import AppKit
import CoreGraphics
import RecorderCore

/// "Record…" (0.2.4): the manual-recording panel Alok asked for — pick a screen or a window,
/// tick system audio / microphone, and choose whether the file goes to Darth Meetings when it
/// stops. Everything the quick "Record this call" path decides on its own is a choice here.
///
/// A NON-modal floating `NSPanel` (the tray is an accessory app, so we activate first to bring
/// it to the front). It must not be an `NSAlert.runModal`: the tray's timers (call detection,
/// re-resolve, grace) and the ws command handler all live on the main queue, and a nested modal
/// run loop entered from a main-queue block never drains that queue again — 0.2.4's first cut
/// wedged the whole tray that way. The source list is built at open time: every display (name +
/// pixel size, default = the display under the mouse), then windows — those of any detected
/// call's app first, then other on-screen layer-0 windows with a title, grouped by app.
final class RecordDialog: NSObject, NSWindowDelegate {
    static let shared = RecordDialog()

    private var panel: NSPanel?
    private var completion: ((RecordingController.RecordOptions?) -> Void)?
    private var popup: NSPopUpButton?
    private var entries: [SourceEntry?] = []
    private var displays: [SourceEntry] = []
    private var sysBox: NSButton?
    private var micBox: NSButton?
    private var upBox: NSButton?

    var isOpen: Bool { panel != nil }

    struct SourceEntry {
        let source: RecordingController.Source
        let title: String
        let owner: String
    }

