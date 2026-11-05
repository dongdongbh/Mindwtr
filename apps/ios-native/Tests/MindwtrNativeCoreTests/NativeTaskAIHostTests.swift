import XCTest
import Security
import JavaScriptCore
@testable import MindwtrNativeCore

private final class TaskAILocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func update(_ work: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; work(&stored) }
}

private final class TaskAIHTTPState: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), stopped = DispatchSemaphore(value: 0)
    let requests = TaskAILocked<[URLRequest]>([])
    private let responses = TaskAILocked<[() -> Void]>([])
    var held = TaskAILocked(false)
    var content = TaskAILocked("{\"question\":\"Choose a title\",\"options\":[{\"label\":\"Rewrite\",\"action\":\"Clear title\"}],\"suggestedAction\":{\"title\":\"Suggested title\",\"context\":\"@home\",\"timeEstimate\":\"15min\"}}")
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
private final class TaskAIHTTPProtocol: URLProtocol {
    static let fixture = TaskAILocked<TaskAIHTTPState?>(nil)
    private let live = TaskAILocked(true)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let state = Self.fixture.value else { return }
        state.record(request) { [weak self] in self?.respond(state) }
    }
    private func respond(_ state: TaskAIHTTPState) {
        guard live.value else { return }
        let bytes = try! JSONSerialization.data(withJSONObject: ["choices": [["message": ["content": state.content.value]]]])
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { live.update { $0 = false }; Self.fixture.value?.stopped.signal() }
}

final class NativeTaskAIHostTests: XCTestCase {
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

