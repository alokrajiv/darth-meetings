import XCTest
@testable import TrayLogic

final class CaptureEasePolicyTests: XCTestCase {
    typealias I = CaptureEasePolicy.Inputs
    static let calm = I(thermal: "nominal", gpuPct: 40, lowPower: false, memPressure: "normal")
    static func gpu(_ g: Double) -> I { var i = calm; i.gpuPct = g; return i }
    static func thermal(_ t: String) -> I { var i = calm; i.thermal = t; return i }

    struct Run {
        var p: CaptureEasePolicy
        var t = 0.0
        var out: [(Double, CaptureEasePolicy.Decision)] = []
        init(config: CaptureEasePolicy.Config = .init(), mode: CaptureProfileMode = .auto, start: I = CaptureEasePolicyTests.calm) {
            p = CaptureEasePolicy(config: config)
            p.begin(at: 0, mode: mode, inputs: start)
        }
        /// `n` real samples, 10 s apart.
        mutating func samples(_ n: Int, _ i: I) {
            for _ in 0..<n {
                t += 10
                if let d = p.tick(.init(now: t, inputs: i, isSample: true)) { out.append((t, d)) }
            }
        }
        /// A notification tick at the current time.
        mutating func nudge(_ i: I) {
            if let d = p.tick(.init(now: t, inputs: i, isSample: false)) { out.append((t, d)) }
        }
    }

    func testCalmNeverChanges() {
        var r = Run()
        r.samples(200, Self.calm)
        XCTAssertTrue(r.out.isEmpty)
        XCTAssertEqual(r.p.current, .normal)
    }

    func testThermalFairStepsDownAtOnce() {
        var r = Run()
        r.samples(3, Self.calm)
        r.nudge(Self.thermal("fair"))
        XCTAssertEqual(r.out.count, 1)
        XCTAssertEqual(r.out[0].1.from, .normal)
        XCTAssertEqual(r.out[0].1.to, .eased)
        XCTAssertEqual(r.out[0].1.reason, "thermal_fair")
        XCTAssertEqual(r.out[0].1.values.thermal, "fair")
    }

    func testLowPowerAndMemoryPressureStepDown() {
        var a = Run(); a.samples(1, I(thermal: "nominal", gpuPct: 10, lowPower: true, memPressure: "normal"))
        XCTAssertEqual(a.out.map { $0.1.reason }, ["low_power"])
        var b = Run(); b.samples(1, I(thermal: "nominal", gpuPct: 10, lowPower: false, memPressure: "warn"))
        XCTAssertEqual(b.out.map { $0.1.reason }, ["mem_pressure_warn"])
        var c = Run(); c.samples(1, I(thermal: "fair", gpuPct: 10, lowPower: true, memPressure: "critical"))
        XCTAssertEqual(c.out.map { $0.1.reason }, ["thermal_fair+low_power+mem_pressure_critical"])
    }

    /// The fanless Air: GPU pinned. Twelve consecutive samples — counted, not timed.
    func testGpuNeedsTwelveConsecutiveSamples() {
        var r = Run()
        r.samples(11, Self.gpu(100))
        XCTAssertTrue(r.out.isEmpty)
        r.samples(1, Self.gpu(85))              // breaks the run
        r.samples(11, Self.gpu(95))
        XCTAssertTrue(r.out.isEmpty)
        r.samples(1, Self.gpu(90))              // 12th in a row, at the threshold
        XCTAssertEqual(r.out.count, 1)
        XCTAssertEqual(r.out[0].1.reason, "gpu_sustained")
        XCTAssertEqual(r.p.current, .eased)
    }

    func testNotificationTicksDoNotCountGpuSamples() {
        var r = Run()
        r.samples(10, Self.gpu(100))
        for _ in 0..<20 { r.nudge(Self.gpu(100)) }
        XCTAssertEqual(r.p.gpuHighStreak, 10)
        XCTAssertTrue(r.out.isEmpty)
    }

    func testUnknownInputsNeverTrigger() {
        var r = Run()
        r.samples(50, I())
        r.samples(50, I(thermal: "unknown", gpuPct: nil, lowPower: nil, memPressure: "weird"))
        XCTAssertTrue(r.out.isEmpty)
        // A missing GPU reading breaks a run.
        r.samples(11, Self.gpu(99)); r.samples(1, I(thermal: "nominal")); r.samples(11, Self.gpu(99))
        XCTAssertTrue(r.out.isEmpty)
    }

