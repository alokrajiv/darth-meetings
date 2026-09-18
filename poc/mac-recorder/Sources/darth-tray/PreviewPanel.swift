import AppKit
import CoreImage
import CoreVideo
import RecorderCore

/// "Preview" (0.3.0): a small floating panel next to the banner showing what is being recorded —
/// a live thumbnail (≤ 4 fps, downscaled from the frames already flowing to the encoder) and two
/// live level bars (system, mic) fed by the 0.2.6 meters at 10 Hz with peak-hold. Non-activating,
/// excluded from capture like the banner (display captures exclude this whole app since 0.2.7;
/// window captures only see the call window). Remembers open/closed in UserDefaults
/// (`previewOpen`) and closes with the recording.
final class PreviewPanel: NSObject, NSWindowDelegate {
    static let width: CGFloat = 340
    private var panel: NSPanel?
    private let image = NSImageView()
    private let placeholder = NSTextField(labelWithString: "audio only")
    private let systemBar = LevelBar(name: "system")
    private let micBar = LevelBar(name: "mic")
    /// 0.3.2: the last 10 s of each track as a scrolling envelope, 20 ms per point.
    private let systemStrip = LevelHistoryView()
    private let micStrip = LevelHistoryView()
    private var timer: Timer?
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let convertQueue = DispatchQueue(label: "darth.preview.convert", qos: .utility)
    private var converting = false
    private(set) var framesShown = 0
    var onClosed: (() -> Void)?
    /// Asked at 10 Hz: (systemMeter, micMeter, health, mic AGC gain in dB) — nil meter = track not requested.
    var levelsProvider: (() -> (system: LevelMeter?, mic: LevelMeter?, systemOK: Bool?, micOK: Bool?, audioOnly: Bool, micGainDb: Float))?

    var isOpen: Bool { panel?.isVisible == true }
    var frame: NSRect? { panel?.frame }
    /// Last bar values, for the test hook / log.
    var lastLevels: [String: Any] { ["system": systemBar.json, "mic": micBar.json, "frames_shown": framesShown] }

