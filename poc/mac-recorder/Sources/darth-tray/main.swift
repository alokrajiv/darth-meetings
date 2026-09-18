import AppKit
import CoreGraphics
import ServiceManagement
import RecorderCore

let VERSION = "0.3.3"
let WS_PORT: UInt16 = 47800
let PWA_URL = URL(string: "https://meetings.darth-internal.trames.io/")!
/// Seconds between "the call ended" and an automatic stop.
let STOP_GRACE: TimeInterval = 60
/// How often a failed upload is retried on its own (0.2.4). The server answers 502 whenever
/// its transcription hand-off fails (AssemblyAI down / out of credit): the bytes stay on this
/// Mac as `upload_failed` and must go up later without anyone clicking.
let UPLOAD_RETRY_INTERVAL: TimeInterval = 30 * 60

/// Menu-bar app "Darth Recorder".
///
/// Detects calls (CallDetector: who has the microphone open), knows who is screen-sharing
/// (ShareDetector: the unified log), records the CALL WINDOW with system audio and the
/// microphone as separate tracks (RecordingController), tells the user where they are looking
/// (BannerController), talks to the Meetings PWA over ws://127.0.0.1:47800 (LocalServer),
/// registers every recording with the server and uploads it (Auth + ApiClient + Uploader),
/// logs everything to events.jsonl, and updates itself (Updater).
final class AppDelegate: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let detector = CallDetector()
    let shares = ShareDetector()
    let server = LocalServer(port: WS_PORT)
    let banner = BannerController()
    let updater = Updater(currentVersion: VERSION)
    let auth = Auth(appVersion: VERSION)
    let api = ApiClient(appVersion: VERSION)
    lazy var uploader = Uploader(api: api)
    let recorder = RecordingController()
    let preview = PreviewPanel()
    let watchdog = MainQueueWatchdog()

    var clients = 0
    /// SIGTERM (updater helper's fallback, `kill <pid>`, logout) → the same clean path as Quit.
    var sigterm: DispatchSourceSignal?
    /// Set in applicationWillTerminate: a recording finalised on the way out must not start
    /// an upload (the process is about to die — the row would be stuck at "uploading") and
    /// must not poke the updater (it would call terminate again).
    var terminating = false
    var graceTimer: Timer?
    var graceDeadline: Date?
    var lastSaved: [String: Any]?

    /// "Upload recordings automatically" — on by default.
    var autoUpload: Bool {
        get { UserDefaults.standard.object(forKey: "autoUpload") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "autoUpload"); refreshMenu(); broadcast("status") }
    }

    // menu items we update
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let permLine = NSMenuItem(title: "", action: #selector(openScreenRecordingSettings), keyEquivalent: "")
    let shareLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let clientsLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let startItem = NSMenuItem(title: "Start recording", action: #selector(startFromMenu), keyEquivalent: "r")
    let displayItem: NSMenuItem = {
        let i = NSMenuItem(title: "Record… (choose screen, window & audio)", action: #selector(openRecordDialog), keyEquivalent: "R")
        i.keyEquivalentModifierMask = [.command, .shift]
        return i
    }()
    var retryTimer: Timer?
    let stopItem = NSMenuItem(title: "Stop recording", action: #selector(stopFromMenu), keyEquivalent: "s")
    let previewItem = NSMenuItem(title: "Show preview", action: #selector(togglePreview), keyEquivalent: "p")
    let authItem = NSMenuItem(title: "Sign in to Darth Meetings…", action: #selector(toggleAuth), keyEquivalent: "")
    let uploadItem = NSMenuItem(title: "Upload recordings automatically", action: #selector(toggleAutoUpload), keyEquivalent: "")
    let pendingLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let loginItem = NSMenuItem(title: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
    let versionLine = NSMenuItem(title: "Darth Recorder \(VERSION)", action: nil, keyEquivalent: "")
    let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")

    func applicationDidFinishLaunching(_ n: Notification) {
        RLog.openFile("~/Library/Logs/DarthRecorder/tray.log")
        rlog("darth-tray \(VERSION) starting, pid \(getpid()), bundle \(Bundle.main.bundleIdentifier ?? "none") at \(Bundle.main.bundlePath)")
        if offerMoveToApplications() { return }   // relaunching from /Applications
        installSignalHandlers()
        buildMenu()
        EventLog.shared.log("app_launched", [
            "version": VERSION, "pid": getpid(), "bundle_path": Bundle.main.bundlePath,
            "device_id": auth.deviceId, "signed_in": auth.signedIn, "os": ProcessInfo.processInfo.operatingSystemVersionString,
        ])

        if !CGPreflightScreenCaptureAccess() {
            rlog("screen recording not granted → requesting")
            CGRequestScreenCaptureAccess()
        }

        detector.onStart = { [weak self] call in self?.callStarted(call) }
        detector.onEnd = { [weak self] call in self?.callEnded(call) }
        // A share by the call's own app keeps the call alive even though the mic closed.
        detector.holdOpen = { [weak self] call in
            guard let self, !call.bundleId.isEmpty, let s = self.shares.shareBy(bundlePrefix: call.bundleId) else { return false }
            rlog("call end held open: \(call.appName) is still sharing \(s.kind) (\(s.target))")
            return true
        }
        detector.start()

        shares.onStart = { [weak self] s in self?.shareStarted(s) }
        shares.onEnd = { [weak self] s in self?.shareEnded(s) }

        server.statusProvider = { [weak self] in self?.statusPayload() ?? [:] }
        server.onCommand = { [weak self] cmd, obj in self?.handleCommand(cmd, obj) }
        server.onClientsChanged = { [weak self] n in self?.clients = n; self?.refreshMenu() }
        do { try server.start() } catch { rlog("local server failed: \(error)") }

        banner.onRecord = { [weak self] call in self?.startRecording(for: call) }
        banner.onStop = { [weak self] in self?.stopRecording(reason: "user") }
        banner.onKeepRecording = { [weak self] in self?.keepRecording() }

        recorder.api = api
        recorder.deviceId = auth.deviceId
        recorder.willStopOwnStreams = { [weak self] n in for _ in 0..<n { self?.shares.expectOwnTeardown() } }
        recorder.onStarted = { [weak self] in self?.recordingStarted() }
        recorder.onSegment = { [weak self] index, reason in self?.broadcast("segment_started", ["segment": index, "reason": reason]) }
        recorder.onStopped = { [weak self] saved in self?.recordingStopped(saved) }
        recorder.onError = { [weak self] msg in
            self?.banner.showMessage(title: "Recording problem", sub: msg, stoppable: self?.recorder.isRecording ?? false)
        }
        recorder.onTrackHealth = { [weak self] track, ok in self?.trackHealthChanged(track, ok: ok) }
        recorder.onNotice = { [weak self] title, sub in
            self?.banner.showMessage(title: title, sub: sub, accent: .warning, stoppable: true, near: self?.recordingFrame)
        }
        recorder.onPreviewFrame = { [weak self] pb in self?.preview.showFrame(pb) }
        preview.levelsProvider = { [weak self] in
            guard let self else { return (nil, nil, nil, nil, false, 0) }
            let h = self.recorder.health()
            let o = self.recorder.options
            return (o.systemAudio ? self.recorder.systemMeter : nil, o.mic ? self.recorder.micMeter : nil,
                    h.systemOK, h.micOK, self.recorder.currentSource?.isAudioOnly == true, self.recorder.micGainDb)
        }
        preview.onClosed = { [weak self] in self?.refreshMenu() }
        banner.onPreview = { [weak self] in self?.togglePreview() }
        recorder.onStartCancelled = { [weak self] reason in
            guard let self else { return }
            self.cancelGrace(reason: "start cancelled")
            self.updateShareWatcher()
            self.refreshMenu()
            self.banner.showMessage(title: "Recording cancelled", sub: "It never started (\(reason)).", accent: .warning)
            self.broadcast("recording_cancelled", ["reason": reason])
        }

        auth.onChange = { [weak self] in
            self?.refreshMenu()
            self?.broadcast("auth_changed")
            if self?.auth.signedIn == true { self?.api.heartbeat(); self?.api.shipEvents(); self?.uploadPending() }
        }
        auth.onPrompt = { [weak self] title, sub, url in
            self?.banner.showMessage(title: title, sub: sub, accent: .info)
            // Tell the PWA too: it shows the code + a link into the same browser, so the user
            // never has to hunt for the tab the tray opened (or the menu item).
            var extra: [String: Any] = ["title": title, "sub": sub]
            if let url { extra["verify_url"] = url.absoluteString }
            if let code = url?.query?.split(separator: "&").first(where: { $0.hasPrefix("code=") || $0.hasPrefix("user_code=") })?.split(separator: "=").last { extra["user_code"] = String(code) }
            self?.broadcast("auth_prompt", extra)
        }

        api.token = { [weak self] in self?.auth.token }
        api.deviceId = auth.deviceId
        api.statusProvider = { [weak self] in self?.statusPayload() ?? [:] }
        api.onNewerVersion = { [weak self] _ in
            guard let self, !self.updater.checking, !self.updater.installing else { return }
            self.updater.check(manual: false)
        }
        api.start()
        // 0.3.1: relaunch when the main dispatch queue stops draining (never mid-recording).
        watchdog.canRelaunch = { [weak self] in self?.recorder.state != .recording }
        watchdog.onStall = { [weak self] seconds in
            guard let self, self.recorder.state == .recording else { return }
            self.banner.showMessage(title: "Darth Recorder needs a restart", sub: "Something inside stalled \(Int(seconds)) s ago. It restarts itself when this recording ends.", accent: .warning, stoppable: true)
        }
        watchdog.start()

        uploader.onProgress = { [weak self] id, seg, pct in
            self?.broadcast("upload_progress", ["recording_id": id, "segment": seg, "pct": pct])
        }
        uploader.onDone = { [weak self] id, tid in
            self?.broadcast("upload_done", ["recording_id": id, "transcript_id": tid])
            self?.refreshMenu()
        }
        uploader.onFailed = { [weak self] id, err in
            self?.broadcast("upload_failed", ["recording_id": id, "error": err])
            self?.refreshMenu()
        }

        updater.isBusy = { [weak self] in
            guard let self else { return false }
            return self.recorder.isRecording || !self.detector.active.isEmpty
        }
        updater.onChange = { [weak self] in self?.refreshMenu() }
        updater.onEvent = { [weak self] ev in self?.updaterEvent(ev) }
        updater.start()

        if let sim = ProcessInfo.processInfo.environment["DARTH_TRAY_SIMULATE"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.simulate(kind: sim) }
        }
        refreshMenu()
        // Open at login is the DEFAULT (Alok, 2026-09-15): a recorder that is not running when
        // the call starts records nothing. Registered once on every install/update unless the
        // user has explicitly switched it off from the menu (loginItemUserChoice).
        if UserDefaults.standard.object(forKey: "loginItemUserChoice") == nil,
           SMAppService.mainApp.status != .enabled {
            do {
                try SMAppService.mainApp.register()
                rlog("login item: enabled by default (status \(SMAppService.mainApp.status.rawValue))")
                EventLog.shared.log("login_item_default", ["status": SMAppService.mainApp.status.rawValue])
            } catch { rlog("login item: default enable failed: \(error)") }
        }

        let seenKey = "firstRunShown", verKey = "lastRunVersion"
        let lastRun = UserDefaults.standard.string(forKey: verKey)
        UserDefaults.standard.set(VERSION, forKey: verKey)
        if !UserDefaults.standard.bool(forKey: seenKey) {
            UserDefaults.standard.set(true, forKey: seenKey)
            if auth.signedIn {
                banner.showMessage(title: "Darth Recorder is running", sub: "It lives in your menu bar (the waveform icon).", accent: .info)
            } else {
                banner.showSignIn(title: "Darth Recorder is running — sign in", sub: "It lives in your menu bar (the waveform icon). Recordings upload to Darth Meetings only after you sign in.") { [weak self] in self?.auth.signIn() }
            }
        } else if let lastRun, lastRun != VERSION {
            rlog("first run after update \(lastRun) → \(VERSION)")
            if auth.signedIn {
                banner.showMessage(title: "Darth Recorder updated to \(VERSION)", sub: "Was \(lastRun). Updates install themselves when you are not on a call.", accent: .info)
            } else {
                banner.showSignIn(title: "Darth Recorder \(VERSION) — sign in to upload", sub: "Updated from \(lastRun). Recordings stay on this Mac until you sign in to Darth Meetings.") { [weak self] in self?.auth.signIn() }
            }
        } else if !auth.signedIn && Registry.shared.pendingUpload().count > 0 {
            banner.showSignIn(title: "\(Registry.shared.pendingUpload().count) recording(s) waiting to upload", sub: "Sign in to Darth Meetings and they upload on their own.") { [weak self] in self?.auth.signIn() }
        }
        if !auth.signedIn {
            rlog("not signed in — recordings stay local until you sign in from the menu")
        }
        uploadPending()
        retryTimer = Timer.scheduledTimer(withTimeInterval: UPLOAD_RETRY_INTERVAL, repeats: true) { [weak self] _ in
            self?.retryFailedUploads()
        }
        retryTimer?.tolerance = 60
    }

    /// Every UPLOAD_RETRY_INTERVAL: push `upload_failed` rows that still have bytes on disk
    /// (never capture-failed rows, which have no files). Signed in + auto-upload only, and
    /// never a recording the user chose to keep on this Mac.
    func retryFailedUploads() {
        guard auth.signedIn, autoUpload else { return }
        let rows = Registry.shared.retryableFailed().filter { row in
            guard let id = row["id"] as? String else { return false }
            return !uploader.isUploading(id)
        }
        guard !rows.isEmpty else { return }
        for row in rows {
            guard let id = row["id"] as? String else { continue }
            EventLog.shared.log("upload_retry", ["recording_id": id, "error": row["error"] ?? NSNull()],
                                summary: "upload: retrying \(id) (was: \((row["error"] as? String) ?? "?"))")
            uploader.upload(recordingId: id)
        }
    }

    /// Quitting must take the `log stream` child with us — and must finalise an in-flight
    /// recording: a process that dies with SCK streams open leaves them orphaned in replayd
    /// (six such streams from killed 0.1.x trays were found thrashing before the 2026-09-16
    /// kernel panic). The teardown runs on a detached task, so blocking the main thread on a
    /// semaphore is safe; 5 s cap so a wedged writer can never hold up Quit or the updater.
    func applicationWillTerminate(_ n: Notification) {
        shares.stop()
        terminating = true
        let wasRecording = recorder.isRecording
        var finalised = false
        if recorder.state == .starting {
            // A pending start has no file to finalise and may be wedged in SCK — cancel, never wait.
            rlog("terminating while a start is pending — cancelling it")
            recorder.cancelStart(reason: "quit")
            finalised = true
        } else if wasRecording {
            let started = Date()
            let sem = DispatchSemaphore(value: 0)
            rlog("terminating while recording — stopping the recording first")
            recorder.stop(reason: "quit") { sem.signal() }
            finalised = sem.wait(timeout: .now() + 5) == .success
            rlog("terminate: recording \(finalised ? "finalised" : "NOT finalised (5 s cap)") in \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
        }
        EventLog.shared.log("app_terminating", ["recording": wasRecording, "finalised": finalised])
    }

    /// Route SIGTERM through NSApp.terminate so applicationWillTerminate runs (a raw SIGTERM
    /// would kill the process with the SCK streams still open).
    func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { [weak self] in
            rlog("SIGTERM received → terminating cleanly")
            EventLog.shared.log("sigterm", ["recording": self?.recorder.isRecording ?? false])
            NSApp.terminate(nil)
        }
        src.resume()
        sigterm = src
    }

    // MARK: install location

    /// Running from Downloads / a mounted DMG / anywhere outside an Applications folder?
    /// Offer to move ourselves (LetsMove-style). Returns true if we are relaunching.
    func offerMoveToApplications() -> Bool {
        let src = Bundle.main.bundleURL
        let home = NSHomeDirectory()
        if src.path.hasPrefix("/Applications/") || src.path.hasPrefix(home + "/Applications/") { return false }
        if ProcessInfo.processInfo.environment["DARTH_TRAY_NO_MOVE"] == "1" { return false }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Move Darth Recorder to your Applications folder?"
        alert.informativeText = "It is running from \(src.deletingLastPathComponent().path). Moving it to Applications keeps it in one place and lets updates replace it cleanly. It will relaunch from there."
        alert.alertStyle = .informational
        alert.icon = NSApp.applicationIconImage
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not now")
        guard alert.runModal() == .alertFirstButtonReturn else { rlog("move to /Applications declined"); return false }

        let fm = FileManager.default
        var destDir = URL(fileURLWithPath: "/Applications", isDirectory: true)
        if !fm.isWritableFile(atPath: destDir.path) {
            destDir = URL(fileURLWithPath: home + "/Applications", isDirectory: true)
            try? fm.createDirectory(at: destDir, withIntermediateDirectories: true)
        }
        let dest = destDir.appendingPathComponent(src.lastPathComponent)
        do {
            if fm.fileExists(atPath: dest.path) {
                // Replace an older copy (quit it first if it is running).
                for app in NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "") where app.processIdentifier != getpid() {
                    app.terminate()
                }
                try fm.removeItem(at: dest)
            }
            try fm.copyItem(at: src, to: dest)
            rlog("moved to \(dest.path)")
            // Tidy the original when it came from Downloads (a DMG is read-only; a translocated
            // copy lives under /private/var/…/AppTranslocation and is not ours to delete).
            if src.path.hasPrefix(home + "/Downloads/") { try? fm.trashItem(at: src, resultingItemURL: nil) }
        } catch {
            rlog("move failed: \(error)")
            let e = NSAlert(); e.messageText = "Could not move Darth Recorder"; e.informativeText = error.localizedDescription; e.runModal()
            return false
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: dest, configuration: cfg) { _, err in
            if let err { rlog("relaunch failed: \(err)") }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        return true
    }

    // MARK: menu

    func buildMenu() {
        if let b = statusItem.button {
            b.image = StatusIcon.image(.idle)
            b.toolTip = "Darth Recorder"
        }
        let m = NSMenu()
        statusLine.isEnabled = false
        m.addItem(statusLine)
        permLine.target = self
        m.addItem(permLine)
        shareLine.isEnabled = false
        m.addItem(shareLine)
        clientsLine.isEnabled = false
        m.addItem(clientsLine)
        m.addItem(.separator())
        startItem.target = self; m.addItem(startItem)
        displayItem.target = self; m.addItem(displayItem)
        stopItem.target = self; m.addItem(stopItem)
        previewItem.target = self; m.addItem(previewItem)
        m.addItem(.separator())
        authItem.target = self; m.addItem(authItem)
        uploadItem.target = self; m.addItem(uploadItem)
        pendingLine.target = self; pendingLine.action = #selector(uploadPendingFromMenu); m.addItem(pendingLine)
        m.addItem(.separator())
        let open = NSMenuItem(title: "Open Darth Meetings", action: #selector(openPWA), keyEquivalent: "o"); open.target = self; m.addItem(open)
        let reveal = NSMenuItem(title: "Show recordings folder", action: #selector(revealFolder), keyEquivalent: ""); reveal.target = self; m.addItem(reveal)
        let logs = NSMenuItem(title: "Show log", action: #selector(revealLog), keyEquivalent: ""); logs.target = self; m.addItem(logs)
        m.addItem(.separator())
        loginItem.target = self; m.addItem(loginItem)
        versionLine.isEnabled = false; m.addItem(versionLine)
        updateItem.target = self; m.addItem(updateItem)
        m.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Darth Recorder", action: #selector(quit), keyEquivalent: "q"); quit.target = self; m.addItem(quit)
        statusItem.menu = m
    }

    func refreshMenu() {
        let recording = recorder.isRecording
        if recording, let since = recorder.startedAt {
            let secs = Int(Date().timeIntervalSince(since))
            let seg = recorder.segments.count
            statusLine.title = String(format: "● Recording %@ · %02d:%02d%@ · %@", recorder.call.map { kindName($0.kind) } ?? "display", secs / 60, secs % 60, seg > 1 ? " · part \(seg)" : "", recorder.healthLine())
        } else if let c = detector.active.values.sorted(by: { $0.startedAt < $1.startedAt }).first {
            statusLine.title = "\(kindName(c.kind)) in progress — \(c.appName)"
        } else {
            statusLine.title = "No call detected"
        }
        let perm = CGPreflightScreenCaptureAccess()
        permLine.title = perm ? "Screen recording: allowed" : "Screen recording: NOT allowed — open settings…"
        permLine.isEnabled = !perm
        if let s = shares.active.last {
            shareLine.title = "Sharing: \(s.appName ?? s.appBundle) · \(s.target)"
            shareLine.isHidden = false
        } else {
            shareLine.isHidden = true
        }
        clientsLine.title = "PWA link: ws://127.0.0.1:\(WS_PORT) · \(clients) connected"
        startItem.title = detector.active.isEmpty ? "Start recording (main display)" : "Record this call"
        startItem.isHidden = recording
        displayItem.isHidden = recording
        stopItem.isHidden = !recording
        previewItem.isHidden = !recording
        previewItem.title = preview.isOpen ? "Hide preview" : "Show preview"
        authItem.title = auth.signingIn ? "Signing in…" : (auth.signedIn ? "Signed in as \(auth.email ?? "?") — sign out" : "Sign in to Darth Meetings…")
        authItem.isEnabled = !auth.signingIn
        uploadItem.state = autoUpload ? .on : .off
        let pending = Registry.shared.pendingUpload(automatic: false).count
        pendingLine.title = pending == 0 ? "No recordings waiting to upload" : "Upload \(pending) recording\(pending == 1 ? "" : "s") now"
        pendingLine.isEnabled = pending > 0 && auth.signedIn
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        if updater.installing { updateItem.title = "Installing update…"; updateItem.isEnabled = false }
        else if let s = updater.staged { updateItem.title = "Install \(s.version) and restart"; updateItem.isEnabled = true }
        else if updater.checking { updateItem.title = "Checking for updates…"; updateItem.isEnabled = false }
        else { updateItem.title = "Check for Updates…"; updateItem.isEnabled = true }
        if let b = statusItem.button {
            b.image = StatusIcon.image(recording ? .recording : (detector.active.isEmpty ? .idle : .callDetected))
        }
    }

    func kindName(_ k: CallKind) -> String {
        switch k {
        case .teams: return "Teams call"; case .meet: return "Meet call"; case .zoom: return "Zoom call"
        case .slack: return "Slack huddle"; case .facetime: return "FaceTime"; case .whatsapp: return "WhatsApp call"
        case .webex: return "Webex call"; case .discord: return "Discord call"; case .browser: return "Browser call"; case .other: return "Call"
        }
    }

    @objc func openScreenRecordingSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }
    @objc func openPWA() { NSWorkspace.shared.open(PWA_URL) }

    // MARK: self-update

    @objc func checkForUpdates() {
        if updater.staged != nil { installUpdateNow() } else { updater.check(manual: true) }
    }
    /// "Install and restart" from the banner/menu: stop a running recording first, then install.
    func installUpdateNow() {
        if recorder.isRecording { installAfterStop = true; stopRecording(reason: "update install"); return }
        updater.install(auto: false)
    }
    var installAfterStop = false
    func updaterEvent(_ ev: Updater.Event) {
        switch ev {
        case .upToDate(let v): banner.showMessage(title: "You're up to date (\(v))", sub: "Darth Recorder \(v) is the latest version.", accent: .info)
        case .error(let msg): banner.showMessage(title: "Update check failed", sub: msg)
        case .staged(let v):
            banner.showUpdate(version: v, sub: recorder.isRecording ? "Installs itself when the recording stops." : "Installs itself when your call ends.") { [weak self] in self?.installUpdateNow() }
        case .installing(let v): rlog("restarting to finish the update to \(v)")
        }
        broadcast("status")
    }
    @objc func toggleLogin() {
        do {
            let turningOff = SMAppService.mainApp.status == .enabled
            UserDefaults.standard.set(!turningOff, forKey: "loginItemUserChoice")   // explicit choice wins over the default
            EventLog.shared.log("login_item_toggle", ["enabled": !turningOff])
            if turningOff { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch { rlog("login item toggle failed: \(error)") }
        refreshMenu()
    }

    // MARK: auth + uploads

    @objc func toggleAuth() {
        if auth.signedIn { auth.signOut() } else { auth.signIn() }
    }
    @objc func toggleAutoUpload() {
        autoUpload = !autoUpload
        EventLog.shared.log("auto_upload_toggled", ["enabled": autoUpload], summary: "auto-upload \(autoUpload ? "ON" : "OFF")")
    }
    @objc func uploadPendingFromMenu() { uploadPending(force: true) }

    /// Upload everything still local (auto-upload on, signed in) — also runs at launch, so a
    /// recording made while signed out goes up as soon as somebody signs in.
    func uploadPending(force: Bool = false) {
        guard auth.signedIn, force || autoUpload else { return }
        for row in Registry.shared.pendingUpload(automatic: !force) {
            guard let id = row["id"] as? String, !uploader.isUploading(id) else { continue }
            uploader.upload(recordingId: id)
        }
    }

    /// darth-recorder://open | //start | //stop | //status — lets the PWA launch or drive us via a link.
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls {
            rlog("url: \(u.absoluteString)")
            switch u.host ?? u.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
            case "start": startRecording(for: detector.active.values.first)
            case "stop": stopRecording(reason: "url")
            case "open", "":
                if let b = statusItem.button { b.performClick(nil) }
            default: break
            }
        }
    }
    @objc func revealFolder() {
        try? FileManager.default.createDirectory(at: Paths.recordings, withIntermediateDirectories: true)
        NSWorkspace.shared.open(Paths.recordings)
    }
    @objc func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: NSString("~/Library/Logs/DarthRecorder/tray.log").expandingTildeInPath)])
    }
    @objc func quit() {
        if recorder.isRecording {
            recorder.onStopped = { [weak self] saved in
                self?.recordingStopped(saved)
                NSApp.terminate(nil)
            }
            stopRecording(reason: "quit")
        } else { NSApp.terminate(nil) }
    }
    @objc func startFromMenu() { startRecording(for: detector.active.values.first) }
    @objc func stopFromMenu() { stopRecording(reason: "menu") }
    /// "Record…": the 0.2.4 panel — pick a display or window, system audio / mic / upload.
    @objc func openRecordDialog() {
        guard !recorder.isRecording else { return }
        guard CGPreflightScreenCaptureAccess() else {
            banner.showMessage(title: "Screen recording not allowed", sub: "Enable Darth Recorder in System Settings → Privacy & Security → Screen Recording.")
            CGRequestScreenCaptureAccess()
            return
        }
        let pids = detector.active.values.sorted { $0.startedAt < $1.startedAt }.map { $0.pid }.filter { $0 > 0 }
        let videoDefault = detector.active.values.sorted { $0.startedAt < $1.startedAt }.first.map { RecordingController.profile(for: $0).0 != .audioOnly } ?? true
        RecordDialog.shared.present(callPids: pids, signedIn: auth.signedIn, autoUpload: autoUpload, videoDefault: videoDefault) { [weak self] options in
            guard let self, let options else { return }
            self.startRecording(for: self.detector.active.values.first, options: options)
        }
    }

    // MARK: calls

    /// The share watcher streams the unified log, so it runs only while there is something to
    /// watch: a live call or a recording.
    func updateShareWatcher() {
        let needed = !detector.active.isEmpty || recorder.isRecording
        if needed {
            if !shares.isWatching { shares.start() }
        } else if shares.isWatching {
            shares.stop()
            rlog("share detector: no call and not recording — watcher stopped")
        }
    }

    func callStarted(_ call: DetectedCall) {
        updateShareWatcher()
        refreshMenu()
        var ev = call.json
        let (profile, why) = RecordingController.profile(for: call)
        ev["profile"] = profile.rawValue; ev["profile_reason"] = why
        EventLog.shared.log("call_started", ev, summary: "call started: \(call.appName) [\(call.kind.rawValue)] \"\(call.title)\" → \(profile.rawValue) (\(why))")
        if call.pid > 0 {
            let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
            WindowPicker.logCandidates(phase: "detect", call: call, pick: pick)
        }
        if !recorder.isRecording { banner.showCall(call) }
        broadcast("call_started", ["call": call.json])
    }

    func callEnded(_ call: DetectedCall) {
        refreshMenu()
        defer { updateShareWatcher() }
        EventLog.shared.log("call_ended", call.json)
        broadcast("call_ended", ["call": call.json])
        if recorder.isRecording, let rc = recorder.call, rc.pid == call.pid, call.pid > 0 {
            recorder.noteCallEnded()   // cancels a window-gone hold: no display fallback after a call end
            startGrace()
        } else if !recorder.isRecording {
            banner.hide()
        }
        updater.installIfIdle()
    }

    // MARK: shares

    func shareStarted(_ s: ShareInfo) {
        refreshMenu()
        broadcast("share_started", ["share": s.json])
        recorder.shareStarted(s)
    }

    func shareEnded(_ s: ShareInfo) {
        refreshMenu()
        broadcast("share_ended", ["share": s.json])
        recorder.shareEnded(s)
    }

    // MARK: recording

    func startRecording(for call: DetectedCall?, displayOverride: CGDirectDisplayID? = nil) {
        var o = RecordingController.RecordOptions()
        if let d = displayOverride { o.source = .display(d) }
        startRecording(for: call, options: o)
    }

    func startRecording(for call: DetectedCall?, options: RecordingController.RecordOptions) {
        if recorder.state == .starting {
            // Record clicked again while the first start is still pending: cancel it and start
            // over (a wedged SCK start used to swallow every later click, 2026-09-16).
            recorder.cancelStart(reason: "record clicked again")
        }
        guard !recorder.isRecording else { return }
        guard CGPreflightScreenCaptureAccess() else {
            banner.showMessage(title: "Screen recording not allowed", sub: "Enable Darth Recorder in System Settings → Privacy & Security → Screen Recording.")
            CGRequestScreenCaptureAccess()
            return
        }
        cancelGrace(reason: "new recording")
        if RecordDialog.shared.isOpen { RecordDialog.shared.cancel() }
        recorder.start(call: call, options: options)
        refreshMenu()
    }

    /// Where the recording is happening — the banner belongs on that display.
    var recordingFrame: CGRect? { recorder.lastWindowFrame ?? recorder.call?.windowFrame }

    func recordingStarted() {
        updateShareWatcher()
        refreshMenu()
        systemWarned = false
        showRecordingBanner()
        tick()
        broadcast("recording_started")
        if PreviewPanel.wantedOpen { openPreview() }
    }

    /// Preview panel (0.3.0): next to the banner, on the banner's display.
    func openPreview() {
        guard recorder.isRecording else { return }
        preview.open(below: banner.frame, on: banner.screen)
        refreshMenu()
    }
    @objc func togglePreview() {
        if preview.isOpen { preview.close(remember: true) } else { openPreview() }
        refreshMenu()
    }

    func recordingLabel() -> String {
        let audio = recorder.currentSource?.isAudioOnly == true
        guard let c = recorder.call else { return audio ? "audio" : "display" }
        return audio ? "\(kindName(c.kind)) (audio)" : kindName(c.kind)
    }

    func showRecordingBanner() {
        banner.showRecording(label: recordingLabel(),
                             since: recorder.startedAt ?? Date(), near: recordingFrame) { [weak self] in
            self?.recorder.healthLine() ?? "Darth Recorder"
        }
    }

    /// Once per recording: system audio silent past the threshold → a warning that stays until
    /// dismissed (the recording itself continues). Mic and video only change the tick + event.
    var systemWarned = false
    func trackHealthChanged(_ track: String, ok: Bool) {
        guard recorder.isRecording else { return }
        if track == "system", !ok, !systemWarned {
            systemWarned = true
            banner.showMessage(title: "No system audio is being captured",
                               sub: "The other side will be missing from this recording — check the call app's audio output and this Mac's sound settings.",
                               accent: .warning, stoppable: true, near: recordingFrame, autoHide: nil)
        } else if track == "system", ok, systemWarned {
            // Back: replace the warning with the normal recording pill.
            showRecordingBanner()
        }
        broadcast("track_health", ["track": track, "ok": ok])
    }

    func stopRecording(reason: String) {
        cancelGrace(reason: "stopping")
        recorder.stop(reason: reason)
        refreshMenu()
    }

    func recordingStopped(_ saved: [String: Any]) {
        lastSaved = saved
        preview.close(remember: false)   // closes with the recording; the preference is untouched
        updateShareWatcher()
        refreshMenu()
        let id = (saved["recording_id"] as? String) ?? ""
        let keepLocal = (saved["upload"] as? Bool) == false
        let willUpload = autoUpload && auth.signedIn && !id.isEmpty && !keepLocal
        let path = (saved["path"] as? String).map { URL(fileURLWithPath: $0) }
        let secs = (saved["seconds"] as? Int) ?? 0
        if !auth.signedIn && !id.isEmpty {
            banner.showSignIn(title: "Recording saved (\(secs / 60)m \(secs % 60)s) — sign in to upload",
                              sub: "It is on this Mac only until you sign in to Darth Meetings.") { [weak self] in self?.auth.signIn() }
        } else {
            banner.showSaved(path ?? Paths.recordings, seconds: secs,
                             segments: (saved["segments"] as? Int) ?? 1, uploading: willUpload, keptLocal: keepLocal)
        }
        // `recording` must stay a boolean here — the file info goes under `saved`.
        broadcast("recording_stopped", ["saved": saved])
        api.shipEvents()
        if terminating {
            rlog("recording \(id) saved on the way out — uploads at next launch")
            return
        }
        if willUpload {
            uploader.upload(recordingId: id)
        } else if keepLocal {
            rlog("recording \(id) kept on this Mac by request — not uploaded")
        } else if !auth.signedIn && !id.isEmpty {
            rlog("recording \(id) stays local — not signed in")
        }
        if installAfterStop { installAfterStop = false; updater.install(auto: false) } else { updater.installIfIdle() }
    }

    func tick() {
        guard recorder.isRecording else { return }
        refreshMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.tick() }
    }

    // MARK: stop grace

    /// The call ended while we were recording: 60 s, a banner with Stop now / Keep recording,
    /// then an automatic stop.
    func startGrace() {
        guard graceTimer == nil else { return }
        let deadline = Date().addingTimeInterval(STOP_GRACE)
        graceDeadline = deadline
        banner.showGrace(secondsLeft: Int(STOP_GRACE), deadline: deadline, near: recordingFrame)
        EventLog.shared.log("stop_grace_started", ["seconds": STOP_GRACE], summary: "record: call ended — auto-stop in \(Int(STOP_GRACE)) s")
        graceTimer = Timer.scheduledTimer(withTimeInterval: STOP_GRACE, repeats: false) { [weak self] _ in
            self?.graceTimer = nil
            self?.graceDeadline = nil
            EventLog.shared.log("stop_grace_elapsed", [:], summary: "record: grace elapsed — stopping")
            self?.stopRecording(reason: "call ended (grace elapsed)")
        }
    }

    func cancelGrace(reason: String) {
        guard graceTimer != nil else { return }
        graceTimer?.invalidate(); graceTimer = nil; graceDeadline = nil
        EventLog.shared.log("stop_grace_cancelled", ["reason": reason])
    }

    /// "Keep recording" — the user says the call is still going.
    func keepRecording() {
        cancelGrace(reason: "user kept recording")
        if recorder.isRecording {
            showRecordingBanner()
        } else {
            banner.hide()
        }
    }

    // MARK: PWA protocol

    func statusPayload() -> [String: Any] {
        let pending = Registry.shared.pendingUpload().count
        var d: [String: Any] = [
            "version": VERSION,
            "screen_recording_permission": CGPreflightScreenCaptureAccess(),
            "calls": detector.active.values.sorted { $0.startedAt < $1.startedAt }.map { $0.json },
            "recording": recorder.isRecording,
            "signed_in": auth.signedIn,
            "email": auth.email ?? NSNull(),
            "device_id": auth.deviceId,
            "share": shares.active.last?.json ?? NSNull(),
            "recordings_pending_upload": pending,
            "auto_upload": autoUpload,
            "update_available": updater.available ?? api.serverLatest ?? NSNull(),
            "update_staged": updater.staged?.version ?? NSNull(),
            "ts": isoNow(),
        ]
        if recorder.isRecording {
            d["recording_since"] = isoString(recorder.startedAt ?? Date())
            d["recording_path"] = (recorder.segments.last?["path"] as? String) ?? ""
            d["recording_label"] = recordingLabel()
            d["recording_id"] = recorder.recordingId ?? NSNull()
            d["segment"] = recorder.segments.count
            d["mic"] = recorder.micActive
            d["options"] = recorder.options.json
            d["audio"] = recorder.healthJSON()
        }
        if let deadline = graceDeadline {
            d["stopping_in"] = max(0, Int(deadline.timeIntervalSinceNow.rounded()))
        }
        return d
    }

    /// Broadcast a full snapshot with `type` plus any event-specific fields.
    func broadcast(_ type: String, _ extra: [String: Any] = [:]) {
        var ev = statusPayload()
        ev["type"] = type
        for (k, v) in extra { ev[k] = v }
        server.broadcast(ev)
    }

    func handleCommand(_ cmd: String, _ obj: [String: Any]) {
        rlog("ws cmd: \(cmd)")
        EventLog.shared.log("ws_command", ["cmd": cmd, "args": obj.filter { $0.key != "cmd" }])
        switch cmd {
        case "start":
            // {cmd:"start", pid?, display_id?, window_id?, system_audio?, mic?, upload?} —
            // every field optional; absent = the automatic behaviour (0.2.4).
            let pid = (obj["pid"] as? Int).map { pid_t($0) }
            let call = pid.flatMap { detector.active[$0] } ?? detector.active.values.first
            var o = RecordingController.RecordOptions()
            if let wid = obj["window_id"] as? Int {
                o.source = .window(CGWindowID(wid), ShareDetector.windowInfo(CGWindowID(wid))?.title ?? "")
            } else if let did = obj["display_id"] as? Int {
                o.source = .display(CGDirectDisplayID(did))
            }
            if let v = obj["system_audio"] as? Bool { o.systemAudio = v }
            if let v = obj["mic"] as? Bool { o.mic = v }
            if let v = obj["upload"] as? Bool { o.upload = v }
            if let v = obj["video"] as? Bool { o.video = v }
            startRecording(for: call, options: o)
        case "open_record_dialog":
            // Test hook: same as the menu item. `auto_cancel_s` closes it again unattended.
            openRecordDialog()
            if let secs = obj["auto_cancel_s"] as? Double, secs > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + secs) { RecordDialog.shared.cancel() }
            }
        case "retry_failed_uploads": retryFailedUploads()   // test hook: the 30-minute timer's body
        case "preview":                                     // {open: true|false}
            if (obj["open"] as? Bool) ?? !preview.isOpen { openPreview() } else { preview.close(remember: true) }
            refreshMenu()
        case "snapshot_preview":                            // test hook: on-screen PNG of the preview + bar values
            var out: [String: Any] = ["open": preview.isOpen, "levels": preview.lastLevels]
            if let path = obj["onscreen_path"] as? String, let f = preview.frame {
                out["onscreen"] = BannerController.screenSnapshot(of: f, to: path, margin: 16)
            }
            rlog("preview: levels \(preview.lastLevels)")
            broadcast("preview_snapshot", out)
        case "simulate_start_hang":                         // test hook: next start sleeps N s inside a timed step
            recorder.simulateStartHang(seconds: (obj["seconds"] as? Double) ?? 20)
        case "simulate_start_exception":                    // test hook: next start raises an NSException in the guarded writer setup
            recorder.simulateStartException()
        case "simulate_main_queue_death":                   // test hook: the 2026-09-17 zombie — an NSException escaping a main-actor job
            // mode "task" (default) = raise inside `Task { @MainActor }`, exactly where the real
            // one came from (Recorder.init in the start task) — AppKit swallowed that one and the
            // main queue died. mode "block" = a plain DispatchQueue.main.async block; measured
            // 2026-09-18: that one is NOT swallowed, the process crashes (uncaught exception).
            let mode = (obj["mode"] as? String) ?? "task"
            rlog("TEST — raising an NSException inside a main-queue \(mode); the watchdog should relaunch this app")
            EventLog.shared.log("test_main_queue_death", ["mode": mode])
            let boom = { NSException(name: .genericException, reason: "simulated exception escaping a main-queue \(mode)", userInfo: nil).raise() }
            if mode == "block" { DispatchQueue.main.async(execute: boom) } else { Task { @MainActor in boom() } }
        case "snapshot_banner":                             // test hook: render the banner to a PNG
            let path = (obj["path"] as? String) ?? "~/Library/Logs/DarthRecorder/banner-snapshot.png"
            let ok = banner.snapshot(to: path)
            // Real on-screen pixels around the banner (this app has the Screen Recording grant).
            let onscreen = (obj["onscreen_path"] as? String).map { banner.screenSnapshot(to: $0) }
            broadcast("banner_snapshot", ["ok": ok, "path": path, "onscreen": onscreen ?? NSNull()])
        case "stop": stopRecording(reason: "pwa")
        case "status": broadcast("status")
        case "simulate_call":
            simulate(kind: (obj["kind"] as? String) ?? "teams", pid: pid_t((obj["pid"] as? Int) ?? 0),
                     bundleOverride: obj["bundle_id"] as? String, titleOverride: obj["title"] as? String)
        case "end_simulated": detector.endInjected(pid: pid_t((obj["pid"] as? Int) ?? 0))
        case "check_update": checkForUpdates()          // test hook: same as the menu item
        case "simulate_server_latest":                    // test hook: as if a heartbeat answered latest_app_version
            if let v = obj["version"] as? String { api.noteServerLatest(v) }
        case "simulate_share":
            let kind = (obj["kind"] as? String) == "display" ? "display" : "window"
            let wid = (obj["window_id"] as? Int).map { UInt32($0) }
            let did = (obj["display_id"] as? Int).map { UInt32($0) }
            let bundle = (obj["bundle_id"] as? String) ?? recorder.call?.bundleId ?? "com.microsoft.teams2.modulehost"
            let info = ShareInfo(id: "sim-share-\(Int(Date().timeIntervalSince1970))", appBundle: bundle,
                                 appName: obj["app"] as? String, kind: kind,
                                 displayID: kind == "display" ? (did ?? CGMainDisplayID()) : nil,
                                 windowID: kind == "window" ? wid : nil,
                                 windowOwner: wid.flatMap { ShareDetector.windowInfo($0)?.owner },
                                 windowTitle: wid.flatMap { ShareDetector.windowInfo($0)?.title },
                                 startedAt: Date())
            shares.injectShare(info)
        case "end_simulated_share": shares.endInjectedShare(id: obj["id"] as? String)
        case "login": if !auth.signedIn { auth.signIn() } else { broadcast("auth_changed") }
        case "logout": auth.signOut()
        case "set_auto_upload":
            if let v = obj["enabled"] as? Bool { autoUpload = v }
        case "upload":
            guard let id = obj["recording_id"] as? String else { rlog("upload: no recording_id"); return }
            let linked = obj["linked_event"] as? [String: Any]
            uploader.upload(recordingId: id, linkedEvent: linked)
        case "list_recordings":
            var msg: [String: Any] = statusPayload()
            msg["type"] = "recordings"
            msg["recordings"] = Registry.shared.all()
            if let req = obj["req"] { msg["req"] = req }
            server.broadcast(msg)
        default: rlog("unknown cmd \(cmd)")
        }
    }

    /// `{cmd:"simulate_call", kind, pid?}`. Without a pid it is a pure fake (records the main
    /// display). WITH a pid it pretends that real app is on a call, so the window picker, the
    /// window filter and the banner placement all run against a real window — that is how the
    /// window path is tested without dialling into a meeting.
    func simulate(kind: String, pid: pid_t = 0, bundleOverride: String? = nil, titleOverride: String? = nil) {
        let k = CallKind(rawValue: kind) ?? .teams
        var name = k == .teams ? "Microsoft Teams" : "Google Chrome"
        var bundle = k == .teams ? "com.microsoft.teams2" : "com.google.Chrome"
        var title = "Simulated call — MSC Contract, Rates overview"
        var frame: CGRect?
        if pid > 0 {
            let pick = WindowPicker.pick(kind: k, pid: pid)
            WindowPicker.logCandidates(phase: "simulate", call: nil, pick: pick)
            if let w = pick.window { title = w.title; frame = w.frame; name = w.owner }
            if let app = NSRunningApplication(processIdentifier: pid) {
                name = app.localizedName ?? name
                bundle = app.bundleIdentifier ?? "sim.pid.\(pid)"
            }
        }
        let call = DetectedCall(id: "sim-\(Int(Date().timeIntervalSince1970))", pid: pid, appName: name,
                                bundleId: bundleOverride ?? bundle, kind: k, title: titleOverride ?? title, windowFrame: frame, startedAt: Date())
        detector.inject(call)
    }
}

if let dir = ProcessInfo.processInfo.environment["DARTH_TRAY_RENDER_ICONS"] {
    StatusIcon.renderPreviews(to: dir)
    exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
