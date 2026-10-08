import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Bundled JSC ordinary editor policy + actual SQLite + native descriptor jobs.
final class AttachmentOwnedSaveHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "ordinary-owned-save-task"
    private let at = "2026-10-05T12:00:00.000Z"
    private let title = "Edited title / 文"
    private let notes = "New notes\nExact é / 文"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js")
        }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task239-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func task() throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }
    // Canonicalize SQLite row-object key order only. Embedded JSON columns
    // remain opaque strings so metadata/attachment serialization stays exact.
    private func saved() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func unrelated() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='unrelated'").utf8))) }
    private func record() throws -> NativeAttachmentDraftStore.Record { try XCTUnwrap(store.read()) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func seed(_ faults: HostIOFaults = HostIOFaults(), note: String? = nil, adds: Int = 1) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        for id in [taskID, "unrelated"] {
            _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,?,'inbox','[]','[]','[]',?,?,1,'fixture')",
                        [id, "Saved title", "Saved notes", at, at])
        }
        let host = core(faults); _ = try await host.start()
        // Same full ordinary producer shape used by Task237. No native field policy.
        let editedNotes = note ?? notes
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task",
            "touchedBase": ["title": "Saved title", "description": "Saved notes"],
            "edited": ["title": title, "description": editedNotes],
            "raw": ["title": title, "note": editedNotes, "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:],
                "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "",
                "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [],
                "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true,
            "attachmentsBase": [], "attachments": [], "linkSheet": [:]] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        _ = try await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: 1)
        let source = cache.appendingPathComponent("borrowed.txt")
        try Data("Borrowed source sentinel / 文".utf8).write(to: source)
        for _ in 0..<adds {
            let before = try latest()
            let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
                "generation": before.generation, "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
            _ = try await host.addAttachmentDraft(requestJSON: request)
        }
        return host
    }
    private func request(_ snapshot: EditorDraftSnapshot? = nil) throws -> String {
        let payload = try object((snapshot ?? latest()).payloadJSON)
        return try json(["id": taskID, "base": payload["touchedBase"]!, "patch": payload["edited"]!,
            "scheduleBase": ["startTime": NSNull(), "dueDate": NSNull(), "relativeStartOffset": NSNull(), "reviewAt": NSNull()],
            "attachments": ["base": payload["attachmentsBase"]!, "value": payload["attachments"]!]] as [String: Any])
    }
    private func save(_ host: CoreHost, request raw: String? = nil) async throws -> String {
        let snapshot = try latest()
        return try await host.saveAttachmentDraftAdds(saveRequestJSON: raw ?? request(snapshot),
            expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
    }
    private func boundary(_ point: AttachmentDraftBoundary, on host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == point { if let action { try action() } else { throw HostFailure("Private.txt injected") } } }
        await host.configureAttachmentDraftHost(hooks)
    }
    private func failure(_ work: () async throws -> Void, confirmed: Bool? = nil,
                         file: StaticString = #filePath, line: UInt = #line) async -> CoreHostAttachmentCleanupPending? {
        do { try await work(); XCTFail("Expected retained ownership", file: file, line: line); return nil }
        catch {
            if let confirmed { XCTAssertEqual(error is CoreHostAttachmentCleanupPending, confirmed, file: file, line: line) }
            XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            if let known = error as? CoreHostAttachmentCleanupPending {
                XCTAssertEqual(known.errorDescription, "Task saved. Attachment cleanup needs Retry.", file: file, line: line)
            }
            return error as? CoreHostAttachmentCleanupPending
        }
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), sub = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub; return previous
    }
    private func files() throws -> [URL: Data] {
        var result = [cache.appendingPathComponent("borrowed.txt"): try Data(contentsOf: cache.appendingPathComponent("borrowed.txt"))]
        for operation in try record().operations {
            let target = try XCTUnwrap(URL(string: operation.targetURI)); result[target] = try Data(contentsOf: target)
        }
        return result
    }
    private func sameFiles(_ expected: [URL: Data], file: StaticString = #filePath, line: UInt = #line) throws {
        for (url, bytes) in expected { XCTAssertEqual(try Data(contentsOf: url), bytes, file: file, line: line) }
    }
    private func released(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertNil(try editor.read(), file: file, line: line); XCTAssertNil(try store.read(), file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }
    private func journalObject() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)) }
    // Replay deliberately re-persists the pending command. JSONEncoder may
    // reorder outer keys; argumentsJSON and attempt arguments remain exact.
    private func journalEvidence() throws -> Data { Data(try json(journalObject()).utf8) }
    private func wrapper(_ command: [String: Any]) throws -> [String: Any] {
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(args.first))
    }
    private func writeJournal(_ command: [String: Any]) throws { try Data(json(command).utf8).write(to: journal) }
    private func setWrapper(_ value: [String: Any], in command: inout [String: Any]) throws {
        command["argumentsJSON"] = try json([json(value)])
    }
    private func noTaskWrites() -> HostIOFaults {
        let faults = HostIOFaults()
        faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) {
                XCTFail("Retained exact Save replay must not write tasks"); throw HostFailure("Unexpected task write")
            }
        }
        return faults
    }

    func testOrdinaryProducerNotesTitleAndNativeAddsSaveThenReleaseAndAllowNextMutation() async throws {
        let host = try await seed(adds: 2), checkpoint = try latest(), retained = try record(), sentinels = try files(), other = try unrelated()
        let expectedAttachments = try json(XCTUnwrap(object(checkpoint.payloadJSON)["attachments"]))
        let result = try object(await save(host))
        XCTAssertEqual(Set(result.keys), Set(["id", "draft"])); XCTAssertEqual(result["id"] as? String, taskID)
        let after = try task(); XCTAssertEqual(after["title"] as? String, title); XCTAssertEqual(after["description"] as? String, notes)
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(after["attachments"] as? String).utf8))), expectedAttachments)
        try released(); try sameFiles(sentinels); XCTAssertEqual(try unrelated(), other)
        for operation in retained.operations {
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(operation.stage?.uri))).deletingLastPathComponent()
            XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        }
        _ = try await host.call("saveDraft", argumentsJSON: json([json(["id": taskID, "base": ["title": title], "patch": ["title": "Next ordinary edit"],
            "scheduleBase": ["startTime": NSNull(), "dueDate": NSNull(), "relativeStartOffset": NSNull(), "reviewAt": NSNull()]] as [String: Any])]))
        XCTAssertEqual(try task()["title"] as? String, "Next ordinary edit")
    }

    func testEveryLegacyEditorAndGenericWriterRemainsSealedWhileOwned() async throws {
        let host = try await seed(), snapshot = try latest(), before = try saved(), sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        for method in ["saveDraft", "checklistSave", "boardAction", "taskDelete", "taskPromote"] {
            _ = await failure { _ = try await host.saveEditorDraft(method, argumentsJSON: "[\"{}\"]", expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
            _ = await failure { _ = try await host.call(method, argumentsJSON: "[\"{}\"]") }
        }
        for method in ["attachmentOwnedSaveCommit", "attachmentOwnedSavePrepare", "attachmentOwnedSaveValidate", "draftCommit"] {
            _ = await failure { _ = try await host.call(method, argumentsJSON: "[\"{}\"]") }
        }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testEverySaveBoundaryColdReplayPreservesMetadataAndNeverRepeatsAppliedWrite() async throws {
        let points: [AttachmentDraftBoundary] = [.afterSaveFreeze, .afterSaveJournal, .beforeSaveCommit, .afterSaveCommit,
            .beforeSaveTerminal, .afterSaveTerminal, .beforeSaveEditorDetach, .afterSaveEditorDetach,
            .beforeSaveStage(0), .afterSaveStage(0), .beforeSaveStage(1), .afterSaveStage(1),
            .beforeSaveRelease, .afterSaveRelease, .beforeSaveJournalClear, .afterSaveJournalClear]
        for point in points {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(adds: 2), sentinels = try files(), checkpoint = try latest(), proofs = try encoded(record().operations), other = try unrelated()
            await boundary(point, on: host)
            let applied = ![AttachmentDraftBoundary.afterSaveFreeze, .afterSaveJournal, .beforeSaveCommit].contains(point)
            let durable = ![AttachmentDraftBoundary.afterSaveFreeze, .afterSaveJournal, .beforeSaveCommit, .afterSaveCommit, .beforeSaveTerminal].contains(point)
            _ = await failure({ _ = try await self.save(host) }, confirmed: durable)
            XCTAssertEqual(try task()["title"] as? String, applied ? title : "Saved title")
            let after = try saved()
            if FileManager.default.fileExists(atPath: store.url.path) { XCTAssertEqual(try encoded(record().operations), proofs) }
            await host.close()
            let cold = core(applied ? noTaskWrites() : HostIOFaults()); _ = try await cold.start()
            if point == .afterSaveFreeze {
                XCTAssertNotNil(try editor.read()?.attempt)
                let thawed = try await cold.readEditorDraft()
                XCTAssertEqual(try encoded(XCTUnwrap(thawed)), try encoded(checkpoint)); XCTAssertNil(try editor.read()?.attempt)
                XCTAssertEqual(try saved(), after); XCTAssertEqual(try encoded(record().operations), proofs)
                _ = try await save(cold)
            }
            try released(); try sameFiles(sentinels); XCTAssertEqual(try unrelated(), other)
            if applied { XCTAssertEqual(try saved(), after) }
            XCTAssertEqual(try task()["title"] as? String, title)
            await cold.close()
        }
    }

    func testPendingAndTerminalJournalWriteFailuresKeepExactWarmOwnership() async throws {
        for terminalFailure in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults), filesBefore = try files()
            var calls = 0
            faults.journalWrite = { calls += 1; if calls == (terminalFailure ? 2 : 1) { throw HostFailure("Journal unavailable") } }
            _ = await failure({ _ = try await self.save(host) }, confirmed: false)
            let attempt = try XCTUnwrap(editor.read()?.attempt), checkpoint = try latest()
            XCTAssertEqual(try task()["title"] as? String, terminalFailure ? title : "Saved title")
            _ = await failure { _ = try await host.readEditorDraft() }
            XCTAssertEqual(try encoded(XCTUnwrap(editor.read()?.attempt)), try encoded(attempt))
            faults.journalWrite = nil
            if terminalFailure { faults.beforeSQL = noTaskWrites().beforeSQL }
            _ = try await host.retryPending()
            try released(); try sameFiles(filesBefore); XCTAssertEqual(try task()["title"] as? String, title)
            XCTAssertEqual(checkpoint.taskID, taskID)
        }
    }

    func testActualSQLiteCommitAckFailureAndLostHostReplyColdReplayUsesExactAfterWithoutNewWrite() async throws {
        let faults = HostIOFaults(), host = try await seed(faults), sentinels = try files()
        var lost = false, hostReplyLost = false
        faults.afterSQL = { if $0 == "COMMIT" && !lost { lost = true; throw HostFailure("COMMIT acknowledgment lost") } }
        // Shared Save can recover the SQL acknowledgement inside this invocation.
        // Lose its eventual host reply separately, after the actual commit.
        await boundary(.afterSaveCommit, on: host) { hostReplyLost = true; throw HostFailure("Host acknowledgment lost") }
        _ = await failure({ _ = try await self.save(host) }, confirmed: false)
        XCTAssertTrue(lost); XCTAssertTrue(hostReplyLost); XCTAssertNil(try journalObject()["terminal"])
        let after = try saved(), attempt = try XCTUnwrap(editor.read()?.attempt), journalBefore = try Data(contentsOf: journal)
        XCTAssertEqual(try task()["title"] as? String, title); XCTAssertEqual(attempt.method, "attachmentDraftSave")
        await host.close(); let cold = core(noTaskWrites()); _ = try await cold.start()
        try released(); XCTAssertEqual(try saved(), after); try sameFiles(sentinels)
        XCTAssertFalse(journalBefore.isEmpty)
    }

    func testUnknownAToBToCRetainsButDurableTerminalThenCCleansWithoutTaskWrite() async throws {
        for terminal in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files()
            await boundary(terminal ? .afterSaveTerminal : .afterSaveCommit, on: host)
            _ = await failure({ _ = try await self.save(host) }, confirmed: terminal)
            let sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), decision = try journalEvidence()
            await host.close()
            _ = try sql("UPDATE tasks SET title='Intervening C',rev=rev+1,updatedAt=? WHERE id=?", [at, taskID])
            let c = try saved(), cold = core(noTaskWrites())
            if terminal { _ = try await cold.start(); try released() }
            else {
                _ = await failure({ _ = try await cold.start() }, confirmed: false)
                XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
                XCTAssertEqual(try journalEvidence(), decision)
            }
            XCTAssertEqual(try saved(), c); try sameFiles(sentinels); await cold.close()
        }
    }

    func testFirstDefiniteRejectionThawsAndPreservesAllFilesWhileReplayRejectionStaysUnknown() async throws {
        for first in [true, false] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), checkpoint = try latest(), sidecar = try Data(contentsOf: store.url), sentinels = try files()
            if first {
                await boundary(.beforeSaveCommit, on: host) { _ = try self.sql("UPDATE tasks SET title='External revision',rev=rev+1 WHERE id=?", [self.taskID]) }
                do { _ = try await save(host); XCTFail("Expected first invocation STALE_REVISION") }
                catch let error as CoreHostRejection { XCTAssertTrue(error.message.hasPrefix("STALE_REVISION:")) }
                XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
                XCTAssertEqual(try encoded(latest()), try encoded(checkpoint)); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            } else {
                await boundary(.afterSaveJournal, on: host); _ = await failure { _ = try await self.save(host) }
                let journalBefore = try journalEvidence(), frozen = try Data(contentsOf: editor.url)
                await host.close(); _ = try sql("UPDATE tasks SET title='External revision',rev=rev+1 WHERE id=?", [taskID])
                let cold = core(); _ = await failure { _ = try await cold.start() }
                XCTAssertEqual(try journalEvidence(), journalBefore); XCTAssertEqual(try Data(contentsOf: editor.url), frozen)
                XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertNil(try journalObject()["terminal"])
                await cold.close()
            }
            try sameFiles(sentinels); await host.close()
        }
    }

    func testRejectedTerminalThawAndClearFaultsColdRetryOnlyExactThaw() async throws {
        for point in [AttachmentDraftBoundary.beforeSaveThaw, .afterSaveThaw, .beforeSaveJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), snapshot = try latest(), sidecar = try Data(contentsOf: store.url), sentinels = try files()
            let hooks = AttachmentDraftHostHooks()
            hooks.boundary = { boundary in
                if boundary == .beforeSaveCommit { _ = try self.sql("UPDATE tasks SET title='External revision',rev=rev+1 WHERE id=?", [self.taskID]) }
                if boundary == point { throw HostFailure("Stop rejected cleanup") }
            }
            await host.configureAttachmentDraftHost(hooks)
            _ = await failure({ _ = try await self.save(host) }, confirmed: false)
            XCTAssertNotNil(try journalObject()["terminal"]); let before = try saved()
            await host.close(); let cold = core(noTaskWrites()); _ = try await cold.start()
            XCTAssertEqual(try saved(), before); XCTAssertNil(try editor.read()?.attempt)
            XCTAssertEqual(try encoded(latest()), try encoded(snapshot)); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try sameFiles(sentinels)
            await cold.close()
        }
    }

    func testNoJournalFrozenOwnedAttemptOnlyExactReconciliationAndNeverCommits() async throws {
        for mode in ["exact", "missing-sidecar", "changed-editor", "corrupt-journal", "changed-request"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), before = try saved(), sentinels = try files()
            await boundary(.afterSaveFreeze, on: host); _ = await failure { _ = try await self.save(host) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await host.close()
            if mode == "missing-sidecar" { try FileManager.default.removeItem(at: store.url) }
            if mode == "corrupt-journal" { try Data("broken".utf8).write(to: journal) }
            if mode == "changed-editor" || mode == "changed-request" {
                var disk = try object(String(decoding: Data(contentsOf: editor.url), as: UTF8.self))
                if mode == "changed-editor" {
                    var snapshot = try XCTUnwrap(disk["snapshot"] as? [String: Any]); snapshot["payloadJSON"] = " " + (try XCTUnwrap(snapshot["payloadJSON"] as? String)); disk["snapshot"] = snapshot
                } else {
                    var attempt = try XCTUnwrap(disk["attempt"] as? [String: Any]); attempt["argumentsJSON"] = "[\"{}\"]"; disk["attempt"] = attempt
                }
                try Data(json(disk).utf8).write(to: editor.url)
            }
            let frozen = try Data(contentsOf: editor.url), cold = core(noTaskWrites())
            if mode == "corrupt-journal" { _ = await failure { _ = try await cold.start() } }
            else {
                _ = try await cold.start()
                if mode == "exact" { _ = try await cold.readEditorDraft(); XCTAssertNil(try editor.read()?.attempt) }
                else { _ = await failure { _ = try await cold.readEditorDraft() }; XCTAssertEqual(try Data(contentsOf: editor.url), frozen) }
            }
            XCTAssertEqual(try saved(), before); try sameFiles(sentinels); await cold.close()
        }
    }

    func testChangedJournalAfterBoundaryCannotInvokeOrOverwriteDecision() async throws {
        let host = try await seed(), before = try saved(), sentinels = try files()
        await boundary(.beforeSaveCommit, on: host) {
            var command = try self.journalObject(), wrapper = try self.wrapper(command)
            wrapper["recordSHA256"] = String(repeating: "a", count: 64)
            try self.setWrapper(wrapper, in: &command); try self.writeJournal(command)
        }
        _ = await failure({ _ = try await self.save(host) }, confirmed: false)
        let altered = try Data(contentsOf: journal)
        _ = await failure { _ = try await host.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), altered); XCTAssertEqual(try saved(), before); try sameFiles(sentinels)
    }

    func testStrictColdOwnedJournalHashEnvelopeAttemptCheckpointAndNativeProofTamperingRefusesBeforeSQLite() async throws {
        for mode in ["wrapper", "hash", "checkpoint", "effect", "original-request", "attempt", "editor", "source-proof", "published-proof", "oversize", "terminal-reply"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files()
            await boundary(mode == "terminal-reply" ? .afterSaveTerminal : .afterSaveJournal, on: host)
            _ = await failure { _ = try await self.save(host) }; await host.close()
            var command = try journalObject(), wrap = try wrapper(command)
            switch mode {
            case "wrapper": wrap["unexpected"] = 1
            case "hash": wrap["recordSHA256"] = String(repeating: "f", count: 64)
            case "checkpoint", "effect":
                var envelope = try XCTUnwrap(wrap["envelope"] as? [String: Any])
                if mode == "checkpoint" {
                    var request = try XCTUnwrap(envelope["request"] as? [String: Any]), checkpoint = try XCTUnwrap(request["checkpoint"] as? [String: Any])
                    checkpoint["payloadJSON"] = " " + (try XCTUnwrap(checkpoint["payloadJSON"] as? String)); request["checkpoint"] = checkpoint; envelope["request"] = request
                } else {
                    var prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), effect = try XCTUnwrap(prepared["effect"] as? [String: Any])
                    effect["unexpected"] = "tampered"; prepared["effect"] = effect; envelope["prepared"] = prepared
                }
                wrap["envelope"] = envelope
            case "original-request", "attempt":
                var attempt = try XCTUnwrap(command["editorDraft"] as? [String: Any])
                attempt[mode == "attempt" ? "id" : "argumentsJSON"] = mode == "attempt" ? UUID().uuidString.lowercased() : "[\"{}\"]"
                command["editorDraft"] = attempt
            case "editor":
                var disk = try object(String(decoding: Data(contentsOf: editor.url), as: UTF8.self)), snapshot = try XCTUnwrap(disk["snapshot"] as? [String: Any])
                snapshot["generation"] = (try XCTUnwrap(snapshot["generation"] as? Int)) + 1; disk["snapshot"] = snapshot
                try Data(json(disk).utf8).write(to: editor.url)
            case "source-proof", "published-proof":
                var disk = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self)), operations = try XCTUnwrap(disk["operations"] as? [[String: Any]])
                let field = mode == "source-proof" ? "source" : "published"
                var proof = try XCTUnwrap(operations[0][field] as? [String: Any]); proof["identity"] = "different-proof"
                operations[0][field] = proof; disk["operations"] = operations; try Data(json(disk).utf8).write(to: store.url)
            case "terminal-reply": command["terminal"] = ["success": ["_0": "{\"id\":\"wrong\",\"draft\":{}}"]]
            default: break
            }
            try setWrapper(wrap, in: &command); try writeJournal(command)
            if mode == "oversize" {
                let data = try Data(contentsOf: journal); try (data + Data(repeating: 32, count: 8 * 1024 * 1024)).write(to: journal)
            }
            let journalBefore = try Data(contentsOf: journal), editorBefore = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url), before = try saved()
            let faults = HostIOFaults(); var sqlCalls = 0; faults.beforeSQL = { _ in sqlCalls += 1 }
            let cold = core(faults); _ = await failure { _ = try await cold.start() }
            XCTAssertEqual(sqlCalls, 0); XCTAssertEqual(try saved(), before)
            XCTAssertEqual(try Data(contentsOf: journal), journalBefore); XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar); try sameFiles(sentinels); await cold.close()
        }
    }

    func testRawPendingUnknownRequestAndStaleGenerationRefuseBeforeFreeze() async throws {
        let host = try await seed(), original = try latest(), sidecar = try Data(contentsOf: store.url), before = try saved(), sentinels = try files()
        let baseRequest = try object(request())
        var variants: [[String: Any]] = []
        var unknown = baseRequest; unknown["unrecognized"] = true; variants.append(unknown)
        var partial = baseRequest; partial["patch"] = ["title": title]; variants.append(partial)
        var wrongBase = baseRequest; wrongBase["base"] = ["title": "Different", "description": "Saved notes"]; variants.append(wrongBase)
        var missingAdd = baseRequest; missingAdd["attachments"] = ["base": [], "value": []]; variants.append(missingAdd)
        for value in variants {
            _ = await failure { _ = try await self.save(host, request: self.json(value)) }
            XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        _ = await failure { _ = try await host.saveAttachmentDraftAdds(saveRequestJSON: self.request(), expectedSession: original.sessionID, expectedGeneration: original.generation + 1) }
        for mode in ["unknown", "pending-token", "checklist", "lifecycle"] {
            var value = try object(original.payloadJSON)
            if mode == "unknown" { value["unknownEditorField"] = "retain" }
            else if mode == "lifecycle" { value["lifecycle"] = ["action": "delete"] }
            else {
                var raw = try XCTUnwrap(value["raw"] as? [String: Any])
                raw[mode == "checklist" ? "checklistAppend" : "tokens"] = mode == "checklist" ? "Uncommitted checklist" : ["tags": "#pending"]
                value["raw"] = raw
            }
            let next = EditorDraftSnapshot(sessionID: original.sessionID, taskID: taskID, generation: try latest().generation + 1, payloadJSON: try json(value))
            try await host.checkpointEditorDraft(next)
            let checkpoint = try Data(contentsOf: editor.url), retained = try Data(contentsOf: store.url)
            _ = await failure { _ = try await self.save(host) }
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), retained)
            XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        XCTAssertEqual(try saved(), before); try sameFiles(sentinels); XCTAssertFalse(sidecar.isEmpty)
    }

    func testEscapedFullSaveCapacityRefusesBeforeFreezeAndRetainsCheckpointAndFiles() async throws {
        let host = try await seed(note: String(repeating: "\"\u{0000}", count: 40_000)), snapshot = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url), before = try saved(), sentinels = try files()
        var froze = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .afterSaveFreeze { froze = true } }
        await host.configureAttachmentDraftHost(hooks)
        _ = await failure({ _ = try await self.save(host) }, confirmed: false)
        XCTAssertFalse(froze); XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try Data(contentsOf: editor.url), snapshot); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertEqual(try saved(), before); try sameFiles(sentinels)
    }

    func testPublicationReplacementBeforeInvocationRetainsUnknownAndNeverAdoptsEqualBytes() async throws {
        let host = try await seed(), sentinels = try files(), target = try XCTUnwrap(URL(string: record().operations[0].targetURI)), before = try saved()
        await boundary(.beforeSaveCommit, on: host) {
            let bytes = try Data(contentsOf: target); try FileManager.default.removeItem(at: target); try bytes.write(to: target)
        }
        _ = await failure({ _ = try await self.save(host) }, confirmed: false)
        XCTAssertEqual(try saved(), before); XCTAssertNil(try journalObject()["terminal"])
        let evidence = try journalEvidence(); await host.close()
        let cold = core(); _ = await failure { _ = try await cold.start() }
        XCTAssertEqual(try journalEvidence(), evidence); XCTAssertNotNil(try editor.read()?.attempt); XCTAssertNotNil(try store.read())
        try sameFiles(sentinels)
    }

    func testReplacedStageRootAndUnavailableTypedCapabilityKeepConfirmedCleanupTerminal() async throws {
        for mode in ["stage", "root", "capability"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files(), retained = try record()
            await boundary(.afterSaveTerminal, on: host)
            let firstFailure = await failure({ _ = try await self.save(host) }, confirmed: true)
            let known = try XCTUnwrap(firstFailure), after = try saved()
            await host.close()
            if mode == "stage" {
                let stage = try XCTUnwrap(URL(string: XCTUnwrap(retained.operations[0].stage?.uri))).deletingLastPathComponent()
                // Publication already removed the recorded namespace. A new
                // same-name directory is foreign, never an owned retry stage.
                XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
                try FileManager.default.createDirectory(at: stage, withIntermediateDirectories: false)
                try Data("replacement sentinel".utf8).write(to: stage.appendingPathComponent("sentinel"))
            } else if mode == "root" {
                try FileManager.default.moveItem(at: managed, to: managed.appendingPathExtension("retained"))
                try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)
            }
            let cold = core(noTaskWrites())
            if mode == "capability" {
                let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in throw NativeAttachmentFileJobsError.unavailable } }
                try await cold.configureAttachmentHost(hooks)
            }
            let retryFailure = await failure({ _ = try await cold.start() }, confirmed: true)
            let retried = try XCTUnwrap(retryFailure)
            XCTAssertEqual(Data(retried.resultJSON.utf8), Data(known.resultJSON.utf8)); XCTAssertEqual(try saved(), after)
            XCTAssertNotNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.read())
            if mode != "root" { try sameFiles(sentinels) }
            else {
                XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("borrowed.txt")), sentinels[cache.appendingPathComponent("borrowed.txt")])
                for operation in retained.operations {
                    let name = try XCTUnwrap(URL(string: operation.targetURI)).lastPathComponent
                    XCTAssertEqual(try Data(contentsOf: managed.appendingPathExtension("retained").appendingPathComponent(name)), sentinels[try XCTUnwrap(URL(string: operation.targetURI))])
                }
            }
            await cold.close()
        }
    }

    func testAbsentSidecarDurableSuccessRunsNoFileJobsAndOnlyDetachesExactEditor() async throws {
        let host = try await seed(), sentinels = try files()
        await boundary(.afterSaveTerminal, on: host); _ = await failure({ _ = try await self.save(host) }, confirmed: true)
        let before = try saved(); await host.close(); try FileManager.default.removeItem(at: store.url)
        let cold = core(noTaskWrites()), hooks = NativeAttachmentHostHooks(); var jobs = 0
        hooks.configureJobs = { worker in worker.beforeWork = { _, _ in jobs += 1; throw HostFailure("Absent sidecar grants no file job") } }
        try await cold.configureAttachmentHost(hooks); _ = try await cold.start()
        XCTAssertEqual(jobs, 0); try released(); XCTAssertEqual(try saved(), before); try sameFiles(sentinels)
    }

    func testNewEditorOrSidecarAfterCleanupHookRefusesBeforeFurtherDestruction() async throws {
        for point in [AttachmentDraftBoundary.beforeSaveStage(0), .beforeSaveRelease, .beforeSaveJournalClear, .afterSaveJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files()
            await boundary(point, on: host) {
                let replacement = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "new-editor", generation: 1, payloadJSON: "{\"raw\":{\"title\":\"new\"}}")
                try self.editor.checkpoint(replacement)
            }
            _ = await failure({ _ = try await self.save(host) }, confirmed: true)
            let editorBefore = try Data(contentsOf: editor.url), before = try saved()
            if point == .afterSaveJournalClear {
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
                _ = await failure { _ = try await host.retryPending() }
            }
            let journalBefore = try Data(contentsOf: journal)
            await host.close(); let cold = core(noTaskWrites()); _ = await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore); XCTAssertEqual(try Data(contentsOf: journal), journalBefore)
            XCTAssertEqual(try saved(), before); try sameFiles(sentinels); await cold.close()
        }
    }

    func testSaveDiagnosticOnlyAfterFullReleaseAndItsFailureCannotInvalidateAcknowledgement() async throws {
        let host = try await seed(), log = root.appendingPathComponent("logs/mindwtr.log")
        await boundary(.beforeSaveJournalClear, on: host)
        _ = await failure({ _ = try await self.save(host) }, confirmed: true)
        let before = try String(contentsOf: log)
        XCTAssertFalse(before.contains("\"operation\":\"save\""))
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        _ = try await host.retryPending(); try released()
        let after = try String(contentsOf: log)
        XCTAssertTrue(after.contains("\"operation\":\"save\"")); XCTAssertTrue(after.contains("v1.3.5/ios-attachment-owned-save"))
        XCTAssertFalse(after.contains("Private.txt")); XCTAssertFalse(after.contains("file:///"))
        await host.close()
        let previous = try isolate(); defer { root = previous }
        let next = try await seed(), directory = root.appendingPathComponent("logs")
        try FileManager.default.removeItem(at: directory); try Data("log unavailable".utf8).write(to: directory)
        _ = try await save(next); try released(); XCTAssertEqual(try task()["title"] as? String, title)
    }

    func testReadOnlyArchivedProjectAndUnsettledDomainJournalRefuseBeforeFreeze() async throws {
        for mode in ["read-only", "journal"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files()
            let snapshot = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url)
            var current = host
            if mode == "read-only" {
                await host.close()
                _ = try sql("INSERT INTO projects(id,title,status,color,createdAt,updatedAt) VALUES ('archived-owner','Archived','archived','#000000',?,?)", [at, at])
                _ = try sql("UPDATE tasks SET projectId='archived-owner' WHERE id=?", [taskID])
                current = core(); _ = try await current.start()
            } else {
                // Even a new disk-only command cannot be overwritten or thawed.
                try Data("unsettled domain journal".utf8).write(to: journal)
            }
            let before = try saved()
            _ = await failure({ _ = try await self.save(current) }, confirmed: false)
            XCTAssertNil(try editor.read()?.attempt); XCTAssertEqual(try Data(contentsOf: editor.url), snapshot)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try saved(), before); try sameFiles(sentinels)
            if mode == "journal" { XCTAssertEqual(try Data(contentsOf: journal), Data("unsettled domain journal".utf8)) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)) }
            await current.close()
        }
    }

    func testSuccessTerminalPresentChangedSidecarAndEquivalentUnicodeAttemptRetainEvidence() async throws {
        for mode in ["sidecar", "attempt-utf8"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files()
            await boundary(.afterSaveTerminal, on: host); _ = await failure({ _ = try await self.save(host) }, confirmed: true)
            let before = try saved(); await host.close()
            if mode == "sidecar" {
                var disk = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self)), operations = try XCTUnwrap(disk["operations"] as? [[String: Any]])
                var source = try XCTUnwrap(operations[0]["source"] as? [String: Any]); source["parentIdentity"] = "different-parent"
                operations[0]["source"] = source; disk["operations"] = operations; try Data(json(disk).utf8).write(to: store.url)
            } else {
                var command = try journalObject(), attempt = try XCTUnwrap(command["editorDraft"] as? [String: Any])
                let original = try XCTUnwrap(attempt["argumentsJSON"] as? String)
                XCTAssertTrue(original.contains("é")); attempt["argumentsJSON"] = original.replacingOccurrences(of: "é", with: "e\u{0301}")
                command["editorDraft"] = attempt; try writeJournal(command)
            }
            let decision = try Data(contentsOf: journal), checkpoint = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url)
            let cold = core(noTaskWrites()); _ = await failure { _ = try await cold.start() }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try Data(contentsOf: journal), decision)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            try sameFiles(sentinels); await cold.close()
        }
    }

    func testMissingManagedRootKeepsConfirmedCleanupAndNeverRecreatesOrWritesTasks() async throws {
        let host = try await seed(), sentinels = try files(), retained = try record()
        await boundary(.afterSaveTerminal, on: host)
        let first = await failure({ _ = try await self.save(host) }, confirmed: true)
        let known = try XCTUnwrap(first), after = try saved(), sidecar = try Data(contentsOf: store.url)
        await host.close()
        let retainedRoot = managed.appendingPathExtension("retained")
        try FileManager.default.moveItem(at: managed, to: retainedRoot)
        let cold = core(noTaskWrites())
        let failed = await failure({ _ = try await cold.start() }, confirmed: true)
        let retry = try XCTUnwrap(failed)
        XCTAssertEqual(Data(retry.resultJSON.utf8), Data(known.resultJSON.utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        XCTAssertEqual(try saved(), after); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertNotNil(try journalObject()["terminal"])
        XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("borrowed.txt")), sentinels[cache.appendingPathComponent("borrowed.txt")])
        for operation in retained.operations {
            let target = try XCTUnwrap(URL(string: operation.targetURI))
            XCTAssertEqual(try Data(contentsOf: retainedRoot.appendingPathComponent(target.lastPathComponent)), sentinels[target])
        }
        await cold.close()
        // Restoring the same recorded root inode permits exact terminal cleanup.
        try FileManager.default.moveItem(at: retainedRoot, to: managed)
        let restored = core(noTaskWrites()); _ = try await restored.start()
        try released(); XCTAssertEqual(try saved(), after); try sameFiles(sentinels)
    }

    func testChangedValidSidecarAfterCleanupHooksRetainsEveryForeignRecordAndSavedTask() async throws {
        for point in [AttachmentDraftBoundary.beforeSaveStage(0), .beforeSaveRelease, .beforeSaveJournalClear, .afterSaveJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), sentinels = try files(), original = try record()
            var replacement = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self))
            var operations = try XCTUnwrap(replacement["operations"] as? [[String: Any]])
            var source = try XCTUnwrap(operations[0]["source"] as? [String: Any])
            let originalParent = try XCTUnwrap(source["parentIdentity"] as? String)
            source["parentIdentity"] = originalParent == "0:0" ? "0:1" : "0:0"
            operations[0]["source"] = source; replacement["operations"] = operations
            let changed = Data(try json(replacement).utf8)
            await boundary(point, on: host) { try changed.write(to: self.store.url) }
            _ = await failure({ _ = try await self.save(host) }, confirmed: true)
            XCTAssertNotEqual(try NativeAttachmentDraftStore.ownedSaveFingerprint(record()), try NativeAttachmentDraftStore.ownedSaveFingerprint(original))
            XCTAssertEqual(try Data(contentsOf: store.url), changed)
            let after = try saved()
            if point == .afterSaveJournalClear {
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
                _ = await failure { _ = try await host.retryPending() }
            }
            let decision = try Data(contentsOf: journal)
            await host.close(); let cold = core(noTaskWrites())
            _ = await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: store.url), changed); XCTAssertEqual(try Data(contentsOf: journal), decision)
            XCTAssertEqual(try saved(), after); try sameFiles(sentinels); await cold.close()
        }
    }

    func testNonregularOwnedJournalMutationGuardRefusesWithoutBlockingOrChangingForeignBytes() async throws {
        for mode in ["symlink", "hardlink", "fifo"] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults), sentinels = try files()
            let foreign = root.appendingPathComponent("foreign-" + mode), retainedJournal = journal.appendingPathExtension("retained")
            let foreignBytes = Data("Foreign regular file sentinel".utf8)
            try foreignBytes.write(to: foreign)
            var protectedEditor = Data(), protectedSidecar = Data()
            await boundary(.beforeSaveEditorDetach, on: host) {
                protectedEditor = try Data(contentsOf: self.editor.url)
                protectedSidecar = try Data(contentsOf: self.store.url)
                try FileManager.default.moveItem(at: self.journal, to: retainedJournal)
                if mode == "symlink" { try FileManager.default.createSymbolicLink(at: self.journal, withDestinationURL: foreign) }
                else if mode == "hardlink" { XCTAssertEqual(Darwin.link(foreign.path, self.journal.path), 0) }
                else { XCTAssertEqual(Darwin.mkfifo(self.journal.path, mode_t(0o600)), 0) }
            }
            _ = await failure({ _ = try await self.save(host) }, confirmed: true)
            let after = try saved(), retainedBytes = try Data(contentsOf: retainedJournal)
            XCTAssertEqual(try Data(contentsOf: editor.url), protectedEditor); XCTAssertEqual(try Data(contentsOf: store.url), protectedSidecar)
            XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); try sameFiles(sentinels)
            _ = await failure { _ = try await host.retryPending() }
            XCTAssertEqual(try saved(), after); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes)
            XCTAssertEqual(try Data(contentsOf: retainedJournal), retainedBytes)
            XCTAssertEqual(try Data(contentsOf: editor.url), protectedEditor); XCTAssertEqual(try Data(contentsOf: store.url), protectedSidecar)
            // Deliberately do not cold-open the FIFO: the unchanged legacy startup
            // reader is outside this owned-only nonblocking mutation guard.
            await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
            try FileManager.default.removeItem(at: journal)
            try FileManager.default.moveItem(at: retainedJournal, to: journal)
            faults.beforeSQL = noTaskWrites().beforeSQL
            _ = try await host.retryPending(); try released(); XCTAssertEqual(try saved(), after); try sameFiles(sentinels)
            await host.close()
        }
    }
}
