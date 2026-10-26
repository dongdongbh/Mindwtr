import Foundation
import Darwin
import Security
import XCTest
@testable import MindwtrNativeCore

private actor WorkspaceReadmission {
    private var continuation: CheckedContinuation<Bool, Never>?
    private var released = false
    let entered: XCTestExpectation
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func wait() async -> Bool {
        if released { return true }
        return await withCheckedContinuation { continuation = $0; entered.fulfill() }
    }
    func release() { released = true; continuation?.resume(returning: true); continuation = nil }
}

private final class WorkspaceObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var factories = 0, terminal = false
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    func constructed() { lock.lock(); factories += 1; lock.unlock() }
    func finish() { lock.lock(); terminal = true; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return factories }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return terminal }
}

/// Real ready NORMAL/JSC/storage and native workers; these are authored Apple tests, not Linux acceptance.
final class NativeWorkspaceRetirementTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("personal.sqlite") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], path.hasPrefix("/"),
              FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Workspace tests require the actual NORMAL bundle") }
        bundle = URL(fileURLWithPath: path)
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/workspace-retirement")
        root = home.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        root = root.resolvingSymlinksInPath()
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func host(bundle: URL? = nil, faults: HostIOFaults = HostIOFaults(), storage: Bool = false) -> CoreHost {
        if storage { XCTAssertNoThrow(try FileManager.default.createDirectory(at: root.appendingPathComponent("device"), withIntermediateDirectories: true)) }
        let core = CoreHost(databaseURL: database, bundleURL: bundle ?? self.bundle, faults: faults,
            deviceStorage: storage ? (root.appendingPathComponent("device"), "mindwtr.workspace.fixture") : nil)
        addTeardownBlock { await core.close() }; return core
    }
    private func capture(_ core: CoreHost) async throws {
        let opened = try object(await core.call("captureOpen"))
        let request = try json([json(["text": "Synthetic workspace row", "captureId": UUID().uuidString.lowercased(),
            "options": XCTUnwrap(opened["options"]), "openAfterSave": false])])
        let saved = try object(await core.call("captureSubmit", argumentsJSON: request))
        let window = try object(await core.call("window", argumentsJSON: "[0,50,\"\"]"))
        XCTAssertEqual(saved["kind"] as? String, "saved"); XCTAssertEqual(window["total"] as? Int, 1)
    }
    private func retirementError(_ core: CoreHost, _ expected: CoreHostRetirementError) async {
        do { _ = try await core.retireForWorkspaceTransition(); XCTFail("Unconfirmed original host must not certify") }
        catch { XCTAssertEqual(error as? CoreHostRetirementError, expected) }
    }
    private func restricted(_ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Restricted native admission must refuse") }
        catch { XCTAssertTrue(error.localizedDescription.contains("WORKSPACE_RESTRICTED"), error.localizedDescription) }
    }
    private func fenced(_ core: CoreHost) async {
        for _ in 0..<1000 {
            if core.workspaceRetirementIsFencedForTests() {
                do { _ = try await core.call("window", argumentsJSON: "[0,50,\"\"]"); XCTFail("New unrelated outer call must refuse") }
                catch { XCTAssertEqual(error as? CoreHostRetirementError, .unavailable) }
                return
            }
            await Task.yield()
        }
        XCTFail("Retirement did not fence new unrelated outer calls")
    }
    private func probeBundle(_ expression: String) throws -> URL {
        let suffix = """
        ;(() => { const oldPoll=MindwtrHost.poll,replies=new Map(); let next=1000000000;
          MindwtrHost.inboxView=()=>{const id=String(++next);Promise.resolve().then(async()=>{\(expression)}).then(
            value=>replies.set(id,JSON.stringify({ok:true,value})),
            ()=>replies.set(id,JSON.stringify({ok:false,error:'Synthetic workspace probe failed'})));return id;};
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value;})():oldPoll(id);
        })();
        """
        let path = root.appendingPathComponent("probe-\(UUID().uuidString).js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: path, atomically: true, encoding: .utf8)
        return path
    }
    private func probe(_ core: CoreHost) async throws -> [String: Any] { try object(await core.call("inboxView", argumentsJSON: "[\"{}\"]")) }
    private func registerSecretCleanup(service: String, account: String = "fixture") {
        let bytes = Data(account.utf8)
        // Register before host teardown: XCTest runs teardown blocks in reverse order,
        // so actual worker close/drain precedes deletion of this exact synthetic account.
        addTeardownBlock {
            let result = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service + ":no-auth", kSecAttrAccount as String: bytes,
                kSecAttrGeneric as String: bytes, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail] as CFDictionary)
            XCTAssertTrue(result == errSecSuccess || result == errSecItemNotFound, "Exact synthetic account cleanup was not acknowledged")
        }
    }
    private func assertRestrictedFixturePredicates(_ root: URL, database: URL) throws {
        XCTAssertTrue(root.isFileURL, "fixture file URL predicate")
        XCTAssertTrue(root.standardizedFileURL == root, "fixture standardized URL predicate")
        XCTAssertTrue(root.resolvingSymlinksInPath() == root, "fixture resolved URL predicate")
        XCTAssertTrue(UUID(uuidString: root.lastPathComponent) != nil, "fixture UUID predicate")
        XCTAssertTrue(root.deletingLastPathComponent().lastPathComponent == "restricted-workspace-fixtures", "fixture parent predicate")
        XCTAssertTrue(database == root.appendingPathComponent("mindwtr.sqlite"), "fixture database child predicate")
        var info = stat()
        XCTAssertEqual(lstat(root.path, &info), 0, "fixture lstat predicate")
        XCTAssertTrue((info.st_mode & S_IFMT) == S_IFDIR, "fixture directory predicate")
        XCTAssertEqual(info.st_uid, geteuid(), "fixture owner predicate")
        XCTAssertTrue((info.st_mode & 0o077) == 0, "fixture private mode predicate")
        let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertTrue(entries.isEmpty, "fixture empty predicate")
    }
    private func fixtureRoot() throws -> URL {
        let path = root.appendingPathComponent("restricted-workspace-fixtures").appendingPathComponent(UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return path.resolvingSymlinksInPath()
    }

    func testReadyPersonalLocalWriteRetiresAndOnlyRetainedReceiptRepeats() async throws {
        let core = host(); XCTAssertEqual(core.workspaceMode, .personal)
        _ = try await core.start(); try await capture(core)
        let receipt = try await core.retireForWorkspaceTransition()
        let repeated = try await core.retireForWorkspaceTransition()
        XCTAssertEqual(receipt, repeated)
        do { _ = try await core.call("captureOpen"); XCTFail("Late original callbacks cannot reenter after terminal retirement") } catch { }
        let replacement = host(); _ = try await replacement.start()
        let reopened = try object(await replacement.call("window", argumentsJSON: "[0,50,\"\"]"))
        XCTAssertEqual(reopened["total"] as? Int, 1)
        await replacement.close()
    }

    func testUnstartedAndOrdinaryClosedReadyHostsCannotManufactureReceipt() async throws {
        let unstarted = host(); await retirementError(unstarted, .unavailable)
        await unstarted.close(); await retirementError(unstarted, .unavailable)
        let ready = host(); _ = try await ready.start(); try await capture(ready)
        await ready.close(); await retirementError(ready, .unavailable)
    }

    func testReadyEditorDebtRefusesWithoutShutdownAndExactCleanupPermitsRetirement() async throws {
        let core = host(); _ = try await core.start(); try await capture(core)
        let session = UUID().uuidString.lowercased(), task = UUID().uuidString.lowercased()
        let draft = EditorDraftSnapshot(sessionID: session, taskID: task, generation: 1,
            payloadJSON: try json(["version": 2, "taskID": task]))
        try await core.checkpointEditorDraft(draft)
        await retirementError(core, .refused)
        let original = try await core.readEditorDraft(); XCTAssertEqual(original, draft)
        try await core.discardEditorDraft(expectedSession: session)
        let receipt = try await core.retireForWorkspaceTransition(), repeated = try await core.retireForWorkspaceTransition()
        XCTAssertEqual(receipt, repeated)
    }

    func testTypedContinuationCommitsOnOriginalHostWhileCancelledRetirementWaits() async throws {
        let core = host(); _ = try await core.start(); try await capture(core)
        let options = try await core.readAIRequestTimeoutOptions()
        let request = NativeAIRequestTimeoutRequest(requestId: UUID().uuidString.lowercased(), value: 60, expected: options.expected)
        let entered = expectation(description: "real typed readmission after Engine begin"), gate = WorkspaceReadmission(entered)
        let work = Task { try await core.setAIRequestTimeout(request, readmission: { await gate.wait() }) }
        await fulfillment(of: [entered], timeout: 10)
        let state = WorkspaceObservation()
        let retiring = Task { let receipt = try await core.retireForWorkspaceTransition(); state.finish(); return receipt }
        await fenced(core); retiring.cancel()
        XCTAssertFalse(state.finished)
        await gate.release()
        let committed = try await work.value
        XCTAssertEqual(committed, .init(value: 60, changed: true), "The admitted typed commit/finish must retain original authority")
        _ = try await retiring.value; XCTAssertTrue(state.finished)
        do { _ = try await core.setAIRequestTimeout(request, readmission: { true }); XCTFail("Expired original continuation must refuse") } catch { }
    }

    func testActualTrailingSecretWorkerKeepsLockAndRetirementPendingUntilTerminal() async throws {
        let state = WorkspaceObservation(), faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture.retirement." + UUID().uuidString.lowercased()
        faults.secretService = service
        registerSecretCleanup(service: service)
        faults.secretAfterOperation = { operation, _ in if operation == "set" { state.entered.signal(); state.release.wait() } }
        defer { state.release.signal() }
        let core = host(bundle: try probeBundle("void __mindwtrSecrets.setSecret('fixture','synthetic-owned').catch(()=>{});return {returned:true};"), faults: faults)
        _ = try await core.start(); try await capture(core)
        let returned = try await probe(core)
        XCTAssertEqual(returned["returned"] as? Bool, true)
        XCTAssertEqual(state.entered.wait(timeout: .now() + 5), .success)
        let retiring = Task { let receipt = try await core.retireForWorkspaceTransition(); state.finish(); return receipt }
        await fenced(core); XCTAssertFalse(state.finished)
        let replacement = host()
        do { _ = try await replacement.start(); XCTFail("The actual worker still owns the original library lock") } catch { }
        state.release.signal(); _ = try await retiring.value; XCTAssertTrue(state.finished)
        _ = try await replacement.start(); await replacement.close()
    }

    func testRestrictedAbsentOrPersonalStorageNeverOpensOrConstructsWorkers() async throws {
        let state = WorkspaceObservation(), faults = HostIOFaults()
        faults.configureHTTPJobs = { _ in state.constructed() }; faults.configureSecretJobs = { _ in state.constructed() }
        let sentinel = root.appendingPathComponent("personal-sentinel"); try Data("personal-owned".utf8).write(to: sentinel)
        let absent = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, workspaceMode: .restricted)
        do { _ = try await absent.start(); XCTFail("Restricted input has no production root/seed authority") } catch { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.path)); XCTAssertEqual(state.count, 0)
        await absent.close(); await retirementError(absent, .unavailable)
        let owned = try fixtureRoot(), container = root.appendingPathComponent("personal-device")
        let supplied = CoreHost(databaseURL: owned.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle, faults: faults,
            deviceStorage: (container, "mindwtr.personal.fixture"), workspaceMode: .restricted, restrictedFixtureRoot: owned)
        do { _ = try await supplied.start(); XCTFail("Caller-supplied personal KV cannot become restricted authority") } catch { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.path)); XCTAssertEqual(state.count, 0)
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("personal-owned".utf8)); await supplied.close()
    }

    func testRejectedRestrictedInputPreservesTheLivePersonalKVAndSecretOwner() async throws {
        let container = root.appendingPathComponent("device"), namespace = "mindwtr.workspace.fixture"
        let manifest = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let before = Data("{\"@mindwtr_sync_backend\":\"off\"}".utf8); try before.write(to: manifest)
        let faults = HostIOFaults(), state = WorkspaceObservation()
        let service = "mindwtr.native-keychain.fixture.owner." + UUID().uuidString.lowercased()
        faults.secretService = service
        registerSecretCleanup(service: service)
        faults.configureSecretJobs = { _ in state.constructed() }
        let expression = "return {stored:globalThis.__mindwtrNative.kvGet('@mindwtr_sync_backend')};"
        let personal = host(bundle: try probeBundle(expression), faults: faults, storage: true)
        _ = try await personal.start(); try await capture(personal)
        let originalWorkers = state.count, owned = try fixtureRoot()
        let rejected = CoreHost(databaseURL: owned.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle, faults: faults,
            deviceStorage: (container, namespace), workspaceMode: .restricted, restrictedFixtureRoot: owned)
        do { _ = try await rejected.start(); XCTFail("Restricted candidate cannot adopt a live personal namespace") } catch { }
        await rejected.close()
        XCTAssertEqual(state.count, originalWorkers)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        let live = try await probe(personal)
        XCTAssertEqual(live["stored"] as? String, "[\"off\"]", "The original personal namespace/lease remains usable")
        _ = try await personal.retireForWorkspaceTransition()
    }

    func testReadyRestrictedLocalWriteAndRealTypedGenericBridgeDenialsWithoutWorkers() async throws {
        let state = WorkspaceObservation(), faults = HostIOFaults(), owned = try fixtureRoot()
        faults.configureHTTPJobs = { _ in state.constructed() }; faults.configureSecretJobs = { _ in state.constructed() }
        faults.configureCalendarJobs = { _ in state.constructed() }; faults.configureCryptoJobs = { _ in state.constructed() }
        faults.configureDeviceStorage = { _ in state.constructed() }; faults.calendarReaderFactory = { state.constructed(); return NativeCalendarReader() }
        let expression = """
        const n=globalThis.__mindwtrNative, denied={};
        if(['fileCall','installerCall','fileDirectories'].some(name=>typeof n[name]==='function')) return {unexpectedFileWorker:true};
        for(const [name,args] of [['netFetch',['{}']],['secretCall',['{}']],['cryptoCall',['{}']],['calendarCall',['{}']],
          ['fileSyncCall',['{}']],['kvGet',['@mindwtr_sync_backend']],['rnStateCommit',['{}']]]) {
          try { denied[name]=n[name](...args); } catch(error) { denied[name]=String(error); }
        } return denied;
        """
        let database = owned.appendingPathComponent("mindwtr.sqlite")
        try assertRestrictedFixturePredicates(owned, database: database)
        let core = CoreHost(databaseURL: database, bundleURL: try probeBundle(expression), faults: faults,
            workspaceMode: .restricted, restrictedFixtureRoot: owned)
        addTeardownBlock { await core.close() }
        var stage = "start"
        do {
            _ = try await core.start()
            stage = "capture"
            try await capture(core)
            XCTAssertEqual(core.workspaceMode, .restricted); XCTAssertEqual(state.count, 0)
            stage = "typed-denials"
            await restricted { _ = try await core.foregroundSync(command: "syncNow", requestJSON: "{}") }
            await restricted { _ = try await core.foregroundFileSync(directoryURL: self.root) }
            await restricted { _ = try await core.foregroundDirectorySyncSettings(command: "openSyncSettings", requestJSON: "{}") }
            await restricted { _ = try await core.prepareBackupImport(self.root) }
            await restricted { _ = try await core.readAISettingsProjection() }
            await restricted { _ = try await core.grantDeviceCalendarAccess(readmission: { XCTFail("No restricted permission callback"); return true }) }
            stage = "generic-denials"
            for method in ["menuRead", "syncNow", "iosDirectorySyncSettings", "iosWorkspaceRetirementStatus"] {
                await restricted { _ = try await core.call(method) }
            }
            stage = "bridge-probe"
            let denied = try await probe(core)
            XCTAssertEqual(denied.count, 7)
            for value in denied.values { XCTAssertTrue((value as? String)?.contains("WORKSPACE_RESTRICTED") == true, String(describing: value)) }
            XCTAssertEqual(state.count, 0)
            stage = "retirement"
            _ = try await core.retireForWorkspaceTransition()
        } catch {
            XCTFail("Restricted ready fixture stage=\(stage) type=\(String(reflecting: type(of: error)))")
            throw error
        }
    }

    func testReadyHostRejectsMalformedPrivateHealthAndGenericHealthDispatch() async throws {
        let bad = root.appendingPathComponent("malformed-health.js")
        let suffix = ";MindwtrHost.iosWorkspaceRetirementStatus=()=>JSON.stringify({version:1,ready:1,pending:false,uncertain:false});"
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: bad, atomically: true, encoding: .utf8)
        let core = host(bundle: bad); _ = try await core.start(); try await capture(core)
        do { _ = try await core.call("iosWorkspaceRetirementStatus"); XCTFail("Health is not a generic App command") }
        catch { XCTAssertTrue(error.localizedDescription.contains("requires original native authority")) }
        await retirementError(core, .unavailable)
        await core.close(); await retirementError(core, .unavailable)
    }

    func testReadyConfiguredUnavailableStoreRemainsUnavailableAfterOrdinaryClose() async throws {
        let manifest = root.appendingPathComponent("device/Library/Application Support/mindwtr.workspace.fixture/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("malformed synthetic namespace".utf8).write(to: manifest)
        let core = host(storage: true); _ = try await core.start(); try await capture(core)
        await retirementError(core, .unavailable)
        await core.close(); await retirementError(core, .unavailable)
    }

    func testActualReadyNativeBatchPendingRefusesAndOrdinaryCloseCannotEraseDebt() async throws {
        let faults = HostIOFaults()
        faults.configureDeviceStorage = { storage in
            storage.faults.beforeReadback = { throw HostFailure("Synthetic uncertain actual native batch") }
        }
        let expression = "return {reply:globalThis.__mindwtrNative.kvMultiSet(JSON.stringify([['@mindwtr_sync_backend','off']]))};"
        let core = host(bundle: try probeBundle(expression), faults: faults, storage: true)
        _ = try await core.start(); try await capture(core)
        let result = try await probe(core)
        XCTAssertTrue((result["reply"] as? String)?.contains("Device settings storage is unavailable") == true)
        await retirementError(core, .refused)
        await core.close(); await retirementError(core, .unavailable)
    }

    func testReadyPoisonedStoreRetainsFailureBeforeAndAfterOrdinaryClose() async throws {
        let core = host(storage: true); _ = try await core.start(); try await capture(core)
        let manifest = root.appendingPathComponent("device/Library/Application Support/mindwtr.workspace.fixture/RCTAsyncLocalStorage_V1/manifest.json")
        try Data("foreign replaced bytes".utf8).write(to: manifest)
        await retirementError(core, .unavailable)
        await core.close(); await retirementError(core, .unavailable)
    }
}
