import Foundation
import Security
import Darwin
import JavaScriptCore
import XCTest
@testable import MindwtrNativeCore

private actor ReadmittedSettingGate {
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

private final class ReadmittedSettingCancelSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (@Sendable () -> Void)?
    func arm(_ action: @escaping @Sendable () -> Void) { lock.lock(); self.action = action; lock.unlock() }
    func cancelOnce() { lock.lock(); let action = action; self.action = nil; lock.unlock(); action?() }
}

private final class ReadmittedSettingIO: @unchecked Sendable {
    private let lock = NSLock()
    private var commitFailure = false, removeFailure = false
    private var statements: [String] = [], journalWrites = 0, commitFailures = 0
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
        if failure { throw HostFailure("PRIVATE_SETTING_COMMIT_ERROR") }
    }
    func beforeJournal() { lock.lock(); journalWrites += 1; lock.unlock() }
    func beforeRemove() throws {
        lock.lock(); defer { lock.unlock() }
        if removeFailure { throw HostFailure("PRIVATE_SETTING_CLEAR_ERROR") }
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [statements.count, journalWrites, commitFailures] }
    var commitAttempts: Int { lock.lock(); defer { lock.unlock() }; return statements.filter { $0 == "COMMIT" }.count }
    var writeCounts: [Int] {
        lock.lock(); defer { lock.unlock() }
        let mutations = statements.filter { text in
            let verb = text.split(whereSeparator: { $0.isWhitespace }).first?.uppercased() ?? ""
            return ["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK", "VACUUM"].contains(verb)
        }.count
        return [mutations, journalWrites, commitFailures]
    }
}

