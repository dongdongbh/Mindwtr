import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// A private DAV endpoint, not a claim of compatibility with a real backend.
/// Every request is intercepted, including unknown destinations.
private final class EncryptionDAVProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var stores: [String: EncryptionDAVStore] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ host: String, store: EncryptionDAVStore) { lock.lock(); stores[host] = store; lock.unlock() }
    static func remove(_ host: String) { lock.lock(); stores.removeValue(forKey: host); lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let store = Self.stores[request.url?.host ?? ""]
        if store == nil { Self.unexpected += 1 }
        Self.lock.unlock()
        guard let store else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        let response = store.respond(request, body: upload())
        let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: response.headers)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        if !response.body.isEmpty { client?.urlProtocol(self, didLoad: response.body) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    private func upload() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}

private final class EncryptionDAVStore: @unchecked Sendable {
    struct Request: Equatable { let method: String; let path: String; let condition: String?; let status: Int; let serverDate: String; let responseEtag: String?; let encryptedBody: Bool; let encryptedBytes: Data? }
    struct Reply { let status: Int; let headers: [String: String]; let body: Data }
    private struct Object { let bytes: Data; let etag: String }
    private let lock = NSLock()
    private let expectedAuthorization: String
    private var objects: [String: Object] = [:]
    private var collections: Set<String> = ["/", "/sync/", "/sync/attachments/"]
    private var requests: [Request] = []
    private var version = 0
    private var unexpected = 0
    private var serverTime: Date?
    private var getStatuses: [String: Int] = [:]
    private var declaredLengths: [String: Int] = [:]
    private var omitEtags = false
    private var unquotedEtags = false
    func refuseStrongEtags(unquoted: Bool = false) { lock.lock(); omitEtags = !unquoted; unquotedEtags = unquoted; lock.unlock() }
    private var refuseFenceDelete = false
    func refuseFenceRelease() { lock.lock(); refuseFenceDelete = true; lock.unlock() }
    init(expectedAuthorization: String) { self.expectedAuthorization = expectedAuthorization }
    var snapshot: [String: Data] { lock.lock(); defer { lock.unlock() }; return objects.mapValues { $0.bytes } }
    var recorded: [Request] { lock.lock(); defer { lock.unlock() }; return requests }
    var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    func bytes(_ path: String) -> Data? { lock.lock(); defer { lock.unlock() }; return objects[path]?.bytes }
    func etag(_ path: String) -> String? { lock.lock(); defer { lock.unlock() }; return objects[path]?.etag }
    func advanceServerTime(to value: Date) { lock.lock(); serverTime = value; lock.unlock() }
    func seed(_ path: String, bytes: Data) {
        lock.lock(); defer { lock.unlock() }
        version += 1; objects[path] = Object(bytes: bytes, etag: "\"fixture-v\(version)\"")
    }
    func removeAsPeer(_ path: String) { lock.lock(); objects.removeValue(forKey: path); lock.unlock() }
    func refuseGet(_ path: String, status: Int?) { lock.lock(); getStatuses[path] = status; lock.unlock() }
    func declareGetLength(_ path: String, bytes: Int) { lock.lock(); declaredLengths[path] = bytes; lock.unlock() }
    func respond(_ request: URLRequest, body: Data) -> Reply {
        lock.lock(); defer { lock.unlock() }
        let url = request.url!, path = url.path, method = request.httpMethod ?? "GET"
        let match = request.value(forHTTPHeaderField: "If-Match")
        let none = request.value(forHTTPHeaderField: "If-None-Match")
        let condition = match.map { "match:" + $0 } ?? none.map { "none:" + $0 }
        let encryptedBody = method == "PUT" && body.prefix(8) == (Data("MWENC1".utf8) + Data([1, 1]))
        let date = DateFormatter(); date.locale = Locale(identifier: "en_US_POSIX"); date.timeZone = TimeZone(secondsFromGMT: 0)
        date.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        func reply(_ status: Int, _ bytes: Data = Data(), etag: String? = nil, type: String = "application/octet-stream") -> Reply {
            let serverDate = date.string(from: serverTime ?? Date())
            var headers = ["Date": serverDate, "Content-Length": String(bytes.count), "Content-Type": type]
            if let etag, !omitEtags { headers["ETag"] = unquotedEtags ? "fixture-unquoted-validator" : etag }
            requests.append(Request(method: method, path: path, condition: condition, status: status, serverDate: serverDate, responseEtag: headers["ETag"], encryptedBody: encryptedBody, encryptedBytes: encryptedBody ? body : nil))
            return Reply(status: status, headers: headers, body: method == "HEAD" ? Data() : bytes)
        }
        // Never retain or report a received credential. Every accepted DAV
        // operation must carry the exact synthetic account configured by setup.
        guard request.value(forHTTPHeaderField: "Authorization") == expectedAuthorization else { return reply(401) }
        guard url.scheme == "https", path.hasPrefix("/sync/"), request.url?.query == nil else {
            unexpected += 1; return reply(400)
        }
        switch method {
        case "GET", "HEAD":
            if method == "GET", let status = getStatuses[path] { return reply(status) }
            guard let object = objects[path] else { return reply(404) }
            let response = reply(200, object.bytes, etag: object.etag, type: path.hasSuffix(".json") ? "application/json" : "application/octet-stream")
            if method == "GET", let size = declaredLengths[path] {
                var headers = response.headers; headers["Content-Length"] = String(size)
                return Reply(status: response.status, headers: headers, body: response.body)
            }
            return response
        case "PUT":
            let previous = objects[path]
            if none == "*" && previous != nil { return reply(412) }
            if let match, previous?.etag != match { return reply(412) }
            let parent = String(path.prefix(through: path.lastIndex(of: "/")!))
            guard collections.contains(parent) else { return reply(409) }
            version += 1
            let object = Object(bytes: body, etag: "\"fixture-v\(version)\"")
            objects[path] = object
            return reply(previous == nil ? 201 : 204, etag: object.etag)
        case "DELETE":
            if refuseFenceDelete && path == "/sync/.mindwtr-sync-fence-v1.json" { return reply(503) }
            if let match, objects[path]?.etag != match { return reply(412) }
            guard objects.removeValue(forKey: path) != nil else { return reply(404) }
            return reply(204)
        case "MKCOL":
            let collection = path.hasSuffix("/") ? path : path + "/"
            if collections.contains(collection) { return reply(405) }
            let withoutSlash = String(collection.dropLast())
            let parent = String(withoutSlash.prefix(through: withoutSlash.lastIndex(of: "/")!))
            guard collections.contains(parent) else { return reply(409) }
            collections.insert(collection); return reply(201)
        case "PROPFIND":
            let collection = path.hasSuffix("/") ? path : path + "/"
            guard collections.contains(collection) else { return reply(404) }
            let depth = request.value(forHTTPHeaderField: "Depth") ?? "infinity"
            guard depth == "0" || depth == "1" else { unexpected += 1; return reply(400) }
            func escaped(_ value: String) -> String { value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
            func entry(_ name: String, directory: Bool, object: Object? = nil) -> String {
                let href = escaped("https://" + url.host! + name)
                let resource = directory ? "<d:collection/>" : ""
                let properties = object.map { "<d:getetag>\(escaped($0.etag))</d:getetag><d:getcontentlength>\($0.bytes.count)</d:getcontentlength>" } ?? ""
                return "<d:response><d:href>\(href)</d:href><d:propstat><d:prop><d:resourcetype>\(resource)</d:resourcetype>\(properties)</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
            }
            var entries = [entry(collection, directory: true)]
            if depth == "1" {
                for name in collections.sorted() where name != collection && name.hasPrefix(collection) {
                    if !name.dropFirst(collection.count).dropLast().contains("/") { entries.append(entry(name, directory: true)) }
                }
                for name in objects.keys.sorted() where name.hasPrefix(collection) {
                    if !name.dropFirst(collection.count).contains("/") { entries.append(entry(name, directory: false, object: objects[name])) }
                }
            }
            return reply(207, Data(("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\">" + entries.joined() + "</d:multistatus>").utf8), type: "application/xml; charset=utf-8")
        default:
            unexpected += 1; return reply(405)
        }
    }
}


/// Existing DEBUG worker hook; all mutable state stays off the Engine queue.
private final class EncryptionKDFGate: @unchecked Sendable {
    let reached: XCTestExpectation
    init(_ boundary: String = "Native Unlock KDF admitted") { reached = XCTestExpectation(description: boundary) }
    private let lock = NSLock(), release = DispatchSemaphore(value: 0)
    private var armed = false, used = false, finished = false
    func arm() { lock.lock(); armed = true; lock.unlock() }
    func visit(_ operation: String) { if operation == "argon2id" { hold() } }
    func hold() {
        lock.lock(); let hold = armed && !used
        if hold { used = true }; lock.unlock()
        if hold { reached.fulfill(); release.wait() }
    }
    func unblock() { release.signal() }
    func complete() { lock.lock(); finished = true; lock.unlock() }
    var completed: Bool { lock.lock(); defer { lock.unlock() }; return finished }
}

/// Actual JSC + native HTTP/Argon2/AES/KV; macOS uses only the existing
/// durable synthetic secret decorator. iOS uses exact isolated Security items.
final class NativeEncryptionUnlockTests: XCTestCase {
    private var root: URL!, bundle: URL!, hostname: String!, namespace: String!, service: String!
    private var remote: EncryptionDAVStore!
    private var crypto: NativeCryptoJobs?, http: NativeHTTPJobs?, secrets: NativeSecretJobs?
    private var unexpectedBefore = 0
    private let taskID = "local370", remoteTaskID = "remote370"
    private let at = "2026-10-07T12:00:00.000Z", password = "synthetic-dav-370"
    private let passphrase = "correct horse battery staple"
    private let nextPassphrase = "synthetic next generation 382"
    // Independent RN/Noble Argon2id reference: salt 01..10, m64/t1/p1.
    private let keyHex = "fcd175b0b1aa6e9995ec57b1a0678fa481c471f2f894ebe20426c324f6ff7aeb"
    private let localBytes = Data("Untouched local file370".utf8)
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private var fixtureSecrets: URL { root.appendingPathComponent("attachment-files/cache/" + NativeSyntheticSecretFixture.cacheFileName) }
    private var localFile: URL { root.appendingPathComponent("attachment-files/documents/attachments/local370.txt") }
    private var endpoint: String { "https://" + hostname + "/sync/data.json" }
    private var fields: [String: Any] { ["url": endpoint, "username": "synthetic", "password": password, "allowInsecureHttp": false] }

    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Set production core-host bundle") }
        guard FileManager.default.isReadableFile(atPath: source) else { throw HostFailure("Encryption bundle unavailable") }
        bundle = URL(fileURLWithPath: source)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeEncryptionUnlockTests/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Encryption fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        #if os(macOS)
        bundle = try NativeSyntheticSecretFixture.makeBundle(source: bundle, directory: root)
        #endif
        hostname = "unlock370-" + UUID().uuidString.lowercased() + ".invalid"
        namespace = "tech.dongdongbh.mindwtr.unlock370." + UUID().uuidString.lowercased()
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        remote = EncryptionDAVStore(expectedAuthorization: "Basic " + Data(("synthetic:" + password).utf8).base64EncodedString())
        unexpectedBefore = EncryptionDAVProtocol.unexpectedCount; EncryptionDAVProtocol.install(hostname, store: remote)
        let document: [String: Any] = ["tasks": [["id": remoteTaskID, "title": "Encrypted remote370", "status": "inbox", "contexts": [], "tags": [], "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture"]], "projects": [], "sections": [], "areas": [], "settings": [:]]
        remote.seed("/sync/data.json.enc", bytes: try independentlyEncrypted(Data(json(document).utf8)))
        remote.seed("/sync/attachments/untouched.bin", bytes: try independentlyEncrypted(Data("Untouched remote file370".utf8)))
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(EncryptionDAVProtocol.unexpectedCount, unexpectedBefore)
        if let remote { XCTAssertEqual(remote.unexpectedCount, 0) }
        #if os(iOS)
        if let service {
            for account in ["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"] {
                for alias in ["no-auth", "auth", "legacy"] {
                    let bytes = Data(account.utf8)
                    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
                        kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
                    let status = SecItemDelete(query as CFDictionary)
                    XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound)
                }
            }
        }
        #endif
        if let hostname { EncryptionDAVProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func key() -> Data { Data(stride(from: 0, to: keyHex.count, by: 2).map { index in
        UInt8(keyHex[keyHex.index(keyHex.startIndex, offsetBy: index)..<keyHex.index(keyHex.startIndex, offsetBy: index + 2)], radix: 16)!
    }) }
    private func independentlyEncrypted(_ plaintext: Data) throws -> Data {
        var header = Data(repeating: 0, count: 54)
        header.replaceSubrange(0..<8, with: Data("MWENC1".utf8) + Data([1, 1]))
        func write(_ value: UInt64, _ offset: Int, _ count: Int) {
            for index in 0..<count { header[offset + index] = UInt8(truncatingIfNeeded: value >> (8 * index)) }
        }
        write(64, 8, 4); write(1, 12, 4); header[16] = 1; header[17] = 1
        header.replaceSubrange(18..<34, with: Data((1...16).map { UInt8($0) }))
        let nonce = Data((33...44).map { UInt8($0) }); header.replaceSubrange(34..<46, with: nonce)
        write(UInt64(plaintext.count + 16), 46, 8)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key()), nonce: AES.GCM.Nonce(data: nonce), authenticating: header)
        var result = header; result.append(sealed.ciphertext); result.append(sealed.tag); return result
    }
    private func core(_ supplied: HostIOFaults = HostIOFaults()) -> CoreHost {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [EncryptionDAVProtocol.self]
        supplied.httpConfiguration = configuration; supplied.secretService = service
        #if os(macOS)
        supplied.secretStatus = { _, _ in errSecNotAvailable }
        supplied.secretBeforeOperation = { _, _ in XCTFail("Synthetic macOS workflow must not enter platform Security") }
        #endif
        let configureHTTP = supplied.configureHTTPJobs
        supplied.configureCryptoJobs = { self.crypto = $0 }
        supplied.configureHTTPJobs = { self.http = $0; configureHTTP?($0) }
        supplied.configureSecretJobs = { self.secrets = $0 }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: supplied, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func raw(_ host: CoreHost, _ command: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        try object(await host.foregroundSync(command: command, requestJSON: json(input)))
    }
    private func command(_ host: CoreHost, _ name: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        let reply = try await raw(host, name, input)
        let code = (reply["error"] as? [String: Any])?["code"] as? String ?? "none"
        XCTAssertEqual(reply["ok"] as? Bool, true, name + " fixedCode=" + code)
        return reply["value"] is NSNull ? [:] : try XCTUnwrap(reply["value"] as? [String: Any])
    }
    private func revision(_ host: CoreHost) async throws -> String {
        let model = try await command(host, "syncSettings")
        return try XCTUnwrap(model["configRevision"] as? String)
    }
    private func encryptionRows(_ host: CoreHost) async throws -> [[String: Any]] {
        let model = try await command(host, "syncSettings"), card = try XCTUnwrap(model["encryption"] as? [String: Any])
        return try XCTUnwrap(card["rows"] as? [[String: Any]])
    }
    private func action(_ host: CoreHost, _ value: [String: Any], requestID: String? = nil, revision explicit: String? = nil) async throws -> [String: Any] {
        let stamp: String
        if let explicit { stamp = explicit } else { stamp = try await revision(host) }
        var input: [String: Any] = ["revision": stamp, "action": value]
        if let requestID { input["requestId"] = requestID }
        return try await command(host, "runSyncEncryptionAction", input)
    }
    private func stored() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)) }
    private func changedStoredCells(_ before: [String: Any], _ after: [String: Any]) throws -> [String] {
        try Set(before.keys).union(after.keys).filter { name in
            try json(before[name] ?? NSNull()) != json(after[name] ?? NSNull())
        }.sorted()
    }
    private func storedState() throws -> [String: Any] { try object(XCTUnwrap(stored()["@mindwtr_sync_encryption_state_v1"] as? String)) }
    private func cachedKey() throws -> Data? {
        #if os(macOS)
        let record = try object(String(decoding: Data(contentsOf: fixtureSecrets), as: UTF8.self))
        guard let value = record["mindwtr_sync_encryption_key_v1"] as? String else { return nil }; return try XCTUnwrap(Data(base64Encoded: value))
        #else
        let bytes = Data("mindwtr_sync_encryption_key_v1".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes, kSecReturnData as String: true,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var value: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }; XCTAssertEqual(status, errSecSuccess)
        let text = try XCTUnwrap(String(data: XCTUnwrap(value as? Data), encoding: .utf8)); return try XCTUnwrap(Data(base64Encoded: text))
        #endif
    }
    private func markers(_ releaseCheck: String = "v1.3.5/ios-encryption-unlock") throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log, encoding: .utf8).components(separatedBy: releaseCheck).count - 1
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
    private func seedAndOpen(_ host: CoreHost) async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown": "Preserve unknown370 🧠"]).utf8).write(to: manifest)
        let network = remote.recorded.count; _ = try await host.start(); XCTAssertEqual(remote.recorded.count, network)
        let db = try SQLiteBridge(url: database); defer { db.close() }
        _ = try db.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Preserve local370','inbox','[]','[]','Preserve notes370',?,?,1,'fixture',0,0,0,0)", parametersJSON: json([taskID, at, at]))
        // Use a fresh host so its memory and durable ordinary writer agree with seed.
        await host.close()
        try FileManager.default.createDirectory(at: localFile.deletingLastPathComponent(), withIntermediateDirectories: true); try localBytes.write(to: localFile)
    }
    private func lockedHost(_ faults: HostIOFaults = HostIOFaults(), fileHooks: NativeAttachmentHostHooks? = nil) async throws -> CoreHost {
        let seed = core(); try await seedAndOpen(seed)
        let host = core(faults)
        if let fileHooks { await host.configureAttachmentHost(fileHooks) }
        _ = try await host.start()
        _ = try await command(host, "openSyncSettings")
        _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "webdav"])
        _ = try await command(host, "testSyncConnection", ["webdav": fields])
        _ = try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        let result = try await raw(host, "syncStored"); XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        XCTAssertNil(try cachedKey()); _ = try await command(host, "closeSyncSettings"); _ = try await command(host, "openSyncSettings")
        let actions = try await encryptionRows(host).compactMap { $0["action"] as? [String: Any] }
        XCTAssertTrue(actions.contains { $0["type"] as? String == "open" && $0["flow"] as? String == "unlock" })
        return host
    }
    private func enter(_ host: CoreHost, _ value: String) async throws {
        _ = try await action(host, ["type": "open", "flow": "unlock"])
        _ = try await action(host, ["type": "typed", "field": "current", "value": value])
    }
    private func plaintextHost(_ faults: HostIOFaults = HostIOFaults(), pendingLocal: Bool = true) async throws -> CoreHost {
        // Setup happens before Enable; no fixture repairs its interrupted journal or artifacts.
        remote = EncryptionDAVStore(expectedAuthorization: "Basic " + Data(("synthetic:" + password).utf8).base64EncodedString())
        EncryptionDAVProtocol.install(hostname, store: remote)
        let document: [String: Any] = ["tasks": [["id": remoteTaskID, "title": "Plain remote379", "status": "inbox", "contexts": [], "tags": [], "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture"]], "projects": [], "sections": [], "areas": [], "settings": [:]]
        let bytes = Data(try json(document).utf8)
        remote.seed("/sync/data.json", bytes: bytes); remote.seed("/sync/data.json.bak", bytes: bytes)
        remote.seed("/sync/attachments/alpha.bin", bytes: Data("Preserve alpha379".utf8))
        remote.seed("/sync/attachments/beta.bin", bytes: Data("Preserve beta379".utf8))
        let seed = core(); try await seedAndOpen(seed)
        let attachment: [String: Any] = ["id": "upload379", "kind": "file", "uri": localFile.absoluteString,
            "title": "Unsent local379.txt", "mimeType": "text/plain", "size": localBytes.count,
            "createdAt": at, "updatedAt": at, "localStatus": "available"]
        let host = core(faults); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "webdav"])
        _ = try await command(host, "testSyncConnection", ["webdav": fields])
        _ = try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        await host.close()
        if pendingLocal {
            let db = try SQLiteBridge(url: database)
            _ = try db.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([try json([attachment]), taskID])); db.close()
        }
        let fresh = core(faults); _ = try await fresh.start(); _ = try await command(fresh, "openSyncSettings")
        let card = try await encryptionRows(fresh)
        XCTAssertTrue(card.contains { ($0["action"] as? [String: Any])?["flow"] as? String == "enable" })
        return fresh
    }
    private func enterEnable(_ host: CoreHost, _ value: String, open: Bool = true) async throws {
        if open { _ = try await action(host, ["type": "open", "flow": "enable"]) }
        for field in ["next", "confirm"] { _ = try await action(host, ["type": "typed", "field": field, "value": value]) }
    }
    private func enabledHost(_ faults: HostIOFaults = HostIOFaults(), pendingLocal: Bool = true) async throws -> (host: CoreHost, original: [String: Data]) {
        let host = try await plaintextHost(faults, pendingLocal: pendingLocal), original = remote.snapshot
        try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        try assertEnableCompleted(original); assertDrained()
        return (host, original)
    }
    private func enterChange(_ host: CoreHost, current: String, next: String, open: Bool = true) async throws {
        if open { _ = try await action(host, ["type": "open", "flow": "change"]) }
        _ = try await action(host, ["type": "typed", "field": "current", "value": current])
        for field in ["next", "confirm"] { _ = try await action(host, ["type": "typed", "field": field, "value": next]) }
    }
    private func encryptedPath(_ plaintextPath: String) -> String {
        plaintextPath == "/sync/data.json" ? "/sync/data.json.enc"
            : plaintextPath == "/sync/data.json.bak" ? "/sync/data.json.enc.bak" : plaintextPath
    }
    private func artifacts(_ snapshot: [String: Data]) -> [String: Data] {
        snapshot.filter { $0.key != "/sync/.mindwtr-sync-fence-v1.json" }
    }
    private func assertNoArtifactMutation(since index: Int) {
        let mutations = remote.recorded.dropFirst(index).filter { $0.method == "PUT" || $0.method == "DELETE" }
        var probePaths = Set<String>()
        for request in mutations {
            let fence = request.path == "/sync/.mindwtr-sync-fence-v1.json"
            let probe = request.path.range(of: "^/sync/data\\.json\\.mindwtr-etag-probe-[a-z0-9]+-[a-z0-9]*$", options: .regularExpression) != nil
            XCTAssertTrue(fence || probe, "Refused transitions cannot mutate a document or attachment")
            if fence {
                if request.method == "PUT" && request.status == 201 { XCTAssertEqual(request.condition, "none:*") }
                else {
                    XCTAssertEqual(request.status, 204); XCTAssertTrue(request.condition?.hasPrefix("match:") == true)
                }
            }
            if probe { probePaths.insert(request.path) }
        }
        XCTAssertLessThanOrEqual(probePaths.count, 1, "Only the exact owned capability probe can mutate outside the fence")
        for path in probePaths {
            let probeRequests = remote.recorded.dropFirst(index).filter { $0.path == path }
            XCTAssertEqual(probeRequests.map { $0.method }, ["PUT", "GET", "PUT", "PUT", "GET", "PUT", "DELETE", "GET", "DELETE"])
            XCTAssertEqual(probeRequests.map { $0.status }, [201, 200, 412, 204, 200, 412, 412, 200, 204])
            let puts = mutations.filter { $0.path == path && $0.method == "PUT" }
            XCTAssertEqual(puts.map { $0.status }, [201, 412, 204, 412])
            XCTAssertEqual(puts.prefix(2).map { $0.condition }, ["none:*", "none:*"])
            XCTAssertTrue(puts.suffix(2).allSatisfy { $0.condition?.hasPrefix("match:") == true })
            let deletes = mutations.filter { $0.path == path && $0.method == "DELETE" }
            XCTAssertEqual(deletes.map { $0.status }, [412, 204], "Stale deletion must refuse before verified conditional cleanup")
            XCTAssertTrue(deletes.allSatisfy { $0.condition?.hasPrefix("match:") == true })
            if puts.count == 4, deletes.count == 2 {
                XCTAssertEqual(puts[2].condition, puts[3].condition, "Replacement and stale write name the initial generation")
                XCTAssertEqual(deletes[0].condition, puts[2].condition, "Stale delete names the same retired initial generation")
                XCTAssertNotEqual(deletes[0].condition, deletes[1].condition, "Cleanup names the verified replacement generation")
            }
            XCTAssertNil(remote.bytes(path))
        }
    }
    private func expireRetainedFence() throws {
        let fence = try object(String(decoding: XCTUnwrap(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")), as: UTF8.self))
        let expires = try XCTUnwrap(fence["expiresAt"] as? NSNumber).doubleValue
        remote.advanceServerTime(to: Date(timeIntervalSince1970: (expires + 1_000) / 1_000))
    }
    private func assertChangeCompleted(_ original: [String: Data], oldKey: Data) throws {
        try assertEnableCompleted(original)
        let changedKey = try XCTUnwrap(cachedKey())
        XCTAssertNotEqual(changedKey, oldKey)
        for path in original.keys {
            let bytes = try XCTUnwrap(remote.bytes(encryptedPath(path)))
            XCTAssertThrowsError(try independentlyDecrypted(bytes, key: oldKey), "Every artifact retired the old generation")
        }
    }
    private func assertDisableCompleted(_ original: [String: Data], since index: Int) throws {
        XCTAssertNil(try cachedKey()); XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(artifacts(remote.snapshot), original)
        let requests = Array(remote.recorded.dropFirst(index))
        for path in ["/sync/data.json", "/sync/data.json.bak"] {
            XCTAssertNil(remote.bytes(encryptedPath(path)))
            if let deletion = requests.firstIndex(where: { $0.method == "DELETE" && $0.path == encryptedPath(path) && $0.status == 204 }) {
                let written = try XCTUnwrap(requests.firstIndex { $0.method == "PUT" && $0.path == path && $0.status == 201 })
                let verified = try XCTUnwrap(requests.indices.first { $0 > written && requests[$0].method == "GET" && requests[$0].path == path && requests[$0].status == 200 })
                XCTAssertLessThan(verified, deletion, "Verified plaintext precedes ciphertext removal")
                XCTAssertEqual(requests[written].condition, "none:*")
                XCTAssertTrue(requests[deletion].condition?.hasPrefix("match:") == true)
            }
        }
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
    }
    private func assertIncompleteTransitionBlocked(_ host: CoreHost, flow: String, expectedKind: String) async throws {
        let before = artifacts(remote.snapshot), domain = try rows(), state = try json(storedState()), currentKey = try cachedKey()
        let count = remote.recorded.count, operations = crypto?.counters.operations
        let wrongFlow = flow == "change" ? "disable" : "change"
        let refused = try await raw(host, "runSyncEncryptionAction", ["revision": try await revision(host), "action": ["type": "open", "flow": wrongFlow]])
        XCTAssertEqual(refused["ok"] as? Bool, false, "An unfinished journal only admits its own transition")
        let off = try await raw(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "off"])
        XCTAssertEqual(off["ok"] as? Bool, false)
        XCTAssertTrue(((off["error"] as? [String: Any])?["message"] as? String)?.contains("SYNC_ENCRYPTION_TRANSITION_INCOMPLETE") == true)
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertEqual(remote.recorded.count, count)
        XCTAssertEqual(try storedState()["incompleteTransition"] as? String, expectedKind)
        XCTAssertEqual(try json(storedState()), state); XCTAssertEqual(try cachedKey(), currentKey)
        try await assertPlaintextSyncBlocked(host)
        XCTAssertEqual(artifacts(remote.snapshot), before); XCTAssertEqual(try rows(), domain)
    }
    private func interruptedTransition(_ flow: String) async throws -> (requestID: String, original: [String: Data], oldKey: Data) {
        let gate = EncryptionKDFGate("Actual " + flow + " after verified backup before base conversion"), faults = HostIOFaults()
        defer { gate.unblock() }
        faults.configureHTTPJobs = { jobs in
            jobs.beforeCompletion = {
                let requests = self.remote.recorded
                if flow == "disable" {
                    if requests.last?.method == "DELETE", requests.last?.path == "/sync/data.json.enc.bak", requests.last?.status == 204 { gate.hold() }
                } else if requests.last?.method == "GET", requests.last?.path == "/sync/.mindwtr-sync-fence-v1.json", requests.last?.status == 200,
                          let write = requests.lastIndex(where: { $0.method == "PUT" && $0.path == "/sync/data.json.enc.bak" && $0.status == 204 }),
                          let verify = requests.lastIndex(where: { $0.method == "GET" && $0.path == "/sync/data.json.enc.bak" && $0.status == 200 }), verify > write {
                    // This next guarded read occurs after shared backup decrypt verification,
                    // before the base document's conditional rewrite.
                    gate.hold()
                }
            }
        }
        let enabled = try await enabledHost(faults), host = enabled.host, before = try rows(), initial = artifacts(remote.snapshot), configuration = try stored()
        let oldKey = try XCTUnwrap(cachedKey()), kind = flow == "change" ? "change-passphrase" : "disable"
        if flow == "change" { try await enterChange(host, current: passphrase, next: nextPassphrase) }
        else { _ = try await action(host, ["type": "open", "flow": "disable"]) }
        let requestID = UUID().uuidString.lowercased()
        let requestJSON = try json(["revision": try await revision(host), "action": ["type": "submit", "flow": flow], "requestId": requestID])
        let transitionStart = remote.recorded.count
        gate.arm()
        let request = Task { () -> Result<String, Error> in
            defer { gate.complete() }
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 30)
        XCTAssertFalse(gate.completed); XCTAssertEqual(http?.counters.running, 1)
        XCTAssertEqual(try storedState()["incompleteTransition"] as? String, kind)
        XCTAssertEqual(try cachedKey(), oldKey); XCTAssertEqual(remote.bytes("/sync/data.json.enc"), initial["/sync/data.json.enc"])
        let requests = Array(remote.recorded.dropFirst(transitionStart)), backup = flow == "change" ? "/sync/data.json.enc.bak" : "/sync/data.json.bak"
        let backupWrite = try XCTUnwrap(requests.firstIndex { $0.method == "PUT" && $0.path == backup && $0.status == (flow == "change" ? 204 : 201) })
        let backupRead = try XCTUnwrap(requests.indices.first { $0 > backupWrite && requests[$0].method == "GET" && requests[$0].path == backup && requests[$0].status == 200 })
        XCTAssertLessThan(backupRead, requests.count - 1, "The held callback follows actual read-back verification")
        if flow == "change" { XCTAssertTrue(requests[backupWrite].condition?.hasPrefix("match:") == true) }
        else { XCTAssertEqual(requests[backupWrite].condition, "none:*"); XCTAssertTrue(requests.last?.condition?.hasPrefix("match:") == true) }
        if flow == "change" {
            for path in ["/sync/attachments/alpha.bin", "/sync/attachments/beta.bin", "/sync/data.json.enc.bak"] {
                let changed = try XCTUnwrap(remote.bytes(path))
                XCTAssertNotEqual(changed, initial[path]); XCTAssertEqual(changed.prefix(6), Data("MWENC1".utf8))
                XCTAssertThrowsError(try independentlyDecrypted(changed, key: oldKey))
            }
            XCTAssertEqual(try independentlyDecrypted(XCTUnwrap(remote.bytes("/sync/data.json.enc")), key: oldKey), enabled.original["/sync/data.json"])
        } else {
            for path in ["/sync/attachments/alpha.bin", "/sync/attachments/beta.bin", "/sync/data.json.bak"] {
                XCTAssertEqual(remote.bytes(path), enabled.original[path])
            }
            XCTAssertNil(remote.bytes("/sync/data.json.enc.bak")); XCTAssertNil(remote.bytes("/sync/data.json"))
        }
        request.cancel(); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(gate.completed, "Cancellation keeps the accepted HTTP callback owned until drain")
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("Interrupted transition retains the library lease until drain") } catch {}
        gate.unblock()
        switch await request.value {
        case .success: XCTFail("Interrupted transition cannot report confirmation")
        case .failure(let error): XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try cachedKey(), oldKey)
        XCTAssertEqual(try storedState()["incompleteTransition"] as? String, kind)
        for name in configuration.keys where name != "@mindwtr_sync_encryption_state_v1" {
            XCTAssertEqual(try json(XCTUnwrap(stored()[name])), try json(XCTUnwrap(configuration[name])))
        }
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1, "Only completed setup Enable is confirmed")
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await host.close()
        return (requestID, enabled.original, oldKey)
    }
    private func independentlyDecrypted(_ bytes: Data, key: Data) throws -> Data {
        XCTAssertGreaterThanOrEqual(bytes.count, 70); XCTAssertEqual(bytes.prefix(8), Data("MWENC1".utf8) + Data([1, 1]))
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: bytes.subdata(in: 34..<46)),
            ciphertext: bytes.subdata(in: 54..<(bytes.count - 16)), tag: bytes.suffix(16))
        return try AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: bytes.prefix(54))
    }
    private func assertEnableCompleted(_ original: [String: Data]) throws {
        let currentKey = try XCTUnwrap(cachedKey()), state = try storedState()
        XCTAssertEqual(state["state"] as? String, "enabled"); XCTAssertNil(state["incompleteTransition"])
        let salt = try XCTUnwrap(state["discoveredSalt"] as? String)
        for (path, plaintext) in original {
            let encryptedPath = path == "/sync/data.json" ? "/sync/data.json.enc"
                : path == "/sync/data.json.bak" ? "/sync/data.json.enc.bak" : path
            let encrypted = try XCTUnwrap(remote.bytes(encryptedPath))
            XCTAssertEqual(try independentlyDecrypted(encrypted, key: currentKey), plaintext, "Conversion preserves exact domain bytes")
            XCTAssertEqual(encrypted.subdata(in: 18..<34).map { String(format: "%02x", $0) }.joined(), salt)
            if encryptedPath != path {
                XCTAssertNil(remote.bytes(path))
                let requests = remote.recorded
                let verification = try XCTUnwrap(requests.firstIndex { $0.method == "GET" && $0.path == encryptedPath && $0.status == 200 })
                let deletion = try XCTUnwrap(requests.firstIndex { $0.method == "DELETE" && $0.path == path && $0.status == 204 })
                XCTAssertLessThan(verification, deletion, "Read-back verification precedes conditional plaintext deletion")
                XCTAssertTrue(requests[deletion].condition?.hasPrefix("match:") == true)
            }
        }
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
    }
    private func assertPlaintextSyncBlocked(_ host: CoreHost) async throws {
        let before = remote.snapshot, count = remote.recorded.count, domain = try rows()
        let reply = try await command(host, "syncStored")
        XCTAssertEqual(reply["skipped"] as? Bool, true)
        _ = try await raw(host, "syncNow", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        XCTAssertEqual(remote.snapshot, before); XCTAssertEqual(try rows(), domain)
        XCTAssertFalse(remote.recorded.dropFirst(count).contains { $0.method == "PUT" },
            "Paused sync cannot publish the document or the actual pending local attachment")
        XCTAssertNil(remote.bytes("/sync/attachments/upload379.txt")); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        assertDrained()
    }
    private func interruptedEnable() async throws -> (requestID: String, original: [String: Data]) {
        let gate = EncryptionKDFGate("Verified backup deleted before native HTTP acknowledgement"), faults = HostIOFaults()
        defer { gate.unblock() }
        faults.configureHTTPJobs = { jobs in
            jobs.beforeCompletion = {
                if self.remote.recorded.last?.method == "DELETE", self.remote.recorded.last?.path == "/sync/data.json.bak",
                   self.remote.recorded.last?.status == 204 { gate.hold() }
            }
        }
        let host = try await plaintextHost(faults), before = try rows(), original = remote.snapshot, configuration = try stored()
        try await enterEnable(host, passphrase)
        let requestID = UUID().uuidString.lowercased()
        let requestJSON = try json(["revision": try await revision(host), "action": ["type": "submit", "flow": "enable"], "requestId": requestID])
        gate.arm()
        let request = Task { () -> Result<String, Error> in
            defer { gate.complete() }
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 30)
        XCTAssertFalse(gate.completed); XCTAssertEqual(http?.counters.running, 1)
        XCTAssertEqual(try storedState()["incompleteTransition"] as? String, "enable")
        XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        XCTAssertEqual(remote.bytes("/sync/data.json"), original["/sync/data.json"]); XCTAssertNil(remote.bytes("/sync/data.json.enc"))
        for path in ["/sync/attachments/alpha.bin", "/sync/attachments/beta.bin", "/sync/data.json.enc.bak"] {
            XCTAssertEqual(remote.bytes(path)?.prefix(6), Data("MWENC1".utf8))
            XCTAssertTrue(remote.recorded.contains { $0.method == "GET" && $0.path == path && $0.status == 200 })
        }
        XCTAssertNil(remote.bytes("/sync/data.json.bak"), "The actual conditional DELETE committed after shared decrypt verification")
        request.cancel(); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(gate.completed, "Cancelled delivery retains admitted HTTP until its terminal callback drains")
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("Interrupted Enable must retain library ownership until drain") } catch {}
        gate.unblock()
        switch await request.value {
        case .success: XCTFail("Interrupted Enable cannot report confirmation")
        case .failure(let error): XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
        }
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try rows(), before)
        for name in configuration.keys where name != "@mindwtr_sync_encryption_state_v1" {
            XCTAssertEqual(try json(XCTUnwrap(stored()[name])), try json(XCTUnwrap(configuration[name])))
        }
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); assertDrained(); await host.close()
        return (requestID, original)
    }
    private func assertRemoteDomainUnchanged(_ before: [String: Data]) {
        for path in before.keys { XCTAssertEqual(remote.bytes(path), before[path], "Original remote artifact retained") }
        XCTAssertNil(remote.bytes("/sync/data.json"), "Unlock cannot create plaintext")
        let extras = Set(remote.snapshot.keys).subtracting(before.keys)
        XCTAssertTrue(extras.isSubset(of: ["/sync/.mindwtr-sync-fence-v1.json"]), "Only the existing mutation lease can survive uncertainty")
    }
    private func assertBusyThenExpiredUnlock(_ host: CoreHost) async throws {
        let path = "/sync/.mindwtr-sync-fence-v1.json", before = remote.snapshot
        let bytes = try XCTUnwrap(remote.bytes(path)), record = try object(String(decoding: bytes, as: UTF8.self))
        let renewed = try XCTUnwrap(record["renewedAt"] as? NSNumber).doubleValue
        let expires = try XCTUnwrap(record["expiresAt"] as? NSNumber).doubleValue
        XCTAssertGreaterThan(expires, renewed + 1_000)
        // The provider's clock proves the retained holder is live, not presumed
        // abandoned. A new UUID cannot consume that holder or produce a key.
        remote.advanceServerTime(to: Date(timeIntervalSince1970: (renewed + 1_000) / 1_000))
        try await enter(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        let denied = try await encryptionRows(host)
        XCTAssertTrue(denied.contains { $0["tone"] as? String == "danger" }, "A live peer lease must keep retry visibly paused")
        XCTAssertTrue(denied.contains { ($0["action"] as? [String: Any])?["type"] as? String == "submit" && $0["enabled"] as? Bool == false },
            "A settled attempt retires its passphrase before another submission")
        XCTAssertEqual(remote.bytes(path), bytes); assertRemoteDomainUnchanged(before); XCTAssertEqual(try markers(), 0); assertDrained()
        // Expiry is established by the same authority; no fixture deletes the
        // lease. Shared conditional acquisition performs its ordinary CAS.
        remote.advanceServerTime(to: Date(timeIntervalSince1970: (expires + 1_000) / 1_000))
        _ = try await action(host, ["type": "typed", "field": "current", "value": passphrase])
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        XCTAssertEqual(try markers(), 1); XCTAssertNil(remote.bytes(path))
        for original in before.keys where original != path { XCTAssertEqual(remote.bytes(original), before[original]) }
    }
    private func assertDrained() {
        XCTAssertEqual(crypto?.counters.jobs, 0); XCTAssertEqual(crypto?.counters.running, 0)
        XCTAssertEqual(http?.counters.jobs, 0); XCTAssertEqual(http?.counters.running, 0)
        XCTAssertEqual(secrets?.counters.jobs, 0); XCTAssertEqual(secrets?.counters.running, 0)
    }
    func testLocalEnableAndDisableKeepOffTargetAndExactDomainAcrossColdHosts() async throws {
        let seed = core(); try await seedAndOpen(seed)
        let host = core(); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        let before = try rows(), configuration = try stored(), original = remote.snapshot
        let files = try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted()
        let operations = try XCTUnwrap(crypto).counters.operations
        XCTAssertEqual(configuration["@mindwtr_sync_backend"] as? String, "off")
        try await enterEnable(host, passphrase)
        let form = try await encryptionRows(host), fields = form.filter { $0["kind"] as? String == "field" }
        XCTAssertEqual(Set(fields.compactMap { $0["field"] as? String }), Set(["next", "confirm"]))
        XCTAssertTrue(fields.allSatisfy { $0["secure"] as? Bool == true && $0["value"] == nil })
        XCTAssertTrue(form.contains { $0["text"] as? String == "Sync is not set up yet — the passphrase is saved on this device now, and the first sync uploads everything already encrypted." })
        XCTAssertFalse(form.contains { let action = $0["action"] as? [String: Any]; return ["reveal", "generate", "decline", "recheck"].contains(action?["type"] as? String ?? "") || ["change", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") })
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        let material = try XCTUnwrap(cachedKey()), enabledState = try storedState(), enabledConfiguration = try stored()
        XCTAssertEqual(material.count, 32); XCTAssertGreaterThan(try XCTUnwrap(crypto).counters.operations, operations)
        XCTAssertEqual(enabledState["state"] as? String, "enabled"); XCTAssertNil(enabledState["incompleteTransition"]); XCTAssertNil(enabledState["partlyEncryptedScope"])
        XCTAssertEqual(try changedStoredCells(configuration, enabledConfiguration), ["@mindwtr_sync_encryption_state_v1"])
        let retired = try await encryptionRows(host)
        XCTAssertFalse(retired.contains { $0["kind"] as? String == "field" })
        XCTAssertTrue(retired.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == "disable" && $0["enabled"] as? Bool == true })
        XCTAssertFalse(retired.contains { let action = $0["action"] as? [String: Any]; return ["change", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || ["reveal", "generate", "decline", "recheck"].contains(action?["type"] as? String ?? "") })
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(remote.snapshot, original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1); assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(try json(storedState()), try json(enabledState))
        XCTAssertEqual(try changedStoredCells(enabledConfiguration, stored()), [])
        let offered = try await encryptionRows(cold)
        XCTAssertTrue(offered.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == "disable" && $0["enabled"] as? Bool == true })
        XCTAssertFalse(offered.contains { let action = $0["action"] as? [String: Any]; return ["enable", "change", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || ["reveal", "generate", "decline", "recheck"].contains(action?["type"] as? String ?? "") || $0["kind"] as? String == "field" })
        _ = try await action(cold, ["type": "open", "flow": "disable"])
        let confirmation = try await encryptionRows(cold)
        XCTAssertFalse(confirmation.contains { $0["kind"] as? String == "field" })
        XCTAssertTrue(confirmation.contains { $0["tone"] as? String == "warning" && $0["text"] as? String == "Sync is not set up, so no synced files change — this only removes the passphrase and key from this device. A sync location that was encrypted earlier stays encrypted and still needs the passphrase." })
        _ = try await action(cold, ["type": "submit", "flow": "disable"], requestID: UUID().uuidString.lowercased())
        XCTAssertNil(try cachedKey()); XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"])
        let disabledConfiguration = try stored()
        XCTAssertEqual(try changedStoredCells(enabledConfiguration, disabledConfiguration), ["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(disabledConfiguration["@mindwtr_sync_backend"] as? String, "off")
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(remote.snapshot, original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 2); assertDrained(); await cold.close()
        let off = core(); _ = try await off.start(); _ = try await command(off, "openSyncSettings")
        let final = try await encryptionRows(off)
        XCTAssertTrue(final.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == "enable" && $0["enabled"] as? Bool == true })
        XCTAssertFalse(final.contains { let action = $0["action"] as? [String: Any]; return ["disable", "change", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || ["reveal", "generate", "decline", "recheck"].contains(action?["type"] as? String ?? "") || $0["kind"] as? String == "field" })
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try changedStoredCells(disabledConfiguration, stored()), [])
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(remote.snapshot, original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        assertDrained(); await off.close()
    }

    func testLocalEnableFirstWebDAVSaveUploadsCiphertextFromItsFirstCanonicalWrite() async throws {
        remote = EncryptionDAVStore(expectedAuthorization: "Basic " + Data(("synthetic:" + password).utf8).base64EncodedString())
        EncryptionDAVProtocol.install(hostname, store: remote)
        let seed = core(); try await seedAndOpen(seed)
        let host = core(); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        let material = try XCTUnwrap(cachedKey()), preparedState = try storedState()
        let backup = try object(await host.call("menuRead", argumentsJSON: json(["dataBackup", "{}"])))
        let expected = try object(XCTUnwrap(backup["content"] as? String)), expectedTasks = try XCTUnwrap(expected["tasks"] as? [[String: Any]])
        XCTAssertEqual(expectedTasks.count, 1); XCTAssertEqual(expectedTasks.first?["id"] as? String, taskID)
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertTrue(remote.snapshot.isEmpty)
        _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "webdav"])
        _ = try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        let encrypted = try XCTUnwrap(remote.bytes("/sync/data.json.enc"))
        let document = try object(String(decoding: independentlyDecrypted(encrypted, key: material), as: UTF8.self))
        XCTAssertEqual(try json(XCTUnwrap(document["tasks"])), try json(expectedTasks))
        for name in ["projects", "sections", "areas", "people"] {
            XCTAssertEqual(try json(document[name] ?? []), try json(expected[name] ?? []))
        }
        XCTAssertEqual(encrypted.subdata(in: 18..<34).map { String(format: "%02x", $0) }.joined(), preparedState["discoveredSalt"] as? String)
        let writes = remote.recorded.filter { $0.method == "PUT" && ["/sync/data.json", "/sync/data.json.enc", "/sync/data.json.bak", "/sync/data.json.enc.bak"].contains($0.path) }
        let first = try XCTUnwrap(writes.first)
        XCTAssertEqual(first.path, "/sync/data.json.enc"); XCTAssertEqual(first.status, 201); XCTAssertEqual(first.condition, "none:*")
        XCTAssertTrue(writes.allSatisfy { ["/sync/data.json.enc", "/sync/data.json.enc.bak"].contains($0.path) && $0.encryptedBody })
        XCTAssertFalse(remote.recorded.contains { $0.method == "PUT" && ["/sync/data.json", "/sync/data.json.bak"].contains($0.path) })
        // First Save uses the shared ordinary-sync writer reservation before its ciphertext write.
        let requests = remote.recorded
        let acquired = try XCTUnwrap(requests.firstIndex { $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.method == "PUT" && $0.status == 201 })
        let published = try XCTUnwrap(requests.firstIndex { $0.path == "/sync/data.json.enc" && $0.method == "PUT" })
        let released = try XCTUnwrap(requests.lastIndex { $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.method == "DELETE" && $0.status == 204 })
        XCTAssertLessThan(acquired, published); XCTAssertLessThan(published, released)
        XCTAssertEqual(requests[acquired].condition, "none:*")
        XCTAssertEqual(requests[released].condition, "match:" + (try XCTUnwrap(requests[acquired].responseEtag)))
        XCTAssertNil(remote.bytes("/sync/data.json")); XCTAssertNil(remote.bytes("/sync/data.json.bak")); XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        XCTAssertNil(try storedState()["incompleteTransition"]); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1); assertDrained(); await host.close()
        let completed = remote.snapshot, network = remote.recorded.count, cold = core()
        _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        let offered = try await encryptionRows(cold)
        for flow in ["change", "disable"] {
            XCTAssertTrue(offered.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == flow && $0["enabled"] as? Bool == true })
        }
        XCTAssertFalse(offered.contains { let action = $0["action"] as? [String: Any]; return ["enable", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || action?["type"] as? String == "recheck" || $0["kind"] as? String == "field" })
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(remote.snapshot, completed); XCTAssertEqual(remote.recorded.count, network)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await cold.close()
    }

    func testLocalEnableFirstWebDAVSaveUploadsEncryptedAttachmentBeforePublishingItsMetadata() async throws {
        remote = EncryptionDAVStore(expectedAuthorization: "Basic " + Data(("synthetic:" + password).utf8).base64EncodedString())
        EncryptionDAVProtocol.install(hostname, store: remote)
        let seed = core(); try await seedAndOpen(seed)
        let attachmentID = "first390", cloudKey = "attachments/first390.txt", blobPath = "/sync/" + cloudKey
        let attachment: [String: Any] = ["id": attachmentID, "kind": "file", "uri": localFile.absoluteString,
            "title": "First encrypted390.txt", "mimeType": "text/plain", "size": localBytes.count,
            "createdAt": at, "updatedAt": at, "localStatus": "available"]
        let db = try SQLiteBridge(url: database)
        _ = try db.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([try json([attachment]), taskID])); db.close()
        let host = core(); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        let before = try rows(), files = try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted()
        let backup = try object(await host.call("menuRead", argumentsJSON: json(["dataBackup", "{}"])))
        let expected = try object(XCTUnwrap(backup["content"] as? String)), seededTasks = try XCTUnwrap(expected["tasks"] as? [[String: Any]])
        XCTAssertEqual(seededTasks.count, 1); XCTAssertEqual(seededTasks.first?["id"] as? String, taskID)
        XCTAssertEqual(try json(XCTUnwrap(seededTasks.first?["attachments"])), try json([attachment]))
        let digest = SHA256.hash(data: localBytes).map { String(format: "%02x", $0) }.joined()
        var remoteAttachment = attachment
        remoteAttachment["uri"] = ""; remoteAttachment.removeValue(forKey: "localStatus")
        remoteAttachment["cloudKey"] = cloudKey; remoteAttachment["fileHash"] = digest
        var expectedTask = try XCTUnwrap(seededTasks.first); expectedTask["attachments"] = [remoteAttachment]
        try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        let material = try XCTUnwrap(cachedKey()), preparedState = try storedState()
        XCTAssertEqual(material.count, 32); XCTAssertEqual(preparedState["state"] as? String, "enabled")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertTrue(remote.snapshot.isEmpty)
        let cache = localFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("cache")
        let cacheFiles = try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted()
        _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "webdav"])
        _ = try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        let requests = remote.recorded
        let blobWrites = requests.enumerated().filter { $0.element.method == "PUT" && $0.element.path.hasPrefix("/sync/attachments/") }
        let firstBlob = try XCTUnwrap(blobWrites.first)
        XCTAssertEqual(firstBlob.element.path, blobPath); XCTAssertEqual(firstBlob.element.status, 201)
        XCTAssertEqual(firstBlob.element.condition, "none:*")
        for (_, request) in blobWrites {
            XCTAssertEqual(request.path, blobPath); XCTAssertTrue((200..<300).contains(request.status)); XCTAssertTrue(request.encryptedBody)
            XCTAssertEqual(try independentlyDecrypted(XCTUnwrap(request.encryptedBytes), key: material), localBytes)
        }
        XCTAssertEqual(try independentlyDecrypted(XCTUnwrap(remote.bytes(blobPath)), key: material), localBytes)
        let canonicalPaths = ["/sync/data.json", "/sync/data.json.enc", "/sync/data.json.bak", "/sync/data.json.enc.bak"]
        let documents = requests.enumerated().filter { $0.element.method == "PUT" && canonicalPaths.contains($0.element.path) }
        let firstDocument = try XCTUnwrap(documents.first)
        XCTAssertEqual(firstDocument.element.path, "/sync/data.json.enc"); XCTAssertEqual(firstDocument.element.status, 201)
        XCTAssertEqual(firstDocument.element.condition, "none:*")
        for (index, request) in documents {
            XCTAssertTrue(["/sync/data.json.enc", "/sync/data.json.enc.bak"].contains(request.path)); XCTAssertTrue(request.encryptedBody)
            XCTAssertTrue((200..<300).contains(request.status))
            let document = try object(String(decoding: independentlyDecrypted(XCTUnwrap(request.encryptedBytes), key: material), as: UTF8.self))
            XCTAssertEqual(try json(XCTUnwrap(document["tasks"])), try json([expectedTask]))
            for name in ["projects", "sections", "areas", "people"] { XCTAssertEqual(try json(document[name] ?? []), try json(expected[name] ?? [])) }
            // Every publishing snapshot must follow a successful ciphertext upload of the exact referenced bytes.
            XCTAssertLessThan(firstBlob.offset, index)
        }
        let finalDocument = try object(String(decoding: independentlyDecrypted(XCTUnwrap(remote.bytes("/sync/data.json.enc")), key: material), as: UTF8.self))
        XCTAssertEqual(try json(XCTUnwrap(finalDocument["tasks"])), try json([expectedTask]))
        XCTAssertFalse(requests.contains { $0.method == "PUT" && ["/sync/data.json", "/sync/data.json.bak"].contains($0.path) })
        XCTAssertFalse(requests.contains { $0.method == "DELETE" && $0.path == blobPath })
        let acquired = try XCTUnwrap(requests.firstIndex { $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.method == "PUT" && $0.status == 201 })
        let released = try XCTUnwrap(requests.lastIndex { $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.method == "DELETE" && $0.status == 204 })
        XCTAssertLessThan(acquired, firstBlob.offset); XCTAssertLessThan(firstDocument.offset, released)
        XCTAssertEqual(requests[acquired].condition, "none:*"); XCTAssertTrue(requests[released].condition?.hasPrefix("match:") == true)
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertNil(remote.bytes("/sync/data.json")); XCTAssertNil(remote.bytes("/sync/data.json.bak"))
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(try storedState()["discoveredSalt"] as? String, preparedState["discoveredSalt"] as? String)
        XCTAssertEqual(try storedState()["state"] as? String, "enabled"); XCTAssertNil(try storedState()["incompleteTransition"])
        let saved = try object(await host.call("menuRead", argumentsJSON: json(["dataBackup", "{}"])))
        let savedDocument = try object(XCTUnwrap(saved["content"] as? String)), savedTasks = try XCTUnwrap(savedDocument["tasks"] as? [[String: Any]])
        let savedAttachment = try XCTUnwrap((savedTasks.first?["attachments"] as? [[String: Any]])?.first)
        XCTAssertEqual(savedAttachment["id"] as? String, attachmentID); XCTAssertEqual(savedAttachment["uri"] as? String, localFile.absoluteString)
        XCTAssertEqual(savedAttachment["cloudKey"] as? String, cloudKey); XCTAssertEqual(savedAttachment["fileHash"] as? String, digest)
        XCTAssertEqual(savedAttachment["localStatus"] as? String, "available"); XCTAssertNil(savedAttachment["pendingContentUpload"]); XCTAssertNil(savedAttachment["deletedAt"])
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted(), cacheFiles)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1); assertDrained()
        let completed = remote.snapshot, network = requests.count, domain = try rows(), configuration = try stored()
        await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        let offered = try await encryptionRows(cold)
        for flow in ["change", "disable"] { XCTAssertTrue(offered.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == flow && $0["enabled"] as? Bool == true }) }
        XCTAssertFalse(offered.contains { let action = $0["action"] as? [String: Any]; return ["enable", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || action?["type"] as? String == "recheck" || $0["kind"] as? String == "field" })
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(try storedState()["state"] as? String, "enabled"); XCTAssertNil(try storedState()["incompleteTransition"])
        XCTAssertEqual(try rows(), domain); XCTAssertEqual(try changedStoredCells(configuration, stored()), [])
        XCTAssertEqual(remote.snapshot, completed); XCTAssertEqual(remote.recorded.count, network)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted(), cacheFiles)
        assertDrained(); await cold.close()
    }

    func testLocalEnablePromotedStateWithLostKVReplyNeverConfirmsAndColdPairStaysEnabled() async throws {
        let seed = core(); try await seedAndOpen(seed)
        let faults = HostIOFaults(), fault = EncryptionKDFGate("Local enabled state promoted before failed acknowledgement")
        let destination = manifest
        faults.configureDeviceStorage = { storage in
            storage.faults.afterPromotion = {
                guard let data = try? Data(contentsOf: destination),
                      let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let stateText = values["@mindwtr_sync_encryption_state_v1"] as? String,
                      let state = (try? JSONSerialization.jsonObject(with: Data(stateText.utf8))) as? [String: Any],
                      state["state"] as? String == "enabled" else { return }
                fault.complete(); throw HostFailure("Synthetic local state acknowledgement unavailable")
            }
        }
        let host = core(faults); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        let before = try rows(), configuration = try stored(), original = remote.snapshot
        let files = try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted()
        try await enterEnable(host, passphrase)
        do {
            _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
            XCTFail("Lost local KV acknowledgement cannot return a confirmed Enable")
        } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        XCTAssertTrue(fault.completed, "The actual local enabled-state promotion fault fired")
        let material = try XCTUnwrap(cachedKey()), promotedState = try storedState(), promotedConfiguration = try stored()
        XCTAssertEqual(material.count, 32); XCTAssertEqual(promotedState["state"] as? String, "enabled")
        XCTAssertNil(promotedState["incompleteTransition"]); XCTAssertNil(promotedState["partlyEncryptedScope"])
        XCTAssertEqual(try changedStoredCells(configuration, promotedConfiguration), ["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); XCTAssertEqual(try markers(), 0)
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(remote.snapshot, original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(try cachedKey(), material); XCTAssertEqual(try json(storedState()), try json(promotedState))
        XCTAssertEqual(try changedStoredCells(promotedConfiguration, stored()), [])
        let offered = try await encryptionRows(cold)
        XCTAssertTrue(offered.contains { $0["text"] as? String == "Sync encryption is on" })
        XCTAssertTrue(offered.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == "disable" && $0["enabled"] as? Bool == true })
        XCTAssertFalse(offered.contains { let action = $0["action"] as? [String: Any]; return ["enable", "change", "unlock", "abandon"].contains(action?["flow"] as? String ?? "") || ["decline", "recheck", "reveal", "generate"].contains(action?["type"] as? String ?? "") || $0["kind"] as? String == "field" })
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); XCTAssertEqual(try markers(), 0)
        XCTAssertTrue(remote.recorded.isEmpty); XCTAssertEqual(remote.snapshot, original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: localFile.deletingLastPathComponent().path).sorted(), files)
        assertDrained(); await cold.close()
    }

    func testSelectedEnableConvertsNativeArtifactsAndColdStartRetainsExactDomain() async throws {
        let host = try await plaintextHost(), before = try rows(), original = remote.snapshot, configuration = try stored()
        try await enterEnable(host, passphrase)
        let card = try await encryptionRows(host), fields = card.filter { $0["kind"] as? String == "field" }
        XCTAssertEqual(Set(fields.compactMap { $0["field"] as? String }), Set(["next", "confirm"]))
        XCTAssertTrue(fields.allSatisfy { $0["secure"] as? Bool == true && $0["value"] == nil })
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        try assertEnableCompleted(original); XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1)
        for name in configuration.keys where name != "@mindwtr_sync_encryption_state_v1" {
            XCTAssertEqual(try json(XCTUnwrap(stored()[name])), try json(XCTUnwrap(configuration[name])))
        }
        let completed = remote.snapshot, persistedKey = try cachedKey(); assertDrained(); await host.close()
        let cold = core(), network = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertEqual(remote.snapshot, completed)
        XCTAssertEqual(try cachedKey(), persistedKey); XCTAssertEqual(try rows(), before)
        let offered = try await encryptionRows(cold).compactMap { $0["action"] as? [String: Any] }
        XCTAssertFalse(offered.contains { $0["flow"] as? String == "enable" })
        for flow in ["change", "disable"] { XCTAssertTrue(offered.contains { $0["flow"] as? String == flow }) }
        assertDrained(); await cold.close()
    }
    func testInterruptedVerifiedEnableColdRetryRejectsWrongPassphraseAndReusesOriginalSalt() async throws {
        let interrupted = try await interruptedEnable(), before = try rows(), configuration = try Data(contentsOf: manifest)
        let cold = core(), network = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertNil(try cachedKey())
        let stamp = try await revision(cold), partial = remote.snapshot
        let replay = try await raw(cold, "runSyncEncryptionAction", ["revision": stamp, "action": ["type": "submit", "flow": "enable"], "requestId": interrupted.requestID])
        XCTAssertEqual(replay["ok"] as? Bool, false, "A cold UUID has no retained flow or passphrases")
        XCTAssertEqual(remote.snapshot, partial); XCTAssertNil(try cachedKey())
        let off = try await raw(cold, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "off"])
        XCTAssertEqual(off["ok"] as? Bool, false); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        try await assertPlaintextSyncBlocked(cold)
        let syncChanged = try changedStoredCells(object(String(decoding: configuration, as: UTF8.self)), stored())
        print("Task379 blocked Sync changed cell names: " + syncChanged.joined(separator: ","))
        XCTAssertTrue(Set(syncChanged).isSubset(of: ["@mindwtr_local_sync_status_v1"]), "Unexpected changed cell names: " + syncChanged.joined(separator: ","))
        let checkedConfiguration = try Data(contentsOf: manifest)
        let leasePath = "/sync/.mindwtr-sync-fence-v1.json"
        let lease = try object(String(decoding: XCTUnwrap(remote.bytes(leasePath)), as: UTF8.self))
        let renewed = try XCTUnwrap(lease["renewedAt"] as? NSNumber).doubleValue, expires = try XCTUnwrap(lease["expiresAt"] as? NSNumber).doubleValue
        remote.advanceServerTime(to: Date(timeIntervalSince1970: (renewed + 1_000) / 1_000))
        try await enterEnable(cold, passphrase)
        _ = try await action(cold, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(remote.snapshot, partial); XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), checkedConfiguration)
        let paused = try await encryptionRows(cold)
        XCTAssertTrue(paused.contains { $0["tone"] as? String == "danger" })
        XCTAssertTrue(paused.contains { ($0["action"] as? [String: Any])?["type"] as? String == "submit" && $0["enabled"] as? Bool == false })
        remote.advanceServerTime(to: Date(timeIntervalSince1970: (expires + 1_000) / 1_000))
        let operations = try XCTUnwrap(crypto).counters.operations
        try await enterEnable(cold, "wrong synthetic enable passphrase", open: false)
        _ = try await action(cold, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        XCTAssertGreaterThan(try XCTUnwrap(crypto).counters.operations, operations, "The wrong retry actually authenticates the persisted generation")
        for path in partial.keys where path != leasePath { XCTAssertEqual(remote.bytes(path), partial[path]) }
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), checkedConfiguration); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); assertDrained()
        try await enterEnable(cold, passphrase, open: false)
        _ = try await action(cold, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        try assertEnableCompleted(interrupted.original); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(remote.bytes("/sync/attachments/alpha.bin"), partial["/sync/attachments/alpha.bin"], "Verified ciphertext is reused byte-for-byte")
        XCTAssertEqual(remote.bytes("/sync/attachments/beta.bin"), partial["/sync/attachments/beta.bin"])
        XCTAssertEqual(remote.bytes("/sync/data.json.enc.bak"), partial["/sync/data.json.enc.bak"])
        XCTAssertNil(remote.bytes(leasePath)); XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1); assertDrained(); await cold.close()
    }
    func testActualAbandonQuarantinesSavedLocationAndOwnedRecheckKeepsMixedUntilPeerFinishes() async throws {
        let interrupted = try await interruptedEnable(), host = core(); _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        let before = try rows(), partial = remote.snapshot, network = remote.recorded.count
        _ = try await action(host, ["type": "open", "flow": "abandon"])
        let warning = try await encryptionRows(host)
        XCTAssertTrue(warning.contains { $0["tone"] as? String == "warning" })
        _ = try await action(host, ["type": "submit", "flow": "abandon"], requestID: UUID().uuidString.lowercased())
        let abandoned = try storedState(), scope = try XCTUnwrap(abandoned["partlyEncryptedScope"] as? String)
        XCTAssertFalse(scope.isEmpty); XCTAssertEqual(abandoned["state"] as? String, "off"); XCTAssertNil(abandoned["incompleteTransition"])
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        XCTAssertEqual(remote.snapshot, partial); XCTAssertEqual(remote.recorded.count, network, "Abandon is local-only")
        let replay = try await raw(host, "runSyncEncryptionAction", ["revision": try await revision(host), "action": ["type": "submit", "flow": "enable"], "requestId": interrupted.requestID])
        XCTAssertEqual(replay["ok"] as? Bool, false); XCTAssertNil(try cachedKey()); XCTAssertEqual(remote.snapshot, partial)
        try await assertPlaintextSyncBlocked(host)
        _ = try await action(host, ["type": "recheck"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(try storedState()["partlyEncryptedScope"] as? String, scope)
        XCTAssertEqual(remote.snapshot, partial); XCTAssertEqual(try rows(), before); XCTAssertNil(try cachedKey())
        // A peer's external completion is only the fixture precondition for Recheck,
        // not native Enable evidence; the interrupted native run above supplied that.
        for (path, bytes) in remote.snapshot where path != "/sync/.mindwtr-sync-fence-v1.json" && bytes.prefix(6) != Data("MWENC1".utf8) {
            let encryptedPath = path == "/sync/data.json" ? "/sync/data.json.enc"
                : path == "/sync/data.json.bak" ? "/sync/data.json.enc.bak" : path
            remote.seed(encryptedPath, bytes: try independentlyEncrypted(bytes))
            if encryptedPath != path { remote.removeAsPeer(path) }
        }
        let whole = remote.snapshot, requestID = UUID().uuidString.lowercased(), stamp = try await revision(host)
        _ = try await action(host, ["type": "recheck"], requestID: requestID, revision: stamp)
        XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(try markers("v1.3.5/encryption-recheck-posture"), 1)
        let checked = remote.recorded.count
        _ = try await action(host, ["type": "recheck"], requestID: requestID, revision: stamp)
        XCTAssertEqual(remote.recorded.count, checked, "An owned Recheck receipt survives its removed button")
        XCTAssertEqual(remote.snapshot, whole); XCTAssertNil(try cachedKey()); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 3); assertDrained(); await host.close()
        let cold = core(), count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count); XCTAssertNil(try cachedKey()); XCTAssertEqual(remote.snapshot, whole)
        // Whole ciphertext clears quarantine, but it cannot authorize plaintext publication.
        remote.advanceServerTime(to: Date().addingTimeInterval(3_600))
        let fencePath = "/sync/.mindwtr-sync-fence-v1.json", expiredFenceVersion = try XCTUnwrap(remote.etag("/sync/.mindwtr-sync-fence-v1.json"))
        let discovery = remote.recorded.count, outcome = try await command(cold, "syncStored")
        let statusText = try stored()["@mindwtr_local_sync_status_v1"] as? String
        let lastFailure = try statusText.map { try object($0)["lastSyncError"] as? String ?? "" } ?? ""
        let failureCategory = lastFailure.contains("SYNC_ENCRYPTION_PARTLY_ENCRYPTED") ? "partly-encrypted"
            : lastFailure.contains("SYNC_ENCRYPTION_TRANSITION_INCOMPLETE") ? "incomplete-transition"
                : lastFailure.contains("SYNC_REMOTE_MUTATION_FENCE") ? "remote-fence"
                    : lastFailure.contains("Attachment") || lastFailure.contains("attachment") ? "attachment"
                        : lastFailure.contains("invalid JSON") ? "invalid-json" : lastFailure.isEmpty ? "none" : "unclassified"
        let classifiedState = try storedState()
        print("Task379 cold discovery witness category=\(failureCategory) requarantined=\(classifiedState["partlyEncryptedScope"] is String) success=\(outcome["success"] as? Bool == true) skipped=\(outcome["skipped"] as? Bool == true)")
        let requests = Array(remote.recorded.dropFirst(discovery))
        print("Task379 cold discovery synthetic HTTP witness: " + requests.prefix(32).map { "\($0.method) \($0.path) \($0.status)" }.joined(separator: "; "))
        XCTAssertTrue(remote.recorded.dropFirst(discovery).contains { $0.method == "GET" && $0.path == "/sync/data.json.enc" && $0.status == 200 },
            "Cold ordinary Sync must read the promoted ciphertext, outcome success=\(outcome["success"] as? Bool == true) skipped=\(outcome["skipped"] as? Bool == true)")
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        let mutations = requests.filter { $0.method == "PUT" || $0.method == "DELETE" }
        XCTAssertEqual(mutations.map { $0.method }, ["PUT", "DELETE"], "Only the expired fence is taken over and retired")
        XCTAssertEqual(mutations.map { $0.path }, [fencePath, fencePath], "No document or attachment mutation is admitted")
        XCTAssertEqual(mutations.map { $0.status }, [204, 204])
        XCTAssertEqual(mutations.first?.condition, "match:" + expiredFenceVersion)
        XCTAssertTrue(mutations.last?.condition?.hasPrefix("match:") == true)
        XCTAssertNotEqual(mutations.last?.condition, mutations.first?.condition, "Release checks the replacement fence generation")
        XCTAssertEqual(remote.snapshot, whole.filter { $0.key != fencePath }); XCTAssertNil(remote.bytes(fencePath))
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        assertDrained(); await cold.close()
    }
    func testEnableEncryptedEnvelopeCapRefusesBeforeJournalKeyOrArtifactMutation() async throws {
        let host = try await plaintextHost(), before = try rows(), configuration = try Data(contentsOf: manifest)
        remote.seed("/sync/attachments/z-cap.bin", bytes: Data(repeating: 7, count: NativeHTTPJobs.maximumBytes - 69))
        let original = remote.snapshot, count = remote.recorded.count
        try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        let requests = Array(remote.recorded.dropFirst(count))
        XCTAssertTrue(requests.contains { $0.method == "GET" && $0.path == "/sync/attachments/z-cap.bin" && $0.status == 200 })
        let puts = requests.filter { $0.method == "PUT" }
        let probePaths = Set(puts.map { $0.path }.filter { $0.range(of: "^/sync/data\\.json\\.mindwtr-etag-probe-[a-z0-9]+-[a-z0-9]*$", options: .regularExpression) != nil })
        XCTAssertEqual(probePaths.count, 1, "Only the owned strong-ETag capability probe may write outside the fence")
        let probe = try XCTUnwrap(probePaths.first), probePuts = puts.filter { $0.path == probe }
        XCTAssertTrue(puts.allSatisfy { $0.path == "/sync/.mindwtr-sync-fence-v1.json" || $0.path == probe })
        XCTAssertEqual(probePuts.map { $0.status }, [201, 412, 204, 412], "The exact create-only/stale-write capability sequence is exercised")
        XCTAssertEqual(probePuts.prefix(2).map { $0.condition }, ["none:*", "none:*"])
        XCTAssertTrue(probePuts.suffix(2).allSatisfy { $0.condition?.hasPrefix("match:") == true })
        XCTAssertTrue(requests.contains { $0.method == "DELETE" && $0.path == probe && $0.status == 204 && $0.condition?.hasPrefix("match:") == true })
        XCTAssertNil(remote.bytes(probe), "The exact owned probe was conditionally cleaned up")
        XCTAssertEqual(remote.snapshot, original); XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-enable-capacity"), 1)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); assertDrained(); await host.close()
    }
    func testEnableUnquotedETagRefusesBeforeProbeFenceCryptoOrDurableMutation() async throws {
        let host = try await plaintextHost(), before = try rows(), original = remote.snapshot, configuration = try Data(contentsOf: manifest)
        try await enterEnable(host, passphrase)
        let count = remote.recorded.count, operations = try XCTUnwrap(crypto).counters.operations
        remote.refuseStrongEtags(unquoted: true)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        let requests = Array(remote.recorded.dropFirst(count))
        XCTAssertEqual(requests.map { $0.method }, ["GET"], "An unsafe existing-document validator refuses before the capability probe or mutation fence")
        XCTAssertEqual(requests.map { $0.path }, ["/sync/data.json"])
        XCTAssertEqual(requests.map { $0.status }, [200])
        XCTAssertEqual(requests.map { $0.responseEtag }, ["fixture-unquoted-validator"], "The actual native GET receives an ETag header, not an omitted validator")
        XCTAssertFalse(requests.contains { $0.method == "PUT" || $0.method == "DELETE" })
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(remote.snapshot, original)
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertNil(try cachedKey())
        XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        if let text = try stored()["@mindwtr_sync_encryption_state_v1"] as? String {
            let state = try object(text)
            XCTAssertEqual(state["state"] as? String, "off"); XCTAssertNil(state["incompleteTransition"]); XCTAssertNil(state["partlyEncryptedScope"])
        }
        let card = try await encryptionRows(host), fields = card.filter { $0["kind"] as? String == "field" }
        XCTAssertTrue(card.contains { $0["tone"] as? String == "danger" && $0["text"] as? String == "This WebDAV server does not provide or enforce safe version checks (strong ETags and conditional writes), so Mindwtr cannot safely sync or change encryption. Use a compatible WebDAV provider, File Sync, or Dropbox." })
        XCTAssertEqual(Set(fields.compactMap { $0["field"] as? String }), Set(["next", "confirm"]))
        XCTAssertTrue(fields.allSatisfy { $0["secure"] as? Bool == true && $0["value"] == nil })
        let submit = try XCTUnwrap(card.first { ($0["action"] as? [String: Any])?["type"] as? String == "submit" })
        XCTAssertEqual(submit["enabled"] as? Bool, false); XCTAssertEqual(submit["busy"] as? Bool, false)
        XCTAssertFalse(card.contains { let action = $0["action"] as? [String: Any]; return action?["flow"] as? String == "abandon" || action?["type"] as? String == "recheck" })
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); XCTAssertEqual(try markers(), 0); assertDrained(); await host.close()
        let cold = core(), network = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        let offered = try await encryptionRows(cold)
        XCTAssertTrue(offered.contains { let action = $0["action"] as? [String: Any]; return action?["type"] as? String == "open" && action?["flow"] as? String == "enable" && $0["enabled"] as? Bool == true })
        XCTAssertFalse(offered.contains { let action = $0["action"] as? [String: Any]; return ["unlock", "change", "disable", "abandon"].contains(action?["flow"] as? String ?? "") || action?["type"] as? String == "recheck" || $0["kind"] as? String == "field" })
        XCTAssertEqual(remote.recorded.count, network); XCTAssertEqual(remote.snapshot, original)
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), configuration); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0)
        assertDrained(); await cold.close()
    }
    func testEnableRemoteCheckFailureRetainsOriginalArtifactsAndRetiresOwnedFields() async throws {
        let host = try await plaintextHost(), before = try rows(), original = remote.snapshot, configuration = try Data(contentsOf: manifest)
        remote.refuseGet("/sync/attachments/beta.bin", status: 503)
        try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        XCTAssertTrue(remote.recorded.contains { $0.method == "GET" && $0.path == "/sync/attachments/beta.bin" && $0.status == 503 })
        XCTAssertEqual(remote.snapshot, original); XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), configuration)
        let card = try await encryptionRows(host)
        XCTAssertTrue(card.contains { $0["tone"] as? String == "danger" })
        XCTAssertTrue(card.contains { ($0["action"] as? [String: Any])?["type"] as? String == "submit" && $0["enabled"] as? Bool == false })
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); assertDrained(); await host.close()
    }
    func testEnableFenceReleaseFailureIsExactCleanupDeferredWithoutConfirmation() async throws {
        let host = try await plaintextHost(), before = try rows(), original = remote.snapshot
        remote.refuseFenceRelease(); try await enterEnable(host, passphrase)
        _ = try await action(host, ["type": "submit", "flow": "enable"], requestID: UUID().uuidString.lowercased())
        try assertEnableCompleted(original); XCTAssertEqual(try rows(), before)
        let card = try await encryptionRows(host)
        XCTAssertTrue(card.contains { $0["tone"] as? String == "warning" && $0["text"] as? String == "Encryption was updated. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed." })
        XCTAssertTrue(remote.recorded.contains { $0.method == "DELETE" && $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.status == 503 })
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0)
        assertDrained(); await host.close()
        let cold = core(), count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count); try assertEnableCompleted(original); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 0); await cold.close()
    }
    func testSelectedChangeWrongThenCorrectAndDisablePreserveEveryArtifactAndColdDomain() async throws {
        let enabled = try await enabledHost(), host = enabled.host, before = try rows(), initial = remote.snapshot
        let oldKey = try XCTUnwrap(cachedKey()), oldState = try json(storedState()), count = remote.recorded.count
        try await enterChange(host, current: "wrong current synthetic382", next: nextPassphrase)
        let fields = try await encryptionRows(host).filter { $0["kind"] as? String == "field" }
        XCTAssertEqual(Set(fields.compactMap { $0["field"] as? String }), Set(["current", "next", "confirm"]))
        XCTAssertTrue(fields.allSatisfy { $0["secure"] as? Bool == true && $0["value"] == nil })
        _ = try await action(host, ["type": "submit", "flow": "change"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(remote.snapshot, initial); assertNoArtifactMutation(since: count)
        XCTAssertEqual(try cachedKey(), oldKey); XCTAssertEqual(try json(storedState()), oldState); XCTAssertEqual(try rows(), before)
        let wrongRows = try await encryptionRows(host)
        XCTAssertTrue(wrongRows.contains { $0["tone"] as? String == "danger" })
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1)
        try await enterChange(host, current: passphrase, next: nextPassphrase, open: false)
        _ = try await action(host, ["type": "submit", "flow": "change"], requestID: UUID().uuidString.lowercased())
        try assertChangeCompleted(enabled.original, oldKey: oldKey)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 2)
        let changed = remote.snapshot, newKey = try XCTUnwrap(cachedKey()); assertDrained(); await host.close()
        let cold = core(), startup = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, startup); XCTAssertEqual(remote.snapshot, changed)
        XCTAssertEqual(try cachedKey(), newKey); XCTAssertEqual(try rows(), before); try assertChangeCompleted(enabled.original, oldKey: oldKey)
        _ = try await action(cold, ["type": "open", "flow": "disable"])
        let disableRows = try await encryptionRows(cold)
        XCTAssertFalse(disableRows.contains { $0["kind"] as? String == "field" }, "Disable needs no passphrase fields")
        let disableStart = remote.recorded.count
        _ = try await action(cold, ["type": "submit", "flow": "disable"], requestID: UUID().uuidString.lowercased())
        try assertDisableCompleted(enabled.original, since: disableStart)
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 3); assertDrained(); await cold.close()
        let off = core(), network = remote.recorded.count; _ = try await off.start(); _ = try await command(off, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertNil(try cachedKey()); XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(remote.snapshot, enabled.original); XCTAssertEqual(try rows(), before)
        let offered = try await encryptionRows(off)
        XCTAssertTrue(offered.contains { ($0["action"] as? [String: Any])?["flow"] as? String == "enable" })
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await off.close()
    }
    func testInterruptedVerifiedChangeColdWrongNextRefusesThenSameInputsConvergeAllGenerations() async throws {
        let interrupted = try await interruptedTransition("change"), before = try rows(), initial = remote.snapshot
        let cold = core(), count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count); XCTAssertEqual(try cachedKey(), interrupted.oldKey)
        let replay = try await raw(cold, "runSyncEncryptionAction", ["revision": try await revision(cold), "action": ["type": "submit", "flow": "change"], "requestId": interrupted.requestID])
        XCTAssertEqual(replay["ok"] as? Bool, false); XCTAssertEqual(remote.recorded.count, count)
        try await assertIncompleteTransitionBlocked(cold, flow: "change", expectedKind: "change-passphrase")
        try expireRetainedFence()
        let wrongStart = remote.recorded.count, oldState = try json(storedState())
        try await enterChange(cold, current: passphrase, next: "wrong next synthetic382")
        _ = try await action(cold, ["type": "submit", "flow": "change"], requestID: UUID().uuidString.lowercased())
        XCTAssertTrue(remote.recorded.dropFirst(wrongStart).contains { $0.method == "GET" && $0.path == "/sync/data.json.enc.bak" && $0.status == 200 })
        XCTAssertEqual(artifacts(remote.snapshot), artifacts(initial)); assertNoArtifactMutation(since: wrongStart)
        XCTAssertEqual(try cachedKey(), interrupted.oldKey); XCTAssertEqual(try json(storedState()), oldState)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 1)
        let wrongRows = try await encryptionRows(cold)
        XCTAssertTrue(wrongRows.contains { $0["tone"] as? String == "danger" })
        try await enterChange(cold, current: passphrase, next: nextPassphrase, open: false)
        let retryStart = remote.recorded.count
        _ = try await action(cold, ["type": "submit", "flow": "change"], requestID: UUID().uuidString.lowercased())
        try assertChangeCompleted(interrupted.original, oldKey: interrupted.oldKey)
        for path in interrupted.original.keys {
            XCTAssertTrue(remote.recorded.dropFirst(retryStart).contains { $0.method == "PUT" && $0.path == encryptedPath(path) && $0.status == 204 && $0.condition?.hasPrefix("match:") == true },
                "Correct retry converges every predecessor/intermediate artifact under one current salt")
        }
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 2)
        let completed = remote.snapshot, persisted = try cachedKey(); assertDrained(); await cold.close()
        let fresh = core(), network = remote.recorded.count; _ = try await fresh.start(); _ = try await command(fresh, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertEqual(remote.snapshot, completed)
        XCTAssertEqual(try cachedKey(), persisted); XCTAssertEqual(try rows(), before); try assertChangeCompleted(interrupted.original, oldKey: interrupted.oldKey)
        assertDrained(); await fresh.close()
    }
    func testInterruptedVerifiedDisableColdCachedKeyRetryFinishesOnlyRemainingBaseDocument() async throws {
        let interrupted = try await interruptedTransition("disable"), before = try rows(), initial = remote.snapshot
        let cold = core(), count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count); XCTAssertEqual(try cachedKey(), interrupted.oldKey)
        try await assertIncompleteTransitionBlocked(cold, flow: "disable", expectedKind: "disable")
        XCTAssertEqual(remote.snapshot, initial); try expireRetainedFence()
        _ = try await action(cold, ["type": "open", "flow": "disable"])
        let retryStart = remote.recorded.count
        _ = try await action(cold, ["type": "submit", "flow": "disable"], requestID: UUID().uuidString.lowercased())
        try assertDisableCompleted(interrupted.original, since: retryStart)
        let artifactPuts = remote.recorded.dropFirst(retryStart).filter { $0.method == "PUT" && ($0.path.hasPrefix("/sync/attachments/") || $0.path == "/sync/data.json" || $0.path == "/sync/data.json.bak") }
        XCTAssertEqual(artifactPuts.map { $0.path }, ["/sync/data.json"], "Already verified plaintext is retained exactly without rewrites")
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 2); assertDrained(); await cold.close()
        let fresh = core(), network = remote.recorded.count; _ = try await fresh.start(); _ = try await command(fresh, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertEqual(remote.snapshot, interrupted.original)
        XCTAssertNil(try cachedKey()); XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"]); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await fresh.close()
    }
    private func abandonInterruptedTransition(_ flow: String) async throws -> (host: CoreHost, partial: [String: Data], domain: [String: String], scope: String) {
        _ = try await interruptedTransition(flow)
        let partial = remote.snapshot, domain = try rows(), configuration = try stored(), host = core()
        let startup = remote.recorded.count; _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, startup)
        _ = try await action(host, ["type": "open", "flow": "abandon"])
        let abandonRows = try await encryptionRows(host)
        XCTAssertFalse(abandonRows.contains { $0["kind"] as? String == "field" })
        let network = remote.recorded.count
        _ = try await action(host, ["type": "submit", "flow": "abandon"], requestID: UUID().uuidString.lowercased())
        let state = try storedState(), scope = try XCTUnwrap(state["partlyEncryptedScope"] as? String)
        let scopeComponents = try XCTUnwrap(NativeJSON.jsonObject(with: Data(scope.utf8)) as? [String])
        XCTAssertEqual(state["state"] as? String, "off"); XCTAssertEqual(scopeComponents, ["webdav", endpoint, "synthetic"])
        XCTAssertNil(state["incompleteTransition"]); XCTAssertNil(try cachedKey())
        XCTAssertEqual(try stored()["@mindwtr_sync_backend"] as? String, "webdav")
        XCTAssertEqual(remote.recorded.count, network, "Abandon clears only this device's transition and secure item")
        XCTAssertEqual(remote.snapshot, partial); XCTAssertEqual(try rows(), domain)
        for name in configuration.keys where name != "@mindwtr_sync_encryption_state_v1" {
            XCTAssertEqual(try json(XCTUnwrap(stored()[name])), try json(XCTUnwrap(configuration[name])))
        }
        try await assertPlaintextSyncBlocked(host); assertDrained(); await host.close()
        let cold = core(), count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count); XCTAssertEqual(try storedState()["partlyEncryptedScope"] as? String, scope)
        XCTAssertNil(try cachedKey()); XCTAssertEqual(remote.snapshot, partial); XCTAssertEqual(try rows(), domain)
        try await assertPlaintextSyncBlocked(cold)
        return (cold, partial, domain, scope)
    }
    func testActualChangeAbandonIsLocalOnlyAndWholeCiphertextRecheckColdDiscoversNoKey() async throws {
        let abandoned = try await abandonInterruptedTransition("change"), host = abandoned.host, count = remote.recorded.count
        XCTAssertTrue(artifacts(abandoned.partial).values.allSatisfy { $0.prefix(6) == Data("MWENC1".utf8) })
        _ = try await action(host, ["type": "recheck"], requestID: UUID().uuidString.lowercased())
        // Recheck classifies encryption posture, not uniform passphrase generation.
        // This real partial rotation is all ciphertext and may clear quarantine.
        XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"]); XCTAssertNil(try cachedKey())
        XCTAssertEqual(remote.snapshot, abandoned.partial); assertNoArtifactMutation(since: count)
        XCTAssertEqual(try markers("v1.3.5/encryption-recheck-posture"), 1); XCTAssertEqual(try rows(), abandoned.domain)
        assertDrained(); await host.close()
        let cold = core(), startup = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, startup); try expireRetainedFence()
        let discovery = remote.recorded.count; _ = try await command(cold, "syncStored")
        XCTAssertTrue(remote.recorded.dropFirst(discovery).contains { $0.method == "GET" && $0.path == "/sync/data.json.enc" && $0.status == 200 })
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        XCTAssertNil(try cachedKey()); assertNoArtifactMutation(since: discovery)
        XCTAssertEqual(artifacts(remote.snapshot), artifacts(abandoned.partial)); XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try rows(), abandoned.domain); XCTAssertNil(remote.bytes("/sync/attachments/upload379.txt"))
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await cold.close()
    }
    func testActualDisableAbandonIsLocalOnlyAndMixedRecheckKeepsColdScopeQuarantined() async throws {
        let abandoned = try await abandonInterruptedTransition("disable"), host = abandoned.host, count = remote.recorded.count
        let bytes = Array(artifacts(abandoned.partial).values)
        XCTAssertTrue(bytes.contains { $0.prefix(6) == Data("MWENC1".utf8) }); XCTAssertTrue(bytes.contains { $0.prefix(6) != Data("MWENC1".utf8) })
        _ = try await action(host, ["type": "recheck"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(try storedState()["partlyEncryptedScope"] as? String, abandoned.scope)
        XCTAssertNil(try cachedKey()); XCTAssertEqual(remote.snapshot, abandoned.partial); assertNoArtifactMutation(since: count)
        XCTAssertEqual(try rows(), abandoned.domain); try await assertPlaintextSyncBlocked(host)
        assertDrained(); await host.close()
        let cold = core(), startup = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, startup); XCTAssertEqual(try storedState()["partlyEncryptedScope"] as? String, abandoned.scope)
        XCTAssertNil(try cachedKey()); try await assertPlaintextSyncBlocked(cold)
        XCTAssertEqual(remote.snapshot, abandoned.partial); XCTAssertEqual(try rows(), abandoned.domain)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await cold.close()
    }
    func testPeerPlaintextDiscoveryAllowsSelectedDisableToClearOnlyLocalEncryptionPair() async throws {
        let enabled = try await enabledHost(pendingLocal: false), host = enabled.host, oldKey = try XCTUnwrap(cachedKey())
        for (path, plaintext) in enabled.original {
            // External peer precondition; native Disable evidence starts after discovery.
            remote.seed(path, bytes: plaintext)
            if encryptedPath(path) != path { remote.removeAsPeer(encryptedPath(path)) }
        }
        let peer = remote.snapshot, count = remote.recorded.count
        _ = try await raw(host, "syncNow", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
        XCTAssertTrue(remote.recorded.dropFirst(count).contains { $0.method == "GET" && $0.path == "/sync/data.json" && $0.status == 200 })
        XCTAssertEqual(try storedState()["state"] as? String, "remote-plaintext"); XCTAssertEqual(try cachedKey(), oldKey)
        XCTAssertEqual(remote.snapshot, peer); assertNoArtifactMutation(since: count)
        let before = try rows()
        _ = try await action(host, ["type": "open", "flow": "disable"])
        let disableStart = remote.recorded.count
        _ = try await action(host, ["type": "submit", "flow": "disable"], requestID: UUID().uuidString.lowercased())
        try assertDisableCompleted(enabled.original, since: disableStart); assertNoArtifactMutation(since: disableStart)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers("v1.3.5/ios-encryption-selected"), 2)
        assertDrained(); await host.close()
        let cold = core(), network = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, network); XCTAssertNil(try cachedKey()); XCTAssertNil(try stored()["@mindwtr_sync_encryption_state_v1"])
        XCTAssertEqual(remote.snapshot, peer); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        assertDrained(); await cold.close()
    }
    func testOffRefusesSeededIncompleteEnableAndColdHostRetainsSavedWebDAVTarget() async throws {
        let saved = try await lockedHost()
        await saved.close()
        // This manually staged, fixture-only sidecar proves selection admission.
        // It is not evidence of actual interrupted Enable conversion/recovery.
        var configuration = try stored()
        configuration["@mindwtr_sync_encryption_state_v1"] = try json(["state":"off","incompleteTransition":"enable"])
        try Data(json(configuration).utf8).write(to: manifest, options: .atomic)
        let originalManifest = try Data(contentsOf: manifest), before = try rows(), initial = remote.snapshot
        let network = remote.recorded.count, keyBefore = try cachedKey()
        #if os(macOS)
        let originalSecrets = try Data(contentsOf: fixtureSecrets)
        #endif
        var host = core()
        _ = try await host.start(); _ = try await command(host, "openSyncSettings")
        let requestID = UUID().uuidString.lowercased()
        for attempt in 0..<3 {
            if attempt == 2 {
                await host.close(); host = core()
                _ = try await host.start(); _ = try await command(host, "openSyncSettings")
            }
            XCTAssertEqual(try storedState()["state"] as? String, "off")
            XCTAssertEqual(try storedState()["incompleteTransition"] as? String, "enable")
            let reply = try await raw(host, "selectSyncBackend", ["requestId":attempt == 2 ? UUID().uuidString.lowercased() : requestID,"option":"off"])
            XCTAssertEqual(reply["ok"] as? Bool, false, "Warm retry and fresh cold request cannot disconnect an unfinished target")
            let error = try XCTUnwrap(reply["error"] as? [String:Any])
            XCTAssertTrue(try XCTUnwrap(error["message"] as? String).contains("SYNC_ENCRYPTION_TRANSITION_INCOMPLETE"))
            let model = try await command(host, "syncSettings")
            let options = try XCTUnwrap((model["backend"] as? [String:Any])?["options"] as? [[String:Any]])
            XCTAssertEqual(options.first { $0["selected"] as? Bool == true }?["option"] as? String, "webdav")
            XCTAssertTrue(model["off"] is NSNull, "Settings must keep the saved WebDAV target available for shared recovery")
            let card = try XCTUnwrap(model["encryption"] as? [String:Any]), cardRows = try XCTUnwrap(card["rows"] as? [[String:Any]])
            XCTAssertTrue(cardRows.contains { $0["tone"] as? String == "danger" && ($0["text"] as? String)?.contains("Sync remains paused") == true },
                "Actual persisted incomplete state must stay visibly paused")
            XCTAssertEqual(try Data(contentsOf: manifest), originalManifest)
            #if os(macOS)
            XCTAssertEqual(try Data(contentsOf: fixtureSecrets), originalSecrets, "No synthetic secure item changes")
            #endif
            XCTAssertEqual(try cachedKey(), keyBefore); XCTAssertEqual(try rows(), before)
            XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(remote.recorded.count, network, "Startup, open and Off refusal perform no HTTP")
            XCTAssertEqual(try Data(contentsOf: localFile), localBytes); XCTAssertEqual(crypto?.counters.operations, 0)
            assertDrained()
        }
        await host.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let guarded = try log.split(separator: "\n").filter { $0.contains("v1.3.5/sync-encryption-off-guard") }.map { try object(String($0)) }
        XCTAssertEqual(guarded.count, 3)
        for record in guarded {
            XCTAssertEqual(record["context"] as? [String:String],
                ["releaseCheck":"v1.3.5/sync-encryption-off-guard","operation":"select-off","outcome":"refused"])
        }
        XCTAssertFalse(log.contains(password)); XCTAssertFalse(log.contains(passphrase)); XCTAssertFalse(log.contains(keyHex))
        XCTAssertEqual(try markers(), 0, "Selecting Off cannot acknowledge an Unlock")
    }

    func testWrongThenCorrectPassphrasePersistsExactKeyAndColdExplicitSyncDecrypts() async throws {
        let host = try await lockedHost(), before = try rows(), initial = remote.snapshot, configuration = try stored()
        try await enter(host, "wrong synthetic passphrase")
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        let alerts = try await encryptionRows(host); XCTAssertTrue(alerts.contains { $0["tone"] as? String == "danger" })
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try json(stored()), try json(configuration)); XCTAssertEqual(try markers(), 0); assertDrained()
        _ = try await action(host, ["type": "typed", "field": "current", "value": passphrase])
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try Data(contentsOf: localFile), localBytes)
        for name in configuration.keys where name != "@mindwtr_sync_encryption_state_v1" { XCTAssertEqual(try json(XCTUnwrap(stored()[name])), try json(XCTUnwrap(configuration[name]))) }
        XCTAssertEqual(try markers(), 1); assertDrained(); await host.close()
        let cold = core(); let network = remote.recorded.count; _ = try await cold.start(); XCTAssertEqual(remote.recorded.count, network)
        _ = try await command(cold, "openSyncSettings"); XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        let reply = try await command(cold, "syncStored")
        XCTAssertEqual(reply["success"] as? Bool, true); XCTAssertEqual(reply["skipped"] as? Bool, false)
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let tasks = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT id,title,description FROM tasks ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(Set(tasks.compactMap { $0["id"] as? String }), Set([taskID, remoteTaskID]))
        XCTAssertEqual(tasks.first { $0["id"] as? String == taskID }?["description"] as? String, "Preserve notes370")
        XCTAssertEqual(remote.bytes("/sync/attachments/untouched.bin"), initial["/sync/attachments/untouched.bin"])
        XCTAssertEqual(remote.bytes("/sync/data.json.enc")?.prefix(6), Data("MWENC1".utf8))
        XCTAssertNil(remote.bytes("/sync/data.json")); XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await cold.close()
    }
    func testNotNowPersistsNoKeyAndColdOpenStillOffersUnlock() async throws {
        let host = try await lockedHost(), before = try rows(), initial = remote.snapshot, config = try stored()
        try await enter(host, passphrase)
        _ = try await action(host, ["type": "decline"], requestID: UUID().uuidString.lowercased())
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try json(stored()), try json(config)); XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try markers(), 0); assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        let coldRows = try await encryptionRows(cold)
        XCTAssertTrue(coldRows.contains { ($0["action"] as? [String: Any])?["flow"] as? String == "unlock" })
        await cold.close()
    }
    func testUnsupportedMalformedAndStaleActionsRefuseBeforeCryptoOrDurableWrites() async throws {
        let host = try await lockedHost(), before = try rows(), config = try Data(contentsOf: manifest), initial = remote.snapshot
        let operations = try XCTUnwrap(crypto).counters.operations
        let current = try await revision(host)
        for value: [String: Any] in [["type": "generate"], ["type": "reveal"], ["type": "recheck"], ["type": "typed", "field": "unknown", "value": "synthetic"], ["type": "typed", "field": "current", "value": String(repeating: "a", count: 1001)], ["type": "typed", "field": "confirm", "value": String(repeating: "🧠", count: 501)]] {
            do { _ = try await raw(host, "runSyncEncryptionAction", ["revision": current, "action": value]); XCTFail("Unsupported native action admitted") } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        }
        for value: [String: Any] in [["type": "open", "flow": "change"], ["type": "open", "flow": "disable"], ["type": "open", "flow": "enable"], ["type": "open", "flow": "abandon"], ["type": "typed", "field": "next", "value": "synthetic"]] {
            let refused = try await raw(host, "runSyncEncryptionAction", ["revision": current, "action": value])
            XCTAssertEqual(refused["ok"] as? Bool, false, "Selected grammar cannot bypass the shared locked-state policy")
        }
        let recheck = try await raw(host, "runSyncEncryptionAction", ["revision": current, "action": ["type": "recheck"], "requestId": UUID().uuidString.lowercased()])
        XCTAssertEqual(recheck["ok"] as? Bool, false, "Owned Recheck requires a quarantined saved location")
        let stale = try await raw(host, "runSyncEncryptionAction", ["revision": "stale", "action": ["type": "open", "flow": "unlock"]])
        XCTAssertEqual(stale["ok"] as? Bool, false)
        for value: [String: Any] in [["action": ["type": "cancel"]], ["revision": current, "action": ["type": "submit", "flow": "unlock"], "requestId": "invalid"], ["revision": current, "action": ["type": "cancel"], "extra": true]] {
            do { _ = try await raw(host, "runSyncEncryptionAction", value); XCTFail("Malformed native input admitted") } catch {}
        }
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertNil(try cachedKey()); XCTAssertEqual(try Data(contentsOf: manifest), config)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try markers(), 0); assertDrained(); await host.close()
    }
    func testCancelledKDFRetainsExactOwnerUntilDrainThenFreshUnlockRemainsLive() async throws {
        let gate = EncryptionKDFGate(), faults = HostIOFaults(); defer { gate.unblock() }
        faults.cryptoBeforeOperation = { gate.visit($0) }
        let host = try await lockedHost(faults), before = try rows(), config = try stored(), initial = remote.snapshot
        try await enter(host, passphrase)
        let input: [String: Any] = ["revision": try await revision(host), "action": ["type": "submit", "flow": "unlock"], "requestId": UUID().uuidString.lowercased()]
        let requestJSON = try json(input); gate.arm()
        let request = Task { () -> Result<String, Error> in
            defer { gate.complete() }
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 5)
        XCTAssertEqual(crypto?.counters.running, 1)
        request.cancel(); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(gate.completed, "Cancellation must wait for the accepted native KDF")
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("The running KDF must retain its library lease") } catch {}
        gate.unblock()
        switch await request.value {
        case .success: XCTFail("Cancelled Unlock must not return a confirmed result")
        case .failure(let error): XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
        }
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try json(stored()), try json(config)); XCTAssertEqual(try rows(), before)
        assertRemoteDomainUnchanged(initial);
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try markers(), 0); assertDrained(); await host.close()
        let fresh = core(); _ = try await fresh.start(); _ = try await command(fresh, "openSyncSettings")
        try await assertBusyThenExpiredUnlock(fresh)
        assertDrained(); await fresh.close()
    }
    func testChangedSavedTransportDuringKDFRefusesBeforeKeyPublication() async throws {
        let gate = EncryptionKDFGate(), faults = HostIOFaults(); defer { gate.unblock() }
        faults.cryptoBeforeOperation = { gate.visit($0) }
        let host = try await lockedHost(faults), before = try rows(), initial = remote.snapshot
        try await enter(host, passphrase)
        let input: [String: Any] = ["revision": try await revision(host), "action": ["type": "submit", "flow": "unlock"], "requestId": UUID().uuidString.lowercased()]
        let requestJSON = try json(input); gate.arm()
        let request = Task { () -> Result<String, Error> in
            defer { gate.complete() }
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 5); XCTAssertEqual(crypto?.counters.running, 1)
        var changed = try stored(); changed["@mindwtr_webdav_url"] = "https://" + hostname + "/sync/changed.json"
        try Data(json(changed).utf8).write(to: manifest, options: .atomic)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(gate.completed, "A changed owner cannot abandon an admitted KDF")
        gate.unblock()
        switch await request.value {
        case .success: XCTFail("Changed transport cannot return a confirmed Unlock")
        case .failure(let error): XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
        }
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try json(stored()), try json(changed)); XCTAssertEqual(try rows(), before)
        assertRemoteDomainUnchanged(initial);
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try markers(), 0); assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start()
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try json(stored()), try json(changed)); XCTAssertEqual(try rows(), before); await cold.close()
    }
    func testCloseWaitsForAcceptedKDFAndNeverPublishesItsLateKey() async throws {
        let gate = EncryptionKDFGate(), closing = EncryptionKDFGate(), faults = HostIOFaults(); defer { gate.unblock() }
        faults.cryptoBeforeOperation = { gate.visit($0) }
        let host = try await lockedHost(faults), before = try rows(), config = try stored(), initial = remote.snapshot
        try await enter(host, passphrase)
        let input: [String: Any] = ["revision": try await revision(host), "action": ["type": "submit", "flow": "unlock"], "requestId": UUID().uuidString.lowercased()]
        let requestJSON = try json(input); gate.arm()
        let request = Task { () -> Result<String, Error> in
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 5); XCTAssertEqual(crypto?.counters.running, 1)
        let close = Task { await host.close(); closing.complete() }
        try await Task.sleep(nanoseconds: 50_000_000); XCTAssertFalse(closing.completed, "Close must retain the lease until KDF drain")
        let replacement = core()
        do { _ = try await replacement.start(); XCTFail("Close cannot release library ownership before KDF completion") } catch {}
        gate.unblock()
        switch await request.value { case .success: XCTFail("Close must not deliver a late Unlock"); case .failure: break }
        await close.value
        XCTAssertNil(try cachedKey()); XCTAssertEqual(try json(stored()), try json(config)); XCTAssertEqual(try rows(), before)
        assertRemoteDomainUnchanged(initial);
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json")); XCTAssertEqual(try markers(), 0); assertDrained()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        try await assertBusyThenExpiredUnlock(cold)
        assertDrained(); await cold.close()
    }

    func testPersistedSecretWithLostReplyIsNeverConfirmedAndColdStateStaysPaused() async throws {
        let gate = EncryptionKDFGate("Synthetic encryption key persisted before reply"), faults = HostIOFaults()
        defer { gate.unblock() }
        let hooks = NativeAttachmentHostHooks()
        #if os(macOS)
        let secretFile = fixtureSecrets, expected = key().base64EncodedString()
        hooks.configureJobs = { jobs in
            jobs.afterWork = { _, _ in
                guard let data = try? Data(contentsOf: secretFile),
                      let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      record["mindwtr_sync_encryption_key_v1"] as? String == expected else { return }
                gate.hold()
            }
        }
        #else
        faults.secretAfterOperation = { operation, alias in
            if operation == "set" && alias == "no-auth" { gate.hold() }
        }
        #endif
        let host = try await lockedHost(faults, fileHooks: hooks), before = try rows(), initial = remote.snapshot
        try await enter(host, passphrase)
        let input: [String: Any] = ["revision": try await revision(host), "action": ["type": "submit", "flow": "unlock"], "requestId": UUID().uuidString.lowercased()]
        let requestJSON = try json(input); gate.arm()
        let request = Task { () -> Result<String, Error> in
            defer { gate.complete() }
            do { return .success(try await host.foregroundSync(command: "runSyncEncryptionAction", requestJSON: requestJSON)) }
            catch { return .failure(error) }
        }
        await fulfillment(of: [gate.reached], timeout: 5)
        XCTAssertEqual(try cachedKey(), key(), "The write completed before its reply was withheld")
        request.cancel(); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(gate.completed, "Cancelled delivery must retain the accepted write until drain")
        gate.unblock()
        switch await request.value {
        case .success: XCTFail("Lost secret reply must not return a confirmed result")
        case .failure(let error): XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed")
        }
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        XCTAssertEqual(try markers(), 0); XCTAssertEqual(try rows(), before); assertRemoteDomainUnchanged(initial); assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key")
        let offered = try await encryptionRows(cold)
        XCTAssertTrue(offered.contains { ($0["action"] as? [String: Any])?["flow"] as? String == "unlock" })
        XCTAssertEqual(try markers(), 0); await cold.close()
    }
    func testPromotedEnabledStateWithLostKVReplyRefusesConfirmationThenColdPairRemainsUsable() async throws {
        let faults = HostIOFaults(), fault = EncryptionKDFGate("Enabled state promoted before failed acknowledgement")
        let destination = manifest
        faults.configureDeviceStorage = { storage in
            storage.faults.afterPromotion = {
                guard let data = try? Data(contentsOf: destination),
                      let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let stateText = values["@mindwtr_sync_encryption_state_v1"] as? String,
                      let state = (try? JSONSerialization.jsonObject(with: Data(stateText.utf8))) as? [String: Any],
                      state["state"] as? String == "enabled" else { return }
                fault.complete(); throw HostFailure("Synthetic state acknowledgement unavailable")
            }
        }
        let host = try await lockedHost(faults), before = try rows(), initial = remote.snapshot
        try await enter(host, passphrase)
        do {
            _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
            XCTFail("Lost KV acknowledgement cannot return a confirmed Unlock")
        } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        XCTAssertTrue(fault.completed, "The actual enabled-state promotion fault fired")
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        XCTAssertEqual(try markers(), 0); XCTAssertEqual(try rows(), before); assertRemoteDomainUnchanged(initial); assertDrained(); await host.close()
        let cold = core(); _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        // The uncertain owner's retained remote lease expires under the provider's
        // authority clock. This never deletes or fabricates a native success receipt.
        remote.advanceServerTime(to: Date().addingTimeInterval(3_600))
        let result = try await command(cold, "syncStored")
        XCTAssertEqual(result["success"] as? Bool, true); XCTAssertEqual(result["skipped"] as? Bool, false)
        XCTAssertEqual(try markers(), 0); XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await cold.close()
    }
    func testFenceReleaseFailureIsKnownCleanupDeferredAndNeverEmitsConfirmedUnlockMarker() async throws {
        let host = try await lockedHost(), before = try rows(), initial = remote.snapshot
        try await enter(host, passphrase); remote.refuseFenceRelease()
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled")
        let warningRows = try await encryptionRows(host)
        XCTAssertTrue(warningRows.contains {
            $0["tone"] as? String == "warning" && $0["text"] as? String == "Encryption was updated. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed."
        }, "The exact cleanup-deferred message must be visible")
        XCTAssertFalse(warningRows.contains { $0["tone"] as? String == "danger" })
        XCTAssertTrue(remote.recorded.contains { $0.method == "DELETE" && $0.path == "/sync/.mindwtr-sync-fence-v1.json" && $0.status == 503 }, "The actual fence release was refused")
        XCTAssertNotNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        XCTAssertEqual(try markers(), 0); XCTAssertEqual(try rows(), before); assertRemoteDomainUnchanged(initial)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await host.close()
        let cold = core(); let count = remote.recorded.count; _ = try await cold.start(); _ = try await command(cold, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, count, "Restart does not launch detached fence cleanup")
        XCTAssertEqual(try cachedKey(), key()); XCTAssertEqual(try storedState()["state"] as? String, "enabled"); XCTAssertEqual(try markers(), 0); await cold.close()
    }

    func testMissingStrongETagRefusesBeforeMutationFenceKeyOrEnabledState() async throws {
        let host = try await lockedHost(), before = try rows(), config = try json(stored()), initial = remote.snapshot
        try await enter(host, passphrase)
        let count = remote.recorded.count, operations = try XCTUnwrap(crypto).counters.operations
        remote.refuseStrongEtags()
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        let requests = Array(remote.recorded.dropFirst(count))
        XCTAssertFalse(requests.contains { $0.method == "PUT" && $0.path == "/sync/.mindwtr-sync-fence-v1.json" }, "ETag capability refusal precedes the mutation fence write")
        XCTAssertNil(remote.bytes("/sync/.mindwtr-sync-fence-v1.json"))
        for path in initial.keys { XCTAssertEqual(remote.bytes(path), initial[path], "Every original remote artifact is exact") }
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertNil(try cachedKey())
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key"); XCTAssertEqual(try json(stored()), config)
        let card = try await encryptionRows(host); XCTAssertTrue(card.contains { $0["tone"] as? String == "danger" })
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers(), 0); XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await host.close()
    }
    func testMalformedCiphertextRefusesWithoutAuthenticationOrPublication() async throws {
        let host = try await lockedHost(), before = try rows(), config = try json(stored())
        try await enter(host, passphrase)
        var corrupted = try XCTUnwrap(remote.bytes("/sync/data.json.enc")); corrupted[6] = 255
        remote.seed("/sync/data.json.enc", bytes: corrupted)
        let initial = remote.snapshot, operations = try XCTUnwrap(crypto).counters.operations
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertNil(try cachedKey())
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key"); XCTAssertEqual(try json(stored()), config)
        let card = try await encryptionRows(host)
        XCTAssertTrue(card.contains { $0["tone"] as? String == "danger" })
        XCTAssertFalse(card.contains { $0["text"] as? String == "That passphrase does not open this sync location. Check it and try again." }, "Format failure is not authentication failure")
        XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers(), 0)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await host.close()
    }
    func testNativeCiphertextResponseCapRefusesBeforeAuthenticationOrPublication() async throws {
        let host = try await lockedHost(), before = try rows(), config = try json(stored()), initial = remote.snapshot
        try await enter(host, passphrase)
        let count = remote.recorded.count, operations = try XCTUnwrap(crypto).counters.operations
        remote.declareGetLength("/sync/data.json.enc", bytes: NativeHTTPJobs.maximumBytes + 1)
        _ = try await action(host, ["type": "submit", "flow": "unlock"], requestID: UUID().uuidString.lowercased())
        XCTAssertTrue(remote.recorded.dropFirst(count).contains { $0.method == "GET" && $0.path == "/sync/data.json.enc" }, "The actual native response admission was exercised")
        XCTAssertEqual(crypto?.counters.operations, operations); XCTAssertNil(try cachedKey())
        XCTAssertEqual(try storedState()["state"] as? String, "remote-encrypted-no-key"); XCTAssertEqual(try json(stored()), config)
        let card = try await encryptionRows(host)
        XCTAssertTrue(card.contains { $0["tone"] as? String == "danger" })
        XCTAssertFalse(card.contains { $0["text"] as? String == "That passphrase does not open this sync location. Check it and try again." }, "Response cap refusal is not authentication failure")
        XCTAssertEqual(remote.snapshot, initial); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers(), 0)
        XCTAssertEqual(try Data(contentsOf: localFile), localBytes); assertDrained(); await host.close()
    }

}
