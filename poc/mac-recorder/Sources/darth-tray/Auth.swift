import AppKit
import RecorderCore

/// Darth device flow — the same one darth-cli uses (`darth/cli/src/core/login.ts`):
/// `POST /api/device/start` → open `verifyUrl` in the browser with a short user code →
/// poll `POST /api/device/poll` until the human approves → a `dth_` token.
///
/// The token (plus email / expiry) lives in
/// `~/Library/Application Support/DarthRecorder/auth.json`, mode 0600. The device id is a
/// UUID minted once and kept next to it; it identifies this Mac to the server across
/// sign-outs and reinstalls.
final class Auth {
    struct Session {
        let token: String
        let email: String
        let userId: String
        let expiresAt: Date?
        var expired: Bool { expiresAt.map { $0 < Date() } ?? false }
    }

    private(set) var session: Session?
    private(set) var deviceId: String = ""
    private(set) var signingIn = false
    /// Main queue. Fired when the session or the sign-in state changes.
    var onChange: (() -> Void)?
    /// Main queue. (title, subtitle) for the banner during the flow.
    var onPrompt: ((String, String, URL?) -> Void)?

    let authURL: URL
    private let appVersion: String
    private var pollTimer: Timer?

    init(appVersion: String) {
        self.appVersion = appVersion
        let env = ProcessInfo.processInfo.environment
        authURL = env["DARTH_AUTH_URL"].flatMap { URL(string: $0) } ?? URL(string: "https://auth.darth-internal.trames.io")!
        deviceId = Auth.loadOrMintDeviceId()
        load()
    }

    var signedIn: Bool { session != nil && !(session?.expired ?? true) }
    var email: String? { session?.email }
    var token: String? { signedIn ? session?.token : nil }

    // MARK: disk

    private static func loadOrMintDeviceId() -> String {
        if let d = try? Data(contentsOf: Paths.device),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let id = o["device_id"] as? String, !id.isEmpty { return id }
        let id = UUID().uuidString
        if let d = try? JSONSerialization.data(withJSONObject: ["device_id": id, "created_at": isoNow()], options: [.prettyPrinted]) {
            try? d.write(to: Paths.device, options: .atomic)
        }
        rlog("auth: minted device_id \(id)")
        return id
    }

