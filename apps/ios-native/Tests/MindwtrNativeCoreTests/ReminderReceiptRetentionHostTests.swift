import Darwin
import Foundation
import XCTest
@testable import MindwtrNativeCore

final class ReminderReceiptRetentionHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let completeID = "abcdefab-cdef-4abc-8abc-abcdefabcdef"
    private let snoozeID = "abcdefab-cdef-4abc-8abc-abcdefabcdee"
    private let settingID = "abcdefab-cdef-4abc-8abc-abcdefabcded"
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var request: String { "{\"requestId\":\"\(completeID)\",\"taskId\":\"retention-task\"}" }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"]
            ?? Bundle.main.url(forResource: "core-host", withExtension: "js")?.path else {
            throw XCTSkip("Build production core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        guard FileManager.default.isReadableFile(atPath: path) else { throw HostFailure("Retention fixture bundle unavailable") }
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("ReminderReceiptRetentionHostTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Retention fixture unavailable") }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host() -> CoreHost {
        let value = CoreHost(databaseURL: database, bundleURL: bundle)
        addTeardownBlock { await value.close() }
        return value
    }
    private func sql(_ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: parameters), as: UTF8.self)
        return try db.execute(statement, parametersJSON: json)
    }
    private func receiptIDs() throws -> [String] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT request_id FROM native_request_receipts ORDER BY request_id").utf8)) as? [[String: Any]])
        return try rows.map { try XCTUnwrap($0["request_id"] as? String) }
    }
    private func receiptSnapshot() throws -> [[String: Data]] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM native_request_receipts ORDER BY request_id").utf8)) as? [[String: String]])
        return rows.map { $0.mapValues { Data($0.utf8) } }
    }
    private func taskSnapshot() throws -> Data {
        let rows = try NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8))
        return try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    }
    private func seedOldCompletion() async throws -> String {
        let initial = host(); _ = try await initial.start(); await initial.close()
        let at = "2020-01-01T00:00:00.000Z"
        _ = try sql("INSERT INTO tasks(id,title,status,contexts,tags,createdAt,updatedAt,rev,revBy,isFocusedToday,pushCount,showFutureRecurrence,suppressMindwtrReminders) VALUES (?,?,'next','[]','[]',?,?,1,'fixture',0,0,0,0)",
                    ["retention-task", "PRIVATE_RETENTION_TITLE", at, at])
        let writer = host(); _ = try await writer.start()
        let result = try await writer.completeReminderTask(requestJSON: request)
        await writer.close()
        _ = try sql("UPDATE native_request_receipts SET saved_at=? WHERE request_id=?", [at, completeID])
        _ = try sql("UPDATE tasks SET status='next',description='PRIVATE_LATER_EDIT',rev=rev+1 WHERE id='retention-task'")
        return result
    }
    private func seedOtherReceipts() throws {
        for (id, command) in [(snoozeID, "reminderSnooze"), (settingID, "notificationSetting")] {
            _ = try sql("INSERT INTO native_request_receipts(request_id,method,reply,saved_at) VALUES (?,?,?,'2020-01-01T00:00:00.000Z')",
                        [id, command + ":" + String(repeating: "0", count: 32), "null"])
        }
    }
    private func expectRejection(_ work: () async throws -> String) async {
        do { _ = try await work(); XCTFail("Expected definite retention refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected error: \(type(of: error))") }
    }
    private func markers() throws -> [[String: Any]] {
        let text = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        return try text.split(separator: "\n").filter { $0.contains("v1.3.5/ios-reminder-receipt-retention") }.map {
            let entry = try XCTUnwrap(NativeJSON.jsonObject(with: Data($0.utf8)) as? [String: Any])
            XCTAssertEqual(entry["message"] as? String, "Native iOS reminder receipt retention applied")
            let context = try XCTUnwrap(entry["context"] as? [String: String])
            XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "outcome"]))
            XCTAssertTrue(["conservative", "snapshot"].contains(context["outcome"] ?? ""))
            XCTAssertFalse(String($0).contains(completeID)); XCTAssertFalse(String($0).contains("PRIVATE_"))
            return entry
        }
    }

    func testFreshSnapshotRetainsInitialAndRepeatedStartAuthorityWithoutRecompletingReopenedTask() async throws {
        let original = try await seedOldCompletion()
        try seedOtherReceipts()
        let before = try taskSnapshot()
        let core = host()
        _ = try await core.start(retainingReminderResponseIDs: [completeID])
        XCTAssertEqual(try receiptIDs(), [completeID])
        let probed = try await core.probeReminderCompletionOutcome(requestJSON: request)
        let replayed = try await core.completeReminderTask(requestJSON: request)
        XCTAssertEqual(probed, original); XCTAssertEqual(replayed, original)
        XCTAssertEqual(try taskSnapshot(), before)
        _ = try await core.start(retainingReminderResponseIDs: [completeID])
        XCTAssertEqual(try receiptIDs(), [completeID])
        // This later snapshot is deliberately empty: construction did not freeze the earlier one.
        _ = try await core.start(retainingReminderResponseIDs: [])
        XCTAssertEqual(try receiptIDs(), [])
        XCTAssertEqual(try taskSnapshot(), before)
        XCTAssertGreaterThanOrEqual(try markers().count, 3)
    }

    func testNilConservativelyRetainsBothReminderCommandsWhileOtherReceiptsExpire() async throws {
        _ = try await seedOldCompletion(); try seedOtherReceipts()
        let core = host(); _ = try await core.start()
        XCTAssertEqual(try receiptIDs(), [completeID, snoozeID].sorted())
        _ = try await core.start()
        XCTAssertEqual(try receiptIDs(), [completeID, snoozeID].sorted())
        let marker = try XCTUnwrap(markers().last)
        XCTAssertEqual((marker["context"] as? [String: String])?["outcome"], "conservative")
        _ = try await core.start(retainingReminderResponseIDs: [])
        XCTAssertEqual(try receiptIDs(), [])
    }

    func testInvalidSnapshotsAndGenericPrivateSelectorNeverPrune() async throws {
        _ = try await seedOldCompletion(); try seedOtherReceipts()
        let core = host()
        let before = try receiptSnapshot()
        let tooMany = (0..<129).map { String(format: "00000000-0000-4000-8000-%012d", $0) }
        for ids in [[completeID.uppercased()], [completeID, completeID], ["not-a-uuid"], tooMany] {
            await expectRejection { try await core.start(retainingReminderResponseIDs: ids) }
            XCTAssertEqual(try receiptSnapshot(), before)
        }
        await expectRejection { try await core.call("iosPruneReceipts", argumentsJSON: "[\"[]\"]") }
        XCTAssertEqual(try receiptSnapshot(), before)
        _ = try await core.start()
        let retained = try receiptSnapshot()
        await expectRejection { try await core.start(retainingReminderResponseIDs: [completeID, completeID]) }
        await expectRejection { try await core.call("iosPruneReceipts", argumentsJSON: "[\"[]\"]") }
        XCTAssertEqual(try receiptSnapshot(), retained)
    }
}