private final class ReadmittedSettingNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("AI settings must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

private final class RetainedSettingOwner {
    weak var facade: CoreHost?
    weak var engine: AnyObject?
    var context: JSContext?, fence: (() -> Void)?
    var observedEngine = false
}

private struct ReadmittedSettingCase<Request: NativeAIReadmittedSettingRequest> {
    let marker: String
    let key: String
    let credential: String
    let provider: String
    let base: [String: Any]?
    let configured: [String: Any]
    let configuredValue: Any
    let fallback: Any
    let edited: Any
    let later: Any
    let failedCommits: Int?
    let malformed: [[String: Any]]
    let make: (String, Any, Request.Options) throws -> Request
    let reply: (Any, Bool) throws -> Request.Reply
    let value: (Request.Options) -> Any
    let saved: (Request.Options) -> Any?
    let projected: (NativeAISettingsProjection) -> Any
    var setting: NativeAIReadmittedSetting { Request.setting }
}

final class NativeAIReadmittedSettingTests: XCTestCase {
    private static let timeout = ReadmittedSettingCase<NativeAIRequestTimeoutRequest>(
        marker: "v1.3.5/ios-ai-request-timeout", key: "requestTimeoutSeconds", credential: "openai", provider: "openai", base: nil,
        configured: ["provider": "anthropic", "enabled": true, "reasoningEffort": "high", "thinkingBudget": 2048], configuredValue: 120,
        fallback: 30, edited: 60, later: 120, failedCommits: nil, malformed: [["requestTimeoutSeconds": 31]],
        make: { try NativeAIRequestTimeoutRequest(requestId: $0, value: XCTUnwrap($1 as? Int), expected: $2.expected) },
        reply: { try NativeAIRequestTimeoutResult(value: XCTUnwrap($0 as? Int), changed: $1) },
        value: { $0.value }, saved: { $0.expected.timeout }, projected: { $0.aiRequestTimeoutSeconds })
    private static let effort = ReadmittedSettingCase<NativeAIReasoningEffortRequest>(
        marker: "v1.3.5/ios-ai-reasoning-effort", key: "reasoningEffort", credential: "openai", provider: "openai", base: nil,
        configured: ["provider": "openai", "enabled": false, "reasoningEffort": "minimal", "thinkingBudget": 2048], configuredValue: "minimal",
        fallback: "low", edited: "medium", later: "high", failedCommits: 5, malformed: [["reasoningEffort": 31]],
        make: { try NativeAIReasoningEffortRequest(requestId: $0, value: XCTUnwrap(($1 as? String).flatMap(NativeAIReasoningEffortValue.init(rawValue:))), expected: $2.expected) },
        reply: { try NativeAIReasoningEffortResult(value: XCTUnwrap(($0 as? String).flatMap(NativeAIReasoningEffortValue.init(rawValue:))), changed: $1) },
        value: { $0.value.rawValue }, saved: { $0.expected.effort?.rawValue }, projected: { $0.aiReasoningEffortSavedValue.rawValue })
    private static let gemini = ReadmittedSettingCase<NativeAIGeminiThinkingBudgetRequest>(
        marker: "v1.3.5/ios-ai-gemini-thinking-budget", key: "thinkingBudget", credential: "gemini", provider: "gemini",
        base: ["provider": "gemini", "enabled": false],
        configured: ["provider": "gemini", "enabled": false, "thinkingBudget": 123, "reasoningEffort": "minimal"], configuredValue: 123,
        fallback: 0, edited: 256, later: 512, failedCommits: 5,
        malformed: [["thinkingBudget": 1.5], ["provider": "gemini", "thinkingBudget": -1], ["provider": "gemini", "thinkingBudget": 32769]],
        make: { try NativeAIGeminiThinkingBudgetRequest(requestId: $0, value: XCTUnwrap(($1 as? Int).flatMap(NativeAIGeminiThinkingBudgetValue.init(rawValue:))), expected: $2.expected) },
        reply: { try NativeAIGeminiThinkingBudgetResult(value: XCTUnwrap(($0 as? Int).flatMap(NativeAIGeminiThinkingBudgetValue.init(rawValue:))), changed: $1) },
        value: { $0.value }, saved: { $0.expected.budget }, projected: { $0.aiThinkingBudgetSavedValue })

    private var source: String!, root: URL!, bundle: URL!, service: String!
    private var roots: [URL] = []
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL {
        root.appendingPathComponent("device/Library/Application Support/mindwtr.ai.fixture/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private let sentinel = "PRIVATE590-SENTINEL"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        source = path
    }
    override func tearDownWithError() throws {
        for root in roots { try FileManager.default.removeItem(at: root) }
    }
    private func prepare() throws {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let created = support.appendingPathComponent("NativeAIReadmittedSettingTests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: created, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(created.path, nil) else { throw HostFailure("AI fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true); roots.append(root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("device"), withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: source), to: bundle)
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
    }
    private func host(_ faults: HostIOFaults = HostIOFaults(), io: ReadmittedSettingIO? = nil) -> CoreHost {
        if let io {
            faults.beforeSQL = { try io.beforeSQL($0) }; faults.journalWrite = { io.beforeJournal() }; faults.journalRemove = { try io.beforeRemove() }
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ReadmittedSettingNoHTTP.self]; faults.httpConfiguration = configuration
        faults.notificationAuthorizationRequest = { XCTFail("AI settings must not request notification permission"); throw HostFailure("No permission port") }
        faults.cryptoBeforeOperation = { _ in XCTFail("AI settings must not use crypto") }
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
    private func same(_ lhs: Any?, _ rhs: Any) -> Bool {
        guard let lhs else { return false }
        return (lhs as AnyObject).isEqual(rhs)
    }
    private func seed<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>, _ ai: [String: Any]) async throws {
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
        try Data(json(["mindwtr-ai-key:" + c.credential: sentinel, "mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]).utf8).write(to: manifest)
    }
    private func seedBase<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        if let base = c.base { try await seed(c, base) }
    }
    private func configured<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) -> [String: Any] {
        let shared: [String: Any] = ["requestTimeoutSeconds": 120, "model": sentinel, "copilotModel": sentinel,
            "baseUrl": "https://" + sentinel, "openAIExtraBodyParams": ["opaque": sentinel],
            "speechToText": ["provider": "parakeet", "enabled": true, "model": sentinel,
                "baseUrl": sentinel, "language": sentinel, "offlineModelPath": sentinel,
                "mode": "transcribe_only", "fieldStrategy": "title_only"]]
        return shared.merging(c.configured) { $1 }
    }
    private func request<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>, _ core: CoreHost, _ value: Any,
                            id: String = UUID().uuidString.lowercased()) async throws -> R {
        let options = try await core.readAIReadmittedSettingOptions(R.self)
        return try c.make(id, value, options)
    }
    private func markerCount<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) throws -> Int {
        try log().components(separatedBy: "\n").filter { $0.contains(c.marker) }.count
    }
    private func savedSettings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func replaceAI(_ value: [String: Any]) throws {
        var settings = try savedSettings(); settings["ai"] = value
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }

    func testAbsentDefaultWritesExplicitlyAndExplicitDefaultNoopCreatesNoJournalOrReceipt() async throws {
        try await absentDefaultWritesExplicitly(Self.timeout)
        try await absentDefaultWritesExplicitly(Self.effort)
        try await absentDefaultWritesExplicitly(Self.gemini)
    }
    private func absentDefaultWritesExplicitly<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let first = try await core.readAIReadmittedSettingOptions(R.self), second = try await core.readAIReadmittedSettingOptions(R.self)
        XCTAssertEqual(first, second); XCTAssertTrue(same(c.value(first), c.fallback)); XCTAssertNil(c.saved(first))
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try markerCount(c), 0)
        let write = try c.make(UUID().uuidString.lowercased(), c.fallback, first)
        let changed = try await core.setAIReadmittedSetting(write, readmission: { true })
        XCTAssertEqual(changed, try c.reply(c.fallback, true)); XCTAssertEqual(try markerCount(c), 1)
        let noop = try await request(c, core, c.fallback), before = try saved(); io.reset()
        let unchanged = try await core.setAIReadmittedSetting(noop, readmission: { true })
        XCTAssertEqual(unchanged, try c.reply(c.fallback, false)); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testPrivateSettingsAndRawRowsSurviveWriteWithoutKVOrSecretAccess() async throws {
        try await privateSettingsSurvive(Self.timeout)
        try await privateSettingsSurvive(Self.effort)
        try await privateSettingsSurvive(Self.gemini)
    }
    private func privateSettingsSurvive<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seed(c, configured(c))
        let faults = HostIOFaults(); var secrets = 0, deviceWrites = 0, configuredStorage = false
        faults.secretBeforeOperation = { _, _ in secrets += 1 }
        faults.configureDeviceStorage = { storage in configuredStorage = true; storage.faults.beforePromotion = { deviceWrites += 1 } }
        let core = host(faults); _ = try await core.start(); secrets = 0; deviceWrites = 0
        XCTAssertTrue(configuredStorage, "Must exercise an admitted real device storage port")
        let before = try savedSettings(), beforeRows = try json(rows("SELECT * FROM tasks")), manifestBefore = try Data(contentsOf: manifest)
        XCTAssertFalse(try rows("SELECT * FROM tasks").isEmpty)
        XCTAssertEqual(try rows("SELECT contexts FROM tasks").first?["contexts"] as? String, "[ \"@raw\" ]")
        let edit = try await request(c, core, c.edited)
        let result = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertEqual(result, try c.reply(c.edited, true))
        var expected = before; var ai = try XCTUnwrap(before["ai"] as? [String: Any]); ai[c.key] = c.edited; expected["ai"] = ai
        var after = try savedSettings(); after["syncPreferencesUpdatedAt"] = before["syncPreferencesUpdatedAt"]
        XCTAssertEqual(try json(after), try json(expected)); XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertEqual(try Data(contentsOf: manifest), manifestBefore); XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0)
        XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(sentinel))
    }

    func testGenericAndMenuRoutesDenyAllPrivateMethodsWithoutJournalOrMarker() async throws {
        try await genericRoutesDeny(Self.timeout)
        try await genericRoutesDeny(Self.effort)
        try await genericRoutesDeny(Self.gemini)
    }
    private func genericRoutesDeny<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
        let name = c.setting.rawValue
        for method in [name, name + "Options", name + "Prepare", name + "Validate", name + "Commit", name + "RetryOutcome", name + "Acknowledged"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
            for dispatch in ["menuRead", "menuCommand"] { await failure { _ = try await core.call(dispatch, argumentsJSON: json([method, "{}"])) } }
        }
        XCTAssertEqual(io.writeCounts, [0, 0, 0]); XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
    }

    func testExternalWriterDuringReadmissionRetiresOwnerUntilNewHostLoad() async throws {
        try await externalWriterRetiresOwner(Self.timeout)
        try await externalWriterRetiresOwner(Self.effort)
        try await externalWriterRetiresOwner(Self.gemini)
    }
    private func externalWriterRetiresOwner<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let core = host(); _ = try await core.start(); let edit = try await request(c, core, c.edited)
        let entered = expectation(description: "readmission"), gate = ReadmittedSettingGate(entered)
        let work = Task { try await core.setAIReadmittedSetting(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        try replaceAI(["provider": c.provider, c.key: c.later]); let before = try saved()
        await gate.setActive(true); await failure { _ = try await work.value }
        await failure { _ = try await core.readAIReadmittedSettingOptions(R.self) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIReadmittedSettingOptions(R.self); XCTAssertTrue(same(c.value(options), c.later))
    }

    func testExternalCommitInsideFullReadCannotRehabilitateAdapterEpochOnNextOptionsRead() async throws {
        try await externalCommitInsideRead(Self.timeout)
        try await externalCommitInsideRead(Self.effort)
        try await externalCommitInsideRead(Self.gemini)
    }
    private func externalCommitInsideRead<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var settingsReads = 0, raced = false
        faults.beforeSQL = { sql in
            if sql == "SELECT data FROM settings WHERE id = 1" {
                settingsReads += 1
                if settingsReads == 2 { raced = true; try self.replaceAI(["provider": c.provider, c.key: c.later]) }
            }
        }
        await failure { _ = try await core.readAIReadmittedSettingOptions(R.self) }; XCTAssertTrue(raced)
        faults.beforeSQL = nil; let before = try saved()
        await failure { _ = try await core.readAIReadmittedSettingOptions(R.self) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0); await core.close()
        let replacement = host(); _ = try await replacement.start()
        let options = try await replacement.readAIReadmittedSettingOptions(R.self); XCTAssertTrue(same(c.value(options), c.later))
    }

    func testCancellationBeforeReadmissionCreatesNoJournalAndConcurrentOwnerIsDenied() async throws {
        try await cancellationBeforeReadmission(Self.timeout)
        try await cancellationBeforeReadmission(Self.effort)
        try await cancellationBeforeReadmission(Self.gemini)
    }
    private func cancellationBeforeReadmission<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let core = host(); _ = try await core.start(); let edit = try await request(c, core, c.edited), before = try saved()
        let entered = expectation(description: "readmission"), gate = ReadmittedSettingGate(entered)
        let work = Task { try await core.setAIReadmittedSetting(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        await failure { _ = try await core.setAIReadmittedSetting(edit, readmission: { true }) }
        await failure { _ = try await core.readAISettingsProjection() }
        work.cancel(); await gate.cancel(); await failure { _ = try await work.value }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActualCommitFailureKeepsExactJournalRawSnapshotAndTypedWarmRetryAcknowledgesOnce() async throws {
        try await actualCommitFailureKeepsJournal(Self.timeout)
        try await actualCommitFailureKeepsJournal(Self.effort)
        try await actualCommitFailureKeepsJournal(Self.gemini)
    }
    private func actualCommitFailureKeepsJournal<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seed(c, configured(c))
        let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start()
        let edit = try await request(c, core, c.edited), before = try saved(); io.reset(); io.failCommit(true)
        await failure { _ = try await core.setAIReadmittedSetting(edit, readmission: { true }) }
        if let failedCommits = c.failedCommits {
            XCTAssertEqual(io.counts[2], failedCommits); XCTAssertEqual(io.commitAttempts, failedCommits)
        } else { XCTAssertGreaterThan(io.counts[2], 0) }
        XCTAssertEqual(try saved(), before)
        let frozen = try Data(contentsOf: journal), object = try self.object(String(decoding: frozen, as: UTF8.self))
        XCTAssertEqual(object["method"] as? String, c.setting.rawValue + "Commit")
        XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(sentinel)); XCTAssertEqual(try markerCount(c), 0)
        await failure { _ = try await core.readAIReadmittedSettingOptions(R.self) }
        XCTAssertEqual(try Data(contentsOf: journal), frozen)
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try saved(), before)
        io.failCommit(false)
        let result = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertEqual(result, try c.reply(c.edited, true)); XCTAssertEqual(try markerCount(c), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        guard let failedCommits = c.failedCommits else { return }
        XCTAssertEqual(io.commitAttempts, failedCommits + 1)
        let acknowledged = try await core.setAIReadmittedSetting(edit, readmission: { XCTFail("Known receipt must not re-admit a write"); return false })
        XCTAssertEqual(acknowledged, result); XCTAssertEqual(io.commitAttempts, failedCommits + 1)
    }

    func testCancellationAfterJournalAndActualCommitFailureRetainsExactWarmRetryAndRejectsGenericRecovery() async throws {
        try await cancellationAfterJournal(Self.timeout)
        try await cancellationAfterJournal(Self.effort)
        try await cancellationAfterJournal(Self.gemini)
    }
    private func cancellationAfterJournal<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seed(c, configured(c))
        let commit = c.setting.rawValue + "Commit"
        let suffix = """
        ;(() => {
            const commit = MindwtrHost.\(commit), poll = MindwtrHost.poll, cancel = MindwtrHost.cancel;
            let first = true, held = null, terminal = null, released = false;
            MindwtrHost.\(commit) = function(...args) {
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
        let io = ReadmittedSettingIO(), core = host(io: io), hooks = NativeAttachmentHostHooks(), cancellation = ReadmittedSettingCancelSignal()
        hooks.pump = { if io.counts[1] > 0 && io.counts[2] > 0 { cancellation.cancelOnce() } }
        try await core.configureAttachmentHost(hooks); _ = try await core.start()
        let edit = try await request(c, core, c.edited), before = try saved(), beforeRows = try json(rows("SELECT * FROM tasks"))
        io.failCommit(true)
        let entered = expectation(description: "readmission before published commit"), gate = ReadmittedSettingGate(entered)
        let work = Task { try await core.setAIReadmittedSetting(edit, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10); cancellation.arm { work.cancel() }; await gate.setActive(true)
        do { _ = try await work.value; XCTFail("Cancelled uncertain save must not report success") }
        catch is CancellationError { }
        catch { XCTFail("Expected owned commit cancellation") }
        XCTAssertGreaterThan(io.counts[2], 0); XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
        let frozen = try Data(contentsOf: journal)
        XCTAssertFalse(String(decoding: frozen, as: UTF8.self).contains(sentinel))
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); XCTAssertEqual(try saved(), before)
        io.failCommit(false)
        let result = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertEqual(result, try c.reply(c.edited, true)); XCTAssertEqual(try markerCount(c), 1)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), beforeRows)
        XCTAssertTrue(try json(savedSettings()).contains(sentinel))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testColdReceiptlessJournalRefusesEvenWhenSavedTargetEqualsOrReturnsByABA() async throws {
        try await coldReceiptlessJournalRefuses(Self.timeout)
        try await coldReceiptlessJournalRefuses(Self.effort)
        try await coldReceiptlessJournalRefuses(Self.gemini)
    }
    private func coldReceiptlessJournalRefuses<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let io = ReadmittedSettingIO(), writer = host(io: io); _ = try await writer.start()
        let id = UUID().uuidString.lowercased()
        let edit = try await request(c, writer, c.edited, id: id), exactBaseline = try savedSettings(); io.failCommit(true)
        await failure { _ = try await writer.setAIReadmittedSetting(edit, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); await writer.close()
        for target in [c.edited, c.later, c.edited] {
            try replaceAI(["provider": c.provider, c.key: target]); try frozen.write(to: journal)
            let before = try saved(), cold = host(); _ = try await cold.start()
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
            await failure { _ = try await cold.probeAIReadmittedSettingOutcome(edit) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
        }
        try rows("UPDATE settings SET data=? WHERE id=1", [json(exactBaseline)]); try frozen.write(to: journal)
        let before = try saved(), exactCold = host(); _ = try await exactCold.start()
        let exactOptions = try await exactCold.readAIReadmittedSettingOptions(R.self)
        XCTAssertEqual(try c.make(id, c.edited, exactOptions), edit); XCTAssertFalse(same(c.value(exactOptions), c.edited))
        await failure { _ = try await exactCold.probeAIReadmittedSettingOutcome(edit) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostAcknowledgmentReopensReceiptAfterLaterEditWithoutOverwritingLaterValue() async throws {
        try await lostAcknowledgmentReopensReceipt(Self.timeout)
        try await lostAcknowledgmentReopensReceipt(Self.effort)
        try await lostAcknowledgmentReopensReceipt(Self.gemini)
    }
    private func lostAcknowledgmentReopensReceipt<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let io = ReadmittedSettingIO(), writer = host(io: io); _ = try await writer.start()
        let a = try await request(c, writer, c.edited); io.failRemove(true)
        await failure { _ = try await writer.setAIReadmittedSetting(a, readmission: { true }) }
        let frozen = try Data(contentsOf: journal); XCTAssertEqual(try markerCount(c), 0)
        io.failRemove(false)
        let aResult = try await writer.setAIReadmittedSetting(a, readmission: { true }); XCTAssertEqual(aResult, try c.reply(c.edited, true))
        let b = try await request(c, writer, c.later); _ = try await writer.setAIReadmittedSetting(b, readmission: { true }); await writer.close()
        let before = try saved(); try frozen.write(to: journal)
        let cold = host(), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, c.setting.rawValue + "Commit")
        XCTAssertEqual(try saved(), before)
        let options = try await cold.readAIReadmittedSettingOptions(R.self); XCTAssertTrue(same(c.value(options), c.later))
        let replay = try await cold.setAIReadmittedSetting(a, readmission: { XCTFail("Receipt replay must bypass readmission"); return false })
        XCTAssertEqual(replay, aResult); XCTAssertEqual(try saved(), before)
    }

    func testMalformedSavedLegacyControlsAndTypedTransportsRefuseWithoutPrivateValues() async throws {
        try await malformedSavedControlsRefuse(Self.timeout)
        try await malformedSavedControlsRefuse(Self.effort)
        try await malformedSavedControlsRefuse(Self.gemini)
    }
    private func malformedSavedControlsRefuse<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let initial = host(); _ = try await initial.start(); await initial.close()
        let malformed: [[String: Any]] = [["apiKey": NSNull()], ["apiKey": ""], ["provider": sentinel]] + c.malformed
        for ai in malformed {
            try replaceAI(ai); let core = host(); _ = try await core.start(); let before = try saved()
            do { _ = try await core.readAIReadmittedSettingOptions(R.self); XCTFail("Malformed raw AI must refuse") }
            catch { XCTAssertFalse(error.localizedDescription.contains(sentinel)) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try markerCount(c), 0); await core.close()
        }
        try replaceAI(configured(c))
        let typed = host(); _ = try await typed.start()
        let options = try await typed.readAIReadmittedSettingOptions(R.self), savedBefore = try saved()
        for invalidID in ["00000000-0000-4000-8000-00000000069A", String(repeating: "a", count: 3000)] {
            let invalid = try c.make(invalidID, c.edited, options)
            await failure { _ = try await typed.setAIReadmittedSetting(invalid, readmission: { true }) }
            XCTAssertEqual(try saved(), savedBefore); XCTAssertEqual(try markerCount(c), 0)
        }
        XCTAssertThrowsError(try R.options(String(repeating: " ", count: 2049)))
        XCTAssertThrowsError(try R.reply(String(repeating: " ", count: 1025)))
    }

    func testTypedValidatorsRefuseMalformedRepliesAndWitnesses() throws {
        let timeoutWitness: [String: Any] = ["aiPresent": false, "timeoutPresent": false, "timeout": NSNull(), "providerPresent": false,
            "provider": NSNull(), "stampPresent": false, "stamp": NSNull()]
        _ = try NativeAIRequestTimeoutOptions.validated(json(["value": 30, "expected": timeoutWitness]))
        for raw in ["{\"value\":31,\"changed\":true}", "{\"value\":60,\"changed\":true,\"secret\":1}",
            "{\"value\":60,\"value\":120,\"changed\":true}", "{\"value\":true,\"changed\":true}"] {
            XCTAssertThrowsError(try NativeAIRequestTimeoutResult.validated(raw))
        }
        var invalidTimeout = timeoutWitness; invalidTimeout["timeout"] = 30
        XCTAssertThrowsError(try NativeAIRequestTimeoutWitness.validated(invalidTimeout))
        invalidTimeout = timeoutWitness; invalidTimeout["stampPresent"] = true; invalidTimeout["stamp"] = sentinel
        XCTAssertThrowsError(try NativeAIRequestTimeoutWitness.validated(invalidTimeout))

        let effortWitness: [String: Any] = ["aiPresent": false, "effortPresent": false, "effort": NSNull(), "providerPresent": false,
            "provider": NSNull(), "stampPresent": false, "stamp": NSNull()]
        _ = try NativeAIReasoningEffortOptions.validated(json(["value": "low", "expected": effortWitness]))
        for raw in ["{\"value\":\"minimal\",\"changed\":true}", "{\"value\":\"medium\",\"changed\":true,\"secret\":1}",
            "{\"value\":\"medium\",\"value\":\"high\",\"changed\":true}", "{\"value\":true,\"changed\":true}",
            "{\"value\":\"future\",\"changed\":false}"] {
            XCTAssertThrowsError(try NativeAIReasoningEffortResult.validated(raw))
        }
        var invalidEffort = effortWitness; invalidEffort["effort"] = "low"
        XCTAssertThrowsError(try NativeAIReasoningEffortWitness.validated(invalidEffort))
        invalidEffort = effortWitness; invalidEffort["stampPresent"] = true; invalidEffort["stamp"] = sentinel
        XCTAssertThrowsError(try NativeAIReasoningEffortWitness.validated(invalidEffort))

        let budgetWitness: [String: Any] = ["aiPresent": true, "budgetPresent": false, "budget": NSNull(), "providerPresent": true,
            "provider": "gemini", "stampPresent": false, "stamp": NSNull()]
        _ = try NativeAIGeminiThinkingBudgetOptions.validated(json(["value": 0, "expected": budgetWitness]))
        for raw in ["{\"value\":123,\"changed\":true}", "{\"value\":256,\"changed\":true,\"secret\":1}",
            "{\"value\":256,\"value\":512,\"changed\":true}", "{\"value\":true,\"changed\":true}",
            "{\"value\":1.5,\"changed\":false}", "{\"value\":\"128\",\"changed\":true}"] {
            XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetResult.validated(raw))
        }
        for value: Any in [-1, 32769, 1.5, true, "128"] {
            var invalid = budgetWitness; invalid["budgetPresent"] = true; invalid["budget"] = value
            XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalid))
        }
        var invalidBudget = budgetWitness; invalidBudget["budget"] = 0
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalidBudget))
        invalidBudget = budgetWitness; invalidBudget["stampPresent"] = true; invalidBudget["stamp"] = sentinel
        XCTAssertThrowsError(try NativeAIGeminiThinkingBudgetWitness.validated(invalidBudget))
    }

    func testIsolatedEntitledAIKeychainAndLegacyKVSentinelsAreNeitherReadMigratedNorChanged() async throws {
        #if os(iOS)
        try await keychainSentinelsSurvive(Self.timeout)
        try await keychainSentinelsSurvive(Self.effort)
        try await keychainSentinelsSurvive(Self.gemini)
        #else
        throw XCTSkip("Requires the entitled physical iPhone12 test host")
        #endif
    }
    #if os(iOS)
    private func keychainSentinelsSurvive<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seed(c, configured(c))
        let account = "mindwtr-ai-key_" + c.credential, bytes = Data(account.utf8)
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
        let before = try Data(contentsOf: manifest), edit = try await request(c, core, c.edited)
        _ = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertEqual(operations, 0); XCTAssertEqual(deviceWrites, 0); XCTAssertEqual(try Data(contentsOf: manifest), before)
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, Data(sentinel.utf8))
    }
    #endif

    #if DEBUG && os(iOS) && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    func testAppCommitFaultSeamRefusesForeignLibraryWithoutReplacingExistingFaultAndLateArm() async throws {
        try await commitFaultSeamRefuses(Self.timeout)
        try await commitFaultSeamRefuses(Self.effort)
        try await commitFaultSeamRefuses(Self.gemini)
    }
    private func commitFaultSeamRefuses<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let faults = HostIOFaults(), io = ReadmittedSettingIO()
        faults.beforeSQL = { try io.beforeSQL($0) }
        let core = host(faults)
        await failure { try await core.configureIsolatedAIReadmittedSettingCommitFailureOnce(c.setting) }
        _ = try await core.start()
        io.reset()
        _ = try await core.readAIReadmittedSettingOptions(R.self)
        XCTAssertGreaterThan(io.counts[0], 0, "Rejected arming must preserve the original SQL callback")
        await failure { try await core.configureIsolatedAIReadmittedSettingCommitFailureOnce(c.setting) }
        await failure { _ = try await core.isolatedAIReadmittedSettingFixtureState(c.setting) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    #endif

    func testAppProjectionOptionsWriteAndRefreshSequenceUsesSameHost() async throws {
        try await projectionOptionsWriteAndRefresh(Self.timeout)
        try await projectionOptionsWriteAndRefresh(Self.effort)
        try await projectionOptionsWriteAndRefresh(Self.gemini)
    }
    private func projectionOptionsWriteAndRefresh<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seed(c, configured(c))
        let core = host(); _ = try await core.start()
        let original = try await core.readAISettingsProjection()
        XCTAssertTrue(same(c.projected(original), c.configuredValue))
        let options = try await core.readAIReadmittedSettingOptions(R.self)
        let edit = try c.make(UUID().uuidString.lowercased(), c.edited, options)
        let written = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertEqual(written, try c.reply(c.edited, true))
        let refreshed = try await core.readAISettingsProjection()
        XCTAssertTrue(same(c.projected(refreshed), c.edited))
        XCTAssertEqual(refreshed.aiProvider, original.aiProvider); XCTAssertEqual(refreshed.aiEnabled, original.aiEnabled)
        let freshOptions = try await core.readAIReadmittedSettingOptions(R.self)
        XCTAssertTrue(same(c.value(freshOptions), c.edited))
        let noop = try c.make(UUID().uuidString.lowercased(), c.edited, freshOptions)
        let unchanged = try await core.setAIReadmittedSetting(noop, readmission: { true })
        XCTAssertEqual(unchanged, try c.reply(c.edited, false))
        let reopened = try await core.readAISettingsProjection()
        XCTAssertEqual(reopened, refreshed)
        XCTAssertEqual(try markerCount(c), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSavedValueSurvivesReadAndEveryExplicitChoiceWhileDisabled() async throws {
        try await savedValueSurvivesEveryChoice(Self.effort, savedValues: [], choices: ["low", "medium", "high"])
        try await savedValueSurvivesEveryChoice(Self.gemini, savedValues: [1, 123, 32768], choices: [0, 128, 256, 512])
    }
    private func savedValueSurvivesEveryChoice<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>, savedValues: [Any], choices: [Any]) async throws {
        try prepare(); try await seed(c, configured(c))
        for value in savedValues {
            var savedAI = configured(c); savedAI[c.key] = value; try replaceAI(savedAI)
            let passive = host(); _ = try await passive.start(); let beforeRead = try saved()
            let read = try await passive.readAIReadmittedSettingOptions(R.self)
            XCTAssertTrue(same(c.value(read), value)); XCTAssertTrue(same(c.saved(read), value))
            XCTAssertEqual(try saved(), beforeRead); XCTAssertEqual(try markerCount(c), 0); await passive.close()
        }
        try replaceAI(configured(c))
        let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start(); io.reset()
        let before = try saved(), options = try await core.readAIReadmittedSettingOptions(R.self)
        XCTAssertTrue(same(c.value(options), c.configuredValue)); XCTAssertTrue(same(c.saved(options), c.configuredValue))
        XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0])
        for value in choices {
            let prior = try savedSettings(), edit = try await request(c, core, value)
            _ = try await core.setAIReadmittedSetting(edit, readmission: { true })
            let current = try savedSettings(), ai = try XCTUnwrap(current["ai"] as? [String: Any])
            XCTAssertTrue(same(ai[c.key], value))
            XCTAssertEqual(ai["enabled"] as? Bool, false); XCTAssertEqual(ai["requestTimeoutSeconds"] as? Int, 120)
            var expected = prior, previousAI = try XCTUnwrap(prior["ai"] as? [String: Any])
            previousAI[c.key] = value; expected["ai"] = previousAI
            var comparison = current; comparison["syncPreferencesUpdatedAt"] = prior["syncPreferencesUpdatedAt"]
            XCTAssertEqual(try json(comparison), try json(expected))
        }
        XCTAssertEqual(try markerCount(c), choices.count)
    }

    func testClosedRuntimeRejectsRetainedOwnerCallbackAndReleasesFacade() async throws {
        try await closedRuntimeRejectsRetainedOwner(Self.timeout)
        try await closedRuntimeRejectsRetainedOwner(Self.effort)
        try await closedRuntimeRejectsRetainedOwner(Self.gemini)
    }
    private func retainOwnerAfterClose<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws -> RetainedSettingOwner {
        let method = c.setting.rawValue + "Options"
        let suffix = """
        ;(() => {
            const options = MindwtrHost.\(method);
            MindwtrHost.\(method) = function(input, owner) {
                globalThis.__retainedSettingOwner = owner; return options.call(this, input, owner);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let retained = RetainedSettingOwner(), faults = HostIOFaults()
        faults.configureRuntimeLifetime = { [weak retained] engine, context, _ in
            retained?.engine = engine; retained?.context = context as? JSContext; retained?.observedEngine = true
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ReadmittedSettingNoHTTP.self]
        faults.httpConfiguration = configuration; faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        retained.facade = core; retained.fence = core.aiReadmittedSettingQueueFenceForTests()
        do { _ = try await core.start(); _ = try await core.readAIReadmittedSettingOptions(R.self) }
        catch { await core.close(); throw error }
        await core.close(); return retained
    }
    private func closedRuntimeRejectsRetainedOwner<R: NativeAIReadmittedSettingRequest>(_ c: ReadmittedSettingCase<R>) async throws {
        try prepare(); try await seedBase(c)
        let retained = try await retainOwnerAfterClose(c)
        try XCTUnwrap(retained.fence)()
        XCTAssertTrue(retained.observedEngine)
        XCTAssertNil(retained.facade); XCTAssertNil(retained.engine)
        guard retained.engine == nil else { return }
        let owner = try XCTUnwrap(retained.context?.objectForKeyedSubscript("__retainedSettingOwner"))
        XCTAssertFalse(owner.isUndefined)
        XCTAssertEqual(owner.call(withArguments: [])?.toString(), "!MindwtrNativeError:" + c.setting.subject + " owner is unavailable")
    }

    func testReasoningEffortRefusesNonOpenAIProvidersAndNeverMaterializesAbsentProvider() async throws {
        try prepare()
        let first = host(); _ = try await first.start(); await first.close()
        for provider in ["gemini", "anthropic"] {
            try replaceAI(["provider": provider, "reasoningEffort": "minimal"])
            let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
            await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0]); await core.close()
        }
        try replaceAI(["reasoningEffort": "minimal", "enabled": false])
        let core = host(); _ = try await core.start()
        let edit = try await request(Self.effort, core, "low")
        XCTAssertFalse(edit.expected.providerPresent)
        _ = try await core.setAIReadmittedSetting(edit, readmission: { true })
        XCTAssertNil((try savedSettings()["ai"] as? [String: Any])?["provider"])
    }

    func testGeminiThinkingBudgetRefusesNonGeminiAndAbsentProvidersWithoutMaterializingDefaults() async throws {
        try prepare(); try await seed(Self.gemini, configured(Self.gemini))
        let first = host(); _ = try await first.start()
        let original = try await request(Self.gemini, first, 256); await first.close()
        for ai: [String: Any] in [["provider": "openai", "thinkingBudget": 123], ["provider": "anthropic", "thinkingBudget": 123],
            ["thinkingBudget": 123, "enabled": false], [:]] {
            try replaceAI(ai)
            let io = ReadmittedSettingIO(), core = host(io: io); _ = try await core.start(); io.reset(); let before = try saved()
            await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIGeminiThinkingBudgetRequest.self) }
            await failure { _ = try await core.setAIReadmittedSetting(original, readmission: { true }) }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(io.writeCounts, [0, 0, 0]); await core.close()
        }
    }

    func testTimeoutAndEffortOwnersAreMutuallyExclusiveAndForeignReceiptCannotAuthorizeEffort() async throws {
        try prepare()
        let core = host(); _ = try await core.start()
        let timeoutOptions = try await core.readAIReadmittedSettingOptions(NativeAIRequestTimeoutRequest.self), id = UUID().uuidString.lowercased()
        let timeout = NativeAIRequestTimeoutRequest(requestId: id, value: 60, expected: timeoutOptions.expected)
        let enteredTimeout = expectation(description: "timeout held"), timeoutGate = ReadmittedSettingGate(enteredTimeout)
        let timeoutWork = Task { try await core.setAIReadmittedSetting(timeout, readmission: { await timeoutGate.wait() }) }
        await fulfillment(of: [enteredTimeout], timeout: 10)
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self) }
        await failure { _ = try await core.retryPending() }
        timeoutWork.cancel(); await timeoutGate.cancel(); await failure { _ = try await timeoutWork.value }
        let effort = try await request(Self.effort, core, "medium")
        let enteredEffort = expectation(description: "effort held"), effortGate = ReadmittedSettingGate(enteredEffort)
        let effortWork = Task { try await core.setAIReadmittedSetting(effort, readmission: { await effortGate.wait() }) }
        await fulfillment(of: [enteredEffort], timeout: 10)
        let before = try saved()
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIRequestTimeoutRequest.self) }
        await failure { _ = try await core.setAIReadmittedSetting(timeout, readmission: { true }) }
        await failure { _ = try await core.readAIProviderDeviceState() }
        await failure { _ = try await core.retryPending() }
        effortWork.cancel(); await effortGate.cancel(); await failure { _ = try await effortWork.value }
        XCTAssertEqual(try saved(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.setAIReadmittedSetting(timeout, readmission: { true })
        let options = try await core.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self)
        let forged = NativeAIReasoningEffortRequest(requestId: id, value: .low, expected: options.expected)
        let savedTimeout = try saved()
        await failure { _ = try await core.setAIReadmittedSetting(forged, readmission: { true }) }
        XCTAssertEqual(try saved(), savedTimeout); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testThreeAISettingsOwnersExcludeEachOtherAndBothForeignReceiptsRefuseBudgetAuthority() async throws {
        try prepare(); try await seed(Self.gemini, configured(Self.gemini))
        let gemini = host(); _ = try await gemini.start()
        let oldBudget = try await request(Self.gemini, gemini, 256); await gemini.close()
        var openAI = configured(Self.gemini); openAI["provider"] = "openai"; try replaceAI(openAI)
        let effortHost = host(); _ = try await effortHost.start()
        let effortOptions = try await effortHost.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self)
        let effort = NativeAIReasoningEffortRequest(requestId: UUID().uuidString.lowercased(), value: .high, expected: effortOptions.expected)
        let enteredEffort = expectation(description: "effort held"), effortGate = ReadmittedSettingGate(enteredEffort)
        let effortWork = Task { try await effortHost.setAIReadmittedSetting(effort, readmission: { await effortGate.wait() }) }
        await fulfillment(of: [enteredEffort], timeout: 10)
        await failure { _ = try await effortHost.readAIReadmittedSettingOptions(NativeAIGeminiThinkingBudgetRequest.self) }
        await failure { _ = try await effortHost.setAIReadmittedSetting(oldBudget, readmission: { true }) }
        await failure { _ = try await effortHost.readAIReadmittedSettingOptions(NativeAIRequestTimeoutRequest.self) }
        await failure { _ = try await effortHost.retryPending() }
        effortWork.cancel(); await effortGate.cancel(); await failure { _ = try await effortWork.value }
        _ = try await effortHost.setAIReadmittedSetting(effort, readmission: { true }); await effortHost.close()
        var configuredGemini = try XCTUnwrap(try savedSettings()["ai"] as? [String: Any]); configuredGemini["provider"] = "gemini"; try replaceAI(configuredGemini)
        let core = host(); _ = try await core.start()
        let timeoutOptions = try await core.readAIReadmittedSettingOptions(NativeAIRequestTimeoutRequest.self), id = UUID().uuidString.lowercased()
        let timeout = NativeAIRequestTimeoutRequest(requestId: id, value: 60, expected: timeoutOptions.expected)
        let enteredTimeout = expectation(description: "timeout held"), timeoutGate = ReadmittedSettingGate(enteredTimeout)
        let timeoutWork = Task { try await core.setAIReadmittedSetting(timeout, readmission: { await timeoutGate.wait() }) }
        await fulfillment(of: [enteredTimeout], timeout: 10)
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIGeminiThinkingBudgetRequest.self) }
        await failure { _ = try await core.setAIReadmittedSetting(oldBudget, readmission: { true }) }
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self) }
        await failure { _ = try await core.retryPending() }
        timeoutWork.cancel(); await timeoutGate.cancel(); await failure { _ = try await timeoutWork.value }
        let edit = try await request(Self.gemini, core, 256)
        let enteredBudget = expectation(description: "budget held"), budgetGate = ReadmittedSettingGate(enteredBudget)
        let budgetWork = Task { try await core.setAIReadmittedSetting(edit, readmission: { await budgetGate.wait() }) }
        await fulfillment(of: [enteredBudget], timeout: 10)
        let before = try saved()
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIRequestTimeoutRequest.self) }
        await failure { _ = try await core.setAIReadmittedSetting(timeout, readmission: { true }) }
        await failure { _ = try await core.readAIReadmittedSettingOptions(NativeAIReasoningEffortRequest.self) }
        await failure { _ = try await core.setAIReadmittedSetting(effort, readmission: { true }) }
        await failure { _ = try await core.readAIProviderDeviceState() }
        await failure { _ = try await core.retryPending() }
        budgetWork.cancel(); await budgetGate.cancel(); await failure { _ = try await budgetWork.value }
        XCTAssertEqual(try saved(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        _ = try await core.setAIReadmittedSetting(timeout, readmission: { true })
        let options = try await core.readAIReadmittedSettingOptions(NativeAIGeminiThinkingBudgetRequest.self)
        for foreignID in [id, effort.requestId] {
            let forged = NativeAIGeminiThinkingBudgetRequest(requestId: foreignID, value: .low, expected: options.expected)
            let savedBefore = try saved()
            await failure { _ = try await core.setAIReadmittedSetting(forged, readmission: { true }) }
            XCTAssertEqual(try saved(), savedBefore)
        }
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 2)
    }
}
