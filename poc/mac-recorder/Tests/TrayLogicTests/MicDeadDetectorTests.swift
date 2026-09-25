import XCTest
@testable import TrayLogic

final class MicDeadDetectorTests: XCTestCase {
    /// A healthy mic: room floor peaks ~−55 dBFS, RMS −70 (not audible, but clearly alive).
    static let floorPeak: Float = -55, floorRms: Float = -70

    struct Run {
        var d = MicDeadDetector()
        /// The first tick is t = 0.
        var t = -1.0
        var fired: [(Double, MicDeadDetector.Detection)] = []
        var restarts = 0

        /// Advance `seconds` one tick at a time with the given mic/system levels.
        mutating func run(_ seconds: Int, peak: Float, rms: Float, system: Bool, muted: Bool = false,
                          active: Bool = true, buffers: Int = 23, systemLive: Bool = true) {
            for _ in 0..<seconds {
                t += 1
                let k = MicDeadDetector.Tick(t: t, active: active, muted: muted, micRestarts: restarts, micBuffers: buffers,
                                             micPeakDb: peak, micRmsDb: rms, systemLive: systemLive, systemAudible: system)
                if let x = d.tick(k) { fired.append((t, x)) }
            }
        }
    }

    func testHealthyMicNeverFires() {
        var r = Run()
        r.run(600, peak: Self.floorPeak, rms: Self.floorRms, system: true)
        XCTAssertTrue(r.fired.isEmpty)
        XCTAssertNil(r.d.condition)
    }

    /// The 2026-09-25 incident: exact zeros from a loopback driver, other side audible.
    func testDigitalSilenceFiresAfter15s() {
        var r = Run()
        r.run(30, peak: Self.floorPeak, rms: Self.floorRms, system: true)
        r.run(20, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 1)
        XCTAssertEqual(r.fired[0].0, 44)                       // last live second 29, + 15
        XCTAssertEqual(r.fired[0].1.reason, .digitalSilence)
        XCTAssertEqual(r.fired[0].1.silentSeconds, 15)
        XCTAssertFalse(r.fired[0].1.followUp)
    }

