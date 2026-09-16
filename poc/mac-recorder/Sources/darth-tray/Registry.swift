import Foundation
import RecorderCore

/// The tray's own list of recordings on this Mac —
/// `~/Library/Application Support/DarthRecorder/recordings.json`.
///
/// It is the answer to ws `{cmd:"list_recordings"}`, the queue the auto-uploader works
/// through, and the local mirror of `recorder_recordings` on the server. Entries are plain
/// JSON dictionaries in exactly the shape the PWA parses (`parseRecording` in
/// `src/lib/companion/companion-client.ts`): id, files[], bytes, duration, started_at, call,
/// status, transcript_id, error, matched — plus tray-private keys (`segments`, `shares`,
/// `needs_sync`) the page ignores.
///
/// status: recording | local | uploading | uploaded | upload_failed | deleted
final class Registry {
    static let shared = Registry()
    private let lock = NSLock()
    private var rows: [[String: Any]] = []
    private let path = Paths.registry
    private let maxRows = 200

    init() { load() }

    private func load() {
        guard let d = try? Data(contentsOf: path),
              let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return }
        rows = arr
    }

    private func saveLocked() {
        if rows.count > maxRows { rows = Array(rows.prefix(maxRows)) }
        guard let d = try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]) else { return }
        try? d.write(to: path, options: .atomic)
    }

    /// Newest first.
    func all() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return rows
    }

    func get(_ id: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return rows.first { $0["id"] as? String == id }
    }

    func insert(_ row: [String: Any]) {
        lock.lock()
        rows.removeAll { $0["id"] as? String == row["id"] as? String }
        rows.insert(row, at: 0)
        saveLocked()
        lock.unlock()
    }

    @discardableResult
    func update(_ id: String, _ patch: [String: Any]) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let i = rows.firstIndex(where: { $0["id"] as? String == id }) else { return nil }
        for (k, v) in patch { rows[i][k] = v }
        saveLocked()
        return rows[i]
    }

    /// Recordings whose bytes are still only on this Mac.
    func pendingUpload() -> [[String: Any]] {
        all().filter {
            let s = ($0["status"] as? String) ?? "local"
            // "uploading" is included on purpose: a row left there by a process that died
            // mid-upload (quit, crash, update) must be retried at the next launch; live
            // uploads are skipped by the caller via `uploader.isUploading`.
            return s == "local" || s == "upload_failed" || s == "uploading"
        }
    }

    /// Rows the server has not confirmed yet (a failed POST/PATCH sets `needs_sync`).
    func needingSync() -> [[String: Any]] {
        all().filter { ($0["needs_sync"] as? Bool) == true }
    }

    /// Body for POST /api/recorder/recordings — the tray-private keys stay local.
    static func serverBody(_ row: [String: Any], deviceId: String) -> [String: Any] {
        var out: [String: Any] = ["device_id": deviceId]
        for k in ["id", "started_at", "ended_at", "duration", "bytes", "segments", "call", "shares", "status", "transcript_id", "error"] {
            if let v = row[k] { out[k] = v }
        }
        if let d = row["duration"] { out["duration_s"] = d }
        return out
    }
}
