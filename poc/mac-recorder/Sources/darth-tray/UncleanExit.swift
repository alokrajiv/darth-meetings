import Foundation
import RecorderCore
import TrayLogic

/// 0.3.20 — the RUNNING marker (`running.json` in Application Support) and the
/// `unclean_exit` report built from it at the next launch. See `RunMarker` (TrayLogic) for the
/// incident and the rules. About our own process only, so it runs at both telemetry levels;
/// the tray.log tail it attaches is still `.logExcerpt` (full only — tray.log names call
/// windows and apps), our own crash report is not.
enum RunGuard {
    static var path: URL { Paths.support.appendingPathComponent("running.json") }
    /// First bytes of our crash report that go up: the .ips header line + the start of the
    /// body (exception, termination reason, the faulting thread's first frames).
    static let crashHeadBytes = 12_000

    static func read() -> RunMarker? {
        guard let d = try? Data(contentsOf: path),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return nil }
        return RunMarker(fields: o)
    }

    static func write(_ m: RunMarker?) {
        guard let m else { try? FileManager.default.removeItem(at: path); return }
        if let d = try? JSONSerialization.data(withJSONObject: m.fields) { try? d.write(to: path, options: .atomic) }
    }

    /// Launch (after the move-to-Applications check): the previous run's marker when it did
    /// not exit cleanly; then our own marker is written.
    static func launch(version: String) -> RunMarker? {
        let me = getpid()
        let stored = read()
        let alive = stored.map { $0.pid != me && isTray($0.pid) } ?? false
        let prev = RunMarkerLogic.uncleanPrevious(stored: stored, currentPid: me, previousStillRunning: alive)
        write(RunMarker(pid: me, version: version, startedAt: Date().timeIntervalSince1970))
        return prev
    }

    /// `applicationWillTerminate`: remove our marker (never another copy's).
    static func cleanExit() {
        write(RunMarkerLogic.afterCleanExit(stored: read(), pid: getpid()))
    }

    /// Is `pid` a live darth-tray process?
    static func isTray(_ pid: Int32) -> Bool {
        guard kill(pid, 0) == 0 || errno == EPERM else { return false }
        var name = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &name, UInt32(name.count)) > 0 else { return false }
        return String(cString: name) == "darth-tray"
    }

    /// Log `unclean_exit` (+ `crash_report`, + `log_excerpt` on a full Mac). `reconciled` = the
    /// registry rows the launch found still `recording` — the recording the dead run was making.
    static func report(_ prev: RunMarker, reconciled: [String]) {
        let started = Date(timeIntervalSince1970: prev.startedAt)
        var e: [String: Any] = [
            "prev_pid": Int(prev.pid), "prev_version": prev.version, "prev_started_at": isoString(started),
            "recordings_left_recording": reconciled.count,
        ]
        // The newest row the dead run left at `recording`.
        let rows = reconciled.compactMap { Registry.shared.get($0) }
            .sorted { (($0["started_at"] as? String) ?? "") < (($1["started_at"] as? String) ?? "") }
        if let row = rows.last {
            e["last_recording_id"] = row["id"] ?? NSNull()
            let segs = row["segments"] as? [[String: Any]] ?? []
            e["last_segment"] = segs.last?["index"] ?? NSNull()
            e["last_segment_started_at"] = segs.last?["started_at"] ?? NSNull()
            e["last_segment_source"] = segs.last?["source"] ?? NSNull()
        }
        let crash = newestCrashReport(after: prev.startedAt)
        e["crash_report"] = crash?.name ?? NSNull()
        EventLog.shared.log("unclean_exit", e,
                            summary: "UNCLEAN EXIT: the previous run (pid \(prev.pid), \(prev.version), started \(isoString(started))) ended without quitting — \(reconciled.count) recording(s) left at 'recording'\(crash.map { ", crash report \($0.name)" } ?? ", no crash report")")
        if let crash {
            EventLog.shared.log("crash_report", ["prev_pid": Int(prev.pid), "prev_version": prev.version, "file": crash.name,
                                                 "mtime": isoString(crash.mtime), "bytes_total": crash.size, "head": crash.head])
        }
        if Telemetry.allows(.logExcerpt) {
            // Everything before THIS run's start line is the previous run's.
            let lines = LogTail.excerpt(before: "starting, pid \(getpid()),")
            EventLog.shared.log("log_excerpt", ["why": "unclean_exit", "prev_pid": Int(prev.pid), "lines": lines])
        }
    }

    /// Our own newest .ips report written after the dead run started (names matched BEFORE
    /// anything is opened — other apps' reports are never read).
    static func newestCrashReport(after: Double) -> (name: String, mtime: Date, size: Int, head: String)? {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DiagnosticReports", isDirectory: true)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return nil }
        let ours = names.filter { CrashReports.isOurs($0) }.compactMap { n -> (name: String, mtime: Double)? in
            guard let m = (try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(n).path))?[.modificationDate] as? Date else { return nil }
            return (n, m.timeIntervalSince1970)
        }
        guard let pick = CrashReports.newest(ours, after: after) else { return nil }
        let url = dir.appendingPathComponent(pick)
        guard let fh = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? fh.close() }
        let head = (try? fh.read(upToCount: crashHeadBytes)) ?? Data()
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
        let mtime = ours.first { $0.name == pick }.map { Date(timeIntervalSince1970: $0.mtime) } ?? Date()
        return (pick, mtime, size, String(decoding: head, as: UTF8.self))
    }
}
