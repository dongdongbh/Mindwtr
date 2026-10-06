import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// All fixture sessions intercept every URL, including unexpected redirects.
/// No URLProtocol request can fall through to the network.
private final class HTTPFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (HTTPFixtureProtocol) -> Void] = [:]
    private static var unexpected = 0
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ host: String, _ handler: @escaping (HTTPFixtureProtocol) -> Void) {
        lock.lock(); handlers[host] = handler; lock.unlock()
    }
    static func remove(_ host: String) { lock.lock(); handlers.removeValue(forKey: host); lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handlers[request.url?.host ?? ""]
        if handler == nil { Self.unexpected += 1 }
        Self.lock.unlock()
        if let handler { handler(self) }
        else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    }
    override func stopLoading() { }
    func reply(_ bytes: Data = Data(), status: Int = 200, headers: [String: String] = [:], finish: Bool = true) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        if finish { client?.urlProtocolDidFinishLoading(self) }
    }
    func redirect(_ url: URL) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": url.absoluteString])!
        var next = request; next.url = url
        client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
    }
    func upload() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; bytes.append(contentsOf: buffer.prefix(count)) }
        return bytes
    }
}

private final class HTTPFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var held: HTTPFixtureProtocol?
    private var jobs: NativeHTTPJobs?
    func record(_ request: URLRequest) { lock.lock(); requests.append(request); lock.unlock() }
    func hold(_ value: HTTPFixtureProtocol) { lock.lock(); held = value; lock.unlock() }
    func getHeld() -> HTTPFixtureProtocol? { lock.lock(); defer { lock.unlock() }; return held }
    func capture(_ value: NativeHTTPJobs) { lock.lock(); jobs = value; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return requests.count }
    var recorded: [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
    var slots: Int { lock.lock(); let value = jobs; lock.unlock(); return value?.counters.jobs ?? -1 }
}

