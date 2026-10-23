import CryptoKit
import Foundation
import XCTest
@testable import MindwtrNativeCore

/// Actual private JSC bundle, canonical KV, journal and SQLite adoption.
/// Existing optional KV constructor reads are allowed before pure validation;
/// the fixed DEBUG seam counts only legacy source multiGet, never boot or SQL.
final class NativePomodoroLegacyAdoptionTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "NativeUITests.pomodoro-adoption"
    private let names = ["@mindwtr_pomodoro_state", "@mindwtr_pomodoro_collapsed"]
    private let observed: Int64 = 1_791_590_400_000
    private let at = "2026-10-10T00:00:00.000Z"
    private let device = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container") }
    private var directory: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1") }
    private var manifest: URL { directory.appendingPathComponent("manifest.json") }

    override func setUpWithError() throws {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], "Actual Task541 bundle required")
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/adoption-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults(), storage: Bool = true) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: storage ? (containerURL: container, bundleIdentifier: namespace) : nil)
        addTeardownBlock { await value.close() }; return value
    }
    private var captureOptions: [String: Any] {
        ["note": "", "dueDate": NSNull(), "dueDateHasTime": false, "startTime": NSNull(),
         "contexts": [String](), "projectId": NSNull(), "areaId": NSNull(), "priority": NSNull(),
         "focus": false, "addAnother": false]
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    @discardableResult private func rows(_ sql: String, _ arguments: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(arguments)).utf8)) as? [[String: Any]])
    }
    private func snapshot() throws -> String {
        var result: [String: Any] = [:]
        for table in ["tasks", "projects", "settings", "native_pomodoro_session", "native_request_receipts"] {
            result[table] = try rows("SELECT * FROM " + table + " ORDER BY rowid")
        }
        return try json(result)
    }
    private func sourceBytes() throws -> [String: Data] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [:] }
        var result: [String: Data] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            result[name] = try Data(contentsOf: directory.appendingPathComponent(name))
        }
        return result
    }
    private func source(_ raw: String?, collapsed: String? = "true", external: Bool = false, bom: Bool = false) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values: [String: Any] = ["unknown": "KEEP", "mindwtr-data": "unrelated"]
        if let raw {
            if external {
                values[names[0]] = NSNull()
                let name = Insecure.MD5.hash(data: Data(names[0].utf8)).map { String(format: "%02x", $0) }.joined()
                try Data(((bom ? "\u{FEFF}" : "") + raw).utf8).write(to: directory.appendingPathComponent(name))
            } else { values[names[0]] = raw }
        }
        if let collapsed { values[names[1]] = collapsed }
        try Data(json(values).utf8).write(to: manifest)
    }
    private func legacy(running: Bool = true) throws -> String {
        var value: [String: Any] = ["durations": ["focusMinutes": 50, "breakMinutes": 10],
            "timerState": ["phase": "focus", "remainingSeconds": 1, "isRunning": running, "completedFocusSessions": 3],
            "sessionHistory": ["totalCompletedFocusSessions": 3, "completedFocusSessionsByTaskId": ["task": 3]],
            "selectedTaskId": "task", "updatedAtMs": observed - 1000]
        if running { value["phaseEndsAt"] = at }
        return try json(value)
    }
    private func request(_ id: String = UUID().uuidString.lowercased(), focus: Bool = false, breaks: Bool = false) throws -> String {
        try json(["action": "adoptLegacy", "requestId": id, "observedAtMs": observed, "localDayKey": "2026-10-10",
                  "autoStart": ["autoStartFocus": focus, "autoStartBreaks": breaks]])
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func domainWrite(_ sql: String) -> Bool {
        sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|native_pomodoro_session|native_request_receipts)\b"#, options: .regularExpression) != nil
    }
    private func seedTask() async throws {
        let core = host(); _ = try await core.start(); await core.close()
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["deviceId"] = device; try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        for (id, minutes) in [("task", 4), ("other", 7)] {
            try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,timeSpentMinutes,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'next',' [ ] ',NULL,?,?,1,?,?,0,0,0,0)",
                [id, "PRIVATE " + id, at, at, device, minutes])
        }
    }
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
    private func session() throws -> [String: Any] {
        try XCTUnwrap(object(XCTUnwrap(rows("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))["session"] as? [String: Any])
    }
    private func credit(_ amount: Int = 54) throws {
        XCTAssertEqual(try rows("SELECT timeSpentMinutes FROM tasks WHERE id='task'").first?["timeSpentMinutes"] as? Int, amount)
        XCTAssertEqual(try rows("SELECT timeSpentMinutes FROM tasks WHERE id='other'").first?["timeSpentMinutes"] as? Int, 7)
    }
    private func enterCase() throws -> URL {
        let previous = root!; root = previous.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true); return previous
    }
    private func capture(_ core: CoreHost) async throws {
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["text": "Later ordinary task", "options": captureOptions,
            "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])]))
    }

    func testBootDoesNotAdoptAndExplicitAbsenceUsesPausedDefaultsWithoutRNWrites() async throws {
        let faults = HostIOFaults(); var reads = 0, markers: [String] = []
        faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 }; if $0.hasPrefix("pomodoroAdoptionConfirmed:") { markers.append($0) } }
        let core = host(faults); _ = try await core.start()
        XCTAssertEqual(reads, 0); XCTAssertTrue(try rows("SELECT * FROM native_pomodoro_session").isEmpty)
        let before = try sourceBytes(), original = try request(), response = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(response["kind"] as? String, "confirmed"); XCTAssertEqual(reads, 2); XCTAssertEqual(markers, ["pomodoroAdoptionConfirmed:ready"])
        XCTAssertEqual(try sourceBytes(), before); XCTAssertEqual(try session()["updatedAtMs"] as? Int, 0)
        XCTAssertEqual((try session()["timerState"] as? [String: Any])?["isRunning"] as? Bool, false)
        let saved = try snapshot(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        XCTAssertEqual(try snapshot(), saved); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try await capture(core)
    }

    func testInlineExternalAndExternalBOMPreservePhysicalSourceAndExactLogicalReceipt() async throws {
        for mode in ["inline", "external", "bom"] {
            let previous = try enterCase(); try await seedTask(); let raw = "  " + (try legacy()) + "\n"
            try source(raw, collapsed: "TRUE", external: mode != "inline", bom: mode == "bom")
            let core = host(); _ = try await core.start(); let before = try sourceBytes(), original = try request()
            _ = try await core.writePomodoroTransition(requestJSON: original); try credit(); XCTAssertEqual(try sourceBytes(), before)
            let id = try XCTUnwrap(object(original)["requestId"] as? String)
            let payload = try XCTUnwrap(rows("SELECT method FROM native_request_receipts WHERE request_id=?", [id]).first?["method"] as? String)
            let pair = try XCTUnwrap(NativeJSON.jsonObject(with: Data(payload.utf8)) as? [Any]), plan = try XCTUnwrap(pair[1] as? [String: Any])
            let input = try XCTUnwrap(plan["request"] as? [String: Any]), frozen = try XCTUnwrap(input["legacy"] as? [String: Any])
            XCTAssertEqual((frozen["sessionRaw"] as? String).map { Data($0.utf8) }, Data(raw.utf8))
            XCTAssertEqual(frozen["collapsedRaw"] as? String, "TRUE"); XCTAssertEqual(frozen["namespace"] as? String, namespace)
            await core.close(); root = previous
        }
    }

    func testPresentEmptyMalformedUnknownDuplicateAndUnreadableSourceNeverDefaultOrPublish() async throws {
        for raw in ["", " ", "null", "[]", "{\"unknown\":1}", "{\"updatedAtMs\":1,\"updatedAtMs\":2}", "{\"timerState\":{\"isRunning\":1}}", "unreadable-manifest"] {
            let previous = try enterCase(); try await seedTask()
            try source(raw); if raw == "unreadable-manifest" { try Data("{broken".utf8).write(to: manifest) }
            let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let before = try snapshot(), kv = try sourceBytes(); var writes = 0, intents = 0
            faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }; faults.journalWrite = { intents += 1 }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
            XCTAssertEqual(writes, 0); XCTAssertEqual(intents, 0); XCTAssertEqual(try snapshot(), before); XCTAssertEqual(try sourceBytes(), kv)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close(); root = previous
        }
    }

    func testUnavailableCanonicalNamespaceAndConflictedDocumentsRefuseWithoutFallback() async throws {
        for mode in ["notOptedIn", "documentsConflict"] {
            let previous = try enterCase(); try await seedTask(); try source(legacy())
            if mode == "documentsConflict" {
                let copy = container.appendingPathComponent("Documents/RCTAsyncLocalStorage_V1")
                try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
                try Data("{\"@mindwtr_pomodoro_state\":\"foreign\"}".utf8).write(to: copy.appendingPathComponent("manifest.json"))
            }
            let core = host(storage: mode != "notOptedIn"); _ = try await core.start(); let before = try snapshot(), kv = try sourceBytes()
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
            XCTAssertEqual(try snapshot(), before); XCTAssertEqual(try sourceBytes(), kv); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await core.close(); root = previous
        }
    }

    func testHeldPendingKVPublicationRefusesFreshOwnerWithoutRepair() async throws {
        try await seedTask(); try source(legacy())
        let store = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace)
        defer { store.close() }
        store.faults.beforePromotion = { throw HostFailure("fixture promotion") }
        XCTAssertThrowsError(try store.set("@mindwtr_sync_backend", "cloud"))
        XCTAssertThrowsError(try store.multiGet(names))
        let before = try sourceBytes(), faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let domain = try snapshot()
        var reads = 0; faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(reads, 0); XCTAssertEqual(try sourceBytes(), before); XCTAssertEqual(try snapshot(), domain)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSameOwnedKVPendingRefusesLegacyReadWithoutRepair() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(); var owned: NativeDeviceKV?
        faults.configureDeviceStorage = { owned = $0 }
        let core = host(faults); _ = try await core.start(); let storage = try XCTUnwrap(owned)
        storage.faults.beforePromotion = { throw HostFailure("actual owned KV promotion") }
        XCTAssertThrowsError(try storage.set("@mindwtr_sync_backend", "cloud"))
        let before = try sourceBytes(), domain = try snapshot(); var sql = 0
        faults.beforeSQL = { _ in sql += 1 }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(sql, 0); XCTAssertEqual(try sourceBytes(), before); XCTAssertEqual(try snapshot(), domain)
        XCTAssertThrowsError(try storage.multiGet(names)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testUnavailableRuntimeAndUnrelatedPendingOwnerNeverReadLegacySource() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults)
        var reads = 0; faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        _ = try await core.start(); faults.journalWrite = { throw HostFailure("ordinary intent retained") }
        await failure { try await self.capture(core) }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(reads, 0); faults.journalWrite = nil; await core.close()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(reads, 0)
    }

    func testMissingLibraryOrMissingMismatchedJournalRefusesRecheckBeforeSourceRead() async throws {
        for mode in ["library", "replacedLibrary", "journal", "mismatchedJournal"] {
            let previous = try enterCase(); try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let original = try request(); var moved = false, reads = 0, sqlAfterLibraryChange = 0
            let libraryCase = ["library", "replacedLibrary"].contains(mode)
            let held = root.appendingPathComponent("held-binding"), target = libraryCase ? database : journal
            faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
            faults.journalWrite = {
                if libraryCase && !moved {
                    try FileManager.default.moveItem(at: target, to: held); moved = true
                    if mode == "replacedLibrary" { try FileManager.default.copyItem(at: held, to: target) }
                }
            }
            faults.beforeSQL = { sql in
                if moved && libraryCase { sqlAfterLibraryChange += 1 }
                if !libraryCase, !moved, FileManager.default.fileExists(atPath: self.journal.path),
                   sql.hasPrefix("SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id") {
                    try FileManager.default.moveItem(at: target, to: held); moved = true
                    if mode == "mismatchedJournal" { try Data("{}".utf8).write(to: target) }
                }
            }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertTrue(moved); XCTAssertEqual(reads, 1, "Only the initial capture may read: " + mode)
            XCTAssertEqual(sqlAfterLibraryChange, 0, "No SQL may use a replaced startup connection binding")
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.moveItem(at: held, to: target); faults.beforeSQL = nil
            XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); try credit(4)
            if libraryCase {
                // Moving an open SQLite file invalidates its vnode (SQLITE_IOERR_VNODE); revalidate on cold startup.
                await core.close()
                let reopened = host(), reply = try object(await reopened.start())
                XCTAssertEqual((reply["recovery"] as? [String: Any])?["method"] as? String, "pomodoroTransitionCommit")
                try credit(); await reopened.close()
            } else {
                _ = try await core.writePomodoroTransition(requestJSON: original)
                try credit(); await core.close()
            }
            root = previous
        }
    }

    func testNilStartupIdentityRefusesFreshAdoptionBeforeSourceOrSQL() async throws {
        try await seedTask(); try source(legacy())
        let alias = root.appendingPathComponent("same-library-hard-link")
        try FileManager.default.linkItem(at: database, to: alias)
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var reads = 0, sql = 0; faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        faults.beforeSQL = { _ in sql += 1 }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(reads, 0); XCTAssertEqual(sql, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); try FileManager.default.removeItem(at: alias)
    }

    func testValidForeignNamespaceColdPlanRefusesBeforeLegacySourceRead() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("retain adoption") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }; await core.close()
        var retained = try command(), plan = try object(planJSON()), input = try XCTUnwrap(plan["request"] as? [String: Any])
        var frozenLegacy = try XCTUnwrap(input["legacy"] as? [String: Any]); frozenLegacy["namespace"] = "NativeUITests.foreign"
        input["legacy"] = frozenLegacy; plan["request"] = input; retained["argumentsJSON"] = try json([json(plan)])
        let pending = Data(try json(retained).utf8); try pending.write(to: journal); let before = try snapshot()
        let cold = HostIOFaults(); var reads = 0, journalWrites = 0
        cold.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }; cold.journalWrite = { journalWrites += 1 }
        await failure { _ = try await self.host(cold).start() }
        XCTAssertEqual(reads, 0); XCTAssertEqual(journalWrites, 1); XCTAssertEqual(try snapshot(), before); try assertRetainedCommand(retained)
    }

    func testMalformedPublicIntentAndGenericBypassDoNoLegacyMultiGetOrDomainEntry() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var reads = 0, writes = 0, intents = 0
        faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }; faults.journalWrite = { intents += 1 }
        let before = try snapshot()
        for mode in ["source", "path", "stopped", "clock", "day", "options", "missing", "duplicate", "overflow"] {
            var value = try object(request())
            if mode == "source" { value["legacy"] = ["version": 1, "namespace": namespace, "sessionRaw": NSNull(), "collapsedRaw": NSNull()] }
            if mode == "path" { value["path"] = container.path }
            if mode == "stopped" { value["stoppedRN"] = true }
            if mode == "clock" { value["observedAtMs"] = true }
            if mode == "day" { value["localDayKey"] = "2026-02-31" }
            if mode == "options" { value["autoStart"] = ["autoStartFocus": 1, "autoStartBreaks": false] }
            if mode == "missing" { value.removeValue(forKey: "autoStart") }
            let raw = mode == "duplicate" ? try json(value).replacingOccurrences(of: "\"action\":", with: "\"action\":\"adoptLegacy\",\"action\":")
                : mode == "overflow" ? (try json(value)) + String(repeating: " ", count: 8193) : try json(value)
            await failure { _ = try await core.writePomodoroTransition(requestJSON: raw) }
        }
        for method in ["pomodoroTransitionWrite", "pomodoroTransitionPrepare", "pomodoroTransitionValidate", "pomodoroTransitionCommit", "pomodoroTransitionOutcome"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[]") }
        }
        XCTAssertEqual(reads, 0); XCTAssertEqual(writes, 0); XCTAssertEqual(intents, 0); XCTAssertEqual(try snapshot(), before)
    }

    func testRestoredRateHistoryClockAndAllAutoStartOptionsUseOriginalSelection() async throws {
        for focus in [false, true] { for breaks in [false, true] {
            let previous = try enterCase(); try await seedTask(); try source(legacy()); let core = host(); _ = try await core.start()
            let reply = try object(await core.writePomodoroTransition(requestJSON: request(focus: focus, breaks: breaks)))
            XCTAssertEqual((reply["result"] as? [String: Any])?["creditedMinutes"] as? Int, 50); try credit()
            let saved = try session(), timer = try XCTUnwrap(saved["timerState"] as? [String: Any])
            XCTAssertEqual(saved["updatedAtMs"] as? Int64, observed - 1000); XCTAssertEqual(timer["completedFocusSessions"] as? Int, 4)
            XCTAssertEqual(timer["phase"] as? String, "break"); XCTAssertEqual(timer["isRunning"] as? Bool, breaks)
            XCTAssertEqual(saved["phaseEndsAt"] as? String, breaks ? "2026-10-10T00:10:00.000Z" : nil)
            await core.close(); root = previous
        } }
    }

    func testExistingOrMissingAfterOldSuccessNativeSessionNeverReimports() async throws {
        for mode in ["valid", "malformed", "missing"] {
            let previous = try enterCase(); try await seedTask(); try source(legacy(running: false)); let core = host(); _ = try await core.start()
            _ = try await core.writePomodoroTransition(requestJSON: request()); await core.close()
            if mode == "malformed" { try rows("UPDATE native_pomodoro_session SET state_json='malformed'") }
            if mode == "missing" { try rows("DELETE FROM native_pomodoro_session") }
            let before = try snapshot(), next = host(); _ = try await next.start()
            await failure { _ = try await next.writePomodoroTransition(requestJSON: self.request()) }
            XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await next.close(); root = previous
        }
    }

    func testRetainedIntentMatchesOnlyOriginalCallerFieldsAndNeverRecapturesSource() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var reads = 0; faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        faults.journalWrite = { throw HostFailure("intent write") }; let original = try request(), before = try snapshot()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }; XCTAssertEqual(reads, 1)
        for field in ["requestId", "action", "observedAtMs", "localDayKey", "autoStart", "legacy"] {
            var changed = try object(original)
            if field == "requestId" { changed[field] = UUID().uuidString.lowercased() }
            if field == "action" { changed[field] = "reset" }
            if field == "observedAtMs" { changed[field] = observed + 1 }
            if field == "localDayKey" { changed[field] = "2026-10-11" }
            if field == "autoStart" { changed[field] = ["autoStartFocus": true, "autoStartBreaks": false] }
            if field == "legacy" { changed[field] = ["sessionRaw": "forged"] }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: self.json(changed)) }
        }
        XCTAssertEqual(reads, 1); XCTAssertEqual(try snapshot(), before); faults.journalWrite = nil
        _ = try await core.writePomodoroTransition(requestJSON: original); XCTAssertEqual(reads, 2); try credit()
    }

    func testChangedSourceAfterIntentRetainsOriginalWarmAndColdWithoutSQLApply() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var changed = false, writes = 0; let original = try request(), before = try snapshot()
        faults.journalWrite = { if !changed { changed = true; try self.source(self.legacy(running: false)) } }
        faults.beforeSQL = { if self.domainWrite($0) { writes += 1 } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        XCTAssertTrue(changed); XCTAssertEqual(writes, 0); XCTAssertEqual(try snapshot(), before)
        let saved = try command(), frozen = try planJSON(); await core.close()
        let replay = HostIOFaults(); var journalWrites = 0; replay.journalWrite = { journalWrites += 1 }
        let cold = host(replay); await failure { _ = try await cold.start() }
        XCTAssertEqual(journalWrites, 1); try assertRetainedCommand(saved); XCTAssertEqual(try planJSON(), frozen); XCTAssertEqual(try snapshot(), before)
    }

    func testActualSQLTaskSessionReceiptReadbackAndCommitCutsRollbackAndRetryOnce() async throws {
        for cut in ["UPDATE tasks", "INSERT INTO native_pomodoro_session", "INSERT INTO native_request_receipts", "SELECT id, state_json", "COMMIT"] {
            let previous = try enterCase(); try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            let original = try request(), before = try snapshot(); var entered = false, markers = 0
            faults.beforeSQL = { sql in
                if sql.hasPrefix("UPDATE tasks") { entered = true }
                if (cut != "SELECT id, state_json" || entered) && sql.hasPrefix(cut) { throw HostFailure("actual SQL cut") }
            }
            faults.commandDiagnostic = { if $0.hasPrefix("pomodoroAdoptionConfirmed:") { markers += 1 } }
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
            XCTAssertEqual(try snapshot(), before); XCTAssertEqual(markers, 0); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
            faults.beforeSQL = nil; _ = try await core.writePomodoroTransition(requestJSON: original); try credit(); XCTAssertEqual(markers, 1)
            XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1); await core.close(); root = previous
        }
    }

    func testFailedRollbackRetainsOwnerAcrossCloseAndNeverAcceptsANewUUID() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let original = try request()
        faults.beforeSQL = { if $0.hasPrefix("INSERT INTO native_request_receipts") || $0 == "ROLLBACK" { throw HostFailure("SQL uncertainty") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let bytes = try Data(contentsOf: journal); await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(try Data(contentsOf: journal), bytes); await core.close()
        _ = try await host().start(); try credit(); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostActualCommitReplyColdReceiptBypassesUnavailableLegacyAndPreservesLaterRows() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var entered = false, lost = false; faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { entered = true } }
        faults.afterSQL = { if entered && $0 == "COMMIT" && !lost { lost = true; throw HostFailure("lost actual COMMIT reply") } }
        let original = try request(); await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }
        let expected = try XCTUnwrap(object(planJSON())["result"]); try credit(); await core.close()
        try Data("{unavailable".utf8).write(to: manifest); try rows("UPDATE tasks SET title='LATER',timeSpentMinutes=99,rev=rev+1 WHERE id='task'")
        let before = try snapshot(), replay = HostIOFaults(); var reads = 0, mutations = 0
        replay.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }; replay.beforeSQL = { if self.domainWrite($0) { mutations += 1 } }
        let next = host(replay), startup = try object(await next.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "pomodoroTransitionCommit")
        XCTAssertEqual(try json(XCTUnwrap((startup["recovery"] as? [String: Any])?["result"])), try json(expected))
        XCTAssertEqual(reads, 0); XCTAssertEqual(mutations, 0); XCTAssertEqual(try snapshot(), before)
        let outcome = try object(await next.probePomodoroTransitionOutcome(requestJSON: original)); XCTAssertEqual(outcome["kind"] as? String, "confirmed")
    }

    func testTerminalReplayNeverRequiresSourceAndVanishedProofNeverFallsIntoFreshAdoption() async throws {
        for mode in ["unavailable", "missing", "betweenProbes"] {
            let previous = try enterCase(); try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
            faults.journalRemove = { throw HostFailure("terminal removal") }; let original = try request()
            await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }; let saved = try command(); await core.close()
            try Data("{unavailable".utf8).write(to: manifest); let id = try XCTUnwrap(object(original)["requestId"] as? String)
            if mode == "missing" { try rows("DELETE FROM native_request_receipts WHERE request_id=?", [id]); try rows("DELETE FROM native_pomodoro_session") }
            let replay = HostIOFaults(); var reads = 0, sqlReads = 0, mutations = 0, journalWrites = 0, vanished = false
            replay.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
            replay.journalWrite = { journalWrites += 1 }
            replay.beforeSQL = { sql in
                if sql.hasPrefix("SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id") { sqlReads += 1 }
                if mode == "betweenProbes" && sql == "BEGIN IMMEDIATE" && sqlReads > 0 && !vanished {
                    vanished = true; try self.rows("DELETE FROM native_request_receipts WHERE request_id=?", [id])
                }
                if self.domainWrite(sql) { mutations += 1 }
            }
            let next = host(replay)
            if mode == "unavailable" {
                _ = try await next.start(); XCTAssertEqual(journalWrites, 2); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            } else {
                await failure { _ = try await next.start() }; XCTAssertEqual(journalWrites, 1); try assertRetainedCommand(saved)
            }
            XCTAssertEqual(reads, 0); XCTAssertEqual(mutations, 0); if mode == "betweenProbes" { XCTAssertTrue(vanished) }
            await next.close(); root = previous
        }
    }

    func testProjectionFailureKeepsSQLProofAndExactRetryBypassesChangedSource() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var committed = false; faults.afterSQL = { if $0 == "COMMIT" { committed = true } }
        faults.beforeSQL = { if committed && $0.hasPrefix("SELECT rowid as _rowid, * FROM tasks") { throw HostFailure("projection unavailable") } }
        let original = try request(), response = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(response["kind"] as? String, "confirmed"); XCTAssertEqual(response["projectionReloaded"] as? Bool, false); try credit()
        XCTAssertNotNil(try command()["terminal"]); let literal = try planJSON(); await failure { try await self.capture(core) }
        try Data("{source now unavailable".utf8).write(to: manifest); var reads = 0
        faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }; faults.beforeSQL = nil
        let retry = try object(await core.writePomodoroTransition(requestJSON: original))
        XCTAssertEqual(reads, 0); XCTAssertEqual(retry["projectionReloaded"] as? Bool, true); try credit()
        XCTAssertEqual(try XCTUnwrap(object(literal)["result"]) as? NSDictionary, retry["result"] as? NSDictionary); try await capture(core)
    }

    func testColdMalformedAugmentedPlansRefuseBeforeSQLGCAndLegacyMultiGet() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0.hasPrefix("UPDATE tasks") { throw HostFailure("retain adoption") } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }; await core.close()
        let original = try command(), plan = try object(planJSON()), bytes = try Data(contentsOf: database), kv = try sourceBytes()
        let files = NativeBackupOperationFiles(libraryRoot: root), operation = try files.prepare(id: UUID().uuidString.lowercased(), planJSON: "{}",
            newSnapshot: (name: files.nextSnapshotName(at: Date()), content: "{}"), existingSnapshot: nil)
        let sentinel = root.appendingPathComponent("backup-operations/" + operation.id + "/plan.json"), sentinelBytes = try Data(contentsOf: sentinel)
        for mode in ["namespace", "sourceShape", "duplicate", "semantic", "credit", "terminal", "outer", "frame"] {
            var changed = original, prepared = plan, input = try XCTUnwrap(prepared["request"] as? [String: Any]), legacy = try XCTUnwrap(input["legacy"] as? [String: Any])
            if mode == "namespace" { legacy["namespace"] = "outside/container" }
            if mode == "sourceShape" { legacy["sessionRaw"] = false }
            if mode == "duplicate" { legacy["sessionRaw"] = "{\"updatedAtMs\":1,\"updatedAtMs\":2}" }
            if mode == "semantic" { legacy["sessionRaw"] = "{\"timerState\":{\"isRunning\":1}}" }
            if mode == "frame" { legacy["collapsedRaw"] = String(repeating: "x", count: 1_000_001) }
            input["legacy"] = legacy; prepared["request"] = input
            if mode == "credit" { var result = try XCTUnwrap(prepared["result"] as? [String: Any]); result["creditedMinutes"] = 100; prepared["result"] = result }
            if mode == "terminal" { changed["terminal"] = ["success": ["_0": "{}"]] }
            if mode == "outer" { changed["sourcePath"] = container.path }
            changed["argumentsJSON"] = try json([json(prepared)]); let pending = Data(try json(changed).utf8); try pending.write(to: journal)
            let cold = HostIOFaults(); var sql = 0, reads = 0; cold.beforeSQL = { _ in sql += 1 }
            cold.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
            await failure { _ = try await self.host(cold).start() }
            XCTAssertEqual(sql, 0, mode); XCTAssertEqual(reads, 0, "Constructor snapshot reads remain allowed: " + mode)
            XCTAssertEqual(try Data(contentsOf: database), bytes); XCTAssertEqual(try Data(contentsOf: journal), pending)
            XCTAssertEqual(try sourceBytes(), kv); XCTAssertEqual(try Data(contentsOf: sentinel), sentinelBytes)
        }
    }

    func testSavedEditorRefusesFreshAdoptionBeforeSourceReadAndPreservesDraft() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "task", generation: 1,
            payloadJSON: try json(["version": 2, "taskID": "task", "raw": ["title": "PRIVATE draft"]]))
        try await core.checkpointEditorDraft(checkpoint); let editor = EditorDraftStore(databaseURL: database), bytes = try Data(contentsOf: editor.url), before = try snapshot()
        var reads = 0; faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 } }
        await failure { _ = try await core.writePomodoroTransition(requestJSON: self.request()) }
        XCTAssertEqual(reads, 0); XCTAssertEqual(try snapshot(), before); XCTAssertEqual(try Data(contentsOf: editor.url), bytes)
    }

    func testOldControlsIgnoreLegacySourceAndHaveNoAdoptionMarker() async throws {
        try await seedTask(); try source("invalid legacy source"); let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); var reads = 0, markers = 0
        faults.commandDiagnostic = { if $0 == "pomodoroLegacyRead" { reads += 1 }; if $0.hasPrefix("pomodoroAdoptionConfirmed:") { markers += 1 } }
        let initial = try json(["action": "initialize", "requestId": UUID().uuidString.lowercased(), "observedAtMs": observed,
            "localDayKey": "2026-10-10", "durations": ["focusMinutes": 25, "breakMinutes": 5]])
        _ = try await core.writePomodoroTransition(requestJSON: initial)
        for action in ["toggle", "reset", "switchPhase", "setDurations", "selectTask", "reconcile"] {
            var value = try object(request()); value["action"] = action
            if action == "setDurations" { value["durations"] = ["focusMinutes": 50, "breakMinutes": 10] }
            if action == "selectTask" { value["taskId"] = NSNull() }
            _ = try await core.writePomodoroTransition(requestJSON: json(value))
        }
        XCTAssertEqual(reads, 0); XCTAssertEqual(markers, 0); try credit(4)
    }

    func testAdoptionDiagnosticIsSQLProofOnlyPrivateAndAppendFailureCannotChangeReceipt() async throws {
        try await seedTask(); try source(legacy()); let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        _ = try await core.call("dataSetting", argumentsJSON: json([json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true]])]))
        await failure { _ = try await core.call("logLine", argumentsJSON: self.json(["Native Pomodoro legacy adoption confirmed",
            self.json(["releaseCheck": "v1.3.5/ios-pomodoro-adoption", "outcome": "confirmed"])])) }
        faults.journalRemove = { throw HostFailure("terminal cleanup") }; let original = try request()
        await failure { _ = try await core.writePomodoroTransition(requestJSON: original) }; try credit()
        _ = try await core.diagnosticsFileAction("logShare"); let log = NativeDiagnosticsLogFile(libraryRoot: root), text = try log.perform("read", text: "")
        let lines = text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-pomodoro-adoption") }; XCTAssertEqual(lines.count, 1)
        let line = try object(String(try XCTUnwrap(lines.first))), context = try XCTUnwrap(line["context"] as? [String: Any])
        XCTAssertEqual(try json(context), try json(["releaseCheck": "v1.3.5/ios-pomodoro-adoption", "outcome": "confirmed"]))
        XCTAssertFalse(String(try XCTUnwrap(lines.first)).contains("PRIVATE")); XCTAssertFalse(String(try XCTUnwrap(lines.first)).contains(namespace))
        let saved = try snapshot(); try FileManager.default.moveItem(at: log.mainURL, to: root.appendingPathComponent("proof.log"))
        try FileManager.default.createDirectory(at: log.mainURL, withIntermediateDirectories: false); faults.journalRemove = nil
        let retry = try object(await core.writePomodoroTransition(requestJSON: original)); XCTAssertEqual(retry["kind"] as? String, "confirmed")
        XCTAssertEqual(try snapshot(), saved); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
