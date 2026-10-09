import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CalendarAuthorityIO: @unchecked Sendable {
    private let lock = NSLock()
    private var readOnly = false
    private var writes = 0, journals = 0, clears = 0, promotions = 0
    private var prompts = 0, factories = 0, permissions = 0, providerReads = 0
    func arm(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        readOnly = value
        writes = 0; journals = 0; clears = 0; promotions = 0
        prompts = 0; factories = 0; permissions = 0; providerReads = 0
    }
    func sql(_ statement: String) throws {
        guard statement.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\b"#, options: .regularExpression) != nil else { return }
        lock.lock(); let deny = readOnly; if deny { writes += 1 }; lock.unlock()
        if deny { throw HostFailure("Passive authority read attempted SQL mutation") }
    }
    func journal(clear: Bool = false) throws {
        lock.lock(); let deny = readOnly
        if deny { if clear { clears += 1 } else { journals += 1 } }; lock.unlock()
        if deny { throw HostFailure("Passive authority read attempted journal mutation") }
    }
    func promotion() throws {
        lock.lock(); let deny = readOnly; if deny { promotions += 1 }; lock.unlock()
        if deny { throw HostFailure("Passive authority read attempted device-copy repair") }
    }
    func factory() { lock.lock(); factories += 1; lock.unlock() }
    func permission() { lock.lock(); permissions += 1; lock.unlock() }
    func provider() { lock.lock(); providerReads += 1; lock.unlock(); XCTFail("Disabled system calendars cannot enumerate calendars or events") }
    func prompt() { lock.lock(); prompts += 1; lock.unlock(); XCTFail("Passive calendar authority cannot request authorization") }
    var counts: [Int] {
        lock.lock(); defer { lock.unlock() }
        return [writes, journals, clears, promotions, prompts, factories, permissions, providerReads]
    }
}

private final class CalendarAuthorityReader: NativeCalendarReading {
    let io: CalendarAuthorityIO
    init(_ io: CalendarAuthorityIO) { self.io = io }
    func permissions() throws -> NativeCalendarPermission { io.permission(); return .denied }
    func calendars() throws -> [[String: Any]] { io.provider(); throw NativeCalendarReadError.denied }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { io.provider(); throw NativeCalendarReadError.denied }
}

private final class CalendarAuthorityHTTP: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    var requests: [String] { lock.lock(); defer { lock.unlock() }; return seen }
    func response(_ request: URLRequest) throws -> Data {
        let url = request.url?.absoluteString ?? ""
        lock.lock(); seen.append(url); lock.unlock()
        guard request.httpMethod == "GET", url == "https://authority.example.invalid/a.ics" || url == "https://authority.example.invalid/b.ics" else {
            throw URLError(.unsupportedURL)
        }
        let isA = url.hasSuffix("/a.ics")
        let body = """
        BEGIN:VCALENDAR
        VERSION:2.0
        X-WR-CALNAME:\(isA ? "Canonical calendar" : "Stale calendar")
        BEGIN:VEVENT
        UID:\(isA ? "authority-event-a" : "authority-event-b")
        DTSTART:20361003T\(isA ? "100000" : "120000")Z
        DTEND:20361003T\(isA ? "110000" : "130000")Z
        SUMMARY:\(isA ? "Canonical authority event" : "Stale device event")
        END:VEVENT
        END:VCALENDAR

        """
        return Data(body.replacingOccurrences(of: "\n", with: "\r\n").utf8)
    }
}