    func open(below bannerFrame: NSRect?, on screen: NSScreen?) {
        if panel == nil { panel = makePanel() }
        guard let p = panel else { return }
        let scr = screen ?? NSScreen.screens.first!
        let vf = scr.visibleFrame
        let size = p.frame.size
        let x = bannerFrame.map { $0.maxX - size.width } ?? (vf.midX - size.width / 2)
        let y = bannerFrame.map { $0.minY - size.height - 8 } ?? (vf.maxY - size.height - 80)
        p.setFrame(NSRect(x: max(vf.minX, x), y: max(vf.minY, y), width: size.width, height: size.height), display: true)
        p.alphaValue = 0
        p.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = 0.18; p.animator().alphaValue = 1 },
                                             completionHandler: { p.invalidateShadow() })
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.tick() }
        timer?.tolerance = 0.02
        tick()
        UserDefaults.standard.set(true, forKey: "previewOpen")
        EventLog.shared.log("preview_opened", [:])
        rlog("preview: opened at \(p.frame)")
    }

    func close(remember: Bool) {
        timer?.invalidate(); timer = nil
        guard let p = panel, p.isVisible else { return }
        p.orderOut(nil)
        if remember { UserDefaults.standard.set(false, forKey: "previewOpen") }
        EventLog.shared.log("preview_closed", ["remembered": remember])
        rlog("preview: closed")
    }

    static var wantedOpen: Bool { UserDefaults.standard.object(forKey: "previewOpen") as? Bool ?? false }

    /// From the recorder's sample queue, ≤ 4 fps. Converted off-main, shown on main.
    func showFrame(_ pb: CVPixelBuffer) {
        guard isOpen, !converting else { return }
        converting = true
        convertQueue.async { [weak self] in
            guard let self else { return }
            defer { self.converting = false }
            let ci = CIImage(cvPixelBuffer: pb)
            let scale = (Self.width - 24) * 2 / max(1, ci.extent.width)   // 2x for Retina
            let scaled = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            guard let cg = self.ciContext.createCGImage(scaled, from: scaled.extent) else { return }
            let img = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / 2, height: CGFloat(cg.height) / 2))
            DispatchQueue.main.async {
                self.image.image = img
                self.placeholder.isHidden = true
                self.framesShown += 1
            }
        }
    }

    private func tick() {
        guard let l = levelsProvider?() else { return }
        if l.audioOnly { image.image = nil; placeholder.isHidden = false }
        systemBar.isHidden = l.system == nil
        systemStrip.isHidden = l.system == nil
        micBar.isHidden = l.mic == nil
        micStrip.isHidden = l.mic == nil
        if let m = l.system {
            systemBar.update(levelDb: m.levelDb, audible: m.audible, silentSeconds: m.secondsSinceAudible, bad: l.systemOK == false)
            systemStrip.update(levels: m.recentLevelsDb(), bad: l.systemOK == false)
        }
        if let m = l.mic {
            micBar.update(levelDb: m.levelDb, audible: m.audible, silentSeconds: m.secondsSinceAudible, bad: l.micOK == false, gainDb: l.micGainDb)
            micStrip.update(levels: m.recentLevelsDb(), bad: l.micOK == false)
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { close(remember: true); onClosed?(); return false }

    private func makePanel() -> NSPanel {
        let thumbH = round((Self.width - 24) * 10 / 16)
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: thumbH + 24 + 2 * 26 + 2 * (LevelHistoryView.height + 6) + 8),
                        styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.appearance = NSAppearance(named: .darkAqua)
        p.delegate = self

        let fx = NSVisualEffectView(frame: p.contentView!.bounds)
        fx.autoresizingMask = [.width, .height]
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 14
        fx.layer?.cornerCurve = .continuous
        fx.layer?.masksToBounds = true
        fx.layer?.borderWidth = 1
        fx.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
        fx.maskImage = {
            let r: CGFloat = 14, side = r * 2 + 1
            let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
                NSColor.black.setFill(); NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill(); return true
            }
            img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r); img.resizingMode = .stretch
            return img
        }()
        p.contentView = fx

        let thumb = NSView()
        thumb.wantsLayer = true
        thumb.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.55).cgColor
        thumb.layer?.cornerRadius = 8
        thumb.layer?.masksToBounds = true
        thumb.translatesAutoresizingMaskIntoConstraints = false
        image.imageScaling = .scaleProportionallyUpOrDown
        image.translatesAutoresizingMaskIntoConstraints = false
        thumb.addSubview(image)
        placeholder.font = .systemFont(ofSize: 12, weight: .medium)
        placeholder.textColor = .tertiaryLabelColor
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholder.isHidden = true
        thumb.addSubview(placeholder)

        let close = NSButton(title: "✕", target: self, action: #selector(closeTapped))
        close.isBordered = false
        close.font = .systemFont(ofSize: 11, weight: .bold)
        close.contentTintColor = .secondaryLabelColor
        close.translatesAutoresizingMaskIntoConstraints = false

        let stack = NSStackView(views: [thumb, systemBar, systemStrip, micBar, micStrip])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        fx.addSubview(stack)
        fx.addSubview(close)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: fx.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: fx.trailingAnchor),
            stack.topAnchor.constraint(equalTo: fx.topAnchor),
            thumb.widthAnchor.constraint(equalToConstant: Self.width - 24),
            thumb.heightAnchor.constraint(equalToConstant: thumbH),
            image.leadingAnchor.constraint(equalTo: thumb.leadingAnchor),
            image.trailingAnchor.constraint(equalTo: thumb.trailingAnchor),
            image.topAnchor.constraint(equalTo: thumb.topAnchor),
            image.bottomAnchor.constraint(equalTo: thumb.bottomAnchor),
            placeholder.centerXAnchor.constraint(equalTo: thumb.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: thumb.centerYAnchor),
            systemBar.widthAnchor.constraint(equalToConstant: Self.width - 24),
            micBar.widthAnchor.constraint(equalToConstant: Self.width - 24),
            systemStrip.widthAnchor.constraint(equalToConstant: Self.width - 24),
            micStrip.widthAnchor.constraint(equalToConstant: Self.width - 24),
            close.trailingAnchor.constraint(equalTo: fx.trailingAnchor, constant: -16),
            close.topAnchor.constraint(equalTo: fx.topAnchor, constant: 14),
        ])
        return p
    }

    @objc private func closeTapped() { close(remember: true); onClosed?() }
}

/// One level bar: −60…0 dBFS, fill green when audible / grey when quiet / red when the track is
/// ✗, a peak-hold marker (decays ~1.5 s), name on the left, "silent Ns" or the dB on the right.
final class LevelBar: NSView {
    let name: String
    private var level: Float = -120
    private var peak: Float = -120
    private var peakAt = Date.distantPast
    private var audible = false
    private var bad = false
    private var silentSeconds: TimeInterval = 0
    private let label = NSTextField(labelWithString: "")
    private let value = NSTextField(labelWithString: "")

