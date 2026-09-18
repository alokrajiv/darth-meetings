import CryptoKit
import Foundation
import RecorderCore

/// Uploads (0.3.5) go through the SAME resumable session the web app uses — `POST /api/uploads`
/// → bytes → `POST /api/uploads/:id/complete` — instead of the one-shot `POST /api/transcripts`
/// that streamed a whole file through nginx and died with HTTP 408 on every retry for a
/// 1.3 GB recording on 2026-09-18 (Tailscale relay + one TCP stream). Two byte paths, the
/// SERVER decides which (`via` in the open reply):
///
///   blob   — darth uploads (docs/darth-uploads.md): the open reply carries a per-blob SAS on
///            Azure Blob (account darthuploads, container meetings); we PUT 4 MiB blocks straight
///            to Azure, `parallel` at a time, commit the block list, and `complete` makes the VM
///            pull the committed blob once. Tailscale and nginx are out of the byte path.
///   chunks — the host has no blob account (a laptop dev server): PUT 4–8 MiB chunks to
///            `/api/uploads/:id/chunks/:idx`, 4 at a time, each sha256-verified by the server.
///
/// Resume is the point: the whole file is hashed first (CryptoKit, streaming) and the session
/// fingerprint is that hash, so a retry after a drop, a quit or an update re-opens the SAME
/// session — on the blob path Azure tells us which blocks it already holds, on the chunk path
/// the server tells us which chunks it has — and only the missing bytes go up. Every attempt
/// is fail-soft: the recording row becomes `upload_failed` with the reason and the 30-minute
/// retry timer (or the next launch) simply calls `upload` again.
///
/// Multi-segment recordings go up as ONE multi-file stitch group (`multi` in the open body:
/// group = the recording id, index/total), exactly like the web multi-file upload, so the
/// server stitches them into a single transcript. `recorderRecordingId` links the transcript
/// back to `recorder_recordings` at finalise.
final class Uploader: NSObject, URLSessionTaskDelegate {
    private let api: ApiClient
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 600      // complete = pull + AAI hand-off, minutes for a big file
        cfg.timeoutIntervalForResource = 6 * 3600
        cfg.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    private var progressByTask: [Int: (Int64) -> Void] = [:]
    private let lock = NSLock()
    /// recording ids currently uploading.
    private(set) var active = Set<String>()

    /// Main queue callbacks.
    var onProgress: ((String, Int, Double) -> Void)?           // id, segment, pct 0…100
    var onDone: ((String, String) -> Void)?                    // id, transcript id
    var onFailed: ((String, String) -> Void)?                  // id, error

    static let blockTimeout: TimeInterval = 180
    /// Backoff between attempts after a failure (seconds; the last repeats) and how long one
    /// `upload` call keeps trying before it gives the row back to the retry timer.
    static let backoffS: [Double] = [1, 2, 4, 8, 15, 30]
    static let resumeWindow: TimeInterval = 30 * 60

    init(api: ApiClient) { self.api = api }

    func isUploading(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active.contains(id)
    }

