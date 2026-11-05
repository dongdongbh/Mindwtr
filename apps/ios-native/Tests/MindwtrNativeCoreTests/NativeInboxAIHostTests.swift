import XCTest
import Security
import JavaScriptCore
@testable import MindwtrNativeCore

private final class InboxAILocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ work: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; work(&stored) }
}

private final class InboxAIHTTPState: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), stopped = DispatchSemaphore(value: 0)
    let requests = InboxAILocked<[URLRequest]>([])
    private let responses = InboxAILocked<[() -> Void]>([])
    var held = InboxAILocked(false)
    var content = InboxAILocked("{\"question\":\"Choose a title\",\"options\":[{\"label\":\"Rewrite\",\"action\":\"Clear title\"}],\"suggestedAction\":{\"title\":\"Suggested title\",\"context\":\"@home\",\"timeEstimate\":\"15min\"}}")
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
private final class InboxAIHTTPProtocol: URLProtocol {
    static let fixture = InboxAILocked<InboxAIHTTPState?>(nil)
    private let live = InboxAILocked(true)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let state = Self.fixture.value else { return }
        state.record(request) { [weak self] in self?.respond(state) }
    }
    private func respond(_ state: InboxAIHTTPState) {
        guard live.value else { return }
        let bytes = try! JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": state.content.value]]]])
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { live.update { $0 = false }; Self.fixture.value?.stopped.signal() }
}

final class NativeInboxAIHostTests: XCTestCase {
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

