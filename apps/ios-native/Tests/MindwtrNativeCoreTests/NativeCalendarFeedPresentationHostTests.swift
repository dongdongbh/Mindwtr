import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class CalendarFeedPresentationIO: @unchecked Sendable {
    private let lock = NSLock()
    private var domainWrites = 0, journalWrites = 0, providers = 0
    func sql(_ statement: String) {
        if statement.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|projects|settings|native_request_receipts)\b"#, options: .regularExpression) != nil {
            lock.lock(); domainWrites += 1; lock.unlock()
        }
    }
    func journal() { lock.lock(); journalWrites += 1; lock.unlock() }
    func provider() { lock.lock(); providers += 1; lock.unlock(); XCTFail("Frozen Calendar presentation cannot access a provider") }
    func reset() { lock.lock(); domainWrites = 0; journalWrites = 0; providers = 0; lock.unlock() }
    var counts: [Int] { lock.lock(); defer { lock.unlock() }; return [domainWrites, journalWrites, providers] }
}

private final class CalendarFeedPresentationNoReader: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { XCTFail("Unexpected Calendar permission read"); throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { XCTFail("Unexpected Calendar source read"); throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { XCTFail("Unexpected Calendar event read"); throw NativeCalendarReadError.unavailable }
}

private final class CalendarFeedPresentationNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Frozen Calendar presentation cannot request HTTP")
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
    }
    override func stopLoading() {}
}

