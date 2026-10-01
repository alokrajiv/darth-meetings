import Foundation
import RecorderCore
import IOKit
import TrayLogic

/// 0.3.20 — who is using the CPU and the GPU while a call or a recording is live. FULL
/// telemetry only: on a partial Mac this never runs and never lists a process
/// (`TelemetryPolicy.processList` / `.processGPU` are asked before anything is read).
///
/// Every 60 s (`SamplerPacing.processInterval`) one `process_sample` event:
/// - `top_cpu` — the top 5 apps by CPU over the interval. `proc_listallpids` +
///   `proc_pid_rusage` (user + system time, Mach ticks → ns), helpers grouped into their app by
///   the outermost `.app` in their path (`ProcessTop.appName`). Another user's processes
///   (WindowServer, coreaudiod, the Teams audio driver host) answer EPERM: counted as
///   `unreadable`, never guessed.
/// - `top_gpu` — the top 5 apps by GPU time: each AGX user client's `IOUserClientCreator`
///   ("pid 533, WindowServer") and the sum of its `AppUsage[].accumulatedGPUTime` (ns), readable
///   without root for every process, WindowServer and replayd included. The clients are
///   children of the IOAccelerator in the service plane; `IOServiceGetMatchingServices` on
///   "AGXDeviceUserClient" finds NONE of them (user clients are not registered services —
///   probed 2026-10-01 on an M3 Max: 0 matched, 142 as children, 2 ms to walk).
/// - tagged separately: `self_cpu_pct` / `self_gpu_ms` (this process), `watcher_cpu_pct` (our
///   children — the ShareDetector's `/usr/bin/log` stream, which getrusage in `resource_sample`
///   never counted), `replayd_cpu_pct` / `replayd_gpu_ms` (the ScreenCaptureKit server our
///   capture runs in), `windowserver_gpu_ms`, and the call's app (`call_app_cpu_pct`,
///   `call_app_gpu_ms`). The GPU numbers are what answer "is the GPU Teams or our capture".
///
/// All reading happens on a private utility queue; the main queue only flips it on and off.
final class ProcessSampler {
    static let shared = ProcessSampler()

    struct Context {
        var recordingId: String?
        var callApp: String?
        var callPid: Int32?
    }

