import Foundation
import RecorderCore

/// The post-recording echo cleanup, as the tray runs it (0.3.24): every part of a recording
/// that just stopped goes through `EchoCleanup.run` on a utility-priority task, in order,
/// BEFORE the upload starts. Progress and the per-part verdicts land in the registry row
/// (`echo_cleanup`), in `events.jsonl` (`echo_cleanup` events, telemetry) and in tray.log.
///
/// What it never does: run while recording, run twice on a part (`EchoCleanup` reports
/// `already cleaned`), touch a part whose rewrite did not verify (the original stays), or
/// hold up a quit (`recordingStopped` skips it when the app is terminating — those parts go
/// up raw at the next launch, like any other pending upload).
final class EchoCleanupStage {
    static let shared = EchoCleanupStage()
    private(set) var running: Set<String> = []

    /// Preference (default ON). Off = recordings upload exactly as captured.
    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "echoCleanup") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "echoCleanup") }
    }

    var statusJSON: [String: Any] {
        ["enabled": enabled, "running": Array(running).sorted()]
    }

    /// Clean every file of `id`; `completion` is called on the main queue with one report per
    /// part, in part order, once all are done (never before `completion` — the upload hashes
    /// the files and must see their final bytes).
    func run(recordingId id: String, files: [String], completion: @escaping ([[String: Any]]) -> Void) {
        guard !files.isEmpty, !running.contains(id) else { completion([]); return }
        running.insert(id)
        let startedAt = Date()
        Registry.shared.update(id, ["echo_cleanup": ["status": "running", "started_at": isoNow()]])
        Task.detached(priority: .utility) {
            var collected: [[String: Any]] = []
            for (i, path) in files.enumerated() {
                var opts = EchoCleanup.Options()
                opts.log = { rlog($0) }
                var r = await EchoCleanup.run(file: URL(fileURLWithPath: path), options: opts)
                r["recording_id"] = id
                r["segment"] = i + 1
                collected.append(r)
                let outcome = r["outcome"] as? String ?? "?"
                let summary: String
                switch outcome {
                case "cleaned":
                    summary = String(format: "echo cleanup: part %d cleaned — delay %@ ms, echo %.2f → %.2f, mic %@ → %@ dB, %d ms",
                                     i + 1, "\(r["delay_ms"] ?? "?")", (r["echo_peak_before"] as? Double) ?? 0, (r["echo_peak_after"] as? Double) ?? 0,
                                     "\(r["mic_rms_before_db"] ?? "?")", "\(r["mic_rms_after_db"] ?? "?")", (r["took_ms"] as? Int) ?? 0)
                case "skipped":
                    summary = "echo cleanup: part \(i + 1) left as is — \(r["reason"] ?? "") (\(r["took_ms"] ?? 0) ms)"
                default:
                    summary = "echo cleanup: part \(i + 1) FAILED — \(r["reason"] ?? "") — the original file is untouched"
                }
                EventLog.shared.log("echo_cleanup", r, summary: summary)
            }
            let reports = collected
            let cleaned = reports.filter { $0["outcome"] as? String == "cleaned" }.count
            let failed = reports.filter { $0["outcome"] as? String == "failed" }.count
            let summaryRow: [String: Any] = [
                "status": "done", "started_at": ISO8601DateFormatter().string(from: startedAt), "ended_at": isoNow(),
                "parts": reports.count, "cleaned": cleaned, "failed": failed,
                "took_ms": Int(Date().timeIntervalSince(startedAt) * 1000),
                "delay_ms": reports.compactMap { $0["delay_ms"] as? Double }.first ?? NSNull(),
                "echo_peak_before": reports.compactMap { $0["echo_peak_before"] as? Double }.max() ?? NSNull(),
                "echo_peak_after": reports.compactMap { $0["echo_peak_after"] as? Double }.max() ?? NSNull(),
            ]
            await MainActor.run {
                Registry.shared.update(id, ["echo_cleanup": summaryRow])
                self.running.remove(id)
                completion(reports)
            }
        }
    }
}
