import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private actor CalendarAccessRequester {
    private var entered: XCTestExpectation?, continuation: CheckedContinuation<Void, Never>?
    private var failure = false, requests = 0, returned = 0
    func hold(_ entered: XCTestExpectation) { self.entered = entered }
    func fail(_ value: Bool) { failure = value }
    func release() { continuation?.resume(); continuation = nil }
    func request() async throws {
        requests += 1
        defer { returned += 1 }
        if let entered {
            self.entered = nil
            await withCheckedContinuation { continuation = $0; entered.fulfill() }
        }
        if failure { throw HostFailure("PRIVATE_CALENDAR_ACCESS_URL_CREDENTIAL_CONTENT") }
    }
    func counts() -> [Int] { [requests, returned] }
}

private actor CalendarAccessReadmission {
    private let entered: XCTestExpectation
    private let admitFirst: Bool
    private var calls = 0, cancelled = false
    private var continuation: CheckedContinuation<Bool, Never>?
    init(_ entered: XCTestExpectation, admitFirst: Bool = false) { self.entered = entered; self.admitFirst = admitFirst }
    func wait() async -> Bool {
        calls += 1
        if admitFirst && calls == 1 { return true }
        return await withTaskCancellationHandler {
            if Task.isCancelled || cancelled { return false }
            return await withCheckedContinuation { continuation = $0; entered.fulfill() }
        } onCancel: { Task { await self.cancel() } }
    }
    func cancel() { cancelled = true; continuation?.resume(returning: false); continuation = nil }
    func release() { continuation?.resume(returning: true); continuation = nil }
}

private actor CalendarAccessPage {
    private var calls = 0
    func readmit() -> Bool { calls += 1; return calls == 1 }
}

private final class CalendarAccessState: @unchecked Sendable, NativeCalendarReading {
    private let lock = NSLock()
    private var permission: NativeCalendarPermission = .denied
    private var operations: [String] = [], sqlWrites = 0, promotions = 0, settled = false, closed = false
    func setPermission(_ value: NativeCalendarPermission) { lock.lock(); permission = value; lock.unlock() }
    func permissions() throws -> NativeCalendarPermission {
        lock.lock(); defer { lock.unlock() }; operations.append("permissions"); return permission
    }
    func calendars() throws -> [[String: Any]] { lock.lock(); operations.append("calendars"); lock.unlock(); return [] }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        lock.lock(); operations.append("events"); lock.unlock(); return []
    }
    func beforeSQL(_ text: String) {
        let verb = text.split(whereSeparator: { $0.isWhitespace }).first?.uppercased() ?? ""
        if ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK"].contains(verb) {
            lock.lock(); sqlWrites += 1; lock.unlock()
        }
    }
    func promotion() { lock.lock(); promotions += 1; lock.unlock() }
    func resetWrites() { lock.lock(); sqlWrites = 0; promotions = 0; lock.unlock() }
    func markSettled() { lock.lock(); settled = true; lock.unlock() }
    func markClosed() { lock.lock(); closed = true; lock.unlock() }
    var didSettle: Bool { lock.lock(); defer { lock.unlock() }; return settled }
    var didClose: Bool { lock.lock(); defer { lock.unlock() }; return closed }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [sqlWrites, promotions, operations.count] }
    var reads: [String] { lock.lock(); defer { lock.unlock() }; return operations }
}

private final class CalendarAccessNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { XCTFail("Calendar access cannot perform HTTP"); client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}

