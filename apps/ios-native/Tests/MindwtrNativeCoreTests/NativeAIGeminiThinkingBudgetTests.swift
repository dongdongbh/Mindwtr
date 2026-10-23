import Foundation
import Security
import Darwin
import JavaScriptCore
import XCTest
@testable import MindwtrNativeCore

private actor AIGeminiThinkingBudgetReadmissionGate {
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

private final class AIGeminiThinkingBudgetCancelSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?
    func arm(_ action: @escaping @Sendable () -> Void) { lock.lock(); self.action = action; lock.unlock() }
    func cancelOnce() { lock.lock(); let action = action; self.action = nil; lock.unlock(); action?() }
}

private final class AIGeminiThinkingBudgetIO: @unchecked Sendable {
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
        if failure { throw HostFailure("PRIVATE_GEMINI_COMMIT_ERROR") }
    }
    func onNextSelect(_ callback: @escaping @Sendable () -> Void) { lock.lock(); selectCallback = callback; lock.unlock() }
    func beforeJournal() { lock.lock(); journalWrites += 1; lock.unlock() }
    func beforeRemove() throws {
        lock.lock(); defer { lock.unlock() }
        if removeFailure { throw HostFailure("PRIVATE_GEMINI_CLEAR_ERROR") }
    }
    var commitAttempts: Int { lock.lock(); defer { lock.unlock() }; return statements.filter { $0 == "COMMIT" }.count }
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

private final class AIGeminiThinkingBudgetNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("AI Gemini thinking budget must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

/// Actual production bundle/JSC/SQLite. These are authored Apple checks, not Linux or device acceptance.
final class NativeAIGeminiThinkingBudgetTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL {
        root.appendingPathComponent("device/Library/Application Support/mindwtr.ai.fixture/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private let sentinel = "PRIVATE590-SENTINEL"
    private let marker = "v1.3.5/ios-ai-gemini-thinking-budget"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeAIGeminiThinkingBudgetTests/" + UUID().uuidString)
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
    private func host(_ faults: HostIOFaults = HostIOFaults(), io: AIGeminiThinkingBudgetIO? = nil) -> CoreHost {
        if let io {
            faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AIGeminiThinkingBudgetNoHTTP.self]; faults.httpConfiguration = configuration
        faults.notificationAuthorizationRequest = { XCTFail("AI Gemini thinking budget must not request notification permission"); throw HostFailure("No permission port") }
        faults.cryptoBeforeOperation = { _ in XCTFail("AI Gemini thinking budget must not use crypto") }
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
        try Data(json(["mindwtr-ai-key:gemini": sentinel, "mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]).utf8).write(to: manifest)
    }
    private func configured() -> [String: Any] {
        ["provider": "gemini", "enabled": false, "thinkingBudget": 123, "reasoningEffort": "minimal",
            "requestTimeoutSeconds": 120, "model": sentinel, "copilotModel": sentinel,
            "baseUrl": "https://" + sentinel, "openAIExtraBodyParams": ["opaque": sentinel],
            "speechToText": ["provider": "parakeet", "enabled": true, "model": sentinel,
                "baseUrl": sentinel, "language": sentinel, "offlineModelPath": sentinel,
                "mode": "transcribe_only", "fieldStrategy": "title_only"]]
    }

    private func request(_ core: CoreHost, value: NativeAIGeminiThinkingBudgetValue, id: String = UUID().uuidString.lowercased()) async throws -> NativeAIGeminiThinkingBudgetRequest {
        let options = try await core.readAIGeminiThinkingBudgetOptions()
        return .init(requestId: id, value: value, expected: options.expected)
    }
    private func markerCount() throws -> Int { try log().components(separatedBy: "\n").filter { $0.contains(marker) }.count }
    private func savedSettings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func replaceAI(_ value: Any) throws {
        var settings = try savedSettings(); settings["ai"] = value
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }

    func testAbsentDefaultWritesExplicitlyAndExplicitDefaultNoopCreatesNoJournalOrReceipt() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let io = AIGeminiThinkingBudgetIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let first = try await core.readAIGeminiThinkingBudgetOptions(), second = try await core.readAIGeminiThinkingBudgetOptions()
        XCTAssertEqual(first, second); XCTAssertEqual(first.value, 0); XCTAssertFalse(first.expected.budgetPresent)
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try markerCount(), 0)
        let write = NativeAIGeminiThinkingBudgetRequest(requestId: UUID().uuidString.lowercased(), value: .off, expected: first.expected)
        let changed = try await core.setAIGeminiThinkingBudget(write, readmission: { true })
        XCTAssertEqual(changed, .init(value: .off, changed: true)); XCTAssertEqual(try markerCount(), 1)
        let noop = try await request(core, value: .off), before = try saved(); io.reset()
        let unchanged = try await core.setAIGeminiThinkingBudget(noop, readmission: { true })
        XCTAssertEqual(unchanged, .init(value: .off, changed: false)); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPrivateSettingsAndRawRowsSurviveBudgetWriteWithoutKVOrSecretAccess() async throws {
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
        let result = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true))
        var expected = before; var ai = try XCTUnwrap(before["ai"] as? [String: Any]); ai["thinkingBudget"] = 256; expected["ai"] = ai
        var after = try savedSettings(); after["syncPreferencesUpdatedAt"] = before["syncPreferencesUpdatedAt"]
        XCTAssertEqual(try json(after), try json(expected)); XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertEqual(try Data(contentsOf: manifest), manifestBefore); XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0)
        XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(sentinel))
    }

    func testGenericAndMenuRoutesDenyAllPrivateBudgetMethodsWithoutJournalOrMarker() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let io = AIGeminiThinkingBudgetIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
        for method in ["iosAIGeminiThinkingBudget", "iosAIGeminiThinkingBudgetOptions", "iosAIGeminiThinkingBudgetPrepare", "iosAIGeminiThinkingBudgetValidate",
            "iosAIGeminiThinkingBudgetCommit", "iosAIGeminiThinkingBudgetRetryOutcome", "iosAIGeminiThinkingBudgetAcknowledged"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
            for dispatch in ["menuRead", "menuCommand"] { await failure { _ = try await core.call(dispatch, argumentsJSON: json([method, "{}"])) } }
        }
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
    }

    func testExternalWriterDuringReadmissionRetiresOwnerUntilNewHostLoad() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let core = host(); _ = try await core.start(); let edit = try await request(core, value: .medium)
        let entered = expectation(description: "readmission"), gate = AIGeminiThinkingBudgetReadmissionGate(entered)
        let work = Task { try await core.setAIGeminiThinkingBudget(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        try replaceAI(["provider": "gemini", "thinkingBudget": 512]); let before = try saved()
        await gate.setActive(true); await failure { _ = try await work.value }
        await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIGeminiThinkingBudgetOptions(); XCTAssertEqual(options.value, 512)
    }

    func testExternalCommitInsideFullReadCannotRehabilitateAdapterEpochOnNextOptionsRead() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var settingsReads = 0, raced = false
        faults.beforeSQL = { sql in
            if sql == "SELECT data FROM settings WHERE id = 1" {
                settingsReads += 1
                if settingsReads == 2 { raced = true; try self.replaceAI(["provider": "gemini", "thinkingBudget": 512]) }
            }
        }
        await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }; XCTAssertTrue(raced)
        faults.beforeSQL = nil; let before = try saved()
        await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIGeminiThinkingBudgetOptions(); XCTAssertEqual(options.value, 512)
    }

    func testCancellationBeforeReadmissionCreatesNoJournalAndConcurrentOwnerIsDenied() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let core = host(); _ = try await core.start(); let edit = try await request(core, value: .medium), before = try saved()
        let entered = expectation(description: "readmission"), gate = AIGeminiThinkingBudgetReadmissionGate(entered)
        let work = Task { try await core.setAIGeminiThinkingBudget(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        await failure { _ = try await core.setAIGeminiThinkingBudget(edit, readmission: { true }) }
        await failure { _ = try await core.readAISettingsProjection() }
        work.cancel(); await gate.cancel(); await failure { _ = try await work.value }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActualCommitFailureKeepsExactJournalRawSnapshotAndTypedWarmRetryAcknowledgesOnce() async throws {
        try await seed(configured())
        let io = AIGeminiThinkingBudgetIO(), core = host(io: io); _ = try await core.start()
        let edit = try await request(core, value: .medium), before = try saved(); io.reset(); io.failCommit(true)
        await failure { _ = try await core.setAIGeminiThinkingBudget(edit, readmission: { true }) }
        XCTAssertEqual(io.counts[2], 5); XCTAssertEqual(io.commitAttempts, 5); XCTAssertEqual(try saved(), before)
        let frozen = try Data(contentsOf: journal), object = try self.object(String(decoding: frozen, as: UTF8.self))
        XCTAssertEqual(object["method"] as? String, "iosAIGeminiThinkingBudgetCommit")
        XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(sentinel)); XCTAssertEqual(try markerCount(), 0)
        await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen)
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try saved(), before)
        io.failCommit(false)
        let result = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true)); XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        XCTAssertEqual(io.commitAttempts, 6)
        let acknowledged = try await core.setAIGeminiThinkingBudget(edit, readmission: { XCTFail("Known receipt must not re-admit a write"); return false })
        XCTAssertEqual(acknowledged, result); XCTAssertEqual(io.commitAttempts, 6)
    }

    func testCancellationAfterJournalAndActualCommitFailureRetainsExactWarmRetryAndRejectsGenericRecovery() async throws {
        try await seed(configured())
        // Hold only delivery of the first real commit's terminal reply until its caller cancels.
        // The production route, store action, SQLite COMMIT and raw retry remain unchanged.
        let suffix = """
        ;(() => {
            const commit = MindwtrHost.iosAIGeminiThinkingBudgetCommit, poll = MindwtrHost.poll, cancel = MindwtrHost.cancel;
            let first = true, held = null, terminal = null, released = false;
            MindwtrHost.iosAIGeminiThinkingBudgetCommit = function(...args) {
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
        let io = AIGeminiThinkingBudgetIO(), core = host(io: io), hooks = NativeAttachmentHostHooks(), cancellation = AIGeminiThinkingBudgetCancelSignal()
        hooks.pump = { if io.counts[1] > 0 && io.counts[2] > 0 { cancellation.cancelOnce() } }
        try await core.configureAttachmentHost(hooks); _ = try await core.start()
        let edit = try await request(core, value: .medium), before = try saved(), beforeRows = try json(rows("SELECT * FROM tasks"))
        io.failCommit(true)
        let entered = expectation(description: "readmission before published commit"), gate = AIGeminiThinkingBudgetReadmissionGate(entered)
        let work = Task { try await core.setAIGeminiThinkingBudget(edit, readmission: { await gate.wait() }) }
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
        let result = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
        XCTAssertEqual(result, .init(value: .medium, changed: true)); XCTAssertEqual(try markerCount(), 1)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertTrue(try json(savedSettings()).contains(sentinel))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testColdReceiptlessJournalRefusesEvenWhenSavedTargetEqualsOrReturnsByABA() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let io = AIGeminiThinkingBudgetIO(), writer = host(io: io); _ = try await writer.start()
        let edit = try await request(writer, value: .medium), exactBaseline = try savedSettings(); io.failCommit(true)
        await failure { _ = try await writer.setAIGeminiThinkingBudget(edit, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); await writer.close()
        for target in [256, 512, 256] {
            try replaceAI(["provider": "gemini", "thinkingBudget": target]); try frozen.write(to: journal)
            let before = try saved(), cold = host(); _ = try await cold.start()
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
            await failure { _ = try await cold.probeAIGeminiThinkingBudgetOutcome(edit) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
        }
        try rows("UPDATE settings SET data=? WHERE id=1", [json(exactBaseline)]); try frozen.write(to: journal)
        let before = try saved(), exactCold = host(); _ = try await exactCold.start()
        let exactOptions = try await exactCold.readAIGeminiThinkingBudgetOptions()
        XCTAssertEqual(exactOptions.expected, edit.expected); XCTAssertNotEqual(exactOptions.value, edit.value.rawValue)
        await failure { _ = try await exactCold.probeAIGeminiThinkingBudgetOutcome(edit) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostAcknowledgmentReopensReceiptAfterLaterEditWithoutOverwritingLaterValue() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let io = AIGeminiThinkingBudgetIO(), writer = host(io: io); _ = try await writer.start()
        let a = try await request(writer, value: .medium); io.failRemove(true)
        await failure { _ = try await writer.setAIGeminiThinkingBudget(a, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); XCTAssertEqual(try markerCount(), 0)
        io.failRemove(false)
        let aResult = try await writer.setAIGeminiThinkingBudget(a, readmission: { true }); XCTAssertEqual(aResult, .init(value: .medium, changed: true))
        let b = try await request(writer, value: .high); _ = try await writer.setAIGeminiThinkingBudget(b, readmission: { true }); await writer.close()
        let before = try saved(); try frozen.write(to: journal)
        let cold = host(), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "iosAIGeminiThinkingBudgetCommit")
        XCTAssertEqual(try saved(), before)
        let options = try await cold.readAIGeminiThinkingBudgetOptions(); XCTAssertEqual(options.value, 512)
        let replay = try await cold.setAIGeminiThinkingBudget(a, readmission: { XCTFail("Receipt replay must bypass readmission"); return false })
        XCTAssertEqual(replay, aResult); XCTAssertEqual(try saved(), before)
    }

    func testMalformedSavedLegacyControlsAndTypedTransportsRefuseWithoutPrivateValues() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let initial = host(); _ = try await initial.start(); await initial.close()
        let malformed: [[String: Any]] = [["apiKey": NSNull()], ["apiKey": ""], ["provider": sentinel], ["thinkingBudget": 1.5], ["provider": "gemini", "thinkingBudget": -1], ["provider": "gemini", "thinkingBudget": 32769]]
        for ai in malformed {
            try replaceAI(ai); let core = host(); _ = try await core.start(); let before = try saved()
            do { _ = try await core.readAIGeminiThinkingBudgetOptions(); XCTFail("Malformed raw AI must refuse") }
            catch { XCTAssertFalse(error.localizedDescription.contains(sentinel)) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(), 0); await core.close()
        }
        try replaceAI(configured())
        let typed = host(); _ = try await typed.start()
        let options = try await typed.readAIGeminiThinkingBudgetOptions(), savedBefore = try saved()
        for invalidID in ["00000000-0000-4000-8000-00000000069A", String(repeating: "a", count: 3000)] {
            let invalid = NativeAIGeminiThinkingBudgetRequest(requestId: invalidID, value: .medium, expected: options.expected)
            await failure { _ = try await typed.setAIGeminiThinkingBudget(invalid, readmission: { true }) }
            XCTAssertEqual(try saved(), savedBefore); XCTAssertEqual(try markerCount(), 0)
        }
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetOptions.validated(String(repeating: " ", count: 2049)))
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetResult.validated(String(repeating: " ", count: 1025)))
        let witness: [String: Any] = ["aiPresent": true, "budgetPresent": false, "budget": NSNull(), "providerPresent": true,
            "provider": "gemini", "stampPresent": false, "stamp": NSNull()]
        _ = try NativeAIGeminiThinkingBudgetOptions.validated(json(["value": 0, "expected": witness]))
        for raw in ["{\"value\":123,\"changed\":true}", "{\"value\":256,\"changed\":true,\"secret\":1}",
            "{\"value\":256,\"value\":512,\"changed\":true}", "{\"value\":true,\"changed\":true}",
            "{\"value\":1.5,\"changed\":false}", "{\"value\":\"128\",\"changed\":true}"] {
            XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetResult.validated(raw))
        }
        for value: Any in [-1, 32769, 1.5, true, "128"] {
            var invalid = witness; invalid["budgetPresent"] = true; invalid["budget"] = value
            XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalid))
        }
        var invalid = witness; invalid["budget"] = 0
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalid))
        invalid = witness; invalid["stampPresent"] = true; invalid["stamp"] = sentinel
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalid))

    }

    func testIsolatedEntitledAIKeychainAndLegacyKVSentinelsAreNeitherReadMigratedNorChanged() async throws {
        #if os(iOS)
        try await seed(configured())
        let account = "mindwtr-ai-key_gemini", bytes = Data(account.utf8)
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
        _ = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
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
        try await seed(["provider": "gemini", "enabled": false])
        let faults = HostIOFaults(), io = AIGeminiThinkingBudgetIO()
        faults.beforeSQL = { try io.beforeSQL($0) }
        let core = host(faults)
        await failure { try await core.configureIsolatedAIGeminiThinkingBudgetCommitFailureOnce() }
        _ = try await core.start()
        io.reset()
        _ = try await core.readAIGeminiThinkingBudgetOptions()
        XCTAssertGreaterThan(io.counts[0], 0, "Rejected arming must preserve the original SQL callback")
        await failure { try await core.configureIsolatedAIGeminiThinkingBudgetCommitFailureOnce() }
        await failure { _ = try await core.isolatedAIGeminiThinkingBudgetFixtureState() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    #endif

    func testAppProjectionOptionsWriteAndRefreshSequenceUsesSameHost() async throws {
        try await seed(configured())
        let core = host(); _ = try await core.start()
        let original = try await core.readAISettingsProjection()
        XCTAssertEqual(original.aiThinkingBudgetSavedValue, 123)
        let options = try await core.readAIGeminiThinkingBudgetOptions()
        let edit = NativeAIGeminiThinkingBudgetRequest(requestId: UUID().uuidString.lowercased(), value: .medium, expected: options.expected)
        let saved = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
        XCTAssertEqual(saved.value, .medium); XCTAssertTrue(saved.changed)
        let refreshed = try await core.readAISettingsProjection()
        XCTAssertEqual(refreshed.aiThinkingBudgetSavedValue, 256)
        XCTAssertEqual(refreshed.aiProvider, original.aiProvider); XCTAssertEqual(refreshed.aiEnabled, original.aiEnabled)
        let freshOptions = try await core.readAIGeminiThinkingBudgetOptions()
        XCTAssertEqual(freshOptions.value, 256)
        let noop = NativeAIGeminiThinkingBudgetRequest(requestId: UUID().uuidString.lowercased(), value: .medium, expected: freshOptions.expected)
        let unchanged = try await core.setAIGeminiThinkingBudget(noop, readmission: { true })
        XCTAssertFalse(unchanged.changed)
        let reopened = try await core.readAISettingsProjection()
        XCTAssertEqual(reopened, refreshed)
        XCTAssertEqual(try markerCount(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSavedCustomSurvivesReadAndAllFourExplicitChoicesWhileDisabled() async throws {
        try await seed(configured())
        for budget in [1, 123, 32768] {
            var savedAI = configured(); savedAI["thinkingBudget"] = budget; try replaceAI(savedAI)
            let passive = host(); _ = try await passive.start(); let beforeRead = try saved()
            let read = try await passive.readAIGeminiThinkingBudgetOptions()
            XCTAssertEqual(read.value, budget); XCTAssertEqual(read.expected.budget, budget)
            XCTAssertEqual(try saved(), beforeRead); XCTAssertEqual(try markerCount(), 0); await passive.close()
        }
        try replaceAI(configured())
        let io = AIGeminiThinkingBudgetIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let before = try saved(), options = try await core.readAIGeminiThinkingBudgetOptions()
        XCTAssertEqual(options.value, 123); XCTAssertEqual(options.expected.budget, 123)
        XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        for value: NativeAIGeminiThinkingBudgetValue in [.off, .low, .medium, .high] {
            let prior = try savedSettings(), edit = try await request(core, value: value)
            _ = try await core.setAIGeminiThinkingBudget(edit, readmission: { true })
            let saved = try savedSettings(), ai = try XCTUnwrap(saved["ai"] as? [String: Any])
            XCTAssertEqual(ai["thinkingBudget"] as? Int, value.rawValue)
            XCTAssertEqual(ai["enabled"] as? Bool, false); XCTAssertEqual(ai["requestTimeoutSeconds"] as? Int, 120)
            var expected = prior, previousAI = try XCTUnwrap(prior["ai"] as? [String: Any])
            previousAI["thinkingBudget"] = value.rawValue; expected["ai"] = previousAI
            var comparison = saved; comparison["syncPreferencesUpdatedAt"] = prior["syncPreferencesUpdatedAt"]
            XCTAssertEqual(try json(comparison), try json(expected))
        }
        XCTAssertEqual(try markerCount(), 4)
    }

    func testNonGeminiAndAbsentProvidersRefuseWithoutMaterializingDefaults() async throws {
        try await seed(configured())
        let first = host(); _ = try await first.start()
        let original = try await request(first, value: .medium); await first.close()
        for ai: [String: Any] in [["provider": "openai", "thinkingBudget": 123], ["provider": "anthropic", "thinkingBudget": 123],
            ["thinkingBudget": 123, "enabled": false], [:]] {
            try replaceAI(ai)
            let io = AIGeminiThinkingBudgetIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
            await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }
            await failure { _ = try await core.setAIGeminiThinkingBudget(original, readmission: { true }) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0]); await core.close()
        }
    }

    func testThreeAISettingsOwnersExcludeEachOtherAndBothForeignReceiptsRefuseBudgetAuthority() async throws {
        try await seed(configured())
        let gemini = host(); _ = try await gemini.start()
        let oldBudget = try await request(gemini, value: .medium); await gemini.close()
        var openAI = configured(); openAI["provider"] = "openai"; try replaceAI(openAI)
        let effortHost = host(); _ = try await effortHost.start()
        let effortOptions = try await effortHost.readAIReasoningEffortOptions()
        let effort = NativeAIReasoningEffortRequest(requestId: UUID().uuidString.lowercased(), value: .high, expected: effortOptions.expected)
        let enteredEffort = expectation(description: "effort held"), effortGate = AIGeminiThinkingBudgetReadmissionGate(enteredEffort)
        let effortWork = Task { try await effortHost.setAIReasoningEffort(effort, readmission: { await effortGate.wait() }) }
        await fulfillment(of: [enteredEffort], timeout: 10)
        await failure { _ = try await effortHost.readAIGeminiThinkingBudgetOptions() }
        await failure { _ = try await effortHost.setAIGeminiThinkingBudget(oldBudget, readmission: { true }) }
        await failure { _ = try await effortHost.readAIRequestTimeoutOptions() }
        await failure { _ = try await effortHost.retryPending() }
        effortWork.cancel(); await effortGate.cancel(); await failure { _ = try await effortWork.value }
        _ = try await effortHost.setAIReasoningEffort(effort, readmission: { true }); await effortHost.close()
        var configuredGemini = try XCTUnwrap(try savedSettings()["ai"] as? [String: Any]); configuredGemini["provider"] = "gemini"; try replaceAI(configuredGemini)
        let core = host(); _ = try await core.start()
        let timeoutOptions = try await core.readAIRequestTimeoutOptions(), id = UUID().uuidString.lowercased()
        let timeout = NativeAIRequestTimeoutRequest(requestId: id, value: 60, expected: timeoutOptions.expected)
        let enteredTimeout = expectation(description: "timeout held"), timeoutGate = AIGeminiThinkingBudgetReadmissionGate(enteredTimeout)
        let timeoutWork = Task { try await core.setAIRequestTimeout(timeout, readmission: { await timeoutGate.wait() }) }
        await fulfillment(of: [enteredTimeout], timeout: 10)
        await failure { _ = try await core.readAIGeminiThinkingBudgetOptions() }
        await failure { _ = try await core.setAIGeminiThinkingBudget(oldBudget, readmission: { true }) }
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        await failure { _ = try await core.retryPending() }
        timeoutWork.cancel(); await timeoutGate.cancel(); await failure { _ = try await timeoutWork.value }
        let edit = try await request(core, value: .medium)
        let enteredBudget = expectation(description: "budget held"), budgetGate = AIGeminiThinkingBudgetReadmissionGate(enteredBudget)
        let budgetWork = Task { try await core.setAIGeminiThinkingBudget(edit, readmission: { await budgetGate.wait() }) }
        await fulfillment(of: [enteredBudget], timeout: 10)
        let before = try saved()
        await failure { _ = try await core.readAIRequestTimeoutOptions() }
        await failure { _ = try await core.setAIRequestTimeout(timeout, readmission: { true }) }
        await failure { _ = try await core.readAIReasoningEffortOptions() }
        await failure { _ = try await core.setAIReasoningEffort(effort, readmission: { true }) }
        await failure { _ = try await core.readAIProviderDeviceState() }
        await failure { _ = try await core.retryPending() }
        budgetWork.cancel(); await budgetGate.cancel(); await failure { _ = try await budgetWork.value }
        XCTAssertEqual(try saved(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.setAIRequestTimeout(timeout, readmission: { true })
        let options = try await core.readAIGeminiThinkingBudgetOptions()
        for foreignID in [id, effort.requestId] {
            let forged = NativeAIGeminiThinkingBudgetRequest(requestId: foreignID, value: .low, expected: options.expected)
            let savedBefore = try saved()
            await failure { _ = try await core.setAIGeminiThinkingBudget(forged, readmission: { true }) }
            XCTAssertEqual(try saved(), savedBefore)
        }
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 2)
    }

    private final class RetainedGeminiOwner {
        weak var facade: CoreHost?
        weak var engine: AnyObject?
        var context: JSContext?, fence: (() -> Void)?
        var observedEngine = false
    }
    private func retainBudgetOwnerAfterClose() async throws -> RetainedGeminiOwner {
        let suffix = """
        ;(() => {
            const options = MindwtrHost.iosAIGeminiThinkingBudgetOptions;
            MindwtrHost.iosAIGeminiThinkingBudgetOptions = function(input, owner) {
                globalThis.__retainedGeminiOwner = owner; return options.call(this, input, owner);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let retained = RetainedGeminiOwner(), faults = HostIOFaults()
        faults.configureRuntimeLifetime = { [weak retained] engine, context, _ in
            retained?.engine = engine; retained?.context = context as? JSContext; retained?.observedEngine = true
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AIGeminiThinkingBudgetNoHTTP.self]
        faults.httpConfiguration = configuration; faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        retained.facade = core; retained.fence = core.aiGeminiThinkingBudgetQueueFenceForTests()
        do { _ = try await core.start(); _ = try await core.readAIGeminiThinkingBudgetOptions() }
        catch { await core.close(); throw error }
        await core.close(); return retained
    }
    func testClosedRuntimeRejectsRetainedOwnerCallbackAndReleasesFacade() async throws {
        try await seed(["provider": "gemini", "enabled": false])
        let retained = try await retainBudgetOwnerAfterClose()
        try XCTUnwrap(retained.fence)()
        XCTAssertTrue(retained.observedEngine)
        XCTAssertNil(retained.facade); XCTAssertNil(retained.engine)
        guard retained.engine == nil else { return } // Baseline failure never calls an unsafe retained owner.
        let owner = try XCTUnwrap(retained.context?.objectForKeyedSubscript("__retainedGeminiOwner"))
        XCTAssertFalse(owner.isUndefined)
        XCTAssertEqual(owner.call(withArguments: [])?.toString(), "!MindwtrNativeError:AI Gemini thinking budget owner is unavailable")
    }
}