    private let queue = DispatchQueue(label: "io.trames.darth.recorder.process-sampler", qos: .utility)
    // queue-only state
    private var timer: DispatchSourceTimer?
    private var previous: [Int32: ProcReading] = [:]
    private var previousAt: TimeInterval = 0
    // shared with the main queue
    private let lock = NSLock()
    private var context = Context()
    private static let timebase: (numer: UInt64, denom: UInt64) = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return (UInt64(max(1, tb.numer)), UInt64(max(1, tb.denom)))
    }()

    /// Main queue: what the next sample is about.
    func setContext(_ c: Context) {
        lock.lock(); context = c; lock.unlock()
    }

    private func currentContext() -> Context {
        lock.lock(); defer { lock.unlock() }
        return context
    }

    /// Main queue: on while a call or a recording is live AND the level is full.
    func setActive(_ on: Bool) {
        queue.async { [self] in
            if on {
                guard timer == nil else { return }
                guard Telemetry.allows(.processList) else { return }
                previous = snapshot()      // the baseline: the first event covers a full interval
                previousAt = ProcessInfo.processInfo.systemUptime
                let t = DispatchSource.makeTimerSource(queue: queue)
                let iv = SamplerPacing.processInterval
                t.schedule(deadline: .now() + iv, repeating: iv, leeway: .seconds(5))
                t.setEventHandler { [weak self] in self?.fire() }
                t.resume()
                timer = t
                rlog("process sampler: on (every \(Int(iv)) s, \(previous.count) processes in the baseline)")
            } else {
                guard let t = timer else { return }
                t.cancel()
                timer = nil
                previous = [:]
                rlog("process sampler: off")
            }
        }
    }

    private func fire() {
        // The level can change between ticks; a partial Mac reads nothing from here on.
        guard Telemetry.allows(.processList) else {
            timer?.cancel(); timer = nil; previous = [:]
            rlog("process sampler: off (telemetry is partial)")
            return
        }
        let t0 = Date()
        let cur = snapshot()
        let now = ProcessInfo.processInfo.systemUptime
        let r = ProcessTop.compute(previous: previous, current: cur, intervalSeconds: now - previousAt)
        previous = cur
        previousAt = now
        var e = Self.payload(r, context: currentContext())
        e["collect_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
        EventLog.shared.log("process_sample", e)
    }

    /// "This feels laggy": two readings `seconds` apart, off the main queue, independent of the
    /// running 60 s baseline. nil (and nothing read) on a partial Mac. `done` on the main queue.
    func oneShot(seconds: TimeInterval = 1, _ done: @escaping ([String: Any]?) -> Void) {
        guard Telemetry.allows(.processList) else { DispatchQueue.main.async { done(nil) }; return }
        let ctx = currentContext()
        DispatchQueue.global(qos: .userInitiated).async {
            let a = self.snapshot()
            let at = ProcessInfo.processInfo.systemUptime
            Thread.sleep(forTimeInterval: seconds)
            let b = self.snapshot()
            let r = ProcessTop.compute(previous: a, current: b, intervalSeconds: ProcessInfo.processInfo.systemUptime - at)
            let p = Self.payload(r, context: ctx)
            DispatchQueue.main.async { done(p) }
        }
    }

    // MARK: - the event

    static func payload(_ r: ProcessTop.Result, context c: Context) -> [String: Any] {
        let me = getpid()
        var kids = [Int32](repeating: 0, count: 64)
        let nk = Int(proc_listchildpids(me, &kids, Int32(kids.count * MemoryLayout<Int32>.size)))
        let children = Array(kids.prefix(max(0, min(nk, kids.count)))).filter { $0 > 0 }
        let replayd = r.pids(named: "replayd")
        let windowServer = r.pids(named: "WindowServer")
        var d: [String: Any] = [
            "interval_s": (r.intervalSeconds * 10).rounded() / 10,
            "processes": r.processes,
            "unreadable": r.unreadable,
            // `pids` capped at 10 (Spotlight's mdworker_shared alone ran 29 in one reading);
            // `pid_count` is the real number.
            "top_cpu": r.topCPU(5).map { ["name": $0.name, "cpu_pct": $0.value, "pids": $0.pids.prefix(10).map(Int.init), "pid_count": $0.pids.count] as [String: Any] },
            "top_gpu": r.topGPU(5).map { ["name": $0.name, "gpu_ms": $0.value, "pids": $0.pids.prefix(10).map(Int.init), "pid_count": $0.pids.count] as [String: Any] },
            "self_cpu_pct": r.cpuPct(pids: [me]) ?? NSNull(),
            "self_gpu_ms": r.gpuMs(pids: [me]) ?? 0,
            "watcher_cpu_pct": r.cpuPct(pids: children) ?? NSNull(),   // nil for no children too
            "watcher_pids": children.map(Int.init),
            "replayd_cpu_pct": r.cpuPct(pids: replayd) ?? NSNull(),
            "replayd_gpu_ms": r.gpuMs(pids: replayd) ?? 0,
            "windowserver_gpu_ms": r.gpuMs(pids: windowServer) ?? 0,
        ]
        if let id = c.recordingId { d["recording_id"] = id }
        d["recording"] = c.recordingId != nil
        if let pid = c.callPid, pid > 0 {
            d["call_pid"] = Int(pid)
            // The call's group is whatever its root pid was grouped under (Teams' helpers included).
            if let group = r.names[pid] {
                d["call_app"] = c.callApp ?? group
                let pids = r.pids(named: group)
                d["call_app_cpu_pct"] = r.cpuPct(pids: pids) ?? NSNull()
                d["call_app_gpu_ms"] = r.gpuMs(pids: pids) ?? 0
            } else if let app = c.callApp {
                d["call_app"] = app
            }
        } else if let app = c.callApp {
            d["call_app"] = app
        }
        return d
    }

    // MARK: - reading

    /// One reading of every process: its group name, CPU time (nil = EPERM) and GPU time.
    func snapshot() -> [Int32: ProcReading] {
        var out: [Int32: ProcReading] = [:]
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return out }
        var pids = [Int32](repeating: 0, count: Int(n) + 64)
        let got = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size)))
        let tb = Self.timebase
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        var name = [CChar](repeating: 0, count: 256)
        for pid in pids.prefix(max(0, min(got, pids.count))) where pid > 0 {
            let pl = proc_pidpath(pid, &path, UInt32(path.count))
            let p = pl > 0 ? String(cString: path) : ""
            let fallback: String = proc_name(pid, &name, UInt32(name.count)) > 0 ? String(cString: name) : "pid \(pid)"
            var info = rusage_info_v4()
            let r = withUnsafeMutablePointer(to: &info) { ptr in
                ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
            }
            // ri_user_time / ri_system_time are Mach absolute ticks on Apple Silicon (125/3 ns).
            let cpu: UInt64? = r == 0 ? UInt64(Double(info.ri_user_time &+ info.ri_system_time) * Double(tb.numer) / Double(tb.denom)) : nil
            out[pid] = ProcReading(name: ProcessTop.appName(path: p, fallback: fallback), cpuNs: cpu)
        }
        for (pid, ns) in Self.gpuTimeByPid() {
            if out[pid] != nil { out[pid]?.gpuNs = ns }
        }
        return out
    }

    /// Summed `accumulatedGPUTime` (ns) per pid over every AGX user client.
    static func gpuTimeByPid() -> [Int32: UInt64] {
        var out: [Int32: UInt64] = [:]
        var acc: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &acc) == KERN_SUCCESS else { return out }
        defer { IOObjectRelease(acc) }
        while case let a = IOIteratorNext(acc), a != 0 {
            defer { IOObjectRelease(a) }
            var it: io_iterator_t = 0
            guard IORegistryEntryGetChildIterator(a, kIOServicePlane, &it) == KERN_SUCCESS else { continue }
            defer { IOObjectRelease(it) }
            while case let c = IOIteratorNext(it), c != 0 {
                defer { IOObjectRelease(c) }
                guard let creator = IORegistryEntryCreateCFProperty(c, "IOUserClientCreator" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? String,
                      let who = ProcessTop.parseCreator(creator) else { continue }
                let usage = IORegistryEntryCreateCFProperty(c, "AppUsage" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [[String: Any]] ?? []
                let ns = usage.reduce(UInt64(0)) { $0 &+ (($1["accumulatedGPUTime"] as? NSNumber)?.uint64Value ?? 0) }
                out[who.pid, default: 0] &+= ns
            }
        }
        return out
    }
}
