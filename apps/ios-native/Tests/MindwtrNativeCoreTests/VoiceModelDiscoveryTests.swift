import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class VoiceDiscoveryHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((VoiceDiscoveryHTTP) -> Void)?
    private static var stopping: (() -> Void)?
    static func install(_ handler: @escaping (VoiceDiscoveryHTTP) -> Void, stopping: (() -> Void)? = nil) {
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
private final class VoiceDiscoveryState: @unchecked Sendable {
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

final class VoiceModelDiscoveryTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL { root.appendingPathComponent("device/Library/Application Support/mindwtr.voice-models.fixture/RCTAsyncLocalStorage_V1/manifest.json") }
    private let sentinel = "SYNTHETIC-VOICE-DISCOVERY-PRIVATE"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Actual production iOS bundle required") }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = support.appendingPathComponent("VoiceModelDiscoveryTests/" + UUID().uuidString)
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
    private func host(_ state: VoiceDiscoveryState = VoiceDiscoveryState(), faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        faults.secretService = service
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [VoiceDiscoveryHTTP.self]; faults.httpConfiguration = config
        faults.configureSecretJobs = { $0.beforeRead = { state.record($0) } }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), "mindwtr.voice-models.fixture"))
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
    private func configuration(_ provider: String, assistant: String = "openai", enabled: Bool = false,
                               speechEnabled: Bool = true, baseURL: String? = nil) -> [String: Any] {
        var speech: [String: Any] = ["provider": provider, "enabled": speechEnabled, "model": "custom speech"]
        if let baseURL { speech["baseUrl"] = baseURL }
        return ["provider": assistant, "enabled": enabled, "model": "custom assistant", "speechToText": speech]
    }
    func testSpeechEnabledDoesNotGrantConsentButMatchingAssistantOrRecordedConsentDoes() async throws {
        for (assistant, enabled, speechEnabled, consent, allowed) in [
            ("gemini", false, true, false, false), ("anthropic", true, true, false, false),
            ("gemini", true, false, false, true), ("anthropic", false, false, true, true)] {
            var values = ["mindwtr-ai-key:gemini": sentinel]
            if consent { values["mindwtr-ai-provider-consent-v1"] = "{\"gemini\":true}" }
            try await seed(configuration("gemini", assistant: assistant, enabled: enabled, speechEnabled: speechEnabled), values: values)
            let state = VoiceDiscoveryState()
            VoiceDiscoveryHTTP.install { state.record($0.request); $0.reply("{\"models\":[{\"name\":\"models/gemini-fresh\",\"supportedGenerationMethods\":[\"generateContent\"]}]}") }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginVoiceSettings()
            let before = try json(settings()), bytes = try Data(contentsOf: manifest); state.resetReads()
            let choices = try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, allowed ? .loaded : .unavailable); XCTAssertEqual(choices.provider, .gemini)
            XCTAssertEqual(state.requests.count, allowed ? 1 : 0)
            if allowed { XCTAssertEqual(Set(state.accounts), Set(["mindwtr-ai-key_gemini"])) } else { XCTAssertTrue(state.accounts.isEmpty) }
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); try assertPrivateAndUnwritten(before); await core.close()
        }
    }
    func testOpenAIUsesRawSpeechRootAndTranscriptionKindWithExistingKeylessPolicy() async throws {
        for (custom, legacy, allowed) in [(false, false, false), (true, false, true), (false, true, true)] {
            var values = ["mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]
            if legacy { values["mindwtr-ai-key:openai"] = sentinel }
            try await seed(configuration("openai", baseURL: custom ? "http://127.0.0.1:9463/v1/" : nil), values: values)
            let state = VoiceDiscoveryState(), body = "{\"data\":[{\"id\":\"gpt-chat\",\"created\":9},{\"id\":\"whisper-1\",\"created\":1},{\"id\":\"gpt-transcribe\",\"created\":2},{\"id\":\"tts-1\"}]}"
            VoiceDiscoveryHTTP.install { state.record($0.request); $0.reply(body) }
            let core = host(state); _ = try await core.start(); let opened = try await core.beginVoiceSettings()
            let before = try json(settings()), bytes = try Data(contentsOf: manifest); state.resetReads()
            let choices = try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, allowed ? .loaded : .unavailable); XCTAssertEqual(choices.expected, opened.options.expected)
            XCTAssertEqual(state.requests.count, allowed ? 1 : 0)
            if allowed {
                XCTAssertEqual(choices.modelOptions, ["custom speech", "gpt-transcribe", "whisper-1"])
                let request = try XCTUnwrap(state.requests.first); XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
                XCTAssertEqual(request.url?.absoluteString, custom ? "http://127.0.0.1:9463/v1/models" : "https://api.openai.com/v1/models")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), legacy ? "Bearer " + sentinel : nil)
            }
            XCTAssertEqual(Set(state.accounts), Set(["mindwtr-ai-key_openai"]))
            XCTAssertEqual(try Data(contentsOf: manifest), bytes); try assertPrivateAndUnwritten(before); await core.close()
        }
    }
    func testGeminiChatFilteringAndUnsupportedProvidersHaveNoEffects() async throws {
        try await seed(configuration("gemini", assistant: "gemini", enabled: true), values: ["mindwtr-ai-key:gemini": sentinel])
        let state = VoiceDiscoveryState(), body = try json(["models": [
            ["name": "models/gemini-2", "supportedGenerationMethods": ["generateContent"]],
            ["name": "models/gemini-3", "supportedGenerationMethods": ["generateContent"]],
            ["name": "models/gemini-live", "supportedGenerationMethods": ["generateContent"]]]])
        VoiceDiscoveryHTTP.install { state.record($0.request); $0.reply(body) }
        let core = host(state); _ = try await core.start(); let opened = try await core.beginVoiceSettings(), before = try json(settings()); state.resetReads()
        let choices = try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected)
        XCTAssertEqual(choices.modelOptions, ["custom speech", "gemini-3", "gemini-2"]); XCTAssertEqual(choices.status, .loaded)
        XCTAssertEqual(Set(state.accounts), Set(["mindwtr-ai-key_gemini"])); try assertPrivateAndUnwritten(before); await core.close()
        for provider in ["whisper", "parakeet"] {
            try await seed(configuration(provider, assistant: "gemini", enabled: true))
            let state = VoiceDiscoveryState(); VoiceDiscoveryHTTP.install { state.record($0.request); XCTFail("Unsupported discovery fetched"); $0.reply("{}") }
            let owner = host(state); _ = try await owner.start(); let page = try await owner.beginVoiceSettings(), saved = try json(settings()); state.resetReads()
            await failure { _ = try await owner.discoverVoiceModels(session: page.id, expected: page.options.expected) }
            XCTAssertTrue(state.accounts.isEmpty); XCTAssertTrue(state.requests.isEmpty); try assertPrivateAndUnwritten(saved); await owner.close()
        }
    }
    func testVoiceFailuresKeepStaticAndCustomChoicesWithoutTruncation() async throws {
        let many = try json(["data": (0...100).map { ["id": "transcribe-\($0)"] }])
        let long = try json(["data": [["id": "transcribe-" + String(repeating: "x", count: 2000)]]])
        for (reply, status) in [("{\"data\":[]}", 200), ("malformed", 200), (many, 200), (long, 200), ("{}", 500)] {
            try await seed(configuration("openai", enabled: true), values: ["mindwtr-ai-key:openai": sentinel])
            VoiceDiscoveryHTTP.install { $0.reply(reply, status: status) }
            let core = host(); _ = try await core.start(); let opened = try await core.beginVoiceSettings(), before = try json(settings())
            let choices = try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected)
            XCTAssertEqual(choices.status, .fallback); XCTAssertEqual(choices.modelOptions, opened.options.modelOptions)
            try assertPrivateAndUnwritten(before); await core.close()
        }
    }
    func testVoiceTaskPageAndHostCancellationDrainTerminalAndKeepEngineFree() async throws {
        for action in ["cancel", "retire", "close"] {
            try await seed(configuration("openai", enabled: true), values: ["mindwtr-ai-key:openai": sentinel])
            let state = VoiceDiscoveryState(), faults = HostIOFaults(), started = expectation(description: action + " voice started")
            let terminal = expectation(description: action + " native terminal entered"), release = DispatchSemaphore(value: 0)
            faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = { if state.once() { terminal.fulfill(); _ = release.wait(timeout: .now() + 5) } } }
            VoiceDiscoveryHTTP.install { state.record($0.request); started.fulfill() }
            let core = host(state, faults: faults); _ = try await core.start(); let text = try await core.beginAITextConfigurationV2()
            let opened = try await core.beginVoiceSettings(), before = try json(settings())
            let work = Task { try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected) }
            await fulfillment(of: [started], timeout: 5)
            let began = Date()
            await failure { _ = try await core.discoverAITextModels(session: text.id, expected: text.options.expected) }
            await failure { _ = try await core.readVoiceSettings(session: opened.id) }
            XCTAssertLessThan(Date().timeIntervalSince(began), 1)
            await core.retireAITextConfiguration(session: opened.id)
            let drain: Task<Void, Never>
            if action == "cancel" { drain = Task { work.cancel(); _ = try? await work.value; state.complete() } }
            else if action == "retire" { drain = Task { await core.retireVoiceSettings(session: opened.id); state.complete() } }
            else { drain = Task { await core.close(); state.complete() } }
            await fulfillment(of: [terminal], timeout: 5); try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(state.completed)
            release.signal(); await drain.value; await failure { _ = try await work.value }
            XCTAssertTrue(state.completed); try assertPrivateAndUnwritten(before); await core.close()
        }
    }
    func testVoiceCredentialConsentEndpointAssistantAndProviderDriftRefusePublication() async throws {
        for mutation in ["credential", "consent", "endpoint", "assistant", "provider"] {
            try await seed(configuration("openai", enabled: true), values: ["mindwtr-ai-provider-consent-v1": "{\"openai\":true}"])
            try credential("openai", value: sentinel)
            let once = VoiceDiscoveryState(), faults = HostIOFaults()
            faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = {
                guard once.once() else { return }
                do {
                    if mutation == "credential" { try self.credential("openai", value: self.sentinel + "-changed") }
                    else if mutation == "consent" { try Data(self.json(["mindwtr-ai-provider-consent-v1": "{\"openai\":false}"]).utf8).write(to: self.manifest, options: .atomic) }
                    else {
                        var settings = try self.settings(), ai = try XCTUnwrap(settings["ai"] as? [String: Any]), speech = try XCTUnwrap(ai["speechToText"] as? [String: Any])
                        if mutation == "endpoint" { speech["baseUrl"] = "https://changed.invalid/v1" }
                        else if mutation == "provider" { speech["provider"] = "gemini" }
                        else { ai["provider"] = "anthropic"; ai["enabled"] = false }
                        ai["speechToText"] = speech; settings["ai"] = ai; try self.rows("UPDATE settings SET data=? WHERE id=1", [self.json(settings)])
                    }
                } catch { XCTFail("Could not inject voice discovery owner drift") }
            } }
            VoiceDiscoveryHTTP.install { $0.reply("{\"data\":[{\"id\":\"whisper-1\"}]}") }
            let core = host(faults: faults); _ = try await core.start(); let opened = try await core.beginVoiceSettings()
            await failure { _ = try await core.discoverVoiceModels(session: opened.id, expected: opened.options.expected) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); await core.close()
        }
    }
    func testVoiceChoicesClosedDTOAndRawRoutesKeepOldWitnessShape() async throws {
        try await seed(configuration("gemini"))
        let core = host(); _ = try await core.start(); let opened = try await core.beginVoiceSettings()
        let value: [String: Any] = ["version": 1, "provider": "gemini", "status": "loaded", "modelOptions": ["custom speech"], "expected": try opened.options.expected.object]
        XCTAssertEqual(try NativeVoiceModelChoices.validated(json(value)).status, .loaded)
        for patch: [String: Any] in [["version": true], ["version": 2], ["provider": "openai"], ["provider": "whisper"], ["status": "partial"],
            ["extra": true], ["modelOptions": []], ["modelOptions": [" "]], ["modelOptions": ["same", "same"]],
            ["modelOptions": Array(repeating: "x", count: 101)], ["modelOptions": [String(repeating: "x", count: 2001)]]] {
            var changed = value; changed.merge(patch) { _, new in new }; XCTAssertThrowsError(try NativeVoiceModelChoices.validated(json(changed)))
        }
        XCTAssertThrowsError(try NativeVoiceModelChoices.validated("{\"version\":1,\"version\":1}"))
        var large = value; large["modelOptions"] = (0..<40).map { String(repeating: "x", count: 1800) + String($0) }
        XCTAssertThrowsError(try NativeVoiceModelChoices.validated(json(large)))
        XCTAssertEqual(Set(try opened.options.expected.object.keys), Set(["aiPresent", "speechPresent", "providerPresent", "provider", "enabledPresent", "enabled", "modelPresent", "model", "languagePresent", "language", "modePresent", "mode", "fieldStrategyPresent", "fieldStrategy", "stampPresent", "stamp"]))
        let before = try json(settings())
        await failure { _ = try await core.call("iosVoiceModelDiscovery", argumentsJSON: "[\"{}\"]") }
        await failure { _ = try await core.call("menuCommand", argumentsJSON: json(["iosVoiceModelDiscovery", "{}"])) }
        try assertPrivateAndUnwritten(before)
    }
}
