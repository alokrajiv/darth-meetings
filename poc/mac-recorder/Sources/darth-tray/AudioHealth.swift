import AVFoundation
import CoreMedia
import RecorderCore

/// Per-track audio level meter (0.2.6). Cheap: one peak + RMS per buffer, folded into a
/// 5-second window of per-second buckets. "Audible" = window RMS above −60 dBFS.
///
/// Why: Atira's 53-minute Teams call on 2026-09-16 had a system track that was silent from
/// the first second to the last (RMS −inf) and nobody noticed until AssemblyAI said "no
/// spoken audio". The tray now knows within 30 s.
final class LevelMeter {
    static let audibleDb: Float = -60
    private let lock = NSLock()
    private let startedAt = Date()
    private var buckets: [(sec: Int, rms: Float)] = Array(repeating: (-1, 0), count: 5)
    private(set) var buffers = 0
    /// Session maximum, linear 0…1.
    private(set) var peak: Float = 0
    private(set) var firstBufferAt: Date?
    private var lastAudibleAt: Date?
    private var lastAudibleSec = -1
    private(set) var audibleSeconds = 0

    /// Called from the capture thread.
    func note(peak p: Float, rms r: Float) {
        let now = Date()
        lock.lock(); defer { lock.unlock() }
        buffers += 1
        if firstBufferAt == nil { firstBufferAt = now }
        if p > peak { peak = p }
        let sec = Int(now.timeIntervalSince(startedAt))
        let i = ((sec % 5) + 5) % 5
        if buckets[i].sec != sec { buckets[i] = (sec, r) } else if r > buckets[i].rms { buckets[i].rms = r }
        if LevelMeter.db(r) > LevelMeter.audibleDb {
            lastAudibleAt = now
            if sec != lastAudibleSec { lastAudibleSec = sec; audibleSeconds += 1 }
        }
    }

    static func db(_ linear: Float) -> Float { linear > 0 ? 20 * log10f(linear) : -120 }

    /// Loudest RMS of the last 5 s, dBFS (−120 = nothing).
    var levelDb: Float {
        lock.lock(); defer { lock.unlock() }
        let sec = Int(Date().timeIntervalSince(startedAt))
        var m: Float = 0
        for b in buckets where b.sec >= 0 && sec - b.sec < 5 { m = max(m, b.rms) }
        return LevelMeter.db(m)
    }
    var audible: Bool { levelDb > LevelMeter.audibleDb }
    /// Seconds since the last audible buffer — since the meter started when nothing was ever heard.
    var secondsSinceAudible: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return Date().timeIntervalSince(lastAudibleAt ?? startedAt)
    }
    var everAudible: Bool { lock.lock(); defer { lock.unlock() }; return lastAudibleAt != nil }
    var peakDb: Float { LevelMeter.db(peak) }

    func snapshot() -> [String: Any] {
        let lvl = levelDb
        return [
            "level_db": Double((lvl * 10).rounded() / 10), "audible": lvl > LevelMeter.audibleDb,
            "silent_s": Int(secondsSinceAudible), "audible_s": audibleSeconds,
            "peak_db": Double((peakDb * 10).rounded() / 10), "buffers": buffers,
        ]
    }

    // MARK: measuring

    /// Peak + RMS of a Float32 PCM CMSampleBuffer (what ScreenCaptureKit delivers), any channel
    /// layout. nil for other formats (they are only counted, not measured).
    static func measure(_ sb: CMSampleBuffer) -> (peak: Float, rms: Float)? {
        guard let fd = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return nil }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return nil }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: abl, bufferListSize: needed,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard st == noErr else { return nil }
        var peak: Float = 0, sum: Double = 0, n = 0
        for buf in UnsafeMutableAudioBufferListPointer(abl) {
            guard let data = buf.mData else { continue }
            let count = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.bindMemory(to: Float.self, capacity: count)
            for i in 0..<count { let v = p[i]; let a = abs(v); if a > peak { peak = a }; sum += Double(v * v) }
            n += count
        }
        withExtendedLifetime(block) {}
        guard n > 0 else { return nil }
        return (peak, Float(sqrt(sum / Double(n))))
    }

    static func measure(_ buf: AVAudioPCMBuffer) -> (peak: Float, rms: Float)? {
        guard let chans = buf.floatChannelData else { return nil }
        let frames = Int(buf.frameLength), nch = Int(buf.format.channelCount)
        guard frames > 0, nch > 0 else { return nil }
        var peak: Float = 0, sum: Double = 0
        for c in 0..<nch {
            let p = chans[c]
            for i in 0..<frames { let v = p[i]; let a = abs(v); if a > peak { peak = a }; sum += Double(v * v) }
        }
        return (peak, Float(sqrt(sum / Double(frames * nch))))
    }
}

/// The tail of tray.log, for the `log_excerpt` event shipped when a recording ends unwell —
/// the server then has the context without asking the person for the file.
enum LogTail {
    static let path = (("~/Library/Logs/DarthRecorder/tray.log") as NSString).expandingTildeInPath
    static func excerpt(lines maxLines: Int = 60, maxBytes: Int = 8_000) -> [String] {
        guard let fh = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        let from = size > 32_000 ? size - 32_000 : 0
        try? fh.seek(toOffset: from)
        guard let data = try? fh.readToEnd(), let text = String(data: data, encoding: .utf8) else { return [] }
        var out = Array(text.split(separator: "\n", omittingEmptySubsequences: true).suffix(maxLines).map(String.init))
        var bytes = out.reduce(0) { $0 + $1.utf8.count + 1 }
        while bytes > maxBytes, !out.isEmpty { bytes -= out.removeFirst().utf8.count + 1 }
        return out
    }
}
