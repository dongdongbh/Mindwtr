import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// Intercept every destination, including malformed URLs and redirects. This
/// fixture never contacts Apple and does not prove live App Store availability.
private final class AboutLookupProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var state: AboutLookupState?
    private static var unexpected = 0
    private var owner: AboutLookupState?
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ value: AboutLookupState?) { lock.lock(); state = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); owner = Self.state
        if owner == nil { Self.unexpected += 1 }
        Self.lock.unlock()
        guard let owner else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        owner.start(self)
    }
    override func stopLoading() { owner?.stop(self) }
    func reply(_ bytes: Data, status: Int) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json", "Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class AboutLookupState: @unchecked Sendable {
    struct Reply { let bytes: Data; let status: Int }
    private let lock = NSLock()
    private let identifier: String
    private var requests: [URLRequest] = []
    private var replies: [Reply] = []
    private var held: AboutLookupProtocol?
    private var holdNext = false
    private var entered: XCTestExpectation?
    private var stopped: XCTestExpectation?
    private var completion: XCTestExpectation?
    private var completionRelease: DispatchSemaphore?
    private var jobs: NativeHTTPJobs?
    private var unexpected = 0
    private var stopCount = 0
    private var secureOperations = 0
    private var settled = false
    init(identifier: String) { self.identifier = identifier }
    var recorded: [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
    var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    var stoppedCount: Int { lock.lock(); defer { lock.unlock() }; return stopCount }
    var secretCount: Int { lock.lock(); defer { lock.unlock() }; return secureOperations }
    var hasSettled: Bool { lock.lock(); defer { lock.unlock() }; return settled }
    var counters: (jobs: Int, running: Int)? {
        lock.lock(); let value = jobs; lock.unlock(); return value?.counters
    }
    func capture(_ value: NativeHTTPJobs) { lock.lock(); jobs = value; lock.unlock() }
    func secretOperation() { lock.lock(); secureOperations += 1; lock.unlock() }
    func markSettled() { lock.lock(); settled = true; lock.unlock() }
    func enqueue(_ values: [Reply]) { lock.lock(); replies.append(contentsOf: values); lock.unlock() }
    func hold(entered: XCTestExpectation, stopped: XCTestExpectation,
              completion: XCTestExpectation, release: DispatchSemaphore) {
        lock.lock(); holdNext = true; self.entered = entered; self.stopped = stopped
        self.completion = completion; completionRelease = release; lock.unlock()
    }
    func beforeCompletion() {
        lock.lock(); let entered = completion, release = completionRelease
        completion = nil; completionRelease = nil; lock.unlock()
        if let entered, let release { entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
    }
    private func accepts(_ request: URLRequest) -> Bool {
        guard request.httpMethod == "GET", let url = request.url,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "itunes.apple.com", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.path == "/lookup", parts.fragment == nil,
              let items = parts.queryItems, items.count == 2 || items.count == 3,
              Set(items.map { $0.name }).count == items.count,
              Set(items.map { $0.name }) == (items.count == 2 ? Set(["bundleId", "_"]) : Set(["bundleId", "_", "country"])),
              items.first(where: { $0.name == "bundleId" })?.value == identifier,
              let stamp = items.first(where: { $0.name == "_" })?.value, !stamp.isEmpty,
              stamp.utf8.allSatisfy({ (48...57).contains($0) }),
              items.count == 2 || items.first(where: { $0.name == "country" })?.value == "US",
              request.value(forHTTPHeaderField: "Accept") == "application/json",
              request.value(forHTTPHeaderField: "User-Agent") == "Mindwtr-App",
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.value(forHTTPHeaderField: "Proxy-Authorization") == nil,
              request.value(forHTTPHeaderField: "Cookie") == nil,
              request.httpBody == nil, request.httpBodyStream == nil else { return false }
        return true
    }
    func start(_ transport: AboutLookupProtocol) {
        lock.lock(); requests.append(transport.request)
        guard accepts(transport.request) else {
            unexpected += 1; lock.unlock(); transport.reply(Data(), status: 400); return
        }
        if holdNext {
            holdNext = false; held = transport; let started = entered; entered = nil
            lock.unlock(); started?.fulfill(); return
        }
        guard !replies.isEmpty else {
            unexpected += 1; lock.unlock(); transport.reply(Data(), status: 500); return
        }
        let answer = replies.removeFirst(); lock.unlock(); transport.reply(answer.bytes, status: answer.status)
    }
    func stop(_ transport: AboutLookupProtocol) {
        lock.lock()
        guard held === transport else { lock.unlock(); return }
        held = nil; stopCount += 1; let stopped = self.stopped; self.stopped = nil
        lock.unlock(); stopped?.fulfill()
    }
}

final class AboutAppStoreHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace: String!, service: String!, state: AboutLookupState!
    private var unexpectedBefore = 0
    private let identifier = "tech.example.mindwtr.about-host"
    private let listing = "https://apps.apple.com/app/id123456789"
    private let responseSecret = "synthetic-about-response-secret"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/" + namespace + "/RCTAsyncLocalStorage_V1/manifest.json") }
    private var logURL: URL { root.appendingPathComponent("logs/mindwtr.log") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build actual production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured About bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("AboutAppStoreHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("About fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.example.mindwtr.about." + UUID().uuidString.lowercased()
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "about-unknown": "Keep synthetic About preferences 文"]).utf8).write(to: manifest)
        state = AboutLookupState(identifier: identifier); unexpectedBefore = AboutLookupProtocol.unexpectedCount
        AboutLookupProtocol.install(state)
    }
    override func tearDownWithError() throws {
        if let state {
            XCTAssertEqual(state.unexpectedCount, 0, "Every request must match the private Apple lookup grammar")
            XCTAssertEqual(state.secretCount, 0, "About never enters native credential storage")
        }
        XCTAssertEqual(AboutLookupProtocol.unexpectedCount, unexpectedBefore, "No request may escape fixture interception")
        AboutLookupProtocol.install(nil)
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func reply(_ version: String, url: String? = nil) throws -> AboutLookupState.Reply {
        AboutLookupState.Reply(bytes: Data(try json(["results": [["version": version, "trackViewUrl": url ?? listing]]]).utf8), status: 200)
    }
    private func host() -> CoreHost {
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral, state = self.state!
        configuration.protocolClasses = [AboutLookupProtocol.self]; faults.httpConfiguration = configuration
        faults.configureHTTPJobs = { jobs in state.capture(jobs); jobs.beforeCompletion = { state.beforeCompletion() } }
        faults.secretService = service; faults.secretBeforeOperation = { _, _ in state.secretOperation() }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ value: CoreHost) async throws {
        let count = state.recorded.count
        _ = try await value.start(); XCTAssertEqual(state.recorded.count, count, "Startup never performs an About lookup")
    }
    private func seededHost() async throws -> CoreHost {
        let bootstrap = host(); try await start(bootstrap); await bootstrap.close()
        do {
            let sql = try SQLiteBridge(url: database), at = "2026-10-08T00:00:00.000Z"
            defer { sql.close() }
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('about-kept-task','Keep About task 文','inbox','[]','[]','Keep exact notes',?,?,3,'fixture',0,0,0,0)", parametersJSON: json([at, at]))
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,createdAt,updatedAt,rev,revBy) VALUES ('about-kept-project','Keep About Project','active','#123456',1,'[]',0,0,'Keep exact Project notes',?,?,4,'fixture')", parametersJSON: json([at, at]))
        }
        let value = host(); try await start(value); return value
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
    private func assertPreserved(_ baseline: [String: String], _ settings: Data) throws {
        XCTAssertEqual(try rows(), baseline); XCTAssertEqual(try Data(contentsOf: manifest), settings)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        XCTAssertEqual(state.secretCount, 0)
    }
    private func assertRegions(_ requests: ArraySlice<URLRequest>, _ expected: [String]) throws {
        let actual = try requests.map { request -> String in
            let parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            return parts.queryItems?.first { $0.name == "country" }?.value ?? "default"
        }
        XCTAssertEqual(actual, expected)
    }
    private func assertDiagnostics(_ count: Int) throws {
        let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        let entries = try log.split(separator: "\n").filter { $0.contains("v1.3.5/ios-about-app-store") }.map { try object(String($0)) }
        XCTAssertEqual(entries.count, count)
        for entry in entries {
            XCTAssertEqual(entry["scope"] as? String, "native-ios")
            XCTAssertEqual(entry["message"] as? String, "Native iOS App Store information fetched")
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-about-app-store", "outcome": "fetched"])
        }
        for privateValue in [identifier, listing, responseSecret, namespace!, service!] { XCTAssertFalse(log.contains(privateValue)) }
    }
    private func drained() async throws {
        for _ in 0..<200 {
            if let counters = state.counters, counters.jobs == 0 && counters.running == 0 { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("About HTTP jobs must drain before the invocation settles")
        XCTAssertEqual(state.counters?.jobs, 0); XCTAssertEqual(state.counters?.running, 0)
    }

    func testLatestRegionAndInstalledVersionComparisonPreserveDataAndColdStartupIsInactive() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        state.enqueue(try [reply("1.4.0"), reply("2.0.0"), reply("1.4.0"), reply("2.0.0")])
        for (installed, available) in [("1.5.0", true), ("v2.0.0-beta+build", false)] {
            let answer = try object(await value.aboutAppStoreInfo(bundleIdentifier: identifier, currentVersion: installed))
            XCTAssertEqual(Set(answer.keys), Set(["version", "trackViewUrl", "updateAvailable"]))
            XCTAssertEqual(answer["version"] as? String, "2.0.0"); XCTAssertEqual(answer["trackViewUrl"] as? String, listing)
            XCTAssertEqual(answer["updateAvailable"] as? Bool, available)
            try assertPreserved(baseline, settings); try await drained()
        }
        try assertRegions(state.recorded[...], ["default", "US", "default", "US"]); try assertDiagnostics(2)
        await value.close(); let cold = host(); try await start(cold)
        try assertPreserved(baseline, settings); XCTAssertEqual(state.recorded.count, 4); try assertDiagnostics(2)
        await cold.close()
    }

    func testUnsafeListingIsNullAndNeverExposesResponseCredentials() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        let unsafe = "https://fixture:" + responseSecret + "@apps.apple.com/app/id123456789"
        state.enqueue(try [reply("2.0.0", url: unsafe), reply("2.0.0", url: unsafe)])
        let answer = try object(await value.aboutAppStoreInfo(bundleIdentifier: identifier, currentVersion: "1.0.0"))
        XCTAssertEqual(Set(answer.keys), Set(["version", "trackViewUrl", "updateAvailable"]))
        XCTAssertEqual(answer["version"] as? String, "2.0.0"); XCTAssertTrue(answer["trackViewUrl"] is NSNull)
        XCTAssertEqual(answer["updateAvailable"] as? Bool, true)
        try assertRegions(state.recorded[...], ["default", "US"]); try assertPreserved(baseline, settings)
        try assertDiagnostics(1); try await drained(); await value.close()
    }

    func testHTTPAndJSONFailuresReturnOnlyFixedFailureAndPreserveState() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        for (response, requests) in [(AboutLookupState.Reply(bytes: Data(responseSecret.utf8), status: 503), 2),
                                     (AboutLookupState.Reply(bytes: Data(("invalid JSON " + responseSecret).utf8), status: 200), 1)] {
            let before = state.recorded.count; state.enqueue(Array(repeating: response, count: requests))
            do {
                _ = try await value.aboutAppStoreInfo(bundleIdentifier: identifier, currentVersion: "1.0.0")
                XCTFail("A failed lookup cannot publish App Store information")
            } catch { XCTAssertEqual(error.localizedDescription, "LOOKUP_FAILED: App Store lookup could not be completed") }
            try assertRegions(state.recorded.dropFirst(before), requests == 2 ? ["default", "US"] : ["default"])
            try assertPreserved(baseline, settings); try assertDiagnostics(0); try await drained()
        }
        await value.close()
    }

    func testInvalidIdentityAndInstalledVersionRefuseBeforeAnyHTTP() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        for (bundleID, version, failure) in [("single", "1.0.0", "INVALID_INPUT: Invalid App Store bundle identifier"),
                                           ("tech.example/invalid", "1.0.0", "INVALID_INPUT: Invalid App Store bundle identifier"),
                                           (identifier, "", "INVALID_INPUT: Invalid installed app version"),
                                           (identifier, "1.0\n", "INVALID_INPUT: Invalid installed app version")] {
            do {
                _ = try await value.aboutAppStoreInfo(bundleIdentifier: bundleID, currentVersion: version)
                XCTFail("Invalid About lookup input must refuse")
            } catch { XCTAssertEqual(error.localizedDescription, failure) }
            XCTAssertEqual(state.recorded.count, 0); try assertPreserved(baseline, settings)
        }
        try assertDiagnostics(0); try await drained(); await value.close()
    }

    func testCancelledHeldLookupStopsAndDrainsBeforeSameHostRetry() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        let entered = expectation(description: "Actual held Apple lookup"), stopped = expectation(description: "Held URLSession request stopped")
        let completion = expectation(description: "Native cancellation completion"), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        state.hold(entered: entered, stopped: stopped, completion: completion, release: release)
        let state = self.state!
        let pending = Task {
            defer { state.markSettled() }
            return try await value.aboutAppStoreInfo(bundleIdentifier: self.identifier, currentVersion: "1.0.0")
        }
        await fulfillment(of: [entered], timeout: 3); pending.cancel()
        await fulfillment(of: [stopped, completion], timeout: 3)
        XCTAssertFalse(state.hasSettled, "Cancellation cannot return while its native completion is held")
        XCTAssertEqual(state.counters?.running, 1); XCTAssertEqual(state.recorded.count, 1)
        release.signal()
        do { _ = try await pending.value; XCTFail("The cancelled lookup must never publish late success") }
        catch is CancellationError {} catch { XCTFail("The caller must receive cancellation") }
        XCTAssertEqual(state.stoppedCount, 1); try await drained()
        try assertRegions(state.recorded[...], ["default"]); try assertDiagnostics(0); try assertPreserved(baseline, settings)
        state.enqueue(try [reply("1.4.0"), reply("2.0.0")])
        let answer = try object(await value.aboutAppStoreInfo(bundleIdentifier: identifier, currentVersion: "1.0.0"))
        XCTAssertEqual(answer["version"] as? String, "2.0.0"); XCTAssertEqual(answer["trackViewUrl"] as? String, listing)
        XCTAssertEqual(answer["updateAvailable"] as? Bool, true)
        try assertRegions(state.recorded[...], ["default", "default", "US"])
        try assertDiagnostics(1); try assertPreserved(baseline, settings); try await drained(); await value.close()
    }
}
