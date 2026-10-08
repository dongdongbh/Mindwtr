import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC, SQLite, retained sidecar and independent ordinary editor.
final class RetainedAttachmentOrdinaryHostTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var bundle: URL!
    private var originalBundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "retained-ordinary-task"
    private let at = "2026-10-05T12:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task272/\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func literal(_ value: String) throws -> String { String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func task(_ id: String? = nil) throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id = ?", [id ?? taskID]).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func mixed() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func retainedCheckpoint() throws -> EditorDraftSnapshot {
        switch try XCTUnwrap(store.readVersioned()).record {
        case .legacy(let value): return value.session.checkpoint
        case .mixed(let value): return value.session.checkpoint
        case .availability(let value): return value.session.checkpoint
        }
    }
    private func operation() throws -> Store.Operation {
        switch try XCTUnwrap(store.readVersioned()).record {
        case .legacy(let value): return try XCTUnwrap(value.operations.first)
        case .mixed(let value):
            guard case .add(let op) = try XCTUnwrap(value.operations.first) else { throw HostFailure("Fixture Add missing") }
            return op
        case .availability: throw HostFailure("Historical fixture Add required")
        }
    }
    private func source() -> URL { cache.appendingPathComponent("borrowed.txt") }
    private func baseline() -> URL { managed.appendingPathComponent("baseline.txt") }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func evidence(includeStage: Bool = true) throws -> [(URL, Data, String)] {
        let operation = try operation()
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(operation.stage?.uri)))
        let target = try XCTUnwrap(URL(string: operation.targetURI))
        let paths = [store.url, source(), baseline(), target] + (includeStage ? [stage] : [])
        return try paths.map { ($0, try Data(contentsOf: $0), try inode($0)) }
    }
    private func preserved(_ values: [(URL, Data, String)], file: StaticString = #filePath, line: UInt = #line) throws {
        for (url, bytes, identity) in values {
            XCTAssertEqual(try Data(contentsOf: url), bytes, file: file, line: line)
            XCTAssertEqual(try inode(url), identity, file: file, line: line)
        }
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected retained ownership refusal", file: file, line: line) }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
        }
    }
    private func seed(_ faults: HostIOFaults = HostIOFaults(), detach: Bool = true, version: Int = 3, published: Bool = false) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try Data("Baseline sentinel / 文".utf8).write(to: baseline())
        try Data("Borrowed sentinel / 文".utf8).write(to: source())
        let attachments: [[String: Any]] = [["id": "baseline", "kind": "file", "title": "Baseline", "uri": baseline().absoluteString,
            "createdAt": at, "updatedAt": at, "localStatus": "available"]]
        _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,checklist,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','inbox','[]','[]',?,'[]',?,?,1,'fixture')",
            [taskID, "Saved title", json(attachments), at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,createdAt,updatedAt,rev,revBy) VALUES ('ordinary-project','Before project','active','#94a3b8','Before notes',?,?,1,'fixture')", [at, at])
        _ = try sql("INSERT INTO areas(id,name,color,orderNum,createdAt,updatedAt,rev,revBy) VALUES ('ordinary-area','Before area','#94a3b8',0,?,?,1,'fixture')", [at, at])
        let host = core(faults); _ = try await host.start()
        let payload = try json(["version": 2, "taskID": taskID, "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "raw": ["title": "Uncommitted owned title"]] as [String: Any])
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(checkpoint)
        if version == 1 { _ = try await host.beginAttachmentDraft(expectedSession: checkpoint.sessionID, expectedGeneration: 1) }
        else if version == 2 { _ = try await host.beginAttachmentDraftV2(expectedSession: checkpoint.sessionID, expectedGeneration: 1) }
        else { _ = try await host.beginAttachmentDraftV3(expectedSession: checkpoint.sessionID, expectedGeneration: 1) }
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .afterStageProof { throw HostFailure("Stop retained stage") } }
        if !published { await host.configureAttachmentDraftHost(hooks) }
        let add = {
            let request = try self.json(["version": 1, "requestId": UUID().uuidString.lowercased(),
                "sessionID": checkpoint.sessionID, "generation": checkpoint.generation,
                "picked": ["uri": self.source().absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
            if version == 3 { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            else { _ = try await host.addAttachmentDraft(requestJSON: request) }
        }
        if published { try await add() } else { await refused(add) }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let operation = try operation()
        XCTAssertEqual(operation.phase, published ? .checkpointed : .stagePrepared)
        if !published { try Data("Unproven target sentinel / 文".utf8).write(to: XCTUnwrap(URL(string: operation.targetURI))) }
        if detach {
            let current = try latest()
            let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": current.sessionID, "generation": current.generation])
            let result = version == 3 ? try await host.discardAttachmentDraftV3(requestJSON: request) : try await host.discardAttachmentDraft(requestJSON: request)
            let reply = try object(result)
            XCTAssertEqual(reply["status"] as? String, "cleanupPending"); XCTAssertNil(try editor.read())
            if version == 3 { XCTAssertEqual(try mixed().discard?.phase, .detached); _ = try Store.ownedMixedDiscardFingerprint(mixed()) }
            else { let retained = try XCTUnwrap(store.read()); XCTAssertEqual(retained.discard?.phase, .detached); _ = try Store.ownedDiscardFingerprint(retained) }
        }
        return host
    }
    private func capture(_ host: CoreHost, id: String = UUID().uuidString.lowercased()) async throws -> String {
        let opened = try object(await host.call("captureOpen"))
        return try json([json(["text": "Ordinary capture", "options": XCTUnwrap(opened["options"]), "captureId": id, "openAfterSave": false])])
    }
    private func olderCaptureWithActiveOwner() async throws -> (CoreHost, String, String) {
        let first = try await seed(detach: false, published: true); await first.close()
        let retained = try evidence(includeStage: false) + [(editor.url, try Data(contentsOf: editor.url), try inode(editor.url))]
        let parked = root.appendingPathComponent("owner-before-older-capture.json")
        // Model the already-owed journal arriving alongside a real producer's
        // active record, preserving that record's original bytes and inode.
        try FileManager.default.moveItem(at: store.url, to: parked)
        defer {
            if FileManager.default.fileExists(atPath: parked.path) {
                try? FileManager.default.moveItem(at: parked, to: store.url)
            }
        }
        let faults = HostIOFaults(), writer = core(faults); _ = try await writer.start()
        let id = UUID().uuidString.lowercased(), args = try await capture(writer, id: id), before = try domainRows()
        var commits = 0
        faults.beforeSQL = { if $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "COMMIT" {
            commits += 1; throw HostFailure("Stop older capture COMMIT")
        } }
        await refused { _ = try await writer.call("captureSubmit", argumentsJSON: args) }
        XCTAssertGreaterThan(commits, 0); faults.beforeSQL = nil
        let pending = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(pending["method"] as? String, "captureCommit"); XCTAssertNil(pending["editorDraft"])
        XCTAssertNil(pending["terminal"]); XCTAssertEqual(try domainRows(), before)
        let encoded = try XCTUnwrap(pending["argumentsJSON"] as? String)
        let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [String])
        let envelope = try object(XCTUnwrap(arguments.first)), request = try XCTUnwrap(envelope["request"] as? [String: Any])
        XCTAssertEqual(request["captureId"] as? String, id)
        try FileManager.default.moveItem(at: parked, to: store.url); try preserved(retained)
        let originalArgs = try XCTUnwrap(NativeJSON.jsonObject(with: Data(args.utf8)) as? [String])
        var fresh = try object(XCTUnwrap(originalArgs.first)); fresh["captureId"] = UUID().uuidString.lowercased()
        return (writer, id, try json([json(fresh)]))
    }
    private func newDraft(_ host: CoreHost) async throws -> (EditorDraftSnapshot, [String: Any]) {
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1,
            payloadJSON: #"{"raw":{"title":"Independent ordinary text","checklistAppend":"pending"},"scheduleEdits":[{"id":"pending","field":"dueDate","value":"2036-10-05"}]}"#)
        XCTAssertNotEqual(draft.sessionID, try retainedCheckpoint().sessionID)
        try await host.checkpointEditorDraft(draft); return (draft, opening)
    }
    private func saveArguments(_ opening: [String: Any], title: String = "Ordinary saved title") throws -> String {
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any])
        return try json([json(["id": taskID, "base": ["title": XCTUnwrap(draft["title"])], "patch": ["title": title],
            "scheduleBase": XCTUnwrap(opening["scheduleBase"])])])
    }
    private func isolate() throws -> URL {
        let parent = try XCTUnwrap(root), next = parent.appendingPathComponent(String(UUID().uuidString.prefix(8)), isDirectory: true)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true); root = next; bundle = originalBundle; return parent
    }
    private func replaceExact(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), old = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension(UUID().uuidString))
        try bytes.write(to: url); XCTAssertNotEqual(try inode(url), old)
    }
    private func domainRows() throws -> String {
        var result: [String: Any] = [:]
        for name in ["tasks", "projects", "areas", "settings", "native_request_receipts"] {
            result[name] = try NativeJSON.jsonObject(with: Data(sql("SELECT * FROM " + name + " ORDER BY rowid").utf8))
        }
        return try json(result)
    }
    private func noDomainWrites(_ faults: HostIOFaults, count: @escaping () -> Void) {
        faults.beforeSQL = { statement in
            if statement.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|projects|areas)\b"#, options: .regularExpression) != nil { count() }
        }
    }

    func testOlderCaptureReplaysExactlyWithoutReleasingActiveOwnerOrEditor() async throws {
        let (writer, id, freshArgs) = try await olderCaptureWithActiveOwner()
        let retained = try evidence(includeStage: false) + [(editor.url, try Data(contentsOf: editor.url), try inode(editor.url))]
        let checkpoint = try latest(), pendingBytes = try Data(contentsOf: journal), before = try domainRows()
        await refused { _ = try await writer.call("captureSubmit", argumentsJSON: freshArgs) }
        XCTAssertEqual(try Data(contentsOf: journal), pendingBytes); XCTAssertEqual(try domainRows(), before)
        try preserved(retained); await writer.close()

        let faults = HostIOFaults(), cold = core(faults); var removals = 0
        faults.editorDraftRemove = { removals += 1; throw HostFailure("Older capture must not detach the owned editor") }
        _ = try await cold.start()
        XCTAssertEqual(try task(id)["title"] as? String, "Ordinary capture")
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT id FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 2); XCTAssertEqual(Set(rows.compactMap { $0["id"] as? String }), Set([id, taskID]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(removals, 0)
        XCTAssertEqual(try latest(), checkpoint); XCTAssertNil(try editor.read()?.attempt); try preserved(retained)
        let settled = try domainRows(); var writes = 0
        noDomainWrites(faults) { writes += 1 }
        await refused { _ = try await cold.call("captureSubmit", argumentsJSON: freshArgs) }
        await refused { try await cold.discardEditorDraft(expectedSession: checkpoint.sessionID) }
        let independent = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: "{}")
        await refused { try await cold.checkpointEditorDraft(independent) }
        XCTAssertEqual(writes, 0); XCTAssertEqual(removals, 0); XCTAssertEqual(try domainRows(), settled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained); await cold.close()
        let reopened = core(); _ = try await reopened.start()
        XCTAssertEqual(try task(id)["title"] as? String, "Ordinary capture"); XCTAssertEqual(try domainRows(), settled)
        XCTAssertEqual(try latest(), checkpoint); try preserved(retained)
    }

    func testOlderActiveReplayRejectsSameByteOwnerEditorAndJournalReplacement() async throws {
        for selected in ["owner", "editor", "journal"] {
            let parent = try isolate(); defer { root = parent }
            let (writer, _, _) = try await olderCaptureWithActiveOwner(); await writer.close()
            let target = try XCTUnwrap(URL(string: operation().targetURI))
            let paths = [store.url, editor.url, journal, source(), baseline(), target]
            let retained = try paths.map { ($0, try Data(contentsOf: $0), try inode($0)) }, before = try domainRows()
            let changed = selected == "owner" ? store.url : selected == "editor" ? editor.url : journal
            let faults = HostIOFaults(), cold = core(faults); var replacements = 0, writes = 0, removals = 0
            noDomainWrites(faults) { writes += 1 }
            faults.editorDraftRemove = { removals += 1; throw HostFailure("Older capture must not detach the owned editor") }
            faults.journalWrite = { if replacements == 0 { replacements += 1; try self.replaceExact(changed) } }
            await refused { _ = try await cold.start() }
            XCTAssertEqual(replacements, 1, selected); XCTAssertEqual(writes, 0, selected); XCTAssertEqual(removals, 0, selected)
            XCTAssertEqual(try domainRows(), before, selected)
            for (url, bytes, identity) in retained {
                XCTAssertEqual(try Data(contentsOf: url), bytes, selected)
                if url == changed { XCTAssertNotEqual(try inode(url), identity, selected) }
                else { XCTAssertEqual(try inode(url), identity, selected) }
            }
            await cold.close()
        }
    }

    func testDetachedV3KeepsEvidenceAcrossCaptureAndSameTaskDifferentSessionSave() async throws {
        let host = try await seed(), retained = try evidence(), old = try mixed().session.checkpoint
        let capturedID = UUID().uuidString.lowercased()
        _ = try await host.call("captureSubmit", argumentsJSON: capture(host, id: capturedID))
        XCTAssertEqual(try task(capturedID)["title"] as? String, "Ordinary capture"); try preserved(retained)
        let (draft, opening) = try await newDraft(host)
        XCTAssertNotEqual(draft.sessionID, old.sessionID); try preserved(retained)
        let current = try await host.readEditorDraft(); XCTAssertEqual(current, draft)
        _ = try await host.saveEditorDraft("saveDraft", argumentsJSON: saveArguments(opening),
            expectedSession: draft.sessionID, expectedGeneration: draft.generation)
        XCTAssertEqual(try task()["title"] as? String, "Ordinary saved title")
        XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
    }

    func testColdRetainedRecordResumesOnlyIndependentOrdinaryCheckpoint() async throws {
        let first = try await seed(), retained = try evidence()
        let (draft, _) = try await newDraft(first); await first.close()
        let cold = core(); _ = try await cold.start()
        let restored = try await cold.readEditorDraft(); XCTAssertEqual(restored, draft); try preserved(retained)
        let record = try mixed()
        await refused { _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: record.session.sessionID, requestId: XCTUnwrap(record.discard?.requestId)) }
        XCTAssertEqual(try editor.read()?.snapshot, draft); try preserved(retained)
        try await cold.discardEditorDraft(expectedSession: draft.sessionID)
        XCTAssertNil(try editor.read()); try preserved(retained)
    }

    func testProjectNotesRenameAndAreaRenameAcknowledgeWithoutTouchingRetainedFiles() async throws {
        let host = try await seed(), retained = try evidence()
        for (method, optionsMethod, field, value) in [
            ("projectRenameWrite", "projectRenameOptions", "title", "Ordinary renamed project"),
            ("projectNotesWrite", "projectNotesEditOptions", "text", "Ordinary notes / 文")
        ] {
            let options = try object(await host.call(optionsMethod, argumentsJSON: json([json(["projectId": "ordinary-project"])])))
            let project = try XCTUnwrap(options["project"] as? [String: Any])
            _ = try await host.call(method, argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(),
                "projectId": "ordinary-project", field: value, "expected": project.filter { $0.key != "id" }])]))
            try preserved(retained)
        }
        let options = try object(await host.call("areaOrderOptions")), areas = try XCTUnwrap(options["areas"] as? [[String: Any]])
        _ = try await host.call("areaRename", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(), "areaId": "ordinary-area",
            "name": "Ordinary renamed area", "expected": XCTUnwrap(areas.first { $0["id"] as? String == "ordinary-area" })])]))
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT title,supportNotes FROM projects WHERE id='ordinary-project'").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.first?["title"] as? String, "Ordinary renamed project"); XCTAssertEqual(rows.first?["supportNotes"] as? String, "Ordinary notes / 文")
        XCTAssertTrue(try sql("SELECT name FROM areas WHERE id='ordinary-area'").contains("Ordinary renamed area"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
    }

    func testLegacyV1AndV2DetachedOwnersRemainSealedWhileOrdinarySaveSucceeds() async throws {
        for version in [1, 2] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(version: version), retained = try evidence(), originalVersion = try XCTUnwrap(store.read()).version
            _ = try await host.call("captureSubmit", argumentsJSON: capture(host))
            let (draft, opening) = try await newDraft(host)
            _ = try await host.saveEditorDraft("saveDraft", argumentsJSON: saveArguments(opening), expectedSession: draft.sessionID, expectedGeneration: 1)
            XCTAssertEqual(originalVersion, version); XCTAssertEqual(try store.read()?.version, version)
            XCTAssertEqual(try task()["title"] as? String, "Ordinary saved title"); try preserved(retained); await host.close()
        }
    }

    func testDifferentSessionScheduleAndChecklistSaveUsesExistingPreparedRoute() async throws {
        let host = try await seed(), retained = try evidence(), (snapshot, opening) = try await newDraft(host)
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any])
        let fields = ["startTime", "dueDate", "relativeStartOffset", "reviewAt"]
        let base = Dictionary(uniqueKeysWithValues: fields.map { ($0, draft[$0] ?? NSNull()) })
        var patch = base; patch["dueDate"] = "2036-10-05"
        let checklist: [[String: Any]] = [["id": "ordinary-row", "title": "Ordinary checklist row", "isCompleted": false]]
        let args = try json([json(["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": base, "patch": patch,
            "scheduleBase": XCTUnwrap(opening["scheduleBase"]), "checklist": ["base": [] as [[String: Any]], "value": checklist]])])
        _ = try await host.saveEditorDraft("checklistSave", argumentsJSON: args, expectedSession: snapshot.sessionID, expectedGeneration: 1)
        XCTAssertEqual(try task()["dueDate"] as? String, "2036-10-05")
        let saved = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(task()["checklist"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(saved.first?["title"] as? String, "Ordinary checklist row"); XCTAssertNil(try editor.read()); try preserved(retained)
    }

    func testOrdinaryPreparedNoopKeepsRevisionAndOnlyDetachesNewEditor() async throws {
        let host = try await seed(), retained = try evidence(), (draft, opening) = try await newDraft(host), before = try domainRows()
        _ = try await host.saveEditorDraft("saveDraft", argumentsJSON: saveArguments(opening, title: "Saved title"), expectedSession: draft.sessionID, expectedGeneration: 1)
        XCTAssertEqual(try domainRows(), before); XCTAssertNil(try editor.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
    }

    func testFrozenBeforeJournalColdThawsOnlyExactOrdinaryAttempt() async throws {
        let faults = HostIOFaults(), first = try await seed(faults), retained = try evidence(), (draft, opening) = try await newDraft(first)
        let before = try domainRows()
        faults.journalWrite = { throw HostFailure("Injected before ordinary journal") }
        await refused { _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: self.saveArguments(opening), expectedSession: draft.sessionID, expectedGeneration: 1) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try domainRows(), before)
        XCTAssertNotNil(try editor.read()?.attempt); try preserved(retained); await first.close()
        let cold = core(); _ = try await cold.start()
        let restored = try await cold.readEditorDraft(); XCTAssertEqual(restored, draft); XCTAssertNil(try editor.read()?.attempt)
        XCTAssertEqual(try task()["title"] as? String, "Saved title"); try preserved(retained)
        try await cold.checkpointEditorDraft(.init(sessionID: draft.sessionID, taskID: taskID, generation: 2, payloadJSON: draft.payloadJSON))
        try await cold.discardEditorDraft(expectedSession: draft.sessionID); try preserved(retained)
    }

    func testColdOrdinarySaveSettlesCommitTerminalEditorAndJournalBoundariesExactlyOnce() async throws {
        for mode in ["commit", "terminal", "editor", "journal"] {
            let parent = try isolate(); defer { root = parent }
            let faults = HostIOFaults(), first = try await seed(faults), retained = try evidence(), (draft, opening) = try await newDraft(first)
            let before = try XCTUnwrap(task()["rev"] as? Int)
            switch mode {
            case "commit": faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected ordinary COMMIT") } }
            case "terminal":
                var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected ordinary terminal") } }
            case "editor": faults.editorDraftRemove = { throw HostFailure("Injected ordinary editor removal") }
            default: faults.journalRemove = { throw HostFailure("Injected ordinary journal removal") }
            }
            await refused { _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: self.saveArguments(opening), expectedSession: draft.sessionID, expectedGeneration: 1) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained); await first.close()
            let replayFaults = HostIOFaults(); var replayWrites = 0
            noDomainWrites(replayFaults) { replayWrites += 1 }
            let cold = core(replayFaults); _ = try await cold.start()
            XCTAssertEqual(try task()["title"] as? String, "Ordinary saved title"); XCTAssertEqual(try task()["rev"] as? Int, before + 1)
            if mode != "commit" { XCTAssertEqual(replayWrites, 0, "acknowledged/committed replay must not write affected rows twice") }
            XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
            await cold.close(); let again = core(); _ = try await again.start()
            XCTAssertEqual(try task()["rev"] as? Int, before + 1); try preserved(retained); await again.close()
        }
    }

    func testCommittedThenChangedRowRetainsUnknownJournalAndBlocksFreshWork() async throws {
        let faults = HostIOFaults(), first = try await seed(faults), retained = try evidence(), (draft, opening) = try await newDraft(first)
        var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected lost ordinary terminal") } }
        await refused { _ = try await first.saveEditorDraft("saveDraft", argumentsJSON: self.saveArguments(opening), expectedSession: draft.sessionID, expectedGeneration: 1) }
        XCTAssertEqual(try task()["title"] as? String, "Ordinary saved title")
        let owed = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)), frozen = try Data(contentsOf: editor.url)
        let exactArguments = try XCTUnwrap(owed["argumentsJSON"] as? String), exactAttempt = try json(XCTUnwrap(owed["editorDraft"]))
        await first.close()
        _ = try sql("UPDATE tasks SET title='Later C',rev=rev+17,revBy='intervening' WHERE id=?", [taskID])
        let changed = try json(task()), cold = core()
        await refused { _ = try await cold.start() }
        XCTAssertEqual(try json(object(String(decoding: Data(contentsOf: journal), as: UTF8.self))), try json(owed))
        XCTAssertEqual(try Data(contentsOf: editor.url), frozen)
        await refused { _ = try await cold.call("captureSubmit", argumentsJSON: "[\"{}\"]") }
        let record = try mixed()
        await refused { _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: record.session.sessionID, requestId: XCTUnwrap(record.discard?.requestId)) }
        let retainedCommand = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(try json(task()), changed); XCTAssertEqual(try json(retainedCommand), try json(owed))
        XCTAssertEqual(retainedCommand["argumentsJSON"] as? String, exactArguments)
        XCTAssertEqual(try json(XCTUnwrap(retainedCommand["editorDraft"])), exactAttempt)
        XCTAssertEqual(try Data(contentsOf: editor.url), frozen); try preserved(retained)
    }

    func testDefinitePreparationRejectionThawsOnlyNewEditorAndNeverWrites() async throws {
        let faults = HostIOFaults(), host = try await seed(faults), retained = try evidence(), (draft, opening) = try await newDraft(host)
        var input = try object(XCTUnwrap((NativeJSON.jsonObject(with: Data(saveArguments(opening).utf8)) as? [String])?.first))
        input["base"] = ["title": "Wrong opening"]
        let before = try domainRows(); var writes = 0; noDomainWrites(faults) { writes += 1 }
        await refused { _ = try await host.saveEditorDraft("saveDraft", argumentsJSON: self.json([self.json(input)]), expectedSession: draft.sessionID, expectedGeneration: 1) }
        XCTAssertEqual(writes, 0); XCTAssertEqual(try domainRows(), before)
        let restored = try await host.readEditorDraft(); XCTAssertEqual(restored, draft); XCTAssertNil(try editor.read()?.attempt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
    }

    func testOldSessionForeignAndOwnedAttemptCannotBorrowOrdinaryEditorException() async throws {
        for mode in ["oldSession", "foreign", "ownedAttempt", "wrongTaskAttempt"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), retained = try evidence(), old = try retainedCheckpoint()
            if mode == "oldSession" {
                await refused { try await host.checkpointEditorDraft(.init(sessionID: old.sessionID, taskID: self.taskID, generation: old.generation + 1, payloadJSON: "{}")) }
                XCTAssertNil(try editor.read())
                try editor.checkpoint(old)
                let bytes = try Data(contentsOf: editor.url)
                await refused { _ = try await host.readEditorDraft() }
                await refused { try await host.discardEditorDraft(expectedSession: old.sessionID) }
                XCTAssertEqual(try Data(contentsOf: editor.url), bytes)
            } else {
                let (draft, opening) = try await newDraft(host)
                if mode == "foreign" {
                    await refused { try await host.checkpointEditorDraft(.init(sessionID: UUID().uuidString.lowercased(), taskID: self.taskID, generation: 2, payloadJSON: "{}")) }
                    await refused { try await host.discardEditorDraft(expectedSession: UUID().uuidString.lowercased()) }
                    XCTAssertEqual(try editor.read()?.snapshot, draft)
                } else {
                    var args = "[\"{}\"]"
                    if mode == "wrongTaskAttempt" {
                        let array = try XCTUnwrap(NativeJSON.jsonObject(with: Data(saveArguments(opening).utf8)) as? [String])
                        var request = try object(XCTUnwrap(array.first)); request["id"] = "foreign-task"; args = try json([json(request)])
                    }
                    _ = try editor.freeze(sessionID: draft.sessionID, generation: 1,
                        method: mode == "wrongTaskAttempt" ? "saveDraft" : "attachmentDraftSave", argumentsJSON: args)
                    let bytes = try Data(contentsOf: editor.url)
                    await refused { _ = try await host.readEditorDraft() }
                    XCTAssertEqual(try Data(contentsOf: editor.url), bytes)
                }
            }
            try preserved(retained); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await host.close()
        }
    }

    func testActiveDecidedCorruptAndAdvanceEvidenceRefusesBeforeDomainWrites() async throws {
        for mode in ["active", "decided", "corrupt", "advance"] {
            let parent = try isolate(); defer { root = parent }
            let faults = HostIOFaults(), host = try await seed(faults, detach: mode != "active")
            if mode == "decided" {
                let value = try mixed(), discard = try XCTUnwrap(value.discard)
                let changed = Store.MixedRecord(session: value.session, operations: value.operations,
                    discard: .init(requestId: discard.requestId, requestJSON: discard.requestJSON, expected: discard.expected, phase: .decided))
                try DurableFile.write(JSONEncoder().encode(changed), to: store.url, privateDraft: true)
            } else if mode == "corrupt" {
                try Data(#"{"version":99,"foreign":true}"#.utf8).write(to: store.url)
            } else if mode == "advance" {
                var value = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self))
                value["checkpointAdvance"] = ["foreign": true]; try Data(json(value).utf8).write(to: store.url)
            }
            let bytes = try Data(contentsOf: store.url), identity = try inode(store.url), before = try domainRows(); var writes = 0
            let independent = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: "{}")
            if FileManager.default.fileExists(atPath: editor.url.path) { try FileManager.default.removeItem(at: editor.url) }
            try editor.checkpoint(independent)
            let editorBytes = try Data(contentsOf: editor.url)
            noDomainWrites(faults) { writes += 1 }
            await refused { _ = try await host.readEditorDraft() }
            await refused { _ = try await host.call("captureSubmit", argumentsJSON: "[\"{}\"]") }
            XCTAssertEqual(writes, 0); XCTAssertEqual(try domainRows(), before)
            XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
            XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await host.close()
        }
    }

    func testSameByteSidecarReplacementAtJournalBoundaryRefusesBeforeDomainCommit() async throws {
        let faults = HostIOFaults(), host = try await seed(faults), before = try domainRows(), bytes = try Data(contentsOf: store.url)
        let identity = try inode(store.url), args = try await capture(host); var fired = false, writes = 0
        noDomainWrites(faults) { writes += 1 }
        faults.journalWrite = { if !fired { fired = true; try self.replaceExact(self.store.url) } }
        await refused { _ = try await host.call("captureSubmit", argumentsJSON: args) }
        XCTAssertTrue(fired); XCTAssertNotEqual(try inode(store.url), identity); XCTAssertEqual(try Data(contentsOf: store.url), bytes)
        XCTAssertEqual(writes, 0); XCTAssertEqual(try domainRows(), before)
    }

    func testOtherExistingEditorRoutesKeepExactRetainedOwner() async throws {
        for method in ["boardAction", "taskDelete", "taskPromote"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), retained = try evidence(), (draft, opening) = try await newDraft(host)
            let id = UUID().uuidString.lowercased(), args: String
            if method == "boardAction" {
                args = try json([json(["requestId": id, "action": ["type": "duplicateTask", "taskId": taskID]])])
            } else {
                var value: [String: Any] = ["requestId": id, "taskId": taskID, "taskRevision": try XCTUnwrap(opening["taskRevision"])]
                if method == "taskPromote" { value["title"] = "Ordinary promoted project" }
                args = try json([json(value)])
            }
            _ = try await host.saveEditorDraft(method, argumentsJSON: args, expectedSession: draft.sessionID, expectedGeneration: 1)
            if method == "boardAction" { XCTAssertEqual(try task(id)["title"] as? String, "Saved title") }
            if method == "taskDelete" { XCTAssertNotNil(try task()["deletedAt"] as? String) }
            if method == "taskPromote" { XCTAssertTrue(try sql("SELECT title FROM projects ORDER BY id").contains("Ordinary promoted project")) }
            XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained); await host.close()
        }
    }

    func testCorruptIndependentEditorCannotBeReadReplacedOrDeletedUnderRetainedOwner() async throws {
        let host = try await seed(), retained = try evidence(), (draft, _) = try await newDraft(host)
        let corrupt = Data(#"{"snapshot":{"version":99},"foreign":true}"#.utf8); try corrupt.write(to: editor.url)
        let before = try domainRows()
        await refused { _ = try await host.readEditorDraft() }
        await refused { try await host.checkpointEditorDraft(.init(sessionID: draft.sessionID, taskID: self.taskID, generation: 2, payloadJSON: "{}")) }
        await refused { try await host.discardEditorDraft(expectedSession: draft.sessionID) }
        await refused { try await host.discardCorruptEditorDraft() }
        XCTAssertEqual(try Data(contentsOf: editor.url), corrupt); XCTAssertEqual(try domainRows(), before); try preserved(retained)
    }

    func testImportsNewOwnedSessionsAndOldOwnedResumeStayBlocked() async throws {
        let host = try await seed(), retained = try evidence(), old = try retainedCheckpoint(), (draft, _) = try await newDraft(host)
        await refused { _ = try await host.prepareBackupImport(self.source()) }
        await refused { _ = try await host.beginAttachmentDraftV3(expectedSession: draft.sessionID, expectedGeneration: 1) }
        await refused { _ = try await host.beginAttachmentDraftV2(expectedSession: draft.sessionID, expectedGeneration: 1) }
        await refused { _ = try await host.checkAttachmentDraftResumeV3(expectedSession: old.sessionID, expectedGeneration: old.generation) }
        await refused { _ = try await host.checkAttachmentDraftResumeV3(expectedSession: draft.sessionID, expectedGeneration: 1) }
        XCTAssertEqual(try editor.read()?.snapshot, draft); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try preserved(retained)
    }

    func testRawBridgeMutationsRejectBeforeJobsAndPreserveSourceStageAndTarget() async throws {
        let first = try await seed(), retained = try evidence(), op = try operation(); await first.close()
        let target = try XCTUnwrap(URL(string: op.targetURI)), stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri)))
        let requests: [[String: Any]] = [
            ["op": "writeBytes", "uri": source().absoluteString, "base64": Data("changed".utf8).base64EncodedString()],
            ["op": "copy", "uri": source().absoluteString, "to": target.absoluteString],
            ["op": "move", "uri": stage.absoluteString, "to": cache.appendingPathComponent("moved.txt").absoluteString],
            ["op": "delete", "uri": target.absoluteString],
            ["op": "makeDirectory", "uri": cache.appendingPathComponent("foreign-directory").absoluteString],
            ["op": "unknown", "uri": target.absoluteString]
        ]
        let install = try json(["op": "install", "staged": source().absoluteString, "target": target.absoluteString,
            "expected": ["kind": "absent"], "expectedDownloadSha256": op.source.sha256])
        bundle = root.appendingPathComponent("raw-probe.js")
        let suffix = """
        ;(()=>{
          const open=MindwtrHost.captureOpen,poll=MindwtrHost.poll;let selected=null,answers=[];
          MindwtrHost.captureOpen=function(){
            answers=\(try json(requests)).map(value=>__mindwtrNative.fileCall(JSON.stringify(value)));
            answers.push(__mindwtrNative.installerCall(\(try literal(install))));
            answers.push(__mindwtrNative.fileDeleteNow(\(try literal(target.absoluteString))));
            selected=open();return selected;
          };
          MindwtrHost.poll=function(ticket){const raw=poll(ticket);if(raw===null||ticket!==selected)return raw;
            const result=JSON.parse(raw);if(result.ok)result.value.rawBridgeAnswers=answers;return JSON.stringify(result);};
        })();
        """
        try (String(contentsOf: originalBundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let host = core(), hooks = NativeAttachmentHostHooks(); var jobs = 0
        hooks.configureJobs = { queue in queue.beforeWork = { _, _ in jobs += 1 } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try domainRows(), result = try object(await host.call("captureOpen"))
        let answers = try XCTUnwrap(result["rawBridgeAnswers"] as? [String]); XCTAssertEqual(answers.count, requests.count + 2)
        XCTAssertTrue(answers.allSatisfy { $0.hasPrefix("!MindwtrNativeError:") }, "raw mutations must fail synchronously before queueing")
        XCTAssertEqual(jobs, 0); XCTAssertEqual(try domainRows(), before); try preserved(retained)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.appendingPathComponent("moved.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.appendingPathComponent("foreign-directory").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOrdinaryRestoreIntroducesLiveReferenceWhichExactCleanupRechecks() async throws {
        let first = try await seed(published: true), op = try operation(), old = try mixed(), sourceBytes = try Data(contentsOf: source())
        let target = try XCTUnwrap(URL(string: op.targetURI)), bytes = try Data(contentsOf: target), identity = try inode(target)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri)))
        XCTAssertEqual(op.phase, .checkpointed); XCTAssertNotNil(op.published)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path), "successful publication removes the candidate stage")
        let attachment = try XCTUnwrap(object(op.preparedJSON)["attachment"] as? [String: Any]); await first.close()
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,deletedAt,rev,revBy) VALUES ('deleted-reference','Deleted saved reference','inbox','[]','[]',?,?,?,?,1,'fixture')",
            [json([attachment]), at, at, at])
        let host = core(); _ = try await host.start()
        let retained = try evidence(includeStage: false), view = try object(await host.call("menuRead", argumentsJSON: json(["trash", json(["offset": 0, "limit": 50])])))
        let items = try XCTUnwrap(view["items"] as? [[String: Any]])
        let row = try XCTUnwrap(items.compactMap { $0["row"] as? [String: Any] }.first { $0["id"] as? String == "deleted-reference" })
        _ = try await host.call("trashTaskRestoreWrite", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(),
            "taskId": "deleted-reference", "taskRevision": XCTUnwrap(row["taskRevision"])])]))
        XCTAssertTrue(try task("deleted-reference")["deletedAt"] is NSNull); try preserved(retained)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        let result = try object(await host.finishAttachmentDraftDiscardV3(expectedSession: old.session.sessionID, requestId: XCTUnwrap(old.discard?.requestId)))
        let outcomes = try XCTUnwrap(result["operations"] as? [[String: Any]])
        XCTAssertEqual(outcomes.first?["target"] as? String, "referenced")
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        XCTAssertEqual(try Data(contentsOf: source()), sourceBytes); XCTAssertNil(try store.readMixed())
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try editor.read())
    }
}
