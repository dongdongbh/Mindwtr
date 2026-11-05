import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

final class NativeAIConfigurationStorageTests: XCTestCase {
    private let legacy = "mindwtr-ai-key:openai"
    private let consent = "mindwtr-ai-provider-consent-v1"
    private let account = "mindwtr-ai-key_openai"
    private var roots: [URL] = []
    private var stores: [NativeDeviceKV] = []
    private var workers: [NativeSecretJobs] = []
    private var services: [String] = []
    private struct Fixture {
        let root: URL, namespace: String
        var storage: URL { root.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1") }
        var manifest: URL { storage.appendingPathComponent("manifest.json") }
        func external(_ name: String) -> URL {
            storage.appendingPathComponent(Insecure.MD5.hash(data: Data(name.utf8)).map { String(format: "%02x", $0) }.joined())
        }
    }
    override func tearDownWithError() throws {
        workers.forEach { $0.shutdown() }; stores.forEach { $0.close() }
        for service in services {
            for alias in ["legacy", "auth", "no-auth"] {
                for name in [account, "mindwtr-ai-key_gemini", "mindwtr-ai-key_anthropic"] {
                    var input = query(service, account: name, alias: alias); _ = SecItemDelete(input as CFDictionary)
                    #if os(macOS)
                    input[kSecAttrAccount as String] = Data(name.utf8); _ = SecItemDelete(input as CFDictionary)
                    #endif
                }
            }
        }
        for root in roots { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func fixture(_ values: [String: Any]) throws -> Fixture {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = base.appendingPathComponent("NativeAIConfigurationStorageTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Synthetic storage fixture unavailable") }
        defer { free(physical) }
        let root = URL(fileURLWithPath: String(cString: physical), isDirectory: true); roots.append(root)
        let fixture = Fixture(root: root, namespace: "mindwtr.ai-configuration.fixture." + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: fixture.storage, withIntermediateDirectories: true)
        try Data(json(values).utf8).write(to: fixture.manifest)
        return fixture
    }
    private func open(_ fixture: Fixture) throws -> NativeDeviceKV {
        let store = try NativeDeviceKV(containerURL: fixture.root, bundleIdentifier: fixture.namespace)
        stores.append(store); return store
    }
    private func secretWorker(_ faults: HostIOFaults = HostIOFaults()) throws -> (NativeSecretJobs, String) {
        let service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        services.append(service); faults.secretService = service
        let worker = try NativeSecretJobs(registry: NativeAttachmentLocalRequests(), faults: faults)
        workers.append(worker); return (worker, service)
    }
    private func query(_ service: String, account: String, alias: String) -> [String: Any] {
        let bytes = Data(account.utf8)
        #if os(macOS)
        let accountValue: Any = account
        #else
        let accountValue: Any = bytes
        #endif
        return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
            kSecAttrAccount as String: accountValue, kSecAttrGeneric as String: bytes,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func seed(_ service: String, account: String? = nil, alias: String = "no-auth", value: String,
                      accessibility: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) throws {
        var input = query(service, account: account ?? self.account, alias: alias)
        input[kSecValueData as String] = Data(value.utf8); input[kSecAttrAccessible as String] = accessibility
        let status = SecItemAdd(input as CFDictionary, nil)
        guard status == errSecSuccess else { XCTFail("Synthetic credential seed failed: \(status)"); throw HostFailure("Synthetic credential seed failed") }
    }
    private func stored(_ service: String, account: String? = nil, alias: String = "no-auth") throws -> Data? {
        var input = query(service, account: account ?? self.account, alias: alias)
        input[kSecReturnData as String] = true; input[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(input as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        XCTAssertEqual(status, errSecSuccess); return try XCTUnwrap(value as? Data)
    }

    func testTargetBoundConsentPendingMutationRejectsAnotherProviderAndPreservesUnknownEntries() throws {
        let fixture = try fixture([consent: "{\"openai\":true,\"unknown\":{\"retained\":7}}"]), store = try open(fixture)
        store.faults.beforePromotion = { throw HostFailure("Synthetic selected consent failure") }
        XCTAssertThrowsError(try store.recordAIConsent(provider: .gemini))
        XCTAssertThrowsError(try store.recordAIConsent(provider: .anthropic))
        store.faults.beforePromotion = nil
        try store.recordAIConsent(provider: .gemini)
        XCTAssertTrue(try store.readAIConsentRecorded(provider: .gemini)); XCTAssertTrue(try store.readAIConsentRecorded(provider: .openai)); XCTAssertFalse(try store.readAIConsentRecorded(provider: .anthropic))
        let map = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(store.get(consent)).utf8)) as? [String: Any])
        XCTAssertEqual((map["unknown"] as? [String: Any])?["retained"] as? Int, 7)
    }

    #if os(macOS)
    func testMacHistoricalByteAccountReadsAndSelectedClearKeepCanonicalOtherProvider() throws {
        let (worker, service) = try secretWorker(), selected = "mindwtr-ai-key_gemini"
        try seed(service, account: account, value: "canonical OpenAI retained")
        var previous = query(service, account: selected, alias: "no-auth")
        previous[kSecAttrAccount as String] = Data(selected.utf8)
        previous[kSecValueData as String] = Data("historical selected".utf8)
        XCTAssertEqual(SecItemAdd(previous as CFDictionary, nil), errSecSuccess)
        XCTAssertEqual(try worker.readAIRequestKey(provider: .gemini, cancellation: NativeAttachmentCancellation()), "historical selected")
        try worker.replaceAIConfigurationCredential(provider: .gemini, value: "canonical selected", cancellation: NativeAttachmentCancellation())
        XCTAssertEqual(try worker.readAIRequestKey(provider: .gemini, cancellation: NativeAttachmentCancellation()), "canonical selected")
        try worker.clearAIConfigurationCredential(provider: .gemini, cancellation: NativeAttachmentCancellation())
        XCTAssertNil(try worker.readAIRequestKey(provider: .gemini, cancellation: NativeAttachmentCancellation()))
        XCTAssertEqual(try worker.readAIRequestKey(provider: .openai, cancellation: NativeAttachmentCancellation()), "canonical OpenAI retained")
        previous.removeValue(forKey: kSecValueData as String); previous[kSecReturnAttributes as String] = true
        var result: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(previous as CFDictionary, &result), errSecItemNotFound)
    }
    #endif

