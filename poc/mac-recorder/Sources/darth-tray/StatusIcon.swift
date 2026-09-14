import AppKit

/// Menu-bar glyph: the Darth Meetings five-bar waveform (same proportions as
/// public/icons/icon-512.png), drawn vectorially so it is crisp at 1x/2x and, as a template
/// image, follows the menu bar's light/dark appearance.
enum StatusIcon {
    enum State { case idle, callDetected, recording }

    /// Bar heights relative to the tallest, measured off the app icon.
    private static let bars: [CGFloat] = [0.38, 0.72, 1.0, 0.72, 0.38]

    static func image(_ state: State) -> NSImage {
        let size = NSSize(width: 20, height: 18)
        let img = NSImage(size: size, flipped: false) { rect in
            let barW: CGFloat = 2.6
            let gap: CGFloat = 1.3
            let totalW = CGFloat(bars.count) * barW + CGFloat(bars.count - 1) * gap
            let maxH: CGFloat = 15
            let x0 = (rect.width - totalW) / 2
            let color: NSColor = state == .recording ? .systemRed : .black
            color.setFill()
            for (i, h) in bars.enumerated() {
                let bh = maxH * h
                let r = NSRect(x: x0 + CGFloat(i) * (barW + gap), y: (rect.height - bh) / 2, width: barW, height: bh)
                NSBezierPath(roundedRect: r, xRadius: barW / 2, yRadius: barW / 2).fill()
            }
            if state == .callDetected {
                // small dot top-right = "a call is live, not recording"
                let d: CGFloat = 5
                let dot = NSRect(x: rect.width - d, y: rect.height - d, width: d, height: d)
                // knock out a ring so the dot reads against the outer bar
                NSGraphicsContext.current?.compositingOperation = .destinationOut
                NSColor.black.setFill()
                NSBezierPath(ovalIn: dot.insetBy(dx: -1.2, dy: -1.2)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                color.setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
        img.isTemplate = state != .recording
        return img
    }

    /// Debug: write 4x PNG previews (DARTH_TRAY_RENDER_ICONS=<dir>).
    static func renderPreviews(to dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (name, st) in [("idle", State.idle), ("call", .callDetected), ("recording", .recording)] {
            let img = image(st)
            let scale: CGFloat = 4
            let px = NSSize(width: img.size.width * scale, height: img.size.height * scale)
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(px.width), pixelsHigh: Int(px.height), bitsPerSample: 8,
                                       samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSColor(white: 0.93, alpha: 1).setFill()
            NSRect(origin: .zero, size: px).fill()
            img.draw(in: NSRect(origin: .zero, size: px))
            NSGraphicsContext.restoreGraphicsState()
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("icon-\(name).png"))
            }
        }
    }
}
