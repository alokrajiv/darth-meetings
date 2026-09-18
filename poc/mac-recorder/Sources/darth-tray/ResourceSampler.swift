import Foundation
import IOKit
import IOKit.ps
import RecorderCore

/// Resource telemetry (0.3.6) — the sampler script of 2026-09-18 built into the tray. One
/// sample every 10 s while recording, every 60 s idle: our own CPU % (getrusage delta), memory
/// footprint (task_vm_info phys_footprint — what Activity Monitor shows), thread count,
/// system-wide CPU user/sys/idle (host_statistics delta), system GPU utilisation (the IOKit
/// IOAccelerator "Device Utilization %"), battery % + state (IOPS), the thermal state
/// (ProcessInfo) and the CPU / GPU die temperatures via the SMC (the same per-chip key sets
/// smctemp uses; averaged, 10–120 °C accepted). Microseconds of work per sample.
///
/// While recording every sample is a `resource_sample` event (ships with the telemetry, 360
/// events / hour, well under 100 KB) and `recording_stopped` carries the avg / max summary, so
/// the table that took a laptop sampler script exists for every recording on every Mac. The
/// latest sample is in the `status` payload (`resources`) and in the heartbeat.
final class ResourceSampler {
    static let shared = ResourceSampler()
    static let recordingInterval: TimeInterval = 10
    static let idleInterval: TimeInterval = 60

    /// Asked when re-pacing: are we recording (→ 10 s)?
    var isRecording: () -> Bool = { false }
    private var timer: Timer?
    private var lastRusage: (user: Double, sys: Double, at: Date)?
    private var lastHost: (user: UInt64, sys: UInt64, idle: UInt64, nice: UInt64)?
    private(set) var latest: [String: Any]?
    private var recordingSamples: [[String: Any]] = []
    private var recordingId: String?
    private let smc = SMCReader()
    private let chip: String = ResourceSampler.cpuBrand()

    func start() {
        _ = sample()   // primes the deltas
        latest = sample()
        schedule()
        rlog("resources: sampler on (\(chip); SMC \(smc.available ? "ok, \(smc.cpuKeys.count) CPU + \(smc.gpuKeys.count) GPU keys" : "unavailable")) — \(Int(Self.recordingInterval)) s recording / \(Int(Self.idleInterval)) s idle")
    }

    /// Re-pace after a recording starts or stops.
    func recordingStateChanged() { schedule() }

    func beginRecording(id: String) {
        recordingSamples = []
        recordingId = id
        tick()
        schedule()
    }

    /// The avg / max over the recording's samples, for `recording_stopped`.
    func endRecording() -> [String: Any] {
        let s = recordingSamples
        recordingSamples = []
        recordingId = nil
        schedule()
        func stat(_ key: String) -> [String: Any]? {
            let xs = s.compactMap { $0[key] as? Double }
            guard !xs.isEmpty else { return nil }
            return ["avg": (xs.reduce(0, +) / Double(xs.count) * 10).rounded() / 10, "max": xs.max()!, "n": xs.count]
        }
        var out: [String: Any] = ["samples": s.count]
        for k in ["cpu_pct", "mem_mb", "threads", "sys_cpu_pct", "gpu_pct", "cpu_temp_c", "gpu_temp_c"] {
            if let v = stat(k) { out[k] = v }
        }
        if let first = s.first?["battery_pct"] as? Double, let last = s.last?["battery_pct"] as? Double { out["battery_from_to"] = [first, last] }
        let thermal = s.compactMap { $0["thermal"] as? String }
        if let worst = ["critical", "serious", "fair", "nominal"].first(where: { thermal.contains($0) }) { out["thermal_worst"] = worst }
        return out
    }

    private func schedule() {
        timer?.invalidate()
        let iv = isRecording() ? Self.recordingInterval : Self.idleInterval
        let t = Timer(timeInterval: iv, repeats: false) { [weak self] _ in
            self?.tick()
            self?.schedule()
        }
        t.tolerance = iv / 10
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        let s = sample()
        latest = s
        if let id = recordingId {
            var e = s
            e["recording_id"] = id
            recordingSamples.append(s)
            EventLog.shared.log("resource_sample", e)
        }
    }

    // MARK: - one sample

