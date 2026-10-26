// swift-tools-version: 5.10

import PackageDescription

let package = Package(
  name: "SyncFileLockEngine",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [.library(name: "SyncFileLockEngine", targets: ["SyncFileLockEngine"])],
  targets: [
    .target(
      name: "SyncFileLockEngine",
      path: ".",
      exclude: ["SyncFileLock.podspec", "Tests"],
      sources: ["SyncFileLockModule.swift", "NativeFileSyncReadOwner.swift", "NativeFileSyncSession.swift"]
    ),
    .testTarget(
      name: "SyncFileLockEngineTests",
      dependencies: ["SyncFileLockEngine"],
      path: "Tests",
      linkerSettings: [.linkedFramework("JavaScriptCore", .when(platforms: [.macOS, .iOS]))]
    ),
  ]
)
