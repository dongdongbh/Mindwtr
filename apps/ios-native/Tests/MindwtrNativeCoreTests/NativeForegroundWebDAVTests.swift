import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// A private DAV endpoint, not a claim of compatibility with a real backend.
/// Every request is intercepted, including unknown destinations.
private final class ForegroundDAVProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var stores: [String: ForegroundDAVStore] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ host: String, store: ForegroundDAVStore) { lock.lock(); stores[host] = store; lock.unlock() }
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

private final class ForegroundDAVStore: @unchecked Sendable {
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
    init(expectedAuthorization: String) { self.expectedAuthorization = expectedAuthorization }
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
            if let etag { headers["ETag"] = etag }
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

private struct ForegroundBoundarySnapshot {
    let journal: Data
    let journalInode: ino_t
    let target: Data
    let targetInode: ino_t
    let rows: [String: String]
    let manifest: Data
    let log: Data?
    let requests: Int
}

private final class ForegroundBoundaryState: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var snapshot: ForegroundBoundarySnapshot?
    private var cleanupCalls = 0
    func arm() { lock.lock(); armed = true; lock.unlock() }
    func visit(_ name: String, capture: () throws -> ForegroundBoundarySnapshot) throws {
        guard name == "afterIntent" else { return }
        lock.lock(); cleanupCalls += 1; let stop = armed && snapshot == nil; lock.unlock()
        guard stop else { return }
        let value = try capture()
        lock.lock(); snapshot = value; lock.unlock()
        throw HostFailure("Synthetic foreground cleanup interruption")
    }
    var captured: ForegroundBoundarySnapshot? { lock.lock(); defer { lock.unlock() }; return snapshot }
    var count: Int { lock.lock(); defer { lock.unlock() }; return cleanupCalls }
}

