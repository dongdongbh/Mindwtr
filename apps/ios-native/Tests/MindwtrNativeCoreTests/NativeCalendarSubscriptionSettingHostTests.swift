import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class SubscriptionSettingIO: @unchecked Sendable {
    private let lock = NSLock()
    private var cut: String?, journalWrites = 0, writes = 0, receipts = 0, commits = 0, promotions = 0
    private var captured: NativeDeviceKV?
    private var replacement: String?
    func configure(_ storage: NativeDeviceKV) {
        lock.lock(); captured = storage; lock.unlock()
        storage.faults.beforePromotion = { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.promotions += 1; self.lock.unlock()
        }
    }
    func arm(_ value: String?, legacy: String? = nil) {
        lock.lock(); cut = value; replacement = legacy; journalWrites = 0; lock.unlock()
    }
    func changeLegacy(_ raw: String) throws {
        lock.lock(); let storage = captured; lock.unlock()
        try XCTUnwrap(storage).set("mindwtr-external-calendars", raw)
    }
    func beforeSQL(_ sql: String) throws {
        lock.lock()
        if sql.hasPrefix("INSERT") || sql.hasPrefix("UPDATE") || sql.hasPrefix("DELETE") { writes += 1 }
        if sql.hasPrefix("INSERT INTO native_request_receipts") { receipts += 1 }
        let fail = cut == "commit" && sql == "COMMIT" || cut == "lostCommitBlocked" && sql.hasPrefix("BEGIN")
        let changed = cut == "legacyCommit" && sql == "COMMIT", next = replacement, storage = captured
        if changed { cut = nil }
        lock.unlock()
        if changed { try XCTUnwrap(storage).set("mindwtr-external-calendars", try XCTUnwrap(next)) }
        if fail { throw HostFailure("Subscription fixture COMMIT failure") }
    }
    func afterSQL(_ sql: String) throws {
        lock.lock()
        if sql == "COMMIT" { commits += 1 }
        let fail = cut == "lostCommit" && sql == "COMMIT"
        if fail { cut = "lostCommitBlocked" }
        lock.unlock()
        if fail { throw HostFailure("Subscription fixture lost COMMIT reply") }
    }
    func journal() throws {
        lock.lock(); journalWrites += 1
        let fail = cut == "journal" || cut == "terminal" && journalWrites == 2
        lock.unlock()
        if fail { throw HostFailure("Subscription fixture journal failure") }
    }
    func clear() throws {
        lock.lock(); let fail = cut == "clear"; lock.unlock()
        if fail { throw HostFailure("Subscription fixture cleanup failure") }
    }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [writes, receipts, commits, promotions] }
}