/// Uses the unmodified production bundle and public closed native methods.
/// Injected feeds prove JSC admission/presentation/availability, not EventKit.
final class NativeCalendarFeedPresentationHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let namespace = "tech.example.mindwtr.calendar-feed-presentation"
    private let taskID = "ba24c776-8c89-4219-a6a9-dc08b6e67430"
    private let day = "2036-10-03"
    private var source: [String: Any] { ["id": "PRIVATE_TRANSIENT_SOURCE", "name": "PRIVATE_TRANSIENT_SOURCE_NAME", "enabled": true,
        "url": "https://PRIVATE_TRANSIENT_URL.invalid/calendar.ics"] }
    private var event: [String: Any] { ["id": "PRIVATE_TRANSIENT_EVENT", "sourceId": source["id"]!, "title": "PRIVATE_TRANSIENT_EVENT_TITLE",
        "start": "2036-10-03T10:00:00.000Z", "end": "2036-10-03T11:00:00.000Z", "allDay": false,
        "description": "PRIVATE_TRANSIENT_DESCRIPTION", "location": "PRIVATE_TRANSIENT_LOCATION", "nativeEventId": "PRIVATE_TRANSIENT_NATIVE_ID"] }
    private var ready: [String: Any] { ["status": "ready", "calendars": [source], "events": [event]] }
    private var state: [String: Any] { ["viewMode": "day", "selectedDate": day, "visibleMonth": day] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/calendar-feed-presentation/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Calendar feed fixture is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        let manifest = root.appendingPathComponent("container/Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func host(_ io: CalendarFeedPresentationIO = CalendarFeedPresentationIO(), faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        faults.beforeSQL = { io.sql($0) }; faults.journalWrite = { io.journal() }
        faults.calendarReaderFactory = { io.provider(); return CalendarFeedPresentationNoReader() }
        faults.calendarAuthorizationRequest = { io.provider(); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CalendarFeedPresentationNoHTTP.self]; faults.httpConfiguration = configuration
        let value = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults,
            deviceStorage: (containerURL: root.appendingPathComponent("container"), bundleIdentifier: namespace))
        addTeardownBlock { await value.close() }; return value
    }
    private func seedTask() async throws {
        let writer = host(); _ = try await writer.start()
        let capture = try object(await writer.call("captureOpen"))
        _ = try await writer.call("captureSubmit", argumentsJSON: json([json([
            "text": "Calendar task fixture", "options": XCTUnwrap(capture["options"]), "captureId": taskID, "openAfterSave": false,
        ])]))
        await writer.close()
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        _ = try sqlite.execute("UPDATE tasks SET status = 'next', startTime = ?, timeEstimate = '30min' WHERE id = ?",
            parametersJSON: json(["2036-10-03T14:00:00.000Z", taskID]))
    }
    private func menu(_ core: CoreHost, name: String = "calendar", input: [String: Any]) async throws -> [String: Any] {
        try object(await core.call("menuRead", argumentsJSON: json([name, json(input)])))
    }
    private func view(_ core: CoreHost, mode: String = "day", feed: [String: Any]) async throws -> [String: Any] {
        var period = state; period["viewMode"] = mode
        return try await menu(core, input: ["state": period, "offset": 0, "limit": 100, "calendar": feed])
    }
    private func taskRows() throws -> String {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        // SQLiteBridge serializes dictionary members in arbitrary order. Keep
        // every persisted column, with deterministic object-member ordering.
        return try json(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT * FROM tasks ORDER BY id").utf8)))
    }
    private func receipts() throws -> String {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try json(NativeJSON.jsonObject(with: Data(sqlite.execute("SELECT request_id, method, reply, saved_at FROM native_request_receipts ORDER BY request_id").utf8)))
    }
    private func refused(_ work: () async throws -> Void, contains: String? = nil, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await work(); XCTFail("Expected Calendar refusal", file: file, line: line) }
        catch { if let contains { XCTAssertTrue(error.localizedDescription.contains(contains), error.localizedDescription, file: file, line: line) } }
    }
    private func composer(_ core: CoreHost, mode: String, feed: [String: Any]? = nil) async throws -> [String: Any] {
        var input: [String: Any] = ["day": mode == "new" ? day : "2036-10-04"]
        if mode == "new" { input["mode"] = mode; input["rawMinutes"] = 37 } else { input["scheduleTaskId"] = taskID }
        input["calendar"] = feed
        let opened = try object(await core.call("calendarComposerOpen", argumentsJSON: json([json(input)])))
        let wrapper = try XCTUnwrap(opened["composer"] as? [String: Any])
        let value = try XCTUnwrap(wrapper["composer"] as? [String: Any])
        if mode != "new" { return value }
        var edit: [String: Any] = ["composer": value, "edit": ["type": "title", "title": "Calendar planned task"]]; edit["calendar"] = feed
        let edited = try object(await core.call("calendarComposerEdit", argumentsJSON: json([json(edit)])))
        return try XCTUnwrap(edited["composer"] as? [String: Any])
    }

    func testActualJSCAllModesRetainRefreshAndPartialEventsExposeFailuresAndKeepTasks() async throws {
        try await seedTask()
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start(); io.reset()
        let before = try taskRows(), beforeReceipts = try receipts()
        for mode in ["month", "week", "day", "schedule"] {
            let shown = try await view(core, mode: mode, feed: ready)
            XCTAssertEqual(try json(XCTUnwrap(shown["feedState"])), try json(["status": "ready", "message": NSNull()]))
            var refreshing = ready; refreshing["status"] = "loading"
            let loading = try await view(core, mode: mode, feed: refreshing)
            let loadingState = try XCTUnwrap(loading["feedState"] as? [String: Any]), text = try XCTUnwrap(shown["text"] as? [String: Any])
            XCTAssertEqual(loadingState["status"] as? String, "loading"); XCTAssertEqual(loadingState["message"] as? String, text["loading"] as? String)
            XCTAssertEqual(try json(XCTUnwrap(loading["items"])), try json(XCTUnwrap(shown["items"])))
            var partial = ready; partial["warning"] = "Failed to load events"
            let warning = try await view(core, mode: mode, feed: partial)
            XCTAssertEqual(try json(XCTUnwrap(warning["feedState"])), try json(["status": "ready", "message": "Failed to load events"]))
            XCTAssertEqual(try json(XCTUnwrap(warning["items"])), try json(XCTUnwrap(shown["items"])))
            let failed = try await view(core, mode: mode, feed: ["status": "error", "message": "Feed unavailable", "calendars": [source]])
            let empty = try await view(core, mode: mode, feed: ["status": "ready", "calendars": [source], "events": []])
            XCTAssertEqual(try json(XCTUnwrap(failed["feedState"])), try json(["status": "error", "message": "Feed unavailable"]))
            XCTAssertEqual(try json(XCTUnwrap(failed["items"])), try json(XCTUnwrap(empty["items"])))
        }
        let presented = try await view(core, feed: ready), entries = try XCTUnwrap(presented["items"] as? [[String: Any]])
        XCTAssertTrue(entries.contains { ($0["item"] as? [String: Any])?["taskId"] as? String == taskID })
        XCTAssertTrue(entries.contains { ($0["item"] as? [String: Any])?["eventId"] as? String == event["id"] as? String })
        XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts); XCTAssertEqual(io.counts, [0, 0, 0])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testClosedBrowseAndComposerGrammarRejectsCommandsDuplicateMembersAndEventActionsWithoutEffects() async throws {
        try await seedTask()
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start(); io.reset()
        let valid: [String: Any] = ["state": state, "offset": 0, "limit": 100, "calendar": ready]
        _ = try await menu(core, input: valid)
        let sheet = try await menu(core, name: "calendarItem", input: ["taskId": taskID, "state": state, "calendar": ready])
        XCTAssertEqual(sheet["kind"] as? String, "task")
        for field in ["op", "action", "refresh", "requestId", "permissionGranted", "event", "canOpen"] {
            var input = valid; input[field] = "PRIVATE_TRANSIENT_COMMAND"
            await refused { _ = try await self.menu(core, input: input) }
        }
        await refused { _ = try await self.menu(core, name: "calendarItem", input: ["event": self.event, "canOpen": true, "calendar": self.ready]) }
        await refused { _ = try await self.menu(core, name: "calendarPreferences", input: ["calendar": self.ready]) }
        for name in ["calendar", "calendarItem"] {
            for raw in ["[]", "null", "invalid", #"{"calendar":{"status":"ready","status":"error","calendars":[],"events":[]},"offset":0,"limit":100}"#,
                #"{"calendar":{"status":"ready","calendars":[],"events":[]},"calendar":{"status":"ready","calendars":[],"events":[]}}"#] {
                await refused { _ = try await core.call("menuRead", argumentsJSON: self.json([name, raw])) }
            }
        }
        for method in ["calendarComposerOpen", "calendarComposerEdit", "calendarComposerSave"] {
            await refused { _ = try await core.call(method, argumentsJSON: self.json([#"{"calendar":{"status":"ready","status":"loading","events":[],"calendars":[]}}"#])) }
        }
        await refused { _ = try await core.call("calendarComposerOpen", argumentsJSON: self.json([self.json(["day": self.day, "calendar": self.ready, "action": "createEvent"])])) }
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testActualSharedFeedValidatorEnforcesCountFieldAndMessageBoundsAndPreservesOpaqueIDs() async throws {
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start(); io.reset()
        let calendars = (0..<200).map { index -> [String: Any] in var value = source; value["id"] = "source-\(index)"; return value }
        let events = (0..<2000).map { index -> [String: Any] in var value = event; value["id"] = "event-\(index)"; value["sourceId"] = "source-\(index % 200)"; return value }
        _ = try await view(core, feed: ["status": "ready", "calendars": calendars, "events": events])
        for feed in [["status": "ready", "calendars": calendars + [source], "events": []],
                     ["status": "ready", "calendars": calendars, "events": events + [event]]] as [[String: Any]] {
            await refused({ _ = try await self.view(core, feed: feed) }, contains: "INVALID_INPUT")
        }
        for (field, maximum) in [("id", 500), ("sourceId", 500), ("nativeEventId", 500), ("title", 2000), ("start", 64), ("end", 64), ("description", 20_000), ("location", 2000)] {
            var invalid = event; invalid[field] = String(repeating: "x", count: maximum + 1)
            await refused({ _ = try await self.view(core, feed: ["status": "ready", "calendars": [self.source], "events": [invalid]]) }, contains: "INVALID_INPUT")
        }
        for (field, maximum) in [("id", 500), ("name", 2000), ("color", 64), ("feedColor", 64)] {
            var invalid = source; invalid[field] = String(repeating: "x", count: maximum + 1)
            await refused({ _ = try await self.view(core, feed: ["status": "ready", "calendars": [invalid], "events": []]) }, contains: "INVALID_INPUT")
        }
        for areaIds in [Array(repeating: "area", count: 201), [String(repeating: "x", count: 201)], [1]] as [Any] {
            var invalid = source; invalid["areaIds"] = areaIds
            await refused({ _ = try await self.view(core, feed: ["status": "ready", "calendars": [invalid], "events": []]) }, contains: "INVALID_INPUT")
        }
        for status in ["error", "ready"] {
            var feed: [String: Any] = ["status": status, "calendars": [source], "events": []]
            feed[status == "error" ? "message" : "warning"] = String(repeating: "é", count: 2000)
            _ = try await view(core, feed: feed)
            feed[status == "error" ? "message" : "warning"] = String(repeating: "é", count: 2001)
            await refused({ _ = try await self.view(core, feed: feed) }, contains: "INVALID_INPUT")
        }
        let opaque = ["calendar-é", "calendar-e\u{301}"]
        let unicodeSources = opaque.map { id -> [String: Any] in var value = source; value["id"] = id; return value }
        let unicodeEvents = opaque.map { id -> [String: Any] in var value = event; value["id"] = id; value["sourceId"] = id; return value }
        let presented = try await view(core, feed: ["status": "ready", "calendars": unicodeSources, "events": unicodeEvents])
        let entries = try XCTUnwrap(presented["items"] as? [[String: Any]])
        let ids = entries.compactMap { ($0["item"] as? [String: Any])?["eventId"] as? String }.map { Data($0.utf8) }
        XCTAssertEqual(Set(ids), Set(opaque.map { Data($0.utf8) }))
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testCompleteInnerRequestsAcceptTwoMillionUTF8BytesAndRejectOneMoreBeforeEffects() async throws {
        try await seedTask()
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start(); io.reset()
        func boundary(_ input: [String: Any]) throws -> String {
            let raw = try json(input)
            XCTAssertGreaterThan(raw.utf8.count, raw.count, "Fixture includes multibyte text")
            return raw + String(repeating: " ", count: 2_000_000 - raw.utf8.count)
        }
        var unicodeFeed = ready; var unicodeEvent = event; unicodeEvent["title"] = "é🙂"; unicodeFeed["events"] = [unicodeEvent]
        let requests: [(String, String, [String: Any])] = [
            ("menuRead", "calendar", ["state": state, "offset": 0, "limit": 100, "calendar": unicodeFeed]),
            ("menuRead", "calendarItem", ["taskId": taskID, "state": state, "calendar": unicodeFeed]),
            ("calendarComposerOpen", "", ["day": day, "mode": "new", "calendar": unicodeFeed]),
        ]
        for (method, name, input) in requests {
            let raw = try boundary(input); XCTAssertEqual(raw.utf8.count, 2_000_000)
            _ = try await core.call(method, argumentsJSON: json(method == "menuRead" ? [name, raw] : [raw]))
            await refused { _ = try await core.call(method, argumentsJSON: self.json(method == "menuRead" ? [name, raw + " "] : [raw + " "])) }
        }
        let created = try await composer(core, mode: "new")
        let editing = try boundary(["composer": created, "edit": ["type": "title", "title": "é🙂"], "calendar": unicodeFeed])
        let edited = try object(await core.call("calendarComposerEdit", argumentsJSON: json([editing])))
        await refused { _ = try await core.call("calendarComposerEdit", argumentsJSON: self.json([editing + " "])) }
        XCTAssertEqual(io.counts, [0, 0, 0])
        let saving = try boundary(["requestId": UUID().uuidString.lowercased(), "composer": XCTUnwrap(edited["composer"]), "calendar": unicodeFeed])
        let saved = try object(await core.call("calendarComposerSave", argumentsJSON: json([saving])))
        XCTAssertEqual(saved["changed"] as? Bool, true)
        let after = io.counts, rows = try taskRows(), receiptRows = try receipts()
        await refused { _ = try await core.call("calendarComposerSave", argumentsJSON: self.json([saving + " "])) }
        XCTAssertEqual(io.counts, after); XCTAssertEqual(try taskRows(), rows); XCTAssertEqual(try receipts(), receiptRows)
        XCTAssertEqual(io.counts[2], 0); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testSuppliedNonReadyFeedRefusesAllComposerOperationsWithoutSuggestionOrPreparedWrite() async throws {
        try await seedTask()
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start(); io.reset()
        let created = try await composer(core, mode: "new"), existing = try await composer(core, mode: "existing")
        let before = try taskRows(), beforeReceipts = try receipts()
        for feed in [["status": "loading", "calendars": [source]], ["status": "loading", "calendars": [source], "events": [event]],
                     ["status": "error", "message": "PRIVATE_TRANSIENT_ERROR_URL", "calendars": [source]]] as [[String: Any]] {
            for opening in [["day": day, "mode": "new"], ["day": day, "scheduleTaskId": taskID], ["at": created["startAt"]!]] as [[String: Any]] {
                var input = opening; input["calendar"] = feed
                await refused({ _ = try await core.call("calendarComposerOpen", argumentsJSON: self.json([self.json(input)])) }, contains: "ACTION_FAILED")
            }
            for edit in [["type": "startTime", "value": "09:30"], ["type": "title", "title": "Held edit"]] {
                await refused({ _ = try await core.call("calendarComposerEdit", argumentsJSON: self.json([self.json(["composer": created, "edit": edit, "calendar": feed])])) }, contains: "ACTION_FAILED")
            }
            for value in [created, existing] {
                await refused({ _ = try await core.call("calendarComposerSave", argumentsJSON: self.json([self.json([
                    "requestId": UUID().uuidString.lowercased(), "composer": value, "calendar": feed,
                ])])) }, contains: "ACTION_FAILED")
            }
        }
        XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts); XCTAssertEqual(io.counts, [0, 0, 0])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFrozenFeedOccupancyIsCheckedButBothPreparedJournalsTerminalsReceiptsAndLogsExcludeTransientData() async throws {
        try await seedTask()
        let io = CalendarFeedPresentationIO(), faults = HostIOFaults()
        var core = host(io, faults: faults); _ = try await core.start(); io.reset()
        for mode in ["new", "existing"] {
            let value = try await composer(core, mode: mode)
            let start = try XCTUnwrap(value["startAt"] as? String), duration = try XCTUnwrap(value["durationMinutes"] as? Double)
            var busy = event; busy["start"] = start
            let instant = try XCTUnwrap(ISO8601DateFormatter().date(from: start) ?? {
                let formatter = ISO8601DateFormatter(); formatter.formatOptions.insert(.withFractionalSeconds); return formatter.date(from: start)
            }())
            busy["end"] = ISO8601DateFormatter().string(from: instant.addingTimeInterval(duration * 60))
            let requestID = UUID().uuidString.lowercased()
            var request: [String: Any] = ["requestId": requestID, "composer": value,
                "calendar": ["status": "ready", "calendars": [source], "events": [busy]]]
            let before = try taskRows(), beforeReceipts = try receipts(), counts = io.counts
            let blocked = try object(await core.call("calendarComposerSave", argumentsJSON: json([json(request)])))
            XCTAssertEqual(blocked["changed"] as? Bool, false)
            let wrapper = try XCTUnwrap(blocked["composer"] as? [String: Any]), refusedComposer = try XCTUnwrap(wrapper["composer"] as? [String: Any])
            XCTAssertEqual((refusedComposer["error"] as? [String: Any])?["code"] as? String, "overlap")
            XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts); XCTAssertEqual(io.counts, counts)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
            var distant = event; distant["start"] = "2036-11-20T12:00:00.000Z"; distant["end"] = "2036-11-20T13:00:00.000Z"
            request["calendar"] = ["status": "ready", "calendars": [source], "events": [distant], "warning": "Failed to load events"]
            faults.beforeSQL = { sql in io.sql(sql); if sql == "COMMIT" { throw HostFailure("Hold prepared Calendar commit") } }
            await refused({ _ = try await core.call("calendarComposerSave", argumentsJSON: self.json([self.json(request)])) }, contains: "SAVE_FAILED")
            let pendingRaw = try String(contentsOf: journal, encoding: .utf8), pending = try object(pendingRaw)
            XCTAssertEqual(pending["method"] as? String, mode == "new" ? "calendarComposerCreateCommit" : "calendarComposerCommit")
            let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
            let envelope = try object(XCTUnwrap(arguments.first)), durableRequest = try XCTUnwrap(envelope["request"] as? [String: Any])
            XCTAssertEqual(Set(durableRequest.keys), Set(["requestId", "composer"]))
            XCTAssertEqual(try json(durableRequest), try json(["requestId": requestID, "composer": value]))
            XCTAssertFalse(pendingRaw.contains("PRIVATE_TRANSIENT")); XCTAssertNil(pending["terminal"])
            XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts)
            faults.beforeSQL = { io.sql($0) }; faults.journalRemove = { throw HostFailure("Hold Calendar terminal clear") }
            await refused { _ = try await core.retryPending() }
            let terminalRaw = try String(contentsOf: journal, encoding: .utf8)
            XCTAssertNotNil(try object(terminalRaw)["terminal"]); XCTAssertFalse(terminalRaw.contains("PRIVATE_TRANSIENT"))
            // Prepared Calendar families use the full stamped task row as their
            // receipt, rather than adding an ordinary native_request_receipts row.
            let receiptRows = try receipts(); XCTAssertEqual(receiptRows, beforeReceipts); XCTAssertFalse(receiptRows.contains("PRIVATE_TRANSIENT"))
            let stampedRows = try taskRows(); XCTAssertNotEqual(stampedRows, before); XCTAssertFalse(stampedRows.contains("PRIVATE_TRANSIENT"))
            let logs = (try? String(contentsOf: root.appendingPathComponent("logs/mindwtr.log"), encoding: .utf8)) ?? ""
            XCTAssertFalse(logs.contains("PRIVATE_TRANSIENT"))
            faults.journalRemove = nil
            await core.close()
            // Recreate the lost-terminal window with the exact original journal,
            // whose prepared request bytes have no transient feed. Cold commit
            // must recognize the complete saved row without applying it again.
            try Data(pendingRaw.utf8).write(to: journal)
            io.reset(); core = host(io, faults: faults)
            let reopened = try object(await core.start()), recovery = try XCTUnwrap(reopened["recovery"] as? [String: Any])
            XCTAssertEqual(recovery["method"] as? String, mode == "new" ? "calendarComposerCreateCommit" : "calendarComposerCommit")
            let recoveredResult = try XCTUnwrap(recovery["result"] as? [String: Any])
            XCTAssertEqual(recoveredResult["taskId"] as? String, mode == "new" ? requestID : taskID)
            XCTAssertEqual(try taskRows(), stampedRows); XCTAssertEqual(try receipts(), beforeReceipts)
            XCTAssertEqual(io.counts[0], 0, "Cold full-row receipt replay must not write tasks, projects, settings or ordinary receipts")
            XCTAssertEqual(io.counts[2], 0)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        }
        XCTAssertEqual(io.counts[2], 0)
    }

    func testCalendarFeedDiagnosticUsesOnlyClosedEnumsAndSavesNoPrivateContext() async throws {
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start()
        _ = try await core.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
        ])]))
        io.reset(); let before = try taskRows(), beforeReceipts = try receipts()
        let message = "Native iOS calendar feed view published"
        for outcome in ["ready", "partial", "error"] {
            let result = try await core.call("logLine", argumentsJSON: json([message, json([
                "releaseCheck": "v1.3.5/ios-calendar-feed", "outcome": outcome,
            ])]))
            XCTAssertEqual(result, "{}")
        }
        let shared = try object(await core.diagnosticsFileAction("logShare"))
        let url = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { try object(String($0)) }
        let contexts = lines.filter { $0["message"] as? String == message }.compactMap { $0["context"] as? [String: Any] }
        XCTAssertEqual(contexts.count, 3)
        XCTAssertEqual(Set(contexts.compactMap { $0["outcome"] as? String }), Set(["ready", "partial", "error"]))
        XCTAssertTrue(contexts.allSatisfy { Set($0.keys) == Set(["releaseCheck", "outcome"]) })
        let log = root.appendingPathComponent("logs/mindwtr.log"), saved = try Data(contentsOf: log)
        var invalid: [[String: Any]] = [
            ["releaseCheck": "v1.3.5/ios-calendar-feed", "outcome": "loading"],
            ["releaseCheck": "v1.3.5/ios-calendar-feed", "outcome": "PRIVATE_TRANSIENT_ERROR"],
            ["releaseCheck": "v1.3.5/ios-calendar-feed", "outcome": true],
            ["releaseCheck": "v1.3.5/ios-calendar-access", "outcome": "ready"],
        ]
        for field in ["count", "sourceId", "eventId", "url", "text", "message"] {
            invalid.append(["releaseCheck": "v1.3.5/ios-calendar-feed", "outcome": "ready", field: "PRIVATE_TRANSIENT_CONTEXT"])
        }
        for context in invalid { await refused { _ = try await core.call("logLine", argumentsJSON: self.json([message, self.json(context)])) } }
        await refused { _ = try await core.call("logLine", argumentsJSON: self.json([message,
            #"{"releaseCheck":"v1.3.5/ios-calendar-feed","outcome":"ready","outcome":"error"}"#])) }
        XCTAssertEqual(try Data(contentsOf: log), saved); XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts)
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
    func testCalendarEventEditorDiagnosticUsesOnlyTerminalEnumsAndSavesNoPrivateContext() async throws {
        let io = CalendarFeedPresentationIO(), core = host(io); _ = try await core.start()
        _ = try await core.call("dataSetting", argumentsJSON: json([json([
            "requestId": UUID().uuidString.lowercased(), "edit": ["type": "debugLogging", "value": true],
        ])]))
        io.reset(); let before = try taskRows(), beforeReceipts = try receipts()
        let message = "Native iOS calendar event dialog dismissed"
        for outcome in ["cancelled", "saved", "deleted"] {
            let result = try await core.call("logLine", argumentsJSON: json([message, json([
                "releaseCheck": "v1.3.5/ios-calendar-event-open", "outcome": outcome,
            ])]))
            XCTAssertEqual(result, "{}")
        }
        let shared = try object(await core.diagnosticsFileAction("logShare"))
        let url = try await core.validatedDiagnosticsShareURL(XCTUnwrap(shared["path"] as? String))
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { try object(String($0)) }
        let contexts = lines.filter { $0["message"] as? String == message }.compactMap { $0["context"] as? [String: Any] }
        XCTAssertEqual(contexts.count, 3)
        XCTAssertEqual(Set(contexts.compactMap { $0["outcome"] as? String }), Set(["cancelled", "saved", "deleted"]))
        XCTAssertTrue(contexts.allSatisfy { Set($0.keys) == Set(["releaseCheck", "outcome"]) })
        let log = root.appendingPathComponent("logs/mindwtr.log"), saved = try Data(contentsOf: log)
        var invalid: [[String: Any]] = [
            ["releaseCheck": "v1.3.5/ios-calendar-event-open", "outcome": "loading"],
            ["releaseCheck": "v1.3.5/ios-calendar-event-open", "outcome": "PRIVATE_TRANSIENT_ERROR"],
            ["releaseCheck": "v1.3.5/ios-calendar-event-open", "outcome": true],
            ["releaseCheck": "v1.3.5/ios-calendar-access", "outcome": "cancelled"],
        ]
        for field in ["count", "sourceId", "eventId", "url", "text", "message"] {
            invalid.append(["releaseCheck": "v1.3.5/ios-calendar-event-open", "outcome": "cancelled", field: "PRIVATE_TRANSIENT_CONTEXT"])
        }
        for context in invalid { await refused { _ = try await core.call("logLine", argumentsJSON: self.json([message, self.json(context)])) } }
        await refused { _ = try await core.call("logLine", argumentsJSON: self.json([message,
            #"{"releaseCheck":"v1.3.5/ios-calendar-event-open","outcome":"cancelled","outcome":"saved"}"#])) }
        XCTAssertEqual(try Data(contentsOf: log), saved); XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receipts(), beforeReceipts)
        XCTAssertEqual(io.counts, [0, 0, 0]); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }
}