final class NativeForegroundWebDAVTests: XCTestCase {
    private var root: URL!, bundle: URL!, hostname: String!, service: String!, namespace: String!
    private var remote: ForegroundDAVStore!
    private var unexpectedBefore = 0
    private var traceBusyLease = false
    #if os(macOS)
    private let secretLock = NSLock()
    private var nativeSecretOperations = 0
    private var nativeCredentialObservations = 0
    private var fixtureSecrets: URL { root.appendingPathComponent("attachment-files/cache/foreground-fixture-secrets.json") }
    #endif
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let originalBytes = Data("Private synthetic foreground cleanup bytes".utf8)
    private let unknownValue = "Unknown current namespace value 🧠"
    private let password = "synthetic-dav-credential-318"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace!)/RCTAsyncLocalStorage_V1/manifest.json") }
    private var target: URL { root.appendingPathComponent("attachment-files/documents/attachments/\(attachmentID).txt") }
    private var logURL: URL { root.appendingPathComponent("logs/mindwtr.log") }
    private var endpoint: String { "https://\(hostname!)/sync/data.json" }
    private var fields: [String: Any] { ["url": endpoint, "username": "synthetic", "password": password, "allowInsecureHttp": false] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else { throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE") }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured foreground bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeForegroundWebDAVTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Foreground fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        #if os(macOS)
        // Workflow tests use durable synthetic credentials without entering the
        // interactive macOS Keychain. iOS keeps the actual Security port below.
        bundle = try NativeSyntheticSecretFixture.makeBundle(source: bundle, directory: root)
        #endif
        hostname = "foreground-" + UUID().uuidString.lowercased() + ".invalid"
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        namespace = "tech.dongdongbh.mindwtr.foreground." + UUID().uuidString.lowercased()
        let authorization = "Basic " + Data(("synthetic:" + password).utf8).base64EncodedString()
        remote = ForegroundDAVStore(expectedAuthorization: authorization); unexpectedBefore = ForegroundDAVProtocol.unexpectedCount
        ForegroundDAVProtocol.install(hostname, store: remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(ForegroundDAVProtocol.unexpectedCount, unexpectedBefore, "No request may escape the private endpoint")
        if let remote { XCTAssertEqual(remote.unexpectedCount, 0, "The fixture refused an unsupported request") }
        #if os(macOS)
        secretLock.lock(); let operations = nativeSecretOperations; secretLock.unlock()
        XCTAssertEqual(operations, 0, "macOS fixtures refuse native secret mutations and unscoped reads")
        #else
        if let service {
            // createSecureSyncConfigStore's secureKeyFor removes the storage '@'.
            for account in ["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"] {
                for alias in ["no-auth", "auth", "legacy"] {
                    let bytes = Data(account.utf8)
                    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
                        kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
                    if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-delete-before") }
                    let status = SecItemDelete(query as CFDictionary)
                    if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-delete-after") }
                    XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound, "Only exact fixture accounts are retired")
                }
            }
        }
        #endif
        if let hostname { ForegroundDAVProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func inode(_ url: URL) throws -> ino_t { var info = stat(); guard lstat(url.path, &info) == 0 else { throw HostFailure("Fixture inode is unavailable") }; return info.st_ino }
    private func core(boundary: ForegroundBoundaryState? = nil, faults supplied: HostIOFaults? = nil, observeNativeCredentials: Bool = false, selectedBundle: URL? = nil) -> CoreHost {
        let faults = supplied ?? HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForegroundDAVProtocol.self]; faults.httpConfiguration = configuration
        faults.secretService = service
        #if os(macOS)
        faults.secretBeforeOperation = { [weak self] operation, _ in
            guard let self else { return }
            self.secretLock.lock()
            if observeNativeCredentials && operation == "get" { self.nativeCredentialObservations += 1 }
            else { self.nativeSecretOperations += 1 }
            self.secretLock.unlock()
            if self.traceBusyLease { NSLog("Native WebDAV CI phase=secure-before operation=%@", operation) }
        }
        // Owned Project downloads compare native credential observations as well
        // as the JS fixture's saved value. Model an absent native account without
        // entering Security; the existing synthetic port still supplies Basic auth.
        // Every mutation and every read outside that explicit scope still refuses.
        faults.secretStatus = { operation, _ in
            observeNativeCredentials && operation == "get" ? errSecItemNotFound : errSecNotAvailable
        }
        #else
        if traceBusyLease {
            faults.secretBeforeOperation = { operation, _ in NSLog("Native WebDAV CI phase=secure-before operation=%@", operation) }
            faults.secretAfterOperation = { operation, _ in NSLog("Native WebDAV CI phase=secure-after operation=%@", operation) }
        }
        #endif
        if let boundary { faults.cleanupBoundary = { name in try boundary.visit(name) { try self.captureBoundary() } } }
        let value = CoreHost(databaseURL: database, bundleURL: selectedBundle ?? bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func projectCore(faults: HostIOFaults? = nil) throws -> CoreHost {
        #if os(macOS)
        // Capture the acknowledged synthetic Save before native selection. The
        // normal decorator reads its cache file on every get, which is correctly
        // forbidden inside a selected Project's target-only file capability.
        let bytes = try Data(contentsOf: fixtureSecrets)
        guard bytes.count <= 16 * 1024 else { throw HostFailure("Synthetic selected credential fixture is unavailable") }
        let values = try object(String(decoding: bytes, as: UTF8.self))
        let accounts = Set(["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"])
        guard Set(values.keys).isSubset(of: accounts), values.values.allSatisfy({ $0 is String }),
              values["mindwtr_webdav_password"] as? String == password else {
            throw HostFailure("Synthetic selected credential fixture is unavailable")
        }
        let snapshot = try json(values)
        let suffix = """
        ;(() => {
            const values = Object.freeze(\(snapshot));
            const refuse = async () => { throw new Error('Synthetic selected credential fixture is read-only'); };
            globalThis.__mindwtrSyncSecrets = {
                getSecret: async (name) => {
                    if (!['mindwtr_webdav_password', 'mindwtr_cloud_token', 'mindwtr_sync_encryption_key_v1'].includes(name)) return refuse();
                    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
                },
                setSecret: refuse, deleteSecret: refuse,
            };
        })();
        """
        let selectedBundle = root.appendingPathComponent("foreground-selected-core-host-" + UUID().uuidString.lowercased() + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n" + suffix).write(to: selectedBundle, atomically: true, encoding: .utf8)
        return core(faults: faults, observeNativeCredentials: true, selectedBundle: selectedBundle)
        #else
        return core(faults: faults)
        #endif
    }
    private func assertNativeCredentialObservation() {
        #if os(macOS)
        secretLock.lock(); let observations = nativeCredentialObservations; secretLock.unlock()
        XCTAssertGreaterThan(observations, 0, "The actual owned Project path must compare native credential observations")
        #endif
    }
    private func seed() async throws {
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "unknown": unknownValue]).utf8).write(to: manifest)
        let value = core(); let requests = remote.recorded.count
        _ = try await value.start(); XCTAssertEqual(remote.recorded.count, requests); await value.close()
        let at = ISO8601DateFormatter().string(from: Date())
        let hash = SHA256.hash(data: originalBytes).map { String(format: "%02x", $0) }.joined()
        let attachment: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Synthetic retained file.txt", "uri": target.absoluteString,
            "size": originalBytes.count, "mimeType": "text/plain", "fileHash": hash, "localStatus": "available",
            "createdAt": at, "updatedAt": at, "deletedAt": at]
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,attachments,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Foreground fixture task','inbox','[]','[]',?,'Preserve unrelated task notes',?,?,1,'fixture',0,0,0,0)",
            parametersJSON: json([taskID, try json([attachment]), at, at]))
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try originalBytes.write(to: target)
        // An absent plaintext document is intentionally legacy-plaintext in RN.
        // An existing canonical document makes the real Test connection prove
        // this server's strong conditional writes before cleanup is admitted.
        remote.seed("/sync/data.json", bytes: Data(try json(["tasks": [], "projects": [], "sections": [], "areas": [], "settings": [:]]).utf8))
    }
    private func command(_ host: CoreHost, _ name: String, _ input: [String: Any] = [:]) async throws -> [String: Any] {
        if traceBusyLease { NSLog("Native WebDAV CI phase=command-before command=%@", name) }
        let encoded = try await host.foregroundSync(command: name, requestJSON: json(input))
        if traceBusyLease { NSLog("Native WebDAV CI phase=command-after command=%@", name) }
        let reply = try object(encoded)
        XCTAssertEqual(reply["ok"] as? Bool, true, "The real shared command must succeed: \(name)")
        if reply["value"] is NSNull { return [:] }
        return try XCTUnwrap(reply["value"] as? [String: Any])
    }
    private func revision(_ host: CoreHost) async throws -> String {
        let model = try await command(host, "syncSettings")
        return try XCTUnwrap(model["configRevision"] as? String)
    }
    private func openAndTest(_ host: CoreHost) async throws {
        let before = remote.recorded.count
        _ = try await host.start(); XCTAssertEqual(remote.recorded.count, before, "Startup performs no network operation")
        _ = try await command(host, "openSyncSettings")
        _ = try await command(host, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "webdav"])
        _ = try await command(host, "testSyncConnection", ["webdav": fields])
        XCTAssertTrue(remote.recorded.contains { $0.condition == "none:*" })
        XCTAssertTrue(remote.recorded.contains { $0.condition?.hasPrefix("match:") == true })
        XCTAssertTrue(remote.recorded.contains { $0.status == 412 }, "The actual capability probe enforces conditional conflicts")
        XCTAssertEqual(try Data(contentsOf: target), originalBytes, "Connection proof does not clean local tombstones")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try manifestObject()["@mindwtr_sync_backend"] as? String, "off", "The form remains unacknowledged before verified Save")
    }
    private func save(_ host: CoreHost) async throws {
        _ = try await command(host, "saveSyncBackend", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
    }
    private func sync(_ host: CoreHost) async throws {
        _ = try await command(host, "syncNow", ["requestId": UUID().uuidString.lowercased(), "revision": try await revision(host), "webdav": fields])
    }
    private func manifestObject() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: manifest), as: UTF8.self)) }
    private func task() throws -> [String: Any] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM tasks WHERE id=?", parametersJSON: json([taskID])).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }
    private func attachment() throws -> [String: Any] {
        let text = try XCTUnwrap(try task()["attachments"] as? String)
        return try XCTUnwrap((NativeJSON.jsonObject(with: Data(text.utf8)) as? [[String: Any]])?.first)
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try values.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func captureBoundary() throws -> ForegroundBoundarySnapshot {
        XCTAssertEqual(try manifestObject()["@mindwtr_sync_backend"] as? String, "webdav", "The verified configuration is durable before ordinary cleanup")
        return ForegroundBoundarySnapshot(journal: try Data(contentsOf: journal), journalInode: try inode(journal), target: try Data(contentsOf: target),
            targetInode: try inode(target), rows: try rows(), manifest: try Data(contentsOf: manifest), log: try? Data(contentsOf: logURL), requests: remote.recorded.count)
    }
    private func markers(_ slug: String) throws -> [[String: Any]] {
        guard FileManager.default.fileExists(atPath: logURL.path) else { return [] }
        return try String(contentsOf: logURL, encoding: .utf8).split(separator: "\n").filter { $0.contains(slug) }.map { try object(String($0)) }
    }
    private func assertConfiguration() throws {
        let stored = try manifestObject()
        XCTAssertEqual(stored["@mindwtr_sync_backend"] as? String, "webdav")
        XCTAssertEqual(stored["unknown"] as? String, unknownValue)
        XCTAssertNil(stored["@mindwtr_webdav_password"], "No plaintext credential is written to device storage")
        #if os(macOS)
        if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-read-before") }
        let fixture = try object(String(decoding: Data(contentsOf: fixtureSecrets), as: UTF8.self))
        if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-read-after") }
        XCTAssertTrue(Set(fixture.keys).isSubset(of: ["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"]))
        XCTAssertEqual(fixture["mindwtr_webdav_password"] as? String, password, "The accepted Save durably stores the exact synthetic credential for cold VMs")
        #else
        let bytes = Data("mindwtr_webdav_password".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var result: CFTypeRef?
        if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-read-before") }
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        if traceBusyLease { NSLog("Native WebDAV CI phase=fixture-read-after") }
        XCTAssertEqual(result as? Data, Data(password.utf8), "The accepted Save uses actual isolated Security storage")
        #endif
    }
    private func assertCleaned(original: [String: Any]) throws {
        var expected = original; expected["localStatus"] = "missing"
        XCTAssertEqual(try json(attachment()), try json(expected), "Only the shared lifecycle's local status changes")
        XCTAssertEqual(try task()["id"] as? String, taskID)
        XCTAssertEqual(try task()["description"] as? String, "Preserve unrelated task notes")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    private func assertRemoteTask(original: [String: Any]) throws {
        let bytes = try XCTUnwrap(remote.bytes("/sync/data.json"))
        let data = try object(String(decoding: bytes, as: UTF8.self))
        let tasks = try XCTUnwrap(data["tasks"] as? [[String: Any]])
        let row = try XCTUnwrap(tasks.first { $0["id"] as? String == taskID }, "The actual Sync must publish the seeded Task, not merely retain the initial empty document")
        XCTAssertEqual(row["title"] as? String, "Foreground fixture task")
        XCTAssertEqual(row["description"] as? String, "Preserve unrelated task notes")
        let attachments = try XCTUnwrap(row["attachments"] as? [[String: Any]])
        let attachment = try XCTUnwrap(attachments.first { $0["id"] as? String == attachmentID })
        var expected = original; expected["uri"] = ""; expected.removeValue(forKey: "localStatus")
        XCTAssertEqual(try json(attachment), try json(expected), "Remote metadata retains the tombstone while excluding this device's local URI and status")
    }
    private func assertDiagnostics() throws {
        let foreground = try markers("v1.3.5/ios-foreground-sync-owned")
        XCTAssertTrue(foreground.contains { ($0["context"] as? [String: String])?["operation"] == "saveSyncBackend" })
        XCTAssertTrue(foreground.allSatisfy { ($0["context"] as? [String: String])?["outcome"] == "settled" })
        let cleanup = try markers("v1.3.5/ios-cleanup-owned-retirement")
        XCTAssertEqual(cleanup.count, 1)
        XCTAssertEqual(cleanup.first?["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-cleanup-owned-retirement", "operation": "cleanup-owned-retirement", "outcome": "removed"])
        let log = try String(contentsOf: logURL, encoding: .utf8)
        for secret in [password, service!, namespace!, hostname!, target.absoluteString, taskID, attachmentID, "Synthetic retained file.txt"] { XCTAssertFalse(log.contains(secret)) }
    }

    func testVerifiedSaveOrdinarySyncRetiresRealFileAndColdOpenDoesNotStartNetwork() async throws {
        try await seed()
        let original = try attachment(), boundary = ForegroundBoundaryState(), host = core(boundary: boundary)
        try await openAndTest(host); XCTAssertEqual(boundary.count, 0)
        try await save(host)
        XCTAssertEqual(boundary.count, 1, "Only Save's ordinary post-publication phase reaches physical cleanup")
        try assertCleaned(original: original); try assertConfiguration()
        try assertRemoteTask(original: original)
        try await sync(host); XCTAssertEqual(boundary.count, 1, "Processed tombstones do not acquire fresh deletion authority")
        _ = try await command(host, "closeSyncSettings"); await host.close()
        let cold = core(), count = remote.recorded.count
        _ = try await cold.start(); XCTAssertEqual(remote.recorded.count, count)
        let model = try await command(cold, "openSyncSettings")
        let options = try XCTUnwrap((model["backend"] as? [String: Any])?["options"] as? [[String: Any]])
        XCTAssertEqual(options.first { $0["selected"] as? Bool == true }?["option"] as? String, "webdav")
        XCTAssertEqual((model["panel"] as? [String: Any])?["kind"] as? String, "webdav")
        XCTAssertEqual(remote.recorded.count, count, "Cold settings open only reads persisted configuration")
        try assertCleaned(original: original); try assertConfiguration()
        let taskBeforeOff = try json(task())
        _ = try await command(cold, "selectSyncBackend", ["requestId": UUID().uuidString.lowercased(), "option": "off"])
        // This immediate read must be admitted by the real host: Off's receipt
        // cannot precede the status-reset store save acknowledgement.
        let off = try await command(cold, "syncSettings")
        let offOptions = try XCTUnwrap((off["backend"] as? [String: Any])?["options"] as? [[String: Any]])
        XCTAssertEqual(offOptions.first { $0["selected"] as? Bool == true }?["option"] as? String, "off")
        XCTAssertTrue(off["panel"] is NSNull)
        XCTAssertEqual(remote.recorded.count, count, "Turning Sync off and immediately reading settings performs no HTTP")
        XCTAssertEqual(try manifestObject()["@mindwtr_sync_backend"] as? String, "off")
        await cold.close()
        let coldOff = core()
        _ = try await coldOff.start()
        let reopenedOff = try await command(coldOff, "openSyncSettings")
        let reopenedOptions = try XCTUnwrap((reopenedOff["backend"] as? [String: Any])?["options"] as? [[String: Any]])
        XCTAssertEqual(reopenedOptions.first { $0["selected"] as? Bool == true }?["option"] as? String, "off")
        XCTAssertTrue(reopenedOff["panel"] is NSNull)
        XCTAssertEqual(remote.recorded.count, count, "Cold Off startup and settings open perform no HTTP")
        try assertCleaned(original: original)
        let storedOff = try manifestObject()
        XCTAssertEqual(storedOff["@mindwtr_sync_backend"] as? String, "off")
        XCTAssertEqual(storedOff["unknown"] as? String, unknownValue)
        XCTAssertNil(storedOff["@mindwtr_webdav_password"])
        let sql = try SQLiteBridge(url: database)
        defer { sql.close() }
        let tasks = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM tasks").utf8)) as? [[String: Any]])
        XCTAssertEqual(tasks.count, 1, "Off preserves the single existing Task")
        XCTAssertEqual(try json(try XCTUnwrap(tasks.first)), taskBeforeOff, "Off preserves every existing Task field")
        await coldOff.close(); try assertDiagnostics()
        let offMarkers = try markers("v1.3.5/native-sync-off-durable")
        XCTAssertEqual(offMarkers.count, 1)
        XCTAssertEqual(offMarkers.first?["context"] as? [String: String],
            ["releaseCheck": "v1.3.5/native-sync-off-durable", "operation": "off", "outcome": "confirmed"])
        XCTAssertTrue(remote.recorded.contains { $0.condition == "none:*" })
        XCTAssertTrue(remote.recorded.contains { $0.condition?.hasPrefix("match:") == true })
        XCTAssertTrue(remote.recorded.contains { $0.status == 412 }, "The real compatibility probe observes conditional conflicts")
    }

    private func configureStoredCleanupCandidate() async throws -> [String: Any] {
        try await seed()
        let original = try attachment()
        // The verified settings path persists real KV/Keychain configuration.
        // Its cycle has no candidate; only the subsequent cold stored invocation
        // loads this newly seeded local edit and can own its cleanup.
        let setupSQL = try SQLiteBridge(url: database)
        _ = try setupSQL.execute("UPDATE tasks SET attachments=NULL WHERE id=?", parametersJSON: json([taskID]))
        setupSQL.close()
        let setup = core()
        try await openAndTest(setup)
        try await save(setup)
        await setup.close()
        let candidateSQL = try SQLiteBridge(url: database)
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(1))
        _ = try candidateSQL.execute("UPDATE tasks SET attachments=?,updatedAt=?,rev=rev+1,revBy='fixture' WHERE id=?",
            parametersJSON: json([try json([original]), at, taskID]))
        candidateSQL.close()
        XCTAssertEqual(try Data(contentsOf: target), originalBytes)
        try assertConfiguration()
        return original
    }

    private func configurationIdentity() throws -> String {
        let stored = try manifestObject()
        var selected: [String: Any] = [:]
        for name in ["@mindwtr_sync_backend", "@mindwtr_webdav_url", "@mindwtr_webdav_username",
                     "@mindwtr_webdav_allow_insecure_http", "@mindwtr_webdav_allow_weak_fingerprint", "unknown"] {
            if let value = stored[name] { selected[name] = value }
        }
        XCTAssertEqual(stored["@mindwtr_webdav_url"] as? String, endpoint)
        XCTAssertEqual(stored["@mindwtr_webdav_username"] as? String, "synthetic")
        return try json(selected)
    }

    func testColdStoredWebDAVSyncOwnsLocalPublicationCleanupAndDurableFastSkip() async throws {
        let original = try await configureStoredCleanupCandidate()
        let identity = try configurationIdentity(), boundary = ForegroundBoundaryState(), host = core(boundary: boundary)
        let beforeStart = remote.recorded.count
        _ = try await host.start()
        XCTAssertEqual(remote.recorded.count, beforeStart, "Cold startup does not activate Sync")
        let result = try await command(host, "syncStored")
        XCTAssertEqual(try json(result), try json(["success": true, "skipped": false]), "The actual stored cycle returns only primitive booleans")
        // This ordinary read is immediate: native admission must see the cycle's
        // acknowledged store save, not an unflushed status/attachment patch.
        let read = try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertNotNil(read["diagnostics"])
        XCTAssertEqual(boundary.count, 1, "The stored invocation reaches the existing journaled physical callback")
        try assertCleaned(original: original); try assertConfiguration(); try assertRemoteTask(original: original)
        XCTAssertEqual(try configurationIdentity(), identity)
        let status = try object(try XCTUnwrap(try manifestObject()["@mindwtr_local_sync_status_v1"] as? String))
        XCTAssertEqual(status["lastSyncStatus"] as? String, "success")
        XCTAssertNotNil(status["lastSyncAt"] as? String, "Successful status is durable before the stored result")
        let storedMarkers = try markers("v1.3.5/ios-stored-sync")
        XCTAssertEqual(storedMarkers.count, 1)
        XCTAssertEqual(storedMarkers.first?["context"] as? [String: String],
            ["releaseCheck": "v1.3.5/ios-stored-sync", "operation": "syncStored", "outcome": "settled"])
        let remoteBytes = try XCTUnwrap(remote.bytes("/sync/data.json")), remoteETag = try XCTUnwrap(remote.etag("/sync/data.json"))
        await host.close()

        // A new VM has no open settings form or process-local cycle snapshot.
        // Its unchanged stored call must use the existing persisted fast proof.
        let coldBoundary = ForegroundBoundaryState(), cold = core(boundary: coldBoundary)
        let beforeCold = remote.recorded.count
        _ = try await cold.start()
        XCTAssertEqual(remote.recorded.count, beforeCold)
        let skipped = try await command(cold, "syncStored")
        XCTAssertEqual(try json(skipped), try json(["success": true, "skipped": true]))
        let skipRequests = remote.recorded.dropFirst(beforeCold)
        XCTAssertTrue(skipRequests.contains { $0.method == "HEAD" && $0.path == "/sync/data.json" }, "The cold fast check verifies the actual remote validator")
        XCTAssertFalse(skipRequests.contains { ["PUT", "DELETE", "MKCOL"].contains($0.method) })
        XCTAssertEqual(coldBoundary.count, 0, "Processed tombstones acquire no fresh physical owner")
        XCTAssertEqual(remote.bytes("/sync/data.json"), remoteBytes); XCTAssertEqual(remote.etag("/sync/data.json"), remoteETag)
        try assertCleaned(original: original); try assertConfiguration()
        XCTAssertEqual(try configurationIdentity(), identity)
        let coldRead = try object(await cold.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertNotNil(coldRead["diagnostics"])
        await cold.close()
        XCTAssertEqual(try markers("v1.3.5/ios-stored-sync").count, 2)
        try assertDiagnostics()
    }

    func testResumeUsesStoredCycleCompletionCadenceWithoutDeferredNetwork() async throws {
        let original = try await configureStoredCleanupCandidate()
        let host = core()
        _ = try await host.start()
        _ = try await command(host, "syncStored")
        let afterStored = remote.recorded.count
        let skipped = try await command(host, "syncResume")
        XCTAssertEqual(try json(skipped), try json(["success": true, "skipped": true]))
        XCTAssertEqual(remote.recorded.count, afterStored, "Immediate resume cannot bypass the stored cycle's shared cadence")
        // Wait past RN's real WebDAV foreground interval. Time alone must not
        // start a native cycle; only the next explicitly owned command may run.
        try await Task.sleep(nanoseconds: 31_000_000_000)
        XCTAssertEqual(remote.recorded.count, afterStored, "No timer or follow-up runs after the invocation returns")
        let due = try await command(host, "syncResume")
        XCTAssertEqual(due["success"] as? Bool, true)
        XCTAssertTrue(remote.recorded.dropFirst(afterStored).contains { $0.method == "HEAD" && $0.path == "/sync/data.json" })
        try assertCleaned(original: original); try assertConfiguration()
        let read = try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertNotNil(read["diagnostics"], "Resume acknowledges persistence before returning")
        XCTAssertEqual(try markers("v1.3.5/ios-resume-sync").count, 2, "The marker acknowledges both configured commands, not network activity")
        await host.close()
    }

    private func assertAutomaticCleanupFailure(command name: String) async throws {
        _ = try await configureStoredCleanupCandidate()
        let boundary = ForegroundBoundaryState(), host = core(boundary: boundary)
        let beforeStart = remote.recorded.count
        _ = try await host.start(); XCTAssertEqual(remote.recorded.count, beforeStart)
        boundary.arm()
        do {
            _ = try await command(host, name)
            XCTFail("An unconfirmed physical cleanup must escape the stored entry")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Attachment cleanup could not be confirmed; retry the retained request")
        }
        let held = try XCTUnwrap(boundary.captured, "The real stored cycle must reach afterIntent")
        XCTAssertEqual(boundary.count, 1)
        XCTAssertEqual(try Data(contentsOf: journal), held.journal); XCTAssertEqual(try inode(journal), held.journalInode)
        XCTAssertEqual(try Data(contentsOf: target), held.target); XCTAssertEqual(try inode(target), held.targetInode)
        XCTAssertEqual(try rows(), held.rows); XCTAssertEqual(try Data(contentsOf: manifest), held.manifest)
        XCTAssertEqual(try? Data(contentsOf: logURL), held.log); XCTAssertEqual(remote.recorded.count, held.requests)
        XCTAssertEqual(try markers(name == "syncStored" ? "v1.3.5/ios-stored-sync" : "v1.3.5/ios-resume-sync").count, 0, "A fatal cycle has no settled marker")
        XCTAssertEqual(try markers("v1.3.5/ios-cleanup-owned-retirement").count, 0)
        do {
            _ = try await host.foregroundSync(command: name, requestJSON: "{}")
            XCTFail("Retained cleanup authority blocks a second stored command")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Attachment cleanup could not be confirmed; retry the retained request")
        }
        XCTAssertEqual(remote.recorded.count, held.requests); XCTAssertEqual(try rows(), held.rows)
        XCTAssertEqual(try Data(contentsOf: manifest), held.manifest); XCTAssertEqual(try? Data(contentsOf: logURL), held.log)
        await host.close()
        let cold = core(), beforeCold = remote.recorded.count
        _ = try await cold.start()
        XCTAssertEqual(remote.recorded.count, beforeCold, "Cold proof recovery is local; startup does not run stored Sync")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), held.rows, "Recovery retires the captured bytes without inventing a shared metadata acknowledgement")
        try assertConfiguration()
        let read = try object(await cold.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertNotNil(read["diagnostics"], "The exact cold settlement releases ordinary read admission")
        await cold.close()
        XCTAssertEqual(try markers(name == "syncStored" ? "v1.3.5/ios-stored-sync" : "v1.3.5/ios-resume-sync").count, 0)
        let cleanup = try markers("v1.3.5/ios-cleanup-owned-retirement")
        XCTAssertEqual(cleanup.count, 1)
        XCTAssertEqual(cleanup.first?["context"] as? [String: String],
            ["releaseCheck": "v1.3.5/ios-cleanup-owned-retirement", "operation": "cleanup-owned-retirement", "outcome": "removed"])
    }

    func testStoredCleanupFailureRetainsOriginalAuthorityAndColdRecoveryDoesNotSync() async throws {
        try await assertAutomaticCleanupFailure(command: "syncStored")
    }

    func testResumeCleanupFailureRetainsOriginalAuthorityAndColdRecoveryDoesNotSync() async throws {
        try await assertAutomaticCleanupFailure(command: "syncResume")
    }

    func testBusyLeaseReturnsWithoutDetachedFollowUpAndLaterExplicitSyncOwnsCleanup() async throws {
        // Fixed stage labels distinguish a platform wait from the intentional
        // lease delay when CI terminates before XCTest can report a result.
        traceBusyLease = true
        NSLog("Native WebDAV CI phase=seed-before")
        try await seed()
        NSLog("Native WebDAV CI phase=seed-after")
        let original = try attachment()
        // Configure through the real verified Test/Save path without giving its
        // ordinary cycle this test's cleanup candidate. The cold host below loads
        // a freshly seeded tombstone; no running store is changed externally.
        let setupSQL = try SQLiteBridge(url: database)
        _ = try setupSQL.execute("UPDATE tasks SET attachments=NULL WHERE id=?", parametersJSON: json([taskID]))
        setupSQL.close()
        let setup = core()
        try await openAndTest(setup)
        try await save(setup)
        await setup.close()
        let candidateSQL = try SQLiteBridge(url: database)
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(1))
        _ = try candidateSQL.execute("UPDATE tasks SET attachments=?,updatedAt=?,rev=rev+1,revBy='fixture' WHERE id=?",
            parametersJSON: json([try json([original]), at, taskID]))
        candidateSQL.close()
        XCTAssertEqual(try Data(contentsOf: target), originalBytes)
        let boundary = ForegroundBoundaryState(), host = core(boundary: boundary)
        let beforeStartup = remote.recorded.count
        _ = try await host.start()
        _ = try await command(host, "openSyncSettings")
        XCTAssertEqual(remote.recorded.count, beforeStartup, "Cold configuration reads perform no HTTP")
        try assertConfiguration()

        let fencePath = "/sync/.mindwtr-sync-fence-v1.json"
        let serverNow = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        let serverNowMs = serverNow.timeIntervalSince1970 * 1_000
        let expiresAt = serverNowMs + 10_000
        // A conforming live lease: 10s TTL, 3s heartbeat, last renewed now.
        // This is separate from the existing fatal test's retained five-minute lease.
        let lease: [String: Any] = ["schema": 1, "leaseId": UUID().uuidString.lowercased(),
            "ownerId": "synthetic-live-peer", "purpose": "ordinary-sync",
            "expiresAt": expiresAt, "heartbeatMs": 3_000, "renewedAt": serverNowMs]
        let leaseBytes = Data(try json(lease).utf8)
        remote.advanceServerTime(to: serverNow)
        remote.seed(fencePath, bytes: leaseBytes)
        let leaseETag = try XCTUnwrap(remote.etag(fencePath))
        let requestStart = remote.recorded.count
        let busy = try await command(host, "syncNow", ["requestId": UUID().uuidString.lowercased(),
            "revision": try await revision(host), "webdav": fields])
        let toasts = try XCTUnwrap(busy["toasts"] as? [[String: Any]])
        XCTAssertTrue(toasts.contains { $0["tone"] as? String == "warning" }, "The actual shared command reports the held lease")
        let busyRequests = remote.recorded.dropFirst(requestStart)
        let observed = try XCTUnwrap(busyRequests.last { $0.method == "GET" && $0.path == fencePath && $0.status == 200 })
        XCTAssertFalse(busyRequests.contains { $0.path == fencePath && ["PUT", "DELETE"].contains($0.method) }, "A live peer lease grants no mutation authority")
        let date = DateFormatter(); date.locale = Locale(identifier: "en_US_POSIX"); date.timeZone = TimeZone(secondsFromGMT: 0)
        date.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let observedServerMs = try XCTUnwrap(date.date(from: observed.serverDate)).timeIntervalSince1970 * 1_000
        let retryAfterMs = expiresAt - observedServerMs
        XCTAssertEqual(retryAfterMs, 10_000, "The real HTTP Date and record produce the parser's busy retry delay")
        XCTAssertLessThanOrEqual(observedServerMs - serverNowMs, 3 * 3_000 + 5_000, "This lease is not reclaimable by missed heartbeats")
        XCTAssertEqual(boundary.count, 0)
        XCTAssertEqual(remote.bytes(fencePath), leaseBytes); XCTAssertEqual(remote.etag(fencePath), leaseETag)
        XCTAssertEqual(try json(attachment()), try json(original))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let heldRows = try rows(), heldManifest = try Data(contentsOf: manifest)
        let heldFile = try Data(contentsOf: target), heldInode = try inode(target)
        let settledRequests = remote.recorded.count
        let cleanupMarkers = try markers("v1.3.5/ios-cleanup-owned-retirement").count

        // Keep this actual Engine/VM alive through its automatic idle pumping,
        // then perform a normal read so due timers are pumped even without HTTP.
        let waitStarted = ProcessInfo.processInfo.systemUptime
        try await Task.sleep(nanoseconds: UInt64((retryAfterMs + 2_000) * 1_000_000))
        XCTAssertGreaterThanOrEqual((ProcessInfo.processInfo.systemUptime - waitStarted) * 1_000, retryAfterMs)
        let read = try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertNotNil(read["diagnostics"], "The same native host remains callable after the deferred deadline")
        XCTAssertEqual(remote.recorded.count, settledRequests, "No deferred service cycle may issue HTTP after the caller's Sync returned")
        XCTAssertEqual(boundary.count, 0, "Idle pumping must not reacquire physical cleanup authority")
        XCTAssertEqual(try rows(), heldRows); XCTAssertEqual(try Data(contentsOf: manifest), heldManifest)
        XCTAssertEqual(try Data(contentsOf: target), heldFile); XCTAssertEqual(try inode(target), heldInode)
        XCTAssertEqual(remote.bytes(fencePath), leaseBytes); XCTAssertEqual(remote.etag(fencePath), leaseETag)
        XCTAssertEqual(try markers("v1.3.5/ios-cleanup-owned-retirement").count, cleanupMarkers)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))

        // Only a later explicit owner can act. Model server expiry by advancing
        // its Date, never by deleting or rewriting the peer's lease/ETag.
        remote.advanceServerTime(to: Date(timeIntervalSince1970: expiresAt / 1_000 + 1))
        let explicitStart = remote.recorded.count
        try await sync(host)
        XCTAssertTrue(remote.recorded.dropFirst(explicitStart).contains {
            $0.method == "PUT" && $0.path == fencePath && $0.condition == "match:" + leaseETag && $0.status == 204
        }, "The explicit owner reacquires only the observed expired generation by CAS")
        XCTAssertEqual(boundary.count, 1)
        try assertCleaned(original: original); try assertConfiguration(); try assertRemoteTask(original: original)
        await host.close()
    }

    private struct ProjectDownloadFixture {
        let projectID: String
        let attachmentID: String
        let bytes: Data
        let target: URL
        let remotePath: String
        let attachment: [String: Any]
    }

    private func seedProjectDownload(status: String = "active", mode: String = "file") throws -> ProjectDownloadFixture {
        let id = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
        let bytes = Data("Synthetic saved Project download \(id) 🧠".utf8)
        let filename = attachmentID + ".txt", at = "2026-10-06T00:00:00.000Z"
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        var attachment: [String: Any] = ["id": attachmentID, "kind": "file", "title": "Remote Project fixture.txt",
            "uri": "", "cloudKey": "attachments/" + filename, "fileHash": digest,
            "size": bytes.count, "mimeType": "text/plain", "localStatus": "missing", "contentRev": 1,
            "createdAt": at, "updatedAt": at]
        if mode == "deleted" { attachment["deletedAt"] = at }
        if mode == "link" {
            attachment = ["id": attachmentID, "kind": "link", "title": "Selected link", "uri": "https://native-download.invalid/link", "createdAt": at, "updatedAt": at]
        }
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Selected download Project',?,'#94a3b8','Keep exact Project Notes 🧠',1,'[]',0,0,?,?,?,1,'fixture')",
            parametersJSON: json([id, status, try json([attachment]), at, at]))
        return ProjectDownloadFixture(projectID: id, attachmentID: attachmentID, bytes: bytes,
            target: target.deletingLastPathComponent().appendingPathComponent(filename), remotePath: "/sync/attachments/" + filename, attachment: attachment)
    }

    private func seedUnrelatedDownloadProject() throws -> String {
        let id = UUID().uuidString.lowercased(), at = "2026-10-06T00:00:00.000Z"
        let link: [String: Any] = ["id": UUID().uuidString.lowercased(), "kind": "link", "title": "Preserve unrelated link", "uri": "https://unrelated-native.invalid/retained", "createdAt": at, "updatedAt": at]
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Unrelated preserved Project','waiting','#123456','Unrelated Notes 🧠',2,'[]',0,0,?,?,?,4,'fixture')",
            parametersJSON: json([id, try json([link]), at, at]))
        return id
    }

    private func projectRows() throws -> [[String: Any]] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM projects").utf8)) as? [[String: Any]])
    }
    private func projectRow(_ id: String) throws -> [String: Any] {
        try XCTUnwrap(projectRows().first { $0["id"] as? String == id })
    }
    private func projectDownloadAttachment(_ fixture: ProjectDownloadFixture) throws -> [String: Any] {
        let encoded = try XCTUnwrap(try projectRow(fixture.projectID)["attachments"] as? String)
        let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [[String: Any]])
        return try XCTUnwrap(values.first { $0["id"] as? String == fixture.attachmentID })
    }
    private func settleDownloadFixtureWriter(_ host: CoreHost) async throws {
        let beforeTask = try task(), beforeProjects = try projectRows(), requestStart = remote.recorded.count
        let configuration = try configurationIdentity()
        let filter = try object(await host.call("areaFilter"))
        let option = try XCTUnwrap((filter["options"] as? [[String: Any]])?.first { $0["id"] as? String == "__none__" })
        XCTAssertEqual(option["state"] as? String, "none")
        // This existing explicit preference command runs the actual whole-store
        // writer before the measured operation. Swift's sorted/slash-escaped
        // seed JSON is not the shared writer's persisted representation.
        _ = try await host.call("setAreaFilter", argumentsJSON: json([json(XCTUnwrap(option["next"]))]))
        let currentTask = try task()
        for (old, current) in [(beforeTask, currentTask)] + (try beforeProjects.map { ($0, try projectRow(XCTUnwrap($0["id"] as? String))) }) {
            XCTAssertEqual(try json(current.filter { $0.key != "attachments" }), try json(old.filter { $0.key != "attachments" }))
            let before = try XCTUnwrap(old["attachments"] as? String), after = try XCTUnwrap(current["attachments"] as? String)
            let oldMetadata = try XCTUnwrap(NativeJSON.jsonObject(with: Data(before.utf8)) as? [[String: Any]])
            let currentMetadata = try XCTUnwrap(NativeJSON.jsonObject(with: Data(after.utf8)) as? [[String: Any]])
            XCTAssertEqual(try json(currentMetadata), try json(oldMetadata), "Setup preserves every seeded attachment field and empty remote-only URI")
        }
        XCTAssertEqual(remote.recorded.count, requestStart, "The baseline writer performs no Sync or attachment GET")
        XCTAssertEqual(try configurationIdentity(), configuration)
        XCTAssertEqual(try Data(contentsOf: target), originalBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try assertProjectDownloadMarker([])
    }
    private func projectDownloadInput(_ host: CoreHost, _ fixture: ProjectDownloadFixture) async throws -> [String: Any] {
        let options = try object(await host.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": fixture.projectID])])))
        let project = try XCTUnwrap(options["project"] as? [String: Any])
        XCTAssertEqual(project["id"] as? String, fixture.projectID)
        let status = try XCTUnwrap(try projectRow(fixture.projectID)["status"] as? String)
        XCTAssertEqual(options["canEdit"] as? Bool, status != "archived", "Archived availability is eligible without granting edit authority")
        return ["projectId": fixture.projectID, "attachmentId": fixture.attachmentID,
            "revision": try XCTUnwrap(options["revision"] as? String)]
    }
    private func assertProjectSearchMembership(_ projects: [[String: Any]]) throws {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        for (field, phrase) in [("title", "Selected download Project"), ("title", "Unrelated preserved Project"),
                                ("supportNotes", "Keep exact Project Notes"), ("supportNotes", "Unrelated Notes")] {
            let result = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute(
                "SELECT projects.id FROM projects_fts JOIN projects ON projects.rowid=projects_fts.rowid WHERE projects_fts MATCH ? ORDER BY projects.id",
                parametersJSON: json([field + " : \"" + phrase + "\""])).utf8)) as? [[String: Any]])
            let expected = projects.filter { ($0[field] as? String)?.contains(phrase) == true }.compactMap { $0["id"] as? String }.sorted()
            XCTAssertEqual(result.compactMap { $0["id"] as? String }, expected, "Project search membership remains exact despite rewritten FTS pages")
        }
    }
    private func assertTaskSearchMembership() throws {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        for phrase in ["title : \"Foreground fixture task\"", "description : \"Preserve unrelated task notes\""] {
            let result = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute(
                "SELECT tasks.id FROM tasks_fts JOIN tasks ON tasks.rowid=tasks_fts.rowid WHERE tasks_fts MATCH ? ORDER BY tasks.id",
                parametersJSON: json([phrase])).utf8)) as? [[String: Any]])
            XCTAssertEqual(result.compactMap { $0["id"] as? String }, [taskID], "Task search returns exactly the unchanged fixture before and after lost save acknowledgements")
        }
    }
    private func assertDownloadPreservation(rows before: [String: String], projects oldProjects: [[String: Any]], selected: String, allowTaskIndexRebuild: Bool = false, expectPendingJournal: Bool = false) throws {
        // Existing projects_au rewrites its FTS shadow pages for any Project
        // update. Keep all other raw tables and all unrelated Projects exact.
        // Only the lost-COMMIT test permits these two Task index layouts: failed
        // acknowledgements discard writer fingerprints and retries re-upsert
        // byte-identical Task rows. Every Task row and remaining index table stays exact.
        let domain = { (name: String) in name != "projects" && !name.hasPrefix("projects_fts")
            && (!allowTaskIndexRebuild || !["tasks_fts_data", "tasks_fts_idx"].contains(name)) }
        XCTAssertEqual(try rows().filter { domain($0.key) }, before.filter { domain($0.key) })
        if allowTaskIndexRebuild { try assertTaskSearchMembership() }
        XCTAssertEqual(try projectRows().filter { $0["id"] as? String != selected }.map { try json($0) }.sorted(),
            try oldProjects.filter { $0["id"] as? String != selected }.map { try json($0) }.sorted())
        let old = try XCTUnwrap(oldProjects.first { $0["id"] as? String == selected }), current = try projectRow(selected)
        let allowed = Set(["attachments", "rev", "revBy", "updatedAt"])
        XCTAssertEqual(try json(current.filter { !allowed.contains($0.key) }), try json(old.filter { !allowed.contains($0.key) }))
        try assertProjectSearchMembership(oldProjects)
        XCTAssertEqual(try Data(contentsOf: target), originalBytes, "The unrelated tombstone's physical bytes are never cleaned by Download")
        XCTAssertEqual(FileManager.default.fileExists(atPath: journal.path), expectPendingJournal,
            "Only an unconfirmed owned download retains its exact recovery journal")
    }
    private func assertDownloaded(_ fixture: ProjectDownloadFixture) throws {
        XCTAssertEqual(try Data(contentsOf: fixture.target), fixture.bytes)
        let digest = SHA256.hash(data: try Data(contentsOf: fixture.target)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, fixture.attachment["fileHash"] as? String)
        var expected = fixture.attachment; expected["uri"] = fixture.target.absoluteString; expected["localStatus"] = "available"
        XCTAssertEqual(try json(projectDownloadAttachment(fixture)), try json(expected), "Only device-local availability fields change")
    }
    private func assertProjectDownloadMarker(_ outcomes: [String], cached: Int = 0) throws {
        let records = try markers("v1.3.5/ios-webdav-project-download")
        XCTAssertEqual(records.compactMap { ($0["context"] as? [String: String])?["outcome"] }, outcomes)
        for record in records {
            XCTAssertEqual(record["scope"] as? String, "native-ios")
            XCTAssertEqual(record["message"] as? String, "Native iOS attachment draft acknowledged")
            let context = try XCTUnwrap(record["context"] as? [String: String])
            XCTAssertEqual(context, ["releaseCheck": "v1.3.5/ios-webdav-project-download",
                "operation": "webdav-project-download", "outcome": try XCTUnwrap(context["outcome"])])
        }
        let cachedRecords = try markers("v1.3.5/ios-cached-project-availability")
        XCTAssertEqual(cachedRecords.count, cached)
        for record in cachedRecords {
            XCTAssertEqual(record["scope"] as? String, "native-ios")
            XCTAssertEqual(record["message"] as? String, "Native iOS attachment draft acknowledged")
            XCTAssertEqual(record["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-cached-project-availability",
                "operation": "cached-project-availability", "outcome": "confirmed"])
        }
        XCTAssertEqual(try markers("v1.3.5/ios-project-file-download").count, 0, "Native owned downloads never fall back to the legacy shared mutation route")
    }

    func testProjectDownloadPersistsLiveAndArchivedAvailabilityAndColdLocalOpen() async throws {
        _ = try await configureStoredCleanupCandidate()
        _ = try seedUnrelatedDownloadProject()
        let fixtures = try [seedProjectDownload(), seedProjectDownload(status: "archived")]
        for fixture in fixtures { remote.seed(fixture.remotePath, bytes: fixture.bytes) }
        let host = try projectCore(), startupRequests = remote.recorded.count
        _ = try await host.start(); XCTAssertEqual(remote.recorded.count, startupRequests)
        try await settleDownloadFixtureWriter(host)
        let configuration = try configurationIdentity(), remoteDocument = remote.bytes("/sync/data.json")
        var outcomes: [String] = [], cachedCount = 0
        for fixture in fixtures {
            let input = try await projectDownloadInput(host, fixture)
            let before = try rows(), oldProjects = try projectRows(), requestStart = remote.recorded.count
            let answer = try await command(host, "projectAttachmentDownload", input)
            XCTAssertEqual(Set(answer.keys), Set(["status", "message", "update"]))
            XCTAssertEqual(answer["status"] as? String, "available"); XCTAssertTrue(answer["message"] is NSNull); XCTAssertTrue(answer["update"] is NSNull)
            let requested = remote.recorded.dropFirst(requestStart)
            XCTAssertEqual(requested.map { $0.path }, [fixture.remotePath], "The selected operation fetches only this attachment, not a full Sync")
            XCTAssertEqual(requested.map { $0.method }, ["GET"]); XCTAssertEqual(requested.map { $0.status }, [200])
            try assertDownloaded(fixture); try assertDownloadPreservation(rows: before, projects: oldProjects, selected: fixture.projectID)
            XCTAssertEqual(try configurationIdentity(), configuration); XCTAssertEqual(remote.bytes("/sync/data.json"), remoteDocument)
            outcomes.append("saved"); try assertProjectDownloadMarker(outcomes, cached: cachedCount)
            let repeatInput = try await projectDownloadInput(host, fixture), settled = try rows(), settledProjects = try projectRows()
            let installedInode = try inode(fixture.target), repeatStart = remote.recorded.count
            let repeated = try await command(host, "projectAttachmentDownload", repeatInput)
            XCTAssertEqual(repeated["status"] as? String, "available"); XCTAssertTrue(repeated["update"] is NSNull)
            XCTAssertEqual(remote.recorded.count, repeatStart); XCTAssertEqual(try rows(), settled)
            XCTAssertEqual(try json(projectRows()), try json(settledProjects)); XCTAssertEqual(try inode(fixture.target), installedInode)
            cachedCount += 1; try assertProjectDownloadMarker(outcomes, cached: cachedCount)
        }
        let settled = try rows(), coldStart = remote.recorded.count
        await host.close()
        let cold = try projectCore(); _ = try await cold.start(); XCTAssertEqual(remote.recorded.count, coldStart)
        for fixture in fixtures {
            let result = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": fixture.projectID, "attachmentId": fixture.attachmentID])))
            XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
            let plan = try XCTUnwrap(result["open"] as? [String: Any])
            XCTAssertEqual(plan["kind"] as? String, "file"); XCTAssertEqual(plan["uri"] as? String, fixture.target.absoluteString)
            try assertDownloaded(fixture)
        }
        XCTAssertEqual(try rows(), settled); XCTAssertEqual(remote.recorded.count, coldStart)
        try assertProjectDownloadMarker(["saved", "saved"], cached: 2); try assertConfiguration()
        let records = try markers("v1.3.5/ios-webdav-project-download") + markers("v1.3.5/ios-cached-project-availability")
        let encoded = try json(records)
        for value in [password, service!, namespace!, hostname!] + fixtures.flatMap({ [$0.projectID, $0.attachmentID, $0.target.absoluteString, $0.remotePath] }) {
            XCTAssertFalse(encoded.contains(value), "The fixed settled marker carries no private fixture content")
        }
        assertNativeCredentialObservation(); await cold.close()
    }

    func testProjectDownloadRefusesStaleRevisionAndNonLiveFileBeforeHTTP() async throws {
        _ = try await configureStoredCleanupCandidate()
        let file = try seedProjectDownload(), link = try seedProjectDownload(mode: "link"), deleted = try seedProjectDownload(mode: "deleted")
        let host = core(); _ = try await host.start()
        try await settleDownloadFixtureWriter(host)
        var stale = try await projectDownloadInput(host, file); stale["revision"] = "stale-" + (try XCTUnwrap(stale["revision"] as? String))
        var missing = try await projectDownloadInput(host, file); missing["attachmentId"] = UUID().uuidString.lowercased()
        let linkInput = try await projectDownloadInput(host, link), deletedInput = try await projectDownloadInput(host, deleted)
        let inputs = [stale, linkInput, deletedInput, missing]
        let before = try rows(), saved = try Data(contentsOf: manifest), requests = remote.recorded.count
        for input in inputs {
            do {
                _ = try await host.foregroundSync(command: "projectAttachmentDownload", requestJSON: json(input))
                XCTFail("The native owned preflight must refuse stale and non-live selections")
            } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
            XCTAssertEqual(remote.recorded.count, requests); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: manifest), saved)
            let summary = try await host.projectFileAvailabilitySummary(); XCTAssertEqual(summary, "null")
        }
        try assertProjectDownloadMarker([]); XCTAssertEqual(try Data(contentsOf: target), originalBytes)
        await host.close()
    }

    func testProjectDownloadAuthHashAndCapFailuresStayRetryableWhile404IsTerminal() async throws {
        _ = try await configureStoredCleanupCandidate()
        var fixtures: [(String, ProjectDownloadFixture)] = []
        for mode in ["auth", "hash", "cap", "404"] {
            let fixture = try seedProjectDownload(); fixtures.append((mode, fixture))
            if mode != "404" { remote.seed(fixture.remotePath, bytes: mode == "hash" ? Data("Wrong synthetic generation".utf8) : fixture.bytes) }
            if mode == "auth" { remote.refuseGet(fixture.remotePath, status: 401) }
            if mode == "cap" { remote.declareGetLength(fixture.remotePath, bytes: NativeHTTPJobs.maximumBytes + 1) }
        }
        let faults = HostIOFaults(); var jobs: NativeHTTPJobs?
        faults.configureHTTPJobs = { jobs = $0 }
        let host = try projectCore(faults: faults); _ = try await host.start()
        try await settleDownloadFixtureWriter(host)
        for (mode, fixture) in fixtures {
            let input = try await projectDownloadInput(host, fixture), before = try rows(), oldProjects = try projectRows(), requestStart = remote.recorded.count
            let answer = try await command(host, "projectAttachmentDownload", input)
            XCTAssertEqual(answer["status"] as? String, mode == "404" ? "unrecoverable" : "unavailable", mode)
            XCTAssertTrue(answer["update"] is NSNull)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.target.path), mode)
            try assertDownloadPreservation(rows: before, projects: oldProjects, selected: fixture.projectID)
            XCTAssertTrue(remote.recorded.dropFirst(requestStart).allSatisfy { $0.method == "GET" && $0.path == fixture.remotePath })
            XCTAssertGreaterThan(remote.recorded.count, requestStart)
            let current = try projectDownloadAttachment(fixture)
            if mode == "404" {
                XCTAssertNotNil(current["deletedAt"] as? String); XCTAssertNil(current["cloudKey"]); XCTAssertNil(current["fileHash"])
                XCTAssertEqual(current["title"] as? String, fixture.attachment["title"] as? String)
                XCTAssertEqual(current["contentRev"] as? Int, fixture.attachment["contentRev"] as? Int)
                let repeatInput = try await projectDownloadInput(host, fixture), repeatStart = remote.recorded.count, terminalRows = try rows()
                do {
                    _ = try await host.foregroundSync(command: "projectAttachmentDownload", requestJSON: json(repeatInput))
                    XCTFail("The native owned preflight must refuse the terminal tombstone")
                } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
                XCTAssertEqual(remote.recorded.count, repeatStart); XCTAssertEqual(try rows(), terminalRows)
            } else {
                XCTAssertNil(current["deletedAt"]); XCTAssertEqual(current["cloudKey"] as? String, fixture.attachment["cloudKey"] as? String)
                XCTAssertEqual(current["fileHash"] as? String, fixture.attachment["fileHash"] as? String)
                XCTAssertEqual(current["localStatus"] as? String, "missing")
            }
            XCTAssertEqual(jobs?.counters.jobs, 0, "No refused response remains retained after this scope")
            XCTAssertEqual(jobs?.counters.running, 0, "No failed download escapes the foreground invocation")
            try assertProjectDownloadMarker(mode == "404" ? ["unrecoverable"] : [])
        }
        try assertConfiguration(); await host.close()
        let cold = core(), beforeCold = remote.recorded.count
        _ = try await cold.start(); XCTAssertEqual(remote.recorded.count, beforeCold)
        for (mode, fixture) in fixtures {
            let current = try projectDownloadAttachment(fixture)
            XCTAssertEqual(current["deletedAt"] != nil, mode == "404", "The durable distinction survives recreation")
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.target.path))
        }
        XCTAssertEqual(try Data(contentsOf: target), originalBytes); assertNativeCredentialObservation(); await cold.close()
    }

    func testProjectDownloadReusesOnlyMatchingManagedTargetAndNeverOverwritesConflict() async throws {
        _ = try await configureStoredCleanupCandidate()
        let matching = try seedProjectDownload(), conflict = try seedProjectDownload()
        let foreignBytes = Data("Preserve this conflicting managed generation".utf8)
        try matching.bytes.write(to: matching.target); try foreignBytes.write(to: conflict.target)
        let matchedInode = try inode(matching.target), conflictInode = try inode(conflict.target)
        let host = try projectCore(); _ = try await host.start()
        try await settleDownloadFixtureWriter(host)
        let requestStart = remote.recorded.count
        let reused = try await command(host, "projectAttachmentDownload", try await projectDownloadInput(host, matching))
        XCTAssertEqual(reused["status"] as? String, "available"); try assertDownloaded(matching)
        let before = try rows(), oldProjects = try projectRows()
        let conflictInput = try await projectDownloadInput(host, conflict)
        do {
            _ = try await host.foregroundSync(command: "projectAttachmentDownload", requestJSON: json(conflictInput))
            XCTFail("A conflicting present target must refuse before the native cached path can fall through")
        } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        XCTAssertEqual(remote.recorded.count, requestStart, "Existing managed targets are proved locally, never overwritten by a GET")
        XCTAssertEqual(try Data(contentsOf: conflict.target), foreignBytes); XCTAssertEqual(try inode(conflict.target), conflictInode)
        XCTAssertEqual(try inode(matching.target), matchedInode)
        XCTAssertNil(try projectDownloadAttachment(conflict)["deletedAt"])
        try assertDownloadPreservation(rows: before, projects: oldProjects, selected: conflict.projectID)
        try assertProjectDownloadMarker([], cached: 1); assertNativeCredentialObservation(); await host.close()
    }

    func testProjectDownloadLostCommitAcknowledgementReconcilesColdWithoutRefetch() async throws {
        _ = try await configureStoredCleanupCandidate()
        _ = try seedUnrelatedDownloadProject()
        let fixture = try seedProjectDownload(); remote.seed(fixture.remotePath, bytes: fixture.bytes)
        let faults = HostIOFaults(); var acknowledgements = 0; var jobs: NativeHTTPJobs?
        faults.configureHTTPJobs = { jobs = $0 }
        let host = try projectCore(faults: faults); _ = try await host.start()
        try await settleDownloadFixtureWriter(host)
        let input = try await projectDownloadInput(host, fixture), before = try rows(), oldProjects = try projectRows(), requestStart = remote.recorded.count
        try assertTaskSearchMembership()
        // The hook is after the real COMMIT, and fires only when its durable row
        // already contains the final installed availability, not a transient
        // downloading patch or a pre-commit refusal.
        faults.afterSQL = { statement in
            guard statement == "COMMIT", FileManager.default.fileExists(atPath: fixture.target.path),
                  try self.projectDownloadAttachment(fixture)["localStatus"] as? String == "available" else { return }
            acknowledgements += 1
            throw HostFailure("Synthetic Project availability COMMIT acknowledgement loss")
        }
        do {
            _ = try await host.foregroundSync(command: "projectAttachmentDownload", requestJSON: json(input))
            XCTFail("A lost persistence acknowledgement cannot publish a confirmed download result")
        } catch { XCTAssertEqual(error.localizedDescription, "Foreground sync could not be confirmed") }
        XCTAssertEqual(jobs?.counters.jobs, 0, "An unknown persistence result leaves no retained HTTP response")
        XCTAssertEqual(jobs?.counters.running, 0, "No download work escapes the unknown-result scope")
        XCTAssertGreaterThan(acknowledgements, 0, "The actual post-COMMIT hook must witness the final durable availability")
        try assertDownloaded(fixture); try assertDownloadPreservation(rows: before, projects: oldProjects, selected: fixture.projectID, allowTaskIndexRebuild: true, expectPendingJournal: true)
        XCTAssertEqual(remote.recorded.dropFirst(requestStart).map { $0.path }, [fixture.remotePath])
        try assertProjectDownloadMarker(["refused"])
        let retained = try object(await host.projectFileAvailabilitySummary()), requestID = try XCTUnwrap(retained["requestId"] as? String)
        XCTAssertEqual(Set(retained.keys), Set(["requestId", "projectId", "attachmentId", "phase"]))
        XCTAssertEqual(retained["projectId"] as? String, fixture.projectID); XCTAssertEqual(retained["attachmentId"] as? String, fixture.attachmentID)
        XCTAssertEqual(retained["phase"] as? String, "published", "The lost domain acknowledgement retains its prior publication proof")
        await host.close()
        let committed = try rows(), currentBytes = try Data(contentsOf: fixture.target), currentInode = try inode(fixture.target), coldStart = remote.recorded.count
        let cold = try projectCore()
        do { _ = try await cold.start(); XCTFail("The retained download requires its exact explicit Retry") }
        catch { XCTAssertTrue(error is CoreHostProjectFileAvailabilityRecovery) }
        XCTAssertEqual(remote.recorded.count, coldStart)
        let coldSummary = try object(await cold.projectFileAvailabilitySummary())
        XCTAssertEqual(try json(coldSummary), try json(retained))
        let reconciled = try object(await cold.recoverProjectFileAvailability(requestId: requestID))
        XCTAssertEqual(reconciled["status"] as? String, "available"); XCTAssertTrue(reconciled["update"] is NSNull)
        XCTAssertEqual(remote.recorded.count, coldStart); XCTAssertEqual(try rows(), committed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), "Exact-after Retry retires the original journal")
        XCTAssertEqual(try Data(contentsOf: fixture.target), currentBytes); XCTAssertEqual(try inode(fixture.target), currentInode)
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": fixture.projectID, "attachmentId": fixture.attachmentID])))
        XCTAssertEqual(opened["status"] as? String, "available")
        try assertProjectDownloadMarker(["refused", "saved"]); try assertConfiguration(); assertNativeCredentialObservation(); await cold.close()
    }

    func testUnconfirmedCleanupContainsAllPostIntentWorkAndColdRecoveryUsesOriginalProof() async throws {
        try await seed()
        let original = try attachment(), boundary = ForegroundBoundaryState(), host = core(boundary: boundary)
        try await openAndTest(host); boundary.arm()
        do { try await save(host); XCTFail("An actual retained cleanup intent must escape the complete shared pipeline") }
        catch { XCTAssertEqual(error.localizedDescription, "Attachment cleanup could not be confirmed; retry the retained request") }
        let held = try XCTUnwrap(boundary.captured, "The actual afterIntent hook must fire")
        XCTAssertEqual(held.target, originalBytes)
        XCTAssertEqual(try Data(contentsOf: journal), held.journal); XCTAssertEqual(try inode(journal), held.journalInode)
        XCTAssertEqual(try Data(contentsOf: target), held.target); XCTAssertEqual(try inode(target), held.targetInode)
        XCTAssertEqual(try rows(), held.rows); XCTAssertEqual(try Data(contentsOf: manifest), held.manifest)
        XCTAssertEqual(try? Data(contentsOf: logURL), held.log); XCTAssertEqual(remote.recorded.count, held.requests)
        XCTAssertEqual(try markers("v1.3.5/ios-cleanup-owned-retirement").count, 0)
        try assertConfiguration()
        let fencePath = "/sync/.mindwtr-sync-fence-v1.json"
        let fenceBytes = try XCTUnwrap(remote.bytes(fencePath)), fenceETag = try XCTUnwrap(remote.etag(fencePath))
        let fence = try object(String(decoding: fenceBytes, as: UTF8.self))
        let expiresAt = try XCTUnwrap(fence["expiresAt"] as? Double)
        XCTAssertGreaterThan(expiresAt, Date().timeIntervalSince1970 * 1000, "The fatal path retains its still-live remote lease")
        do { _ = try await host.foregroundSync(command: "syncNow", requestJSON: json(["requestId": UUID().uuidString.lowercased(), "revision": "retained", "webdav": fields])); XCTFail("A retained intent blocks another foreground command") }
        catch { XCTAssertEqual(error.localizedDescription, "Attachment cleanup could not be confirmed; retry the retained request") }
        XCTAssertEqual(remote.recorded.count, held.requests); XCTAssertEqual(try rows(), held.rows)
        await host.close()
        let cold = core(), count = remote.recorded.count
        _ = try await cold.start()
        XCTAssertEqual(remote.recorded.count, count, "Prehydration recovery requires no network")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try rows(), held.rows, "Native cold retirement does not impersonate shared metadata cleanup")
        _ = try await command(cold, "openSyncSettings")
        try await sync(cold)
        XCTAssertGreaterThan(remote.recorded.count, count, "The first cold ordinary Sync reads the retained remote fence")
        XCTAssertEqual(try json(attachment()), try json(original), "An unexpired remote lease defers shared metadata cleanup")
        XCTAssertEqual(remote.bytes(fencePath), fenceBytes); XCTAssertEqual(remote.etag(fencePath), fenceETag)
        try assertConfiguration()
        // Model server-time expiry without deleting or rewriting the original lease.
        // HTTP Date has whole-second precision, so advance one second beyond its observed deadline.
        remote.advanceServerTime(to: Date(timeIntervalSince1970: expiresAt / 1000 + 1))
        XCTAssertEqual(remote.bytes(fencePath), fenceBytes); XCTAssertEqual(remote.etag(fencePath), fenceETag)
        let expiredRequestStart = remote.recorded.count
        try await sync(cold)
        XCTAssertTrue(remote.recorded.dropFirst(expiredRequestStart).contains {
            $0.method == "PUT" && $0.condition == "match:" + fenceETag && $0.status == 204
        }, "Reacquisition replaces exactly the observed expired lease by CAS")
        try assertCleaned(original: original); try assertConfiguration()
        let cleaned = try json(attachment())
        try await sync(cold); XCTAssertEqual(try json(attachment()), cleaned)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await cold.close()
        let cleanup = try markers("v1.3.5/ios-cleanup-owned-retirement")
        XCTAssertEqual(cleanup.count, 1, "The original retained proof is retired once; later missing-file cleanup creates no intent")
        XCTAssertEqual((cleanup.first?["context"] as? [String: String])?["outcome"], "removed")
    }
}
