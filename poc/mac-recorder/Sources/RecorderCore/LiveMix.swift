import AVFoundation
import Foundation

/// The mix, made while recording, so the FIRST audio track of every file is already the one
/// thing a transcriber should listen to (0.3.12).
///
/// Until now a Darth Recorder file carried only the raw sources — system audio as track 0, the
/// microphone as track 1 — and the server mixed them at ingest (`src/lib/server/multitrack.ts`:
/// amix + a re-mux that puts the mix first). That mix-down is the ONLY reason a recorder upload
/// may not hand its bytes straight to AssemblyAI (`blobFastPathRefusal`, DEC-1 in
/// `docs/recordings-blob-spec.md`): whoever transcribes a multi-track file without it hears one
/// track, which on 2026-09-16 was a Slack huddle transcribed at 484 words instead of 1429. The
/// tray is the biggest user of blob transit, so it is worth doing the mix here, once, for free.
///
/// **How.** Every source hands its buffers to `accept(_:source:)` on its own thread (the SCK
/// audio queue, the mic tap). Each buffer is folded to mono, resampled to 48 kHz by LINEAR
/// interpolation and summed into an accumulator indexed by TIME — the frame index comes from
/// the buffer's presentation timestamp, not from a running count, so the two sources line up
/// exactly as they do in the file (both timestamp against the host clock) and neither drift nor
/// a late-starting source can smear the mix. Whatever is older than `delay` behind the newest
/// sample seen is emitted in 100 ms blocks to the mix track, through a peak limiter.
///
/// **Level.** No per-track normalisation, unlike the server's dynaudnorm pair: the microphone
/// arrives already conditioned (`MicConditioner`, target peak −12 dBFS, and Apple's AGC when
/// voice processing is on) and the system track is the call at its own playback level. What is
/// left is the rare overlap peak, which the limiter catches — instant attack, ~+0.4 dB per
/// 100 ms release, ceiling 0.95, then a hard clamp.
///
/// **Honesty.** `healthy` is false unless every source that produced buffers also reached the
/// mix (an unexpected sample format, say) and at least one block was written. The tray records
/// that verdict per recording and only declares `tracks.mixFirst` at upload when it holds — a
/// mix track that is silently missing one side would be the 2026-09-16 incident with the blame
/// moved to the Mac.
public final class LiveMix {
    /// The mix track's sample rate, and the resolution of the accumulator.
    public static let rate: Double = 48_000
    /// How far behind the newest sample seen the emit point sits. A whole second because the
    /// two sources are not synchronous: SCK delivers system audio in its own rhythm and the mic
    /// tap in another, and a block emitted before both have contributed would lose one of them.
    public static let delay: Double = 1.0
    /// 100 ms per appended buffer.
    static let block = 4_800
    /// Never let the accumulator grow past this (a source that stops delivering must not make
    /// the tray eat memory): the oldest blocks are emitted anyway.
    static let maxBufferedSeconds: Double = 8
    static let ceiling: Float = 0.95

    /// ISO 639-2 language tag on the mix track. `qaa`–`qtz` is the range reserved for local
    /// use, so this can never collide with a real language on a real recording — and the
    /// language code is the ONLY per-track label AVAssetWriter writes that survives into
    /// `ffprobe` (`quickTimeUserDataTrackName` / `commonIdentifierTitle` do not; verified
    /// 2026-09-22). `isMixTrack` in `src/lib/server/multitrack.ts` reads it, which is what
    /// stops the server mixing a mix back in with the raw tracks.
    public static let languageCode = "qmx"
    public static var trackSpec: AudioTrackSpec {
        AudioTrackSpec(name: "mix", languageCode: languageCode, channels: 2, sampleRate: rate)
    }

    private let lock = NSLock()
    private let sources: Int
    private let emit: (CMSampleBuffer) -> Bool
    private let outFormat: AVAudioFormat

    /// PTS of accumulator frame 0 of the whole recording.
    private var anchor: CMTime?
    /// The accumulator, mono, from frame `accStart`.
    private var acc: [Float] = []
    private var accStart: Int64 = 0
    /// Highest frame index any source has written.
    private var newest: Int64 = 0
    private var limiterGain: Float = 1
    private var appliedGain: Float = 1

