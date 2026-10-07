import AVFoundation
import Accelerate
import CSpeexDSP
import Foundation

/// Echo cleanup AFTER the recording, on this Mac (0.3.24).
///
/// **Why here and why afterwards.** The far end of a call on the speakers reaches the
/// microphone a few tens of milliseconds after the system-audio track has it, so the mix the
/// transcriber hears carries the other people twice. Apple's voice-processing unit removed
/// that live (0.3.10) — and reconfigured the microphone for every other client of it, which
/// is how Slack, Teams and Meet stopped hearing the person recording (0.3.23). The capture is
/// raw again and must stay raw. The echo is removed from the FILE instead, once the recording
/// has stopped: the system-audio track is exactly the far-end reference an echo canceller
/// needs, the mic track is the near end, the two are already in step (the writer keeps them on
/// the host clock, `fillGap` pads the mic), and there is no deadline, so it can be done at the
/// lowest priority with a filter that sees the whole recording.
///
/// **What it does to a part file** (`<id>/… part N.mp4|.m4a`, tracks `qmx` mix · `mul` system ·
/// `eng` mic, video optional):
///
/// 1. **Find the echo.** Decode both audio tracks to 16 kHz mono (`AVAssetReader` does the
///    rate conversion) in up to `maxWindows` windows of `windowS` seconds spread over the
///    recording, and slide the mic window over the system track across `minLagS…maxLagS`
///    (normalised cross-correlation, `vDSP_conv`). A window with a peak ≥ `echoPeakThreshold`
///    has echo in it; the delay is the median lag of those windows. Fewer than
///    `minEchoWindows` such windows (headphones, AirPods, a muted mic) → `skipped: no echo`,
///    and the file is not touched — nothing to remove, nothing to risk.
/// 2. **Cancel it.** speexdsp's MDF echo canceller (`speex_echo_cancellation`, 16 kHz, 16 ms
///    frames, `filterLength` taps) with the system track as the far end, shifted so the direct
///    echo lands `leadIn` samples into the filter, followed by the speex preprocessor coupled
///    to it for residual-echo suppression. The adaptive filter is warmed up on the first
///    `warmupS` seconds before the real pass so the opening of the recording is cleaned too.
///    The output is upsampled back to 48 kHz (exact ×3, windowed-sinc FIR).
/// 3. **Rewrite the file.** `AVAssetWriter` to a temp file next to the original: video, the
///    system track and the RAW mic track are stream-copied (no re-encode), the mix track
///    (`qmx`, stereo, first audio track as `LiveMix` put it) is re-rendered from system +
///    cleaned mic with the same limiter, and the cleaned mic goes in as a NEW track
///    (`qmc` "mic-clean", 48 kHz mono) after the raw one. Nothing is thrown away: the raw
///    microphone stays in the file for anyone who wants to redo this with a better canceller.
///    The temp file is verified (one more audio track, same duration, video kept) and then
///    replaces the original atomically; any failure leaves the original exactly as it was.
/// 4. **Measure.** The same correlation runs again on the rewritten file with the cleaned
///    track, so every part reports `echo_peak_before` / `echo_peak_after`, the delay, and RMS
///    before/after — the numbers that say whether this was worth it.
///
/// Cost: a few seconds of one core per hour of audio for the canceller and the AAC encode of
/// two tracks, plus one stream-copy of the file (I/O bound). It runs on a utility-QoS thread
/// after the recording has stopped and before the upload starts.
public enum EchoCleanup {
    public static let analysisRate: Double = 16_000
    /// speex frame at 16 kHz (16 ms). The MDF canceller wants a power of two.
    public static let frame = 256
    /// Adaptive filter length in samples at 16 kHz: 256 ms of echo tail after the lead-in.
    public static let filterLength = 4_096
    /// The far end is shifted so the measured direct echo falls this far into the filter
    /// (32 ms): early reflections and a few ms of delay error still land inside it.
    public static let leadIn = 512
    public static let minLagS: Double = -0.05
    public static let maxLagS: Double = 0.5
    public static let windowS: Double = 8
    public static let maxWindows = 12
    public static let echoPeakThreshold: Float = 0.12
    /// Windows with echo needed before the file is rewritten: a quarter of them, at least one.
    /// (One window is 8 s with a correlation peak ≥ 0.12 — chance alone gives ~0.003.)
    public static func minEchoWindows(of windows: Int) -> Int { max(1, windows / 4) }
    public static let warmupS: Double = 20
    public static let minDurationS: Double = 10
    /// ISO 639-2 private-use tag on the cleaned mic track (`qmx` is the mix, see `LiveMix`).
    public static let cleanLanguageCode = "qmc"
    public static let cleanTrackName = "mic-clean"
    static let mixCeiling: Float = 0.95
    /// Samples per processing block at 16 kHz (64 speex frames ≈ 1 s).
    static let block = 256 * 64

    public struct Options {
        /// Report only: find the echo, do not rewrite.
        public var dryRun = false
        /// Rewrite even when no echo was found (tests).
        public var force = false
        public var log: (String) -> Void = { rlog($0) }
        public init() {}
    }

