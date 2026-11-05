// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MindwtrWhisperEngine",
    platforms: [.iOS(.v16)],
    products: [.library(name: "MindwtrWhisperEngine", targets: ["MindwtrWhisperEngine"])],
    targets: [
        .binaryTarget(name: "rnwhisper", path: "Vendor/rnwhisper.xcframework"),
        .target(name: "MindwtrWhisperEngine", dependencies: [.target(name: "rnwhisper", condition: .when(platforms: [.iOS]))],
                resources: [.copy("Resources/WhisperNotices.txt")]),
        .testTarget(name: "MindwtrWhisperEngineTests", dependencies: ["MindwtrWhisperEngine"], resources: [.copy("Fixtures")]),
    ]
)
