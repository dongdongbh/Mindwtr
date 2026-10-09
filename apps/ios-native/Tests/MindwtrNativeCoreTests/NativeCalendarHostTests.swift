import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CalendarNoNetworkProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var requests = 0
    static var count: Int { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.requests += 1; Self.lock.unlock()
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

private final class CalendarHostState: @unchecked Sendable {
    let reader = CalendarTestReader()
    private let lock = NSLock()
    private var jobs: NativeCalendarJobs?
    private var created = 0, settled = false, closed = false
    func makeReader() -> any NativeCalendarReading { lock.lock(); created += 1; lock.unlock(); return reader }
    func capture(_ value: NativeCalendarJobs) { lock.lock(); jobs = value; lock.unlock() }
    func markSettled() { lock.lock(); settled = true; lock.unlock() }
    func markClosed() { lock.lock(); closed = true; lock.unlock() }
    var factoryCount: Int { lock.lock(); defer { lock.unlock() }; return created }
    var hasSettled: Bool { lock.lock(); defer { lock.unlock() }; return settled }
    var hasClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }
    var counters: (jobs: Int, running: Int)? { lock.lock(); let value = jobs; lock.unlock(); return value?.counters }
}

private final class CalendarHeldFeedProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var state: CalendarHeldFeedState?
    private var owner: CalendarHeldFeedState?
    static func install(_ value: CalendarHeldFeedState?) { lock.lock(); state = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); owner = Self.state; Self.lock.unlock()
        guard let owner else { XCTFail("Unexpected Calendar HTTP owner"); fail(); return }
        owner.start(self)
    }
    override func stopLoading() { owner?.stop(self) }
    func fail() { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    func reply(_ bytes: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/calendar", "Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class CalendarHeldFeedState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0, stopped = 0, settled = false, writes = 0, prompts = 0
    private var entered: XCTestExpectation?, stopExpectation: XCTestExpectation?, completion: XCTestExpectation?
    private var completionRelease: DispatchSemaphore?
    private var jobs: NativeHTTPJobs?
    private var held: CalendarHeldFeedProtocol?
    private let bytes = Data("""
    BEGIN:VCALENDAR\r
    VERSION:2.0\r
    BEGIN:VEVENT\r
    UID:cancel-retry-conflict\r
    DTSTART:20361003T100000Z\r
    DTEND:20361003T110000Z\r
    SUMMARY:Retried ICS conflict\r
    END:VEVENT\r
    END:VCALENDAR\r

    """.utf8)
    func hold(entered: XCTestExpectation, stopped: XCTestExpectation, completion: XCTestExpectation, release: DispatchSemaphore) {
        lock.lock(); self.entered = entered; stopExpectation = stopped
        self.completion = completion; completionRelease = release; lock.unlock()
    }
    func start(_ transport: CalendarHeldFeedProtocol) {
        lock.lock(); requests += 1; let first = requests == 1, entered = self.entered
        if first { self.entered = nil; held = transport }; lock.unlock()
        guard transport.request.url?.absoluteString == "https://calendar.example.invalid/calendar.ics",
              transport.request.httpMethod == "GET" else { XCTFail("Unexpected Calendar feed request"); transport.fail(); return }
        if first { entered?.fulfill() } else { transport.reply(bytes) }
    }
    func stop(_ transport: CalendarHeldFeedProtocol) {
        lock.lock(); guard held === transport else { lock.unlock(); return }
        held = nil; stopped += 1; let expected = stopExpectation; stopExpectation = nil; lock.unlock(); expected?.fulfill()
    }
    func capture(_ value: NativeHTTPJobs) { lock.lock(); jobs = value; lock.unlock() }
    func beforeCompletion() {
        lock.lock(); let entered = completion, release = completionRelease; completion = nil; completionRelease = nil; lock.unlock()
        if let entered, let release { entered.fulfill(); _ = release.wait(timeout: .now() + 10) }
    }
    func markSettled() { lock.lock(); settled = true; lock.unlock() }
    func write() { lock.lock(); writes += 1; lock.unlock() }
    func prompt() { lock.lock(); prompts += 1; lock.unlock() }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [requests, stopped, writes, prompts] }
    var hasSettled: Bool { lock.lock(); defer { lock.unlock() }; return settled }
    var counters: (jobs: Int, running: Int)? { lock.lock(); let value = jobs; lock.unlock(); return value?.counters }
}

