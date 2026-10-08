import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ReminderCompletionIO: @unchecked Sendable {
    private let lock = NSLock()
    private var commitFailure = false, removeFailure = false
    private var failJournalAt: Int?
    private var writes = 0, commitsRefused = 0, journals = 0
    private var writesWithoutJournal = 0
    private var held: (XCTestExpectation, DispatchSemaphore)?
    private var closed = false
    var journal: URL?
    func failCommit(_ value: Bool) { lock.lock(); commitFailure = value; lock.unlock() }
    func failRemove(_ value: Bool) { lock.lock(); removeFailure = value; lock.unlock() }
    func failJournal(at value: Int?) { lock.lock(); failJournalAt = value; lock.unlock() }
    func holdWrite(_ entered: XCTestExpectation, release: DispatchSemaphore) { lock.lock(); held = (entered, release); lock.unlock() }
    func reset() { lock.lock(); writes = 0; commitsRefused = 0; journals = 0; writesWithoutJournal = 0; lock.unlock() }
    func beforeSQL(_ text: String) throws {
        let verb = text.split(whereSeparator: { $0.isWhitespace }).first?.uppercased() ?? ""
        let mutation = ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK", "VACUUM"].contains(verb)
        lock.lock()
        if mutation { writes += 1; if let journal, !FileManager.default.fileExists(atPath: journal.path) { writesWithoutJournal += 1 } }
        let pause = mutation ? held : nil
        if pause != nil { held = nil }
        let refusal = text == "COMMIT" && commitFailure
        if refusal { commitsRefused += 1 }
        lock.unlock()
        if let pause {
            pause.0.fulfill()
            guard pause.1.wait(timeout: .now() + 5) == .success else { throw HostFailure("PRIVATE_COMPLETE_HOLD_EXPIRED") }
        }
        if refusal { throw HostFailure("PRIVATE_COMPLETE_COMMIT_REFUSAL") }
    }
    func beforeJournal() throws {
        lock.lock(); journals += 1; let refusal = failJournalAt == journals; lock.unlock()
        if refusal { throw HostFailure("PRIVATE_COMPLETE_JOURNAL_REFUSAL") }
    }
    func beforeRemove() throws {
        lock.lock(); let refusal = removeFailure; lock.unlock()
        if refusal { throw HostFailure("PRIVATE_COMPLETE_CLEAR_REFUSAL") }
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [writes, journals, commitsRefused, writesWithoutJournal] }
    func didClose() { lock.lock(); closed = true; lock.unlock() }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
}
private final class ReminderCompletionNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Reminder Complete must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

