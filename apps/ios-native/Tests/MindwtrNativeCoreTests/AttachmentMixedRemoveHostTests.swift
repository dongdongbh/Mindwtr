import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore


final class AttachmentMixedRemoveHostTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "mixed-remove-task"
    private let at = "2026-10-05T12:00:00.000Z"
    private let attachmentID = "baseline:文"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task258-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func core() -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle)
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
    private func seed(cloudOnly: Bool = false, begin: Bool = true, attachmentCount: Int = 1,
                      extra: String = "opaque e\u{301} / 文") async throws -> (CoreHost, EditorDraftSnapshot) {
        let boot = core(); _ = try await boot.start(); await boot.close()
        var attachment: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Renamed.bin", "mimeType": "text/plain",
            "size": 25, "uri": "", "createdAt": at, "updatedAt": at, "localStatus": cloudOnly ? "missing" : "available", "cloudKey": "retained-cloud-object"]
        if !cloudOnly {
            try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
            let target = managed.appendingPathComponent("historical-original.txt")
            try Data("baseline bytes / 文".utf8).write(to: target); attachment["uri"] = target.absoluteString
        }
        let attachments = (0..<attachmentCount).map { index -> [String: Any] in
            var row = attachment; row["id"] = index == 0 ? attachmentID : attachmentID + ":\(index)"; return row
        }
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'inbox','[]','[]',?,?,?,1,'fixture')", [taskID, "Saved title", json(attachments), at, at])
        let host = core(); _ = try await host.start()
        let payload = try json(["version": 2, "taskID": taskID, "attachmentsOwned": true,
            "attachmentsBase": attachments, "attachments": attachments, "title": "Private raw title",
            "unknownEditorField": ["nested": ["retained": extra]]] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        if begin { _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation) }
        return (host, snapshot)
    }
    private func request(_ before: EditorDraftSnapshot, id: String = UUID().uuidString.lowercased(), attachment: String? = nil) throws -> String {
        try json(["version": 1, "requestId": id, "sessionID": before.sessionID, "generation": before.generation, "attachmentId": attachment ?? attachmentID])
    }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func removeOp() throws -> Store.RemoveOperation {
        guard case .remove(let op) = try XCTUnwrap(record().operations.last) else { throw HostFailure("Expected retained Remove") }
        return op
    }
    private func identity(_ url: URL) throws -> String {
        var info = stat(); guard lstat(url.path, &info) == 0 else { throw HostFailure("Fixture identity unavailable") }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func same(_ actual: EditorDraftSnapshot, _ expected: EditorDraftSnapshot, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.sessionID, expected.sessionID, file: file, line: line)
        XCTAssertEqual(actual.taskID, expected.taskID, file: file, line: line)
        XCTAssertEqual(actual.generation, expected.generation, file: file, line: line)
        XCTAssertEqual(Data(actual.payloadJSON.utf8), Data(expected.payloadJSON.utf8), file: file, line: line)
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Operation must refuse", file: file, line: line) }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("Private raw title"), file: file, line: line)
        }
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), next = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true); root = next; return previous
    }
    private func edited(_ before: EditorDraftSnapshot, generation: Int? = nil) throws -> EditorDraftSnapshot {
        var payload = try object(before.payloadJSON)
        payload["title"] = "Later raw title"; payload["notes"] = "Unsaved notes / 文"
        return .init(sessionID: before.sessionID, taskID: before.taskID, generation: generation ?? before.generation + 3,
            payloadJSON: " \n" + (try json(payload)) + "\n")
    }
    private func acknowledgmentCount() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        let value = FileManager.default.fileExists(atPath: log.path) ? try String(contentsOf: log) : ""
        return value.components(separatedBy: "\"operation\":\"remove\"").count - 1
    }
    private func advanceCapacityCandidates(_ record: Store.MixedRecord, after: EditorDraftSnapshot) throws -> [Store.MixedRecord] {
        let pending = Store.MixedRecord(session: record.session, operations: record.operations,
            checkpointAdvance: .init(before: record.session.checkpoint, after: after))
        let settled = Store.MixedRecord(session: .init(sessionID: after.sessionID, taskID: after.taskID,
            state: .active, checkpoint: after), operations: record.operations)
        let id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try json(["version": 1, "requestId": id, "sessionID": after.sessionID, "generation": after.generation])
        let reply = try json(["version": 1, "status": "cleanupPending", "requestId": id, "sessionID": after.sessionID])
        let discards = [Store.DiscardPhase.decided, .detached].map { phase in
            Store.MixedRecord(session: .init(sessionID: after.sessionID, taskID: after.taskID,
                state: .cleanupPending, checkpoint: after), operations: record.operations,
                discard: .init(requestId: id, requestJSON: request, expected: after,
                    phase: phase, replyJSON: phase == .detached ? reply : nil))
        }
        return [pending, settled] + discards
    }

    func testBaselineRemoveChangesOnlyPrivateMetadataAndRecordsExactFrozenReply() async throws {
        let (host, before) = try await seed()
        let target = managed.appendingPathComponent("historical-original.txt"), targetData = try Data(contentsOf: target)
        let source = cache.appendingPathComponent("source-sentinel.bin"), sourceData = Data("source sentinel".utf8)
        try sourceData.write(to: source)
        let domainBefore = try domain(), entries = try FileManager.default.contentsOfDirectory(atPath: managed.path)
        let raw = try request(before), acknowledgments = try acknowledgmentCount()
        let returned = try await host.removeAttachmentDraftV3(requestJSON: raw), op = try removeOp(), after = try latest()
        XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(returned, op.replyJSON)
        same(after, op.after); same(try record().session.checkpoint, after)
        XCTAssertEqual(after.generation, before.generation + 1)
        let frozen = try object(op.preparedJSON), afterPayload = try object(after.payloadJSON), beforePayload = try object(before.payloadJSON)
        let attachment = try XCTUnwrap((afterPayload["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(attachment["deletedAt"] as? String, frozen["removedAt"] as? String)
        XCTAssertEqual(attachment["updatedAt"] as? String, frozen["removedAt"] as? String)
        XCTAssertEqual(try json(afterPayload["attachmentsBase"]!), try json(beforePayload["attachmentsBase"]!))
        XCTAssertEqual(try json(afterPayload["unknownEditorField"]!), try json(beforePayload["unknownEditorField"]!))
        XCTAssertEqual(attachment["cloudKey"] as? String, "retained-cloud-object")
        XCTAssertEqual(try Data(contentsOf: target), targetData); XCTAssertEqual(try Data(contentsOf: source), sourceData)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), entries)
        XCTAssertEqual(try domain(), domainBefore); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try acknowledgmentCount(), acknowledgments + 1)
    }

    func testCloudOnlyEmptyURIRequiresNoManagedDirectoryOrFileJob() async throws {
        let (host, before) = try await seed(cloudOnly: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        let domainBefore = try domain(), raw = try request(before)
        let reply = try object(await host.removeAttachmentDraftV3(requestJSON: raw))
        XCTAssertEqual(reply["status"] as? String, "draftRemoved")
        let row = try XCTUnwrap((object(latest().payloadJSON)["attachments"] as? [[String: Any]])?.first)
        XCTAssertNotNil(row["deletedAt"]); XCTAssertEqual(row["uri"] as? String, "")
        XCTAssertEqual(row["cloudKey"] as? String, "retained-cloud-object")
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)); XCTAssertEqual(try domain(), domainBefore)
    }

    func testExactHistoricalUUIDReplayAfterColdHostAndLaterCheckpointNeverRewinds() async throws {
        let (host, before) = try await seed(), raw = try request(before)
        let firstReply = try await host.removeAttachmentDraftV3(requestJSON: raw), frozen = try removeOp().preparedJSON
        let later = try edited(latest())
        try await host.checkpointEditorDraft(later)
        let sidecar = try encoded(record()), domainBefore = try domain()
        await host.close(); let cold = core(); _ = try await cold.start()
        let begun = try object(await cold.beginAttachmentDraftV3(expectedSession: later.sessionID, expectedGeneration: later.generation))
        XCTAssertEqual(begun["version"] as? Int, 3)
        let replay = try await cold.removeAttachmentDraftV3(requestJSON: raw)
        XCTAssertEqual(replay, firstReply); same(try latest(), later)
        XCTAssertEqual(try removeOp().preparedJSON, frozen); XCTAssertEqual(try encoded(record()), sidecar)
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: later.sessionID)
        same(try latest(), later); XCTAssertEqual(try domain(), domainBefore)
        let changed = try request(before, id: try XCTUnwrap(object(raw)["requestId"] as? String), attachment: "other")
        await refused { _ = try await cold.removeAttachmentDraftV3(requestJSON: changed) }
        same(try latest(), later); XCTAssertEqual(try encoded(record()), sidecar)
    }

    func testColdRemoveRecoveryAtIntentEditorAndMarkerBoundariesUsesOneFrozenTimestamp() async throws {
        for boundary in [AttachmentDraftBoundary.afterIntent, .afterCheckpoint, .afterMarker] {
            let parent = try isolate()
            let (host, before) = try await seed(), raw = try request(before), domainBefore = try domain()
            let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == boundary { throw HostFailure("Injected private boundary") } }
            await host.configureAttachmentDraftHost(hooks)
            await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) }
            let retained = try removeOp(), frozen = retained.preparedJSON
            XCTAssertEqual(retained.phase, boundary == .afterMarker ? .checkpointed : .intent)
            same(try latest(), boundary == .afterIntent ? retained.before : retained.after)
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
            let reply = try await cold.removeAttachmentDraftV3(requestJSON: raw)
            XCTAssertEqual(reply, try removeOp().replyJSON); XCTAssertEqual(try removeOp().preparedJSON, frozen)
            same(try latest(), retained.after); XCTAssertEqual(try record().operations.count, 1)
            XCTAssertEqual(try domain(), domainBefore); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await cold.close(); root = parent
        }
    }

    func testV3SummaryIsReadOnlyAndLegacyEntryPointsStaySealed() async throws {
        let (host, before) = try await seed(), bytes = try Data(contentsOf: store.url), inode = try identity(store.url)
        let summary = try object(await host.readAttachmentDraft())
        XCTAssertEqual(summary["version"] as? Int, 3)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try identity(store.url), inode)
        await refused { _ = try await host.beginAttachmentDraft(expectedSession: before.sessionID, expectedGeneration: before.generation) }
        await refused { _ = try await host.beginAttachmentDraftV2(expectedSession: before.sessionID, expectedGeneration: before.generation) }
        await refused { _ = try await host.recoverAttachmentDraft(expectedSession: before.sessionID) }
        let discard = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID, "generation": before.generation])
        await refused { _ = try await host.discardAttachmentDraft(requestJSON: discard) }
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); same(try latest(), before)
        await host.close()
        for version in [1, 2] {
            let parent = try isolate(), (legacy, initial) = try await seed(begin: false)
            if version == 1 { _ = try await legacy.beginAttachmentDraft(expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
            else { _ = try await legacy.beginAttachmentDraftV2(expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
            let retained = try Data(contentsOf: store.url)
            await refused { _ = try await legacy.beginAttachmentDraftV3(expectedSession: initial.sessionID, expectedGeneration: initial.generation) }
            XCTAssertEqual(try Data(contentsOf: store.url), retained); same(try latest(), initial)
            await legacy.close(); root = parent
        }
    }

    func testExactByteDifferentInodeAndChangedRawSpellingAfterHooksRefuseWithoutAdoption() async throws {
        for boundary in [AttachmentDraftBoundary.beforeIntent, .afterIntent, .beforeCheckpoint, .afterCheckpoint, .beforeMarker, .afterMarker] {
            for mode in ["inode", "raw"] {
                let parent = try isolate(), (host, before) = try await seed(), raw = try request(before)
                let domainBefore = try domain(), acknowledgments = try acknowledgmentCount()
                var foreign: Data?, expectedEditor: Data?, fired = false
                let hooks = AttachmentDraftHostHooks()
                hooks.boundary = { event in
                    guard event == boundary else { return }; fired = true
                    let current = try Data(contentsOf: self.store.url), oldIdentity = try self.identity(self.store.url)
                    if mode == "inode" {
                        let replacement = self.root.appendingPathComponent("replacement-sidecar.json")
                        try current.write(to: replacement)
                        try FileManager.default.moveItem(at: self.store.url, to: self.root.appendingPathComponent("original-sidecar.json"))
                        try FileManager.default.moveItem(at: replacement, to: self.store.url)
                        XCTAssertNotEqual(try self.identity(self.store.url), oldIdentity); foreign = current
                    } else {
                        let changed = Data(" \n".utf8) + current
                        let fd = Darwin.open(self.store.url.path, O_WRONLY | O_TRUNC | O_NOFOLLOW)
                        guard fd >= 0 else { throw HostFailure("Fixture open failed") }; defer { Darwin.close(fd) }
                        let count = changed.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
                        XCTAssertEqual(count, changed.count); XCTAssertEqual(try self.identity(self.store.url), oldIdentity); foreign = changed
                    }
                    expectedEditor = try Data(contentsOf: self.editor.url)
                }
                await host.configureAttachmentDraftHost(hooks)
                await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) }
                XCTAssertTrue(fired); XCTAssertEqual(try Data(contentsOf: store.url), try XCTUnwrap(foreign))
                XCTAssertEqual(try Data(contentsOf: editor.url), try XCTUnwrap(expectedEditor))
                XCTAssertEqual(try domain(), domainBefore); XCTAssertEqual(try acknowledgmentCount(), acknowledgments)
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
                await host.close(); root = parent
            }
        }
    }

    func testMissingNewerOrPendingEditorAtCASBoundaryRetainsIntentAndForeignEditor() async throws {
        for mode in ["missing", "newer", "attempt"] {
            let parent = try isolate(), (host, before) = try await seed(), raw = try request(before), domainBefore = try domain()
            var expected: Data?, fired = false
            let hooks = AttachmentDraftHostHooks()
            hooks.boundary = { event in
                guard event == .beforeCheckpoint else { return }; fired = true
                if mode == "missing" { try FileManager.default.removeItem(at: self.editor.url) }
                if mode == "newer" { try self.editor.checkpoint(self.edited(before, generation: 9)) }
                if mode == "attempt" {
                    _ = try self.editor.freeze(sessionID: before.sessionID, generation: before.generation, method: "saveDraft",
                        argumentsJSON: self.json([self.json(["version": 1])]))
                    XCTAssertNotNil(try self.editor.read()?.attempt)
                }
                expected = FileManager.default.fileExists(atPath: self.editor.url.path) ? try Data(contentsOf: self.editor.url) : nil
            }
            await host.configureAttachmentDraftHost(hooks)
            await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) }
            XCTAssertTrue(fired); XCTAssertEqual(try removeOp().phase, .intent)
            let retained = try Data(contentsOf: store.url)
            if let expected { XCTAssertEqual(try Data(contentsOf: editor.url), expected) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: editor.url.path)) }
            await host.close(); let cold = core(); _ = try await cold.start()
            await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
            XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try domain(), domainBefore)
            if let expected { XCTAssertEqual(try Data(contentsOf: editor.url), expected) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: editor.url.path)) }
            await cold.close(); root = parent
        }
    }

    func testFreshReadOnlyTaskRefusesButOwedRemoveRecoversWithoutReapplyingEditPolicy() async throws {
        for pending in [false, true] {
            let parent = try isolate(), (host, before) = try await seed(), raw = try request(before)
            if pending {
                let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .afterIntent { throw HostFailure("Owed metadata intent") } }
                await host.configureAttachmentDraftHost(hooks)
                await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) }
            }
            await host.close()
            _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,createdAt,updatedAt,archivedAt,rev) VALUES ('archived-owner','Archived','archived','#94a3b8',0,'[]',0,0,?,?,?,1)", [at, at, at])
            _ = try sql("UPDATE tasks SET projectId='archived-owner',status='reference',archivedAt=? WHERE id=?", [at, taskID])
            let cold = core(); _ = try await cold.start()
            let view = try object(await cold.call("taskView", argumentsJSON: json([json(["id": taskID])])))
            XCTAssertEqual(view["readOnly"] as? Bool, true)
            let domainBefore = try domain(), retained = try Data(contentsOf: store.url)
            if pending {
                _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
                XCTAssertEqual(try removeOp().phase, .checkpointed); same(try latest(), try removeOp().after)
            } else {
                await refused { _ = try await cold.removeAttachmentDraftV3(requestJSON: raw) }
                XCTAssertEqual(try Data(contentsOf: store.url), retained); same(try latest(), before)
                let later = try edited(before)
                try await cold.checkpointEditorDraft(later); same(try latest(), later)
            }
            XCTAssertEqual(try domain(), domainBefore); await cold.close(); root = parent
        }
    }

    func testCapabilityRefusalBeforeIntentPreservesBytesAndDoesNotAcknowledge() async throws {
        let (host, before) = try await seed(), raw = try request(before)
        await host.close()
        let original = try String(contentsOf: bundle), fixture = root.appendingPathComponent("capability-core-host.js")
        let suffix = ";(() => { const original = globalThis.MindwtrHost.attachmentDraftRemovePrepareV3; if(typeof original !== 'function') throw new Error('Fixture binding missing'); globalThis.MindwtrHost.attachmentDraftRemovePrepareV3 = function(json) { globalThis.__mindwtrHostPlatform = 'android'; return original.call(this, json); }; })();"
        try (original + "\n" + suffix + "\n").write(to: fixture, atomically: true, encoding: .utf8); bundle = fixture
        let blocked = core(); _ = try await blocked.start()
        let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), domainBefore = try domain(), count = try acknowledgmentCount()
        await refused { _ = try await blocked.removeAttachmentDraftV3(requestJSON: raw) }
        XCTAssertEqual(try Data(contentsOf: store.url), retained); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try domain(), domainBefore); XCTAssertEqual(try acknowledgmentCount(), count)
    }

    func testCancellationAndAppearingDomainJournalAtPreIntentBoundaryMutateNothing() async throws {
        for mode in ["cancel", "journal"] {
            let parent = try isolate(), (host, before) = try await seed(), raw = try request(before)
            let retained = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), domainBefore = try domain()
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), foreign = Data("foreign pending journal".utf8)
            var fired = false
            let hooks = AttachmentDraftHostHooks(); hooks.boundary = { event in
                guard event == .beforeIntent else { return }; fired = true
                if mode == "journal" { try foreign.write(to: self.journal) }
                else {
                    entered.signal()
                    guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Fixture cancellation barrier expired") }
                }
            }
            await host.configureAttachmentDraftHost(hooks)
            if mode == "cancel" {
                let work = Task { try await host.removeAttachmentDraftV3(requestJSON: raw) }
                let reached = await Task.detached { entered.wait(timeout: .now() + 10) == .success }.value
                XCTAssertTrue(reached); work.cancel(); release.signal()
                await refused { _ = try await work.value }
            } else { await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) } }
            XCTAssertTrue(fired); XCTAssertEqual(try Data(contentsOf: store.url), retained)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try domain(), domainBefore)
            if mode == "journal" { XCTAssertEqual(try Data(contentsOf: journal), foreign) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)) }
            await host.close(); root = parent
        }
    }

    func testColdOrdinaryAdvanceAfterRemovePreservesFrozenHistoryAndExactRawEditor() async throws {
        for boundary in [AttachmentDraftBoundary.afterAdvanceIntent, .afterAdvanceEditor, .afterAdvanceMarker] {
            let parent = try isolate(), (host, initial) = try await seed(), raw = try request(initial)
            let reply = try await host.removeAttachmentDraftV3(requestJSON: raw), before = try latest()
            let after = try edited(before, generation: before.generation + 7)
            let proofs = try encoded(record().operations), domainBefore = try domain()
            let target = managed.appendingPathComponent("historical-original.txt"), bytes = try Data(contentsOf: target)
            let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == boundary { throw HostFailure("Retained ordinary advance") } }
            await host.configureAttachmentDraftHost(hooks)
            await refused { try await host.checkpointEditorDraft(after) }
            if boundary == .afterAdvanceMarker { XCTAssertNil(try record().checkpointAdvance) }
            else {
                let pair = try XCTUnwrap(record().checkpointAdvance)
                same(pair.before, before); same(pair.after, after)
            }
            same(try latest(), boundary == .afterAdvanceIntent ? before : after)
            let editorIdentity = try identity(editor.url)
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: initial.sessionID)
            same(try latest(), after); same(try record().session.checkpoint, after)
            XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
            if boundary == .afterAdvanceEditor { XCTAssertNotEqual(try identity(editor.url), editorIdentity) }
            let replay = try await cold.removeAttachmentDraftV3(requestJSON: raw)
            XCTAssertEqual(replay, reply)
            same(try latest(), after); XCTAssertEqual(try encoded(record().operations), proofs)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try domain(), domainBefore)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await cold.close(); root = parent
        }
    }

    func testActualRemoveAndEscapedAdvanceCapacityRefuseBeforeIntentAndPreserveAllEvidence() async throws {
        let (host, _) = try await seed(attachmentCount: 4, extra: String(repeating: "x", count: 460_000))
        for index in 0..<3 {
            _ = try await host.removeAttachmentDraftV3(requestJSON: request(latest(), attachment: index == 0 ? attachmentID : attachmentID + ":\(index)"))
        }
        let accepted = try record(), before = try latest(), proofs = try encoded(accepted.operations)
        let sidecar = try Data(contentsOf: store.url), checkpoint = try Data(contentsOf: editor.url), domainBefore = try domain()
        let target = managed.appendingPathComponent("historical-original.txt"), bytes = try Data(contentsOf: target)
        let entries = try FileManager.default.contentsOfDirectory(atPath: managed.path), acknowledgments = try acknowledgmentCount()
        let id = UUID().uuidString.lowercased(), selected = attachmentID + ":3", raw = try request(before, id: id, attachment: selected)


        var payload = try object(before.payloadJSON), rows = try XCTUnwrap(payload["attachments"] as? [[String: Any]])
        let position = try XCTUnwrap(rows.firstIndex { ($0["id"] as? String) == selected })
        rows[position]["deletedAt"] = at; rows[position]["updatedAt"] = at; payload["attachments"] = rows
        let projected = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: before.generation + 1, payloadJSON: try json(payload))
        let prepared = try json(["version": 1, "kind": "prepared-file-remove", "taskID": taskID, "requestId": id,
            "attachmentId": selected, "removedAt": at, "beforePayloadJSON": before.payloadJSON, "afterPayloadJSON": projected.payloadJSON])
        let proposedReply = try json(["version": 1, "status": "draftRemoved", "requestId": id, "sessionID": before.sessionID,
            "generation": projected.generation, "attachmentId": selected])
        let intentOp = Store.RemoveOperation(requestId: id, requestJSON: raw, phase: .intent,
            before: before, after: projected, preparedJSON: prepared)
        let completeOp = Store.RemoveOperation(requestId: id, requestJSON: raw, phase: .checkpointed,
            before: before, after: projected, preparedJSON: prepared, replyJSON: proposedReply)
        let intent = Store.MixedRecord(session: accepted.session, operations: accepted.operations + [.remove(intentOp)])
        let complete = Store.MixedRecord(session: .init(sessionID: before.sessionID, taskID: before.taskID,
            state: .active, checkpoint: projected), operations: accepted.operations + [.remove(completeOp)])
        try editor.preflightCheckpoint(projected)
        for candidate in [intent, complete] {
            _ = try Store.mixedFingerprint(candidate)
            XCTAssertLessThanOrEqual(try encoded(candidate).count, Store.maximumBytes)
        }
        let following = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: projected.generation + 1, payloadJSON: projected.payloadJSON)
        XCTAssertGreaterThan(try encoded(XCTUnwrap(advanceCapacityCandidates(complete, after: following).first)).count, Store.maximumBytes)
        var entered = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .beforeIntent || $0 == .beforeAdvanceIntent { entered = true } }
        await host.configureAttachmentDraftHost(hooks)
        await refused { _ = try await host.removeAttachmentDraftV3(requestJSON: raw) }
        XCTAssertFalse(entered); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try encoded(record().operations), proofs)

        func grown(_ padding: Int) -> EditorDraftSnapshot {
            .init(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 9,
                payloadJSON: String(repeating: "\n", count: padding) + before.payloadJSON)
        }
        var lower = 0, upper = 999_999 - before.payloadJSON.utf8.count
        while lower < upper {
            let middle = lower + (upper - lower + 1) / 2
            let detached = try XCTUnwrap(advanceCapacityCandidates(accepted, after: grown(middle)).last)
            if try encoded(detached).count <= Store.maximumBytes { lower = middle } else { upper = middle - 1 }
        }
        XCTAssertGreaterThan(lower, 0); XCTAssertLessThan(lower, 999_999 - before.payloadJSON.utf8.count)
        let fitting = grown(lower), over = grown(lower + 1)
        let fit = try advanceCapacityCandidates(accepted, after: fitting), exceed = try advanceCapacityCandidates(accepted, after: over)
        for candidate in fit { XCTAssertLessThanOrEqual(try encoded(candidate).count, Store.maximumBytes) }
        for candidate in exceed.prefix(2) { XCTAssertLessThanOrEqual(try encoded(candidate).count, Store.maximumBytes) }
        XCTAssertGreaterThan(try encoded(XCTUnwrap(exceed.last)).count, Store.maximumBytes)
        _ = try Store.mixedFingerprint(XCTUnwrap(exceed.last)); try editor.preflightCheckpoint(over)
        await refused { try await host.checkpointEditorDraft(over) }
        XCTAssertFalse(entered); XCTAssertNil(try record().checkpointAdvance)
        XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try encoded(record().operations), proofs); same(try latest(), before)
        XCTAssertEqual(try acknowledgmentCount(), acknowledgments); XCTAssertEqual(try domain(), domainBefore)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), entries)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        try await host.checkpointEditorDraft(fitting)
        await host.close(); let cold = core(); _ = try await cold.start()
        _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        same(try latest(), fitting); same(try record().session.checkpoint, fitting)
        XCTAssertNil(try record().checkpointAdvance); XCTAssertEqual(try encoded(record().operations), proofs)
        XCTAssertEqual(try domain(), domainBefore); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
}
