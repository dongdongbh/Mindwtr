import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class AITextConfigurationNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("AI setup must not perform HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}
private final class AIProviderCaptureHTTPState: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(URLRequest, Data)] = []
    func record(_ request: URLRequest) {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; body.append(contentsOf: buffer.prefix(count)) }
        }
        lock.lock(); values.append((request, body)); lock.unlock()
    }
    var requests: [(URLRequest, Data)] { lock.lock(); defer { lock.unlock() }; return values }
}
private final class AIProviderCaptureHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var state: AIProviderCaptureHTTPState?
    static func install(_ value: AIProviderCaptureHTTPState) { lock.lock(); state = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.state; Self.lock.unlock(); state?.record(request)
        let text = "{\"context\":\"@home\",\"tags\":[\"#provider-native\"],\"timeEstimate\":\"15min\"}"
        let payload: [String: Any]
        switch request.url?.host {
        case "generativelanguage.googleapis.com": payload = ["candidates": [["content": ["parts": [["text": text]]]]]]
        case "api.anthropic.com": payload = ["content": [["type": "text", "text": text]]]
        default: XCTFail("Provider fixture must use an official selected endpoint"); client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed); client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
private final class AITextConfigurationIO: @unchecked Sendable {
    private let lock = NSLock()
    private var failing = false
    private(set) var commits = 0
    func failCommit(_ value: Bool) { lock.lock(); failing = value; lock.unlock() }
    func beforeSQL(_ text: String) throws {
        lock.lock(); let fail = text == "COMMIT" && failing
        if fail { commits += 1 }; lock.unlock()
        if fail { throw HostFailure("Synthetic scalar save failure") }
    }
}

final class AITextConfigurationTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL { root.appendingPathComponent("device/Library/Application Support/mindwtr.ai-text.fixture/RCTAsyncLocalStorage_V1/manifest.json") }
    private let sentinel = "SYNTHETIC-AI-SETUP-PRIVATE"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Actual production iOS bundle required") }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = support.appendingPathComponent("AITextConfigurationTests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Synthetic setup fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("device"), withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: bundle)
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
    }
    override func tearDownWithError() throws {
        if let service {
            for provider in ["openai", "gemini", "anthropic"] { for alias in ["legacy", "auth", "no-auth"] { _ = SecItemDelete(secretQuery(service, provider: provider, alias: alias) as CFDictionary) } }
        }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func host(_ faults: HostIOFaults = HostIOFaults(), io: AITextConfigurationIO? = nil) -> CoreHost {
        faults.secretService = service
        if let io { faults.beforeSQL = { try io.beforeSQL($0) } }
        if faults.httpConfiguration == nil { let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AITextConfigurationNoHTTP.self]; faults.httpConfiguration = config }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), "mindwtr.ai-text.fixture"))
        addTeardownBlock { await core.close() }; return core
    }
    private func secretQuery(_ service: String, provider: String = "openai", alias: String = "no-auth") -> [String: Any] {
        let account = Data(("mindwtr-ai-key_" + provider).utf8)
        #if os(macOS)
        let accountValue: Any = "mindwtr-ai-key_" + provider
        #else
        let accountValue: Any = account
        #endif
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
            kSecAttrAccount as String: accountValue, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    @discardableResult private func rows(_ sql: String, _ arguments: [Any] = []) throws -> [[String: Any]] {
        let connection = try SQLiteBridge(url: database); defer { connection.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(connection.execute(sql, parametersJSON: json(arguments)).utf8)) as? [[String: Any]])
    }
    private func settings() throws -> [String: Any] { try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)) }
    private func seed(ai: [String: Any], legacy: Bool = false) async throws {
        let writer = host(); _ = try await writer.start(); await writer.close()
        var value = try settings(); value["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(value)])
        if legacy {
            try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(json(["mindwtr-ai-key:openai": sentinel, "mindwtr-ai-key:gemini": "other-provider"]).utf8).write(to: manifest)
        }
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
    }
    private func request(_ session: NativeAITextConfigurationSession, _ change: NativeAITextConfigurationChange,
        consent: Bool = false) -> NativeAITextConfigurationRequest { .init(requestId: UUID().uuidString.lowercased(), change: change, expected: session.options.expected, consent: consent) }
    private func assertPrivateBytesAbsent(file: StaticString = #filePath, line: UInt = #line) throws {
        let receipts = try json(rows("SELECT * FROM native_request_receipts"))
        XCTAssertFalse(receipts.contains(sentinel), file: file, line: line)
        if FileManager.default.fileExists(atPath: journal.path) { XCTAssertFalse(try String(contentsOf: journal).contains(sentinel), file: file, line: line) }
        let log = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: log.path) { XCTAssertFalse(try String(contentsOf: log).contains(sentinel), file: file, line: line) }
    }

    private func requestV2(_ session: NativeAITextConfigurationSessionV2, _ change: NativeAITextConfigurationChangeV2, consent: Bool = false) -> NativeAITextConfigurationRequestV2 {
        .init(requestId: UUID().uuidString.lowercased(), change: change, expected: session.options.expected, consent: consent)
    }
    private func seedSyntheticCredential(provider: NativeAISettingsProjection.Provider, value: String) throws {
        var input = secretQuery(service, provider: provider.rawValue)
        input[kSecValueData as String] = Data(value.utf8); input[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
    }
    private func syntheticCredential(provider: NativeAISettingsProjection.Provider) throws -> Data? {
        var input = secretQuery(service, provider: provider.rawValue); input[kSecReturnData as String] = true; input[kSecMatchLimit as String] = kSecMatchLimitOne
        var data: CFTypeRef?; let status = SecItemCopyMatching(input as CFDictionary, &data)
        if status == errSecItemNotFound { return nil }; XCTAssertEqual(status, errSecSuccess); return try XCTUnwrap(data as? Data)
    }

    func testV2SelectedProvidersOpenWithoutMigrationAndCredentialSaveClearPreservesOtherProviders() async throws {
        for provider in [NativeAISettingsProjection.Provider.gemini, .anthropic] {
            try await seed(ai: ["provider": provider.rawValue, "model": "custom selected", "baseUrl": "https://fixture.invalid/" + sentinel])
            try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let values = ["mindwtr-ai-key:" + provider.rawValue: sentinel, "mindwtr-ai-key:openai": "retained OpenAI"]
            try Data(json(values).utf8).write(to: manifest)
            let core = host(); _ = try await core.start(); let before = try json(rows("SELECT * FROM settings")), initialManifest = try Data(contentsOf: manifest)
            let opened = try await core.beginAITextConfigurationV2()
            XCTAssertEqual(opened.options.provider, provider); XCTAssertEqual(opened.options.model, "custom selected"); XCTAssertTrue(opened.credentialAvailable)
            XCTAssertEqual(Set(opened.options.providerOptions.map { $0.value.rawValue }), Set(["openai", "gemini", "anthropic"]))
            XCTAssertEqual(try json(rows("SELECT * FROM settings")), before); XCTAssertEqual(try Data(contentsOf: manifest), initialManifest)
            await failure { _ = try await core.readAITextEndpoint(session: opened.id, expected: opened.options.expected) }
            await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: "https://other.invalid", expected: opened.options.expected) }
            try await core.saveAITextKey(session: opened.id, value: sentinel + provider.rawValue, expected: opened.options.expected)
            XCTAssertEqual(try syntheticCredential(provider: provider), Data((sentinel + provider.rawValue).utf8))
            let map = try object(String(contentsOf: manifest)); XCTAssertNil(map["mindwtr-ai-key:" + provider.rawValue]); XCTAssertEqual(map["mindwtr-ai-key:openai"] as? String, "retained OpenAI")
            await core.close()
            let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfigurationV2()
            XCTAssertEqual(reopened.options.provider, provider); XCTAssertTrue(reopened.credentialAvailable)
            try await cold.clearAITextKey(session: reopened.id, expected: reopened.options.expected)
            let missing = try await cold.readAITextCredentialAvailable(session: reopened.id); XCTAssertFalse(missing)
            XCTAssertNil(try syntheticCredential(provider: provider)); try assertPrivateBytesAbsent(); await cold.close()
        }
    }

    func testV2EnabledSwitchPromptsForTargetCancelsWithoutWritesThenAtomicallyDefaultsAndRetiresOwner() async throws {
        try await seed(ai: ["provider": "openai", "enabled": true, "model": "custom old", "copilotModel": "custom old copilot", "reasoningEffort": "high", "thinkingBudget": 17,
            "baseUrl": "https://fixture.invalid/" + sentinel, "openAIExtraBodyParams": ["private": sentinel], "speechToText": ["provider": "whisper", "offlineModelPath": sentinel]])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try settings()
        let first = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .provider(.gemini)), readmission: { true })
        guard case .consent(let target, let prompt) = first else { return XCTFail("Enabled switch must request selected target consent") }
        XCTAssertEqual(target, .gemini); XCTAssertTrue(prompt.message.contains("Gemini")); XCTAssertEqual(try json(settings()), try json(before)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let agreed = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .provider(.gemini), consent: true), readmission: { true })
        guard case .saved(let result, let recorded) = agreed else { return XCTFail("Expected switched provider") }; XCTAssertTrue(result.changed); XCTAssertTrue(recorded)
        await failure { try await core.saveAITextKey(session: opened.id, value: sentinel, expected: opened.options.expected) }
        let selected = try await core.beginAITextConfigurationV2(); XCTAssertEqual(selected.options.provider, .gemini); XCTAssertTrue(selected.options.enabled)
        let ai = try XCTUnwrap(settings()["ai"] as? [String: Any]), old = try XCTUnwrap(before["ai"] as? [String: Any])
        XCTAssertNotEqual(ai["model"] as? String, "custom old"); XCTAssertNotEqual(ai["copilotModel"] as? String, "custom old copilot")
        XCTAssertEqual(ai["baseUrl"] as? String, old["baseUrl"] as? String); XCTAssertEqual(try json(XCTUnwrap(ai["speechToText"])), try json(XCTUnwrap(old["speechToText"])))
        XCTAssertEqual(try json(XCTUnwrap(ai["openAIExtraBodyParams"])), try json(XCTUnwrap(old["openAIExtraBodyParams"])))
        var custom = selected.options.expected
        let edited = try await core.setAITextConfigurationV2(session: selected.id, request: requestV2(selected, .model("custom Gemini")), readmission: { true })
        guard case .saved = edited else { return XCTFail("Expected custom model") }
        custom = try await core.readAITextSetupOptionsV2(session: selected.id).expected
        let noop = try await core.setAITextConfigurationV2(session: selected.id, request: .init(requestId: UUID().uuidString.lowercased(), change: .provider(.gemini), expected: custom), readmission: { true })
        guard case .saved(let unchanged, _) = noop else { return XCTFail("Current provider must not prompt") }; XCTAssertFalse(unchanged.changed)
        let same = try await core.readAITextSetupOptionsV2(session: selected.id); XCTAssertEqual(same.model, "custom Gemini"); try assertPrivateBytesAbsent()
    }

    func testV2FailedTargetConsentRetrySurvivesSwitchRetirementAndCannotAdoptCurrentProvider() async throws {
        try await seed(ai: ["provider": "openai", "enabled": true])
        let faults = HostIOFaults(); var storage: NativeDeviceKV?; faults.configureDeviceStorage = { storage = $0 }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), retained = try XCTUnwrap(storage)
        retained.faults.beforePromotion = { throw HostFailure("Synthetic target agreement failure") }
        let result = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .provider(.anthropic), consent: true), readmission: { true })
        guard case .saved(let saved, let recorded) = result else { return XCTFail("Explicit agreement authorizes switch") }; XCTAssertTrue(saved.changed); XCTAssertFalse(recorded)
        XCTAssertEqual((try settings()["ai"] as? [String: Any])?["provider"] as? String, "anthropic")
        await failure { _ = try await core.beginAITextConfigurationV2() }
        XCTAssertThrowsError(try retained.recordAIConsent(provider: .gemini))
        retained.faults.beforePromotion = nil
        let retried = try await core.retryAITextConsentRecord(session: opened.id); XCTAssertTrue(retried)
        XCTAssertTrue(try retained.readAIConsentRecorded(provider: .anthropic)); XCTAssertFalse(try retained.readAIConsentRecorded(provider: .gemini)); XCTAssertFalse(try retained.readAIConsentRecorded(provider: .openai))
        let fresh = try await core.beginAITextConfigurationV2(); XCTAssertEqual(fresh.options.provider, .anthropic); XCTAssertTrue(fresh.consentRecorded)
        await failure { try await core.saveAITextKey(session: opened.id, value: sentinel, expected: opened.options.expected) }
    }

    func testPendingConsentTargetRejectsFreshSwitchAndSensitiveWriteUntilOriginalRetrySettles() async throws {
        let faults = HostIOFaults(); var storage: NativeDeviceKV?; faults.configureDeviceStorage = { storage = $0 }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), retained = try XCTUnwrap(storage)
        retained.faults.beforePromotion = { throw HostFailure("Synthetic original agreement failure") }
        let enabled = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .enabled(true), consent: true), readmission: { true })
        guard case .saved(_, let recorded) = enabled else { return XCTFail("Expected standing explicit agreement") }; XCTAssertFalse(recorded)
        let refreshed = try await core.readAITextSetupOptionsV2(session: opened.id), before = try json(settings())
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id,
            request: .init(requestId: UUID().uuidString.lowercased(), change: .provider(.gemini), expected: refreshed.expected, consent: true), readmission: { true }) }
        await failure { try await core.saveAITextKey(session: opened.id, value: sentinel, expected: refreshed.expected) }
        XCTAssertEqual(try json(settings()), before); XCTAssertNil(try syntheticCredential(provider: .openai)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        retained.faults.beforePromotion = nil
        let retried = try await core.retryAITextConsentRecord(session: opened.id); XCTAssertTrue(retried)
        XCTAssertTrue(try retained.readAIConsentRecorded(provider: .openai)); XCTAssertFalse(try retained.readAIConsentRecorded(provider: .gemini))
        let current = try await core.readAITextSetupOptionsV2(session: opened.id)
        let next = try await core.setAITextConfigurationV2(session: opened.id,
            request: .init(requestId: UUID().uuidString.lowercased(), change: .provider(.gemini), expected: current.expected), readmission: { true })
        guard case .consent(let provider, _) = next else { return XCTFail("Next provider still needs its own agreement") }; XCTAssertEqual(provider, .gemini)
    }

    func testV2ProviderFailedCommitExactRetryAndRestartPreserveLaterCustomModel() async throws {
        let io = AITextConfigurationIO(), core = host(io: io); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let intent = requestV2(opened, .provider(.anthropic)); io.failCommit(true)
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: intent, readmission: { true }) }
        let bytes = try Data(contentsOf: journal); XCTAssertEqual(try object(String(decoding: bytes, as: UTF8.self))["method"] as? String, "iosAITextConfigurationCommitV2")
        await core.retireAITextConfiguration(session: opened.id); io.failCommit(false)
        _ = try await core.setAITextConfigurationV2(session: opened.id, request: intent, readmission: { true })
        let fresh = try await core.beginAITextConfigurationV2()
        _ = try await core.setAITextConfigurationV2(session: fresh.id, request: requestV2(fresh, .copilotModel("later custom")), readmission: { true })
        await core.close()
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfigurationV2()
        XCTAssertEqual(reopened.options.provider, .anthropic); XCTAssertEqual(reopened.options.copilotModel, "later custom"); try assertPrivateBytesAbsent()
    }

    func testV2ColdSavedProviderReceiptDoesNotResetLaterModels() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        faults.journalRemove = { throw HostFailure("Synthetic v2 receipt delivery interruption") }
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .provider(.gemini)), readmission: { true }) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        await core.close()
        var later = try settings(), ai = try XCTUnwrap(later["ai"] as? [String: Any]); ai["model"] = "later Gemini assistant"; ai["copilotModel"] = "later Gemini copilot"; later["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(later)])
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfigurationV2()
        XCTAssertEqual(reopened.options.provider, .gemini); XCTAssertEqual(reopened.options.model, "later Gemini assistant"); XCTAssertEqual(reopened.options.copilotModel, "later Gemini copilot")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testV1ColdReceiptRecoveryAfterLaterV2ProviderDoesNotResetSelection() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start(); let old = try await core.beginAITextConfiguration()
        faults.journalRemove = { throw HostFailure("Synthetic v1 receipt delivery interruption") }
        await failure { _ = try await core.setAITextConfiguration(session: old.id, request: request(old, .model("v1 selected model")), readmission: { true }) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        await core.close()
        var later = try settings(); later["ai"] = ["provider": "gemini", "model": "later Gemini model", "copilotModel": "later Gemini copilot"]
        try rows("UPDATE settings SET data=? WHERE id=1", [json(later)])
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfigurationV2()
        XCTAssertEqual(reopened.options.provider, .gemini); XCTAssertEqual(reopened.options.model, "later Gemini model"); XCTAssertEqual(reopened.options.copilotModel, "later Gemini copilot")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testAnthropicThinkingReadPreservesAbsentDefaultAndCustomBudgets() async throws {
        for budget: Int? in [nil, 0, 17, 2048] {
            var ai: [String: Any] = ["provider": "anthropic", "enabled": false, "model": "custom assistant", "baseUrl": sentinel]
            if let budget { ai["thinkingBudget"] = budget }
            try await seed(ai: ai)
            let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
            let before = try json(settings()), options = try await core.readAIAnthropicThinkingOptions(session: opened.id)
            XCTAssertEqual(options.expected, opened.options.expected)
            XCTAssertEqual(options.value, budget ?? 0); XCTAssertEqual(options.enabled, (budget ?? 0) > 0)
            XCTAssertEqual(options.options.map { $0.value }, [1024, 2048, 4096]); XCTAssertTrue(options.options.allSatisfy { !$0.label.isEmpty })
            XCTAssertEqual(try json(settings()), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
            XCTAssertEqual(Set(options.expected.object.keys), Set(["aiPresent", "providerPresent", "provider", "enabledPresent", "enabled", "modelPresent", "model", "copilotModelPresent", "copilotModel", "effortPresent", "effort", "budgetPresent", "budget", "stampPresent", "stamp"]))
            await core.close()
        }
    }

    func testAnthropicThinkingToggleAndPresetUseExistingWriterWithoutConsentOrUnrelatedChanges() async throws {
        let original: [String: Any] = ["provider": "anthropic", "enabled": false, "model": "custom assistant", "copilotModel": "custom copilot",
            "baseUrl": sentinel, "openAIExtraBodyParams": ["private": sentinel], "speechToText": ["provider": "whisper"]]
        try await seed(ai: original)
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
        func edit(_ change: NativeAITextConfigurationChangeV2) async throws -> NativeAITextConfigurationResultV2 {
            let options = try await core.readAIAnthropicThinkingOptions(session: opened.id)
            let outcome = try await core.setAITextConfigurationV2(session: opened.id,
                request: .init(requestId: UUID().uuidString.lowercased(), change: change, expected: options.expected), readmission: { true })
            guard case .saved(let result, let recorded) = outcome else { throw HostFailure("Thinking controls must not request consent") }
            XCTAssertFalse(recorded); XCTAssertEqual(result.change, change); return result
        }
        let alreadyOff = try await edit(.anthropicThinking(false)); XCTAssertFalse(alreadyOff.changed); XCTAssertEqual(try json(settings()), before)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
        let enabled = try await edit(.anthropicThinking(true)); XCTAssertTrue(enabled.changed)
        var current = try await core.readAIAnthropicThinkingOptions(session: opened.id); XCTAssertEqual(current.value, 1024); XCTAssertTrue(current.enabled)
        let preset = try await edit(.thinkingBudget(2048)); XCTAssertTrue(preset.changed)
        let saved = try json(settings()), repeated = try await edit(.anthropicThinking(true)); XCTAssertFalse(repeated.changed); XCTAssertEqual(try json(settings()), saved)
        let samePreset = try await edit(.thinkingBudget(2048)); XCTAssertFalse(samePreset.changed); XCTAssertEqual(try json(settings()), saved)
        let disabled = try await edit(.anthropicThinking(false)); XCTAssertTrue(disabled.changed)
        current = try await core.readAIAnthropicThinkingOptions(session: opened.id); XCTAssertEqual(current.value, 0); XCTAssertFalse(current.enabled)
        var after = try XCTUnwrap(settings()["ai"] as? [String: Any]); after.removeValue(forKey: "thinkingBudget")
        XCTAssertEqual(try json(after), try json(original)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testAnthropicThinkingCustomOnIsNoopAndInvalidPresetOrOffBudgetRefuses() async throws {
        try await seed(ai: ["provider": "anthropic", "thinkingBudget": 17])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
        let custom = try await core.readAIAnthropicThinkingOptions(session: opened.id); XCTAssertEqual(custom.value, 17)
        let outcome = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .anthropicThinking(true)), readmission: { true })
        guard case .saved(let result, _) = outcome else { return XCTFail("Custom budget On must be a no-op") }; XCTAssertFalse(result.changed)
        XCTAssertEqual(try json(settings()), before)
        let fresh = try await core.readAITextSetupOptionsV2(session: opened.id)
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id,
            request: .init(requestId: UUID().uuidString.lowercased(), change: .thinkingBudget(17), expected: fresh.expected), readmission: { true }) }
        XCTAssertEqual(try json(settings()), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        try await seed(ai: ["provider": "anthropic"])
        let off = host(); _ = try await off.start(); let offSession = try await off.beginAITextConfigurationV2(), offBefore = try json(settings())
        await failure { _ = try await off.setAITextConfigurationV2(session: offSession.id, request: requestV2(offSession, .thinkingBudget(2048)), readmission: { true }) }
        XCTAssertEqual(try json(settings()), offBefore); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
    }

    func testAnthropicThinkingReadAndWriteRefuseForeignRetiredAndStaleSessions() async throws {
        for provider in ["openai", "gemini"] {
            try await seed(ai: ["provider": provider, "thinkingBudget": 2048])
            let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            await failure { _ = try await core.readAIAnthropicThinkingOptions(session: opened.id) }
            await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .anthropicThinking(false)), readmission: { true }) }
            XCTAssertEqual(try json(settings()), before); await core.close()
        }
        try await seed(ai: ["provider": "anthropic", "thinkingBudget": 1024])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let options = try await core.readAIAnthropicThinkingOptions(session: opened.id)
        var changed = try settings(), ai = try XCTUnwrap(changed["ai"] as? [String: Any]); ai["thinkingBudget"] = 4096; changed["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(changed)])
        await failure { _ = try await core.readAIAnthropicThinkingOptions(session: opened.id) }
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id,
            request: .init(requestId: UUID().uuidString.lowercased(), change: .thinkingBudget(2048), expected: options.expected), readmission: { true }) }
        XCTAssertEqual(try json(settings()), try json(changed)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        let reloaded = host(); _ = try await reloaded.start(); let fresh = try await reloaded.beginAITextConfigurationV2()
        let current = try await reloaded.readAIAnthropicThinkingOptions(session: fresh.id); XCTAssertEqual(current.value, 4096)
        await reloaded.retireAITextConfiguration(session: fresh.id)
        await failure { _ = try await reloaded.readAIAnthropicThinkingOptions(session: fresh.id) }
    }

    func testAnthropicThinkingFailedSaveExactRetryAndColdReceiptPreserveLaterBudget() async throws {
        try await seed(ai: ["provider": "anthropic", "thinkingBudget": 1024])
        let faults = HostIOFaults(), io = AITextConfigurationIO(), core = host(faults, io: io)
        _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), intent = requestV2(opened, .thinkingBudget(2048))
        io.failCommit(true)
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: intent, readmission: { true }) }
        let frozen = try Data(contentsOf: journal)
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, .thinkingBudget(4096)), readmission: { true }) }
        XCTAssertEqual(try Data(contentsOf: journal), frozen); io.failCommit(false)
        _ = try await core.setAITextConfigurationV2(session: opened.id, request: intent, readmission: { true })
        let current = try await core.readAIAnthropicThinkingOptions(session: opened.id); XCTAssertEqual(current.value, 2048)
        faults.journalRemove = { throw HostFailure("Synthetic thinking receipt delivery interruption") }
        await failure { _ = try await core.setAITextConfigurationV2(session: opened.id,
            request: .init(requestId: UUID().uuidString.lowercased(), change: .thinkingBudget(4096), expected: current.expected), readmission: { true }) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        var later = try settings(), ai = try XCTUnwrap(later["ai"] as? [String: Any]); ai["thinkingBudget"] = 17; later["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(later)])
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfigurationV2()
        let retained = try await cold.readAIAnthropicThinkingOptions(session: reopened.id); XCTAssertEqual(retained.value, 17)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 2)
    }

    func testAnthropicThinkingDTOAndV2VariantGrammarRejectMalformedReplies() async throws {
        try await seed(ai: ["provider": "anthropic", "thinkingBudget": 17])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let options = try await core.readAIAnthropicThinkingOptions(session: opened.id)
        let valid: [String: Any] = ["version": 1, "enabled": true, "value": 17, "options": options.options.map { ["value": $0.value, "label": $0.label] }, "expected": options.expected.object]
        XCTAssertEqual(try NativeAIAnthropicThinkingOptions.validated(json(valid)), options)
        for patch: [String: Any] in [["version": 2], ["enabled": 1], ["enabled": false], ["value": true], ["value": 1.5], ["value": 32769],
            ["value": 2048], ["extra": true], ["options": []], ["options": [["value": true, "label": "Low"]]],
            ["options": [["value": 1024, "label": "Low"], ["value": 1024, "label": "Low"]]], ["options": [["value": 1024, "label": String(repeating: "x", count: 2001)]]]] {
            var changed = valid; changed.merge(patch) { _, new in new }; XCTAssertThrowsError(try NativeAIAnthropicThinkingOptions.validated(json(changed)))
        }
        var witness = options.expected.object; witness["provider"] = "gemini"
        var foreign = valid; foreign["expected"] = witness; XCTAssertThrowsError(try NativeAIAnthropicThinkingOptions.validated(json(foreign)))
        XCTAssertThrowsError(try NativeAIAnthropicThinkingOptions.validated("{\"version\":1,\"version\":1}"))
        for value: [String: Any] in [["type": "anthropicThinking", "value": 1], ["type": "thinkingBudget", "value": true],
            ["type": "thinkingBudget", "value": 1.5], ["type": "thinkingBudget", "value": 0], ["type": "thinkingBudget", "value": 32769],
            ["type": "thinkingBudget", "value": 2048, "extra": true]] { XCTAssertThrowsError(try NativeAITextConfigurationChangeV2.validated(value)) }
        XCTAssertThrowsError(try NativeAITextConfigurationChange.validated(["type": "anthropicThinking", "value": true]))
    }

    func testAnthropicThinkingNoopAcknowledgmentMustProveEffectiveToggleAndExactRawBudget() async throws {
        for change in [NativeAITextConfigurationChangeV2.anthropicThinking(false), .thinkingBudget(2048)] {
            try await seed(ai: ["provider": "anthropic", "thinkingBudget": 1024])
            let suffix = """
            ;MindwtrHost.iosAITextConfigurationPrepareV2 = function(input, owner) {
                owner(); return JSON.stringify({kind:'noop',result:{change:JSON.parse(input).change,changed:false}});
            };
            """
            try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
            let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            await failure { _ = try await core.setAITextConfigurationV2(session: opened.id, request: requestV2(opened, change), readmission: { true }) }
            XCTAssertEqual(try json(settings()), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); await core.close()
        }
    }

    func testOpenAIExtraBodyReadSaveAndClearStayPrivateAndLeaveCredentialsPassive() async throws {
        let original: [String: Any] = ["provider": "openai", "enabled": false, "model": "custom assistant", "baseUrl": "https://fixture.invalid/v1",
            "thinkingBudget": 17, "speechToText": ["provider": "whisper"], "openAIExtraBodyParams": ["nested": ["private": sentinel]]]
        try await seed(ai: original, legacy: true)
        let faults = HostIOFaults(); var secretOperations: [String] = []
        faults.secretBeforeOperation = { operation, _ in secretOperations.append(operation) }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let before = try json(settings()), legacy = try Data(contentsOf: manifest), tasks = try json(rows("SELECT * FROM tasks"))
        secretOperations.removeAll()
        let initial = try await core.readAITextExtraBody(session: opened.id, expected: opened.options.expected)
        XCTAssertTrue(initial.contains(sentinel)); XCTAssertEqual(try json(settings()), before)
        let privateText = try json(["max_tokens": 512, "nested": ["private": sentinel]])
        let changed = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: privateText, expected: opened.options.expected); XCTAssertTrue(changed)
        var current = try await core.readAITextSetupOptionsV2(session: opened.id)
        let formatted = try await core.readAITextExtraBody(session: opened.id, expected: current.expected)
        XCTAssertEqual(try json(object(formatted)), privateText); XCTAssertTrue(formatted.contains("\n"))
        var after = try XCTUnwrap(settings()["ai"] as? [String: Any]), retained = original
        after.removeValue(forKey: "openAIExtraBodyParams"); retained.removeValue(forKey: "openAIExtraBodyParams")
        XCTAssertEqual(try json(after), try json(retained))
        for clear in ["{}", " \n "] {
            _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: clear, expected: current.expected)
            current = try await core.readAITextSetupOptionsV2(session: opened.id)
            let blank = try await core.readAITextExtraBody(session: opened.id, expected: current.expected); XCTAssertEqual(blank, "")
        }
        XCTAssertEqual(try Data(contentsOf: manifest), legacy); XCTAssertTrue(secretOperations.isEmpty)
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), tasks); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); try assertPrivateBytesAbsent()
        XCTAssertFalse(try json(current.expected.object).contains(sentinel))
    }

    func testOpenAIExtraBodyInvalidDraftAndFormattingOverflowAreDefiniteAndRemainEditable() async throws {
        try await seed(ai: ["provider": "openai", "openAIExtraBodyParams": ["retained": sentinel]])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
        let expansion = String(repeating: "{\"a\":", count: 90) + "1" + String(repeating: "}", count: 90)
        for draft in ["[1]", "null", "true", "1", "{\"private\":\"" + sentinel, String(repeating: " ", count: 4001), expansion] {
            do { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: draft, expected: opened.options.expected); XCTFail("Invalid draft saved") }
            catch { XCTAssertTrue(error is CoreHostRejection); XCTAssertFalse(String(describing: error).contains(sentinel)) }
            XCTAssertEqual(try json(settings()), before)
        }
        let corrected = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: "{\"max_tokens\":512}", expected: opened.options.expected)
        XCTAssertTrue(corrected); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
        try assertPrivateBytesAbsent()
    }

    func testOpenAIExtraBodyFailedSaveRetainsExactAttemptWithoutSensitiveJournal() async throws {
        try await seed(ai: ["provider": "openai", "openAIExtraBodyParams": ["retained": sentinel]])
        let io = AITextConfigurationIO(), core = host(io: io); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        let attempt = UUID(), text = try json(["private": sentinel, "max_tokens": 512]), before = try json(settings())
        io.failCommit(true)
        do { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: attempt, value: text, expected: opened.options.expected); XCTFail("Failed save acknowledged") }
        catch { XCTAssertFalse(error is CoreHostRejection); XCTAssertFalse(String(describing: error).contains(sentinel)) }
        XCTAssertEqual(try json(settings()), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await failure { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: attempt, value: text + " ", expected: opened.options.expected) }
        XCTAssertEqual(try json(settings()), before); io.failCommit(false)
        let retried = try await core.saveAITextExtraBody(session: opened.id, attempt: attempt, value: text, expected: opened.options.expected); XCTAssertTrue(retried)
        XCTAssertEqual(try json(XCTUnwrap((settings()["ai"] as? [String: Any])?["openAIExtraBodyParams"])), text)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testOpenAIExtraBodyLostReplyAndOldAttemptReplayPreserveLaterSave() async throws {
        try await seed(ai: ["provider": "openai"])
        let suffix = """
        ;(() => {
            const sensitive = MindwtrHost.iosAITextConfigurationSensitiveV2, poll = MindwtrHost.poll;
            let first = true, held = null;
            MindwtrHost.iosAITextConfigurationSensitiveV2 = function(input, owner) {
                const ticket = sensitive.call(this, input, owner);
                if (first && JSON.parse(input).op === 'save-extra-body') { first = false; held = ticket; }
                return ticket;
            };
            MindwtrHost.poll = function(ticket) {
                const raw = poll.call(this, ticket);
                if (ticket === held && raw !== null) {
                    held = null; if (JSON.parse(raw).ok) return JSON.stringify({ok:false,error:'ACTION_FAILED: Synthetic saved reply interruption'});
                }
                return raw;
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), attemptA = UUID()
        let textA = try json(["private": sentinel, "max_tokens": 512]), textB = "{\"max_tokens\":1024}"
        do { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: attemptA, value: textA, expected: opened.options.expected); XCTFail("Lost reply reported success") }
        catch { XCTAssertFalse(error is CoreHostRejection) }
        let replay = try await core.saveAITextExtraBody(session: opened.id, attempt: attemptA, value: textA, expected: opened.options.expected); XCTAssertTrue(replay)
        let current = try await core.readAITextSetupOptionsV2(session: opened.id)
        _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: textB, expected: current.expected)
        let savedB = try json(settings())
        let oldReplay = try await core.saveAITextExtraBody(session: opened.id, attempt: attemptA, value: textA, expected: opened.options.expected); XCTAssertTrue(oldReplay)
        XCTAssertEqual(try json(settings()), savedB)
        XCTAssertEqual(try json(XCTUnwrap((settings()["ai"] as? [String: Any])?["openAIExtraBodyParams"])), try json(object(textB)))
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
        await core.close()
        let cold = host(); _ = try await cold.start(); let fresh = try await cold.beginAITextConfigurationV2()
        let actual = try await cold.readAITextExtraBody(session: fresh.id, expected: fresh.options.expected); XCTAssertEqual(try json(object(actual)), try json(object(textB)))
        await failure { _ = try await cold.saveAITextExtraBody(session: opened.id, attempt: attemptA, value: textA, expected: opened.options.expected) }
    }

    func testOpenAIExtraBodySelectedOriginalSessionAndOversizeStoredValueArePreserved() async throws {
        for provider in ["gemini", "anthropic"] {
            try await seed(ai: ["provider": provider, "openAIExtraBodyParams": ["retained": sentinel]])
            let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
            await failure { _ = try await core.readAITextExtraBody(session: opened.id, expected: opened.options.expected) }
            await failure { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: "{}", expected: opened.options.expected) }
            XCTAssertEqual(try json(settings()), before); await core.close()
        }
        try await seed(ai: ["provider": "openai", "openAIExtraBodyParams": ["legacy": String(repeating: "x", count: 5000)]])
        let oversized = host(); _ = try await oversized.start(); let page = try await oversized.beginAITextConfigurationV2(), before = try json(settings())
        await failure { _ = try await oversized.readAITextExtraBody(session: page.id, expected: page.options.expected) }
        XCTAssertEqual(try json(settings()), before); await oversized.close()
        try await seed(ai: ["provider": "openai", "openAIExtraBodyParams": ["private": sentinel]])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        var changed = try settings(), ai = try XCTUnwrap(changed["ai"] as? [String: Any]); ai["openAIExtraBodyParams"] = ["external": true]; changed["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(changed)])
        await failure { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: "{}", expected: opened.options.expected) }
        XCTAssertEqual(try json(settings()), try json(changed)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        let reloaded = host(); _ = try await reloaded.start(); let fresh = try await reloaded.beginAITextConfigurationV2()
        await reloaded.retireAITextConfiguration(session: fresh.id)
        await failure { _ = try await reloaded.readAITextExtraBody(session: fresh.id, expected: fresh.options.expected) }
    }

    func testOpenAIExtraBodyClosedRepliesAndAcceptedInvalidInputRemainUncertain() async throws {
        try await seed(ai: ["provider": "openai"])
        let suffix = """
        ;(() => {
            const sensitive = MindwtrHost.iosAITextConfigurationSensitiveV2, poll = MindwtrHost.poll;
            const reads = new Set();
            MindwtrHost.iosAITextConfigurationSensitiveV2 = function(input, owner) {
                const parsed = JSON.parse(input);
                if (parsed.op === 'save-extra-body') {
                    owner(JSON.stringify({phase:'extra-body-save'}));
                    throw new Error('INVALID_INPUT: Synthetic error after admission');
                }
                const ticket = sensitive.call(this, input, owner); if (parsed.op === 'read-extra-body') reads.add(ticket); return ticket;
            };
            MindwtrHost.poll = function(ticket) {
                const raw = poll.call(this, ticket);
                if (reads.has(ticket) && raw !== null) { reads.delete(ticket); return JSON.stringify({ok:true,value:{value:'{}',extra:true}}); }
                return raw;
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2(), before = try json(settings())
        await failure { _ = try await core.readAITextExtraBody(session: opened.id, expected: opened.options.expected) }
        do { _ = try await core.saveAITextExtraBody(session: opened.id, attempt: UUID(), value: "{}", expected: opened.options.expected); XCTFail("Admitted failure acknowledged") }
        catch { XCTAssertFalse(error is CoreHostRejection) }
        XCTAssertEqual(try json(settings()), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
    }

    private func exerciseSelectedProviderCapture(_ provider: NativeAISettingsProjection.Provider) async throws {
        try await seed(ai: ["provider": provider.rawValue, "enabled": true, "model": "fixture-model", "copilotModel": "fixture-model", "requestTimeoutSeconds": 30])
        var configured = try settings(); configured["features"] = ["timeEstimates": true]; try rows("UPDATE settings SET data=? WHERE id=1", [json(configured)])
        try seedSyntheticCredential(provider: .openai, value: "unselected OpenAI synthetic")
        try seedSyntheticCredential(provider: provider == .gemini ? .anthropic : .gemini, value: "unselected alternative synthetic")
        let state = AIProviderCaptureHTTPState(), faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AIProviderCaptureHTTP.self]; faults.httpConfiguration = config; AIProviderCaptureHTTP.install(state)
        var readAccounts: [String] = []; faults.configureSecretJobs = { $0.beforeRead = { readAccounts.append($0) } }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfigurationV2()
        try await core.saveAITextKey(session: opened.id, value: sentinel + provider.rawValue, expected: opened.options.expected)
        XCTAssertTrue(state.requests.isEmpty, "Configuration must perform no HTTP")
        await core.close()
        let active = host(faults); _ = try await active.start(); readAccounts.removeAll()
        let capture = try object(await active.call("captureOpen")), options = try XCTUnwrap(capture["options"] as? [String: Any]), text = "Synthetic selected provider task"
        let empty: [String: Any] = ["tags": [String]()]
        let projection = try object(await active.readCaptureCopilotOptions(requestJSON: json(["text": text, "options": options, "applied": empty])))
        let question = try json(["revision": XCTUnwrap(projection["revision"]), "request": XCTUnwrap(projection["request"])])
        let answer = try object(await active.requestCaptureCopilot(requestJSON: question)), suggestion = try XCTUnwrap(answer["suggestion"] as? [String: Any])
        XCTAssertEqual(readAccounts, ["mindwtr-ai-key_" + provider.rawValue]); XCTAssertEqual(state.requests.count, 1)
        let sent = try XCTUnwrap(state.requests.first), body = try object(String(decoding: sent.1, as: UTF8.self))
        if provider == .gemini {
            XCTAssertEqual(sent.0.url?.host, "generativelanguage.googleapis.com"); XCTAssertTrue(sent.0.url?.path.hasSuffix("fixture-model:generateContent") == true)
            XCTAssertEqual(sent.0.value(forHTTPHeaderField: "x-goog-api-key"), sentinel + provider.rawValue); XCTAssertNil(sent.0.value(forHTTPHeaderField: "x-api-key")); XCTAssertNotNil(body["contents"])
        } else {
            XCTAssertEqual(sent.0.url?.absoluteString, "https://api.anthropic.com/v1/messages"); XCTAssertEqual(sent.0.value(forHTTPHeaderField: "x-api-key"), sentinel + provider.rawValue)
            XCTAssertEqual(sent.0.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01"); XCTAssertNil(sent.0.value(forHTTPHeaderField: "x-goog-api-key")); XCTAssertNotNil(body["messages"])
        }
        XCTAssertNil(sent.0.value(forHTTPHeaderField: "Authorization")); XCTAssertFalse(sent.0.url?.absoluteString.contains(sentinel) == true)
        let fresh = try object(await active.readCaptureCopilotOptions(requestJSON: json(["text": text, "options": options, "applied": empty])))
        var edit: [String: Any] = ["text": text, "options": options, "revision": try XCTUnwrap(fresh["revision"]), "suggestion": suggestion, "applied": empty, "edit": NSNull()]
        let chips = try object(await active.call("captureCopilotEdit", argumentsJSON: json([json(edit)])))
        edit["edit"] = try XCTUnwrap((chips["applyAll"] as? [String: Any])?["edit"])
        let applied = try object(await active.call("captureCopilotEdit", argumentsJSON: json([json(edit)]))), id = UUID().uuidString.lowercased()
        let submit = try json([json(["capture": ["text": text, "options": options, "captureId": id, "openAfterSave": false], "applied": XCTUnwrap(applied["applied"])])])
        _ = try await active.call("captureCopilotSubmit", argumentsJSON: submit)
        do {
            _ = try await active.call("captureCopilotSubmit", argumentsJSON: submit)
            XCTFail("A fresh prepare must refuse an already saved capture ID")
        } catch {
            XCTAssertTrue(String(describing: error).contains("Capture ID already exists; replay its prepared journal"))
        }
        let stored = try XCTUnwrap(rows("SELECT contexts,tags,timeEstimate FROM tasks WHERE id=?", [id]).first)
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(stored["contexts"] as? String).utf8))), try json(["@home"]))
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(XCTUnwrap(stored["tags"] as? String).utf8))), try json(["#provider-native"]))
        XCTAssertEqual(stored["timeEstimate"] as? String, "15min"); XCTAssertEqual(try rows("SELECT id FROM tasks WHERE id=?", [id]).count, 1)
        XCTAssertEqual(state.requests.count, 1); try assertPrivateBytesAbsent(); await active.close()
        let final = host(); _ = try await final.start(); XCTAssertEqual(try rows("SELECT id FROM tasks WHERE id=?", [id]).count, 1)
    }
    func testGeminiNativeTransportSelectedCredentialAndDurableAppliedCapture() async throws { try await exerciseSelectedProviderCapture(.gemini) }
    func testAnthropicNativeTransportSelectedCredentialAndDurableAppliedCapture() async throws { try await exerciseSelectedProviderCapture(.anthropic) }

    func testOpenIsNonmutatingAndEnableRequiresSharedConsentThenPersistsSelectedControls() async throws {
        let core = host(); _ = try await core.start()
        let before = try json(rows("SELECT * FROM settings")), opened = try await core.beginAITextConfiguration()
        XCTAssertFalse(opened.options.enabled); XCTAssertFalse(opened.credentialAvailable); XCTAssertFalse(opened.consentRecorded)
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before)
        let asked = try await core.setAITextConfiguration(session: opened.id, request: request(opened, .enabled(true)), readmission: { true })
        guard case .consent(let prompt) = asked else { return XCTFail("Enable must ask for shared consent") }
        XCTAssertFalse(prompt.title.isEmpty); XCTAssertFalse(prompt.message.isEmpty)
        XCTAssertEqual(try json(rows("SELECT * FROM settings")), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let result = try await core.setAITextConfiguration(session: opened.id, request: request(opened, .enabled(true), consent: true), readmission: { true })
        guard case .saved(let saved, let recorded) = result else { return XCTFail("Expected saved agreement") }
        XCTAssertEqual(saved.change, .enabled(true)); XCTAssertTrue(saved.changed); XCTAssertTrue(recorded)
        let refreshed = try await core.readAITextSetupOptions(session: opened.id); XCTAssertTrue(refreshed.enabled)
        let noop = NativeAITextConfigurationRequest(requestId: UUID().uuidString.lowercased(), change: .enabled(true), expected: refreshed.expected)
        let unchanged = try await core.setAITextConfiguration(session: opened.id, request: noop, readmission: { true })
        guard case .saved(let same, _) = unchanged else { return XCTFail("No-op must not ask") }
        XCTAssertFalse(same.changed); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
    }

    func testScalarPreservesUnrelatedAIFieldsAndSensitiveValuesNeverEnterItsJournalOrReceipt() async throws {
        try await seed(ai: ["provider": "openai", "enabled": false, "baseUrl": "https://fixture.invalid/" + sentinel,
            "model": "before", "openAIExtraBodyParams": ["private": sentinel], "speechToText": ["provider": "whisper", "offlineModelPath": sentinel]])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        let before = try XCTUnwrap(settings()["ai"] as? [String: Any])
        let result = try await core.setAITextConfiguration(session: opened.id, request: request(opened, .model("custom assistant")), readmission: { true })
        guard case .saved(let saved, _) = result else { return XCTFail("Expected scalar save") }
        XCTAssertTrue(saved.changed)
        var expected = before; expected["model"] = "custom assistant"
        XCTAssertEqual(try json(XCTUnwrap(settings()["ai"])), try json(expected))
        try assertPrivateBytesAbsent()
    }

    func testActualCommitFailureRequiresExactTypedRetryAfterPageRetirementAndColdReceiptDoesNotRepeat() async throws {
        let io = AITextConfigurationIO(), core = host(io: io); _ = try await core.start()
        let opened = try await core.beginAITextConfiguration(), edit = request(opened, .copilotModel("custom copilot"))
        io.failCommit(true)
        await failure { _ = try await core.setAITextConfiguration(session: opened.id, request: edit, readmission: { true }) }
        XCTAssertGreaterThan(io.commits, 0)
        let frozen = try Data(contentsOf: journal)
        XCTAssertEqual(try object(String(decoding: frozen, as: UTF8.self))["method"] as? String, "iosAITextConfigurationCommit")
        await core.retireAITextConfiguration(session: opened.id)
        await failure { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), frozen)
        io.failCommit(false)
        let result = try await core.setAITextConfiguration(session: opened.id, request: edit, readmission: { true })
        guard case .saved(let saved, _) = result else { return XCTFail("Expected exact retry") }; XCTAssertTrue(saved.changed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfiguration()
        XCTAssertEqual(reopened.options.copilotModel, "custom copilot"); XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        try assertPrivateBytesAbsent()
    }

    func testSensitiveSaveClearRetireOnlySelectedLegacyAndNeverCreateDurableReceipt() async throws {
        try await seed(ai: ["provider": "openai"], legacy: true)
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        XCTAssertTrue(opened.credentialAvailable)
        try await core.saveAITextKey(session: opened.id, value: sentinel + "-replacement", expected: opened.options.expected)
        let present = try await core.readAITextCredentialAvailable(session: opened.id); XCTAssertTrue(present)
        let map = try object(String(contentsOf: manifest)); XCTAssertNil(map["mindwtr-ai-key:openai"]); XCTAssertEqual(map["mindwtr-ai-key:gemini"] as? String, "other-provider")
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
        try await core.clearAITextKey(session: opened.id, expected: opened.options.expected)
        let absent = try await core.readAITextCredentialAvailable(session: opened.id); XCTAssertFalse(absent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testEndpointEditorIsSeparateSensitiveDefaultSaveAndNativeAdmissionNeverPerformsHTTP() async throws {
        try await seed(ai: ["provider": "openai", "baseUrl": "https://fixture.invalid/" + sentinel])
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        XCTAssertFalse(String(describing: opened.options).contains(sentinel))
        let loaded = try await core.readAITextEndpoint(session: opened.id, expected: opened.options.expected); XCTAssertTrue(loaded.contains(sentinel))
        await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: "http://public.invalid/v1", expected: opened.options.expected) }
        await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: "https://name:secret@fixture.invalid/v1", expected: opened.options.expected) }
        let saved = try await core.saveAITextEndpoint(session: opened.id, value: "http://127.0.0.1:9123/v1", expected: opened.options.expected); XCTAssertTrue(saved)
        let options = try await core.readAITextSetupOptions(session: opened.id)
        let defaulted = try await core.saveAITextEndpoint(session: opened.id, value: "", expected: options.expected); XCTAssertTrue(defaulted)
        XCTAssertEqual((try settings()["ai"] as? [String: Any])?["baseUrl"] as? String, "")
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); try assertPrivateBytesAbsent()
    }

    func testEndpointCommitFailureRequiresSameExplicitValueAndRetriesWithoutJournalOrDurableReceipt() async throws {
        let io = AITextConfigurationIO(), core = host(io: io); _ = try await core.start()
        let opened = try await core.beginAITextConfiguration(), endpoint = "https://fixture.invalid/" + sentinel
        io.failCommit(true)
        await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: endpoint, expected: opened.options.expected) }
        XCTAssertGreaterThan(io.commits, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        io.failCommit(false)
        await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: "https://other.invalid/v1", expected: opened.options.expected) }
        let retried = try await core.saveAITextEndpoint(session: opened.id, value: endpoint, expected: opened.options.expected)
        XCTAssertTrue(retried)
        let refreshed = try await core.readAITextSetupOptions(session: opened.id)
        let stored = try await core.readAITextEndpoint(session: opened.id, expected: refreshed.expected); XCTAssertEqual(stored, endpoint)
        XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty); try assertPrivateBytesAbsent()
    }

    func testOnlyOwnedSavedTransitionAdvancesPageGeneration() async throws {
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        let outcome = try await core.setAITextConfiguration(session: opened.id, request: request(opened, .model("owned model")), readmission: { true })
        guard case .saved = outcome else { return XCTFail("Expected owned scalar save") }
        let advanced = try await core.readAITextSetupOptions(session: opened.id); XCTAssertEqual(advanced.model, "owned model")
        let timeout = try await core.readAIRequestTimeoutOptions()
        _ = try await core.setAIRequestTimeout(.init(requestId: UUID().uuidString.lowercased(), value: timeout.value == 60 ? 120 : 60, expected: timeout.expected), readmission: { true })
        await failure { _ = try await core.readAITextSetupOptions(session: opened.id) }
        await failure { _ = try await core.saveAITextEndpoint(session: opened.id, value: "https://fixture.invalid/v1", expected: advanced.expected) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testRetiredSessionAndExternalProviderChangeRejectAllNewSensitiveIntents() async throws {
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        await core.retireAITextConfiguration(session: opened.id)
        await failure { try await core.saveAITextKey(session: opened.id, value: sentinel, expected: opened.options.expected) }
        await failure { _ = try await core.readAITextEndpoint(session: opened.id, expected: opened.options.expected) }
        let live = try await core.beginAITextConfiguration()
        var changed = try settings(); changed["ai"] = ["provider": "gemini"]
        try rows("UPDATE settings SET data=? WHERE id=1", [json(changed)])
        await failure { try await core.clearAITextKey(session: live.id, expected: live.options.expected) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testGenericRoutesCannotReachSensitiveSetupOrPrivateScalarMethods() async throws {
        let core = host(); _ = try await core.start()
        for name in ["iosAIAnthropicThinkingOptions", "iosAITextConfiguration", "iosAITextConfigurationOptions", "iosAITextConfigurationPrepare", "iosAITextConfigurationValidate",
                     "iosAITextConfigurationCommit", "iosAITextConfigurationRetryOutcome", "iosAITextConfigurationSensitive", "iosAITextConfigurationAcknowledged",
                     "iosAITextConfigurationV2", "iosAITextConfigurationOptionsV2", "iosAITextConfigurationPrepareV2", "iosAITextConfigurationValidateV2", "iosAITextConfigurationCommitV2", "iosAITextConfigurationRetryOutcomeV2", "iosAITextConfigurationSensitiveV2", "iosAITextConfigurationConsentTargetV2", "iosAITextConfigurationSessionOpenV2", "iosAITextConfigurationSessionOpen", "iosAITextConfigurationSessionRefresh", "iosAITextConfigurationSessionCheck", "iosAITextConfigurationSessionClose"] {
            await failure { _ = try await core.call(name, argumentsJSON: "[\"{}\"]") }
            await failure { _ = try await core.call("menuCommand", argumentsJSON: json([name, "{}"])) }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
    }

    func testConsentRecordingFailureDoesNotClaimDurabilityAndTypedLocalRetrySettlesFrozenMap() async throws {
        let faults = HostIOFaults()
        var storage: NativeDeviceKV?
        faults.configureDeviceStorage = { value in storage = value }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        let retained = try XCTUnwrap(storage)
        retained.faults.beforePromotion = { throw HostFailure("Synthetic consent promotion failure") }
        let outcome = try await core.setAITextConfiguration(session: opened.id, request: request(opened, .enabled(true), consent: true), readmission: { true })
        guard case .saved(let result, let recorded) = outcome else { return XCTFail("Explicit agreement still authorizes settings") }
        XCTAssertTrue(result.changed); XCTAssertFalse(recorded)
        let options = try await core.readAITextSetupOptions(session: opened.id); XCTAssertTrue(options.enabled)
        retained.faults.beforePromotion = nil
        let retried = try await core.retryAITextConsentRecord(session: opened.id); XCTAssertTrue(retried)
        XCTAssertTrue(try retained.readOpenAIConsentRecorded())
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts").count, 1)
        try assertPrivateBytesAbsent()
    }

    func testCancelledAcceptedCredentialWriteDrainsBeforeCloseAndRetainsUsableStateWithoutSuccessClaim() async throws {
        let faults = HostIOFaults(), entered = expectation(description: "accepted synchronous secure mutation")
        let release = DispatchSemaphore(value: 0)
        faults.secretBeforeOperation = { operation, alias in
            if operation == "set" && alias == "no-auth" {
                entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 10), .success)
            }
        }
        let core = host(faults); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        let write = Task { try await core.saveAITextKey(session: opened.id, value: sentinel, expected: opened.options.expected) }
        await fulfillment(of: [entered], timeout: 10)
        write.cancel()
        let closing = Task { await core.close() }
        release.signal()
        await failure { try await write.value }
        await closing.value
        let cold = host(); _ = try await cold.start(); let reopened = try await cold.beginAITextConfiguration()
        XCTAssertTrue(reopened.credentialAvailable)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertTrue(try rows("SELECT * FROM native_request_receipts").isEmpty)
        try assertPrivateBytesAbsent()
    }

    func testBlankReplacementAndForeignProviderAreRefusedWithoutMutation() async throws {
        let core = host(); _ = try await core.start(); let opened = try await core.beginAITextConfiguration()
        await failure { try await core.saveAITextKey(session: opened.id, value: "", expected: opened.options.expected) }
        let available = try await core.readAITextCredentialAvailable(session: opened.id); XCTAssertFalse(available)
        await core.close()
        var value = try settings(); value["ai"] = ["provider": "anthropic", "enabled": true]
        try rows("UPDATE settings SET data=? WHERE id=1", [json(value)])
        let foreign = host(); _ = try await foreign.start()
        await failure { _ = try await foreign.beginAITextConfiguration() }
        XCTAssertEqual(try json(settings()), try json(value)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
