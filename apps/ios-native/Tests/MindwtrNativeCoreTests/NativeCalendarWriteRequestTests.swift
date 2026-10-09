import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarWriteRequestTests: XCTestCase {
    private var event: [String: Any] {
        ["title": "Synthetic event", "startMs": 1_800_000_000_000, "endMs": 1_800_003_600_000,
         "allDay": false, "notes": "Synthetic notes", "location": ""]
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func invalid(_ raw: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try NativeCalendarWriteRequest(json: raw), file: file, line: line) {
            XCTAssertEqual($0 as? NativeCalendarWriteError, .invalid, file: file, line: line)
            XCTAssertEqual($0.localizedDescription, "Calendar write request is invalid", file: file, line: line)
        }
    }

    func testClosedOperationsRetainExactIDsAndTypedEventFields() throws {
        guard case .sources = try NativeCalendarWriteRequest(json: ##"{"op":"sources"}"##) else { return XCTFail() }
        let create = try json(["op": "createCalendar", "details": ["title": "Mindwtr", "color": "#3B82F6", "entityType": "event", "sourceId": "source"]])
        guard case .createCalendar(let details) = try NativeCalendarWriteRequest(json: create) else { return XCTFail() }
        XCTAssertEqual(details.sourceID, "source"); XCTAssertEqual(details.title, "Mindwtr")
        guard case .updateCalendar(let calendar, let update) = try NativeCalendarWriteRequest(json: ##"{"op":"updateCalendar","calendarId":"calendar","details":{"color":"#3B82F6","title":"Renamed"}}"##) else { return XCTFail() }
        XCTAssertEqual(calendar, "calendar"); XCTAssertEqual(update.title, "Renamed")
        guard case .deleteCalendar(let deleted) = try NativeCalendarWriteRequest(json: ##"{"op":"deleteCalendar","calendarId":"calendar"}"##) else { return XCTFail() }
        XCTAssertEqual(deleted, "calendar")
        let decomposed = "e\u{301}"
        let raw = try json(["op": "createEvent", "calendarId": decomposed, "details": event])
        guard case .createEvent(let target, let fields) = try NativeCalendarWriteRequest(json: raw) else { return XCTFail() }
        XCTAssertEqual(Data(target.utf8), Data(decomposed.utf8)); XCTAssertNotEqual(Data(target.utf8), Data("é".utf8))
        XCTAssertEqual(fields.start.timeIntervalSince1970, 1_800_000_000)
        XCTAssertEqual(fields.end.timeIntervalSince1970, 1_800_003_600)
        XCTAssertFalse(fields.allDay); XCTAssertEqual(fields.notes, "Synthetic notes"); XCTAssertNil(fields.url)
        guard case .updateEvent(let eventID, let current, _) = try NativeCalendarWriteRequest(json: json(["op": "updateEvent", "calendarId": "calendar", "eventId": "event", "details": event])) else { return XCTFail() }
        XCTAssertEqual(eventID, "event"); XCTAssertEqual(current, "calendar")
        guard case .deleteEvent(let removed, let prior) = try NativeCalendarWriteRequest(json: ##"{"op":"deleteEvent","eventId":"event","calendarId":"old-calendar"}"##) else { return XCTFail() }
        XCTAssertEqual(removed, "event"); XCTAssertEqual(prior, "old-calendar")
    }

    func testInvalidGrammarDuplicatesAndPrivateParserErrorsUseFixedFailure() throws {
        for raw in ["", "[]", "null", "{private-title", ##"{"op":"unknown"}"##,
                    ##"{"op":"sources","all":true}"##,
                    ##"{"op":"sources","op":"sources"}"##,
                    ##"{"op":"sources","\u006fp":"sources"}"##,
                    ##"{"op":"deleteEvent","eventId":"event"}"##,
                    ##"{"op":"deleteEvent","eventId":"event","calendarId":true}"##,
                    ##"{"op":"deleteCalendar","calendarId":"\ud800"}"##,
                    ##"{"op":"createCalendar","details":{"title":"A","title":"B","color":"#3B82F6","entityType":"event","sourceId":"source"}}"##,
                    ##"{"op":"createCalendar","details":{"title":"A","color":"#3B82F6","entityType":"reminder","sourceId":"source"}}"##,
                    ##"{"op":"updateCalendar","calendarId":"calendar","details":{"color":"#3B82F6","title":null}}"##] {
            invalid(raw)
        }
        for (name, value) in [("allDay", 1 as Any), ("startMs", true), ("endMs", 1.5),
                              ("startMs", NSNull()), ("endMs", 1_799_000_000_000),
                              ("url", NSNull()), ("timeZone", "not-a-zone"), ("recurrenceRule", "daily")] {
            var details = event; details[name] = value
            invalid(try json(["op": "createEvent", "calendarId": "calendar", "details": details]))
        }
    }

    func testOptionalFieldsAndWholeEscapedFrameLimit() throws {
        var details = event
        details["url"] = "https://example.invalid/event"
        details["timeZone"] = "UTC"; details["endTimeZone"] = "America/New_York"
        guard case .createEvent(_, let value) = try NativeCalendarWriteRequest(json: json(["op": "createEvent", "calendarId": "calendar", "details": details])) else { return XCTFail() }
        XCTAssertEqual(value.url, "https://example.invalid/event"); XCTAssertEqual(value.endTimeZone, "America/New_York")
        let raw = ##"{"op":"sources"}"##
        let boundary = raw + String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes - raw.utf8.count)
        XCTAssertNoThrow(try NativeCalendarWriteRequest(json: boundary))
        invalid(boundary + " ")
        details["notes"] = String(repeating: "\n", count: NativeCalendarJobs.maximumRequestBytes / 2)
        let escaped = try json(["op": "createEvent", "calendarId": "calendar", "details": details])
        XCTAssertGreaterThan(escaped.utf8.count, NativeCalendarJobs.maximumRequestBytes)
        invalid(escaped)
    }

    func testCurrentReadBridgeCannotAdmitAnyWriterOperation() throws {
        var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests(), readerFactory: {
            factories += 1; return CalendarTestReader()
        })
        defer { jobs.shutdown() }
        let requests = try [
            json(["op": "sources"]),
            json(["op": "createCalendar", "details": ["title": "Mindwtr", "color": "#3B82F6", "entityType": "event", "sourceId": "source"]]),
            json(["op": "updateCalendar", "calendarId": "calendar", "details": ["color": "#3B82F6"]]),
            json(["op": "deleteCalendar", "calendarId": "calendar"]),
            json(["op": "createEvent", "calendarId": "calendar", "details": event]),
            json(["op": "updateEvent", "eventId": "event", "calendarId": "calendar", "details": event]),
            json(["op": "deleteEvent", "eventId": "event", "calendarId": "calendar"]),
        ]
        for raw in requests {
            XCTAssertNoThrow(try NativeCalendarWriteRequest(json: raw))
            XCTAssertThrowsError(try jobs.submit(raw))
        }
        XCTAssertEqual(factories, 0); XCTAssertEqual(jobs.counters.jobs, 0)
    }
}
