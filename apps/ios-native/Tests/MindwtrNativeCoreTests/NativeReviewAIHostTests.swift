import XCTest
import Security
import JavaScriptCore
@testable import MindwtrNativeCore

private final class ReviewAILocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ work: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; work(&stored) }
}

private final class ReviewAIHTTPState: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), stopped = DispatchSemaphore(value: 0)
    let requests = ReviewAILocked<[URLRequest]>([])
    private let responses = ReviewAILocked<[() -> Void]>([])
    var held = ReviewAILocked(false)
    var content = ReviewAILocked("{\"suggestions\":[{\"id\":\"legacy-task-ai-target\",\"action\":\"someday\",\"reason\":\"Reconsider later\"},{\"id\":\"legacy-task-ai-sibling\",\"action\":\"archive\",\"reason\":\"No longer needed\"}]}")
    func record(_ request: URLRequest, response: @escaping () -> Void) {
        requests.update { $0.append(request) }; entered.signal()
        if held.value { responses.update { $0.append(response) } } else { response() }
    }
    func release() {
        held.update { $0 = false }
        var pending: [() -> Void] = []; responses.update { pending = $0; $0.removeAll() }
        pending.forEach { $0() }
    }
}
private final class ReviewAIHTTPProtocol: URLProtocol {
    static let fixture = ReviewAILocked<ReviewAIHTTPState?>(nil)
    private let live = ReviewAILocked(true)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let state = Self.fixture.value else { return }
        state.record(request) { [weak self] in self?.respond(state) }
    }
    private func respond(_ state: ReviewAIHTTPState) {
        guard live.value else { return }
        let bytes = try! JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": state.content.value]]]])
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { live.update { $0 = false }; Self.fixture.value?.stopped.signal() }
}

