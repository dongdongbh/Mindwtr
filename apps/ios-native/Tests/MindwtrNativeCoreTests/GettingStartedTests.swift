import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

/// Production bundle/SQLite/journal checks; root owns Apple runtime execution.
final class GettingStartedTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual core bundle required") }
        let candidate = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/getting-started-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Getting Started fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        bundle = root.appendingPathComponent("core-host.js"); try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    @discardableResult private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(sql, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func request(_ id: String = UUID().uuidString.lowercased(), language: String = "en") throws -> String { try json(["requestId": id, "language": language]) }
    private func seed(_ core: CoreHost, raw: String) async throws -> [String: Any] { try object(await core.call("gettingStarted", argumentsJSON: json([raw]))) }
    private func snapshot() throws -> String {
        try json(["tasks": rows("SELECT rowid,* FROM tasks ORDER BY rowid"), "projects": rows("SELECT rowid,* FROM projects ORDER BY rowid"),
                  "settings": rows("SELECT rowid,* FROM settings ORDER BY rowid"), "receipts": rows("SELECT * FROM native_request_receipts ORDER BY request_id")])
    }
    private func domain() throws -> String {
        try json(["tasks": rows("SELECT rowid,* FROM tasks ORDER BY rowid"), "projects": rows("SELECT rowid,* FROM projects ORDER BY rowid"), "settings": rows("SELECT rowid,* FROM settings ORDER BY rowid")])
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch {}
    }
    private func capture(_ core: CoreHost) async throws -> String {
        let id = UUID().uuidString.lowercased(), opened = try object(await core.call("captureOpen"))
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Unrelated populated task", "options": XCTUnwrap(opened["options"]), "captureId": id, "openAfterSave": false])]))
        return id
    }
    private func laterTaskEdit() throws {
        let id = try XCTUnwrap(rows("SELECT id FROM tasks WHERE projectId IS NOT NULL LIMIT 1").first?["id"] as? String)
        try rows("UPDATE tasks SET title=?,description=?,rev=rev+7 WHERE id=?", ["Later custom tutorial title", "Later private description", id])
    }

    func testDataReadsAndRestartNeverSeedAutomatically() async throws {
        let core = host(); _ = try await core.start(); let before = try snapshot()
        for _ in 0..<2 {
            let model = try object(await core.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
            let row = try XCTUnwrap((model["backup"] as? [String: Any])?["gettingStarted"] as? [String: Any])
            XCTAssertEqual(Set(row.keys), Set(["label", "description", "language", "ready", "notCreated", "failed", "open"]))
        }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let cold = host(); _ = try await cold.start(); XCTAssertEqual(try snapshot(), before)
        XCTAssertTrue(try rows("SELECT * FROM tasks").isEmpty); XCTAssertTrue(try rows("SELECT * FROM projects").isEmpty)
    }

    func testExplicitSeedPreservesPopulatedRawRowsAndSettings() async throws {
        let initial = host(); _ = try await initial.start(); let id = try await capture(initial); await initial.close()
        try rows("ALTER TABLE tasks ADD COLUMN future_getting_started TEXT")
        try rows("UPDATE tasks SET future_getting_started=?,tags=?,rev=91 WHERE id=?", ["Unrecognized preserved cell", "[\"#existing\"]", id])
        let row = try json(rows("SELECT rowid,* FROM tasks WHERE id=?", [id])), settings = try json(rows("SELECT rowid,* FROM settings"))
        let core = host(); _ = try await core.start(); let reply = try await seed(core, raw: request())
        XCTAssertNotNil(reply["projectId"] as? String); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 10)
        XCTAssertEqual(try rows("SELECT * FROM projects").count, 1); XCTAssertEqual(try json(rows("SELECT rowid,* FROM tasks WHERE id=?", [id])), row)
        XCTAssertEqual(try json(rows("SELECT rowid,* FROM settings")), settings); XCTAssertTrue(try rows("PRAGMA foreign_key_check").isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFailedTransactionRetainsExactWarmAndColdRetry() async throws {
        for cold in [false, true] {
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let before = try snapshot()
            let id = UUID().uuidString.lowercased(), raw = try request(id), args = try json([raw])
            faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Synthetic Getting Started commit failure") } }
            await failure { _ = try await core.call("gettingStarted", argumentsJSON: args) }
            let frozen = try Data(contentsOf: journal), command = try object(String(decoding: frozen, as: UTF8.self))
            XCTAssertEqual(command["version"] as? Int, 2); XCTAssertEqual(command["method"] as? String, "gettingStarted")
            XCTAssertEqual(command["argumentsJSON"] as? String, args); XCTAssertEqual(try snapshot(), before)
            await failure { _ = try await seed(core, raw: request(id, language: "fr")) }
            XCTAssertEqual(try Data(contentsOf: journal), frozen); faults.beforeSQL = nil
            if cold {
                await core.close(); let restarted = host(); let startup = try object(await restarted.start())
                XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "gettingStarted")
                let confirmed = try await seed(restarted, raw: raw); XCTAssertNotNil(confirmed["projectId"] as? String)
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await restarted.close()
            } else {
                _ = try await core.retryPending()
                let confirmed = try await seed(core, raw: raw); XCTAssertNotNil(confirmed["projectId"] as? String)
                await core.close()
            }
            XCTAssertEqual(try rows("SELECT * FROM tasks").count, 9); XCTAssertEqual(try rows("SELECT * FROM projects").count, 1)
            XCTAssertEqual(try rows("SELECT * FROM native_request_receipts WHERE request_id=?", [id]).count, 1)
        }
    }

    func testDrainingAnotherPendingRequestDoesNotAcknowledgeOriginalGettingStartedRequest() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let pendingID = UUID().uuidString.lowercased(), originalID = UUID().uuidString.lowercased()
        let pending = try request(pendingID), original = try request(originalID, language: "fr")
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Synthetic other Getting Started commit failure") } }
        await failure { _ = try await seed(core, raw: pending) }
        let frozen = try Data(contentsOf: journal)
        await failure { _ = try await seed(core, raw: original) }
        XCTAssertEqual(try Data(contentsOf: journal), frozen)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts WHERE request_id=?", [originalID]).isEmpty)
        faults.beforeSQL = nil
        _ = try await core.retryPending()
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts WHERE request_id=?", [pendingID]).count, 1)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts WHERE request_id=?", [originalID]).isEmpty,
            "A global retry result belongs to its original pending request")
        let result = try await seed(core, raw: original)
        let receipt = try XCTUnwrap(rows("SELECT reply FROM native_request_receipts WHERE request_id=?", [originalID]).first?["reply"] as? String)
        XCTAssertEqual(try json(object(receipt)), try json(result))
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 2)
        XCTAssertEqual(try rows("SELECT * FROM projects").count, 1); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 9)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testTerminalColdReceiptReplayPreservesLaterRowsWithoutReseeding() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let raw = try request()
        faults.journalRemove = { throw HostFailure("Synthetic Getting Started cleanup interruption") }
        await failure { _ = try await seed(core, raw: raw) }
        let frozen = try Data(contentsOf: journal); XCTAssertNotNil(try object(String(decoding: frozen, as: UTF8.self))["terminal"])
        await core.close(); try laterTaskEdit(); let before = try snapshot()
        let cold = host(); let startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "gettingStarted"); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
        try frozen.write(to: journal)
        let replay = host(); _ = try await replay.start(); XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostReplyColdReplayUsesCommittedReceiptWithoutRepairingLaterTask() async throws {
        let production = try String(contentsOf: bundle, encoding: .utf8)
        let suffix = """
        ;(() => {
            const command=MindwtrHost.menuCommand,poll=MindwtrHost.poll; let held=null,first=true;
            MindwtrHost.menuCommand=function(name,input){const ticket=command.call(this,name,input);if(name==='gettingStarted'&&first){first=false;held=ticket;}return ticket;};
            MindwtrHost.poll=function(ticket){const raw=poll.call(this,ticket);if(ticket===held&&raw!==null){held=null;if(JSON.parse(raw).ok)return JSON.stringify({ok:false,error:'ACTION_FAILED: Synthetic seed reply loss'});}return raw;};
        })();
        """
        try (production + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start(); await failure { _ = try await seed(core, raw: request()) }
        XCTAssertNil(try object(String(contentsOf: journal))["terminal"]); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        await core.close(); try production.write(to: bundle, atomically: true, encoding: .utf8); try laterTaskEdit(); let before = try snapshot()
        let cold = host(); let startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "gettingStarted")
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testInvalidRequestsEditorAndRestrictedOwnersCannotSeed() async throws {
        let core = host(); _ = try await core.start(); let id = UUID().uuidString.lowercased(), before = try snapshot()
        for raw in ["{}", "[]", "{\"requestId\":\"\(id)\",\"language\":\"en\",\"extra\":true}",
            "{\"requestId\":\"\(id)\",\"language\":\"en\",\"language\":\"fr\"}",
            try request("ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"), try request(language: "unsupported-language"), try json(["requestId": id, "language": true]),
            try request(language: String(repeating: "x", count: 41))] { await failure { _ = try await seed(core, raw: raw) } }
        await failure { _ = try await core.call("gettingStarted", argumentsJSON: "[]") }
        await failure { _ = try await core.call("gettingStartedOutcome", argumentsJSON: json([request()])) }
        await failure { _ = try await core.call("menuCommand", argumentsJSON: json(["gettingStarted", request()])) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let task = try await capture(core), draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: task, generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved edit"}}"#)
        try await core.checkpointEditorDraft(draft); let saved = try snapshot()
        await failure { _ = try await seed(core, raw: request()) }; XCTAssertEqual(try snapshot(), saved)
        let retainedDraft = try await core.readEditorDraft(); XCTAssertEqual(retainedDraft, draft)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let restricted = CoreHost(databaseURL: database, bundleURL: bundle, workspaceMode: .restricted)
        addTeardownBlock { await restricted.close() }
        await failure { _ = try await seed(restricted, raw: request()) }; XCTAssertEqual(try snapshot(), saved)
    }

    func testExistingLegacyStarterProjectIdIsReturnedUnchanged() async throws {
        let first = host(); _ = try await first.start(); let result = try await seed(first, raw: request()), id = try XCTUnwrap(result["projectId"] as? String); await first.close()
        let legacy = "legacy-starter-project-2019", sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("PRAGMA foreign_keys=OFF")
        _ = try sqlite.execute("UPDATE projects SET id=? WHERE id=?", parametersJSON: json([legacy, id]))
        _ = try sqlite.execute("UPDATE tasks SET projectId=? WHERE projectId=?", parametersJSON: json([legacy, id])); sqlite.close()
        let core = host(); _ = try await core.start(); let reply = try await seed(core, raw: request())
        XCTAssertEqual(reply["projectId"] as? String, legacy); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 9)
        XCTAssertEqual(try rows("SELECT * FROM projects").count, 1); XCTAssertTrue(try rows("PRAGMA foreign_key_check").isEmpty)
    }

    func testNullMalformedAndMissingReceiptResultsAreCheckedBeforeJournalCleanup() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let id = UUID().uuidString.lowercased()
        faults.journalRemove = { throw HostFailure("Synthetic terminal retention") }
        await failure { _ = try await seed(core, raw: request(id)) }; await core.close()
        let original = try object(String(contentsOf: journal)), receipt = try XCTUnwrap(rows("SELECT reply FROM native_request_receipts WHERE request_id=?", [id]).first?["reply"] as? String), before = try domain()
        var null = original; null["terminal"] = ["success": ["_0": try json(["projectId": NSNull()])]]
        try rows("UPDATE native_request_receipts SET reply=? WHERE request_id=?", [json(["projectId": NSNull()]), id]); try Data(json(null).utf8).write(to: journal)
        let valid = host(); let startup = try object(await valid.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any]), reply = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertTrue(reply["projectId"] is NSNull); XCTAssertEqual(try domain(), before); await valid.close()
        try rows("UPDATE native_request_receipts SET reply=? WHERE request_id=?", [receipt, id])
        for bad: [String: Any] in [[:], ["projectId": 3], ["projectId": " "], ["projectId": String(repeating: "x", count: 501)], ["projectId": NSNull(), "extra": true]] {
            var command = original; command["terminal"] = ["success": ["_0": try json(bad)]]
            let bytes = Data(try json(command).utf8); try bytes.write(to: journal)
            let owner = host(); await failure { _ = try await owner.start() }; await owner.close()
            XCTAssertEqual(try Data(contentsOf: journal), bytes); XCTAssertEqual(try domain(), before)
        }
        try Data(json(original).utf8).write(to: journal); try rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
        let retained = try Data(contentsOf: journal), missing = host(); await failure { _ = try await missing.start() }; await missing.close()
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try domain(), before); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
    }
}
