import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ForegroundSyncReadState: @unchecked Sendable {
    private let lock = NSLock()
    private var operations: [String] = []
    func record(_ operation: String) { lock.lock(); operations.append(operation); lock.unlock() }
    var recorded: [String] { lock.lock(); defer { lock.unlock() }; return operations }
}

private final class ForegroundSyncNoNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Opening foreground Sync settings must not access the network")
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

final class NativeForegroundSyncTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.foreground-tests"
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL {
        container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
    }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build the production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Foreground fixture bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeForegroundSyncTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Foreground fixture root is unavailable") }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }

    override func tearDownWithError() throws {
        if let root { try FileManager.default.removeItem(at: root) }
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }

    private func host(backend: String) throws -> (CoreHost, ForegroundSyncReadState) {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": backend, "unknown": "preserve 🧠"]).utf8).write(to: manifest)
        let state = ForegroundSyncReadState(), faults = HostIOFaults()
        faults.secretBeforeOperation = { operation, _ in state.record(operation) }
        faults.secretStatus = { _, _ in errSecItemNotFound }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForegroundSyncNoNetwork.self]
        faults.httpConfiguration = configuration
        let host = CoreHost(databaseURL: root.appendingPathComponent("core.sqlite"), bundleURL: bundle,
                            faults: faults, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await host.close() }
        return (host, state)
    }

    func testExplicitOpenUsesSharedSettingsWithoutStartupSyncOrConfigurationWrites() async throws {
        let (host, state) = try host(backend: "off")
        let before = try Data(contentsOf: manifest)
        _ = try await host.start()
        XCTAssertTrue(state.recorded.isEmpty)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        let opened = try object(await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        XCTAssertEqual(opened["ok"] as? Bool, true)
        let model = try XCTUnwrap(opened["value"] as? [String: Any])
        let backend = try XCTUnwrap(model["backend"] as? [String: Any])
        let options = try XCTUnwrap(backend["options"] as? [[String: Any]])
        XCTAssertEqual(options.compactMap { $0["option"] as? String }, ["off", "webdav"])
        XCTAssertFalse(state.recorded.isEmpty, "Shared settings read the existing secret adapter")
        XCTAssertTrue(state.recorded.allSatisfy { $0 == "get" })
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        let read = try object(await host.foregroundSync(command: "syncSettings", requestJSON: "{}"))
        XCTAssertEqual(read["ok"] as? Bool, true)
        let closed = try object(await host.foregroundSync(command: "closeSyncSettings", requestJSON: "{}"))
        XCTAssertEqual(closed["ok"] as? Bool, true)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
    }

    func testUnsupportedStoredProviderIsRefusedWithoutCoercionOrSecretReads() async throws {
        let (host, state) = try host(backend: "cloudkit")
        let before = try Data(contentsOf: manifest)
        _ = try await host.start()
        for command in ["openSyncSettings", "syncSettings"] {
            let response = try object(await host.foregroundSync(command: command, requestJSON: "{}"))
            XCTAssertEqual(response["ok"] as? Bool, false)
            XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "ACTION_FAILED")
        }
        XCTAssertTrue(state.recorded.isEmpty)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
    }
}
