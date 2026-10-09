import Darwin
import Foundation
import Security
import XCTest
@testable import MindwtrNativeCore

private final class EventTaskNoCalendar: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { XCTFail("Event copy cannot read permission"); throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { XCTFail("Event copy cannot enumerate calendars"); throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { XCTFail("Event copy cannot fetch events"); throw NativeCalendarReadError.unavailable }
}
private final class EventTaskNoHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { XCTFail("Event copy cannot use HTTP"); client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}

/// Public native command over real production JSC, SQLite, device KV and journal.
/// Only the explicitly named forged-reply test appends a fault shim to the bundle.
final class NativeCalendarEventTaskHostTests: XCTestCase {
    private var root: URL!, bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var journal: URL { database.appendingPathExtension("pending.json") }
    private let namespace = "tech.example.mindwtr.calendar-event-task"
    private var manifest: URL { root.appendingPathComponent("container/Library/Application Support/\(namespace)/RCTAsyncLocalStorage_V1/manifest.json") }
    private var state: [String: Any] { ["viewMode": "week", "selectedDate": "2036-10-03", "visibleMonth": "2036-10-01"] }

    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"], FileManager.default.isReadableFile(atPath: path) else {
            throw XCTSkip("Build the actual production iOS core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        bundle = URL(fileURLWithPath: path)
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/calendar-event-task/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw HostFailure("Event task fixture is unavailable") }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(json(["@mindwtr_sync_backend": "off"]).utf8).write(to: manifest)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func host(_ faults: HostIOFaults = HostIOFaults(), using alternate: URL? = nil) -> CoreHost {
        faults.calendarReaderFactory = { XCTFail("Event copy cannot create a provider reader"); return EventTaskNoCalendar() }
        faults.calendarAuthorizationRequest = { XCTFail("Event copy cannot request authorization"); throw NativeCalendarReadError.unavailable }
        faults.secretService = "mindwtr.native-keychain.fixture." + UUID().uuidString.lowercased()
        faults.secretStatus = { _, _ in errSecNotAvailable }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [EventTaskNoHTTP.self]; faults.httpConfiguration = configuration
        let core = CoreHost(databaseURL: database, bundleURL: alternate ?? bundle, faults: faults,
            deviceStorage: (containerURL: root.appendingPathComponent("container"), bundleIdentifier: namespace))
        addTeardownBlock { await core.close() }; return core
    }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func request(id: String = UUID().uuidString.lowercased(), allDay: Bool = false) -> [String: Any] {
        ["requestId": id, "event": ["title": "Literal +Project /due:tomorrow", "start": allDay ? "2036-10-03" : "2036-10-03T10:00:00.000Z",
            "end": allDay ? "2036-10-04" : "2036-10-03T11:15:00.000Z", "allDay": allDay, "description": " Event notes ", "location": " Library "],
         "calendarName": " Work ", "fallbackTitle": "Calendar event", "state": state]
    }
    private func create(_ core: CoreHost, _ input: [String: Any]) async throws -> [String: Any] {
        try object(await core.call("calendarEventTaskCreate", argumentsJSON: json([json(input)])))
    }
    private func rows(_ sql: String, _ params: [Any] = []) throws -> [[String: Any]] {
        let sqlite = try SQLiteBridge(url: database); defer { sqlite.close() }
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(sqlite.execute(sql, parametersJSON: json(params)).utf8)) as? [[String: Any]])
    }
    private func task(_ id: String) throws -> [String: Any] { try XCTUnwrap(rows("SELECT * FROM tasks WHERE id = ?", [id]).first) }
    private func receiptRows() throws -> String { try json(rows("SELECT request_id, method, reply, saved_at FROM native_request_receipts ORDER BY request_id")) }
    private func taskRows() throws -> String { try json(rows("SELECT * FROM tasks ORDER BY id")) }
    private func taskWrite(_ sql: String) -> Bool { sql.range(of: #"(?i)^\s*(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+tasks\b"#, options: .regularExpression) != nil }
    private func refused(_ contains: String? = nil, file: StaticString = #filePath, line: UInt = #line, _ work: () async throws -> Void) async {
        do { try await work(); XCTFail("Expected event task refusal", file: file, line: line) }
        catch { if let contains { XCTAssertTrue(error.localizedDescription.contains(contains), error.localizedDescription, file: file, line: line) } }
    }
    private func command(_ bytes: Data) throws -> [String: Any] {
        let pending = try object(String(decoding: bytes, as: UTF8.self))
        let arguments = try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(pending["argumentsJSON"] as? String).utf8)) as? [String])
        return try object(XCTUnwrap(arguments.first))
    }
    private func assertRetained(_ bytes: Data) throws {
        let old = try object(String(decoding: bytes, as: UTF8.self)), current = try object(String(contentsOf: journal))
        XCTAssertEqual(try json(old), try json(current))
        XCTAssertEqual(Data(try XCTUnwrap(old["argumentsJSON"] as? String).utf8), Data(try XCTUnwrap(current["argumentsJSON"] as? String).utf8))
    }

    func testTimedAndAllDayCopiesUseSharedFactoryLiteralTitleAndDateSemantics() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let beforeReceipts = try receiptRows(), beforeKV = try Data(contentsOf: manifest)
        var writes = 0
        faults.beforeSQL = { sql in if self.taskWrite(sql) { writes += 1; XCTAssertTrue(FileManager.default.fileExists(atPath: self.journal.path)) } }
        for allDay in [false, true] {
            let input = request(allDay: allDay), id = try XCTUnwrap(input["requestId"] as? String)
            let result = try await create(core, input), row = try task(id)
            XCTAssertEqual(row["title"] as? String, "Literal +Project /due:tomorrow")
            XCTAssertEqual(row["location"] as? String, "Library"); XCTAssertEqual(row["description"] as? String, "Event notes\n\nCalendar: Work")
            XCTAssertEqual(row["status"] as? String, "next"); XCTAssertEqual(row["rev"] as? Int, 1)
            XCTAssertTrue(row["projectId"] is NSNull); XCTAssertTrue(row["attachments"] is NSNull)
            XCTAssertEqual((result["next"] as? [String: Any])?["viewMode"] as? String, "week")
            XCTAssertEqual((result["next"] as? [String: Any])?["selectedDate"] as? String, "2036-10-03")
            XCTAssertTrue(result["toast"] is NSNull); XCTAssertTrue(result["composer"] is NSNull); XCTAssertTrue(result["scrollToMinutes"] is NSNull)
            if allDay { XCTAssertEqual(row["dueDate"] as? String, "2036-10-03"); XCTAssertTrue(row["startTime"] is NSNull); XCTAssertTrue(row["timeEstimate"] is NSNull) }
            else { XCTAssertEqual(row["startTime"] as? String, "2036-10-03T10:00:00.000Z"); XCTAssertEqual(row["timeEstimate"] as? String, "custom:75"); XCTAssertTrue(row["dueDate"] is NSNull) }
            await refused("Request ID") { _ = try await self.create(core, input) }
        }
        XCTAssertEqual(writes, 2); XCTAssertEqual(try receiptRows(), beforeReceipts); XCTAssertEqual(try Data(contentsOf: manifest), beforeKV)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        for name in ["calendarEventTaskPrepare", "calendarEventTaskValidate", "calendarEventTaskCommit", "calendarEventTaskAcknowledged", "runCalendarAction"] {
            await refused("unavailable") { _ = try await core.call(name, argumentsJSON: self.json(["{}"])) }
        }
    }

    func testFractionalAndMultiDayDurationsAndFullDescriptionSurviveSQLiteRestart() async throws {
        let core = host(); _ = try await core.start()
        for (end, estimate) in [("2036-10-03T10:01:31.000Z", "custom:2"), ("2036-10-05T10:00:00.000Z", "custom:2880")] {
            var input = request(), event = try XCTUnwrap(input["event"] as? [String: Any]); event["end"] = end; input["event"] = event
            _ = try await create(core, input); XCTAssertEqual(try task(XCTUnwrap(input["requestId"] as? String))["timeEstimate"] as? String, estimate)
        }
        var input = request(), event = try XCTUnwrap(input["event"] as? [String: Any])
        let notes = String(repeating: "界", count: 20_000), calendarName = String(repeating: "名", count: 2_000)
        event["description"] = notes; input["event"] = event; input["calendarName"] = calendarName
        _ = try await create(core, input)
        let id = try XCTUnwrap(input["requestId"] as? String), full = try task(id), expected = notes + "\n\nCalendar: " + calendarName
        XCTAssertEqual(expected.utf16.count, 22_012); XCTAssertEqual(full["description"] as? String, expected)
        await core.close(); let reopened = host(); _ = try await reopened.start()
        XCTAssertEqual(try json(task(id)), try json(full)); XCTAssertEqual(try task(id)["description"] as? String, expected)
    }

    func testClosedEventSheetPrivacyUnicodeIdentityAndNativeAdmissionBounds() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let before = try taskRows(), receipts = try receiptRows(), kv = try Data(contentsOf: manifest)
        var sql = 0, journals = 0; faults.beforeSQL = { _ in sql += 1 }; faults.journalWrite = { journals += 1 }
        let input = request(); var event = try XCTUnwrap(input["event"] as? [String: Any]); event["id"] = "PRIVATE_EVENT"; event["sourceId"] = "e\u{301}"
        let reader: [String: Any] = ["event": event, "canOpen": false, "state": state, "calendarName": "Work"]
        let sheet = try object(await core.call("menuRead", argumentsJSON: json(["calendarItem", json(reader)])))
        let template = try XCTUnwrap(sheet["creationTemplate"] as? [String: Any])
        XCTAssertFalse(try json(template).contains("PRIVATE_EVENT")); XCTAssertFalse(try json(template).contains("sourceId"))
        let copied = try XCTUnwrap(template["event"] as? [String: Any]); XCTAssertEqual(Data(try XCTUnwrap(copied["title"] as? String).utf8), Data("Literal +Project /due:tomorrow".utf8))
        var invalid = reader; invalid["canOpen"] = true
        await refused { _ = try await core.call("menuRead", argumentsJSON: self.json(["calendarItem", self.json(invalid)])) }
        invalid = reader; invalid["taskId"] = "mixed"
        await refused { _ = try await core.call("menuRead", argumentsJSON: self.json(["calendarItem", self.json(invalid)])) }
        var badEvent = event; badEvent["nativeEventId"] = "PRIVATE_PROVIDER"; invalid = reader; invalid["event"] = badEvent
        await refused { _ = try await core.call("menuRead", argumentsJSON: self.json(["calendarItem", self.json(invalid)])) }
        let identities = ["\u{e9}", "e\u{301}"]
        let events: [[String: Any]] = identities.map { identity in var value = event; value["sourceId"] = identity; return value }
        let sources: [[String: Any]] = identities.map { ["id": $0, "name": "Unicode source", "url": "https://PRIVATE.invalid/calendar.ics", "enabled": true] }
        let view = try object(await core.call("menuRead", argumentsJSON: json(["calendar", json([
            "state": ["viewMode": "day", "selectedDate": "2036-10-03", "visibleMonth": "2036-10-03"], "offset": 0, "limit": 100,
            "calendar": ["status": "ready", "calendars": sources, "events": events],
        ])])))
        let entries = try XCTUnwrap(view["items"] as? [[String: Any]])
        let references = entries.compactMap { ($0["item"] as? [String: Any])?["eventRef"] as? [String: Any] }
        XCTAssertEqual(references.count, 2)
        let rawIDs = references.compactMap { ($0["sourceId"] as? String).map { Data($0.utf8) } }
        XCTAssertEqual(Set(rawIDs), Set(identities.map { Data($0.utf8) }))
        var invalidWrite = input; var raw = try XCTUnwrap(input["event"] as? [String: Any]); raw["sourceId"] = "PRIVATE_SOURCE"; invalidWrite["event"] = raw
        await refused("INVALID_INPUT") { _ = try await self.create(core, invalidWrite) }
        raw = try XCTUnwrap(input["event"] as? [String: Any]); raw["description"] = String(repeating: "x", count: 20_001); invalidWrite["event"] = raw
        await refused("INVALID_INPUT") { _ = try await self.create(core, invalidWrite) }
        let duplicate = String(try json(input).dropLast()) + ",\"requestId\":\"" + (input["requestId"] as! String) + "\"}"
        await refused("INVALID_INPUT") { _ = try await core.call("calendarEventTaskCreate", argumentsJSON: self.json([duplicate])) }
        XCTAssertEqual(sql, 0); XCTAssertEqual(journals, 0); XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receiptRows(), receipts); XCTAssertEqual(try Data(contentsOf: manifest), kv)
        faults.beforeSQL = nil; faults.journalWrite = nil
        let encoded = try json(input), exact = encoded + String(repeating: " ", count: 2_000_000 - encoded.utf8.count)
        XCTAssertEqual(exact.utf8.count, 2_000_000)
        await refused("INVALID_INPUT") { _ = try await core.call("calendarEventTaskCreate", argumentsJSON: self.json([exact + " "])) }
        _ = try await core.call("calendarEventTaskCreate", argumentsJSON: json([exact]))
        XCTAssertEqual(try task(input["requestId"] as! String)["rev"] as? Int, 1)
    }

    func testBeforeJournalAndAtomicTaskCommitFailuresRetainExactCommandForWarmRetry() async throws {
        let faults = HostIOFaults(), core = host(faults); _ = try await core.start()
        let input = request(), before = try taskRows(), receipts = try receiptRows()
        var acknowledgments = 0
        faults.commandDiagnostic = { method in
            guard method == "calendarEventTaskCreate" else { return }
            acknowledgments += 1
            XCTAssertFalse(FileManager.default.fileExists(atPath: self.journal.path))
            do { XCTAssertEqual(try self.task(input["requestId"] as! String)["rev"] as? Int, 1) }
            catch { XCTFail("Acknowledgment preceded durable task: \(error)") }
        }
        var sql = 0; faults.beforeSQL = { _ in sql += 1 }; faults.journalWrite = { throw HostFailure("Injected before journal") }
        await refused("before journal") { _ = try await self.create(core, input) }
        XCTAssertEqual(acknowledgments, 0)
        XCTAssertEqual(sql, 0); XCTAssertEqual(try taskRows(), before); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        faults.journalWrite = nil; faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected task COMMIT") } }
        // A failed journal write retains the prepared command in memory.
        await refused("SAVE_FAILED") { _ = try await core.retryPending() }
        XCTAssertEqual(acknowledgments, 0)
        XCTAssertEqual(try taskRows(), before); XCTAssertEqual(try receiptRows(), receipts)
        let retained = try Data(contentsOf: journal), envelope = try command(retained)
        XCTAssertEqual(try json(XCTUnwrap(envelope["request"])), try json(input))
        XCTAssertFalse(String(decoding: retained, as: UTF8.self).contains("sourceId"))
        faults.beforeSQL = nil
        let retry = try await core.retryPending(); XCTAssertEqual(try object(XCTUnwrap(retry))["taskId"] as? String, input["requestId"] as? String)
        XCTAssertEqual(acknowledgments, 1)
        XCTAssertEqual(try task(input["requestId"] as! String)["rev"] as? Int, 1); XCTAssertEqual(try receiptRows(), receipts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testLostCommitReplyTerminalWriteAndJournalClearCutsReplayExactRowWithoutSecondTaskWrite() async throws {
        for cut in ["commitReply", "terminalWrite", "journalClear"] {
            let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
            let input = request(), id = input["requestId"] as! String, receipts = try receiptRows(), kv = try Data(contentsOf: manifest)
            var acknowledgments = 0
            faults.commandDiagnostic = { if $0 == "calendarEventTaskCreate" { acknowledgments += 1 } }
            var lostCommitReplies = 0
            if cut == "commitReply" {
                // Exhaust the store's automatic save retries to leave a cold-recovery window.
                faults.afterSQL = { if $0 == "COMMIT" { lostCommitReplies += 1; throw HostFailure("Injected lost COMMIT reply") } }
            }
            else if cut == "terminalWrite" { var count = 0; faults.journalWrite = { count += 1; if count == 2 { throw HostFailure("Injected terminal write") } } }
            else { faults.journalRemove = { throw HostFailure("Injected journal clear") } }
            await refused { _ = try await self.create(writer, input) }
            XCTAssertEqual(acknowledgments, 0, cut)
            if cut == "commitReply" { XCTAssertGreaterThan(lostCommitReplies, 1) }
            let written = try task(id), bytes = try Data(contentsOf: journal), envelope = try command(bytes)
            XCTAssertEqual(try json(XCTUnwrap(envelope["request"])), try json(input))
            XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("sourceId"))
            await writer.close()
            let replayFaults = HostIOFaults(); var writes = 0
            replayFaults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
            replayFaults.commandDiagnostic = { method in
                guard method == "calendarEventTaskCreate" else { return }
                acknowledgments += 1
                XCTAssertFalse(FileManager.default.fileExists(atPath: self.journal.path), cut)
                do { XCTAssertEqual(try self.json(self.task(id)), try self.json(written), cut) }
                catch { XCTFail("Acknowledgment preceded durable task: \(error)") }
            }
            let cold = host(replayFaults), startup = try object(await cold.start())
            XCTAssertEqual(acknowledgments, 1, cut)
            let recovery = try XCTUnwrap(startup["recovery"] as? [String: Any]), result = try XCTUnwrap(recovery["result"] as? [String: Any])
            XCTAssertEqual(recovery["method"] as? String, "calendarEventTaskCommit", cut); XCTAssertEqual(result["taskId"] as? String, id, cut)
            XCTAssertEqual((result["next"] as? [String: Any])?["viewMode"] as? String, "week", cut)
            XCTAssertEqual(writes, 0, cut); XCTAssertEqual(try json(task(id)), try json(written), cut)
            XCTAssertEqual(try receiptRows(), receipts, cut); XCTAssertEqual(try Data(contentsOf: manifest), kv, cut)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path), cut); await cold.close()
        }
    }

    func testEditedDeletedAndPurgedRowsCannotBeClobberedByAnOlderRetainedCommand() async throws {
        for change in ["edit", "delete", "purge"] {
            let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
            let input = request(), id = input["requestId"] as! String
            var count = 0; faults.journalWrite = { count += 1; if count == 2 { throw HostFailure("Injected lost terminal") } }
            await refused { _ = try await self.create(writer, input) }
            let originalJournal = try Data(contentsOf: journal); await writer.close()
            let sqlite = try SQLiteBridge(url: database), at = "2036-10-04T00:00:00.000Z"
            _ = try sqlite.execute("UPDATE tasks SET title = ?, deletedAt = ?, purgedAt = ?, rev = rev + 1, updatedAt = ? WHERE id = ?",
                parametersJSON: json([change == "purge" ? "" : "Later " + change, change == "edit" ? NSNull() : at as Any,
                    change == "purge" ? at as Any : NSNull(), at, id])); sqlite.close()
            let changed = try task(id), receipts = try receiptRows(), replayFaults = HostIOFaults(); var writes = 0
            replayFaults.beforeSQL = { if self.taskWrite($0) { writes += 1 } }
            let cold = host(replayFaults)
            await refused { _ = try await cold.start() }
            XCTAssertEqual(writes, 0, change); XCTAssertEqual(try json(task(id)), try json(changed), change); XCTAssertEqual(try receiptRows(), receipts, change)
            try assertRetained(originalJournal)
            await cold.close()
            // This test owns the stale journal; retire it before the next isolated case.
            try? FileManager.default.removeItem(at: journal)
        }
    }

    func testForgedPreparationRepliesAreRefusedBeforeJournalAndSQLite() async throws {
        for field in ["task", "props", "projection", "result", "unknown"] {
            let mutation: String = field == "task" ? "p.task.title='FORGED';" : field == "props" ? "p.intent.props.status='inbox';"
                : field == "projection" ? "p.projection.localDay='2036-10-04';" : field == "result" ? "p.result.taskId='FORGED';" : "p.providerURL='https://private.invalid';"
            let alternate = root.appendingPathComponent("forged-" + field + ".js")
            let shim = "\n(function(){var original=MindwtrHost.poll;MindwtrHost.poll=function(ticket){var raw=original(ticket);if(raw===null)return raw;var reply=JSON.parse(raw);if(reply.ok&&reply.value&&reply.value.kind==='prepared'&&reply.value.prepared.kind==='event'){var p=reply.value.prepared;" + mutation + "return JSON.stringify(reply);}return raw;};})();"
            try (String(contentsOf: bundle) + shim).write(to: alternate, atomically: true, encoding: .utf8)
            let faults = HostIOFaults(), core = host(faults, using: alternate); _ = try await core.start()
            let before = try taskRows(); var sql = 0, journals = 0
            faults.beforeSQL = { _ in sql += 1 }; faults.journalWrite = { journals += 1 }
            await refused { _ = try await self.create(core, self.request()) }
            XCTAssertEqual(sql, 0, field); XCTAssertEqual(journals, 0, field); XCTAssertEqual(try taskRows(), before, field)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path)); await core.close()
        }
    }

    func testCorruptOuterAndTerminalDuplicateMembersRefuseColdRecoveryBeforeSQLOrCleanup() async throws {
        let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        let input = request(); faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending fixture") } }
        await refused("SAVE_FAILED") { _ = try await self.create(writer, input) }
        let original = try Data(contentsOf: journal), pending = try object(String(decoding: original, as: UTF8.self)), envelope = try command(original)
        let prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any]), result = try XCTUnwrap(prepared["result"] as? [String: Any])
        await writer.close()
        let beforeDB = try Data(contentsOf: database)
        let rawPending = try json(pending), quotedArguments = String(try json([pending["argumentsJSON"]!]).dropFirst().dropLast())
        var variants = [String(rawPending.dropLast()) + ",\"method\":\"calendarEventTaskCommit\"}",
            String(rawPending.dropLast()) + ",\"argumentsJSON\":" + quotedArguments + "}"]
        for field in ["taskId", "next"] {
            let member = String(try json([field: result[field]!]).dropFirst().dropLast())
            let rawResult = String(try json(result).dropLast()) + "," + member + "}"
            var terminal = pending; terminal["terminal"] = ["success": ["_0": rawResult]]; variants.append(try json(terminal))
        }
        var nested = result, next = try XCTUnwrap(result["next"] as? [String: Any]); next["selectedDate"] = "2036-10-03"; nested["next"] = next
        let nextJSON = try json(next), rawNext = String(nextJSON.dropLast()) + ",\"selectedDate\":\"2036-10-03\"}"
        let rawNested = try json(nested).replacingOccurrences(of: nextJSON, with: rawNext)
        var nestedTerminal = pending; nestedTerminal["terminal"] = ["success": ["_0": rawNested]]; variants.append(try json(nestedTerminal))
        for raw in variants {
            let bytes = Data(raw.utf8); try bytes.write(to: journal)
            let coldFaults = HostIOFaults(); var sql = 0, cleanup = 0
            coldFaults.beforeSQL = { _ in sql += 1 }; coldFaults.journalRemove = { cleanup += 1 }
            let cold = host(coldFaults); await refused { _ = try await cold.start() }
            XCTAssertEqual(sql, 0); XCTAssertEqual(cleanup, 0); XCTAssertEqual(try Data(contentsOf: database), beforeDB)
            XCTAssertEqual(try Data(contentsOf: journal), bytes); await cold.close()
        }
        try original.write(to: journal)
        let recovered = host(); _ = try await recovered.start(); XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testForgedPreparedAndTerminalEffectsRetainColdJournalBeforeSQL() async throws {
        let faults = HostIOFaults(), writer = host(faults); _ = try await writer.start()
        faults.beforeSQL = { if $0 == "COMMIT" { throw HostFailure("Injected pending fixture") } }
        await refused("SAVE_FAILED") { _ = try await self.create(writer, self.request()) }
        let original = try Data(contentsOf: journal), base = try object(String(decoding: original, as: UTF8.self)), originalEnvelope = try command(original)
        await writer.close(); let beforeDB = try Data(contentsOf: database)
        for field in ["task", "props", "projection", "terminal", "unknown"] {
            var pending = base, envelope = originalEnvelope, prepared = try XCTUnwrap(envelope["prepared"] as? [String: Any])
            if field == "task" { var row = try XCTUnwrap(prepared["task"] as? [String: Any]); row["title"] = "Forged"; prepared["task"] = row }
            else if field == "props" { var intent = try XCTUnwrap(prepared["intent"] as? [String: Any]), props = try XCTUnwrap(intent["props"] as? [String: Any]); props["dueDate"] = "not-a-date"; intent["props"] = props; prepared["intent"] = intent }
            else if field == "projection" { var projection = try XCTUnwrap(prepared["projection"] as? [String: Any]); projection["localDay"] = "2036-10-04"; prepared["projection"] = projection }
            else if field == "unknown" { prepared["providerId"] = "Private" }
            else { var result = try XCTUnwrap(prepared["result"] as? [String: Any]); result["taskId"] = "Wrong"; pending["terminal"] = ["success": ["_0": try json(result)]] }
            envelope["prepared"] = prepared; pending["argumentsJSON"] = try json([json(envelope)])
            let bytes = Data(try json(pending).utf8); try bytes.write(to: journal)
            let coldFaults = HostIOFaults(); var sql = 0, cleanup = 0
            coldFaults.beforeSQL = { _ in sql += 1 }; coldFaults.journalRemove = { cleanup += 1 }
            let cold = host(coldFaults); await refused { _ = try await cold.start() }
            XCTAssertEqual(sql, 0, field); XCTAssertEqual(cleanup, 0, field); XCTAssertEqual(try Data(contentsOf: database), beforeDB, field)
            XCTAssertEqual(try Data(contentsOf: journal), bytes, field); await cold.close()
        }
    }
}