    /// Upload every segment of `id` in order. Fail-soft: one failure marks the recording
    /// `upload_failed` and stops; the files stay on disk for a retry.
    func upload(recordingId id: String, linkedEvent: [String: Any]? = nil) {
        guard let row = Registry.shared.get(id) else { rlog("upload: unknown recording \(id)"); return }
        guard api.token() != nil else {
            EventLog.shared.log("upload_skipped", ["recording_id": id, "reason": "not signed in"],
                                summary: "upload: \(id) skipped — not signed in")
            onFailed?(id, "Sign in to Darth Meetings first")
            return
        }
        lock.lock()
        if active.contains(id) { lock.unlock(); rlog("upload: \(id) already in flight"); return }
        active.insert(id)
        lock.unlock()

        // 0-byte parts (a writer that died at the start of a segment) are dropped here, before
        // the group is numbered — the server's stitch expects exactly multi_total parts.
        let files = (row["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
            .filter { (((try? FileManager.default.attributesOfItem(atPath: $0.path)[.size]) as? Int) ?? 0) > 0 }
        guard !files.isEmpty else {
            finish(id, error: "no files on disk")
            return
        }
        let sizes = files.map { (try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int) ?? 0 }
        let total = sizes.reduce(0, +)
        guard total > 0 else {
            finish(id, error: "the recording is empty (0 bytes) — nothing to upload")
            return
        }
        Registry.shared.update(id, ["status": "uploading", "error": NSNull()])
        api.syncRecording(id)
        EventLog.shared.log("upload_started", ["recording_id": id, "files": files.count, "bytes": total],
                            summary: "upload: \(id) — \(files.count) file(s), \(total) bytes")

        DispatchQueue.global(qos: .utility).async {
            var sentBefore = 0
            var transcriptId: String?
            let group = files.count > 1 ? id.lowercased() : nil
            for (i, file) in files.enumerated() {
                let result = self.putOne(file: file, size: sizes[i], recordingId: id, linkedEvent: linkedEvent,
                                         group: group, index: i + 1, total: files.count) { sent in
                    let pct = Double(sentBefore + Int(sent)) / Double(total) * 100
                    DispatchQueue.main.async { self.onProgress?(id, i + 1, min(99.9, pct)) }
                }
                switch result {
                case .failure(let msg):
                    DispatchQueue.main.async { self.finish(id, error: msg) }
                    return
                case .success(let tid):
                    transcriptId = tid ?? transcriptId
                    sentBefore += sizes[i]
                }
            }
            DispatchQueue.main.async { self.finish(id, transcriptId: transcriptId) }
        }
    }

    private func finish(_ id: String, transcriptId: String? = nil, error: String? = nil) {
        lock.lock(); active.remove(id); lock.unlock()
        if let error {
            Registry.shared.update(id, ["status": "upload_failed", "error": error])
            api.syncRecording(id)
            EventLog.shared.log("upload_failed", ["recording_id": id, "error": error], summary: "upload: \(id) FAILED — \(error)")
            onFailed?(id, error)
        } else {
            Registry.shared.update(id, ["status": "uploaded", "transcript_id": transcriptId ?? NSNull(), "error": NSNull()])
            api.syncRecording(id)
            EventLog.shared.log("upload_done", ["recording_id": id, "transcript_id": transcriptId ?? ""],
                                summary: "upload: \(id) → transcript \(transcriptId ?? "?")")
            onDone?(id, transcriptId ?? "")
        }
    }

    private enum PutResult {
        case success(String?)
        case failure(String)
    }

    // MARK: - one file through /api/uploads

    /// The open reply.
    private struct Session {
        let id: String
        let via: String                 // "blob" | "chunks"
        let resumed: Bool
        let chunkSize: Int
        let chunkCount: Int
        let received: Set<Int>
        let blob: BlobTicket?
        let placeholderId: String?
    }

    private struct BlobTicket {
        let sasUrl: URL
        let blockBytes: Int
        let parallel: Int
        let expiresAt: Date
    }

    private struct HttpError: Error {
        let code: Int          // 0 = transport
        let message: String
        let json: [String: Any]?
    }

    private enum StepError: Error {
        case http(HttpError)
        case sessionGone(String)       // 404/410 — start over with a fresh session
        case notCommitted              // complete: blob not committed (blocks raced) — re-sync
        case missingChunks             // complete: chunks missing — re-sync
        case giveUp(String)
    }

    /// Synchronous (runs on a utility queue): one file through a resumable session.
    private func putOne(file: URL, size: Int, recordingId: String, linkedEvent: [String: Any]?,
                        group: String?, index: Int, total: Int,
                        progress: @escaping (Int64) -> Void) -> PutResult {
        let t0 = Date()
        guard let sha256 = Self.sha256(of: file) else { return .failure("could not read \(file.lastPathComponent)") }
        var fingerprint = "tray:" + sha256.prefix(40)
        if let group { fingerprint += "|g:\(group):\(index)" }
        rlog("upload: \(file.lastPathComponent) \(size) B sha256 \(sha256.prefix(12))… hashed in \(Int(Date().timeIntervalSince(t0) * 1000)) ms")

        let openBody: () -> [String: Any] = {
            var body: [String: Any] = [
                "fingerprint": fingerprint,
                "size": size,
                "filename": file.lastPathComponent,
                "contentType": file.pathExtension.lowercased() == "m4a" ? "audio/mp4" : "video/mp4",
                "via": "blob",
                "sha256": sha256,
                "recorderRecordingId": recordingId,
            ]
            if let linkedEvent, index == 1 { body["linkedEvent"] = linkedEvent }
            if let group {
                body["multi"] = ["group": group, "index": index, "total": total,
                                 "comment": "Darth Recorder segment \(index) of \(total)"]
            }
            return body
        }

        var restarts = 0
        while true {
            do {
                let session = try openSession(openBody(), label: file.lastPathComponent)
                if session.resumed { rlog("upload: \(file.lastPathComponent) resumes session \(session.id) (\(session.via))") }
                else { rlog("upload: \(file.lastPathComponent) session \(session.id) via \(session.via)") }
                // Up to 3 rounds of bytes → complete (a 409 from complete means an ack raced).
                var current = session
                for round in 0..<3 {
                    try sendBytes(file: file, size: size, session: &current, openBody: openBody, progress: progress)
                    do {
                        let tid = try complete(sessionId: current.id)
                        rlog("upload: \(file.lastPathComponent) done via \(current.via) in \(Int(Date().timeIntervalSince(t0))) s → \(tid ?? "?")")
                        return .success(tid)
                    } catch StepError.notCommitted where round < 2 {
                        rlog("upload: \(file.lastPathComponent) — blob not committed yet, re-syncing blocks")
                        current = try openSession(openBody(), label: file.lastPathComponent)
                    } catch StepError.missingChunks where round < 2 {
                        rlog("upload: \(file.lastPathComponent) — chunks missing, re-syncing")
                        current = try openSession(openBody(), label: file.lastPathComponent)
                    }
                }
                return .failure("bytes kept going missing between send and complete")
            } catch StepError.sessionGone(let why) where restarts < 1 {
                restarts += 1
                rlog("upload: \(file.lastPathComponent) session gone (\(why)) — starting over")
                continue
            } catch StepError.sessionGone(let why) {
                return .failure("upload session expired (\(why))")
            } catch StepError.giveUp(let why) {
                return .failure(why)
            } catch StepError.http(let e) {
                return .failure(e.code == 0 ? e.message : "HTTP \(e.code): \(e.message)")
            } catch {
                return .failure(error.localizedDescription)
            }
        }
    }

    // MARK: open

    private func openSession(_ body: [String: Any], label: String) throws -> Session {
        var attempt = 0
        while true {
            attempt += 1
            do {
                let (code, json) = try self.json("POST", "/api/uploads", body: body)
                guard (200..<300).contains(code), let j = json, let id = j["id"] as? String else {
                    let msg = (json?["error"] as? String) ?? "HTTP \(code)"
                    if code == 404 { throw StepError.giveUp(msg) }        // e.g. recorder row not ours
                    if (400..<500).contains(code) && code != 429 { throw StepError.giveUp("open rejected: \(msg)") }
                    throw HttpError(code: code, message: msg, json: json)
                }
                var ticket: BlobTicket?
                if (j["via"] as? String) == "blob", let b = j["blob"] as? [String: Any],
                   let sas = (b["sasUrl"] as? String).flatMap(URL.init(string:)),
                   let bb = b["blockBytes"] as? Int, let par = b["parallel"] as? Int,
                   let exp = (b["expiresAt"] as? String).flatMap(Self.iso.date(from:)) {
                    ticket = BlobTicket(sasUrl: sas, blockBytes: bb, parallel: max(1, par), expiresAt: exp)
                }
                return Session(
                    id: id,
                    via: ticket != nil ? "blob" : "chunks",
                    resumed: (j["resumed"] as? Bool) ?? false,
                    chunkSize: (j["chunkSize"] as? Int) ?? 0,
                    chunkCount: (j["chunkCount"] as? Int) ?? 0,
                    received: Set((j["received"] as? [Int]) ?? []),
                    blob: ticket,
                    placeholderId: (j["transcript"] as? [String: Any])?["assemblyai_id"] as? String
                )
            } catch let e as HttpError {
                if attempt >= 8 { throw StepError.http(e) }
                rlog("upload: open \(label) failed (\(e.message)) — retry \(attempt)")
                Thread.sleep(forTimeInterval: min(15, pow(2, Double(attempt - 1))))
            }
        }
    }

    // MARK: bytes

    private func sendBytes(file: URL, size: Int, session: inout Session, openBody: () -> [String: Any],
                           progress: @escaping (Int64) -> Void) throws {
        let started = Date()
        var attempt = 0
        while true {
            do {
                if let ticket = session.blob {
                    var t = ticket
                    if t.expiresAt <= Date() {
                        session = try openSession(openBody(), label: file.lastPathComponent)
                        guard let fresh = session.blob else { throw StepError.sessionGone("blob path withdrawn") }
                        t = fresh
                    }
                    try sendBlocks(file: file, size: size, ticket: t, progress: progress)
                } else {
                    try sendChunks(file: file, size: size, session: session, progress: progress)
                }
                return
            } catch StepError.sessionGone(let why) {
                throw StepError.sessionGone(why)
            } catch StepError.giveUp(let why) {
                throw StepError.giveUp(why)
            } catch {
                attempt += 1
                let why = (error as? HttpError)?.message ?? error.localizedDescription
                if Date().timeIntervalSince(started) > Self.resumeWindow {
                    throw StepError.giveUp("gave up after \(attempt) attempts in \(Int(Self.resumeWindow / 60)) min — last: \(why); the next retry resumes where it stopped")
                }
                let wait = Self.backoffS[min(attempt, Self.backoffS.count) - 1]
                rlog("upload: \(file.lastPathComponent) hiccup (\(why)) — attempt \(attempt + 1) in \(Int(wait)) s")
                Thread.sleep(forTimeInterval: wait)
                // A dead SAS (401/403) → the same blob with a fresh signature.
                if let e = error as? HttpError, e.code == 401 || e.code == 403, session.blob != nil {
                    session = try openSession(openBody(), label: file.lastPathComponent)
                }
            }
        }
    }

    /// Blob path: HEAD (committed already?) → uncommitted block list → PUT the missing blocks,
    /// `parallel` at a time → Put Block List. Throws HttpError on any blob failure.
    private func sendBlocks(file: URL, size: Int, ticket: BlobTicket, progress: @escaping (Int64) -> Void) throws {
        let blocks = stride(from: 0, to: size, by: ticket.blockBytes).enumerated().map { (i, start) in
            (index: i, start: start, end: min(size, start + ticket.blockBytes))
        }
        let ids = blocks.map { Self.blockId($0.index) }

        // Committed already? Straight to complete.
        let head = try blobCall("HEAD", ticket.sasUrl, query: [:], body: nil, contentType: nil)
        if head.code == 200, let len = head.headers["Content-Length"].flatMap({ Int($0) }), len == size {
            progress(Int64(size)); return
        }
        if head.code == 401 || head.code == 403 { throw HttpError(code: head.code, message: "the upload link expired", json: nil) }

        // What Azure holds.
        let listed = try blobCall("GET", ticket.sasUrl, query: ["comp": "blocklist", "blocklisttype": "uncommitted"], body: nil, contentType: nil)
        var have: [String: Int] = [:]
        if listed.code == 200 { have = Self.parseUncommitted(String(data: listed.body, encoding: .utf8) ?? "") }
        else if listed.code == 401 || listed.code == 403 { throw HttpError(code: listed.code, message: "the upload link expired", json: nil) }
        else if listed.code != 404 { throw HttpError(code: listed.code, message: "block list failed (\(listed.code))", json: nil) }
        var acked = 0
        var pending: [(index: Int, start: Int, end: Int)] = []
        for b in blocks {
            if have[ids[b.index]] == b.end - b.start { acked += b.end - b.start } else { pending.append(b) }
        }
        if acked > 0 { rlog("upload: \(file.lastPathComponent) — Azure already holds \(acked) of \(size) bytes (\(acked * 100 / max(1, size))%)") }
        progress(Int64(acked))

        // Parallel PUTs.
        let group = DispatchGroup()
        let gate = DispatchSemaphore(value: ticket.parallel)
        let state = NSLock()
        var failure: HttpError?
        var ackedShared = acked
        guard let fh = try? FileHandle(forReadingFrom: file) else { throw HttpError(code: 0, message: "could not open the file", json: nil) }
        defer { try? fh.close() }
        for b in pending {
            state.lock(); let stop = failure != nil; state.unlock()
            if stop { break }
            gate.wait()
            // Read on the calling thread (one FileHandle, sequential seeks); send in parallel.
            let data: Data
            do {
                try fh.seek(toOffset: UInt64(b.start))
                data = try fh.read(upToCount: b.end - b.start) ?? Data()
            } catch {
                gate.signal()
                throw HttpError(code: 0, message: "read failed at \(b.start): \(error.localizedDescription)", json: nil)
            }
            guard data.count == b.end - b.start else {
                gate.signal()
                throw HttpError(code: 0, message: "short read at \(b.start) (\(data.count) of \(b.end - b.start))", json: nil)
            }
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { gate.signal(); group.leave() }
                let r = try? self.blobCall("PUT", ticket.sasUrl, query: ["comp": "block", "blockid": ids[b.index]],
                                           body: data, contentType: "application/octet-stream", timeout: Self.blockTimeout)
                state.lock()
                if let r, (200..<300).contains(r.code) {
                    ackedShared += b.end - b.start
                    let now = ackedShared
                    state.unlock()
                    progress(Int64(now))
                } else {
                    if failure == nil {
                        failure = HttpError(code: r?.code ?? 0, message: "block \(b.index + 1)/\(blocks.count) failed (\(r.map { String($0.code) } ?? "network"))", json: nil)
                    }
                    state.unlock()
                }
            }
        }
        group.wait()
        if let failure { throw failure }

        // Commit.
        let xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><BlockList>" + ids.map { "<Latest>\($0)</Latest>" }.joined() + "</BlockList>"
        let contentType = file.pathExtension.lowercased() == "m4a" ? "audio/mp4" : "video/mp4"
        let commit = try blobCall("PUT", ticket.sasUrl, query: ["comp": "blocklist"], body: Data(xml.utf8),
                                  contentType: "application/xml", extraHeaders: ["x-ms-blob-content-type": contentType])
        guard (200..<300).contains(commit.code) else { throw HttpError(code: commit.code, message: "commit failed (\(commit.code))", json: nil) }
        progress(Int64(size))
    }

    /// Chunk path (a host without the blob account): PUT the chunks the server does not have,
    /// 4 at a time, each with its sha256; 404/410 = the session is gone.
    private func sendChunks(file: URL, size: Int, session: Session, progress: @escaping (Int64) -> Void) throws {
        guard session.chunkSize > 0, session.chunkCount > 0 else { throw StepError.giveUp("open reply without a chunk plan") }
        var acked = 0
        for i in session.received { acked += Self.chunkRange(size, session.chunkSize, i).length }
        if acked > 0 { rlog("upload: \(file.lastPathComponent) — server already holds \(acked) of \(size) bytes") }
        progress(Int64(acked))
        let pending = (0..<session.chunkCount).filter { !session.received.contains($0) }
        let group = DispatchGroup()
        let gate = DispatchSemaphore(value: 4)
        let state = NSLock()
        var failure: Error?
        var ackedShared = acked
        guard let fh = try? FileHandle(forReadingFrom: file) else { throw HttpError(code: 0, message: "could not open the file", json: nil) }
        defer { try? fh.close() }
        for idx in pending {
            state.lock(); let stop = failure != nil; state.unlock()
            if stop { break }
            gate.wait()
            let r = Self.chunkRange(size, session.chunkSize, idx)
            let data: Data
            do {
                try fh.seek(toOffset: UInt64(r.start))
                data = try fh.read(upToCount: r.length) ?? Data()
            } catch {
                gate.signal()
                throw HttpError(code: 0, message: "read failed at \(r.start): \(error.localizedDescription)", json: nil)
            }
            let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                defer { gate.signal(); group.leave() }
                let res = try? self.raw("PUT", "/api/uploads/\(session.id)/chunks/\(idx)", body: data,
                                        contentType: "application/octet-stream",
                                        extraHeaders: ["x-chunk-sha256": sha], timeout: Self.blockTimeout)
                state.lock()
                if let res, (200..<300).contains(res.code) {
                    ackedShared += r.length
                    let now = ackedShared
                    state.unlock()
                    progress(Int64(now))
                } else {
                    if failure == nil {
                        if let res, res.code == 404 || res.code == 410 { failure = StepError.sessionGone("chunk \(idx) → \(res.code)") }
                        else { failure = HttpError(code: res?.code ?? 0, message: "chunk \(idx + 1)/\(session.chunkCount) failed (\(res.map { String($0.code) } ?? "network"))", json: nil) }
                    }
                    state.unlock()
                }
            }
        }
        group.wait()
        if let failure { throw failure }
    }

