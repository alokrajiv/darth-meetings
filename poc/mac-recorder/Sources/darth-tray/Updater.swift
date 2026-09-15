import AppKit
import CryptoKit
import RecorderCore

/// Self-update without Sparkle. Reads the same version.json the installer uses, downloads the
/// notarized zip, verifies it (sha256 → codesign --deep --strict → Team ID → spctl notarization
/// → bundle id + version inside), stages it under ~/Library/Caches, and — when the app is idle —
/// hands over to a tiny bash helper that swaps the bundle in place and relaunches us.
///
/// Env (testing): DARTH_TRAY_UPDATE_URL (version.json URL, file:// allowed; zip resolves relative
/// to it), DARTH_TRAY_UPDATE_INTERVAL (seconds between checks; the first check is min(30, interval)).
final class Updater {
    struct Release { let version: String; let zip: URL; let sha256: String; let minMacOS: String? }
    struct Staged { let version: String; let app: URL; let dir: URL }
    enum Event {
        case upToDate(String)                 // manual check, nothing newer
        case error(String)                    // manual check failed / verification refused
        case staged(String)                   // verified update waiting because we are busy
        case installing(String)               // helper launched; the app terminates next
    }
    private enum Outcome { case upToDate(String), staged(Staged), failed(String, silent: Bool) }

    static let teamID = "SMX3ZQ2226"
    static let defaultFeed = URL(string: "https://cli.darth-internal.trames.io/darth-recorder/version.json")!
    static let bundleName = "Darth Recorder.app"

    let currentVersion: String
    let feedURL: URL
    let interval: TimeInterval
    /// Recording, starting a recording, or a detected call in progress → do not restart now.
    var isBusy: () -> Bool = { false }
    /// Main queue. UI + status hooks.
    var onEvent: ((Event) -> Void)?
    var onChange: (() -> Void)?

    private(set) var available: String?
    private(set) var staged: Staged?
    private(set) var checking = false
    private(set) var installing = false
    private var timer: Timer?
    private var loggedOffline = false
    private let work = DispatchQueue(label: "darth.updater", qos: .utility)
    private let logPath = (("~/Library/Logs/DarthRecorder/tray.log") as NSString).expandingTildeInPath
    private let attemptKey = "updateInstallAttempt"   // "<version>|<unix ts>" — loop guard

    init(currentVersion: String) {
        self.currentVersion = currentVersion
        let env = ProcessInfo.processInfo.environment
        feedURL = env["DARTH_TRAY_UPDATE_URL"].flatMap { URL(string: $0) } ?? Updater.defaultFeed
        interval = env["DARTH_TRAY_UPDATE_INTERVAL"].flatMap { Double($0) }.map { max(5, $0) } ?? 6 * 3600
    }

    // MARK: schedule

    func start() {
        let first = min(30, interval)
        rlog("updater: feed \(feedURL.absoluteString), first check in \(Int(first)) s, then every \(Int(interval)) s")
        DispatchQueue.main.asyncAfter(deadline: .now() + first) { [weak self] in
            self?.check(manual: false)
            self?.timer = Timer.scheduledTimer(withTimeInterval: self?.interval ?? 21600, repeats: true) { [weak self] _ in
                self?.check(manual: false)
            }
        }
    }

    /// Fetch version.json; if newer, download + verify + stage; then install (idle) or offer (busy).
    func check(manual: Bool) {
        guard !installing else { return }
        guard !checking else { rlog("updater: check already running"); return }
        checking = true
        onChange?()
        if let s = staged, !manual, !isBusy() {
            // A verified update is waiting from an earlier busy period — install it now.
            checking = false; onChange?()
            rlog("updater: staged \(s.version) still pending and we are idle → installing")
            install(auto: true)
            return
        }
        work.async {
            let outcome = self.fetchAndStage(manual: manual)
            DispatchQueue.main.async {
                self.checking = false
                self.handle(outcome, manual: manual)
                self.onChange?()
            }
        }
    }

