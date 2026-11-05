import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private func cloudKitHostJSON(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
}

private actor CloudKitHostSDK {
    enum ReadFault: Sendable, Equatable { case none, failed, malformed, held }
    private let status: String
    private var readFault: ReadFault
    private let entered: XCTestExpectation?
    private var held: CheckedContinuation<String, Error>?
    private var records: [String: String]
    private(set) var calls: [String] = []
    private(set) var writes: [String] = []
    private(set) var events: [String] = []
    private(set) var fallbackReleased = false

    init(status: String = "available", tasks: String = "[]", fault: ReadFault = .none, entered: XCTestExpectation? = nil) {
        self.status = status; readFault = fault; self.entered = entered
        records = ["MindwtrTask": tasks, "MindwtrProject": "[]", "MindwtrSection": "[]", "MindwtrArea": "[]", "MindwtrPerson": "[]", "MindwtrSettings": "[]"]
    }
    func request(_ raw: String) async throws -> String {
        let request = try NativeCloudKitRequest(json: raw)
        switch request {
        case .accountStatus: calls.append("accountStatus"); return try cloudKitHostJSON(status)
        case .ensureZone: calls.append("ensureZone"); return "null"
        case .fetchAllRecords(let type):
            calls.append("fetch:" + type.rawValue)
            if type == .task, readFault == .held {
                readFault = .none; events.append("read-held")
                defer { events.append("read-returned") }
                return try await withCheckedThrowingContinuation { continuation in
                    held = continuation; entered?.fulfill()
                }
            }
            if type == .section, readFault == .failed { throw HostFailure("Synthetic partial CloudKit query failure") }
            if type == .section, readFault == .malformed { return "{\"records\":[],\"partial\":true}" }
            return records[type.rawValue] ?? "[]"
        case .saveRecords(let type, let json):
            calls.append("save:" + type.rawValue); writes.append(raw); records[type.rawValue] = json; return "[]"
        case .deleteRecords(let type, _): calls.append("delete:" + type.rawValue); writes.append(raw); return "null"
        case .saveAttachmentAsset, .fetchAttachmentAsset:
            throw HostFailure("This records-only fixture has no assets")
        }
    }
    func cancel() {
        events.append("cancel")
        releaseHeld()
    }
    func releaseHeld() {
        if let continuation = held { held = nil; continuation.resume(throwing: CancellationError()) }
    }
    func releaseHeldForFallback() {
        if held != nil { fallbackReleased = true; releaseHeld() }
    }
    func markClosed() { events.append("host-closed") }
}

