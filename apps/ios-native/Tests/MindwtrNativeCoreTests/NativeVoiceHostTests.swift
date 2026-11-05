import XCTest
import Foundation
import Darwin
import Security
@testable import MindwtrNativeCore

private final class VoiceFixtureHTTP: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((VoiceFixtureHTTP) -> Void)?
    static func install(_ body: @escaping (VoiceFixtureHTTP) -> Void) { lock.lock(); handler = body; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let selected = Self.handler; Self.lock.unlock()
        guard let host = request.url?.host, ["generativelanguage.googleapis.com", "api.openai.com", "speech.local"].contains(host), let selected else {
            XCTFail("Unexpected fixture destination"); client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        selected(self)
    }
    override func stopLoading() { }
    func reply(_ bytes: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes); client?.urlProtocolDidFinishLoading(self)
    }
    func fail() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    func body() throws -> Data {
        if let bytes = request.httpBody { return bytes }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var body = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let read = stream.read(&buffer, maxLength: 4096)
            guard read >= 0 else { throw HostFailure("Fixture body read failed") }
            if read == 0 { return body }
            body.append(contentsOf: buffer.prefix(read))
            guard body.count <= 8 * 1024 * 1024 else { throw HostFailure("Fixture body exceeded its bound") }
        }
    }
}
private struct VoiceFixtureRequest: Sendable {
    let url: String
    let authorization: String?
    let contentType: String?
    let body: Data
}
private final class VoiceFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0, failSQL = false
    private var journalCount = 0, failJournalAt: Int?
    private var held: VoiceFixtureHTTP?
    private var sent: [VoiceFixtureRequest] = []
    func record(_ transport: VoiceFixtureHTTP) {
        let request = VoiceFixtureRequest(url: transport.request.url!.absoluteString,
            authorization: transport.request.value(forHTTPHeaderField: "Authorization"),
            contentType: transport.request.value(forHTTPHeaderField: "Content-Type"), body: (try? transport.body()) ?? Data())
        lock.lock(); requests += 1; held = transport; sent.append(request); lock.unlock()
    }
    var sentRequests: [VoiceFixtureRequest] { lock.lock(); defer { lock.unlock() }; return sent }
    var count: Int { lock.lock(); defer { lock.unlock() }; return requests }
    func failJournalOn(_ value: Int?) { lock.lock(); journalCount = 0; failJournalAt = value; lock.unlock() }
    func beforeJournal() throws { lock.lock(); journalCount += 1; let fail = failJournalAt == journalCount; lock.unlock(); if fail { throw HostFailure("Synthetic voice journal failure") } }
    func fail(_ value: Bool) { lock.lock(); failSQL = value; lock.unlock() }
    func beforeSQL(_ sql: String) throws { lock.lock(); let failing = failSQL; lock.unlock(); if failing && sql == "COMMIT" { throw HostFailure("Synthetic voice save failure") } }
    func reply(_ bytes: Data) { lock.lock(); let selected = held; lock.unlock(); selected?.reply(bytes) }
}
private final class VoiceFixtureAdapter: NativeVoiceRecordingAdapter {
    private let writer: FileHandle
    private let event: @Sendable (NativeVoiceRecorderEvent) -> Void
    init(url: URL, event: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws { writer = try FileHandle(forWritingTo: url); self.event = event }
    func start() throws { try writer.write(contentsOf: Data("synthetic AAC fixture".utf8)) }
    func close() throws { try writer.close() }
    func interrupt() { event(.interrupted) }
}
private final class VoiceFixtureBackend: NativeVoiceRecorderBackend, @unchecked Sendable {
    var adapter: VoiceFixtureAdapter?
    let allowed: Bool
    init(allowed: Bool = true) { self.allowed = allowed }
    func requestPermission() async throws -> Bool { allowed }
    func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws -> any NativeVoiceRecordingAdapter {
        let created = try VoiceFixtureAdapter(url: url, event: onEvent); adapter = created; return created
    }
}
private actor VoiceEditorGate {
    private var waiter: CheckedContinuation<Bool, Never>?
    func wait() async -> Bool { await withCheckedContinuation { waiter = $0 } }
    func close() { waiter?.resume(returning: true); waiter = nil }
}

/// Production bundle/JSC/SQLite, fixed synthetic credential and intercepted HTTP.
/// These fixtures make no microphone, network or physical-device claim.
final class NativeVoiceHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, state: VoiceFixtureState!, service: String!
    private var rnCandidate = false
    private var database: URL { root.appendingPathComponent(rnCandidate ? "Documents/SQLite/mindwtr.db" : "core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var manifest: URL { root.appendingPathComponent(rnCandidate
        ? "Library/Application Support/tech.dongdongbh.mindwtr/RCTAsyncLocalStorage_V1/manifest.json"
        : "device/Library/Application Support/mindwtr.voice.fixture/RCTAsyncLocalStorage_V1/manifest.json") }
    private let sentinel = "SYNTHETIC-VOICE-PRIVATE"
    private let openAISentinel = "SYNTHETIC-VOICE-OPENAI-PRIVATE"
    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual iOS bundle required") }
        let candidate = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/voice-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(candidate.path, nil) else { throw HostFailure("Voice fixture unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        bundle = URL(fileURLWithPath: source); state = VoiceFixtureState(); service = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["mindwtr-ai-key:gemini": sentinel, "mindwtr-ai-key:openai": openAISentinel]).utf8).write(to: manifest)
        let state = self.state!
        VoiceFixtureHTTP.install { transport in state.record(transport) }
    }
    override func tearDownWithError() throws {
        if let service, service.hasPrefix("mindwtr.native-keychain.fixture.") {
            for suffix in ["", ":no-auth", ":auth"] {
                SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + suffix] as CFDictionary)
            }
        }
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func host() -> CoreHost {
        let faults = HostIOFaults(), config = URLSessionConfiguration.ephemeral, state = self.state!
        config.protocolClasses = [VoiceFixtureHTTP.self]; faults.httpConfiguration = config; faults.secretService = service
        faults.beforeSQL = { try state.beforeSQL($0) }; faults.journalWrite = { try state.beforeJournal() }
        let core: CoreHost
        if rnCandidate {
            faults.secretStatus = { _, _ in errSecItemNotFound }
            core = try! CoreHost(rnAdoptionContainerURL: root, bundleURL: bundle, faults: faults)
        } else {
            core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults, deviceStorage: (root.appendingPathComponent("device"), "mindwtr.voice.fixture"))
        }
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String { try NativeVoiceJSON.encode(value) }
    private func object(_ raw: String) throws -> [String: Any] { try NativeVoiceJSON.object(raw, maximum: 4 * 1024 * 1024) }
    @discardableResult private func rows(_ sql: String, _ parameters: [Any] = []) throws -> [[String: Any]] {
        let connection = try SQLiteBridge(url: database); defer { connection.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(connection.execute(sql, parametersJSON: json(parameters)).utf8)) as? [[String: Any]])
    }
    private func seed(provider: String = "gemini", enabled: Bool = true, retain: Bool = true, baseURL: String? = nil,
                      mode: String = "smart_parse", language: String = "auto", model: String? = nil, fieldStrategy: String = "smart") async throws {
        let initial = host(); _ = try await initial.start(); await initial.close()
        let row = try XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String)
        var settings = try object(row)
        var speech: [String: Any] = ["provider": provider, "enabled": enabled, "model": model ?? (provider == "openai" ? "gpt-transcribe" : "gemini-2.5-flash"),
            "mode": mode, "fieldStrategy": fieldStrategy, "language": language]
        if let baseURL { speech["baseUrl"] = baseURL }
        settings["ai"] = ["provider": "openai", "model": "gpt-test-primary", "speechToText": speech]
        var gtd = settings["gtd"] as? [String: Any] ?? [:]; gtd["saveAudioAttachments"] = retain; settings["gtd"] = gtd
        try rows("UPDATE settings SET data=? WHERE id=1", [json(settings)])
    }
    private func recording(_ core: CoreHost, text: String = "") async throws -> (NativeVoiceCaptureHandle, String) {
        let opened = try object(await core.call("captureOpen"))
        let handle = try await core.beginVoiceCapture(presentationID: UUID(), captureID: UUID(), backend: VoiceFixtureBackend())
        try await core.startVoiceRecording(handle)
        return (handle, try json(["text": text, "options": XCTUnwrap(opened["options"]), "openAfterSave": false, "applied": NSNull()]))
    }
    private func response(title: String = "From speech") throws -> Data {
        let speech = try json(["title": title, "transcript": title, "description": "Fixture detail"])
        return try JSONSerialization.data(withJSONObject: ["candidates": [["content": ["parts": [["text": speech]]]]]])
    }
    private func job(_ outcome: NativeVoiceCaptureOutcome) throws -> UUID {
        guard case .saved(_, let id) = outcome else { throw HostFailure("Expected durable saved capture") }; return try XCTUnwrap(id)
    }
    private func assertPrivateBytesAbsent() throws {
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(sentinel))
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains(openAISentinel))
        if FileManager.default.fileExists(atPath: journal.path) { XCTAssertFalse(try String(contentsOf: journal).contains(sentinel)) }
    }
    private func openAITranscript(_ transcript: String) throws -> Data { try JSONSerialization.data(withJSONObject: ["text": transcript]) }
    private func openAIParse(_ result: [String: Any], api: NativeOpenAISpeechAPI = .responses) throws -> Data {
        let text = try json(result)
        let value: [String: Any] = api == .responses ? ["output_text": text] : ["choices": [["message": ["content": text]]]]
        return try JSONSerialization.data(withJSONObject: value)
    }
    private func openAIReplies(_ replies: [Data?]) {
        let state = self.state!, base = state.count
        VoiceFixtureHTTP.install { transport in
            state.record(transport)
            let index = state.count - base - 1
            guard index < replies.count else { XCTFail("Unexpected provider request"); transport.fail(); return }
            if let bytes = replies[index] { transport.reply(bytes) } else { transport.fail() }
        }
    }

    func testUnsupportedProviderPreservedUntilExplicitGeminiSwitch() async throws {
        try await seed(provider: "parakeet")
        let core = host(); _ = try await core.start()
        let session = try await core.beginVoiceSettings()
        XCTAssertEqual(session.options.provider, .parakeet); XCTAssertFalse(session.options.supported)
        do {
            _ = try await core.setVoiceSettings(session: session.id, request: .init(requestId: UUID().uuidString.lowercased(), expected: session.options.expected, change: .model("other")), readmission: { true })
            XCTFail("Unsupported provider edit must refuse")
        } catch { }
        let preserved = try await core.readVoiceSettings(session: session.id)
        XCTAssertEqual(preserved.provider, .parakeet)
        _ = try await core.setVoiceSettings(session: session.id, request: .init(requestId: UUID().uuidString.lowercased(), expected: session.options.expected, change: .useGemini), readmission: { true })
        let after = try await core.beginVoiceSettings().options
        XCTAssertEqual(after.provider, .gemini); XCTAssertEqual(state.count, 0)
        try assertPrivateBytesAbsent()
    }
    func testWhisperMissingModelRetainsRecordingWithoutRemoteSpeech() async throws {
        try await seed(provider: "whisper", retain: false, model: "whisper-base.en")
        let core = host(); _ = try await core.start()
        let session = try await core.beginVoiceSettings()
        XCTAssertEqual(session.options.provider, .whisper)
        XCTAssertTrue(session.options.supported)
        XCTAssertFalse(session.credentialAvailable)
        let local = try await core.readVoiceLocalModel(session: session.id)
        XCTAssertEqual(local.modelID, "whisper-base.en")
        XCTAssertEqual(local.availability, .missing)
        XCTAssertGreaterThan(local.sizeBytes, 0)
        let runtime = try await core.readVoiceRuntime()
        XCTAssertFalse(runtime.available)
        XCTAssertEqual(runtime.availabilityReason, .modelMissing)
        let (handle, raw) = try await recording(core)
        let outcome = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(outcome, .saved(taskId: handle.captureID.uuidString.lowercased(), speechJobID: nil))
        let audio = root.appendingPathComponent("attachment-files/documents/attachments/" + handle.captureID.uuidString.lowercased() + ".m4a")
        XCTAssertTrue(FileManager.default.fileExists(atPath: audio.path))
        XCTAssertEqual(state.count, 0)
        try assertPrivateBytesAbsent()
    }
    func testWhisperModelSessionRejectsRetiredPageAndKeepsLegacySelection() async throws {
        try await seed(provider: "whisper", model: "legacy-large-model")
        let core = host(); _ = try await core.start()
        let session = try await core.beginVoiceSettings()
        let local = try await core.readVoiceLocalModel(session: session.id)
        XCTAssertEqual(local.modelID, "whisper-tiny")
        let preserved = try await core.readVoiceSettings(session: session.id)
        XCTAssertEqual(preserved.model, "legacy-large-model")
        _ = try await core.removeVoiceLocalModel(session: session.id)
        await core.retireVoiceSettings(session: session.id)
        do { _ = try await core.readVoiceLocalModel(session: session.id); XCTFail("Closed settings must refuse model access") } catch { }
        do { _ = try await core.downloadVoiceLocalModel(session: session.id, progress: { _, _ in }); XCTFail("Closed settings must refuse model download") } catch { }
        XCTAssertEqual(state.count, 0)
    }
    func testDurableInitialSaveAndDuplicateStopCreateOneTaskAndOneManagedAudio() async throws {
        try await seed(enabled: false)
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core, text: "Typed voice task")
        let first = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(first, .saved(taskId: handle.captureID.uuidString.lowercased(), speechJobID: nil))
        let duplicate = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(duplicate, first)
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        let attachments = root.appendingPathComponent("attachment-files/documents/attachments")
        XCTAssertTrue(FileManager.default.fileExists(atPath: attachments.appendingPathComponent(handle.captureID.uuidString.lowercased() + ".m4a").path))
        XCTAssertEqual(state.count, 0); try assertPrivateBytesAbsent()
    }

    func testCandidateRecordingColdSettlementUsesRNRootsAndCreatesOneTerminalSave() async throws {
        rnCandidate = true
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off"]).utf8).write(to: manifest)
        try FileManager.default.createDirectory(at: database.deletingLastPathComponent(), withIntermediateDirectories: true)
        let sqlite = try SQLiteBridge(url: database)
        _ = try sqlite.execute("PRAGMA user_version = 0"); sqlite.close()
        try await seed(enabled: false)
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        state.failJournalOn(3)
        let pending = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(pending, .savePending)
        let disk = try object(String(contentsOf: journal)), file = try XCTUnwrap(disk["voiceFiles"] as? [String: Any])
        let source = try XCTUnwrap(file["source"] as? [String: Any]), sourceURI = try XCTUnwrap(source["sourceURI"] as? String)
        XCTAssertEqual(URL(string: sourceURI)?.deletingLastPathComponent(), root.appendingPathComponent("Library/Caches", isDirectory: true))
        let target = root.appendingPathComponent("Documents/attachments", isDirectory: true).appendingPathComponent(handle.captureID.uuidString.lowercased() + ".m4a")
        XCTAssertEqual(file["targetURI"] as? String, target.absoluteString)
        await core.close(); state.failJournalOn(nil)
        let cold = host(); _ = try await cold.start()
        let stored = try rows("SELECT id,attachments FROM tasks")
        XCTAssertEqual(stored.count, 1)
        let attachmentJSON = try XCTUnwrap(stored.first?["attachments"] as? String)
        let attachments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(attachmentJSON.utf8)) as? [[String: Any]])
        XCTAssertEqual(attachments.first?["uri"] as? String, target.absoluteString)
        XCTAssertEqual(try Data(contentsOf: target), Data("synthetic AAC fixture".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await cold.close()
        let reopened = host(); _ = try await reopened.start()
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1); XCTAssertEqual(state.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("Documents/SQLite/attachment-files").path))
    }
    func testOrdinaryCaptureAfterCompletedVoiceUsesCanonicalAddAnotherReset() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let (handle, openedRequest) = try await recording(core)
        let opened = try object(openedRequest)
        let selected = try object(await core.call("captureEdit", argumentsJSON: json([json([
            "text": "", "options": XCTUnwrap(opened["options"]),
            "edit": ["type": "setAddAnother", "value": true],
        ])])))
        let selectedView = try XCTUnwrap(selected["view"] as? [String: Any])
        let raw = try json(["text": "", "options": XCTUnwrap(selectedView["options"]),
                            "openAfterSave": false, "applied": NSNull()])
        let saved = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        let speechID = try job(saved), state = self.state!, payload = try response()
        VoiceFixtureHTTP.install { transport in state.record(transport); transport.reply(payload) }
        let speech = try await core.completeVoiceSpeech(jobID: speechID, readmission: { _ in true })
        XCTAssertEqual(speech, .applied)

        // Match the App's post-voice canonical reset, then use the ordinary bridge.
        let resetOpen = try object(await core.call("captureOpen"))
        let resetEdit = try object(await core.call("captureEdit", argumentsJSON: json([json([
            "text": "", "options": XCTUnwrap(resetOpen["options"]),
            "edit": ["type": "setAddAnother", "value": true],
        ])])))
        let resetView = try XCTUnwrap(resetEdit["view"] as? [String: Any])
        let followupID = UUID().uuidString.lowercased()
        let followup = try object(await core.call("captureSubmit", argumentsJSON: json([json([
            "text": "Synthetic voice ordinary follow-up", "options": XCTUnwrap(resetView["options"]),
            "captureId": followupID, "openAfterSave": false,
        ])])))
        XCTAssertEqual(followup["kind"] as? String, "saved")
        XCTAssertEqual(followup["taskId"] as? String, followupID)
        XCTAssertEqual(followup["next"] as? String, "addAnother")
        let reset = try XCTUnwrap(followup["reset"] as? [String: Any])
        XCTAssertEqual(reset["text"] as? String, "")
        XCTAssertEqual((reset["options"] as? [String: Any])?["addAnother"] as? Bool, true)
        let tasks = try rows("SELECT id,title FROM tasks")
        XCTAssertEqual(Set(tasks.compactMap { $0["id"] as? String }),
                       Set([handle.captureID.uuidString.lowercased(), followupID]))
        XCTAssertEqual(tasks.first { $0["id"] as? String == followupID }?["title"] as? String,
                       "Synthetic voice ordinary follow-up")
        XCTAssertEqual(state.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try assertPrivateBytesAbsent()
    }
    func testInitialSaveFailureStartsZeroHTTPAndExactRetryCreatesOneTask() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        state.fail(true)
        let pending = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(pending, .savePending); XCTAssertEqual(state.count, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        state.fail(false)
        let saved = try await core.retryVoiceCapture(handle, readmission: { true })
        _ = try job(saved); XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1); XCTAssertEqual(state.count, 0)
        await core.cancelVoiceRecording(handle) // Accepted source/job survives sheet close.
        await core.cancelVoiceSpeech(jobID: try job(saved)); try assertPrivateBytesAbsent()
    }
    func testColdRecoveryAfterReservationProofWriteFailureUsesFreshPrivateStage() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        state.failJournalOn(3) // Prepared command, fresh reservation intent, then lost stage-proof write.
        let pending = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(pending, .savePending)
        let disk = try object(String(contentsOf: journal)), file = try XCTUnwrap(disk["voiceFiles"] as? [String: Any])
        XCTAssertNil(file["stage"], "Cold journal deliberately lacks the already-created reservation proof")
        await core.close(); state.failJournalOn(nil)
        let restarted = host(); _ = try await restarted.start()
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(state.count, 0)
        try assertPrivateBytesAbsent()
    }
    func testPausedHTTPAllowsOrdinaryTitleEditAndEditorGateDoesNotReupload() async throws {
        try await seed(retain: false)
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let saved = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }), id = try job(saved)
        let started = expectation(description: "HTTP outside Engine"), decoded = expectation(description: "Decoded result awaits editor")
        let state = self.state!, gate = VoiceEditorGate()
        VoiceFixtureHTTP.install { transport in state.record(transport); started.fulfill() }
        let speech = Task { try await core.completeVoiceSpeech(jobID: id, readmission: { _ in decoded.fulfill(); return await gate.wait() }) }
        await fulfillment(of: [started], timeout: 5)
        let opening = try object(await core.call("editorModel", argumentsJSON: json([handle.captureID.uuidString.lowercased()])))
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any]), title = try XCTUnwrap(draft["title"])
        _ = try await core.call("saveDraft", argumentsJSON: json([json(["id": handle.captureID.uuidString.lowercased(), "base": ["title": title], "patch": ["title": "Edited while uploading"]])]))
        state.reply(try response())
        await fulfillment(of: [decoded], timeout: 5)
        XCTAssertEqual(state.count, 1)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Edited while uploading")
        await gate.close()
        let result = try await speech.value
        XCTAssertEqual(result, .applied)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Edited while uploading")
        XCTAssertEqual(try rows("SELECT description FROM tasks").first?["description"] as? String, "Fixture detail")
        XCTAssertEqual(state.count, 1); try assertPrivateBytesAbsent()
    }
    func testLateSaveFailureThrowsTypedPendingAndRetryUsesDecodedResultWithoutHTTP() async throws {
        try await seed()
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let saved = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }), id = try job(saved)
        let state = self.state!, payload = try response()
        VoiceFixtureHTTP.install { transport in state.record(transport); transport.reply(payload) }
        do {
            _ = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in state.fail(true); return true })
            XCTFail("Uncertain late save must retain the exact job")
        } catch { XCTAssertTrue(error is NativeVoiceSpeechSavePending) }
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1); XCTAssertEqual(state.count, 1)
        state.fail(false)
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .applied); XCTAssertEqual(state.count, 1)
        XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }
    func testRejectedSecondSettingsSessionCannotStealRetiredExactRetryOwner() async throws {
        try await seed()
        let core = host(); _ = try await core.start()
        let original = try await core.beginVoiceSettings(), second = try await core.beginVoiceSettings()
        let request = NativeVoiceSettingsRequest(requestId: UUID().uuidString.lowercased(), expected: original.options.expected, change: .enabled(false))
        state.fail(true)
        do { _ = try await core.setVoiceSettings(session: original.id, request: request, readmission: { true }); XCTFail("Synthetic save must fail") } catch { }
        do {
            _ = try await core.setVoiceSettings(session: second.id, request: .init(requestId: UUID().uuidString.lowercased(), expected: second.options.expected, change: .model("different")), readmission: { true })
            XCTFail("Another session cannot select the pending command")
        } catch { }
        await core.retireVoiceSettings(session: original.id); state.fail(false)
        let outcome = try await core.setVoiceSettings(session: original.id, request: request, readmission: { true })
        XCTAssertEqual(outcome, .saved(changed: true)); XCTAssertEqual(state.count, 0)
        do { _ = try await core.readVoiceSettings(session: original.id); XCTFail("Ordinary read of retired exact retry owner must refuse") } catch { }
        try assertPrivateBytesAbsent()
    }
    func testVoiceHTTPHasIndependentResponseBoundAndThirtySecondDeadline() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [VoiceFixtureHTTP.self]
        let registry = NativeAttachmentLocalRequests(), http = NativeHTTPJobs(voiceRegistry: registry, configuration: config)
        defer { http.shutdown() }
        XCTAssertEqual(config.timeoutIntervalForRequest, 30); XCTAssertEqual(config.timeoutIntervalForResource, 30)
        let waiter = NativeVoiceHTTPWait(http), state = self.state!
        VoiceFixtureHTTP.install { transport in state.record(transport); transport.reply(Data(repeating: 1, count: 2 * 1024 * 1024 + 1)) }
        let request = try json(["url": "https://generativelanguage.googleapis.com/v1beta/models/fixture:generateContent", "method": "POST", "redirect": "error", "headers": [], "text": String(repeating: "a", count: 3 * 1024 * 1024)])
        do { _ = try await waiter.run(request); XCTFail("Response above 2MiB must refuse") } catch { }
        XCTAssertEqual(state.count, 1, "3MiB request remains admitted independently of 2MiB response cap")
    }
    func testCancelledWaiterCannotSubmitAndDrainWaitsForTerminalCallback() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [VoiceFixtureHTTP.self]
        let http = NativeHTTPJobs(voiceRegistry: NativeAttachmentLocalRequests(), configuration: config)
        defer { http.shutdown() }
        let cancelled = NativeVoiceHTTPWait(http)
        cancelled.cancel(); cancelled.drain()
        let raw = try json(["url": "https://generativelanguage.googleapis.com/v1beta/models/fixture:generateContent", "method": "POST", "redirect": "error", "headers": [], "text": "fixture"])
        do { _ = try await cancelled.run(raw); XCTFail("A drained cancelled waiter cannot submit") } catch { }
        XCTAssertEqual(state.count, 0)
        let callback = expectation(description: "Terminal callback held"), release = DispatchSemaphore(value: 0)
        http.beforeCompletion = { callback.fulfill(); _ = release.wait(timeout: .now() + 5) }
        let state = self.state!
        VoiceFixtureHTTP.install { transport in state.record(transport); transport.reply(Data("{}".utf8)) }
        let waiter = NativeVoiceHTTPWait(http), request = Task { try await waiter.run(raw) }
        await fulfillment(of: [callback], timeout: 5)
        let drainStarted = expectation(description: "Drain started"), drainFinished = DispatchSemaphore(value: 0)
        let drain = Task.detached { drainStarted.fulfill(); waiter.drain(); drainFinished.signal() }
        await fulfillment(of: [drainStarted], timeout: 5)
        let premature = await Task.detached { drainFinished.wait(timeout: .now() + 0.05) }.value
        XCTAssertEqual(premature, .timedOut)
        release.signal(); await drain.value
        do { _ = try await request.value; XCTFail("Cancelled request must not expose a provider body") } catch { }
        XCTAssertEqual(state.count, 1)
    }
    func testRecorderStreamReportsRealInterruption() async throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), backend = VoiceFixtureBackend(), recorder = NativeVoiceRecorder(files: files, backend: backend)
        let selected = try await recorder.begin(presentationID: UUID(), captureID: UUID())
        let events = try await recorder.events(selected)
        let interrupted = expectation(description: "Actual recorder interruption observed")
        let observer = Task { for await state in events { if state == .interrupted { interrupted.fulfill(); break } } }
        try await recorder.start(selected); backend.adapter?.interrupt()
        await fulfillment(of: [interrupted], timeout: 5); observer.cancel()
        do { _ = try await recorder.stop(selected); XCTFail("Interrupted source cannot save") } catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .interrupted) }
    }

    func testOpenAIRecorderSavesBeforeHTTPAndAppliesFullParsedResult() async throws {
        try await seed(provider: "openai", retain: false, language: "en-US")
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }))
        XCTAssertEqual(state.count, 0); XCTAssertEqual(try rows("SELECT id FROM tasks").count, 1)
        openAIReplies([try openAITranscript("Synthetic initial speech"), try openAIParse([
            "transcript": "Synthetic parsed transcript", "title": "Synthetic parsed title", "description": "Synthetic full description",
            "dueDate": "2026-11-04", "startTime": "2026-11-03", "projectTitle": "Synthetic speech project", "tags": ["#speech"], "contexts": ["@home"], "language": "en"])])
        let outcome = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(outcome, .applied)
        let task = try XCTUnwrap(rows("SELECT * FROM tasks").first), request = try XCTUnwrap(state.sentRequests.first)
        XCTAssertEqual(task["title"] as? String, "Synthetic parsed title"); XCTAssertEqual(task["description"] as? String, "Synthetic full description")
        XCTAssertEqual(task["dueDate"] as? String, "2026-11-04"); XCTAssertEqual(task["startTime"] as? String, "2026-11-03")
        XCTAssertTrue((task["tags"] as? String)?.contains("#speech") == true); XCTAssertTrue((task["contexts"] as? String)?.contains("@home") == true)
        XCTAssertEqual(try rows("SELECT title FROM projects WHERE id=?", [XCTUnwrap(task["projectId"])]).first?["title"] as? String, "Synthetic speech project")
        XCTAssertEqual(request.url, "https://api.openai.com/v1/audio/transcriptions"); XCTAssertEqual(request.authorization, "Bearer " + openAISentinel)
        let multipart = String(decoding: request.body, as: UTF8.self)
        XCTAssertTrue(multipart.contains("filename=\"" + handle.captureID.uuidString.lowercased() + ".m4a\""))
        XCTAssertTrue(multipart.contains("Content-Type: audio/mp4")); XCTAssertTrue(multipart.contains("synthetic AAC fixture"))
        XCTAssertTrue(multipart.contains("name=\"languages[]\"\r\n\r\nen\r\n"))
        XCTAssertEqual(state.count, 2); try assertPrivateBytesAbsent()
    }

    func testKeylessCustomOpenAIRecorderAvailabilityAndTranscription() async throws {
        try Data(json(["mindwtr-ai-key:gemini": sentinel]).utf8).write(to: manifest)
        try await seed(provider: "openai", retain: false, baseURL: "http://speech.local:8123/v1", language: "en-US", model: "whisper-1")
        let core = host(); _ = try await core.start(); let runtime = try await core.readVoiceRuntime()
        XCTAssertTrue(runtime.available); XCTAssertFalse(runtime.credentialAvailable)
        let (handle, raw) = try await recording(core), id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }))
        openAIReplies([try openAITranscript("Synthetic keyless recording")])
        let outcome = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(outcome, .applied); XCTAssertEqual(state.count, 1)
        let request = try XCTUnwrap(state.sentRequests.first)
        XCTAssertEqual(request.url, "http://speech.local:8123/v1/audio/transcriptions"); XCTAssertNil(request.authorization)
        XCTAssertTrue(String(decoding: request.body, as: UTF8.self).contains("name=\"language\"\r\n\r\nen\r\n"))
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic keyless recording")
    }

    func testInvalidOpenAIEndpointRemainsUnavailableAndRecordingAudioIsPreserved() async throws {
        try await seed(provider: "openai", retain: false, baseURL: "http://public.example.test/v1")
        let core = host(); _ = try await core.start(); let runtime = try await core.readVoiceRuntime()
        XCTAssertFalse(runtime.available)
        let (handle, raw) = try await recording(core)
        let outcome = try await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })
        XCTAssertEqual(outcome, .saved(taskId: handle.captureID.uuidString.lowercased(), speechJobID: nil))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("attachment-files/documents/attachments/" + handle.captureID.uuidString.lowercased() + ".m4a").path))
        XCTAssertEqual(state.count, 0)
    }

    func testOpenAICredentialsAreSessionBoundAndGeminiCredentialIsPreserved() async throws {
        try await seed(); let core = host(); _ = try await core.start(); let gemini = try await core.beginVoiceSettings()
        _ = try await core.setVoiceSettings(session: gemini.id, request: .init(requestId: UUID().uuidString.lowercased(), expected: gemini.options.expected, change: .useOpenAI), readmission: { true })
        do { try await core.clearVoiceCredential(session: gemini.id, expected: gemini.credentialWitness); XCTFail("Old provider session edited credential") } catch {}
        let openAI = try await core.beginVoiceSettings()
        XCTAssertEqual(openAI.options.provider, .openai); XCTAssertTrue(openAI.options.supported)
        try await core.saveVoiceCredential(session: openAI.id, value: "SYNTHETIC-REPLACEMENT-OPENAI", expected: openAI.credentialWitness)
        await core.retireVoiceSettings(session: openAI.id)
        let refreshed = try await core.beginVoiceSettings(); XCTAssertTrue(refreshed.credentialAvailable)
        try await core.clearVoiceCredential(session: refreshed.id, expected: refreshed.credentialWitness)
        await core.retireVoiceSettings(session: refreshed.id)
        let cleared = try await core.beginVoiceSettings(); XCTAssertFalse(cleared.credentialAvailable)
        await core.close()
        let storage = try NativeDeviceKV(containerURL: root.appendingPathComponent("device"), bundleIdentifier: "mindwtr.voice.fixture"); defer { storage.close() }
        XCTAssertEqual(try storage.get("mindwtr-ai-key:gemini"), sentinel)
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains("SYNTHETIC-REPLACEMENT-OPENAI"))
    }

    func testEndpointSensitiveFailureRetainsExactSessionAndRetryWithoutJournal() async throws {
        try await seed(provider: "openai", baseURL: "http://speech.local:8123/old/v1")
        let core = host(); _ = try await core.start(); let session = try await core.beginVoiceSettings()
        let original = try await core.readVoiceEndpoint(session: session.id, expected: session.options.expected)
        XCTAssertEqual(original, "http://speech.local:8123/old/v1")
        let replacement = "http://speech.local:8123/SYNTHETIC-ENDPOINT/v1"
        state.fail(true)
        do { _ = try await core.saveVoiceEndpoint(session: session.id, value: replacement, expected: session.options.expected); XCTFail("Accepted save failure must remain retryable") }
        catch { XCTAssertFalse(error is CoreHostRejection) }
        do { _ = try await core.saveVoiceEndpoint(session: session.id, value: replacement + "-changed", expected: session.options.expected); XCTFail("Changed accepted retry admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        state.fail(false)
        _ = try await core.saveVoiceEndpoint(session: session.id, value: replacement, expected: session.options.expected)
        let options = try await core.readVoiceSettings(session: session.id)
        let endpoint = try await core.readVoiceEndpoint(session: session.id, expected: options.expected)
        XCTAssertEqual(endpoint, replacement)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(try json(rows("SELECT * FROM native_request_receipts")).contains("SYNTHETIC-ENDPOINT"))
        let settings = try object(XCTUnwrap(rows("SELECT data FROM settings WHERE id=1").first?["data"] as? String))
        XCTAssertNil((settings["ai"] as? [String: Any])?["baseUrl"])
    }

    func testStaleEndpointSnapshotIsDefiniteAndFreshSessionCanSave() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start(); let session = try await core.beginVoiceSettings()
        _ = try await core.setVoiceSettings(session: session.id, request: .init(requestId: UUID().uuidString.lowercased(), expected: session.options.expected, change: .model("gpt-new-model")), readmission: { true })
        do { _ = try await core.saveVoiceEndpoint(session: session.id, value: "https://speech.local/stale/v1", expected: session.options.expected); XCTFail("Stale endpoint page admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        await core.retireVoiceSettings(session: session.id)
        let fresh = try await core.beginVoiceSettings()
        _ = try await core.saveVoiceEndpoint(session: fresh.id, value: "https://speech.local/current/v1", expected: fresh.options.expected)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOpenAIParseRetriesModelsThenAppliesInitialTranscriptFallback() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }))
        openAIReplies([try openAITranscript("Synthetic phone fallback"), nil, Data("{}".utf8), nil, Data("{}".utf8)])
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .applied); XCTAssertEqual(state.count, 5)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Synthetic phone fallback")
        let models = try state.sentRequests.dropFirst().map { try object(String(decoding: $0.body, as: UTF8.self))["model"] as? String }
        XCTAssertEqual(models[0], "gpt-test-primary"); XCTAssertEqual(models[1], models[0]); XCTAssertEqual(models[2], models[3])
    }

    func testLargeCJKTranscriptFallsBackWhenParseUTF8BoundRefusesIt() async throws {
        try await seed(provider: "openai", fieldStrategy: "description_only")
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core, text: "Keep title")
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })), transcript = String(repeating: "漢", count: 22000)
        openAIReplies([try openAITranscript(transcript)])
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .applied); XCTAssertEqual(state.count, 1)
        XCTAssertEqual(try rows("SELECT description FROM tasks").first?["description"] as? String, transcript)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, "Keep title")
    }

    func testEmptyOpenAITranscriptionUsesExistingGeneratedCaptureDiscardPolicy() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }))
        openAIReplies([try openAITranscript(" \n ")])
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .discarded); XCTAssertEqual(state.count, 1)
        XCTAssertNotNil(try rows("SELECT deletedAt FROM tasks").first?["deletedAt"] as? String)
    }

    func testOpenAILateResultSaveRetryDoesNotUploadOrParseAgain() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })), state = self.state!
        openAIReplies([try openAITranscript("Synthetic initial"), try openAIParse(["transcript": "Synthetic parsed", "title": "Saved OpenAI result", "description": "Full result retained"])])
        do { _ = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in state.fail(true); return true }); XCTFail("Expected pending result save") }
        catch { XCTAssertTrue(error is NativeVoiceSpeechSavePending) }
        XCTAssertEqual(state.count, 2); XCTAssertFalse(try String(contentsOf: journal).contains(openAISentinel))
        state.fail(false)
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .applied); XCTAssertEqual(state.count, 2)
        XCTAssertEqual(try rows("SELECT description FROM tasks").first?["description"] as? String, "Full result retained")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertPrivateBytesAbsent()
    }

    func testOpenAIParseCancellationRetainsInitiallySavedTaskAndStopsFallback() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })), state = self.state!, initial = try openAITranscript("Synthetic initial")
        let title = try rows("SELECT title FROM tasks").first?["title"] as? String, parsing = expectation(description: "OpenAI parsing outside Engine")
        VoiceFixtureHTTP.install { transport in state.record(transport); if state.count == 1 { transport.reply(initial) } else { parsing.fulfill() } }
        let task = Task { try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true }) }
        await fulfillment(of: [parsing], timeout: 5); task.cancel()
        let result = try await task.value
        XCTAssertEqual(result, .cancelled); XCTAssertEqual(state.count, 2)
        XCTAssertEqual(try rows("SELECT title FROM tasks").first?["title"] as? String, title)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testOpenAIParsedFieldsPreserveLaterTitleEditAndWaitForEditorWithoutReupload() async throws {
        try await seed(provider: "openai", retain: false)
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true })), state = self.state!
        let initial = try openAITranscript("Synthetic initial"), parseStarted = expectation(description: "Parse request held"), decoded = expectation(description: "Decoded full result awaits editor")
        VoiceFixtureHTTP.install { transport in state.record(transport); if state.count == 1 { transport.reply(initial) } else { parseStarted.fulfill() } }
        let gate = VoiceEditorGate(), speech = Task { try await core.completeVoiceSpeech(jobID: id, readmission: { _ in decoded.fulfill(); return await gate.wait() }) }
        await fulfillment(of: [parseStarted], timeout: 5)
        let opening = try object(await core.call("editorModel", argumentsJSON: json([handle.captureID.uuidString.lowercased()])))
        let draft = try XCTUnwrap(opening["draft"] as? [String: Any]), title = try XCTUnwrap(draft["title"])
        _ = try await core.call("saveDraft", argumentsJSON: json([json(["id": handle.captureID.uuidString.lowercased(), "base": ["title": title], "patch": ["title": "Edited during OpenAI parsing"]])]))
        state.reply(try openAIParse(["transcript": "Synthetic parsed", "title": "Provider title", "description": "Full parsed detail", "dueDate": "2026-11-05"]))
        await fulfillment(of: [decoded], timeout: 5)
        XCTAssertEqual(state.count, 2); await gate.close()
        let result = try await speech.value
        XCTAssertEqual(result, .applied); XCTAssertEqual(state.count, 2)
        let task = try XCTUnwrap(rows("SELECT title,description,dueDate FROM tasks").first)
        XCTAssertEqual(task["title"] as? String, "Edited during OpenAI parsing")
        XCTAssertEqual(task["description"] as? String, "Full parsed detail"); XCTAssertEqual(task["dueDate"] as? String, "2026-11-05")
    }

    func testAcceptedRecorderJobFreezesOpenAIEndpointAndCredential() async throws {
        try await seed(provider: "openai", baseURL: "https://speech.local/original/v1", mode: "transcribe_only")
        let core = host(); _ = try await core.start(); let (handle, raw) = try await recording(core)
        let id = try job(await core.stopVoiceCapture(handle, requestJSON: raw, readmission: { true }))
        let settings = try await core.beginVoiceSettings()
        _ = try await core.saveVoiceEndpoint(session: settings.id, value: "https://speech.local/replaced/v1", expected: settings.options.expected)
        try await core.saveVoiceCredential(session: settings.id, value: "SYNTHETIC-LATER-OPENAI", expected: settings.credentialWitness)
        openAIReplies([try openAITranscript("Synthetic frozen policy")])
        let result = try await core.completeVoiceSpeech(jobID: id, readmission: { _ in true })
        XCTAssertEqual(result, .applied)
        let request = try XCTUnwrap(state.sentRequests.first)
        XCTAssertEqual(request.url, "https://speech.local/original/v1/audio/transcriptions")
        XCTAssertEqual(request.authorization, "Bearer " + openAISentinel)
    }

    func testOpenAIPrivateRuntimeAndEndpointMethodsRejectRawCalls() async throws {
        try await seed(provider: "openai"); let core = host(); _ = try await core.start()
        for method in ["iosVoiceOpenAIRuntime", "iosVoiceEndpointSessionOpen", "iosVoiceEndpointSessionClose", "iosVoiceEndpointSensitive"] {
            do { _ = try await core.call(method, argumentsJSON: json(["{}"])); XCTFail("Raw speech authority admitted") } catch {}
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