    // MARK: complete

    /// POST …/complete → the transcript id. 409 notCommitted / missing → re-sync; 409
    /// completing → poll the session; 503 → the VM's pull hiccuped, try again; 404/410 → gone.
    private func complete(sessionId: String) throws -> String? {
        var attempt = 0
        while true {
            attempt += 1
            let (code, json): (Int, [String: Any]?)
            do {
                (code, json) = try self.json("POST", "/api/uploads/\(sessionId)/complete", body: nil, timeout: 900)
            } catch let e as HttpError {
                // Transport dropped while the server may still be finalising: poll.
                rlog("upload: complete \(sessionId) transport error (\(e.message)) — polling the session")
                if let tid = try pollSession(sessionId) { return tid }
                if attempt >= 20 { throw StepError.giveUp("could not finalise the upload") }
                Thread.sleep(forTimeInterval: min(15, pow(2, Double(min(attempt, 4)))))
                continue
            }
            if (200..<300).contains(code) {
                let t = json?["transcript"] as? [String: Any]
                return (t?["assemblyai_id"] as? String) ?? (json?["transcriptId"] as? String)
            }
            let msg = (json?["error"] as? String) ?? "HTTP \(code)"
            switch code {
            case 409 where (json?["notCommitted"] as? Bool) == true: throw StepError.notCommitted
            case 409 where json?["missing"] != nil: throw StepError.missingChunks
            case 409 where (json?["status"] as? String) == "completing":
                if let tid = try pollSession(sessionId) { return tid }
                if attempt >= 20 { throw StepError.giveUp("could not finalise the upload") }
                Thread.sleep(forTimeInterval: 3)
            case 503:
                if attempt >= 20 { throw StepError.giveUp("transfer from blob storage kept failing: \(msg)") }
                rlog("upload: complete \(sessionId) — \(msg) (attempt \(attempt))")
                Thread.sleep(forTimeInterval: min(30, 5 * Double(attempt)))
            case 404, 410: throw StepError.sessionGone(msg)
            case 400..<500: throw StepError.giveUp(msg)
            default: throw StepError.giveUp("finalise failed: \(msg)")  // 502 = AAI/stitch failed, server tore down
            }
        }
    }

