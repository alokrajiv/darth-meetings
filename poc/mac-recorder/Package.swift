// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "recorder-poc",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "RecorderCore",
            path: "Sources/RecorderCore",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
            ]
        ),
        .executableTarget(name: "recorder-poc", dependencies: ["RecorderCore"], path: "Sources/recorder-poc"),
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
