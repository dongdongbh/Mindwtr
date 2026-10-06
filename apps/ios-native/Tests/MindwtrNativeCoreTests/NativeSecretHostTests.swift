import XCTest
import Foundation
import Security
import Darwin
@testable import MindwtrNativeCore

private final class SecretFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var jobs: NativeSecretJobs?
    private var events: [String] = []
    func capture(_ value: NativeSecretJobs) { lock.lock(); jobs = value; lock.unlock() }
    func record(_ operation: String, _ alias: String) { lock.lock(); events.append(operation + ":" + alias); lock.unlock() }
    var recorded: [String] { lock.lock(); defer { lock.unlock() }; return events }
    var slots: Int { lock.lock(); let value = jobs; lock.unlock(); return value?.counters.jobs ?? -1 }
}

/// No fixture request is allowed to fall through to a real endpoint.
private final class SecretHTTPFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var calls = 0
    static var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.calls += 1; Self.lock.unlock()
        guard request.url?.host == "secret-fixture.invalid" else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length":"2"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([8,9])); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

final class NativeSecretHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, service: String!, state: SecretFixtureState!
    private let accounts = ["fixture", "other", "legacy", "auth", "after", "unlocked", "default", "invalid", "oversize"]
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    override func setUpWithError() throws {
        #if os(iOS)
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] ?? Bundle.main.url(forResource:"core-host",withExtension:"js")?.path else { throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: source)
        let fixture = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("NativeSecretTests/secrets-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased(); state = SecretFixtureState()
        #else
        throw XCTSkip("Requires an entitled iOS app host; macOS uses a different Keychain implementation")
        #endif
    }
    override func tearDownWithError() throws {
        // Exact synthetic account/alias ownership only: never enumerate a service.
        if service != nil {
            for account in accounts { for alias in ["no-auth", "auth", "legacy"] {
                let result = SecItemDelete(query(account, alias: alias) as CFDictionary)
                XCTAssertTrue(result == errSecSuccess || result == errSecItemNotFound, "Owned fixture cleanup failed")
            } }
        }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func literal(_ value: String) throws -> String { try json([value]) + "[0]" }
    private func query(_ account: String, alias: String = "no-auth") -> [String: Any] {
        let bytes = Data(account.utf8)
        return [kSecClass as String:kSecClassGenericPassword,
                kSecAttrService as String:alias == "legacy" ? service! : service! + ":" + alias,
                kSecAttrAccount as String:bytes, kSecAttrGeneric as String:bytes,
                kSecUseAuthenticationUI as String:kSecUseAuthenticationUIFail]
    }
    private func seed(_ account: String, bytes: Data, alias: String = "no-auth", accessibility: CFString = kSecAttrAccessibleWhenUnlockedThisDeviceOnly) throws {
        XCTAssertTrue(accounts.contains(account))
        var input = query(account, alias: alias); input[kSecValueData as String] = bytes; input[kSecAttrAccessible as String] = accessibility
        XCTAssertEqual(SecItemAdd(input as CFDictionary, nil), errSecSuccess)
    }
    private func stored(_ account: String, alias: String = "no-auth") throws -> Data? {
        var input = query(account, alias: alias); input[kSecReturnData as String] = true; input[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?; let result = SecItemCopyMatching(input as CFDictionary, &value)
        if result == errSecItemNotFound { return nil }
        XCTAssertEqual(result, errSecSuccess); return try XCTUnwrap(value as? Data)
    }
    private func accessibility(_ account: String) throws -> String {
        var input = query(account); input[kSecReturnAttributes as String] = true; input[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(input as CFDictionary, &value), errSecSuccess)
        let attrs = try XCTUnwrap(value as? [String:Any])
        XCTAssertEqual(attrs[kSecAttrGeneric as String] as? Data, Data(account.utf8))
        XCTAssertEqual(attrs[kSecAttrAccount as String] as? Data, Data(account.utf8))
        return try XCTUnwrap(attrs[kSecAttrAccessible as String] as? String)
    }
    private func faults() -> HostIOFaults {
        let value = HostIOFaults(), state = self.state!
        value.secretService = service; value.configureSecretJobs = { state.capture($0) }
        value.secretBeforeOperation = { state.record($0, $1) }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SecretHTTPFixtureProtocol.self]; value.httpConfiguration = config
        return value
    }
    // Temporary actual production-bundle suffix, reusing existing entry points.
    // Original cancellation remains active; no evaluator/test API ships.
    private func probeBundle(_ expression: String) throws -> URL {
        let suffix = """
        ;(() => {
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000;
          const probe=()=>{const id=String(++next);Promise.resolve().then(async()=>{\(expression)}).then(
            value=>replies.set(id,JSON.stringify({ok:true,value})),
            ()=>replies.set(id,JSON.stringify({ok:false,error:'Secure storage probe failed'})));return id;};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.attachmentRequest=probe;
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value;})():oldPoll(id);
        })();
        """
        let url = root.appendingPathComponent("probe-\(UUID().uuidString).js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
    private func host(_ expression: String, faults: HostIOFaults) throws -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: try probeBundle(expression), faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ host: CoreHost) async throws {
        let before = state.recorded.count, network = SecretHTTPFixtureProtocol.count
        _ = try await host.start()
        XCTAssertEqual(state.recorded.count, before, "Startup performs no Security operation")
        XCTAssertEqual(SecretHTTPFixtureProtocol.count, network, "Startup performs no network operation")
    }
    private func probe(_ host: CoreHost) async throws -> [String:Any] { try object(await host.call("menuRead", argumentsJSON: json(["dataSettings","{}"]))) }
    private func drained() async throws {
        for _ in 0..<500 { if state.slots == 0 { return }; try await Task.sleep(nanoseconds:10_000_000) }
        XCTFail("Secret slots did not drain"); XCTAssertEqual(state.slots, 0)
    }

    func testActualSecurityJSCSetGetRecreateDeleteEmptyAndAccessibility() async throws {
        let host = try host("""
        const s=__mindwtrSecrets;await s.setSecret('fixture','Grüße 文 😀');await s.setSecret('after','a','after-first-unlock');
        await s.setSecret('unlocked','u','when-unlocked');await s.setSecret('default','');
        await s.setSecret('after','changed','when-unlocked');
        return {value:await s.getSecret('fixture'),empty:await s.getSecret('default'),missing:await s.getSecret('other'),kv:typeof __mindwtrNative.kvMultiGet};
        """, faults:faults())
        try await start(host); let result = try await probe(host)
        XCTAssertEqual(result["value"] as? String, "Grüße 文 😀"); XCTAssertEqual(result["empty"] as? String, "")
        XCTAssertTrue(result["missing"] is NSNull); XCTAssertEqual(result["kv"] as? String, "undefined")
        XCTAssertEqual(try accessibility("after"), kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(try accessibility("unlocked"), kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(try accessibility("default"), kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        await host.close()
        let recreated = try self.host("""
        const s=__mindwtrSecrets,value=await s.getSecret('fixture');await s.deleteSecret('fixture');
        return {value,gone:await s.getSecret('fixture'),after:await s.getSecret('after')};
        """, faults:faults())
        try await start(recreated); let cold = try await probe(recreated)
        XCTAssertEqual(cold["value"] as? String, "Grüße 文 😀"); XCTAssertTrue(cold["gone"] is NSNull)
        XCTAssertEqual(cold["after"] as? String, "changed"); try await drained(); await recreated.close()
        let log = try String(contentsOf:root.appendingPathComponent("logs/mindwtr.log"),encoding:.utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-secure-storage")); XCTAssertFalse(log.contains("Grüße")); XCTAssertFalse(log.contains(service))
    }

    func testExpoByteQueriesReadPrecedenceLegacyAndSelectedThreeAliasDelete() async throws {
        try seed("fixture",bytes:Data("first".utf8)); try seed("fixture",bytes:Data("second".utf8),alias:"auth")
        try seed("fixture",bytes:Data("third".utf8),alias:"legacy"); try seed("other",bytes:Data("untouched".utf8))
        try seed("auth",bytes:Data("auth-only".utf8),alias:"auth"); try seed("legacy",bytes:Data("legacy-only".utf8),alias:"legacy")
        let host = try host("""
        const s=__mindwtrSecrets,first=await s.getSecret('fixture'),auth=await s.getSecret('auth'),legacy=await s.getSecret('legacy');
        await s.deleteSecret('fixture');return {first,auth,legacy,gone:await s.getSecret('fixture')};
        """, faults:faults())
        try await start(host); let result = try await probe(host)
        XCTAssertEqual(result["first"] as? String,"first"); XCTAssertEqual(result["auth"] as? String,"auth-only")
        XCTAssertEqual(result["legacy"] as? String,"legacy-only"); XCTAssertTrue(result["gone"] is NSNull)
        for alias in ["no-auth","auth","legacy"] { XCTAssertNil(try stored("fixture",alias:alias)) }
        XCTAssertEqual(try stored("other"),Data("untouched".utf8)); XCTAssertNil(try stored("legacy"))
        XCTAssertEqual(try stored("legacy",alias:"legacy"),Data("legacy-only".utf8))
        XCTAssertTrue(state.recorded.contains("get:auth")); XCTAssertTrue(state.recorded.contains("get:legacy"))
    }

    func testNewWriteDoesNotMigrateOtherAliasesOrAccount() async throws {
        try seed("fixture",bytes:Data("old-auth".utf8),alias:"auth"); try seed("fixture",bytes:Data("old-legacy".utf8),alias:"legacy")
        try seed("other",bytes:Data("other".utf8))
        let host = try host("await __mindwtrSecrets.setSecret('fixture','new');return {value:await __mindwtrSecrets.getSecret('fixture')};",faults:faults())
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["value"] as? String,"new")
        XCTAssertEqual(try stored("fixture",alias:"auth"),Data("old-auth".utf8))
        XCTAssertEqual(try stored("fixture",alias:"legacy"),Data("old-legacy".utf8)); XCTAssertEqual(try stored("other"),Data("other".utf8))
        XCTAssertFalse(state.recorded.contains(where:{$0.hasPrefix("delete:")}))
    }

    func testInaccessibleUnavailableAndDecodeErrorsNeverFallThroughOrBecomeMissing() async throws {
        try seed("fixture",bytes:Data("fallback-must-not-read".utf8),alias:"legacy")
        for (status,message) in [(errSecInteractionNotAllowed,"Secure storage access is denied"),
                                 (errSecAuthFailed,"Secure storage access is denied"),
                                 (errSecNotAvailable,"Secure storage is unavailable"),
                                 (errSecDecode,"Secure storage data is invalid")] {
            let faults = faults(); faults.secretStatus = { operation,alias in operation == "get" && alias == "no-auth" ? status : nil }
            let host = try host("let error='SUCCESS';try{await __mindwtrSecrets.getSecret('fixture')}catch(e){error=e.message}return {error};",faults:faults)
            try await start(host); let before = state.recorded.count; let result = try await probe(host)
            XCTAssertEqual(result["error"] as? String,message); XCTAssertEqual(Array(state.recorded.dropFirst(before)),["get:no-auth"])
            XCTAssertEqual(try stored("fixture",alias:"legacy"),Data("fallback-must-not-read".utf8)); await host.close()
        }
    }

    func testPartialDeleteRejectsChecksAllAliasesAndPreservesOtherAccount() async throws {
        for alias in ["no-auth","auth","legacy"] { try seed("fixture",bytes:Data(alias.utf8),alias:alias) }
        try seed("other",bytes:Data("untouched".utf8))
        let faults = faults(); faults.secretStatus = { operation,alias in operation == "delete" && alias == "auth" ? errSecInteractionNotAllowed : nil }
        let host = try host("let error='SUCCESS';try{await __mindwtrSecrets.deleteSecret('fixture')}catch(e){error=e.message}return {error};",faults:faults)
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["error"] as? String,"Secure storage access is denied")
        XCTAssertEqual(state.recorded,["delete:legacy","delete:auth","delete:no-auth"])
        XCTAssertNil(try stored("fixture")); XCTAssertNil(try stored("fixture",alias:"legacy"))
        XCTAssertEqual(try stored("fixture",alias:"auth"),Data("auth".utf8)); XCTAssertEqual(try stored("other"),Data("untouched".utf8))
        await host.close()
        let retry = try self.host("await __mindwtrSecrets.deleteSecret('fixture');return {gone:await __mindwtrSecrets.getSecret('fixture')};",faults:self.faults())
        try await start(retry); let retried = try await probe(retry); XCTAssertTrue(retried["gone"] is NSNull)
    }

    func testMalformedWireRefusesBeforeAnySecurityOperation() async throws {
        let host = try host("""
        const n=__mindwtrNative,base={op:'set',key:'fixture',value:'synthetic'};
        const bad=[{op:'bad'},{op:null},{key:''},{key:'a/b'},{key:'文'},{key:'a'.repeat(256)},
          {value:null},{value:4},{value:'a'.repeat(65537)},{value:'😀'.repeat(16385)},
          {accessibility:null},{accessibility:'always'},{extra:true},{op:'get'},{op:'delete'}];
        const answers=bad.map(x=>n.secretCall(JSON.stringify({...base,...x})));
        answers.push(n.secretCall(4),n.secretCall('not-json'),n.secretCall(JSON.stringify({op:'get',key:'fixture',accessibility:'when-unlocked'})),
          n.secretCall(JSON.stringify({op:'delete',key:'fixture',value:null})),n.secretCall(' '.repeat(524289)));
        return {count:answers.length,refused:answers.every(x=>typeof x==='string'&&x.startsWith('!MindwtrNativeError:'))};
        """,faults:faults())
        try await start(host); let result = try await probe(host)
        XCTAssertEqual(result["count"] as? Int,20); XCTAssertEqual(result["refused"] as? Bool,true)
        XCTAssertEqual(state.recorded,[]); XCTAssertEqual(state.slots,0); XCTAssertNil(try stored("fixture"))
    }

    func testMalformedStoredUTF8AndOversizeReadRejectWithoutMutation() async throws {
        try seed("invalid",bytes:Data([255])); try seed("oversize",bytes:Data(repeating:65,count:65537))
        let host = try host("""
        const errors=[];for(const account of ['invalid','oversize']){try{await __mindwtrSecrets.getSecret(account);errors.push('SUCCESS')}catch(e){errors.push(e.message)}}return {errors};
        """,faults:faults())
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["errors"] as? [String],["Secure storage data is invalid","Secure storage data is invalid"])
        XCTAssertEqual(try stored("invalid"),Data([255])); XCTAssertEqual(try stored("oversize"),Data(repeating:65,count:65537))
    }

    func testTwoRetainedSlotsAndTrailingIdleDelivery() async throws {
        let host = try host("""
        const s=__mindwtrSecrets,one=s.setSecret('fixture','one'),two=s.setSecret('other','two');let capacity=false;
        try{await s.getSecret('after')}catch(e){capacity=e.name==='TypeError'&&e.message==='Secure storage bridge is unavailable or at capacity'}
        await Promise.all([one,two]);void s.setSecret('after','trailing');return {capacity};
        """,faults:faults())
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["capacity"] as? Bool,true)
        try await drained() // No subsequent host call settles the trailing operation.
        XCTAssertEqual(try stored("after"),Data("trailing".utf8))
    }

    func testCancelledCallerAwaitsFourSequentialFinallyWrites() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0)
        let faults=faults(),state=self.state!
        faults.secretBeforeOperation={ operation,alias in state.record(operation,alias);if operation == "set" && state.recorded.count == 1 { entered.signal();release.wait() } }
        let host=try host("""
        try{await __mindwtrSecrets.setSecret('fixture','started')}finally{
          let refused=false;try{await __mindwtrSecrets.getSecret('fixture')}catch(e){refused=e.name==='AbortError'}
          if(!refused)throw new Error('Normal cancelled facade did not refuse');
          for(let i=0;i<4;i++)await __mindwtrSyncSecrets.setSecret('after','finally-'+i,'after-first-unlock');
          globalThis.__fourFinallyDone=refused;
        }return {done:globalThis.__fourFinallyDone};
        """,faults:faults)
        try await start(host)
        let input=try json(["owner":["kind":"task","taskId":"secret-fixture","attachments":[]] as [String:Any],"attachmentId":"probe"])
        let request=Task{try await host.localAttachmentRequest(name:"openAttachment",requestJSON:input)}
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success);request.cancel()
        // Give the Engine a turn to observe caller cancellation before release.
        try await Task.sleep(nanoseconds:50_000_000);release.signal()
        do{_=try await request.value;XCTFail("Cancelled caller must refuse")}catch is CancellationError{}catch{XCTFail("Expected cancellation")}
        try await drained();XCTAssertEqual(try stored("fixture"),Data("started".utf8));XCTAssertEqual(try stored("after"),Data("finally-3".utf8))
        XCTAssertEqual(state.recorded.filter{$0=="set:no-auth"}.count,5)
        XCTAssertEqual(try accessibility("after"),kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testCloseStartedWriteDrainsBeforeUnlockAndRefusesQueuedAndLateFinally() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),closed=DispatchSemaphore(value:0)
        let faults=faults(),state=self.state!
        faults.secretBeforeOperation={ operation,alias in state.record(operation,alias);if operation == "set" && state.recorded.count == 1 { entered.signal();release.wait() } }
        let host=try host("""
        const first=__mindwtrSecrets.setSecret('fixture','owned'),queued=__mindwtrSecrets.setSecret('other','must-not-write');
        const results=await Promise.allSettled([first,queued]);let late=false;
        try{await __mindwtrSyncSecrets.setSecret('after','late')}catch(e){late=e.name==='TypeError'}
        return {statuses:results.map(x=>x.status),late};
        """,faults:faults)
        try await start(host);let request=Task{try await self.probe(host)}
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success)
        let closing=Task{await host.close();closed.signal()}
        XCTAssertEqual(closed.wait(timeout:.now()+0.05),.timedOut)
        let replacement=CoreHost(databaseURL:database,bundleURL:bundle,faults:self.faults());addTeardownBlock{await replacement.close()}
        do{_=try await replacement.start();XCTFail("Started SecItem work must retain the library lock")}catch{}
        release.signal();let result=try await request.value;await closing.value
        XCTAssertEqual(result["statuses"] as? [String],["fulfilled","rejected"]);XCTAssertEqual(result["late"] as? Bool,true)
        XCTAssertEqual(try stored("fixture"),Data("owned".utf8));XCTAssertNil(try stored("other"));XCTAssertNil(try stored("after"));XCTAssertEqual(state.slots,0)
        _=try await replacement.start();await replacement.close()
    }

    func testFileHTTPAndSecretRepliesKeepIDsAndBodyOwnership() async throws {
        let cache=root.appendingPathComponent("attachment-files/cache/bytes")
        let host=try host("""
        const uri=\(try literal(cache.absoluteString)),s=__mindwtrSecrets;await s.setSecret('fixture','synthetic');
        const results=[];for(const order of [true,false]){
          const file=()=>__mindwtrFileCall({op:'readBytes',uri}).then(b=>Array.from(b));
          const net=()=>fetch('https://secret-fixture.invalid/bytes').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)));
          const secret=()=>s.getSecret('fixture');results.push(await Promise.all(order?[file(),net(),secret()]:[secret(),net(),file()]));
        }let bodyRefused=false;try{bodyRefused=__mindwtrNative.ioBody().startsWith('!MindwtrNativeError:')}catch(e){bodyRefused=true}
        return {results,bodyRefused,kv:typeof __mindwtrNative.kvMultiGet};
        """,faults:faults())
        try await start(host);try Data([1,2,3]).write(to:cache);let before=try rows();let network=SecretHTTPFixtureProtocol.count
        let result=try await probe(host),values=try XCTUnwrap(result["results"] as? [[Any]])
        XCTAssertEqual(values.count,2);XCTAssertEqual(values[0][0] as? [Int],[1,2,3]);XCTAssertEqual(values[0][1] as? [Int],[8,9]);XCTAssertEqual(values[0][2] as? String,"synthetic")
        XCTAssertEqual(values[1][0] as? String,"synthetic");XCTAssertEqual(values[1][1] as? [Int],[8,9]);XCTAssertEqual(values[1][2] as? [Int],[1,2,3])
        XCTAssertEqual(result["bodyRefused"] as? Bool,true);XCTAssertEqual(result["kv"] as? String,"undefined")
        XCTAssertEqual(SecretHTTPFixtureProtocol.count-network,2);try await drained();XCTAssertEqual(try rows(),before);XCTAssertEqual(try Data(contentsOf:cache),Data([1,2,3]))
        XCTAssertFalse(FileManager.default.fileExists(atPath:database.appendingPathExtension("pending.json").path))
    }

    func testTrailingStartedOperationHoldsLibraryLockThroughShutdown() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),closed=DispatchSemaphore(value:0)
        let faults=faults()
        faults.secretAfterOperation={ operation,_ in if operation == "set" { entered.signal();release.wait() } }
        let host=try host("void __mindwtrSecrets.setSecret('fixture','trailing-owned').catch(()=>{});return {returned:true};",faults:faults)
        try await start(host);let result=try await probe(host);XCTAssertEqual(result["returned"] as? Bool,true)
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success);XCTAssertEqual(state.slots,1)
        let closing=Task{await host.close();closed.signal()}
        XCTAssertEqual(closed.wait(timeout:.now()+0.05),.timedOut)
        let replacement=CoreHost(databaseURL:database,bundleURL:bundle,faults:self.faults());addTeardownBlock{await replacement.close()}
        do{_=try await replacement.start();XCTFail("Trailing SecItem work must drain before unlock")}catch{}
        release.signal();await closing.value;XCTAssertEqual(state.slots,0)
        XCTAssertEqual(try stored("fixture"),Data("trailing-owned".utf8))
        _=try await replacement.start();await replacement.close()
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let names = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for row in names { let name = try XCTUnwrap(row["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            // SQLiteBridge intentionally refuses BLOB JSON cells. Capture every
            // table (including FTS shadow BLOBs), with type and exact byte hex
            // for both text/BLOB; scalar quote preserves NULL/integer/real.
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

}
