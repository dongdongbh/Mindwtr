import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

/// Actual bundled JSC policy, SQLite and descriptor-owned retirement/recovery.
final class AttachmentDiscardFinishHostTests: XCTestCase {
    private var root: URL!
    private var bundle: URL!
    private var originalBundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var store: NativeAttachmentDraftStore { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let taskID = "discard-finish-task"
    private let referenceID = "live-reference-task"
    private let at = "2026-10-05T12:00:00.000Z"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path); originalBundle = bundle
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task243-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
    }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func domain() throws -> String {
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='fixture_trace' ORDER BY name").utf8)) as? [[String: Any]])
        var result: [String: Any] = [:]
        func quoted(_ value: String) -> String { "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), schema = try XCTUnwrap(table["sql"] as? String)
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("PRAGMA table_info(" + quoted(name) + ")").utf8)) as? [[String: Any]])
            let names = try columns.map { try XCTUnwrap($0["name"] as? String) }
            var fields = names.map { column -> String in
                let identifier = quoted(column)
                return "typeof(" + identifier + ") || ':' || CASE typeof(" + identifier
                    + ") WHEN 'blob' THEN hex(" + identifier + ") WHEN 'text' THEN hex(CAST(" + identifier
                    + " AS BLOB)) ELSE quote(" + identifier + ") END AS " + quoted(column)
            }
            if schema.range(of: "WITHOUT\\s+ROWID", options: [.regularExpression, .caseInsensitive]) == nil {
                let declared = Set(names.map { $0.lowercased() })
                if let rowID = ["rowid", "_rowid_", "oid"].first(where: { !declared.contains($0) }) {
                    fields.append("quote(" + quoted(rowID) + ") AS " + quoted("__fixture_row_identity"))
                }
            }
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT " + fields.joined(separator: ",") + " FROM " + quoted(name)).utf8)) as? [[String: Any]])
            result[name] = ["schema": schema, "columns": columns, "rows": try rows.map { try json($0) }.sorted()]
        }
        return try json(result)
    }
    private func record() throws -> NativeAttachmentDraftStore.Record { try XCTUnwrap(store.read()) }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func targets(_ value: NativeAttachmentDraftStore.Record) throws -> [URL] {
        try value.operations.map { try XCTUnwrap(URL(string: $0.targetURI)) }
    }
    private func metadata(_ op: NativeAttachmentDraftStore.Operation) throws -> [String: Any] {
        try XCTUnwrap(object(op.preparedJSON)["attachment"] as? [String: Any])
    }
    private func seed(version: Int = 2, adds: Int = 1, faults: HostIOFaults = HostIOFaults(),
                      jobs: NativeAttachmentHostHooks? = nil, stopAdd: AttachmentDraftBoundary? = nil) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        for id in [taskID, referenceID] {
            _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,?,'inbox','[]','[]','[]',?,?,1,'fixture')", [id, "Saved title", at, at])
        }
        let host = core(faults)
        if let jobs { try await host.configureAttachmentHost(jobs) }
        _ = try await host.start()
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let baseline = managed.appendingPathComponent("baseline.txt")
        try Data("Baseline sentinel / 文".utf8).write(to: baseline)
        let attachment: [String: Any] = ["id": "baseline-file", "kind": "file", "title": "Baseline.txt", "uri": baseline.absoluteString,
            "mimeType": "text/plain", "size": 23, "createdAt": at, "updatedAt": at, "localStatus": "available"]
        let payload = try json(["version": 2, "taskID": taskID, "attachmentsOwned": true, "attachmentsBase": [attachment], "attachments": [attachment],
            "title": "Uncommitted title", "unknownEditorField": ["nested": ["retained": "opaque é / 文"]]] as [String: Any])
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: payload)
        try await host.checkpointEditorDraft(snapshot)
        if version == 1 { _ = try await host.beginAttachmentDraft(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        else { _ = try await host.beginAttachmentDraftV2(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        try Data("Borrowed source sentinel / 文".utf8).write(to: cache.appendingPathComponent("borrowed.txt"))
        if let stopAdd { await boundary(stopAdd, on: host) }
        for _ in 0..<adds {
            let before = try latest()
            let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
                "generation": before.generation, "picked": ["uri": cache.appendingPathComponent("borrowed.txt").absoluteString,
                    "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
            if stopAdd != nil { await failure { _ = try await host.addAttachmentDraft(requestJSON: request) } }
            else { _ = try await host.addAttachmentDraft(requestJSON: request) }
        }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        return host
    }
    private func detach(_ host: CoreHost) async throws -> NativeAttachmentDraftStore.Record {
        let snapshot = try latest(), id = UUID().uuidString.lowercased()
        let result = try object(await host.discardAttachmentDraft(requestJSON: json(["version": 1, "requestId": id,
            "sessionID": snapshot.sessionID, "generation": snapshot.generation])))
        XCTAssertEqual(result["status"] as? String, "cleanupPending"); XCTAssertNil(try editor.read())
        return try record()
    }
    private func finish(_ host: CoreHost, _ record: NativeAttachmentDraftStore.Record) async throws -> String {
        try await host.finishAttachmentDraftDiscard(expectedSession: record.session.sessionID, requestId: XCTUnwrap(record.discard?.requestId))
    }
    private func stagePrepared(version: Int = 2, prefix: Int = 0, content: String = "empty") async throws -> CoreHost {
        let host = try await seed(version: version, adds: prefix)
        if version == 2 {
            let before = try latest()
            try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID,
                generation: before.generation + 7, payloadJSON: before.payloadJSON))
        }
        // Large enough that a real streaming cancellation leaves a partial stage.
        try Data(repeating: 0x73, count: 256 * 1024).write(to: cache.appendingPathComponent("borrowed.txt"))
        let before = try latest()
        let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
            "generation": before.generation, "picked": ["uri": cache.appendingPathComponent("borrowed.txt").absoluteString,
                "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
        await boundary(content == "full" ? .beforeFilled : .afterStageProof, on: host)
        await failure { _ = try await host.addAttachmentDraft(requestJSON: request) }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let op = try XCTUnwrap(record().operations.last), proof = try XCTUnwrap(op.stage)
        XCTAssertEqual(op.phase, .stagePrepared); XCTAssertNil(op.filled); XCTAssertNil(op.published)
        let stage = try XCTUnwrap(URL(string: proof.uri))
        if content == "partial" {
            let files = try NativeAttachmentFiles(libraryRoot: root)
            XCTAssertThrowsError(try files.fillReservedAttachmentStage(
                sourceProof: .init(sourceURI: op.source.sourceURI, sha256: op.source.sha256, size: op.source.size,
                    identity: op.source.identity, cacheRootIdentity: op.source.cacheRootIdentity, parentIdentity: op.source.parentIdentity),
                stageProof: .init(stageURI: proof.uri, stagedIdentity: proof.identity,
                    directoryIdentity: proof.directoryIdentity, privateDirectoryIdentity: proof.privateDirectoryIdentity),
                checkCancellation: {
                    var info = stat()
                    guard lstat(stage.path, &info) == 0 else { throw HostFailure("Fixture stage unavailable") }
                    if info.st_size > 0 { throw NativeAttachmentFileJobsError.cancelled }
                })) { XCTAssertEqual($0.localizedDescription, NativeAttachmentFileJobsError.cancelled.localizedDescription) }
        }
        let count = try Data(contentsOf: stage).count
        if content == "empty" { XCTAssertEqual(count, 0) }
        if content == "partial" { XCTAssertGreaterThan(count, 0); XCTAssertLessThan(count, Int(op.source.size)) }
        if content == "full" { XCTAssertEqual(count, Int(op.source.size)) }
        XCTAssertEqual(try inode(stage), proof.identity)
        return host
    }
    private func unstarted(version: Int = 2, prefix: Int = 0, point: AttachmentDraftBoundary = .afterIntent) async throws -> CoreHost {
        let host = try await seed(version: version, adds: prefix)
        if version == 2 {
            let before = try latest()
            try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID,
                generation: before.generation + 7, payloadJSON: before.payloadJSON))
        }
        let before = try latest()
        let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
            "generation": before.generation, "picked": ["uri": cache.appendingPathComponent("borrowed.txt").absoluteString,
                "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
        await boundary(point, on: host); await failure { _ = try await host.addAttachmentDraft(requestJSON: request) }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let last = try XCTUnwrap(record().operations.last)
        XCTAssertEqual(last.phase, .intent); XCTAssertNil(last.stage); XCTAssertNil(last.filled); XCTAssertNil(last.published); XCTAssertNil(last.replyJSON)
        return host
    }
    private func stageFilled(version: Int = 2, prefix: Int = 0, published: Bool = false) async throws -> CoreHost {
        let host = try await seed(version: version, adds: prefix)
        if version == 2 {
            let before = try latest()
            try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID,
                generation: before.generation + 7, payloadJSON: before.payloadJSON))
        }
        let before = try latest()
        let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
            "generation": before.generation, "picked": ["uri": cache.appendingPathComponent("borrowed.txt").absoluteString,
                "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
        await boundary(published ? .afterPublication : .afterFilled, on: host)
        await failure { _ = try await host.addAttachmentDraft(requestJSON: request) }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        let op = try XCTUnwrap(record().operations.last)
        XCTAssertEqual(op.phase, .stageFilled); XCTAssertNotNil(op.stage); XCTAssertNotNil(op.filled)
        XCTAssertNil(op.published); XCTAssertNil(op.replyJSON)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), target = try XCTUnwrap(URL(string: op.targetURI))
        XCTAssertEqual(FileManager.default.fileExists(atPath: stage.path), !published)
        XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), published)
        return host
    }
    // Fixture observation only; production never reconstructs intent ownership.
    private func unclaimedNamespace(_ op: NativeAttachmentDraftStore.Operation) -> URL {
        managed.appendingPathComponent(".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate", isDirectory: true)
    }
    private func diagnosticText() throws -> String {
        let file = root.appendingPathComponent("logs/mindwtr.log")
        return FileManager.default.fileExists(atPath: file.path) ? try String(contentsOf: file) : ""
    }
    private func failure(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected retained exact decision", file: file, line: line) }
        catch {
            XCTAssertFalse(error.localizedDescription.contains("Private.txt"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
        }
    }
    private func boundary(_ point: AttachmentDraftBoundary, on host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks()
        hooks.boundary = { if $0 == point { if let action { try action() } else { throw HostFailure("Private.txt injected") } } }
        await host.configureAttachmentDraftHost(hooks)
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), child = previous.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true); root = child; bundle = originalBundle
        return previous
    }
    private func protectedBytes() throws -> [URL: Data] {
        let values = [cache.appendingPathComponent("borrowed.txt"), managed.appendingPathComponent("baseline.txt")]
        return try Dictionary(uniqueKeysWithValues: values.map { ($0, try Data(contentsOf: $0)) })
    }
    private func sameFiles(_ files: [URL: Data]) throws { for (url, bytes) in files { XCTAssertEqual(try Data(contentsOf: url), bytes) } }
    private func released() throws {
        XCTAssertNil(try editor.read()); XCTAssertNil(try store.read()); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    private func journalObject() throws -> [String: Any] { try object(String(decoding: Data(contentsOf: journal), as: UTF8.self)) }
    private func journalEvidence() throws -> Data { Data(try json(journalObject()).utf8) }
    private func wrapper(_ command: [String: Any]) throws -> [String: Any] {
        let args = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(command["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(args.first))
    }
    private func writeJournal(_ command: [String: Any]) throws { try Data(json(command).utf8).write(to: journal) }
    private func setWrapper(_ value: [String: Any], in command: inout [String: Any]) throws { command["argumentsJSON"] = try json([json(value)]) }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture inode unavailable") }
        return "\(value.st_dev):\(value.st_ino)"
    }
    private func replaceExact(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), before = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained-original"))
        try bytes.write(to: url); XCTAssertNotEqual(try inode(url), before)
    }
    private func noDomainWrites() -> HostIOFaults {
        let faults = HostIOFaults()
        faults.beforeSQL = { statement in
            if ["INSERT INTO tasks", "UPDATE tasks", "DELETE FROM tasks", "INSERT INTO projects", "UPDATE projects", "DELETE FROM projects"].contains(where: statement.hasPrefix) {
                XCTFail("Terminal Discard must not write domain owners"); throw HostFailure("Unexpected domain write")
            }
        }
        return faults
    }
    private func resultOperations(_ value: String, record: NativeAttachmentDraftStore.Record, status: String = "released") throws -> [[String: Any]] {
        let result = try object(value)
        XCTAssertEqual(Set(result.keys), Set(["version", "status", "sessionID", "requestId", "operations"]))
        XCTAssertEqual(result["status"] as? String, status); XCTAssertEqual(result["sessionID"] as? String, record.session.sessionID)
        XCTAssertEqual(result["requestId"] as? String, record.discard?.requestId)
        let operations = try XCTUnwrap(result["operations"] as? [[String: Any]])
        XCTAssertEqual(operations.compactMap { $0["requestId"] as? String }, record.operations.map(\.requestId))
        XCTAssertLessThanOrEqual(value.utf8.count, 64 * 1024)
        XCTAssertFalse(value.contains("sha256")); XCTAssertFalse(value.contains("file:///")); XCTAssertFalse(value.contains("Private.txt"))
        return operations
    }

    // Private fixture source only: exactly one host insertion and exactly one
    // settled-readiness pattern must match the actual minified bundle. No
    // production evaluator or extra CoreHost command is exposed.
    private func probeBundle(_ suffix: String, exposeState: Bool = false) throws {
        var source = try String(contentsOf: originalBundle, encoding: .utf8)
        if exposeState {
            let pattern = #"let [A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\(\),[A-Za-z_$][A-Za-z0-9_$]*=([A-Za-z_$][A-Za-z0-9_$]*)\.getState\(\);if\([^;]*\.editLockCount!==0"#
            let regex = try NSRegularExpression(pattern: pattern), whole = NSRange(source.startIndex..., in: source)
            let matches = regex.matches(in: source, range: whole); XCTAssertEqual(matches.count, 1)
            let match = try XCTUnwrap(matches.first)
            func captured(_ index: Int) throws -> String { String(source[try XCTUnwrap(Range(match.range(at: index), in: source))]) }
            let status = try captured(1), state = try captured(2), body = String(source[try XCTUnwrap(Range(match.range, in: source))])
            let slotsRegex = try NSRegularExpression(pattern: #"\[\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)\.values\(\)\]"#)
            let slots = slotsRegex.matches(in: body, range: NSRange(body.startIndex..., in: body)); XCTAssertEqual(slots.count, 1)
            let slot = try XCTUnwrap(slots.first)
            let name = String(body[try XCTUnwrap(Range(slot.range(at: 1), in: body))])
            let marker = "globalThis.MindwtrHost={"
            XCTAssertEqual(source.components(separatedBy: marker).count, 2)
            guard source.components(separatedBy: marker).count == 2 else { throw HostFailure("Fixture bundle insertion mismatch") }
            source = source.replacingOccurrences(of: marker,
                with: "globalThis.__task243Store=\(state);globalThis.__task243Status=\(status);globalThis.__task243Slots=\(name);" + marker)
        }
        let destination = root.appendingPathComponent("probe-core-host.js")
        try (source + "\n;(() => {" + suffix + "})();\n").write(to: destination, atomically: true, encoding: .utf8)
        bundle = destination
    }

    func testZeroAndMultipleV1V2PublishedAddsReleaseOnlyOwnedFilesAndAllowNextSession() async throws {
        for version in [1, 2] { for count in [0, 2] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(version: version, adds: count)
            if version == 2 {
                let before = try latest()
                try await host.checkpointEditorDraft(.init(sessionID: before.sessionID, taskID: before.taskID,
                    generation: before.generation + 7, payloadJSON: before.payloadJSON))
            }
            let retained = try await detach(host), files = try protectedBytes(), saved = try domain(), ownedTargets = try targets(retained)
            let result = try await finish(host, retained), operations = try resultOperations(result, record: retained)
            XCTAssertEqual(operations.count, count)
            for operation in operations {
                XCTAssertEqual(operation["target"] as? String, "removed"); XCTAssertEqual(operation["stage"] as? String, "missing")
            }
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
            for url in ownedTargets { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)) }
            for op in retained.operations {
                let namespace = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).deletingLastPathComponent()
                XCTAssertFalse(FileManager.default.fileExists(atPath: namespace.path))
            }
            await host.close(); let cold = core(noDomainWrites()); _ = try await cold.start()
            try released(); XCTAssertEqual(try domain(), saved); try sameFiles(files)
            // There is no completed receipt/new UUID generator in this API.
            await failure { _ = try await self.finish(cold, retained) }
            let raw = try json(["version": 2, "taskID": taskID, "attachmentsOwned": true, "attachmentsBase": [], "attachments": []])
            let next = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: raw)
            try await cold.checkpointEditorDraft(next)
            _ = try await cold.beginAttachmentDraftV2(expectedSession: next.sessionID, expectedGeneration: 1)
            XCTAssertEqual(try record().operations.count, 0); await cold.close()
        } }
    }

    func testEveryFinishBoundaryColdReplayPreservesDomainAndBorrowedBaselineBytes() async throws {
        let points: [AttachmentDraftBoundary] = [.beforeDiscardFinishJournal, .afterDiscardFinishJournal,
            .beforeDiscardTarget(0), .afterDiscardTarget(0), .beforeDiscardStage(0), .afterDiscardStage(0),
            .beforeDiscardTarget(1), .afterDiscardTarget(1), .beforeDiscardStage(1), .afterDiscardStage(1),
            .beforeDiscardTerminal, .afterDiscardTerminal, .beforeDiscardRelease, .afterDiscardRelease,
            .beforeDiscardJournalClear, .afterDiscardJournalClear]
        for point in points {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(adds: 2), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            let frozen = try encoded(retained.operations)
            await boundary(point, on: host)
            await failure { _ = try await self.finish(host, retained) }
            if let actual = try store.read() { XCTAssertEqual(try encoded(actual.operations), frozen) }
            XCTAssertNil(try editor.read()); XCTAssertEqual(try domain(), saved); try sameFiles(files)
            await host.close(); let cold = core(noDomainWrites()); _ = try await cold.start()
            if point == .beforeDiscardFinishJournal { _ = try await finish(cold, retained) }
            try released(); XCTAssertEqual(try domain(), saved); try sameFiles(files)
            for url in try targets(retained) { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)) }
            await cold.close()
        }
    }

    func testWarmPendingAndTerminalWriteFailuresRetainKnownOutcomeAndExactRetry() async throws {
        for terminalWrite in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults: faults), retained = try await detach(host)
            let files = try protectedBytes(), saved = try domain(), ownedTargets = try targets(retained)
            var writes = 0
            faults.journalWrite = { writes += 1; if writes == (terminalWrite ? 2 : 1) { throw HostFailure("Journal unavailable") } }
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertEqual(writes, terminalWrite ? 2 : 1)
            XCTAssertNotNil(try store.read()); XCTAssertNil(try editor.read())
            if terminalWrite { for url in ownedTargets { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)) } }
            else { for url in ownedTargets { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)) } }
            faults.journalWrite = nil
            let retried = try await host.retryPending()
            let value = try XCTUnwrap(retried), operations = try resultOperations(value, record: retained)
            XCTAssertEqual(operations.first?["target"] as? String, "removed")
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
            await host.close()
        }
    }

    func testLostPhysicalUnlinkAcknowledgmentColdRetryUsesExactAbsentWithoutSourceAdoption() async throws {
        let hooks = NativeAttachmentHostHooks()
        var fired = false
        hooks.configureJobs = { jobs in jobs.afterRetirementUnlink = { if !fired { fired = true; throw HostFailure("Unlink acknowledgment lost") } } }
        let host = try await seed(jobs: hooks), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
        let ownedTarget = try XCTUnwrap(targets(retained).first)
        await failure { _ = try await self.finish(host, retained) }
        XCTAssertTrue(fired); XCTAssertFalse(FileManager.default.fileExists(atPath: ownedTarget.path)); XCTAssertNil(try journalObject()["terminal"])
        let evidence = try Data(contentsOf: store.url)
        await host.close(); let cold = core(noDomainWrites())
        // Stop after native missing proof so its actual outcome can be observed
        // in the success terminal, before any sidecar release.
        await boundary(.afterDiscardTerminal, on: cold)
        await failure { _ = try await cold.start() }
        let command = try journalObject(), terminal = try XCTUnwrap(command["terminal"] as? [String: Any])
        let body = try XCTUnwrap(terminal["success"] as? [String: Any])
        let operations = try resultOperations(XCTUnwrap(body["_0"] as? String), record: retained)
        XCTAssertEqual(operations.first?["target"] as? String, "absent"); XCTAssertEqual(try Data(contentsOf: store.url), evidence)
        await cold.close(); let final = core(noDomainWrites()); _ = try await final.start()
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testRecordedMissingTargetAndPrivateNamespaceUseActualTypedOutcomes() async throws {
        let host = try await seed(), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
        let op = try XCTUnwrap(retained.operations.first), target = try XCTUnwrap(URL(string: op.targetURI))
        let namespace = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).deletingLastPathComponent()
        // Immutable publication already consumed the recorded private namespace.
        var info = stat(); XCTAssertEqual(lstat(namespace.path, &info), -1); XCTAssertEqual(errno, ENOENT)
        try FileManager.default.removeItem(at: target)
        let operations = try resultOperations(await finish(host, retained), record: retained)
        XCTAssertEqual(operations.first?["target"] as? String, "absent"); XCTAssertEqual(operations.first?["stage"] as? String, "missing")
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testCurrentTaskProjectArchivedAndTombstoneReferencePolicyKeepsOnlyLiveBytes() async throws {
        for mode in ["task", "archived-task", "project", "archived-project", "deleted-task", "attachment-tombstone"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first)
            let target = try XCTUnwrap(URL(string: op.targetURI)), bytes = try Data(contentsOf: target), files = try protectedBytes()
            var attachment = try metadata(op)
            if mode == "attachment-tombstone" { attachment["deletedAt"] = at }
            await host.close()
            if mode.contains("project") {
                _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,attachments,createdAt,updatedAt,archivedAt,rev) VALUES ('reference-project','Reference',?,'#94a3b8',0,'[]',0,0,?,?,?,?,1)",
                    [mode == "archived-project" ? "archived" : "active", json([attachment]), at, at,
                     mode == "archived-project" ? at as Any : NSNull()])
            } else {
                _ = try sql("UPDATE tasks SET attachments=?,deletedAt=? WHERE id=?", [json([attachment]), mode == "deleted-task" ? at as Any : NSNull(), referenceID])
                if mode == "archived-task" {
                    _ = try sql("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,createdAt,updatedAt,archivedAt,rev) VALUES ('archived-owner','Archived','archived','#94a3b8',0,'[]',0,0,?,?,?,1)", [at, at, at])
                    _ = try sql("UPDATE tasks SET projectId='archived-owner',status='reference',archivedAt=? WHERE id=?", [at, referenceID])
                }
            }
            let saved = try domain(), cold = core(noDomainWrites()); _ = try await cold.start()
            if mode == "archived-task" {
                let view = try object(await cold.call("taskView", argumentsJSON: json([json(["id": referenceID])])))
                XCTAssertEqual(view["readOnly"] as? Bool, true)
            }
            let operations = try resultOperations(await finish(cold, retained), record: retained)
            let live = !["deleted-task", "attachment-tombstone"].contains(mode)
            XCTAssertEqual(operations.first?["target"] as? String, live ? "referenced" : "removed")
            if live { XCTAssertEqual(try Data(contentsOf: target), bytes) } else { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)) }
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testReferencedReplacedTargetIsLeftAloneWithoutAdoptingItsPublicationProof() async throws {
        let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first), attachment = try metadata(op)
        let target = try XCTUnwrap(URL(string: op.targetURI)), files = try protectedBytes()
        await host.close(); _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([attachment]), referenceID])
        try FileManager.default.moveItem(at: target, to: target.appendingPathExtension("original-owned"))
        let replacement = Data("Foreign referenced bytes".utf8); try replacement.write(to: target)
        let identity = try inode(target), saved = try domain(), cold = core(noDomainWrites()); _ = try await cold.start()
        let operations = try resultOperations(await finish(cold, retained), record: retained)
        XCTAssertEqual(operations.first?["target"] as? String, "referenced")
        XCTAssertEqual(try Data(contentsOf: target), replacement); XCTAssertEqual(try inode(target), identity)
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testNonterminalRetryReobservesNewReferenceInsteadOfFrozenOldPlan() async throws {
        let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first), files = try protectedBytes()
        let target = try XCTUnwrap(URL(string: op.targetURI)), bytes = try Data(contentsOf: target)
        await boundary(.beforeDiscardTarget(0), on: host); await failure { _ = try await self.finish(host, retained) }
        XCTAssertNil(try journalObject()["terminal"])
        await host.close(); _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json([metadata(op)]), referenceID])
        let saved = try domain(), cold = core(noDomainWrites()); _ = try await cold.start()
        try released(); XCTAssertEqual(try Data(contentsOf: target), bytes); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testSuccessTerminalWithInterveningDomainAndTargetReplacementRunsNoNewFileJobsOrQueries() async throws {
        let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first), files = try protectedBytes()
        await boundary(.afterDiscardTerminal, on: host); await failure { _ = try await self.finish(host, retained) }
        XCTAssertNotNil(try journalObject()["terminal"]); await host.close()
        _ = try sql("UPDATE tasks SET title='Later C',rev=rev+1 WHERE id=?", [taskID])
        let target = try XCTUnwrap(URL(string: op.targetURI)), foreign = Data("Later foreign bytes".utf8)
        try foreign.write(to: target); let identity = try inode(target), saved = try domain()
        try probeBundle("MindwtrHost.attachmentDraftDiscardCandidates=()=>{throw Error('No candidate replay')}; MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('No live replay')};")
        let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
        jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Durable success must start no file job"); throw HostFailure("Unexpected file job") } }
        try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
        try released(); XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), identity)
        try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testStageFilledWithoutEitherPositiveProofRefusesBeforeJournalAndKeepsAllEvidence() async throws {
        for mode in ["missing", "different-content", "different-inode"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(), retained = try await detach(host)
            let op = try XCTUnwrap(retained.operations.last), stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri)))
            let original = try Data(contentsOf: stage)
            if mode == "missing" { try FileManager.default.removeItem(at: stage) }
            if mode == "different-content" { try Data(repeating: 0x58, count: original.count).write(to: stage) }
            if mode == "different-inode" { try replaceExact(stage) }
            let evidence = try Data(contentsOf: store.url), files = try protectedBytes(), saved = try domain()
            let observer = LockedFlag(), verifier = LockedFlag(), hooks = AttachmentDraftHostHooks()
            hooks.boundary = { point in
                if point == .afterDiscardFilledObservation { observer.set(true) }
                if point == .beforeDiscardPublicationReproof { verifier.set(true) }
                if point == .beforeDiscardFinishJournal { XCTFail("Two failed positive proofs must not create a journal") }
            }
            await host.configureAttachmentDraftHost(hooks)
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertTrue(observer.take()); XCTAssertTrue(verifier.take())
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try Data(contentsOf: store.url), evidence)
            if mode != "missing" { XCTAssertEqual(try Data(contentsOf: stage), mode == "different-content" ? Data(repeating: 0x58, count: original.count) : original) }
            XCTAssertNil(try editor.read()); try sameFiles(files); XCTAssertEqual(try domain(), saved)
            await host.close()
        }
    }

    func testFilledV1V2ObserverFirstReleasesStageWithSourceGoneAndSameContentForeignTargetUntouched() async throws {
        for version in [1, 2] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(version: version, prefix: 1), retained = try await detach(host)
            let op = try XCTUnwrap(retained.operations.last), stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri)))
            let target = try XCTUnwrap(URL(string: op.targetURI)), foreign = try Data(contentsOf: stage)
            try foreign.write(to: target); let identity = try inode(target)
            XCTAssertNotEqual(identity, op.stage?.identity)
            try FileManager.default.removeItem(at: cache.appendingPathComponent("borrowed.txt"))
            let baseline = managed.appendingPathComponent("baseline.txt"), baselineBytes = try Data(contentsOf: baseline)
            let saved = try domain(), frozen = try encoded(retained.operations)
            await host.close()
            try probeBundle("const h=MindwtrHost,f=h.attachmentDraftDiscardRetire;h.attachmentDraftDiscardRetire=function(j,k,r){if(JSON.parse(j).requestId==='\(op.requestId)')throw Error('Unexpected last target query');return f.call(h,j,k,r)}")
            let cold = core(noDomainWrites()); _ = try await cold.start()
            let observed = LockedFlag(), hooks = AttachmentDraftHostHooks()
            hooks.boundary = { point in
                if point == .afterDiscardFilledObservation { observed.set(true) }
                if point == .beforeDiscardPublicationReproof || point == .beforeDiscardPublicationPromotion { XCTFail("Positive observer must not inspect public publication") }
                if point == .beforeDiscardStage(1) { XCTAssertEqual(try self.encoded(self.record().operations), frozen) }
                if point == .beforeDiscardTarget(1) || point == .afterDiscardTarget(1) { XCTFail("Last target must remain untouched") }
            }
            await cold.configureAttachmentDraftHost(hooks)
            let result = try await finish(cold, retained), operations = try resultOperations(result, record: retained)
            XCTAssertTrue(observed.take()); XCTAssertEqual(try object(result)["version"] as? Int, 4)
            XCTAssertEqual(operations.first?["target"] as? String, "removed")
            XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "removed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), identity)
            XCTAssertEqual(try Data(contentsOf: baseline), baselineBytes); XCTAssertEqual(try domain(), saved)
            XCTAssertFalse(FileManager.default.fileExists(atPath: cache.appendingPathComponent("borrowed.txt").path))
            try released(); await cold.close()
        }
    }

    func testFilledV1V2LostPublicationAcknowledgmentPromotesExactProofBeforeV1JournalAndKeepsLiveReferences() async throws {
        for version in [1, 2] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(version: version, prefix: 1, published: true), retained = try await detach(host)
            let beforeBytes = try Data(contentsOf: store.url), beforeIdentity = try inode(store.url)
            let op = try XCTUnwrap(retained.operations.last), target = try XCTUnwrap(URL(string: op.targetURI)), targetBytes = try Data(contentsOf: target)
            XCTAssertEqual(try inode(target), op.stage?.identity)
            let attachments = try retained.operations.map { try metadata($0) }
            await host.close(); _ = try sql("UPDATE tasks SET attachments=? WHERE id=?", [json(attachments), referenceID])
            try FileManager.default.removeItem(at: cache.appendingPathComponent("borrowed.txt"))
            let saved = try domain(), baseline = managed.appendingPathComponent("baseline.txt"), baselineBytes = try Data(contentsOf: baseline)
            let cold = core(noDomainWrites()); _ = try await cold.start()
            let observed = LockedFlag(), reproof = LockedFlag(), promoted = LockedFlag(), hooks = AttachmentDraftHostHooks()
            hooks.boundary = { point in
                if point == .afterDiscardFilledObservation { observed.set(true) }
                if point == .afterDiscardPublicationReproof { reproof.set(true) }
                if point == .afterDiscardPublicationPromotion {
                    promoted.set(true)
                    let actual = try self.record(), last = try XCTUnwrap(actual.operations.last), proof = try XCTUnwrap(last.published)
                    XCTAssertEqual(last.phase, .published); XCTAssertEqual(proof.sha256, op.filled?.sha256)
                    XCTAssertEqual(proof.size, op.filled?.size); XCTAssertEqual(proof.identity, op.stage?.identity)
                    XCTAssertEqual(proof.directoryIdentity, op.stage?.directoryIdentity)
                    XCTAssertEqual(last.requestJSON, op.requestJSON); XCTAssertEqual(last.preparedJSON, op.preparedJSON)
                    XCTAssertEqual(last.before, op.before); XCTAssertEqual(last.after, op.after)
                    XCTAssertEqual(last.source, op.source); XCTAssertEqual(last.stage, op.stage); XCTAssertEqual(last.filled, op.filled)
                    XCTAssertEqual(last.reason, op.reason); XCTAssertEqual(last.replyJSON, op.replyJSON)
                    XCTAssertEqual(actual.session, retained.session); XCTAssertEqual(actual.discard, retained.discard)
                    XCTAssertEqual(try self.encoded(Array(actual.operations.dropLast())), try self.encoded(Array(retained.operations.dropLast())))
                    XCTAssertNotEqual(try Data(contentsOf: self.store.url), beforeBytes); XCTAssertNotEqual(try self.inode(self.store.url), beforeIdentity)
                }
                if point == .afterDiscardFinishJournal {
                    let actual = try self.record(), wrapper = try self.wrapper(self.journalObject())
                    XCTAssertEqual(wrapper["version"] as? Int, 1)
                    XCTAssertEqual(wrapper["recordSHA256"] as? String, try NativeAttachmentDraftStore.ownedDiscardFingerprint(actual))
                }
            }
            await cold.configureAttachmentDraftHost(hooks)
            let result = try await finish(cold, retained), operations = try resultOperations(result, record: retained)
            XCTAssertTrue(observed.take()); XCTAssertTrue(reproof.take()); XCTAssertTrue(promoted.take())
            XCTAssertEqual(try object(result)["version"] as? Int, 1)
            for operation in operations { XCTAssertEqual(operation["target"] as? String, "referenced"); XCTAssertEqual(operation["stage"] as? String, "missing") }
            XCTAssertEqual(try Data(contentsOf: target), targetBytes); XCTAssertEqual(try inode(target), op.stage?.identity)
            XCTAssertEqual(try Data(contentsOf: baseline), baselineBytes); XCTAssertEqual(try domain(), saved)
            try released(); await cold.close()
        }
    }

    func testFreshDiscardJournalHookCancellationRetainsAllFourVersionsWithoutJournal() async throws {
        for version in [1, 2, 3, 4] {
            let previous = try isolate(); defer { root = previous }
            let host: CoreHost
            switch version {
            case 1: host = try await seed()
            case 2: host = try await stagePrepared()
            case 3: host = try await unstarted()
            default: host = try await stageFilled()
            }
            let retained = try await detach(host), evidence = try Data(contentsOf: store.url), files = try protectedBytes(), saved = try domain()
            let stage = try retained.operations.last?.stage.map { try XCTUnwrap(URL(string: $0.uri)) }
            let stageBytes = try stage.flatMap { FileManager.default.fileExists(atPath: $0.path) ? try Data(contentsOf: $0) : nil }
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            await boundary(.beforeDiscardFinishJournal, on: host) { entered.signal(); release.wait() }
            let operation = Task { try await self.finish(host, retained) }
            XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
            operation.cancel(); release.signal(); await failure { _ = try await operation.value }
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertEqual(try Data(contentsOf: store.url), evidence)
            if let stage, let stageBytes { XCTAssertEqual(try Data(contentsOf: stage), stageBytes) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await host.close()
        }
    }

    func testFilledPersistedV4ColdBoundariesNeverReclassifyAndLostStageAcknowledgmentReturnsMissing() async throws {
        for point in [AttachmentDraftBoundary.afterDiscardFinishJournal, .afterDiscardStage(0), .afterDiscardTerminal,
                      .afterDiscardRelease, .beforeDiscardJournalClear, .afterDiscardJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), target = try XCTUnwrap(URL(string: op.targetURI))
            let foreign = Data("Untouched target across v4 cold replay".utf8); try foreign.write(to: target)
            let identity = try inode(target), frozen = try encoded(retained.operations), files = try protectedBytes(), saved = try domain()
            await boundary(point, on: host); await failure { _ = try await self.finish(host, retained) }
            if let actual = try store.read() { XCTAssertEqual(try encoded(actual.operations), frozen) }
            if FileManager.default.fileExists(atPath: journal.path) { XCTAssertEqual(try wrapper(journalObject())["version"] as? Int, 4) }
            if point == .afterDiscardStage(0) {
                XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path)); XCTAssertNil(try journalObject()["terminal"])
            }
            await host.close()
            try probeBundle("MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('v4 last target must not be queried')}")
            let cold = core(noDomainWrites()), hooks = AttachmentDraftHostHooks(), replayed = LockedFlag()
            hooks.boundary = { boundary in
                if boundary == .beforeDiscardFilledObservation || boundary == .beforeDiscardPublicationReproof
                    || boundary == .beforeDiscardPublicationPromotion { XCTFail("Persisted v4 must not reclassify"); throw HostFailure("Unexpected reclassification") }
                if boundary == .afterDiscardTerminal {
                    replayed.set(true)
                    let terminal = try XCTUnwrap(self.journalObject()["terminal"] as? [String: Any])
                    let success = try XCTUnwrap(terminal["success"] as? [String: Any]), result = try XCTUnwrap(success["_0"] as? String)
                    XCTAssertEqual(try self.object(result)["version"] as? Int, 4)
                    let operations = try self.resultOperations(result, record: retained)
                    XCTAssertEqual(operations.last?["target"] as? String, "untouched")
                    XCTAssertEqual(operations.last?["stage"] as? String, point == .afterDiscardStage(0) ? "missing" : "removed")
                }
            }
            await cold.configureAttachmentDraftHost(hooks); _ = try await cold.start()
            if point != .afterDiscardJournalClear { XCTAssertTrue(replayed.take()) }
            try released(); XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), identity)
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testFilledRecordedV4UnknownPrivateChildRetainsJournalAfterOwnedStageRetirementAndColdRetry() async throws {
        let host = try await stageFilled(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), namespace = stage.deletingLastPathComponent()
        let unknown = namespace.appendingPathComponent("unknown"), unknownBytes = Data("Private unknown child is preserved".utf8)
        let target = try XCTUnwrap(URL(string: op.targetURI)), foreign = Data("Public target remains untouched".utf8)
        try foreign.write(to: target); let targetIdentity = try inode(target)
        let evidence = try Data(contentsOf: store.url), files = try protectedBytes(), saved = try domain()
        await boundary(.beforeDiscardStage(0), on: host) { try unknownBytes.write(to: unknown) }
        await failure { _ = try await self.finish(host, retained) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertEqual(try inode(namespace), op.stage?.privateDirectoryIdentity)
        let unknownIdentity = try inode(unknown), pending = try journalEvidence()
        XCTAssertEqual(try wrapper(journalObject())["version"] as? Int, 4); XCTAssertNil(try journalObject()["terminal"])
        XCTAssertEqual(try Data(contentsOf: store.url), evidence)
        await host.close()
        try probeBundle("MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('v4 unknown child cannot query target')}")
        let cold = core(noDomainWrites()), hooks = AttachmentDraftHostHooks()
        hooks.boundary = { point in
            if point == .beforeDiscardFilledObservation || point == .beforeDiscardPublicationReproof { XCTFail("Existing v4 decision must remain selected"); throw HostFailure("Unexpected classification") }
        }
        await cold.configureAttachmentDraftHost(hooks); await failure { _ = try await cold.start() }
        XCTAssertEqual(try journalEvidence(), pending); XCTAssertNil(try journalObject()["terminal"])
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertEqual(try Data(contentsOf: unknown), unknownBytes); XCTAssertEqual(try inode(unknown), unknownIdentity)
        XCTAssertEqual(try inode(namespace), op.stage?.privateDirectoryIdentity)
        XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), targetIdentity)
        try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
    }

    func testFilledDurableV4TerminalPresentOrAbsentSidecarStartsNoFileOrReferenceWork() async throws {
        for absent in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(prefix: 1), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(absent ? .afterDiscardRelease : .afterDiscardTerminal, on: host)
            await failure { _ = try await self.finish(host, retained) }
            let terminal = try XCTUnwrap(journalObject()["terminal"] as? [String: Any])
            let success = try XCTUnwrap(terminal["success"] as? [String: Any]), result = try XCTUnwrap(success["_0"] as? String)
            let operations = try resultOperations(result, record: retained)
            XCTAssertEqual(try object(result)["version"] as? Int, 4)
            XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "removed")
            XCTAssertEqual(try store.read() == nil, absent); await host.close()
            let foreign = Data("Foreign public bytes after terminal".utf8)
            for target in try targets(retained) { try foreign.write(to: target) }
            try probeBundle("MindwtrHost.attachmentDraftDiscardCandidates=()=>{throw Error('No terminal plan')};MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('No terminal reference')}")
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Durable v4 terminal must start no file job"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
            try released(); for target in try targets(retained) { XCTAssertEqual(try Data(contentsOf: target), foreign) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testFilledPublicationPromotionBoundariesAndExactSidecarReplacementRequireFreshAuthorityBeforeJournal() async throws {
        for mode in ["before-write", "after-write", "after-reproof-replacement", "after-write-replacement"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stageFilled(published: true), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let target = try XCTUnwrap(URL(string: op.targetURI)), targetBytes = try Data(contentsOf: target), targetIdentity = try inode(target)
            let original = try Data(contentsOf: store.url), files = try protectedBytes(), saved = try domain(), hookFired = LockedFlag()
            let point: AttachmentDraftBoundary = mode == "before-write" ? .beforeDiscardPublicationPromotion
                : mode == "after-reproof-replacement" ? .afterDiscardPublicationReproof : .afterDiscardPublicationPromotion
            if mode.contains("replacement") {
                await boundary(point, on: host) { hookFired.set(true); try self.replaceExact(self.store.url) }
            } else {
                await boundary(point, on: host) { hookFired.set(true); throw HostFailure("Interrupted promotion boundary") }
            }
            await failure { _ = try await self.finish(host, retained) }; XCTAssertTrue(hookFired.take())
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            let actual = try record(), expectedPublished = mode == "after-write" || mode == "after-write-replacement"
            XCTAssertEqual(actual.operations.last?.phase, expectedPublished ? .published : .stageFilled)
            if expectedPublished { XCTAssertEqual(actual.operations.last?.published?.identity, op.stage?.identity) }
            else { XCTAssertEqual(try Data(contentsOf: store.url), original) }
            let preserved = try Data(contentsOf: store.url)
            XCTAssertEqual(try Data(contentsOf: target), targetBytes); XCTAssertEqual(try inode(target), targetIdentity)
            try sameFiles(files); XCTAssertEqual(try domain(), saved)
            await host.close(); let cold = core(noDomainWrites()); _ = try await cold.start()
            XCTAssertEqual(try Data(contentsOf: store.url), preserved)
            if expectedPublished {
                let hooks = AttachmentDraftHostHooks()
                hooks.boundary = { point in
                    if point == .beforeDiscardFilledObservation || point == .beforeDiscardPublicationReproof
                        || point == .beforeDiscardPublicationPromotion { XCTFail("Acknowledged visible published record must not be promoted twice") }
                }
                await cold.configureAttachmentDraftHost(hooks)
            }
            let result = try await finish(cold, actual), operations = try resultOperations(result, record: retained)
            XCTAssertEqual(try object(result)["version"] as? Int, 1)
            XCTAssertEqual(operations.last?["target"] as? String, "removed"); XCTAssertEqual(operations.last?["stage"] as? String, "missing")
            try released(); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testFilledV4VersionPhaseStatusAndOutcomeConfusionRefusesBeforeJobs() async throws {
        for mode in ["v4-prepared", "v4-published", "v4-empty", "v3-filled", "discarded", "unclaimed", "prefix-untouched", "last-removed"] {
            let previous = try isolate(); defer { root = previous }
            let host: CoreHost
            if mode == "v4-prepared" { host = try await stagePrepared() }
            else if mode == "v4-published" || mode == "v4-empty" { host = try await seed(adds: mode == "v4-empty" ? 0 : 1) }
            else { host = try await stageFilled(prefix: mode == "prefix-untouched" ? 1 : 0) }
            let retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
            await host.close(); var command = try journalObject(), value = try wrapper(command)
            value["version"] = mode == "v3-filled" ? 3 : 4
            if ["discarded", "unclaimed", "prefix-untouched", "last-removed"].contains(mode) {
                let result: [String: Any] = ["version": 4, "status": mode == "discarded" ? "discarded" : "released",
                    "sessionID": retained.session.sessionID, "requestId": try XCTUnwrap(retained.discard?.requestId),
                    "operations": retained.operations.enumerated().map { index, op in
                        let last = index == retained.operations.count - 1
                        return ["requestId": op.requestId, "target": last ? (mode == "last-removed" ? "removed" : "untouched")
                            : (mode == "prefix-untouched" ? "untouched" : "removed"),
                            "stage": last && mode == "unclaimed" ? "unclaimed" : "removed"]
                    }]
                command["terminal"] = ["success": ["_0": try json(result)]]
            }
            try setWrapper(value, in: &command); try writeJournal(command)
            let evidence = try Data(contentsOf: journal), sidecar = try Data(contentsOf: store.url)
            let stage = try retained.operations.last?.stage.map { try XCTUnwrap(URL(string: $0.uri)) }
            let stageBytes = try stage.flatMap { FileManager.default.fileExists(atPath: $0.path) ? try Data(contentsOf: $0) : nil }
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Forged v4 decision must start no work"); throw HostFailure("Unexpected file work") } }
            try await cold.configureAttachmentHost(jobs); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: journal), evidence); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            if let stage, let stageBytes { XCTAssertEqual(try Data(contentsOf: stage), stageBytes) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testPublishedAndResultDurableBeforeCheckpointRemainHistoricallyDiscardable() async throws {
        for point in [AttachmentDraftBoundary.afterPublicationProof, .afterResult] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(stopAdd: point), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            XCTAssertEqual(retained.operations.first?.phase, point == .afterResult ? .resultDurable : .published)
            let operations = try resultOperations(await finish(host, retained), record: retained)
            XCTAssertEqual(operations.first?["target"] as? String, "removed"); XCTAssertEqual(operations.first?["stage"] as? String, "missing")
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved); await host.close()
        }
    }

    func testActiveDecidedWrongIdentityAndGenericDeleteEscapeStaySealedBeforeJournal() async throws {
        let host = try await seed(), active = try record(), target = try XCTUnwrap(targets(active).first), bytes = try Data(contentsOf: target)
        await failure { _ = try await host.finishAttachmentDraftDiscard(expectedSession: active.session.sessionID, requestId: UUID().uuidString.lowercased()) }
        let snapshot = try latest(), id = UUID().uuidString.lowercased()
        await boundary(.afterDiscardDecision, on: host)
        await failure { _ = try await host.discardAttachmentDraft(requestJSON: self.json(["version": 1, "requestId": id,
            "sessionID": snapshot.sessionID, "generation": snapshot.generation])) }
        XCTAssertEqual(try record().discard?.phase, .decided)
        await failure { _ = try await host.finishAttachmentDraftDiscard(expectedSession: snapshot.sessionID, requestId: id) }
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        _ = try await host.recoverAttachmentDraft(expectedSession: snapshot.sessionID)
        let retained = try record(), evidence = try Data(contentsOf: store.url)
        for (session, request) in [(UUID().uuidString.lowercased(), id), (snapshot.sessionID, UUID().uuidString.lowercased()),
            (snapshot.sessionID, try XCTUnwrap(retained.operations.first?.requestId)), (snapshot.sessionID.uppercased(), id)] {
            await failure { _ = try await host.finishAttachmentDraftDiscard(expectedSession: session, requestId: request) }
        }
        for method in ["attachmentOwnedDiscardFinish", "attachmentDraftDiscardRetire", "attachmentDraftDiscardCandidates", "fileDelete", "saveDraft", "taskDelete"] {
            await failure { _ = try await host.call(method, argumentsJSON: "[\"{}\"]") }
        }
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); XCTAssertNil(try editor.read())
    }

    func testExactByteSidecarAndJournalInodeReplacementAfterHooksRefusesWithoutOverwrite() async throws {
        for kind in ["sidecar", "journal", "journal-write"] {
            let previous = try isolate(); defer { root = previous }
            let faults = HostIOFaults(), host = try await seed(faults: faults), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            let ownedTarget = try XCTUnwrap(targets(retained).first), targetBytes = try Data(contentsOf: ownedTarget)
            let url = kind == "sidecar" ? store.url : journal
            var replaced = false
            if kind == "journal-write" {
                var calls = 0
                faults.journalWrite = { calls += 1; if calls == 2 { try self.replaceExact(url); replaced = true } }
            } else {
                await boundary(.beforeDiscardTarget(0), on: host) { try self.replaceExact(url); replaced = true }
            }
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertTrue(replaced)
            let bytes = try Data(contentsOf: url), identity = try inode(url)
            XCTAssertEqual(bytes, try Data(contentsOf: url.appendingPathExtension("retained-original")))
            XCTAssertEqual(try inode(url), identity); XCTAssertEqual(try Data(contentsOf: url), bytes)
            if kind != "journal-write" { XCTAssertEqual(try Data(contentsOf: ownedTarget), targetBytes) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: ownedTarget.path)); XCTAssertNil(try journalObject()["terminal"]) }
            XCTAssertNotNil(try store.read()); XCTAssertNil(try editor.read()); try sameFiles(files); XCTAssertEqual(try domain(), saved)
            await host.close()
        }
    }

    func testReplacedEditorAfterTargetAndAfterReleaseRetainsExactJournalAndForeignCheckpoint() async throws {
        for point in [AttachmentDraftBoundary.beforeDiscardTarget(0), .beforeDiscardJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), retained = try await detach(host), saved = try domain(), files = try protectedBytes()
            let foreign = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: "{\"foreign\":true}")
            await boundary(point, on: host) { try self.editor.checkpoint(foreign) }
            await failure { _ = try await self.finish(host, retained) }
            let checkpoint = try Data(contentsOf: editor.url), decision = try journalEvidence()
            XCTAssertEqual(try encoded(XCTUnwrap(editor.read()?.snapshot)), try encoded(foreign))
            await host.close(); let cold = core(noDomainWrites()); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: editor.url), checkpoint); XCTAssertEqual(try journalEvidence(), decision)
            try sameFiles(files); XCTAssertEqual(try domain(), saved)
        }
    }

    func testTargetAndManagedRootProofReplacementAfterHookRetainsUnknownBytes() async throws {
        for mode in ["inode", "content", "hardlink", "symlink", "missing-root"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first)
            let target = try XCTUnwrap(URL(string: op.targetURI)), evidence = try Data(contentsOf: store.url), saved = try domain()
            let bytes = try Data(contentsOf: target), unknown = root.appendingPathComponent("unknown-sentinel.txt")
            try Data("Unknown sentinel".utf8).write(to: unknown)
            let unknownBefore = try Data(contentsOf: unknown)
            await boundary(.beforeDiscardTarget(0), on: host) {
                switch mode {
                case "inode": try self.replaceExact(target)
                case "content": try Data("Changed target content".utf8).write(to: target)
                case "hardlink": XCTAssertEqual(link(target.path, target.appendingPathExtension("foreign-link").path), 0)
                case "symlink":
                    try FileManager.default.moveItem(at: target, to: target.appendingPathExtension("original-owned"))
                    try FileManager.default.createSymbolicLink(at: target, withDestinationURL: unknown)
                default: try FileManager.default.moveItem(at: self.managed, to: self.managed.appendingPathExtension("retained-owned-root"))
                }
            }
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertNil(try journalObject()["terminal"])
            XCTAssertEqual(try Data(contentsOf: unknown), unknownBefore); XCTAssertEqual(try domain(), saved)
            if mode == "inode" || mode == "hardlink" { XCTAssertEqual(try Data(contentsOf: target), bytes) }
            if mode == "missing-root" {
                XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path))
                XCTAssertEqual(try Data(contentsOf: managed.appendingPathExtension("retained-owned-root").appendingPathComponent(target.lastPathComponent)), bytes)
            }
            await host.close()
        }
    }

    func testForeignPrivateNamespaceAfterTargetRetirementIsNotRemovedOrAdopted() async throws {
        let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first), files = try protectedBytes(), saved = try domain()
        let namespace = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).deletingLastPathComponent()
        let sentinel = namespace.appendingPathComponent("foreign.txt"), bytes = Data("Foreign namespace".utf8)
        await boundary(.beforeDiscardStage(0), on: host) {
            try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: false)
            try bytes.write(to: sentinel)
        }
        await failure { _ = try await self.finish(host, retained) }
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes); XCTAssertNil(try journalObject()["terminal"])
        let identity = try inode(namespace), evidence = try Data(contentsOf: store.url)
        await host.close(); let cold = core(noDomainWrites()); await failure { _ = try await cold.start() }
        XCTAssertEqual(try inode(namespace), identity); XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
        XCTAssertEqual(try Data(contentsOf: store.url), evidence); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testColdStrictWrapperAndTerminalShapeRefuseWithoutNewJobsOrDomainWrites() async throws {
        let modes = ["extra", "boolean-version", "duplicate-ids", "wrong-order", "discard-add-id", "editor-attempt",
            "bad-hash", "rejected", "bad-success", "bad-outcome", "oversize-success"]
        for mode in modes {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(adds: 2), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
            await host.close(); var command = try journalObject(), value = try wrapper(command)
            switch mode {
            case "extra": value["extra"] = true
            case "boolean-version": value["version"] = true
            case "duplicate-ids": value["operationIDs"] = [retained.operations[0].requestId, retained.operations[0].requestId]
            case "wrong-order": value["operationIDs"] = retained.operations.map(\.requestId).reversed().map { $0 }
            case "discard-add-id": value["requestId"] = retained.operations[0].requestId
            case "bad-hash": value["recordSHA256"] = String(repeating: "a", count: 64)
            case "editor-attempt": command["editorDraft"] = NSNull()
            case "rejected": command["terminal"] = ["rejected": ["_0": "INVALID_INPUT"]]
            default:
                var result: [String: Any] = ["version": 1, "status": "released", "sessionID": retained.session.sessionID,
                    "requestId": try XCTUnwrap(retained.discard?.requestId), "operations": retained.operations.map {
                        ["requestId": $0.requestId, "target": mode == "bad-outcome" ? "deleted" : "removed", "stage": "missing"]
                    }]
                if mode == "bad-success" { result["extra"] = true }
                if mode == "oversize-success" { result["padding"] = String(repeating: "x", count: 64 * 1024) }
                command["terminal"] = ["success": ["_0": try json(result)]]
            }
            try setWrapper(value, in: &command); try writeJournal(command)
            let evidence = try Data(contentsOf: journal), sidecar = try Data(contentsOf: store.url), cold = core(noDomainWrites())
            let jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Invalid journal must start no job"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: journal), evidence); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            for target in try targets(retained) { XCTAssertTrue(FileManager.default.fileExists(atPath: target.path)) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved)
        }
    }

    func testColdFIFOAndSymlinkJournalRefuseWithoutBlockingOrExternalMutation() async throws {
        for mode in ["fifo", "symlink"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
            await host.close()
            let external = root.appendingPathComponent("external-journal.txt"), bytes = try Data(contentsOf: journal)
            try bytes.write(to: external); try FileManager.default.removeItem(at: journal)
            if mode == "fifo" { XCTAssertEqual(mkfifo(journal.path, mode_t(0o600)), 0) }
            else { try FileManager.default.createSymbolicLink(at: journal, withDestinationURL: external) }
            let identity = try inode(journal), cold = core(noDomainWrites()), start = Date()
            await failure { _ = try await cold.start() }
            XCTAssertLessThan(Date().timeIntervalSince(start), 2); XCTAssertEqual(try inode(journal), identity)
            XCTAssertEqual(try Data(contentsOf: external), bytes); XCTAssertNotNil(try store.read()); try sameFiles(files); XCTAssertEqual(try domain(), saved)
        }
    }

    func testCallbackMissingDuplicateReentrantForgedAndThrowingResultsRetainPending() async throws {
        for mode in ["missing", "duplicate", "reentrant", "forged", "throw"] {
            let previous = try isolate(); defer { root = previous }
            let body: String
            switch mode {
            case "missing": body = "return JSON.stringify({outcome:'removed'});"
            case "duplicate": body = "const value=original(json,keep,retire); keep(); return value;"
            case "reentrant": body = "return original(json,keep,()=>{const value=retire(); original(json,keep,retire); return value;});"
            case "forged": body = "original(json,keep,retire); return JSON.stringify({outcome:'referenced'});"
            default: body = "original(json,keep,retire); throw Error('Private.txt must stay private');"
            }
            try probeBundle("const original=MindwtrHost.attachmentDraftDiscardRetire; MindwtrHost.attachmentDraftDiscardRetire=(json,keep,retire)=>{\(body)};")
            let host = try await seed(), retained = try await detach(host), files = try protectedBytes(), saved = try domain(), target = try XCTUnwrap(targets(retained).first)
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.read())
            XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), mode == "missing")
            await host.close(); bundle = originalBundle
            let cold = core(noDomainWrites()); _ = try await cold.start()
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
        }
    }

    func testExpiredCallbackCannotRetireReplacementAfterItsOuterFunctionReturned() async throws {
        try probeBundle("""
        const original=MindwtrHost.attachmentDraftDiscardRetire; let previous=null, calls=0;
        MindwtrHost.attachmentDraftDiscardRetire=(json,keep,retire)=>{
          if(++calls===2){const late=previous(); if(!late.startsWith('!MindwtrNativeError:')) throw Error('Late callback was live');}
          previous=retire; return original(json,keep,retire);
        };
        """)
        let host = try await seed(adds: 2), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
        let first = try XCTUnwrap(targets(retained).first), foreign = Data("Post-return foreign target".utf8)
        await boundary(.afterDiscardTarget(0), on: host) { try foreign.write(to: first) }
        let operations = try resultOperations(await finish(host, retained), record: retained)
        XCTAssertEqual(operations.count, 2); XCTAssertEqual(operations[0]["target"] as? String, "removed")
        XCTAssertEqual(try Data(contentsOf: first), foreign); try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testActualJSCMicrotaskRunsOnlyAfterTypedRetirementCompletedInsideCallback() async throws {
        try probeBundle("""
        const original=MindwtrHost.attachmentDraftDiscardRetire;
        const trace=label=>__mindwtrNative.sqlRun('INSERT INTO fixture_trace(label) VALUES (?)',JSON.stringify([label]));
        MindwtrHost.attachmentDraftDiscardRetire=(json,keep,retire)=>{
          Promise.resolve().then(()=>trace('microtask'));
          return original(json,()=>keep(),()=>{trace('callback-before');const value=retire();trace('callback-after');return value;});
        };
        """)
        let jobs = NativeAttachmentHostHooks()
        jobs.configureJobs = { jobs in jobs.afterRetirementUnlink = { _ = try self.sql("INSERT INTO fixture_trace(label) VALUES ('native-unlink')") } }
        let host = try await seed(jobs: jobs), retained = try await detach(host), files = try protectedBytes()
        _ = try sql("CREATE TABLE fixture_trace(id INTEGER PRIMARY KEY,label TEXT NOT NULL)")
        let saved = try domain()
        _ = try await finish(host, retained)
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT label FROM fixture_trace ORDER BY id").utf8)) as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["label"] as? String }, ["callback-before", "native-unlink", "callback-after", "microtask"])
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testActualReadinessFlagsAndUnfinishedSharedSlotRefuseBeforeNativeCallback() async throws {
        for mode in ["slot", "loading", "failed", "edit-lock"] {
            let previous = try isolate(); defer { root = previous }
            let hold: String
            switch mode {
            case "slot": hold = "__task243Slots.set('task243-held',{done:false});"
            case "loading": hold = "__task243Store.setState({isLoading:true});"
            case "failed": hold = "__task243Store.setState({persistenceFailure:'Private.txt'});"
            default: hold = "__task243Store.setState({editLockCount:1});"
            }
            try probeBundle("const original=MindwtrHost.attachmentDraftDiscardRetire; MindwtrHost.attachmentDraftDiscardRetire=(json,keep,retire)=>{\(hold)return original(json,keep,retire);};", exposeState: true)
            let host = try await seed(), retained = try await detach(host), files = try protectedBytes(), saved = try domain(), target = try XCTUnwrap(targets(retained).first), bytes = try Data(contentsOf: target)
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertNil(try journalObject()["terminal"]); XCTAssertNotNil(try store.read())
            await host.close(); bundle = originalBundle; let cold = core(noDomainWrites()); _ = try await cold.start()
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
        }
    }

    func testActualSuccessfulSharedReferenceWriteAfterPlanningIsKeptAtFinalCallback() async throws {
        let host = try await seed(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.first)
        let target = try XCTUnwrap(URL(string: op.targetURI)), bytes = try Data(contentsOf: target), files = try protectedBytes()
        let request = try json(["id": referenceID, "base": [:], "patch": [:],
            "scheduleBase": ["startTime": NSNull(), "dueDate": NSNull(), "relativeStartOffset": NSNull(), "reviewAt": NSNull()],
            "attachments": ["base": [], "value": [metadata(op)]]] as [String: Any])
        let literal = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
        await host.close()
        try probeBundle("""
        const candidates=MindwtrHost.attachmentDraftDiscardCandidates, poll=MindwtrHost.poll;
        const gates=new Map();let calls=0;
        MindwtrHost.attachmentDraftDiscardCandidates=json=>{
          const ticket=candidates(json);
          if(++calls===2)gates.set(ticket,MindwtrHost.saveDraft(\(literal)));
          return ticket;
        };
        MindwtrHost.poll=ticket=>{
          const gate=gates.get(ticket);
          if(gate){const reply=poll(gate);if(!reply)return null;
            if(!JSON.parse(reply).ok)throw Error('Fixture shared reference write failed');gates.delete(ticket);}
          return poll(ticket);
        };
        """)
        let faults = HostIOFaults(), cold = core(faults); _ = try await cold.start()
        var afterReference: String?
        await boundary(.beforeDiscardTarget(0), on: cold) {
            // This is the real shared ordinary Save, fully acknowledged before
            // the final live callback. Only subsequent Discard SQL is forbidden.
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(self.sql("SELECT attachments FROM tasks WHERE id=?", [self.referenceID]).utf8)) as? [[String: Any]])
            let attachments = try self.object("{\"value\":" + XCTUnwrap(rows.first?["attachments"] as? String) + "}")
            let values = try XCTUnwrap(attachments["value"] as? [[String: Any]])
            XCTAssertEqual(values.first?["uri"] as? String, op.targetURI)
            afterReference = try self.domain()
            faults.beforeSQL = self.noDomainWrites().beforeSQL
        }
        let operations = try resultOperations(await finish(cold, retained), record: retained)
        XCTAssertEqual(operations.first?["target"] as? String, "referenced")
        XCTAssertEqual(try domain(), try XCTUnwrap(afterReference)); XCTAssertEqual(try Data(contentsOf: target), bytes)
        try released(); try sameFiles(files)
    }

    private final class LockedFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        func set(_ value: Bool) { lock.lock(); self.value = value; lock.unlock() }
        func take() -> Bool { lock.lock(); defer { lock.unlock() }; let result = value; value = false; return result }
    }
    func testCancelledHeldRetirementDrainsAndKeepsLibraryLockUntilWorkerFinishes() async throws {
        let jobs = NativeAttachmentHostHooks(), armed = LockedFlag()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        jobs.configureJobs = { jobs in jobs.beforeWork = { _, installer in
            if !installer && armed.take() { entered.signal(); release.wait() }
        } }
        let host = try await seed(jobs: jobs), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
        let target = try XCTUnwrap(targets(retained).first), bytes = try Data(contentsOf: target), evidence = try Data(contentsOf: store.url)
        armed.set(true)
        let operation = Task { try await self.finish(host, retained) }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        operation.cancel()
        let closing = Task { await host.close(); closed.signal() }
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        let replacement = core(noDomainWrites()); await failure { _ = try await replacement.start() }
        release.signal()
        await failure { _ = try await operation.value }
        await closing.value
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try Data(contentsOf: store.url), evidence)
        XCTAssertNil(try journalObject()["terminal"]); XCTAssertEqual(try domain(), saved); try sameFiles(files)
        _ = try await replacement.start()
        try released(); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); XCTAssertEqual(try domain(), saved); try sameFiles(files)
    }

    func testStagePreparedEmptyPartialFullV1V2RetireOnlyPrivateStageWithSourceGoneAndPublishedPrefix() async throws {
        for version in [1, 2] { for content in ["empty", "partial", "full"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stagePrepared(version: version, prefix: 1, content: content), retained = try await detach(host)
            let last = try XCTUnwrap(retained.operations.last), proof = try XCTUnwrap(last.stage)
            let stage = try XCTUnwrap(URL(string: proof.uri)), target = try XCTUnwrap(URL(string: last.targetURI))
            let frozen = try encoded(retained.operations), baseline = managed.appendingPathComponent("baseline.txt")
            let baselineBytes = try Data(contentsOf: baseline), saved = try domain()
            let foreign = try Data(contentsOf: cache.appendingPathComponent("borrowed.txt"))
            try foreign.write(to: target); let targetIdentity = try inode(target)
            XCTAssertNotEqual(targetIdentity, proof.identity)
            try FileManager.default.removeItem(at: cache.appendingPathComponent("borrowed.txt"))
            await host.close()
            // A stage-only entry must not use even the trusted public-target callback.
            try probeBundle("const h=MindwtrHost,f=h.attachmentDraftDiscardRetire;h.attachmentDraftDiscardRetire=function(j,k,r){if(JSON.parse(j).requestId==='\(last.requestId)')throw new Error('Unexpected stage target query');return f.call(h,j,k,r)}")
            let cold = core(noDomainWrites()); _ = try await cold.start()
            let hooks = AttachmentDraftHostHooks()
            hooks.boundary = { point in
                if point == .beforeDiscardTarget(1) || point == .afterDiscardTarget(1) { XCTFail("Stage-only target must remain untouched") }
                if point == .beforeDiscardStage(1) { XCTAssertEqual(try self.encoded(self.record().operations), frozen) }
            }
            await cold.configureAttachmentDraftHost(hooks)
            let result = try await finish(cold, retained), operations = try resultOperations(result, record: retained)
            XCTAssertEqual(try object(result)["version"] as? Int, 2)
            XCTAssertEqual(operations.first?["target"] as? String, "removed")
            XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "removed")
            XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), targetIdentity)
            XCTAssertEqual(try Data(contentsOf: baseline), baselineBytes); XCTAssertEqual(try domain(), saved)
            XCTAssertFalse(FileManager.default.fileExists(atPath: cache.appendingPathComponent("borrowed.txt").path))
            try released(); await cold.close()
        } }
    }

    func testStagePreparedColdFinishBoundariesAndRecordedMissingKeepTargetUntouched() async throws {
        let points: [AttachmentDraftBoundary] = [.afterDiscardFinishJournal, .beforeDiscardStage(0), .afterDiscardStage(0),
            .beforeDiscardTerminal, .afterDiscardTerminal, .beforeDiscardRelease, .afterDiscardRelease,
            .beforeDiscardJournalClear, .afterDiscardJournalClear]
        for point in points {
            let previous = try isolate(); defer { root = previous }
            let host = try await stagePrepared(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), target = try XCTUnwrap(URL(string: op.targetURI))
            let foreign = Data("Foreign public target sentinel".utf8); try foreign.write(to: target)
            let targetIdentity = try inode(target), files = try protectedBytes(), saved = try domain(), frozen = try encoded(retained.operations)
            await boundary(point, on: host); await failure { _ = try await self.finish(host, retained) }
            if let actual = try store.read() { XCTAssertEqual(try encoded(actual.operations), frozen) }
            if FileManager.default.fileExists(atPath: journal.path) { XCTAssertEqual(try wrapper(journalObject())["version"] as? Int, 2) }
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), targetIdentity)
            await host.close(); let cold = core(noDomainWrites()); _ = try await cold.start()
            try released(); XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), targetIdentity)
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
        let previous = try isolate(); defer { root = previous }
        let host = try await stagePrepared(), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
        let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri)))
        try FileManager.default.removeItem(at: stage.deletingLastPathComponent())
        let saved = try domain(), files = try protectedBytes()
        let operations = try resultOperations(await finish(host, retained), record: retained)
        XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "missing")
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: op.targetURI)).path))
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testStagePreparedProofAndNamespaceConflictsRetainExactEvidenceAndForeignBytes() async throws {
        for mode in ["stage", "namespace", "root", "missing-root", "hardlink", "symlink", "extra"] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stagePrepared(content: "full"), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let stage = try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))), namespace = stage.deletingLastPathComponent()
            let target = try XCTUnwrap(URL(string: op.targetURI)), foreign = Data("Untouched public bytes".utf8)
            try foreign.write(to: target)
            let evidence = try Data(contentsOf: store.url), saved = try domain(), source = cache.appendingPathComponent("borrowed.txt")
            let sourceBytes = try Data(contentsOf: source), baselineBytes = try Data(contentsOf: managed.appendingPathComponent("baseline.txt"))
            var keptStage = stage, keptTarget = target, keptBaseline = managed.appendingPathComponent("baseline.txt")
            let unknown = namespace.appendingPathComponent("unknown"), unknownBytes = Data("Unknown child".utf8)
            var unknownIdentity: String?
            await boundary(.beforeDiscardStage(0), on: host) {
                switch mode {
                case "stage", "symlink":
                    keptStage = self.root.appendingPathComponent("retained-stage")
                    try FileManager.default.moveItem(at: stage, to: keptStage)
                    if mode == "symlink" { try FileManager.default.createSymbolicLink(at: stage, withDestinationURL: source) }
                    else { try sourceBytes.write(to: stage) }
                case "namespace":
                    let moved = self.root.appendingPathComponent("retained-namespace", isDirectory: true)
                    try FileManager.default.moveItem(at: namespace, to: moved); keptStage = moved.appendingPathComponent("stage")
                    try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: false)
                    try sourceBytes.write(to: stage)
                case "root", "missing-root":
                    let moved = self.root.appendingPathComponent("retained-managed", isDirectory: true)
                    try FileManager.default.moveItem(at: self.managed, to: moved)
                    keptStage = moved.appendingPathComponent(namespace.lastPathComponent).appendingPathComponent("stage")
                    keptTarget = moved.appendingPathComponent(target.lastPathComponent); keptBaseline = moved.appendingPathComponent("baseline.txt")
                    if mode == "root" {
                        try FileManager.default.createDirectory(at: self.managed, withIntermediateDirectories: false)
                        try foreign.write(to: target)
                    }
                case "hardlink": XCTAssertEqual(Darwin.link(stage.path, self.root.appendingPathComponent("stage-alias").path), 0)
                default: try unknownBytes.write(to: unknown); unknownIdentity = try self.inode(unknown)
                }
            }
            await failure { _ = try await self.finish(host, retained) }
            XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertNil(try journalObject()["terminal"])
            let pendingEvidence = try journalEvidence()
            if mode == "extra" {
                // Retirement is not rollback: the exact owned stage was unlinked
                // before rmdir refused the unknown child. No full result is owed.
                var info = stat(); XCTAssertEqual(lstat(keptStage.path, &info), -1); XCTAssertEqual(errno, ENOENT)
                XCTAssertEqual(try inode(namespace), op.stage?.privateDirectoryIdentity)
                XCTAssertEqual(try Data(contentsOf: unknown), unknownBytes); XCTAssertEqual(try inode(unknown), unknownIdentity)
            } else { XCTAssertEqual(try Data(contentsOf: keptStage), sourceBytes) }
            XCTAssertEqual(try Data(contentsOf: keptTarget), foreign)
            XCTAssertEqual(try Data(contentsOf: keptBaseline), baselineBytes); XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
            if mode == "missing-root" { XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)) }
            await host.close(); let cold = core(noDomainWrites()); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: store.url), evidence); XCTAssertNil(try journalObject()["terminal"])
            XCTAssertEqual(try journalEvidence(), pendingEvidence)
            if mode == "extra" {
                var info = stat(); XCTAssertEqual(lstat(keptStage.path, &info), -1); XCTAssertEqual(errno, ENOENT)
                XCTAssertEqual(try inode(namespace), op.stage?.privateDirectoryIdentity)
                XCTAssertEqual(try Data(contentsOf: unknown), unknownBytes); XCTAssertEqual(try inode(unknown), unknownIdentity)
            } else { XCTAssertEqual(try Data(contentsOf: keptStage), sourceBytes) }
            XCTAssertEqual(try Data(contentsOf: keptTarget), foreign)
            XCTAssertEqual(try Data(contentsOf: keptBaseline), baselineBytes); XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
            XCTAssertEqual(try domain(), saved)
            if mode == "missing-root" { XCTAssertFalse(FileManager.default.fileExists(atPath: managed.path)) }
            await cold.close()
        }
    }

    func testStagePreparedVersionAndUntouchedCorrespondenceRefuseBeforeJobs() async throws {
        for mode in ["v1-stage", "v2-published", "v2-empty", "v1-untouched", "v2-result-v1", "v2-prefix-untouched", "v2-last-removed"] {
            let previous = try isolate(); defer { root = previous }
            let published = ["v2-published", "v2-empty", "v1-untouched"].contains(mode)
            let host: CoreHost
            if published { host = try await seed(adds: mode == "v2-empty" ? 0 : 1) }
            else { host = try await stagePrepared(prefix: 1) }
            let retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
            await host.close(); var command = try journalObject(), value = try wrapper(command)
            if mode == "v1-stage" { value["version"] = 1 }
            if mode == "v2-published" || mode == "v2-empty" { value["version"] = 2 }
            if ["v1-untouched", "v2-result-v1", "v2-prefix-untouched", "v2-last-removed"].contains(mode) {
                let resultVersion = mode == "v1-untouched" || mode == "v2-result-v1" ? 1 : 2
                let result: [String: Any] = ["version": resultVersion, "status": "released", "sessionID": retained.session.sessionID,
                    "requestId": try XCTUnwrap(retained.discard?.requestId), "operations": retained.operations.enumerated().map { index, op in
                        ["requestId": op.requestId, "target": mode == "v2-last-removed" ? "removed"
                            : mode == "v2-prefix-untouched" || index == retained.operations.count - 1 ? "untouched" : "removed", "stage": "removed"]
                    }]
                command["terminal"] = ["success": ["_0": try json(result)]]
            }
            try setWrapper(value, in: &command); try writeJournal(command)
            let journalBytes = try Data(contentsOf: journal), sidecarBytes = try Data(contentsOf: store.url)
            let lastStage = try retained.operations.last?.stage.map { try XCTUnwrap(URL(string: $0.uri)) }
            let stageBytes = try lastStage.flatMap { FileManager.default.fileExists(atPath: $0.path) ? try Data(contentsOf: $0) : nil }
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Version/proof mismatch must start no job"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: journal), journalBytes); XCTAssertEqual(try Data(contentsOf: store.url), sidecarBytes)
            if let lastStage, let stageBytes { XCTAssertEqual(try Data(contentsOf: lastStage), stageBytes) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testStagePreparedDurableTerminalPresentOrAbsentSidecarReleasesWithoutAnyNewFileOrReferenceWork() async throws {
        for absent in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await stagePrepared(prefix: 1), retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(absent ? .afterDiscardRelease : .afterDiscardTerminal, on: host)
            await failure { _ = try await self.finish(host, retained) }
            let command = try journalObject(), terminal = try XCTUnwrap(command["terminal"] as? [String: Any])
            let success = try XCTUnwrap(terminal["success"] as? [String: Any]), result = try XCTUnwrap(success["_0"] as? String)
            let operations = try resultOperations(result, record: retained)
            XCTAssertEqual(try object(result)["version"] as? Int, 2); XCTAssertEqual(operations.last?["target"] as? String, "untouched")
            XCTAssertEqual(operations.last?["stage"] as? String, "removed"); XCTAssertEqual(try store.read() == nil, absent)
            await host.close()
            let foreign = Data("New foreign replacement after terminal".utf8)
            for target in try targets(retained) { try foreign.write(to: target) }
            try probeBundle("const h=MindwtrHost;h.attachmentDraftDiscardCandidates=function(){throw new Error('Unexpected terminal plan')};h.attachmentDraftDiscardRetire=function(){throw new Error('Unexpected terminal reference')}")
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Durable v2 terminal must start no file job"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
            try released(); for target in try targets(retained) { XCTAssertEqual(try Data(contentsOf: target), foreign) }
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testUnstartedV1V2NormalCrashWindowsDiscardLogicallyWithoutNamespaceOrSourceWork() async throws {
        for version in [1, 2] { for point in [AttachmentDraftBoundary.afterIntent, .afterReservation, .beforeStageProof] {
            let previous = try isolate(); defer { root = previous }
            let host = try await unstarted(version: version, point: point), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let namespace = unclaimedNamespace(op), stage = namespace.appendingPathComponent("stage")
            let existing = point != .afterIntent
            let namespaceIdentity = existing ? try inode(namespace) : nil, stageIdentity = existing ? try inode(stage) : nil
            if existing { XCTAssertEqual(try Data(contentsOf: stage).count, 0) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: namespace.path)) }
            let target = try XCTUnwrap(URL(string: op.targetURI)), foreign = Data("Foreign public bytes".utf8)
            try foreign.write(to: target); let targetIdentity = try inode(target)
            let saved = try domain(), files = try protectedBytes(); await host.close()
            try probeBundle("MindwtrHost.attachmentDraftDiscardRetire=()=>{throw Error('Intent must not query target')}")
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Last intent must submit no file work"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
            let beforeLog = try diagnosticText(), result = try await finish(cold, retained)
            let operations = try resultOperations(result, record: retained, status: "discarded")
            XCTAssertEqual(try object(result)["version"] as? Int, 3)
            XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "unclaimed")
            if existing {
                XCTAssertEqual(try inode(namespace), namespaceIdentity); XCTAssertEqual(try inode(stage), stageIdentity)
                XCTAssertEqual(try Data(contentsOf: stage).count, 0)
            } else { XCTAssertFalse(FileManager.default.fileExists(atPath: namespace.path)) }
            XCTAssertEqual(try Data(contentsOf: target), foreign); XCTAssertEqual(try inode(target), targetIdentity)
            try sameFiles(files); XCTAssertEqual(try domain(), saved); try released()
            let log = try diagnosticText()
            XCTAssertEqual(log.components(separatedBy: "\"operation\":\"discard-unstarted\"").count,
                           beforeLog.components(separatedBy: "\"operation\":\"discard-unstarted\"").count + 1)
            XCTAssertEqual(log.components(separatedBy: "\"operation\":\"discard-finish\"").count,
                           beforeLog.components(separatedBy: "\"operation\":\"discard-finish\"").count)
            XCTAssertTrue(log.contains("v1.3.5/ios-unstarted-add-discard")); XCTAssertFalse(log.contains("Private.txt"))
            XCTAssertFalse(log.contains("file:///")); await cold.close()
        } }
    }

    func testUnstartedForeignModifiedAndExternallyRolledBackNonemptyNamespacesRemainUnclaimed() async throws {
        for mode in ["preexisting", "modified", "external-rollback"] {
            let previous = try isolate(); defer { root = previous }
            var host = try await unstarted(point: mode == "modified" ? .afterReservation : .afterIntent)
            let original = try record(), op = try XCTUnwrap(original.operations.last), namespace = unclaimedNamespace(op), stage = namespace.appendingPathComponent("stage")
            let oldIntent = try Data(contentsOf: store.url), foreign = Data("Unknown nonempty private content".utf8)
            if mode == "external-rollback" {
                await boundary(.beforeFilled, on: host)
                await failure { _ = try await host.recoverAttachmentDraft(expectedSession: original.session.sessionID) }
                XCTAssertEqual(try record().operations.last?.phase, .stagePrepared)
                XCTAssertEqual(try Data(contentsOf: stage), try Data(contentsOf: cache.appendingPathComponent("borrowed.txt")))
                await host.close()
                // External historical rollback is not a Store-authorized downgrade.
                // Logical Discard neither claims nor deletes these actual filled bytes.
                try oldIntent.write(to: store.url)
                host = core(noDomainWrites()); _ = try await host.start()
            } else {
                if mode == "preexisting" { try FileManager.default.createDirectory(at: namespace, withIntermediateDirectories: false) }
                try foreign.write(to: stage)
                if mode == "preexisting" {
                    await failure { _ = try await host.recoverAttachmentDraft(expectedSession: original.session.sessionID) }
                    XCTAssertEqual(try record().operations.last?.phase, .intent)
                    XCTAssertEqual(try record().operations.last?.reason, .interruptedReservation)
                }
            }
            try Data("Unknown second child".utf8).write(to: namespace.appendingPathComponent("unknown"))
            let retained = try await detach(host), bytes = try Data(contentsOf: stage), identity = try inode(stage), namespaceIdentity = try inode(namespace)
            let unknown = namespace.appendingPathComponent("unknown"), unknownBytes = try Data(contentsOf: unknown), unknownIdentity = try inode(unknown)
            let saved = try domain(), files = try protectedBytes(); await host.close()
            let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Unknown intent namespace must never be adopted or swept"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
            let operations = try resultOperations(await finish(cold, retained), record: retained, status: "discarded")
            XCTAssertEqual(operations.last?["stage"] as? String, "unclaimed")
            XCTAssertEqual(try Data(contentsOf: stage), bytes); XCTAssertEqual(try inode(stage), identity); XCTAssertEqual(try inode(namespace), namespaceIdentity)
            XCTAssertEqual(try Data(contentsOf: unknown), unknownBytes); XCTAssertEqual(try inode(unknown), unknownIdentity)
            try sameFiles(files); XCTAssertEqual(try domain(), saved); try released(); await cold.close()
        }
    }

    func testUnstartedPendingColdReplayReobservesPrefixReferenceAndTerminalSkipsEveryJob() async throws {
        let host = try await unstarted(prefix: 1, point: .afterReservation), retained = try await detach(host)
        let prefix = retained.operations[0], last = try XCTUnwrap(retained.operations.last), target = try XCTUnwrap(URL(string: prefix.targetURI))
        let namespace = unclaimedNamespace(last), stage = namespace.appendingPathComponent("stage")
        try Data("Unknown intent bytes after empty creation".utf8).write(to: stage)
        let stageBytes = try Data(contentsOf: stage), stageIdentity = try inode(stage), namespaceIdentity = try inode(namespace), files = try protectedBytes()
        await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
        XCTAssertNil(try journalObject()["terminal"]); XCTAssertEqual(try wrapper(journalObject())["version"] as? Int, 3)
        await host.close()
        _ = try sql("UPDATE tasks SET attachments=?,updatedAt=?,rev=rev+1 WHERE id=?", [json([metadata(prefix)]), "2026-10-05T13:00:00.000Z", referenceID])
        let saved = try domain(), targetBytes = try Data(contentsOf: target), targetIdentity = try inode(target)
        let cold = core(noDomainWrites()); await boundary(.afterDiscardRelease, on: cold)
        await failure { _ = try await cold.start() }
        let terminal = try XCTUnwrap(journalObject()["terminal"] as? [String: Any])
        let success = try XCTUnwrap(terminal["success"] as? [String: Any]), result = try XCTUnwrap(success["_0"] as? String)
        let operations = try resultOperations(result, record: retained, status: "discarded")
        XCTAssertEqual(operations.first?["target"] as? String, "referenced"); XCTAssertEqual(operations.first?["stage"] as? String, "missing")
        XCTAssertEqual(operations.last?["target"] as? String, "untouched"); XCTAssertEqual(operations.last?["stage"] as? String, "unclaimed")
        XCTAssertNil(try store.read()); await cold.close()
        try probeBundle("const h=MindwtrHost;h.attachmentDraftDiscardCandidates=()=>{throw Error('No terminal plan')};h.attachmentDraftDiscardRetire=()=>{throw Error('No terminal query')}")
        let terminalOwner = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
        jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Logical terminal must start no new job"); throw HostFailure("Unexpected job") } }
        try await terminalOwner.configureAttachmentHost(jobs); _ = try await terminalOwner.start()
        XCTAssertEqual(try Data(contentsOf: stage), stageBytes); XCTAssertEqual(try inode(stage), stageIdentity); XCTAssertEqual(try inode(namespace), namespaceIdentity)
        XCTAssertEqual(try Data(contentsOf: target), targetBytes); XCTAssertEqual(try inode(target), targetIdentity)
        try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testUnstartedColdJournalTerminalReleaseAndClearBoundariesLeaveUnknownNamespaceUntouched() async throws {
        for point in [AttachmentDraftBoundary.afterDiscardFinishJournal, .beforeDiscardTerminal, .afterDiscardTerminal,
                      .beforeDiscardRelease, .afterDiscardRelease, .beforeDiscardJournalClear, .afterDiscardJournalClear] {
            let previous = try isolate(); defer { root = previous }
            let host = try await unstarted(point: .afterReservation), retained = try await detach(host), op = try XCTUnwrap(retained.operations.last)
            let namespace = unclaimedNamespace(op), stage = namespace.appendingPathComponent("stage"), bytes = Data("Unclaimed bytes".utf8)
            try bytes.write(to: stage); let identity = try inode(stage), namespaceIdentity = try inode(namespace), saved = try domain(), files = try protectedBytes()
            await boundary(point, on: host); await failure { _ = try await self.finish(host, retained) }
            if FileManager.default.fileExists(atPath: journal.path) {
                XCTAssertEqual(try wrapper(journalObject())["version"] as? Int, 3)
                XCTAssertLessThan(try Data(contentsOf: journal).count, 32 * 1024)
            }
            await host.close(); let cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Intent replay must submit no job"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); _ = try await cold.start()
            XCTAssertEqual(try Data(contentsOf: stage), bytes); XCTAssertEqual(try inode(stage), identity); XCTAssertEqual(try inode(namespace), namespaceIdentity)
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
    }

    func testUnstartedHeldPrepareCancellationDrainsBeforeLibraryReleaseForBothFormats() async throws {
        for version in [1, 2] { for completed in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let jobs = NativeAttachmentHostHooks(), armed = LockedFlag()
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
            jobs.configureJobs = { jobs in
                let hold: (String, Bool) -> Void = { _, installer in if installer && armed.take() { entered.signal(); release.wait() } }
                if completed { jobs.afterWork = hold }
                else { jobs.beforeWork = { id, installer in hold(id, installer) } }
            }
            let host = try await seed(version: version, adds: 0, jobs: jobs), before = try latest(), files = try protectedBytes(), saved = try domain()
            // The completed prepare may win cancellation. A real pre-proof crash
            // separately retains intent; cancellation is never claimed rollback.
            if completed { await boundary(.beforeStageProof, on: host) }
            let request = try json(["version": 1, "requestId": UUID().uuidString.lowercased(), "sessionID": before.sessionID,
                "generation": before.generation, "picked": ["uri": cache.appendingPathComponent("borrowed.txt").absoluteString,
                    "name": "Private.txt", "mimeType": "text/plain", "size": NSNull()]] as [String: Any])
            armed.set(true); let operation = Task { try await host.addAttachmentDraft(requestJSON: request) }
            XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
            let intent = try record(), last = try XCTUnwrap(intent.operations.last), namespace = unclaimedNamespace(last), stage = namespace.appendingPathComponent("stage")
            XCTAssertEqual(last.phase, .intent); XCTAssertNil(last.stage)
            if completed { XCTAssertEqual(try Data(contentsOf: stage).count, 0) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: namespace.path)) }
            operation.cancel(); let closing = Task { await host.close(); closed.signal() }
            XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
            let replacement = core(noDomainWrites()); await failure { _ = try await replacement.start() }
            release.signal(); await failure { _ = try await operation.value }; await closing.value
            XCTAssertEqual(try record().operations.last?.phase, .intent); XCTAssertNil(try record().operations.last?.stage)
            _ = try await replacement.start(); let retained = try await detach(replacement)
            let operations = try resultOperations(await finish(replacement, retained), record: retained, status: "discarded")
            XCTAssertEqual(operations.last?["stage"] as? String, "unclaimed")
            if completed { XCTAssertEqual(try Data(contentsOf: stage).count, 0) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: namespace.path)) }
            try released(); try sameFiles(files); XCTAssertEqual(try domain(), saved); await replacement.close()
        } }
    }

    func testUnstartedVersionProofOutcomeConfusionAndExistingWriterGatesStaySealed() async throws {
        for mode in ["intent-stage", "intent-filled", "v3-stagePrepared", "v3-published", "v3-empty", "released", "last-removed", "last-missing", "v2-unclaimed", "prefix-unclaimed"] {
            let previous = try isolate(); defer { root = previous }
            let host: CoreHost
            if mode == "v3-stagePrepared" { host = try await stagePrepared() }
            else if mode == "v3-published" || mode == "v3-empty" { host = try await seed(adds: mode == "v3-empty" ? 0 : 1) }
            else { host = try await unstarted(prefix: mode == "prefix-unclaimed" ? 1 : 0) }
            let retained = try await detach(host), files = try protectedBytes(), saved = try domain()
            await boundary(.afterDiscardFinishJournal, on: host); await failure { _ = try await self.finish(host, retained) }
            await host.close(); var command = try journalObject(), value = try wrapper(command)
            value["version"] = mode == "v2-unclaimed" ? 2 : 3
            if mode == "intent-stage" || mode == "intent-filled" {
                var raw = try object(String(decoding: Data(contentsOf: store.url), as: UTF8.self))
                var operations = try XCTUnwrap(raw["operations"] as? [[String: Any]]), last = try XCTUnwrap(operations.last)
                if mode == "intent-stage" {
                    last["stage"] = ["uri": unclaimedNamespace(try XCTUnwrap(retained.operations.last)).appendingPathComponent("stage").absoluteString,
                        "identity": "1:2", "directoryIdentity": "1:3", "privateDirectoryIdentity": "1:4"]
                } else {
                    last["filled"] = ["sha256": String(repeating: "a", count: 64), "size": 0, "identity": "1:2"] as [String: Any]
                }
                operations[operations.count - 1] = last; raw["operations"] = operations; try Data(json(raw).utf8).write(to: store.url)
            } else if ["released", "last-removed", "last-missing", "v2-unclaimed", "prefix-unclaimed"].contains(mode) {
                let result: [String: Any] = ["version": mode == "v2-unclaimed" ? 2 : 3, "status": mode == "released" || mode == "v2-unclaimed" ? "released" : "discarded",
                    "sessionID": retained.session.sessionID, "requestId": try XCTUnwrap(retained.discard?.requestId),
                    "operations": retained.operations.enumerated().map { index, op in
                        let last = index == retained.operations.count - 1
                        return ["requestId": op.requestId, "target": last ? (mode == "last-removed" ? "removed" : "untouched") : "removed",
                            "stage": last ? (mode == "last-missing" ? "missing" : "unclaimed") : (mode == "prefix-unclaimed" ? "unclaimed" : "missing")]
                    }]
                command["terminal"] = ["success": ["_0": try json(result)]]
            }
            try setWrapper(value, in: &command); try writeJournal(command)
            let evidence = try Data(contentsOf: journal), sidecar = try Data(contentsOf: store.url), cold = core(noDomainWrites()), jobs = NativeAttachmentHostHooks()
            jobs.configureJobs = { jobs in jobs.beforeWork = { _, _ in XCTFail("Forged logical disposition must start no work"); throw HostFailure("Unexpected job") } }
            try await cold.configureAttachmentHost(jobs); await failure { _ = try await cold.start() }
            XCTAssertEqual(try Data(contentsOf: journal), evidence); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
            try sameFiles(files); XCTAssertEqual(try domain(), saved); await cold.close()
        }
        let previous = try isolate(); defer { root = previous }
        let host = try await unstarted(), retained = try await detach(host), sidecar = try Data(contentsOf: store.url), files = try protectedBytes(), saved = try domain()
        for method in ["saveDraft", "taskDelete", "attachmentOwnedDiscardFinish", "fileDelete"] {
            await failure { _ = try await host.call(method, argumentsJSON: "[\"{}\"]") }
        }
        do { _ = try await host.prepareBackupImport(cache.appendingPathComponent("borrowed.txt")); XCTFail("Import must remain gated") }
        catch { XCTAssertEqual(error.localizedDescription, "Attachment draft ownership requires exact recovery") }
        try writeJournal(["version": 2, "method": "saveDraft", "argumentsJSON": "[\"{}\"]"])
        let pendingBytes = try Data(contentsOf: journal)
        await failure { _ = try await self.finish(host, retained) }
        XCTAssertEqual(try Data(contentsOf: journal), pendingBytes); XCTAssertEqual(try Data(contentsOf: store.url), sidecar)
        try sameFiles(files); XCTAssertEqual(try domain(), saved)
    }

    func testUnstartedMaximumFixedJournalEnvelopeRemainsIndependentOfSidecarCapacity() throws {
        // Production never embeds the opaque sidecar in this journal. This uses
        // its exact bounded field/enum shape and the real JSONEncoder escaping.
        enum Terminal: Codable { case success(String) }
        struct Command: Encodable { let version: Int; let method: String; let argumentsJSON: String; let terminal: Terminal? }
        let session = UUID().uuidString.lowercased(), id = UUID().uuidString.lowercased(), ids = (0..<128).map { _ in UUID().uuidString.lowercased() }
        let wrapper = try json(["version": 3, "sessionID": session, "requestId": id, "recordSHA256": String(repeating: "f", count: 64), "operationIDs": ids] as [String: Any])
        let result = try json(["version": 3, "status": "discarded", "sessionID": session, "requestId": id,
            "operations": ids.enumerated().map { index, value in ["requestId": value, "target": index == 127 ? "untouched" : "referenced", "stage": index == 127 ? "unclaimed" : "removed"] }] as [String: Any])
        let args = String(decoding: try JSONEncoder().encode([wrapper]), as: UTF8.self)
        XCTAssertLessThan(result.utf8.count, 64 * 1024)
        for terminal in [nil, Terminal.success(result)] {
            let command = Command(version: 2, method: "attachmentOwnedDiscardFinish", argumentsJSON: args, terminal: terminal)
            XCTAssertLessThan(try JSONEncoder().encode(command).count, 32 * 1024)
        }
    }
}
