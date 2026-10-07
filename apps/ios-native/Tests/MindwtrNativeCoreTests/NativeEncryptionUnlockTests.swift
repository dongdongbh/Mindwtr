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
    struct Request: Equatable { let method: String; let path: String; let condition: String?; let status: Int; let serverDate: String }
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
    func refuseStrongEtags() { lock.lock(); omitEtags = true; lock.unlock() }
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
    func refuseGet(_ path: String, status: Int) { lock.lock(); getStatuses[path] = status; lock.unlock() }
    func declareGetLength(_ path: String, bytes: Int) { lock.lock(); declaredLengths[path] = bytes; lock.unlock() }
    func respond(_ request: URLRequest, body: Data) -> Reply {
        lock.lock(); defer { lock.unlock() }
        let url = request.url!, path = url.path, method = request.httpMethod ?? "GET"
        let match = request.value(forHTTPHeaderField: "If-Match")
        let none = request.value(forHTTPHeaderField: "If-None-Match")
        let condition = match.map { "match:" + $0 } ?? none.map { "none:" + $0 }
        let date = DateFormatter(); date.locale = Locale(identifier: "en_US_POSIX"); date.timeZone = TimeZone(secondsFromGMT: 0)
        date.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        func reply(_ status: Int, _ bytes: Data = Data(), etag: String? = nil, type: String = "application/octet-stream") -> Reply {
            let serverDate = date.string(from: serverTime ?? Date())
            requests.append(Request(method: method, path: path, condition: condition, status: status, serverDate: serverDate))
            var headers = ["Date": serverDate, "Content-Length": String(bytes.count), "Content-Type": type]
            if let etag, !omitEtags { headers["ETag"] = etag }
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
        supplied.configureCryptoJobs = { self.crypto = $0 }; supplied.configureHTTPJobs = { self.http = $0 }; supplied.configureSecretJobs = { self.secrets = $0 }
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
    private func markers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log, encoding: .utf8).components(separatedBy: "v1.3.5/ios-encryption-unlock").count - 1
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
        for value: [String: Any] in [["type": "open", "flow": "enable"], ["type": "generate"], ["type": "reveal"], ["type": "recheck"], ["type": "typed", "field": "next", "value": "synthetic"], ["type": "typed", "field": "current", "value": String(repeating: "a", count: 1001)]] {
            do { _ = try await raw(host, "runSyncEncryptionAction", ["revision": current, "action": value]); XCTFail("Unsupported native action admitted") } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        }
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
