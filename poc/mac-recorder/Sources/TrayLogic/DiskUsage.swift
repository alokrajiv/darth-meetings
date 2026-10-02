import Foundation

/// 0.3.22 — how much of this Mac's disk the recorder holds, and why.
///
/// 2026-10-02: Alok's Mac had ~491 MB under ~/Movies/Darth Recorder while the registry knew
/// of 5.1 MB still to upload — the rest were files no registry row referenced (pre-registry
/// recordings from 2026-09-15, rows the 200-row cap dropped, deleted rows whose files a
/// failed `removeItem` left behind). "Where is all this stored, and how much of it is not
/// uploaded?" had no answer short of `du`.
///
/// Buckets (bytes of files that EXIST — a missing file counts nowhere):
/// - `pendingUpload` — rows `local` / `uploading` / `upload_failed` (+ a row with no status,
///   which `Registry.pendingUpload` reads as `local`): exactly what an explicit "Upload now"
///   (`pendingUpload(automatic: false)`) would send.
/// - `kept` — the part of `pendingUpload` whose row says `upload: false` (keep on this Mac).
///   A subset, never added to the total twice.
/// - `uploaded` — `uploaded` rows whose files are still here (the 1 h purge has not run yet).
/// - `recording` — the live recording's parts (the open part is not in the row's `files` yet,
///   so every file under `<dir>/<id>/` of a `recording` row is counted here).
/// - `orphan` — files under the recordings folder that no live (non-`deleted`) row references.
///   Known only after a folder walk (`folder == nil` → orphans unknown, reported as nil).
///
/// Pure: the caller stats the files (`size` → nil when missing) and walks the folder.
public struct DiskRow: Equatable {
    public var id: String
    public var status: String?
    /// `upload: false` = the user chose to keep it on this Mac. nil = not set (uploads).
    public var upload: Bool?
    public var files: [String]

    public init(id: String, status: String?, upload: Bool?, files: [String]) {
        self.id = id
        self.status = status
        self.upload = upload
        self.files = files
    }
}

public struct DiskFile: Equatable {
    public var path: String
    public var bytes: Int

    public init(path: String, bytes: Int) {
        self.path = path
        self.bytes = bytes
    }
}

public struct DiskUsage: Equatable {
    /// Every byte counted below (pending + uploaded + recording + orphan; kept is inside pending).
    public var totalBytes = 0
    public var files = 0
    /// Rows with at least one file here, plus orphan groups (a folder under the recordings
    /// directory, or a loose file at its top level, counts as one).
    public var recordings = 0
    public var pendingUploadBytes = 0
    public var pendingUploadRecordings = 0
    public var keptBytes = 0
    public var uploadedBytes = 0
    public var recordingBytes = 0
    /// nil until the folder has been walked.
    public var orphanBytes: Int?
    public var orphanFiles: Int?

    public init() {}

    static let pendingStatuses: Set<String> = ["local", "uploading", "upload_failed"]

    /// - Parameters:
    ///   - rows: the registry, any order.
    ///   - dir: the recordings folder (`~/Movies/Darth Recorder`), no trailing slash needed.
    ///   - size: bytes of a file, nil when it does not exist.
    ///   - folder: every regular file under `dir` (recursive) with its size, or nil when the
    ///     folder has not been walked yet.
    public static func compute(rows: [DiskRow], dir: String, size: (String) -> Int?, folder: [DiskFile]?) -> DiskUsage {
        var u = DiskUsage()
        let root = normalize(dir)
        var counted = Set<String>()          // a file referenced twice is counted once
        var liveDirs: [String: String] = [:] // "<dir>/<id>" of a `recording` row → id

        for row in rows {
            let status = row.status ?? "local"
            if status == "deleted" { continue }
            if status == "recording" { liveDirs[root + "/" + row.id] = row.id }
            var rowBytes = 0, rowFiles = 0
            for f in row.files {
                let p = normalize(f)
                guard !counted.contains(p), let b = size(p) else { continue }
                counted.insert(p)
                rowBytes += b; rowFiles += 1
            }
            // The live recording's open part lives in its folder before it reaches `files`.
            if status == "recording", let folder {
                let prefix = root + "/" + row.id + "/"
                for f in folder where !counted.contains(normalize(f.path)) && normalize(f.path).hasPrefix(prefix) {
                    counted.insert(normalize(f.path))
                    rowBytes += f.bytes; rowFiles += 1
                }
            }
            guard rowFiles > 0 else { continue }
            u.files += rowFiles
            u.recordings += 1
            u.totalBytes += rowBytes
            switch status {
            case "recording":
                u.recordingBytes += rowBytes
            case "uploaded":
                u.uploadedBytes += rowBytes
            case _ where pendingStatuses.contains(status):
                u.pendingUploadBytes += rowBytes
                u.pendingUploadRecordings += 1
                if row.upload == false { u.keptBytes += rowBytes }
            default:
                break   // an unknown status: on disk (total), in no bucket
            }
        }

        guard let folder else { return u }
        var orphanBytes = 0, orphanFiles = 0
        var groups = Set<String>()
        for f in folder {
            let p = normalize(f.path)
            guard !counted.contains(p), p.hasPrefix(root + "/") else { continue }
            let rel = p.dropFirst(root.count + 1)
            let top = rel.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? String(rel)
            // A live recording's folder is never orphaned (a part may appear between the walk and the stat).
            if liveDirs[root + "/" + top] != nil { continue }
            counted.insert(p)
            orphanBytes += f.bytes; orphanFiles += 1
            groups.insert(top)
        }
        u.orphanBytes = orphanBytes
        u.orphanFiles = orphanFiles
        u.files += orphanFiles
        u.recordings += groups.count
        u.totalBytes += orphanBytes
        return u
    }

    /// "a//b/" → "a/b" (registry paths come from `URL.path`; the walk's do too, but a
    /// hand-edited registry should still match).
    static func normalize(_ p: String) -> String {
        var s = p
        while s.contains("//") { s = s.replacingOccurrences(of: "//", with: "/") }
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// The menu line: "On this Mac: 1.2 GB in 7 recordings · 480 MB waiting to upload ·
    /// 400 MB not in the registry". Zero clauses are left out; nothing on disk → "On this
    /// Mac: no recordings".
    public var menuLine: String {
        guard totalBytes > 0 else { return "On this Mac: no recordings" }
        var s = "On this Mac: \(Self.bytesLabel(totalBytes)) in \(recordings) recording\(recordings == 1 ? "" : "s")"
        if pendingUploadBytes > 0 { s += " · \(Self.bytesLabel(pendingUploadBytes)) waiting to upload" }
        if let o = orphanBytes, o > 0 { s += " · \(Self.bytesLabel(o)) not in the registry" }
        return s
    }

    /// 1000-based like Finder: "0 B", "512 KB", "4.8 MB", "1.2 GB"; one decimal under 10.
    public static func bytesLabel(_ b: Int) -> String {
        if b <= 0 { return "0 B" }
        if b < 1000 { return "\(b) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var v = Double(b) / 1000
        var i = 0
        while v >= 999.5 && i < units.count - 1 { v /= 1000; i += 1 }
        if v < 9.95 {
            let tenths = Int((v * 10).rounded())
            return "\(tenths / 10).\(tenths % 10) \(units[i])"
        }
        return "\(Int(v.rounded())) \(units[i])"
    }
}