    // MARK: - Entry

    /// Returns the report as JSON-ready values (`outcome`: cleaned | skipped | failed, `reason`,
    /// `delay_ms`, `echo_peak_before`, `echo_peak_after`, …). Never throws: a failure is an
    /// outcome, and the file is untouched whenever the outcome is not `cleaned`.
    public static func run(file: URL, options: Options = Options()) async -> [String: Any] {
        let t0 = Date()
        var report: [String: Any] = ["file": file.lastPathComponent]
        func done(_ outcome: String, _ reason: String? = nil) -> [String: Any] {
            report["outcome"] = outcome
            if let reason { report["reason"] = reason }
            report["took_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            return report
        }
        do {
            let asset = AVURLAsset(url: file)
            let layout = try await Layout.probe(asset)
            report["duration_s"] = (layout.duration * 10).rounded() / 10
            report["audio_tracks"] = layout.audio.count
            report["has_video"] = layout.video != nil
            guard let sys = layout.system, let mic = layout.mic else {
                return done("skipped", "no system or mic track (\(layout.audio.map { $0.lang ?? "?" }.joined(separator: ",")))")
            }
            if layout.clean != nil { return done("skipped", "already cleaned") }
            guard layout.duration >= minDurationS else { return done("skipped", "shorter than \(Int(minDurationS)) s") }

            // 1. Find the echo.
            let before = try await Echo.measure(asset: asset, system: sys, mic: mic, duration: layout.duration, log: options.log)
            report["windows"] = before.windows
            report["echo_windows"] = before.echoWindows
            report["echo_peak_before"] = r3(before.peak)
            report["delay_ms"] = before.lagMs.map { ($0 * 10).rounded() / 10 } ?? NSNull()
            report["window_peaks"] = before.peaks.map { r3($0) }
            guard before.echoWindows >= minEchoWindows(of: before.windows) || options.force else {
                return done("skipped", "no echo (\(before.echoWindows)/\(before.windows) windows ≥ \(echoPeakThreshold))")
            }
            if options.dryRun { return done("dry_run") }

            // Disk: the rewrite needs a second copy of the part next to it.
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            report["bytes_before"] = size
            if let free = try? file.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
               free < Int64(size) + 200 * 1_048_576 {
                return done("skipped", "not enough free disk for a rewrite (\(free / 1_048_576) MB free, part is \(size / 1_048_576) MB)")
            }

            // 2 + 3. Cancel and rewrite.
            let delaySamples = Int(((before.lagMs ?? 0) / 1000 * analysisRate).rounded())
            let tmp = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).clean.tmp.\(file.pathExtension)")
            try? FileManager.default.removeItem(at: tmp)
            let stats: Rewrite.Stats
            do {
                stats = try await Rewrite.run(asset: asset, layout: layout, delaySamples: delaySamples, to: tmp, log: options.log)
            } catch {
                try? FileManager.default.removeItem(at: tmp)
                throw error
            }
            report["mic_rms_before_db"] = r1(stats.micRmsBeforeDb)
            report["mic_rms_after_db"] = r1(stats.micRmsAfterDb)
            report["warmup_s"] = Int(min(warmupS, layout.duration))

            // Verify before replacing anything.
            let newAsset = AVURLAsset(url: tmp)
            let newLayout = try await Layout.probe(newAsset)
            let expectedAudio = layout.audio.count + 1 + (layout.mix == nil ? 1 : 0)
            guard newLayout.audio.count == expectedAudio, newLayout.clean != nil, newLayout.mix != nil,
                  (newLayout.video != nil) == (layout.video != nil),
                  abs(newLayout.duration - layout.duration) <= 1.5 else {
                try? FileManager.default.removeItem(at: tmp)
                return done("failed", "rewritten file does not verify: audio \(newLayout.audio.count)/\(expectedAudio), clean \(newLayout.clean != nil), mix \(newLayout.mix != nil), video \(newLayout.video != nil), duration \(r1(newLayout.duration)) vs \(r1(layout.duration))")
            }
            // 4. Measure the result on the new file (cleaned track vs system).
            if let cs = newLayout.system, let cc = newLayout.clean {
                let after = try await Echo.measure(asset: newAsset, system: cs, mic: cc, duration: newLayout.duration, log: options.log)
                report["echo_peak_after"] = r3(after.peak)
                report["echo_windows_after"] = after.echoWindows
            }
            _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
            report["bytes_after"] = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            return done("cleaned")
        } catch {
            return done("failed", error.localizedDescription)
        }
    }

    static func r3(_ x: Float) -> Double { (Double(x) * 1000).rounded() / 1000 }
    static func r1(_ x: Double) -> Double { (x * 10).rounded() / 10 }

    // MARK: - Track layout