final class ReminderCompletionHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.example.mindwtr.reminder-completion"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Reminder Complete fixture bundle unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderCompletionHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Reminder Complete fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown-complete-preference": "PRIVATE_PREFERENCE 文",
            "mindwtr:local:alarms:v1": "{}", "mindwtr:native:reminders:v1": "{}"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func host(_ io: ReminderCompletionIO = ReminderCompletionIO(), coreBundle: URL? = nil) -> CoreHost {
        let faults = HostIOFaults(); io.journal = journal
        faults.notificationAuthorizationRequest = { XCTFail("Reminder Complete must not request permission") }
        faults.notificationPermissionRead = { XCTFail("Reminder Complete must not inspect permission"); return .init(status: "denied", granted: false, canAskAgain: false) }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { try io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReminderCompletionNoHTTP.self]; faults.httpConfiguration = config
        faults.secretBeforeOperation = { _, _ in XCTFail("Reminder Complete must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }; faults.cryptoBeforeOperation = { _ in XCTFail("Reminder Complete must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: coreBundle ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func request(taskID: String = "complete-task", id: String = UUID().uuidString.lowercased()) throws -> String {
        try json(["requestId": id, "taskId": taskID])
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func rows() throws -> [String: String] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func seed(status: String = "next", recurring: Bool = false, taskID: String = "complete-task") async throws -> CoreHost {
        let initial = host(); _ = try await initial.start(); await initial.close()
        let at = "2026-10-08T10:00:00.000Z"
        let recurrence = recurring ? try json(["rule": "daily", "strategy": "strict", "seriesId": taskID]) : nil
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,dueDate,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders,recurrence) VALUES (?,?,?,'[]','[]',?,?,?,3,'fixture',1,0,0,0,?)",
            [taskID, "PRIVATE_COMPLETE_TASK", status, "2026-10-09T10:00:00.000Z", at, at, recurrence.map { $0 as Any } ?? NSNull()])
        let value = host(); _ = try await value.start(); return value
    }
    private func taskRows() throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT id,status,title,rev,isFocusedToday,recurrence FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
    }
    private func receiptRows() throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS evidence_rowid,request_id,method,reply,saved_at FROM native_request_receipts ORDER BY request_id").utf8)) as? [[String: Any]])
    }
    private func markers() throws -> [[String: Any]] {
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(text.contains("PRIVATE_")); XCTAssertFalse(text.contains(namespace)); XCTAssertFalse(text.contains("complete-task"))
        return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-complete") }.map {
            let entry = try object(String($0))
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-reminder-complete", "outcome": "confirmed"])
            return entry
        }
    }
    private func rejected(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected definite Complete refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected error: \(type(of: error))") }
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained Complete uncertainty") }
        catch { XCTAssertTrue(error is HostFailure, "Unexpected error: \(type(of: error))") }
    }

    func testTypedBoundaryAndAllPrivateSelectorsRejectWithoutWriting() async throws {
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let before = try rows(), local = try Data(contentsOf: manifest), id = UUID().uuidString.lowercased()
        let malformed = ["[]", "{}", try json(["requestId": id.uppercased(), "taskId": "t"]),
            try json(["requestId": id, "taskId": ""]), try json(["requestId": id, "taskId": String(repeating: "🧭", count: 251)]),
            try json(["requestId": id, "taskId": "t", "extra": true]),
            "{\"requestId\":\"\(id)\",\"taskId\":\"t\",\"taskId\":\"other\"}",
            String(repeating: " ", count: 4097) + "{}"]
        for raw in malformed {
            await rejected { try await core.completeReminderTask(requestJSON: raw) }
            await rejected { try await core.probeReminderCompletionOutcome(requestJSON: raw) }
        }
        for method in ["reminderCompletionCommit", "reminderCompletionProbe", "reminderCompletionRetry", "reminderCompletionAcknowledged"] {
            await rejected { try await core.call(method, argumentsJSON: json([try request()])) }
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), local)
        XCTAssertEqual(io.counts, [0, 0, 0, 0]); XCTAssertEqual(try markers().count, 0)
    }
    func testExactCompletionJournalsBeforeSQLAndRecurringTaskAppliesOnce() async throws {
        let initial = try await seed(recurring: true); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), local = try Data(contentsOf: manifest)
        let result = try object(await core.completeReminderTask(requestJSON: raw))
        XCTAssertEqual(try json(result), try json(["changed": true, "outcome": "completed"]))
        XCTAssertGreaterThan(io.counts[0], 0); XCTAssertEqual(io.counts[1], 2); XCTAssertEqual(io.counts[3], 0)
        let tasks = try taskRows(); XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(tasks.filter { $0["status"] as? String == "next" }.count, 1)
        XCTAssertEqual(tasks.first { $0["id"] as? String == "complete-task" }?["isFocusedToday"] as? Int, 0)
        let baseline = try rows(), receipts = try receiptRows(); XCTAssertEqual(receipts.count, 1)
        XCTAssertEqual(receipts.first?["request_id"] as? String, try object(raw)["requestId"] as? String)
        XCTAssertTrue((receipts.first?["method"] as? String)?.hasPrefix("reminderComplete:") == true)
        let replay = try object(await core.completeReminderTask(requestJSON: raw)), probe = try object(await core.probeReminderCompletionOutcome(requestJSON: raw))
        XCTAssertEqual(try json(replay), try json(result)); XCTAssertEqual(try json(probe), try json(result))
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), local)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 1)
    }
    func testWarmFailedCommitRetryKeepsExactRequestAndOneRecurringChild() async throws {
        let initial = try await seed(recurring: true); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), before = try rows(); io.failCommit(true)
        await uncertain { try await core.completeReminderTask(requestJSON: raw) }
        XCTAssertGreaterThan(io.counts[2], 0); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 0)
        let frozen = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        XCTAssertEqual(frozen["method"] as? String, "reminderCompletionCommit")
        XCTAssertEqual(frozen["argumentsJSON"] as? String, try json([raw])); io.failCommit(false)
        let returned = try await core.retryPending(), result = try object(XCTUnwrap(returned))
        XCTAssertEqual(result["changed"] as? Bool, true); XCTAssertEqual(try taskRows().count, 2)
        let beforeReplay = try rows(); _ = try await core.completeReminderTask(requestJSON: raw)
        XCTAssertEqual(try rows(), beforeReplay); XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 1)
    }
    func testUncertainInitialJournalUnknownWarmRetryClearsAndReleasesDispatcher() async throws {
        try await assertUnknownWarmRetryClearsAndReleasesDispatcher(useFacade: false)
    }
    func testUncertainInitialJournalUnknownSameRequestFacadeClearsAndReleasesDispatcher() async throws {
        try await assertUnknownWarmRetryClearsAndReleasesDispatcher(useFacade: true)
    }
    private func assertUnknownWarmRetryClearsAndReleasesDispatcher(useFacade: Bool) async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), before = try rows(); io.failJournal(at: 1)
        await uncertain { try await core.completeReminderTask(requestJSON: raw) }
        XCTAssertEqual(io.counts, [0, 1, 0, 0]); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try receiptRows().count, 0)
        io.failJournal(at: nil)
        await rejected {
            if useFacade { return try await core.completeReminderTask(requestJSON: raw) }
            return try await core.retryPending() ?? "null"
        }
        XCTAssertEqual(io.counts, [0, 3, 0, 0])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try receiptRows().count, 0)
        XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await rejected { try await core.probeReminderCompletionOutcome(requestJSON: raw) }
        let fresh = try request()
        do {
            let result = try object(await core.completeReminderTask(requestJSON: fresh))
            XCTAssertEqual(try json(result), try json(["changed": true, "outcome": "completed"]))
            XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 1)
            XCTAssertEqual(try receiptRows().first?["request_id"] as? String, try object(fresh)["requestId"] as? String)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        } catch { XCTFail("Definite unknown refusal must release dispatcher: \(type(of: error))") }
    }
    func testTerminalPromotionFailureRecoversOnlyExactCommittedReceipt() async throws {
        let initial = try await seed(recurring: true); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(); io.failJournal(at: 2)
        await uncertain { try await core.completeReminderTask(requestJSON: raw) }
        XCTAssertEqual(io.counts[1], 2); XCTAssertEqual(try taskRows().count, 2); XCTAssertEqual(try receiptRows().count, 1)
        XCTAssertEqual(try markers().count, 0); let before = try rows()
        io.failJournal(at: nil); let returned = try await core.retryPending(), reply = try object(XCTUnwrap(returned))
        XCTAssertEqual(reply["outcome"] as? String, "completed"); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 1)
    }
    func testColdCommittedLostClearReturnsOriginalOnceAndPreservesLaterReopen() async throws {
        let initial = try await seed(recurring: true); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start()
        let raw = try request(); io.failRemove(true)
        await uncertain { try await core.completeReminderTask(requestJSON: raw) }
        let frozen = try Data(contentsOf: journal), original = ["changed": true, "outcome": "completed"] as [String: Any]
        XCTAssertEqual(try markers().count, 0); await core.close()
        _ = try sql("UPDATE tasks SET status='next',title='PRIVATE_LATER_TITLE',rev=rev+1,isFocusedToday=1 WHERE id='complete-task'")
        let before = try rows(); try frozen.write(to: journal)
        let cold = host(), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(try json(recovery), try json(["method": "reminderCompletionCommit", "result": original]))
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 1)
        let again = try object(await cold.start()); XCTAssertNil(again["recovery"])
        let replay = try object(await cold.completeReminderTask(requestJSON: raw)); XCTAssertEqual(try json(replay), try json(original))
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testColdReceiptlessRefusesWithoutCompletingCurrentTask() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start()
        let raw = try request(); io.failCommit(true); await uncertain { try await core.completeReminderTask(requestJSON: raw) }
        XCTAssertGreaterThan(io.counts[2], 0); await core.close()
        _ = try sql("UPDATE tasks SET title='PRIVATE_CHANGED_AFTER_INTENT',rev=rev+1 WHERE id='complete-task'")
        let before = try rows(), cold = host(), startup = try object(await cold.start())
        XCTAssertNil(startup["recovery"]); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await rejected { try await cold.probeReminderCompletionOutcome(requestJSON: raw) }
        XCTAssertEqual(try rows(), before)
    }
    func testAllNoopReceiptsSurviveLaterTaskBecomingActionable() async throws {
        let initial = try await seed(); await initial.close()
        for (status, deleted, outcome) in [("reference", false, "not-actionable"), ("next", true, "task-deleted"), ("missing", false, "task-not-found")] {
            if status == "missing" { _ = try sql("DELETE FROM tasks WHERE id='complete-task'") }
            else { _ = try sql("UPDATE tasks SET status=?,deletedAt=? WHERE id='complete-task'", [status, deleted ? "2026-10-08T10:00:00.000Z" as Any : NSNull()]) }
            let core = host(); _ = try await core.start(); let raw = try request()
            let result = try object(await core.completeReminderTask(requestJSON: raw))
            XCTAssertEqual(try json(result), try json(["changed": false, "outcome": outcome])); await core.close()
            if status == "missing" {
                _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('complete-task','PRIVATE_RECREATED','next','[]','[]','2026-10-08T10:00:00.000Z','2026-10-08T10:00:00.000Z',9,'fixture',1,0,0,0)")
            } else { _ = try sql("UPDATE tasks SET status='next',deletedAt=NULL,rev=rev+1 WHERE id='complete-task'") }
            let before = try rows(), cold = host(); _ = try await cold.start()
            let replay = try object(await cold.completeReminderTask(requestJSON: raw))
            XCTAssertEqual(try json(replay), try json(result)); XCTAssertEqual(try rows(), before); await cold.close()
        }
        XCTAssertEqual(try receiptRows().count, 3); XCTAssertEqual(try markers().count, 3)
    }
    func testUnknownProbeAndSavedUUIDCollisionNeverWriteOrJournal() async throws {
        let core = try await seed(), raw = try request(); _ = try await core.completeReminderTask(requestJSON: raw)
        let before = try rows(), collision = try request(taskID: "other-task", id: try XCTUnwrap(object(raw)["requestId"] as? String))
        await rejected { try await core.completeReminderTask(requestJSON: collision) }
        await rejected { try await core.probeReminderCompletionOutcome(requestJSON: collision) }
        await rejected { try await core.probeReminderCompletionOutcome(requestJSON: request(taskID: "unknown")) }
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 1)
    }
    func testExactUTF16TaskIDBoundaryPreservesWhitespaceAndUnicode() async throws {
        let id = " " + String(repeating: "🧭", count: 249) + " "
        XCTAssertEqual(id.utf16.count, 500)
        let core = try await seed(taskID: id), raw = try request(taskID: id)
        let result = try object(await core.completeReminderTask(requestJSON: raw)); XCTAssertEqual(result["changed"] as? Bool, true)
        let task = try XCTUnwrap(taskRows().first); XCTAssertEqual(task["id"] as? String, id); XCTAssertEqual(task["status"] as? String, "done")
    }
    func testMalformedTerminalRefusesBeforeSQLiteAndKeepsJournal() async throws {
        let core = try await seed(); await core.close()
        let raw = try request(), malformed = ["changed": false, "outcome": "completed"] as [String: Any]
        let bytes = Data(try json(["version": 2, "method": "reminderCompletionCommit", "argumentsJSON": json([raw]),
            "terminal": ["success": ["_0": json(malformed)]]]).utf8)
        try bytes.write(to: journal); let before = try rows(), io = ReminderCompletionIO(), cold = host(io)
        await uncertain { try await cold.start() }
        XCTAssertEqual(io.counts, [0, 0, 0, 0]); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: journal), bytes)
        XCTAssertEqual(try markers().count, 0)
    }
    func testMalformedSavedReceiptCannotAcknowledgeOrFallThroughToWriter() async throws {
        let io = ReminderCompletionIO(), initial = try await seed(); await initial.close()
        let core = host(io); _ = try await core.start(); let raw = try request(); io.failRemove(true)
        await uncertain { try await core.completeReminderTask(requestJSON: raw) }; await core.close()
        _ = try sql("UPDATE tasks SET status='next',rev=rev+1 WHERE id='complete-task'")
        _ = try sql("UPDATE native_request_receipts SET reply=?", [json(["changed": true, "outcome": "not-actionable"])])
        let before = try rows(), frozen = try Data(contentsOf: journal), cold = host()
        await uncertain { try await cold.start() }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try markers().count, 0)
    }
    func testAcceptedEngineWriteSurvivesCancellationAndCloseDrainsIt() async throws {
        let initial = try await seed(recurring: true); await initial.close()
        let io = ReminderCompletionIO(), core = host(io); _ = try await core.start(); io.reset()
        let entered = expectation(description: "Journaled Complete reaches SQL"), release = DispatchSemaphore(value: 0)
        io.holdWrite(entered, release: release)
        let raw = try request(), completing = Task { try await core.completeReminderTask(requestJSON: raw) }
        await fulfillment(of: [entered], timeout: 3); completing.cancel()
        let closing = Task { await core.close(); io.didClose() }; for _ in 0..<30 { await Task.yield() }
        XCTAssertFalse(io.isClosed); XCTAssertEqual(try markers().count, 0)
        release.signal(); let result = try object(await completing.value); await closing.value
        XCTAssertEqual(result["outcome"] as? String, "completed"); XCTAssertTrue(io.isClosed)
        XCTAssertEqual(try taskRows().count, 2); XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
