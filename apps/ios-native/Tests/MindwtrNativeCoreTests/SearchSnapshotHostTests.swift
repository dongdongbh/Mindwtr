import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class SearchSnapshotHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let at = "2026-10-09T12:00:00.000Z"
    private let taskID = "opaque synthetic task/漢+😀", projectID = "synthetic-project"

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("SearchSnapshotHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    }
    private func fixtureBundle(suffix: String = "") throws -> URL {
        let url = root.appendingPathComponent("clock-\(UUID().uuidString).js")
        let clock = """
        (() => {
          const NativeDate = Date, instant = NativeDate.parse('\(at)');
          globalThis.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [instant])); }
            static now() { return instant; }
          };
        })();
        """
        try (clock + "\n" + String(contentsOf: bundle, encoding: .utf8) + "\n" + suffix).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
    private func host(_ faults: HostIOFaults = HostIOFaults(), bundleURL: URL? = nil) throws -> CoreHost {
        let selectedBundle = try bundleURL ?? fixtureBundle()
        let core = CoreHost(databaseURL: database, bundleURL: selectedBundle, faults: faults)
        addTeardownBlock { await core.close() }
        return core
    }
    private func seed() async throws {
        let bootstrap = try host(); _ = try await bootstrap.start(); await bootstrap.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        for (id, status, deleted) in [(projectID, "active", false), ("synthetic-archived", "archived", false), ("synthetic-deleted", "active", true)] {
            _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,isSequential,isFocused,supportNotes,createdAt,updatedAt,deletedAt,rev,revBy) VALUES (?,'Synthetic project 漢',?,'#123456',0,'[]',0,0,'Synthetic private project notes',?,?,?,4,'fixture')",
                                parametersJSON: json([id, status, at, at, deleted ? at as Any : NSNull()]))
        }
        for index in 0..<60 { try task(sql, id: "synthetic-inbox-\(index)", title: "Synthetic inbox \(index)", status: "inbox") }
        try task(sql, id: taskID, title: "Synthetic title 漢😀e\u{0301}", status: "next", project: projectID, due: "2026-10-09", start: "2026-10-08")
        for id in ["é", "e\u{0301}", "Task", "task"] { try task(sql, id: id, title: "Same synthetic title", status: "waiting") }
        try task(sql, id: "synthetic-someday", title: "Synthetic deferred", status: "someday", start: "2036-10-09")
        try task(sql, id: "synthetic-future-next", title: "Synthetic future action", status: "next", start: "2036-10-09")
        for status in ["done", "reference", "archived"] { try task(sql, id: "synthetic-" + status, title: "Synthetic excluded", status: status) }
        try task(sql, id: "synthetic-task-deleted", title: "Synthetic excluded", status: "next", deleted: true)
        try task(sql, id: "synthetic-task-archived-project", title: "Synthetic excluded", status: "next", project: "synthetic-archived")
        try task(sql, id: "synthetic-task-deleted-project", title: "Synthetic excluded", status: "next", project: "synthetic-deleted")
    }
    private func task(_ sql: SQLiteBridge, id: String, title: String, status: String,
                      project: String? = nil, due: String? = nil, start: String? = nil, deleted: Bool = false) throws {
        _ = try sql.execute("INSERT INTO tasks(id,title,status,projectId,contexts,tags,description,dueDate,startTime,createdAt,updatedAt,deletedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,?,?,'[]','[]','Synthetic private notes',?,?,?,?,?,3,'fixture',0,0,0,0)",
                            parametersJSON: json([id, title, status, project as Any? ?? NSNull(), due as Any? ?? NSNull(), start as Any? ?? NSNull(), at, at, deleted ? at as Any : NSNull()]))
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        var result: [String: String] = [:]
        for table in ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"] {
            result[table] = try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + table + " ORDER BY rowid", parametersJSON: "[]").utf8)))
        }
        return result
    }
    private func refused(_ action: () async throws -> NativeSearchSnapshot) async {
        do { _ = try await action(); XCTFail("Expected unavailable snapshot") }
        catch { XCTAssertTrue(error is HostFailure || error is CoreHostRejection || error is CancellationError) }
    }

    func testActualCanonicalSnapshotIsIndependentOfPageAndPreservesAllStorage() async throws {
        try await seed()
        let faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:projects|tasks|sections|areas|settings|native_request_receipts)\b"#, options: .regularExpression) != nil { writes += 1 } }
        let core = try host(faults); _ = try await core.start(); writes = 0
        let before = try rows()
        let page = try object(await core.call("window", argumentsJSON: json([0, 1, ""])))
        XCTAssertEqual((page["rows"] as? [Any])?.count, 1)
        let snapshot = try await core.searchSnapshot(), ids = snapshot.items.map { Data($0.id.utf8) }
        XCTAssertEqual(snapshot.items.filter { $0.list == .inbox }.count, 50)
        XCTAssertEqual(Set(ids).count, snapshot.items.count)
        for id in [taskID, "é", "e\u{0301}", "Task", "task", "synthetic-someday", "synthetic-future-next"] {
            XCTAssertTrue(ids.contains(Data(id.utf8)), "Expected exact seeded identity")
        }
        for id in ["synthetic-done", "synthetic-reference", "synthetic-archived", "synthetic-task-deleted", "synthetic-task-archived-project"] {
            XCTAssertFalse(ids.contains(Data(id.utf8)), "Expected excluded synthetic identity: \(id)")
        }
        // Canonical hydration detaches live tasks from deleted projects before this readonly projection.
        let stored = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(before["tasks"]).utf8)) as? [[String: Any]])
        let detachedRow = try XCTUnwrap(stored.first { $0["id"] as? String == "synthetic-task-deleted-project" })
        XCTAssertTrue(detachedRow["projectId"] is NSNull); XCTAssertEqual(detachedRow["status"] as? String, "next")
        let detached = try XCTUnwrap(snapshot.items.first { Data($0.id.utf8) == Data("synthetic-task-deleted-project".utf8) })
        XCTAssertNil(detached.projectName)
        let projected = try XCTUnwrap(snapshot.items.first { Data($0.id.utf8) == Data(taskID.utf8) })
        XCTAssertEqual(projected.list, .focus)
        XCTAssertEqual(Data(projected.title.utf8), Data("Synthetic title 漢😀e\u{0301}".utf8))
        XCTAssertEqual(projected.projectName, "Synthetic project 漢"); XCTAssertEqual(projected.dueDate, "2026-10-09"); XCTAssertEqual(projected.startDate, "2026-10-08")
        let raw = try object(await core.call("iosSearchSnapshot")), items = try XCTUnwrap(raw["items"] as? [[String: Any]])
        XCTAssertEqual(Set(raw.keys), ["items"])
        for item in items { XCTAssertTrue(Set(item.keys).isSubset(of: ["id", "title", "list", "projectName", "dueDate", "startDate"])) }
        XCTAssertEqual(try rows(), before); XCTAssertEqual(writes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testReadinessAndZeroArgumentTransportRefuseWithoutPoisoningHost() async throws {
        try await seed()
        let core = try host(), before = try rows()
        await refused { try await core.searchSnapshot() }
        XCTAssertEqual(try rows(), before)
        _ = try await core.start(); let started = try rows()
        for raw in ["{}", "[1]", "[true]", "[null]", "[{}]", "[\"private synthetic input\"]", "[[],[]]"] {
            do { _ = try await core.call("iosSearchSnapshot", argumentsJSON: raw); XCTFail("Expected zero-argument refusal") }
            catch { XCTAssertTrue(error is HostFailure || error is CoreHostRejection) }
        }
        for raw in ["null", "malformed"] {
            do { _ = try await core.call("iosSearchSnapshot", argumentsJSON: raw); XCTFail("Expected JSON parser refusal") }
            catch {
                let parser = error as NSError
                XCTAssertEqual(parser.domain, NSCocoaErrorDomain)
                XCTAssertEqual(parser.code, CocoaError.Code.propertyListReadCorrupt.rawValue)
            }
            let fresh = try await core.searchSnapshot()
            XCTAssertFalse(fresh.items.isEmpty)
            XCTAssertEqual(try rows(), started); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        let exact = "[]" + String(repeating: " ", count: 2_046)
        XCTAssertEqual(exact.utf8.count, 2_048)
        _ = try await core.call("iosSearchSnapshot", argumentsJSON: exact)
        do { _ = try await core.call("iosSearchSnapshot", argumentsJSON: exact + " "); XCTFail("Expected transport size refusal") }
        catch let error as HostFailure { XCTAssertTrue(error.message.hasPrefix("INVALID_INPUT:")) }
        _ = try await core.searchSnapshot()
        XCTAssertEqual(try rows(), started); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); await refused { try await core.searchSnapshot() }
    }

    func testMalformedProjectionIsReadonlyAndNextRequestRecovers() async throws {
        try await seed()
        let suffix = """
        ;(() => {
          const original = MindwtrHost.iosSearchSnapshot, poll = MindwtrHost.poll, replies = new Map();
          let first = true;
          MindwtrHost.iosSearchSnapshot = function() {
            if (!first) return original.apply(this, arguments);
            first = false;
            const id = '1000000001';
            Promise.resolve().then(() => replies.set(id, JSON.stringify({ok:true,value:{items:[{id:'synthetic',title:'Synthetic',list:'next',notes:'Synthetic private metadata'}]}})));
            return id;
          };
          MindwtrHost.poll = id => {
            if (id !== '1000000001') return poll(id);
            const value = replies.get(id); if (!value) return null; replies.delete(id); return value;
          };
        })();
        """
        let core = try host(bundleURL: fixtureBundle(suffix: suffix)); _ = try await core.start()
        let before = try rows()
        await refused { try await core.searchSnapshot() }
        let fresh = try await core.searchSnapshot()
        XCTAssertFalse(fresh.items.isEmpty)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
