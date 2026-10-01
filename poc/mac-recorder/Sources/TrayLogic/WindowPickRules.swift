import Foundation

/// 0.3.20 — which window IS the call? The rules `WindowPicker` has applied since 0.2.x, moved
/// here unchanged so "why did it pick THIS window" is unit-testable against the bad picks seen
/// in the field (`WindowPickRulesTests`):
/// - Slack: a huddle recorded the main window titled after the DM in view, "radhika.rungta
///   (DM)", while the huddle itself was an UNTITLED 1728×1084 window (no "huddle" in any title →
///   the frontmost-window fallback).
/// - Teams: "Calendar | Atira Sarat (You)" as the call window (every Teams window a nav tab →
///   no Teams rule matches → frontmost).
/// - Meet in a Chrome tab: the window's title is the ACTIVE tab's; another tab in front → no
///   Meet title → frontmost.
///
/// Order: (1) title patterns per app, (2) the app's frontmost usable window (CGWindowList
/// order, `z`). Never largest-by-area. Every decision carries a stable `rule` code and the
/// human `reason` the logs have always shown. Foundation only (case-insensitive matching).
public struct WindowInfo: Equatable {
    public var id: UInt32
    public var pid: Int32
    public var owner: String
    public var title: String
    public var x: Double, y: Double, width: Double, height: Double
    /// Position in the front-to-back window list (0 = frontmost).
    public var z: Int
    public var onScreen: Bool
    public var layer: Int
    public var alpha: Double

    public init(id: UInt32, pid: Int32 = 0, owner: String = "", title: String, x: Double = 0, y: Double = 0,
                width: Double, height: Double, z: Int, onScreen: Bool = true, layer: Int = 0, alpha: Double = 1) {
        self.id = id
        self.pid = pid
        self.owner = owner
        self.title = title
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.z = z
        self.onScreen = onScreen
        self.layer = layer
        self.alpha = alpha
    }
}

public enum WindowPickRules {
    /// Nav tabs of the new Teams: the main window's title is whatever tab is open.
    public static let teamsNavPrefixes = ["Chat |", "Calendar |", "Activity |", "Teams |", "Calls |", "OneDrive |", "Apps |", "Copilot |"]

    public struct Decision: Equatable {
        public let window: WindowInfo?
        /// Stable code: `teams_meeting_title`, `teams_non_nav_teams_window`, `teams_frontmost_non_nav`,
        /// `zoom_meeting_title`, `slack_huddle_title`, `whatsapp_call_title`, `meet_title`,
        /// `webex_meeting_title`, `frontmost`, `no_usable_window`.
        public let rule: String
        /// The sentence the logs have carried since 0.2.x.
        public let reason: String
    }

    /// Why a window is not even considered (nil = usable): real windows only — layer 0, on
    /// screen, bigger than 320×240.
    public static func exclusion(_ c: WindowInfo) -> String? {
        if c.layer != 0 { return "layer \(c.layer)" }
        if !c.onScreen { return "off screen" }
        if !(c.width > 320 && c.height > 240) { return "too small" }
        return nil
    }

    public static func isTeamsNav(_ title: String) -> Bool { teamsNavPrefixes.contains { title.hasPrefix($0) } }

    /// `kind` is the CallKind raw value ("teams", "meet", …); `candidates` are the call app's
    /// windows (any order — sorted front to back here).
    public static func decide(kind: String, candidates: [WindowInfo]) -> Decision {
        let usable = candidates.sorted { $0.z < $1.z }.filter { exclusion($0) == nil }
        guard !usable.isEmpty else { return Decision(window: nil, rule: "no_usable_window", reason: "no usable window") }

        func first(_ rule: String, _ reason: String, _ test: (WindowInfo) -> Bool) -> Decision? {
            usable.first(where: test).map { Decision(window: $0, rule: rule, reason: reason) }
        }

        switch kind {
        case "teams":
            let notNav: (WindowInfo) -> Bool = { !isTeamsNav($0.title) }
            if let d = first("teams_meeting_title", "teams: title names a meeting/call", { c in
                notNav(c) && (c.title.localizedCaseInsensitiveContains("meeting") || c.title.localizedCaseInsensitiveContains("call"))
            }) { return d }
            if let d = first("teams_non_nav_teams_window", "teams: non-nav “… | Microsoft Teams” window", { c in
                notNav(c) && c.title.contains("| Microsoft Teams")
            }) { return d }
            if let d = first("teams_frontmost_non_nav", "teams: frontmost non-nav window", notNav) { return d }
        case "zoom":
            if let d = first("zoom_meeting_title", "zoom: “Zoom Meeting”/“Zoom Webinar”", {
                $0.title.contains("Zoom Meeting") || $0.title.contains("Zoom Webinar")
            }) { return d }
        case "slack":
            if let d = first("slack_huddle_title", "slack: huddle window", { $0.title.localizedCaseInsensitiveContains("huddle") }) { return d }
        case "whatsapp":
            // "<name> - WhatsApp voice call" / "… video call"; the main window is just "WhatsApp".
            if let d = first("whatsapp_call_title", "whatsapp: call window", { $0.title.localizedCaseInsensitiveContains("call") }) { return d }
        case "meet":
            if let d = first("meet_title", "meet: title names Google Meet", {
                $0.title.localizedCaseInsensitiveContains("meet.google") || $0.title.localizedCaseInsensitiveContains("google meet")
                    || $0.title.contains("Meet - ") || $0.title.contains("Meet – ")
            }) { return d }
        case "webex":
            if let d = first("webex_meeting_title", "webex: meeting window", { $0.title.localizedCaseInsensitiveContains("meeting") }) { return d }
        default:
            break
        }
        // Frontmost window of the app (CGWindowList order), never largest-by-area.
        return Decision(window: usable.first, rule: "frontmost", reason: "frontmost window of the app")
    }

    /// "Has the pick changed?" — what a re-resolve compares before it logs again.
    public static func signature(_ d: Decision) -> String { "\(d.window?.id ?? 0)|\(d.rule)" }
}

/// 0.3.20 — `window_title_changed` at most once per `interval` seconds per recording, and
/// always the NET change since the last logged title (a flip A→B→C inside the window logs
/// A→C, never B on its own). Pure and clock-free.
public struct TitleChangeTracker {
    public let interval: Double
    private var logged: String?
    private var windowId: UInt32?
    private var lastAt: Double?

    public init(interval: Double = 10) { self.interval = interval }

    /// Start (or re-point) tracking without logging: a new recording, a new window.
    public mutating func reset(windowId: UInt32?, title: String?) {
        self.windowId = windowId
        logged = title
        lastAt = nil
    }

    /// The (old, new) pair to log now, if any.
    public mutating func observe(windowId id: UInt32, title: String, now: Double) -> (old: String, new: String)? {
        if id != windowId { reset(windowId: id, title: title); return nil }
        guard let old = logged, title != old else { if logged == nil { logged = title }; return nil }
        if let lastAt, now - lastAt < interval { return nil }
        logged = title
        lastAt = now
        return (old, title)
    }
}