    /// Step up only after 5 clear minutes AND the 60 s dwell.
    func testStepUpAfterFiveClearMinutes() {
        var r = Run()
        r.samples(1, Self.thermal("fair"))       // t=10 eased
        r.samples(29, Self.calm)                 // t=300: last pressure 10, clear 290 s
        XCTAssertEqual(r.p.current, .eased)
        r.samples(1, Self.calm)                  // t=310: clear exactly 300 s
        XCTAssertEqual(r.out.count, 2)
        XCTAssertEqual(r.out[1].0, 310)
        XCTAssertEqual(r.out[1].1.from, .eased)
        XCTAssertEqual(r.out[1].1.to, .normal)
        XCTAssertEqual(r.out[1].1.reason, "clear")
    }

    /// Hysteresis: in after 12 hot samples, out only after 5 minutes without a single one.
    func testSingleHotGpuSampleIsNotClear() {
        var r = Run()
        r.samples(12, Self.gpu(100))             // t=120 eased
        r.samples(20, Self.calm)                 // t=320
        r.samples(1, Self.gpu(97))               // t=330 — not clear
        r.samples(29, Self.calm)                 // t=620, clear 290 s
        XCTAssertEqual(r.p.current, .eased)
        r.samples(1, Self.calm)                  // t=630
        XCTAssertEqual(r.p.current, .normal)
        XCTAssertEqual(r.out.map { $0.1.to }, [.eased, .normal])
    }

    func testDwellHoldsAStepUp() {
        var c = CaptureEasePolicy.Config(); c.clearSeconds = 10; c.minDwellSeconds = 60
        var r = Run(config: c)
        r.samples(1, Self.thermal("fair"))       // t=10 eased
        r.samples(3, Self.calm)                  // t=40: clear 30 s but dwell 30 s
        XCTAssertEqual(r.p.current, .eased)
        r.samples(3, Self.calm)                  // t=70: dwell 60
        XCTAssertEqual(r.out.map { $0.0 }, [10, 70])
    }

    func testPressureWhileEasedEmitsNothing() {
        var r = Run()
        r.samples(1, Self.thermal("fair"))
        r.samples(100, Self.thermal("fair"))
        r.nudge(I(thermal: "fair", gpuPct: 100, lowPower: true, memPressure: "warn"))
        XCTAssertEqual(r.out.count, 1)
    }

    func testSeriousIsOnlyEasedWithoutAudioOnly() {
        var r = Run()
        r.samples(1, Self.thermal("serious"))
        XCTAssertEqual(r.out.map { $0.1.to }, [.eased])
        XCTAssertEqual(r.out[0].1.reason, "thermal_serious")
    }

    func testAudioOnlyHookWhenAllowed() {
        var c = CaptureEasePolicy.Config(); c.allowAudioOnly = true
        var r = Run(config: c)
        r.samples(1, Self.thermal("fair"))
        r.samples(1, Self.thermal("critical"))
        XCTAssertEqual(r.out.map { $0.1.to }, [.eased, .audioOnly])
        // Back to fair: severe has to clear for 5 min before audio-only → eased.
        r.samples(30, Self.thermal("fair"))      // t=320, severe last at 20 → 300 s
        XCTAssertEqual(r.out.map { $0.1.to }, [.eased, .audioOnly, .eased])
        XCTAssertEqual(r.out[2].0, 320)
    }

    func testStartingProfile() {
        let p = CaptureEasePolicy()
        XCTAssertEqual(p.startingProfile(for: Self.calm), .normal)
        XCTAssertEqual(p.startingProfile(for: Self.thermal("fair")), .eased)
        XCTAssertEqual(p.startingProfile(for: I(lowPower: true)), .eased)
        XCTAssertEqual(p.startingProfile(for: Self.gpu(100)), .normal)        // GPU needs a run
        XCTAssertEqual(p.startingProfile(for: Self.thermal("critical")), .eased)
        XCTAssertEqual(p.startingProfile(for: I()), .normal)
    }

