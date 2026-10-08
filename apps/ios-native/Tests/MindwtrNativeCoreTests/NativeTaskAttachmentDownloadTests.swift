import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// Actual selected JSC/HTTP/native producer. No real endpoint or credentials.
private final class TaskDownloadHTTPState: @unchecked Sendable {
    private let lock = NSLock()
    var bytes = Data(), status = 200
    var expectedAuthorization = "Basic " + Data("synthetic:fixture-only".utf8).base64EncodedString()
    var duringGET: (() -> Void)?
    var holdResponse = false
    private var count = 0, rejected = 0, stoppedCount = 0
    var requests: Int { lock.lock(); defer { lock.unlock() }; return count }
    var unexpected: Int { lock.lock(); defer { lock.unlock() }; return rejected }
    var stops: Int { lock.lock(); defer { lock.unlock() }; return stoppedCount }
    func stopped() { lock.lock(); stoppedCount += 1; lock.unlock() }
    func respond(_ request: URLRequest) -> (Int, Data, Bool) {
        lock.lock(); count += 1
        let valid = request.httpMethod == "GET" && request.url?.path == "/sync/attachments/36300000-1111-4111-8111-111111111111.txt"
            && request.value(forHTTPHeaderField: "Authorization") == expectedAuthorization
            && request.httpBody == nil
        if !valid { rejected += 1 }
        let value = (valid ? status : 401, bytes, holdResponse), callback = duringGET
        lock.unlock(); callback?(); return value
    }
}
private final class TaskDownloadHTTPProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var states: [String: TaskDownloadHTTPState] = [:]
    static func set(_ host: String, _ state: TaskDownloadHTTPState?) { lock.lock(); states[host] = state; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.states[request.url?.host ?? ""]; Self.lock.unlock()
        guard let state, let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        let (status, bytes, held) = state.respond(request)
        if held { return } // URLSession cancellation must settle this accepted GET.
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Length": String(bytes.count), "Content-Type": "application/octet-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {
        Self.lock.lock(); let state = Self.states[request.url?.host ?? ""]; Self.lock.unlock()
        state?.stopped()
    }
}

final class NativeTaskAttachmentDownloadTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!, bundle: URL!, hostname: String!, namespace: String!
    private var remote: TaskDownloadHTTPState!
    private var scheduleBase: [String: Any]!
    private var before: EditorDraftSnapshot!
    private var relocationFixtureBase: URL?
    private let taskID = "task363-download"
    private var attachmentID = "36300000-1111-4111-8111-111111111111"
    private let requestID = "36300000-2222-4222-8222-222222222222"
    private let bytes = Data([0, 255, 128, 7, 13, 10]) + Data("Task363 / 文".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Set actual iOS MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured Task Download bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeTaskAttachmentDownloadTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        hostname = "task363-" + UUID().uuidString.lowercased() + ".invalid"
        namespace = "tech.dongdongbh.mindwtr.task363." + UUID().uuidString.lowercased()
        remote = TaskDownloadHTTPState(); remote.bytes = bytes
        TaskDownloadHTTPProtocol.set(hostname, remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(remote?.unexpected, 0, "Every request is a bound authenticated GET")
        if let hostname { TaskDownloadHTTPProtocol.set(hostname, nil) }
        if let root { try FileManager.default.removeItem(at: root) }
        if let relocationFixtureBase, FileManager.default.fileExists(atPath: relocationFixtureBase.path) {
            try FileManager.default.removeItem(at: relocationFixtureBase)
        }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func hash(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
    private func sql(_ text: String, _ params: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }; return try db.execute(text, parametersJSON: json(params))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func inode(_ url: URL) throws -> String {
        var stat = Darwin.stat(); guard lstat(url.path, &stat) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(UInt64(stat.st_dev)):\(UInt64(stat.st_ino))"
    }
    private func host(_ selected: URL? = nil, faults supplied: HostIOFaults? = nil, secureRead: Bool = false) -> CoreHost {
        let faults = supplied ?? HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TaskDownloadHTTPProtocol.self]; faults.httpConfiguration = configuration
        if faults.secretService == nil { faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased() }
        // Headless macOS does not write or depend on Keychain. The actual native
        // true-null route reads an isolated legacy value without migrating it.
        if !secureRead { faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : nil } }
        let value = CoreHost(databaseURL: database, bundleURL: selected ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func seed(backend: String = "webdav", originalURI: String? = nil, encrypted: Bool = false) async throws {
        var settings: [String: Any] = ["@mindwtr_sync_backend": backend,
            "@mindwtr_webdav_url": "https://" + hostname + "/sync/data.json", "@mindwtr_webdav_username": "synthetic",
            "@mindwtr_webdav_allow_insecure_http": "false", "@mindwtr_webdav_password": "fixture-only", "unknown": "preserved / 文"]
        if backend == "cloud" {
            settings["@mindwtr_cloud_url"] = "https://" + hostname + "/sync/data"
            settings["@mindwtr_cloud_provider"] = "selfhosted"
            settings["@mindwtr_cloud_allow_insecure_http"] = "false"
            settings["@mindwtr_cloud_token"] = "synthetic-cloud-token-401"
            remote.expectedAuthorization = "Bearer synthetic-cloud-token-401"
        }
        if encrypted {
            settings["@mindwtr_sync_encryption_state_v1"] = try json(["state": "enabled", "discoveredSalt": String(repeating: "0", count: 32),
                "discoveredParams": ["mKib": 64, "t": 1, "p": 1]])
            settings["@mindwtr_sync_encryption_key_v1"] = Data(count: 32).base64EncodedString()
        }
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(settings).utf8).write(to: manifest)
        let boot = host(); _ = try await boot.start(); await boot.close()
        let at = "2026-10-05T12:00:00.000Z"
        let saved: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Remote source.txt",
            "uri": originalURI ?? target.absoluteString, "size": bytes.count, "mimeType": "text/plain", "createdAt": at, "updatedAt": at,
            "cloudKey": "attachments/" + attachmentID + ".txt", "fileHash": hash(bytes).uppercased(), "contentRev": 7, "localStatus": "missing"]
        _ = try sql("INSERT INTO tasks(id,title,description,status,taskMode,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Saved title','Saved note','next','list','[]','[]',?,?,?,1,'fixture',0,0,0,0)", [taskID, json([saved]), at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy) VALUES ('other','Untouched','inbox','[]','[]',?,?,1,'fixture')", [at, at])
        let opening = host(); _ = try await opening.start()
        let model = try object(await opening.call("editorModel", argumentsJSON: json([taskID])))
        scheduleBase = try XCTUnwrap(model["scheduleBase"] as? [String: Any]); await opening.close()
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": ["title": "Saved title", "description": "Saved note"],
            "edited": ["title": "Dirty title", "description": "Kept dirty note / 文"],
            "raw": ["title": "Dirty title", "note": "Kept dirty note / 文", "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [saved], "attachments": [saved],
            "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        before = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try editor.checkpoint(before)
        if encrypted {
            var header = Data("MWENC1".utf8); header.append(contentsOf: [1,1,64,0,0,0,1,0,0,0,1,1])
            header.append(Data(count: 16)); header.append(Data(count: 12))
            var length = UInt64(bytes.count + 16).littleEndian
            withUnsafeBytes(of: &length) { header.append(contentsOf: $0) }
            XCTAssertEqual(header.count, 54)
            let box = try AES.GCM.seal(bytes, using: SymmetricKey(data: Data(count: 32)), nonce: AES.GCM.Nonce(data: Data(count: 12)), authenticating: header)
            remote.bytes = header + box.ciphertext + box.tag
        }
    }
    private func request(_ id: String? = nil) throws -> String {
        let selected = try XCTUnwrap((object(before.payloadJSON)["attachments"] as? [[String: Any]])?.first)
        let identity = try json([attachmentID, selected["cloudKey"] ?? NSNull(), selected["fileHash"] ?? NSNull(), selected["contentRev"] ?? 0])
        return try json(["version": 1, "requestId": id ?? requestID, "sessionID": before.sessionID, "generation": before.generation,
            "attachmentId": attachmentID, "identity": identity])
    }
    private func savedRequest() throws -> String {
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot), payload = try object(checkpoint.payloadJSON)
        return try json(["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": try XCTUnwrap(payload["touchedBase"]),
            "patch": try XCTUnwrap(payload["edited"]), "scheduleBase": try XCTUnwrap(scheduleBase),
            "checklist": ["base": try XCTUnwrap(payload["checklistBase"]), "value": try XCTUnwrap(payload["checklistValue"])],
            "attachments": ["base": try XCTUnwrap(payload["attachmentsBase"]), "value": try XCTUnwrap(payload["attachments"])]] as [String: Any])
    }
    private func refusal(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected exact refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    private func suffix(_ text: String) throws -> URL {
        let url = root.appendingPathComponent(UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + text).write(to: url, atomically: true, encoding: .utf8); return url
    }
    private func files(_ url: URL) throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: url.path).sorted() }
    private func trackedPreparationBundle(malformedTerminal: Bool = false) throws -> URL {
        try suffix("""
        ;(() => {
          const prepare=MindwtrHost.iosTaskDraftPrepareAvailability,poll=MindwtrHost.poll,begin=MindwtrHost.attachmentDraftBeginV5,read=MindwtrHost.menuRead;
          const active=new Set(),probes=new Set();let input=null,settled=0,malformed=\(malformedTerminal ? "true" : "false");
          MindwtrHost.iosTaskDraftPrepareAvailability=(raw,source)=>{input=JSON.parse(raw);const id=prepare(raw,source);active.add(id);return id;};
          MindwtrHost.poll=id=>{const raw=poll(id);if(!raw)return raw;
            if(active.delete(id)){settled++;if(malformed){malformed=false;return '!synthetic-malformed-terminal';}}
            if(probes.delete(id)){const result=JSON.parse(raw);if(result.ok)result.value={pending:active.size,settled};return JSON.stringify(result);}return raw;};
          MindwtrHost.menuRead=(name,raw)=>{if(name!=='dataSettings'||raw!=='{}')return read(name,raw);const id=begin(JSON.stringify({taskID:input.taskID,payloadJSON:input.beforePayloadJSON}));probes.add(id);return id;};
        })();
        """)
    }
    private func exactEditorReplacement() throws -> String {
        let bytes = try Data(contentsOf: editor.url), prior = try inode(editor.url)
        try bytes.write(to: editor.url, options: .atomic)
        let current = try inode(editor.url)
        XCTAssertNotEqual(prior, current, "The owner fence must see an actual same-byte inode replacement")
        XCTAssertEqual(try Data(contentsOf: editor.url), bytes)
        return current
    }
    func testPlaintextOwnedDownloadRetainsDirtyDraftAndSavedRowsThenColdSavePublishesExactlyOnce() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), savedManifestInode = try inode(manifest)
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(reply["generation"] as? Int, 2)
        XCTAssertEqual(reply["attachmentId"] as? String, attachmentID); XCTAssertNotEqual(attachmentID, requestID)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try inode(manifest), savedManifestInode)
        let record = try XCTUnwrap(store.readAvailability()), op = try XCTUnwrap(record.operations.last)
        XCTAssertEqual(op.phase, .checkpointed); guard case .owned = op.resource else { return XCTFail("Actual bytes require owned creation receipt") }
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try files(cache), [])
        let targetInode = try inode(target), requests = remote.requests
        let replay = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(replay["status"] as? String, "draftAvailable")
        XCTAssertEqual(remote.requests, requests, "Exact UUID replay performs no HTTP or source creation")
        await live.close()
        let cold = host(); _ = try await cold.start()
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        _ = try await cold.saveAttachmentDraftComplete(saveRequestJSON: savedRequest(), expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try inode(target), targetInode); XCTAssertEqual(try Data(contentsOf: target), bytes)
        let row = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT title,description,rev FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(row["title"] as? String, "Dirty title"); XCTAssertEqual(row["description"] as? String, "Kept dirty note / 文"); XCTAssertEqual(row["rev"] as? Int, 2)
        await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-task-availability-consumers")); XCTAssertTrue(log.contains("availability-checkpoint"))
        XCTAssertFalse(log.contains("fixture-only")); XCTAssertFalse(log.contains(hostname)); XCTAssertFalse(log.contains("Kept dirty note"))
    }
    func testSelfHostedTaskDownloadUsesBearerRetainsAuthorityAndColdSavePublishesOnce() async throws {
        try await seed(backend: "cloud"); let original = try rows(), settings = try Data(contentsOf: manifest)
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(reply["attachmentId"] as? String, attachmentID)
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try files(cache), [])
        let record = try XCTUnwrap(store.readAvailability()), op = try XCTUnwrap(record.operations.last)
        XCTAssertEqual(op.phase, .checkpointed); guard case .owned = op.resource else { return XCTFail("Cloud bytes need the same native owned receipt") }
        _ = try await live.downloadTaskAttachmentV5(requestJSON: request()); XCTAssertEqual(remote.requests, 1)
        let installed = try inode(target); await live.close()
        let cold = host(); _ = try await cold.start(); let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        _ = try await cold.saveAttachmentDraftComplete(saveRequestJSON: savedRequest(), expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try inode(target), installed); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(remote.requests, 1)
        XCTAssertEqual(try Data(contentsOf: manifest), settings)
        let row = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT title,description,rev FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(row["title"] as? String, "Dirty title"); XCTAssertEqual(row["description"] as? String, "Kept dirty note / 文"); XCTAssertEqual(row["rev"] as? Int, 2)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-selfhosted-file-availability")); XCTAssertTrue(log.contains("selfhosted-task-availability"))
        XCTAssertFalse(log.contains("synthetic-cloud-token-401")); XCTAssertFalse(log.contains(hostname)); XCTAssertFalse(log.contains("Kept dirty note"))
    }
    private func assertSelfHostedAuthorityChange(_ name: String, _ value: String) async throws {
        try await seed(backend: "cloud"); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        var changed = false, failed = false
        remote.duringGET = {
            do { var current = try self.object(String(decoding: settings, as: UTF8.self)); current[name] = value
                try Data(self.json(current).utf8).write(to: self.manifest, options: .atomic); changed = true
            } catch { failed = true }
        }
        let live = host(); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(changed); XCTAssertFalse(failed); XCTAssertEqual(remote.requests, 1)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        let current = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)); XCTAssertEqual(current[name] as? String, value)
        await live.close(); remote.duringGET = nil; try settings.write(to: manifest, options: .atomic)
        let cold = host(); _ = try await cold.start()
        let retried = try object(await cold.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(retried["status"] as? String, "draftAvailable")
        XCTAssertEqual(remote.requests, 2); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
    }
    func testSelfHostedTaskCloudURLChangeAfterGETRefusesBeforeInstallThenColdRetryCompletes() async throws {
        try await assertSelfHostedAuthorityChange("@mindwtr_cloud_url", "https://changed.invalid/sync/data")
    }
    func testSelfHostedTaskProviderChangeAfterGETRefusesBeforeInstallThenColdRetryCompletes() async throws {
        try await assertSelfHostedAuthorityChange("@mindwtr_cloud_provider", "dropbox")
    }
    func testSelfHostedTaskLegacyTokenChangeAfterGETRefusesBeforeInstallThenColdRetryCompletes() async throws {
        try await assertSelfHostedAuthorityChange("@mindwtr_cloud_token", "synthetic-changed-token-401")
    }
    func testSelfHostedTaskSecureAuthorityFailureAfterGETRefusesBeforeNativeSourceOrInstall() async throws {
        try await seed(backend: "cloud"); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let faults = HostIOFaults(); var postGETReads = 0
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { return nil }
            if self.remote.requests > 0 { postGETReads += 1; return errSecNotAvailable }
            return errSecItemNotFound
        }
        let live = host(faults: faults, secureRead: true); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertGreaterThan(postGETReads, 0); XCTAssertEqual(remote.requests, 1)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
    }
    func testPhysicalSelfHostedSecureTokenValueChangeAfterGETRefusesBeforeInstall() async throws {
        #if os(iOS)
        try await seed(backend: "cloud")
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretService = service
        let account = Data("mindwtr_cloud_token".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var input = query; input[kSecValueData as String] = Data("synthetic-cloud-token-401".utf8)
        input[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        defer { let status = SecItemDelete(query as CFDictionary); XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound) }
        var changed = false, changeStatus = errSecSuccess
        remote.duringGET = {
            changeStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data("synthetic-changed-token-401".utf8)] as CFDictionary)
            changed = true
        }
        let live = host(faults: faults, secureRead: true); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(changed); XCTAssertEqual(changeStatus, errSecSuccess); XCTAssertEqual(remote.requests, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        #else
        throw XCTSkip("Actual isolated cloud-token value changes are iOS-only; macOS proves read failure and legacy authority changes")
        #endif
    }
    func testSelfHostedTaskIncompleteTransitionRefusesBeforeGETAndRetainsLocalState() async throws {
        try await seed(backend: "cloud")
        var current = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        current["@mindwtr_sync_encryption_state_v1"] = try json(["state": "off", "incompleteTransition": "enable"])
        try Data(json(current).utf8).write(to: manifest)
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let live = host(); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertEqual(remote.requests, 0); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertNil(try store.readAvailability()); XCTAssertEqual(try files(cache), [])
    }
    func testSelfHostedTaskResponseCapRefusesWithoutSourceOrMetadataPublication() async throws {
        try await seed(backend: "cloud"); remote.bytes = Data(count: 8_388_609)
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable"); XCTAssertEqual(reply["attachmentId"] as? String, attachmentID)
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
    }
    func testSameURIAlreadyAvailableSelfHostedProjectRefusesBeforeIOAndLeavesLiveAndColdPersistenceClean() async throws {
        try await seed(backend: "cloud"); try FileManager.default.removeItem(at: editor.url)
        let projectID = "project401-download", at = "2026-10-07T00:00:00.000Z"
        let item: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Project source.txt", "uri": target.absoluteString,
            "size": bytes.count, "createdAt": at, "updatedAt": at, "cloudKey": "attachments/" + attachmentID + ".txt",
            "fileHash": hash(bytes), "localStatus": "available", "contentRev": 7]
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy,viewSectionIds) VALUES (?,'Preserve Project','active','#94a3b8','Preserve notes',1,NULL,0,0,?,?,?,3,'fixture','[]')", [projectID, json([item]), at, at])
        let faults = HostIOFaults(), hooks = NativeAttachmentHostHooks()
        var fileWork = 0, installerWork = 0, secretWork = 0
        hooks.configureJobs = { $0.beforeWork = { _, installer in
            if installer { installerWork += 1 } else { fileWork += 1 }
        } }
        faults.secretAfterOperation = { _, _ in secretWork += 1 }
        let live = host(faults: faults); await live.configureAttachmentHost(hooks); _ = try await live.start()
        // Warm intentional settings persistence before taking exact domain/config baselines.
        let filter = try object(await live.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        let sameSelection = try json(XCTUnwrap(option["next"]))
        _ = try await live.call("setAreaFilter", argumentsJSON: json([sameSelection]))
        let options = try object(await live.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        let revision = try XCTUnwrap(options["revision"] as? String)
        let input = try json(["projectId": projectID, "attachmentId": attachmentID, "revision": revision])
        // Canonicalize only SQL's outer JSON object keys across reopened connections.
        // Attachment column values remain exact raw strings; their content is not parsed.
        func projectRows() throws -> String {
            try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects ORDER BY id").utf8)))
        }
        let original = try rows(), projects = try projectRows(), settings = try Data(contentsOf: manifest)
        // An early refusal must preserve absent directories as well as contents;
        // the fixture must not create them merely to inspect an empty inventory.
        func directoryInventory(_ url: URL) throws -> [String]? {
            FileManager.default.fileExists(atPath: url.path) ? try files(url) : nil
        }
        let managedBefore = try directoryInventory(managed), cacheBefore = try directoryInventory(cache)
        var workBefore = fileWork, installsBefore = installerWork, secretsBefore = secretWork
        func assertPreserved() throws {
            XCTAssertEqual(remote.requests, 0); XCTAssertEqual(fileWork, workBefore); XCTAssertEqual(installerWork, installsBefore)
            XCTAssertEqual(secretWork, secretsBefore, "The ineligible already-available route never reads credentials")
            XCTAssertEqual(try rows(), original); XCTAssertEqual(try projectRows(), projects)
            XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try directoryInventory(managed), managedBefore); XCTAssertEqual(try directoryInventory(cache), cacheBefore)
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try store.readAvailability())
            let log = root.appendingPathComponent("logs/mindwtr.log")
            if FileManager.default.fileExists(atPath: log.path) {
                let text = try String(contentsOf: log, encoding: .utf8)
                XCTAssertFalse(text.contains("v1.3.5/ios-selfhosted-file-availability"))
                XCTAssertFalse(text.contains("v1.3.5/ios-project-file-download"))
                XCTAssertFalse(text.contains("v1.3.5/ios-selfhosted-project-download"))
            }
        }
        for _ in 0..<2 {
            do { _ = try await live.foregroundSync(command: "projectAttachmentDownload", requestJSON: input); XCTFail("Same-URI available Project download must refuse before IO") }
            catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
            try assertPreserved()
            // A same-current filter command retries persistence when a latch exists.
            // Successful fresh reads and an unchanged row after this command prove
            // refusal left no failed or queued downloading snapshot to publish.
            let fresh = try object(await live.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
            XCTAssertEqual(fresh["revision"] as? String, revision)
            _ = try await live.call("setAreaFilter", argumentsJSON: json([sameSelection]))
            try assertPreserved()
        }
        await live.close()
        let cold = host(faults: faults); await cold.configureAttachmentHost(hooks); _ = try await cold.start()
        let coldOptions = try object(await cold.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        let coldRevision = try XCTUnwrap(coldOptions["revision"] as? String)
        let coldInput = try json(["projectId": projectID, "attachmentId": attachmentID, "revision": coldRevision])
        workBefore = fileWork; installsBefore = installerWork; secretsBefore = secretWork
        do { _ = try await cold.foregroundSync(command: "projectAttachmentDownload", requestJSON: coldInput); XCTFail("Cold same-URI available Project download must refuse before IO") }
        catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        let coldFresh = try object(await cold.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        XCTAssertEqual(coldFresh["revision"] as? String, coldRevision)
        _ = try await cold.call("setAreaFilter", argumentsJSON: json([sameSelection]))
        try assertPreserved()
    }
    func testUnlockedCiphertextUsesActualAESOpenAndReadOnlyLegacyFallback() async throws {
        try await seed(encrypted: true); let original = try rows(), settings = try Data(contentsOf: manifest)
        let faults = HostIOFaults(); var operations = [String]()
        faults.cryptoAfterOperation = { operations.append($0) }
        let live = host(faults: faults); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        XCTAssertEqual(operations, ["aesGcmOpen"]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
    }
    func testExistingCurrentManagedBytesAreBorrowedAndDiscardNeverDeletesThem() async throws {
        try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        let identity = try inode(target), original = try rows(), live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        XCTAssertEqual(remote.requests, 0); guard case .borrowed = try XCTUnwrap(store.readAvailability()?.operations.last).resource else { return XCTFail("Preexisting bytes are borrowed") }
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
        let discardID = UUID().uuidString.lowercased()
        _ = try await live.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]))
        _ = try await live.finishAttachmentDraftDiscardV3(expectedSession: checkpoint.sessionID, requestId: discardID)
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
    }
    func test404ProducesOnlyDraftTombstoneAndColdDiscardKeepsSavedTask() async throws {
        try await seed(); remote.status = 404; let original = try rows(), settings = try Data(contentsOf: manifest), live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftUnrecoverable")
        let op = try XCTUnwrap(store.readAvailability()?.operations.last); guard case .none = op.resource else { return XCTFail("404 owns no bytes") }
        XCTAssertNil(op.targetURI); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        await live.close(); let cold = host(); _ = try await cold.start(); let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
        let discardID = UUID().uuidString.lowercased()
        _ = try await cold.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]))
        _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: checkpoint.sessionID, requestId: discardID)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
    }
    func testKnownOffRefusesBeforeHTTPAndEmptyOwner() async throws {
        try await seed(backend: "off"); let original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable")
        XCTAssertNil(try store.readVersioned()); XCTAssertEqual(remote.requests, 0); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        await live.close()
    }
    func testForeignOriginalRefusesBeforeHTTPAndEmptyOwner() async throws {
        try await seed(originalURI: "files/attachments/foreign.txt")
        let original = try rows(), checkpoint = try Data(contentsOf: editor.url), live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable")
        XCTAssertNil(try store.readVersioned()); XCTAssertEqual(remote.requests, 0)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
    }
    func testDuplicateSourceCallbackCannotPublishEvenWhenFirstTokenIsReturned() async throws {
        try await seed(); let original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let probe = try suffix("""
        ;(() => { const prepare=MindwtrHost.iosTaskDraftPrepareAvailability;
          MindwtrHost.iosTaskDraftPrepareAvailability=(input,source)=>prepare(input,(metadata,bytes)=>{const first=source(metadata,bytes);source(metadata,bytes);return first;});})();
        """)
        let hooks = NativeAttachmentHostHooks(); var sourceCreated = 0
        hooks.configureJobs = { $0.beforeStageSync = { sourceCreated += 1 } }
        let live = host(probe); await live.configureAttachmentHost(hooks); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(sourceCreated, 1, "Refusal must follow the actual native source creation boundary")
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
    }
    func testWrongNativeSourceTokenRefusesBeforeIntentAndRetiresOnlyMintedScratch() async throws {
        try await seed(); let original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let probe = try suffix("""
        ;(() => { const poll=MindwtrHost.poll;MindwtrHost.poll=id=>{const raw=poll(id);if(!raw)return raw;const r=JSON.parse(raw);
          if(r.ok&&r.value&&r.value.status==='prepared')r.value.sourceToken='36300000-ffff-4fff-8fff-ffffffffffff';return JSON.stringify(r);};})();
        """)
        let hooks = NativeAttachmentHostHooks(); var sourceCreated = 0
        hooks.configureJobs = { $0.beforeStageSync = { sourceCreated += 1 } }
        let live = host(probe); await live.configureAttachmentHost(hooks); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(sourceCreated, 1, "Refusal must follow the actual native source creation boundary")
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
    }
    func testInterruptedIntentColdRetryReusesCapturedSourceWithoutSecondGET() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), live = host(); _ = try await live.start()
        let hooks = AttachmentDraftHostHooks(); var hit = false
        hooks.boundary = { if $0 == .afterIntent { hit = true; throw HostFailure("Synthetic intent interruption") } }
        await live.configureAttachmentDraftHost(hooks)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(hit); XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .intent)
        XCTAssertEqual(try files(cache).count, 1); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        let requests = remote.requests; await live.close()
        let cold = host(); _ = try await cold.start()
        let reply = try object(await cold.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        XCTAssertEqual(remote.requests, requests); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
    }
    func testEditorReplacementDuringGETSettlesExactTicketAndNextRequestCanComplete() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest)
        let faults = HostIOFaults(); var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        faults.configureHTTPJobs = { http = $0 }; faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        let hooks = NativeAttachmentHostHooks(); var fileSyncs = 0
        hooks.configureJobs = { fileJobs = $0; $0.beforeStageSync = { fileSyncs += 1 } }
        var replacement: String?, mutationFailed = false
        remote.duringGET = { self.remote.duringGET = nil; do { replacement = try self.exactEditorReplacement() } catch { mutationFailed = true } }
        let live = host(try trackedPreparationBundle(), faults: faults); await live.configureAttachmentHost(hooks); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertFalse(mutationFailed); XCTAssertNotNil(replacement); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(fileSyncs, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0); XCTAssertEqual(secrets?.counters.jobs, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try inode(editor.url), replacement)
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2); XCTAssertEqual(fileSyncs, 2, "The valid turn syncs one cache source and one installer stage")
        let finalProbe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(finalProbe["pending"] as? Int, 0); XCTAssertEqual(finalProbe["settled"] as? Int, 2)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testEditorReplacementDuringAESOpenDrainsCryptoAndNextRequestCanComplete() async throws {
        try await seed(encrypted: true); let original = try rows(), settings = try Data(contentsOf: manifest)
        let faults = HostIOFaults(); var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        faults.configureHTTPJobs = { http = $0 }; faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        var replacement: String?, mutationFailed = false, operations = 0
        faults.cryptoBeforeOperation = { operation in
            guard operation == "aesGcmOpen" else { return }; operations += 1
            if replacement == nil { do { replacement = try self.exactEditorReplacement() } catch { mutationFailed = true } }
        }
        let hooks = NativeAttachmentHostHooks(); var sources = 0
        hooks.configureJobs = { fileJobs = $0; $0.beforeStageSync = { sources += 1 } }
        let live = host(try trackedPreparationBundle(), faults: faults); await live.configureAttachmentHost(hooks); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertFalse(mutationFailed); XCTAssertNotNil(replacement); XCTAssertEqual(operations, 1); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(sources, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(secrets?.counters.jobs, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try inode(editor.url), replacement); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(operations, 2)
        let finalProbe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(finalProbe["pending"] as? Int, 0); XCTAssertEqual(finalProbe["settled"] as? Int, 2)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testMalformedConsumedTerminalDoesNotPollRemovedTicketOrLeavePreparationActive() async throws {
        try await seed(); let original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let hooks = NativeAttachmentHostHooks(); var sources = 0
        hooks.configureJobs = { $0.beforeStageSync = { sources += 1 } }
        let live = host(try trackedPreparationBundle(malformedTerminal: true)); await live.configureAttachmentHost(hooks); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(sources, 1)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        let finalProbe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(finalProbe["pending"] as? Int, 0); XCTAssertEqual(finalProbe["settled"] as? Int, 2)
    }
    func testTaskCancellationDuringHeldGETSettlesBeforeNextSameHostRequest() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let faults = HostIOFaults(); var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        faults.configureHTTPJobs = { http = $0 }; faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        let hooks = NativeAttachmentHostHooks(); var fileSyncs = 0
        hooks.configureJobs = { fileJobs = $0; $0.beforeStageSync = { fileSyncs += 1 } }
        let accepted = expectation(description: "Actual authenticated GET accepted but body not delivered")
        remote.holdResponse = true; remote.duringGET = { accepted.fulfill() }
        let live = host(try trackedPreparationBundle(), faults: faults); await live.configureAttachmentHost(hooks); _ = try await live.start()
        let requestJSON = try request(), operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: requestJSON) }
        await fulfillment(of: [accepted], timeout: 5)
        XCTAssertEqual(http?.counters.jobs, 1); XCTAssertEqual(http?.counters.running, 1)
        operation.cancel()
        await refusal { _ = try await operation.value }
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(remote.stops, 1); XCTAssertEqual(fileSyncs, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0); XCTAssertEqual(secrets?.counters.jobs, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.bytes, 0); XCTAssertEqual(fileJobs?.counters.jobs, 0)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        remote.holdResponse = false; remote.duringGET = nil
        let next = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(next["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2); XCTAssertEqual(fileSyncs, 2, "The valid turn syncs one cache source and one installer stage")
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testCloseDuringHeldGETDrainsBeforeUnlockAndColdRequestCanComplete() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let faults = HostIOFaults(); var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        faults.configureHTTPJobs = { http = $0 }; faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        let hooks = NativeAttachmentHostHooks(); var sources = 0
        hooks.configureJobs = { fileJobs = $0; $0.beforeStageSync = { sources += 1 } }
        let accepted = expectation(description: "Close observes an accepted GET before any response body")
        remote.holdResponse = true; remote.duringGET = { accepted.fulfill() }
        let live = host(try trackedPreparationBundle(), faults: faults); await live.configureAttachmentHost(hooks); _ = try await live.start()
        let requestJSON = try request(), operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: requestJSON) }
        await fulfillment(of: [accepted], timeout: 5)
        XCTAssertEqual(http?.counters.jobs, 1); XCTAssertEqual(http?.counters.running, 1)
        let closing = Task { await live.close() }
        await refusal { _ = try await operation.value }; await closing.value
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(remote.stops, 1); XCTAssertEqual(sources, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0); XCTAssertEqual(secrets?.counters.jobs, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)
        XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        remote.holdResponse = false; remote.duringGET = nil
        let cold = host(); _ = try await cold.start()
        let next = try object(await cold.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(next["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testPhysicalSecureHitReadsExactIsolatedAccountsWithoutLegacyFallback() async throws {
        #if os(iOS)
        try await seed(encrypted: true)
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        settings.removeValue(forKey: "@mindwtr_webdav_password"); settings.removeValue(forKey: "@mindwtr_sync_encryption_key_v1")
        try Data(json(settings).utf8).write(to: manifest)
        let original = try rows(), savedSettings = try Data(contentsOf: manifest)
        let faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretService = service
        let accounts = [("mindwtr_webdav_password", "fixture-only"), ("mindwtr_sync_encryption_key_v1", Data(count: 32).base64EncodedString())]
        func query(_ account: String) -> [String: Any] {
            let bytes = Data(account.utf8)
            return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
                kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        }
        defer { for (account, _) in accounts {
            let status = SecItemDelete(query(account) as CFDictionary)
            XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound, "Exact owned fixture cleanup")
        } }
        for (account, value) in accounts {
            var input = query(account); input[kSecValueData as String] = Data(value.utf8)
            input[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        }
        var reads = [String](); faults.secretAfterOperation = { operation, alias in if operation == "get" { reads.append(alias) } }
        let live = host(faults: faults, secureRead: true); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        XCTAssertEqual(reads, ["no-auth", "no-auth"], "Both isolated accounts are secure hits on their first alias"); XCTAssertEqual(reads.count, 2)
        XCTAssertEqual(try Data(contentsOf: manifest), savedSettings); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: target), bytes)
        #else
        throw XCTSkip("Actual isolated Keychain writes are iOS-only; macOS uses true-null legacy controls")
        #endif
    }
    func testEmptyOriginalURIAndInterruptedPublicationColdRetryDiscardOnlyNewOwnedBytes() async throws {
        try await seed(originalURI: ""); let original = try rows(), settings = try Data(contentsOf: manifest)
        let live = host(); _ = try await live.start()
        let hooks = AttachmentDraftHostHooks(); var published = false
        hooks.boundary = { if $0 == .afterPublication { published = true; throw HostFailure("Synthetic publication interruption") } }
        await live.configureAttachmentDraftHost(hooks)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(published); XCTAssertEqual(remote.requests, 1)
        let retained = try XCTUnwrap(store.readAvailability()?.operations.last)
        XCTAssertEqual(retained.phase, .stageFilled)
        guard case .owned(_, let stage?, let filled?, let proof) = retained.resource else { return XCTFail("Owned stage proof survives the lost publication acknowledgement") }
        XCTAssertNil(proof); XCTAssertEqual(stage.identity, filled.identity)
        let publishedInode = try inode(target)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        await live.close()
        let cold = host(); _ = try await cold.start()
        let reply = try object(await cold.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 1)
        XCTAssertEqual(try inode(target), publishedInode); XCTAssertEqual(try Data(contentsOf: target), bytes)
        let recovered = try XCTUnwrap(store.readAvailability()?.operations.last)
        XCTAssertEqual(recovered.phase, .checkpointed)
        guard case .owned(_, _, _, let publication?) = recovered.resource else { return XCTFail("Recovery verifies the actual installed inode") }
        XCTAssertEqual(publication.identity, publishedInode)
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot), discardID = UUID().uuidString.lowercased()
        _ = try await cold.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discardID, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]))
        _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: checkpoint.sessionID, requestId: discardID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read())
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(remote.requests, 1)
    }
    func testSelectedPreparationRejectsOtherPortsAndStillCompletesExactAllowedGET() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let sibling = managed.appendingPathComponent("untouched.txt"), siblingBytes = Data("Unrelated local bytes".utf8)
        try siblingBytes.write(to: sibling); let siblingInode = try inode(sibling)
        let input = try json(["taskID": taskID, "uri": sibling.absoluteString, "url": "https://" + hostname + "/sync/attachments/" + attachmentID + ".txt"])
        let probe = try suffix("""
        ;(() => {
          const prepare=MindwtrHost.iosTaskDraftPrepareAvailability,read=MindwtrHost.menuRead,poll=MindwtrHost.poll,begin=MindwtrHost.attachmentDraftBeginV5;
          const n=__mindwtrNative,f=\(input),probes=new Set();let captured=null,refused=null,retainedSource=null,lateRefused=false;
          MindwtrHost.iosTaskDraftPrepareAvailability=(raw,source)=>{
            captured=JSON.parse(raw);const deny=call=>{try{const answer=call();return typeof answer==='string'&&answer.startsWith('!MindwtrNativeError:');}catch{return false;}};
            const http={url:f.url,method:'GET',headers:[],redirect:'follow'};
            refused=[
              deny(()=>n.sqlRun("UPDATE tasks SET title='Forbidden' WHERE id=?",JSON.stringify([f.taskID]))),
              deny(()=>n.fileCall(JSON.stringify({op:'delete',uri:f.uri}))),
              deny(()=>n.fileCall(JSON.stringify({op:'readBytes',uri:f.uri}))),
              deny(()=>n.fileDeleteNow(f.uri)),
              deny(()=>n.installerCall(JSON.stringify({op:'hash',path:f.uri}))),
              deny(()=>n.kvSet('@mindwtr_sync_backend','off')),
              deny(()=>n.kvRemove('@mindwtr_webdav_password')),
              deny(()=>n.kvGet('@mindwtr_sync_backend')),
              deny(()=>n.secretCall(JSON.stringify({op:'set',key:'mindwtr_webdav_password',value:'Forbidden'}))),
              deny(()=>n.secretCall(JSON.stringify({op:'delete',key:'mindwtr_webdav_password'}))),
              deny(()=>n.secretCall(JSON.stringify({op:'get',key:'mindwtr_cloud_token'}))),
              deny(()=>n.cryptoCall(JSON.stringify({op:'aesGcmSeal',key:'A'.repeat(43)+'=',nonce:'A'.repeat(16),data:'',aad:''}))),
              deny(()=>n.netFetch(JSON.stringify({...http,method:'POST'}))),
              deny(()=>n.netFetch(JSON.stringify({...http,url:f.url+'/foreign'}))),
              deny(()=>n.secretCall(' '.repeat(524289))),
              deny(()=>n.cryptoCall(' '.repeat(12582913))),
              deny(()=>n.netFetch(' '.repeat(12582913)))
            ];return prepare(raw,(metadata,bytes)=>{retainedSource=()=>source(metadata,bytes);return retainedSource();});
          };
          MindwtrHost.menuRead=(name,raw)=>{if(name!=='dataSettings'||raw!=='{}')return read(name,raw);const late=retainedSource();lateRefused=typeof late==='string'&&late.startsWith('!MindwtrNativeError:');const id=begin(JSON.stringify({taskID:captured.taskID,payloadJSON:captured.beforePayloadJSON}));probes.add(id);return id;};
          MindwtrHost.poll=id=>{const raw=poll(id);if(!raw)return raw;if(!probes.delete(id))return raw;const result=JSON.parse(raw);if(result.ok)result.value={refused,lateRefused};return JSON.stringify(result);};
        })();
        """)
        let faults = HostIOFaults(); var secretOperations = [String](), cryptoOperations = [String]()
        faults.secretAfterOperation = { operation, _ in secretOperations.append(operation) }; faults.cryptoAfterOperation = { cryptoOperations.append($0) }
        let live = host(probe, faults: faults); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 1)
        let answer = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))), refused = try XCTUnwrap(answer["refused"] as? [Bool])
        XCTAssertEqual(answer["lateRefused"] as? Bool, true, "A retained callback cannot create a second source after its owner settles")
        XCTAssertEqual(refused.count, 17); XCTAssertTrue(refused.allSatisfy { $0 }, "All probes must reach and be refused by their selected native admission boundary")
        XCTAssertFalse(secretOperations.isEmpty); XCTAssertTrue(secretOperations.allSatisfy { $0 == "get" }); XCTAssertEqual(cryptoOperations, [])
        XCTAssertEqual(try Data(contentsOf: sibling), siblingBytes); XCTAssertEqual(try inode(sibling), siblingInode)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testMalformedSourceFramesRefuseBeforeNativeCreationThenSameHostValidRequestCompletes() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let probe = try suffix("""
        ;(() => {
          const prepare=MindwtrHost.iosTaskDraftPrepareAvailability,read=MindwtrHost.menuRead,poll=MindwtrHost.poll,begin=MindwtrHost.attachmentDraftBeginV5;
          const probes=new Set();let captured=null,calls=0;
          MindwtrHost.iosTaskDraftPrepareAvailability=(raw,source)=>{captured=JSON.parse(raw);return prepare(raw,(metadata,bytes)=>{
            calls++;if(calls===1)return source(metadata,bytes+'\\n');
            if(calls===2)return source(metadata,'A'.repeat(11184816));
            if(calls===3)return source(' '.repeat(65537)+metadata,bytes);
            return source(metadata,bytes);
          });};
          MindwtrHost.menuRead=(name,raw)=>{if(name!=='dataSettings'||raw!=='{}')return read(name,raw);const id=begin(JSON.stringify({taskID:captured.taskID,payloadJSON:captured.beforePayloadJSON}));probes.add(id);return id;};
          MindwtrHost.poll=id=>{const raw=poll(id);if(!raw)return raw;if(!probes.delete(id))return raw;const result=JSON.parse(raw);if(result.ok)result.value={calls};return JSON.stringify(result);};
        })();
        """)
        let hooks = NativeAttachmentHostHooks(); var syncs = 0
        hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let live = host(probe); await live.configureAttachmentHost(hooks); _ = try await live.start()
        for attempt in 1...3 {
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request(UUID().uuidString.lowercased())) }
            let answer = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(answer["calls"] as? Int, attempt)
            XCTAssertEqual(remote.requests, attempt); XCTAssertEqual(syncs, 0, "Malformed frames must refuse before the native source creator")
            XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
            XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        }
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 4); XCTAssertEqual(syncs, 2)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
    }
    func testCancellationAfterNativeReceiptRetiresExactScratchBeforeNextRequest() async throws {
        try await seed(); let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let hooks = NativeAttachmentHostHooks(); var syncs = 0, cancelledAfterReceipt = false, observationFailed = false
        hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        var operation: Task<String, Error>?
        hooks.pump = {
            guard !cancelledAfterReceipt else { return }
            do {
                if syncs == 1, try self.files(self.cache).count == 1, try self.store.readAvailability()?.operations.count == 0 {
                    cancelledAfterReceipt = true; operation?.cancel()
                }
            } catch { observationFailed = true }
        }
        let live = host(try trackedPreparationBundle()); await live.configureAttachmentHost(hooks); _ = try await live.start()
        let requestJSON = try request(); operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: requestJSON) }
        await refusal { _ = try await XCTUnwrap(operation).value }
        XCTAssertFalse(observationFailed); XCTAssertTrue(cancelledAfterReceipt); XCTAssertEqual(syncs, 1); XCTAssertEqual(remote.requests, 1)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        hooks.pump = nil
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2); XCTAssertEqual(syncs, 3)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
    }
    func testNativeReadCapChecksOpenedDescriptorAndGrowthWithoutChangingOrdinaryLimit() throws {
        let files = try NativeAttachmentFiles(libraryRoot: root)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 9).write(to: target)
        let read = try json(["op": "readBytes", "uri": target.absoluteString]), digest = try json(["op": "sha256File", "uri": target.absoluteString])
        XCTAssertThrowsError(try files.call(read, maximumReadBytes: 8)); XCTAssertThrowsError(try files.call(digest, maximumReadBytes: 8))
        XCTAssertThrowsError(try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString, maximumReadBytes: 8))
        XCTAssertEqual(try files.call(read).bytes?.count, 9)
        try Data(repeating: 1, count: 8).write(to: target)
        files.afterSourceOpened = { let handle = try FileHandle(forWritingTo: self.target); defer { try? handle.close() }; try handle.seekToEnd(); try handle.write(contentsOf: Data([2])) }
        XCTAssertThrowsError(try files.call(read, maximumReadBytes: 8)); files.afterSourceOpened = nil
        XCTAssertEqual(try Data(contentsOf: target).count, 9)
    }

    // Synthetic roots model an actual container move on macOS. Hosted iOS
    // already has a real Application/<UUID>/Library anchor; real reinstall
    // acceptance uses the App fixture rather than nesting a second anchor.
    private func relocationRoot367(_ name: String) throws -> URL {
        #if os(iOS)
        throw XCTSkip("Synthetic relocation roots are macOS fixtures; actual iOS reinstall is separate acceptance")
        #else
        if relocationFixtureBase == nil { relocationFixtureBase = try XCTUnwrap(root) }
        let base = try XCTUnwrap(relocationFixtureBase).appendingPathComponent(name, isDirectory: true)
        let container = base.appendingPathComponent("Application/" + UUID().uuidString.lowercased(), isDirectory: true)
        root = container.appendingPathComponent("Library/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return container
        #endif
    }
    private func relocate367(_ original: URL, copy: Bool = false) throws {
        let next = original.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        let suffix = String(root.path.dropFirst(original.path.count))
        if copy { try FileManager.default.copyItem(at: original, to: next) }
        else { try FileManager.default.moveItem(at: original, to: next) }
        root = URL(fileURLWithPath: next.path + suffix, isDirectory: true)
    }
    private func relocatedMarkers367() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log, encoding: .utf8).components(separatedBy: "v1.3.5/ios-relocated-task-availability").count - 1
    }
    private func pendingWrapper367() throws -> [String: Any] {
        let command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(args.first))
    }
    private func terminalBody367() throws -> [String: Any] {
        let command = try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))
        let raw = try XCTUnwrap(((command["terminal"] as? [String: Any])?["success"] as? [String: Any])?["_0"] as? String)
        return try object(raw)
    }
    private func replaceSelected367(_ edit: (inout [String: Any]) -> Void) throws {
        var payload = try object(before.payloadJSON)
        var selected = try XCTUnwrap((payload["attachments"] as? [[String: Any]])?.first)
        edit(&selected)
        payload["attachments"] = [selected]; payload["attachmentsBase"] = [selected]
        _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([selected]), taskID])
        before = EditorDraftSnapshot(sessionID: before.sessionID, taskID: taskID, generation: before.generation + 1, payloadJSON: try json(payload))
        try editor.checkpoint(before)
    }
    private func assertRelocatedRefused367(_ live: CoreHost, file: StaticString = #filePath, line: UInt = #line) async throws {
        let saved = try rows(), settings = try Data(contentsOf: manifest), settingsIdentity = try inode(manifest)
        let checkpoint = try Data(contentsOf: editor.url), checkpointIdentity = try inode(editor.url)
        do {
            let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
            XCTAssertTrue(["unavailable", "generation-conflict"].contains(reply["status"] as? String ?? ""), file: file, line: line)
        } catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
        XCTAssertNil(try store.readVersioned(), file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
        XCTAssertEqual(try rows(), saved, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: manifest), settings, file: file, line: line)
        XCTAssertEqual(try inode(manifest), settingsIdentity, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint, file: file, line: line)
        XCTAssertEqual(try inode(editor.url), checkpointIdentity, file: file, line: line)
        XCTAssertEqual(remote.requests, 0, file: file, line: line)
        XCTAssertEqual(try relocatedMarkers367(), 0, file: file, line: line)
    }
    func testRelocatedSelfHostedTaskIncompleteTransitionRefusesBeforeFileProofLiveAndCold() async throws {
        let originalContainer = try relocationRoot367("cloud-incomplete")
        try await seed(backend: "cloud"); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        let old = target; try relocate367(originalContainer, copy: true)
        let oldBytes = Data("Unrelated retained old-container bytes".utf8); try oldBytes.write(to: old)
        var current = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        current["@mindwtr_sync_encryption_state_v1"] = try json(["state": "off", "incompleteTransition": "enable"])
        try Data(json(current).utf8).write(to: manifest)
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let oldIdentity = try inode(old), currentIdentity = try inode(target)
        for _ in 0..<2 {
            let hooks = NativeAttachmentHostHooks(); var fileWork = 0
            hooks.configureJobs = { $0.beforeWork = { _, _ in fileWork += 1 } }
            let live = host(); await live.configureAttachmentHost(hooks); _ = try await live.start(); let beforeWork = fileWork
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
            XCTAssertEqual(fileWork, beforeWork, "Incomplete selfhosted state refuses before the first local byte-proof job")
            XCTAssertEqual(remote.requests, 0); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertNil(try store.readVersioned()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
            XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
            XCTAssertEqual(try relocatedMarkers367(), 0)
            let log = root.appendingPathComponent("logs/mindwtr.log")
            if FileManager.default.fileExists(atPath: log.path) { XCTAssertFalse(try String(contentsOf: log, encoding: .utf8).contains("v1.3.5/ios-selfhosted-file-availability")) }
            await live.close()
        }
    }
    func testRelocatedTaskBorrowedDownloadKeepColdSaveLeavesOldBaselineUnmanaged() async throws {
        let container = try relocationRoot367("keep-save")
        try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        let old = target, oldURI = old.absoluteString
        try relocate367(container, copy: true)
        // The readable old file deliberately disagrees; success must use only
        // the selected current target and never consult or retire old bytes.
        let oldBytes = Data("Unrelated readable old-container bytes".utf8)
        try oldBytes.write(to: old)
        let oldIdentity = try inode(old), currentIdentity = try inode(target), saved = try rows()
        let settings = try Data(contentsOf: manifest), settingsIdentity = try inode(manifest)
        let other = try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='other'").utf8)))
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(reply["generation"] as? Int, 2)
        let op = try XCTUnwrap(store.readAvailability()?.operations.last)
        guard case .borrowed(let proof) = op.resource else { return XCTFail("Relocated current bytes must remain borrowed") }
        XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(op.targetURI, target.absoluteString)
        XCTAssertEqual(proof.identity, currentIdentity); XCTAssertEqual(proof.sha256, hash(bytes)); XCTAssertEqual(proof.size, Int64(bytes.count))
        let projected = try object(XCTUnwrap(editor.read()?.snapshot.payloadJSON))
        XCTAssertEqual((projected["edited"] as? [String: String])?["title"], "Dirty title")
        XCTAssertEqual((projected["edited"] as? [String: String])?["description"], "Kept dirty note / 文")
        XCTAssertEqual((projected["attachments"] as? [[String: Any]])?.first?["uri"] as? String, target.absoluteString)
        XCTAssertEqual((projected["attachmentsBase"] as? [[String: Any]])?.first?["uri"] as? String, oldURI)
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try inode(manifest), settingsIdentity)
        XCTAssertEqual(remote.requests, 0); XCTAssertEqual(try files(cache), [])
        await live.close(); XCTAssertEqual(try relocatedMarkers367(), 1)
        let cold = host(); _ = try await cold.start()
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        var journalReached = false, settledReached = false
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .afterSaveJournal { journalReached = true; throw HostFailure("Synthetic relocated Save journal boundary") } }
        await cold.configureAttachmentDraftHost(hooks)
        await refusal { _ = try await cold.saveAttachmentDraftComplete(saveRequestJSON: self.savedRequest(), expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation) }
        XCTAssertTrue(journalReached)
        let wrapper = try pendingWrapper367(); XCTAssertEqual(wrapper["version"] as? Int, 5)
        let candidates = try XCTUnwrap(wrapper["candidates"] as? [[String: Any]])
        let baseline = try XCTUnwrap(candidates.first { ($0["authority"] as? [String: Any])?["kind"] as? String == "baseline" })
        let observation = try XCTUnwrap((baseline["authority"] as? [String: Any])?["observation"] as? [String: String])
        XCTAssertEqual(observation, ["kind": "unmanaged", "targetURI": oldURI])
        hooks.boundary = { if $0 == .afterSaveSettled { settledReached = true; throw HostFailure("Synthetic relocated Save settled boundary") } }
        await refusal { _ = try await cold.retryPending() }; XCTAssertTrue(settledReached)
        let terminal = try terminalBody367()
        XCTAssertEqual((terminal["targets"] as? [[String: Any]])?.first?["outcome"] as? String, "unmanaged")
        await cold.configureAttachmentDraftHost(AttachmentDraftHostHooks()); _ = try await cold.retryPending()
        XCTAssertNil(try store.readVersioned()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let row = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT title,description,attachments,rev FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(row["title"] as? String, "Dirty title"); XCTAssertEqual(row["description"] as? String, "Kept dirty note / 文"); XCTAssertEqual(row["rev"] as? Int, 2)
        let attachment = try XCTUnwrap((NativeJSON.jsonObject(with: Data(XCTUnwrap(row["attachments"] as? String).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(attachment["uri"] as? String, target.absoluteString); XCTAssertEqual(attachment["localStatus"] as? String, "available")
        XCTAssertEqual(attachment["fileHash"] as? String, hash(bytes).uppercased())
        XCTAssertEqual(try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks WHERE id='other'").utf8))), other)
        XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try inode(manifest), settingsIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
        XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
        XCTAssertEqual(remote.requests, 0); await cold.close(); XCTAssertEqual(try relocatedMarkers367(), 1)
    }
    func testRelocatedTaskBorrowedDiscardRetainsCurrentBytesAfterContainerMove() async throws {
        let container = try relocationRoot367("discard")
        try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        let old = target; try relocate367(container)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        let saved = try rows(), settings = try Data(contentsOf: manifest), identity = try inode(target)
        let live = host(); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        guard case .borrowed = try XCTUnwrap(store.readAvailability()?.operations.last).resource else { return XCTFail("Borrowed-only repair") }
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot), id = UUID().uuidString.lowercased()
        _ = try await live.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": id, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]))
        XCTAssertEqual(try store.readAvailability()?.session.state, .cleanupPending)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        await live.close(); let cold = host(); _ = try await cold.start()
        let result = try object(await cold.finishAttachmentDraftDiscardV3(expectedSession: checkpoint.sessionID, requestId: id))
        XCTAssertEqual(result["version"] as? Int, 7)
        XCTAssertEqual((result["operations"] as? [[String: Any]])?.first?["target"] as? String, "notOwned")
        XCTAssertEqual((result["operations"] as? [[String: Any]])?.first?["stage"] as? String, "unclaimed")
        XCTAssertNil(try store.readVersioned()); XCTAssertNil(try editor.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path)); XCTAssertEqual(remote.requests, 0)
        await cold.close(); XCTAssertEqual(try relocatedMarkers367(), 1)
    }
    func testRelocatedTaskMissingHashSizeAndFilenameRefuseWithoutNetworkOrOwner() async throws {
        for name in ["missing", "hashless", "hash", "size", "filename"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            switch name {
            case "missing": try FileManager.default.removeItem(at: target)
            case "hashless": try replaceSelected367 { $0.removeValue(forKey: "fileHash") }
            case "hash": try replaceSelected367 { $0["fileHash"] = String(repeating: "0", count: 64) }
            case "size": try replaceSelected367 { $0["size"] = self.bytes.count + 1 }
            default: try replaceSelected367 { $0["cloudKey"] = "attachments/36300000-3333-4333-8333-333333333333.txt" }
            }
            let identity = name == "missing" ? nil : try inode(target)
            let live = host(); _ = try await live.start(); try await assertRelocatedRefused367(live)
            if let identity { XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes) }
            await live.close()
        }
    }

    func testRelocatedTaskCanonicalMappingRefusalsStopBeforeFileWork() async throws {
        for name in ["foreign", "noncanonical", "library", "extra-anchor", "query", "non-uuid", "uppercase-uuid"] {
            attachmentID = name == "non-uuid" ? "not-a-uuid" : name == "uppercase-uuid" ? "A1111111-B222-4333-8444-555555555555" : "36300000-1111-4111-8111-111111111111"
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            let oldURI = target.absoluteString, libraryName = root.lastPathComponent
            try relocate367(container)
            try replaceSelected367 { selected in
                switch name {
                case "foreign": selected["uri"] = oldURI.replacingOccurrences(of: "/Application/", with: "/Foreign/")
                case "noncanonical": selected["uri"] = oldURI.replacingOccurrences(of: attachmentID + ".txt", with: "%33" + String(attachmentID.dropFirst()) + ".txt")
                case "library": selected["uri"] = oldURI.replacingOccurrences(of: "/Library/" + libraryName + "/", with: "/Library/36300000-4444-4444-8444-444444444444/")
                case "extra-anchor": selected["uri"] = oldURI.replacingOccurrences(of: "/attachment-files/", with: "/Application/36300000-4444-4444-8444-444444444444/Library/attachment-files/")
                case "query": selected["uri"] = oldURI + "?unexpected=1"
                default: break // Valid metadata ID syntax, but not the selected relocation UUID grammar.
                }
            }
            let identity = try inode(target), hooks = NativeAttachmentHostHooks(); var work = 0
            hooks.configureJobs = { $0.beforeWork = { _, _ in work += 1 } }
            let live = host(); await live.configureAttachmentHost(hooks); _ = try await live.start()
            let initialWork = work
            try await assertRelocatedRefused367(live)
            XCTAssertEqual(work, initialWork, "Malformed mapping must refuse before observing any file")
            XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
            await live.close()
        }
    }
    func testRelocatedTaskAmbiguousCurrentAnchorCannotMintAvailabilityOwner() async throws {
        let outer = try relocationRoot367("ambiguous"), outerRoot = try XCTUnwrap(root)
        let inner = outerRoot.appendingPathComponent("Application/" + UUID().uuidString.lowercased(), isDirectory: true)
        root = inner.appendingPathComponent("Library/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        try relocate367(inner)
        let identity = try inode(target), live = host(); _ = try await live.start()
        try await assertRelocatedRefused367(live)
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertTrue(FileManager.default.fileExists(atPath: outer.path)); await live.close()
    }
    func testRelocatedTaskUnsafeEntriesAndEightMiBCapCannotBecomeBorrowed() async throws {
        for name in ["symlink", "hardlink", "directory", "cap"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            let outside = root.appendingPathComponent("unrelated.txt"); try bytes.write(to: outside)
            try FileManager.default.removeItem(at: target)
            switch name {
            case "symlink": try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside)
            case "hardlink": try FileManager.default.linkItem(at: outside, to: target)
            case "directory": try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            default:
                XCTAssertTrue(FileManager.default.createFile(atPath: target.path, contents: Data()))
                let handle = try FileHandle(forWritingTo: target); try handle.truncate(atOffset: 8_388_609); try handle.close()
                // Sparse file, streaming hash: every other proof condition agrees
                // so the selected descriptor cap itself is required to refuse.
                let reader = try FileHandle(forReadingFrom: target); var digest = SHA256()
                while let chunk = try reader.read(upToCount: 65_536), !chunk.isEmpty { digest.update(data: chunk) }
                try reader.close()
                let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
                try replaceSelected367 { $0["size"] = 8_388_609; $0["fileHash"] = hash }
            }
            let identity = try inode(target), outsideIdentity = try inode(outside)
            let live = host(); _ = try await live.start(); try await assertRelocatedRefused367(live)
            XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try inode(outside), outsideIdentity)
            XCTAssertEqual(try Data(contentsOf: outside), bytes)
            if name == "cap" { XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.intValue, 8_388_609) }
            await live.close()
        }
    }

    func testRelocatedTaskEntryAndParentReplacementAfterProofRefuseCheckpoint() async throws {
        for name in ["entry-race", "parent-race"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            let saved = try rows(), checkpoint = try Data(contentsOf: editor.url), checkpointIdentity = try inode(editor.url)
            let originalIdentity = try inode(target), hooks = NativeAttachmentHostHooks()
            var replacementIdentity: String?, displaced: URL?, mutationFailed = false
            hooks.configureJobs = { jobs in jobs.afterWork = { _, _ in
                guard replacementIdentity == nil && !mutationFailed else { return }
                do {
                    if name == "entry-race" {
                        try self.bytes.write(to: self.target, options: .atomic)
                    } else {
                        let old = self.root.appendingPathComponent("displaced-managed", isDirectory: true)
                        try FileManager.default.moveItem(at: self.managed, to: old); displaced = old
                        try FileManager.default.copyItem(at: old, to: self.managed)
                    }
                    replacementIdentity = try self.inode(self.target)
                } catch { mutationFailed = true }
            } }
            let live = host(); await live.configureAttachmentHost(hooks); _ = try await live.start()
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
            XCTAssertFalse(mutationFailed); XCTAssertNotNil(replacementIdentity); XCTAssertNotEqual(replacementIdentity, originalIdentity)
            // Admission may already have created an empty V5 owner; the changed
            // current generation must never become an availability operation.
            XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), checkpointIdentity)
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), replacementIdentity)
            if let displaced { XCTAssertEqual(try Data(contentsOf: displaced.appendingPathComponent(attachmentID + ".txt")), bytes) }
            XCTAssertEqual(remote.requests, 0); await live.close(); XCTAssertEqual(try relocatedMarkers367(), 0)
        }
    }
    func testRelocatedTaskRawRowAndSameByteEditorReplacementRefuseBeforeOwner() async throws {
        for name in ["row-race", "editor-race"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            let checkpoint = try Data(contentsOf: editor.url), initialEditorIdentity = try inode(editor.url), targetIdentity = try inode(target)
            let settings = try Data(contentsOf: manifest), hooks = NativeAttachmentHostHooks()
            var mutatedRows: String?, editorIdentity: String?, mutationFailed = false, hit = false
            hooks.configureJobs = { jobs in jobs.afterWork = { _, _ in
                guard !hit else { return }; hit = true
                do {
                    if name == "row-race" { _ = try self.sql("UPDATE tasks SET description='Intervening durable note',rev=2 WHERE id=?", [self.taskID]); mutatedRows = try self.rows() }
                    else { editorIdentity = try self.exactEditorReplacement(); mutatedRows = try self.rows() }
                } catch { mutationFailed = true }
            } }
            let live = host(); await live.configureAttachmentHost(hooks); _ = try await live.start()
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
            XCTAssertTrue(hit); XCTAssertFalse(mutationFailed); XCTAssertNil(try store.readVersioned())
            XCTAssertEqual(try rows(), mutatedRows); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
            XCTAssertEqual(try inode(editor.url), editorIdentity ?? initialEditorIdentity)
            XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try inode(target), targetIdentity); XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(remote.requests, 0); await live.close(); XCTAssertEqual(try relocatedMarkers367(), 0)
        }
    }
    func testRelocatedTaskSidecarReplacementAndFailedMarkerNeverEmitConfirmedDiagnostic() async throws {
        for name in ["sidecar-race", "marker-failure"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            let saved = try rows(), settings = try Data(contentsOf: manifest), targetIdentity = try inode(target)
            let hooks = AttachmentDraftHostHooks(); var hit = false, retainedBytes: Data?, retainedIdentity: String?
            hooks.boundary = { point in
                if name == "sidecar-race" && point == .afterIntent {
                    hit = true; retainedBytes = try Data(contentsOf: self.store.url)
                    let original = try self.inode(self.store.url)
                    try XCTUnwrap(retainedBytes).write(to: self.store.url, options: .atomic)
                    retainedIdentity = try self.inode(self.store.url)
                    XCTAssertNotEqual(original, retainedIdentity)
                } else if name == "marker-failure" && point == .beforeMarker {
                    hit = true; throw HostFailure("Synthetic unavailable checkpoint marker")
                }
            }
            let live = host(); _ = try await live.start(); await live.configureAttachmentDraftHost(hooks)
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
            XCTAssertTrue(hit)
            let op = try XCTUnwrap(store.readAvailability()?.operations.last)
            XCTAssertEqual(op.phase, name == "sidecar-race" ? .intent : .resultDurable)
            guard case .borrowed = op.resource else { return XCTFail("Failure may retain only the borrowed current proof") }
            if let retainedBytes, let retainedIdentity { XCTAssertEqual(try Data(contentsOf: store.url), retainedBytes); XCTAssertEqual(try inode(store.url), retainedIdentity) }
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), targetIdentity)
            XCTAssertEqual(remote.requests, 0); await live.close(); XCTAssertEqual(try relocatedMarkers367(), 0)
            if name == "marker-failure" {
                let cold = host(); _ = try await cold.start()
                let checkpoint = try XCTUnwrap(editor.read()?.snapshot)
                // A before-marker failure retains resultDurable while the
                // editor is already at after; explicit recovery settles that
                // owed transition before ordinary Resume validation.
                _ = try await cold.recoverAttachmentDraftV3(expectedSession: checkpoint.sessionID)
                XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
                XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), targetIdentity)
                await cold.close(); XCTAssertEqual(try relocatedMarkers367(), 0, "Cold replay uses ordinary Resume, not a new relocation admission marker")
            }
        }
    }
    func testRelocatedTaskCancellationAndCloseDrainAcceptedProofWithoutCheckpoint() async throws {
        for name in ["cancel", "cancel-close"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            try relocate367(container)
            let saved = try rows(), checkpoint = try Data(contentsOf: editor.url), identity = try inode(target)
            let accepted = expectation(description: "Relocated typed proof admitted on native file queue")
            let release = DispatchSemaphore(value: 0), hooks = NativeAttachmentHostHooks()
            var held = false, jobs: NativeAttachmentFileJobs?
            hooks.configureJobs = { value in jobs = value; value.beforeWork = { _, _ in
                guard !held else { return }; held = true; accepted.fulfill()
                guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Synthetic proof barrier timed out") }
            } }
            let live = host(); await live.configureAttachmentHost(hooks); _ = try await live.start()
            let raw = try request(), operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: raw) }
            await fulfillment(of: [accepted], timeout: 5); XCTAssertTrue(held); XCTAssertEqual(jobs?.counters.jobs, 1)
            operation.cancel()
            let closing: Task<Void, Never>? = name == "cancel-close" ? Task { await live.close() } : nil
            // The accepted proof still owns the library even after cancellation.
            let replacement = host(); await refusal { _ = try await replacement.start() }
            release.signal(); await refusal { _ = try await operation.value }
            if let closing { await closing.value } else { await live.close() }
            XCTAssertEqual(jobs?.counters.jobs, 0); XCTAssertEqual(jobs?.counters.bytes, 0)
            XCTAssertNil(try store.readVersioned()); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
            XCTAssertEqual(remote.requests, 0); XCTAssertEqual(try relocatedMarkers367(), 0)
            _ = try await replacement.start()
            let reply = try object(await replacement.downloadTaskAttachmentV5(requestJSON: request()))
            XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 0)
            await replacement.close(); XCTAssertEqual(try relocatedMarkers367(), 1)
        }
    }
    func testRelocatedTaskPreMoveV5AndMixedV4EvidenceCannotBeRebound() async throws {
        for name in ["pre-move-v5", "pre-move-v4"] {
            let container = try relocationRoot367(name)
            try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            let oldHost = host(); _ = try await oldHost.start()
            if name == "pre-move-v5" {
                let reply = try object(await oldHost.downloadTaskAttachmentV5(requestJSON: request()))
                XCTAssertEqual(reply["status"] as? String, "draftAvailable")
                before = try XCTUnwrap(editor.read()?.snapshot)
            } else { _ = try await oldHost.beginAttachmentDraftV4(expectedSession: before.sessionID, expectedGeneration: before.generation) }
            await oldHost.close(); try relocate367(container)
            let saved = try rows(), sidecar = try Data(contentsOf: store.url), sidecarIdentity = try inode(store.url)
            let checkpoint = try Data(contentsOf: editor.url), checkpointIdentity = try inode(editor.url), identity = try inode(target)
            let live = host(); _ = try await live.start()
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request(UUID().uuidString.lowercased())) }
            XCTAssertEqual(try Data(contentsOf: store.url), sidecar); XCTAssertEqual(try inode(store.url), sidecarIdentity)
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), checkpointIdentity)
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
            XCTAssertEqual(remote.requests, 0); await live.close(); XCTAssertEqual(try relocatedMarkers367(), 0)
        }
    }
    func testRelocatedTaskPendingOrdinaryCommandRefusesBeforeProofAndPreservesJournal() async throws {
        let container = try relocationRoot367("pending")
        try await seed(); try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
        try relocate367(container)
        let faults = HostIOFaults(), live = host(faults: faults); _ = try await live.start()
        let capture = try object(await live.call("captureOpen"))
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Synthetic pending Capture COMMIT") } }
        await refusal { _ = try await live.call("captureSubmit", argumentsJSON: self.json([self.json(["text": "Pending synthetic capture", "options": try XCTUnwrap(capture["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])) }
        let pendingBytes = try Data(contentsOf: journal), pendingIdentity = try inode(journal), saved = try rows()
        let checkpoint = try Data(contentsOf: editor.url), checkpointIdentity = try inode(editor.url), identity = try inode(target)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertEqual(try Data(contentsOf: journal), pendingBytes); XCTAssertEqual(try inode(journal), pendingIdentity)
        XCTAssertNil(try store.readVersioned()); XCTAssertEqual(try rows(), saved)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), checkpointIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        XCTAssertEqual(remote.requests, 0); await live.close(); XCTAssertEqual(try relocatedMarkers367(), 0)
    }

}
