import Foundation

/// Sizes and durations the way the menu line and the banner say them (0.3.9).
enum Fmt {
    /// B / KB / MB / GB — one decimal under 10 ("9.4 MB", "298 MB", "1.4 GB").
    static func bytes(_ n: Int) -> String {
        let n = max(0, n)
        if n < 1024 { return "\(n) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var value = Double(n) / 1024
        var unit = 0
        while value >= 1024, unit < units.count - 1 { value /= 1024; unit += 1 }
        return value < 10 ? String(format: "%.1f %@", value, units[unit])
                          : String(format: "%.0f %@", value, units[unit])
    }

    /// "44m 31s", "1m 40s", "12s".
    static func duration(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    /// Shorten for one line of menu / banner text.
    static func clip(_ s: String, _ max: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > max ? String(t.prefix(max - 1)) + "…" : t
    }
}

/// The one upload the tray is talking about (0.3.9, P3 in docs/recorder-upload-ux.md).
///
/// The bytes belong to the tray, so the tray says where they are: the menu-bar glyph, the
/// menu line under the status line, the ws `upload` block in every status payload, and the
/// banner card all read this. Several uploads at once: the newest in flight wins the line,
/// the others stay in the registry behind "Upload N recordings now".
///
/// Read from the ws connection queue (`statusPayload`) and written from the main queue, so
/// everything goes through the lock.
final class UploadTracker {
    enum Phase: String { case uploading, done, failed }

    struct State {
        let id: String
        var title: String
        var phase: Phase
        var bytesSent: Int
        var bytesTotal: Int
        var segment: Int
        var segmentsTotal: Int
        var transcriptId: String?
        var error: String?
        /// When this phase was entered — a terminal line expires from the menu.
        var since: Date
        var pct: Double { bytesTotal > 0 ? min(100, Double(bytesSent) / Double(bytesTotal) * 100) : 0 }
    }

    /// "Uploaded … — transcribing · Open transcript" stays this long (or until the next upload).
    static let keepDone: TimeInterval = 10 * 60
    /// A failure stays until the retry timer (30 min) has had its go at it.
    static let keepFailed: TimeInterval = 35 * 60

    private let lock = NSLock()
    private var state: State?

    /// Every path that starts an upload calls this BEFORE `Uploader.upload`, so the first
    /// thing the person sees is the recording's name and its real size.
    func started(id: String, title: String, bytesTotal: Int, segmentsTotal: Int) {
        lock.lock(); defer { lock.unlock() }
        state = State(id: id, title: title, phase: .uploading, bytesSent: 0, bytesTotal: bytesTotal,
                      segment: 1, segmentsTotal: max(1, segmentsTotal), transcriptId: nil, error: nil, since: Date())
    }

    /// A throttled tick. An upload we never saw start (a tray restarted mid-flight) is adopted
    /// as long as nothing else is in flight — the newest in-flight upload keeps the line.
    func progress(_ p: UploadProgress, title: String?) {
        lock.lock(); defer { lock.unlock() }
        var s: State
        if let cur = state, cur.id == p.id {
            s = cur
        } else {
            guard state == nil || state?.phase != .uploading else { return }
            s = State(id: p.id, title: title ?? p.id, phase: .uploading, bytesSent: 0, bytesTotal: p.bytesTotal,
                      segment: 1, segmentsTotal: p.segmentsTotal, transcriptId: nil, error: nil, since: Date())
        }
        s.phase = .uploading
        s.bytesSent = p.bytesSent
        s.bytesTotal = max(p.bytesTotal, p.bytesSent)
        s.segment = p.segment
        s.segmentsTotal = p.segmentsTotal
        if let title, !title.isEmpty { s.title = title }
        state = s
    }

    /// Terminal events for anything but the line's own recording are ignored (the banner still
    /// shows them) — the newest upload owns the line.
    func done(id: String, transcriptId: String?, title: String?) {
        lock.lock(); defer { lock.unlock() }
        guard var s = state, s.id == id else { return }
        s.phase = .done
        s.transcriptId = (transcriptId?.isEmpty == false) ? transcriptId : nil
        s.bytesSent = s.bytesTotal
        s.error = nil
        s.since = Date()
        if let title, !title.isEmpty { s.title = title }
        state = s
    }

    func failed(id: String, error: String) {
        lock.lock(); defer { lock.unlock() }
        guard var s = state, s.id == id else { return }
        s.phase = .failed
        s.error = error
        s.since = Date()
        state = s
    }

    /// What there is to say right now — nil once a terminal line has aged out.
    func current() -> State? {
        lock.lock(); defer { lock.unlock() }
        guard let s = state else { return nil }
        let age = Date().timeIntervalSince(s.since)
        switch s.phase {
        case .uploading: return s
        case .done: return age < Self.keepDone ? s : nil
        case .failed: return age < Self.keepFailed ? s : nil
        }
    }

    var isUploading: Bool {
        lock.lock(); defer { lock.unlock() }
        return state?.phase == .uploading
    }

    /// The `upload` block of every status payload — the newest in-flight upload, so a PWA that
    /// connects mid-upload sees where the bytes are. NSNull()'d by the caller when nil.
    func wsPayload() -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let s = state, s.phase == .uploading else { return nil }
        return [
            "recording_id": s.id,
            "title": s.title,
            "pct": s.pct,
            "bytes_sent": s.bytesSent,
            "bytes_total": s.bytesTotal,
            "segment": s.segment,
            "segments_total": s.segmentsTotal,
        ]
    }

    /// The menu line under the status line, or nil when there is nothing to say.
    func menuLine() -> (title: String, actionable: Bool)? {
        guard let s = current() else { return nil }
        let name = Fmt.clip(s.title, 40)
        switch s.phase {
        case .uploading:
            let part = s.segmentsTotal > 1 ? " · part \(s.segment) of \(s.segmentsTotal)" : ""
            return ("Uploading “\(name)” · \(Int(s.pct))% · \(Fmt.bytes(s.bytesSent)) of \(Fmt.bytes(s.bytesTotal))\(part)", false)
        case .done:
            return ("Uploaded “\(name)” — transcribing\(s.transcriptId == nil ? "" : " · Open transcript")", s.transcriptId != nil)
        case .failed:
            return ("Upload failed “\(name)” — Retry now", true)
        }
    }
}
