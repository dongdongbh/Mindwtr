import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// Only the maintained Cloud document route, not a DAV endpoint or a real server.
/// Unknown destinations are intercepted too; this fixture never opens a socket.
private final class SelfHostedDocumentProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var stores: [String: SelfHostedDocumentStore] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ hostname: String, _ store: SelfHostedDocumentStore) { lock.lock(); stores[hostname] = store; lock.unlock() }
    static func remove(_ hostname: String) { lock.lock(); stores.removeValue(forKey: hostname); lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let store = Self.stores[request.url?.host ?? ""]
        if store == nil { Self.unexpected += 1 }
        Self.lock.unlock()
        guard let store, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return
        }
        let reply = store.respond(request, body: upload())
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !reply.body.isEmpty { client?.urlProtocol(self, didLoad: reply.body) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    private func upload() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        return bytes
    }
}

private final class SelfHostedDocumentStore: @unchecked Sendable {
    struct Request { let method: String; let status: Int; let authorized: Bool; let body: Data }
    struct Reply { let status: Int; let headers: [String: String]; let body: Data }
    private let lock = NSLock()
    private let authorization: String
    private var document: Data
    private var requests: [Request] = []
    private var unexpected = 0
    private let getStatus: Int?
    private let declaredGetLength: Int?
    /// Runs before publishing the first accepted PUT or giving its acknowledgement.
    private var beforeFirstPut: (() -> Void)?
    init(token: String, document: Data, getStatus: Int? = nil, declaredGetLength: Int? = nil, beforeFirstPut: (() -> Void)? = nil) {
        authorization = "Bearer " + token; self.document = document
        self.getStatus = getStatus; self.declaredGetLength = declaredGetLength; self.beforeFirstPut = beforeFirstPut
    }
    var bytes: Data { lock.lock(); defer { lock.unlock() }; return document }
    var recorded: [Request] { lock.lock(); defer { lock.unlock() }; return requests }
    var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    func seedAsPeer(_ bytes: Data) { lock.lock(); document = bytes; lock.unlock() }
    private func encoded(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func respond(_ request: URLRequest, body: Data) -> Reply {
        lock.lock(); defer { lock.unlock() }
        let method = request.httpMethod ?? "GET", url = request.url!
        let authorized = request.value(forHTTPHeaderField: "Authorization") == authorization
        let etag = "\"" + SHA256.hash(data: document).map { String(format: "%02x", $0) }.joined() + "\""
        let modified = "Tue, 06 Oct 2026 00:00:00 GMT"
        func reply(_ status: Int, _ bytes: Data = Data(), headers extra: [String: String] = [:]) -> Reply {
            var headers = ["Content-Type": "application/json", "Content-Length": String(bytes.count)]
            headers.merge(extra) { _, new in new }
            // A boolean records exact Bearer comparison; a received token is never retained.
            requests.append(Request(method: method, status: status, authorized: authorized, body: method == "PUT" ? body : Data()))
            return Reply(status: status, headers: headers, body: method == "HEAD" ? Data() : bytes)
        }
        guard url.scheme == "https", url.path == "/v1/data", url.query == nil,
              url.user == nil, url.password == nil, ["GET", "HEAD", "PUT"].contains(method),
              request.value(forHTTPHeaderField: "If-Match") == nil,
              request.value(forHTTPHeaderField: "If-None-Match") == nil else {
            unexpected += 1; return reply(400)
        }
        guard authorized else { return reply(401) }
        if method == "HEAD" {
            return reply(200, headers: ["ETag": etag, "Last-Modified": modified, "Content-Length": String(document.count)])
        }
        if method == "GET" {
            if let getStatus { return reply(getStatus, encoded(["error": "Synthetic document refusal"])) }
            return reply(200, document, headers: ["Content-Length": String(declaredGetLength ?? document.count)])
        }
        guard request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("application/json") == true,
              let incoming = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let tasks = incoming["tasks"] as? [[String: Any]],
              ["projects", "sections", "areas"].allSatisfy({ incoming[$0] is [Any] }),
              incoming["settings"] is [String: Any],
              tasks.allSatisfy({ $0["id"] is String && $0["title"] is String && $0["status"] is String }),
              Set(tasks.compactMap { $0["id"] as? String }).count == tasks.count,
              let existing = (try? JSONSerialization.jsonObject(with: document)) as? [String: Any],
              let prior = existing["tasks"] as? [[String: Any]],
              prior.allSatisfy({ old in tasks.contains { encoded($0) == encoded(old) } }) else {
            unexpected += 1; return reply(400)
        }
        // This bounded route has no concurrent server edit: incoming already contains
        // every exact stored task. Actual server.ts merges under its namespace lock;
        // this fixture cannot establish that server merge or its conflict accounting.
        beforeFirstPut?(); beforeFirstPut = nil
        let oldCount = prior.count
        document = body
        let savedTag = "\"" + SHA256.hash(data: document).map { String(format: "%02x", $0) }.joined() + "\""
        func stats(_ old: Int, _ incoming: Int) -> [String: Any] {
            ["localTotal": old, "incomingTotal": incoming, "mergedTotal": incoming,
             "localOnly": 0, "incomingOnly": incoming - old, "conflicts": 0,
             "resolvedUsingLocal": 0, "resolvedUsingIncoming": 0, "deletionsWon": 0, "conflictIds": [],
             "maxClockSkewMs": 0, "invalidTimestamps": 0, "timestampAdjustments": 0, "timestampAdjustmentIds": [],
             "futureTimestampClamps": 0, "futureTimestampClampIds": []]
        }
        let receipt: [String: Any] = ["ok": true, "etag": savedTag, "lastModified": modified,
            "contentLength": String(document.count), "remoteFingerprint": "cloud:v1:etag=" + savedTag,
            "serverMergedRemoteData": false, "clockSkewWarning": NSNull(),
            "stats": ["tasks": stats(oldCount, tasks.count), "projects": stats(0, 0), "sections": stats(0, 0),
                      "areas": stats(0, 0), "people": stats(0, 0), "tombstoneRepairs": 0]]
        return reply(200, encoded(receipt), headers: ["ETag": savedTag, "Last-Modified": modified])
    }
}

final class NativeSelfHostedSyncTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var namespace = "", service = "", hostname = "", replacementHostname = "", at = ""
    private let token = "synthetic-fixture-token-400"
    private let replacementToken = "synthetic-replacement-token-400"
    private let unknown = "Preserve unknown400 🧠"
    private let localBytes = Data("Preserve native local bytes400\u{0}🧠".utf8)
    private var remote: SelfHostedDocumentStore!, replacement: SelfHostedDocumentStore?
    private var unexpectedBefore = 0
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private var fixtureSecrets: URL { root.appendingPathComponent("attachment-files/cache/" + NativeSyntheticSecretFixture.cacheFileName) }
    private var localFile: URL { root.appendingPathComponent("attachment-files/documents/preserved400.bin") }
    private var url: String { "https://" + hostname }
    private var replacementURL: String { "https://" + replacementHostname }

    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build the production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: source) else { throw HostFailure("Self-hosted fixture bundle is unavailable") }
        bundle = URL(fileURLWithPath: source)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("NativeSelfHostedSyncTests/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Self-hosted fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        #if os(macOS)
        // Shared test-only file-backed secrets; Mac acceptance is not Keychain proof.
        bundle = try NativeSyntheticSecretFixture.makeBundle(source: bundle, directory: root)
        #endif
        namespace = "tech.dongdongbh.mindwtr.selfhosted400." + UUID().uuidString.lowercased()
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        hostname = "cloud400-" + UUID().uuidString.lowercased() + ".invalid"
        replacementHostname = "replacement400-" + UUID().uuidString.lowercased() + ".invalid"
        let date = ISO8601DateFormatter(); date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        at = date.string(from: Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970)))
        remote = SelfHostedDocumentStore(token: token, document: try document([task("remote400")]))
        unexpectedBefore = SelfHostedDocumentProtocol.unexpectedCount
        SelfHostedDocumentProtocol.install(hostname, remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(SelfHostedDocumentProtocol.unexpectedCount, unexpectedBefore)
        if let remote { XCTAssertEqual(remote.unexpectedCount, 0) }
        if let replacement { XCTAssertEqual(replacement.unexpectedCount, 0) }
        #if os(iOS)
        for account in ["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"] {
            for alias in ["no-auth", "auth", "legacy"] {
                var query = secretQuery(account)
                query[kSecAttrService as String] = alias == "legacy" ? service : service + ":" + alias
                let status = SecItemDelete(query as CFDictionary)
                XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound)
            }
        }
        #endif
        SelfHostedDocumentProtocol.remove(hostname); SelfHostedDocumentProtocol.remove(replacementHostname)
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func task(_ id: String) -> [String: Any] {
        ["id": id, "title": "Exact " + id + " 🧠", "description": "Preserve " + id + "\nsecond line café",
         "status": "inbox", "contexts": ["@desk"], "tags": ["native400"],
         "checklist": [["id": id + "-item", "title": "Exact checklist " + id, "isCompleted": false]],
         "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture", "pushCount": 0,
         "isFocusedToday": false, "suppressMindwtrReminders": false]
    }
    private func document(_ tasks: [[String: Any]]) throws -> Data {
        Data(try json(["tasks": tasks, "projects": [], "sections": [], "areas": [], "people": [], "settings": [:]]).utf8)
    }
    private func core(limit: Int? = nil) -> CoreHost {
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SelfHostedDocumentProtocol.self]
        faults.httpConfiguration = configuration; faults.httpByteLimit = limit; faults.secretService = service
        #if os(macOS)
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.secretBeforeOperation = { _, _ in XCTFail("Synthetic Mac workflow must not enter platform Security") }
        #endif
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
                            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await host.close() }; return host
    }
    private func raw(_ host: CoreHost, _ name: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        try object(await host.foregroundSync(command: name, requestJSON: json(input)))
    }
    private func command(_ host: CoreHost, _ name: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        let reply = try await raw(host, name, input)
        XCTAssertEqual(reply["ok"] as? Bool, true, name + " fixedCode=" + ((reply["error"] as? [String: Any])?["code"] as? String ?? "none"))
        return reply["value"] is NSNull ? [:] : try XCTUnwrap(reply["value"] as? [String: Any])
    }
    private func stored() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)) }
    private func fields(_ target: String? = nil, credential: Any? = nil) -> [String: Any] {
        ["url": target ?? url, "token": credential ?? token, "allowInsecureHttp": false]
    }
    private func revision(_ host: CoreHost) async throws -> String {
        let model = try await command(host, "syncSettings")
        return try XCTUnwrap(model["configRevision"] as? String)
    }
    private func open(_ host: CoreHost, select: Bool = true) async throws {
        let count = remote.recorded.count + (replacement?.recorded.count ?? 0)
        _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count + (replacement?.recorded.count ?? 0), count, "Cold opening is read-only")
        if select { _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "selfhosted"]) }
    }
    private func save(_ host: CoreHost, _ form: [String: Any]? = nil) async throws -> [String: Any] {
        try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "selfHosted": form ?? fields()])
    }
    private func seed(state: String? = nil) async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        var configuration = ["@mindwtr_sync_backend": "off", "unknown": unknown]
        if let state { configuration["@mindwtr_sync_encryption_state_v1"] = state }
        try Data(json(configuration).utf8).write(to: manifest)
        let host = core(), count = remote.recorded.count
        _ = try await host.start(); XCTAssertEqual(remote.recorded.count, count); await host.close()
        let local = task("local400"), db = try SQLiteBridge(url: database); defer { db.close() }
        _ = try db.execute("INSERT INTO tasks(id,title,status,contexts,tags,checklist,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,?,?,?,?,?,?,?,1,'fixture',0,0,0,0)",
            parametersJSON: json([local["id"]!, local["title"]!, local["status"]!, try json(local["contexts"]!), try json(local["tags"]!), try json(local["checklist"]!), local["description"]!, at, at]))
        try FileManager.default.createDirectory(at: localFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try localBytes.write(to: localFile)
    }
    private func secretQuery(_ account: String) -> [String: Any] {
        let bytes = Data(account.utf8)
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes, kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
    private func secret(_ account: String) throws -> String? {
        #if os(macOS)
        guard FileManager.default.fileExists(atPath: fixtureSecrets.path) else { return nil }
        return try object(String(decoding: Data(contentsOf: fixtureSecrets), as: UTF8.self))[account] as? String
        #else
        var query = secretQuery(account); query[kSecReturnData as String] = true
        var value: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        XCTAssertEqual(status, errSecSuccess)
        return try XCTUnwrap(String(data: XCTUnwrap(value as? Data), encoding: .utf8))
        #endif
    }
    private func seedSecret(_ account: String, _ value: String) throws {
        #if os(macOS)
        var values: [String: Any] = [:]
        if FileManager.default.fileExists(atPath: fixtureSecrets.path) { values = try object(String(decoding: Data(contentsOf: fixtureSecrets), as: UTF8.self)) }
        values[account] = value
        try FileManager.default.createDirectory(at: fixtureSecrets.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(values).utf8).write(to: fixtureSecrets)
        #else
        var query = secretQuery(account); query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)
        #endif
    }
    private func rows() throws -> [String: String] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS t\(index), CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS v\(index)"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func taskRows() throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT * FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
        return try rows.map { row in
            var result = row
            for name in ["contexts", "tags", "checklist"] {
                if let text = result[name] as? String { result[name] = try JSONSerialization.jsonObject(with: Data(text.utf8)) }
            }
            return result
        }
    }
    private func assertTasks(_ ids: [String], template: [String: Any]) throws {
        let actual = try taskRows()
        let expected = ids.sorted().map { id -> [String: Any] in
            var row = template
            for name in ["id", "title", "description", "contexts", "tags", "checklist"] { row[name] = task(id)[name] }
            return row
        }
        XCTAssertEqual(try json(actual), try json(expected), "Every persisted task column survives the document sync")
        let document = try object(String(decoding: remote.bytes, as: UTF8.self))
        let uploaded = try XCTUnwrap(document["tasks"] as? [[String: Any]])
        XCTAssertEqual(try uploaded.map { try json($0) }.sorted(), try ids.map { try json(task($0)) }.sorted(), "The entire remote task projection is exact")
        let db = try SQLiteBridge(url: database); defer { db.close() }
        for collection in ["projects", "sections", "areas", "people"] {
            XCTAssertEqual((document[collection] as? [Any])?.count ?? 0, 0)
            let stored = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT * FROM \(collection)").utf8)) as? [[String: Any]])
            XCTAssertTrue(stored.isEmpty)
        }
        for request in remote.recorded where request.method == "PUT" {
            XCTAssertFalse(request.body.starts(with: Data("MWENC1".utf8)))
            XCTAssertNotNil(try JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        }
    }
    private func assertProvenConfiguration() throws {
        let values = try stored()
        XCTAssertEqual(values["@mindwtr_sync_backend"] as? String, "cloud")
        XCTAssertEqual(values["@mindwtr_cloud_provider"] as? String, "selfhosted")
        XCTAssertEqual(values["@mindwtr_cloud_url"] as? String, url)
        XCTAssertEqual(values["@mindwtr_cloud_allow_insecure_http"] as? String, "false")
        XCTAssertEqual(values["unknown"] as? String, unknown)
        XCTAssertNil(values["@mindwtr_cloud_token"], "A saved token is not an ordinary device-storage cell")
        XCTAssertTrue(try secret("mindwtr_cloud_token") == token, "The saved synthetic credential matches exactly")
    }
    private func assertMasked(_ host: CoreHost, expectedLength: Int) async throws {
        let model = try await command(host, "syncSettings"), panel = try XCTUnwrap(model["panel"] as? [String: Any])
        XCTAssertEqual(panel["kind"] as? String, "selfhosted")
        let credential = try XCTUnwrap(panel["token"] as? [String: Any])
        XCTAssertEqual(credential["mask"] as? String, String(repeating: "•", count: expectedLength))
        XCTAssertNil(credential["value"])
        XCTAssertTrue(model["encryption"] is NSNull, "Cloud retains RN plaintext policy and offers no encryption actions")
        try assertPrivate(model)
    }
    private func assertPrivate(_ result: [String: Any]) throws {
        let text = try json(result)
        XCTAssertFalse(text.contains(token)); XCTAssertFalse(text.contains(replacementToken))
        let log = root.appendingPathComponent("logs/mindwtr.log")
        if FileManager.default.fileExists(atPath: log.path) {
            let content = try String(contentsOf: log, encoding: .utf8)
            XCTAssertFalse(content.contains(token)); XCTAssertFalse(content.contains(replacementToken))
        }
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("core.sqlite.pending.json").path))
    }
    private func assertSuccess(_ result: [String: Any]) throws {
        let toasts = try XCTUnwrap(result["toasts"] as? [[String: Any]])
        XCTAssertTrue(toasts.contains { $0["tone"] as? String == "success" })
        XCTAssertFalse(toasts.contains { $0["tone"] as? String == "error" })
        try assertPrivate(result)
    }

    func testVerifiedActivationCommitsAfterDocumentPUTAndColdNullTokenReusePreservesExactTasks() async throws {
        try await seed()
        let template = try XCTUnwrap(taskRows().first), before = try Data(contentsOf: manifest)
        remote = SelfHostedDocumentStore(token: token, document: try document([task("remote400")]), beforeFirstPut: {
            XCTAssertEqual(try? Data(contentsOf: self.manifest), before, "Before the first PUT acknowledgement, only Off is proven")
            XCTAssertTrue((try? self.secret("mindwtr_cloud_token")) == nil)
        })
        SelfHostedDocumentProtocol.install(hostname, remote)
        let host = core(); try await open(host)
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(try Data(contentsOf: manifest), before)
        try await assertMasked(host, expectedLength: 0)
        let input: [String: Any] = ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "selfHosted": fields()]
        let accepted = try await command(host, "saveSyncBackend", input)
        try assertSuccess(accepted); try assertProvenConfiguration(); try assertTasks(["local400", "remote400"], template: template)
        XCTAssertTrue(remote.recorded.contains { $0.method == "GET" && $0.status == 200 })
        XCTAssertTrue(remote.recorded.contains { $0.method == "PUT" && $0.status == 200 })
        XCTAssertTrue(remote.recorded.allSatisfy { $0.authorized })
        try await assertMasked(host, expectedLength: token.count)
        let count = remote.recorded.count, persisted = remote.bytes, domain = try rows()
        let replay = try await command(host, "saveSyncBackend", input)
        XCTAssertEqual(try json(replay), try json(accepted)); XCTAssertEqual(remote.recorded.count, count)
        XCTAssertEqual(remote.bytes, persisted); XCTAssertEqual(try rows(), domain)
        var stale = input; stale["requestId"] = UUID().uuidString.lowercased()
        let rejected = try await raw(host, "saveSyncBackend", stale)
        XCTAssertEqual(rejected["ok"] as? Bool, false)
        XCTAssertEqual((rejected["error"] as? [String: Any])?["code"] as? String, "STALE_REVISION")
        var changed = input; changed["selfHosted"] = fields(credential: replacementToken)
        let collision = try await raw(host, "saveSyncBackend", changed)
        XCTAssertEqual(collision["ok"] as? Bool, false)
        XCTAssertEqual((collision["error"] as? [String: Any])?["code"] as? String, "INVALID_INPUT")
        XCTAssertEqual(remote.recorded.count, count); try assertPrivate(rejected); try assertPrivate(collision)
        await host.close()
        let cold = core(); try await open(cold, select: false); try await assertMasked(cold, expectedLength: token.count)
        XCTAssertEqual(try rows(), domain); XCTAssertEqual(remote.bytes, persisted); XCTAssertEqual(remote.recorded.count, count)
        // An external task makes cold Sync now exercise an actual read/apply rather than an idle return.
        remote.seedAsPeer(try document([task("local400"), task("remote400"), task("cold400")]))
        let synced = try await command(cold, "syncNow", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(cold), "selfHosted": fields(credential: NSNull())])
        try assertSuccess(synced); try assertProvenConfiguration(); try assertTasks(["local400", "remote400", "cold400"], template: template)
        XCTAssertTrue(remote.recorded.dropFirst(count).contains { $0.method == "GET" && $0.authorized })
        await cold.close()
    }

    func testConnectionProofReadsBearerDocumentWithoutActivatingOrApplyingTasks() async throws {
        try await seed()
        let host = core(); try await open(host)
        let configuration = try Data(contentsOf: manifest), domain = try rows(), bytes = remote.bytes
        let result = try await command(host, "testSyncConnection", ["selfHosted": fields()])
        try assertSuccess(result)
        XCTAssertEqual(remote.recorded.map { $0.method }, ["GET"])
        XCTAssertTrue(remote.recorded.allSatisfy { $0.authorized && $0.status == 200 })
        XCTAssertEqual(remote.bytes, bytes); XCTAssertEqual(try rows(), domain)
        XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertNil(try secret("mindwtr_cloud_token"))
        await host.close()
    }

    private func assertCandidateRefused(status: Int? = nil, tooLarge: Bool = false) async throws {
        try await seed()
        let original = core(); try await open(original); try assertSuccess(try await save(original)); try assertProvenConfiguration()
        await original.close()
        let proven = try stored(), domain = try rows(), remoteBytes = remote.bytes, priorRequests = remote.recorded.count
        replacement = SelfHostedDocumentStore(token: replacementToken, document: try document([task("candidate400")]),
                                              getStatus: status, declaredGetLength: tooLarge ? 4097 : nil)
        SelfHostedDocumentProtocol.install(replacementHostname, replacement!)
        let host = core(limit: tooLarge ? 4096 : nil); try await open(host, select: false)
        let result = try await save(host, fields(replacementURL, credential: replacementToken))
        let toasts = try XCTUnwrap(result["toasts"] as? [[String: Any]])
        XCTAssertFalse(toasts.contains { $0["tone"] as? String == "success" })
        XCTAssertTrue(toasts.contains { $0["tone"] as? String == "error" })
        try assertPrivate(result); try assertProvenConfiguration()
        for name in ["@mindwtr_sync_backend", "@mindwtr_cloud_provider", "@mindwtr_cloud_url", "@mindwtr_cloud_allow_insecure_http", "unknown"] {
            XCTAssertEqual(try json(stored()[name] ?? NSNull()), try json(proven[name] ?? NSNull()))
        }
        XCTAssertEqual(try rows(), domain); XCTAssertEqual(remote.bytes, remoteBytes); XCTAssertEqual(remote.recorded.count, priorRequests)
        let refused = try XCTUnwrap(replacement)
        XCTAssertEqual(refused.recorded.map { $0.method }, ["GET"])
        XCTAssertTrue(refused.recorded.allSatisfy { $0.authorized && $0.status == (status ?? 200) })
        XCTAssertEqual(refused.bytes, try document([task("candidate400")]))
        if tooLarge {
            XCTAssertLessThanOrEqual(refused.bytes.count, 4096, "Only the advertised 4097-byte length exceeds this native cap")
            XCTAssertTrue(toasts.contains {
                $0["tone"] as? String == "error"
                    && ($0["message"] as? String ?? "").contains("Response exceeds the 4096 byte download limit")
            }, "The actual native document response cap must survive into the fixed failure detail")
        }
        await host.close()
        let cold = core(); try await open(cold, select: false); try await assertMasked(cold, expectedLength: token.count)
        let model = try await command(cold, "syncSettings"), panel = try XCTUnwrap(model["panel"] as? [String: Any])
        XCTAssertEqual((panel["url"] as? [String: Any])?["value"] as? String, url)
        try assertProvenConfiguration(); XCTAssertEqual(try rows(), domain)
        XCTAssertEqual(remote.recorded.count, priorRequests); XCTAssertEqual(refused.recorded.count, 1)
        await cold.close()
    }
    func testAuthenticationRefusalKeepsPreviousProvenConfigurationAndEveryTypedCell() async throws { try await assertCandidateRefused(status: 401) }
    func testUnavailableCandidateKeepsPreviousProvenConfigurationAndEveryTypedCell() async throws { try await assertCandidateRefused(status: 503) }
    func testNativeDocumentResponseCapRefusesCandidateBeforePUTOrLocalApply() async throws { try await assertCandidateRefused(tooLarge: true) }

    func testCompletedRetainedEncryptionMaterialStaysExactWhileCloudDocumentIsPlaintext() async throws {
        let material = Data((0..<32).map { UInt8($0) }).base64EncodedString()
        let state = try json(["state": "enabled", "discoveredSalt": "0102030405060708090a0b0c0d0e0f10",
            "discoveredParams": ["mKib": 64, "t": 1, "p": 1],
            "discoveredScope": try json(["webdav", "https://other400.invalid/sync/data.json", "synthetic"])])
        try seedSecret("mindwtr_sync_encryption_key_v1", material); try await seed(state: state)
        let template = try XCTUnwrap(taskRows().first), host = core(); try await open(host)
        try assertSuccess(try await save(host)); try assertTasks(["local400", "remote400"], template: template)
        XCTAssertEqual(try stored()["@mindwtr_sync_encryption_state_v1"] as? String, state)
        XCTAssertTrue(try secret("mindwtr_sync_encryption_key_v1") == material)
        try await assertMasked(host, expectedLength: token.count)
        let domain = try rows(), bytes = remote.bytes, count = remote.recorded.count; await host.close()
        let cold = core(); try await open(cold, select: false); try await assertMasked(cold, expectedLength: token.count)
        XCTAssertEqual(try stored()["@mindwtr_sync_encryption_state_v1"] as? String, state)
        XCTAssertTrue(try secret("mindwtr_sync_encryption_key_v1") == material)
        XCTAssertEqual(try rows(), domain); XCTAssertEqual(remote.bytes, bytes); XCTAssertEqual(remote.recorded.count, count)
        let model = try await command(cold, "syncSettings")
        XCTAssertFalse(try json(model).contains(material))
        XCTAssertFalse(try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8).contains(material))
        await cold.close()
    }

    func testIncompleteTransitionRefusesSelectionAndFormWorkBeforeCloudBytesAcrossColdOpen() async throws {
        let state = try json(["state": "off", "incompleteTransition": "enable"])
        try await seed(state: state)
        let domain = try rows(), before = try Data(contentsOf: manifest), bytes = remote.bytes
        for _ in 0..<2 {
            let host = core(); try await open(host, select: false)
            for (name, input) in [
                ("selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "selfhosted"] as [String: Any]),
                ("testSyncConnection", ["selfHosted": fields()]),
                ("saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "selfHosted": fields()]),
                ("syncNow", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "selfHosted": fields()]),
            ] {
                let refusal = try await raw(host, name, input)
                XCTAssertEqual(refusal["ok"] as? Bool, false)
                let error = try XCTUnwrap(refusal["error"] as? [String: Any])
                XCTAssertEqual(error["code"] as? String, "ACTION_FAILED")
                XCTAssertEqual(error["message"] as? String, "SYNC_ENCRYPTION_TRANSITION_INCOMPLETE: retry the enable sync encryption transition before syncing or changing the sync location")
                try assertPrivate(refusal)
            }
            XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try rows(), domain)
            XCTAssertNil(try secret("mindwtr_cloud_token")); XCTAssertNil(try secret("mindwtr_sync_encryption_key_v1"))
            XCTAssertEqual(remote.bytes, bytes); XCTAssertTrue(remote.recorded.isEmpty)
            await host.close()
        }
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-selfhosted-encryption-guard"))
    }

    func testLegacyMissingProviderUsesSavedSelfHostedTokenWithoutRewritingProviderOnOpen() async throws {
        try await seed()
        let host = core(); try await open(host); try assertSuccess(try await save(host)); await host.close()
        var values = try stored(); values.removeValue(forKey: "@mindwtr_cloud_provider")
        try Data(json(values).utf8).write(to: manifest)
        let before = try Data(contentsOf: manifest), domain = try rows(), count = remote.recorded.count
        let cold = core(); try await open(cold, select: false); try await assertMasked(cold, expectedLength: token.count)
        XCTAssertEqual(try Data(contentsOf: manifest), before); XCTAssertEqual(try rows(), domain); XCTAssertEqual(remote.recorded.count, count)
        let model = try await command(cold, "syncSettings"), backend = try XCTUnwrap(model["backend"] as? [String: Any])
        let options = try XCTUnwrap(backend["options"] as? [[String: Any]])
        XCTAssertTrue(options.contains { $0["option"] as? String == "selfhosted" && $0["selected"] as? Bool == true })
        await cold.close()
    }
}
