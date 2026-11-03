import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativePomodoroSettingsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let fields = ["pomodoro", "pomodoroLinkTask", "pomodoroAutoStartBreaks", "pomodoroAutoStartFocus", "pomodoroCompletionAlert", "pomodoroDurations"]

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual native bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
    }

    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }
        return core
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    @discardableResult private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(args)).utf8)) as? [[String: Any]])
    }
    private func seed(_ values: [String: Any] = [:]) async throws {
        let core = host(); _ = try await core.start()
        _ = try await core.writePomodoroTransition(requestJSON: json(["action": "initialize", "requestId": UUID().uuidString.lowercased(),
            "observedAtMs": 1_791_590_400_000 as Int64, "localDayKey": "2026-10-10", "durations": ["focusMinutes": 25, "breakMinutes": 5]]))
        await core.close()
        try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,timeSpentMinutes,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('task548','Private timer fixture','next','[]','[]','2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z',1,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',4,0,0,0,0)")
        var state = try object(XCTUnwrap(rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        var session = try XCTUnwrap(state["session"] as? [String: Any])
        var timer = try XCTUnwrap(session["timerState"] as? [String: Any])
        timer["isRunning"] = true; session["timerState"] = timer
        session["selectedTaskId"] = "task548"; session["phaseEndsAt"] = "2026-10-10T00:00:00.000Z"
        state["session"] = session
        try rows("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["deviceId"] = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        settings["features"] = ["pomodoro": true, "priorities": true]
        var pomodoro: [String: Any] = ["linkTask": true, "autoStartBreaks": false, "autoStartFocus": false,
            "completionAlert": true, "customDurations": ["focusMinutes": 25, "breakMinutes": 5], "retained548": "keep"]
        pomodoro.merge(values) { _, new in new }
        settings["gtd"] = ["pomodoro": pomodoro, "focusTaskLimit": 5, "retained548": "keep"]
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }
    private func call(_ core: CoreHost, _ method: String, _ input: Any = [String: Any]()) async throws -> [String: Any] {
        try object(await core.call(method, argumentsJSON: json([json(input)])))
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }

    func testAlarmAndPanelRefuseExternalSettingsCommitUntilReloaded() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let presentation = try json(["collapsed": false, "lastEvent": NSNull()])
        let initial = try object(await core.readPomodoroAlarmIntent())
        XCTAssertEqual(initial["kind"] as? String, "schedule")
        try rows("UPDATE settings SET data=json_set(data, '$.gtd.pomodoro.completionAlert', json('false')) WHERE id=1")
        let saved = try json(rows("SELECT data FROM settings WHERE id=1"))
        let timer = try json(rows("SELECT * FROM native_pomodoro_session"))
        await failure { _ = try await core.readPomodoroAlarmIntent() }
        await failure { _ = try await core.readPomodoroPanel(presentationJSON: presentation) }
        XCTAssertEqual(try json(rows("SELECT data FROM settings WHERE id=1")), saved)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), timer)
        await core.close()
        let reloaded = host(); _ = try await reloaded.start()
        let alarm = try object(await reloaded.readPomodoroAlarmIntent())
        XCTAssertEqual(alarm["kind"] as? String, "cancel")
        XCTAssertEqual(alarm["reason"] as? String, "completion-alert-off")
        let panel = try object(await reloaded.readPomodoroPanel(presentationJSON: presentation))
        XCTAssertEqual(panel["completionAlert"] as? Bool, false)
    }

    func testAlarmIntentReadsSavedPhaseWithoutCreditAndHonorsExplicitOff() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let before = try json(rows("SELECT * FROM native_pomodoro_session"))
        let tasks = try json(rows("SELECT * FROM tasks ORDER BY id"))
        let alarm = try object(await core.readPomodoroAlarmIntent())
        XCTAssertEqual(alarm["kind"] as? String, "schedule")
        XCTAssertEqual(alarm["phase"] as? String, "focus")
        let details = try XCTUnwrap(alarm["details"] as? [String: Any])
        XCTAssertEqual(details["has_complete_action"] as? Bool, false)
        XCTAssertEqual(details["data"] as? [String: String], ["kind": "pomodoro", "phase": "focus-complete"])
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), before)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), tasks)
        for method in ["pomodoroAlarmReadHost", "pomodoroAlarmRead"] {
            await failure { _ = try await core.call(method) }
        }
        await core.close()
        try rows("UPDATE settings SET data=json_set(data, '$.features.pomodoro', json('false'), '$.notificationsEnabled', json('false')) WHERE id=1")
        let hidden = host(); _ = try await hidden.start()
        let hiddenIntent = try object(await hidden.readPomodoroAlarmIntent())
        XCTAssertEqual(hiddenIntent["kind"] as? String, "schedule")
        await hidden.close()
        try rows("UPDATE settings SET data=json_set(data, '$.gtd.pomodoro.completionAlert', json('false')) WHERE id=1")
        let off = host(); _ = try await off.start()
        let cancellation = try object(await off.readPomodoroAlarmIntent())
        XCTAssertEqual(cancellation["kind"] as? String, "cancel")
        XCTAssertEqual(cancellation["reason"] as? String, "completion-alert-off")
        XCTAssertEqual(cancellation["preserveDue"] as? Bool, false)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), before)
    }

    func testPanelReadsOverdueSavedSessionWithoutSpeculativeCreditAndKeepsHiddenRuntime() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let before = try json(rows("SELECT * FROM native_pomodoro_session"))
        let tasks = try json(rows("SELECT * FROM tasks ORDER BY id"))
        let input = try json(["collapsed": false, "lastEvent": NSNull()])
        let panel = try object(await core.readPomodoroPanel(presentationJSON: input))
        XCTAssertEqual(panel["kind"] as? String, "ready")
        XCTAssertEqual(panel["visible"] as? Bool, true)
        XCTAssertEqual(panel["needsReconcile"] as? Bool, true)
        XCTAssertEqual(panel["clock"] as? String, "00:00")
        XCTAssertEqual(panel["phase"] as? String, "focus")
        XCTAssertEqual(panel["completedToday"] as? Int, 0)
        XCTAssertEqual((panel["selectedTask"] as? [String: Any])?["id"] as? String, "task548")
        XCTAssertTrue(panel["event"] is NSNull)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), before)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), tasks)
        await core.close()
        try rows("UPDATE settings SET data=json_set(data, '$.features.pomodoro', json('false')) WHERE id=1")
        let replay = host(); _ = try await replay.start()
        let hidden = try object(await replay.readPomodoroPanel(presentationJSON: input))
        XCTAssertEqual(hidden["visible"] as? Bool, false)
        XCTAssertEqual(hidden["isRunning"] as? Bool, true)
        XCTAssertEqual(hidden["completionAlert"] as? Bool, true)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), before)
    }

    func testPanelRefusesRetainedPomodoroWriteWithoutChangingItsRecoveryJournal() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Task582 retained terminal") }
        let request = try json(["action": "reconcile", "requestId": UUID().uuidString.lowercased(),
            "observedAtMs": 1_791_633_600_000 as Int64, "localDayKey": "2026-10-10",
            "autoStart": ["autoStartFocus": false, "autoStartBreaks": false]])
        await failure { _ = try await core.writePomodoroTransition(requestJSON: request) }
        let retained = try Data(contentsOf: journal)
        await failure { _ = try await core.readPomodoroAlarmIntent() }
        await failure { _ = try await core.readPomodoroPanel(presentationJSON: self.json(["collapsed": false, "lastEvent": NSNull()])) }
        XCTAssertEqual(try Data(contentsOf: journal), retained)
        faults.journalRemove = nil
        _ = try await core.writePomodoroTransition(requestJSON: request)
        let panel = try object(await core.readPomodoroPanel(presentationJSON: json(["collapsed": false, "lastEvent": NSNull()])))
        XCTAssertEqual(panel["kind"] as? String, "ready")
        XCTAssertEqual(panel["needsReconcile"] as? Bool, false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPanelAbsenceMalformedStorageAndClosedPrivateBoundaryNeverInitialize() async throws {
        let core = host(); _ = try await core.start()
        let input = try json(["collapsed": true, "lastEvent": NSNull()])
        let missing = try object(await core.readPomodoroPanel(presentationJSON: input))
        XCTAssertEqual(missing["kind"] as? String, "uninitialized")
        XCTAssertEqual(missing["collapsed"] as? Bool, true)
        XCTAssertTrue(try rows("SELECT * FROM native_pomodoro_session").isEmpty)
        let missingAlarm = try object(await core.readPomodoroAlarmIntent())
        XCTAssertEqual(missingAlarm["kind"] as? String, "uninitialized")
        for raw in ["{}", "[]", "{\"collapsed\":0,\"lastEvent\":null}",
            "{\"collapsed\":false,\"collapsed\":true,\"lastEvent\":null}",
            "{\"collapsed\":false,\"lastEvent\":null,\"raw\":\"{}\"}"] {
            await failure { _ = try await core.readPomodoroPanel(presentationJSON: raw) }
        }
        for method in ["pomodoroPanelReadHost", "pomodoroPanelRead"] {
            await failure { _ = try await core.call(method, argumentsJSON: self.json([input])) }
        }
        await core.close()
        try await seed()
        try rows("UPDATE native_pomodoro_session SET state_json='{}'")
        let corrupt = host(); _ = try await corrupt.start()
        await failure { _ = try await corrupt.readPomodoroPanel(presentationJSON: input) }
        await failure { _ = try await corrupt.readPomodoroAlarmIntent() }
        XCTAssertEqual(try rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String, "{}")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPomodoroPickerPagesBeyondFocusWindowWithoutChangingTimerOrTasks() async throws {
        try await seed()
        for id in ["picker581-a", "picker581-b"] {
            try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,timeSpentMinutes,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) SELECT ?,?,'next',contexts,tags,createdAt,updatedAt,rev,revBy,0,0,0,0,0 FROM tasks WHERE id='task548'", [id, id])
        }
        let core = host(); _ = try await core.start()
        let before = try json(rows("SELECT * FROM tasks ORDER BY id"))
        let timer = try json(rows("SELECT * FROM native_pomodoro_session"))
        let focus = try object(await core.call("focus", argumentsJSON: "[1]"))
        let revision = try XCTUnwrap(focus["revision"] as? String)
        var ids: [String] = []
        for offset in 0..<3 {
            let page = try await call(core, "pomodoroTasks", ["offset": offset, "limit": 1, "revision": revision])
            XCTAssertEqual(page["total"] as? Int, 3)
            XCTAssertEqual(page["revision"] as? String, revision)
            let items = try XCTUnwrap(page["rows"] as? [[String: Any]])
            XCTAssertEqual(items.count, 1)
            ids.append(try XCTUnwrap(items.first?["id"] as? String))
        }
        XCTAssertEqual(Set(ids), Set(["task548", "picker581-a", "picker581-b"]))
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), before)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), timer)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPomodoroPickerRejectsMalformedDuplicateAndStaleRequests() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let focus = try object(await core.call("focus", argumentsJSON: "[1]"))
        let revision = try XCTUnwrap(focus["revision"] as? String)
        let input: [String: Any] = ["offset": 0, "limit": 1, "revision": revision]
        for change: [String: Any] in [["offset": true], ["offset": -1], ["limit": 101], ["limit": 0],
            ["extra": true], ["controls": ["extra": true]], ["revision": "stale"]] {
            var request = input; request.merge(change) { _, new in new }
            await failure { _ = try await self.call(core, "pomodoroTasks", request) }
        }
        let duplicate = "{\"offset\":0,\"offset\":1,\"limit\":1,\"revision\":\"stale\"}"
        await failure { _ = try await core.call("pomodoroTasks", argumentsJSON: self.json([duplicate])) }
        await core.close()
        await failure { _ = try await self.call(core, "pomodoroTasks", input) }
    }

    func testHubPreservesFourWitnessesAndAddsPomodoro() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let options = try await call(core, "gtdWorkflowOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        XCTAssertEqual(Set(expected.keys), Set(["defaultScheduleTime", "focusTaskLimit", "focusIncludeStartDates", "defaultProjectFlowMode", "pomodoro"]))
        XCTAssertEqual((expected["pomodoro"] as? [String: Any])?["value"] as? Bool, true)
    }

    private func exercise(_ type: String, _ value: Any) async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let timerBefore = try json(rows("SELECT * FROM native_pomodoro_session"))
        let tasksBefore = try json(rows("SELECT * FROM tasks ORDER BY id"))
        let options = try await call(core, "gtdPomodoroOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        XCTAssertEqual(Set(expected.keys), Set(fields))
        let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "edit": ["type": type, "value": value], "expected": try XCTUnwrap(expected[type])]
        faults.journalRemove = { throw HostFailure("Task548 terminal cleanup") }
        await failure { _ = try await self.call(core, "gtdWorkflow", request) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        let saved = try json(rows("SELECT * FROM settings"))
        await core.close()
        let recoveryFaults = HostIOFaults()
        var diagnostics: [String] = []
        recoveryFaults.commandDiagnostic = { diagnostics.append($0) }
        let replay = host(recoveryFaults); _ = try await replay.start()
        XCTAssertEqual(diagnostics.filter { $0 == "gtdPomodoroApplied" }.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), saved)
        XCTAssertEqual(try json(rows("SELECT * FROM native_pomodoro_session")), timerBefore)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), tasksBefore)
        let settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        let gtd = try XCTUnwrap(settings["gtd"] as? [String: Any])
        XCTAssertEqual(gtd["retained548"] as? String, "keep")
        XCTAssertEqual((gtd["pomodoro"] as? [String: Any])?["retained548"] as? String, "keep")
        if type == "pomodoro" {
            XCTAssertEqual((settings["features"] as? [String: Any])?["pomodoro"] as? Bool, value as? Bool)
        } else {
            let field = ["pomodoroLinkTask": "linkTask", "pomodoroAutoStartBreaks": "autoStartBreaks",
                "pomodoroAutoStartFocus": "autoStartFocus", "pomodoroCompletionAlert": "completionAlert",
                "pomodoroDurations": "customDurations"][type]!
            let actual = try XCTUnwrap((gtd["pomodoro"] as? [String: Any])?[field])
            XCTAssertEqual(try json([actual]), try json([value]))
        }
    }
    func testFeatureSettingColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoro", false) }
    func testLinkSettingColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoroLinkTask", false) }
    func testAutoBreakSettingColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoroAutoStartBreaks", true) }
    func testAutoFocusSettingColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoroAutoStartFocus", true) }
    func testCompletionAlertColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoroCompletionAlert", false) }
    func testDurationSettingColdCleanupDoesNotTouchTimer() async throws { try await exercise("pomodoroDurations", ["focusMinutes": 50, "breakMinutes": 10]) }

    func testDurationDraftUsesCapturedRNPartialValuesAndKeepsScheduleDraft() async throws {
        try await seed(["customDurations": ["focusMinutes": 12.5]])
        let core = host(); _ = try await core.start()
        let options = try await call(core, "gtdPomodoroOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        let before = try json(rows("SELECT * FROM settings"))
        let normalized = try await call(core, "gtdWorkflowDraft", ["type": "pomodoroDurations", "focusMinutes": "invalid", "breakMinutes": "200tail", "expected": try XCTUnwrap(expected["pomodoroDurations"])])
        XCTAssertEqual(normalized["valid"] as? Bool, true)
        XCTAssertEqual((normalized["value"] as? [String: Any])?["focusMinutes"] as? Int, 13)
        XCTAssertEqual((normalized["value"] as? [String: Any])?["breakMinutes"] as? Int, 180)
        let schedule = try await call(core, "gtdWorkflowDraft", ["value": "930"])
        XCTAssertEqual(schedule["value"] as? String, "09:30")
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testUnsupportedDurationDoesNotDisableAnotherFlag() async throws {
        try await seed(["customDurations": ["unexpected": 1]])
        let core = host(); _ = try await core.start()
        let options = try await call(core, "gtdPomodoroOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        XCTAssertTrue(expected["pomodoroDurations"] is NSNull)
        XCTAssertTrue(expected["pomodoroLinkTask"] is [String: Any])
        let result = try await call(core, "gtdWorkflow", ["requestId": UUID().uuidString.lowercased(),
            "edit": ["type": "pomodoroLinkTask", "value": false], "expected": try XCTUnwrap(expected["pomodoroLinkTask"])])
        XCTAssertEqual(result["changed"] as? Bool, true)
        let settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        let pomodoro = (settings["gtd"] as? [String: Any])?["pomodoro"] as? [String: Any]
        XCTAssertEqual((pomodoro?["customDurations"] as? [String: Any])?["unexpected"] as? Int, 1)
    }

    func testDisabledFeatureRejectsOldDependentWitnessEvenForNoop() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let options = try await call(core, "gtdPomodoroOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        _ = try await call(core, "gtdWorkflow", ["requestId": UUID().uuidString.lowercased(),
            "edit": ["type": "pomodoro", "value": false], "expected": try XCTUnwrap(expected["pomodoro"])])
        let disabled = try await call(core, "gtdPomodoroOptions")
        let disabledExpected = try XCTUnwrap(disabled["expected"] as? [String: Any])
        for field in fields where field != "pomodoro" { XCTAssertTrue(disabledExpected[field] is NSNull) }
        let before = try json(rows("SELECT * FROM settings"))
        var writes = 0, journals = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(INSERT|UPDATE|DELETE)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        faults.journalWrite = { journals += 1 }
        await failure { _ = try await self.call(core, "gtdWorkflow", ["requestId": UUID().uuidString.lowercased(),
            "edit": ["type": "pomodoroLinkTask", "value": true], "expected": try XCTUnwrap(expected["pomodoroLinkTask"])]) }
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0)
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testMalformedDurationsAndDuplicateInputDoNotWriteOrCreateJournal() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let options = try await call(core, "gtdPomodoroOptions")
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        let witness = try XCTUnwrap(expected["pomodoroDurations"])
        let before = try json(rows("SELECT * FROM settings"))
        var writes = 0, journals = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(INSERT|UPDATE|DELETE)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        faults.journalWrite = { journals += 1 }
        let invalid: [[String: Any]] = [
            ["focusMinutes": true, "breakMinutes": 5], ["focusMinutes": 25],
            ["focusMinutes": 25, "breakMinutes": 5, "extra": 0],
            ["focusMinutes": 0, "breakMinutes": 5], ["focusMinutes": 181, "breakMinutes": 5],
            ["focusMinutes": 1.5, "breakMinutes": 5], ["focusMinutes": "25", "breakMinutes": 5],
        ]
        for value in invalid {
            let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(),
                "edit": ["type": "pomodoroDurations", "value": value], "expected": witness]
            await failure { _ = try await self.call(core, "gtdWorkflow", request) }
        }
        for text in [String(repeating: "x", count: 513), String(repeating: "😀", count: 129)] {
            await failure { _ = try await self.call(core, "gtdWorkflowDraft", ["type": "pomodoroDurations",
                "focusMinutes": text, "breakMinutes": "5", "expected": witness]) }
        }
        let duplicated = "{\"type\":\"pomodoroDurations\",\"focusMinutes\":\"25\",\"focusMinutes\":\"50\",\"breakMinutes\":\"5\",\"expected\":" + (try json(witness)) + "}"
        await failure { _ = try await core.call("gtdWorkflowDraft", argumentsJSON: self.json([duplicated])) }
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0)
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    #if DEBUG && os(iOS) && targetEnvironment(simulator)
    func testIsolatedPomodoroPickerAndPanelSavedDiagnostics() async throws {
        let identifier = UUID().uuidString.lowercased()
        let directory = root.appendingPathComponent("NativeUITests/" + identifier)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let faults = HostIOFaults(); faults.secretService = "mindwtr.native-keychain.fixture." + identifier
        let core = CoreHost(databaseURL: directory.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; _ = try await core.start()
        let focus = try object(await core.call("focus", argumentsJSON: "[1]"))
        let revision = try XCTUnwrap(focus["revision"] as? String)
        _ = try await call(core, "pomodoroTasks", ["offset": 0, "limit": 1, "revision": revision])
        _ = try await call(core, "pomodoroTasks", ["offset": 1, "limit": 1, "revision": revision])
        await failure { _ = try await self.call(core, "pomodoroTasks", ["offset": 0, "limit": 1, "revision": "stale"]) }
        _ = try await core.readPomodoroPanel(presentationJSON: json(["collapsed": false, "lastEvent": NSNull()]))
        await failure { _ = try await core.readPomodoroPanel(presentationJSON: "{}") }
        _ = try await core.readPomodoroAlarmIntent()
        await failure { _ = try await core.call("pomodoroAlarmReadHost") }
        let message = "Native iOS Pomodoro panel transition acknowledged"
        for context in [["releaseCheck": "v1.3.5/ios-pomodoro-ui", "outcome": "pending"],
                        ["releaseCheck": "v1.3.5/ios-pomodoro-ui", "outcome": "confirmed", "title": "private"],
                        ["releaseCheck": "wrong", "outcome": "confirmed"]] {
            await failure { _ = try await core.call("logLine", argumentsJSON: self.json([message, self.json(context)])) }
        }
        let shared = try object(await core.diagnosticsFileAction("logShare"))
        let url = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        let savedLog = try String(contentsOf: url, encoding: .utf8)
        let alarmMarkers = savedLog.split(separator: "\n").filter { $0.contains("v1.3.5/ios-pomodoro-alarm-plan") }
        XCTAssertEqual(alarmMarkers.count, 1)
        let alarmMarker = try object(String(XCTUnwrap(alarmMarkers.first)))
        XCTAssertEqual(alarmMarker["message"] as? String, "Native Pomodoro alarm intent read")
        XCTAssertEqual(alarmMarker["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-pomodoro-alarm-plan", "outcome": "uninitialized"])
        let panelMarkers = savedLog.split(separator: "\n").filter { $0.contains("v1.3.5/ios-pomodoro-panel") }
        XCTAssertEqual(panelMarkers.count, 1)
        let panelMarker = try object(String(XCTUnwrap(panelMarkers.first)))
        XCTAssertEqual(panelMarker["message"] as? String, "Native Pomodoro panel state read")
        XCTAssertEqual(panelMarker["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-pomodoro-panel", "outcome": "uninitialized"])
        let markers = savedLog.split(separator: "\n")
            .filter { $0.contains("v1.3.5/ios-pomodoro-picker") }
        XCTAssertEqual(markers.count, 1)
        let marker = try object(String(XCTUnwrap(markers.first)))
        XCTAssertEqual(marker["message"] as? String, "Native Pomodoro task choices loaded")
        XCTAssertEqual(marker["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-pomodoro-picker", "outcome": "confirmed"])
    }

    func testIsolatedRealTerminalCleanupInjectorAlsoOwnsGtdSettings() async throws {
        let identifier = UUID().uuidString.lowercased()
        let directory = root.appendingPathComponent("NativeUITests/" + identifier)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let isolated = directory.appendingPathComponent("mindwtr.sqlite")
        let faults = HostIOFaults(); faults.secretService = "mindwtr.native-keychain.fixture." + identifier
        let core = CoreHost(databaseURL: isolated, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }
        try await core.configureIsolatedCaptureTerminalFailureOnce(); _ = try await core.start()
        _ = try await call(core, "dataSetting", ["requestId": UUID().uuidString.lowercased(),
            "edit": ["type": "debugLogging", "value": true]])
        let options = try await call(core, "gtdWorkflowOptions")
        let witness = try XCTUnwrap((options["expected"] as? [String: Any])?["pomodoro"] as? [String: Any])
        let current = ((options["hub"] as? [String: Any])?["pomodoro"] as? [String: Any])?["value"] as? Bool ?? false
        let request: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "edit": ["type": "pomodoro", "value": !current], "expected": witness]
        await failure { _ = try await self.call(core, "gtdWorkflow", request) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: isolated.appendingPathExtension("pending.json").path))
        let pendingLog = (try? String(contentsOf: directory.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(pendingLog.contains("v1.3.5/ios-pomodoro-settings"))
        let retried = try await core.retryPending()
        let result = try object(XCTUnwrap(retried))
        XCTAssertEqual(result["type"] as? String, "pomodoro")
        XCTAssertEqual(result["value"] as? Bool, !current)
        XCTAssertEqual(result["changed"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: isolated.appendingPathExtension("pending.json").path))
        let again = try await core.retryPending(); XCTAssertNil(again)
        let shared = try object(await core.diagnosticsFileAction("logShare"))
        let shareURL = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        let markers = try String(contentsOf: shareURL, encoding: .utf8).split(separator: "\n")
            .filter { $0.contains("v1.3.5/ios-pomodoro-settings") }
        XCTAssertEqual(markers.count, 1)
        let marker = try object(String(XCTUnwrap(markers.first)))
        XCTAssertEqual(marker["message"] as? String, "Native iOS Pomodoro settings saved")
        let context = try XCTUnwrap(marker["context"] as? [String: String])
        XCTAssertEqual(context, ["releaseCheck": "v1.3.5/ios-pomodoro-settings", "outcome": "confirmed"])
    }
    #endif

}
