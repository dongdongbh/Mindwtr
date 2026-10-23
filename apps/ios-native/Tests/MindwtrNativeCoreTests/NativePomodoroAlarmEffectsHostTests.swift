import Darwin
import Foundation
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

private actor PomodoroAlarmFakePort: NativePomodoroAlarmPort {
    struct Mutation: Sendable { let operation: String; let identifiers: [String]; let state: String? }
    private var pendingValues: [NativePomodoroAlarmObservation] = []
    private var deliveredValues: [NativePomodoroAlarmObservation] = []
    private var permissionValue = NativeNotificationPermission.observed(status: .authorized, alertEnabled: true)
    private var failAdd = false, ignoreRemoval = false
    private var holdOperation: String?, holdAt = 0
    private var entered: XCTestExpectation?, held: CheckedContinuation<Void, Never>?
    private var counts: [String: Int] = [:]
    private(set) var mutations: [Mutation] = []
    private(set) var authorizationCount = 0
    private let manifest: URL
    init(manifest: URL) { self.manifest = manifest }
    private func boundary(_ operation: String) async {
        counts[operation, default: 0] += 1
        if holdOperation == operation, counts[operation] == holdAt, let entered {
            holdOperation = nil; self.entered = nil
            await withCheckedContinuation { continuation in held = continuation; entered.fulfill() }
        }
    }
    func hold(_ operation: String, afterAdditionalCalls: Int = 1, entered: XCTestExpectation) {
        holdOperation = operation; holdAt = counts[operation, default: 0] + afterAdditionalCalls; self.entered = entered
    }
    func release() { held?.resume(); held = nil }
    func permission() async throws -> NativeNotificationPermission { await boundary("permission"); return permissionValue }
    func pending(namespace: String) async throws -> [NativePomodoroAlarmObservation] { await boundary("pending"); return pendingValues }
    func delivered(namespace: String) async throws -> [NativePomodoroAlarmObservation] { await boundary("delivered"); return deliveredValues }
    func configure(status: UNAuthorizationStatus = .authorized, failAdd: Bool = false, ignoreRemoval: Bool = false) {
        permissionValue = .observed(status: status, alertEnabled: status == .authorized)
        self.failAdd = failAdd; self.ignoreRemoval = ignoreRemoval
    }
    func authorize() { authorizationCount += 1; permissionValue = .observed(status: .authorized, alertEnabled: true) }
    func setPending(_ values: [NativePomodoroAlarmObservation]) { pendingValues = values }
    func setDelivered(_ values: [NativePomodoroAlarmObservation]) { deliveredValues = values }
    func inventory() -> (pending: [NativePomodoroAlarmObservation], delivered: [NativePomodoroAlarmObservation]) {
        (pendingValues, deliveredValues)
    }
    func callCount(_ operation: String) -> Int { counts[operation, default: 0] }
    private func record(_ operation: String, identifiers: [String]) throws {
        let values = try NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: String]
        mutations.append(.init(operation: operation, identifiers: identifiers, state: values?["mindwtr:native:pomodoro-alarms:v1"]))
    }
    func add(_ intentJSON: String, namespace: String, libraryID: String) async throws {
        let value = try XCTUnwrap(NativeJSON.jsonObject(with: Data(intentJSON.utf8)) as? [String: Any])
        let request = try NativePomodoroRequest.make(intent: value, namespace: namespace, libraryID: libraryID)
        try record("add", identifiers: [request.identifier])
        if failAdd { throw HostFailure("Synthetic uncertain SDK callback") }
        pendingValues.removeAll { $0.identifier == request.identifier }
        pendingValues.append(.read(request, namespace: namespace))
        await boundary("add")
    }
    func removePending(_ identifiers: [String]) async throws {
        try record("remove-pending", identifiers: identifiers)
        if !ignoreRemoval { pendingValues.removeAll { identifiers.contains($0.identifier) } }
        await boundary("remove-pending")
    }
    func removeDelivered(_ identifiers: [String]) async throws {
        try record("remove-delivered", identifiers: identifiers)
        if !ignoreRemoval { deliveredValues.removeAll { identifiers.contains($0.identifier) } }
        await boundary("remove-delivered")
    }
}

private final class PomodoroAlarmPublicationFault: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0, enabled = true
    let failureAt: Int
    init(_ failureAt: Int) { self.failureAt = failureAt }
    func before() throws {
        lock.lock(); defer { lock.unlock() }; calls += 1
        if enabled, calls == failureAt { throw HostFailure("Synthetic exact Pomodoro CAS failure") }
    }
    func disable() { lock.lock(); defer { lock.unlock() }; enabled = false }
}