final class NativeCalendarHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, state: CalendarHostState!
    private var networkBefore = 0
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/calendar-host/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Calendar fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        state = CalendarHostState()
        networkBefore = CalendarNoNetworkProtocol.count
    }
    override func tearDownWithError() throws {
        XCTAssertEqual(CalendarNoNetworkProtocol.count, networkBefore, "Passive calendar transport never requests network")
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    // Actual production polyfills and cancellation remain active; only the
    // shared entry method is replaced to isolate native transport behavior.
    private func probeBundle(_ expression: String, setup: String = "") throws -> URL {
        let suffix = """
        ;(()=>{
          \(setup)
          const oldMenu=MindwtrHost.menuRead,oldPoll=MindwtrHost.poll,replies=new Map();let next=1000000000;
          const probe=requestJSON=>{const id=String(++next);Promise.resolve().then(async()=>{\(expression)}).then(
            value=>replies.set(id,JSON.stringify({ok:true,value})),
            error=>replies.set(id,JSON.stringify({ok:false,error:error instanceof Error?error.message:'Calendar probe failed'})));
            return id;};
          MindwtrHost.iosCalendarRead=probe;
          MindwtrHost.menuRead=(name,params)=>name==='dataSettings'?probe(params):oldMenu(name,params);
          MindwtrHost.poll=id=>Number(id)>1000000000?(()=>{const value=replies.get(id);if(!value)return null;replies.delete(id);return value;})():oldPoll(id);
        })();
        """
        let destination = root.appendingPathComponent("probe-" + UUID().uuidString + ".js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: destination, atomically: true, encoding: .utf8)
        return destination
    }
    private func host(_ expression: String = "return await __mindwtrCalendarCall(JSON.parse(requestJSON));", setup: String = "") throws -> CoreHost {
        let faults = HostIOFaults(), state = self.state!
        faults.calendarReaderFactory = { state.makeReader() }; faults.configureCalendarJobs = { state.capture($0) }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CalendarNoNetworkProtocol.self]; faults.httpConfiguration = configuration
        let value = CoreHost(databaseURL: database, bundleURL: try probeBundle(expression, setup: setup), faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ value: CoreHost) async throws {
        let before = state.reader.operations
        _ = try await value.start()
        XCTAssertEqual(state.reader.operations, before, "Startup performs no passive calendar read")
    }
    private func drained() async throws {
        for _ in 0..<200 {
            if state.counters?.jobs == 0 && state.counters?.running == 0 { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Calendar jobs must drain before the invocation settles")
        XCTAssertEqual(state.counters?.jobs, 0); XCTAssertEqual(state.counters?.running, 0)
    }
    private func canAcquireLibraryLock() -> Bool {
        let descriptor = Darwin.open(database.appendingPathExtension("host-lock").path, O_RDWR | O_NOFOLLOW)
        guard descriptor >= 0 else { return false }; defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { return false }
        _ = flock(descriptor, LOCK_UN); return true
    }

    func testUnmodifiedSharedSettingsAndFeedUseNativeWorkerAndDeviceStorage() async throws {
        let container = root.appendingPathComponent("container"), namespace = "tech.dongdongbh.mindwtr.calendar-tests"
        let directory = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let settings = try json(["enabled": true, "selectAll": false, "selectedCalendarIds": ["calendar-fixture"]])
        let manifest = directory.appendingPathComponent("manifest.json")
        let original = Data(try json(["mindwtr-system-calendar-settings": settings, "unknown": "preserve"]).utf8)
        try original.write(to: manifest)
        state.reader.calendarValues = [["id": "calendar-fixture", "title": "Fixture", "allowsModifications": true]]
        state.reader.eventValues = [["id": "calendar-item", "calendarId": "calendar-fixture", "title": "Fixture event",
            "startDate": "2026-10-09T12:00:00.000Z", "endDate": "2026-10-09T13:00:00.000Z", "allDay": false]]
        let faults = HostIOFaults(), state = self.state!
        faults.calendarReaderFactory = { state.makeReader() }; faults.configureCalendarJobs = { state.capture($0) }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CalendarNoNetworkProtocol.self]; faults.httpConfiguration = configuration
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
                             deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }
        try await start(value)
        let opened = try object(await value.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"))
        let device = try XCTUnwrap(opened["device"] as? [String: Any])
        XCTAssertEqual((device["calendars"] as? [[String: Any]])?.count, 1)
        let feed = try object(await value.calendarRead(requestJSON: json([
            "op": "feed", "slot": "calendar", "start": "2026-10-09T00:00:00.000Z", "end": "2026-10-10T00:00:00.000Z"])))
        XCTAssertEqual(feed["status"] as? String, "ready")
        let events = try XCTUnwrap(feed["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 1); XCTAssertEqual(events.first?["title"] as? String, "Fixture event")
        try await drained(); await value.close()
        XCTAssertEqual(try Data(contentsOf: manifest), original)
    }

    func testActualJSCBodylessRepliesAndNativeIDsUseProductionCalendarChannel() async throws {
        state.reader.calendarValues = [["id": " \u{feff}calendar ", "title": "Private calendar", "allowsModifications": true]]
        state.reader.eventValues = [["id": "item-id", "calendarId": " \u{feff}calendar ", "title": "Private event",
            "startDate": "2026-10-09T00:00:00.123Z", "endDate": "2026-10-10T00:00:00.123Z", "allDay": true]]
        let value = try host("""
        const n=__mindwtrNative,oldCall=n.calendarCall,oldNext=n.ioNext,ids=[],answers=[];
        n.calendarCall=raw=>{const id=oldCall(raw);ids.push(id);return id;};
        n.ioNext=()=>{const raw=oldNext();if(raw){const answer=JSON.parse(raw);if(String(answer.id).startsWith('cal:'))answers.push(answer);}return raw;};
        try {
          const permission=await __mindwtrCalendarCall({op:'permissions'});
          const calendars=await __mindwtrCalendarCall({op:'calendars'});
          const events=await __mindwtrCalendarCall({op:'events',calendarIds:[' \\ufeffcalendar '],startMs:1791504000123,endMs:1791590400123});
          return {permission,calendars,events,ids,bodyless:answers.every(x=>!Object.prototype.hasOwnProperty.call(x,'body')),replyIds:answers.map(x=>x.id)};
        } finally {n.calendarCall=oldCall;n.ioNext=oldNext;}
        """)
        try await start(value); XCTAssertEqual(state.factoryCount, 0)
        let answer = try object(await value.calendarRead(requestJSON: "{}"))
        XCTAssertEqual((answer["permission"] as? [String: String])?["status"], "granted")
        XCTAssertEqual((answer["calendars"] as? [[String: Any]])?.first?["title"] as? String, "Private calendar")
        XCTAssertEqual((answer["events"] as? [[String: Any]])?.first?["id"] as? String, "item-id")
        let ids = try XCTUnwrap(answer["ids"] as? [String])
        XCTAssertEqual(ids.count, 3); XCTAssertEqual(Set(ids).count, 3)
        XCTAssertTrue(ids.allSatisfy { $0.hasPrefix("cal:") }); XCTAssertEqual(ids, answer["replyIds"] as? [String])
        XCTAssertEqual(answer["bodyless"] as? Bool, true); XCTAssertEqual(state.factoryCount, 1)
        XCTAssertEqual(state.reader.requestedEvents?.ids.map { Data($0.utf8) }, [Data(" \u{feff}calendar ".utf8)])
        try await drained(); await value.close()
        let logs = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        XCTAssertFalse(logs.contains("Private calendar")); XCTAssertFalse(logs.contains("Private event"))
    }

    func testStartupRawBridgeRefusesBeforeReaderCreation() async throws {
        let setup = """
        const oldBoot=MindwtrHost.boot;
        MindwtrHost.boot=(...args)=>{globalThis.__calendarBootRefusal=__mindwtrNative.calendarCall('{"op":"permissions"}');return oldBoot(...args);};
        """
        let value = try host("return {refusal:globalThis.__calendarBootRefusal};", setup: setup)
        try await start(value)
        let answer = try object(await value.calendarRead(requestJSON: "{}"))
        XCTAssertTrue((answer["refusal"] as? String)?.hasPrefix("!MindwtrNativeError:") == true)
        XCTAssertEqual(state.factoryCount, 0); XCTAssertEqual(state.reader.operations, [])
    }

    func testPublicBoundaryRejectsInvalidJSONAndGenericCallBeforeNativeWork() async throws {
        let value = try host(); try await start(value)
        for input in ["[]", "null", "invalid", "{\"op\":\"permissions\",\"op\":\"permissions\"}", String(repeating: " ", count: 8193)] {
            do { _ = try await value.calendarRead(requestJSON: input); XCTFail("Invalid calendar facade request must refuse") }
            catch { XCTAssertEqual(error.localizedDescription, "INVALID_INPUT: Calendar request is invalid") }
        }
        do { _ = try await value.call("iosCalendarRead", argumentsJSON: "[\"{}\"]"); XCTFail("Generic call cannot expose Calendar") }
        catch {}
        XCTAssertEqual(state.factoryCount, 0); XCTAssertEqual(state.reader.operations, [])
        let base = "{\"op\":\"permissions\"}"
        let boundary = base + String(repeating: " ", count: 8192 - base.utf8.count)
        let accepted = try object(await value.calendarRead(requestJSON: boundary))
        XCTAssertEqual(accepted["status"] as? String, "granted")
        try await drained()
    }

    func testCancelledHeldReadDrainsWorkerDropsLateValueAndSameHostRetryWorks() async throws {
        let entered = expectation(description: "Calendar synchronous read entered"), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        state.reader.calendarValues = [["id": "late-private-calendar"]]
        state.reader.beforeRead = { operation in
            if operation == "calendars" { entered.fulfill(); _ = release.wait(timeout: .now() + 10) }
        }
        let value = try host(); try await start(value); let state = self.state!
        let pending = Task {
            defer { state.markSettled() }
            return try await value.calendarRead(requestJSON: "{\"op\":\"calendars\"}")
        }
        await fulfillment(of: [entered], timeout: 3); pending.cancel()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(state.hasSettled); XCTAssertEqual(state.counters?.running, 1)
        release.signal()
        do { _ = try await pending.value; XCTFail("Cancelled read cannot publish late success") }
        catch is CancellationError {} catch { XCTFail("Expected caller cancellation, got \(error)") }
        try await drained()
        let retry = try object(await value.calendarRead(requestJSON: "{\"op\":\"permissions\"}"))
        XCTAssertEqual(retry["status"] as? String, "granted"); try await drained()
        XCTAssertEqual(state.reader.operations, ["permissions", "calendars", "permissions"])
    }

    func testActualSharedICSCancellationCannotPoisonSameRangeRefreshCache() async throws {
        let entered = expectation(description: "Actual shared ICS fetch entered")
        let stopped = expectation(description: "Cancelled ICS transport stopped")
        let completing = expectation(description: "Cancelled HTTP delegate completion is held")
        let release = DispatchSemaphore(value: 0), http = CalendarHeldFeedState()
        defer { release.signal(); CalendarHeldFeedProtocol.install(nil) }
        http.hold(entered: entered, stopped: stopped, completion: completing, release: release)
        CalendarHeldFeedProtocol.install(http)
        let namespace = "tech.example.mindwtr.calendar-feed-cancel"
        let container = root.appendingPathComponent("cancel-container")
        let manifest = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let feeds = [["id": "feed-cancel", "name": "ICS cancellation fixture", "url": "https://calendar.example.invalid/calendar.ics", "enabled": true]] as [[String: Any]]
        let original = Data(try json(["mindwtr-external-calendars": json(feeds), "@mindwtr_sync_backend": "off", "unknown": "preserve"]).utf8)
        try original.write(to: manifest)
        // Only Date.now is frozen, so a slow CI drain still retries within the
        // one-second cache window. All production entry/loader/IO code is intact.
        let clockBundle = root.appendingPathComponent("calendar-cancel-clock.js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n;Date.now=()=>1791504000000;\n")
            .write(to: clockBundle, atomically: true, encoding: .utf8)
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CalendarHeldFeedProtocol.self]; faults.httpConfiguration = configuration
        faults.configureHTTPJobs = { jobs in http.capture(jobs); jobs.beforeCompletion = { http.beforeCompletion() } }
        faults.calendarReaderFactory = { XCTFail("Disabled system calendars cannot read EventKit"); return CalendarTestReader() }
        faults.calendarAuthorizationRequest = { http.prompt(); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let value = CoreHost(databaseURL: database, bundleURL: clockBundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; _ = try await value.start()
        faults.beforeSQL = { statement in
            if statement.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|projects|settings|native_request_receipts)\b"#, options: .regularExpression) != nil { http.write() }
        }
        faults.journalWrite = { http.write() }
        let request = try json(["op": "feed", "slot": "calendar", "start": "2036-10-03T00:00:00.000Z",
            "end": "2036-10-04T00:00:00.000Z", "refresh": true])
        let pending = Task { defer { http.markSettled() }; return try await value.calendarRead(requestJSON: request) }
        await fulfillment(of: [entered], timeout: 3); pending.cancel()
        await fulfillment(of: [stopped, completing], timeout: 3)
        XCTAssertFalse(http.hasSettled, "Caller cancellation must wait for the accepted HTTP delegate to drain")
        XCTAssertEqual(http.counters?.running, 1)
        release.signal()
        do { _ = try await pending.value; XCTFail("Cancelled shared feed cannot publish a partial success") }
        catch is CancellationError {} catch { XCTFail("Expected caller cancellation, got \(error)") }
        XCTAssertEqual(http.counters?.jobs, 0); XCTAssertEqual(http.counters?.running, 0)
        let retry = try object(await value.calendarRead(requestJSON: request))
        XCTAssertEqual(retry["status"] as? String, "ready"); XCTAssertNil(retry["warning"])
        let events = try XCTUnwrap(retry["events"] as? [[String: Any]])
        XCTAssertEqual(events.map { $0["title"] as? String }, ["Retried ICS conflict"])
        XCTAssertEqual(events.first?["start"] as? String, "2036-10-03T10:00:00.000Z")
        XCTAssertEqual(http.counts, [2, 1, 0, 0], "Retry must fetch again without a write or permission prompt")
        let throttled = try object(await value.calendarRead(requestJSON: request))
        XCTAssertEqual((throttled["events"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(http.counts, [2, 1, 0, 0], "Successful same-range refresh still uses the normal throttle")
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }

    func testCloseWaitsHeldWorkerBeforeLibraryUnlockAndColdOwnerHasNoLateResponse() async throws {
        let entered = expectation(description: "Calendar synchronous read entered"), release = DispatchSemaphore(value: 0)
        let closing = expectation(description: "Close requested")
        defer { release.signal() }
        state.reader.beforeRead = { operation in
            if operation == "calendars" { entered.fulfill(); _ = release.wait(timeout: .now() + 10) }
        }
        let value = try host(); try await start(value); let state = self.state!
        let pending = Task {
            defer { state.markSettled() }
            return try await value.calendarRead(requestJSON: "{\"op\":\"calendars\"}")
        }
        await fulfillment(of: [entered], timeout: 3)
        let close = Task { closing.fulfill(); await value.close(); state.markClosed() }
        await fulfillment(of: [closing], timeout: 1); try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(state.hasClosed); XCTAssertFalse(state.hasSettled)
        XCTAssertFalse(canAcquireLibraryLock()); XCTAssertEqual(state.counters?.running, 1)
        release.signal(); await close.value
        do { _ = try await pending.value; XCTFail("Closing read cannot publish late success") }
        catch is CancellationError {} catch { XCTFail("Expected caller cancellation, got \(error)") }
        XCTAssertTrue(canAcquireLibraryLock()); XCTAssertEqual(state.counters?.jobs, 0)
        let cold = try host(); try await start(cold)
        let answer = try object(await cold.calendarRead(requestJSON: "{\"op\":\"permissions\"}"))
        XCTAssertEqual(answer["status"] as? String, "granted"); try await drained()
    }

    func testRetainedAttachmentEvidenceRefusesFacadeAndRawBridgeWithoutNativeReads() async throws {
        let value = try host("return {refusal:__mindwtrNative.calendarCall('{\"op\":\"permissions\"}')};")
        try await start(value)
        let checkpoint = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "retained-task", generation: 1, payloadJSON: "{}")
        let record = NativeAttachmentDraftStore.Record(session: .init(sessionID: checkpoint.sessionID,
            taskID: checkpoint.taskID, state: .active, checkpoint: checkpoint), operations: [])
        let store = NativeAttachmentDraftStore(databaseURL: database); try store.write(record)
        let before = try Data(contentsOf: store.url)
        do { _ = try await value.calendarRead(requestJSON: "{}"); XCTFail("Calendar facade cannot borrow retained ownership") }
        catch { XCTAssertEqual(error.localizedDescription, "Attachment draft ownership requires exact recovery") }
        let answer = try object(await value.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        XCTAssertTrue((answer["refusal"] as? String)?.hasPrefix("!MindwtrNativeError:") == true)
        XCTAssertEqual(state.factoryCount, 0); XCTAssertEqual(state.reader.operations, [])
        XCTAssertEqual(try Data(contentsOf: store.url), before)
    }

    func testRecoveryBootRawBridgeRefusesBeforeCalendarProviderThenOrdinaryReadCanResume() async throws {
        let boot = try host(); try await start(boot); await boot.close()
        let sqlite = try SQLiteBridge(url: database), at = "2026-10-09T00:00:00.000Z"
        _ = try sqlite.execute("INSERT INTO tasks(id,title,status,tags,contexts,createdAt,updatedAt,rev) VALUES ('calendar-recovery-task','Retained task','inbox','[]','[]',?,?,1)", parametersJSON: json([at, at]))
        sqlite.close()
        let journal = try json(["version": 2, "method": "complete", "argumentsJSON": json(["calendar-recovery-task"])])
        try Data(journal.utf8).write(to: database.appendingPathExtension("pending.json"))
        let setup = """
        const oldRecovery=MindwtrHost.bootRecovery;
        MindwtrHost.bootRecovery=(...args)=>{globalThis.__calendarRecoveryRefusal=__mindwtrNative.calendarCall('{"op":"permissions"}');return oldRecovery(...args);};
        """
        let value = try host("return {refusal:globalThis.__calendarRecoveryRefusal};", setup: setup)
        try await start(value)
        let answer = try object(await value.calendarRead(requestJSON: "{}"))
        XCTAssertTrue((answer["refusal"] as? String)?.hasPrefix("!MindwtrNativeError:") == true)
        XCTAssertEqual(state.factoryCount, 0); XCTAssertEqual(state.reader.operations, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
    }
}
