import Darwin
import CoreFoundation
import Foundation
import Security
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

private actor ReminderEffectsFakePort: NativeReminderPort {
    struct Mutation: Sendable { let operation: String; let identifiers: [String]; let maps: [String?] }
    private var pendingValues: [NativeReminderObservation] = []
    private var deliveredValues: [NativeReminderObservation] = []
    private var grant = true
    private var failAdd: Int?
    private var ignoreRemoval = false
    private var entered: XCTestExpectation?
    private var held: CheckedContinuation<Void, Never>?
    private var permissionHoldAt: Int?
    private var permissionEntered: XCTestExpectation?
    private var heldPermission: CheckedContinuation<Void, Never>?
    private var removalEntered: XCTestExpectation?
    private var heldRemoval: CheckedContinuation<Void, Never>?
    private(set) var mutations: [Mutation] = []
    private(set) var addCount = 0
    private(set) var permissionCount = 0
    let manifest: URL
    init(manifest: URL) { self.manifest = manifest }
    func permission() async throws -> NativeNotificationPermission {
        permissionCount += 1
        if permissionHoldAt == permissionCount, let permissionEntered {
            self.permissionEntered = nil; permissionHoldAt = nil
            await withCheckedContinuation { continuation in heldPermission = continuation; permissionEntered.fulfill() }
        }
        return .observed(status: grant ? .authorized : .denied, alertEnabled: grant)
    }
    func pending(namespace: String) async throws -> [NativeReminderObservation] { pendingValues }
    func delivered(namespace: String) async throws -> [NativeReminderObservation] { deliveredValues }
    func configure(granted: Bool = true, failAdd: Int? = nil, ignoreRemoval: Bool = false) {
        grant = granted; self.failAdd = failAdd; self.ignoreRemoval = ignoreRemoval
    }
    func setPending(_ values: [NativeReminderObservation]) { pendingValues = values }
    func setDelivered(_ values: [NativeReminderObservation]) { deliveredValues = values }
    func holdAdd(_ expectation: XCTestExpectation) { entered = expectation }
    func releaseAdd() { held?.resume(); held = nil }
    func holdPermission(at count: Int, entered: XCTestExpectation) { permissionHoldAt = count; permissionEntered = entered }
    func releasePermission() { heldPermission?.resume(); heldPermission = nil }
    func holdDeliveredRemoval(_ expectation: XCTestExpectation) { removalEntered = expectation }
    func releaseDeliveredRemoval() { heldRemoval?.resume(); heldRemoval = nil }
    private func record(_ operation: String, _ identifiers: [String]) throws {
        let object = try NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: String]
        mutations.append(.init(operation: operation, identifiers: identifiers,
            maps: [object?["mindwtr:local:alarms:v1"], object?["mindwtr:native:reminders:v1"]]))
    }
    func add(_ alarm: NativeReminderEffects.Alarm, namespace: String) async throws {
        addCount += 1; try record("add", [alarm.identifier])
        if failAdd == addCount { throw HostFailure("Private synthetic add refusal") }
        guard let value = try NativeJSON.jsonObject(with: Data(alarm.json.utf8)) as? [String: Any] else { throw NativeReminderEffects.unavailable }
        let request = try NativeReminderRequest.make(alarm: value, namespace: namespace)
        pendingValues.removeAll { $0.identifier == request.identifier }
        pendingValues.append(.read(request, namespace: namespace))
        if let entered {
            self.entered = nil
            await withCheckedContinuation { continuation in held = continuation; entered.fulfill() }
        }
    }
    func removePending(_ identifiers: [String]) async throws {
        try record("pending-remove", identifiers)
        if !ignoreRemoval { pendingValues.removeAll { identifiers.contains($0.identifier) } }
    }
    func removeDelivered(_ identifiers: [String]) async throws {
        try record("delivered-remove", identifiers)
        if !ignoreRemoval { deliveredValues.removeAll { identifiers.contains($0.identifier) } }
        if let removalEntered {
            self.removalEntered = nil
            await withCheckedContinuation { continuation in heldRemoval = continuation; removalEntered.fulfill() }
        }
    }
}

private final class ReminderEffectsForbiddenHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Reminder effects must not access HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

private final class ReminderMapWriteFault: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var enabled = true
    func before() throws {
        lock.lock(); defer { lock.unlock() }; count += 1
        if count == 2 && enabled { throw HostFailure("Private final map refusal") }
    }
}

private final class ReminderWakeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(String, UInt64)] = []
    func record(_ event: NativeReminderWake) {
        lock.lock(); defer { lock.unlock() }
        switch event {
        case .sourceChanged(let revision): values.append(("source", revision))
        case .admissionReady(let revision): values.append(("ready", revision))
        }
    }
    var events: [(String, UInt64)] { lock.lock(); defer { lock.unlock() }; return values }
}

private final class ReminderOrdinaryWriteHold: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private let entered: XCTestExpectation
    private let released = DispatchSemaphore(value: 0)
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func arm() { lock.lock(); defer { lock.unlock() }; armed = true }
    func before() throws {
        lock.lock()
        let hold = armed; armed = false
        lock.unlock()
        if hold {
            entered.fulfill()
            guard released.wait(timeout: .now() + 5) == .success else { throw HostFailure("Private ordinary write hold expired") }
        }
    }
    func release() { released.signal() }
}

private final class ReminderJournalClearFault: @unchecked Sendable {
    private let lock = NSLock()
    private var refusing = false
    func enable(_ value: Bool) { lock.lock(); defer { lock.unlock() }; refusing = value }
    func before() throws {
        lock.lock(); defer { lock.unlock() }
        if refusing { throw HostFailure("Private reminder receipt clear refusal") }
    }
}

