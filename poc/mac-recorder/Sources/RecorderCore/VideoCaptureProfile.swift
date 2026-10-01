import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics

/// 0.3.21 — the SCK video stream's load knobs, as one value per capture profile.
///
/// Everything here can be changed on a LIVE stream with `SCStream.updateConfiguration(_:)`
/// (frame interval, pixel format, cursor, queue depth) — the pixel size cannot (the writer's
/// size is fixed when the part is created), so it is not part of a profile. The writer
/// (`Recorder`) uses a pixel-buffer adaptor with no source attributes and no format hint, so a
/// mid-part BGRA → 420v switch is accepted; the encoded track is 4:2:0 either way.
///
/// `videoBitRate` is NOT live: a writer's bit rate is fixed at creation. It is used only when a
/// part is created anyway (a share start, a window-gone fallback, a writer-error roll) while the
/// profile is eased — nothing rolls a part for the bit rate alone.
public struct VideoCaptureProfile: Equatable {
    public var name: String
    public var fps: Int
    public var pixelFormat: OSType
    public var showsCursor: Bool
    public var queueDepth: Int
    public var videoBitRate: Int

    public init(name: String, fps: Int, pixelFormat: OSType, showsCursor: Bool, queueDepth: Int, videoBitRate: Int) {
        self.name = name; self.fps = fps; self.pixelFormat = pixelFormat; self.showsCursor = showsCursor
        self.queueDepth = queueDepth; self.videoBitRate = videoBitRate
    }

    /// What every recording ran with through 0.3.20: 5 fps BGRA, cursor, 6 surfaces, 1.5 Mbps.
    public static let normal = VideoCaptureProfile(name: "normal", fps: 5, pixelFormat: kCVPixelFormatType_32BGRA,
                                                   showsCursor: true, queueDepth: 6, videoBitRate: Recorder.defaultVideoBitRate)
    /// 0.3.21: 2 fps, 4:2:0 video-range (half the bytes per frame of BGRA and no conversion
    /// before the encoder), no cursor compositing, 4 surfaces. Not 3 (SCK's minimum): the
    /// Recorder holds `lastPixelBuffer` for idle duplicates, the encoder has frames in flight
    /// and the preview holds one while it converts.
    public static let eased = VideoCaptureProfile(name: "eased", fps: 2, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                                  showsCursor: false, queueDepth: 4, videoBitRate: 1_000_000)

    /// The full video-stream configuration for a `width`×`height` part. `updateConfiguration`
    /// REPLACES the whole configuration, so the live switch sends one of these too — the size
    /// must be the part's pinned size, never a new one.
    public func streamConfiguration(width: Int, height: Int) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        cfg.width = width; cfg.height = height
        cfg.scalesToFit = true      // letterbox a differently-shaped source into the pinned size
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        cfg.pixelFormat = pixelFormat
        // 0.3.20: pin the colour pipeline to what the writer tags (Rec. 709): sRGB pixels in,
        // the 709 matrix for the YCbCr conversion SCK does on the way (420v uses it directly).
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        cfg.showsCursor = showsCursor
        cfg.queueDepth = queueDepth
        cfg.capturesAudio = false
        return cfg
    }

    /// "420v" / "BGRA" — the FourCC, for logs and events.
    public var pixelFormatName: String {
        let b = [24, 16, 8, 0].map { UInt8((pixelFormat >> $0) & 0xff) }
        return String(bytes: b, encoding: .ascii) ?? "\(pixelFormat)"
    }
}
