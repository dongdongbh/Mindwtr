import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual mixed AddV3 producer, bundled JSC, SQLite and typed descriptor jobs.
/// Old fixture suites are unchanged; these histories begin with real V3 calls.
final class AttachmentMixedAddHostTests: XCTestCase {
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
    private let taskID = "mixed-add-task"
    private let at = "2026-10-05T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task264/\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func domain() throws -> String {
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='fixture_trace' ORDER BY name").utf8)) as? [[String: Any]])
        var result: [String: Any] = [:]
        func quoted(_ value: String) -> String { "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), schema = try XCTUnwrap(table["sql"] as? String)
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("PRAGMA table_info(" + quoted(name) + ")").utf8)) as? [[String: Any]])
            let names = try columns.map { try XCTUnwrap($0["name"] as? String) }
            var fields = names.map { column -> String in
                let identifier = quoted(column)
                return "typeof(" + identifier + ") || ':' || CASE typeof(" + identifier
                    + ") WHEN 'blob' THEN hex(" + identifier + ") WHEN 'text' THEN hex(CAST(" + identifier
                    + " AS BLOB)) ELSE quote(" + identifier + ") END AS " + quoted(column)
            }
            if schema.range(of: "WITHOUT\\s+ROWID", options: [.regularExpression, .caseInsensitive]) == nil {
                let declared = Set(names.map { $0.lowercased() })
                if let rowID = ["rowid", "_rowid_", "oid"].first(where: { !declared.contains($0) }) {
                    fields.append("quote(" + quoted(rowID) + ") AS " + quoted("__fixture_row_identity"))
                }
            }
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT " + fields.joined(separator: ",") + " FROM " + quoted(name)).utf8)) as? [[String: Any]])
            result[name] = ["schema": schema, "columns": columns, "rows": try rows.map { try json($0) }.sorted()]
        }
        return try json(result)
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func baselineTarget() -> URL { managed.appendingPathComponent("baseline.txt") }
    private func source() -> URL { cache.appendingPathComponent("borrowed.txt") }
    private func payload(_ attachments: [[String: Any]], note: String = "Ordinary notes / e\u{301} / 文") throws -> String {
        try json(["version": 2, "taskID": taskID, "tab": "task",
            "touchedBase": ["title": "Saved title", "description": "Saved notes"],
            "edited": ["title": "Private.txt draft", "description": note],
            "raw": ["title": "Private.txt draft", "note": note, "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "linkSheet": [:]] as [String: Any])
    }

    private func seed(note: String = "Ordinary notes / e\u{301} / 文", faults: HostIOFaults = HostIOFaults(),
                      baselineCount: Int = 1, jobs: NativeAttachmentHostHooks? = nil) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try Data("baseline sentinel / 文".utf8).write(to: baselineTarget())
        try Data("borrowed sentinel / 文".utf8).write(to: source())
        let baseline: [[String: Any]] = (0..<baselineCount).map { index in
            ["id": index == 0 ? "baseline" : "baseline-\(index)", "kind": "file", "title": "Baseline",
             "uri": index == 0 ? baselineTarget().absoluteString : "", "createdAt": at, "updatedAt": at,
             "localStatus": "available", "cloudKey": "retained-cloud"]
        }
        for id in [taskID, "reference-task"] {
            _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','inbox','[]','[]',?,?,?,1,'fixture')",
                [id, "Saved title", json(id == taskID ? baseline : []), at, at])
        }
        let host = core(faults); if let jobs { try await host.configureAttachmentHost(jobs) }; _ = try await host.start()
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID,
            generation: 1, payloadJSON: try payload(baseline, note: note))
        try await host.checkpointEditorDraft(checkpoint)
        _ = try await host.beginAttachmentDraftV3(expectedSession: checkpoint.sessionID, expectedGeneration: 1)
        return host
    }
    private func addRequest(_ before: EditorDraftSnapshot, id: String = UUID().uuidString.lowercased(),
                            picked: URL? = nil, name: String = "Private.txt") throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": before.sessionID, "generation": before.generation,
            "picked": ["uri": (picked ?? source()).absoluteString, "name": name, "mimeType": "text/plain", "size": 999_999]] as [String: Any])
    }
    private func lastAdd() throws -> Store.Operation {
        guard let last = try record().operations.last, case .add(let op) = last else { throw HostFailure("Fixture Add missing") }
        return op
    }
    private func target(_ op: Store.Operation) throws -> URL { try XCTUnwrap(URL(string: op.targetURI)) }
    private func stage(_ op: Store.Operation) throws -> URL { try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))) }
    private func added(_ host: CoreHost) async throws -> Store.Operation {
        let before = try latest(), request = try addRequest(before)
        let reply = try object(await host.addAttachmentDraftV3(requestJSON: request))
        XCTAssertEqual(Set(reply.keys), Set(["version", "status", "requestId", "sessionID", "generation"]))
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(reply["generation"] as? Int, before.generation + 1)
        return try lastAdd()
    }
    private func remove(_ host: CoreHost, id: String = "baseline") async throws {
        let before = try latest()
        _ = try await host.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation, "attachmentId": id]))
    }
    private func advance(_ host: CoreHost, gap: Int = 7) async throws {
        let before = try latest(); var value = try object(before.payloadJSON)
        let note = "Opaque notes \n \" / e\u{301} / 文"
        var raw = try XCTUnwrap(value["raw"] as? [String: Any]); raw["note"] = note; value["raw"] = raw
        var edits = try XCTUnwrap(value["edited"] as? [String: Any]); edits["description"] = note; value["edited"] = edits
        let snapshot = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: before.generation + gap, payloadJSON: try json(value))
        try await host.checkpointEditorDraft(snapshot)
    }
    private func saveRequest() throws -> String {
        let value = try object(latest().payloadJSON)
        return try json(["id": taskID, "base": value["touchedBase"]!, "patch": value["edited"]!,
            "scheduleBase": ["startTime": NSNull(), "dueDate": NSNull(), "relativeStartOffset": NSNull(), "reviewAt": NSNull()],
            "attachments": ["base": value["attachmentsBase"]!, "value": value["attachments"]!]] as [String: Any])
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected exact retained refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point {
            if let action { try action() } else { throw HostFailure("Private.txt injected") }
        } }; await host.configureAttachmentDraftHost(hooks)
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), next = previous.appendingPathComponent(String(UUID().uuidString.prefix(8)), isDirectory: true)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true); root = next; bundle = originalBundle; return previous
    }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func replaceExact(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), identity = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained-original"))
        try bytes.write(to: url); XCTAssertNotEqual(try inode(url), identity)
    }
    private func probe(_ suffix: String) throws {
        bundle = root.appendingPathComponent("probe-core-host.js")
        try (String(contentsOf: originalBundle, encoding: .utf8) + "\n;(()=>{" + suffix + "})();\n")
            .write(to: bundle, atomically: true, encoding: .utf8)
    }
    private func archivedOwner() throws {
        _ = try sql("INSERT INTO projects(id,title,status,color,createdAt,updatedAt,rev) VALUES ('archived-owner','Archived','archived','#94a3b8',?,?,1)", [at, at])
        _ = try sql("UPDATE tasks SET projectId='archived-owner' WHERE id=?", [taskID])
    }

    func testRealRemoveAdvanceAddRemoveAddSavePreservesOriginalProofsAndUnrelatedCells() async throws {
        let host = try await seed(), originalDomain = try domain()
        let sentinel = managed.appendingPathComponent("unrelated.txt"); try Data("keep unrelated".utf8).write(to: sentinel)
        let borrowed = try Data(contentsOf: source()), baseBytes = try Data(contentsOf: baselineTarget())
        let unrelated = try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='reference-task'").utf8)))
        try await remove(host); try await advance(host)
        let removedAdd = try await added(host), removedPrepared = removedAdd.preparedJSON
        XCTAssertEqual(removedAdd.before.generation, 9)
        XCTAssertEqual(removedAdd.source.size, Int64(borrowed.count))
        XCTAssertEqual(try object(removedPrepared)["measuredSize"] as? Int, borrowed.count)
        try await remove(host, id: removedAdd.requestId)
        let live = try await added(host), beforeSave = try latest()
        guard case .add(let retainedFirstAdd) = try record().operations[1] else { throw HostFailure("First Add missing") }
        XCTAssertEqual(retainedFirstAdd.preparedJSON, removedPrepared)
        let value = try object(beforeSave.payloadJSON)
        XCTAssertEqual((value["attachmentsBase"] as? [[String: Any]])?.first?["cloudKey"] as? String, "retained-cloud")
        XCTAssertEqual(try record().operations.map { $0.checkpointed }, [true, true, true, true])
        XCTAssertEqual(try domain(), originalDomain)
        XCTAssertEqual(try Data(contentsOf: target(removedAdd)), borrowed); XCTAssertEqual(try Data(contentsOf: target(live)), borrowed)
        await host.close(); let cold = core(); _ = try await cold.start()
        let result = try await cold.saveAttachmentDraftMixed(saveRequestJSON: saveRequest(),
            expectedSession: beforeSave.sessionID, expectedGeneration: beforeSave.generation)
        XCTAssertFalse(result.contains("file:///")); XCTAssertNil(try store.readMixed()); XCTAssertNil(try editor.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: baselineTarget().path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: try target(removedAdd).path))
        XCTAssertEqual(try Data(contentsOf: target(live)), borrowed); XCTAssertEqual(try Data(contentsOf: source()), borrowed)
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("keep unrelated".utf8)); XCTAssertEqual(baseBytes, Data("baseline sentinel / 文".utf8))
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='reference-task'").utf8))), unrelated)
        let task = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT attachments,description FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(task["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments.last?["id"] as? String, live.requestId)
        XCTAssertEqual(attachments.last?["createdAt"] as? String, try object(live.preparedJSON)["attachment"].flatMap { ($0 as? [String: Any])?["createdAt"] as? String })
        XCTAssertFalse(removedPrepared.isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLinkEditsBeforeAndBetweenRealFileOperationsSurviveColdSave() async throws {
        let host = try await seed(), originalDomain = try domain()
        let linkID = UUID().uuidString.lowercased()
        var link: [String: Any] = ["id": linkID, "kind": "link", "title": "Link",
            "uri": "https://example.test/first", "createdAt": at, "updatedAt": at]
        func checkpointLink() async throws {
            let before = try latest(); var value = try object(before.payloadJSON)
            var rows = try XCTUnwrap(value["attachments"] as? [[String: Any]])
            rows.removeAll { $0["id"] as? String == linkID }; rows.append(link)
            value["attachments"] = rows
            try await host.checkpointEditorDraft(EditorDraftSnapshot(sessionID: before.sessionID,
                taskID: before.taskID, generation: before.generation + 1, payloadJSON: try json(value)))
        }
        try await checkpointLink()
        let removed = try await added(host)
        link["title"] = "Edited link"; link["uri"] = "https://example.test/edited"
        try await checkpointLink(); try await remove(host, id: removed.requestId)
        let live = try await added(host)
        link["deletedAt"] = at; try await checkpointLink()
        XCTAssertEqual(try domain(), originalDomain)
        let before = try latest(), request = try saveRequest()
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.saveAttachmentDraftMixed(saveRequestJSON: request,
            expectedSession: before.sessionID, expectedGeneration: before.generation)
        let task = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(task["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(try json(XCTUnwrap(rows.first { $0["id"] as? String == linkID })), try json(link))
        XCTAssertFalse(FileManager.default.fileExists(atPath: try target(removed).path))
        XCTAssertEqual(try Data(contentsOf: target(live)), try Data(contentsOf: source()))
        XCTAssertEqual(try Data(contentsOf: baselineTarget()), Data("baseline sentinel / 文".utf8))
        XCTAssertNil(try store.readMixed()); XCTAssertNil(try editor.read())
    }

    func testColdRecoveryAtAllSixPhasesAndLostCheckpointMarkerAcknowledgments() async throws {
        let points: [AttachmentDraftBoundary] = [.afterIntent, .afterStageProof, .beforeFilled, .afterFilled,
            .beforePublication, .afterPublication, .afterPublicationProof, .beforeResult, .afterResult,
            .beforeCheckpoint, .afterCheckpoint, .beforeMarker, .afterMarker]
        for point in points {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(); try await remove(host); try await advance(host)
            let before = try latest(), request = try addRequest(before), rows = try domain()
            await boundary(point, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            let frozen = try lastAdd().preparedJSON
            let beforeInode = try inode(editor.url)
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
            let op = try lastAdd(), reply = try await cold.addAttachmentDraftV3(requestJSON: request)
            XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(op.preparedJSON, frozen)
            XCTAssertEqual(op.before, before); XCTAssertEqual(try latest(), op.after)
            XCTAssertEqual(try object(reply)["generation"] as? Int, before.generation + 1)
            if point == .afterCheckpoint || point == .beforeMarker { XCTAssertNotEqual(try inode(editor.url), beforeInode) }
            XCTAssertEqual(try record().operations.count, 2); XCTAssertEqual(try domain(), rows)
            XCTAssertEqual(try Data(contentsOf: target(op)), try Data(contentsOf: source()))
            await cold.close()
        }
    }

    func testSamePendingRequestResumesWhileUnrelatedPendingRequestAndOldAPIsRefuse() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before)
        await boundary(.afterIntent, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        await refused { _ = try await host.addAttachmentDraftV3(requestJSON: self.addRequest(before)) }
        await refused { _ = try await host.addAttachmentDraft(requestJSON: request) }
        await refused { _ = try await host.recoverAttachmentDraft(expectedSession: before.sessionID) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        let reply = try await host.addAttachmentDraftV3(requestJSON: request)
        XCTAssertEqual(try object(reply)["generation"] as? Int, before.generation + 1)
        XCTAssertEqual(try record().operations.count, 1)
    }

    func testHistoricalReplayAfterRemoveAndOrdinaryGapNeverRewindsOrUsesFileJobs() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before)
        let original = try await host.addAttachmentDraftV3(requestJSON: request), op = try lastAdd()
        try await remove(host, id: op.requestId); try await advance(host)
        let current = try latest(), editorBytes = try Data(contentsOf: editor.url), editorInode = try inode(editor.url)
        await host.close(); let cold = core()
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Replay must not use files"); throw HostFailure("Unexpected replay job") } }
        try await cold.configureAttachmentHost(hooks); _ = try await cold.start()
        let replay = try await cold.addAttachmentDraftV3(requestJSON: request)
        XCTAssertEqual(replay, original); XCTAssertEqual(try latest(), current)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(editor.url), editorInode)
        var changed = try object(request); var picked = try XCTUnwrap(changed["picked"] as? [String: Any]); picked["name"] = "other.txt"; changed["picked"] = picked
        await refused { _ = try await cold.addAttachmentDraftV3(requestJSON: self.json(changed)) }
        let removed = try record().operations.last!
        await refused { _ = try await cold.addAttachmentDraftV3(requestJSON: self.addRequest(current, id: removed.requestId)) }
    }

    func testPendingRemoveAndOrdinaryAdvanceRequireExplicitRecoveryBeforeNewAdd() async throws {
        for advancePending in [false, true] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(); _ = try await added(host)
            if advancePending {
                await boundary(.afterAdvanceIntent, host: host)
                await refused { try await self.advance(host) }
            } else {
                await boundary(.afterIntent, host: host); await refused { try await self.remove(host) }
            }
            let checkpoint = try Data(contentsOf: editor.url), evidence = try Data(contentsOf: store.url)
            await refused { _ = try await host.addAttachmentDraftV3(requestJSON: self.addRequest(self.latest())) }
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), evidence)
            await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
            _ = try await host.recoverAttachmentDraftV3(expectedSession: latest().sessionID)
            _ = try await added(host)
        }
    }

    func testLostReservationProofKeepsUnclaimedNamespaceThroughColdRefusalAndDiscard() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before), rows = try domain()
        await boundary(.afterReservation, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
        let op = try lastAdd(); XCTAssertEqual(op.phase, .intent); XCTAssertNil(op.stage)
        XCTAssertEqual(op.reason, .interruptedReservation)
        let file = managed.appendingPathComponent(".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage")
        let bytes = try Data(contentsOf: file), identity = try inode(file)
        await host.close(); let cold = core(); _ = try await cold.start()
        await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        let discard = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID, "generation": before.generation])
        _ = try await cold.discardAttachmentDraftV3(requestJSON: discard)
        let retained = try record()
        _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: before.sessionID, requestId: XCTUnwrap(retained.discard?.requestId))
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity)
        XCTAssertEqual(try domain(), rows); XCTAssertEqual(try Data(contentsOf: baselineTarget()), Data("baseline sentinel / 文".utf8))
    }

    func testPositiveLostRenameReproofCompletesWithoutBorrowedSource() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before)
        await boundary(.afterPublication, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
        let op = try lastAdd(); XCTAssertEqual(op.phase, .stageFilled)
        let file = try target(op), bytes = try Data(contentsOf: file), identity = try inode(file)
        try FileManager.default.removeItem(at: source())
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertFalse(FileManager.default.fileExists(atPath: source().path))
    }

    func testFilledMissingSourceAndSameContentForeignTargetCannotAuthorizePublication() async throws {
        for foreign in [false, true] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest(), request = try addRequest(before)
            await boundary(.beforePublication, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            let op = try lastAdd(), file = try target(op), stageFile = try stage(op), bytes = try Data(contentsOf: stageFile)
            if foreign { try Data(contentsOf: source()).write(to: file) } else { try FileManager.default.removeItem(at: source()) }
            let targetIdentity = foreign ? try inode(file) : nil
            await host.close(); let cold = core(); _ = try await cold.start()
            await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
            XCTAssertEqual(try latest(), before); XCTAssertEqual(try lastAdd().phase, .stageFilled)
            XCTAssertEqual(try Data(contentsOf: stageFile), bytes)
            if foreign { XCTAssertEqual(try inode(file), targetIdentity); XCTAssertEqual(try Data(contentsOf: file), bytes) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: file.path)) }
            await cold.close()
        }
    }

    func testSourceParentAndCacheReplacementKeepStageAndExactBefore() async throws {
        for mode in ["source", "parent", "cache"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest()
            let folder = cache.appendingPathComponent("picked", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let input = folder.appendingPathComponent("borrowed.txt"), bytes = Data("same borrowed bytes".utf8); try bytes.write(to: input)
            let request = try addRequest(before, picked: input)
            await boundary(.afterStageProof, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            let op = try lastAdd(), stageFile = try stage(op), identity = try inode(stageFile)
            await host.close()
            let moved = mode == "source" ? input : mode == "parent" ? folder : cache
            try FileManager.default.moveItem(at: moved, to: moved.appendingPathExtension("original"))
            if mode != "source" { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
            try bytes.write(to: input)
            let cold = core(); _ = try await cold.start()
            await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
            XCTAssertEqual(try latest(), before); XCTAssertEqual(try lastAdd().phase, .stagePrepared)
            XCTAssertEqual(try inode(stageFile), identity); XCTAssertEqual(try Data(contentsOf: stageFile).count, 0)
            XCTAssertEqual(try Data(contentsOf: input), bytes); await cold.close()
        }
    }

    func testPublishedCompletionStillChecksCurrentPolicyWithoutRegeneratingMetadata() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before)
        await boundary(.afterPublicationProof, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
        let op = try lastAdd(), bytes = try Data(contentsOf: target(op)), rowsBefore = try domain()
        XCTAssertEqual(op.phase, .published); await host.close(); try archivedOwner()
        let rows = try domain(); XCTAssertNotEqual(rows, rowsBefore)
        let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start()
        let producerRows = try domain()
        faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks", "INSERT INTO projects", "UPDATE projects", "DELETE FROM projects"].contains(where: statement.hasPrefix) {
                XCTFail("Producer must not write domain rows"); throw HostFailure("Unexpected producer SQL")
            }
        }
        await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
        XCTAssertEqual(try lastAdd().preparedJSON, op.preparedJSON); XCTAssertEqual(try lastAdd().phase, .published)
        XCTAssertEqual(try latest(), before); XCTAssertEqual(try Data(contentsOf: target(op)), bytes); XCTAssertEqual(try domain(), producerRows)
    }

    func testResultDurableRecoverySkipsCurrentCompletionPolicyAndReacksMatchedAfter() async throws {
        for point in [AttachmentDraftBoundary.afterResult, .afterCheckpoint] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest(), request = try addRequest(before)
            await boundary(point, host: host); await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            let op = try lastAdd(), identity = try inode(editor.url); XCTAssertEqual(op.phase, .resultDurable)
            await host.close(); try archivedOwner()
            try probe("globalThis.MindwtrHost.attachmentDraftResult=()=>{throw new Error('Fresh completion forbidden');};")
            let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start()
            let rows = try domain()
            faults.beforeSQL = { statement in
                if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks", "INSERT INTO projects", "UPDATE projects", "DELETE FROM projects"].contains(where: statement.hasPrefix) {
                    XCTFail("Owed checkpoint must not write domain rows"); throw HostFailure("Unexpected producer SQL")
                }
            }
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
            XCTAssertEqual(try latest(), op.after); XCTAssertNotEqual(try inode(editor.url), identity)
            XCTAssertEqual(try lastAdd().preparedJSON, op.preparedJSON); XCTAssertEqual(try lastAdd().replyJSON, op.replyJSON)
            XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertEqual(try domain(), rows)
            await cold.close()
        }
    }

    func testRawBytesAndReplacementInodesAtHooksRefuseWithoutAdoptingEvidence() async throws {
        for mode in ["editor-inode", "editor-raw", "sidecar-inode", "sidecar-raw"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest(), request = try addRequest(before)
            let file = mode.hasPrefix("editor") ? editor.url : store.url
            var fired = false
            await boundary(.beforeIntent, host: host) {
                fired = true
                if mode.hasSuffix("inode") { try self.replaceExact(file) }
                else { var bytes = try Data(contentsOf: file); bytes.append(0x20); try bytes.write(to: file) }
            }
            await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            XCTAssertTrue(fired); XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), ["baseline.txt"])
            await host.close()
        }
    }

    func testEditorAndSidecarHardlinksRefuseBeforeAnyProducerFileJob() async throws {
        for editorLink in [false, true] {
            let parent = try isolate(); defer { root = parent }
            var configured = false, armed = false, work = 0
            let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in
                configured = true
                jobs.beforeWork = { _, _ in if armed { work += 1; throw HostFailure("Unexpected hardlink job") } }
            }
            let host = try await seed(jobs: hooks), before = try latest(), file = editorLink ? editor.url : store.url
            XCTAssertTrue(configured, "The rejecting worker hook must be installed before startup")
            XCTAssertEqual(link(file.path, file.appendingPathExtension("second-link").path), 0)
            let bytes = try Data(contentsOf: file); armed = true
            await refused { _ = try await host.addAttachmentDraftV3(requestJSON: self.addRequest(before)) }
            armed = false; XCTAssertEqual(work, 0, "Hardlink admission must precede source read")
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try latest(), before); XCTAssertEqual(try record().operations.count, 0)
            await host.close()
        }
    }

    func testPostCheckpointReplacementCannotAcquireMarkerOrCompletionAuthority() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before)
        var fired = false
        await boundary(.afterCheckpoint, host: host) { fired = true; try self.replaceExact(self.editor.url) }
        await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
        XCTAssertTrue(fired); let op = try lastAdd(); XCTAssertEqual(op.phase, .resultDurable)
        XCTAssertEqual(try latest(), op.after)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        XCTAssertEqual(try lastAdd().phase, .checkpointed)
    }

    func testRealAddRemoveDiscardKeepsBaselineBorrowedSourceAndUnrelatedSentinel() async throws {
        let host = try await seed(), rows = try domain(), op = try await added(host)
        let sentinel = managed.appendingPathComponent("unrelated.txt"), bytes = Data("unrelated sentinel".utf8); try bytes.write(to: sentinel)
        try await remove(host, id: op.requestId); try await advance(host)
        let before = try latest(), id = UUID().uuidString.lowercased()
        _ = try await host.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": id,
            "sessionID": before.sessionID, "generation": before.generation]))
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: before.sessionID, requestId: id)
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.readMixed()); XCTAssertEqual(try domain(), rows)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try target(op).path))
        XCTAssertEqual(try Data(contentsOf: source()), Data("borrowed sentinel / 文".utf8))
        XCTAssertEqual(try Data(contentsOf: baselineTarget()), Data("baseline sentinel / 文".utf8))
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
    }

    func testSuccessfulSharedCallsFenceExactEditorAndSidecarAcrossCompletedPoll() async throws {
        for method in ["attachmentDraftValidateLineageV3", "attachmentDraftPrepareV3", "attachmentDraftResult"] {
            for editorFile in [false, true] {
                let parent = try isolate(); defer { root = parent }
                let host = try await seed(), before = try latest(), request = try addRequest(before)
                await host.close()
                try probe("""
                const host=MindwtrHost,method='\(method)',original=host[method],poll=host.poll;
                let ticket=null;
                host[method]=json=>{ticket=original(json);return ticket;};
                host.poll=id=>{const result=poll(id);if(id===ticket&&result!==null){
                  ticket=null;const completed=JSON.parse(result),value=completed.value;
                  if(completed.ok===true&&value&&value.taskID==='mixed-add-task'
                    &&(value.version===3||value.kind==='prepared'||value.kind==='added'))
                    __mindwtrNative.sqlRun('SELECT 264 AS completed_add_probe','[]');
                }return result;};
                """)
                let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start()
                var fired = false
                let file = editorFile ? editor.url : store.url
                let originalIdentity = try inode(file)
                faults.beforeSQL = { statement in
                    if statement == "SELECT 264 AS completed_add_probe" && !fired {
                        fired = true; try self.replaceExact(file)
                    }
                }
                await refused { _ = try await cold.addAttachmentDraftV3(requestJSON: request) }
                XCTAssertTrue(fired); XCTAssertNotEqual(try inode(file), originalIdentity)
                XCTAssertEqual(try latest(), before)
                if method == "attachmentDraftResult" { XCTAssertEqual(try lastAdd().phase, .published) }
                else { XCTAssertEqual(try record().operations.count, 0) }
                await cold.close()
            }
        }
    }

    func testAppearingDomainJournalRefusesBeforeIntentAndBeforeEditorCAS() async throws {
        for point in [AttachmentDraftBoundary.beforeIntent, .beforeCheckpoint] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest(), request = try addRequest(before), rows = try domain()
            let foreign = Data("foreign domain journal".utf8); var fired = false
            await boundary(point, host: host) { fired = true; try foreign.write(to: self.journal) }
            await refused { _ = try await host.addAttachmentDraftV3(requestJSON: request) }
            XCTAssertTrue(fired); XCTAssertEqual(try Data(contentsOf: journal), foreign)
            XCTAssertEqual(try latest(), before); XCTAssertEqual(try domain(), rows)
            if point == .beforeIntent { XCTAssertEqual(try record().operations.count, 0) }
            else { XCTAssertEqual(try lastAdd().phase, .resultDurable) }
            await host.close()
        }
    }

    func testCancellationBeforePublicationRetainsProofAndColdOwnerCompletes() async throws {
        let host = try await seed(), before = try latest(), request = try addRequest(before), rows = try domain()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        await boundary(.beforePublication, host: host) { entered.signal(); _ = release.wait(timeout: .now() + 10) }
        let work = Task { try await host.addAttachmentDraftV3(requestJSON: request) }
        XCTAssertEqual(entered.wait(timeout: .now() + 10), .success)
        work.cancel(); release.signal()
        await refused { _ = try await work.value }
        let op = try lastAdd(); XCTAssertEqual(op.phase, .stageFilled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try target(op).path)); XCTAssertEqual(try latest(), before)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertEqual(try latest(), op.after)
        XCTAssertEqual(try domain(), rows); XCTAssertEqual(try Data(contentsOf: source()), Data("borrowed sentinel / 文".utf8))
    }

    func testSafeGenerationAndStrictPickedRequestRefuseWithoutAnyFileJobs() async throws {
        var configured = false, armed = false, work = 0
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in
            configured = true
            jobs.beforeWork = { _, _ in if armed { work += 1; throw HostFailure("Unexpected strict-admission job") } }
        }
        let host = try await seed(jobs: hooks), before = try latest()
        XCTAssertTrue(configured, "Strict-admission worker hook must be installed before startup")
        var cases: [[String: Any]] = []
        let valid = try object(addRequest(before))
        var value = valid; value["generation"] = true; cases.append(value)
        value = valid; value["version"] = 3; cases.append(value)
        value = valid; value["requestId"] = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"; cases.append(value)
        value = valid; value["sessionID"] = UUID().uuidString.lowercased(); cases.append(value)
        value = valid; var picked = try XCTUnwrap(value["picked"] as? [String: Any]); picked["size"] = true; value["picked"] = picked; cases.append(value)
        value = valid; picked["size"] = NSNull(); picked["name"] = String(repeating: "文", count: 30_000); value["picked"] = picked; cases.append(value)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        armed = true
        for input in cases { await refused { _ = try await host.addAttachmentDraftV3(requestJSON: self.json(input)) } }
        armed = false; XCTAssertEqual(work, 0, "Strict admission must precede source snapshot")
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        let high = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: 9_007_199_254_740_990, payloadJSON: before.payloadJSON)
        try await host.checkpointEditorDraft(high)
        let highRecord = try Data(contentsOf: store.url), highEditor = try Data(contentsOf: editor.url)
        armed = true; await refused { _ = try await host.addAttachmentDraftV3(requestJSON: self.addRequest(high)) }; armed = false
        XCTAssertEqual(work, 0)
        XCTAssertEqual(try Data(contentsOf: store.url), highRecord); XCTAssertEqual(try Data(contentsOf: editor.url), highEditor)
        XCTAssertEqual(try record().operations.count, 0)
    }

    func testEscapedFutureDiscardCapacityRefusesFreshButColdIntentOnlyOwesActualPhase() async throws {
        let host = try await seed(), first = try latest()
        let before = EditorDraftSnapshot(sessionID: first.sessionID, taskID: first.taskID, generation: 2,
            payloadJSON: String(repeating: "\n", count: 950_000) + first.payloadJSON)
        try await host.checkpointEditorDraft(before); await host.close()
        _ = try sql("CREATE TABLE fixture_trace(id INTEGER PRIMARY KEY,label TEXT NOT NULL)")
        try probe("""
        const prepare=MindwtrHost.attachmentDraftPrepareV3,poll=MindwtrHost.poll;let ticket=null;
        MindwtrHost.attachmentDraftPrepareV3=j=>{ticket=prepare(j);return ticket;};
        MindwtrHost.poll=id=>{const result=poll(id);if(id===ticket&&result!==null){ticket=null;
          const completed=JSON.parse(result),value=completed.value;
          if(completed.ok===true&&value&&value.version===1&&value.kind==='prepared'&&value.taskID==='mixed-add-task')
            __mindwtrNative.sqlRun('INSERT INTO fixture_trace(label) VALUES (?)',JSON.stringify([JSON.stringify(value)]));
        }return result;};
        """)
        let fresh = core(); _ = try await fresh.start()
        let request = try addRequest(before), recordBytes = try Data(contentsOf: store.url), editorBytes = try Data(contentsOf: editor.url)
        let identity = try inode(editor.url), entries = try FileManager.default.contentsOfDirectory(atPath: managed.path), rows = try domain()
        var mutation = false
        await boundary(.beforeIntent, host: fresh) { mutation = true }
        await refused { _ = try await fresh.addAttachmentDraftV3(requestJSON: request) }
        XCTAssertFalse(mutation); XCTAssertEqual(try Data(contentsOf: store.url), recordBytes)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(editor.url), identity)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), entries); XCTAssertEqual(try domain(), rows)
        let capturedRows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT label FROM fixture_trace").utf8)) as? [[String: Any]])
        XCTAssertEqual(capturedRows.count, 1)
        let frozenJSON = try XCTUnwrap(capturedRows.first?["label"] as? String), frozen = try object(frozenJSON)
        let files = try NativeAttachmentFiles(libraryRoot: root), proof = try files.snapshotCacheSource(source().absoluteString)
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: taskID, generation: 3,
            payloadJSON: try XCTUnwrap(frozen["afterPayloadJSON"] as? String))
        let op = Store.Operation(requestId: try XCTUnwrap(frozen["requestId"] as? String), requestJSON: request, phase: .intent,
            before: before, after: after, preparedJSON: frozenJSON, targetURI: try XCTUnwrap(frozen["targetURI"] as? String),
            source: .init(sourceURI: proof.sourceURI, sha256: proof.sha256, size: proof.size, identity: proof.identity,
                cacheRootIdentity: proof.cacheRootIdentity, parentIdentity: proof.parentIdentity))
        let intent = Store.MixedRecord(session: .init(sessionID: before.sessionID, taskID: taskID, state: .active, checkpoint: before), operations: [.add(op)])
        let discardID = UUID().uuidString.lowercased(), discardRequest = try json(["version": 1, "requestId": discardID,
            "sessionID": before.sessionID, "generation": before.generation])
        let decided = Store.MixedRecord(session: .init(sessionID: before.sessionID, taskID: taskID, state: .cleanupPending, checkpoint: before),
            operations: intent.operations, discard: .init(requestId: discardID, requestJSON: discardRequest, expected: before, phase: .decided))
        XCTAssertLessThanOrEqual(try encoded(intent).count, Store.maximumBytes)
        XCTAssertGreaterThan(try encoded(decided).count, Store.maximumBytes)
        try store.preflightMixed(intent)
        // A retained exact intent needs its actual owed encodings, independent
        // of today's unused future Discard reservation. Not fresh admission.
        await fresh.close(); _ = try store.writeMixedAcknowledged(intent); bundle = originalBundle
        let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertEqual(try lastAdd().preparedJSON, frozenJSON)
        XCTAssertEqual(try latest(), after); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try Data(contentsOf: target(op)), try Data(contentsOf: source()))
    }

    func testFitting128TotalHistoryAdmitsRealAddAnd129RefusesBeforeFileWork() async throws {
        let previousRoot = try XCTUnwrap(root)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".m264-\(UUID().uuidString.prefix(8))", isDirectory: true)
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw HostFailure("Owned fixture path collision") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        let ownedRoot = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        root = ownedRoot; defer { root = previousRoot }
        addTeardownBlock { try FileManager.default.removeItem(at: ownedRoot) }
        let host = try await seed(baselineCount: 0), template = try await added(host)
        await host.close()
        func compact(_ value: Any) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
        }
        let files = try NativeAttachmentFiles(libraryRoot: root)
        let installer = try NativeAttachmentInstaller(managedRoot: managed, sourceRoots: [cache])
        let sourceProof = NativeAttachmentFiles.CacheSourceProof(sourceURI: template.source.sourceURI, sha256: template.source.sha256,
            size: template.source.size, identity: template.source.identity, cacheRootIdentity: template.source.cacheRootIdentity,
            parentIdentity: template.source.parentIdentity)
        let frozenTemplate = try object(template.preparedJSON)
        var before = EditorDraftSnapshot(sessionID: template.before.sessionID, taskID: taskID, generation: 1,
            payloadJSON: try compact(["version": 2, "taskID": taskID, "attachmentsOwned": true, "attachmentsBase": [], "attachments": [],
                "raw": ["note": "retained 文"]] as [String: Any]))
        var history: [Store.MixedOperation] = []
        // Efficient capacity fixture: one actual V3 metadata template, 64 actual
        // descriptor publications, and one full shared validation at admission.
        for index in 0..<64 {
            let id = index == 0 ? template.requestId : UUID().uuidString.lowercased()
            let uri = managed.appendingPathComponent(id + ".txt").absoluteString
            var attachment = try XCTUnwrap(frozenTemplate["attachment"] as? [String: Any]); attachment["id"] = id; attachment["uri"] = uri
            var prepared = try XCTUnwrap(frozenTemplate["prepared"] as? [String: Any])
            var pickedAttachment = try XCTUnwrap(prepared["attachment"] as? [String: Any]); pickedAttachment["id"] = id; prepared["attachment"] = pickedAttachment
            var value = try object(before.payloadJSON), rows = try XCTUnwrap(value["attachments"] as? [[String: Any]])
            rows.append(attachment); value["attachments"] = rows
            let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: taskID, generation: before.generation + 1, payloadJSON: try compact(value))
            var frozen = frozenTemplate
            frozen["requestId"] = id; frozen["beforePayloadJSON"] = before.payloadJSON; frozen["afterPayloadJSON"] = after.payloadJSON
            frozen["targetURI"] = uri; frozen["attachment"] = attachment; frozen["prepared"] = prepared
            var request = try object(template.requestJSON); request["requestId"] = id; request["generation"] = before.generation
            let reserved: Store.Stage, filled: Store.Filled, published: Store.Published
            if index == 0 {
                reserved = try XCTUnwrap(template.stage); filled = try XCTUnwrap(template.filled); published = try XCTUnwrap(template.published)
                XCTAssertEqual(uri, template.targetURI)
            } else {
                let stage = try installer.prepareStage(targetURI: uri, operationID: id.replacingOccurrences(of: "-", with: ""))
                let content = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: stage)
                _ = try installer.publishStage(stage: stage, targetURI: uri, sha256: content.sha256)
                let proof = try files.verifyPublishedAttachment(targetURI: uri, stageProof: stage, sha256: content.sha256, size: content.size)
                reserved = .init(uri: stage.stageURI, identity: stage.stagedIdentity, directoryIdentity: stage.directoryIdentity,
                    privateDirectoryIdentity: stage.privateDirectoryIdentity)
                filled = .init(sha256: content.sha256, size: content.size, identity: stage.stagedIdentity)
                published = .init(sha256: proof.sha256, size: proof.size, identity: proof.identity, directoryIdentity: proof.directoryIdentity)
            }
            history.append(.add(.init(requestId: id, requestJSON: try json(request), phase: .checkpointed, before: before, after: after,
                preparedJSON: try compact(frozen), targetURI: uri, source: template.source, stage: reserved, filled: filled, published: published,
                replyJSON: try json(["version": 1, "status": "added", "requestId": id, "sessionID": after.sessionID, "generation": after.generation]))))
            if index == 63 { before = after; break }
            let removeID = UUID().uuidString.lowercased()
            rows[rows.count - 1]["deletedAt"] = at; rows[rows.count - 1]["updatedAt"] = at; value["attachments"] = rows
            let removed = EditorDraftSnapshot(sessionID: after.sessionID, taskID: taskID, generation: after.generation + 1, payloadJSON: try compact(value))
            let frozenRemove = try compact(["version": 1, "kind": "prepared-file-remove", "taskID": taskID, "requestId": removeID,
                "attachmentId": id, "removedAt": at, "beforePayloadJSON": after.payloadJSON, "afterPayloadJSON": removed.payloadJSON])
            history.append(.remove(.init(requestId: removeID,
                requestJSON: try json(["version": 1, "requestId": removeID, "sessionID": after.sessionID, "generation": after.generation, "attachmentId": id]),
                phase: .checkpointed, before: after, after: removed, preparedJSON: frozenRemove,
                replyJSON: try json(["version": 1, "status": "draftRemoved", "requestId": removeID, "sessionID": after.sessionID,
                    "generation": removed.generation, "attachmentId": id]))))
            before = removed
        }
        let fixture = Store.MixedRecord(session: .init(sessionID: before.sessionID, taskID: taskID, state: .active, checkpoint: before), operations: history)
        XCTAssertEqual(history.count, 127); _ = try Store.mixedFingerprint(fixture)
        try DurableFile.write(encoded(fixture), to: store.url, privateDraft: true); try editor.checkpoint(before)
        var configured = false, armed = false, work = 0
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in
            configured = true
            jobs.beforeWork = { _, _ in work += 1; if armed { throw HostFailure("Unexpected capacity job") } }
        }
        let fresh = core(); try await fresh.configureAttachmentHost(hooks); _ = try await fresh.start()
        let produced = try await added(fresh)
        XCTAssertTrue(configured); XCTAssertGreaterThan(work, 0, "The admitted128th operation must exercise the real installed worker")
        XCTAssertEqual(try record().operations.count, 128); XCTAssertEqual(produced.before, before)
        XCTAssertEqual(try Data(contentsOf: target(produced)), try Data(contentsOf: source()))
        let admitted = try encoded(record()).count
        XCTAssertLessThanOrEqual(admitted, Store.maximumBytes)
        print("Task264 actual128 producer Foundation bytes=\(admitted), limit=\(Store.maximumBytes)")
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let workBefore = work; armed = true
        await refused { _ = try await fresh.addAttachmentDraftV3(requestJSON: self.addRequest(self.latest())) }
        armed = false; XCTAssertEqual(work, workBefore, "129th operation must refuse before source read")
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        await fresh.close()
    }
}