    /// A recording that starts under pressure starts eased, and stays until 5 clear minutes.
    func testBeginEasedNeedsClearToStepUp() {
        var r = Run(start: Self.thermal("fair"))
        XCTAssertEqual(r.p.current, .eased)
        r.samples(29, Self.calm)
        XCTAssertTrue(r.out.isEmpty)
        r.samples(1, Self.calm)                  // t=300
        XCTAssertEqual(r.out.map { $0.1.to }, [.normal])
    }

    func testModeNeverIgnoresThePolicy() {
        var r = Run(mode: .never, start: Self.thermal("critical"))
        XCTAssertEqual(r.p.current, .normal)
        r.samples(50, I(thermal: "critical", gpuPct: 100, lowPower: true, memPressure: "critical"))
        XCTAssertTrue(r.out.isEmpty)
        XCTAssertEqual(r.p.startingProfile(for: Self.thermal("serious")), .normal)
    }

    func testModeEasedAlwaysEased() {
        var r = Run(mode: .eased)
        XCTAssertEqual(r.p.current, .eased)
        r.samples(100, Self.calm)
        XCTAssertTrue(r.out.isEmpty)
        XCTAssertEqual(r.p.current, .eased)
    }

    func testModeChangesMidRecording() {
        var r = Run()
        let d1 = r.p.setMode(.eased, now: 10)
        XCTAssertEqual(d1?.to, .eased); XCTAssertEqual(d1?.reason, "mode_eased")
        let d2 = r.p.setMode(.never, now: 20)
        XCTAssertEqual(d2?.to, .normal); XCTAssertEqual(d2?.reason, "mode_never")
        XCTAssertNil(r.p.setMode(.never, now: 30))
        XCTAssertNil(r.p.setMode(.auto, now: 30))
        r.t = 30
        r.nudge(Self.thermal("fair"))
        XCTAssertEqual(r.out.map { $0.1.to }, [.eased])
    }

    func testFailedApplyRevertsAndHoldsOff() {
        var r = Run()
        r.samples(1, Self.thermal("fair"))       // t=10
        r.p.applyFailed(r.out[0].1, now: 10)
        XCTAssertEqual(r.p.current, .normal)
        r.samples(5, Self.thermal("fair"))       // t=60: still inside the 60 s hold
        XCTAssertEqual(r.out.count, 1)
        r.samples(1, Self.thermal("fair"))       // t=70
        XCTAssertEqual(r.out.count, 2)
        XCTAssertEqual(r.out[1].1.to, .eased)
    }

    func testForceThenRulesCarryOn() {
        var r = Run()
        XCTAssertEqual(r.p.force(.eased, now: 0)?.reason, "forced")
        r.samples(30, Self.calm)                 // t=300: clear since 0
        XCTAssertEqual(r.out.map { $0.1.to }, [.normal])
        XCTAssertEqual(r.p.changes, 2)
    }

    func testFastConfigForE2E() {
        var r = Run(config: .fast)
        r.samples(2, Self.gpu(100))              // t=20 eased
        r.samples(2, Self.calm)                  // t=40: clear 20 s, dwell 20
        XCTAssertEqual(r.out.map { $0.0 }, [20, 40])
    }

    func testInputsFromSampleAndOverride() {
        let i = I(sample: ["thermal": "fair", "gpu_pct": 99.5, "low_power": false, "mem_pressure": "normal", "cpu_pct": 3.0])
        XCTAssertEqual(i, I(thermal: "fair", gpuPct: 99.5, lowPower: false, memPressure: "normal"))
        XCTAssertEqual(I(sample: ["gpu_pct": 100]).gpuPct, 100)
        XCTAssertEqual(I(sample: [:]), I())
        let o = i.overridden(by: I(gpuPct: 10, lowPower: true))
        XCTAssertEqual(o, I(thermal: "fair", gpuPct: 10, lowPower: true, memPressure: "normal"))
        XCTAssertTrue(i.json["gpu_pct"] is Double)
        XCTAssertTrue(I().json["thermal"] is NSNull)
        XCTAssertEqual(CaptureProfileMode(stored: nil), .auto)
        XCTAssertEqual(CaptureProfileMode(stored: "never"), .never)
        XCTAssertEqual(CaptureProfileMode(stored: "bogus"), .auto)
    }
}
