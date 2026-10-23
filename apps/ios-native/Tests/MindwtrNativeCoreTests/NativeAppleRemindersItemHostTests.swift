import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeAppleRemindersItemHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private let namespace = "tech.dongdongbh.mindwtr.reminders-item-test"
    private let list = NativeAppleReminderListIdentity(id: "selected-list", sourceID: "selected-source")
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }

    override func setUpWithError() throws {
        guard let source = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Actual private host bundle required") }
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        root = base.appendingPathComponent(".mindwtr-native-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        bundle = root.appendingPathComponent("core-host.js")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: source), to: bundle)
        try setRegistry(["selectedListId": list.id, "selectedListTitle": "Selected",
            "importedReminderIds": ["older"], "deleteImportedReminders": false, "autoImportOnOpen": true])
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let core = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: root, bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func source(id: String = "provider-row") -> NativeAppleReminderSourceDTO {
        .init(id: id, title: "Literal @home /due:today", notes: "Original notes", completed: false,
              creationDate: nil, startDate: nil, dueDate: nil)
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ value: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
    private func rows(_ sql: String) throws -> [[String: Any]] {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute(sql).utf8)) as? [[String: Any]])
    }
    private func setRegistry(_ value: [String: Any]) throws {
        let kv = try NativeDeviceKV(containerURL: root, bundleIdentifier: namespace); defer { kv.close() }
        try kv.compareAndSetAppleRemindersImportState(expected: kv.readAppleRemindersImportState(), next: json(value))
    }
    private func registry() throws -> [String: Any] {
        let kv = try NativeDeviceKV(containerURL: root, bundleIdentifier: namespace); defer { kv.close() }
        return try object(XCTUnwrap(kv.readAppleRemindersImportState()))
    }
    private func refused(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected retained refusal", file: file, line: line) } catch { }
    }

    func testLiteralTaskReceiptRegistryAndRepeatedSource() async throws {
        let core = host(); _ = try await core.start()
        let first = try object(await core.importAppleReminderItem(source: source(), list: list))
        XCTAssertEqual(first["kind"] as? String, "published")
        let second = try object(await core.importAppleReminderItem(source: source(), list: list))
        XCTAssertEqual(second["kind"] as? String, "noop")
        let log = try String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("Native Reminders item and import registry confirmed"))
        XCTAssertTrue(log.contains("v1.3.5/ios-reminders-item"))
        XCTAssertFalse(log.contains("Literal @home")); XCTAssertFalse(log.contains("Original notes"))
        await core.close()
        let tasks = try rows("SELECT * FROM tasks")
        XCTAssertEqual(tasks.count, 1); XCTAssertEqual(tasks.first?["title"] as? String, "Literal @home /due:today")
        XCTAssertEqual(tasks.first?["status"] as? String, "inbox"); XCTAssertEqual(tasks.first?["description"] as? String, "Original notes")
        XCTAssertTrue(tasks.first?["dueDate"] is NSNull)
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts WHERE method LIKE 'appleReminderImportItem:%'").count, 1)
        let saved = try registry(); XCTAssertEqual(saved["importedReminderIds"] as? [String], ["older", "provider-row"])
        XCTAssertEqual(saved["autoImportOnOpen"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testDeleteEnabledItemSettlementSavesTaskAndPreservesPreference() async throws {
        var original = try registry(); original["deleteImportedReminders"] = true; try setRegistry(original)
        let core = host(); _ = try await core.start()
        _ = try await core.importAppleReminderItem(source: source(), list: list)
        await core.close()
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 1)
        XCTAssertEqual(try registry()["deleteImportedReminders"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testColdRecoveryAfterRealTaskTransactionFailure() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.beforeSQL = { sql in if sql.hasPrefix("INSERT INTO tasks") { throw HostFailure("Injected task save failure") } }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
        await core.close(); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 0)
        let next = host(); _ = try await next.start(); await next.close()
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 1)
        XCTAssertEqual(try registry()["importedReminderIds"] as? [String], ["older", "provider-row"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testJournalRemovalFailureDoesNotRecreateTaskOrAppendRegistryTwice() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Injected journal cleanup failure") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        let before = try json(rows("SELECT * FROM tasks")); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 1)
        let next = host(); _ = try await next.start(); await next.close()
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
        XCTAssertEqual(try registry()["importedReminderIds"] as? [String], ["older", "provider-row"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testExistingUUIDOnlyAddsReceiptWithoutChangingTask() async throws {
        let id = UUID().uuidString.lowercased()
        let first = host(); _ = try await first.start()
        _ = try await first.importAppleReminderItem(source: source(id: id), list: list)
        await first.close()
        let before = try json(rows("SELECT * FROM tasks"))
        var state = try registry(); state["importedReminderIds"] = ["older"]; try setRegistry(state)
        let faults = HostIOFaults(), next = host(faults); _ = try await next.start()
        var writes = 0
        faults.beforeSQL = { sql in
            if sql.hasPrefix("INSERT INTO tasks") || sql.hasPrefix("UPDATE tasks") || sql.hasPrefix("DELETE FROM tasks") { writes += 1 }
        }
        let result = try object(await next.importAppleReminderItem(source: source(id: id), list: list))
        XCTAssertEqual((result["result"] as? [String: Any])?["mode"] as? String, "existing")
        XCTAssertEqual(writes, 0)
        await next.close(); XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts WHERE method LIKE 'appleReminderImportItem:%'").count, 2)
    }

    func testPostReceiptDeletionKeepsSourceWithoutPublishingRegistry() async throws {
        let id = UUID().uuidString.lowercased(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        var inserted = false, deleted = false
        faults.afterSQL = { sql in
            if sql.hasPrefix("INSERT INTO native_request_receipts") { inserted = true }
            if inserted && !deleted && sql == "COMMIT" {
                let other = try SQLiteBridge(url: self.database); defer { other.close() }
                _ = try other.execute("DELETE FROM tasks WHERE id=?", parametersJSON: self.json([id]))
                deleted = true
            }
        }
        let result = try object(await core.importAppleReminderItem(source: source(id: id), list: list))
        XCTAssertTrue(deleted); XCTAssertEqual(result["kind"] as? String, "keptSource")
        await core.close()
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 0)
        XCTAssertEqual(try registry()["importedReminderIds"] as? [String], ["older"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testForeignNamespaceRefusesRetainedJournalBeforeSQL() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        await core.close()
        let original = try Data(contentsOf: journal), nextFaults = HostIOFaults()
        var queries = 0; nextFaults.beforeSQL = { _ in queries += 1 }
        let next = CoreHost(databaseURL: database, bundleURL: bundle, faults: nextFaults,
            deviceStorage: (containerURL: root, bundleIdentifier: namespace + ".foreign"))
        await refused { _ = try await next.start() }; await next.close()
        XCTAssertEqual(queries, 0); XCTAssertEqual(try Data(contentsOf: journal), original)
    }

    func testDuplicateOuterJournalRefusesBeforeSQL() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        await core.close()
        let raw = try String(contentsOf: journal, encoding: .utf8)
        let corrupted = "{\"version\":2," + raw.dropFirst()
        try Data(corrupted.utf8).write(to: journal)
        let nextFaults = HostIOFaults(); var queries = 0; nextFaults.beforeSQL = { _ in queries += 1 }
        let next = host(nextFaults); await refused { _ = try await next.start() }; await next.close()
        XCTAssertEqual(queries, 0); XCTAssertEqual(try String(contentsOf: journal, encoding: .utf8), corrupted)
    }

    func testLostRegistryPublicationResumesExactPairWarmAndCold() async throws {
        for cold in [false, true] {
            for cut in ["before", "after", "readback"] {
                let id = UUID().uuidString.lowercased(), faults = HostIOFaults()
                var storage: NativeDeviceKV?
                faults.configureDeviceStorage = { storage = $0 }
                let core = host(faults); _ = try await core.start()
                let kv = try XCTUnwrap(storage)
                if cut == "before" { kv.faults.beforePromotion = { throw HostFailure("Registry publication cut") } }
                if cut == "after" { kv.faults.afterPromotion = { throw HostFailure("Registry publication cut") } }
                if cut == "readback" { kv.faults.beforeReadback = { throw HostFailure("Registry publication cut") } }
                await refused { _ = try await core.importAppleReminderItem(source: self.source(id: id), list: self.list) }
                XCTAssertTrue(FileManager.default.fileExists(atPath: journal.path))
                XCTAssertTrue(kv.hasPendingAppleRemindersImportMutation)
                let before = try json(rows("SELECT * FROM tasks"))
                if cold {
                    await core.close(); let next = host(); _ = try await next.start(); await next.close()
                } else {
                    kv.faults.beforePromotion = nil; kv.faults.afterPromotion = nil; kv.faults.beforeReadback = nil
                    let reply = try await core.retryPending(); XCTAssertNotNil(reply); await core.close()
                }
                XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
                XCTAssertEqual((try registry()["importedReminderIds"] as? [String])?.filter { $0 == id }.count, 1)
                XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            }
        }
    }

    func testPublishingSettlementSurvivesLaterTaskDeletion() async throws {
        let id = UUID().uuidString.lowercased(), faults = HostIOFaults()
        var storage: NativeDeviceKV?; faults.configureDeviceStorage = { storage = $0 }
        let core = host(faults); _ = try await core.start()
        let kv = try XCTUnwrap(storage); kv.faults.afterPromotion = { throw HostFailure("Registry ACK lost") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(id: id), list: self.list) }
        await core.close()
        let external = try SQLiteBridge(url: database)
        _ = try external.execute("DELETE FROM tasks WHERE id=?", parametersJSON: json([id])); external.close()
        let next = host(); _ = try await next.start(); await next.close()
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 0)
        XCTAssertEqual((try registry()["importedReminderIds"] as? [String])?.filter { $0 == id }.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testReadyRecoveryRebasesLatestRegistryWithoutDroppingPreferences() async throws {
        let id = UUID().uuidString.lowercased(), faults = HostIOFaults(), core = host(faults)
        _ = try await core.start()
        faults.beforeSQL = { sql in if sql == "SELECT id,deletedAt,purgedAt FROM tasks WHERE id=?" { throw HostFailure("Before live read") } }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(id: id), list: self.list) }
        await core.close()
        var changed = try registry(); changed["selectedListId"] = "another-list"; changed["selectedListTitle"] = "Changed"
        changed["autoImportOnOpen"] = false; changed["deleteImportedReminders"] = true
        changed["importedReminderIds"] = ["older", "intervening"]
        try setRegistry(changed)
        let before = try json(rows("SELECT * FROM tasks")), next = host(); _ = try await next.start(); await next.close()
        var expected = changed; expected["importedReminderIds"] = ["older", "intervening", id]
        XCTAssertEqual(try json(registry()), try json(expected))
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
    }

    func testMissingTerminalReceiptCannotBeReplacedByMatchingTask() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        await core.close()
        let external = try SQLiteBridge(url: database)
        _ = try external.execute("DELETE FROM native_request_receipts WHERE method LIKE 'appleReminderImportItem:%'"); external.close()
        let before = try json(rows("SELECT * FROM tasks")), raw = try Data(contentsOf: journal)
        let next = host(); await refused { _ = try await next.start() }; await next.close()
        XCTAssertEqual(try json(rows("SELECT * FROM tasks")), before)
        XCTAssertEqual(try Data(contentsOf: journal), raw)
        XCTAssertEqual(try rows("SELECT * FROM native_request_receipts WHERE method LIKE 'appleReminderImportItem:%'").count, 0)
    }

    func testWarmItemsReuseCompletedRecoverySnapshot() async throws {
        let core = host(); _ = try await core.start()
        _ = try await core.importAppleReminderItem(source: source(id: "first"), list: list)
        _ = try await core.importAppleReminderItem(source: source(id: "second"), list: list)
        await core.close()
        let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("backup-snapshots"), includingPropertiesForKeys: nil)
        XCTAssertEqual(files.filter { $0.lastPathComponent.hasSuffix(".snapshot.json") }.count, 1)
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 2)
    }

    func testWarmRetryPreservesReplacedJournal() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        let foreign = Data("foreign journal must remain untouched".utf8)
        try foreign.write(to: journal, options: .atomic)
        faults.journalRemove = nil
        var queries = 0; faults.beforeSQL = { _ in queries += 1 }
        await refused { _ = try await core.retryPending() }
        XCTAssertEqual(try Data(contentsOf: journal), foreign); XCTAssertEqual(queries, 0)
        await core.close()
    }

    func testJournalRemovalRechecksIdentityAfterHook() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let foreign = Data("replacement at remove boundary".utf8)
        faults.journalRemove = { try foreign.write(to: self.journal, options: .atomic) }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        XCTAssertEqual(try Data(contentsOf: journal), foreign)
        await core.close(); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 1)
    }

    func testFirstJournalWriteCannotOverwriteInterveningFile() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let foreign = Data("intervening journal".utf8)
        faults.journalWrite = { try foreign.write(to: self.journal, options: .atomic) }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        XCTAssertEqual(try Data(contentsOf: journal), foreign)
        await core.close(); XCTAssertEqual(try rows("SELECT * FROM tasks").count, 0)
    }

    func testRegistryCapacityRefusesBeforeTaskOrJournalWrite() async throws {
        var state = try registry(); state["selectedListTitle"] = String(repeating: "x", count: 1024 * 1024 - 300)
        try setRegistry(state)
        let core = host(); _ = try await core.start()
        let large = NativeAppleReminderSourceDTO(id: nil, title: "Fallback", notes: String(repeating: "n", count: 600),
            completed: false, creationDate: nil, startDate: nil, dueDate: nil)
        await refused { _ = try await core.importAppleReminderItem(source: large, list: self.list) }
        await core.close()
        XCTAssertEqual(try rows("SELECT * FROM tasks").count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertEqual(try json(registry()), try json(state))
    }

    func testDuplicateNestedRegistryRefusesBeforeSQL() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        await core.close()
        var outer = try object(String(contentsOf: journal, encoding: .utf8))
        let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data((outer["argumentsJSON"] as! String).utf8)) as? [String])
        var frame = try object(arguments[0]), registry = try XCTUnwrap(frame["registry"] as? [String: Any])
        registry["expectedRaw"] = #"{"selectedListId":"selected-list","selectedList\u0049d":"selected-list"}"#
        frame["registry"] = registry; outer["argumentsJSON"] = try json([json(frame)])
        let corrupt = try json(outer); try Data(corrupt.utf8).write(to: journal)
        let nextFaults = HostIOFaults(); var queries = 0; nextFaults.beforeSQL = { _ in queries += 1 }
        let next = host(nextFaults); await refused { _ = try await next.start() }; await next.close()
        XCTAssertEqual(queries, 0); XCTAssertEqual(try String(contentsOf: journal, encoding: .utf8), corrupt)
    }

    func testCopiedDeviceContainerRefusesRetainedJournalBeforeSQL() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        faults.journalRemove = { throw HostFailure("Retain terminal") }
        await refused { _ = try await core.importAppleReminderItem(source: self.source(), list: self.list) }
        await core.close()
        let retained = root.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: root, to: retained)
        addTeardownBlock { try FileManager.default.removeItem(at: retained) }
        try FileManager.default.copyItem(at: retained, to: root)
        let original = try Data(contentsOf: journal), nextFaults = HostIOFaults()
        var queries = 0; nextFaults.beforeSQL = { _ in queries += 1 }
        let next = host(nextFaults); await refused { _ = try await next.start() }; await next.close()
        XCTAssertEqual(queries, 0); XCTAssertEqual(try Data(contentsOf: journal), original)
    }
}
