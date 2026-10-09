import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeClientDiagnosticsTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build production core-host.js")
        }
        bundle = URL(fileURLWithPath: path)
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func host() -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle)
        addTeardownBlock { await value.close() }; return value
    }
    private func preparedHost() async throws -> CoreHost {
        let core = host(); _ = try await core.start()
        _ = try await core.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
        ])]))
        return core
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        var result: [String: String] = [:]
        for table in ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"] {
            result[table] = try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + table + " ORDER BY rowid").utf8)))
        }
        return result
    }
    private func lines(_ core: CoreHost) async throws -> [[String: Any]] {
        let raw = try await core.diagnosticsFileAction("logShare")
        let shared = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        let url = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(NativeJSON.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }
    private var approved: [(String, [String: Any])] {
        var result: [(String, [String: Any])] = [
            ("Native iOS launch selection admitted", ["releaseCheck": "v1.3.5/ios-launch-selection", "outcome": "confirmed"]),
            ("Native iOS reminder lifecycle reconciled", ["releaseCheck": "v1.3.5/ios-reminder-lifecycle", "outcome": "confirmed"]),
            ("Native iOS foreground activation refreshed", ["releaseCheck": "v1.3.5/ios-foreground-activation", "outcome": "refreshed"]),
        ]
        for outcome in ["publicationQueued", "removalQueued", "failed"] {
            result.append(("Native iOS system search", ["releaseCheck": "v1.3.5/ios-search-publication", "outcome": outcome, "count": 2_750]))
        }
        for (message, slug) in [("Native iOS system search route", "ios-search-publication"), ("Native iOS entity link", "ios-entity-link")] {
            for kind in message == "Native iOS system search route" ? ["none", "task", "inbox"] : ["none", "task", "project", "inbox"] {
                for outcome in ["opened", "refused"] {
                    result.append((message, ["releaseCheck": "v1.3.5/" + slug, "kind": kind, "outcome": outcome]))
                }
            }
        }
        for action in ["open", "complete", "snooze", "dismiss", "unknown"] {
            for outcome in ["captured", "retired", "capture-refused", "admitting", "confirmed", "refused", "uncertain"] {
                result.append(("Native iOS reminder response", ["releaseCheck": "v1.3.5/ios-reminder-response", "action": action, "outcome": outcome]))
            }
        }
        for outcome in ["sound", "silent"] {
            result.append(("Native iOS foreground reminder presentation requested", ["releaseCheck": "v1.3.5/ios-reminder-present", "outcome": outcome]))
        }
        return result
    }

    func testActualJSCAdmitsOnlyApprovedClientMarkersIntoSavedDiagnosticsWithoutDomainWrites() async throws {
        let core = try await preparedHost(), before = try rows()
        for (message, context) in approved {
            let result = try await core.call("logLine", argumentsJSON: json([message, json(context)]))
            XCTAssertEqual(result, "{}")
        }
        let saved = try await lines(core)
        for (message, context) in approved {
            var expected = context
            if let count = context["count"] as? NSNumber { expected["count"] = count.stringValue }
            XCTAssertTrue(try saved.contains { line in
                guard line["message"] as? String == message else { return false }
                return try json(line["context"] as? [String: Any] ?? [:]) == json(expected)
            }, "Client marker must reach the Settings Diagnostics file")
        }
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testMalformedOversizedAndPrivacyBearingClientMarkersRefuseBeforeLoggingOrDomainWrites() async throws {
        let core = try await preparedHost(), before = try rows()
        let message = "Native iOS system search"
        let context = try json(["releaseCheck": "v1.3.5/ios-search-publication", "outcome": "publicationQueued", "count": 0])
        let valid = try json([message, context])
        _ = try await core.call("logLine", argumentsJSON: valid + String(repeating: " ", count: 2_048 - valid.utf8.count))
        _ = try await lines(core)
        let log = root.appendingPathComponent("logs/mindwtr.log"), bytes = try Data(contentsOf: log)
        var refused = ["null", "{}", "[]", "[1,2]", "[true,null]", "[\"message\"]", "[\"a\",\"b\",\"c\"]", "[\"a\",{}]",
            try json([message, "not JSON"]), try json([message, "[]"]), try json([message, "null"]),
            try json([String(repeating: "x", count: 257), context]), try json([message, "{}" + String(repeating: " ", count: 1_023)]),
            valid + String(repeating: " ", count: 2_049 - valid.utf8.count), try json(["Synthetic private task title", context]),
            try json([message, context.replacingOccurrences(of: "publicationQueued", with: "Synthetic private notes")]),
            try json([message, context.replacingOccurrences(of: "ios-search-publication", with: "ios-entity-link")]),
            try json([message, #"{"releaseCheck":"v1.3.5/ios-search-publication","outcome":"failed","outcome":"publicationQueued","count":0}"#])]
        for count in [-1, 2_751, 0.5, true, "0", NSNull()] as [Any] {
            refused.append(try json([message, json(["releaseCheck": "v1.3.5/ios-search-publication", "outcome": "publicationQueued", "count": count])]))
        }
        for field in ["taskId", "text", "url", "passphrase"] {
            refused.append(try json([message, json(["releaseCheck": "v1.3.5/ios-search-publication", "outcome": "publicationQueued", "count": 0, field: "Synthetic private value"])]))
        }
        for raw in refused {
            do { _ = try await core.call("logLine", argumentsJSON: raw); XCTFail("Expected closed client diagnostic refusal") } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), bytes)
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testClientDiagnosticsRequireStartupAndRefuseAfterClose() async throws {
        let core = host(), arguments = try json([approved[0].0, json(approved[0].1)])
        do { _ = try await core.call("logLine", argumentsJSON: arguments); XCTFail("Startup required") } catch {}
        _ = try await core.start(); await core.close()
        let log = root.appendingPathComponent("logs/mindwtr.log"), before = try Data(contentsOf: log)
        do { _ = try await core.call("logLine", argumentsJSON: arguments); XCTFail("Closed host must refuse") } catch {}
        XCTAssertEqual(try Data(contentsOf: log), before)
    }
}
