/// 0.3.20 — did the previous run of the tray exit cleanly?
///
/// 29 Sep 15:10 SGT, Ivan's 0.3.18: 35 s after a part roll onto a display share the tray went
/// silent — four `resource_sample`s, then nothing: no `recording_stopped`, no
/// `app_terminating`, a part-2 file without a moov atom, and no crash evidence from the device.
/// The next morning's launch only said `registry_reconciled`.
///
/// A RUNNING marker is written at launch and removed on a clean exit (`app_terminating`).
/// A marker still there at the next launch means the previous process died without that —
/// crash, `kill -9`, a hang killed by the system, the watchdog's `exit(70)` — and the launch
/// ships `unclean_exit` with what it can find (our own crash report, the end of tray.log).
///
/// Pure (no Foundation): the marker is a string dictionary the tray stores in a file.
public struct RunMarker: Equatable {
    public var pid: Int32
    public var version: String
    /// Unix seconds.
    public var startedAt: Double

    public init(pid: Int32, version: String, startedAt: Double) {
        self.pid = pid
        self.version = version
        self.startedAt = startedAt
    }

    public var fields: [String: String] {
        ["pid": String(pid), "version": version, "started_at": String(startedAt)]
    }

    public init?(fields: [String: String]) {
        guard let p = fields["pid"].flatMap(Int32.init), p > 0,
              let v = fields["version"], let s = fields["started_at"].flatMap(Double.init) else { return nil }
        self.init(pid: p, version: v, startedAt: s)
    }
}

public enum RunMarkerLogic {
    /// At launch, BEFORE our own marker is written: the previous run's marker if that run did
    /// not exit cleanly, else nil. A marker whose process is still alive (another copy of the
    /// tray — the move-to-Applications relaunch, an update relaunch racing the old copy's quit)
    /// is not an unclean exit. A marker with OUR pid is a stale one from before a reboot (pids
    /// are reused), so it counts.
    public static func uncleanPrevious(stored: RunMarker?, currentPid: Int32, previousStillRunning: Bool) -> RunMarker? {
        guard let stored else { return nil }
        if stored.pid != currentPid && previousStillRunning { return nil }
        return stored
    }

    /// On a clean exit: the marker to keep (nil = remove it). Only OUR marker is removed — a
    /// relaunched copy may already have written its own, and that one must survive our quit.
    public static func afterCleanExit(stored: RunMarker?, pid: Int32) -> RunMarker? {
        guard let stored, stored.pid != pid else { return nil }
        return stored
    }
}

/// Our own crash reports in ~/Library/Logs/DiagnosticReports: `<process>-YYYY-MM-DD-HHMMSS.ips`
/// and the system's variants (`ExcUserFault_<process>-…`, `<process>.cpu_resource-…`). Other
/// apps' reports are never read — the names are matched before anything is opened.
public enum CrashReports {
    public static let processNames = ["darth-tray", "Darth Recorder"]

    public static func isOurs(_ fileName: String, processNames: [String] = processNames) -> Bool {
        guard fileName.hasSuffix(".ips") else { return false }
        var name = Substring(fileName)
        if name.hasPrefix("ExcUserFault_") { name = name.dropFirst("ExcUserFault_".count) }
        return processNames.contains { p in
            guard name.hasPrefix(p) else { return false }
            let rest = name.dropFirst(p.count)
            return rest.hasPrefix("-") || rest.hasPrefix(".")   // "darth-tray-2026…", "darth-tray.cpu_resource-…"
        }
    }

    /// The newest of our reports written after `after` (unix seconds), if any.
    public static func newest(_ files: [(name: String, mtime: Double)], after: Double,
                              processNames: [String] = processNames) -> String? {
        files.filter { $0.mtime > after && isOurs($0.name, processNames: processNames) }
            .max { $0.mtime < $1.mtime }?.name
    }
}
