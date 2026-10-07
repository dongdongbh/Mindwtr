import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class ProjectRelocationState: @unchecked Sendable {
    private let lock = NSLock()
    private var network = 0, secrets = 0, crypto = 0, work = 0, installers = 0
    private var secretOperations: [String] = []
    func networkAttempt() { lock.lock(); network += 1; lock.unlock() }
    func secretAttempt(operation: String? = nil, alias: String? = nil) {
        lock.lock(); defer { lock.unlock() }; secrets += 1
        if let operation, let alias { secretOperations.append(operation + ":" + alias) }
    }
    var cloudReads: [String] { lock.lock(); defer { lock.unlock() }; return secretOperations }
    func cryptoAttempt() { lock.lock(); crypto += 1; lock.unlock() }
    func fileWork(_ installer: Bool) -> Int { lock.lock(); defer { lock.unlock() }; work += 1; if installer { installers += 1 }; return work }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [network, secrets, crypto, work, installers] }
}
private final class ProjectRelocationNoHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var states: [String: ProjectRelocationState] = [:]
    private static var unexpected = 0
    static func set(_ name: String, _ state: ProjectRelocationState?) { lock.lock(); states[name] = state; lock.unlock() }
    static var unexpectedAttempts: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let state = Self.states[request.url?.host ?? ""]
        if state == nil { Self.unexpected += 1 }; Self.lock.unlock()
        state?.networkAttempt()
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

