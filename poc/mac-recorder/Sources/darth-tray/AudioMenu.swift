import AppKit
import RecorderCore

/// The "which audio tracks" menu (0.3.17). One builder, two places — the preview gear (an
/// "Audio" submenu under Microphone) and the tray's own "Audio" submenu — live whether or not
/// a recording is running, exactly like the video source's "Audio only" entry:
///
///   recording  → a tick per track; un-ticking MUTES that track from now on (silence is
///                written in its place, so the timeline and the live mix stay intact, and
///                ticking it again brings the sound back — no part roll, nothing lost);
///   idle       → the ticks are what the NEXT recording starts with (the Record… dialog's
///                two check boxes follow them); they go back to "both on" once that
///                recording has started, so a one-off "no mic" can never silently outlive it.
///
/// Alok, 2026-09-25: "my tray icon doesn't have an option to turn the system audio channel to
/// none, or the mic to none — just like video screen off".
final class AudioMenu: NSObject {
    struct Info {
        /// The track is being captured right now (recording) / will be (idle).
        let systemOn: Bool
        let micOn: Bool
        /// Recording: the track exists in this recording's file at all. A recording started
        /// without a track cannot grow one mid-way (the writer's tracks are fixed), so that
        /// entry is shown greyed. Idle: always true.
        let systemInRecording: Bool
        let micInRecording: Bool
        let recording: Bool
    }

    /// (track "system" | "mic", wanted on?)
    var onToggle: ((String, Bool) -> Void)?
    /// "preview" | "tray" — which surface the click came from, for the event log.
    let origin: String

    init(origin: String) { self.origin = origin }

    /// "system + mic" / "mic only (system off)" / "system only (mic off)" / "nothing — both off".
    static func summary(_ info: Info) -> String {
        switch (info.systemOn && info.systemInRecording, info.micOn && info.micInRecording) {
        case (true, true): return "system + mic"
        case (false, true): return "mic only (system audio off)"
        case (true, false): return "system only (mic off)"
        case (false, false): return "nothing — both off"
        }
    }

    static func headline(_ info: Info) -> String {
        info.recording ? "Recording: \(summary(info))" : "Next recording: \(summary(info))"
    }

    /// The tray item's title.
    static func itemTitle(_ info: Info) -> String {
        info.recording ? "Audio: \(summary(info))" : "Audio (next recording): \(summary(info))"
    }

    func build(into m: NSMenu, info: Info) {
        let head = NSMenuItem(title: Self.headline(info), action: nil, keyEquivalent: "")
        head.isEnabled = false
        m.addItem(head)
        m.addItem(.separator())
        let sys = NSMenuItem(title: "System audio (what the others say)", action: #selector(systemTapped), keyEquivalent: "")
        sys.target = self
        sys.state = (info.systemOn && info.systemInRecording) ? .on : .off
        sys.isEnabled = info.systemInRecording
        sys.toolTip = info.recording
            ? (info.systemInRecording ? "Un-tick to stop recording the other side from now on (silence is written instead); tick to resume"
                                      : "This recording was started without system audio — it cannot be added mid-way")
            : "Whether the next recording captures what the others say"
        m.addItem(sys)
        let mic = NSMenuItem(title: "Microphone (your side)", action: #selector(micTapped), keyEquivalent: "")
        mic.target = self
        mic.state = (info.micOn && info.micInRecording) ? .on : .off
        mic.isEnabled = info.micInRecording
        mic.toolTip = info.recording
            ? (info.micInRecording ? "Un-tick to stop recording your microphone from now on (silence is written instead); tick to resume"
                                   : "This recording was started without a microphone — it cannot be added mid-way")
            : "Whether the next recording captures your microphone"
        m.addItem(mic)
        if !info.recording {
            m.addItem(.separator())
            let note = NSMenuItem(title: "Resets to both on once that recording starts", action: nil, keyEquivalent: "")
            note.isEnabled = false
            m.addItem(note)
        }
        lastInfo = info
    }

    private var lastInfo: Info?

    @objc private func systemTapped() {
        let on = !(lastInfo?.systemOn ?? true)
        EventLog.shared.log("audio_menu_click", ["where": origin, "track": "system", "on": on])
        onToggle?("system", on)
    }
    @objc private func micTapped() {
        let on = !(lastInfo?.micOn ?? true)
        EventLog.shared.log("audio_menu_click", ["where": origin, "track": "mic", "on": on])
        onToggle?("mic", on)
    }
}