final class ReminderEffectsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace: String!, port: ReminderEffectsFakePort!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private let alarmName = "mindwtr:local:alarms:v1", stateName = "mindwtr:native:reminders:v1"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Reminder test bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderEffectsHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Reminder fixture directory is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.example.mindwtr.effects." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown-reminder-setting": "Exact private preference 文", alarmName: "{}", stateName: "{}"]).utf8).write(to: manifest)
        port = ReminderEffectsFakePort(manifest: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func saved() throws -> [String: String] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: String]) }
    private func maps() throws -> [String?] { let values = try saved(); return [values[alarmName], values[stateName]] }
    private func host(io: ((HostIOFaults) -> Void)? = nil, coreBundle: URL? = nil, configure: ((NativeDeviceKV) -> Void)? = nil) -> CoreHost {
        let faults = HostIOFaults(), captured = port!; faults.reminderPort = captured; faults.configureDeviceStorage = configure
        faults.notificationPermissionRead = { try await captured.permission() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReminderEffectsForbiddenHTTP.self]; faults.httpConfiguration = config
        faults.secretBeforeOperation = { _, _ in XCTFail("Reminder effects must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Reminder effects must not access crypto") }
        io?(faults)
        let value = CoreHost(databaseURL: database, bundleURL: coreBundle ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func seed(count: Int = 2) async throws -> CoreHost {
        let initial = host(); _ = try await initial.start(); await initial.close()
        let at = ISO8601DateFormatter().string(from: Date())
        for index in 0..<count {
            let due = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600 + Double(index) * 60))
            _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,dueDate,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,?,'[]','[]',?,?,?,3,'fixture',0,0,0,0)", ["task-\(index)", "PRIVATE_REMINDER_\(index)", "next", due, at, at])
        }
        try settings { data in
            data["notificationsEnabled"] = true; data["dueDateNotificationsEnabled"] = true
            data["dailyDigestMorningEnabled"] = false; data["dailyDigestEveningEnabled"] = false; data["weeklyReviewEnabled"] = false
        }
        let value = host(); _ = try await value.start(); return value
    }
    private func settings(_ mutate: (inout [String: Any]) -> Void) throws {
        let selected = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        var data = try object(try XCTUnwrap(selected.first?["data"] as? String)); mutate(&data)
        _ = try sql("UPDATE settings SET data=? WHERE id=1", [json(data)])
    }
    /// Canonical outer SQL encoding leaves every cell's original bytes and storage type intact.
    private func rows() throws -> [String: String] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var answer: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            answer[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return answer
    }
    private func markers() throws -> [[String: Any]] {
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(text.contains("PRIVATE_REMINDER")); XCTAssertFalse(text.contains("task:task-")); XCTAssertFalse(text.contains(namespace))
        let entries = try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-apply") }.map { try object(String($0)) }
        for entry in entries {
            XCTAssertEqual(entry["message"] as? String, "Native iOS reminders reconciled")
            let context = try XCTUnwrap(entry["context"] as? [String: String])
            XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "outcome", "mode", "scheduled", "cancelled"]))
            XCTAssertEqual(context["outcome"], "confirmed")
        }
        return entries
    }
    private func unavailable(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected exact reminder refusal") }
        catch { XCTAssertEqual(error.localizedDescription, "NOT_READY: Reminder reconciliation is unavailable") }
    }
    private func cancelled(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected reminder cancellation") } catch { XCTAssertTrue(error is CancellationError) }
    }
    private func unchangedDomain(_ before: [String: String], other: [String: String]) throws {
        XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try saved().filter { ![alarmName, stateName].contains($0.key) }, other)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }
    private func observation(_ identifier: String, id: Int? = nil, invalid: Bool = false) -> NativeReminderObservation {
        let content = UNMutableNotificationContent(); content.threadIdentifier = "PRIVATE_THREAD"
        if let id { content.userInfo = ["mindwtrNativeReminder": ["version": invalid ? true as Any : 1 as Any, "namespace": namespace!, "id": id]] }
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        return .read(request, namespace: namespace, deliveredAt: Date())
    }

    func testRealJSCWriteAheadBeforeEveryAddExactFinalMapsAndNoopKeepsForeignRequests() async throws {
        let value = try await seed(), baseline = try rows(), other = try saved().filter { ![alarmName, stateName].contains($0.key) }
        let foreign = observation("foreign-pomodoro"); await port.setPending([foreign]); await port.setDelivered([foreign])
        let result = try object(try await value.reconcileReminders())
        XCTAssertEqual(Set(result.keys), Set(["mode", "scheduled", "cancelled", "topUpAtMs"])); XCTAssertEqual(result["mode"] as? String, "active")
        XCTAssertEqual(result["scheduled"] as? Int, 2); XCTAssertEqual(result["cancelled"] as? Int, 0)
        let mutations = await port.mutations; XCTAssertEqual(mutations.map(\.operation), ["add", "add"])
        for event in mutations {
            let map = try object(try XCTUnwrap(event.maps[0])); XCTAssertEqual(map.count, 2)
            XCTAssertTrue(map.values.allSatisfy { ($0 as? [String: Any])?["pending"] as? Bool == true })
        }
        let final = try object(try XCTUnwrap(maps()[0])); XCTAssertEqual(final.count, 2)
        XCTAssertTrue(final.values.allSatisfy { ($0 as? [String: Any])?["pending"] == nil })
        let before = try maps(), next = try object(try await value.reconcileReminders())
        XCTAssertEqual(next["scheduled"] as? Int, 0); XCTAssertEqual(try maps(), before)
        let pending = try await port.pending(namespace: namespace), delivered = try await port.delivered(namespace: namespace)
        XCTAssertTrue(pending.contains(foreign)); XCTAssertEqual(delivered, [foreign]); XCTAssertEqual(try markers().count, 2)
        try unchangedDomain(baseline, other: other)
    }
    func testPartialAddFailureColdRetriesExactStableIDsWithoutDuplicateOwnership() async throws {
        let value = try await seed(), baseline = try rows(), other = try saved().filter { ![alarmName, stateName].contains($0.key) }
        await port.configure(failAdd: 2); await unavailable { try await value.reconcileReminders() }
        let interrupted = try object(try XCTUnwrap(maps()[0])); XCTAssertEqual(interrupted.count, 2)
        XCTAssertTrue(interrupted.values.allSatisfy { ($0 as? [String: Any])?["pending"] as? Bool == true })
        let original = await port.mutations.flatMap(\.identifiers); XCTAssertEqual(Set(original).count, 2); XCTAssertEqual(try markers().count, 0)
        await value.close(); await port.configure()
        let cold = host(); _ = try await cold.start(); let reply = try object(try await cold.reconcileReminders())
        XCTAssertEqual(reply["scheduled"] as? Int, 2)
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(Set(pending.map(\.identifier)), Set(original))
        XCTAssertEqual(pending.count, 2); try unchangedDomain(baseline, other: other); XCTAssertEqual(try markers().count, 1)
    }
    func testUncertainFinalMapRetainsExactOwnerUntilSettlementThenFreshCycle() async throws {
        let first = try await seed(); await first.close()
        let fault = ReminderMapWriteFault(), value = host { store in store.faults.beforePromotion = { try fault.before() } }
        _ = try await value.start(); let baseline = try rows()
        await unavailable { try await value.reconcileReminders() }
        let before = await port.addCount; XCTAssertEqual(before, 2); XCTAssertEqual(try markers().count, 0)
        await unavailable { try await value.readAboutUpdateState() }
        // The exact retained bytes settle, but that retry cannot resume or acknowledge the old plan.
        await unavailable { try await value.reconcileReminders() }
        let afterSettlement = await port.addCount; XCTAssertEqual(afterSettlement, before); XCTAssertEqual(try markers().count, 0)
        let result = try object(try await value.reconcileReminders()); XCTAssertEqual(result["scheduled"] as? Int, 0)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 1)
        await value.close(); let cold = host(); _ = try await cold.start()
        let replay = try object(try await cold.reconcileReminders()); XCTAssertEqual(replay["scheduled"] as? Int, 0)
    }
    func testCancelledHeldAddDrainsWithoutSuccessorOrFinalPublicationThenRetries() async throws {
        let value = try await seed(), baseline = try rows(), entered = expectation(description: "Accepted held add")
        await port.holdAdd(entered)
        let task = Task { try await value.reconcileReminders() }; await fulfillment(of: [entered], timeout: 5)
        task.cancel(); await port.releaseAdd(); await cancelled { try await task.value }
        let count = await port.addCount; XCTAssertEqual(count, 1); XCTAssertEqual(try markers().count, 0); XCTAssertEqual(try rows(), baseline)
        let pendingMap = try object(try XCTUnwrap(maps()[0])); XCTAssertTrue(pendingMap.values.allSatisfy { ($0 as? [String: Any])?["pending"] as? Bool == true })
        let next = try object(try await value.reconcileReminders()); XCTAssertEqual(next["scheduled"] as? Int, 2)
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending.count, 2)
    }
    func testCloseWaitsForAcceptedAddAndPreservesFutureRequestWithoutCleanup() async throws {
        let value = try await seed(), entered = expectation(description: "Accepted add before close")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let closing = Task { await value.close() }
        for _ in 0..<20 { await Task.yield() }
        await port.releaseAdd(); await closing.value; await cancelled { try await task.value }
        let events = await port.mutations, pending = try await port.pending(namespace: namespace)
        XCTAssertEqual(events.map(\.operation), ["add"]); XCTAssertEqual(pending.count, 1); XCTAssertEqual(try markers().count, 0)
        await cancelled { try await value.reconcileReminders() }
    }
    func testConcurrentCycleAndGenericPrivateSelectorsCannotOverlapEffectsOwner() async throws {
        let value = try await seed(), entered = expectation(description: "Single effects owner")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        await unavailable { try await value.reconcileReminders() }
        await unavailable { try await value.call("iosReminderPrepare", argumentsJSON: "[]") }
        let writer = Task { try await value.recordAboutUpdateCheck(timestamp: "1") }
        for _ in 0..<100 { await Task.yield() }
        let count = await port.addCount; XCTAssertEqual(count, 1)
        await port.releaseAdd(); await cancelled { try await task.value }; try await writer.value
        XCTAssertEqual(try saved()["mindwtr-update-last-check"], "1")
        _ = try await value.reconcileReminders()
        let final = await port.addCount; XCTAssertEqual(final, 3)
    }
    func testExternalTaskCommitWhileAddHeldRefusesStaleRuntimeAndColdUsesFreshRows() async throws {
        let value = try await seed(), entered = expectation(description: "Held add before external task commit")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        _ = try sql("UPDATE tasks SET status='done',rev=rev+1 WHERE id='task-0'"); let baseline = try rows()
        await port.releaseAdd(); await unavailable { try await task.value }
        let count = await port.addCount, reads = await port.permissionCount
        XCTAssertEqual(count, 1); XCTAssertEqual(try markers().count, 0); XCTAssertEqual(try rows(), baseline)
        await unavailable { try await value.reconcileReminders() }; let laterReads = await port.permissionCount; XCTAssertEqual(laterReads, reads)
        await value.close(); let cold = host(); _ = try await cold.start(); _ = try await cold.reconcileReminders()
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending.count, 1); XCTAssertEqual(try rows(), baseline)
    }
    func testExternalSettingsCommitWhileAddHeldStopsSuccessorsAndPreservesAllRows() async throws {
        let value = try await seed(), entered = expectation(description: "Held add before settings commit")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }; await fulfillment(of: [entered], timeout: 5)
        try settings { $0["notificationsEnabled"] = false }; let baseline = try rows()
        await port.releaseAdd(); await unavailable { try await task.value }
        let count = await port.addCount; XCTAssertEqual(count, 1); XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 0)
        await value.close(); let cold = host(); _ = try await cold.start()
        let result = try object(try await cold.reconcileReminders()); XCTAssertEqual(result["mode"] as? String, "inactive")
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending, []); XCTAssertEqual(try rows(), baseline)
    }
    func testNamespaceReplacementWhileAddHeldPreservesReplacementAndStopsSuccessors() async throws {
        let value = try await seed(), entered = expectation(description: "Held add before namespace replacement")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }; await fulfillment(of: [entered], timeout: 5)
        let directory = manifest.deletingLastPathComponent(), retired = directory.appendingPathExtension("retired")
        var object = try saved(); object["external-owner"] = "Exact replacement bytes 文"
        let bytes = Data(try json(object).utf8), baseline = try rows()
        try FileManager.default.moveItem(at: directory, to: retired); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try bytes.write(to: manifest)
        await port.releaseAdd(); await unavailable { try await task.value }
        let count = await port.addCount; XCTAssertEqual(count, 1); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 0)
    }
    func testMalformedAndLegacyMapsRefuseBeforeAnyStorageOrOSMutation() async throws {
        let initial = try await seed(); await initial.close()
        let malformed = ["PRIVATE", "[]", "{\"task:task-0\":{\"id\":123,\"signature\":\"legacy\"}}",
            "{\"task:task-0\":{\"id\":1073741824,\"signature\":\"native:{}\"}}"]
        for raw in malformed {
            var object = try saved(); object[alarmName] = raw
            let bytes = Data(try json(object).utf8); try bytes.write(to: manifest, options: .atomic)
            let value = host(); _ = try await value.start(); let baseline = try rows()
            await unavailable { try await value.reconcileReminders() }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), baseline)
            let effects = await port.mutations; XCTAssertEqual(effects.count, 0); XCTAssertEqual(try markers().count, 0)
            await value.close()
        }
    }
    func testUnownedSameIdentifierCollisionRefusesBeforeWriteAhead() async throws {
        let value = try await seed(), preview = try object(try await value.readReminderPlan())
        let plan = try XCTUnwrap(preview["plan"] as? [String: Any]), schedule = try XCTUnwrap(plan["schedule"] as? [[String: Any]])
        let id = try XCTUnwrap(schedule.first?["id"] as? Int), identifier = "mindwtr-native:\(namespace!):\(id)"
        let foreign = observation(identifier, id: id, invalid: true); XCTAssertNil(foreign.ownedID)
        await port.setPending([foreign]); await port.setDelivered([foreign]); let bytes = try Data(contentsOf: manifest), baseline = try rows()
        await unavailable { try await value.reconcileReminders() }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), baseline)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0); XCTAssertEqual(try markers().count, 0)
    }
    func testProjectedCapacityCountsAllForeignRequestsAndRefusesWholeCycleThenAllows64() async throws {
        let value = try await seed(), foreign = (0..<63).map { observation("foreign-\($0)") }
        await port.setPending(foreign); let bytes = try Data(contentsOf: manifest), baseline = try rows()
        await unavailable { try await value.reconcileReminders() }
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), baseline)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
        await port.setPending(Array(foreign.prefix(62))); _ = try await value.reconcileReminders()
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending.count, 64)
        XCTAssertTrue(foreign.prefix(62).allSatisfy { pending.contains($0) })
    }
    func testDeniedPermissionWithdrawsOwnedDeliveredBeforePendingAndPreservesForeign() async throws {
        let value = try await seed(); _ = try await value.reconcileReminders()
        let owned = try await port.pending(namespace: namespace), foreign = observation("foreign")
        await port.setPending(owned + [foreign]); await port.setDelivered(owned + [foreign]); await port.configure(granted: false)
        let before = await port.mutations.count, baseline = try rows(), result = try object(try await value.reconcileReminders())
        XCTAssertEqual(result["mode"] as? String, "revoked"); XCTAssertEqual(result["cancelled"] as? Int, 2)
        let events = await port.mutations, pending = try await port.pending(namespace: namespace), delivered = try await port.delivered(namespace: namespace)
        XCTAssertEqual(Array(events.dropFirst(before)).map(\.operation), ["delivered-remove", "pending-remove"])
        XCTAssertEqual(pending, [foreign]); XCTAssertEqual(delivered, [foreign]); XCTAssertEqual(try maps(), ["{}", "{}"]); XCTAssertEqual(try rows(), baseline)
    }
    func testFeatureOffWithdrawsOnlyOwnedRequestsWithExactDomainPreservation() async throws {
        let value = try await seed(); _ = try await value.reconcileReminders()
        let owned = try await port.pending(namespace: namespace), foreign = observation("foreign")
        await port.setPending(owned + [foreign]); await port.setDelivered(owned + [foreign]); await value.close()
        try settings { $0["notificationsEnabled"] = false }; let baseline = try rows()
        let cold = host(); _ = try await cold.start(); let result = try object(try await cold.reconcileReminders())
        XCTAssertEqual(result["mode"] as? String, "inactive")
        let pending = try await port.pending(namespace: namespace), delivered = try await port.delivered(namespace: namespace)
        XCTAssertEqual(pending, [foreign]); XCTAssertEqual(delivered, [foreign]); XCTAssertEqual(try rows(), baseline)
    }
    func testUnacknowledgedRemovalRetainsMapsAndCannotEmitConfirmedMarker() async throws {
        let value = try await seed(); _ = try await value.reconcileReminders()
        let owned = try await port.pending(namespace: namespace); await port.setDelivered(owned)
        await port.configure(granted: false, ignoreRemoval: true); let before = try maps()
        await unavailable { try await value.reconcileReminders() }
        XCTAssertEqual(try maps(), before); XCTAssertEqual(try markers().count, 1)
        await port.configure(granted: false); _ = try await value.reconcileReminders()
        XCTAssertEqual(try maps(), ["{}", "{}"]); XCTAssertEqual(try markers().count, 2)
    }
    func testMissingPendingIsNotFiredEvidenceAndActualExpiredTrayIsPreserved() async throws {
        let value = try await seed(); _ = try await value.reconcileReminders(); await value.close()
        let owned = try await port.pending(namespace: namespace)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let first = try XCTUnwrap(owned.first)
        let past = formatter.string(from: Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) - 3600))
        _ = try sql("UPDATE tasks SET dueDate=? WHERE id='task-0'", [past])
        var values = try saved(), map = try object(try XCTUnwrap(values[alarmName]))
        var entry = try XCTUnwrap(map["task:task-0"] as? [String: Any])
        let raw = try XCTUnwrap(entry["signature"] as? String)
        var signature = try object(String(raw.dropFirst(7))); signature["fireAt"] = past
        entry["signature"] = "native:" + (try json(signature)); map["task:task-0"] = entry
        values[alarmName] = try json(map); try Data(json(values).utf8).write(to: manifest, options: .atomic)
        await port.setPending(Array(owned.dropFirst())); await port.setDelivered([])
        let cold = host(); _ = try await cold.start(); _ = try await cold.reconcileReminders()
        XCTAssertEqual(try maps()[1], "{}"); let events = await port.mutations
        XCTAssertFalse(events.contains { $0.operation == "delivered-remove" })
        await cold.close()
        // Restore only the known expired map fixture and actual owned tray evidence; disappearance alone above created none.
        var restored = try saved(); restored[alarmName] = try json(map); restored[stateName] = "{}"
        try Data(json(restored).utf8).write(to: manifest, options: .atomic); await port.setDelivered([first])
        let deliveredHost = host(); _ = try await deliveredHost.start(); let baseline = try rows()
        _ = try await deliveredHost.reconcileReminders()
        let tray = try await port.delivered(namespace: namespace); XCTAssertEqual(tray, [first])
        let remembered = try object(try XCTUnwrap(maps()[1])); XCTAssertEqual((remembered["task:task-0"] as? [String: Any])?["kind"] as? String, "delivered")
        XCTAssertEqual(try rows(), baseline)
    }

    private func refuseReplacementDuringPermissionAwait(delivered: Bool) async throws {
        let value = try await seed(); _ = try await value.reconcileReminders()
        let owned = try await port.pending(namespace: namespace), first = try XCTUnwrap(owned.first)
        await port.setDelivered(delivered ? owned : []); await port.configure(granted: false)
        let reads = await port.permissionCount, before = await port.mutations.count
        let entered = expectation(description: "Permission held after initial inventory")
        await port.holdPermission(at: reads + 2, entered: entered)
        let bytes = try Data(contentsOf: manifest), baseline = try rows()
        let task = Task { try await value.reconcileReminders() }; await fulfillment(of: [entered], timeout: 5)
        let foreign = observation(first.identifier, id: first.ownedID, invalid: true)
        if delivered { await port.setDelivered([foreign] + Array(owned.dropFirst())) }
        else { await port.setPending([foreign] + Array(owned.dropFirst())) }
        await port.releasePermission(); await unavailable { try await task.value }
        let pending = try await port.pending(namespace: namespace), tray = try await port.delivered(namespace: namespace)
        XCTAssertTrue((delivered ? tray : pending).contains(foreign))
        let effects = await port.mutations; XCTAssertEqual(effects.count, before)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 1)
        _ = try await value.readAboutUpdateState()
        // The external owner then retires its replacement; our next explicit cycle must be usable.
        if delivered { await port.setDelivered(Array(owned.dropFirst())) }
        else { await port.setPending(Array(owned.dropFirst())) }
        let next = try object(try await value.reconcileReminders()); XCTAssertEqual(next["mode"] as? String, "revoked")
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 2)
    }
    func testPendingOwnershipReplacementDuringPermissionAwaitRefusesBeforeRemoval() async throws {
        try await refuseReplacementDuringPermissionAwait(delivered: false)
    }
    func testDeliveredOwnershipReplacementDuringPermissionAwaitRefusesBeforeRemoval() async throws {
        try await refuseReplacementDuringPermissionAwait(delivered: true)
    }
    func testMissingDailyPendingRequestIsRearmedDespiteOldOwnedTrayWithSameID() async throws {
        let initial = try await seed(count: 0); await initial.close()
        try settings { $0["dailyDigestMorningEnabled"] = true }
        let value = host(); _ = try await value.start(); _ = try await value.reconcileReminders()
        let owned = try await port.pending(namespace: namespace); XCTAssertEqual(owned.count, 1)
        await port.setPending([]); await port.setDelivered(owned)
        let baseline = try rows(), before = await port.mutations.count
        let result = try object(try await value.reconcileReminders()); XCTAssertEqual(result["scheduled"] as? Int, 1)
        let pending = try await port.pending(namespace: namespace), tray = try await port.delivered(namespace: namespace), events = await port.mutations
        XCTAssertEqual(pending.map(\.identifier), owned.map(\.identifier)); XCTAssertEqual(tray, owned)
        XCTAssertEqual(Array(events.dropFirst(before)).map(\.operation), ["add"]); XCTAssertEqual(try rows(), baseline)
    }
    func testMovedFutureReminderWithMissingPendingWithdrawsOldTrayBeforeStableIDReplacement() async throws {
        let value = try await seed(count: 1); _ = try await value.reconcileReminders(); await value.close()
        let owned = try await port.pending(namespace: namespace); XCTAssertEqual(owned.count, 1)
        await port.setPending([]); await port.setDelivered(owned)
        let due = ISO8601DateFormatter().string(from: Date().addingTimeInterval(7200))
        _ = try sql("UPDATE tasks SET dueDate=?,rev=rev+1 WHERE id='task-0'", [due]); let baseline = try rows(), before = await port.mutations.count
        let cold = host(); _ = try await cold.start(); let result = try object(try await cold.reconcileReminders())
        XCTAssertEqual(result["scheduled"] as? Int, 1)
        let pending = try await port.pending(namespace: namespace), tray = try await port.delivered(namespace: namespace), events = await port.mutations
        XCTAssertEqual(pending.map(\.identifier), owned.map(\.identifier)); XCTAssertEqual(tray, [])
        XCTAssertEqual(Array(events.dropFirst(before)).map(\.operation), ["delivered-remove", "add"]); XCTAssertEqual(try rows(), baseline)
    }

    private func threadDelivery(_ identifier: String, id: Int? = nil, thread: String,
        at: Double? = 1_800_000_000_000, invalid: Bool = false, foreignNamespace: Bool = false) -> NativeReminderObservation {
        let content = UNMutableNotificationContent(); content.threadIdentifier = thread
        if let id {
            content.userInfo = ["mindwtrNativeReminder": ["version": invalid ? true as Any : 1 as Any,
                "namespace": foreignNamespace ? "foreign" : namespace!, "id": id]]
        }
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        return .read(request, namespace: namespace, deliveredAt: at.map { Date(timeIntervalSince1970: $0 / 1000) })
    }
    private func reminderIdentifier(_ id: Int) -> String { "mindwtr-native:\(namespace!):\(id)" }
    private func collapseMarkers() throws -> [[String: Any]] {
        _ = try markers() // The same full log privacy checks apply to both fixed markers.
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        let entries = try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-thread-collapse") }.map { try object(String($0)) }
        for entry in entries {
            XCTAssertEqual(entry["message"] as? String, "Native iOS reminder threads collapsed")
            let context = try XCTUnwrap(entry["context"] as? [String: String])
            XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "count"]))
            let count = try XCTUnwrap(context["count"].flatMap(Int.init)); XCTAssertTrue((1...4096).contains(count))
        }
        return entries
    }
    func testDeliveredThreadSelectionUsesActualDatesExactOwnershipAndFirstObservedTies() throws {
        let thread = "mindwtr-reminder:PRIVATE_REMINDER_A"
        let oldest = threadDelivery(reminderIdentifier(11), id: 11, thread: thread, at: 10)
        let newest = threadDelivery(reminderIdentifier(12), id: 12, thread: thread, at: 30)
        let tied = threadDelivery(reminderIdentifier(13), id: 13, thread: thread, at: 30)
        let snooze = threadDelivery(reminderIdentifier(1_073_741_825), id: 1_073_741_825, thread: thread, at: 20)
        let foreign = threadDelivery("foreign", thread: thread, at: 100)
        let prefixOnly = threadDelivery(reminderIdentifier(14), thread: thread, at: 100)
        let malformed = threadDelivery(reminderIdentifier(15), id: 15, thread: thread, at: 100, invalid: true)
        let otherNamespace = threadDelivery(reminderIdentifier(16), id: 16, thread: thread, at: 100, foreignNamespace: true)
        let undated = threadDelivery(reminderIdentifier(17), id: 17, thread: thread, at: nil)
        let invalidDate = threadDelivery(reminderIdentifier(18), id: 18, thread: thread, at: .infinity)
        let otherThread = threadDelivery(reminderIdentifier(19), id: 19, thread: "foreign-thread", at: 100)
        let independent = threadDelivery(reminderIdentifier(20), id: 20, thread: "mindwtr-reminder:PRIVATE_REMINDER_B", at: 1)
        let inventory = [oldest, foreign, prefixOnly, newest, tied, malformed, otherNamespace, snooze, undated, invalidDate, otherThread, independent]
        XCTAssertEqual(try NativeReminderEffects.supersededDelivered(inventory).map(\.identifier), [oldest.identifier, tied.identifier, snooze.identifier])
        XCTAssertThrowsError(try NativeReminderEffects.supersededDelivered([oldest, oldest]))
    }
    func testActualThreadCollapseKeepsNewestRepeatOrSnoozeAndPreservesAllPendingRequests() async throws {
        let value = try await seed(); _ = try await value.reconcileReminders()
        let pending = try await port.pending(namespace: namespace), first = try XCTUnwrap(pending.first), second = try XCTUnwrap(pending.last)
        let threadA = "mindwtr-reminder:PRIVATE_REMINDER_A", threadB = "mindwtr-reminder:PRIVATE_REMINDER_B"
        let old = threadDelivery(first.identifier, id: first.ownedID, thread: threadA, at: 10)
        let repeatEntry = threadDelivery(reminderIdentifier(123), id: 123, thread: threadA, at: 20)
        let newest = threadDelivery(reminderIdentifier(1_073_741_825), id: 1_073_741_825, thread: threadA, at: 30)
        let otherOld = threadDelivery(reminderIdentifier(124), id: 124, thread: threadB, at: 10)
        let otherNewest = threadDelivery(second.identifier, id: second.ownedID, thread: threadB, at: 20)
        let foreign = threadDelivery("foreign", thread: threadA, at: 100)
        let malformed = threadDelivery(reminderIdentifier(125), id: 125, thread: threadA, at: 100, invalid: true)
        let undated = threadDelivery(reminderIdentifier(126), id: 126, thread: threadA, at: nil)
        let before = await port.mutations.count, baseline = try rows(), other = try saved().filter { ![alarmName, stateName].contains($0.key) }
        await port.setDelivered([old, repeatEntry, newest, otherOld, otherNewest, foreign, malformed, undated])
        let result = try object(try await value.reconcileReminders())
        XCTAssertEqual(Set(result.keys), Set(["mode", "scheduled", "cancelled", "topUpAtMs"]))
        XCTAssertEqual(result["scheduled"] as? Int, 0); XCTAssertEqual(result["cancelled"] as? Int, 0)
        let events = await port.mutations, actualPending = try await port.pending(namespace: namespace), tray = try await port.delivered(namespace: namespace)
        XCTAssertEqual(Array(events.dropFirst(before)).map(\.operation), ["delivered-remove"])
        XCTAssertEqual(Set(try XCTUnwrap(events.last).identifiers), Set([old.identifier, repeatEntry.identifier, otherOld.identifier]))
        XCTAssertEqual(actualPending, pending); XCTAssertEqual(tray, [newest, otherNewest, foreign, malformed, undated])
        let collapsed = try collapseMarkers(); XCTAssertEqual(collapsed.count, 1)
        XCTAssertEqual((collapsed[0]["context"] as? [String: String])?["count"], "3")
        try unchangedDomain(baseline, other: other)
        _ = try await value.reconcileReminders()
        let after = await port.mutations.count; XCTAssertEqual(after, events.count); XCTAssertEqual(try collapseMarkers().count, 1)
        let finalPending = try await port.pending(namespace: namespace); XCTAssertEqual(finalPending, pending)
    }
    func testThreadRemovalMustBeObservedBeforeFinalMapsOrMarkerAndRetriesSafely() async throws {
        let value = try await seed(count: 1); _ = try await value.reconcileReminders()
        let pending = try await port.pending(namespace: namespace), first = try XCTUnwrap(pending.first)
        let thread = "mindwtr-reminder:PRIVATE_REMINDER_A"
        let old = threadDelivery(reminderIdentifier(123), id: 123, thread: thread, at: 10)
        let newest = threadDelivery(first.identifier, id: first.ownedID, thread: thread, at: 20)
        await port.setDelivered([old, newest]); await port.configure(ignoreRemoval: true)
        let before = try maps(), baseline = try rows(), other = try saved().filter { ![alarmName, stateName].contains($0.key) }
        await unavailable { try await value.reconcileReminders() }
        XCTAssertEqual(try maps(), before); XCTAssertEqual(try markers().count, 1); XCTAssertEqual(try collapseMarkers().count, 0)
        let retained = try await port.delivered(namespace: namespace); XCTAssertEqual(retained, [old, newest])
        try unchangedDomain(baseline, other: other)
        await port.configure(); _ = try await value.reconcileReminders()
        let tray = try await port.delivered(namespace: namespace), actualPending = try await port.pending(namespace: namespace)
        XCTAssertEqual(tray, [newest]); XCTAssertEqual(actualPending, pending)
        XCTAssertEqual(try markers().count, 2); XCTAssertEqual(try collapseMarkers().count, 1)
        try unchangedDomain(baseline, other: other)
    }
    func testThreadCollapsePreservesForeignUndatedAndNonReminderDuplicatesWithoutEffects() async throws {
        let value = try await seed(count: 0)
        let thread = "mindwtr-reminder:PRIVATE_REMINDER_A"
        let inventory = [threadDelivery("foreign-1", thread: thread), threadDelivery("foreign-2", thread: thread),
            threadDelivery(reminderIdentifier(11), id: 11, thread: thread, at: nil),
            threadDelivery(reminderIdentifier(12), id: 12, thread: thread, at: nil),
            threadDelivery(reminderIdentifier(13), id: 13, thread: "foreign-thread"),
            threadDelivery(reminderIdentifier(14), id: 14, thread: "foreign-thread")]
        await port.setDelivered(inventory); let baseline = try rows(), before = try maps()
        _ = try await value.reconcileReminders()
        let events = await port.mutations, tray = try await port.delivered(namespace: namespace)
        XCTAssertEqual(events.count, 0); XCTAssertEqual(tray, inventory); XCTAssertEqual(try maps(), before)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try collapseMarkers().count, 0); XCTAssertEqual(try markers().count, 1)
    }
    func testThreadCollapseUsesPostPermissionInventoryWithoutRemovingForeignReplacement() async throws {
        let value = try await seed(count: 0), thread = "mindwtr-reminder:PRIVATE_REMINDER_A"
        let old = threadDelivery(reminderIdentifier(11), id: 11, thread: thread, at: 10)
        let newest = threadDelivery(reminderIdentifier(12), id: 12, thread: thread, at: 20)
        await port.setDelivered([old, newest]); let reads = await port.permissionCount
        let entered = expectation(description: "Permission before fresh collapse inventory")
        await port.holdPermission(at: reads + 2, entered: entered)
        let before = try maps(), baseline = try rows(), task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let replacement = threadDelivery(old.identifier, id: old.ownedID, thread: thread, at: 30, invalid: true)
        await port.setDelivered([replacement, newest]); await port.releasePermission(); _ = try await task.value
        let events = await port.mutations, tray = try await port.delivered(namespace: namespace)
        XCTAssertEqual(events.count, 0); XCTAssertEqual(tray, [replacement, newest]); XCTAssertEqual(try maps(), before)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try collapseMarkers().count, 0)
    }
    private func interruptedThreadRemoval(close: Bool) async throws {
        let value = try await seed(count: 1); _ = try await value.reconcileReminders()
        let pending = try await port.pending(namespace: namespace), first = try XCTUnwrap(pending.first)
        let thread = "mindwtr-reminder:PRIVATE_REMINDER_A"
        let old = threadDelivery(reminderIdentifier(123), id: 123, thread: thread, at: 10)
        let newest = threadDelivery(first.identifier, id: first.ownedID, thread: thread, at: 20)
        await port.setDelivered([old, newest]); let before = try maps(), baseline = try rows(), effects = await port.mutations.count
        let entered = expectation(description: "Accepted delivered removal")
        await port.holdDeliveredRemoval(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        await unavailable { try await value.call("iosReminderPrepare") }
        if close {
            let closing = Task { await value.close() }
            for _ in 0..<20 { await Task.yield() }
            await port.releaseDeliveredRemoval(); await closing.value
        } else { task.cancel(); await port.releaseDeliveredRemoval() }
        await cancelled { try await task.value }
        let events = await port.mutations, actualPending = try await port.pending(namespace: namespace), tray = try await port.delivered(namespace: namespace)
        XCTAssertEqual(Array(events.dropFirst(effects)).map(\.operation), ["delivered-remove"])
        XCTAssertEqual(actualPending, pending); XCTAssertEqual(tray, [newest]); XCTAssertEqual(try maps(), before)
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers().count, 1); XCTAssertEqual(try collapseMarkers().count, 0)
        if !close {
            _ = try await value.reconcileReminders(); XCTAssertEqual(try markers().count, 2); XCTAssertEqual(try collapseMarkers().count, 0)
        }
    }
    func testCancelledThreadRemovalDrainsWithoutSuccessorOrConfirmedMarker() async throws {
        try await interruptedThreadRemoval(close: false)
    }
    func testCloseWaitsForAcceptedThreadRemovalAndPreservesFuturePendingRequest() async throws {
        try await interruptedThreadRemoval(close: true)
    }

    func testObserverUsesSharedDelayAndExactDisposalPreservesNewerRegistration() async throws {
        let value = try await seed(), first = ReminderWakeRecorder(), next = ReminderWakeRecorder()
        let registration = try await value.observeReminders { first.record($0) }
        XCTAssertEqual(registration.revision, 1); XCTAssertEqual(registration.rescheduleDelayMs, 2500)
        do { _ = try await value.observeReminders { _ in }; XCTFail("Duplicate observer admitted") } catch {}
        for method in ["iosReminderObserve", "iosReminderObservation", "iosReminderDisposeObservation"] {
            await unavailable { try await value.call(method) }
        }
        _ = try await value.call("language", argumentsJSON: json(["de", "en"]))
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(first.events.map(\.0), ["source"])
        await value.removeReminderObserver(registration.id)
        let replacement = try await value.observeReminders { next.record($0) }
        XCTAssertGreaterThan(replacement.revision, registration.revision)
        await value.removeReminderObserver(registration.id)
        _ = try await value.call("language", argumentsJSON: json(["fr", "en"]))
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(first.events.count, 1); XCTAssertEqual(next.events.map(\.0), ["source"])
        await value.removeReminderObserver(replacement.id)
        _ = try await value.call("language", argumentsJSON: json(["en", "en"]))
        XCTAssertEqual(next.events.count, 1)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
    }

    func testObserverReportsSavedTaskMutationWithoutReadOrUnchangedLanguageNoise() async throws {
        let value = try await seed(), recorder = ReminderWakeRecorder()
        _ = try await value.call("language", argumentsJSON: json(["en", "en"]))
        let registration = try await value.observeReminders { recorder.record($0) }
        _ = try await value.call("complete", argumentsJSON: json(["task-0"]))
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.map(\.0), ["source"])
        XCTAssertGreaterThan(try XCTUnwrap(recorder.events.last?.1), registration.revision)
        let selected = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT status FROM tasks WHERE id='task-0'").utf8)) as? [[String: Any]])
        XCTAssertEqual(selected.first?["status"] as? String, "done")
        for _ in 0..<5 {
            _ = try await value.readAboutUpdateState()
            _ = try await value.call("language", argumentsJSON: json(["en", "en"]))
        }
        XCTAssertEqual(recorder.events.count, 1)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
    }

    func testObserverInstalledBeforeHeldPermissionDoesNotSpinAfterOwnAddFailure() async throws {
        let value = try await seed(), recorder = ReminderWakeRecorder(), entered = expectation(description: "First passive permission held")
        _ = try await value.observeReminders { recorder.record($0) }
        await port.configure(failAdd: 1); await port.holdPermission(at: 1, entered: entered)
        let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        await unavailable { try await value.call("iosReminderPrepare") }
        XCTAssertEqual(recorder.events.count, 0)
        await port.releasePermission(); await unavailable { try await task.value }
        for _ in 0..<5 { _ = try await value.readAboutUpdateState() }
        XCTAssertEqual(recorder.events.count, 0)
        let reads = await port.permissionCount, effects = await port.addCount
        XCTAssertGreaterThan(reads, 0); XCTAssertEqual(effects, 1)
        _ = try await value.call("language", argumentsJSON: json(["de", "en"]))
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.map(\.0), ["source"])
        await port.configure(); _ = try await value.reconcileReminders()
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.count, 1)
    }

    func testObserverWakesAfterExactReceiptRetiresFollowingItsLastJSInvocation() async throws {
        let initial = try await seed(); await initial.close()
        let fault = ReminderJournalClearFault(), value = host(io: { $0.journalRemove = { try fault.before() } })
        _ = try await value.start()
        let recorder = ReminderWakeRecorder(); _ = try await value.observeReminders { recorder.record($0) }
        fault.enable(true)
        do { _ = try await value.call("complete", argumentsJSON: json(["task-0"])); XCTFail("Expected retained receipt") } catch {}
        _ = try? await value.readAboutUpdateState() // Queue barrier while the retained owner still refuses reads.
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        XCTAssertEqual(recorder.events.map(\.0), ["source"])
        let revision = try XCTUnwrap(recorder.events.last?.1), baseline = try rows()
        fault.enable(false)
        let reply = try await value.retryPending(); XCTAssertNotNil(reply)
        _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.map(\.0), ["source", "ready"])
        XCTAssertEqual(recorder.events.last?.1, revision)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        XCTAssertEqual(try rows(), baseline)
        for _ in 0..<5 { _ = try await value.readAboutUpdateState() }
        XCTAssertEqual(recorder.events.count, 2)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
    }

    func testConfirmedTopUpDeadlineDoesNotExtendByHeldOSCallbackLatency() async throws {
        let value = try await seed(), previewStarted = Date().timeIntervalSince1970 * 1000
        let preview = try object(try await value.readReminderPlan()), plan = try XCTUnwrap(preview["plan"] as? [String: Any])
        let delay = try XCTUnwrap(plan["topUpDelayMs"] as? Double)
        let entered = expectation(description: "OS add holds confirmed result")
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        // A real held callback spans a controlled second; the shared deadline was already planned.
        try await Task.sleep(nanoseconds: 1_000_000_000)
        await port.releaseAdd(); let result = try object(try await task.value)
        let deadline = try XCTUnwrap(result["topUpAtMs"] as? NSNumber)
        XCTAssertNotEqual(CFGetTypeID(deadline), CFBooleanGetTypeID())
        XCTAssertTrue(deadline.doubleValue.isFinite); XCTAssertEqual(deadline.doubleValue.rounded(), deadline.doubleValue)
        XCTAssertLessThanOrEqual(deadline.doubleValue, previewStarted + delay + 500)
        let baseline = try rows(); await value.close()
        let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), baseline)
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending.count, 2)
    }

    func testObserverCloseDetachesCallbacksAndPreservesAcceptedFutureRequest() async throws {
        let value = try await seed(), recorder = ReminderWakeRecorder(), entered = expectation(description: "Accepted add before observed close")
        _ = try await value.observeReminders { recorder.record($0) }
        await port.holdAdd(entered); let task = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let closing = Task { await value.close() }
        for _ in 0..<20 { await Task.yield() }
        await port.releaseAdd(); await closing.value; await cancelled { try await task.value }
        XCTAssertEqual(recorder.events.count, 0)
        let pending = try await port.pending(namespace: namespace), effects = await port.mutations
        XCTAssertEqual(pending.count, 1); XCTAssertEqual(effects.map(\.operation), ["add"])
        do { _ = try await value.observeReminders { recorder.record($0) }; XCTFail("Closed observer admitted") } catch {}
        XCTAssertEqual(recorder.events.count, 0)
    }


    func testPostPerformReleaseRearmsActualJSTimerAndIdlePumpDeliversSourceWithoutAnotherCall() async throws {
        let initial = try await seed(); await initial.close()
        // Test-local derived bundle only: the original command/production bundle are unchanged.
        // complete's pending receipt blocks invoke's idle scheduling; its later retirement must re-arm this timer.
        var bytes = try Data(contentsOf: bundle)
        bytes.append(Data(#"""
        ;(() => {
            const complete = MindwtrHost.complete;
            MindwtrHost.complete = function(...args) {
                setTimeout(() => MindwtrHost.language('fr', 'en'), 1000);
                return complete.apply(this, args);
            };
        })();
        """#.utf8))
        let privateBundle = root.appendingPathComponent("timer-observation-core-host.js")
        try bytes.write(to: privateBundle)
        let value = host(coreBundle: privateBundle); _ = try await value.start()
        _ = try await value.call("language", argumentsJSON: json(["en", "en"]))
        let recorder = ReminderWakeRecorder(), timer = expectation(description: "Actual idle JS timer source wake")
        _ = try await value.observeReminders { event in
            recorder.record(event)
            if recorder.events.count == 2 { timer.fulfill() }
        }
        _ = try await value.call("complete", argumentsJSON: json(["task-0"]))
        // There is intentionally no later host operation to rescue a stranded timer.
        await fulfillment(of: [timer], timeout: 5)
        XCTAssertEqual(recorder.events.map(\.0), ["source", "source"])
        XCTAssertGreaterThan(try XCTUnwrap(recorder.events.last?.1), try XCTUnwrap(recorder.events.first?.1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
        XCTAssertEqual(try markers().count, 0)
    }


    func testOrdinaryGeneralPreferencePreemptsHeldReminderWithoutUncertainSaveAndRetainsOneWake() async throws {
        let value = try await seed(), options = try object(try await value.call("generalPreferenceOptions", argumentsJSON: json(["{}"])))
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        let input: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "edit": ["type": "dateFormat", "value": "ymd"],
            "expected": try XCTUnwrap(expected["dateFormat"])]
        let baseline = try rows(), other = try saved().filter { ![alarmName, stateName].contains($0.key) }
        let recorder = ReminderWakeRecorder(), registration = try await value.observeReminders { recorder.record($0) }
        let entered = expectation(description: "Held reminder before actual preference write")
        await port.holdAdd(entered); let reminder = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let writing = Task { try await value.call("generalPreference", argumentsJSON: json([json(input)])) }
        for _ in 0..<100 { await Task.yield() }
        XCTAssertEqual(try rows(), baseline)
        await port.releaseAdd(); await cancelled { try await reminder.value }
        let result = try object(try await writing.value)
        XCTAssertEqual(result["type"] as? String, "dateFormat"); XCTAssertEqual(result["value"] as? String, "ymd")
        XCTAssertEqual(result["changed"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let after = try rows(); XCTAssertEqual(after["tasks"], baseline["tasks"]); XCTAssertEqual(after["projects"], baseline["projects"])
        XCTAssertEqual(try saved().filter { ![alarmName, stateName].contains($0.key) }, other)
        XCTAssertEqual(try markers().count, 0)
        for _ in 0..<5 { _ = try await value.readAboutUpdateState() }
        XCTAssertEqual(recorder.events.map(\.0), ["source"])
        XCTAssertGreaterThan(try XCTUnwrap(recorder.events.last?.1), registration.revision)
        _ = try await value.reconcileReminders(); _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.count, 1); XCTAssertEqual(try markers().count, 1)
    }

    func testDirectReadAndAttachmentFacadesDrainReminderBeforeOriginalAdmission() async throws {
        let value = try await seed(), baseline = try rows(), before = try Data(contentsOf: manifest)
        for attachment in [false, true] {
            let reads = await port.permissionCount, entered = expectation(description: "Held permission before direct facade")
            await port.holdPermission(at: reads + 1, entered: entered)
            let reminder = Task { try await value.reconcileReminders() }; await fulfillment(of: [entered], timeout: 5)
            let ordinary = Task { () -> String in
                if attachment { return try await value.prepareProjectFileOpen(requestJSON: "{}") }
                return try await value.readAboutUpdateState()
            }
            for _ in 0..<100 { await Task.yield() }
            await port.releasePermission(); await cancelled { try await reminder.value }
            if attachment {
                do { _ = try await ordinary.value; XCTFail("Invalid original file request admitted") }
                catch { XCTAssertNotEqual(error.localizedDescription, "NOT_READY: Reminder reconciliation is unavailable") }
            } else {
                let result = try object(try await ordinary.value); XCTAssertEqual(Set(result.keys), Set(["updateAvailable", "shouldCheck"]))
            }
            XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), before)
        }
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0); XCTAssertEqual(try markers().count, 0)
        _ = try await value.reconcileReminders() // Both reservations released after success and original admission failure.
    }

    func testCancelledOrdinaryWaiterCannotWriteAndReleasesReservationAfterReminderDrain() async throws {
        let value = try await seed(), baseline = try rows(), entered = expectation(description: "Held add before cancelled ordinary waiter")
        await port.holdAdd(entered); let reminder = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let writing = Task { try await value.call("complete", argumentsJSON: json(["task-0"])) }
        for _ in 0..<100 { await Task.yield() }
        writing.cancel(); await port.releaseAdd(); await cancelled { try await reminder.value }
        await cancelled { try await writing.value }
        XCTAssertEqual(try rows(), baseline)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        XCTAssertEqual(try markers().count, 0)
        _ = try await value.readAboutUpdateState(); _ = try await value.reconcileReminders()
        XCTAssertEqual(try markers().count, 1)
    }

    func testCloseCancelsUnadmittedOrdinaryWaiterWithoutWritingOrLeakingReservation() async throws {
        let value = try await seed(), baseline = try rows(), entered = expectation(description: "Held add before closing queued ordinary work")
        await port.holdAdd(entered); let reminder = Task { try await value.reconcileReminders() }
        await fulfillment(of: [entered], timeout: 5)
        let writing = Task { try await value.call("complete", argumentsJSON: json(["task-0"])) }
        for _ in 0..<100 { await Task.yield() }
        let closing = Task { await value.close() }
        for _ in 0..<100 { await Task.yield() }
        await port.releaseAdd(); await closing.value; await cancelled { try await reminder.value }; await cancelled { try await writing.value }
        XCTAssertEqual(try rows(), baseline)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let pending = try await port.pending(namespace: namespace); XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(try markers().count, 0)
    }

    func testReminderBeginBlockedByHeldOrdinaryWriteReceivesOneReadyWakeAfterRelease() async throws {
        let initial = try await seed(); await initial.close()
        let entered = expectation(description: "Ordinary reservation held before final readiness snapshot")
        let hold = ReminderOrdinaryWriteHold(entered)
        let value = host(configure: { store in store.faults.beforePromotion = { try hold.before() } })
        _ = try await value.start()
        let recorder = ReminderWakeRecorder(), registration = try await value.observeReminders { recorder.record($0) }
        let baseline = try rows()
        hold.arm(); defer { hold.release() }
        let writing = Task { try await value.recordAboutUpdateCheck(timestamp: "1") }
        await fulfillment(of: [entered], timeout: 5)
        // begin runs before queued Engine work; no observation has seen a transient reservation.
        await unavailable { try await value.reconcileReminders() }
        XCTAssertEqual(recorder.events.count, 0)
        let effects = await port.mutations; XCTAssertEqual(effects.count, 0)
        hold.release(); try await writing.value
        for _ in 0..<5 { _ = try await value.readAboutUpdateState() }
        XCTAssertEqual(recorder.events.map(\.0), ["ready"])
        XCTAssertEqual(recorder.events.first?.1, registration.revision)
        XCTAssertEqual(try saved()["mindwtr-update-last-check"], "1")
        XCTAssertEqual(try rows(), baseline)
        _ = try await value.reconcileReminders(); _ = try await value.readAboutUpdateState()
        XCTAssertEqual(recorder.events.count, 1); XCTAssertEqual(try markers().count, 1)
    }

}