/// Synthetic single-container moves are macOS-only. Actual iPhone reinstall
/// mapping is root's separate physical acceptance; these never rebase old IO.
final class NativeProjectRelocationAvailabilityTests: XCTestCase {
    private var fixture: URL!, root: URL!, bundle: URL!
    private var hostname: String!, namespace: String!, state: ProjectRelocationState!
    private var cloudSecretReads = false
    private var cloudService = ""
    private var unexpectedBaseline: Int?
    private enum CloudProviderMode { case missing, blank, selfHosted }
    private let projectID = "project368", attachmentID = "852d70cf-303a-47d0-98cb-d16de850a94d"
    private let at = "2026-10-07T12:00:00.000Z", bytes = Data("Verified relocated Project bytes / 文\n".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private var manifest: URL { root.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    override func setUpWithError() throws {
        #if os(iOS)
        throw XCTSkip("Synthetic nested container moves are macOS-only; actual iOS UUID move is separate physical acceptance")
        #else
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Set actual iOS host bundle") }
        guard FileManager.default.isReadableFile(atPath: source) else { throw HostFailure("Project relocation bundle unavailable") }
        bundle = URL(fileURLWithPath: source)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("NativeProjectRelocationTests/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(dir.path, nil) else { throw HostFailure("Project relocation fixture unavailable") }
        defer { free(physical) }; fixture = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        root = fixture.appendingPathComponent("Application/" + UUID().uuidString.lowercased() + "/Library/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        hostname = "project368-" + UUID().uuidString.lowercased() + ".invalid"
        namespace = "tech.dongdongbh.mindwtr.project368." + UUID().uuidString.lowercased()
        cloudSecretReads = false; cloudService = "mindwtr.native-keychain.fixture.project403." + UUID().uuidString.lowercased()
        state = ProjectRelocationState(); ProjectRelocationNoHTTP.set(hostname, state)
        unexpectedBaseline = ProjectRelocationNoHTTP.unexpectedAttempts
        #endif
    }
    override func tearDownWithError() throws {
        if let unexpectedBaseline { XCTAssertEqual(ProjectRelocationNoHTTP.unexpectedAttempts, unexpectedBaseline, "No intercepted HTTP attempt may escape the registered fixture destination") }
        if let state {
            XCTAssertEqual(state.counts[0], 0); XCTAssertEqual(state.counts[2], 0); XCTAssertEqual(state.counts[4], 0)
            if cloudSecretReads {
                XCTAssertEqual(state.cloudReads.count, state.counts[1])
                XCTAssertTrue(state.cloudReads.allSatisfy { ["get:no-auth", "get:auth", "get:legacy"].contains($0) })
            } else { XCTAssertEqual(state.counts[1], 0) }
        }
        if let hostname { ProjectRelocationNoHTTP.set(hostname, nil) }
        if let fixture { try FileManager.default.removeItem(at: fixture) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func sql(_ command: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }; return try db.execute(command, parametersJSON: json(parameters))
    }
    private func row() throws -> [String: Any] {
        try XCTUnwrap((NativeJSON.jsonObject(with: Data(sql("SELECT rowid AS _rowid,* FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])?.first)
    }
    private func selected() throws -> [String: Any] {
        let value = try row(); return try XCTUnwrap((NativeJSON.jsonObject(with: Data(XCTUnwrap(value["attachments"] as? String).utf8)) as? [[String: Any]])?.first)
    }
    private func rows() throws -> [String] {
        try ["projects", "tasks", "sections", "areas", "people", "settings", "saved_filters", "calendar_sync"].map {
            try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \($0) ORDER BY \($0 == "calendar_sync" ? "task_id,platform" : "id")").utf8)))
        }
    }
    private func inode(_ uri: URL) throws -> String {
        var entry = Darwin.stat(); guard lstat(uri.path, &entry) == 0 else { throw HostFailure("Fixture generation unavailable") }
        return "\(UInt64(entry.st_dev)):\(UInt64(entry.st_ino))"
    }
    private func hash(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
    private func markers(_ receipt: String = "v1.3.5/ios-relocated-project-availability") throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log, encoding: .utf8).components(separatedBy: receipt).count - 1
    }
    private func host(_ faults: HostIOFaults = HostIOFaults(), mutation: ((Int) -> Void)? = nil,
                      before: ((Int) throws -> Void)? = nil) async -> CoreHost {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ProjectRelocationNoHTTP.self]; faults.httpConfiguration = config
        let cloud = cloudSecretReads
        if cloud { faults.secretService = cloudService }
        faults.secretBeforeOperation = { [state] operation, alias in
            state?.secretAttempt(operation: cloud ? operation : nil, alias: cloud ? alias : nil)
        }
        faults.secretStatus = { _, _ in errSecItemNotFound }
        faults.cryptoBeforeOperation = { [state] _ in state?.cryptoAttempt() }
        let live = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: root, bundleIdentifier: namespace))
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { [state] jobs in
            if let before { jobs.beforeWork = { _, installer in try before(installer ? -1 : (state?.counts[3] ?? 0) + 1) } }
            jobs.afterWork = { _, installer in let count = state?.fileWork(installer) ?? 0; mutation?(count) }
        }
        await live.configureAttachmentHost(hooks); addTeardownBlock { await live.close() }; return live
    }
    private func seed(status: String = "active") async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "webdav", "@mindwtr_webdav_url": "https://" + hostname + "/data.json",
            "@mindwtr_webdav_username": "synthetic", "@mindwtr_webdav_allow_insecure_http": "false", "unknown": "preserve"]).utf8).write(to: manifest)
        let boot = await host(); _ = try await boot.start(); await boot.close()
        let item: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Original.txt", "uri": target.absoluteString,
            "cloudKey": "attachments/" + attachmentID + ".txt", "fileHash": hash(bytes).uppercased(), "size": bytes.count,
            "contentRev": 4, "contentMtimeMs": 123, "contentSize": bytes.count, "pendingContentUpload": false,
            "localStatus": "missing", "createdAt": at, "updatedAt": at]
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy,viewSectionIds) VALUES (?,'Preserve Project',?,'#94a3b8','Original notes',1,NULL,0,0,?,?,?,3,'fixture','[]')", [projectID, status, json([item]), at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES ('other','Other Project','waiting','#123456','Unchanged',2,'[]',0,0,NULL,?,?,2,'fixture')", [at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('other-task','Unchanged','inbox','[]','[]',?,?,1,'fixture',0,0,0,0)", [at, at])
        let setup = await host(); _ = try await setup.start()
        let filter = try object(await setup.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        XCTAssertEqual(option["state"] as? String, "none")
        _ = try await setup.call("setAreaFilter", argumentsJSON: json([json(XCTUnwrap(option["next"]))])); await setup.close()
        // Establish settled raw authority before the operation. Initial loader
        // preference normalization is historical and is not this command's proof.
        _ = try sql("UPDATE projects SET attachments=?,tagIds=NULL,viewSectionIds='[]' WHERE id=?", [json([item]), projectID])
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true); try bytes.write(to: target)
    }
    private func retainedCloudState() throws -> String {
        try json(["state": "enabled", "discoveredSalt": "0102030405060708090a0b0c0d0e0f10",
            "discoveredParams": ["mKib": 64, "t": 1, "p": 1],
            "discoveredScope": try json(["webdav", "https://other403.invalid/data.json", "synthetic"])])
    }
    private func configureCloud(_ provider: CloudProviderMode) throws {
        var config = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        config["@mindwtr_sync_backend"] = "cloud"; config["@mindwtr_cloud_url"] = "https://" + hostname + "/v1/data"
        config["@mindwtr_cloud_allow_insecure_http"] = "false"
        config["@mindwtr_cloud_token"] = "synthetic-relocation-token-403"
        config["@mindwtr_sync_encryption_state_v1"] = try retainedCloudState()
        switch provider {
        case .missing: config.removeValue(forKey: "@mindwtr_cloud_provider")
        case .blank: config["@mindwtr_cloud_provider"] = " \t\n"
        case .selfHosted: config["@mindwtr_cloud_provider"] = "selfhosted"
        }
        try Data(json(config).utf8).write(to: manifest, options: .atomic); cloudSecretReads = true
    }
    private func relocate(copy: Bool = false) throws -> URL {
        let original = root.deletingLastPathComponent().deletingLastPathComponent()
        let next = original.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        let suffix = String(root.path.dropFirst(original.path.count))
        if copy { try FileManager.default.copyItem(at: original, to: next) } else { try FileManager.default.moveItem(at: original, to: next) }
        let old = target; root = URL(fileURLWithPath: next.path + suffix, isDirectory: true); return old
    }
    private func input(_ live: CoreHost) async throws -> String {
        let options = try object(await live.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        return try json(["projectId": projectID, "attachmentId": attachmentID, "revision": XCTUnwrap(options["revision"] as? String)])
    }
    private func replaceSelected(_ mutate: (inout [String: Any]) -> Void) throws {
        var item = try selected(); mutate(&item); _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([item]), projectID])
    }
    private func refused(_ live: CoreHost, request: String, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            let reply = try object(await live.foregroundSync(command: "projectAttachmentDownload", requestJSON: request))
            XCTAssertFalse(reply["ok"] as? Bool == true && (reply["value"] as? [String: Any])?["status"] as? String == "available", file: file, line: line)
        } catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line) }
    }
    func testLiveSelectedSavePreservesRawFalseNullAndActualColdCoreHostOpen() async throws { try await saveAndCold(status: "active") }
    func testArchivedSelectedSavePreservesRawFalseNullAndActualColdCoreHostOpen() async throws { try await saveAndCold(status: "archived") }
    func testCloudKeylessHashedLocalSelectionPreservesRawMetadataAndColdOpenWithoutRemoteFallback() async throws { try await saveAndCold(status: "active", cloudKey: false) }
    func testMissingCloudProviderRelocatesAndColdOpensWithoutMigrationOrRemoteFallback() async throws { try await saveAndCold(status: "active", cloudProvider: .missing) }
    func testBlankCloudProviderRelocatesAndColdOpensWithoutMigrationOrRemoteFallback() async throws { try await saveAndCold(status: "active", cloudProvider: .blank) }
    func testSelfHostedCloudProviderRelocatesAndColdOpensWithoutMigrationOrRemoteFallback() async throws { try await saveAndCold(status: "active", cloudProvider: .selfHosted) }
    private func saveAndCold(status: String, cloudKey: Bool = true, cloudProvider: CloudProviderMode? = nil) async throws {
        try await seed(status: status)
        if let cloudProvider { try configureCloud(cloudProvider) }
        if !cloudKey { try replaceSelected { $0.removeValue(forKey: "cloudKey") } }
        let old = try relocate(copy: true)
        let oldBytes = Data("Coexisting old bytes must remain unmanaged".utf8); try oldBytes.write(to: old)
        let oldIdentity = try inode(old), currentIdentity = try inode(target), preferences = try Data(contentsOf: manifest)
        let live = await host(); _ = try await live.start(); let before = try row(), others = try rows().dropFirst(), original = try selected()
        XCTAssertEqual(original["pendingContentUpload"] as? Bool, false); XCTAssertTrue(before["tagIds"] is NSNull); XCTAssertEqual(before["viewSectionIds"] as? String, "[]")
        let answer = try object(await live.foregroundSync(command: "projectAttachmentDownload", requestJSON: input(live)))
        XCTAssertEqual(answer["ok"] as? Bool, true); let result = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertEqual(Set(result.keys), Set(["status", "message", "update"])); XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["message"] is NSNull); XCTAssertTrue(result["update"] is NSNull)
        let after = try row(); var expected = original; expected["uri"] = target.absoluteString; expected["localStatus"] = "available"
        XCTAssertEqual(try json(selected()), try json(expected)); XCTAssertEqual(after["rev"] as? Int, 4)
        for name in before.keys where !["attachments", "rev", "revBy", "updatedAt"].contains(name) { XCTAssertEqual(try json(after[name] as Any), try json(before[name] as Any), name) }
        XCTAssertEqual(Array(try rows().dropFirst()), Array(others)); XCTAssertEqual(try Data(contentsOf: manifest), preferences)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
        XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readVersioned())
        await live.close(); XCTAssertEqual(try markers(), 1)
        if cloudProvider != nil { XCTAssertEqual(try markers("v1.3.5/ios-selfhosted-file-availability"), 1) }
        let cold = await host(); _ = try await cold.start()
        XCTAssertEqual(try json(row()), try json(after), "A fresh CoreHost must not normalize the acknowledged raw AFTER")
        XCTAssertEqual(try selected()["pendingContentUpload"] as? Bool, false)
        let open = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": attachmentID])))
        XCTAssertEqual(open["status"] as? String, "available"); XCTAssertEqual((open["open"] as? [String: Any])?["uri"] as? String, target.absoluteString)
        XCTAssertEqual(try json(row()), try json(after)); XCTAssertEqual(try Data(contentsOf: old), oldBytes)
        XCTAssertEqual(try Data(contentsOf: manifest), preferences); await cold.close(); XCTAssertEqual(try markers(), 1)
        if cloudProvider != nil {
            XCTAssertEqual(try markers("v1.3.5/ios-selfhosted-file-availability"), 1)
            let config = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
            XCTAssertEqual(config["@mindwtr_sync_encryption_state_v1"] as? String, try retainedCloudState())
            XCTAssertEqual(config["@mindwtr_cloud_token"] as? String, "synthetic-relocation-token-403")
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity); XCTAssertEqual(try inode(old), oldIdentity)
            XCTAssertGreaterThan(state.counts[1], 0, "A saved cloud owner must compare its real native read-only token snapshot")
        }
    }
    func testCloudURLProviderAndLegacyTokenChangesAcrossRelocatedProofRefuseWithoutWrite() async throws {
        try await seed(); try configureCloud(.selfHosted); let old = try relocate(copy: true)
        let oldBytes = Data("Coexisting old cloud bytes must remain unmanaged".utf8); try oldBytes.write(to: old)
        let oldIdentity = try inode(old), currentIdentity = try inode(target), config = try Data(contentsOf: manifest)
        for field in ["@mindwtr_cloud_url", "@mindwtr_cloud_provider", "@mindwtr_cloud_token"] {
            var armed = false, changed = false, failed = false, holdAt = Int.max, changedConfig: Data?
            let live = await host(mutation: { count in
                guard armed && !changed && count == holdAt else { return }; changed = true
                do {
                    var value = try self.object(String(decoding: config, as: UTF8.self))
                    switch field {
                    case "@mindwtr_cloud_url": value[field] = "https://" + self.hostname + "/changed/v1/data"
                    case "@mindwtr_cloud_provider": value[field] = "dropbox"
                    default: value[field] = "synthetic-intervening-token-403"
                    }
                    let updated = Data(try self.json(value).utf8); try updated.write(to: self.manifest, options: .atomic); changedConfig = updated
                } catch { failed = true }
            })
            _ = try await live.start(); let request = try await input(live), before = try rows(), selectedRow = try json(row())
            holdAt = state.counts[3] + 1; armed = true
            await refused(live, request: request)
            XCTAssertTrue(changed, field); XCTAssertFalse(failed, field); XCTAssertGreaterThanOrEqual(state.counts[3], holdAt)
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try json(row()), selectedRow)
            let preservedConfig = try XCTUnwrap(changedConfig); XCTAssertEqual(try Data(contentsOf: manifest), preservedConfig)
            XCTAssertEqual(try object(String(decoding: preservedConfig, as: UTF8.self))["@mindwtr_sync_encryption_state_v1"] as? String, try retainedCloudState())
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
            XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
            XCTAssertEqual(try markers(), 0); XCTAssertEqual(try markers("v1.3.5/ios-selfhosted-file-availability"), 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readVersioned())
            await live.close()
            let cold = await host(); _ = try await cold.start()
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try json(row()), selectedRow); XCTAssertEqual(try Data(contentsOf: manifest), preservedConfig)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
            XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
            await cold.close(); XCTAssertEqual(try markers(), 0); XCTAssertEqual(try markers("v1.3.5/ios-selfhosted-file-availability"), 0)
            // Reset only the mutated synthetic configuration between independent proof windows.
            try config.write(to: manifest)
        }
        XCTAssertGreaterThan(state.counts[1], 0, "The changed owner must have captured the native token snapshot")
    }
    func testIncompleteCloudTransitionRefusesRelocatedProofBeforeFileWorkAcrossColdOpen() async throws {
        try await seed(); try configureCloud(.selfHosted)
        var config = try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self))
        config["@mindwtr_sync_encryption_state_v1"] = try json(["state": "off", "incompleteTransition": "enable"])
        try Data(json(config).utf8).write(to: manifest, options: .atomic)
        let old = try relocate(copy: true), oldBytes = Data("Preserve old incomplete-transition bytes".utf8); try oldBytes.write(to: old)
        let oldIdentity = try inode(old), currentIdentity = try inode(target), preferences = try Data(contentsOf: manifest)
        let baseline = try rows(), selectedRow = try json(row())
        for _ in 0..<2 {
            var armed = false, proofAttempts = 0
            let live = await host(before: { _ in if armed { proofAttempts += 1 } })
            _ = try await live.start(); let request = try await input(live), work = state.counts[3]; armed = true
            await refused(live, request: request); armed = false
            XCTAssertEqual(proofAttempts, 0, "Incomplete cloud state must reject before the first native file worker")
            XCTAssertEqual(state.counts[3], work); XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try json(row()), selectedRow)
            XCTAssertEqual(try Data(contentsOf: manifest), preferences)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try inode(target), currentIdentity)
            XCTAssertEqual(try Data(contentsOf: old), oldBytes); XCTAssertEqual(try inode(old), oldIdentity)
            XCTAssertEqual(try markers(), 0); XCTAssertEqual(try markers("v1.3.5/ios-selfhosted-file-availability"), 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readVersioned())
            await live.close()
        }
    }
    func testMissingHashSizeFilenameAndEightMiBCapRefuseWithoutFallbackOrWrite() async throws {
        try await seed(); _ = try relocate()
        let original = try selected(), settings = try Data(contentsOf: manifest)
        for mode in ["missing", "hashless", "hash", "size", "filename", "cap", "null"] {
            _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([original]), projectID]); try bytes.write(to: target)
            switch mode {
            case "missing": try FileManager.default.removeItem(at: target)
            case "hashless": try replaceSelected { $0.removeValue(forKey: "fileHash") }
            case "hash": try replaceSelected { $0["fileHash"] = String(repeating: "a", count: 64) }
            case "size": try replaceSelected { $0["size"] = self.bytes.count + 1 }
            case "filename": try replaceSelected { $0["cloudKey"] = "attachments/" + self.attachmentID + ".pdf" }
            case "cap": try Data(count: 8_388_609).write(to: target)
            default: break
            }
            // Wrong generation metadata must already be in this fresh host's
            // captured selection, rather than merely disagreeing with memory.
            let live = await host(); _ = try await live.start()
            if mode == "null" { try replaceSelected { $0["pendingContentUpload"] = NSNull() } }
            let before = try rows(), request = try await input(live)
            await refused(live, request: request); XCTAssertEqual(try rows(), before, mode); XCTAssertEqual(try Data(contentsOf: manifest), settings)
            XCTAssertEqual(try markers(), 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await live.close()
        }
    }
    func testForeignExtraContainerAnchorLibraryAndUnsafeURIRefuseBeforeFileWork() async throws {
        try await seed(); let old = try relocate(); let live = await host(); _ = try await live.start(); let original = try selected()
        let foreign = old.absoluteString.replacingOccurrences(of: "/Application/", with: "/Foreign/")
        let changedLibrary = old.absoluteString.replacingOccurrences(of: root.lastPathComponent, with: UUID().uuidString.lowercased())
        for uri in [foreign, changedLibrary, old.absoluteString.replacingOccurrences(of: "/Library/", with: "/Application/" + UUID().uuidString.lowercased() + "/Library/"), old.absoluteString + "?query=1", old.absoluteString.replacingOccurrences(of: "/attachments/", with: "/attachments/../attachments/")] {
            var item = original; item["uri"] = uri; _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([item]), projectID])
            let before = try rows(), work = state.counts[3]; await refused(live, request: try await input(live))
            XCTAssertEqual(try rows(), before); XCTAssertEqual(state.counts[3], work); XCTAssertEqual(try markers(), 0)
        }
        await live.close()
    }
    func testSymlinkHardlinkAndDirectoryTargetsCannotBecomeAvailable() async throws {
        try await seed(); _ = try relocate(); let live = await host(); _ = try await live.start()
        for mode in ["symlink", "hardlink", "directory"] {
            try FileManager.default.removeItem(at: target)
            let elsewhere = root.appendingPathComponent("outside.txt"); try bytes.write(to: elsewhere)
            if mode == "symlink" { try FileManager.default.createSymbolicLink(at: target, withDestinationURL: elsewhere) }
            else if mode == "hardlink" { XCTAssertEqual(link(elsewhere.path, target.path), 0) }
            else { try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false) }
            let before = try rows(); await refused(live, request: try await input(live)); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: elsewhere), bytes)
            try FileManager.default.removeItem(at: elsewhere); XCTAssertEqual(try markers(), 0)
        }
        await live.close()
    }
    func testSelectedRawRowDeviceConfigAndNewSidecarChangesAcrossProofRefuse() async throws {
        try await seed(); _ = try relocate()
        for mode in ["title", "order", "revision", "revBy", "attachment", "false", "device", "config", "editor", "sidecar", "rowid"] {
            let baseline = try row(), settings = try sql("SELECT data FROM settings WHERE id=1"), config = try Data(contentsOf: manifest)
            var changed = false, failed = false
            let live = await host(mutation: { _ in
                guard !changed else { return }; changed = true
                do {
                    switch mode {
                    case "title": _ = try self.sql("UPDATE projects SET title='Intervening' WHERE id=?", [self.projectID])
                    case "order": _ = try self.sql("UPDATE projects SET orderNum=99 WHERE id=?", [self.projectID])
                    case "revision": _ = try self.sql("UPDATE projects SET rev=98 WHERE id=?", [self.projectID])
                    case "revBy": _ = try self.sql("UPDATE projects SET revBy='other' WHERE id=?", [self.projectID])
                    case "attachment": try self.replaceSelected { $0["title"] = "Intervening" }
                    case "false": try self.replaceSelected { $0.removeValue(forKey: "pendingContentUpload") }
                    case "device": let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(settings.utf8)) as? [[String: Any]]); var value = try self.object(XCTUnwrap(rows[0]["data"] as? String)); value["deviceId"] = "other"; _ = try self.sql("UPDATE settings SET data=? WHERE id=1", [self.json(value)])
                    case "config": var value = try self.object(String(decoding: config, as: UTF8.self)); value["@mindwtr_webdav_url"] = "https://different.invalid/data.json"; try Data(self.json(value).utf8).write(to: self.manifest, options: .atomic)
                    case "editor": try Data("retained editor evidence".utf8).write(to: EditorDraftStore(databaseURL: self.database).url)
                    case "sidecar": try Data("retained owner evidence".utf8).write(to: NativeAttachmentDraftStore(databaseURL: self.database).url)
                    default:
                        let fields = baseline.keys.filter { $0 != "_rowid" }.sorted()
                        _ = try self.sql("DELETE FROM projects WHERE id=?", [self.projectID])
                        _ = try self.sql("INSERT INTO projects(" + fields.joined(separator: ",") + ") VALUES(" + fields.map { _ in "?" }.joined(separator: ",") + ")", fields.map { baseline[$0]! })
                    }
                } catch { failed = true }
            })
            _ = try await live.start(); let request = try await input(live); await refused(live, request: request)
            XCTAssertTrue(changed, mode); XCTAssertFalse(failed, mode); XCTAssertEqual(try markers(), 0); await live.close()
            // Reset only synthetic setup for the next independent mutation case.
            for url in [EditorDraftStore(databaseURL: database).url, NativeAttachmentDraftStore(databaseURL: database).url] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            let names = baseline.keys.filter { $0 != "_rowid" }.sorted(); _ = try sql("UPDATE projects SET " + names.map { "\($0)=?" }.joined(separator: ",") + " WHERE id=?", names.map { baseline[$0]! } + [projectID])
            let savedSettings = try XCTUnwrap((NativeJSON.jsonObject(with: Data(settings.utf8)) as? [[String: Any]])?.first?["data"] as? String)
            _ = try sql("UPDATE settings SET data=? WHERE id=1", [savedSettings]); try config.write(to: manifest)
        }
    }
    func testEntryAndParentReplacementRefuseFinalPhysicalAcknowledgment() async throws {
        try await seed(); _ = try relocate()
        for mode in ["entry", "parent"] {
            let baseline = try row(); var changed = false, failed = false
            let live = await host(mutation: { _ in
                guard !changed else { return }; changed = true
                do {
                    if mode == "entry" { try self.bytes.write(to: self.target, options: .atomic) }
                    else { let old = self.root.appendingPathComponent("displaced-" + UUID().uuidString.lowercased(), isDirectory: true); try FileManager.default.moveItem(at: self.managed, to: old); try FileManager.default.copyItem(at: old, to: self.managed) }
                } catch { failed = true }
            })
            _ = try await live.start(); await refused(live, request: try await input(live)); XCTAssertTrue(changed); XCTAssertFalse(failed); XCTAssertEqual(try markers(), 0); XCTAssertEqual(try Data(contentsOf: target), bytes); await live.close()
            let names = baseline.keys.filter { $0 != "_rowid" }.sorted(); _ = try sql("UPDATE projects SET " + names.map { "\($0)=?" }.joined(separator: ",") + " WHERE id=?", names.map { baseline[$0]! } + [projectID])
        }
    }
    func testFailedCommitAcknowledgmentNeverReturnsAvailableOrEmitsRelocationMarker() async throws {
        try await seed(); _ = try relocate(); let faults = HostIOFaults(); var armed = false, acknowledgments = 0
        // Keep every matching ACK unavailable, as in the existing Project
        // download fault fixture; a one-shot fault permits a real writer retry.
        faults.afterSQL = { sql in if armed && sql == "COMMIT", try self.selected()["uri"] as? String == self.target.absoluteString {
            acknowledgments += 1; throw HostFailure("Synthetic lost Project acknowledgment")
        } }
        let live = await host(faults); _ = try await live.start(); let request = try await input(live); armed = true
        await refused(live, request: request); XCTAssertGreaterThan(acknowledgments, 0, "The real final COMMIT hook must fire"); XCTAssertEqual(try markers(), 0); await live.close()
        let cold = await host(); _ = try await cold.start(); XCTAssertEqual(state.counts[0], 0); await cold.close()
    }
    func testPendingJournalEditorAndOwnerEvidenceRefuseBeforeCurrentFileProof() async throws {
        try await seed(); _ = try relocate(); let live = await host(); _ = try await live.start(); let request = try await input(live), baseline = try rows()
        for url in [journal, EditorDraftStore(databaseURL: database).url, NativeAttachmentDraftStore(databaseURL: database).url] {
            let evidence = Data("Preserve pending authority".utf8); try evidence.write(to: url); let identity = try inode(url), work = state.counts[3]
            await refused(live, request: request); XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try Data(contentsOf: url), evidence); XCTAssertEqual(try inode(url), identity); XCTAssertEqual(state.counts[3], work); XCTAssertEqual(try markers(), 0)
            try FileManager.default.removeItem(at: url)
        }
        await live.close()
    }
    func testCancellationDrainsHeldProofWithoutAvailabilityWrite() async throws { try await cancelOrClose(close: false) }
    func testCloseDrainsHeldProofBeforeLibraryReleaseWithoutAvailabilityWrite() async throws { try await cancelOrClose(close: true) }
    func testCancellationDrainsSelectedJSCReadTicketBeforeLaterExplicitRetry() async throws { try await cancelOrClose(close: false, selectedRead: true) }
    private func cancelOrClose(close: Bool, selectedRead: Bool = false) async throws {
        try await seed(); _ = try relocate(); let reached = expectation(description: "Proof worker accepted"), release = DispatchSemaphore(value: 0)
        var entered = false, holdAt = Int.max
        let live = await host(before: { count in if !entered && count == holdAt { entered = true; reached.fulfill(); release.wait() } })
        _ = try await live.start(); let request = try await input(live), baseline = try rows()
        // The first work item is the typed baseline proof. The second is the
        // shared resolver's getInfo, inside its admitted selected-JSC ticket.
        holdAt = state.counts[3] + (selectedRead ? 2 : 1)
        let operation = Task { try await live.foregroundSync(command: "projectAttachmentDownload", requestJSON: request) }
        await fulfillment(of: [reached], timeout: 10)
        let closing = close ? Task { await live.close() } : nil
        operation.cancel(); release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled proof must not report availability") } catch {}
        if let closing { await closing.value }; XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try markers(), 0); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertGreaterThanOrEqual(state.counts[3], holdAt, "The held native worker must settle before return")
        if selectedRead {
            let retry = try object(await live.foregroundSync(command: "projectAttachmentDownload", requestJSON: input(live)))
            XCTAssertEqual(retry["ok"] as? Bool, true); XCTAssertEqual((retry["value"] as? [String: Any])?["status"] as? String, "available")
            XCTAssertEqual(try selected()["uri"] as? String, target.absoluteString)
        }
        await live.close()
        XCTAssertEqual(try markers(), selectedRead ? 1 : 0)
    }
}