    func testProductionWritesAllThreeProvidersUnderOneAliasAndClearKeepsOtherAccounts() throws {
        let (worker, _) = try secretWorker()
        for provider in [NativeAISettingsProjection.Provider.openai, .gemini, .anthropic] {
            try worker.replaceAIConfigurationCredential(provider: provider, value: "synthetic selected " + provider.rawValue, cancellation: NativeAttachmentCancellation())
        }
        for provider in [NativeAISettingsProjection.Provider.openai, .gemini, .anthropic] {
            XCTAssertEqual(try worker.readAIRequestKey(provider: provider, cancellation: NativeAttachmentCancellation()), "synthetic selected " + provider.rawValue)
        }
        try worker.clearAIConfigurationCredential(provider: .gemini, cancellation: NativeAttachmentCancellation())
        XCTAssertNil(try worker.readAIRequestKey(provider: .gemini, cancellation: NativeAttachmentCancellation()))
        for provider in [NativeAISettingsProjection.Provider.openai, .anthropic] {
            XCTAssertEqual(try worker.readAIRequestKey(provider: provider, cancellation: NativeAttachmentCancellation()), "synthetic selected " + provider.rawValue)
        }
    }

    func testAllFixedProviderCredentialMutationsPreserveUnselectedSecureAndLegacyValues() throws {
        for provider in [NativeAISettingsProjection.Provider.gemini, .anthropic] {
            let selectedAccount = "mindwtr-ai-key_" + provider.rawValue, selectedLegacy = "mindwtr-ai-key:" + provider.rawValue
            let fixture = try fixture([selectedLegacy: "selected old fallback", legacy: "OpenAI fallback", consent: "{\"openai\":true}"]), store = try open(fixture)
            let (worker, service) = try secretWorker()
            try seed(service, account: account, value: "OpenAI secure retained")
            try seed(service, account: selectedAccount, alias: "auth", value: "selected old secure")
            try worker.replaceAIConfigurationCredential(provider: provider, value: "selected replacement", cancellation: NativeAttachmentCancellation())
            try store.retireAILegacyCredential(provider: provider)
            XCTAssertEqual(try stored(service, account: selectedAccount), Data("selected replacement".utf8))
            XCTAssertEqual(try stored(service, account: account), Data("OpenAI secure retained".utf8)); XCTAssertEqual(try store.get(legacy), "OpenAI fallback")
            XCTAssertNil(try store.get(selectedLegacy)); XCTAssertThrowsError(try store.remove(selectedLegacy)); XCTAssertThrowsError(try store.set(selectedLegacy, "forbidden"))
            try worker.clearAIConfigurationCredential(provider: provider, cancellation: NativeAttachmentCancellation())
            for alias in ["legacy", "auth", "no-auth"] { XCTAssertNil(try stored(service, account: selectedAccount, alias: alias)) }
            XCTAssertEqual(try stored(service, account: account), Data("OpenAI secure retained".utf8)); XCTAssertTrue(try store.readAIConsentRecorded(provider: .openai))
        }
    }

