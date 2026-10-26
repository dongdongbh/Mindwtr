// swift-tools-version: 5.10

import PackageDescription

// The root entry gives SwiftPM a distinct identity from NativeCore's other ios dependency.

let package = Package(
  name: "SyncFileLockEngine",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [.library(name: "SyncFileLockEngine", targets: ["SyncFileLockEngine"])],
  targets: [
    .target(
      name: "SyncFileLockEngine",
      path: "ios",
      exclude: ["Package.swift", "SyncFileLock.podspec", "Tests"],
      sources: ["SyncFileLockModule.swift", "NativeFileSyncReadOwner.swift", "NativeFileSyncSession.swift"]
    ),
    .testTarget(
      name: "SyncFileLockEngineTests",
      dependencies: ["SyncFileLockEngine"],
      path: "ios/Tests",
      linkerSettings: [.linkedFramework("JavaScriptCore", .when(platforms: [.macOS, .iOS]))]
    ),
  ]
)
