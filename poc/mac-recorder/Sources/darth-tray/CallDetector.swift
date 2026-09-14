import Foundation
import AppKit
import CoreAudio
import CoreGraphics
import RecorderCore

/// What kind of call we think this is. Drives the banner copy and the PWA payload.
enum CallKind: String {
    case teams, meet, zoom, slack, facetime, whatsapp, webex, discord, browser, other
}

struct DetectedCall: Equatable {
    let id: String
    let pid: pid_t          // root app pid (Teams main process, Chrome main process, …)
    let appName: String
    let bundleId: String
    let kind: CallKind
    let title: String       // best window title we found ("MSC Contract … | Microsoft Teams")
    let windowFrame: CGRect?
    let startedAt: Date

    var json: [String: Any] {
        var d: [String: Any] = [
            "id": id, "pid": Int(pid), "app": appName, "bundle_id": bundleId,
            "kind": kind.rawValue, "title": title,
            "started_at": ISO8601DateFormatter().string(from: startedAt),
        ]
        if let f = windowFrame { d["window"] = ["x": f.origin.x, "y": f.origin.y, "w": f.width, "h": f.height] }
        return d
    }
}

/// Detects calls the way Notion/Granola do: poll Core Audio's process objects
/// (`kAudioHardwarePropertyProcessObjectList`, macOS 14+) and see which processes are
/// currently RUNNING INPUT — i.e. have the microphone open. Each such process is walked up
/// to its owning application (Teams WebView → Microsoft Teams, Chrome Helper → Google
/// Chrome), classified by bundle id, and for browsers the window title tells Meet from
/// Teams-web from Zoom-web. No mic permission is needed for this; window titles need
/// Screen Recording (without it browsers classify as `.browser` with an empty title).
final class CallDetector {
    var onStart: ((DetectedCall) -> Void)?
    var onEnd: ((DetectedCall) -> Void)?
    private(set) var active: [pid_t: DetectedCall] = [:]

    private var timer: Timer?
    private var seenCount: [pid_t: Int] = [:]      // consecutive polls a root pid was running input
    private var missingCount: [pid_t: Int] = [:]   // consecutive polls an active call was NOT seen
    private let startPolls = 2                     // ~3 s before we call it a call (mic permission checks flicker)
    private let endPolls = 3                       // ~4.5 s of silence before we call it ended
    private let interval: TimeInterval = 1.5

    /// Apps that use the mic but are not calls.
    private let ignoredBundles: Set<String> = [
        "com.apple.VoiceMemos", "com.apple.QuickTimePlayerX", "com.apple.controlcenter",
        "com.apple.Siri", "com.apple.assistant_service", "com.raycast.macos", "com.apple.systempreferences",
        "com.apple.SoundRecorder", "com.apple.ScreenContinuity", "io.trames.darth.recorder",
    ]
    private let browsers: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.canary", "com.google.Chrome.beta", "com.apple.Safari",
        "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox",
        "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.poll() }
        timer?.tolerance = 0.3
        poll()
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// Test hook (WS `simulate_call` / DARTH_TRAY_SIMULATE): inject a fake call.
    func inject(_ call: DetectedCall) {
        active[call.pid] = call
        onStart?(call)
    }
    func endInjected(pid: pid_t) {
        if let c = active.removeValue(forKey: pid) { onEnd?(c) }
    }

    // MARK: polling

    private func poll() {
        let running = pidsRunningInput()                 // helper pids with the mic open
        var roots: [pid_t: (bundle: String, name: String)] = [:]
        for (pid, bundleHint) in running {
            guard let root = rootApp(for: pid, bundleHint: bundleHint) else { continue }
            if ignoredBundles.contains(root.bundle) || root.pid == getpid() { continue }
            roots[root.pid] = (root.bundle, root.name)
        }

        // starts
        for (pid, info) in roots {
            if active[pid] != nil { missingCount[pid] = 0; continue }
            let n = (seenCount[pid] ?? 0) + 1
            seenCount[pid] = n
            if n >= startPolls {
                let call = classify(pid: pid, bundle: info.bundle, name: info.name)
                active[pid] = call
                seenCount[pid] = 0
                rlog("call started: \(call.appName) [\(call.kind)] \"\(call.title)\" pid=\(pid)")
                onStart?(call)
            }
        }
        for pid in seenCount.keys where roots[pid] == nil { seenCount[pid] = 0 }

        // ends
        for (pid, call) in active where roots[pid] == nil && pid > 0 {   // pid 0 = injected fake
            let n = (missingCount[pid] ?? 0) + 1
            missingCount[pid] = n
            if n >= endPolls {
                active.removeValue(forKey: pid)
                missingCount[pid] = 0
                rlog("call ended: \(call.appName) pid=\(pid) after \(Int(Date().timeIntervalSince(call.startedAt)))s")
                onEnd?(call)
            }
        }
    }

