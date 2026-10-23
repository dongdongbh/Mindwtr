import Foundation
import XCTest
@testable import MindwtrNativeCore

/// Five controls through actual private bundle/JSC, inline journal and SQLite.
/// This test file does not activate timer UI, alarms or completion feedback.
final class NativePomodoroActionsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let observed: Int64 = 1_791_590_400_000
    private let at = "2026-10-10T00:00:00.000Z"
    private let device = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    private let actions = ["toggle", "reset", "switchPhase", "setDurations", "selectTask"]

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual Task529 bundle required") }
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
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    @discardableResult private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(args)).utf8)) as? [[String: Any]])
    }
    private func snapshot() throws -> String {
        var data: [String: Any] = [:]
        for table in ["tasks", "projects", "settings", "native_pomodoro_session", "native_request_receipts"] {
            data[table] = try rows("SELECT * FROM " + table + " ORDER BY rowid")
        }
        return try json(data)
    }
    private func request(_ action: String, id: String = UUID().uuidString.lowercased(), time: Int64? = nil,
                         focus: Bool = false, breaks: Bool = false, taskID: String? = "other") throws -> String {
        var value: [String: Any] = ["action": action, "requestId": id, "observedAtMs": time ?? observed, "localDayKey": "2026-10-10"]
        if action == "initialize" { value["durations"] = ["focusMinutes": 25, "breakMinutes": 5] }
        else {
            value["autoStart"] = ["autoStartFocus": focus, "autoStartBreaks": breaks]
            if action == "setDurations" { value["durations"] = ["focusMinutes": 50, "breakMinutes": 10] }
            if action == "selectTask" { value["taskId"] = taskID.map { $0 as Any } ?? NSNull() }
        }
        return try json(value)
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func domainWrite(_ sql: String) -> Bool {
        sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|native_pomodoro_session|native_request_receipts)\b"#, options: .regularExpression) != nil
    }
    private func seed(running: Bool = true, selected: Bool = true) async throws {
        let core = host(); _ = try await core.start()
        _ = try await core.writePomodoroTransition(requestJSON: request("initialize")); await core.close()
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["deviceId"] = device; try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        for (id, minutes) in [("task", 4), ("other", 7)] {
            try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,timeSpentMinutes,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'next','[]','[]',?,?,1,?,?,0,0,0,0)", [id, "PRIVATE " + id, at, at, device, minutes])
        }
        var state = try currentState(), session = try XCTUnwrap(state["session"] as? [String: Any])
        var timer = try XCTUnwrap(session["timerState"] as? [String: Any])
        timer["isRunning"] = running; session["timerState"] = timer
        if running { session["phaseEndsAt"] = at }
        if selected { session["selectedTaskId"] = "task" }
        state["session"] = session; try rows("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
    }
    private func currentState() throws -> [String: Any] {
        try object(XCTUnwrap(rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
    }
    private func session() throws -> [String: Any] { try XCTUnwrap(currentState()["session"] as? [String: Any]) }
    private func timer() throws -> [String: Any] { try XCTUnwrap(session()["timerState"] as? [String: Any]) }
    private func command() throws -> [String: Any] { try object(String(contentsOf: journal, encoding: .utf8)) }
    private func assertRetainedCommand(_ before: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        let after = try command()
        // Recovery may re-encode the outer envelope; inner JSON strings remain literal.
        XCTAssertEqual(Data(try XCTUnwrap(after["argumentsJSON"] as? String).utf8), Data(try XCTUnwrap(before["argumentsJSON"] as? String).utf8), file: file, line: line)
        XCTAssertEqual(Data(try json(after).utf8), Data(try json(before).utf8), file: file, line: line)
    }
    private func planJSON() throws -> String {
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command()["argumentsJSON"] as? String).utf8)) as? [String])
        return try XCTUnwrap(args.first)
    }
    private func credit(_ expected: Int = 29) throws {
        XCTAssertEqual(try rows("SELECT timeSpentMinutes FROM tasks WHERE id='task'").first?["timeSpentMinutes"] as? Int, expected)
        XCTAssertEqual(try rows("SELECT timeSpentMinutes FROM tasks WHERE id='other'").first?["timeSpentMinutes"] as? Int, 7)
    }
    private func enterCase() throws -> URL {
        let previous = root!; root = previous.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); return previous
    }
    private func capture(_ core: CoreHost) async throws {
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Later ordinary task", "options": captureOptions, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])]))
    }

    func testEachControlUsesOneExistingOwnerReceiptAndClosedCanonicalSession() async throws {
        for action in actions {
            let previous = try enterCase(); try await seed(running: false)
            let faults = HostIOFaults(); var markers: [String] = [], writes = 0
            faults.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers.append($0) } }
            let core = host(faults); _ = try await core.start()
            faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }
            let original = try request(action), reply = try object(await core.writePomodoroTransition(requestJSON: original))
            XCTAssertEqual(reply["kind"] as? String, "confirmed"); XCTAssertEqual(reply["projectionReloaded"] as? Bool, true)
            let state = try currentState(), active = try session()
            XCTAssertEqual(state["generation"] as? Int, 1); XCTAssertEqual(active["updatedAtMs"] as? Int64, observed + 1)
            XCTAssertNil(active["lastEvent"]); XCTAssertEqual(markers, ["pomodoroActionConfirmed:" + action])
            let id = try XCTUnwrap(object(original)["requestId"] as? String)
            let receipt = try XCTUnwrap(rows("SELECT method,reply FROM native_request_receipts WHERE request_id=?", [id]).first)
            XCTAssertTrue(try XCTUnwrap(receipt["method"] as? String).hasPrefix("[\"pomodoroTransition\","))
            XCTAssertEqual(try json(object(XCTUnwrap(receipt["reply"] as? String))), try json(XCTUnwrap(reply["result"])))
            XCTAssertEqual(writes, 2, "session and receipt only"); try credit(4)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try await capture(core)
            await core.close(); root = previous
        }
    }

    func testPresetAtExpiryCreditsOldDurationAndPausesResolvedBreak() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let reply = try object(await core.writePomodoroTransition(requestJSON: request("setDurations", focus: true, breaks: true)))
        let result = try XCTUnwrap(reply["result"] as? [String: Any]); XCTAssertEqual(result["creditedMinutes"] as? Int, 25)
        try credit(); let active = try session(), clock = try timer()
        XCTAssertEqual(try json(XCTUnwrap(active["durations"])), try json(["focusMinutes": 50, "breakMinutes": 10]))
        XCTAssertEqual(clock["phase"] as? String, "break"); XCTAssertEqual(clock["remainingSeconds"] as? Int, 600)
        XCTAssertEqual(clock["isRunning"] as? Bool, false); XCTAssertNil(active["phaseEndsAt"])
    }

    func testSelectionAndNullAtExpiryKeepAllFourAutoStartPreferencesAndCreditOnlyBeforeTask() async throws {
        for focus in [false, true] { for breaks in [false, true] { for selected in ["other", nil] as [String?] {
            let previous = try enterCase(); try await seed(); let other = try json(rows("SELECT * FROM tasks WHERE id='other'"))
            let core = host(); _ = try await core.start()
            let reply = try object(await core.writePomodoroTransition(requestJSON: request("selectTask", focus: focus, breaks: breaks, taskID: selected)))
            XCTAssertEqual((reply["result"] as? [String: Any])?["creditedMinutes"] as? Int, 25)
            try credit(); XCTAssertEqual(try json(rows("SELECT * FROM tasks WHERE id='other'")), other)
            let active = try session(), clock = try timer()
            XCTAssertEqual(active["selectedTaskId"] as? String, selected); XCTAssertEqual(clock["phase"] as? String, "break")
            XCTAssertEqual(clock["isRunning"] as? Bool, breaks)
            XCTAssertEqual(active["phaseEndsAt"] as? String, breaks ? "2026-10-10T00:05:00.000Z" : nil)
            await core.close(); root = previous
        } } }
    }

    func testExpiryToggleDoesNotToggleTwiceAndResetSwitchTransformResolvedPhase() async throws {
        for action in ["toggle", "reset", "switchPhase"] { for breaks in [false, true] {
            let previous = try enterCase(); try await seed(); let core = host(); _ = try await core.start()
            _ = try await core.writePomodoroTransition(requestJSON: request(action, focus: true, breaks: breaks))
            try credit(); let active = try session(), clock = try timer()
            XCTAssertEqual(clock["phase"] as? String, action == "switchPhase" ? "focus" : "break")
            XCTAssertEqual(clock["isRunning"] as? Bool, action == "toggle" && breaks)
            XCTAssertEqual(clock["remainingSeconds"] as? Int, action == "switchPhase" ? 1500 : 300)
            XCTAssertEqual(active["phaseEndsAt"] as? String, action == "toggle" && breaks ? "2026-10-10T00:05:00.000Z" : nil)
            let history = try XCTUnwrap(active["sessionHistory"] as? [String: Any]); XCTAssertEqual(history["totalCompletedFocusSessions"] as? Int, 1)
            await core.close(); root = previous
        } }
    }

    func testSkewedSameTimeControlsUseMonotonicStampButActualObservationForDeadline() async throws {
        try await seed(running: false); let core = host(); _ = try await core.start()
        let before = try currentState(), original = try request("toggle", time: observed - 1000)
        _ = try await core.writePomodoroTransition(requestJSON: original)
        XCTAssertEqual(try session()["updatedAtMs"] as? Int64, observed + 1)
        XCTAssertEqual(try session()["phaseEndsAt"] as? String, "2026-10-10T00:24:59.000Z")
        _ = try await core.writePomodoroTransition(requestJSON: request("reset", time: observed - 1000))
        XCTAssertEqual(try session()["updatedAtMs"] as? Int64, observed + 2)
        XCTAssertEqual(try currentState()["generation"] as? Int, (before["generation"] as? Int ?? 0) + 2)
        let paused = try snapshot(), reply = try object(await core.writePomodoroTransition(requestJSON: request("reconcile")))
        XCTAssertEqual(reply["kind"] as? String, "noop"); XCTAssertEqual(try snapshot(), paused)
        try credit(4)
    }

    func testMalformedControlTransportAndSemanticIdentitiesPublishNoIntentOrMutation() async throws {
        try await seed(running: false); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let before = try snapshot(); var writes = 0, intents = 0, markers = 0
        faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }; faults.journalWrite = { intents += 1 }
        faults.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers += 1 } }
        for action in actions {
            for mode in ["extra", "missingOptions", "optionNumber", "boolTime", "unsafe", "day", "duplicate", "unknown"] {
                var value = try object(request(action))
                if mode == "extra" { value["legacy"] = true }
                if mode == "missingOptions" { value.removeValue(forKey: "autoStart") }
                if mode == "optionNumber" { value["autoStart"] = ["autoStartFocus": 1, "autoStartBreaks": false] }
                if mode == "boolTime" { value["observedAtMs"] = true }
                if mode == "unsafe" { value["observedAtMs"] = Int64(9_007_199_254_740_992) }
                if mode == "day" { value["localDayKey"] = "2026-02-31" }
                if mode == "unknown" { value["action"] = "legacyToggle" }
                let raw = mode == "duplicate" ? try json(value).replacingOccurrences(of: "\"action\":", with: "\"action\":\"toggle\",\"action\":") : try json(value)
                await failure { _ = try await core.writePomodoroTransition(requestJSON: raw) }
            }
        }
        for identity in [NSNull(), "", " task", "__proto__", true, String(repeating: "😀", count: 251)] as [Any] {
            var value = try object(request("selectTask")); value["taskId"] = identity
            // Explicit null is valid and is checked separately; absence is invalid.
            if identity is NSNull { value.removeValue(forKey: "taskId") }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(value)) }
        }
        for duration in [true, 0, 181, 25.5, NSNull()] as [Any] {
            var value = try object(request("setDurations")); value["durations"] = ["focusMinutes": duration, "breakMinutes": 5]
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(value)) }
        }
        let oversized = try request("selectTask", taskID: String(repeating: "x", count: 8193))
        await failure { _ = try await core.writePomodoroTransition(requestJSON: oversized) }
        for method in ["pomodoroTransitionPrepare", "pomodoroTransitionValidate", "pomodoroTransitionCommit", "pomodoroTransitionOutcome", "pomodoroTransitionWrite"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[]") }
        }
        XCTAssertEqual(writes, 0); XCTAssertEqual(intents, 0); XCTAssertEqual(markers, 0); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testMaximumUTF16SelectionStaysExactAndGenerationOverflowRefusesBeforeIntent() async throws {
        try await seed(running: false); let core = host(); _ = try await core.start()
        let identity = String(repeating: "😀", count: 250), maximum = try request("selectTask", taskID: identity)
        _ = try await core.writePomodoroTransition(requestJSON: maximum + String(repeating: " ", count: 8192 - maximum.utf8.count))
        XCTAssertEqual(try session()["selectedTaskId"] as? String, identity)
        let another = try request("selectTask", taskID: identity), saved = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: another + String(repeating: " ", count: 8193 - another.utf8.count)) }
        XCTAssertEqual(try snapshot(), saved); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        var state = try currentState(); state["generation"] = Int64(9_007_199_254_740_991)
        try rows("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
        let faults = HostIOFaults(), reopened = host(faults); _ = try await reopened.start(); let before = try snapshot(); var intents = 0
        faults.journalWrite = { intents += 1 }
        await failure { _ = try await reopened.writePomodoroTransition(requestJSON: self.request("reset")) }
        XCTAssertEqual(intents, 0); XCTAssertEqual(try snapshot(), before)
    }

    func testRetainedPresetFreezesUUIDActionDurationsOptionsDayAndObservation() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalWrite = { throw HostFailure("intent failed") }; let original = try request("setDurations"), before = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        for field in ["requestId", "action", "durations", "autoStart", "localDayKey", "observedAtMs"] {
            var changed = try object(original)
            if field == "requestId" { changed[field] = UUID().uuidString.lowercased() }
            if field == "action" { changed = try object(request("reset")); changed["requestId"] = try object(original)["requestId"] }
            if field == "durations" { changed[field] = ["focusMinutes": 51, "breakMinutes": 10] }
            if field == "autoStart" { changed[field] = ["autoStartFocus": true, "autoStartBreaks": false] }
            if field == "localDayKey" { changed[field] = "2026-10-11" }
            if field == "observedAtMs" { changed[field] = observed + 1000 }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(changed)) }
            let proof = try object(await core.probePomodoroTransitionOutcome(requestJSON: json(changed)))
            XCTAssertEqual(proof["kind"] as? String, "unproven", field)
        }
        XCTAssertEqual(try snapshot(), before); faults.journalWrite = nil
        _ = try await core.writePomodoroTransition(requestJSON: original); try credit()
        XCTAssertEqual((try session()["durations"] as? [String: Any])?["focusMinutes"] as? Int, 50)
    }

    func testAtomicControlFaultCutsRollbackAndExactRetryCreditsOnce() async throws {
        for cut in ["UPDATE tasks", "UPDATE native_pomodoro_session", "INSERT INTO native_request_receipts", "SELECT id, state_json", "COMMIT"] {
            let previous = try enterCase(); try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let original = try request("reset"), before = try snapshot(); var attempted = false, markers = 0
            faults.beforeSQL = { sql in
                if sql.hasPrefix("UPDATE tasks") { attempted = true }
                if attempted && sql.hasPrefix(cut) { throw HostFailure("control fault") }
            }
            faults.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers += 1 } }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(try snapshot(), before, cut); XCTAssertEqual(markers, 0)
            XCTAssertEqual(try json(XCTUnwrap(object(planJSON())["request"])), original)
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
            faults.beforeSQL = nil; _ = try await core.writePomodoroTransition(requestJSON: original)
            try credit(); XCTAssertEqual(markers, 1); XCTAssertEqual(try timer()["phase"] as? String, "break")
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close(); root = previous
        }
    }

    func testLostActualControlCommitReplyColdReceiptWinsLaterTaskAndSessionEdits() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var attempted = false, lost = false
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { attempted = true } }
        faults.afterSQL = { if attempted && $0 == "COMMIT" && !lost { lost = true; throw HostFailure("lost control COMMIT reply") } }
        let original = try request("selectTask"); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let literal = try planJSON(), expected = try XCTUnwrap(object(literal)["result"]); try credit(); await core.close()
        try rows("UPDATE tasks SET title='LATER',timeSpentMinutes=99,rev=rev+1 WHERE id='task'")
        var later = try currentState(); later["generation"] = 20
        var active = try XCTUnwrap(later["session"] as? [String: Any]); active["selectedTaskId"] = "task"; later["session"] = active
        try rows("UPDATE native_pomodoro_session SET state_json=?", [json(later)])
        let before = try snapshot(), replay = HostIOFaults(); var mutations = 0
        replay.beforeSQL = { if self.domainWrite($0) { mutations += 1 } }
        let reopened = host(replay), startup = try object(await reopened.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "pomodoroTransitionCommit"); XCTAssertEqual(try json(XCTUnwrap(recovery["result"])), try json(expected))
        XCTAssertEqual(mutations, 0); XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let confirmedProbe = try object(await reopened.probePomodoroTransitionOutcome(requestJSON: original))
        XCTAssertEqual(confirmedProbe["kind"] as? String, "confirmed")
    }

    func testSessionOnlyTerminalReceiptMissingChangedMalformedAndBetweenProbesRemainOwed() async throws {
        for action in ["reset", "selectTask", "setDurations"] { for mode in ["missing", "changed", "malformed", "betweenProbes"] {
            let previous = try enterCase(); try await seed(running: false)
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request(action)
            faults.journalRemove = { throw HostFailure("terminal removal") }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            let frozen = try object(planJSON()), saved = try command(), savedBytes = try Data(contentsOf: journal); await core.close()
            let id = try XCTUnwrap(object(original)["requestId"] as? String)
            if mode == "missing" {
                try rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
                try rows("UPDATE native_pomodoro_session SET state_json=?", [XCTUnwrap(frozen["sessionBefore"])])
            }
            if mode == "changed" { try rows("UPDATE native_request_receipts SET method='foreign' WHERE request_id=?", [id]) }
            if mode == "malformed" { try rows("UPDATE native_request_receipts SET reply='{}' WHERE request_id=?", [id]) }
            let before = try snapshot(), replay = HostIOFaults(); var reads = 0, mutations = 0, journalWrites = 0, vanished = false, markers = 0
            replay.journalWrite = { journalWrites += 1 }
            replay.beforeSQL = { sql in
                if sql == "SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?" { reads += 1 }
                if mode == "betweenProbes" && sql == "BEGIN IMMEDIATE" && reads > 0 && !vanished {
                    vanished = true; try self.rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
                }
                if self.domainWrite(sql) { mutations += 1 }
            }
            replay.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers += 1 } }
            await failure { _ = try await self.host(replay).start() }
            XCTAssertEqual(mutations, 0); XCTAssertEqual(markers, 0)
            if mode == "malformed" {
                XCTAssertEqual(journalWrites, 0); XCTAssertEqual(try Data(contentsOf: journal), savedBytes)
            } else {
                XCTAssertEqual(journalWrites, 1); try assertRetainedCommand(saved)
            }
            if mode == "betweenProbes" { XCTAssertTrue(vanished) } else { XCTAssertEqual(try snapshot(), before) }
            root = previous
        } }
    }

    func testCreditingControlProjectionFailureKeepsProofAndBlocksOrdinaryUntilExactAdoption() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); var committed = false
        faults.afterSQL = { if $0 == "COMMIT" { committed = true } }
        faults.beforeSQL = { if committed && $0.hasPrefix("SELECT rowid as _rowid, * FROM tasks") { throw HostFailure("control projection failed") } }
        let original = try request("selectTask"), reply = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(reply["kind"] as? String, "confirmed"); XCTAssertEqual(reply["projectionReloaded"] as? Bool, false); try credit()
        let settled = try currentState(), literal = try planJSON(); XCTAssertNotNil(try command()["terminal"])
        let confirmedProbe = try object(await core.probePomodoroTransitionOutcome(requestJSON: original))
        XCTAssertEqual(confirmedProbe["kind"] as? String, "confirmed")
        await failure { try await self.capture(core) }
        var different = try object(original); different["taskId"] = NSNull()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(different)) }
        XCTAssertEqual(try planJSON(), literal)
        faults.beforeSQL = nil; let retry = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(retry["projectionReloaded"] as? Bool, true); XCTAssertEqual(try json(currentState()), try json(settled)); try credit()
        try await capture(core); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
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

    func testColdForgedActionsPresetSelectionAndTerminalRefuseBeforeSQLiteOrGC() async throws {
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("retained control") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request("selectTask")) }; await core.close()
        let original = try command(), frozen = try object(planJSON()), before = try snapshot(), bytes = try Data(contentsOf: database), sentinels = try gcSentinels()
        for mode in ["action", "preset", "selection", "reserved", "after", "result", "duplicate", "terminal", "outer", "overflow"] {
            var command = original, prepared = frozen, input = try XCTUnwrap(prepared["request"] as? [String: Any])
            if mode == "action" { input["action"] = "legacyToggle" }
            if mode == "preset" { input = try object(request("setDurations")); input["durations"] = ["focusMinutes": true, "breakMinutes": 5] }
            if mode == "selection" { input["taskId"] = "task" }
            if mode == "reserved" { input["taskId"] = "__proto__" }
            prepared["request"] = input
            if mode == "after" { var after = try object(XCTUnwrap(prepared["sessionAfter"] as? String)); after["generation"] = 999; prepared["sessionAfter"] = try json(after) }
            if mode == "result" { var result = try XCTUnwrap(prepared["result"] as? [String: Any]); result["creditedMinutes"] = 50; prepared["result"] = result }
            if mode == "terminal" { command["terminal"] = ["success": ["_0": "{\"forged\":true}"]] }
            if mode == "outer" { command["editorDraft"] = NSNull() }
            if mode == "overflow" { prepared["sessionAfter"] = String(repeating: "x", count: 1_000_001) }
            let literal = mode == "duplicate" ? try json(prepared).replacingOccurrences(of: "\"action\":", with: "\"action\":\"reset\",\"action\":") : try json(prepared)
            command["argumentsJSON"] = try json([literal]); let pending = Data(try json(command).utf8); try pending.write(to: journal)
            let replay = HostIOFaults(); var sql = 0; replay.beforeSQL = { _ in sql += 1 }
            await failure { _ = try await self.host(replay).start() }
            XCTAssertEqual(sql, 0, mode); XCTAssertEqual(try Data(contentsOf: database), bytes, mode)
            XCTAssertEqual(try snapshot(), before, mode); XCTAssertEqual(try Data(contentsOf: journal), pending, mode)
            for (path, sentinel) in sentinels { XCTAssertEqual(try Data(contentsOf: path), sentinel, mode) }
        }
    }

    func testFirstStaleControlRefusalOnlyClearsWithDefiniteRollbackAndRetainedIntentStays() async throws {
        for mode in ["first", "retained", "rollback"] {
            let previous = try enterCase(); try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let original = try request("setDurations")
            if mode == "retained" {
                faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("attempted control") } }
                await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            }
            var changed = false
            faults.beforeSQL = { sql in
                if sql == "BEGIN IMMEDIATE" && !changed { changed = true; try self.rows("UPDATE tasks SET title='EXTERNAL' WHERE id='task'") }
                if mode == "rollback" && sql == "ROLLBACK" { throw HostFailure("rollback failure") }
            }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(FileManager.default.fileExists(atPath: journal.path), mode != "first", mode)
            XCTAssertEqual(try timer()["phase"] as? String, "focus"); try credit(4)
            await core.close(); root = previous
        }
    }

    func testSavedEditorRefusesNewControlAndColdSuccessPreservesCheckpoint() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "task", generation: 1,
            payloadJSON: try json(["version": 2, "taskID": "task", "raw": ["title": "PRIVATE retained draft"]]))
        try await core.checkpointEditorDraft(checkpoint)
        let editor = EditorDraftStore(databaseURL: database), saved = try Data(contentsOf: editor.url), before = try snapshot()
        for action in actions { await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request(action)) } }
        XCTAssertEqual(try Data(contentsOf: editor.url), saved); XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        // A separate genuine committed control becomes owed before a saved
        // checkpoint is introduced; startup must preserve both authorities.
        let previous = try enterCase(); try await seed(); let faults = HostIOFaults(), owed = host(faults); _ = try await owed.start()
        faults.journalRemove = { throw HostFailure("terminal") }
        await failure { _ = try await owed.writePomodoroTransition(requestJSON: self.request("reset")) }; await owed.close()
        let coldEditor = EditorDraftStore(databaseURL: database); try coldEditor.checkpoint(checkpoint)
        let coldBytes = try Data(contentsOf: coldEditor.url), coldBefore = try snapshot()
        await failure { _ = try await self.host().start() }
        XCTAssertEqual(try Data(contentsOf: coldEditor.url), coldBytes); XCTAssertEqual(try snapshot(), coldBefore)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); root = previous
    }

    func testOldBundleAuthoredInitializeAndReconcileRetainExactReceiptUnderNewBundle() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_POMODORO_OLD_BUNDLE"] else { throw XCTSkip("Frozen Task520 bundle required for old-authored journal") }
        let currentBundle = bundle!, oldBundle = root.appendingPathComponent("old-core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: oldBundle)
        for action in ["initialize", "reconcile"] {
            let previous = try enterCase(); bundle = oldBundle
            if action == "reconcile" { try await seed() }
            let faults = HostIOFaults(), originalHost = host(faults); _ = try await originalHost.start()
            faults.journalRemove = { throw HostFailure("old terminal retained") }
            let original = try request(action)
            await failure { _ = try await originalHost.writePomodoroTransition(requestJSON: original) }
            let literal = try planJSON(), frozen = try command(), id = try XCTUnwrap(object(original)["requestId"] as? String)
            let receipt = try json(rows("SELECT method,reply FROM native_request_receipts WHERE request_id=?", [id]))
            XCTAssertNotNil(frozen["terminal"]); XCTAssertEqual(try json(XCTUnwrap(object(literal)["request"])), original)
            await originalHost.close(); bundle = currentBundle
            let replay = HostIOFaults(); var mutations = 0
            replay.beforeSQL = { if self.domainWrite($0) { mutations += 1 } }
            let reopened = host(replay), startup = try object(await reopened.start())
            XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "pomodoroTransitionCommit")
            XCTAssertEqual(mutations, 0); XCTAssertEqual(try json(rows("SELECT method,reply FROM native_request_receipts WHERE request_id=?", [id])), receipt)
            let confirmedProbe = try object(await reopened.probePomodoroTransitionOutcome(requestJSON: original))
            XCTAssertEqual(confirmedProbe["kind"] as? String, "confirmed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await reopened.close(); root = previous
        }
    }

    func testOldBundleRefusesNewActionBeforeSQLiteGCOrJournalLoss() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_POMODORO_OLD_BUNDLE"] else { throw XCTSkip("Frozen Task520 bundle required for downgrade refusal") }
        try await seed(); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("retain new preset") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request("setDurations")) }; await core.close()
        let pending = try Data(contentsOf: journal), bytes = try Data(contentsOf: database), before = try snapshot(), sentinels = try gcSentinels()
        let old = root.appendingPathComponent("old-core-host.js"); try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: old); bundle = old
        let refusal = HostIOFaults(); var statements = 0; refusal.beforeSQL = { _ in statements += 1 }
        await failure { _ = try await self.host(refusal).start() }
        XCTAssertEqual(statements, 0); XCTAssertEqual(try Data(contentsOf: database), bytes); XCTAssertEqual(try snapshot(), before)
        XCTAssertEqual(try Data(contentsOf: journal), pending)
        for (path, sentinel) in sentinels { XCTAssertEqual(try Data(contentsOf: path), sentinel) }
    }

    func testOldActionsHaveNoControlMarkerAndClosedHostKeepsExactOwedRequest() async throws {
        let faults = HostIOFaults(), core = host(faults); var markers = 0
        faults.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers += 1 } }
        _ = try await core.start(); _ = try await core.writePomodoroTransition(requestJSON: request("initialize"))
        let reconciled = try object(await core.writePomodoroTransition(requestJSON: request("reconcile")))
        XCTAssertEqual(reconciled["kind"] as? String, "noop")
        XCTAssertEqual(markers, 0)
        faults.beforeSQL = { if $0.hasPrefix("UPDATE native_pomodoro_session") { throw HostFailure("retain reset") } }
        let original = try request("reset"), before = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let pending = try Data(contentsOf: journal); await core.close()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        XCTAssertEqual(try Data(contentsOf: journal), pending); XCTAssertEqual(try snapshot(), before); XCTAssertEqual(markers, 0)
        _ = try await host().start()
        XCTAssertEqual(try currentState()["generation"] as? Int, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActionDiagnosticProvesSQLOnlyIncludingReplayAndLoggerFailureCannotRevokeResult() async throws {
        try await seed(running: false); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        // Enable the real shared diagnostics sink; an arbitrary bridge log is
        // not the proof. No request or raw provider error belongs in the line.
        _ = try await core.call("dataSetting", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true]])]))
        var markers: [String] = []; faults.commandDiagnostic = { if $0.hasPrefix("pomodoroActionConfirmed:") { markers.append($0) } }
        await failure {
            _ = try await core.call("logLine", argumentsJSON: self.json(["Native Pomodoro control transition confirmed",
                self.json(["releaseCheck": "v1.3.5/ios-pomodoro-actions", "outcome": "confirmed", "action": "reset"])]))
        }
        XCTAssertTrue(markers.isEmpty, "Public diagnostics cannot forge the SQL proof")
        faults.journalRemove = { throw HostFailure("terminal cleanup") }
        let original = try request("reset"); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        XCTAssertEqual(markers, ["pomodoroActionConfirmed:reset"])
        _ = try await core.diagnosticsFileAction("logShare") // flush the shared serialized sink
        let log = NativeDiagnosticsLogFile(libraryRoot: root)
        let text = try log.perform("read", text: "")
        XCTAssertTrue(text.contains("v1.3.5/ios-pomodoro-actions")); XCTAssertTrue(text.contains("confirmed")); XCTAssertTrue(text.contains("reset"))
        let proofLines = text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-pomodoro-actions") }
        XCTAssertEqual(proofLines.count, 1)
        let line = try object(String(try XCTUnwrap(proofLines.first))), context = try XCTUnwrap(line["context"] as? [String: Any])
        XCTAssertEqual(try json(context), try json(["releaseCheck": "v1.3.5/ios-pomodoro-actions", "outcome": "confirmed", "action": "reset"]))
        XCTAssertFalse(text.contains("PRIVATE")); XCTAssertFalse(String(try XCTUnwrap(proofLines.first)).contains(try XCTUnwrap(object(original)["requestId"] as? String)))
        let after = try snapshot(); faults.journalRemove = nil
        // A directory at the native log file path makes the actual append
        // refuse; no App or fake acknowledgement replaces the storage proof.
        try FileManager.default.moveItem(at: log.mainURL, to: root.appendingPathComponent("saved-proof.log"))
        try FileManager.default.createDirectory(at: log.mainURL, withIntermediateDirectories: false)
        let retry = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(retry["kind"] as? String, "confirmed"); XCTAssertEqual(try snapshot(), after)
        XCTAssertEqual(markers, ["pomodoroActionConfirmed:reset", "pomodoroActionConfirmed:reset"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
