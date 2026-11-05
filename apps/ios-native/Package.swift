// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MindwtrNativeCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "MindwtrNativeCore", targets: ["MindwtrNativeCore"])],
    dependencies: [.package(name: "AttachmentFileInstallerEngine", path: "../mobile/modules/attachment-file-installer/ios"), .package(path: "../mobile/modules/sync-file-lock"), .package(path: "../mobile/modules/cloudkit-sync"), .package(path: "../mobile/modules/watch-connectivity"), .package(path: "../mobile/modules/whisper-engine")],
    targets: [
        .binaryTarget(name: "QuickCryptoOpenSSL",
                      url: "https://github.com/margelo/react-native-quick-crypto/releases/download/openssl-apple-3.6.2/QuickCryptoOpenSSL-3.6.2.zip",
                      checksum: "a50e3c8473b0526b159ad8d105e97a90d1153a4a230388cc731ee23a7d0ad3a4"),
        .target(name: "CMindwtrArgon2", dependencies: ["QuickCryptoOpenSSL"], publicHeadersPath: "include",
                cSettings: [.headerSearchPath("private")]),
        .target(name: "SQLiteSupport", publicHeadersPath: "include", linkerSettings: [.linkedLibrary("sqlite3")]),
        .target(name: "MindwtrNativeCore", dependencies: ["SQLiteSupport", "CMindwtrArgon2", .product(name: "AttachmentFileInstallerEngine", package: "AttachmentFileInstallerEngine"), .product(name: "SyncFileLockEngine", package: "sync-file-lock"), .product(name: "NativeCloudKitTransport", package: "cloudkit-sync"), .product(name: "MindwtrWatchPayloadValidation", package: "watch-connectivity"), .product(name: "MindwtrWhisperEngine", package: "whisper-engine", condition: .when(platforms: [.iOS]))], resources: [.copy("Resources/CryptoNotices.txt"), .copy("Resources/sandbox-host.js")], linkerSettings: [.linkedFramework("JavaScriptCore")]),
        .testTarget(name: "MindwtrNativeCoreTests", dependencies: ["MindwtrNativeCore"]),
    ]
)
