import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private actor NotificationSettingsPermissionPort {
    private var granted = true
    private var refusal = false
    private var entered: XCTestExpectation?
    private var held: CheckedContinuation<Void, Never>?
    private var readEntered: XCTestExpectation?
    private var heldRead: CheckedContinuation<Void, Never>?
    private var requests = 0, reads = 0
    func configure(granted: Bool = true, refusal: Bool = false) { self.granted = granted; self.refusal = refusal }
    func hold(_ entered: XCTestExpectation) { self.entered = entered }
    func release() { held?.resume(); held = nil }
    func holdRead(_ entered: XCTestExpectation) { readEntered = entered }
    func releaseRead() { heldRead?.resume(); heldRead = nil }
    func request() async throws {
        requests += 1
        if let entered {
            self.entered = nil
            await withCheckedContinuation { held = $0; entered.fulfill() }
        }
        if refusal { throw HostFailure("PRIVATE_NOTIFICATION_AUTHORIZATION_ERROR") }
    }
    func read() async -> NativeNotificationPermission {
        reads += 1
        if let readEntered {
            self.readEntered = nil
            await withCheckedContinuation { heldRead = $0; readEntered.fulfill() }
        }
        return .init(status: granted ? "authorized" : "denied", granted: granted, canAskAgain: false)
    }
    func counts() -> [Int] { [requests, reads] }
}

private actor NotificationSettingsReadmissionGate {
    private var cancelled = false
    private var active: Bool
    private var held: CheckedContinuation<Bool, Never>?
    let entered: XCTestExpectation
    init(_ entered: XCTestExpectation, active: Bool = false) { self.entered = entered; self.active = active }
    func setActive(_ value: Bool) {
        active = value
        if value { held?.resume(returning: true); held = nil }
    }
    func wait() async -> Bool {
        await withTaskCancellationHandler {
            if Task.isCancelled || cancelled { return false }
            if active { return true }
            return await withCheckedContinuation { continuation in
                if cancelled { continuation.resume(returning: false) }
                else { held = continuation; entered.fulfill() }
            }
        } onCancel: { Task { await self.cancel() } }
    }
    func cancel() { cancelled = true; held?.resume(returning: false); held = nil }
}

private final class NotificationSettingsIO: @unchecked Sendable {
    private let lock = NSLock()
    private var commitFailure = false, removeFailure = false
    private var statements: [String] = [], journalWrites = 0, commitFailures = 0
    private var completed = false
    private var selectCallback: (@Sendable () -> Void)?
    func failCommit(_ value: Bool) { lock.lock(); commitFailure = value; lock.unlock() }
    func failRemove(_ value: Bool) { lock.lock(); removeFailure = value; lock.unlock() }
    func reset() { lock.lock(); statements = []; journalWrites = 0; commitFailures = 0; lock.unlock() }
    func beforeSQL(_ text: String) throws {
        lock.lock(); statements.append(text)
        let callback = text.hasPrefix("SELECT") ? selectCallback : nil
        if callback != nil { selectCallback = nil }
        let failure = text == "COMMIT" && commitFailure
        if failure { commitFailures += 1 }
        lock.unlock(); callback?()
        if failure { throw HostFailure("PRIVATE_NOTIFICATION_COMMIT_ERROR") }
    }
    func onNextSelect(_ callback: @escaping @Sendable () -> Void) { lock.lock(); selectCallback = callback; lock.unlock() }
    func beforeJournal() { lock.lock(); journalWrites += 1; lock.unlock() }
    func beforeRemove() throws {
        lock.lock(); defer { lock.unlock() }
        if removeFailure { throw HostFailure("PRIVATE_NOTIFICATION_CLEAR_ERROR") }
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [statements.count, journalWrites, commitFailures] }
    var writeCounts: [Int] {
        lock.lock(); defer { lock.unlock() }
        let mutations = statements.filter { text in
            let verb = text.split(whereSeparator: { $0.isWhitespace }).first?.uppercased() ?? ""
            return ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK", "VACUUM"].contains(verb)
        }.count
        return [mutations, journalWrites, commitFailures]
    }
    func closeCompleted() { lock.lock(); completed = true; lock.unlock() }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return completed }
}

