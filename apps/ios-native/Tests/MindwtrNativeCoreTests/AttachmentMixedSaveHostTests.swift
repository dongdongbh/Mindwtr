import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Full RN ordinary checkpoint/request, actual bundled JSC, SQLite and native
/// descriptor jobs. Seeded Add history is a fixture, not AddV3 producer evidence.
final class AttachmentMixedSaveHostTests: XCTestCase {
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
    private let taskID = "mixed-save-task"
    private let at = "2026-10-05T12:00:00.000Z"
    private let title = "Edited title / 文"
    private let notes = "Ordinary notes\nExact é / 文"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task260-fixtures/\(UUID().uuidString)", isDirectory: true)
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
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func task() throws -> [String: Any] { try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func target(_ index: Int = 0) -> URL { managed.appendingPathComponent("baseline-\(index).txt") }
    private func baseline(_ index: Int, tombstone: Bool = false, uri: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["id": "baseline-\(index)", "kind": "file", "title": "Private.txt", "uri": uri ?? target(index).absoluteString,
            "mimeType": "text/plain", "size": 15, "createdAt": at, "updatedAt": at, "cloudKey": "retained-object", "localStatus": "available"]
        if tombstone { result["deletedAt"] = at }; return result
    }
    private func payload(_ attachments: [[String: Any]], edited: Bool = true, note: String? = nil) throws -> String {
        let currentTitle = edited ? title : "", currentNote = edited ? (note ?? notes) : ""
        return try json(["version": 2, "taskID": taskID, "tab": "task",
            "touchedBase": edited ? ["title": "Saved title", "description": "Saved notes"] : [:],
            "edited": edited ? ["title": currentTitle, "description": currentNote] : [:],
            "raw": ["title": currentTitle, "note": currentNote, "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "linkSheet": [:]] as [String: Any])
    }
    private func seed(_ faults: HostIOFaults = HostIOFaults(), count: Int = 1, edited: Bool = true,
                      note: String? = nil, uri: String? = nil, adds: Int = 0, files: Bool = true,
                      jobs: NativeAttachmentHostHooks? = nil) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let baseline = (0..<count).map { self.baseline($0, tombstone: $0 > 0, uri: $0 == 0 ? uri : nil) }
        if files { for index in 0..<count { try Data("baseline bytes \(index)".utf8).write(to: target(index)) } }
        _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'Saved notes','inbox','[]','[]',?,?,?,1,'fixture')", [taskID, "Saved title", json(baseline), at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES ('unrelated','Untouched','inbox','[]','[]','[]',?,?,1,'fixture')", [at, at])
        let host = core(faults); if let jobs { try await host.configureAttachmentHost(jobs) }; _ = try await host.start()
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1,
            payloadJSON: try payload(baseline, edited: edited, note: note))
        try await host.checkpointEditorDraft(snapshot)
        if adds > 0 {
            // Reuse real V2 publication jobs and retain their exact proofs, then
            // explicitly seed the separately validated V3 tagged fixture.
            _ = try await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: 1)
            let source = cache.appendingPathComponent("borrowed.txt"); try Data("borrowed cache sentinel".utf8).write(to: source)
            for _ in 0..<adds {
                let before = try latest()
                _ = try await host.addAttachmentDraft(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
                    "sessionID": before.sessionID, "generation": before.generation,
                    "picked": ["uri": source.absoluteString, "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any]))
            }
            let legacy = try XCTUnwrap(store.read()), mixed = Store.MixedRecord(session: legacy.session, operations: legacy.operations.map { .add($0) })
            _ = try Store.mixedFingerprint(mixed)
            try DurableFile.write(JSONEncoder().encode(mixed), to: store.url, privateDraft: true)
        }
        let before = try latest()
        _ = try await host.beginAttachmentDraftV3(expectedSession: before.sessionID, expectedGeneration: before.generation)
        return host
    }
    private func remove(_ host: CoreHost, id: String = "baseline-0") async throws {
        let before = try latest()
        _ = try await host.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
            "sessionID": before.sessionID, "generation": before.generation, "attachmentId": id]))
    }
    private func request() throws -> String {
        let value = try object(latest().payloadJSON)
        return try json(["id": taskID, "base": value["touchedBase"]!, "patch": value["edited"]!,
            "scheduleBase": ["startTime": NSNull(), "dueDate": NSNull(), "relativeStartOffset": NSNull(), "reviewAt": NSNull()],
            "attachments": ["base": value["attachmentsBase"]!, "value": value["attachments"]!]] as [String: Any])
    }
    private func save(_ host: CoreHost, raw: String? = nil) async throws -> String {
        let before = try latest()
        return try await host.saveAttachmentDraftMixed(saveRequestJSON: raw ?? request(), expectedSession: before.sessionID, expectedGeneration: before.generation)
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
    private func noWrites() -> HostIOFaults {
        let result = HostIOFaults(); result.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks"].contains(where: { statement.hasPrefix($0) }) { XCTFail("Terminal replay must not write tasks"); throw HostFailure("Unexpected write") }
        }; return result
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), child = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true); root = child; bundle = originalBundle; return previous
    }
    private func probe(_ suffix: String, state: Bool = false) throws {
        var source = try String(contentsOf: originalBundle, encoding: .utf8)
        if state {
            let regex = try NSRegularExpression(pattern: #"let [A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\(\),[A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\.getState\(\);if\([^;]*\.editLockCount!==0"#)
            let matches = regex.matches(in: source, range: NSRange(source.startIndex..., in: source)); XCTAssertEqual(matches.count, 1)
            let match = try XCTUnwrap(matches.first), range = try XCTUnwrap(Range(match.range(at: 2), in: source))
            let marker = "globalThis.MindwtrHost={"; XCTAssertEqual(source.components(separatedBy: marker).count, 2)
            guard source.components(separatedBy: marker).count == 2 else { throw HostFailure("Fixture insertion mismatch") }
            source = source.replacingOccurrences(of: marker, with: "globalThis.__task260Store=\(source[range]);" + marker)
        }
        bundle = root.appendingPathComponent("probe-core-host.js")
        try (source + "\n;(()=>{" + suffix + "})();\n").write(to: bundle, atomically: true, encoding: .utf8)
    }

    func testFullOrdinaryChangedSavePreservesCloudDriftAndOtherRowsThenRetiresBaseline() async throws {
        let host = try await seed(); try await remove(host)
        let other = try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='unrelated'").utf8)))
        // Current stored cloud/content metadata is retained by the shared merge.
        await host.close(); var attachment = baseline(0); attachment["cloudKey"] = "new-cloud-object"; attachment["title"] = "Remote rename"
        _ = try sql("UPDATE tasks SET attachments=?,rev=rev+1 WHERE id=?", [json([attachment]), taskID])
        let fresh = core(); _ = try await fresh.start()
        let value = try object(await save(fresh)); XCTAssertEqual(Set(value.keys), Set(["id", "draft"]))
        let after = try task(); XCTAssertEqual(after["title"] as? String, title); XCTAssertEqual(after["description"] as? String, notes)
        let saved = try XCTUnwrap((NativeJSON.jsonObject(with: Data(XCTUnwrap(after["attachments"] as? String).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(saved["cloudKey"] as? String, "new-cloud-object"); XCTAssertNotNil(saved["deletedAt"])
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='unrelated'").utf8))), other)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path)); try released()
    }
    func testTrueNoopUsesFrozenRawRowWithoutTaskWriteOrRevision() async throws {
        let host = try await seed(edited: false); try await remove(host)
        let payload = try object(latest().payloadJSON); await host.close()
        _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json(payload["attachments"]!), taskID])
        let before = try rows(), fresh = core(noWrites()); _ = try await fresh.start()
        _ = try await save(fresh); XCTAssertEqual(try rows(), before); try released()
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path))
    }
    func testCompleteBaselinePlanIncludesMoreThan128Candidates() async throws {
        let host = try await seed(count: 259); try await remove(host)
        await boundary(.afterSaveTerminal, host: host)
        await refused({ _ = try await self.save(host) }, saved: true)
        XCTAssertEqual((try settlement()["targets"] as? [Any])?.count, 259)
        await host.close(); let cold = core(noWrites()); _ = try await cold.start(); try released()
        for index in 0..<259 { XCTAssertFalse(FileManager.default.fileExists(atPath: target(index).path)) }
    }
    func testCapturedPositiveAbsenceNeverAdoptsLaterAppearance() async throws {
        let host = try await seed(files: false); try await remove(host)
        await boundary(.beforeSaveTarget(0), host: host) { try Data("later foreign generation".utf8).write(to: self.target()) }
        _ = try await save(host); XCTAssertEqual(try Data(contentsOf: target()), Data("later foreign generation".utf8)); try released()
    }
    func testUnmanagedProviderAndUnsafeBaselineNeverTouchTheirTargets() async throws {
        for mode in ["provider", "outside", "symlink", "hardlink"] {
            let previous = try isolate(); defer { root = previous }
            let outside = root.appendingPathComponent("outside.txt"), bytes = Data("outside sentinel".utf8)
            try bytes.write(to: outside)
            let uri = mode == "provider" ? "content://fixture/private" : mode == "outside" ? outside.absoluteString : nil
            let host = try await seed(uri: uri, files: false)
            if mode == "symlink" { try FileManager.default.createSymbolicLink(at: target(), withDestinationURL: outside) }
            if mode == "hardlink" { XCTAssertEqual(link(outside.path, target().path), 0) }
            try await remove(host); _ = try await save(host); try released()
            XCTAssertEqual(try Data(contentsOf: outside), bytes)
            if mode == "symlink" || mode == "hardlink" { XCTAssertEqual(try Data(contentsOf: target()), bytes) }
            await host.close()
        }
    }
    func testLiveAddGetsOnlyStageCleanupWhileMissingRemovedAddDoesNotBlockSave() async throws {
        let host = try await seed(adds: 2), adds = NativeAttachmentDraftCoordinator.mixedSaveAdds(try record())
        let removed = try XCTUnwrap(adds.first), surviving = try XCTUnwrap(adds.last)
        try await remove(host, id: removed.requestId); try FileManager.default.removeItem(at: XCTUnwrap(URL(string: removed.targetURI)))
        let current = try latest(); var value = try object(current.payloadJSON)
        var raw = try XCTUnwrap(value["raw"] as? [String: Any]), edited = try XCTUnwrap(value["edited"] as? [String: Any])
        raw["note"] = notes + "\nOrdinary edit after Remove"; edited["description"] = raw["note"]
        value["raw"] = raw; value["edited"] = edited
        try await host.checkpointEditorDraft(.init(sessionID: current.sessionID, taskID: current.taskID, generation: current.generation + 3, payloadJSON: json(value)))
        try await remove(host)
        let source = cache.appendingPathComponent("borrowed.txt"), sourceBytes = try Data(contentsOf: source)
        let kept = try XCTUnwrap(URL(string: surviving.targetURI)), keptBytes = try Data(contentsOf: kept)
        _ = try await save(host); try released()
        XCTAssertEqual(try Data(contentsOf: kept), keptBytes); XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target().path))
        for op in adds { XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).deletingLastPathComponent().path)) }
    }
    func testColdDomainSavedProgressAndSettledNeverReinvokeCommitAfterTaskC() async throws {
        for point in [AttachmentDraftBoundary.afterSaveTerminal, .afterSaveProgress, .afterSaveSettled, .afterSaveRelease, .beforeSaveJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(count: 2); try await remove(host)
            await boundary(point, host: host); await refused({ _ = try await self.save(host) }, saved: true)
            await host.close(); _ = try sql("UPDATE tasks SET title='Task C',rev=rev+1 WHERE id=?", [taskID])
            let c = try rows(), fresh = core(noWrites()); _ = try await fresh.start(); try released(); XCTAssertEqual(try rows(), c)
            if point == .afterSaveTerminal { XCTAssertTrue(FileManager.default.fileExists(atPath: target().path)) }
            await fresh.close()
        }
    }
    func testUnknownPriorCommitRejectionRetainsExactFrozenEvidence() async throws {
        let host = try await seed(); try await remove(host)
        await boundary(.afterSaveCommit, host: host); await refused({ _ = try await self.save(host) }, saved: false)
        let sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        XCTAssertNil(try journalObject()["terminal"]); await host.close()
        _ = try sql("UPDATE tasks SET title='Task C',rev=rev+1 WHERE id=?", [taskID])
        let c = try rows(), fresh = core(noWrites()); await refused { _ = try await fresh.start() }
        XCTAssertEqual(try rows(), c); XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertNil(try journalObject()["terminal"]); XCTAssertTrue(FileManager.default.fileExists(atPath: target().path))
    }
    func testKnownRejectedTerminalColdThawsWithoutInvocationOrFileJobs() async throws {
        for point in [AttachmentDraftBoundary.afterSaveTerminal, .afterSaveThaw, .beforeSaveJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); try await remove(host); let checkpoint = try latest(), sidecar = try Data(contentsOf: store.url)
            let hooks = AttachmentDraftHostHooks(); hooks.boundary = {
                if $0 == .beforeSaveCommit { _ = try self.sql("UPDATE tasks SET title='Task C',rev=rev+1 WHERE id=?", [self.taskID]) }
                if $0 == point { throw HostFailure("Rejected cleanup interrupted") }
            }
            await host.configureAttachmentDraftHost(hooks); await refused { _ = try await self.save(host) }
            XCTAssertNotNil((try journalObject()["terminal"] as? [String: Any])?["rejected"])
            await host.close(); let fresh = core(noWrites()), fileHooks = NativeAttachmentHostHooks(); var jobs = 0
            fileHooks.configureJobs = { $0.beforeWork = { _, _ in jobs += 1; throw HostFailure("Rejected terminal cannot run files") } }
            try await fresh.configureAttachmentHost(fileHooks); _ = try await fresh.start()
            XCTAssertEqual(jobs, 0); XCTAssertNil(try editor.read()?.attempt); XCTAssertEqual(try latest(), checkpoint)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: target().path)); await fresh.close()
        }
    }
    func testUnjournaledFreezeReconcilesOnlyExactV3SnapshotWithoutSaving() async throws {
        let host = try await seed(); try await remove(host); let before = try rows()
        await boundary(.afterSaveFreeze, host: host); await refused { _ = try await self.save(host) }
        XCTAssertNotNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await host.close(); let fresh = core(noWrites()); _ = try await fresh.start(); _ = try await fresh.readEditorDraft()
        XCTAssertNil(try editor.read()?.attempt); XCTAssertEqual(try rows(), before); XCTAssertTrue(FileManager.default.fileExists(atPath: target().path))
    }
    func testUnjournaledV3ReconciliationRejectsSameBytesEditorReplacementDuringSharedValidation() async throws {
        let faults = HostIOFaults(), host = try await seed(faults); try await remove(host)
        await boundary(.afterSaveFreeze, host: host); await refused { _ = try await self.save(host) }
        await host.close()
        try probe("const original=MindwtrHost.attachmentDraftValidateLineageV3;MindwtrHost.attachmentDraftValidateLineageV3=(json)=>{__mindwtrNative.sqlRun('SELECT 260 AS fixture_probe','[]');return original(json);};")
        let fresh = core(faults); _ = try await fresh.start(); let frozen = try Data(contentsOf: editor.url)
        var before = stat(); XCTAssertEqual(lstat(editor.url.path, &before), 0)
        var fired = false
        faults.beforeSQL = { statement in
            if statement == "SELECT 260 AS fixture_probe" {
                fired = true
                let replacement = self.editor.url.appendingPathExtension("replacement")
                try frozen.write(to: replacement); XCTAssertEqual(rename(replacement.path, self.editor.url.path), 0)
            }
        }
        await refused { _ = try await fresh.readEditorDraft() }
        var after = stat(); XCTAssertEqual(lstat(editor.url.path, &after), 0)
        XCTAssertTrue(fired); XCTAssertNotEqual(before.st_ino, after.st_ino)
        XCTAssertEqual(try Data(contentsOf: editor.url), frozen); XCTAssertNotNil(try editor.read()?.attempt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(FileManager.default.fileExists(atPath: target().path))
    }
    func testColdHardlinkedFrozenEditorRefusesBeforeAnySQLiteCall() async throws {
        let host = try await seed(); try await remove(host)
        await boundary(.afterSaveJournal, host: host); await refused { _ = try await self.save(host) }
        await host.close(); let copy = root.appendingPathComponent("editor-hardlink.json")
        XCTAssertEqual(link(editor.url.path, copy.path), 0)
        let before = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url), decision = try Data(contentsOf: journal)
        let faults = HostIOFaults(); var calls = 0; faults.beforeSQL = { _ in calls += 1 }
        let fresh = core(faults); await refused { _ = try await fresh.start() }
        XCTAssertEqual(calls, 0); XCTAssertEqual(try Data(contentsOf: editor.url), before)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try Data(contentsOf: journal), decision)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target().path))
    }
    func testWarmPendingProgressAndClearAcknowledgmentFailuresRetryExactOwner() async throws {
        for mode in ["pending", "domainSaved", "progress", "clear"] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults); try await remove(host)
            var writes = 0; faults.journalWrite = { writes += 1; if writes == (mode == "pending" ? 1 : mode == "domainSaved" ? 2 : mode == "progress" ? 3 : -1) { throw HostFailure("Write acknowledgment lost") } }
            if mode == "clear" { await boundary(.afterSaveJournalClear, host: host) }
            await refused { _ = try await self.save(host) }; faults.journalWrite = nil
            await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()); _ = try await host.retryPending(); try released()
            XCTAssertFalse(FileManager.default.fileExists(atPath: target().path)); await host.close()
        }
    }
    func testLostUnlinkOrProgressAckRetriesProofButDurableKeepIsNeverRevisited() async throws {
        for point in [AttachmentDraftBoundary.afterSaveTarget(0), .beforeSaveProgress, .afterSaveProgress] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(count: 2); try await remove(host)
            await boundary(point, host: host); await refused({ _ = try await self.save(host) }, saved: true)
            XCTAssertFalse(FileManager.default.fileExists(atPath: target().path)); await host.close()
            let fresh = core(noWrites()); _ = try await fresh.start(); try released(); await fresh.close()
        }
    }
    func testDomainSavedMissingSidecarIsCorruptionButSettledMissingSidecarRunsNoFileJobs() async throws {
        for settled in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); try await remove(host)
            await boundary(settled ? .afterSaveSettled : .afterSaveTerminal, host: host); await refused({ _ = try await self.save(host) }, saved: true)
            await host.close(); try FileManager.default.removeItem(at: store.url)
            let fresh = core(noWrites()), hooks = NativeAttachmentHostHooks(); var jobs = 0
            hooks.configureJobs = { $0.beforeWork = { _, _ in jobs += 1; throw HostFailure("Missing sidecar cannot grant file job") } }
            try await fresh.configureAttachmentHost(hooks)
            if settled { _ = try await fresh.start(); try released() } else { await refused { _ = try await fresh.start() }; XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)) }
            XCTAssertEqual(jobs, 0); await fresh.close()
        }
    }
    func testExactSameBytesNewInodeAtCommitAndCleanupBoundariesRefuses() async throws {
        for mode in ["record", "editor", "journal"] { for cleanup in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(); try await remove(host)
            let url = mode == "record" ? store.url : mode == "editor" ? editor.url : journal
            await boundary(cleanup ? .beforeSaveEditorDetach : .beforeSaveCommit, host: host) {
                let bytes = try Data(contentsOf: url), replacement = url.appendingPathExtension("replacement")
                try bytes.write(to: replacement); XCTAssertEqual(rename(replacement.path, url.path), 0)
            }
            await refused({ _ = try await self.save(host) }, saved: cleanup)
            XCTAssertTrue(FileManager.default.fileExists(atPath: target().path)); XCTAssertNotNil(try editor.read()?.attempt)
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await host.close()
        } }
    }
    func testCurrentGenerationReplacementGetsDurablePositiveKeep() async throws {
        let host = try await seed(); try await remove(host); let foreign = Data("foreign replacement generation".utf8)
        await boundary(.beforeSaveTarget(0), host: host) {
            let replacement = self.target().appendingPathExtension("replacement"); try foreign.write(to: replacement)
            XCTAssertEqual(rename(replacement.path, self.target().path), 0)
        }
        _ = try await save(host); try released(); XCTAssertEqual(try Data(contentsOf: target()), foreign)
    }
    func testActualJSCSharedReferenceAndMovedTaskFenceKeepTheirReasonsDurably() async throws {
        for mode in ["reference", "moved"] {
            let previous = try isolate(); defer { root = previous }
            let change = mode == "reference"
                ? "const rows=state._allTasks.map(t=>t.id==='unrelated'?{...t,attachments:[{id:'reference',kind:'file',uri:attachment.uri}]}:t);"
                : "const rows=state._allTasks.map(t=>t.id===request.saveRequest.id?{...t,title:'Task C',rev:(t.rev||0)+1}:t);"
            try probe("""
            const original=MindwtrHost.attachmentFileEditSaveRetire;
            MindwtrHost.attachmentFileEditSaveRetire=(json,keep,moved,retire)=>{
              const frame=JSON.parse(json), request=JSON.parse(frame.envelopeJSON).request;
              const attachment=request.saveRequest.attachments.base[0], state=__task260Store.getState(); \(change)
              __task260Store.setState({_allTasks:rows,_tasksById:new Map(rows.map(t=>[t.id,t]))});
              return original(json,keep,moved,retire);
            };
            """, state: true)
            let host = try await seed(); try await remove(host); let bytes = try Data(contentsOf: target())
            await boundary(.afterSaveProgress, host: host); await refused({ _ = try await self.save(host) }, saved: true)
            let outcomes = try XCTUnwrap(settlement()["targets"] as? [[String: Any]])
            XCTAssertEqual(outcomes[0]["outcome"] as? String, mode == "reference" ? "referenced" : "taskChanged")
            await host.close(); bundle = originalBundle; let fresh = core(noWrites()); _ = try await fresh.start(); try released()
            // The reference/state mutation existed only in the previous runtime.
            // Its durably recorded keep still wins after that reference is gone.
            XCTAssertEqual(try Data(contentsOf: target()), bytes); await fresh.close()
        }
    }
    func testActualJSCMicrotaskWaitsUntilNativeRetirementCallbackFinishes() async throws {
        try probe("""
        const original=MindwtrHost.attachmentFileEditSaveRetire;
        const trace=label=>__mindwtrNative.sqlRun('INSERT INTO fixture_trace(label) VALUES (?)',JSON.stringify([label]));
        MindwtrHost.attachmentFileEditSaveRetire=(json,keep,moved,retire)=>{
          Promise.resolve().then(()=>trace('microtask'));
          return original(json,keep,moved,()=>{trace('callback-before');const result=retire();trace('callback-after');return result;});
        };
        """)
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.afterRetirementUnlink = { _ = try self.sql("INSERT INTO fixture_trace(label) VALUES ('native-unlink')") } }
        let host = try await seed(jobs: hooks); try await remove(host)
        _ = try sql("CREATE TABLE fixture_trace(id INTEGER PRIMARY KEY,label TEXT NOT NULL)")
        _ = try await save(host)
        let trace = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT label FROM fixture_trace ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(trace.compactMap { $0["label"] as? String }, ["callback-before", "native-unlink", "callback-after", "microtask"]); try released()
    }
    func testMissingDuplicateForgedAndThrowingCallbacksRetainDomainSavedWithoutProgress() async throws {
        for body in ["return JSON.stringify({outcome:'removed'});", "const result=original(json,keep,moved,retire);keep();return result;",
                     "original(json,keep,moved,retire);return JSON.stringify({outcome:'referenced'});", "original(json,keep,moved,retire);throw Error('Private.txt');"] {
            let previous = try isolate(); defer { root = previous }
            try probe("const original=MindwtrHost.attachmentFileEditSaveRetire;MindwtrHost.attachmentFileEditSaveRetire=(json,keep,moved,retire)=>{\(body)};")
            let host = try await seed(); try await remove(host); await refused({ _ = try await self.save(host) }, saved: true)
            XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved")
            XCTAssertTrue(((try settlement()["targets"] as? [[String: Any]])?[0]["outcome"]) is NSNull)
            await host.close(); bundle = originalBundle; let fresh = core(noWrites()); _ = try await fresh.start(); try released(); await fresh.close()
        }
    }
    func testActualEscapedCapacityAndPartialOrdinaryRequestRefuseBeforeFreeze() async throws {
        for large in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(note: large ? String(repeating: "\u{0000}", count: 55_000) : nil); try await remove(host)
            let checkpoint = try Data(contentsOf: editor.url), sidecar = try Data(contentsOf: store.url), before = try rows()
            var raw = try object(request()); if !large { raw["patch"] = ["title": title] }
            await refused { _ = try await self.save(host, raw: self.json(raw)) }
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            XCTAssertEqual(try rows(), before); XCTAssertNil(try editor.read()?.attempt); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await host.close()
        }
    }
    func testCancellationBeforeIntentAndAtFinalTargetPreservesEvidence() async throws {
        let host = try await seed(); try await remove(host); let before = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let work = Task { try await self.save(host) }; work.cancel(); await refused { _ = try await work.value }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let entered = DispatchSemaphore(value: 0), proceed = DispatchSemaphore(value: 0)
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .beforeSaveTarget(0) { entered.signal(); _ = proceed.wait(timeout: .now() + 5) } }
        await host.configureAttachmentDraftHost(hooks)
        let cleanup = Task { try await self.save(host) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success); cleanup.cancel(); proceed.signal()
        await refused({ _ = try await cleanup.value }, saved: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target().path)); XCTAssertEqual(try settlement()["phase"] as? String, "domainSaved")
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()); _ = try await host.retryPending(); try released()
    }
}
