import AppKit
import CoreGraphics
import ServiceManagement
import RecorderCore

let VERSION = "0.1.3"
let WS_PORT: UInt16 = 47800
let PWA_URL = URL(string: "https://meetings.darth-internal.trames.io/")!

/// Menu-bar app: detects calls (CallDetector), shows the banner (BannerController),
/// serves the Meetings PWA over ws://127.0.0.1:47800 (LocalServer) and records the display
/// the call's window is on (RecorderCore.CaptureSession).
final class AppDelegate: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let detector = CallDetector()
    let server = LocalServer(port: WS_PORT)
    let banner = BannerController()

    var session: CaptureSession?
    var recordingCall: DetectedCall?
    var starting = false
    var clients = 0

    // menu items we update
    let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let permLine = NSMenuItem(title: "", action: #selector(openScreenRecordingSettings), keyEquivalent: "")
    let clientsLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let startItem = NSMenuItem(title: "Start recording (main display)", action: #selector(startFromMenu), keyEquivalent: "r")
    let stopItem = NSMenuItem(title: "Stop recording", action: #selector(stopFromMenu), keyEquivalent: "s")
    let loginItem = NSMenuItem(title: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
    let versionLine = NSMenuItem(title: "Darth Recorder \(VERSION)", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ n: Notification) {
        RLog.openFile("~/Library/Logs/DarthRecorder/tray.log")
        rlog("darth-tray \(VERSION) starting, pid \(getpid()), bundle \(Bundle.main.bundleIdentifier ?? "none") at \(Bundle.main.bundlePath)")
        if offerMoveToApplications() { return }   // relaunching from /Applications
        buildMenu()

        if !CGPreflightScreenCaptureAccess() {
            rlog("screen recording not granted → requesting")
            CGRequestScreenCaptureAccess()
        }

        detector.onStart = { [weak self] call in self?.callStarted(call) }
        detector.onEnd = { [weak self] call in self?.callEnded(call) }
        detector.start()

        server.statusProvider = { [weak self] in self?.statusPayload() ?? [:] }
        server.onCommand = { [weak self] cmd, obj in self?.handleCommand(cmd, obj) }
        server.onClientsChanged = { [weak self] n in self?.clients = n; self?.refreshMenu() }
        do { try server.start() } catch { rlog("local server failed: \(error)") }

        banner.onRecord = { [weak self] call in self?.startRecording(for: call) }
        banner.onStop = { [weak self] in self?.stopRecording() }

        if let sim = ProcessInfo.processInfo.environment["DARTH_TRAY_SIMULATE"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.simulate(kind: sim) }
        }
        refreshMenu()
        let seenKey = "firstRunShown"
        if !UserDefaults.standard.bool(forKey: seenKey) {
            UserDefaults.standard.set(true, forKey: seenKey)
            banner.showMessage(title: "Darth Recorder is running", sub: "It lives in your menu bar (the waveform icon). Turn on “Open at login” from its menu.")
        }
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
        clientsLine.isEnabled = false
        m.addItem(clientsLine)
        m.addItem(.separator())
        startItem.target = self; m.addItem(startItem)
        stopItem.target = self; m.addItem(stopItem)
        m.addItem(.separator())
        let open = NSMenuItem(title: "Open Darth Meetings", action: #selector(openPWA), keyEquivalent: "o"); open.target = self; m.addItem(open)
        let reveal = NSMenuItem(title: "Show recordings folder", action: #selector(revealFolder), keyEquivalent: ""); reveal.target = self; m.addItem(reveal)
        let logs = NSMenuItem(title: "Show log", action: #selector(revealLog), keyEquivalent: ""); logs.target = self; m.addItem(logs)
        m.addItem(.separator())
        loginItem.target = self; m.addItem(loginItem)
        versionLine.isEnabled = false; m.addItem(versionLine)
        m.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Darth Recorder", action: #selector(quit), keyEquivalent: "q"); quit.target = self; m.addItem(quit)
        statusItem.menu = m
    }

    func refreshMenu() {
        let recording = session != nil
        if let s = session {
            let secs = Int(Date().timeIntervalSince(s.startedAt))
            statusLine.title = String(format: "● Recording %@ · %02d:%02d", recordingCall.map { kindName($0.kind) } ?? "display", secs / 60, secs % 60)
        } else if let c = detector.active.values.sorted(by: { $0.startedAt < $1.startedAt }).first {
            statusLine.title = "\(kindName(c.kind)) in progress — \(c.appName)"
        } else {
            statusLine.title = "No call detected"
        }
        let perm = CGPreflightScreenCaptureAccess()
        permLine.title = perm ? "Screen recording: allowed" : "Screen recording: NOT allowed — open settings…"
        permLine.isEnabled = !perm
        clientsLine.title = "PWA link: ws://127.0.0.1:\(WS_PORT) · \(clients) connected"
        startItem.isHidden = recording || starting
        stopItem.isHidden = !recording
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
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
    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch { rlog("login item toggle failed: \(error)") }
        refreshMenu()
    }

    /// darth-recorder://open | //start | //stop | //status — lets the PWA launch or drive us via a link.
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls {
            rlog("url: \(u.absoluteString)")
            switch u.host ?? u.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) {
            case "start": startRecording(for: detector.active.values.first)
            case "stop": stopRecording()
            case "open", "":
                if let b = statusItem.button { b.performClick(nil) }
            default: break
            }
        }
    }
    @objc func revealFolder() {
        try? FileManager.default.createDirectory(at: recordingsDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(recordingsDir)
    }
    @objc func revealLog() {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: NSString("~/Library/Logs/DarthRecorder/tray.log").expandingTildeInPath)])
    }
    @objc func quit() {
        if let s = session {
            session = nil
            Task { @MainActor in await s.stop(); NSApp.terminate(nil) }
        } else { NSApp.terminate(nil) }
    }
    @objc func startFromMenu() { startRecording(for: detector.active.values.first) }
    @objc func stopFromMenu() { stopRecording() }

    // MARK: calls

    var recordingsDir: URL {
        FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0].appendingPathComponent("Darth Recorder", isDirectory: true)
    }

    func callStarted(_ call: DetectedCall) {
        refreshMenu()
        if session == nil { banner.showCall(call) }
        var ev = statusPayload(); ev["type"] = "call_started"; ev["call"] = call.json
        server.broadcast(ev)
    }

    func callEnded(_ call: DetectedCall) {
        refreshMenu()
        if session == nil { banner.hide() }
        var ev = statusPayload(); ev["type"] = "call_ended"; ev["call"] = call.json
        server.broadcast(ev)
        // If we were recording this call, the call ending is a strong hint to stop.
        if let rc = recordingCall, rc.pid == call.pid, call.pid > 0 {
            banner.showMessage(title: "Call ended — still recording", sub: "Stop from the banner, the menu bar, or the PWA.")
        }
    }

    // MARK: recording

    func displayForCall(_ call: DetectedCall?) -> CGDirectDisplayID {
        guard let f = call?.windowFrame else { return CGMainDisplayID() }
        var ids = [CGDirectDisplayID](repeating: 0, count: 8)
        var n: UInt32 = 0
        // Display whose bounds contain the window's centre (CG coords = top-left origin, same as CGWindowBounds).
        let centre = CGRect(x: f.midX, y: f.midY, width: 1, height: 1)
        if CGGetDisplaysWithRect(centre, 8, &ids, &n) == .success, n > 0 { return ids[0] }
        return CGMainDisplayID()
    }

    func startRecording(for call: DetectedCall?) {
        guard session == nil, !starting else { return }
        guard CGPreflightScreenCaptureAccess() else {
            banner.showMessage(title: "Screen recording not allowed", sub: "Enable Darth Recorder in System Settings → Privacy & Security → Screen Recording.")
            CGRequestScreenCaptureAccess()
            return
        }
        starting = true
        refreshMenu()
        let displayID = displayForCall(call)
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let name = "\(f.string(from: Date())) \(call?.kind.rawValue ?? "display").mp4"
        let url = recordingsDir.appendingPathComponent(name)
        Task { @MainActor in
            do {
                let (filter, label) = try await CaptureSession.displayFilter(displayID: displayID)
                let s = try await CaptureSession.start(filter: filter, label: label, fps: 5, audio: true, url: url)
                s.recorder.onStop = { [weak self] err in
                    DispatchQueue.main.async {
                        self?.banner.showMessage(title: "Recording interrupted", sub: err.localizedDescription)
                        self?.stopRecording()
                    }
                }
                self.session = s
                self.recordingCall = call
                self.starting = false
                self.refreshMenu()
                self.banner.showRecording(label: call.map { self.kindName($0.kind) } ?? "display", since: s.startedAt)
                self.tick()
                var ev = self.statusPayload(); ev["type"] = "recording_started"
                self.server.broadcast(ev)
            } catch {
                self.starting = false
                self.refreshMenu()
                rlog("start recording failed: \(error)")
                self.banner.showMessage(title: "Could not start recording", sub: error.localizedDescription)
            }
        }
    }

    func tick() {
        guard session != nil else { return }
        refreshMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.tick() }
    }

    func stopRecording() {
        guard let s = session else { return }
        session = nil
        let call = recordingCall
        recordingCall = nil
        refreshMenu()
        Task { @MainActor in
            await s.stop()
            let secs = Int(Date().timeIntervalSince(s.startedAt))
            let size = (try? FileManager.default.attributesOfItem(atPath: s.url.path)[.size] as? Int) ?? 0
            self.banner.showSaved(s.url, seconds: secs)
            var ev = self.statusPayload(); ev["type"] = "recording_stopped"
            ev["recording"] = ["path": s.url.path, "seconds": secs, "bytes": size, "call": call?.json as Any]
            self.server.broadcast(ev)
            self.refreshMenu()
        }
    }

    // MARK: PWA protocol

    func statusPayload() -> [String: Any] {
        var d: [String: Any] = [
            "version": VERSION,
            "screen_recording_permission": CGPreflightScreenCaptureAccess(),
            "calls": detector.active.values.sorted { $0.startedAt < $1.startedAt }.map { $0.json },
            "recording": session != nil,
            "ts": ISO8601DateFormatter().string(from: Date()),
        ]
        if let s = session {
            d["recording_since"] = ISO8601DateFormatter().string(from: s.startedAt)
            d["recording_path"] = s.url.path
            d["recording_label"] = recordingCall.map { kindName($0.kind) } ?? "display"
        }
        return d
    }

    func handleCommand(_ cmd: String, _ obj: [String: Any]) {
        rlog("ws cmd: \(cmd)")
        switch cmd {
        case "start":
            let pid = (obj["pid"] as? Int).map { pid_t($0) }
            let call = pid.flatMap { detector.active[$0] } ?? detector.active.values.first
            startRecording(for: call)
        case "stop": stopRecording()
        case "status":
            var s = statusPayload(); s["type"] = "status"; server.broadcast(s)
        case "simulate_call": simulate(kind: (obj["kind"] as? String) ?? "teams")
        case "end_simulated": detector.endInjected(pid: 0)
        default: rlog("unknown cmd \(cmd)")
        }
    }

    func simulate(kind: String) {
        let k = CallKind(rawValue: kind) ?? .teams
        let call = DetectedCall(id: "sim-\(Int(Date().timeIntervalSince1970))", pid: 0, appName: k == .teams ? "Microsoft Teams" : "Google Chrome",
                                bundleId: k == .teams ? "com.microsoft.teams2" : "com.google.Chrome", kind: k,
                                title: "Simulated call — MSC Contract, Rates overview", windowFrame: nil, startedAt: Date())
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