    /// Called by the app when a recording stops or a call ends: install a staged update if idle.
    func installIfIdle() {
        guard staged != nil, !installing, !isBusy() else { return }
        install(auto: true)
    }

    private func handle(_ o: Outcome, manual: Bool) {
        switch o {
        case .upToDate(let v):
            available = nil
            if manual { onEvent?(.upToDate(v)) }
        case .staged(let s):
            available = s.version
            staged = s
            if isBusy() {
                rlog("updater: \(s.version) staged, app busy → install when idle")
                onEvent?(.staged(s.version))
            } else {
                install(auto: !manual)
            }
        case .failed(let msg, _):
            if manual { onEvent?(.error(msg)) }   // every failure is already in tray.log
        }
    }

    // MARK: fetch + verify (background queue)

    private func fetchAndStage(manual: Bool) -> Outcome {
        let rel: Release
        do {
            let data = try fetch(feedURL, timeout: 20)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = obj["version"] as? String, let zipName = obj["zip"] as? String,
                  let sha = obj["sha256"] as? String, let zipURL = URL(string: zipName, relativeTo: feedURL)?.absoluteURL
            else { rlog("updater: version.json is malformed"); return .failed("version.json is malformed", silent: false) }
            rel = Release(version: version, zip: zipURL, sha256: sha.lowercased(), minMacOS: obj["min_macos"] as? String)
            loggedOffline = false
        } catch {
            // Off the Tailnet is the normal case for a laptop: log once, no banner.
            if !loggedOffline { rlog("updater: check skipped (offline? \(error.localizedDescription))"); loggedOffline = true }
            return .failed("Could not reach \(feedURL.host ?? feedURL.absoluteString) — are you on the Trames Tailnet?", silent: true)
        }

        guard Updater.compare(rel.version, currentVersion) > 0 else {
            rlog("updater: up to date (\(currentVersion), published \(rel.version))")
            return .upToDate(currentVersion)
        }
        if let min = rel.minMacOS, !Updater.osAtLeast(min) {
            rlog("updater: \(rel.version) needs macOS \(min) or newer — skipped")
            return .failed("Darth Recorder \(rel.version) needs macOS \(min) or newer", silent: false)
        }
        if let s = staged, s.version == rel.version, FileManager.default.fileExists(atPath: s.app.path) {
            rlog("updater: \(rel.version) already staged at \(s.app.path)")
            return .staged(s)
        }
        rlog("updater: \(rel.version) is newer than \(currentVersion) → downloading \(rel.zip.absoluteString)")

        let fm = FileManager.default
        let base = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("io.trames.darth.recorder/updates", isDirectory: true)
        try? fm.removeItem(at: base)   // no stale leftovers from earlier attempts
        let dir = base.appendingPathComponent(rel.version, isDirectory: true)
        let zipPath = dir.appendingPathComponent(rel.zip.lastPathComponent)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try download(rel.zip, to: zipPath, timeout: 300)
        } catch {
            rlog("updater: download failed: \(error.localizedDescription)")
            return .failed("download failed: \(error.localizedDescription)", silent: false)
        }
        let size = (try? fm.attributesOfItem(atPath: zipPath.path)[.size] as? Int) ?? 0
        rlog("updater: downloaded \(zipPath.lastPathComponent) (\(size) bytes)")

        // 1. sha256 must match version.json
        guard let data = fm.contents(atPath: zipPath.path) else { return refuse("could not read download", dir) }
        let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard got == rel.sha256 else { return refuse("sha256 mismatch (expected \(rel.sha256), got \(got))", dir) }
        rlog("updater: sha256 ok \(got)")

        // 2. unpack
        let unpacked = dir.appendingPathComponent("unpacked", isDirectory: true)
        let (dx, dout) = run("/usr/bin/ditto", ["-x", "-k", zipPath.path, unpacked.path])
        guard dx == 0 else { return refuse("ditto failed (\(dx)): \(dout)", dir) }
        let app = unpacked.appendingPathComponent(Updater.bundleName)
        guard fm.fileExists(atPath: app.path) else { return refuse("archive did not contain \(Updater.bundleName)", dir) }