    init(name: String) {
        self.name = name
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 22).isActive = true
        for t in [label, value] {
            t.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
            t.textColor = .secondaryLabelColor
            t.translatesAutoresizingMaskIntoConstraints = false
            addSubview(t)
        }
        label.stringValue = name
        value.alignment = .right
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.widthAnchor.constraint(equalToConstant: 46),
            value.trailingAnchor.constraint(equalTo: trailingAnchor),
            value.centerYAnchor.constraint(equalTo: centerYAnchor),
            value.widthAnchor.constraint(equalToConstant: 76),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(levelDb: Float, audible: Bool, silentSeconds: TimeInterval, bad: Bool, gainDb: Float = 0) {
        level = levelDb
        self.audible = audible
        self.bad = bad
        self.silentSeconds = silentSeconds
        if levelDb >= peak || Date().timeIntervalSince(peakAt) > 1.5 { peak = levelDb; peakAt = Date() }
        // "+34" after the level = the AGC gain currently applied to this track (0.3.2).
        let gain = gainDb >= 1 ? String(format: " +%.0f", gainDb) : ""
        value.stringValue = bad || (!audible && silentSeconds >= 5)
            ? "silent \(Int(silentSeconds))s"
            : (levelDb <= -119 ? "—" : String(format: "%.0f dB", levelDb) + gain)
        value.textColor = bad ? .systemRed : .secondaryLabelColor
        needsDisplay = true
    }

    var json: [String: Any] {
        ["level_db": Double((level * 10).rounded() / 10), "peak_db": Double((peak * 10).rounded() / 10),
         "audible": audible, "bad": bad, "silent_s": Int(silentSeconds), "fill": Double(Self.fraction(level))]
    }

    static func fraction(_ db: Float) -> Float { max(0, min(1, (db + 60) / 60)) }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSRect(x: 50, y: bounds.midY - 4, width: bounds.width - 50 - 80, height: 8)
        NSColor.white.withAlphaComponent(0.10).setFill()
        NSBezierPath(roundedRect: track, xRadius: 4, yRadius: 4).fill()
        let f = CGFloat(Self.fraction(level))
        if f > 0 {
            let fill = NSRect(x: track.minX, y: track.minY, width: track.width * f, height: track.height)
            (bad ? NSColor.systemRed : (audible ? NSColor.systemGreen : NSColor.white.withAlphaComponent(0.35))).setFill()
            NSBezierPath(roundedRect: fill, xRadius: 4, yRadius: 4).fill()
        }
        let pf = CGFloat(Self.fraction(peak))
        if pf > 0.02 {
            let x = track.minX + track.width * pf
            (bad ? NSColor.systemRed : NSColor.white.withAlphaComponent(0.8)).setFill()
            NSRect(x: x - 1, y: track.minY - 1, width: 2, height: track.height + 2).fill()
        }
    }
}


/// The last 10 s of one track as a scrolling envelope (0.3.2): one point per 20 ms bin from
/// `LevelMeter.recentLevelsDb()`, newest at the right, drawn as a symmetric "waveform" whose
/// half-height is the −60…0 dBFS fraction. Faint ticks every second. Alok, 2026-09-18: "a
/// waveform for the last 10 seconds moving like a graph, so I can see if it's up compared to
/// 3 seconds before".
final class LevelHistoryView: NSView {
    static let height: CGFloat = 40
    private var levels: [Float] = []
    private var bad = false

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: Self.height).isActive = true
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.35).cgColor
        layer?.cornerRadius = 6
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(levels: [Float], bad: Bool) {
        self.levels = levels
        self.bad = bad
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width, h = bounds.height, mid = h / 2
        // 1 s grid (50 bins) + centre line.
        NSColor.white.withAlphaComponent(0.08).setFill()
        NSRect(x: 0, y: mid - 0.5, width: w, height: 1).fill()
        let bins = max(1, levels.count)
        for sec in stride(from: 0, to: bins, by: 50) {
            let x = w * CGFloat(sec) / CGFloat(bins)
            NSRect(x: x, y: 0, width: 1, height: h).fill()
        }
        guard !levels.isEmpty else { return }
        // One column per pixel: the loudest bin in that pixel's span.
        let px = Int(w)
        guard px > 0 else { return }
        let path = NSBezierPath()
        var tops: [CGFloat] = []
        tops.reserveCapacity(px)
        for x in 0..<px {
            let b0 = x * bins / px, b1 = max(b0 + 1, (x + 1) * bins / px)
            var m: Float = -120
            for b in b0..<min(b1, bins) { m = max(m, levels[b]) }
            let f = CGFloat(LevelBar.fraction(m))
            tops.append(max(0.5, (mid - 2) * f))
        }
        path.move(to: NSPoint(x: 0, y: mid + tops[0]))
        for x in 1..<px { path.line(to: NSPoint(x: CGFloat(x), y: mid + tops[x])) }
        for x in stride(from: px - 1, through: 0, by: -1) { path.line(to: NSPoint(x: CGFloat(x), y: mid - tops[x])) }
        path.close()
        (bad ? NSColor.systemRed : NSColor.systemGreen).withAlphaComponent(0.75).setFill()
        path.fill()
        // "now" edge.
        NSColor.white.withAlphaComponent(0.5).setFill()
        NSRect(x: w - 1, y: 0, width: 1, height: h).fill()
    }
}
