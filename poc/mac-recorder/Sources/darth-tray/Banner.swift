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
    /// 0.3.0: the "Preview" capsule on the recording pill.
    var onPreview: (() -> Void)?
    /// 0.3.6: the pill was closed (× / auto-hide) — the menu's "Show banner" brings it back.
    var onHidden: (() -> Void)?
    var isVisible: Bool { panel?.isVisible == true }
    var frame: NSRect? { panel?.isVisible == true ? panel?.frame : nil }
    var screen: NSScreen? { panel?.screen }

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
    private var panelLoggedOnce = false
    private var currentCall: DetectedCall?
    private var hideTimer: Timer?
    private var tickTimer: Timer?
    private var targetFrame: CGRect?

    /// 0.2.7 look: tinted icon circle instead of the left accent bar, capsule buttons, a
    /// pulsing red dot next to the elapsed time while recording, 16 pt corners.
    private let iconCircle = NSView()
    private let icon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let subLabel = NSTextField(labelWithString: "")
    private let dot = NSView()
    private let primary = CapsuleButton(title: "Record", filled: true)
    private let secondary = CapsuleButton(title: "Not now", filled: false)
    /// 0.3.6: × on the recording pill — hides it (the recording goes on; the menu shows it again).
    private let closeButton = NSButton(title: "✕", target: nil, action: nil)
    private var currentAccent: Accent = .call

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

    /// Recording: compact pill with the clock and Stop. `detail` (0.2.6) is asked every second
    /// for the health ticks ("video ✓ · mic ✓ · system ✗"). 0.3.6: `autoHide` seconds after
    /// which the pill fades on its own (the recording goes on — the menu's "Show banner" or
    /// ⌘B brings it back), and a × to hide it at once. Warnings, the call-ended grace and
    /// the saved card still come back on their own.
    func showRecording(label: String, since: Date, near frame: CGRect?, autoHide: TimeInterval? = nil, detail: (() -> String)? = nil) {
        set(symbol: "record.circle.fill", accent: .recording, title: "Recording \(label)", sub: "00:00 · Darth Recorder")
        closeButton.isHidden = false
        dot.isHidden = false
        startPulse()
        primary.isHidden = false
        primary.title = "Stop"
        primary.target = self; primary.action = #selector(stopTapped)
        secondary.isHidden = false
        secondary.title = "Preview"
        secondary.target = self; secondary.action = #selector(previewTapped)
        tickTimer?.invalidate()
        let update = { [weak self] in
            let s = Int(Date().timeIntervalSince(since))
            let tail = detail?() ?? "Darth Recorder"
            self?.subLabel.stringValue = String(format: "%02d:%02d · %@", s / 60, s % 60, tail)
        }
        update()
        tickTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in update() }
        present(compact: true, autoHideAfter: autoHide, near: frame)
        EventLog.shared.log("banner_shown", ["kind": "recording", "label": label, "auto_hide_s": autoHide ?? NSNull()])
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

    func showSaved(_ url: URL, seconds: Int, segments: Int, uploading: Bool, keptLocal: Bool = false) {
        tickTimer?.invalidate()
        set(symbol: "checkmark.circle.fill", accent: .success,
            title: "Recording saved (\(seconds / 60)m \(seconds % 60)s\(segments > 1 ? ", \(segments) parts" : ""))",
            sub: uploading ? "Uploading to Darth Meetings…"
                : keptLocal ? "Kept on this Mac, not uploaded — \(url.lastPathComponent)"
                : url.lastPathComponent)
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
    func showMessage(title: String, sub: String, accent: Accent = .warning, stoppable: Bool = false, near frame: CGRect? = nil, autoHide: TimeInterval? = 10) {
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
        present(compact: false, autoHideAfter: autoHide, near: frame)
        EventLog.shared.log("banner_shown", ["kind": "message", "title": title, "sub": sub])
    }

    /// Verified update staged while a call/recording is in progress: offer to install now.
    /// Sign-in prompt: shown after an unsigned recording, on first run, and after an update when
    /// the user never signed in. Without sign-in nothing reaches the server (Atira, 2026-09-15).
    func showSignIn(title: String, sub: String, onSignIn: @escaping () -> Void) {
        tickTimer?.invalidate()
        signInAction = onSignIn
        set(symbol: "person.crop.circle.badge.exclamationmark", accent: .warning, title: title, sub: sub)
        primary.isHidden = false
        primary.title = "Sign in"
        primary.target = self; primary.action = #selector(signInTapped)
        secondary.isHidden = false
        secondary.title = "Later"
        secondary.target = self; secondary.action = #selector(dismissTapped)
        present(compact: false, autoHideAfter: 45, near: nil)
        EventLog.shared.log("banner_shown", ["kind": "sign_in", "title": title])
    }

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
        let was = panel?.isVisible == true
        panel?.orderOut(nil)
        EventLog.shared.log("banner_hidden", [:])
        if was { onHidden?() }
    }

    // MARK: internals

    private var currentSaved: URL?
    private var installAction: (() -> Void)?
    private var signInAction: (() -> Void)?

    private func set(symbol: String, accent: Accent, title: String, sub: String) {
        currentAccent = accent
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = accent.color
        iconCircle.layer?.backgroundColor = accent.color.withAlphaComponent(0.22).cgColor
        iconCircle.layer?.borderColor = accent.color.withAlphaComponent(0.55).cgColor
        (panel?.contentView as? NSVisualEffectView)?.layer?.borderColor = accent.color.withAlphaComponent(0.35).cgColor
        primary.fill = accent.color
        closeButton.isHidden = true
        dot.isHidden = true
        dot.layer?.removeAllAnimations()
        titleLabel.stringValue = title
        subLabel.stringValue = sub
    }

    /// The little red dot breathes while we record.
    private func startPulse() {
        dot.layer?.removeAllAnimations()
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1.0; a.toValue = 0.25
        a.duration = 0.9
        a.autoreverses = true
        a.repeatCount = .infinity
        a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.layer?.add(a, forKey: "pulse")
    }

    /// Test hook (0.2.7): render the banner's content view to a PNG — this is how the look is
    /// checked from a shell that has no Screen Recording grant.
    @discardableResult
    func snapshot(to path: String) -> Bool {
        guard let v = panel?.contentView, panel?.isVisible == true,
              let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return false }
        v.cacheDisplay(in: v.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        do { try png.write(to: url); rlog("banner: snapshot \(Int(rep.pixelsWide))x\(Int(rep.pixelsHigh)) → \(url.path)"); return true }
        catch { rlog("banner: snapshot failed: \(error)"); return false }
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
                        styleMask: [.nonactivatingPanel, .borderless],
                        backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        // 0.3.6: never part of another app's screen share or capture (Teams / Meet / Zoom
        // sharing this display do not include the pill; the person still sees it).
        p.sharingType = .none
        // Explicit dark appearance: the HUD material is dark in both system appearances, so
        // without this the labels come out black-on-dark in Light Mode.
        p.appearance = NSAppearance(named: .darkAqua)

        let fx = NSVisualEffectView(frame: p.contentView!.bounds)
        fx.autoresizingMask = [.width, .height]
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 16
        fx.layer?.cornerCurve = .continuous
        fx.layer?.masksToBounds = true
        // 0.2.8: the layer mask does NOT clip a behind-window material — its backdrop still drew
        // as a square behind the rounded card. NSVisualEffectView needs its own maskImage.
        fx.maskImage = Self.roundedMask(radius: 16)
        fx.layer?.borderWidth = 1
        fx.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        p.contentView = fx

        iconCircle.wantsLayer = true
        iconCircle.layer?.cornerRadius = 15
        iconCircle.layer?.borderWidth = 1
        iconCircle.translatesAutoresizingMaskIntoConstraints = false
        icon.symbolConfiguration = .init(pointSize: 14, weight: .semibold)
        icon.translatesAutoresizingMaskIntoConstraints = false
        iconCircle.addSubview(icon)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        subLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        subLabel.textColor = .secondaryLabelColor
        subLabel.lineBreakMode = .byTruncatingTail
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemRed.cgColor
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.isHidden = true
        let subRow = NSStackView(views: [dot, subLabel])
        subRow.orientation = .horizontal
        subRow.alignment = .centerY
        subRow.spacing = 5
        let text = NSStackView(views: [titleLabel, subRow])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.translatesAutoresizingMaskIntoConstraints = false
        for b in [primary, secondary] { b.translatesAutoresizingMaskIntoConstraints = false }
        primary.keyEquivalent = "\r"
        closeButton.isBordered = false
        closeButton.font = .systemFont(ofSize: 11, weight: .bold)
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self; closeButton.action = #selector(closeTapped)
        closeButton.toolTip = "Hide this banner (the recording continues; the menu shows it again)"
        closeButton.isHidden = true
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        let buttons = NSStackView(views: [primary, secondary, closeButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [iconCircle, text, buttons])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        fx.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: fx.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: fx.trailingAnchor, constant: -14),
            row.centerYAnchor.constraint(equalTo: fx.centerYAnchor),
            iconCircle.widthAnchor.constraint(equalToConstant: 30),
            iconCircle.heightAnchor.constraint(equalToConstant: 30),
            icon.centerXAnchor.constraint(equalTo: iconCircle.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: iconCircle.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            text.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        buttons.setContentHuggingPriority(.required, for: .horizontal)
        return p
    }

    /// A stretchable rounded-rect mask for NSVisualEffectView (cap insets = the radius).
    private static func roundedMask(radius r: CGFloat) -> NSImage {
        let side = r * 2 + 1
        let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    /// Test hook (0.2.8): real on-screen pixels around the banner via CGWindowListCreateImage —
    /// the tray has the Screen Recording grant, the shell driving the tests does not.
    @discardableResult
    func screenSnapshot(to path: String, margin: CGFloat = 24) -> Bool {
        guard let p = panel, p.isVisible else { return false }
        return Self.screenSnapshot(of: p.frame, to: path, margin: margin)
    }

    /// Real on-screen pixels of any window frame (Cocoa coordinates) — shared with the preview.
    @discardableResult
    static func screenSnapshot(of frame: NSRect, to path: String, margin: CGFloat = 24) -> Bool {
        guard let s = NSScreen.screens.first else { return false }
        let f = frame.insetBy(dx: -margin, dy: -margin)
        // Cocoa (bottom-left, per-screen) → CG global (top-left of the primary display).
        let primaryH = s.frame.height
        let cg = CGRect(x: f.origin.x, y: primaryH - f.maxY, width: f.width, height: f.height)
        guard let img = CGWindowListCreateImage(cg, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
            rlog("banner: on-screen snapshot failed (no image)"); return false
        }
        let rep = NSBitmapImageRep(cgImage: img)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        do { try png.write(to: url); rlog("banner: on-screen snapshot \(img.width)x\(img.height) → \(url.path)"); return true }
        catch { rlog("banner: on-screen snapshot failed: \(error)"); return false }
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

        if panelLoggedOnce == false {
            panelLoggedOnce = true
            rlog("banner: window opaque=\(p.isOpaque) background=\(p.backgroundColor == .clear ? "clear" : "\(p.backgroundColor)") shadow=\(p.hasShadow) styleMask=\(p.styleMask.rawValue) maskImage=\((p.contentView as? NSVisualEffectView)?.maskImage != nil)")
        }
        if p.isVisible {
            p.setFrame(target, display: true, animate: false)
            p.invalidateShadow()
        } else {
            // Slide in from just above the top edge of that screen.
            p.setFrame(NSRect(x: x, y: vf.maxY + 4, width: width, height: height), display: false)
            p.alphaValue = 0
            p.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.22
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                p.animator().setFrame(target, display: true)
                p.animator().alphaValue = 1
            }, completionHandler: { p.invalidateShadow() })
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
        }, completionHandler: { [weak self] in
            self?.panel?.orderOut(nil); self?.panel?.alphaValue = 1
            EventLog.shared.log("banner_hidden", ["auto": true])
            self?.onHidden?()
        })
    }

    @objc private func closeTapped() {
        EventLog.shared.log("banner_click", ["button": "close"], summary: "banner: hidden by the user (×)")
        hide()
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
    @objc private func previewTapped() {
        EventLog.shared.log("banner_click", ["button": "preview"], summary: "banner: Preview clicked")
        onPreview?()
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
    @objc private func signInTapped() { EventLog.shared.log("banner_click", ["action": "sign_in"]); hide(); signInAction?() }
    @objc private func showFileTapped() {
        if let u = currentSaved { NSWorkspace.shared.activateFileViewerSelecting([u]) }
        hide()
    }
}


/// Capsule button for the banner: no AppKit bezel, a rounded layer, filled with the accent
/// (primary) or a translucent white (secondary), white label.
final class CapsuleButton: NSButton {
    var fill: NSColor = .systemRed { didSet { needsDisplay = true; layer?.backgroundColor = bg } }
    let filled: Bool
    private var bg: CGColor { (filled ? fill : NSColor.white.withAlphaComponent(0.14)).cgColor }

    init(title: String, filled: Bool) {
        self.filled = filled
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        wantsLayer = true
        bezelStyle = .rounded
        font = .systemFont(ofSize: 11, weight: .semibold)
        contentTintColor = .white
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = bg
        setButtonType(.momentaryChange)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var title: String {
        didSet { attributedTitle = NSAttributedString(string: title, attributes: [.foregroundColor: NSColor.white, .font: font ?? .systemFont(ofSize: 11, weight: .semibold)]) }
    }
    override var intrinsicContentSize: NSSize {
        let s = super.intrinsicContentSize
        return NSSize(width: s.width + 22, height: 24)
    }
    override func layout() { super.layout(); layer?.cornerRadius = bounds.height / 2 }
    override func mouseDown(with event: NSEvent) {
        layer?.backgroundColor = (filled ? fill.withAlphaComponent(0.7) : NSColor.white.withAlphaComponent(0.26)).cgColor
        super.mouseDown(with: event)
        layer?.backgroundColor = bg
    }
}
