import AppKit
import RecorderCore

/// The floating call-out. Non-activating panel, so clicking Record never steals focus from
/// the meeting window.
///
/// 0.2.0 fixes what the beta plan calls out:
/// - it appears on the display that contains the CALL WINDOW (0.1.x used `NSScreen.main`,
///   which for a background app is an arbitrary display — people watched the wrong monitor),
/// - a 6 px accent bar on the left says what state we are in (green = call detected,
///   red = recording, amber = warning, blue = update),
/// - it slides in from the top edge instead of appearing,
/// - the panel is explicitly dark (`NSAppearance(named: .darkAqua)`), so labels are white on
///   the HUD material in both system appearances,
/// - while a call is live it stays as a compact pill instead of auto-hiding after 45 s, and
/// - every banner that warns about a recording carries a Stop button.
final class BannerController {
    var onRecord: ((DetectedCall) -> Void)?
    var onStop: (() -> Void)?
    var onKeepRecording: (() -> Void)?
    var onDismiss: (() -> Void)?

    enum Accent {
        case call, recording, warning, info, success
        var color: NSColor {
            switch self {
            case .call: return .systemGreen
            case .recording: return .systemRed
            case .warning: return .systemOrange
            case .info: return .systemBlue
            case .success: return .systemGreen
            }
        }
    }

    private var panel: NSPanel?
    private var currentCall: DetectedCall?
    private var hideTimer: Timer?
    private var tickTimer: Timer?
    private var targetFrame: CGRect?

    private let accentBar = NSView()
    private let icon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subLabel = NSTextField(labelWithString: "")
    private let primary = NSButton(title: "Record", target: nil, action: nil)
    private let secondary = NSButton(title: "Not now", target: nil, action: nil)

    private let fullWidth: CGFloat = 480
    private let fullHeight: CGFloat = 64
    private let pillHeight: CGFloat = 44

    // MARK: public

    /// A call is live and we are not recording it: compact pill, stays until Record / Not now
    /// / the call ends.
    func showCall(_ call: DetectedCall) {
        currentCall = call
        set(symbol: "video.fill", accent: .call,
            title: "\(kindLabel(call.kind))\(call.title.isEmpty ? "" : " · \(shorten(call.title))")",
            sub: call.title.isEmpty ? "\(call.appName) is using the microphone" : call.appName)
        primary.isHidden = false
        primary.title = "Record"
        primary.target = self; primary.action = #selector(recordTapped)
        secondary.isHidden = false
        secondary.title = "Not now"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(compact: true, autoHideAfter: nil, near: call.windowFrame)
        EventLog.shared.log("banner_shown", ["kind": "call", "call": call.json])
    }

