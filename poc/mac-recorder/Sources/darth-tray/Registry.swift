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
/// `upload: false` (0.2.4) marks a recording the user chose to keep on this Mac.
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

    /// Recordings whose bytes are still only on this Mac. `automatic` (the default: launch,
    /// sign-in, the retry timer) leaves out rows recorded with "upload: false" — the user asked
    /// to keep those on this Mac; only an explicit push (menu "Upload … now", PWA Upload) takes
    /// them, via `automatic: false`.
    func pendingUpload(automatic: Bool = true) -> [[String: Any]] {
        all().filter {
            let s = ($0["status"] as? String) ?? "local"
            if automatic, ($0["upload"] as? Bool) == false { return false }
            // "uploading" is included on purpose: a row left there by a process that died
            // mid-upload (quit, crash, update) must be retried at the next launch; live
            // uploads are skipped by the caller via `uploader.isUploading`.
            if s == "local" || s == "uploading" { return true }
            // A failed row is worth another go only while its bytes are still here. Capture-
            // failed rows (no files) used to be re-tried at every launch and fail again with
            // "no files on disk" each time (311b6289, 2026-09-18) — they are left alone now.
            return s == "upload_failed" && ($0["files"] as? [String] ?? []).contains { FileManager.default.fileExists(atPath: $0) }
        }
    }

    /// Launch-time repair (0.3.7). A row still at `recording` when the tray starts belongs to
    /// a process that died mid-recording (the 2026-09-16 main-queue zombie left one; the PWA
    /// showed it as an Upload spinner that never resolved and the calendar row as "Recording
    /// now…" for days). Nothing is being recorded at launch, so the row becomes `local` when
    /// its files are on disk with bytes (the auto-uploader then takes it) and `upload_failed`
    /// otherwise. Returns the ids changed so the caller can sync them to the server.
    func reconcileAfterLaunch() -> [String] {
        lock.lock(); defer { lock.unlock() }
        var changed: [String] = []
        for i in rows.indices where (rows[i]["status"] as? String) == "recording" {
            let files = (rows[i]["files"] as? [String] ?? []).filter { Self.fileSize($0) > 0 }
            rows[i]["files"] = files
            rows[i]["bytes"] = files.reduce(0) { $0 + Self.fileSize($1) }
            if !(rows[i]["ended_at"] is String) { rows[i]["ended_at"] = isoNow() }
            if files.isEmpty {
                rows[i]["status"] = "upload_failed"
                rows[i]["error"] = "capture never finished — the recorder was not running when the call ended"
            } else {
                rows[i]["status"] = "local"
                rows[i]["error"] = NSNull()
            }
            rows[i]["needs_sync"] = true
            if let id = rows[i]["id"] as? String { changed.append(id) }
        }
        if !changed.isEmpty { saveLocked() }
        return changed
    }

    /// Delete from this Mac (0.3.8, ws `delete_recording`): the files and the per-recording
    /// folder under ~/Movies/Darth Recorder/<id>/ go; the row STAYS as `deleted` with
    /// `needs_sync` so the server hears it (its transcript, if any, is untouched), and it no
    /// longer appears in `listed()`. Callers refuse a recording that is live or uploading.
    func markDeleted(_ id: String) -> (files: Int, removed: Int)? {
        lock.lock(); defer { lock.unlock() }
        guard let i = rows.firstIndex(where: { $0["id"] as? String == id }) else { return nil }
        let fm = FileManager.default
        let files = rows[i]["files"] as? [String] ?? []
        var removed = 0
        for f in files where fm.fileExists(atPath: f) {
            do { try fm.removeItem(atPath: f); removed += 1 } catch { rlog("delete: \(f): \(error)") }
        }
        let dir = Paths.recordings.appendingPathComponent(id, isDirectory: true)
        if fm.fileExists(atPath: dir.path) {
            do { try fm.removeItem(at: dir) } catch { rlog("delete: \(dir.path): \(error)") }
        }
        rows[i]["status"] = "deleted"
        rows[i]["files"] = []
        rows[i]["bytes"] = 0
        rows[i]["error"] = NSNull()
        rows[i]["needs_sync"] = true
        saveLocked()
        return (files.count, removed)
    }

    /// What `list_recordings` answers (0.3.8): everything but deleted rows.
    func listed() -> [[String: Any]] {
        all().filter { ($0["status"] as? String) != "deleted" }
    }

    private static func fileSize(_ path: String) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? Int) ?? 0
    }

    /// `upload_failed` rows that still have bytes on disk — what the 30-minute retry timer
    /// (0.2.4) works through. Capture-failed rows have no files and are left alone.
    func retryableFailed() -> [[String: Any]] {
        pendingUpload().filter {
            ($0["status"] as? String) == "upload_failed"
                && ($0["files"] as? [String] ?? []).contains { FileManager.default.fileExists(atPath: $0) }
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
