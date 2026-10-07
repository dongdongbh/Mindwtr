import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class UploadAdmissionFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (UploadAdmissionFixtureProtocol) -> Void] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ hostname: String, handler: @escaping (UploadAdmissionFixtureProtocol) -> Void) {
        lock.lock(); handlers[hostname] = handler; lock.unlock()
    }
    static func remove(_ hostname: String) { lock.lock(); handlers.removeValue(forKey: hostname); lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url?.host ?? ""]
        if handler == nil { Self.unexpected += 1 }; Self.lock.unlock()
        if let handler { handler(self) }
        else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    }
    override func stopLoading() { }
    func reply(_ status: Int) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0", "ETag": "\"synthetic-upload\""])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    func body() -> Data {
        if let bytes = request.httpBody { return bytes }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
        }
        return bytes
    }
}

private final class UploadAdmissionFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var methods: [String] = [], uploads: [Data] = [], conditions: [String?] = [], authorizations: [String?] = []
    func record(_ method: String, body: Data, condition: String?, authorization: String?) {
        lock.lock(); methods.append(method)
        if method == "PUT" { uploads.append(body); conditions.append(condition); authorizations.append(authorization) }; lock.unlock()
    }
    var recorded: (methods: [String], uploads: [Data], conditions: [String?], authorizations: [String?]) {
        lock.lock(); defer { lock.unlock() }; return (methods, uploads, conditions, authorizations)
    }
}

