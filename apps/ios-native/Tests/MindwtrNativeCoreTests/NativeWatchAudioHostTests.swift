import Foundation
import XCTest
import Security
@testable import MindwtrNativeCore

private final class WatchAudioFixtureHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((WatchAudioFixtureHTTP) -> Void)?
    static func install(_ value: @escaping (WatchAudioFixtureHTTP) -> Void) { lock.lock(); handler = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let selected = Self.handler; Self.lock.unlock()
        guard let host = request.url?.host, ["generativelanguage.googleapis.com", "api.openai.com", "speech.local"].contains(host), let selected else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        selected(self)
    }
    override func stopLoading() {}
    func reply(_ bytes: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    func fail() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    func body() throws -> Data {
        if let bytes = request.httpBody { return bytes }
        guard let stream = request.httpBodyStream else { throw HostFailure("Fixture request body is missing") }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let read = stream.read(&buffer, maxLength: 4096)
            guard read >= 0 else { throw HostFailure("Fixture request body failed") }
            if read == 0 { return bytes }
            bytes.append(contentsOf: buffer.prefix(read))
            guard bytes.count <= 8 * 1024 * 1024 else { throw HostFailure("Fixture request body exceeded its bound") }
        }
    }
}

private struct WatchAudioFixtureRequest: Sendable {
    let url: String
    let authorization: String?
    let contentType: String?
    let body: Data
}

private final class WatchAudioFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0, loads = 0, checks = 0, journalWrites = 0
    private var failJournalAt: Int?
    private var sent: [WatchAudioFixtureRequest] = []
    private var secrets = 0
    func request() { lock.lock(); requests += 1; lock.unlock() }
    func load() { lock.lock(); loads += 1; lock.unlock() }
    func check() { lock.lock(); checks += 1; lock.unlock() }
    func secret() { lock.lock(); secrets += 1; lock.unlock() }
    var secretCount: Int { lock.lock(); defer { lock.unlock() }; return secrets }
    var sentRequests: [WatchAudioFixtureRequest] { lock.lock(); defer { lock.unlock() }; return sent }
    func record(_ transport: WatchAudioFixtureHTTP) throws {
        let value = WatchAudioFixtureRequest(url: transport.request.url!.absoluteString,
            authorization: transport.request.value(forHTTPHeaderField: "Authorization"),
            contentType: transport.request.value(forHTTPHeaderField: "Content-Type"), body: try transport.body())
        lock.lock(); requests += 1; sent.append(value); lock.unlock()
    }
    var counts: (requests: Int, loads: Int, checks: Int) { lock.lock(); defer { lock.unlock() }; return (requests, loads, checks) }
    func failJournal(_ at: Int?) { lock.lock(); journalWrites = 0; failJournalAt = at; lock.unlock() }
    func beforeJournal() throws {
        lock.lock(); journalWrites += 1; let fail = failJournalAt == journalWrites; lock.unlock()
        if fail { throw HostFailure("Synthetic Watch audio journal failure") }
    }
}