private final class NotificationSettingsNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Notification Settings must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

final class NativeNotificationSettingsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, port: NotificationSettingsPermissionPort!
    private let namespace = "tech.example.mindwtr.notification-settings"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Notification Settings fixture bundle unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("NativeNotificationSettingsHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Notification Settings fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown-notification-preference": "PRIVATE_PREFERENCE 文",
            "mindwtr:local:alarms:v1": "{}", "mindwtr:native:reminders:v1": "{}"]).utf8).write(to: manifest)
        port = NotificationSettingsPermissionPort()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func host(_ io: NotificationSettingsIO = NotificationSettingsIO(), coreBundle: URL? = nil) -> CoreHost {
        let faults = HostIOFaults(), captured = port!
        faults.notificationAuthorizationRequest = { try await captured.request() }
        faults.notificationPermissionRead = { await captured.read() }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NotificationSettingsNoHTTP.self]; faults.httpConfiguration = config
        faults.secretBeforeOperation = { _, _ in XCTFail("Notification Settings must not access credentials") }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Notification Settings must not access crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: coreBundle ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func request(_ core: CoreHost, type: String = "notificationsEnabled", value: Any) async throws -> String {
        let options = try object(await core.readNotificationSettingsOptions())
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        return try json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": type, "value": value], "expected": try XCTUnwrap(expected[type])])
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func settings() throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
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
    private func markers() throws -> [[String: Any]] {
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(text.contains("PRIVATE_")); XCTAssertFalse(text.contains(namespace))
        return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-notification-setting") }.map {
            let entry = try object(String($0))
            XCTAssertEqual(entry["message"] as? String, "Native iOS notification setting saved")
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-notification-setting", "outcome": "saved"])
            return entry
        }
    }
    private func rejected(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected definite refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected error: \(type(of: error))") }
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained save uncertainty") }
        catch { XCTAssertTrue(error is HostFailure, "Unexpected error: \(type(of: error))") }
    }
    private func permissionCounts(_ expected: [Int], file: StaticString = #filePath, line: UInt = #line) async {
        let actual = await port.counts(); XCTAssertEqual(actual, expected, file: file, line: line)
    }

    func testClosedBoundaryAndProjectionNeverWriteOrPrompt() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start(); io.reset()
        let before = try rows(), local = try Data(contentsOf: manifest)
        let options = try object(await core.readNotificationSettingsOptions())
        XCTAssertEqual((options["expected"] as? [String: Any])?.count, 10)
        let raw = try await request(core, value: true), original = try object(raw)
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); io.reset()
        var hinted = original; hinted["permissionGranted"] = true
        var numeric = original; numeric["edit"] = ["type": "notificationsEnabled", "value": 1]
        var booleanDay = original; booleanDay["edit"] = ["type": "weeklyReviewDay", "value": true]
        var badTime = original; badTime["edit"] = ["type": "weeklyReviewTime", "value": "9:00"]
        var large = original; large["expected"] = ["present": true, "value": String(repeating: "x", count: 1025)]
        for input in [hinted, numeric, booleanDay, badTime, large] {
            await rejected { try await core.setNotificationSetting(requestJSON: json(input), readmission: { true }) }
        }
        for method in ["notificationSetting", "notificationSettingOptions", "notificationSettingPrepare", "notificationSettingValidate",
                       "notificationSettingCommit", "notificationSettingRetryOutcome", "notificationSettingAcknowledged"] {
            await rejected { try await core.call(method, argumentsJSON: json([raw])) }
        }
        XCTAssertEqual(io.counts, [0, 0, 0]); await permissionCounts([0, 0])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), local)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
    }

    func testObservedDenialAndAuthorizationErrorAreDefiniteBeforeJournal() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let before = try rows(), local = try Data(contentsOf: manifest), raw = try await request(core, value: true)
        io.reset(); await port.configure(granted: false)
        await rejected { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await permissionCounts([1, 1]); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        await port.configure(refusal: true)
        await rejected { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await permissionCounts([2, 1]); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), local)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
    }

    func testEnableUsesObservedGrantButOffTimeAndDayNeverPrompt() async throws {
        let core = host(); _ = try await core.start()
        let raw = try await request(core, value: true)
        let enabled = try object(await core.setNotificationSetting(requestJSON: raw, readmission: { true }))
        XCTAssertEqual(enabled["changed"] as? Bool, true)
        await permissionCounts([1, 1]); XCTAssertEqual(try markers().count, 1)
        for (type, value) in [("notificationsEnabled", false as Any), ("weeklyReviewTime", "09:31"), ("weeklyReviewDay", 2),
                              ("dailyDigestMorningTime", "07:32"), ("dailyDigestEveningTime", "21:33")] {
            let edit = try await request(core, type: type, value: value)
            _ = try await core.setNotificationSetting(requestJSON: edit, readmission: { true })
            XCTAssertEqual(try json(["value": XCTUnwrap(settings()[type])]), try json(["value": value]))
        }
        await permissionCounts([1, 1]); XCTAssertEqual(try markers().count, 6)
        let count = try markers().count, noop = try await request(core, type: "weeklyReviewDay", value: 2)
        let unchanged = try object(await core.setNotificationSetting(requestJSON: noop, readmission: { true }))
        XCTAssertEqual(unchanged["changed"] as? Bool, false)
        XCTAssertEqual(try markers().count, count)
    }

    func testHeldAcceptedCallbackCancellationBlocksSecondEditAndCloseDrains() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), before = try rows()
        let entered = expectation(description: "accepted authorization callback"); await port.hold(entered); io.reset()
        let edit = Task { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await fulfillment(of: [entered], timeout: 3); edit.cancel()
        await rejected { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await rejected { try await core.call("generalPreferenceOptions", argumentsJSON: "[\"{}\"]") }
        let close = Task { await core.close(); io.closeCompleted() }
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertFalse(io.isClosed); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        await port.release(); await rejected { try await edit.value }; await close.value
        XCTAssertTrue(io.isClosed); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testCloseCancelsSuspendedReadmissionWithoutFutureActiveEvent() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), before = try rows(), entered = expectation(description: "readmission suspended")
        let reader = expectation(description: "passive permission callback held")
        await port.holdRead(reader)
        let gate = NotificationSettingsReadmissionGate(entered, active: true); io.reset()
        let edit = Task { try await core.setNotificationSetting(requestJSON: raw, readmission: { await gate.wait() }) }
        await fulfillment(of: [reader], timeout: 3)
        await gate.setActive(false); await port.releaseRead()
        await fulfillment(of: [entered], timeout: 3)
        let closed = expectation(description: "close drains cancelled readmission")
        let close = Task { await core.close(); closed.fulfill() }
        await fulfillment(of: [closed], timeout: 3); await close.value
        await rejected { try await edit.value }
        await permissionCounts([1, 1]); XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
    }

    func testPassivePermissionCallbackWaitsForRenewedActiveReadmissionBeforeSaving() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), before = try rows()
        let reader = expectation(description: "passive permission callback held"), entered = expectation(description: "renewed active readmission required")
        await port.holdRead(reader)
        let gate = NotificationSettingsReadmissionGate(entered, active: true); io.reset()
        let edit = Task { try await core.setNotificationSetting(requestJSON: raw, readmission: { await gate.wait() }) }
        await fulfillment(of: [reader], timeout: 3)
        await gate.setActive(false); await port.releaseRead()
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try rows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
        await gate.setActive(true)
        let saved = try object(await edit.value)
        XCTAssertEqual(saved["changed"] as? Bool, true); XCTAssertEqual(try settings()["notificationsEnabled"] as? Bool, true)
        await permissionCounts([1, 1]); XCTAssertEqual(try markers().count, 1)
    }

    func testCommitFailureRetainsExactRequestAndWarmRetryDoesNotReprompt() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), before = try rows(); io.reset(); io.failCommit(true)
        await uncertain { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        XCTAssertGreaterThan(io.counts[2], 0); XCTAssertEqual(try rows(), before)
        let frozen = try Data(contentsOf: journal); XCTAssertEqual(try object(String(decoding: frozen, as: UTF8.self))["method"] as? String, "notificationSettingCommit")
        XCTAssertEqual(try markers().count, 0); await permissionCounts([1, 1])
        await uncertain { try await core.retryPending() }; XCTAssertEqual(try rows(), before)
        io.failCommit(false)
        let reply = try await core.retryPending(), result = try object(XCTUnwrap(reply))
        XCTAssertEqual(result["value"] as? Bool, true); XCTAssertEqual(result["changed"] as? Bool, true)
        await permissionCounts([1, 1]); XCTAssertEqual(try markers().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let receipts = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT request_id, method FROM native_request_receipts").utf8)) as? [[String: Any]])
        XCTAssertEqual(receipts.count, 1)
        XCTAssertEqual(receipts.first?["request_id"] as? String, try object(raw)["requestId"] as? String)
        XCTAssertTrue((receipts.first?["method"] as? String)?.hasPrefix("notificationSetting:") == true)
    }

    func testColdNoReceiptRefusesWithoutPromptAndAllowsFreshExplicitEdit() async throws {
        let io = NotificationSettingsIO(), writer = host(io); _ = try await writer.start()
        let raw = try await request(writer, value: true); io.failCommit(true)
        await uncertain { try await writer.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        let before = try rows(); await writer.close()
        let coldIO = NotificationSettingsIO(), cold = host(coldIO); _ = try await cold.start()
        XCTAssertEqual(try rows(), before); await permissionCounts([1, 1]); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await rejected { try await cold.probeNotificationSettingOutcome(requestJSON: raw) }
        let fresh = try await request(cold, value: true)
        _ = try await cold.setNotificationSetting(requestJSON: fresh, readmission: { true })
        await permissionCounts([2, 2]); XCTAssertEqual(try markers().count, 1)
    }

    func testColdCommittedLostAckReplaysReceiptWithoutOverwritingLaterChoice() async throws {
        let io = NotificationSettingsIO(), writer = host(io); _ = try await writer.start()
        let raw = try await request(writer, value: true); io.failRemove(true)
        await uncertain { try await writer.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); XCTAssertEqual(try markers().count, 0)
        io.failRemove(false); let originalAcknowledgment = try await writer.retryPending()
        let originalResult = try object(XCTUnwrap(originalAcknowledgment))
        let later = try await request(writer, value: false)
        _ = try await writer.setNotificationSetting(requestJSON: later, readmission: { true }); await writer.close()
        let before = try rows(), counts = await port.counts(); try frozen.write(to: journal)
        let cold = host(), startup = try object(await cold.start())
        let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(try json(recovery), try json(["method": "notificationSettingCommit", "result": originalResult]))
        XCTAssertEqual(try rows(), before); await permissionCounts(counts)
        XCTAssertEqual(try settings()["notificationsEnabled"] as? Bool, false)
        let repeatedStartup = try object(await cold.start())
        XCTAssertNil(repeatedStartup["recovery"], "Startup acknowledgment must be returned once")
        let result = try object(await cold.setNotificationSetting(requestJSON: raw, readmission: { XCTFail("Committed receipt must bypass readmission"); return false }))
        XCTAssertEqual(result["value"] as? Bool, true); XCTAssertEqual(try settings()["notificationsEnabled"] as? Bool, false)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testStaleSelectedWitnessAfterAcceptedCallbackDoesNotJournal() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), entered = expectation(description: "authorization held for selected external edit")
        await port.hold(entered)
        let edit = Task { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await fulfillment(of: [entered], timeout: 3)
        var external = try settings(); external["notificationsEnabled"] = true; external["unrelated442"] = ["opaque": "PRIVATE_SELECTED_SIBLING"]
        _ = try sql("UPDATE settings SET data=? WHERE id=1", [json(external)])
        let before = try rows(); io.reset(); await port.release()
        await rejected { try await edit.value }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(io.counts[1], 0); XCTAssertEqual(try markers().count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testCancellationDuringSharedPreparationStopsBeforeJournalAdmission() async throws {
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), before = try rows(), entered = expectation(description: "authorization accepted before preparation cancellation")
        await port.hold(entered)
        let edit = Task { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        await fulfillment(of: [entered], timeout: 3); io.reset()
        io.onNextSelect { edit.cancel() }; await port.release()
        await rejected { try await edit.value }
        XCTAssertGreaterThan(io.counts[0], 0); XCTAssertEqual(io.counts[1], 0)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
    }

    func testForeignGeneralJournalAndTaskReceiptKeepTheirOwner() async throws {
        let bootstrap = host(); _ = try await bootstrap.start(); await bootstrap.close()
        let at = ISO8601DateFormatter().string(from: Date()), id = "notification-foreign-task"
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'next','[]','[]',?,?,3,'fixture',0,0,0,0)", [id, "Foreign owner fixture", at, at])
        let io = NotificationSettingsIO(), core = host(io); _ = try await core.start()
        let raw = try await request(core, value: true), identity = try object(raw)
        let options = try object(await core.call("generalPreferenceOptions", argumentsJSON: "[\"{}\"]"))
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        let general = try json(["requestId": XCTUnwrap(identity["requestId"]), "edit": ["type": "dateFormat", "value": "ymd"],
            "expected": XCTUnwrap(expected["dateFormat"])])
        io.failCommit(true)
        await uncertain { try await core.call("generalPreference", argumentsJSON: json([general])) }
        XCTAssertGreaterThan(io.counts[2], 0)
        let frozen = try Data(contentsOf: journal), before = try rows()
        XCTAssertEqual(try object(String(decoding: frozen, as: UTF8.self))["method"] as? String, "generalPreferenceCommit"); io.reset()
        await uncertain { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(io.counts, [0, 0, 0]); await permissionCounts([0, 0]); XCTAssertEqual(try markers().count, 0)
        io.failCommit(false)
        let reply = try await core.retryPending(), result = try object(XCTUnwrap(reply))
        XCTAssertEqual(result["type"] as? String, "dateFormat"); XCTAssertEqual(result["changed"] as? Bool, true)
        XCTAssertEqual(try settings()["dateFormat"] as? String, "ymd")
        // General uses its existing synced CAS stamp, so establish a real foreign durable UUID receipt too.
        let focus = try object(await core.call("focus", argumentsJSON: "[50]"))
        let sections = try XCTUnwrap(focus["sections"] as? [[String: Any]])
        let task = try XCTUnwrap(sections.flatMap { $0["rows"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == id })
        let completion = try json(["id": id, "requestId": XCTUnwrap(identity["requestId"]), "taskRevision": XCTUnwrap(task["taskRevision"])])
        _ = try await core.call("taskCompletion", argumentsJSON: json([completion]))
        let receipts = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT request_id, method FROM native_request_receipts").utf8)) as? [[String: Any]])
        XCTAssertEqual(receipts.count, 1); XCTAssertEqual(receipts.first?["request_id"] as? String, identity["requestId"] as? String)
        XCTAssertTrue((receipts.first?["method"] as? String)?.hasPrefix("taskCompletion:") == true)
        let saved = try rows(); io.reset()
        await rejected { try await core.setNotificationSetting(requestJSON: raw, readmission: { true }) }
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(io.counts, [0, 0, 0]); await permissionCounts([0, 0])
    }

    func testMalformedFrozenJournalsRefuseBeforeSQLite() async throws {
        let writer = host(); _ = try await writer.start()
        let raw = try await request(writer, value: true), request = try object(raw)
        await writer.close(); let before = try rows()
        var changed = request; changed["edit"] = ["type": "notificationsEnabled", "value": false]
        let envelopes: [[String: Any]] = [
            ["request": request, "prepared": ["version": true, "request": request]],
            ["request": request, "prepared": ["version": 1, "request": changed]],
            ["request": request, "prepared": ["version": 1, "request": request, "permissionGranted": true]],
            ["request": request, "prepared": ["version": 1, "request": request], "permissionGranted": true],
        ]
        for envelope in envelopes {
            let encoded = try json(["version": 2, "method": "notificationSettingCommit", "argumentsJSON": json([json(envelope)])])
            try Data(encoded.utf8).write(to: journal)
            let io = NotificationSettingsIO(), cold = host(io)
            do { _ = try await cold.start(); XCTFail("Malformed frozen journal admitted") } catch {}
            XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertEqual(try rows(), before)
            XCTAssertEqual(try Data(contentsOf: journal), Data(encoded.utf8)); await cold.close()
        }
        await permissionCounts([0, 0]); XCTAssertEqual(try markers().count, 0)
    }
}
