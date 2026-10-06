import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class DownloadAdmissionFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (DownloadAdmissionFixtureProtocol) -> Void] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ hostname: String, handler: @escaping (DownloadAdmissionFixtureProtocol) -> Void) {
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
    func reply(_ bytes: Data = Data(), status: Int = 200, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        client?.urlProtocolDidFinishLoading(self)
    }

}

private final class DownloadAdmissionFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var methods: [String] = []
    func record(_ method: String) { lock.lock(); methods.append(method); lock.unlock() }
    var recorded: [String] { lock.lock(); defer { lock.unlock() }; return methods }

}

final class NativeWebDAVDownloadAdmissionTests: XCTestCase {
    private var root: URL!, bundle: URL!, hostname: String!, state: DownloadAdmissionFixtureState!
    private var unexpectedBefore = 0
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let at = "2026-10-06T12:00:00.000Z"
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
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured download fixture bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeWebDAVDownloadAdmissionTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Download fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        hostname = "download-" + UUID().uuidString.lowercased() + ".invalid"
        state = DownloadAdmissionFixtureState(); unexpectedBefore = DownloadAdmissionFixtureProtocol.unexpectedCount
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(DownloadAdmissionFixtureProtocol.unexpectedCount, unexpectedBefore, "Every transport attempt was intercepted")
        if let hostname { DownloadAdmissionFixtureProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func attachment(hash: String, pending: Bool = false) -> [String: Any] {
        var value: [String: Any] = ["id": attachmentID, "kind": "file", "uri": source.absoluteString,
            "title": "Synthetic private download.bin", "mimeType": "application/octet-stream", "size": 1,
            "createdAt": at, "updatedAt": at, "localStatus": "available",
            "cloudKey": "attachments/" + attachmentID + ".bin", "fileHash": hash]
        if pending { value["pendingContentUpload"] = true }
        return value
    }
    private func data(_ attachment: [String: Any]) -> [String: Any] {
        ["tasks": [["id": taskID, "title": "Synthetic download task", "status": "inbox", "contexts": [], "tags": [],
                     "attachments": [attachment], "createdAt": at, "updatedAt": at, "rev": 1, "revBy": "fixture"]],
         "projects": [], "sections": [], "areas": [], "settings": [:]]
    }
    private func host(plans: [[String: Any]] = [], limit: Int = 4, bytes: Data = Data(), headers: [String: String] = [:]) throws -> CoreHost {
        let suffix = """
        ;(()=>{
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map(),plans=\(try json(plans));let next=1000000000;
          const probe=()=>{const id=String(++next);Promise.resolve().then(async()=>{
            const gate=globalThis.attachmentUploadGate,n=__mindwtrNative;
            if(!gate||typeof gate.run!=='function'||typeof n.fileCall!=='function')throw new Error('Attachment upload fixture gate is unavailable');
            const input=plans.shift(),ops={},original=n.fileCall,installer=n.installerCall,crypto=n.cryptoCall;
            if(!input)throw new Error('Upload fixture probe failed');
            n.fileCall=request=>{const op=JSON.parse(request).op;ops[op]=(ops[op]||0)+1;return original(request)};
            n.installerCall=request=>{ops.installer=(ops.installer||0)+1;return installer(request)};
            n.cryptoCall=request=>{const op=JSON.parse(request).op;ops[op]=(ops[op]||0)+1;return crypto(request)};
            try {const result=await gate.run(input.data,input.cap,input.phase,input.url,input.fixture);return {...result,ops,kv:typeof n.kvMultiGet}}
            finally {n.fileCall=original;n.installerCall=installer;n.cryptoCall=crypto}
          }).then(value=>replies.set(id,JSON.stringify({ok:true,value})),
            error=>replies.set(id,JSON.stringify({ok:false,error:error&&error.message==='Attachment upload fixture gate is unavailable'?'Attachment upload fixture gate is unavailable':'Upload fixture probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():oldPoll(id);
        })();
        """
        let probe = root.appendingPathComponent("probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: probe, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral, state = self.state!
        config.protocolClasses = [DownloadAdmissionFixtureProtocol.self]; faults.httpConfiguration = config; faults.httpByteLimit = limit
        DownloadAdmissionFixtureProtocol.install(hostname) { transport in
            let method = transport.request.httpMethod ?? ""
            state.record(method)
            switch method {
            case "HEAD": transport.reply(headers: ["Content-Length": String(bytes.count)])
            case "GET": transport.reply(bytes, headers: headers)
            default: transport.client?.urlProtocol(transport, didFailWithError: URLError(.unsupportedURL))
            }
        }
        let value = CoreHost(databaseURL: database, bundleURL: probe, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ host: CoreHost) async throws {
        let count = state.recorded.count; _ = try await host.start()
        XCTAssertEqual(state.recorded.count, count, "Startup performs no transport work")
    }
    private func seed(_ attachment: [String: Any]) async throws {
        let initial = try host(); try await start(initial); await initial.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks (id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'inbox','[]','[]',?,?,?,1,'fixture',0,0,0,0)",
                            parametersJSON: json([taskID, "Synthetic download task", try json([attachment]), at, at]))
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    }
    private func plan(_ attachment: [String: Any], phase: String = "post-merge", encrypted: Bool = false) -> [String: Any] {
        var value: [String: Any] = ["data": data(attachment), "cap": 1024, "phase": phase, "url": remote]
        if encrypted { value["fixture"] = ["key": [Int](repeating: 0, count: 32), "salt": [Int](repeating: 0, count: 16), "params": ["mKib": 64, "t": 1, "p": 1]] }
        return value
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] {
        return try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }
    private func inode(_ url: URL) throws -> ino_t {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Download fixture inode is unavailable") }; return value.st_ino
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

    private func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func assertRefused(_ result: [String: Any], limit: Int, mayHashLocal: Bool = false, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(result["admitted"] as? Bool, false, file: file, line: line)
        XCTAssertEqual(result["name"] as? String, "TypeError", file: file, line: line)
        XCTAssertEqual(result["code"] as? String, "response-too-large", file: file, line: line)
        XCTAssertEqual(result["limitBytes"] as? Int, limit, file: file, line: line)
        XCTAssertEqual(result["message"] as? String, "Response exceeds the \(limit) byte download limit", file: file, line: line)
        XCTAssertEqual(result["inputUnchanged"] as? Bool, true, file: file, line: line)
        XCTAssertNil(result["result"], file: file, line: line)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int], file: file, line: line)
        for op in ["copy", "readBytes", "readBytesRange", "writeBytes", "move", "installer", "aesGcmOpen", "sha256"] {
            XCTAssertEqual(ops[op] ?? 0, 0, "Refused bytes cannot reach " + op, file: file, line: line)
        }
        if !mayHashLocal { XCTAssertEqual(ops["sha256File"] ?? 0, 0, file: file, line: line) }
        XCTAssertEqual(result["warnings"] as? [[String: String]], [["releaseCheck": "v1.3.5/webdav-host-download-limit", "operation": "download", "outcome": "refused"]], file: file, line: line)
        XCTAssertEqual(result["kv"] as? String, "undefined", file: file, line: line)
    }
    private func assertInstalled(_ result: [String: Any], bytes: Data, encrypted: Bool = false) throws {
        XCTAssertEqual(result["admitted"] as? Bool, true); XCTAssertEqual(result["inputUnchanged"] as? Bool, true)
        let uploaded = try XCTUnwrap(result["result"] as? [String: Any])
        let tasks = try XCTUnwrap(uploaded["tasks"] as? [[String: Any]])
        let attachments = try XCTUnwrap(tasks.first?["attachments"] as? [[String: Any]])
        let attachment = try XCTUnwrap(attachments.first)
        XCTAssertEqual(attachment["id"] as? String, attachmentID); XCTAssertEqual(attachment["uri"] as? String, source.absoluteString)
        XCTAssertEqual(attachment["localStatus"] as? String, "available"); XCTAssertEqual(attachment["fileHash"] as? String, hash(bytes))
        XCTAssertNil(attachment["deletedAt"]); XCTAssertNotEqual(attachment["pendingContentUpload"] as? Bool, true)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        XCTAssertGreaterThan(ops["writeBytes"] ?? 0, 0); XCTAssertGreaterThan(ops["installer"] ?? 0, 0)
        XCTAssertEqual(ops["aesGcmOpen"] ?? 0, encrypted ? 1 : 0)
    }

    func testMissingLocalDeclaredStreamedAndDishonestCapsKeepPendingDataAndColdRetry() async throws {
        let bytes = Data([0,255,128,1,7]), pending = attachment(hash: hash(bytes), pending: true)
        try await seed(pending)
        var before: [String: String]?
        for (index, headers) in [["Content-Length": "5"], [:], ["Content-Length": "1"]].enumerated() {
            let selected = attachment(hash: hash(bytes), pending: index != 0)
            let value = try host(plans: [plan(selected, phase: index == 0 ? "prepare" : "post-merge")], bytes: bytes, headers: headers)
            try await start(value); if before == nil { before = try rows() }
            let count = state.recorded.filter { $0 == "GET" }.count
            let managedBefore = try FileManager.default.contentsOfDirectory(atPath: managed.path)
            let cacheBefore = try FileManager.default.contentsOfDirectory(atPath: cache.path)
            try assertRefused(await probe(value), limit: 4)
            XCTAssertEqual(state.recorded.filter { $0 == "GET" }.count, count + 1, "A coded cap refusal is not retried")
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), managedBefore)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), cacheBefore)
            await value.close()
        }
        let cold = try host(plans: [plan(pending)], bytes: bytes, headers: ["Content-Length": "5"])
        try await start(cold); try assertRefused(await probe(cold), limit: 4)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertFalse(state.recorded.contains("PUT")); XCTAssertFalse(state.recorded.contains("MKCOL")); await cold.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let markers = log.split(separator: "\n").filter { $0.contains("v1.3.5/webdav-host-download-limit") }
        XCTAssertEqual(markers.count, 4)
        for marker in markers {
            XCTAssertEqual(try object(String(marker))["context"] as? [String: String], ["releaseCheck": "v1.3.5/webdav-host-download-limit", "operation": "download", "outcome": "refused"])
        }
        XCTAssertFalse(log.contains(hostname)); XCTAssertFalse(log.contains(source.absoluteString))
        XCTAssertFalse(log.contains("Synthetic private download.bin")); XCTAssertFalse(log.contains("synthetic-not-a-credential"))
    }

    func testRemoteWinnerCapRetainsExactExistingTargetWithoutStagingReplacement() async throws {
        let remoteBytes = Data([0,255,128,1,7]), local = Data([9,8,7,6])
        var selected = attachment(hash: hash(remoteBytes)); selected["contentMtimeMs"] = 1; selected["contentSize"] = 1
        try await seed(selected); try local.write(to: source)
        let originalInode = try inode(source)
        let value = try host(plans: [plan(selected)], bytes: remoteBytes, headers: ["Content-Length": "5"])
        try await start(value); let before = try rows(), cacheBefore = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        let result = try await probe(value); try assertRefused(result, limit: 4, mayHashLocal: true)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int]); XCTAssertGreaterThan(ops["sha256File"] ?? 0, 0, "The existing generation is proved before GET")
        XCTAssertEqual(state.recorded.filter { $0 == "GET" }.count, 1)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(source), originalInode); XCTAssertEqual(try Data(contentsOf: source), local)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path), cacheBefore)
        await value.close()
    }

    func testExactBinaryCapInstallsRealBytesAndOnlyReturnsConfirmedMetadata() async throws {
        let bytes = Data([0,255,128,1]), selected = attachment(hash: hash(bytes), pending: true)
        try await seed(selected)
        let value = try host(plans: [plan(selected)], bytes: bytes, headers: ["Content-Length": "4"])
        try await start(value); let before = try rows()
        try assertInstalled(await probe(value), bytes: bytes)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(state.recorded.filter { $0 == "GET" }.count, 1)
        XCTAssertFalse(state.recorded.contains("PUT")); await value.close()
    }

    func testValidEncryptedWireRefusesBeforeDecryptThenExactWireCapInstallsPlaintext() async throws {
        let plain = Data([0,255,128,1]), selected = attachment(hash: hash(plain), pending: true)
        // Maintained MWENC1 header (54 bytes), with deterministic synthetic AES-256
        // material. CryptoKit supplies an independent wire oracle; the real native
        // crypto/shared decoder must authenticate it on the successful path.
        var header = Data("MWENC1".utf8); header.append(contentsOf: [1,1,64,0,0,0,1,0,0,0,1,1])
        header.append(Data(count: 16)); header.append(Data(count: 12)); header.append(contentsOf: [20,0,0,0,0,0,0,0])
        XCTAssertEqual(header.count, 54)
        let sealed = try AES.GCM.seal(plain, using: SymmetricKey(data: Data(count: 32)), nonce: AES.GCM.Nonce(data: Data(count: 12)), authenticating: header)
        var wire = header; wire.append(sealed.ciphertext); wire.append(sealed.tag); XCTAssertEqual(wire.count, 74)
        try await seed(selected)
        let refused = try host(plans: [plan(selected, encrypted: true)], limit: wire.count - 1, bytes: wire, headers: ["Content-Length": String(wire.count)])
        try await start(refused); let before = try rows()
        try assertRefused(await probe(refused), limit: wire.count - 1)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: source.path)); await refused.close()
        let exact = try host(plans: [plan(selected, encrypted: true)], limit: wire.count, bytes: wire, headers: ["Content-Length": String(wire.count)])
        try await start(exact); try assertInstalled(await probe(exact), bytes: plain, encrypted: true)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(state.recorded.filter { $0 == "GET" }.count, 2)
        await exact.close()
    }
}
