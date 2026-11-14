import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeShortcutCaptureHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, container: URL!
    private let namespace = "tech.dongdongbh.mindwtr.native-shortcut-tests"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build production bundle") }
        bundle = URL(fileURLWithPath: path)
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeShortcutCaptureTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
        container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func host() -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func source(_ n: Int, _ fields: [String: Any] = [:]) throws -> (name: String, body: String) {
        let id = String(format: "ABCDEF00-0000-4000-8000-%012d", n)
        var value: [String: Any] = ["id": id, "title": "Shortcut capture \(n)", "createdAt": "2026-11-14T12:00:0\(n)Z"]
        value.merge(fields) { _, new in new }
        return (id + ".json", try json(value))
    }

    func testCapturesSaveOnceWithReceiptsAndColdReplayAddsNothing() async throws {
        let selected = try XCTUnwrap(NativeShortcutCaptureBatch.next([
            source(1, ["note": "Synthetic note", "tags": "home,errands", "dueDate": "2026-11-20"]), source(2)]))
        let first = host(); _ = try await first.start()
        let completed = try await first.ingestShortcutCaptures(selected)
        XCTAssertEqual(completed, selected.entries.map(\.name))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await first.close()
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 2)
        XCTAssertEqual(try rows("SELECT dueDate FROM tasks WHERE title='Shortcut capture 1'").first?["dueDate"] as? String, "2026-11-20")
        XCTAssertEqual(try rows("SELECT status FROM tasks WHERE title='Shortcut capture 2'").first?["status"] as? String, "inbox")
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 2)
        let cold = host(); _ = try await cold.start()
        XCTAssertEqual(try await cold.ingestShortcutCaptures(selected), completed)
        await cold.close()
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 2)
    }

    func testRetiredOwnerAndRawCallsNeverWrite() async throws {
        let core = host(); _ = try await core.start()
        let selected = try XCTUnwrap(NativeShortcutCaptureBatch.next([source(1)]))
        do { _ = try await core.ingestShortcutCaptures(selected, readmit: { false }); XCTFail("Denied owner was admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        let lease = NativeTaskAIEditorLease()
        do { _ = try await core.ingestShortcutCaptures(selected, lease: lease, readmit: { lease.invalidate(); return true }); XCTFail("Retired owner was admitted") }
        catch { XCTAssertTrue(error is CoreHostRejection) }
        do { _ = try await core.call("iosShortcutCaptureIngest", argumentsJSON: json([selected.json])); XCTFail("Raw call admitted") } catch {}
        do { _ = try await core.call("iosShortcutCaptureOutcome", argumentsJSON: json([selected.json])); XCTFail("Raw outcome admitted") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
    }

    func testSnapshotReadsCoreListsWithoutWriting() async throws {
        let core = host(); _ = try await core.start()
        _ = try await core.ingestShortcutCaptures(try XCTUnwrap(NativeShortcutCaptureBatch.next([source(1)])))
        let receipts = try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int
        let snapshot = try XCTUnwrap(NativeShortcutsSnapshot(json: try await core.shortcutsSnapshot()))
        XCTAssertEqual(snapshot.items(forList: "inbox").map(\.title), ["Shortcut capture 1"])
        XCTAssertEqual(snapshot.freshness(now: Date()), .current)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
