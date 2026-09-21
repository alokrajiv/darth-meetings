import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import AVFoundation
import RecorderCore

// recorder-poc — ScreenCaptureKit proof of concept CLI.
//   recorder-poc --list
//   recorder-poc [--window <substr>] [--seconds N] [--fps N] [--out file.mp4] [--no-audio]
//   recorder-poc --display | --display-id <id> ...
//   recorder-poc --selftest-mix <out.m4a>   (no capture at all — see selfTestMix)

struct Opts {
    var list = false
    var display = false
    var displayID: UInt32? = nil
    var windowQuery = "Microsoft Teams"
    var seconds: Double = 15
    var fps: Int = 5
    var noAudio = false
    var out: String = "recording.mp4"
    var selfTestMix: String? = nil
}

/// The mix track, proven WITHOUT capturing anything (0.3.12).
///
/// Two synthetic sources are fed straight into `Recorder.appendAudio` on the host clock — a
/// 440 Hz tone as "system" (48 kHz stereo, the shape SCK delivers) and an 880 Hz tone as "mic"
/// (24 kHz mono, the shape a voice-processed MacBook mic delivers), the second starting half a
/// second late — and the file is closed the ordinary way. What it proves is exactly what the
/// server relies on: audio track 0 is the mix (`qmx`, stereo), the raw sources follow it in
/// order, and both tones really are inside track 0. `ffprobe` the result; no microphone, no
/// screen, no permission of any kind is involved.
func selfTestMix(out path: String) async -> Int32 {
    let url = URL(fileURLWithPath: path)
    let mic = AudioTrackSpec.mic(channels: 1, sampleRate: 24_000)
    let rec: Recorder
    do { rec = try Recorder(audioOnlyURL: url, audioTracks: [.system, mic]) } catch {
        rlog("selftest: writer setup failed: \(error)"); return 1
    }
    let start = CMClockGetTime(CMClockGetHostTimeClock())
    func tone(_ hz: Double, rate: Double, channels: Int, frames: Int, at frame: Int) -> CMSampleBuffer? {
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                channels: AVAudioChannelCount(channels), interleaved: false)!
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)),
              let chans = buf.floatChannelData else { return nil }
        buf.frameLength = AVAudioFrameCount(frames)
        for c in 0..<channels {
            for k in 0..<frames {
                chans[c][k] = Float(sin(2 * Double.pi * hz * Double(frame + k) / rate)) * 0.3
            }
        }
        return LiveMix.sampleBuffer(buf, pts: CMTimeAdd(start, CMTime(value: Int64(frame), timescale: CMTimeScale(rate))))
    }
    // 4 s, the sources INTERLEAVED the way a real recording delivers them (that is what the
    // 1 s emit delay is sized for): system in 100 ms buffers from t=0, mic in 50 ms buffers
    // from t=0.5 s. Nothing may arrive late.
    for i in 0..<40 {
        if let sb = tone(440, rate: 48_000, channels: 2, frames: 4_800, at: i * 4_800) {
            rec.appendAudio(sb, track: 0)
        }
        for half in 0..<2 {
            let frame = i * 2_400 + half * 1_200
            guard frame >= 12_000 else { continue }          // the mic starts at t = 0.5 s
            if let sb = tone(880, rate: 24_000, channels: 1, frames: 1_200, at: frame) {
                rec.appendAudio(sb, track: 1)
            }
        }
    }
    await rec.finish()
    rlog("selftest: \(rec.stats)")
    rlog("selftest: mix healthy = \(rec.mixHealthy) → \(url.path)")
    return rec.mixHealthy ? 0 : 1
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
        case "--selftest-mix": o.selfTestMix = it.next()
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
        // The mix self-test captures nothing, so it runs before any permission is asked for.
        if let out = o.selfTestMix {
            let code = await selfTestMix(out: out)
            exit(code)
        }
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
