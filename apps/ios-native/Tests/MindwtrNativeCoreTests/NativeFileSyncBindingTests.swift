import CryptoKit
import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class FileBindingNoNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("The app-local File Sync slice must not access the network")
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

private final class FileBindingDrainObservation: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let nativeClosed = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var values: [String: Int] = [:]
    @discardableResult func record(_ value: String) -> Int {
        lock.lock(); defer { lock.unlock() }; values[value, default: 0] += 1; return values[value, default: 0]
    }
    func count(_ value: String) -> Int { lock.lock(); defer { lock.unlock() }; return values[value, default: 0] }
}

final class NativeFileSyncBindingTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.file-binding-tests"
    private var container: URL { root.appendingPathComponent("container", isDirectory: true) }
    private var selected: URL { container.appendingPathComponent("Sync 資料 folder", isDirectory: true) }
    private var manifest: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private let configuration = ["@mindwtr_sync_backend": "off", "@mindwtr_sync_path": "preserved selection", "@mindwtr_sync_path_bookmark": "preserved bookmark"]
    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              let evidence = ProcessInfo.processInfo.environment["MINDWTR_FILE_SYNC_APP_BINDING_EVIDENCE_ROOT"],
              source.hasPrefix("/"), evidence.hasPrefix("/"), FileManager.default.isReadableFile(atPath: source) else {
            throw HostFailure("File Sync binding requires its production bundle and retained evidence root")
        }
        bundle = URL(fileURLWithPath: source)
        let fixture = URL(fileURLWithPath: evidence, isDirectory: true).appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        root = fixture.resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(configuration).utf8).write(to: manifest)
        try Data([0, 255, 7]).write(to: selected.appendingPathComponent("unknown.bin"))
        try Data(json(["test": name, "bundleSHA256": hash(Data(contentsOf: bundle))]).utf8).write(to: root.appendingPathComponent("input.json"))
    }
    override func tearDownWithError() throws {
        guard let root else { return }
        var files: [[String: Any]] = []
        let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
        while let url = entries?.nextObject() as? URL {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                let bytes = try Data(contentsOf: url)
                files.append(["name": String(url.path.dropFirst(root.path.count + 1)), "bytes": bytes.count, "sha256": hash(bytes)])
            }
        }
        try Data(json(["test": name, "files": files]).utf8).write(to: root.appendingPathComponent("retained-manifest.json"))
    }
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ text: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any]) }
    private func host(configure: ((HostIOFaults) -> Void)? = nil, closeOnTearDown: Bool = true) -> CoreHost {
        let faults = HostIOFaults(), network = URLSessionConfiguration.ephemeral
        network.protocolClasses = [FileBindingNoNetwork.self]; faults.httpConfiguration = network
        faults.secretStatus = { _, _ in errSecItemNotFound }
        configure?(faults)
        let host = CoreHost(databaseURL: root.appendingPathComponent("core.sqlite"), bundleURL: bundle, faults: faults,
                            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        if closeOnTearDown { addTeardownBlock { await host.close() } }
        return host
    }
    private func export(_ host: CoreHost, _ name: String) async throws -> [String: Any] {
        let exported = try await host.prepareDataBackup(), bytes = try Data(contentsOf: exported.url)
        try bytes.write(to: root.appendingPathComponent(name))
        await host.discardDataBackup(exported.id)
        return try object(String(decoding: bytes, as: UTF8.self))
    }
    private func capture(_ host: CoreHost) async throws -> String {
        let opened = try object(await host.call("captureOpen")), id = UUID().uuidString.lowercased()
        let request = try json([json(["text": "Synthetic local row", "options": XCTUnwrap(opened["options"]), "captureId": id, "openAfterSave": false])])
        let saved = try object(await host.call("captureSubmit", argumentsJSON: request))
        XCTAssertEqual(saved["kind"] as? String, "saved"); return id
    }
    private func readConfiguration() throws -> [String: String] {
        let values = try object(String(contentsOf: manifest, encoding: .utf8))
        return configuration.keys.reduce(into: [:]) { $0[$1] = values[$1] as? String }
    }
    private func refuses(_ operation: () async throws -> Void) async {
        do { try await operation(); XCTFail("Expected refusal") } catch { }
    }
    func testRealCoreHostMergesNonemptyDocumentsThenUsesFreshUnchangedTurn() async throws {
        let host = host(); _ = try await host.start()
        let local = try await capture(host), remote = UUID().uuidString.lowercased()
        var document = try await export(host, "local-before.json")
        let loggingBefore = (document["settings"] as? [String: Any])?["diagnostics"] as? [String: Any]
        XCTAssertNotEqual(loggingBefore?["loggingEnabled"] as? Bool, true, "Completion evidence must not require detailed logging")
        document["tasks"] = [["id": remote, "title": "Synthetic remote row", "status": "inbox", "tags": [], "contexts": [],
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "rev": 1]]
        let file = selected.appendingPathComponent("data.json")
        try Data(json(document).utf8).write(to: file)
        try Data(contentsOf: file).write(to: root.appendingPathComponent("remote-before.json"))
        let first = try object(await host.foregroundFileSync(directoryURL: selected))
        XCTAssertEqual(first["success"] as? Bool, true); XCTAssertNil(first["skipped"]); XCTAssertNil(first["fileSyncLockDeferred"])
        let after = try await export(host, "local-after-first.json")
        let rows = try XCTUnwrap(after["tasks"] as? [[String: Any]])
        XCTAssertEqual(Set(rows.compactMap { $0["id"] as? String }), Set([local, remote]))
        let published = try object(String(contentsOf: file, encoding: .utf8))
        XCTAssertEqual(Set((published["tasks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }), Set([local, remote]))
        let savedValues = try object(String(contentsOf: manifest, encoding: .utf8))
        let status = try object(XCTUnwrap(savedValues["@mindwtr_local_sync_status_v1"] as? String))
        XCTAssertEqual(status["lastSyncStatus"] as? String, "success")
        XCTAssertNotNil(status["lastSyncAt"])
        XCTAssertEqual(try readConfiguration(), configuration)
        let firstBytes = try Data(contentsOf: file)
        let second = try object(await host.foregroundFileSync(directoryURL: selected))
        XCTAssertEqual(second["success"] as? Bool, true); XCTAssertNil(second["skipped"])
        XCTAssertEqual(try Data(contentsOf: file), firstBytes, "An unchanged second turn must not republish")
        let secondLocal = try await export(host, "local-after-second.json")
        let loggingAfter = (secondLocal["settings"] as? [String: Any])?["diagnostics"] as? [String: Any]
        XCTAssertNotEqual(loggingAfter?["loggingEnabled"] as? Bool, true)
        let diagnosticText = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        let diagnosticRows = try diagnosticText.split(separator: "\n").map { try object(String($0)) }
        let completions = diagnosticRows.filter { $0["message"] as? String == "Native iOS File Sync app binding completed" }
        XCTAssertEqual(completions.count, 2, "Each successful closed foreground turn must force one marker while logging is off")
        for completion in completions {
            XCTAssertEqual(Set(completion.keys), Set(["ts", "level", "scope", "message", "context"]))
            XCTAssertNotNil(completion["ts"] as? String)
            XCTAssertEqual(completion["level"] as? String, "info")
            XCTAssertEqual(completion["scope"] as? String, "native-ios")
            let context = try XCTUnwrap(completion["context"] as? [String: String])
            XCTAssertEqual(context, ["releaseCheck": "v1.3.8/ios-file-sync-app-binding", "operation": "foreground", "outcome": "completed"])
        }
        XCTAssertEqual(try readConfiguration(), configuration)
        XCTAssertEqual(try Data(contentsOf: selected.appendingPathComponent("unknown.bin")), Data([0, 255, 7]))
        try Data(json(["first": first, "second": second]).utf8).write(to: root.appendingPathComponent("result.json"))
        await host.close()
        let reopened = self.host(); let cold = try object(await reopened.start())
        XCTAssertEqual(cold["total"] as? Int, 2)
        await reopened.close()
    }
    func testUnsupportedStoredFileAndPublicSelectionRemainUnavailable() async throws {
        var config = configuration; config["@mindwtr_sync_backend"] = "file"
        try Data(json(config).utf8).write(to: manifest)
        let before = try Data(contentsOf: manifest), host = host(); _ = try await host.start()
        let stored = try object(await host.foregroundSync(command: "syncStored", requestJSON: "{}"))
        XCTAssertEqual(stored["ok"] as? Bool, false)
        let choice = try object(await host.foregroundSync(command: "selectSyncBackend", requestJSON: "{\"option\":\"file\"}"))
        XCTAssertEqual(choice["ok"] as? Bool, false)
        XCTAssertEqual(try Data(contentsOf: manifest), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.appendingPathComponent("data.json").path))
        await host.close()
    }
    func testCancelledForegroundCallDoesNotPublishOrRetainLease() async throws {
        let host = host(); _ = try await host.start()
        let gate = DispatchSemaphore(value: 0)
        let task = Task { gate.wait(); return try await host.foregroundFileSync(directoryURL: selected) }
        task.cancel(); gate.signal()
        await refuses { _ = try await task.value }
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.appendingPathComponent("data.json").path))
        await host.close()
    }
    private func reply(_ jobs: NativeFileSyncJobs, _ request: [String: Any]) async throws -> [String: Any] {
        let id = jobs.submit(try json(request)), deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let text = jobs.next() {
                var answer = try object(text); XCTAssertEqual(answer["id"] as? String, id)
                if answer["body"] as? Bool == true { answer["base64"] = try jobs.body() }
                return answer
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        throw HostFailure("Native File Sync mailbox did not settle")
    }
    func testRealMailboxRejectsForeignTokenURIAndNoncanonicalBase64ThenDrains() async throws {
        for mode in ["foreign", "uri", "base64"] {
            let jobs = try NativeFileSyncJobs(directoryURL: selected)
            let opened = try await reply(jobs, ["turn": jobs.token, "op": "open"])
            XCTAssertNil(opened["error"])
            let request: [String: Any]
            if mode == "foreign" { request = ["turn": "foreign", "op": "read", "uri": jobs.canonicalPath] }
            else if mode == "uri" { request = ["turn": jobs.token, "op": "read", "uri": jobs.rootURI + "%64ata.json"] }
            else { request = ["turn": jobs.token, "op": "writeCreated", "uri": jobs.canonicalPath, "base64": "Zg==\n"] }
            let answer = try await reply(jobs, request); XCTAssertNotNil(answer["error"])
            try jobs.closeAndDrain()
            let stale = try await reply(jobs, ["turn": jobs.token, "op": "revalidate"]); XCTAssertNotNil(stale["error"])
            try jobs.closeAndDrain()
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: selected.appendingPathComponent("data.json").path))
    }
    func testRealMailboxCodecSupportsProductionEightMiBBoundAndRejectsOversize() async throws {
        let file = selected.appendingPathComponent("data.json"), exact = Data(repeating: 7, count: NativeHTTPJobs.maximumBytes)
        try exact.write(to: file)
        let jobs = try NativeFileSyncJobs(directoryURL: selected)
        let opened = try await reply(jobs, ["turn": jobs.token, "op": "open"]); XCTAssertNil(opened["error"])
        let answer = try await reply(jobs, ["turn": jobs.token, "op": "read", "uri": jobs.canonicalPath])
        XCTAssertEqual(answer["value"] as? String, "bytes")
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(answer["base64"] as? String)), exact)
        try jobs.closeAndDrain()
        var oversize = exact; oversize.append(8); try oversize.write(to: file)
        let bounded = try NativeFileSyncJobs(directoryURL: selected)
        let nextOpen = try await reply(bounded, ["turn": bounded.token, "op": "open"]); XCTAssertNil(nextOpen["error"])
        let rejected = try await reply(bounded, ["turn": bounded.token, "op": "read", "uri": bounded.canonicalPath])
        XCTAssertNotNil(rejected["error"]); XCTAssertNil(rejected["body"])
        try bounded.closeAndDrain()
        XCTAssertEqual(try Data(contentsOf: file), oversize)
    }

    func testForegroundRefusesExternalAndContainerPrefixSiblingBeforeSessionConstruction() async throws {
        let observation = FileBindingDrainObservation()
        let host = host(configure: { faults in
            faults.configureFileSyncJobs = { _ in observation.record("constructed") }
        })
        _ = try await host.start()
        for name in ["external", "container-peer"] {
            let outside = root.appendingPathComponent(name, isDirectory: true), bytes = Data([0, 255, 7, 42])
            try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
            try bytes.write(to: outside.appendingPathComponent("sentinel"))
            await refuses { _ = try await host.foregroundFileSync(directoryURL: outside) }
            XCTAssertEqual(observation.count("constructed"), 0, "Refuse before jobs/session/scope/lease admission")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), ["sentinel"])
            XCTAssertEqual(try Data(contentsOf: outside.appendingPathComponent("sentinel")), bytes)
            XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent(".mindwtr.lock").path))
        }
        XCTAssertEqual(try readConfiguration(), configuration)
        await host.close()
    }
    func testEnteredCoreHostReadCancellationWithRealCleanupFailureTerminatesAndRetiresHost() async throws {
        let observation = FileBindingDrainObservation(), directory = selected
        defer { observation.release.signal() }
        let host = host(configure: { faults in
            faults.configureFileSyncJobs = { jobs in
                observation.record("constructed")
                jobs.afterRead = {
                    guard observation.record("read") == 1 else {
                        XCTFail("Unexpected repeated real owner read after the cancellation gate"); return
                    }
                    do {
                        // The actual session has returned complete bytes under its still-held real lease.
                        // Replace the named lock inode, so its real release validation must fail.
                        try FileManager.default.moveItem(at: directory.appendingPathComponent(".mindwtr.lock"),
                            to: directory.appendingPathComponent("retained-original-lock"))
                        try Data().write(to: directory.appendingPathComponent(".mindwtr.lock"))
                    } catch { XCTFail("Could not replace the real held lock inode: \(error)") }
                    observation.entered.signal()
                    observation.release.wait()
                }
                jobs.afterClose = { success in
                    observation.record(success ? "close-success" : "close-failed")
                    observation.nativeClosed.signal()
                }
            }
        }, closeOnTearDown: false)
        _ = try await host.start()
        _ = try await host.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
        ])]))
        _ = try await host.diagnosticsFileAction("logShare")
        var remote = try await export(host, "local-before-cancel.json")
        remote["tasks"] = [["id": UUID().uuidString.lowercased(), "title": "Synthetic retained remote row", "status": "inbox",
            "tags": [], "contexts": [], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "rev": 1]]
        let file = directory.appendingPathComponent("data.json"), before = Data(try json(remote).utf8)
        try before.write(to: file)
        let call = Task.detached {
            do { _ = try await host.foregroundFileSync(directoryURL: directory); observation.record("call-success") }
            catch { observation.record("call-refused") }
            observation.returned.signal()
        }
        guard observation.entered.wait(timeout: .now() + 10) == .success else {
            call.cancel(); observation.release.signal(); XCTFail("The production CoreHost did not enter a real owner read"); return
        }
        XCTAssertEqual(observation.count("read"), 1)
        call.cancel()
        guard observation.nativeClosed.wait(timeout: .now() + 10) == .success else {
            observation.release.signal(); XCTFail("The real native close barrier did not finish"); return
        }
        XCTAssertEqual(observation.count("close-failed"), 1)
        XCTAssertEqual(observation.count("close-success"), 0)
        XCTAssertEqual(observation.returned.wait(timeout: .now() + 0.02), .timedOut,
                       "CoreHost must await the entered mailbox work even after real close failure")
        observation.release.signal()
        guard observation.returned.wait(timeout: .now() + 10) == .success else {
            XCTFail("CoreHost kept polling the unavailable JS ticket after native drain"); return
        }
        await call.value
        XCTAssertEqual(observation.count("call-refused"), 1); XCTAssertEqual(observation.count("call-success"), 0)
        await refuses { _ = try await host.foregroundFileSync(directoryURL: directory) }
        XCTAssertEqual(observation.count("constructed"), 1, "An unavailable host cannot admit another session")
        XCTAssertEqual(observation.count("read"), 1)
        let closeFinished = DispatchSemaphore(value: 0)
        let close = Task.detached { await host.close(); closeFinished.signal() }
        guard closeFinished.wait(timeout: .now() + 10) == .success else { XCTFail("CoreHost.close did not terminate"); return }
        await close.value
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)),
                       Set(["data.json", "unknown.bin", ".mindwtr.lock", "retained-original-lock"]))
        let original = Darwin.open(directory.appendingPathComponent("retained-original-lock").path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(original, 0)
        if original >= 0 { XCTAssertEqual(flock(original, LOCK_EX | LOCK_NB), 0); _ = flock(original, LOCK_UN); Darwin.close(original) }
        let rootFD = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(rootFD, 0)
        if rootFD >= 0 { XCTAssertEqual(flock(rootFD, LOCK_EX | LOCK_NB), 0); _ = flock(rootFD, LOCK_UN); Darwin.close(rootFD) }
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertFalse(log.contains("Native iOS File Sync app binding completed"))
        try Data(json(["realReadCount": observation.count("read"), "realCloseFailed": observation.count("close-failed"),
            "callRefused": observation.count("call-refused"), "sessionsConstructed": observation.count("constructed"),
            "publicationUnchanged": true, "hostCloseTerminated": true, "completionAbsent": true]).utf8)
            .write(to: root.appendingPathComponent("cancel-cleanup-result.json"))
    }

}
