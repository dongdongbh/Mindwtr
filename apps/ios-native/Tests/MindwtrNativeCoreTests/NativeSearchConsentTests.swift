import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeSearchConsentTests: XCTestCase {
    private var root: URL!, current: NativeDeviceKV?
    private let consentCellName = "mindwtr:iosSearchIndexingEnabled"
    private var namespace = ""
    private var container: URL { root.appendingPathComponent("device", isDirectory: true) }
    private var storage: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1", isDirectory: true) }
    private var manifest: URL { storage.appendingPathComponent("manifest.json") }
    private enum Injected: Error { case failed }

    override func setUpWithError() throws {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("NativeSearchConsentTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw Injected.failed }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.dongdongbh.mindwtr.native-ui." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { current?.close(); current = nil; if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func seed(_ value: [String: Any]) throws { try Data(json(value).utf8).write(to: manifest) }
    private func open() throws -> NativeDeviceKV {
        let value = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace); current = value; return value
    }
    private func inode() throws -> UInt64 {
        var value = stat(); guard lstat(manifest.path, &value) == 0 else { throw Injected.failed }; return UInt64(value.st_ino)
    }

    func testAbsentDefaultNeverWritesAndTypedConsentStaysPrivateAndIsolated() throws {
        let value = try open()
        XCTAssertFalse(try value.readSearchConsent())
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifest.path))
        XCTAssertThrowsError(try value.set(consentCellName, "true")); XCTAssertThrowsError(try value.remove(consentCellName))
        try value.setSearchConsent(true); XCTAssertTrue(try value.readSearchConsent())
        let acknowledged = try Data(contentsOf: manifest), generation = try inode()
        try value.setSearchConsent(true)
        XCTAssertEqual(try Data(contentsOf: manifest), acknowledged); XCTAssertEqual(try inode(), generation)
        let other = try NativeDeviceKV(containerURL: container, bundleIdentifier: "tech.dongdongbh.mindwtr.native-ui." + UUID().uuidString.lowercased())
        defer { other.close() }; XCTAssertFalse(try other.readSearchConsent())
        value.close(); current = nil
        let cold = try open(); XCTAssertTrue(try cold.readSearchConsent())
        try cold.setSearchConsent(false); XCTAssertFalse(try cold.readSearchConsent())
    }

    func testMalformedStoredConsentFailsClosedWithoutWriting() throws {
        for text in ["TRUE", "False", " true", "false\n", "1", "", "null"] {
            try seed([consentCellName: text, "unknown": "opaque"])
            let value = try open(), before = try Data(contentsOf: manifest)
            XCTAssertThrowsError(try value.readSearchConsent())
            XCTAssertEqual(try Data(contentsOf: manifest), before)
            value.close(); current = nil
        }
    }

    func testFailureBeforePromotionRetainsBothIntentsForExactRetryAndColdNeverReplays() throws {
        for enabled in [true, false] {
            try seed([consentCellName: enabled ? "false" : "true", "unknown": "opaque 漢"])
            let value = try open(), before = try Data(contentsOf: manifest), generation = try inode()
            value.faults.beforePromotion = { throw Injected.failed }
            XCTAssertThrowsError(try value.setSearchConsent(enabled))
            XCTAssertThrowsError(try value.readSearchConsent()); XCTAssertThrowsError(try value.setSearchConsent(!enabled))
            XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try inode(), generation)
            value.faults.beforePromotion = nil; try value.setSearchConsent(enabled)
            XCTAssertEqual(try value.readSearchConsent(), enabled); XCTAssertEqual(try value.get("unknown"), "opaque 漢")
            value.close(); current = nil
            let cold = try open(); XCTAssertEqual(try cold.readSearchConsent(), enabled)
            cold.faults.beforePromotion = { throw Injected.failed }
            XCTAssertThrowsError(try cold.setSearchConsent(!enabled))
            let stable = try Data(contentsOf: manifest); cold.close(); current = nil
            let reopened = try open(); XCTAssertEqual(try reopened.readSearchConsent(), enabled)
            XCTAssertEqual(try Data(contentsOf: manifest), stable); reopened.close(); current = nil
        }
    }

    func testLostAcknowledgmentAllowsExactRetryWithoutRepromotionAndColdUsesCurrentCell() throws {
        for enabled in [true, false] {
            try seed([consentCellName: enabled ? "false" : "true"])
            let value = try open(); value.faults.afterPromotion = { throw Injected.failed }
            XCTAssertThrowsError(try value.setSearchConsent(enabled))
            let promoted = try Data(contentsOf: manifest), generation = try inode()
            XCTAssertThrowsError(try value.readSearchConsent()); XCTAssertThrowsError(try value.setSearchConsent(!enabled))
            value.faults.afterPromotion = nil; try value.setSearchConsent(enabled)
            XCTAssertEqual(try Data(contentsOf: manifest), promoted); XCTAssertEqual(try inode(), generation)
            XCTAssertEqual(try value.readSearchConsent(), enabled)
            value.faults.afterPromotion = { throw Injected.failed }
            XCTAssertThrowsError(try value.setSearchConsent(!enabled)); let after = try Data(contentsOf: manifest)
            value.close(); current = nil
            let cold = try open(); XCTAssertEqual(try cold.readSearchConsent(), !enabled)
            XCTAssertEqual(try Data(contentsOf: manifest), after); cold.close(); current = nil
        }
    }

    func testActualHostAcknowledgesOnlySavedConsentAndPreservesDomain() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build production core-host.js")
        }
        try seed(["unknown": "opaque retained value"])
        let database = root.appendingPathComponent("core.sqlite"), faults = HostIOFaults()
        let bootstrap = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        _ = try await bootstrap.start(); await bootstrap.close()
        do {
            let sql = try SQLiteBridge(url: database); defer { sql.close() }
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('kept-search-task','Synthetic retained title','inbox','[]','[]','Synthetic retained notes','2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z',3,'fixture',0,0,0,0)")
        }
        var store: NativeDeviceKV?
        faults.configureDeviceStorage = { store = $0 }
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }
        _ = try await core.start()
        let loggingRequest = try json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true]])
        _ = try await core.call("dataSetting", argumentsJSON: json([loggingRequest]))
        let settingsJSON = try await core.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))
        let settings = try XCTUnwrap(NativeJSON.jsonObject(with: Data(settingsJSON.utf8)) as? [String: Any])
        let diagnostics = try XCTUnwrap(settings["diagnostics"] as? [String: Any])
        let logging = try XCTUnwrap(diagnostics["debugLogging"] as? [String: Any])
        XCTAssertEqual(logging["value"] as? Bool, true)
        func rows() throws -> [String: String] {
            let sql = try SQLiteBridge(url: database); defer { sql.close() }
            var result: [String: String] = [:]
            for table in ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"] {
                result[table] = try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + table + " ORDER BY rowid").utf8)))
            }
            return result
        }
        func outcomes() throws -> [String] {
            let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
            return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-search-publication") }.map {
                let line = try XCTUnwrap(NativeJSON.jsonObject(with: Data($0.utf8)) as? [String: Any])
                let context = try XCTUnwrap(line["context"] as? [String: Any])
                XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "enabled", "outcome"]))
                XCTAssertEqual(context["outcome"] as? String, "consent-saved")
                return try XCTUnwrap(context["enabled"] as? String)
            }
        }
        let before = try rows(); let initial = try await core.readSearchConsent(); XCTAssertFalse(initial)
        try XCTUnwrap(store).faults.afterPromotion = { throw Injected.failed }
        do { try await core.setSearchConsent(true); XCTFail("Expected uncertain write") } catch Injected.failed {}
        XCTAssertEqual(try outcomes(), [])
        let promoted = try Data(contentsOf: manifest), generation = try inode()
        do { _ = try await core.readSearchConsent(); XCTFail("Pending write must refuse reads") } catch {}
        do { try await core.setSearchConsent(false); XCTFail("Only exact retry is admitted") } catch {}
        try XCTUnwrap(store).faults.afterPromotion = nil
        try await core.setSearchConsent(true)
        XCTAssertEqual(try Data(contentsOf: manifest), promoted); XCTAssertEqual(try inode(), generation)
        try await core.setSearchConsent(false)
        XCTAssertEqual(try outcomes(), ["true", "false"]); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try XCTUnwrap(store).get("unknown"), "opaque retained value")
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }
}
