import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class SubscriptionAddIO: @unchecked Sendable {
    private let lock = NSLock()
    private var cut: String?, journalWrites = 0, writes = 0, receipts = 0, commits = 0, promotions = 0
    private var storage: NativeDeviceKV?, replacement: String?
    func configure(_ storage: NativeDeviceKV) {
        lock.lock(); self.storage = storage; lock.unlock()
        storage.faults.beforePromotion = { [weak self] in
            guard let self else { return }; self.lock.lock(); self.promotions += 1; self.lock.unlock()
        }
    }
    func arm(_ value: String?, legacy: String? = nil) {
        lock.lock(); cut = value; replacement = legacy; journalWrites = 0; lock.unlock()
    }
    func beforeSQL(_ sql: String) throws {
        lock.lock()
        if sql.hasPrefix("INSERT") || sql.hasPrefix("UPDATE") || sql.hasPrefix("DELETE") { writes += 1 }
        if sql.hasPrefix("INSERT INTO native_request_receipts") { receipts += 1 }
        let fail = cut == "commit" && sql == "COMMIT" || cut == "lostCommitBlocked" && sql.hasPrefix("BEGIN")
        let changed = cut == "legacyCommit" && sql == "COMMIT", next = replacement, storage = self.storage
        if changed { cut = nil }; lock.unlock()
        if changed { try XCTUnwrap(storage).set("mindwtr-external-calendars", try XCTUnwrap(next)) }
        if fail { throw HostFailure("Subscription Add fixture COMMIT failure") }
    }
    func afterSQL(_ sql: String) throws {
        lock.lock(); if sql == "COMMIT" { commits += 1 }
        let fail = cut == "lostCommit" && sql == "COMMIT"
        if fail { cut = "lostCommitBlocked" }; lock.unlock()
        if fail { throw HostFailure("Subscription Add fixture lost COMMIT reply") }
    }
    func journal() throws {
        lock.lock(); journalWrites += 1
        let fail = cut == "journal" || cut == "terminal" && journalWrites == 2; lock.unlock()
        if fail { throw HostFailure("Subscription Add fixture journal failure") }
    }
    func clear() throws {
        lock.lock(); let fail = cut == "clear"; lock.unlock()
        if fail { throw HostFailure("Subscription Add fixture cleanup failure") }
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [writes, receipts, commits, promotions] }
}

