import AppKit

/// Notion-style floating call-out at the top of the main screen. Non-activating panel:
/// clicking Record does not steal focus from the meeting window.
final class BannerController {
    var onRecord: ((DetectedCall) -> Void)?
    var onStop: (() -> Void)?

    private var panel: NSPanel?
    private var currentCall: DetectedCall?
    private var hideTimer: Timer?
    private var tickTimer: Timer?

    private let icon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subLabel = NSTextField(labelWithString: "")
    private let primary = NSButton(title: "Record", target: nil, action: nil)
    private let secondary = NSButton(title: "Not now", target: nil, action: nil)

    // MARK: public

    func showCall(_ call: DetectedCall) {
        currentCall = call
        icon.image = NSImage(systemSymbolName: "video.fill", accessibilityDescription: nil)
        icon.contentTintColor = .systemGreen
        titleLabel.stringValue = "\(kindLabel(call.kind)) detected"
        subLabel.stringValue = call.title.isEmpty ? "\(call.appName) is using the microphone" : call.title
        primary.title = "Record"
        primary.isHidden = false
        primary.target = self; primary.action = #selector(recordTapped)
        secondary.title = "Not now"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(autoHideAfter: 45)
    }

    func showRecording(label: String, since: Date) {
        icon.image = NSImage(systemSymbolName: "record.circle.fill", accessibilityDescription: nil)
        icon.contentTintColor = .systemRed
        titleLabel.stringValue = "Recording \(label)"
        primary.isHidden = true
        secondary.title = "Stop"
        secondary.target = self; secondary.action = #selector(stopTapped)
        tickTimer?.invalidate()
        let update = { [weak self] in
            let s = Int(Date().timeIntervalSince(since))
            self?.subLabel.stringValue = String(format: "%02d:%02d · Darth Recorder", s / 60, s % 60)
        }
        update()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in update() }
        present(autoHideAfter: 6)   // collapse to the menu-bar dot after a few seconds
    }

    func showSaved(_ url: URL, seconds: Int) {
        tickTimer?.invalidate()
        icon.image = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)
        icon.contentTintColor = .systemGreen
        titleLabel.stringValue = "Recording saved (\(seconds / 60)m \(seconds % 60)s)"
        subLabel.stringValue = url.lastPathComponent
        primary.isHidden = false
        primary.title = "Show"
        primary.target = self; primary.action = #selector(showFileTapped)
        currentSaved = url
        secondary.title = "OK"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(autoHideAfter: 12)
    }

    func showMessage(title: String, sub: String) {
        icon.image = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
        icon.contentTintColor = .systemOrange
        titleLabel.stringValue = title
        subLabel.stringValue = sub
        primary.isHidden = true
        secondary.title = "OK"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(autoHideAfter: 10)
    }

    func hide() {
        hideTimer?.invalidate(); hideTimer = nil
        tickTimer?.invalidate(); tickTimer = nil
        panel?.orderOut(nil)
    }

    // MARK: internals

    private var currentSaved: URL?

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
        let width: CGFloat = 480, height: CGFloat = 64
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                        styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                        backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

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

        icon.symbolConfiguration = .init(pointSize: 20, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
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
            row.leadingAnchor.constraint(equalTo: fx.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: fx.trailingAnchor, constant: -14),
            row.centerYAnchor.constraint(equalTo: fx.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 26),
            text.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
        ])
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        buttons.setContentHuggingPriority(.required, for: .horizontal)
        return p
    }

    private func present(autoHideAfter secs: TimeInterval) {
        if panel == nil { panel = makePanel() }
        guard let p = panel else { return }
        if let screen = NSScreen.main ?? NSScreen.screens.first {
            let vf = screen.visibleFrame
            let x = vf.midX - p.frame.width / 2
            let y = vf.maxY - p.frame.height - 10
            p.setFrameOrigin(NSPoint(x: x, y: y))
        }
        p.alphaValue = 1
        p.orderFrontRegardless()
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { [weak self] _ in self?.fadeOut() }
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
        onRecord?(c)
    }
    @objc private func dismissTapped() { hide() }
    @objc private func stopTapped() { onStop?() }
    @objc private func showFileTapped() {
        if let u = currentSaved { NSWorkspace.shared.activateFileViewerSelecting([u]) }
        hide()
    }
}
