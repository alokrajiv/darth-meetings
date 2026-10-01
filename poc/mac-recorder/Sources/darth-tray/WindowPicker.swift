import AppKit
import CoreGraphics
import RecorderCore
import TrayLogic

/// Which window IS the call? The 0.1.x tray took the largest window of the app, which on
/// Teams is ALWAYS the main Chat/Calendar window and never the call — so every recording
/// captured the wrong thing.
///
/// Order now: (1) title patterns per app, (2) the app's frontmost window in CGWindowList
/// order. Never largest-by-area. 0.3.20: the rules live in TrayLogic (`WindowPickRules`,
/// unit-tested against the field's bad picks) and every DECISION is one `window_pick` event —
/// at detection, recording start, a re-resolve whose pick CHANGED, a roll, a re-detect, a manual
/// pick and a fallback — instead of `window_candidates` every 5 s (5,600 rows for one device
/// in two weeks, most of them identical). Never pixels, never thumbnails: titles, owners,
/// bounds, z-order.
struct WindowCandidate: Equatable {
    let id: CGWindowID
    let pid: pid_t
    let owner: String
    let title: String
    let frame: CGRect
    let z: Int
    let onScreen: Bool
    let layer: Int
    var alpha: Double = 1

    var info: WindowInfo {
        WindowInfo(id: id, pid: pid, owner: owner, title: title, x: frame.origin.x, y: frame.origin.y,
                   width: frame.width, height: frame.height, z: z, onScreen: onScreen, layer: layer, alpha: alpha)
    }

    /// The `window_pick` shape (0.3.20). An untitled window is "" with its size — the Slack
    /// huddle case.
    var json: [String: Any] {
        ["window_id": Int(id), "title": title, "owner": owner, "pid": Int(pid), "z_index": z, "on_screen": onScreen,
         "layer": layer, "alpha": (alpha * 100).rounded() / 100,
         "display_id": Int(WindowPicker.display(containing: frame)),
         "bounds": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height]]
    }
    var short: String { "#\(id) z\(z) \(Int(frame.width))x\(Int(frame.height)) \"\(title)\"" }
}

enum WindowPicker {
    static var teamsNavPrefixes: [String] { WindowPickRules.teamsNavPrefixes }

    /// Every on-screen window, front to back (`z` = position in that order).
    static func onScreenWindows() -> [WindowCandidate] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var out: [WindowCandidate] = []
        var z = 0
        for w in list {
            defer { z += 1 }
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let frame = CGRect(dictionaryRepresentation: b as CFDictionary),
                  let id = w[kCGWindowNumber as String] as? Int else { continue }
            out.append(WindowCandidate(
                id: CGWindowID(id), pid: pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? -1),
                owner: (w[kCGWindowOwnerName as String] as? String) ?? "?",
                title: (w[kCGWindowName as String] as? String) ?? "",
                frame: frame, z: z,
                onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) ?? true,
                layer: (w[kCGWindowLayer as String] as? Int) ?? 0,
                alpha: (w[kCGWindowAlpha as String] as? Double) ?? 1))
        }
        return out
    }

    /// All windows of `pid`, front to back.
    static func candidates(pid: pid_t) -> [WindowCandidate] { onScreenWindows().filter { $0.pid == pid } }

    struct Pick {
        let window: WindowCandidate?
        /// The call app's windows.
        let candidates: [WindowCandidate]
        let reason: String
        /// `WindowPickRules.Decision.rule` (stable code).
        let rule: String
        /// Every on-screen window at pick time (only ever SHIPPED on a full-telemetry Mac).
        let screen: [WindowCandidate]

        var signature: String { "\(window?.id ?? 0)|\(rule)" }
    }

    /// Pick the call window for a detected call.
    static func pick(kind: CallKind, pid: pid_t) -> Pick {
        let screen = onScreenWindows()
        let all = screen.filter { $0.pid == pid }
        let d = WindowPickRules.decide(kind: kind.rawValue, candidates: all.map { $0.info })
        let w = d.window.flatMap { info in all.first { $0.id == info.id } }
        return Pick(window: w, candidates: all, reason: d.reason, rule: d.rule, screen: screen)
    }

    /// One `window_pick` event (0.3.20). `how`: detect | start | reresolve | roll | redetect |
    /// manual | fallback | simulate. `picked`/`rule` override the picker's own answer when the
    /// decision was not the picker's (a manual pick, a share, a display fallback).
    ///
    /// Tiers: PARTIAL ships the call app's own windows as `candidates` (meeting metadata the
    /// tray already ships); FULL ships every on-screen window (owner, title, bounds, z) with
    /// `call_app` marking the call's, so a server-side look can see what beat what.
    static func logPick(how: String, call: DetectedCall?, pick: Pick, recordingId: String? = nil, detail: String? = nil,
                        picked: WindowCandidate?? = nil, rule: String? = nil, previous: Any? = nil) {
        let chosen: WindowCandidate? = picked ?? pick.window
        let callIds = Set(pick.candidates.map { $0.id })
        func row(_ c: WindowCandidate) -> [String: Any] {
            var j = c.json
            j["call_app"] = callIds.contains(c.id)
            if callIds.contains(c.id) { j["excluded"] = WindowPickRules.exclusion(c.info) ?? NSNull() }
            return j
        }
        var payload: [String: Any] = [
            "how": how,
            "rule": rule ?? pick.rule,
            "reason": pick.reason,
            "order_key": "z_index (front to back): the first usable window the rule matches wins; never area",
            "picked": chosen.map(row) ?? NSNull(),
            "call": ["app": call?.appName ?? NSNull(), "bundle_id": call?.bundleId ?? "", "kind": call?.kind.rawValue ?? "",
                     "pid": Int(call?.pid ?? 0)] as [String: Any],
            "call_window_count": pick.candidates.count,
            "untitled_call_windows": pick.candidates.filter { $0.title.isEmpty && WindowPickRules.exclusion($0.info) == nil }.count,
        ]
        if let recordingId { payload["recording_id"] = recordingId }
        if let detail { payload["detail"] = detail }
        if let previous { payload["previous"] = previous }
        if Telemetry.allows(.screenWindows) {
            // Every on-screen window, capped (the menu bar's status items alone are dozens).
            payload["candidates"] = pick.screen.prefix(120).map(row)
            payload["candidates_scope"] = "screen"
            payload["screen_window_count"] = pick.screen.count
        } else {
            payload["candidates"] = pick.candidates.map(row)
            payload["candidates_scope"] = "call_app"
        }
        let summary = "window pick (\(how)): \(chosen.map { $0.short } ?? "none") — \(rule ?? pick.rule): \(pick.reason); \(pick.candidates.count) call-app window(s): "
            + pick.candidates.prefix(8).map { $0.short }.joined(separator: ", ")
        EventLog.shared.log("window_pick", payload, summary: summary)
    }

    /// The display whose bounds contain the centre of `frame` (CG coords, top-left origin).
    static func display(containing frame: CGRect) -> CGDirectDisplayID {
        var ids = [CGDirectDisplayID](repeating: 0, count: 8)
        var n: UInt32 = 0
        let centre = CGRect(x: frame.midX, y: frame.midY, width: 1, height: 1)
        if CGGetDisplaysWithRect(centre, 8, &ids, &n) == .success, n > 0 { return ids[0] }
        return CGMainDisplayID()
    }
}
