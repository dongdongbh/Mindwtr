import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarPushWitnessTests: XCTestCase {
    private let id = UUID(uuid: (0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0x4c, 0xcc,
                                0x8d, 0xdd, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee))
    private let temporaryID = "12345678-1234-4234-8234-123456789abc"
    private let sharedNotes = "cafe\u{301} 🧠\n\n[Mindwtr task]\nMindwtr-Task-ID: task\n[/Mindwtr task]"
    private var marker: String { "\n\n[Mindwtr native calendar operation: \(id.uuidString.lowercased())]" }
    private func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
    private func request(notes: String? = nil, url: String? = nil, calendar: String = "calendar-e\u{301}",
                         start: Int64 = 1_800_000_000_123, end: Int64 = 1_800_003_600_456) throws -> String {
        var details: [String: Any] = ["title": "title-e\u{301}", "startMs": start, "endMs": end,
                                      "allDay": false, "notes": notes ?? sharedNotes, "location": "place-e\u{301}",
                                      "timeZone": "America/New_York", "endTimeZone": "Europe/London"]
        if let url { details["url"] = url }
        return try json(["op": "createEvent", "calendarId": calendar, "details": details])
    }
    private func eventEffect(raw: String? = nil, url: String? = nil) throws -> NativeCalendarPushEffect {
        let marked = try NativeCalendarPushWitness.markCreateEvent(requestJSON: raw ?? request(url: url), id: id)
        return try NativeCalendarPushEffect(id: id, libraryID: "library", requestJSON: marked, taskID: "task").markingStarted()
    }
    private func eventRow(_ effect: NativeCalendarPushEffect) throws -> [String: Any] {
        guard case .createEvent(let calendar, let details) = effect.request else { throw NativeCalendarWriteError.invalid }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var row: [String: Any] = ["id": "event-e\u{301}", "calendarId": calendar, "title": details.title,
                                 "notes": details.notes, "location": details.location, "allDay": details.allDay,
                                 "isRecurring": false, "startDate": formatter.string(from: details.start),
                                 "endDate": formatter.string(from: details.end)]
        if let url = details.url { row["url"] = url }
        if let zone = details.timeZone { row["timeZone"] = zone }
        return row
    }
    private func calendarEffect(title: String? = nil, source: String = "source-e\u{301}",
                                color: String = "#aabbcc") throws -> NativeCalendarPushEffect {
        let raw = try json(["op": "createCalendar", "details": ["title": title ?? "Mindwtr (\(temporaryID))",
                            "color": color, "entityType": "event", "sourceId": source]])
        return try NativeCalendarPushEffect(id: id, libraryID: "library", requestJSON: raw,
                                            beforeCalendarState: Array(repeating: nil, count: 5)).markingStarted()
    }
    private func calendarRow(_ effect: NativeCalendarPushEffect) throws -> [String: Any] {
        guard case .createCalendar(let details) = effect.request else { throw NativeCalendarWriteError.invalid }
        return ["id": "calendar-e\u{301}", "title": details.title, "source": ["id": details.sourceID],
                "color": details.color.uppercased(), "allowsModifications": true]
    }
    private func fixed<T>(_ error: NativeCalendarWriteError, file: StaticString = #filePath, line: UInt = #line,
                          _ work: () throws -> T) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertEqual($0 as? NativeCalendarWriteError, error, file: file, line: line)
        }
    }

    func testMarkerPreservesSharedNotesUnicodeAndEveryOtherRequestValue() throws {
        let raw = try request(url: "https://example.test/cafe%CC%81?q=Exact")
        let marked = try NativeCalendarPushWitness.markCreateEvent(requestJSON: raw, id: id)
        var expected = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        var details = try XCTUnwrap(expected["details"] as? [String: Any])
        details["notes"] = sharedNotes + marker; expected["details"] = details
        XCTAssertEqual(Data(marked.utf8), Data(try json(expected).utf8))
        guard case .createEvent(_, let actual) = try NativeCalendarWriteRequest(json: marked) else { return XCTFail("Expected create") }
        XCTAssertEqual(Data(actual.notes.utf8), Data((sharedNotes + marker).utf8))
        fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: marked, id: id) }
        let other = "\n\n[Mindwtr native calendar operation: 12345678-1234-4234-8234-123456789abc]"
        let withOther = try NativeCalendarPushWitness.markCreateEvent(requestJSON: request(notes: sharedNotes + other), id: id)
        guard case .createEvent(_, let preserved) = try NativeCalendarWriteRequest(json: withOther) else { return XCTFail("Expected create") }
        XCTAssertEqual(Data(preserved.notes.utf8), Data((sharedNotes + other + marker).utf8))
        fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: request(notes: marker + "trailing text"), id: id) }
    }

    func testMarkerRefusesNonCreateMalformedAndFullEscapedRequestOverflow() throws {
        for raw in ["malformed", "{\"op\":\"sources\"}", "{\"op\":\"deleteCalendar\",\"calendarId\":\"calendar\"}",
                    "{\"op\":\"deleteEvent\",\"calendarId\":\"calendar\",\"eventId\":\"event\"}"] {
            fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: raw, id: id) }
        }
        var update = try XCTUnwrap(NativeJSON.jsonObject(with: Data(request().utf8)) as? [String: Any])
        update["op"] = "updateEvent"; update["eventId"] = "event"
        fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: json(update), id: id) }
        fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: calendarEffect().requestJSON, id: id) }
        let base = try request(notes: "")
        let raw = try request(notes: String(repeating: "\"", count: (NativeCalendarJobs.maximumRequestBytes - base.utf8.count - 10) / 2))
        XCTAssertLessThanOrEqual(raw.utf8.count, NativeCalendarJobs.maximumRequestBytes)
        _ = try NativeCalendarWriteRequest(json: raw)
        fixed(.invalid) { try NativeCalendarPushWitness.markCreateEvent(requestJSON: raw, id: id) }
    }

    func testExactUniqueEventReturnsOriginalIDWithURLAndMillisecondInstants() throws {
        let effect = try eventEffect(url: "https://example.test/Exact?q=cafe%CC%81"), row = try eventRow(effect)
        XCTAssertEqual(Data(try NativeCalendarPushWitness.createdEvent(effect: effect, events: [row]).utf8), Data("event-e\u{301}".utf8))
        var offset = row
        offset["startDate"] = "2027-01-15T03:00:00.123-05:00"
        offset["endDate"] = "2027-01-15T04:00:00.456-05:00"
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: effect, events: [offset]), "event-e\u{301}")
        let plainEffect = try eventEffect(raw: request(start: 1_800_000_000_000, end: 1_800_003_600_000))
        var plain = try eventRow(plainEffect)
        plain["startDate"] = "2027-01-15T08:00:00Z"; plain["endDate"] = "2027-01-15T09:00:00Z"
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: plainEffect, events: [plain]), "event-e\u{301}")
    }

    func testNoWitnessWrongCalendarOrSharedTaskMarkerNeverProvesAbsence() throws {
        let effect = try eventEffect(), row = try eventRow(effect)
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: []) }
        var wrong = row; wrong["calendarId"] = "calendar-\u{e9}"
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [wrong]) }
        wrong = row; wrong["notes"] = sharedNotes
        wrong["externalIdentifier"] = id.uuidString.lowercased()
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [wrong]) }
        wrong = row; wrong["notes"] = sharedNotes + "\n\n[Mindwtr native calendar operation: \(id.uuidString)]"
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [wrong]) }
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: effect, events: [wrong, row]), "event-e\u{301}")
    }

    func testDuplicateWitnessRefusesBeforeCheckingChangedOrMalformedCandidate() throws {
        let effect = try eventEffect(), row = try eventRow(effect)
        var changed = row; changed["title"] = "edited"; changed["id"] = "other"
        fixed(.ambiguous) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [row, changed]) }
        changed.removeValue(forKey: "isRecurring")
        fixed(.ambiguous) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [row, changed]) }
        var foreign = changed; foreign["calendarId"] = "other"
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: effect, events: [row, foreign]), "event-e\u{301}")
    }

    func testChangedEventFieldsUnicodeDatesURLAndRecurrenceRefuse() throws {
        let effect = try eventEffect(url: "https://example.test/Exact"), row = try eventRow(effect)
        let changes: [(String, Any)] = [
            ("title", "title-\u{e9}"), ("notes", sharedNotes.replacingOccurrences(of: "e\u{301}", with: "\u{e9}") + marker),
            ("location", "place-\u{e9}"), ("url", "https://example.test/exact"),
            ("allDay", true), ("isRecurring", true),
            ("startDate", "2027-01-15T08:00:00.124Z"), ("endDate", "2027-01-15T09:00:00.457Z"),
            ("notes", sharedNotes + marker + "edited")
        ]
        for (name, value) in changes {
            var changed = row; changed[name] = value
            fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [changed]) }
        }
        var absent = row; absent.removeValue(forKey: "url")
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [absent]) }
        absent["url"] = NSNull()
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [absent]) }
        let withoutURL = try eventEffect(); var noURLRow = try eventRow(withoutURL)
        noURLRow["url"] = NSNull()
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: withoutURL, events: [noURLRow]), "event-e\u{301}")
        noURLRow["url"] = ""
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: withoutURL, events: [noURLRow]) }
        let unicodeURL = try eventEffect(url: "https://example.test/cafe\u{301}")
        var unicodeRow = try eventRow(unicodeURL); unicodeRow["url"] = "https://example.test/caf\u{e9}"
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: unicodeURL, events: [unicodeRow]) }
    }

    func testMalformedEventCandidateFieldsAndNumericFlagsAreInvalid() throws {
        let effect = try eventEffect(), row = try eventRow(effect)
        for name in ["id", "title", "startDate", "endDate", "allDay", "isRecurring"] {
            var malformed = row; malformed.removeValue(forKey: name)
            fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [malformed]) }
        }
        var missingLocation = row; missingLocation.removeValue(forKey: "location")
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [missingLocation]) }
        let changes: [(String, Any)] = [("id", ""), ("id", String(repeating: "a", count: 1025)),
            ("title", 3), ("startDate", "invalid date"), ("allDay", NSNumber(value: 0)),
            ("isRecurring", NSNumber(value: 0)), ("url", 123)]
        for (name, value) in changes {
            var malformed = row; malformed[name] = value
            fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [malformed]) }
        }
        var detached = row; detached["isRecurring"] = true; detached["isDetached"] = true
        fixed(.unavailable) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: [detached]) }
    }

    func testEventRecoveryRequiresStartedCreateMarkedFrozenNotesAndBoundedRows() throws {
        let effect = try eventEffect(), row = try eventRow(effect)
        let prepared = try NativeCalendarPushEffect(id: id, libraryID: "library", requestJSON: effect.requestJSON, taskID: "task")
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: prepared, events: [row]) }
        let saved = try effect.recording(result: .identifier("event"))
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: saved, events: [row]) }
        let unmarked = try NativeCalendarPushEffect(id: id, libraryID: "library", requestJSON: request(), taskID: "task").markingStarted()
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: unmarked, events: [row]) }
        let wrongID = try NativeCalendarPushEffect(id: UUID(), libraryID: "library", requestJSON: effect.requestJSON, taskID: "task").markingStarted()
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: wrongID, events: [row]) }
        let wrong = try calendarEffect()
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: wrong, events: [row]) }
        fixed(.invalid) { try NativeCalendarPushWitness.createdEvent(effect: effect, events: Array(repeating: row, count: 10_001)) }
        let unrelated: [String: Any] = ["calendarId": "other", "notes": "other"]
        XCTAssertEqual(try NativeCalendarPushWitness.createdEvent(effect: effect, events: [row] + Array(repeating: unrelated, count: 9_999)), "event-e\u{301}")
    }

    func testUniqueTemporaryCalendarMatchesExactSourceTitleAndHexColor() throws {
        let effect = try calendarEffect(), row = try calendarRow(effect)
        XCTAssertEqual(Data(try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [row]).utf8), Data("calendar-e\u{301}".utf8))
        var lower = row; lower["color"] = "#aabbcc"
        XCTAssertEqual(try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [lower]), "calendar-e\u{301}")
        var foreign = row; foreign["source"] = ["id": "source-\u{e9}"]
        fixed(.unavailable) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [foreign]) }
        var plain = row; plain["title"] = "Mindwtr"
        plain["externalIdentifier"] = temporaryID
        fixed(.unavailable) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [plain]) }
        XCTAssertEqual(try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [foreign, plain, row]), "calendar-e\u{301}")
    }

    func testCalendarDuplicatesChangedPropertiesAndMalformedFieldsRefuse() throws {
        let effect = try calendarEffect(), row = try calendarRow(effect)
        fixed(.unavailable) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: []) }
        var duplicate = row; duplicate["color"] = "#000000"; duplicate["allowsModifications"] = false
        fixed(.ambiguous) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [row, duplicate]) }
        for (name, value) in [("color", "#000000" as Any), ("allowsModifications", false as Any)] {
            var changed = row; changed[name] = value
            fixed(.unavailable) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [changed]) }
        }
        for name in ["id", "color", "allowsModifications"] {
            var malformed = row; malformed.removeValue(forKey: name)
            fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [malformed]) }
        }
        for (name, value) in [("id", "" as Any), ("color", "rgb(1,2,3)" as Any),
                              ("allowsModifications", NSNumber(value: 1) as Any)] {
            var malformed = row; malformed[name] = value
            fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: effect, calendars: [malformed]) }
        }
    }

    func testCalendarRecoveryRequiresStartedCreateAndCanonicalUniqueTemporaryTitle() throws {
        let effect = try calendarEffect(), row = try calendarRow(effect)
        let prepared = try NativeCalendarPushEffect(id: id, libraryID: "library", requestJSON: effect.requestJSON,
                                                    beforeCalendarState: effect.beforeCalendarState)
        fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: prepared, calendars: [row]) }
        let saved = try effect.recording(result: .identifier("calendar"))
        fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: saved, calendars: [row]) }
        fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: eventEffect(), calendars: [row]) }
        for title in ["Mindwtr", "Mindwtr (not-a-uuid)", "Mindwtr (\(temporaryID.uppercased()))", "Mindwtr (\(temporaryID)) "] {
            fixed(.invalid) { try NativeCalendarPushWitness.createdCalendar(effect: calendarEffect(title: title), calendars: [row]) }
        }
    }
}