private final class SubscriptionSettingNoReader: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { XCTFail("Subscription metadata cannot read provider permission"); throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { XCTFail("Subscription metadata cannot enumerate calendars"); throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { XCTFail("Subscription metadata cannot read events"); throw NativeCalendarReadError.unavailable }
}
private final class SubscriptionSettingNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { XCTFail("Subscription metadata cannot fetch"); client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}

/// Actual public prepared facade, production JSC and SQLite. Only transport/fault cuts are substituted.
final class NativeCalendarSubscriptionSettingHostTests: XCTestCase {
    private struct Library {
        let root: URL
        let namespace = "tech.example.mindwtr.subscription-setting"
        var database: URL { root.appendingPathComponent("core.sqlite") }
        var journal: URL { database.appendingPathExtension("pending.json") }
        var container: URL { root.appendingPathComponent("container", isDirectory: true) }
        var device: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1") }
        var manifest: URL { device.appendingPathComponent("manifest.json") }
    }
    private var root: URL!, bundle: URL!
    private let stamp = "2099-01-01T00:00:00.000Z"
    private let fresh = "SAVE_FAILED: Calendar subscription save requires fresh runtime recovery"
    private let sourceName = "mindwtr-external-calendars"
    private var a: [String: Any] { ["id": "é", "name": "PRIVATE_SUBSCRIPTION_A", "url": "https://private-subscription.invalid/a.ics?secret=fixture", "enabled": true,
        "color": "#2563EB", "areaIds": ["dangling-area", "area-a"], "fixtureExtra": ["retain": "文"]] }
    private var b: [String: Any] { ["id": "e\u{301}", "name": "PRIVATE_SUBSCRIPTION_B", "url": "https://private-subscription.invalid/b.ics", "enabled": true,
        "color": "#DB2777", "areaIds": ["area-b"]] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/calendar-subscription-settings/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Subscription fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func library(_ name: String, legacy: [[String: Any]]? = nil) throws -> Library {
        let library = Library(root: root.appendingPathComponent(name, isDirectory: true))
        try FileManager.default.createDirectory(at: library.device, withIntermediateDirectories: true)
        var cells = ["@mindwtr_sync_backend": "off", "private-unrelated-cell": "\u{FEFF}opaque 文"]
        cells[sourceName] = try legacy.map { try json($0) }
        try Data(json(cells).utf8).write(to: library.manifest)
        return library
    }
    private func host(_ library: Library, io: SubscriptionSettingIO = SubscriptionSettingIO(), supplied: URL? = nil) -> CoreHost {
        let faults = HostIOFaults()
        faults.configureDeviceStorage = { io.configure($0) }
        faults.beforeSQL = { try io.beforeSQL($0) }; faults.afterSQL = { try io.afterSQL($0) }
        faults.journalWrite = { try io.journal() }; faults.journalRemove = { try io.clear() }
        faults.calendarReaderFactory = { XCTFail("Metadata cannot create EventKit reader"); return SubscriptionSettingNoReader() }
        faults.calendarAuthorizationRequest = { XCTFail("Metadata cannot request EventKit access"); throw NativeCalendarReadError.unavailable }
        faults.notificationPermissionRead = { XCTFail("Metadata cannot read notification permission"); return .init(status: "denied", granted: false, canAskAgain: false) }
        faults.notificationAuthorizationRequest = { XCTFail("Metadata cannot request notification permission") }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        faults.secretBeforeOperation = { _, _ in XCTFail("Metadata cannot use secrets") }
        faults.cryptoBeforeOperation = { _ in XCTFail("Metadata cannot use native crypto") }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [SubscriptionSettingNoHTTP.self]; faults.httpConfiguration = config
        let core = CoreHost(databaseURL: library.database, bundleURL: supplied ?? bundle, faults: faults,
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
        var document = try object(String(contentsOf: export.url, encoding: .utf8))
        await core.discardDataBackup(export.id)
        var values = try XCTUnwrap(document["settings"] as? [String: Any])
        values["externalCalendars"] = feeds
        values["unrelated470"] = ["preserve": "\u{FEFF}raw 文"]
        var stamps = values["syncPreferencesUpdatedAt"] as? [String: Any] ?? [:]
        stamps["externalCalendars"] = timestamp; values["syncPreferencesUpdatedAt"] = stamps
        document["settings"] = values
        let selected = library.root.appendingPathComponent("import-" + UUID().uuidString + ".json")
        try json(document).write(to: selected, atomically: true, encoding: .utf8)
        let preview = try await core.prepareBackupImport(selected, action: .replace)
        XCTAssertEqual(try object(preview.json)["valid"] as? Bool, true)
        _ = try await core.mergeBackupImport(preview.id)
    }
    private func request(_ core: CoreHost, feedId: String = "é", field: String = "enabled", value: Any = false, remove: Bool = false) async throws -> String {
        let options = try object(await core.getCalendarSubscriptionOptions())
        let expected = try XCTUnwrap(options["expected"] as? [String: Any])
        var edit: [String: Any] = ["type": remove ? "removeFeed" : "feed", "feedId": feedId, "revision": try XCTUnwrap(expected["revision"] as? String)]
        if !remove { edit["field"] = field; edit["value"] = value }
        return try json(["requestId": UUID().uuidString.lowercased(), "edit": edit, "expected": expected])
    }
    private func result(_ raw: String, changed: Bool = true) throws {
        XCTAssertEqual(try json(object(raw)), try json(["changed": changed, "toasts": [], "open": NSNull(), "clearDraft": false]))
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
        // An uninitialized device ID is the one frozen initialization allowed by the prepared producer.
        if first["deviceId"] == nil { second.removeValue(forKey: "deviceId") }
        XCTAssertEqual(try json(first), try json(second))
    }
    private func privacy(_ library: Library) throws {
        let journal = (try? String(contentsOf: library.journal, encoding: .utf8)) ?? ""
        let receipts = try sql(library, "SELECT request_id, method, reply FROM native_request_receipts")
        let log = (try? String(contentsOf: library.root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
        for text in [journal, receipts, log] {
            XCTAssertFalse(text.contains("private-subscription.invalid")); XCTAssertFalse(text.contains("PRIVATE_SUBSCRIPTION"))
        }
    }
    private func uncertain(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected retained uncertainty") } catch { XCTAssertTrue(error is HostFailure, "Unexpected \(error)") }
    }
    private func rejected(_ work: () async throws -> String?) async {
        do { _ = try await work(); XCTFail("Expected definite refusal") } catch { XCTAssertTrue(error is CoreHostRejection, "Unexpected \(error)") }
    }

    func testCanonicalMetadataUsesExactUnicodeIDsPreservesRowsAndDeviceCopy() async throws {
        let library = try library("canonical", legacy: [b]), io = SubscriptionSettingIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a, b], timestamp: stamp)
        let domainBefore = try domain(library), local = try deviceBytes(library), original = try settings(library), receipts = try receiptCount(library), promotions = io.counts[3]
        try result(await core.setCalendarSubscriptionSetting(requestJSON: request(core)))
        var expectedA = a; expectedA["enabled"] = false
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([expectedA, b]))
        try result(await core.setCalendarSubscriptionSetting(requestJSON: request(core, field: "color", value: NSNull())))
        expectedA.removeValue(forKey: "color")
        try result(await core.setCalendarSubscriptionSetting(requestJSON: request(core, field: "areaIds", value: [])))
        expectedA["areaIds"] = [String]()
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([expectedA, b]))
        try result(await core.setCalendarSubscriptionSetting(requestJSON: request(core, feedId: "e\u{301}", remove: true)))
        XCTAssertEqual(try json(settings(library)["externalCalendars"]!), try json([expectedA]))
        try preservedSettings(original, settings(library))
        XCTAssertEqual(try domain(library), domainBefore); XCTAssertEqual(try deviceBytes(library), local)
        XCTAssertEqual(io.counts[3], promotions); XCTAssertEqual(try receiptCount(library), receipts + 4)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path)); try privacy(library)
    }

    func testNoopBeforeStaleAndSameStampImportReplacementHaveNoEffects() async throws {
        let library = try library("stale", legacy: [b]), core = host(library)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let changed = try await request(core), noop = try await request(core, value: true)
        var replacement = a; replacement["name"] = "PRIVATE_SUBSCRIPTION_REPLACEMENT"
        try await replace(core, library, [replacement], timestamp: stamp)
        let before = try settings(library), rows = try domain(library), local = try deviceBytes(library), receipts = try receiptCount(library)
        try result(await core.setCalendarSubscriptionSetting(requestJSON: noop), changed: false)
        await rejected { try await core.setCalendarSubscriptionSetting(requestJSON: changed) }
        XCTAssertEqual(try json(settings(library)), try json(before)); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try await replace(core, library, [], timestamp: stamp)
        let options = try object(await core.getCalendarSubscriptionOptions())
        XCTAssertEqual((options["expected"] as? [String: Any])?["source"] as? String, "canonical")
        XCTAssertEqual(((options["model"] as? [String: Any])?["items"] as? [Any])?.count, 0)
    }

    func testWarmExactRetryAtJournalCommitTerminalAndCleanupCuts() async throws {
        for cut in ["journal", "commit", "terminal", "clear"] {
            let library = try library(cut, legacy: [b]), io = SubscriptionSettingIO(), core = host(library, io: io)
            _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
            let raw = try await request(core), baseline = try domain(library), local = try deviceBytes(library), receipts = try receiptCount(library)
            io.arm(cut); await uncertain { try await core.setCalendarSubscriptionSetting(requestJSON: raw) }
            if cut != "journal" { XCTAssertTrue(FileManager.default.fileExists(atPath: library.journal.path)); try privacy(library) }
            io.arm(nil)
            let retried = try await core.retryPending()
            try result(XCTUnwrap(retried))
            try result(await core.probeCalendarSubscriptionSettingOutcome(requestJSON: raw))
            XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertEqual(try domain(library), baseline)
            XCTAssertEqual(try deviceBytes(library), local); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
            XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.first?["enabled"] as? Bool, false)
            await core.close()
        }
    }

    func testLegacyChangedBeforeCommitRetainsUntilFreshRuntimeStaleCleanupAndFreshWork() async throws {
        var legacy = a; legacy.removeValue(forKey: "fixtureExtra")
        let library = try library("legacy-cut", legacy: [legacy]), io = SubscriptionSettingIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, nil)
        let raw = try await request(core), before = try settings(library), rows = try domain(library), receipts = try receiptCount(library)
        var later = legacy; later["name"] = "PRIVATE_SUBSCRIPTION_LATER"
        io.arm("legacyCommit", legacy: try json([later]))
        do { _ = try await core.setCalendarSubscriptionSetting(requestJSON: raw); XCTFail("Stale publication must require fresh runtime") }
        catch { XCTAssertEqual(error.localizedDescription, fresh) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: library.journal.path))
        XCTAssertEqual(try json(settings(library)), try json(before)); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try receiptCount(library), receipts); try privacy(library)
        let frozen = try Data(contentsOf: library.journal)
        await uncertain { try await core.call("captureSubmit", argumentsJSON: json(["Cannot flush old snapshot"])) }
        XCTAssertEqual(try Data(contentsOf: library.journal), frozen)
        io.arm(nil); let startup = try object(await core.start())
        XCTAssertNil(startup["recovery"]); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        await rejected { try await core.probeCalendarSubscriptionSettingOutcome(requestJSON: raw) }
        let local = try deviceBytes(library)
        try result(await core.setCalendarSubscriptionSetting(requestJSON: request(core)))
        let admitted = try XCTUnwrap(settings(library)["externalCalendars"] as? [[String: Any]])
        XCTAssertEqual(admitted.first?["name"] as? String, "PRIVATE_SUBSCRIPTION_LATER")
        XCTAssertEqual(admitted.first?["enabled"] as? Bool, false)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try receiptCount(library), receipts + 1)
    }

    func testUncommittedCanonicalRetryPreservesLaterDurableSettings() async throws {
        let library = try library("later-canonical", legacy: [b]), io = SubscriptionSettingIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), receipts = try receiptCount(library)
        io.arm("commit"); await uncertain { try await core.setCalendarSubscriptionSetting(requestJSON: raw) }
        io.arm(nil)
        var later = try settings(library)
        later["externalCalendars"] = []; later["retainedOutside"] = "later durable value"
        _ = try sql(library, "UPDATE settings SET data=? WHERE id=1", [json(later)])
        let before = try json(settings(library))
        do { _ = try await core.retryPending(); XCTFail("Old failed snapshot cannot replace later durable settings") }
        catch { XCTAssertEqual(error.localizedDescription, fresh) }
        XCTAssertEqual(try json(settings(library)), before)
        XCTAssertEqual(try receiptCount(library), receipts)
        _ = try await core.start()
        XCTAssertEqual(try json(settings(library)), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        XCTAssertEqual(try receiptCount(library), receipts)
        await core.close()
    }

    func testDirtyLostCommitReceiptRequiresFreshRuntimeThenPreservesLaterSQLChoice() async throws {
        let library = try library("lost-commit", legacy: [b]), io = SubscriptionSettingIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), receipts = try receiptCount(library), local = try deviceBytes(library)
        io.arm("lostCommit"); await uncertain { try await core.setCalendarSubscriptionSetting(requestJSON: raw) }
        XCTAssertEqual(try receiptCount(library), receipts + 1)
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
        XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionSettingCommit")
        try result(json(try XCTUnwrap(recovery["result"])))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try deviceBytes(library), local)
        XCTAssertEqual(try receiptCount(library), receipts + 1); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try result(await core.probeCalendarSubscriptionSettingOutcome(requestJSON: raw)); try privacy(library)
    }

    func testColdSavedReceiptWinsAfterLaterPublicImportAndRevokedLegacyNamespace() async throws {
        var legacy = a; legacy.removeValue(forKey: "fixtureExtra")
        let library = try library("cold-receipt", legacy: [legacy]), io = SubscriptionSettingIO(), writer = host(library, io: io)
        _ = try await writer.start(); try await replace(writer, library, nil)
        let raw = try await request(writer); io.arm("clear")
        await uncertain { try await writer.setCalendarSubscriptionSetting(requestJSON: raw) }
        let frozen = try Data(contentsOf: library.journal)
        io.arm(nil); _ = try await writer.retryPending()
        try await replace(writer, library, [b], timestamp: stamp)
        let before = try json(settings(library)), rows = try domain(library), receipts = try receiptCount(library)
        await writer.close()
        try frozen.write(to: library.journal)
        // No NativeDeviceKV can lease this missing namespace, yet durable receipt remains sufficient.
        try FileManager.default.moveItem(at: library.device, to: library.root.appendingPathComponent("revoked-device"))
        let cold = host(library), startup = try object(await cold.start()), recovery = try XCTUnwrap(startup["recovery"] as? [String: Any])
        XCTAssertEqual(recovery["method"] as? String, "calendarSubscriptionSettingCommit"); try result(json(try XCTUnwrap(recovery["result"])))
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows)
        XCTAssertEqual(try receiptCount(library), receipts); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        try result(await cold.probeCalendarSubscriptionSettingOutcome(requestJSON: raw))
        let repeated = try object(await cold.start()); XCTAssertNil(repeated["recovery"])
    }

    func testMalformedOuterEnvelopeAndTerminalRefuseBeforeColdActivation() async throws {
        let library = try library("cold-malformed", legacy: [b]), io = SubscriptionSettingIO(), writer = host(library, io: io)
        _ = try await writer.start(); try await replace(writer, library, [a], timestamp: stamp)
        let raw = try await request(writer); io.arm("clear")
        await uncertain { try await writer.setCalendarSubscriptionSetting(requestJSON: raw) }
        let frozen = try String(contentsOf: library.journal, encoding: .utf8)
        await writer.close()
        let before = try json(settings(library)), rows = try domain(library), local = try deviceBytes(library), receipts = try receiptCount(library)
        let wrapper = try object(frozen)
        var outer = wrapper; outer["editorDraft"] = NSNull()
        var badTerminal = wrapper; badTerminal["terminal"] = ["success": ["_0": try json(["changed": true, "toasts": [], "open": NSNull(), "clearDraft": false]), "authority": true]]
        let arguments = try XCTUnwrap(wrapper["argumentsJSON"] as? String)
        let inner = try XCTUnwrap((NativeJSON.jsonObject(with: Data(arguments.utf8)) as? [String])?.first)
        var envelope = try object(inner); var prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
        prepared["authority"] = true; envelope["prepared"] = prepared
        var badEnvelope = wrapper; badEnvelope["argumentsJSON"] = try json([json(envelope)])
        let duplicate = String(frozen.dropLast()) + ",\"method\":\"calendarSubscriptionSettingCommit\"}"
        for invalid in try [json(outer), json(badTerminal), json(badEnvelope), duplicate, frozen + String(repeating: " ", count: 24_000_001 - frozen.utf8.count)] {
            try Data(invalid.utf8).write(to: library.journal)
            let cold = host(library)
            do { _ = try await cold.start(); XCTFail("Malformed retained journal must refuse before activation") }
            catch { XCTAssertTrue(error is HostFailure) }
            XCTAssertEqual(try Data(contentsOf: library.journal), Data(invalid.utf8))
            XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try domain(library), rows)
            XCTAssertEqual(try deviceBytes(library), local); XCTAssertEqual(try receiptCount(library), receipts)
            await cold.close()
        }
    }

    func testClosedBoundaryWorstEscapedAreaFrameAndJournalPrivacy() async throws {
        let library = try library("bounds", legacy: [b]), core = host(library)
        _ = try await core.start(); try await replace(core, library, [a], timestamp: stamp)
        let raw = try await request(core), input = try object(raw), before = try json(settings(library)), receipts = try receiptCount(library), local = try deviceBytes(library)
        var unknown = input; unknown["authority"] = true
        let duplicate = String(raw.dropLast()) + ",\"requestId\":\"" + (input["requestId"] as! String) + "\"}"
        for invalid in try [json(unknown), duplicate, raw + String(repeating: " ", count: 1_048_576)] {
            await rejected { try await core.setCalendarSubscriptionSetting(requestJSON: invalid) }
        }
        for method in ["calendarSubscriptionSetting", "calendarSubscriptionSettingOptions", "calendarSubscriptionSettingPrepare", "calendarSubscriptionSettingValidate", "calendarSubscriptionSettingCommit", "calendarSubscriptionSettingRetryOutcome", "calendarSubscriptionSettingAcknowledged"] {
            await rejected { try await core.call(method, argumentsJSON: json([raw])) }
        }
        XCTAssertEqual(try json(settings(library)), before); XCTAssertEqual(try receiptCount(library), receipts)
        XCTAssertEqual(try deviceBytes(library), local); XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        let areas = (0..<500).map { String(repeating: "\u{1}", count: 195) + String(format: "%05d", $0) }
        let oversizedFrame = try await request(core, field: "areaIds", value: areas)
        XCTAssertGreaterThan(oversizedFrame.utf8.count, 500_000); XCTAssertLessThanOrEqual(oversizedFrame.utf8.count, 1_048_576)
        try result(await core.setCalendarSubscriptionSetting(requestJSON: oversizedFrame))
        XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.first?["areaIds"] as? [String], areas)
        try privacy(library)
    }
}
