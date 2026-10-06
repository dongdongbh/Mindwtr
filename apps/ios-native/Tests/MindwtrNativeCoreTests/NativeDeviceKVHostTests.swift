import XCTest
import Foundation
import CryptoKit
import Security
import Darwin
@testable import MindwtrNativeCore

private final class DeviceKVHostState: @unchecked Sendable {
    private let lock = NSLock()
    private var promotions = 0, receipts = 0, otherIO = 0
    func promotion() { lock.lock(); promotions += 1; lock.unlock() }
    func receipt() { lock.lock(); receipts += 1; lock.unlock() }
    func unexpectedIO() { lock.lock(); otherIO += 1; lock.unlock() }
    var counts: (promotions: Int, receipts: Int, otherIO: Int) {
        lock.lock(); defer { lock.unlock() }; return (promotions, receipts, otherIO)
    }
}

/// Every unexpected request terminates here; there is no external fallback.
private final class DeviceKVHTTPFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var requests = 0
    static var count: Int { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requests += 1; Self.lock.unlock()
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() { }
}

final class NativeDeviceKVHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, container: URL!, namespace: String!, state: DeviceKVHostState!
    private var networkBefore = 0
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var storage: URL {
        container.appendingPathComponent("Library/Application Support/\(namespace!)/RCTAsyncLocalStorage_V1", isDirectory: true)
    }
    private var manifest: URL { storage.appendingPathComponent("manifest.json") }
    private let backend = "@mindwtr_sync_backend", path = "@mindwtr_sync_path"
    private let invalid = "!MindwtrNativeError:Device settings input is invalid"
    private let unavailable = "!MindwtrNativeError:Device settings storage is unavailable"

    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: source)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeDeviceKVHostTests/kv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Device fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        container = root.appendingPathComponent("device", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
        namespace = "mindwtr.device.fixture." + UUID().uuidString.lowercased()
        state = DeviceKVHostState(); networkBefore = DeviceKVHTTPFixtureProtocol.count
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(DeviceKVHTTPFixtureProtocol.count, networkBefore, "Storage bridge performs no HTTP")
        if let state { XCTAssertEqual(state.counts.otherIO, 0, "Storage bridge performs no secret or crypto operation") }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func literal(_ value: String) throws -> String { try json([value]) + "[0]" }
    private func seed(_ entries: [(String, Any)]) throws {
        try FileManager.default.createDirectory(at: storage, withIntermediateDirectories: true)
        // NSDictionary preserves byte-distinct canonical Unicode keys.
        let values = NSMutableDictionary()
        for (key, value) in entries { values.setObject(value, forKey: key as NSString) }
        try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]).write(to: manifest)
    }
    private func external(_ key: String, bytes: Data) throws -> URL {
        let name = Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        let file = storage.appendingPathComponent(name); try bytes.write(to: file); return file
    }
    private func faults() -> HostIOFaults {
        let value = HostIOFaults(), state = self.state!
        value.configureDeviceStorage = { store in store.faults.afterPromotion = { state.promotion() } }
        value.commandDiagnostic = { if $0 == "deviceStorageDelivered" { state.receipt() } }
        value.cryptoBeforeOperation = { _ in state.unexpectedIO() }
        value.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        value.secretBeforeOperation = { _, _ in state.unexpectedIO() }
        value.secretStatus = { _, _ in errSecItemNotFound }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DeviceKVHTTPFixtureProtocol.self]
        value.httpConfiguration = config; return value
    }
    private let helpers = """
    const n=__mindwtrNative, names=['kvGet','kvSet','kvRemove','kvMultiGet','kvMultiSet','kvMultiRemove'];
    const checked=value=>{if(typeof value==='string'&&value.startsWith('!MindwtrNativeError:'))throw new Error('Storage probe refused');return value};
    const get=key=>JSON.parse(checked(n.kvGet(key))), many=keys=>JSON.parse(checked(n.kvMultiGet(JSON.stringify(keys))));
    """
    private func probeBundle(_ expression: String, beforeBoot: String = "", extra: String = "") throws -> URL {
        let suffix = """
        ;(()=>{\(beforeBoot)
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000;
          const probe=()=>{const id=String(++next);Promise.resolve().then(async()=>{\(helpers)\n\(expression)}).then(
            value=>replies.set(id,JSON.stringify({ok:true,value})),
            ()=>replies.set(id,JSON.stringify({ok:false,error:'Device storage probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():oldPoll(id);
          \(extra)
        })();
        """
        let url = root.appendingPathComponent("probe-\(UUID().uuidString).js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: url, atomically: true, encoding: .utf8); return url
    }
    private func host(_ expression: String, optedIn: Bool = true, database: URL? = nil,
                      faults: HostIOFaults? = nil, beforeBoot: String = "", extra: String = "") throws -> CoreHost {
        let value = CoreHost(databaseURL: database ?? self.database,
                             bundleURL: try probeBundle(expression, beforeBoot: beforeBoot, extra: extra),
                             faults: faults ?? self.faults(),
                             deviceStorage: optedIn ? (containerURL: container, bundleIdentifier: namespace) : nil)
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ host: CoreHost) async throws {
        let before = state.counts, network = DeviceKVHTTPFixtureProtocol.count
        _ = try await host.start()
        XCTAssertEqual(state.counts.promotions, before.promotions, "Startup writes no device settings")
        XCTAssertEqual(state.counts.receipts, before.receipts, "Startup is not storage delivery")
        XCTAssertEqual(state.counts.otherIO, before.otherIO)
        XCTAssertEqual(DeviceKVHTTPFixtureProtocol.count, network)
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] {
        try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
    }
    private func receipts(_ minimum: Int) async throws {
        for _ in 0..<500 { if state.counts.receipts >= minimum { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTFail("Current storage delivery receipt did not arrive")
    }
    private func rows(_ database: URL? = nil) throws -> [String: String] {
        let sql = try SQLiteBridge(url: database ?? self.database); defer { sql.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for row in names {
            let name = try XCTUnwrap(row["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let columnName = try XCTUnwrap(column["name"] as? String).replacingOccurrences(of: "\"", with: "\"\"")
                let cell = "\"\(columnName)\""
                return "typeof(\(cell)) AS c\(index)type, CASE WHEN typeof(\(cell)) IN ('blob','text') THEN hex(\(cell)) ELSE quote(\(cell)) END AS c\(index)value"
            }.joined(separator: ",")
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func seedTask() async throws -> String {
        let initial = try host("return {};", optedIn: false)
        try await start(initial); await initial.close()
        let id = "device-kv-guard-task", at = "2026-10-06T12:00:00.000Z"
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks (id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'inbox','[]','[]','[]',?,?,1,'fixture',0,0,0,0)",
                            parametersJSON: json([id, "Synthetic guard task", at, at]))
        return id
    }
    private let guardedCalls = """
    [__mindwtrNative.kvGet('missing'),__mindwtrNative.kvSet('@mindwtr_sync_backend','after'),
     __mindwtrNative.kvRemove('@mindwtr_sync_backend'),__mindwtrNative.kvMultiGet('[]'),
     __mindwtrNative.kvMultiSet('[]'),__mindwtrNative.kvMultiRemove('[]')]
    """

    func testDefaultHasNoKVPortsOrNamespaceActivation() async throws {
        let host = try host("return {ports:names.map(name=>typeof n[name]),network:typeof n.netFetch};", optedIn: false)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["ports"] as? [String], [String](repeating: "undefined", count: 6))
        XCTAssertEqual(result["network"] as? String, "function")
        XCTAssertFalse(FileManager.default.fileExists(atPath: storage.path))
        XCTAssertEqual(state.counts.receipts, 0); XCTAssertEqual(try rows(), before)
    }

    func testSixPortsExactWireAtomicWritesUnicodeBOMAndColdRead() async throws {
        try seed([("unknown", "retained"), ("empty", ""), ("inline-bom", "\u{FEFF}inline"),
                  ("external", NSNull()), ("\u{00E9}", "NFC"), ("e\u{0301}", "NFD")])
        let file = try external("external", bytes: Data("\u{FEFF}\u{FEFF}external 文".utf8)), fileBefore = try Data(contentsOf: file)
        let host = try host("""
        const initial=many(['missing','empty','external','inline-bom','é','e\\u0301','unknown','empty']);
        const a=n.kvSet('@mindwtr_sync_backend','webdav'),b=n.kvMultiSet(JSON.stringify([
          ['@mindwtr_sync_path','first'],['@mindwtr_sync_path','文\\uFEFFlast']]));
        const saved=get('@mindwtr_sync_path'),c=n.kvRemove('@mindwtr_sync_backend'),
          d=n.kvMultiRemove(JSON.stringify(['@mindwtr_sync_path','@mindwtr_sync_path']));
        return {ports:names.map(name=>typeof n[name]),initial,saved,mutations:[a==null,b==null,c==null,d==null],
          absent:get('@mindwtr_sync_backend'),last:get('@mindwtr_sync_path'),unknown:get('unknown')};
        """)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["ports"] as? [String], [String](repeating: "function", count: 6))
        let pairs = try XCTUnwrap(result["initial"] as? [[Any]])
        XCTAssertEqual(pairs.count, 8); XCTAssertEqual(pairs.map { $0[0] as? String }, ["missing", "empty", "external", "inline-bom", "é", "e\u{0301}", "unknown", "empty"])
        XCTAssertTrue(pairs[0][1] is NSNull); XCTAssertEqual(pairs[1][1] as? String, "")
        XCTAssertEqual(Data(try XCTUnwrap(pairs[2][1] as? String).utf8), Data("\u{FEFF}external 文".utf8))
        XCTAssertEqual(Data(try XCTUnwrap(pairs[3][1] as? String).utf8), Data("\u{FEFF}inline".utf8))
        XCTAssertEqual(pairs[4][1] as? String, "NFC"); XCTAssertEqual(pairs[5][1] as? String, "NFD")
        XCTAssertEqual(result["mutations"] as? [Bool], [true, true, true, true])
        XCTAssertEqual(result["saved"] as? [String], ["文\u{FEFF}last"])
        XCTAssertTrue((result["absent"] as? [Any])?.first is NSNull); XCTAssertTrue((result["last"] as? [Any])?.first is NSNull)
        XCTAssertEqual(result["unknown"] as? [String], ["retained"])
        try await receipts(1); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), fileBefore)
        await host.close()
        let cold = try self.host("return {value:get('unknown'),external:get('external'),missing:get('@mindwtr_sync_path')};")
        try await start(cold); let reopened = try await probe(cold)
        XCTAssertEqual(reopened["value"] as? [String], ["retained"])
        XCTAssertEqual(reopened["external"] as? [String], ["\u{FEFF}external 文"])
        XCTAssertTrue((reopened["missing"] as? [Any])?.first is NSNull)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), fileBefore)
    }

    func testMalformedPrimitiveJSONAndDeniedMixedBatchRefuseWithoutMutationOrReceipt() async throws {
        try seed([(backend, "before"), ("unknown", "retained")]); let bytes = try Data(contentsOf: manifest)
        let host = try host("""
        const bad=[n.kvGet(null),n.kvGet(1),n.kvGet(new String('x')),n.kvSet('@mindwtr_sync_backend',false),
          n.kvRemove(undefined),n.kvMultiGet([]),n.kvMultiGet('{'),n.kvMultiGet('{}'),n.kvMultiGet('[1]'),
          n.kvMultiSet('[["@mindwtr_sync_backend","after",0]]'),n.kvMultiSet('[["@mindwtr_sync_backend",null]]'),
          n.kvMultiRemove('[false]')];
        const denied=n.kvMultiSet(JSON.stringify([['@mindwtr_sync_backend','after'],['synthetic-secret-hunter2','credential-fixture']]));
        return {bad,denied};
        """)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["bad"] as? [String], [String](repeating: invalid, count: 12))
        XCTAssertEqual(result["denied"] as? String, invalid)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(state.counts.promotions, 0); XCTAssertEqual(state.counts.receipts, 0)
        let output = try json(result); XCTAssertFalse(output.contains("hunter2")); XCTAssertFalse(output.contains("credential-fixture"))
    }

    func testNamespaceContentionKeepsSecondLibraryValidAndRequiresRecreation() async throws {
        try seed([(backend, "before")])
        let first = try host("return {value:get('@mindwtr_sync_backend')};")
        try await start(first)
        let secondDB = root.appendingPathComponent("second/core.sqlite")
        let second = try host("return {ports:names.map(name=>typeof n[name]),value:n.kvGet('@mindwtr_sync_backend')};", database: secondDB)
        try await start(second); let before = try rows(secondDB), refused = try await probe(second)
        XCTAssertEqual(refused["ports"] as? [String], [String](repeating: "function", count: 6))
        XCTAssertEqual(refused["value"] as? String, unavailable); XCTAssertEqual(state.counts.receipts, 0)
        await first.close(); let stillRefused = try await probe(second)
        XCTAssertEqual(stillRefused["value"] as? String, unavailable); XCTAssertEqual(try rows(secondDB), before)
        await second.close()
        let recreated = try host("return {value:get('@mindwtr_sync_backend')};", database: secondDB)
        try await start(recreated); let reopened = try await probe(recreated)
        XCTAssertEqual(reopened["value"] as? [String], ["before"])
        XCTAssertEqual(try rows(secondDB), before)
    }

    func testCorruptOptionalStoreDoesNotBreakBootOrResetBytes() async throws {
        try seed([(backend, "before")]); let bytes = Data("not-json credential-fixture".utf8); try bytes.write(to: manifest)
        let host = try host("return {ports:names.map(name=>typeof n[name]),values:[n.kvGet('x'),n.kvSet('@mindwtr_sync_backend','after'),n.kvRemove('@mindwtr_sync_backend'),n.kvMultiGet('[]'),n.kvMultiSet('[]'),n.kvMultiRemove('[]')]};")
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["ports"] as? [String], [String](repeating: "function", count: 6))
        XCTAssertEqual(result["values"] as? [String], [String](repeating: unavailable, count: 6))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(state.counts.promotions, 0); XCTAssertEqual(state.counts.receipts, 0)
    }

    func testReplyValueDecodedAndSerializedCapsAreWholeReadOnlyRefusals() async throws {
        let one = String(repeating: "a", count: 1024 * 1024)
        try seed([("one", one), ("oversized", one + "x"), ("escaped", String(repeating: "\0", count: 1024 * 1024))])
        let bytes = try Data(contentsOf: manifest)
        let host = try host("""
        const one=get('one'),seven=many(Array(7).fill('one'));
        return {single:one[0].length,seven:seven.length,
          value:n.kvGet('oversized'),decoded:n.kvMultiGet(JSON.stringify(Array(8).fill('one'))),
          serialized:n.kvMultiGet(JSON.stringify(Array(3).fill('escaped')))};
        """)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["single"] as? Int, 1024 * 1024); XCTAssertEqual(result["seven"] as? Int, 7)
        XCTAssertEqual(result["value"] as? String, unavailable)
        // Keys are returned strings too: eight 1MiB values plus their keys exceed 8MiB.
        XCTAssertEqual(result["decoded"] as? String, unavailable)
        XCTAssertEqual(result["serialized"] as? String, unavailable)
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(state.counts.promotions, 0)
    }

    func testWireFrameKeyEntryAndValueLimitsRefuseBeforeMutation() async throws {
        try seed([(backend, "before")])
        let host = try host("""
        const limit=12*1024*1024,frame=' '.repeat(limit-2)+'[]',max='x'.repeat(1024*1024);
        const result={frame:JSON.parse(checked(n.kvMultiGet(frame))).length,
          tooLarge:n.kvMultiGet(' '+frame),entries:many(Array(64).fill('missing')).length,
          tooMany:n.kvMultiGet(JSON.stringify(Array(65).fill('missing'))),
          key:get('x'.repeat(4096))[0]===null,bigKey:n.kvGet('x'.repeat(4097)),emptyKey:n.kvGet('')};
        checked(n.kvSet('@mindwtr_sync_backend',max));result.maximum=get('@mindwtr_sync_backend')[0].length;
        result.bigValue=n.kvSet('@mindwtr_sync_backend',max+'x');
        result.preserved=get('@mindwtr_sync_backend')[0]===max;return result;
        """)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["frame"] as? Int, 0); XCTAssertEqual(result["entries"] as? Int, 64)
        XCTAssertEqual(result["tooLarge"] as? String, invalid); XCTAssertEqual(result["tooMany"] as? String, invalid)
        XCTAssertEqual(result["key"] as? Bool, true); XCTAssertEqual(result["bigKey"] as? String, invalid)
        XCTAssertEqual(result["emptyKey"] as? String, invalid); XCTAssertEqual(result["maximum"] as? Int, 1024 * 1024)
        XCTAssertEqual(result["bigValue"] as? String, invalid); XCTAssertEqual(result["preserved"] as? Bool, true)
        XCTAssertEqual(state.counts.promotions, 1); XCTAssertEqual(try rows(), before)
    }

    func testWarmLostACKRequiresExactRetryAndColdReadUsesCurrentStoredState() async throws {
        try seed([(backend, "before"), ("unknown", "retained")])
        let faults = faults(), state = self.state!
        faults.configureDeviceStorage = { store in
            store.faults.afterPromotion = {
                state.promotion()
                if state.counts.promotions == 1 { throw HostFailure("credential-fixture hunter2") }
            }
        }
        let host = try host("""
        const first=n.kvSet('@mindwtr_sync_backend','after'),read=n.kvGet('@mindwtr_sync_backend'),
          unrelated=n.kvSet('@mindwtr_sync_path','not-owned');
        const retry=n.kvSet('@mindwtr_sync_backend','after');
        return {first,read,unrelated,retry:retry==null,value:get('@mindwtr_sync_backend'),unknown:get('unknown')};
        """, faults: faults)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["first"] as? String, unavailable); XCTAssertEqual(result["read"] as? String, unavailable)
        XCTAssertEqual(result["unrelated"] as? String, unavailable); XCTAssertEqual(result["retry"] as? Bool, true)
        XCTAssertEqual(result["value"] as? [String], ["after"]); XCTAssertEqual(result["unknown"] as? [String], ["retained"])
        XCTAssertEqual(state.counts.promotions, 1, "Exact retry acknowledges the retained publication without a second promotion")
        XCTAssertFalse(try json(result).contains("hunter2")); XCTAssertEqual(try rows(), before)
        await host.close()
        let cold = try self.host("return {value:get('@mindwtr_sync_backend'),unrelated:get('@mindwtr_sync_path')};")
        try await start(cold); let reopened = try await probe(cold)
        XCTAssertEqual(reopened["value"] as? [String], ["after"])
        XCTAssertTrue((reopened["unrelated"] as? [Any])?.first is NSNull)
        XCTAssertEqual(state.counts.promotions, 1); XCTAssertEqual(try rows(), before)
    }

    func testPrebootRefusesAndMissingReadDeliversOnlyFixedCurrentReceipt() async throws {
        try seed([(backend, "before")]); let bytes = try Data(contentsOf: manifest)
        let preboot = "globalThis.preboot=[__mindwtrNative.kvGet('missing'),__mindwtrNative.kvSet('@mindwtr_sync_backend','credential-fixture')];"
        let host = try host("return {preboot:globalThis.preboot,missing:get('missing')};", beforeBoot: preboot)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["preboot"] as? [String], [unavailable, unavailable])
        XCTAssertTrue((result["missing"] as? [Any])?.first is NSNull)
        try await receipts(1); XCTAssertEqual(state.counts.receipts, 1)
        XCTAssertEqual(state.counts.promotions, 0); XCTAssertEqual(try Data(contentsOf: manifest), bytes)
        XCTAssertEqual(try rows(), before); await host.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-device-storage")); XCTAssertTrue(log.contains("device-storage"))
        XCTAssertTrue(log.contains("delivered")); XCTAssertFalse(log.contains("credential-fixture"))
        XCTAssertFalse(log.contains(backend)); XCTAssertFalse(log.contains(namespace))
    }

    func testAcceptedSynchronousWriteKeepsLibraryAndNamespaceOwnedUntilQueuedClose() async throws {
        try seed([(backend, "before")])
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let faults = faults(), state = self.state!
        faults.configureDeviceStorage = { store in
            store.faults.beforePromotion = { entered.signal(); release.wait() }
            store.faults.afterPromotion = { state.promotion() }
        }
        let host = try host("const result=n.kvSet('@mindwtr_sync_backend','after');return {accepted:result==null};", faults: faults)
        try await start(host); let before = try rows()
        let request = Task { try await self.probe(host) }
        guard entered.wait(timeout: .now() + 5) == .success else {
            XCTFail("Synchronous storage write did not enter the controlled publication boundary")
            release.signal(); _ = try? await request.value; await host.close(); return
        }
        let closing = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut, "Queued close cannot pass an accepted synchronous write")
        let sameLibrary = CoreHost(databaseURL: database, bundleURL: bundle, faults: self.faults())
        addTeardownBlock { await sameLibrary.close() }
        do { _ = try await sameLibrary.start(); XCTFail("Accepted mutation must retain the library lease") } catch { }
        let secondDB = root.appendingPathComponent("held-second/core.sqlite")
        let contender = try self.host("return {value:n.kvGet('@mindwtr_sync_backend')};", database: secondDB)
        try await start(contender); let refused = try await probe(contender)
        XCTAssertEqual(refused["value"] as? String, unavailable, "The namespace lease remains held during the write")
        release.signal(); await closing.value
        // Close may fence the query's later poll, but it cannot undo the native accepted mutation.
        _ = try? await request.value
        XCTAssertEqual(state.counts.promotions, 1); XCTAssertEqual(state.counts.receipts, 0, "Delivery queued behind close is stale")
        XCTAssertEqual(try rows(), before); await contender.close()
        let cold = try self.host("return {value:get('@mindwtr_sync_backend')};")
        try await start(cold); let reopened = try await probe(cold)
        XCTAssertEqual(reopened["value"] as? [String], ["after"]); XCTAssertEqual(try rows(), before)
    }

    func testAllPortsRefuseInsideActualPendingOrdinaryCommand() async throws {
        let id = try await seedTask(); try seed([(backend, "before")]); let bytes = try Data(contentsOf: manifest)
        let instrumentation = """
        const oldComplete=MindwtrHost.complete;
        MindwtrHost.complete=(...args)=>{globalThis.pendingKV=\(guardedCalls);return oldComplete(...args)};
        """
        let host = try host("return {guarded:globalThis.pendingKV};", extra: instrumentation)
        try await start(host)
        _ = try await host.call("complete", argumentsJSON: json([id]))
        let result = try await probe(host)
        XCTAssertEqual(result["guarded"] as? [String], [String](repeating: unavailable, count: 6))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(state.counts.promotions, 0)
        XCTAssertEqual(state.counts.receipts, 0)
        // The synthetic ordinary command is forwarded unchanged, so its own
        // expected Task write remains distinct from the refused KV operations.
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let saved = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT status FROM tasks WHERE id=?", parametersJSON: json([id])).utf8)) as? [[String: Any]])
        XCTAssertEqual(saved.first?["status"] as? String, "done")
    }

    func testAllPortsRefuseWhileRealAttachmentDraftOwnsTheEditor() async throws {
        let id = try await seedTask(); try seed([(backend, "before")]); let bytes = try Data(contentsOf: manifest)
        let instrumentation = """
        const oldLineage=MindwtrHost.attachmentDraftValidateLineage;
        MindwtrHost.attachmentDraftValidateLineage=(...args)=>{globalThis.draftKV=\(guardedCalls);return oldLineage(...args)};
        """
        let host = try host("return {guarded:globalThis.draftKV};", extra: instrumentation)
        try await start(host); let before = try rows()
        let payload = try json(["version": 2, "taskID": id, "attachmentsOwned": true,
                                "attachmentsBase": [], "attachments": [], "title": "Synthetic unsaved title"])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: id, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        let begun = try object(await host.beginAttachmentDraft(expectedSession: snapshot.sessionID, expectedGeneration: 1))
        XCTAssertEqual(begun["status"] as? String, "begun")
        _ = try await host.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
        _ = try await host.discardAttachmentDraft(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(),
                                                                   "sessionID": snapshot.sessionID, "generation": 1]))
        let result = try await probe(host)
        XCTAssertEqual(result["guarded"] as? [String], [String](repeating: unavailable, count: 6))
        XCTAssertEqual(try Data(contentsOf: manifest), bytes); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(state.counts.promotions, 0); XCTAssertEqual(state.counts.receipts, 0)
    }
}
