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
            ("Native iOS retained editor draft protected from late close", ["releaseCheck": "v1.3.5/ios-editor-retained-close", "outcome": "ignored"]),
            ("Native iOS Process Inbox editor reloaded", ["releaseCheck": "v1.3.8/ios-inbox-processing-editor-reload", "outcome": "refreshed"]),
            ("Native iOS Weekly Review project completion confirmed", ["releaseCheck": "v1.3.8/ios-weekly-review-complete-project", "outcome": "confirmed"]),
            ("Native iOS launch selection admitted", ["releaseCheck": "v1.3.5/ios-launch-selection", "outcome": "confirmed"]),
            ("Native iOS reminder lifecycle reconciled", ["releaseCheck": "v1.3.5/ios-reminder-lifecycle", "outcome": "confirmed"]),
            ("Native iOS foreground activation refreshed", ["releaseCheck": "v1.3.5/ios-foreground-activation", "outcome": "refreshed"]),
            ("Native iOS personal intake reopened after container relocation", ["releaseCheck": "v1.3.8/ios-intake-same-tree-reopen", "operation": "same-tree-reopen", "outcome": "confirmed"]),
        ]
        for outcome in ["completed", "ignored"] {
            result.append(("Native iOS navigation finish settlement confirmed", [
                "releaseCheck": "v1.3.8/ios-navigation-finish-settlement", "operation": "finish-settlement", "outcome": outcome]))
        }
        for operation in ["capture", "restore", "purge"] {
            result.append(("Native iOS bulk operation acknowledged", ["releaseCheck": "v1.3.5/ios-bulk-ui", "operation": operation, "outcome": "confirmed"]))
        }
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

    func testQuickCaptureIntentMarkerReachesSavedExportAndRefusesForeignContext() async throws {
        let core = try await preparedHost(), before = try rows()
        let message = "Native iOS Add Task shortcut presented"
        let context = ["releaseCheck": "v1.3.8/ios-quick-capture-intent", "outcome": "presented"]
        _ = try await core.call("logLine", argumentsJSON: json([message, json(context)]))
        let exported = try await lines(core)
        XCTAssertTrue(exported.contains { line in
            line["message"] as? String == message
                && (line["context"] as? [String: String]) == context
        })
        let log = root.appendingPathComponent("logs/mindwtr.log"), bytes = try Data(contentsOf: log)
        var invalid = [
            try json(["releaseCheck": "v1.3.8/ios-quick-capture-intent", "outcome": "saved"]),
            try json(["releaseCheck": "v1.3.8/ios-share-text-url", "outcome": "presented"]),
            try json(["releaseCheck": "v1.3.8/ios-quick-capture-intent"]),
            try json(["releaseCheck": "v1.3.8/ios-quick-capture-intent", "outcome": true]),
            #"{"releaseCheck":"v1.3.8/ios-quick-capture-intent","outcome":"presented","outcome":"saved"}"#,
        ]
        for field in ["text", "taskId", "url", "operation"] {
            var extra = context; extra[field] = "private"
            invalid.append(try json(extra))
        }
        for raw in invalid {
            do {
                _ = try await core.call("logLine", argumentsJSON: json([message, raw]))
                XCTFail("Foreign shortcut diagnostic context must refuse")
            } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), bytes)
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
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
        for context in [
            ["releaseCheck": "v1.3.5/ios-editor-retained-close", "outcome": "saved"],
            ["releaseCheck": "v1.3.5/ios-editor-retained-close", "outcome": "ignored", "taskId": "Synthetic private value"],
        ] {
            refused.append(try json(["Native iOS retained editor draft protected from late close", json(context)]))
        }
        for context in [
            ["releaseCheck": "v1.3.5/ios-bulk-ui", "operation": "private text", "outcome": "confirmed"],
            ["releaseCheck": "v1.3.5/ios-bulk-ui", "operation": "capture", "outcome": "pending"],
            ["releaseCheck": "v1.3.5/ios-bulk-ui", "operation": "restore", "outcome": "confirmed", "taskId": "private"],
        ] {
            refused.append(try json(["Native iOS bulk operation acknowledged", json(context)]))
        }
        for context in [
            ["releaseCheck": "v1.3.8/ios-inbox-processing-editor-reload", "outcome": "pending"],
            ["releaseCheck": "v1.3.8/ios-inbox-processing-editor-reload", "outcome": "refreshed", "taskId": "private"],
        ] {
            refused.append(try json(["Native iOS Process Inbox editor reloaded", json(context)]))
        }
        for context in [
            ["releaseCheck": "v1.3.8/ios-weekly-review-complete-project", "outcome": "pending"],
            ["releaseCheck": "v1.3.8/ios-weekly-review-complete-project", "outcome": "confirmed", "projectId": "private"],
            ["releaseCheck": "v1.3.8/unreviewed", "outcome": "confirmed"],
        ] {
            refused.append(try json(["Native iOS Weekly Review project completion confirmed", json(context)]))
        }
        let finishMessage = "Native iOS navigation finish settlement confirmed"
        for invalid in [
            ["releaseCheck": "v1.3.8/ios-navigation-finish-settlement", "operation": "capture", "outcome": "completed"],
            ["releaseCheck": "v1.3.8/unreviewed", "operation": "finish-settlement", "outcome": "completed"],
            ["releaseCheck": "v1.3.8/ios-navigation-finish-settlement", "outcome": "completed"],
        ] { refused.append(try json([finishMessage, json(invalid)])) }
        refused.append(try json([finishMessage, #"{"releaseCheck":"v1.3.8/ios-navigation-finish-settlement","operation":"finish-settlement","outcome":"completed","outcome":"ignored"}"#]))
        for invalidOutcome in ["confirmed", "pending", true, 1, NSNull()] as [Any] {
            refused.append(try json([finishMessage, json([
                "releaseCheck": "v1.3.8/ios-navigation-finish-settlement", "operation": "finish-settlement", "outcome": invalidOutcome])]))
        }
        for field in ["taskId", "eventId", "url", "text", "path"] {
            refused.append(try json([finishMessage, json([
                "releaseCheck": "v1.3.8/ios-navigation-finish-settlement", "operation": "finish-settlement",
                "outcome": "completed", field: "Synthetic private value"])]))
        }
        let reopenMessage = "Native iOS personal intake reopened after container relocation"
        let reopenContext: [String: Any] = ["releaseCheck": "v1.3.8/ios-intake-same-tree-reopen", "operation": "same-tree-reopen", "outcome": "confirmed"]
        for (field, value) in [("releaseCheck", "v1.3.8/unreviewed"), ("operation", "capture"),
                               ("outcome", "pending"), ("outcome", true), ("path", "Synthetic private value")] as [(String, Any)] {
            var invalid = reopenContext; invalid[field] = value
            refused.append(try json([reopenMessage, json(invalid)]))
        }
        var missingReopenOperation = reopenContext; missingReopenOperation.removeValue(forKey: "operation")
        refused.append(try json([reopenMessage, json(missingReopenOperation)]))
        refused.append(try json([reopenMessage, #"{"releaseCheck":"v1.3.8/ios-intake-same-tree-reopen","operation":"same-tree-reopen","operation":"capture","outcome":"confirmed"}"#]))
        for raw in refused {
            do { _ = try await core.call("logLine", argumentsJSON: raw); XCTFail("Expected closed client diagnostic refusal") } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), bytes)
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testReminderCaptureHandoverMarkerIsExportedAndRefusesInvalidContext() async throws {
        let core = try await preparedHost(), before = try rows()
        let message = "Native iOS reminder capture handover confirmed"
        let context: [String: Any] = ["releaseCheck": "v1.3.8/ios-reminder-capture-handover",
                                      "operation": "handover", "outcome": "confirmed"]
        let initial = try await lines(core)
        XCTAssertFalse(initial.contains { $0["message"] as? String == message })
        let result: String
        do { result = try await core.call("logLine", argumentsJSON: json([message, json(context)])) }
        catch {
            XCTFail("Handover diagnostic must be admitted by the closed native allowlist")
            return
        }
        XCTAssertEqual(result, "{}")
        let exported = try await lines(core)
        XCTAssertTrue(try exported.contains { line in
            guard line["message"] as? String == message else { return false }
            return try json(line["context"] as? [String: Any] ?? [:]) == json(context)
        }, "The handover marker must reach the actual Settings Diagnostics export")
        let log = root.appendingPathComponent("logs/mindwtr.log"), bytes = try Data(contentsOf: log)
        var refused: [String] = []
        let edits: [(String, Any)] = [
            ("releaseCheck", "v1.3.8/unreviewed"), ("operation", "retire"),
            ("outcome", "pending"), ("outcome", true), ("detail", "Synthetic private value"),
        ]
        for (field, value) in edits {
            var invalid = context; invalid[field] = value
            refused.append(try json([message, json(invalid)]))
        }
        var missing = context; missing.removeValue(forKey: "operation")
        refused.append(try json([message, json(missing)]))
        refused.append(try json([message, #"{"releaseCheck":"v1.3.8/ios-reminder-capture-handover","operation":"handover","operation":"retire","outcome":"confirmed"}"#]))
        for arguments in refused {
            do {
                _ = try await core.call("logLine", argumentsJSON: arguments)
                XCTFail("Changed handover marker context must refuse")
            } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), bytes)
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testPersonalIntakeCaptureMarkerIsExportedAndRefusesInvalidContext() async throws {
        let core = try await preparedHost(), before = try rows()
        let message = "Native iOS personal intake capture confirmed"
        let context: [String: Any] = ["releaseCheck": "v1.3.8/ios-personal-intake",
                                      "operation": "capture", "outcome": "confirmed"]
        let initial = try await lines(core)
        XCTAssertFalse(initial.contains { $0["message"] as? String == message })
        let result: String
        do { result = try await core.call("logLine", argumentsJSON: json([message, json(context)])) }
        catch {
            XCTFail("Capture diagnostic must be admitted by the closed native allowlist")
            return
        }
        XCTAssertEqual(result, "{}")
        let exported = try await lines(core)
        XCTAssertTrue(try exported.contains { line in
            guard line["message"] as? String == message else { return false }
            return try json(line["context"] as? [String: Any] ?? [:]) == json(context)
        }, "The capture marker must reach the actual Settings Diagnostics export")
        let log = root.appendingPathComponent("logs/mindwtr.log"), bytes = try Data(contentsOf: log)
        var refused: [String] = []
        let edits: [(String, Any)] = [
            ("releaseCheck", "v1.3.8/unreviewed"), ("operation", "retire"),
            ("outcome", "pending"), ("outcome", true), ("detail", "Synthetic private value"),
            ("url", "mindwtr://capture?text=private"), ("identifier", "Synthetic Spotlight identifier"),
            ("eventId", UUID().uuidString.lowercased()), ("taskId", "Synthetic task identifier"),
            ("path", "/synthetic/private"),
        ]
        for (field, value) in edits {
            var invalid = context; invalid[field] = value
            refused.append(try json([message, json(invalid)]))
        }
        var missing = context; missing.removeValue(forKey: "operation")
        refused.append(try json([message, json(missing)]))
        refused.append(try json([message, #"{"releaseCheck":"v1.3.8/ios-personal-intake","operation":"capture","operation":"retire","outcome":"confirmed"}"#]))
        for arguments in refused {
            do {
                _ = try await core.call("logLine", argumentsJSON: arguments)
                XCTFail("Changed capture marker context must refuse")
            } catch {}
        }
        XCTAssertEqual(try Data(contentsOf: log), bytes)
        XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testShareImportOpenAndFinishMarkersReachExportThroughActualClientBoundary() async throws {
        let core = try await preparedHost(), before = try rows()
        let markers: [(String, String, String)] = [
            ("Native iOS share intake confirmed", "share-import", "confirmed"),
            ("Native iOS shared capture bound", "share-open", "confirmed"),
            ("Native iOS shared capture finish confirmed", "share-finish", "completed"),
            ("Native iOS shared capture finish confirmed", "share-finish", "ignored"),
        ]
        for (message, operation, outcome) in markers {
            let context = ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": operation, "outcome": outcome]
            let result = try await core.call("logLine", argumentsJSON: json([message, json(context)]))
            XCTAssertEqual(result, "{}")
        }
        let exported = try await lines(core)
        for (message, operation, outcome) in markers {
            let expected = ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": operation, "outcome": outcome]
            XCTAssertTrue(try exported.contains { line in
                guard line["message"] as? String == message else { return false }
                return try json(line["context"] as? [String: Any] ?? [:]) == json(expected)
            }, "Actual App share marker must reach the Settings Diagnostics export")
        }
        let log = root.appendingPathComponent("logs/mindwtr.log"), bytes = try Data(contentsOf: log)
        for (message, operation, outcome) in markers {
            let context: [String: Any] = ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": operation, "outcome": outcome]
            for (field, value) in [("releaseCheck", "v1.3.8/foreign"), ("operation", "share-save"), ("outcome", "pending"),
                ("outcome", true), ("text", "Synthetic private body"), ("url", "https://private.invalid"),
                ("eventId", "Synthetic private id"), ("fingerprint", String(repeating: "a", count: 64))] as [(String, Any)] {
                var changed = context; changed[field] = value
                do {
                    _ = try await core.call("logLine", argumentsJSON: json([message, json(changed)]))
                    XCTFail("Changed or privacy-bearing share marker must refuse before logging")
                } catch {}
            }
            var missing = context; missing.removeValue(forKey: "operation")
            do { _ = try await core.call("logLine", argumentsJSON: json([message, json(missing)])); XCTFail("Missing operation must refuse") } catch {}
            let duplicate = "{\"releaseCheck\":\"v1.3.8/ios-share-text-url\",\"operation\":\"\(operation)\",\"operation\":\"\(operation)\",\"outcome\":\"\(outcome)\"}"
            do { _ = try await core.call("logLine", argumentsJSON: json([message, duplicate])); XCTFail("Duplicate share field must refuse") } catch {}
        }
        for (message, context) in [
            ("Native iOS shared capture saved", ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": "share-save", "outcome": "confirmed"]),
            ("Native iOS share intake confirmed", ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": "share-open", "outcome": "confirmed"]),
            ("Native iOS shared capture bound", ["releaseCheck": "v1.3.8/ios-share-text-url", "operation": "share-import", "outcome": "confirmed"]),
        ] {
            do { _ = try await core.call("logLine", argumentsJSON: json([message, json(context)])); XCTFail("A client cannot forge another phase or internal Save marker") } catch {}
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
