import XCTest
@testable import TrayLogic

final class ProcessTopTests: XCTestCase {
    static let s: UInt64 = 1_000_000_000   // one second in ns

    func testFirstSnapshotIsOnlyABaseline() {
        let cur: [Int32: ProcReading] = [10: ProcReading(name: "Microsoft Teams", cpuNs: 500 * Self.s, gpuNs: 9 * Self.s)]
        let r = ProcessTop.compute(previous: [:], current: cur, intervalSeconds: 60)
        XCTAssertTrue(r.cpuNsByPid.isEmpty)
        XCTAssertTrue(r.gpuNsByPid.isEmpty)
        XCTAssertTrue(r.topCPU().isEmpty)
        XCTAssertEqual(r.processes, 1)
    }

    func testCPUDeltaIsPercentOfOneCore() {
        let prev: [Int32: ProcReading] = [10: ProcReading(name: "A", cpuNs: 100 * Self.s)]
        let cur: [Int32: ProcReading] = [10: ProcReading(name: "A", cpuNs: 130 * Self.s)]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        // 30 s of CPU in 60 s = half a core.
        XCTAssertEqual(r.topCPU(), [ProcessTop.Entry(name: "A", value: 50, pids: [10])])
        XCTAssertEqual(r.cpuPct(pids: [10]), 50)
    }

    func testHelpersGroupIntoTheirApp() {
        let prev: [Int32: ProcReading] = [
            1: ProcReading(name: "Google Chrome", cpuNs: 0),
            2: ProcReading(name: "Google Chrome", cpuNs: 0),
            3: ProcReading(name: "Slack", cpuNs: 0),
        ]
        let cur: [Int32: ProcReading] = [
            1: ProcReading(name: "Google Chrome", cpuNs: 6 * Self.s),
            2: ProcReading(name: "Google Chrome", cpuNs: 12 * Self.s),
            3: ProcReading(name: "Slack", cpuNs: 15 * Self.s),
        ]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertEqual(r.topCPU(), [
            ProcessTop.Entry(name: "Google Chrome", value: 30, pids: [1, 2]),
            ProcessTop.Entry(name: "Slack", value: 25, pids: [3]),
        ])
    }