final class NativeWatchAudioHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, state: WatchAudioFixtureState!, service: String!
    private let namespace = "mindwtr.watch.audio.fixture", at = "2026-10-31T12:00:00.000Z"
    private let sentinel = "SYNTHETIC-WATCH-AUDIO-CREDENTIAL"
    private let openAISentinel = "SYNTHETIC-OPENAI-WATCH-CREDENTIAL"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL { root.appendingPathComponent("device/Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build production bundle") }
        let home = FileManager.default.homeDirectoryForCurrentUser
        root = home.appendingPathComponent(".mindwtr-native-tests/watch-audio-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath(); bundle = URL(fileURLWithPath: path)
        state = WatchAudioFixtureState(); service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["mindwtr-ai-key:gemini": sentinel, "mindwtr-ai-key:openai": openAISentinel]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { try NativeVoiceJSON.encode(value) }
    private func host(configure: (HostIOFaults) -> Void = { _ in }) -> CoreHost {
        let faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral, state = self.state!
        config.protocolClasses = [WatchAudioFixtureHTTP.self]; faults.httpConfiguration = config; faults.secretService = service
        faults.journalWrite = { try state.beforeJournal() }
        configure(faults)
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (root.appendingPathComponent("device"), namespace))
        addTeardownBlock { await core.close() }; return core
    }
    @discardableResult private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let connection = try SQLiteBridge(url: database); defer { connection.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(connection.execute(sql, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func seed(provider: String = "gemini", enabled: Bool = true, model: String? = nil,
                      baseURL: String? = nil, language: String = "auto", mode: String = "smart_parse") async throws {
        let core = host(); _ = try await core.start(); await core.close()
        let raw = try XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)
        var settings = try NativeVoiceJSON.object(raw, maximum: 1024 * 1024)
        var speech: [String: Any] = ["provider": provider, "enabled": enabled, "model": model ?? (provider == "openai" ? "gpt-transcribe" : "gemini-2.5-flash"),
            "mode": mode, "fieldStrategy": "smart", "language": language]
        if let baseURL { speech["baseUrl"] = baseURL }
        settings["ai"] = ["provider": "openai", "model": "gpt-test-primary", "speechToText": speech]
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }
    private func source() throws -> NativeWatchAudio {
        let id = UUID().uuidString.lowercased()
        return try NativeWatchAudio(name: id + ".json", body: json(["protocolVersion": 1, "id": id,
            "source": "apple-watch", "kind": "audio", "createdAt": at,
            "audioPath": "file:///previous-container/Documents/watch-audio/" + id + ".wav"]))
    }
    private func loader(refuse: Bool = false, bytes: Data = Data("receiver-validated synthetic WAV".utf8)) -> @Sendable () async throws -> NativeWatchAudioBytes {
        let state = self.state!
        return {
            state.load()
            if refuse { throw HostFailure("Synthetic unavailable WAV") }
            return NativeWatchAudioBytes(bytes: bytes, validate: { state.check() })
        }
    }
    private func reply(_ transcript: String) throws {
        let state = self.state!, payload = try JSONSerialization.data(withJSONObject: ["candidates": [["content": ["parts": [[
            "text": try json(["title": "Provider title must be ignored", "description": "Provider description must be ignored", "transcript": transcript])
        ]]]]]])
        WatchAudioFixtureHTTP.install { transport in state.request(); transport.reply(payload) }
    }
    private func assertNoSave() throws {
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 0)
    }

    private func openAIResponse(_ transcript: String, api: NativeOpenAISpeechAPI? = nil) throws -> Data {
        let speech = try json(["title": "Provider title must be ignored", "transcript": transcript])
        let value: [String: Any]
        switch api {
        case .some(.responses): value = ["output_text": speech]
        case .some(.chat): value = ["choices": [["message": ["content": speech]]]]
        case .none: value = ["text": transcript]
        }
        return try JSONSerialization.data(withJSONObject: value)
    }
    private func openAIReplies(_ replies: [Data?]) {
        let state = self.state!, base = state.counts.requests
        WatchAudioFixtureHTTP.install { transport in
            do {
                try state.record(transport)
                let index = state.counts.requests - base - 1
                guard index < replies.count else { XCTFail("Unexpected extra speech request"); transport.fail(); return }
                if let bytes = replies[index] { transport.reply(bytes) } else { transport.fail() }
            } catch { XCTFail("Fixture request body could not be read"); transport.fail() }
        }
    }

    func testStrictSourceAndTranscriptEnvelopeRefuseMalformedInput() throws {
        let selected = try source(), valid = try selected.envelope(transcript: "Synthetic transcript")
        XCTAssertEqual(try NativeWatchAudio.readEnvelope(valid).source.body, selected.body)
        XCTAssertThrowsError(try selected.envelope(transcript: ""))
        XCTAssertThrowsError(try selected.envelope(transcript: "  transcript  "))
        XCTAssertThrowsError(try selected.envelope(transcript: String(repeating: "x", count: 64 * 1024 + 1)))
        XCTAssertThrowsError(try NativeWatchAudio(name: selected.name, body: selected.body.replacingOccurrences(of: "\"audio\"", with: "\"text\"")))
        XCTAssertThrowsError(try NativeWatchAudio(name: selected.name, body: String(selected.body.dropLast()) + ",\"kind\":\"audio\"}"))
        var envelope = try NativeVoiceJSON.object(valid, maximum: 1024 * 1024)
        envelope.removeValue(forKey: "transcript")
        XCTAssertThrowsError(try NativeWatchAudio.readEnvelope(json(envelope)))
        envelope["transcript"] = "Synthetic transcript"; envelope["requestId"] = UUID().uuidString.lowercased()
        XCTAssertThrowsError(try NativeWatchAudio.readEnvelope(json(envelope)))
    }

    func testRawHostMethodsCannotGrantAudioAuthority() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let selected = try source()
        for (method, argument) in [("iosWatchAudioOutcome", selected.body), ("iosWatchAudioNeedsTranscript", selected.body),
                                   ("iosWatchAudioIngest", try selected.envelope(transcript: "Synthetic transcript"))] {
            do { _ = try await core.call(method, argumentsJSON: json([argument])); XCTFail("Raw audio authority was admitted") } catch {}
        }
        try assertNoSave()
    }

    func testUnsupportedProviderAndMissingWAVLeaveNoPlaceholderOrReceipt() async throws {
        try await seed(provider: "parakeet"); let core = host(); _ = try await core.start()
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Unsupported provider admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.loads, 0); try assertNoSave(); await core.close()
        try await seed(); let ready = host(); _ = try await ready.start()
        do { try await ready.ingestWatchAudio(source(), load: loader(refuse: true)); XCTFail("Missing WAV admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.requests, 0); try assertNoSave()
    }

    func testWhisperMissingModelRetainsQueueWithoutReadingAudioOrProvider() async throws {
        try await seed(provider: "whisper")
        let core = host(); _ = try await core.start()
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Missing local model admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.loads, 0)
        XCTAssertEqual(state.counts.requests, 0)
        XCTAssertEqual(state.counts.checks, 0)
        try assertNoSave()
    }

    func testNetworkFailureAndEmptyTranscriptRemainRetryableWithoutWrites() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let state = self.state!
        WatchAudioFixtureHTTP.install { transport in state.request(); transport.fail() }
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Network failure admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        try assertNoSave(); try reply(" \n ")
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Empty transcript admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.requests, 2); XCTAssertEqual(state.counts.checks, 0); try assertNoSave()
    }

    func testCanonicalTombstoneCreatesReceiptWithoutReadingWAVOrProvider() async throws {
        try await seed(provider: "whisper"); let selected = try source()
        try rows("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,?,'inbox','[]','[]',?,?,?,1,'fixture')",
                 [selected.id, "Synthetic deleted capture", at, at, at])
        let core = host(); _ = try await core.start()
        try await core.ingestWatchAudio(selected, load: loader(refuse: true))
        XCTAssertEqual(state.counts.loads, 0); XCTAssertEqual(state.counts.requests, 0)
        XCTAssertEqual(try rows("SELECT title FROM tasks WHERE id=?", [selected.id]).first?["title"] as? String, "Synthetic deleted capture")
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 1)
    }

    func testReadmissionAndReceiverGenerationAreCheckedBeforeJournalPublication() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let selected = try source(), state = self.state!
        do { try await core.ingestWatchAudio(selected, load: loader(), readmit: { false }); XCTFail("Closed intake owner admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        XCTAssertEqual(state.counts.loads, 0)
        try reply("Synthetic spoken capture")
        do {
            try await core.ingestWatchAudio(selected, load: {
                state.load()
                return NativeWatchAudioBytes(bytes: Data("receiver-validated synthetic WAV".utf8), validate: {
                    state.check(); throw HostFailure("Synthetic replaced WAV generation")
                })
            })
            XCTFail("Replaced receiver generation admitted")
        } catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.requests, 1); XCTAssertEqual(state.counts.checks, 1); try assertNoSave()
    }

    func testTranscriptJournalRecoversWithoutUploadAndReceiptSurvivesPurgedTask() async throws {
        try await seed(provider: "whisper"); let selected = try source()
        try Data(json(["version": 2, "method": "iosWatchAudioIngest", "argumentsJSON": json([selected.envelope(transcript: "Synthetic retained transcript")])]).utf8).write(to: journal)
        let cold = host(); _ = try await cold.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try await cold.ingestWatchAudio(selected, load: loader(refuse: true)); await cold.close()
        XCTAssertEqual(try rows("SELECT title FROM tasks WHERE id=?", [selected.id]).first?["title"] as? String, "Synthetic retained transcript")
        try rows("DELETE FROM tasks WHERE id=?", [selected.id])
        let reopened = host(); _ = try await reopened.start()
        try await reopened.ingestWatchAudio(selected, load: loader(refuse: true))
        XCTAssertEqual(state.counts.loads, 0); XCTAssertEqual(state.counts.requests, 0)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
    }

    func testMissingTranscriptJournalCannotCreateTaskOrReceipt() async throws {
        try await seed(); let selected = try source()
        try Data(json(["version": 2, "method": "iosWatchAudioIngest", "argumentsJSON": json([selected.envelope(transcript: nil)])]).utf8).write(to: journal)
        let cold = host()
        do { _ = try await cold.start(); XCTFail("Missing transcript replay admitted") } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 0)
        XCTAssertEqual(state.counts.requests, 0)
    }

    func testPendingReplayRequiresExactSourceUTF8() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let original = try source()
        let selected = try NativeWatchAudio(name: original.name, body: original.body.replacingOccurrences(of: "previous-container", with: "caf\u{00e9}"))
        let changed = try NativeWatchAudio(name: selected.name, body: selected.body.replacingOccurrences(of: "caf\u{00e9}", with: "cafe\u{0301}"))
        XCTAssertEqual(selected.body, changed.body)
        XCTAssertNotEqual(Data(selected.body.utf8), Data(changed.body.utf8))
        try reply("Synthetic exact source"); state.failJournal(2)
        do { try await core.ingestWatchAudio(selected, load: loader()); XCTFail("Expected retained journal") } catch {}
        let retained = try Data(contentsOf: journal); state.failJournal(nil)
        do { try await core.ingestWatchAudio(changed, load: loader()); XCTFail("Different source bytes were admitted") } catch {}
        XCTAssertEqual(try Data(contentsOf: journal), retained)
        XCTAssertEqual(state.counts.requests, 1)
        try await core.ingestWatchAudio(selected, load: loader(refuse: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostTerminalJournalReplaysWithoutSecondUploadAndKeepsCredentialsNative() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let selected = try source()
        try reply("  Synthetic spoken capture  "); state.failJournal(2)
        do { try await core.ingestWatchAudio(selected, load: loader()); XCTFail("Lost terminal write must remain pending") }
        catch { XCTAssertFalse(error is NativeWatchAudioRetryable) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        let retained = try String(contentsOf: journal)
        XCTAssertTrue(retained.contains("Synthetic spoken capture")); XCTAssertFalse(retained.contains(sentinel))
        XCTAssertEqual(state.counts.requests, 1); XCTAssertEqual(state.counts.checks, 1)
        state.failJournal(nil); await core.close()
        let cold = host(); _ = try await cold.start()
        try await cold.ingestWatchAudio(selected, load: loader(refuse: true))
        XCTAssertEqual(state.counts.requests, 1); XCTAssertEqual(state.counts.loads, 1)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic spoken capture")
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(sentinel))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOpenAIMultipartPreservesBinaryWAVAndUsesOnlySelectedCredential() async throws {
        try await seed(provider: "openai", language: "fr-FR", mode: "transcribe_only")
        let core = host(); _ = try await core.start(); let selected = try source(), bytes = Data([0, 255, 13, 10, 128, 0, 127])
        openAIReplies([try openAIResponse("  Synthetic OpenAI capture  ")])
        try await core.ingestWatchAudio(selected, load: loader(bytes: bytes))
        let sent = try XCTUnwrap(state.sentRequests.first)
        XCTAssertEqual(sent.url, "https://api.openai.com/v1/audio/transcriptions")
        XCTAssertEqual(sent.authorization, "Bearer " + openAISentinel)
        XCTAssertTrue(sent.contentType?.hasPrefix("multipart/form-data; boundary=Mindwtr-") == true)
        XCTAssertNotNil(sent.body.range(of: bytes))
        let fields = String(decoding: sent.body, as: UTF8.self)
        XCTAssertTrue(fields.contains("name=\"languages[]\"\r\n\r\nfr\r\n"))
        XCTAssertTrue(fields.contains("filename=\"" + selected.id + ".wav\"\r\nContent-Type: audio/wav"))
        XCTAssertFalse(fields.contains(sentinel)); XCTAssertFalse(fields.contains(openAISentinel))
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic OpenAI capture")
        XCTAssertEqual(state.counts.requests, 1); XCTAssertEqual(state.counts.checks, 1)
    }

    func testCustomKeylessOpenAISTTSucceedsInSmartModeWithoutParseUpload() async throws {
        try Data(json(["mindwtr-ai-key:gemini": sentinel]).utf8).write(to: manifest)
        try await seed(provider: "openai", model: "whisper-1", baseURL: "http://speech.local:8123/v1", language: "English")
        let core = host(); _ = try await core.start()
        openAIReplies([try openAIResponse("Synthetic local speech")])
        try await core.ingestWatchAudio(source(), load: loader())
        let sent = try XCTUnwrap(state.sentRequests.first)
        XCTAssertEqual(sent.url, "http://speech.local:8123/v1/audio/transcriptions")
        XCTAssertNil(sent.authorization)
        XCTAssertTrue(String(decoding: sent.body, as: UTF8.self).contains("name=\"language\"\r\n\r\nen\r\n"))
        XCTAssertEqual(state.counts.requests, 1)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic local speech")
    }

    func testOfficialOpenAIRequiresItsOwnCredentialAndNeverUsesGeminiFallback() async throws {
        try Data(json(["mindwtr-ai-key:gemini": sentinel]).utf8).write(to: manifest)
        try await seed(provider: "openai", mode: "transcribe_only")
        let core = host(); _ = try await core.start()
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Missing OpenAI credential admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.loads, 0); XCTAssertEqual(state.counts.requests, 0); try assertNoSave()
    }

    func testUnavailableSecureStoreRefusesEvenKeylessCustomOpenAI() async throws {
        try Data(json(["mindwtr-ai-key:gemini": sentinel]).utf8).write(to: manifest)
        try await seed(provider: "openai", baseURL: "https://speech.local/v1", mode: "transcribe_only")
        let core = host { faults in faults.secretStatus = { operation, _ in operation == "ai-metadata" ? errSecInteractionNotAllowed : nil } }
        _ = try await core.start()
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Unavailable secure store admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.loads, 0); XCTAssertEqual(state.counts.requests, 0); try assertNoSave()
    }

    func testUnsafeOpenAIEndpointRefusesBeforeCredentialInspectionOrWAVRead() async throws {
        try await seed(provider: "openai", baseURL: "http://public.example.test/v1", mode: "transcribe_only")
        let state = self.state!, core = host { faults in faults.secretBeforeOperation = { _, _ in state.secret() } }
        _ = try await core.start(); let reads = state.secretCount
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Public insecure endpoint admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.secretCount, reads); XCTAssertEqual(state.counts.loads, 0); try assertNoSave()
    }

    func testOpenAISmartParseTriesResponsesThenChatAndKeepsOnlyTranscript() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        openAIReplies([try openAIResponse("Synthetic initial speech"), Data("{}".utf8), try openAIResponse("Synthetic parsed speech", api: .chat)])
        try await core.ingestWatchAudio(source(), load: loader())
        XCTAssertEqual(state.sentRequests.map(\.url), ["https://api.openai.com/v1/audio/transcriptions",
            "https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"])
        XCTAssertTrue(state.sentRequests.allSatisfy { $0.authorization == "Bearer " + openAISentinel })
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic parsed speech")
    }

    func testOpenAISmartParseRetriesModelThenFallsBackToInitialTranscript() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        openAIReplies([try openAIResponse("Synthetic fallback speech"), nil, Data("{}".utf8), nil, Data("{}".utf8)])
        try await core.ingestWatchAudio(source(), load: loader())
        let sent = state.sentRequests
        XCTAssertEqual(sent.map(\.url), ["https://api.openai.com/v1/audio/transcriptions", "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"])
        let models = try sent.dropFirst().map { try NativeVoiceJSON.object(String(decoding: $0.body, as: UTF8.self), maximum: 512 * 1024)["model"] as? String }
        XCTAssertEqual(models[0], "gpt-test-primary"); XCTAssertEqual(models[1], models[0])
        XCTAssertNotEqual(models[2], models[0]); XCTAssertEqual(models[2], models[3])
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic fallback speech")
    }

    func testSuccessfulOpenAIParseWithFalsyTranscriptUsesInitialWithoutRetry() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        for parsed in [["title": "Provider title must be ignored"] as [String: Any], ["transcript": NSNull()],
                       ["transcript": false], ["transcript": 0], ["transcript": ""]] {
            let response = try JSONSerialization.data(withJSONObject: ["output_text": json(parsed)])
            openAIReplies([try openAIResponse("Synthetic initial speech"), response])
            let before = state.counts.requests
            try await core.ingestWatchAudio(source(), load: loader())
            XCTAssertEqual(state.counts.requests - before, 2)
        }
        XCTAssertEqual(try rows("SELECT title FROM tasks").count, 5)
        XCTAssertTrue(try rows("SELECT title FROM tasks").allSatisfy { $0["title"] as? String == "Synthetic initial speech" })
    }

    func testTruthyNontextParsedTranscriptRetainsSourceWithoutFallbackRequests() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        for value in [true, 1, ["unexpected": "value"], ["unexpected"]] as [Any] {
            let response = try JSONSerialization.data(withJSONObject: ["output_text": json(["transcript": value])])
            openAIReplies([try openAIResponse("Synthetic initial speech"), response])
            let before = state.counts.requests
            do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Truthy nontext transcript admitted") }
            catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
            XCTAssertEqual(state.counts.requests - before, 2); try assertNoSave()
        }
    }

    func testWhitespaceParsedTranscriptIsRetryableAndDoesNotFallBackToInitial() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        openAIReplies([try openAIResponse("Synthetic initial speech"), try openAIResponse(" \n ", api: .responses)])
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Whitespace parsed transcript admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.requests, 2); try assertNoSave()
    }

    func testEmptyOpenAITranscriptionDoesNotStartParsingOrCreatePlaceholder() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        openAIReplies([try openAIResponse(" \n ")])
        do { try await core.ingestWatchAudio(source(), load: loader()); XCTFail("Empty transcription admitted") }
        catch { XCTAssertTrue(error is NativeWatchAudioRetryable) }
        XCTAssertEqual(state.counts.requests, 1); try assertNoSave()
    }

    func testOpenAIParseCancellationStopsFallbackAndLeavesSourceUncommitted() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        let parsing = expectation(description: "Parse request is outside Engine"), state = self.state!, initial = try openAIResponse("Synthetic initial speech")
        WatchAudioFixtureHTTP.install { transport in
            do {
                try state.record(transport)
                if state.counts.requests == 1 { transport.reply(initial) }
                else { parsing.fulfill() }
            } catch { transport.fail() }
        }
        let selected = try source(), load = loader()
        let task = Task { try await core.ingestWatchAudio(selected, load: load) }
        await fulfillment(of: [parsing], timeout: 5); task.cancel()
        do { try await task.value; XCTFail("Cancelled parsing admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        XCTAssertEqual(state.counts.requests, 2); try assertNoSave()
    }

    func testOpenAIJournalReplayAndPurgedTaskReceiptDoNotReadOrUploadAgain() async throws {
        try await seed(provider: "openai", mode: "transcribe_only"); let core = host(); _ = try await core.start(); let selected = try source()
        openAIReplies([try openAIResponse("Synthetic durable OpenAI speech")]); state.failJournal(2)
        do { try await core.ingestWatchAudio(selected, load: loader()); XCTFail("Lost terminal journal must remain pending") }
        catch { XCTAssertFalse(error is NativeWatchAudioRetryable) }
        let retained = try String(contentsOf: journal)
        XCTAssertFalse(retained.contains(openAISentinel)); XCTAssertFalse(retained.contains(sentinel))
        state.failJournal(nil)
        try await core.ingestWatchAudio(selected, load: loader(refuse: true)); await core.close()
        try rows("DELETE FROM tasks WHERE id=?", [selected.id])
        let cold = host(); _ = try await cold.start()
        try await cold.ingestWatchAudio(selected, load: loader(refuse: true))
        XCTAssertEqual(state.counts.loads, 1); XCTAssertEqual(state.counts.requests, 1)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(openAISentinel))
    }

    func testOpenAIPrivateMethodsRefuseRawHostAuthority() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        do { _ = try await core.call("iosWatchOpenAIRuntime"); XCTFail("Raw runtime read admitted") } catch {}
        for method in ["iosVoiceOpenAITranscriptionBuild", "iosVoiceOpenAITranscriptionDecode", "iosVoiceOpenAIParseBuild", "iosVoiceOpenAIParseDecode"] {
            do { _ = try await core.call(method, argumentsJSON: json(["{}"])); XCTFail("Raw provider operation admitted") } catch {}
        }
        try assertNoSave()
    }

    func testPrivateOpenAIRuntimeAndMultipartEnforceClosedInputAndNativeBounds() throws {
        let value: [String: Any] = ["version": 1, "provider": "openai", "enabled": true, "model": "gpt-transcribe", "language": "auto",
            "mode": "transcribe_only", "fieldStrategy": "smart", "endpoint": "https://api.openai.com/v1/audio/transcriptions",
            "credentialRequired": true, "parseModel": "gpt-primary", "retryModel": "gpt-retry"]
        let runtime = try NativeWatchOpenAIRuntime.validated(json(value)), id = UUID().uuidString.lowercased()
        let fields = [["model", "gpt-transcribe"], ["response_format", "json"]]
        let bounded = try runtime.multipart(fields: fields, bytes: Data(repeating: 0, count: 4 * 1024 * 1024), sourceID: id)
        XCTAssertLessThan(bounded.body.count, 8 * 1024 * 1024)
        XCTAssertThrowsError(try runtime.multipart(fields: fields, bytes: Data(repeating: 0, count: 4 * 1024 * 1024 + 1), sourceID: id))
        XCTAssertThrowsError(try runtime.multipart(fields: fields + [["file", "injected"]], bytes: Data([1]), sourceID: id))
        XCTAssertThrowsError(try runtime.multipart(fields: [["model", "changed"], ["response_format", "json"]], bytes: Data([1]), sourceID: id))
        for change in [["version": true] as [String: Any], ["extra": true], ["endpoint": "https://credential@example.test/v1/audio/transcriptions"],
                       ["endpoint": "http://public.example.test/v1/audio/transcriptions"], ["model": "bad\r\nfield"]] {
            var changed = value; changed.merge(change) { _, new in new }
            XCTAssertThrowsError(try NativeWatchOpenAIRuntime.validated(json(changed)))
        }
    }
}
