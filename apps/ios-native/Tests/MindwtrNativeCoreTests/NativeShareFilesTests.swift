import XCTest
import UniformTypeIdentifiers
import Darwin
@testable import MindwtrNativeCore

final class NativeShareFilesTests: XCTestCase {
    private var group: URL!, home: URL!, scratch: URL!, namespace: String!
    private var stores: [NativePersonalIntake] = []
    private var boxes: [NativeShareMailbox] = []
    private let sha = String(repeating: "a", count: 64)

    override func setUpWithError() throws {
        let id = UUID().uuidString.lowercased(), base = FileManager.default.homeDirectoryForCurrentUser
        namespace = "mindwtr.share.fixture." + id
        group = base.appendingPathComponent(".mindwtr-native-tests/share/" + id)
        home = base.appendingPathComponent(".mindwtr-native-tests/personal-intake/" + id + "/home")
        scratch = base.appendingPathComponent(".mindwtr-native-tests/share-sources/" + id)
        for directory in [group, home, scratch] { try FileManager.default.createDirectory(at: directory!, withIntermediateDirectories: true) }
    }
    override func tearDown() async throws {
        for store in stores { await store.close() }; stores.removeAll(); boxes.removeAll()
        for directory in [group, scratch] { if let directory { try? FileManager.default.removeItem(at: directory) } }
        if let home { try? FileManager.default.removeItem(at: home.deletingLastPathComponent()) }
    }
    private func mailbox() throws -> NativeShareMailbox {
        let box = try NativeShareMailbox.fixture(root: group, namespace: namespace); boxes.append(box); return box
    }
    private func intake() throws -> NativePersonalIntake {
        let route = try NativePersonalIntakeRoute.fixture(home: home, bundleIdentifier: namespace)
        let store = try NativePersonalIntake(route: route, diagnostic: { _ in }); stores.append(store); return store
    }
    private func source(_ name: String, bytes: Data) throws -> URL {
        let url = scratch.appendingPathComponent(name); try bytes.write(to: url); return url
    }
    private func filesDirectory() -> URL { group.appendingPathComponent("NativeShare/files", isDirectory: true) }
    private func entries(_ url: URL) -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted() }
    private func staged(_ box: NativeShareMailbox, id: UUID, files: [(String, Data, String)]) throws -> [NativeShareEnvelope.File] {
        let writer = try box.payloadWriter(for: id)
        return try files.map { name, bytes, mime in
            let copied = try writer.copy(from: source(name, bytes: bytes))
            return try NativeShareEnvelope.File(id: copied.id, name: name, mimeType: mime, size: copied.size, sha256: copied.sha256)
        }
    }

    func testTextEnvelopeBytesStayVersionOneAndFileEnvelopesAreBounded() throws {
        let legacy = Data(#"{"id":"0b9f7c8e-3c2a-4a55-9b1e-2f4d6c8a0e11","receivedAtMs":100000,"subject":"Subject","text":"Shared text","version":1,"webUrl":"https://example.com/doc"}"#.utf8)
        let decoded = try NativeShareEnvelope.decode(legacy)
        XCTAssertNil(decoded.files); XCTAssertNil(decoded.skippedFiles)
        XCTAssertEqual(try decoded.encoded(), legacy)
        let text = try NativeShareEnvelope(subject: nil, text: "Only text", webUrl: nil)
        XCTAssertEqual(text.version, 1)
        XCTAssertFalse(String(decoding: try text.encoded(), as: UTF8.self).contains("files"))

        let file = try NativeShareEnvelope.File(name: "Scan.pdf", mimeType: "application/pdf", size: 12, sha256: sha)
        let photoOnly = try NativeShareEnvelope(subject: nil, text: nil, webUrl: nil, files: [file])
        XCTAssertEqual(photoOnly.version, 2); XCTAssertEqual(photoOnly.skippedFiles, 0)
        XCTAssertEqual(try NativeShareEnvelope.decode(photoOnly.encoded()), photoOnly)
        let event = try NativePersonalIntakeEvent.shared(photoOnly)
        XCTAssertEqual(try IntakeWire.decode(NativePersonalIntakeEvent.self, IntakeWire.encode(event, limit: IntakeWire.recordLimit), limit: IntakeWire.recordLimit), event)

        XCTAssertThrowsError(try NativeShareEnvelope(subject: nil, text: nil, webUrl: nil, files: [], skippedFiles: 2),
                             "Skipped files alone make no capture")
        let many = try (0..<7).map { _ in try NativeShareEnvelope.File(name: "a.png", mimeType: "image/png", size: 1, sha256: sha) }
        XCTAssertThrowsError(try NativeShareEnvelope(subject: nil, text: "t", webUrl: nil, files: many))
        XCTAssertThrowsError(try NativeShareEnvelope(subject: nil, text: "t", webUrl: nil, files: [file, file]))
        for (name, mime, size, digest) in [("", "image/png", Int64(1), sha), ("a/b.png", "image/png", 1, sha), ("a.png", "", 1, sha),
            ("a.png", "image/png", NativeShareEnvelope.File.maximumBytes + 1, sha), ("a.png", "image/png", 1, String(repeating: "A", count: 64))] {
            XCTAssertThrowsError(try NativeShareEnvelope.File(name: name, mimeType: mime, size: size, sha256: digest))
        }
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: legacy) as? [String: Any]); object["files"] = [Any]()
        XCTAssertThrowsError(try NativeShareEnvelope.decode(JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])),
                             "A version 1 envelope never carries a file list")
    }

    func testStagedFilesStreamWithDigestAndPublishPromotesThemBeforeTheEnvelope() async throws {
        let box = try mailbox(), id = UUID(), photo = Data(repeating: 7, count: 200_000), pdf = Data("%PDF-1.4 synthetic".utf8)
        let files = try staged(box, id: id, files: [("IMG_0001.heic", photo, "image/heic"), ("Scan.pdf", pdf, "application/pdf")])
        XCTAssertEqual(files.map(\.size), [Int64(photo.count), Int64(pdf.count)])
        XCTAssertEqual(entries(filesDirectory()), [".staging-" + id.uuidString.lowercased()])
        var page = try await box.pendingPage(); XCTAssertTrue(page.items.isEmpty, "Staged files without an envelope are no mailbox entry")

        let envelope = try NativeShareEnvelope(id: id, subject: nil, text: nil, webUrl: nil, files: files)
        try await box.publish(envelope); try await box.publish(envelope)
        XCTAssertEqual(entries(filesDirectory()), [envelope.id])
        page = try await box.pendingPage(); XCTAssertEqual(page.items.map(\.envelope), [envelope])
        XCTAssertEqual(try Data(contentsOf: box.payloadURL(envelope, file: files[0])), photo)
        XCTAssertEqual(try Data(contentsOf: box.payloadURL(envelope, file: files[1])), pdf)
    }

    func testPublishRefusesMissingOrChangedPayloadAndWritesNoEnvelope() async throws {
        let box = try mailbox(), id = UUID()
        let files = try staged(box, id: id, files: [("a.txt", Data("abc".utf8), "text/plain")])
        let wrongSize = try NativeShareEnvelope.File(id: XCTUnwrap(UUID(uuidString: files[0].id)), name: "a.txt", mimeType: "text/plain", size: 4, sha256: files[0].sha256)
        do { try await box.publish(NativeShareEnvelope(id: id, subject: nil, text: nil, webUrl: nil, files: [wrongSize])); XCTFail("Changed payload must refuse") } catch {}
        let missing = try NativeShareEnvelope.File(name: "b.txt", mimeType: "text/plain", size: 3, sha256: files[0].sha256)
        do { try await box.publish(NativeShareEnvelope(id: id, subject: nil, text: nil, webUrl: nil, files: [files[0], missing])); XCTFail("Missing payload must refuse") } catch {}
        let page = try await box.pendingPage(); XCTAssertTrue(page.items.isEmpty)
        do { try await box.publish(NativeShareEnvelope(subject: nil, text: nil, webUrl: nil, files: files)); XCTFail("No payload staged for this id") } catch {}
    }

    func testWriterRefusesOversizeAndLeavesNoPartialFile() throws {
        let box = try mailbox(), id = UUID(), writer = try box.payloadWriter(for: id)
        let big = try source("big.mov", bytes: Data(repeating: 1, count: 300_000))
        XCTAssertThrowsError(try writer.copy(from: big, limit: 100_000))
        XCTAssertThrowsError(try writer.copy(from: big, checkCancellation: { throw CancellationError() }))
        XCTAssertEqual(entries(filesDirectory().appendingPathComponent(".staging-" + id.uuidString.lowercased())), [])
    }

    func testCancelledShareDiscardsOnlyUnpublishedPayloads() async throws {
        let box = try mailbox(), cancelled = UUID(), kept = UUID()
        _ = try staged(box, id: cancelled, files: [("a.png", Data([1]), "image/png")])
        try await box.removePayload(cancelled.uuidString.lowercased(), unlessPublished: true)
        XCTAssertEqual(entries(filesDirectory()), [])
        let files = try staged(box, id: kept, files: [("b.png", Data([2]), "image/png")])
        let envelope = try NativeShareEnvelope(id: kept, subject: nil, text: nil, webUrl: nil, files: files)
        try await box.publish(envelope)
        try await box.removePayload(envelope.id, unlessPublished: true)
        XCTAssertEqual(entries(filesDirectory()), [envelope.id])
        try await box.removePayload(envelope.id)
        XCTAssertEqual(entries(filesDirectory()), [])
    }

    func testSweepRemovesOrphansButKeepsPendingRetainedAndFreshStaging() async throws {
        let box = try mailbox(), pending = UUID(), retained = UUID(), orphan = UUID(), fresh = UUID(), stale = UUID()
        for id in [pending, retained, orphan] {
            let files = try staged(box, id: id, files: [("a.png", Data([1]), "image/png")])
            try await box.publish(NativeShareEnvelope(id: id, subject: nil, text: nil, webUrl: nil, files: files))
        }
        for item in try await box.pendingPage().items where item.envelope.id != pending.uuidString.lowercased() { try await box.acknowledge(item) }
        _ = try staged(box, id: fresh, files: [("a.png", Data([1]), "image/png")])
        _ = try staged(box, id: stale, files: [("a.png", Data([1]), "image/png")])
        let stalePath = filesDirectory().appendingPathComponent(".staging-" + stale.uuidString.lowercased()).path
        var times = [timespec(tv_sec: 1000, tv_nsec: 0), timespec(tv_sec: 1000, tv_nsec: 0)]
        XCTAssertEqual(utimensat(AT_FDCWD, stalePath, &times, AT_SYMLINK_NOFOLLOW), 0)
        let removed = try await box.sweepPayloads(keeping: [retained.uuidString.lowercased()])
        XCTAssertEqual(removed, 2)
        let expected = [pending, retained].map { $0.uuidString.lowercased() } + [".staging-" + fresh.uuidString.lowercased()]
        XCTAssertEqual(entries(filesDirectory()), expected.sorted())
    }

    func testFileShareImportsIntoIntakeAndKeepsPayloadAfterMailboxAcknowledgment() async throws {
        let box = try mailbox(), store = try intake(), id = UUID()
        let files = try staged(box, id: id, files: [("IMG_0002.jpg", Data(repeating: 3, count: 1000), "image/jpeg")])
        let envelope = try NativeShareEnvelope(id: id, subject: "Trip", text: nil, webUrl: nil, files: files, skippedFiles: 1)
        try await box.publish(envelope)
        let pending = try await box.pendingPage(), item = try XCTUnwrap(pending.items.first)
        let imported = try await store.importShare(item, from: box)
        XCTAssertEqual(imported.event?.share, envelope)
        let page = try await box.pendingPage(); XCTAssertTrue(page.items.isEmpty)
        XCTAssertEqual(try Data(contentsOf: box.payloadURL(envelope, file: files[0])).count, 1000,
                       "The payload outlives the mailbox entry until the capture finishes")
    }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    func testManagedFileNameMatchesCoreRule() throws {
        let id = UUID(), lower = id.uuidString.lowercased()
        for (name, expected) in [("IMG_0001.HEIC", ".heic"), ("Scan.pdf", ".pdf"), ("archive.tar.gz", ".gz"), ("noext", ""), ("a.toolongext9", ""),
                                 ("a.p-f", ""), ("a.pdf?x=1", ".pdf"), ("a.png#top", ".png"), ("dir\\b.TXT", ".txt"), ("a.ünï", ""), (".hidden", ".hidden")] {
            XCTAssertEqual(try NativeShareEnvelope.File(id: id, name: name, mimeType: "a/b", size: 1, sha256: sha).managedFileName, lower + expected, name)
        }
    }

    func testActualHostCopiesSharedFilesIntoManagedStorageAndSavesThemOnTheTaskOnce() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("MINDWTR_CORE_BUNDLE required") }
        let box = try mailbox(), id = UUID(), photo = Data(repeating: 9, count: 300_000), pdf = Data("%PDF-1.4 synthetic".utf8)
        let files = try staged(box, id: id, files: [("IMG_0001.HEIC", photo, "image/heic"), ("Scan.pdf", pdf, "application/pdf")])
        let envelope = try NativeShareEnvelope(id: id, receivedAt: Date(timeIntervalSince1970: 1_800_000_000), subject: nil, text: nil, webUrl: nil, files: files)
        try await box.publish(envelope)
        let database = home.appendingPathComponent("share-files.sqlite")
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path))
        _ = try await core.start()
        let uris = try await core.materializeShareFiles(envelope) { box.payloadURL(envelope, file: $0) }
        XCTAssertEqual(uris.count, 2)
        let targets = try uris.map { try XCTUnwrap(URL(string: XCTUnwrap($0))) }
        XCTAssertEqual(try Data(contentsOf: targets[0]), photo); XCTAssertEqual(try Data(contentsOf: targets[1]), pdf)
        XCTAssertTrue(targets[0].lastPathComponent == files[0].id + ".heic" && targets[1].lastPathComponent == files[1].id + ".pdf")
        let again = try await core.materializeShareFiles(envelope) { box.payloadURL(envelope, file: $0) }
        XCTAssertEqual(again, uris, "A relaunch copies the same files to the same names once")

        let shared: [String: Any] = ["subject": NSNull(), "text": NSNull(), "webUrl": NSNull(), "skippedFiles": 0, "receivedAt": "2027-01-15T08:00:00.000Z",
            "files": zip(files, uris).map { file, uri in ["id": file.id, "name": file.name, "mimeType": file.mimeType, "size": file.size, "sha256": file.sha256, "uri": uri!] }]
        let output = try await core.call("iosShareCaptureDraft", argumentsJSON: json([json(shared)]))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any])
        XCTAssertEqual(result["draft"] as? [String: String], ["title": "IMG_0001", "note": ""])
        XCTAssertEqual(result["skipped"] as? Int, 0)
        let attachments = try XCTUnwrap(result["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.map { $0["uri"] as? String }, uris)

        let opened = try await core.call("captureOpen")
        let view = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(opened.utf8)) as? [String: Any])
        var options = try XCTUnwrap(view["options"] as? [String: Any]); options["addAnother"] = false
        let request = try json(["text": "IMG_0001", "options": options, "captureId": envelope.id, "openAfterSave": false])
        let foreign = try json([attachments[0].merging(["fileHash": String(repeating: "b", count: 64)]) { $1 }])
        do { _ = try await core.submitShareCapture(source: envelope, method: "captureSubmit", requestJSON: request, attachmentsJSON: foreign,
            lease: NativeTaskAIEditorLease(), readmit: { true }); XCTFail("Attachments must match the shared files") } catch {}
        let saved = try await core.submitShareCapture(source: envelope, method: "captureSubmit", requestJSON: request,
            attachmentsJSON: json(attachments), lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual((try JSONSerialization.jsonObject(with: Data(saved.utf8)) as? [String: Any])?["taskId"] as? String, envelope.id)
        let replay = try await core.submitShareCapture(source: envelope, method: "captureSubmit", requestJSON: request,
            attachmentsJSON: json(attachments), lease: NativeTaskAIEditorLease(), readmit: { true })
        XCTAssertEqual((try JSONSerialization.jsonObject(with: Data(replay.utf8)) as? [String: Any])?["taskId"] as? String, envelope.id)
        let sqlite = try SQLiteBridge(url: database)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT id, attachments FROM tasks").utf8)) as? [[String: Any]])
        sqlite.close()
        XCTAssertEqual(rows.count, 1)
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(rows[0]["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(stored.map { $0["id"] as? String }, files.map(\.id))
        XCTAssertEqual(stored.map { $0["kind"] as? String }, ["file", "file"])

        try await core.discardShareFiles([try XCTUnwrap(uris[1])])
        XCTAssertFalse(FileManager.default.fileExists(atPath: targets[1].path))
        try Data("changed".utf8).write(to: targets[1])
        let changed = try await core.materializeShareFiles(envelope) { box.payloadURL(envelope, file: $0) }
        XCTAssertEqual(changed[0], uris[0]); XCTAssertNil(changed[1], "A different file at the managed name is never overwritten")
        XCTAssertEqual(try Data(contentsOf: targets[1]), Data("changed".utf8))
        await core.close()
    }

    func testPublishDropsAStagedFileTheEnvelopeDoesNotList() async throws {
        let box = try mailbox(), id = UUID()
        let files = try staged(box, id: id, files: [("kept.png", Data([1, 2]), "image/png"), ("orphan.png", Data([3]), "image/png")])
        let envelope = try NativeShareEnvelope(id: id, subject: nil, text: nil, webUrl: nil, files: [files[0]], skippedFiles: 1)
        try await box.publish(envelope)
        XCTAssertEqual(entries(filesDirectory().appendingPathComponent(envelope.id)), [files[0].id])
        let page = try await box.pendingPage(); XCTAssertEqual(page.items.map(\.envelope), [envelope])
    }

    func testFailedShareCommitRecoversFromItsJournalWithTheAttachmentsOnce() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("MINDWTR_CORE_BUNDLE required") }
        let box = try mailbox(), id = UUID()
        let files = try staged(box, id: id, files: [("Scan.pdf", Data("%PDF-1.4 synthetic".utf8), "application/pdf")])
        let envelope = try NativeShareEnvelope(id: id, receivedAt: Date(timeIntervalSince1970: 1_800_000_000), subject: "Invoice", text: nil, webUrl: nil, files: files)
        try await box.publish(envelope)
        let database = home.appendingPathComponent("share-journal.sqlite"), journal = database.appendingPathExtension("pending.json")
        let faults = HostIOFaults(), fired = DispatchSemaphore(value: 0), inserted = DispatchSemaphore(value: 0)
        let core = CoreHost(databaseURL: database, bundleURL: URL(fileURLWithPath: path), faults: faults)
        _ = try await core.start()
        let uris = try await core.materializeShareFiles(envelope) { box.payloadURL(envelope, file: $0) }
        let shared: [String: Any] = ["subject": "Invoice", "text": NSNull(), "webUrl": NSNull(), "skippedFiles": 0, "receivedAt": "2027-01-15T08:00:00.000Z",
            "files": [["id": files[0].id, "name": files[0].name, "mimeType": files[0].mimeType, "size": files[0].size, "sha256": files[0].sha256, "uri": try XCTUnwrap(uris[0])]]]
        let draftJSON = try await core.call("iosShareCaptureDraft", argumentsJSON: json([json(shared)]))
        let draft = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(draftJSON.utf8)) as? [String: Any])
        let attachments = try XCTUnwrap(draft["attachments"] as? [[String: Any]])
        let openedJSON = try await core.call("captureOpen")
        let opened = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(openedJSON.utf8)) as? [String: Any])
        var options = try XCTUnwrap(opened["options"] as? [String: Any]); options["addAnother"] = false
        let request = try json(["text": "Invoice", "options": options, "captureId": envelope.id, "openAfterSave": false])
        faults.beforeSQL = { sql in
            if sql.hasPrefix("INSERT INTO native_request_receipts") { inserted.signal() }
            if sql == "COMMIT", FileManager.default.fileExists(atPath: journal.path), inserted.wait(timeout: .now()) == .success {
                fired.signal(); throw NSError(domain: "injected", code: 1)
            }
        }
        do { _ = try await core.submitShareCapture(source: envelope, method: "captureSubmit", requestJSON: request, attachmentsJSON: json(attachments),
            lease: NativeTaskAIEditorLease(), readmit: { true }); XCTFail("COMMIT failure must refuse") } catch {}
        XCTAssertEqual(fired.wait(timeout: .now()), .success)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        faults.beforeSQL = nil
        let recovered = try await core.retryPending(); XCTAssertNotNil(recovered)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let sqlite = try SQLiteBridge(url: database)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT id, attachments FROM tasks").utf8)) as? [[String: Any]])
        let receipts = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sqlite.execute("SELECT request_id FROM native_request_receipts").utf8)) as? [[String: Any]])
        sqlite.close()
        XCTAssertEqual(rows.count, 1); XCTAssertEqual(receipts.count, 1)
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(rows[0]["attachments"] as? String).utf8)) as? [[String: Any]])
        XCTAssertEqual(stored.map { $0["id"] as? String }, [files[0].id])
        XCTAssertEqual(stored.first?["uri"] as? String, uris[0])
        await core.close()
    }

    func testSharedItemTypeChoiceAndNameFollowRNsOrder() throws {
        XCTAssertEqual(NativeSharedFileRule.fileType(["public.heic", "public.file-url"])?.identifier, "public.heic")
        XCTAssertEqual(NativeSharedFileRule.fileType(["com.apple.quicktime-movie"])?.identifier, "com.apple.quicktime-movie")
        XCTAssertEqual(NativeSharedFileRule.fileType(["public.url", "public.file-url"])?.identifier, "public.file-url",
                       "A file URL is a file, never a web link")
        XCTAssertEqual(NativeSharedFileRule.fileType(["public.url", "com.adobe.pdf"])?.identifier, "com.adobe.pdf")
        XCTAssertNil(NativeSharedFileRule.fileType(["public.url"]))
        XCTAssertNil(NativeSharedFileRule.fileType(["public.plain-text"]))
        XCTAssertEqual(NativeSharedFileRule.fileType(["org.openxmlformats.wordprocessingml.document"])?.identifier,
                       "org.openxmlformats.wordprocessingml.document")
        let heic = try XCTUnwrap(UTType("public.heic")), fileURL = UTType.fileURL
        let photo = NativeSharedFileRule.name(original: URL(fileURLWithPath: "/tmp/x/7F3A.heic"), suggested: "IMG_0001", type: heic)
        XCTAssertEqual(photo.name, "IMG_0001.heic"); XCTAssertEqual(photo.mimeType, "image/heic")
        let file = NativeSharedFileRule.name(original: URL(fileURLWithPath: "/tmp/x/Scan.pdf"), suggested: "Other", type: fileURL)
        XCTAssertEqual(file.name, "Scan.pdf"); XCTAssertEqual(file.mimeType, "application/pdf")
        let odd = NativeSharedFileRule.name(original: URL(fileURLWithPath: "/tmp/x/a.zzq"), suggested: "a/b\u{7}c", type: try XCTUnwrap(UTType("public.data")))
        XCTAssertEqual(odd.name, "a-bc.zzq"); XCTAssertEqual(odd.mimeType, "application/octet-stream")
        XCTAssertNoThrow(try NativeShareEnvelope.File(name: odd.name, mimeType: odd.mimeType, size: 1, sha256: sha))
    }
}

