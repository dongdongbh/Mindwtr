import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Production JSC binding + native descriptor jobs + durable sidecar/checkpoint.
final class AttachmentDraftHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "durable-attachment-task"
    private let at = "2026-10-05T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task228-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func savedTask() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id=?", [taskID]).utf8))) }
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
        let reply = try object(await host.beginAttachmentDraft(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation))
        XCTAssertEqual(reply["status"] as? String, "begun")
    }
    private func source(_ bytes: Data = Data("retained native draft bytes".utf8), name: String = "source.txt") throws -> URL {
        let file = cache.appendingPathComponent(name); try bytes.write(to: file); return file
    }
    private func addRequest(_ snapshot: EditorDraftSnapshot, source: URL, id: String = UUID().uuidString.lowercased(), name: String = "Private.txt") throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": snapshot.sessionID, "generation": snapshot.generation,
                  "picked": ["uri": source.absoluteString, "name": name, "mimeType": "text/plain", "size": NSNull()]])
    }
    private func discardRequest(_ snapshot: EditorDraftSnapshot, id: String = UUID().uuidString.lowercased()) throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": snapshot.sessionID, "generation": snapshot.generation])
    }
    private func record() throws -> NativeAttachmentDraftStore.Record { try XCTUnwrap(store.read()) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func target() throws -> URL { try XCTUnwrap(URL(string: XCTUnwrap(record().operations.last?.targetURI))) }
    private func fail(_ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Operation must refuse without releasing evidence") }
        catch { XCTAssertFalse(error.localizedDescription.contains("Private.txt")); XCTAssertFalse(error.localizedDescription.contains("file:///")) }
    }
    private func stop(_ boundary: AttachmentDraftBoundary, on host: CoreHost) async {
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == boundary { throw HostFailure("Private.txt injected path must never escape") } }
        await host.configureAttachmentDraftHost(hooks)
    }
    private func clear(_ host: CoreHost) async { await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()) }

    func testFreshAddColdReplayPreservesFrozenMetadataOpaqueEditorAndSavedTask() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let original = try savedTask(), input = try source(), bytes = try Data(contentsOf: input)
        let request = try addRequest(snapshot, source: input)
        let reply = try await host.addAttachmentDraft(requestJSON: request)
        XCTAssertEqual(try object(reply)["generation"] as? Int, 2)
        let after = try latest(), retained = try record(), file = try target()
        XCTAssertEqual(retained.operations.last?.phase, .checkpointed)
        XCTAssertEqual(after, retained.session.checkpoint)
        XCTAssertEqual(try object(after.payloadJSON)["title"] as? String, "Uncommitted title")
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: input), bytes)
        XCTAssertEqual(try savedTask(), original)
        let frozen = try XCTUnwrap(retained.operations.last?.preparedJSON)
        await host.close()
        let cold = core(); _ = try await cold.start()
        let replay = try await cold.addAttachmentDraft(requestJSON: request)
        XCTAssertEqual(replay, reply); XCTAssertEqual(try latest(), after)
        XCTAssertEqual(try record().operations.last?.preparedJSON, frozen)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try savedTask(), original)
        let summary = try await cold.readAttachmentDraft()
        XCTAssertFalse(summary.contains(input.absoluteString)); XCTAssertFalse(summary.contains("sha256")); XCTAssertFalse(summary.contains("identity"))
        let log = root.appendingPathComponent("logs/mindwtr.log")
        let diagnostics = try String(contentsOf: log)
        XCTAssertTrue(diagnostics.contains("v1.3.4/ios-attachment-draft-owned"))
        XCTAssertFalse(diagnostics.contains(input.absoluteString)); XCTAssertFalse(diagnostics.contains("Private.txt"))
    }
    func testIdempotentBeginAfterAcknowledgedAddValidatesFrozenInitialAndPreservesCheckpoint() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        _ = try await host.addAttachmentDraft(requestJSON: request)
        let after = try latest(), evidence = try Data(contentsOf: store.url)
        try await begin(host, after)
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try latest(), after)
        await host.close(); let cold = core(); _ = try await cold.start()
        try await begin(cold, after)
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try latest(), after)
    }
    func testForgedPendingFrozenMetadataRefusesRecoveryBeforeFileCreation() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        await stop(.afterIntent, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        await host.close()
        var raw = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self))
        var operations = try XCTUnwrap(raw["operations"] as? [[String: Any]])
        var frozen = try object(XCTUnwrap(operations[0]["preparedJSON"] as? String))
        var metadata = try XCTUnwrap(frozen["attachment"] as? [String: Any]); metadata["title"] = "forged"
        frozen["attachment"] = metadata; operations[0]["preparedJSON"] = try json(frozen); raw["operations"] = operations
        try Data(json(raw).utf8).write(to: store.url)
        let retained = try Data(contentsOf: store.url), cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try latest(), snapshot)
    }
    func testStrictRequestsAndBeginAdmissionPreserveEmptyOwnershipWithoutIO() async throws {
        let (host, snapshot) = try await seed()
        let missing = try await host.readAttachmentDraft(); XCTAssertEqual(missing, "null")
        await fail { _ = try await host.beginAttachmentDraft(expectedSession: snapshot.sessionID, expectedGeneration: 2) }
        XCTAssertNil(try store.read()); try await begin(host, snapshot)
        let before = try Data(contentsOf: store.url), request = try object(addRequest(snapshot, source: source()))
        var invalid: [[String: Any]] = []
        for field in ["version", "generation"] { var value = request; value[field] = true; invalid.append(value) }
        for generation in [0, 1.25, "1", 9_007_199_254_740_992] as [Any] { var value = request; value["generation"] = generation; invalid.append(value) }
        var extra = request; extra["owned"] = true; invalid.append(extra)
        var uppercase = request; uppercase["requestId"] = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"; invalid.append(uppercase)
        var oversized = request, picked = try XCTUnwrap(oversized["picked"] as? [String: Any]); picked["name"] = String(repeating: "x", count: 70_000); oversized["picked"] = picked; invalid.append(oversized)
        for value in invalid { await fail { _ = try await host.addAttachmentDraft(requestJSON: self.json(value)) } }
        XCTAssertEqual(try Data(contentsOf: store.url), before)
        XCTAssertEqual(try latest(), snapshot); XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
    }
    func testOldUUIDReplayAfterLaterAddDoesNotRestoreOldCheckpointAndChangedInputRefusesBeforeIO() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let input = try source(), first = try addRequest(snapshot, source: input)
        let firstReply = try await host.addAttachmentDraft(requestJSON: first)
        let secondSnapshot = try latest(), second = try addRequest(secondSnapshot, source: input, name: "Second.txt")
        _ = try await host.addAttachmentDraft(requestJSON: second)
        let final = try latest(), recordBytes = try Data(contentsOf: store.url)
        let replay = try await host.addAttachmentDraft(requestJSON: first)
        XCTAssertEqual(replay, firstReply); XCTAssertEqual(try latest(), final)
        var changed = try object(first), picked = try XCTUnwrap(changed["picked"] as? [String: Any])
        picked["uri"] = cache.appendingPathComponent("does-not-exist.txt").absoluteString; changed["picked"] = picked
        await fail { _ = try await host.addAttachmentDraft(requestJSON: self.json(changed)) }
        XCTAssertEqual(try Data(contentsOf: store.url), recordBytes)
        XCTAssertEqual(try latest(), final); XCTAssertEqual(try record().operations.count, 2)
    }
    func testColdRecoveryAtEveryProvenAddBoundaryAndAcknowledgmentLoss() async throws {
        let boundaries: [AttachmentDraftBoundary] = [.afterIntent, .afterStageProof, .beforeFilled, .afterFilled, .beforePublication,
            .afterPublication, .afterPublicationProof, .beforeResult, .afterResult, .beforeCheckpoint, .afterCheckpoint, .beforeMarker, .afterMarker]
        for boundary in boundaries {
            // Each boundary needs an independent library/session: no sidecar release API.
            let savedRoot = root!
            let sub = savedRoot.appendingPathComponent("boundary-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
            let (host, snapshot) = try await seed(); try await begin(host, snapshot)
            let input = try source(), request = try addRequest(snapshot, source: input)
            await stop(boundary, on: host)
            await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
            let frozen = try XCTUnwrap(record().operations.last?.preparedJSON)
            await host.close()
            let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
            let reply = try await cold.addAttachmentDraft(requestJSON: request)
            XCTAssertEqual(try object(reply)["generation"] as? Int, 2)
            XCTAssertEqual(try record().operations.count, 1)
            XCTAssertEqual(try record().operations.last?.phase, .checkpointed)
            XCTAssertEqual(try record().operations.last?.preparedJSON, frozen)
            XCTAssertEqual(try latest().generation, 2)
            XCTAssertEqual(try Data(contentsOf: target()), Data("retained native draft bytes".utf8))
            await cold.close(); root = savedRoot
        }
    }
    func testBeforeIntentFailureCreatesNoStageAndCanRetryNewWork() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        await stop(.beforeIntent, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(try record().operations.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        await clear(host); _ = try await host.addAttachmentDraft(requestJSON: request)
        XCTAssertEqual(try latest().generation, 2)
    }
    func testLostReservationProofRefusesColdAdoptionAndRetainsPrivateBytes() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let input = try source(), request = try addRequest(snapshot, source: input)
        await stop(.afterReservation, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let op = try XCTUnwrap(record().operations.last)
        XCTAssertEqual(op.phase, .intent); XCTAssertNil(op.stage)
        let entries = try FileManager.default.contentsOfDirectory(atPath: managed.path).filter { $0.hasSuffix(".candidate") }
        XCTAssertEqual(entries.count, 1)
        let namespace = ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate"
        XCTAssertEqual(entries.first, namespace)
        let stage = managed.appendingPathComponent(namespace).appendingPathComponent("stage")
        let before = try Data(contentsOf: stage)
        await host.close(); let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertEqual(try Data(contentsOf: stage), before); XCTAssertEqual(try latest(), snapshot)
        XCTAssertEqual(try record().operations.last?.reason, .interruptedReservation)
        XCTAssertEqual(try Data(contentsOf: input), Data("retained native draft bytes".utf8))
        let discarded = try await cold.discardAttachmentDraft(requestJSON: discardRequest(snapshot))
        XCTAssertEqual(try object(discarded)["status"] as? String, "cleanupPending")
        XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.expected, snapshot)
        XCTAssertEqual(try record().operations.last?.phase, .intent)
        XCTAssertEqual(try Data(contentsOf: stage), before)
        XCTAssertEqual(try Data(contentsOf: input), Data("retained native draft bytes".utf8))
    }
    func testAfterRenameLostAckRecoversWithoutSourceAndNeverCopiesAgain() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let input = try source(), request = try addRequest(snapshot, source: input)
        await stop(.afterPublication, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(try record().operations.last?.phase, .stageFilled)
        let file = try target(), bytes = try Data(contentsOf: file)
        try FileManager.default.removeItem(at: input)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try latest().generation, 2)
    }
    func testSameHashDifferentTargetInodeIsNeverAdopted() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let input = try source(), request = try addRequest(snapshot, source: input)
        await stop(.beforePublication, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let op = try XCTUnwrap(record().operations.last), file = try target()
        try Data(contentsOf: input).write(to: file)
        let foreignBytes = try Data(contentsOf: file)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), stageBytes = try Data(contentsOf: stage)
        await host.close(); let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertEqual(try Data(contentsOf: file), foreignBytes); XCTAssertEqual(try Data(contentsOf: stage), stageBytes)
        XCTAssertEqual(try latest(), snapshot)
        XCTAssertEqual(try record().operations.last?.phase, .stageFilled)
    }
    func testSourceReplacementAndColdCacheParentReplacementRetainStageAndCheckpoint() async throws {
        for parentReplacement in [false, true] {
            let savedRoot = root!, sub = savedRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
            let (host, snapshot) = try await seed(); try await begin(host, snapshot)
            let folder = cache.appendingPathComponent("picked", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let input = folder.appendingPathComponent("source.txt"); try Data([1, 2]).write(to: input)
            let request = try addRequest(snapshot, source: input)
            await stop(.afterStageProof, on: host)
            await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(record().operations.last?.stage?.uri)))
            await host.close()
            if parentReplacement {
                try FileManager.default.moveItem(at: folder, to: cache.appendingPathComponent("old-parent"))
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
                try Data([1, 2]).write(to: input)
            } else {
                try FileManager.default.moveItem(at: input, to: folder.appendingPathComponent("old-source.txt"))
                try Data([1, 2]).write(to: input)
            }
            let cold = core(); _ = try await cold.start()
            await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
            XCTAssertEqual(try Data(contentsOf: stage).count, 0); XCTAssertEqual(try latest(), snapshot)
            XCTAssertEqual(try Data(contentsOf: input), Data([1, 2]))
            let discarded = try await cold.discardAttachmentDraft(requestJSON: discardRequest(snapshot))
            XCTAssertEqual(try object(discarded)["status"] as? String, "cleanupPending")
            XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.expected, snapshot)
            XCTAssertEqual(try record().operations.last?.phase, .stagePrepared)
            XCTAssertEqual(try Data(contentsOf: stage).count, 0); XCTAssertEqual(try Data(contentsOf: input), Data([1, 2]))
            await cold.close(); root = savedRoot
        }
    }
    func testLaterUnrelatedEditorCheckpointIsNeverOverwritten() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        await stop(.afterPublicationProof, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let file = try target(), bytes = try Data(contentsOf: file)
        await host.close()
        let later = EditorDraftSnapshot(sessionID: snapshot.sessionID, taskID: taskID, generation: 4, payloadJSON: snapshot.payloadJSON)
        try editor.checkpoint(later)
        let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertEqual(try latest(), later); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
    func testPendingAfterCheckpointRequiresReconciliationBeforeDiscardCanDetach() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        await stop(.afterCheckpoint, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let after = try latest(), retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        XCTAssertEqual(try record().operations.last?.phase, .resultDurable)
        await clear(host)
        await fail { _ = try await host.discardAttachmentDraft(requestJSON: self.discardRequest(snapshot)) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        _ = try await host.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
        _ = try await host.discardAttachmentDraft(requestJSON: discardRequest(after))
        XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.expected, after)
    }
    func testCurrentTaskReadOnlyAfterPublicationRefusesCheckpointWithoutLosingBytes() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        await stop(.afterPublicationProof, on: host)
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        let file = try target(), bytes = try Data(contentsOf: file)
        await host.close()
        _ = try sql("INSERT INTO projects(id,title,status,color,createdAt,updatedAt,rev) VALUES ('archived-owner','Archived','archived','#94a3b8',?,?,1)", [at, at])
        _ = try sql("UPDATE tasks SET projectId='archived-owner' WHERE id=?", [taskID])
        let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertEqual(try latest(), snapshot); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try record().operations.last?.phase, .published)
    }
    func testDiscardDecisionAndDetachCrashWindowsRetainAllBytesAndExactIdentity() async throws {
        for boundary in [AttachmentDraftBoundary.beforeDiscardDecision, .afterDiscardDecision, .beforeDetach, .afterDetach] {
            let savedRoot = root!, sub = savedRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
            let (host, snapshot) = try await seed(); try await begin(host, snapshot)
            let input = try source(), add = try addRequest(snapshot, source: input)
            _ = try await host.addAttachmentDraft(requestJSON: add)
            let after = try latest(), file = try target(), bytes = try Data(contentsOf: file)
            let discard = try discardRequest(after)
            await stop(boundary, on: host)
            await fail { _ = try await host.discardAttachmentDraft(requestJSON: discard) }
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: input), bytes)
            await host.close(); let cold = core(); _ = try await cold.start()
            let reply = try await cold.discardAttachmentDraft(requestJSON: discard)
            XCTAssertEqual(try object(reply)["status"] as? String, "cleanupPending")
            XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.phase, .detached)
            let replay = try await cold.discardAttachmentDraft(requestJSON: discard)
            XCTAssertEqual(replay, reply)
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: input), bytes)
            let state = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
            XCTAssertEqual(try object(state)["status"] as? String, "cleanupPending")
            await fail { _ = try await cold.addAttachmentDraft(requestJSON: add) }
            await cold.close(); root = savedRoot
        }
    }
    func testDecidedDiscardPreservesAnUnrelatedReplacementCheckpoint() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        await stop(.afterDiscardDecision, on: host)
        let request = try discardRequest(snapshot)
        await fail { _ = try await host.discardAttachmentDraft(requestJSON: request) }
        await host.close()
        let replacement = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 3, payloadJSON: snapshot.payloadJSON)
        try editor.discardMatching(expected: snapshot); try editor.checkpoint(replacement)
        let cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
        XCTAssertEqual(try latest(), replacement); XCTAssertEqual(try record().discard?.phase, .decided)
    }
    func testAllLegacyMutationAdmissionsRefuseRetainedEvidenceBeforeFreezingOrIO() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let before = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        await fail { try await host.checkpointEditorDraft(EditorDraftSnapshot(sessionID: snapshot.sessionID, taskID: self.taskID, generation: 2, payloadJSON: snapshot.payloadJSON)) }
        await fail { try await host.discardEditorDraft(expectedSession: snapshot.sessionID) }
        await fail { try await host.discardCorruptEditorDraft() }
        for method in ["saveDraft", "checklistSave", "boardAction", "taskDelete", "taskPromote"] {
            await fail { _ = try await host.saveEditorDraft(method, argumentsJSON: "[]", expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        }
        for name in ["draftAddFile", "draftRemove", "settleTaskDraftAttachments"] {
            await fail { _ = try await host.localAttachmentRequest(name: name, requestJSON: "{}") }
        }
        await fail { _ = try await host.call("captureSubmit", argumentsJSON: "[]") }
        let emptyBackup = root.appendingPathComponent("source.json"); try Data("{}".utf8).write(to: emptyBackup)
        await fail { _ = try await host.prepareBackupImport(emptyBackup) }
        XCTAssertEqual(try Data(contentsOf: store.url), before); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await host.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        _ = try await host.prepareDataBackup()
    }
    func testCorruptAndSymlinkSidecarLeaveOrdinaryColdReadAvailableAndBlockSalvage() async throws {
        let (host, snapshot) = try await seed(); await host.close()
        try Data("private corrupt sidecar".utf8).write(to: store.url)
        let cold = core(); _ = try await cold.start()
        _ = try await cold.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        await fail { _ = try await cold.readAttachmentDraft() }
        await fail { try await cold.discardCorruptEditorDraft() }
        XCTAssertEqual(try latest(), snapshot)
        await cold.close()
        try FileManager.default.removeItem(at: store.url)
        let outside = root.appendingPathComponent("outside-proof"); try Data("retained".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: outside)
        let linked = core(); _ = try await linked.start()
        _ = try await linked.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        await fail { try await linked.discardEditorDraft(expectedSession: snapshot.sessionID) }
        await fail { _ = try await linked.readAttachmentDraft() }
        XCTAssertEqual(try Data(contentsOf: outside), Data("retained".utf8))
    }
    func testCapacityRefusalBeforeIntentOrReservationRetainsPreviousCheckpoint() async throws {
        let (host, snapshot) = try await seed(extra: String(repeating: "x", count: 350_000)); try await begin(host, snapshot)
        let input = try source(), bytes = try Data(contentsOf: input)
        var refused = false
        for _ in 0..<12 {
            let before = try latest(), evidence = try Data(contentsOf: store.url)
            let id = UUID().uuidString.lowercased(), request = try addRequest(before, source: input, id: id)
            do { _ = try await host.addAttachmentDraft(requestJSON: request) }
            catch {
                refused = true
                XCTAssertEqual(try Data(contentsOf: store.url), evidence)
                XCTAssertEqual(try latest(), before)
                XCTAssertFalse(FileManager.default.fileExists(atPath: managed.appendingPathComponent(".mindwtr-install-" + id.replacingOccurrences(of: "-", with: "") + ".candidate").path))
                break
            }
        }
        XCTAssertTrue(refused); XCTAssertEqual(try Data(contentsOf: input), bytes)
        let checkpoint = try latest()
        let discard = try await host.discardAttachmentDraft(requestJSON: discardRequest(checkpoint))
        XCTAssertEqual(try object(discard)["status"] as? String, "cleanupPending")
        XCTAssertEqual(try record().discard?.phase, .detached)
        XCTAssertNil(try editor.read())
    }
    func testPendingDiscardCapacityIncludesExactLargerWhitespaceBeforeHalf() async throws {
        let (host, snapshot) = try await seed()
        let before = EditorDraftSnapshot(sessionID: snapshot.sessionID, taskID: taskID, generation: 2,
            payloadJSON: String(repeating: "\n", count: 950_000) + snapshot.payloadJSON)
        try await host.checkpointEditorDraft(before); try await begin(host, before)
        let evidence = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url)
        let request = try addRequest(before, source: source())
        // Canonical after would be tiny. Retained pending Discard must still
        // duplicate the larger exact before-half, so refuse before reservation.
        await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try record().operations.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        _ = try await host.discardAttachmentDraft(requestJSON: discardRequest(before))
        XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.expected, before)
    }
    func testColdFilledStageRequiresOriginalSourceUntilPublicationIsProven() async throws {
        for replacement in [false, true] {
            let savedRoot = root!, sub = savedRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
            let (host, snapshot) = try await seed(); try await begin(host, snapshot)
            let input = try source(), request = try addRequest(snapshot, source: input)
            await stop(.afterFilled, on: host)
            await fail { _ = try await host.addAttachmentDraft(requestJSON: request) }
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(record().operations.last?.stage?.uri)))
            let bytes = try Data(contentsOf: stage), file = try target()
            await host.close()
            try FileManager.default.moveItem(at: input, to: cache.appendingPathComponent("retained-source"))
            if replacement { try bytes.write(to: input) }
            let cold = core(); _ = try await cold.start()
            await fail { _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID) }
            XCTAssertEqual(try Data(contentsOf: stage), bytes); XCTAssertEqual(try latest(), snapshot)
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
            XCTAssertEqual(try record().operations.last?.phase, .stageFilled)
            await cold.close(); root = savedRoot
        }
    }
    func testCancellationDuringStreamingFillRetainsPartialOwnedInodeAndColdRetry() async throws {
        for discardPending in [false, true] {
            let savedRoot = root!, sub = savedRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true); root = sub
            let (host, snapshot) = try await seed(); try await begin(host, snapshot)
            let bytes = Data(repeating: 37, count: 48 * 1024 * 1024), input = try source(bytes, name: "large.bin")
            let id = UUID().uuidString.lowercased(), request = try addRequest(snapshot, source: input, id: id)
            let stage = managed.appendingPathComponent(".mindwtr-install-" + id.replacingOccurrences(of: "-", with: "") + ".candidate/stage")
            let operation = Task { try await host.addAttachmentDraft(requestJSON: request) }
            let deadline = Date().addingTimeInterval(10)
            var observedPartial = false
            while Date() < deadline {
                var value = stat()
                if lstat(stage.path, &value) == 0, value.st_size > 0, value.st_size < bytes.count {
                    observedPartial = true; operation.cancel(); break
                }
                try await Task.sleep(nanoseconds: 100_000)
            }
            XCTAssertTrue(observedPartial, "Observe actual streamed bytes before cancellation")
            if !observedPartial { operation.cancel() }
            await fail { _ = try await operation.value }
            let retained = try record(), op = try XCTUnwrap(retained.operations.last)
            XCTAssertTrue([NativeAttachmentDraftStore.Phase.stagePrepared, .stageFilled].contains(op.phase))
            XCTAssertEqual(try latest(), snapshot)
            var stageInfo = stat(); XCTAssertEqual(lstat(stage.path, &stageInfo), 0)
            let identity = "\(UInt64(stageInfo.st_dev)):\(UInt64(stageInfo.st_ino))"
            XCTAssertEqual(identity, op.stage?.identity)
            XCTAssertGreaterThan(stageInfo.st_size, 0)
            XCTAssertEqual(try Data(contentsOf: input), bytes)
            await host.close(); let cold = core(); _ = try await cold.start()
            if discardPending {
                let retainedBytes = try Data(contentsOf: stage)
                let discarded = try await cold.discardAttachmentDraft(requestJSON: discardRequest(snapshot))
                XCTAssertEqual(try object(discarded)["status"] as? String, "cleanupPending")
                XCTAssertNil(try editor.read()); XCTAssertEqual(try record().discard?.expected, snapshot)
                XCTAssertEqual(try record().operations.last?.phase, op.phase)
                XCTAssertEqual(try Data(contentsOf: stage), retainedBytes)
                XCTAssertEqual(try Data(contentsOf: input), bytes)
            } else {
                _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
                XCTAssertEqual(try latest().generation, 2)
                XCTAssertEqual(try Data(contentsOf: target()), bytes)
            }
            await cold.close(); root = savedRoot
        }
    }
    func testCloseCancelsQueuedPrepareButDrainsStartedReservationAndRetainsReturnedProof() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let input = try source(), request = try addRequest(snapshot, source: input)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in
            jobs.afterWork = { _, installer in if installer { entered.signal(); _ = release.wait(timeout: .now() + 10) } }
        }
        // Jobs already exist after start, so configure through a boundary before
        // first reservation via the existing hook on a new owner.
        await host.close()
        let writing = core(); await writing.configureAttachmentHost(hooks); _ = try await writing.start()
        let operation = Task { try await writing.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(entered.wait(timeout: .now() + 10), .success)
        let closeDone = DispatchSemaphore(value: 0)
        let close = Task { await writing.close(); closeDone.signal() }
        XCTAssertEqual(closeDone.wait(timeout: .now() + 0.03), .timedOut)
        release.signal()
        await fail { _ = try await operation.value }
        await close.value
        let op = try XCTUnwrap(record().operations.last)
        XCTAssertEqual(op.phase, .stagePrepared); XCTAssertNotNil(op.stage)
        XCTAssertEqual(try latest(), snapshot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).path))
        XCTAssertEqual(try Data(contentsOf: input), Data("retained native draft bytes".utf8))
        let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
        XCTAssertEqual(try latest().generation, 2)
    }
    func testReadCannotThawFrozenEditorAttemptWhenSidecarEvidenceExists() async throws {
        let (host, snapshot) = try await seed()
        let attempt = try editor.freeze(sessionID: snapshot.sessionID, generation: snapshot.generation,
                                        method: "saveDraft", argumentsJSON: "[\"{}\"]")
        try store.write(.init(session: .init(sessionID: snapshot.sessionID, taskID: taskID, state: .active, checkpoint: snapshot), operations: []))
        await fail { _ = try await host.readEditorDraft() }
        XCTAssertEqual(try editor.read()?.attempt, attempt)
        XCTAssertEqual(try latest(), snapshot)
    }
    func testTerminalEditorCleanupConflictRetainsExactJournalSnapshotAndSidecar() async throws {
        let (host, snapshot) = try await seed(); await host.close()
        let faults = HostIOFaults(), writing = core(faults); _ = try await writing.start()
        let opening = try object(await writing.call("editorModel", argumentsJSON: json([taskID])))
        let arguments = try json([json(["id": taskID, "base": ["title": "Saved title"], "patch": ["title": "Committed title"],
                                      "scheduleBase": opening["scheduleBase"]!])])
        faults.editorDraftRemove = {
            try self.store.write(.init(session: .init(sessionID: snapshot.sessionID, taskID: self.taskID, state: .active, checkpoint: snapshot), operations: []))
        }
        await fail { _ = try await writing.saveEditorDraft("saveDraft", argumentsJSON: arguments, expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        let frozen = try XCTUnwrap(editor.read()?.attempt), journalBytes = try Data(contentsOf: journal), recordBytes = try Data(contentsOf: store.url)
        XCTAssertTrue(try savedTask().contains("Committed title"))
        await writing.close(); let cold = core()
        await fail { _ = try await cold.start() }
        // Existing terminal recovery re-encodes the outer envelope before its
        // cleanup gate. Pin every value, including the byte-exact request and
        // terminal strings, without depending on JSONEncoder dictionary order.
        let beforeJournal = try object(String(decoding: journalBytes, as: UTF8.self))
        let afterJournal = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(try Data(json(afterJournal).utf8), try Data(json(beforeJournal).utf8))
        XCTAssertEqual(try Data(contentsOf: store.url), recordBytes)
        XCTAssertEqual(try editor.read()?.attempt, frozen)
        XCTAssertEqual(try latest(), snapshot)
    }
    func testRejectedTerminalEditorJournalFixtureRetainsProofBeforeThawOrJournalRemoval() async throws {
        let (host, snapshot) = try await seed(); await host.close()
        let faults = HostIOFaults(), writing = core(faults); _ = try await writing.start()
        let opening = try object(await writing.call("editorModel", argumentsJSON: json([taskID])))
        let arguments = try json([json(["id": taskID, "base": ["title": "Saved title"], "patch": ["title": "Prepared edit"],
                                      "scheduleBase": opening["scheduleBase"]!])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Hold actual prepared editor journal") } }
        await fail { _ = try await writing.saveEditorDraft("saveDraft", argumentsJSON: arguments, expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        await writing.close()
        // Use the actual frozen request/attempt from the failed invocation; only
        // supply a controlled valid terminal-refusal fixture to exercise cleanup.
        var envelope = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        envelope["terminal"] = ["rejected": ["_0": "STALE_REVISION: Controlled terminal refusal"]]
        try Data(json(envelope).utf8).write(to: journal)
        try store.write(.init(session: .init(sessionID: snapshot.sessionID, taskID: taskID, state: .active, checkpoint: snapshot), operations: []))
        let frozen = try XCTUnwrap(editor.read()?.attempt), editorBytes = try Data(contentsOf: editor.url), sidecarBytes = try Data(contentsOf: store.url)
        let cold = core(); await fail { _ = try await cold.start() }
        let retained = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(try Data(json(retained).utf8), try Data(json(envelope).utf8))
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes)
        XCTAssertEqual(try editor.read()?.attempt, frozen)
        XCTAssertEqual(try latest(), snapshot)
        XCTAssertTrue(try savedTask().contains("Saved title")); XCTAssertFalse(try savedTask().contains("Prepared edit"))
    }
    func testMalformedSmallStoredReplyCannotBecomeSuccessfulReplay() async throws {
        let (host, snapshot) = try await seed(); try await begin(host, snapshot)
        let request = try addRequest(snapshot, source: source())
        _ = try await host.addAttachmentDraft(requestJSON: request)
        let after = try latest(), file = try target(), bytes = try Data(contentsOf: file)
        await host.close()
        var raw = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self))
        var operations = try XCTUnwrap(raw["operations"] as? [[String: Any]])
        operations[0]["replyJSON"] = try json(["version": 1, "status": "added", "requestId": "wrong", "sessionID": snapshot.sessionID, "generation": 2])
        raw["operations"] = operations
        try Data(json(raw).utf8).write(to: store.url)
        let retained = try Data(contentsOf: store.url), cold = core(); _ = try await cold.start()
        await fail { _ = try await cold.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained)
        XCTAssertEqual(try latest(), after); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testUnsettledDomainJournalBlocksAddBeforeFileMutationButOlderOrdinaryReplayIsUsable() async throws {
        let (host, snapshot) = try await seed()
        await host.close()
        let faults = HostIOFaults(), pendingHost = core(faults); _ = try await pendingHost.start()
        let opened = try object(await pendingHost.call("captureOpen"))
        let captureID = UUID().uuidString.lowercased()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending commit") } }
        await fail { _ = try await pendingHost.call("captureSubmit", argumentsJSON: self.json([self.json(["text": "Pending capture", "options": opened["options"]!, "captureId": captureID, "openAfterSave": false])])) }
        try store.write(.init(session: .init(sessionID: snapshot.sessionID, taskID: taskID, state: .active, checkpoint: snapshot), operations: []))
        let input = try source(), request = try addRequest(snapshot, source: input)
        await fail { _ = try await pendingHost.addAttachmentDraft(requestJSON: request) }
        XCTAssertEqual(try record().operations.count, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        await pendingHost.close()
        let cold = core(); _ = try await cold.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await cold.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        XCTAssertNotNil(try store.read()); XCTAssertEqual(try latest(), snapshot)
    }
}