    // MARK: Core Audio

    private func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private func processObjects() -> [AudioObjectID] {
        var a = addr(kAudioHardwarePropertyProcessObjectList)
        let sys = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &list) == noErr else { return [] }
        return list
    }

    private func u32(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32? {
        var a = addr(sel)
        var v: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
    }

    private func str(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
        var a = addr(sel)
        var v: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr, let s = v?.takeRetainedValue() else { return nil }
        return s as String
    }

    /// pid → bundle id (may be a helper bundle) for every process with the mic open right now.
    private func pidsRunningInput() -> [pid_t: String] {
        var out: [pid_t: String] = [:]
        for obj in processObjects() {
            guard let running = u32(obj, kAudioProcessPropertyIsRunningInput), running != 0 else { continue }
            guard let pidU = u32(obj, kAudioProcessPropertyPID) else { continue }
            out[pid_t(pidU)] = str(obj, kAudioProcessPropertyBundleID) ?? ""
        }
        return out
    }

    // MARK: process → app

    private func parentPid(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }

    private func processPath(_ pid: pid_t) -> String {
        var buf = [CChar](repeating: 0, count: Int(PATH_MAX) * 4)
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : ""
    }

    private func processName(_ pid: pid_t) -> String {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_name(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : "pid \(pid)"
    }

    /// Walk up the parent chain until we hit a regular (Dock-visible) application; that is
    /// the thing the user thinks of as "the app on the call".
    private func rootApp(for pid: pid_t, bundleHint: String) -> (pid: pid_t, bundle: String, name: String)? {
        var p = pid
        var fallback: (pid_t, String, String)? = nil
        for _ in 0..<8 {
            if p <= 1 { break }
            if let app = NSRunningApplication(processIdentifier: p), let b = app.bundleIdentifier {
                let name = app.localizedName ?? processName(p)
                if app.activationPolicy == .regular { return (p, b, name) }
                if fallback == nil { fallback = (p, b, name) }
            }
            guard let pp = parentPid(p), pp != p else { break }
            p = pp
        }
        if let f = fallback { return f }
        // Not an app at all. System daemons (replayd — macOS's own screen-capture
        // daemon — opens "input" while WE record; coreaudiod, etc.) are never calls.
        let path = processPath(pid)
        if path.hasPrefix("/System/") || path.hasPrefix("/usr/") || path.hasPrefix("/sbin/") || path.hasPrefix("/Library/Apple/") { return nil }
        // CLI tool such as ffmpeg: report it under its own name.
        return (pid, bundleHint, processName(pid))
    }

    // MARK: classification

    private struct WinInfo { let title: String; let frame: CGRect }

    private func windows(of pid: pid_t) -> [WinInfo] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? Int) == Int(pid),
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let frame = CGRect(dictionaryRepresentation: b as CFDictionary),
                  frame.width > 200, frame.height > 150 else { return nil }
            return WinInfo(title: (w[kCGWindowName as String] as? String) ?? "", frame: frame)
        }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
    }

    private func classify(pid: pid_t, bundle: String, name: String) -> DetectedCall {
        let wins = windows(of: pid)
        var kind: CallKind
        var pick: WinInfo? = wins.first
        switch bundle {
        case let b where b.hasPrefix("com.microsoft.teams"): kind = .teams
        case "us.zoom.xos": kind = .zoom
        case "com.tinyspeck.slackmacgap": kind = .slack
        case "com.apple.FaceTime": kind = .facetime
        case "net.whatsapp.WhatsApp": kind = .whatsapp
        case "Cisco-Systems.Spark": kind = .webex
        case "com.hnc.Discord": kind = .discord
        case let b where browsers.contains(b):
            kind = .browser
            // Prefer the window whose title names a meeting product.
            let patterns: [(String, CallKind)] = [("meet.google", .meet), ("google meet", .meet), ("meet –", .meet), ("meet -", .meet),
                                                  ("microsoft teams", .teams), ("teams.microsoft", .teams), ("zoom", .zoom), ("webex", .webex)]
            outer: for w in wins {
                let t = w.title.lowercased()
                for (pat, k) in patterns where t.contains(pat) { kind = k; pick = w; break outer }
            }
        default: kind = .other
        }
        let title = pick?.title ?? ""
        return DetectedCall(id: "\(pid)-\(Int(Date().timeIntervalSince1970))", pid: pid, appName: name, bundleId: bundle,
                            kind: kind, title: title, windowFrame: pick?.frame, startedAt: Date())
    }
}
