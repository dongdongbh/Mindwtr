import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ReminderSnoozeIO: @unchecked Sendable {
    private let lock = NSLock()
    private var commitFailure = false, removeFailure = false
    private var failJournalAt: Int?
    private var writes = 0, commitsRefused = 0, journals = 0
    private var writesWithoutJournal = 0
    private var held: (XCTestExpectation, DispatchSemaphore)?
    private var mapBeforeFailure = false, mapAfterFailure = false, granted = true
    private var promotions = 0, permissions = 0
    private var closed = false
    func mapFailure(before: Bool = false, after: Bool = false) { lock.lock(); mapBeforeFailure = before; mapAfterFailure = after; lock.unlock() }
    func beforeMap() throws { lock.lock(); promotions += 1; let fail = mapBeforeFailure; lock.unlock(); if fail { throw HostFailure("PRIVATE_SNOOZE_MAP_BEFORE") } }
    func afterMap() throws { lock.lock(); let fail = mapAfterFailure; lock.unlock(); if fail { throw HostFailure("PRIVATE_SNOOZE_MAP_AFTER") } }
    func grant(_ value: Bool) { lock.lock(); granted = value; lock.unlock() }
    func permission() -> NativeNotificationPermission { lock.lock(); defer { lock.unlock() }; permissions += 1; return .init(status: granted ? "authorized" : "denied", granted: granted, canAskAgain: false) }
    var mapCount: Int { lock.lock(); defer { lock.unlock() }; return promotions }
    var permissionCount: Int { lock.lock(); defer { lock.unlock() }; return permissions }
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
private final class ReminderSnoozeNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Reminder Snooze must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

private actor ReminderSnoozePort: NativeReminderPort {
    private var inventory: [NativeReminderObservation] = []
    private(set) var adds = 0, removals = 0
    func permission() async throws -> NativeNotificationPermission { .init(status: "authorized", granted: true, canAskAgain: false) }
    func pending(namespace: String) async throws -> [NativeReminderObservation] { inventory }
    func delivered(namespace: String) async throws -> [NativeReminderObservation] { [] }
    func add(_ alarm: NativeReminderEffects.Alarm, namespace: String) async throws {
        adds += 1
        let value = try XCTUnwrap(NativeJSON.jsonObject(with: Data(alarm.json.utf8)) as? [String: Any])
        inventory.append(.read(try NativeReminderRequest.make(alarm: value, namespace: namespace), namespace: namespace))
    }
    func removePending(_ identifiers: [String]) async throws { removals += 1; inventory.removeAll { identifiers.contains($0.identifier) } }
    func removeDelivered(_ identifiers: [String]) async throws { removals += 1 }
}
private final class ReminderSnoozeWakes: @unchecked Sendable {
    private let lock = NSLock(); private var values: [UInt64] = []
    func record(_ wake: NativeReminderWake) { lock.lock(); defer { lock.unlock() }; if case .sourceChanged(let revision) = wake { values.append(revision) } }
    var revisions: [UInt64] { lock.lock(); defer { lock.unlock() }; return values }
}

final class ReminderSnoozeHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let port = ReminderSnoozePort()
    private let namespace = "tech.example.mindwtr.reminder-snooze"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Reminder Snooze fixture bundle unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderSnoozeHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Reminder Snooze fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown-complete-preference": "PRIVATE_PREFERENCE 文",
            "mindwtr:local:alarms:v1": "{}", "mindwtr:native:reminders:v1": "{}"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func host(_ io: ReminderSnoozeIO = ReminderSnoozeIO(), coreBundle: URL? = nil) -> CoreHost {
        let faults = HostIOFaults(); io.journal = journal
        faults.notificationAuthorizationRequest = { XCTFail("Reminder Snooze must not request permission") }
        faults.notificationPermissionRead = { io.permission() }
        faults.reminderPort = port
        faults.configureDeviceStorage = { store in store.faults.beforePromotion = { try io.beforeMap() }; store.faults.afterPromotion = { try io.afterMap() } }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { try io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReminderSnoozeNoHTTP.self]; faults.httpConfiguration = config
        faults.secretBeforeOperation = { _, _ in XCTFail("Reminder Snooze must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }; faults.cryptoBeforeOperation = { _ in XCTFail("Reminder Snooze must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: coreBundle ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func request(id: String = UUID().uuidString.lowercased(), requestedAt: Double = floor(Date().timeIntervalSince1970 * 1000), title: String = "PRIVATE_SNOOZE_TITLE", interval: Double = 5) throws -> String {
        try json(["requestId": id, "requestedAt": requestedAt,
            "details": ["title": title, "message": "PRIVATE_SNOOZE_BODY", "tag": "task:complete-task", "play_sound": true,
                        "snooze_interval": interval, "data": ["alarmKey": "task:complete-task", "taskId": "complete-task"],
                        "custom": ["nested": [1, 2, 3], "text": "PRIVATE_PRESERVE 文"]] as [String: Any]])
    }
    private func saved() throws -> [String: String] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: String]) }
    private func maps() throws -> [String?] { let values = try saved(); return [values["mindwtr:local:alarms:v1"], values["mindwtr:native:reminders:v1"]] }
    private func changeState(_ change: (inout [String: Any]) throws -> Void) throws {
        var values = try saved(), state = try object(values["mindwtr:native:reminders:v1"] ?? "{}")
        try change(&state); values["mindwtr:native:reminders:v1"] = try json(state)
        try Data(json(values).utf8).write(to: manifest, options: .atomic)
    }
    private func entry(_ raw: String) throws -> [String: Any] {
        let key = "snooze:" + (try XCTUnwrap(object(raw)["requestId"] as? String))
        return try XCTUnwrap(object(try XCTUnwrap(maps()[1]))[key] as? [String: Any])
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
        let selected = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        var settings = try object(try XCTUnwrap(selected.first?["data"] as? String))
        settings["notificationsEnabled"] = false
        _ = try sql("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        let value = host(); _ = try await value.start(); return value
    }
    private func taskRows() throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT id,status,title,rev,isFocusedToday,recurrence FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
    }
    private func receiptRows() throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS evidence_rowid,request_id,method,reply,saved_at FROM native_request_receipts ORDER BY request_id").utf8)) as? [[String: Any]])
    }
    private func markers() throws -> [[String: Any]] {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return [] }
        let text = try String(contentsOf: log, encoding: .utf8)
        XCTAssertFalse(text.contains("PRIVATE_")); XCTAssertFalse(text.contains(namespace)); XCTAssertFalse(text.contains("complete-task"))
        return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-snooze") }.map {
            let entry = try object(String($0))
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-reminder-snooze", "outcome": "confirmed"])
            return entry
        }
    }
    private func rejected(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected definite Snooze refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected error: \(type(of: error)): \(error.localizedDescription)") }
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained Snooze uncertainty") }
        catch { XCTAssertTrue(error is HostFailure, "Unexpected error: \(type(of: error)): \(error.localizedDescription)") }
    }

    func testStrictBoundaryPrivateSelectorsAndFreshRefusalsWriteNothing() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let before = try rows(), original = try maps(), id = UUID().uuidString.lowercased()
        for raw in ["[]", "{}", try request(id: id.uppercased()), try request(interval: 0), String(repeating: " ", count: 65_537) + "{}"] {
            await rejected { try await core.snoozeReminder(requestJSON: raw) }
        }
        for name in ["reminderSnoozePrepare", "reminderSnoozeValidate", "reminderSnoozeCommit", "reminderSnoozeProbe", "reminderSnoozeRetry", "reminderSnoozeAcknowledged"] {
            await rejected { try await core.call(name, argumentsJSON: "[]") }
        }
        io.grant(false); await rejected { try await core.snoozeReminder(requestJSON: request()) }
        io.grant(true); await rejected { try await core.snoozeReminder(requestJSON: request(requestedAt: floor(Date().timeIntervalSince1970 * 1000) - 90_000_000)) }
        XCTAssertEqual(io.counts, [0, 0, 0, 0]); XCTAssertEqual(io.mapCount, 0)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try maps(), original); XCTAssertEqual(try markers().count, 0)
        let adds = await port.adds; XCTAssertEqual(adds, 0)
    }
    func testNestedDetailsAndRepeatedSiblingNamesAcceptAndPreserveExactPublication() async throws {
        let core = try await seed()
        var input = try object(request()), details = try XCTUnwrap(input["details"] as? [String: Any])
        let nested: [String: Any] = ["requestId": "PRIVATE_NESTED_ID", "title": "PRIVATE_NESTED_TITLE",
            "children": [["same": 1], ["same": 2]], "quoted": "PRIVATE_\\\"{\\\"same\\\":3}\\\""]
        details["custom"] = nested; input["details"] = details
        let raw = try json(input), result = try object(await core.snoozeReminder(requestJSON: raw))
        var expected = details; expected["schedule_type"] = "once"
        XCTAssertEqual(try json(XCTUnwrap(result["details"] as? [String: Any])), try json(expected))
        XCTAssertEqual(try json(XCTUnwrap(entry(raw)["details"] as? [String: Any])), try json(expected))
        XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let replay = try object(await core.snoozeReminder(requestJSON: raw))
        XCTAssertEqual(try json(replay), try json(result)); XCTAssertEqual(try markers().count, 1)
        let adds = await port.adds; XCTAssertEqual(adds, 0)
    }
    func testDuplicateRootAndNestedMembersIncludingEscapedNamesRefuseBeforeJournal() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let id = UUID().uuidString.lowercased(), raw = try request(id: id), baseline = try rows(), before = try maps()
        let duplicates = [
            raw.replacingOccurrences(of: "\"requestId\":", with: "\"requestId\":\"\(id)\",\"requestId\":"),
            raw.replacingOccurrences(of: "\"requestId\":", with: "\"\\u0072equestId\":\"\(id)\",\"requestId\":"),
            raw.replacingOccurrences(of: "\"title\":", with: "\"title\":\"PRIVATE_DUPLICATE\",\"title\":"),
            raw.replacingOccurrences(of: "\"title\":", with: "\"\\u0074itle\":\"PRIVATE_DUPLICATE\",\"title\":"),
            raw.replacingOccurrences(of: "\"alarmKey\":", with: "\"alarmKey\":\"task:complete-task\",\"alarmKey\":"),
            raw.replacingOccurrences(of: "\"text\":", with: "\"\\u0074ext\":\"PRIVATE_DUPLICATE\",\"text\":"),
            raw.replacingOccurrences(of: "\"nested\":[1,2,3]", with: "\"nested\":[{\"same\":1,\"\\u0073ame\":2}]")
        ]
        for duplicate in duplicates {
            XCTAssertNotEqual(duplicate, raw)
            await rejected { try await core.snoozeReminder(requestJSON: duplicate) }
        }
        XCTAssertEqual(io.counts, [0, 0, 0, 0]); XCTAssertEqual(io.mapCount, 0)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try maps(), before)
        XCTAssertEqual(try receiptRows().count, 0); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let adds = await port.adds; XCTAssertEqual(adds, 0)
    }
    func testExactPublicationJournalsBeforeReceiptPreservesDisjointMapsAndSchedulesOnlyLater() async throws {
        let initial = try await seed(); await initial.close()
        var values = try saved(); values["mindwtr:local:alarms:v1"] = "  {} \n"
        let other = "snooze:22222222-2222-4222-8222-222222222222"
        let raw = try request(), input = try object(raw), details = try XCTUnwrap(input["details"] as? [String: Any])
        let past = floor(Date().timeIntervalSince1970 * 1000) - 60_000
        values["mindwtr:native:reminders:v1"] = try json([other: ["kind": "snooze", "id": 1_073_741_825, "fireAtMs": past, "details": details, "armed": true]])
        try Data(json(values).utf8).write(to: manifest, options: .atomic)
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let tasks = try taskRows(), result = try object(await core.snoozeReminder(requestJSON: raw))
        XCTAssertEqual(result["key"] as? String, "snooze:" + (try XCTUnwrap(input["requestId"] as? String)))
        XCTAssertEqual(try entry(raw)["armed"] as? Bool, false); XCTAssertEqual(try maps()[0], values["mindwtr:local:alarms:v1"])
        XCTAssertEqual(try json(XCTUnwrap(object(try XCTUnwrap(maps()[1]))[other])), try json(XCTUnwrap(object(try XCTUnwrap(values["mindwtr:native:reminders:v1"]))[other])))
        XCTAssertEqual(try json(taskRows()), try json(tasks)); XCTAssertEqual(io.counts[1], 2); XCTAssertEqual(io.counts[3], 0)
        XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try markers().count, 1)
        let before = try rows(), mapsBefore = try maps(), permissions = io.permissionCount
        io.grant(false); let replay = try object(await core.snoozeReminder(requestJSON: raw))
        XCTAssertEqual(try json(replay), try json(result)); XCTAssertEqual(try rows(), before); XCTAssertEqual(try maps(), mapsBefore)
        XCTAssertEqual(io.permissionCount, permissions); XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try markers().count, 1)
        let adds = await port.adds; XCTAssertEqual(adds, 0)
        _ = try await core.reconcileReminders(); let scheduled = await port.adds; XCTAssertEqual(scheduled, 1)
        XCTAssertEqual(try entry(raw)["armed"] as? Bool, true)
        _ = try await core.snoozeReminder(requestJSON: raw); XCTAssertEqual(try entry(raw)["armed"] as? Bool, true)
        XCTAssertEqual(try markers().count, 1)
    }
    func testWarmFailedReceiptSaveRetriesOnlyOriginalAlarm() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), before = try maps(); io.failCommit(true)
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertGreaterThan(io.counts[2], 0); XCTAssertEqual(try maps(), before); XCTAssertEqual(io.mapCount, 0); XCTAssertEqual(try markers().count, 0)
        io.failCommit(false); let returned = try await core.retryPending(), result = try object(XCTUnwrap(returned))
        XCTAssertEqual(result["key"] as? String, "snooze:" + (try XCTUnwrap(object(raw)["requestId"] as? String)))
        XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try markers().count, 1)
    }
    func testUnknownWarmInitialJournalRefusesClearsAndAllowsFreshUUID() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), before = try maps(); io.failJournal(at: 1)
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertEqual(io.counts[0], 0); io.failJournal(at: nil)
        await rejected { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertEqual(try maps(), before); XCTAssertEqual(try receiptRows().count, 0); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.snoozeReminder(requestJSON: request()); XCTAssertEqual(try receiptRows().count, 1)
    }
    func testWarmBeforeMapAndLostMapAcknowledgmentKeepExactMutation() async throws {
        try await recoverWarmMapFailure(after: false)
    }
    func testWarmAfterMapLostAcknowledgmentKeepsExactMutation() async throws {
        try await recoverWarmMapFailure(after: true)
    }
    private func recoverWarmMapFailure(after: Bool) async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let raw = try request(), before = try maps(); io.mapFailure(before: !after, after: after)
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 0)
        if after { XCTAssertEqual(try entry(raw)["armed"] as? Bool, false) } else { XCTAssertEqual(try maps(), before) }
        await uncertain { try await core.snoozeReminder(requestJSON: request()) }
        io.mapFailure(); _ = try await core.snoozeReminder(requestJSON: raw)
        XCTAssertEqual(io.mapCount, after ? 1 : 2); XCTAssertEqual(try receiptRows().count, 1); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); let adds = await port.adds; XCTAssertEqual(adds, 0)
    }
    func testColdBeforeMapPublishesFrozenIntentAndPreservesLaterPrivatePreference() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); let raw = try request()
        io.mapFailure(before: true); await uncertain { try await core.snoozeReminder(requestJSON: raw) }; await core.close()
        var values = try saved(); values["unknown-complete-preference"] = "PRIVATE_LATER_PREF"; try Data(json(values).utf8).write(to: manifest, options: .atomic)
        let cold = host(), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "reminderSnoozeCommit"); XCTAssertEqual(try entry(raw)["armed"] as? Bool, false)
        XCTAssertEqual(try saved()["unknown-complete-preference"], "PRIVATE_LATER_PREF"); XCTAssertEqual(try markers().count, 1)
        let again = try object(await cold.start()); XCTAssertNil(again["recovery"])
    }
    func testColdAfterMapForcedConfirmationLostAckRetriesStartupWithoutRecreatingSnooze() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); let raw = try request()
        io.mapFailure(after: true); await uncertain { try await core.snoozeReminder(requestJSON: raw) }; await core.close()
        let after = try maps(), coldIO = ReminderSnoozeIO(), cold = host(coldIO); coldIO.mapFailure(after: true)
        await uncertain { try await cold.start() }
        XCTAssertEqual(coldIO.mapCount, 1); XCTAssertEqual(try maps(), after); XCTAssertEqual(try markers().count, 0)
        await uncertain { try await cold.snoozeReminder(requestJSON: request()) }
        await uncertain { try await cold.retryPending() }
        coldIO.mapFailure()
        let restarted = try object(await cold.start())
        XCTAssertEqual((restarted["recovery"] as? [String: Any])?["method"] as? String, "reminderSnoozeCommit")
        XCTAssertEqual(coldIO.mapCount, 2); XCTAssertEqual(try maps(), after); XCTAssertEqual(try markers().count, 1)
        XCTAssertEqual(try receiptRows().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await cold.snoozeReminder(requestJSON: request()); XCTAssertEqual(try receiptRows().count, 2)
    }
    func testTerminalPromotionAndClearFailuresDoNotRepublish() async throws {
        try await terminalFailure(clear: false)
    }
    func testTerminalClearFailureDoesNotRepublish() async throws {
        try await terminalFailure(clear: true)
    }
    private func terminalFailure(clear: Bool) async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset(); let raw = try request()
        if clear { io.failRemove(true) } else { io.failJournal(at: 2) }
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try markers().count, 0); let after = try maps()
        io.failRemove(false); io.failJournal(at: nil); _ = try await core.retryPending()
        XCTAssertEqual(io.mapCount, 1); XCTAssertEqual(try maps(), after); XCTAssertEqual(try markers().count, 1)
    }
    func testColdTerminalAfterConsumptionAcknowledgesOriginalWithoutRecreatingMap() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); let raw = try request(); io.failRemove(true)
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }; let terminal = try Data(contentsOf: journal); await core.close()
        try changeState { $0.removeAll() }; let consumed = try maps(); try terminal.write(to: journal)
        let coldIO = ReminderSnoozeIO(), cold = host(coldIO), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "reminderSnoozeCommit")
        XCTAssertEqual(try maps(), consumed); XCTAssertEqual(coldIO.mapCount, 0); XCTAssertEqual(try markers().count, 1)
        await rejected { try await cold.snoozeReminder(requestJSON: raw) }; XCTAssertEqual(try maps(), consumed)
    }
    func testColdUnknownReceiptRefusesWithoutWriterOrPublication() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.failCommit(true)
        let raw = try request(), before = try maps(); await uncertain { try await core.snoozeReminder(requestJSON: raw) }; await core.close()
        let coldIO = ReminderSnoozeIO(), cold = host(coldIO), startup = try object(await cold.start())
        XCTAssertNil(startup["recovery"]); XCTAssertEqual(try maps(), before); XCTAssertEqual(try receiptRows().count, 0)
        XCTAssertEqual(coldIO.mapCount, 0); XCTAssertEqual(try markers().count, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testSavedReceiptMissingMapAndUnknownReceiptOwnedMapNeverRecreate() async throws {
        let initial = try await seed(), raw = try request(); _ = try await initial.snoozeReminder(requestJSON: raw); await initial.close()
        let owned = try maps(); _ = try sql("DELETE FROM native_request_receipts")
        let unknown = host(); _ = try await unknown.start(); await rejected { try await unknown.snoozeReminder(requestJSON: raw) }; await unknown.close()
        XCTAssertEqual(try maps(), owned); XCTAssertEqual(try receiptRows().count, 0)
    }
    func testMalformedReceiptRetainsPendingEvidence() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); let raw = try request(); io.failRemove(true)
        await uncertain { try await core.snoozeReminder(requestJSON: raw) }; await core.close()
        _ = try sql("UPDATE native_request_receipts SET reply='{}'")
        let frozen = try Data(contentsOf: journal), before = try maps(), cold = host(); await uncertain { try await cold.start() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try maps(), before); XCTAssertEqual(try markers().count, 0)
    }
    func testSavedUUIDPayloadCollisionCannotPublishAnotherAlarm() async throws {
        let core = try await seed(), raw = try request(); _ = try await core.snoozeReminder(requestJSON: raw)
        let id = try XCTUnwrap(object(raw)["requestId"] as? String), at = try XCTUnwrap(object(raw)["requestedAt"] as? Double)
        let before = try maps(), baseline = try rows()
        await rejected { try await core.snoozeReminder(requestJSON: request(id: id, requestedAt: at, title: "PRIVATE_CHANGED")) }
        XCTAssertEqual(try maps(), before); XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testOwnerGoneAndMalformedMapsRefuseBeforeJournalOrReceipt() async throws {
        let initial = try await seed(); await initial.close()
        _ = try sql("UPDATE tasks SET status='done' WHERE id='complete-task'")
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        await rejected { try await core.snoozeReminder(requestJSON: request()) }
        XCTAssertEqual(io.counts, [0, 0, 0, 0]); XCTAssertEqual(io.mapCount, 0); await core.close()
        _ = try sql("UPDATE tasks SET status='next' WHERE id='complete-task'")
        var values = try saved(); values["mindwtr:local:alarms:v1"] = "{\"legacy\":{}}"; try Data(json(values).utf8).write(to: manifest, options: .atomic)
        let brokenIO = ReminderSnoozeIO(), broken = host(brokenIO); _ = try await broken.start(); brokenIO.reset()
        await rejected { try await broken.snoozeReminder(requestJSON: request()) }
        XCTAssertEqual(brokenIO.counts, [0, 0, 0, 0]); XCTAssertEqual(try receiptRows().count, 0)
    }
    func testColdUnfinishedConflictingMapNeverOverwritesAndRetainsJournal() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.mapFailure(before: true)
        await uncertain { try await core.snoozeReminder(requestJSON: request()) }; await core.close()
        try changeState { $0["task:complete-task"] = ["kind": "delivered", "id": 5, "firedAtMs": floor(Date().timeIntervalSince1970 * 1000)] }
        let before = try maps(), frozen = try Data(contentsOf: journal), coldIO = ReminderSnoozeIO(), cold = host(coldIO)
        await uncertain { try await cold.start() }
        XCTAssertEqual(try maps(), before); XCTAssertEqual(try Data(contentsOf: journal), frozen)
        XCTAssertEqual(coldIO.mapCount, 0); XCTAssertEqual(try markers().count, 0)
    }
    func testMalformedFrozenDeltaRefusesBeforeSQLiteAndPreservesJournal() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.mapFailure(before: true)
        await uncertain { try await core.snoozeReminder(requestJSON: request()) }; await core.close()
        var command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        var args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [Any])
        args[3] = "{}"; command["argumentsJSON"] = try json(args); let malformed = Data(try json(command).utf8); try malformed.write(to: journal)
        let coldIO = ReminderSnoozeIO(), cold = host(coldIO); await uncertain { try await cold.start() }
        XCTAssertEqual(coldIO.counts, [0, 0, 0, 0]); XCTAssertEqual(try Data(contentsOf: journal), malformed)
        XCTAssertEqual(try markers().count, 0)
    }
    func testObserverWakeArrivesOnlyAfterDurablePublicationClearAndOnceForWarmRetry() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); let wakes = ReminderSnoozeWakes()
        _ = try await core.observeReminders { wakes.record($0) }
        let raw = try request(); io.mapFailure(after: true); await uncertain { try await core.snoozeReminder(requestJSON: raw) }
        XCTAssertEqual(wakes.revisions, []); XCTAssertEqual(try markers().count, 0)
        io.mapFailure(); _ = try await core.retryPending(); _ = try await core.readAboutUpdateState()
        XCTAssertEqual(wakes.revisions.count, 1); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.snoozeReminder(requestJSON: raw); _ = try await core.readAboutUpdateState()
        XCTAssertEqual(wakes.revisions.count, 1); XCTAssertEqual(try markers().count, 1)
    }
    func testAcceptedReceiptWriteCancellationAndQueuedCloseDrainPublication() async throws {
        let initial = try await seed(); await initial.close()
        let io = ReminderSnoozeIO(), core = host(io); _ = try await core.start(); io.reset()
        let entered = expectation(description: "Journaled Snooze reaches receipt SQL"), release = DispatchSemaphore(value: 0)
        io.holdWrite(entered, release: release)
        let raw = try request(), task = Task { try await core.snoozeReminder(requestJSON: raw) }
        await fulfillment(of: [entered], timeout: 3); task.cancel()
        let closing = Task { await core.close(); io.didClose() }; for _ in 0..<30 { await Task.yield() }
        XCTAssertFalse(io.isClosed); XCTAssertEqual(try markers().count, 0)
        release.signal(); _ = try await task.value; await closing.value
        XCTAssertTrue(io.isClosed); XCTAssertEqual(try entry(raw)["armed"] as? Bool, false)
        XCTAssertEqual(try markers().count, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let adds = await port.adds; XCTAssertEqual(adds, 0)
    }
}
