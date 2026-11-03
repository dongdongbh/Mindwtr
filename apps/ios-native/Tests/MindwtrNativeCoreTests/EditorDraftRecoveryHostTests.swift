import XCTest
import SQLite3
@testable import MindwtrNativeCore

final class EditorDraftRecoveryHostTests: XCTestCase {
    private var directory: URL!
    private var bundle: URL!
    private var database: URL { directory.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var snapshotFile: URL { EditorDraftStore(databaseURL: database).url }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE to its absolute path")
        }
        bundle = URL(fileURLWithPath: path)
        directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let directory { try FileManager.default.removeItem(at: directory) }
    }

    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await value.close() }
        return value
    }

    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func task(_ id: String) throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute(
            "SELECT * FROM tasks WHERE id = ?", parametersJSON: json([id])).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }

    private func seed(_ core: CoreHost, id: String) async throws -> [String: Any] {
        let opened = try object(await core.call("captureOpen"))
        _ = try await core.call("captureSubmit", argumentsJSON: json([json([
            "text": "Before edit", "options": try XCTUnwrap(opened["options"]),
            "captureId": id, "openAfterSave": false,
        ])]))
        return try object(await core.call("editorModel", argumentsJSON: json([id])))
    }

    private func titleSave(_ id: String, opening: [String: Any]) throws -> String {
        try json([json([
            "id": id, "base": ["title": "Before edit"], "patch": ["title": "After edit"],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
        ])])
    }

    private func cancellationArguments(_ id: String, requestID: String, opening: [String: Any]) throws -> String {
        try json([json(["id": id, "requestId": requestID, "intent": "cancel",
            "base": ["title": "Before edit"], "patch": ["title": "Cancelled draft title"],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []]])])
    }

    private func recurringOpening(_ core: CoreHost, id: String) async throws -> [String: Any] {
        let opening = try await seed(core, id: id)
        let edited = try object(await core.call("editDraft", argumentsJSON: json([json([
            "id": id, "draft": try XCTUnwrap(opening["draft"]),
            "edit": ["type": "recurrence", "edit": ["kind": "rule", "rule": "daily"]],
        ])])))
        let original = try XCTUnwrap(opening["draft"] as? [String: Any])
        let changed = try XCTUnwrap(edited["draft"] as? [String: Any])
        let recurrenceFields = ["recurrence", "recurrenceStrategy", "recurrenceRRule", "showFutureRecurrence"]
        var base = try Dictionary(uniqueKeysWithValues: recurrenceFields.map { ($0, try XCTUnwrap(original[$0])) })
        var patch = try Dictionary(uniqueKeysWithValues: recurrenceFields.map { ($0, try XCTUnwrap(changed[$0])) })
        base["dueDate"] = try XCTUnwrap(original["dueDate"])
        patch["dueDate"] = "2036-10-05"
        _ = try await core.call("saveDraft", argumentsJSON: json([json([
            "id": id, "base": base, "patch": patch,
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "recurrenceBase": try XCTUnwrap(opening["recurrenceBase"]),
        ])]))
        let recurring = try object(await core.call("editorModel", argumentsJSON: json([id])))
        XCTAssertEqual(recurring["canSkipOccurrence"] as? Bool, true)
        return recurring
    }

    private func skipArguments(_ id: String, opening: [String: Any], intent: String = "skip",
                               baseTitle: String = "Before edit") throws -> String {
        try json([json(["id": id, "requestId": UUID().uuidString.lowercased(), "intent": intent,
            "base": ["title": baseTitle], "patch": ["title": "Skipped draft title"],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []]])])
    }

    private func taskRows() throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute(
            "SELECT * FROM tasks ORDER BY id", parametersJSON: "[]").utf8)) as? [[String: Any]])
    }

    private func projectRows() throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database)
        defer { sqlite.close() }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute(
            "SELECT * FROM projects ORDER BY id", parametersJSON: "[]").utf8)) as? [[String: Any]])
    }

    private func promotionArguments(_ id: String, requestID: String, opening: [String: Any],
                                    title: String = "Draft project") throws -> String {
        try json([json(["requestId": requestID, "taskId": id,
            "taskRevision": try XCTUnwrap(opening["taskRevision"] as? String), "title": title])])
    }

    private func deletionArguments(_ id: String, requestID: String, opening: [String: Any]) throws -> String {
        try json([json(["requestId": requestID, "taskId": id,
            "taskRevision": try XCTUnwrap(opening["taskRevision"] as? String)])])
    }

    func testTaskDeleteKeepsSavedSourceAndFrozenDraftUntilColdCommit() async throws {
        let faults = HostIOFaults(), first = host()
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        await first.close()
        let writing = host(faults); _ = try await writing.start()
        let before = try json(task(id))
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved deleted title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let args = try deletionArguments(id, requestID: UUID().uuidString.lowercased(), opening: opening)
        do {
            _ = try await writing.call("taskDelete", argumentsJSON: args)
            XCTFail("Delete with an editor snapshot must use its exact attempt")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Editor draft must use")) }
        XCTAssertEqual(try json(task(id)), before)
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Delete COMMIT") } }
        do {
            _ = try await writing.saveEditorDraft("taskDelete", argumentsJSON: args,
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected failed Delete")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(task(id)), before)
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read())
        XCTAssertEqual(frozen.snapshot, draft)
        XCTAssertEqual(frozen.attempt?.method, "taskDelete")
        let owed = try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal)))
        do { _ = try await writing.retryPending(); XCTFail("Expected repeated Delete failure") } catch {}
        XCTAssertEqual(try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal))), owed)
        await writing.close()

        let recovered = host()
        let startup = try object(await recovered.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "taskDeleteCommit")
        let result = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertEqual(result["id"] as? String, id)
        XCTAssertEqual((result["deletion"] as? [String: Any])?["undoEnabled"] as? Bool, true)
        let deleted = try task(id)
        XCTAssertEqual(deleted["title"] as? String, "Before edit")
        XCTAssertNotNil(deleted["deletedAt"] as? String)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(task(id)), try json(deleted))
    }

    func testTaskDeleteUndoRequiresConfirmedProofAndColdRestoresSavedSource() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(writing, id: id)
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved deleted title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let deleteID = UUID().uuidString.lowercased()
        let deletion = try object(await writing.saveEditorDraft("taskDelete",
            argumentsJSON: deletionArguments(id, requestID: deleteID, opening: opening),
            expectedSession: draft.sessionID, expectedGeneration: draft.generation))
        XCTAssertEqual(deletion["id"] as? String, id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        let deleted = try json(task(id))
        do {
            _ = try await writing.call("taskDeleteUndo", argumentsJSON: json([json([
                "requestId": UUID().uuidString.lowercased(), "deleteRequestId": UUID().uuidString.lowercased()])]))
            XCTFail("Expected unconfirmed Undo refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT")) }
        XCTAssertEqual(try json(task(id)), deleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let undoArgs = try json([json(["requestId": UUID().uuidString.lowercased(), "deleteRequestId": deleteID])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Delete Undo COMMIT") } }
        do {
            _ = try await writing.call("taskDeleteUndo", argumentsJSON: undoArgs)
            XCTFail("Expected failed Delete Undo")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(task(id)), deleted)
        await writing.close()

        let recovered = host(); _ = try await recovered.start()
        let restored = try task(id)
        XCTAssertTrue(restored["deletedAt"] is NSNull)
        XCTAssertEqual(restored["title"] as? String, "Before edit")
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(task(id)), try json(restored))
    }

    func testTaskDeleteTerminalDraftCleanupRetainsExactUndoProof() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(writing, id: id)
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved deleted title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let deleteID = UUID().uuidString.lowercased()
        faults.editorDraftRemove = { throw HostFailure("Injected Delete draft cleanup") }
        do {
            _ = try await writing.saveEditorDraft("taskDelete",
                argumentsJSON: deletionArguments(id, requestID: deleteID, opening: opening),
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected terminal draft cleanup failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Injected Delete draft cleanup")) }
        XCTAssertNotNil(try task(id)["deletedAt"] as? String)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.attempt?.method, "taskDelete")
        faults.editorDraftRemove = nil
        let acknowledgment = try await writing.retryPending()
        let result = try XCTUnwrap(acknowledgment)
        XCTAssertEqual(try object(result)["id"] as? String, id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        let undo = try object(await writing.call("taskDeleteUndo", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "deleteRequestId": deleteID])])))
        XCTAssertEqual(undo["id"] as? String, id)
        XCTAssertTrue(try task(id)["deletedAt"] is NSNull)
        XCTAssertEqual(try task(id)["title"] as? String, "Before edit")
    }

    func testTaskPromoteFailedCommitRetainsDraftAndColdMovesSavedTaskOnce() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(writing, id: id)
        let requestID = UUID().uuidString.lowercased()
        let args = try promotionArguments(id, requestID: requestID, opening: opening)
        let beforeTask = try json(taskRows()), beforeProjects = try json(projectRows())
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Draft project","description":"Unsaved notes"}}"#)
        try await writing.checkpointEditorDraft(draft)
        do {
            _ = try await writing.call("taskPromote", argumentsJSON: args)
            XCTFail("A dirty editor must use its frozen promotion attempt")
        } catch { XCTAssertTrue(error.localizedDescription.contains("exact Save attempt")) }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected promotion COMMIT") } }
        do {
            _ = try await writing.saveEditorDraft("taskPromote", argumentsJSON: args,
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected failed promotion")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(taskRows()), beforeTask)
        XCTAssertEqual(try json(projectRows()), beforeProjects)
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read())
        XCTAssertEqual(frozen.snapshot, draft)
        XCTAssertEqual(frozen.attempt?.method, "taskPromote")
        let owed = try object(String(contentsOf: journal))
        do { _ = try await writing.retryPending(); XCTFail("Expected repeated promotion failure") } catch {}
        let retried = try object(String(contentsOf: journal))
        XCTAssertEqual(try json(retried), try json(owed))
        XCTAssertEqual(retried["argumentsJSON"] as? String, owed["argumentsJSON"] as? String)
        XCTAssertEqual(try json(taskRows()), beforeTask)
        XCTAssertEqual(try json(projectRows()), beforeProjects)
        await writing.close()

        let recovered = host()
        let startup = try object(await recovered.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "taskPromoteCommit")
        let result = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), Set(["id", "reused"]))
        XCTAssertEqual(result["id"] as? String, requestID)
        XCTAssertEqual(result["reused"] as? Bool, false)
        let moved = try task(id)
        XCTAssertEqual(moved["id"] as? String, id)
        XCTAssertEqual(moved["title"] as? String, "Before edit")
        XCTAssertEqual(moved["projectId"] as? String, requestID)
        let projects = try projectRows()
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects.first?["title"] as? String, "Draft project")
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let tasks = try taskRows()
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(taskRows()), try json(tasks))
        XCTAssertEqual(try json(projectRows()), try json(projects))
    }

    func testTaskPromoteLostTerminalColdReturnsExactReceipt() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(writing, id: id)
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Draft project"}}"#)
        try await writing.checkpointEditorDraft(draft)
        var writes = 0
        faults.journalWrite = {
            writes += 1
            if writes == 2 { throw HostFailure("Injected promotion terminal loss") }
        }
        let requestID = UUID().uuidString.lowercased()
        do {
            _ = try await writing.saveEditorDraft("taskPromote",
                argumentsJSON: promotionArguments(id, requestID: requestID, opening: opening),
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected lost terminal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("terminal loss")) }
        XCTAssertEqual(writes, 2)
        let tasks = try taskRows(), projects = try projectRows()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(projects.count, 1)
        XCTAssertNil(try object(String(contentsOf: journal))["terminal"])
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        await writing.close()

        let replayFaults = HostIOFaults()
        var rowWrites = 0
        replayFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|projects)\b"#,
                         options: .regularExpression) != nil { rowWrites += 1 }
        }
        let recovered = host(replayFaults)
        let startup = try object(await recovered.start())
        let result = try XCTUnwrap((startup["recovery"] as? [String: Any])?["result"] as? [String: Any])
        XCTAssertEqual(result["id"] as? String, requestID)
        XCTAssertEqual(result["reused"] as? Bool, false)
        XCTAssertEqual(rowWrites, 0)
        XCTAssertEqual(try json(taskRows()), try json(tasks))
        XCTAssertEqual(try json(projectRows()), try json(projects))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testTaskPromoteInvalidAndStaleRequestPreserveCheckpoint() async throws {
        let writing = host()
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(writing, id: id)
        let beforeTask = try json(taskRows()), beforeProjects = try json(projectRows())
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Draft project"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let invalid = try json([json(["requestId": "invalid", "taskId": id,
            "taskRevision": try XCTUnwrap(opening["taskRevision"]), "title": "Draft project"])])
        do {
            _ = try await writing.saveEditorDraft("taskPromote", argumentsJSON: invalid,
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected invalid request refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT")) }
        let stale = try json([json(["requestId": UUID().uuidString.lowercased(), "taskId": id,
            "taskRevision": "stale-revision", "title": "Draft project"])])
        do {
            _ = try await writing.saveEditorDraft("taskPromote", argumentsJSON: stale,
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected stale revision refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("STALE_REVISION")) }
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try json(taskRows()), beforeTask)
        XCTAssertEqual(try json(projectRows()), beforeProjects)
    }

    func testTaskCancellationFailedCommitRetainsDraftAndColdAppliesOnce() async throws {
        let faults = HostIOFaults(), first = host()
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        await first.close()
        let writing = host(faults)
        _ = try await writing.start()
        let before = try json(task(id))
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Cancelled draft title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let args = try cancellationArguments(id, requestID: UUID().uuidString.lowercased(), opening: opening)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected cancel COMMIT") } }
        do {
            _ = try await writing.saveEditorDraft("checklistSave", argumentsJSON: args,
                expectedSession: draft.sessionID, expectedGeneration: 1)
            XCTFail("Expected failed cancellation")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(task(id)), before)
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        let owed = try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal)))
        do { _ = try await writing.retryPending(); XCTFail("Expected repeated failure") } catch {}
        XCTAssertEqual(try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal))), owed)
        await writing.close()
        let recovered = host()
        let startup = try object(await recovered.start())
        let result = try XCTUnwrap((startup["recovery"] as? [String: Any])?["result"] as? [String: Any])
        let cancelledAt = try XCTUnwrap((result["cancellation"] as? [String: Any])?["cancelledAt"] as? String)
        let saved = try task(id)
        XCTAssertEqual(saved["status"] as? String, "archived")
        XCTAssertEqual(saved["title"] as? String, "Cancelled draft title")
        XCTAssertEqual(saved["cancelledAt"] as? String, cancelledAt)
        XCTAssertTrue(saved["completedAt"] is NSNull)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(task(id)), try json(saved))
    }

    func testSkipFailedCommitKeepsDirtyDraftAndColdCreatesOneFollowUp() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await recurringOpening(writing, id: id)
        let before = try json(taskRows())
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Skipped draft title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let args = try skipArguments(id, opening: opening)
        do {
            _ = try await writing.call("checklistSave", argumentsJSON: args)
            XCTFail("A dirty editor must use its frozen Save attempt")
        } catch { XCTAssertTrue(error.localizedDescription.contains("exact Save attempt")) }
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Skip COMMIT") } }
        do {
            _ = try await writing.saveEditorDraft("checklistSave", argumentsJSON: args,
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected failed Skip")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(taskRows()), before)
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read())
        XCTAssertEqual(frozen.snapshot, draft)
        XCTAssertEqual(frozen.attempt?.method, "checklistSave")
        let owed = try object(String(contentsOf: journal))
        do { _ = try await writing.retryPending(); XCTFail("Expected repeated Skip failure") } catch {}
        let retried = try object(String(contentsOf: journal))
        XCTAssertEqual(try json(retried), try json(owed))
        XCTAssertEqual(retried["argumentsJSON"] as? String, owed["argumentsJSON"] as? String)
        XCTAssertEqual(try json(taskRows()), before)
        await writing.close()

        let recovered = host()
        let startup = try object(await recovered.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "checklistPreparedCommit")
        let result = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), Set(["id"]))
        XCTAssertEqual(result["id"] as? String, id)
        let skipped = try task(id)
        XCTAssertEqual(skipped["status"] as? String, "archived")
        XCTAssertEqual(skipped["title"] as? String, "Skipped draft title")
        XCTAssertTrue(skipped["completedAt"] is NSNull)
        XCTAssertNotNil(skipped["cancelledAt"] as? String)
        let rows = try taskRows()
        XCTAssertEqual(rows.count, 2)
        let followUp = try XCTUnwrap(rows.first { $0["id"] as? String != id })
        XCTAssertEqual(followUp["title"] as? String, "Skipped draft title")
        XCTAssertEqual(followUp["status"] as? String, "inbox")
        XCTAssertEqual(followUp["dueDate"] as? String, "2036-10-06")
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(taskRows()), try json(rows))
    }

    func testSkipLostTerminalRetryKeepsOneFrozenFollowUp() async throws {
        let faults = HostIOFaults(), writing = host(faults)
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await recurringOpening(writing, id: id)
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Skipped draft title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        var writes = 0
        faults.journalWrite = {
            writes += 1
            if writes == 2 { throw HostFailure("Injected Skip terminal loss") }
        }
        do {
            _ = try await writing.saveEditorDraft("checklistSave",
                argumentsJSON: skipArguments(id, opening: opening),
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected lost terminal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("terminal loss")) }
        XCTAssertEqual(writes, 2)
        let committed = try taskRows()
        XCTAssertEqual(committed.count, 2)
        XCTAssertNil(try object(String(contentsOf: journal))["terminal"])
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        faults.journalWrite = { throw HostFailure("Injected Skip retry terminal loss") }
        do { _ = try await writing.retryPending(); XCTFail("Expected failed terminal retry") }
        catch { XCTAssertTrue(error.localizedDescription.contains("retry terminal loss")) }
        XCTAssertEqual(try json(taskRows()), try json(committed))
        await writing.close()

        let recovered = host()
        let startup = try object(await recovered.start())
        let result = try XCTUnwrap((startup["recovery"] as? [String: Any])?["result"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), Set(["id"]))
        XCTAssertEqual(result["id"] as? String, id)
        XCTAssertEqual(try json(taskRows()), try json(committed))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(taskRows()), try json(committed))
    }

    func testSkipInvalidIntentAndStaleDraftKeepCheckpoint() async throws {
        let writing = host()
        _ = try await writing.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await recurringOpening(writing, id: id)
        let before = try json(taskRows())
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Skipped draft title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        do {
            _ = try await writing.saveEditorDraft("checklistSave",
                argumentsJSON: skipArguments(id, opening: opening, intent: "skip-again"),
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected unsupported intent refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT")) }
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        do {
            _ = try await writing.saveEditorDraft("checklistSave",
                argumentsJSON: skipArguments(id, opening: opening, baseTitle: "Stale title"),
                expectedSession: draft.sessionID, expectedGeneration: draft.generation)
            XCTFail("Expected stale baseline refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("STALE_REVISION")) }
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertEqual(try json(taskRows()), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testTaskCancellationUndoRequiresConfirmedProofAndColdRetriesExactly() async throws {
        let faults = HostIOFaults(), core = host()
        _ = try await core.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(core, id: id)
        await core.close()
        let writing = host(faults); _ = try await writing.start()
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id,
            generation: 1, payloadJSON: #"{"raw":{"title":"Cancelled draft title"}}"#)
        try await writing.checkpointEditorDraft(draft)
        let cancellationID = UUID().uuidString.lowercased()
        let result = try object(await writing.saveEditorDraft("checklistSave",
            argumentsJSON: cancellationArguments(id, requestID: cancellationID, opening: opening),
            expectedSession: draft.sessionID, expectedGeneration: 1))
        XCTAssertNotNil(result["cancellation"])
        let cancelled = try json(task(id))
        do {
            _ = try await writing.call("taskCancellationUndo", argumentsJSON: json([json([
                "requestId": UUID().uuidString.lowercased(), "cancelRequestId": UUID().uuidString.lowercased()])]))
            XCTFail("Expected unconfirmed Undo refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("INVALID_INPUT")) }
        XCTAssertEqual(try json(task(id)), cancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let undoArguments = try json([json([
            "requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancellationID])])
        faults.journalWrite = { throw HostFailure("Injected Undo pre-journal failure") }
        do {
            _ = try await writing.call("taskCancellationUndo", argumentsJSON: undoArguments)
            XCTFail("Expected pre-journal Undo failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Injected Undo pre-journal failure")) }
        XCTAssertEqual(try json(task(id)), cancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        faults.journalWrite = nil
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Undo COMMIT") } }
        do {
            _ = try await writing.retryPending()
            XCTFail("Expected failed Undo")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertEqual(try json(task(id)), cancelled)
        await writing.close()
        let recovered = host(); _ = try await recovered.start()
        let restored = try task(id)
        XCTAssertEqual(restored["status"] as? String, "inbox")
        XCTAssertEqual(restored["title"] as? String, "Cancelled draft title")
        XCTAssertTrue(restored["cancelledAt"] is NSNull)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await recovered.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try json(task(id)), try json(restored))
    }

    func testTaskDuplicateKeepsFrozenDraftUntilColdCommitAndCopiesSavedSource() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let sourceID = UUID().uuidString.lowercased()
        _ = try await seed(first, id: sourceID)
        let before = try json(task(sourceID))
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: sourceID,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved source title"}}"#)
        try await first.checkpointEditorDraft(snapshot)
        let copyID = UUID().uuidString.lowercased()
        let args = try json([json(["requestId": copyID, "action": ["type": "duplicateTask", "taskId": sourceID]])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Duplicate COMMIT failure") } }
        do {
            _ = try await first.saveEditorDraft("boardAction", argumentsJSON: args,
                expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
            XCTFail("Expected failed duplicate")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read())
        XCTAssertEqual(frozen.snapshot, snapshot)
        XCTAssertEqual(frozen.attempt?.method, "boardAction")
        XCTAssertEqual(try json(task(sourceID)), before)
        let owed = try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal)))
        do { _ = try await first.retryPending(); XCTFail("Expected failed retry") } catch {}
        XCTAssertEqual(try json(JSONSerialization.jsonObject(with: Data(contentsOf: journal))), owed)
        await first.close()

        let second = host()
        let startup = try object(await second.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "boardCommit")
        let result = try XCTUnwrap(recovery["result"] as? [String: Any])
        XCTAssertEqual((result["open"] as? [String: Any])?["taskId"] as? String, copyID)
        XCTAssertEqual(try task(copyID)["title"] as? String, "Before edit")
        XCTAssertEqual(try json(task(sourceID)), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let copy = try json(task(copyID))
        await second.close()
        let third = host()
        _ = try await third.start()
        XCTAssertEqual(try json(task(copyID)), copy)
        XCTAssertEqual(try json(task(sourceID)), before)
    }

    func testTaskDuplicateRejectsWrongSourceAndTrashWithoutConsumingDraft() async throws {
        let core = host()
        _ = try await core.start()
        let sourceID = UUID().uuidString.lowercased()
        _ = try await seed(core, id: sourceID)
        let before = try json(task(sourceID))
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: sourceID,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved"}}"#)
        try await core.checkpointEditorDraft(snapshot)
        for action in [["type": "duplicateTask", "taskId": "wrong-source"], ["type": "trashTask", "taskId": sourceID]] {
            do {
                _ = try await core.saveEditorDraft("boardAction",
                    argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(), "action": action])]),
                    expectedSession: snapshot.sessionID, expectedGeneration: 1)
                XCTFail("Expected identity refusal")
            } catch {}
            XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, snapshot)
            XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertEqual(try json(task(sourceID)), before)
        }
    }

    func testTaskDuplicateLostAcknowledgmentRemovesOnlyItsDraftWithoutSecondWrite() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let sourceID = UUID().uuidString.lowercased()
        _ = try await seed(first, id: sourceID)
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: sourceID,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved"}}"#)
        try await first.checkpointEditorDraft(snapshot)
        let copyID = UUID().uuidString.lowercased()
        faults.editorDraftRemove = { throw HostFailure("Injected draft cleanup failure") }
        do {
            _ = try await first.saveEditorDraft("boardAction",
                argumentsJSON: json([json(["requestId": copyID, "action": ["type": "duplicateTask", "taskId": sourceID]])]),
                expectedSession: snapshot.sessionID, expectedGeneration: 1)
            XCTFail("Expected cleanup failure")
        } catch {}
        let copy = try json(task(copyID))
        XCTAssertNotNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        await first.close()
        let replayFaults = HostIOFaults()
        replayFaults.beforeSQL = { sql in
            if sql == "COMMIT" { throw HostFailure("Replay must not write") }
        }
        let second = host(replayFaults)
        _ = try await second.start()
        XCTAssertEqual(try json(task(copyID)), copy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testInterruptedPersonCreatePreservesUnsavedTaskCheckpointAcrossColdReplay() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let taskID = UUID().uuidString.lowercased()
        _ = try await seed(first, id: taskID)
        let before = try json(task(taskID))
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID,
            generation: 1, payloadJSON: #"{"raw":{"title":"Unsaved title","assignedTo":"  Inline Person  "}}"#)
        try await first.checkpointEditorDraft(draft)
        let personID = UUID().uuidString.lowercased()
        let request: [String: Any] = ["requestId": personID, "expectedPersonId": personID,
                                     "name": "  Inline Person  ", "note": "", "referenceLink": ""]
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Person COMMIT failure") } }
        do {
            _ = try await first.call("managePersonCreate", argumentsJSON: json([json(request)]))
            XCTFail("Expected failed Person write")
        } catch { XCTAssertTrue(error.localizedDescription.contains("SAVE_FAILED"), error.localizedDescription) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try json(task(taskID)), before)
        await first.close()

        let second = host()
        let startup = try object(await second.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "managePersonCreateCommit")
        let retained = try await second.readEditorDraft()
        XCTAssertEqual(retained, draft)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertEqual(try json(task(taskID)), before)
        let resolved = try object(await second.call("managePersonCreateResolve", argumentsJSON: json([
            json(["requestId": personID, "name": "  Inline Person  "])])))
        XCTAssertEqual(resolved["expectedPersonId"] as? String, personID)
        XCTAssertEqual(resolved["displayName"] as? String, "Inline Person")
        XCTAssertEqual(resolved["taken"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await second.close()

        let third = host()
        _ = try await third.start()
        XCTAssertEqual(try json(task(taskID)), before)
        let stillRetained = try await third.readEditorDraft()
        XCTAssertEqual(stillRetained, draft)
    }

    func testSnapshotStrictIdentityCorruptionAndPrivacy() throws {
        let store = EditorDraftStore(databaseURL: database)
        let session = UUID().uuidString.lowercased()
        let first = EditorDraftSnapshot(sessionID: session, taskID: "task-one", generation: 1,
                                        payloadJSON: #"{"note":"private draft"}"#)
        try store.checkpoint(first)
        XCTAssertEqual(try store.read()?.snapshot, first)
        XCTAssertThrowsError(try store.checkpoint(EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(),
            taskID: "task-one", generation: 2, payloadJSON: "{}")))
        XCTAssertThrowsError(try store.checkpoint(EditorDraftSnapshot(sessionID: session,
            taskID: "task-one", generation: 0, payloadJSON: "{}")))
        let second = EditorDraftSnapshot(sessionID: session, taskID: "task-one", generation: 2, payloadJSON: "{}")
        try store.checkpoint(second)
        XCTAssertThrowsError(try store.checkpoint(first))
        XCTAssertThrowsError(try store.checkpoint(EditorDraftSnapshot(sessionID: session,
            taskID: "task-two", generation: 3, payloadJSON: "{}")))
        let attempt = try store.freeze(sessionID: session, generation: 2, method: "saveDraft",
                                       argumentsJSON: #"["{\"id\":\"task-one\"}"]"#)
        XCTAssertThrowsError(try store.checkpoint(EditorDraftSnapshot(sessionID: session,
            taskID: "task-one", generation: 3, payloadJSON: "{}")))
        try store.thaw(attempt)
        XCTAssertEqual(try store.read()?.snapshot, second)
        #if os(iOS)
        let attributes = try FileManager.default.attributesOfItem(atPath: snapshotFile.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
        XCTAssertTrue(try snapshotFile.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try Data(#"{"snapshot":{"version":2}}"#.utf8).write(to: snapshotFile)
        XCTAssertThrowsError(try store.read())
        try store.discardCorrupt()
        XCTAssertNil(try store.read())
        try Data(repeating: 0, count: 3_000_001).write(to: snapshotFile)
        XCTAssertThrowsError(try store.read())
        try store.discardCorrupt()
        try store.checkpoint(second)
        XCTAssertThrowsError(try store.discardCorrupt())
        XCTAssertEqual(try store.read()?.snapshot, second)
    }

    func testTerminalCleanupFailureColdReplayRemovesOnlyMatchingSnapshot() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: id, generation: 1, payloadJSON: "{}")
        try await first.checkpointEditorDraft(draft)
        faults.editorDraftRemove = { throw HostFailure("Injected draft cleanup failure") }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected cleanup failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("cleanup failure")) }
        XCTAssertEqual(try task(id)["title"] as? String, "After edit")
        let rev = try XCTUnwrap(task(id)["rev"] as? Int)
        XCTAssertNotNil(try object(String(contentsOf: journal))["terminal"])
        XCTAssertNotNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        await first.close()

        let second = host()
        _ = try await second.start()
        XCTAssertEqual(try task(id)["rev"] as? Int, rev)
        XCTAssertEqual(try task(id)["title"] as? String, "After edit")
        let restored = try await second.readEditorDraft()
        XCTAssertNil(restored)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        await second.close()
    }

    func testFrozenBeforeJournalRestoresAsUnsavedOnColdStart() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: id, generation: 1,
                                        payloadJSON: #"{"title":"unsaved"}"#)
        try await first.checkpointEditorDraft(draft)
        faults.journalWrite = { throw HostFailure("Injected pre-journal failure") }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected journal failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("pre-journal failure")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try task(id)["title"] as? String, "Before edit")
        await first.close()

        let second = host()
        _ = try await second.start()
        let restored = try await second.readEditorDraft()
        XCTAssertEqual(restored, draft)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        try await second.checkpointEditorDraft(EditorDraftSnapshot(sessionID: session, taskID: id,
            generation: 2, payloadJSON: #"{"title":"still unsaved"}"#))
        XCTAssertEqual(try task(id)["title"] as? String, "Before edit")
        await second.close()
    }

    func testPreparedNoopCleanupFailureRetainsRetryableSnapshot() async throws {
        let faults = HostIOFaults()
        let core = host(faults)
        _ = try await core.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(core, id: id)
        let session = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: id, generation: 1,
                                        payloadJSON: #"{"title":"Before edit"}"#)
        try await core.checkpointEditorDraft(draft)
        let rev = try XCTUnwrap(task(id)["rev"] as? Int)
        let unchanged = try json([json([
            "id": id, "base": ["title": "Before edit"], "patch": ["title": "Before edit"],
            "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
        ])])
        do {
            _ = try await core.call("saveDraft", argumentsJSON: unchanged)
            XCTFail("Expected direct writer to be fenced")
        } catch { XCTAssertTrue(error.localizedDescription.contains("exact Save attempt")) }
        faults.editorDraftRemove = { throw HostFailure("Injected no-op cleanup failure") }
        do {
            _ = try await core.saveEditorDraft("saveDraft", argumentsJSON: unchanged,
                                              expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected no-op cleanup failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("no-op cleanup failure")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try task(id)["rev"] as? Int, rev)
        let retained = try await core.readEditorDraft()
        XCTAssertEqual(retained, draft)
        faults.editorDraftRemove = nil
        _ = try await core.saveEditorDraft("saveDraft", argumentsJSON: unchanged,
                                           expectedSession: session, expectedGeneration: 1)
        let cleared = try await core.readEditorDraft()
        XCTAssertNil(cleared)
        XCTAssertEqual(try task(id)["rev"] as? Int, rev)
        await core.close()
    }

    func testCommittedWriteWithUnpersistedTerminalColdReplaysExactlyOnce() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: id, generation: 1, payloadJSON: "{}")
        try await first.checkpointEditorDraft(draft)
        let beforeRev = try XCTUnwrap(task(id)["rev"] as? Int)
        var journalWrites = 0
        faults.journalWrite = {
            journalWrites += 1
            if journalWrites == 2 { throw HostFailure("Injected terminal journal failure") }
        }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected terminal journal failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("terminal journal failure")) }
        XCTAssertEqual(journalWrites, 2)
        let committed = try task(id)
        XCTAssertEqual(committed["title"] as? String, "After edit")
        XCTAssertEqual(committed["rev"] as? Int, beforeRev + 1)
        let pending = try object(String(contentsOf: journal))
        XCTAssertNil(pending["terminal"])
        let journalAttempt = try XCTUnwrap(pending["editorDraft"] as? [String: Any])
        XCTAssertEqual(journalAttempt["sessionID"] as? String, session)
        XCTAssertEqual(journalAttempt["taskID"] as? String, id)
        XCTAssertEqual(journalAttempt["generation"] as? Int, 1)
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertEqual(journalAttempt["id"] as? String, frozen.id)
        await first.close()

        let replayFaults = HostIOFaults()
        var replayTaskWrites = 0
        replayFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#,
                         options: .regularExpression) != nil { replayTaskWrites += 1 }
        }
        let second = host(replayFaults)
        _ = try await second.start()
        XCTAssertEqual(replayTaskWrites, 0)
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        let restored = try await second.readEditorDraft()
        XCTAssertNil(restored)
        await second.close()

        let third = host()
        _ = try await third.start()
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read())
        await third.close()
    }

    func testMismatchedAttemptJournalRefusesBeforeDatabaseActivation() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: id, generation: 1, payloadJSON: "{}")
        try await first.checkpointEditorDraft(draft)
        let before = try task(id)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pre-commit failure") } }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected pre-commit failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("pre-commit failure")) }
        let frozen = try XCTUnwrap(EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertEqual(frozen.generation, 1)
        await first.close()

        var pending = try object(String(contentsOf: journal))
        XCTAssertNil(pending["terminal"])
        var tampered = try XCTUnwrap(pending["editorDraft"] as? [String: Any])
        tampered["generation"] = 2
        pending["editorDraft"] = tampered
        let changed = try json(pending)
        try Data(changed.utf8).write(to: journal)
        let replayFaults = HostIOFaults()
        var statements = 0
        replayFaults.beforeSQL = { _ in statements += 1 }
        let second = host(replayFaults)
        do {
            _ = try await second.start()
            XCTFail("Expected identity mismatch before SQLite activation")
        } catch { XCTAssertTrue(error.localizedDescription.contains("identity does not match snapshot")) }
        XCTAssertEqual(statements, 0)
        XCTAssertEqual(try task(id)["rev"] as? Int, before["rev"] as? Int)
        XCTAssertEqual(try task(id)["title"] as? String, "Before edit")
        XCTAssertEqual(try Data(contentsOf: journal), Data(changed.utf8))
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.attempt, frozen)
        await second.close()
    }

    func testPreparedJournalMissingFrozenSnapshotRefusesBeforeDatabaseActivation() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        try await first.checkpointEditorDraft(EditorDraftSnapshot(sessionID: session, taskID: id,
            generation: 1, payloadJSON: "{}"))
        let before = try task(id)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pre-commit failure") } }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected pre-commit failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("pre-commit failure")) }
        let pending = try Data(contentsOf: journal)
        XCTAssertNil(try object(String(decoding: pending, as: UTF8.self))["terminal"])
        await first.close()

        try FileManager.default.removeItem(at: snapshotFile)
        let replayFaults = HostIOFaults()
        var statements = 0
        replayFaults.beforeSQL = { _ in statements += 1 }
        let second = host(replayFaults)
        do {
            _ = try await second.start()
            XCTFail("Expected missing frozen snapshot refusal")
        } catch { XCTAssertTrue(error.localizedDescription.contains("missing its frozen snapshot")) }
        XCTAssertEqual(statements, 0)
        XCTAssertEqual(try task(id)["rev"] as? Int, before["rev"] as? Int)
        XCTAssertEqual(try task(id)["title"] as? String, "Before edit")
        XCTAssertEqual(try Data(contentsOf: journal), pending)
        await second.close()
    }

    func testSuccessfulTerminalWithoutSnapshotCompletesColdJournalCleanup() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        try await first.checkpointEditorDraft(EditorDraftSnapshot(sessionID: session, taskID: id,
            generation: 1, payloadJSON: "{}"))
        let beforeRev = try XCTUnwrap(task(id)["rev"] as? Int)
        faults.journalRemove = { throw HostFailure("Injected final journal cleanup failure") }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected final journal cleanup failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("final journal cleanup failure")) }
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        XCTAssertNotNil(try object(String(contentsOf: journal))["terminal"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        await first.close()

        let replayFaults = HostIOFaults()
        var taskWrites = 0
        replayFaults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#,
                         options: .regularExpression) != nil { taskWrites += 1 }
        }
        let second = host(replayFaults)
        _ = try await second.start()
        XCTAssertEqual(taskWrites, 0)
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let restored = try await second.readEditorDraft()
        XCTAssertNil(restored)
        await second.close()
    }

    func testCorruptSnapshotCannotBeDiscardedBesideNonterminalEditorJournal() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        try await first.checkpointEditorDraft(EditorDraftSnapshot(sessionID: session, taskID: id,
            generation: 1, payloadJSON: "{}"))
        let before = try task(id)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pre-commit failure") } }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected pre-commit failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("pre-commit failure")) }
        let pending = try Data(contentsOf: journal)
        XCTAssertNil(try object(String(decoding: pending, as: UTF8.self))["terminal"])
        await first.close()

        let corrupt = Data(#"{"snapshot":{"version":99}}"#.utf8)
        try corrupt.write(to: snapshotFile)
        let second = host()
        do {
            _ = try await second.start()
            XCTFail("Expected unreadable frozen snapshot")
        } catch { XCTAssertTrue(error is EditorDraftStoreError) }
        do {
            try await second.discardCorruptEditorDraft()
            XCTFail("Expected pending editor journal to block discard")
        } catch { XCTAssertTrue(error.localizedDescription.contains("requires its frozen snapshot")) }
        XCTAssertEqual(try Data(contentsOf: snapshotFile), corrupt)
        XCTAssertEqual(try Data(contentsOf: journal), pending)
        XCTAssertEqual(try task(id)["rev"] as? Int, before["rev"] as? Int)
        await second.close()
    }

    func testCorruptSnapshotMayBeDiscardedAfterDurableTerminalSuccess() async throws {
        let faults = HostIOFaults()
        let first = host(faults)
        _ = try await first.start()
        let id = UUID().uuidString.lowercased()
        let opening = try await seed(first, id: id)
        let session = UUID().uuidString.lowercased()
        try await first.checkpointEditorDraft(EditorDraftSnapshot(sessionID: session, taskID: id,
            generation: 1, payloadJSON: "{}"))
        let beforeRev = try XCTUnwrap(task(id)["rev"] as? Int)
        faults.editorDraftRemove = { throw HostFailure("Injected draft removal failure") }
        do {
            _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: titleSave(id, opening: opening),
                                               expectedSession: session, expectedGeneration: 1)
            XCTFail("Expected snapshot removal failure")
        } catch { XCTAssertTrue(error.localizedDescription.contains("draft removal failure")) }
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        XCTAssertNotNil(try object(String(contentsOf: journal))["terminal"])
        await first.close()

        try Data(#"{"snapshot":{"version":99}}"#.utf8).write(to: snapshotFile)
        let second = host()
        do {
            _ = try await second.start()
            XCTFail("Expected unreadable snapshot before cleanup")
        } catch { XCTAssertTrue(error is EditorDraftStoreError) }
        try await second.discardCorruptEditorDraft()
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotFile.path))
        _ = try await second.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try task(id)["rev"] as? Int, beforeRev + 1)
        let restored = try await second.readEditorDraft()
        XCTAssertNil(restored)
        await second.close()
    }
}
