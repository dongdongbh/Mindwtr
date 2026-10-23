import Foundation
import Security
import Darwin
import JavaScriptCore
import XCTest
@testable import MindwtrNativeCore

private actor AIReasoningEffortReadmissionGate {
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

private final class AIReasoningEffortCancelSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?
    func arm(_ action: @escaping @Sendable () -> Void) { lock.lock(); self.action = action; lock.unlock() }
    func cancelOnce() { lock.lock(); let action = action; self.action = nil; lock.unlock(); action?() }
}

private final class AIReasoningEffortIO: @unchecked Sendable {
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
        if failure { throw HostFailure("PRIVATE_EFFORT_COMMIT_ERROR") }
    }
    func onNextSelect(_ callback: @escaping @Sendable () -> Void) { lock.lock(); selectCallback = callback; lock.unlock() }
    func beforeJournal() { lock.lock(); journalWrites += 1; lock.unlock() }
    func beforeRemove() throws {
        lock.lock(); defer { lock.unlock() }
        if removeFailure { throw HostFailure("PRIVATE_EFFORT_CLEAR_ERROR") }
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

private final class AIReasoningEffortNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("AI reasoning effort must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

/// Actual production bundle/JSC/SQLite. These are authored Apple checks, not Linux or device acceptance.
final class NativeAIReasoningEffortTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL {
        root.appendingPathComponent("device/Library/Application Support/mindwtr.ai.fixture/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private let sentinel = "PRIVATE590-SENTINEL"
    private let marker = "v1.3.5/ios-ai-reasoning-effort"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeAIReasoningEffortTests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(root.path, nil) else { throw HostFailure("AI fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("device"), withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
    }
    override func tearDownWithError() throws {
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func host(_ faults: HostIOFaults = HostIOFaults(), io: AIReasoningEffortIO? = nil) -> CoreHost {
        if let io {
            faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AIReasoningEffortNoHTTP.self]; faults.httpConfiguration = configuration
        faults.notificationAuthorizationRequest = { XCTFail("AI reasoning effort must not request notification permission"); throw HostFailure("No permission port") }
        faults.cryptoBeforeOperation = { _ in XCTFail("AI reasoning effort must not use crypto") }
        faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), "mindwtr.ai.fixture"))
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    @discardableResult private func rows(_ sql: String, _ args: [Any] = []) throws -> [[String: Any]] {
        let connection = try SQLiteBridge(url: database); defer { connection.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(connection.execute(sql, parametersJSON: json(args)).utf8)) as? [[String: Any]])
    }
    private func saved() throws -> String {
        try json(["settings": rows("SELECT * FROM settings"), "tasks": rows("SELECT * FROM tasks"),
            "receipts": rows("SELECT * FROM native_request_receipts"), "timer": rows("SELECT * FROM native_pomodoro_session")])
    }
    private func log() throws -> String {
        let url = root.appendingPathComponent("logs/mindwtr.log")
        return FileManager.default.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : ""
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func seed(_ ai: [String: Any]) async throws {
        let initial = host(); _ = try await initial.start()
        let capture = UUID().uuidString.lowercased()
        let options: [String: Any] = ["note": "", "dueDate": NSNull(), "dueDateHasTime": false, "startTime": NSNull(),
            "contexts": [String](), "projectId": NSNull(), "areaId": NSNull(), "priority": NSNull(), "focus": false, "addAnother": false]
        _ = try await initial.call("captureSubmit", argumentsJSON: json([json(["text": "Raw fixture", "options": options,
            "captureId": capture, "openAfterSave": false])]))
        await initial.close()
        try rows("UPDATE tasks SET contexts=?, tags=?, focusOrder=? WHERE id=?", ["[ \"@raw\" ]", "[ \"keep\" ]", 9, capture])
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["mindwtr-ai-key:openai": sentinel, "mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]).utf8).write(to: manifest)
    }
    private func configured() -> [String: Any] {
        ["provider": "openai", "enabled": false, "reasoningEffort": "minimal", "thinkingBudget": 2048,
            "requestTimeoutSeconds": 120, "model": sentinel, "copilotModel": sentinel,
            "baseUrl": "https://" + sentinel, "openAIExtraBodyParams": ["opaque": sentinel],
            "speechToText": ["provider": "parakeet", "enabled": true, "model": sentinel,
                "baseUrl": sentinel, "language": sentinel, "offlineModelPath": sentinel,
                "mode": "transcribe_only", "fieldStrategy": "title_only"]]
    }

    private func request(_ core: CoreHost, value: NativeAIReasoningEffortValue, id: String = UUID().uuidString.lowercased()) async throws -> NativeAIReasoningEffortRequest {
        let options = try await core.readAIReasoningEffortOptions()
        return .init(requestId: id, value: value, expected: options.expected)
    }
    private func markerCount() throws -> Int { try log().components(separatedBy: "\n").filter { $0.contains(marker) }.count }
    private func savedSettings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func replaceAI(_ value: Any) throws {
        var settings = try savedSettings(); settings["ai"] = value
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }

    func testAbsentDefaultWritesExplicitlyAndExplicitDefaultNoopCreatesNoJournalOrReceipt() async throws {
        let io = AIReasoningEffortIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let first = try await core.readAIReasoningEffortOptions(), second = try await core.readAIReasoningEffortOptions()
        XCTAssertEqual(first, second); XCTAssertEqual(first.value, .low); XCTAssertFalse(first.expected.effortPresent)
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try markerCount(), 0)
        let write = NativeAIReasoningEffortRequest(requestId: UUID().uuidString.lowercased(), value: .low, expected: first.expected)
        let changed = try await core.setAIReasoningEffort(write, readmission: { true })
        XCTAssertEqual(changed, .init(value: .low, changed: true)); XCTAssertEqual(try markerCount(), 1)
        let noop = try await request(core, value: .low), before = try saved(); io.reset()
        let unchanged = try await core.setAIReasoningEffort(noop, readmission: { true })
        XCTAssertEqual(unchanged, .init(value: .low, changed: false)); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPrivateSettingsAndRawRowsSurviveReasoningWriteWithoutKVOrSecretAccess() async throws {
        try await seed(configured())
        let faults = HostIOFaults(); var secrets = 0, deviceWrites = 0, configuredStorage = false
        faults.secretBeforeOperation = { _, _ in secrets += 1 }
        faults.configureDeviceStorage = { storage in configuredStorage = true; storage.faults.beforePromotion = { deviceWrites += 1 } }
        let core = host(faults); _ = try await core.start(); secrets = 0; deviceWrites = 0
        XCTAssertTrue(configuredStorage, "Must exercise an admitted real device storage port")
        let before = try savedSettings(), beforeRows = try json(rows("SELECT * FROM tasks")), manifestBefore = try Data(contentsOf: manifest)
        XCTAssertFalse(try rows("SELECT * FROM tasks").isEmpty)
        XCTAssertEqual(try rows("SELECT contexts FROM tasks").first?["contexts"] as? String, "[ \"@raw\" ]")
        let edit = try await request(core, value: .medium)
        let result = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true))
        var expected = before; var ai = try XCTUnwrap(before["ai"] as? [String: Any]); ai["reasoningEffort"] = "medium"; expected["ai"] = ai
        var after = try savedSettings(); after["syncPreferencesUpdatedAt"] = before["syncPreferencesUpdatedAt"]
        XCTAssertEqual(try json(after), try json(expected)); XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertEqual(try Data(contentsOf: manifest), manifestBefore); XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0)
        XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(sentinel))
    }

    func testGenericAndMenuRoutesDenyAllPrivateEffortMethodsWithoutJournalOrMarker() async throws {
        let io = AIReasoningEffortIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
        for method in ["iosAIReasoningEffort", "iosAIReasoningEffortOptions", "iosAIReasoningEffortPrepare", "iosAIReasoningEffortValidate",
            "iosAIReasoningEffortCommit", "iosAIReasoningEffortRetryOutcome", "iosAIReasoningEffortAcknowledged"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
            for dispatch in ["menuRead", "menuCommand"] { await failure { _ = try await core.call(dispatch, argumentsJSON: json([method, "{}"])) } }
        }
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
    }

    func testExternalWriterDuringReadmissionRetiresOwnerUntilNewHostLoad() async throws {
        let core = host(); _ = try await core.start(); let edit = try await request(core, value: .medium)
        let entered = expectation(description: "readmission"), gate = AIReasoningEffortReadmissionGate(entered)
        let work = Task { try await core.setAIReasoningEffort(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        try replaceAI(["provider": "openai", "reasoningEffort": "high"]); let before = try saved()
        await gate.setActive(true); await failure { _ = try await work.value }
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIReasoningEffortOptions(); XCTAssertEqual(options.value, .high)
    }

    func testExternalCommitInsideFullReadCannotRehabilitateAdapterEpochOnNextOptionsRead() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var settingsReads = 0, raced = false
        faults.beforeSQL = { sql in
            if sql == "SELECT data FROM settings WHERE id = 1" {
                settingsReads += 1
                if settingsReads == 2 { raced = true; try self.replaceAI(["provider": "openai", "reasoningEffort": "high"]) }
            }
        }
        await failure { _ = try await core.readAIReasoningEffortOptions() }; XCTAssertTrue(raced)
        faults.beforeSQL = nil; let before = try saved()
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIReasoningEffortOptions(); XCTAssertEqual(options.value, .high)
    }

    func testCancellationBeforeReadmissionCreatesNoJournalAndConcurrentOwnerIsDenied() async throws {
        let core = host(); _ = try await core.start(); let edit = try await request(core, value: .medium), before = try saved()
        let entered = expectation(description: "readmission"), gate = AIReasoningEffortReadmissionGate(entered)
        let work = Task { try await core.setAIReasoningEffort(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        await failure { _ = try await core.setAIReasoningEffort(edit, readmission: { true }) }
        await failure { _ = try await core.readAISettingsProjection() }
        work.cancel(); await gate.cancel(); await failure { _ = try await work.value }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActualCommitFailureKeepsExactJournalRawSnapshotAndTypedWarmRetryAcknowledgesOnce() async throws {
        try await seed(configured())
        let io = AIReasoningEffortIO(), core = host(io: io); _ = try await core.start()
        let edit = try await request(core, value: .medium), before = try saved(); io.failCommit(true)
        await failure { _ = try await core.setAIReasoningEffort(edit, readmission: { true }) }
        XCTAssertEqual(io.counts[2], 5); XCTAssertEqual(try saved(), before)
        let frozen = try Data(contentsOf: journal), object = try self.object(String(decoding: frozen, as: UTF8.self))
        XCTAssertEqual(object["method"] as? String, "iosAIReasoningEffortCommit")
        XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(sentinel)); XCTAssertEqual(try markerCount(), 0)
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen)
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try saved(), before)
        io.failCommit(false)
        let result = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true)); XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testCancellationAfterJournalAndActualCommitFailureRetainsExactWarmRetryAndRejectsGenericRecovery() async throws {
        try await seed(configured())
        // Hold only delivery of the first real commit's terminal reply until its caller cancels.
        // The production route, store action, SQLite COMMIT and raw retry remain unchanged.
        let suffix = """
        ;(() => {
            const commit = MindwtrHost.iosAIReasoningEffortCommit, poll = MindwtrHost.poll, cancel = MindwtrHost.cancel;
            let first = true, held = null, terminal = null, released = false;
            MindwtrHost.iosAIReasoningEffortCommit = function(...args) {
                const ticket = commit.apply(this, args); if (first) { first = false; held = ticket; } return ticket;
            };
            MindwtrHost.poll = function(ticket) {
                if (ticket !== held) return poll.call(this, ticket);
                if (terminal === null) terminal = poll.call(this, ticket);
                if (!released || terminal === null) return null;
                const raw = terminal; held = null; terminal = null; return raw;
            };
            MindwtrHost.cancel = function(ticket) {
                if (ticket === held) released = true; return cancel.call(this, ticket);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let io = AIReasoningEffortIO(), core = host(io: io), hooks = NativeAttachmentHostHooks(), cancellation = AIReasoningEffortCancelSignal()
        hooks.pump = { if io.counts[1] > 0 && io.counts[2] > 0 { cancellation.cancelOnce() } }
        try await core.configureAttachmentHost(hooks); _ = try await core.start()
        let edit = try await request(core, value: .medium), before = try saved(), beforeRows = try json(rows("SELECT * FROM tasks"))
        io.failCommit(true)
        let entered = expectation(description: "readmission before published commit"), gate = AIReasoningEffortReadmissionGate(entered)
        let work = Task { try await core.setAIReasoningEffort(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10); cancellation.arm { work.cancel() }; await gate.setActive(true)
        do { _ = try await work.value; XCTFail("Cancelled uncertain save must not report success") }
        catch is CancellationError { }
        catch { XCTFail("Expected owned commit cancellation") }
        XCTAssertGreaterThan(io.counts[2], 0); XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        let frozen = try Data(contentsOf: journal)
        XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(sentinel))
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try saved(), before)
        io.failCommit(false)
        let result = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true)); XCTAssertEqual(try markerCount(), 1)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertTrue(try json(savedSettings()).contains(sentinel))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testColdReceiptlessJournalRefusesEvenWhenSavedTargetEqualsOrReturnsByABA() async throws {
        let io = AIReasoningEffortIO(), writer = host(io: io); _ = try await writer.start()
        let edit = try await request(writer, value: .medium), exactBaseline = try savedSettings(); io.failCommit(true)
        await failure { _ = try await writer.setAIReasoningEffort(edit, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); await writer.close()
        for target in ["medium", "high", "medium"] {
            try replaceAI(["provider": "openai", "reasoningEffort": target]); try frozen.write(to: journal)
            let before = try saved(), cold = host(); _ = try await cold.start()
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
            await failure { _ = try await cold.probeAIReasoningEffortOutcome(edit) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
        }
        try rows("UPDATE settings SET data=? WHERE id=1", [json(exactBaseline)]); try frozen.write(to: journal)
        let before = try saved(), exactCold = host(); _ = try await exactCold.start()
        let exactOptions = try await exactCold.readAIReasoningEffortOptions()
        XCTAssertEqual(exactOptions.expected, edit.expected); XCTAssertNotEqual(exactOptions.value.rawValue, edit.value.rawValue)
        await failure { _ = try await exactCold.probeAIReasoningEffortOutcome(edit) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostAcknowledgmentReopensReceiptAfterLaterEditWithoutOverwritingLaterValue() async throws {
        let io = AIReasoningEffortIO(), writer = host(io: io); _ = try await writer.start()
        let a = try await request(writer, value: .medium); io.failRemove(true)
        await failure { _ = try await writer.setAIReasoningEffort(a, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); XCTAssertEqual(try markerCount(), 0)
        io.failRemove(false)
        let aResult = try await writer.setAIReasoningEffort(a, readmission: { true }); XCTAssertEqual(aResult, .init(value: .medium, changed: true))
        let b = try await request(writer, value: .high); _ = try await writer.setAIReasoningEffort(b, readmission: { true }); await writer.close()
        let before = try saved(); try frozen.write(to: journal)
        let cold = host(), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "iosAIReasoningEffortCommit")
        XCTAssertEqual(try saved(), before)
        let options = try await cold.readAIReasoningEffortOptions(); XCTAssertEqual(options.value, .high)
        let replay = try await cold.setAIReasoningEffort(a, readmission: { XCTFail("Receipt replay must bypass readmission"); return false })
        XCTAssertEqual(replay, aResult); XCTAssertEqual(try saved(), before)
    }

    func testMalformedSavedLegacyControlsAndTypedTransportsRefuseWithoutPrivateValues() async throws {
        let initial = host(); _ = try await initial.start(); await initial.close()
        let malformed: [[String: Any]] = [["apiKey": NSNull()], ["apiKey": ""], ["provider": sentinel], ["reasoningEffort": 31]]
        for ai in malformed {
            try replaceAI(ai); let core = host(); _ = try await core.start(); let before = try saved()
            do { _ = try await core.readAIReasoningEffortOptions(); XCTFail("Malformed raw AI must refuse") }
            catch { XCTAssertFalse(error.localizedDescription.contains(sentinel)) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0); await core.close()
        }
        let witness: [String: Any] = ["aiPresent": false, "effortPresent": false, "effort": NSNull(), "providerPresent": false,
            "provider": NSNull(), "stampPresent": false, "stamp": NSNull()]
        _ = try NativeAIReasoningEffortOptions.validated(json(["value": "low", "expected": witness]))
        for raw in ["{\"value\":\"minimal\",\"changed\":true}", "{\"value\":\"medium\",\"changed\":true,\"secret\":1}",
            "{\"value\":\"medium\",\"value\":\"high\",\"changed\":true}", "{\"value\":true,\"changed\":true}",
            "{\"value\":\"future\",\"changed\":false}"] {
            XCTAssertThrowsError(try NativeAIReasoningEffortResult.validated(raw))
        }
        var invalid = witness; invalid["effort"] = "low"
        XCTAssertThrowsError(try NativeAIReasoningEffortWitness.validated(invalid))
        invalid = witness; invalid["stampPresent"] = true; invalid["stamp"] = sentinel
        XCTAssertThrowsError(try NativeAIReasoningEffortWitness.validated(invalid))
    }

    func testIsolatedEntitledAIKeychainAndLegacyKVSentinelsAreNeitherReadMigratedNorChanged() async throws {
        #if os(iOS)
        try await seed(configured())
        let account = "mindwtr-ai-key_openai", bytes = Data(account.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service! + ":no-auth", kSecAttrAccount as String: bytes,
            kSecAttrGeneric as String: bytes, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var input = query; input[kSecValueData as String] = Data(sentinel.utf8)
        input[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        defer { XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess) }
        let faults = HostIOFaults(); var operations = 0, deviceWrites = 0
        faults.secretBeforeOperation = { _, _ in operations += 1 }
        faults.configureDeviceStorage = { $0.faults.beforePromotion = { deviceWrites += 1 } }
        let core = host(faults); _ = try await core.start(); operations = 0; deviceWrites = 0
        let before = try Data(contentsOf: manifest), edit = try await request(core, value: .medium)
        _ = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertEqual(operations, 0); XCTAssertEqual(deviceWrites, 0); XCTAssertEqual(try Data(contentsOf: manifest), before)
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, Data(sentinel.utf8))
        #else
        throw XCTSkip("Requires the entitled physical iPhone12 test host")
        #endif
    }
    #if DEBUG && os(iOS) && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    func testAppCommitFaultSeamRefusesForeignLibraryWithoutReplacingExistingFaultAndLateArm() async throws {
        let faults = HostIOFaults(), io = AIReasoningEffortIO()
        faults.beforeSQL = { try io.beforeSQL($0) }
        let core = host(faults)
        await failure { try await core.configureIsolatedAIReasoningEffortCommitFailureOnce() }
        _ = try await core.start()
        io.reset()
        _ = try await core.readAIReasoningEffortOptions()
        XCTAssertGreaterThan(io.counts[0], 0, "Rejected arming must preserve the original SQL callback")
        await failure { try await core.configureIsolatedAIReasoningEffortCommitFailureOnce() }
        await failure { _ = try await core.isolatedAIReasoningEffortFixtureState() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    #endif

    func testAppProjectionOptionsWriteAndRefreshSequenceUsesSameHost() async throws {
        try await seed(configured())
        let core = host(); _ = try await core.start()
        let original = try await core.readAISettingsProjection()
        XCTAssertEqual(original.aiReasoningEffortSavedValue, .minimal)
        let options = try await core.readAIReasoningEffortOptions()
        let edit = NativeAIReasoningEffortRequest(requestId: UUID().uuidString.lowercased(), value: .medium, expected: options.expected)
        let saved = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertEqual(saved.value, .medium); XCTAssertTrue(saved.changed)
        let refreshed = try await core.readAISettingsProjection()
        XCTAssertEqual(refreshed.aiReasoningEffortSavedValue, .medium)
        XCTAssertEqual(refreshed.aiProvider, original.aiProvider); XCTAssertEqual(refreshed.aiEnabled, original.aiEnabled)
        let freshOptions = try await core.readAIReasoningEffortOptions()
        XCTAssertEqual(freshOptions.value, .medium)
        let noop = NativeAIReasoningEffortRequest(requestId: UUID().uuidString.lowercased(), value: .medium, expected: freshOptions.expected)
        let unchanged = try await core.setAIReasoningEffort(noop, readmission: { true })
        XCTAssertFalse(unchanged.changed)
        let reopened = try await core.readAISettingsProjection()
        XCTAssertEqual(reopened, refreshed)
        XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSavedMinimalSurvivesReadAndAllThreeExplicitChoicesWhileDisabled() async throws {
        try await seed(configured())
        let io = AIReasoningEffortIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let before = try saved(), options = try await core.readAIReasoningEffortOptions()
        XCTAssertEqual(options.value, .minimal); XCTAssertEqual(options.expected.effort, .minimal)
        XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        for value: NativeAIReasoningEffortValue in [.low, .medium, .high] {
            let prior = try savedSettings(), edit = try await request(core, value: value)
            _ = try await core.setAIReasoningEffort(edit, readmission: { true })
            let saved = try savedSettings(), ai = try XCTUnwrap(saved["ai"] as? [String: Any])
            XCTAssertEqual(ai["reasoningEffort"] as? String, value.rawValue)
            XCTAssertEqual(ai["enabled"] as? Bool, false); XCTAssertEqual(ai["requestTimeoutSeconds"] as? Int, 120)
            var expected = prior, previousAI = try XCTUnwrap(prior["ai"] as? [String: Any])
            previousAI["reasoningEffort"] = value.rawValue; expected["ai"] = previousAI
            var comparison = saved; comparison["syncPreferencesUpdatedAt"] = prior["syncPreferencesUpdatedAt"]
            XCTAssertEqual(try json(comparison), try json(expected))
        }
        XCTAssertEqual(try markerCount(), 3)
    }

    func testNonOpenAIProvidersRefuseAndAbsentProviderIsNeverMaterialized() async throws {
        let first = host(); _ = try await first.start(); await first.close()
        for provider in ["gemini", "anthropic"] {
            try replaceAI(["provider": provider, "reasoningEffort": "minimal"])
            let io = AIReasoningEffortIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
            await failure { _ = try await core.readAIReasoningEffortOptions() }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0]); await core.close()
        }
        try replaceAI(["reasoningEffort": "minimal", "enabled": false])
        let core = host(); _ = try await core.start()
        let edit = try await request(core, value: .low)
        XCTAssertFalse(edit.expected.providerPresent)
        _ = try await core.setAIReasoningEffort(edit, readmission: { true })
        XCTAssertNil((try savedSettings()["ai"] as? [String: Any])?["provider"])
    }

    func testTimeoutAndEffortOwnersAreMutuallyExclusiveAndForeignReceiptCannotAuthorizeEffort() async throws {
        let core = host(); _ = try await core.start()
        let timeoutOptions = try await core.readAIRequestTimeoutOptions(), id = UUID().uuidString.lowercased()
        let timeout = NativeAIRequestTimeoutRequest(requestId: id, value: 60, expected: timeoutOptions.expected)
        let enteredTimeout = expectation(description: "timeout held"), timeoutGate = AIReasoningEffortReadmissionGate(enteredTimeout)
        let timeoutWork = Task { try await core.setAIRequestTimeout(timeout, readmission: { await timeoutGate.wait() }) }
        await fulfillment(of: [enteredTimeout], timeout: 10)
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        await failure { _ = try await core.retryPending() }
        timeoutWork.cancel(); await timeoutGate.cancel(); await failure { _ = try await timeoutWork.value }
        let effort = try await request(core, value: .medium)
        let enteredEffort = expectation(description: "effort held"), effortGate = AIReasoningEffortReadmissionGate(enteredEffort)
        let effortWork = Task { try await core.setAIReasoningEffort(effort, readmission: { await effortGate.wait() }) }
        await fulfillment(of: [enteredEffort], timeout: 10)
        let before = try saved()
        await failure { _ = try await core.readAIRequestTimeoutOptions() }
        await failure { _ = try await core.setAIRequestTimeout(timeout, readmission: { true }) }
        await failure { _ = try await core.readAIProviderDeviceState() }
        await failure { _ = try await core.retryPending() }
        effortWork.cancel(); await effortGate.cancel(); await failure { _ = try await effortWork.value }
        XCTAssertEqual(try saved(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.setAIRequestTimeout(timeout, readmission: { true })
        let options = try await core.readAIReasoningEffortOptions()
        let forged = NativeAIReasoningEffortRequest(requestId: id, value: .low, expected: options.expected)
        let savedTimeout = try saved()
        await failure { _ = try await core.setAIReasoningEffort(forged, readmission: { true }) }
        XCTAssertEqual(try saved(), savedTimeout); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    private final class RetainedEffortOwner {
        weak var facade: CoreHost?
        weak var engine: AnyObject?
        var context: JSContext?, fence: (() -> Void)?
        var observedEngine = false
    }
    private func retainEffortOwnerAfterClose() async throws -> RetainedEffortOwner {
        let suffix = """
        ;(() => {
            const options = MindwtrHost.iosAIReasoningEffortOptions;
            MindwtrHost.iosAIReasoningEffortOptions = function(input, owner) {
                globalThis.__retainedEffortOwner = owner; return options.call(this, input, owner);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let retained = RetainedEffortOwner(), faults = HostIOFaults()
        faults.configureRuntimeLifetime = { [weak retained] engine, context, _ in
            retained?.engine = engine; retained?.context = context as? JSContext; retained?.observedEngine = true
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AIReasoningEffortNoHTTP.self]
        faults.httpConfiguration = configuration; faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        retained.facade = core; retained.fence = core.aiReasoningEffortQueueFenceForTests()
        do { _ = try await core.start(); _ = try await core.readAIReasoningEffortOptions() }
        catch { await core.close(); throw error }
        await core.close(); return retained
    }
    func testClosedRuntimeRejectsRetainedOwnerCallbackAndReleasesFacade() async throws {
        let retained = try await retainEffortOwnerAfterClose()
        try XCTUnwrap(retained.fence)()
        XCTAssertTrue(retained.observedEngine)
        XCTAssertNil(retained.facade); XCTAssertNil(retained.engine)
        guard retained.engine == nil else { return } // Baseline failure never calls an unsafe retained owner.
        let owner = try XCTUnwrap(retained.context?.objectForKeyedSubscript("__retainedEffortOwner"))
        XCTAssertFalse(owner.isUndefined)
        XCTAssertEqual(owner.call(withArguments: [])?.toString(), "!MindwtrNativeError:AI reasoning effort owner is unavailable")
    }
}