final class NativeHTTPHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var hostname: String!
    private var base: String { "https://\(hostname!)/" }
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var state: HTTPFixtureState!
    private var unexpectedBefore = 0
    override func setUpWithError() throws {
        unexpectedBefore = HTTPFixtureProtocol.unexpectedCount
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: source)
        let fixture = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/http-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        hostname = "fixture-\(UUID().uuidString.lowercased()).invalid"; state = HTTPFixtureState()
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(HTTPFixtureProtocol.unexpectedCount, unexpectedBefore, "Fixture sessions attempted no unregistered destination")
        if let hostname { HTTPFixtureProtocol.remove(hostname) }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ object: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func literal(_ text: String) throws -> String { try json([text]) + "[0]" }
    private func faults(_ handler: @escaping (HTTPFixtureProtocol) -> Void) -> HostIOFaults {
        let state = self.state!
        HTTPFixtureProtocol.install(hostname) { transport in state.record(transport.request); handler(transport) }
        let result = HostIOFaults(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HTTPFixtureProtocol.self]; result.httpConfiguration = config
        result.configureHTTPJobs = { state.capture($0) }
        return result
    }
    // Temporary production-bundle suffix only. Original cancel remains intact.
    private func probeBundle(_ expression: String) throws -> URL {
        let suffix = """
        ;(() => {
          const oldMenu = MindwtrHost.menuRead, oldPoll = MindwtrHost.poll, replies = new Map(); let next = 1000000000;
          const probe = () => { const id = String(++next);
            Promise.resolve().then(async () => { \(expression) }).then(
              value => replies.set(id, JSON.stringify({ok:true,value})),
              () => replies.set(id, JSON.stringify({ok:false,error:'HTTP probe failed'})));
            return id;
          };
          MindwtrHost.menuRead = (name, params) => name === 'dataSettings' ? probe() : oldMenu(name, params);
          MindwtrHost.attachmentRequest = probe;
          MindwtrHost.poll = id => Number(id) > 1000000000 ? (() => {
            const value = replies.get(id); if (!value) return null; replies.delete(id); return value;
          })() : oldPoll(id);
        })();
        """
        let url = root.appendingPathComponent("probe-\(UUID().uuidString).js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
    private func host(_ expression: String, faults: HostIOFaults) throws -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: try probeBundle(expression), faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func probe(_ host: CoreHost) async throws -> [String: Any] { try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"]))) }
    private func start(_ host: CoreHost) async throws {
        let unexpected = HTTPFixtureProtocol.unexpectedCount, known = state.count
        _ = try await host.start()
        XCTAssertEqual(HTTPFixtureProtocol.unexpectedCount, unexpected, "Startup attempted no unregistered request")
        XCTAssertEqual(state.count, known, "Startup attempted no registered request")
    }
    private func drained() async throws {
        for _ in 0..<500 { if state.slots == 0 { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        XCTFail("HTTP slots did not drain"); XCTAssertEqual(state.slots, 0)
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

    func testActualJSCTextBinaryMethodsStatusesHeadersAndEmptyBodies() async throws {
        let faults = faults { transport in
            let path = transport.request.url!.path
            if path == "/empty" { transport.reply(status: 204, headers: ["Content-Encoding": "gzip", "Content-Length": "100"]) }
            else if path == "/invalid-utf8" { transport.reply(Data([255]), headers: ["Content-Length": "1"]) }
            else { let bytes = transport.upload(); transport.reply(bytes, status: 207, headers: ["Content-Length": String(bytes.count), "ETag": "\"fixed\""]) }
        }
        let expression = """
        const base = \(try literal(base)); const bytes = new Uint8Array(256); for(let i=0;i<256;i++)bytes[i]=i;
        const text = await fetch(base+'echo',{method:'PUT',body:'Grüße 文 😀',headers:{Authorization:'Bearer fixture-secret','If-Match':'"cas"'}});
        const binary = await fetch(base+'echo',{method:'PATCH',body:bytes});
        const methods=[]; for(const method of ['GET','HEAD','POST','PUT','DELETE','PATCH','PROPFIND','MKCOL','MOVE','COPY']) {
          const r=await fetch(base+'echo',{method}); methods.push(r.status);
        }
        const empty=await fetch(base+'empty'); const invalid=await fetch(base+'invalid-utf8');
        let utf8=false; try{await invalid.text()}catch(e){utf8=e.name==='TypeError'}
        return {text:await text.text(),binary:Array.from(new Uint8Array(await binary.arrayBuffer())),methods,
          status:text.status,etag:text.headers.get('etag'),url:text.url,redirected:text.redirected,
          empty:(await empty.arrayBuffer()).byteLength,emptyStatus:empty.status,utf8,raw:Array.from(new Uint8Array(await invalid.arrayBuffer()))};
        """
        let host = try host(expression, faults: faults); try await start(host); XCTAssertEqual(state.count, 0)
        let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["text"] as? String, "Grüße 文 😀"); XCTAssertEqual(result["binary"] as? [Int], Array(0...255))
        XCTAssertEqual(result["methods"] as? [Int], [Int](repeating: 207, count: 10))
        XCTAssertEqual(result["status"] as? Int, 207); XCTAssertEqual(result["etag"] as? String, "\"fixed\"")
        XCTAssertEqual(result["url"] as? String, base + "echo"); XCTAssertEqual(result["redirected"] as? Bool, false)
        XCTAssertEqual(result["empty"] as? Int, 0); XCTAssertEqual(result["emptyStatus"] as? Int, 204)
        XCTAssertEqual(result["utf8"] as? Bool, true); XCTAssertEqual(result["raw"] as? [Int], [255])
        XCTAssertEqual(state.recorded.first?.httpMethod, "PUT")
        XCTAssertEqual(state.recorded.first?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-secret")
        XCTAssertEqual(state.recorded.first?.value(forHTTPHeaderField: "If-Match"), "\"cas\"")
        XCTAssertEqual(state.recorded.first?.value(forHTTPHeaderField: "Accept-Encoding"), "identity")
        XCTAssertEqual(state.recorded.first?.value(forHTTPHeaderField: "Content-Type"), "text/plain;charset=UTF-8")
        try await drained(); XCTAssertEqual(try rows(), before)
        await host.close()
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-http-transport")); XCTAssertFalse(log.contains("fixture-secret")); XCTAssertFalse(log.contains(hostname))
    }

    func testNativeMalformedRefusalStartsNoURLSessionTasks() async throws {
        let faults = faults { $0.reply() }; faults.httpByteLimit = 4
        let expression = """
        const n=__mindwtrNative, base={url:\(try literal(base)),method:'POST',redirect:'follow',headers:[]};
        const bad=[{extra:true},{method:'post'},{method:'TRACE'},{redirect:'bad'},{url:'http://example.invalid/'},
          {url:'https://name:secret@example.invalid/'},{headers:[['X','a\\r\\nb']]},{headers:[['bad name','x']]},
          {headers:[['Host','other']]},{headers:[['Content-Length','0']]},{headers:[['Accept-Encoding','gzip']]},
          {headers:[['X','a'],['x','b']]},{text:'12345'},{text:null},{base64:'Zh=='},{base64:'AAAAAAA='},
          {text:'',base64:''},{method:'GET',text:''},{headers:[['X','a'.repeat(65537)]]}];
        const answers=bad.map(p=>n.netFetch(JSON.stringify({...base,...p})));
        answers.push(n.netFetch(4),n.netFetch('not-json'));
        return {count:answers.length,refused:answers.every(x=>typeof x==='string'&&x.startsWith('!MindwtrNativeError:'))};
        """
        let host = try host(expression, faults: faults); try await start(host)
        let result = try await probe(host); XCTAssertEqual(result["count"] as? Int, 21); XCTAssertEqual(result["refused"] as? Bool, true)
        XCTAssertEqual(state.count, 0); XCTAssertEqual(state.slots, 0)
    }

    func testWholeBodyLimitsLengthAndEncodingFailClosed() async throws {
        let faults = faults { transport in
            switch transport.request.url!.path {
            case "/exact": transport.reply(Data([1,2,3,4]), headers: ["Content-Length": "4"])
            case "/stream": transport.reply(Data([1,2,3,4,5]))
            case "/dishonest": transport.reply(Data([1,2,3,4,5]), headers: ["Content-Length": "1"])
            case "/declared": transport.reply(headers: ["Content-Length": "5"])
            case "/short": transport.reply(Data([1,2]), headers: ["Content-Length": "3"])
            case "/gzip": transport.reply(Data([1]), headers: ["Content-Encoding": "gzip"])
            case "/reset": transport.client?.urlProtocol(transport, didFailWithError: URLError(.networkConnectionLost))
            case "/head": transport.reply(headers: ["Content-Length": "5"])
            case "/no-content": transport.reply(status: 204, headers: ["Content-Length": "5"])
            case "/not-modified": transport.reply(status: 304, headers: ["Content-Length": "5"])
            default: transport.reply(status: 412, headers: ["Content-Length": "0"])
            }
        }; faults.httpByteLimit = 4
        let host = try host("""
        const base=\(try literal(base)); const errors=[],n=__mindwtrNative,body=n.ioBody;let bodyCalls=0;
        n.ioBody=()=>{bodyCalls++;return body()};
        for(const path of ['stream','dishonest','declared','short','gzip','reset']) {
          try{await fetch(base+path);errors.push({message:'SUCCESS'})}
          catch(e){errors.push({name:e.name,message:e.message,code:e.code??null,limit:e.limitBytes??null})}
        }
        const failureBodyCalls=bodyCalls,bodyless=[];
        for(const path of ['head','no-content','not-modified']) {
          const r=await fetch(base+path,{method:path==='head'?'HEAD':'GET'});bodyless.push((await r.arrayBuffer()).byteLength);
        }
        const exact=await fetch(base+'exact'), empty=await fetch(base+'empty');
        n.ioBody=body;
        return {errors,failureBodyCalls,bodyless,bytes:Array.from(new Uint8Array(await exact.arrayBuffer())),status:empty.status,length:(await empty.arrayBuffer()).byteLength};
        """, faults: faults)
        try await start(host); let result = try await probe(host)
        let errors = try XCTUnwrap(result["errors"] as? [[String: Any]])
        XCTAssertEqual(errors.count, 6)
        for (index, error) in errors.enumerated() {
            XCTAssertEqual(error["name"] as? String, "TypeError")
            if index < 3 {
                XCTAssertEqual(error["message"] as? String, "Response exceeds the 4 byte download limit")
                XCTAssertEqual(error["code"] as? String, "response-too-large"); XCTAssertEqual(error["limit"] as? Int, 4)
            } else {
                XCTAssertTrue(error["code"] is NSNull); XCTAssertTrue(error["limit"] is NSNull)
                XCTAssertEqual(error["message"] as? String, index == 4 ? "HTTP response encoding is unsupported" : "Network request failed")
            }
        }
        XCTAssertEqual(result["failureBodyCalls"] as? Int, 0)
        XCTAssertEqual(result["bodyless"] as? [Int], [0,0,0])
        XCTAssertEqual(result["bytes"] as? [Int], [1,2,3,4]); XCTAssertEqual(result["status"] as? Int, 412); XCTAssertEqual(result["length"] as? Int, 0)
        try await drained()
    }

    func testNativeCapReplyIsBodylessAndCancellationClearsItsMarkerBeforeDelivery() async throws {
        for cancelled in [false, true] {
            let entered = expectation(description: "Native cap completion boundary"), release = DispatchSemaphore(value: 0)
            let faults = faults { $0.reply(headers: ["Content-Length": "5"]) }; faults.httpByteLimit = 4
            let jobs = NativeHTTPJobs(registry: NativeAttachmentLocalRequests(), faults: faults)
            defer { jobs.shutdown() }
            jobs.beforeCompletion = { entered.fulfill(); release.wait() }
            let id = try jobs.submit(json(["url": base, "method": "GET", "redirect": "follow", "headers": []]))
            defer { release.signal() }
            await fulfillment(of: [entered], timeout: 5)
            if cancelled { jobs.abort(id) }
            release.signal()
            var answer: (json: String, body: Bool)?
            for _ in 0..<500 {
                answer = try jobs.next(); if answer != nil { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            let reply = try XCTUnwrap(answer), value = try object(reply.json)
            XCTAssertFalse(reply.body); XCTAssertEqual(value["id"] as? String, id)
            if cancelled {
                XCTAssertEqual(Set(value.keys), ["id", "error"])
                XCTAssertEqual(value["error"] as? String, "Request cancelled")
            } else {
                XCTAssertEqual(Set(value.keys), ["id", "error", "errorCode", "limitBytes"])
                XCTAssertEqual(value["errorCode"] as? String, "response-too-large"); XCTAssertEqual(value["limitBytes"] as? Int, 4)
            }
            XCTAssertEqual(jobs.counters.jobs, 0); jobs.shutdown()
        }
    }

    func testAbortPreservesReasonAndLateAnswerDrainsBeforeNextFetch() async throws {
        let faults = faults { transport in
            if transport.request.url!.path == "/hold" { transport.reply(Data([1]), headers: ["Content-Length": "100"], finish: false) }
            else { transport.reply(Data([9]), headers: ["Content-Length": "1"]) }
        }
        let host = try host("""
        const base=\(try literal(base)), c=new AbortController(), reason=new Error('fixture abort');
        const pending=fetch(base+'hold',{signal:c.signal}); setTimeout(()=>c.abort(reason),20);
        let same=false; try{await pending}catch(e){same=e===reason}
        await new Promise(resolve=>setTimeout(resolve,20));
        const next=await fetch(base+'next'); return {same,bytes:Array.from(new Uint8Array(await next.arrayBuffer()))};
        """, faults: faults)
        try await start(host); let result = try await probe(host)
        XCTAssertEqual(result["same"] as? Bool, true); XCTAssertEqual(result["bytes"] as? [Int], [9]); try await drained()
        XCTAssertEqual(state.count, 2)
    }

    func testTrailingNetworkAnswerIsConsumedWithoutAnotherHostCall() async throws {
        let entered = DispatchSemaphore(value: 0)
        let faults = faults { [state] transport in state!.hold(transport); entered.signal() }
        let host = try host("""
        void fetch(\(try literal(base))).then(()=>globalThis.__trailingHTTPDone=true); return {returned:true};
        """, faults: faults)
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["returned"] as? Bool, true)
        XCTAssertEqual(entered.wait(timeout: .now()+5), .success); XCTAssertEqual(state.slots, 1)
        try XCTUnwrap(state.getHeld()).reply(Data([7]), headers: ["Content-Length": "1"])
        try await drained() // No subsequent CoreHost call drives the pump.
    }

    func testCloseAndSwiftCancellationDrainHeldDelegateBeforeUnlock() async throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        let faults = faults { $0.reply(Data([1]), headers: ["Content-Length": "1"]) }
        faults.configureHTTPJobs = { [state] jobs in state!.capture(jobs); jobs.beforeCompletion = { entered.signal(); release.wait() } }
        let host = try host("return await (await fetch(\(try literal(base)))).text();", faults: faults)
        try await start(host)
        let input = try json(["owner": ["kind":"task", "taskId":"http-fixture", "attachments":[]] as [String:Any], "attachmentId":"probe"])
        let request = Task { try await host.localAttachmentRequest(name: "openAttachment", requestJSON: input) }
        XCTAssertEqual(entered.wait(timeout: .now()+5), .success)
        request.cancel(); let closing = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now()+0.05), .timedOut)
        let replacement = CoreHost(databaseURL: database, bundleURL: bundle)
        addTeardownBlock { await replacement.close() }
        do { _ = try await replacement.start(); XCTFail("Held HTTP delegate must retain library lock") } catch { }
        release.signal()
        do { _ = try await request.value; XCTFail("Cancelled caller must refuse") } catch is CancellationError { } catch { XCTFail("Expected caller cancellation") }
        await closing.value; XCTAssertEqual(state.slots, 0)
        _ = try await replacement.start(); await replacement.close()
    }

    func testFileAndNetworkRepliesKeepDistinctIDsAndBodies() async throws {
        let faults = faults { $0.reply(Data([8,9]), headers: ["Content-Length":"2"]) }
        let cache = root.appendingPathComponent("attachment-files/cache/bytes")
        let host = try host("""
        const file=__mindwtrFileCall, uri=\(try literal(cache.absoluteString)), base=\(try literal(base));
        const results=[];
        for(const order of [true,false]) { const net=()=>fetch(base).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)));
          const local=()=>file({op:'readBytes',uri}).then(b=>Array.from(b));
          const pair=order?[net(),local()]:[local(),net()]; results.push(await Promise.all(pair)); }
        let duplicate=false; try{const x=__mindwtrNative.ioBody();duplicate=x.startsWith('!MindwtrNativeError:')}catch(e){duplicate=true}
        return {results,duplicate};
        """, faults: faults)
        try await start(host); try Data([1,2,3]).write(to: cache)
        let result = try await probe(host)
        XCTAssertEqual(result["results"] as? [[[Int]]], [[[8,9],[1,2,3]],[[1,2,3],[8,9]]])
        XCTAssertEqual(result["duplicate"] as? Bool, true); try await drained()
        XCTAssertEqual(try Data(contentsOf: cache), Data([1,2,3]))
    }

    func testTwoRetainedSlotsRefuseThirdAndReleaseAfterBodyDelivery() async throws {
        let faults = faults { $0.reply(Data([6]), headers: ["Content-Length":"1"]) }
        let host = try host("""
        const url=\(try literal(base)), first=fetch(url), second=fetch(url); let capacity=false;
        try{await fetch(url)}catch(e){capacity=e.name==='TypeError'&&e.message==='HTTP bridge is unavailable or at capacity'}
        const pair=await Promise.all([first,second]); const bytes=await Promise.all(pair.map(r=>r.arrayBuffer()));
        const next=await fetch(url); return {capacity,lengths:bytes.map(b=>b.byteLength),next:(await next.arrayBuffer()).byteLength};
        """, faults: faults)
        try await start(host); let result = try await probe(host)
        XCTAssertEqual(result["capacity"] as? Bool, true); XCTAssertEqual(result["lengths"] as? [Int], [1,1])
        XCTAssertEqual(result["next"] as? Int, 1); XCTAssertEqual(state.count, 3); try await drained()
    }

    func testCloseTrailingHeldCompletionRetainsLockUntilDelegateDrains() async throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        let faults = faults { $0.reply(Data([1]), headers: ["Content-Length":"1"]) }
        faults.configureHTTPJobs = { [state] jobs in state!.capture(jobs); jobs.beforeCompletion = { entered.signal(); release.wait() } }
        let host = try host("void fetch(\(try literal(base))).catch(()=>{}); return {returned:true};", faults: faults)
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["returned"] as? Bool, true)
        XCTAssertEqual(entered.wait(timeout: .now()+5), .success)
        let closing = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now()+0.05), .timedOut)
        let replacement = CoreHost(databaseURL: database, bundleURL: bundle)
        addTeardownBlock { await replacement.close() }
        do { _ = try await replacement.start(); XCTFail("Incomplete registered callback must retain library lock") } catch { }
        release.signal(); await closing.value; XCTAssertEqual(state.slots, 0)
        _ = try await replacement.start(); await replacement.close()
    }

    func testHTTPWorksWithoutOptionalFilesAndDoesNotEnableSyncOrMutateRows() async throws {
        try Data([1]).write(to: root.appendingPathComponent("attachment-files"))
        let faults = faults { $0.reply(Data([4]), headers: ["Content-Length":"1"]) }
        let host = try host("""
        const n=__mindwtrNative, r=await fetch(\(try literal(base)));
        return {bytes:Array.from(new Uint8Array(await r.arrayBuffer())),file:typeof n.fileCall,kv:typeof n.kvMultiGet};
        """, faults: faults)
        try await start(host); XCTAssertEqual(state.count, 0); let before = try rows()
        let result = try await probe(host); XCTAssertEqual(result["bytes"] as? [Int], [4])
        XCTAssertEqual(result["file"] as? String, "undefined"); XCTAssertEqual(result["kv"] as? String, "undefined")
        do { _ = try await host.call("syncSettings"); XCTFail("Sync must remain unavailable") } catch { }
        try await drained(); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("attachment-files")), Data([1]))
    }

    func testRealLoopbackWireCompletionDamageRedirectEncodingAndTimeout() async throws {
        guard let raw = ProcessInfo.processInfo.environment["MINDWTR_HTTP_FIXTURE_URL"], let url = URL(string: raw) else { throw XCTSkip("Root-controlled loopback HTTP fixture required") }
        let faults = HostIOFaults(); faults.httpLoopbackOrigin = url; faults.httpTimeout = 0.3
        faults.configureHTTPJobs = { [state] in state!.capture($0) }
        let host = try host("""
        const base=\(try literal(raw)); const a=await fetch(base+'/bytes'), empty=await fetch(base+'/empty');
        const errors=[]; for(const path of ['short','reset','stall','gzip','cross']) {try{await fetch(base+'/'+path);errors.push('SUCCESS')}catch(e){errors.push(e.message)}}
        const manual=await fetch(base+'/redirect',{redirect:'manual'}), followed=await fetch(base+'/redirect');
        let refused=false;try{await fetch(base+'/redirect',{redirect:'error'})}catch(e){refused=e.message==='fetch failed: unexpected redirect'}
        let loopRefused=false;try{await fetch(base+'/loop')}catch(e){loopRefused=e.message==='fetch failed: unexpected redirect'}
        const payload=new Uint8Array([0,255,128,1,10,13,42]);
        const echoed=await fetch(base+'/redirect307',{method:'PUT',body:payload,
          headers:{Authorization:'Bearer fixture-redirect-secret','If-Match':'"fixture-cas"'}});
        return {bytes:Array.from(new Uint8Array(await a.arrayBuffer())),empty:(await empty.arrayBuffer()).byteLength,errors,
          manual:manual.status,manualRedirected:manual.redirected,followed:followed.url,redirected:followed.redirected,refused,loopRefused,
          echo:await echoed.json(),echoURL:echoed.url,echoRedirected:echoed.redirected};
        """, faults: faults)
        try await start(host); let before = try rows(), result = try await probe(host)
        XCTAssertEqual(result["bytes"] as? [Int], Array(0...255)); XCTAssertEqual(result["empty"] as? Int, 0)
        XCTAssertEqual(result["errors"] as? [String], ["Network request failed", "Network request failed", "Network request failed: request timed out", "HTTP response encoding is unsupported", "fetch failed: unexpected redirect"])
        XCTAssertEqual(result["manual"] as? Int, 302); XCTAssertEqual(result["manualRedirected"] as? Bool, false)
        XCTAssertEqual(result["followed"] as? String, raw+"/bytes"); XCTAssertEqual(result["redirected"] as? Bool, true); XCTAssertEqual(result["refused"] as? Bool, true)
        XCTAssertEqual(result["loopRefused"] as? Bool, true)
        let echo = try XCTUnwrap(result["echo"] as? [String: Any])
        XCTAssertEqual(echo["method"] as? String, "PUT")
        XCTAssertEqual(echo["bodyBase64"] as? String, Data([0,255,128,1,10,13,42]).base64EncodedString())
        XCTAssertEqual(echo["authorization"] as? String, "Bearer fixture-redirect-secret")
        XCTAssertEqual(echo["ifMatch"] as? String, "\"fixture-cas\"")
        XCTAssertEqual(result["echoURL"] as? String, raw+"/echo"); XCTAssertEqual(result["echoRedirected"] as? Bool, true)
        try await drained(); XCTAssertEqual(try rows(), before)
    }

    func testRealDefaultTLSRejectsSelfSignedWithoutTrustOverride() async throws {
        guard let raw = ProcessInfo.processInfo.environment["MINDWTR_HTTP_TLS_FIXTURE_URL"] else { throw XCTSkip("Root-controlled self-signed TLS fixture required") }
        let faults = HostIOFaults(); faults.httpTimeout = 1
        let host = try host("""
        let refused=false;try{await fetch(\(try literal(raw+"/bytes")))}catch(e){refused=e.name==='TypeError'&&e.message==='Network request failed'}
        return {refused};
        """, faults: faults)
        try await start(host); let result = try await probe(host); XCTAssertEqual(result["refused"] as? Bool, true)
    }
}
