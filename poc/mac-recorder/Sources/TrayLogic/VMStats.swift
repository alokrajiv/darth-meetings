/// 0.3.20 — memory pressure and swap for `resource_sample`.
///
/// The tray reads `host_statistics64(HOST_VM_INFO64)` (page counts and the LIFETIME swap-in /
/// swap-out totals), `vm.swapusage` and the two `kern.memorystatus_*` sysctls; this turns the
/// raw numbers into the event's fields. Swaps are shipped as deltas per sample: a lifetime
/// total says nothing about the call, a jump during it says the Mac was paging.
public struct VMCounters: Equatable {
    public var pageSize: UInt64
    public var freePages: UInt64
    public var activePages: UInt64
    public var compressorPages: UInt64
    public var swapins: UInt64
    public var swapouts: UInt64

    public init(pageSize: UInt64, freePages: UInt64, activePages: UInt64, compressorPages: UInt64, swapins: UInt64, swapouts: UInt64) {
        self.pageSize = pageSize
        self.freePages = freePages
        self.activePages = activePages
        self.compressorPages = compressorPages
        self.swapins = swapins
        self.swapouts = swapouts
    }
}

public enum VMStats {
    static func mb(_ pages: UInt64, _ pageSize: UInt64) -> Double {
        (Double(pages) * Double(pageSize) / 1_048_576 * 10).rounded() / 10
    }

    /// `mem_free_mb`, `mem_active_mb`, `mem_compressed_mb`, and — when there is a previous
    /// reading — `swapins` / `swapouts` since it. A counter that went BACKWARDS (it cannot,
    /// short of a reboot under us) yields no delta rather than a huge wrapped number.
    public static func fields(_ cur: VMCounters, previous prev: VMCounters?) -> [String: Double] {
        var d: [String: Double] = [
            "mem_free_mb": mb(cur.freePages, cur.pageSize),
            "mem_active_mb": mb(cur.activePages, cur.pageSize),
            "mem_compressed_mb": mb(cur.compressorPages, cur.pageSize),
        ]
        if let prev {
            if cur.swapins >= prev.swapins { d["swapins"] = Double(cur.swapins - prev.swapins) }
            if cur.swapouts >= prev.swapouts { d["swapouts"] = Double(cur.swapouts - prev.swapouts) }
        }
        return d
    }

    /// `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical (anything else: nil).
    public static func pressureName(_ level: Int) -> String? {
        switch level {
        case 1: return "normal"
        case 2: return "warn"
        case 4: return "critical"
        default: return nil
        }
    }

    /// Bytes → MB, one decimal (for `vm.swapusage`'s xsu_used).
    public static func megabytes(_ bytes: UInt64) -> Double {
        (Double(bytes) / 1_048_576 * 10).rounded() / 10
    }
}
