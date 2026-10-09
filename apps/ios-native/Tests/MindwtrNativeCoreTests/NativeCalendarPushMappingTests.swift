import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarPushMappingTests: XCTestCase {
    private func withDatabase(_ work: (SQLiteBridge, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("mapping.sqlite"), db = try SQLiteBridge(url: url)
        defer { db.close() }
        _ = try db.execute("CREATE TABLE calendar_sync (task_id TEXT NOT NULL, calendar_event_id TEXT NOT NULL, calendar_id TEXT NOT NULL, platform TEXT NOT NULL, last_synced_at TEXT NOT NULL, PRIMARY KEY (task_id, platform))")
        try work(db, url)
    }
    private func row(task: String = "task", event: String = "event", stamp: String = "before") throws -> NativeCalendarPushMapping {
        try NativeCalendarPushMapping(taskId: task, calendarEventId: event, calendarId: "calendar", platform: "ios", lastSyncedAt: stamp)
    }

    func testCreateUpdateDeleteAndExactRetryPreserveOtherPlatformAndTasks() throws {
        try withDatabase { db, _ in
            _ = try db.execute("INSERT INTO calendar_sync VALUES ('task','android-event','android-calendar','android','original')")
            let other = try row(task: "other"), first = try row(), next = try row(stamp: "after")
            try db.compareAndSetCalendarPushMapping(taskID: "other", expected: nil, next: other)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: first)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: first)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: first, next: next)
            XCTAssertEqual(try db.readCalendarPushMapping(taskID: "task"), next)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: next, next: nil)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: next, next: nil)
            XCTAssertNil(try db.readCalendarPushMapping(taskID: "task"))
            XCTAssertEqual(try db.readCalendarPushMapping(taskID: "other"), other)
            XCTAssertTrue(try db.execute("SELECT * FROM calendar_sync WHERE platform = 'android'").contains("android-event"))
        }
    }

    func testStaleFullRowAndByteDistinctUnicodeCannotAcknowledgeOrOverwrite() throws {
        try withDatabase { db, _ in
            let original = try row(stamp: "cafe\u{301}"), normalized = try row(stamp: "caf\u{e9}"), replacement = try row(event: "new-event")
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: original)
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: normalized, next: replacement))
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: normalized, next: nil))
            XCTAssertEqual(try db.readCalendarPushMapping(taskID: "task"), original)
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "other", expected: original, next: nil))
        }
    }

    func testLostCommitReplyReopensAndAcknowledgesWithoutSecondWrite() throws {
        try withDatabase { db, url in
            let next = try row(), faults = HostIOFaults()
            var fired = false
            faults.afterSQL = { sql in
                if sql == "COMMIT", !fired { fired = true; throw HostFailure("lost reply") }
            }
            db.faults = faults
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: next))
            XCTAssertTrue(fired)
            db.close()
            let reopened = try SQLiteBridge(url: url); defer { reopened.close() }
            let guardWrites = HostIOFaults()
            guardWrites.beforeSQL = { sql in
                if sql.hasPrefix("INSERT") || sql.hasPrefix("UPDATE") || sql.hasPrefix("DELETE") { throw HostFailure("unexpected second write") }
            }
            reopened.faults = guardWrites
            try reopened.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: next)
            XCTAssertEqual(try reopened.readCalendarPushMapping(taskID: "task"), next)
        }
    }

    func testFailedStatementRollsBackAndDoesNotStrandTransaction() throws {
        try withDatabase { db, _ in
            let first = try row(), next = try row(stamp: "after"), faults = HostIOFaults()
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: first)
            faults.afterSQL = { sql in if sql.hasPrefix("INSERT") { throw HostFailure("write reply lost") } }
            db.faults = faults
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: first, next: next))
            db.faults = nil
            XCTAssertEqual(try db.readCalendarPushMapping(taskID: "task"), first)
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: first, next: next)
        }
    }

    func testExistingTransactionIsRefusedWithoutRollingItBack() throws {
        try withDatabase { db, _ in
            _ = try db.execute("BEGIN IMMEDIATE")
            _ = try db.execute("INSERT INTO calendar_sync VALUES ('outside','e','c','ios','s')")
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: row()))
            _ = try db.execute("COMMIT")
            XCTAssertNotNil(try db.readCalendarPushMapping(taskID: "outside"))
        }
    }

    func testLostBeginReplyRollsBackOnlyTheNewTransaction() throws {
        try withDatabase { db, _ in
            let faults = HostIOFaults()
            faults.afterSQL = { sql in if sql == "BEGIN IMMEDIATE" { throw HostFailure("begin reply lost") } }
            db.faults = faults
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: row()))
            db.faults = nil
            XCTAssertNil(try db.readCalendarPushMapping(taskID: "task"))
            try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: row())
        }
    }

    func testMalformedExistingRowFailsWithoutRepair() throws {
        try withDatabase { db, _ in
            _ = try db.execute("INSERT INTO calendar_sync VALUES ('task','','calendar','ios','before')")
            let before = try db.execute("SELECT * FROM calendar_sync")
            XCTAssertThrowsError(try db.readCalendarPushMapping(taskID: "task"))
            XCTAssertThrowsError(try db.compareAndSetCalendarPushMapping(taskID: "task", expected: nil, next: row()))
            XCTAssertEqual(try db.execute("SELECT * FROM calendar_sync"), before)
        }
    }
}