        // 3. signature intact, 4. our Team ID, 5. notarized (Gatekeeper)
        let (vx, vout) = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        guard vx == 0 else { return refuse("codesign --verify failed (\(vx)): \(vout)", dir) }
        let (_, dv) = run("/usr/bin/codesign", ["-dv", app.path])
        guard dv.contains("TeamIdentifier=\(Updater.teamID)") else {
            return refuse("Team ID mismatch: \(dv.split(separator: "\n").first { $0.hasPrefix("TeamIdentifier=") } ?? "none")", dir)
        }
        let (sx, sout) = run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app.path])
        guard sx == 0 else { return refuse("spctl rejected the app (\(sx)): \(sout)", dir) }
        rlog("updater: codesign ok, TeamIdentifier=\(Updater.teamID), spctl: \(sout.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " "))")

        // 6. the bundle must be us, at the advertised version
        let plist = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any]
        let bid = plist?["CFBundleIdentifier"] as? String ?? ""
        let bver = plist?["CFBundleShortVersionString"] as? String ?? ""
        guard bid == (Bundle.main.bundleIdentifier ?? "io.trames.darth.recorder") else { return refuse("bundle id mismatch: \(bid)", dir) }
        guard bver == rel.version else { return refuse("bundle version \(bver) ≠ advertised \(rel.version)", dir) }

        rlog("updater: \(rel.version) verified and staged at \(app.path)")
        return .staged(Staged(version: rel.version, app: app, dir: dir))
    }

    private func refuse(_ why: String, _ dir: URL) -> Outcome {
        rlog("updater: REFUSED — \(why); not installing")
        try? FileManager.default.removeItem(at: dir)
        return .failed("Update refused: \(why)", silent: false)
    }

    // MARK: install (main queue)

    /// Write the helper, launch it detached, terminate. The helper waits for our pid, moves the old
    /// bundle to the Trash, moves the staged one into place and `open`s it.
    func install(auto: Bool) {
        guard let s = staged, !installing else { return }
        let dest = Bundle.main.bundleURL
        guard dest.pathExtension == "app" else { rlog("updater: not running from an .app bundle (\(dest.path)) — install skipped"); return }
        if auto, let last = UserDefaults.standard.string(forKey: attemptKey) {
            let parts = last.split(separator: "|")
            if parts.count == 2, parts[0] == s.version, let ts = Double(parts[1]), Date().timeIntervalSince1970 - ts < 3600 {
                rlog("updater: auto-install of \(s.version) attempted \(Int(Date().timeIntervalSince1970 - ts)) s ago and we are still \(currentVersion) — not retrying automatically (use Check for Updates…)")
                onEvent?(.staged(s.version))
                return
            }
        }
        installing = true
        onChange?()
        UserDefaults.standard.set("\(s.version)|\(Int(Date().timeIntervalSince1970))", forKey: attemptKey)
        UserDefaults.standard.synchronize()

        let script = s.dir.appendingPathComponent("install.sh")
        do {
            try Updater.helperScript.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
            p.arguments = ["/bin/bash", script.path, String(getpid()), s.app.path, dest.path, currentVersion, s.version, s.dir.path, logPath]
            // The helper appends to tray.log itself (`exec >>`, O_APPEND); handing it an inherited
            // seek-to-end fd made its first line overwrite ours.
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.standardInput = FileHandle.nullDevice
            try p.run()
            rlog("updater: installing \(s.version) over \(dest.path) — helper pid \(p.processIdentifier), terminating pid \(getpid())")
        } catch {
            rlog("updater: could not launch install helper: \(error)")
            installing = false
            onChange?()
            onEvent?(.error("Could not start the installer: \(error.localizedDescription)"))
            return
        }
        onEvent?(.installing(s.version))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
    }

    /// Runs after we exit. Args: pid src dest oldver newver stagedir logfile. Appends to tray.log.
    static let helperScript = """
    #!/bin/bash
    # Darth Recorder self-update helper — written by the running app, runs after it exits.
    PID="$1"; SRC="$2"; DEST="$3"; OLDVER="$4"; NEWVER="$5"; STAGEDIR="$6"; LOGFILE="$7"
    exec >>"$LOGFILE" 2>&1
    log() { echo "[$(date '+%Y-%m-%d %H:%M:%S.000')] update-helper: $*"; }
    log "waiting for pid $PID ($OLDVER) to exit"
    for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$PID" 2>/dev/null; then log "pid $PID still alive after 60 s → SIGTERM"; kill "$PID" 2>/dev/null; sleep 2; fi
    if kill -0 "$PID" 2>/dev/null; then log "pid $PID ignores SIGTERM → SIGKILL"; kill -9 "$PID" 2>/dev/null; sleep 1; fi
    BACKUP=""
    if [ -e "$DEST" ]; then
      TRASH="$HOME/.Trash/$(basename "$DEST" .app) $OLDVER.app"
      rm -rf "$TRASH"
      if mv "$DEST" "$TRASH" 2>/dev/null; then BACKUP="$TRASH"; log "moved old app to $TRASH"
      else rm -rf "$DEST"; log "removed old app (move to Trash failed)"; fi
    fi
    if mv "$SRC" "$DEST" 2>/dev/null || ditto "$SRC" "$DEST"; then
      log "installed $NEWVER at $DEST"
    else
      log "INSTALL FAILED (mv and ditto both failed)"
      if [ -n "$BACKUP" ] && [ ! -e "$DEST" ] && mv "$BACKUP" "$DEST"; then log "restored $OLDVER"; fi
    fi
    log "relaunching $DEST"
    open "$DEST" || log "open failed with $?"
    rm -rf "$STAGEDIR"

    """

    // MARK: helpers

    private func fetch(_ url: URL, timeout: TimeInterval) throws -> Data {
        if url.isFileURL { return try Data(contentsOf: url) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        req.setValue("DarthRecorder/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let sem = DispatchSemaphore(value: 0)
        var out: Result<Data, Error> = .failure(URLError(.unknown))
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err { out = .failure(err) }
            else if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { out = .failure(URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])) }
            else { out = .success(data ?? Data()) }
            sem.signal()
        }.resume()
        sem.wait()
        return try out.get()
    }

    private func download(_ url: URL, to dest: URL, timeout: TimeInterval) throws {
        if url.isFileURL { try FileManager.default.copyItem(at: url, to: dest); return }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        req.setValue("DarthRecorder/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let sem = DispatchSemaphore(value: 0)
        var failure: Error?
        URLSession.shared.downloadTask(with: req) { tmp, resp, err in
            defer { sem.signal() }
            if let err { failure = err; return }
            if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { failure = URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"]); return }
            guard let tmp else { failure = URLError(.cannotOpenFile); return }
            do { try FileManager.default.moveItem(at: tmp, to: dest) } catch { failure = error }
        }.resume()
        sem.wait()
        if let failure { throw failure }
    }

    private func run(_ path: String, _ args: [String]) -> (Int32, String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe; p.standardError = pipe
        do { try p.run() } catch { return (-1, "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    /// Numeric dotted compare; a pre-release suffix ("-beta") is ignored. >0 when a is newer.
    static func compare(_ a: String, _ b: String) -> Int {
        func parts(_ s: String) -> [Int] { (s.split(separator: "-").first.map(String.init) ?? "").split(separator: ".").map { Int($0) ?? 0 } }
        let (x, y) = (parts(a), parts(b))
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r ? 1 : -1 }
        }
        return 0
    }

    static func osAtLeast(_ v: String) -> Bool {
        let p = v.split(separator: ".").map { Int($0) ?? 0 }
        let os = OperatingSystemVersion(majorVersion: p.count > 0 ? p[0] : 0, minorVersion: p.count > 1 ? p[1] : 0, patchVersion: p.count > 2 ? p[2] : 0)
        return ProcessInfo.processInfo.isOperatingSystemAtLeast(os)
    }
}