    func testTopNKeepsTheBiggestAndDropsIdle() {
        var prev: [Int32: ProcReading] = [:], cur: [Int32: ProcReading] = [:]
        for i in Int32(1)...8 {
            prev[i] = ProcReading(name: "p\(i)", cpuNs: 0)
            cur[i] = ProcReading(name: "p\(i)", cpuNs: UInt64(i) * Self.s)
        }
        cur[9] = ProcReading(name: "idle", cpuNs: 0); prev[9] = cur[9]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 10)
        XCTAssertEqual(r.topCPU(5).map(\.name), ["p8", "p7", "p6", "p5", "p4"])
        XCTAssertFalse(r.topCPU(20).contains { $0.name == "idle" })
    }

    func testUnreadableProcessesAreCountedNotMeasured() {
        let prev: [Int32: ProcReading] = [
            533: ProcReading(name: "WindowServer", cpuNs: nil, gpuNs: 100 * Self.s),
            700: ProcReading(name: "coreaudiod", cpuNs: nil),
        ]
        let cur: [Int32: ProcReading] = [
            533: ProcReading(name: "WindowServer", cpuNs: nil, gpuNs: 103 * Self.s),
            700: ProcReading(name: "coreaudiod", cpuNs: nil),
            800: ProcReading(name: "Mine", cpuNs: 2 * Self.s),
        ]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertEqual(r.unreadable, 2)
        XCTAssertNil(r.cpuPct(pids: [533]))
        // WindowServer's GPU is still readable — the whole point of the AGX clients.
        XCTAssertEqual(r.gpuMs(pids: [533]), 3000)
        XCTAssertEqual(r.topGPU().first, ProcessTop.Entry(name: "WindowServer", value: 3000, pids: [533]))
    }

    func testNewProcessCountsItsWholeTime() {
        let prev: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0)]
        let cur: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0), 2: ProcReading(name: "B", cpuNs: 3 * Self.s, gpuNs: 2_000_000)]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertEqual(r.cpuPct(pids: [2]), 5)
        XCTAssertEqual(r.gpuMs(pids: [2]), 2)
    }

    func testReusedPidIsANewProcess() {
        // Same pid, smaller CPU time → a new process; same pid under another name → also new.
        let prev: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 50 * Self.s), 2: ProcReading(name: "B", cpuNs: 1 * Self.s)]
        let cur: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 6 * Self.s), 2: ProcReading(name: "C", cpuNs: 9 * Self.s)]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertEqual(r.cpuPct(pids: [1]), 10)
        XCTAssertEqual(r.cpuPct(pids: [2]), 15)
    }

    func testGPUTimeThatDropsIsNotBlamed() {
        // A pid's client closed: its summed GPU time went DOWN. No delta, never a huge one.
        let prev: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0, gpuNs: 900 * Self.s)]
        let cur: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0, gpuNs: 4 * Self.s)]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertNil(r.gpuMs(pids: [1]))
    }

    func testFirstGPUClientInTheIntervalCountsFully() {
        let prev: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0, gpuNs: nil)]
        let cur: [Int32: ProcReading] = [1: ProcReading(name: "A", cpuNs: 0, gpuNs: 7_000_000)]
        let r = ProcessTop.compute(previous: prev, current: cur, intervalSeconds: 60)
        XCTAssertEqual(r.gpuMs(pids: [1]), 7)
    }

    func testPidsNamed() {
        let cur: [Int32: ProcReading] = [5: ProcReading(name: "Microsoft Teams", cpuNs: 0), 3: ProcReading(name: "Microsoft Teams", cpuNs: 0), 4: ProcReading(name: "x", cpuNs: 0)]
        let r = ProcessTop.compute(previous: [:], current: cur, intervalSeconds: 1)
        XCTAssertEqual(r.pids(named: "Microsoft Teams"), [3, 5])
    }

    func testAppName() {
        XCTAssertEqual(ProcessTop.appName(path: "/Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/Contents/MacOS/Microsoft Teams WebView", fallback: "x"), "Microsoft Teams")
        XCTAssertEqual(ProcessTop.appName(path: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)", fallback: "x"), "Google Chrome")
        XCTAssertEqual(ProcessTop.appName(path: "/usr/libexec/replayd", fallback: "x"), "replayd")
        XCTAssertEqual(ProcessTop.appName(path: "", fallback: "WindowServer"), "WindowServer")
    }

    func testParseCreator() {
        XCTAssertEqual(ProcessTop.parseCreator("pid 533, WindowServer")?.pid, 533)
        XCTAssertEqual(ProcessTop.parseCreator("pid 533, WindowServer")?.name, "WindowServer")
        XCTAssertEqual(ProcessTop.parseCreator("pid 910, NotificationCent")?.name, "NotificationCent")
        XCTAssertEqual(ProcessTop.parseCreator("pid 42")?.pid, 42)
        XCTAssertNil(ProcessTop.parseCreator("kernel_task"))
        XCTAssertNil(ProcessTop.parseCreator("pid x, y"))
    }
}

final class VMStatsTests: XCTestCase {
    static let page: UInt64 = 16_384

    func testFieldsWithoutPreviousHaveNoSwapDeltas() {
        let c = VMCounters(pageSize: Self.page, freePages: 64_000, activePages: 128_000, compressorPages: 32_000, swapins: 900, swapouts: 1200)
        let d = VMStats.fields(c, previous: nil)
        XCTAssertEqual(d["mem_free_mb"], 1000)           // 64,000 × 16 KB = 1000 MB
        XCTAssertEqual(d["mem_active_mb"], 2000)
        XCTAssertEqual(d["mem_compressed_mb"], 500)
        XCTAssertNil(d["swapins"])
        XCTAssertNil(d["swapouts"])
    }

    func testSwapsAreDeltas() {
        let a = VMCounters(pageSize: Self.page, freePages: 1, activePages: 1, compressorPages: 1, swapins: 900, swapouts: 1200)
        var b = a
        b.swapins = 950; b.swapouts = 1200
        let d = VMStats.fields(b, previous: a)
        XCTAssertEqual(d["swapins"], 50)
        XCTAssertEqual(d["swapouts"], 0)
    }

    func testCounterGoingBackwardsYieldsNoDelta() {
        let a = VMCounters(pageSize: Self.page, freePages: 1, activePages: 1, compressorPages: 1, swapins: 900, swapouts: 1200)
        var b = a
        b.swapins = 10
        let d = VMStats.fields(b, previous: a)
        XCTAssertNil(d["swapins"])
        XCTAssertEqual(d["swapouts"], 0)
    }

    func testPressureNames() {
        XCTAssertEqual(VMStats.pressureName(1), "normal")
        XCTAssertEqual(VMStats.pressureName(2), "warn")
        XCTAssertEqual(VMStats.pressureName(4), "critical")
        XCTAssertNil(VMStats.pressureName(0))
        XCTAssertEqual(VMStats.megabytes(3_419_276_288), 3260.9)   // 3260.875 MB
    }
}

