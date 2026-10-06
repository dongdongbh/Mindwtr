import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class CleanupRefusingProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var attempts = 0
    static var count: Int { lock.lock(); defer { lock.unlock() }; return attempts }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.attempts += 1; Self.lock.unlock()
        client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }
    override func stopLoading() { }
}

private final class CleanupBarrier: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    private var claimed = false
    let entered: XCTestExpectation
    let release = DispatchSemaphore(value: 0)
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func arm() { lock.lock(); armed = true; lock.unlock() }
    func holdFirstFileJob(_ isInstaller: Bool) {
        lock.lock()
        let hold = armed && !claimed && !isInstaller
        if hold { claimed = true }
        lock.unlock()
        if hold { entered.fulfill(); release.wait() } // Native file worker only; never the async test/Engine.
    }
}

final class NativeAttachmentCleanupFreshnessTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var networkBefore = 0
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let at = "2026-10-06T12:00:00.000Z"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var source: URL { managed.appendingPathComponent(attachmentID + ".txt") }
    private let bytes = Data("Synthetic retained cleanup bytes".utf8)

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_ATTACHMENT_UPLOAD_TEST_BUNDLE"]
            ?? ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build attachment-upload-test-host.js and set MINDWTR_ATTACHMENT_UPLOAD_TEST_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured cleanup fixture bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeAttachmentCleanupFreshnessTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        root = try physicalURL(fixture)
        networkBefore = CleanupRefusingProtocol.count
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(CleanupRefusingProtocol.count, networkBefore, "No startup or cleanup transport attempt is permitted")
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func physicalURL(_ url: URL) throws -> URL {
        guard let physical = Darwin.realpath(url.path, nil) else { throw HostFailure("Cleanup fixture physical path is unavailable") }
        defer { free(physical) }; return URL(fileURLWithPath: String(cString: physical), isDirectory: url.hasDirectoryPath)
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func attachment(id: String? = nil, uri: String? = nil, deleted: Bool = true) -> [String: Any] {
        var row: [String: Any] = ["id": id ?? attachmentID, "kind": "file", "uri": uri ?? source.absoluteString,
            "title": "Synthetic private cleanup title", "createdAt": at, "updatedAt": at, "localStatus": "available"]
        if deleted { row["deletedAt"] = at }
        return row
    }
    private func host(save: String? = nil) throws -> CoreHost {
        let saveValue: Any
        if let save { saveValue = save } else { saveValue = NSNull() }
        let encodedSave = try json([saveValue])
        // Test-only wrappers forward the native file requests unchanged. The
        // save timer uses the existing shared durable command, never setState.
        let prefix = """
        (()=>{
          const n=globalThis.__mindwtrNative;globalThis.__cleanupOps={};let scheduled=false;
          const record=op=>{const ops=globalThis.__cleanupOps;ops[op]=(ops[op]||0)+1};
          const original=n.fileCall;
          n.fileCall=payload=>{const op=JSON.parse(payload).op;record(op);const id=original(payload);
            if(!scheduled&&op==='barrier'&&\(encodedSave)[0]!==null){scheduled=true;setTimeout(()=>{
              const ticket=MindwtrHost.saveDraft(\(encodedSave)[0]);
              const check=()=>{const reply=MindwtrHost.poll(ticket);if(reply===null){setTimeout(check,1);return}
                globalThis.__cleanupRestoreSucceeded=JSON.parse(reply).ok===true};check();
            },0)}return id};
          const remove=n.fileDeleteNow;n.fileDeleteNow=uri=>{record('deleteNow');return remove(uri)};
          for(const name of ['netFetch','secretCall','cryptoCall','installerCall']){
            if(typeof n[name]==='function'){const call=n[name];n[name]=(...args)=>{record(name);return call(...args)}}
          }
        })();
        """
        let suffix = """
        ;(()=>{
          const menu=MindwtrHost.menuRead,poll=MindwtrHost.poll,replies=new Map();let next=1000000000;
          const probe=()=>{const id=String(++next),startupOps={...globalThis.__cleanupOps};globalThis.__cleanupOps={};
            Promise.resolve().then(async()=>{
              const gate=globalThis.attachmentCleanupGate;
              if(!gate||typeof gate.run!=='function')throw new Error('Attachment cleanup fixture gate is unavailable');
              const result=await gate.run();return {...result,startupOps,ops:{...globalThis.__cleanupOps},
                restoreSucceeded:globalThis.__cleanupRestoreSucceeded===true,kv:typeof __mindwtrNative.kvMultiGet};
            }).then(value=>replies.set(id,JSON.stringify({ok:true,value})),
              error=>replies.set(id,JSON.stringify({ok:false,error:error&&error.message==='Attachment cleanup fixture gate is unavailable'
                ?'Attachment cleanup fixture gate is unavailable':'Attachment cleanup fixture probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():menu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():poll(id);
        })();
        """
        let instrumented = root.appendingPathComponent("probe-" + UUID().uuidString + ".js")
        try (prefix + String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: instrumented, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CleanupRefusingProtocol.self]; faults.httpConfiguration = config
        let result = CoreHost(databaseURL: database, bundleURL: instrumented, faults: faults)
        addTeardownBlock { await result.close() }; return result
    }
    private func seed(projectURI: String? = nil) async throws {
        let initial = try host(); _ = try await initial.start(); await initial.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks (id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'inbox','[]','[]',?,?,?,1,'fixture',0,0,0,0)",
            parametersJSON: json([taskID, "Synthetic cleanup task", try json([attachment()]), at, at]))
        if let projectURI {
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,'Synthetic soft-deleted Project','active','#94a3b8','[]',0,0,?,?,?,?,1,'fixture')",
                parametersJSON: json([UUID().uuidString.lowercased(), try json([attachment(id: UUID().uuidString.lowercased(), uri: projectURI, deleted: false)]), at, at, at]))
        }
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try bytes.write(to: source)
    }
    private func storedAttachments() throws -> [[String: Any]] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT attachments FROM tasks WHERE id=?", parametersJSON: json([taskID])).utf8)) as? [[String: Any]])
        let text = try XCTUnwrap(rows.first?["attachments"] as? String)
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [[String: Any]])
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
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] {
        try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }
    private func assertLocalOnly(_ result: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(result["inputUnchanged"] as? Bool, true, file: file, line: line)
        XCTAssertEqual(result["warningCount"] as? Int, 0, file: file, line: line)
        XCTAssertEqual(result["kv"] as? String, "undefined", file: file, line: line)
        let startup = try XCTUnwrap(result["startupOps"] as? [String: Int], file: file, line: line)
        XCTAssertTrue(startup.isEmpty, "Startup performs no private I/O work", file: file, line: line)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int], file: file, line: line)
        for op in ["netFetch", "secretCall", "cryptoCall", "installerCall", "readBytes", "writeBytes", "copy", "move"] {
            XCTAssertEqual(ops[op] ?? 0, 0, "Cleanup must not invoke " + op, file: file, line: line)
        }
    }
    private func markerEntries() throws -> [[String: Any]] {
        let file = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
            .filter { $0.contains("v1.3.5/native-cleanup-freshness") }.map { try object(String($0)) }
    }

    func testHeldCleanupAbortsAfterActualDurableSaveRestoresLiveReference() async throws {
        try await seed()
        let restoredID = UUID().uuidString.lowercased(), tombstone = attachment()
        // Ordinary draft merging intentionally never revives a tombstoned id.
        // A newly saved live record references the same already-existing bytes.
        let live = attachment(id: restoredID, deleted: false)
        let save = try json(["id": taskID, "base": [:] as [String: Any], "patch": [:] as [String: Any],
            "attachments": ["base": [tombstone], "value": [tombstone, live]], "requestId": UUID().uuidString.lowercased()])
        let value = try host(save: save), barrier = CleanupBarrier(expectation(description: "Native cleanup file barrier entered"))
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, installer in barrier.holdFirstFileJob(installer) } }
        await value.configureAttachmentHost(hooks); _ = try await value.start(); barrier.arm()
        defer { barrier.release.signal() }
        let cleanup = Task { try await self.probe(value) }
        await fulfillment(of: [barrier.entered], timeout: 5)
        let deadline = Date().addingTimeInterval(5)
        while !(try storedAttachments()).contains(where: { ($0["id"] as? String) == restoredID && $0["deletedAt"] == nil }), Date() < deadline {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        let durable = try storedAttachments()
        XCTAssertTrue(durable.contains { ($0["id"] as? String) == restoredID && $0["deletedAt"] == nil }, "Production saveDraft became durable before the native barrier was released")
        XCTAssertEqual(try Data(contentsOf: source), bytes)
        barrier.release.signal()
        let result = try await cleanup.value; try assertLocalOnly(result)
        XCTAssertEqual(result["completed"] as? Bool, false)
        XCTAssertEqual(result["name"] as? String, "LocalSyncAbort"); XCTAssertEqual(result["reason"] as? String, "local-data-changed")
        XCTAssertEqual(result["followUpRequested"] as? Bool, true); XCTAssertEqual(result["restoreSucceeded"] as? Bool, true)
        XCTAssertNil(result["result"])
        XCTAssertEqual(result["markers"] as? [[String: String]], [])
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        XCTAssertEqual(ops["barrier"], 1); XCTAssertEqual(ops["deleteNow"] ?? 0, 0); XCTAssertEqual(ops["syncParent"] ?? 0, 0)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try markerEntries().count, 0)
        await value.close()
        let cold = try host(); _ = try await cold.start()
        let view = try await cold.call("taskView", argumentsJSON: json([json(["id": taskID])]))
        XCTAssertTrue(view.contains(restoredID)); XCTAssertEqual(try json(storedAttachments()), try json(durable))
        XCTAssertEqual(try Data(contentsOf: source), bytes); await cold.close()
    }

    func testUnchangedTombstoneUnlinksWithoutPersistingCleanupDocument() async throws {
        try await seed()
        let value = try host(); _ = try await value.start(); let before = try rows()
        let result = try await probe(value); try assertLocalOnly(result)
        XCTAssertEqual(result["completed"] as? Bool, true); XCTAssertEqual(result["followUpRequested"] as? Bool, false)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        XCTAssertEqual(ops["barrier"], 1); XCTAssertEqual(ops["deleteNow"], 1); XCTAssertEqual(ops["syncParent"], 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        let cleanup = try XCTUnwrap(result["result"] as? [String: Any]), data = try XCTUnwrap(cleanup["appData"] as? [String: Any])
        let tasks = try XCTUnwrap(data["tasks"] as? [[String: Any]]), attachments = try XCTUnwrap(tasks.first?["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.first?["id"] as? String, attachmentID); XCTAssertEqual(attachments.first?["localStatus"] as? String, "missing")
        XCTAssertEqual(try rows(), before, "The private cleanup return document is never saved")
        XCTAssertEqual(try storedAttachments().first?["localStatus"] as? String, "available")
        XCTAssertEqual(result["markers"] as? [[String: String]], [["releaseCheck": "v1.3.5/native-cleanup-freshness", "outcome": "removed"]])
        await value.close()
        let entries = try markerEntries(); XCTAssertEqual(entries.count, 1)
        let marker = try XCTUnwrap(entries.first)
        XCTAssertEqual(Set(marker.keys), Set(["ts", "level", "scope", "message", "context"]))
        XCTAssertEqual(marker["scope"] as? String, "native-ios"); XCTAssertEqual(marker["level"] as? String, "info")
        XCTAssertEqual(marker["message"] as? String, "Attachment cleanup freshness guarded")
        XCTAssertEqual(marker["context"] as? [String: String], ["releaseCheck": "v1.3.5/native-cleanup-freshness", "outcome": "removed"])
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        for privateValue in [taskID, attachmentID, source.absoluteString, "Synthetic private cleanup title"] { XCTAssertFalse(log.contains(privateValue)) }
        XCTAssertEqual(try rows(), before)
    }

    func testSoftDeletedProjectLiveReferenceKeepsTaskTombstoneBytes() async throws {
        var uri = source.absoluteString
        #if os(iOS)
        XCTAssertTrue(root.path.range(of: "/(?:private/)?var/mobile/Containers/Data/Application/[0-9A-Fa-f-]{36}/", options: .regularExpression) != nil)
        if uri.hasPrefix("file:///private/var/") { uri = uri.replacingOccurrences(of: "file:///private/var/", with: "file:///var/") }
        else { XCTAssertTrue(uri.hasPrefix("file:///var/")); uri = uri.replacingOccurrences(of: "file:///var/", with: "file:///private/var/") }
        XCTAssertNotEqual(uri, source.absoluteString, "Physical iOS proof uses distinct fixed aliases")
        #endif
        try await seed(projectURI: uri)
        let alias = try XCTUnwrap(URL(string: uri))
        XCTAssertEqual(try physicalURL(alias).path, try physicalURL(source).path, "Both references name the same actual file, never another container")
        XCTAssertEqual(try Data(contentsOf: alias), bytes)
        let value = try host(); _ = try await value.start(); let before = try rows()
        let result = try await probe(value); try assertLocalOnly(result)
        XCTAssertEqual(result["completed"] as? Bool, true); XCTAssertEqual(result["followUpRequested"] as? Bool, false)
        let ops = try XCTUnwrap(result["ops"] as? [String: Int])
        for op in ["barrier", "deleteNow", "syncParent"] { XCTAssertEqual(ops[op] ?? 0, 0, "The live Project reference prevents deletion admission") }
        XCTAssertEqual(result["markers"] as? [[String: String]], [])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: source), bytes)
        XCTAssertEqual(try markerEntries().count, 0); await value.close()
    }
}
