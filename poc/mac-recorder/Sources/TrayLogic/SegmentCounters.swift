/// 0.3.20 — capture counters that live for the whole RECORDING (the microphone survives part
/// rolls; so does the CoreAudio overload listener on it), turned into per-SEGMENT numbers for
/// `segment_closed`. The writer's own counters need no such thing: every part has a new writer.
///
/// The controller keeps a baseline taken when a part starts; at the cut it reads the totals,
/// ships `delta(since: baseline)` with the closing part, and the totals become the next part's
/// baseline. A new MicCapture (a recording always starts one) starts from zero, so a total
/// smaller than the baseline means "counted from a fresh object" and the total itself is the
/// delta.
public struct SegmentCounters: Equatable {
    public var micGapsFilled: Int
    public var micGapSeconds: Double
    public var coreaudioOverloads: Int

    public init(micGapsFilled: Int = 0, micGapSeconds: Double = 0, coreaudioOverloads: Int = 0) {
        self.micGapsFilled = micGapsFilled
        self.micGapSeconds = micGapSeconds
        self.coreaudioOverloads = coreaudioOverloads
    }

    public static let zero = SegmentCounters()

    public func delta(since base: SegmentCounters) -> SegmentCounters {
        SegmentCounters(
            micGapsFilled: micGapsFilled >= base.micGapsFilled ? micGapsFilled - base.micGapsFilled : micGapsFilled,
            micGapSeconds: micGapSeconds >= base.micGapSeconds ? micGapSeconds - base.micGapSeconds : micGapSeconds,
            coreaudioOverloads: coreaudioOverloads >= base.coreaudioOverloads ? coreaudioOverloads - base.coreaudioOverloads : coreaudioOverloads)
    }

    /// The `segment_closed` fields.
    public var json: [String: Any] {
        ["mic_gaps_filled_delta": micGapsFilled,
         "mic_gap_seconds_delta": (micGapSeconds * 100).rounded() / 100,
         "coreaudio_overloads": coreaudioOverloads]
    }
}

/// 0.3.20 — "one event per N seconds at most", for `audio_overload` (an overloading IO thread
/// can fire hundreds of times a second). Pure and clock-free: the caller passes `now`.
public struct RateLimiter {
    public let interval: Double
    private var last: Double?
    /// Hits swallowed since the last one that went through.
    public private(set) var suppressed = 0

    public init(interval: Double) { self.interval = interval }

    /// True → emit now (and `suppressed` is how many were swallowed before it; reset after).
    public mutating func allow(now: Double) -> (Bool, suppressed: Int) {
        if let last, now - last < interval {
            suppressed += 1
            return (false, suppressed)
        }
        let s = suppressed
        suppressed = 0
        last = now
        return (true, s)
    }
}
