import Darwin
import Foundation
import Security
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

private actor ReminderPermissionRead {
    var calls = 0
    private var answer = NativeNotificationPermission.observed(status: .authorized, alertEnabled: true)
    private var failure = false
    private var entered: XCTestExpectation?
    private var continuation: CheckedContinuation<NativeNotificationPermission, Never>?
    func configure(_ status: UNAuthorizationStatus, alerts: Bool = true, fail: Bool = false) {
        answer = .observed(status: status, alertEnabled: alerts); failure = fail
    }
    func hold(_ expectation: XCTestExpectation) { entered = expectation }
    func read() async throws -> NativeNotificationPermission {
        calls += 1
        if failure { throw HostFailure("Synthetic private permission failure") }
        if let entered {
            self.entered = nil
            return await withCheckedContinuation { continuation in
                self.continuation = continuation; entered.fulfill()
            }
        }
        return answer
    }
    func release() { continuation?.resume(returning: answer); continuation = nil }
}

/// No URL may escape interception. Passive planning has no HTTP/credential/crypto effects.
private final class ReminderForbiddenHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Reminder preview must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

final class ReminderPlanHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace: String!, permission: ReminderPermissionRead!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private var logURL: URL { root.appendingPathComponent("logs/mindwtr.log") }
    private let alarmMap = "mindwtr:local:alarms:v1", nativeState = "mindwtr:native:reminders:v1"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured reminder bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderPlanHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Reminder fixture directory is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.example.mindwtr.reminder." + UUID().uuidString.lowercased()
        permission = ReminderPermissionRead()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "reminder-unknown": "Preserve exact preferences 文", alarmMap: "{}", nativeState: "{}"] as [String: String]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func host() -> CoreHost {
        let faults = HostIOFaults(), reader = permission!
        faults.notificationPermissionRead = { try await reader.read() }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ReminderForbiddenHTTP.self]
        faults.httpConfiguration = configuration
        faults.secretBeforeOperation = { _, _ in XCTFail("Reminder preview must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Reminder preview must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func seededHost() async throws -> CoreHost {
        let initial = host(); _ = try await initial.start(); await initial.close()
        do {
            let sql = try SQLiteBridge(url: database); defer { sql.close() }
            let stamp = ISO8601DateFormatter(), now = Date(), at = stamp.string(from: now)
            // Reverse insertion order proves earliest-date selection, including Waiting/Someday.
            for index in (0..<205).reversed() {
                let due = stamp.string(from: now.addingTimeInterval(3600 + Double(index) * 60))
                _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,dueDate,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,?,'[]','[]',?,?,?,3,'fixture',0,0,0,0)", parametersJSON: json(["cap-\(index)", "Private reminder \(index)", index % 2 == 0 ? "waiting" : "someday", due, at, at]))
            }
            let settings = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
            var data = try object(try XCTUnwrap(settings.first?["data"] as? String))
            data["notificationsEnabled"] = true; data["dueDateNotificationsEnabled"] = true
            data["dailyDigestMorningEnabled"] = true; data["dailyDigestEveningEnabled"] = true; data["weeklyReviewEnabled"] = true
            _ = try sql.execute("UPDATE settings SET data=? WHERE id=1", parametersJSON: json([json(data)]))
        }
        let value = host(); _ = try await value.start(); return value
    }
    /// Canonical outer SQL formatting preserves each cell's exact bytes and SQLite storage type.
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func preserved(_ baseline: [String: String], _ bytes: Data) throws {
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        for directory in ["attachment-files/documents", "attachment-files/cache"] {
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(directory).path), [])
        }
    }
    private func markers() throws -> [[String: Any]] {
        let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        XCTAssertFalse(log.contains("Private reminder")); XCTAssertFalse(log.contains("task:cap-"))
        let entries = try log.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-plan") }.map { try object(String($0)) }
        for entry in entries {
            XCTAssertEqual(Set(entry.keys), Set(["ts", "level", "scope", "message", "context"]))
            XCTAssertEqual(entry["message"] as? String, "Native iOS reminder plan inspected")
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-reminder-plan", "outcome": "planned"])
        }
        return entries
    }
    private func envelope(_ raw: String) throws -> (permission: [String: Any], plan: [String: Any]) {
        let value = try object(raw); XCTAssertEqual(Set(value.keys), Set(["permission", "plan"]))
        let permission = try XCTUnwrap(value["permission"] as? [String: Any]); XCTAssertEqual(Set(permission.keys), Set(["status", "granted", "canAskAgain"]))
        return (permission, try XCTUnwrap(value["plan"] as? [String: Any]))
    }
    private func unavailable(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected fixed reminder refusal") }
        catch { XCTAssertEqual(error.localizedDescription, "NOT_READY: Reminder plan is unavailable") }
    }
    private func cancelled(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected reminder cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testPassivePermissionMappingRequiresKnownStatusAndEnabledAlerts() {
        let states: [(UNAuthorizationStatus, String, Bool)] = [(.notDetermined, "not-determined", false), (.denied, "denied", false),
            (.authorized, "authorized", true), (.provisional, "provisional", true), (UNAuthorizationStatus(rawValue: 999)!, "unavailable", false)]
        for (status, name, canGrant) in states {
            for alerts in [false, true] {
                let result = NativeNotificationPermission.observed(status: status, alertEnabled: alerts)
                XCTAssertEqual(result.status, name); XCTAssertEqual(result.granted, canGrant && alerts)
                XCTAssertEqual(result.canAskAgain, status == .notDetermined)
            }
        }
        #if os(iOS)
        XCTAssertEqual(NativeNotificationPermission.observed(status: .ephemeral, alertEnabled: true).status, "ephemeral")
        XCTAssertTrue(NativeNotificationPermission.observed(status: .ephemeral, alertEnabled: true).granted)
        XCTAssertFalse(NativeNotificationPermission.observed(status: .ephemeral, alertEnabled: false).granted)
        #endif
    }
    func testActualIOSPlanUsesSavedMapsEarliest60AndIndependentRecurringWithoutEffects() async throws {
        let value = try await seededHost(), baseline = try rows(), before = try Data(contentsOf: manifest)
        let first = try envelope(try await value.readReminderPlan())
        XCTAssertEqual(first.permission["status"] as? String, "authorized"); XCTAssertEqual(first.permission["granted"] as? Bool, true); XCTAssertEqual(first.permission["canAskAgain"] as? Bool, false)
        let schedule = try XCTUnwrap(first.plan["schedule"] as? [[String: Any]])
        XCTAssertEqual(schedule.filter { $0["repeat"] as? String == "once" }.compactMap { $0["key"] as? String }, (0..<60).map { "task:cap-\($0)" })
        XCTAssertEqual(schedule.filter { $0["repeat"] as? String != "once" }.compactMap { $0["repeat"] as? String }, ["daily", "daily", "weekly"])
        XCTAssertGreaterThan(try XCTUnwrap(first.plan["topUpDelayMs"] as? Double), 0)
        try preserved(baseline, before); XCTAssertEqual(try markers().count, 1)
        await value.close()
        var saved = try object(String(decoding: before, as: UTF8.self)); saved[alarmMap] = first.plan["alarms"]; saved[nativeState] = first.plan["state"]
        let bytes = Data(try json(saved).utf8); try bytes.write(to: manifest, options: .atomic)
        let cold = host(); _ = try await cold.start(); let coldBaseline = try rows()
        let next = try envelope(try await cold.readReminderPlan())
        XCTAssertEqual((next.plan["schedule"] as? [Any])?.count, 0); XCTAssertEqual((next.plan["cancel"] as? [Any])?.count, 0)
        XCTAssertEqual(next.plan["alarms"] as? String, first.plan["alarms"] as? String)
        try preserved(coldBaseline, bytes); XCTAssertEqual(try markers().count, 2)
    }
    func testMalformedMapsKeepSharedPreviewBytesAndDeniedPermissionHasNoEffects() async throws {
        let initial = try await seededHost(); await initial.close()
        for (alarms, state) in [("{not json", "{bad state"), ("{\"foreign\":{\"id\":\"bad\"}}", "{\"bad\":{\"kind\":\"snooze\",\"id\":null}}") ] {
            var saved = try object(String(contentsOf: manifest, encoding: .utf8)); saved[alarmMap] = alarms; saved[nativeState] = state
            let bytes = Data(try json(saved).utf8); try bytes.write(to: manifest, options: .atomic)
            let value = host(); _ = try await value.start(); let baseline = try rows()
            let result = try envelope(try await value.readReminderPlan())
            XCTAssertEqual((result.plan["schedule"] as? [[String: Any]])?.filter { $0["repeat"] as? String == "once" }.count, 60)
            try preserved(baseline, bytes)
            await permission.configure(.denied)
            let denied = try envelope(try await value.readReminderPlan())
            XCTAssertEqual(denied.permission["granted"] as? Bool, false); XCTAssertEqual(denied.permission["canAskAgain"] as? Bool, false)
            XCTAssertEqual(denied.plan["mode"] as? String, "revoked"); XCTAssertEqual((denied.plan["schedule"] as? [Any])?.count, 0)
            try preserved(baseline, bytes); await value.close(); await permission.configure(.authorized)
        }
    }
    func testUnstartedPrecancelledAndClosedReadsNeverObservePermissionOrPublish() async throws {
        let value = host(), bytes = try Data(contentsOf: manifest)
        await unavailable { try await value.readReminderPlan() }
        let entered = expectation(description: "Task body entered"), release = DispatchSemaphore(value: 0)
        let task = Task.detached { () throws -> String in
            entered.fulfill(); _ = release.wait(timeout: .now() + 5); return try await value.readReminderPlan()
        }
        await fulfillment(of: [entered], timeout: 5); task.cancel(); release.signal()
        await cancelled { try await task.value }
        await value.close(); await cancelled { try await value.readReminderPlan() }
        let calls = await permission.calls; XCTAssertEqual(calls, 0)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try markers().count, 0)
    }
    func testPermissionReadFailureIsFixedAndPreservesAllStorage() async throws {
        let value = try await seededHost(), baseline = try rows(), bytes = try Data(contentsOf: manifest)
        await permission.configure(.authorized, fail: true)
        await unavailable { try await value.readReminderPlan() }
        try preserved(baseline, bytes); XCTAssertEqual(try markers().count, 0)
    }
    func testAwaitedPermissionDoesNotBlockEngineAndCancellationAllowsFreshRead() async throws {
        let value = try await seededHost(), baseline = try rows(), bytes = try Data(contentsOf: manifest)
        let entered = expectation(description: "Passive read held"); await permission.hold(entered)
        let pending = Task { try await value.readReminderPlan() }
        await fulfillment(of: [entered], timeout: 5)
        // This serialized command must finish while the OS-style callback is suspended.
        let state = try await value.readAboutUpdateState(); XCTAssertNotNil(try object(state)["shouldCheck"])
        pending.cancel(); await permission.release(); await cancelled { try await pending.value }
        try preserved(baseline, bytes); XCTAssertEqual(try markers().count, 0)
        _ = try await value.readReminderPlan(); try preserved(baseline, bytes); XCTAssertEqual(try markers().count, 1)
    }
    func testCloseWhilePermissionIsHeldRefusesOldResultAndFreshHostCanPlan() async throws {
        let old = try await seededHost(), bytes = try Data(contentsOf: manifest)
        let entered = expectation(description: "Old passive read held"); await permission.hold(entered)
        let pending = Task { try await old.readReminderPlan() }; await fulfillment(of: [entered], timeout: 5)
        await old.close()
        let fresh = host(); _ = try await fresh.start(); let baseline = try rows()
        _ = try await fresh.readReminderPlan(); XCTAssertEqual(try markers().count, 1)
        await permission.release(); await cancelled { try await pending.value }
        try preserved(baseline, bytes); XCTAssertEqual(try markers().count, 1)
    }
    func testNamespaceReplacementDuringPermissionReadRefusesWithoutOverwritingExternalBytes() async throws {
        let value = try await seededHost(), baseline = try rows()
        let entered = expectation(description: "Passive read held before namespace replacement"); await permission.hold(entered)
        let pending = Task { try await value.readReminderPlan() }; await fulfillment(of: [entered], timeout: 5)
        var external = try object(String(contentsOf: manifest, encoding: .utf8)); external["reminder-unknown"] = "External exact preserved preferences 文"
        let bytes = Data(try json(external).utf8); try bytes.write(to: manifest, options: .atomic)
        await permission.release(); await unavailable { try await pending.value }
        try preserved(baseline, bytes); XCTAssertEqual(try markers().count, 0)
        await value.close()
        let fresh = host(); _ = try await fresh.start(); let coldBaseline = try rows()
        _ = try await fresh.readReminderPlan(); try preserved(coldBaseline, bytes); XCTAssertEqual(try markers().count, 1)
    }
}