private final class CloudKitHostNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("CloudKit must not fall back to HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

final class NativeCloudKitHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.cloudkit-tests"
    private let at = "2026-10-30T00:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        guard let temporary = ProcessInfo.processInfo.environment["TMPDIR"], !temporary.isEmpty else {
            throw XCTSkip("Set a disk-backed TMPDIR for native CloudKit Host tests")
        }
        bundle = URL(fileURLWithPath: path)
        root = URL(fileURLWithPath: temporary, isDirectory: true)
            .appendingPathComponent("NativeCloudKitHostTests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    private func value(_ raw: String) throws -> [String: Any] {
        let reply = try object(raw)
        XCTAssertEqual(reply["ok"] as? Bool, true, raw)
        return try XCTUnwrap(reply["value"] as? [String: Any], raw)
    }
    private func makeHost(_ sdk: CloudKitHostSDK, backend: String = "cloudkit", directory: URL? = nil) throws -> (CoreHost, URL, URL) {
        let directory = directory ?? root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let container = directory.appendingPathComponent("container", isDirectory: true)
        let manifest = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        if !FileManager.default.fileExists(atPath: manifest.path) {
            try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(cloudKitHostJSON(["@mindwtr_sync_backend": backend, "unknown": "preserve synthetic"]).utf8).write(to: manifest)
        }
        let faults = HostIOFaults()
        faults.secretStatus = { _, _ in errSecItemNotFound }
        faults.cloudKitRequest = { try await sdk.request($0) }
        faults.cloudKitCancel = { await sdk.cancel() }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CloudKitHostNoHTTP.self]
        faults.httpConfiguration = configuration
        let database = directory.appendingPathComponent("core.sqlite")
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await host.close() }
        return (host, database, directory)
    }
    private func execute(_ database: URL, _ sql: String, _ parameters: [Any] = []) throws -> String {
        let bridge = try SQLiteBridge(url: database); defer { bridge.close() }
        return try bridge.execute(sql, parametersJSON: cloudKitHostJSON(parameters))
    }
    private func tasks(_ database: URL) throws -> String {
        try cloudKitHostJSON(NativeJSON.jsonObject(with: Data(execute(database, "SELECT * FROM tasks ORDER BY id").utf8)))
    }
    private func taskRows(_ database: URL) throws -> [[String: Any]] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(tasks(database).utf8)) as? [[String: Any]])
    }
    private func remoteTask() throws -> String {
        try cloudKitHostJSON([["id": "cloudkit-remote-inbox", "title": "Synthetic CloudKit Inbox", "status": "inbox",
            "description": "Synthetic remote note", "tags": [], "contexts": [], "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture"]])
    }
    private func assertCloudKitPanel(_ model: [String: Any], enabled: Bool) throws {
        let panel = try XCTUnwrap(model["panel"] as? [String: Any])
        XCTAssertEqual(Set(panel.keys), ["kind", "help", "syncNow", "lastSync"])
        XCTAssertEqual(panel["kind"] as? String, "cloudkit")
        let help = try XCTUnwrap(panel["help"] as? [String: Any])
        XCTAssertEqual(Set(help.keys), ["title", "text", "status"])
        XCTAssertFalse((help["status"] as? String ?? "").isEmpty)
        XCTAssertFalse((help["text"] as? String ?? "").isEmpty)
        XCTAssertEqual((panel["syncNow"] as? [String: Any])?["enabled"] as? Bool, enabled)
        XCTAssertTrue(model["encryption"] is NSNull)
        XCTAssertNil(panel["save"]); XCTAssertNil(panel["test"]); XCTAssertNil(panel["url"])
    }
    private func assertNoErrorToasts(_ result: [String: Any]) {
        let toasts = result["toasts"] as? [[String: Any]] ?? []
        XCTAssertFalse(toasts.contains { $0["tone"] as? String == "error" }, String(describing: toasts))
    }
    private func sync(_ host: CoreHost) async throws -> String {
        try await host.foregroundSync(command: "syncNow", requestJSON: cloudKitHostJSON(["requestId": UUID().uuidString.lowercased()]))
    }

    func testBootAndAutomaticPathsNeverCallCloudKitSDK() async throws {
        let sdk = CloudKitHostSDK(), (host, database, _) = try makeHost(sdk)
        _ = try await host.start()
        let bootCalls = await sdk.calls; XCTAssertTrue(bootCalls.isEmpty)
        for command in ["syncStored", "syncResume"] {
            let reply = try value(await host.foregroundSync(command: command, requestJSON: "{}"))
            XCTAssertEqual(reply["success"] as? Bool, true); XCTAssertEqual(reply["skipped"] as? Bool, true)
        }
        let calls = await sdk.calls, writes = await sdk.writes
        XCTAssertTrue(calls.isEmpty); XCTAssertTrue(writes.isEmpty); XCTAssertEqual(try taskRows(database).count, 0)
    }

    func testStoredFileMetadataUsesForegroundLaneAndOffKeepsDirectoryLane() async throws {
        let sdk = CloudKitHostSDK(), (host, database, directory) = try makeHost(sdk, backend: "file")
        _ = try await host.start()
        let manifest = directory.appendingPathComponent("container/Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        let original = try Data(contentsOf: manifest), originalTasks = try tasks(database)
        let expectedOptions: Set<String> = ["off", "file", "webdav", "selfhosted", "cloudkit"]
        for command in ["openSyncSettings", "syncSettings"] {
            let model = try value(await host.foregroundSync(command: command, requestJSON: "{}"))
            XCTAssertEqual((model["panel"] as? [String: Any])?["kind"] as? String, "file")
            let options = try XCTUnwrap((model["backend"] as? [String: Any])?["options"] as? [[String: Any]])
            XCTAssertEqual(options.count, expectedOptions.count)
            XCTAssertEqual(Set(options.compactMap { $0["option"] as? String }), expectedOptions)
            XCTAssertEqual(options.first { $0["option"] as? String == "file" }?["selected"] as? Bool, true)
        }
        let closed = try object(await host.foregroundSync(command: "closeSyncSettings", requestJSON: "{}"))
        XCTAssertEqual(closed["ok"] as? Bool, true); XCTAssertTrue(closed["value"] is NSNull)
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertEqual(try tasks(database), originalTasks)
        _ = try value(await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        let switched = try value(await host.foregroundDirectorySyncSettings(command: "selectSyncBackend", requestJSON:
            cloudKitHostJSON(["requestId": UUID().uuidString.lowercased(), "option": "off"])))
        assertNoErrorToasts(switched)
        let off = try value(await host.foregroundSync(command: "syncSettings", requestJSON: "{}"))
        XCTAssertTrue(off["panel"] is NSNull)
        let options = try XCTUnwrap((off["backend"] as? [String: Any])?["options"] as? [[String: Any]])
        XCTAssertEqual(Set(options.compactMap { $0["option"] as? String }), expectedOptions)
        XCTAssertEqual(options.first { $0["option"] as? String == "off" }?["selected"] as? Bool, true)
        let calls = await sdk.calls, writes = await sdk.writes
        XCTAssertTrue(calls.allSatisfy { $0 == "accountStatus" }); XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(try tasks(database), originalTasks)
        let finished = try object(await host.foregroundSync(command: "closeSyncSettings", requestJSON: "{}"))
        XCTAssertEqual(finished["ok"] as? Bool, true)
    }

    func testCanonicalSettingsSelectionAndSyncNowMergeRemoteInboxThroughRealCore() async throws {
        let sdk = CloudKitHostSDK(tasks: try remoteTask()), (host, database, _) = try makeHost(sdk, backend: "off")
        _ = try await host.start()
        let opened = try value(await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        let options = try XCTUnwrap((opened["backend"] as? [String: Any])?["options"] as? [[String: Any]])
        XCTAssertTrue(options.contains { $0["option"] as? String == "cloudkit" })
        let openingCalls = await sdk.calls; XCTAssertFalse(openingCalls.isEmpty)
        XCTAssertTrue(openingCalls.allSatisfy { $0 == "accountStatus" }); XCTAssertEqual(try taskRows(database).count, 0)
        let selected = try value(await host.foregroundSync(command: "selectSyncBackend", requestJSON:
            cloudKitHostJSON(["requestId": UUID().uuidString.lowercased(), "option": "cloudkit"])))
        assertNoErrorToasts(selected)
        let model = try value(await host.foregroundSync(command: "syncSettings", requestJSON: "{}"))
        try assertCloudKitPanel(model, enabled: true)
        assertNoErrorToasts(try value(await sync(host)))
        let rows = try taskRows(database); XCTAssertEqual(rows.count, 1)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row["id"] as? String, "cloudkit-remote-inbox")
        XCTAssertEqual(row["status"] as? String, "inbox"); XCTAssertEqual(row["description"] as? String, "Synthetic remote note")
        let calls = await sdk.calls, writes = await sdk.writes
        for type in ["MindwtrTask", "MindwtrProject", "MindwtrSection", "MindwtrArea", "MindwtrPerson", "MindwtrSettings"] {
            XCTAssertTrue(calls.contains("fetch:" + type), "Missing full fetch: " + type)
        }
        XCTAssertTrue(calls.contains("ensureZone"))
        let requests = try writes.map { try NativeCloudKitRequest(json: $0) }
        let taskPayloads = requests.compactMap { request -> String? in
            if case .saveRecords(.task, let raw) = request { return raw }; return nil
        }
        XCTAssertFalse(taskPayloads.isEmpty)
        let saved = try XCTUnwrap(taskPayloads.last)
        let records = try XCTUnwrap(NativeJSON.jsonObject(with: Data(saved.utf8)) as? [[String: Any]])
        XCTAssertEqual(records.filter { $0["id"] as? String == "cloudkit-remote-inbox" }.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testFailedOrPartialReadNeverPublishesRemoteOrChangesLocalTasks() async throws {
        for fault in [CloudKitHostSDK.ReadFault.failed, .malformed] {
            let sdk = CloudKitHostSDK(tasks: try remoteTask(), fault: fault)
            let (host, database, directory) = try makeHost(sdk)
            _ = try await host.start(); await host.close()
            _ = try execute(database, "INSERT INTO tasks(id,title,status,tags,contexts,createdAt,updatedAt,rev,revBy,isFocusedToday,showFutureRecurrence,suppressMindwtrReminders,pushCount) VALUES ('local-retained','Synthetic local','inbox','[]','[]',?,?,1,'fixture',0,0,0,0)", [at, at])
            let (reopened, _, _) = try makeHost(sdk, directory: directory); _ = try await reopened.start()
            let before = try tasks(database)
            _ = try value(await reopened.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
            var failed = false
            do {
                let reply = try object(await sync(reopened))
                let result = reply["value"] as? [String: Any] ?? [:]
                let toasts = result["toasts"] as? [[String: Any]] ?? []
                failed = reply["ok"] as? Bool == false || toasts.contains { $0["tone"] as? String == "error" }
            } catch { failed = true }
            XCTAssertTrue(failed, "Failed read must surface as failure")
            let calls = await sdk.calls, writes = await sdk.writes
            XCTAssertTrue(calls.contains("fetch:MindwtrSection")); XCTAssertTrue(writes.isEmpty)
            XCTAssertEqual(try tasks(database), before)
            XCTAssertEqual(try taskRows(database).map { $0["id"] as? String }, ["local-retained"])
            await reopened.close()
        }
    }

    func testUnavailableAccountDisablesCanonicalSyncNowAndNeverWritesData() async throws {
        let sdk = CloudKitHostSDK(status: "noAccount"), (host, database, _) = try makeHost(sdk)
        _ = try await host.start()
        let model = try value(await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        try assertCloudKitPanel(model, enabled: false)
        let response = try object(await sync(host))
        XCTAssertEqual(response["ok"] as? Bool, false)
        let calls = await sdk.calls, writes = await sdk.writes
        XCTAssertTrue(calls.contains("accountStatus")); XCTAssertTrue(calls.allSatisfy { $0 == "accountStatus" })
        XCTAssertTrue(writes.isEmpty); XCTAssertEqual(try taskRows(database).count, 0)
    }

    func testCancelledReadDrainsCallbackBeforeHostCloseAndNewOwner() async throws {
        let entered = expectation(description: "SDK read held")
        let sdk = CloudKitHostSDK(fault: .held, entered: entered)
        let (host, database, directory) = try makeHost(sdk); _ = try await host.start()
        _ = try value(await host.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        let work = Task { try await self.sync(host) }
        await fulfillment(of: [entered], timeout: 5)
        work.cancel()
        let closing = Task { await host.close(); await sdk.markClosed() }
        // A bounded fallback prevents a broken cancellation path from hanging the whole test process.
        let released = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await sdk.releaseHeldForFallback()
        }
        do { _ = try await work.value; XCTFail("Cancelled sync must not report success") } catch {}
        await closing.value; released.cancel()
        let events = await sdk.events, writes = await sdk.writes, fallback = await sdk.fallbackReleased
        let held = try XCTUnwrap(events.firstIndex(of: "read-held"))
        let cancelled = try XCTUnwrap(events.indices.first { $0 > held && events[$0] == "cancel" })
        let returned = try XCTUnwrap(events.firstIndex(of: "read-returned")), closed = try XCTUnwrap(events.firstIndex(of: "host-closed"))
        XCTAssertFalse(fallback, "The native cancel callback must release the held read")
        XCTAssertLessThan(cancelled, returned); XCTAssertLessThan(returned, closed); XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(try taskRows(database).count, 0)
        let (next, _, _) = try makeHost(sdk, directory: directory); _ = try await next.start()
        let fresh = try value(await next.foregroundSync(command: "openSyncSettings", requestJSON: "{}"))
        try assertCloudKitPanel(fresh, enabled: true)
        await next.close()
    }
}
