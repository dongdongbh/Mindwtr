import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAnalyticsHeartbeatHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.example.mindwtr.analytics"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual core bundle required") }
        let candidate = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/analytics-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Analytics fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        bundle = root.appendingPathComponent("core-host.js"); try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "mindwtr-analytics-distinct-id": "rn-distinct-id"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws {
        NativeAppInfo.install("")
        if let root { try FileManager.default.removeItem(at: root) }
    }

    private func host() -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func analytics(_ core: CoreHost) async throws -> [String: Any]? {
        let model = try object(await core.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        return (model["diagnostics"] as? [String: Any])?["analytics"] as? [String: Any]
    }
    private func settings() throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT data FROM settings WHERE id=1", parametersJSON: "[]").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
    }

    func testAppInfoCarriesRNsIOSFieldsAndTheDefaultHeartbeatURL() throws {
        let encoded = try object(NativeAppInfo.encode(info: ["CFBundleDisplayName": "Mindwtr", "CFBundleShortVersionString": "1.4.0",
            "CFBundleVersion": "7", "MindwtrReleaseVersion": "v1.4.0-rc.1", "MindwtrAnalyticsHeartbeatURL": "", "MindwtrFeedbackEndpointURL": "https://feedback.mindwtr.app"],
            bundleIdentifier: "tech.dongdongbh.mindwtr", systemVersion: "17.5.1", isPad: true, isDev: false))
        XCTAssertEqual(encoded["analyticsHeartbeatUrl"] as? String, NativeAppInfo.defaultAnalyticsHeartbeatURL)
        XCTAssertEqual(encoded["releaseVersion"] as? String, "v1.4.0-rc.1")
        XCTAssertEqual(encoded["platform"] as? String, "ios")
        XCTAssertEqual(encoded["analyticsHeartbeatChannel"] as? String, "")
        XCTAssertEqual(encoded["isPad"] as? Bool, true)
        XCTAssertEqual(encoded["isDev"] as? Bool, false)
    }

    func testDevelopmentAndTestBundlesNeverGetAHeartbeatURL() throws {
        for bundle in ["tech.dongdongbh.mindwtr.native.dev", "tech.dongdongbh.mindwtr.dev", "tech.dongdongbh.mindwtr.uitests", ""] {
            for configured in ["", "https://analytics.example.test/"] {
                let encoded = try object(NativeAppInfo.encode(info: ["MindwtrAnalyticsHeartbeatURL": configured], bundleIdentifier: bundle,
                    systemVersion: "17.5.1", isPad: false, isDev: false))
                XCTAssertEqual(encoded["analyticsHeartbeatUrl"] as? String, "", bundle)
            }
        }
    }

    func testDevelopmentBundleNeitherSendsNorOffersTheOptOut() async throws {
        NativeAppInfo.install(NativeAppInfo.encode(info: ["MindwtrAnalyticsHeartbeatURL": "http://127.0.0.1:9/"],
            bundleIdentifier: "tech.dongdongbh.mindwtr.native.dev", systemVersion: "17.5.1", isPad: false, isDev: false))
        let core = host(); _ = try await core.start()
        let row = try await analytics(core)
        XCTAssertNil(row)
        let reply = try object(await core.call("sendAboutHeartbeat", argumentsJSON: "[]"))
        XCTAssertEqual(reply["sent"] as? Bool, false)
        let device = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        XCTAssertEqual(Set(device.keys), ["@mindwtr_sync_backend", "mindwtr-analytics-distinct-id"])
    }

    func testHeartbeatKeepsRNsDistinctIDAndOptOutIsADataSetting() async throws {
        NativeAppInfo.install(NativeAppInfo.encode(info: ["CFBundleDisplayName": "Mindwtr", "CFBundleShortVersionString": "1.4.0", "CFBundleVersion": "7",
            "MindwtrAnalyticsHeartbeatURL": "http://127.0.0.1:9/"], bundleIdentifier: "tech.dongdongbh.mindwtr", systemVersion: "17.5.1", isPad: false, isDev: false))
        let core = host(); _ = try await core.start()
        let opened = try await analytics(core)
        let row = try XCTUnwrap(opened)
        XCTAssertEqual(row["value"] as? Bool, false)
        let reply = try object(await core.call("sendAboutHeartbeat", argumentsJSON: "[]"))
        XCTAssertEqual(reply["sent"] as? Bool, false)
        let device = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        XCTAssertEqual(device["mindwtr-analytics-distinct-id"] as? String, "rn-distinct-id")
        XCTAssertNil(device["mindwtr-analytics-last-heartbeat-day"])
        _ = try await core.call("dataSetting", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(),
            "edit": ["type": "analyticsOptOut", "value": true]])]))
        XCTAssertEqual((try settings()["analytics"] as? [String: Any])?["heartbeatEnabled"] as? Bool, false)
        let optedOut = try await analytics(core)
        XCTAssertEqual(optedOut?["value"] as? Bool, true)
    }

    func testWithoutAppInfoThereIsNoHeartbeatOrOptOutRow() async throws {
        NativeAppInfo.install("")
        let core = host(); _ = try await core.start()
        let row = try await analytics(core)
        XCTAssertNil(row)
        do { _ = try await core.call("sendAboutHeartbeat", argumentsJSON: "[]"); XCTFail("Heartbeat must be unavailable") } catch {}
    }
}
