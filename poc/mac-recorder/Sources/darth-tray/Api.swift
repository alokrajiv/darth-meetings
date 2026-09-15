import Foundation
import RecorderCore

/// Everything the tray says to the Darth Meetings server. Every call is FAIL-SOFT: a failure
/// is logged (throttled), the local state keeps the truth, and the next sweep retries. A
/// recording never waits on the network.
///
/// Base URL `https://meetings.darth-internal.trames.io`, override `DARTH_TRAY_API_URL`.
/// Auth is the `dth_` token from the device flow (`Auth`), sent as `Authorization: Bearer`.
///
/// Endpoints (contract: docs/recorder-beta-plan.md, Stream S1):
///   POST  /api/recorder/heartbeat            {device_id, hostname, os, app_version, status}
///   POST  /api/recorder/events               {device_id, events:[{ts,kind,payload}…]}   ≤500
///   POST  /api/recorder/recordings           {id, device_id, started_at, call, …}  (upsert)
///   PATCH /api/recorder/recordings/:id       partial update
///   POST  /api/transcripts                   the one-shot upload darth-cli uses
final class ApiClient {
    let baseURL: URL
    let appVersion: String
    var token: () -> String? = { nil }
    var deviceId: String = ""
    /// Snapshot included in the heartbeat.
    var statusProvider: () -> [String: Any] = { [:] }

    private var heartbeatConfirmed = false
    private var eventsConfirmed = false
    private var lastLogged: [String: Date] = [:]
    private let logLock = NSLock()
    private var timers: [Timer] = []

    init(appVersion: String) {
        self.appVersion = appVersion
        let env = ProcessInfo.processInfo.environment
        baseURL = env["DARTH_TRAY_API_URL"].flatMap { URL(string: $0) } ?? URL(string: "https://meetings.darth-internal.trames.io")!
    }

    // MARK: schedule

    /// Heartbeat now + every 5 min; telemetry every 60 s; registry re-sync every 60 s.
    func start() {
        rlog("api: base \(baseURL.absoluteString), device_id \(deviceId)")
        heartbeat()
        let hb = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in self?.heartbeat() }
        let tel = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.shipEvents() }
        let sync = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.syncPending() }
        for t in [hb, tel, sync] { t.tolerance = 5 }
        timers = [hb, tel, sync]
    }

    private func throttledLog(_ key: String, _ message: String) {
        logLock.lock()
        let last = lastLogged[key]
        let quiet = last.map { Date().timeIntervalSince($0) < 300 } ?? false
        if !quiet { lastLogged[key] = Date() }
        logLock.unlock()
        if !quiet { rlog(message) }
    }

    // MARK: primitives

    private func request(_ method: String, _ path: String, body: [String: Any]?) -> URLRequest? {
        guard let token = token() else { return nil }
        guard let url = URL(string: path, relativeTo: baseURL) else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("DarthRecorder/\(appVersion)", forHTTPHeaderField: "user-agent")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    /// `done(ok, json)` on the main queue. Never throws, never blocks the caller.
    private func send(_ method: String, _ path: String, body: [String: Any]?, label: String,
                      done: ((Bool, [String: Any]?) -> Void)? = nil) {
        guard let req = request(method, path, body: body) else {
            throttledLog("\(label)-noauth", "api: \(label) skipped — not signed in")
            DispatchQueue.main.async { done?(false, nil) }
            return
        }
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let ok = err == nil && (200..<300).contains(code)
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil
            if !ok {
                let why = err?.localizedDescription ?? "HTTP \(code)"
                self?.throttledLog("\(label)-\(code)", "api: \(label) failed — \(why) (will retry later)")
            }
            DispatchQueue.main.async { done?(ok, json) }
        }.resume()
    }

    // MARK: endpoints

    func heartbeat() {
        var status = statusProvider()
        status["pending_upload"] = Registry.shared.pendingUpload().count
        let body: [String: Any] = [
            "device_id": deviceId,
            "hostname": Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            "os": "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "app_version": appVersion,
            "status": status,
        ]
        send("POST", "/api/recorder/heartbeat", body: body, label: "heartbeat") { ok, json in
            guard ok else { return }
            if !self.heartbeatConfirmed {
                self.heartbeatConfirmed = true
                let dev = json?["device"] as? [String: Any]
                rlog("api: registered with \(self.baseURL.host ?? "the server") as device \(self.deviceId)\((dev?["email"] as? String).map { " (\($0))" } ?? "")")
            }
            if let min = json?["min_app_version"] as? String, Updater.compare(min, self.appVersion) > 0 {
                rlog("api: server wants at least \(min), we are \(self.appVersion)")
            }
        }
    }

    /// Ship unshipped events.jsonl lines. Called every 60 s and at recording stop.
    func shipEvents() {
        guard token() != nil else { return }
        guard let batch = EventLog.shared.takeBatch(max: 500) else { return }
        let body: [String: Any] = ["device_id": deviceId, "events": batch.events]
        send("POST", "/api/recorder/events", body: body, label: "events") { ok, json in
            guard ok else { return }
            EventLog.shared.commit(batch.endOffset)
            if !self.eventsConfirmed {
                self.eventsConfirmed = true
                rlog("api: telemetry accepted (\(json?["accepted"] ?? batch.events.count) events in the first batch)")
            }
            // Drain quickly when a backlog built up while we were offline.
            if EventLog.shared.unshippedBytes > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.shipEvents() }
            }
        }
    }

    /// Upsert a recording row. `insert` uses POST (the create in the contract); updates use
    /// PATCH and fall back to a full POST on the next sweep if they fail.
    func syncRecording(_ id: String, insert: Bool = false) {
        guard let row = Registry.shared.get(id) else { return }
        let body = Registry.serverBody(row, deviceId: deviceId)
        let method = insert ? "POST" : "PATCH"
        let path = insert ? "/api/recorder/recordings" : "/api/recorder/recordings/\(id)"
        send(method, path, body: body, label: "recordings-\(method.lowercased())") { ok, json in
            if ok {
                Registry.shared.update(id, ["needs_sync": false])
                // The server answers {recording:{… matched …}} (it re-runs matchRecording on
                // every write); older/plainer shapes may put `matched` at the top level.
                let rec = json?["recording"] as? [String: Any]
                if let matched = (rec?["matched"] ?? json?["matched"]) as? [String: Any], !matched.isEmpty {
                    Registry.shared.update(id, ["matched": matched])
                }
            } else {
                Registry.shared.update(id, ["needs_sync": true])
            }
        }
    }

    /// Re-POST every row the server has not confirmed (upsert by id).
    func syncPending() {
        let rows = Registry.shared.needingSync()
        guard !rows.isEmpty, token() != nil else { return }
        rlog("api: re-syncing \(rows.count) recording row(s)")
        for row in rows {
            guard let id = row["id"] as? String else { continue }
            syncRecording(id, insert: true)
        }
    }
}

