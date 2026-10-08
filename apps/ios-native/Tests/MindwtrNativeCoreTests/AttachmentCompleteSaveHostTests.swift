import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC, SQLite and native V3 producers. Full editor requests
/// remain frozen through the existing mixed Save/cleanup owner.
final class AttachmentCompleteSaveHostTests: XCTestCase {
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
    private let taskID = "complete-save-task"
    private let at = "2026-10-05T12:00:00.000Z"
    private let title = "Edited title / 文"
    private let notes = "Full editor notes / é"
    private var items: [[String: Any]] { [["id": "one", "title": "First", "isCompleted": false], ["id": "two", "title": "Second", "isCompleted": false]] }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task268-fixtures/\(UUID().uuidString)", isDirectory: true)
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
    // Only outer SQL object ordering is canonicalized; opaque cell strings stay exact.
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture identity unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func task(_ id: String? = nil) throws -> [String: Any] { try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id=?", [id ?? taskID]).utf8)) as? [[String: Any]])?.first) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func target(_ index: Int = 0) -> URL { managed.appendingPathComponent("baseline-\(index).txt") }
    private func baseline(_ index: Int, tombstone: Bool = false) -> [String: Any] {
        var value: [String: Any] = ["id": "baseline-\(index)", "kind": "file", "title": "Private.txt", "uri": target(index).absoluteString,
            "mimeType": "text/plain", "size": 15, "createdAt": at, "updatedAt": at, "cloudKey": "retained-object", "localStatus": "available"]
        if tombstone { value["deletedAt"] = at }; return value
    }
    private func payload(_ attachments: [[String: Any]], base: [String: Any], edits: [String: Any], checklist: [[String: Any]]) throws -> String {
        try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": base, "edited": edits,
            "raw": ["title": edits["title"] ?? "", "note": edits["description"] ?? "", "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "linkSheet": [:], "checklistBase": items, "checklistValue": checklist] as [String: Any])
    }
    private func seed(_ faults: HostIOFaults = HostIOFaults(), count: Int = 1, edited: Bool = true,
                      checklist: [[String: Any]]? = nil, lifecycle: [String: Any]? = nil, recurring: Bool = false,
                      jobs: NativeAttachmentHostHooks? = nil, historyVersion: Int = 3) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let attachments = (0..<count).map { baseline($0, tombstone: $0 > 0) }
        for index in 0..<count { try Data("baseline bytes \(index)".utf8).write(to: target(index)) }
        let recurrence: Any = recurring ? try json(["rule": "daily", "strategy": "strict", "count": 3, "seriesId": taskID]) : NSNull()
        _ = try sql("INSERT INTO tasks(id,title,description,status,taskMode,contexts,tags,attachments,checklist,recurrence,dueDate,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','next','list','[]','[]',?,?,?,?,?,?,1,'fixture')", [taskID, "Saved title", json(attachments), json(items), recurrence, recurring ? "2026-10-05" : NSNull(), at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES ('unrelated','Untouched','inbox','[]','[]','[]',?,?,1,'fixture')", [at, at])
        let host = core(faults); if let jobs { try await host.configureAttachmentHost(jobs) }; _ = try await host.start()
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any]); scheduleBase = try XCTUnwrap(opening["scheduleBase"] as? [String: Any])
        var edits: [String: Any] = edited ? ["title": title, "description": notes] : [:]
        if let lifecycle { for field in ["status", "focusedToday", "completedAt"] { edits[field] = lifecycle[field] ?? draft[field] ?? NSNull() } }
        let base = Dictionary(uniqueKeysWithValues: edits.keys.map { ($0, draft[$0] ?? NSNull()) })
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1,
            payloadJSON: try payload(attachments, base: base, edits: edits, checklist: checklist ?? items))
        try await host.checkpointEditorDraft(snapshot)
        _ = try await historyVersion == 4 ? host.beginAttachmentDraftV4(expectedSession: snapshot.sessionID, expectedGeneration: 1)
            : host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1)
        return host
    }
    private func add(_ host: CoreHost) async throws -> Store.Operation {
        if try record().version == 4 {
            let selected = root.appendingPathComponent("provider-" + UUID().uuidString + ".txt")
            try Data("borrowed source bytes".utf8).write(to: selected)
            let before = try latest()
            let reply = try object(await host.addProviderAttachmentV4(selectedURL: selected, expectedSession: before.sessionID,
                expectedGeneration: before.generation, requestId: UUID().uuidString.lowercased()))
            XCTAssertEqual(reply["version"] as? Int, 2)
            XCTAssertEqual(try Data(contentsOf: selected), Data("borrowed source bytes".utf8))
            return try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        }
        let source = cache.appendingPathComponent("borrowed.txt"); try Data("borrowed source bytes".utf8).write(to: source)
        let before = try latest()
        _ = try await host.addAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation,
            "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any]))
        return try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
    }
    private func remove(_ host: CoreHost, id: String = "baseline-0") async throws {
        let before = try latest()
        _ = try await host.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation, "attachmentId": id]))
    }
    private func request(intent: String? = nil, requestID: String = UUID().uuidString.lowercased()) throws -> String {
        let value = try object(latest().payloadJSON)
        var result: [String: Any] = ["id": taskID, "requestId": requestID, "base": try XCTUnwrap(value["touchedBase"]), "patch": try XCTUnwrap(value["edited"]),
            "scheduleBase": try XCTUnwrap(scheduleBase), "checklist": ["base": try XCTUnwrap(value["checklistBase"]), "value": try XCTUnwrap(value["checklistValue"])],
            "attachments": ["base": try XCTUnwrap(value["attachmentsBase"]), "value": try XCTUnwrap(value["attachments"])] ]
        if let intent { result["intent"] = intent }; return try json(result)
    }
    private func save(_ host: CoreHost, raw: String? = nil) async throws -> String {
        let before = try latest()
        return try await host.saveAttachmentDraftComplete(saveRequestJSON: raw ?? request(), expectedSession: before.sessionID, expectedGeneration: before.generation)
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point { if let action { try action() } else { throw HostFailure("Private.txt injected") } } }
        await host.configureAttachmentDraftHost(hooks)
    }
    @discardableResult private func refused(_ body: () async throws -> Void, saved: Bool? = nil,
                                           file: StaticString = #filePath, line: UInt = #line) async -> CoreHostAttachmentCleanupPending? {
        do { try await body(); XCTFail("Expected retained evidence", file: file, line: line); return nil }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            if let saved { XCTAssertEqual(error is CoreHostAttachmentCleanupPending, saved, file: file, line: line) }
            return error as? CoreHostAttachmentCleanupPending
        }
    }
    private func released(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertNil(try editor.read(), file: file, line: line); XCTAssertNil(try store.readMixed(), file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }
    private func journalObject() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)) }
    private func settlement() throws -> [String: Any] {
        let success = try XCTUnwrap((journalObject()["terminal"] as? [String: Any])?["success"] as? [String: Any])
        return try object(XCTUnwrap(success["_0"] as? String))
    }
    private func recovery(_ raw: String, requestId: String? = nil) throws -> [String: Any] {
        let window = try object(raw), value = try XCTUnwrap(window["recovery"] as? [String: Any])
        XCTAssertEqual(Set(value.keys), Set(requestId == nil ? ["method", "result"] : ["method", "result", "requestId"]))
        XCTAssertEqual(value["method"] as? String, "attachmentFileEditSaveCommit")
        XCTAssertEqual(value["requestId"] as? String, requestId)
        let result = try XCTUnwrap(value["result"] as? [String: Any])
        XCTAssertEqual(result["id"] as? String, taskID); XCTAssertNotNil(result["draft"] as? [String: Any])
        XCTAssertNil(result["phase"]); XCTAssertNil(result["targets"]); XCTAssertNil(result["stages"])
        return value
    }
    private func noWrites() -> HostIOFaults {
        let result = HostIOFaults(); result.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) { XCTFail("Terminal replay must not write tasks"); throw HostFailure("Unexpected write") }
        }; return result
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), child = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true); root = child; bundle = originalBundle; return previous
    }
    private func probe(_ suffix: String) throws {
        bundle = root.appendingPathComponent("probe-core-host.js")
        try (String(contentsOf: originalBundle, encoding: .utf8) + "\n;(()=>{" + suffix + "})();\n").write(to: bundle, atomically: true, encoding: .utf8)
    }
    private func relocatedTerminal(withAdd: Bool = false, stop: AttachmentDraftBoundary = .beforeSaveTarget(0)) async throws
        -> (original: URL, arguments: String, result: String) {
        let fixture = try XCTUnwrap(root), application = fixture.appendingPathComponent("Application", isDirectory: true)
        let oldContainer = application.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let newContainer = application.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let suffix = "Library/NativeUITests/" + UUID().uuidString
        root = oldContainer.appendingPathComponent(suffix, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = try XCTUnwrap(root), host = try await seed()
        if withAdd { _ = try await add(host) }; try await remove(host)
        await boundary(stop, host: host)
        let known = await refused({ _ = try await self.save(host) }, saved: true)
        let result = try XCTUnwrap(known?.resultJSON), arguments = try XCTUnwrap(journalObject()["argumentsJSON"] as? String)
        let savedRows = try rows(), bytes = try Data(contentsOf: journal), identity = try inode(journal), parent = try inode(managed)
        let owner = try store.readMixed().map { _ in try Data(contentsOf: store.url) }
        await host.close(); try FileManager.default.moveItem(at: oldContainer, to: newContainer)
        root = newContainer.appendingPathComponent(suffix, isDirectory: true)
        XCTAssertEqual(try inode(journal), identity); XCTAssertEqual(try Data(contentsOf: journal), bytes)
        XCTAssertEqual(try inode(managed), parent); XCTAssertEqual(try rows(), savedRows)
        if let owner { XCTAssertEqual(try Data(contentsOf: store.url), owner) } else { XCTAssertNil(try store.readMixed()) }
        return (original, arguments, result)
    }

    func testHashedDocumentAddRemoveAddChecklistSaveColdRecoversExactCompleteProofOnce() async throws {
        let checklist: [[String: Any]] = [["id": "one", "title": "Changed", "isCompleted": true]]
        let host = try await seed(checklist: checklist, historyVersion: 4), first = try await add(host)
        try await remove(host, id: first.requestId); let live = try await add(host)
        let frozen = try record(), snapshot = try latest(), raw = try request(), target = try XCTUnwrap(URL(string: live.targetURI))
        let bytes = try Data(contentsOf: target), identity = try inode(target), other = try json(task("unrelated"))
        XCTAssertEqual(frozen.version, 4)
        for op in [first, live] {
            let prepared = try object(op.preparedJSON), attachment = try XCTUnwrap(prepared["attachment"] as? [String: Any])
            XCTAssertEqual(prepared["version"] as? Int, 2); XCTAssertEqual(prepared["sourceSha256"] as? String, op.source.sha256)
            XCTAssertEqual(attachment["fileHash"] as? String, op.source.sha256)
        }
        await boundary(.afterSaveTerminal, host: host)
        let retained = await refused({ _ = try await self.save(host, raw: raw) }, saved: true)
        let argsJSON = try XCTUnwrap(journalObject()["argumentsJSON"] as? String)
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(argsJSON.utf8)) as? [String])
        let wrapper = try object(XCTUnwrap(args.first)), envelope = try XCTUnwrap(wrapper["envelope"] as? [String: Any])
        XCTAssertEqual(wrapper["version"] as? Int, 4)
        XCTAssertEqual((envelope["request"] as? [String: Any])?["version"] as? Int, 3)
        XCTAssertEqual(try editor.read()?.snapshot, snapshot); XCTAssertEqual(try record(), frozen)
        let savedRows = try rows(); await host.close()
        let cold = core(noWrites()), recovered = try recovery(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(object(XCTUnwrap(retained?.resultJSON))))
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try json(task("unrelated")), other); try released()
        let row = try task(), attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(row["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(row["rev"] as? Int, 2); XCTAssertEqual(row["title"] as? String, title)
        XCTAssertEqual(attachments.first { $0["id"] as? String == live.requestId }?["fileHash"] as? String, live.source.sha256)
        XCTAssertNotNil(attachments.first { $0["id"] as? String == first.requestId }?["deletedAt"])
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertTrue(log.contains("v1.3.5/ios-task-file-hash")); XCTAssertFalse(log.contains(live.source.sha256))
    }
    func testHashedInterruptedAddColdResumeAndDiscardKeepBorrowedBytesAndUseHistory4() async throws {
        let host = try await seed(edited: false, historyVersion: 4), before = try rows()
        let selected = root.appendingPathComponent("borrowed-document.txt"), bytes = Data("owned v4 document".utf8)
        try bytes.write(to: selected); let snapshot = try latest(), id = UUID().uuidString.lowercased()
        await boundary(.afterResult, host: host)
        await refused { _ = try await host.addProviderAttachmentV4(selectedURL: selected, expectedSession: snapshot.sessionID,
            expectedGeneration: snapshot.generation, requestId: id) }
        let pending = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        XCTAssertEqual(pending.phase, .resultDurable); XCTAssertEqual(try record().version, 4)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: snapshot.sessionID)
        let current = try latest(), opened = try object(await cold.checkAttachmentDraftResumeV3(expectedSession: current.sessionID, expectedGeneration: current.generation))
        XCTAssertEqual(opened["version"] as? Int, 1); XCTAssertEqual(try record().version, 4)
        let op = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        XCTAssertEqual(try object(op.replyJSON ?? "{}")["version"] as? Int, 2)
        let discardID = UUID().uuidString.lowercased()
        _ = try await cold.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID,
            "sessionID": current.sessionID, "generation": current.generation]))
        let finished = try object(await cold.finishAttachmentDraftDiscardV3(expectedSession: current.sessionID, requestId: discardID))
        XCTAssertEqual(finished["version"] as? Int, 6); XCTAssertEqual(finished["historyVersion"] as? Int, 4)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: selected), bytes); try released()
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: op.targetURI)).path))
    }
    func testHashedCompleteCancellationColdUndoRetainsHashAndLegacyOwnerRefusesNewProducer() async throws {
        let host = try await seed(historyVersion: 4), live = try await add(host), cancelID = UUID().uuidString.lowercased()
        await boundary(.afterSaveTerminal, host: host)
        await refused({ _ = try await self.save(host, raw: self.request(intent: "cancel", requestID: cancelID)) }, saved: true)
        await host.close(); let cold = core(); _ = try recovery(await cold.start(), requestId: cancelID)
        let undo = try json([json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])
        _ = try await cold.call("taskCancellationUndo", argumentsJSON: undo)
        XCTAssertEqual(try task()["status"] as? String, "next")
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(task()["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments.first { $0["id"] as? String == live.requestId }?["fileHash"] as? String, live.source.sha256)
        try released(); await cold.close()
        let previous = try isolate(); defer { root = previous }
        let legacy = try await seed(), snapshot = try latest(), ownerBytes = try Data(contentsOf: store.url)
        let selected = root.appendingPathComponent("legacy-provider.txt"); try Data("legacy".utf8).write(to: selected)
        await refused { _ = try await legacy.addProviderAttachmentV4(selectedURL: selected, expectedSession: snapshot.sessionID,
            expectedGeneration: snapshot.generation, requestId: UUID().uuidString.lowercased()) }
        XCTAssertEqual(try record().version, 3); XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes)
        XCTAssertEqual(try latest(), snapshot)
        let old = try await add(legacy); XCTAssertNil(try object(old.preparedJSON)["sourceSha256"])
        XCTAssertNil((try object(old.preparedJSON)["attachment"] as? [String: Any])?["fileHash"])
    }

    func testActualHashedAddStoreRefusesFrozenDigestAndVersionTamperingWithoutMutation() async throws {
        let host = try await seed(historyVersion: 4), added = try await add(host)
        let owner = try record(), snapshot = try latest(), beforeRows = try rows()
        let sidecarBytes = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url)
        let editorBytes = try Data(contentsOf: editor.url), editorIdentity = try inode(editor.url)
        let target = try XCTUnwrap(URL(string: added.targetURI)), targetBytes = try Data(contentsOf: target), targetIdentity = try inode(target)
        let raw = try object(String(decoding: JSONEncoder().encode(owner), as: UTF8.self))
        for field in ["version", "sourceSha256", "source.fileHash", "completed.fileHash"] {
            var frozen = try object(added.preparedJSON)
            if field == "version" { frozen["version"] = 1 }
            else if field == "sourceSha256" { frozen[field] = String(repeating: "b", count: 64) }
            else if field == "source.fileHash" {
                var prepared = try XCTUnwrap(frozen["prepared"] as? [String: Any])
                var source = try XCTUnwrap(prepared["attachment"] as? [String: Any])
                source["fileHash"] = String(repeating: "b", count: 64); prepared["attachment"] = source; frozen["prepared"] = prepared
            } else {
                var completed = try XCTUnwrap(frozen["attachment"] as? [String: Any])
                completed["fileHash"] = String(repeating: "b", count: 64); frozen["attachment"] = completed
            }
            var wrong = raw, operations = try XCTUnwrap(raw["operations"] as? [[String: Any]])
            var entry = operations[0], operation = try XCTUnwrap(entry["operation"] as? [String: Any])
            operation["preparedJSON"] = try json(frozen); entry["operation"] = operation; operations[0] = entry; wrong["operations"] = operations
            let changed = try JSONDecoder().decode(Store.MixedRecord.self, from: Data(json(wrong).utf8))
            XCTAssertThrowsError(try store.writeMixed(changed), field)
            XCTAssertEqual(try record(), owner); XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try rows(), beforeRows)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes); XCTAssertEqual(try inode(store.url), sidecarIdentity)
            XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(editor.url), editorIdentity)
            XCTAssertEqual(try Data(contentsOf: target), targetBytes); XCTAssertEqual(try inode(target), targetIdentity)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
    }
    func testEmptyAndRemoveOnlyHashedSavesDoNotEmitLiveAddHashMarker() async throws {
        for mode in ["empty", "baseline-remove", "removed-add"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(count: mode == "empty" ? 0 : 1, historyVersion: 4)
            if mode == "baseline-remove" { try await remove(host) }
            if mode == "removed-add" { let added = try await add(host); try await remove(host, id: added.requestId) }
            _ = try await save(host); try released()
            XCTAssertEqual(try task()["rev"] as? Int, 2)
            let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
            XCTAssertFalse(log.contains("v1.3.5/ios-task-file-hash"), mode)
            await host.close()
        }
    }

    func testTerminalRemoveRelocatesSameInodeContainerWithoutRewritingFrozenAuthority() async throws {
        let fixture = try XCTUnwrap(root), application = fixture.appendingPathComponent("Application", isDirectory: true)
        let oldContainer = application.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let newContainer = application.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let suffix = "Library/NativeUITests/" + UUID().uuidString
        root = oldContainer.appendingPathComponent(suffix, isDirectory: true); defer { root = fixture }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let host = try await seed(); try await remove(host)
        await boundary(.beforeSaveTarget(0), host: host)
        let known = await refused({ _ = try await self.save(host) }, saved: true)
        let savedResult = try XCTUnwrap(known?.resultJSON), command = try journalObject()
        let arguments = try XCTUnwrap(command["argumentsJSON"] as? String), fingerprint = try Store.mixedFingerprint(record())
        let encoded = try XCTUnwrap(NativeJSON.jsonObject(with: Data(arguments.utf8)) as? [String])
        let wrapper = try object(XCTUnwrap(encoded.first)); XCTAssertEqual(wrapper["recordSHA256"] as? String, fingerprint)
        XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved")
        XCTAssertEqual((try settlement()["stages"] as? [Any])?.count, 0); XCTAssertNil(try editor.read())
        let savedRows = try rows(), originalURI = target().absoluteString
        let oldRootIdentity = try inode(root), parentIdentity = try inode(managed), fileIdentity = try inode(target())
        let sidecarIdentity = try inode(store.url), journalIdentity = try inode(journal)
        let ownerBytes = try Data(contentsOf: store.url), journalBytes = try Data(contentsOf: journal)
        await host.close()
        try FileManager.default.moveItem(at: oldContainer, to: newContainer)
        root = newContainer.appendingPathComponent(suffix, isDirectory: true)
        XCTAssertNotEqual(target().absoluteString, originalURI)
        XCTAssertEqual(try inode(root), oldRootIdentity); XCTAssertEqual(try inode(managed), parentIdentity)
        XCTAssertEqual(try inode(target()), fileIdentity); XCTAssertEqual(try inode(store.url), sidecarIdentity)
        XCTAssertEqual(try inode(journal), journalIdentity); XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes)
        XCTAssertEqual(try Data(contentsOf: journal), journalBytes); XCTAssertEqual(try rows(), savedRows)
        let cold = core(noWrites()); var progress = 0
        await boundary(.afterSaveProgress, host: cold, action: {
            progress += 1
            XCTAssertEqual(try self.journalObject()["argumentsJSON"] as? String, arguments)
            XCTAssertEqual(try Store.mixedFingerprint(self.record()), fingerprint)
            XCTAssertEqual(try Data(contentsOf: self.store.url), ownerBytes)
        })
        let recovered = try recovery(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(object(savedResult)))
        XCTAssertGreaterThan(progress, 0); XCTAssertEqual(try rows(), savedRows)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path)); XCTAssertEqual(try inode(managed), parentIdentity)
        let attachmentsJSON = try XCTUnwrap(task()["attachments"] as? String)
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(attachmentsJSON.utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments.first?["uri"] as? String, originalURI); XCTAssertNotNil(attachments.first?["deletedAt"] as? String)
        try released(); await cold.close()
        let again = core(noWrites()), hooks = NativeAttachmentHostHooks(); var jobs = 0
        hooks.configureJobs = { queue in queue.beforeWork = { _, _ in jobs += 1 } }
        try await again.configureAttachmentHost(hooks)
        let reopened = try object(await again.start()); XCTAssertNil(reopened["recovery"])
        XCTAssertEqual(jobs, 0); XCTAssertEqual(try rows(), savedRows); try released()
    }

    func testAlreadySettledAddWithAbsentSidecarClearsAfterContainerRenameWithoutFileJobsOrRelocationMarker() async throws {
        let fixture = try XCTUnwrap(root); defer { root = fixture }
        let frozen = try await relocatedTerminal(withAdd: true, stop: .afterSaveRelease)
        XCTAssertEqual(try settlement()["phase"] as? String, "settled"); XCTAssertNil(try store.readMixed()); XCTAssertNil(try editor.read())
        let savedRows = try rows(), raw = try XCTUnwrap(task()["attachments"] as? String)
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [[String: Any]])
        let added = try XCTUnwrap(attachments.first { $0["kind"] as? String == "file" && $0["deletedAt"] == nil })
        let originalURI = try XCTUnwrap(added["uri"] as? String), originalTarget = try XCTUnwrap(URL(string: originalURI))
        XCTAssertTrue(originalURI.hasPrefix(frozen.original.absoluteString))
        let published = managed.appendingPathComponent(originalTarget.lastPathComponent), bytes = try Data(contentsOf: published), identity = try inode(published)
        let cold = core(noWrites()), hooks = NativeAttachmentHostHooks(); var jobs = 0
        hooks.configureJobs = { queue in queue.beforeWork = { _, _ in jobs += 1 } }; try await cold.configureAttachmentHost(hooks)
        let recovered = try recovery(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(object(frozen.result)))
        XCTAssertEqual(jobs, 0); XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try Data(contentsOf: published), bytes)
        XCTAssertEqual(try inode(published), identity); try released()
        let logs = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(logs.contains("v1.3.5/ios-attachment-container-recovery"), "already-settled Add clearing is not relocated cleanup")
    }

    func testRelocatedRemoveOriginalTaskAndCurrentProjectReferencesKeepExactGeneration() async throws {
        for currentProject in [false, true] {
            let fixture = try isolate(); defer { root = fixture }
            let frozen = try await relocatedTerminal(), bytes = try Data(contentsOf: target()), identity = try inode(target())
            var attachment = baseline(0)
            if !currentProject { attachment["uri"] = frozen.original.appendingPathComponent("attachment-files/documents/attachments/baseline-0.txt").absoluteString }
            if currentProject {
                _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,attachments,createdAt,updatedAt,rev,revBy) VALUES ('relocated-reference','Live reference','active','#94a3b8','',?,?,?,1,'fixture')",
                    [json([attachment]), at, at])
            } else { _ = try sql("UPDATE tasks SET attachments=? WHERE id='unrelated'", [json([attachment])]) }
            let savedRows = try rows(), cold = core(noWrites()), hooks = NativeAttachmentHostHooks(); var jobs = 0
            hooks.configureJobs = { queue in queue.beforeWork = { _, _ in jobs += 1 } }; try await cold.configureAttachmentHost(hooks)
            let recovered = try recovery(await cold.start())
            XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(object(frozen.result)))
            XCTAssertEqual(jobs, 0, "a fresh old/current reference selects keep before native file IO")
            XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try Data(contentsOf: target()), bytes); XCTAssertEqual(try inode(target()), identity)
            try released(); await cold.close()
        }
    }

    func testRelocatedRemoveKeepsSameBytesNewFileGenerationAndUnsafeLeaf() async throws {
        for symlink in [false, true] {
            let fixture = try isolate(); defer { root = fixture }
            _ = try await relocatedTerminal()
            let bytes = try Data(contentsOf: target()), original = try inode(target()), parent = try inode(managed), savedRows = try rows()
            let kept = root.appendingPathComponent("prior-generation.txt")
            try FileManager.default.moveItem(at: target(), to: kept)
            if symlink { try FileManager.default.createSymbolicLink(at: target(), withDestinationURL: kept) }
            else { try bytes.write(to: target()) }
            XCTAssertNotEqual(try inode(target()), original)
            let replacement = try inode(target()), cold = core(noWrites()); _ = try await cold.start()
            XCTAssertEqual(try Data(contentsOf: target()), bytes); XCTAssertEqual(try inode(target()), replacement)
            XCTAssertEqual(try Data(contentsOf: kept), bytes); XCTAssertEqual(try inode(kept), original)
            XCTAssertEqual(try inode(managed), parent); XCTAssertEqual(try rows(), savedRows); try released(); await cold.close()
        }
    }

    func testRelocatedRemoveRefusesChangedParentWithOriginalFileInodeAndRetainsTerminal() async throws {
        let fixture = try XCTUnwrap(root); defer { root = fixture }
        let frozen = try await relocatedTerminal(), bytes = try Data(contentsOf: target()), fileIdentity = try inode(target())
        let parentIdentity = try inode(managed), ownerBytes = try Data(contentsOf: store.url), savedRows = try rows()
        let previousParent = managed.deletingLastPathComponent().appendingPathComponent("previous-attachments", isDirectory: true)
        try FileManager.default.moveItem(at: managed, to: previousParent)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)
        try FileManager.default.moveItem(at: previousParent.appendingPathComponent(target().lastPathComponent), to: target())
        XCTAssertNotEqual(try inode(managed), parentIdentity); XCTAssertEqual(try inode(target()), fileIdentity)
        let cold = core(noWrites()); await refused { _ = try await cold.start() }
        XCTAssertEqual(try Data(contentsOf: target()), bytes); XCTAssertEqual(try inode(target()), fileIdentity)
        XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes); XCTAssertEqual(try rows(), savedRows)
        XCTAssertEqual(try journalObject()["argumentsJSON"] as? String, frozen.arguments)
        XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved"); XCTAssertNil(try editor.read())
    }

    func testRelocatedRemoveRefusesForeignContainerPrefixLibrarySuffixAndInvalidUUIDBeforeSQL() async throws {
        for change in ["prefix", "library", "uuid"] {
            let fixture = try isolate(); defer { root = fixture }
            _ = try await relocatedTerminal()
            let bytes = try Data(contentsOf: journal), ownerBytes = try Data(contentsOf: store.url), savedRows = try rows()
            let fileIdentity = try inode(target()), parentIdentity = try inode(managed), library = try XCTUnwrap(root)
            if change == "library" {
                let changed = library.deletingLastPathComponent().appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.moveItem(at: library, to: changed); root = changed
            } else {
                let container = library.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                let changed = change == "prefix"
                    ? container.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Foreign/Application/" + UUID().uuidString, isDirectory: true)
                    : container.deletingLastPathComponent().appendingPathComponent("not-a-container-uuid", isDirectory: true)
                try FileManager.default.createDirectory(at: changed.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: container, to: changed)
                root = changed.appendingPathComponent("Library/NativeUITests/" + library.lastPathComponent, isDirectory: true)
            }
            XCTAssertEqual(try inode(managed), parentIdentity); XCTAssertEqual(try inode(target()), fileIdentity)
            let faults = HostIOFaults(), cold = core(faults); var queries = 0
            faults.beforeSQL = { _ in queries += 1 }
            await refused { _ = try await cold.start() }
            XCTAssertEqual(queries, 0, change); XCTAssertEqual(try Data(contentsOf: journal), bytes, change)
            XCTAssertEqual(try Data(contentsOf: store.url), ownerBytes, change); XCTAssertEqual(try rows(), savedRows, change)
            XCTAssertEqual(try inode(managed), parentIdentity); XCTAssertEqual(try inode(target()), fileIdentity)
            await cold.close()
        }
    }

    func testRelocatedRemoveInterruptedAfterUnlinkRetriesExactTerminalWithoutDomainWrite() async throws {
        let fixture = try XCTUnwrap(root); defer { root = fixture }
        let frozen = try await relocatedTerminal(), savedRows = try rows(), fingerprint = try Store.mixedFingerprint(record())
        let parentIdentity = try inode(managed), cold = core(noWrites()); var entered = 0
        await boundary(.afterSaveTarget(0), host: cold, action: { entered += 1; throw HostFailure("Stop after relocated unlink") })
        await refused({ _ = try await cold.start() }, saved: true)
        XCTAssertEqual(entered, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: target().path))
        XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved")
        let targets = try XCTUnwrap(settlement()["targets"] as? [[String: Any]])
        XCTAssertTrue(targets.first?["outcome"] is NSNull); XCTAssertEqual(try journalObject()["argumentsJSON"] as? String, frozen.arguments)
        XCTAssertEqual(try Store.mixedFingerprint(record()), fingerprint); XCTAssertEqual(try rows(), savedRows); await cold.close()
        let retry = core(noWrites()); var progress = 0
        await boundary(.afterSaveProgress, host: retry, action: {
            progress += 1; XCTAssertEqual(try self.journalObject()["argumentsJSON"] as? String, frozen.arguments)
            XCTAssertEqual(try Store.mixedFingerprint(self.record()), fingerprint)
        })
        let recovered = try recovery(await retry.start())
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(object(frozen.result)))
        XCTAssertGreaterThan(progress, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: target().path))
        XCTAssertEqual(try inode(managed), parentIdentity); XCTAssertEqual(try rows(), savedRows); try released()
    }

    func testChecklistOrdinaryAndMixedFilesCommitTogetherWithCloudMergeAndUnrelatedCells() async throws {
        let value: [[String: Any]] = [["id": "one", "title": "Changed", "isCompleted": true], ["id": "three", "title": "Third", "isCompleted": false]]
        let host = try await seed(checklist: value); let added = try await add(host); try await remove(host)
        let other = try json(task("unrelated")), kept = try XCTUnwrap(URL(string: added.targetURI)), bytes = try Data(contentsOf: kept)
        await host.close(); var cloud = baseline(0); cloud["cloudKey"] = "remote-object"; cloud["title"] = "Remote title"
        _ = try sql("UPDATE tasks SET attachments=?,rev=rev+1 WHERE id=?", [json([cloud]), taskID])
        let cold = core(); _ = try await cold.start(); let result = try object(await save(cold))
        XCTAssertEqual(Set(result.keys), Set(["id", "draft"])); let row = try task()
        XCTAssertEqual(row["title"] as? String, title); XCTAssertEqual(row["description"] as? String, notes)
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(row["checklist"] as? String).utf8))), try json(value))
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(row["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments.first(where: { $0["id"] as? String == "baseline-0" })?["cloudKey"] as? String, "remote-object")
        XCTAssertEqual(try json(task("unrelated")), other); XCTAssertEqual(try Data(contentsOf: kept), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path)); try released()
    }
    func testEmptyHistoryTrueNoopHasZeroCleanupNoTaskRevisionOrDeviceInitialization() async throws {
        let host = try await seed(count: 2, edited: false), before = try rows()
        let beforeSettings = try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM settings ORDER BY id").utf8)))
        await boundary(.afterSaveTerminal, host: host); await refused({ _ = try await self.save(host) }, saved: true)
        let state = try settlement(); XCTAssertEqual((state["targets"] as? [Any])?.count, 0); XCTAssertEqual((state["stages"] as? [Any])?.count, 0)
        XCTAssertEqual(try rows(), before); await host.close()
        let cold = core(noWrites()); _ = try await cold.start(); XCTAssertEqual(try rows(), before); try released()
        for index in 0..<2 { XCTAssertTrue(FileManager.default.fileExists(atPath: target(index).path)) }
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM settings ORDER BY id").utf8))), beforeSettings)
    }
    func testEmptyHistoryCompleteChecklistChangeDoesNotClaimBaselineTombstones() async throws {
        let changed: [[String: Any]] = [["id": "one", "title": "First changed", "isCompleted": false]]
        let host = try await seed(count: 2, checklist: changed)
        _ = try await save(host); try released()
        XCTAssertEqual(try task()["title"] as? String, title)
        for index in 0..<2 { XCTAssertTrue(FileManager.default.fileExists(atPath: target(index).path)) }
    }
    func testBackdatedCompletionAndFocusUseFullLifecycleEffect() async throws {
        let completion = "2026-10-03T18:23:45.678Z"
        let host = try await seed(lifecycle: ["status": "done", "focusedToday": false, "completedAt": completion])
        try await remove(host); _ = try await save(host); try released()
        XCTAssertEqual(try task()["status"] as? String, "done"); XCTAssertEqual(try task()["completedAt"] as? String, completion)
        let previous = try isolate(); defer { root = previous }
        let focused = try await seed(lifecycle: ["focusedToday": true]); try await remove(focused); _ = try await save(focused); try released()
        XCTAssertEqual(try task()["isFocusedToday"] as? Int, 1)
    }
    func testRecurringCompletionPublishesOneChildWithProvenLiveAdd() async throws {
        let host = try await seed(lifecycle: ["status": "done", "focusedToday": false], recurring: true)
        let added = try await add(host); try await remove(host); let uri = try XCTUnwrap(URL(string: added.targetURI)), bytes = try Data(contentsOf: uri)
        _ = try await save(host); try released()
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id != 'unrelated' ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        let source = try XCTUnwrap(rows.first { $0["id"] as? String == taskID }), child = try XCTUnwrap(rows.first { $0["id"] as? String != taskID })
        let sourceFiles = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(source["attachments"] as? String).utf8)) as? [[String: Any]])
        let childFiles = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(child["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertTrue(sourceFiles.contains { $0["id"] as? String == added.requestId && $0["deletedAt"] == nil })
        // Completion projects the original recurring source, preserving its
        // baseline file. Skip below uses the edited source instead.
        XCTAssertTrue(childFiles.contains { $0["uri"] as? String == target().absoluteString && $0["deletedAt"] == nil })
        XCTAssertFalse(childFiles.contains { $0["id"] as? String == added.requestId })
        XCTAssertTrue(FileManager.default.fileExists(atPath: target().path), "Child reference fences baseline retirement")
        XCTAssertEqual(try Data(contentsOf: uri), bytes)
    }
    func testFailedCommitColdRetryUsesFrozenCompleteEnvelopeAndOneEffect() async throws {
        let faults = HostIOFaults(), host = try await seed(faults); let added = try await add(host); try await remove(host)
        let before = try rows(), raw = try request(), snapshot = try latest()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected complete COMMIT") } }
        await refused({ _ = try await self.save(host, raw: raw) }, saved: false)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try editor.read()?.snapshot, snapshot)
        XCTAssertEqual(try editor.read()?.attempt?.argumentsJSON, try json([raw])); XCTAssertNil(try journalObject()["terminal"])
        await host.close(); try probe("MindwtrHost.attachmentFileEditSavePrepare=function(){throw Error('Must not prepare replay')};")
        let cold = core(); let recovered = try recovery(await cold.start()); try released()
        XCTAssertEqual(((recovered["result"] as? [String: Any])?["draft"] as? [String: Any])?["title"] as? String, title)
        XCTAssertEqual(try task()["title"] as? String, title); XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: added.targetURI)).path))
    }
    func testLostCommitAcknowledgementReplaysExactFullProofWithoutWritingAfterRows() async throws {
        let faults = HostIOFaults(), host = try await seed(faults); try await remove(host)
        faults.afterSQL = { if $0 == "COMMIT" { throw HostFailure("Injected lost complete ACK") } }
        await refused({ _ = try await self.save(host) }, saved: false)
        XCTAssertNil(try journalObject()["terminal"]); XCTAssertEqual(try task()["title"] as? String, title)
        let saved = try rows(); await host.close(); let cold = core(noWrites()); let recovered = try recovery(await cold.start())
        XCTAssertEqual(((recovered["result"] as? [String: Any])?["draft"] as? [String: Any])?["title"] as? String, title)
        XCTAssertEqual(try rows(), saved); try released()
        let ordinary = try object(await cold.start()); XCTAssertNil(ordinary["recovery"])
    }
    func testDomainSavedColdCleanupAfterTaskCDoesNotReplayDomainEffect() async throws {
        let host = try await seed(); try await remove(host); await boundary(.afterSaveTerminal, host: host)
        let known = await refused({ _ = try await self.save(host) }, saved: true); XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved")
        let acknowledged = try object(XCTUnwrap(known?.resultJSON))
        await host.close(); _ = try sql("UPDATE tasks SET title='Task C',rev=rev+1 WHERE id=?", [taskID])
        let c = try rows(), cold = core(noWrites()); let recovered = try recovery(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(acknowledged)); XCTAssertEqual(try rows(), c); try released()
        XCTAssertTrue(FileManager.default.fileExists(atPath: target().path), "Changed source keeps its referenced baseline file")
    }
    func testCompleteCancellationCleanupGateAndColdConfirmedUndoPreserveLaterAttachmentEdits() async throws {
        let cancelID = UUID().uuidString.lowercased(), host = try await seed(); let added = try await add(host); try await remove(host)
        await boundary(.afterSaveTerminal, host: host)
        let raw = try request(intent: "cancel", requestID: cancelID)
        let pending = await refused({ _ = try await self.save(host, raw: raw) }, saved: true)
        let result = try object(XCTUnwrap(pending?.resultJSON)); XCTAssertNotNil(result["cancellation"])
        let undo = try json([json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])
        await refused { _ = try await host.call("taskCancellationUndo", argumentsJSON: undo) }
        await host.close(); let cold = core(); let recovered = try recovery(await cold.start(), requestId: cancelID); try released()
        XCTAssertEqual(try json(XCTUnwrap(recovered["result"])), try json(result))
        let exposedID = try XCTUnwrap(recovered["requestId"] as? String)
        let recoveredUndo = try json([json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": exposedID])])
        let cancelled = try task(); XCTAssertEqual(cancelled["status"] as? String, "archived")
        // After terminal release, unrelated later file metadata remains exact.
        let live = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(cancelled["attachments"] as? String).utf8)) as? [[String: Any]])
        var later = live; var foreign = baseline(9); foreign["uri"] = "content://later/file"; later.append(foreign)
        _ = try sql("UPDATE tasks SET attachments=?,rev=rev+1 WHERE id=?", [json(later), taskID])
        let value = try object(await cold.call("taskCancellationUndo", argumentsJSON: recoveredUndo))
        XCTAssertEqual(value["id"] as? String, taskID); XCTAssertEqual(try task()["status"] as? String, "next")
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(task()["attachments"] as? String).utf8))), try json(later))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: added.targetURI)).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path), "Undo cannot restore retired baseline bytes")
        await cold.close(); let reopened = core(); _ = try await reopened.start()
        await refused { _ = try await reopened.call("taskCancellationUndo", argumentsJSON: self.json([self.json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])) }
    }
    func testOldFacadeAndForgedWrapperVersionRefuseBeforeAnyReplaySQL() async throws {
        let host = try await seed(); try await remove(host); let snapshot = try latest()
        await refused { _ = try await host.saveAttachmentDraftMixed(saveRequestJSON: self.request(), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await boundary(.afterSaveJournal, host: host); await refused({ _ = try await self.save(host) }, saved: false)
        await host.close(); var command = try journalObject()
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
        var wrapper = try object(XCTUnwrap(args.first)); XCTAssertEqual(wrapper["version"] as? Int, 3); wrapper["version"] = 2
        command["argumentsJSON"] = try json([json(wrapper)]); try Data(json(command).utf8).write(to: journal)
        let before = try Data(contentsOf: database), retained = try Data(contentsOf: editor.url), faults = HostIOFaults(); var statements = 0
        faults.beforeSQL = { _ in statements += 1 }; let cold = core(faults); await refused { _ = try await cold.start() }
        XCTAssertEqual(statements, 0); XCTAssertEqual(try Data(contentsOf: database), before); XCTAssertEqual(try Data(contentsOf: editor.url), retained)
    }
    func testUnjournaledCompleteFreezeColdThawsExactEmptyAndNonemptyHistory() async throws {
        for nonempty in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); if nonempty { try await remove(host) }
            let before = try latest(), sidecar = try Data(contentsOf: store.url), rowsBefore = try rows(), raw = try request()
            await boundary(.afterSaveFreeze, host: host); await refused({ _ = try await self.save(host, raw: raw) }, saved: false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNotNil(try editor.read()?.attempt)
            await host.close(); let cold = core(noWrites()); let ordinary = try object(await cold.start()); XCTAssertNil(ordinary["recovery"])
            _ = try await cold.readEditorDraft()
            XCTAssertEqual(try latest(), before); XCTAssertNil(try editor.read()?.attempt)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try rows(), rowsBefore)
            await cold.close(); let ready = core(); _ = try await ready.start(); _ = try await save(ready, raw: raw); try released()
            await ready.close()
        }
    }

    func testUnknownCommitThenTaskCColdRefusesWithoutThawOrMetadataAdoption() async throws {
        let host = try await seed(); try await remove(host); await boundary(.afterSaveCommit, host: host)
        await refused({ _ = try await self.save(host) }, saved: false)
        XCTAssertNil(try journalObject()["terminal"]); XCTAssertEqual(try task()["title"] as? String, title)
        let sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), pending = try Data(contentsOf: journal)
        await host.close(); _ = try sql("UPDATE tasks SET title='Task C',rev=rev+1 WHERE id=?", [taskID])
        let c = try rows(), cold = core(noWrites()); await refused({ _ = try await cold.start() }, saved: false)
        XCTAssertEqual(try rows(), c); XCTAssertEqual(try Data(contentsOf: journal), pending)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target().path))
    }
    func testCompleteSaveCancellationBeforeCommitAndAfterTerminalKeepsExactRecovery() async throws {
        for point in [AttachmentDraftBoundary.beforeSaveCommit, .afterSaveTerminal] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); try await remove(host); let before = try rows()
            let entered = expectation(description: "Complete Save boundary"), release = DispatchSemaphore(value: 0)
            await boundary(point, host: host) { entered.fulfill(); _ = release.wait(timeout: .now() + 10) }
            let raw = try request(), work = Task { try await self.save(host, raw: raw) }
            await fulfillment(of: [entered], timeout: 10); work.cancel(); release.signal()
            await refused({ _ = try await work.value }, saved: point == .afterSaveTerminal)
            if point == .beforeSaveCommit { XCTAssertEqual(try rows(), before); XCTAssertNil(try journalObject()["terminal"]) }
            else { XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved") }
            await host.close(); let cold = core(); _ = try await cold.start(); try released()
            XCTAssertEqual(try task()["title"] as? String, title); await cold.close()
        }
    }
    func testRecurringSkipCarriesLiveAddToSingleFollowUpAndDoesNotConflateCancel() async throws {
        let host = try await seed(recurring: true); let added = try await add(host); try await remove(host)
        let result = try object(await save(host, raw: request(intent: "skip")))
        XCTAssertNil(result["cancellation"]); try released()
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id != 'unrelated' ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.count, 2); XCTAssertEqual(try task()["status"] as? String, "archived")
        XCTAssertNotNil(try task()["cancelledAt"] as? String)
        let child = try XCTUnwrap(rows.first { $0["id"] as? String != taskID })
        let files = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(child["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertTrue(files.contains { $0["uri"] as? String == added.targetURI && $0["deletedAt"] == nil })
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: added.targetURI)).path))
    }
    func testSelectedCancellationUndoFailedCommitAndLostAckColdReplayExactProof() async throws {
        for lost in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults); let added = try await add(host); try await remove(host)
            let cancelID = UUID().uuidString.lowercased(); _ = try await save(host, raw: request(intent: "cancel", requestID: cancelID))
            let before = try rows(), args = try json([json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])
            if lost { faults.afterSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Undo lost ACK") } } }
            else { faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Undo COMMIT") } } }
            await refused { _ = try await host.call("taskCancellationUndo", argumentsJSON: args) }
            let command = try journalObject(); XCTAssertEqual(command["method"] as? String, "taskCancellationUndoCommit"); XCTAssertNil(command["terminal"])
            let captured = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
            let envelope = try object(XCTUnwrap(captured.first)); XCTAssertEqual((envelope["prepared"] as? [String: Any])?["version"] as? Int, 2)
            if !lost { XCTAssertEqual(try rows(), before) }
            let after = try rows(); await host.close(); let cold = core(lost ? noWrites() : HostIOFaults()); _ = try await cold.start()
            if lost { XCTAssertEqual(try rows(), after) }
            XCTAssertEqual(try task()["status"] as? String, "next"); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: added.targetURI)).path)); await cold.close()
        }
    }
    func testSelectedUndoVersionOrOriginalUUIDForgeryRefusesBeforeStartupSQL() async throws {
        for mode in ["version", "uuid"] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults); try await remove(host)
            let cancelID = UUID().uuidString.lowercased(); _ = try await save(host, raw: request(intent: "cancel", requestID: cancelID))
            faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Undo COMMIT") } }
            await refused { _ = try await host.call("taskCancellationUndo", argumentsJSON: self.json([self.json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])) }
            await host.close(); var command = try journalObject()
            let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
            var envelope = try object(XCTUnwrap(args.first)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            if mode == "version" { prepared["version"] = 1 }
            else {
                var request = try XCTUnwrap(envelope["request"] as? [String: Any]); request["cancelRequestId"] = UUID().uuidString.lowercased()
                envelope["request"] = request; prepared["request"] = request
            }
            envelope["prepared"] = prepared; command["argumentsJSON"] = try json([json(envelope)])
            try Data(json(command).utf8).write(to: journal)
            let bytes = try Data(contentsOf: journal), databaseBefore = try Data(contentsOf: database), replay = HostIOFaults(); var statements = 0
            replay.beforeSQL = { _ in statements += 1 }; let cold = core(replay); await refused { _ = try await cold.start() }
            XCTAssertEqual(statements, 0); XCTAssertEqual(try Data(contentsOf: journal), bytes); XCTAssertEqual(try Data(contentsOf: database), databaseBefore)
            await cold.close()
        }
    }

    func testSelectedUndoReservesEscapedFutureTerminalBeforeWritingValidNearLimitIntent() async throws {
        let schema = core(); _ = try await schema.start(); await schema.close()
        // Inject only inert witness settings after actual preparation, and let
        // the unchanged shared validator complete successfully before returning
        // that proof to native. This does not grant commit/storage authority.
        try probe("""
        const prepare=MindwtrHost.taskCancellationUndoPrepare,validate=MindwtrHost.taskCancellationUndoValidate,poll=MindwtrHost.poll;
        let ticket=null,validationTicket=null,completed=null,envelope=null;
        MindwtrHost.taskCancellationUndoPrepare=raw=>{ticket=prepare(raw);return ticket;};
        MindwtrHost.poll=id=>{
          if(id!==ticket)return poll(id);
          if(completed!==null){
            const raw=poll(validationTicket);if(raw===null)return null;
            const validated=JSON.parse(raw);
            if(validated.ok!==true||!validated.value||validated.value.id!=='complete-save-task')throw Error('Capacity fixture needs shared validation');
            __mindwtrNative.sqlRun('INSERT INTO fixture_trace(envelope) VALUES (?)',JSON.stringify([envelope]));
            ticket=null;return JSON.stringify(completed);
          }
          const raw=poll(id);if(raw===null)return null;
          const result=JSON.parse(raw);
          if(result.ok!==true||!result.value||result.value.kind!=='prepared'){ticket=null;return raw;}
          result.value.prepared.witness.settings.task268Padding=String.fromCharCode(0).repeat(900000);
          envelope=JSON.stringify({request:result.value.prepared.request,prepared:result.value.prepared});
          validationTicket=validate(envelope);completed=result;return null;
        };
        """)
        // The initial schema-only owner must release the lock before seeding.
        // addTeardown handles its closed lifetime just like every other fixture.
        // Seed uses the probe bundle for its actual cancellation/Undo owner.
        let faults = HostIOFaults(), host = try await seed(faults); try await remove(host)
        let cancelID = UUID().uuidString.lowercased(); _ = try await save(host, raw: request(intent: "cancel", requestID: cancelID))
        _ = try sql("CREATE TABLE fixture_trace(envelope TEXT NOT NULL)")
        let before = try rows(); var writes = 0, journals = 0
        faults.beforeSQL = { statement in if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) { writes += 1 } }
        faults.journalWrite = { journals += 1 }
        await refused { _ = try await host.call("taskCancellationUndo", argumentsJSON: self.json([self.json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": cancelID])])) }
        let trace = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT envelope FROM fixture_trace").utf8)) as? [[String: Any]])
        XCTAssertEqual(trace.count, 1); let envelope = try XCTUnwrap(trace.first?["envelope"] as? String)
        enum Terminal: Codable { case success(String), rejected(String) }
        struct Command: Codable { let version: Int; let method: String; let argumentsJSON: String; var terminal: Terminal? }
        var command = Command(version: 2, method: "taskCancellationUndoCommit", argumentsJSON: try json([envelope]), terminal: nil)
        let initial = try JSONEncoder().encode(command).count
        command.terminal = .rejected(String(repeating: "\u{0000}", count: 64 * 1024))
        let reserved = try JSONEncoder().encode(command).count
        XCTAssertLessThanOrEqual(initial, Store.maximumBytes); XCTAssertGreaterThan(reserved, Store.maximumBytes)
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try released()
    }

    func testUnprovenLiveAddRefusesWholeRecurringEffectBeforeCommit() async throws {
        let faults = HostIOFaults(), host = try await seed(faults, lifecycle: ["status": "done", "focusedToday": false], recurring: true)
        let added = try await add(host); try await remove(host)
        let target = try XCTUnwrap(URL(string: added.targetURI)), before = try rows(), borrowed = cache.appendingPathComponent("borrowed.txt"), sourceBytes = try Data(contentsOf: borrowed)
        var commits = 0; faults.beforeSQL = { if $0 == "COMMIT" { commits += 1 } }
        await boundary(.afterSaveJournal, host: host) { try Data("Changed unproven publication bytes".utf8).write(to: target) }
        await refused({ _ = try await self.save(host) }, saved: false)
        XCTAssertEqual(commits, 0); XCTAssertEqual(try rows(), before); XCTAssertNil(try journalObject()["terminal"])
        XCTAssertNotNil(try editor.read()?.attempt); XCTAssertEqual(try Data(contentsOf: borrowed), sourceBytes)
        XCTAssertEqual(try Data(contentsOf: target), Data("Changed unproven publication bytes".utf8))
        XCTAssertNotNil(try store.readMixed()); XCTAssertTrue(FileManager.default.fileExists(atPath: self.target().path))
    }
    func testFreshStaleOrArchivedParentRefusesBeforeFreezeAndPreservesOwnedCheckpoint() async throws {
        for mode in ["stale", "archived"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); try await remove(host)
            let snapshot = try latest(), sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
            await host.close()
            if mode == "stale" { _ = try sql("UPDATE tasks SET title='Intervening title',rev=rev+1 WHERE id=?", [taskID]) }
            else {
                _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,createdAt,updatedAt,rev) VALUES ('protected','Protected','archived','#000000',0,?,?,1)", [at, at])
                _ = try sql("UPDATE tasks SET projectId='protected',rev=rev+1 WHERE id=?", [taskID])
            }
            let fresh = core(); _ = try await fresh.start()
            let rowsBefore = try rows() // Existing startup archive repair precedes this Save refusal baseline.
            await refused({ _ = try await self.save(fresh) }, saved: false)
            XCTAssertEqual(try latest(), snapshot); XCTAssertNil(try editor.read()?.attempt)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            XCTAssertEqual(try rows(), rowsBefore); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: target().path)); await fresh.close()
        }
    }


    func testStartupCleanupFailureRetainsTypedSavedAckAndRetriesWithoutDomainWrite() async throws {
        let host = try await seed(); try await remove(host); await boundary(.afterSaveTerminal, host: host)
        let known = await refused({ _ = try await self.save(host) }, saved: true), actual = try object(XCTUnwrap(known?.resultJSON))
        let rowsAfter = try rows(); await host.close()
        let cold = core(noWrites()); await boundary(.beforeSaveEditorDetach, host: cold)
        let failedStartup = await refused({ _ = try await cold.start() }, saved: true)
        XCTAssertEqual(try json(object(XCTUnwrap(failedStartup?.resultJSON))), try json(actual))
        await refused { _ = try await cold.readAttachmentDraft() }
        XCTAssertEqual(try rows(), rowsAfter); XCTAssertNotNil(try editor.read()?.attempt); XCTAssertNotNil(try store.readMixed())
        await cold.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let surfaced = try recovery(await cold.start())
        XCTAssertEqual(try json(XCTUnwrap(surfaced["result"])), try json(actual)); XCTAssertEqual(try rows(), rowsAfter); try released()
        let ordinary = try object(await cold.start()); XCTAssertNil(ordinary["recovery"])
    }
    func testStartupWindowFailurePreservesCancellationAckUntilOnePresentation() async throws {
        let cancelID = UUID().uuidString.lowercased(), host = try await seed(); try await remove(host)
        await boundary(.afterSaveTerminal, host: host)
        let known = await refused({ _ = try await self.save(host, raw: self.request(intent: "cancel", requestID: cancelID)) }, saved: true)
        let actual = try object(XCTUnwrap(known?.resultJSON)), rowsAfter = try rows(); await host.close()
        try probe("""
        const original=MindwtrHost.window;
        MindwtrHost.window=(...args)=>{
          const guardResult=__mindwtrNative.sqlRun('SELECT 271 AS after_settled_startup','[]');
          if(typeof guardResult==='string'&&guardResult.startsWith('!MindwtrNativeError:')) throw Error('Injected startup window failure');
          return original(...args);
        };
        """)
        let faults = HostIOFaults(); var failed = false
        faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) {
                XCTFail("Startup presentation retry must not replay the saved domain effect"); throw HostFailure("Unexpected domain write")
            }
            if statement == "SELECT 271 AS after_settled_startup" && !failed {
                failed = true; XCTAssertNil(try self.editor.read()); XCTAssertNil(try self.store.readMixed())
                XCTAssertFalse(FileManager.default.fileExists(atPath: self.journal.path))
                throw HostFailure("Injected startup window failure")
            }
        }
        let cold = core(faults); await refused({ _ = try await cold.start() }, saved: false)
        XCTAssertTrue(failed); XCTAssertEqual(try rows(), rowsAfter); try released()
        await refused { _ = try await cold.readAttachmentDraft() }
        let surfaced = try recovery(await cold.start(), requestId: cancelID)
        XCTAssertEqual(try json(XCTUnwrap(surfaced["result"])), try json(actual)); XCTAssertEqual(try rows(), rowsAfter)
        let ordinary = try object(await cold.start()); XCTAssertNil(ordinary["recovery"])
        faults.beforeSQL = nil
        let exposedID = try XCTUnwrap(surfaced["requestId"] as? String)
        _ = try await cold.call("taskCancellationUndo", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(), "cancelRequestId": exposedID])]))
        XCTAssertEqual(try task()["status"] as? String, "next")
        await cold.close(); await refused { _ = try await cold.start() }
    }

    func testDefinitiveRejectedCompleteSaveStartupNeverReportsSavedRecovery() async throws {
        let host = try await seed(); try await remove(host); let snapshot = try latest(), sidecar = try Data(contentsOf: store.url)
        let hooks = AttachmentDraftHostHooks(); var changed = false
        hooks.boundary = { point in
            if point == .beforeSaveCommit && !changed {
                changed = true; _ = try self.sql("UPDATE tasks SET title='Changed before commit',rev=rev+1 WHERE id=?", [self.taskID])
            }
            if point == .beforeSaveThaw { throw HostFailure("Retain the actual definitive rejection") }
        }
        await host.configureAttachmentDraftHost(hooks)
        await refused({ _ = try await self.save(host) }, saved: false)
        XCTAssertTrue(changed)
        let terminal = try XCTUnwrap(journalObject()["terminal"] as? [String: Any])
        XCTAssertNotNil(terminal["rejected"]); XCTAssertNil(terminal["success"])
        let rowsAfter = try rows(); await host.close()
        let cold = core(noWrites()), startup = try object(await cold.start())
        XCTAssertNil(startup["recovery"]); XCTAssertEqual(try rows(), rowsAfter)
        XCTAssertEqual(try latest(), snapshot); XCTAssertNil(try editor.read()?.attempt)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
