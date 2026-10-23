import XCTest
import CryptoKit
@testable import MindwtrNativeCore

final class NativeCaptureLinesHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var files: NativeBackupOperationFiles { NativeBackupOperationFiles(libraryRoot: root) }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Core bundle required") }
        bundle = URL(fileURLWithPath: path)
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func rows(_ sql: String, _ params: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(params)).utf8)) as? [[String: Any]])
    }
    private func backupEntries() throws -> [String] {
        // Startup GC may create empty family directories. Refusal must preserve
        // their contents and create no operation, reservation or snapshot bytes.
        var entries: [String] = []
        for family in ["backup-operations", "backup-snapshots"] {
            let directory = root.appendingPathComponent(family)
            guard FileManager.default.fileExists(atPath: directory.path) else { continue }
            let iterator = try XCTUnwrap(FileManager.default.enumerator(at: directory,
                includingPropertiesForKeys: nil))
            for case let entry as URL in iterator { entries.append(String(entry.path.dropFirst(root.path.count + 1))) }
        }
        return entries.sorted()
    }
    private func failure(_ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected failure") } catch { }
    }
    private func request(_ core: CoreHost, text: String = "First 日本語 🦉\nSecond 日本語 🦉") async throws -> (String, [String]) {
        let opened = try object(await core.call("captureOpen"))
        let ids = text.split(separator: "\n").map { _ in UUID().uuidString.lowercased() }
        return (try json([json(["text": text, "options": XCTUnwrap(opened["options"]), "captureIds": ids])]), ids)
    }
    private func single(_ core: CoreHost, title: String) async throws -> String {
        let id = UUID().uuidString.lowercased(), opened = try object(await core.call("captureOpen"))
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": title,
            "options": XCTUnwrap(opened["options"]), "captureId": id, "openAfterSave": false])]))
        return id
    }
    private func operation(firstID: String? = nil) throws -> (NativeBackupOperationReference, String, String) {
        let reference: NativeBackupOperationReference
        if FileManager.default.fileExists(atPath: journal.path) {
            let raw = try object(String(contentsOf: journal, encoding: .utf8))
            XCTAssertEqual(raw["method"] as? String, "captureLinesCommit")
            let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(raw["argumentsJSON"] as? String).utf8)) as? [String])
            reference = try JSONDecoder().decode(NativeBackupOperationReference.self, from: Data(XCTUnwrap(args.first).utf8))
        } else {
            // A first journal write can fail before promotion. The warm host
            // still owns this command; its immutable manifest is already durable.
            let id = try XCTUnwrap(firstID)
            let bytes = try Data(contentsOf: root.appendingPathComponent("backup-operations/" + id + "/manifest.json"))
            reference = NativeBackupOperationReference(id: id,
                sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), byteCount: bytes.count)
        }
        let owned = try files.read(reference)
        return (reference, owned.planJSON, try files.readSnapshot(owned.snapshot))
    }

    func testInvalidLaterLineAndPrivateFacadesCreateNoRowsOrFiles() async throws {
        let core = host(); _ = try await core.start()
        let before = try json(rows("SELECT * FROM tasks")), entriesBefore = try backupEntries()
        let (bad, _) = try await request(core, text: "Valid first\nBad /due:whenever")
        let result = try object(await core.call("captureLinesSubmit", argumentsJSON: bad))
        XCTAssertEqual(result["kind"] as? String, "refused")
        for method in ["captureLinesPrepare", "captureLinesValidate", "captureLinesAdmission", "captureLinesCommit"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
        }
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try backupEntries(), entriesBefore)
        XCTAssertTrue(try files.listSnapshots().isEmpty)
    }

    func testClosedRequestRejectsUnknownDuplicateAndNoncanonicalFieldsBeforeFiles() async throws {
        let core = host(); _ = try await core.start()
        let (input, ids) = try await request(core)
        let entriesBefore = try backupEntries()
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(input.utf8)) as? [String])
        let original = try object(XCTUnwrap(args.first))
        var extra = original; extra["openAfterSave"] = true
        var duplicateID = original; duplicateID["captureIds"] = [ids[0], ids[0]]
        var uppercase = original; uppercase["captureIds"] = ids.map { $0.uppercased() }
        let escapedDuplicate = try json(original).replacingOccurrences(of: "\"text\":", with: "\"\\u0074ext\":\"duplicate\",\"text\":")
        for raw in [try json(extra), try json(duplicateID), try json(uppercase), escapedDuplicate] {
            await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: self.json([raw])) }
        }
        XCTAssertTrue(try rows("SELECT id FROM tasks").isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try backupEntries(), entriesBefore)
        XCTAssertTrue(try files.listSnapshots().isEmpty)
    }

    func testSnapshotExistsBeforeSQLAndFileFailureCreatesNothing() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (input, ids) = try await request(core)
        try await core.configureCaptureLinesFilesForTesting { $0.beforeSnapshotWrite = { throw HostFailure("Injected snapshot write") } }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        XCTAssertTrue(try rows("SELECT id FROM tasks").isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try await core.configureCaptureLinesFilesForTesting { $0.beforeSnapshotWrite = nil }
        var observed = false
        faults.beforeSQL = { sql in
            if sql.uppercased().contains("INSERT"), sql.uppercased().contains("INTO TASKS") {
                let (_, plan, snapshot) = try self.operation()
                XCTAssertEqual((try self.object(plan)["request"] as? [String: Any])?["captureIds"] as? [String], ids)
                XCTAssertTrue((try self.object(snapshot)["tasks"] as? [[String: Any]] ?? []).isEmpty)
                observed = true
            }
        }
        let result = try object(await core.call("captureLinesSubmit", argumentsJSON: input))
        XCTAssertTrue(observed); XCTAssertEqual(result["taskIds"] as? [String], ids)
        XCTAssertEqual(try files.listSnapshots().count, 1)
    }

    func testWarmFaultsRetryExactPlanAndSnapshotOnce() async throws {
        for boundary in ["sql", "journal", "terminal", "clear", "snapshot-before", "snapshot-after"] {
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let (input, ids) = try await request(core)
            if boundary == "sql" { faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected COMMIT") } } }
            if boundary == "journal" { faults.journalWrite = { throw HostFailure("Injected journal") } }
            if boundary == "terminal" { var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected terminal") } } }
            if boundary == "clear" { faults.journalRemove = { throw HostFailure("Injected clear") } }
            if boundary.hasPrefix("snapshot-") {
                try await core.configureCaptureLinesFilesForTesting {
                    if boundary == "snapshot-before" { $0.beforeMetadataPromote = { throw HostFailure("Injected snapshot promotion") } }
                    else { $0.afterMetadataPromote = { throw HostFailure("Injected snapshot ACK") } }
                }
            }
            await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
            let (_, plan, snapshot) = try operation(firstID: ids[0])
            await failure { _ = try await core.call("captureOpen") }
            faults.beforeSQL = nil; faults.journalWrite = nil; faults.journalRemove = nil
            try await core.configureCaptureLinesFilesForTesting { $0.beforeMetadataPromote = nil; $0.afterMetadataPromote = nil }
            let retry = try await core.retryPending()
            let result = try object(XCTUnwrap(retry))
            XCTAssertEqual(result["taskIds"] as? [String], ids)
            XCTAssertEqual(try rows("SELECT id FROM tasks WHERE id IN (?, ?)", ids).count, 2)
            let roster = try files.listSnapshots(); XCTAssertEqual(roster.count, 1)
            XCTAssertEqual(try files.readSnapshot(XCTUnwrap(roster.first)), snapshot)
            XCTAssertEqual((try object(plan)["request"] as? [String: Any])?["captureIds"] as? [String], ids)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let repeated = try await core.retryPending()
            XCTAssertNil(repeated)
            await core.close()
            // Each boundary is a new isolated physical library.
            try FileManager.default.removeItem(at: root)
            root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
    }

    func testColdPartialRowsReplayFrozenBatchAndPreserveUnrelatedEdits() async throws {
        for partial in ["none", "project", "task", "all"] {
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let unrelated = try await single(core, title: "Unrelated original")
            let (input, ids) = try await request(core, text: "First +NewLinesProject\nSecond +NewLinesProject")
            var committedRepliesLost = 0
            // Shared flush retries a transient failed acknowledgment. Keep losing
            // every COMMIT reply until this call reports its retained command.
            faults.afterSQL = { sql in
                if sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "COMMIT" {
                    committedRepliesLost += 1; throw HostFailure("Injected committed ACK")
                }
            }
            await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
            XCTAssertGreaterThan(committedRepliesLost, 0)
            XCTAssertNil(try object(String(contentsOf: journal, encoding: .utf8))["terminal"])
            let (_, plan, snapshot) = try operation()
            let landed = try rows("SELECT * FROM tasks WHERE id IN (?, ?) ORDER BY id", ids)
            XCTAssertEqual(landed.count, ids.count)
            let expected = try json(landed)
            // Lines replay uses exact landed rows, not a durable request receipt.
            // Manufacturing missing-row crash states must never remove rows
            // protected by a matching committed receipt or terminal outcome.
            XCTAssertTrue(try rows("SELECT request_id FROM native_request_receipts WHERE request_id IN (?, ?)", ids).isEmpty)
            await core.close()
            if partial != "all" { _ = try rows("DELETE FROM tasks WHERE id = ?", [ids[1]]) }
            if partial == "none" || partial == "project" { _ = try rows("DELETE FROM tasks WHERE id = ?", [ids[0]]) }
            if partial == "none" { _ = try rows("DELETE FROM projects WHERE title = ?", ["NewLinesProject"]) }
            _ = try rows("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", ["Unrelated later edit", unrelated])
            let laterDevice = UUID().uuidString.lowercased()
            _ = try rows("UPDATE settings SET data = json_set(data, '$.gtd.focusTaskLimit', 1, '$.deviceId', ?) WHERE id = 1", [laterDevice])
            let reopened = host(); _ = try await reopened.start()
            XCTAssertEqual(try json(rows("SELECT * FROM tasks WHERE id IN (?, ?) ORDER BY id", ids)), expected)
            XCTAssertEqual(try rows("SELECT title FROM tasks WHERE id = ?", [unrelated]).first?["title"] as? String, "Unrelated later edit")
            XCTAssertEqual(try files.readSnapshot(XCTUnwrap(files.listSnapshots().first)), snapshot)
            let prepared = try XCTUnwrap(try object(plan)["prepared"] as? [String: Any])
            XCTAssertEqual((prepared["result"] as? [String: Any])?["taskIds"] as? [String], ids)
            await reopened.close()
            try FileManager.default.removeItem(at: root)
            root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
    }

    func testColdLaterConflictRefusesWholeBatchAndRetainsOriginalFiles() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (input, ids) = try await request(core)
        faults.afterSQL = { if $0 == "COMMIT" { throw HostFailure("Injected committed ACK") } }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        let (reference, plan, snapshot) = try operation(); await core.close()
        _ = try rows("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", ["External edit", ids[1]])
        _ = try rows("DELETE FROM tasks WHERE id = ?", [ids[0]])
        let before = try json(rows("SELECT * FROM tasks ORDER BY id"))
        await failure { _ = try await self.host().start() }
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), before)
        XCTAssertEqual(try files.read(reference).planJSON, plan)
        XCTAssertEqual(try files.readSnapshot(files.read(reference).snapshot), snapshot)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertTrue(try files.listSnapshots().isEmpty)
    }

    func testColdBeforeCommitRetainsOwedFilesThroughStartupGCAndReplaysOnce() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (input, ids) = try await request(core)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected before COMMIT") } }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        let (reference, plan, snapshot) = try operation()
        XCTAssertTrue(try rows("SELECT id FROM tasks").isEmpty)
        await core.close()
        let orphan = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{}",
            newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{}"), existingSnapshot: nil)
        var observed = false
        let replayFaults = HostIOFaults()
        replayFaults.beforeSQL = { sql in
            if sql.uppercased().contains("INSERT"), sql.uppercased().contains("INTO TASKS") {
                XCTAssertEqual(try self.files.read(reference).planJSON, plan)
                XCTAssertEqual(try self.files.readSnapshot(self.files.read(reference).snapshot), snapshot)
                XCTAssertFalse(FileManager.default.fileExists(atPath: self.root.appendingPathComponent("backup-operations/" + orphan.id).path))
                observed = true
            }
        }
        let reopened = host(replayFaults); _ = try await reopened.start()
        XCTAssertTrue(observed); XCTAssertEqual(try rows("SELECT id FROM tasks").count, ids.count)
        XCTAssertEqual(try files.listSnapshots().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let repeated = try await reopened.retryPending(); XCTAssertNil(repeated)
    }

    func testColdTerminalCleanupDoesNotReapplyDeletedRowsOrExternalEdits() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let (input, ids) = try await request(core)
        faults.journalRemove = { throw HostFailure("Injected terminal retention") }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        let (_, _, snapshot) = try operation(); await core.close()
        _ = try rows("DELETE FROM tasks WHERE id = ?", [ids[0]])
        _ = try rows("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", ["Later edit must survive cleanup", ids[1]])
        let before = try json(rows("SELECT * FROM tasks ORDER BY id"))
        var taskWrites: [String] = [], taskTriggerDefinitions = 0
        let replayFaults = HostIOFaults()
        replayFaults.beforeSQL = { sql in
            let upper = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            if upper.hasPrefix("CREATE TRIGGER"), upper.contains("INTO TASKS") { taskTriggerDefinitions += 1 }
            // The exact table boundary also excludes top-level tasks_fts maintenance.
            if upper.range(of: "^(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+TASKS(?:\\s|\\()",
                           options: .regularExpression) != nil { taskWrites.append(sql) }
        }
        let reopened = host(replayFaults); _ = try await reopened.start()
        XCTAssertGreaterThan(taskTriggerDefinitions, 0, "Boot still installs schema trigger definitions")
        XCTAssertTrue(taskWrites.isEmpty, "Terminal cleanup must not execute task DML: \(taskWrites)")
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), before)
        XCTAssertEqual(try files.readSnapshot(XCTUnwrap(files.listSnapshots().first)), snapshot)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdMalformedTerminalOrOwnedBytesStopBeforeSQLAndGC() async throws {
        for corruption in ["result", "extra-member", "duplicate-member", "missing-plan", "snapshot"] {
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let (input, _) = try await request(core)
            faults.journalRemove = { throw HostFailure("Injected terminal retention") }
            await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
            let (reference, _, _) = try operation(), owned = try files.read(reference)
            await core.close()
            let orphan = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{}",
                newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{}"), existingSnapshot: nil)
            if corruption == "missing-plan" {
                try FileManager.default.removeItem(at: root.appendingPathComponent("backup-operations/" + reference.id + "/plan.json"))
            } else if corruption == "snapshot" {
                try Data("corrupt snapshot".utf8).write(to: root.appendingPathComponent("backup-snapshots/" + owned.snapshot.id + "/" + owned.snapshot.name))
            } else {
                var raw = try object(String(contentsOf: journal, encoding: .utf8))
                if corruption == "result" { raw["terminal"] = ["success": ["_0": try json(["kind": "saved", "taskIds": [reference.id]])]] }
                if corruption == "extra-member" { raw["editorDraft"] = NSNull() }
                let bytes = try json(raw)
                let changed = corruption == "duplicate-member" ? bytes.replacingOccurrences(of: "\"version\":2", with: "\"version\":2,\"\\u0076ersion\":2") : bytes
                try Data(changed.utf8).write(to: journal)
            }
            let before = try json(rows("SELECT * FROM tasks ORDER BY id")), journalBefore = try Data(contentsOf: journal)
            var queries = 0
            let replayFaults = HostIOFaults(); replayFaults.beforeSQL = { _ in queries += 1 }
            let reopened = host(replayFaults); await failure { _ = try await reopened.start() }; await reopened.close()
            XCTAssertEqual(queries, 0)
            XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), before)
            XCTAssertEqual(try Data(contentsOf: journal), journalBefore)
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("backup-operations/" + reference.id).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("backup-operations/" + orphan.id).path))
            try FileManager.default.removeItem(at: root)
            root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
    }

    func testColdSharedValidatorRefusesChangedPreparedRowBeforeSQLAndGC() async throws {
        for corruption in ["revision", "status", "type", "unknown-field"] {
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let (input, _) = try await request(core)
            faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected before COMMIT") } }
            await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
            let (reference, plan, snapshot) = try operation(), original = try files.read(reference)
            await core.close()
            var envelope = try object(plan), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            var tasks = try XCTUnwrap(prepared["tasks"] as? [[String: Any]])
            // Canonical frozen rows are authority; changing a valid title does not
            // invalidate them. These corruptions violate the actual pure grammar.
            switch corruption {
            case "revision": tasks[0]["rev"] = 2
            case "status": tasks[0]["status"] = "unknown-native-status"
            case "type": tasks[0]["pushCount"] = "0"
            default: tasks[0]["unknownNativeField"] = true
            }
            prepared["tasks"] = tasks; envelope["prepared"] = prepared
            // Valid immutable file hashes do not grant domain authority. Rebuild the
            // fixture's manifest/reference so only shared pure validation can refuse.
            try files.discard(reference, provenRejected: true)
            let changed = try files.prepare(id: reference.id, planJSON: json(envelope),
                newSnapshot: (name: original.snapshot.name, content: snapshot), existingSnapshot: nil)
            var command = try object(String(contentsOf: journal, encoding: .utf8))
            command["argumentsJSON"] = try json([String(decoding: JSONEncoder().encode(changed), as: UTF8.self)])
            try Data(json(command).utf8).write(to: journal)
            let orphan = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{}",
                newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{}"), existingSnapshot: nil)
            let journalBefore = try Data(contentsOf: journal), changedPlan = try files.read(changed).planJSON
            var queries = 0
            let replayFaults = HostIOFaults(); replayFaults.beforeSQL = { _ in queries += 1 }
            let reopened = host(replayFaults); await failure { _ = try await reopened.start() }; await reopened.close()
            XCTAssertEqual(queries, 0, corruption); XCTAssertTrue(try rows("SELECT id FROM tasks").isEmpty)
            XCTAssertEqual(try Data(contentsOf: journal), journalBefore)
            XCTAssertEqual(try files.read(changed).planJSON, changedPlan)
            XCTAssertEqual(try files.readSnapshot(files.read(changed).snapshot), snapshot)
            XCTAssertEqual(try files.read(orphan).planJSON, "{}")
            try FileManager.default.removeItem(at: root)
            root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
    }

    func testStaleEpochBeforePrepareDoesNotAdoptExternalBase() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let existing = try await single(core, title: "Before external edit")
        let (input, _) = try await request(core)
        var fired = false
        faults.beforeSQL = { sql in if sql == "PRAGMA data_version", !fired {
            fired = true; _ = try self.rows("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", ["External before prepare", existing])
        } }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        XCTAssertTrue(fired); XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        XCTAssertEqual(try rows("SELECT title FROM tasks WHERE id = ?", [existing]).first?["title"] as? String, "External before prepare")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try files.listSnapshots().isEmpty)
    }

    func testExternalEpochBetweenSnapshotAndAdmissionRefusesWithoutJournal() async throws {
        let core = host(); _ = try await core.start()
        let existing = try await single(core, title: "Before external edit")
        let (input, _) = try await request(core)
        try await core.configureCaptureLinesFilesForTesting { owned in owned.beforePlanWrite = {
            _ = try self.rows("UPDATE tasks SET title = ?, rev = rev + 1 WHERE id = ?", ["External during files", existing])
        } }
        await failure { _ = try await core.call("captureLinesSubmit", argumentsJSON: input) }
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        XCTAssertEqual(try rows("SELECT title FROM tasks WHERE id = ?", [existing]).first?["title"] as? String, "External during files")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try files.listSnapshots().isEmpty)
    }

    func testSavedOrdinaryEditorDraftSurvivesLinesCapture() async throws {
        let core = host(); _ = try await core.start()
        let id = try await single(core, title: "Original editor task")
        let draft = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id, generation: 1,
            payloadJSON: try json(["version": 2, "taskID": id, "title": "Unsaved protected editor draft"]))
        try await core.checkpointEditorDraft(draft)
        let (input, ids) = try await request(core)
        let result = try object(await core.call("captureLinesSubmit", argumentsJSON: input))
        XCTAssertEqual(result["taskIds"] as? [String], ids)
        let retained = try await core.readEditorDraft()
        XCTAssertEqual(retained, draft)
    }
}
