import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CachedProjectHTTPState: @unchecked Sendable {
    let lock = NSLock()
    var bytes = Data()
    private var requests = 0, unexpected = 0
    func reply(_ request: URLRequest) -> Data? {
        lock.lock(); defer { lock.unlock() }; requests += 1
        guard request.httpMethod == "GET", request.url?.path == "/v1/attachments/41000000-1111-4111-8111-111111111111.txt",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token-410", request.httpBody == nil else { unexpected += 1; return nil }
        return bytes
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [requests, unexpected] }
}
private final class CachedProjectHTTPProtocol: URLProtocol {
    static let lock = NSLock()
    private static var states: [String: CachedProjectHTTPState] = [:]
    private static var unexpected = 0
    static func register(_ name: String, _ state: CachedProjectHTTPState?) { lock.lock(); defer { lock.unlock() }; states[name] = state }
    static var unknown: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.states[request.url?.host ?? ""]
        if state == nil { Self.unexpected += 1 }; Self.lock.unlock()
        guard let state, let bytes = state.reply(request), let url = request.url else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(bytes.count)])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Existing managed bytes are borrowed read-only; only selected metadata may change.
final class NativeCachedProjectAvailabilityTests: XCTestCase {
    private var root: URL!, bundle: URL!, hostname: String!, namespace: String!, remote: CachedProjectHTTPState!
    private var unknownBefore = 0
    private let projectID = "cached-project-410", attachmentID = "41000000-1111-4111-8111-111111111111"
    private let at = "2026-10-07T12:00:00.000Z", bytes = Data([0, 255, 128, 7]) + Data("Cached Project / 文\n".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set actual iOS MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let candidate = base.appendingPathComponent("NativeCachedProjectAvailabilityTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        hostname = "cached410-" + UUID().uuidString.lowercased() + ".invalid"
        namespace = "tech.dongdongbh.mindwtr.cached410." + UUID().uuidString.lowercased()
        remote = CachedProjectHTTPState(); remote.bytes = bytes
        unknownBefore = CachedProjectHTTPProtocol.unknown; CachedProjectHTTPProtocol.register(hostname, remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(remote?.counts[1], 0); XCTAssertEqual(CachedProjectHTTPProtocol.unknown, unknownBefore)
        if let hostname { CachedProjectHTTPProtocol.register(hostname, nil) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func host(faults supplied: HostIOFaults? = nil) -> CoreHost {
        let faults = supplied ?? HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CachedProjectHTTPProtocol.self]; faults.httpConfiguration = configuration
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        if faults.secretStatus == nil { faults.secretStatus = { operation, _ in operation == "get" ? errSecItemNotFound : nil } }
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func started(faults: HostIOFaults? = nil, before: ((String, Bool) throws -> Void)? = nil,
                         after: ((String, Bool) -> Void)? = nil) async throws -> CoreHost {
        let core = host(faults: faults), hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { $0.beforeWork = before; $0.afterWork = after }
        // Jobs receive hooks during start; changing attachmentHooks afterwards
        // does not reconfigure an already-created worker.
        try await core.configureAttachmentHost(hooks); _ = try await core.start(); return core
    }
    private func sql(_ text: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }; return try db.execute(text, parametersJSON: json(args))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS _rowid,* FROM projects ORDER BY id").utf8))) }
    private func domainRows() throws -> [String] {
        try ["projects", "tasks", "sections", "areas", "people", "settings", "saved_filters", "calendar_sync"].map {
            try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \($0) ORDER BY \($0 == "calendar_sync" ? "task_id,platform" : "id")").utf8)))
        } + [rows()]
    }
    private func unrelatedRows() throws -> [String] {
        let all = try domainRows()
        return try [1, 2, 3, 4, 6, 7].map { all[$0] } + [sql("SELECT rowid AS _rowid,* FROM projects WHERE id<>? ORDER BY id", [projectID])]
    }
    private func project() throws -> [String: Any] { try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS _rowid,* FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])?.first) }
    private func selected() throws -> [String: Any] { try XCTUnwrap((NativeJSON.jsonObject(with: Data(XCTUnwrap(project()["attachments"] as? String).utf8)) as? [[String: Any]])?.first) }
    private func inode(_ url: URL) throws -> String { var info = stat(); guard lstat(url.path, &info) == 0 else { throw HostFailure("Fixture identity unavailable") }; return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))" }
    private func fileState(_ url: URL) throws -> String {
        var info = stat(); guard lstat(url.path, &info) == 0 else { throw HostFailure("Fixture state unavailable") }
        var result: [String: Any] = ["identity": try inode(url), "mode": UInt32(info.st_mode), "links": UInt64(info.st_nlink), "size": Int64(info.st_size)]
        switch info.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFREG): result["digest"] = SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
        case mode_t(S_IFLNK): result["destination"] = try FileManager.default.destinationOfSymbolicLink(atPath: url.path)
        case mode_t(S_IFDIR): result["entries"] = try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
        default: break
        }
        return try json(result)
    }
    private func replaceSelected(_ mutate: (inout [String: Any]) -> Void) throws {
        var item = try selected(); mutate(&item)
        _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([item]), projectID])
    }
    private func updateManifest(_ mutate: (inout [String: Any]) throws -> Void) throws -> Data {
        var value = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)); try mutate(&value)
        let encoded = Data(try json(value).utf8); try encoded.write(to: manifest, options: .atomic); return encoded
    }
    private func seed(status: String = "active", sameURI: Bool = false, present: Bool = true) async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "cloud", "@mindwtr_cloud_provider": "selfhosted", "@mindwtr_cloud_url": "https://" + hostname + "/v1/data/",
            "@mindwtr_cloud_allow_insecure_http": "false", "@mindwtr_cloud_token": "synthetic-token-410", "unknown": "Preserve fixture preference"]).utf8).write(to: manifest)
        let initial = host(); _ = try await initial.start(); await initial.close()
        let item: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Original.txt", "uri": sameURI ? target.absoluteString : "",
            "size": bytes.count, "mimeType": "text/plain", "createdAt": at, "updatedAt": at, "cloudKey": "attachments/" + attachmentID + ".txt",
            "fileHash": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined().uppercased(), "contentRev": 7, "localStatus": "missing"]
        _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Preserved Project',?,'#123456',1,'[]',0,0,'Preserved notes',?,?,?,3,'fixture')", [projectID, status, json([item]), at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,createdAt,updatedAt,rev,revBy) VALUES ('sibling','Sibling','waiting','#abcdef',2,'[]',0,0,?,?,4,'fixture')", [at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('sibling-task','Unchanged','inbox','[]','[]',?,?,1,'fixture',0,0,0,0)", [at, at])
        if present { try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target) }
    }
    private func request(_ core: CoreHost) async throws -> String {
        let options = try object(await core.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        return try json(["projectId": projectID, "attachmentId": attachmentID, "revision": XCTUnwrap(options["revision"] as? String)])
    }
    private func noOwnedArtifacts() throws {
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readVersioned())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), [])
    }
    private func cachedMarkers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        if !FileManager.default.fileExists(atPath: log.path) { return 0 }
        let lines = try String(contentsOf: log).split(separator: "\n")
        return lines.filter { $0.contains("v1.3.5/ios-cached-project-availability") }.count
    }
    private func assertSelectedUpdate(_ before: [String: Any], item: [String: Any]) throws {
        var expected = item; expected["uri"] = target.absoluteString; expected["localStatus"] = "available"
        XCTAssertEqual(try json(selected()), try json(expected))
        let beforeItems = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(before["attachments"] as? String).utf8)) as? [[String: Any]])
        let afterItems = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(project()["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(try json(afterItems), try json(beforeItems.map { $0["id"] as? String == attachmentID ? expected : $0 }))
        let after = try project(); XCTAssertEqual(after["rev"] as? Int, 4)
        var original = before, actual = after
        for field in ["attachments", "rev", "revBy", "updatedAt"] { original.removeValue(forKey: field); actual.removeValue(forKey: field) }
        XCTAssertEqual(try json(actual), try json(original))
    }
    private func refused(_ core: CoreHost, input: String, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            let answer = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
            XCTAssertFalse(answer["ok"] as? Bool == true && (answer["value"] as? [String: Any])?["status"] as? String == "available", file: file, line: line)
        } catch {
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("synthetic-token-410"), file: file, line: line)
        }
    }

    func testVerifiedEmptyURICachedFileUpdatesOnlyMetadataAndColdOpensWithoutGET() async throws { try await cachedSuccess() }
    func testArchivedCachedFileWithRetainedEncryptionStateUpdatesOnlyMetadataAndColdOpens() async throws { try await cachedSuccess(status: "archived", retainedState: true) }
    func testSameCanonicalURIMissingCachedFileUpdatesOnlyMetadataAndColdOpens() async throws { try await cachedSuccess(sameURI: true) }
    private func cachedSuccess(status: String = "active", sameURI: Bool = false, retainedState: Bool = false) async throws {
        try await seed(status: status, sameURI: sameURI)
        if retainedState {
            _ = try updateManifest { $0["@mindwtr_sync_encryption_state_v1"] = try self.json(["state": "enabled",
                "discoveredSalt": "0102030405060708090a0b0c0d0e0f10", "discoveredParams": ["mKib": 64, "t": 1, "p": 1],
                "discoveredScope": try self.json(["webdav", "https://retained410.invalid/data.json", "synthetic"])]) }
        }
        var armed = false, fileWork = 0, installs = 0, cryptoWork = 0
        let faults = HostIOFaults(); faults.cryptoBeforeOperation = { _ in if armed { cryptoWork += 1 } }
        let core = try await started(faults: faults, after: { _, installer in if armed { if installer { installs += 1 } else { fileWork += 1 } } })
        let input = try await request(core), before = try project(), item = try selected(), identity = try inode(target), settings = try Data(contentsOf: manifest)
        let others = try unrelatedRows()
        armed = true
        let answer = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
        XCTAssertEqual(answer["ok"] as? Bool, true); XCTAssertEqual((answer["value"] as? [String: Any])?["status"] as? String, "available")
        try assertSelectedUpdate(before, item: item); XCTAssertEqual(remote.counts, [0, 0]); XCTAssertEqual(installs, 0); XCTAssertGreaterThan(fileWork, 0)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertEqual(try unrelatedRows(), others); XCTAssertEqual(cryptoWork, 0)
        try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 1)
        let saved = try rows(); await core.close(); let cold = host(); _ = try await cold.start()
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": attachmentID])))
        XCTAssertEqual(opened["status"] as? String, "available"); XCTAssertEqual((opened["open"] as? [String: Any])?["kind"] as? String, "file")
        XCTAssertEqual((opened["open"] as? [String: Any])?["uri"] as? String, target.absoluteString); XCTAssertEqual(try rows(), saved)
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(remote.counts, [0, 0])
    }

    func testProvedAbsentTargetFallsThroughExistingOwnedDownloadWithoutCachedMarker() async throws {
        try await seed(present: false); let core = host(); _ = try await core.start(); let input = try await request(core)
        let answer = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input))
        XCTAssertEqual(answer["ok"] as? Bool, true); XCTAssertEqual((answer["value"] as? [String: Any])?["status"] as? String, "available")
        XCTAssertEqual(remote.counts, [1, 0]); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try selected()["uri"] as? String, target.absoluteString)
        try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0)
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log")); XCTAssertTrue(log.contains("v1.3.5/ios-selfhosted-project-download"))
    }

    func testActualRowChangeAfterCachedProofRefusesAndPreservesExternalRowsAndBytes() async throws {
        try await seed(); var armed = false, fired = false, mutationFailed = false, external: String?
        let core = try await started(after: { _, installer in if armed && !installer && !fired {
            fired = true
            do { _ = try self.sql("UPDATE projects SET title='External preserved title' WHERE id=?", [self.projectID]); external = try self.rows() }
            catch { mutationFailed = true }
        } })
        let input = try await request(core), identity = try inode(target); armed = true
        await refused(core, input: input); armed = false
        XCTAssertTrue(fired); XCTAssertFalse(mutationFailed); XCTAssertEqual(try rows(), try XCTUnwrap(external)); XCTAssertEqual(try selected()["localStatus"] as? String, "missing")
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(remote.counts, [0, 0])
        try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0); _ = try await core.call("areaFilter")
        await core.close(); let cold = host(); _ = try await cold.start(); XCTAssertEqual(try rows(), external)
    }

    func testSameURIAlreadyAvailableRefusesBeforeLocalProofWithoutDebtAcrossColdStart() async throws {
        try await seed(sameURI: true); try replaceSelected { $0["localStatus"] = "available" }
        let baseline = try domainRows(), settings = try Data(contentsOf: manifest), physical = try fileState(target)
        for _ in 0..<2 {
            var armed = false, work = 0
            let core = try await started(before: { _, _ in if armed { work += 1 } })
            let input = try await request(core); armed = true; await refused(core, input: input); armed = false
            XCTAssertEqual(work, 0); XCTAssertEqual(try domainRows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try fileState(target), physical); XCTAssertEqual(remote.counts, [0, 0]); XCTAssertEqual(try cachedMarkers(), 0)
            try noOwnedArtifacts(); _ = try await core.call("areaFilter"); await core.close()
        }
    }

    func testHashlessWrongHashSizeAndUnsafeURICannotFallThroughToRemoteDownload() async throws {
        try await seed(); let original = try selected(), settings = try Data(contentsOf: manifest), physical = try fileState(target)
        for mode in ["hashless", "hash", "size", "cap", "uri"] {
            _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([original]), projectID])
            try replaceSelected {
                switch mode {
                case "hashless": $0.removeValue(forKey: "fileHash")
                case "hash": $0["fileHash"] = String(repeating: "a", count: 64)
                case "size": $0["size"] = self.bytes.count + 1
                case "cap": $0["size"] = 8_388_609
                default: $0["uri"] = "file:///outside410/" + self.attachmentID + ".txt"
                }
            }
            var armed = false, work = 0, installs = 0
            let core = try await started(before: { _, installer in if armed { work += 1; if installer { installs += 1 } } })
            let input = try await request(core), baseline = try domainRows(); armed = true
            await refused(core, input: input); armed = false
            if ["hash", "size", "cap"].contains(mode) { XCTAssertGreaterThan(work, 0, mode) } else { XCTAssertEqual(work, 0, mode) }
            XCTAssertEqual(installs, 0, mode); XCTAssertEqual(try domainRows(), baseline, mode)
            XCTAssertEqual(try fileState(target), physical, mode); XCTAssertEqual(try Data(contentsOf: manifest), settings, mode)
            XCTAssertEqual(remote.counts, [0, 0], mode); try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0, mode)
            await core.close(); let cold = host(); _ = try await cold.start(); XCTAssertEqual(try domainRows(), baseline, mode); await cold.close()
        }
    }

    func testPresentSymlinkHardlinkDirectoryAndOversizeTargetsRefuseWithoutRemoteFallback() async throws {
        try await seed(); let settings = try Data(contentsOf: manifest), outside = root.appendingPathComponent("foreign410.txt")
        try bytes.write(to: outside)
        for mode in ["symlink", "hardlink", "directory", "oversize"] {
            try FileManager.default.removeItem(at: target)
            switch mode {
            case "symlink": try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside)
            case "hardlink": XCTAssertEqual(link(outside.path, target.path), 0)
            case "directory": try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            default: try Data(count: 8_388_609).write(to: target)
            }
            var armed = false, work = 0, installs = 0
            let core = try await started(before: { _, installer in if armed { work += 1; if installer { installs += 1 } } })
            let input = try await request(core), baseline = try domainRows(), physical = try fileState(target), foreign = try fileState(outside); armed = true
            await refused(core, input: input); armed = false
            XCTAssertGreaterThan(work, 0, mode); XCTAssertEqual(installs, 0, mode); XCTAssertEqual(try domainRows(), baseline, mode)
            XCTAssertEqual(try fileState(target), physical, mode); XCTAssertEqual(try fileState(outside), foreign, mode)
            XCTAssertEqual(try Data(contentsOf: manifest), settings, mode); XCTAssertEqual(remote.counts, [0, 0], mode)
            try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0, mode); await core.close()
            let cold = host(); _ = try await cold.start(); XCTAssertEqual(try domainRows(), baseline, mode); await cold.close()
        }
    }

    func testIncompleteTransitionRefusesBeforeProofOrSecretsAcrossColdStart() async throws {
        try await seed()
        let settings = try updateManifest { $0["@mindwtr_sync_encryption_state_v1"] = try self.json(["state": "off", "incompleteTransition": "enable"]) }
        let baseline = try domainRows(), physical = try fileState(target)
        for _ in 0..<2 {
            var armed = false, work = 0, secrets = 0, crypto = 0
            let faults = HostIOFaults(); faults.secretBeforeOperation = { _, _ in if armed { secrets += 1 } }
            faults.cryptoBeforeOperation = { _ in if armed { crypto += 1 } }
            let core = try await started(faults: faults, before: { _, _ in if armed { work += 1 } })
            let input = try await request(core); armed = true; await refused(core, input: input); armed = false
            XCTAssertEqual(work, 0); XCTAssertEqual(secrets, 0); XCTAssertEqual(crypto, 0); XCTAssertEqual(remote.counts, [0, 0])
            XCTAssertEqual(try domainRows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), settings); XCTAssertEqual(try fileState(target), physical)
            try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0); await core.close()
        }
    }

    func testActualEndpointProviderAndLegacyTokenChangesAfterProofPreserveExternalConfiguration() async throws {
        try await seed(); let originalConfig = try Data(contentsOf: manifest), physical = try fileState(target)
        for field in ["@mindwtr_cloud_url", "@mindwtr_cloud_provider", "@mindwtr_cloud_token"] {
            var armed = false, fired = false, failed = false, external: Data?
            let core = try await started(after: { _, installer in if armed && !installer && !fired {
                fired = true
                do { external = try self.updateManifest {
                    switch field {
                    case "@mindwtr_cloud_url": $0[field] = "https://" + self.hostname + "/changed/v1/data"
                    case "@mindwtr_cloud_provider": $0[field] = "dropbox"
                    default: $0[field] = "synthetic-replaced-token-410"
                    }
                } } catch { failed = true }
            } })
            let input = try await request(core), baseline = try domainRows(); armed = true
            // A synthetic external manifest replacement exercises the owner
            // fence. It is not a second admitted NativeDeviceKV writer.
            await refused(core, input: input); armed = false
            XCTAssertTrue(fired, field); XCTAssertFalse(failed, field); let expected = try XCTUnwrap(external)
            XCTAssertEqual(try domainRows(), baseline, field); XCTAssertEqual(try Data(contentsOf: manifest), expected, field)
            XCTAssertEqual(try fileState(target), physical, field); XCTAssertEqual(remote.counts, [0, 0], field)
            try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0, field); _ = try await core.call("areaFilter"); await core.close()
            let cold = host(); _ = try await cold.start()
            XCTAssertEqual(try domainRows(), baseline, field); XCTAssertEqual(try Data(contentsOf: manifest), expected, field)
            XCTAssertEqual(try fileState(target), physical, field); await cold.close()
            try originalConfig.write(to: manifest, options: .atomic)
        }
    }

    func testActualDeviceAndRowIDChangesAfterProofPreserveExactExternalRows() async throws {
        try await seed(); let original = try project(), initialSettings = try sql("SELECT data FROM settings WHERE id=1"), physical = try fileState(target)
        for mode in ["device", "rowid"] {
            var armed = false, fired = false, failed = false, external: [String]?
            let core = try await started(after: { _, installer in if armed && !installer && !fired {
                fired = true
                do {
                    if mode == "device" {
                        let saved = try XCTUnwrap((NativeJSON.jsonObject(with: Data(self.sql("SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])?.first?["data"] as? String)
                        var value = try self.object(saved); value["deviceId"] = "41000000-2222-4222-8222-222222222222"
                        _ = try self.sql("UPDATE settings SET data=? WHERE id=1", [self.json(value)])
                    } else { _ = try self.sql("UPDATE projects SET rowid=rowid+1000 WHERE id=?", [self.projectID]) }
                    external = try self.domainRows()
                } catch { failed = true }
            } })
            let input = try await request(core); armed = true; await refused(core, input: input); armed = false
            XCTAssertTrue(fired, mode); XCTAssertFalse(failed, mode); let expected = try XCTUnwrap(external)
            XCTAssertEqual(try domainRows(), expected, mode); XCTAssertEqual(try selected()["localStatus"] as? String, "missing", mode)
            XCTAssertEqual(try fileState(target), physical, mode); XCTAssertEqual(remote.counts, [0, 0], mode)
            try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0, mode); await core.close()
            let cold = host(); _ = try await cold.start(); XCTAssertEqual(try domainRows(), expected, mode); await cold.close()
            _ = try sql("UPDATE projects SET rowid=? WHERE id=?", [XCTUnwrap(original["_rowid"]), projectID])
            let saved = try XCTUnwrap((NativeJSON.jsonObject(with: Data(initialSettings.utf8)) as? [[String: Any]])?.first?["data"] as? String)
            _ = try sql("UPDATE settings SET data=? WHERE id=1", [saved])
        }
    }

    func testReplacedEntryOrParentNeverReceivesCachedAvailabilityAcknowledgment() async throws {
        try await seed(); let initialRow = try project(), item = try selected(), configuration = try Data(contentsOf: manifest)
        for mode in ["entry", "parent"] {
            var armed = false, fired = false, failed = false, external: String?, displaced: URL?
            let core = try await started(after: { _, installer in if armed && !installer && !fired {
                fired = true
                do {
                    if mode == "entry" { try self.bytes.write(to: self.target, options: .atomic) }
                    else {
                        let old = self.root.appendingPathComponent("displaced410", isDirectory: true)
                        try FileManager.default.moveItem(at: self.managed, to: old); try FileManager.default.copyItem(at: old, to: self.managed); displaced = old
                    }
                    external = try self.fileState(self.target)
                } catch { failed = true }
            } })
            let input = try await request(core); armed = true; await refused(core, input: input); armed = false
            XCTAssertTrue(fired, mode); XCTAssertFalse(failed, mode); XCTAssertEqual(try fileState(target), try XCTUnwrap(external), mode)
            XCTAssertEqual(try Data(contentsOf: target), bytes, mode); XCTAssertEqual(try Data(contentsOf: manifest), configuration, mode)
            XCTAssertEqual(remote.counts, [0, 0], mode); try noOwnedArtifacts(); XCTAssertEqual(try cachedMarkers(), 0, mode)
            // The reused pipeline can have durably saved the exact metadata
            // effect before the final generation proof rejects acknowledgment.
            // It never rolls back that save or claims a confirmed file receipt.
            if try project()["rev"] as? Int == 4 { try assertSelectedUpdate(initialRow, item: item) }
            else { XCTAssertEqual(try json(project()), try json(initialRow), mode) }
            let durable = try domainRows(); await core.close(); let cold = host(); _ = try await cold.start()
            XCTAssertEqual(try domainRows(), durable, mode); XCTAssertEqual(try fileState(target), external, mode); await cold.close()
            if let displaced { XCTAssertEqual(try Data(contentsOf: displaced.appendingPathComponent(target.lastPathComponent)), bytes) }
            let fields = initialRow.keys.filter { $0 != "_rowid" }.sorted()
            _ = try sql("UPDATE projects SET " + fields.map { "\($0)=?" }.joined(separator: ",") + " WHERE id=?", fields.map { initialRow[$0]! } + [projectID])
        }
    }

    func testLostCommitAcknowledgmentNeverReportsCachedConfirmation() async throws {
        try await seed(); var armed = false, acknowledgments = 0
        let faults = HostIOFaults(); faults.afterSQL = { sql in if armed && sql == "COMMIT", try self.selected()["localStatus"] as? String == "available" {
            acknowledgments += 1; throw HostFailure("Synthetic lost cached Project acknowledgment")
        } }
        let core = try await started(faults: faults), input = try await request(core), physical = try fileState(target)
        armed = true; await refused(core, input: input); armed = false
        XCTAssertGreaterThan(acknowledgments, 0); XCTAssertEqual(try cachedMarkers(), 0); XCTAssertEqual(remote.counts, [0, 0])
        XCTAssertEqual(try fileState(target), physical); try noOwnedArtifacts(); let durable = try domainRows(); await core.close()
        let cold = host(); _ = try await cold.start(); XCTAssertEqual(try domainRows(), durable); XCTAssertEqual(try fileState(target), physical)
    }

    func testCancelledSelectedReadDrainsWithoutMetadataAndAllowsExplicitLiveRetry() async throws {
        try await seed(); let reached = expectation(description: "Cached selected file read accepted"), release = DispatchSemaphore(value: 0)
        var armed = false, work = 0, held = false
        let core = try await started(before: { _, installer in if armed && !installer {
            work += 1
            // First work is typed baseline; second is shared getInfo under the
            // admitted selected-JSC read ticket, as in old relocation controls.
            if work == 2 { held = true; reached.fulfill(); release.wait() }
        } })
        let input = try await request(core), baseline = try domainRows(), physical = try fileState(target); armed = true
        let operation = Task { try await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: input) }
        await fulfillment(of: [reached], timeout: 10); operation.cancel(); release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled selected read must not report available") } catch {}
        armed = false; XCTAssertTrue(held); XCTAssertGreaterThanOrEqual(work, 2)
        XCTAssertEqual(try domainRows(), baseline); XCTAssertEqual(try fileState(target), physical); XCTAssertEqual(try cachedMarkers(), 0)
        XCTAssertEqual(remote.counts, [0, 0]); try noOwnedArtifacts()
        let answer = try object(await core.foregroundSync(command: "projectAttachmentDownload", requestJSON: request(core)))
        XCTAssertEqual(answer["ok"] as? Bool, true); XCTAssertEqual((answer["value"] as? [String: Any])?["status"] as? String, "available")
        XCTAssertEqual(try fileState(target), physical); XCTAssertEqual(try cachedMarkers(), 1); try noOwnedArtifacts()
    }

    func testPrivateCachedBridgesCannotBeCalledThroughOrdinaryDispatcher() async throws {
        try await seed(); var armed = false, work = 0
        let core = try await started(before: { _, _ in if armed { work += 1 } })
        let input = try await request(core), baseline = try domainRows(), physical = try fileState(target); armed = true
        for name in ["projectAttachmentCachedAvailabilityPreflight", "projectAttachmentCachedAvailability"] {
            do { _ = try await core.call(name, argumentsJSON: json([input, target.absoluteString])); XCTFail("Private cached bridge must refuse ordinary dispatch") } catch {}
        }
        armed = false; XCTAssertEqual(work, 0); XCTAssertEqual(remote.counts, [0, 0]); XCTAssertEqual(try domainRows(), baseline)
        XCTAssertEqual(try fileState(target), physical); XCTAssertEqual(try cachedMarkers(), 0); try noOwnedArtifacts(); _ = try await core.call("areaFilter")
    }
}