private final class SubscriptionAddNoReader: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { XCTFail("URL Add cannot read provider permission"); throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { XCTFail("URL Add cannot enumerate calendars"); throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { XCTFail("URL Add cannot read events"); throw NativeCalendarReadError.unavailable }
}
private final class SubscriptionAddNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { XCTFail("URL Add cannot fetch"); client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}

final class NativeCalendarSubscriptionAddHostTests: XCTestCase {
    private struct Library {
        let root: URL
        let namespace = "tech.example.mindwtr.subscription-add"
        var database: URL { root.appendingPathComponent("core.sqlite") }
        var journal: URL { database.appendingPathExtension("pending.json") }
        var container: URL { root.appendingPathComponent("container", isDirectory: true) }
        var device: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1") }
        var manifest: URL { device.appendingPathComponent("manifest.json") }
    }
    private var root: URL!, bundle: URL!
    private let stamp = "2099-01-01T00:00:00.000Z"
    private let fresh = "SAVE_FAILED: Calendar subscription save requires fresh runtime recovery"
    private let privateURL = "https://fixture-id:fixture-secret@private-subscription.invalid/new.ics?token=URL_ADD_TOKEN"
    private var a: [String: Any] { ["id": "é", "name": "PRIVATE_SUBSCRIPTION_A", "url": "https://private-subscription.invalid/a.ics?secret=fixture", "enabled": true,
        "color": "#2563EB", "areaIds": ["dangling-area", "area-a"], "fixtureExtra": ["retain": "文"]] }
    private var b: [String: Any] { ["id": "e\u{301}", "name": "PRIVATE_SUBSCRIPTION_B", "url": "https://private-subscription.invalid/b.ics", "enabled": true,
        "color": "#DB2777", "areaIds": ["area-b"]] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/calendar-subscription-add/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Subscription Add fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func library(_ name: String, legacy: [[String: Any]]? = nil) throws -> Library {
        let library = Library(root: root.appendingPathComponent(name, isDirectory: true))
        try FileManager.default.createDirectory(at: library.device, withIntermediateDirectories: true)
        var cells = ["@mindwtr_sync_backend": "off", "private-unrelated-cell": "\u{FEFF}opaque 文"]
        cells["mindwtr-external-calendars"] = try legacy.map { try json($0) }
        try Data(json(cells).utf8).write(to: library.manifest); return library
    }
    private func host(_ library: Library, io: SubscriptionAddIO = SubscriptionAddIO()) -> CoreHost {
        let faults = HostIOFaults()
        faults.configureDeviceStorage = { io.configure($0) }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.afterSQL = { try io.afterSQL($0) }
        faults.journalWrite = { try io.journal() }; faults.journalRemove = { try io.clear() }
        faults.calendarReaderFactory = { XCTFail("URL Add cannot create EventKit reader"); return SubscriptionAddNoReader() }
        faults.calendarAuthorizationRequest = { XCTFail("URL Add cannot request EventKit access"); throw NativeCalendarReadError.unavailable }
        faults.notificationPermissionRead = { XCTFail("URL Add cannot read notification permission"); return .init(status: "denied", granted: false, canAskAgain: false) }
        faults.notificationAuthorizationRequest = { XCTFail("URL Add cannot request notification permission") }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.secretBeforeOperation = { _, _ in XCTFail("URL Add cannot use secrets") }
        faults.cryptoBeforeOperation = { _ in XCTFail("URL Add cannot use native crypto") }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SubscriptionAddNoHTTP.self]; faults.httpConfiguration = config
        let core = CoreHost(databaseURL: library.database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: library.container, bundleIdentifier: library.namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func sql(_ library: Library, _ statement: String, _ parameters: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: library.database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(parameters))
    }
    private func settings(_ library: Library) throws -> [String: Any] {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql(library, "SELECT data FROM settings WHERE id=1").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
    }
    private func replace(_ core: CoreHost, _ library: Library, _ feeds: [[String: Any]]?, timestamp: String? = nil) async throws {
        let export = try await core.prepareDataBackup()
        var document = try object(String(contentsOf: export.url, encoding: .utf8)); await core.discardDataBackup(export.id)
        var values = try XCTUnwrap(document["settings"] as? [String: Any]); values["externalCalendars"] = feeds
        values["unrelated472"] = ["preserve": "\u{FEFF}raw 文"]
        var stamps = values["syncPreferencesUpdatedAt"] as? [String: Any] ?? [:]
        stamps["externalCalendars"] = timestamp; values["syncPreferencesUpdatedAt"] = stamps; document["settings"] = values
        let selected = library.root.appendingPathComponent("import-" + UUID().uuidString + ".json")
        try json(document).write(to: selected, atomically: true, encoding: .utf8)
        let preview = try await core.prepareBackupImport(selected, action: .replace)
        XCTAssertEqual(try object(preview.json)["valid"] as? Bool, true); _ = try await core.mergeBackupImport(preview.id)
    }
    private func request(_ core: CoreHost, id: String = UUID().uuidString.lowercased(), name: String = " PRIVATE_URL_ADD ",
                         url: String? = nil, defaultName: String = "Calendar") async throws -> String {
        let options = try object(await core.getCalendarSubscriptionOptions())
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        return try json(["requestId": id, "name": name, "url": url ?? " \u{FEFF}" + privateURL + " \n", "defaultName": defaultName,
            "expected": expected])
    }
    private func added(_ raw: String, name: String = "PRIVATE_URL_ADD", url: String? = nil) throws -> [String: Any] {
        ["id": try XCTUnwrap(object(raw)["requestId"] as? String), "name": name, "url": url ?? privateURL, "enabled": true]
    }
    private func result(_ raw: String) throws {
        XCTAssertEqual(try json(object(raw)), try json(["changed": true, "toasts": [], "open": NSNull(), "clearDraft": true]))
    }
    private func receiptCount(_ library: Library) throws -> Int {
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sql(library, "SELECT count(*) AS count FROM native_request_receipts").utf8)) as? [[String: Any]])
        return try XCTUnwrap(rows.first?["count"] as? Int)
    }
    private func domain(_ library: Library) throws -> [String: String] {
        let db = try SQLiteBridge(url: library.database); defer { db.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('settings','native_request_receipts')").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { offset, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(offset)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(offset)value"
            }.joined(separator: ",")
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(db.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try rows.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func deviceBytes(_ library: Library) throws -> [String: Data] {
        let files = try XCTUnwrap(FileManager.default.enumerator(at: library.device, includingPropertiesForKeys: [.isRegularFileKey]))
        var result: [String: Data] = [:]
        while let file = files.nextObject() as? URL {
            if try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                result[String(file.path.dropFirst(library.device.path.count))] = try Data(contentsOf: file)
            }
        }
        return result
    }
    private func preservedSettings(_ before: [String: Any], _ after: [String: Any]) throws {
        var first = before, second = after
        first.removeValue(forKey: "externalCalendars"); second.removeValue(forKey: "externalCalendars")
        for value in [true, false] {
            var stamps = (value ? first : second)["syncPreferencesUpdatedAt"] as? [String: Any] ?? [:]
            stamps.removeValue(forKey: "externalCalendars")
            if value { first["syncPreferencesUpdatedAt"] = stamps } else { second["syncPreferencesUpdatedAt"] = stamps }
        }
        if first["deviceId"] == nil { second.removeValue(forKey: "deviceId") }
        XCTAssertEqual(try json(first), try json(second))
    }
    private func privacy(_ library: Library) throws {
        let receipts = try sql(library, "SELECT request_id, method, reply FROM native_request_receipts")
        let log = (try? String(contentsOf: library.root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        for text in [receipts, log] {
            for marker in ["private-subscription.invalid", "PRIVATE_SUBSCRIPTION", "PRIVATE_URL_ADD", "URL_ADD_TOKEN", "fixture-secret"] {
                XCTAssertFalse(text.contains(marker))
            }
        }
    }
    private func privateJournal(_ library: Library) throws {
        let data = try String(contentsOf: library.journal, encoding: .utf8)
        XCTAssertTrue(data.contains("PRIVATE_URL_ADD")); XCTAssertTrue(data.contains("URL_ADD_TOKEN"))
        let attributes = try FileManager.default.attributesOfItem(atPath: library.journal.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try library.journal.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #if os(iOS)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained uncertainty") }
        catch { XCTAssertTrue(error is HostFailure, "Unexpected \(error)") }
    }
    private func rejected(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected definite refusal") }
        catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected \(error)") }
    }

    func testCanonicalURLAddsPreserveRowsDeviceCopyAndAllowDuplicateURLs() async throws {
        let library = try library("canonical", legacy: [b]), io = SubscriptionAddIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a, b], timestamp: stamp)
        let before = try settings(library), rows = try domain(library), local = try deviceBytes(library)
        let receipts = try receiptCount(library), promotions = io.counts[3]
        let first = try await request(core); try result(await core.addCalendarSubscription(requestJSON: first))
        let second = try await request(core, name: " \u{FEFF} ", defaultName: "冻结的日历")
        try result(await core.addCalendarSubscription(requestJSON: second))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([a, b, added(first), added(second, name: "冻结的日历")]))
        let saved = try json(settings(library)), count = io.counts
        try result(await core.addCalendarSubscription(requestJSON: first)); try result(await core.probeCalendarSubscriptionAddOutcome(requestJSON: second))
        XCTAssertEqual(try json(settings(library)), saved); XCTAssertEqual(io.counts, count)
        var conflict = try object(first); conflict["url"] = "https://different.invalid/conflict.ics"
        await rejected { try await core.addCalendarSubscription(requestJSON: json(conflict)) }
        conflict = try object(first); conflict["defaultName"] = "Later locale label"
        await rejected { try await core.addCalendarSubscription(requestJSON: json(conflict)) }
        XCTAssertEqual(try json(settings(library)), saved)
        try preservedSettings(before, settings(library)); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(io.counts[3], promotions)
        XCTAssertEqual(try receiptCount(library), receipts + 2); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try privacy(library)
    }

    func testCanonicalEmptyAuthorityAndUnreceiptedUUIDCollisionRefuseWithoutLegacyRepair() async throws {
        let library = try library("empty-collision", legacy: [a]), core = host(library)
        _ = try await core.start(); try await replace(core, library, [], timestamp: stamp)
        let local = try deviceBytes(library), raw = try await request(core)
        try result(await core.addCalendarSubscription(requestJSON: raw))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([added(raw)]))
        XCTAssertEqual(try deviceBytes(library), local)
        let collisionID = UUID().uuidString.lowercased()
        var collision = try added(raw); collision["id"] = collisionID
        try await replace(core, library, [collision], timestamp: stamp)
        let attempt = try await request(core, id: collisionID), before = try json(settings(library)), receipts = try receiptCount(library)
        await rejected { try await core.addCalendarSubscription(requestJSON: attempt) }
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try privacy(library)
    }

    func testWarmExactRetryAtJournalCommitTerminalAndCleanupCutsUsesPrivatePendingFile() async throws {
        for cut in ["journal", "commit", "terminal", "clear"] {
            let library = try library(cut, legacy: [b]), io = SubscriptionAddIO(), core = host(library, io: io)
            _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
            let raw = try await request(core), rows = try domain(library), local = try deviceBytes(library), receipts = try receiptCount(library)
            var other = try object(raw); other["requestId"] = UUID().uuidString.lowercased()
            io.arm(cut); await uncertain { try await core.addCalendarSubscription(requestJSON: raw) }
            let frozen = try FileManager.default.fileExists(atPath: library.journal.path) ? Data(contentsOf: library.journal) : nil
            if cut != "journal" { try privateJournal(library) }
            await uncertain { try await core.addCalendarSubscription(requestJSON: json(other)) }
            if let frozen { XCTAssertEqual(try Data(contentsOf: library.journal), frozen) }
            io.arm(nil); let retried = try await core.retryPending(); try result(XCTUnwrap(retried))
            try result(await core.addCalendarSubscription(requestJSON: raw)); try result(await core.probeCalendarSubscriptionAddOutcome(requestJSON: raw))
            XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([a, added(raw)]))
            XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertEqual(try domain(library), rows)
            XCTAssertEqual(try deviceBytes(library), local); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
            try privacy(library); await core.close()
        }
    }

    func testLegacyChangedDuringCommitRetiresDirtyRuntimeBeforeFreshAppend() async throws {
        var legacy = a; legacy.removeValue(forKey: "fixtureExtra")
        let library = try library("legacy-cut", legacy: [legacy]), io = SubscriptionAddIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, nil)
        let raw = try await request(core), before = try json(settings(library)), rows = try domain(library), receipts = try receiptCount(library)
        var later = legacy; later["name"] = "PRIVATE_SUBSCRIPTION_LATER"
        io.arm("legacyCommit", legacy: try json([later]))
        do { _ = try await core.addCalendarSubscription(requestJSON: raw); XCTFail("Stale publication must require fresh runtime") }
        catch { XCTAssertEqual(error.localizedDescription, fresh) }
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows); XCTAssertEqual(try receiptCount(library), receipts)
        try privateJournal(library); let frozen = try Data(contentsOf: library.journal)
        await uncertain { try await core.call("captureSubmit", argumentsJSON: json(["Cannot flush old snapshot"])) }
        XCTAssertEqual(try Data(contentsOf: library.journal), frozen)
        io.arm(nil); let startup = try object(await core.start())
        XCTAssertNil(startup["recovery"]); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        await rejected { try await core.probeCalendarSubscriptionAddOutcome(requestJSON: raw) }
        let local = try deviceBytes(library), freshRequest = try await request(core)
        try result(await core.addCalendarSubscription(requestJSON: freshRequest))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([later, added(freshRequest)]))
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try domain(library), rows); XCTAssertEqual(try receiptCount(library), receipts + 1)
        try privacy(library)
    }

    func testUncommittedCanonicalRetryPreservesLaterDurableSettings() async throws {
        let library = try library("later-canonical", legacy: [b]), io = SubscriptionAddIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), receipts = try receiptCount(library), rows = try domain(library), local = try deviceBytes(library)
        io.arm("commit"); await uncertain { try await core.addCalendarSubscription(requestJSON: raw) }
        try privateJournal(library); let frozen = try Data(contentsOf: library.journal)
        io.arm(nil)
        var later = try settings(library); later["externalCalendars"] = []; later["retainedOutside"] = "later durable value"
        _ = try sql(library, "UPDATE settings SET data=? WHERE id=1", [json(later)])
        let before = try json(settings(library))
        do { _ = try await core.retryPending(); XCTFail("Old failed snapshot cannot replace later durable settings") }
        catch { XCTAssertEqual(error.localizedDescription, fresh) }
        XCTAssertEqual(try Data(contentsOf: library.journal), frozen); XCTAssertEqual(try json(settings(library)), before)
        XCTAssertEqual(try receiptCount(library), receipts)
        let startup = try object(await core.start()); XCTAssertNil(startup["recovery"])
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        await rejected { try await core.probeCalendarSubscriptionAddOutcome(requestJSON: raw) }
        let next = try await request(core); try result(await core.addCalendarSubscription(requestJSON: next))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([added(next)])); try privacy(library)
    }

    func testDirtyLostCommitReceiptRequiresFreshRuntimeThenPreservesLaterSQLChoice() async throws {
        let library = try library("lost-commit", legacy: [b]), io = SubscriptionAddIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), receipts = try receiptCount(library), local = try deviceBytes(library), rows = try domain(library)
        io.arm("lostCommit"); await uncertain { try await core.addCalendarSubscription(requestJSON: raw) }
        XCTAssertEqual(try receiptCount(library), receipts + 1); try privateJournal(library)
        var later = try settings(library), source = a; source["name"] = "PRIVATE_SUBSCRIPTION_LATER_SQL"
        later["externalCalendars"] = [source]
        _ = try sql(library, "UPDATE settings SET data=? WHERE id=1", [json(later)])
        let before = try json(settings(library)), frozen = try Data(contentsOf: library.journal)
        do { _ = try await core.retryPending(); XCTFail("Dirty saved receipt cannot release old queued snapshot") }
        catch { XCTAssertEqual(error.localizedDescription, fresh) }
        XCTAssertEqual(try Data(contentsOf: library.journal), frozen)
        await uncertain { try await core.call("captureSubmit", argumentsJSON: json(["Cannot flush stale queued save"])) }
        XCTAssertEqual(try json(settings(library)), before)
        io.arm(nil)
        let startup = try object(await core.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionAddCommit"); try result(json(try XCTUnwrap(recovery["result"])))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows); XCTAssertEqual(try deviceBytes(library), local)
        XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try result(await core.probeCalendarSubscriptionAddOutcome(requestJSON: raw))
        try result(await core.addCalendarSubscription(requestJSON: raw)); XCTAssertEqual(try json(settings(library)), before); try privacy(library)
    }

    func testColdSavedReceiptWinsAfterPublicRemoveImportAndRevokedLegacyNamespace() async throws {
        var legacy = a; legacy.removeValue(forKey: "fixtureExtra")
        let library = try library("cold-receipt", legacy: [legacy]), io = SubscriptionAddIO(), writer = host(library, io: io)
        _ = try await writer.start(); try await replace(writer, library, nil)
        let raw = try await request(writer, name: " \u{FEFF} ", defaultName: "Captured Calendar")
        io.arm("clear"); await uncertain { try await writer.addCalendarSubscription(requestJSON: raw) }
        let frozen = try Data(contentsOf: library.journal)
        io.arm(nil); _ = try await writer.retryPending()
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([legacy, added(raw, name: "Captured Calendar")]))
        let options = try object(await writer.getCalendarSubscriptionOptions()), expected = try XCTUnwrap(options["expected"] as? [String: Any])
        let remove = try json(["requestId": UUID().uuidString.lowercased(), "expected": expected,
            "edit": ["type": "removeFeed", "feedId": try XCTUnwrap(object(raw)["requestId"] as? String), "revision": try XCTUnwrap(expected["revision"] as? String)]])
        _ = try await writer.setCalendarSubscriptionSetting(requestJSON: remove)
        try result(await writer.probeCalendarSubscriptionAddOutcome(requestJSON: raw))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([legacy]))
        try await replace(writer, library, [b], timestamp: stamp)
        let before = try json(settings(library)), rows = try domain(library), receipts = try receiptCount(library)
        await writer.close(); try frozen.write(to: library.journal)
        // A missing RN namespace cannot be leased, but the receipt still owns the original result.
        try FileManager.default.moveItem(at: library.device, to: library.root.appendingPathComponent("revoked-device"))
        let cold = host(library), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionAddCommit"); try result(json(try XCTUnwrap(recovery["result"])))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try result(await cold.probeCalendarSubscriptionAddOutcome(requestJSON: raw)); try result(await cold.addCalendarSubscription(requestJSON: raw))
        let repeated = try object(await cold.start()); XCTAssertNil(repeated["recovery"])
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts); try privacy(library)
    }

    func testMalformedDuplicateCrossMethodAndOversizedColdJournalsRefuseBeforeEffects() async throws {
        let library = try library("cold-malformed", legacy: [b]), io = SubscriptionAddIO(), writer = host(library, io: io)
        _ = try await writer.start(); try await replace(writer, library, [a], timestamp: stamp)
        let raw = try await request(writer); io.arm("clear"); await uncertain { try await writer.addCalendarSubscription(requestJSON: raw) }
        try privateJournal(library); let frozen = try String(contentsOf: library.journal, encoding: .utf8)
        await writer.close()
        let before = try json(settings(library)), rows = try domain(library), local = try deviceBytes(library), receipts = try receiptCount(library)
        let wrapper = try object(frozen), arguments = try XCTUnwrap(wrapper["argumentsJSON"] as? String)
        let inner = try XCTUnwrap((NativeJSON.jsonObject(with: Data(arguments.utf8)) as? [String])?.first)
        let envelope = try object(inner), original = try XCTUnwrap(envelope["request"] as? [String: Any])
        func wrapped(_ input: String) throws -> String { var value = wrapper; value["argumentsJSON"] = try json([input]); return try json(value) }
        var outer = wrapper; outer["editorDraft"] = NSNull()
        var crossMethod = wrapper; crossMethod["method"] = "calendarSubscriptionSettingCommit"
        var terminal = wrapper; terminal["terminal"] = ["success": ["_0": try json(["changed": true, "toasts": [], "open": NSNull(), "clearDraft": false])]]
        var extraTerminal = wrapper; extraTerminal["terminal"] = ["success": ["_0": try json(["changed": true, "toasts": [], "open": NSNull(), "clearDraft": true]), "authority": true]]
        var forged = envelope, prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]); prepared["authority"] = true; forged["prepared"] = prepared
        var forgedStamp = envelope, stampPreparation = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        stampPreparation["stamp"] = "2099-01-01T00:00:00.002Z"; forgedStamp["prepared"] = stampPreparation
        let duplicateOuter = String(frozen.dropLast()) + ",\"method\":\"calendarSubscriptionAddCommit\"}"
        let duplicateEnvelope = String(inner.dropLast()) + ",\"request\":" + (try json(original)) + "}"
        let identifier = try XCTUnwrap(original["requestId"] as? String)
        let duplicateRequest = inner.replacingOccurrences(of: "\"requestId\":\"" + identifier + "\"", with: "\"requestId\":\"" + identifier + "\",\"requestId\":\"" + identifier + "\"")
        var oversizedArguments = wrapper; oversizedArguments["argumentsJSON"] = arguments + String(repeating: " ", count: 12_000_001 - arguments.utf8.count)
        let oversizedEnvelope = inner + String(repeating: " ", count: 4_194_305 - inner.utf8.count)
        let invalids = try [json(outer), json(crossMethod), json(terminal), json(extraTerminal), wrapped(json(forged)), wrapped(json(forgedStamp)),
            duplicateOuter, wrapped(duplicateEnvelope), wrapped(duplicateRequest), wrapped(oversizedEnvelope), json(oversizedArguments),
            frozen + String(repeating: " ", count: 24_000_001 - frozen.utf8.count)]
        XCTAssertNotEqual(duplicateRequest, inner)
        for invalid in invalids {
            try Data(invalid.utf8).write(to: library.journal)
            let cold = host(library)
            do { _ = try await cold.start(); XCTFail("Malformed retained Add journal must refuse") }
            catch { XCTAssertTrue(error is HostFailure) }
            XCTAssertEqual(try Data(contentsOf: library.journal), Data(invalid.utf8))
            XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows)
            XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try receiptCount(library), receipts)
            await cold.close()
        }
    }

    func testClosedPublicBoundaryBlankUTF16DuplicatesAndExactRequestByteLimit() async throws {
        let library = try library("public-bounds", legacy: [b]), core = host(library)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), input = try object(raw), before = try json(settings(library)), receipts = try receiptCount(library), local = try deviceBytes(library)
        var unknown = input; unknown["authority"] = true
        var blank = input; blank["url"] = " \u{FEFF}\t\n"
        var emptyDefault = input; emptyDefault["defaultName"] = " \u{FEFF} "
        var longName = input; longName["name"] = String(repeating: "😀", count: 251)
        var longURL = input; longURL["url"] = String(repeating: "😀", count: 2001)
        var longDefault = input; longDefault["defaultName"] = String(repeating: "😀", count: 251)
        var wrongType = input; wrongType["name"] = true
        let duplicate = String(raw.dropLast()) + ",\"requestId\":\"" + (try XCTUnwrap(input["requestId"] as? String)) + "\"}"
        let expected = try XCTUnwrap(input["expected"] as? [String: Any])
        let expectedJSON = try json(expected), duplicateExpected = String(expectedJSON.dropLast()) + ",\"source\":\"" + (try XCTUnwrap(expected["source"] as? String)) + "\"}"
        let nestedDuplicate = raw.replacingOccurrences(of: expectedJSON, with: duplicateExpected)
        XCTAssertNotEqual(nestedDuplicate, raw)
        for invalid in try [json(unknown), json(blank), json(emptyDefault), json(longName), json(longURL), json(longDefault), json(wrongType), duplicate, nestedDuplicate,
                            raw + String(repeating: " ", count: 1_048_577 - raw.utf8.count)] {
            await rejected { try await core.addCalendarSubscription(requestJSON: invalid) }
        }
        for method in ["calendarSubscriptionAdd", "calendarSubscriptionAddPrepare", "calendarSubscriptionAddValidate", "calendarSubscriptionAddCommit", "calendarSubscriptionAddRetryOutcome", "calendarSubscriptionAddAcknowledged"] {
            await rejected { try await core.call(method, argumentsJSON: json([raw])) }
        }
        await rejected { try await core.setCalendarSubscriptionSetting(requestJSON: raw) }
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts); XCTAssertEqual(try deviceBytes(library), local)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        let boundary = raw + String(repeating: " ", count: 1_048_576 - raw.utf8.count)
        XCTAssertEqual(boundary.utf8.count, 1_048_576); try result(await core.addCalendarSubscription(requestJSON: boundary))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([a, added(raw)]))
        XCTAssertEqual(try receiptCount(library), receipts + 1); try privacy(library)
    }

    func testWorstEscapedFrameAndUnsupportedTransportStoreWithoutProviderWork() async throws {
        let library = try library("escaped-transport", legacy: [b]), core = host(library)
        _ = try await core.start(); try await replace(core, library, [], timestamp: stamp)
        let name = String(repeating: "😀", count: 250), url = String(repeating: "\u{1}", count: 4000)
        let raw = try await request(core, name: name, url: url, defaultName: String(repeating: "\u{2}", count: 500))
        XCTAssertGreaterThan(raw.utf8.count, 24_000); try result(await core.addCalendarSubscription(requestJSON: raw))
        let arbitraryURL = "file://fixture.invalid/path?value=kept%2fCASE"
        let next = try await request(core, name: " \u{85} ", url: " \u{FEFF}" + arbitraryURL + " \n")
        try result(await core.addCalendarSubscription(requestJSON: next))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([added(raw, name: name, url: url), added(next, name: "\u{85}", url: arbitraryURL)]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path)); try privacy(library)
    }
}
