import XCTest
import Darwin
@testable import MindwtrNativeCore

final class NativeShareMailboxTests: XCTestCase {
    private var group: URL!, home: URL!, namespace: String!
    private var stores: [NativePersonalIntake] = []
    private var boxes: [NativeShareMailbox] = []
    private enum Injected: Error { case failure }
    override func setUpWithError() throws {
        let id = UUID().uuidString.lowercased(), base = FileManager.default.homeDirectoryForCurrentUser
        namespace = "mindwtr.share.fixture." + id
        group = base.appendingPathComponent(".mindwtr-native-tests/share/" + id)
        home = base.appendingPathComponent(".mindwtr-native-tests/personal-intake/" + id + "/home")
        try FileManager.default.createDirectory(at: group, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }
    override func tearDown() async throws {
        for store in stores { await store.close() }; stores.removeAll(); boxes.removeAll()
        if let group { try FileManager.default.removeItem(at: group) }
        if let home { try FileManager.default.removeItem(at: home.deletingLastPathComponent()) }
    }
    private func mailbox() throws -> NativeShareMailbox {
        let box = try NativeShareMailbox.fixture(root: group, namespace: namespace); boxes.append(box); return box
    }
    private func intake(namespace selected: String? = nil) throws -> NativePersonalIntake {
        let route = try NativePersonalIntakeRoute.fixture(home: home, bundleIdentifier: selected ?? namespace)
        let store = try NativePersonalIntake(route: route, diagnostic: { _ in }); stores.append(store); return store
    }
    private func envelope(id: UUID = UUID(), text: String = "Shared text") throws -> NativeShareEnvelope {
        try NativeShareEnvelope(id: id, receivedAt: Date(timeIntervalSince1970: 100), subject: "Subject", text: text, webUrl: "https://example.com/doc")
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch {}
    }
    func testClosedEnvelopeBoundsAndDevGroupAdmission() throws {
        XCTAssertEqual(try NativeShareMailbox.group(for: NativeShareMailbox.appIdentifier), NativeShareMailbox.groupIdentifier)
        XCTAssertEqual(try NativeShareMailbox.group(for: NativeShareMailbox.extensionIdentifier), NativeShareMailbox.groupIdentifier)
        XCTAssertEqual(try NativeShareMailbox.group(for: "tech.dongdongbh.mindwtr"), "group.tech.dongdongbh.mindwtr")
        XCTAssertEqual(try NativeShareMailbox.group(for: "tech.dongdongbh.mindwtr.share-extension"), "group.tech.dongdongbh.mindwtr")
        for foreign in ["tech.dongdongbh.mindwtr.dev", "tech.dongdongbh.mindwtr.native.dev.foreign", ""] {
            XCTAssertThrowsError(try NativeShareMailbox.group(for: foreign))
        }
        let value = try envelope(text: String(repeating: "😀", count: 25_000))
        XCTAssertEqual(try NativeShareEnvelope.decode(value.encoded()), value)
        XCTAssertThrowsError(try envelope(text: String(repeating: "😀", count: 25_000) + "x"))
        XCTAssertThrowsError(try NativeShareEnvelope(subject: nil, text: " \n", webUrl: nil))
        XCTAssertThrowsError(try NativeShareEnvelope(subject: nil, text: nil, webUrl: "file:///private/foreign"))
        XCTAssertThrowsError(try NativeShareEnvelope(receivedAt: Date(timeIntervalSince1970: .infinity), subject: nil, text: "text", webUrl: nil))
        let data = try envelope().encoded()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]); object["library"] = "foreign"
        XCTAssertThrowsError(try NativeShareEnvelope.decode(JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])))
        let duplicate = Data("{\"version\":1,\"version\":1}".utf8)
        XCTAssertThrowsError(try NativeShareEnvelope.decode(duplicate))
        // Old navigation envelopes retain their exact canonical wire without a new share member.
        let old = try NativePersonalIntakeEvent.url("mindwtr-native-dev://open?task=a")
        let oldBytes = try IntakeWire.encode(old, limit: IntakeWire.recordLimit)
        XCTAssertFalse(String(decoding: oldBytes, as: UTF8.self).contains("\"share\""))
        XCTAssertEqual(try IntakeWire.decode(NativePersonalIntakeEvent.self, oldBytes, limit: IntakeWire.recordLimit), old)
    }
    func testProducerRetriesOriginalIDAndRefusesChangedPayload() async throws {
        let box = try mailbox(), first = try envelope()
        try await box.publish(first); try await box.publish(first)
        var page = try await box.pendingPage(); XCTAssertEqual(page.items.count, 1); XCTAssertEqual(page.items[0].envelope, first)
        let changed = try envelope(id: XCTUnwrap(UUID(uuidString: first.id)), text: "Changed")
        await refused { try await box.publish(changed) }
        try await box.publish(envelope())
        page = try await box.pendingPage(); XCTAssertEqual(page.items.count, 2)
        XCTAssertNil(page.next)
    }
    func testDevelopmentMailboxExportRetainsExactProducerBytesWithoutAcknowledgment() async throws {
        let box = try mailbox(), first = try envelope(), second = try envelope(text: "Second producer")
        try await box.publish(first); try await box.publish(second)
        let source = group.appendingPathComponent("NativeShare/v1")
        let before = try [first.id, second.id].reduce(into: [String: Data]()) { result, id in
            result[id + ".json"] = try Data(contentsOf: source.appendingPathComponent(id + ".json"))
        }
        let documents = home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: false)
        let run = UUID().uuidString.lowercased()
        let receipt = try await box.exportRaw(documents: documents, run: run)
        XCTAssertEqual(receipt.envelopes, 2)
        XCTAssertEqual(receipt.bytes, before.values.reduce(0) { $0 + $1.count })
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: receipt.directory.path)), Set(before.keys).union(["receipt.json"]))
        for (name, bytes) in before {
            XCTAssertEqual(try Data(contentsOf: receipt.directory.appendingPathComponent(name)), bytes)
            XCTAssertEqual(try Data(contentsOf: source.appendingPathComponent(name)), bytes)
        }
        let raw = try Data(contentsOf: receipt.directory.appendingPathComponent("receipt.json"))
        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(report["acknowledged"] as? Bool, false)
        XCTAssertEqual(report["imported"] as? Bool, false)
        XCTAssertEqual(report["mailboxInitializationMayCreateDirectoriesAndLock"] as? Bool, true)
        let rows = try XCTUnwrap(report["files"] as? [[String: Any]])
        for row in rows {
            let name = try XCTUnwrap(row["name"] as? String), bytes = try XCTUnwrap(before[name])
            XCTAssertEqual(row["sha256"] as? String, IntakeWire.digest(bytes))
            XCTAssertEqual(row["bytes"] as? Int, bytes.count)
        }
        let pending = try await box.pendingPage()
        XCTAssertEqual(Set(pending.items.map(\.envelope.id)), Set([first.id, second.id]))
        await refused { _ = try await box.exportRaw(documents: documents, run: run) }
        XCTAssertEqual(try Data(contentsOf: receipt.directory.appendingPathComponent("receipt.json")), raw)
    }
    func testDevelopmentMailboxExportRejectsForeignRoutingAndMalformedAttempts() throws {
        let run = UUID().uuidString.lowercased(), flag = NativeShareMailboxExport.flag
        XCTAssertEqual(try NativeShareMailboxExport.run(arguments: ["app", flag, run], bundleIdentifier: NativeShareMailbox.appIdentifier), run)
        for bundle in ["tech.dongdongbh.mindwtr", NativeShareMailbox.extensionIdentifier, NativeShareMailbox.appIdentifier + ".uitests.xctrunner", ""] {
            XCTAssertThrowsError(try NativeShareMailboxExport.run(arguments: ["app", flag, run], bundleIdentifier: bundle))
        }
        for arguments in [["app", flag], ["app", flag, "../foreign"], ["app", flag, run.uppercased()], ["app", flag, run, flag, run], ["app", flag + "=" + run]] {
            XCTAssertTrue(NativeShareMailboxExport.requested(arguments: arguments))
            XCTAssertThrowsError(try NativeShareMailboxExport.run(arguments: arguments, bundleIdentifier: NativeShareMailbox.appIdentifier))
        }
        XCTAssertFalse(NativeShareMailboxExport.requested(arguments: ["app"]))
    }
    func testDevelopmentMailboxExportFailureCodesNeverExposeRawDetails() {
        XCTAssertEqual(NativeShareMailboxExport.failureCode(NativeShareError.unavailable), "mailbox-unavailable")
        XCTAssertEqual(NativeShareMailboxExport.failureCode(NativeShareError.invalidInput), "invalid-input")
        XCTAssertEqual(NativeShareMailboxExport.failureCode(NativeShareError.changedSource), "source-changed")
        XCTAssertEqual(NativeShareMailboxExport.failureCode(NativeShareError.full), "mailbox-full")
        for (message, code) in ["Invalid anchored recovery publication": "write-invalid", "Cannot create pending command journal": "write-create",
                                "Cannot retain recovery publication": "write-retain", "Cannot preserve recovery data protection": "write-protection",
                                "Cannot write pending command journal": "write-bytes", "Cannot durably save pending command journal": "write-sync",
                                "Cannot promote pending command journal": "write-promote", "Cannot synchronize recovery data": "directory-sync"] {
            XCTAssertEqual(NativeShareMailboxExport.failureCode(HostFailure(message)), code)
        }
        let privateValue = "/private/task-text/credential"
        XCTAssertEqual(NativeShareMailboxExport.failureCode(HostFailure("Cannot preserve recovery data protection " + privateValue)), "unexpected")
        XCTAssertEqual(NativeShareMailboxExport.failureCode(NSError(domain: privateValue, code: 1, userInfo: [NSLocalizedDescriptionKey: privateValue])), "unexpected")
        XCTAssertEqual(NativeShareMailboxExport.failureCode(Injected.failure), "unexpected")
    }
    func testDevelopmentMailboxExportRefusesSymlinkedOutputAndProducer() async throws {
        let box = try mailbox(), value = try envelope()
        try await box.publish(value)
        let documents = home.appendingPathComponent("Documents"), outside = home.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: documents.appendingPathComponent("NativeShareMailboxExports"), withDestinationURL: outside)
        await refused { _ = try await box.exportRaw(documents: documents, run: UUID().uuidString.lowercased()) }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
        try FileManager.default.removeItem(at: documents.appendingPathComponent("NativeShareMailboxExports"))
        let producer = group.appendingPathComponent("NativeShare/v1/" + value.id + ".json")
        let original = try Data(contentsOf: producer)
        try original.write(to: outside.appendingPathComponent("foreign.json"))
        try FileManager.default.removeItem(at: producer)
        try FileManager.default.createSymbolicLink(at: producer, withDestinationURL: outside.appendingPathComponent("foreign.json"))
        await refused { _ = try await box.exportRaw(documents: documents, run: UUID().uuidString.lowercased()) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appendingPathComponent("NativeShareMailboxExports").path))
        XCTAssertEqual(try Data(contentsOf: outside.appendingPathComponent("foreign.json")), original)
    }
    func testDevelopmentMailboxExportRefusesMalformedEnvelopeWithoutChangingQueue() async throws {
        let box = try mailbox(), value = try envelope()
        try await box.publish(value)
        let source = group.appendingPathComponent("NativeShare/v1"), documents = home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: false)
        let valid = source.appendingPathComponent(value.id + ".json"), malformed = source.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
        let original = try Data(contentsOf: valid), invalid = Data("{\"version\":1}".utf8)
        try invalid.write(to: malformed)
        let names = try FileManager.default.contentsOfDirectory(atPath: source.path).sorted()
        await refused { _ = try await box.exportRaw(documents: documents, run: UUID().uuidString.lowercased()) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: source.path).sorted(), names)
        XCTAssertEqual(try Data(contentsOf: valid), original)
        XCTAssertEqual(try Data(contentsOf: malformed), invalid)
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appendingPathComponent("NativeShareMailboxExports").path))
    }
    func testUncertainPublishAndImportAcknowledgmentReplayExactlyOnceIncludingTerminal() async throws {
        let box = try mailbox(), value = try envelope(), store = try intake()
        await box.setFaults(afterPublication: { throw Injected.failure })
        await refused { try await box.publish(value) }
        await box.setFaults(); try await box.publish(value)
        let page = try await box.pendingPage(), source = try XCTUnwrap(page.items.first)
        await box.setFaults(beforeAcknowledgment: { throw Injected.failure })
        await refused { _ = try await store.importShare(source, from: box) }
        let retained = try await box.pendingPage(); XCTAssertEqual(retained.items.count, 1)
        var pending = try await store.pendingPage(); XCTAssertEqual(pending.items.count, 1)
        XCTAssertEqual(pending.items[0].event?.share, value)
        await box.setFaults()
        let accepted = try await store.importShare(source, from: box)
        XCTAssertEqual(accepted.id, value.id)
        let empty = try await box.pendingPage(); XCTAssertTrue(empty.items.isEmpty)
        pending = try await store.pendingPage(); XCTAssertEqual(pending.items.count, 1)
        let admitting = try await store.markAdmitting(accepted)
        try await store.finish(admitting, outcome: .ignored)
        _ = try await store.settleFinish(admitting, outcome: .ignored)
        await store.close()
        // A later producer retry is checked against the retained terminal's original payload fingerprint.
        let cold = try intake(); try await box.publish(value)
        let replayPage = try await box.pendingPage(), replay = try XCTUnwrap(replayPage.items.first)
        let terminal = try await cold.importShare(replay, from: box)
        XCTAssertEqual(terminal.stage, .terminal); XCTAssertEqual(terminal.outcome, .ignored)
        let changed = try envelope(id: XCTUnwrap(UUID(uuidString: value.id)), text: "Foreign bytes")
        try await box.publish(changed)
        let foreignPage = try await box.pendingPage(), foreign = try XCTUnwrap(foreignPage.items.first)
        await refused { _ = try await cold.importShare(foreign, from: box) }
        let stillOwned = try await box.pendingPage(); XCTAssertEqual(stillOwned.items.count, 1)
    }
    func testWrongNamespaceAndReplacedOrSymlinkedProducerNeverAcknowledged() async throws {
        let box = try mailbox(), value = try envelope(), wrong = try intake(namespace: namespace + ".foreign")
        try await box.publish(value)
        let page = try await box.pendingPage(), source = try XCTUnwrap(page.items.first)
        await refused { _ = try await wrong.importShare(source, from: box) }
        let privatePage = try await wrong.pendingPage(); XCTAssertTrue(privatePage.items.isEmpty)
        let name = group.appendingPathComponent("NativeShare/v1/" + value.id + ".json")
        let replacement = group.appendingPathComponent("replacement")
        try value.encoded().write(to: replacement)
        XCTAssertEqual(rename(replacement.path, name.path), 0)
        await refused { try await box.acknowledge(source) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: name.path))
        try FileManager.default.removeItem(at: name)
        try FileManager.default.createSymbolicLink(at: name, withDestinationURL: group.appendingPathComponent("foreign.json"))
        await refused { _ = try await box.pendingPage() }
    }
    func testProducerPagesStayBoundedAcrossIndependentAppAndExtensionOwners() async throws {
        let producer = try mailbox(), consumer = try mailbox()
        for _ in 0..<33 { try await producer.publish(envelope()) }
        let first = try await consumer.pendingPage(); XCTAssertEqual(first.items.count, 32)
        let next = try XCTUnwrap(first.next), last = try await consumer.pendingPage(after: next)
        XCTAssertEqual(last.items.count, 1); XCTAssertNil(last.next)
        await refused { try await producer.acknowledge(first.items[0]) }
        for item in first.items + last.items { try await consumer.acknowledge(item) }
        let empty = try await consumer.pendingPage(); XCTAssertTrue(empty.items.isEmpty)
    }
    func testActualHostShareProjectionKeepsCoreFormattingAndWritesNoTask() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("MINDWTR_CORE_BUNDLE required") }
        let database = home.appendingPathComponent("core.sqlite")
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        _ = try await core.start()
        let input: [String: Any] = ["subject": " Email ", "text": " Body https://example.com/doc ", "webUrl": "https://example.com/doc"]
        let raw = String(decoding: try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]), as: UTF8.self)
        let arguments = String(decoding: try JSONSerialization.data(withJSONObject: [raw]), as: UTF8.self)
        let output = try await core.call("iosShareCaptureDraft", argumentsJSON: arguments)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any])
        let draft = try XCTUnwrap(result["draft"] as? [String: String])
        XCTAssertEqual(draft, ["title": "Email", "note": "Body https://example.com/doc"])
        let sqlite = try SQLiteBridge(url: database)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT id FROM tasks").utf8)) as? [[String: Any]])
        XCTAssertTrue(rows.isEmpty); sqlite.close()
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        await core.close()
    }
    func testNativeShareAtomicFailureColdReceiptAndLaterEditFinishOriginalIntakeOnce() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("MINDWTR_CORE_BUNDLE required") }
        let source = try envelope(), mailbox = try self.mailbox(), intake = try self.intake()
        try await mailbox.publish(source)
        let producerPage = try await mailbox.pendingPage(), original = try XCTUnwrap(producerPage.items.first)
        let imported = try await intake.importShare(original, from: mailbox)
        _ = try await intake.markAdmitting(imported)
        let database = home.appendingPathComponent("share.sqlite"), journal = database.appendingPathExtension("pending.json")
        let faults = HostIOFaults(), fired = DispatchSemaphore(value: 0), inserted = DispatchSemaphore(value: 0)
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), faults: faults)
        _ = try await core.start()
        let opened = try await core.call("captureOpen")
        let view = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(opened.utf8)) as? [String: Any])
        var options = try XCTUnwrap(view["options"] as? [String: Any]); options["note"] = "Edited note"; options["addAnother"] = false
        let request = String(decoding: try JSONSerialization.data(withJSONObject: ["text": "Edited share title", "options": options,
            "captureId": source.id, "openAfterSave": false], options: [.sortedKeys]), as: UTF8.self)
        faults.beforeSQL = { sql in
            if sql.hasPrefix("INSERT INTO native_request_receipts") { inserted.signal() }
            if sql == "COMMIT", FileManager.default.fileExists(atPath: journal.path), inserted.wait(timeout: .now()) == .success {
                fired.signal(); throw Injected.failure
            }
        }
        await refused { _ = try await core.submitShareCapture(source: source, method: "captureSubmit", requestJSON: request,
            lease: NativeTaskAIEditorLease(), readmit: { true }) }
        XCTAssertEqual(fired.wait(timeout: .now()), .success)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        let sqlite = try SQLiteBridge(url: database)
        XCTAssertEqual(try sqlite.execute("SELECT id FROM tasks"), "[]")
        XCTAssertEqual(try sqlite.execute("SELECT request_id FROM native_request_receipts"), "[]"); sqlite.close()
        faults.beforeSQL = nil
        let recovered = try await core.retryPending(); XCTAssertNotNil(recovered)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); await intake.close()
        let coldIntake = try self.intake(), cold = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        _ = try await cold.start()
        let args = String(decoding: try JSONSerialization.data(withJSONObject: [source.id]), as: UTF8.self)
        _ = try await cold.call("complete", argumentsJSON: args)
        let editedDB = try SQLiteBridge(url: database), edited = try editedDB.execute("SELECT * FROM tasks ORDER BY id")
        let proof = try await cold.probeShareCapture(source: source)
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(proof.utf8)) as? [String: Any])
        XCTAssertEqual(result["taskId"] as? String, source.id); XCTAssertEqual(result["kind"] as? String, "saved")
        XCTAssertEqual(try editedDB.execute("SELECT * FROM tasks ORDER BY id"), edited)
        let pending = try await coldIntake.pendingPage(), item = try XCTUnwrap(pending.items.first)
        XCTAssertEqual(item.stage, .admitting); XCTAssertEqual(item.event?.share, source)
        try await coldIntake.finish(item, outcome: .completed)
        _ = try await coldIntake.settleFinish(item, outcome: .completed)
        let finished = try await coldIntake.pendingPage(); XCTAssertTrue(finished.items.isEmpty)
        for name in ["shareCaptureSubmit", "iosShareCapturePrepare", "iosShareCaptureCommit", "iosShareCaptureOutcome"] {
            await refused { _ = try await cold.call(name, argumentsJSON: args) }
        }
        XCTAssertEqual(try editedDB.execute("SELECT * FROM tasks ORDER BY id"), edited)
        editedDB.close(); await cold.close()
    }
}
