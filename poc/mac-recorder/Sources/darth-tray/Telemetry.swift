import Foundation
import RecorderCore
import IOKit
import TrayLogic

/// 0.3.20 — the telemetry level (UserDefaults `telemetryLevel`: "full" | "partial", default
/// full) and the hardware identity every heartbeat and `app_launched` carry.
///
/// The level gates the RICH collectors only (process lists, per-process GPU, tray.log
/// excerpts — `TelemetryPolicy`); every event is stamped with it (`EventLog.log`) so the
/// server can tell "this Mac does not send process lists" from "nothing was running".
enum Telemetry {
    static let levelKey = "telemetryLevel"
    /// The first-launch notice has been shown (once, ever).
    static let noticeKey = "telemetryNoticeShown"

    /// Read straight from UserDefaults (thread-safe), so the sampler's queue and EventLog's
    /// callers never need the main queue to know the level.
    static var level: TelemetryLevel { TelemetryLevel(stored: UserDefaults.standard.string(forKey: levelKey)) }

    static func allows(_ c: TelemetryCollector) -> Bool { TelemetryPolicy.allows(c, level: level) }

    static func set(_ l: TelemetryLevel) { UserDefaults.standard.set(l.rawValue, forKey: levelKey) }
}

/// What this Mac is — partial-OK (Alok: hardware model and specs are fine on a personal Mac).
/// Read once; none of it changes while the process lives.
enum HardwareInfo {
    static let fields: [String: Any] = {
        var d: [String: Any] = [
            "hw_model": sysctlString("hw.model") ?? NSNull(),
            "chip": ResourceSampler.cpuBrand(),
        ]
        if let mem = sysctlInt("hw.memsize") { d["ram_gb"] = Int((Double(mem) / 1_073_741_824).rounded()) }
        if let n = sysctlInt("hw.ncpu") { d["cpu_cores"] = n }
        let nlevels = sysctlInt("hw.nperflevels") ?? 0
        var levels: [[String: Any]] = []
        for i in 0..<max(0, nlevels) {
            let name = sysctlString("hw.perflevel\(i).name") ?? "level \(i)"
            let cores = sysctlInt("hw.perflevel\(i).physicalcpu") ?? 0
            levels.append(["name": name, "cores": cores])
            if name == "Performance" { d["cpu_perf_cores"] = cores }
            if name == "Efficiency" { d["cpu_eff_cores"] = cores }
        }
        if !levels.isEmpty { d["cpu_perf_levels"] = levels }
        if let g = gpuCores() { d["gpu_cores"] = g }
        return d
    }()

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
        return String(cString: buf)
    }

    /// 4- or 8-byte integer sysctls (hw.ncpu is an int, hw.memsize a uint64).
    static func sysctlInt(_ name: String) -> Int? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0 else { return nil }
        if size == 8 {
            var v: Int64 = 0
            guard sysctlbyname(name, &v, &size, nil, 0) == 0 else { return nil }
            return Int(v)
        }
        if size == 4 {
            var v: Int32 = 0
            guard sysctlbyname(name, &v, &size, nil, 0) == 0 else { return nil }
            return Int(v)
        }
        return nil
    }

    /// The accelerator's "gpu-core-count" (Apple Silicon); nil elsewhere.
    static func gpuCores() -> Int? {
        var it: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &it) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(it) }
        while case let e = IOIteratorNext(it), e != 0 {
            defer { IOObjectRelease(e) }
            let v = IORegistryEntrySearchCFProperty(e, kIOServicePlane, "gpu-core-count" as CFString, kCFAllocatorDefault,
                                                    IOOptionBits(kIORegistryIterateRecursively | kIORegistryIterateParents))
            if let n = v as? NSNumber, n.intValue > 0 { return n.intValue }
        }
        return nil
    }
}
