import XCTest
@testable import TrayLogic

final class RunMarkerTests: XCTestCase {
    /// The store as the tray uses it: written at launch, removed on a clean exit.
    struct Store {
        var marker: RunMarker?
        /// Launch: detect, then write our own marker.
        mutating func launch(pid: Int32, version: String = "0.3.20", at: Double, alive: Set<Int32> = []) -> RunMarker? {
            let prev = RunMarkerLogic.uncleanPrevious(stored: marker, currentPid: pid,
                                                      previousStillRunning: marker.map { alive.contains($0.pid) } ?? false)
            marker = RunMarker(pid: pid, version: version, startedAt: at)
            return prev
        }
        mutating func cleanExit(pid: Int32) { marker = RunMarkerLogic.afterCleanExit(stored: marker, pid: pid) }
    }

    func testFirstLaunchEverIsClean() {
        var s = Store()
        XCTAssertNil(s.launch(pid: 100, at: 1000))
        XCTAssertEqual(s.marker, RunMarker(pid: 100, version: "0.3.20", startedAt: 1000))
    }

    func testCleanExitClearsTheMarkerAndTheNextLaunchIsClean() {
        var s = Store()
        _ = s.launch(pid: 100, at: 1000)
        s.cleanExit(pid: 100)
        XCTAssertNil(s.marker)
        XCTAssertNil(s.launch(pid: 200, at: 2000))
    }

    /// Ivan, 29 Sep: the process died mid-recording — no app_terminating, so the marker stayed.
    func testStaleMarkerIsAnUncleanExit() {
        var s = Store()
        _ = s.launch(pid: 100, version: "0.3.18", at: 1000)
        let prev = s.launch(pid: 200, at: 90_000)
        XCTAssertEqual(prev, RunMarker(pid: 100, version: "0.3.18", startedAt: 1000))
        XCTAssertEqual(s.marker?.pid, 200)                         // ours replaces it
    }

    func testAnotherLiveCopyIsNotAnUncleanExit() {
        // The move-to-Applications / update relaunch: the old copy is still quitting.
        var s = Store()
        _ = s.launch(pid: 100, at: 1000)
        XCTAssertNil(s.launch(pid: 200, at: 1001, alive: [100]))
        // …and the old copy's clean exit must not remove the NEW copy's marker.
        s.cleanExit(pid: 100)
        XCTAssertEqual(s.marker?.pid, 200)
    }

    func testOurOwnPidInAStaleMarkerStillCounts() {
        // pid reuse after a reboot: the stored pid can be ours, and "alive" is then us.
        var s = Store()
        _ = s.launch(pid: 321, at: 1000)
        XCTAssertNotNil(s.launch(pid: 321, at: 5000, alive: [321]))
    }

    func testFieldsRoundTrip() {
        let m = RunMarker(pid: 4242, version: "0.3.20", startedAt: 1_759_300_000.5)
        XCTAssertEqual(RunMarker(fields: m.fields), m)
        XCTAssertNil(RunMarker(fields: ["pid": "x", "version": "1", "started_at": "1"]))
        XCTAssertNil(RunMarker(fields: [:]))
    }

    func testCrashReportNames() {
        XCTAssertTrue(CrashReports.isOurs("darth-tray-2026-09-29-151057.ips"))
        XCTAssertTrue(CrashReports.isOurs("darth-tray.cpu_resource-2026-09-29-151057.ips"))
        XCTAssertTrue(CrashReports.isOurs("ExcUserFault_darth-tray-2026-09-29-151057.ips"))
        XCTAssertTrue(CrashReports.isOurs("Darth Recorder-2026-09-29-151057.ips"))
        XCTAssertFalse(CrashReports.isOurs("DarthChat-2026-09-30-233635.ips"))
        XCTAssertFalse(CrashReports.isOurs("darth-trayhelper-2026-09-29-151057.ips"))
        XCTAssertFalse(CrashReports.isOurs("darth-tray-2026-09-29-151057.diag"))
        XCTAssertFalse(CrashReports.isOurs("AccessibilityControlsExtension-2026-09-24-092017.ips"))
    }

    func testNewestOfOursAfterTheRunStarted() {
        let files: [(name: String, mtime: Double)] = [
            ("darth-tray-2026-09-20-101010.ips", 500),          // before the run started
            ("darth-tray-2026-09-29-151057.ips", 1500),
            ("ExcUserFault_darth-tray-2026-09-29-151100.ips", 1600),
            ("Slack-2026-09-29-151200.ips", 1700),               // not ours, newer
        ]
        XCTAssertEqual(CrashReports.newest(files, after: 1000), "ExcUserFault_darth-tray-2026-09-29-151100.ips")
        XCTAssertNil(CrashReports.newest(files, after: 2000))
    }
}
