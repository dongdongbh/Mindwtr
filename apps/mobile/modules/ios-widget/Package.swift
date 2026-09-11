// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "MindwtrWidgetActionStore",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "MindwtrWidgetActionStore",
            targets: ["MindwtrWidgetActionStore"]
        ),
    ],
    targets: [
        .target(
            name: "MindwtrWidgetActionStore",
            path: "ios",
            exclude: [
                "MindwtrIosWidget.podspec",
                "MindwtrIosWidgetModule.swift",
            ],
            sources: ["MindwtrWidgetActionStore.swift"]
        ),
        .testTarget(
            name: "MindwtrWidgetActionStoreTests",
            dependencies: ["MindwtrWidgetActionStore"],
            path: "tests"
        ),
    ]
)