    private func load() {
        guard let d = try? Data(contentsOf: Paths.auth),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let token = o["token"] as? String, token.hasPrefix("dth_") else { return }
        let exp = (o["expiresAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
            ?? (o["expiresAt"] as? String).flatMap { d -> Date? in
                let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: d)
            }
        session = Session(token: token, email: (o["email"] as? String) ?? "?", userId: (o["userId"] as? String) ?? "", expiresAt: exp)
        rlog("auth: signed in as \(session?.email ?? "?")\(session?.expired == true ? " (TOKEN EXPIRED — sign in again)" : "")")
    }

    private func save(token: String, email: String, userId: String, expiresAt: String?, scopes: Any?) {
        var obj: [String: Any] = ["token": token, "email": email, "userId": userId, "savedAt": isoNow()]
        if let expiresAt { obj["expiresAt"] = expiresAt }
        if let scopes { obj["scopes"] = scopes }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else { return }
        try? d.write(to: Paths.auth, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.auth.path)
    }

    // MARK: flow

    func signIn() {
        guard !signingIn else { rlog("auth: sign-in already in progress"); return }
        signingIn = true
        onChange?()
        EventLog.shared.log("auth_signin_started", ["auth_url": authURL.absoluteString], summary: "auth: starting device flow at \(authURL.absoluteString)")
        var req = URLRequest(url: authURL.appendingPathComponent("/api/device/start"), timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("DarthRecorder/\(appVersion)", forHTTPHeaderField: "user-agent")
        let body: [String: Any] = [
            "host": Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            "os": "darwin \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "cliVersion": "darth-recorder/\(appVersion)",
            "requested": ["meetings": "readwrite"],
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard err == nil, (200..<300).contains(code), let data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let deviceCode = o["deviceCode"] as? String, let userCode = o["userCode"] as? String,
                  let verify = (o["verifyUrl"] as? String).flatMap({ URL(string: $0) })
            else {
                DispatchQueue.main.async {
                    self.signingIn = false
                    self.onChange?()
                    let msg = err?.localizedDescription ?? "HTTP \(code)"
                    EventLog.shared.log("auth_signin_failed", ["error": msg], summary: "auth: device/start failed — \(msg)")
                    self.onPrompt?("Sign-in could not start", "\(self.authURL.host ?? "darth-auth") unreachable (\(msg)) — are you on the Trames Tailnet?", nil)
                }
                return
            }
            let interval = (o["interval"] as? Double) ?? 3
            let expiresIn = (o["expiresIn"] as? Double) ?? 600
            DispatchQueue.main.async {
                EventLog.shared.log("auth_signin_prompt", ["user_code": userCode, "verify_url": verify.absoluteString],
                                    summary: "auth: approve in the browser — code \(userCode) at \(verify.absoluteString)")
                NSWorkspace.shared.open(verify)
                self.onPrompt?("Approve Darth Recorder in your browser", "Confirm the code \(userCode) — the page should already be open.", verify)
                self.startPolling(deviceCode: deviceCode, interval: max(2, interval), deadline: Date().addingTimeInterval(expiresIn))
            }
        }.resume()
    }

    private func startPolling(deviceCode: String, interval: TimeInterval, deadline: Date) {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] t in
            guard let self else { t.invalidate(); return }
            if Date() > deadline {
                t.invalidate()
                self.signingIn = false
                self.onChange?()
                EventLog.shared.log("auth_signin_timeout", [:], summary: "auth: sign-in timed out waiting for browser approval")
                self.onPrompt?("Sign-in timed out", "Nobody approved it in the browser. Try “Sign in to Darth Meetings…” again.", nil)
                return
            }
            self.pollOnce(deviceCode: deviceCode) { status, data in
                switch status {
                case "pending", "error": return
                case "approved":
                    t.invalidate()
                    let user = data?["user"] as? [String: Any]
                    let token = (data?["token"] as? String) ?? ""
                    let email = (user?["email"] as? String) ?? "?"
                    let userId = (user?["userId"] as? String) ?? ""
                    let exp = data?["expiresAt"] as? String
                    guard token.hasPrefix("dth_") else {
                        self.signingIn = false; self.onChange?()
                        EventLog.shared.log("auth_signin_failed", ["error": "no token in approval"], summary: "auth: approval carried no dth_ token")
                        return
                    }
                    self.save(token: token, email: email, userId: userId, expiresAt: exp, scopes: data?["scopes"])
                    self.session = Session(token: token, email: email, userId: userId,
                                           expiresAt: exp.flatMap { ISO8601DateFormatter().date(from: $0) })
                    self.signingIn = false
                    self.onChange?()
                    EventLog.shared.log("auth_signed_in", ["email": email, "expires_at": exp ?? ""], summary: "auth: signed in as \(email)")
                    self.onPrompt?("Signed in as \(email)", "Recordings from this Mac will upload to Darth Meetings.", nil)
                default:
                    t.invalidate()
                    self.signingIn = false
                    self.onChange?()
                    EventLog.shared.log("auth_signin_failed", ["status": status], summary: "auth: sign-in \(status)")
                    self.onPrompt?("Sign-in \(status)", "Try “Sign in to Darth Meetings…” again.", nil)
                }
            }
        }
        pollTimer?.tolerance = 0.5
    }

    private func pollOnce(deviceCode: String, done: @escaping (String, [String: Any]?) -> Void) {
        var req = URLRequest(url: authURL.appendingPathComponent("/api/device/poll"), timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceCode": deviceCode])
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? nil
            let status = (obj?["status"] as? String) ?? (code == 0 ? "error" : "error")
            DispatchQueue.main.async { done(status, obj) }
        }.resume()
    }

    func signOut() {
        let old = session
        session = nil
        try? FileManager.default.removeItem(at: Paths.auth)
        onChange?()
        EventLog.shared.log("auth_signed_out", ["email": old?.email ?? ""], summary: "auth: signed out \(old?.email ?? "")")
        guard let token = old?.token else { return }
        var req = URLRequest(url: authURL.appendingPathComponent("/api/revoke-self"), timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            rlog("auth: revoke-self → HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
        }.resume()
    }
}
