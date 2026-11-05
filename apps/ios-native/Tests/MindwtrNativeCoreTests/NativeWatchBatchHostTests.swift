import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWatchBatchHostTests: XCTestCase {
    private var root: URL!, bundle: URL!, container: URL!
    private let namespace = "tech.dongdongbh.mindwtr.native-watch-tests"
    private let at = "2026-10-31T12:00:00.000Z"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Build production bundle") }
        bundle = URL(fileURLWithPath: path)
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("NativeWatchBatchTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        root = root.resolvingSymlinksInPath()
        container = root.appendingPathComponent("container", isDirectory: true)
        let manifest = container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{\"unknown\":\"preserve\"}".utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
                            deviceStorage: (containerURL: container, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func rows(_ sql: String, _ values: [Any] = []) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql, parametersJSON: json(values)).utf8)) as? [[String: Any]])
    }
    private func sourceID(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
    private func entry(_ n: Int, _ fields: [String: Any]) throws -> [String: Any] {
        var value: [String: Any] = ["protocolVersion": 1, "id": sourceID(n), "source": "apple-watch", "createdAt": at]
        value.merge(fields) { _, new in new }
        return ["name": sourceID(n) + ".json", "body": try json(value)]
    }
    private func batch(_ entries: [[String: Any]]) throws -> NativeWatchBatch {
        try NativeWatchBatch(json: json(["version": 1, "requestId": sourceID(999), "entries": entries]))
    }
    private func seed() async throws {
        let core = host(); _ = try await core.start(); await core.close()
        for id in ["complete", "defer", "list"] {
            _ = try rows("INSERT INTO tasks(id,title,status,contexts,tags,checklist,createdAt,updatedAt,rev,revBy) VALUES (?,?,'next','[]','[]',?,?,?,1,'fixture')",
                         [id, "Synthetic " + id, try json([["id": "milk", "title": "Milk", "isCompleted": false]]), at, at])
        }
    }

    func testQueueBatchChoosesOldestBeforeBoundingAndLeavesRemainingSources() throws {
        let sources = try (1...20).map { n -> (name: String, body: String) in
            let value = try entry(n, ["kind": "text", "title": "Synthetic capture",
                "createdAt": String(format: "2026-10-31T12:00:%02d.000Z", 21 - n)])
            return (value["name"] as! String, value["body"] as! String)
        }
        let first = try XCTUnwrap(NativeWatchBatch.next(sources))
        XCTAssertEqual(first.entries.map(\.name), (5...20).reversed().map { sourceID($0) + ".json" })
        let remaining = sources.filter { source in !first.entries.contains { $0.name == source.name } }
        let second = try XCTUnwrap(NativeWatchBatch.next(remaining))
        XCTAssertEqual(second.entries.map(\.name), (1...4).reversed().map { sourceID($0) + ".json" })
        XCTAssertNil(try NativeWatchBatch.next([]))
    }

    func testDeniedReadmissionAndRetiredLeaseDoNotMutateOrJournal() async throws {
        let core = host(); _ = try await core.start()
        let selected = try batch([entry(1, ["kind": "text", "title": "Synthetic capture"])])
        do {
            _ = try await core.ingestWatchBatch(selected, readmit: { false })
            XCTFail("Locked or editor-owned intake was admitted")
        } catch { XCTAssertTrue(error is CoreHostRejection) }
        let lease = NativeTaskAIEditorLease()
        do {
            _ = try await core.ingestWatchBatch(selected, lease: lease, readmit: { lease.invalidate(); return true })
            XCTFail("Retired owner was admitted")
        } catch { XCTAssertTrue(error is CoreHostRejection) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await core.close()
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM tasks").first?["n"] as? Int, 0)
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 0)
    }

    func testMixedBatchPersistsReceiptsAndColdReplayPreservesLaterEditsAndPurgedCapture() async throws {
        try await seed()
        let selected = try batch([
            entry(1, ["kind": "text", "title": "Synthetic capture"]),
            entry(2, ["kind": "complete", "taskId": "complete"]),
            entry(3, ["kind": "defer", "taskId": "defer", "startDate": "2026-11-02"]),
            entry(4, ["kind": "checklist", "taskId": "list", "taskCreatedAt": at, "itemId": "milk", "itemTitle": "Milk", "isCompleted": true])])
        let first = host(); _ = try await first.start()
        let result = try await first.ingestWatchBatch(selected)
        XCTAssertEqual(result.completed, selected.entries.map(\.name))
        XCTAssertEqual(result.checklistOutcomes[sourceID(4) + ".json"], "applied")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        await first.close()
        XCTAssertEqual(try rows("SELECT status FROM tasks WHERE id='complete'").first?["status"] as? String, "done")
        XCTAssertEqual(try rows("SELECT startTime FROM tasks WHERE id='defer'").first?["startTime"] as? String, "2026-11-02")
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 4)
        _ = try rows("DELETE FROM tasks WHERE id=?", [sourceID(1)])
        _ = try rows("UPDATE tasks SET status='next',rev=rev+1 WHERE id='complete'")
        _ = try rows("UPDATE tasks SET checklist=?,rev=rev+1 WHERE id='list'", [try json([["id": "milk", "title": "Milk", "isCompleted": false]])])
        let before = try json(rows("SELECT * FROM tasks ORDER BY id"))
        let cold = host(); _ = try await cold.start()
        let replay = try await cold.ingestWatchBatch(selected)
        XCTAssertEqual(replay.completed, result.completed)
        await cold.close()
        XCTAssertEqual(try json(rows("SELECT * FROM tasks ORDER BY id")), before)
        let storage = try NativeDeviceKV(containerURL: container, bundleIdentifier: namespace); defer { storage.close() }
        XCTAssertEqual(try storage.get("unknown"), "preserve")
        XCTAssertNotNil(try storage.get(NativeDeviceKV.watchOrderingName))
    }

    func testOrderingFailureRetainsJournalAndColdStartupFinishesBeforeNewWrites() async throws {
        try await seed()
        var fail = false
        let faults = HostIOFaults()
        faults.configureDeviceStorage = { storage in storage.faults.beforePromotion = { if fail { throw HostFailure("Injected record failure") } } }
        let first = host(faults); _ = try await first.start(); fail = true
        let selected = try batch([entry(2, ["kind": "complete", "taskId": "complete"])])
        do { _ = try await first.ingestWatchBatch(selected); XCTFail("Expected retained save") } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        await first.close()
        XCTAssertEqual(try rows("SELECT status FROM tasks WHERE id='complete'").first?["status"] as? String, "done")
        let cold = host(); _ = try await cold.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        let recovered = try await cold.ingestWatchBatch(selected)
        XCTAssertEqual(recovered.completed, [sourceID(2) + ".json"])
        await cold.close()
        XCTAssertEqual(try rows("SELECT count(*) AS n FROM native_request_receipts").first?["n"] as? Int, 1)
    }

    func testBatchRejectsUnsupportedAndDuplicateSourcesAndRawHostCalls() async throws {
        let text = try entry(1, ["kind": "text", "title": "Synthetic capture"])
        XCTAssertThrowsError(try batch([text, text]))
        XCTAssertThrowsError(try batch([entry(2, ["kind": "pomodoro", "action": "start"])]))
        XCTAssertThrowsError(try batch([["name": "../outside.json", "body": text["body"]!]]))
        let core = host(); _ = try await core.start()
        let selected = try batch([text])
        do { _ = try await core.call("iosWatchIngest", argumentsJSON: json([selected.json])); XCTFail("Raw call admitted") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
