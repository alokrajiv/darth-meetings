import AVFoundation
import CoreAudio
import RecorderCore

/// CoreAudio input devices (0.3.16): what microphones exist, which one is the system default,
/// putting a chosen one on an engine's input unit, and a listener for the two things that
/// change under a running recording — the default input and the device list.
///
/// Why: on 2026-09-23 11:04 SGT the AirPods dropped out of a Meet recording twenty seconds in.
/// `AVAudioEngine` follows the system default input only until the device it started on goes
/// away; then it just stops, and 0.3.15 never noticed — 212 mic buffers in a 33-minute call,
/// the health line said "mic ✗" for half an hour and nothing tried the MacBook's own mic.
enum AudioDevices {
    struct Device: Equatable {
        let id: AudioDeviceID
        let uid: String
        let name: String
    }

    private static func address(_ selector: AudioObjectPropertySelector,
                                scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: Unmanaged<CFString>?
        let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
        guard st == noErr, let v = value?.takeRetainedValue() else { return nil }
        return v as String
    }

    static func name(of id: AudioDeviceID) -> String? { string(id, kAudioObjectPropertyName) }
    static func uid(of id: AudioDeviceID) -> String? { string(id, kAudioDevicePropertyDeviceUID) }

    /// Input channel count — 0 for output-only devices.
    static func inputChannels(_ id: AudioDeviceID) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, list) == noErr else { return 0 }
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func allIDs() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    /// Every device with at least one input channel, in CoreAudio's order.
    static func inputs() -> [Device] {
        allIDs().compactMap { id in
            guard inputChannels(id) > 0, let uid = uid(of: id) else { return nil }
            return Device(id: id, uid: uid, name: name(of: id) ?? uid)
        }
    }

    static var defaultInputID: AudioDeviceID? {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr,
              id != kAudioObjectUnknown else { return nil }
        return id
    }

    static func id(forUID uid: String) -> AudioDeviceID? {
        inputs().first { $0.uid == uid }?.id
    }

    /// Test hook only (the mic self-test flips the system default and puts it back).
    @discardableResult
    static func setDefaultInput(_ id: AudioDeviceID) -> OSStatus {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var v = id
        return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v)
    }

    /// Point an engine's input unit (AUHAL, or the voice-processing unit once that is on) at
    /// one device. Must happen before the engine starts. `scope`/`element` default to the
    /// AUHAL convention (Global, 0); the voice-processing unit is probed with others (see
    /// `MicCapture.pinMode`).
    static func setDevice(_ id: AudioDeviceID, on unit: AudioUnit,
                          scope: AudioUnitScope = kAudioUnitScope_Global, element: AudioUnitElement = 0) throws {
        var v = id
        let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, scope, element,
                                      &v, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard st == noErr else {
            throw NSError(domain: "mic", code: Int(st), userInfo: [NSLocalizedDescriptionKey: "could not select the input device (OSStatus \(st))"])
        }
    }

    static func currentDevice(of unit: AudioUnit) -> AudioDeviceID? {
        var v: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &v, &size)
        guard st == noErr, v != kAudioObjectUnknown else { return nil }
        return v
    }

    /// Fires on the main queue with "default_input" or "devices" whenever either changes.
    ///
    /// The listener is registered on a PRIVATE serial queue and hops to main itself. Registering
    /// it on the main queue looked simpler and deadlocked the mic self-test on 2026-09-23 12:25:
    /// `AudioObjectRemovePropertyListenerBlock` waits for an in-flight delivery on the listener's
    /// queue, and when that queue is main and the caller is on main (a `stop()` the instant a
    /// headset changes), neither side can move — in the tray that is a frozen main queue for
    /// the rest of the day, the 2026-09-17 kind.
    final class Watcher {
        private static let queue = DispatchQueue(label: "io.trames.darth.recorder.audio-devices")
        private let onChange: (String) -> Void
        private var blocks: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

        init(onChange: @escaping (String) -> Void) {
            self.onChange = onChange
            for (selector, label) in [(kAudioHardwarePropertyDefaultInputDevice, "default_input"), (kAudioHardwarePropertyDevices, "devices")] {
                var addr = AudioDevices.address(selector)
                let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                    DispatchQueue.main.async { self?.onChange(label) }
                }
                let st = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, Watcher.queue, block)
                if st == noErr { blocks.append((addr, block)) } else { rlog("mic: could not watch \(label) (OSStatus \(st))") }
            }
        }

        deinit {
            for (addr, block) in blocks {
                var a = addr
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &a, Watcher.queue, block)
            }
        }
    }
}
