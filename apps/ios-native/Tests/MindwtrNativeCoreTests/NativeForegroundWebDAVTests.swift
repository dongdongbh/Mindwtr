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
    private var objects: [String: Object] = [:]
    private var collections: Set<String> = ["/", "/sync/", "/sync/attachments/"]
    private var requests: [Request] = []
    private var version = 0
    private var unexpected = 0
    private var serverTime: Date?
    var recorded: [Request] { lock.lock(); defer { lock.unlock() }; return requests }
    var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    func bytes(_ path: String) -> Data? { lock.lock(); defer { lock.unlock() }; return objects[path]?.bytes }
    func etag(_ path: String) -> String? { lock.lock(); defer { lock.unlock() }; return objects[path]?.etag }
    func advanceServerTime(to value: Date) { lock.lock(); serverTime = value; lock.unlock() }
    func seed(_ path: String, bytes: Data) {
        lock.lock(); defer { lock.unlock() }
        version += 1; objects[path] = Object(bytes: bytes, etag: "\"fixture-v\(version)\"")
    }
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
        guard url.scheme == "https", path.hasPrefix("/sync/"), request.url?.query == nil else {
            unexpected += 1; return reply(400)
        }
        switch method {
        case "GET", "HEAD":
            guard let object = objects[path] else { return reply(404) }
            return reply(200, object.bytes, etag: object.etag, type: path.hasSuffix(".json") ? "application/json" : "application/octet-stream")
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
        hostname = "foreground-" + UUID().uuidString.lowercased() + ".invalid"
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        namespace = "tech.dongdongbh.mindwtr.foreground." + UUID().uuidString.lowercased()
        remote = ForegroundDAVStore(); unexpectedBefore = ForegroundDAVProtocol.unexpectedCount
        ForegroundDAVProtocol.install(hostname, store: remote)
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(ForegroundDAVProtocol.unexpectedCount, unexpectedBefore, "No request may escape the private endpoint")
        if let remote { XCTAssertEqual(remote.unexpectedCount, 0, "The fixture refused an unsupported request") }
        if let service {
            // createSecureSyncConfigStore's secureKeyFor removes the storage '@'.
            for account in ["mindwtr_webdav_password", "mindwtr_cloud_token", "mindwtr_sync_encryption_key_v1"] {
                for alias in ["no-auth", "auth", "legacy"] {
                    let bytes = Data(account.utf8)
                    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                        kSecAttrService as String: alias == "legacy" ? service : service + ":" + alias,
                        kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
                    let status = SecItemDelete(query as CFDictionary)
                    XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound, "Only exact fixture accounts are retired")
                }
            }
        }
        if let hostname { ForegroundDAVProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func inode(_ url: URL) throws -> ino_t { var info = stat(); guard lstat(url.path, &info) == 0 else { throw HostFailure("Fixture inode is unavailable") }; return info.st_ino }
    private func core(boundary: ForegroundBoundaryState? = nil) -> CoreHost {
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ForegroundDAVProtocol.self]; faults.httpConfiguration = configuration
        faults.secretService = service
        if let boundary { faults.cleanupBoundary = { name in try boundary.visit(name) { try self.captureBoundary() } } }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
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
        let reply = try object(await host.foregroundSync(command: name, requestJSON: json(input)))
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
        let bytes = Data("mindwtr_webdav_password".utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + ":no-auth",
            kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, Data(password.utf8), "The accepted Save uses actual isolated Security storage")
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

    func testBusyLeaseReturnsWithoutDetachedFollowUpAndLaterExplicitSyncOwnsCleanup() async throws {
        try await seed()
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
