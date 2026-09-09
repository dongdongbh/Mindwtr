// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MindwtrWatchCaptureState",
    products: [
        .library(name: "MindwtrWatchCaptureState", targets: ["MindwtrWatchCaptureState"]),
    ],
    targets: [
        .target(
            name: "MindwtrWatchCaptureState",
            path: "App",
            exclude: [
                "MindwtrWatchApp.swift",
                "MindwtrWatchIntents.swift",
                "MindwtrWatchViews.swift",
                "WatchAudioRecorder.swift",
                "WatchConnectivityModel.swift",
            ],
            sources: ["WatchOutbox.swift"]
        ),
        .target(
            name: "MindwtrWatchProtocolCore",
            path: "Shared",
            exclude: ["WatchSnapshotStore.swift"],
            sources: ["WatchProtocol.swift"]
        ),
        .testTarget(
            name: "MindwtrWatchCaptureStateTests",
            dependencies: ["MindwtrWatchCaptureState", "MindwtrWatchProtocolCore"],
            path: "Tests"
        ),
    ]
)