    private func fixture(faults: HostIOFaults = HostIOFaults(), state: TaskAIHTTPState = TaskAIHTTPState(),
                         suffix: String = "", contextSiblings: Int = 0) async throws -> (CoreHost, TaskAIHTTPState, String) {
        let seed = CoreHost(databaseURL: database, bundleURL: bundle)
        _ = try await seed.start()
        let original = try await createTask(seed, title: "Target AI title")
        let originalSibling = try await createTask(seed, title: "Unrelated AI sibling"); await seed.close()
        let sqlite = try SQLiteBridge(url: database)
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
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [TaskAIHTTPProtocol.self]; faults.httpConfiguration = config
        TaskAIHTTPProtocol.fixture.update { $0 = state }
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
    private func request(_ core: CoreHost, operation: String = "clarify") async throws -> String {
        let editor = try object(await core.call("editorModel", argumentsJSON: json([id])))
        var value: [String: Any] = ["operation": operation, "id": id, "draft": try XCTUnwrap(editor["draft"])]
        if operation == "breakdown" { value["checklist"] = [["id": "existing", "title": "Existing step", "isCompleted": false]] }
        return try json(value)
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

    func testCanonicalClarifyAndBreakdownAreUnsavedAndUseOnlySelectedSecret() async throws {
        let faults = HostIOFaults(), reads = TaskAILocked<[String]>([])
        faults.configureSecretJobs = { jobs in jobs.beforeRead = { name in reads.update { $0.append(name) } } }
        let (core, state, service) = try await fixture(faults: faults)
        try seedSecret(service); try seedSecret(service, provider: "gemini", value: "unrelated-secret")
        let before = try snapshot(), raw = try await request(core)
        let input = try object(raw), lease = NativeTaskAIEditorLease()
        let options = try object(await core.readTaskAIOptions(requestJSON: json(["id": id, "draft": XCTUnwrap(input["draft"])]), lease: lease))
        XCTAssertEqual(Set(options.keys), Set(["enabled", "clarify", "breakdown", "working"])); XCTAssertEqual(options["enabled"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("editor-draft.json").path))
        let handle = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: lease, readmit: { true })
        let answer = try object(await core.awaitTaskAI(handle)); XCTAssertEqual(answer["kind"] as? String, "dialog")
        XCTAssertTrue(try json(answer).contains("Suggested title")); XCTAssertEqual(reads.value, ["mindwtr-ai-key_openai"])
        XCTAssertEqual(state.requests.value.first?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-selected")
        state.content.update { $0 = "{\"steps\":[\"First AI step\",\"Second AI step\"]}" }
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id, generation: 1, payloadJSON: "{}")
        try await core.checkpointEditorDraft(checkpoint)
        let breakdown = try await core.beginTaskAI(requestJSON: request(core, operation: "breakdown"), editor: checkpoint,
            lease: NativeTaskAIEditorLease(), readmit: { true })
        let result = try object(await core.awaitTaskAI(breakdown))
        let choices = try XCTUnwrap(result["choices"] as? [[String: Any]])
        let apply = try XCTUnwrap(choices.last?["apply"] as? [String: Any]), list = try XCTUnwrap(apply["checklist"] as? [[String: Any]])
        XCTAssertEqual(list.compactMap { $0["title"] as? String }, ["Existing step", "First AI step", "Second AI step"])
        XCTAssertEqual(try snapshot(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
    }

    func testHeldHTTPAllowsUnrelatedOrdinarySaveAndRechecksTargetRevision() async throws {
        let state = TaskAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(state: state); try seedSecret(service)
        let original = try await request(core)
        let handle = try await core.beginTaskAI(requestJSON: original, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered)
        _ = try await core.call("complete", argumentsJSON: json([sibling]))
        state.release()
        let answer = try object(await core.awaitTaskAI(handle)); XCTAssertEqual(answer["kind"] as? String, "dialog")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        state.held.update { $0 = true }
        let stale = try await core.beginTaskAI(requestJSON: original, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered)
        _ = try await core.call("complete", argumentsJSON: json([id]))
        state.release(); await refused { _ = try await core.awaitTaskAI(stale) }
        await core.close()
    }

    func testDraftLeaseCheckpointConfigAndLanguageChangesRefuseHeldAnswer() async throws {
        for change in ["lease", "checkpoint", "config", "language", "deleted"] {
            let child = directory.appendingPathComponent(change); try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
            let previous = directory; directory = child
            let state = TaskAIHTTPState(); state.held.update { $0 = true }
            let (core, _, service) = try await fixture(state: state); try seedSecret(service)
            let lease = NativeTaskAIEditorLease(), raw = try await request(core)
            let handle = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: lease, readmit: { true })
            try await wait(state.entered)
            if change == "lease" { lease.invalidate() }
            else if change == "checkpoint" {
                try await core.checkpointEditorDraft(EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id, generation: 1, payloadJSON: "{}"))
            } else {
                let sqlite = try SQLiteBridge(url: database)
                if change == "deleted" { _ = try sqlite.execute("UPDATE tasks SET deletedAt='2026-10-30T00:00:00.000Z' WHERE id=?", parametersJSON: json([id])) }
                else {
                    let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
                    var settings = try object(XCTUnwrap(rows.first?["data"] as? String))
                    if change == "language" { settings["language"] = "de" }
                    else { var ai = settings["ai"] as! [String: Any]; ai["model"] = "changed"; settings["ai"] = ai }
                    _ = try sqlite.execute("UPDATE settings SET data=? WHERE id=1", parametersJSON: json([json(settings)]))
                }
                sqlite.close()
            }
            state.release(); await refused { _ = try await core.awaitTaskAI(handle) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close(); directory = previous
        }
    }

    func testCancelBeforeSubmissionWaitsForSelectedSecretCompletion() async throws {
        let faults = HostIOFaults(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        faults.configureSecretJobs = { jobs in jobs.beforeRead = { _ in entered.signal(); _ = release.wait(timeout: .now() + 15) } }
        let (core, state, service) = try await fixture(faults: faults); try seedSecret(service)
        let raw = try await request(core), before = try snapshot()
        let handle = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(entered)
        let done = TaskAILocked(false)
        let cancel = Task { await core.cancelTaskAI(handle); done.update { $0 = true } }
        _ = try await core.call("window", argumentsJSON: "[0,50,\"\"]")
        XCTAssertFalse(done.value, "Cancellation cannot return while its selected secret read is held")
        release.signal(); await cancel.value
        await refused { _ = try await core.awaitTaskAI(handle) }
        XCTAssertTrue(state.requests.value.isEmpty); XCTAssertEqual(try snapshot(), before); await core.close()
    }

    func testSelectedCancellationDrainsHTTPCompletionWithoutCancellingUnrelatedPool() async throws {
        let faults = HostIOFaults(), pools = TaskAILocked<[NativeHTTPJobs]>([])
        let completionEntered = DispatchSemaphore(value: 0), releaseCompletion = DispatchSemaphore(value: 0)
        faults.configureHTTPJobs = { jobs in
            pools.update { values in
                if !values.isEmpty { jobs.beforeCompletion = { completionEntered.signal(); _ = releaseCompletion.wait(timeout: .now() + 15) } }
                values.append(jobs)
            }
        }
        let state = TaskAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(faults: faults, state: state); try seedSecret(service)
        let global = try XCTUnwrap(pools.value.first)
        _ = try global.submit(json(["url": "https://unrelated.example.test/held", "method": "GET", "redirect": "follow", "headers": [[String]]()]))
        try await wait(state.entered)
        let handle = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered)
        let done = TaskAILocked(false), cancel = Task { await core.cancelTaskAI(handle); done.update { $0 = true } }
        try await wait(completionEntered)
        XCTAssertFalse(done.value, "JS cancellation is insufficient: URLSession completion still owns the request")
        XCTAssertEqual(global.counters.running, 1, "Selected abort must not cancel runtime-wide HTTP")
        _ = try await core.call("complete", argumentsJSON: json([sibling]))
        releaseCompletion.signal(); await cancel.value
        XCTAssertEqual(pools.value.last?.counters.running, 0)
        XCTAssertEqual(global.counters.running, 1)
        state.release(); await core.close()
    }

    func testEarlyJSTerminalStillWaitsForOwnedTransportDrain() async throws {
        let faults = HostIOFaults(), pools = TaskAILocked<[NativeHTTPJobs]>([])
        let completionEntered = DispatchSemaphore(value: 0), releaseCompletion = DispatchSemaphore(value: 0)
        faults.configureHTTPJobs = { jobs in
            pools.update { values in
                if !values.isEmpty { jobs.beforeCompletion = { completionEntered.signal(); _ = releaseCompletion.wait(timeout: .now() + 15) } }
                values.append(jobs)
            }
        }
        let state = TaskAIHTTPState(); state.held.update { $0 = true }
        let suffix = """
        MindwtrHost.iosTaskAIRequest=function(json,owner){
          owner(JSON.stringify({phase:'begin',provider:'openai',configuration:JSON.stringify({enabled:true,provider:'openai',model:'fixture',requestTimeoutSeconds:30}),language:'en'}));
          owner(JSON.stringify({phase:'credential',provider:'openai'}));
          owner(JSON.stringify({phase:'http',url:'https://api.openai.com/v1/chat/completions'}));
          __mindwtrNative.netFetch(JSON.stringify({url:'https://api.openai.com/v1/chat/completions',method:'POST',redirect:'follow',headers:[],text:'{}'}));
          return MindwtrHost.logLine('early fixture terminal','{}');
        };
        """
        let (core, _, service) = try await fixture(faults: faults, state: state, suffix: suffix); try seedSecret(service)
        let handle = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        let settled = TaskAILocked(false)
        let result = Task { await self.refused { _ = try await core.awaitTaskAI(handle) }; settled.update { $0 = true } }
        try await wait(completionEntered)
        XCTAssertFalse(settled.value, "A terminal JS answer cannot release an unfinished URLSession callback")
        _ = try await core.call("window", argumentsJSON: "[0,50,\"\"]")
        releaseCompletion.signal(); await result.value
        XCTAssertEqual(pools.value.last?.counters.running, 0); await core.close()
    }

    func testCloseDrainsOriginalRequestAndAppReadmissionRejectsBeforeSubmission() async throws {
        let state = TaskAIHTTPState(); state.held.update { $0 = true }
        let (core, _, service) = try await fixture(state: state); try seedSecret(service)
        let denied = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { false })
        await refused { _ = try await core.awaitTaskAI(denied) }; XCTAssertTrue(state.requests.value.isEmpty)
        let handle = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        try await wait(state.entered); await core.close()
        await refused { _ = try await core.awaitTaskAI(handle) }
        XCTAssertEqual(state.stopped.wait(timeout: .now() + 1), .success)
    }

    func testDisplayedAnswerRevalidatesDurableWitnessBeforeApplyAndRetiresOnCancel() async throws {
        let (core, _, service) = try await fixture(); try seedSecret(service)
        let handle = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        _ = try await core.awaitTaskAI(handle)
        try await core.validateTaskAIAnswer(handle)
        _ = try await core.call("complete", argumentsJSON: json([sibling]))
        try await core.validateTaskAIAnswer(handle)
        _ = try await core.call("complete", argumentsJSON: json([id]))
        await refused { try await core.validateTaskAIAnswer(handle) }
        await core.cancelTaskAI(handle)
        await refused { try await core.validateTaskAIAnswer(handle) }
        await refused { _ = try await core.awaitTaskAI(handle) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
    }

    func testAnswerPinsBoundedCanonicalContextAndResolvedRuntimeLanguage() async throws {
        let (core, _, service) = try await fixture(contextSiblings: 22); try seedSecret(service)
        let raw = try await request(core)
        let handle = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        _ = try await core.awaitTaskAI(handle)
        _ = try await core.call("complete", argumentsJSON: json(["context-21"]))
        try await core.validateTaskAIAnswer(handle)
        _ = try await core.call("language", argumentsJSON: json(["de", "de-DE"]))
        await refused { try await core.validateTaskAIAnswer(handle) }
        let german = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        _ = try await core.awaitTaskAI(german); try await core.validateTaskAIAnswer(german)
        _ = try await core.call("complete", argumentsJSON: json(["context-0"]))
        await refused { try await core.validateTaskAIAnswer(german) }; await core.close()
    }

    func testNewBeginRetiresPriorAnswerBeforeHeldAsyncReadmission() async throws {
        let (core, _, service) = try await fixture(); try seedSecret(service)
        let raw = try await request(core)
        let first = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        _ = try await core.awaitTaskAI(first); try await core.validateTaskAIAnswer(first)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let second = try await core.beginTaskAI(requestJSON: raw, editor: nil, lease: NativeTaskAIEditorLease(), readmit: {
            entered.signal(); await Task.detached { _ = release.wait(timeout: .now() + 15) }.value; return false
        })
        try await wait(entered)
        await refused { try await core.validateTaskAIAnswer(first) }
        release.signal(); await core.cancelTaskAI(second); await core.close()
    }

    func testPrivateBoundaryMalformedAnswersAndExactBooleanOptions() async throws {
        XCTAssertThrowsError(try NativeTaskAIJSON.options("{\"enabled\":1,\"clarify\":\"c\",\"breakdown\":\"b\",\"working\":\"w\"}"))
        XCTAssertThrowsError(try NativeTaskAIJSON.answer("{\"kind\":\"none\",\"extra\":true}", operation: "clarify"))
        XCTAssertThrowsError(try NativeTaskAIJSON.answer("{\"kind\":\"dialog\",\"title\":\"x\",\"message\":null,\"choices\":[{\"label\":\"x\",\"variant\":null,\"apply\":{\"type\":\"fields\",\"patch\":{\"id\":\"inject\"}}}]}", operation: "clarify"))
        let (core, _, service) = try await fixture(suffix: "MindwtrHost.iosTaskAIRequest=function(){return MindwtrHost.logLine('fixture', '{}');};")
        try seedSecret(service)
        for method in ["iosTaskAIOptions", "iosTaskAIRequest"] { await refused { _ = try await core.call(method, argumentsJSON: "[]") } }
        let handle = try await core.beginTaskAI(requestJSON: request(core), editor: nil, lease: NativeTaskAIEditorLease(), readmit: { true })
        await refused { _ = try await core.awaitTaskAI(handle) }; await core.close()
    }
}