final class SegmentCountersTests: XCTestCase {
    func testDeltaAcrossTwoParts() {
        // Part 1 closes with 2 gaps / 3.5 s / 4 overloads; part 2 adds 1 gap / 1.25 s / 0.
        let base = SegmentCounters.zero
        let cut1 = SegmentCounters(micGapsFilled: 2, micGapSeconds: 3.5, coreaudioOverloads: 4)
        XCTAssertEqual(cut1.delta(since: base), cut1)
        let cut2 = SegmentCounters(micGapsFilled: 3, micGapSeconds: 4.75, coreaudioOverloads: 4)
        XCTAssertEqual(cut2.delta(since: cut1), SegmentCounters(micGapsFilled: 1, micGapSeconds: 1.25, coreaudioOverloads: 0))
    }

    func testFreshCounterSmallerThanBaselineIsItsOwnDelta() {
        let base = SegmentCounters(micGapsFilled: 5, micGapSeconds: 10, coreaudioOverloads: 7)
        let fresh = SegmentCounters(micGapsFilled: 1, micGapSeconds: 0.5, coreaudioOverloads: 2)
        XCTAssertEqual(fresh.delta(since: base), fresh)
    }

    func testJSONFields() {
        let j = SegmentCounters(micGapsFilled: 1, micGapSeconds: 1.234, coreaudioOverloads: 3).json
        XCTAssertEqual(j["mic_gaps_filled_delta"] as? Int, 1)
        XCTAssertEqual(j["mic_gap_seconds_delta"] as? Double, 1.23)
        XCTAssertEqual(j["coreaudio_overloads"] as? Int, 3)
    }

    func testRateLimiterOnePer30s() {
        var r = RateLimiter(interval: 30)
        XCTAssertTrue(r.allow(now: 0).0)
        XCTAssertFalse(r.allow(now: 1).0)
        XCTAssertFalse(r.allow(now: 29.9).0)
        let third = r.allow(now: 30)
        XCTAssertTrue(third.0)
        XCTAssertEqual(third.suppressed, 2)
        XCTAssertFalse(r.allow(now: 45).0)
    }
}

final class TelemetryPolicyTests: XCTestCase {
    func testLevelFromStorage() {
        XCTAssertEqual(TelemetryLevel(stored: nil), .full)
        XCTAssertEqual(TelemetryLevel(stored: "partial"), .partial)
        XCTAssertEqual(TelemetryLevel(stored: "full"), .full)
        XCTAssertEqual(TelemetryLevel(stored: "garbage"), .full)
    }

    func testFullAllowsEverything() {
        for c in TelemetryCollector.allCases { XCTAssertTrue(TelemetryPolicy.allows(c, level: .full), c.rawValue) }
    }

    func testPartialIsMachineLevelOnly() {
        for c: TelemetryCollector in [.machineStats, .hardwareIdentity, .captureCounters, .lagReport, .callWindows] {
            XCTAssertTrue(TelemetryPolicy.allows(c, level: .partial), c.rawValue)
        }
        for c: TelemetryCollector in [.processList, .processGPU, .logExcerpt, .screenWindows] {
            XCTAssertFalse(TelemetryPolicy.allows(c, level: .partial), c.rawValue)
        }
    }

    func testPacing() {
        XCTAssertEqual(SamplerPacing.interval(recording: true, callLive: true), 10)
        XCTAssertEqual(SamplerPacing.interval(recording: true, callLive: false), 10)
        XCTAssertEqual(SamplerPacing.interval(recording: false, callLive: true), 30)
        XCTAssertEqual(SamplerPacing.interval(recording: false, callLive: false), 60)
        XCTAssertTrue(SamplerPacing.logs(recording: false, callLive: true))
        XCTAssertFalse(SamplerPacing.logs(recording: false, callLive: false))
    }

    func testProcessSamplingIsFullOnlyAndOnlyDuringACallOrRecording() {
        XCTAssertTrue(SamplerPacing.processSampling(recording: false, callLive: true, level: .full))
        XCTAssertTrue(SamplerPacing.processSampling(recording: true, callLive: false, level: .full))
        XCTAssertFalse(SamplerPacing.processSampling(recording: false, callLive: false, level: .full))
        XCTAssertFalse(SamplerPacing.processSampling(recording: true, callLive: true, level: .partial))
    }
}
