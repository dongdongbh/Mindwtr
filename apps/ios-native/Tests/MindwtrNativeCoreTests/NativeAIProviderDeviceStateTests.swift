import Foundation
import Security
import JavaScriptCore
import Darwin
import XCTest
@testable import MindwtrNativeCore

/// Actual production bundle/JSC/SQLite. These are authored Apple checks, not Linux or device acceptance.
final class NativeAIProviderDeviceStateTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL {
        root.appendingPathComponent("device/Library/Application Support/mindwtr.ai.fixture/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private let sentinel = "PRIVATE592-SENTINEL"
    private let marker = "v1.3.5/ios-ai-device-state"

    override func setUpWithError() throws {
        #if !os(iOS) || targetEnvironment(simulator)
        throw XCTSkip("Requires the entitled physical iPhone12 test host; never run on simulator")
        #endif
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle(for: type(of: self)).url(forResource: "core-host", withExtension: "js")?.path
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Actual production iOS bundle required")
        }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeAIProviderDeviceStateTests/" + UUID().uuidString)
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
    private func host(_ faults: HostIOFaults = HostIOFaults(), registerTeardown: Bool = true) -> CoreHost {
        faults.secretService = service
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), "mindwtr.ai.fixture"))
        if registerTeardown { addTeardownBlock { await core.close() } }
        return core
    }
    private func withScopedHost(_ faults: HostIOFaults = HostIOFaults(),
        _ body: (CoreHost) async throws -> Void) async rethrows {
        let core = host(faults, registerTeardown: false)
        do {
            try await body(core)
            await core.close()
        } catch {
            await core.close()
            throw error
        }
    }
    private enum ScopedHostFixtureFailure: Error { case body }

    private final class RetainedAIReadCallbacks {
        var owner: JSValue?, inspect: JSValue?, fence: (() -> Void)?
        weak var facade: CoreHost?
        weak var engine: AnyObject?
        var observedEngine = false
    }
    private func retainAIReadCallbacks(refuse: Bool) async throws -> RetainedAIReadCallbacks {
        if refuse {
            let suffix = """
            ;(() => {
                const read = MindwtrHost.iosAIProviderDeviceState;
                MindwtrHost.iosAIProviderDeviceState = function(input, owner, inspect) {
                    return read.call(this, input, owner, () => inspect('gemini','arbitrary','arbitrary'));
                };
            })();
            """
            try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        }
        let retained = RetainedAIReadCallbacks(), faults = metadataFaults()
        faults.configureRuntimeLifetime = { [weak retained] engine, _, _ in
            retained?.engine = engine; retained?.observedEngine = true
        }
        faults.configureAIProviderDeviceStateCallbacks = { [weak retained] owner, inspect, fence in
            retained?.owner = owner as? JSValue; retained?.inspect = inspect as? JSValue; retained?.fence = fence
        }
        try await withScopedHost(faults) { core in
            retained.facade = core
            _ = try await core.start()
            if refuse { await failure { _ = try await core.readAIProviderDeviceState() } }
            else { _ = try await core.readAIProviderDeviceState() }
        }
        return retained
    }
    private func assertRetainedAIReadCallbacksReleaseOwner(_ retained: RetainedAIReadCallbacks,
        file: StaticString = #filePath, line: UInt = #line) throws {
        let owner = try XCTUnwrap(retained.owner, file: file, line: line)
        let inspect = try XCTUnwrap(retained.inspect, file: file, line: line)
        let fence = try XCTUnwrap(retained.fence, file: file, line: line)
        XCTAssertTrue(retained.observedEngine, file: file, line: line)
        // Keep these boxed values/context alive: only ARC ownership of the facade/Engine is tested, not JSC collection.
        XCTAssertTrue(owner.context === inspect.context, file: file, line: line)
        fence()
        XCTAssertNil(retained.facade, file: file, line: line)
        XCTAssertNil(retained.engine, file: file, line: line)
        // Baseline failure must not invoke its unsafe unowned callbacks.
        guard retained.facade == nil, retained.engine == nil else { return }
        XCTAssertEqual(owner.call(withArguments: [])?.toString(),
            "!MindwtrNativeError:AI provider device metadata owner is unavailable", file: file, line: line)
        XCTAssertEqual(inspect.call(withArguments: ["openai", "mindwtr-ai-key_openai", "mindwtr-ai-key:openai"])?.toString(),
            "!MindwtrNativeError:AI provider device metadata is unavailable", file: file, line: line)
    }
    func testRetainedAIReadCallbacksReleaseEngineAfterSuccessfulRead() async throws {
        let retained = try await retainAIReadCallbacks(refuse: false)
        try assertRetainedAIReadCallbacksReleaseOwner(retained)
    }
    func testRetainedAIReadCallbacksReleaseEngineAfterRefusedRead() async throws {
        let retained = try await retainAIReadCallbacks(refuse: true)
        try assertRetainedAIReadCallbacksReleaseOwner(retained)
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
        try await withScopedHost { initial in _ = try await initial.start() }
        var settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        settings["ai"] = ai
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["mindwtr-ai-key:openai": sentinel, "mindwtr-ai-provider-consent-v1": "{\"openai\":true}"]).utf8).write(to: manifest)
    }

    private func keychain(_ account: String, _ alias: String) -> [String: Any] {
        let bytes = Data(account.utf8)
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + (alias == "legacy" ? "" : ":" + alias),
            kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func addItem(provider: String, alias: String, bytes: Data) throws {
        let query = keychain("mindwtr-ai-key_" + provider, alias)
        var item = query; item[kSecValueData as String] = bytes
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        addTeardownBlock { XCTAssertTrue([errSecSuccess, errSecItemNotFound].contains(SecItemDelete(query as CFDictionary))) }
    }
    private func savedItem(provider: String, alias: String) throws -> NSDictionary {
        var query = keychain("mindwtr-ai-key_" + provider, alias)
        query[kSecReturnData as String] = true; query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        return try XCTUnwrap(result as? NSDictionary)
    }
    private func metadataFaults(_ secureStatus: OSStatus = errSecItemNotFound) -> HostIOFaults {
        let faults = HostIOFaults()
        faults.secretStatus = { operation, _ in
            XCTAssertEqual(operation, "ai-metadata", "No credential data reads/writes/deletes are admitted")
            return secureStatus
        }
        return faults
    }

    func testDefaultExactDTOIsStableReadOnlyAndColdReopenDrains() async throws {
        let faults = metadataFaults(), core = host(faults)
        var jobs: NativeSecretJobs?, http: NativeHTTPJobs?, queries = [[String: Any]](), writes = 0, journals = 0
        faults.configureSecretJobs = { value in jobs = value; value.beforeAIProviderQuery = { query, _ in queries.append(query) } }
        faults.configureDeviceStorage = { $0.faults.beforePromotion = { writes += 1 } }
        faults.configureHTTPJobs = { http = $0 }
        _ = try await core.start(); let before = try saved()
        faults.journalWrite = { journals += 1 }
        let first = try await core.readAIProviderDeviceState(), second = try await core.readAIProviderDeviceState()
        XCTAssertEqual(first, second); XCTAssertEqual(first.version, 1); XCTAssertEqual(first.provider, .openai)
        XCTAssertFalse(first.consentRecorded); XCTAssertEqual(first.secureItem, .absent); XCTAssertFalse(first.legacyItemPresent)
        XCTAssertEqual(queries.count, 6)
        for (index, query) in queries.enumerated() {
            XCTAssertEqual(Set(query.keys), Set([kSecClass, kSecAttrService, kSecAttrAccount, kSecAttrGeneric,
                kSecUseAuthenticationUI, kSecMatchLimit, kSecReturnAttributes].map { $0 as String }))
            XCTAssertEqual(query[kSecAttrAccount as String] as? Data, Data("mindwtr-ai-key_openai".utf8))
            XCTAssertEqual(query[kSecAttrGeneric as String] as? Data, Data("mindwtr-ai-key_openai".utf8))
            XCTAssertEqual(query[kSecAttrService as String] as? String, service + [":no-auth", ":auth", ""][index % 3])
            XCTAssertEqual(query[kSecReturnAttributes as String] as? Bool, true)
            XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
            XCTAssertEqual(query[kSecUseAuthenticationUI as String] as? String, kSecUseAuthenticationUIFail as String)
        }
        XCTAssertEqual(jobs?.counters.jobs, 0); XCTAssertEqual(jobs?.counters.running, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0)
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try saved(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let lines = try log().split(separator: "\n").filter { $0.contains(marker) }
        XCTAssertEqual(lines.count, 2)
        for line in lines { XCTAssertEqual(try object(String(line))["context"] as? [String: String], ["releaseCheck": marker]) }
        await core.close(); let reopened = host(metadataFaults()); _ = try await reopened.start()
        let afterReopen = try await reopened.readAIProviderDeviceState()
        XCTAssertEqual(afterReopen, first)
        XCTAssertEqual(try saved(), before)
    }

    func testPrivateMetadataJobsStayBoundedAndGenericRequestsCannotSelectThem() async throws {
        let registry = NativeAttachmentLocalRequests(), faults = metadataFaults()
        faults.secretService = service
        let jobs = try NativeSecretJobs(registry: registry, faults: faults)
        defer { jobs.shutdown() }
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"ai-metadata\",\"key\":\"mindwtr-ai-key_openai\"}"))
        XCTAssertThrowsError(try jobs.inspectAIProviderItem(account: "arbitrary", cancellation: NativeAttachmentCancellation()))
        let entered = expectation(description: "private job held"), release = DispatchSemaphore(value: 0)
        var held = false
        jobs.beforeAIProviderQuery = { _, _ in if !held { held = true; entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success, "Held metadata fixture must release within five seconds") } }
        let first = Task.detached { try jobs.inspectAIProviderItem(account: "mindwtr-ai-key_openai", cancellation: NativeAttachmentCancellation()) }
        await fulfillment(of: [entered], timeout: 10)
        let second = Task.detached { try jobs.inspectAIProviderItem(account: "mindwtr-ai-key_gemini", cancellation: NativeAttachmentCancellation()) }
        for _ in 0..<10000 { if jobs.counters.jobs == 2 { break }; await Task.yield() }
        XCTAssertEqual(jobs.counters.jobs, 2)
        XCTAssertThrowsError(try jobs.inspectAIProviderItem(account: "mindwtr-ai-key_anthropic", cancellation: NativeAttachmentCancellation()))
        release.signal()
        let firstResult = try await first.value, secondResult = try await second.value
        XCTAssertEqual(firstResult, "absent"); XCTAssertEqual(secondResult, "absent")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.running, 0)
        XCTAssertNil(try jobs.next(), "Private metadata replies are consumed natively, never by JS I/O")
    }

    func testAliasesEmptyItemPresenceAndActualFixtureBytesAccessibilityAreUnchanged() async throws {
        let suffix = """
        ;(() => {
            const read = MindwtrHost.iosAIProviderDeviceState;
            MindwtrHost.iosAIProviderDeviceState = function(input, owner, inspect) {
                return read.call(this, input, owner, (provider,account,legacy) => {
                    const raw = inspect(provider,account,legacy);
                    if (raw.includes('PRIVATE592-SENTINEL') || Object.keys(JSON.parse(raw)).sort().join(',') !== 'consentRecorded,legacyItemPresent,secureItem')
                        throw new Error('Unexpected native metadata transport');
                    return raw;
                });
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        for provider in ["openai", "gemini", "anthropic"] {
            for alias in ["no-auth", "auth", "legacy"] {
                try await seed(["provider": provider, "apiKey": sentinel, "baseUrl": sentinel])
                try addItem(provider: provider, alias: alias, bytes: alias == "auth" ? Data() : Data(sentinel.utf8))
                let before = try savedItem(provider: provider, alias: alias), manifestBefore = try Data(contentsOf: manifest)
                let faults = HostIOFaults(); var aliases = [String]()
                faults.secretBeforeOperation = { operation, name in XCTAssertEqual(operation, "ai-metadata"); aliases.append(name) }
                let core = host(faults); _ = try await core.start(); let domainBefore = try saved()
                let result = try await core.readAIProviderDeviceState()
                XCTAssertEqual(result.provider.rawValue, provider); XCTAssertEqual(result.secureItem, .present)
                XCTAssertEqual(aliases, Array(["no-auth", "auth", "legacy"].prefix(["no-auth", "auth", "legacy"].firstIndex(of: alias)! + 1)))
                XCTAssertEqual(try savedItem(provider: provider, alias: alias), before)
                XCTAssertEqual(try Data(contentsOf: manifest), manifestBefore); XCTAssertEqual(try saved(), domainBefore)
                XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
                await core.close()
                XCTAssertEqual(SecItemDelete(keychain("mindwtr-ai-key_" + provider, alias) as CFDictionary), errSecSuccess)
            }
        }
    }

    func testOnlyMissingContinuesAndEveryRefusalStopsAtItsAlias() async throws {
        for refusal in [errSecNotAvailable, errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled, errSecDecode, errSecParam] {
            for stopped in ["no-auth", "auth", "legacy"] {
                let faults = metadataFaults(); var aliases = [String]()
                faults.secretStatus = { operation, alias in
                    XCTAssertEqual(operation, "ai-metadata"); aliases.append(alias)
                    return alias == stopped ? refusal : errSecItemNotFound
                }
                let core = host(faults); _ = try await core.start()
                let result = try await core.readAIProviderDeviceState()
                XCTAssertEqual(result.secureItem, .unavailable)
                XCTAssertEqual(aliases.last, stopped); XCTAssertEqual(aliases.count, ["no-auth", "auth", "legacy"].firstIndex(of: stopped)! + 1)
                await core.close()
            }
        }
    }

    func testStrictConsentAndLegacyMembershipPreserveUnknownCellsAndSentinels() async throws {
        for provider in ["openai", "gemini", "anthropic"] {
            let cases: [(String?, Bool)] = [(nil, false), ("", false), ("not json", false), ("null", false),
                ("[]", false), ("true", false), ("1", false), ("{}", false), ("{\"\(provider)\":1}", false),
                ("{\"\(provider)\":\"true\"}", false), ("{\"\(provider)\":false}", false),
                ("{\"\(provider)\":true,\"future\":{\"opaque\":\"\(sentinel)\"}}", true),
                ("\u{FEFF}{\"\(provider)\":true}", false), ("{\"\(provider)\":true,}", false),
                ("{\"\(provider)\":true,\"future\":{\"opaque\":1,}}", false),
                ("{\"\(provider)\":true,\"future\":[1, \n]}", false),
                ("{\"\(provider)\":true,\"future\":\",} ,]\"}", true),
                ("{\"\(provider)\":true,\"future\":\"escaped \\\" ,} and \\\\ ,]\"}", true),
                (" \t\r\n{\"\(provider)\":true,\"future\":[]} \t\r\n", true)]
            for (consent, expected) in cases {
                try await seed(["provider": provider, "apiKey": sentinel])
                var entries = ["mindwtr-ai-key:" + provider: "", "opaque-future-cell": sentinel]
                if let consent { entries["mindwtr-ai-provider-consent-v1"] = consent }
                try Data(json(entries).utf8).write(to: manifest)
                let bytes = try Data(contentsOf: manifest)
                try await withScopedHost(metadataFaults()) { core in
                    _ = try await core.start()
                    let before = try saved(), result = try await core.readAIProviderDeviceState()
                    XCTAssertEqual(result.consentRecorded, expected)
                    XCTAssertTrue(result.legacyItemPresent, "Even an empty fixed slot is membership, never usability")
                    XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try saved(), before)
                    XCTAssertFalse(String(describing: result).contains(sentinel)); XCTAssertFalse(try log().contains(sentinel))
                }
            }
        }
    }

    func testScopedHostClosesAndReleasesAfterSuccessfulBody() async throws {
        weak var released: CoreHost?
        var retained: CoreHost?
        try await withScopedHost(metadataFaults()) { core in
            retained = core; released = core
            _ = try await core.start()
            _ = try await core.readAIProviderDeviceState()
        }
        // Keep only this caller's temporary reference to distinguish awaited close from deinit cleanup.
        await failure { _ = try await XCTUnwrap(retained).readAIProviderDeviceState() }
        retained = nil
        XCTAssertNil(released, "The scoped helper must not retain its closed host until XCTest teardown")
        try await withScopedHost(metadataFaults()) { reopened in
            _ = try await reopened.start()
            _ = try await reopened.readAIProviderDeviceState()
        }
    }

    func testScopedHostClosesAndReleasesAfterThrownBody() async throws {
        weak var released: CoreHost?
        var retained: CoreHost?
        do {
            try await withScopedHost(metadataFaults()) { core in
                retained = core; released = core
                _ = try await core.start()
                _ = try await core.readAIProviderDeviceState()
                throw ScopedHostFixtureFailure.body
            }
            XCTFail("The scoped helper must rethrow the body's error")
        } catch ScopedHostFixtureFailure.body { }
        await failure { _ = try await XCTUnwrap(retained).readAIProviderDeviceState() }
        retained = nil
        XCTAssertNil(released, "A thrown body must not retain its closed host until XCTest teardown")
        try await withScopedHost(metadataFaults()) { reopened in
            _ = try await reopened.start()
            _ = try await reopened.readAIProviderDeviceState()
        }
    }

    func testRawSyncedCredentialAndAnotherProvidersLegacySlotNeverBecomePresence() async throws {
        try await seed(["provider": "gemini", "apiKey": sentinel])
        let core = host(metadataFaults()); _ = try await core.start()
        let result = try await core.readAIProviderDeviceState()
        XCTAssertEqual(result.provider, .gemini); XCTAssertFalse(result.legacyItemPresent); XCTAssertFalse(result.consentRecorded)
        XCTAssertFalse(try log().contains(sentinel))
    }

    func testMalformedInputMappingsAndDTOAreRejectedBeforeInspection() async throws {
        let suffix = """
        ;(() => {
            const read = MindwtrHost.iosAIProviderDeviceState;
            MindwtrHost.iosAIProviderDeviceState = function(input, owner, inspect) {
                return read.call(this, input, owner, () => inspect('gemini','arbitrary','arbitrary'));
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let faults = metadataFaults(); var operations = 0
        faults.secretBeforeOperation = { _, _ in operations += 1 }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAIProviderDeviceState() }
        XCTAssertEqual(operations, 0); XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testActualPrivateFacadeRejectsMalformedAndForgedDTOWithoutNativeInspection() async throws {
        let suffix = """
        ;(() => {
            const poll = MindwtrHost.poll;
            MindwtrHost.iosAIProviderDeviceState = () => '592000';
            MindwtrHost.poll = function(id) {
                if (id === '592000') return JSON.stringify({ok:true,value:{version:1,provider:'openai',consentRecorded:false,secureItem:'absent',legacyItemPresent:false}});
                return poll.call(this,id);
            };
        })();
        """
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bundle, atomically: true, encoding: .utf8)
        let faults = metadataFaults(); var probes = 0
        faults.secretBeforeOperation = { _, _ in probes += 1 }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAIProviderDeviceState() }
        XCTAssertEqual(probes, 0); XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
        for raw in ["{}", "[]", "null", "{\"version\":1,\"provider\":\"openai\",\"consentRecorded\":1,\"secureItem\":\"absent\",\"legacyItemPresent\":false}",
            "{\"version\":1,\"provider\":\"openai\",\"consentRecorded\":false,\"secureItem\":\"absent\",\"legacyItemPresent\":false,\"extra\":\"PRIVATE592-SENTINEL\"}"] {
            XCTAssertThrowsError(try NativeAIProviderDeviceState.validated(raw))
        }
    }

    func testGenericCallMenuUnstartedClosedAndReplacedHostRefuse() async throws {
        let first = host(metadataFaults()); await failure { _ = try await first.readAIProviderDeviceState() }
        _ = try await first.start(); let before = try saved(), logBefore = try log()
        for method in ["iosAIProviderDeviceState", "readAIProviderDeviceState"] {
            await failure { _ = try await first.call(method, argumentsJSON: "[\"{}\"]") }
        }
        for method in ["menuRead", "menuCommand"] {
            await failure { _ = try await first.call(method, argumentsJSON: json(["iosAIProviderDeviceState", "{}"])) }
        }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
        await first.close(); let replaced = host(metadataFaults()); _ = try await replaced.start()
        await failure { _ = try await first.readAIProviderDeviceState() }
        _ = try await replaced.readAIProviderDeviceState()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testHeldProbeCancellationRetiresWithoutMarkerAndNextReadDrains() async throws {
        let entered = expectation(description: "metadata held"), release = DispatchSemaphore(value: 0)
        let faults = metadataFaults(); var held = false
        faults.secretBeforeOperation = { _, _ in
            if !held { held = true; entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success, "Held metadata fixture must release within five seconds") }
        }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        let task = Task { try await core.readAIProviderDeviceState() }
        await fulfillment(of: [entered], timeout: 10); task.cancel(); release.signal()
        await failure { _ = try await task.value }
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
        _ = try await core.readAIProviderDeviceState()
    }

    func testHeldProbeHostCloseCancelsBeforeDelivery() async throws {
        let entered = expectation(description: "metadata held"), release = DispatchSemaphore(value: 0)
        let faults = metadataFaults(); var token: NativeAttachmentCancellation?
        faults.configureSecretJobs = { $0.beforeAIProviderQuery = { _, cancellation in
            token = cancellation; entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success, "Held metadata fixture must release within five seconds")
        } }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        let task = Task { try await core.readAIProviderDeviceState() }
        await fulfillment(of: [entered], timeout: 10)
        let close = Task { await core.close() }
        for _ in 0..<10000 { if token?.isCancelled == true { break }; await Task.yield() }
        XCTAssertTrue(token?.isCancelled == true); release.signal()
        await failure { _ = try await task.value }; await close.value
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testHeldProbeExternalProviderSettingsAndSchemaChangesRefuseAndNeverAdopt() async throws {
        for mutation in ["provider", "settings", "schema"] {
            let faults = metadataFaults(); var changed = false
            faults.secretAfterOperation = { _, _ in
                guard !changed else { return }; changed = true
                do {
                    if mutation == "schema" { try self.rows("ALTER TABLE tasks ADD COLUMN metadata592_fixture TEXT") }
                    else {
                        var settings = try self.object(XCTUnwrap(self.rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
                        if mutation == "provider" { settings["ai"] = ["provider": "gemini"] }
                        else { settings["weeklyReviewDay"] = 3 }
                        try self.rows("UPDATE settings SET data=? WHERE id=1", [self.json(settings)])
                    }
                } catch { XCTFail("External fixture writer failed: \(error)") }
            }
            let core = host(faults); _ = try await core.start(); let logBefore = try log()
            await failure { _ = try await core.readAIProviderDeviceState() }; XCTAssertTrue(changed)
            let afterWriter = try saved(); await failure { _ = try await core.readAIProviderDeviceState() }
            XCTAssertEqual(try saved(), afterWriter); XCTAssertEqual(try log(), logBefore); await core.close()
        }
    }

    func testAlreadyStaleExternalWriterAndDatabaseReplacementRefuseBeforeProbe() async throws {
        let faults = metadataFaults(); var probes = 0
        faults.secretBeforeOperation = { _, _ in probes += 1 }
        let core = host(faults); _ = try await core.start(); let logBefore = try log()
        try rows("UPDATE settings SET data='{}' WHERE id=1")
        await failure { _ = try await core.readAIProviderDeviceState() }; XCTAssertEqual(probes, 0)
        XCTAssertEqual(try log(), logBefore); await core.close()
        let replacement = host(faults); _ = try await replacement.start()
        try FileManager.default.moveItem(at: database, to: root.appendingPathComponent("retained.sqlite")); try Data().write(to: database)
        await failure { _ = try await replacement.readAIProviderDeviceState() }; XCTAssertEqual(probes, 0)
    }

    func testPendingKVRefusesBeforeProbeAndPreservesUnpromotedBytes() async throws {
        let faults = metadataFaults(); var storage: NativeDeviceKV?, probes = 0
        faults.configureDeviceStorage = { storage = $0 }
        faults.secretBeforeOperation = { _, _ in probes += 1 }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        let selected = try XCTUnwrap(storage)
        selected.faults.beforePromotion = { throw HostFailure("Held KV mutation") }
        XCTAssertThrowsError(try selected.set("@mindwtr_sync_backend", "webdav"))
        let manifestBefore = FileManager.default.fileExists(atPath: manifest.path) ? try Data(contentsOf: manifest) : nil
        await failure { _ = try await core.readAIProviderDeviceState() }; XCTAssertEqual(probes, 0)
        let manifestAfter = FileManager.default.fileExists(atPath: manifest.path) ? try Data(contentsOf: manifest) : nil
        XCTAssertEqual(manifestAfter, manifestBefore); XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testConsentAndLegacyCellChangesDuringProbeRefuseAndPreserveExternalBytes() async throws {
        try await seed(["provider": "openai"])
        let faults = metadataFaults(); var changed: Data?
        faults.secretAfterOperation = { _, _ in
            guard changed == nil else { return }
            do {
                changed = try Data(self.json(["mindwtr-ai-provider-consent-v1": "{\"openai\":false}",
                    "mindwtr-ai-key:openai": "EXTERNAL592-SENTINEL"]).utf8)
                try changed!.write(to: self.manifest)
            } catch { XCTFail("External KV fixture failed: \(error)") }
        }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAIProviderDeviceState() }
        XCTAssertNotNil(changed); XCTAssertEqual(try Data(contentsOf: manifest), changed)
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testHeldProbeNamespaceReplacementRefusesWithoutAdoptingIdenticalBytes() async throws {
        try await seed(["provider": "openai"])
        let faults = metadataFaults(); var replaced = false
        faults.secretAfterOperation = { _, _ in
            guard !replaced else { return }; replaced = true
            do {
                let dir = self.manifest.deletingLastPathComponent(), bytes = try Data(contentsOf: self.manifest)
                try FileManager.default.moveItem(at: dir, to: dir.appendingPathExtension("retained"))
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true); try bytes.write(to: self.manifest)
            } catch { XCTFail("Namespace fixture failed: \(error)") }
        }
        let core = host(faults); _ = try await core.start(); let before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAIProviderDeviceState() }; XCTAssertTrue(replaced)
        XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }

    func testExternalCommitAfterDiagnosticCheckpointStillRefusesDelivery() async throws {
        let faults = metadataFaults(), core = host(faults); _ = try await core.start(); var changed = false
        faults.beforeSQL = { sql in
            if sql == "PRAGMA data_version", !changed, (try self.log()).contains(self.marker) {
                changed = true; try self.rows("UPDATE settings SET data='{}' WHERE id=1")
            }
        }
        await failure { _ = try await core.readAIProviderDeviceState() }
        XCTAssertTrue(changed); XCTAssertTrue(try log().contains(marker))
    }

    func testPendingSaveRefusesWithoutSettlingOrRewritingJournal() async throws {
        let faults = metadataFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected save failure") } }
        let options: [String: Any] = ["note": "", "dueDate": NSNull(), "dueDateHasTime": false, "startTime": NSNull(),
            "contexts": [String](), "projectId": NSNull(), "areaId": NSNull(), "priority": NSNull(), "focus": false, "addAnother": false]
        let request = try json(["text": sentinel, "options": options, "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])
        await failure { _ = try await core.call("captureSubmit", argumentsJSON: json([request])) }
        let bytes = try Data(contentsOf: journal), before = try saved(), logBefore = try log()
        await failure { _ = try await core.readAIProviderDeviceState() }
        XCTAssertEqual(try Data(contentsOf: journal), bytes); XCTAssertEqual(try saved(), before); XCTAssertEqual(try log(), logBefore)
    }
}
