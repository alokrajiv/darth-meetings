import AppKit
import CoreGraphics
import RecorderCore

/// Who is sharing what, right now, without any extra permission: every ScreenCaptureKit
/// stream on the machine goes through `replayd`, and `replayd` + `tccd` narrate it in the
/// unified log. We keep a `/usr/bin/log stream` subprocess alive and parse it line by line.
///
/// Verified line shapes (macOS 15.0.1, 2026-09-15 — see the memory note
/// `project_recorder_share_mute_detection`):
///
///   tccd  AUTHREQ_ATTRIBUTION: msgID=644.3657, attribution={accessing={TCCDProcess:
///         identifier=com.microsoft.teams2.modulehost, pid=…}, requesting={TCCDProcess:
///         identifier=com.apple.replayd, …}}                      → WHO
///   replayd -[SCReporting initWithClientBundleID:…]:89 0x…        → a stream is being set up
///   replayd -[SLContentFilter initWithDisplay:…]: self = 0x…, displayID = 0x00000001,
///           shareAll = YES                                       → WHAT (whole display)
///   replayd -[SLContentFilter initWithDesktopIndependentWindow:]: self = 0x…,
///           windowID = 0x27885                                   → WHAT (one window)
///   replayd +[SCScreenCaptureSession …]:147 isFullDisplayShare=1 outputType=1
///           outputType = which outputs the client registered: 0 = none (the share picker's
///           thumbnail streams — dozens of sub-second ones per picker open, always ignored),
///           1 = screen, 2 = audio, 3 = both. 2026-09-15: our own video-only stream logs 1 and
///           our audio-only stream logs 2, so outputType can NOT identify our own capture —
///           only the client bundle id can (the earlier "3 = our own recording" note was the
///           0.1.x display+audio stream, i.e. simply 1|2).
///   replayd -[RPClient startCapture:…]:1187 Created New Stream=<private> with Hash=119194…
///                                                                → START (id = the hash)
///   replayd -[RPRecordingManager invalidateFilterTimerForStream:]:1813/1818
///                                                                → TEARDOWN (no id, 2 lines)
///
/// `-[SLContentStream stop:]` fires for every picker thumbnail and NOT when someone leaves a
/// meeting mid-share, so it is never used here. Teardown lines carry no stream id, so the
/// most recent active share is the one that ends; our own recording's teardown is suppressed
/// explicitly (`expectOwnTeardown()`), and a 5 s sweep closes shares whose window or app has
/// gone away.
struct ShareInfo: Equatable {
    let id: String
    let appBundle: String
    let appName: String?
    let kind: String              // "display" | "window"
    let displayID: UInt32?
    let windowID: UInt32?
    let windowOwner: String?
    let windowTitle: String?
    let startedAt: Date

    var target: String {
        if kind == "display" { return "Display \(displayID.map(String.init) ?? "?")" }
        let t = windowTitle?.isEmpty == false ? windowTitle! : (windowOwner ?? "a window")
        return windowOwner != nil && windowTitle?.isEmpty == false ? "\(t) — \(windowOwner!)" : t
    }

    var json: [String: Any] {
        var d: [String: Any] = [
            "id": id, "app": appName ?? appBundle, "app_bundle": appBundle, "kind": kind,
            "target": target, "started_at": isoString(startedAt),
        ]
        if let displayID { d["display_id"] = Int(displayID) }
        if let windowID { d["window_id"] = Int(windowID) }
        if let windowOwner { d["window_owner"] = windowOwner }
        if let windowTitle { d["window_title"] = windowTitle }
        return d
    }
}

final class ShareDetector {
    static let ownBundle = "io.trames.darth.recorder"

    /// Main queue.
    var onStart: ((ShareInfo) -> Void)?
    var onEnd: ((ShareInfo) -> Void)?

    private(set) var active: [ShareInfo] = []
    private var proc: Process?
    private var buffer = Data()
    private var stopped = false
    private var sweepTimer: Timer?

