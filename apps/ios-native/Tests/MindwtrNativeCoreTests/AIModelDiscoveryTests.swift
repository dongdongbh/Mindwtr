import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ModelDiscoveryHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((ModelDiscoveryHTTP) -> Void)?
    private static var stopping: (() -> Void)?
    static func install(_ handler: @escaping (ModelDiscoveryHTTP) -> Void, stopping: (() -> Void)? = nil) {
        lock.lock(); self.handler = handler; self.stopping = stopping; lock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handler; Self.lock.unlock()
        guard let handler else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }; handler(self)
    }
    override func stopLoading() { Self.lock.lock(); let callback = Self.stopping; Self.lock.unlock(); callback?() }
    func reply(_ text: String, status: Int = 200) {
        let data = Data(text.utf8), response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json", "Content-Length": String(data.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}
private final class ModelDiscoveryState: @unchecked Sendable {
    private let lock = NSLock()
    private var sent: [URLRequest] = [], read: [String] = []
    private var claimed = false, done = false
    func record(_ request: URLRequest) { lock.lock(); sent.append(request); lock.unlock() }
    func record(_ account: String) { lock.lock(); read.append(account); lock.unlock() }
    func resetReads() { lock.lock(); read.removeAll(); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return sent }
    var accounts: [String] { lock.lock(); defer { lock.unlock() }; return read }
    func once() -> Bool { lock.lock(); defer { lock.unlock() }; if claimed { return false }; claimed = true; return true }
    func complete() { lock.lock(); done = true; lock.unlock() }
    var completed: Bool { lock.lock(); defer { lock.unlock() }; return done }
}

/// Actual bundle/JSC, selected native key reads, HTTP transport and SQLite. Root runs on Apple runtime.
final class AIModelDiscoveryTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL { root.appendingPathComponent("device/Library/Application Support/mindwtr.models.fixture/RCTAsyncLocalStorage_V1/manifest.json") }
    private let sentinel = "SYNTHETIC-MODEL-DISCOVERY-PRIVATE"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Actual production iOS bundle required") }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = support.appendingPathComponent("AIModelDiscoveryTests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate.appendingPathComponent("device"), withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Model discovery fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        bundle = root.appendingPathComponent("core-host.js"); try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
    }
    override func tearDownWithError() throws {
        if let service { for provider in ["openai", "gemini", "anthropic"] { for alias in ["legacy", "auth", "no-auth"] { _ = SecItemDelete(query(service, provider: provider, alias: alias) as CFDictionary) } } }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func host(_ state: ModelDiscoveryState = ModelDiscoveryState(), faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        faults.secretService = service
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ModelDiscoveryHTTP.self]; faults.httpConfiguration = config
        faults.configureSecretJobs = { $0.beforeRead = { state.record($0) } }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), "mindwtr.models.fixture"))
        addTeardownBlock { await core.close() }; return core
    }
    private func query(_ service: String, provider: String, alias: String = "no-auth") -> [String: Any] {
        let account = Data(("mindwtr-ai-key_" + provider).utf8)
        #if os(macOS)
        let value: Any = "mindwtr-ai-key_" + provider
        #else
        let value: Any = account
        #endif
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
            kSecAttrAccount as String: value, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func credential(_ provider: String, value: String) throws {
        let search = query(service, provider: provider)
        let status = SecItemUpdate(search as CFDictionary, [kSecValueData as String: Data(value.utf8)] as CFDictionary)
        if status == errSecItemNotFound {
            var input = search; input[kSecValueData as String] = Data(value.utf8); input[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        } else { XCTAssertEqual(status, errSecSuccess) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    @discardableResult private func rows(_ sql: String, _ arguments: [Any] = []) throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(sql, parametersJSON: json(arguments)).utf8)) as? [[String: Any]])
    }
    private func settings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func seed(_ ai: [String: Any], values: [String: String] = [:]) async throws {
        let writer = host(); _ = try await writer.start(); await writer.close()
        var current = try settings(); current["ai"] = ai; try rows("UPDATE settings SET data=? WHERE id=1", [json(current)])
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(values).utf8).write(to: manifest, options: .atomic)
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refused discovery", file: file, line: line) } catch { XCTAssertFalse(String(describing: error).contains(sentinel), file: file, line: line) }
    }
    private func assertPrivateAndUnwritten(_ before: String, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try json(settings()), before, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
        XCTAssertTrue(try rows("SELECT * FROM tasks").isEmpty, file: file, line: line)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty, file: file, line: line)
        let log = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: log.path) { XCTAssertFalse(try String(contentsOf: log).contains(sentinel), file: file, line: line) }
    }

    func testConsentBeforeSelectedCredentialsAndHTTPKeepsLegacyUnchanged() async throws {
        for provider in ["openai", "gemini", "anthropic"] {
            try await seed(["provider": provider, "enabled": false], values: ["mindwtr-ai-key:" + provider: sentinel])
            let state = ModelDiscoveryState(); ModelDiscoveryHTTP.install { state.record($0.request); XCTFail("Unconsented discovery performed HTTP"); $0.reply("{}") }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
            state.resetReads(); let before = try json(settings()), bytes = try Data(contentsOf: manifest)
            let choices = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, .unavailable); XCTAssertEqual(choices.modelOptions, opened.options.modelOptions)
            XCTAssertTrue(state.accounts.isEmpty); XCTAssertTrue(state.requests.isEmpty); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
            try assertPrivateAndUnwritten(before); await core.close()
        }
    }

    func testSelectedProviderGETOrderingAndCustomChoicesUseReadOnlySelectedLegacy() async throws {
        for provider in ["openai", "gemini", "anthropic"] {
            try await seed(["provider": provider, "enabled": true, "model": "custom assistant", "copilotModel": "custom copilot"],
                values: ["mindwtr-ai-key:" + provider: sentinel, "mindwtr-ai-key:unselected": "retained"])
            let state = ModelDiscoveryState()
            let body: [String: Any] = provider == "gemini" ? ["models": [
                ["name": "models/gemini-2", "supportedGenerationMethods": ["generateContent"]],
                ["name": "models/gemini-3", "supportedGenerationMethods": ["generateContent"]],
                ["name": "models/gemini-embedding", "supportedGenerationMethods": ["generateContent"]]]] :
                ["data": [["id": "chat-old", "created": 1], ["id": "chat-new", "created": 2], ["id": "chat-old", "created": 1]]]
            let reply = try json(body); ModelDiscoveryHTTP.install { state.record($0.request); $0.reply(reply) }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
            state.resetReads(); let before = try json(settings()), bytes = try Data(contentsOf: manifest)
            let choices = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected)
            let order = provider == "gemini" ? ["gemini-3", "gemini-2"] : provider == "openai" ? ["chat-new", "chat-old"] : ["chat-old", "chat-new"]
            XCTAssertEqual(choices.status, .loaded); XCTAssertEqual(choices.modelOptions, ["custom assistant"] + order)
            XCTAssertEqual(choices.copilotModelOptions, ["custom copilot"] + order); XCTAssertEqual(choices.expected, opened.options.expected)
            XCTAssertFalse(state.accounts.isEmpty); XCTAssertEqual(Set(state.accounts), Set(["mindwtr-ai-key_" + provider]))
            let request = try XCTUnwrap(state.requests.first); XCTAssertEqual(state.requests.count, 1); XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
            if provider == "openai" { XCTAssertEqual(request.url?.absoluteString, "https://api.openai.com/v1/models"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + sentinel) }
            if provider == "gemini" { XCTAssertEqual(request.url?.host, "generativelanguage.googleapis.com"); XCTAssertTrue(request.url?.query?.contains(sentinel) == true); XCTAssertNil(request.value(forHTTPHeaderField: "Authorization")) }
            if provider == "anthropic" { XCTAssertEqual(request.url?.absoluteString, "https://api.anthropic.com/v1/models?limit=100"); XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), sentinel) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); try assertPrivateAndUnwritten(before); await core.close()
        }
    }

    func testRecordedConsentAndKeylessCustomOpenAIKeepExistingPolicy() async throws {
        for custom in [false, true] {
            var ai: [String: Any] = ["provider": "openai", "enabled": false, "model": "custom"]
            if custom { ai["baseUrl"] = "http://127.0.0.1:9421/v1" }
            try await seed(ai, values: ["mindwtr-ai-provider-consent-v1": "{\"openai\":true}"])
            let state = ModelDiscoveryState(); ModelDiscoveryHTTP.install { state.record($0.request); $0.reply("{\"data\":[{\"id\":\"chat-discovered\"}]}") }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            let choices = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, custom ? .loaded : .unavailable); XCTAssertEqual(state.requests.count, custom ? 1 : 0)
            if custom { XCTAssertEqual(state.requests.first?.url?.absoluteString, "http://127.0.0.1:9421/v1/models"); XCTAssertNil(state.requests.first?.value(forHTTPHeaderField: "Authorization")) }
            try assertPrivateAndUnwritten(before); await core.close()
        }
    }

    func testProviderTransportEmptyMalformedAndOversizedListsFallBackWithoutTruncation() async throws {
        let oversized = try json(["data": (0...100).map { ["id": "chat-\($0)"] }])
        let longID = try json(["data": [["id": String(repeating: "x", count: 2001)]]])
        for (reply, status) in [("{}", 200), ("{\"data\":[]}", 200), ("malformed", 200), (oversized, 200), (longID, 200), ("{}", 500)] {
            try await seed(["provider": "openai", "enabled": true, "model": "custom fallback"], values: ["mindwtr-ai-key:openai": sentinel])
            let state = ModelDiscoveryState(); ModelDiscoveryHTTP.install { state.record($0.request); $0.reply(reply, status: status) }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            let choices = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, .fallback); XCTAssertEqual(choices.modelOptions, opened.options.modelOptions)
            XCTAssertEqual(choices.copilotModelOptions, opened.options.copilotModelOptions); XCTAssertEqual(state.requests.count, 1)
            try assertPrivateAndUnwritten(before); await core.close()
        }
        try await seed(["provider": "openai", "enabled": true], values: ["mindwtr-ai-key:openai": sentinel])
        let faults = HostIOFaults(); faults.httpByteLimit = 32
        ModelDiscoveryHTTP.install { $0.reply(String(repeating: "x", count: 64)) }
        let core = host(faults: faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let choices = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected); XCTAssertEqual(choices.status, .fallback)
    }

    func testCancellationPageRetirementAndCloseDrainSelectedHTTPWhileEngineRemainsFree() async throws {
        for action in ["cancel", "retire", "close"] {
            try await seed(["provider": "openai", "enabled": true], values: ["mindwtr-ai-key:openai": sentinel])
            let state = ModelDiscoveryState(), started = expectation(description: action + " started"), terminal = expectation(description: action + " native terminal entered")
            let release = DispatchSemaphore(value: 0), faults = HostIOFaults()
            faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = {
                if state.once() { terminal.fulfill(); _ = release.wait(timeout: .now() + 5) }
            } }
            ModelDiscoveryHTTP.install { state.record($0.request); started.fulfill() }
            let core = host(state, faults: faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            let work = Task { try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected) }
            await fulfillment(of: [started], timeout: 5)
            let began = Date()
            await failure { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: "{}", expected: opened.options.expected) }
            XCTAssertLessThan(Date().timeIntervalSince(began), 1, "The Engine must be free during the held GET")
            let drain: Task<Void, Never>
            if action == "cancel" { drain = Task { work.cancel(); _ = try? await work.value; state.complete() } }
            else if action == "retire" { drain = Task { await core.retireAITextConfiguration(session: opened.id); state.complete() } }
            else { drain = Task { await core.close(); state.complete() } }
            await fulfillment(of: [terminal], timeout: 5)
            try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(state.completed)
            release.signal(); await drain.value; await failure { _ = try await work.value }
            XCTAssertTrue(state.completed); try assertPrivateAndUnwritten(before); await core.close()
        }
    }

    func testCredentialConsentSettingsAndLibraryDriftNeverPublishChoices() async throws {
        for mutation in ["credential", "consent", "settings", "library"] {
            try await seed(["provider": "openai", "enabled": true], values: ["mindwtr-ai-provider-consent-v1": "{\"openai\":true}"])
            try credential("openai", value: sentinel)
            let once = ModelDiscoveryState(), faults = HostIOFaults()
            faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = {
                guard once.once() else { return }
                do {
                    if mutation == "credential" { try self.credential("openai", value: self.sentinel + "-changed") }
                    else if mutation == "consent" { try Data(self.json(["mindwtr-ai-provider-consent-v1": "{\"openai\":false}"]).utf8).write(to: self.manifest, options: .atomic) }
                    else if mutation == "settings" {
                        var value = try self.settings(); value["ai"] = ["provider": "gemini", "enabled": true]
                        try self.rows("UPDATE settings SET data=? WHERE id=1", [self.json(value)])
                    } else { try FileManager.default.moveItem(at: self.database, to: self.root.appendingPathComponent("retained.sqlite")); try Data().write(to: self.database) }
                } catch { XCTFail("Could not inject discovery owner drift") }
            } }
            ModelDiscoveryHTTP.install { $0.reply("{\"data\":[{\"id\":\"chat-fresh\"}]}") }
            let core = host(faults: faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
            await failure { _ = try await core.discoverAITextModels(session: opened.id, expected: opened.options.expected) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
            if mutation == "library" { try FileManager.default.removeItem(at: database); try FileManager.default.moveItem(at: root.appendingPathComponent("retained.sqlite"), to: database) }
        }
    }

    func testChoicesDTOBoundsAndPrivateGeneralRoutesAreClosed() async throws {
        try await seed(["provider": "openai", "model": "custom"])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let value: [String: Any] = ["version": 1, "provider": "openai", "status": "loaded", "modelOptions": ["custom"], "copilotModelOptions": ["custom"], "expected": opened.options.expected.object]
        XCTAssertEqual(try NativeAITextModelChoices.validated(json(value)).status, .loaded)
        for patch: [String: Any] in [["version": true], ["version": 2], ["provider": "gemini"], ["status": "partial"], ["extra": true],
            ["modelOptions": []], ["modelOptions": [" "]], ["modelOptions": ["custom", "custom"]], ["modelOptions": Array(repeating: "x", count: 101)],
            ["copilotModelOptions": [String(repeating: "x", count: 2001)]]] {
            var changed = value; changed.merge(patch) { _, new in new }; XCTAssertThrowsError(try NativeAITextModelChoices.validated(json(changed)))
        }
        XCTAssertThrowsError(try NativeAITextModelChoices.validated("{\"version\":1,\"version\":1}"))
        var oversized = value; oversized["modelOptions"] = (0..<40).map { String(repeating: "x", count: 1800) + String($0) }
        XCTAssertThrowsError(try NativeAITextModelChoices.validated(json(oversized)))
        let before = try json(settings())
        await failure { _ = try await core.call("iosAITextModelDiscovery", argumentsJSON: "[\"{}\"]") }
        await failure { _ = try await core.call("menuCommand", argumentsJSON: json(["iosAITextModelDiscovery", "{}"])) }
        try assertPrivateAndUnwritten(before)
    }
}
