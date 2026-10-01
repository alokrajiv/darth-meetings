import CoreAudio
import Foundation
import RecorderCore
import TrayLogic

/// 0.3.20 — CoreAudio's own "the IO thread ran out of time" signal for the recording's
/// microphone: an in-process `kAudioDeviceProcessorOverload` listener (counts only — partial-OK).
///
/// An overload is a cycle the HAL could not service in time: the mic track gets a glitch or a
/// gap there. The count goes into each `segment_closed` (`coreaudio_overloads`), and an
/// `audio_overload` event is logged at most once per 30 s (with how many were swallowed since
/// the previous one). The listener sits on the mic device AND on the input unit's current
/// device when that differs (under voice processing our IO runs on Apple's aggregate, not on
/// the capsule). Re-attached when the capture restarts on another device. Never the unified
/// log.
///
/// Listener blocks run on a PRIVATE serial queue — removing a listener whose queue is the
/// caller's own can deadlock (AudioDevices.Watcher, 2026-09-23).
final class AudioOverloadWatcher {
    private static let queue = DispatchQueue(label: "io.trames.darth.recorder.audio-overload")
    private let lock = NSLock()
    private var total = 0
    private var limiter = RateLimiter(interval: 30)
    private var recordingId = ""
    private var label = ""
    // main queue only
    private var attached: [(AudioObjectID, AudioObjectPropertyListenerBlock)] = []

    /// Overloads counted since `reset` (the recording's total).
    var count: Int { lock.lock(); defer { lock.unlock() }; return total }

    /// A new recording: zero the count.
    func reset(recordingId: String) {
        lock.lock()
        total = 0
        limiter = RateLimiter(interval: 30)
        self.recordingId = recordingId
        lock.unlock()
    }

    /// (Re-)attach to these devices (duplicates and nils dropped). Main queue.
    func watch(devices: [AudioDeviceID?], label: String) {
        detach()
        lock.lock(); self.label = label; lock.unlock()
        var seen = Set<AudioDeviceID>()
        for case let id? in devices where id != kAudioObjectUnknown && seen.insert(id).inserted {
            var addr = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload,
                                                  mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.fired() }
            let st = AudioObjectAddPropertyListenerBlock(id, &addr, Self.queue, block)
            if st == noErr { attached.append((id, block)) } else { rlog("audio overload: could not watch device \(id) (OSStatus \(st))") }
        }
    }

    /// Main queue.
    func detach() {
        for (id, block) in attached {
            var addr = AudioObjectPropertyAddress(mSelector: kAudioDeviceProcessorOverload,
                                                  mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
            AudioObjectRemovePropertyListenerBlock(id, &addr, Self.queue, block)
        }
        attached = []
    }

    deinit { detach() }

    private func fired() {
        lock.lock()
        total += 1
        let n = total
        let (emit, suppressed) = limiter.allow(now: ProcessInfo.processInfo.systemUptime)
        let id = recordingId, device = label
        lock.unlock()
        guard emit else { return }
        EventLog.shared.log("audio_overload", ["recording_id": id, "device": device, "total": n, "suppressed_since_last": suppressed],
                            summary: "audio: CoreAudio IO overload on \(device) (\(n) this recording)")
    }
}
