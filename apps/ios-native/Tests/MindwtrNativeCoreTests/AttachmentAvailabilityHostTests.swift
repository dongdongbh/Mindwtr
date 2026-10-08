import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC/SQLite consumers; resource proofs below are minted by
/// the existing native stage/publication primitives, never by matching bytes.
final class AttachmentAvailabilityHostTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var bundle: URL!
    private var scheduleBase: [String: Any]!
    private let taskID = "availability-consumer-task"
    private var attachmentID = "35800000-1111-4111-8111-111111111111"
    private let operationID = "35800000-2222-4222-8222-222222222222"
    private let at = "2026-10-05T12:00:00.000Z"
    private let bytes = Data("verified availability bytes / 文".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private var baseline: URL { managed.appendingPathComponent(attachmentID + ".bin") }
    override func setUpWithError() throws {
        if let configured = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] { bundle = URL(fileURLWithPath: configured) }
        else if let packaged = Bundle.main.url(forResource: "core-host", withExtension: "js") { bundle = packaged }
        else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        #if os(iOS)
        let base = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
            .appendingPathComponent("NativeAvailabilityHostTests", isDirectory: true)
        #else
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let base = checkout.appendingPathComponent(".build/task358-fixtures", isDirectory: true)
        #endif
        let fixture = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func host(_ faults: HostIOFaults = HostIOFaults(), bundle selected: URL? = nil) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: selected ?? bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ values: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }; return try db.execute(statement, parametersJSON: json(values))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func inode(_ file: URL) throws -> String {
        var value = stat(); guard Darwin.lstat(file.path, &value) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.AvailabilityRecord { try XCTUnwrap(store.readAvailability()) }
    private func source(_ proof: NativeAttachmentFiles.CacheSourceProof) -> Store.Source {
        .init(sourceURI: proof.sourceURI, sha256: proof.sha256, size: proof.size, identity: proof.identity,
              cacheRootIdentity: proof.cacheRootIdentity, parentIdentity: proof.parentIdentity)
    }
    private func stage(_ proof: NativeAttachmentFiles.ReservedAttachmentStageProof) -> Store.Stage {
        .init(uri: proof.stageURI, identity: proof.stagedIdentity, directoryIdentity: proof.directoryIdentity, privateDirectoryIdentity: proof.privateDirectoryIdentity)
    }
    private func publication(_ proof: NativeAttachmentFiles.PublishedAttachmentProof) -> Store.Published {
        .init(sha256: proof.sha256, size: proof.size, identity: proof.identity, directoryIdentity: proof.directoryIdentity)
    }
    // Private bundle suffix produces JSON-string ordering for the frozen fixture.
    // The real V5 lineage consumer independently recomputes all patch policy.
    private func frozen(_ before: EditorDraftSnapshot, resolved: [String: Any], terminal: Bool) async throws -> (String, String) {
        let selected = try XCTUnwrap((object(before.payloadJSON)["attachments"] as? [[String: Any]])?.first)
        let identity = try json([attachmentID, selected["cloudKey"] ?? NSNull(), selected["fileHash"] ?? NSNull(), selected["contentRev"] ?? 0])
        let input = try json(["version": 1, "kind": "prepared-file-availability", "taskID": taskID, "requestId": operationID,
            "attachmentId": attachmentID, "identity": identity, "beforePayloadJSON": before.payloadJSON,
            "status": terminal ? "unrecoverable" : "available", "resolvedAttachmentJSON": try json(resolved)])
        let suffix = """
        ;(() => { const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll; let reply=null,proof=null;
          MindwtrHost.menuRead=(name,params)=>{ if(name!=='dataSettings')return oldMenu(name,params);
            if(proof)return MindwtrHost.attachmentDraftValidateLineageV5(JSON.stringify({version:5,taskID:proof.taskID,
              initialPayloadJSON:proof.beforePayloadJSON,beforePayloadJSON:proof.afterPayloadJSON,
              priorOperations:[{kind:'availability',operation:proof}],managedDirectoryURI:\(try json(managed.absoluteString))}));
            const f=JSON.parse(\(try json(input))),p=JSON.parse(f.beforePayloadJSON),r=JSON.parse(f.resolvedAttachmentJSON);
            const c=p.attachments[0];f.identity=JSON.stringify([c.id,c.cloudKey??null,c.fileHash??null,c.contentRev??0]);
            const patch=\(terminal ? "{cloudKey:r.cloudKey,fileHash:r.fileHash,localStatus:r.localStatus,deletedAt:r.deletedAt,updatedAt:r.updatedAt}" : "{uri:r.uri,localStatus:r.localStatus,...(!c.fileHash&&r.fileHash?{fileHash:r.fileHash}:{})}");
            const next={...c,...patch};p.attachments=p.attachments.map(a=>a.id===f.attachmentId?next:a);
            f.afterPayloadJSON=JSON.stringify(p);proof=f;reply=JSON.stringify({ok:true,value:{prepared:JSON.stringify(f),identity:f.identity}});return '1000000001'; };
          MindwtrHost.poll=id=>id==='1000000001'?(()=>{const r=reply;reply=null;return r;})():oldPoll(id);
        })();
        """
        let probe = root.appendingPathComponent("fixture-proof.js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: probe, atomically: true, encoding: .utf8)
        let producer = host(bundle: probe); _ = try await producer.start()
        let result = try object(await producer.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        let fields = result
        let validated = try object(await producer.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertEqual(validated["version"] as? Int, 5, "The fixture must pass actual shared V5 policy before writing its record")
        XCTAssertEqual(validated["payloadJSON"] as? String, try object(XCTUnwrap(fields["prepared"] as? String))["afterPayloadJSON"] as? String)
        await producer.close()
        return (try XCTUnwrap(fields["prepared"] as? String), try XCTUnwrap(fields["identity"] as? String))
    }
    private func seed(kind: String = "owned", phase: Store.Phase = .checkpointed, sameURI: Bool = false) async throws -> Store.AvailabilityRecord {
        let boot = host(); _ = try await boot.start(); await boot.close()
        let files = try NativeAttachmentFiles(libraryRoot: root)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let sourceURL = cache.appendingPathComponent("availability-source.txt"); try bytes.write(to: sourceURL)
        let sourceProof = try files.snapshotCacheSource(sourceURL.absoluteString)
        let originalURI = sameURI ? target.absoluteString : baseline.absoluteString
        let saved: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Saved source.txt", "uri": originalURI,
            "mimeType": "text/plain", "size": bytes.count, "createdAt": at, "updatedAt": at, "cloudKey": "attachments/fixture.txt",
            "fileHash": sourceProof.sha256.uppercased(), "contentRev": 7, "localStatus": "missing"]
        if !sameURI && kind != "none" { try Data("saved baseline bytes".utf8).write(to: baseline) }
        _ = try sql("INSERT INTO tasks(id,title,description,status,taskMode,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Saved title','Saved note','next','list','[]','[]',?,?,?,1,'fixture')", [taskID, json([saved]), at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy) VALUES ('other','Untouched','inbox','[]','[]',?,?,1,'fixture')", [at, at])
        let openingHost = host(); _ = try await openingHost.start()
        let opening = try object(await openingHost.call("editorModel", argumentsJSON: json([taskID])))
        scheduleBase = try XCTUnwrap(opening["scheduleBase"] as? [String: Any]); await openingHost.close()
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": ["title": "Saved title", "description": "Saved note"],
            "edited": ["title": "Dirty title", "description": "Dirty notes / 文"],
            "raw": ["title": "Dirty title", "note": "Dirty notes / 文", "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [saved], "attachments": [saved],
            "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        let before = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        var resolved = saved; resolved["uri"] = target.absoluteString; resolved["fileHash"] = sourceProof.sha256; resolved["localStatus"] = "available"
        if kind == "none" { resolved.removeValue(forKey: "cloudKey"); resolved.removeValue(forKey: "fileHash"); resolved["deletedAt"] = at; resolved["updatedAt"] = at; resolved["localStatus"] = "missing" }
        let (prepared, identity) = try await frozen(before, resolved: resolved, terminal: kind == "none")
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: taskID, generation: 2,
            payloadJSON: try XCTUnwrap(object(prepared)["afterPayloadJSON"] as? String))
        var resource: Store.AvailabilityResource = .none
        if kind == "borrowed" {
            try bytes.write(to: target)
            guard case .present(let proof) = try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString) else { throw HostFailure("Borrowed fixture unavailable") }
            resource = .borrowed(proof: .init(sha256: proof.sha256, size: proof.size, identity: proof.identity, directoryIdentity: proof.directoryIdentity))
        } else if kind == "owned" {
            let installer = try NativeAttachmentInstaller(managedRoot: managed, sourceRoots: [cache])
            let reserved = phase.rank >= Store.Phase.stagePrepared.rank ? try installer.prepareStage(targetURI: target.absoluteString, operationID: operationID.replacingOccurrences(of: "-", with: "")) : nil
            var filled: Store.Filled?, published: Store.Published?
            if let reserved, phase.rank >= Store.Phase.stageFilled.rank {
                let content = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: reserved)
                filled = .init(sha256: content.sha256, size: content.size, identity: reserved.stagedIdentity)
            }
            if let reserved, phase.rank >= Store.Phase.published.rank {
                _ = try installer.publishStage(stage: reserved, targetURI: target.absoluteString, sha256: sourceProof.sha256)
                published = publication(try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: reserved,
                    sha256: sourceProof.sha256, size: sourceProof.size))
            }
            resource = .owned(source: source(sourceProof), stage: reserved.map(stage), filled: filled, published: published)
        }
        let reply = phase.rank >= Store.Phase.resultDurable.rank ? try json(["version": 1, "status": kind == "none" ? "draftUnrecoverable" : "draftAvailable",
            "requestId": operationID, "sessionID": before.sessionID, "generation": 2, "attachmentId": attachmentID]) : nil
        let op = Store.AvailabilityOperation(requestId: operationID, requestJSON: try json(["version": 1, "requestId": operationID,
            "sessionID": before.sessionID, "generation": 1, "attachmentId": attachmentID, "identity": identity]), attachmentId: attachmentID,
            identity: identity, phase: phase, before: before, after: after, preparedJSON: prepared,
            targetURI: kind == "none" ? nil : target.absoluteString, resource: resource, replyJSON: reply)
        let checkpoint = phase == .checkpointed ? after : before
        let record = Store.AvailabilityRecord(session: .init(sessionID: before.sessionID, taskID: taskID, state: .active, checkpoint: checkpoint), operations: [op])
        try editor.checkpoint(checkpoint); _ = try store.writeAvailabilityAcknowledged(record)
        return record
    }
    private func request() throws -> String {
        let snapshot = try latest(), value = try object(snapshot.payloadJSON)
        return try json(["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": try XCTUnwrap(value["touchedBase"]),
            "patch": try XCTUnwrap(value["edited"]), "scheduleBase": try XCTUnwrap(scheduleBase),
            "checklist": ["base": try XCTUnwrap(value["checklistBase"]), "value": try XCTUnwrap(value["checklistValue"])],
            "attachments": ["base": try XCTUnwrap(value["attachmentsBase"]), "value": try XCTUnwrap(value["attachments"])]] as [String: Any])
    }
    private func save(_ host: CoreHost) async throws -> String {
        let snapshot = try latest(); return try await host.saveAttachmentDraftComplete(saveRequestJSON: request(), expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point { throw HostFailure("Synthetic boundary") } }
        await host.configureAttachmentDraftHost(hooks)
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    func testOwnedAvailabilityCompleteSaveColdAcknowledgmentPreservesExactBytesAndDirtyFields() async throws {
        let seeded = try await seed(), identity = try inode(target)
        XCTAssertNotEqual(seeded.operations[0].requestId, seeded.operations[0].attachmentId)
        let beforeRows = try rows(), sidecarBytes = try Data(contentsOf: store.url)
        let live = host(); _ = try await live.start()
        XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes)
        await boundary(.afterSaveTerminal, host: live)
        await refused { _ = try await self.save(live) }
        let saved = try rows(); await live.close()
        let cold = host(); let window = try object(await cold.start())
        XCTAssertNotNil(window["recovery"]); XCTAssertEqual(try rows(), saved)
        XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        let row = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT title,description,attachments,rev FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(row["title"] as? String, "Dirty title"); XCTAssertEqual(row["description"] as? String, "Dirty notes / 文"); XCTAssertEqual(row["rev"] as? Int, 2)
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(row["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments[0]["id"] as? String, attachmentID); XCTAssertEqual(attachments[0]["uri"] as? String, target.absoluteString)
        XCTAssertEqual(attachments[0]["fileHash"] as? String, (try object(seeded.operations[0].before.payloadJSON)["attachments"] as? [[String: Any]])?.first?["fileHash"] as? String)
    }
    func testBorrowedAndTerminalResumePreserveRawCheckpointAndDoNotClaimBytes() async throws {
        for kind in ["borrowed", "none"] {
            let parent = try XCTUnwrap(root); root = parent.appendingPathComponent(kind, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let seeded = try await seed(kind: kind), beforeRows = try rows(), checkpoint = try latest(), sidecarBytes = try Data(contentsOf: store.url)
            let live = host(); _ = try await live.start()
            let result = try object(await live.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation))
            XCTAssertEqual(result["version"] as? Int, 1); XCTAssertEqual(try latest(), checkpoint)
            XCTAssertEqual(try record(), seeded); XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes); XCTAssertEqual(try rows(), beforeRows)
            if kind == "borrowed" { XCTAssertEqual(try Data(contentsOf: target), bytes) }
            await live.close(); root = parent
        }
    }
    private func discard(_ host: CoreHost, requestId: String) async throws -> String {
        let value = try record()
        return try await host.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": requestId,
            "sessionID": value.session.sessionID, "generation": value.session.checkpoint.generation]))
    }
    private func finishDiscard(_ host: CoreHost, session: String, requestId: String) async throws -> String {
        try await host.finishAttachmentDraftDiscardV3(expectedSession: session, requestId: requestId)
    }
    private func pendingWrapper() throws -> [String: Any] {
        let pending = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(arguments.first))
    }
    private func terminalBody() throws -> [String: Any] {
        let command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        let raw = try XCTUnwrap(((command["terminal"] as? [String: Any])?["success"] as? [String: Any])?["_0"] as? String)
        return try object(raw)
    }
    private func concurrentTombstone() throws {
        let row = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        var attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(row["attachments"] as? String).utf8)) as? [[String: Any]])
        attachments[0]["deletedAt"] = "2026-10-07T12:01:00.000Z"; attachments[0]["updatedAt"] = "2026-10-07T12:01:00.000Z"
        _ = try sql("UPDATE tasks SET attachments=?,updatedAt=?,rev=2 WHERE id=?", [json(attachments), "2026-10-07T12:01:00.000Z", taskID])
    }
    func testOwnedNewURIControlledDiscardColdTerminalReplayPreservesSavedBaseline() async throws {
        let seeded = try await seed(), session = seeded.session.sessionID, requestID = UUID().uuidString.lowercased()
        let savedRows = try rows(), baselineBytes = try Data(contentsOf: baseline), baselineIdentity = try inode(baseline)
        let live = host(); _ = try await live.start()
        let decided = try object(await discard(live, requestId: requestID))
        XCTAssertEqual(decided["status"] as? String, "cleanupPending"); XCTAssertNil(try editor.read())
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try Data(contentsOf: target), bytes)
        await boundary(.afterDiscardTerminal, host: live)
        await refused { _ = try await self.finishDiscard(live, session: session, requestId: requestID) }
        let wrapper = try pendingWrapper(); XCTAssertEqual(wrapper["version"] as? Int, 7); XCTAssertEqual(wrapper["historyVersion"] as? Int, 5)
        let result = try terminalBody(), operations = try XCTUnwrap(result["operations"] as? [[String: Any]])
        XCTAssertEqual(operations[0]["target"] as? String, "removed"); XCTAssertEqual(operations[0]["stage"] as? String, "missing")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); await live.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try Data(contentsOf: baseline), baselineBytes); XCTAssertEqual(try inode(baseline), baselineIdentity)
    }
    func testBorrowedNoneAndSameBaselineDiscardNeverClaimPhysicalBytes() async throws {
        let parent = try XCTUnwrap(root)
        for (kind, sameURI) in [("borrowed", false), ("none", false), ("borrowed", true), ("owned", true)] {
            root = parent.appendingPathComponent(kind + "-" + String(sameURI), isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let seeded = try await seed(kind: kind, sameURI: sameURI), id = UUID().uuidString.lowercased(), savedRows = try rows()
            let identity = kind == "none" ? nil : try inode(target)
            let live = host(); _ = try await live.start(); _ = try await discard(live, requestId: id)
            let result = try object(await finishDiscard(live, session: seeded.session.sessionID, requestId: id))
            let operations = try XCTUnwrap(result["operations"] as? [[String: Any]])
            XCTAssertEqual(operations[0]["target"] as? String, kind == "borrowed" && !sameURI ? "notOwned" : "untouched")
            XCTAssertEqual(operations[0]["stage"] as? String, kind == "owned" ? "missing" : "unclaimed")
            if let identity { XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes) }
            XCTAssertEqual(try rows(), savedRows); XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read())
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await live.close()
        }
        root = parent
    }
    func testAllRecordedOwnedPhasesRecoverWithoutChangingTaskRows() async throws {
        let parent = try XCTUnwrap(root)
        for phase in [Store.Phase.intent, .stagePrepared, .stageFilled, .published, .resultDurable] {
            root = parent.appendingPathComponent(phase.rawValue, isDirectory: true); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let seeded = try await seed(phase: phase), beforeRows = try rows(), before = try latest()
            let live = host(); _ = try await live.start()
            let summary = try object(await live.recoverAttachmentDraftV3(expectedSession: seeded.session.sessionID))
            XCTAssertEqual(summary["version"] as? Int, 5); XCTAssertEqual(try record().operations[0].phase, .checkpointed)
            XCTAssertEqual(try latest(), seeded.operations[0].after); XCTAssertNotEqual(try latest(), before)
            XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try Data(contentsOf: target), bytes)
            await live.close(); let cold = host(); _ = try await cold.start()
            _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: seeded.session.sessionID, expectedGeneration: 2)
            XCTAssertEqual(try rows(), beforeRows); await cold.close()
        }
        root = parent
    }
    func testPublicationLostAcknowledgmentReprovesRecordedInodeAcrossColdRecovery() async throws {
        let seeded = try await seed(phase: .stageFilled), savedRows = try rows(), live = host(); _ = try await live.start()
        await boundary(.afterPublication, host: live)
        await refused { _ = try await live.recoverAttachmentDraftV3(expectedSession: seeded.session.sessionID) }
        XCTAssertEqual(try record().operations[0].phase, .stageFilled)
        let identity = try inode(target); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), savedRows); await live.close()
        let cold = host(); _ = try await cold.start(); _ = try await cold.recoverAttachmentDraftV3(expectedSession: seeded.session.sessionID)
        XCTAssertEqual(try record().operations[0].phase, .checkpointed); XCTAssertEqual(try inode(target), identity)
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try latest(), seeded.operations[0].after)
    }
    func testBorrowedSameBaselineConcurrentTombstoneSaveRetainsTruthfulNotOwnedOutcome() async throws {
        let seeded = try await seed(kind: "borrowed", sameURI: true), identity = try inode(target)
        try concurrentTombstone()
        let live = host(); _ = try await live.start(); await boundary(.afterSaveSettled, host: live)
        await refused { _ = try await self.save(live) }
        let wrapper = try pendingWrapper(), candidates = try XCTUnwrap(wrapper["candidates"] as? [[String: Any]])
        XCTAssertEqual((candidates[0]["authority"] as? [String: Any])?["kind"] as? String, "borrowedAvailability")
        let terminal = try terminalBody(); XCTAssertEqual(terminal["phase"] as? String, "settled")
        XCTAssertEqual((terminal["targets"] as? [[String: Any]])?.first?["outcome"] as? String, "notOwned")
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        let saved = try rows(); await live.close(); let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertNil(try store.readAvailability())
        XCTAssertEqual(seeded.operations[0].attachmentId, attachmentID)
    }
    func testOwnedSameBaselineReplacementCannotDowngradeToBaselineObservation() async throws {
        _ = try await seed(sameURI: true); try concurrentTombstone()
        var physicalJobs = 0
        let fileHooks = NativeAttachmentHostHooks(); fileHooks.configureJobs = { jobs in
            jobs.beforeWork = { _, _ in physicalJobs += 1 }
        }
        let live = host(); try await live.configureAttachmentHost(fileHooks)
        _ = try await live.start(); await boundary(.afterSaveTerminal, host: live)
        await refused { _ = try await self.save(live) }
        let wrapper = try pendingWrapper(), candidates = try XCTUnwrap(wrapper["candidates"] as? [[String: Any]])
        XCTAssertEqual((candidates[0]["authority"] as? [String: Any])?["kind"] as? String, "ownedAvailability")
        let replacement = root.appendingPathComponent("replacement.txt"); try bytes.write(to: replacement)
        try FileManager.default.removeItem(at: target); try FileManager.default.moveItem(at: replacement, to: target)
        // Remove only the conservative durable tombstone reference so retry
        // must reprove the recorded owned publication, rather than keep it.
        _ = try sql("UPDATE tasks SET attachments='[]' WHERE id=?", [taskID])
        let replacementIdentity = try inode(target), saved = try rows()
        physicalJobs = 0
        await live.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        await refused { _ = try await live.retryPending() }
        XCTAssertGreaterThan(physicalJobs, 0, "Retry must reach the recorded physical proof")
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), replacementIdentity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertNotNil(try store.readAvailability()); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
    }
    func testDurableOnlyReferenceRetainsBytesWithTruthfulSelectedDiscardSettlement() async throws {
        let seeded = try await seed(), id = UUID().uuidString.lowercased(), identity = try inode(target)
        let live = host(); _ = try await live.start(); _ = try await discard(live, requestId: id)
        var reference = try XCTUnwrap((object(seeded.operations[0].after.payloadJSON)["attachments"] as? [[String: Any]])?.first)
        reference["id"] = "independent-reference"
        _ = try sql("UPDATE tasks SET attachments=? WHERE id='other'", [json([reference])])
        let saved = try rows(), sidecar = try Data(contentsOf: store.url)
        await boundary(.afterDiscardTerminal, host: live)
        await refused { _ = try await self.finishDiscard(live, session: seeded.session.sessionID, requestId: id) }
        XCTAssertEqual(((try terminalBody())["operations"] as? [[String: Any]])?.first?["target"] as? String, "referenced")
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try rows(), saved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await live.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), saved)
        XCTAssertNil(try store.readAvailability()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testSidecarAndEditorSameByteReplacementRefuseBeforeSaveCommit() async throws {
        let parent = try XCTUnwrap(root)
        for fileName in ["sidecar", "editor"] {
            root = parent.appendingPathComponent(fileName, isDirectory: true); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            _ = try await seed(); let beforeRows = try rows(), targetIdentity = try inode(target), live = host(); _ = try await live.start()
            let replaced = fileName == "sidecar" ? store.url : editor.url
            var hit = false
            let hooks = AttachmentDraftHostHooks(); hooks.boundary = { point in
                guard point == .beforeSaveCommit else { return }; hit = true
                let original = try Data(contentsOf: replaced), replacement = replaced.appendingPathExtension("replacement")
                try original.write(to: replacement); try FileManager.default.removeItem(at: replaced); try FileManager.default.moveItem(at: replacement, to: replaced)
            }
            await live.configureAttachmentDraftHost(hooks)
            await refused { _ = try await self.save(live) }
            XCTAssertTrue(hit); XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try inode(target), targetIdentity)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNotNil(try editor.read())
            await live.close()
        }
        root = parent
    }

    func testRawReferenceWriterCannotRaceSelectedOwnedDiscardUnlink() async throws {
        let seeded = try await seed(), id = UUID().uuidString.lowercased(), beforeRows = try rows()
        let reference = try XCTUnwrap((object(seeded.operations[0].after.payloadJSON)["attachments"] as? [[String: Any]])?.first)
        var attempted = false, blocked = false
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in jobs.beforeRetirementUnlink = {
            attempted = true
            let writer = try SQLiteBridge(url: self.database); defer { writer.close() }
            _ = try writer.execute("PRAGMA busy_timeout=10")
            do { _ = try writer.execute("UPDATE tasks SET attachments=? WHERE id='other'", parametersJSON: self.json([try self.json([reference])])) }
            catch { blocked = true }
        } }
        let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        _ = try await discard(live, requestId: id); _ = try await finishDiscard(live, session: seeded.session.sessionID, requestId: id)
        XCTAssertTrue(attempted); XCTAssertTrue(blocked); XCTAssertEqual(try rows(), beforeRows)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertNil(try store.readAvailability())
    }
    func testCheckpointAdvanceColdCompletionPreservesExactOpaqueBuffers() async throws {
        let seeded = try await seed(), beforeRows = try rows(), before = try latest(), live = host(); _ = try await live.start()
        var payload = try object(before.payloadJSON), raw = try XCTUnwrap(payload["raw"] as? [String: Any])
        raw["note"] = "Unresolved e\u{301} / \n"; raw["estimate"] = "not-a-number"; payload["raw"] = raw
        let next = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: 3, payloadJSON: try json(payload))
        await boundary(.afterAdvanceEditor, host: live)
        await refused { try await live.checkpointEditorDraft(next) }
        XCTAssertEqual(try latest(), next); XCTAssertNotNil(try record().checkpointAdvance); XCTAssertEqual(try rows(), beforeRows)
        await live.close(); let cold = host(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: seeded.session.sessionID)
        XCTAssertEqual(try latest(), next); XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try record().session.checkpoint, next)
        XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testStructurallyValidFrozenPolicyTamperRefusesWithoutMutation() async throws {
        let seeded = try await seed(), op = seeded.operations[0]
        var prepared = try object(op.preparedJSON), resolved = try object(XCTUnwrap(prepared["resolvedAttachmentJSON"] as? String))
        resolved["cloudKey"] = "different-remote-object"; prepared["resolvedAttachmentJSON"] = try json(resolved)
        let altered = Store.AvailabilityOperation(requestId: op.requestId, requestJSON: op.requestJSON, attachmentId: op.attachmentId,
            identity: op.identity, phase: op.phase, before: op.before, after: op.after, preparedJSON: try json(prepared),
            targetURI: op.targetURI, resource: op.resource, replyJSON: op.replyJSON)
        let record = Store.AvailabilityRecord(session: seeded.session, operations: [altered])
        _ = try Store.availabilityFingerprint(record)
        try DurableFile.write(JSONEncoder().encode(record), to: store.url, privateDraft: true)
        let sidecar = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url), checkpoint = try latest(), editorIdentity = try inode(editor.url)
        let rows = try self.rows(), targetIdentity = try inode(target), live = host(); _ = try await live.start()
        await refused { _ = try await live.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation) }
        await refused { _ = try await self.save(live) }
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try inode(store.url), sidecarIdentity)
        XCTAssertEqual(try latest(), checkpoint); XCTAssertEqual(try inode(editor.url), editorIdentity); XCTAssertEqual(try self.rows(), rows)
        XCTAssertEqual(try inode(target), targetIdentity); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOwnedSameBaselineTombstoneSaveRetainsBytesAndSettlesConservatively() async throws {
        _ = try await seed(sameURI: true); let identity = try inode(target); try concurrentTombstone()
        let live = host(); _ = try await live.start(); await boundary(.afterSaveSettled, host: live)
        await refused { _ = try await self.save(live) }
        XCTAssertEqual(((try pendingWrapper())["candidates"] as? [[String: Any]])?.first?["authority"] as? [String: String], ["kind": "ownedAvailability", "requestId": operationID])
        XCTAssertEqual(((try terminalBody())["targets"] as? [[String: Any]])?.first?["outcome"] as? String, "referenced")
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        let saved = try rows(); await live.close(); let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertNil(try store.readAvailability())
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testSelectedSaveTaskChangedOutcomeColdReplayKeepsOwnedBytes() async throws {
        _ = try await seed(sameURI: true); try concurrentTombstone()
        let live = host(); _ = try await live.start(); await boundary(.afterSaveTerminal, host: live)
        await refused { _ = try await self.save(live) }; await live.close()
        _ = try sql("UPDATE tasks SET deletedAt=?,updatedAt=?,rev=rev+1 WHERE id=?", ["2026-10-07T12:02:00.000Z", "2026-10-07T12:02:00.000Z", taskID])
        let moved = try rows(), identity = try inode(target), cold = host()
        await boundary(.afterSaveSettled, host: cold)
        await refused { _ = try await cold.start() }
        XCTAssertEqual(((try terminalBody())["targets"] as? [[String: Any]])?.first?["outcome"] as? String, "taskChanged")
        XCTAssertEqual(try rows(), moved); XCTAssertEqual(try inode(target), identity); await cold.close()
        let final = host(); _ = try await final.start()
        XCTAssertEqual(try rows(), moved); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        XCTAssertNil(try store.readAvailability()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testUncommittedAvailabilityTaskChangedTerminalRefusesBeforeJournalRewrite() async throws {
        let seeded = try await seed(); try concurrentTombstone()
        XCTAssertNotEqual(seeded.operations[0].targetURI,
            (try object(seeded.operations[0].before.payloadJSON)["attachmentsBase"] as? [[String: Any]])?.first?["uri"] as? String)
        let live = host(); _ = try await live.start()
        var reached = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { point in
            if point == .afterSaveTerminal { reached = true; throw HostFailure("Synthetic terminal boundary") }
        }
        await live.configureAttachmentDraftHost(hooks)
        await refused { _ = try await self.save(live) }; XCTAssertTrue(reached)
        let wrapper = try pendingWrapper(), candidates = try XCTUnwrap(wrapper["candidates"] as? [[String: Any]])
        let selected = try XCTUnwrap(candidates.firstIndex { ($0["authority"] as? [String: Any])?["kind"] as? String == "ownedAvailability" })
        var state = try terminalBody(), targets = try XCTUnwrap(state["targets"] as? [[String: Any]])
        for index in 0...selected { targets[index]["outcome"] = index == selected ? "taskChanged" : "referenced" }
        state["targets"] = targets
        var command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        command["terminal"] = ["success": ["_0": try json(state)]]
        await live.close(); try DurableFile.write(Data(json(command).utf8), to: journal, privateDraft: true)
        let journalBytes = try Data(contentsOf: journal), journalIdentity = try inode(journal)
        let sidecarBytes = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url)
        let editorBytes = try Data(contentsOf: editor.url), editorIdentity = try inode(editor.url)
        let saved = try rows(), targetIdentity = try inode(target), baselineIdentity = try inode(baseline), baselineBytes = try Data(contentsOf: baseline)
        let cold = host(); await refused { _ = try await cold.start() }
        XCTAssertEqual(try Data(contentsOf: journal), journalBytes); XCTAssertEqual(try inode(journal), journalIdentity)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes); XCTAssertEqual(try inode(store.url), sidecarIdentity)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(editor.url), editorIdentity)
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), targetIdentity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try inode(baseline), baselineIdentity); XCTAssertEqual(try Data(contentsOf: baseline), baselineBytes)
    }
    func testUnicodeAttachmentIDAtSharedBoundCanDiscardTerminalOutcome() async throws {
        attachmentID = String(repeating: "😀", count: 250)
        XCTAssertEqual(attachmentID.utf16.count, 500); XCTAssertEqual(attachmentID.utf8.count, 1000)
        let seeded = try await seed(kind: "none"), savedRows = try rows(), id = UUID().uuidString.lowercased(), live = host()
        _ = try await live.start(); _ = try await discard(live, requestId: id)
        let result = try object(await finishDiscard(live, session: seeded.session.sessionID, requestId: id))
        XCTAssertEqual(result["version"] as? Int, 7); XCTAssertEqual(try rows(), savedRows)
        XCTAssertEqual((result["operations"] as? [[String: Any]])?.first?["target"] as? String, "untouched")
        XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read())
    }
    func testCanonicalEquivalentDiscardAttachmentTupleRefusesWithoutJournalRewrite() async throws {
        attachmentID = "café"; let seeded = try await seed(kind: "none"), id = UUID().uuidString.lowercased(), live = host()
        _ = try await live.start(); _ = try await discard(live, requestId: id); await boundary(.afterDiscardFinishJournal, host: live)
        await refused { _ = try await self.finishDiscard(live, session: seeded.session.sessionID, requestId: id) }; await live.close()
        var command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)), wrapper = try pendingWrapper()
        var operations = try XCTUnwrap(wrapper["operations"] as? [[String: Any]])
        operations[0]["attachmentId"] = "cafe\u{301}"; wrapper["operations"] = operations; command["argumentsJSON"] = try json([json(wrapper)])
        try DurableFile.write(Data(json(command).utf8), to: journal, privateDraft: true)
        let beforeJournal = try Data(contentsOf: journal), journalIdentity = try inode(journal), sidecar = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url)
        let sourceURL = cache.appendingPathComponent("availability-source.txt")
        let saved = try rows(), identity = try inode(sourceURL), cold = host()
        await refused { _ = try await cold.start() }
        XCTAssertEqual(try Data(contentsOf: journal), beforeJournal); XCTAssertEqual(try inode(journal), journalIdentity)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try inode(store.url), sidecarIdentity)
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(sourceURL), identity); XCTAssertEqual(try Data(contentsOf: sourceURL), bytes)
    }
    func testAlreadyCancelledSelectedSaveLeavesAllEvidenceAndRowsUntouched() async throws {
        _ = try await seed(); let checkpoint = try latest(), beforeRows = try rows(), sidecar = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url), editorIdentity = try inode(editor.url)
        var jobs = 0; let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { queue in queue.beforeWork = { _, _ in jobs += 1 } }
        let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let operation = Task { withUnsafeCurrentTask { $0?.cancel() }; return try await self.save(live) }
        await refused { _ = try await operation.value }
        XCTAssertEqual(jobs, 0); XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try latest(), checkpoint)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try inode(store.url), sidecarIdentity); XCTAssertEqual(try inode(editor.url), editorIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testHistoricalSaveWrappersRejectAvailabilityAuthorityBeforeAnyRewrite() async throws {
        let parent = try XCTUnwrap(root)
        for wrapperVersion in [2, 3, 4] {
            root = parent.appendingPathComponent("sealed-" + String(wrapperVersion), isDirectory: true); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let seeded = try await seed(), initial = seeded.operations[0].before
            var historicalPayload = try object(initial.payloadJSON)
            if wrapperVersion == 2 {
                // The sealed legacy Save checkpoint predates complete checklist ownership.
                historicalPayload.removeValue(forKey: "checklistBase"); historicalPayload.removeValue(forKey: "checklistValue")
            }
            let original = EditorDraftSnapshot(sessionID: initial.sessionID, taskID: initial.taskID, generation: initial.generation,
                payloadJSON: wrapperVersion == 2 ? try json(historicalPayload) : initial.payloadJSON)
            try DurableFile.remove(store.url); try editor.discardMatching(expected: latest()); try editor.checkpoint(original)
            let live = host(); _ = try await live.start()
            if wrapperVersion == 4 { _ = try await live.beginAttachmentDraftV4(expectedSession: original.sessionID, expectedGeneration: original.generation) }
            else { _ = try await live.beginAttachmentDraftV3(expectedSession: original.sessionID, expectedGeneration: original.generation) }
            let picked = cache.appendingPathComponent("historical-picked.txt"), addID = UUID().uuidString.lowercased()
            if wrapperVersion == 4 { _ = try await live.addProviderAttachmentV4(selectedURL: pickedSource(picked), expectedSession: original.sessionID, expectedGeneration: original.generation, requestId: addID) }
            else { _ = try await live.addProviderAttachmentV3(selectedURL: pickedSource(picked), expectedSession: original.sessionID, expectedGeneration: original.generation, requestId: addID) }
            let current = try latest()
            _ = try await live.removeAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
                "sessionID": current.sessionID, "generation": current.generation, "attachmentId": attachmentID]))
            var reachedJournal = false
            let journalHooks = AttachmentDraftHostHooks(); journalHooks.boundary = { point in
                if point == .afterSaveJournal { reachedJournal = true; throw HostFailure("Synthetic journal boundary") }
            }
            await live.configureAttachmentDraftHost(journalHooks)
            if wrapperVersion == 2 {
                let value = try object(latest().payloadJSON), checkpoint = try latest()
                let legacySchedule = Dictionary(uniqueKeysWithValues: ["startTime", "dueDate", "relativeStartOffset", "reviewAt"].map {
                    ($0, scheduleBase[$0] ?? NSNull())
                })
                let legacy = try json(["id": taskID, "base": try XCTUnwrap(value["touchedBase"]), "patch": try XCTUnwrap(value["edited"]),
                    "scheduleBase": legacySchedule, "attachments": ["base": try XCTUnwrap(value["attachmentsBase"]), "value": try XCTUnwrap(value["attachments"])]] as [String: Any])
                do { _ = try await live.saveAttachmentDraftMixed(saveRequestJSON: legacy, expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation) }
                catch { XCTAssertTrue(reachedJournal, "Historical wrapper2 refused before its journal cut: \(type(of: error)) \(error)") }
            } else { await refused { _ = try await self.save(live) } }
            XCTAssertTrue(reachedJournal, "Historical wrapper\(wrapperVersion) must reach its actual journal")
            var wrapper = try pendingWrapper(), command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
            XCTAssertEqual(wrapper["version"] as? Int, wrapperVersion)
            var candidates = try XCTUnwrap(wrapper["candidates"] as? [[String: Any]])
            XCTAssertFalse(candidates.isEmpty); candidates[0]["authority"] = ["kind": "borrowedAvailability", "requestId": operationID]
            wrapper["candidates"] = candidates; command["argumentsJSON"] = try json([json(wrapper)])
            await live.close(); try DurableFile.write(Data(json(command).utf8), to: journal, privateDraft: true)
            let journalBytes = try Data(contentsOf: journal), journalIdentity = try inode(journal), sidecarBytes = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url)
            let editorBytes = try Data(contentsOf: editor.url), editorIdentity = try inode(editor.url), beforeRows = try rows(), targetIdentity = try inode(target)
            let cold = host(); await refused { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: journal), journalBytes); XCTAssertEqual(try inode(journal), journalIdentity)
            XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes); XCTAssertEqual(try inode(store.url), sidecarIdentity)
            XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try inode(editor.url), editorIdentity)
            XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try inode(target), targetIdentity); await cold.close()
        }
        root = parent
    }
    private func pickedSource(_ url: URL) throws -> URL { try bytes.write(to: url); return url }
    func testBorrowedGenerationReplacementRefusesSaveButDiscardNeverDeletesReplacement() async throws {
        let seeded = try await seed(kind: "borrowed"), beforeRows = try rows(), beforeEditor = try latest()
        let replacement = root.appendingPathComponent("borrowed-replacement"); try bytes.write(to: replacement)
        try FileManager.default.removeItem(at: target); try FileManager.default.moveItem(at: replacement, to: target)
        let identity = try inode(target), sidecar = try Data(contentsOf: store.url), live = host(); _ = try await live.start()
        await refused { _ = try await self.save(live) }
        XCTAssertEqual(try rows(), beforeRows); XCTAssertEqual(try latest(), beforeEditor); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let id = UUID().uuidString.lowercased(); _ = try await discard(live, requestId: id)
        let result = try object(await finishDiscard(live, session: seeded.session.sessionID, requestId: id))
        XCTAssertEqual((result["operations"] as? [[String: Any]])?.first?["target"] as? String, "notOwned")
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), beforeRows)
    }
    func testMatchingForeignBytesCannotReplaceRecordedOwnedPublicationProof() async throws {
        let seeded = try await seed(phase: .stageFilled), savedRows = try rows(), checkpoint = try latest()
        guard case .owned(_, let reserved?, _, _) = seeded.operations[0].resource else { return XCTFail("Expected owned stage") }
        let stageURL = try XCTUnwrap(URL(string: reserved.uri)), retainedStage = root.appendingPathComponent("retained-stage")
        try FileManager.default.moveItem(at: stageURL, to: retainedStage); try bytes.write(to: target)
        let foreignIdentity = try inode(target), stageIdentity = try inode(retainedStage)
        let live = host(); _ = try await live.start()
        await refused { _ = try await live.recoverAttachmentDraftV3(expectedSession: seeded.session.sessionID) }
        let retained = try record()
        // A valid recovery re-ACK may re-encode the sidecar. Its frozen strings
        // and every recorded resource receipt must remain the original proof.
        XCTAssertEqual(retained, seeded)
        let original = seeded.operations[0], actual = retained.operations[0]
        XCTAssertEqual(Data(actual.requestJSON.utf8), Data(original.requestJSON.utf8))
        XCTAssertEqual(Data(actual.preparedJSON.utf8), Data(original.preparedJSON.utf8))
        XCTAssertEqual(Data(actual.identity.utf8), Data(original.identity.utf8))
        XCTAssertEqual(Data(actual.before.payloadJSON.utf8), Data(original.before.payloadJSON.utf8))
        XCTAssertEqual(Data(actual.after.payloadJSON.utf8), Data(original.after.payloadJSON.utf8))
        XCTAssertEqual(actual.replyJSON.map { Data($0.utf8) }, original.replyJSON.map { Data($0.utf8) })
        XCTAssertEqual(actual.resource, original.resource)
        XCTAssertEqual(try rows(), savedRows); XCTAssertEqual(try latest(), checkpoint)
        XCTAssertEqual(try inode(target), foreignIdentity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try inode(retainedStage), stageIdentity); XCTAssertEqual(try Data(contentsOf: retainedStage), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

}