    func sample() -> [String: Any] {
        var d: [String: Any] = ["ts": isoNow()]
        // Own CPU: getrusage delta over wall time.
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        let user = Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6
        let sys = Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
        let now = Date()
        if let last = lastRusage {
            let wall = now.timeIntervalSince(last.at)
            if wall > 0.5 { d["cpu_pct"] = (((user - last.user) + (sys - last.sys)) / wall * 1000).rounded() / 10 }
        }
        lastRusage = (user, sys, now)

        // Memory footprint + threads.
        var vm = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &vm) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        if kr == KERN_SUCCESS { d["mem_mb"] = (Double(vm.phys_footprint) / 1024 / 1024 * 10).rounded() / 10 }
        var threads: thread_act_array_t?
        var threadCount = mach_msg_type_number_t(0)
        if task_threads(mach_task_self_, &threads, &threadCount) == KERN_SUCCESS, let threads {
            d["threads"] = Double(threadCount)
            for i in 0..<Int(threadCount) { mach_port_deallocate(mach_task_self_, threads[i]) }
            vm_deallocate(mach_task_self_, vm_address_t(bitPattern: threads), vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.size))
        }

        // System CPU: host_statistics delta.
        var load = host_cpu_load_info()
        var lcount = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let hr = withUnsafeMutablePointer(to: &load) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(lcount)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &lcount) }
        }
        if hr == KERN_SUCCESS {
            let t = (UInt64(load.cpu_ticks.0), UInt64(load.cpu_ticks.1), UInt64(load.cpu_ticks.2), UInt64(load.cpu_ticks.3)) // user, system, idle, nice
            if let l = lastHost {
                let du = t.0 &- l.user, ds = t.1 &- l.sys, di = t.2 &- l.idle, dn = t.3 &- l.nice
                let total = Double(du + ds + di + dn)
                if total > 0 {
                    d["sys_cpu_pct"] = (Double(du + ds + dn) / total * 1000).rounded() / 10
                    d["sys_idle_pct"] = (Double(di) / total * 1000).rounded() / 10
                }
            }
            lastHost = (t.0, t.1, t.2, t.3)
        }

        if let gpu = Self.gpuUtilisation() { d["gpu_pct"] = gpu }
        if let b = Self.battery() { d["battery_pct"] = b.pct; d["battery_state"] = b.state }
        d["thermal"] = Self.thermalName(ProcessInfo.processInfo.thermalState)
        if smc.available {
            if let c = smc.average(smc.cpuKeys) { d["cpu_temp_c"] = c }
            if let g = smc.average(smc.gpuKeys) { d["gpu_temp_c"] = g }
        }
        return d
    }

    /// The first IOAccelerator's "Device Utilization %" (system-wide, what the sampler script read).
    private static func gpuUtilisation() -> Double? {
        var it: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &it) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(it) }
        var out: Double?
        while case let entry = IOIteratorNext(it), entry != 0 {
            defer { IOObjectRelease(entry) }
            if let stats = IORegistryEntryCreateCFProperty(entry, "PerformanceStatistics" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? [String: Any],
               let v = stats["Device Utilization %"] as? NSNumber {
                out = v.doubleValue
                break
            }
        }
        return out
    }

    private static func battery() -> (pct: Double, state: String)? {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for ps in list {
            guard let desc = IOPSGetPowerSourceDescription(blob, ps)?.takeUnretainedValue() as? [String: Any] else { continue }
            guard let cap = desc[kIOPSCurrentCapacityKey as String] as? NSNumber else { continue }
            let max = (desc[kIOPSMaxCapacityKey as String] as? NSNumber)?.doubleValue ?? 100
            let pct = (cap.doubleValue / Swift.max(1, max) * 100).rounded()
            let charging = (desc[kIOPSIsChargingKey as String] as? Bool) ?? false
            let source = (desc[kIOPSPowerSourceStateKey as String] as? String) ?? ""
            let state = charging ? "charging" : source == (kIOPSACPowerValue as String) ? (pct >= 100 ? "charged" : "ac") : "discharging"
            return (pct, state)
        }
        return nil
    }

    private static func thermalName(_ s: ProcessInfo.ThermalState) -> String {
        switch s {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    static func cpuBrand() -> String {
        var size = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
        guard size > 0 else { return "unknown" }
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("machdep.cpu.brand_string", &buf, &size, nil, 0)
        return String(cString: buf)
    }
}

// MARK: - SMC (Apple Silicon die temperatures)

/// A minimal AppleSMC user client: key info + read bytes, decoded like smctemp (flt / sp78 /
/// ui8…). Key sets per chip family are smctemp's (narugit/smctemp, 0.7.0). Fail-soft: any
/// error → `available` false and no temperature fields; never a crash, never a throw.
final class SMCReader {
    private var conn: io_connect_t = 0
    private(set) var available = false
    private(set) var cpuKeys: [String] = []
    private(set) var gpuKeys: [String] = []
    private var infoCache: [UInt32: (size: UInt32, type: String)] = [:]

    // The classic AppleSMC.h layout (80 bytes). Verified at init with MemoryLayout.
    private struct Vers { var major: UInt8 = 0, minor: UInt8 = 0, build: UInt8 = 0, reserved: UInt8 = 0, release: UInt16 = 0 }
    private struct PLimit { var version: UInt16 = 0, length: UInt16 = 0, cpu: UInt32 = 0, gpu: UInt32 = 0, mem: UInt32 = 0 }
    // C pads this to 12 bytes; Swift would pack it to 9 and shift result/status/data8 by 3
    // (the size check still passed — 80 — but the command byte landed in padding, 2026-09-18).
    private struct KeyInfo { var dataSize: UInt32 = 0, dataType: UInt32 = 0, attributes: UInt8 = 0, pad: (UInt8, UInt8, UInt8) = (0, 0, 0) }
    private struct KeyData {
        var key: UInt32 = 0
        var vers = Vers()
        var pLimit = PLimit()
        var keyInfo = KeyInfo()
        var result: UInt8 = 0, status: UInt8 = 0, data8: UInt8 = 0, pad: UInt8 = 0
        var data32: UInt32 = 0
        var bytes: (UInt64, UInt64, UInt64, UInt64) = (0, 0, 0, 0)   // 32 bytes
    }
    private static let kernelIndex: UInt32 = 2
    private static let cmdReadBytes: UInt8 = 5
    private static let cmdReadKeyInfo: UInt8 = 9

    init() {
        guard MemoryLayout<KeyData>.size == 80, MemoryLayout<KeyData>.offset(of: \KeyData.bytes) == 48,
              MemoryLayout<KeyData>.offset(of: \KeyData.keyInfo) == 28, MemoryLayout<KeyData>.offset(of: \KeyData.data32) == 44,
              MemoryLayout<KeyData>.offset(of: \KeyData.data8) == 42 else {
            rlog("resources: SMC struct layout mismatch (size \(MemoryLayout<KeyData>.size), keyInfo @\(MemoryLayout<KeyData>.offset(of: \KeyData.keyInfo) ?? -1), data8 @\(MemoryLayout<KeyData>.offset(of: \KeyData.data8) ?? -1), data32 @\(MemoryLayout<KeyData>.offset(of: \KeyData.data32) ?? -1), bytes @\(MemoryLayout<KeyData>.offset(of: \KeyData.bytes) ?? -1)) — temperatures off")
            return
        }
        let matching = IOServiceMatching("AppleSMC")
        var it: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &it) == KERN_SUCCESS else { return }
        let device = IOIteratorNext(it)
        IOObjectRelease(it)
        guard device != 0 else { return }
        let r = IOServiceOpen(device, mach_task_self_, 0, &conn)
        IOObjectRelease(device)
        guard r == KERN_SUCCESS else { rlog("resources: SMC open failed (\(r)) — temperatures off"); return }
        let brand = ResourceSampler.cpuBrand().lowercased()
        (cpuKeys, gpuKeys) = Self.keys(for: brand)
        // Prove one read works (and the keys exist on this chip) before claiming availability.
        available = !cpuKeys.isEmpty && average(cpuKeys) != nil
        if !available { rlog("resources: SMC opened but no readable CPU temperature keys for \"\(brand)\" — temperatures off") }
    }

    deinit { if conn != 0 { IOServiceClose(conn) } }

    /// smctemp's per-family key sets (Apple Silicon only; Intel Macs get nothing here).
    private static func keys(for brand: String) -> ([String], [String]) {
        if brand.contains("m5") {
            return (["Tp00", "Tp04", "Tp08", "Tp0C", "Tp0G", "Tp0K", "Tp0O", "Tp0R", "Tp0U", "Tp0X", "Tp0a", "Tp0d", "Tp0g", "Tp0j", "Tp0m", "Tp0p", "Tp0u", "Tp0y"],
                    ["Tg0U", "Tg0X", "Tg0d", "Tg0g", "Tg0j", "Tg1Y", "Tg1c", "Tg1g"])
        }
        if brand.contains("m4") { return (["Tp01", "Tp09", "Tp0f", "Tp05", "Tp0D"], ["Tg0D", "Tg0P", "Tg0X", "Tg0j"]) }
        if brand.contains("m3") { return (["Tp01", "Tp09", "Tp0f", "Tp0n", "Tp05", "Tp0D", "Tp0j", "Tp0r"], ["Tg0D", "Tg0P", "Tg0X", "Tg0b", "Tg0j", "Tg0v"]) }
        if brand.contains("m2") { return (["Tp1h", "Tp1t", "Tp1p", "Tp1l", "Tp01", "Tp09", "Tp0f", "Tp0n", "Tp05", "Tp0D", "Tp0j", "Tp0r"], ["Tg0f", "Tg0j"]) }
        if brand.contains("m1") { return (["Tp01", "Tp05", "Tp0D", "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b", "Tp09", "Tp0T"], ["Tg05", "Tg0D", "Tg0L", "Tg0T", "Tg1b", "Tg4b"]) }
        return ([], [])
    }

    /// Average of the keys that read as a plausible temperature (10–120 °C), one decimal; nil when none.
    func average(_ keys: [String]) -> Double? {
        var sum = 0.0, n = 0
        for k in keys {
            if let v = read(k), v > 10, v < 120 { sum += v; n += 1 }
        }
        return n > 0 ? ((sum / Double(n)) * 10).rounded() / 10 : nil
    }

    private func call(_ input: inout KeyData) -> KeyData? {
        var output = KeyData()
        var outSize = MemoryLayout<KeyData>.size
        let r = withUnsafePointer(to: &input) { ip in
            withUnsafeMutablePointer(to: &output) { op in
                IOConnectCallStructMethod(conn, Self.kernelIndex, ip, MemoryLayout<KeyData>.size, op, &outSize)
            }
        }
        return r == KERN_SUCCESS ? output : nil
    }

    private func read(_ key: String) -> Double? {
        guard conn != 0, key.utf8.count == 4 else { return nil }
        let k = key.utf8.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let info: (size: UInt32, type: String)
        if let cached = infoCache[k] { info = cached } else {
            var input = KeyData()
            input.key = k
            input.data8 = Self.cmdReadKeyInfo
            guard let out = call(&input), out.result == 0 else { return nil }
            let t = out.keyInfo.dataType
            let type = String(bytes: [UInt8(t >> 24 & 0xff), UInt8(t >> 16 & 0xff), UInt8(t >> 8 & 0xff), UInt8(t & 0xff)], encoding: .ascii) ?? ""
            info = (out.keyInfo.dataSize, type)
            infoCache[k] = info
        }
        var input = KeyData()
        input.key = k
        input.keyInfo.dataSize = info.size
        input.data8 = Self.cmdReadBytes
        guard let out = call(&input), out.result == 0 else { return nil }
        let bytes = withUnsafeBytes(of: out.bytes) { Array($0.prefix(Int(min(info.size, 32)))) }
        return Self.decode(type: info.type, bytes: bytes)
    }

    /// The subset of SMC types temperatures come in.
    private static func decode(type: String, bytes: [UInt8]) -> Double? {
        switch type {
        case "flt ":
            guard bytes.count >= 4 else { return nil }
            return Double(bytes.withUnsafeBytes { $0.load(as: Float.self) })   // little-endian on Apple Silicon, as smctemp reads it
        case "sp78":
            guard bytes.count >= 2 else { return nil }
            return Double(Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))) / 256
        case "ui8 ": return bytes.first.map(Double.init)
        case "ui16":
            guard bytes.count >= 2 else { return nil }
            return Double(UInt16(bytes[0]) << 8 | UInt16(bytes[1]))
        case "si8 ": return bytes.first.map { Double(Int8(bitPattern: $0)) }
        default: return nil
        }
    }
}
