import AppKit
import CoreGraphics
import RecorderCore

/// The "what is being recorded, and what else could be" menu (0.3.15). One builder, two places:
/// the preview panel's gear and the tray's "Video source" submenu — so the person can change
/// the source without the preview panel being open.
///
/// Before 0.3.15 this menu was a dead end on an audio-only recording ("Audio-only recording
/// (no video source)" and nothing to click — Alok, on a Slack huddle where a screen was being
/// shared, 2026-09-22 18:33 SGT: "why can't I update source? what's the point else"). Now the
/// same list is offered either way: on an audio-only recording it is headed "Add video", and
/// picking an entry rolls a new part WITH video (the audio tracks carry straight on). "Audio
/// only" at the bottom goes the other way.
///
/// Privacy: every entry here is an explicit pick. Nothing in this file ever chooses a source
/// on its own, and an audio-only recording stays audio-only until somebody clicks.
final class SourceMenu: NSObject {
    /// What the tray knows about the live recording, asked for each time the menu opens.
    struct Info {
        let current: String
        let mode: String
        let callPids: [pid_t]
        let audioOnly: Bool
    }

    var onSetAuto: (() -> Void)?
    var onRedetect: (() -> Void)?
    var onPickSource: ((RecordingController.Source, String) -> Void)?
    var onPickAudioOnly: (() -> Void)?
    /// "preview" | "tray" — which surface the click came from, for the event log.
    let origin: String

    init(origin: String) { self.origin = origin }

    private var pickable: [RecordDialog.SourceEntry] = []

    /// The head line — and the gear's tooltip. Never a dead end: it says what to do next.
    static func headline(_ info: Info) -> String {
        info.audioOnly ? "Audio only — add a video source below" : "Recording: \(info.current)"
    }

    /// Fill `m`: head line, (Auto / Re-detect when there IS a video source), every display and
    /// window the Record… dialog would offer (the call's windows first), then "Audio only".
    func build(into m: NSMenu, info: Info) {
        let head = NSMenuItem(title: Self.headline(info), action: nil, keyEquivalent: "")
        head.isEnabled = false
        m.addItem(head)
        if !info.audioOnly {
            let auto = NSMenuItem(title: "Auto — follow the call window", action: #selector(autoTapped), keyEquivalent: "")
            auto.target = self
            auto.state = info.mode == "auto" ? .on : .off
            m.addItem(auto)
            let re = NSMenuItem(title: "Re-detect the window now", action: #selector(redetectTapped), keyEquivalent: "")
            re.target = self
            m.addItem(re)
        }
        m.addItem(.separator())
        let pick = NSMenuItem(title: info.audioOnly ? "Add video — record this:" : "Record this instead:",
                              action: nil, keyEquivalent: "")
        pick.isEnabled = false
        m.addItem(pick)
        let src = RecordDialog.sources(callPids: info.callPids)
        pickable = []
        for e in src.displays + Array(src.windows.prefix(18)) {
            let item = NSMenuItem(title: e.title, action: #selector(pickTapped(_:)), keyEquivalent: "")
            item.target = self
            item.tag = pickable.count
            item.state = (!info.audioOnly && e.title == info.current) ? .on : .off
            pickable.append(e)
            m.addItem(item)
        }
        m.addItem(.separator())
        let none = NSMenuItem(title: "Audio only", action: #selector(audioOnlyTapped), keyEquivalent: "")
        none.target = self
        none.state = info.audioOnly ? .on : .off
        m.addItem(none)
    }

    @objc private func autoTapped() {
        EventLog.shared.log("source_menu_click", ["where": origin, "button": "auto"])
        onSetAuto?()
    }
    @objc private func redetectTapped() {
        EventLog.shared.log("source_menu_click", ["where": origin, "button": "redetect"])
        onRedetect?()
    }
    @objc private func audioOnlyTapped() {
        EventLog.shared.log("source_menu_click", ["where": origin, "button": "audio_only"])
        onPickAudioOnly?()
    }
    @objc private func pickTapped(_ sender: NSMenuItem) {
        guard sender.tag >= 0, sender.tag < pickable.count else { return }
        let e = pickable[sender.tag]
        EventLog.shared.log("source_menu_click", ["where": origin, "button": "pick", "source": e.source.json, "title": e.title])
        onPickSource?(e.source, e.title)
    }
}
