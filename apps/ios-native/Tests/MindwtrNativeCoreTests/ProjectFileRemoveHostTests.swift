import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class ProjectFileRemoveHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private let projectID = "file-remove-project"
    private let at = "2026-10-06T12:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task281-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func rows(_ table: String) throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM \(table) ORDER BY \(table == "calendar_sync" ? "task_id,platform" : "id")").utf8))) }
    private func sibling() throws -> String { try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects WHERE id='sibling-project'").utf8))) }
    private func otherRows() throws -> [String] { try ["tasks", "sections", "areas", "people", "settings", "saved_filters", "calendar_sync"].map(rows) }
    private func project() throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM projects WHERE id=?", [projectID]).utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first)
    }
    private func stored() throws -> [[String: Any]] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(project()["attachments"] as? String).utf8)) as? [[String: Any]]) }
    private func item(_ id: String, uri: String) -> [String: Any] {
        ["id": id, "kind": "file", "title": "Private file", "uri": uri, "mimeType": "text/plain", "size": 5,
         "cloudKey": "attachments/retained", "contentRev": 7, "fileHash": "retained-hash", "localStatus": "available",
         "createdAt": at, "updatedAt": at]
    }
    private func seed(_ attachments: [[String: Any]], status: String = "active") async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        // Match the existing writer's defaults so exact preservation checks do
        // not mistake first-save hydration of incomplete SQL fixtures for Remove.
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Preserved Project',?,'#94a3b8','Preserved notes',1,'[]',0,0,?,?,?,1,'fixture')",
            [projectID, status, try json(attachments), at, at])
        _ = try sql("INSERT INTO projects(id,title,status,color,supportNotes,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,rev,revBy) VALUES ('sibling-project','Sibling','waiting','#123456','Sibling notes',2,'[]',0,0,NULL,?,?,4,'fixture')", [at, at])
        _ = try sql("INSERT INTO tasks(id,title,status,taskMode,projectId,contexts,tags,attachments,checklist,showFutureRecurrence,pushCount,isFocusedToday,suppressMindwtrReminders,createdAt,updatedAt,rev,revBy) VALUES ('sibling-task','Preserved task','next','list',?,'[]','[]',NULL,NULL,0,0,0,0,?,?,2,'fixture')", [projectID, at, at])
    }
    private func request(_ host: CoreHost, id: String, project: String? = nil) async throws -> [String: Any] {
        let idProject = project ?? projectID
        let options = try object(await host.call("projectAttachmentEditOptions", argumentsJSON: json([json(["projectId": idProject])])))
        let token = try XCTUnwrap(options["project"] as? [String: Any])
        return ["requestId": UUID().uuidString.lowercased(), "projectId": idProject,
                "intent": ["kind": "remove", "attachmentId": id], "expected": token.filter { $0.key != "id" }]
    }
    private func remove(_ host: CoreHost, _ request: [String: Any], method: String = "projectFileRemoveWrite") async throws -> [String: Any] {
        try object(await host.call(method, argumentsJSON: json([json(request)])))
    }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture identity unavailable") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func markers() throws -> Int {
        let log = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: log.path) else { return 0 }
        return try String(contentsOf: log).components(separatedBy: "v1.3.5/ios-project-file-remove").count - 1
    }
    private func refused(_ expected: String? = nil, file: StaticString = #filePath, line: UInt = #line, _ operation: () async throws -> Void) async {
        do { try await operation(); XCTFail("Expected safe refusal", file: file, line: line) }
        catch {
            if let expected { XCTAssertTrue(error.localizedDescription.contains(expected), "Unexpected refusal: \(error.localizedDescription)", file: file, line: line) }
            XCTAssertFalse(error.localizedDescription.contains("Private file"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
        }
    }
    private func assertUnchangedFields(_ before: [String: Any], _ after: [String: Any], excluding: Set<String>, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(Set(before.keys), Set(after.keys), file: file, line: line)
        for (name, value) in before where !excluding.contains(name) {
            XCTAssertEqual(try json([value]), try json([after[name] ?? NSNull()]), name, file: file, line: line)
        }
    }

    func testCurrentMissingForeignAndCloudFilesTombstoneWithoutFileWorkOrOtherRowChanges() async throws {
        let local = managed.appendingPathComponent("current.txt"), outside = root.appendingPathComponent("foreign.txt"), bytes = Data("retained bytes".utf8)
        var cloud = item("cloud", uri: ""); cloud["localStatus"] = "missing"
        let attachments = [item("current", uri: local.absoluteString), item("missing", uri: managed.appendingPathComponent("missing.txt").absoluteString), item("foreign", uri: outside.absoluteString), cloud]
        try await seed(attachments); try bytes.write(to: local); try bytes.write(to: outside)
        let hooks = NativeAttachmentHostHooks(); var work = 0
        hooks.configureJobs = { jobs in jobs.beforeWork = { _, _ in work += 1 } }
        let host = core(); try await host.configureAttachmentHost(hooks); _ = try await host.start()
        let beforeOther = try otherRows(), siblingBefore = try sibling(), identities = try [local, outside].map(inode)
        let before = try project()
        for id in ["current", "missing", "foreign", "cloud"] {
            let result = try await remove(host, request(host, id: id))
            XCTAssertEqual(result["id"] as? String, projectID); XCTAssertEqual(result["attachmentIds"] as? [String], [id])
        }
        let after = try project(), tombstones = try stored()
        try assertUnchangedFields(before, after, excluding: ["attachments", "rev", "revBy", "updatedAt"])
        XCTAssertEqual(after["rev"] as? Int, (before["rev"] as? Int ?? 0) + 4)
        XCTAssertEqual(tombstones.count, attachments.count)
        for index in attachments.indices {
            try assertUnchangedFields(attachments[index], tombstones[index].filter { $0.key != "deletedAt" }, excluding: ["updatedAt"])
            XCTAssertNotNil(tombstones[index]["deletedAt"] as? String)
        }
        XCTAssertEqual(work, 0); XCTAssertEqual(try [local, outside].map(inode), identities)
        XCTAssertEqual(try [local, outside].map { try Data(contentsOf: $0) }, [bytes, bytes])
        XCTAssertEqual(try otherRows(), beforeOther); XCTAssertEqual(try sibling(), siblingBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 4)
        XCTAssertNil(try NativeAttachmentDraftStore(databaseURL: database).readMixed()); XCTAssertNil(try EditorDraftStore(databaseURL: database).read())
    }

    func testFailedCommitColdReplayUsesExactVersionTwoIntentAndPreservesBytes() async throws {
        let file = managed.appendingPathComponent("current.txt"), bytes = Data("retained bytes".utf8), attachment = item("current", uri: file.absoluteString)
        try await seed([attachment]); try bytes.write(to: file)
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current"), before = try project(), beforeOther = try otherRows(), identity = try inode(file)
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Project file COMMIT failure") } }
        await refused("SAVE_FAILED") { _ = try await self.remove(host, input) }
        XCTAssertEqual(try json(project()), try json(before)); XCTAssertEqual(try otherRows(), beforeOther); XCTAssertEqual(try markers(), 0)
        let pending = try object(String(contentsOf: journal))
        XCTAssertEqual(pending["version"] as? Int, 2); XCTAssertEqual(pending["method"] as? String, "projectFileRemoveWriteCommit")
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
        let envelope = try object(XCTUnwrap(args.first)), prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        XCTAssertEqual(prepared["version"] as? Int, 2); XCTAssertEqual(try json(XCTUnwrap(envelope["request"])), try json(input))
        await host.close()
        let cold = core(), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "projectFileRemoveWriteCommit")
        XCTAssertEqual((recovery["result"] as? [String: Any])?["attachmentIds"] as? [String], ["current"])
        let after = try project()
        XCTAssertEqual(after["rev"] as? Int, (before["rev"] as? Int ?? 0) + 1)
        XCTAssertEqual(try otherRows(), beforeOther); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 1)
        await refused("STALE_REVISION") { _ = try await self.remove(cold, input) }
        await cold.close(); let again = core(); let second = try object(await again.start())
        XCTAssertNil(second["recovery"]); XCTAssertEqual(try json(project()), try json(after))
    }

    func testFailedInitialJournalWriteDoesNotMutateAndWarmRetryUsesOwedRequest() async throws {
        let attachment = item("current", uri: "file:///unavailable-source.txt")
        try await seed([attachment]); let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current"), before = try project(), beforeOther = try otherRows()
        var attempts = 0
        faults.journalWrite = { attempts += 1; if attempts == 1 { throw HostFailure("Injected Project intent write failure") } }
        await refused("intent write failure") { _ = try await self.remove(host, input) }
        XCTAssertEqual(attempts, 1); XCTAssertEqual(try json(project()), try json(before)); XCTAssertEqual(try otherRows(), beforeOther)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 0)
        let reply = try await host.retryPending(), result = try object(XCTUnwrap(reply))
        XCTAssertEqual(result["id"] as? String, projectID); XCTAssertEqual(result["attachmentIds"] as? [String], ["current"])
        XCTAssertEqual(try project()["rev"] as? Int, (before["rev"] as? Int ?? 0) + 1)
        XCTAssertEqual(try otherRows(), beforeOther); XCTAssertEqual(try markers(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testCommittedLostTerminalWriteColdReplayAcknowledgesExactAfterWithoutAnotherProjectWrite() async throws {
        let file = managed.appendingPathComponent("current.txt"), bytes = Data("retained bytes".utf8)
        try await seed([item("current", uri: file.absoluteString)]); try bytes.write(to: file)
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current"), beforeOther = try otherRows(), identity = try inode(file)
        var writes = 0
        faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected Project terminal write failure") } }
        await refused("terminal write failure") { _ = try await self.remove(host, input) }
        XCTAssertEqual(writes, 2); XCTAssertEqual(try markers(), 0)
        let after = try project(), pending = try object(String(contentsOf: journal))
        XCTAssertNil(pending["terminal"])
        let originalArguments = try XCTUnwrap(pending["argumentsJSON"] as? String)
        await host.close()
        let replayFaults = HostIOFaults(); var projectWrites = 0
        replayFaults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+projects\b"#, options: .regularExpression) != nil { projectWrites += 1 } }
        let cold = core(replayFaults), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "projectFileRemoveWriteCommit")
        XCTAssertEqual(projectWrites, 0); XCTAssertEqual(try json(project()), try json(after)); XCTAssertEqual(try otherRows(), beforeOther)
        XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertEqual(try inode(file), identity)
        XCTAssertEqual(try markers(), 1); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let envelope = try object(XCTUnwrap((try NativeJSON.jsonObject(with: Data(originalArguments.utf8)) as? [String])?.first))
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        XCTAssertEqual(try stored().first?["deletedAt"] as? String, prepared["updateAt"] as? String)
        await refused("STALE_REVISION") { _ = try await self.remove(cold, input, method: "projectFileRemoveWriteRetryOutcome") }
    }

    func testTerminalClearFailureColdRecoveryClearsWithoutProjectWriteAndOnlyThenLogs() async throws {
        try await seed([item("current", uri: "file:///unavailable-source.txt")])
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current")
        faults.journalRemove = { throw HostFailure("Injected Project terminal clear failure") }
        await refused("terminal clear failure") { _ = try await self.remove(host, input) }
        let pending = try object(String(contentsOf: journal)), after = try project(), beforeOther = try otherRows()
        XCTAssertNotNil(pending["terminal"]); XCTAssertEqual(try markers(), 0)
        await host.close()
        let replayFaults = HostIOFaults(); var projectWrites = 0
        replayFaults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+projects\b"#, options: .regularExpression) != nil { projectWrites += 1 } }
        let cold = core(replayFaults), startup = try object(await cold.start())
        XCTAssertEqual((startup["recovery"] as? [String: Any])?["method"] as? String, "projectFileRemoveWriteCommit")
        XCTAssertEqual(projectWrites, 0); XCTAssertEqual(try json(project()), try json(after)); XCTAssertEqual(try otherRows(), beforeOther)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 1)
    }

    func testUnknownCommittedOutcomeRefusesInterveningWholeRowAndRetainsFrozenRequest() async throws {
        try await seed([item("current", uri: "file:///unavailable-source.txt")])
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current"); var writes = 0
        faults.journalWrite = { writes += 1; if writes == 2 { throw HostFailure("Injected Project terminal write failure") } }
        await refused("terminal write failure") { _ = try await self.remove(host, input) }
        let pending = try object(String(contentsOf: journal)); await host.close()
        _ = try sql("UPDATE projects SET title='Intervening Project edit',rev=rev+1 WHERE id=?", [projectID])
        let current = try rows("projects"), beforeOther = try otherRows(), replayFaults = HostIOFaults(); var mutations = 0
        replayFaults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:projects|tasks|sections|areas|people|settings|saved_filters|calendar_sync)\b"#, options: .regularExpression) != nil { mutations += 1 } }
        let cold = core(replayFaults)
        await refused("STALE_REVISION") { _ = try await cold.start() }
        XCTAssertEqual(mutations, 0); XCTAssertEqual(try rows("projects"), current); XCTAssertEqual(try otherRows(), beforeOther)
        let retained = try object(String(contentsOf: journal))
        XCTAssertEqual(try json(retained), try json(pending)); XCTAssertEqual(retained["argumentsJSON"] as? String, pending["argumentsJSON"] as? String)
        XCTAssertEqual(try markers(), 0)
    }

    func testWaitingAndSomedayProjectsUseTheSameMetadataOnlyWrite() async throws {
        let attachment = item("current", uri: "file:///unavailable-source.txt")
        try await seed([attachment], status: "waiting")
        for status in ["waiting", "someday"] {
            _ = try sql("UPDATE projects SET status=?,attachments=? WHERE id=?", [status, try json([attachment]), projectID])
            let host = core(); _ = try await host.start(); let before = try project()
            let result = try await remove(host, request(host, id: "current"))
            XCTAssertEqual(result["attachmentIds"] as? [String], ["current"])
            try assertUnchangedFields(before, project(), excluding: ["attachments", "rev", "revBy", "updatedAt"])
            XCTAssertNotNil(try stored().first?["deletedAt"] as? String); await host.close()
        }
    }

    func testNoopArchivedWrongKindStaleAndMalformedRequestsNeverJournalOrWrite() async throws {
        let file = item("current", uri: "file:///unavailable-source.txt")
        let link: [String: Any] = ["id": "link", "kind": "link", "title": "Existing link", "uri": "https://example.invalid", "createdAt": at, "updatedAt": at]
        var deleted = file; deleted["id"] = "deleted"; deleted["deletedAt"] = at
        try await seed([file, link, deleted])
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let baseline = try rows("projects"), beforeOther = try otherRows(); var writes = 0, journals = 0
        faults.journalWrite = { journals += 1 }
        faults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:projects|tasks|sections|areas|people|settings|saved_filters|calendar_sync)\b"#, options: .regularExpression) != nil { writes += 1 } }
        for id in ["unknown", "deleted"] {
            let result = try await remove(host, request(host, id: id)); XCTAssertEqual(result["attachmentIds"] as? [String], [])
        }
        let removeFile = try await request(host, id: "current"), removeLink = try await request(host, id: "link")
        await refused("INVALID_INPUT") { _ = try await self.remove(host, removeLink) }
        await refused("INVALID_INPUT") { _ = try await self.remove(host, removeFile, method: "projectAttachmentWrite") }
        var stale = removeFile, expected = try XCTUnwrap(removeFile["expected"] as? [String: Any]); expected["title"] = "Stale title"; stale["expected"] = expected
        await refused("STALE_REVISION") { _ = try await self.remove(host, stale) }
        var add = removeFile; add["intent"] = ["kind": "add", "text": "https://example.invalid"]
        var extra = removeFile; extra["extra"] = "private-input"
        var badID = removeFile; badID["requestId"] = NSNull()
        for input in [add, extra, badID] { await refused("INVALID_INPUT") { _ = try await self.remove(host, input) } }
        XCTAssertEqual(writes, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try rows("projects"), baseline); XCTAssertEqual(try otherRows(), beforeOther)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 0)
        await host.close()
        _ = try sql("UPDATE projects SET status='archived' WHERE id=?", [projectID])
        let archived = core()
        _ = try await archived.start(); let archivedBefore = try rows("projects")
        let result = try await remove(archived, request(archived, id: "current"))
        XCTAssertEqual(result["blocked"] as? String, ""); XCTAssertEqual(try rows("projects"), archivedBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers(), 0)
    }

    func testDeletedAndPurgedProjectsCannotUseCapturedLiveRemoveRequest() async throws {
        try await seed([item("current", uri: "file:///unavailable-source.txt")])
        let initial = core(); _ = try await initial.start(); let input = try await request(initial, id: "current"); await initial.close()
        for field in ["deletedAt", "purgedAt"] {
            _ = try sql("UPDATE projects SET deletedAt=NULL,purgedAt=NULL WHERE id=?", [projectID])
            _ = try sql("UPDATE projects SET \(field)=? WHERE id=?", [at, projectID])
            let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
            let before = try rows("projects"), beforeOther = try otherRows(); var journals = 0, writes = 0
            faults.journalWrite = { journals += 1 }
            faults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:projects|tasks|sections|areas|people|settings|saved_filters|calendar_sync)\b"#, options: .regularExpression) != nil { writes += 1 } }
            await refused("STALE_REVISION") { _ = try await self.remove(host, input) }
            XCTAssertEqual(journals, 0); XCTAssertEqual(writes, 0)
            XCTAssertEqual(try rows("projects"), before); XCTAssertEqual(try otherRows(), beforeOther)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await host.close()
        }
        XCTAssertEqual(try markers(), 0)
    }

    func testHistoricalLinkRemovalRemainsVersionOneAndRetainsFileMetadata() async throws {
        let file = item("current", uri: "file:///unavailable-source.txt")
        let link: [String: Any] = ["id": "link", "kind": "link", "title": "Existing link", "uri": "https://example.invalid", "createdAt": at, "updatedAt": at]
        try await seed([file, link]); let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "link"), beforeOther = try otherRows()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected historical link COMMIT failure") } }
        await refused("SAVE_FAILED") { _ = try await self.remove(host, input, method: "projectAttachmentWrite") }
        let pending = try object(String(contentsOf: journal))
        XCTAssertEqual(pending["method"] as? String, "projectAttachmentWriteCommit")
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
        XCTAssertEqual((try object(XCTUnwrap(args.first))["prepared"] as? [String: Any])?["version"] as? Int, 1)
        await host.close(); let cold = core(); _ = try await cold.start()
        XCTAssertEqual(try json(XCTUnwrap(stored().first)), try json(file)); XCTAssertNotNil(try stored().last?["deletedAt"] as? String)
        XCTAssertEqual(try otherRows(), beforeOther); XCTAssertEqual(try markers(), 0)
    }

    func testForgedVersionEffectAndTerminalJournalsRefuseBeforeSQLAndRemainExact() async throws {
        try await seed([item("current", uri: "file:///unavailable-source.txt")])
        let faults = HostIOFaults(), host = core(faults); _ = try await host.start()
        let input = try await request(host, id: "current")
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected Project pending COMMIT failure") } }
        await refused("SAVE_FAILED") { _ = try await self.remove(host, input) }
        let pending = try object(String(contentsOf: journal)), args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
        let envelope = try object(XCTUnwrap(args.first)); await host.close()
        for corruption in ["version", "historical-method", "effect", "terminal"] {
            var forged = pending, value = envelope, prepared = try XCTUnwrap(value["prepared"] as? [String: Any])
            if corruption == "version" { prepared["version"] = 1 }
            else if corruption == "historical-method" { forged["method"] = "projectAttachmentWriteCommit" }
            else if corruption == "effect" {
                var effect = try XCTUnwrap(prepared["effect"] as? [String: Any]), pair = try XCTUnwrap(effect["project"] as? [String: Any]), after = try XCTUnwrap(pair["after"] as? [String: Any])
                after["title"] = "Forged Project edit"; pair["after"] = after; effect["project"] = pair; prepared["effect"] = effect
            } else { forged["terminal"] = ["success": ["_0": try json(["id": projectID, "attachmentIds": ["forged"]])]] }
            value["prepared"] = prepared; forged["argumentsJSON"] = try json([json(value)])
            let bytes = Data(try json(forged).utf8); try bytes.write(to: journal)
            let blockedFaults = HostIOFaults(); var statements = 0, removals = 0
            blockedFaults.beforeSQL = { _ in statements += 1 }; blockedFaults.journalRemove = { removals += 1 }
            let blocked = core(blockedFaults)
            await refused { _ = try await blocked.start() }
            XCTAssertEqual(statements, 0, corruption); XCTAssertEqual(removals, 0, corruption)
            XCTAssertEqual(try Data(contentsOf: journal), bytes, corruption); await blocked.close()
        }
    }
}
