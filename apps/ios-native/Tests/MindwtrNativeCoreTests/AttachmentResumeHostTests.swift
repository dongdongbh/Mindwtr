import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC, SQLite and real V3 producers; resume grants no file or
/// editor mutation authority and preserves the original opaque checkpoint.
final class AttachmentResumeHostTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var bundle: URL!
    private var originalBundle: URL!
    private var scheduleBase: [String: Any]!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "owned-resume-task"
    private let at = "2026-10-05T12:00:00.000Z"
    private var items: [[String: Any]] { [["id": "one", "title": "First", "isCompleted": false], ["id": "two", "title": "Second", "isCompleted": true]] }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task270-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    // Sort only outer row keys, keeping opaque SQL cell strings unchanged.
    private func rows(_ table: String = "tasks") throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \(table) ORDER BY id").utf8))) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func target(_ index: Int = 0) -> URL { managed.appendingPathComponent("baseline-\(index).txt") }
    private func baseline(_ index: Int) -> [String: Any] {
        var value: [String: Any] = ["id": "baseline-\(index)", "kind": "file", "title": "Private.txt", "uri": target(index).absoluteString,
            "mimeType": "text/plain", "size": 15, "createdAt": at, "updatedAt": at, "cloudKey": "opening-object", "localStatus": "available"]
        if index == 1 { value["deletedAt"] = at }; return value
    }
    private func link(_ index: Int) -> [String: Any] {
        ["id": String(format: "27000000-0000-4000-8000-%012d", index), "kind": "link", "title": "Link \(index)", "uri": "https://example.test/\(index)", "createdAt": at, "updatedAt": at]
    }
    private func payload(_ attachments: [[String: Any]], unresolved: Bool) throws -> String {
        let cleanRaw: [String: Any] = ["title": "Edited title", "note": "", "location": "", "estimate": "", "estimateResolved": "",
            "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
            "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
            "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        return try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": ["title": "Saved title"],
            "edited": unresolved ? [:] : ["title": "Edited title"],
            "raw": unresolved ? ["title": "Unresolved raw title 🧪\n", "note": "Unresolved note", "location": "", "estimate": "12.", "estimateResolved": "",
                "timeSpent": "-", "timeSpentResolved": "", "tokens": ["tags": "#half"], "tokenCanonical": ["tags": ""], "tokenResolved": ["tags": ""], "tokenEdited": ["tags"],
                "checklistInputs": ["one": "half row"], "checklistAppend": "pending row", "relativeAmount": "-", "relativeUnit": "day", "relativeOwned": true,
                "relativeCommitRequested": true, "recurrenceInputs": ["interval": "-"], "recurrenceOwned": ["interval"], "recurrenceCommitRequested": ["interval"]] as [String: Any] : cleanRaw,
            "scheduleEdits": unresolved ? [["id": "pending", "field": "dueDate", "value": "2026-10-10"]] : [],
            "scheduleFailedID": unresolved ? "pending" : NSNull(), "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "linkSheet": unresolved ? ["text": "https://["] : [:], "checklistBase": items, "checklistValue": items] as [String: Any])
    }
    private func seed(_ faults: HostIOFaults = HostIOFaults(), version: Int = 3, unresolved: Bool = true) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let attachments = [baseline(0), baseline(1), link(0)]
        for index in 0..<2 { try Data("baseline bytes \(index)".utf8).write(to: target(index)) }
        _ = try sql("INSERT INTO tasks(id,title,description,status,taskMode,contexts,tags,attachments,checklist,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','next','list','[]','[]',?,?,?,?,1,'fixture')", [taskID, "Saved title", json(attachments), json(items), at, at])
        let host = core(faults); _ = try await host.start()
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        scheduleBase = try XCTUnwrap(opening["scheduleBase"] as? [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1,
            payloadJSON: try payload(attachments, unresolved: unresolved))
        try await host.checkpointEditorDraft(snapshot)
        if version == 3 { _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        else if version == 2 { _ = try await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        else { _ = try await host.beginAttachmentDraft(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        return host
    }
    private func add(_ host: CoreHost) async throws -> Store.Operation {
        let source = cache.appendingPathComponent("borrowed.txt"); try Data("borrowed source bytes".utf8).write(to: source)
        let before = try latest()
        _ = try await host.addAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
            "generation": before.generation, "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any]))
        return try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
    }
    private func remove(_ host: CoreHost, id: String = "baseline-0") async throws {
        let before = try latest()
        _ = try await host.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation, "attachmentId": id]))
    }
    private func linkGap(_ host: CoreHost, index: Int) async throws {
        let before = try latest(); var value = try object(before.payloadJSON)
        var attachments = try XCTUnwrap(value["attachments"] as? [[String: Any]]); attachments.append(link(index)); value["attachments"] = attachments
        try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1, payloadJSON: json(value)))
    }
    private func resume(_ host: CoreHost) async throws -> [String: Any] {
        let before = try latest()
        let value = try object(await host.checkAttachmentDraftResumeV3(expectedSession: before.sessionID, expectedGeneration: before.generation))
        XCTAssertEqual(Set(value.keys), Set(["version", "checkpoint", "ready"])); XCTAssertEqual(value["version"] as? Int, 1)
        let checkpoint = try XCTUnwrap(value["checkpoint"] as? [String: Any])
        XCTAssertEqual(Set(checkpoint.keys), Set(["version", "sessionID", "taskID", "generation", "payloadJSON"]))
        XCTAssertEqual(checkpoint["payloadJSON"] as? String, before.payloadJSON); XCTAssertEqual(checkpoint["sessionID"] as? String, before.sessionID)
        XCTAssertEqual(checkpoint["generation"] as? Int, before.generation); XCTAssertEqual(checkpoint["taskID"] as? String, before.taskID)
        let ready = try XCTUnwrap(value["ready"] as? [String: Any]); XCTAssertEqual(ready["kind"] as? String, "ready"); return ready
    }
    private func request() throws -> String {
        let value = try object(latest().payloadJSON)
        return try json(["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": try XCTUnwrap(value["touchedBase"]), "patch": try XCTUnwrap(value["edited"]),
            "scheduleBase": try XCTUnwrap(scheduleBase), "checklist": ["base": items, "value": items],
            "attachments": ["base": try XCTUnwrap(value["attachmentsBase"]), "value": try XCTUnwrap(value["attachments"])]] as [String: Any])
    }
    private func inode(_ file: URL) throws -> String {
        var info = stat(); guard lstat(file.path, &info) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func replaceExact(_ file: URL) throws {
        let bytes = try Data(contentsOf: file), replacement = file.appendingPathExtension("replacement")
        try bytes.write(to: replacement); guard rename(replacement.path, file.path) == 0 else { throw HostFailure("Fixture rename unavailable") }
    }
    private struct Evidence {
        let editorBytes: Data, editorIdentity: String, sidecarBytes: Data, sidecarIdentity: String, tasks: String, settings: String
    }
    private func evidence() throws -> Evidence { try .init(editorBytes: Data(contentsOf: editor.url), editorIdentity: inode(editor.url),
        sidecarBytes: Data(contentsOf: store.url), sidecarIdentity: inode(store.url), tasks: rows(), settings: rows("settings")) }
    private func unchanged(_ before: Evidence, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: editor.url), before.editorBytes, file: file, line: line); XCTAssertEqual(try inode(editor.url), before.editorIdentity, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: store.url), before.sidecarBytes, file: file, line: line); XCTAssertEqual(try inode(store.url), before.sidecarIdentity, file: file, line: line)
        XCTAssertEqual(try rows(), before.tasks, file: file, line: line); XCTAssertEqual(try rows("settings"), before.settings, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected retained evidence", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line); XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point { throw HostFailure("Injected retained work") } }; await host.configureAttachmentDraftHost(hooks)
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), child = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true); root = child; bundle = originalBundle; return previous
    }
    private func probe(_ suffix: String) throws {
        bundle = root.appendingPathComponent("probe-core-host.js")
        try (String(contentsOf: originalBundle, encoding: .utf8) + "\n;(()=>{" + suffix + "})();\n").write(to: bundle, atomically: true, encoding: .utf8)
    }

    func testEmptyOwnerReadsOpaqueBuffersWithoutDomainSettingsOrPrivateFileChanges() async throws {
        let faults = HostIOFaults(), host = try await seed(faults), before = try evidence(), snapshot = try latest()
        var writes = 0
        faults.beforeSQL = { statement in if ["INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT"].contains(where: { statement.hasPrefix($0) }) { writes += 1; throw HostFailure("Unexpected resume write") } }
        let ready = try await resume(host)
        XCTAssertEqual((ready["freshDraft"] as? [String: Any])?["title"] as? String, "Saved title")
        XCTAssertEqual(try json(XCTUnwrap(ready["freshChecklistBase"])), try json(items)); XCTAssertEqual(writes, 0); try unchanged(before)
        let raw = try object(snapshot.payloadJSON)
        XCTAssertEqual((raw["raw"] as? [String: Any])?["estimate"] as? String, "12."); XCTAssertEqual((raw["scheduleEdits"] as? [Any])?.count, 1)
        XCTAssertEqual((raw["linkSheet"] as? [String: Any])?["text"] as? String, "https://[")
    }
    func testRealMixedHistoryLinkGapsAndColdCloudMetadataPreserveExactCheckpoint() async throws {
        let host = try await seed(); try await linkGap(host, index: 1); let added = try await add(host)
        try await linkGap(host, index: 2); try await remove(host); await host.close()
        var fresh = baseline(0); fresh["cloudKey"] = "concurrent-object"; fresh["title"] = "Remote metadata"; fresh["deletedAt"] = at
        _ = try sql("UPDATE tasks SET attachments=?,description='External note',rev=rev+1 WHERE id=?", [json([fresh, baseline(1), link(0)]), taskID])
        let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start(); let before = try evidence()
        var writes = 0
        faults.beforeSQL = { statement in if ["INSERT", "UPDATE", "DELETE"].contains(where: { statement.hasPrefix($0) }) { writes += 1 } }
        let ready = try await resume(cold), attachments = try XCTUnwrap(ready["freshAttachmentsBase"] as? [[String: Any]])
        XCTAssertEqual(attachments.first?["cloudKey"] as? String, "concurrent-object"); XCTAssertEqual((ready["freshDraft"] as? [String: Any])?["description"] as? String, "External note")
        XCTAssertEqual(writes, 0); XCTAssertEqual(try record().operations.count, 2); try unchanged(before)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: added.targetURI))), Data("borrowed source bytes".utf8))
        let payload = try object(latest().payloadJSON)
        var ordinary: [String: Any] = ["id": taskID, "touchedBase": try XCTUnwrap(payload["touchedBase"]), "checklistBase": items,
            "attachmentsBase": try XCTUnwrap(payload["attachmentsBase"]), "attachments": try XCTUnwrap(payload["attachments"])]
        let ownedFileChange = try json(ordinary)
        await refused { _ = try await cold.call("taskEditorResumeCheck", argumentsJSON: self.json([ownedFileChange])) }
        ordinary["attachments"] = try XCTUnwrap(payload["attachmentsBase"])
        let unchangedFiles = try json(ordinary)
        let ordinaryReady = try object(await cold.call("taskEditorResumeCheck", argumentsJSON: json([unchangedFiles])))
        XCTAssertEqual(ordinaryReady["kind"] as? String, "ready"); XCTAssertEqual(writes, 0); try unchanged(before)
    }
    func testStaleOpeningChecklistAndArchivedParentRefuseWithoutChangingEvidence() async throws {
        for mode in ["title", "checklist", "archived"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed()
            if mode == "title" { _ = try sql("UPDATE tasks SET title='External title' WHERE id=?", [taskID]) }
            else if mode == "checklist" { _ = try sql("UPDATE tasks SET checklist='[]' WHERE id=?", [taskID]) }
            else {
                _ = try sql("INSERT INTO projects(id,title,status,color,createdAt,updatedAt) VALUES ('archived','Archived','archived','#000000',?,?)", [at, at])
                _ = try sql("UPDATE tasks SET projectId='archived' WHERE id=?", [taskID])
            }
            let before = try evidence(); await refused { _ = try await self.resume(host) }; try unchanged(before); await host.close()
        }
    }
    func testMissingAddedBytesCanOpenButSaveMustProvePublicationUntilExplicitRemove() async throws {
        let host = try await seed(unresolved: false), added = try await add(host), published = try XCTUnwrap(URL(string: added.targetURI))
        try FileManager.default.removeItem(at: published); let before = try evidence()
        _ = try await resume(host); try unchanged(before)
        let raw = try request(), snapshot = try latest()
        await refused { _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: raw, expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        try unchanged(before); try await remove(host, id: added.requestId)
        let after = try latest(); _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: request(), expectedSession: after.sessionID, expectedGeneration: after.generation)
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.readMixed()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try Data(contentsOf: target(0)), Data("baseline bytes 0".utf8))
        // The existing nonempty Save planner settles an opening baseline
        // tombstone too; resume itself never owns or deletes those bytes.
        XCTAssertFalse(FileManager.default.fileExists(atPath: target(1).path))
        let persisted = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first?["attachments"] as? String)
        XCTAssertEqual((try XCTUnwrap(NativeJSON.jsonObject(with: Data(persisted.utf8)) as? [[String: Any]])).first(where: { $0["id"] as? String == "baseline-1" })?["deletedAt"] as? String, at)
    }
    func testStrictOwnerInputsLegacyAndForeignEditorRemainRetained() async throws {
        let host = try await seed(), before = try evidence(), snapshot = try latest()
        for (session, generation) in [(snapshot.sessionID.uppercased(), snapshot.generation), (UUID().uuidString.lowercased(), snapshot.generation),
            (snapshot.sessionID, 0), (snapshot.sessionID, snapshot.generation + 1), (snapshot.sessionID, 9_007_199_254_740_992)] {
            await refused { _ = try await host.checkAttachmentDraftResumeV3(expectedSession: session, expectedGeneration: generation) }; try unchanged(before)
        }
        var foreign = try object(snapshot.payloadJSON); foreign["raw"] = ["title": "Foreign buffer"]
        let replacement = EditorDraftSnapshot(sessionID: snapshot.sessionID, taskID: snapshot.taskID, generation: snapshot.generation, payloadJSON: try json(foreign))
        struct Stored: Encodable { let snapshot: EditorDraftSnapshot }
        try JSONEncoder().encode(Stored(snapshot: replacement)).write(to: editor.url, options: .atomic)
        let changed = try evidence(); await refused { _ = try await self.resume(host) }; try unchanged(changed); await host.close()
        for version in [1, 2] {
            let previous = try isolate(); defer { root = previous }
            let legacy = try await seed(version: version), retained = try evidence()
            await refused { _ = try await self.resume(legacy) }; try unchanged(retained); await legacy.close()
        }
    }
    func testRetainedPendingRemoveAdvanceFrozenSaveAndDiscardAreNeverReplayedByRead() async throws {
        for mode in ["remove", "add", "advance", "freeze", "discard", "terminal"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(unresolved: false)
            if mode == "remove" { await boundary(.afterIntent, host: host); await refused { try await self.remove(host) } }
            else if mode == "add" { await boundary(.afterIntent, host: host); await refused { _ = try await self.add(host) } }
            else if mode == "advance" { await boundary(.afterAdvanceIntent, host: host); await refused { try await self.linkGap(host, index: 1) } }
            else if mode == "discard" {
                await boundary(.afterDiscardDecision, host: host); let snapshot = try latest()
                await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: self.json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": snapshot.sessionID, "generation": snapshot.generation])) }
            } else {
                await boundary(mode == "freeze" ? .afterSaveFreeze : .afterSaveTerminal, host: host); let snapshot = try latest()
                await refused { _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: self.request(), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
            }
            if mode == "advance" { XCTAssertNotNil(try record().checkpointAdvance) }
            if mode == "add" || mode == "remove" { XCTAssertFalse(try XCTUnwrap(record().operations.last).checkpointed) }
            if mode == "freeze" || mode == "terminal" { XCTAssertNotNil(try editor.read()?.attempt) }
            if mode == "discard" { XCTAssertNotNil(try record().discard) }
            let before = try evidence(), savedJournal = try? Data(contentsOf: journal)
            await refused { _ = try await self.resume(host) }
            XCTAssertEqual(try Data(contentsOf: editor.url), before.editorBytes); XCTAssertEqual(try inode(editor.url), before.editorIdentity)
            XCTAssertEqual(try Data(contentsOf: store.url), before.sidecarBytes); XCTAssertEqual(try inode(store.url), before.sidecarIdentity)
            XCTAssertEqual(try rows(), before.tasks); XCTAssertEqual(try rows("settings"), before.settings)
            XCTAssertEqual(try? Data(contentsOf: journal), savedJournal); await host.close()
        }
    }

    func testExactEditorAndSidecarInodesAreFencedAcrossLineageReadyAndDiagnostic() async throws {
        for point in ["lineage", "ready", "marker"] {
            for editorFile in [false, true] {
                let previous = try isolate(); defer { root = previous }
                let host = try await seed(); await host.close()
                let method = point == "lineage" ? "attachmentDraftValidateLineageV3" : "attachmentDraftResumeCheckV3"
                if point == "marker" {
                    try probe("""
                    const f=MindwtrHost.attachmentDraftAcknowledged;
                    MindwtrHost.attachmentDraftAcknowledged=(operation,outcome)=>{
                      if(operation==='owned-resume'&&outcome==='validated') __mindwtrNative.sqlRun('SELECT 270 AS exact_resume_owner','[]');
                      return f(operation,outcome);
                    };
                    """)
                } else {
                    try probe("""
                    const host=MindwtrHost,original=host['\(method)'],poll=host.poll;let ticket=null;
                    host['\(method)']=json=>{ticket=original(json);return ticket;};
                    host.poll=id=>{const result=poll(id);if(id===ticket&&result!==null){
                      ticket=null;const completed=JSON.parse(result),value=completed.value;
                      if(completed.ok===true&&value&&(value.kind==='ready'||value.version===3))
                        __mindwtrNative.sqlRun('SELECT 270 AS exact_resume_owner','[]');
                    }return result;};
                    """)
                }
                let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start()
                let file = editorFile ? editor.url : store.url, before = try evidence(), bytes = try Data(contentsOf: file), identity = try inode(file)
                var fired = false, replacementIdentity: String?
                faults.beforeSQL = { statement in
                    if statement == "SELECT 270 AS exact_resume_owner" && !fired {
                        fired = true; try self.replaceExact(file); replacementIdentity = try self.inode(file)
                    }
                }
                await refused { _ = try await self.resume(cold) }
                XCTAssertTrue(fired); XCTAssertNotEqual(try inode(file), identity); XCTAssertEqual(try inode(file), try XCTUnwrap(replacementIdentity))
                XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try rows(), before.tasks); XCTAssertEqual(try rows("settings"), before.settings)
                XCTAssertEqual(try Data(contentsOf: editor.url), before.editorBytes); XCTAssertEqual(try Data(contentsOf: store.url), before.sidecarBytes)
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
            }
        }
    }
    func testCancellationBeforeReadAndAcrossCompletedSharedReadRetainsExactOwner() async throws {
        let host = try await seed(), before = try evidence(), snapshot = try latest()
        let cancelled = Task { () async throws -> String in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await host.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        }
        await refused { _ = try await cancelled.value }; try unchanged(before); await host.close()
        try probe("""
        const host=MindwtrHost,f=host.attachmentDraftResumeCheckV3,poll=host.poll;let ticket=null;
        host.attachmentDraftResumeCheckV3=json=>{ticket=f(json);return ticket;};
        host.poll=id=>{const result=poll(id);if(id===ticket&&result!==null){ticket=null;
          const completed=JSON.parse(result);if(completed.ok===true&&completed.value?.kind==='ready')
            __mindwtrNative.sqlRun('SELECT 270 AS cancelled_resume_arrival','[]');
        }return result;};
        """)
        let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start(); let retained = try evidence()
        let entered = expectation(description: "Completed shared resume read"), release = DispatchSemaphore(value: 0)
        var fired = false
        faults.beforeSQL = { statement in if statement == "SELECT 270 AS cancelled_resume_arrival" && !fired {
            fired = true; entered.fulfill(); guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Cancellation fixture did not release") }
        } }
        let work = Task { try await cold.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        await fulfillment(of: [entered], timeout: 10); work.cancel(); release.signal()
        await refused { _ = try await work.value }; XCTAssertTrue(fired); try unchanged(retained)
        faults.beforeSQL = nil; _ = try await resume(cold); try unchanged(retained)
    }
    func testAppearingJournalAndClosedLibraryCannotBeAdoptedByRead() async throws {
        let host = try await seed(), before = try evidence(), snapshot = try latest(); await host.close()
        await refused { _ = try await host.checkAttachmentDraftResumeV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }; try unchanged(before)
        try probe("""
        const host=MindwtrHost,f=host.attachmentDraftResumeCheckV3,poll=host.poll;let ticket=null;
        host.attachmentDraftResumeCheckV3=json=>{ticket=f(json);return ticket;};
        host.poll=id=>{const result=poll(id);if(id===ticket&&result!==null){ticket=null;
          const completed=JSON.parse(result);if(completed.ok===true&&completed.value?.kind==='ready')
            __mindwtrNative.sqlRun('SELECT 270 AS foreign_resume_journal','[]');
        }return result;};
        """)
        let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start(); let retained = try evidence(), foreign = Data("foreign retained journal".utf8)
        var fired = false
        faults.beforeSQL = { statement in if statement == "SELECT 270 AS foreign_resume_journal" && !fired {
            fired = true; try foreign.write(to: self.journal, options: .atomic)
        } }
        await refused { _ = try await self.resume(cold) }; XCTAssertTrue(fired); XCTAssertEqual(try Data(contentsOf: journal), foreign)
        XCTAssertEqual(try Data(contentsOf: editor.url), retained.editorBytes); XCTAssertEqual(try inode(editor.url), retained.editorIdentity)
        XCTAssertEqual(try Data(contentsOf: store.url), retained.sidecarBytes); XCTAssertEqual(try inode(store.url), retained.sidecarIdentity)
        XCTAssertEqual(try rows(), retained.tasks); XCTAssertEqual(try rows("settings"), retained.settings)
    }
    func testValidEscapedHistoryIsActuallyBoundedAndResumePerformsNoFileJobs() async throws {
        let host = try await seed(); _ = try await add(host); try await remove(host)
        let before = try latest(), padded = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1,
            payloadJSON: String(repeating: "\n", count: 20_000) + before.payloadJSON)
        try await host.checkpointEditorDraft(padded); await host.close()
        let lineage = try object(NativeAttachmentDraftCoordinator.mixedSaveLineageJSON(record(), managedDirectoryURI: managed.absoluteString, selection: .complete))
        let checkpoint = try object(String(decoding: JSONEncoder().encode(padded), as: UTF8.self))
        let input = try json(["version": 1, "kind": "owned-editor-resume", "checkpoint": checkpoint, "ownedDraft": lineage])
        XCTAssertGreaterThan(input.utf8.count, padded.payloadJSON.utf8.count * 2); XCTAssertLessThanOrEqual(input.utf8.count, 8 * 1024 * 1024)
        let hooks = NativeAttachmentHostHooks(); var jobs = 0
        hooks.configureJobs = { runner in runner.beforeWork = { _, _ in jobs += 1; throw HostFailure("Resume must not inspect or mutate file content") } }
        let cold = core(); try await cold.configureAttachmentHost(hooks); _ = try await cold.start(); let retained = try evidence()
        _ = try await resume(cold); XCTAssertEqual(jobs, 0); XCTAssertEqual(try latest(), padded); try unchanged(retained)
    }

    func testSummaryNullActiveAndLegacyDiscardRemainInformationalAndSealed() async throws {
        let ordinary = core(), startup = try object(await ordinary.start()), absent = try await ordinary.readAttachmentDraft()
        XCTAssertNil(startup["recovery"]); XCTAssertEqual(absent, "null"); await ordinary.close()
        for version in [1, 2, 3] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(version: version), before = try evidence(), snapshot = try latest()
            let summary = try object(await host.readAttachmentDraft())
            XCTAssertEqual(Set(summary.keys), Set(["version", "status", "sessionID", "checkpoint", "operations", "discard"]))
            XCTAssertEqual(summary["version"] as? Int, version); XCTAssertTrue(summary["discard"] is NSNull); try unchanged(before)
            // Typed V3 methods are public; generic string routing stays sealed.
            await refused { _ = try await host.call("checkAttachmentDraftResumeV3", argumentsJSON: "[]") }
            await refused { _ = try await host.call("addProviderAttachmentV3", argumentsJSON: "[]") }; try unchanged(before)
            if version < 3 {
                let requestID = UUID().uuidString.lowercased(), raw = try json(["version": 1, "requestId": requestID, "sessionID": snapshot.sessionID, "generation": snapshot.generation])
                await boundary(.afterDiscardDecision, host: host)
                await refused { _ = try await host.discardAttachmentDraft(requestJSON: raw) }
                let retained = try evidence(), legacySummary = try object(await host.readAttachmentDraft())
                let decision = try XCTUnwrap(legacySummary["discard"] as? [String: Any])
                XCTAssertEqual(Set(decision.keys), Set(["requestId", "phase"])); XCTAssertEqual(decision["requestId"] as? String, requestID)
                XCTAssertEqual(decision["phase"] as? String, "decided"); XCTAssertEqual(legacySummary["version"] as? Int, version); try unchanged(retained)
                await refused { _ = try await self.resume(host) }; try unchanged(retained)
            }
            await host.close()
        }
    }
}
