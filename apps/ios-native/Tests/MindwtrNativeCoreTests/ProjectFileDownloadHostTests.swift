import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ProjectDownloadHTTPState: @unchecked Sendable {
    let lock = NSLock()
    var bytes = Data(), status = 200
    var duringGET: (() -> Void)?
    private var requests = 0, unexpected = 0
    func reply(_ request: URLRequest) -> Data? {
        lock.lock()
        requests += 1
        guard request.httpMethod == "GET", request.url?.path == "/v1/attachments/40500000-1111-4111-8111-111111111111.txt",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token-405", request.httpBody == nil else { unexpected += 1; lock.unlock(); return nil }
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
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set actual iOS MINDWTR_CORE_BUNDLE") }
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
    private func host(faults supplied: HostIOFaults? = nil) -> CoreHost {
        let faults = supplied ?? HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProjectDownloadHTTPProtocol.self]; faults.httpConfiguration = configuration
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        if faults.secretStatus == nil { faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : nil } }
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

}