private final class PomodoroAlarmPublicationHold: @unchecked Sendable {
    private let lock = NSLock(), released = DispatchSemaphore(value: 0)
    private var armed = true
    private let entered: XCTestExpectation
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func before() throws {
        lock.lock(); let hold = armed; armed = false; lock.unlock()
        if hold {
            entered.fulfill()
            guard released.wait(timeout: .now() + 10) == .success else { throw HostFailure("Synthetic attempted publication hold expired") }
        }
    }
    func release() { released.signal() }
}

private actor PomodoroTaskReminderPort: NativeReminderPort {
    private let observation: NativeReminderObservation
    private(set) var mutations = 0
    init(_ request: UNNotificationRequest, namespace: String) { observation = .read(request, namespace: namespace) }
    func permission() async throws -> NativeNotificationPermission { .observed(status: .denied, alertEnabled: false) }
    func pending(namespace: String) async throws -> [NativeReminderObservation] { [observation] }
    func delivered(namespace: String) async throws -> [NativeReminderObservation] { [observation] }
    func add(_ alarm: NativeReminderEffects.Alarm, namespace: String) async throws { mutations += 1 }
    func removePending(_ identifiers: [String]) async throws { mutations += identifiers.count }
    func removeDelivered(_ identifiers: [String]) async throws { mutations += identifiers.count }
}

final class NativePomodoroAlarmEffectsHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace: String!, service: String!, port: PomodoroAlarmFakePort!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private let cell = "mindwtr:native:pomodoro-alarms:v1"
    private var now: Int64 { Int64(floor(Date().timeIntervalSince1970 * 1000)) }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle(for: NativePomodoroAlarmEffectsHostTests.self).url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Actual production JSC bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        let directory = base.appendingPathComponent(".mindwtr-native-tests/pomodoro-effects-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Fixture path is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.example.mindwtr.pomodoro." + UUID().uuidString.lowercased()
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown": "keep exact é e\u{301}",
                       "mindwtr:local:alarms:v1": "{}", "mindwtr:native:reminders:v1": "{}"]).utf8).write(to: manifest)
        port = PomodoroAlarmFakePort(manifest: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func saved() throws -> [String: String] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(contentsOf: manifest)) as? [String: String]) }
    private func receipt(_ raw: String? = nil) throws -> [String: Any]? {
        guard let raw = try raw ?? saved()[cell] else { return nil }
        return ((try object(raw)["libraries"] as? [[String: Any]])?.last?["alarm"] as? [String: Any])
    }
    private func host(_ configure: ((HostIOFaults) -> Void)? = nil) -> CoreHost {
        let faults = HostIOFaults(), captured = port!
        faults.pomodoroAlarmPort = captured
        faults.notificationPermissionRead = { try await captured.permission() }
        faults.notificationAuthorizationRequest = { await captured.authorize() }
        configure?(faults)
        faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    @discardableResult private func sql(_ statement: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(statement, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func mutateSession(_ edit: (inout [String: Any], inout [String: Any]) -> Void) throws {
        var state = try object(XCTUnwrap(sql("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        var session = try XCTUnwrap(state["session"] as? [String: Any]), timer = try XCTUnwrap(session["timerState"] as? [String: Any])
        edit(&session, &timer); session["timerState"] = timer; state["session"] = session
        try sql("UPDATE native_pomodoro_session SET state_json=?", [json(state)])
    }
    private func deadline(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }
    private func seed(offset: TimeInterval = 3600) async throws {
        let core = host(); _ = try await core.start()
        _ = try await core.writePomodoroTransition(requestJSON: json(["action": "initialize", "requestId": UUID().uuidString.lowercased(),
            "observedAtMs": now, "localDayKey": "2026-10-11", "durations": ["focusMinutes": 25, "breakMinutes": 5]]))
        await core.close()
        try mutateSession { session, timer in timer["isRunning"] = true; session["phaseEndsAt"] = deadline(offset) }
        try sql("UPDATE settings SET data=json_set(data,'$.loggingEnabled',json('true'),'$.notificationsEnabled',json('false'),'$.features.pomodoro',json('false')) WHERE id=1")
    }
    private func refusal(_ work: () async throws -> String, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await work(); XCTFail("Expected unavailable owner", file: file, line: line) } catch { }
    }
    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    func testIsolatedAlarmFixtureRequiresOwnedLibraryNamespaceAndSecretService() async throws {
        let identifier = UUID(), name = identifier.uuidString.lowercased()
        let directory = root.appendingPathComponent("NativeUITests/" + name, isDirectory: true)
        let ownedNamespace = "tech.dongdongbh.mindwtr.native-ui." + name
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let owned = CoreHost(databaseURL: directory.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle,
            deviceStorage: (directory, ownedNamespace), isolatedTestID: identifier)
        addTeardownBlock { await owned.close() }
        try await owned.configureIsolatedPomodoroAlarmFixture()
        let state = try object(await owned.readIsolatedPomodoroAlarmFixture())
        XCTAssertEqual(state["addAttempts"] as? Int, 0)
        for (location, scope, identity) in [
            (directory, ownedNamespace, nil as UUID?),
            (directory, "tech.dongdongbh.mindwtr.native.dev", identifier),
            (directory, ownedNamespace, UUID()),
            (root.appendingPathComponent("NativeFoundation"), ownedNamespace, identifier),
        ] {
            let core: CoreHost
            if let identity {
                core = CoreHost(databaseURL: location.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle,
                    deviceStorage: (location, scope), isolatedTestID: identity)
            } else {
                core = CoreHost(databaseURL: location.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle,
                    deviceStorage: (location, scope))
            }
            addTeardownBlock { await core.close() }
            await refusal { try await core.configureIsolatedPomodoroAlarmFixture(); return "admitted" }
            await refusal { try await core.readIsolatedPomodoroAlarmFixture() }
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }
    #endif
    private func outcome(_ core: CoreHost) async throws -> String? { try object(await core.reconcilePomodoroAlarms())["outcome"] as? String }
    private func foreign(_ count: Int) -> [NativePomodoroAlarmObservation] {
        (0..<count).map { .init(identifier: $0.isMultiple(of: 2) ? "foreign:\($0)" : "mindwtr-native:\(namespace!):\($0 + 1)", identity: nil) }
    }
    private func markers() throws -> [[String: Any]] {
        let raw = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(raw.contains(database.path)); XCTAssertFalse(raw.contains(namespace)); XCTAssertFalse(raw.contains("private-selected"))
        let entries = try raw.split(separator: "\n").filter { $0.contains("v1.3.5/ios-pomodoro-alarm-effects") }.map { try object(String($0)) }
        for entry in entries {
            let context = try XCTUnwrap(entry["context"] as? [String: String])
            checkEqual(Set(context.keys), Set(["releaseCheck", "outcome"]))
        }
        return entries
    }

    func testSchedulesFromSavedPolicyAndPublishesAttemptBeforeAddWithIdempotentLinkIdentity() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let session = try json(sql("SELECT * FROM native_pomodoro_session")), tasks = try json(sql("SELECT * FROM tasks"))
        checkEqual(try await outcome(core), "scheduled")
        let mutations = await port.mutations
        checkEqual(mutations.map(\.operation), ["add"])
        checkEqual(try receipt(mutations.first?.state)?["status"] as? String, "attempted")
        checkEqual(try receipt()?["status"] as? String, "confirmed")
        checkEqual(try await outcome(core), "retained")
        checkEqual(await port.mutations.count, 1)
        checkEqual(try json(sql("SELECT * FROM native_pomodoro_session")), session)
        checkEqual(try json(sql("SELECT * FROM tasks")), tasks)
        await core.close()
        try mutateSession { session, _ in session["selectedTaskId"] = "private-selected" }
        let reopened = host(); _ = try await reopened.start()
        checkEqual(try await outcome(reopened), "retained")
        checkEqual(await port.mutations.count, 1)
        checkEqual(try saved()["unknown"], "keep exact é e\u{301}")
        XCTAssertFalse(try markers().isEmpty)
    }

    func testPrivateAlarmOwnerReadsSavedBaselineButRefusesSQLWritesAndConnectionChanges() async throws {
        try await seed()
        let session = try json(sql("SELECT * FROM native_pomodoro_session")), settings = try json(sql("SELECT * FROM settings"))
        let patch = """
        \n(() => {
            const begin = MindwtrHost.iosPomodoroAlarmBegin, bridge = __mindwtrNative;
            MindwtrHost.iosPomodoroAlarmBegin = function(...args) {
                if (JSON.parse(bridge.sqlAll('SELECT state_json FROM native_pomodoro_session', '[]')).length !== 1)
                    throw new Error('Synthetic private alarm baseline read failed');
                const writes = [
                    () => bridge.sqlAll("UPDATE settings SET data='{}' WHERE id=1", '[]'),
                    () => bridge.sqlRun('DELETE FROM native_pomodoro_session', '[]'),
                    () => bridge.sqlExec('CREATE TABLE forbidden_alarm_write (value TEXT)'),
                    () => bridge.sqlAll("WITH value(x) AS (SELECT '{}') UPDATE settings SET data=(SELECT x FROM value)", '[]'),
                    () => bridge.sqlAll('PRAGMA foreign_keys = OFF', '[]'),
                    () => bridge.sqlExec('PRAGMA query_only = ON')
                ];
                for (const write of writes) {
                    const answer = write();
                    if (typeof answer !== 'string' || !answer.startsWith('!MindwtrNativeError:'))
                        throw new Error('Synthetic private alarm SQL write admitted');
                }
                return begin.apply(this, args);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start()
        checkEqual(try await outcome(core), "scheduled")
        checkEqual(await port.mutations.map(\.operation), ["add"])
        checkEqual(try json(sql("SELECT * FROM native_pomodoro_session")), session)
        checkEqual(try json(sql("SELECT * FROM settings")), settings)
        checkEqual(try sql("SELECT name FROM sqlite_master WHERE name='forbidden_alarm_write'").count, 0)
    }

    func testPermissionRequesterRunsOnlyForActualScheduleAndFreshlyReprepares() async throws {
        await port.configure(status: .notDetermined)
        let absent = host(); _ = try await absent.start()
        checkEqual(try await outcome(absent), "uninitialized")
        checkEqual(await port.authorizationCount, 0)
        await absent.close()
        try await seed()
        let core = host(); _ = try await core.start()
        checkEqual(try await outcome(core), "scheduled")
        checkEqual(await port.authorizationCount, 1)
        checkGreaterThanOrEqual(await port.callCount("pending"), 3)
    }

    func testExplicitOffCancelsCorruptTimerDeliveredBeforePending() async throws {
        try await checkCorruptTimerCancellation(denied: false)
    }

    func testDenialCancelsCorruptTimerDeliveredBeforePending() async throws {
        try await checkCorruptTimerCancellation(denied: true)
    }

    private func checkCorruptTimerCancellation(denied: Bool) async throws {
        try await seed(offset: -60)
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let scheduled = await port.inventory().pending
        await port.setDelivered(scheduled); await core.close()
        try sql("UPDATE native_pomodoro_session SET state_json='corrupt-private-timer'")
        if denied { await port.configure(status: .denied) }
        else { try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('false')) WHERE id=1") }
        let off = host(); _ = try await off.start()
        checkEqual(try await outcome(off), "cancelled")
        let operations = await port.mutations.map(\.operation)
        checkEqual(Array(operations.suffix(2)), ["remove-delivered", "remove-pending"])
        checkTrue(await port.inventory().pending.isEmpty); checkTrue(await port.inventory().delivered.isEmpty)
        await off.close()
    }

    func testCapacityCountsForeignAndTaskRequestsWithoutEviction() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        await port.setPending(foreign(64))
        let before = try Data(contentsOf: manifest)
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkEqual(try Data(contentsOf: manifest), before); checkTrue(await port.mutations.isEmpty)
        await port.setPending(foreign(63))
        checkEqual(try await outcome(core), "scheduled")
        checkEqual(await port.inventory().pending.count, 64)
        checkEqual(await port.mutations.map(\.operation), ["add"])
    }

    func testDuePriorPhaseSurvivesReplacementAndPassiveStop() async throws {
        try await seed(offset: -60)
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let observedPrior = await port.inventory().pending.first
        let prior = try XCTUnwrap(observedPrior)
        await port.setDelivered([prior]); await core.close()
        try mutateSession { session, timer in timer["phase"] = "break"; timer["remainingSeconds"] = 300; session["phaseEndsAt"] = deadline(600) }
        let replacement = host(); _ = try await replacement.start(); checkEqual(try await outcome(replacement), "scheduled")
        checkTrue(await port.inventory().pending.contains(prior)); checkTrue(await port.inventory().delivered.contains(prior))
        checkEqual(await port.mutations.map(\.operation), ["add", "add"])
        await replacement.close()
        try mutateSession { session, timer in timer["isRunning"] = false; session.removeValue(forKey: "phaseEndsAt") }
        let stopped = host(); _ = try await stopped.start(); checkEqual(try await outcome(stopped), "cancelled")
        checkEqual(await port.inventory().pending, [prior]); checkEqual(await port.inventory().delivered, [prior])
    }

    func testUncertainImmediateAttemptIsNotResentAfterRetryOrRestartOrDismissal() async throws {
        try await seed(offset: -60); await port.configure(failAdd: true)
        let core = host(); _ = try await core.start()
        checkEqual(try await outcome(core), "uncertain")
        checkEqual(try receipt()?["status"] as? String, "attempted")
        await port.configure()
        checkEqual(try await outcome(core), "uncertain")
        await core.close()
        let restarted = host(); _ = try await restarted.start()
        checkEqual(try await outcome(restarted), "uncertain")
        checkEqual(await port.mutations.map(\.operation), ["add"])
        checkEqual(try markers().last?["context"] as? [String: String],
                       ["releaseCheck": "v1.3.5/ios-pomodoro-alarm-effects", "outcome": "uncertain"])
    }

    func testFailedConfirmationRetainsExactCASAndSuccessorNeverResumesOldOSPlan() async throws {
        try await seed(offset: -60)
        let fault = PomodoroAlarmPublicationFault(2)
        let core = host { $0.configureDeviceStorage = { $0.faults.beforePromotion = { try fault.before() } } }
        _ = try await core.start()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkEqual(try receipt()?["status"] as? String, "attempted")
        checkEqual(await port.mutations.map(\.operation), ["add"])
        checkTrue(try markers().isEmpty)
        await refusal { try await core.call("focus") }
        fault.disable()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkEqual(try receipt()?["status"] as? String, "confirmed")
        checkEqual(try await outcome(core), "retained")
        checkEqual(await port.mutations.map(\.operation), ["add"])
    }

    func testCloseDuringAcceptedAddDrainsCallbackAndRestartKeepsConservativeReceipt() async throws {
        try await seed(offset: -60)
        let core = host(); _ = try await core.start()
        let entered = expectation(description: "Accepted SDK add callback held")
        await port.hold("add", entered: entered)
        let reconcile = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        let close = Task { await core.close() }
        try await Task.sleep(nanoseconds: 50_000_000)
        await port.release()
        _ = try? await reconcile.value; await close.value
        checkEqual(try receipt()?["status"] as? String, "attempted")
        await port.setPending([]); await port.setDelivered([])
        let replacement = host(); _ = try await replacement.start()
        checkEqual(try await outcome(replacement), "uncertain")
        checkEqual(await port.mutations.map(\.operation), ["add"])
    }

    func testAwaitedPermissionAndInventoryRejectExternalSettingsAndSessionChanges() async throws {
        try await seed()
        for boundary in ["permission", "pending", "delivered"] {
            let core = host(); _ = try await core.start()
            let entered = expectation(description: "Held \(boundary)")
            await port.hold(boundary, entered: entered)
            let run = Task { try await core.reconcilePomodoroAlarms() }
            await fulfillment(of: [entered], timeout: 5)
            if boundary == "permission" {
                try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('false')) WHERE id=1")
            } else { try mutateSession { session, _ in session["phaseEndsAt"] = deadline(7200) } }
            await port.release(); await refusal { try await run.value }
            checkTrue(await port.mutations.isEmpty)
            await core.close()
            try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('true')) WHERE id=1")
        }
    }

    func testPendingWithdrawalThatBecomesDeliveredIsRemovedBeforeStateRetirement() async throws {
        try await seed(offset: -60)
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let owned = await port.inventory().pending
        await core.close()
        try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('false')) WHERE id=1")
        let off = host(); _ = try await off.start()
        let entered = expectation(description: "Pending changes to delivered after initial plan")
        await port.hold("pending", afterAdditionalCalls: 2, entered: entered)
        let run = Task { try await off.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        await port.setPending([]); await port.setDelivered(owned); await port.release()
        checkEqual(try object(await run.value)["outcome"] as? String, "cancelled")
        checkTrue(await port.inventory().delivered.isEmpty)
        checkEqual(await port.mutations.map(\.operation), ["add", "remove-delivered"])
        XCTAssertNil(try receipt())
    }

    func testSharedRepreparePreservesFutureAlarmThatBecameDueBeforeWithdrawal() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let observed = await port.inventory().pending
        let fireAt = try XCTUnwrap(observed.first?.identity?.fireAtMs)
        await core.close()
        try mutateSession { session, timer in timer["isRunning"] = false; session.removeValue(forKey: "phaseEndsAt") }
        // Advance the clock inside the actual private planner after its first future cancellation plan.
        let patch = "\n(() => { const prepare = MindwtrHost.iosPomodoroAlarmPrepare; let calls = 0; MindwtrHost.iosPomodoroAlarmPrepare = function(...args) { if (++calls >= 3) Date.now = () => \(fireAt + 2000); return prepare.apply(this, args); }; })();\n"
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let stopped = host(); _ = try await stopped.start()
        _ = try await stopped.reconcilePomodoroAlarms()
        checkEqual(await port.inventory().pending, observed)
        checkEqual(await port.mutations.map(\.operation), ["add"])
    }

    func testFreshCancellationEntersSDKBeforeAnotherAwaitedJSCurrentCheck() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        await core.close()
        try mutateSession { session, timer in timer["isRunning"] = false; session.removeValue(forKey: "phaseEndsAt") }
        // The fourth plan is the final pending withdrawal; a slow JS check must not separate it from SDK entry.
        let patch = "\n(() => { const prepare = MindwtrHost.iosPomodoroAlarmPrepare, current = MindwtrHost.iosPomodoroAlarmCurrent; let plans = 0, finalPlan = false; MindwtrHost.iosPomodoroAlarmPrepare = function(...args) { if (++plans === 4) finalPlan = true; return prepare.apply(this, args); }; MindwtrHost.iosPomodoroAlarmCurrent = function(...args) { if (finalPlan) throw new Error('Synthetic post-plan await refused'); return current.apply(this, args); }; })();\n"
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let stopped = host(); _ = try await stopped.start()
        await refusal { try await stopped.reconcilePomodoroAlarms() }
        checkEqual(await port.mutations.map(\.operation), ["add", "remove-pending"])
        checkTrue(await port.inventory().pending.isEmpty)
        // The post-effect refusal prevents an acknowledgement even though the accepted callback drained.
        checkEqual(try markers().count, 1)
    }

    func testAwaitedSchedulingInventoryRefreshesTheSharedImmediateDecision() async throws {
        try await seed()
        let rows = try sql("SELECT state_json FROM native_pomodoro_session")
        let state = try object(XCTUnwrap(rows.first?["state_json"] as? String))
        let session = try XCTUnwrap(state["session"] as? [String: Any])
        let date = try XCTUnwrap(session["phaseEndsAt"] as? String)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireAt = Int64(try XCTUnwrap(formatter.date(from: date)).timeIntervalSince1970 * 1000)
        let patch = "\n(() => { const prepare = MindwtrHost.iosPomodoroAlarmPrepare; let calls = 0; MindwtrHost.iosPomodoroAlarmPrepare = function(...args) { if (++calls >= 2) Date.now = () => \(fireAt + 2000); return prepare.apply(this, args); }; })();\n"
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start()
        let entered = expectation(description: "Scheduling inventory held across due boundary")
        await port.hold("pending", afterAdditionalCalls: 2, entered: entered)
        let run = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5); await port.release()
        checkEqual(try object(await run.value)["outcome"] as? String, "scheduled")
        let additions = await port.mutations
        checkEqual(try receipt(additions.first?.state)?["immediate"] as? Bool, true)
        checkEqual(additions.map(\.operation), ["add"])
    }

    func testDelayedAttemptPublicationRefreshesPastDeadlineBeforeSDKAdd() async throws {
        try await seed(offset: 5)
        let state = try object(XCTUnwrap(sql("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        let session = try XCTUnwrap(state["session"] as? [String: Any]), rawDate = try XCTUnwrap(session["phaseEndsAt"] as? String)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireAt = try XCTUnwrap(formatter.date(from: rawDate))
        let entered = expectation(description: "Attempt receipt publication held until deadline")
        let hold = PomodoroAlarmPublicationHold(entered)
        defer { hold.release() }
        let core = host { $0.configureDeviceStorage = { $0.faults.beforePromotion = { try hold.before() } } }
        _ = try await core.start()
        let run = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        let delay = max(0, fireAt.timeIntervalSinceNow + 0.2)
        try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        hold.release()
        checkEqual(try object(await run.value)["outcome"] as? String, "scheduled")
        let additions = await port.mutations
        checkEqual(try receipt(additions.first?.state)?["immediate"] as? Bool, true)
        checkEqual(try receipt()?["immediate"] as? Bool, true)
        checkEqual(additions.map(\.operation), ["add"])
    }

    func testClockRollbackAfterImmediateFenceRefusesDispatchWithoutReopeningFutureAttempt() async throws {
        try await seed(offset: -60)
        let state = try object(XCTUnwrap(sql("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        let session = try XCTUnwrap(state["session"] as? [String: Any]), rawDate = try XCTUnwrap(session["phaseEndsAt"] as? String)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireAt = Int64(try XCTUnwrap(formatter.date(from: rawDate)).timeIntervalSince1970 * 1000)
        let patch = "\n(() => { const dispatch = MindwtrHost.iosPomodoroAlarmDispatchPrepare; MindwtrHost.iosPomodoroAlarmDispatchPrepare = function(...args) { Date.now = () => \(fireAt - 60_000); return dispatch.apply(this, args); }; })();\n"
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkTrue(await port.mutations.isEmpty)
        checkEqual(try receipt()?["immediate"] as? Bool, true)
        checkEqual(try receipt()?["status"] as? String, "attempted")
        checkEqual(try await outcome(core), "uncertain")
        checkTrue(await port.mutations.isEmpty)
    }

    func testImmediateFenceCASFailurePreventsSDKAddAndRetainsExactFenceRetry() async throws {
        try await seed()
        let state = try object(XCTUnwrap(sql("SELECT state_json FROM native_pomodoro_session").first?["state_json"] as? String))
        let session = try XCTUnwrap(state["session"] as? [String: Any]), rawDate = try XCTUnwrap(session["phaseEndsAt"] as? String)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireAt = Int64(try XCTUnwrap(formatter.date(from: rawDate)).timeIntervalSince1970 * 1000)
        let patch = "\n(() => { const dispatch = MindwtrHost.iosPomodoroAlarmDispatchPrepare; MindwtrHost.iosPomodoroAlarmDispatchPrepare = function(...args) { Date.now = () => \(fireAt + 2000); return dispatch.apply(this, args); }; })();\n"
        try (String(contentsOf: bundle, encoding: .utf8) + patch).write(to: bundle, atomically: true, encoding: .utf8)
        let fault = PomodoroAlarmPublicationFault(2)
        let core = host { $0.configureDeviceStorage = { $0.faults.beforePromotion = { try fault.before() } } }
        _ = try await core.start()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkTrue(await port.mutations.isEmpty)
        checkEqual(try receipt()?["immediate"] as? Bool, false)
        checkEqual(try receipt()?["status"] as? String, "attempted")
        fault.disable()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkEqual(try receipt()?["immediate"] as? Bool, true)
        checkEqual(try await outcome(core), "uncertain")
        checkTrue(await port.mutations.isEmpty)
    }

    func testTargetArrivingDeliveredDuringSchedulingInventoryPreventsAnotherSDKAdd() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let prior = await port.inventory().pending
        await port.setPending([])
        let entered = expectation(description: "Target arrives in tray while missing-future retry awaits inventory")
        await port.hold("pending", afterAdditionalCalls: 2, entered: entered)
        let run = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        await port.setDelivered(prior); await port.release()
        checkEqual(try object(await run.value)["outcome"] as? String, "retained")
        checkEqual(await port.mutations.map(\.operation), ["add"])
    }

    func testDatabaseFileReplacementRejectsAnAwaitedPermissionCallback() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let entered = expectation(description: "Permission held across database replacement")
        await port.hold("permission", entered: entered)
        let run = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        try FileManager.default.moveItem(at: database, to: root.appendingPathComponent("old.sqlite"))
        let replacement = try SQLiteBridge(url: database); replacement.close()
        await port.release(); await refusal { try await run.value }
        checkTrue(await port.mutations.isEmpty)
        XCTAssertNil(try saved()[cell])
    }

    func testPostRenameWriteAheadFailureRestartsWithAttemptReceiptWithoutSDKAdd() async throws {
        try await seed(offset: -60)
        let fault = PomodoroAlarmPublicationFault(1)
        let core = host { $0.configureDeviceStorage = { $0.faults.afterPromotion = { try fault.before() } } }
        _ = try await core.start()
        await refusal { try await core.reconcilePomodoroAlarms() }
        checkEqual(try receipt()?["status"] as? String, "attempted")
        checkTrue(await port.mutations.isEmpty)
        checkTrue(try markers().isEmpty)
        await core.close()
        let restarted = host(); _ = try await restarted.start()
        checkEqual(try await outcome(restarted), "uncertain")
        checkTrue(await port.mutations.isEmpty)
    }

    func testFreshCancellationRejectsMetadataCollisionAndUnverifiedRemoval() async throws {
        try await seed(offset: -60)
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let observed = await port.inventory().pending
        await core.close()
        try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('false')) WHERE id=1")
        let off = host(); _ = try await off.start()
        let entered = expectation(description: "Fresh pending contains colliding metadata")
        await port.hold("pending", afterAdditionalCalls: 2, entered: entered)
        let run = Task { try await off.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        let identifier = try XCTUnwrap(observed.first?.identifier)
        await port.setPending([.init(identifier: identifier, identity: nil)]); await port.release()
        await refusal { try await run.value }
        checkEqual(await port.mutations.map(\.operation), ["add"])
        await port.setPending(observed); await port.configure(ignoreRemoval: true)
        await refusal { try await off.reconcilePomodoroAlarms() }
        checkEqual(await port.inventory().pending, observed)
    }

    func testPrivateMethodsAndDuplicateRawStateNeverAdmitGenericBypass() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        for method in ["iosPomodoroAlarmBegin", "iosPomodoroAlarmCurrent", "iosPomodoroAlarmPrepare", "iosPomodoroAlarmDispatchPrepare", "iosPomodoroAlarmAcknowledged", "iosPomodoroAlarmEnd"] {
            await refusal { try await core.call(method, argumentsJSON: "[]") }
        }
        await core.close()
        var values = try saved(); values[cell] = "{\"version\":1,\"version\":1,\"libraries\":[]}"
        try Data(json(values).utf8).write(to: manifest)
        let corrupt = host(); _ = try await corrupt.start()
        await refusal { try await corrupt.reconcilePomodoroAlarms() }
        checkTrue(await port.mutations.isEmpty)
    }

    func testUnknownLibraryScopeBecomesCancellationAuthorityOnlyWhenStored() async throws {
        try await seed()
        let initial = host(); _ = try await initial.start()
        let intent = try object(await initial.readPomodoroAlarmIntent())
        let request = try NativePomodoroRequest.make(intent: intent, namespace: namespace, libraryID: "unregistered-private-library")
        let observation = NativePomodoroAlarmObservation.read(request, namespace: namespace)
        await initial.close()
        await port.setPending([observation]); await port.setDelivered([observation])
        try sql("UPDATE settings SET data=json_set(data,'$.gtd.pomodoro.completionAlert',json('false')) WHERE id=1")
        try sql("UPDATE native_pomodoro_session SET state_json='corrupt-private-timer'")
        let off = host(); _ = try await off.start(); _ = try await off.reconcilePomodoroAlarms()
        checkEqual(await port.inventory().pending, [observation]); checkEqual(await port.inventory().delivered, [observation])
        checkTrue(await port.mutations.isEmpty)
        await off.close()
        let scope = try XCTUnwrap(observation.identity?.scope)
        var values = try saved(); values[cell] = try json(["version": 1, "libraries": [["scope": scope, "alarm": NSNull()]]])
        try Data(json(values).utf8).write(to: manifest)
        let known = host(); _ = try await known.start()
        checkEqual(try await outcome(known), "cancelled")
        checkEqual(await port.mutations.map(\.operation), ["remove-delivered", "remove-pending"])
        checkTrue(await port.inventory().pending.isEmpty); checkTrue(await port.inventory().delivered.isEmpty)
    }

    func testPermissionRevocationAfterSchedulingInventoryPreventsAttemptPublication() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let entered = expectation(description: "Permission changes after initial authorized plan")
        await port.hold("pending", afterAdditionalCalls: 2, entered: entered)
        let run = Task { try await core.reconcilePomodoroAlarms() }
        await fulfillment(of: [entered], timeout: 5)
        await port.configure(status: .denied); await port.release()
        await refusal { try await run.value }
        XCTAssertNil(try saved()[cell]); checkTrue(await port.mutations.isEmpty)
    }

    func testInventoryBoundsAndMalformedRawStateRefuseBeforeEffects() throws {
        XCTAssertThrowsError(try NativePomodoroAlarmEffects.checkInventory(foreign(4097)))
        XCTAssertThrowsError(try NativePomodoroAlarmEffects.checkInventory(foreign(1) + foreign(1)))
        for raw in ["{\"version\":1,\"version\":1,\"libraries\":[]}", "{\"unfinished\\", String(repeating: "a", count: 1024 * 1024 + 1)] {
            XCTAssertThrowsError(try NativePomodoroAlarmEffects.checkState(raw))
        }
    }

    func testTaskReminderReconciliationDoesNotSweepPomodoroRequests() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); _ = try await core.reconcilePomodoroAlarms()
        let intent = try object(await core.readPomodoroAlarmIntent())
        await core.close()
        let request = try NativePomodoroRequest.make(intent: intent, namespace: namespace, libraryID: "strict-task-isolation-fixture")
        let taskPort = PomodoroTaskReminderPort(request, namespace: namespace)
        let tasks = host { $0.reminderPort = taskPort }; _ = try await tasks.start()
        _ = try await tasks.reconcileReminders()
        checkEqual(await taskPort.mutations, 0)
    }
    private func checkEqual<T: Equatable>(_ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(value, expected, file: file, line: line)
    }
    private func checkTrue(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(value, file: file, line: line)
    }
    private func checkGreaterThanOrEqual<T: Comparable>(_ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThanOrEqual(value, expected, file: file, line: line)
    }
}
