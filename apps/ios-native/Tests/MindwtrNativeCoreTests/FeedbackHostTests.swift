import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

/// Intercept every destination, including malformed URLs and redirects. This
/// fixture never submits real feedback or proves live service availability.
private final class FeedbackProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var state: FeedbackState?
    private static var unexpected = 0
    private var owner: FeedbackState?
    static var unexpectedCount: Int { lock.lock(); defer { lock.unlock() }; return unexpected }
    static func install(_ value: FeedbackState?) { lock.lock(); state = value; lock.unlock() }
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
    func reply(_ bytes: Data, status: Int, headers: [String: String] = [:]) {
        var fields = ["Content-Type": "application/json", "Content-Length": String(bytes.count)]
        fields.merge(headers) { _, next in next }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: fields)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class FeedbackState: @unchecked Sendable {
    struct Reply { let bytes: Data; let status: Int; var headers: [String: String] = [:] }
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var replies: [Reply] = []
    private var held: FeedbackProtocol?
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
    private var bodies: [Data] = []
    var recordedBodies: [Data] { lock.lock(); defer { lock.unlock() }; return bodies }
    private func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
            if bytes.count > 256_000 { break }
        }
        return bytes
    }
    private func accepts(_ request: URLRequest, body: Data) -> Bool {
        guard request.httpMethod == "POST", let url = request.url,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "feedback.mindwtr.app", parts.port == nil,
              parts.user == nil, parts.password == nil, ["", "/"].contains(parts.path),
              parts.query == nil, parts.fragment == nil,
              request.value(forHTTPHeaderField: "Content-Type") == "application/json",
              request.value(forHTTPHeaderField: "Authorization") == nil,
              request.value(forHTTPHeaderField: "Proxy-Authorization") == nil,
              request.value(forHTTPHeaderField: "Cookie") == nil,
              !body.isEmpty, body.count <= 256_000,
              (try? NativeJSON.jsonObject(with: body)) is [String: Any] else { return false }
        return true
    }
    func start(_ transport: FeedbackProtocol) {
        let bytes = body(transport.request)
        lock.lock(); requests.append(transport.request); bodies.append(bytes)
        guard accepts(transport.request, body: bytes) else {
            unexpected += 1; lock.unlock(); transport.reply(Data(), status: 400); return
        }
        if holdNext {
            holdNext = false; held = transport; let started = entered; entered = nil
            lock.unlock(); started?.fulfill(); return
        }
        guard !replies.isEmpty else {
            unexpected += 1; lock.unlock(); transport.reply(Data(), status: 500); return
        }
        let answer = replies.removeFirst(); lock.unlock(); transport.reply(answer.bytes, status: answer.status, headers: answer.headers)
    }
    func stop(_ transport: FeedbackProtocol) {
        lock.lock()
        guard held === transport else { lock.unlock(); return }
        held = nil; stopCount += 1; let stopped = self.stopped; self.stopped = nil
        lock.unlock(); stopped?.fulfill()
    }
}

