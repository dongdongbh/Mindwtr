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
            && request.value(forHTTPHeaderField: "Authorization") == "Basic " + Data("synthetic:fixture-only".utf8).base64EncodedString()
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
    private let taskID = "task363-download"
    private let attachmentID = "36300000-1111-4111-8111-111111111111"
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
}