private final class CalendarAuthorityProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var current: CalendarAuthorityHTTP?
    static func install(_ value: CalendarAuthorityHTTP?) { lock.lock(); current = value; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let owner = Self.current; Self.lock.unlock()
        do {
            let bytes = try XCTUnwrap(owner).response(request)
            let reply = try XCTUnwrap(HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/calendar", "Content-Length": String(bytes.count)]))
            client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: bytes)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

/// Real public backup writers and actual shared subscription loading through the production bundle.
/// URLProtocol substitutes synthetic HTTP transport only; no JSC entry method/store is replaced.
final class NativeCalendarSubscriptionAuthorityHostTests: XCTestCase {
    private struct Library {
        let root: URL
        let namespace = "tech.example.mindwtr.calendar-subscription-authority"
        var database: URL { root.appendingPathComponent("core.sqlite") }
        var journal: URL { database.appendingPathExtension("pending.json") }
        var container: URL { root.appendingPathComponent("container", isDirectory: true) }
        var deviceDirectory: URL { container.appendingPathComponent("Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1") }
        var manifest: URL { deviceDirectory.appendingPathComponent("manifest.json") }
    }
    private struct Baseline {
        let rows: [String: String]
        let deviceBytes: [String: Data]
        let manifestInode: UInt64
        let snapshots: String
    }
    private var root: URL!, bundle: URL!, http: CalendarAuthorityHTTP!
    private let day = "2036-10-03"
    private let sourceKey = "mindwtr-external-calendars"
    private var a: [String: Any] { ["id": "é", "name": "Canonical calendar", "url": "https://authority.example.invalid/a.ics", "enabled": true,
        "color": "#2563EB", "areaIds": ["area-a"]] }
    private var b: [String: Any] { ["id": "e\u{301}", "name": "Stale calendar", "url": "https://authority.example.invalid/b.ics", "enabled": true,
        "color": "#DB2777", "areaIds": ["area-b"]] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/calendar-subscription-authority/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Authority fixture root unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        http = CalendarAuthorityHTTP(); CalendarAuthorityProtocol.install(http)
    }
    override func tearDownWithError() throws {
        CalendarAuthorityProtocol.install(nil)
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func library(_ name: String, device: [[String: Any]]? = nil) throws -> Library {
        let value = Library(root: root.appendingPathComponent(name, isDirectory: true))
        try FileManager.default.createDirectory(at: value.deviceDirectory, withIntermediateDirectories: true)
        var cells = ["@mindwtr_sync_backend": "off", "unknown-calendar-record": "\u{FEFF}preserve 文"]
        cells["mindwtr-system-calendar-settings"] = try json(["enabled": false, "selectAll": true, "selectedCalendarIds": [], "areaIdsByCalendar": [:]])
        if let device { cells[sourceKey] = try json(device) }
        try Data(json(cells).utf8).write(to: value.manifest)
        return value
    }
    private func host(_ library: Library, io: CalendarAuthorityIO, bundle supplied: URL? = nil) -> CoreHost {
        let faults = HostIOFaults()
        faults.beforeSQL = { try io.sql($0) }
        faults.journalWrite = { try io.journal() }; faults.journalRemove = { try io.journal(clear: true) }
        faults.configureDeviceStorage = { storage in storage.faults.beforePromotion = { try io.promotion() } }
        faults.calendarReaderFactory = { io.factory(); return CalendarAuthorityReader(io) }
        faults.calendarAuthorizationRequest = { io.prompt(); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CalendarAuthorityProtocol.self]; faults.httpConfiguration = config
        let value = CoreHost(databaseURL: library.database, bundleURL: supplied ?? bundle, faults: faults,
            deviceStorage: (containerURL: library.container, bundleIdentifier: library.namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func settings(_ library: Library) throws -> [String: Any] {
        let sqlite = try SQLiteBridge(url: library.database); defer { sqlite.close() }
        let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT data FROM settings WHERE id = 1").utf8)) as? [[String: Any]])
        return try object(XCTUnwrap(rows.first?["data"] as? String))
    }
    private func source(_ core: CoreHost, library: Library, subscriptions: [[String: Any]]?, syncEnabled: Bool = false,
                        syncStamp: String = "2099-01-01T00:00:00.000Z") async throws -> URL {
        let export = try await core.prepareDataBackup()
        var document = try object(String(contentsOf: export.url, encoding: .utf8))
        await core.discardDataBackup(export.id)
        var values = try XCTUnwrap(document["settings"] as? [String: Any])
        values["externalCalendars"] = subscriptions
        var preferences = values["syncPreferences"] as? [String: Any] ?? [:]
        preferences["externalCalendars"] = syncEnabled; values["syncPreferences"] = preferences
        if syncEnabled {
            var stamps = values["syncPreferencesUpdatedAt"] as? [String: Any] ?? [:]
            stamps["externalCalendars"] = syncStamp; values["syncPreferencesUpdatedAt"] = stamps
        }
        document["settings"] = values
        let url = library.root.appendingPathComponent("selected-" + UUID().uuidString + ".json")
        try json(document).write(to: url, atomically: true, encoding: .utf8)
        return url
    }
    @discardableResult
    private func replace(_ core: CoreHost, library: Library, subscriptions: [[String: Any]]?, syncEnabled: Bool = false,
                         action: NativeBackupImportAction = .replace, syncStamp: String = "2099-01-01T00:00:00.000Z") async throws -> [String: Any] {
        let url = try await source(core, library: library, subscriptions: subscriptions, syncEnabled: syncEnabled, syncStamp: syncStamp)
        let preview = try await core.prepareBackupImport(url, action: action)
        XCTAssertEqual(try object(preview.json)["valid"] as? Bool, true)
        let result = try object(await core.mergeBackupImport(preview.id))
        XCTAssertEqual(result["operation"] as? String, action.operation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        return result
    }
    private func snapshots(_ core: CoreHost) async throws -> [[String: Any]] {
        let encoded = try await core.listBackupSnapshots()
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(encoded.utf8)) as? [[String: Any]])
    }
    private func domainRows(_ library: Library) throws -> [String: String] {
        let sqlite = try SQLiteBridge(url: library.database); defer { sqlite.close() }
        let tables = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").utf8)) as? [[String: Any]])
        var result: [String: String] = [:]
        for table in tables {
            let name = try XCTUnwrap(table["name"] as? String), quoted = name.replacingOccurrences(of: "\"", with: "\"\"")
            let columns = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("PRAGMA table_info(\"\(quoted)\")").utf8)) as? [[String: Any]])
            let projection = try columns.enumerated().map { index, column -> String in
                let field = "\"" + (try XCTUnwrap(column["name"] as? String)).replacingOccurrences(of: "\"", with: "\"\"") + "\""
                return "typeof(\(field)) AS c\(index)type, CASE WHEN typeof(\(field)) IN ('blob','text') THEN hex(\(field)) ELSE quote(\(field)) END AS c\(index)value"
            }.joined(separator: ",")
            let rows = try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT \(projection) FROM \"\(quoted)\"").utf8)) as? [[String: Any]])
            result[name] = try rows.map { try json($0) }.sorted().joined(separator: "\n")
        }
        return result
    }
    private func deviceBytes(_ library: Library) throws -> [String: Data] {
        let files = try XCTUnwrap(FileManager.default.enumerator(at: library.deviceDirectory, includingPropertiesForKeys: [.isRegularFileKey]))
        var result: [String: Data] = [:]
        while let file = files.nextObject() as? URL {
            if try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                result[String(file.path.dropFirst(library.deviceDirectory.path.count))] = try Data(contentsOf: file)
            }
        }
        return result
    }
    private func inode(_ file: URL) throws -> UInt64 {
        var value = stat(); guard lstat(file.path, &value) == 0 else { throw HostFailure("Fixture manifest unavailable") }
        return UInt64(value.st_ino)
    }
    private func baseline(_ core: CoreHost, library: Library) async throws -> Baseline {
        let roster = try await snapshots(core)
        return try Baseline(rows: domainRows(library), deviceBytes: deviceBytes(library), manifestInode: inode(library.manifest), snapshots: json(roster))
    }
    private func assertPassive(_ before: Baseline, core: CoreHost, library: Library, io: CalendarAuthorityIO, permissionReads: Int = 0) async throws {
        XCTAssertEqual(try domainRows(library), before.rows, "A passive read preserves every SQL value/type/byte, including ordinary receipts")
        XCTAssertEqual(try deviceBytes(library), before.deviceBytes)
        XCTAssertEqual(try inode(library.manifest), before.manifestInode, "Same-byte device-copy repair is still a forbidden promotion")
        let roster = try await snapshots(core)
        XCTAssertEqual(try json(roster), before.snapshots)
        XCTAssertFalse(FileManager.default.fileExists(atPath: library.journal.path))
        let counts = io.counts
        XCTAssertEqual(Array(counts.prefix(5)), [0, 0, 0, 0, 0], "No SQL/journal/KV repair/authorization attempt is permitted")
        XCTAssertEqual(counts[6], permissionReads); XCTAssertEqual(counts[7], 0)
        if permissionReads == 0 { XCTAssertEqual(counts[5], 0) }
    }
    private func feed(_ core: CoreHost) async throws -> [String: Any] {
        try object(await core.calendarRead(requestJSON: json(["op": "feed", "slot": "calendar",
            "start": "2036-10-03T00:00:00.000Z", "end": "2036-10-04T00:00:00.000Z", "refresh": true])))
    }
    private func assertFeed(_ feed: [String: Any], source: [String: Any]?) throws {
        XCTAssertEqual(feed["status"] as? String, "ready"); XCTAssertNil(feed["warning"])
        let events = try XCTUnwrap(feed["events"] as? [[String: Any]])
        guard let source else { XCTAssertTrue(events.isEmpty); return }
        let id = try XCTUnwrap(source["id"] as? String)
        XCTAssertEqual(events.count, 1)
        let eventSourceID = try XCTUnwrap(events.first?["sourceId"] as? String)
        XCTAssertEqual(Data(eventSourceID.utf8), Data(id.utf8))
        XCTAssertEqual(events.first?["title"] as? String, (source["url"] as? String)?.hasSuffix("/a.ics") == true ? "Canonical authority event" : "Stale device event")
        let calendars = try XCTUnwrap(feed["calendars"] as? [[String: Any]])
        let calendar = try XCTUnwrap(calendars.first { ($0["id"] as? String).map { Data($0.utf8) } == Data(id.utf8) })
        XCTAssertEqual(calendar["name"] as? String, source["name"] as? String)
        XCTAssertEqual(calendar["color"] as? String, source["color"] as? String)
        XCTAssertNil(calendar["feedColor"], "The fixture has no ICS-provided color; its subscription color remains separate")
        XCTAssertEqual(calendar["areaIds"] as? [String], source["areaIds"] as? [String])
    }

    func testActualReplacementAndMergeImportsFeedCanonicalSourcesWithoutSettingsOrDeviceRepair() async throws {
        for action in [NativeBackupImportAction.replace, .merge] {
            for absent in [true, false] {
                let library = try library(action.operation + (absent ? "-missing" : "-stale"), device: absent ? nil : [b])
                let original = try Data(contentsOf: library.manifest), io = CalendarAuthorityIO(), core = host(library, io: io)
                _ = try await core.start()
                if action == .merge {
                    // Replacement advances the group's revision, so give the incoming merge
                    // a later revision instead of relying on a same-stamp tie.
                    try await replace(core, library: library, subscriptions: [], syncEnabled: true,
                        syncStamp: "2098-01-01T00:00:00.000Z")
                }
                try await replace(core, library: library, subscriptions: [a], syncEnabled: action == .merge, action: action)
                let saved = try XCTUnwrap(settings(library)["externalCalendars"] as? [[String: Any]])
                XCTAssertEqual(saved.count, 1); XCTAssertEqual(Data(try XCTUnwrap(saved.first?["id"] as? String).utf8), Data("é".utf8))
                XCTAssertEqual(try Data(contentsOf: library.manifest), original)
                let before = try await baseline(core, library: library), count = http.requests.count
                io.arm(true)
                let loaded = try await feed(core); try assertFeed(loaded, source: a)
                XCTAssertEqual(Array(http.requests.dropFirst(count)), ["https://authority.example.invalid/a.ics"])
                try await assertPassive(before, core: core, library: library, io: io)
                await core.close()
            }
        }
    }

    func testImportedCanonicalEmptyAndDisabledSourceNeverResurrectPoisonedDeviceCopy() async throws {
        var disabled = a; disabled["enabled"] = false
        for (name, subscriptions) in [("empty", [[String: Any]]()), ("disabled", [disabled])] {
            let library = try library(name, device: [b]), original = try Data(contentsOf: library.manifest)
            let io = CalendarAuthorityIO(), core = host(library, io: io); _ = try await core.start()
            try await replace(core, library: library, subscriptions: subscriptions)
            XCTAssertEqual((try settings(library)["externalCalendars"] as? [[String: Any]])?.count, subscriptions.count)
            let before = try await baseline(core, library: library), count = http.requests.count
            io.arm(true)
            let loaded = try await feed(core); try assertFeed(loaded, source: nil)
            XCTAssertEqual(http.requests.count, count)
            XCTAssertEqual(try Data(contentsOf: library.manifest), original)
            try await assertPassive(before, core: core, library: library, io: io); await core.close()
        }
    }

    func testActualColdSnapshotRestoreFeedsRestoredCanonicalSourcesAndEmptyWithoutSettings() async throws {
        for empty in [false, true] {
            let library = try library(empty ? "restore-empty" : "restore-a", device: [b])
            let original = try Data(contentsOf: library.manifest), io = CalendarAuthorityIO()
            let core = host(library, io: io); _ = try await core.start()
            try await replace(core, library: library, subscriptions: empty ? [] : [a])
            let changed = try await replace(core, library: library, subscriptions: [b])
            let roster = try await snapshots(core)
            let reference = try XCTUnwrap(roster.first { $0["name"] as? String == changed["snapshotName"] as? String })
            await core.close()
            let reopened = host(library, io: io); _ = try await reopened.start()
            let restored = try object(await reopened.restoreBackupSnapshot(json(reference)))
            XCTAssertEqual(restored["operation"] as? String, "restore")
            let saved = try XCTUnwrap(settings(library)["externalCalendars"] as? [[String: Any]])
            XCTAssertEqual(saved.count, empty ? 0 : 1)
            if !empty { XCTAssertEqual(Data(try XCTUnwrap(saved.first?["id"] as? String).utf8), Data("é".utf8)) }
            let before = try await baseline(reopened, library: library), count = http.requests.count
            io.arm(true)
            let loaded = try await feed(reopened); try assertFeed(loaded, source: empty ? nil : a)
            XCTAssertEqual(Array(http.requests.dropFirst(count)), empty ? [] : ["https://authority.example.invalid/a.ics"])
            XCTAssertEqual(try Data(contentsOf: library.manifest), original)
            try await assertPassive(before, core: reopened, library: library, io: io); await reopened.close()
        }
    }

    func testMissingCanonicalFieldKeepsLegacyDeviceFallbackWithoutManufacturingSettingsOrCopy() async throws {
        for missing in [false, true] {
            let library = try library(missing ? "legacy-missing" : "legacy-b", device: missing ? nil : [b])
            let io = CalendarAuthorityIO(), core = host(library, io: io); _ = try await core.start()
            XCTAssertNil(try settings(library)["externalCalendars"])
            let before = try await baseline(core, library: library), count = http.requests.count
            io.arm(true)
            let loaded = try await feed(core); try assertFeed(loaded, source: missing ? nil : b)
            XCTAssertEqual(Array(http.requests.dropFirst(count)), missing ? [] : ["https://authority.example.invalid/b.ics"])
            XCTAssertNil(try settings(library)["externalCalendars"])
            try await assertPassive(before, core: core, library: library, io: io); await core.close()
        }
    }

    func testSameHostDocumentReplacementBypassesSourceCacheAndUnchangedSourceStillThrottles() async throws {
        let library = try library("source-cache", device: [a]), io = CalendarAuthorityIO()
        // All entry/loader/parser/writer code remains production; only cache time is held constant.
        let clock = root.appendingPathComponent("authority-clock.js")
        try (String(contentsOf: bundle, encoding: .utf8) + "\n;Date.now=()=>1791504000000;\n")
            .write(to: clock, atomically: true, encoding: .utf8)
        let core = host(library, io: io, bundle: clock); _ = try await core.start()
        try await replace(core, library: library, subscriptions: [a])
        var before = try await baseline(core, library: library), count = http.requests.count
        io.arm(true)
        let first = try await feed(core); try assertFeed(first, source: a)
        XCTAssertEqual(Array(http.requests.dropFirst(count)), ["https://authority.example.invalid/a.ics"])
        try await assertPassive(before, core: core, library: library, io: io)
        io.arm(false); try await replace(core, library: library, subscriptions: [b])
        before = try await baseline(core, library: library); count = http.requests.count; io.arm(true)
        let changed = try await feed(core); try assertFeed(changed, source: b)
        XCTAssertEqual(Array(http.requests.dropFirst(count)), ["https://authority.example.invalid/b.ics"])
        let unchanged = try await feed(core); try assertFeed(unchanged, source: b)
        XCTAssertEqual(http.requests.count, count + 1, "Same-source healthy refresh retains the one-second throttle")
        try await assertPassive(before, core: core, library: library, io: io)
        io.arm(false); try await replace(core, library: library, subscriptions: [])
        before = try await baseline(core, library: library); count = http.requests.count; io.arm(true)
        let removed = try await feed(core); try assertFeed(removed, source: nil)
        XCTAssertEqual(http.requests.count, count, "Canonical removal cannot replay the previous source cache")
        try await assertPassive(before, core: core, library: library, io: io)
    }

    func testActualCanonicalHTTPFeedProtectsComposerOverlapWithoutAnyPreparedWrite() async throws {
        let library = try library("composer-missing-cell"), io = CalendarAuthorityIO(), core = host(library, io: io)
        _ = try await core.start(); try await replace(core, library: library, subscriptions: [a])
        let before = try await baseline(core, library: library); io.arm(true)
        let loaded = try await feed(core); try assertFeed(loaded, source: a)
        let events = try XCTUnwrap(loaded["events"] as? [[String: Any]])
        let eventStart = try XCTUnwrap(events.first?["start"] as? String)
        let instant = ISO8601DateFormatter()
        instant.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let eventDate = try XCTUnwrap(instant.date(from: eventStart))
        let local = DateFormatter()
        local.calendar = Calendar(identifier: .gregorian)
        local.locale = Locale(identifier: "en_US_POSIX")
        local.timeZone = ProcessInfo.processInfo.environment["TZ"].flatMap { TimeZone(identifier: $0) } ?? .current
        local.dateFormat = "yyyy-MM-dd"
        let selectedDay = local.string(from: eventDate)
        local.dateFormat = "HH:mm"
        let startTime = local.string(from: eventDate)
        let shown = try object(await core.call("menuRead", argumentsJSON: json(["calendar", json([
            "state": ["viewMode": "day", "selectedDate": selectedDay, "visibleMonth": selectedDay], "offset": 0, "limit": 100, "calendar": loaded,
        ])])))
        let entries = try XCTUnwrap(shown["items"] as? [[String: Any]])
        XCTAssertTrue(entries.contains { ($0["item"] as? [String: Any])?["eventId"] as? String != nil })
        let opened = try object(await core.call("calendarComposerOpen", argumentsJSON: json([json([
            "at": eventStart, "mode": "new", "calendar": loaded,
        ])])))
        let wrapper = try XCTUnwrap(opened["composer"] as? [String: Any])
        var composer = try XCTUnwrap(wrapper["composer"] as? [String: Any])
        for edit in [["type": "title", "title": "Authority planned task"], ["type": "duration", "minutes": 30], ["type": "startTime", "value": startTime]] as [[String: Any]] {
            let edited = try object(await core.call("calendarComposerEdit", argumentsJSON: json([json([
                "composer": composer, "edit": edit, "calendar": loaded,
            ])])))
            composer = try XCTUnwrap(edited["composer"] as? [String: Any])
        }
        XCTAssertEqual(composer["startAt"] as? String, eventStart, "The local edit must still overlap the exact loaded UTC occurrence")
        let saved = try object(await core.call("calendarComposerSave", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "composer": composer, "calendar": loaded,
        ])])))
        XCTAssertEqual(saved["changed"] as? Bool, false)
        let refusedView = try XCTUnwrap(saved["composer"] as? [String: Any])
        let refused = try XCTUnwrap(refusedView["composer"] as? [String: Any])
        XCTAssertEqual((refused["error"] as? [String: Any])?["code"] as? String, "overlap")
        try await assertPassive(before, core: core, library: library, io: io)
    }

    func testNativePassiveSettingsShowsCanonicalAndLegacyListsWithoutAttemptingCopyRepair() async throws {
        let cases: [(String, [[String: Any]]?, [[String: Any]]?)] = [
            ("settings-a-missing", [a], nil), ("settings-a-stale", [a], [b]),
            ("settings-empty-stale", [], [b]), ("settings-legacy", nil, [b]),
        ]
        for (name, canonical, device) in cases {
            let library = try library(name, device: device), io = CalendarAuthorityIO(), core = host(library, io: io)
            _ = try await core.start()
            if let canonical { try await replace(core, library: library, subscriptions: canonical) }
            let before = try await baseline(core, library: library), count = http.requests.count
            io.arm(true)
            let opened = try object(await core.calendarRead(requestJSON: "{\"op\":\"openSettings\"}"))
            let current = try object(await core.calendarRead(requestJSON: "{\"op\":\"getSettings\"}"))
            for shown in [opened, current] {
                let feeds = try XCTUnwrap(shown["feeds"] as? [String: Any])
                let items = try XCTUnwrap(feeds["items"] as? [[String: Any]])
                let expected = canonical ?? device ?? []
                XCTAssertEqual(items.compactMap { ($0["id"] as? String).map { Data($0.utf8) } }, expected.compactMap { ($0["id"] as? String).map { Data($0.utf8) } })
            }
            _ = try await core.calendarRead(requestJSON: "{\"op\":\"closeSettings\"}")
            XCTAssertEqual(http.requests.count, count)
            try await assertPassive(before, core: core, library: library, io: io, permissionReads: 2)
            await core.close()
        }
    }
}
