import CryptoKit
import CloudKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore
@testable import CloudKitAttachmentErrorClassifier

private final class TaskDownloadCloudKitState: @unchecked Sendable {
    private let lock = NSLock()
    let provider: URL
    let recordName = "selected-cloudkit-record"
    let attachmentID: String
    var failure: Error?
    var hold = false
    var entered: (() -> Void)?
    var duringFetch: (() throws -> Void)?
    private var count = 0
    private var held: CKFetchRecordsOperation?
    var requests: Int { lock.lock(); defer { lock.unlock() }; return count }
    var heldOperation: CKFetchRecordsOperation? { lock.lock(); defer { lock.unlock() }; return held }
    init(provider: URL, attachmentID: String) { self.provider = provider; self.attachmentID = attachmentID }
    func schedule(_ operation: CKDatabaseOperation) {
        guard let fetch = operation as? CKFetchRecordsOperation, fetch.recordIDs?.count == 1,
              fetch.recordIDs?.first?.recordName == recordName else {
            XCTFail("Only the selected CloudKit asset fetch may enter the SDK")
            DispatchQueue.global().async {
                if let fetch = operation as? CKFetchRecordsOperation { fetch.fetchRecordsResultBlock?(.failure(CancellationError())) }
                else if let write = operation as? CKModifyRecordsOperation { write.modifyRecordsResultBlock?(.failure(CancellationError())) }
                else if let query = operation as? CKQueryOperation { query.queryResultBlock?(.failure(CancellationError())) }
                else if let zone = operation as? CKModifyRecordZonesOperation { zone.modifyRecordZonesResultBlock?(.failure(CancellationError())) }
            }
            return
        }
        lock.lock(); count += 1; let wait = hold, notify = entered; if wait { held = fetch }; lock.unlock()
        DispatchQueue.global().async { [self] in
            notify?()
            if !wait { finish(fetch) }
        }
    }
    func finishHeld() {
        lock.lock(); let operation = held; held = nil; lock.unlock()
        if let operation { finish(operation) }
    }
    private func finish(_ operation: CKFetchRecordsOperation) {
        do {
            try duringFetch?()
            if let failure { operation.fetchRecordsResultBlock?(.failure(failure)); return }
            guard let id = operation.recordIDs?.first else { throw CancellationError() }
            let record = CKRecord(recordType: "MindwtrAttachment", recordID: id)
            record["asset"] = CKAsset(fileURL: provider)
            for (name, value) in ["attachmentId": attachmentID, "ownerType": "task", "ownerId": "task363-download",
                                  "title": "Older asset metadata.bin", "updatedAt": "2025-01-01T00:00:00.000Z"] {
                record[name] = value as CKRecordValue
            }
            operation.perRecordResultBlock?(id, .success(record))
            operation.fetchRecordsResultBlock?(.success(()))
        } catch { operation.fetchRecordsResultBlock?(.failure(error)) }
    }
}


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
        if held { return }
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


        if !secureRead { faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : nil } }
        let value = CoreHost(databaseURL: database, bundleURL: selected ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func seed(backend: String = "webdav", originalURI: String? = nil, encrypted: Bool = false, cloudKey: String? = nil,
                      includeHash: Bool = true, debugLogging: Bool = false) async throws {
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
        let boot = host(); _ = try await boot.start()
        if debugLogging {
            _ = try await boot.call("dataSetting", argumentsJSON: json([json([
                "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
            ])]))
        }
        await boot.close()
        let at = "2026-10-05T12:00:00.000Z"
        var saved: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Remote source.txt",
            "uri": originalURI ?? target.absoluteString, "size": bytes.count, "mimeType": "text/plain", "createdAt": at, "updatedAt": at,
            "cloudKey": cloudKey ?? "attachments/" + attachmentID + ".txt", "fileHash": hash(bytes).uppercased(), "contentRev": 7, "localStatus": "missing"]
        if !includeHash { saved.removeValue(forKey: "fileHash") }
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
    private func cloudKitHost(_ state: TaskDownloadCloudKitState, faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        faults.selectedCloudKitBridge = { files, name in
            XCTAssertEqual(name, state.recordName)
            let manager = CloudKitSyncManager(containerIdentifier: "iCloud.synthetic.selected-download", zoneName: "SyntheticZone",
                operationScheduler: state.schedule)
            return NativeCloudKitBridge(transport: NativeCloudKitTransport(manager: manager), files: files, selectedRecordName: name)
        }
        return host(faults: faults)
    }
    private func seedCloudKit(_ source: Data? = nil, includeHash: Bool = true, originalURI: String? = nil,
                              debugLogging: Bool = false) async throws -> TaskDownloadCloudKitState {
        let provider = root.appendingPathComponent("sdk-selected-asset")
        try (source ?? bytes).write(to: provider)
        let state = TaskDownloadCloudKitState(provider: provider, attachmentID: attachmentID)
        try await seed(backend: "cloudkit", originalURI: originalURI, cloudKey: "cloudkit:" + state.recordName,
                       includeHash: includeHash, debugLogging: debugLogging)
        return state
    }
    private func cloudKitScratchNames() throws -> [String] {
        guard FileManager.default.fileExists(atPath: managed.path) else { return [] }
        return try files(managed).filter { $0.hasPrefix(".mindwtr-download-") && $0.hasSuffix(".staged") }
    }
    private func cloudKitOutcomes() throws -> [String] {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return [] }
        let text = try String(contentsOf: log, encoding: .utf8)
        XCTAssertFalse(text.contains("Dirty title")); XCTAssertFalse(text.contains("Kept dirty note"))
        XCTAssertFalse(text.contains("selected-cloudkit-record")); XCTAssertFalse(text.contains("sdk-selected-asset"))
        return try text.split(separator: "\n").compactMap { line in
            let entry = try object(String(line)), context = entry["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.8/ios-cloudkit-selected-download" else { return nil }
            XCTAssertEqual(Set(context?.keys.map { $0 } ?? []), Set(["releaseCheck", "operation", "outcome"]))
            XCTAssertEqual(context?["operation"], "cloudkit-task-availability")
            return context?["outcome"]
        }
    }
    func testCloudKitSelectedDownloadPreservesDirtyDraftAndColdSavePublishesOnce() async throws {
        let sdk = try await seedCloudKit(), original = try rows(), settings = try Data(contentsOf: manifest)
        let live = cloudKitHost(sdk); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(reply["generation"] as? Int, 2)
        XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(remote.requests, 0)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitScratchNames(), [])
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot), draft = try object(checkpoint.payloadJSON)
        let selected = try XCTUnwrap((draft["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(selected["title"] as? String, "Remote source.txt"); XCTAssertEqual(selected["mimeType"] as? String, "text/plain")
        XCTAssertEqual((draft["edited"] as? [String: Any])?["title"] as? String, "Dirty title")
        XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
        XCTAssertEqual(try cloudKitOutcomes(), ["confirmed"])
        _ = try await live.downloadTaskAttachmentV5(requestJSON: request())
        XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(try cloudKitOutcomes(), ["confirmed"])
        await live.close()
        let cold = host(); _ = try await cold.start()
        _ = try await cold.checkAttachmentDraftResumeV3(expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        _ = try await cold.saveAttachmentDraftComplete(saveRequestJSON: savedRequest(), expectedSession: checkpoint.sessionID, expectedGeneration: checkpoint.generation)
        let saved = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT title,description,rev FROM tasks WHERE id=?", [taskID]).utf8)) as? [[String: Any]])?.first)
        XCTAssertEqual(saved["title"] as? String, "Dirty title"); XCTAssertEqual(saved["description"] as? String, "Kept dirty note / 文")
        XCTAssertEqual(saved["rev"] as? Int, 2); XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read())
        XCTAssertEqual(sdk.requests, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testCloudKitSelectedCapturedIntentColdReplayAndDiscardNeedsNoSDK() async throws {
        let sdk = try await seedCloudKit(originalURI: ""), original = try rows(), settings = try Data(contentsOf: manifest)
        let live = cloudKitHost(sdk); _ = try await live.start()
        let hooks = AttachmentDraftHostHooks(); var stopped = false
        hooks.boundary = { if $0 == .afterIntent { stopped = true; throw HostFailure("Synthetic CloudKit intent interruption") } }
        await live.configureAttachmentDraftHost(hooks)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(stopped); XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .intent)
        XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(try files(cache).count, 1)
        guard case .owned(let source, _, _, _) = try XCTUnwrap(store.readAvailability()?.operations.last).resource,
              let sourceURL = URL(string: source.sourceURI) else { return XCTFail("Captured intent must retain its exact owned source") }
        let sourceIdentity = try inode(sourceURL), sourceNames = try files(cache)
        XCTAssertEqual(UUID(uuidString: sourceURL.lastPathComponent)?.uuidString.lowercased(), sourceURL.lastPathComponent)
        XCTAssertEqual(sourceNames, [sourceURL.lastPathComponent]); XCTAssertEqual(sourceIdentity, source.identity)
        XCTAssertEqual(source.sha256, hash(bytes)); XCTAssertEqual(try Data(contentsOf: sourceURL), bytes)
        XCTAssertEqual(try cloudKitScratchNames(), [])
        await live.close()
        let cold = host(); _ = try await cold.start()
        let reply = try object(await cold.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(sdk.requests, 1)
        let checkpoint = try XCTUnwrap(editor.read()?.snapshot), discard = UUID().uuidString.lowercased()
        _ = try await cold.discardAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": discard,
            "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]))
        _ = try await cold.finishAttachmentDraftDiscardV3(expectedSession: checkpoint.sessionID, requestId: discard)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: manifest), settings)
        // Cold replay keeps a conservative source proof; it cannot recreate the
        // original live creation receipt just to authorize cache retirement.
        XCTAssertEqual(try files(cache), sourceNames); XCTAssertEqual(try inode(sourceURL), sourceIdentity)
        XCTAssertEqual(try Data(contentsOf: sourceURL), bytes); XCTAssertEqual(hash(try Data(contentsOf: sourceURL)), source.sha256)
        XCTAssertEqual(remote.requests, 0); XCTAssertNil(try store.readAvailability()); XCTAssertNil(try editor.read())
    }
    private func assertCloudKitRefusal(_ code: CKError.Code, retry: Bool = false) async throws {
        let sdk = try await seedCloudKit(), original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        sdk.failure = NSError(domain: CKErrorDomain, code: code.rawValue)
        let live = cloudKitHost(sdk); _ = try await live.start()
        let input = try request(), reply = try object(await live.downloadTaskAttachmentV5(requestJSON: input))
        XCTAssertEqual(reply["status"] as? String, "unavailable"); XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(remote.requests, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitScratchNames(), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        XCTAssertEqual(try cloudKitOutcomes(), [])
        if retry {
            await live.close()
            let cold = cloudKitHost(sdk); _ = try await cold.start()
            XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(try rows(), original)
            XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
            XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
            sdk.failure = nil
            let retried = try object(await cold.downloadTaskAttachmentV5(requestJSON: input))
            XCTAssertEqual(retried["status"] as? String, "draftAvailable"); XCTAssertEqual(retried["generation"] as? Int, 2)
            XCTAssertEqual(sdk.requests, 2); XCTAssertEqual(remote.requests, 0)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
            XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
            XCTAssertEqual(try cloudKitOutcomes(), ["confirmed"])
        }
    }
    func testCloudKitSelectedMissingAssetPreservesCheckpointAndColdRetrySucceeds() async throws { try await assertCloudKitRefusal(.unknownItem, retry: true) }
    func testCloudKitSelectedTransientFailurePreservesCheckpoint() async throws { try await assertCloudKitRefusal(.networkFailure) }
    func testCloudKitSelectedNoAccountDoesNotFallback() async throws { try await assertCloudKitRefusal(.notAuthenticated) }
    private func assertCloudKitInvalidBytes(_ source: Data) async throws {
        let sdk = try await seedCloudKit(source), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let live = cloudKitHost(sdk), hooks = NativeAttachmentHostHooks(); var syncs = 0
        hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable"); XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(remote.requests, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitScratchNames(), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try cloudKitOutcomes(), [])
        if source.count > 8_388_608 { XCTAssertEqual(syncs, 0, "Actual provider cap refuses before copying into any cache output") }
    }
    func testCloudKitSelectedActualAssetOverEightMiBRefusesBeforeScratch() async throws {
        try await assertCloudKitInvalidBytes(Data(repeating: 7, count: 8_388_609))
    }
    func testCloudKitSelectedHashMismatchCannotMintPreparedSource() async throws {
        try await assertCloudKitInvalidBytes(Data("different remote generation".utf8))
    }
    func testCloudKitSelectedSameByteScratchReplacementIsNotAdoptedOrRetired() async throws {
        let sdk = try await seedCloudKit(), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let live = cloudKitHost(sdk), hooks = NativeAttachmentHostHooks()
        var replaced: URL?, replacementIdentity: String?
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in
            guard replaced == nil, FileManager.default.fileExists(atPath: self.managed.path),
                  let leaf = try self.files(self.managed).first(where: { $0.hasPrefix(".mindwtr-download-") && $0.hasSuffix(".staged") }) else { return }
            let stage = self.managed.appendingPathComponent(leaf), old = try self.inode(stage)
            try self.bytes.write(to: stage, options: .atomic)
            replacementIdentity = try self.inode(stage); XCTAssertNotEqual(old, replacementIdentity)
            replaced = stage
        } }
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable")
        let stage = try XCTUnwrap(replaced)
        XCTAssertEqual(try inode(stage), replacementIdentity); XCTAssertEqual(try Data(contentsOf: stage), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try cloudKitOutcomes(), [])
    }
    func testCloudKitSelectedPublishedScratchReplacementCannotGainCreationAuthority() async throws {
        let sdk = try await seedCloudKit(), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let live = cloudKitHost(sdk), hooks = NativeAttachmentHostHooks()
        var replacement: URL?, identity: String?
        hooks.configureJobs = { jobs in jobs.afterCloudKitStagePublished = {
            guard let leaf = try self.cloudKitScratchNames().first else { throw HostFailure("Published SDK scratch missing") }
            let stage = self.managed.appendingPathComponent(leaf), before = try self.inode(stage)
            try self.bytes.write(to: stage, options: .atomic)
            replacement = stage; identity = try self.inode(stage); XCTAssertNotEqual(before, identity)
        } }
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "unavailable")
        let foreign = try XCTUnwrap(replacement)
        XCTAssertEqual(try inode(foreign), identity); XCTAssertEqual(try Data(contentsOf: foreign), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try cloudKitOutcomes(), [])
    }
    func testCloudKitSelectedReadDescriptorRejectsSandwichSubstitutionWithoutExpectedAttachmentHash() async throws {
        let sdk = try await seedCloudKit(includeHash: false), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let live = cloudKitHost(sdk), hooks = NativeAttachmentHostHooks(), backup = root.appendingPathComponent("retained-original-scratch")
        var stage: URL?, substituted = false, restored = false
        hooks.configureJobs = { jobs in
            jobs.beforeCloudKitStageRead = { op in
                guard op == "readBytes", !substituted, let leaf = try self.cloudKitScratchNames().first else { return }
                let selected = self.managed.appendingPathComponent(leaf)
                try FileManager.default.moveItem(at: selected, to: backup)
                try Data(repeating: 42, count: self.bytes.count).write(to: selected)
                stage = selected; substituted = true
            }
            jobs.afterCloudKitStageRead = { op in
                guard op == "readBytes", let stage, FileManager.default.fileExists(atPath: backup.path) else { return }
                try FileManager.default.removeItem(at: stage)
                try FileManager.default.moveItem(at: backup, to: stage)
                restored = true
            }
        }
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertTrue(substituted); XCTAssertTrue(restored)
        XCTAssertEqual(reply["status"] as? String, "unavailable", "A path restored after IO cannot authorize the other descriptor's bytes")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try cloudKitOutcomes(), [])
    }
    func testCloudKitSelectedSameByteEditorReplacementDuringSDKFetchRefusesCheckpoint() async throws {
        let sdk = try await seedCloudKit(), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        var replacement: String?
        sdk.duringFetch = { replacement = try self.exactEditorReplacement() }
        let live = cloudKitHost(sdk); _ = try await live.start()
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertNotNil(replacement); XCTAssertEqual(try inode(editor.url), replacement)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try rows(), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitScratchNames(), []); XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        XCTAssertEqual(try cloudKitOutcomes(), []); XCTAssertEqual(remote.requests, 0)
    }
    func testCloudKitSelectedCancellationWaitsForSDKCallbackAndNextTurnIsFresh() async throws {
        let sdk = try await seedCloudKit(), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let entered = expectation(description: "Selected SDK callback held"), completed = TaskCloudKitLocked(false)
        sdk.hold = true; sdk.entered = { entered.fulfill() }
        let live = cloudKitHost(sdk); _ = try await live.start()
        let input = try request()
        let running = Task { defer { completed.set(true) }; return try await live.downloadTaskAttachmentV5(requestJSON: input) }
        defer { sdk.finishHeld() }
        await fulfillment(of: [entered], timeout: 3)
        let operation = try XCTUnwrap(sdk.heldOperation)
        running.cancel()
        for _ in 0..<100 where !operation.isCancelled { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(operation.isCancelled); XCTAssertFalse(completed.value, "Cancellation cannot release the library before the SDK callback")
        sdk.finishHeld()
        await refusal { _ = try await running.value }
        XCTAssertTrue(completed.value); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitOutcomes(), [])
        sdk.hold = false; sdk.entered = nil
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(sdk.requests, 2); XCTAssertEqual(remote.requests, 0)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    private func closeCancellationMarkers() throws -> [[String: String]] {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return [] }
        return try String(contentsOf: log, encoding: .utf8).split(separator: "\n").compactMap { line in
            let entry = try object(String(line)), context = entry["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.8/ios-close-cancellation-order" else { return nil }
            XCTAssertEqual(context, ["releaseCheck": "v1.3.8/ios-close-cancellation-order", "operation": "close", "outcome": "drained"])
            return context
        }
    }
    func testCloudKitSelectedCloseCancelsHeldSDKWithoutCallerCancellationAndDrainsBeforeUnlock() async throws {
        let sdk = try await seedCloudKit(debugLogging: true), original = try rows(), checkpoint = try Data(contentsOf: editor.url)
        let beforeMarkers = try closeCancellationMarkers().count
        let entered = expectation(description: "SDK held before selected close"), completed = TaskCloudKitLocked(false), closed = TaskCloudKitLocked(false)
        sdk.hold = true; sdk.entered = { entered.fulfill() }
        let live = cloudKitHost(sdk); _ = try await live.start()
        let input = try request()
        let running = Task { defer { completed.set(true) }; return try await live.downloadTaskAttachmentV5(requestJSON: input) }
        defer { sdk.finishHeld() }
        await fulfillment(of: [entered], timeout: 3)
        let operation = try XCTUnwrap(sdk.heldOperation)
        let closing = Task { await live.close(); closed.set(true) }
        for _ in 0..<200 where !operation.isCancelled { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(operation.isCancelled, "close itself must signal the SDK before awaiting the occupied Engine queue")
        XCTAssertFalse(completed.value); XCTAssertFalse(closed.value, "Library release must await the actual SDK callback")
        sdk.finishHeld()
        await refusal { _ = try await running.value }
        await closing.value
        XCTAssertTrue(completed.value); XCTAssertTrue(closed.value)
        XCTAssertEqual(sdk.requests, 1); XCTAssertEqual(remote.requests, 0)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try cloudKitScratchNames(), []); XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        XCTAssertEqual(try closeCancellationMarkers().count, beforeMarkers + 1)
        sdk.hold = false; sdk.entered = nil
        let cold = cloudKitHost(sdk); _ = try await cold.start()
        let reply = try object(await cold.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(sdk.requests, 2); XCTAssertEqual(remote.requests, 0)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original)
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
        let live = host(faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()

        let filter = try object(await live.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        let sameSelection = try json(XCTUnwrap(option["next"]))
        _ = try await live.call("setAreaFilter", argumentsJSON: json([sameSelection]))
        let options = try object(await live.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        let revision = try XCTUnwrap(options["revision"] as? String)
        let input = try json(["projectId": projectID, "attachmentId": attachmentID, "revision": revision])


        func projectRows() throws -> String {
            try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects ORDER BY id").utf8)))
        }
        let original = try rows(), projects = try projectRows(), settings = try Data(contentsOf: manifest)


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


            let fresh = try object(await live.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
            XCTAssertEqual(fresh["revision"] as? String, revision)
            _ = try await live.call("setAreaFilter", argumentsJSON: json([sameSelection]))
            try assertPreserved()
        }
        await live.close()
        let cold = host(faults: faults); try await cold.configureAttachmentHost(hooks); _ = try await cold.start()
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
    func test404PreservesCheckpointAndSameIdentityColdRetrySucceeds() async throws {
        try await seed(); remote.status = 404
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let live = host(); _ = try await live.start()
        let input = try request(), reply = try object(await live.downloadTaskAttachmentV5(requestJSON: input))
        XCTAssertEqual(reply["status"] as? String, "unavailable"); XCTAssertEqual(remote.requests, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        await live.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        remote.status = 200
        let retried = try object(await cold.downloadTaskAttachmentV5(requestJSON: input))
        XCTAssertEqual(retried["status"] as? String, "draftAvailable"); XCTAssertEqual(retried["generation"] as? Int, 2)
        XCTAssertEqual(remote.requests, 2); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
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
        let live = host(probe); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(probe); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(try trackedPreparationBundle(), faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(try trackedPreparationBundle(), faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(try trackedPreparationBundle(malformedTerminal: true)); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(try trackedPreparationBundle(), faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        remote.holdResponse = true; remote.duringGET = {
            if self.remote.requests == 1 { accepted.fulfill() }
        }
        let live = host(try trackedPreparationBundle(), faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let requestJSON = try request(), operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: requestJSON) }
        await fulfillment(of: [accepted], timeout: 5)
        XCTAssertEqual(http?.counters.jobs, 1); XCTAssertEqual(http?.counters.running, 1)
        let closing = Task { await live.close() }
        await refusal { _ = try await operation.value }
        await closing.value
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
        XCTAssertGreaterThan(reads.count, 2, "Material owner checks must repeat secure observations")
        XCTAssertTrue(reads.allSatisfy { $0 == "no-auth" }, "Both isolated accounts and repeated owner reads remain secure hits on their first alias")
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
        let live = host(probe); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
        let live = host(try trackedPreparationBundle()); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let requestJSON = try request(); operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: requestJSON) }
        await refusal { _ = try await XCTUnwrap(operation).value }
        XCTAssertFalse(observationFailed); XCTAssertTrue(cancelledAfterReceipt); XCTAssertEqual(syncs, 1); XCTAssertEqual(remote.requests, 1)
        let probe = try object(await live.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))); XCTAssertEqual(probe["pending"] as? Int, 0); XCTAssertEqual(probe["settled"] as? Int, 1)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint)
        XCTAssertEqual(try webdavTaskOutcomes417(), ["source-retired"])
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
            let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start(); let beforeWork = fileWork
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
                default: break
                }
            }
            let identity = try inode(target), hooks = NativeAttachmentHostHooks(); var work = 0
            hooks.configureJobs = { $0.beforeWork = { _, _ in work += 1 } }
            let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
            let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
            await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
            XCTAssertFalse(mutationFailed); XCTAssertNotNil(replacementIdentity); XCTAssertNotEqual(replacementIdentity, originalIdentity)


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
            let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
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
            let live = host(); try await live.configureAttachmentHost(hooks); _ = try await live.start()
            let raw = try request(), operation = Task { try await live.downloadTaskAttachmentV5(requestJSON: raw) }
            await fulfillment(of: [accepted], timeout: 5); XCTAssertTrue(held); XCTAssertEqual(jobs?.counters.jobs, 1)
            operation.cancel()
            let closing: Task<Void, Never>? = name == "cancel-close" ? Task { await live.close() } : nil

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

    func testNativeMaterialReadFailureAfterActualAESRefusesBeforeSourceAndFreshRequestCompletes() async throws {
        try await seed(encrypted: true)
        let faults = HostIOFaults()
        var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        faults.configureHTTPJobs = { http = $0 }; faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        var reject = false, flipped = false, postAESReads = 0, operations = [String](), sourceSyncs = 0
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected preparation cannot mutate secure storage"); return errSecInteractionNotAllowed }
            if reject { postAESReads += 1; return errSecNotAvailable }
            return errSecItemNotFound
        }
        faults.cryptoAfterOperation = { operation in
            operations.append(operation)
            if operation == "aesGcmOpen" && !flipped { flipped = true; reject = true }
        }
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { fileJobs = $0; $0.beforeStageSync = { sourceSyncs += 1 } }
        let live = host(faults: faults, secureRead: true)
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let checkpointIdentity = try inode(editor.url), ciphertext = remote.bytes
        var didRefuse = false
        do { _ = try await live.downloadTaskAttachmentV5(requestJSON: request()) }
        catch { didRefuse = true }
        XCTAssertTrue(flipped, "The fault must follow successful actual native AES, not substitute decryption")
        XCTAssertEqual(operations, ["aesGcmOpen"]); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(remote.bytes, ciphertext)
        XCTAssertGreaterThan(postAESReads, 0, "The selected owner must re-read native material after AES")
        XCTAssertTrue(didRefuse, "Loss of native material authority must refuse before plaintext source creation")
        XCTAssertEqual(sourceSyncs, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0, "An empty availability session may remain; no operation or checkpoint may advance")
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), checkpointIdentity)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0); XCTAssertEqual(secrets?.counters.jobs, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)


        guard didRefuse else { return }
        reject = false
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2)
        XCTAssertEqual(operations, ["aesGcmOpen", "aesGcmOpen"]); XCTAssertEqual(sourceSyncs, 2, "Only the valid successor syncs its source and installer stage")
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 1); XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
        XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    private func materialOutcomes415() throws -> [String] {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return [] }
        let text = try String(contentsOf: log, encoding: .utf8)
        XCTAssertFalse(text.contains(Data(count: 32).base64EncodedString()))
        XCTAssertFalse(text.contains("synthetic-cloud-token-401"))
        return try text.split(separator: "\n").compactMap { line in
            let entry = try object(String(line)), context = entry["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.5/ios-task-download-material" else { return nil }
            XCTAssertEqual(Set(context?.keys.map { $0 } ?? []), Set(["releaseCheck", "operation", "outcome"]))
            XCTAssertEqual(context?["operation"], "task-download-material")
            return context?["outcome"]
        }
    }
    private func webdavTaskOutcomes417() throws -> [String] {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return [] }
        let text = try String(contentsOf: log, encoding: .utf8)
        XCTAssertFalse(text.contains("fixture-only")); XCTAssertFalse(text.contains(Data(count: 32).base64EncodedString()))
        return try text.split(separator: "\n").compactMap { line in
            let entry = try object(String(line)), context = entry["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.5/ios-webdav-task-availability" else { return nil }
            XCTAssertEqual(Set(context?.keys.map { $0 } ?? []), Set(["releaseCheck", "operation", "outcome"]))
            XCTAssertEqual(context?["operation"], "webdav-task-availability")
            XCTAssertTrue(["confirmed", "source-retired"].contains(context?["outcome"] ?? ""))
            return context?["outcome"]
        }
    }
    func testEncryptedSelfHostedTaskAcceptsSharedFormattedMaterialAndEmitsBoundedDiagnostic() async throws {
        try await seed(backend: "cloud", encrypted: true)
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))

        settings["@mindwtr_sync_encryption_key_v1"] = "\n!" + String(Data(count: 32).base64EncodedString().dropLast()) + " \n"
        try Data(json(settings).utf8).write(to: manifest)
        let faults = HostIOFaults(); var operations = [String](), readsAfterAES = 0, opened = false
        faults.cryptoAfterOperation = { operations.append($0); if $0 == "aesGcmOpen" { opened = true } }
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected download cannot mutate secrets"); return errSecInteractionNotAllowed }
            if opened { readsAfterAES += 1 }; return errSecItemNotFound
        }
        let live = host(faults: faults, secureRead: true); _ = try await live.start()
        let original = try rows(), configuration = try Data(contentsOf: manifest), wire = remote.bytes
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(operations, ["aesGcmOpen"])
        XCTAssertGreaterThan(readsAfterAES, 0); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(remote.unexpected, 0)
        XCTAssertEqual(remote.bytes, wire); XCTAssertNotEqual(wire, bytes); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
        XCTAssertEqual(try materialOutcomes415(), ["decrypted"]); XCTAssertEqual(try files(cache), [])
    }
    func testAESRequestWithDifferentValidKeyRefusesBeforeNativeCryptoOrSource() async throws {
        try await seed(encrypted: true)
        let other = Data(repeating: 1, count: 32)
        var header = Data("MWENC1".utf8); header.append(contentsOf: [1,1,64,0,0,0,1,0,0,0,1,1])
        header.append(Data(count: 16)); header.append(Data(count: 12))
        var length = UInt64(bytes.count + 16).littleEndian
        withUnsafeBytes(of: &length) { header.append(contentsOf: $0) }
        let box = try AES.GCM.seal(bytes, using: SymmetricKey(data: other), nonce: AES.GCM.Nonce(data: Data(count: 12)), authenticating: header)
        remote.bytes = header + box.ciphertext + box.tag
        let selected = try suffix("""
        ;(() => { const native=__mindwtrNative,call=native.cryptoCall;
          native.cryptoCall=raw=>{const request=JSON.parse(raw);if(request.op==='aesGcmOpen')request.key='\(other.base64EncodedString())';return call(JSON.stringify(request));};
        })();
        """)
        let faults = HostIOFaults(); var attempts = [String](), syncs = 0
        faults.cryptoBeforeOperation = { attempts.append($0) }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let live = host(selected, faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), configuration = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)


        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(Set(reply.keys), Set(["version", "status", "requestId", "sessionID", "generation", "attachmentId"]))
        XCTAssertEqual(reply["version"] as? Int, 1); XCTAssertEqual(reply["status"] as? String, "unavailable")
        XCTAssertEqual(reply["requestId"] as? String, requestID); XCTAssertEqual(reply["sessionID"] as? String, before.sessionID)
        XCTAssertEqual(reply["generation"] as? Int, before.generation); XCTAssertEqual(reply["attachmentId"] as? String, attachmentID)
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(attempts, [], "A valid but unobserved key never reaches native AES")
        XCTAssertEqual(syncs, 0); XCTAssertEqual(try files(cache), []); XCTAssertEqual(try materialOutcomes415(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
    }
    func testExactLegacyMaterialChangeAfterAESRefusesDespiteEqualDecodedBytes() async throws {
        try await seed(encrypted: true)
        let faults = HostIOFaults(); var opened = false, syncs = 0, externallyWritten: Data?
        faults.cryptoAfterOperation = { operation in
            guard operation == "aesGcmOpen" else { return }; opened = true
            do {
                var settings = try self.object(String(decoding: Data(contentsOf: self.manifest), as: UTF8.self))
                settings["@mindwtr_sync_encryption_key_v1"] = "\n" + Data(count: 32).base64EncodedString()
                let value = Data(try self.json(settings).utf8); try value.write(to: self.manifest, options: .atomic); externallyWritten = value
            } catch { XCTFail("Synthetic legacy edit failed") }
        }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let live = host(faults: faults); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(opened); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(syncs, 0)
        XCTAssertEqual(try Data(contentsOf: manifest), try XCTUnwrap(externallyWritten)); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try materialOutcomes415(), [])


    }
    func testNativeMaterialRevocationAfterSourceRetiresOnlyExactUnadoptedReceipt() async throws {
        try await seed(encrypted: true)
        let faults = HostIOFaults(); var reject = false, revoked = false, readFailures = 0, syncs = 0, opened = 0
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected download cannot mutate secrets"); return errSecInteractionNotAllowed }
            return errSecItemNotFound
        }
        faults.configureSecretJobs = { jobs in
            jobs.beforeRead = { account in
                if reject && account == "mindwtr_sync_encryption_key_v1" {
                    readFailures += 1; throw HostFailure("Synthetic material read is unavailable")
                }
            }
        }
        faults.cryptoAfterOperation = { if $0 == "aesGcmOpen" { opened += 1 } }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let boundary = AttachmentDraftHostHooks()
        boundary.boundary = { if $0 == .beforeIntent && !revoked { revoked = true; reject = true } }
        let live = host(faults: faults, secureRead: true); try await live.configureAttachmentHost(hooks)
        await live.configureAttachmentDraftHost(boundary); _ = try await live.start()
        let foreign = cache.appendingPathComponent("foreign-415.txt"), foreignBytes = Data("Foreign cache bytes / 文".utf8)
        try foreignBytes.write(to: foreign); let foreignIdentity = try inode(foreign)
        let original = try rows(), configuration = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(revoked); XCTAssertGreaterThan(readFailures, 0); XCTAssertEqual(opened, 1); XCTAssertEqual(syncs, 1)
        XCTAssertEqual(try files(cache), [foreign.lastPathComponent]); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), foreignIdentity)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
        XCTAssertEqual(try materialOutcomes415(), ["decrypted"], "Authenticated preparation is distinct from checkpoint admission")
        XCTAssertEqual(try webdavTaskOutcomes417(), ["source-retired"])
        reject = false
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(opened, 2); XCTAssertEqual(syncs, 3); XCTAssertEqual(remote.requests, 2)
        XCTAssertEqual(try files(cache), [foreign.lastPathComponent]); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), foreignIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        await live.close(); let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try files(cache), [foreign.lastPathComponent]); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(remote.requests, 2)
    }
    func testNativePasswordRevocationAfterSourceRetainsExactScratchAndForeignFileThroughColdRetry() async throws {
        try await seed(encrypted: true)
        let faults = HostIOFaults(); var reject = false, revoked = false, readFailures = 0, syncs = 0, opened = 0
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected download cannot mutate secrets"); return errSecInteractionNotAllowed }
            return errSecItemNotFound
        }
        faults.configureSecretJobs = { jobs in
            jobs.beforeRead = { account in
                if reject && account == "mindwtr_webdav_password" {
                    readFailures += 1; throw HostFailure("Synthetic credential read is unavailable")
                }
            }
        }
        faults.cryptoAfterOperation = { if $0 == "aesGcmOpen" { opened += 1 } }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let boundary = AttachmentDraftHostHooks()
        boundary.boundary = { if $0 == .beforeIntent && !revoked { revoked = true; reject = true } }
        let live = host(faults: faults, secureRead: true); try await live.configureAttachmentHost(hooks)
        await live.configureAttachmentDraftHost(boundary); _ = try await live.start()
        let foreign = cache.appendingPathComponent("foreign-417.txt"), foreignBytes = Data("Foreign cache bytes / 文".utf8)
        try foreignBytes.write(to: foreign); let foreignIdentity = try inode(foreign)
        let original = try rows(), configuration = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(revoked); XCTAssertGreaterThan(readFailures, 0); XCTAssertEqual(opened, 1); XCTAssertEqual(syncs, 1)
        let retained = try files(cache), candidates = retained.filter { $0 != foreign.lastPathComponent }
        XCTAssertEqual(candidates.count, 1)
        let name = try XCTUnwrap(candidates.first), source = cache.appendingPathComponent(name)
        XCTAssertEqual(UUID(uuidString: name)?.uuidString.lowercased(), name)
        let sourceIdentity = try inode(source)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), foreignIdentity)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows(), original)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
        XCTAssertEqual(try materialOutcomes415(), ["decrypted"])
        XCTAssertEqual(try webdavTaskOutcomes417(), [], "Credential loss cannot authorize source retirement or checkpoint")
        reject = false
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(opened, 2); XCTAssertEqual(syncs, 3); XCTAssertEqual(remote.requests, 2)
        XCTAssertEqual(try files(cache), retained); XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try inode(source), sourceIdentity)
        XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), foreignIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        await live.close(); let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try files(cache), retained); XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try inode(source), sourceIdentity)
        XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), foreignIdentity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(remote.requests, 2)
    }
    func testEncryptedFilledProofRetainsSourceOnRevocationAndColdReplayNeedsNoMaterialOrGET() async throws {
        try await seed(encrypted: true)
        let faults = HostIOFaults(); var reject = false, filled = false, opened = 0, readFailures = 0
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected download cannot mutate secrets"); return errSecInteractionNotAllowed }
            if reject { readFailures += 1; return errSecNotAvailable }; return errSecItemNotFound
        }
        faults.cryptoAfterOperation = { if $0 == "aesGcmOpen" { opened += 1 } }
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == .afterFilled && !filled { filled = true; reject = true } }
        let live = host(faults: faults, secureRead: true); _ = try await live.start(); await live.configureAttachmentDraftHost(hooks)
        let original = try rows(), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(filled); XCTAssertGreaterThan(readFailures, 0); XCTAssertEqual(opened, 1); XCTAssertEqual(remote.requests, 1)
        let operation = try XCTUnwrap(store.readAvailability()?.operations.last); XCTAssertEqual(operation.phase, .stageFilled)
        guard case .owned(let source, _, let proof?, _) = operation.resource else { return XCTFail("Exact adopted plaintext proof must remain recoverable") }
        let sourceURL = try XCTUnwrap(URL(string: source.sourceURI)), sourceIdentity = try inode(sourceURL)
        XCTAssertEqual(try Data(contentsOf: sourceURL), bytes); XCTAssertEqual(source.sha256, hash(bytes)); XCTAssertEqual(proof.size, Int64(bytes.count))
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity); XCTAssertEqual(try rows(), original)
        let retained = try String(contentsOf: store.url, encoding: .utf8)
        XCTAssertFalse(retained.contains(Data(count: 32).base64EncodedString())); XCTAssertFalse(retained.contains("fixture-only"))
        await live.close()
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)); settings.removeValue(forKey: "@mindwtr_sync_encryption_key_v1")
        try Data(json(settings).utf8).write(to: manifest)
        let freshSettings = try Data(contentsOf: manifest), coldFaults = HostIOFaults(); var coldAES = 0
        coldFaults.cryptoAfterOperation = { if $0 == "aesGcmOpen" { coldAES += 1 } }
        let cold = host(faults: coldFaults); _ = try await cold.start()
        let reply = try object(await cold.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(coldAES, 0)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), freshSettings)
        XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)


        if FileManager.default.fileExists(atPath: sourceURL.path) { XCTAssertEqual(try inode(sourceURL), sourceIdentity) }
    }

    func testPhysicalSecureMaterialValueChangeAfterAESRefusesBeforeSource() async throws {
        #if os(iOS)
        try await seed(encrypted: true)
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        settings.removeValue(forKey: "@mindwtr_sync_encryption_key_v1"); try Data(json(settings).utf8).write(to: manifest)
        let faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretService = service
        let account = Data("mindwtr_sync_encryption_key_v1".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        defer { let status = SecItemDelete(query as CFDictionary); XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound) }
        var input = query; input[kSecValueData as String] = Data(Data(count: 32).base64EncodedString().utf8)
        input[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
        var changed = false, opened = 0, syncs = 0
        faults.cryptoAfterOperation = { operation in
            guard operation == "aesGcmOpen" else { return }; opened += 1
            let replacement = Data(Data(repeating: 1, count: 32).base64EncodedString().utf8)
            XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: replacement] as CFDictionary), errSecSuccess); changed = true
        }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let live = host(faults: faults, secureRead: true); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), configuration = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        await refusal { _ = try await live.downloadTaskAttachmentV5(requestJSON: self.request()) }
        XCTAssertTrue(changed); XCTAssertEqual(opened, 1); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(syncs, 0)
        XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try materialOutcomes415(), [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
        #else
        throw XCTSkip("Actual isolated Keychain value changes are iOS-only; macOS exercises secure read failures")
        #endif
    }

    func testWebDAVNativePasswordReadFailureAfterActualGETRefusesBeforeSourceAndFreshRequestCompletes() async throws {
        try await seed()
        let faults = HostIOFaults()
        var http: NativeHTTPJobs?, secrets: NativeSecretJobs?, crypto: NativeCryptoJobs?, fileJobs: NativeAttachmentFileJobs?
        var reject = false, completions = 0, preGETReads = 0, postGETReads = 0
        var sourceSyncs = 0, installerWork = 0, cryptoOperations = [String]()
        faults.configureHTTPJobs = { jobs in
            http = jobs
            jobs.beforeCompletion = { completions += 1; reject = true }
        }
        faults.configureSecretJobs = { secrets = $0 }; faults.configureCryptoJobs = { crypto = $0 }
        faults.secretStatus = { operation, _ in
            guard operation == "get" else { XCTFail("Selected preparation cannot mutate secure storage"); return errSecInteractionNotAllowed }
            if reject { postGETReads += 1; return errSecNotAvailable }
            preGETReads += 1; return errSecItemNotFound
        }
        faults.cryptoAfterOperation = { cryptoOperations.append($0) }
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in
            fileJobs = jobs; jobs.beforeStageSync = { sourceSyncs += 1 }
            jobs.beforeWork = { _, installer in if installer { installerWork += 1 } }
        }
        let live = host(faults: faults, secureRead: true)
        try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), settings = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url)
        let checkpointIdentity = try inode(editor.url), wire = remote.bytes
        let initialSyncs = sourceSyncs, initialInstallerWork = installerWork, initialReads = preGETReads
        var didRefuse = false, reply: String?
        do { reply = try await live.downloadTaskAttachmentV5(requestJSON: request()) }
        catch { didRefuse = true; XCTAssertFalse(error.localizedDescription.contains("file:///")) }
        if let reply {
            let value = try object(reply)
            XCTAssertEqual(Set(value.keys), Set(["version", "status", "requestId", "sessionID", "generation", "attachmentId"]))
            XCTAssertEqual(value["version"] as? Int, 1); XCTAssertEqual(value["status"] as? String, "unavailable")
            XCTAssertEqual(value["requestId"] as? String, requestID); XCTAssertEqual(value["sessionID"] as? String, before.sessionID)
            XCTAssertEqual(value["generation"] as? Int, before.generation); XCTAssertEqual(value["attachmentId"] as? String, attachmentID)
            didRefuse = value["status"] as? String == "unavailable"
        }
        XCTAssertEqual(remote.requests, 1); XCTAssertEqual(remote.unexpected, 0); XCTAssertEqual(completions, 1)
        XCTAssertEqual(wire, bytes); XCTAssertEqual(remote.bytes, wire, "The actual authenticated GET returns unchanged plaintext")
        XCTAssertGreaterThan(preGETReads, initialReads, "True-nil native password reads must precede the legacy-authenticated GET")
        XCTAssertGreaterThan(postGETReads, 0, "The selected owner must re-read native WebDAV authority after HTTP completion")
        XCTAssertTrue(didRefuse, "Loss of native WebDAV password authority must refuse before plaintext source creation")
        XCTAssertEqual(sourceSyncs, initialSyncs); XCTAssertEqual(installerWork, initialInstallerWork); XCTAssertEqual(cryptoOperations, [])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), checkpointIdentity)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0, "An empty session may remain; no operation or checkpoint may advance")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try files(cache), [])
        if FileManager.default.fileExists(atPath: managed.path) { XCTAssertEqual(try files(managed), []) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0)
        XCTAssertEqual(secrets?.counters.jobs, 0); XCTAssertEqual(secrets?.counters.running, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)


        guard didRefuse else { return }
        reject = false; http?.beforeCompletion = { completions += 1 }
        let successor = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(successor["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2); XCTAssertEqual(completions, 2)
        XCTAssertEqual(sourceSyncs, initialSyncs + 2, "Only the admitted successor syncs its plaintext source and installer stage")
        XCTAssertGreaterThan(installerWork, initialInstallerWork, "The same pre-start installer hook must witness successful installation")
        XCTAssertEqual(cryptoOperations, []); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 1); XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
        XCTAssertEqual(try files(cache), []); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0)
        XCTAssertEqual(secrets?.counters.jobs, 0); XCTAssertEqual(secrets?.counters.running, 0)
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        XCTAssertEqual(fileJobs?.counters.jobs, 0); XCTAssertEqual(fileJobs?.counters.bytes, 0)
    }

    func testPhysicalWebDAVSecurePasswordValueChangeAfterGETRefusesThenFreshCheckpointUsesCurrentAuthority() async throws {
        #if os(iOS)
        try await seed()
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        settings.removeValue(forKey: "@mindwtr_webdav_password"); try Data(json(settings).utf8).write(to: manifest)
        let faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretService = service
        let account = Data("mindwtr_webdav_password".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var item = query; item[kSecValueData as String] = Data("fixture-only".utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        defer { let status = SecItemDelete(query as CFDictionary); XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound) }
        var changed = false, changeStatus = errSecSuccess, syncs = 0
        remote.duringGET = {
            changeStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data("synthetic-replaced-417".utf8)] as CFDictionary); changed = true
        }
        let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { $0.beforeStageSync = { syncs += 1 } }
        let live = host(faults: faults, secureRead: true); try await live.configureAttachmentHost(hooks); _ = try await live.start()
        let original = try rows(), configuration = try Data(contentsOf: manifest), checkpoint = try Data(contentsOf: editor.url), identity = try inode(editor.url)
        do {
            let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
            XCTAssertEqual(Set(reply.keys), Set(["version", "status", "requestId", "sessionID", "generation", "attachmentId"]))
            XCTAssertEqual(reply["version"] as? Int, 1); XCTAssertEqual(reply["status"] as? String, "unavailable")
            XCTAssertEqual(reply["requestId"] as? String, requestID); XCTAssertEqual(reply["sessionID"] as? String, before.sessionID)
            XCTAssertEqual(reply["generation"] as? Int, before.generation); XCTAssertEqual(reply["attachmentId"] as? String, attachmentID)
        } catch { }
        XCTAssertTrue(changed); XCTAssertEqual(changeStatus, errSecSuccess); XCTAssertEqual(remote.requests, 1); XCTAssertEqual(syncs, 0)
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try inode(editor.url), identity)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 0); XCTAssertEqual(try files(cache), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let log = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: log.path) { XCTAssertFalse(try String(contentsOf: log, encoding: .utf8).contains("v1.3.5/ios-webdav-task-availability")) }
        remote.duringGET = nil
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data("fixture-only".utf8)] as CFDictionary), errSecSuccess)
        let result = try object(await live.downloadTaskAttachmentV5(requestJSON: request(UUID().uuidString.lowercased())))
        XCTAssertEqual(result["status"] as? String, "draftAvailable"); XCTAssertEqual(remote.requests, 2)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), original); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try store.readAvailability()?.operations.count, 1); XCTAssertEqual(try store.readAvailability()?.operations.last?.phase, .checkpointed)
        let entries = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map { try object(String($0)) }
        let markers = entries.compactMap { $0["context"] as? [String: String] }.filter { $0["releaseCheck"] == "v1.3.5/ios-webdav-task-availability" }
        XCTAssertEqual(markers.count, 1); XCTAssertEqual(markers.first, ["releaseCheck": "v1.3.5/ios-webdav-task-availability", "operation": "webdav-task-availability", "outcome": "confirmed"])
        #else
        throw XCTSkip("Actual isolated WebDAV password value changes require iOS; macOS exercises true-nil secure reads and post-GET read refusal")
        #endif
    }

}

