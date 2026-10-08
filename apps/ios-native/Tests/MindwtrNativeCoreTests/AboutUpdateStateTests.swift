import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class AboutUpdateNoHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var requests = 0
    static var count: Int { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requests += 1; Self.lock.unlock()
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

final class AboutUpdateStateTests: XCTestCase {
    private var root: URL!, current: NativeDeviceKV?
    private let namespace = "tech.example.mindwtr.about-update-state"
    private let available = "mindwtr-update-available", checked = "mindwtr-update-last-check", latest = "mindwtr-update-latest"
    private var container: URL { root.appendingPathComponent("device", isDirectory: true) }
    private var storage: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1", isDirectory: true) }
    private var manifest: URL { storage.appendingPathComponent("manifest.json") }
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var log: URL { root.appendingPathComponent("logs/mindwtr.log") }
    private var networkBefore = 0
    private enum Injected: Error { case failure }

    override func setUpWithError() throws {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("AboutUpdateStateTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw Injected.failure }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        try seed([available: "false", checked: "0", latest: "old", "@mindwtr_sync_backend": "off", "unknown": "  opaque 🧠\n", "external": NSNull()])
        try Data("external original 文".utf8).write(to: external)
        networkBefore = AboutUpdateNoHTTP.count
    }
    override func tearDownWithError() throws {
        current?.close(); current = nil
        XCTAssertEqual(AboutUpdateNoHTTP.count, networkBefore, "Update-state APIs never perform HTTP")
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private var external: URL {
        let name = Insecure.MD5.hash(data: Data("external".utf8)).map { String(format: "%02x", $0) }.joined()
        return storage.appendingPathComponent(name)
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func seed(_ value: [String: Any]) throws { try Data(json(value).utf8).write(to: manifest) }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func cells() throws -> NSDictionary {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? NSDictionary)
    }
    private func inode(_ url: URL) throws -> UInt64 {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw Injected.failure }; return UInt64(value.st_ino)
    }
    private func open() throws -> NativeDeviceKV {
        let value = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace); current = value; return value
    }
    private func host(configureStorage: ((NativeDeviceKV) -> Void)? = nil) throws -> CoreHost {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build actual production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw Injected.failure }
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AboutUpdateNoHTTP.self]; faults.httpConfiguration = configuration
        faults.configureDeviceStorage = configureStorage
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretBeforeOperation = { _, _ in XCTFail("Update state must not access secrets") }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Update state must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func seededHost() async throws -> CoreHost {
        let bootstrap = try host(); _ = try await bootstrap.start(); await bootstrap.close()
        do {
            let sql = try SQLiteBridge(url: database); defer { sql.close() }
            let at = "2026-10-08T00:00:00.000Z"
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('update-kept-task','Keep exact task','inbox','[]','[]','Keep notes',?,?,3,'fixture',0,0,0,0)", parametersJSON: json([at, at]))
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,createdAt,updatedAt,rev,revBy) VALUES ('update-kept-project','Keep exact Project','active','#123456',1,'[]',0,0,'Keep notes',?,?,4,'fixture')", parametersJSON: json([at, at]))
        }
        let value = try host(); _ = try await value.start(); return value
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func outcomes() throws -> [String] {
        let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-about-update-state") }.map {
            let entry = try object(String($0)), context = try XCTUnwrap(entry["context"] as? [String: String])
            XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "outcome"]))
            XCTAssertEqual(context["releaseCheck"], "v1.3.5/ios-about-update-state")
            XCTAssertEqual(entry["message"] as? String, "Native iOS About update state saved")
            return try XCTUnwrap(context["outcome"])
        }
    }

    func testAtomicResultAndOptionalTimePreserveUnknownExternalGenerationsAndNoOp() throws {
        let store = try open(), original = try Data(contentsOf: manifest), externalBytes = try Data(contentsOf: external), externalInode = try inode(external)
        var promotions = 0
        store.faults.beforePromotion = { XCTAssertEqual(try Data(contentsOf: self.manifest), original) }
        store.faults.afterPromotion = {
            promotions += 1
            let values = try self.cells()
            XCTAssertEqual(values[self.available] as? String, "true")
            XCTAssertEqual(values[self.latest] as? String, "2.0.0")
            XCTAssertEqual(values[self.checked] as? String, "1800000000000")
        }
        try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: "1800000000000")
        XCTAssertEqual(promotions, 1)
        store.faults.beforePromotion = nil; store.faults.afterPromotion = nil
        let acknowledged = try Data(contentsOf: manifest), acknowledgedInode = try inode(manifest)
        try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0")
        try store.recordAboutUpdateCheck(timestamp: "1800000000000")
        XCTAssertEqual(try Data(contentsOf: manifest), acknowledged); XCTAssertEqual(try inode(manifest), acknowledgedInode)
        try store.storeAboutUpdateResult(available: false, latestVersion: "2.0.0")
        XCTAssertEqual(try store.get(available), "false"); XCTAssertNil(try store.get(latest)); XCTAssertEqual(try store.get(checked), "1800000000000")
        XCTAssertEqual(try store.get("unknown"), "  opaque 🧠\n"); XCTAssertEqual(try store.get("external"), "external original 文")
        XCTAssertEqual(try Data(contentsOf: external), externalBytes); XCTAssertEqual(try inode(external), externalInode)
        store.close(); current = nil
        let reopened = try open()
        XCTAssertEqual(try reopened.get(available), "false"); XCTAssertNil(try reopened.get(latest)); XCTAssertEqual(try reopened.get(checked), "1800000000000")
        XCTAssertEqual(try Data(contentsOf: external), externalBytes); XCTAssertEqual(try inode(external), externalInode)
    }

    func testInvalidTimestampVersionAndUnlistedSiblingNeverPublish() throws {
        let store = try open(), before = try Data(contentsOf: manifest), generation = try inode(manifest)
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        for timestamp in ["", "-1", "-0", "+1", "01", "1.0", "1e3", " 1", "1\n", "9007199254740992", "99999999999999999"] {
            XCTAssertThrowsError(try store.recordAboutUpdateCheck(timestamp: timestamp))
            XCTAssertThrowsError(try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: timestamp))
        }
        for version in ["", " \n", "1.0\u{0}", "1.0\u{85}", String(repeating: "x", count: 201), String(repeating: "🧠", count: 101)] {
            XCTAssertThrowsError(try store.storeAboutUpdateResult(available: false, latestVersion: version))
        }
        for name in [available + "_extra", checked + "_extra", latest + "_extra"] {
            XCTAssertThrowsError(try store.set(name, "foreign")); XCTAssertThrowsError(try store.remove(name))
        }
        XCTAssertEqual(promotions, 0); XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try inode(manifest), generation)
        try store.recordAboutUpdateCheck(timestamp: "0"); try store.recordAboutUpdateCheck(timestamp: "9007199254740991")
        XCTAssertEqual(try store.get(checked), "9007199254740991")
    }

    func testFailedBeforePublicationRetainsExactRequestAndColdOpeningDoesNotReplay() throws {
        let store = try open(), before = try Data(contentsOf: manifest), generation = try inode(manifest)
        store.faults.beforePromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: "100"))
        XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try inode(manifest), generation)
        XCTAssertThrowsError(try store.recordAboutUpdateCheck(timestamp: "100"))
        store.close(); current = nil
        let reopened = try open()
        XCTAssertEqual(try reopened.get(available), "false"); XCTAssertEqual(try reopened.get(latest), "old"); XCTAssertEqual(try reopened.get(checked), "0")
        XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try inode(manifest), generation)
    }

    func testLostPublicationAcknowledgmentAllowsOnlyExactRetryWithoutRepublishing() throws {
        let store = try open()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: "100"))
        let after = try Data(contentsOf: manifest), generation = try inode(manifest)
        XCTAssertThrowsError(try store.storeAboutUpdateResult(available: false, latestVersion: "2.0.0", checkedAt: "100"))
        XCTAssertThrowsError(try store.get(available))
        store.faults.afterPromotion = nil
        try store.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: "100")
        XCTAssertEqual(try Data(contentsOf: manifest), after); XCTAssertEqual(try inode(manifest), generation)
        store.close(); current = nil
        let reopened = try open()
        XCTAssertEqual(try reopened.get(available), "true"); XCTAssertEqual(try reopened.get(latest), "2.0.0"); XCTAssertEqual(try reopened.get(checked), "100")
        XCTAssertEqual(try Data(contentsOf: manifest), after); XCTAssertEqual(try inode(manifest), generation)
    }

    func testMatchingNoOpStillRefusesReplacedManifestGeneration() throws {
        let store = try open(), before = try Data(contentsOf: manifest), generation = try inode(manifest)
        let replacement = storage.appendingPathComponent("foreign-manifest")
        try before.write(to: replacement); XCTAssertEqual(rename(replacement.path, manifest.path), 0)
        XCTAssertNotEqual(try inode(manifest), generation)
        XCTAssertThrowsError(try store.recordAboutUpdateCheck(timestamp: "0"))
        XCTAssertEqual(try Data(contentsOf: manifest), before)
    }

    func testActualHostReadAndWritesPreserveDomainRowsAndEmitOnlyAcknowledgedOutcomes() async throws {
        let value = try await seededHost(), baseline = try rows(), before = try Data(contentsOf: manifest)
        let externalBytes = try Data(contentsOf: external), externalInode = try inode(external)
        let initial = try object(await value.readAboutUpdateState())
        XCTAssertEqual(initial as NSDictionary, ["updateAvailable": false, "shouldCheck": true] as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try outcomes(), [])
        let now = String(Int64(Date().timeIntervalSince1970 * 1000))
        try await value.recordAboutUpdateCheck(timestamp: now)
        XCTAssertEqual(try cells()[available] as? String, "false"); XCTAssertEqual(try cells()[latest] as? String, "old")
        try await value.storeAboutUpdateResult(available: true, latestVersion: "2.0.0")
        let stored = try object(await value.readAboutUpdateState())
        XCTAssertEqual(stored as NSDictionary, ["updateAvailable": true, "shouldCheck": false] as NSDictionary)
        try await value.storeAboutUpdateResult(available: false, latestVersion: "2.0.0")
        XCTAssertEqual(try outcomes(), ["check-saved", "badge-saved", "badge-saved"])
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try cells()["unknown"] as? String, "  opaque 🧠\n")
        XCTAssertEqual(try Data(contentsOf: external), externalBytes); XCTAssertEqual(try inode(external), externalInode)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        await value.close()
        let cold = try host(); _ = try await cold.start()
        let reopened = try object(await cold.readAboutUpdateState())
        XCTAssertEqual(reopened as NSDictionary, ["updateAvailable": false, "shouldCheck": false] as NSDictionary)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try outcomes(), ["check-saved", "badge-saved", "badge-saved"])
    }

    func testActualHostUncertainWriteEmitsNoSavedMarkerAndColdReadReconcilesPublishedCells() async throws {
        let value = try host(configureStorage: { store in store.faults.afterPromotion = { throw Injected.failure } })
        _ = try await value.start(); let baseline = try rows()
        let now = String(Int64(Date().timeIntervalSince1970 * 1000))
        do {
            try await value.storeAboutUpdateResult(available: true, latestVersion: "2.0.0", checkedAt: now)
            XCTFail("Lost storage acknowledgment must propagate")
        } catch Injected.failure {} catch { XCTFail("Unexpected failure category") }
        XCTAssertEqual(try outcomes(), []); XCTAssertEqual(try rows(), baseline)
        let after = try Data(contentsOf: manifest), generation = try inode(manifest)
        await value.close()
        let cold = try host(); _ = try await cold.start()
        let state = try object(await cold.readAboutUpdateState())
        XCTAssertEqual(state as NSDictionary, ["updateAvailable": true, "shouldCheck": false] as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: manifest), after); XCTAssertEqual(try inode(manifest), generation)
        XCTAssertEqual(try outcomes(), []); XCTAssertEqual(try rows(), baseline)
    }
}
