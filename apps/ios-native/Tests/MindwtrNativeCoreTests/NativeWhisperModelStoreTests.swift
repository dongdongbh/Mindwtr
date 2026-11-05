import AttachmentFileInstallerEngine
import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class WhisperModelHTTPFixture: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((WhisperModelHTTPFixture) -> Void)?
    static func install(_ body: @escaping (WhisperModelHTTPFixture) -> Void) {
        lock.lock(); handler = body; lock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handler; Self.lock.unlock()
        guard let handler else { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        handler(self)
    }
    override func stopLoading() {}
    func reply(_ bytes: Data, status: Int = 200, headers: [String: String] = [:], finish: Bool = true) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for offset in stride(from: 0, to: bytes.count, by: 97) {
            client?.urlProtocol(self, didLoad: bytes.subdata(in: offset..<min(bytes.count, offset + 97)))
        }
        if finish { client?.urlProtocolDidFinishLoading(self) }
    }
    func redirect(_ url: URL) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": url.absoluteString])!
        var next = request; next.url = url
        next.setValue("SYNTHETIC-REDIRECT-CREDENTIAL", forHTTPHeaderField: "Authorization")
        next.setValue("SYNTHETIC-REDIRECT-COOKIE", forHTTPHeaderField: "Cookie")
        client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
    }
}

private final class WhisperModelFixtureState: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    private var progressValues: [Int64] = []
    private var stages: [String] = []
    private var claimed = false
    private var diagnostics: [NativeWhisperModelDiagnostic] = []
    func diagnostic(_ value: NativeWhisperModelDiagnostic) { lock.lock(); diagnostics.append(value); lock.unlock() }
    var diagnosticValues: [NativeWhisperModelDiagnostic] { lock.lock(); defer { lock.unlock() }; return diagnostics }
    func record(_ request: URLRequest) -> Int { lock.lock(); defer { lock.unlock() }; requests.append(request); return requests.count }
    var sent: [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
    func progress(_ value: Int64) { lock.lock(); progressValues.append(value); lock.unlock() }
    var progress: [Int64] { lock.lock(); defer { lock.unlock() }; return progressValues }
    func stage(_ name: String) { lock.lock(); stages.append(name); lock.unlock() }
    var stageNames: [String] { lock.lock(); defer { lock.unlock() }; return stages }
    func once() -> Bool { lock.lock(); defer { lock.unlock() }; if claimed { return false }; claimed = true; return true }
}

