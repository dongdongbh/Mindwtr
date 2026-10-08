import Darwin
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
    private func host(configure: ((NativeDeviceKV) -> Void)? = nil) -> CoreHost {
        let faults = HostIOFaults(), captured = port!; faults.reminderPort = captured; faults.configureDeviceStorage = configure
        faults.notificationPermissionRead = { try await captured.permission() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReminderEffectsForbiddenHTTP.self]; faults.httpConfiguration = config
        faults.secretBeforeOperation = { _, _ in XCTFail("Reminder effects must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Reminder effects must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
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
        XCTAssertEqual(Set(result.keys), Set(["mode", "scheduled", "cancelled"])); XCTAssertEqual(result["mode"] as? String, "active")
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
        do { try await value.recordAboutUpdateCheck(timestamp: "1"); XCTFail("Competing storage writer was admitted") } catch {}
        let count = await port.addCount; XCTAssertEqual(count, 1)
        await port.releaseAdd(); _ = try await task.value
        let final = await port.addCount; XCTAssertEqual(final, 2)
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
}
