import AppKit
import CoreGraphics
import RecorderCore

let VERSION = "0.1.1"
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

    func applicationDidFinishLaunching(_ n: Notification) {
        RLog.openFile("~/Library/Logs/DarthRecorder/tray.log")
        rlog("darth-tray \(VERSION) starting, pid \(getpid()), bundle \(Bundle.main.bundleIdentifier ?? "none")")
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
