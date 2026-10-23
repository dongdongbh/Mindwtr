import Foundation
import Security
import Darwin
import XCTest
@testable import MindwtrNativeCore

/// Actual production bundle/JSC/SQLite. These are authored Apple checks, not Linux or device acceptance.
final class NativeAISettingsProjectionTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL {
        root.appendingPathComponent("device/Library/Application Support/mindwtr.ai.fixture/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private let sentinel = "PRIVATE587-SENTINEL"
    private let marker = "v1.3.5/ios-ai-settings-projection"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeAISettingsProjectionTests/" + UUID().uuidString)
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
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
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
        let initial = host(); _ = try await initial.start(); await initial.close()
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["mindwtr-ai-key:openai": sentinel, "mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]).utf8).write(to: manifest)
    }
    private func configured() -> [String: Any] {
        ["provider": "anthropic", "enabled": true, "reasoningEffort": "high", "thinkingBudget": 2048,
            "requestTimeoutSeconds": 120, "model": sentinel, "copilotModel": sentinel,
            "baseUrl": "https://" + sentinel, "openAIExtraBodyParams": ["opaque": sentinel],
            "speechToText": ["provider": "parakeet", "enabled": true, "model": sentinel,
                "baseUrl": sentinel, "language": sentinel, "offlineModelPath": sentinel,
                "mode": "transcribe_only", "fieldStrategy": "title_only"]]
    }

    #if DEBUG && os(iOS) && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    @MainActor
    func testAISummaryCheckpointFacadeRefusesOrdinaryRunnerWithoutArtifactOrOwnerAdmission() async throws {
        let core = host()
        await failure { try await core.configureIsolatedAISummaryCheckpoint() }
        var admissions = 0
        await failure { try await core.captureIsolatedAISummaryCheckpoint(.baseline, startupToken: UUID()) {
            admissions += 1; return true
        } }
        XCTAssertEqual(admissions, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".ai-summary-proof").path))
    }
    #endif

    func testSummaryPublicationDiagnosticAcceptsOnlyFixedNonsecretMarker() async throws {
        let core = host(); _ = try await core.start(); defer { Task { await core.close() } }
        _ = try await core.call("logLine", argumentsJSON: json([
            "Native iOS AI settings summary published",
            "{\"releaseCheck\":\"v1.3.5/ios-ai-settings-summary\",\"outcome\":\"confirmed\"}",
        ]))
        for context in [
            "{\"releaseCheck\":\"v1.3.5/ios-ai-settings-summary\",\"outcome\":\"ready\"}",
            "{\"releaseCheck\":\"v1.3.5/ios-ai-settings-summary\",\"outcome\":\"confirmed\",\"text\":\"private\"}",
        ] {
            await failure { _ = try await core.call("logLine", argumentsJSON: self.json(["Native iOS AI settings summary published", context])) }
        }
    }

    func testDefaultReadIsStableTypedAndCreatesNoJournalOrDomainWrite() async throws {
        let faults = HostIOFaults(); var writes = 0, journals = 0, secrets = 0, deviceWrites = 0, storageConfigured = false
        faults.configureDeviceStorage = { storage in
            storageConfigured = true; storage.faults.beforePromotion = { deviceWrites += 1 }
        }
        let core = host(faults); _ = try await core.start()
        XCTAssertTrue(storageConfigured, "The no-write check must exercise an admitted real device-storage port")
        let before = try saved(); deviceWrites = 0
        faults.beforeSQL = { sql in
            if sql.range(of: #"(?i)^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b"#, options: .regularExpression) != nil { writes += 1 }
        }
        faults.journalWrite = { journals += 1 }; faults.secretBeforeOperation = { _, _ in secrets += 1 }
        let first = try await core.readAISettingsProjection(), second = try await core.readAISettingsProjection()
        XCTAssertEqual(first, second); XCTAssertEqual(first.version, 1); XCTAssertFalse(first.aiEnabled)
        XCTAssertEqual(first.aiProvider, .openai); XCTAssertEqual(first.aiReasoningEffort, .low)
        XCTAssertEqual(first.aiThinkingBudget, 0); XCTAssertEqual(first.aiRequestTimeoutSeconds, 30)
        XCTAssertFalse(first.speechEnabled); XCTAssertEqual(first.speechProvider, .gemini)
        XCTAssertEqual(first.speechMode, .smart_parse); XCTAssertEqual(first.speechFieldStrategy, .smart)
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0)
        XCTAssertEqual(try saved(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try log().components(separatedBy: "\n").filter { $0.contains(marker) }.count, 2)
    }

    func testSavedControlsExcludePrivateStringsAndLeaveLegacyCredentialsAndConsentUntouched() async throws {
        try await seed(configured())
        let faults = HostIOFaults(); var secrets = 0, deviceWrites = 0
        faults.secretBeforeOperation = { _, _ in secrets += 1 }
        faults.configureDeviceStorage = { $0.faults.beforePromotion = { deviceWrites += 1 } }
        let core = host(faults); _ = try await core.start(); secrets = 0; deviceWrites = 0
        let before = try saved(), manifestBefore = try Data(contentsOf: manifest)
        let result = try await core.readAISettingsProjection()
        XCTAssertTrue(result.aiEnabled); XCTAssertEqual(result.aiProvider, .anthropic)
        XCTAssertEqual(result.aiThinkingBudget, 2048); XCTAssertTrue(result.anthropicThinkingEnabled)
        XCTAssertEqual(result.aiRequestTimeoutSeconds, 120); XCTAssertEqual(result.speechProvider, .whisper)
        XCTAssertEqual(result.speechMode, .transcribe_only); XCTAssertEqual(result.speechFieldStrategy, .title_only)
        XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try Data(contentsOf: manifest), manifestBefore)
        XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0)
    }

    func testPrivateFacadeReceivesCallableOwnerAndRetriesAfterSynchronousJSRefusal() async throws {
        let suffix = """
        ;(() => {
            const projection = MindwtrHost.iosAISettingsProjection;
            let refuseOnce = true;
            MindwtrHost.iosAISettingsProjection = function(json, owner) {
                if (typeof owner !== 'function' || owner() !== '') {
                    throw new Error('INVALID_INPUT: Task595 owner callback is not callable');
                }
                if (refuseOnce) {
                    refuseOnce = false;
                    throw new Error('NOT_READY: Task595 synchronous JS refusal');
                }
                return projection.call(this, json, owner);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(); var secrets = 0, deviceWrites = 0
        faults.secretBeforeOperation = { _, _ in secrets += 1 }
        faults.configureDeviceStorage = { $0.faults.beforePromotion = { deviceWrites += 1 } }
        let core = host(faults); _ = try await core.start(); secrets = 0; deviceWrites = 0
        let before = try saved(), logBefore = try log()
        do { _ = try await core.readAISettingsProjection(); XCTFail("Expected synchronous JS refusal") }
        catch { XCTAssertEqual(error.localizedDescription, "Error: NOT_READY: Task595 synchronous JS refusal") }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
        let result = try await core.readAISettingsProjection()
        XCTAssertEqual(result.aiProvider, .openai); XCTAssertEqual(result.aiRequestTimeoutSeconds, 30)
        XCTAssertEqual(secrets, 0); XCTAssertEqual(deviceWrites, 0); XCTAssertEqual(try saved(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try log().components(separatedBy: "\n").filter { $0.contains(marker) }.count, 1)
        XCTAssertFalse(try log().contains(sentinel))
    }

    func testUnreadyClosedCompetingAndReplacedHostCannotRead() async throws {
        let first = host(); await failure { _ = try await first.readAISettingsProjection() }
        _ = try await first.start()
        let locked = host(); await failure { _ = try await locked.start() }
        await failure { _ = try await locked.readAISettingsProjection() }; await locked.close()
        await first.close(); await failure { _ = try await first.readAISettingsProjection() }
        let replacement = host(); _ = try await replacement.start()
        let before = try log(); await failure { _ = try await first.readAISettingsProjection() }
        XCTAssertEqual(try log(), before); _ = try await replacement.readAISettingsProjection()
    }

    func testGenericCallAndMenuDispatchAreDeniedWithoutJournalOrMarker() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let before = try saved(), logBefore = try log(); var writes = 0
        faults.journalWrite = { writes += 1 }
        for method in ["iosAISettingsProjection", "readAISettingsProjection"] {
            await failure { _ = try await core.call(method, argumentsJSON: "[\"{}\"]") }
        }
        for method in ["menuRead", "menuCommand"] {
            await failure { _ = try await core.call(method, argumentsJSON: json(["iosAISettingsProjection", "{}"])) }
        }
        XCTAssertEqual(writes, 0); XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testMalformedSavedProviderRefusesWithoutPersistingDefaultsOrLeakingValue() async throws {
        try await seed(["provider": sentinel])
        let core = host(); _ = try await core.start(); let before = try saved(), logBefore = try log()
        do { _ = try await core.readAISettingsProjection(); XCTFail("Expected malformed saved provider refusal") }
        catch { XCTAssertFalse(error.localizedDescription.contains(sentinel)) }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testAlreadyStaleExternalWriterAndSchemaDriftRefuseWithoutRefreshingAcceptedBaseline() async throws {
        for schema in [false, true] {
            let core = host(); _ = try await core.start(); let logBefore = try log()
            if schema { try rows("ALTER TABLE tasks ADD COLUMN projection587_fixture TEXT") }
            else {
                var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
                settings["ai"] = ["provider": "gemini"]
                try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
            }
            let before = try saved()
            await failure { _ = try await core.readAISettingsProjection() }
            await failure { _ = try await core.readAISettingsProjection() }
            XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
            await core.close()
        }
    }

    func testDatabaseReplacementRefusesBeforeReadingOrLogging() async throws {
        let core = host(); _ = try await core.start(); let before = try log()
        try FileManager.default.moveItem(at: database, to: root.appendingPathComponent("retained.sqlite"))
        try Data().write(to: database)
        await failure { _ = try await core.readAISettingsProjection() }
        XCTAssertEqual(try log(), before)
    }

    func testExternalCommitAfterDiagnosticCheckpointRejectsDeliveryButKeepsTruthfulReadMarker() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        var changed = false
        faults.beforeSQL = { sql in
            if sql == "PRAGMA data_version", !changed, (try self.log()).contains(self.marker) {
                changed = true
                var settings = try self.object(XCTUnwrap(self.rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
                settings["ai"] = ["provider": "gemini"]
                try self.rows("UPDATE settings SET data=? WHERE id=1", [self.json(settings)])
            }
        }
        await failure { _ = try await core.readAISettingsProjection() }
        XCTAssertTrue(changed); XCTAssertTrue(try log().contains(marker))
        let before = try saved(); await failure { _ = try await core.readAISettingsProjection() }
        XCTAssertEqual(try saved(), before, "Late retirement never replaces the external writer's settings")
    }

    func testActualPrivateFacadeRejectsMalformedBundledResult() async throws {
        let suffix = """
        ;(() => {
            const poll = MindwtrHost.poll;
            MindwtrHost.iosAISettingsProjection = () => '587000';
            MindwtrHost.poll = function(id) {
                if (id === '587000') return JSON.stringify({ok:true,value:{version:1,extra:'PRIVATE587-SENTINEL'}});
                return poll.call(this,id);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let core = host(); _ = try await core.start(); let before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAISettingsProjection() }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testPendingDurableSaveRefusesWithoutSettlingOrRewritingExactJournal() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected save failure") } }
        let options: [String: Any] = ["note": "", "dueDate": NSNull(), "dueDateHasTime": false, "startTime": NSNull(),
            "contexts": [String](), "projectId": NSNull(), "areaId": NSNull(), "priority": NSNull(),
            "focus": false, "addAnother": false]
        let request = try json(["text": sentinel, "options": options, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])
        await failure { _ = try await core.call("captureSubmit", argumentsJSON: json([request])) }
        let exact = try Data(contentsOf: journal), before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAISettingsProjection() }
        XCTAssertEqual(try Data(contentsOf: journal), exact); XCTAssertEqual(try saved(), before)
        XCTAssertEqual(try log(), logBefore)
    }

    func testTypedTransportRejectsExtraFieldsEnumsNumbersDuplicatesAndUnboundedChoices() throws {
        let valid: [String: Any] = ["version": 1, "aiProvider": "openai", "aiEnabled": false,
            "staticAiModelOptions": ["model"], "aiReasoningEffort": "low", "aiThinkingBudget": 0,
            "staticAiCopilotOptions": ["model"], "aiRequestTimeoutSeconds": 30, "anthropicThinkingEnabled": false,
            "speechEnabled": false, "speechProvider": "gemini", "speechMode": "smart_parse",
            "speechFieldStrategy": "smart", "staticSpeechModelOptions": ["model"]]
        _ = try NativeAISettingsProjection.validated(json(valid))
        let invalid: [(String, Any)] = [("extra", sentinel), ("aiProvider", sentinel), ("speechProvider", "parakeet"),
            ("aiReasoningEffort", "other"), ("speechMode", "other"), ("speechFieldStrategy", "other"),
            ("aiEnabled", 1), ("aiThinkingBudget", -1), ("aiThinkingBudget", 32769), ("aiThinkingBudget", 1.5),
            ("aiRequestTimeoutSeconds", 999), ("anthropicThinkingEnabled", true),
            ("staticAiModelOptions", [String]()), ("staticAiModelOptions", ["model", "model"]),
            ("staticAiModelOptions", ["https://private"]), ("staticAiModelOptions", [String(repeating: "x", count: 65)]),
            ("staticAiModelOptions", (0..<17).map { "model-\($0)" })]
        for (field, value) in invalid {
            var changed = valid; changed[field] = value
            XCTAssertThrowsError(try NativeAISettingsProjection.validated(json(changed)))
        }
        let raw = try json(valid)
        XCTAssertThrowsError(try NativeAISettingsProjection.validated("{\"version\":1," + String(raw.dropFirst())))
        XCTAssertThrowsError(try NativeAISettingsProjection.validated(String(repeating: " ", count: 8193) + raw))
    }

    func testIsolatedEntitledAIKeychainSentinelIsNeitherReadMigratedNorChanged() async throws {
        #if os(iOS)
        let account = "mindwtr-ai-key_openai", bytes = Data(account.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service! + ":no-auth", kSecAttrAccount as String: bytes,
            kSecAttrGeneric as String: bytes, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var input = query; input[kSecValueData as String] = Data(sentinel.utf8)
        input[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        defer { XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess) }
        let faults = HostIOFaults(); var operations = 0
        faults.secretBeforeOperation = { _, _ in operations += 1 }
        let core = host(faults); _ = try await core.start(); operations = 0
        _ = try await core.readAISettingsProjection(); XCTAssertEqual(operations, 0)
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, Data(sentinel.utf8))
        #else
        throw XCTSkip("Requires the entitled physical iPhone12 test host")
        #endif
    }
}
