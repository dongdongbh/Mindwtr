import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class CleanupOwnedJobs: @unchecked Sendable {
    private let lock = NSLock()
    private var value: NativeAttachmentFileJobs?
    private var count = 0
    func set(_ jobs: NativeAttachmentFileJobs) { lock.lock(); value = jobs; lock.unlock() }
    func record() { lock.lock(); count += 1; lock.unlock() }
    var submitted: Int { lock.lock(); defer { lock.unlock() }; return count }
    var jobs: NativeAttachmentFileJobs? { lock.lock(); defer { lock.unlock() }; return value }
}

final class NativeAttachmentCleanupOwnedTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let at = "2026-10-06T12:00:00.000Z"
    private let taskID = UUID().uuidString.lowercased(), attachmentID = UUID().uuidString.lowercased()
    private let bytes = Data("Synthetic original cleanup generation".utf8)
    private let fixedFailure = "Attachment cleanup could not be confirmed; retry the retained request"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var target: URL { managed.appendingPathComponent(attachmentID + ".txt") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build the production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Configured cleanup bundle is unavailable") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let fixture = base.appendingPathComponent("NativeAttachmentCleanupOwnedTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw HostFailure("Cleanup fixture root is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func quoted(_ text: String) throws -> String {
        String(try json([text]).dropFirst().dropLast())
    }
    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    private func core(faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundleURL ?? bundle, faults: faults)
        addTeardownBlock { await value.close() }; return value
    }
    private func attachment(id: String? = nil, uri: String? = nil, deleted: Bool = true) -> [String: Any] {
        var row: [String: Any] = ["id": id ?? attachmentID, "kind": "file", "uri": uri ?? target.absoluteString,
            "title": "Private synthetic cleanup title", "localStatus": "available", "createdAt": at, "updatedAt": at]
        if deleted { row["deletedAt"] = at }; return row
    }
    private func request(id: String = UUID().uuidString.lowercased(), uri: String? = nil) throws -> String {
        try json(["version": 1, "requestID": id, "attachmentID": attachmentID, "targetURI": uri ?? target.absoluteString])
    }
    private func seed() async throws {
        let initial = core(); _ = try await initial.start(); await initial.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        _ = try sql.execute("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,'Synthetic cleanup task','inbox','[]','[]',?,?,?,1,'fixture',0,0,0,0)",
            parametersJSON: json([taskID, try json([attachment()]), at, at]))
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        try bytes.write(to: target)
    }
    private func enterCase(_ name: String, below base: URL) throws {
        root = base.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    private func assertFailure(_ work: () async throws -> String, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await work(); XCTFail("Uncertain ownership must refuse", file: file, line: line) }
        catch { XCTAssertEqual(error.localizedDescription, fixedFailure, file: file, line: line) }
    }
    private func assertReply(_ text: String, request: String, outcome: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let result = try object(text), input = try object(request)
        XCTAssertEqual(Set(result.keys), Set(["version", "requestID", "outcome"]), file: file, line: line)
        XCTAssertEqual(result["version"] as? Int, 1, file: file, line: line)
        XCTAssertEqual(result["requestID"] as? String, input["requestID"] as? String, file: file, line: line)
        XCTAssertEqual(result["outcome"] as? String, outcome, file: file, line: line)
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
            let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try raw.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func inode(_ url: URL) throws -> ino_t {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture inode is unavailable") }; return value.st_ino
    }
    private func markers() throws -> [[String: Any]] {
        let file = root.appendingPathComponent("logs/mindwtr.log")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        return try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
            .filter { $0.contains("v1.3.5/ios-cleanup-owned-retirement") }.map { try object(String($0)) }
    }
    private func intentFault(_ name: String = "afterIntent") -> HostIOFaults {
        let faults = HostIOFaults(); var fired = false
        faults.cleanupBoundary = { boundary in
            if !fired && boundary == name { fired = true; throw HostFailure("Synthetic cleanup interruption") }
        }
        return faults
    }

    func testSuccessReopenAndInitialAbsenceNeverPersistMetadataOrNewAuthority() async throws {
        try await seed()
        let value = core(); _ = try await value.start(); let before = try rows(), input = try request()
        try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try rows(), before); await value.close()
        let cold = core(); _ = try await cold.start()
        XCTAssertEqual(try rows(), before)
        let absentInput = try request()
        try assertReply(await cold.retireAttachmentCleanup(absentInput), request: absentInput, outcome: "retained")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows(), before); await cold.close()
        let entries = try markers(); XCTAssertEqual(entries.count, 1)
        let marker = try XCTUnwrap(entries.first)
        XCTAssertEqual(marker["context"] as? [String: String], ["releaseCheck": "v1.3.5/ios-cleanup-owned-retirement", "operation": "cleanup-owned-retirement", "outcome": "removed"])
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        for secret in [taskID, attachmentID, target.absoluteString, "Private synthetic cleanup title"] { XCTAssertFalse(log.contains(secret)) }
    }

    func testExactWarmRetryAtIntentRetirementTerminalAndLostClearBoundaries() async throws {
        let base = root!; defer { root = base }
        for boundary in ["beforeIntent", "afterIntent", "beforeRetirement", "afterRetirement", "beforeTerminal", "afterTerminal", "beforeClear", "afterClear"] {
            try enterCase(boundary, below: base); try await seed()
            let value = core(faults: intentFault(boundary)); _ = try await value.start()
            let before = try rows(), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            let hasBytes = ["beforeIntent", "afterIntent", "beforeRetirement"].contains(boundary)
            XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), hasBytes, boundary)
            await assertFailure { try await value.retireAttachmentCleanup(self.request()) }
            await assertFailure { try await value.call("complete", argumentsJSON: self.json([self.taskID])) }
            do { _ = try await value.retryPending(); XCTFail("Generic retry cannot impersonate cleanup") } catch { XCTAssertEqual(error.localizedDescription, fixedFailure) }
            XCTAssertEqual(try markers().count, 0)
            let expected = ["afterRetirement", "beforeTerminal"].contains(boundary) ? "absent" : "removed"
            try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: expected)
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
            let cold = core(); _ = try await cold.start(); XCTAssertEqual(try rows(), before); await cold.close()
        }
    }

    func testColdRecoveryUsesOriginalIntentAndTerminalOnlyClears() async throws {
        let base = root!; defer { root = base }
        for boundary in ["afterIntent", "beforeRetirement", "afterRetirement", "beforeTerminal", "afterTerminal", "beforeClear"] {
            try enterCase(boundary, below: base); try await seed()
            let value = core(faults: intentFault(boundary)); _ = try await value.start()
            let before = try rows(), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }; await value.close()
            let frozen = try Data(contentsOf: journal), counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
            // A recreated generation appearing after a terminal must never be
            // captured or unlinked by terminal recovery.
            let terminal = ["afterTerminal", "beforeClear"].contains(boundary)
            if terminal { try bytes.write(to: target) }
            let cold = core(); try await cold.configureAttachmentHost(hooks); _ = try await cold.start()
            XCTAssertEqual(counter.submitted, terminal ? 0 : 1, "Cold recovery never recaptures the baseline")
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), terminal)
            if terminal { XCTAssertEqual(try Data(contentsOf: target), bytes) }
            XCTAssertFalse(frozen.isEmpty); await cold.close()
        }
    }

    func testUnlinkAndDirectorySyncInterruptionsRetainExactIntentUntilAcknowledged() async throws {
        let base = root!; defer { root = base }
        for point in ["beforeUnlink", "afterUnlink", "beforeSync"] {
            try enterCase(point, below: base); try await seed()
            let captured = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks(); var fired = false
            let failure: () throws -> Void = { if !fired { fired = true; throw HostFailure("Synthetic physical interruption") } }
            hooks.configureJobs = { jobs in
                captured.set(jobs)
                if point == "beforeUnlink" { jobs.beforeRetirementUnlink = failure }
                if point == "afterUnlink" { jobs.afterRetirementUnlink = failure }
                if point == "beforeSync" { jobs.beforeRetirementSync = failure }
            }
            let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
            let before = try rows(), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            let intent = try Data(contentsOf: journal)
            XCTAssertNil(try object(String(decoding: intent, as: UTF8.self))["terminal"])
            XCTAssertEqual(captured.jobs?.counters.jobs, 0); XCTAssertEqual(try markers().count, 0)
            XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), point == "beforeUnlink")
            try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: point == "beforeUnlink" ? "removed" : "absent")
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
        }
    }


    func testJournalInodeReplacementAtPhysicalBoundariesCannotAuthorizeTerminalSuccess() async throws {
        let base = root!; defer { root = base }
        for point in ["beforeUnlink", "afterUnlink", "beforeSync"] {
            try enterCase(point, below: base); try await seed()
            let parked = root.appendingPathComponent("original-intent.json"), hooks = NativeAttachmentHostHooks()
            var fired = false
            let replace: () throws -> Void = {
                guard !fired else { return }; fired = true
                let original = try Data(contentsOf: self.journal)
                try FileManager.default.moveItem(at: self.journal, to: parked)
                try original.write(to: self.journal)
                XCTAssertNotEqual(try self.inode(parked), try self.inode(self.journal))
            }
            hooks.configureJobs = { jobs in
                if point == "beforeUnlink" { jobs.beforeRetirementUnlink = replace }
                if point == "afterUnlink" { jobs.afterRetirementUnlink = replace }
                if point == "beforeSync" { jobs.beforeRetirementSync = replace }
            }
            let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
            let before = try rows(), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), point == "beforeUnlink")
            XCTAssertNil(try object(String(decoding: Data(contentsOf: parked), as: UTF8.self))["terminal"])
            XCTAssertEqual(try markers().count, 0)
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            // Teardown releases the uncertain transaction. Restore the parked
            // fixture before cold load, which validates its current journal
            // binding; inode identity is captured per runtime, not persisted.
            await value.close()
            try FileManager.default.removeItem(at: journal)
            try FileManager.default.moveItem(at: parked, to: journal)
            let cold = core(); _ = try await cold.start()
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); await cold.close()
        }
    }

    func testOriginalProofRetainsNewInodeChangedContentAndUnsafeEntries() async throws {
        let base = root!; defer { root = base }
        for change in ["sameBytesNewInode", "sameInodeChangedHash", "symlink", "hardlink"] {
            try enterCase(change, below: base); try await seed()
            let value = core(faults: intentFault()); _ = try await value.start()
            let before = try rows(), original = try inode(target), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            let outside = root.appendingPathComponent("unowned.txt")
            if change == "sameBytesNewInode" {
                try bytes.write(to: target, options: .atomic); XCTAssertNotEqual(try inode(target), original)
            } else if change == "sameInodeChangedHash" {
                let changed = Data(repeating: 88, count: bytes.count)
                try changed.write(to: target); XCTAssertEqual(try inode(target), original)
            } else {
                try bytes.write(to: outside); try FileManager.default.removeItem(at: target)
                if change == "symlink" { try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside) }
                else { try FileManager.default.linkItem(at: outside, to: target) }
            }
            let currentBytes = try Data(contentsOf: target), currentInode = try inode(target)
            try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "retained")
            XCTAssertEqual(try Data(contentsOf: target), currentBytes); XCTAssertEqual(try inode(target), currentInode)
            if FileManager.default.fileExists(atPath: outside.path) { XCTAssertEqual(try Data(contentsOf: outside), bytes) }
            XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
        }
    }

    func testOriginalParentSwapRefusesWithoutAdoptingReplacementDirectory() async throws {
        try await seed(); let value = core(faults: intentFault()); _ = try await value.start()
        let before = try rows(), input = try request(), parentInode = try inode(managed)
        await assertFailure { try await value.retireAttachmentCleanup(input) }
        let parked = managed.deletingLastPathComponent().appendingPathComponent("original-attachments")
        try FileManager.default.moveItem(at: managed, to: parked)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)
        try bytes.write(to: target); XCTAssertNotEqual(try inode(managed), parentInode)
        await assertFailure { try await value.retireAttachmentCleanup(input) }
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: parked.appendingPathComponent(target.lastPathComponent)), bytes)
        XCTAssertNil(try object(String(decoding: Data(contentsOf: journal), as: UTF8.self))["terminal"])
        await value.close()
        try FileManager.default.removeItem(at: managed); try FileManager.default.moveItem(at: parked, to: managed)
        let cold = core(); _ = try await cold.start()
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); await cold.close()
    }

    func testFreshDurableRestorationAndLiveProjectAliasOverrideStaleWarmStore() async throws {
        let base = root!; defer { root = base }
        for change in ["restored", "liveProjectAlias"] {
            try enterCase(change, below: base); try await seed()
            let value = core(faults: intentFault()); _ = try await value.start(); let input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            let sql = try SQLiteBridge(url: database)
            if change == "restored" {
                _ = try sql.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([try json([attachment(deleted: false)]), taskID]))
            } else {
                let aliasPath: String
                if target.path.hasPrefix("/private/var/") { aliasPath = String(target.path.dropFirst("/private".count)) }
                else if target.path.hasPrefix("/var/") { aliasPath = "/private" + target.path }
                else { aliasPath = target.path }
                let alias = URL(fileURLWithPath: aliasPath)
                // An actual iPhone has distinct /var and /private/var spellings;
                // the Mac fixture can use its one ordinary spelling.
                XCTAssertEqual(try Data(contentsOf: alias), bytes)
                var a = stat(), b = stat()
                XCTAssertEqual(Darwin.lstat(target.path, &a), 0); XCTAssertEqual(Darwin.lstat(alias.path, &b), 0)
                XCTAssertEqual(a.st_dev, b.st_dev); XCTAssertEqual(a.st_ino, b.st_ino)
                #if os(iOS)
                XCTAssertNotEqual(alias.absoluteString, target.absoluteString)
                #endif
                _ = try sql.execute("INSERT INTO projects(id,title,status,color,attachments,createdAt,updatedAt,rev,revBy,deletedAt) VALUES (?,'Synthetic live reference','active','#123456',?,?,?,1,'fixture',?)",
                    parametersJSON: json([UUID().uuidString.lowercased(), try json([attachment(id: UUID().uuidString.lowercased(), uri: alias.absoluteString, deleted: false)]), at, at, at]))
            }
            sql.close(); let changed = try rows()
            try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "retained")
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), changed)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
        }
    }

    func testBeginImmediateExcludesExternalWriterThroughPhysicalUnlink() async throws {
        try await seed()
        let reached = expectation(description: "Physical unlink entered"), release = DispatchSemaphore(value: 0)
        let hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in jobs.beforeRetirementUnlink = {
            reached.fulfill()
            guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Fixture barrier timed out") }
        } }
        let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
        let before = try rows(), input = try request()
        let work = Task { try await value.retireAttachmentCleanup(input) }; defer { release.signal() }
        await fulfillment(of: [reached], timeout: 10)
        let other = try SQLiteBridge(url: database); defer { other.close() }
        _ = try other.execute("PRAGMA busy_timeout=0")
        do { _ = try other.execute("UPDATE tasks SET title='Forbidden external writer' WHERE id=?", parametersJSON: json([taskID])); XCTFail("External writer must be excluded") }
        catch { XCTAssertTrue(["SQLite step failed (5)", "SQLite step failed (6)"].contains(error.localizedDescription), "Native SQLite BUSY/LOCKED status must exclude the writer") }
        XCTAssertEqual(try rows(), before)
        release.signal(); try assertReply(await work.value, request: input, outcome: "removed")
        _ = try other.execute("BEGIN IMMEDIATE"); _ = try other.execute("ROLLBACK")
        XCTAssertEqual(try rows(), before); await value.close()
    }

    func testInvalidBoundedJournalsMissingDatabaseAndIncompatibleSchemaRefuseBeforeTargetIO() async throws {
        let base = root!; defer { root = base }
        for invalid in ["outerVersion", "duplicateField", "escapedOuterField", "proofDuplicate", "requestDuplicate", "witnessDuplicate", "selectedDuplicate", "proofTarget", "witnessID", "witnessBound", "attachmentBound", "rejectedTerminal", "terminalID", "missingDatabase", "incompatibleSchema"] {
            try enterCase(invalid, below: base); try await seed()
            let value = core(faults: intentFault()); _ = try await value.start(); let input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }; await value.close()
            let original = try Data(contentsOf: journal); var before = try rows()
            var outer = try object(String(decoding: original, as: UTF8.self))
            var inner = try object(try XCTUnwrap(outer["argumentsJSON"] as? String))
            if invalid == "outerVersion" { outer["version"] = 3 }
            if invalid == "proofTarget" { var proof = try XCTUnwrap(inner["proof"] as? [String: Any]); proof["targetURI"] = root.appendingPathComponent("foreign.txt").absoluteString; inner["proof"] = proof }
            if ["witnessID", "witnessBound", "attachmentBound"].contains(invalid) {
                var witness = try object(try XCTUnwrap(inner["witnessJSON"] as? String))
                if invalid == "witnessID" { witness["attachmentID"] = "different" }
                if invalid == "witnessBound" { witness["parentPurgedAt"] = String(repeating: "a", count: 128 * 1024) }
                if invalid == "attachmentBound" { witness["attachmentJSON"] = String(repeating: "a", count: 64 * 1024 + 1) }
                inner["witnessJSON"] = try json(witness)
            }
            if invalid == "rejectedTerminal" { outer["terminal"] = ["rejected": ["_0": "Synthetic rejection"]] }
            if invalid == "terminalID" { outer["terminal"] = ["success": ["_0": try json(["version": 1, "requestID": UUID().uuidString.lowercased(), "outcome": "removed"])]] }
            if invalid == "requestDuplicate" {
                inner["requestJSON"] = "{\"version\":1," + String(try XCTUnwrap(inner["requestJSON"] as? String).dropFirst())
            }
            if invalid == "witnessDuplicate" || invalid == "selectedDuplicate" {
                let text = try XCTUnwrap(inner["witnessJSON"] as? String)
                if invalid == "witnessDuplicate" { inner["witnessJSON"] = "{\"version\":1," + String(text.dropFirst()) }
                else {
                    var witness = try object(text)
                    witness["attachmentJSON"] = "{\"id\":" + (try quoted(attachmentID)) + "," + String(try XCTUnwrap(witness["attachmentJSON"] as? String).dropFirst())
                    inner["witnessJSON"] = try json(witness)
                }
            }
            var innerJSON = try json(inner)
            if invalid == "proofDuplicate" {
                let proof = try XCTUnwrap(inner["proof"] as? [String: Any]), originalProof = try json(proof)
                let duplicate = "{\"\\u0073ha256\":" + (try quoted(XCTUnwrap(proof["sha256"] as? String))) + "," + String(originalProof.dropFirst())
                innerJSON = "{\"version\":1,\"requestJSON\":" + (try quoted(XCTUnwrap(inner["requestJSON"] as? String)))
                    + ",\"witnessJSON\":" + (try quoted(XCTUnwrap(inner["witnessJSON"] as? String))) + ",\"proof\":" + duplicate + "}"
            }
            outer["argumentsJSON"] = innerJSON
            var changed = try json(outer)
            if invalid == "duplicateField" || invalid == "escapedOuterField" {
                // Foundation intentionally tolerates duplicates. The fixture
                // adds the same decoded key/value; only cleanup's raw checker
                // must reject it, not an unknown-field or semantic mismatch.
                let key = invalid == "duplicateField" ? "version" : "\\u0076ersion"
                changed = "{\"" + key + "\":2," + String(changed.dropFirst())
                XCTAssertEqual(try object(changed)["version"] as? Int, 2)
            }
            if invalid == "missingDatabase" { try FileManager.default.moveItem(at: database, to: root.appendingPathComponent("original.sqlite")) }
            if invalid == "incompatibleSchema" {
                let sql = try SQLiteBridge(url: database); _ = try sql.execute("ALTER TABLE tasks RENAME COLUMN attachments TO unavailableAttachments"); sql.close(); before = try rows()
            }
            try Data(changed.utf8).write(to: journal)
            let retained = try Data(contentsOf: journal), counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
            let cold = core(); try await cold.configureAttachmentHost(hooks)
            do { _ = try await cold.start(); XCTFail("Invalid cleanup evidence must not enter normal boot: " + invalid) } catch { }
            XCTAssertEqual(counter.submitted, 0, invalid); XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(try Data(contentsOf: journal), retained); XCTAssertEqual(try markers().count, 0)
            if invalid == "missingDatabase" { XCTAssertFalse(FileManager.default.fileExists(atPath: database.path)) }
            else { XCTAssertEqual(try rows(), before) }
            await cold.close()
        }
    }

    func testProjectionRawTypeAndAggregateByteBoundRefuseBeforeFileSubmission() async throws {
        let base = root!; defer { root = base }
        for invalid in ["blob", "oversizedText"] {
            try enterCase(invalid, below: base); try await seed()
            let counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
            let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
            let sql = try SQLiteBridge(url: database)
            if invalid == "blob" { _ = try sql.execute("UPDATE tasks SET attachments=x'5B5D' WHERE id=?", parametersJSON: json([taskID])) }
            else {
                var large = attachment(); large["padding"] = String(repeating: "x", count: 8 * 1024 * 1024 + 1)
                // Valid JSON passes the real schema trigger, then the native
                // aggregate byte prepass must refuse before materialization.
                _ = try sql.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([try json([large]), taskID]))
            }
            sql.close(); let before = try rows(), input = try request()
            await assertFailure { try await value.retireAttachmentCleanup(input) }
            XCTAssertEqual(counter.submitted, 0); XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try rows(), before); await value.close()
        }
    }

    func testActualEditorCheckpointAndTaskSidecarDenyNewCleanupOwner() async throws {
        try await seed(); let counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
        let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
        let raw: [String: Any] = ["title": "", "note": "", "location": "", "estimate": "", "estimateResolved": "", "timeSpent": "", "timeSpentResolved": "",
            "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [], "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
            "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []]
        let payload: [String: Any] = ["version": 2, "taskID": taskID, "tab": "task", "touchedBase": [:], "edited": [:], "raw": raw,
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true, "attachmentsBase": [], "attachments": [], "linkSheet": [:]]
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: try json(payload))
        try await value.checkpointEditorDraft(snapshot)
        let editor = EditorDraftStore(databaseURL: database), editorBefore = try Data(contentsOf: editor.url), before = try rows()
        await assertFailure { try await value.retireAttachmentCleanup(self.request()) }
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore)
        _ = try await value.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1)
        let sidecar = NativeAttachmentDraftStore(databaseURL: database), sidecarBefore = try Data(contentsOf: sidecar.url)
        await assertFailure { try await value.retireAttachmentCleanup(self.request()) }
        XCTAssertEqual(try Data(contentsOf: sidecar.url), sidecarBefore); XCTAssertEqual(try Data(contentsOf: editor.url), editorBefore)
        XCTAssertEqual(counter.submitted, 0); XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
    }

    func testWarmAndColdCloseCancelRetirementAndDrainBeforeLibraryUnlock() async throws {
        let base = root!; defer { root = base }
        for mode in ["warm", "cold"] {
            try enterCase(mode, below: base); try await seed(); let input = try request()
            if mode == "cold" {
                let first = core(faults: intentFault()); _ = try await first.start()
                await assertFailure { try await first.retireAttachmentCleanup(input) }; await first.close()
            }
            let reached = expectation(description: mode + " retirement entered"), release = DispatchSemaphore(value: 0), capture = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in
                capture.set(jobs); jobs.beforeRetirementUnlink = {
                    reached.fulfill()
                    guard release.wait(timeout: .now() + 10) == .success else { throw HostFailure("Close fixture barrier timed out") }
                }
            }
            let value = core(); try await value.configureAttachmentHost(hooks)
            if mode == "warm" { _ = try await value.start() }
            let before = try rows()
            let operation = Task { mode == "warm" ? try await value.retireAttachmentCleanup(input) : try await value.start() }
            defer { release.signal() }
            await fulfillment(of: [reached], timeout: 10)
            let closeStarted = expectation(description: "Close entered")
            let closing = Task { closeStarted.fulfill(); await value.close() }
            await fulfillment(of: [closeStarted], timeout: 2)
            // close cancels the registry before enqueueing shutdown. Give the
            // already-running close task its synchronous entry before releasing IO.
            try await Task.sleep(nanoseconds: 100_000_000)
            release.signal(); await assertFailure { try await operation.value }; await closing.value
            XCTAssertEqual(capture.jobs?.counters.jobs, 0)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), before)
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0)
            let cold = core(); _ = try await cold.start()
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
            XCTAssertEqual(try rows(), before); await cold.close()
        }
    }

    func testDirectSharedGuardCannotUseOrdinarySQLOrRawFileBridges() async throws {
        try await seed(); let before = try rows()
        let suffix = """
        ;(function(){
          var host=globalThis.MindwtrHost, original=host.attachmentCleanupRetire;
          host.attachmentCleanupRetire=function(projection,witness,keep,retire){
            var native=globalThis.__mindwtrNative, uri=JSON.parse(witness).targetURI;
            var values=[native.sqlRun("UPDATE tasks SET title='Forbidden shared mutation'",'[]'),
              native.sqlExec("UPDATE tasks SET title='Forbidden shared mutation'"),
              native.sqlAll('SELECT id FROM tasks','[]'),
              native.fileCall(JSON.stringify({op:'readBytes',uri:uri})),
              native.fileCall(JSON.stringify({op:'delete',uri:uri})),native.fileDeleteNow(uri),
              native.installerCall('{}'),native.ioNext(),native.ioBody()];
            if(values.some(function(value){return typeof value!=='string'||value.indexOf('!MindwtrNativeError:')!==0;}))
              throw new Error('Synthetic cleanup isolation assertion');
            return original(projection,witness,keep,retire);
          };
        })();
        """
        let injected = root.appendingPathComponent("cleanup-isolation.js")
        try (String(contentsOf: bundle, encoding: .utf8) + suffix).write(to: injected, atomically: true, encoding: .utf8)
        let counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
        let value = core(bundleURL: injected); try await value.configureAttachmentHost(hooks); _ = try await value.start()
        let input = try request(); try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "removed")
        XCTAssertEqual(counter.submitted, 2, "Only native baseline observation and retirement are admitted")
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
    }


    func testAlreadyProcessedTaskAndProjectTombstonesGrantNoNewAuthority() async throws {
        let base = root!; defer { root = base }
        for owner in ["task", "project"] {
            try enterCase(owner, below: base); try await seed()
            let sql = try SQLiteBridge(url: database)
            var selected = attachment(); selected["localStatus"] = "missing"
            if owner == "task" {
                _ = try sql.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json([try json([selected]), taskID]))
            } else {
                _ = try sql.execute("UPDATE tasks SET attachments=NULL WHERE id=?", parametersJSON: json([taskID]))
                _ = try sql.execute("INSERT INTO projects(id,title,status,color,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Synthetic processed tombstone','active','#123456',?,?,?,1,'fixture')",
                    parametersJSON: json([UUID().uuidString.lowercased(), try json([selected]), at, at]))
            }
            sql.close()
            let counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
            let value = core(); try await value.configureAttachmentHost(hooks); _ = try await value.start()
            let before = try rows(), input = try request()
            try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "retained")
            XCTAssertEqual(counter.submitted, 0, "RN already-processed tombstone cannot grant fresh native proof")
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try rows(), before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try markers().count, 0); await value.close()
        }
    }

    func testActualOrdinaryPendingCommandKeepsItsSlotAndDeniesCleanup() async throws {
        try await seed()
        let counter = CleanupOwnedJobs(), hooks = NativeAttachmentHostHooks(), faults = HostIOFaults()
        hooks.configureJobs = { jobs in counter.set(jobs); jobs.beforeWork = { _, _ in counter.record() } }
        let value = core(faults: faults); try await value.configureAttachmentHost(hooks); _ = try await value.start()
        faults.journalRemove = { throw HostFailure("Synthetic ordinary clear interruption") }
        do { _ = try await value.call("complete", argumentsJSON: json([taskID])); XCTFail("Ordinary command must retain its terminal on lost clear") } catch { }
        let pending = try Data(contentsOf: journal), before = try rows()
        XCTAssertNotEqual(try object(String(decoding: pending, as: UTF8.self))["method"] as? String, "attachmentCleanupRetireOwned")
        await assertFailure { try await value.retireAttachmentCleanup(self.request()) }
        XCTAssertEqual(try Data(contentsOf: journal), pending); XCTAssertEqual(counter.submitted, 0)
        XCTAssertEqual(try rows(), before); XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try markers().count, 0)
        await value.close()
    }


    func testSeparateNestedMetadataKeysAndDistinctDecodedUTF8NamesRemainValid() async throws {
        try await seed(); let value = core(); _ = try await value.start()
        let original = try json(attachment())
        let metadata = "{\"left\":{\"same\":1},\"right\":{\"same\":2},\"\\ufeffsame\":3,\"\\u00e9\":4,\"e\\u0301\":5}"
        let selected = String(original.dropLast()) + ",\"metadata\":" + metadata + "}"
        let sql = try SQLiteBridge(url: database)
        _ = try sql.execute("UPDATE tasks SET attachments=? WHERE id=?", parametersJSON: json(["[" + selected + "]", taskID])); sql.close()
        let before = try rows(), input = try request()
        // Public request duplicate refusal also grants no original proof.
        await assertFailure { try await value.retireAttachmentCleanup("{\"version\":1," + String(input.dropFirst())) }
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        try assertReply(await value.retireAttachmentCleanup(input), request: input, outcome: "removed")
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await value.close()
    }
}
