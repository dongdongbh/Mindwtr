import XCTest
import Foundation
import Security
import CryptoKit
import Darwin
@testable import MindwtrNativeCore

private final class CryptoFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var jobs: NativeCryptoJobs?
    private var events: [String] = []
    private var receipts = 0
    func capture(_ value: NativeCryptoJobs) { lock.lock(); jobs = value; lock.unlock() }
    func record(_ operation: String) { lock.lock(); events.append(operation); lock.unlock() }
    func receipt() { lock.lock(); receipts += 1; lock.unlock() }
    var recorded: [String] { lock.lock(); defer { lock.unlock() }; return events }
    var delivered: Int { lock.lock(); defer { lock.unlock() }; return receipts }
    var slots: Int { lock.lock(); let value = jobs; lock.unlock(); return value?.counters.jobs ?? -1 }
    var retainedBytes: Int { lock.lock(); let value = jobs; lock.unlock(); return value?.counters.bytes ?? -1 }
    var unfinished: Int { lock.lock(); let value = jobs; lock.unlock(); return value?.counters.running ?? -1 }
}

private final class CryptoHTTPFixtureProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var requests = 0, unexpected = 0
    static var counts: (Int,Int) { lock.lock(); defer { lock.unlock() }; return (requests,unexpected) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let known = request.url?.host == "crypto-fixture.invalid"
        Self.lock.lock(); Self.requests += 1; if !known { Self.unexpected += 1 }; Self.lock.unlock()
        guard known else { client?.urlProtocol(self,didFailWithError:URLError(.cannotConnectToHost));return }
        let response=HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Length":"2"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data([8,9]));client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

final class NativeCryptoHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, state: CryptoFixtureState!
    private var unexpectedBefore = 0
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    override func setUpWithError() throws {
        guard let source=ProcessInfo.processInfo.environment["MINDWTR_CRYPTO_TEST_BUNDLE"]
            ?? ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource:"core-host",withExtension:"js")?.path else {
            throw XCTSkip("Build crypto-test-host.js and set MINDWTR_CRYPTO_TEST_BUNDLE")
        }
        bundle=URL(fileURLWithPath:source)
        let base=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
        let fixture=base.appendingPathComponent("NativeCryptoTests/crypto-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:fixture,withIntermediateDirectories:true)
        guard let physical=Darwin.realpath(fixture.path,nil) else { throw HostFailure("Crypto fixture root unavailable") }
        defer{free(physical)};root=URL(fileURLWithPath:String(cString:physical),isDirectory:true)
        state=CryptoFixtureState();unexpectedBefore=CryptoHTTPFixtureProtocol.counts.1
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.1,unexpectedBefore,"Fixture requests cannot reach an unregistered destination")
        if let root { try FileManager.default.removeItem(at:root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),as:UTF8.self) }
    private func object(_ value: String) throws -> [String:Any] { try XCTUnwrap(NativeJSON.jsonObject(with:Data(value.utf8)) as? [String:Any]) }
    private func literal(_ value: String) throws -> String { try json([value])+"[0]" }
    private func faults() -> HostIOFaults {
        let value=HostIOFaults(),state=self.state!
        value.configureCryptoJobs={state.capture($0)};value.cryptoBeforeOperation={state.record($0)}
        value.commandDiagnostic={if $0 == "cryptoDelivered"{state.receipt()}}
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[CryptoHTTPFixtureProtocol.self];value.httpConfiguration=config
        // Only the mixed-pump test asks for a synthetic secret read. These
        // injected not-found statuses never call Security on any platform.
        value.secretService="mindwtr.native-keychain.fixture."+UUID().uuidString.lowercased()
        value.secretStatus={_,_ in errSecItemNotFound}
        return value
    }
    private let helpers = """
    const g=globalThis.cryptoGate;
    if(!g||!g.prims||typeof g.deriveSyncKeyMaterial!=='function'||typeof g.encryptSyncArtifact!=='function'
      ||!g.primitiveVectors||g.primitiveVectors.argon2id.length!==8||g.primitiveVectors.aesGcm.length!==7||g.vectors.length!==5)
      throw new Error('Crypto fixture gate is unavailable');
    const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    const unhex=text=>new Uint8Array((text.match(/../g)||[]).map(x=>parseInt(x,16)));
    const un64=text=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out=[];let value=0,bits=0;
      for(const c of text){if(c==='=')break;value=(value<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;out.push((value>>bits)&255)}}return new Uint8Array(out)};
    """
    private func probeBundle(_ expression: String) throws -> URL {
        let suffix="""
        ;(()=>{const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000;
          const probe=()=>{const id=String(++next);Promise.resolve().then(async()=>{\(helpers)\n\(expression)}).then(
            value=>replies.set(id,JSON.stringify({ok:true,value})),
            error=>replies.set(id,JSON.stringify({ok:false,error:error&&error.message==='Crypto fixture gate is unavailable'?'Crypto fixture gate is unavailable':'Crypto probe failed'})));return id};
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe():oldMenu(name,params);
          MindwtrHost.attachmentRequest=probe;
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value})():oldPoll(id);
        })();
        """
        let url=root.appendingPathComponent("probe-\(UUID().uuidString).js")
        try (String(contentsOf:bundle,encoding:.utf8)+suffix).write(to:url,atomically:true,encoding:.utf8);return url
    }
    private func host(_ expression: String, faults: HostIOFaults) throws -> CoreHost {
        let value=CoreHost(databaseURL:database,bundleURL:try probeBundle(expression),faults:faults)
        addTeardownBlock{await value.close()};return value
    }
    private func start(_ host: CoreHost) async throws {
        let network=CryptoHTTPFixtureProtocol.counts.0,before=state.recorded.count
        _=try await host.start();XCTAssertEqual(state.recorded.count,before,"Startup executes no crypto")
        XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.0,network,"Startup executes no HTTP")
    }
    private func probe(_ host: CoreHost) async throws -> [String:Any] { try object(await host.call("menuRead",argumentsJSON:json(["dataSettings","{}"]))) }
    private func drained() async throws {
        for _ in 0..<500{if state.slots==0{return};try await Task.sleep(nanoseconds:10_000_000)}
        XCTFail("Crypto slots did not drain");XCTAssertEqual(state.slots,0)
    }

    // Synthetic remote generations isolate shared admission from HTTP and the
    // production Unlock-only parser; all Argon2/AES work still uses native jobs.
    private let capacityHelpers = """
    if(typeof g.runEnableSyncEncryptionOverRemote!=='function'||typeof g.SyncEncryptionArtifactCapacityError!=='function'
      ||typeof g.encryptedSyncArtifactByteLength!=='function')throw new Error('Crypto fixture gate is unavailable');
    const kdf={mKib:64,t:1,p:1},passphrase='synthetic-capacity-376';
    const bytes=length=>Uint8Array.from({length},(_,i)=>(i*17+3)%251);
    const fixture=(seed,capacity)=>{
      const store=new Map(Object.entries(seed).map(([name,item])=>[name,{bytes:item.bytes.slice(),kind:item.kind,version:1}]));
      const mutations=[],stateWrites=[],keys={current:null,writes:0,clears:0};let local=null,failAfterWrite=false;
      const version=name=>store.has(name)?'v'+store.get(name).version:null;
      const read=name=>({bytes:store.has(name)?store.get(name).bytes.slice():null,version:version(name)});
      const snapshot=()=>JSON.stringify([...store].sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>
        ({name,kind:item.kind,version:item.version,bytes:hex(item.bytes)})));
      const remote={maxEncryptedArtifactBytes:capacity,
        async list(){return [...store].map(([name,item])=>({name,kind:item.kind}))},
        async captureInventory(){const entries=await this.list();return {entries,snapshot:new Map(entries.map(item=>[item.name,read(item.name)]))}},
        async read(name){return read(name)},
        async write(name,value,expected){if(version(name)!==expected)throw new Error('Synthetic generation conflict');
          const current=store.get(name);store.set(name,{bytes:value.slice(),kind:current?current.kind:'document',version:(current?current.version:0)+1});
          mutations.push({operation:'write',name,expected,length:value.length});
          if(failAfterWrite){failAfterWrite=false;throw new Error('Synthetic interrupted write acknowledgement')}},
        async remove(name,expected){if(version(name)!==expected)throw new Error('Synthetic generation conflict');
          store.delete(name);mutations.push({operation:'remove',name,expected})}};
      const keyCache={async getKey(){return keys.current&&keys.current.slice()},
        async setKey(key){keys.current=key.slice();keys.writes++},async clearKey(){keys.current=null;keys.clears++}};
      const localState={read(){return local},write(value){local=value===null?null:JSON.parse(JSON.stringify(value));stateWrites.push(local)}};
      return {remote,keyCache,localState,store,mutations,stateWrites,keys,snapshot,
        interruptNextWrite(){failAfterWrite=true}};
    };
    const enable=f=>g.runEnableSyncEncryptionOverRemote(passphrase,f.remote,f.keyCache,f.localState,undefined,g.prims,kdf);
    """

    func testEnableCapacityRefusesLateAttachmentAndBaseDocumentBeforeAnyMutation() async throws {
        let host=try host(capacityHelpers+"""
        const checks=[];
        for(const kind of ['attachment','document']){
          const seed={'attachments/first.bin':{bytes:bytes(1),kind:'attachment'}};
          seed[kind==='attachment'?'attachments/last.bin':'data.json']={bytes:bytes(11),kind};
          const f=fixture(seed,g.encryptedSyncArtifactByteLength(10)),before=f.snapshot();let typed=false,fixed=false;
          try{await enable(f)}catch(error){typed=error instanceof g.SyncEncryptionArtifactCapacityError;
            fixed=error.message==='SYNC_ENCRYPTION_ARTIFACT_CAPACITY: encrypted artifact exceeds host capacity'}
          checks.push({typed,fixed,unchanged:f.snapshot()===before,mutations:f.mutations.length,
            states:f.stateWrites.length,keyWrites:f.keys.writes,keyClears:f.keys.clears,
            keyMissing:f.keys.current===null,stateMissing:f.localState.read()===null});
        }return {checks};
        """,faults:faults())
        try await start(host);let before=try rows(),network=CryptoHTTPFixtureProtocol.counts.0,result=try await probe(host)
        let checks=try XCTUnwrap(result["checks"] as? [[String:Any]]);XCTAssertEqual(checks.count,2)
        for check in checks {
            for name in ["typed","fixed","unchanged","keyMissing","stateMissing"] { XCTAssertEqual(check[name] as? Bool,true,name) }
            for name in ["mutations","states","keyWrites","keyClears"] { XCTAssertEqual(check[name] as? Int,0,name) }
        }
        XCTAssertEqual(state.recorded,["argon2id","argon2id"],"Native KDF runs, but no artifact is sealed before all sizes pass")
        try await drained();XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0)
        XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.0,network,"Synthetic admission performs no HTTP")
        XCTAssertEqual(try rows(),before,"Capacity refusal preserves every local table byte")
    }

    func testEnableCapacityExactCanonicalBoundaryEncryptsAndDecryptsThroughNativeJobs() async throws {
        let host=try host(capacityHelpers+"""
        const plain=bytes(10),capacity=g.encryptedSyncArtifactByteLength(plain.length);
        const f=fixture({'attachments/file.bin':{bytes:plain,kind:'attachment'},'data.json':{bytes:plain,kind:'document'}},capacity);
        await enable(f);const attachment=f.store.get('attachments/file.bin'),document=f.store.get('data.json.enc');
        const opened=await Promise.all([g.decryptSyncArtifact(attachment.bytes,f.keys.current,g.prims),
          g.decryptSyncArtifact(document.bytes,f.keys.current,g.prims)]);
        return {capacity,lengths:[attachment.bytes.length,document.bytes.length],opened:opened.map(value=>hex(value)===hex(plain)),
          names:[...f.store.keys()].sort(),state:f.localState.read().state,complete:!f.localState.read().incompleteTransition,
          stateWrites:f.stateWrites.map(value=>value.incompleteTransition||value.state),keyWrites:f.keys.writes,keyClears:f.keys.clears,
          mutations:f.mutations.map(value=>({operation:value.operation,name:value.name,expected:value.expected})),
          allWritesAdmitted:f.mutations.filter(value=>value.operation==='write').every(value=>value.length<=capacity)};
        """,faults:faults())
        try await start(host);let before=try rows(),network=CryptoHTTPFixtureProtocol.counts.0,result=try await probe(host)
        XCTAssertEqual(result["capacity"] as? Int,80);XCTAssertEqual(result["lengths"] as? [Int],[80,80])
        XCTAssertEqual(result["opened"] as? [Bool],[true,true]);XCTAssertEqual(result["names"] as? [String],["attachments/file.bin","data.json.enc"])
        XCTAssertEqual(result["state"] as? String,"enabled");XCTAssertEqual(result["complete"] as? Bool,true)
        XCTAssertEqual(result["stateWrites"] as? [String],["enable","enabled"]);XCTAssertEqual(result["keyWrites"] as? Int,1);XCTAssertEqual(result["keyClears"] as? Int,0)
        let mutations=try XCTUnwrap(result["mutations"] as? [[String:Any]])
        XCTAssertEqual(try json(mutations),try json([
            ["operation":"write","name":"attachments/file.bin","expected":"v1"],
            ["operation":"write","name":"data.json.enc","expected":NSNull()],
            ["operation":"remove","name":"data.json","expected":"v1"]
        ] as [[String:Any]]))
        XCTAssertEqual(result["allWritesAdmitted"] as? Bool,true)
        XCTAssertTrue(state.recorded.contains("argon2id"));XCTAssertTrue(state.recorded.contains("aesGcmSeal"));XCTAssertTrue(state.recorded.contains("aesGcmOpen"))
        try await drained();XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0)
        XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.0,network);XCTAssertEqual(try rows(),before)
    }

    func testEnableCapacityResumesInterruptedPaddedForeignGenerationWithoutDataLoss() async throws {
        let host=try host(capacityHelpers+"""
        const base=await g.deriveSyncKeyMaterial(passphrase,new Uint8Array(16).fill(1),kdf,g.prims),
          abandoned=await g.deriveSyncKeyMaterial(passphrase,new Uint8Array(16).fill(2),kdf,g.prims),plain=bytes(10),documentPlain=bytes(1);
        const baseDocument=await g.encryptSyncArtifact(documentPlain,base,g.prims),foreign=await g.encryptSyncArtifact(plain,abandoned,g.prims),
          padded=new Uint8Array(foreign.length+9);padded.set(foreign);padded.fill(0x20,foreign.length);
        const capacity=g.encryptedSyncArtifactByteLength(plain.length),f=fixture({
          'attachments/file.bin':{bytes:padded,kind:'attachment'},'data.json.enc':{bytes:baseDocument,kind:'document'},
          'data.json':{bytes:documentPlain,kind:'document'}},capacity);
        f.interruptNextWrite();let interrupted=false;
        try{await enable(f)}catch(error){interrupted=error.message==='Synthetic interrupted write acknowledgement'}
        const afterInterrupted=f.store.get('attachments/file.bin'),journal=f.localState.read();
        const interruptedChecks={interrupted,inputPadded:padded.length>capacity,journal:journal&&journal.incompleteTransition==='enable',
          stateOff:journal&&journal.state==='off',keyMissing:f.keys.current===null,keyWrites:f.keys.writes,mutations:f.mutations.length,
          canonical:afterInterrupted.bytes.length===capacity,version:afterInterrupted.version,
          attachment:hex(await g.decryptSyncArtifact(afterInterrupted.bytes,base.key,g.prims))===hex(plain),
          document:hex(f.store.get('data.json.enc').bytes)===hex(baseDocument),
          original:hex(f.store.get('data.json').bytes)===hex(documentPlain)};
        await enable(f);const finalState=f.localState.read(),attachment=f.store.get('attachments/file.bin');
        return {interruptedChecks,complete:finalState.state==='enabled'&&!finalState.incompleteTransition,
          keyMatches:hex(f.keys.current)===hex(base.key),keyWrites:f.keys.writes,keyClears:f.keys.clears,
          stateWrites:f.stateWrites.map(value=>value.incompleteTransition||value.state),
          mutations:f.mutations.map(value=>({operation:value.operation,name:value.name,expected:value.expected})),
          canonical:attachment.bytes.length===capacity,version:attachment.version,
          attachment:hex(await g.decryptSyncArtifact(attachment.bytes,f.keys.current,g.prims))===hex(plain),
          document:hex(await g.decryptSyncArtifact(f.store.get('data.json.enc').bytes,f.keys.current,g.prims))===hex(documentPlain),
          baseUnchanged:hex(f.store.get('data.json.enc').bytes)===hex(baseDocument),originalRemoved:!f.store.has('data.json'),
          allWritesAdmitted:f.mutations.filter(value=>value.operation==='write').every(value=>value.length<=capacity)};
        """,faults:faults())
        try await start(host);let before=try rows(),network=CryptoHTTPFixtureProtocol.counts.0,result=try await probe(host)
        let interrupted=try XCTUnwrap(result["interruptedChecks"] as? [String:Any])
        for name in ["interrupted","inputPadded","journal","stateOff","keyMissing","canonical","attachment","document","original"] { XCTAssertEqual(interrupted[name] as? Bool,true,name) }
        XCTAssertEqual(interrupted["keyWrites"] as? Int,0);XCTAssertEqual(interrupted["mutations"] as? Int,1);XCTAssertEqual(interrupted["version"] as? Int,2)
        for name in ["complete","keyMatches","canonical","attachment","document","baseUnchanged","originalRemoved","allWritesAdmitted"] { XCTAssertEqual(result[name] as? Bool,true,name) }
        XCTAssertEqual(result["version"] as? Int,2,"Resume skips the already-converted exact generation")
        XCTAssertEqual(result["keyWrites"] as? Int,1);XCTAssertEqual(result["keyClears"] as? Int,0)
        XCTAssertEqual(result["stateWrites"] as? [String],["enable","enable","enabled"])
        XCTAssertEqual(try json(try XCTUnwrap(result["mutations"] as? [[String:Any]])),try json([
            ["operation":"write","name":"attachments/file.bin","expected":"v1"],
            ["operation":"remove","name":"data.json","expected":"v1"]
        ] as [[String:Any]]))
        XCTAssertTrue(state.recorded.contains("aesGcmSeal"));XCTAssertTrue(state.recorded.contains("aesGcmOpen"))
        try await drained();XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0)
        XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.0,network);XCTAssertEqual(try rows(),before)
    }

    func testEightSharedArgon2VectorsAndSevenAESVectorsThroughActualJSC() async throws {
        let host=try host("""
        const argon=[],aes=[];
        for(const v of g.primitiveVectors.argon2id){const key=await g.prims.argon2id(unhex(v.passHex),unhex(v.saltHex),{mKib:v.mKib,t:v.t,p:v.p},v.dkLen);argon.push(hex(key)===v.keyHex)}
        for(const v of g.primitiveVectors.aesGcm){const key=unhex(v.keyHex),nonce=unhex(v.nonceHex),plain=unhex(v.plaintextHex),aad=unhex(v.aadHex);
          const sealed=await g.prims.aesGcmSeal(key,nonce,plain,aad),opened=await g.prims.aesGcmOpen(key,nonce,sealed,aad);
          aes.push(hex(sealed)===v.sealedHex&&hex(opened)===v.plaintextHex)}
        return {argon,aes,kv:typeof __mindwtrNative.kvMultiGet};
        """,faults:faults())
        try await start(host);let before=try rows(),result=try await probe(host)
        XCTAssertEqual(result["argon"] as? [Bool],[Bool](repeating:true,count:8));XCTAssertEqual(result["aes"] as? [Bool],[Bool](repeating:true,count:7))
        XCTAssertEqual(result["kv"] as? String,"undefined");try await drained();XCTAssertEqual(try rows(),before);XCTAssertEqual(state.retainedBytes,0)
        await host.close();let log=try String(contentsOf:root.appendingPathComponent("logs/mindwtr.log"),encoding:.utf8)
        XCTAssertTrue(log.contains("v1.3.5/ios-sync-crypto"));XCTAssertFalse(log.contains("hunter2"));XCTAssertFalse(log.contains("passHex"))
    }

    func testFiveMWENC1FixturesUseSharedCoreIncludingNFCAndTrailingPadding() async throws {
        let host=try host("""
        const results=[];for(const v of g.vectors){const material=await g.deriveSyncKeyMaterial(v.passphrase,un64(v.saltB64),v.params,g.prims);
          const encrypted=un64(v.encryptedB64),plain=un64(v.plaintextB64),opened=await g.decryptSyncArtifact(encrypted,material.key,g.prims);
          const sealed=await g.encryptSyncArtifact(plain,material,{...g.prims,randomBytes:()=>un64(v.nonceB64)});
          const padded=new Uint8Array(encrypted.length+3);padded.set(encrypted);padded.set([1,2,3],encrypted.length);
          const padding=await g.decryptSyncArtifact(padded,material.key,g.prims);
          results.push(hex(opened)===hex(plain)&&hex(sealed)===hex(encrypted)&&hex(padding)===hex(plain))}
        const v=g.vectors[3],a=await g.deriveSyncKeyMaterial(v.passphrase.normalize('NFC'),un64(v.saltB64),v.params,g.prims),
          b=await g.deriveSyncKeyMaterial(v.passphrase.normalize('NFD'),un64(v.saltB64),v.params,g.prims);
        return {results,nfc:hex(a.key)===hex(b.key)};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["results"] as? [Bool],[Bool](repeating:true,count:5));XCTAssertEqual(result["nfc"] as? Bool,true)
        try await drained();XCTAssertEqual(state.retainedBytes,0)
    }

    func testAuthenticationFailuresRemainSharedAuthErrorsAndNextOpenSucceeds() async throws {
        let host=try host("""
        const key=new Uint8Array(32),nonce=new Uint8Array(12),plain=new Uint8Array([1,2,3]),aad=new Uint8Array([9]);
        const sealed=await g.prims.aesGcmSeal(key,nonce,plain,aad),tag=sealed.slice(),body=sealed.slice(),otherKey=key.slice();
        tag[tag.length-1]^=1;body[0]^=1;otherKey[0]=1;const errors=[];
        for(const [k,data,a] of [[key,sealed,new Uint8Array([8])],[key,tag,aad],[otherKey,sealed,aad],[key,sealed.slice(0,15),aad],[key,body,aad]]){
          try{await g.prims.aesGcmOpen(k,nonce,data,a);errors.push(false)}catch(e){errors.push(e instanceof g.SyncCryptoAuthError&&e.message==='wrong passphrase or corrupted data')}}
        return {errors,opened:Array.from(await g.prims.aesGcmOpen(key,nonce,sealed,aad))};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["errors"] as? [Bool],[Bool](repeating:true,count:5));XCTAssertEqual(result["opened"] as? [Int],[1,2,3])
        try await drained();XCTAssertEqual(state.retainedBytes,0)
    }

    func testMalformedCostsFieldsAndBase64RefuseBeforeNativeWork() async throws {
        let host=try host("""
        const n=__mindwtrNative,kdf={op:'argon2id',pass:'AA==',salt:'AAAAAAAAAAA=',m:64,t:1,p:1,dkLen:32};
        const changes=[{m:true},{m:1.5},{m:'64'},{m:null},{m:0},{m:7},{m:262145},{m:4294967296},{t:0},{t:17},{t:false},
          {p:0},{p:9},{p:2,m:8},{dkLen:3},{dkLen:65},{pass:'Zh=='},{pass:'AA'},{pass:null},{salt:''},{salt:'AAAA'},
          {extra:true},{op:'unknown'}];
        const answers=changes.map(x=>n.cryptoCall(JSON.stringify({...kdf,...x})));
        const aes={op:'aesGcmSeal',key:'A'.repeat(43)+'=',nonce:'A'.repeat(16),data:'',aad:''};
        for(const x of [{key:''},{key:'A'.repeat(22)+'=='},{nonce:''},{nonce:'A'.repeat(16)+'AAAA'},{data:3},{aad:null},{extra:true}])answers.push(n.cryptoCall(JSON.stringify({...aes,...x})));
        answers.push(n.cryptoCall(4),n.cryptoCall('not-json'),n.cryptoCall(' '.repeat(12582913)));
        return {count:answers.length,refused:answers.every(x=>typeof x==='string'&&x.startsWith('!MindwtrNativeError:'))};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["count"] as? Int,33);XCTAssertEqual(result["refused"] as? Bool,true)
        XCTAssertEqual(state.recorded,[]);XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0)
    }

    func testUnavailableProviderIsFixedNonAuthAndNeverFallsBack() async throws {
        let faults=faults();faults.cryptoArgon2Unavailable={true}
        let host=try host("""
        let message='',auth=false,unsupported=false;try{await g.prims.argon2id(new Uint8Array([0]),new Uint8Array(8),{mKib:64,t:1,p:1},32)}catch(e){message=e.message;auth=e instanceof g.SyncCryptoAuthError}
        try{await g.deriveSyncKeyMaterial('synthetic',new Uint8Array(16),{mKib:64,t:1,p:1},g.prims)}catch(e){unsupported=e instanceof g.SyncCryptoUnsupportedError}
        return {message,auth,unsupported};
        """,faults:faults)
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["message"] as? String,"Sync encryption is unavailable");XCTAssertEqual(result["auth"] as? Bool,false)
        XCTAssertEqual(result["unsupported"] as? Bool,true);try await drained();XCTAssertEqual(state.retainedBytes,0)
        await host.close()
        if let log=try? String(contentsOf:root.appendingPathComponent("logs/mindwtr.log"),encoding:.utf8){XCTAssertFalse(log.contains("v1.3.5/ios-sync-crypto"))}
    }


    func testDirectNativeSealSliceOutputBodyCleanupPreservesBytesAndReleasesSlots() async throws {
        // This direct owner regression does not start the giant Engine, so the
        // cleanup path can run under ASan independently of CoreHost stack size.
        // CryptoKit's observed ciphertext slice uses nonzero indices on Darwin;
        // correctness must also hold if its storage representation later changes.
        let registry=NativeAttachmentLocalRequests(),jobs=NativeCryptoJobs(registry:registry);defer{jobs.shutdown()}
        let keyBytes=Data(count:32),nonceBytes=Data(count:12),aad=Data([9,0,8])
        let key=SymmetricKey(data:keyBytes),nonce=try AES.GCM.Nonce(data:nonceBytes)
        for length in [0,1,15,16,17,1000,4096] {
            let plain=Data((0..<length).map{UInt8($0 % 251)})
            let box=try AES.GCM.seal(plain,using:key,nonce:nonce,authenticating:aad)
            var expected=box.ciphertext;expected.append(box.tag)
            // Use Data's actual index range, never assume a zero-based slice.
            XCTAssertEqual(expected.endIndex-expected.startIndex,length+16)
            let request=try json(["op":"aesGcmSeal","key":keyBytes.base64EncodedString(),"nonce":nonceBytes.base64EncodedString(),
                                  "data":plain.base64EncodedString(),"aad":aad.base64EncodedString()])
            let id=try jobs.submit(request);var reply:(json:String,body:Bool)?
            for _ in 0..<500{if let next=try jobs.next(){reply=next;break};try await Task.sleep(nanoseconds:10_000_000)}
            let metadata=try XCTUnwrap(reply);XCTAssertTrue(metadata.body);XCTAssertEqual(try object(metadata.json)["id"] as? String,id)
            let body=try jobs.body();XCTAssertTrue(body.completed);XCTAssertEqual(body.base64,expected.base64EncodedString())
            XCTAssertEqual(jobs.counters.jobs,0);XCTAssertEqual(jobs.counters.bytes,0);XCTAssertThrowsError(try jobs.body())
        }
    }

    func testTwoRetainedSlotsRefuseThirdAndIdleDeliveryReleasesCapacity() async throws {
        let host=try host("""
        const key=new Uint8Array(32),nonce=new Uint8Array(12),seal=()=>g.prims.aesGcmSeal(key,nonce,new Uint8Array([7]),new Uint8Array());
        const first=seal(),second=seal();let capacity=false;
        try{await seal()}catch(e){capacity=e.name==='TypeError'&&e.message==='Crypto bridge is unavailable or at capacity'}
        const pair=await Promise.all([first,second]),next=await seal();void seal().catch(()=>{});
        return {capacity,lengths:pair.map(x=>x.length),next:next.length};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["capacity"] as? Bool,true);XCTAssertEqual(result["lengths"] as? [Int],[17,17]);XCTAssertEqual(result["next"] as? Int,17)
        try await drained();XCTAssertEqual(state.recorded.count,4);XCTAssertEqual(state.retainedBytes,0)
    }

    func testExactByteCapsAndOverLimitRefusals() async throws {
        let host=try host("""
        const key=new Uint8Array(32),nonce=new Uint8Array(12),plain=new Uint8Array(8388608),aad=new Uint8Array(65536);plain[0]=23;plain[plain.length-1]=91;
        const sealed=await g.prims.aesGcmSeal(key,nonce,plain,aad),opened=await g.prims.aesGcmOpen(key,nonce,sealed,aad);
        const refused=[];for(const request of [()=>g.prims.aesGcmSeal(key,nonce,new Uint8Array(8388609),aad),
          ()=>g.prims.aesGcmOpen(key,nonce,new Uint8Array(8388625),aad),()=>g.prims.aesGcmSeal(key,nonce,new Uint8Array(),new Uint8Array(65537)),
          ()=>g.prims.argon2id(new Uint8Array(65537),new Uint8Array(8),{mKib:64,t:1,p:1},32),
          ()=>g.prims.argon2id(new Uint8Array(),new Uint8Array(65),{mKib:64,t:1,p:1},32)]){
          try{await request();refused.push(false)}catch(e){refused.push(e.name==='TypeError'&&e.message==='Crypto request is invalid')}}
        const derived=await g.prims.argon2id(new Uint8Array(65536),new Uint8Array(64),{mKib:64,t:1,p:1},64);
        return {sealed:sealed.length,opened:opened.length,ends:[opened[0],opened[opened.length-1]],refused,derived:derived.length};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["sealed"] as? Int,8*1024*1024+16);XCTAssertEqual(result["opened"] as? Int,8*1024*1024)
        XCTAssertEqual(result["ends"] as? [Int],[23,91]);XCTAssertEqual(result["refused"] as? [Bool],[Bool](repeating:true,count:5))
        XCTAssertEqual(result["derived"] as? Int,64);XCTAssertEqual(state.recorded,["aesGcmSeal","aesGcmOpen","argon2id"])
        try await drained();XCTAssertEqual(state.retainedBytes,0)
    }

    func testKDFCeilingAdmissionUsesInjectedUnavailableWithoutExpensiveWork() async throws {
        let faults=faults();faults.cryptoArgon2Unavailable={true}
        let host=try host("""
        const admitted=[],refused=[];
        for(const params of [{mKib:262144,t:16,p:8},{mKib:64,t:1,p:8}]){try{await g.prims.argon2id(new Uint8Array(),new Uint8Array(8),params,4);admitted.push(false)}catch(e){admitted.push(e.message==='Sync encryption is unavailable')}}
        for(const params of [{mKib:262145,t:16,p:8},{mKib:262144,t:17,p:8},{mKib:262144,t:16,p:9},{mKib:63,t:1,p:8}]){
          try{await g.prims.argon2id(new Uint8Array(),new Uint8Array(8),params,4);refused.push(false)}catch(e){refused.push(e.name==='TypeError'&&e.message==='Crypto request is invalid')}}
        return {admitted,refused};
        """,faults:faults)
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["admitted"] as? [Bool],[true,true]);XCTAssertEqual(result["refused"] as? [Bool],[true,true,true,true])
        XCTAssertEqual(state.recorded,["argon2id","argon2id"]);try await drained();XCTAssertEqual(state.retainedBytes,0)
    }

    func testMWENC1InvalidHeadersRefuseBeforeNativeAndFullHeaderIsAuthenticated() async throws {
        let host=try host("""
        const bytes=un64(g.vectors[0].encryptedB64),invalid=[];
        for(const [offset,value] of [[6,2],[7,2],[17,2],[16,9],[8,255]]){const bad=bytes.slice();bad[offset]=value;if(offset===8){bad[9]=255;bad[10]=255;bad[11]=255}invalid.push(bad)}
        invalid.push(bytes.slice(0,53),bytes.slice(0,bytes.length-1));
        const unsupported=[];for(const bad of invalid){const inspection=g.inspectSyncArtifact(bad);let error=false;
          try{await g.decryptSyncArtifact(bad,new Uint8Array(32),g.prims)}catch(e){error=e instanceof g.SyncCryptoUnsupportedError}
          unsupported.push(inspection.kind==='unsupported'&&error)}
        const v=g.vectors[0],material=await g.deriveSyncKeyMaterial(v.passphrase,un64(v.saltB64),v.params,g.prims),bad=bytes.slice();bad[18]^=1;
        let auth=false;try{await g.decryptSyncArtifact(bad,material.key,g.prims)}catch(e){auth=e instanceof g.SyncCryptoAuthError}
        return {unsupported,auth};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["unsupported"] as? [Bool],[Bool](repeating:true,count:7));XCTAssertEqual(result["auth"] as? Bool,true)
        XCTAssertEqual(state.recorded,["argon2id","aesGcmOpen"]);try await drained();XCTAssertEqual(state.retainedBytes,0)
    }

    func testFileHTTPSecretAndCryptoRepliesKeepFourWayBodyOwnership() async throws {
        let cache=root.appendingPathComponent("attachment-files/cache/bytes")
        let host=try host("""
        const uri=\(try literal(cache.absoluteString)),results=[];
        const file=()=>__mindwtrFileCall({op:'readBytes',uri}).then(b=>Array.from(b)),
          net=()=>fetch('https://crypto-fixture.invalid/bytes').then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b))),
          secret=()=>__mindwtrSecrets.getSecret('synthetic'),
          crypto=()=>g.prims.aesGcmSeal(new Uint8Array(32),new Uint8Array(12),new Uint8Array(),new Uint8Array()).then(hex);
        for(const order of [[file,net,secret,crypto],[crypto,secret,net,file],[secret,file,crypto,net]])results.push(await Promise.all(order.map(f=>f())));
        const duplicate=__mindwtrNative.ioBody().startsWith('!MindwtrNativeError:');return {results,duplicate,kv:typeof __mindwtrNative.kvMultiGet};
        """,faults:faults())
        try await start(host);try Data([1,2,3]).write(to:cache);let before=try rows(),network=CryptoHTTPFixtureProtocol.counts.0
        let result=try await probe(host),values=try XCTUnwrap(result["results"] as? [[Any]])
        XCTAssertEqual(values.count,3);let tag="530f8afbc74536b9a963b4f1c4cb738b"
        XCTAssertEqual(values[0][0] as? [Int],[1,2,3]);XCTAssertEqual(values[0][1] as? [Int],[8,9]);XCTAssertTrue(values[0][2] is NSNull);XCTAssertEqual(values[0][3] as? String,tag)
        XCTAssertEqual(values[1][0] as? String,tag);XCTAssertTrue(values[1][1] is NSNull);XCTAssertEqual(values[1][2] as? [Int],[8,9]);XCTAssertEqual(values[1][3] as? [Int],[1,2,3])
        XCTAssertTrue(values[2][0] is NSNull);XCTAssertEqual(values[2][1] as? [Int],[1,2,3]);XCTAssertEqual(values[2][2] as? String,tag);XCTAssertEqual(values[2][3] as? [Int],[8,9])
        XCTAssertEqual(result["duplicate"] as? Bool,true);XCTAssertEqual(result["kv"] as? String,"undefined");XCTAssertEqual(CryptoHTTPFixtureProtocol.counts.0-network,3)
        try await drained();XCTAssertEqual(try rows(),before);XCTAssertEqual(try Data(contentsOf:cache),Data([1,2,3]));XCTAssertEqual(state.retainedBytes,0)
        XCTAssertFalse(FileManager.default.fileExists(atPath:database.appendingPathExtension("pending.json").path))
    }

    func testCancelledCallerAwaitsFourSequentialFinallyCryptoOperations() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0);defer{release.signal()}
        let faults=faults(),state=self.state!
        faults.cryptoBeforeOperation={operation in state.record(operation);if state.recorded.count == 1{entered.signal();release.wait()}}
        let host=try host("""
        try{await g.prims.argon2id(new Uint8Array([0]),new Uint8Array(8),{mKib:64,t:1,p:1},32)}finally{
          let refused=false;try{await __mindwtrSecrets.getSecret('synthetic')}catch(e){refused=e.name==='AbortError'}
          if(!refused)throw new Error('Cancelled facade did not refuse');
          for(let i=0;i<4;i++)await g.prims.aesGcmSeal(new Uint8Array(32),new Uint8Array(12),new Uint8Array([i]),new Uint8Array());
        }return {done:true};
        """,faults:faults)
        try await start(host)
        let input=try json(["owner":["kind":"task","taskId":"crypto-fixture","attachments":[]] as [String:Any],"attachmentId":"probe"])
        let request=Task{try await host.localAttachmentRequest(name:"openAttachment",requestJSON:input)}
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success);request.cancel();try await Task.sleep(nanoseconds:50_000_000);release.signal()
        do{_=try await request.value;XCTFail("Cancelled caller must refuse")}catch is CancellationError{}catch{XCTFail("Expected cancellation, received \(type(of:error))")}
        try await drained();XCTAssertEqual(state.recorded,["argon2id"]+[String](repeating:"aesGcmSeal",count:4));XCTAssertEqual(state.retainedBytes,0)
    }

    func testCloseRunningKDFDropsResultRefusesQueuedAndLateWorkBeforeUnlock() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),closed=DispatchSemaphore(value:0);defer{release.signal()}
        let faults=faults(),state=self.state!
        faults.cryptoBeforeOperation={operation in state.record(operation);if state.recorded.count == 1{entered.signal();release.wait()}}
        let host=try host("""
        const first=g.prims.argon2id(new Uint8Array([0]),new Uint8Array(8),{mKib:64,t:1,p:1},32),
          queued=g.prims.aesGcmSeal(new Uint8Array(32),new Uint8Array(12),new Uint8Array(),new Uint8Array());
        const results=await Promise.allSettled([first,queued]);let late=false;
        try{await g.prims.aesGcmSeal(new Uint8Array(32),new Uint8Array(12),new Uint8Array(),new Uint8Array())}catch(e){late=e.name==='TypeError'}
        const fixedCode=e=>!e?'none':e.message==='Crypto bridge is closed'?'closed':e.message==='I/O response body is unavailable'?'body-unavailable':e.message==='Crypto bridge is unavailable or at capacity'?'admission-refused':'other';
        return {statuses:results.map(x=>x.status),codes:results.map(x=>fixedCode(x.reason)),auth:results.map(x=>x.reason instanceof g.SyncCryptoAuthError),
          closed:results.every(x=>x.reason&&x.reason.message==='Crypto bridge is closed'&&!(x.reason instanceof g.SyncCryptoAuthError)),late};
        """,faults:faults)
        try await start(host);let request=Task{try await self.probe(host)}
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success)
        // counters.jobs includes pre-decode reservations. Unfinished counts only
        // actual admitted jobs, proving the second submit finished admission.
        let admissionDeadline=Date().addingTimeInterval(5)
        while state.unfinished != 2 && Date() < admissionDeadline { try await Task.sleep(nanoseconds:1_000_000) }
        guard state.unfinished == 2 else {
            XCTFail("Both crypto requests must be admitted before close")
            release.signal();_ = try? await request.value;await host.close();return
        }
        XCTAssertEqual(state.slots,2)
        let closing=Task{await host.close();closed.signal()}
        XCTAssertEqual(closed.wait(timeout:.now()+0.05),.timedOut)
        let replacement=CoreHost(databaseURL:database,bundleURL:bundle,faults:self.faults());addTeardownBlock{await replacement.close()}
        do{_=try await replacement.start();XCTFail("Running KDF must retain library ownership")}catch{}
        release.signal();let result=try await request.value;await closing.value
        XCTAssertEqual(result["statuses"] as? [String],["rejected","rejected"],"Both admitted requests reject at close")
        XCTAssertEqual(result["codes"] as? [String],["closed","closed"],"Only fixed closed errors reach the admitted promises")
        XCTAssertEqual(result["auth"] as? [Bool],[false,false],"Close errors never become authentication failures")
        XCTAssertEqual(result["closed"] as? Bool,true,"Admitted request closed classification")
        XCTAssertEqual(result["late"] as? Bool,true,"Late admission TypeError refusal")
        XCTAssertEqual(state.recorded,["argon2id"]);XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0);XCTAssertEqual(state.delivered,0)
        _=try await replacement.start();await replacement.close()
    }

    func testTrailingRunningOperationDrainsBeforeLibraryUnlock() async throws {
        let entered=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0),closed=DispatchSemaphore(value:0);defer{release.signal()}
        let faults=faults();faults.cryptoAfterOperation={_ in entered.signal();release.wait()}
        let host=try host("void g.prims.argon2id(new Uint8Array(),new Uint8Array(8),{mKib:64,t:1,p:1},32).catch(()=>{});return {returned:true};",faults:faults)
        try await start(host);let result=try await probe(host);XCTAssertEqual(result["returned"] as? Bool,true)
        XCTAssertEqual(entered.wait(timeout:.now()+5),.success);XCTAssertEqual(state.slots,1)
        let closing=Task{await host.close();closed.signal()};XCTAssertEqual(closed.wait(timeout:.now()+0.05),.timedOut)
        let replacement=CoreHost(databaseURL:database,bundleURL:bundle,faults:self.faults());addTeardownBlock{await replacement.close()}
        do{_=try await replacement.start();XCTFail("Trailing crypto must drain before unlock")}catch{}
        release.signal();await closing.value;XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0);XCTAssertEqual(state.delivered,0)
        _=try await replacement.start();await replacement.close()
    }

    func testPendingNativeBodyKeepsOwnerAndCloseReleasesWithoutBytes() async throws {
        let host=try host("""
        const id=__mindwtrNative.cryptoCall(JSON.stringify({op:'aesGcmSeal',key:'A'.repeat(43)+'=',nonce:'A'.repeat(16),data:'',aad:''}));
        if(id.startsWith('!MindwtrNativeError:'))throw new Error('Admission failed');let answer;
        for(let i=0;i<500;i++){const raw=__mindwtrNative.ioNext();if(raw){answer=JSON.parse(raw);break}await new Promise(resolve=>setTimeout(resolve,10))}
        let duplicate=false;const again=__mindwtrNative.ioNext();duplicate=again.startsWith('!MindwtrNativeError:');
        return {matched:answer&&answer.id===id,body:answer&&answer.body,duplicate};
        """,faults:faults())
        try await start(host);let result=try await probe(host)
        XCTAssertEqual(result["matched"] as? Bool,true);XCTAssertEqual(result["body"] as? Bool,true);XCTAssertEqual(result["duplicate"] as? Bool,true)
        XCTAssertEqual(state.slots,1);XCTAssertEqual(state.retainedBytes,16);XCTAssertEqual(state.delivered,0)
        await host.close();XCTAssertEqual(state.slots,0);XCTAssertEqual(state.retainedBytes,0)
        let replacement=try self.host("return {clean:__mindwtrNative.ioBody().startsWith('!MindwtrNativeError:')};",faults:faults())
        try await start(replacement);let cold=try await probe(replacement);XCTAssertEqual(cold["clean"] as? Bool,true);await replacement.close()
    }

    func testCloseBetweenNativeMetadataAndBodyRefusesAndReleasesSlot() async throws {
        let registry=NativeAttachmentLocalRequests(),jobs=NativeCryptoJobs(registry:registry);defer{jobs.shutdown()}
        let request=try json(["op":"aesGcmSeal","key":Data(count:32).base64EncodedString(),"nonce":Data(count:12).base64EncodedString(),"data":"","aad":""])
        let id=try jobs.submit(request);var answer:(json:String,body:Bool)?
        for _ in 0..<500{if let next=try jobs.next(){answer=next;break};try await Task.sleep(nanoseconds:10_000_000)}
        let metadata=try XCTUnwrap(answer);XCTAssertTrue(metadata.body);XCTAssertEqual(try object(metadata.json)["id"] as? String,id)
        XCTAssertEqual(jobs.counters.jobs,1);XCTAssertEqual(jobs.counters.bytes,16);registry.close()
        XCTAssertThrowsError(try jobs.body()){XCTAssertEqual(($0 as? HostFailure)?.message,"I/O response body is unavailable")}
        XCTAssertEqual(jobs.counters.jobs,0);XCTAssertEqual(jobs.counters.bytes,0);XCTAssertThrowsError(try jobs.body())
    }

    func testProvidedBundleMissingCryptoGateFailsMeaningfully() async throws {
        let original=bundle!,missing=root.appendingPathComponent("missing-gate.js")
        try (String(contentsOf:original,encoding:.utf8)+";delete globalThis.cryptoGate;").write(to:missing,atomically:true,encoding:.utf8)
        bundle=missing;defer{bundle=original}
        let host=try host("return {unexpected:true};",faults:faults());try await start(host)
        do{_=try await probe(host);XCTFail("An existing bundle without cryptoGate must fail, not skip")}catch{XCTAssertEqual((error as? HostFailure)?.message,"Crypto fixture gate is unavailable")}
        XCTAssertEqual(state.recorded,[]);XCTAssertEqual(state.slots,0)
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