    private func fixture(faults: HostIOFaults = HostIOFaults(), state: InboxAIHTTPState = InboxAIHTTPState(),
                         suffix: String = "", contextSiblings: Int = 0) async throws -> (CoreHost, InboxAIHTTPState, String) {
        let seed = CoreHost(databaseURL: database, bundleURL: bundle)
        _ = try await seed.start()
        let original = try await createTask(seed, title: "Target AI title")
        let originalSibling = try await createTask(seed, title: "Unrelated AI sibling"); await seed.close()
        let sqlite = try SQLiteBridge(url: database)
        // Cold-load bounded legacy IDs without changing a live core's backing rows.
        _ = try sqlite.execute("UPDATE tasks SET id=? WHERE id=?", parametersJSON: json([id, original]))
        _ = try sqlite.execute("UPDATE tasks SET id=? WHERE id=?", parametersJSON: json([sibling, originalSibling]))
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
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [InboxAIHTTPProtocol.self]; faults.httpConfiguration = config
        InboxAIHTTPProtocol.fixture.update { $0 = state }
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
    private func request(_ core: CoreHost) async throws -> String {
        let opened = try object(await core.call("inboxStart", argumentsJSON: json(["guided"])))
        let view = try XCTUnwrap(opened["view"] as? [String: Any])
        XCTAssertEqual(view["taskId"] as? String, id)
        return try json(["sessionId": XCTUnwrap(view["sessionId"]), "taskId": id, "step": XCTUnwrap(view["step"])])
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

    func testCanonicalClarifyApplyIsUnsavedThenOrdinaryDecisionSavesOnce() async throws {
        let faults = HostIOFaults(), reads = InboxAILocked<[String]>([])
        faults.configureSecretJobs = { jobs in jobs.beforeRead = { name in reads.update { $0.append(name) } } }
        let (core, state, service) = try await fixture(faults: faults); try seedSecret(service)
        let input = try await request(core), before = try snapshot()
        let handle = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true })
        let answer = try object(await core.awaitInboxAI(handle)); XCTAssertEqual(answer["kind"] as? String, "dialog")
        XCTAssertEqual(reads.value, ["mindwtr-ai-key_openai"])
        let choices = try XCTUnwrap(answer["choices"] as? [[String: Any]]), index = try XCTUnwrap(choices.firstIndex { $0["variant"] as? String == "primary" })
        try await core.validateInboxAIAnswer(handle)
        let applied = try object(await core.applyInboxAIChoice(handle, index: index))
        let draft = try XCTUnwrap(applied["draft"] as? [String: Any]); XCTAssertEqual(draft["title"] as? String, "Suggested title")
        XCTAssertEqual(draft["contexts"] as? [String], ["@home"])
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await refused { _ = try await core.applyInboxAIChoice(handle, index: index) }
        let original = try object(input)
        var request = original; request["step"] = applied["step"]; request["decision"] = ["choice": "actionable"]; request["requestId"] = UUID().uuidString.lowercased()
        let flow = try object(await core.call("inboxCommit", argumentsJSON: json([json(request)])))
        let result = try XCTUnwrap(flow["result"] as? [String: Any]), next = try XCTUnwrap(result["view"] as? [String: Any])
        request["step"] = next["step"]; request["decision"] = ["choice": "done"]; request["requestId"] = UUID().uuidString.lowercased()
        _ = try await core.call("inboxCommit", argumentsJSON: json([json(request)]))
        let sqlite = try SQLiteBridge(url: database)
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT title,status,contexts FROM tasks WHERE id=?", parametersJSON: json([id])).utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.first?["title"] as? String, "Suggested title"); XCTAssertEqual(rows.first?["status"] as? String, "done"); sqlite.close()
        XCTAssertEqual(state.requests.value.count, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
    }

    func testHeldRequestAllowsUnrelatedOrdinarySaveAndRefusesChangedProcessingDraft() async throws {
        let state = InboxAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(state: state); try seedSecret(service)
        let input = try await request(core)
        let first = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered); _ = try await core.call("complete", argumentsJSON: json([sibling])); state.release()
        _ = try await core.awaitInboxAI(first); try await core.validateInboxAIAnswer(first)
        await core.cancelInboxAI(first)
        state.held.update { $0 = true }
        let second = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true }); try await wait(state.entered)
        var edit = try object(input); edit["edit"] = ["type": "set", "field": "title", "value": "Changed while held"]
        _ = try await core.call("inboxStep", argumentsJSON: json([json(edit)])); state.release()
        await refused { _ = try await core.awaitInboxAI(second) }; await core.close()
    }

    func testDisplayedAnswerRefusesChangedDraftRuntimeLanguageAndTargetBeforeApply() async throws {
        let (core, _, service) = try await fixture(); try seedSecret(service)
        let input = try await request(core)
        for change in ["draft", "language", "target"] {
            let handle = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true })
            _ = try await core.awaitInboxAI(handle); try await core.validateInboxAIAnswer(handle)
            if change == "draft" {
                var edit = try object(input); edit["edit"] = ["type": "set", "field": "title", "value": "Changed draft"]
                _ = try await core.call("inboxStep", argumentsJSON: json([json(edit)]))
            } else if change == "language" { _ = try await core.call("language", argumentsJSON: json(["de", "de-DE"])) }
            else { _ = try await core.call("complete", argumentsJSON: json([id])) }
            await refused { try await core.validateInboxAIAnswer(handle) }
            await refused { _ = try await core.applyInboxAIChoice(handle, index: 1) }
            await core.cancelInboxAI(handle)
        }
        await core.close()
    }

    func testSelectedCancelDrainsHTTPAndCachedAwaitRefuses() async throws {
        let faults = HostIOFaults(), pools = InboxAILocked<[NativeHTTPJobs]>([])
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        faults.configureHTTPJobs = { jobs in pools.update { values in
            if !values.isEmpty { jobs.beforeCompletion = { entered.signal(); _ = release.wait(timeout: .now() + 15) } }
            values.append(jobs)
        } }
        let state = InboxAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(faults: faults, state: state); try seedSecret(service)
        let handle = try await core.beginInboxAI(requestJSON: request(core), lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered)
        let done = InboxAILocked(false), cancel = Task { await core.cancelInboxAI(handle); done.update { $0 = true } }
        try await wait(entered); XCTAssertFalse(done.value)
        _ = try await core.call("window", argumentsJSON: "[0,50,\"\"]")
        release.signal(); await cancel.value
        XCTAssertEqual(pools.value.last?.counters.running, 0)
        await refused { _ = try await core.awaitInboxAI(handle) }; await core.close()
    }

    func testMissingCredentialToastAndPrivateBoundaryHaveNoWrites() async throws {
        let (core, state, _) = try await fixture(); let input = try await request(core), before = try snapshot()
        let handle = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true })
        let answer = try object(await core.awaitInboxAI(handle)); XCTAssertEqual(answer["kind"] as? String, "toast")
        XCTAssertTrue(state.requests.value.isEmpty); XCTAssertEqual(try snapshot(), before)
        for method in ["iosInboxAIWitness", "iosInboxAIRequest", "iosInboxAIApply"] { await refused { _ = try await core.call(method) } }
        XCTAssertThrowsError(try NativeInboxAIJSON.request("{\"sessionId\":\"s\",\"taskId\":\"legacy\",\"step\":\"actionable\",\"extra\":true}"))
        XCTAssertThrowsError(try NativeInboxAIJSON.answer("{\"kind\":\"dialog\",\"title\":\"x\",\"message\":null,\"choices\":[{\"label\":\"x\",\"variant\":null,\"apply\":[{\"type\":\"setPriority\",\"value\":\"high\"}]}]}"))
        await core.cancelInboxAI(handle); await core.close()
    }
    func testOversizedContextIsRefusedBeforeDraftApply() async throws {
        let (core, state, service) = try await fixture(); try seedSecret(service)
        let input = try await request(core), before = try snapshot()
        let original = try object(await core.call("inboxStep", argumentsJSON: json([input])))
        for (title, context) in [("Title before refused context", "@" + String(repeating: "x", count: 500)),
                                  (String(repeating: "x", count: 10_001), "@home")] {
            state.content.update { $0 = try! self.json(["question": "Choose", "options": [Any](), "suggestedAction": ["title": title, "context": context]]) }
            let handle = try await core.beginInboxAI(requestJSON: input, lease: NativeTaskAIEditorLease(), readmit: { true })
            await refused { _ = try await core.awaitInboxAI(handle) }
            let after = try object(await core.call("inboxStep", argumentsJSON: json([input])))
            XCTAssertEqual(try json(after["draft"]!), try json(original["draft"]!))
            XCTAssertEqual(try snapshot(), before)
        }
        XCTAssertTrue(NativeInboxAIJSON.edits([["type": "set", "field": "title", "value": String(repeating: "x", count: 10_000)],
                                             ["type": "addContext", "value": String(repeating: "x", count: 500)]]))
        await core.close()
    }

}
