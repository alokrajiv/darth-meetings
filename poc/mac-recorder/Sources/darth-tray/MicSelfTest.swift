import AVFoundation
import Foundation
import RecorderCore

/// `DARTH_TRAY_MIC_SELFTEST=1 darth-tray` — exercises the 0.3.16 mic layer without recording
/// anything: start on the default input, flip the SYSTEM default to another input device and
/// back (the auto path), pin a device and release it (the manual path), and stop the engine
/// behind the capture's back (the watchdog path — the 2026-09-23 11:04 failure). Each step
/// waits, then checks the capture is on the device it should be on AND that buffers kept
/// coming. Prints a PASS/FAIL table and exits 0/1. Needs microphone permission (run the
/// signed .app binary, not the bare .build/ one). The system default input is restored.
enum MicSelfTest {
    static func run() -> Never {
        RLog.openFile("~/Library/Logs/DarthRecorder/mic-selftest.log")
        var results: [(String, Bool, String)] = []
        func check(_ name: String, _ ok: Bool, _ detail: String) {
            results.append((name, ok, detail))
            print("\(ok ? "PASS" : "FAIL")  \(name) — \(detail)")
        }
        func wait(_ s: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

        let inputs = AudioDevices.inputs()
        let defaultID = AudioDevices.defaultInputID
        let defaultName = defaultID.flatMap { AudioDevices.name(of: $0) } ?? "?"
        print("inputs: " + inputs.map { "\($0.name) [\($0.uid)]\($0.id == defaultID ? " (default)" : "")" }.joined(separator: ", "))
        guard let defaultID else { print("no default input device"); exit(1) }

        // `DARTH_TRAY_MIC_SELFTEST=raw` runs the AUHAL path (voice processing off).
        let raw = ProcessInfo.processInfo.environment["DARTH_TRAY_MIC_SELFTEST"] == "raw"
        print("mode: voice processing \(raw ? "OFF (raw)" : "ON")")
        let mic = MicCapture(voiceProcessing: !raw, deviceUID: nil)
        var delivered = 0
        mic.onBuffer = { _ in delivered += 1 }
        var restarts: [(String?, String?, String)] = []
        mic.onRestarted = { from, to, reason in restarts.append((from, to, reason)) }
        do { try mic.start() } catch { print("start failed: \(error)"); exit(1) }
        wait(3)
        // The hardware channel count is the one thing that says which device the buffers
        // REALLY come from (the MacBook mic shows 9 ch under voice processing, BlackHole 2).
        let homeCh = mic.hardwareFormat?.channelCount ?? 0
        func ch() -> AVAudioChannelCount { mic.hardwareFormat?.channelCount ?? 0 }
        func lvl() -> String { String(format: "lvl %.0f dB", mic.meter.levelDb) }
        // Under voice processing the node's format is NOT the device's (9 or 10 ch for the
        // MacBook mic, 2 or 10 for BlackHole, run to run) — the format proves the device only
        // when the capture is on the raw path.
        func onRaw() -> Bool { mic.voiceProcessing == .off }
        check("start on default", delivered > 10 && mic.deviceID == defaultID,
              "\(delivered) buffers, on \(mic.deviceLabel ?? "?"), format \(mic.formatLabel ?? "?") (hw \(mic.hardwareFormatLabel ?? "?")), vp=\(mic.voiceProcessing.rawValue)")
        check("canonical format", mic.format?.sampleRate == MicCapture.canonicalRate && mic.format?.channelCount == 1, mic.formatLabel ?? "nil")

        // Another input device to move to — prefer a virtual one (silent, harmless to other apps).
        let other = inputs.first { $0.id != defaultID && $0.name.contains("BlackHole") } ?? inputs.first { $0.id != defaultID }
        if let other {
            // The pinned steps always run raw, and on the raw path the unit's own device report
            // is the truth — that is the proof a pin took (the format is not: BlackHole reads
            // 2 or 4 ch depending on what else is open).
            // Auto path: the system default changes under us.
            var before = delivered
            let st = AudioDevices.setDefaultInput(other.id)
            wait(6)
            check("auto: follow default → \(other.name)", st == noErr && mic.deviceID == other.id && delivered > before && (!onRaw() || ch() != homeCh),
                  "set status \(st), on \(mic.deviceLabel ?? "?"), hw \(mic.hardwareFormatLabel ?? "?"), \(lvl()), +\(delivered - before) buffers, restarts \(mic.restarts) (\(mic.lastRestartReason ?? "-"))")
            before = delivered
            AudioDevices.setDefaultInput(defaultID)
            wait(6)
            check("auto: follow default back → \(defaultName)", mic.deviceID == defaultID && delivered > before && (!onRaw() || ch() == homeCh),
                  "on \(mic.deviceLabel ?? "?"), hw \(mic.hardwareFormatLabel ?? "?"), \(lvl()), +\(delivered - before) buffers, restarts \(mic.restarts)")

            // Manual path: pin the other device, then release.
            before = delivered
            let out = mic.switchDevice(uid: other.uid)
            wait(4)
            check("manual: pin \(other.name)", mic.deviceID == other.id && mic.deviceUID == other.uid && delivered > before && onRaw() && mic.unitDeviceID == other.id && (raw || mic.pinnedRaw),
                  "→ \(out), on \(mic.deviceLabel ?? "?"), unit reports \(mic.unitDeviceID.flatMap { AudioDevices.name(of: $0) } ?? "?"), hw \(mic.hardwareFormatLabel ?? "?"), vp=\(mic.voiceProcessing.rawValue), \(lvl()), +\(delivered - before) buffers, restarts \(mic.restarts)")
            // A default change while pinned must NOT move us (the engine may still restart —
            // AVAudioEngine stops on any default change — but it comes back on the pin).
            before = delivered
            let restartsBefore = mic.restarts
            AudioDevices.setDefaultInput(other.id); wait(1); AudioDevices.setDefaultInput(defaultID); wait(6)
            check("manual: default flips ignored while pinned", mic.deviceID == other.id && delivered > before && onRaw() && mic.unitDeviceID == other.id,
                  "on \(mic.deviceLabel ?? "?"), unit reports \(mic.unitDeviceID.flatMap { AudioDevices.name(of: $0) } ?? "?"), hw \(mic.hardwareFormatLabel ?? "?"), \(lvl()), restarts \(restartsBefore) → \(mic.restarts), +\(delivered - before) buffers")
            before = delivered
            let back = mic.switchDevice(uid: nil)
            wait(6)
            check("manual: release → default", mic.deviceID == defaultID && mic.deviceUID == nil && delivered > before && (!onRaw() || ch() == homeCh) && (raw || mic.voiceProcessing == .on),
                  "→ \(back), on \(mic.deviceLabel ?? "?"), hw \(mic.hardwareFormatLabel ?? "?"), vp=\(mic.voiceProcessing.rawValue), \(lvl()), +\(delivered - before) buffers, restarts \(mic.restarts)")
        } else {
            print("only one input device — auto/manual switch steps skipped")
        }

        // Watchdog: the engine dies without a word (what the AirPods did on 2026-09-23).
        let before = delivered
        let restartsBefore = mic.restarts
        mic._testStopEngine()
        wait(0.3)
        let stalled = delivered == before
        wait(10)
        let byWatchdog = (mic.lastRestartReason ?? "").hasPrefix("engine not running") || (mic.lastRestartReason ?? "").hasPrefix("no mic buffers")
        check("watchdog: engine stopped → restarted", stalled && byWatchdog && mic.restarts > restartsBefore && delivered > before + 10 && mic.deviceID == defaultID,
              "stalled=\(stalled), restarts \(restartsBefore) → \(mic.restarts) (\(mic.lastRestartReason ?? "-")), +\(delivered - before) buffers, \(lvl()), on \(mic.deviceLabel ?? "?")")

        mic.stop()
        AudioDevices.setDefaultInput(defaultID)
        print("restarts seen: " + restarts.map { "\($0.0 ?? "?") → \($0.1 ?? "?") (\($0.2))" }.joined(separator: "; "))
        let failed = results.filter { !$0.1 }.count
        print(failed == 0 ? "ALL \(results.count) PASSED" : "\(failed) of \(results.count) FAILED")
        exit(failed == 0 ? 0 : 1)
    }
}