    /// Recording: compact pill with the clock and Stop, stays for the whole recording.
    func showRecording(label: String, since: Date, near frame: CGRect?) {
        set(symbol: "record.circle.fill", accent: .recording, title: "Recording \(label)", sub: "00:00 · Darth Recorder")
        primary.isHidden = true
        secondary.isHidden = false
        secondary.title = "Stop"
        secondary.target = self; secondary.action = #selector(stopTapped)
        tickTimer?.invalidate()
        let update = { [weak self] in
            let s = Int(Date().timeIntervalSince(since))
            self?.subLabel.stringValue = String(format: "%02d:%02d · Darth Recorder", s / 60, s % 60)
        }
        update()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in update() }
        present(compact: true, autoHideAfter: nil, near: frame)
        EventLog.shared.log("banner_shown", ["kind": "recording", "label": label])
    }

    /// The call ended while we were recording: 60 s to decide.
    func showGrace(secondsLeft: Int, deadline: Date, near frame: CGRect?) {
        set(symbol: "exclamationmark.triangle.fill", accent: .warning, title: "Call ended — stopping the recording",
            sub: "Stopping in \(secondsLeft) s")
        primary.isHidden = false
        primary.title = "Stop now"
        primary.target = self; primary.action = #selector(stopTapped)
        secondary.isHidden = false
        secondary.title = "Keep recording"
        secondary.target = self; secondary.action = #selector(keepTapped)
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            let left = Int(deadline.timeIntervalSinceNow.rounded())
            if left <= 0 { t.invalidate(); return }
            self?.subLabel.stringValue = "Stopping in \(left) s"
        }
        present(compact: false, autoHideAfter: nil, near: frame)
        EventLog.shared.log("banner_shown", ["kind": "grace", "seconds": secondsLeft])
    }

    func showSaved(_ url: URL, seconds: Int, segments: Int, uploading: Bool) {
        tickTimer?.invalidate()
        set(symbol: "checkmark.circle.fill", accent: .success,
            title: "Recording saved (\(seconds / 60)m \(seconds % 60)s\(segments > 1 ? ", \(segments) parts" : ""))",
            sub: uploading ? "Uploading to Darth Meetings…" : url.lastPathComponent)
        primary.isHidden = false
        primary.title = "Show"
        primary.target = self; primary.action = #selector(showFileTapped)
        currentSaved = url
        secondary.isHidden = false
        secondary.title = "OK"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(compact: false, autoHideAfter: 12, near: nil)
    }

    /// Transient message. `stoppable` adds a Stop button — every warning shown while we are
    /// recording must have one.
    func showMessage(title: String, sub: String, accent: Accent = .warning, stoppable: Bool = false, near frame: CGRect? = nil) {
        tickTimer?.invalidate()
        set(symbol: accent == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill", accent: accent, title: title, sub: sub)
        primary.isHidden = !stoppable
        if stoppable {
            primary.title = "Stop"
            primary.target = self; primary.action = #selector(stopTapped)
        }
        secondary.isHidden = false
        secondary.title = "OK"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(compact: false, autoHideAfter: 10, near: frame)
        EventLog.shared.log("banner_shown", ["kind": "message", "title": title, "sub": sub])
    }

    /// Verified update staged while a call/recording is in progress: offer to install now.
    func showUpdate(version: String, sub: String, onInstall: @escaping () -> Void) {
        installAction = onInstall
        set(symbol: "arrow.down.circle.fill", accent: .info, title: "Darth Recorder \(version) is ready", sub: sub)
        primary.isHidden = false
        primary.title = "Install and restart"
        primary.target = self; primary.action = #selector(installTapped)
        secondary.isHidden = false
        secondary.title = "Later"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(compact: false, autoHideAfter: 20, near: nil)
    }

    func hide() {
        hideTimer?.invalidate(); hideTimer = nil
        tickTimer?.invalidate(); tickTimer = nil
        panel?.orderOut(nil)
        EventLog.shared.log("banner_hidden", [:])
    }

    // MARK: internals

    private var currentSaved: URL?
    private var installAction: (() -> Void)?

    private func set(symbol: String, accent: Accent, title: String, sub: String) {
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = accent.color
        accentBar.layer?.backgroundColor = accent.color.cgColor
        titleLabel.stringValue = title
        subLabel.stringValue = sub
    }

    private func shorten(_ s: String) -> String {
        s.count > 42 ? String(s.prefix(41)) + "…" : s
    }

    private func kindLabel(_ k: CallKind) -> String {
        switch k {
        case .teams: return "Teams call"
        case .meet: return "Google Meet call"
        case .zoom: return "Zoom call"
        case .slack: return "Slack huddle"
        case .facetime: return "FaceTime call"
        case .whatsapp: return "WhatsApp call"
        case .webex: return "Webex call"
        case .discord: return "Discord call"
        case .browser: return "Browser call"
        case .other: return "Call"
        }
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: fullWidth, height: fullHeight),
                        styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                        backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        // Explicit dark appearance: the HUD material is dark in both system appearances, so
        // without this the labels come out black-on-dark in Light Mode.
        p.appearance = NSAppearance(named: .darkAqua)

        let fx = NSVisualEffectView(frame: p.contentView!.bounds)
        fx.autoresizingMask = [.width, .height]
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 14
        fx.layer?.masksToBounds = true
        fx.layer?.borderWidth = 0.5
        fx.layer?.borderColor = NSColor.white.withAlphaComponent(0.15).cgColor
        p.contentView = fx

        accentBar.wantsLayer = true
        accentBar.layer?.backgroundColor = NSColor.systemGreen.cgColor
        accentBar.translatesAutoresizingMaskIntoConstraints = false
        fx.addSubview(accentBar)

        icon.symbolConfiguration = .init(pointSize: 18, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        subLabel.font = .systemFont(ofSize: 11)
        subLabel.textColor = .secondaryLabelColor
        subLabel.lineBreakMode = .byTruncatingTail
        let text = NSStackView(views: [titleLabel, subLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.translatesAutoresizingMaskIntoConstraints = false
        for b in [primary, secondary] {
            b.bezelStyle = .rounded
            b.controlSize = .small
            b.font = .systemFont(ofSize: 11, weight: .medium)
            b.translatesAutoresizingMaskIntoConstraints = false
        }
        primary.keyEquivalent = "\r"
        let buttons = NSStackView(views: [primary, secondary])
        buttons.orientation = .horizontal
        buttons.spacing = 6
        buttons.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [icon, text, buttons])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        fx.addSubview(row)
        NSLayoutConstraint.activate([
            accentBar.leadingAnchor.constraint(equalTo: fx.leadingAnchor),
            accentBar.topAnchor.constraint(equalTo: fx.topAnchor),
            accentBar.bottomAnchor.constraint(equalTo: fx.bottomAnchor),
            accentBar.widthAnchor.constraint(equalToConstant: 6),
            row.leadingAnchor.constraint(equalTo: accentBar.trailingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: fx.trailingAnchor, constant: -14),
            row.centerYAnchor.constraint(equalTo: fx.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 24),
            text.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        buttons.setContentHuggingPriority(.required, for: .horizontal)
        return p
    }

    /// The NSScreen that contains `frame` (CoreGraphics coordinates, top-left origin — what
    /// CGWindowListCopyWindowInfo gives us), else the screen under the mouse. NEVER
    /// `NSScreen.main`, which for an accessory app is whichever screen last had a key window.
    private func screen(near frame: CGRect?) -> NSScreen {
        if let frame {
            let displayID = WindowPicker.display(containing: frame)
            if let s = NSScreen.screens.first(where: {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
            }) { return s }
        }
        let mouse = NSEvent.mouseLocation
        if let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) { return s }
        return NSScreen.screens.first ?? NSScreen.main!
    }

    private func present(compact: Bool, autoHideAfter secs: TimeInterval?, near frame: CGRect?) {
        if panel == nil { panel = makePanel() }
        guard let p = panel else { return }
        subLabel.isHidden = false
        let height = compact ? pillHeight : fullHeight
        let width = compact ? 400 : fullWidth
        let scr = screen(near: frame)
        let vf = scr.visibleFrame
        rlog("banner: display \(scr.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] ?? "?") \(scr.frame) for window frame \(frame.map { "\($0)" } ?? "nil")")
        let x = vf.midX - width / 2
        let y = vf.maxY - height - 12
        let target = NSRect(x: x, y: y, width: width, height: height)
        targetFrame = target

        if p.isVisible {
            p.setFrame(target, display: true, animate: false)
        } else {
            // Slide in from just above the top edge of that screen.
            p.setFrame(NSRect(x: x, y: vf.maxY + 4, width: width, height: height), display: false)
            p.alphaValue = 0
            p.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                p.animator().setFrame(target, display: true)
                p.animator().alphaValue = 1
            }
        }
        hideTimer?.invalidate()
        hideTimer = nil
        if let secs {
            hideTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { [weak self] _ in self?.fadeOut() }
        }
    }

    private func fadeOut() {
        guard let p = panel else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.35
            p.animator().alphaValue = 0
        }, completionHandler: { [weak self] in self?.panel?.orderOut(nil); self?.panel?.alphaValue = 1 })
    }

    @objc private func recordTapped() {
        guard let c = currentCall else { return }
        EventLog.shared.log("banner_click", ["button": "record", "call": c.json], summary: "banner: Record clicked")
        onRecord?(c)
    }
    @objc private func dismissTapped() {
        EventLog.shared.log("banner_click", ["button": "dismiss"], summary: "banner: dismissed")
        hide()
        onDismiss?()
    }
    @objc private func stopTapped() {
        EventLog.shared.log("banner_click", ["button": "stop"], summary: "banner: Stop clicked")
        onStop?()
    }
    @objc private func keepTapped() {
        EventLog.shared.log("banner_click", ["button": "keep_recording"], summary: "banner: Keep recording clicked")
        onKeepRecording?()
    }
    @objc private func installTapped() { hide(); installAction?() }
    @objc private func showFileTapped() {
        if let u = currentSaved { NSWorkspace.shared.activateFileViewerSelecting([u]) }
        hide()
    }
}