final class NativeWebDAVUploadAdmissionTests: XCTestCase {
    private var root: URL!, bundle: URL!, hostname: String!, state: UploadAdmissionFixtureState!
    private var unexpectedBefore = 0
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let at = "2026-10-06T12:00:00.000Z"
    private let refusal = "WebDAV attachment upload cannot be admitted by this host transport"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var source: URL { managed.appendingPathComponent(attachmentID + ".bin") }
    private var remote: String { "https://" + hostname + "/mindwtr/data.json" }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_ATTACHMENT_UPLOAD_TEST_BUNDLE"]
            ?? ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build attachment-upload-test-host.js and set MINDWTR_ATTACHMENT_UPLOAD_TEST_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured upload fixture bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeWebDAVUploadAdmissionTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Upload fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        hostname = "upload-" + UUID().uuidString.lowercased() + ".invalid"
        state = UploadAdmissionFixtureState(); unexpectedBefore = UploadAdmissionFixtureProtocol.unexpectedCount
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(UploadAdmissionFixtureProtocol.unexpectedCount, unexpectedBefore, "Every transport attempt was intercepted")
        if let hostname { UploadAdmissionFixtureProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func literal(_ text: String) throws -> String { try json([text]) + "[0]" }
    private func attachment(_ pending: Bool) -> [String: Any] {
        var value: [String: Any] = ["id": attachmentID, "kind": "file", "uri": source.absoluteString,
            "title": "Synthetic private upload.bin", "mimeType": "application/octet-stream", "size": 1,
            "createdAt": at, "updatedAt": at, "localStatus": "available"]
        if pending {
            value["cloudKey"] = "attachments/" + attachmentID + ".bin"
            value["fileHash"] = String(repeating: "a", count: 64); value["pendingContentUpload"] = true
        }
        return value
    }
    private func data(_ pending: Bool) -> [String: Any] {
        ["tasks": [["id": taskID, "title": "Synthetic upload task", "status": "inbox", "contexts": [], "tags": [],
                     "attachments": [attachment(pending)], "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture"]],
         "projects": [], "sections": [], "areas": [], "settings": [:]]
    }
    private func host(plans: [[String: Any]] = []) throws -> CoreHost {
        let suffix = """
        ;(()=>{
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map(),plans=\(try json(plans));let next=1000000000;
          const probe=()=>{const id=String(++next);Promise.resolve().then(async()=>{
            const gate=globalThis.attachmentUploadGate,n=__mindwtrNative;
            if(!gate||typeof gate.run!=='function'||typeof n.fileCall!=='function')throw new Error('Attachment upload fixture gate is unavailable');
            const input=plans.shift(),ops={},original=n.fileCall,crypto=n.cryptoCall;
            if(!input)throw new Error('Upload fixture probe failed');
            n.fileCall=request=>{const op=JSON.parse(request).op;ops[op]=(ops[op]||0)+1;return original(request)};
            n.cryptoCall=request=>{const op=JSON.parse(request).op;ops[op]=(ops[op]||0)+1;return crypto(request)};
            try {const result=await gate.run(input.data,input.cap,input.phase,input.url,input.fixture,input.provider);return {...result,ops,kv:typeof n.kvMultiGet}}
            finally {n.fileCall=original;n.cryptoCall=crypto}
          }).then(value=>replies.set(id,JSON.stringify({ok:true,value})),
            error=>replies.set(id,JSON.stringify({ok:false,error:error&&error.message==='Attachment upload fixture gate is unavailable'?'Attachment upload fixture gate is unavailable':'Upload fixture probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():oldPoll(id);
        })();
        """
        let probe = root.appendingPathComponent("probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: probe, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral, state = self.state!
        config.protocolClasses = [UploadAdmissionFixtureProtocol.self]; faults.httpConfiguration = config
        UploadAdmissionFixtureProtocol.install(hostname) { transport in
            let method = transport.request.httpMethod ?? ""
            state.record(method, body: method == "PUT" ? transport.body() : Data(), condition: transport.request.value(forHTTPHeaderField: "If-None-Match"),
                         authorization: transport.request.value(forHTTPHeaderField: "Authorization"))
            switch method {
            case "HEAD": transport.reply(404)
            case "MKCOL", "PUT": transport.reply(201)
            default: transport.client?.urlProtocol(transport, didFailWithError: URLError(.unsupportedURL))
            }
        }
        let value = CoreHost(databaseURL: database, bundleURL: probe, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ host: CoreHost) async throws {
        let count = state.recorded.methods.count; _ = try await host.start()
        XCTAssertEqual(state.recorded.methods.count, count, "Startup performs no transport work")
    }
    private func seed(_ pending: Bool) async throws {
        let initial = try host(); try await start(initial); await initial.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks (id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'inbox','[]','[]',?,?,?,1,'fixture',0,0,0,0)",
                            parametersJSON: json([taskID, "Synthetic upload task", try json([attachment(pending)]), at, at]))
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    }
    private func plan(cap: Int, phase: String, pending: Bool, encrypted: Bool = false, provider: String = "webdav") -> [String: Any] {
        var value: [String: Any] = ["data": data(pending), "cap": cap, "phase": phase,
                                    "url": provider == "selfhosted" ? "https://" + hostname + "/mindwtr/v1/data" : remote, "provider": provider]
        if encrypted { value["fixture"] = ["key": [Int](repeating: 0, count: 32), "salt": [Int](repeating: 0, count: 16), "params": ["mKib": 64, "t": 1, "p": 1]] }
        return value
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] {
        return try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }
    private func inode(_ url: URL) throws -> ino_t {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Upload fixture inode is unavailable") }; return value.st_ino
    }
    private func digest(_ url: URL) throws -> String {
        let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
        var hash = SHA256()
        while let bytes = try file.read(upToCount: 64 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for row in names {
            let name = try XCTUnwrap(row["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func assertRefused(_ result: [String: Any], provider: String = "webdav", file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(result["admitted"] as? Bool, false, file: file, line: line)
        XCTAssertEqual(result["name"] as? String, provider == "webdav" ? "WebdavHostUploadLimitError" : "CloudHostUploadLimitError", file: file, line: line)
        XCTAssertEqual(result["message"] as? String, provider == "webdav" ? refusal : "Cloud attachment upload cannot be admitted by this host transport", file: file, line: line)
        XCTAssertEqual(result["inputUnchanged"] as? Bool, true, file: file, line: line)
        XCTAssertNil(result["result"], file: file, line: line)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int], file: file, line: line)
        XCTAssertGreaterThan(ops["getInfo"] ?? 0, 0, file: file, line: line)
        for op in ["copy", "readBytes", "readBytesRange", "sha256File", "sha256", "writeBytes", "move", "aesGcmSeal", "aesGcmOpen"] {
            XCTAssertEqual(ops[op] ?? 0, 0, "Admission precedes source/snapshot bytes: " + op, file: file, line: line)
        }
        let warnings = try XCTUnwrap(result["warnings"] as? [[String: String]], file: file, line: line)
        XCTAssertEqual(warnings, [["releaseCheck": provider == "webdav" ? "v1.3.5/webdav-host-upload-limit" : "v1.3.5/cloud-host-upload-limit", "operation": "upload", "outcome": "refused"]], file: file, line: line)
        XCTAssertEqual(result["kv"] as? String, "undefined", file: file, line: line)
    }

    func testOverRawReadLimitSourceRefusesPreparePostMergeAndColdRepeatBeforeNativeBytesOrHTTP() async throws {
        try await seed(true)
        let fd = Darwin.open(source.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw HostFailure("Synthetic upload source creation failed") }
        XCTAssertEqual(ftruncate(fd, off_t(16 * 1024 * 1024 + 1)), 0)
        Darwin.close(fd)
        let originalInode = try inode(source), originalHash = try digest(source)
        let warm = try host(plans: [plan(cap: 8 * 1024 * 1024, phase: "prepare", pending: true),
                                   plan(cap: 8 * 1024 * 1024, phase: "post-merge", pending: true)])
        try await start(warm)
        let before = try rows(), beforeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        for _ in 0..<2 {
            try assertRefused(await probe(warm))
            XCTAssertEqual(state.recorded.methods.count, 0)
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try digest(source), originalHash)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        }
        do { _ = try await warm.call("syncSettings"); XCTFail("Private factory must not activate normal Sync") } catch { }
        await warm.close()
        let cold = try host(plans: [plan(cap: 8 * 1024 * 1024, phase: "post-merge", pending: true)])
        try await start(cold)
        try assertRefused(await probe(cold))
        XCTAssertEqual(state.recorded.methods.count, 0); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try digest(source), originalHash)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let lines = log.split(separator: "\n").filter { $0.contains("v1.3.5/webdav-host-upload-limit") }
        XCTAssertEqual(lines.count, 3, "Actual factory refusal reaches the native Diagnostics file")
        for line in lines {
            let context = try XCTUnwrap(object(String(line))["context"] as? [String: String])
            XCTAssertEqual(context, ["releaseCheck": "v1.3.5/webdav-host-upload-limit", "operation": "upload", "outcome": "refused"])
        }
        XCTAssertFalse(log.contains(source.absoluteString)); XCTAssertFalse(log.contains("Synthetic private upload.bin"))
        XCTAssertFalse(log.contains("synthetic-not-a-credential")); XCTAssertFalse(log.contains(hostname))
    }

    func testExactSmallCapUploadsRealSnapshotBytesWhileCapMinusOneRefusesBeforeCopy() async throws {
        try await seed(false)
        let bytes = Data([0, 255, 128, 1, 10, 13, 42, 7, 9]); try bytes.write(to: source)
        let originalInode = try inode(source), originalHash = try digest(source)
        let value = try host(plans: [plan(cap: bytes.count - 1, phase: "post-merge", pending: false),
                                    plan(cap: bytes.count, phase: "post-merge", pending: false)])
        try await start(value); let before = try rows()
        let beforeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        try assertRefused(await probe(value))
        XCTAssertEqual(state.recorded.methods.count, 0)
        let result = try await probe(value)
        XCTAssertEqual(result["admitted"] as? Bool, true); XCTAssertEqual(result["inputUnchanged"] as? Bool, true)
        let uploaded = try XCTUnwrap(result["result"] as? [String: Any])
        let tasks = try XCTUnwrap(uploaded["tasks"] as? [[String: Any]])
        let attachments = try XCTUnwrap(tasks.first?["attachments"] as? [[String: Any]])
        let attachment = try XCTUnwrap(attachments.first)
        XCTAssertEqual(attachment["fileHash"] as? String, originalHash)
        XCTAssertFalse((attachment["cloudKey"] as? String ?? "").isEmpty); XCTAssertNil(attachment["deletedAt"])
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        XCTAssertGreaterThan(ops["copy"] ?? 0, 0); XCTAssertGreaterThan(ops["sha256File"] ?? 0, 0)
        XCTAssertGreaterThan(ops["readBytes"] ?? 0, 0)
        let network = state.recorded
        XCTAssertEqual(network.methods.filter { $0 == "MKCOL" }.count, 1)
        XCTAssertEqual(network.methods.filter { $0 == "PUT" }.count, 1)
        XCTAssertGreaterThan(network.methods.filter { $0 == "HEAD" }.count, 0)
        XCTAssertEqual(network.uploads, [bytes]); XCTAssertEqual(network.conditions, ["*"])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        XCTAssertEqual(result["kv"] as? String, "undefined"); await value.close()
    }

    func testEncryptedWireCapAuthenticatesExactUploadAndRefusesEightMiBSourceBeforeBytesAcrossColdPhases() async throws {
        try await seed(false)
        let bytes = Data([0, 255, 128, 1, 10, 13, 42, 7, 9]); try bytes.write(to: source)
        // MWENC1 has a maintained 54-byte authenticated header and a 16-byte tag.
        let wireCap = bytes.count + 70
        let originalInode = try inode(source), originalHash = try digest(source)
        let exact = try host(plans: [plan(cap: wireCap - 1, phase: "post-merge", pending: false, encrypted: true),
                                    plan(cap: wireCap, phase: "post-merge", pending: false, encrypted: true)])
        try await start(exact); let before = try rows()
        let beforeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        try assertRefused(await probe(exact))
        XCTAssertEqual(state.recorded.methods.count, 0); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        let result = try await probe(exact)
        XCTAssertEqual(result["admitted"] as? Bool, true); XCTAssertEqual(result["inputUnchanged"] as? Bool, true)
        let uploaded = try XCTUnwrap(result["result"] as? [String: Any])
        let tasks = try XCTUnwrap(uploaded["tasks"] as? [[String: Any]])
        let attachments = try XCTUnwrap(tasks.first?["attachments"] as? [[String: Any]])
        let attachment = try XCTUnwrap(attachments.first)
        XCTAssertEqual(attachment["fileHash"] as? String, originalHash)
        XCTAssertFalse((attachment["cloudKey"] as? String ?? "").isEmpty); XCTAssertNil(attachment["deletedAt"])
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        for op in ["copy", "sha256File", "readBytes", "aesGcmSeal"] { XCTAssertGreaterThan(ops[op] ?? 0, 0, op) }
        let network = state.recorded
        XCTAssertEqual(network.methods.filter { $0 == "MKCOL" }.count, 1)
        XCTAssertEqual(network.methods.filter { $0 == "PUT" }.count, 1)
        XCTAssertGreaterThan(network.methods.filter { $0 == "HEAD" }.count, 0)
        XCTAssertEqual(network.conditions, ["*"])
        let wire = try XCTUnwrap(network.uploads.first); XCTAssertEqual(wire.count, wireCap)
        guard wire.count >= 70 else { throw HostFailure("Synthetic encrypted upload container is incomplete") }
        XCTAssertEqual(wire.prefix(8), Data("MWENC1".utf8) + Data([1, 1])); XCTAssertNotEqual(wire, bytes)
        let header = wire.prefix(54), nonce = try AES.GCM.Nonce(data: wire.subdata(in: 34..<46))
        let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: wire.subdata(in: 54..<(wire.count - 16)), tag: wire.suffix(16))
        XCTAssertEqual(try AES.GCM.open(sealed, using: SymmetricKey(data: Data(count: 32)), authenticating: header), bytes)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        XCTAssertEqual(result["kv"] as? String, "undefined"); await exact.close()

        // An 8 MiB plaintext source fits the old source cap but its sealed bytes
        // exceed the unchanged native 8 MiB wire cap. Use a real sparse file.
        let hostWireCap = 8 * 1024 * 1024
        let fd = Darwin.open(source.path, O_WRONLY | O_TRUNC | O_CLOEXEC)
        guard fd >= 0 else { throw HostFailure("Synthetic encrypted upload source creation failed") }
        XCTAssertEqual(ftruncate(fd, off_t(hostWireCap)), 0); Darwin.close(fd)
        XCTAssertEqual(try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, hostWireCap)
        let largeInode = try inode(source), largeHash = try digest(source), transportBefore = state.recorded.methods.count
        let warm = try host(plans: [plan(cap: hostWireCap, phase: "prepare", pending: true, encrypted: true),
                                   plan(cap: hostWireCap, phase: "post-merge", pending: true, encrypted: true)])
        try await start(warm)
        let largeBefore = try rows(), largeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        for _ in 0..<2 {
            try assertRefused(await probe(warm))
            XCTAssertEqual(state.recorded.methods.count, transportBefore); XCTAssertEqual(try rows(), largeBefore)
            XCTAssertEqual(try inode(source), largeInode); XCTAssertEqual(try digest(source), largeHash)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), largeCache)
        }
        await warm.close()
        let cold = try host(plans: [plan(cap: hostWireCap, phase: "post-merge", pending: true, encrypted: true)])
        try await start(cold); try assertRefused(await probe(cold))
        XCTAssertEqual(state.recorded.methods.count, transportBefore); XCTAssertEqual(try rows(), largeBefore)
        XCTAssertEqual(try inode(source), largeInode); XCTAssertEqual(try digest(source), largeHash)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), largeCache)
        await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let markers = log.split(separator: "\n").filter { $0.contains("v1.3.5/webdav-host-upload-limit") }
        XCTAssertEqual(markers.count, 4)
        for marker in markers {
            XCTAssertEqual(try object(String(marker))["context"] as? [String: String],
                           ["releaseCheck": "v1.3.5/webdav-host-upload-limit", "operation": "upload", "outcome": "refused"])
        }
        XCTAssertFalse(log.contains(source.absoluteString)); XCTAssertFalse(log.contains("Synthetic private upload.bin"))
        XCTAssertFalse(log.contains("synthetic-not-a-credential")); XCTAssertFalse(log.contains(hostname))
    }

    func testCloudWireCapUploadsExactBearerBytesAndRefusesOversizedSourceAcrossColdPhases() async throws {
        try await seed(false)
        let bytes = Data([0, 255, 128, 1, 10, 13, 42, 7, 9]); try bytes.write(to: source)
        let originalInode = try inode(source), originalHash = try digest(source)
        let exact = try host(plans: [plan(cap: bytes.count - 1, phase: "post-merge", pending: false, provider: "selfhosted"),
                                    plan(cap: bytes.count, phase: "post-merge", pending: false, provider: "selfhosted")])
        try await start(exact); let before = try rows()
        let beforeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        try assertRefused(await probe(exact), provider: "selfhosted")
        XCTAssertEqual(state.recorded.methods.count, 0); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        let result = try await probe(exact)
        XCTAssertEqual(result["admitted"] as? Bool, true); XCTAssertEqual(result["inputUnchanged"] as? Bool, true)
        let uploaded = try XCTUnwrap(result["result"] as? [String: Any])
        let tasks = try XCTUnwrap(uploaded["tasks"] as? [[String: Any]])
        let attachments = try XCTUnwrap(tasks.first?["attachments"] as? [[String: Any]])
        let attachment = try XCTUnwrap(attachments.first)
        XCTAssertEqual(attachment["fileHash"] as? String, originalHash)
        XCTAssertFalse((attachment["cloudKey"] as? String ?? "").isEmpty); XCTAssertNil(attachment["deletedAt"])
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        for op in ["copy", "sha256File", "readBytes"] { XCTAssertGreaterThan(ops[op] ?? 0, 0, op) }
        XCTAssertEqual(ops["aesGcmSeal"] ?? 0, 0, "Self-hosted follows the shared plaintext policy")
        let network = state.recorded
        XCTAssertEqual(network.methods, ["PUT"]); XCTAssertEqual(network.uploads, [bytes])
        XCTAssertEqual(network.authorizations.count, 1)
        XCTAssertTrue(network.authorizations.allSatisfy { $0 == "Bearer synthetic-fixture-token-395" }, "The owned PUT carries the exact private synthetic Bearer credential")
        XCTAssertEqual(network.conditions, [nil])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), beforeCache)
        XCTAssertEqual(result["kv"] as? String, "undefined"); await exact.close()

        // The source fits native file reads but exceeds the unchanged 8 MiB HTTP
        // wire cap. Pending generations are excluded from remote presence HEADs.
        let hostWireCap = 8 * 1024 * 1024
        let fd = Darwin.open(source.path, O_WRONLY | O_TRUNC | O_CLOEXEC)
        guard fd >= 0 else { throw HostFailure("Synthetic cloud upload source creation failed") }
        XCTAssertEqual(ftruncate(fd, off_t(hostWireCap + 1)), 0); Darwin.close(fd)
        XCTAssertEqual(try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, hostWireCap + 1)
        let largeInode = try inode(source), largeHash = try digest(source), transportBefore = state.recorded.methods.count
        let warm = try host(plans: [plan(cap: hostWireCap, phase: "prepare", pending: true, provider: "selfhosted"),
                                   plan(cap: hostWireCap, phase: "post-merge", pending: true, provider: "selfhosted")])
        try await start(warm)
        let largeBefore = try rows(), largeCache = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        for _ in 0..<2 {
            try assertRefused(await probe(warm), provider: "selfhosted")
            XCTAssertEqual(state.recorded.methods.count, transportBefore); XCTAssertEqual(try rows(), largeBefore)
            XCTAssertEqual(try inode(source), largeInode); XCTAssertEqual(try digest(source), largeHash)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), largeCache)
        }
        await warm.close()
        let cold = try host(plans: [plan(cap: hostWireCap, phase: "post-merge", pending: true, provider: "selfhosted")])
        try await start(cold); try assertRefused(await probe(cold), provider: "selfhosted")
        XCTAssertEqual(state.recorded.methods.count, transportBefore); XCTAssertEqual(try rows(), largeBefore)
        XCTAssertEqual(try inode(source), largeInode); XCTAssertEqual(try digest(source), largeHash)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), largeCache)
        await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let markers = log.split(separator: "\n").filter { $0.contains("v1.3.5/cloud-host-upload-limit") }
        XCTAssertEqual(markers.count, 4)
        for marker in markers {
            XCTAssertEqual(try object(String(marker))["context"] as? [String: String],
                           ["releaseCheck": "v1.3.5/cloud-host-upload-limit", "operation": "upload", "outcome": "refused"])
        }
        XCTAssertFalse(log.contains(source.absoluteString)); XCTAssertFalse(log.contains("Synthetic private upload.bin"))
        XCTAssertFalse(log.contains("synthetic-fixture-token-395")); XCTAssertFalse(log.contains(hostname))
    }
}
