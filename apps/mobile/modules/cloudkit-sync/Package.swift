// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "CloudKitAttachmentErrorClassifier",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "CloudKitAttachmentErrorClassifier",
            targets: ["CloudKitAttachmentErrorClassifier"]
        ),
    ],
    targets: [
        .target(
            name: "CloudKitAttachmentErrorClassifier",
            path: "ios",
            exclude: [
                "CloudKitChangeTracker.swift",
                "CloudKitRecordMapper.swift",
                "CloudKitSync.podspec",
                "CloudKitSyncAppDelegateSubscriber.swift",
                "CloudKitSyncManager.swift",
                "CloudKitSyncModule.swift",
            ],
            sources: ["CloudKitAttachmentErrorClassifier.swift"]
        ),
        .testTarget(
            name: "CloudKitAttachmentErrorClassifierTests",
            dependencies: ["CloudKitAttachmentErrorClassifier"],
            path: "tests"
        ),
    ]
)
