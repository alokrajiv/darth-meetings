import AppKit
import RecorderCore

/// 2026-09-17 22:53 SGT: an NSInvalidArgumentException raised inside a main-queue block
/// (AVAssetWriterInput, 3-channel mic) was swallowed by AppKit. The app kept running — the
/// menu, banners and every run-loop Timer worked — but the main DISPATCH queue never drained
/// again: every `DispatchQueue.main.async`, every URLSession completion and every
/// `Task { @MainActor }` sat forever. The tray looked alive for 12 hours while no recording
/// could start and the same registry row and event batch were re-POSTed every minute.
///
/// Run-loop timers survive that state, so this timer posts a ping to the main queue and, when
/// the pong is `stallAfter` late, logs loudly (`main_queue_stalled`) and relaunches the app —
/// unless a recording is writing, in which case it warns and relaunches once that ends.
final class MainQueueWatchdog {
    static let interval: TimeInterval = 15
    static let stallAfter: TimeInterval = 45

    private var timer: Timer?
    private var pendingSince: Date?
    private var reported = false
    private var relaunching = false
    /// Safe to relaunch right now? (Never while a recording is writing.)
    var canRelaunch: () -> Bool = { true }
    /// Called once when the stall is first detected (seconds since the ping).
    var onStall: ((TimeInterval) -> Void)?

    func start() {
        timer?.invalidate()
        let t = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 2
        // .common: keeps ticking while a menu or panel is being tracked.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tick() {
        if let p = pendingSince {
            let stalled = Date().timeIntervalSince(p)
            if stalled >= Self.stallAfter { handleStall(stalled) }
            return
        }
        pendingSince = Date()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingSince = nil
            if self.reported {
                // Only reachable if the queue came back on its own — say so, and stand down.
                self.reported = false
                rlog("WATCHDOG: the main dispatch queue is draining again")
            }
        }
    }

    private func handleStall(_ seconds: TimeInterval) {
        if !reported {
            reported = true
            EventLog.shared.log("main_queue_stalled", ["seconds": Int(seconds), "pid": Int(getpid()), "version": VERSION],
                                summary: "WATCHDOG: the main dispatch queue has not drained for \(Int(seconds)) s — the app is a zombie (menu works, nothing async does)")
            onStall?(seconds)
        }
        guard !relaunching, canRelaunch() else { return }
        relaunching = true
        relaunch(after: seconds)
    }

    /// `open` the bundle again from a detached shell after we are gone, then exit hard:
    /// `NSApp.terminate` would run the normal quit path, parts of which need the very queue
    /// that is dead. Nothing is recording here (see `canRelaunch`), so there is nothing to
    /// finalise and no SCK stream to leak.
    private func relaunch(after seconds: TimeInterval) {
        let app = Bundle.main.bundleURL.path
        EventLog.shared.log("watchdog_relaunch", ["seconds": Int(seconds), "pid": Int(getpid()), "app": app],
                            summary: "WATCHDOG: relaunching \(app) (pid \(getpid()) exits now)")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
        p.arguments = ["/bin/bash", "-c", "sleep 1.5; /usr/bin/open \"$0\"", app]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch {
            rlog("WATCHDOG: could not spawn the relaunch helper: \(error) — exiting anyway; the login item brings us back at next login")
        }
        exit(70)
    }
}
