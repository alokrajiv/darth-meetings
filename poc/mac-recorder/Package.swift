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
        .executableTarget(
            name: "darth-tray",
            dependencies: ["RecorderCore"],
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