    public private(set) var framesWritten: Int64 = 0
    public private(set) var buffersWritten = 0
    /// Frames each source contributed — the health check.
    public private(set) var accepted: [Int64]
    /// Buffers that arrived after their block had already been emitted.
    public private(set) var late = 0
    /// Buffers in a sample format the mixer does not understand.
    public private(set) var unsupported = 0
    private var loggedUnsupported = false

    public init(sources: Int, emit: @escaping (CMSampleBuffer) -> Bool) {
        self.sources = max(1, sources)
        self.emit = emit
        accepted = Array(repeating: 0, count: max(1, sources))
        outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.rate,
                                  channels: 2, interleaved: false)!
    }

    /// True when the mix really is the whole recording. Deliberately strict — a false yes is
    /// the 2026-09-16 incident (one side of a call transcribed), a false no costs nothing but
    /// the fast path — so all four must hold, read after `drain()`:
    ///
    ///  - something was written at all;
    ///  - no buffer was refused for its sample format (`unsupported`);
    ///  - no buffer arrived after its block had already gone out (`late`) — with a 1 s emit
    ///    delay that means a source stalled for longer than that and its audio was dropped;
    ///  - every source that produced raw buffers also reached the mix, and the mix covers the
    ///    timeline those sources wrote (a writer that stopped accepting blocks would otherwise
    ///    leave a short mix behind a healthy-looking verdict).
    ///
    /// `raw` is each source's raw buffer count.
    public func healthy(raw: [Int]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard buffersWritten > 0, unsupported == 0, late == 0 else { return false }
        guard newest > 0, framesWritten * 100 >= newest * 99 else { return false }
        for (i, n) in raw.enumerated() where i < accepted.count {
            if n > 0 && accepted[i] == 0 { return false }
        }
        return true
    }

    public var summary: String {
        lock.lock(); defer { lock.unlock() }
        let per = accepted.enumerated().map { "src\($0.offset)=\($0.element)" }.joined(separator: " ")
        return "mix frames=\(framesWritten) buffers=\(buffersWritten) \(per)"
            + (late > 0 ? " late=\(late)" : "") + (unsupported > 0 ? " UNSUPPORTED=\(unsupported)" : "")
    }

    // MARK: - input

    /// One source buffer. Safe from any thread.
    public func accept(_ sb: CMSampleBuffer, source: Int) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        guard pts.isValid, source >= 0, source < sources else { return }
        guard let mono = Self.mono(of: sb) else {
            lock.lock()
            unsupported += 1
            let first = !loggedUnsupported
            loggedUnsupported = true
            lock.unlock()
            if first {
                let asbd = CMSampleBufferGetFormatDescription(sb)
                    .flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
                rlog("mix: source \(source) is not 32-bit float PCM (\(asbd.map { "\($0.mBitsPerChannel)-bit, flags \($0.mFormatFlags)" } ?? "?")) — it will NOT be in the mix track")
            }
            return
        }
        place(mono.samples, rate: mono.rate, pts: pts, source: source)
    }

    /// Emit everything that is left — the segment is ending.
    public func drain() {
        lock.lock()
        flushLocked(force: true)
        lock.unlock()
    }

    // MARK: - the accumulator

    private func place(_ mono: [Float], rate: Double, pts: CMTime, source: Int) {
        guard !mono.isEmpty, rate > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        if anchor == nil { anchor = pts }
        guard let anchor else { return }
        let offset = CMTimeGetSeconds(CMTimeSubtract(pts, anchor))
        guard offset.isFinite else { return }
        let start = Int64((offset * Self.rate).rounded())
        let count = Int((Double(mono.count) * Self.rate / rate).rounded())
        guard count > 0 else { return }
        if start < accStart {
            late += 1
            return
        }
        let end = start + Int64(count)
        let needed = Int(end - accStart)
        if acc.count < needed { acc.append(contentsOf: repeatElement(0, count: needed - acc.count)) }
        let base = Int(start - accStart)
        let step = rate / Self.rate
        let last = mono.count - 1
        for k in 0..<count {
            let pos = Double(k) * step
            let i = min(Int(pos), last)
            let j = min(i + 1, last)
            let f = Float(pos - Double(i))
            acc[base + k] += mono[i] + (mono[j] - mono[i]) * f
        }
        newest = max(newest, end)
        accepted[source] += Int64(count)
        flushLocked(force: false)
    }

    /// Emit whole blocks that are older than `delay` (everything, when the segment ends).
    /// Called with the lock held.
    private func flushLocked(force: Bool) {
        var until = force ? newest : newest - Int64(Self.delay * Self.rate)
        // A source that went quiet for a long time must not make this grow without end.
        let cap = accStart + Int64(Self.maxBufferedSeconds * Self.rate)
        if newest > cap { until = max(until, cap) }
        while accStart < until {
            let n = min(Self.block, Int(until - accStart), acc.count)
            guard n > 0 else { return }
            guard emitLocked(count: n) else { return }   // the writer is not ready — keep it
        }
    }

    /// One block: limiter, stereo PCM, append. Returns false when the writer refused it (it is
    /// left in the accumulator for the next flush). Called with the lock held.
    private func emitLocked(count n: Int) -> Bool {
        var peak: Float = 0
        for k in 0..<n { peak = max(peak, abs(acc[k])) }
        let wanted = peak > Self.ceiling ? Self.ceiling / peak : 1
        if wanted < limiterGain { limiterGain = wanted } else { limiterGain = min(1, limiterGain * 1.05) }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(n)),
              let chans = pcm.floatChannelData else { return false }
        pcm.frameLength = AVAudioFrameCount(n)
        let from = appliedGain
        let step = (limiterGain - from) / Float(n)
        var g = from
        for k in 0..<n {
            g += step
            let v = acc[k] * g
            let c = v > 0.98 ? 0.98 : (v < -0.98 ? -0.98 : v)
            chans[0][k] = c
            chans[1][k] = c
        }
        appliedGain = limiterGain
        guard let anchor,
              let sb = Self.sampleBuffer(pcm, pts: CMTimeAdd(anchor, CMTime(value: accStart, timescale: CMTimeScale(Self.rate))))
        else { return false }
        guard emit(sb) else { return false }
        acc.removeFirst(n)
        accStart += Int64(n)
        framesWritten += Int64(n)
        buffersWritten += 1
        return true
    }

    // MARK: - CoreMedia plumbing

    struct Mono {
        let samples: [Float]
        let rate: Double
    }

    /// Every channel of a 32-bit-float PCM buffer, averaged. nil for anything else — the mixer
    /// refuses to guess at a format rather than write silence.
    static func mono(of sb: CMSampleBuffer) -> Mono? {
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0,
              let fd = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              asbd.mBitsPerChannel == 32,
              asbd.mChannelsPerFrame > 0
        else { return nil }
        let channels = Int(asbd.mChannelsPerFrame)
        let size = MemoryLayout<AudioBufferList>.size + (channels - 1) * MemoryLayout<AudioBuffer>.size
        let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let listPtr = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: nil,
            bufferListOut: listPtr,
            bufferListSize: size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &block) == noErr
        else { return nil }
        _ = block   // held until the samples are copied out
        let list = UnsafeMutableAudioBufferListPointer(listPtr)
        var out = [Float](repeating: 0, count: frames)
        var contributing = 0
        for buffer in list {
            guard let data = buffer.mData else { continue }
            let perBuffer = Int(buffer.mNumberChannels)
            guard perBuffer > 0 else { continue }
            let ptr = data.bindMemory(to: Float.self, capacity: frames * perBuffer)
            let available = min(frames, Int(buffer.mDataByteSize) / (4 * perBuffer))
            for c in 0..<perBuffer {
                for k in 0..<available { out[k] += ptr[k * perBuffer + c] }
            }
            contributing += perBuffer
        }
        guard contributing > 0 else { return nil }
        if contributing > 1 {
            let scale = 1 / Float(contributing)
            for k in 0..<frames { out[k] *= scale }
        }
        return Mono(samples: out, rate: asbd.mSampleRate > 0 ? asbd.mSampleRate : Self.rate)
    }

    /// PCM buffer → CMSampleBuffer at an explicit PTS. `dataReady` is set LAST: a buffer that
    /// is appended before it fails every append and takes the whole writer to `.failed`
    /// ("Cannot Encode Media") — the same lesson `MicCapture.sampleBuffer` carries.
    public static func sampleBuffer(_ buf: AVAudioPCMBuffer, pts: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buf.format.sampleRate)),
            presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: buf.format.formatDescription,
            sampleCount: CMItemCount(buf.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sb) == noErr, let sb
        else { return nil }
        guard CMSampleBufferSetDataBufferFromAudioBufferList(
            sb, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, bufferList: buf.audioBufferList) == noErr
        else { return nil }
        CMSampleBufferSetDataReady(sb)
        return sb
    }
}
