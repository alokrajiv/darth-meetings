import Foundation
import RecorderCore

/// `~/Library/Logs/DarthRecorder/events.jsonl` — one JSON object per line
/// (`{"ts":…,"kind":…,"payload":{…}}`), rotated at 20 MB keeping 5 old files.
///
/// This is the beta's data set: every detection, candidate window list, share event, banner
/// show/hide/click, user action, recording start/stop/segment, upload step, auth step and
/// error lands here, and `Telemetry` ships it to the server. A byte offset into the current
/// file records what has already been shipped, so a batch is never sent twice and nothing is
/// lost across restarts (rotation resets the offset — the rotated-out tail is not re-shipped,
/// which is the right trade for 20 MB of already-shipped lines).
final class EventLog {
    static let shared = EventLog()

    private let path: URL
    private let offsetPath: URL
    private let lock = NSLock()
    private let maxBytes = 20 * 1024 * 1024
    private let keep = 5
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    init(path: URL? = nil, offsetPath: URL? = nil) {
        self.path = path ?? URL(fileURLWithPath: NSString("~/Library/Logs/DarthRecorder/events.jsonl").expandingTildeInPath)
        self.offsetPath = offsetPath ?? Paths.support.appendingPathComponent("telemetry-offset.json")
        try? FileManager.default.createDirectory(at: self.path.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    /// Append one event. `summary` (when given) also goes to tray.log so the human-readable
    /// log keeps its narrative without the full payload.
    func log(_ kind: String, _ payload: [String: Any] = [:], summary: String? = nil) {
        if let summary { rlog(summary) }
        let obj: [String: Any] = ["ts": iso.string(from: Date()), "kind": kind, "payload": payload]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        lock.lock()
        defer { lock.unlock() }
        rotateIfNeededLocked()
        if !FileManager.default.fileExists(atPath: path.path) {
            FileManager.default.createFile(atPath: path.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: path) {
            defer { try? fh.close() }
            _ = try? fh.seekToEnd()
            try? fh.write(contentsOf: Data(line.utf8))
        }
    }

    private func rotateIfNeededLocked() {
        let size = (try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? Int) ?? 0
        guard size > maxBytes else { return }
        let fm = FileManager.default
        try? fm.removeItem(at: path.appendingPathExtension("\(keep)"))
        for i in stride(from: keep - 1, through: 1, by: -1) {
            let from = path.appendingPathExtension("\(i)")
            if fm.fileExists(atPath: from.path) {
                try? fm.moveItem(at: from, to: path.appendingPathExtension("\(i + 1)"))
            }
        }
        try? fm.moveItem(at: path, to: path.appendingPathExtension("1"))
        writeOffsetLocked(0)
        rlog("events.jsonl rotated at \(size) bytes")
    }

    // MARK: shipping

    private func readOffset() -> UInt64 {
        guard let d = try? Data(contentsOf: offsetPath),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let v = o["offset"] as? NSNumber else { return 0 }
        return v.uint64Value
    }

    private func writeOffsetLocked(_ v: UInt64) {
        try? FileManager.default.createDirectory(at: offsetPath.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: ["offset": NSNumber(value: v)]) {
            try? d.write(to: offsetPath, options: .atomic)
        }
    }

    struct Batch {
        let events: [[String: Any]]
        let endOffset: UInt64
    }

    /// Up to `max` unshipped events (whole lines only). `endOffset` is what to commit after a
    /// successful POST.
    func takeBatch(max: Int = 500) -> Batch? {
        lock.lock()
        defer { lock.unlock() }
        let start = readOffset()
        guard let fh = try? FileHandle(forReadingFrom: path) else { return nil }
        defer { try? fh.close() }
        let size = (try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? Int).map { UInt64($0) } ?? 0
        if start > size { writeOffsetLocked(0) }            // truncated behind our back
        let from = start > size ? 0 : start
        guard size > from else { return nil }
        try? fh.seek(toOffset: from)
        // 8 MB is far more than 500 events; the cap is only a memory guard.
        guard let data = try? fh.read(upToCount: 8 * 1024 * 1024), !data.isEmpty else { return nil }
        var events: [[String: Any]] = []
        var consumed = 0
        var lineStart = data.startIndex
        while events.count < max, let nl = data[lineStart...].firstIndex(of: 0x0A) {
            let lineData = data[lineStart..<nl]
            if let obj = try? JSONSerialization.jsonObject(with: Data(lineData)) as? [String: Any] { events.append(obj) }
            consumed += data.distance(from: lineStart, to: nl) + 1
            lineStart = data.index(after: nl)
        }
        guard !events.isEmpty else { return nil }
        return Batch(events: events, endOffset: from + UInt64(consumed))
    }

    func commit(_ endOffset: UInt64) {
        lock.lock()
        writeOffsetLocked(endOffset)
        lock.unlock()
    }

    /// How many events are waiting to be shipped (cheap-ish: byte delta, not a line count).
    var unshippedBytes: Int {
        let size = (try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? Int) ?? 0
        return max(0, size - Int(readOffset()))
    }
}

/// Where the tray keeps its state. `~/Library/Application Support/DarthRecorder/`.
enum Paths {
    static let support: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DarthRecorder", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    static var auth: URL { support.appendingPathComponent("auth.json") }
    static var device: URL { support.appendingPathComponent("device.json") }
    static var registry: URL { support.appendingPathComponent("recordings.json") }
    static var recordings: URL {
        FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0].appendingPathComponent("Darth Recorder", isDirectory: true)
    }
}

func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
func isoString(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
