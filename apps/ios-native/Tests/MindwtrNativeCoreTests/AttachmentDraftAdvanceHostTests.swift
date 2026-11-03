import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore


final class AttachmentDraftAdvanceHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "owned-checkpoint-task"
    private let at = "2026-10-05T12:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js")
        }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task236-fixtures/\(UUID().uuidString)", isDirectory: true)
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
    private func domain() throws -> String {
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").utf8)) as? [[String: Any]])
        var result: [String: Any] = [:]
        func quoted(_ value: String) -> String { "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String)
            let schema = try XCTUnwrap(table["sql"] as? String)
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
    private func seed(extra: String = "opaque / 文") async throws -> (CoreHost, EditorDraftSnapshot) {
        let boot = core(); _ = try await boot.start(); await boot.close()
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'inbox','[]','[]','[]',?,?,1,'fixture')", [taskID, "Saved title", at, at])
        let host = core(); _ = try await host.start()
        let payload = try json(["version": 2, "taskID": taskID, "attachmentsOwned": true, "attachmentsBase": [], "attachments": [],
                                "title": "Uncommitted title", "unknownEditorField": ["nested": ["retained": extra]]])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        return (host, snapshot)
    }
    private func begin(_ host: CoreHost, _ snapshot: EditorDraftSnapshot) async throws {
        let reply = try object(await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation))
        XCTAssertEqual(reply["version"] as? Int, 2); XCTAssertEqual(reply["status"] as? String, "begun")
    }
    private func source(_ bytes: Data = Data("retained checkpoint source".utf8), name: String = "source.txt") throws -> URL {
        let file = cache.appendingPathComponent(name); try bytes.write(to: file); return file
    }
    private func addRequest(_ snapshot: EditorDraftSnapshot, source: URL, id: String = UUID().uuidString.lowercased()) throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": snapshot.sessionID, "generation": snapshot.generation,
                  "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]])
    }
    private func discardRequest(_ snapshot: EditorDraftSnapshot) throws -> String {
        try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": snapshot.sessionID, "generation": snapshot.generation])
    }
    private func record() throws -> NativeAttachmentDraftStore.Record { try XCTUnwrap(store.read()) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func edited(_ before: EditorDraftSnapshot, generation: Int? = nil, title: String = "Raw later title / 文") throws -> EditorDraftSnapshot {
        var value = try object(before.payloadJSON)
        value["title"] = title
        value["rawTokens"] = ["@ untouched ", "#文", "bad/date"]
        value["scheduleBase"] = ["dueDate": "unparsed raw/no normalization", "startTime": NSNull()]
        value["unknownEditorField"] = ["nested": ["retained": "exact/raw \u{0009} é"]]
        let payload = "\n \t" + (try json(value)) + "\n"
        return .init(sessionID: before.sessionID, taskID: before.taskID, generation: generation ?? before.generation + 3, payloadJSON: payload)
    }
    private func same(_ actual: EditorDraftSnapshot, _ expected: EditorDraftSnapshot, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.sessionID, expected.sessionID, file: file, line: line)
        XCTAssertEqual(actual.taskID, expected.taskID, file: file, line: line)
        XCTAssertEqual(actual.generation, expected.generation, file: file, line: line)
        XCTAssertEqual(Data(actual.payloadJSON.utf8), Data(expected.payloadJSON.utf8), file: file, line: line)
    }
    private func fail(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Operation must refuse and preserve ownership", file: file, line: line) }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
        }
    }
    private func stop(_ boundary: AttachmentDraftBoundary, on host: CoreHost) async {
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == boundary { throw HostFailure("Private.txt injected fault") } }
        await host.configureAttachmentDraftHost(hooks)
    }
    private func clear(_ host: CoreHost) async { await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()) }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root)
        let sub = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
        return previous
    }

    func testTwoAddsSeparatedByOrdinaryAdvancesRetainExactColdHistoryAndDomain() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let databaseBefore = try domain(), input = try source(), bytes = try Data(contentsOf: input)
        let firstRequest = try addRequest(initial, source: input)
        let firstReply = try await host.addAttachmentDraft(requestJSON: firstRequest)
        XCTAssertEqual(try object(firstReply)["version"] as? Int, 1)
        let afterFirst = try latest(), advance = try edited(afterFirst), firstProofs = try encoded(record().operations)
        try await host.checkpointEditorDraft(advance)
        same(try latest(), advance); XCTAssertEqual(try encoded(record().operations), firstProofs)
        let secondRequest = try addRequest(advance, source: input)
        _ = try await host.addAttachmentDraft(requestJSON: secondRequest)
        let afterSecond = try latest(), final = try edited(afterSecond, generation: afterSecond.generation + 5, title: "Final raw title")
        let beforeAdvance = try record(), proofs = try encoded(beforeAdvance.operations)
        let targets = try beforeAdvance.operations.map { try XCTUnwrap(URL(string: $0.targetURI)) }
        let targetBytes = try targets.map { try Data(contentsOf: $0) }
        try await host.checkpointEditorDraft(final)
        same(try latest(), final); same(try record().session.checkpoint, final)
        XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
        let attachments = try XCTUnwrap(object(final.payloadJSON)["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 2)
        XCTAssertEqual(attachments.map { $0["uri"] as? String }, beforeAdvance.operations.map { Optional($0.targetURI) })
        XCTAssertEqual(try domain(), databaseBefore); XCTAssertEqual(try Data(contentsOf: input), bytes)
        for (index, file) in targets.enumerated() { XCTAssertEqual(try Data(contentsOf: file), targetBytes[index]) }
        await host.close(); let cold = core(); _ = try await cold.start()
        try await begin(cold, final)
        let oldReply = try await cold.addAttachmentDraft(requestJSON: firstRequest)
        XCTAssertEqual(oldReply, firstReply); same(try latest(), final)
        _ = try await cold.recoverAttachmentDraft(expectedSession: final.sessionID)
        same(try record().session.checkpoint, final); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try domain(), databaseBefore)
        let discard = try discardRequest(final), discarded = try await cold.discardAttachmentDraft(requestJSON: discard)
        XCTAssertEqual(try object(discarded)["version"] as? Int, 1)
        XCTAssertEqual(try object(discarded)["status"] as? String, "cleanupPending")
        XCTAssertEqual(try record().version, 2); XCTAssertEqual(try record().discard?.phase, .detached)
        same(try XCTUnwrap(record().discard?.expected), final)
        XCTAssertNil(try editor.read()); XCTAssertEqual(try encoded(record().operations), proofs)
        for (index, file) in targets.enumerated() { XCTAssertEqual(try Data(contentsOf: file), targetBytes[index]) }
        XCTAssertEqual(try Data(contentsOf: input), bytes); XCTAssertEqual(try domain(), databaseBefore)
        await cold.close(); let detached = core(); _ = try await detached.start()
        let replayDiscard = try await detached.discardAttachmentDraft(requestJSON: discard)
        XCTAssertEqual(replayDiscard, discarded)
        let summary = try object(await detached.recoverAttachmentDraft(expectedSession: final.sessionID))
        XCTAssertEqual(summary["version"] as? Int, 2); XCTAssertEqual(summary["status"] as? String, "cleanupPending")
    }

    func testNoAddAdvanceExactRetryAndColdBeginPreserveRawBytes() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let before = try domain(), after = try edited(initial, generation: 9)
        try await host.checkpointEditorDraft(after)
        try await host.checkpointEditorDraft(after)
        same(try latest(), after); XCTAssertEqual(try record().operations.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)); XCTAssertEqual(try domain(), before)
        await host.close(); let cold = core(); _ = try await cold.start()
        try await begin(cold, after); try await cold.checkpointEditorDraft(after)
        same(try latest(), after); XCTAssertEqual(try record().version, 2)
        XCTAssertNil(try record().checkpointAdvance)
    }

    func testFixedVersionBeginsNeverMigrateOrAdoptOtherMode() async throws {
        for old in [true, false] {
            let previous = try isolate(); defer { root = previous }
            let (host, initial) = try await seed()
            if old { _ = try await host.beginAttachmentDraft(expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
            else { try await begin(host, initial) }
            let before = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
            if old {
                await fail { try await self.begin(host, initial) }
                await fail { try await host.checkpointEditorDraft(self.edited(initial)) }
            } else {
                await fail { _ = try await host.beginAttachmentDraft(expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
            }
            XCTAssertEqual(try Data(contentsOf: store.url), before); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
            XCTAssertEqual(try record().version, old ? 1 : 2)
            let reply = try await host.addAttachmentDraft(requestJSON: addRequest(initial, source: source()))
            XCTAssertEqual(try object(reply)["version"] as? Int, 1)
            await host.close()
        }
    }

    func testV2BeginRefusesInitialURLDeltaWithoutOwnershipOrFileCreation() async throws {
        let (host, initial) = try await seed()
        var value = try object(initial.payloadJSON)
        value["attachments"] = [["id": "initial-link", "kind": "link", "title": "Unsaved link", "uri": "https://example.test/private", "createdAt": at, "updatedAt": at]]
        let changed = EditorDraftSnapshot(sessionID: initial.sessionID, taskID: taskID, generation: 2, payloadJSON: try json(value))
        try await host.checkpointEditorDraft(changed)
        let before = try Data(contentsOf: editor.url), db = try domain()
        await fail { try await self.begin(host, changed) }
        XCTAssertNil(try store.read()); XCTAssertEqual(try Data(contentsOf: editor.url), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)); XCTAssertEqual(try domain(), db)
    }

    func testAttachmentRemoveReorderMetadataAndBaseChangesRefuseBeforeIntent() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let input = try source()
        _ = try await host.addAttachmentDraft(requestJSON: addRequest(initial, source: input))
        _ = try await host.addAttachmentDraft(requestJSON: addRequest(latest(), source: input))
        let accepted = try latest(), original = try object(accepted.payloadJSON)
        let attachments = try XCTUnwrap(original["attachments"] as? [[String: Any]])
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), db = try domain()
        var variants: [[String: Any]] = []
        var removed = original; removed["attachments"] = Array(attachments.dropLast()); variants.append(removed)
        var reordered = original; reordered["attachments"] = Array(attachments.reversed()); variants.append(reordered)
        var metadata = original, items = attachments; items[0]["title"] = "Changed metadata"; metadata["attachments"] = items; variants.append(metadata)
        var base = original; base["attachmentsBase"] = attachments; variants.append(base)
        var owned = original; owned["attachmentsOwned"] = false; variants.append(owned)
        for value in variants {
            let next = EditorDraftSnapshot(sessionID: accepted.sessionID, taskID: taskID, generation: accepted.generation + 2, payloadJSON: try json(value))
            await fail { try await host.checkpointEditorDraft(next) }
            XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        }
        XCTAssertEqual(try domain(), db); XCTAssertEqual(try record().operations.count, 2)
        let inputBytes = try Data(contentsOf: input)
        for op in try record().operations { XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))), inputBytes) }
    }

    func testStaleSameGenerationWrongSessionTaskAndUnsafeGenerationRefuse() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let accepted = try edited(initial, generation: 7); try await host.checkpointEditorDraft(accepted)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let variants = [initial,
            try edited(accepted, generation: accepted.generation, title: "Different same generation"),
            EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 8, payloadJSON: accepted.payloadJSON),
            EditorDraftSnapshot(sessionID: accepted.sessionID, taskID: "other-task", generation: 8, payloadJSON: accepted.payloadJSON),
            EditorDraftSnapshot(sessionID: accepted.sessionID, taskID: taskID, generation: 0, payloadJSON: accepted.payloadJSON),
            EditorDraftSnapshot(sessionID: accepted.sessionID, taskID: taskID, generation: 9_007_199_254_740_992, payloadJSON: accepted.payloadJSON)]
        for next in variants { await fail { try await host.checkpointEditorDraft(next) } }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        same(try latest(), accepted)
    }

    func testUnicodeEquivalentButDifferentPayloadBytesAreNotExactRetry() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let composed = try edited(initial, generation: 4, title: "é")
        try await host.checkpointEditorDraft(composed)
        let decomposed = try edited(initial, generation: 4, title: "e\u{0301}")
        XCTAssertEqual(composed.payloadJSON, decomposed.payloadJSON)
        XCTAssertNotEqual(Data(composed.payloadJSON.utf8), Data(decomposed.payloadJSON.utf8))
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        await fail { try await host.checkpointEditorDraft(decomposed) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
    }

    func testColdRecoveryAtEveryAdvanceTransitionPreservesProofsFilesAndDomain() async throws {
        let boundaries: [AttachmentDraftBoundary] = [.beforeAdvanceIntent, .afterAdvanceIntent, .beforeAdvanceEditor,
            .afterAdvanceEditor, .beforeAdvanceMarker, .afterAdvanceMarker]
        for boundary in boundaries {
            let previous = try isolate(); defer { root = previous }
            let (host, initial) = try await seed(); try await begin(host, initial)
            let input = try source(); _ = try await host.addAttachmentDraft(requestJSON: addRequest(initial, source: input))
            let before = try latest(), after = try edited(before), proofs = try encoded(record().operations), db = try domain()
            let file = try XCTUnwrap(URL(string: XCTUnwrap(record().operations.last?.targetURI)))
            let bytes = try Data(contentsOf: file)
            await stop(boundary, on: host)
            await fail { try await host.checkpointEditorDraft(after) }
            if boundary == .beforeAdvanceIntent { XCTAssertNil(try record().checkpointAdvance); same(try latest(), before) }
            else if boundary == .afterAdvanceMarker { XCTAssertNil(try record().checkpointAdvance); same(try latest(), after) }
            else { XCTAssertNotNil(try record().checkpointAdvance) }
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID)
            if boundary == .beforeAdvanceIntent { try await cold.checkpointEditorDraft(after) }
            same(try latest(), after); same(try record().session.checkpoint, after)
            XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: input), bytes)
            XCTAssertEqual(try domain(), db)
            await cold.close()
        }
    }

    func testPendingAdvanceExactRetryCompletesBeforeAndAfterEditorWrite() async throws {
        for boundary in [AttachmentDraftBoundary.afterAdvanceIntent, .afterAdvanceEditor] {
            let previous = try isolate(); defer { root = previous }
            let (host, initial) = try await seed(); try await begin(host, initial)
            let after = try edited(initial, generation: 6)
            await stop(boundary, on: host); await fail { try await host.checkpointEditorDraft(after) }
            let pair = try XCTUnwrap(record().checkpointAdvance)
            same(pair.before, initial); same(pair.after, after)
            await host.close(); let cold = core(); _ = try await cold.start()
            try await cold.checkpointEditorDraft(after)
            XCTAssertNil(try record().checkpointAdvance); same(try latest(), after)
            XCTAssertEqual(try record().operations.count, 0)
            await cold.close()
        }
    }

    func testPendingAdvanceDifferentProposalBeginAddAndDiscardCannotReplacePair() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let after = try edited(initial, generation: 5)
        await stop(.afterAdvanceIntent, on: host); await fail { try await host.checkpointEditorDraft(after) }
        await clear(host)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), input = try source()
        await fail { try await host.checkpointEditorDraft(self.edited(initial, generation: 6)) }
        await fail { try await self.begin(host, initial) }
        await fail { _ = try await host.addAttachmentDraft(requestJSON: self.addRequest(initial, source: input)) }
        await fail { _ = try await host.discardAttachmentDraft(requestJSON: self.discardRequest(initial)) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        let summary = try object(await host.readAttachmentDraft())
        XCTAssertEqual(summary["version"] as? Int, 2); XCTAssertEqual(summary["status"] as? String, "checkpointPending")
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        _ = try await host.recoverAttachmentDraft(expectedSession: initial.sessionID)
        same(try latest(), after)
    }

    func testPendingAdvanceColdRecoveryRetainsNewerDifferentMissingAndFrozenEditors() async throws {
        for mode in ["newer", "different", "missing", "attempt"] {
            let previous = try isolate(); defer { root = previous }
            let (host, initial) = try await seed(); try await begin(host, initial)
            let after = try edited(initial, generation: 5)
            await stop(.afterAdvanceIntent, on: host); await fail { try await host.checkpointEditorDraft(after) }
            await host.close()
            if mode == "newer" { try editor.checkpoint(edited(initial, generation: 8)) }
            if mode == "different" { try editor.checkpoint(edited(initial, generation: 5, title: "Foreign same generation")) }
            if mode == "missing" { try editor.discardMatching(expected: initial) }
            if mode == "attempt" { _ = try editor.freeze(sessionID: initial.sessionID, generation: initial.generation, method: "saveDraft", argumentsJSON: "[\"{}\"]") }
            let retained = try Data(contentsOf: store.url)
            let editorBytes = FileManager.default.fileExists(atPath: editor.url.path) ? try Data(contentsOf: editor.url) : nil
            let cold = core(); _ = try await cold.start()
            await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID) }
            await fail { try await cold.checkpointEditorDraft(after) }
            XCTAssertEqual(try Data(contentsOf: store.url), retained)
            if let editorBytes { XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: editor.url.path)) }
            XCTAssertNotNil(try record().checkpointAdvance)
            await cold.close()
        }
    }

    func testNewerEditorInsertedAtMarkerBoundaryPreventsAcknowledgementAndRetainsIntent() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let after = try edited(initial, generation: 5), newer = try edited(initial, generation: 9, title: "Keep newer raw draft")
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == .beforeAdvanceMarker { try self.editor.checkpoint(newer) } }
        await host.configureAttachmentDraftHost(hooks)
        await fail { try await host.checkpointEditorDraft(after) }
        same(try latest(), newer); XCTAssertNotNil(try record().checkpointAdvance)
        same(try record().session.checkpoint, initial)
        await host.close(); let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID) }
        same(try latest(), newer)
    }

    func testPendingAddRefusesAdvanceThenRecoveryUsesFrozenAfterAndAllowsOrdinaryAdvance() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let input = try source(), request = try addRequest(initial, source: input)
        await stop(.afterIntent, on: host); await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        await fail { try await host.checkpointEditorDraft(self.edited(initial)) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID)
        XCTAssertEqual(try record().operations.last?.phase, .checkpointed)
        let after = try edited(latest()); try await cold.checkpointEditorDraft(after)
        same(try latest(), after); XCTAssertEqual(try record().version, 2)
    }

    func testResultDurablePendingAddColdRecoveryAcceptsOnlyRecordedEditorAfter() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let request = try addRequest(initial, source: source())
        await stop(.afterCheckpoint, on: host); await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let after = try latest()
        XCTAssertEqual(try record().operations.last?.phase, .resultDurable); same(try record().session.checkpoint, initial)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID)
        same(try latest(), after); XCTAssertEqual(try record().operations.last?.phase, .checkpointed)
        let advanced = try edited(after); try await cold.checkpointEditorDraft(advanced)
        same(try latest(), advanced)
    }

    func testLostAddAcknowledgementColdUUIDReplayNeverRollsBackLaterAdvance() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let request = try addRequest(initial, source: source())
        await stop(.afterMarker, on: host); await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let reply = try XCTUnwrap(record().operations.last?.replyJSON), after = try latest()
        await clear(host); let advanced = try edited(after, generation: 12)
        try await host.checkpointEditorDraft(advanced)
        let proofs = try encoded(record().operations)
        await host.close(); let cold = core(); _ = try await cold.start()
        let replay = try await cold.addAttachmentDraft(requestJSON: request)
        XCTAssertEqual(replay, reply); same(try latest(), advanced); same(try record().session.checkpoint, advanced)
        XCTAssertEqual(try encoded(record().operations), proofs)
    }

    func testReadOnlyTaskRetainsOrdinaryRawCheckpointButSaveAndNewAddStayGated() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        await host.close()
        _ = try sql("INSERT INTO projects(id,title,status,color,createdAt,updatedAt,rev) VALUES ('archived-owner','Archived','archived','#94a3b8',?,?,1)", [at, at])
        _ = try sql("UPDATE tasks SET projectId='archived-owner' WHERE id=?", [taskID])


        let archived = core(); _ = try await archived.start()
        let view = try object(await archived.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        XCTAssertEqual(view["readOnly"] as? Bool, true)
        let before = try domain(), after = try edited(initial, generation: 5)
        try await archived.checkpointEditorDraft(after); same(try latest(), after)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), input = try source()
        await fail { _ = try await archived.saveEditorDraft("saveDraft", argumentsJSON: "[]", expectedSession: after.sessionID, expectedGeneration: after.generation) }
        await fail { _ = try await archived.addAttachmentDraft(requestJSON: self.addRequest(after, source: input)) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try domain(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        await archived.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: after.sessionID)
        same(try latest(), after)
    }

    func testV2LegacyWriteAdmissionsStillRefuseAndOrdinaryReadsRemainAvailable() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), db = try domain()
        await fail { try await host.discardEditorDraft(expectedSession: initial.sessionID) }
        await fail { try await host.discardCorruptEditorDraft() }
        for method in ["saveDraft", "checklistSave", "boardAction", "taskDelete", "taskPromote"] {
            await fail { _ = try await host.saveEditorDraft(method, argumentsJSON: "[]", expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
        }
        for name in ["draftAddFile", "draftRemove", "settleTaskDraftAttachments"] {
            await fail { _ = try await host.localAttachmentRequest(name: name, requestJSON: "{}") }
        }
        await fail { _ = try await host.call("captureSubmit", argumentsJSON: "[]") }
        let backup = root.appendingPathComponent("source.json"); try Data("{}".utf8).write(to: backup)
        await fail { _ = try await host.prepareBackupImport(backup) }
        _ = try await host.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        _ = try await host.prepareDataBackup()
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try domain(), db); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPendingDomainJournalBlocksAdvanceUntilExistingOrdinaryRecoverySettles() async throws {
        let (host, initial) = try await seed(); await host.close()
        let faults = HostIOFaults(), writing = core(faults); _ = try await writing.start()
        let opened = try object(await writing.call("captureOpen")), captureID = UUID().uuidString.lowercased()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Hold actual domain journal") } }
        await fail { _ = try await writing.call("captureSubmit", argumentsJSON: self.json([self.json(["text": "Pending capture", "options": opened["options"]!, "captureId": captureID, "openAfterSave": false])])) }
        try store.write(.init(version: 2, session: .init(sessionID: initial.sessionID, taskID: taskID, state: .active, checkpoint: initial), operations: []))
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), pending = try Data(contentsOf: journal)
        let after = try edited(initial)
        await fail { try await writing.checkpointEditorDraft(after) }
        await fail { try await self.begin(writing, initial) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try Data(contentsOf: journal), pending)
        await writing.close(); let cold = core(); _ = try await cold.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try await cold.checkpointEditorDraft(after); same(try latest(), after)
    }

    func testCorruptAndUnknownVersionSidecarsRefuseCheckpointWithoutChangingEditor() async throws {
        for unknown in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let (host, initial) = try await seed(); try await begin(host, initial); await host.close()
            if unknown {
                var raw = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self)); raw["version"] = 99
                try Data(json(raw).utf8).write(to: store.url)
            } else { try Data("private corrupt ownership".utf8).write(to: store.url) }
            let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
            let cold = core(); _ = try await cold.start()
            _ = try await cold.call("taskView", argumentsJSON: json([json(["id": taskID])]))
            await fail { try await cold.checkpointEditorDraft(self.edited(initial)) }
            await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID) }
            XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
            await cold.close()
        }
    }

    func testCoherentForgedAcceptedAttachmentListDoesNotAuthorizeAdvanceOrRecovery() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        _ = try await host.addAttachmentDraft(requestJSON: addRequest(initial, source: source()))
        let actual = try latest(), file = try XCTUnwrap(URL(string: XCTUnwrap(record().operations.last?.targetURI))), bytes = try Data(contentsOf: file)
        await host.close()
        var payload = try object(actual.payloadJSON), items = try XCTUnwrap(payload["attachments"] as? [[String: Any]])
        items[0]["uri"] = cache.appendingPathComponent("foreign.txt").absoluteString; payload["attachments"] = items
        let forged = EditorDraftSnapshot(sessionID: actual.sessionID, taskID: taskID, generation: 8, payloadJSON: try json(payload))
        try editor.checkpoint(forged)
        var raw = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self)), session = try XCTUnwrap(raw["session"] as? [String: Any])
        session["checkpoint"] = try object(String(decoding: encoded(forged), as: UTF8.self)); raw["session"] = session
        try Data(json(raw).utf8).write(to: store.url)
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: actual.sessionID) }
        await fail { try await cold.checkpointEditorDraft(self.edited(forged)) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testNoSafeFollowingAdvanceGenerationRefusesAddBeforeReservation() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let accepted = try edited(initial, generation: 9_007_199_254_740_990)
        try await host.checkpointEditorDraft(accepted)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), input = try source()
        await fail { _ = try await host.addAttachmentDraft(requestJSON: self.addRequest(accepted, source: input)) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        let maximum = try edited(accepted, generation: 9_007_199_254_740_991)
        try await host.checkpointEditorDraft(maximum); try await host.checkpointEditorDraft(maximum)
        same(try latest(), maximum)
    }

    func testWholeHistoryCapacityRefusalRetainsPreviousEditorBeforeAnyAdvanceIntent() async throws {
        let (host, initial) = try await seed(extra: String(repeating: "x", count: 250_000)); try await begin(host, initial)
        let input = try source()
        var refused = false
        for _ in 0..<12 {
            let before = try latest(), evidence = try Data(contentsOf: store.url)
            let id = UUID().uuidString.lowercased(), request = try addRequest(before, source: input, id: id)
            do { _ = try await host.addAttachmentDraft(requestJSON: request) }
            catch {
                refused = true
                XCTAssertEqual(try Data(contentsOf: store.url), evidence); same(try latest(), before)
                let candidate = managed.appendingPathComponent(".mindwtr-install-" + id.replacingOccurrences(of: "-", with: "") + ".candidate")
                XCTAssertFalse(FileManager.default.fileExists(atPath: candidate.path)); break
            }
        }
        XCTAssertTrue(refused)
        let accepted = try latest(), padding = 990_000 - accepted.payloadJSON.utf8.count
        XCTAssertGreaterThan(padding, 0)
        let larger = EditorDraftSnapshot(sessionID: accepted.sessionID, taskID: taskID, generation: accepted.generation + 2,
            payloadJSON: String(repeating: "\n", count: max(padding, 0)) + accepted.payloadJSON)
        try editor.preflightCheckpoint(larger)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), proofs = try encoded(record().operations)
        await fail { try await host.checkpointEditorDraft(larger) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try Data(contentsOf: input), Data("retained checkpoint source".utf8))
    }

    func testRawEditorOverLimitRefusesBeforePrivateAdvanceIntent() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let over = EditorDraftSnapshot(sessionID: initial.sessionID, taskID: taskID, generation: 3,
            payloadJSON: String(repeating: " ", count: 1_048_576) + initial.payloadJSON)
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        await fail { try await host.checkpointEditorDraft(over) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertNil(try record().checkpointAdvance)
    }

    func testCheckpointDiagnosticIsEmittedOnlyAfterDurableMarkerAndIsPrivate() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let after = try edited(initial), log = root.appendingPathComponent("logs/mindwtr.log")
        await stop(.beforeAdvanceMarker, on: host); await fail { try await host.checkpointEditorDraft(after) }
        let before = FileManager.default.fileExists(atPath: log.path) ? try String(contentsOf: log) : ""
        XCTAssertFalse(before.contains("\"operation\":\"checkpoint\""))
        await clear(host); _ = try await host.recoverAttachmentDraft(expectedSession: initial.sessionID)
        XCTAssertNil(try record().checkpointAdvance)
        let afterLog = try String(contentsOf: log)
        XCTAssertTrue(afterLog.contains("\"operation\":\"checkpoint\""))
        XCTAssertTrue(afterLog.contains("v1.3.4/ios-attachment-draft-owned"))
        XCTAssertFalse(afterLog.contains(after.payloadJSON)); XCTAssertFalse(afterLog.contains(initial.sessionID))
        XCTAssertFalse(afterLog.contains("Private.txt")); XCTAssertFalse(afterLog.contains("file:///"))
    }

    func testCancelledCallerAndCloseRetainAcceptedAdvanceIntentForColdOwner() async throws {
        let (host, initial) = try await seed(); try await begin(host, initial)
        let after = try edited(initial), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == .afterAdvanceIntent {
            entered.signal(); _ = release.wait(timeout: .now() + 10)
            throw HostFailure("Hold retained advance intent")
        } }
        await host.configureAttachmentDraftHost(hooks)
        let operation = Task { try await host.checkpointEditorDraft(after) }
        XCTAssertEqual(entered.wait(timeout: .now() + 10), .success)
        operation.cancel()
        let closeDone = DispatchSemaphore(value: 0), closing = Task { await host.close(); closeDone.signal() }
        XCTAssertEqual(closeDone.wait(timeout: .now() + 0.03), .timedOut)
        release.signal(); await fail { try await operation.value }; await closing.value
        XCTAssertNotNil(try record().checkpointAdvance); same(try latest(), initial)
        let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: initial.sessionID)
        same(try latest(), after); XCTAssertNil(try record().checkpointAdvance)
    }

    private struct DiscardCapacityFixture {
        let host: CoreHost
        let accepted: NativeAttachmentDraftStore.Record
        let fitting: EditorDraftSnapshot
        let over: EditorDraftSnapshot
        let files: [URL: Data]
        let domain: String
    }
    private func advanceCapacityCandidates(_ record: NativeAttachmentDraftStore.Record,
                                           after: EditorDraftSnapshot) throws -> [NativeAttachmentDraftStore.Record] {
        let pending = NativeAttachmentDraftStore.Record(version: 2, session: record.session,
            operations: record.operations, checkpointAdvance: .init(before: record.session.checkpoint, after: after))
        let settled = NativeAttachmentDraftStore.Record(version: 2,
            session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: .active, checkpoint: after),
            operations: record.operations)
        let id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try json(["version": 1, "requestId": id, "sessionID": after.sessionID, "generation": after.generation])
        let reply = try json(["version": 1, "status": "cleanupPending", "requestId": id, "sessionID": after.sessionID])
        let discards = [NativeAttachmentDraftStore.DiscardPhase.decided, .detached].map { phase in
            NativeAttachmentDraftStore.Record(version: 2,
                session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: .cleanupPending, checkpoint: after),
                operations: record.operations, discard: .init(requestId: id, requestJSON: request, expected: after,
                    phase: phase, replyJSON: phase == .detached ? reply : nil))
        }
        return [pending, settled] + discards
    }
    private func discardCapacityFixture() async throws -> DiscardCapacityFixture {
        let (host, initial) = try await seed(extra: String(repeating: "x", count: 320_000))
        try await begin(host, initial)
        let input = try source()


        for _ in 0..<5 { _ = try await host.addAttachmentDraft(requestJSON: addRequest(latest(), source: input)) }
        let small = try edited(latest(), generation: latest().generation + 7)
        try await host.checkpointEditorDraft(small)
        let accepted = try record()
        func grown(_ padding: Int) -> EditorDraftSnapshot {
            .init(sessionID: small.sessionID, taskID: small.taskID, generation: small.generation + 9,
                payloadJSON: String(repeating: "\n", count: padding) + small.payloadJSON)
        }


        var lower = 0, upper = max(1_000_000 - small.payloadJSON.utf8.count, 0)
        while lower < upper {
            let middle = lower + (upper - lower + 1) / 2
            let detached = try XCTUnwrap(advanceCapacityCandidates(accepted, after: grown(middle)).last)
            if try encoded(detached).count <= NativeAttachmentDraftStore.maximumBytes { lower = middle }
            else { upper = middle - 1 }
        }
        XCTAssertGreaterThan(lower, 0)
        XCTAssertLessThan(lower, 1_000_000 - small.payloadJSON.utf8.count)
        let fitting = grown(lower), over = grown(lower + 1)
        let fit = try advanceCapacityCandidates(accepted, after: fitting), exceed = try advanceCapacityCandidates(accepted, after: over)
        for candidate in fit { XCTAssertLessThanOrEqual(try encoded(candidate).count, NativeAttachmentDraftStore.maximumBytes) }
        for candidate in exceed.prefix(2) { XCTAssertLessThanOrEqual(try encoded(candidate).count, NativeAttachmentDraftStore.maximumBytes) }
        XCTAssertGreaterThan(try encoded(XCTUnwrap(exceed.last)).count, NativeAttachmentDraftStore.maximumBytes)
        try editor.preflightCheckpoint(over)
        var files = [input: try Data(contentsOf: input)]
        for operation in accepted.operations {
            let target = try XCTUnwrap(URL(string: operation.targetURI)); files[target] = try Data(contentsOf: target)
        }
        return .init(host: host, accepted: accepted, fitting: fitting, over: over, files: files, domain: try domain())
    }
    private func discardCapacityMarkers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        let text = FileManager.default.fileExists(atPath: log.path) ? try String(contentsOf: log) : ""
        return text.components(separatedBy: "\"operation\":\"discard-capacity\"").count - 1
    }
    private func preservedCapacityFiles(_ expected: [URL: Data], file: StaticString = #filePath, line: UInt = #line) throws {
        for (url, data) in expected { XCTAssertEqual(try Data(contentsOf: url), data, file: file, line: line) }
    }

    func testFutureDiscardCapacityRefusesNewAdvanceBeforeIntentButFittingAdvanceDiscardsCold() async throws {
        let fixture = try await discardCapacityFixture(), host = fixture.host
        let sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let proofs = try encoded(fixture.accepted.operations), markers = try discardCapacityMarkers()
        XCTAssertGreaterThan(markers, 0)
        var entered = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .beforeAdvanceIntent { entered = true } }
        await host.configureAttachmentDraftHost(hooks)
        await fail { try await host.checkpointEditorDraft(fixture.over) }
        XCTAssertFalse(entered); XCTAssertNil(try record().checkpointAdvance)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        same(try latest(), fixture.accepted.session.checkpoint)
        XCTAssertEqual(try discardCapacityMarkers(), markers); XCTAssertEqual(try domain(), fixture.domain)
        try preservedCapacityFiles(fixture.files)
        await clear(host)
        try await host.checkpointEditorDraft(fixture.fitting)
        same(try latest(), fixture.fitting); same(try record().session.checkpoint, fixture.fitting)
        XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try discardCapacityMarkers(), markers + 1)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertTrue(log.contains("v1.3.5/ios-owned-discard-capacity"))
        XCTAssertFalse(log.contains(fixture.fitting.payloadJSON)); XCTAssertFalse(log.contains("Private.txt")); XCTAssertFalse(log.contains("file:///"))
        await host.close(); let cold = core(); _ = try await cold.start()
        let request = try discardRequest(fixture.fitting), reply = try await cold.discardAttachmentDraft(requestJSON: request)
        XCTAssertEqual(try object(reply)["status"] as? String, "cleanupPending")
        XCTAssertEqual(try record().discard?.phase, .detached); XCTAssertNil(try editor.read())
        same(try XCTUnwrap(record().discard?.expected), fixture.fitting)
        XCTAssertEqual(try encoded(record().operations), proofs); XCTAssertEqual(try domain(), fixture.domain)
        XCTAssertEqual(try discardCapacityMarkers(), markers + 1); try preservedCapacityFiles(fixture.files)
        await cold.close(); let detached = core(); _ = try await detached.start()
        let repeated = try await detached.discardAttachmentDraft(requestJSON: request)
        XCTAssertEqual(Data(repeated.utf8), Data(reply.utf8)); XCTAssertEqual(try discardCapacityMarkers(), markers + 1)
        XCTAssertEqual(try encoded(record().operations), proofs); try preservedCapacityFiles(fixture.files)
    }

    func testOlderPendingAdvanceCompletesExactOwedCheckpointWithoutRetroactiveDiscardBudget() async throws {
        let fixture = try await discardCapacityFixture(), host = fixture.host
        let candidates = try advanceCapacityCandidates(fixture.accepted, after: fixture.over)
        let pending = try XCTUnwrap(candidates.first), proofs = try encoded(fixture.accepted.operations)
        let markers = try discardCapacityMarkers()
        await host.close()


        try store.write(pending)
        same(try latest(), fixture.accepted.session.checkpoint)
        let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: fixture.over.sessionID)
        same(try latest(), fixture.over); same(try record().session.checkpoint, fixture.over)
        XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try discardCapacityMarkers(), markers); XCTAssertEqual(try domain(), fixture.domain)
        try preservedCapacityFiles(fixture.files)


        try await cold.checkpointEditorDraft(fixture.over)
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let later = EditorDraftSnapshot(sessionID: fixture.over.sessionID, taskID: fixture.over.taskID,
            generation: fixture.over.generation + 1, payloadJSON: fixture.over.payloadJSON)
        await fail { try await cold.checkpointEditorDraft(later) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try discardCapacityMarkers(), markers); XCTAssertEqual(try domain(), fixture.domain)
        try preservedCapacityFiles(fixture.files)
        await cold.close(); let restarted = core(); _ = try await restarted.start()
        _ = try await restarted.recoverAttachmentDraft(expectedSession: fixture.over.sessionID)
        same(try latest(), fixture.over); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try discardCapacityMarkers(), markers); try preservedCapacityFiles(fixture.files)
    }
}