final class NativeCalendarAccessHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, requester: CalendarAccessRequester!, state: CalendarAccessState!
    private let namespace = "tech.example.mindwtr.calendar-access"
    private let settingName = "mindwtr-system-calendar-settings", markerName = "mindwtr:native:calendar-setting:v1"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var disabled: [String: Any] { ["enabled": false, "selectAll": true, "selectedCalendarIds": [], "areaIdsByCalendar": [:]] }
    private var enabled: [String: Any] { ["enabled": true, "selectAll": true, "selectedCalendarIds": [], "areaIdsByCalendar": [:]] }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/calendar-access/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Calendar access fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        requester = CalendarAccessRequester(); state = CalendarAccessState()
        try seed()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func seed(marker: String? = nil, settings: [String: Any]? = nil) throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        var values = ["@mindwtr_sync_backend": "off", settingName: try json(settings ?? disabled), "unknown-calendar-choice": "PRIVATE_CALENDAR_ACCESS 文"]
        values[markerName] = marker; try Data(json(values).utf8).write(to: manifest)
    }
    private func host(bundle supplied: URL? = nil) -> CoreHost {
        let faults = HostIOFaults(), requester = self.requester!, state = self.state!
        faults.calendarAuthorizationRequest = { try await requester.request() }
        faults.calendarReaderFactory = { state }
        faults.beforeSQL = { state.beforeSQL($0) }; faults.configureDeviceStorage = { storage in storage.faults.afterPromotion = { state.promotion() } }
        faults.secretBeforeOperation = { _, _ in XCTFail("Calendar access cannot access credentials") }; faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Calendar access cannot access crypto") }
        faults.notificationAuthorizationRequest = { XCTFail("Calendar access cannot request notification permission") }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CalendarAccessNoHTTP.self]; faults.httpConfiguration = config
        let value = CoreHost(databaseURL: database, bundleURL: supplied ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ core: CoreHost) async throws { _ = try await core.start(); state.resetWrites() }
    private func markers() throws -> Int {
        let text = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(text.contains("PRIVATE_CALENDAR_ACCESS")); XCTAssertFalse(text.contains(namespace))
        return text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-calendar-access") }.count
    }
    private func rejection(_ message: String? = nil, _ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected calendar permission refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected \(error)"); if let message { XCTAssertEqual(error.localizedDescription, message) } }
    }
    private func assertNoWrite(_ before: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: manifest), before, file: file, line: line)
        XCTAssertEqual(Array(state.counts.prefix(2)), [0, 0], file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
    }
    private func lockAvailable() -> Bool {
        let descriptor = Darwin.open(database.appendingPathExtension("host-lock").path, O_RDWR | O_NOFOLLOW)
        guard descriptor >= 0 else { return false }; defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return false }
        _ = flock(descriptor, LOCK_UN); return true
    }
    private func bundleWith(_ suffix: String) throws -> URL {
        let url = root.appendingPathComponent("access-probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n;" + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testBootPassiveReadsGenericDispatchAndSavedWriterRetriesNeverRequestAccess() async throws {
        let core = host(); try await start(core)
        let startupCounts = await requester.counts(); XCTAssertEqual(startupCounts, [0, 0])
        XCTAssertEqual(state.reads, [])
        let retried = try await core.retryPending(); XCTAssertNil(retried)
        let opened = try object(await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"))
        let device = try XCTUnwrap(opened["device"] as? [String: Any])
        XCTAssertEqual(device["enabled"] as? Bool, false)
        XCTAssertEqual((device["calendars"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(state.reads, ["permissions", "permissions"])
        for method in ["grantDeviceCalendarAccess", "deviceCalendarAccessAcknowledged"] {
            await rejection { _ = try await core.call(method) }
        }
        let raw = try json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "deviceCalendars", "before": disabled, "value": enabled]])
        let first = try object(await core.setDeviceCalendarSetting(requestJSON: raw))
        XCTAssertEqual(first["open"] as? String, "device")
        _ = try await core.setDeviceCalendarSetting(requestJSON: raw)
        let after = await requester.counts(); XCTAssertEqual(after, [0, 0]); XCTAssertEqual(try markers(), 0)
        await core.close()
        let cold = host(); try await start(cold)
        _ = try await cold.setDeviceCalendarSetting(requestJSON: raw)
        let coldCounts = await requester.counts(); XCTAssertEqual(coldCounts, [0, 0])
    }

    func testPreReadmissionRefusalDoesNotPromptThenDeniedCallbackReturnsAndAllowsPassiveRefresh() async throws {
        try seed(settings: enabled)
        let core = host(); try await start(core); let before = try Data(contentsOf: manifest)
        await rejection("STALE_REVISION: Calendar access is no longer current") { try await core.grantDeviceCalendarAccess(readmission: { false }) }
        let refused = await requester.counts(); XCTAssertEqual(refused, [0, 0]); XCTAssertEqual(try markers(), 0)
        try assertNoWrite(before); XCTAssertEqual(state.counts[2], 0)
        try await core.grantDeviceCalendarAccess(readmission: { true })
        let returned = await requester.counts(); XCTAssertEqual(returned, [1, 1]); XCTAssertEqual(try markers(), 1)
        try assertNoWrite(before); XCTAssertEqual(state.counts[2], 0)
        let opened = try object(await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"))
        let device = try XCTUnwrap(opened["device"] as? [String: Any])
        XCTAssertEqual(device["enabled"] as? Bool, true)
        XCTAssertNotNil(device["access"] as? [String: Any])
        XCTAssertEqual((device["calendars"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(state.reads, ["permissions", "permissions"])
        let afterRefresh = await requester.counts(); XCTAssertEqual(afterRefresh, [1, 1])
        try assertNoWrite(before)
    }

    func testCancelledAcceptedCallbackRetainsOwnerAndBlocksCompetingReadsWritesAndGrant() async throws {
        let entered = expectation(description: "calendar permission callback accepted")
        await requester.hold(entered)
        let core = host(); try await start(core); let before = try Data(contentsOf: manifest), state = self.state!
        let request = Task { defer { state.markSettled() }; try await core.grantDeviceCalendarAccess(readmission: { true }) }
        await fulfillment(of: [entered], timeout: 3); request.cancel()
        await rejection("NOT_READY: Calendar access is unavailable") { try await core.grantDeviceCalendarAccess(readmission: { true }) }
        await rejection { _ = try await core.call("window", argumentsJSON: "[0,20]") }
        await rejection { _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}") }
        await rejection { _ = try await core.readNotificationSettingsOptions() }
        await rejection { _ = try await core.retryPending() }
        let raw = try json(["requestId": UUID().uuidString.lowercased(), "edit": ["type": "deviceCalendars", "before": disabled, "value": enabled]])
        await rejection { _ = try await core.setDeviceCalendarSetting(requestJSON: raw) }
        XCTAssertFalse(state.didSettle); XCTAssertEqual(state.counts[2], 0); try assertNoWrite(before)
        let held = await requester.counts(); XCTAssertEqual(held, [1, 0])
        await requester.release()
        await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
        XCTAssertTrue(state.didSettle); XCTAssertEqual(try markers(), 0)
        _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}")
        XCTAssertEqual(state.reads, ["permissions", "permissions"])
        try await core.grantDeviceCalendarAccess(readmission: { true })
        let returned = await requester.counts(); XCTAssertEqual(returned, [2, 2]); XCTAssertEqual(try markers(), 1)
    }

    func testPageGoneAfterAcceptedCallbackRefusesWithoutPublishingOrChangingChoice() async throws {
        let core = host(), page = CalendarAccessPage(); try await start(core)
        let before = try Data(contentsOf: manifest)
        await rejection("STALE_REVISION: Calendar access is no longer current") {
            try await core.grantDeviceCalendarAccess(readmission: { await page.readmit() })
        }
        let counts = await requester.counts(); XCTAssertEqual(counts, [1, 1]); XCTAssertEqual(try markers(), 0)
        try assertNoWrite(before); XCTAssertEqual(state.counts[2], 0)
        _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}")
        XCTAssertEqual(state.reads, ["permissions", "permissions"])
    }

    func testCloseWaitsForAcceptedCallbackAndKeepsLibraryAndNamespaceLeases() async throws {
        let entered = expectation(description: "calendar callback held"), closing = expectation(description: "close requested")
        await requester.hold(entered)
        let core = host(); try await start(core); let before = try Data(contentsOf: manifest), state = self.state!
        let request = Task { defer { state.markSettled() }; try await core.grantDeviceCalendarAccess(readmission: { true }) }
        await fulfillment(of: [entered], timeout: 3)
        let close = Task { closing.fulfill(); await core.close(); state.markClosed() }
        await fulfillment(of: [closing], timeout: 1); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(state.didClose); XCTAssertFalse(state.didSettle); XCTAssertFalse(lockAvailable())
        XCTAssertThrowsError(try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace))
        try assertNoWrite(before); XCTAssertEqual(try markers(), 0)
        await requester.release(); await close.value
        await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
        XCTAssertTrue(state.didClose); XCTAssertTrue(lockAvailable())
        let available = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace); available.close()
        let cold = host(); try await start(cold)
        let counts = await requester.counts(); XCTAssertEqual(counts, [1, 1]); XCTAssertEqual(try markers(), 0)
    }

    func testCloseCancelsSuspendedPreReadmissionWithoutFuturePageEvent() async throws {
        let entered = expectation(description: "pre-readmission suspended"), closed = expectation(description: "close drains readmission")
        let gate = CalendarAccessReadmission(entered), core = host(); try await start(core)
        let before = try Data(contentsOf: manifest)
        let request = Task { try await core.grantDeviceCalendarAccess(readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 3)
        let close = Task { await core.close(); closed.fulfill() }
        await fulfillment(of: [closed], timeout: 3); await close.value
        await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
        let counts = await requester.counts(); XCTAssertEqual(counts, [0, 0]); XCTAssertEqual(try markers(), 0)
        try assertNoWrite(before); XCTAssertTrue(lockAvailable())
    }

    func testCloseCancelsSuspendedPostReadmissionAfterCallbackReturned() async throws {
        let entered = expectation(description: "post-readmission suspended"), closed = expectation(description: "close drains renewed readmission")
        let gate = CalendarAccessReadmission(entered, admitFirst: true), core = host(); try await start(core)
        let before = try Data(contentsOf: manifest)
        let request = Task { try await core.grantDeviceCalendarAccess(readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 3)
        let close = Task { await core.close(); closed.fulfill() }
        await fulfillment(of: [closed], timeout: 3); await close.value
        await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
        let counts = await requester.counts(); XCTAssertEqual(counts, [1, 1]); XCTAssertEqual(try markers(), 0)
        try assertNoWrite(before); XCTAssertTrue(lockAvailable())
    }

    func testExternalSettingAndCanonicallyEquivalentMarkerChangesRefuseWithoutOverwrite() async throws {
        for field in [settingName, markerName] {
            try seed(marker: "\u{e9}")
            let entered = expectation(description: "held callback before external choice change")
            await requester.hold(entered)
            let core = host(); try await start(core)
            let request = Task { try await core.grantDeviceCalendarAccess(readmission: { true }) }
            await fulfillment(of: [entered], timeout: 3)
            var values = try object(String(contentsOf: manifest, encoding: .utf8))
            values[field] = field == markerName ? "e\u{301}" : (try XCTUnwrap(values[field] as? String)) + " "
            let external = Data(try json(values).utf8); try external.write(to: manifest)
            await requester.release()
            await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
            try assertNoWrite(external); XCTAssertEqual(try markers(), 0); XCTAssertEqual(state.counts[2], 0)
            await core.close()
        }
    }

    func testExternalFixedCellChangeDuringPreReadmissionRefusesBeforeOSRequest() async throws {
        for field in [settingName, markerName] {
            try seed(marker: "\u{e9}")
            let entered = expectation(description: "pre-readmission held before external choice change")
            let gate = CalendarAccessReadmission(entered), core = host(); try await start(core)
            let request = Task { try await core.grantDeviceCalendarAccess(readmission: { await gate.wait() }) }
            await fulfillment(of: [entered], timeout: 3)
            var values = try object(String(contentsOf: manifest, encoding: .utf8))
            values[field] = field == markerName ? "e\u{301}" : (try XCTUnwrap(values[field] as? String)) + " "
            let external = Data(try json(values).utf8); try external.write(to: manifest)
            await gate.release()
            await rejection("STALE_REVISION: Calendar access is no longer current") { try await request.value }
            let counts = await requester.counts(); XCTAssertEqual(counts, [0, 0])
            try assertNoWrite(external); XCTAssertEqual(try markers(), 0); XCTAssertEqual(state.counts[2], 0)
            await core.close()
        }
    }

    func testAuthorizationFailureHasFixedPrivateReplyAndRetiresOwner() async throws {
        let core = host(); try await start(core); let before = try Data(contentsOf: manifest)
        await requester.fail(true)
        await rejection("ACTION_FAILED: Calendar authorization is unavailable") { try await core.grantDeviceCalendarAccess(readmission: { true }) }
        try assertNoWrite(before); XCTAssertEqual(try markers(), 0); XCTAssertEqual(state.counts[2], 0)
        await requester.fail(false); try await core.grantDeviceCalendarAccess(readmission: { true })
        let counts = await requester.counts(); XCTAssertEqual(counts, [2, 2]); XCTAssertEqual(try markers(), 1)
    }

    func testDiagnosticFailureCannotChangeValidatedPermissionReply() async throws {
        let instrumented = try bundleWith("MindwtrHost.deviceCalendarAccessAcknowledged=()=>{throw Error('PRIVATE_CALENDAR_ACCESS_DIAGNOSTIC_ERROR');};")
        let core = host(bundle: instrumented); try await start(core); let before = try Data(contentsOf: manifest)
        try await core.grantDeviceCalendarAccess(readmission: { true })
        try assertNoWrite(before); XCTAssertEqual(try markers(), 0); XCTAssertEqual(state.counts[2], 0)
        let counts = await requester.counts(); XCTAssertEqual(counts, [1, 1])
        _ = try await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}")
        XCTAssertEqual(state.reads, ["permissions", "permissions"])
    }
}
