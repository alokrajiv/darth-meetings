import AppKit
import CoreGraphics
import RecorderCore

/// Which window IS the call? The 0.1.x tray took the largest window of the app, which on
/// Teams is ALWAYS the main Chat/Calendar window and never the call — so every recording
/// captured the wrong thing.
///
/// Order now: (1) title patterns per app, (2) the app's frontmost window in CGWindowList
/// order. Never largest-by-area. Every candidate (id, title, frame, z-index, on-screen) is
/// logged to events.jsonl at detection and at every 5 s re-resolve — that log is the data we
/// want back from the beta testers.
struct WindowCandidate: Equatable {
    let id: CGWindowID
    let pid: pid_t
    let owner: String
    let title: String
    let frame: CGRect
    let z: Int
    let onScreen: Bool
    let layer: Int

    var json: [String: Any] {
        ["window_id": Int(id), "title": title, "owner": owner, "z": z, "on_screen": onScreen, "layer": layer,
         "frame": ["x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height]]
    }
    var short: String { "#\(id) z\(z) \(Int(frame.width))x\(Int(frame.height)) \"\(title)\"" }
}

enum WindowPicker {
    /// Nav tabs of the new Teams: the main window's title is whatever tab is open.
    static let teamsNavPrefixes = ["Chat |", "Calendar |", "Activity |", "Teams |", "Calls |", "OneDrive |", "Apps |", "Copilot |"]

    /// All windows of `pid`, front to back (`z` = position in that order).
    static func candidates(pid: pid_t) -> [WindowCandidate] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        var out: [WindowCandidate] = []
        var z = 0
        for w in list {
            let wpid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? -1)
            let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let frame = CGRect(dictionaryRepresentation: b as CFDictionary),
                  let id = w[kCGWindowNumber as String] as? Int else { z += 1; continue }
            if wpid == pid {
                out.append(WindowCandidate(
                    id: CGWindowID(id), pid: wpid,
                    owner: (w[kCGWindowOwnerName as String] as? String) ?? "?",
                    title: (w[kCGWindowName as String] as? String) ?? "",
                    frame: frame, z: z,
                    onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) ?? true,
                    layer: layer))
            }
            z += 1
        }
        return out
    }

    struct Pick {
        let window: WindowCandidate?
        let candidates: [WindowCandidate]
        let reason: String
    }

    /// Pick the call window for a detected call. `reason` explains which rule fired — it is
    /// logged, so a bad pick in the field can be diagnosed without a repro.
    static func pick(kind: CallKind, pid: pid_t) -> Pick {
        let all = candidates(pid: pid)
        // Real windows only: layer 0, big enough to be a call window, actually on screen.
        let usable = all.filter { $0.layer == 0 && $0.onScreen && $0.frame.width > 320 && $0.frame.height > 240 }
        guard !usable.isEmpty else { return Pick(window: nil, candidates: all, reason: "no usable window") }

        func firstMatch(_ why: String, _ test: (WindowCandidate) -> Bool) -> Pick? {
            guard let w = usable.first(where: test) else { return nil }
            return Pick(window: w, candidates: all, reason: why)
        }

        switch kind {
        case .teams:
            let notNav: (WindowCandidate) -> Bool = { c in
                !teamsNavPrefixes.contains { c.title.hasPrefix($0) }
            }
            if let p = firstMatch("teams: title names a meeting/call", { c in
                notNav(c) && (c.title.localizedCaseInsensitiveContains("meeting") || c.title.localizedCaseInsensitiveContains("call"))
            }) { return p }
            if let p = firstMatch("teams: non-nav “… | Microsoft Teams” window", { c in
                notNav(c) && c.title.contains("| Microsoft Teams")
            }) { return p }
            if let p = firstMatch("teams: frontmost non-nav window", notNav) { return p }
        case .zoom:
            if let p = firstMatch("zoom: “Zoom Meeting”/“Zoom Webinar”", {
                $0.title.contains("Zoom Meeting") || $0.title.contains("Zoom Webinar")
            }) { return p }
        case .slack:
            if let p = firstMatch("slack: huddle window", { $0.title.localizedCaseInsensitiveContains("huddle") }) { return p }
        case .whatsapp:
            // "<name> - WhatsApp voice call" / "… video call"; the main window is just "WhatsApp".
            if let p = firstMatch("whatsapp: call window", { $0.title.localizedCaseInsensitiveContains("call") }) { return p }
        case .meet:
            if let p = firstMatch("meet: title names Google Meet", {
                $0.title.localizedCaseInsensitiveContains("meet.google") || $0.title.localizedCaseInsensitiveContains("google meet")
                    || $0.title.contains("Meet - ") || $0.title.contains("Meet – ")
            }) { return p }
        case .webex:
            if let p = firstMatch("webex: meeting window", { $0.title.localizedCaseInsensitiveContains("meeting") }) { return p }
        default:
            break
        }
        // Frontmost window of the app (CGWindowList order), never largest-by-area.
        return Pick(window: usable.first, candidates: all, reason: "frontmost window of the app")
    }

    /// Log the full candidate list + the pick. `phase` is "detect", "record" or "reresolve".
    static func logCandidates(phase: String, call: DetectedCall?, pick: Pick) {
        let payload: [String: Any] = [
            "phase": phase,
            "app": call?.appName ?? "?",
            "bundle_id": call?.bundleId ?? "",
            "kind": call?.kind.rawValue ?? "",
            "pid": Int(call?.pid ?? 0),
            "reason": pick.reason,
            "picked": pick.window?.json ?? NSNull(),
            "candidates": pick.candidates.map { $0.json },
        ]
        let summary = "window pick (\(phase)): \(pick.window.map { $0.short } ?? "none") — \(pick.reason); \(pick.candidates.count) candidate(s): "
            + pick.candidates.prefix(8).map { $0.short }.joined(separator: ", ")
        EventLog.shared.log("window_candidates", payload, summary: summary)
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