    struct AudioTrackRef {
        let track: AVAssetTrack
        let lang: String?
        let format: CMFormatDescription?
        var sampleRate: Double? {
            guard let format, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return nil }
            return asbd.pointee.mSampleRate > 0 ? asbd.pointee.mSampleRate : nil
        }
    }

    struct Layout {
        let duration: Double
        let video: AVAssetTrack?
        let audio: [AudioTrackRef]
        var mix: AudioTrackRef? { audio.first { $0.lang == LiveMix.languageCode } }
        var system: AudioTrackRef? { audio.first { $0.lang == AudioTrackSpec.system.languageCode } }
        var mic: AudioTrackRef? { audio.first { $0.lang == "eng" } }
        var clean: AudioTrackRef? { audio.first { $0.lang == cleanLanguageCode } }

        static func probe(_ asset: AVURLAsset) async throws -> Layout {
            let duration = try await asset.load(.duration).seconds
            let video = try await asset.loadTracks(withMediaType: .video).first
            var audio: [AudioTrackRef] = []
            for t in try await asset.loadTracks(withMediaType: .audio) {
                let lang = try await t.load(.languageCode)
                let fmts = try await t.load(.formatDescriptions)
                audio.append(AudioTrackRef(track: t, lang: lang, format: fmts.first))
            }
            return Layout(duration: duration, video: video, audio: audio)
        }
    }

    // MARK: - PCM streaming

    /// One audio track as Float32 mono at `rate`, continuous from `start` (zero-padded at the
    /// front and across gaps, placed by presentation time — a track whose first sample is at
    /// 150 ms gets 150 ms of silence first, exactly as the file plays it).
    ///
    /// Decoded at the track's NATIVE rate and decimated here when the ratio is a whole number
    /// (48 → 16 kHz: ×3): AVFoundation's own rate conversion was measured on 2026-10-07 to
    /// deliver 2 731 samples per 8 192 input samples where 2 730.67 are due — a 122 ppm stretch
    /// that walks the cleaned track 0.4 s away from the system track per hour. Only a track
    /// whose rate is not a multiple of `rate` falls back to the converter.
    final class PCMStream {
        let rate: Double
        let nativeRate: Double
        /// Native samples per output sample (1 = none; 3 = 48 → 16 kHz).
        let factor: Int
        private let reader: AVAssetReader
        private let output: AVAssetReaderTrackOutput
        private var decimator: Decimator?
        /// Decoded native-rate samples not yet handed out.
        private var buf: [Float] = []
        /// Native sample index (from t = 0) of buf[0].
        private var bufStart: Int64
        private var eof = false
        private(set) var samplesSeen: Int64 = 0
        /// Native samples of timestamp drift treated as continuity rather than a gap (~1–3 ms).
        static let continuityTolerance: Int64 = 48
        static let trace = ProcessInfo.processInfo.environment["ECHO_CLEANUP_TRACE"] != nil
        private var buffers = 0

        static func nativeRate(of track: AVAssetTrack) async -> Double? {
            guard let fmts = try? await track.load(.formatDescriptions), let f = fmts.first,
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(f) else { return nil }
            return asbd.pointee.mSampleRate > 0 ? asbd.pointee.mSampleRate : nil
        }

        init(asset: AVAsset, track: AVAssetTrack, rate: Double, nativeRate: Double?, start: Double = 0, duration: Double? = nil) throws {
            self.rate = rate
            if let nr = nativeRate, nr >= rate, nr.truncatingRemainder(dividingBy: rate) == 0, Int(nr / rate) <= 8 {
                self.nativeRate = nr
                factor = Int(nr / rate)
            } else {
                self.nativeRate = rate                       // converter fallback (non-integer ratio)
                factor = 1
            }
            if factor > 1 { decimator = Decimator(factor: factor) }
            reader = try AVAssetReader(asset: asset)
            output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: self.nativeRate,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsNonInterleaved: false,
                AVLinearPCMIsBigEndianKey: false,
            ])
            output.alwaysCopiesSampleData = false
            reader.add(output)
            if let duration {
                reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 48_000),
                                               duration: CMTime(seconds: duration, preferredTimescale: 48_000))
            }
            bufStart = Int64((start * self.nativeRate).rounded())
            guard reader.startReading() else {
                throw reader.error ?? NSError(domain: "echo-cleanup", code: 1, userInfo: [NSLocalizedDescriptionKey: "reader would not start"])
            }
        }

        private func fill() {
            guard !eof else { return }
            guard let sb = output.copyNextSampleBuffer() else {
                eof = true
                if reader.status == .failed { rlog("echo cleanup: reader failed — \(reader.error?.localizedDescription ?? "?")") }
                return
            }
            let n = CMSampleBufferGetNumSamples(sb)
            guard n > 0 else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            var idx = Int64((pts * nativeRate).rounded())
            let end = bufStart + Int64(buf.count)
            // Decoded packets are CONTINUOUS even when their timestamps do not round to the
            // sample (1024 AAC frames at 48 kHz are 341.33 samples at 16 kHz): anything within
            // the tolerance is appended as-is. Placing every packet by its rounded timestamp
            // inserted a zero sample every few packets and stretched the track by 0.3 % —
            // enough to decorrelate the cleaned mic from itself over a minute (found 2026-10-07).
            if Self.trace {
                buffers += 1
                if buffers <= 12 || abs(idx - end) > 2 { rlog(String(format: "pcm trace native %.0f→%.0f: buffer %d pts %.6f → idx %lld, end %lld (Δ %lld), %d samples", nativeRate, rate, buffers, pts, idx, end, idx - end, n)) }
            }
            if abs(idx - end) <= Self.continuityTolerance { idx = end }
            if idx > end {
                buf.append(contentsOf: [Float](repeating: 0, count: Int(idx - end)))       // real gap → silence
            }
            // A window read (timeRange) can start a packet or two EARLY: trim what lies before
            // `bufStart`, never shift it (a shifted window would mis-measure the delay).
            let drop = idx < end ? Int(end - idx) : 0
            var abl = AudioBufferList()
            var blockBuffer: CMBlockBuffer?
            let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sb, bufferListSizeNeededOut: nil, bufferListOut: &abl,
                bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
                blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                blockBufferOut: &blockBuffer)
            guard st == noErr, let data = abl.mBuffers.mData else { return }
            let count = Int(abl.mBuffers.mDataByteSize) / MemoryLayout<Float>.size
            guard drop < count else { return }
            let p = data.assumingMemoryBound(to: Float.self)
            buf.append(contentsOf: UnsafeBufferPointer(start: p + drop, count: count - drop))
            samplesSeen += Int64(count - drop)
        }

        /// Exactly `n` output samples, or nil once the track is exhausted and the buffer is
        /// empty. Short at the very end is padded with zeros.
        func next(_ n: Int) -> [Float]? {
            let want = n * factor
            while buf.count < want && !eof { fill() }
            if buf.isEmpty && eof { return nil }
            var native: [Float]
            if buf.count >= want {
                native = Array(buf[0..<want])
                buf.removeFirst(want)
            } else {
                native = buf
                native.append(contentsOf: [Float](repeating: 0, count: want - buf.count))
                buf.removeAll()
            }
            bufStart += Int64(want)
            return decimator.map { $0.process(native) } ?? native
        }

        /// Everything the stream has (bounded reads only — windows).
        func all() -> [Float] {
            while !eof { fill() }
            let usable = buf.count / factor * factor
            let native = Array(buf[0..<usable])
            buf.removeAll()
            return decimator.map { $0.process(native) } ?? native
        }

        func cancel() { reader.cancelReading() }
    }

    // MARK: - Echo measurement

    struct Measurement {
        let windows: Int
        let echoWindows: Int
        /// Median NCC peak over the windows that have echo (0 when none).
        let peak: Float
        /// Median lag of those windows, ms (mic later than system → positive).
        let lagMs: Double?
        let peaks: [Float]
    }

    enum Echo {
        static func measure(asset: AVAsset, system: AudioTrackRef, mic: AudioTrackRef, duration: Double, log: ((String) -> Void)? = nil) async throws -> Measurement {
            let r = analysisRate
            let w = min(windowS, max(2, duration - 1))
            let count = max(1, min(maxWindows, Int(duration / 15)))
            // Window starts, evenly spread, never before maxLagS (the system read begins that far ahead).
            let first = maxLagS + 0.1
            let last = max(first, duration - w - 0.1)
            let starts: [Double] = (0..<count).map { i in count == 1 ? first : first + (last - first) * Double(i) / Double(count - 1) }
            var peaks: [Float] = []
            var lags: [Double] = []
            let maxLag = Int(maxLagS * r), minLag = Int(minLagS * r)
            for s in starts {
                let micS = try PCMStream(asset: asset, track: mic.track, rate: r, nativeRate: mic.sampleRate, start: s, duration: w)
                let sysS = try PCMStream(asset: asset, track: system.track, rate: r, nativeRate: system.sampleRate, start: s - maxLagS, duration: w + maxLagS - minLagS)
                let m = micS.all(), sys = sysS.all()
                micS.cancel(); sysS.cancel()
                let n = Int(w * r)
                guard m.count >= n, sys.count >= n + (maxLag - minLag) else { peaks.append(0); continue }
                let (peak, lag) = ncc(mic: Array(m[0..<n]), system: Array(sys[0..<(n + maxLag - minLag)]), maxLag: maxLag, minLag: minLag)
                peaks.append(peak)
                lags.append(Double(lag) / r * 1000)
                if let log {
                    var em: Float = 0, es: Float = 0
                    vDSP_svesq(m, 1, &em, vDSP_Length(n)); vDSP_svesq(sys, 1, &es, vDSP_Length(sys.count))
                    log(String(format: "echo window @%.1fs: mic %d samples (E %.3f) · system %d samples (E %.3f) · peak %.3f lag %.1f ms", s, m.count, em, sys.count, es, peak, Double(lag) / r * 1000))
                }
            }
            let echoIdx = peaks.indices.filter { peaks[$0] >= echoPeakThreshold }
            let echoPeaks = echoIdx.map { peaks[$0] }.sorted()
            let echoLags = echoIdx.compactMap { $0 < lags.count ? lags[$0] : nil }.sorted()
            return Measurement(windows: peaks.count, echoWindows: echoIdx.count,
                               peak: echoPeaks.isEmpty ? (peaks.max() ?? 0) : echoPeaks[echoPeaks.count / 2],
                               lagMs: echoLags.isEmpty ? nil : echoLags[echoLags.count / 2], peaks: peaks)
        }

        /// `system[j]` is the system track from (window start − maxLag). Correlating the mic
        /// window across it gives c[k] = Σ system[k + i]·mic[i]; the echo delay is maxLag − k.
        static func ncc(mic m: [Float], system s: [Float], maxLag: Int, minLag: Int) -> (peak: Float, lag: Int) {
            let n = m.count
            let lagsCount = maxLag - minLag + 1
            guard s.count >= n + lagsCount - 1, n > 0 else { return (0, 0) }
            var c = [Float](repeating: 0, count: lagsCount)
            m.withUnsafeBufferPointer { mp in
                s.withUnsafeBufferPointer { sp in
                    vDSP_conv(sp.baseAddress!, 1, mp.baseAddress!, 1, &c, 1, vDSP_Length(lagsCount), vDSP_Length(n))
                }
            }
            var em: Float = 0
            vDSP_svesq(m, 1, &em, vDSP_Length(n))
            guard em > 1e-6 else { return (0, 0) }
            // Sliding energy of the system over each n-sample window via a prefix sum of squares.
            var sq = [Float](repeating: 0, count: s.count)
            vDSP_vsq(s, 1, &sq, 1, vDSP_Length(s.count))
            var prefix = [Double](repeating: 0, count: s.count + 1)
            for i in 0..<s.count { prefix[i + 1] = prefix[i] + Double(sq[i]) }
            var best: Float = 0, bestK = 0
            for k in 0..<lagsCount {
                let es = prefix[k + n] - prefix[k]
                guard es > 1e-6 else { continue }
                let v = c[k] / Float(sqrt(Double(em) * es))
                if v > best { best = v; bestK = k }
            }
            return (best, maxLag - bestK)
        }
    }

    // MARK: - Resampling (exact whole-number ratios: 48 ↔ 16 kHz)

    /// Windowed-sinc low-pass for the rate changes: `taps` long, cutoff at `cutoff` × the
    /// higher rate's Nyquist, Hamming window, unity DC gain × `gain`. Symmetric, so its group
    /// delay is (taps − 1) / 2 samples at the higher rate — `Rewrite` pays that once.
    static func lowpass(taps: Int = 95, cutoff: Double = 0.9, gain: Float = 1) -> [Float] {
        let fc = cutoff / 2        // fraction of the sampling rate (Nyquist = 0.5)
        var h = [Float](repeating: 0, count: taps)
        let mid = Double(taps - 1) / 2
        for i in 0..<taps {
            let x = Double(i) - mid
            let sinc = x == 0 ? 2 * fc : sin(2 * .pi * fc * x) / (.pi * x)
            let win = 0.54 - 0.46 * cos(2 * .pi * Double(i) / Double(taps - 1))
            h[i] = Float(sinc * win)
        }
        let sum = h.reduce(0, +)
        return h.map { $0 / sum * gain }
    }

    /// Exact ÷`factor` decimation: low-pass at 0.9 × the LOWER rate's Nyquist, then every
    /// `factor`-th sample (`vDSP_desamp`). Filter history is kept across blocks; the input
    /// count must be a multiple of `factor` (`PCMStream` guarantees it).
    final class Decimator {
        let factor: Int
        let h: [Float]
        private var history: [Float]
        init(factor: Int) {
            self.factor = factor
            h = EchoCleanup.lowpass(cutoff: 0.9 / Double(factor))
            history = [Float](repeating: 0, count: h.count - 1)
        }
        func process(_ x: [Float]) -> [Float] {
            let n = x.count / factor
            guard n > 0 else { return [] }
            var stuffed = history
            stuffed.append(contentsOf: x)
            var out = [Float](repeating: 0, count: n)
            stuffed.withUnsafeBufferPointer { sp in
                vDSP_desamp(sp.baseAddress!, vDSP_Stride(factor), h, &out, vDSP_Length(n), vDSP_Length(h.count))
            }
            history = Array(stuffed.suffix(h.count - 1))
            return out
        }
    }

    /// Exact ×3 interpolation: zero-stuff then the same low-pass with gain 3 (`vDSP_conv` with
    /// the filter reversed = convolution), history kept across blocks, so the output is exactly
    /// 3× the input block after block.
    final class Upsampler3 {
        let h: [Float]
        private let hr: [Float]
        private var history: [Float]
        init() {
            h = EchoCleanup.lowpass(cutoff: 0.9 / 3, gain: 3)
            hr = Array(h.reversed())
            history = [Float](repeating: 0, count: h.count - 1)
        }
        /// Group delay of decimation + interpolation together, in 48 kHz samples.
        static var roundTripDelay: Int { 95 - 1 }
        func process(_ x: [Float]) -> [Float] {
            let up = x.count * 3
            var stuffed = history
            stuffed.reserveCapacity(history.count + up)
            for v in x { stuffed.append(v); stuffed.append(0); stuffed.append(0) }
            var out = [Float](repeating: 0, count: up)
            stuffed.withUnsafeBufferPointer { sp in
                vDSP_conv(sp.baseAddress!, 1, hr, 1, &out, 1, vDSP_Length(up), vDSP_Length(h.count))
            }
            history = Array(stuffed.suffix(h.count - 1))
            return out
        }
    }

    // MARK: - Rewrite

    enum Rewrite {
        struct Stats {
            var micRmsBeforeDb: Double
            var micRmsAfterDb: Double
        }

        final class Passthrough {
            let reader: AVAssetReader
            let output: AVAssetReaderTrackOutput
            let input: AVAssetWriterInput
            var finished = false
            init(asset: AVAsset, track: AVAssetTrack, mediaType: AVMediaType, format: CMFormatDescription?, lang: String?, name: String?) throws {
                reader = try AVAssetReader(asset: asset)
                output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
                output.alwaysCopiesSampleData = false
                reader.add(output)
                guard reader.startReading() else {
                    throw reader.error ?? NSError(domain: "echo-cleanup", code: 1, userInfo: [NSLocalizedDescriptionKey: "passthrough reader would not start"])
                }
                input = AVAssetWriterInput(mediaType: mediaType, outputSettings: nil, sourceFormatHint: format)
                input.expectsMediaDataInRealTime = false
                if let lang { input.languageCode = lang }
                if let name {
                    let item = AVMutableMetadataItem()
                    item.identifier = .quickTimeUserDataTrackName
                    item.value = name as NSString
                    input.metadata = [item]
                }
            }
            /// Append what is ready; returns false once the track is fully copied.
            func pump() -> Bool {
                guard !finished else { return false }
                while input.isReadyForMoreMediaData {
                    guard let sb = output.copyNextSampleBuffer() else {
                        input.markAsFinished()
                        finished = true
                        return false
                    }
                    if !input.append(sb) { input.markAsFinished(); finished = true; return false }
                }
                return true
            }
        }

        static func pcmInput(rate: Double, channels: Int, lang: String, name: String) -> AVAssetWriterInput {
            let i = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: rate,
                AVNumberOfChannelsKey: channels,
            ])
            i.expectsMediaDataInRealTime = false
            i.languageCode = lang
            let item = AVMutableMetadataItem()
            item.identifier = .quickTimeUserDataTrackName
            item.value = name as NSString
            i.metadata = [item]
            return i
        }

        static func run(asset: AVURLAsset, layout: Layout, delaySamples: Int, to tmp: URL, log: (String) -> Void) async throws -> Stats {
            guard let sys = layout.system, let mic = layout.mic else { throw err("tracks vanished") }
            let fileType: AVFileType = tmp.pathExtension.lowercased() == "m4a" ? .m4a : .mp4
            let writer = try AVAssetWriter(outputURL: tmp, fileType: fileType)

            // Writer inputs in file order: video, mix, system, mic (raw), mic-clean.
            var passthroughs: [Passthrough] = []
            if let v = layout.video {
                let fmts = try await v.load(.formatDescriptions)
                let p = try Passthrough(asset: asset, track: v, mediaType: .video, format: fmts.first, lang: nil, name: nil)
                passthroughs.append(p)
                writer.add(p.input)
            }
            let mixIn = pcmInput(rate: LiveMix.rate, channels: 2, lang: LiveMix.languageCode, name: LiveMix.trackSpec.name)
            writer.add(mixIn)
            let sysP = try Passthrough(asset: asset, track: sys.track, mediaType: .audio, format: sys.format, lang: sys.lang, name: AudioTrackSpec.system.name)
            passthroughs.append(sysP); writer.add(sysP.input)
            let micP = try Passthrough(asset: asset, track: mic.track, mediaType: .audio, format: mic.format, lang: mic.lang, name: "mic")
            passthroughs.append(micP); writer.add(micP.input)
            let cleanIn = pcmInput(rate: LiveMix.rate, channels: 1, lang: cleanLanguageCode, name: cleanTrackName)
            writer.add(cleanIn)

            guard writer.startWriting() else { throw writer.error ?? err("writer would not start") }
            writer.startSession(atSourceTime: .zero)

            // The canceller.
            guard let st = speex_echo_state_init(Int32(frame), Int32(filterLength)) else { throw err("speex_echo_state_init") }
            defer { speex_echo_state_destroy(st) }
            var rate32 = Int32(analysisRate)
            speex_echo_ctl(st, SPEEX_ECHO_SET_SAMPLING_RATE, &rate32)
            guard let pp = speex_preprocess_state_init(Int32(frame), Int32(analysisRate)) else { throw err("speex_preprocess_state_init") }
            defer { speex_preprocess_state_destroy(pp) }
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_ECHO_STATE, UnsafeMutableRawPointer(st))
            var off: Int32 = 0, on: Int32 = 1
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_AGC, &off)           // the mic is conditioned already
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_DENOISE, &on)
            var noiseSuppress: Int32 = -10                                     // mild: speech for a transcriber, not a phone
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_NOISE_SUPPRESS, &noiseSuppress)
            let env = ProcessInfo.processInfo.environment
            var echoSuppress: Int32 = Int32(env["ECHO_CLEANUP_SUPPRESS"] ?? "") ?? -40
            var echoSuppressActive: Int32 = Int32(env["ECHO_CLEANUP_SUPPRESS_ACTIVE"] ?? "") ?? -15
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS, &echoSuppress)
            speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_ECHO_SUPPRESS_ACTIVE, &echoSuppressActive)
            let usePreprocess = env["ECHO_CLEANUP_NO_PREPROCESS"] == nil
            let bypass = env["ECHO_CLEANUP_BYPASS"] != nil          // test: out = in (pipeline check)
            let dump: FileHandle? = env["ECHO_CLEANUP_DUMP"].flatMap { path in
                FileManager.default.createFile(atPath: path, contents: nil)
                return FileHandle(forWritingAtPath: path)
            }
            if let v = env["ECHO_CLEANUP_NO_DENOISE"], !v.isEmpty { speex_preprocess_ctl(pp, SPEEX_PREPROCESS_SET_DENOISE, &off) }

            // The far end is the system track shifted so the direct echo lands `leadIn` into the filter.
            let farShift = max(0, delaySamples - leadIn)
            log("echo cleanup: delay \(delaySamples) samples (\(delaySamples * 1000 / Int(analysisRate)) ms) → far end shifted by \(farShift), filter \(filterLength) taps")

            // Warm-up pass over the opening seconds (output discarded) so the real pass starts converged.
            let warm = min(warmupS, layout.duration)
            do {
                let micW = try PCMStream(asset: asset, track: mic.track, rate: analysisRate, nativeRate: mic.sampleRate, start: 0, duration: warm)
                let sysW = try PCMStream(asset: asset, track: sys.track, rate: analysisRate, nativeRate: sys.sampleRate, start: 0, duration: warm)
                var far = FarEnd(stream: sysW, shift: farShift)
                var inI = [Int16](repeating: 0, count: frame), farI = [Int16](repeating: 0, count: frame), outI = [Int16](repeating: 0, count: frame)
                while let m = micW.next(frame), let f = far.next(frame) {
                    toInt16(m, &inI); toInt16(f, &farI)
                    speex_echo_cancellation(st, inI, farI, &outI)
                }
                micW.cancel(); sysW.cancel()
            }

            // The real pass.
            let micS = try PCMStream(asset: asset, track: mic.track, rate: analysisRate, nativeRate: mic.sampleRate)
            let sysS = try PCMStream(asset: asset, track: sys.track, rate: analysisRate, nativeRate: sys.sampleRate)
            let sys48 = try PCMStream(asset: asset, track: sys.track, rate: LiveMix.rate, nativeRate: sys.sampleRate)
            if micS.factor == 1 && (mic.sampleRate ?? 0) != analysisRate { log("echo cleanup: mic track at \(Int(mic.sampleRate ?? 0)) Hz — AVFoundation converter (not sample-exact)") }
            // Decimation + interpolation delay the cleaned mic by 94 samples at 48 kHz: skip them
            // once so the cleaned track sits exactly on the raw mic's timeline.
            var skip = Upsampler3.roundTripDelay
            var far = FarEnd(stream: sysS, shift: farShift)
            let up = Upsampler3()
            var inI = [Int16](repeating: 0, count: frame), farI = [Int16](repeating: 0, count: frame), outI = [Int16](repeating: 0, count: frame)
            var sumBefore = 0.0, sumAfter = 0.0, countBefore = 0.0
            var blockIndex: Int64 = 0
            // The new tracks end where the file ends: the last block is cut to the duration
            // instead of being padded to a full second.
            let totalFrames48 = Int64((layout.duration * LiveMix.rate).rounded(.up))
            let mixFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: LiveMix.rate, channels: 2, interleaved: false)!
            let cleanFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: LiveMix.rate, channels: 1, interleaved: false)!
            var limiterGain: Float = 1

            func pumpAll() { for p in passthroughs { _ = p.pump() } }
            func waitReady(_ input: AVAssetWriterInput) {
                while !input.isReadyForMoreMediaData { pumpAll(); usleep(2_000) }
            }

            while true {
                let m = micS.next(block)
                let s48 = sys48.next(block * 3)
                if m == nil && s48 == nil { break }
                let micBlock = m ?? [Float](repeating: 0, count: block)
                let farBlock = far.next(block) ?? [Float](repeating: 0, count: block)
                let sysBlock = s48 ?? [Float](repeating: 0, count: block * 3)
                var clean16 = [Float](repeating: 0, count: block)
                for f in 0..<(block / frame) {
                    let r = (f * frame)..<((f + 1) * frame)
                    toInt16(Array(micBlock[r]), &inI); toInt16(Array(farBlock[r]), &farI)
                    if bypass { outI = inI } else {
                        speex_echo_cancellation(st, inI, farI, &outI)
                        if usePreprocess { speex_preprocess_run(pp, &outI) }
                    }
                    for i in 0..<frame { clean16[r.lowerBound + i] = Float(outI[i]) / 32768 }
                }
                if let dump { micBlock.withUnsafeBufferPointer { dump.write(Data(buffer: $0)) } }
                var e: Float = 0
                vDSP_svesq(micBlock, 1, &e, vDSP_Length(block)); sumBefore += Double(e)
                vDSP_svesq(clean16, 1, &e, vDSP_Length(block)); sumAfter += Double(e)
                countBefore += Double(block)

                var clean48 = up.process(clean16)
                if skip > 0 {
                    let d = min(skip, clean48.count)
                    clean48.removeFirst(d); clean48.append(contentsOf: [Float](repeating: 0, count: d)); skip -= d
                }
                // The mix: system (already mono) + cleaned mic, through LiveMix's limiter rules.
                var mix = [Float](repeating: 0, count: block * 3)
                vDSP_vadd(sysBlock, 1, clean48, 1, &mix, 1, vDSP_Length(block * 3))
                limit(&mix, gain: &limiterGain)

                let startFrame = blockIndex * Int64(block * 3)
                guard startFrame < totalFrames48 else { break }
                let frames = Int(min(Int64(block * 3), totalFrames48 - startFrame))
                let pts = CMTime(value: startFrame, timescale: CMTimeScale(LiveMix.rate))
                guard let mixBuf = AVAudioPCMBuffer(pcmFormat: mixFmt, frameCapacity: AVAudioFrameCount(frames)),
                      let cleanBuf = AVAudioPCMBuffer(pcmFormat: cleanFmt, frameCapacity: AVAudioFrameCount(frames)),
                      let mc = mixBuf.floatChannelData, let cc = cleanBuf.floatChannelData else { throw err("pcm buffers") }
                mixBuf.frameLength = AVAudioFrameCount(frames); cleanBuf.frameLength = AVAudioFrameCount(frames)
                mix.withUnsafeBufferPointer { p in mc[0].update(from: p.baseAddress!, count: frames); mc[1].update(from: p.baseAddress!, count: frames) }
                clean48.withUnsafeBufferPointer { p in cc[0].update(from: p.baseAddress!, count: frames) }
                guard let mixSB = LiveMix.sampleBuffer(mixBuf, pts: pts), let cleanSB = LiveMix.sampleBuffer(cleanBuf, pts: pts) else { throw err("sample buffers") }
                waitReady(mixIn); guard mixIn.append(mixSB) else { throw writer.error ?? err("mix append") }
                waitReady(cleanIn); guard cleanIn.append(cleanSB) else { throw writer.error ?? err("clean append") }
                pumpAll()
                blockIndex += 1
            }
            mixIn.markAsFinished(); cleanIn.markAsFinished()
            micS.cancel(); sysS.cancel(); sys48.cancel()
            while passthroughs.contains(where: { !$0.finished }) { pumpAll(); usleep(2_000) }
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? err("writer status \(writer.status.rawValue)") }
            let before = countBefore > 0 ? 10 * log10(max(sumBefore / countBefore, 1e-12)) : -120
            let after = countBefore > 0 ? 10 * log10(max(sumAfter / countBefore, 1e-12)) : -120
            return Stats(micRmsBeforeDb: before, micRmsAfterDb: after)
        }

        /// The system stream delayed by `shift` samples of silence (the far-end reference).
        struct FarEnd {
            let stream: PCMStream
            var pending: [Float]
            init(stream: PCMStream, shift: Int) { self.stream = stream; pending = [Float](repeating: 0, count: shift) }
            mutating func next(_ n: Int) -> [Float]? {
                while pending.count < n {
                    guard let more = stream.next(n) else { break }
                    pending.append(contentsOf: more)
                }
                if pending.isEmpty { return nil }
                if pending.count < n { pending.append(contentsOf: [Float](repeating: 0, count: n - pending.count)) }
                let out = Array(pending[0..<n]); pending.removeFirst(n)
                return out
            }
        }

        static func toInt16(_ x: [Float], _ out: inout [Int16]) {
            var scaled = [Float](repeating: 0, count: x.count)
            var k: Float = 32767
            vDSP_vsmul(x, 1, &k, &scaled, 1, vDSP_Length(x.count))
            var lo: Float = -32768, hi: Float = 32767
            vDSP_vclip(scaled, 1, &lo, &hi, &scaled, 1, vDSP_Length(x.count))
            vDSP_vfix16(scaled, 1, &out, 1, vDSP_Length(x.count))
        }

        /// LiveMix's limiter: instant attack, ~+0.4 dB per 100 ms release, ceiling 0.95, hard clamp.
        static func limit(_ x: inout [Float], gain: inout Float) {
            let release: Float = powf(10, 0.4 / 20 / 4_800)   // per sample, 100 ms = 4 800 samples at 48 kHz
            for i in 0..<x.count {
                let v = x[i] * gain
                if abs(v) > mixCeiling {
                    gain *= mixCeiling / abs(v)
                    x[i] = v > 0 ? mixCeiling : -mixCeiling
                } else {
                    x[i] = v
                    if gain < 1 { gain = min(1, gain * release) }
                }
            }
        }

        static func err(_ s: String) -> NSError {
            NSError(domain: "echo-cleanup", code: 2, userInfo: [NSLocalizedDescriptionKey: s])
        }
    }
}