private final class TaskCloudKitLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func set(_ value: Value) { lock.lock(); stored = value; lock.unlock() }
}


extension NativeTaskAttachmentDownloadTests {
    func testDropboxSelectedTaskRefreshPreservesDirtyDraftAndUsesOnlyFixedProviderRequests() async throws {
        try await seed(backend: "cloud")
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        settings["@mindwtr_cloud_provider"] = "dropbox"
        settings.removeValue(forKey: "@mindwtr_cloud_url"); settings.removeValue(forKey: "@mindwtr_cloud_allow_insecure_http")
        settings["@mindwtr_dropbox_tokens"] = try json(["accessToken": "expired-synthetic", "refreshToken": "controlled-refresh", "expiresAt": 0])
        try Data(json(settings).utf8).write(to: manifest, options: .atomic)
        let fixture = NativeDropboxSelectedHTTPFixture(path: "/attachments/" + attachmentID + ".txt", bytes: bytes), faults = HostIOFaults()
        fixture.configure(faults)
        let live = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace), dropboxAuthorization: try NativeDropboxSelectedHTTPFixture.binding())
        addTeardownBlock { await live.close() }
        _ = try await live.start()
        let original = try rows()
        let reply = try object(await live.downloadTaskAttachmentV5(requestJSON: request()))
        XCTAssertEqual(reply["status"] as? String, "draftAvailable")
        XCTAssertEqual(fixture.counts, [1, 1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try rows(), original, "Selected Task availability must preserve the saved row and dirty edit ownership")
        let draft = try XCTUnwrap(editor.readOwnedCheckpoint())
        XCTAssertTrue(draft.snapshot.payloadJSON.contains("Dirty title")); XCTAssertTrue(draft.snapshot.payloadJSON.contains("Kept dirty note"))
        let after = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        settings.removeValue(forKey: "@mindwtr_dropbox_tokens")
        XCTAssertEqual(try json(after), try json(settings), "Only fixed legacy-token evacuation may change device configuration")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await live.close()
    }
}