final class NativeReviewAIHostTests: XCTestCase {
    private var directory: URL!
    private var bundle: URL!
    private var database: URL { directory.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let id = "legacy-task-ai-target"
    private let sibling = "legacy-task-ai-sibling"
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("MINDWTR_CORE_BUNDLE is required") }
        bundle = URL(fileURLWithPath: path)
        directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/task-ai-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let directory { try FileManager.default.removeItem(at: directory) } }

    private func createTask(_ core: CoreHost, title: String) async throws -> String {
        let open = try object(await core.call("captureOpen"))
        let capturedID = UUID().uuidString.lowercased()
        _ = try await core.call("captureSubmit", argumentsJSON: json([json(["captureId": capturedID, "text": title,
            "options": XCTUnwrap(open["options"]), "openAfterSave": false])]))
        return capturedID
    }

    private func fixture(faults: HostIOFaults = HostIOFaults(), state: ReviewAIHTTPState = ReviewAIHTTPState(),
                         suffix: String = "", contextSiblings: Int = 0) async throws -> (CoreHost, ReviewAIHTTPState, String) {
        let seed = CoreHost(databaseURL: database, bundleURL: bundle)
        _ = try await seed.start()
        let original = try await createTask(seed, title: "Target AI title")
        let originalSibling = try await createTask(seed, title: "Unrelated AI sibling"); await seed.close()
        let sqlite = try SQLiteBridge(url: database)
        // Cold-load bounded legacy IDs without changing a live core's backing rows.
        _ = try sqlite.execute("UPDATE tasks SET id=? WHERE id=?", parametersJSON: json([id, original]))
        _ = try sqlite.execute("UPDATE tasks SET id=? WHERE id=?", parametersJSON: json([sibling, originalSibling]))
        _ = try sqlite.execute("UPDATE tasks SET status='next',updatedAt='2025-01-01T00:00:00.000Z',createdAt='2025-01-01T00:00:00.000Z'")
        if contextSiblings > 0 {
            let at = "2026-10-30T00:00:00.000Z"
            _ = try sqlite.execute("INSERT INTO projects (id,title,status,color,createdAt,updatedAt) VALUES (?,?,?,?,?,?)", parametersJSON: json(["context-project", "Context project", "active", "#123456", at, at]))
            _ = try sqlite.execute("UPDATE tasks SET projectId=? WHERE id=?", parametersJSON: json(["context-project", id]))
            for index in 0..<contextSiblings {
                _ = try sqlite.execute("INSERT INTO tasks (id,title,status,projectId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)", parametersJSON: json(["context-\(index)", "Context \(index)", "next", "context-project", at, at]))
            }
        }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        var settings = try object(XCTUnwrap(rows.first?["data"] as? String))
        settings["ai"] = ["enabled": true, "provider": "openai", "model": "fixture", "requestTimeoutSeconds": 30]
        settings["language"] = "en"
        _ = try sqlite.execute("UPDATE settings SET data=? WHERE id=1", parametersJSON: json([json(settings)])); sqlite.close()
        let namespace = "tech.dongdongbh.mindwtr.task-ai-tests", container = directory.appendingPathComponent("container")
        let manifest = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["unrelated": "preserved"]).utf8).write(to: manifest)
        let service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased(); faults.secretService = service
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewAIHTTPProtocol.self]; faults.httpConfiguration = config
        ReviewAIHTTPProtocol.fixture.update { $0 = state }
        var selectedBundle = bundle!
        if !suffix.isEmpty {
            selectedBundle = directory.appendingPathComponent("fixture.js")
            try (String(contentsOf: bundle) + "\n" + suffix).write(to: selectedBundle, atomically: true, encoding: .utf8)
        }
        let core = CoreHost(databaseURL: database, bundleURL: selectedBundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }
        _ = try await core.start()
        return (core, state, service)
    }
    private func seedSecret(_ service: String, provider: String = "openai", value: String = "synthetic-selected") throws {
        let account = Data(("mindwtr-ai-key_" + provider).utf8)
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        #if os(macOS)
        query[kSecAttrAccount as String] = String(decoding: account, as: UTF8.self)
        #endif
        var item = query; item[kSecValueData as String] = Data(value.utf8); item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        addTeardownBlock { let status = SecItemDelete(query as CFDictionary); XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound) }
    }
    private func snapshot() throws -> String {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        var value: [String: Any] = [:]
        for name in ["tasks", "projects", "areas", "people", "sections", "settings", "saved_filters", "schema_migrations", "calendar_sync"] {
            value[name] = try NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM \(name) ORDER BY rowid").utf8))
        }
        return try json(value)
    }
    private func refused(_ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected refusal") } catch {}
    }
    private func wait(_ semaphore: DispatchSemaphore) async throws {
        let result = await Task.detached { semaphore.wait(timeout: .now() + 10) }.value
        XCTAssertEqual(result, .success)
        if result != .success { throw NativeTaskAIJSON.unavailable }
    }

    private func selection(_ answer: [String: Any], requestID: String = UUID().uuidString.lowercased()) throws -> String {
        let rows = try XCTUnwrap(answer["suggestions"] as? [[String: Any]])
        let suggestions: [[String: Any]] = try rows.map { row in
            ["id": try XCTUnwrap(row["id"]), "action": try XCTUnwrap(row["action"]), "reason": try XCTUnwrap(row["reason"])]
        }
        var revisions: [String: String] = [:]
        for row in rows { revisions[try XCTUnwrap(row["id"] as? String)] = try XCTUnwrap(row["taskRevision"] as? String) }
        return try json(["requestId": requestID, "suggestions": suggestions, "taskRevisions": revisions])
    }
    private func cancelApplyAfterReadmission(_ core: CoreHost, request: String) async throws {
        let reached = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        core.beforeReviewAIApplyEngine = { reached.signal(); _ = release.wait(timeout: .now() + 10) }
        let operation = Task { try await core.applyReviewAISuggestions(requestJSON: request,
            lease: NativeTaskAIEditorLease(), readmit: { true }) }
        try await wait(reached)
        operation.cancel(); release.signal()
        do { _ = try await operation.value; XCTFail("Expected definite pre-Engine refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Pre-Engine failure must be definite: \(error)") }
        core.beforeReviewAIApplyEngine = nil
    }
    func testApplyCancelledAfterReadmissionBeforeEngineIsDefiniteAndWritesNothing() async throws {
        let (core, state, _) = try await fixture(), before = try snapshot()
        let input = try json(["requestId": UUID().uuidString, "suggestions": [["id": id, "action": "someday", "reason": "Later"]],
            "taskRevisions": [id: "stale"]])
        try await cancelApplyAfterReadmission(core, request: input)
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(state.requests.value.count, 0)
        let retry = try await core.retryPending(); XCTAssertNil(retry)
        await core.close()
    }

    func testCanonicalAnalysisIsReadOnlyAndSelectedMixedApplySavesOnce() async throws {
        let (core, state, service) = try await fixture(); try seedSecret(service)
        let before = try snapshot()
        let handle = try await core.beginReviewAI(requestJSON: "{}", lease: NativeTaskAIEditorLease(), readmit: { true })
        let answer = try object(await core.awaitReviewAI(handle))
        XCTAssertTrue(answer["error"] is NSNull); XCTAssertEqual(answer["selectedIds"] as? [String], [id, sibling])
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let selected = try selection(answer), lease = NativeTaskAIEditorLease()
        let result = try object(await core.applyReviewAISuggestions(requestJSON: selected, lease: lease, readmit: { true }))
        XCTAssertEqual(result["changed"] as? Bool, true)
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT id,status FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: rows.map { ($0["id"] as! String, $0["status"] as! String) }), [id: "someday", sibling: "archived"])
        let saved = try snapshot()
        _ = try await core.applyReviewAISuggestions(requestJSON: selected, lease: lease, readmit: { true })
        XCTAssertEqual(try snapshot(), saved); XCTAssertEqual(state.requests.value.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        for method in ["iosReviewAIWitness", "iosReviewAIRequest", "iosReviewAIApply", "iosReviewAIOutcome", "reviewAISuggestionsWrite"] {
            await refused { _ = try await core.call(method, argumentsJSON: self.json([selected])) }
        }
        await core.close()
    }

    func testDuplicateProviderTaskIDsRefuseBeforePublicationAndPriorSelectionStillApplies() async throws {
        let (core, state, service) = try await fixture(); try seedSecret(service)
        let first = try await core.beginReviewAI(requestJSON: "{}", lease: NativeTaskAIEditorLease(), readmit: { true })
        let previous = try object(await core.awaitReviewAI(first)), selected = try selection(previous)
        let before = try snapshot()
        state.content.update { $0 = "{\"suggestions\":[{\"id\":\"legacy-task-ai-target\",\"action\":\"someday\",\"reason\":\"Later\"},{\"id\":\"legacy-task-ai-target\",\"action\":\"archive\",\"reason\":\"Already finished\"}]}" }
        let duplicate = try await core.beginReviewAI(requestJSON: "{}", lease: NativeTaskAIEditorLease(), readmit: { true })
        do {
            _ = try await core.awaitReviewAI(duplicate)
            XCTFail("Duplicate provider task IDs must never reach App result publication")
        } catch let error as HostFailure {
            XCTAssertEqual(error.message, NativeTaskAIJSON.invalid.message)
        }
        XCTAssertEqual(try snapshot(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(state.requests.value.count, 2)
        // The App keeps its prior proposals on the fixed failure; their original revisions retain independent Apply authority.
        let result = try object(await core.applyReviewAISuggestions(requestJSON: selected, lease: NativeTaskAIEditorLease(), readmit: { true }))
        XCTAssertEqual(result["changed"] as? Bool, true)
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT id,status FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: rows.map { ($0["id"] as! String, $0["status"] as! String) }), [id: "someday", sibling: "archived"])
        XCTAssertEqual(state.requests.value.count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
    }

    func testHeldAnalysisLeaseCancellationDrainsAndNeverCreatesJournal() async throws {
        let state = ReviewAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(state: state); try seedSecret(service)
        let before = try snapshot(), lease = NativeTaskAIEditorLease()
        let handle = try await core.beginReviewAI(requestJSON: "{}", lease: lease, readmit: { true }); try await wait(state.entered)
        lease.invalidate(); await core.cancelReviewAI(handle); state.release()
        await refused { _ = try await core.awaitReviewAI(handle) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
    }

    func testApplyPendingCommitFailureRetriesExactJournalWithoutNetwork() async throws {
        let faults = HostIOFaults(), (core, state, service) = try await fixture(faults: faults); try seedSecret(service)
        let handle = try await core.beginReviewAI(requestJSON: "{}", lease: NativeTaskAIEditorLease(), readmit: { true })
        let answer = try object(await core.awaitReviewAI(handle)), selected = try selection(answer)
        let commits = ReviewAILocked(0), armed = ReviewAILocked(false)
        faults.journalWrite = { armed.update { $0 = true } }
        faults.beforeSQL = { sql in
            if armed.value && sql == "COMMIT" { commits.update { $0 += 1 }; throw HostFailure("Injected review COMMIT failure") }
        }
        await refused { _ = try await core.applyReviewAISuggestions(requestJSON: selected, lease: NativeTaskAIEditorLease(), readmit: { true }) }
        XCTAssertGreaterThan(commits.value, 0); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        let owed = try Data(contentsOf: journal), request = try object(selected)
        // A new facade invocation can be definitely unadmitted while earlier intent remains owed.
        try await cancelApplyAfterReadmission(core, request: selected)
        XCTAssertEqual(try Data(contentsOf: journal), owed)
        var different = request; different["requestId"] = UUID().uuidString.lowercased()
        await refused { _ = try await core.applyReviewAISuggestions(requestJSON: self.json(different), lease: NativeTaskAIEditorLease(), readmit: { true }) }
        XCTAssertEqual(try Data(contentsOf: journal), owed)
        faults.beforeSQL = nil
        let retried = try await core.retryPending()
        let result = try object(XCTUnwrap(retried))
        XCTAssertEqual(result["changed"] as? Bool, true); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(state.requests.value.count, 1); await core.close()
    }

    func testColdReplayRetainsSavedReceiptAndDoesNotReapplySelectedTask() async throws {
        let faults = HostIOFaults(), (core, state, service) = try await fixture(faults: faults); try seedSecret(service)
        let handle = try await core.beginReviewAI(requestJSON: "{}", lease: NativeTaskAIEditorLease(), readmit: { true })
        let selected = try selection(object(await core.awaitReviewAI(handle)))
        faults.journalRemove = { throw HostFailure("Injected review journal removal") }
        await refused { _ = try await core.applyReviewAISuggestions(requestJSON: selected, lease: NativeTaskAIEditorLease(), readmit: { true }) }
        let saved = try snapshot(); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let reopened = CoreHost(databaseURL: database, bundleURL: bundle)
        _ = try await reopened.start(); XCTAssertEqual(try snapshot(), saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(state.requests.value.count, 1)
        await reopened.close()
    }

    func testApplyInvalidatedBeforeAdmissionWritesNothing() async throws {
        let (core, _, _) = try await fixture(), before = try snapshot(), lease = NativeTaskAIEditorLease(); lease.invalidate()
        let input = try json(["requestId": UUID().uuidString, "suggestions": [["id": id, "action": "someday", "reason": "Later"]], "taskRevisions": [id: "stale"]])
        await refused { _ = try await core.applyReviewAISuggestions(requestJSON: input, lease: lease, readmit: { true }) }
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
    }
}
