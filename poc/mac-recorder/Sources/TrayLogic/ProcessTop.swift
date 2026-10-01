/// 0.3.20 — "who was using the CPU and the GPU during the call", from two snapshots.
///
/// The tray reads, per pid: CPU time (`proc_pid_rusage`, user + system, already in ns) — or
/// nothing, when the process belongs to another user (WindowServer, coreaudiod, the Teams
/// audio driver host answer EPERM) — and GPU time (the AGX user clients' `AppUsage`
/// `accumulatedGPUTime`, readable for every process). This is the maths: per-pid deltas,
/// helper processes grouped into their app, the top N, and the totals the event tags
/// separately (our own pid, our children, replayd, WindowServer, the call's app).
///
/// Pure (no libproc, no IOKit): the snapshots are plain dictionaries, so every rule is
/// unit-tested (`Tests/TrayLogicTests/ProcessTopTests`). FULL telemetry only — the collector
/// that produces the snapshots is never called on a partial Mac (`TelemetryPolicy`).
public struct ProcReading: Equatable {
    /// The group the pid is shown under — its app (`ProcessTop.appName`).
    public var name: String
    /// User + system CPU time in ns; nil = unreadable (another user's process).
    public var cpuNs: UInt64?
    /// Summed `accumulatedGPUTime` over the pid's AGX clients, ns; nil = no GPU client.
    public var gpuNs: UInt64?

    public init(name: String, cpuNs: UInt64?, gpuNs: UInt64? = nil) {
        self.name = name
        self.cpuNs = cpuNs
        self.gpuNs = gpuNs
    }
}

public enum ProcessTop {
    public struct Entry: Equatable {
        public let name: String
        /// cpu_pct (100 = one core) for the CPU list, gpu_ms for the GPU list.
        public let value: Double
        public let pids: [Int32]

        public init(name: String, value: Double, pids: [Int32]) {
            self.name = name
            self.value = value
            self.pids = pids
        }
    }

    public struct Result {
        public let intervalSeconds: Double
        /// Pids in the current snapshot.
        public let processes: Int
        /// Pids whose CPU time could not be read (EPERM).
        public let unreadable: Int
        /// CPU / GPU ns spent in the interval, per pid (only pids with a known delta).
        public let cpuNsByPid: [Int32: UInt64]
        public let gpuNsByPid: [Int32: UInt64]
        public let names: [Int32: String]

        /// Percent of one core over the interval, one decimal.
        public func pct(_ ns: UInt64) -> Double {
            guard intervalSeconds > 0 else { return 0 }
            return (Double(ns) / (intervalSeconds * 1e9) * 1000).rounded() / 10
        }

        public static func ms(_ ns: UInt64) -> Double { (Double(ns) / 1e6 * 10).rounded() / 10 }

        /// Summed CPU % of these pids; nil when none of them had a readable delta.
        public func cpuPct(pids: [Int32]) -> Double? {
            let xs = pids.compactMap { cpuNsByPid[$0] }
            return xs.isEmpty ? nil : pct(xs.reduce(0, +))
        }

        public func gpuMs(pids: [Int32]) -> Double? {
            let xs = pids.compactMap { gpuNsByPid[$0] }
            return xs.isEmpty ? nil : Self.ms(xs.reduce(0, +))
        }

        public func pids(named name: String) -> [Int32] {
            names.filter { $0.value == name }.map { $0.key }.sorted()
        }

        public func topCPU(_ n: Int = 5) -> [Entry] {
            Self.top(cpuNsByPid, names: names, n: n).map { Entry(name: $0.name, value: pct($0.ns), pids: $0.pids) }
        }

        public func topGPU(_ n: Int = 5) -> [Entry] {
            Self.top(gpuNsByPid, names: names, n: n).map { Entry(name: $0.name, value: Self.ms($0.ns), pids: $0.pids) }
        }

