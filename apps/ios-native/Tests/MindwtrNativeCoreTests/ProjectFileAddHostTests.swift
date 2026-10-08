import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class ProjectFileAddHostTests: XCTestCase {
    private var fixtureRoot: URL!
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private let projectID = "file-add-project"
    private let at = "2026-10-06T12:00:00.000Z"
    private let bytes = Data("Project provider bytes\n".utf8)
    private enum Injected: Error { case boundary }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task282-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        fixtureRoot = URL(fileURLWithPath: String(cString: physical), isDirectory: true); root = fixtureRoot
    }
    override func tearDownWithError() throws { if let fixtureRoot { try FileManager.default.removeItem(at: fixtureRoot) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func projectRows() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects ORDER BY id").utf8))) }
    private func otherRows() throws -> [String] {
        try ["tasks", "sections", "areas", "people", "settings", "saved_filters", "calendar_sync"].map {
            try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \($0) ORDER BY \($0 == "calendar_sync" ? "task_id,platform" : "id")").utf8)))
        }
    }
    private func stored(_ id: String? = nil) throws -> [[String: Any]] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT attachments FROM projects WHERE id=?", [id ?? projectID]).utf8)) as? [[String: Any]])
        guard let raw = rows.first?["attachments"] as? String else { return [] }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [[String: Any]])
    }
    private func seed(_ name: String = "one", status: String = "active", existingRoot: Bool = true) async throws -> URL {
        root = fixtureRoot.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let initial = core(); _ = try await initial.start(); await initial.close()
        if existingRoot { try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true) }
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Preserved Project',?,'#94a3b8','Preserved notes',1,'[]',0,0,NULL,?,?,1,'fixture')", [projectID, status, at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES ('sibling-project','Sibling','waiting','#123456','Sibling notes',2,'[]',0,0,NULL,?,?,4,'fixture')", [at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,taskMode,projectId,contexts,tags,attachments,checklist,showFutureRecurrence,pushCount,isFocusedToday,suppressMindwtrReminders,createdAt,updatedAt,rev,revBy) VALUES ('sibling-task','Preserved task','next','list',?,'[]','[]',NULL,NULL,0,0,0,0,?,?,2,'fixture')", [projectID, at, at])
        let source = root.appendingPathComponent("picked.txt"); try bytes.write(to: source); return source
    }
    private func request(_ host: CoreHost) async throws -> [String: Any] {
        let options = try object(await host.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": projectID])])))
        let token = try XCTUnwrap(options["project"] as? [String: Any])
        return ["requestId": UUID().uuidString.lowercased(), "projectId": projectID, "expected": token.filter { $0.key != "id" }]
    }
    private func state() throws -> [String: Any] {
        let outer = try object(String(contentsOf: journal)), args = try XCTUnwrap(outer["argumentsJSON"] as? String)
        let values = try XCTUnwrap(NativeJSON.jsonObject(with: Data(args.utf8)) as? [String])
        return try object(XCTUnwrap(values.first))
    }
    private func target(_ state: [String: Any]) throws -> URL {
        let envelope = try object(XCTUnwrap(state["envelopeJSON"] as? String)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        return try XCTUnwrap(URL(string: XCTUnwrap(prepared["targetURI"] as? String)))
    }
    private func source(_ state: [String: Any]) throws -> URL {
        let proof = try XCTUnwrap(state["source"] as? [String: Any])
        return try XCTUnwrap(URL(string: XCTUnwrap(proof["sourceURI"] as? String)))
    }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture identity missing") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    @discardableResult
    private func refused(file: StaticString = #filePath, line: UInt = #line, _ action: () async throws -> Void) async -> Error? {
        do { try await action(); XCTFail("Expected retained refusal", file: file, line: line); return nil }
        catch { return error }
    }
    private func refusalDiagnostic(_ error: Error?) -> String {
        guard let error else { return "no refusal" }
        let message = error.localizedDescription
            .replacingOccurrences(of: fixtureRoot.path, with: "<fixture>")
            .replacingOccurrences(of: #"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"#, with: "<uuid>", options: .regularExpression)
        return "\(String(reflecting: type(of: error))): \(String(message.prefix(512)))"
    }
    private func retainedStart(_ host: CoreHost) async throws {
        do { _ = try await host.start(); XCTFail("Retained Add must not generically replay") }
        catch { XCTAssertTrue(error is CoreHostProjectFileAddRecovery, "Unexpected startup failure: \(error)") }
    }
    private func inject(_ host: CoreHost, _ boundary: ProjectFileAddHostBoundary) async -> () -> Bool {
        let hooks = ProjectFileAddHostHooks(); var fired = false
        hooks.boundary = { if $0 == boundary && !fired { fired = true; throw Injected.boundary } }
        await host.configureProjectFileAddHost(hooks)
        return { fired }
    }
    private func markers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-project-file-add").count - 1
    }
    private func assertNoTaskOwner(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed(), file: file, line: line)
        XCTAssertNil(try EditorDraftStore(databaseURL: database).read(), file: file, line: line)
    }

    private func changeOnlyCtime(_ file: URL) throws {
        let fd = Darwin.open(file.path, O_RDWR | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw HostFailure("Fixture metadata open failed") }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat()
        guard fstat(fd, &before) == 0 else { throw HostFailure("Fixture metadata stat failed") }
        let marker = Data([0x2a])
        let result = marker.withUnsafeBytes {
            Darwin.fsetxattr(fd, "com.mindwtr.fixture.ctime", $0.baseAddress, $0.count, 0, 0)
        }
        guard result == 0, fstat(fd, &after) == 0 else { throw HostFailure("Fixture metadata mutation failed") }
        XCTAssertTrue(before.st_dev == after.st_dev && before.st_ino == after.st_ino
            && before.st_size == after.st_size && before.st_mode == after.st_mode && before.st_nlink == after.st_nlink
            && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
            "Metadata fixture must preserve identity, bytes, mode, mtime and link count")
        XCTAssertFalse(before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
            "Metadata fixture must advance ctime")
    }

    func testActualProviderAddUsesMeasuredBytesAndColdProjectFileOpenWithoutTaskOwner() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String)
        let before = try otherRows(), originalIdentity = try inode(picked)
        let reply = try object(await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: json(input)))
        XCTAssertEqual(reply["id"] as? String, projectID); XCTAssertEqual(reply["attachmentIds"] as? [String], [id])
        let attachment = try XCTUnwrap(stored().first), target = try XCTUnwrap(URL(string: XCTUnwrap(attachment["uri"] as? String)))
        XCTAssertEqual(attachment["size"] as? Int, bytes.count); XCTAssertEqual(attachment["title"] as? String, "picked.txt")
        XCTAssertEqual(attachment["fileHash"] as? String, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try Data(contentsOf: picked), bytes)
        XCTAssertEqual(try inode(picked), originalIdentity); XCTAssertEqual(try otherRows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner(); XCTAssertEqual(try markers(), 1)
        let summary = try await host.projectFileAddSummary(); XCTAssertEqual(summary, "null")
        let saved = try projectRows(), identity = try inode(target)
        await host.close(); let cold = core(); _ = try await cold.start()
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": id])))
        let plan = try XCTUnwrap(opened["open"] as? [String: Any])
        XCTAssertEqual(plan["kind"] as? String, "file"); XCTAssertEqual(try projectRows(), saved)
        XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
    }

    func testAllDurablePhasesColdRecoverExactUUIDAndPublicationLostAcknowledgment() async throws {
        let boundaries: [ProjectFileAddHostBoundary] = [.afterIntent, .afterStageProof, .afterFilled, .afterPublication, .afterPublicationProof, .afterCommit, .afterDomainSaved, .afterStageCleanup, .afterSettled, .beforeClear]
        for boundary in boundaries {
            let picked = try await seed(boundary.rawValue), host = core(); _ = try await host.start()
            let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), beforeOther = try otherRows()
            let fired = await inject(host, boundary)
            let refusal = await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
            XCTAssertTrue(fired(), "\(boundary.rawValue): \(refusalDiagnostic(refusal))")
            let captured = try state(), envelope = try XCTUnwrap(captured["envelopeJSON"] as? String), borrowed = try source(captured), copyIdentity = try inode(borrowed)
            XCTAssertEqual(try Data(contentsOf: borrowed), bytes)
            let cold = core(); await host.close()
            let summary = try object(await cold.projectFileAddSummary())
            XCTAssertEqual(summary["requestId"] as? String, id); XCTAssertEqual(summary["phase"] as? String, captured["phase"] as? String)
            try await retainedStart(cold)
            await refused { _ = try await cold.recoverProjectFileAdd(requestId: UUID().uuidString.lowercased()) }
            let result = try object(await cold.recoverProjectFileAdd(requestId: id))
            XCTAssertEqual(result["attachmentIds"] as? [String], [id], boundary.rawValue)
            XCTAssertEqual(try stored().filter { $0["id"] as? String == id }.count, 1)
            XCTAssertEqual(try Data(contentsOf: target(captured)), bytes)
            XCTAssertEqual(try Data(contentsOf: borrowed), bytes); XCTAssertEqual(try inode(borrowed), copyIdentity)
            XCTAssertEqual(try otherRows(), beforeOther); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            try assertNoTaskOwner(); XCTAssertEqual(try object(envelope)["prepared"] is [String: Any], true)
            await cold.close()
        }
    }

    func testPublishedAbandonDeletesOnlyUnreferencedOwnedTargetAndPreservesProviderAndRows() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), before = try projectRows(), other = try otherRows()
        let fired = await inject(host, .afterPublicationProof)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(fired()); let captured = try state(), target = try target(captured), borrowed = try source(captured)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        await host.close(); let cold = core(); try await retainedStart(cold)
        let result = try object(await cold.abandonProjectFileAdd(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try projectRows(), before); XCTAssertEqual(try otherRows(), other)
        XCTAssertEqual(try Data(contentsOf: picked), bytes); XCTAssertEqual(try Data(contentsOf: borrowed), bytes)
        try assertNoTaskOwner(); XCTAssertEqual(try markers(), 1)
    }

    func testKnownSavedAbandonKeepsLiveProjectFileAndNeverRollsBackRow() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterDomainSaved)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(fired()); let captured = try state(), target = try target(captured), identity = try inode(target), saved = try projectRows()
        await host.close(); let cold = core(); try await retainedStart(cold)
        let result = try object(await cold.abandonProjectFileAdd(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true)
        XCTAssertEqual(try projectRows(), saved); XCTAssertEqual(try inode(target), identity); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testAppLockReadIsOnlyOrdinaryCallAdmittedUnderColdProjectOwner() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterIntent)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        await host.close(); let cold = core(); try await retainedStart(cold)
        let before = try Data(contentsOf: journal), rows = try projectRows(), other = try otherRows()
        _ = try object(await cold.call("appLockOptions", argumentsJSON: "[\"{}\"]"))
        XCTAssertEqual(try Data(contentsOf: journal), before); XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), other)
        await refused { _ = try await cold.call("appLockOptions", argumentsJSON: "[\"{\\\"extra\\\":true}\"]") }
        await refused { _ = try await cold.call("projectAttachmentEditOptions", argumentsJSON: self.json([self.json(["projectId": self.projectID])])) }
        await refused { _ = try await cold.call("captureCommit", argumentsJSON: "[\"not-admitted\"]") }
        await refused { _ = try await cold.call("retryPending") }
        XCTAssertEqual(try Data(contentsOf: journal), before)
        _ = try await cold.abandonProjectFileAdd(requestId: id)
    }

    func testLostClearAcknowledgmentRetainsWarmSettledSummaryAndExactRetry() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterClear)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(fired()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let saved = try projectRows(), other = try otherRows(), file = try XCTUnwrap(URL(string: XCTUnwrap(stored().first?["uri"] as? String))), identity = try inode(file)
        let summary = try object(await host.projectFileAddSummary())
        XCTAssertEqual(summary["requestId"] as? String, id); XCTAssertEqual(summary["phase"] as? String, "settled")
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        let attachment = try XCTUnwrap(stored().first)
        let openRequest = try json(["owner": ["kind": "task", "taskId": "sibling-task", "attachments": [attachment]], "attachmentId": id])
        await refused { _ = try await host.localAttachmentRequest(name: "openAttachment", requestJSON: openRequest) }
        let result = try object(await host.recoverProjectFileAdd(requestId: id))
        XCTAssertEqual(result["attachmentIds"] as? [String], [id]); XCTAssertEqual(try projectRows(), saved); XCTAssertEqual(try otherRows(), other)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        let absent = try await host.projectFileAddSummary(); XCTAssertEqual(absent, "null")
        let ordinary = try object(await host.localAttachmentRequest(name: "openAttachment", requestJSON: openRequest))
        XCTAssertEqual(ordinary["status"] as? String, "available")
    }

    func testFailedCommitColdRecoveryKeepsPublicationAndExactPreparedIntent() async throws {
        let picked = try await seed(), faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), before = try projectRows()
        var fired = false
        faults.beforeSQL = { if $0 == "COMMIT" { fired = true; throw Injected.boundary } }
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(fired); let captured = try state(), file = try target(captured), identity = try inode(file)
        XCTAssertEqual(captured["phase"] as? String, "published"); XCTAssertEqual(try projectRows(), before)
        await host.close(); let cold = core(); try await retainedStart(cold)
        let result = try object(await cold.recoverProjectFileAdd(requestId: id))
        XCTAssertEqual(result["attachmentIds"] as? [String], [id]); XCTAssertEqual(try stored().count, 1)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testReadonlyStaleUnknownAndMalformedRequestsRefuseBeforeProviderCopy() async throws {
        let picked = try await seed(status: "archived"), hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let valid = try await request(host), before = try projectRows(), sourceIdentity = try inode(picked)
        var wrong = valid; wrong["projectId"] = "unknown"
        var malformed = valid; malformed["requestId"] = "BAD"
        var extra = valid; extra["extra"] = true
        for input in [valid, wrong, malformed, extra] {
            await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        }
        XCTAssertEqual(work, 0); XCTAssertEqual(try projectRows(), before); XCTAssertEqual(try inode(picked), sourceIdentity)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cache.path).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await host.close()
        _ = try sql("UPDATE projects SET status='active' WHERE id=?", [projectID])
        let fresh = core(); _ = try await fresh.start()
        await refused { _ = try await fresh.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(valid)) }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cache.path).isEmpty)
    }

    func testReservationWithoutProofCannotAdoptOrDeleteCandidateButZeroCandidateCanStop() async throws {
        let picked = try await seed("candidate"), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterReservation)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let captured = try state(), retained = try Data(contentsOf: journal)
        XCTAssertNil(captured["stage"]); XCTAssertEqual(captured["reservationStarted"] as? Bool, true)
        let candidate = managed.appendingPathComponent(".mindwtr-install-" + id.replacingOccurrences(of: "-", with: "") + ".candidate", isDirectory: true)
        let stage = candidate.appendingPathComponent("stage"), identity = try inode(stage)
        await host.close(); let cold = core(); try await retainedStart(cold)
        await refused { _ = try await cold.recoverProjectFileAdd(requestId: id) }
        XCTAssertEqual(try Data(contentsOf: journal), retained)
        await refused { _ = try await cold.abandonProjectFileAdd(requestId: id) }
        XCTAssertEqual(try inode(stage), identity); XCTAssertEqual(try stored().count, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await cold.close()

        let second = try await seed("zero"), zero = core(); _ = try await zero.start()
        let requestZero = try await request(zero), zeroID = try XCTUnwrap(requestZero["requestId"] as? String), hit = await inject(zero, .afterIntent)
        await refused { _ = try await zero.addProviderProjectAttachment(selectedURL: second, requestJSON: self.json(requestZero)) }; XCTAssertTrue(hit())
        await zero.close(); let stopped = core(); try await retainedStart(stopped)
        let result = try object(await stopped.abandonProjectFileAdd(requestId: zeroID))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try stored().count, 0); XCTAssertEqual(try Data(contentsOf: second), bytes)
    }

    func testCreatedManagedRootColdRecoveryAndLostRootProofRefusal() async throws {
        let picked = try await seed("created", existingRoot: false), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterIntent)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
        await host.close(); let cold = core(); try await retainedStart(cold)
        _ = try await cold.recoverProjectFileAdd(requestId: id); XCTAssertEqual(try stored().count, 1); await cold.close()

        let second = try await seed("root-proof", existingRoot: false), faults = HostIOFaults(), interrupted = core(faults); _ = try await interrupted.start()
        let requestTwo = try await request(interrupted), secondID = try XCTUnwrap(requestTwo["requestId"] as? String)
        var writes = 0; faults.journalWrite = { writes += 1; if writes == 2 { throw Injected.boundary } }
        await refused { _ = try await interrupted.addProviderProjectAttachment(selectedURL: second, requestJSON: self.json(requestTwo)) }
        XCTAssertEqual(writes, 2); XCTAssertTrue(FileManager.default.fileExists(atPath: managed.path))
        XCTAssertNil(try state()["managedDirectoryIdentity"]); let retained = try Data(contentsOf: journal), rootIdentity = try inode(managed)
        await interrupted.close(); let refusal = core(); var queries = 0; let blocked = HostIOFaults(); blocked.beforeSQL = { _ in queries += 1 }
        let checked = core(blocked)
        await refused { _ = try await checked.start() }
        XCTAssertEqual(queries, 0); XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try inode(managed), rootIdentity)
        let summary = try object(await refusal.projectFileAddSummary()); XCTAssertEqual(summary["requestId"] as? String, secondID)
    }

    func testWarmJournalReplacementAndColdHardlinkRefuseWithoutAdoption() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterIntent)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let retained = try Data(contentsOf: journal), oldIdentity = try inode(journal), parked = root.appendingPathComponent("journal-original")
        try FileManager.default.moveItem(at: journal, to: parked); try retained.write(to: journal)
        XCTAssertNotEqual(try inode(journal), oldIdentity)
        await refused { _ = try await host.recoverProjectFileAdd(requestId: id) }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try stored().count, 0)
        await host.close()
        let alias = root.appendingPathComponent("journal-link")
        XCTAssertEqual(Darwin.link(journal.path, alias.path), 0)
        let faults = HostIOFaults(); var sqlCount = 0; faults.beforeSQL = { _ in sqlCount += 1 }
        let cold = core(faults); await refused { _ = try await cold.start() }
        XCTAssertEqual(sqlCount, 0); XCTAssertEqual(try Data(contentsOf: journal), retained)
    }

    func testSourceStageTargetAndManagedRootReplacementsRetainOriginalProofs() async throws {
        for part in ["source", "stage", "target", "root"] {
            let picked = try await seed(part), host = core(); _ = try await host.start()
            let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String)
            let boundary: ProjectFileAddHostBoundary = part == "target" ? .afterPublicationProof : part == "root" ? .afterIntent : .afterStageProof
            let fired = await inject(host, boundary)
            await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
            let captured = try state(), retained = try Data(contentsOf: journal), rows = try projectRows()
            let changed: URL
            if part == "source" { changed = try source(captured) }
            else if part == "target" { changed = try target(captured) }
            else if part == "root" { changed = managed }
            else {
                let proof = try XCTUnwrap(captured["stage"] as? [String: Any]); changed = try XCTUnwrap(URL(string: XCTUnwrap(proof["uri"] as? String)))
            }
            let identity = try inode(changed), parked = root.appendingPathComponent("original-" + part)
            let contents = part == "root" ? nil : (try Data(contentsOf: changed))
            try FileManager.default.moveItem(at: changed, to: parked)
            if part == "root" { try FileManager.default.createDirectory(at: changed, withIntermediateDirectories: true) }
            else { try XCTUnwrap(contents).write(to: changed) }
            XCTAssertNotEqual(try inode(changed), identity)
            await host.close(); let cold = core()
            if part == "root" { await refused { _ = try await cold.start() } }
            else { try await retainedStart(cold); await refused { _ = try await cold.recoverProjectFileAdd(requestId: id) } }
            XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try projectRows(), rows)
            XCTAssertEqual(try inode(parked), identity); await cold.close()
        }
    }

    func testStalePreparedProjectDoesNotCommitAndStopNeverRestoresOldFields() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let captured = try state(), retained = try Data(contentsOf: journal), target = try target(captured)
        await host.close(); _ = try sql("UPDATE projects SET supportNotes='Intervening B',rev=rev+1 WHERE id=?", [projectID])
        let cold = core(); try await retainedStart(cold)
        _ = try sql("UPDATE projects SET title='Intervening C',rev=rev+1 WHERE id=?", [projectID])
        let changed = try projectRows()
        await refused { _ = try await cold.recoverProjectFileAdd(requestId: id) }
        XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try projectRows(), changed); XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
        _ = try await cold.abandonProjectFileAdd(requestId: id)
        XCTAssertEqual(try projectRows(), changed); XCTAssertEqual(try stored().count, 0); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testTaskAndProjectReferencesIntroducedBeforeColdStopKeepOwnedBytes() async throws {
        for owner in ["tasks", "projects"] {
            let picked = try await seed(owner), host = core(); _ = try await host.start()
            let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
            await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
            let captured = try state(), file = try target(captured), identity = try inode(file)
            let envelope = try object(XCTUnwrap(captured["envelopeJSON"] as? String)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), attachment = try XCTUnwrap(prepared["attachment"] as? [String: Any])
            await host.close()
            _ = try sql("UPDATE \(owner) SET attachments=? WHERE id=?", [try json([attachment]), owner == "tasks" ? "sibling-task" : "sibling-project"])
            let cold = core(); try await retainedStart(cold)
            let projects = try projectRows(), others = try otherRows()
            _ = try await cold.abandonProjectFileAdd(requestId: id)
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
            XCTAssertEqual(try projectRows(), projects); XCTAssertEqual(try otherRows(), others); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            await cold.close()
        }
    }

    func testAbandonDecisionSurvivesUnlinkLostAcknowledgmentWithoutBorrowedSourceDeletion() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let captured = try state(), file = try target(captured), borrowed = try source(captured), rows = try projectRows()
        await host.close(); let hooks = NativeAttachmentHostHooks(); var removed = false
        hooks.configureJobs = { jobs in jobs.afterRetirementUnlink = { if !removed { removed = true; throw Injected.boundary } } }
        let stopped = core(); try await stopped.configureAttachmentHost(hooks); try await retainedStart(stopped)
        await refused { _ = try await stopped.abandonProjectFileAdd(requestId: id) }
        XCTAssertTrue(removed); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path)); XCTAssertEqual(try state()["abandoned"] as? Bool, true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await stopped.close()
        let cold = core(); try await retainedStart(cold)
        let result = try object(await cold.recoverProjectFileAdd(requestId: id))
        XCTAssertEqual(result["abandoned"] as? Bool, true); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try Data(contentsOf: borrowed), bytes); XCTAssertEqual(try Data(contentsOf: picked), bytes)
    }

    func testCreatedDirectoryDescriptorCannotBeReplacedBeforeProofDelivery() async throws {
        let picked = try await seed(existingRoot: false), hooks = NativeAttachmentHostHooks()
        var completed = 0, swapped = false, originalIdentity: String?
        hooks.configureJobs = { jobs in jobs.afterWork = { _, _ in
            completed += 1
            if completed == 2 {
                do {
                    originalIdentity = try self.inode(self.managed)
                    try FileManager.default.moveItem(at: self.managed, to: self.root.appendingPathComponent("created-original"))
                    try FileManager.default.createDirectory(at: self.managed, withIntermediateDirectories: true)
                    swapped = true
                } catch { XCTFail("Directory replacement fixture could not run") }
            }
        } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let input = try await request(host)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(swapped); XCTAssertEqual(completed, 2); XCTAssertNotEqual(try inode(managed), originalIdentity)
        let captured = try state(); XCTAssertNil(captured["managedDirectoryIdentity"]); XCTAssertNil(captured["stage"])
        XCTAssertEqual(captured["phase"] as? String, "intent"); XCTAssertEqual(try stored().count, 0)
        XCTAssertEqual(try inode(root.appendingPathComponent("created-original")), originalIdentity)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
    }

    func testDurableOnlyReferenceWhileSharedRowsAreStaleRefusesUntilColdKeep() async throws {
        for owner in ["tasks", "projects"] {
            let picked = try await seed("durable-" + owner), host = core(); _ = try await host.start()
            let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
            let refusal = await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
            XCTAssertTrue(fired(), "durable-\(owner): \(refusalDiagnostic(refusal))")
            let captured = try state(), file = try target(captured), identity = try inode(file)
            let envelope = try object(XCTUnwrap(captured["envelopeJSON"] as? String)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), attachment = try XCTUnwrap(prepared["attachment"] as? [String: Any])
            // Bypass the host deliberately: SQLite has a live ref JSC has never loaded.
            _ = try sql("UPDATE \(owner) SET attachments=? WHERE id=?", [try json([attachment]), owner == "tasks" ? "sibling-task" : "sibling-project"])
            let rows = try projectRows(), other = try otherRows()
            await refused { _ = try await host.abandonProjectFileAdd(requestId: id) }
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
            XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), other)
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try state()["abandoned"] as? Bool, true)
            await host.close(); let cold = core(); try await retainedStart(cold)
            let result = try object(await cold.recoverProjectFileAdd(requestId: id))
            XCTAssertEqual(result["abandoned"] as? Bool, true)
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
            XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), other); await cold.close()
        }
    }

    func testDurableReferenceWriterCannotRaceScanAndOwnedUnlink() async throws {
        let picked = try await seed(), hooks = NativeAttachmentHostHooks(); var attempted = false, blocked = false
        var attachmentJSON = ""
        hooks.configureJobs = { jobs in jobs.beforeRetirementUnlink = {
            guard !attempted else { return }; attempted = true
            let writer = try SQLiteBridge(url: self.database); defer { writer.close() }
            _ = try writer.execute("PRAGMA busy_timeout=10")
            do { _ = try writer.execute("UPDATE tasks SET attachments=? WHERE id='sibling-task'", parametersJSON: self.json([attachmentJSON])) }
            catch { blocked = true }
        } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let captured = try state(), file = try target(captured)
        let envelope = try object(XCTUnwrap(captured["envelopeJSON"] as? String)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        attachmentJSON = try json([XCTUnwrap(prepared["attachment"] as? [String: Any])])
        let before = try otherRows(), projects = try projectRows()
        _ = try await host.abandonProjectFileAdd(requestId: id)
        XCTAssertTrue(attempted); XCTAssertTrue(blocked); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(try otherRows(), before); XCTAssertEqual(try projectRows(), projects)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testEditorAndActualTaskV3OwnerBlockProjectCopyAndRemainExact() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host)
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "",
            "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
            "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
            "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload: [String: Any] = ["version": 2, "taskID": "sibling-task", "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:]]
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: "sibling-task", generation: 1, payloadJSON: try json(payload))
        try await host.checkpointEditorDraft(snapshot)
        let editor = EditorDraftStore(databaseURL: database), editorBefore = try Data(contentsOf: editor.url)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore); XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cache.path).isEmpty)
        _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1)
        let store = NativeAttachmentDraftStore(databaseURL: database), sidecarBefore = try Data(contentsOf: store.url)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertEqual(try Data(contentsOf: store.url), sidecarBefore); XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: cache.path).isEmpty); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testCancellationAfterPublicationKeepsIntentAndColdRecoveryOwnsExactUUID() async throws {
        let picked = try await seed(), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String)
        let hooks = ProjectFileAddHostHooks(), reached = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        hooks.boundary = { if $0 == .afterPublicationProof { reached.signal(); release.wait() } }
        await host.configureProjectFileAddHost(hooks)
        let operation = Task { try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        defer { release.signal() }
        let hit = await Task.detached { reached.wait(timeout: .now() + 10) == .success }.value
        XCTAssertTrue(hit); operation.cancel(); release.signal()
        await refused { _ = try await operation.value }
        let captured = try state(), file = try target(captured), identity = try inode(file)
        XCTAssertEqual(captured["phase"] as? String, "published"); XCTAssertEqual(try stored().count, 0)
        await host.close(); let cold = core(); try await retainedStart(cold)
        _ = try await cold.recoverProjectFileAdd(requestId: id)
        XCTAssertEqual(try stored().filter { $0["id"] as? String == id }.count, 1)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }

    func testMutableProviderOutputCtimeChangeStillRequiresExactPublishedContent() async throws {
        let picked = try await seed("mutable-ctime"), hooks = NativeAttachmentHostHooks()
        var changed = false
        hooks.configureJobs = { jobs in jobs.beforeProviderOutputNamedStat = { frozen in
            guard !frozen && !changed else { return }
            let entries = try FileManager.default.contentsOfDirectory(at: self.cache, includingPropertiesForKeys: nil)
            XCTAssertEqual(entries.count, 1)
            try self.changeOnlyCtime(XCTUnwrap(entries.first))
            changed = true
        } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String)
        let before = try otherRows(), originalIdentity = try inode(picked)
        let reply = try object(await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: json(input)))
        XCTAssertTrue(changed); XCTAssertEqual(reply["attachmentIds"] as? [String], [id])
        let file = try XCTUnwrap(URL(string: XCTUnwrap(stored().first?["uri"] as? String))), identity = try inode(file)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try Data(contentsOf: picked), bytes)
        XCTAssertEqual(try inode(picked), originalIdentity); XCTAssertEqual(try otherRows(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); try assertNoTaskOwner()
        await host.close(); let cold = core(); _ = try await cold.start()
        let opened = try object(await cold.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": id])))
        XCTAssertEqual(opened["status"] as? String, "available")
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity)
        XCTAssertEqual(try stored().filter { $0["id"] as? String == id }.count, 1)
    }

    func testFrozenProviderOutputCtimeChangeRefusesBeforeIntentAndKeepsDomainAndSource() async throws {
        let picked = try await seed("frozen-ctime"), hooks = NativeAttachmentHostHooks()
        var changed = false
        hooks.configureJobs = { jobs in jobs.beforeProviderOutputNamedStat = { frozen in
            guard frozen && !changed else { return }
            let entries = try FileManager.default.contentsOfDirectory(at: self.cache, includingPropertiesForKeys: nil)
            XCTAssertEqual(entries.count, 1)
            try self.changeOnlyCtime(XCTUnwrap(entries.first))
            changed = true
        } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let input = try await request(host), before = try projectRows(), other = try otherRows(), originalIdentity = try inode(picked)
        let failure = await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(changed); XCTAssertTrue(failure is NativeAttachmentFilesError)
        let summary = try await host.projectFileAddSummary(); XCTAssertEqual(summary, "null")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: managed, includingPropertiesForKeys: nil).count, 0)
        XCTAssertEqual(try projectRows(), before); XCTAssertEqual(try otherRows(), other)
        XCTAssertEqual(try Data(contentsOf: picked), bytes); XCTAssertEqual(try inode(picked), originalIdentity)
        try assertNoTaskOwner()
    }

    private func hashMarkers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-project-file-hash").count - 1
    }
    private func replaceFixtureState(_ state: [String: Any]) throws {
        var outer = try object(String(contentsOf: journal))
        outer["argumentsJSON"] = try json([json(state)])
        let encoded = Data(try json(outer).utf8)
        XCTAssertLessThanOrEqual(encoded.count, 8 * 1024 * 1024)
        try encoded.write(to: journal)
    }
    // Build the sealed historical counterpart of a real retained publication.
    // This fixture changes no native source/stage/publication descriptor proof.
    private func historicalFixture(_ original: [String: Any]) throws -> [String: Any] {
        var state = original, envelope = try object(XCTUnwrap(state["envelopeJSON"] as? String))
        var request = try XCTUnwrap(envelope["request"] as? [String: Any])
        request.removeValue(forKey: "version"); request.removeValue(forKey: "sourceSha256")
        var prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        prepared["version"] = 3; prepared["request"] = request
        var source = try XCTUnwrap(prepared["prepared"] as? [String: Any])
        var sourceAttachment = try XCTUnwrap(source["attachment"] as? [String: Any])
        sourceAttachment.removeValue(forKey: "fileHash"); source["attachment"] = sourceAttachment; prepared["prepared"] = source
        var attachment = try XCTUnwrap(prepared["attachment"] as? [String: Any])
        attachment.removeValue(forKey: "fileHash"); prepared["attachment"] = attachment
        var effect = try XCTUnwrap(prepared["effect"] as? [String: Any]), project = try XCTUnwrap(effect["project"] as? [String: Any])
        var after = try XCTUnwrap(project["after"] as? [String: Any])
        after["attachments"] = [attachment]; project["after"] = after; effect["project"] = project; prepared["effect"] = effect
        envelope["request"] = request; envelope["prepared"] = prepared
        state["version"] = 1; state["envelopeJSON"] = try json(envelope)
        return state
    }

    func testNewHashBearingLostCommitAcknowledgmentColdRecoveryThenRelocationKeepsExactRowsAndBytes() async throws {
        let oldID = UUID().uuidString.lowercased(), libraryID = UUID().uuidString.lowercased()
        let picked = try await seed("Application/" + oldID + "/Library/" + libraryID), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterCommit)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }
        XCTAssertTrue(fired()); let captured = try state(), file = try target(captured), identity = try inode(file)
        let envelope = try object(XCTUnwrap(captured["envelopeJSON"] as? String)), request = try XCTUnwrap(envelope["request"] as? [String: Any])
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), sourceProof = try XCTUnwrap(captured["source"] as? [String: Any])
        let publication = try XCTUnwrap(captured["published"] as? [String: Any]), digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(captured["version"] as? Int, 2); XCTAssertEqual(request["version"] as? Int, 2); XCTAssertEqual(prepared["version"] as? Int, 4)
        XCTAssertEqual(request["sourceSha256"] as? String, digest); XCTAssertEqual(sourceProof["sha256"] as? String, digest)
        XCTAssertEqual(publication["sha256"] as? String, digest); XCTAssertEqual(try stored().first?["fileHash"] as? String, digest)
        XCTAssertEqual(try stored().first?["id"] as? String, id)
        let rows = try projectRows(), others = try otherRows(), exactEnvelope = try XCTUnwrap(captured["envelopeJSON"] as? String)
        XCTAssertEqual(try hashMarkers(), 0); try FileManager.default.removeItem(at: picked); await host.close()
        let faults = HostIOFaults(); var domainWrites = 0
        faults.beforeSQL = { statement in
            let sql = statement.uppercased()
            if ["INSERT", "UPDATE", "DELETE"].contains(where: { sql.hasPrefix($0) }) && (sql.contains("PROJECTS") || sql.contains("TASKS")) {
                domainWrites += 1; throw Injected.boundary
            }
        }
        let cold = core(faults); try await retainedStart(cold)
        XCTAssertEqual(try state()["envelopeJSON"] as? String, exactEnvelope)
        let reply = try object(await cold.recoverProjectFileAdd(requestId: id))
        XCTAssertEqual(reply["attachmentIds"] as? [String], [id]); XCTAssertEqual(domainWrites, 0)
        XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), others)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual(try markers(), 1); XCTAssertEqual(try hashMarkers(), 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await cold.close()
        let oldContainer = fixtureRoot.appendingPathComponent("Application/" + oldID, isDirectory: true)
        let next = oldContainer.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.moveItem(at: oldContainer, to: next)
        root = next.appendingPathComponent("Library/" + libraryID, isDirectory: true)
        let relocated = core(); _ = try await relocated.start()
        let opened = try object(await relocated.prepareProjectFileOpen(requestJSON: json(["projectId": projectID, "attachmentId": id])))
        XCTAssertEqual(opened["status"] as? String, "available"); XCTAssertEqual(opened["relocatedFrom"] as? String, file.absoluteString)
        let plan = try XCTUnwrap(opened["open"] as? [String: Any]), uri = try XCTUnwrap(plan["uri"] as? String), current = try XCTUnwrap(URL(string: uri))
        XCTAssertNotEqual(uri, file.absoluteString); XCTAssertEqual(try inode(current), identity); XCTAssertEqual(try Data(contentsOf: current), bytes)
        XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), others)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldContainer.path)); try assertNoTaskOwner()
    }

    func testHistoricalHashlessVersionOneJournalRecoversWithoutBackfillOrNewMarker() async throws {
        let oldID = UUID().uuidString.lowercased(), libraryID = UUID().uuidString.lowercased()
        let picked = try await seed("Application/" + oldID + "/Library/" + libraryID), host = core(); _ = try await host.start()
        let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
        await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
        let original = try state(), file = try target(original), identity = try inode(file); await host.close()
        let historical = try historicalFixture(original); try replaceFixtureState(historical)
        let exactEnvelope = try XCTUnwrap(historical["envelopeJSON"] as? String), others = try otherRows()
        let cold = core(); try await retainedStart(cold)
        XCTAssertEqual(try state()["envelopeJSON"] as? String, exactEnvelope)
        let reply = try object(await cold.recoverProjectFileAdd(requestId: id))
        XCTAssertEqual(reply["attachmentIds"] as? [String], [id]); XCTAssertNil(try stored().first?["fileHash"])
        XCTAssertEqual(try hashMarkers(), 0); XCTAssertEqual(try markers(), 1)
        XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try otherRows(), others)
        let rows = try projectRows(); await cold.close()
        let oldContainer = fixtureRoot.appendingPathComponent("Application/" + oldID, isDirectory: true)
        let next = oldContainer.deletingLastPathComponent().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.moveItem(at: oldContainer, to: next); root = next.appendingPathComponent("Library/" + libraryID, isDirectory: true)
        let relocated = core(); _ = try await relocated.start()
        await refused { _ = try await relocated.prepareProjectFileOpen(requestJSON: self.json(["projectId": self.projectID, "attachmentId": id])) }
        XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), others); XCTAssertEqual(try hashMarkers(), 0)
        let current = managed.appendingPathComponent(file.lastPathComponent)
        XCTAssertEqual(try inode(current), identity); XCTAssertEqual(try Data(contentsOf: current), bytes)
    }

    func testNewHashJournalMismatchNeverFallsBackOrDeletesRetainedProofBytes() async throws {
        for change in ["missing-input", "prepared-hash", "publication-hash", "cross-version"] {
            let picked = try await seed(change), host = core(); _ = try await host.start()
            let input = try await request(host), id = try XCTUnwrap(input["requestId"] as? String), fired = await inject(host, .afterPublicationProof)
            await refused { _ = try await host.addProviderProjectAttachment(selectedURL: picked, requestJSON: self.json(input)) }; XCTAssertTrue(fired())
            var captured = try state(); let file = try target(captured), borrowed = try source(captured), identity = try inode(file), rows = try projectRows(), others = try otherRows()
            await host.close()
            var envelope = try object(XCTUnwrap(captured["envelopeJSON"] as? String)), request = try XCTUnwrap(envelope["request"] as? [String: Any])
            var prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            if change == "missing-input" { request.removeValue(forKey: "sourceSha256"); envelope["request"] = request; prepared["request"] = request }
            if change == "prepared-hash" { var attachment = try XCTUnwrap(prepared["attachment"] as? [String: Any]); attachment["fileHash"] = String(repeating: "b", count: 64); prepared["attachment"] = attachment }
            if change == "publication-hash" { var proof = try XCTUnwrap(captured["published"] as? [String: Any]); proof["sha256"] = String(repeating: "b", count: 64); captured["published"] = proof }
            if change == "cross-version" { captured["version"] = 1 }
            envelope["prepared"] = prepared; captured["envelopeJSON"] = try json(envelope); try replaceFixtureState(captured)
            let exactJournal = try Data(contentsOf: journal), journalIdentity = try inode(journal), cold = core()
            await refused { _ = try await cold.projectFileAddSummary() }
            await refused { _ = try await cold.start() }
            await refused { _ = try await cold.recoverProjectFileAdd(requestId: id) }
            XCTAssertEqual(try Data(contentsOf: journal), exactJournal); XCTAssertEqual(try inode(journal), journalIdentity)
            XCTAssertEqual(try projectRows(), rows); XCTAssertEqual(try otherRows(), others)
            XCTAssertEqual(try inode(file), identity); XCTAssertEqual(try Data(contentsOf: file), bytes)
            XCTAssertEqual(try Data(contentsOf: borrowed), bytes); XCTAssertEqual(try Data(contentsOf: picked), bytes)
            XCTAssertEqual(try hashMarkers(), 0); try assertNoTaskOwner(); await cold.close()
        }
    }

}