final class FeedbackHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, namespace: String!, service: String!, state: FeedbackState!
    private var unexpectedBefore = 0
    private let endpoint = "https://feedback.mindwtr.app"
    private let message = "Synthetic private feedback body"
    private let email = "synthetic-private@example.test"
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
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured feedback bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("FeedbackHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Feedback fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        namespace = "tech.example.mindwtr.about." + UUID().uuidString.lowercased()
        service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off", "about-unknown": "Keep synthetic About preferences 文"]).utf8).write(to: manifest)
        state = FeedbackState(); unexpectedBefore = FeedbackProtocol.unexpectedCount
        FeedbackProtocol.install(state)
    }
    override func tearDownWithError() throws {
        if let state {
            XCTAssertEqual(state.unexpectedCount, 0, "Every request must match the exact synthetic feedback POST grammar")
            XCTAssertEqual(state.secretCount, 0, "Feedback never enters native credential storage")
        }
        XCTAssertEqual(FeedbackProtocol.unexpectedCount, unexpectedBefore, "No request may escape fixture interception")
        FeedbackProtocol.install(nil)
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ value: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any]) }
    private func host(byteLimit: Int? = nil) -> CoreHost {
        let faults = HostIOFaults(), configuration = URLSessionConfiguration.ephemeral, state = self.state!
        configuration.protocolClasses = [FeedbackProtocol.self]; faults.httpConfiguration = configuration; faults.httpByteLimit = byteLimit
        faults.configureHTTPJobs = { jobs in state.capture(jobs); jobs.beforeCompletion = { state.beforeCompletion() } }
        faults.secretService = service; faults.secretBeforeOperation = { _, _ in state.secretOperation() }
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.cryptoBeforeOperation = { _ in XCTFail("Feedback must not access native crypto") }
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func start(_ value: CoreHost) async throws {
        let count = state.recorded.count
        _ = try await value.start(); XCTAssertEqual(state.recorded.count, count, "Startup never performs a feedback request")
    }
    private func seededHost(byteLimit: Int? = nil) async throws -> CoreHost {
        let bootstrap = host(); try await start(bootstrap); await bootstrap.close()
        do {
            let sql = try SQLiteBridge(url: database), at = "2026-10-08T00:00:00.000Z"
            defer { sql.close() }
            _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,description,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES ('about-kept-task','Keep About task 文','inbox','[]','[]','Keep exact notes',?,?,3,'fixture',0,0,0,0)", parametersJSON: json([at, at]))
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,createdAt,updatedAt,rev,revBy) VALUES ('about-kept-project','Keep About Project','active','#123456',1,'[]',0,0,'Keep exact Project notes',?,?,4,'fixture')", parametersJSON: json([at, at]))
        }
        let value = host(byteLimit: byteLimit); try await start(value); return value
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
    private func assertDiagnostics(_ count: Int) throws {
        let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        let entries = try log.split(separator: "\n").filter { $0.contains("v1.3.5/ios-feedback") }.map { try object(String($0)) }
        XCTAssertEqual(entries.count, count)
        for entry in entries {
            XCTAssertEqual(entry["scope"] as? String, "native-ios")
            XCTAssertEqual(entry["message"] as? String, "Native iOS feedback submission acknowledged")
            XCTAssertEqual(entry["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-feedback", "outcome": "sent"])
        }
        for privateValue in [message, email, endpoint, responseSecret, namespace!, service!] { XCTAssertFalse(log.contains(privateValue)) }
    }
    private func drained() async throws {
        for _ in 0..<200 {
            if let counters = state.counters, counters.jobs == 0 && counters.running == 0 { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Feedback HTTP jobs must drain before the invocation settles")
        XCTAssertEqual(state.counters?.jobs, 0); XCTAssertEqual(state.counters?.running, 0)
    }

    private func input(category: String = "bug", diagnostics: Bool = false) throws -> String {
        try json(["category": category, "message": "  " + message + "  ", "email": " " + email + " ", "includeDiagnostics": diagnostics])
    }
    private func payload(_ index: Int) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: state.recordedBodies[index]) as? [String: Any])
    }

    func testExplicitSubmissionUsesActualMetadataAndColdStartupNeverReplays() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        let options = try object(await value.feedbackConfiguration(endpointURL: " " + endpoint + " "))
        XCTAssertEqual(Set(options.keys), Set(["configured", "categories"]))
        XCTAssertEqual(options["configured"] as? Bool, true)
        XCTAssertEqual(options["categories"] as? [String], ["bug", "feature", "other"])
        XCTAssertEqual(state.recorded.count, 0); try assertPreserved(baseline, settings)
        state.enqueue([.init(bytes: Data("not JSON".utf8), status: 201), .init(bytes: Data(), status: 204)])
        for category in ["bug", "feature"] {
            let result = try object(await value.submitFeedback(requestJSON: input(category: category, diagnostics: category == "feature"), endpointURL: endpoint))
            XCTAssertEqual(result as NSDictionary, ["status": "sent"] as NSDictionary)
            try assertPreserved(baseline, settings)
        }
        XCTAssertEqual(state.recorded.count, 2)
        for index in 0..<2 {
            let sent = try payload(index)
            XCTAssertEqual(Set(sent.keys), Set(["category", "message", "email", "metadata", "submittedAt"]))
            XCTAssertEqual(sent["message"] as? String, message); XCTAssertEqual(sent["email"] as? String, email)
            XCTAssertNotNil(ISO8601DateFormatter().date(from: String((sent["submittedAt"] as? String ?? "").prefix(19)) + "Z"))
            var expected = ["platform": "ios", "installChannel": "app-store", "locale": Locale.current.identifier]
            let version = ProcessInfo.processInfo.operatingSystemVersion
            expected["os"] = "ios \(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
            if let text = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String { expected["appVersion"] = text.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let text = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String { expected["build"] = text.trimmingCharacters(in: .whitespacesAndNewlines) }
            XCTAssertEqual(sent["metadata"] as? [String: String], expected)
        }
        try assertDiagnostics(2); try await drained(); await value.close()
        let cold = host(); try await start(cold)
        try assertPreserved(baseline, settings); XCTAssertEqual(state.recorded.count, 2); try assertDiagnostics(2)
        await cold.close()
    }

    func testInvalidConfigurationAndClosedRequestRefuseBeforeAnyPOST() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        for url in ["", "http://feedback.mindwtr.app", endpoint + "/other", endpoint + "?token=private", "https://name:secret@feedback.mindwtr.app", "https://feedback.mindwtr.app.attacker.test"] {
            let options = try object(await value.feedbackConfiguration(endpointURL: url))
            XCTAssertEqual(options["configured"] as? Bool, false)
            do { _ = try await value.submitFeedback(requestJSON: input(), endpointURL: url); XCTFail("Unsafe configuration must refuse") }
            catch { XCTAssertEqual(error.localizedDescription, "feedback_not_configured") }
        }
        for (raw, expected) in [("malformed {", "feedback_invalid_request"),
            (try json(["category": "bug", "message": message, "includeDiagnostics": true, "diagnostics": ["logs": "private"]]), "feedback_invalid_request"),
            (try json(["category": "invalid", "message": message, "includeDiagnostics": true]), "invalid_category"),
            (try json(["category": "bug", "message": " ", "includeDiagnostics": true]), "message_required"),
            (try json(["category": "bug", "message": String(repeating: "a", count: 4001), "includeDiagnostics": true]), "message_too_long"),
            (try json(["category": "bug", "message": message, "email": "invalid", "includeDiagnostics": true]), "invalid_email")] {
            do { _ = try await value.submitFeedback(requestJSON: raw, endpointURL: endpoint); XCTFail("Invalid feedback must refuse") }
            catch { XCTAssertEqual(error.localizedDescription, expected) }
        }
        XCTAssertEqual(state.recorded.count, 0); try assertPreserved(baseline, settings); try assertDiagnostics(0)
        await value.close()
    }

    func testExplicitBugOptInSanitizesCompleteBoundedLinesWithoutPersistingSnapshot() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let saved = try json(["ts": "2026-10-08T00:00:00.000Z", "level": "error", "scope": "sync",
            "message": "Synthetic saved failure Authorization: Bearer private-secret",
            "context": ["password": "private-password", "taskTitle": "private-task-title", "url": "https://name:secret@example.test?token=private-query"], "foreign": "private-extra"])
        let noise = try (0..<500).map { try json(["ts": "2026-10-07T00:00:00.000Z", "level": "info", "scope": "sync", "message": "Routine \($0)"]) }.joined(separator: "\n")
        try Data(("rotated fragment\n" + saved + "\n" + noise + "\n").utf8).write(to: logURL)
        state.enqueue([.init(bytes: Data(), status: 204)])
        let result = try object(await value.submitFeedback(requestJSON: input(diagnostics: true), endpointURL: endpoint))
        XCTAssertEqual(result["status"] as? String, "sent")
        let sent = try payload(0), diagnostic = try XCTUnwrap(sent["diagnostics"] as? [String: String]), logs = try XCTUnwrap(diagnostic["logs"])
        XCTAssertEqual(Set(diagnostic.keys), Set(["logs"])); XCTAssertLessThanOrEqual(logs.utf16.count, 20_000)
        let entries = try logs.split(separator: "\n").map { try object(String($0)) }
        XCTAssertTrue(entries.contains { ($0["message"] as? String)?.contains("Synthetic saved failure") == true })
        XCTAssertEqual(entries.last?["message"] as? String, "Feedback diagnostics snapshot")
        XCTAssertEqual((entries.last?["context"] as? [String: String])?["debugLoggingEnabled"], "false")
        for secret in ["private-secret", "private-password", "private-task-title", "name:secret", "private-query", "private-extra", "rotated fragment"] { XCTAssertFalse(logs.contains(secret)) }
        let persisted = try String(contentsOf: logURL, encoding: .utf8)
        XCTAssertFalse(persisted.contains("Feedback diagnostics snapshot"))
        XCTAssertEqual(state.recorded.count, 1); try assertPreserved(baseline, settings); try assertDiagnostics(1)
        try await drained(); await value.close()
    }

    func testHTTPSizeAndFramingFailuresStayFixedAndNeverRetryOrMutateData() async throws {
        let value = try await seededHost(byteLimit: 4096), baseline = try rows(), settings = try Data(contentsOf: manifest)
        state.enqueue([.init(bytes: Data(responseSecret.utf8), status: 503),
            .init(bytes: Data(repeating: 97, count: 5000), status: 200),
            .init(bytes: Data(), status: 200, headers: ["Content-Length": "invalid"])])
        for index in 1...3 {
            do { _ = try await value.submitFeedback(requestJSON: input(), endpointURL: endpoint); XCTFail("Unconfirmed POST must fail") }
            catch { XCTAssertEqual(error.localizedDescription, "feedback_failed") }
            XCTAssertEqual(state.recorded.count, index); try assertPreserved(baseline, settings); try assertDiagnostics(0); try await drained()
        }
        await value.close()
    }

    func testCancelledPOSTDrainsBeforeSameHostExplicitSuccess() async throws {
        let value = try await seededHost(), baseline = try rows(), settings = try Data(contentsOf: manifest)
        let entered = expectation(description: "Actual held feedback POST"), stopped = expectation(description: "Feedback POST stopped")
        let completion = expectation(description: "Native feedback completion"), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        state.hold(entered: entered, stopped: stopped, completion: completion, release: release)
        let state = self.state!, raw = try input(), endpoint = self.endpoint
        let pending = Task {
            defer { state.markSettled() }
            return try await value.submitFeedback(requestJSON: raw, endpointURL: endpoint)
        }
        await fulfillment(of: [entered], timeout: 3); pending.cancel()
        await fulfillment(of: [stopped, completion], timeout: 3)
        XCTAssertFalse(state.hasSettled); XCTAssertEqual(state.counters?.running, 1); XCTAssertEqual(state.recorded.count, 1)
        release.signal()
        do { _ = try await pending.value; XCTFail("Cancelled POST cannot publish late success") }
        catch is CancellationError {} catch { XCTFail("Expected cancellation") }
        XCTAssertEqual(state.stoppedCount, 1); try await drained(); try assertPreserved(baseline, settings); try assertDiagnostics(0)
        state.enqueue([.init(bytes: Data(), status: 204)])
        let result = try object(await value.submitFeedback(requestJSON: raw, endpointURL: endpoint))
        XCTAssertEqual(result["status"] as? String, "sent"); XCTAssertEqual(state.recorded.count, 2)
        try await drained(); try assertPreserved(baseline, settings); try assertDiagnostics(1); await value.close()
    }

    func testPrecancelledAndUnstartedCallsNeverSubmit() async throws {
        let value = host(), raw = try input(), endpoint = self.endpoint
        do { _ = try await value.feedbackConfiguration(endpointURL: endpoint); XCTFail("Unstarted feedback is unavailable") }
        catch { XCTAssertEqual(error.localizedDescription, "feedback_not_ready") }
        try await start(value)
        let baseline = try rows(), settings = try Data(contentsOf: manifest)
        let pending = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await value.submitFeedback(requestJSON: raw, endpointURL: endpoint)
        }
        do { _ = try await pending.value; XCTFail("Precancelled feedback never submits") }
        catch NativeAttachmentFileJobsError.cancelled {} catch { XCTFail("Expected exact primitive cancellation") }
        XCTAssertEqual(state.recorded.count, 0); try assertPreserved(baseline, settings); try assertDiagnostics(0); await value.close()
    }
}
