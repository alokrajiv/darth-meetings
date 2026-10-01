import XCTest
@testable import TrayLogic

/// The picker's rules against the bad picks seen in the field. These PIN today's behaviour
/// (0.3.20 adds diagnostics, not a new picker): each test names the rule that fired, which is
/// exactly what `window_pick.rule` now ships, so a server-side look at a bad pick reads the
/// same story as this file.
final class WindowPickRulesTests: XCTestCase {
    func w(_ id: UInt32, _ title: String, _ width: Double = 1728, _ height: Double = 1084, z: Int,
           onScreen: Bool = true, layer: Int = 0) -> WindowInfo {
        WindowInfo(id: id, title: title, width: width, height: height, z: z, onScreen: onScreen, layer: layer)
    }

    /// Ameya's huddle (recording 6843e1e4, 30 Sep 13:17 SGT): Slack's main window, titled after
    /// the DM in view, was in front of the UNTITLED huddle window of the same size. No title says
    /// "huddle" → frontmost → the DM window. The untitled window is a candidate with its size.
    func testSlackHuddleBehindTheDMWindowPicksTheDM() {
        let c = [w(11, "radhika.rungta (DM) - Trames - Slack", z: 3), w(12, "", z: 5)]
        let d = WindowPickRules.decide(kind: "slack", candidates: c)
        XCTAssertEqual(d.window?.id, 11)
        XCTAssertEqual(d.rule, "frontmost")
        XCTAssertNil(WindowPickRules.exclusion(c[1]))           // untitled, but usable
    }

    func testSlackUntitledHuddleInFrontIsPicked() {
        let c = [w(12, "", z: 2), w(11, "radhika.rungta (DM) - Trames - Slack", z: 4)]
        XCTAssertEqual(WindowPickRules.decide(kind: "slack", candidates: c).window?.id, 12)
    }

    func testSlackHuddleTitleWins() {
        let c = [w(11, "general - Trames - Slack", z: 1), w(13, "Huddle: #ops", 600, 400, z: 4)]
        let d = WindowPickRules.decide(kind: "slack", candidates: c)
        XCTAssertEqual(d.window?.id, 13)
        XCTAssertEqual(d.rule, "slack_huddle_title")
    }

    /// Teams with only nav-tab windows: every Teams rule skips them, and the fallback takes the
    /// frontmost — "Calendar | Atira Sarat (You)" became the call window.
    func testTeamsOnlyNavWindowsFallsBackToTheCalendar() {
        let c = [w(21, "Calendar | Atira Sarat (You) | Microsoft Teams", z: 0), w(22, "Chat | Ops | Microsoft Teams", z: 6)]
        let d = WindowPickRules.decide(kind: "teams", candidates: c)
        XCTAssertEqual(d.window?.id, 21)
        XCTAssertEqual(d.rule, "frontmost")
    }

    func testTeamsMeetingWindowBehindTheNavWindowWins() {
        let c = [w(21, "Calendar | Atira Sarat (You) | Microsoft Teams", z: 0),
                 w(23, "Weekly sync | Microsoft Teams", 1200, 800, z: 2)]
        let d = WindowPickRules.decide(kind: "teams", candidates: c)
        XCTAssertEqual(d.window?.id, 23)
        XCTAssertEqual(d.rule, "teams_non_nav_teams_window")
    }

    func testTeamsMeetingTitleBeatsOtherNonNav() {
        let c = [w(24, "Notes | Microsoft Teams", z: 0), w(25, "Meeting with Ivan | Microsoft Teams", z: 1)]
        XCTAssertEqual(WindowPickRules.decide(kind: "teams", candidates: c).rule, "teams_meeting_title")
    }

    /// Meet in a Chrome tab: the window title is the ACTIVE tab's.
    func testMeetTabNotActiveFallsBackToFrontmost() {
        let c = [w(31, "Inbox (3) - alok@trames.sg - Gmail - Google Chrome", z: 1)]
        let d = WindowPickRules.decide(kind: "meet", candidates: c)
        XCTAssertEqual(d.rule, "frontmost")
    }

    func testMeetTabActiveMatches() {
        let c = [w(31, "Inbox - Gmail - Google Chrome", z: 1), w(32, "Meet - abc-defg-hij - Google Chrome", z: 3)]
        let d = WindowPickRules.decide(kind: "meet", candidates: c)
        XCTAssertEqual(d.window?.id, 32)
        XCTAssertEqual(d.rule, "meet_title")
    }

    func testExclusionsAndNoUsableWindow() {
        let tiny = w(1, "Meeting", 300, 200, z: 0)
        let menu = w(2, "Meeting", z: 1, layer: 25)
        let off = w(3, "Meeting", z: 2, onScreen: false)
        XCTAssertEqual(WindowPickRules.exclusion(tiny), "too small")
        XCTAssertEqual(WindowPickRules.exclusion(menu), "layer 25")
        XCTAssertEqual(WindowPickRules.exclusion(off), "off screen")
        let d = WindowPickRules.decide(kind: "teams", candidates: [tiny, menu, off])
        XCTAssertNil(d.window)
        XCTAssertEqual(d.rule, "no_usable_window")
    }

    func testOrderIsZNotInputOrderNorArea() {
        let c = [w(2, "big", 3000, 2000, z: 9), w(1, "small", 400, 300, z: 1)]
        XCTAssertEqual(WindowPickRules.decide(kind: "other", candidates: c).window?.id, 1)
    }

    func testSignatureChangesWithWindowOrRule() {
        let a = WindowPickRules.decide(kind: "slack", candidates: [w(11, "dm", z: 0), w(12, "", z: 1)])
        let b = WindowPickRules.decide(kind: "slack", candidates: [w(12, "", z: 0), w(11, "dm", z: 1)])
        XCTAssertNotEqual(WindowPickRules.signature(a), WindowPickRules.signature(b))
        XCTAssertEqual(WindowPickRules.signature(a), WindowPickRules.signature(a))
    }
}

final class TitleChangeTrackerTests: XCTestCase {
    func testLogsAChangeThenThrottlesTo10s() {
        var t = TitleChangeTracker(interval: 10)
        t.reset(windowId: 7, title: "A")
        XCTAssertNil(t.observe(windowId: 7, title: "A", now: 0))
        XCTAssertEqual(t.observe(windowId: 7, title: "B", now: 5).map { [$0.old, $0.new] }, ["A", "B"])
        XCTAssertNil(t.observe(windowId: 7, title: "C", now: 10))          // 5 s later: held
        // The net change since the last logged title, once the 10 s have passed.
        XCTAssertEqual(t.observe(windowId: 7, title: "C", now: 15).map { [$0.old, $0.new] }, ["B", "C"])
    }

    func testAFlipBackInsideTheWindowLogsNothing() {
        var t = TitleChangeTracker(interval: 10)
        t.reset(windowId: 7, title: "A")
        _ = t.observe(windowId: 7, title: "B", now: 0)
        XCTAssertNil(t.observe(windowId: 7, title: "A", now: 3))
        XCTAssertEqual(t.observe(windowId: 7, title: "A", now: 12).map { [$0.old, $0.new] }, ["B", "A"])
        XCTAssertNil(t.observe(windowId: 7, title: "A", now: 30))
    }

    func testANewWindowResetsWithoutLogging() {
        var t = TitleChangeTracker(interval: 10)
        t.reset(windowId: 7, title: "A")
        XCTAssertNil(t.observe(windowId: 8, title: "Z", now: 1))
        XCTAssertEqual(t.observe(windowId: 8, title: "Y", now: 2).map { [$0.old, $0.new] }, ["Z", "Y"])
    }
}