    // in-flight stream being described by the log
    private var pendingBundle: (id: String, pid: pid_t, at: Date)?
    private var pendingKind: String?
    private var pendingDisplay: UInt32?
    private var pendingWindow: (id: UInt32, owner: String?, title: String?)?
    private var pendingOutputType: Int?
    private var pendingAt: Date?
    private var lastTeardown = Date.distantPast
    private var ownTeardownExpected = 0

    /// A token that never matches a real message — it exists so the command line of our
    /// `log stream` child is uniquely greppable and orphans from a killed tray can be swept.
    static let marker = "DarthRecorderShareWatch"

    private static let predicate = """
    (process == "replayd" AND (eventMessage CONTAINS "isFullDisplayShare" \
    OR eventMessage CONTAINS "SLContentFilter init" \
    OR eventMessage CONTAINS "initWithClientBundleID" \
    OR eventMessage CONTAINS "Created New Stream" \
    OR eventMessage CONTAINS "invalidateFilterTimerForStream")) \
    OR (process == "tccd" AND eventMessage CONTAINS "AUTHREQ_ATTRIBUTION" AND eventMessage CONTAINS "com.apple.replayd") \
    OR eventMessage CONTAINS "DarthRecorderShareWatch"
    """

    var isWatching: Bool { proc?.isRunning == true }

