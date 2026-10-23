import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Production JSC/SQLite Process Inbox Undo commands in the physical XCTest target.
final class NativeProcessInboxUndoHostTests: XCTestCase {
    private var directory: URL!, bundle: URL!, service: String!, namespace: String!
    private var database: URL { directory.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let identity = UUID().uuidString.lowercased()
        // Keep the existing runner-private capture root; own only this fresh UUID child.
        directory = support.appendingPathComponent("NativeBoardMoveTests/" + identity)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Process Inbox Undo fixture root unavailable") }
        defer { free(physical) }; directory = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("device"), withIntermediateDirectories: true)
        bundle = directory.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        service = "mindwtr.native-keychain.fixture." + identity
        namespace = "mindwtr.process-inbox-undo.fixture." + identity
    }

    override func tearDownWithError() throws {
        // XCTest runs the registered async host-close blocks before this owned directory cleanup.
        if let directory { try FileManager.default.removeItem(at: directory) }
    }

    private func host(_ faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) -> CoreHost {
        faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults,
            deviceStorage: (directory.appendingPathComponent("device"), namespace))
        addTeardownBlock { await core.close() }; return core
    }

    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func assertJournalContentUnchanged(_ saved: Data) throws {
        let before = try object(String(decoding: saved, as: UTF8.self))
        let after = try object(String(contentsOf: journal))
        // Recovery can re-encode the outer envelope; JSON object order is not
        // part of the contract. The embedded request must remain byte-exact.
        XCTAssertEqual(try json(after), try json(before))
        XCTAssertEqual(Data(try XCTUnwrap(after["argumentsJSON"] as? String).utf8),
                       Data(try XCTUnwrap(before["argumentsJSON"] as? String).utf8))
    }

    private func storedTask(_ id: String) throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        let rows = try JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT * FROM tasks WHERE id = ?", parametersJSON: json([id])).utf8)) as? [[String: Any]]
        return try XCTUnwrap(rows?.first)
    }

    private func dateBundle(at instant: String, rejectingPreparation: Bool = false, suffix: String = "") throws -> URL {
        let url = directory.appendingPathComponent("date-clock-\(UUID().uuidString).js")
        let clock = """
        (() => {
            const NativeDate = Date;
            const instant = NativeDate.parse('\(instant)');
            globalThis.Date = class extends NativeDate {
                constructor(...args) { super(...(args.length ? args : [instant])); }
                static now() { return instant; }
            };
        })();
        """
        let reject = rejectingPreparation ? "\nMindwtrHost.draftPrepare = function () { throw new Error('Replay must not prepare dates'); };" : ""
        try (clock + "\n" + String(contentsOf: bundle) + reject + "\n" + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func expectFailure(_ contains: String? = nil, _ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected failure") }
        catch {
            if let contains { XCTAssertTrue(error.localizedDescription.contains(contains), error.localizedDescription) }
        }
    }

    private func processInboxUndoDecision(_ core: CoreHost, choice: String) async throws -> (task: String, decision: String, session: String) {
        let opened = try object(await core.call("inboxStart", argumentsJSON: json(["quick"])))
        let session = try XCTUnwrap(opened["sessionId"] as? String)
        let view = try XCTUnwrap(opened["view"] as? [String: Any])
        let task = try XCTUnwrap(view["taskId"] as? String)
        let decision = UUID().uuidString.lowercased()
        let reply = try object(await core.call("inboxCommit", argumentsJSON: json([json([
            "sessionId": session, "taskId": task, "step": try XCTUnwrap(view["step"] as? String),
            "decision": ["choice": choice], "requestId": decision,
        ])])))
        XCTAssertEqual(reply["kind"] as? String, "saved")
        return (task, decision, session)
    }

    func testProcessInboxUndoPublicThreeKindsRawReplyAndOwnReceiptAfterLaterEdit() async throws {
        let faults = HostIOFaults()
        let core = host(faults, bundleURL: try dateBundle(at: "2026-10-20T12:00:00.000Z"))
        _ = try await core.start()
        let task = UUID().uuidString.lowercased()
        let other = UUID().uuidString.lowercased()
        for (id, title) in [(task, "Undo original"), (other, "Untouched sentinel")] {
            _ = try await core.call("mindSweepAdd", argumentsJSON: json([json(["requestId": id, "title": title])]))
        }
        _ = try await core.call("complete", argumentsJSON: json([other]))
        let sentinel = try json(storedTask(other))
        var diagnostics = 0
        faults.commandDiagnostic = { if $0 == "processInboxUndo" { diagnostics += 1 } }
        var lastRequest: [String: Any] = [:]
        var lastResult: [String: Any] = [:]
        for (choice, kind) in [("reference", "filed"), ("done", "completed"), ("trash", "discarded")] {
            let original = try storedTask(task)
            let saved = try await processInboxUndoDecision(core, choice: choice)
            XCTAssertEqual(saved.task, task)
            let flow = try object(await core.call("inboxAfterCommit", argumentsJSON: json([json([
                "sessionId": saved.session, "requestId": saved.decision,
            ])])))
            let toast = try XCTUnwrap(flow["toast"] as? [String: Any])
            XCTAssertEqual(try json(XCTUnwrap(toast["undo"])), try json([
                "taskId": task, "decisionRequestId": saved.decision, "kind": kind,
            ]))
            let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(),
                "decisionRequestId": saved.decision, "taskId": task]
            let result = try object(await core.call("inboxUndo", argumentsJSON: json([json(request)])))
            XCTAssertEqual(Set(result.keys), Set(["taskId", "decisionRequestId", "kind"]))
            XCTAssertEqual(try json(result), try json(["taskId": task, "decisionRequestId": saved.decision, "kind": kind]))
            let restored = try storedTask(task)
            for field in ["title", "status", "description", "contexts", "tags", "attachments", "deletedAt", "completedAt"] {
                XCTAssertEqual(try json([restored[field] ?? NSNull()]), try json([original[field] ?? NSNull()]), field)
            }
            XCTAssertGreaterThan(try XCTUnwrap(restored["rev"] as? Int), try XCTUnwrap(original["rev"] as? Int))
            XCTAssertEqual(try json(storedTask(other)), sentinel)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            _ = try await core.call("inboxEnd", argumentsJSON: json([saved.session]))
            lastRequest = request; lastResult = result
        }
        XCTAssertEqual(diagnostics, 3)
        // Own exact receipt precedes mutable task/default guards and never writes again.
        _ = try await core.call("inboxStart", argumentsJSON: json(["quick"]))
        let outside = try SQLiteBridge(url: database)
        _ = try outside.execute("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", parametersJSON: json(["Later edit stays", task]))
        outside.close()
        let edited = try json(storedTask(task))
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let outcome = try object(await core.call("inboxUndoRetryOutcome", argumentsJSON: json([json(lastRequest)])))
        XCTAssertEqual(try json(outcome), try json(lastResult))
        XCTAssertEqual(try json(storedTask(task)), edited)
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(diagnostics, 3)
        var forged = lastRequest; forged["requestId"] = UUID().uuidString.lowercased()
        await expectFailure("STALE_REVISION") { _ = try await core.call("inboxUndoRetryOutcome", argumentsJSON: json([json(forged)])) }
    }

    func testProcessInboxUndoFreshSessionRetiresPreviousDecisionAuthority() async throws {
        let faults = HostIOFaults()
        let core = host(faults)
        _ = try await core.start()
        let task = UUID().uuidString.lowercased()
        _ = try await core.call("mindSweepAdd", argumentsJSON: json([json(["requestId": task, "title": "Previous session"])]))
        let saved = try await processInboxUndoDecision(core, choice: "reference")
        _ = try await core.call("inboxStart", argumentsJSON: json(["quick"]))
        let before = try json(storedTask(task))
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(),
            "decisionRequestId": saved.decision, "taskId": task]
        await expectFailure("INVALID_INPUT") {
            _ = try await core.call("inboxUndo", argumentsJSON: json([json(request)]))
        }
        XCTAssertEqual(try json(storedTask(task)), before)
        XCTAssertEqual(writes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testProcessInboxUndoFailedCommitExactRetryAndColdTerminalRecovery() async throws {
        let faults = HostIOFaults()
        let core = host(faults)
        _ = try await core.start()
        let task = UUID().uuidString.lowercased()
        _ = try await core.call("mindSweepAdd", argumentsJSON: json([json(["requestId": task, "title": "Retry exact Undo"])]))
        let saved = try await processInboxUndoDecision(core, choice: "reference")
        let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "decisionRequestId": saved.decision, "taskId": task]
        let before = try json(storedTask(task))
        var diagnostics = 0
        faults.commandDiagnostic = { if $0 == "processInboxUndo" { diagnostics += 1 } }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Process Inbox Undo COMMIT failure") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("inboxUndo", argumentsJSON: json([json(request)])) }
        let frozen = try Data(contentsOf: journal)
        XCTAssertEqual(try object(String(decoding: frozen, as: UTF8.self))["method"] as? String, "inboxUndoCommit")
        XCTAssertEqual(try json(storedTask(task)), before)
        await expectFailure("SAVE_FAILED") { _ = try await core.retryPending() }
        try assertJournalContentUnchanged(frozen)
        XCTAssertEqual(try json(storedTask(task)), before)
        XCTAssertEqual(diagnostics, 0)
        faults.beforeSQL = nil
        faults.journalRemove = { throw HostFailure("Injected Process Inbox Undo cleanup failure") }
        await expectFailure("cleanup failure") { _ = try await core.retryPending() }
        XCTAssertEqual(try storedTask(task)["status"] as? String, "inbox")
        let applied = try json(storedTask(task))
        XCTAssertEqual(diagnostics, 0)
        await core.close()
        let coldFaults = HostIOFaults()
        var writes = 0, coldDiagnostics = 0
        coldFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        coldFaults.commandDiagnostic = { if $0 == "processInboxUndo" { coldDiagnostics += 1 } }
        let cold = host(coldFaults)
        let window = try object(await cold.start())
        let recovery = try XCTUnwrap(window["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "inboxUndoCommit")
        let result = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertEqual(try json(result), try json(["taskId": task, "decisionRequestId": saved.decision, "kind": "filed"]))
        XCTAssertEqual(try json(storedTask(task)), applied)
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(coldDiagnostics, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let outcome = try object(await cold.call("inboxUndoRetryOutcome", argumentsJSON: json([json(request)])))
        XCTAssertEqual(try json(outcome), try json(result))
        let newUndo: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "decisionRequestId": saved.decision, "taskId": task]
        await expectFailure("INVALID_INPUT") { _ = try await cold.call("inboxUndo", argumentsJSON: json([json(newUndo)])) }
        XCTAssertEqual(writes, 0)
    }

    func testProcessInboxUndoMalformedPublicAndForgedJournalsRefuse() async throws {
        let faults = HostIOFaults()
        let core = host(faults)
        _ = try await core.start()
        let task = UUID().uuidString.lowercased()
        _ = try await core.call("mindSweepAdd", argumentsJSON: json([json(["requestId": task, "title": "Do not trust a forged Undo"])]))
        let saved = try await processInboxUndoDecision(core, choice: "reference")
        let id = UUID().uuidString.lowercased()
        let request: [String: Any] = ["requestId": id, "decisionRequestId": saved.decision, "taskId": task]
        for method in ["inboxUndo", "inboxUndoRetryOutcome"] {
            for invalid in ["{}", try json(["requestId": saved.decision, "decisionRequestId": saved.decision, "taskId": task]),
                            try json(["requestId": id, "decisionRequestId": saved.decision, "taskId": task, "decision": [:]]),
                            try json(["requestId": id, "decisionRequestId": saved.decision, "taskId": String(repeating: "界", count: 501)]),
                            "{\"requestId\":\"\(id)\",\"requestId\":\"\(id)\",\"decisionRequestId\":\"\(saved.decision)\",\"taskId\":\"\(task)\"}"] {
                await expectFailure("INVALID_INPUT") { _ = try await core.call(method, argumentsJSON: json([invalid])) }
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
        }
        for method in ["inboxUndoPrepare", "inboxUndoValidate", "inboxUndoCommit", "inboxUndoOutcome"] {
            await expectFailure("unavailable") { _ = try await core.call(method, argumentsJSON: json(["{}"])) }
        }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending Undo") } }
        await expectFailure("SAVE_FAILED") { _ = try await core.call("inboxUndo", argumentsJSON: json([json(request)])) }
        let frozen = try object(String(contentsOf: journal))
        let args = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(frozen["argumentsJSON"] as? String).utf8)) as? [String])
        let envelope = try object(XCTUnwrap(args.first))
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        let result = try XCTUnwrap(prepared["result"] as? [String: Any])
        await core.close()
        let beforeDB = try Data(contentsOf: database)
        for corruption in ["extra", "ack", "duplicate", "oversized"] {
            var forgedEnvelope = envelope
            var forgedPrepared = prepared
            var forgedResult = result
            if corruption == "extra" { forgedPrepared["extra"] = true }
            if corruption == "ack" { forgedResult["taskId"] = "Another task" }
            forgedEnvelope["prepared"] = forgedPrepared
            var raw = try json(forgedEnvelope)
            if corruption == "duplicate" { raw = "{\"request\":{}," + String(raw.dropFirst()) }
            if corruption == "oversized" { raw += String(repeating: " ", count: 4_500_001) }
            let data = try Data(json(["version": 2, "method": "inboxUndoCommit", "argumentsJSON": json([raw]),
                                     "terminal": ["success": ["_0": json(forgedResult)]]]).utf8)
            try data.write(to: journal)
            let blockedFaults = HostIOFaults()
            var sql = 0
            blockedFaults.beforeSQL = { _ in sql += 1 }
            let blocked = host(blockedFaults)
            await expectFailure { _ = try await blocked.start() }
            XCTAssertEqual(sql, 0, corruption)
            XCTAssertEqual(try Data(contentsOf: database), beforeDB, corruption)
            XCTAssertEqual(try Data(contentsOf: journal), data, corruption)
            await blocked.close()
        }
        // Even a structurally valid terminal and matching result need the Undo's own receipt.
        let terminal = try Data(json(["version": 2, "method": "inboxUndoCommit", "argumentsJSON": json([json(envelope)]),
                                     "terminal": ["success": ["_0": json(result)]]]).utf8)
        try terminal.write(to: journal)
        let noReceiptFaults = HostIOFaults()
        var mutations = 0
        noReceiptFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|native_request_receipts)\b"#, options: .regularExpression) != nil { mutations += 1 }
        }
        let noReceipt = host(noReceiptFaults)
        await expectFailure("saved receipt") { _ = try await noReceipt.start() }
        XCTAssertEqual(mutations, 0)
        XCTAssertEqual(try Data(contentsOf: journal), terminal)
    }

    func testProcessInboxUndoLostAcknowledgmentColdReceiptPrecedesLaterTaskEdit() async throws {
        let source = try dateBundle(at: "2026-10-20T12:00:00.000Z", suffix: """
        (() => {
            const commit = MindwtrHost.inboxUndoCommit, poll = MindwtrHost.poll;
            const tickets = new Set(); let failOnce = true;
            MindwtrHost.inboxUndoCommit = function (raw) { const id = commit(raw); tickets.add(id); return id; };
            MindwtrHost.poll = function (id) {
                const reply = poll(id);
                if (failOnce && tickets.has(id) && reply && JSON.parse(reply).ok) {
                    failOnce = false;
                    return JSON.stringify({ok: false, error: 'Injected Process Inbox Undo lost acknowledgment'});
                }
                return reply;
            };
        })();
        """)
        let core = host(bundleURL: source)
        _ = try await core.start()
        let task = UUID().uuidString.lowercased()
        _ = try await core.call("mindSweepAdd", argumentsJSON: json([json(["requestId": task, "title": "Lost reply original"])]))
        let saved = try await processInboxUndoDecision(core, choice: "reference")
        let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "decisionRequestId": saved.decision, "taskId": task]
        await expectFailure("lost acknowledgment") { _ = try await core.call("inboxUndo", argumentsJSON: json([json(request)])) }
        let pending = try object(String(contentsOf: journal))
        XCTAssertNil(pending["terminal"])
        XCTAssertEqual(try storedTask(task)["status"] as? String, "inbox")
        await core.close()
        let outside = try SQLiteBridge(url: database)
        _ = try outside.execute("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", parametersJSON: json(["Edit after proven Undo", task]))
        outside.close()
        let edited = try json(storedTask(task))
        let faults = HostIOFaults()
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        let cold = host(faults, bundleURL: try dateBundle(at: "2026-10-21T12:00:00.000Z", suffix: """
        (() => {
            const prune = MindwtrHost.iosPruneReceipts;
            MindwtrHost.iosPruneReceipts = function (retention, owed, inbox) {
                if (JSON.stringify(inbox) !== JSON.stringify(['\(try XCTUnwrap(request["requestId"] as? String))', '\(saved.decision)'])) {
                    throw new Error('Cold Undo must retain both exact journal request identities');
                }
                return prune(retention, owed, inbox);
            };
            MindwtrHost.inboxUndoPrepare = function () { throw new Error('Cold Undo must never prepare again'); };
        })();
        """))
        let window = try object(await cold.start())
        XCTAssertEqual((window["recovery"] as? [String: Any])?["method"] as? String, "inboxUndoCommit")
        XCTAssertEqual(try json(storedTask(task)), edited)
        XCTAssertEqual(writes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let outcome = try object(await cold.call("inboxUndoRetryOutcome", argumentsJSON: json([json(request)])))
        XCTAssertEqual(try json(outcome), try json(["taskId": task, "decisionRequestId": saved.decision, "kind": "filed"]))
        let opened = try object(await cold.call("inboxStart", argumentsJSON: json(["quick"])))
        XCTAssertNil(opened["toast"])
    }

}
