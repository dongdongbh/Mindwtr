import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class WidgetNextSnapshotHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"],
              FileManager.default.isReadableFile(atPath: path) else { throw XCTSkip("Build production core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("WidgetNextSnapshotHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw CocoaError(.fileReadUnknown) }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await core.close() }; return core
    }
    private func seed() async throws {
        let bootstrap = host(); _ = try await bootstrap.start(); await bootstrap.close()
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        let at = "2026-10-30T00:00:00.000Z"
        _ = try sql.execute("INSERT INTO projects(id,title,status,color,orderNum,tagIds,createdAt,updatedAt) VALUES ('widget-project','Synthetic widget project','active','#123456',0,'[]',?,?)",
                            parametersJSON: json([at, at]))
        for index in 0..<17 {
            _ = try sql.execute("INSERT INTO tasks(id,title,status,projectId,contexts,tags,description,createdAt,updatedAt,rev,revBy) VALUES (?,?,'next','widget-project','[]','[]','Synthetic private note',?,?,1,'fixture')",
                                parametersJSON: json(["widget-next-\(index)", "Synthetic next \(index)", at, at]))
        }
    }
    private func rows() throws -> [String: String] {
        let sql = try SQLiteBridge(url: database); defer { sql.close() }
        var result: [String: String] = [:]
        for table in ["tasks", "projects", "sections", "areas", "settings", "native_request_receipts"] {
            result[table] = try json(NativeJSON.jsonObject(with: Data(sql.execute("SELECT * FROM " + table + " ORDER BY rowid").utf8)))
        }
        return result
    }

    func testActualWidgetReadRoundtripCapOldShapeAndDiagnosticPreserveStorage() async throws {
        try await seed()
        let faults = HostIOFaults(); var writes = 0
        faults.beforeSQL = { if $0.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\b"#, options: .regularExpression) != nil { writes += 1 } }
        let core = host(faults); _ = try await core.start(); writes = 0
        let before = try rows(), snapshot = try await core.widgetNextSnapshot()
        XCTAssertEqual(snapshot.version, 1); XCTAssertEqual(snapshot.totalCount, 17); XCTAssertEqual(snapshot.items.count, 13)
        XCTAssertFalse(snapshot.title.isEmpty); XCTAssertFalse(snapshot.emptyMessage.isEmpty)
        for item in snapshot.items {
            XCTAssertTrue(item.id.hasPrefix("widget-next-")); XCTAssertEqual(item.contextLabel, "Synthetic widget project")
            XCTAssertNil(item.dueLabel); XCTAssertEqual(item.dueTone, .normal)
        }
        let oldRaw = try await core.call("iosSearchSnapshot")
        let old = try XCTUnwrap(NativeJSON.jsonObject(with: Data(oldRaw.utf8)) as? [String: Any])
        XCTAssertEqual(Set(old.keys), ["items"])
        for item in try XCTUnwrap(old["items"] as? [[String: Any]]) {
            XCTAssertTrue(Set(item.keys).isSubset(of: ["id", "title", "list", "projectName", "dueDate", "startDate"]))
        }
        let shared = try await core.diagnosticsFileAction("logShare")
        let exported = try XCTUnwrap(NativeJSON.jsonObject(with: Data(shared.utf8)) as? [String: Any])
        let log = try await core.validatedDiagnosticsShareURL(XCTUnwrap(exported["path"] as? String))
        let lines = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map {
            try XCTUnwrap(NativeJSON.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
        let marker = try XCTUnwrap(lines.first { $0["message"] as? String == "Native iOS Next widget snapshot" })
        XCTAssertEqual(marker["context"] as? [String: String], ["releaseCheck": "v1.3.9/ios-widget-next-snapshot", "count": "13"])
        XCTAssertEqual(try rows(), before); XCTAssertEqual(writes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActualFacadeRequiresReadyHostAndZeroArgumentsWithoutCreatingJournal() async throws {
        try await seed()
        let core = host()
        do { _ = try await core.widgetNextSnapshot(); XCTFail("Startup is required") } catch {}
        _ = try await core.start(); let before = try rows()
        for raw in ["[null]", "[1]", "[{}]", "[\"private input\"]", "[]" + String(repeating: " ", count: 2_047)] {
            do { _ = try await core.call("iosWidgetNextSnapshot", argumentsJSON: raw); XCTFail("Invalid transport must refuse") } catch {}
        }
        let fresh = try await core.widgetNextSnapshot()
        XCTAssertEqual(fresh.totalCount, 17)
        XCTAssertEqual(try rows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        do { _ = try await core.widgetNextSnapshot(); XCTFail("A closed Host cannot read") } catch {}
    }
}
