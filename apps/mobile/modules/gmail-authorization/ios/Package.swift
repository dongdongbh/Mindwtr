// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "MindwtrGmailAuthorizationCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [.library(name: "MindwtrGmailAuthorizationCore", targets: ["MindwtrGmailAuthorizationCore"])],
    targets: [
        .target(name: "MindwtrGmailAuthorizationCore", path: ".", exclude: ["Tests", "MindwtrGmailAuthorizationModule.swift", "GmailWebAuthenticationBrowser.swift"],
                sources: ["GmailAuthorizationCore.swift", "GmailBoundedHTTPTransport.swift"]),
        .testTarget(name: "MindwtrGmailAuthorizationCoreTests", dependencies: ["MindwtrGmailAuthorizationCore"], path: "Tests")
    ])