    func testNonOpenAIInterruptedReplacementAndLegacyRetirementRemainExplicitTargetStateRetries() throws {
        let fixture = try fixture(["mindwtr-ai-key:anthropic": "old fallback", legacy: "other fallback"]), store = try open(fixture)
        let faults = HostIOFaults(), (worker, service) = try secretWorker(faults)
        try seed(service, account: "mindwtr-ai-key_anthropic", value: "old secure")
        faults.secretStatus = { operation, _ in operation == "verify" ? errSecInteractionNotAllowed : nil }
        XCTAssertThrowsError(try worker.replaceAIConfigurationCredential(provider: .anthropic, value: "new selected", cancellation: NativeAttachmentCancellation()))
        XCTAssertEqual(try store.get("mindwtr-ai-key:anthropic"), "old fallback")
        faults.secretStatus = nil
        try worker.replaceAIConfigurationCredential(provider: .anthropic, value: "new selected", cancellation: NativeAttachmentCancellation())
        store.faults.beforePromotion = { throw HostFailure("Synthetic selected legacy failure") }
        XCTAssertThrowsError(try store.retireAILegacyCredential(provider: .anthropic))
        XCTAssertEqual(try stored(service, account: "mindwtr-ai-key_anthropic"), Data("new selected".utf8))
        XCTAssertThrowsError(try store.retireAILegacyCredential(provider: .gemini))
        store.faults.beforePromotion = nil
        try store.retireAILegacyCredential(provider: .anthropic)
        XCTAssertNil(try store.get("mindwtr-ai-key:anthropic")); XCTAssertEqual(try store.get(legacy), "other fallback")
    }

