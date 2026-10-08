import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class AttachmentOpenHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var fixtureBase: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private let taskID = "file-open-task"
    private let projectID = "file-open-project"
    private let at = "2026-10-06T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task277-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true); fixtureBase = root
    }
    override func tearDownWithError() throws { if let fixtureBase { try FileManager.default.removeItem(at: fixtureBase) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func rows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture identity unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func seed(_ attachments: [[String: Any]] = [], deleted: Bool = false, archived: Bool = false) async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        if archived { _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,createdAt,updatedAt,rev) VALUES ('archived','Archived','archived','#94a3b8','',?,?,1)", [at, at]) }
        let storedAttachments: Any = attachments.isEmpty ? NSNull() : try json(attachments)
        _ = try sql("INSERT INTO tasks(id,title,status,taskMode,projectId,contexts,tags,attachments,checklist,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,'Preserved title','next','list',?,'[]','[]',?,NULL,?,?,?,1,'fixture')",
            [taskID, archived ? "archived" : NSNull(), storedAttachments, at, at, deleted ? at : NSNull()])
    }
    private func item(_ id: String, uri: String, mime: String = "text/plain") -> [String: Any] {
        ["id": id, "kind": "file", "title": "Private.txt", "uri": uri, "mimeType": mime,
         "size": 5, "createdAt": at, "updatedAt": at, "localStatus": "available"]
    }
    private func request(_ rows: [[String: Any]], id: String, task: String? = nil) throws -> String {
        try json(["owner": ["kind": "task", "taskId": task ?? taskID, "attachments": rows], "attachmentId": id])
    }
    private func opened(_ host: CoreHost, _ rows: [[String: Any]], id: String) async throws -> [String: Any] {
        try object(await host.prepareTaskFileOpen(requestJSON: request(rows, id: id)))
    }
    private func seedProject(_ attachments: [[String: Any]], status: String = "active") throws {
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Preserved Project',?,'#94a3b8','Preserved notes',?,?,?,1,'fixture')",
            [projectID, status, try json(attachments), at, at])
    }
    private func projectRows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects ORDER BY id").utf8))) }
    private func projectOpened(_ host: CoreHost, id: String) async throws -> [String: Any] {
        try object(await host.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": id])))
    }
    private func projectMarkers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-project-local-file-open").count - 1
    }
    private func markers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-local-file-open").count - 1
    }
    private func refused(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected safe refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line); XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line) }
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(EditorDraftStore(databaseURL: database).read()?.snapshot) }
    private func produce(_ host: CoreHost) async throws -> [[String: Any]] {
        let opening = try object(await host.call("editorModel", argumentsJSON: json([taskID])))
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "",
            "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "",
            "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: snapshot.generation)
        for (name, mime, bytes) in [("Private.txt", "text/plain", Data("plain".utf8)),
            ("Private.png", "image/png", Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=")!),
            ("Private.wav", "audio/wav", Data(base64Encoded: "UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAAAA")!)] {
            let source = cache.appendingPathComponent(name); try bytes.write(to: source)
            let before = try latest()
            _ = try await host.addAttachmentDraftV3(requestJSON: json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID, "generation": before.generation,
                "picked": ["uri": source.absoluteString, "name": name, "mimeType": mime, "size": NSNull()]] as [String: Any]))
        }
        let before = try latest(), value = try object(before.payloadJSON)
        let rows = try XCTUnwrap(value["attachments"] as? [[String: Any]])
        let save: [String: Any] = ["id": taskID, "requestId": UUID().uuidString.lowercased(), "base": [:], "patch": [:], "scheduleBase": try XCTUnwrap(opening["scheduleBase"]),
            "checklist": ["base": [], "value": []], "attachments": ["base": [], "value": rows]]
        _ = try await host.saveAttachmentDraftComplete(saveRequestJSON: json(save), expectedSession: before.sessionID, expectedGeneration: before.generation)
        return rows
    }

    func testActualAddCompleteSaveAndColdFileImageAudioPlansPreserveBytesAndRows() async throws {
        try await checkActualAddCompleteSaveAndColdOpen(legacyEmptyArrays: false)
    }

    func testLegacyEmptyArraysSupportActualAddCompleteSaveAndColdOpen() async throws {
        try await checkActualAddCompleteSaveAndColdOpen(legacyEmptyArrays: true)
    }

    private func checkActualAddCompleteSaveAndColdOpen(legacyEmptyArrays: Bool) async throws {
        try await seed()
        if legacyEmptyArrays {
            _ = try sql("UPDATE tasks SET attachments='[]',checklist='[]' WHERE id=?", [taskID])
        }
        let host = core(); _ = try await host.start()
        let attachments = try await produce(host)
        let files = try attachments.map { try XCTUnwrap(URL(string: XCTUnwrap($0["uri"] as? String))) }
        let contents = try files.map { try Data(contentsOf: $0) }, identities = try files.map(inode)
        await host.close(); let cold = core(); _ = try await cold.start()
        let before = try rows(), count = try markers()
        for (index, kind) in ["file", "image", "audio"].enumerated() {
            let result = try await opened(cold, attachments, id: XCTUnwrap(attachments[index]["id"] as? String))
            XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
            let plan = try XCTUnwrap(result["open"] as? [String: Any]); XCTAssertEqual(plan["kind"] as? String, kind)
            XCTAssertEqual(kind == "file" ? plan["uri"] as? String : (plan["attachment"] as? [String: Any])?["uri"] as? String, files[index].absoluteString)
        }
        XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, contents); XCTAssertEqual(try files.map(inode), identities)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers() - count, 3)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed())
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertTrue(log.contains("v1.3.5/ios-owned-raw-row-save"))
        XCTAssertFalse(log.contains("Private.txt")); XCTAssertFalse(log.contains(files[0].absoluteString))
    }

    func testMissingManagedFileReturnsExistingUnavailableWithoutWrites() async throws {
        let missing = item("missing", uri: managed.appendingPathComponent("missing.txt").absoluteString)
        try await seed([missing]); let host = core(); _ = try await host.start()
        let before = try rows(), names = try FileManager.default.contentsOfDirectory(atPath: managed.path), count = try markers()
        let result = try await opened(host, [missing], id: "missing")
        XCTAssertEqual(result["status"] as? String, "unavailable"); XCTAssertNotNil(result["message"] as? String)
        XCTAssertTrue(result["open"] is NSNull); XCTAssertTrue(result["update"] is NSNull)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), names)
        XCTAssertEqual(try markers(), count)
    }

    func testUnknownDeletedLinkMalformedAndMissingTaskSelectionsPreserveEvidence() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("live bytes".utf8)
        let live = item("live", uri: file.absoluteString)
        try await seed([live]); try bytes.write(to: file)
        let host = core(); _ = try await host.start()
        let before = try rows(), identity = try inode(file), count = try markers()
        var removed = live; removed["deletedAt"] = at
        let link: [String: Any] = ["id": "link", "kind": "link", "title": "Private link", "uri": "https://example.invalid", "createdAt": at, "updatedAt": at]
        let inputs = try [request([live], id: "unknown"), request([removed], id: "live"), request([link], id: "link"),
            request([live], id: "live", task: "missing-task"),
            json(["owner": ["kind": "project", "projectId": "missing", "attachments": [live]], "attachmentId": "live"]),
            json(["owner": ["kind": "task", "taskId": taskID, "attachments": [live]], "attachmentId": "live", "extra": true])]
        for input in inputs { await refused { _ = try await host.prepareTaskFileOpen(requestJSON: input) } }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try markers(), count)
        await host.close()
        _ = try sql("UPDATE tasks SET deletedAt=? WHERE id=?", [at, taskID])
        let cold = core(); _ = try await cold.start(); let deletedRows = try rows()
        await refused { _ = try await self.opened(cold, [live], id: "live") }
        XCTAssertEqual(try rows(), deletedRows); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try markers(), count)
    }

    func testForeignCacheRemoteAlternateSpellingAndWrongIDCannotCopy() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), outside = root.appendingPathComponent("outside.txt"), cached = cache.appendingPathComponent("cached.txt")
        let bytes = Data("untouched bytes".utf8)
        for url in [file, outside, cached] { try bytes.write(to: url) }
        let alternative = "file:" + file.path
        XCTAssertEqual(try XCTUnwrap(URL(string: alternative)).path, file.path, "Alternate spelling still names the same actual file")
        let prefixRefusals = [item("outside", uri: outside.absoluteString), item("cached", uri: cached.absoluteString),
            item("remote", uri: "https://example.invalid/Private.txt"), item("live", uri: alternative),
            item("live", uri: "file:///var/mobile/Containers/Data/Application/00000000-0000-0000-0000-000000000000/Library/attachments/live.txt"),
            item("live", uri: "file:///private/var/mobile/Containers/Data/Application/00000000-0000-0000-0000-000000000000/Library/attachments/live.txt")]
        let host = core(), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identities = try [file, outside, cached].map(inode), names = try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), cachedNames = try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted()
        for attachment in prefixRefusals {
            let count = work
            await refused { _ = try await self.opened(host, [attachment], id: XCTUnwrap(attachment["id"] as? String)) }
            XCTAssertEqual(work, count, "Noncanonical or external spelling must stop before file jobs")
        }
        let wrongID = item("different-id", uri: file.absoluteString)
        await refused { _ = try await self.opened(host, [wrongID], id: "different-id") }
        XCTAssertGreaterThan(work, 0, "Managed ID mismatch reaches the existing typed read-only proof")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try [file, outside, cached].map(inode), identities)
        XCTAssertEqual(try [file, outside, cached].map { try Data(contentsOf: $0) }, [bytes, bytes, bytes])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), names)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted(), cachedNames); XCTAssertEqual(try markers(), 0)
    }

    func testDirectorySymlinkAndHardlinkTargetsCannotProduceOpenPlans() async throws {
        try await seed()
        let directory = managed.appendingPathComponent("directory.txt"), symlink = managed.appendingPathComponent("symlink.txt"), hardlink = managed.appendingPathComponent("hardlink.txt"), source = root.appendingPathComponent("source.txt")
        let bytes = Data("retained source".utf8); try bytes.write(to: source)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
        try FileManager.default.linkItem(at: source, to: hardlink)
        let paths = [directory, symlink, hardlink, source], identities = try paths.map(inode)
        let host = core(); _ = try await host.start(); let before = try rows()
        for (id, target) in [("directory", directory), ("symlink", symlink), ("hardlink", hardlink)] {
            await refused { _ = try await self.opened(host, [self.item(id, uri: target.absoluteString)], id: id) }
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try paths.map(inode), identities)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try Data(contentsOf: hardlink), bytes)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: symlink.path), source.path)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty); XCTAssertEqual(try markers(), 0)
    }

    func testArchivedReadOnlyTaskCanOpenExistingLocalFile() async throws {
        let file = managed.appendingPathComponent("archived-file.txt"), attachment = item("archived-file", uri: file.absoluteString), bytes = Data("read only bytes".utf8)
        try await seed([attachment], archived: true); try bytes.write(to: file)
        let host = core(); _ = try await host.start(); let before = try rows(), identity = try inode(file)
        let view = try object(await host.call("taskView", argumentsJSON: json([json(["id": taskID])])))
        XCTAssertEqual(view["readOnly"] as? Bool, true)
        let result = try await opened(host, [attachment], id: "archived-file")
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try markers(), 1)
    }

    // A private bundle extension drives real asynchronous JSC tickets. It adds
    // no production evaluator or command and leaves taskView/SQLite unchanged.
    private func probeBundle(_ answers: [[String: Any]], method: String = "attachmentRequest") throws -> URL {
        let suffix = """
        ;(() => {
          const oldPoll = MindwtrHost.poll, replies = new Map(), answers = \(try json(answers));
          let next = 1000000000, call = 0;
          MindwtrHost[\(try json([method]))[0]] = () => {
            const id = String(++next), value = answers[call++];
            Promise.resolve().then(() => replies.set(id, JSON.stringify({ok:true,value})));
            return id;
          };
          MindwtrHost.poll = id => {
            if (Number(id) > 1000000000) { const value = replies.get(id); if (!value) return null; replies.delete(id); return value; }
            return oldPoll(id);
          };
        })();
        """
        let result = root.appendingPathComponent("probe.js")
        try (String(contentsOf: bundle) + suffix).write(to: result, atomically: true, encoding: .utf8)
        return result
    }

    func testUpdatedForeignMalformedAndMismatchedSharedAnswersAreRefused() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("original bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let plan: [String: Any] = ["kind": "file", "uri": file.absoluteString, "mimeType": "text/plain", "viewMimeType": "text/plain"]
        func answer(_ open: Any, status: String = "available", update: Any = NSNull()) -> [String: Any] {
            ["status": status, "message": NSNull(), "update": update, "open": open]
        }
        var remote = plan; remote["uri"] = "https://example.invalid/Private.txt"
        var alternate = plan; alternate["uri"] = "file:" + file.path
        var wrong = attachment; wrong["id"] = "wrong"
        var changed = attachment; changed["size"] = 999
        var extra = plan; extra["extra"] = true
        let answers = [answer(plan, update: ["attachments": [attachment]]), answer(NSNull(), status: "unavailable", update: ["attachments": [attachment]]),
            answer(remote), answer(alternate), answer(["kind": "link", "uri": file.absoluteString]),
            answer(["kind": "image", "attachment": wrong]), answer(["kind": "audio", "attachment": changed]), answer(extra)]
        let host = core(bundleURL: try probeBundle(answers + [answer(plan)])); _ = try await host.start()
        let before = try rows(), identity = try inode(file)
        for _ in answers { await refused { _ = try await self.opened(host, [attachment], id: "live") } }
        // The same valid request must consume the final successful ticket,
        // proving earlier refusals actually reached each forged shared answer.
        let accepted = try await opened(host, [attachment], id: "live")
        XCTAssertEqual(accepted["status"] as? String, "available")
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try markers(), 1)
    }

    func testChangedFileProofAfterPreflightCannotReturnStalePlan() async throws {
        let file = managed.appendingPathComponent("live.txt"), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try Data("before".utf8).write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(); var fired = false, mutationError: Error?
        hooks.configureJobs = { jobs in jobs.afterWork = { id, _ in
            if id == "1" { fired = true; do { try Data("after changed".utf8).write(to: file, options: .atomic) } catch { mutationError = error } }
        } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identity = try inode(file)
        await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertTrue(fired); XCTAssertNil(mutationError); XCTAssertNotEqual(try inode(file), identity)
        XCTAssertEqual(try Data(contentsOf: file), Data("after changed".utf8)); XCTAssertEqual(try rows(), before); XCTAssertEqual(try markers(), 0)
    }

    func testCancellationDrainsTypedReadBeforeCloseAndReleasesLibraryOnlyAfterward() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("cancel bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let before = try rows(), identity = try inode(file), input = try request([attachment], id: "live")
        let operation = Task { try await host.prepareTaskFileOpen(requestJSON: input) }
        defer { release.signal() }
        let enteredResult = entered.wait(timeout: .now() + 5); XCTAssertEqual(enteredResult, .success)
        guard enteredResult == .success else { operation.cancel(); release.signal(); _ = try? await operation.value; return }
        operation.cancel()
        let closed = DispatchSemaphore(value: 0), closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let replacement = core(); await refused { _ = try await replacement.start() }
        release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled opening must not produce a plan") }
        catch is CancellationError { } catch { XCTFail("Expected cancellation") }
        await closeTask.value
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markers(), 0)
        _ = try await replacement.start()
        let result = try await opened(replacement, [attachment], id: "live")
        XCTAssertEqual(result["status"] as? String, "available"); XCTAssertEqual(try markers(), 1)
    }

    func testClosedAndPendingDomainHostsRefuseWithoutChangingRetainedEvidence() async throws {
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("pending bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let capture = try object(await host.call("captureOpen"))
        let command = try json([json(["text": "Pending capture", "options": try XCTUnwrap(capture["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending COMMIT") } }
        await refused { _ = try await host.call("captureSubmit", argumentsJSON: command) }
        let journal = database.appendingPathExtension("pending.json"), retained = try Data(contentsOf: journal), before = try rows(), identity = try inode(file)
        await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), before)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try markers(), 0)
        await host.close(); await refused { _ = try await self.opened(host, [attachment], id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testProjectColdActualManagedFileImageAndAudioPlansDoNotRepairMetadata() async throws {
        try await seed(); let producer = core(); _ = try await producer.start()
        let attachments = try await produce(producer)
        let files = try attachments.map { try XCTUnwrap(URL(string: XCTUnwrap($0["uri"] as? String))) }
        let bytes = try files.map { try Data(contentsOf: $0) }, identities = try files.map(inode)
        await producer.close()
        let stale = attachments.map { row -> [String: Any] in
            var value = row; value.removeValue(forKey: "size"); value["localStatus"] = "missing"; return value
        }
        try seedProject(stale)
        let cold = core(); _ = try await cold.start(); let tasks = try rows(), projects = try projectRows(), count = try projectMarkers()
        for (index, kind) in ["file", "image", "file"].enumerated() {
            let result = try await projectOpened(cold, id: XCTUnwrap(stale[index]["id"] as? String))
            XCTAssertEqual(result["status"] as? String, "available"); XCTAssertTrue(result["update"] is NSNull)
            let plan = try XCTUnwrap(result["open"] as? [String: Any]); XCTAssertEqual(plan["kind"] as? String, kind)
            XCTAssertEqual(kind == "file" ? plan["uri"] as? String : (plan["attachment"] as? [String: Any])?["uri"] as? String, files[index].absoluteString)
        }
        XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, bytes); XCTAssertEqual(try files.map(inode), identities)
        XCTAssertEqual(try projectMarkers() - count, 3); XCTAssertEqual(try markers(), 0)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed())
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertFalse(log.contains("Private.txt")); XCTAssertFalse(log.contains(files[0].absoluteString))
    }

    func testArchivedProjectAndMissingManagedFileRemainReadOnly() async throws {
        try await seed()
        let file = managed.appendingPathComponent("archived-file.txt"), bytes = Data("archived Project".utf8)
        let live = item("archived-file", uri: file.absoluteString), missing = item("missing", uri: managed.appendingPathComponent("missing.txt").absoluteString)
        try seedProject([live, missing], status: "archived"); try bytes.write(to: file)
        let host = core(); _ = try await host.start(); let tasks = try rows(), projects = try projectRows(), identity = try inode(file)
        let options = try object(await host.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        XCTAssertEqual(options["canEdit"] as? Bool, false)
        let available = try await projectOpened(host, id: "archived-file")
        XCTAssertEqual(available["status"] as? String, "available")
        let unavailable = try await projectOpened(host, id: "missing")
        XCTAssertEqual(unavailable["status"] as? String, "unavailable"); XCTAssertNotNil(unavailable["message"] as? String)
        XCTAssertTrue(unavailable["update"] is NSNull); XCTAssertTrue(unavailable["open"] is NSNull)
        XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try projectMarkers(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.appendingPathComponent("missing.txt").path))
    }

    func testProjectUnknownDeletedPurgedLinkAndMalformedRequestsCannotReadOrWrite() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("Project bytes".utf8), live = item("live", uri: file.absoluteString)
        var removed = live; removed["id"] = "removed"; removed["deletedAt"] = at
        let link: [String: Any] = ["id": "link", "kind": "link", "title": "Private link", "uri": "https://example.invalid", "createdAt": at, "updatedAt": at]
        try seedProject([live, removed, link]); try bytes.write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let tasks = try rows(), projects = try projectRows(), identity = try inode(file)
        let inputs = try [json(["projectId": "unknown", "attachmentId": "live"]), json(["projectId": projectID, "attachmentId": "unknown"]),
            json(["projectId": projectID, "attachmentId": "removed"]), json(["projectId": projectID, "attachmentId": "link"]),
            json(["projectId": projectID, "attachmentId": "live", "extra": true]), json(["projectId": projectID, "attachmentId": 1]),
            json(["projectId": String(repeating: "x", count: 501), "attachmentId": "live"]), String(repeating: " ", count: 2_001)]
        for input in inputs { await refused { _ = try await host.prepareProjectFileOpen(requestJSON: input) } }
        XCTAssertEqual(work, 0); XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try projectMarkers(), 0)
        await host.close()
        for column in ["deletedAt", "purgedAt"] {
            _ = try sql("UPDATE projects SET deletedAt=NULL,purgedAt=NULL"); _ = try sql("UPDATE projects SET \(column)=? WHERE id=?", [at, projectID])
            let cold = core(); try await cold.configureAttachmentHost(hooks); _ = try await cold.start(); let retained = try projectRows()
            await refused { _ = try await self.projectOpened(cold, id: "live") }
            XCTAssertEqual(work, 0); XCTAssertEqual(try projectRows(), retained); XCTAssertEqual(try rows(), tasks)
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity); await cold.close()
        }
    }

    func testProjectForeignAlternateAndUnsafeManagedTargetsCannotCopy() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), outside = root.appendingPathComponent("outside.txt"), cached = cache.appendingPathComponent("cached.txt")
        let symlink = managed.appendingPathComponent("symlink.txt"), hardlink = managed.appendingPathComponent("hardlink.txt"), directory = managed.appendingPathComponent("directory.txt")
        let bytes = Data("unsafe Project bytes".utf8)
        for url in [file, outside, cached] { try bytes.write(to: url) }
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
        try FileManager.default.linkItem(at: outside, to: hardlink); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let attachments = [item("outside", uri: outside.absoluteString), item("cached", uri: cached.absoluteString), item("remote", uri: "https://example.invalid/Private.txt"),
            item("live", uri: "file:" + file.path), item("old-root", uri: "file:///var/mobile/Containers/Data/Application/00000000-0000-0000-0000-000000000000/Library/attachments/old-root.txt"),
            item("wrong-id", uri: file.absoluteString), item("symlink", uri: symlink.absoluteString), item("hardlink", uri: hardlink.absoluteString), item("directory", uri: directory.absoluteString)]
        try seedProject(attachments)
        let host = core(), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let tasks = try rows(), projects = try projectRows(), paths = [file, outside, cached, symlink, hardlink, directory], identities = try paths.map(inode)
        let managedNames = try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), cacheNames = try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted()
        for (index, row) in attachments.enumerated() {
            let before = work
            await refused { _ = try await self.projectOpened(host, id: XCTUnwrap(row["id"] as? String)) }
            if index < 5 { XCTAssertEqual(work, before, "External or noncanonical URI must stop before typed jobs") }
        }
        XCTAssertGreaterThan(work, 0); XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try paths.map(inode), identities); XCTAssertEqual(try [file, outside, cached, hardlink].map { try Data(contentsOf: $0) }, [bytes, bytes, bytes, bytes])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path).sorted(), managedNames)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.path).sorted(), cacheNames); XCTAssertEqual(try projectMarkers(), 0)
    }

    func testProjectUpdatedAudioForeignAndMismatchedSharedPlansAreRefused() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("Project plan bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try seedProject([attachment]); try bytes.write(to: file)
        let plan: [String: Any] = ["kind": "file", "uri": file.absoluteString, "mimeType": "text/plain", "viewMimeType": "text/plain"]
        func answer(_ open: Any, status: String = "available", update: Any = NSNull()) -> [String: Any] {
            ["status": status, "message": NSNull(), "update": update, "open": open]
        }
        var foreign = plan; foreign["uri"] = "https://example.invalid/Private.txt"
        var changed = attachment; changed["size"] = 999
        var extra = plan; extra["extra"] = true
        let answers = [answer(plan, update: ["attachments": [attachment]]), answer(NSNull(), status: "unavailable"), answer(foreign),
            answer(["kind": "audio", "attachment": attachment]), answer(["kind": "image", "attachment": changed]), answer(extra)]
        let host = core(bundleURL: try probeBundle(answers + [answer(plan)], method: "projectLocalFileOpenPlan")); _ = try await host.start()
        let tasks = try rows(), projects = try projectRows(), identity = try inode(file)
        for _ in answers { await refused { _ = try await self.projectOpened(host, id: "live") } }
        let accepted = try await projectOpened(host, id: "live")
        XCTAssertEqual(accepted["status"] as? String, "available", "Final valid ticket proves every earlier forged plan was consumed")
        XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try projectMarkers(), 1)
    }

    func testProjectTokenRevisionAndSelectedMetadataAreRecheckedAroundSharedCallsAndMarker() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("Project token bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try seedProject([attachment]); try bytes.write(to: file)
        let tasks = try rows(), projects = try projectRows(), identity = try inode(file)
        for point in [2, 3, 5] {
            // The first complete Open is a control (five exact option reads).
            // Only the second Open's selected boundary returns a changed token.
            let suffix = """
            ;(() => {
              const oldOptions = MindwtrHost.projectAttachmentEditOptions, oldPoll = MindwtrHost.poll, tracked = new Set();
              let seen = 0;
              MindwtrHost.projectAttachmentEditOptions = (...args) => { const id = oldOptions(...args); tracked.add(id); return id; };
              MindwtrHost.poll = id => {
                const raw = oldPoll(id);
                if (raw == null || !tracked.has(id)) return raw;
                tracked.delete(id);
                const frame = JSON.parse(raw);
                if (frame.ok && frame.value && frame.value.project && ++seen >= \(5 + point)) {
                  if (\(point) === 2) frame.value.project.title = 'Changed token';
                  else if (\(point) === 3) frame.value.revision += ':changed';
                  else frame.value.project.attachments[0].size = 999;
                }
                return JSON.stringify(frame);
              };
            })();
            """
            let probe = root.appendingPathComponent("project-token-\(point).js")
            try (String(contentsOf: bundle) + suffix).write(to: probe, atomically: true, encoding: .utf8)
            let host = core(bundleURL: probe); _ = try await host.start(); let count = try projectMarkers()
            let control = try await projectOpened(host, id: "live"); XCTAssertEqual(control["status"] as? String, "available")
            await refused { _ = try await self.projectOpened(host, id: "live") }
            XCTAssertEqual(try projectMarkers() - count, point == 5 ? 2 : 1)
            XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); await host.close()
        }
    }

    func testProjectCancellationDrainsReadAndPendingOrClosedHostsPreserveEvidence() async throws {
        try await seed()
        let file = managed.appendingPathComponent("live.txt"), bytes = Data("Project cancellation bytes".utf8), attachment = item("live", uri: file.absoluteString)
        try seedProject([attachment]); try bytes.write(to: file)
        let host = core(), hooks = NativeAttachmentHostHooks(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { id, _ in if id == "1" { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let tasks = try rows(), projects = try projectRows(), identity = try inode(file), input = try json(["projectId": projectID, "attachmentId": "live"])
        let operation = Task { try await host.prepareProjectFileOpen(requestJSON: input) }; defer { release.signal() }
        let enteredResult = entered.wait(timeout: .now() + 5); XCTAssertEqual(enteredResult, .success)
        guard enteredResult == .success else { operation.cancel(); release.signal(); _ = try? await operation.value; return }
        operation.cancel(); let closed = DispatchSemaphore(value: 0), closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let faults = HostIOFaults(), replacement = core(faults); await refused { _ = try await replacement.start() }
        release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled Project opening must not produce a plan") }
        catch is CancellationError { } catch { XCTFail("Expected cancellation") }
        await closeTask.value
        XCTAssertEqual(try rows(), tasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try projectMarkers(), 0)
        _ = try await replacement.start()
        let accepted = try await projectOpened(replacement, id: "live"); XCTAssertEqual(accepted["status"] as? String, "available")
        let capture = try object(await replacement.call("captureOpen"))
        let command = try json([json(["text": "Pending Project capture", "options": try XCTUnwrap(capture["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending COMMIT") } }
        await refused { _ = try await replacement.call("captureSubmit", argumentsJSON: command) }
        let journal = database.appendingPathExtension("pending.json"), retained = try Data(contentsOf: journal), pendingTasks = try rows(), count = try projectMarkers()
        await refused { _ = try await self.projectOpened(replacement, id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), pendingTasks); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try projectMarkers(), count)
        await replacement.close(); await refused { _ = try await self.projectOpened(replacement, id: "live") }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try rows(), pendingTasks); XCTAssertEqual(try projectRows(), projects)
    }
    private func oldContainer285() throws -> URL {
        let container = fixtureBase.appendingPathComponent("Application/" + UUID().uuidString.lowercased(), isDirectory: true)
        root = container.appendingPathComponent("Library/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return container
    }
    private func relocate285(_ container: URL, copy: Bool = false) throws {
        let next = container.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        let suffix = String(root.path.dropFirst(container.path.count))
        if copy { try FileManager.default.copyItem(at: container, to: next) }
        else { try FileManager.default.moveItem(at: container, to: next) }
        root = URL(fileURLWithPath: next.path + suffix, isDirectory: true)
    }
    private func hashed285(_ id: String, uri: String, bytes: Data, mime: String = "text/plain") -> [String: Any] {
        var result = item(id, uri: uri, mime: mime)
        result["size"] = bytes.count; result["fileHash"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return result
    }
    private func plannedURI285(_ answer: [String: Any]) throws -> String {
        let plan = try XCTUnwrap(answer["open"] as? [String: Any])
        return try XCTUnwrap(plan["kind"] as? String == "file" ? plan["uri"] as? String : (plan["attachment"] as? [String: Any])?["uri"] as? String)
    }
    private func relocatedMarkers285() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-relocated-file-open").count - 1
    }

    func testRelocatedRenameTaskAndArchivedProjectPlansPreserveOriginalRowsAndBytes() async throws {
        let container = try oldContainer285()
        let bytes = Data("plain".utf8), ids = (0..<3).map { _ in UUID().uuidString.lowercased() }
        let names = zip(ids, ["txt", "png", "wav"]).map { $0.0 + "." + $0.1 }
        let oldFiles = names.map { managed.appendingPathComponent($0) }
        let attachments = zip(zip(ids, oldFiles), ["text/plain", "image/png", "audio/wav"]).map {
            hashed285($0.0.0, uri: $0.0.1.absoluteString, bytes: bytes, mime: $0.1)
        }
        try await seed(attachments, archived: true); try seedProject(attachments, status: "archived")
        for file in oldFiles { try bytes.write(to: file) }
        let identities = try oldFiles.map(inode)
        try relocate285(container)
        let currentFiles = names.map { managed.appendingPathComponent($0) }
        XCTAssertEqual(try currentFiles.map(inode), identities)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldFiles[0].path))
        let host = core(); _ = try await host.start(); let before = try rows(), projects = try projectRows()
        for (index, kind) in ["file", "image", "audio"].enumerated() {
            let answer = try await opened(host, attachments, id: ids[index])
            XCTAssertEqual(answer["relocatedFrom"] as? String, oldFiles[index].absoluteString)
            XCTAssertEqual(try plannedURI285(answer), currentFiles[index].absoluteString)
            XCTAssertEqual((answer["open"] as? [String: Any])?["kind"] as? String, kind)
            XCTAssertTrue(answer["update"] is NSNull)
            let project = try await projectOpened(host, id: ids[index])
            XCTAssertEqual(project["relocatedFrom"] as? String, oldFiles[index].absoluteString)
            XCTAssertEqual(try plannedURI285(project), currentFiles[index].absoluteString)
            XCTAssertEqual((project["open"] as? [String: Any])?["kind"] as? String, kind == "audio" ? "file" : kind)
            XCTAssertTrue(project["update"] is NSNull)
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try currentFiles.map(inode), identities); XCTAssertEqual(try currentFiles.map { try Data(contentsOf: $0) }, [bytes, bytes, bytes])
        XCTAssertEqual(try relocatedMarkers285(), 6)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()); XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed())
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.appendingPathExtension("pending.json").path))
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"))
        XCTAssertFalse(log.contains(oldFiles[0].absoluteString)); XCTAssertFalse(log.contains("Private.txt"))
    }

    func testRelocatedCopiedContainerReadsOnlyCurrentTargetWhileOldURIStillExists() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), attachment = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([attachment]); try bytes.write(to: old); let oldIdentity = try inode(old)
        try relocate285(container, copy: true)
        let current = managed.appendingPathComponent(id + ".txt"), currentIdentity = try inode(current)
        XCTAssertNotEqual(currentIdentity, oldIdentity)
        let unrelated = Data("wrong".utf8); try unrelated.write(to: old)
        let oldAfter = try inode(old)
        let host = core(); _ = try await host.start(); let before = try rows(), projects = try projectRows()
        let answer = try await opened(host, [attachment], id: id)
        XCTAssertEqual(answer["relocatedFrom"] as? String, old.absoluteString); XCTAssertEqual(try plannedURI285(answer), current.absoluteString)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try Data(contentsOf: old), unrelated); XCTAssertEqual(try inode(old), oldAfter)
        XCTAssertEqual(try Data(contentsOf: current), bytes); XCTAssertEqual(try inode(current), currentIdentity); XCTAssertEqual(try relocatedMarkers285(), 1)
    }

    func testRelocatedHashSizeAndCanonicalUUIDAreRequiredForBothOwners() async throws {
        let container = try oldContainer285(), bytes = Data("plain".utf8)
        var attachments: [[String: Any]] = [], names: [String] = []
        for failure in ["missingHash", "invalidHash", "wrongHash", "wrongSize", "booleanSize", "fractionalSize", "nonUUID", "uppercaseUUID", "valid"] {
            let id = failure == "nonUUID" ? "non-uuid" : failure == "uppercaseUUID" ? "A1111111-B222-4333-8444-555555555555" : UUID().uuidString.lowercased()
            let name = id + ".txt"; names.append(name)
            var selected = hashed285(id, uri: managed.appendingPathComponent(name).absoluteString, bytes: bytes)
            switch failure {
            case "missingHash": selected.removeValue(forKey: "fileHash")
            case "invalidHash": selected["fileHash"] = "not a hash"
            case "wrongHash": selected["fileHash"] = String(repeating: "b", count: 64)
            case "wrongSize": selected["size"] = bytes.count + 1
            case "booleanSize": selected["size"] = true
            case "fractionalSize": selected["size"] = 2.5
            default: break
            }
            attachments.append(selected)
        }
        try await seed(attachments); try seedProject(attachments)
        for name in names { try bytes.write(to: managed.appendingPathComponent(name)) }
        try relocate285(container)
        let files = names.map { managed.appendingPathComponent($0) }, identities = try files.map(inode)
        for selected in attachments {
            let id = try XCTUnwrap(selected["id"] as? String)
            _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([selected]), taskID])
            _ = try sql("UPDATE projects SET attachments=? WHERE id=?", [json([selected]), projectID])
            let host = core(); _ = try await host.start(); let before = try rows(), projects = try projectRows(), count = try relocatedMarkers285()
            if id == (attachments.last?["id"] as? String) {
                let task = try await opened(host, [selected], id: id), project = try await projectOpened(host, id: id)
                XCTAssertEqual(task["status"] as? String, "available"); XCTAssertEqual(project["status"] as? String, "available")
                XCTAssertEqual(try relocatedMarkers285() - count, 2)
            } else {
                await refused { _ = try await self.opened(host, [selected], id: id) }
                await refused { _ = try await self.projectOpened(host, id: id) }
                XCTAssertEqual(try relocatedMarkers285(), count)
            }
            XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects); await host.close()
        }
        XCTAssertEqual(try files.map(inode), identities); XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, Array(repeating: bytes, count: files.count))
    }

    func testRelocatedMissingCurrentTargetCannotCopyReadableOldBytesOrRepairMetadata() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try seedProject([selected]); try bytes.write(to: old)
        try relocate285(container, copy: true)
        let current = managed.appendingPathComponent(id + ".txt"); try FileManager.default.removeItem(at: current)
        let oldIdentity = try inode(old), host = core(); _ = try await host.start()
        let before = try rows(), projects = try projectRows(), names = try FileManager.default.contentsOfDirectory(atPath: managed.path)
        let task = try await opened(host, [selected], id: id), project = try await projectOpened(host, id: id)
        for answer in [task, project] {
            XCTAssertEqual(answer["status"] as? String, "unavailable"); XCTAssertNotNil(answer["message"] as? String)
            XCTAssertTrue(answer["update"] is NSNull); XCTAssertTrue(answer["open"] is NSNull); XCTAssertNil(answer["relocatedFrom"])
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects)
        XCTAssertFalse(FileManager.default.fileExists(atPath: current.path)); XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: managed.path), names)
        XCTAssertEqual(try inode(old), oldIdentity); XCTAssertEqual(try Data(contentsOf: old), bytes); XCTAssertEqual(try relocatedMarkers285(), 0)
    }

    func testRelocatedForeignSuffixAndNoncanonicalMappingsRefuseBeforeFileJobs() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), oldURI = old.absoluteString
        let scope = root.lastPathComponent
        let uris = ["file:" + old.path,
            oldURI.replacingOccurrences(of: "/Library/" + scope + "/", with: "/Library/" + UUID().uuidString.lowercased() + "/"),
            oldURI.replacingOccurrences(of: "/Application/", with: "/Foreign/"),
            oldURI.replacingOccurrences(of: "/Library/", with: "/Library//"),
            oldURI.replacingOccurrences(of: id + ".txt", with: "%" + String(format: "%02X", id.utf8.first!) + String(id.dropFirst()) + ".txt"),
            oldURI.replacingOccurrences(of: id + ".txt", with: "../" + id + ".txt"),
            oldURI + "?query=1", oldURI + "#fragment"]
        let selected = hashed285(id, uri: oldURI, bytes: bytes)
        try await seed([selected]); try bytes.write(to: old); try relocate285(container)
        let current = managed.appendingPathComponent(id + ".txt"), identity = try inode(current)
        let host = core(), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let original = try rows()
        for uri in uris {
            var invalid = selected; invalid["uri"] = uri
            _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([invalid]), taskID])
            let before = work
            await refused { _ = try await self.opened(host, [invalid], id: id) }
            XCTAssertEqual(work, before, "Invalid mapping must stop before any file observation")
        }
        _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([selected]), taskID])
        XCTAssertEqual(try rows(), original); XCTAssertEqual(try inode(current), identity); XCTAssertEqual(try Data(contentsOf: current), bytes)
        XCTAssertEqual(try relocatedMarkers285(), 0)
    }

    func testRelocatedAmbiguousCurrentContainerAnchorIsNeverGuessed() async throws {
        let outer = try oldContainer285(), outerRoot = try XCTUnwrap(root)
        let inner = outerRoot.appendingPathComponent("Application/" + UUID().uuidString.lowercased(), isDirectory: true)
        root = inner.appendingPathComponent("Library/" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8), old = managed.appendingPathComponent(id + ".txt")
        let selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try bytes.write(to: old); try relocate285(inner)
        let file = managed.appendingPathComponent(id + ".txt"), identity = try inode(file), host = core()
        _ = try await host.start(); let before = try rows()
        await refused { _ = try await self.opened(host, [selected], id: id) }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try relocatedMarkers285(), 0); XCTAssertTrue(FileManager.default.fileExists(atPath: outer.path))
    }

    func testRelocatedSymlinkHardlinkAndDirectoryCannotGainOpeningAuthority() async throws {
        let container = try oldContainer285(), bytes = Data("plain".utf8), ids = (0..<3).map { _ in UUID().uuidString.lowercased() }
        let names = ids.map { $0 + ".txt" }, oldFiles = names.map { managed.appendingPathComponent($0) }
        let attachments = zip(ids, oldFiles).map { hashed285($0.0, uri: $0.1.absoluteString, bytes: bytes) }
        try await seed(attachments); try seedProject(attachments); for file in oldFiles { try bytes.write(to: file) }
        try relocate285(container)
        let outside = root.appendingPathComponent("outside.txt"); try bytes.write(to: outside)
        let files = names.map { managed.appendingPathComponent($0) }; for file in files { try FileManager.default.removeItem(at: file) }
        try FileManager.default.createSymbolicLink(at: files[0], withDestinationURL: outside)
        try FileManager.default.linkItem(at: outside, to: files[1])
        try FileManager.default.createDirectory(at: files[2], withIntermediateDirectories: false)
        let identities = try files.map(inode), host = core(); _ = try await host.start(); let before = try rows(), projects = try projectRows()
        for id in ids {
            await refused { _ = try await self.opened(host, attachments, id: id) }
            await refused { _ = try await self.projectOpened(host, id: id) }
        }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects); XCTAssertEqual(try files.map(inode), identities)
        XCTAssertEqual(try Data(contentsOf: outside), bytes); XCTAssertEqual(try relocatedMarkers285(), 0)
    }

    private func checkpoint285(_ host: CoreHost, attachments: [[String: Any]]) async throws -> EditorDraftSnapshot {
        let raw: [String: Any] = ["title": "Unsaved title", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "",
            "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "",
            "relativeOwned": false, "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload = try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": ["title": "Preserved title"], "edited": ["title": "Unsaved title"], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": attachments, "attachments": attachments,
            "linkSheet": [:], "checklistBase": [], "checklistValue": []] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot); return snapshot
    }

    func testRelocatedOrdinaryCheckpointSurvivesButChangedSelectionAndOwnedHistoryRefuse() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try bytes.write(to: old); try relocate285(container)
        let host = core(); _ = try await host.start(); let draft = try await checkpoint285(host, attachments: [selected])
        let editor = EditorDraftStore(databaseURL: database).url, editorBytes = try Data(contentsOf: editor), editorIdentity = try inode(editor)
        let current = managed.appendingPathComponent(id + ".txt"), identity = try inode(current), before = try rows()
        let accepted = try await opened(host, [selected], id: id)
        XCTAssertEqual(accepted["relocatedFrom"] as? String, old.absoluteString)
        var edited = selected; edited["title"] = "Unsaved attachment title"
        await refused { _ = try await self.opened(host, [edited], id: id) }
        XCTAssertEqual(try Data(contentsOf: editor), editorBytes); XCTAssertEqual(try inode(editor), editorIdentity)
        XCTAssertEqual(try EditorDraftStore(databaseURL: database).read()?.snapshot, draft)
        _ = try await host.beginAttachmentDraftV3(expectedSession: draft.sessionID, expectedGeneration: draft.generation)
        let ownerFile = NativeAttachmentDraftStore(databaseURL: database).url, ownerBytes = try Data(contentsOf: ownerFile), ownerIdentity = try inode(ownerFile)
        let ownedEditor = try Data(contentsOf: editor), ownedEditorIdentity = try inode(editor), markers = try relocatedMarkers285()
        await refused { _ = try await self.opened(host, [selected], id: id) }
        XCTAssertEqual(try Data(contentsOf: ownerFile), ownerBytes); XCTAssertEqual(try inode(ownerFile), ownerIdentity)
        XCTAssertEqual(try Data(contentsOf: editor), ownedEditor); XCTAssertEqual(try inode(editor), ownedEditorIdentity)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: current), bytes); XCTAssertEqual(try inode(current), identity)
        XCTAssertEqual(try relocatedMarkers285(), markers)
    }

    func testRelocatedSameByteEditorReplacementDuringReadRefusesWithoutThaw() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try bytes.write(to: old); try relocate285(container)
        let host = core(), hooks = NativeAttachmentHostHooks(); var armed = false, fired = false, mutationError: Error?
        let editor = EditorDraftStore(databaseURL: database).url
        hooks.configureJobs = { jobs in jobs.afterWork = { _, _ in
            if armed && !fired { fired = true; do { try Data(contentsOf: editor).write(to: editor, options: .atomic) } catch { mutationError = error } }
        } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start()
        _ = try await checkpoint285(host, attachments: [selected])
        let accepted = try await opened(host, [selected], id: id); XCTAssertEqual(accepted["status"] as? String, "available")
        let retained = try Data(contentsOf: editor), editorIdentity = try inode(editor), before = try rows(), markers = try relocatedMarkers285()
        let file = managed.appendingPathComponent(id + ".txt"), fileIdentity = try inode(file)
        armed = true; await refused { _ = try await self.opened(host, [selected], id: id) }
        XCTAssertTrue(fired); XCTAssertNil(mutationError); XCTAssertNotEqual(try inode(editor), editorIdentity); XCTAssertEqual(try Data(contentsOf: editor), retained)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read()?.attempt)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), fileIdentity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try relocatedMarkers285(), markers)
    }

    func testRelocatedCurrentFileAndParentGenerationChangesDuringReadRefuse() async throws {
        for parent in [false, true] {
            let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
            let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
            try await seed([selected]); try bytes.write(to: old); try relocate285(container)
            let file = managed.appendingPathComponent(id + ".txt"), held = managed.deletingLastPathComponent().appendingPathComponent("held-attachments")
            let identity = try inode(file), directoryIdentity = try inode(managed), host = core(), hooks = NativeAttachmentHostHooks()
            var fired = false, mutationError: Error?
            hooks.configureJobs = { jobs in jobs.afterWork = { token, _ in
                if token == "1" { fired = true; do {
                    if parent {
                        try FileManager.default.moveItem(at: self.managed, to: held)
                        try FileManager.default.createDirectory(at: self.managed, withIntermediateDirectories: false)
                    }
                    try bytes.write(to: file, options: .atomic)
                } catch { mutationError = error } }
            } }
            try await host.configureAttachmentHost(hooks); _ = try await host.start(); let before = try rows()
            await refused { _ = try await self.opened(host, [selected], id: id) }
            XCTAssertTrue(fired); XCTAssertNil(mutationError); XCTAssertNotEqual(try inode(file), identity)
            if parent { XCTAssertNotEqual(try inode(managed), directoryIdentity); XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent(id + ".txt")), bytes) }
            XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try rows(), before); XCTAssertEqual(try relocatedMarkers285(), 0)
            await host.close()
        }
    }

    func testRelocatedDurableMetadataChangeWhileSharedStoreIsStaleRefuses() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try seedProject([selected]); try bytes.write(to: old); try relocate285(container)
        let file = managed.appendingPathComponent(id + ".txt"), identity = try inode(file)
        for table in ["tasks", "projects"] {
            let host = core(), hooks = NativeAttachmentHostHooks(); var fired = false, mutationError: Error?
            var changed = selected; changed["title"] = "Changed durable metadata"
            let targetID = table == "tasks" ? taskID : projectID
            hooks.configureJobs = { jobs in jobs.afterWork = { token, _ in
                if token == "1" { fired = true; do { _ = try self.sql("UPDATE \(table) SET attachments=? WHERE id=?", [self.json([changed]), targetID]) } catch { mutationError = error } }
            } }
            try await host.configureAttachmentHost(hooks); _ = try await host.start()
            if table == "tasks" { await refused { _ = try await self.opened(host, [selected], id: id) } }
            else { await refused { _ = try await self.projectOpened(host, id: id) } }
            XCTAssertTrue(fired); XCTAssertNil(mutationError)
            let actual = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM \(table) WHERE id=?", [targetID]).utf8)) as? [[String: Any]])
            XCTAssertEqual(actual.first?["attachments"] as? String, try json([changed]))
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try relocatedMarkers285(), 0)
            await host.close(); _ = try sql("UPDATE \(table) SET attachments=? WHERE id=?", [json([selected]), targetID])
        }
    }

    func testRelocatedPendingCommandRemainsExactAndBlocksBothOwners() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try seedProject([selected]); try bytes.write(to: old); try relocate285(container)
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let capture = try object(await host.call("captureOpen"))
        let command = try json([json(["text": "Pending capture", "options": try XCTUnwrap(capture["options"]), "captureId": UUID().uuidString.lowercased(), "openAfterSave": false])])
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending COMMIT") } }
        await refused { _ = try await host.call("captureSubmit", argumentsJSON: command) }
        let journal = database.appendingPathExtension("pending.json"), retained = try Data(contentsOf: journal), journalIdentity = try inode(journal)
        let before = try rows(), projects = try projectRows(), file = managed.appendingPathComponent(id + ".txt"), identity = try inode(file)
        await refused { _ = try await self.opened(host, [selected], id: id) }
        await refused { _ = try await self.projectOpened(host, id: id) }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try inode(journal), journalIdentity)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try projectRows(), projects)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try relocatedMarkers285(), 0)
    }

    func testRelocatedCancellationDrainsCurrentReadWithoutPreparingOrChangingRows() async throws {
        let container = try oldContainer285(), id = UUID().uuidString.lowercased(), bytes = Data("plain".utf8)
        let old = managed.appendingPathComponent(id + ".txt"), selected = hashed285(id, uri: old.absoluteString, bytes: bytes)
        try await seed([selected]); try bytes.write(to: old); try relocate285(container)
        let file = managed.appendingPathComponent(id + ".txt"), identity = try inode(file), host = core()
        let hooks = NativeAttachmentHostHooks(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.configureJobs = { jobs in jobs.beforeWork = { token, _ in if token == "1" { entered.signal(); release.wait() } } }
        try await host.configureAttachmentHost(hooks); _ = try await host.start(); let before = try rows()
        let operation = Task { try await self.opened(host, [selected], id: id) }; defer { release.signal() }
        let result = entered.wait(timeout: .now() + 5); XCTAssertEqual(result, .success)
        guard result == .success else { operation.cancel(); release.signal(); _ = try? await operation.value; return }
        operation.cancel(); let closed = DispatchSemaphore(value: 0), closeTask = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut); release.signal()
        do { _ = try await operation.value; XCTFail("Cancelled relocated read must not produce a plan") }
        catch is CancellationError { } catch { XCTFail("Expected cancellation") }
        await closeTask.value
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try relocatedMarkers285(), 0)
    }

}
