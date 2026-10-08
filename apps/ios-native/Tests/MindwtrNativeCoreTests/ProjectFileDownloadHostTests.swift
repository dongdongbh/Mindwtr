import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ProjectDownloadHTTPState: @unchecked Sendable {
    let lock = NSLock()
    var bytes = Data(), status = 200
    var expectedAuthorization = "Bearer synthetic-token-405"
    var duringGET: (() -> Void)?
    private var requests = 0, unexpected = 0
    func reply(_ request: URLRequest) -> Data? {
        lock.lock()
        requests += 1
        guard request.httpMethod == "GET", request.url?.path == "/v1/attachments/40500000-1111-4111-8111-111111111111.txt",
              request.value(forHTTPHeaderField: "Authorization") == expectedAuthorization, request.httpBody == nil else { unexpected += 1; lock.unlock(); return nil }
        let value = bytes, callback = duringGET
        lock.unlock(); callback?(); return value
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [requests, unexpected] }
}
private final class ProjectDownloadHTTPProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var states: [String: ProjectDownloadHTTPState] = [:]
    private static var unknown = 0
    static func set(_ host: String, _ state: ProjectDownloadHTTPState?) { lock.lock(); states[host] = state; lock.unlock() }
    static var unexpected: Int { lock.lock(); defer { lock.unlock() }; return unknown }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.states[request.url?.host ?? ""]
        if state == nil { Self.unknown += 1 }; Self.lock.unlock()
        guard let state, let bytes = state.reply(request), let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: state.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(bytes.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Real native JSC/Bearer/source/publication/SQLite boundaries, with synthetic credentials only.
final class ProjectFileDownloadHostTests: XCTestCase {
    private var fixtureRoot: URL!
    private var root: URL!, bundle: URL!, hostname: String!, namespace: String!, remote: ProjectDownloadHTTPState!
    private var unknownBefore = 0
    private let projectID = "project-download-405", attachmentID = "40500000-1111-4111-8111-111111111111"
    private let at = "2026-10-07T12:00:00.000Z", bytes = Data([0, 255, 128, 7]) + Data("Project download / 文\n".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private enum Injected: Error { case boundary }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Set actual iOS MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = base.appendingPathComponent("ProjectFileDownloadHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        fixtureRoot = root
        hostname = "project405-" + UUID().uuidString.lowercased() + ".invalid"
        namespace = "tech.dongdongbh.mindwtr.project405." + UUID().uuidString.lowercased()
        remote = ProjectDownloadHTTPState(); remote.bytes = bytes
        unknownBefore = ProjectDownloadHTTPProtocol.unexpected; ProjectDownloadHTTPProtocol.set(hostname, remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(remote?.counts[1], 0); XCTAssertEqual(ProjectDownloadHTTPProtocol.unexpected, unknownBefore)
        if let hostname { ProjectDownloadHTTPProtocol.set(hostname, nil) }
        if let fixtureRoot { try FileManager.default.removeItem(at: fixtureRoot) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func host(faults supplied: HostIOFaults? = nil, secureRead: Bool = false) -> CoreHost {
        let faults = supplied ?? HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectDownloadHTTPProtocol.self]; faults.httpConfiguration = configuration
        if faults.secretService == nil { faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased() }
        if !secureRead && faults.secretStatus == nil { faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : nil } }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func sql(_ text: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }; return try db.execute(text, parametersJSON: json(args))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS _rowid,* FROM projects ORDER BY id").utf8))) }
    private func others() throws -> [String] { try ["tasks", "sections", "areas", "people", "settings"].map { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \($0) ORDER BY id").utf8))) } }
    private func inode(_ url: URL) throws -> String { var st = stat(); guard lstat(url.path, &st) == 0 else { throw HostFailure("Fixture identity unavailable") }; return "\(UInt64(st.st_dev)):\(UInt64(st.st_ino))" }
    private func seed(status: String = "active", sameURI: Bool = false, declaredSize: Bool = true) async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let settings: [String: Any] = ["@mindwtr_sync_backend": "cloud", "@mindwtr_cloud_provider": "selfhosted", "@mindwtr_cloud_url": "https://" + hostname + "/v1/data/",
            "@mindwtr_cloud_allow_insecure_http": "false", "@mindwtr_cloud_token": "synthetic-token-405", "unknown": "Kept setting / 文"]
        try Data(json(settings).utf8).write(to: manifest)
        let initial = host(); _ = try await initial.start(); await initial.close()
        var attachment: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Original.txt", "uri": sameURI ? target.absoluteString : "",
            "size": bytes.count, "mimeType": "text/plain", "createdAt": at, "updatedAt": at, "cloudKey": "attachments/" + attachmentID + ".txt",
            "fileHash": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined().uppercased(), "contentRev": 7, "localStatus": "missing"]
        if !declaredSize { attachment.removeValue(forKey: "size") }
        _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Kept Project',?,'#123456',1,'[]',0,0,'Kept notes',?,?,?,3,'fixture')", [projectID, status, json([attachment]), at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,createdAt,updatedAt,rev,revBy) VALUES ('sibling','Sibling','waiting','#abcdef',2,'[]',0,0,?,?,4,'fixture')", [at, at])
    }
    private func request(_ core: CoreHost) async throws -> String {
        let options = try object(await core.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        return try json(["projectId": projectID, "attachmentId": attachmentID, "revision": XCTUnwrap(options["revision"] as? String)])
    }
    private func state() throws -> [String: Any] {
        let outer = try object(String(contentsOf: journal)), args = try XCTUnwrap(outer["argumentsJSON"] as? String)
        XCTAssertEqual(outer["method"] as? String, "projectFileAvailabilityOwned")
        let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(args.utf8)) as? [String]); return try object(XCTUnwrap(values.first))
    }
    private func retainedStart(_ core: CoreHost) async throws {
        do { _ = try await core.start(); XCTFail("Download must retain exact recovery") }
        catch { XCTAssertTrue(error is CoreHostProjectFileAvailabilityRecovery, "Unexpected startup failure: \(type(of: error))") }
    }
    private func assertNoTaskOwner() throws { XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readVersioned()) }
    private func cacheFiles() throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted() }

    private func scenario(_ name: String) {
        root = fixtureRoot.appendingPathComponent(name, isDirectory: true)
        remote.bytes = bytes; remote.status = 200; remote.duringGET = nil
    }
    private func selected() throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])
        return try XCTUnwrap((NativeJSON.jsonObject(with: Data(XCTUnwrap(rows.first?["attachments"] as? String).utf8)) as? [[String: Any]])?.first)
    }
    private func changeSelected(_ mutation: (inout [String: Any]) -> Void) throws {
        var item = try selected(); mutation(&item); _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([item]), projectID])
    }
    private func kv() throws -> NativeDeviceKV { try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace) }
    private func setKV(_ name: String, _ value: String) throws {
        let storage = try kv(); defer { storage.close() }; try storage.set(name, value)
    }
    private func getKV(_ name: String) throws -> String? {
        let storage = try kv(); defer { storage.close() }; return try storage.get(name)
    }
    private func inject(_ core: CoreHost, _ boundary: ProjectFileDownloadHostBoundary) async -> () -> Bool {
        let hooks = ProjectFileDownloadHostHooks(); var fired = false
        hooks.boundary = { if $0 == boundary && !fired { fired = true; throw Injected.boundary } }
        await core.configureProjectFileDownloadHost(hooks); return { fired }
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch {}
    }
    private func sourceURL(_ state: [String: Any]) throws -> URL {
        let source = try XCTUnwrap(state["source"] as? [String: Any]); return try XCTUnwrap(URL(string: XCTUnwrap(source["sourceURI"] as? String)))
    }
    private func selectNoAreaFilter(_ core: CoreHost) async throws {
        let filter = try object(await core.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        _ = try await core.call("setAreaFilter", argumentsJSON: json([json(XCTUnwrap(option["next"]))]))
    }
    private func noProgressDebt(_ core: CoreHost, expectedRows: String) async throws {
        try await selectNoAreaFilter(core)
        XCTAssertEqual(try rows(), expectedRows)
    }

    private var encryptionKey: Data { Data((0..<32).map { UInt8($0) }) }
    private func setLegacyEncryptionKey(_ value: String?) throws {
        var current = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        current["@mindwtr_sync_encryption_key_v1"] = value
        try Data(json(current).utf8).write(to: manifest, options: .atomic)
    }
    /// Independent CryptoKit seal, not the production bridge or shared decoder.
    private func encryptedWire(_ key: Data) throws -> Data {
        let salt = Data((1...16).map { UInt8($0) }), nonce = Data((33...44).map { UInt8($0) })
        var header = Data("MWENC1".utf8); header.append(contentsOf: [1, 1, 64, 0, 0, 0, 1, 0, 0, 0, 1, 1])
        header.append(salt); header.append(nonce)
        var length = UInt64(bytes.count + 16).littleEndian
        withUnsafeBytes(of: &length) { header.append(contentsOf: $0) }
        XCTAssertEqual(header.count, 54)
        let sealed = try AES.GCM.seal(bytes, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: header)
        return header + sealed.ciphertext + sealed.tag
    }
    private func seedEncryption(_ stored: String?, state: String = "enabled", wireKey: Data? = nil) throws -> Data {
        try setKV("@mindwtr_sync_encryption_state_v1", json(["state": state,
            "discoveredSalt": Data((1...16).map { UInt8($0) }).map { String(format: "%02x", $0) }.joined(),
            "discoveredParams": ["mKib": 64, "t": 1, "p": 1]]))
        try setLegacyEncryptionKey(stored)
        let ciphertext = try encryptedWire(wireKey ?? encryptionKey)
        XCTAssertNotEqual(ciphertext, bytes); remote.bytes = ciphertext; return ciphertext
    }
    private func downloadOutcomes() throws -> [String] {
        let url = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(text.contains(encryptionKey.base64EncodedString())); XCTAssertFalse(text.contains("synthetic-token-405"))
        return try text.split(separator: "\n").compactMap { line in
            let entry = try object(String(line)), context = entry["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.5/ios-selfhosted-project-download" else { return nil }
            XCTAssertEqual(Set(context?.keys.map { $0 } ?? []), Set(["releaseCheck", "operation", "outcome"]))
            return context?["outcome"]
        }
    }
    private func assertUnpublished(_ before: String, _ other: [String], _ configuration: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try rows(), before, file: file, line: line); XCTAssertEqual(try others(), other, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration, file: file, line: line)
        XCTAssertEqual(try cacheFiles(), [], file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), file: file, line: line)
        XCTAssertFalse(try downloadOutcomes().contains("decrypted"), file: file, line: line)
        XCTAssertFalse(try downloadOutcomes().contains("saved"), file: file, line: line); try assertNoTaskOwner()
    }
    private func assertManagedInventory() throws {
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), [".mindwtr-attachment-installer.lock", target.lastPathComponent].sorted())
        var lock = stat()
        XCTAssertEqual(lstat(managed.appendingPathComponent(".mindwtr-attachment-installer.lock").path, &lock), 0)
        XCTAssertEqual(lock.st_mode & mode_t(S_IFMT), mode_t(S_IFREG), "The only extra entry is the regular standard installer lock")
    }

    func testActualBearerDownloadPublishesBeforeExactProjectMetadataAndColdOpen() async throws {
        try await seed(); let core = host(); _ = try await core.start()
        let input = try await request(core), beforeOther = try others(), config = try Data(contentsOf: manifest)
        let response = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual((response["value"] as? [String: Any])?["status"] as? String, "available")
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try others(), beforeOther); XCTAssertEqual(try Data(contentsOf: manifest), config)
        XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner()
        let saved = try rows(), identity = try inode(target)
        await core.close(); let cold = host(); _ = try await cold.start()
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": attachmentID])))
        XCTAssertEqual((opened["open"] as? [String: Any])?["kind"] as? String, "file")
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(remote.counts, [1, 0])
    }

    func testKnownFilledProofColdRetryDoesNotRepeatGETAndCleansAdoptedSource() async throws {
        try await seed(status: "archived")
        // RN cells need not use the sorted object order of the native recovery journal.
        var item = try selected()
        let raw = try "[{" + item.keys.sorted(by: >).map { try json($0) + ":" + json(item[$0]!) }.joined(separator: ",") + "}]"
        XCTAssertNotEqual(raw, try json([item]))
        _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [raw, projectID])
        let core = host(); _ = try await core.start(); let input = try await request(core)
        let hooks = ProjectFileDownloadHostHooks(); var fired = false
        hooks.boundary = { if $0 == .afterFilled && !fired { fired = true; throw Injected.boundary } }; await core.configureProjectFileDownloadHost(hooks)
        do { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input); XCTFail("Expected retained proof") } catch {}
        XCTAssertTrue(fired); let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
        XCTAssertEqual(retained["phase"] as? String, "stageFilled"); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let source = try XCTUnwrap(retained["source"] as? [String: Any]), sourceURL = try XCTUnwrap(URL(string: XCTUnwrap(source["sourceURI"] as? String)))
        XCTAssertEqual(try Data(contentsOf: sourceURL), bytes); let before = try rows()
        await core.close(); let cold = host(); try await retainedStart(cold)
        XCTAssertEqual(try rows(), before); let result = try object(await cold.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sourceURL.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner()
        item["uri"] = target.absoluteString; item["localStatus"] = "available"
        XCTAssertEqual(try json(selected()), try json(item))
    }

    func testLateRowChangeKeepsPublicationProofAndColdCleanupAbandonPreservesExternalRow() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
        let hooks = ProjectFileDownloadHostHooks(); var fired = false
        hooks.boundary = { if $0 == .afterPublication && !fired { fired = true; _ = try self.sql("UPDATE projects SET title='External title' WHERE id=?", [self.projectID]) } }
        await core.configureProjectFileDownloadHost(hooks)
        do { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input); XCTFail("Expected lost freshness") } catch {}
        XCTAssertTrue(fired); let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String), external = try rows()
        XCTAssertEqual(retained["phase"] as? String, "published"); XCTAssertEqual(try Data(contentsOf: target), bytes)
        await core.close(); let cold = host(); try await retainedStart(cold)
        do { _ = try await cold.recoverProjectFileAvailability(requestId: id); XCTFail("Third row state must refuse") } catch {}
        let result = try object(await cold.abandonProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try rows(), external); XCTAssertEqual(remote.counts, [1, 0])
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try cacheFiles(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner()
    }
    func testEveryKnownDurablePhaseColdRetryKeepsOneGETOneRevisionAndExactBytes() async throws {
        let boundaries: [ProjectFileDownloadHostBoundary] = [.afterIntent, .afterStageProof, .afterFilled, .afterPublication, .afterPublicationProof, .afterCommit, .afterDomainSaved, .afterStageCleanup, .afterSourceCleanup, .afterSettled, .beforeClear]
        for boundary in boundaries {
            scenario(boundary.rawValue); try await seed()
            let core = host(); _ = try await core.start(); let input = try await request(core), count = remote.counts[0]
            let fired = await inject(core, boundary)
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
            XCTAssertTrue(fired(), boundary.rawValue)
            let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
            let savedAtInterruption = try rows(), source = try sourceURL(retained)
            if FileManager.default.fileExists(atPath: source.path) { XCTAssertEqual(try Data(contentsOf: source), bytes) }
            XCTAssertFalse(try String(contentsOf: journal).contains("synthetic-token-405"))
            await core.close(); let cold = host(); try await retainedStart(cold)
            await refused { _ = try await cold.recoverProjectFileAvailability(requestId: UUID().uuidString.lowercased()) }
            let result = try object(await cold.recoverProjectFileAvailability(requestId: id))
            XCTAssertEqual(result["status"] as? String, "available", boundary.rawValue)
            XCTAssertEqual(remote.counts[0], count + 1); XCTAssertEqual(try Data(contentsOf: target), bytes)
            let raw = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])?.first)
            XCTAssertEqual(raw["rev"] as? Int, 4)
            if [.afterCommit, .afterDomainSaved, .afterStageCleanup, .afterSourceCleanup, .afterSettled, .beforeClear].contains(boundary) { XCTAssertEqual(try rows(), savedAtInterruption, "Exact-after must not revise/save again") }
            XCTAssertFalse(FileManager.default.fileExists(atPath: source.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner()
            let settled = try rows(), identity = try inode(target)
            let replay = try object(await cold.recoverProjectFileAvailability(requestId: id))
            XCTAssertEqual(replay["status"] as? String, "available"); XCTAssertEqual(try rows(), settled); XCTAssertEqual(try inode(target), identity)
            XCTAssertEqual(remote.counts[0], count + 1); await cold.close()
        }
    }

    func testSameURIMissingAbandonRetainsReferencedGenerationAndOriginalOpenRemainsLive() async throws {
        try await seed(sameURI: true); let core = host(); _ = try await core.start(); let input = try await request(core), before = try rows()
        let fired = await inject(core, .afterPublicationProof)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        XCTAssertTrue(fired()); let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String), identity = try inode(target)
        await core.close(); let cold = host(); try await retainedStart(cold)
        let result = try object(await cold.abandonProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try cacheFiles(), [])
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": attachmentID])))
        XCTAssertEqual((opened["open"] as? [String: Any])?["kind"] as? String, "file")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testChangedSavedEndpointRefusesRetryButCleanupOnlyStopPreservesConfiguration() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core), before = try rows()
        let fired = await inject(core, .afterFilled)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
        await core.close()
        try setKV("@mindwtr_cloud_url", "https://changed.invalid/v1/data"); let changed = try Data(contentsOf: manifest)
        let cold = host(); try await retainedStart(cold)
        await refused { _ = try await cold.recoverProjectFileAvailability(requestId: id) }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.counts, [1, 0])
        let result = try object(await cold.abandonProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try Data(contentsOf: manifest), changed); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdRetryAdmitsFreshTokenWithoutSerializingOldSecretOrRepeatingHTTP() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
        let fired = await inject(core, .afterFilled)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
        XCTAssertFalse(try String(contentsOf: journal).contains("synthetic-token-405"))
        await core.close()
        // Simulate a changed legacy value after releasing the host; native KV never writes secrets.
        var legacy = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        legacy["@mindwtr_cloud_token"] = "fresh-synthetic-token-405"
        try Data(json(legacy).utf8).write(to: manifest, options: .atomic)
        let cold = host(); try await retainedStart(cold)
        let result = try object(await cold.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        await cold.close(); XCTAssertEqual(try getKV("@mindwtr_cloud_token"), "fresh-synthetic-token-405")
    }

    func testUnprovenReservationStaysRetainedAndCannotBeAdoptedOrStoppedByPath() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core), before = try rows()
        let fired = await inject(core, .afterReservation)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
        XCTAssertEqual(retained["reservationStarted"] as? Bool, true); XCTAssertNil(retained["stage"])
        let candidate = managed.appendingPathComponent(".mindwtr-install-" + id.replacingOccurrences(of: "-", with: "") + ".candidate", isDirectory: true)
        let identity = try inode(candidate), evidence = try Data(contentsOf: sourceURL(retained))
        await core.close(); let cold = host(); try await retainedStart(cold)
        await refused { _ = try await cold.recoverProjectFileAvailability(requestId: id) }
        await refused { _ = try await cold.abandonProjectFileAvailability(requestId: id) }
        XCTAssertEqual(try inode(candidate), identity); XCTAssertEqual(try Data(contentsOf: sourceURL(retained)), evidence)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
    }

    func testBeforeCommitDeviceRowidAndSiblingAttachmentChangesCannotPublishMetadata() async throws {
        for change in ["device", "rowid", "attachment"] {
            scenario(change); try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
            let hooks = ProjectFileDownloadHostHooks(); var fired = false
            hooks.boundary = { if $0 == .beforeCommit && !fired {
                fired = true
                switch change {
                case "device":
                    let raw = try XCTUnwrap((NativeJSON.jsonObject(with: Data(self.sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])?.first?["data"] as? String)
                    var value = try self.object(raw); value["deviceId"] = "external-device"
                    _ = try self.sql("UPDATE settings SET data=? WHERE id=1", [self.json(value)])
                case "rowid": _ = try self.sql("UPDATE projects SET rowid=rowid+100 WHERE id=?", [self.projectID])
                default: try self.changeSelected { $0["title"] = "External attachment" }
                }
            } }
            await core.configureProjectFileDownloadHost(hooks)
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired)
            let external = try rows(), settings = try others(), id = try XCTUnwrap(state()["requestId"] as? String)
            XCTAssertEqual(try selected()["localStatus"] as? String, "missing")
            await core.close(); let cold = host(); try await retainedStart(cold)
            await refused { _ = try await cold.recoverProjectFileAvailability(requestId: id) }
            _ = try await cold.abandonProjectFileAvailability(requestId: id)
            XCTAssertEqual(try rows(), external); XCTAssertEqual(try others(), settings)
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); await cold.close()
        }
    }

    func testDurableReferenceAndForeignOrUnsafeTargetAreRetainedOnCleanupStop() async throws {
        for kind in ["reference", "replacement", "symlink", "hardlink"] {
            do {
            scenario(kind); try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core), count = remote.counts[0]
            let fired = await inject(core, .afterPublicationProof)
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
            let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
            let foreign = root.appendingPathComponent("foreign.txt"), foreignBytes = Data("foreign-preserved".utf8)
            if kind == "reference" {
                var item = try selected(); item["uri"] = target.absoluteString
                _ = try sql("UPDATE projects SET attachments=? WHERE id='sibling'", [json([item])])
            } else if kind == "replacement" {
                try FileManager.default.removeItem(at: target); try foreignBytes.write(to: target)
            } else if kind == "symlink" {
                try foreignBytes.write(to: foreign); try FileManager.default.removeItem(at: target)
                try FileManager.default.createSymbolicLink(at: target, withDestinationURL: foreign)
            } else { guard Darwin.link(target.path, foreign.path) == 0 else { throw HostFailure("Hardlink fixture unavailable") } }
            let identity = try inode(target), external = try rows()
            await core.close(); let cold = host(); try await retainedStart(cold)
            if kind == "symlink" {
                let source = try sourceURL(retained), sourceIdentity = try inode(source)
                let proof = try XCTUnwrap(retained["stage"] as? [String: Any])
                let stage = try XCTUnwrap(URL(string: XCTUnwrap(proof["uri"] as? String)))
                XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
                await refused { _ = try await cold.abandonProjectFileAvailability(requestId: id) }
                let pending = try state(), retainedJournal = try Data(contentsOf: journal), journalIdentity = try inode(journal)
                XCTAssertEqual(pending["abandoned"] as? Bool, true); XCTAssertEqual(pending["targetRetired"] as? Bool, true)
                XCTAssertEqual(pending["stageRetired"] as? Bool, false); XCTAssertEqual(pending["sourceRetired"] as? Bool, false)
                XCTAssertEqual(pending["phase"] as? String, "published"); XCTAssertEqual(pending["requestId"] as? String, id)
                for field in ["requestJSON", "preflightJSON", "envelopeJSON", "rawBeforeJSON", "deviceBeforeJSON", "config", "source", "stage", "filled", "published"] {
                    XCTAssertEqual(try json(XCTUnwrap(pending[field])), try json(XCTUnwrap(retained[field])), field)
                }
                await refused { _ = try await cold.abandonProjectFileAvailability(requestId: id) }
                XCTAssertEqual(try Data(contentsOf: journal), retainedJournal); XCTAssertEqual(try inode(journal), journalIdentity)
                XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try inode(source), sourceIdentity)
                XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
                XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), foreignBytes)
                XCTAssertEqual(try rows(), external); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes)
                // Remove only this test's injected unsafe leaf; the exact recorded operation can then settle.
                try FileManager.default.removeItem(at: target)
                _ = try await cold.abandonProjectFileAvailability(requestId: id)
                XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes)
            } else {
                _ = try await cold.abandonProjectFileAvailability(requestId: id)
                XCTAssertEqual(try inode(target), identity)
                XCTAssertEqual(try Data(contentsOf: target), kind == "replacement" ? foreignBytes : bytes)
                if kind == "hardlink" { XCTAssertEqual(try Data(contentsOf: foreign), bytes) }
            }
            XCTAssertEqual(try rows(), external); XCTAssertEqual(remote.counts, [count + 1, 0])
            XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await cold.close()
            } catch { XCTFail("Retention scenario \(kind) failed"); throw error }
        }
    }

    func testKnownDomainSavedStopNeverRollsBackAvailabilityAndCleanupACKReplays() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
        let fired = await inject(core, .afterDomainSaved)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String), saved = try rows(), identity = try inode(target)
        await core.close(); let cold = host(); try await retainedStart(cold)
        let interrupted = await inject(cold, .afterSourceCleanup)
        await refused { _ = try await cold.abandonProjectFileAvailability(requestId: id) }; XCTAssertTrue(interrupted())
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows(), saved)
        await cold.close(); let final = host(); try await retainedStart(final)
        let result = try object(await final.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try cacheFiles(), [])
    }

    func testWarmTerminalReplayThenNewInitialRefusalDoesNotAdoptOldReceipt() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
        _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input)
        let summary = try object(await core.projectFileAvailabilitySummary()), id = try XCTUnwrap(summary["requestId"] as? String), saved = try rows(), identity = try inode(target)
        XCTAssertEqual(summary["phase"] as? String, "settled")
        _ = try await core.recoverProjectFileAvailability(requestId: id)
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(remote.counts, [1, 0])
        let current = try await request(core)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: current) }
        let empty = try await core.projectFileAvailabilitySummary(); XCTAssertEqual(empty, "null")
        await refused { _ = try await core.recoverProjectFileAvailability(requestId: id) }
        XCTAssertEqual(try rows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(remote.counts, [1, 0])
    }

    func testNoDeclaredSizeKeepsRawMetadataSizeAbsentAfterMeasuredDownload() async throws {
        try await seed(declaredSize: false); let core = host(); _ = try await core.start()
        let input = try await request(core)
        _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input)
        XCTAssertNil(try selected()["size"]); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }

    func testIncompleteHashSizeCapAndUnavailableRefusalsLeaveNoQueuedProgressDebt() async throws {
        for failure in ["incomplete", "hash", "size", "cap", "unavailable"] {
            scenario(failure); try await seed()
            if failure == "incomplete" { try setKV("@mindwtr_sync_encryption_state_v1", json(["state": "off", "incompleteTransition": "enable"])) }
            if failure == "hash" { try changeSelected { $0["fileHash"] = String(repeating: "a", count: 64) } }
            if failure == "size" { try changeSelected { $0["size"] = bytes.count + 1 } }
            if failure == "cap" { remote.bytes = Data(count: 8_388_609) }
            if failure == "unavailable" { remote.status = 404 }
            let core = host(); _ = try await core.start(); try await selectNoAreaFilter(core)
            let input = try await request(core), before = try rows(), config = try Data(contentsOf: manifest), count = remote.counts[0]
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
            XCTAssertEqual(remote.counts[0], count + (failure == "incomplete" ? 0 : 1)); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), config)
            XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            try await noProgressDebt(core, expectedRows: before); await core.close()
            let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), before); try assertNoTaskOwner(); await cold.close()
        }
    }

    func testConfigChangeAfterActualSourceRetiresOnlyMintedCacheWithoutManagedStageOrRowWrites() async throws {
        try await seed(); let core = host(); _ = try await core.start(); try await selectNoAreaFilter(core)
        let input = try await request(core), before = try rows()
        let hooks = ProjectFileDownloadHostHooks(); var fired = false
        hooks.boundary = { if $0 == .afterSource && !fired {
            var changed = try self.object(String(decoding: Data(contentsOf: self.manifest), as: UTF8.self))
            changed["@mindwtr_cloud_url"] = "https://changed.invalid/v1/data"
            try Data(self.json(changed).utf8).write(to: self.manifest, options: .atomic); fired = true
        } }
        await core.configureProjectFileDownloadHost(hooks)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired)
        let changed = try Data(contentsOf: manifest)
        XCTAssertEqual(try object(String(decoding: changed, as: UTF8.self))["@mindwtr_cloud_url"] as? String, "https://changed.invalid/v1/data")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try await noProgressDebt(core, expectedRows: before); XCTAssertEqual(try Data(contentsOf: manifest), changed)
        await core.close(); let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), changed)
    }

    func testDEBUGFilledFixtureRefusesOrdinaryLibraryAndStartedIsolatedHost() async throws {
        let ordinary = host()
        await refused { try await ordinary.configureIsolatedProjectFileDownloadFilledFailureOnce() }
        let isolatedID = UUID().uuidString.lowercased()
        let isolated = fixtureRoot.appendingPathComponent("NativeUITests/" + isolatedID, isDirectory: true)
        try FileManager.default.createDirectory(at: isolated, withIntermediateDirectories: true)
        let core = CoreHost(databaseURL: isolated.appendingPathComponent("mindwtr.sqlite"), bundleURL: bundle)
        addTeardownBlock { await core.close() }
        try await core.configureIsolatedProjectFileDownloadFilledFailureOnce()
        _ = try await core.start()
        await refused { try await core.configureIsolatedProjectFileDownloadFilledFailureOnce() }
        await core.close()
    }

    func testEarlySelectedRowFailureReleasesUnjournaledOwnerAndLiveRetryCanSucceed() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let input = try await request(core)
        let original = try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])?.first)
        _ = try sql("DELETE FROM projects WHERE id=?", [projectID])
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        let summary = try await core.projectFileAvailabilitySummary(); XCTAssertEqual(summary, "null")
        _ = try await core.call("areaFilter")
        let columns = original.keys.sorted()
        _ = try sql("INSERT INTO projects(" + columns.joined(separator: ",") + ") VALUES (" + Array(repeating: "?", count: columns.count).joined(separator: ",") + ")", columns.map { original[$0]! })
        let result = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
        XCTAssertEqual(result["ok"] as? Bool, true); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }

    func testEarlyNativeSecureReadFailureReleasesOwnerBeforeAnyProofAndLiveRetryWorks() async throws {
        try await seed(); let faults = HostIOFaults(); var reject = false
        faults.secretStatus = { operation, _ in operation == "get" ? (reject ? errSecInteractionNotAllowed : errSecItemNotFound) : nil }
        let core = host(faults: faults); _ = try await core.start(); let input = try await request(core), before = try rows()
        reject = true
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        let summary = try await core.projectFileAvailabilitySummary(); XCTAssertEqual(summary, "null")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.counts, [0, 0]); XCTAssertEqual(try cacheFiles(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); _ = try await core.call("areaFilter")
        reject = false
        let result = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
        XCTAssertEqual(result["ok"] as? Bool, true); XCTAssertEqual(remote.counts, [1, 0])
    }

    func testSettledLiveOnlySiblingReferenceKeepsPublishedBytesBeforeDurableScan() async throws {
        try await seed()
        var referenced = try selected(); referenced["uri"] = target.absoluteString
        _ = try sql("UPDATE projects SET attachments=? WHERE id='sibling'", [json([referenced])])
        let core = host(); _ = try await core.start(); let input = try await request(core)
        let hooks = ProjectFileDownloadHostHooks(); var fired = false
        hooks.boundary = { if $0 == .afterPublication && !fired {
            fired = true; _ = try self.sql("UPDATE projects SET attachments=NULL WHERE id='sibling'")
            throw Injected.boundary
        } }
        await core.configureProjectFileDownloadHost(hooks)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired)
        let external = try rows(), id = try XCTUnwrap(state()["requestId"] as? String), identity = try inode(target)
        let result = try object(await core.abandonProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try rows(), external)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
        XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(remote.counts, [1, 0])
    }

    func testNativeCancellationAfterMintedSourceDrainsAndRetiresOnlyThatCache() async throws {
        try await seed(); let core = host(); _ = try await core.start(); try await selectNoAreaFilter(core)
        let input = try await request(core), before = try rows()
        let hooks = ProjectFileDownloadHostHooks(); var fired = false, operation: Task<String, Error>?
        hooks.boundary = { if $0 == .afterSource && !fired { fired = true; operation?.cancel() } }
        await core.configureProjectFileDownloadHost(hooks)
        var release: AsyncStream<Void>.Continuation?
        let admitted = AsyncStream<Void> { release = $0 }
        operation = Task {
            var iterator = admitted.makeAsyncIterator(); _ = await iterator.next()
            return try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input)
        }
        release?.yield(()); release?.finish()
        await refused { _ = try await XCTUnwrap(operation).value }; XCTAssertTrue(fired)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try await noProgressDebt(core, expectedRows: before)
        await core.close(); let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), before)
    }

    func testEncryptedBearerDownloadUsesActualAESAndColdFilledRetryNeedsNoGET() async throws {
        try await seed(status: "archived")
        let key = encryptionKey, ciphertext = try seedEncryption(encryptionKey.base64EncodedString())
        var item = try selected()
        let raw = try "[{" + item.keys.sorted(by: >).map { try json($0) + ":" + json(item[$0]!) }.joined(separator: ",") + "}]"
        XCTAssertNotEqual(raw, try json([item]))
        _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [raw, projectID])
        let before = try rows(), beforeOthers = try others(), configuration = try Data(contentsOf: manifest)
        var operations = [String](), secureReads = 0
        let faults = HostIOFaults()
        faults.cryptoAfterOperation = { operations.append($0) }
        faults.secretStatus = { operation, _ in
            XCTAssertEqual(operation, "get", "Preparation cannot mutate secure storage")
            secureReads += 1; return errSecItemNotFound
        }
        let core = host(faults: faults); _ = try await core.start(); let input = try await request(core)
        let fired = await inject(core, .afterFilled)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(remote.bytes, ciphertext)
        XCTAssertGreaterThan(secureReads, 0, "Actual nil secure reads use the unchanged legacy fallback")
        XCTAssertEqual(operations, ["aesGcmOpen"], "Only actual native decryption may produce this plaintext source")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), beforeOthers)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        guard fired() else { return XCTFail("Encrypted preparation must reach the durable filled-stage boundary") }
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
        XCTAssertEqual(retained["phase"] as? String, "stageFilled")
        XCTAssertEqual(try downloadOutcomes().filter { $0 == "decrypted" }, ["decrypted"])
        XCTAssertFalse(try downloadOutcomes().contains("saved"))
        let source = try sourceURL(retained), stage = try XCTUnwrap(retained["stage"] as? [String: Any])
        let stageURL = try XCTUnwrap(URL(string: XCTUnwrap(stage["uri"] as? String)))
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try Data(contentsOf: stageURL), bytes)
        let journalText = try String(contentsOf: journal)
        XCTAssertFalse(journalText.contains(key.base64EncodedString()), "No encryption material is journaled")
        XCTAssertFalse(journalText.contains("synthetic-token-405"), "No transport credential is journaled")
        await core.close()
        let coldFaults = HostIOFaults(); coldFaults.cryptoAfterOperation = { operations.append($0) }
        let cold = host(faults: coldFaults); try await retainedStart(cold)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), beforeOthers)
        let result = try object(await cold.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["status"] as? String, "available")
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(remote.bytes, ciphertext)
        XCTAssertEqual(operations, ["aesGcmOpen"], "Proven plaintext recovery must neither fetch nor decrypt again")
        XCTAssertEqual(try downloadOutcomes().filter { $0 == "decrypted" }, ["decrypted"])
        XCTAssertEqual(try downloadOutcomes().filter { $0 == "saved" }, ["saved"])
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try others(), beforeOthers)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        item["uri"] = target.absoluteString; item["localStatus"] = "available"
        let expectedRaw = try "[{" + item.keys.sorted(by: >).map { try json($0) + ":" + json(item[$0]!) }.joined(separator: ",") + "}]"
        var expectedRows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(before.utf8)) as? [[String: Any]])
        let savedRows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(rows().utf8)) as? [[String: Any]])
        let index = try XCTUnwrap(expectedRows.firstIndex { $0["id"] as? String == projectID }), saved = savedRows[index]
        XCTAssertEqual(saved["rev"] as? Int, 4)
        XCTAssertFalse((saved["revBy"] as? String ?? "").isEmpty); XCTAssertNotEqual(saved["updatedAt"] as? String, at)
        expectedRows[index]["attachments"] = expectedRaw; expectedRows[index]["rev"] = 4
        expectedRows[index]["revBy"] = saved["revBy"]; expectedRows[index]["updatedAt"] = saved["updatedAt"]
        XCTAssertEqual(try json(savedRows), try json(expectedRows), "Only the exact selected availability patch is persisted")
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: stageURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try cacheFiles(), [])
        try assertManagedInventory(); try assertNoTaskOwner()
        let savedRowsJSON = try rows(), identity = try inode(target)
        await cold.close(); let opened = host(); _ = try await opened.start()
        let preview = try object(await opened.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": attachmentID])))
        XCTAssertEqual((preview["open"] as? [String: Any])?["kind"] as? String, "file")
        XCTAssertEqual(try rows(), savedRowsJSON); XCTAssertEqual(try others(), beforeOthers)
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(remote.counts, [1, 0])
    }

    func testEncryptedStoredMaterialDecoderMatchesSharedFormattingWithoutMutation() async throws {
        let canonical = encryptionKey.base64EncodedString(), zeros = Data(repeating: 0, count: 32)
        let vectors: [(String, String, Data, String)] = [
            ("canonical", canonical, encryptionKey, "enabled"),
            ("whitespace", " \n" + String(canonical.prefix(20)) + "\t" + String(canonical.dropFirst(20)) + "\r ", encryptionKey, "enabled"),
            ("unpadded", String(canonical.dropLast()), encryptionKey, "remote-plaintext"),
            ("ignored", "文!" + String(canonical.prefix(13)) + "_-" + String(canonical.dropFirst(13)) + "?", encryptionKey, "enabled"),
            // Shared base64ToBytes allocates 32 zero bytes, then stops at the first padding.
            ("embedded-padding", "=" + String(repeating: "A", count: 42) + "=", zeros, "enabled")]
        for (name, stored, decoded, posture) in vectors {
            scenario(name); try await seed()
            let ciphertext = try seedEncryption(stored, state: posture, wireKey: decoded)
            let beforeOther = try others(), configuration = try Data(contentsOf: manifest), original = try selected(), count = remote.counts[0]
            let faults = HostIOFaults(); var operations = [String]()
            faults.cryptoAfterOperation = { operations.append($0) }
            faults.secretStatus = { operation, _ in XCTAssertEqual(operation, "get"); return errSecItemNotFound }
            let core = host(faults: faults); _ = try await core.start(); let input = try await request(core)
            let result = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
            XCTAssertEqual(result["ok"] as? Bool, true, name); XCTAssertEqual(operations, ["aesGcmOpen"], name)
            XCTAssertEqual(remote.counts, [count + 1, 0]); XCTAssertEqual(remote.bytes, ciphertext); XCTAssertEqual(try Data(contentsOf: target), bytes)
            var expected = original; expected["uri"] = target.absoluteString; expected["localStatus"] = "available"
            XCTAssertEqual(try json(selected()), try json(expected)); XCTAssertEqual(try others(), beforeOther)
            XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(try cacheFiles(), [])
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertManagedInventory(); try assertNoTaskOwner()
            XCTAssertEqual(try downloadOutcomes(), ["decrypted", "saved"])
            await core.close()
        }
    }

    func testEncryptedMissingInvalidOrWrongMaterialCannotPublishOrQueueMetadata() async throws {
        let vectors: [(String, String?, String, Int)] = [
            ("missing", nil, "enabled", 0),
            ("short", Data(repeating: 2, count: 31).base64EncodedString(), "enabled", 0),
            ("long", Data(repeating: 2, count: 33).base64EncodedString(), "enabled", 0),
            ("no-key-posture", encryptionKey.base64EncodedString(), "remote-encrypted-no-key", 0),
            ("wrong", Data(repeating: 2, count: 32).base64EncodedString(), "enabled", 1)]
        for (name, stored, posture, attempts) in vectors {
            scenario(name); try await seed(); let ciphertext = try seedEncryption(stored, state: posture)
            let count = remote.counts[0]
            let faults = HostIOFaults(); var operations = [String]()
            faults.cryptoBeforeOperation = { operations.append($0) }
            faults.secretStatus = { operation, _ in XCTAssertEqual(operation, "get"); return errSecItemNotFound }
            let core = host(faults: faults); _ = try await core.start(); try await selectNoAreaFilter(core)
            let input = try await request(core), before = try rows(), other = try others(), configuration = try Data(contentsOf: manifest)
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
            XCTAssertEqual(remote.counts, [count + 1, 0], name); XCTAssertEqual(remote.bytes, ciphertext)
            XCTAssertEqual(operations, Array(repeating: "aesGcmOpen", count: attempts), name)
            try assertUnpublished(before, other, configuration)
            await core.close(); let cold = host(); _ = try await cold.start()
            try assertUnpublished(before, other, configuration); XCTAssertEqual(remote.counts, [count + 1, 0])
            // The debt probe intentionally cycles the filter; verify cold preservation first.
            try await noProgressDebt(cold, expectedRows: before); await cold.close()
        }
    }

    func testExactLegacyMaterialChangeAfterAESOrMintedSourceRefusesAndRetiresOnlyOwnedCache() async throws {
        for boundary in ["aes", "source"] {
            scenario(boundary); try await seed(); _ = try seedEncryption(encryptionKey.base64EncodedString())
            let count = remote.counts[0]
            let faults = HostIOFaults(); var changed = false, mutationFailed = false, operations = [String]()
            let mutate = {
                do { try self.setLegacyEncryptionKey("\n" + self.encryptionKey.base64EncodedString()); changed = true }
                catch { mutationFailed = true }
            }
            faults.cryptoAfterOperation = { operation in operations.append(operation); if boundary == "aes" { mutate() } }
            let core = host(faults: faults); _ = try await core.start(); try await selectNoAreaFilter(core)
            let input = try await request(core), before = try rows(), other = try others()
            let foreign = cache.appendingPathComponent("foreign-kept.txt"), foreignBytes = Data("Unrelated cache / 文".utf8)
            try foreignBytes.write(to: foreign); let identity = try inode(foreign)
            if boundary == "source" {
                let hooks = ProjectFileDownloadHostHooks(); hooks.boundary = { if $0 == .afterSource { mutate() } }
                await core.configureProjectFileDownloadHost(hooks)
            }
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
            XCTAssertTrue(changed); XCTAssertFalse(mutationFailed); XCTAssertEqual(operations, ["aesGcmOpen"])
            let configuration = try Data(contentsOf: manifest)
            XCTAssertEqual(try getKV("@mindwtr_sync_encryption_key_v1"), "\n" + encryptionKey.base64EncodedString(), "Raw observation changes refuse even when decoded AES bytes are identical")
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), other)
            XCTAssertEqual(try cacheFiles(), [foreign.lastPathComponent]); XCTAssertEqual(try Data(contentsOf: foreign), foreignBytes); XCTAssertEqual(try inode(foreign), identity)
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertEqual(try downloadOutcomes(), []); XCTAssertEqual(remote.counts, [count + 1, 0]); try assertNoTaskOwner()
            try await noProgressDebt(core, expectedRows: before); await core.close()
            let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
            XCTAssertEqual(try cacheFiles(), [foreign.lastPathComponent]); XCTAssertEqual(try inode(foreign), identity); await cold.close()
        }
    }

    func testWarmChangedMaterialRefusesButColdFilledPlaintextRetryAllowsFreshNilWithoutGET() async throws {
        try await seed(); let ciphertext = try seedEncryption(encryptionKey.base64EncodedString())
        let before = try rows(), other = try others(); var operations = [String](), changed = false
        let faults = HostIOFaults(); faults.cryptoAfterOperation = { operations.append($0) }
        let core = host(faults: faults); _ = try await core.start(); let input = try await request(core)
        let hooks = ProjectFileDownloadHostHooks()
        hooks.boundary = { if $0 == .afterFilled && !changed { try self.setLegacyEncryptionKey("\n" + self.encryptionKey.base64EncodedString()); changed = true } }
        await core.configureProjectFileDownloadHost(hooks)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(changed)
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String), journalBytes = try Data(contentsOf: journal)
        XCTAssertEqual(retained["phase"] as? String, "stageFilled"); XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), other)
        let source = try sourceURL(retained); XCTAssertEqual(try Data(contentsOf: source), bytes)
        await refused { _ = try await core.recoverProjectFileAvailability(requestId: id) }
        XCTAssertEqual(try Data(contentsOf: journal), journalBytes); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(remote.bytes, ciphertext); XCTAssertEqual(operations, ["aesGcmOpen"])
        await core.close(); try setLegacyEncryptionKey(nil); let current = try Data(contentsOf: manifest)
        let coldFaults = HostIOFaults(); coldFaults.cryptoBeforeOperation = { operations.append($0) }
        let cold = host(faults: coldFaults); try await retainedStart(cold)
        let result = try object(await cold.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertEqual(operations, ["aesGcmOpen"])
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try others(), other)
        XCTAssertEqual(try Data(contentsOf: manifest), current); XCTAssertNil(try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))["@mindwtr_sync_encryption_key_v1"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try cacheFiles(), []); try assertManagedInventory(); try assertNoTaskOwner()
        XCTAssertEqual(try downloadOutcomes().filter { $0 == "decrypted" }, ["decrypted"])
        XCTAssertEqual(try downloadOutcomes().filter { $0 == "saved" }, ["saved"])
    }

    func testCancellationDuringActualAESDrainsAndNextEncryptedRequestCompletes() async throws {
        try await seed(); _ = try seedEncryption(encryptionKey.base64EncodedString())
        let faults = HostIOFaults(); var crypto: NativeCryptoJobs?, operations = [String](), fired = false, operation: Task<String, Error>?
        faults.configureCryptoJobs = { crypto = $0 }
        faults.cryptoBeforeOperation = { value in if value == "aesGcmOpen" && !fired { fired = true; operation?.cancel() } }
        faults.cryptoAfterOperation = { operations.append($0) }
        let core = host(faults: faults); _ = try await core.start(); try await selectNoAreaFilter(core)
        let input = try await request(core), before = try rows(), other = try others(), configuration = try Data(contentsOf: manifest)
        var release: AsyncStream<Void>.Continuation?; let admitted = AsyncStream<Void> { release = $0 }
        operation = Task { var iterator = admitted.makeAsyncIterator(); _ = await iterator.next(); return try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        release?.yield(()); release?.finish()
        await refused { _ = try await XCTUnwrap(operation).value }; XCTAssertTrue(fired); XCTAssertEqual(operations, ["aesGcmOpen"])
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0); XCTAssertEqual(crypto?.counters.bytes, 0)
        try assertUnpublished(before, other, configuration); try await noProgressDebt(core, expectedRows: before)
        // This successful filter command owns its settings change, not the cancelled download.
        let afterProbe = try others()
        let fresh = try await request(core), reply = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: fresh))
        XCTAssertEqual(reply["ok"] as? Bool, true); XCTAssertEqual(remote.counts, [2, 0]); XCTAssertEqual(operations, ["aesGcmOpen", "aesGcmOpen"])
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try others(), afterProbe); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try downloadOutcomes(), ["decrypted", "saved"]); try assertManagedInventory()
    }

    func testPhysicalSecureMaterialValueChangeAfterActualAESRefusesBeforeSource() async throws {
        #if os(iOS)
        try await seed(); _ = try seedEncryption(encryptionKey.base64EncodedString())
        let faults = HostIOFaults(), service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretService = service
        let account = Data("mindwtr_sync_encryption_key_v1".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: account, kSecAttrGeneric as String: account, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var item = query; item[kSecValueData as String] = Data(encryptionKey.base64EncodedString().utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        defer { let status = SecItemDelete(query as CFDictionary); XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound) }
        var changed = false, status = errSecSuccess, operations = [String]()
        faults.cryptoAfterOperation = { value in
            operations.append(value)
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: Data(("\n" + self.encryptionKey.base64EncodedString()).utf8)] as CFDictionary)
            changed = true
        }
        let core = host(faults: faults, secureRead: true); _ = try await core.start(); try await selectNoAreaFilter(core)
        let input = try await request(core), before = try rows(), other = try others(), configuration = try Data(contentsOf: manifest)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        XCTAssertTrue(changed); XCTAssertEqual(status, errSecSuccess); XCTAssertEqual(operations, ["aesGcmOpen"]); XCTAssertEqual(remote.counts, [1, 0])
        try assertUnpublished(before, other, configuration); try await noProgressDebt(core, expectedRows: before)
        #else
        throw XCTSkip("Actual isolated secure-material value changes require iOS; macOS exercises true nil reads and exact legacy changes")
        #endif
    }

    func testWebDAVEndpointReplacementAfterSuccessfulGETRefusesBeforePublicationAndProgressPersistence() async throws {
        try await seed()
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        for name in ["@mindwtr_cloud_provider", "@mindwtr_cloud_url", "@mindwtr_cloud_allow_insecure_http", "@mindwtr_cloud_token"] { settings.removeValue(forKey: name) }
        settings["@mindwtr_sync_backend"] = "webdav"
        settings["@mindwtr_webdav_url"] = "https://" + hostname + "/v1/data.json"
        settings["@mindwtr_webdav_username"] = "synthetic"
        settings["@mindwtr_webdav_password"] = "fixture-only"
        settings["@mindwtr_webdav_allow_insecure_http"] = "false"
        try Data(json(settings).utf8).write(to: manifest)
        remote.expectedAuthorization = "Basic " + Data("synthetic:fixture-only".utf8).base64EncodedString()
        let faults = HostIOFaults(); var fired = false, completions = 0, changedConfiguration: Data?
        faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = {
            completions += 1
            guard !fired else { return }
            do {
                XCTAssertEqual(self.remote.counts, [1, 0], "The actual allowed GET must finish before authority changes")
                var next = try self.object(String(decoding: Data(contentsOf: self.manifest), as: UTF8.self))
                next["@mindwtr_webdav_url"] = "https://changed-416.invalid/v1/data.json"
                let bytes = Data(try self.json(next).utf8); try bytes.write(to: self.manifest, options: .atomic)
                changedConfiguration = bytes; fired = true
            } catch { XCTFail("Synthetic saved endpoint replacement failed") }
        } }
        let hooks = NativeAttachmentHostHooks(); var syncs = 0, installerWork = 0
        hooks.configureJobs = { jobs in
            jobs.beforeStageSync = { syncs += 1 }
            jobs.beforeWork = { _, installer in if installer { installerWork += 1 } }
        }
        let core = host(faults: faults); try await core.configureAttachmentHost(hooks); _ = try await core.start()
        // Warm the ordinary persistence path before taking exact raw-row/config
        // snapshots, and retain the SAME selection for the post-refusal probe.
        let filter = try object(await core.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        let sameSelection = try json(XCTUnwrap(option["next"]))
        _ = try await core.call("setAreaFilter", argumentsJSON: json([sameSelection]))
        let input = try await request(core), before = try rows(), beforeOther = try others(), configuration = try Data(contentsOf: manifest)
        let initialInstallerWork = installerWork, initialSyncs = syncs, wire = remote.bytes
        var refused = false
        do {
            let response = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
            if response["ok"] as? Bool == true {
                // Shared on-demand refusal is a successful command envelope
                // carrying unavailable, never an availability acknowledgment.
                XCTAssertEqual(Set(response.keys), Set(["ok", "value"]))
                let value = try XCTUnwrap(response["value"] as? [String: Any])
                XCTAssertEqual(Set(value.keys), Set(["status", "message", "update"]))
                XCTAssertEqual(value["status"] as? String, "unavailable"); XCTAssertTrue(value["update"] is NSNull)
                XCTAssertFalse((value["message"] as? String ?? "").isEmpty)
                refused = value["status"] as? String == "unavailable"
            } else {
                XCTAssertEqual(Set(response.keys), Set(["ok", "error"]))
                let error = try XCTUnwrap(response["error"] as? [String: Any]); XCTAssertEqual(error["code"] as? String, "ACTION_FAILED")
                refused = response["ok"] as? Bool == false
            }
        } catch { refused = true }
        XCTAssertTrue(fired); XCTAssertEqual(completions, 1); XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(remote.bytes, wire)
        XCTAssertTrue(refused, "Changed saved WebDAV authority must not acknowledge Project availability")
        let external = try XCTUnwrap(changedConfiguration); XCTAssertNotEqual(external, configuration)
        XCTAssertEqual(try Data(contentsOf: manifest), external); XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), beforeOther)
        XCTAssertEqual(syncs, initialSyncs, "No plaintext source or installation stage may be synced after authority loss")
        XCTAssertEqual(installerWork, initialInstallerWork, "No installer may be admitted after authority loss")
        XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        if FileManager.default.fileExists(atPath: managed.path) { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), []) }
        try assertNoTaskOwner()
        var noOpFailed = false
        do { _ = try await core.call("setAreaFilter", argumentsJSON: json([sameSelection])) } catch { noOpFailed = true }
        XCTAssertFalse(noOpFailed, "An unchanged ordinary selection must not carry failed Project persistence debt")
        XCTAssertEqual(try rows(), before, "The warmed no-op must not later persist downloading metadata")
        XCTAssertEqual(try others(), beforeOther); XCTAssertEqual(try Data(contentsOf: manifest), external)
        await core.close()
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try others(), beforeOther); XCTAssertEqual(try Data(contentsOf: manifest), external)
        XCTAssertEqual(try cacheFiles(), []); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        if FileManager.default.fileExists(atPath: managed.path) { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), []) }
        XCTAssertEqual(remote.counts, [1, 0]); try assertNoTaskOwner()
    }

    private func seedWebDAV416(status: String = "active", hash: Bool = true, sameURI: Bool = false, available: Bool = false) async throws {
        try await seed(status: status, sameURI: sameURI, declaredSize: hash)
        var settings = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        for name in ["@mindwtr_cloud_provider", "@mindwtr_cloud_url", "@mindwtr_cloud_allow_insecure_http", "@mindwtr_cloud_token"] { settings.removeValue(forKey: name) }
        settings["@mindwtr_sync_backend"] = "webdav"; settings["@mindwtr_webdav_url"] = "https://" + hostname + "/v1/data.json"
        settings["@mindwtr_webdav_username"] = "synthetic"; settings["@mindwtr_webdav_password"] = "fixture-only"
        settings["@mindwtr_webdav_allow_insecure_http"] = "false"
        try Data(json(settings).utf8).write(to: manifest)
        remote.expectedAuthorization = "Basic " + Data("synthetic:fixture-only".utf8).base64EncodedString()
        try changeSelected { item in if !hash { item.removeValue(forKey: "fileHash") }; if available { item["localStatus"] = "available" } }
    }
    private func webdavOutcomes416() throws -> [String] {
        let url = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(text.contains("fixture-only")); XCTAssertFalse(text.contains(remote.expectedAuthorization))
        return try text.split(separator: "\n").compactMap { line in
            let context = try object(String(line))["context"] as? [String: String]
            guard context?["releaseCheck"] == "v1.3.5/ios-webdav-project-download" else { return nil }
            XCTAssertEqual(Set(context?.keys.map { $0 } ?? []), Set(["releaseCheck", "operation", "outcome"]))
            XCTAssertEqual(context?["operation"], "webdav-project-download")
            return context?["outcome"]
        }
    }
    private func projectRows416() throws -> [[String: Any]] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(rows().utf8)) as? [[String: Any]]) }
    private func assertWebDAVEffect416(_ before: [[String: Any]], original: [String: Any], metadataNoop: Bool = false,
                                       unrecoverable: Bool = false, file: StaticString = #filePath, line: UInt = #line) throws {
        let actual = try projectRows416(), old = try XCTUnwrap(before.first { $0["id"] as? String == projectID })
        let saved = try XCTUnwrap(actual.first { $0["id"] as? String == projectID })
        if metadataNoop { XCTAssertEqual(try json(actual), try json(before), file: file, line: line); return }
        XCTAssertEqual(saved["rev"] as? Int, (old["rev"] as? Int ?? 0) + 1, file: file, line: line)
        let stamp = try XCTUnwrap(saved["updatedAt"] as? String), device = try XCTUnwrap(saved["revBy"] as? String)
        XCTAssertFalse(device.isEmpty, file: file, line: line)
        var expected = original
        if unrecoverable {
            expected.removeValue(forKey: "cloudKey"); expected.removeValue(forKey: "fileHash")
            expected["localStatus"] = "missing"; expected["deletedAt"] = stamp; expected["updatedAt"] = stamp
        } else { expected["uri"] = target.absoluteString; expected["localStatus"] = "available" }
        XCTAssertEqual(try json(selected()), try json(expected), file: file, line: line)
        var expectedRow = old
        expectedRow["attachments"] = saved["attachments"]; expectedRow["rev"] = saved["rev"]
        expectedRow["revBy"] = device; expectedRow["updatedAt"] = stamp
        XCTAssertEqual(try json(saved), try json(expectedRow), file: file, line: line)
        XCTAssertEqual(try json(actual.filter { $0["id"] as? String != projectID }),
            try json(before.filter { $0["id"] as? String != projectID }), file: file, line: line)
    }

    func testWebDAVOwnedDownloadPreservesKnownOrAbsentHashAndRestoresAbsentAlreadyAvailableBytesWithoutMetadataChange() async throws {
        for variant in ["known", "hashless-archived", "available-absent"] {
            scenario(variant); let count = remote.counts[0], noop = variant == "available-absent"
            try await seedWebDAV416(status: variant == "hashless-archived" ? "archived" : "active", hash: variant == "known", sameURI: noop, available: noop)
            if noop {
                let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
                var settings = try object(XCTUnwrap(raw.first?["data"] as? String)); settings.removeValue(forKey: "deviceId")
                _ = try sql("UPDATE settings SET data=? WHERE id=1", [json(settings)])
            }
            let core = host(); _ = try await core.start(); let input = try await request(core)
            let original = try selected(), before = try projectRows416(), other = try others(), config = try Data(contentsOf: manifest)
            var deviceBefore: String?
            if noop {
                let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
                deviceBefore = try json([try object(XCTUnwrap(raw.first?["data"] as? String))["deviceId"] ?? NSNull()])
            }
            let reply = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
            XCTAssertEqual(reply["ok"] as? Bool, true); XCTAssertEqual((reply["value"] as? [String: Any])?["status"] as? String, "available")
            XCTAssertEqual(remote.counts, [count + 1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
            try assertWebDAVEffect416(before, original: original, metadataNoop: noop)
            if noop {
                let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
                XCTAssertEqual(try json([try object(XCTUnwrap(raw.first?["data"] as? String))["deviceId"] ?? NSNull()]), deviceBefore)
            }
            XCTAssertEqual(try webdavOutcomes416(), [noop ? "noop" : "saved"])
            XCTAssertEqual(try others(), other); XCTAssertEqual(try Data(contentsOf: manifest), config)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try cacheFiles(), [])
            try assertManagedInventory(); try assertNoTaskOwner()
            let saved = try rows(); await core.close(); let cold = host(); _ = try await cold.start()
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(remote.counts, [count + 1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(try others(), other); XCTAssertEqual(try Data(contentsOf: manifest), config); await cold.close()
        }
    }

    func testWebDAVCachedHashlessCurrentGenerationRepairsOrNoopsWithoutGETAndUnknownPresentEmptyURIRefuses() async throws {
        for variant in ["missing", "available", "unknown-empty"] {
            scenario(variant); let count = remote.counts[0], unknown = variant == "unknown-empty", noop = variant == "available"
            try await seedWebDAV416(hash: false, sameURI: !unknown, available: noop)
            try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
            let identity = try inode(target), core = host(); _ = try await core.start(); let input = try await request(core)
            let original = try selected(), before = try projectRows416(), other = try others(), config = try Data(contentsOf: manifest)
            if unknown { await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) } }
            else {
                let result = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
                XCTAssertEqual(result["ok"] as? Bool, true); XCTAssertEqual((result["value"] as? [String: Any])?["status"] as? String, "available")
                try assertWebDAVEffect416(before, original: original, metadataNoop: noop)
            }
            if unknown { XCTAssertEqual(try json(projectRows416()), try json(before)) }
            XCTAssertEqual(try webdavOutcomes416(), [])
            XCTAssertEqual(remote.counts, [count, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), [target.lastPathComponent])
            XCTAssertEqual(try others(), other); XCTAssertEqual(try Data(contentsOf: manifest), config)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try cacheFiles(), []); try assertNoTaskOwner()
            let saved = try rows(); await core.close(); let cold = host(); _ = try await cold.start()
            XCTAssertEqual(try rows(), saved); XCTAssertEqual(remote.counts, [count, 0]); XCTAssertEqual(try inode(target), identity); await cold.close()
        }
    }

    func testWebDAVConfirmed404UsesSourceFreeColdRetryAndStopNeverRollsBackLostCommitAcknowledgment() async throws {
        for variant in ["retry", "stop-before", "retry-after-commit", "stop-after-commit"] {
            scenario(variant); let count = remote.counts[0]
            try await seedWebDAV416(hash: false); remote.status = 404
            let core = host(); _ = try await core.start(); let input = try await request(core)
            let original = try selected(), before = try projectRows416(), other = try others(), config = try Data(contentsOf: manifest)
            let fired = await inject(core, variant.hasSuffix("after-commit") ? .afterCommit : .afterIntent)
            await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
            let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String)
            XCTAssertEqual(retained["version"] as? Int, 2); XCTAssertEqual(retained["outcome"] as? String, "unrecoverable")
            XCTAssertEqual(retained["phase"] as? String, "intent")
            for field in ["source", "stage", "filled", "published", "managedDirectoryIdentity"] { XCTAssertNil(retained[field], field) }
            for field in ["reservationStarted", "targetRetired", "stageRetired", "sourceRetired"] { XCTAssertEqual(retained[field] as? Bool, false, field) }
            XCTAssertEqual(remote.counts, [count + 1, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)); XCTAssertEqual(try cacheFiles(), [])
            if variant.hasSuffix("after-commit") { try assertWebDAVEffect416(before, original: original, unrecoverable: true) }
            else { XCTAssertEqual(try json(projectRows416()), try json(before)) }
            let preCold = try rows(); await core.close(); let cold = host(); try await retainedStart(cold)
            let reply: String
            if variant.hasPrefix("stop") { reply = try await cold.abandonProjectFileAvailability(requestId: id) }
            else { reply = try await cold.recoverProjectFileAvailability(requestId: id) }
            let result = try object(reply)
            if !variant.hasPrefix("stop") { XCTAssertEqual(result["status"] as? String, "unrecoverable"); try assertWebDAVEffect416(before, original: original, unrecoverable: true) }
            else { XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertEqual(try rows(), preCold) }
            XCTAssertEqual(remote.counts, [count + 1, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)); XCTAssertEqual(try cacheFiles(), [])
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try others(), other)
            let terminal = variant.hasPrefix("stop") ? "abandoned" : "unrecoverable"
            XCTAssertEqual(try webdavOutcomes416().filter { $0 == terminal }, [terminal])
            XCTAssertEqual(try Data(contentsOf: manifest), config); try assertNoTaskOwner(); await cold.close()
            let clean = host(); _ = try await clean.start(); XCTAssertEqual(remote.counts, [count + 1, 0]); await clean.close()
        }
    }

    func testWebDAVNativePasswordReadErrorAfterGETRefusesBeforeSourceAndFreshRequestSucceeds() async throws {
        try await seedWebDAV416()
        let faults = HostIOFaults(); var fetched = false, refuseReads = true, beforeReads = 0, afterReads = 0
        faults.secretStatus = { operation, _ in
            XCTAssertEqual(operation, "get")
            if fetched && refuseReads { afterReads += 1; return errSecNotAvailable }; beforeReads += 1
            return errSecItemNotFound
        }
        faults.configureHTTPJobs = { jobs in jobs.beforeCompletion = { fetched = true } }
        let hooks = NativeAttachmentHostHooks(); var stages = 0, installs = 0
        hooks.configureJobs = { jobs in jobs.beforeStageSync = { stages += 1 }; jobs.beforeWork = { _, installer in if installer { installs += 1 } } }
        let core = host(faults: faults); try await core.configureAttachmentHost(hooks); _ = try await core.start(); let input = try await request(core)
        let before = try rows(), other = try others(), config = try Data(contentsOf: manifest)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        XCTAssertTrue(fetched); XCTAssertGreaterThan(beforeReads, 0); XCTAssertGreaterThan(afterReads, 0); XCTAssertEqual(remote.counts, [1, 0])
        XCTAssertEqual(stages, 0); XCTAssertEqual(installs, 0); try assertUnpublished(before, other, config)
        XCTAssertEqual(try webdavOutcomes416(), [])
        let current = try await request(core); refuseReads = false
        let result = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: current))
        XCTAssertEqual((result["value"] as? [String: Any])?["status"] as? String, "available"); XCTAssertEqual(remote.counts, [2, 0])
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try others(), other); XCTAssertEqual(try Data(contentsOf: manifest), config)
        XCTAssertEqual(try webdavOutcomes416(), ["saved"])
        try assertManagedInventory(); try assertNoTaskOwner()
    }

    func testWebDAVHashlessFilledSourceColdRetryUsesExistingV1JournalWithoutSecondGET() async throws {
        try await seedWebDAV416(hash: false)
        let core = host(); _ = try await core.start(); let input = try await request(core)
        let original = try selected(), before = try projectRows416(), other = try others(), config = try Data(contentsOf: manifest)
        let fired = await inject(core, .afterFilled)
        await refused { _ = try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }; XCTAssertTrue(fired())
        let retained = try state(), id = try XCTUnwrap(retained["requestId"] as? String), source = try sourceURL(retained)
        XCTAssertEqual(retained["version"] as? Int, 1); XCTAssertNil(retained["outcome"]); XCTAssertEqual(retained["phase"] as? String, "stageFilled")
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try json(projectRows416()), try json(before)); XCTAssertEqual(remote.counts, [1, 0])
        let journalText = try String(contentsOf: journal, encoding: .utf8)
        XCTAssertFalse(journalText.contains("fixture-only")); XCTAssertFalse(journalText.contains(remote.expectedAuthorization))
        await core.close(); let cold = host(); try await retainedStart(cold)
        let recovered = try object(await cold.recoverProjectFileAvailability(requestId: id))
        XCTAssertEqual(recovered["status"] as? String, "available")
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes)
        try assertWebDAVEffect416(before, original: original); XCTAssertEqual(try others(), other); XCTAssertEqual(try Data(contentsOf: manifest), config)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(try cacheFiles(), []); try assertManagedInventory(); try assertNoTaskOwner()
    }

}
