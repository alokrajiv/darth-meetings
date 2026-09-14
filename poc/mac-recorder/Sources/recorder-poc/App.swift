import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import RecorderCore

// recorder-poc — ScreenCaptureKit proof of concept CLI.
//   recorder-poc --list
//   recorder-poc [--window <substr>] [--seconds N] [--fps N] [--out file.mp4] [--no-audio]
//   recorder-poc --display | --display-id <id> ...

struct Opts {
    var list = false
    var display = false
    var displayID: UInt32? = nil
    var windowQuery = "Microsoft Teams"
    var seconds: Double = 15
    var fps: Int = 5
    var noAudio = false
    var out: String = "recording.mp4"
}

func parseArgs() -> Opts {
    var o = Opts()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--list": o.list = true
        case "--display": o.display = true
        case "--display-id": o.display = true; o.displayID = UInt32(it.next() ?? "")
        case "--window": o.windowQuery = it.next() ?? o.windowQuery
        case "--seconds": o.seconds = Double(it.next() ?? "") ?? o.seconds
        case "--fps": o.fps = Int(it.next() ?? "") ?? o.fps
        case "--no-audio": o.noAudio = true
        case "--out": o.out = it.next() ?? o.out
        default: fputs("unknown arg \(a)\n", stderr); exit(64)
        }
    }
    return o
}

final class Stopper {
    private let lock = NSLock()
    private var cont: CheckedContinuation<String, Never>?
    private var fired: String?
    func fire(_ why: String) {
        lock.lock(); defer { lock.unlock() }
        if fired != nil { return }
        fired = why
        cont?.resume(returning: why)
        cont = nil
    }
    func wait() async -> String {
        await withCheckedContinuation { c in
            lock.lock(); defer { lock.unlock() }
            if let f = fired { c.resume(returning: f) } else { cont = c }
        }
    }
}

@main
struct App {
    static func main() async {
        let o = parseArgs()
        // Window-server connection (window filters assert CGS_REQUIRE_INIT without it).
        NSApplication.shared.setActivationPolicy(.prohibited)

        if !CGPreflightScreenCaptureAccess() {
            rlog("Screen Recording permission NOT granted for this process (attributed to the terminal app that launched it).")
            let r = CGRequestScreenCaptureAccess()
            rlog("Requested access (returned \(r)). Grant it in System Settings > Privacy & Security > Screen Recording, then re-run.")
            exit(2)
        }
        rlog("Screen Recording permission: granted")

        if o.list {
            let content: SCShareableContent
            do { content = try await CaptureSession.shareableContent() } catch { rlog("SCShareableContent failed: \(error)"); exit(1) }
            print("DISPLAYS")
            for d in content.displays { print("  id=\(d.displayID) \(d.width)x\(d.height) frame=\(d.frame)\(d.displayID == CGMainDisplayID() ? "  (main)" : "")") }
            print("APPS")
            for a in content.applications.sorted(by: { $0.applicationName < $1.applicationName }) {
                print("  pid=\(a.processID) \(a.applicationName) [\(a.bundleIdentifier)]")
            }
            print("WINDOWS (on-screen, layer 0)")
            for w in content.windows where w.isOnScreen && w.windowLayer == 0 {
                print("  id=\(w.windowID) app=\(w.owningApplication?.applicationName ?? "?") title=\"\(w.title ?? "")\" \(Int(w.frame.width))x\(Int(w.frame.height))")
            }
            return
        }

        let filter: SCContentFilter
        let label: String
        do {
            if o.display {
                (filter, label) = try await CaptureSession.displayFilter(displayID: o.displayID)
            } else {
                let (f, l, cands) = try await CaptureSession.windowFilter(query: o.windowQuery)
                rlog("candidates: " + cands.map { "[\($0.windowID)] \($0.owningApplication?.applicationName ?? "?") \"\($0.title ?? "")\" \(Int($0.frame.width))x\(Int($0.frame.height))" }.joined(separator: " | "))
                filter = f; label = l
            }
        } catch { rlog("\(error.localizedDescription) — try --list or --display"); exit(1) }

        let url = URL(fileURLWithPath: o.out)
        let session: CaptureSession
        do { session = try await CaptureSession.start(filter: filter, label: label, fps: o.fps, audio: !o.noAudio, url: url) }
        catch { rlog("start failed: \(error)"); exit(1) }

        let stopper = Stopper()
        session.recorder.onStop = { _ in stopper.fire("stream error") }
        signal(SIGINT, SIG_IGN)
        let sig = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sig.setEventHandler { stopper.fire("SIGINT") }
        sig.resume()

        let ticker = Task {
            var elapsed = 0.0
            while !Task.isCancelled && elapsed < o.seconds {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                elapsed += 1
                if Int(elapsed) % 5 == 0 { rlog("t=\(Int(elapsed))s \(session.recorder.stats)") }
            }
            stopper.fire("timer")
        }
        let why = await stopper.wait()
        ticker.cancel()
        rlog("stopping (\(why))")
        await session.stop()
        if session.recorder.streamError != nil { exit(3) }
    }
}
