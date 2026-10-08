import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC, SQLite and native descriptor retirement. V3 Add records
/// below are explicitly seeded from real V2 jobs, not AddV3 producer acceptance.
final class AttachmentMixedDiscardHostTests: XCTestCase {
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
    private let taskID = "mixed-discard-task"
    private let at = "2026-10-05T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task262/\(UUID().uuidString.prefix(8))", isDirectory: true)
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
    private func seed(adds: Int = 0, stopAdd: AttachmentDraftBoundary? = nil, empty: Bool = false,
                      faults: HostIOFaults = HostIOFaults(), jobs: NativeAttachmentHostHooks? = nil) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try Data("baseline sentinel / 文".utf8).write(to: baselineTarget())
        try Data("borrowed sentinel / 文".utf8).write(to: source())
        let baseline: [[String: Any]] = empty ? [] : [["id": "baseline", "kind": "file", "title": "Baseline",
            "uri": baselineTarget().absoluteString, "createdAt": at, "updatedAt": at, "localStatus": "available", "cloudKey": "retained-cloud"]]
        for id in [taskID, "reference-task"] {
            _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','inbox','[]','[]',?,?,?,1,'fixture')",
                [id, "Saved title", json(id == taskID ? baseline : []), at, at])
        }
        let host = core(faults); if let jobs { try await host.configureAttachmentHost(jobs) }; _ = try await host.start()
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: try payload(baseline))
        try await host.checkpointEditorDraft(snapshot)
        if adds > 0 || stopAdd != nil {
            _ = try await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: 1)
            for _ in 0..<adds { _ = try await host.addAttachmentDraft(requestJSON: addRequest(latest())) }
            if let stopAdd {
                await boundary(stopAdd, host: host)
                await refused { _ = try await host.addAttachmentDraft(requestJSON: self.addRequest(self.latest())) }
                await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
            }
            let legacy = try XCTUnwrap(store.read())
            let mixed = Store.MixedRecord(session: legacy.session, operations: legacy.operations.map { .add($0) })
            _ = try Store.mixedFingerprint(mixed)
            try DurableFile.write(JSONEncoder().encode(mixed), to: store.url, privateDraft: true)
            // This is already a retained validated mixed fixture. New BeginV3
            // intentionally does not admit an interrupted Add producer.
            return host
        }
        let current = try latest()
        _ = try await host.beginAttachmentDraftV3(expectedSession: current.sessionID, expectedGeneration: current.generation)
        return host
    }
    private func addRequest(_ before: EditorDraftSnapshot) throws -> String {
        try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
            "generation": before.generation, "picked": ["uri": source().absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
    }
    private func remove(_ host: CoreHost, id: String = "baseline") async throws {
        let before = try latest()
        _ = try await host.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation, "attachmentId": id]))
    }
    private func discardRequest(_ snapshot: EditorDraftSnapshot, id: String = UUID().uuidString.lowercased()) throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": snapshot.sessionID, "generation": snapshot.generation])
    }
    private func detach(_ host: CoreHost) async throws -> Store.MixedRecord {
        let result = try object(await host.discardAttachmentDraftV3(requestJSON: discardRequest(latest())))
        XCTAssertEqual(result["status"] as? String, "cleanupPending"); XCTAssertNil(try editor.read())
        return try record()
    }
    private func finish(_ host: CoreHost, _ value: Store.MixedRecord) async throws -> String {
        try await host.finishAttachmentDraftDiscardV3(expectedSession: value.session.sessionID, requestId: XCTUnwrap(value.discard?.requestId))
    }
    private func outcomes(_ value: String, _ record: Store.MixedRecord) throws -> [[String: Any]] {
        let result = try object(value)
        XCTAssertEqual(Set(result.keys), Set(["version", "historyVersion", "status", "sessionID", "requestId", "operations"]))
        XCTAssertEqual(result["version"] as? Int, 5); XCTAssertEqual(result["historyVersion"] as? Int, 3)
        XCTAssertEqual(result["status"] as? String, "discarded"); XCTAssertEqual(result["sessionID"] as? String, record.session.sessionID)
        XCTAssertEqual(result["requestId"] as? String, record.discard?.requestId)
        let operations = try XCTUnwrap(result["operations"] as? [[String: Any]])
        XCTAssertEqual(operations.compactMap { $0["requestId"] as? String }, record.operations.map(\.requestId))
        XCTAssertLessThanOrEqual(value.utf8.count, 64 * 1024); XCTAssertFalse(value.contains("file:///")); XCTAssertFalse(value.contains("Private.txt"))
        return operations
    }
    private func released(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertNil(try editor.read(), file: file, line: line); XCTAssertNil(try store.readMixed(), file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected exact retained evidence", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line); XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point { if let action { try action() } else { throw HostFailure("Private.txt injected") } } }
        await host.configureAttachmentDraftHost(hooks)
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
        let bytes = try Data(contentsOf: url), previous = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained-original"))
        try bytes.write(to: url); XCTAssertNotEqual(try inode(url), previous)
    }
    private func journalObject() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)) }
    private func terminal() throws -> String {
        try XCTUnwrap(((journalObject()["terminal"] as? [String: Any])?["success"] as? [String: Any])?["_0"] as? String)
    }
    private func noWrites() -> HostIOFaults {
        let faults = HostIOFaults(); faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks", "INSERT INTO projects", "UPDATE projects", "DELETE FROM projects"].contains(where: statement.hasPrefix) {
                XCTFail("Discard must not write domain owners"); throw HostFailure("Unexpected domain write")
            }
        }; return faults
    }
    private func noJobs() -> NativeAttachmentHostHooks {
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Logical/terminal replay must have zero jobs"); throw HostFailure("Unexpected job") } }; return hooks
    }
    private func probe(_ suffix: String) throws {
        bundle = root.appendingPathComponent("probe-core-host.js")
        try (String(contentsOf: originalBundle, encoding: .utf8) + "\n;(()=>{" + suffix + "})();\n").write(to: bundle, atomically: true, encoding: .utf8)
    }

    func testEmptyAndBaselineRemoveOnlyReleaseWithoutFileOrDomainMutation() async throws {
        for empty in [false, true] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(empty: empty, jobs: noJobs())
            if !empty { try await remove(host) }
            let rows = try domain(), bytes = try Data(contentsOf: baselineTarget()), identity = try inode(baselineTarget())
            let retained = try await detach(host)
            let result = try outcomes(await finish(host, retained), retained)
            XCTAssertEqual(result.count, empty ? 0 : 1)
            if !empty { XCTAssertEqual(result[0]["disposition"] as? String, "metadataOnly"); XCTAssertNil(result[0]["target"]) }
            try released(); XCTAssertEqual(try domain(), rows); XCTAssertEqual(try Data(contentsOf: baselineTarget()), bytes)
            XCTAssertEqual(try inode(baselineTarget()), identity); await host.close()
        }
    }
    func testRetainedDecidedIsReacknowledgedBeforeDetachingEditor() async throws {
        let host = try await seed(), before = try latest(), raw = try discardRequest(before)
        await boundary(.afterDiscardDecision, host: host)
        await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: raw) }
        XCTAssertEqual(try record().discard?.phase, .decided)
        let priorInode = try inode(store.url), editorBytes = try Data(contentsOf: editor.url)
        var reached = false
        await boundary(.afterDiscardDecision, host: host) {
            reached = true; XCTAssertNotEqual(try self.inode(self.store.url), priorInode)
            XCTAssertEqual(try Data(contentsOf: self.editor.url), editorBytes)
            throw HostFailure("Stop after reacknowledged decision")
        }
        await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: raw) }
        XCTAssertTrue(reached); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        _ = try await host.discardAttachmentDraftV3(requestJSON: raw); let retained = try record()
        _ = try await finish(host, retained); try released()
    }
    func testPendingRemoveColdDetachPreservesExactFrozenIntent() async throws {
        let host = try await seed(), before = try latest()
        await boundary(.afterIntent, host: host)
        await refused { try await self.remove(host) }
        let proof = try encoded(record().operations), rows = try domain(), raw = try discardRequest(before)
        await boundary(.afterDetach, host: host)
        await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: raw) }
        XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.phase, .decided)
        XCTAssertEqual(try encoded(record().operations), proof)
        await host.close(); let cold = core(noWrites()); _ = try await cold.start()
        _ = try await cold.discardAttachmentDraftV3(requestJSON: raw); let retained = try record()
        XCTAssertEqual(try encoded(retained.operations), proof)
        let result = try outcomes(await finish(cold, retained), retained)
        XCTAssertEqual(result.first?["disposition"] as? String, "metadataOnly"); try released(); XCTAssertEqual(try domain(), rows)
    }
    func testFreshPendingRemoveRefusesAfterMissingForeignFrozenAndAdvanceEditors() async throws {
        for mode in ["after", "missing", "foreign", "frozen", "advance"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(), before = try latest()
            if mode == "advance" {
                try await remove(host); let checkpoint = try latest()
                await boundary(.afterAdvanceIntent, host: host)
                await refused { try await host.checkpointEditorDraft(.init(sessionID: checkpoint.sessionID, taskID: checkpoint.taskID,
                    generation: checkpoint.generation + 3, payloadJSON: checkpoint.payloadJSON)) }
            } else {
                await boundary(mode == "after" ? .afterCheckpoint : .afterIntent, host: host)
                await refused { try await self.remove(host) }
            }
            await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
            if mode == "missing" { try FileManager.default.removeItem(at: editor.url) }
            if mode == "foreign" {
                let foreign = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: before.taskID, generation: 1, payloadJSON: before.payloadJSON)
                struct Stored: Encodable { let snapshot: EditorDraftSnapshot }
                try DurableFile.write(encoded(Stored(snapshot: foreign)), to: editor.url, privateDraft: true)
                XCTAssertEqual(try editor.read()?.snapshot.sessionID, foreign.sessionID)
            }
            if mode == "frozen" { _ = try editor.freeze(sessionID: before.sessionID, generation: before.generation,
                method: "saveDraft", argumentsJSON: json([json(["id": taskID, "base": [:], "patch": [:]])])) }
            let sidecar = try Data(contentsOf: store.url), checkpoint = try? Data(contentsOf: editor.url), rows = try domain()
            await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: self.discardRequest(self.record().session.checkpoint)) }
            XCTAssertNil(try record().discard); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            XCTAssertEqual(try? Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try domain(), rows)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await host.close()
        }
    }
    func testMixedAddsRemovesOrdinaryNotesAndTrailingRemoveCleanOnlyActualAdds() async throws {
        let host = try await seed(adds: 2), adds = NativeAttachmentDraftCoordinator.mixedSaveAdds(try record())
        try await remove(host, id: XCTUnwrap(adds.first?.requestId))
        let before = try latest(); var value = try object(before.payloadJSON)
        var raw = try XCTUnwrap(value["raw"] as? [String: Any]), edited = try XCTUnwrap(value["edited"] as? [String: Any])
        raw["note"] = "Later ordinary notes / 文"; edited["description"] = raw["note"]; value["raw"] = raw; value["edited"] = edited
        try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 7, payloadJSON: json(value)))
        try await remove(host)
        let retained = try await detach(host), rows = try domain(), baselineBytes = try Data(contentsOf: baselineTarget())
        let baselineInode = try inode(baselineTarget()), sourceBytes = try Data(contentsOf: source())
        let result = try outcomes(await finish(host, retained), retained)
        XCTAssertEqual(result.map { $0["kind"] as? String }, ["add", "add", "remove", "remove"])
        XCTAssertEqual(result.prefix(2).map { $0["target"] as? String }, ["removed", "removed"])
        for add in adds { XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: add.targetURI)).path)) }
        XCTAssertEqual(try Data(contentsOf: baselineTarget()), baselineBytes); XCTAssertEqual(try inode(baselineTarget()), baselineInode)
        XCTAssertEqual(try Data(contentsOf: source()), sourceBytes); XCTAssertEqual(try domain(), rows); try released()
    }
    func testPendingAddPhaseOutcomesAndFilledPublicationRecoveryStaySeparateFromRemove() async throws {
        for point in [AttachmentDraftBoundary.afterIntent, .afterStageProof, .afterFilled, .afterPublication, .afterPublicationProof, .afterResult] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(stopAdd: point), add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
            let target = try XCTUnwrap(URL(string: add.targetURI)), sourceBytes = try Data(contentsOf: source())
            var foreign: Data?, unknown: URL?, unknownInode: String?
            if [.afterIntent, .afterStageProof, .afterFilled].contains(point) {
                foreign = Data("foreign same target remains / 文".utf8); try XCTUnwrap(foreign).write(to: target)
            }
            if point == .afterIntent {
                let namespace = managed.appendingPathComponent(".mindwtr-install-" + add.requestId.replacingOccurrences(of: "-", with: "") + ".candidate", isDirectory: true)
                try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: true)
                try Data("unclaimed".utf8).write(to: namespace.appendingPathComponent("foreign"))
                unknown = namespace; unknownInode = try inode(namespace)
            }
            let retained = try await detach(host)
            let stageOnly = [.afterIntent, .afterStageProof, .afterFilled].contains(point)
            var current = host, workCount = 0
            if stageOnly {
                await host.close()
                try probe("const f=MindwtrHost.attachmentDraftDiscardRetire;MindwtrHost.attachmentDraftDiscardRetire=(j,k,r)=>{if(JSON.parse(j).requestId==='\(add.requestId)')throw Error('No last public query');return f(j,k,r);};")
                let jobs = NativeAttachmentHostHooks(); jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in workCount += 1 } }
                current = core(); try await current.configureAttachmentHost(jobs); _ = try await current.start()
            }
            let result = try outcomes(await finish(current, retained), retained), last = try XCTUnwrap(result.last)
            XCTAssertEqual(last["target"] as? String, stageOnly ? "untouched" : "removed")
            XCTAssertEqual(last["stage"] as? String, point == .afterIntent ? "unclaimed" : stageOnly ? "removed" : "missing")
            if stageOnly { XCTAssertEqual(workCount, point == .afterIntent ? 0 : point == .afterStageProof ? 1 : 2) }
            if let foreign { XCTAssertEqual(try Data(contentsOf: target), foreign) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)) }
            if let unknown {
                XCTAssertEqual(try inode(unknown), unknownInode)
                XCTAssertEqual(try Data(contentsOf: unknown.appendingPathComponent("foreign")), Data("unclaimed".utf8))
            }
            XCTAssertEqual(try Data(contentsOf: source()), sourceBytes); try released(); await current.close()
        }
    }
    func testColdPendingTerminalReleaseAndClearBoundariesNeverRewriteDomain() async throws {
        for point in [AttachmentDraftBoundary.afterDiscardFinishJournal, .afterDiscardTarget(0), .afterDiscardStage(0),
                      .afterDiscardTerminal, .afterDiscardRelease, .beforeDiscardJournalClear] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(adds: 1); try await remove(host)
            let retained = try await detach(host), rows = try domain(), baseline = try Data(contentsOf: baselineTarget())
            await boundary(point, host: host); await refused { _ = try await self.finish(host, retained) }
            let completed = try journalObject()["terminal"] != nil
            await host.close()
            if completed { try probe("MindwtrHost.attachmentDraftDiscardCandidatesV3=()=>{throw Error('No terminal candidate replay')};MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('No terminal refs')};") }
            let cold = core(noWrites()); if completed { try await cold.configureAttachmentHost(noJobs()) }
            _ = try await cold.start(); try released(); XCTAssertEqual(try domain(), rows); XCTAssertEqual(try Data(contentsOf: baselineTarget()), baseline)
            await cold.close()
        }
    }
    func testLostJournalClearAcknowledgmentWarmTerminalRetryHasZeroFileJobs() async throws {
        let jobs = NativeAttachmentHostHooks(); var forbidJobs = false
        jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in if forbidJobs { XCTFail("Warm terminal retry must not start jobs"); throw HostFailure("Unexpected job") } } }
        let host = try await seed(adds: 1, jobs: jobs), retained = try await detach(host)
        await boundary(.afterDiscardJournalClear, host: host)
        await refused { _ = try await self.finish(host, retained) }
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.readMixed()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()); forbidJobs = true
        let rows = try domain()
        _ = try await host.retryPending(); try released(); XCTAssertEqual(try domain(), rows)
    }
    func testNonterminalRetryRechecksCurrentTaskReference() async throws {
        let host = try await seed(adds: 1), retained = try await detach(host)
        let add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(retained).first), target = try XCTUnwrap(URL(string: add.targetURI))
        let metadata = try XCTUnwrap(object(add.preparedJSON)["attachment"] as? [String: Any])
        await boundary(.afterDiscardFinishJournal, host: host); await refused { _ = try await self.finish(host, retained) }; await host.close()
        _ = try sql("UPDATE tasks SET attachments=? WHERE id='reference-task'", [json([metadata])])
        let bytes = try Data(contentsOf: target), rows = try domain(), cold = core(noWrites())
        _ = try await cold.start(); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try domain(), rows); try released()
    }
    func testExactRawAndInodeReplacementAtDecisionAndJournalRefuseWithoutAdoption() async throws {
        for mode in ["decision-editor", "decision-record", "raw-record", "journal"] {
            let parent = try isolate(); defer { root = parent }
            let host = try await seed(adds: 1), before = try latest()
            let add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).first)
            let target = try XCTUnwrap(URL(string: add.targetURI)), targetBytes = try Data(contentsOf: target), sourceBytes = try Data(contentsOf: source())
            if mode == "journal" {
                let retained = try await detach(host)
                await boundary(.beforeDiscardTarget(0), host: host) { try self.replaceExact(self.journal) }
                await refused { _ = try await self.finish(host, retained) }
                XCTAssertNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.readMixed())
            } else {
                await boundary(.beforeDiscardDecision, host: host) {
                    if mode == "decision-editor" { try self.replaceExact(self.editor.url) }
                    else if mode == "decision-record" { try self.replaceExact(self.store.url) }
                    else { var bytes = try Data(contentsOf: self.store.url); bytes.append(Data(" \n".utf8)); try bytes.write(to: self.store.url) }
                }
                await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: self.discardRequest(before)) }
                XCTAssertNil(try record().discard); XCTAssertNotNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
            XCTAssertEqual(try Data(contentsOf: target), targetBytes); XCTAssertEqual(try Data(contentsOf: source()), sourceBytes)
            XCTAssertTrue(FileManager.default.fileExists(atPath: baselineTarget().path)); await host.close()
        }
    }
    func testMalformedCallbacksRetainPendingAndColdProofRetryCompletes() async throws {
        for body in ["return JSON.stringify({outcome:'removed'});", "const value=f(j,k,r);k();return value;", "f(j,k,r);return JSON.stringify({outcome:'referenced'});"] {
            let parent = try isolate(); defer { root = parent }
            try probe("const f=MindwtrHost.attachmentDraftDiscardRetire;MindwtrHost.attachmentDraftDiscardRetire=(j,k,r)=>{" + body + "};")
            let host = try await seed(adds: 1), retained = try await detach(host)
            await refused { _ = try await self.finish(host, retained) }
            XCTAssertNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.readMixed())
            await host.close(); bundle = originalBundle; let cold = core(noWrites()); _ = try await cold.start(); try released(); await cold.close()
        }
    }
    func testActualJSCMicrotasksRunAfterSynchronousNativeRetirement() async throws {
        try probe("""
        const f=MindwtrHost.attachmentDraftDiscardRetire;
        const trace=label=>__mindwtrNative.sqlRun('INSERT INTO fixture_trace(label) VALUES (?)',JSON.stringify([label]));
        MindwtrHost.attachmentDraftDiscardRetire=(j,k,r)=>{
          Promise.resolve().then(()=>trace('microtask'));
          return f(j,()=>k(),()=>{trace('callback-before');const value=r();trace('callback-after');return value;});
        };
        """)
        let jobs = NativeAttachmentHostHooks(); jobs.configureJobs = { jobs in jobs.afterRetirementUnlink = { _ = try self.sql("INSERT INTO fixture_trace(label) VALUES ('native-unlink')") } }
        let host = try await seed(adds: 1, jobs: jobs), retained = try await detach(host)
        _ = try sql("CREATE TABLE fixture_trace(id INTEGER PRIMARY KEY,label TEXT NOT NULL)")
        _ = try await finish(host, retained)
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT label FROM fixture_trace ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["label"] as? String }, ["callback-before", "native-unlink", "callback-after", "microtask"]); try released()
    }

    func testVersion5GrammarIsSealedBeforeSQLiteIncluding129Entries() async throws {
        let host = try await seed(adds: 1); try await remove(host)
        let retained = try await detach(host)
        await boundary(.afterDiscardTerminal, host: host); await refused { _ = try await self.finish(host, retained) }
        let original = try Data(contentsOf: journal), sidecar = try Data(contentsOf: store.url), result = try object(terminal())
        await host.close()
        for mode in ["legacy", "history", "middle", "remove-target", "add-unclaimed", "rejected", "extra", "129"] {
            var command = try object(String(decoding: original, as: UTF8.self))
            let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
            var wrapper = try object(XCTUnwrap(args.first)), terminalResult = result
            var descriptors = try XCTUnwrap(wrapper["operations"] as? [[String: Any]])
            var completed = try XCTUnwrap(terminalResult["operations"] as? [[String: Any]])
            switch mode {
            case "legacy": wrapper["version"] = 1
            case "history": wrapper["historyVersion"] = 2
            case "middle": descriptors[0]["phase"] = "intent"; wrapper["operations"] = descriptors
            case "remove-target": completed[1]["target"] = "removed"; terminalResult["operations"] = completed
            case "add-unclaimed": completed[0]["stage"] = "unclaimed"; terminalResult["operations"] = completed
            case "extra": wrapper["unexpected"] = true
            case "129":
                while descriptors.count < 129 { descriptors.append(["kind": "remove", "requestId": UUID().uuidString.lowercased(), "phase": "checkpointed"]) }
                wrapper["operations"] = descriptors
            default: break
            }
            command["argumentsJSON"] = try json([json(wrapper)])
            command["terminal"] = mode == "rejected" ? ["rejected": ["_0": "INVALID_INPUT"]] : ["success": ["_0": try json(terminalResult)]]
            let bytes = Data(try json(command).utf8); try bytes.write(to: journal)
            let faults = HostIOFaults(); var sqlCalls = 0; faults.beforeSQL = { _ in sqlCalls += 1 }
            let cold = core(faults); await refused { _ = try await cold.start() }
            XCTAssertEqual(sqlCalls, 0, mode); XCTAssertEqual(try Data(contentsOf: journal), bytes, mode)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar, mode); XCTAssertNil(try editor.read()); await cold.close()
        }
        try DurableFile.write(original, to: journal, privateDraft: true)
        let cold = core(noWrites()); try await cold.configureAttachmentHost(noJobs()); _ = try await cold.start(); try released()
    }

    func testCancellationAtDurableTerminalRetainsDecisionAndColdRetryHasNoJobs() async throws {
        let host = try await seed(adds: 1), retained = try await detach(host), rows = try domain()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        await boundary(.beforeDiscardRelease, host: host) { entered.signal(); _ = release.wait(timeout: .now() + 10) }
        let work = Task { try await self.finish(host, retained) }
        let reached = await Task.detached { entered.wait(timeout: .now() + 10) == .success }.value
        XCTAssertTrue(reached); work.cancel(); release.signal(); await refused { _ = try await work.value }
        XCTAssertNotNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.readMixed()); XCTAssertNil(try editor.read())
        await host.close(); let cold = core(noWrites()); try await cold.configureAttachmentHost(noJobs())
        _ = try await cold.start(); try released(); XCTAssertEqual(try domain(), rows)
    }

    func testWarmPendingAndTerminalWriteFailureRetryOnlyOwedWork() async throws {
        for terminalWrite in [false, true] {
            let parent = try isolate(); defer { root = parent }
            let faults = HostIOFaults(), jobs = NativeAttachmentHostHooks(); var forbidJobs = false
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in if forbidJobs { XCTFail("Known terminal retry must not work files"); throw HostFailure("Unexpected job") } } }
            let host = try await seed(adds: 1, faults: faults, jobs: jobs), retained = try await detach(host)
            var writes = 0
            faults.journalWrite = { writes += 1; if writes == (terminalWrite ? 2 : 1) { throw HostFailure("Journal acknowledgment unavailable") } }
            await refused { _ = try await self.finish(host, retained) }
            XCTAssertEqual(writes, terminalWrite ? 2 : 1); XCTAssertNotNil(try store.readMixed()); XCTAssertNil(try editor.read())
            forbidJobs = terminalWrite; faults.journalWrite = nil
            let pendingResult = try await host.retryPending()
            let retried = try XCTUnwrap(pendingResult), result = try outcomes(retried, retained)
            XCTAssertEqual(result.first?["target"] as? String, "removed"); try released(); await host.close()
        }
    }

    func testFilledObservationAndPublicationBothFailRetainsBeforeJournal() async throws {
        let host = try await seed(stopAdd: .afterFilled), add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(add.stage?.uri))), target = try XCTUnwrap(URL(string: add.targetURI))
        let stageBytes = Data("conflicting filled stage".utf8), targetBytes = Data("foreign target generation".utf8)
        try stageBytes.write(to: stage); try targetBytes.write(to: target)
        let retained = try await detach(host), bytes = try Data(contentsOf: store.url)
        var reachedJournal = false
        await boundary(.beforeDiscardFinishJournal, host: host) { reachedJournal = true }
        await refused { _ = try await self.finish(host, retained) }
        XCTAssertFalse(reachedJournal); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try Data(contentsOf: stage), stageBytes)
        XCTAssertEqual(try Data(contentsOf: target), targetBytes)
    }

    func testFilledPublicationPromotionIsAcknowledgedBeforeColdPublishedRetry() async throws {
        let host = try await seed(stopAdd: .afterPublication), original = try record()
        let add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(original).last), target = try XCTUnwrap(URL(string: add.targetURI))
        let identity = try inode(target), retained = try await detach(host)
        await boundary(.afterDiscardPublicationPromotion, host: host)
        await refused { _ = try await self.finish(host, retained) }
        let promoted = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        XCTAssertEqual(promoted.phase, .published); XCTAssertEqual(promoted.published?.identity, identity)
        XCTAssertEqual(promoted.preparedJSON, add.preparedJSON); XCTAssertEqual(promoted.before, add.before); XCTAssertEqual(promoted.after, add.after)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await host.close(); let cold = core(noWrites()); _ = try await cold.start()
        _ = try await finish(cold, record()); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); try released()
    }

    func testPersistedStageFilledPhaseDoesNotReobserveOrQueryTargetAfterStageRemoval() async throws {
        let host = try await seed(stopAdd: .afterFilled), add = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).last)
        let target = try XCTUnwrap(URL(string: add.targetURI)), foreign = Data("foreign public sentinel".utf8)
        try foreign.write(to: target); let retained = try await detach(host)
        await boundary(.afterDiscardStage(0), host: host); await refused { _ = try await self.finish(host, retained) }
        XCTAssertNil(try journalObject()["terminal"]); await host.close()
        try probe("MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('No filled-stage target query')};")
        let jobs = NativeAttachmentHostHooks(); var count = 0; jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in count += 1 } }
        let cold = core(noWrites()); try await cold.configureAttachmentHost(jobs); await boundary(.afterDiscardTerminal, host: cold)
        await refused { _ = try await cold.start() }
        let result = try outcomes(terminal(), retained)
        XCTAssertEqual(result.first?["target"] as? String, "untouched"); XCTAssertEqual(result.first?["stage"] as? String, "missing")
        XCTAssertEqual(count, 1); XCTAssertEqual(try Data(contentsOf: target), foreign)
        await cold.configureAttachmentDraftHost(AttachmentDraftHostHooks()); _ = try await cold.start()
        XCTAssertEqual(count, 1); try released()
    }

    func testActual128EntryHistoryUsesOneTemplateAnd64RealPublicationProofs() async throws {
        // The native cap includes every opaque snapshot copy. A shorter,
        // exclusively owned home/disk path keeps 128 real entries within that
        // cap on Mac; the earlier long checkout URI correctly exceeded it.
        let previousRoot = try XCTUnwrap(root)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".m262-\(UUID().uuidString.prefix(8))", isDirectory: true)
        guard !FileManager.default.fileExists(atPath: directory.path) else { throw HostFailure("Owned fixture path collision") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        let ownedRoot = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        root = ownedRoot; defer { root = previousRoot }
        // Registered before hosts, so their LIFO teardown closes them first.
        addTeardownBlock { try FileManager.default.removeItem(at: ownedRoot) }
        let host = try await seed(adds: 1, empty: true)
        let template = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).first)
        await host.close()
        // One real fresh preparation supplies metadata. Each additional Add
        // gets real descriptor reservation/fill/publication proofs; full shared
        // history validation runs at the Discard owner, not inside this loop.
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
        var history: [Store.MixedOperation] = [], additions: [Store.Operation] = []
        for index in 0..<64 {
            let id = index == 0 ? template.requestId : UUID().uuidString.lowercased()
            let uri = managed.appendingPathComponent(id + ".txt").absoluteString
            var attachment = try XCTUnwrap(frozenTemplate["attachment"] as? [String: Any])
            attachment["id"] = id; attachment["uri"] = uri
            var prepared = try XCTUnwrap(frozenTemplate["prepared"] as? [String: Any])
            var pickedAttachment = try XCTUnwrap(prepared["attachment"] as? [String: Any])
            pickedAttachment["id"] = id; prepared["attachment"] = pickedAttachment
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
            let addition = Store.Operation(requestId: id, requestJSON: try json(request), phase: .checkpointed,
                before: before, after: after, preparedJSON: try compact(frozen), targetURI: uri, source: template.source,
                stage: reserved, filled: filled, published: published,
                replyJSON: try json(["version": 1, "status": "added", "requestId": id, "sessionID": after.sessionID, "generation": after.generation]))
            additions.append(addition); history.append(.add(addition))
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
        let fixtureBytes = try encoded(fixture)
        XCTAssertEqual(history.count, 128); XCTAssertLessThanOrEqual(fixtureBytes.count, Store.maximumBytes)
        print("Task262 native128 actual Foundation bytes=\(fixtureBytes.count), limit=\(Store.maximumBytes)")
        _ = try Store.mixedFingerprint(fixture)
        try DurableFile.write(fixtureBytes, to: store.url, privateDraft: true); try editor.checkpoint(before)
        let sourceBytes = try Data(contentsOf: source()), rowsBefore = try domain(), fresh = core(noWrites())
        _ = try await fresh.start(); let retained = try await detach(fresh)
        await boundary(.afterDiscardTerminal, host: fresh)
        await refused { _ = try await self.finish(fresh, retained) }
        let result = try outcomes(terminal(), retained)
        XCTAssertEqual(result.count, 128); XCTAssertEqual(result.filter { $0["kind"] as? String == "add" }.count, 64)
        XCTAssertTrue(result.filter { $0["kind"] as? String == "add" }.allSatisfy { $0["target"] as? String == "removed" && $0["stage"] as? String == "missing" })
        XCTAssertTrue(result.filter { $0["kind"] as? String == "remove" }.allSatisfy { $0["disposition"] as? String == "metadataOnly" })
        for add in additions { XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: add.targetURI)).path)) }
        XCTAssertEqual(try Data(contentsOf: source()), sourceBytes); XCTAssertEqual(try domain(), rowsBefore)
        await fresh.close(); let cold = core(noWrites()); try await cold.configureAttachmentHost(noJobs()); _ = try await cold.start(); try released()
    }

    func testFoundationEscapedCapacityRefusesBeforeDecisionDetachOrFileWork() async throws {
        let host = try await seed(adds: 1)
        let added = try XCTUnwrap(NativeAttachmentDraftCoordinator.mixedSaveAdds(record()).first)
        try await remove(host)
        await boundary(.afterIntent, host: host)
        await refused { try await self.remove(host, id: added.requestId) }
        let template = try record(); XCTAssertEqual(template.operations.count, 3)
        await host.close()
        // Preserve three real prepared operations and their RN projections.
        // Leading JSON whitespace is opaque editor evidence; its Foundation
        // escaping grows every retained copy without new shared preparations.
        func padded(_ count: Int) throws -> Store.MixedRecord {
            let prefix = String(repeating: "\n", count: count)
            func snapshot(_ original: EditorDraftSnapshot) -> EditorDraftSnapshot {
                .init(sessionID: original.sessionID, taskID: original.taskID, generation: original.generation,
                    payloadJSON: prefix + original.payloadJSON)
            }
            let operations = try template.operations.map { entry -> Store.MixedOperation in
                let before = snapshot(entry.before), after = snapshot(entry.after)
                let preparedJSON: String
                switch entry {
                case .add(let op):
                    var prepared = try object(op.preparedJSON)
                    prepared["beforePayloadJSON"] = before.payloadJSON; prepared["afterPayloadJSON"] = after.payloadJSON
                    preparedJSON = try json(prepared)
                    return .add(.init(requestId: op.requestId, requestJSON: op.requestJSON, phase: op.phase, reason: op.reason,
                        before: before, after: after, preparedJSON: preparedJSON, targetURI: op.targetURI, source: op.source,
                        stage: op.stage, filled: op.filled, published: op.published, replyJSON: op.replyJSON))
                case .remove(let op):
                    var prepared = try object(op.preparedJSON)
                    prepared["beforePayloadJSON"] = before.payloadJSON; prepared["afterPayloadJSON"] = after.payloadJSON
                    preparedJSON = try json(prepared)
                    return .remove(.init(requestId: op.requestId, requestJSON: op.requestJSON, phase: op.phase,
                        before: before, after: after, preparedJSON: preparedJSON, replyJSON: op.replyJSON))
                }
            }
            return .init(session: .init(sessionID: template.session.sessionID, taskID: template.session.taskID, state: .active,
                checkpoint: snapshot(template.session.checkpoint)), operations: operations)
        }
        let baseBytes = try encoded(padded(0)).count
        let escapedBytesPerNewline = try encoded(padded(1)).count - baseBytes
        XCTAssertGreaterThan(escapedBytesPerNewline, 0)
        let padding = (Store.maximumBytes - baseBytes - 512) / escapedBytesPerNewline
        let fixture = try padded(padding), fixtureBytes = try encoded(fixture)
        _ = try Store.mixedFingerprint(fixture)
        XCTAssertLessThanOrEqual(fixtureBytes.count, Store.maximumBytes)
        XCTAssertGreaterThan(fixtureBytes.count, Store.maximumBytes - 1024)
        let checkpoint = fixture.session.checkpoint, raw = try discardRequest(checkpoint)
        let requestId = try XCTUnwrap(object(raw)["requestId"] as? String)
        let decided = Store.MixedRecord(session: .init(sessionID: checkpoint.sessionID, taskID: checkpoint.taskID,
            state: .cleanupPending, checkpoint: checkpoint), operations: fixture.operations,
            discard: .init(requestId: requestId, requestJSON: raw, expected: checkpoint, phase: .decided))
        let detached = Store.MixedRecord(session: decided.session, operations: fixture.operations,
            discard: .init(requestId: requestId, requestJSON: raw, expected: checkpoint, phase: .detached,
                replyJSON: try json(["version": 1, "status": "cleanupPending", "requestId": requestId, "sessionID": checkpoint.sessionID])))
        XCTAssertGreaterThan(try encoded(decided).count, Store.maximumBytes)
        XCTAssertGreaterThan(try encoded(detached).count, Store.maximumBytes)
        XCTAssertThrowsError(try store.preflightMixed(decided)); XCTAssertThrowsError(try store.preflightMixed(detached))
        try DurableFile.write(fixtureBytes, to: store.url, privateDraft: true)
        struct Stored: Encodable { let snapshot: EditorDraftSnapshot }
        try DurableFile.write(encoded(Stored(snapshot: checkpoint)), to: editor.url, privateDraft: true)
        XCTAssertEqual(try latest(), checkpoint)
        _ = try sql("CREATE TABLE fixture_trace(id INTEGER PRIMARY KEY,label TEXT NOT NULL)")
        try probe("""
        const candidates=MindwtrHost.attachmentDraftDiscardCandidatesV3,poll=MindwtrHost.poll;
        let ticket=null;
        MindwtrHost.attachmentDraftDiscardCandidatesV3=j=>{ticket=candidates(j);return ticket;};
        MindwtrHost.poll=id=>{
          const result=poll(id);
          if(id===ticket&&result!==null){
            ticket=null;
            const completed=JSON.parse(result),value=completed.value;
            if(completed.ok===true&&value&&value.version===2&&value.historyVersion===3
              &&value.kind==='owned-mixed-discard-candidates'&&value.taskID==='mixed-discard-task'
              &&Array.isArray(value.candidates)&&value.candidates.length===1){
              __mindwtrNative.sqlRun('INSERT INTO fixture_trace(label) VALUES (?)',JSON.stringify(['full-history-validated']));
            }
          }
          return result;
        };
        """)
        let editorBytes = try Data(contentsOf: editor.url), editorInode = try inode(editor.url), recordInode = try inode(store.url)
        let targets = [baselineTarget(), source(), try XCTUnwrap(URL(string: added.targetURI))]
        let targetBytes = try targets.map { try Data(contentsOf: $0) }, targetInodes = try targets.map { try inode($0) }
        let rows = try domain(), fresh = core(noWrites())
        try await fresh.configureAttachmentHost(noJobs()); _ = try await fresh.start()
        var reachedMutation = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { point in
            if point == .beforeDiscardDecision || point == .beforeDetach || point == .beforeDiscardFinishJournal { reachedMutation = true }
        }
        await fresh.configureAttachmentDraftHost(hooks)
        await refused { _ = try await fresh.discardAttachmentDraftV3(requestJSON: raw) }
        let trace = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT label FROM fixture_trace ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(trace.compactMap { $0["label"] as? String }, ["full-history-validated"])
        XCTAssertFalse(reachedMutation); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertNil(try record().discard); XCTAssertEqual(try Data(contentsOf: store.url), fixtureBytes)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(store.url), recordInode)
        XCTAssertEqual(try inode(editor.url), editorInode); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try targets.map { try Data(contentsOf: $0) }, targetBytes)
        XCTAssertEqual(try targets.map { try inode($0) }, targetInodes)
    }

    func testDiscardSummaryExposesExactDecisionAndDetachWithoutMutation() async throws {
        let host = try await seed(), checkpoint = try latest(), requestID = UUID().uuidString.lowercased()
        let raw = try discardRequest(checkpoint, id: requestID), beforeRows = try domain()
        await boundary(.afterDiscardDecision, host: host)
        await refused { _ = try await host.discardAttachmentDraftV3(requestJSON: raw) }
        for phase in ["decided", "detached"] {
            let retained = try Data(contentsOf: store.url), identity = try inode(store.url), editorBytes = try? Data(contentsOf: editor.url)
            let summaryJSON = try await host.readAttachmentDraft(), summary = try object(summaryJSON)
            XCTAssertEqual(Set(summary.keys), Set(["version", "status", "sessionID", "checkpoint", "operations", "discard"]))
            let decision = try XCTUnwrap(summary["discard"] as? [String: Any])
            XCTAssertEqual(Set(decision.keys), Set(["requestId", "phase"])); XCTAssertEqual(decision["requestId"] as? String, requestID)
            XCTAssertEqual(decision["phase"] as? String, phase); XCTAssertEqual(summary["version"] as? Int, 3)
            XCTAssertEqual(try record().session.state, .cleanupPending)
            XCTAssertEqual(summary["status"] as? String, "cleanupPending")
            XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try inode(store.url), identity)
            XCTAssertEqual(try? Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try domain(), beforeRows)
            XCTAssertLessThanOrEqual(summaryJSON.utf8.count, 8 * 1024 * 1024)
            if phase == "decided" {
                await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
                _ = try await host.discardAttachmentDraftV3(requestJSON: raw); XCTAssertEqual(try record().discard?.phase, .detached)
            }
        }
        let decision = try record(); _ = try await finish(host, decision); try released()
        let absent = try await host.readAttachmentDraft(); XCTAssertEqual(absent, "null"); XCTAssertEqual(try domain(), beforeRows)
    }
}