/// One-shot uploads to `POST /api/transcripts` — the same route darth-cli's
/// `meetings upload` uses (raw body, `x-filename`, optional `x-linked-event`). A
/// multi-segment recording goes up as ONE multi-file stitch group
/// (`multi_group`/`multi_index`/`multi_total`), exactly like the web multi-file upload, so the
/// server stitches it into a single transcript. `recorderRecordingId` links the transcript
/// back to `recorder_recordings`.
final class Uploader: NSObject, URLSessionTaskDelegate {
    private let api: ApiClient
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 600
        cfg.timeoutIntervalForResource = 6 * 3600
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
            // A failed writer leaves 0-byte segments; the one-shot route answers "Empty request
            // body" and we would retry that forever.
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
                let result = self.putOne(file: file, recordingId: id, linkedEvent: linkedEvent,
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

    /// Synchronous (runs on a utility queue): stream one file up, return the transcript id.
    private func putOne(file: URL, recordingId: String, linkedEvent: [String: Any]?,
                        group: String?, index: Int, total: Int,
                        progress: @escaping (Int64) -> Void) -> PutResult {
        var comps = URLComponents(url: api.baseURL.appendingPathComponent("/api/transcripts"), resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "recorderRecordingId", value: recordingId)]
        if let group {
            items.append(URLQueryItem(name: "multi_group", value: group))
            items.append(URLQueryItem(name: "multi_index", value: String(index)))
            items.append(URLQueryItem(name: "multi_total", value: String(total)))
        }
        comps?.queryItems = items
        guard let url = comps?.url, let token = api.token() else { return .failure("not signed in") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("video/mp4", forHTTPHeaderField: "content-type")
        req.setValue(pctEncode(file.lastPathComponent), forHTTPHeaderField: "x-filename")
        if let linkedEvent, let d = try? JSONSerialization.data(withJSONObject: linkedEvent),
           let s = String(data: d, encoding: .utf8) {
            req.setValue(pctEncode(s), forHTTPHeaderField: "x-linked-event")
        }
        if total > 1 {
            req.setValue(pctEncode("Darth Recorder segment \(index) of \(total)"), forHTTPHeaderField: "x-part-comment")
        }

        let sem = DispatchSemaphore(value: 0)
        var outcome: PutResult = .failure("upload did not run")
        let task = session.uploadTask(with: req, fromFile: file) { data, resp, err in
            defer { sem.signal() }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if let err { outcome = .failure(err.localizedDescription); return }
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil
            guard (200..<300).contains(code) else {
                let detail = (json?["error"] as? String) ?? String(data: data?.prefix(200) ?? Data(), encoding: .utf8) ?? ""
                outcome = .failure("HTTP \(code)\(detail.isEmpty ? "" : ": \(detail)")")
                return
            }
            let t = json?["transcript"] as? [String: Any]
            outcome = .success((t?["assemblyai_id"] as? String) ?? (json?["assemblyaiId"] as? String))
        }
        lock.lock(); progressByTask[task.taskIdentifier] = progress; lock.unlock()
        task.resume()
        sem.wait()
        lock.lock(); progressByTask.removeValue(forKey: task.taskIdentifier); lock.unlock()
        return outcome
    }

    private func pctEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        lock.lock()
        let cb = progressByTask[task.taskIdentifier]
        lock.unlock()
        cb?(totalBytesSent)
    }
}
