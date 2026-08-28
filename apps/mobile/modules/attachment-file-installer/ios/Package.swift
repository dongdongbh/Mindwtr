// swift-tools-version: 5.10

import PackageDescription

let package = Package(
  name: "AttachmentFileInstallerEngine",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [
    .library(
      name: "AttachmentFileInstallerEngine",
      targets: ["AttachmentFileInstallerEngine"]
    ),
  ],
  targets: [
    .target(
      name: "AttachmentFileInstallerEngine",
      path: ".",
      exclude: ["AttachmentFileInstaller.podspec", "Tests"],
      sources: ["AttachmentFileInstallerModule.swift"]
    ),
    .testTarget(
      name: "AttachmentFileInstallerEngineTests",
      dependencies: ["AttachmentFileInstallerEngine"],
      path: "Tests"
    ),
  ]
)
