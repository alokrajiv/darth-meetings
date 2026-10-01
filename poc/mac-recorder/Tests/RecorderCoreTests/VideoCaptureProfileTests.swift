import XCTest
import AVFoundation
import CoreMedia
import CoreVideo
import ScreenCaptureKit
@testable import RecorderCore

/// 0.3.21: the two capture profiles produce the SCK configuration the brief asks for, and both
/// keep the 0.3.20 colour pinning and the part's pixel size.
final class VideoCaptureProfileTests: XCTestCase {
    func testNormalProfileIsThe0320Stream() {
        let c = VideoCaptureProfile.normal.streamConfiguration(width: 2304, height: 1472)
        XCTAssertEqual(c.width, 2304); XCTAssertEqual(c.height, 1472)
        XCTAssertTrue(c.scalesToFit)
        XCTAssertEqual(c.minimumFrameInterval, CMTime(value: 1, timescale: 5))
        XCTAssertEqual(c.pixelFormat, kCVPixelFormatType_32BGRA)
        XCTAssertTrue(c.showsCursor)
        XCTAssertEqual(c.queueDepth, 6)
        XCTAssertFalse(c.capturesAudio)
        XCTAssertEqual(c.colorSpaceName, CGColorSpace.sRGB)
        XCTAssertEqual(c.colorMatrix, CGDisplayStream.yCbCrMatrix_ITU_R_709_2)
        XCTAssertEqual(VideoCaptureProfile.normal.videoBitRate, Recorder.defaultVideoBitRate)
        XCTAssertEqual(VideoCaptureProfile.normal.pixelFormatName, "BGRA")
    }

    func testEasedProfile() {
        let c = VideoCaptureProfile.eased.streamConfiguration(width: 2304, height: 1472)
        XCTAssertEqual(c.width, 2304); XCTAssertEqual(c.height, 1472)   // the part's size, never a new one
        XCTAssertTrue(c.scalesToFit)
        XCTAssertEqual(c.minimumFrameInterval, CMTime(value: 1, timescale: 2))
        XCTAssertEqual(c.pixelFormat, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        XCTAssertFalse(c.showsCursor)
        XCTAssertEqual(c.queueDepth, 4)
        XCTAssertFalse(c.capturesAudio)
        XCTAssertEqual(c.colorSpaceName, CGColorSpace.sRGB)
        XCTAssertEqual(c.colorMatrix, CGDisplayStream.yCbCrMatrix_ITU_R_709_2)
        XCTAssertEqual(VideoCaptureProfile.eased.videoBitRate, 1_000_000)
        XCTAssertEqual(VideoCaptureProfile.eased.pixelFormatName, "420v")
    }

    /// The writer's colour tags do not depend on the profile: one colour header per part.
    func testWriterSettingsKeep709() {
        let s = Recorder.videoSettings(width: 1280, height: 720, fps: 5, bitRate: VideoCaptureProfile.eased.videoBitRate)
        let col = s[AVVideoColorPropertiesKey] as? [String: String]
        XCTAssertEqual(col?[AVVideoYCbCrMatrixKey], AVVideoYCbCrMatrix_ITU_R_709_2)
        let comp = s[AVVideoCompressionPropertiesKey] as? [String: Any]
        XCTAssertEqual(comp?[AVVideoAverageBitRateKey] as? Int, 1_000_000)
    }
}
