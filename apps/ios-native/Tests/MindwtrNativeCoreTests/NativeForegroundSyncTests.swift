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

    private func host(backend: String?) throws -> (CoreHost, ForegroundSyncReadState) {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        var values = ["unknown": "preserve 🧠"]
        if let backend { values["@mindwtr_sync_backend"] = backend }
        try Data(json(values).utf8).write(to: manifest)
        return makeHost()
    }

    private func makeHost() -> (CoreHost, ForegroundSyncReadState) {
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
        XCTAssertEqual(options.compactMap { $0["option"] as? String }, ["off", "webdav", "selfhosted"])
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

    private func assertStoredSkip(backend: String?, command: String = "syncStored") async throws {
        let (host, state) = try host(backend: backend)
        let before = try Data(contentsOf: manifest)
        _ = try await host.start()
        let expected: [String: Any] = ["ok": true, "value": ["success": true, "skipped": true]]
        let reply = try object(await host.foregroundSync(command: command, requestJSON: "{}"))
        XCTAssertEqual(try json(reply), try json(expected), "The stored result contains only primitive booleans")
        XCTAssertTrue(state.recorded.isEmpty, "An unconfigured stored cycle never asks for a secret")
        XCTAssertEqual(try Data(contentsOf: manifest), before, "The no-op leaves every stored value and its encoding unchanged")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("core.sqlite.pending.json").path))
        await host.close()

        // Recreate against the existing bytes, without reseeding the manifest.
        let (cold, coldState) = makeHost()
        _ = try await cold.start()
        let coldReply = try object(await cold.foregroundSync(command: command, requestJSON: "{}"))
        XCTAssertEqual(try json(coldReply), try json(expected))
        XCTAssertTrue(coldState.recorded.isEmpty)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        await cold.close()
    }

    func testStoredOffSkipsWithoutNetworkSecretsOrConfigurationWritesAcrossColdOpen() async throws {
        try await assertStoredSkip(backend: "off")
    }

    func testStoredAbsentBackendSkipsWithoutCreatingConfigurationAcrossColdOpen() async throws {
        try await assertStoredSkip(backend: nil)
    }

    func testResumeOffSkipsWithoutNetworkSecretsOrConfigurationWritesAcrossColdOpen() async throws {
        try await assertStoredSkip(backend: "off", command: "syncResume")
    }

    func testResumeAbsentBackendSkipsWithoutCreatingConfigurationAcrossColdOpen() async throws {
        try await assertStoredSkip(backend: nil, command: "syncResume")
    }

    func testStoredRequestRejectsSuppliedFieldsBeforeWork() async throws {
        let (host, state) = try host(backend: "webdav")
        _ = try await host.start()
        let before = try Data(contentsOf: manifest)
        for command in ["syncStored", "syncResume"] {
            for input in ["[]", "null", "{\"manual\":false}", "{\"revision\":\"synthetic\"}",
                          "{\"webdav\":{\"url\":\"https://native-fixture.invalid/data.json\",\"password\":\"synthetic-only\"}}"] {
                do {
                    _ = try await host.foregroundSync(command: command, requestJSON: input)
                    XCTFail("Stored configuration cannot be overridden by request fields")
                } catch {
                    XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
                }
                XCTAssertTrue(state.recorded.isEmpty)
                XCTAssertEqual(try Data(contentsOf: manifest), before)
            }
        }
        await host.close()
    }

    func testStoredUnsupportedProviderIsRefusedWithoutRewritingOrReadingSecrets() async throws {
        let (host, state) = try host(backend: "cloudkit")
        let before = try Data(contentsOf: manifest)
        _ = try await host.start()
        for command in ["syncStored", "syncResume"] {
            let response = try object(await host.foregroundSync(command: command, requestJSON: "{}"))
            XCTAssertEqual(response["ok"] as? Bool, false)
            XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "ACTION_FAILED")
        }
        XCTAssertTrue(state.recorded.isEmpty)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        await host.close()
    }

    func testIsolatedUIHostKeepsCredentialsInItsExactTestNamespace() async throws {
        #if !os(iOS)
        throw XCTSkip("Requires an entitled iOS app host; macOS uses a different Keychain implementation")
        #else
        let owner = UUID(), other = UUID()
        let account = Data("mindwtr_webdav_password".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "mindwtr.native-keychain.fixture." + owner.uuidString.lowercased() + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var seed = query
        seed[kSecValueData as String] = Data(("isolated-" + owner.uuidString).utf8)
        seed[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(seed as CFDictionary, nil), errSecSuccess)
        defer {
            let status = SecItemDelete(query as CFDictionary)
            XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound)
        }
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off"]).utf8).write(to: manifest)
        for id in [owner, other, owner] {
            let host = CoreHost(databaseURL: root.appendingPathComponent("core.sqlite"), bundleURL: bundle,
                                deviceStorage: (containerURL: container, bundleIdentifier: namespace), isolatedTestID: id)
            addTeardownBlock { await host.close() }
            _ = try await host.start()
            _ = try await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}")
            _ = try await host.foregroundSync(command: "selectSyncBackend", requestJSON:
                json(["requestId": UUID().uuidString.lowercased(), "option": "webdav"]))
            let reply = try object(await host.foregroundSync(command: "syncSettings", requestJSON: "{}"))
            let model = try XCTUnwrap(reply["value"] as? [String: Any])
            let panel = try XCTUnwrap(model["panel"] as? [String: Any])
            let password = try XCTUnwrap(panel["password"] as? [String: Any])
            let mask = try XCTUnwrap(password["mask"] as? String)
            XCTAssertTrue(mask.isEmpty == (id == other), "Only the matching isolated host can see its stored credential")
            await host.close()
        }
        #endif
    }
}