    /// GET …/uploads/:id until done/failed (the AAI hand-off can take minutes). Returns the
    /// transcript id when done; nil when the session is still open (our complete never landed).
    private func pollSession(_ id: String) throws -> String? {
        for _ in 0..<400 {
            Thread.sleep(forTimeInterval: 3)
            guard let (code, json) = try? self.json("GET", "/api/uploads/\(id)", body: nil) else { continue }
            if code == 404 { throw StepError.sessionGone("session vanished") }
            guard code == 200, let j = json else { continue }
            switch j["status"] as? String {
            case "done": return (j["transcriptId"] as? String) ?? ""
            case "failed": throw StepError.giveUp((j["error"] as? String) ?? "upload failed on the server")
            case "open": return nil
            default: continue  // completing
            }
        }
        throw StepError.giveUp("finalise did not finish")
    }

    // MARK: - HTTP primitives (synchronous)

    private struct Raw { let code: Int; let body: Data; let headers: [String: String] }

    /// Same-origin JSON call with the bearer. Throws HttpError only on transport failure; the
    /// caller reads the status.
    private func json(_ method: String, _ path: String, body: [String: Any]?, timeout: TimeInterval = 60) throws -> (Int, [String: Any]?) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let r = try raw(method, path, body: data, contentType: body != nil ? "application/json" : nil, extraHeaders: [:], timeout: timeout)
        let json = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any]
        return (r.code, json ?? nil)
    }

    private func raw(_ method: String, _ path: String, body: Data?, contentType: String?,
                     extraHeaders: [String: String], timeout: TimeInterval) throws -> Raw {
        guard let token = api.token() else { throw HttpError(code: 0, message: "not signed in", json: nil) }
        guard let url = URL(string: path, relativeTo: api.baseURL) else { throw HttpError(code: 0, message: "bad url", json: nil) }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("DarthRecorder/\(api.appVersion)", forHTTPHeaderField: "user-agent")
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
        for (k, v) in extraHeaders { req.setValue(v, forHTTPHeaderField: k) }
        return try perform(req, body: body)
    }

    /// A cross-origin blob call: the SAS is the credential, no bearer.
    private func blobCall(_ method: String, _ sasUrl: URL, query: [String: String], body: Data?, contentType: String?,
                          extraHeaders: [String: String] = [:], timeout: TimeInterval = 60) throws -> Raw {
        // Append the query as a RAW string. URLComponents.queryItems decodes and re-encodes the
        // existing SAS query, and `+` is legal in a query so a signature's `%2B` comes back as `+`
        // — which Azure reads as a space: 403 "the upload link expired" on every call whose
        // signature contained one (the 1.3 GB Meet file, 2026-09-18 23:07, while the Teams file
        // next to it worked). Block ids are base64 and hit the same trap.
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let extra = query.map { k, v in "\(k)=\(v.addingPercentEncoding(withAllowedCharacters: allowed) ?? v)" }.joined(separator: "&")
        let joined = sasUrl.absoluteString + (sasUrl.query == nil ? "?" : "&") + extra
        guard let url = URL(string: joined) else { throw HttpError(code: 0, message: "bad blob url", json: nil) }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
        for (k, v) in extraHeaders { req.setValue(v, forHTTPHeaderField: k) }
        return try perform(req, body: body)
    }

    private func perform(_ req: URLRequest, body: Data?) throws -> Raw {
        let sem = DispatchSemaphore(value: 0)
        var out: Raw?
        var failure: Error?
        let handler: (Data?, URLResponse?, Error?) -> Void = { data, resp, err in
            defer { sem.signal() }
            if let err { failure = err; return }
            let http = resp as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k)] = String(describing: v) }
            out = Raw(code: http?.statusCode ?? 0, body: data ?? Data(), headers: headers)
        }
        let task: URLSessionTask
        if let body, req.httpMethod == "PUT" || req.httpMethod == "POST" {
            task = session.uploadTask(with: req, from: body, completionHandler: handler)
        } else {
            task = session.dataTask(with: req, completionHandler: handler)
        }
        task.resume()
        sem.wait()
        if let failure { throw HttpError(code: 0, message: failure.localizedDescription, json: nil) }
        return out!
    }

    // MARK: - helpers

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Streaming SHA-256 of a file (8 MiB reads).
    static func sha256(of file: URL) -> String? {
        guard let fh = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? fh.close() }
        var h = SHA256()
        while let d = try? fh.read(upToCount: 8 * 1024 * 1024), !d.isEmpty { h.update(data: d) }
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Block id of block `index`: the zero-padded decimal in base64 — every id the same length.
    static func blockId(_ index: Int) -> String {
        Data(String(format: "%06d", index).utf8).base64EncodedString()
    }

    /// `<Name>…</Name><Size>…</Size>` pairs under `<UncommittedBlocks>`.
    static func parseUncommitted(_ xml: String) -> [String: Int] {
        var out: [String: Int] = [:]
        guard let a = xml.range(of: "<UncommittedBlocks>"), let b = xml.range(of: "</UncommittedBlocks>"), a.upperBound <= b.lowerBound else { return out }
        let section = xml[a.upperBound..<b.lowerBound]
        let re = try! NSRegularExpression(pattern: "<Block>\\s*<Name>([^<]*)</Name>\\s*<Size>(\\d+)</Size>\\s*</Block>")
        let s = String(section)
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            if let n = Range(m.range(at: 1), in: s), let z = Range(m.range(at: 2), in: s) { out[String(s[n])] = Int(s[z]) }
        }
        return out
    }

    static func chunkRange(_ size: Int, _ chunkSize: Int, _ idx: Int) -> (start: Int, end: Int, length: Int) {
        let start = idx * chunkSize
        let end = min(size, start + chunkSize)
        return (start, end, end - start)
    }

    // URLSessionTaskDelegate (kept for the delegate-queue session; progress is reported per
    // acknowledged block/chunk instead of per byte in flight).
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        lock.lock()
        let cb = progressByTask[task.taskIdentifier]
        lock.unlock()
        cb?(totalBytesSent)
    }
}
