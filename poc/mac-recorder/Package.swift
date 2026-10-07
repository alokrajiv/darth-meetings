// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "recorder-poc",
    platforms: [.macOS(.v14)],
    targets: [
        // speexdsp 1.2.1 (BSD, vendored): the MDF echo canceller + preprocessor that
        // `EchoCleanup` runs over a finished recording (0.3.24). Float build, kiss FFT.
        .target(
            name: "CSpeexDSP",
            path: "Sources/CSpeexDSP",
            exclude: ["COPYING"],
            publicHeadersPath: "include",
            cSettings: [.define("HAVE_CONFIG_H"), .headerSearchPath(".")]
        ),
        .target(
            name: "RecorderCore",
            dependencies: ["CSpeexDSP"],
            path: "Sources/RecorderCore",
            linkerSettings: [
                .linkedFramework("Accelerate"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
            ]
        ),
        .executableTarget(name: "recorder-poc", dependencies: ["RecorderCore"], path: "Sources/recorder-poc"),
        // 0.3.21: the capture profiles' SCK stream configuration (no capture, no permission needed).
        .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"], path: "Tests/RecorderCoreTests"),
        // Objective-C @try/@catch for Swift (0.3.1): AVFoundation raises NSException for bad
        // settings, and one that escapes a main-queue block zombifies the app.
        .target(name: "ObjCTry", path: "Sources/ObjCTry", publicHeadersPath: "include"),
        // Pure decision logic with no AppKit/AVFoundation (0.3.18): unit-tested by `swift test`.
        .target(name: "TrayLogic", path: "Sources/TrayLogic"),
        .testTarget(name: "TrayLogicTests", dependencies: ["TrayLogic"], path: "Tests/TrayLogicTests"),
        .executableTarget(
            name: "darth-tray",
            dependencies: ["RecorderCore", "ObjCTry", "TrayLogic"],
            path: "Sources/darth-tray",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Network"),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
