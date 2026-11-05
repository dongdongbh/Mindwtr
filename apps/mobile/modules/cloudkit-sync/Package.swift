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
        .library(name: "NativeCloudKitTransport", targets: ["CloudKitAttachmentErrorClassifier"]),
    ],
    targets: [
        .target(
            name: "CloudKitAttachmentErrorClassifier",
            path: "ios",
            exclude: [
                "CloudKitChangeTracker.swift",
                "CloudKitSync.podspec",
                "CloudKitSyncAppDelegateSubscriber.swift",
                "CloudKitSyncModule.swift",
            ],
            sources: [
                "CloudKitAttachmentErrorClassifier.swift",
                "CloudKitOperationTimeouts.swift",
                "CloudKitRecordMapper.swift",
                "CloudKitSyncManager.swift",
                "NativeCloudKitTransport.swift",
            ]
        ),
        .testTarget(
            name: "CloudKitAttachmentErrorClassifierTests",
            dependencies: ["CloudKitAttachmentErrorClassifier"],
            path: "tests"
        ),
    ]
)