    /// Build the source list. `callPids` first (they are what the user most likely wants).
    static func sources(callPids: [pid_t]) -> (displays: [SourceEntry], windows: [SourceEntry]) {
        var displays: [SourceEntry] = []
        for (i, screen) in NSScreen.screens.enumerated() {
            guard let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            let id = num.uint32Value
            let px = (Int(screen.frame.width * screen.backingScaleFactor), Int(screen.frame.height * screen.backingScaleFactor))
            let name = screen.localizedName
            displays.append(SourceEntry(source: .display(id), title: "Display \(i + 1): \(name) (\(px.0)×\(px.1))", owner: "display"))
        }

        var windows: [SourceEntry] = []
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return (displays, windows)
        }
        let me = getpid()
        struct W { let id: CGWindowID; let pid: pid_t; let owner: String; let title: String }
        var all: [W] = []
        for w in list {
            let pid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? -1)
            guard pid != me, ((w[kCGWindowLayer as String] as? Int) ?? 0) == 0,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let frame = CGRect(dictionaryRepresentation: b as CFDictionary),
                  frame.width > 320, frame.height > 240,
                  let id = w[kCGWindowNumber as String] as? Int,
                  let title = w[kCGWindowName as String] as? String, !title.isEmpty else { continue }
            all.append(W(id: CGWindowID(id), pid: pid, owner: (w[kCGWindowOwnerName as String] as? String) ?? "?", title: title))
        }
        // Call apps first (front-to-back order kept), then the rest grouped by app in first-seen order.
        let callFirst = all.filter { callPids.contains($0.pid) }
        var rest = all.filter { !callPids.contains($0.pid) }
        var order: [String] = []
        for w in rest where !order.contains(w.owner) { order.append(w.owner) }
        rest.sort { (order.firstIndex(of: $0.owner) ?? 0) < (order.firstIndex(of: $1.owner) ?? 0) }
        for w in (callFirst + rest).prefix(25) {
            let t = w.title.count > 70 ? String(w.title.prefix(70)) + "…" : w.title
            windows.append(SourceEntry(source: .window(w.id, w.title), title: "\(w.owner) — \(t)", owner: w.owner))
        }
        return (displays, windows)
    }

    /// Open the panel (or bring the open one to the front). `completion` runs once, on the
    /// main queue: the options on Start, nil on Cancel / close.
    func present(callPids: [pid_t], signedIn: Bool, autoUpload: Bool,
                 completion: @escaping (RecordingController.RecordOptions?) -> Void) {
        if let panel {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            return
        }
        self.completion = completion
        let (displays, windows) = Self.sources(callPids: callPids)
        self.displays = displays
        rlog("record dialog: \(displays.count) display(s), \(windows.count) window(s) — "
             + (displays + windows).prefix(12).map { $0.title }.joined(separator: " | "))
        EventLog.shared.log("record_dialog_opened", [
            "displays": displays.map { $0.title }, "windows": windows.map { $0.title }, "signed_in": signedIn,
        ])

        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 440, height: 26), pullsDown: false)
        var entries: [SourceEntry?] = []      // parallel to the menu items (nil = header/separator)
        func add(_ e: SourceEntry) { popup.addItem(withTitle: e.title); entries.append(e) }
        func header(_ t: String) {
            popup.menu?.addItem(.separator()); entries.append(nil)
            let h = NSMenuItem(title: t, action: nil, keyEquivalent: ""); h.isEnabled = false
            popup.menu?.addItem(h); entries.append(nil)
        }
        for d in displays { add(d) }
        var lastOwner = ""
        for w in windows {
            if w.owner != lastOwner { header(w.owner); lastOwner = w.owner }
            add(w)
        }
        // Default: the display the mouse is on.
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }),
           let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
           let idx = entries.firstIndex(where: { e in
               if case .display(let id)? = e?.source { return id == num.uint32Value }
               return false
           }) {
            popup.selectItem(at: idx)
        }
        self.popup = popup
        self.entries = entries

        let sysBox = NSButton(checkboxWithTitle: "System audio (what the others say)", target: nil, action: nil)
        sysBox.state = .on
        let micBox = NSButton(checkboxWithTitle: "Microphone (your side)", target: nil, action: nil)
        micBox.state = .on
        let upBox = NSButton(checkboxWithTitle: "Upload to Darth Meetings when it stops", target: nil, action: nil)
        upBox.state = (signedIn && autoUpload) ? .on : .off
        upBox.isEnabled = signedIn
        self.sysBox = sysBox; self.micBox = micBox; self.upBox = upBox
        let hint = NSTextField(wrappingLabelWithString: signedIn
            ? "Off = the file stays in Movies › Darth Recorder; upload it later from the menu or the Meetings page."
            : "Sign in to Darth Meetings (menu bar) to upload. Until then recordings stay on this Mac.")
        hint.font = .systemFont(ofSize: 11)
        hint.textColor = .secondaryLabelColor

        let title = NSTextField(labelWithString: "Record a screen or window")
        title.font = .boldSystemFont(ofSize: 15)
        let sub = NSTextField(wrappingLabelWithString: "Everything you tick is saved in one file, as separate audio tracks.")
        sub.font = .systemFont(ofSize: 12)
        sub.textColor = .secondaryLabelColor
        let srcLabel = NSTextField(labelWithString: "Record:")

        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelTapped))
        cancel.keyEquivalent = "\u{1b}"
        let startBtn = NSButton(title: "Start recording", target: self, action: #selector(startTapped))
        startBtn.keyEquivalent = "\r"
        let buttons = NSStackView(views: [cancel, startBtn])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [title, sub, srcLabel, popup, sysBox, micBox, upBox, hint, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.setCustomSpacing(14, after: sub)
        stack.setCustomSpacing(14, after: popup)
        stack.setCustomSpacing(14, after: hint)
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        popup.widthAnchor.constraint(equalToConstant: 440).isActive = true
        hint.widthAnchor.constraint(equalToConstant: 440).isActive = true
        sub.widthAnchor.constraint(equalToConstant: 440).isActive = true
        buttons.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -20).isActive = true

        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                            styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
        panel.title = "Darth Recorder"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = stack
        panel.setContentSize(stack.fittingSize)
        panel.center()
        panel.initialFirstResponder = popup
        self.panel = panel
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    /// Close without recording (the Cancel button, the close box, Esc, the test hook).
    func cancel() {
        guard panel != nil else { return }
        EventLog.shared.log("record_dialog_cancelled", [:])
        finish(nil)
    }

    @objc private func cancelTapped() { cancel() }

    @objc private func startTapped() {
        var o = RecordingController.RecordOptions()
        let idx = popup?.indexOfSelectedItem ?? -1
        o.source = (idx >= 0 && idx < entries.count ? entries[idx]?.source : nil) ?? displays.first?.source
        o.systemAudio = sysBox?.state == .on
        o.mic = micBox?.state == .on
        o.upload = (upBox?.isEnabled ?? false) && upBox?.state == .on
        EventLog.shared.log("record_dialog_start", o.json)
        finish(o)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        cancel()
        return false
    }

    private func finish(_ options: RecordingController.RecordOptions?) {
        let done = completion
        completion = nil
        panel?.delegate = nil
        panel?.orderOut(nil)
        panel = nil
        popup = nil; sysBox = nil; micBox = nil; upBox = nil
        entries = []; displays = []
        done?(options)
    }
}