/// Real file proofs/publication and intercepted streaming HTTP; no live model/provider claim.
final class NativeWhisperModelStoreTests: XCTestCase {
    private var fixture: URL!
    private let bytes = Data((0..<4096).map { UInt8($0 % 251) })
    private var modelRoot: URL { fixture.appendingPathComponent("models", isDirectory: true) }
    override func setUpWithError() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        fixture = home.appendingPathComponent(".mindwtr-native-tests/model-store-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        fixture = fixture.resolvingSymlinksInPath()
    }
    override func tearDownWithError() throws { if let fixture { try FileManager.default.removeItem(at: fixture) } }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func spec(mirrors: Bool = false) -> NativeWhisperModelSpec {
        .init(id: "whisper-tiny", fileName: "ggml-tiny.bin", sizeBytes: Int64(bytes.count), sha256: digest(bytes),
              urls: (mirrors ? ["https://models.example.test/ggml-tiny.bin", "https://mirror.example.test/ggml-tiny.bin"] : ["https://models.example.test/ggml-tiny.bin"]).map { URL(string: $0)! })
    }
    private func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [WhisperModelHTTPFixture.self]
        config.httpAdditionalHeaders = ["Authorization": "SYNTHETIC-CONFIG-CREDENTIAL", "Cookie": "SYNTHETIC-CONFIG-COOKIE"]
        return config
    }
    private func store(root: URL? = nil) throws -> NativeWhisperModelStore {
        let store = try NativeWhisperModelStore(root: root ?? modelRoot, sessionConfiguration: configuration())
        addTeardownBlock { try? await store.close() }; return store
    }
    private func expect(_ state: NativeWhisperModelState, _ store: NativeWhisperModelStore, _ model: NativeWhisperModelSpec,
                        file: StaticString = #filePath, line: UInt = #line) async throws {
        let actual = try await store.inspect(model); XCTAssertEqual(actual, state, file: file, line: line)
    }
    private func assertNoPrivateStages(_ root: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertFalse(names.contains { $0.hasPrefix(".mindwtr-install-") || $0.hasPrefix(".whisper-model-install-") }, file: file, line: line)
    }

    private func systemVarFixture() throws -> (canonical: URL, aliased: URL) {
        let destination = try FileManager.default.destinationOfSymbolicLink(atPath: "/var")
        guard ["private/var", "/private/var"].contains(destination) else { throw XCTSkip("Verified Apple system var alias required") }
        let name = "mindwtr-whisper-root-" + UUID().uuidString.lowercased()
        let canonical = URL(fileURLWithPath: "/private/var/tmp", isDirectory: true).appendingPathComponent(name, isDirectory: true)
        let aliased = URL(fileURLWithPath: "/var/tmp", isDirectory: true).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: false)
        addTeardownBlock { try FileManager.default.removeItem(at: canonical) }
        return (canonical, aliased)
    }

    func testMissingWhisperRootThroughSystemVarAliasReturnsMissing() async throws {
        let roots = try systemVarFixture()
        let selected = roots.aliased.appendingPathComponent("models", isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
        let modelStore = try store(root: selected)
        try await expect(.missing, modelStore, spec())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: roots.canonical.appendingPathComponent("models").path), [".whisper-model-store.lock"])
    }

    func testMissingWhisperRootThroughCanonicalPrivateVarReturnsMissing() async throws {
        let roots = try systemVarFixture()
        let selected = roots.canonical.appendingPathComponent("models", isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
        let modelStore = try store(root: selected)
        try await expect(.missing, modelStore, spec())
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: selected.path), [".whisper-model-store.lock"])
    }

    func testExistingWhisperRootThroughSystemVarAliasCanReopen() async throws {
        let roots = try systemVarFixture()
        let selected = roots.aliased.appendingPathComponent("models", isDirectory: true)
        let initial = try store(root: selected)
        try await expect(.missing, initial, spec())
        try await initial.close()
        for parent in [roots.aliased, roots.canonical] {
            let reopened = try store(root: parent.appendingPathComponent("models", isDirectory: true))
            try await expect(.missing, reopened, spec())
            try await reopened.close()
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: selected.path), [".whisper-model-store.lock"])
    }

    func testMissingWhisperRootThroughLibraryParentSymlinkIsRejected() throws {
        let roots = try systemVarFixture()
        let actual = roots.canonical.appendingPathComponent("actual", isDirectory: true)
        try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: false)
        let marker = actual.appendingPathComponent("unrelated")
        try bytes.write(to: marker)
        try FileManager.default.createSymbolicLink(at: roots.canonical.appendingPathComponent("redirect"), withDestinationURL: actual)
        let selected = roots.aliased.appendingPathComponent("redirect/models", isDirectory: true)
        XCTAssertThrowsError(try NativeWhisperModelStore(root: selected, sessionConfiguration: configuration()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: actual.appendingPathComponent("models").path))
        XCTAssertEqual(try Data(contentsOf: marker), bytes)
    }

    func testWhisperRootSymlinkIsRejectedBeforeStoreCreation() throws {
        let roots = try systemVarFixture()
        let actual = roots.canonical.appendingPathComponent("actual", isDirectory: true)
        try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: false)
        let marker = actual.appendingPathComponent("unrelated")
        try bytes.write(to: marker)
        try FileManager.default.createSymbolicLink(at: roots.canonical.appendingPathComponent("models"), withDestinationURL: actual)
        XCTAssertThrowsError(try NativeWhisperModelStore(root: roots.aliased.appendingPathComponent("models", isDirectory: true), sessionConfiguration: configuration()))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: actual.path), ["unrelated"])
        XCTAssertEqual(try Data(contentsOf: marker), bytes)
    }

    func testInitializerFailuresReportTheirPhaseAndPreserveRefusal() async throws {
        let state = WhisperModelFixtureState()
        let selected = try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration())
        addTeardownBlock { try? await selected.close() }
        XCTAssertThrowsError(try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration(), onFailure: state.diagnostic)) {
            XCTAssertEqual($0 as? NativeWhisperModelError, .busy)
        }
        let file = modelRoot.appendingPathComponent("ordinary-file")
        try bytes.write(to: file)
        XCTAssertThrowsError(try NativeWhisperModelStore(root: file, sessionConfiguration: configuration(), onFailure: state.diagnostic)) {
            XCTAssertEqual($0 as? NativeWhisperModelError, .unavailable)
        }
        XCTAssertEqual(state.diagnosticValues.map(\.stage), [.lock, .initialization])
        XCTAssertEqual(state.diagnosticValues.map(\.reason), [.busy, .unavailable])
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testRealWriterIdentityFailureReportsWriterAndKeepsReservation() async throws {
        let state = WhisperModelFixtureState(), root = modelRoot
        let selected = try NativeWhisperModelStore(root: root, sessionConfiguration: configuration(), onFailure: state.diagnostic)
        addTeardownBlock { try? await selected.close() }
        WhisperModelHTTPFixture.install { transport in _ = state.record(transport.request); transport.reply(Data(), status: 500) }
        selected.beforeReservedWriterOpen = {
            let name = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: root.path).first { $0.hasSuffix(".candidate") })
            let directory = root.appendingPathComponent(name)
            try FileManager.default.moveItem(at: directory.appendingPathComponent("stage"), to: directory.appendingPathComponent("original"))
            try Data().write(to: directory.appendingPathComponent("stage"), options: .withoutOverwriting)
        }
        do { try await selected.install(spec()); XCTFail("Writer identity replacement must refuse") }
        catch {
            let value = error as NSError
            XCTAssertEqual(value.domain, "AttachmentFileInstaller"); XCTAssertEqual(value.code, 1)
            XCTAssertEqual(value.userInfo[NSLocalizedDescriptionKey] as? String, "ATTACHMENT_FILE_INSTALLER_FAILED: Reserved attachment writer identity changed")
        }
        XCTAssertEqual(state.diagnosticValues.map(\.stage), [.writer])
        XCTAssertEqual(state.diagnosticValues.map(\.reason), [.writerIdentity])
        XCTAssertNil(state.diagnosticValues.first?.errorNumber); XCTAssertTrue(state.sent.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".whisper-model-install-") }.count, 1)
    }

    func testWriterFailureCallbackPreservesExactErrorAndBoundedPOSIXCode() async throws {
        let state = WhisperModelFixtureState()
        let expected = NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES), userInfo: [NSLocalizedDescriptionKey: "PRIVATE fixture path and title"])
        let selected = try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration(), onFailure: state.diagnostic)
        addTeardownBlock { try? await selected.close() }
        selected.beforeReservedWriterOpen = { throw expected }
        do { try await selected.install(spec()); XCTFail("Injected writer boundary must refuse") }
        catch {
            let actual = error as NSError
            XCTAssertEqual(actual.domain, expected.domain); XCTAssertEqual(actual.code, expected.code)
            XCTAssertEqual(actual.localizedDescription, expected.localizedDescription)
        }
        XCTAssertEqual(state.diagnosticValues.map(\.stage), [.writer]); XCTAssertEqual(state.diagnosticValues.map(\.reason), [.other])
        XCTAssertEqual(state.diagnosticValues.first?.errorNumber, Int(EACCES))
    }

    func testTransferFailureDiagnosticAndCleanupRemainDistinct() async throws {
        let state = WhisperModelFixtureState()
        let selected = try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration(), onFailure: state.diagnostic)
        addTeardownBlock { try? await selected.close() }
        WhisperModelHTTPFixture.install { transport in _ = state.record(transport.request); transport.reply(Data(), status: 500) }
        do { try await selected.install(spec()); XCTFail("HTTP failure must refuse") }
        catch { XCTAssertEqual(error as? NativeWhisperModelError, .downloadFailed) }
        XCTAssertEqual(state.diagnosticValues.map(\.stage), [.transfer]); XCTAssertEqual(state.diagnosticValues.map(\.reason), [.download])
        XCTAssertEqual(state.sent.count, 1); try assertNoPrivateStages(modelRoot)
    }

    func testCleanupFailureDiagnosticKeepsRecordAndOriginalError() async throws {
        let state = WhisperModelFixtureState(), expected = NSError(domain: NSPOSIXErrorDomain, code: Int(EBUSY))
        let selected = try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration(), onFailure: state.diagnostic)
        addTeardownBlock { try? await selected.close() }
        WhisperModelHTTPFixture.install { transport in _ = state.record(transport.request); transport.reply(Data(), status: 500) }
        selected.beforeRemovalClaim = { _ in throw expected }
        do { try await selected.install(spec()); XCTFail("Cleanup failure must remain retained") }
        catch {
            let actual = error as NSError
            XCTAssertEqual(actual.domain, expected.domain); XCTAssertEqual(actual.code, expected.code)
            XCTAssertEqual(actual.localizedDescription, expected.localizedDescription)
        }
        XCTAssertEqual(state.diagnosticValues.map(\.stage), [.transfer, .cleanup])
        XCTAssertEqual(state.diagnosticValues.last?.errorNumber, Int(EBUSY))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: modelRoot.path).filter { $0.hasPrefix(".whisper-model-install-") }.count, 1)
    }

    func testDiagnosticClassifierDoesNotExposeUnrecognizedErrorDetails() throws {
        let error = NSError(domain: "PRIVATE", code: 9000, userInfo: [NSLocalizedDescriptionKey: "PRIVATE path content", NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: 9000)])
        let value = NativeWhisperModelDiagnostic(stage: .recovery, error: error)
        XCTAssertEqual(value.stage, .recovery); XCTAssertEqual(value.reason, .other); XCTAssertNil(value.errorNumber)
        let wrapped = NativeWhisperModelDiagnostic(stage: .admission, error: NativeWhisperModelError.busy)
        XCTAssertEqual(wrapped.reason, .busy); XCTAssertNil(wrapped.errorNumber)
    }

    func testSharedCatalogProjectionHasClosedGrammarAndNativeSizeBoundary() throws {
        let value: [String: Any] = ["version": 1, "id": "whisper-tiny", "fileName": "ggml-tiny.bin", "sizeBytes": bytes.count,
                                   "sha256": digest(bytes), "urls": ["https://models.example.test/ggml-tiny.bin"]]
        func json(_ value: Any) throws -> String { try NativeVoiceJSON.encode(value) }
        XCTAssertEqual(try NativeWhisperModelSpec.validated(json(value)).sizeBytes, Int64(bytes.count))
        for change in [["version": true] as [String: Any], ["sizeBytes": true], ["sizeBytes": 150_000_001], ["extra": true],
                       ["id": "whisper-large-v3-turbo"], ["fileName": "../ggml-tiny.bin"], ["sha256": digest(bytes).uppercased()],
                       ["urls": ["http://models.example.test/ggml-tiny.bin"]], ["urls": ["https://secret@models.example.test/ggml-tiny.bin"]],
                       ["urls": ["https://models.example.test/ggml-tiny.bin#fragment"]], ["urls": ["https://models.example.test/wrong.bin"]]] {
            var changed = value; changed.merge(change) { _, new in new }
            XCTAssertThrowsError(try NativeWhisperModelSpec.validated(json(changed)))
        }
        XCTAssertThrowsError(try NativeWhisperModelSpec.validated("{\"version\":1,\"version\":1}"))
    }

    func testChunkedInstallVerifiesExactBytesAndRepeatedInstallDoesNoDownload() async throws {
        let model = spec(), state = WhisperModelFixtureState(), bytes = self.bytes, store = try store()
        WhisperModelHTTPFixture.install { transport in _ = state.record(transport.request); transport.reply(bytes, headers: ["Content-Length": String(bytes.count)]) }
        try await expect(.missing, store, model)
        try await store.install(model, progress: { received, total in XCTAssertEqual(total, model.sizeBytes); state.progress(received) })
        try await expect(.installed, store, model)
        XCTAssertEqual(try Data(contentsOf: modelRoot.appendingPathComponent(model.fileName)), bytes)
        XCTAssertEqual(state.progress.last, model.sizeBytes); XCTAssertFalse(state.progress.isEmpty)
        XCTAssertEqual(state.progress, state.progress.sorted())
        XCTAssertTrue(state.sent.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil && $0.value(forHTTPHeaderField: "Cookie") == nil
            && $0.value(forHTTPHeaderField: "Accept-Encoding") == "identity" })
        try await store.install(model)
        XCTAssertEqual(state.sent.count, 1); try assertNoPrivateStages(modelRoot)
    }

    func testSystemVarRootInstallPublishesAndReopensVerifiedModel() async throws {
        let roots = try systemVarFixture(), model = spec(), bytes = self.bytes
        let root = roots.aliased.appendingPathComponent("models", isDirectory: true)
        let selected = try store(root: root)
        WhisperModelHTTPFixture.install { $0.reply(bytes, headers: ["Content-Length": String(bytes.count)]) }
        try await selected.install(model)
        try await expect(.installed, selected, model)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(model.fileName)), bytes)
        try assertNoPrivateStages(root)
        try await selected.close()
        let reopened = try store(root: root)
        try await expect(.installed, reopened, model)
    }

    func testBadHashTruncatedOversizeStatusEncodingAndDeclaredLengthNeverPublish() async throws {
        let cases: [(Data, Int, [String: String])] = [(Data(repeating: 9, count: bytes.count), 200, [:]), (bytes.dropLast(), 200, [:]),
            (bytes + Data([1]), 200, [:]), (bytes, 404, [:]), (bytes, 200, ["Content-Encoding": "gzip"]),
            (bytes, 200, ["Content-Length": String(bytes.count + 1)])]
        for (payload, status, headers) in cases {
            let root = fixture.appendingPathComponent("model-" + UUID().uuidString), store = try store(root: root)
            WhisperModelHTTPFixture.install { $0.reply(payload, status: status, headers: headers) }
            do { try await store.install(spec()); XCTFail("Unverified model was installed") } catch {}
            try await expect(.missing, store, spec()); try assertNoPrivateStages(root); try await store.close()
        }
    }

    func testIntegrityFailureUsesMirrorWithFreshReservation() async throws {
        let model = spec(mirrors: true), bytes = self.bytes, state = WhisperModelFixtureState(), store = try store(), root = modelRoot
        WhisperModelHTTPFixture.install { transport in
            let count = state.record(transport.request)
            let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
            let stages = names.filter { $0.hasPrefix(".mindwtr-install-") && $0.hasSuffix(".candidate") }
            XCTAssertEqual(stages.count, 1); state.stage(stages.first ?? "missing")
            transport.reply(count == 1 ? Data(repeating: 8, count: bytes.count) : bytes)
        }
        try await store.install(model)
        XCTAssertEqual(state.sent.map { $0.url?.host }, ["models.example.test", "mirror.example.test"])
        XCTAssertEqual(state.stageNames.count, 2)
        if state.stageNames.count == 2 { XCTAssertNotEqual(state.stageNames[0], state.stageNames[1]) }
        try await expect(.installed, store, model); try assertNoPrivateStages(modelRoot)
    }

    func testHTTPSCrossHostSignedRedirectStripsCredentials() async throws {
        let state = WhisperModelFixtureState(), bytes = self.bytes, store = try store()
        WhisperModelHTTPFixture.install { transport in
            let count = state.record(transport.request)
            if count == 1 { transport.redirect(URL(string: "https://cdn.example.test/content?signature=SYNTHETIC")!) }
            else { transport.reply(bytes) }
        }
        try await store.install(spec())
        XCTAssertEqual(state.sent.count, 2)
        XCTAssertEqual(state.sent.last?.url?.host, "cdn.example.test")
        XCTAssertEqual(state.sent.last?.url?.query, "signature=SYNTHETIC")
        XCTAssertNil(state.sent.last?.value(forHTTPHeaderField: "Authorization")); XCTAssertNil(state.sent.last?.value(forHTTPHeaderField: "Cookie"))
        try await expect(.installed, store, spec())
    }

    func testInsecureAndExcessiveRedirectsRefuseWithoutPublication() async throws {
        for excessive in [false, true] {
            let state = WhisperModelFixtureState(), root = fixture.appendingPathComponent(UUID().uuidString), store = try store(root: root)
            WhisperModelHTTPFixture.install { transport in
                let count = state.record(transport.request)
                transport.redirect(URL(string: (excessive ? "https://cdn.example.test/hop" + String(count) : "http://cdn.example.test/model"))!)
            }
            do { try await store.install(spec()); XCTFail("Invalid redirect chain installed") } catch {}
            XCTAssertEqual(state.sent.count, excessive ? 6 : 1)
            try await expect(.missing, store, spec()); try assertNoPrivateStages(root); try await store.close()
        }
    }

    func testCancellationDrainsCleanupWithoutMirrorAndStoreRemainsReusable() async throws {
        let store = try store(), state = WhisperModelFixtureState(), payload = Data(repeating: 17, count: 256 * 1024)
        let initial = spec(mirrors: true)
        let model = NativeWhisperModelSpec(id: initial.id, fileName: initial.fileName, sizeBytes: Int64(payload.count),
            sha256: digest(payload), urls: initial.urls)
        let started = expectation(description: "Partial bytes written")
        let token = NativeAttachmentCancellation(), partial = payload.prefix(128 * 1024)
        WhisperModelHTTPFixture.install({ transport in
            _ = state.record(transport.request)
            transport.reply(partial, headers: ["Content-Length": String(payload.count)], finish: false)
        })
        let install = Task { try await store.install(model, cancellation: token, progress: { _, _ in if state.once() { started.fulfill() } }) }
        await fulfillment(of: [started], timeout: 5)
        await store.cancelAndDrain()
        try assertNoPrivateStages(modelRoot)
        do { try await install.value; XCTFail("Cancelled download succeeded") } catch {}
        XCTAssertEqual(state.sent.count, 1)
        try await expect(.missing, store, model); try assertNoPrivateStages(modelRoot)
        WhisperModelHTTPFixture.install { $0.reply(payload) }
        try await store.install(model)
        try await expect(.installed, store, model)
    }

    func testNoReplacePublicationPreservesInterveningTarget() async throws {
        let store = try store(), bytes = self.bytes, state = WhisperModelFixtureState(), root = modelRoot, model = spec()
        let foreign = Data("intervening existing model".utf8)
        WhisperModelHTTPFixture.install { $0.reply(bytes) }
        do {
            try await store.install(model, progress: { _, _ in
                if state.once() { do { try foreign.write(to: root.appendingPathComponent(model.fileName), options: .atomic) } catch { XCTFail("Could not inject existing target") } }
            })
            XCTFail("Invalid existing target was adopted")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(model.fileName)), foreign)
        try await expect(.invalid, store, model); try assertNoPrivateStages(root)
    }

    func testExistingVerifiedModelSurvivesRejectedDifferentGeneration() async throws {
        let store = try store(), bytes = self.bytes, model = spec(), state = WhisperModelFixtureState()
        WhisperModelHTTPFixture.install { transport in _ = state.record(transport.request); transport.reply(bytes) }
        try await store.install(model)
        let changed = NativeWhisperModelSpec(id: model.id, fileName: model.fileName, sizeBytes: model.sizeBytes,
            sha256: digest(Data(repeating: 8, count: bytes.count)), urls: model.urls)
        do { try await store.install(changed); XCTFail("Existing generation was replaced implicitly") } catch {}
        XCTAssertEqual(state.sent.count, 1)
        XCTAssertEqual(try Data(contentsOf: modelRoot.appendingPathComponent(model.fileName)), bytes)
        try await expect(.installed, store, model)
    }

    func testReplacedDownloadStageRetainsRecordAndForeignBytesAcrossRestart() async throws {
        let store = try store(), bytes = self.bytes, root = modelRoot, state = WhisperModelFixtureState()
        let replacement = Data("SYNTHETIC-REPLACED-STAGE".utf8)
        WhisperModelHTTPFixture.install { $0.reply(bytes) }
        do {
            try await store.install(spec(), progress: { _, _ in
                if state.once() {
                    do {
                        let candidate = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: root.path).first { $0.hasPrefix(".mindwtr-install-") && $0.hasSuffix(".candidate") })
                        try replacement.write(to: root.appendingPathComponent(candidate + "/stage"), options: .atomic)
                    } catch { XCTFail("Could not replace fixture stage") }
                }
            })
            XCTFail("Changed stage was published")
        } catch {}
        try await expect(.missing, store, spec()); try await store.close()
        let restarted = try self.store()
        let candidate = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: root.path).first { $0.hasPrefix(".mindwtr-install-") && $0.hasSuffix(".candidate") })
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(candidate + "/stage")), replacement)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".whisper-model-install-") })
        try await expect(.missing, restarted, spec())
    }

    func testLeaseBlocksRemoveAndCloseUntilExplicitReleaseAndDuplicatePinsBytes() async throws {
        let store = try store(), bytes = self.bytes, model = spec()
        WhisperModelHTTPFixture.install { $0.reply(bytes) }; try await store.install(model)
        let lease = try await store.acquire(model); try await lease.validate()
        let descriptor = try await lease.duplicateDescriptor()
        var buffer = [UInt8](repeating: 0, count: bytes.count)
        XCTAssertEqual(Darwin.read(descriptor, &buffer, bytes.count), bytes.count); Darwin.close(descriptor)
        XCTAssertEqual(Data(buffer), bytes)
        do { try await store.remove(model); XCTFail("Active decoder lease was removed") } catch {}
        do { try await store.close(); XCTFail("Active decoder lease was closed") } catch {}
        do { _ = try await lease.duplicateDescriptor(); XCTFail("Closing store admitted another decoder") } catch {}
        XCTAssertThrowsError(try NativeWhisperModelStore(root: modelRoot, sessionConfiguration: configuration()))
        await lease.release(); await lease.release(); try await store.close()
        do { try await lease.validate(); XCTFail("Released lease validated") } catch {}
        let replacement = try self.store(); try await expect(.installed, replacement, model)
        try await replacement.remove(model); try await expect(.missing, replacement, model)
    }

    func testSymlinkHardlinkAndDirectoryModelsNeverAcquireOrRemove() async throws {
        let model = spec(), store = try store(), outside = fixture.appendingPathComponent("outside.bin")
        try bytes.write(to: outside)
        let target = modelRoot.appendingPathComponent(model.fileName)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside)
        try await expect(.invalid, store, model)
        do { _ = try await store.acquire(model); XCTFail("Symlink model acquired") } catch {}
        do { try await store.remove(model); XCTFail("Symlink model removed") } catch {}
        try FileManager.default.removeItem(at: target)
        try FileManager.default.linkItem(at: outside, to: target)
        try await expect(.invalid, store, model)
        do { try await store.remove(model); XCTFail("Hardlinked model removed") } catch {}
        try FileManager.default.removeItem(at: target)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        try await expect(.invalid, store, model)
        XCTAssertEqual(try Data(contentsOf: outside), bytes)
    }

    func testRemovalClaimRefusesAndRestoresSubstitutedModelGeneration() async throws {
        let store = try store(), model = spec(), bytes = self.bytes, target = modelRoot.appendingPathComponent(spec().fileName)
        WhisperModelHTTPFixture.install { $0.reply(bytes) }; try await store.install(model)
        let replacement = Data("SYNTHETIC-REPLACEMENT-GENERATION".utf8), state = WhisperModelFixtureState()
        store.beforeRemovalClaim = { name in
            if name == model.fileName, state.once() { try replacement.write(to: target, options: .atomic) }
        }
        do { try await store.remove(model); XCTFail("Substituted generation was deleted") } catch {}
        XCTAssertEqual(try Data(contentsOf: target), replacement)
        try await expect(.invalid, store, model)
    }

    func testPinnedDescriptorHashCannotBorrowDigestFromTemporaryRootReplacement() async throws {
        let store = try store(), model = spec(), root = modelRoot, held = fixture.appendingPathComponent("retained-model-root")
        let invalid = Data(repeating: 5, count: bytes.count)
        try invalid.write(to: root.appendingPathComponent(model.fileName))
        let bytes = self.bytes
        store.beforeModelHash = {
            try FileManager.default.moveItem(at: root, to: held)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
            try bytes.write(to: root.appendingPathComponent(model.fileName))
        }
        store.afterModelHash = {
            try FileManager.default.removeItem(at: root)
            try FileManager.default.moveItem(at: held, to: root)
        }
        try await expect(.invalid, store, model)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(model.fileName)), invalid)
    }

    private func abandoned(recorded: Bool) throws -> ImmutableAttachmentPreparedStage {
        try FileManager.default.createDirectory(at: modelRoot, withIntermediateDirectories: true)
        let model = spec(), installer = try AttachmentFileInstaller(targetRoot: modelRoot, sourceRoots: [modelRoot])
        let operation = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let prepared = try installer.prepareImmutableStage(targetInput: modelRoot.appendingPathComponent(model.fileName), operationId: operation)
        let writer = try installer.openPreparedStageForWriting(prepared, targetInput: modelRoot.appendingPathComponent(model.fileName))
        try writer.append(Data([1, 2, 3])); try writer.synchronize(); writer.close()
        if recorded {
            let record: [String: Any] = ["version": 1, "id": model.id, "fileName": model.fileName, "sizeBytes": model.sizeBytes, "sha256": model.sha256,
                "operation": operation, "stagedIdentity": prepared.stagedIdentity, "directoryIdentity": prepared.directoryIdentity, "privateDirectoryIdentity": prepared.privateDirectoryIdentity]
            try DurableFile.write(JSONSerialization.data(withJSONObject: record), to: modelRoot.appendingPathComponent(".whisper-model-install-" + operation + ".json"))
        }
        return prepared
    }

    func testRestartRetiresOnlyExactRecordedStageAndPreservesUnknownPartial() async throws {
        let recorded = try abandoned(recorded: true), unknown = try abandoned(recorded: false)
        let store = try store()
        XCTAssertFalse(FileManager.default.fileExists(atPath: recorded.stagedUrl.path))
        XCTAssertEqual(try Data(contentsOf: unknown.stagedUrl), Data([1, 2, 3]))
        try await expect(.missing, store, spec())
    }

    func testRestartPreservesRecordedNamespaceReplacement() async throws {
        let original = try abandoned(recorded: true), moved = fixture.appendingPathComponent("retained-private-stage")
        let directory = original.stagedUrl.deletingLastPathComponent(), foreign = Data("SYNTHETIC-UNKNOWN-STAGE".utf8)
        try FileManager.default.moveItem(at: directory, to: moved)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try foreign.write(to: original.stagedUrl)
        let store = try store()
        XCTAssertEqual(try Data(contentsOf: original.stagedUrl), foreign)
        XCTAssertEqual(try Data(contentsOf: moved.appendingPathComponent("stage")), Data([1, 2, 3]))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: modelRoot.path).contains { $0.hasPrefix(".whisper-model-install-") })
        try await expect(.missing, store, spec())
    }
}