    func testBelowMinus100CountsAsZero() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: Self.floorRms, system: false)
        r.run(16, peak: -105, rms: -110, system: false)
        XCTAssertEqual(r.fired.map { $0.1.reason }, [.digitalSilence])
    }

    func testJustAboveFloorIsAlive() {
        var r = Run()
        r.run(120, peak: -99, rms: -110, system: false)
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testNeverWhileMuted() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: Self.floorRms, system: true)
        r.run(300, peak: -120, rms: -120, system: true, muted: true)
        XCTAssertTrue(r.fired.isEmpty)
        // Unmute onto a dead device: the grace (5 s) + 15 s window, counted from the unmute.
        r.run(25, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.map { $0.0 }, [310 + 20])
    }

    func testNeverWithoutMicTrack() {
        var r = Run()
        r.run(300, peak: -120, rms: -120, system: true, active: false)
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testDeadFromTheStartWaitsForGrace() {
        var r = Run()
        // The first tick (t = 0) opens the grace; judged from 5; fires at 20.
        r.run(20, peak: -120, rms: -120, system: true)
        XCTAssertTrue(r.fired.isEmpty)
        r.run(1, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.map { $0.0 }, [20])
    }

    func testRestartRestartsTheGrace() {
        var r = Run()
        r.run(10, peak: -120, rms: -120, system: true)     // t=0…9: 5 s into the window
        r.restarts = 1
        r.run(19, peak: -120, rms: -120, system: true)     // new engine at t=10 → judged from 15, fires at 30
        XCTAssertTrue(r.fired.isEmpty)
        r.run(3, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.first?.0, 30)
    }

    func testNoBuffersIsNotThisDetectorsJob() {
        // A stalled engine is the MicCapture watchdog's; this detector needs buffers arriving.
        var r = Run()
        r.run(120, peak: -120, rms: -120, system: true, buffers: 0)
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testCooldownTwoMinutes() {
        var r = Run()
        r.run(300, peak: -120, rms: -120, system: true)
        // Fires at 20, then at most every 120 s: 140, 260.
        XCTAssertEqual(r.fired.map { $0.0 }, [20, 140, 260])
    }

    func testQuietWhileSystemAudibleFiresAfter60s() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: -40, system: true)    // talking
        // Low noise: not digital silence (peak −80 > −100), never audible, never peaks > −60.
        r.run(70, peak: -80, rms: -90, system: true)
        XCTAssertEqual(r.fired.count, 1)
        XCTAssertEqual(r.fired[0].0, 69)
        XCTAssertEqual(r.fired[0].1.reason, .silentWhileSystemAudible)
        XCTAssertEqual(r.fired[0].1.silentSeconds, 60)
        XCTAssertGreaterThanOrEqual(r.fired[0].1.systemAudibleSeconds, 40)
    }

    func testQuietNeedsTheSystemMostOfTheMinute() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: -40, system: true)
        // System audible only 1 s in 3 → a third of the minute: nothing.
        for _ in 0..<60 {
            r.run(1, peak: -80, rms: -90, system: true)
            r.run(2, peak: -80, rms: -90, system: false)
        }
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testQuietListenerWithARoomDoesNotFire() {
        // Someone listening to a long monologue: never audible, but the room peaks above −60.
        var r = Run()
        r.run(600, peak: Self.floorPeak, rms: Self.floorRms, system: true)
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testQuietNeedsASystemTrack() {
        var r = Run()
        r.run(600, peak: -80, rms: -90, system: true, systemLive: false)
        XCTAssertTrue(r.fired.isEmpty)
    }

    func testFollowUpAfterRedetectStillDead() {
        var r = Run()
        r.run(21, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 1)
        r.d.armFollowUp(at: r.t)                               // due at 50
        r.run(2, peak: -120, rms: -120, system: true)
        r.restarts = 1                                         // the re-detect's new engine
        r.run(40, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 2)
        XCTAssertEqual(r.fired[1].0, 50)
        XCTAssertTrue(r.fired[1].1.followUp)
        XCTAssertEqual(r.fired[1].1.reason, .digitalSilence)
        // After the follow-up it holds its tongue while the mic stays dead (backoff 10 min)…
        r.run(500, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 2)
        r.run(100, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 3)
        XCTAssertEqual(r.fired[2].0, 650)
    }

    func testFollowUpRecovered() {
        var r = Run()
        r.run(21, peak: -120, rms: -120, system: true)
        r.d.armFollowUp(at: r.t)
        r.restarts = 1
        r.run(60, peak: Self.floorPeak, rms: Self.floorRms, system: true)
        XCTAssertEqual(r.fired.count, 1)
        XCTAssertFalse(r.d.followUpPending)
        XCTAssertNil(r.d.condition)
    }

    func testFollowUpQuietReasonUsesTheShortWindow() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: -40, system: true)
        r.run(60, peak: -80, rms: -90, system: true)
        XCTAssertEqual(r.fired.count, 1)
        r.d.armFollowUp(at: r.t)                               // due at 99
        r.restarts = 1
        r.run(30, peak: -80, rms: -90, system: true)           // the call goes on, still nothing
        XCTAssertEqual(r.fired.count, 2)
        XCTAssertTrue(r.fired[1].1.followUp)
        XCTAssertEqual(r.fired[1].1.reason, .silentWhileSystemAudible)
    }

    /// E2E 2026-09-25 17:18 SGT: the follow-up fired "while the call was audible" on a
    /// quiet mic with a SILENT system track. A silent room during a silent call is not evidence.
    func testFollowUpQuietNeedsTheCallToGoOn() {
        var r = Run()
        r.run(10, peak: Self.floorPeak, rms: -40, system: true)
        r.run(60, peak: -80, rms: -90, system: true)
        XCTAssertEqual(r.fired.count, 1)
        r.d.armFollowUp(at: r.t)
        r.restarts = 1
        r.run(30, peak: -80, rms: -90, system: false)          // the call went quiet too
        XCTAssertEqual(r.fired.count, 1)
        XCTAssertFalse(r.d.followUpPending)
    }

    func testRecoveryClearsTheBackoff() {
        var r = Run()
        r.run(21, peak: -120, rms: -120, system: true)
        r.d.armFollowUp(at: r.t)
        r.run(30, peak: -120, rms: -120, system: true)
        XCTAssertEqual(r.fired.count, 2)                       // detection + follow-up
        r.run(5, peak: Self.floorPeak, rms: Self.floorRms, system: true)   // alive again
        r.run(130, peak: -120, rms: -120, system: true)        // dead again: cooldown only
        XCTAssertEqual(r.fired.count, 3)
        XCTAssertEqual(r.fired[2].0, 170)                      // 50 + 120 (≥ 55 + 15 too)
    }

    func testMuteCancelsAPendingFollowUp() {
        var r = Run()
        r.run(21, peak: -120, rms: -120, system: true)
        r.d.armFollowUp(at: r.t)
        r.run(5, peak: -120, rms: -120, system: true, muted: true)
        XCTAssertFalse(r.d.followUpPending)
    }
}