        static func top(_ byPid: [Int32: UInt64], names: [Int32: String], n: Int) -> [(name: String, ns: UInt64, pids: [Int32])] {
            var groups: [String: (ns: UInt64, pids: [Int32])] = [:]
            for (pid, ns) in byPid where ns > 0 {
                let name = names[pid] ?? "pid \(pid)"
                var g = groups[name] ?? (0, [])
                g.ns += ns
                g.pids.append(pid)
                groups[name] = g
            }
            return groups.map { (name: $0.key, ns: $0.value.ns, pids: $0.value.pids.sorted()) }
                .sorted { $0.ns != $1.ns ? $0.ns > $1.ns : $0.name < $1.name }
                .prefix(max(0, n)).map { $0 }
        }
    }

    /// Deltas between two snapshots `intervalSeconds` apart.
    ///
    /// - A pid in both with the same name: current − previous. CPU time never goes backwards
    ///   for one process, so a smaller value is a REUSED pid (a new process): its whole time is
    ///   the delta. GPU time can drop when one of a pid's clients closes: no delta then (the
    ///   truth is somewhere between 0 and the current value; 0 never blames the wrong app).
    /// - A pid (or a reused pid under a new name) that appeared in the interval: its whole
    ///   time is the delta — but only when there IS a previous snapshot; the first one is a
    ///   baseline and yields nothing.
    /// - A pid that left in the interval: its last seconds are lost (nothing to read).
    public static func compute(previous: [Int32: ProcReading], current: [Int32: ProcReading], intervalSeconds: Double) -> Result {
        var cpu: [Int32: UInt64] = [:]
        var gpu: [Int32: UInt64] = [:]
        var names: [Int32: String] = [:]
        var unreadable = 0
        let baseline = !previous.isEmpty
        for (pid, cur) in current {
            names[pid] = cur.name
            if cur.cpuNs == nil { unreadable += 1 }
            guard baseline else { continue }
            let prev = previous[pid].flatMap { $0.name == cur.name ? $0 : nil }
            if let c = cur.cpuNs {
                if let p = prev?.cpuNs { cpu[pid] = c >= p ? c - p : c }
                else if prev == nil { cpu[pid] = c }
            }
            if let g = cur.gpuNs {
                if let p = prev?.gpuNs { if g >= p { gpu[pid] = g - p } }
                else { gpu[pid] = g }     // new pid, or its first GPU client opened in the interval
            }
        }
        return Result(intervalSeconds: intervalSeconds, processes: current.count, unreadable: unreadable,
                      cpuNsByPid: cpu, gpuNsByPid: gpu, names: names)
    }

    /// The app a process belongs to, from its executable path: the OUTERMOST `.app` bundle
    /// ("/Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/…" →
    /// "Microsoft Teams"; every "Google Chrome Helper (Renderer)" → "Google Chrome"). Not in an
    /// app: the executable's file name; no path at all: `fallback` (the process name).
    public static func appName(path: String, fallback: String) -> String {
        guard !path.isEmpty else { return fallback }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        if let app = parts.first(where: { $0.hasSuffix(".app") }) {
            let n = app.dropLast(4)
            if !n.isEmpty { return String(n) }
        }
        return parts.last.map(String.init) ?? fallback
    }

    /// An AGX user client's `IOUserClientCreator`: "pid 533, WindowServer" → (533, "WindowServer").
    /// The name is the kernel's p_comm (truncated to 16 characters) — the tray prefers the path.
    public static func parseCreator(_ s: String) -> (pid: Int32, name: String)? {
        guard s.hasPrefix("pid ") else { return nil }
        let rest = s.dropFirst(4)
        let comma = rest.firstIndex(of: ",") ?? rest.endIndex
        guard let pid = Int32(trim(rest[..<comma])), pid > 0 else { return nil }
        let name = comma < rest.endIndex ? trim(rest[rest.index(after: comma)...]) : ""
        return (pid, name)
    }

    /// Spaces off both ends (TrayLogic has no Foundation).
    static func trim(_ s: Substring) -> String {
        String(s.drop(while: { $0 == " " }).reversed().drop(while: { $0 == " " }).reversed())
    }
}
