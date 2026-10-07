import XCTest
@testable import RecorderCore

/// The pure pieces of the post-recording echo cleanup (0.3.24): delay search, the exact
/// resamplers, the limiter. The file rewrite itself is exercised by
/// `recorder-poc --selftest-echo … && recorder-poc --clean …` (see the README).
final class EchoCleanupTests: XCTestCase {
    /// Band-limited noise: what the correlation is good at, what speech roughly is.
    private func noise(_ n: Int, seed: UInt64) -> [Float] {
        var s = seed
        var out = [Float](repeating: 0, count: n)
        var lp: Float = 0
        for i in 0..<n {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            let white = Float(Int64(bitPattern: s) >> 40) / Float(1 << 23)
            lp += 0.3 * (white - lp)
            out[i] = lp
        }
        return out
    }

    func testNccFindsTheDelayOfAnAttenuatedCopy() {
        let r = Int(EchoCleanup.analysisRate)
        let far = noise(12 * r, seed: 1)
        let delay = Int(0.137 * Double(r))          // 137 ms, like laptop speakers over Bluetooth
        let n = 8 * r
        let maxLag = Int(EchoCleanup.maxLagS * Double(r)), minLag = Int(EchoCleanup.minLagS * Double(r))
        // mic = 0.4 × far delayed + a louder uncorrelated near end
        let near = noise(n, seed: 2)
        let start = maxLag + 100                      // mic window begins here in `far` time
        var mic = [Float](repeating: 0, count: n)
        for i in 0..<n { mic[i] = 0.4 * far[start + i - delay] + 0.8 * near[i] }
        // system window = far from (start − maxLag) for n + lags − 1 samples
        let sys = Array(far[(start - maxLag)..<(start - maxLag + n + maxLag - minLag)])
        let (peak, lag) = EchoCleanup.Echo.ncc(mic: mic, system: sys, maxLag: maxLag, minLag: minLag)
        XCTAssertEqual(lag, delay, accuracy: 1)
        XCTAssertGreaterThan(peak, 0.3)
        XCTAssertLessThan(peak, 0.7)
    }

    func testNccIsNearZeroWithoutEcho() {
        let r = Int(EchoCleanup.analysisRate)
        let n = 8 * r
        let maxLag = Int(EchoCleanup.maxLagS * Double(r)), minLag = Int(EchoCleanup.minLagS * Double(r))
        let mic = noise(n, seed: 3)
        let sys = noise(n + maxLag - minLag, seed: 4)
        let (peak, _) = EchoCleanup.Echo.ncc(mic: mic, system: sys, maxLag: maxLag, minLag: minLag)
        XCTAssertLessThan(peak, EchoCleanup.echoPeakThreshold / 2)
    }

    func testDecimatorAndUpsamplerAreExactInLengthAndRoundTripATone() {
        let dec = EchoCleanup.Decimator(factor: 3)
        let up = EchoCleanup.Upsampler3()
        let n48 = 48_000
        var x = [Float](repeating: 0, count: n48)
        for i in 0..<n48 { x[i] = sinf(2 * .pi * 1_000 * Float(i) / 48_000) }   // 1 kHz, well inside the band
        var y: [Float] = []
        var z: [Float] = []
        // Block sizes that are NOT multiples of anything convenient, to exercise the carry.
        var at = 0
        for size in [4_800, 7_200, 9_600, 12_000, 14_400] {
            let blk = Array(x[at..<(at + size)])
            let d = dec.process(blk)
            XCTAssertEqual(d.count, size / 3)
            let u = up.process(d)
            XCTAssertEqual(u.count, size)
            y.append(contentsOf: d); z.append(contentsOf: u)
            at += size
        }
        XCTAssertEqual(y.count, n48 / 3)
        XCTAssertEqual(z.count, n48)
        // Round trip: same tone, same level, delayed by the two filters' group delay.
        let delay = EchoCleanup.Upsampler3.roundTripDelay
        var err: Float = 0, ref: Float = 0
        for i in 10_000..<40_000 {
            err += (z[i + delay] - x[i]) * (z[i + delay] - x[i])
            ref += x[i] * x[i]
        }
        XCTAssertLessThan(err / ref, 0.002, "round-trip error \(err / ref)")
    }

    func testLowpassHasUnityDCGain() {
        let h = EchoCleanup.lowpass()
        XCTAssertEqual(h.reduce(0, +), 1, accuracy: 1e-5)
        XCTAssertEqual(EchoCleanup.lowpass(gain: 3).reduce(0, +), 3, accuracy: 1e-4)
    }

    func testLimiterHoldsTheCeiling() {
        var gain: Float = 1
        var x = [Float](repeating: 0, count: 10)
        x[3] = 2.0; x[4] = -1.5; x[9] = 0.5
        EchoCleanup.Rewrite.limit(&x, gain: &gain)
        XCTAssertEqual(x[3], 0.95, accuracy: 1e-6)
        // Gain dropped to 0.475 on the first peak, so the next sample is scaled, not clipped.
        XCTAssertEqual(x[4], -1.5 * 0.475, accuracy: 1e-4)
        XCTAssertLessThanOrEqual(abs(x[4]), 0.95)
        XCTAssertLessThan(abs(x[9]), 0.5)          // still attenuated moments later
        XCTAssertLessThan(gain, 1)
    }
}