    func testTypedConsentPreservesOtherEntriesAndGenericAIWritesRemainRejected() throws {
        let raw = "{\"openai\":1,\"gemini\":true,\"anthropic\":false,\"unknown\":{\"retained\":7}}"
        let fixture = try fixture([consent: raw, legacy: "synthetic fallback", "mindwtr-ai-key:gemini": "other fallback", "unrelated": "preserved"])
        let store = try open(fixture), before = try Data(contentsOf: fixture.manifest)
        XCTAssertFalse(try store.readOpenAIConsentRecorded())
        XCTAssertThrowsError(try store.set(consent, "{}")); XCTAssertThrowsError(try store.remove(consent))
        XCTAssertThrowsError(try store.set(legacy, "replacement")); XCTAssertThrowsError(try store.remove(legacy))
        XCTAssertEqual(try Data(contentsOf: fixture.manifest), before)
        try store.recordOpenAIConsent()
        XCTAssertTrue(try store.readOpenAIConsentRecorded())
        let map = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(store.get(consent)).utf8)) as? [String: Any])
        XCTAssertEqual(map["gemini"] as? Bool, true); XCTAssertEqual(map["anthropic"] as? Bool, false)
        XCTAssertEqual((map["unknown"] as? [String: Any])?["retained"] as? Int, 7)
        XCTAssertEqual(try store.get(legacy), "synthetic fallback"); XCTAssertEqual(try store.get("mindwtr-ai-key:gemini"), "other fallback")
        let saved = try Data(contentsOf: fixture.manifest)
        try store.recordOpenAIConsent(); XCTAssertEqual(try Data(contentsOf: fixture.manifest), saved)
        store.close(); let cold = try open(fixture)
        XCTAssertTrue(try cold.readOpenAIConsentRecorded()); XCTAssertEqual(try cold.get("unrelated"), "preserved")
    }

    func testMalformedConsentRefusesWithoutOverwriteAndFailedPromotionRetriesFrozenMap() throws {
        for raw in ["[]", "{bad}", "{\"gemini\":true,}", "\u{feff}{\"gemini\":true}"] {
            let fixture = try fixture([consent: raw, "unrelated": "preserved"]), store = try open(fixture)
            let before = try Data(contentsOf: fixture.manifest)
            XCTAssertFalse(try store.readOpenAIConsentRecorded()); XCTAssertThrowsError(try store.recordOpenAIConsent())
            XCTAssertEqual(try Data(contentsOf: fixture.manifest), before)
        }
        let fixture = try fixture([consent: "{\"gemini\":true}", "unrelated": "preserved"]), store = try open(fixture)
        var promotions = 0
        store.faults.afterPromotion = { promotions += 1; throw HostFailure("Synthetic consent readback interruption") }
        XCTAssertThrowsError(try store.recordOpenAIConsent())
        let promoted = try Data(contentsOf: fixture.manifest)
        XCTAssertThrowsError(try store.validateWorkspaceRetirement()); XCTAssertThrowsError(try store.readOpenAIConsentRecorded())
        store.faults.afterPromotion = nil
        try store.recordOpenAIConsent()
        XCTAssertEqual(promotions, 1); XCTAssertEqual(try Data(contentsOf: fixture.manifest), promoted)
        XCTAssertTrue(try store.readOpenAIConsentRecorded()); XCTAssertEqual(try store.get("unrelated"), "preserved")
        let map = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(store.get(consent)).utf8)) as? [String: Bool])
        XCTAssertEqual(map, ["openai": true, "gemini": true])
    }

    func testExplicitLegacyRetirementHandlesExternalAndOrphanWithoutOtherProviderMutation() throws {
        for shape in ["inline", "external", "orphan"] {
            var values: [String: Any] = ["mindwtr-ai-key:gemini": "unrelated provider", consent: "{\"gemini\":true}", "unrelated": "retained"]
            if shape == "inline" { values[legacy] = "old synthetic fallback" }
            if shape == "external" { values[legacy] = NSNull() }
            let fixture = try fixture(values)
            if shape != "inline" { try Data("old synthetic fallback".utf8).write(to: fixture.external(legacy)) }
            let unrelated = fixture.storage.appendingPathComponent("unrelated-file"); try Data([0, 255, 7]).write(to: unrelated)
            let store = try open(fixture)
            try store.retireOpenAILegacyCredential()
            XCTAssertNil(try store.get(legacy)); XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.external(legacy).path))
            XCTAssertEqual(try store.get("mindwtr-ai-key:gemini"), "unrelated provider")
            XCTAssertEqual(try store.get(consent), "{\"gemini\":true}"); XCTAssertEqual(try Data(contentsOf: unrelated), Data([0, 255, 7]))
            let saved = try Data(contentsOf: fixture.manifest)
            try store.retireOpenAILegacyCredential(); XCTAssertEqual(try Data(contentsOf: fixture.manifest), saved)
        }
    }

    func testSaveVerifiesSecureReplacementBeforeLegacyRetirementAndKeepsUnrelatedAlias() throws {
        let fixture = try fixture([legacy: "old fallback", consent: "{\"gemini\":true}", "unrelated": "retained"]), store = try open(fixture)
        let faults = HostIOFaults()
        let (worker, service) = try secretWorker(faults)
        try seed(service, value: "old secure", accessibility: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        try seed(service, account: "mindwtr-ai-key_gemini", alias: "auth", value: "other provider")
        var operations: [String] = [], reads: [String] = []
        faults.secretBeforeOperation = { operation, alias in operations.append(operation + ":" + alias) }
        worker.beforeRead = { reads.append($0) }
        try worker.replaceOpenAIConfigurationCredential(value: "replacement synthetic", cancellation: NativeAttachmentCancellation())
        XCTAssertEqual(reads, [account]); XCTAssertTrue(operations.contains("verify:no-auth"))
        XCTAssertEqual(try store.get(legacy), "old fallback", "Secure verification alone does not retire plaintext")
        XCTAssertEqual(try stored(service), Data("replacement synthetic".utf8))
        XCTAssertEqual(try stored(service, account: "mindwtr-ai-key_gemini", alias: "auth"), Data("other provider".utf8))
        try store.retireOpenAILegacyCredential(); XCTAssertNil(try store.get(legacy))
        XCTAssertEqual(try store.get(consent), "{\"gemini\":true}")
        store.close(); let cold = try open(fixture)
        XCTAssertNil(try cold.get(legacy))
        XCTAssertEqual(try worker.readAIRequestKey(provider: .openai, cancellation: NativeAttachmentCancellation()), "replacement synthetic")
    }

    func testDeniedReplacementOrReadbackNeverAuthorizesLegacyRemoval() throws {
        for boundary in ["write", "readback"] {
            let fixture = try fixture([legacy: "only old fallback", "unrelated": "retained"]), store = try open(fixture)
            let faults = HostIOFaults()
            let (worker, service) = try secretWorker(faults)
            if boundary == "write" { faults.secretStatus = { operation, _ in operation == "set" ? errSecInteractionNotAllowed : nil } }
            else { worker.beforeRead = { _ in throw HostFailure("Synthetic denied replacement readback") } }
            XCTAssertThrowsError(try worker.replaceOpenAIConfigurationCredential(value: "new synthetic", cancellation: NativeAttachmentCancellation()))
            XCTAssertEqual(try store.get(legacy), "only old fallback")
            XCTAssertEqual(try stored(service), boundary == "write" ? nil : Data("new synthetic".utf8))
            faults.secretStatus = nil; worker.beforeRead = nil
            try worker.replaceOpenAIConfigurationCredential(value: "new synthetic", cancellation: NativeAttachmentCancellation())
            try store.retireOpenAILegacyCredential()
            XCTAssertNil(try store.get(legacy)); XCTAssertEqual(try stored(service), Data("new synthetic".utf8))
        }
    }

    func testInterruptedLegacyRetirementRetainsReplacementAndColdExplicitRetryRemovesOrphan() throws {
        let fixture = try fixture([legacy: NSNull(), "unrelated": "retained"])
        try Data("old backing fallback".utf8).write(to: fixture.external(legacy))
        let store = try open(fixture)
        let (worker, service) = try secretWorker()
        try worker.replaceOpenAIConfigurationCredential(value: "verified replacement", cancellation: NativeAttachmentCancellation())
        store.faults.beforeSecretUnlink = { throw HostFailure("Synthetic interrupted legacy retirement") }
        XCTAssertThrowsError(try store.retireOpenAILegacyCredential())
        XCTAssertEqual(try stored(service), Data("verified replacement".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.external(legacy).path))
        XCTAssertThrowsError(try store.validateWorkspaceRetirement())
        store.close(); let cold = try open(fixture)
        XCTAssertNil(try cold.get(legacy), "The old external orphan is not an effective fallback after its manifest cell was removed")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.external(legacy).path))
        try cold.retireOpenAILegacyCredential()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.external(legacy).path))
        XCTAssertEqual(try stored(service), Data("verified replacement".utf8)); XCTAssertEqual(try cold.get("unrelated"), "retained")
    }

    func testClearAttemptsEverySelectedAliasReportsPartialFailureAndRetriesTargetState() throws {
        let fixture = try fixture([legacy: "selected fallback", "mindwtr-ai-key:gemini": "other provider"]), store = try open(fixture)
        let faults = HostIOFaults()
        let (worker, service) = try secretWorker(faults)
        for alias in ["legacy", "auth", "no-auth"] { try seed(service, alias: alias, value: "synthetic " + alias) }
        var operations: [String] = []
        faults.secretBeforeOperation = { operation, alias in operations.append(operation + ":" + alias) }
        faults.secretStatus = { operation, alias in operation == "delete" && alias == "auth" ? errSecInteractionNotAllowed : nil }
        try store.retireOpenAILegacyCredential()
        XCTAssertThrowsError(try worker.clearOpenAIConfigurationCredential(cancellation: NativeAttachmentCancellation()))
        XCTAssertNil(try store.get(legacy)); XCTAssertNil(try stored(service, alias: "legacy")); XCTAssertNil(try stored(service))
        XCTAssertEqual(try stored(service, alias: "auth"), Data("synthetic auth".utf8))
        XCTAssertEqual(operations.filter { $0.hasPrefix("delete:") }, ["delete:legacy", "delete:auth", "delete:no-auth"])
        XCTAssertEqual(operations.filter { $0.hasPrefix("verify-clear:") }, ["verify-clear:legacy", "verify-clear:auth", "verify-clear:no-auth"])
        XCTAssertNotNil(try worker.readAIRequestKey(provider: .openai, cancellation: NativeAttachmentCancellation()), "Partial Clear still has a usable selected alias")
        faults.secretStatus = nil
        try worker.clearOpenAIConfigurationCredential(cancellation: NativeAttachmentCancellation())
        for alias in ["legacy", "auth", "no-auth"] { XCTAssertNil(try stored(service, alias: alias)) }
        XCTAssertNil(try worker.readAIRequestKey(provider: .openai, cancellation: NativeAttachmentCancellation()))
        XCTAssertEqual(try store.get("mindwtr-ai-key:gemini"), "other provider")
        try worker.clearOpenAIConfigurationCredential(cancellation: NativeAttachmentCancellation())
    }

    func testAcceptedReplacementFinishesVerificationBeforeCancelledPublicationAndLegacyStays() throws {
        let fixture = try fixture([legacy: "old fallback"]), store = try open(fixture)
        let faults = HostIOFaults(), cancellation = NativeAttachmentCancellation()
        let (worker, service) = try secretWorker(faults)
        var verified = false
        faults.secretAfterOperation = { operation, _ in if operation == "set" { cancellation.cancel() }; if operation == "verify" { verified = true } }
        XCTAssertThrowsError(try worker.replaceOpenAIConfigurationCredential(value: "accepted replacement", cancellation: cancellation))
        XCTAssertTrue(verified, "Accepted synchronous replacement and readback drain before cancellation returns")
        XCTAssertEqual(try stored(service), Data("accepted replacement".utf8)); XCTAssertEqual(try store.get(legacy), "old fallback")
        let rejected = NativeAttachmentCancellation(); rejected.cancel()
        XCTAssertThrowsError(try worker.replaceOpenAIConfigurationCredential(value: "must not write", cancellation: rejected))
        XCTAssertEqual(try stored(service), Data("accepted replacement".utf8))
    }
}
