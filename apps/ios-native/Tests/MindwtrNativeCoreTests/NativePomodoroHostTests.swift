import Foundation
import XCTest
@testable import MindwtrNativeCore

/// Actual private bundle, JSC, native inline journal and real SQLite faults.
/// Running timer rows below are SQL fixtures; this slice activates no timer UI.
final class NativePomodoroHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let at = "2026-10-10T00:00:00.000Z"
    private let observed: Int64 = 1_791_590_400_000
    private let device = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual Task520 bundle required") }
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; return core
    }
    private var captureOptions: [String: Any] {
        ["note": "", "dueDate": NSNull(), "dueDateHasTime": false, "startTime": NSNull(),
         "contexts": [String](), "projectId": NSNull(), "areaId": NSNull(), "priority": NSNull(),
         "focus": false, "addAnother": false]
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
    @discardableResult private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(args)).utf8)) as? [[String: Any]])
    }
    private func request(_ action: String = "reconcile", id: String = UUID().uuidString.lowercased()) throws -> String {
        var value: [String: Any] = ["action": action, "requestId": id, "observedAtMs": observed, "localDayKey": "2026-10-10"]
        if action == "initialize" { value["durations"] = ["focusMinutes": 25, "breakMinutes": 5] }
        else { value["autoStart"] = ["autoStartFocus": false, "autoStartBreaks": false] }
        return try json(value)
    }
    private func snapshot() throws -> String {
        var result: [String: Any] = [:]
        for table in ["tasks", "projects", "settings", "native_pomodoro_session", "native_request_receipts"] {
            result[table] = try rows("SELECT * FROM " + table + " ORDER BY rowid")
        }
        return try json(result)
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func domainWrite(_ sql: String) -> Bool {
        sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|native_pomodoro_session|native_request_receipts)\b"#, options: .regularExpression) != nil
    }
    private func seed(status: String = "next", selected: Bool = true, minutes: Int = 4) async throws {
        let initial = host(); _ = try await initial.start()
        _ = try await initial.writePomodoroTransition(requestJSON: request("initialize")); await initial.close()
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["deviceId"] = device
        // The fixed `at` date ages past the default 7-day auto-archive, which then archives a done fixture on boot; 0 turns it off.
        var gtd = settings["gtd"] as? [String: Any] ?? [:]; gtd["autoArchiveDays"] = 0; settings["gtd"] = gtd
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,timeSpentMinutes,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('task','PRIVATE',?,'[]','[]',?,?,1,?,?,0,0,0,0)", [status, at, at, device, minutes])
        var state = try object(XCTUnwrap(rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        var session = try XCTUnwrap(state["session"] as? [String: Any]), timer = try XCTUnwrap(session["timerState"] as? [String: Any])
        timer["isRunning"] = true; session["timerState"] = timer; session["phaseEndsAt"] = at
        if selected { session["selectedTaskId"] = "task" }
        state["session"] = session; try rows("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
    }
    private func plan() throws -> [String: Any] {
        let saved = try object(String(contentsOf: journal, encoding: .utf8))
        XCTAssertEqual(saved["method"] as? String, "pomodoroTransitionCommit")
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(saved["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(args.first))
    }
    private func credited(_ expected: Int = 29) throws {
        XCTAssertEqual(try rows("SELECT timeSpentMinutes FROM tasks WHERE id='task'").first?["timeSpentMinutes"] as? Int, expected)
    }

    func testReadExplicitAbsenceInitializePausedAndOrdinaryDocumentExcludesLocalSession() async throws {
        let core = host(); _ = try await core.start()
        let absent = try object(await core.readPomodoroSession()); XCTAssertTrue(absent["raw"] is NSNull)
        let reply = try object(await core.writePomodoroTransition(requestJSON: request("initialize")))
        XCTAssertEqual(reply["kind"] as? String, "confirmed"); XCTAssertEqual(reply["projectionReloaded"] as? Bool, true)
        let read = try object(await core.readPomodoroSession()), state = try XCTUnwrap(read["state"] as? [String: Any])
        let session = try XCTUnwrap(state["session"] as? [String: Any]), timer = try XCTUnwrap(session["timerState"] as? [String: Any])
        XCTAssertEqual(timer["isRunning"] as? Bool, false); XCTAssertEqual(timer["remainingSeconds"] as? Int, 1500)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let local = try rows("SELECT * FROM native_pomodoro_session")
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Later", "options": captureOptions, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])]))
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), try json(local))
        XCTAssertFalse(try XCTUnwrap(rows("SELECT data FROM settings").first?["data"] as? String).contains("timerState"))
    }

    func testFrozenReconcileCreditsOncePreservesRawSQLAndLaterOrdinarySave() async throws {
        try await seed(); try rows("UPDATE tasks SET contexts=?,tags=?,rev=? WHERE id='task'", [" [ ] ", " [ ] ", 2_147_483_647])
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("lost terminal") } }
        let original = try request(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let prepared = try plan(), target = try XCTUnwrap(prepared["target"] as? [String: Any]), raw = try XCTUnwrap(target["row"] as? [Any])
        XCTAssertTrue(raw.contains { $0 as? String == " [ ] " }); try credited()
        let fixed = try XCTUnwrap(prepared["request"] as? [String: Any]); XCTAssertEqual(try json(fixed), original)
        faults.journalWrite = nil
        let result = try object(await core.writePomodoroTransition(requestJSON: original)); XCTAssertEqual(result["projectionReloaded"] as? Bool, true)
        try credited(); XCTAssertEqual(try rows("SELECT rev FROM tasks WHERE id='task'").first?["rev"] as? Int, 2_147_483_647)
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Other", "options": captureOptions, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])]))
        try credited(); XCTAssertEqual(try rows("SELECT contexts FROM tasks WHERE id='task'").first?["contexts"] as? String, " [ ] ")
    }

    func testPausedCountdownNoopCreatesNoJournalSessionGenerationOrReceipt() async throws {
        let core = host(); _ = try await core.start(); _ = try await core.writePomodoroTransition(requestJSON: request("initialize"))
        let before = try snapshot(); let reply = try object(await core.writePomodoroTransition(requestJSON: request()))
        XCTAssertEqual(reply["kind"] as? String, "noop"); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFocusDoneUnlinkedMissingArchivedDeletedAndCappedUseSharedPolicy() async throws {
        for mode in ["done", "unlinked", "missing", "archived", "deleted", "capped"] {
            let caseRoot = root.appendingPathComponent(mode); try FileManager.default.createDirectory(at: caseRoot, withIntermediateDirectories: true)
            let prior = root!; root = caseRoot
            try await seed(status: mode == "done" ? "done" : "next", selected: mode != "unlinked", minutes: mode == "capped" ? 100_000 : 4)
            if mode == "missing" { try rows("DELETE FROM tasks WHERE id='task'") }
            if mode == "archived" { try rows("UPDATE tasks SET status='archived' WHERE id='task'") }
            if mode == "deleted" { try rows("UPDATE tasks SET deletedAt=? WHERE id='task'", [at]) }
            let core = host(); _ = try await core.start()
            let reply = try object(await core.writePomodoroTransition(requestJSON: request())), result = try XCTUnwrap(reply["result"] as? [String: Any])
            XCTAssertEqual(result["creditDisposition"] as? String, mode == "done" ? "credited" : mode == "unlinked" ? "unlinked" : mode == "capped" ? "capped" : "unavailable", mode)
            XCTAssertEqual(result["creditedMinutes"] as? Int, mode == "done" ? 25 : 0, mode)
            await core.close(); root = prior
        }
    }

    func testIntentWriteFailureAndOverlappingUUIDRetainOnlyExactOriginal() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalWrite = { throw HostFailure("intent failed") }; let original = try request(), before = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        var changed = try object(original); changed["observedAtMs"] = observed + 1000
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(changed)) }
        let unrelatedProbe = try object(await core.probePomodoroTransitionOutcome(requestJSON: json(changed)))
        XCTAssertEqual(unrelatedProbe["kind"] as? String, "unproven")
        XCTAssertEqual(try snapshot(), before); faults.journalWrite = nil
        _ = try await core.writePomodoroTransition(requestJSON: original); try credited()
    }

    func testTaskSessionReceiptReadbackAndCommitFaultsRemainOwedAndRetryWithoutDuplicateCredit() async throws {
        for statement in ["UPDATE tasks", "UPDATE native_pomodoro_session", "INSERT INTO native_request_receipts", "SELECT id, state_json", "COMMIT"] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request(), before = try snapshot()
            var taskAttempted = false
            faults.beforeSQL = { sql in
                if sql.hasPrefix("UPDATE tasks") { taskAttempted = true }
                if taskAttempted && sql.hasPrefix(statement) { throw HostFailure("write fault") }
            }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(try snapshot(), before, statement); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
            faults.beforeSQL = nil; _ = try await core.writePomodoroTransition(requestJSON: original); try credited()
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close(); root = prior
        }
    }

    func testLostActualCommitReplyColdReplayReportsOnceAndPreservesLaterRows() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var wrote = false, lost = false; faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { wrote = true } }
        faults.afterSQL = { if wrote && $0 == "COMMIT" && !lost { lost = true; throw HostFailure("lost COMMIT reply") } }
        let original = try request(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        try credited(); await core.close(); try rows("UPDATE tasks SET description='LATER',rev=rev+1 WHERE id='task'")
        let replay = HostIOFaults(); var mutations = 0; replay.beforeSQL = { if self.domainWrite($0) { mutations += 1 } }
        let reopened = host(replay), first = try object(await reopened.start())
        let recovery = try XCTUnwrap(first["recovery"] as? [String: Any]); XCTAssertEqual(recovery["method"] as? String, "pomodoroTransitionCommit")
        XCTAssertEqual(mutations, 0); try credited(); XCTAssertEqual(try rows("SELECT description FROM tasks").first?["description"] as? String, "LATER")
        let again = try object(await reopened.start()); XCTAssertFalse((again["recovery"] as? [String: Any])?["method"] as? String == "pomodoroTransitionCommit")
    }

    func testTerminalWriteAndRemovalFaultsNeverRunTaskCreditAgain() async throws {
        for terminalWrite in [true, false] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); var journalWrites = 0, creditWrites = 0
            faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { creditWrites += 1 } }
            if terminalWrite { faults.journalWrite = { journalWrites += 1; if journalWrites == 2 { throw HostFailure("terminal") } } }
            else { faults.journalRemove = { throw HostFailure("clear") } }
            let original = try request(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }; try credited()
            faults.journalWrite = nil; faults.journalRemove = nil; _ = try await core.writePomodoroTransition(requestJSON: original)
            try credited(); XCTAssertEqual(creditWrites, 1); await core.close(); root = prior
        }
    }

    func testFailedProjectionReturnsSQLProofRetainsTerminalAndFencesOrdinaryWrites() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); var committed = false
        faults.afterSQL = { if $0 == "COMMIT" { committed = true } }
        faults.beforeSQL = { if committed && $0.hasPrefix("SELECT rowid as _rowid, * FROM tasks") { throw HostFailure("reload failed") } }
        let original = try request(), reply = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(reply["kind"] as? String, "confirmed"); XCTAssertEqual(reply["projectionReloaded"] as? Bool, false); try credited()
        XCTAssertNotNil(try object(String(contentsOf: journal, encoding: .utf8))["terminal"])
        let proof = try object(await core.probePomodoroTransitionOutcome(requestJSON: original)); XCTAssertEqual(proof["kind"] as? String, "confirmed")
        await failure { _ = try await core.call("captureSubmit", argumentsJSON: self.json([self.json(["text": "Blocked", "options": self.captureOptions, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])) }
        faults.beforeSQL = nil; let retry = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(retry["projectionReloaded"] as? Bool, true); try credited(); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testTerminalMissingChangedMalformedAndVanishedReceiptNeverInferFromBeforeOrAfter() async throws {
        for mode in ["missing", "changed", "malformed", "betweenProbes"] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request()
            faults.journalRemove = { throw HostFailure("clear") }; await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            let frozen = try plan(); await core.close()
            let id = try XCTUnwrap(object(original)["requestId"] as? String)
            if mode == "changed" { try rows("UPDATE native_request_receipts SET method='foreign' WHERE request_id=?", [id]) }
            if mode == "malformed" { try rows("UPDATE native_request_receipts SET reply='{}' WHERE request_id=?", [id]) }
            if mode == "missing" {
                try rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
                try rows("UPDATE tasks SET timeSpentMinutes=4,rev=1,revBy=?,updatedAt=? WHERE id='task'", [device, at])
                try rows("UPDATE native_pomodoro_session SET state_json=?", [XCTUnwrap(frozen["sessionBefore"])])
            }
            let before = try snapshot(), saved = try object(String(contentsOf: journal, encoding: .utf8)), replay = HostIOFaults(); var reads = 0, mutations = 0, vanished = false
            replay.beforeSQL = { sql in
                if sql == "SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?" {
                    reads += 1
                }
                if mode == "betweenProbes" && sql == "BEGIN IMMEDIATE" && reads > 0 && !vanished {
                    vanished = true; try self.rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
                }
                if self.domainWrite(sql) { mutations += 1 }
            }
            await failure { _ = try await self.host(replay).start() }; XCTAssertEqual(mutations, 0, mode)
            if mode != "betweenProbes" { XCTAssertEqual(try snapshot(), before, mode) }
            else { XCTAssertTrue(vanished, "receipt removed after Outcome and before replay transaction") }
            XCTAssertEqual(try json(object(String(contentsOf: journal, encoding: .utf8))), try json(saved), mode)
            root = prior
        }
    }

    func testFirstStaleRefusalClearsButRetainedRefusalAndFailedRollbackStayOwed() async throws {
        for mode in ["first", "retained", "rollback"] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request()
            if mode == "retained" { faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("write") } }; await failure { _ = try await core.writePomodoroTransition(requestJSON: original) } }
            var changed = false
            faults.beforeSQL = { sql in
                if sql == "BEGIN IMMEDIATE" && !changed { changed = true; try self.rows("UPDATE tasks SET title='COLD EDIT' WHERE id='task'") }
                if mode == "rollback" && sql == "ROLLBACK" { throw HostFailure("rollback failed") }
            }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(FileManager.default.fileExists(atPath: journal.path), mode != "first", mode)
            try credited(4); await core.close(); root = prior
        }
    }

    func testCorruptNativeRowsNeverBecomeNativeAbsence() async throws {
        let core = host(); _ = try await core.start(); await core.close()
        let malformed = "{\"version\":9}"; try rows("INSERT INTO native_pomodoro_session(id,state_json) VALUES (1,?)", [malformed])
        let reopened = host(); _ = try await reopened.start(); let before = try snapshot()
        await failure { _ = try await reopened.readPomodoroSession() }
        await failure { _ = try await reopened.writePomodoroTransition(requestJSON: self.request("initialize")) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testClosedRequestsUnsafeNumbersAndEveryPrivateMethodDeniedWithoutJournal() async throws {
        let core = host(); _ = try await core.start(); let before = try snapshot()
        for method in ["pomodoroSessionRead", "pomodoroTransitionPrepare", "pomodoroTransitionValidate", "pomodoroTransitionCommit", "pomodoroTransitionOutcome", "pomodoroTransitionWrite"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[]") }
        }
        for change in ["extra", "bool", "unsafe", "day", "duplicate"] {
            var value = try object(request("initialize"))
            if change == "extra" { value["legacy"] = true }
            if change == "bool" { value["observedAtMs"] = true }
            if change == "unsafe" { value["observedAtMs"] = 9_007_199_254_740_992 as Int64 }
            if change == "day" { value["localDayKey"] = "2026-02-31" }
            let raw = change == "duplicate" ? try json(value).replacingOccurrences(of: "\"action\":", with: "\"action\":\"initialize\",\"action\":") : try json(value)
            await failure { _ = try await core.writePomodoroTransition(requestJSON: raw) }
        }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSavedEditorRefusesNewInteractiveTransitionAndPreservesCheckpointBytes() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "task", generation: 1,
            payloadJSON: try json(["version": 2, "taskID": "task", "raw": ["title": "Uncommitted"]]))
        try await core.checkpointEditorDraft(checkpoint)
        let editor = EditorDraftStore(databaseURL: database), bytes = try Data(contentsOf: editor.url), before = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(try snapshot(), before); XCTAssertEqual(try Data(contentsOf: editor.url), bytes)
    }

    private func gcSentinels() throws -> [(URL, Data)] {
        let files = NativeBackupOperationFiles(libraryRoot: root)
        let orphan = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{\"sentinel\":true}",
            newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{\"sentinel\":true}"), existingSnapshot: nil)
        let directory = root.appendingPathComponent("backup-operations/" + orphan.id)
        let export = root.appendingPathComponent("backup-export-" + UUID().uuidString.lowercased()), imports = root.appendingPathComponent("backup-imports")
        try FileManager.default.createDirectory(at: export, withIntermediateDirectories: true); try FileManager.default.createDirectory(at: imports, withIntermediateDirectories: true)
        let exportFile = export.appendingPathComponent("mindwtr-backup-2026-10-10T00-00-00-000Z.json"), importFile = imports.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
        try Data("export sentinel".utf8).write(to: exportFile); try Data("import sentinel".utf8).write(to: importFile)
        return try [directory.appendingPathComponent("manifest.json"), directory.appendingPathComponent("plan.json"), exportFile, importFile].map { ($0, try Data(contentsOf: $0)) }
    }

    func testColdMalformedInnerOuterSemanticPlanAndTerminalStopBeforeSQLAndGC() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("intent") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }; await core.close()
        let original = try object(String(contentsOf: journal, encoding: .utf8)), frozen = try plan(), before = try snapshot(), bytes = try Data(contentsOf: database), sentinels = try gcSentinels()
        for mode in ["unknown", "result", "after", "duplicate", "terminal", "outer", "oversized"] {
            var command = original, prepared = frozen
            if mode == "unknown" { prepared["legacy"] = true }
            if mode == "result" { var result = try XCTUnwrap(prepared["result"] as? [String: Any]); result["creditedMinutes"] = 26; prepared["result"] = result }
            if mode == "after" { var after = try object(XCTUnwrap(prepared["sessionAfter"] as? String)); after["generation"] = 4; prepared["sessionAfter"] = try json(after) }
            if mode == "outer" { command["editorDraft"] = NSNull() }
            if mode == "terminal" { command["terminal"] = ["success": ["_0": "{\"forged\":true}"]] }
            if mode == "oversized" { prepared["sessionAfter"] = String(repeating: "x", count: 1_000_001) }
            let planJSON = mode == "duplicate" ? try json(prepared).replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1") : try json(prepared)
            command["argumentsJSON"] = try json([planJSON]); let pendingBytes = Data(try json(command).utf8); try pendingBytes.write(to: journal)
            let replay = HostIOFaults(); var sql = 0; replay.beforeSQL = { _ in sql += 1 }
            await failure { _ = try await self.host(replay).start() }
            XCTAssertEqual(sql, 0, mode); XCTAssertEqual(try Data(contentsOf: database), bytes, mode)
            XCTAssertEqual(try Data(contentsOf: journal), pendingBytes, mode); XCTAssertEqual(try snapshot(), before, mode)
            for (path, sentinel) in sentinels { XCTAssertEqual(try Data(contentsOf: path), sentinel, mode) }
        }
    }

    func testOwedOldReceiptSurvivesFullReminderRetentionAndConservativeNull() async throws {
        for explicit in [true, false] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request(), id = try XCTUnwrap(object(original)["requestId"] as? String)
            faults.journalRemove = { throw HostFailure("clear") }; await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }; await core.close()
            try rows("UPDATE native_request_receipts SET saved_at='2020-01-01T00:00:00.000Z' WHERE request_id=?", [id])
            let ids = (0..<128).map { _ in UUID().uuidString.lowercased() }
            for reminder in ids { try rows("INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES (?,?,?,'2020-01-01T00:00:00.000Z')", [reminder, "reminderSnooze:" + String(repeating: "0", count: 32), "null"]) }
            let reopened = host(); _ = try await reopened.start(retainingReminderResponseIDs: explicit ? ids : nil)
            let retained = try rows("SELECT request_id FROM native_request_receipts").compactMap { $0["request_id"] as? String }
            XCTAssertTrue(retained.contains(id)); XCTAssertTrue(ids.allSatisfy(retained.contains)); try credited()
            await reopened.close(); root = prior
        }
    }

    func testNativeReadFailureAndExistingPausedSessionNeverAuthorizeInitialization() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let before = try snapshot()
        faults.beforeSQL = { if $0 == "SELECT id, state_json FROM native_pomodoro_session" { throw HostFailure("read failed") } }
        await failure { _ = try await core.readPomodoroSession() }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request("initialize")) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        faults.beforeSQL = nil; _ = try await core.writePomodoroTransition(requestJSON: request("initialize"))
        let paused = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request("initialize")) }
        XCTAssertEqual(try snapshot(), paused); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLegacyTimerPreferenceBytesRemainUntouchedAndAreNeverAdopted() async throws {
        let directory = root.appendingPathComponent("Library/Application Support/tech.dongdongbh.mindwtr/RCTAsyncLocalStorage_V1")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("manifest.json")
        let legacy = ["@mindwtr_pomodoro_state": "{\"overdueLegacyHistory\":true}", "@mindwtr_pomodoro_collapsed": "false"]
        let bytes = Data(try json(legacy).utf8); try bytes.write(to: file)
        let core = host(); _ = try await core.start()
        let absent = try object(await core.readPomodoroSession()); XCTAssertTrue(absent["raw"] is NSNull)
        let reply = try object(await core.writePomodoroTransition(requestJSON: request("initialize")))
        let result = try XCTUnwrap(reply["result"] as? [String: Any]); XCTAssertEqual(result["completedFocusSessions"] as? Int, 0)
        XCTAssertEqual(result["creditedMinutes"] as? Int, 0); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testBreakCompletionAndMissingCanonicalDeviceNeverInventTaskCreditOrIdentity() async throws {
        for isBreak in [true, false] {
            let prior = root!; root = prior.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); try await seed()
            if isBreak {
                var state = try object(XCTUnwrap(rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
                var session = try XCTUnwrap(state["session"] as? [String: Any]), timer = try XCTUnwrap(session["timerState"] as? [String: Any])
                timer["phase"] = "break"; timer["remainingSeconds"] = 300; session["timerState"] = timer
                state["session"] = session; try rows("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
            }
            let core = host(); _ = try await core.start()
            if !isBreak {
                // Boot may initialize identity; a later Pomodoro write must not replace missing identity.
                var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
                settings.removeValue(forKey: "deviceId"); try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
            }
            let before = try snapshot()
            if isBreak {
                let reply = try object(await core.writePomodoroTransition(requestJSON: request())), result = try XCTUnwrap(reply["result"] as? [String: Any])
                XCTAssertEqual(result["creditedMinutes"] as? Int, 0); XCTAssertEqual(result["creditDisposition"] as? String, "none")
                try credited(4)
            } else {
                await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
                XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
            await core.close(); root = prior
        }
    }

    func testNonterminalColdBeforeRetryAllowsUnrelatedEditAndAppliesOnlyFrozenCredit() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("before write") } }
        let original = try request(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let frozen = try plan(); try credited(4); await core.close()
        try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt) VALUES('other','COLD UNRELATED','next','[]','[]',?,?)", [at, at])
        let unrelated = try rows("SELECT * FROM tasks WHERE id='other'")
        let reopened = host(), first = try object(await reopened.start()), recovery = try XCTUnwrap(first["recovery"] as? [String: Any])
        XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), try json(XCTUnwrap(frozen["result"])))
        XCTAssertEqual(try json(rows("SELECT * FROM tasks WHERE id='other'")), try json(unrelated)); try credited()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdOwedSuccessCannotDiscardSavedEditorCheckpointOrClaimProjection() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("clear") }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }; try credited(); await core.close()
        let editor = EditorDraftStore(databaseURL: database)
        try editor.checkpoint(EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "task", generation: 1,
            payloadJSON: try json(["version": 2, "taskID": "task", "raw": ["title": "Retained edit"]])))
        let bytes = try Data(contentsOf: editor.url), before = try snapshot()
        await failure { _ = try await self.host().start() }
        XCTAssertEqual(try Data(contentsOf: editor.url), bytes); XCTAssertEqual(try snapshot(), before)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); try credited()
    }

    func testExactPreparedReceiptTransportBoundaryReservesFutureTerminalBeforeJournal() async throws {
        let fixedID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", original = try request(id: fixedID)
        // Measure the literal actual bridge plan; only the raw description cell
        // changes in the following fixtures. Receipt JSON has the same fixed wrapper.
        try await seed(); try rows("UPDATE tasks SET description='' WHERE id='task'")
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("intent retained") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let command = try object(String(contentsOf: journal, encoding: .utf8))
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
        let literal = try XCTUnwrap(args.first), base = ("[\"pomodoroTransition\"," + literal + "]").utf8.count
        await core.close(); let prior = root!
        for extra in [0, 1] {
            root = prior.appendingPathComponent("boundary-" + String(extra)); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try await seed(); let available = 2_000_000 - base + extra
            XCTAssertGreaterThan(available, 0)
            let description = String(repeating: "\0", count: available / 6) + String(repeating: "x", count: available % 6)
            try rows("UPDATE tasks SET description=? WHERE id='task'", [description])
            let attemptFaults = HostIOFaults(), attempt = host(attemptFaults); _ = try await attempt.start(); let before = try snapshot(); var writes = 0
            attemptFaults.journalWrite = { writes += 1 }
            attemptFaults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("intent retained") } }
            await failure { _ = try await attempt.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(try snapshot(), before)
            if extra == 1 {
                XCTAssertEqual(writes, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            } else {
                XCTAssertEqual(writes, 1)
                let saved = try object(String(contentsOf: journal, encoding: .utf8))
                let encoded = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(saved["argumentsJSON"] as? String).utf8)) as? [String])
                let planJSON = try XCTUnwrap(encoded.first)
                XCTAssertEqual(("[\"pomodoroTransition\"," + planJSON + "]").utf8.count, 2_000_000)
                attemptFaults.beforeSQL = nil; _ = try await attempt.writePomodoroTransition(requestJSON: original)
                try credited(); XCTAssertEqual(writes, 3, "intent retry and exact success terminal fit")
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
            await attempt.close(); root = prior
        }
    }

    func testFixedStorageProofReceiverAcceptsOnlyExactMessageScopeAndContext() async throws {
        let valid: [String: Any] = ["scope": "storage", "force": true, "context": try json(["releaseCheck": "v1.3.5/ios-pomodoro-credit", "outcome": "confirmed"])]
        var lines = ["info: Native Pomodoro transition confirmed " + (try json(valid))]
        for field in ["scope", "message", "outcome", "extra"] {
            var payload = valid, context = ["releaseCheck": "v1.3.5/ios-pomodoro-credit", "outcome": "confirmed"]
            if field == "scope" { payload["scope"] = "native-ios" }
            if field == "outcome" { context["outcome"] = "failed" }
            if field == "extra" { context["taskId"] = "PRIVATE" }
            payload["context"] = try json(context)
            lines.append((field == "message" ? "info: Other message " : "info: Native Pomodoro transition confirmed ") + (try json(payload)))
        }
        let suffix = "\n" + "for (const line of " + (try json(lines)) + ") globalThis.__mindwtrNative.log(line);"
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(); var proofLines = 0; faults.commandDiagnostic = { if $0 == "pomodoroCreditConfirmed" { proofLines += 1 } }
        let core = host(faults); _ = try await core.start(); XCTAssertEqual(proofLines, 1)
        _ = try await core.writePomodoroTransition(requestJSON: request("initialize")); XCTAssertEqual(proofLines, 2, "actual shared logger reaches exact native receiver")
    }
}