    /// Idempotent. The watcher only runs while a call is live or we are recording — streaming
    /// the unified log costs ~17% of a core, which is not something a tray should burn all day.
    func start() {
        guard proc == nil else { return }
        stopped = false
        spawn()
        sweepTimer?.invalidate()
        sweepTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.sweep() }
        sweepTimer?.tolerance = 1
    }

    func stop() {
        stopped = true
        sweepTimer?.invalidate()
        sweepTimer = nil
        for s in active { end(s, reason: "watcher stopped") }
        proc?.terminate()
        proc = nil
        buffer.removeAll()
        pendingBundle = nil; pendingKind = nil; pendingDisplay = nil; pendingWindow = nil; pendingOutputType = nil
    }

    /// We are about to stop our own SCK capture: the next teardown line is ours.
    func expectOwnTeardown() { ownTeardownExpected += 1 }

    /// Is `bundle` (or an app whose bundle starts with it, e.g. Teams' module host) sharing?
    func shareBy(bundlePrefix: String) -> ShareInfo? {
        active.first { $0.appBundle.hasPrefix(bundlePrefix) || bundlePrefix.hasPrefix($0.appBundle) }
    }

    /// Test hook (ws `simulate_share` / `end_simulated_share`): inject a share as if the log
    /// had announced it. The parser itself is exercised by real lines — this drives everything
    /// downstream of it (ws events, the segment roll, the menu line) without a second machine
    /// on a Teams call.
    func injectShare(_ info: ShareInfo) {
        guard !active.contains(where: { $0.id == info.id }) else { return }
        active.append(info)
        EventLog.shared.log("share_started", info.json,
                            summary: "share started (injected): \(info.appName ?? info.appBundle) \(info.kind) — \(info.target)")
        onStart?(info)
    }

    func endInjectedShare(id: String?) {
        guard let s = (id.flatMap { i in active.first { $0.id == i } } ?? active.last) else { return }
        end(s, reason: "injected end")
    }

    // MARK: subprocess

    private func spawn() {
        guard !stopped else { return }
        // A tray that was force-quit leaves its watcher behind; it would sit there streaming
        // the log forever. Sweep any orphan before starting ours (our own is not running yet).
        let sweep = Process()
        sweep.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        sweep.arguments = ["-f", ShareDetector.marker]
        sweep.standardOutput = FileHandle.nullDevice
        sweep.standardError = FileHandle.nullDevice
        try? sweep.run()
        sweep.waitUntilExit()
        if sweep.terminationStatus == 0 { rlog("share detector: swept an orphaned log-stream watcher") }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        // No --debug/--info: the lines we need are all DEFAULT level (the "[INFO]" inside the
        // message is replayd's own prefix). Those two flags tripled the watcher's CPU
        // (52% of a core vs 17%) for nothing.
        p.arguments = ["stream", "--style", "compact", "--predicate", ShareDetector.predicate]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let d = fh.availableData
            guard !d.isEmpty else { return }
            DispatchQueue.main.async { self?.feed(d) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, !self.stopped, self.proc === proc else { return }
                self.proc = nil
                rlog("share detector: log stream exited — restarting in 5 s")
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.spawn() }
            }
        }
        do {
            try p.run()
            proc = p
            rlog("share detector: watching replayd/tccd via /usr/bin/log stream (pid \(p.processIdentifier))")
        } catch {
            rlog("share detector: could not start log stream: \(error.localizedDescription)")
        }
    }

    private func feed(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...nl)
            handle(line)
        }
        if buffer.count > 1_000_000 { buffer.removeAll() }   // runaway guard
    }

    // MARK: parsing

    private func handle(_ line: String) {
        if line.contains("AUTHREQ_ATTRIBUTION") {
            // Only the requests replayd makes on an app's behalf name the sharer; every other
            // TCC request (routined→calaccessd, teams2→donotdisturbd, …) must be ignored or a
            // random app becomes "the one sharing".
            guard line.contains("requesting={TCCDProcess: identifier=com.apple.replayd") else { return }
            guard let m = Self.match(Self.reAccessing, line), m.count >= 3 else { return }
            pendingBundle = (id: m[1], pid: pid_t(m[2]) ?? 0, at: Date())  // Int32(String) — nil for a weird line
            return
        }
        guard line.contains(" replayd[") else { return }
        if line.contains("initWithClientBundleID") {
            // A fresh stream is being described — start a new pending record.
            pendingKind = nil; pendingDisplay = nil; pendingWindow = nil; pendingOutputType = nil
            pendingAt = Date()
            return
        }
        if line.contains("initWithDesktopIndependentWindow") {
            guard let m = Self.match(Self.reWindow, line), let wid = Self.parseID(m[1]) else { return }
            // Window ids die with the window: resolve owner + title NOW.
            let info = Self.windowInfo(UInt32(wid))
            pendingKind = "window"
            pendingWindow = (id: UInt32(wid), owner: info?.owner, title: info?.title)
            pendingAt = Date()
            return
        }
        if line.contains("SLContentFilter initWithDisplay") || (line.contains("SLContentFilter init") && line.contains("displayID =")) {
            guard let m = Self.match(Self.reDisplay, line), let did = Self.parseID(m[1]) else { return }
            pendingKind = "display"
            pendingDisplay = UInt32(did)
            pendingAt = Date()
            return
        }
        if line.contains("isFullDisplayShare") {
            guard let m = Self.match(Self.reOutput, line) else { return }
            pendingOutputType = Int(m[2])
            if pendingKind == nil { pendingKind = m[1] == "1" ? "display" : "window" }
            pendingAt = Date()
            return
        }
        if line.contains("Created New Stream") {
            guard let m = Self.match(Self.reHash, line) else { return }
            commit(hash: m[1])
            return
        }
        if line.contains("invalidateFilterTimerForStream") {
            // Two lines per teardown (…:1813 and …:1818) — collapse them.
            guard Date().timeIntervalSince(lastTeardown) > 0.5 else { return }
            lastTeardown = Date()
            teardown()
            return
        }
    }

    private func commit(hash: String) {
        let outputType = pendingOutputType ?? -1
        let bundle = pendingBundle.flatMap { Date().timeIntervalSince($0.at) < 10 ? $0.id : nil } ?? "unknown"
        let kind = pendingKind ?? "display"
        defer { pendingKind = nil; pendingDisplay = nil; pendingWindow = nil; pendingOutputType = nil }

        if bundle == ShareDetector.ownBundle {
            rlog("share detector: ignoring our own capture (outputType=\(outputType), bundle=\(bundle))")
            return
        }
        guard outputType != 0 else {
            // The share picker's thumbnails: dozens of sub-second streams per picker open.
            return
        }
        let name = pendingBundle.flatMap { b in NSRunningApplication(processIdentifier: b.pid)?.localizedName }
        let info = ShareInfo(id: hash, appBundle: bundle, appName: name, kind: kind,
                             displayID: kind == "display" ? pendingDisplay : nil,
                             windowID: pendingWindow?.id, windowOwner: pendingWindow?.owner,
                             windowTitle: pendingWindow?.title, startedAt: Date())
        guard !active.contains(where: { $0.id == info.id }) else { return }
        active.append(info)
        EventLog.shared.log("share_started", info.json,
                            summary: "share started: \(info.appName ?? info.appBundle) is sharing \(info.kind) — \(info.target)")
        onStart?(info)
    }

    private func teardown() {
        if ownTeardownExpected > 0 {
            ownTeardownExpected -= 1
            rlog("share detector: teardown is our own capture — ignored")
            return
        }
        guard let last = active.last else { return }
        end(last, reason: "log teardown")
    }

    private func end(_ info: ShareInfo, reason: String) {
        active.removeAll { $0.id == info.id }
        var payload = info.json
        payload["reason"] = reason
        payload["seconds"] = Int(Date().timeIntervalSince(info.startedAt))
        EventLog.shared.log("share_ended", payload,
                            summary: "share ended: \(info.appName ?? info.appBundle) \(info.kind) after \(Int(Date().timeIntervalSince(info.startedAt)))s (\(reason))")
        onEnd?(info)
    }

    /// Close shares whose window vanished or whose app quit — the teardown line is not
    /// guaranteed (leaving a meeting mid-share never logs one).
    private func sweep() {
        for s in active {
            if let wid = s.windowID, Self.windowInfo(wid) == nil {
                end(s, reason: "window gone")
                continue
            }
            if s.appBundle != "unknown",
               NSRunningApplication.runningApplications(withBundleIdentifier: s.appBundle).isEmpty,
               // Teams shares as com.microsoft.teams2.modulehost, a helper: check the prefix too.
               NSWorkspace.shared.runningApplications.first(where: { ($0.bundleIdentifier ?? "").hasPrefix(String(s.appBundle.prefix(20))) }) == nil {
                end(s, reason: "app gone")
            }
        }
    }

    // MARK: helpers

    private static let reAccessing = try! NSRegularExpression(pattern: "accessing=\\{TCCDProcess: identifier=([^,]+), pid=(\\d+)")
    private static let reWindow = try! NSRegularExpression(pattern: "windowID = (0x[0-9a-fA-F]+|\\d+)")
    private static let reDisplay = try! NSRegularExpression(pattern: "displayID = (0x[0-9a-fA-F]+|\\d+)")
    private static let reOutput = try! NSRegularExpression(pattern: "isFullDisplayShare=(\\d+) outputType=(\\d+)")
    private static let reHash = try! NSRegularExpression(pattern: "Hash=(\\d+)")

    private static func match(_ re: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    private static func parseID(_ s: String) -> UInt64? {
        s.hasPrefix("0x") ? UInt64(s.dropFirst(2), radix: 16) : UInt64(s)
    }

    /// CG bounds of a window id, or nil when the window is gone.
    static func windowFrame(_ id: UInt32) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
              let w = list.first, let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return CGRect(dictionaryRepresentation: b as CFDictionary)
    }

    static func windowInfo(_ id: UInt32) -> (owner: String, title: String)? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
              let w = list.first else { return nil }
        return (owner: (w[kCGWindowOwnerName as String] as? String) ?? "?",
                title: (w[kCGWindowName as String] as? String) ?? "")
    }
}
