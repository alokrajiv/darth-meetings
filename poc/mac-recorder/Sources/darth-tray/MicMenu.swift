import AppKit
import RecorderCore

/// The "which microphone" menu (0.3.16). One builder, two places — the preview gear (as a
/// "Microphone" submenu under the video sources) and the tray's own "Microphone" submenu —
/// and, unlike the video source menu, it is live whether or not a recording is running: idle,
/// a pick is the microphone the NEXT recording starts on; recording, the mic engine restarts
/// on the pick at once (the writer's track is unaffected — `MicCapture.canonicalRate`).
///
/// Entries: a head line saying what is captured right now, "Automatic — follow the system
/// default" (ticked in auto mode, with the current default named), every input device
/// CoreAudio lists (ticked when pinned), and "Re-detect the microphone now" (recording only) —
/// the button Alok asked for on 2026-09-23 when the gear offered no way to recover a mic that
/// had gone quiet.
final class MicMenu: NSObject {
    struct Info {
        let devices: [AudioDevices.Device]
        /// The preference: nil = automatic.
        let selectedUID: String?
        /// What the running recording's mic is really on (nil when idle).
        let current: String?
        let recording: Bool
    }

    /// (uid or nil for automatic, display name)
    var onPickDevice: ((String?, String) -> Void)?
    var onRedetect: (() -> Void)?
    /// "preview" | "tray" — which surface the click came from, for the event log.
    let origin: String

    init(origin: String) { self.origin = origin }

    private var pickable: [AudioDevices.Device] = []

    static func headline(_ info: Info) -> String {
        if let cur = info.current { return "Microphone: \(cur)" }
        if let uid = info.selectedUID {
            let name = info.devices.first { $0.uid == uid }?.name
            return name.map { "Next recording: \($0) — echo cancellation off while a microphone is chosen" }
                ?? "Next recording: chosen microphone (not connected — the default will stand in)"
        }
        let def = AudioDevices.defaultInputID.flatMap { AudioDevices.name(of: $0) }
        return "Next recording: system default\(def.map { " (\($0))" } ?? "")"
    }

    /// The tray item's title: "Microphone: Automatic" / "Microphone: <name>".
    static func itemTitle(_ info: Info) -> String {
        if let cur = info.current { return "Microphone: \(cur)" }
        if let uid = info.selectedUID { return "Microphone: \(info.devices.first { $0.uid == uid }?.name ?? "chosen device (not connected)")" }
        return "Microphone: Automatic"
    }

    func build(into m: NSMenu, info: Info) {
        let head = NSMenuItem(title: Self.headline(info), action: nil, keyEquivalent: "")
        head.isEnabled = false
        m.addItem(head)
        let def = AudioDevices.defaultInputID.flatMap { AudioDevices.name(of: $0) }
        let auto = NSMenuItem(title: "Automatic — follow the system default\(def.map { " (\($0))" } ?? "")",
                              action: #selector(autoTapped), keyEquivalent: "")
        auto.target = self
        auto.state = info.selectedUID == nil ? .on : .off
        m.addItem(auto)
        if info.recording {
            let re = NSMenuItem(title: "Re-detect the microphone now", action: #selector(redetectTapped), keyEquivalent: "")
            re.target = self
            re.toolTip = "Restart the microphone capture on whatever device is wanted right now — use this when the mic went quiet after a headset change"
            m.addItem(re)
        }
        m.addItem(.separator())
        let pick = NSMenuItem(title: "Always use:", action: nil, keyEquivalent: "")
        pick.isEnabled = false
        m.addItem(pick)
        pickable = info.devices
        if pickable.isEmpty {
            let none = NSMenuItem(title: "No input devices found", action: nil, keyEquivalent: "")
            none.isEnabled = false
            m.addItem(none)
        }
        for (i, d) in pickable.enumerated() {
            let item = NSMenuItem(title: d.name, action: #selector(pickTapped(_:)), keyEquivalent: "")
            item.target = self
            item.tag = i
            item.state = d.uid == info.selectedUID ? .on : .off
            m.addItem(item)
        }
    }

    @objc private func autoTapped() {
        EventLog.shared.log("mic_menu_click", ["where": origin, "button": "auto"])
        onPickDevice?(nil, "Automatic")
    }
    @objc private func redetectTapped() {
        EventLog.shared.log("mic_menu_click", ["where": origin, "button": "redetect"])
        onRedetect?()
    }
    @objc private func pickTapped(_ sender: NSMenuItem) {
        guard sender.tag >= 0, sender.tag < pickable.count else { return }
        let d = pickable[sender.tag]
        EventLog.shared.log("mic_menu_click", ["where": origin, "button": "pick", "uid": d.uid, "name": d.name])
        onPickDevice?(d.uid, d.name)
    }
}
