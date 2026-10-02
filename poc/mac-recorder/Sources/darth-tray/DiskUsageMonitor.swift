import Foundation
import TrayLogic

/// 0.3.22 — the recorder's footprint on this Mac (`status.local_disk`, the menu's
/// "On this Mac: …" line). The buckets are `DiskUsage` in TrayLogic; this class only feeds it.
///
/// Never on the main queue: every refresh runs on a utility queue and stores the result;
/// `statusPayload()` and the menu read the stored value and ask for a new one. A refresh stats
/// only the registry's files (≤ 200 rows, a few parts each) and runs at most every
/// `minInterval` (a trailing run catches a burst's last change). The folder walk — the only
/// way to see files no row references — runs at launch and then at most every `walkInterval`.
/// File names and sizes only; nothing is ever opened.
final class DiskUsageMonitor {
    static let shared = DiskUsageMonitor()
    static let walkInterval: TimeInterval = 300
    static let minInterval: TimeInterval = 5
    static let COUNTING = "On this Mac: counting…"

    private let queue = DispatchQueue(label: "io.trames.darth.recorder.disk-usage", qos: .utility)
    private let lock = NSLock()
    // lock-guarded
    private var current: DiskUsage?
    private var computedAt: Date?
    private var walkedAt: Date?
    private var scheduled = false
    private var lastRun: Date?
    // queue-only
    private var folder: [DiskFile]?

    /// Main queue, when a refresh produced different numbers than the last one. The flag is
    /// true when more than the live recording's growth changed (worth a ws `status` broadcast;
    /// the growing part alone only retitles the menu line).
    var onChange: ((Bool) -> Void)?

    var latest: DiskUsage? {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// Ask for fresh numbers. `walk: true` also re-walks the folder now (launch).
    func refresh(walk: Bool = false) {
        lock.lock()
        if scheduled && !walk { lock.unlock(); return }
        scheduled = true
        let wait = walk ? 0 : max(0, Self.minInterval - Date().timeIntervalSince(lastRun ?? .distantPast))
        lock.unlock()
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.run(forceWalk: walk) }
    }

    private func run(forceWalk: Bool) {
        lock.lock()
        scheduled = false
        lastRun = Date()
        let needWalk = forceWalk || walkedAt.map { Date().timeIntervalSince($0) >= Self.walkInterval } ?? true
        lock.unlock()

        let dir = Paths.recordings.path
        if needWalk {
            folder = Self.walk(Paths.recordings)
            lock.lock(); walkedAt = Date(); lock.unlock()
        }
        let rows = Registry.shared.all().compactMap { r -> DiskRow? in
            guard let id = r["id"] as? String else { return nil }
            return DiskRow(id: id, status: r["status"] as? String, upload: r["upload"] as? Bool, files: r["files"] as? [String] ?? [])
        }
        let u = DiskUsage.compute(rows: rows, dir: dir, size: Self.size, folder: folder)

        lock.lock()
        let changed = u != current
        let settledChange = current.map { Self.settled($0) != Self.settled(u) } ?? true
        current = u
        computedAt = Date()
        lock.unlock()
        if changed {
            DispatchQueue.main.async { [weak self] in self?.onChange?(settledChange) }
        }
    }

    /// The numbers with the live recording's bytes taken out.
    private static func settled(_ u: DiskUsage) -> DiskUsage {
        var s = u
        s.totalBytes -= u.recordingBytes
        s.recordingBytes = 0
        return s
    }

    private static func size(_ path: String) -> Int? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path),
              (a[.type] as? FileAttributeType) == .typeRegular else { return nil }
        return (a[.size] as? NSNumber)?.intValue ?? 0
    }

    /// Every regular, non-hidden file under the recordings folder with its size. A missing
    /// folder is an empty list (nothing recorded yet), not "unknown".
    private static func walk(_ root: URL) -> [DiskFile] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
                                                     options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var out: [DiskFile] = []
        for case let url as URL in e {
            guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
            out.append(DiskFile(path: url.path, bytes: v.fileSize ?? 0))
        }
        return out
    }

    /// `status.local_disk`. nil before the first refresh finished (the key is then omitted).
    func json() -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let u = current else { return nil }
        return [
            "dir": Paths.recordings.path,
            "total_bytes": u.totalBytes,
            "files": u.files,
            "recordings": u.recordings,
            "pending_upload_bytes": u.pendingUploadBytes,
            "pending_upload_recordings": u.pendingUploadRecordings,
            "kept_bytes": u.keptBytes,
            "uploaded_bytes": u.uploadedBytes,
            "recording_bytes": u.recordingBytes,
            "orphan_bytes": u.orphanBytes ?? NSNull(),
            "orphan_files": u.orphanFiles ?? NSNull(),
            "orphans_scanned_at": walkedAt.map(isoString) ?? NSNull(),
            "computed_at": computedAt.map(isoString) ?? NSNull(),
        ]
    }
}
