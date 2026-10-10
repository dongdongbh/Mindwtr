import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarPushRequestTests: XCTestCase {
    private let operationID = "abcdef12-3456-4789-abcd-0123456789ab"
    private var event: [String: Any] {
        ["title": "Synthetic event", "startMs": 1_800_000_000_000, "endMs": 1_800_003_600_000,
         "allDay": false, "notes": "Synthetic notes", "location": ""]
    }
    private var mapping: [String: Any] {
        ["taskId": "task-é", "calendarEventId": "event-é", "calendarId": "calendar-é",
         "platform": "ios", "lastSyncedAt": "2026-10-09T00:00:00.000Z"]
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func invalid(_ raw: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try NativeCalendarPushRequest(json: raw), file: file, line: line) {
            XCTAssertEqual($0 as? NativeCalendarWriteError, .invalid, file: file, line: line)
            XCTAssertEqual($0.localizedDescription, "Calendar write request is invalid", file: file, line: line)
        }
    }

    func testClosedReadsRetainTypedValuesAndCanonicalNestedJSON() throws {
        for operation in ["permissions", "calendars"] {
            let nested = ["op": operation]
            guard case .read(let request, let canonical) = try NativeCalendarPushRequest(json: json(["op": "read", "request": nested])) else { return XCTFail() }
            switch (operation, request) {
            case ("permissions", .permissions), ("calendars", .calendars): break
            default: XCTFail()
            }
            XCTAssertEqual(canonical, try json(nested))
        }
        let id = "\u{feff}calendar-e\u{301}"
        let nested: [String: Any] = ["op": "events", "calendarIds": [id, "calendar-é", id],
                                    "startMs": 1_800_000_000_000, "endMs": 1_800_003_600_000]
        guard case .read(.events(let ids, let start, let end), let canonical) = try NativeCalendarPushRequest(json: json(["op": "read", "request": nested])) else { return XCTFail() }
        XCTAssertEqual(ids.map { Data($0.utf8) }, [id, "calendar-é", id].map { Data($0.utf8) })
        XCTAssertEqual(start.timeIntervalSince1970, 1_800_000_000)
        XCTAssertEqual(end.timeIntervalSince1970, 1_800_003_600)
        XCTAssertEqual(canonical, try json(nested))
        let restored = try XCTUnwrap(NativeJSON.jsonObject(with: Data(canonical.utf8)) as? [String: Any])
        XCTAssertEqual((restored["calendarIds"] as? [String])?.map { Data($0.utf8) }, ids.map { Data($0.utf8) })
    }

    func testAllWritersReuseTheExistingClosedGrammarAndRetainCanonicalSnapshot() throws {
        let requests: [[String: Any]] = [
            ["op": "createCalendar", "details": ["title": "Mindwtr", "color": "#3B82F6", "entityType": "event", "sourceId": "source-é"]],
            ["op": "updateCalendar", "calendarId": "calendar-é", "details": ["color": "#3B82F6"]],
            ["op": "deleteCalendar", "calendarId": "calendar-é"],
            ["op": "createEvent", "calendarId": "calendar-é", "details": event],
            ["op": "updateEvent", "eventId": "event-é", "calendarId": "calendar-é", "details": event],
            ["op": "deleteEvent", "eventId": "event-é", "calendarId": "calendar-é"],
        ]
        for nested in requests {
            let isEvent = (nested["op"] as? String)?.hasSuffix("Event") == true
            let task: Any = isEvent ? ("task-e\u{301}" as Any) : NSNull()
            guard case .write(let request, let canonical, let taskID) = try NativeCalendarPushRequest(json: json(["op": "write", "request": nested, "taskId": task])) else { return XCTFail() }
            XCTAssertEqual(canonical, try json(nested))
            XCTAssertEqual(taskID.map { Data($0.utf8) }, isEvent ? Data("task-e\u{301}".utf8) : nil)
            switch (nested["op"] as? String, request) {
            case ("createCalendar", .createCalendar), ("updateCalendar", .updateCalendar), ("deleteCalendar", .deleteCalendar),
                 ("createEvent", .createEvent), ("updateEvent", .updateEvent), ("deleteEvent", .deleteEvent): break
            default: XCTFail()
            }
            XCTAssertNoThrow(try NativeCalendarWriteRequest(json: canonical))
        }
    }

    func testMappingAcknowledgementCleanupAndReadsRetainExactRowsAndIdentities() throws {
        guard case .ackMapping(let id, let entry) = try NativeCalendarPushRequest(json: json(["op": "ackMapping", "operationId": operationID, "entry": mapping])) else { return XCTFail() }
        XCTAssertEqual(id.uuidString.lowercased(), operationID)
        XCTAssertEqual(entry?.taskId, "task-é"); XCTAssertEqual(entry?.calendarEventId, "event-é")
        guard case .ackMapping(_, nil) = try NativeCalendarPushRequest(json: json(["op": "ackMapping", "operationId": operationID, "entry": NSNull()])) else { return XCTFail() }
        guard case .deleteMapping(let expected) = try NativeCalendarPushRequest(json: json(["op": "deleteMapping", "expected": mapping])) else { return XCTFail() }
        XCTAssertEqual(expected, entry)
        let task = "\u{feff}task-e\u{301}"
        guard case .mapping(let taskID) = try NativeCalendarPushRequest(json: json(["op": "mapping", "taskId": task])) else { return XCTFail() }
        XCTAssertEqual(Data(taskID.utf8), Data(task.utf8))
        guard case .sources = try NativeCalendarPushRequest(json: ##"{"op":"sources"}"##) else { return XCTFail() }
        guard case .mappings = try NativeCalendarPushRequest(json: ##"{"op":"mappings"}"##) else { return XCTFail() }
        guard case .readState = try NativeCalendarPushRequest(json: ##"{"op":"readState"}"##) else { return XCTFail() }
    }

    func testCanonicalWriteRetainsBOMUnicodeAndQuotedKeyText() throws {
        let identity = "\u{feff}e\u{301}"
        let notes = identity + ##" {"op":"one","op":"two"}"##
        var fields = event; fields["notes"] = notes
        let nested: [String: Any] = ["op": "createEvent", "calendarId": identity, "details": fields]
        guard case .write(.createEvent(let calendar, let details), let canonical, let task) = try NativeCalendarPushRequest(json: json(["op": "write", "request": nested, "taskId": identity])) else { return XCTFail() }
        XCTAssertEqual(Data(calendar.utf8), Data(identity.utf8))
        XCTAssertEqual(task.map { Data($0.utf8) }, Data(identity.utf8))
        XCTAssertEqual(Data(details.notes.utf8), Data(notes.utf8))
        XCTAssertEqual(canonical, try json(nested))
    }

    func testSetStateAcceptsOnlyFiveNamesAndExactStringOrNullValues() throws {
        for suffix in ["enabled", "calendar-id", "target-calendar-id", "color", "creation-intent"] {
            let name = "mindwtr:calendar-push-sync:" + suffix
            for value in ["", "\u{feff}e\u{301}", NSNull()] as [Any] {
                guard case .setState(let parsedName, let parsedValue) = try NativeCalendarPushRequest(json: json(["op": "setState", "name": name, "value": value])) else { return XCTFail() }
                XCTAssertEqual(parsedName, name)
                XCTAssertEqual(parsedValue.map { Data($0.utf8) }, (value as? String).map { Data($0.utf8) })
            }
        }
        for name in ["mindwtr:calendar-push-sync:pending-calendar", "mindwtr:native:calendar-push-effect:v1", "other", "mindwtr:calendar-push-sync:enabled "] {
            invalid(try json(["op": "setState", "name": name, "value": "1"]))
        }
        for value in [true, 1, [Any](), [String: Any]()] as [Any] {
            invalid(try json(["op": "setState", "name": "mindwtr:calendar-push-sync:enabled", "value": value]))
        }
    }

    func testEveryOuterOperationRejectsUnknownAndMissingFields() throws {
        let requests: [[String: Any]] = [
            ["op": "read", "request": ["op": "permissions"]], ["op": "sources"],
            ["op": "write", "request": ["op": "deleteCalendar", "calendarId": "calendar"], "taskId": NSNull()],
            ["op": "ackMapping", "operationId": operationID, "entry": NSNull()],
            ["op": "deleteMapping", "expected": mapping], ["op": "mapping", "taskId": "task"],
            ["op": "mappings"], ["op": "readState"],
            ["op": "setState", "name": "mindwtr:calendar-push-sync:enabled", "value": NSNull()],
        ]
        for request in requests {
            var extra = request; extra["options"] = true; invalid(try json(extra))
            for name in request.keys {
                var missing = request; missing.removeValue(forKey: name); invalid(try json(missing))
            }
        }
        for raw in ["", "null", "[]", "true", "{private-title", ##"{"op":"unknown"}"##,
                    ##"{"op":"permissions"}"##, ##"{"op":"read","request":{"op":"readFile","uri":"file:///private"}}"##,
                    ##"{"op":"read","request":{"op":"sources"}}"##,
                    ##"{"op":"read","request":{"op":"permissions","options":true}}"##,
                    ##"{"op":"read","request":[]}"##,
                    ##"{"op":"write","request":{"op":"sources"},"taskId":null}"##,
                    ##"{"op":"ackMapping","operationId":true,"entry":null}"##,
                    ##"{"op":"ackMapping","operationId":"abcdef12-3456-4789-abcd-0123456789ab","entry":"row"}"##,
                    ##"{"op":"mapping","taskId":true}"##,
                    ##"{"op":"write","request":{"op":"deleteCalendar","calendarId":"calendar"},"taskId":1}"##] {
            invalid(raw)
        }
    }

    func testRecursiveDuplicatesIncludingEscapedKeysAreRejectedBeforeCanonicalization() {
        for raw in [
            ##"{"op":"sources","\u006fp":"sources"}"##,
            ##"{"op":"read","request":{"op":"permissions","\u006fp":"permissions"}}"##,
            ##"{"op":"write","request":{"op":"createCalendar","details":{"title":"A","\u0074itle":"B","color":"#3B82F6","entityType":"event","sourceId":"source"}},"taskId":null}"##,
            ##"{"op":"ackMapping","operationId":"abcdef12-3456-4789-abcd-0123456789ab","entry":{"taskId":"one","\u0074askId":"two","calendarEventId":"e","calendarId":"c","platform":"ios","lastSyncedAt":"s"}}"##,
            ##"{"op":"deleteMapping","expected":{"taskId":"t","calendarEventId":"e","calendarId":"c","platform":"ios","lastSyncedAt":"s","lastSyncedAt":"s"}}"##,
            ##"{"op":"setState","name":"mindwtr:calendar-push-sync:enabled","value":"0","\u0076alue":"1"}"##,
        ] { invalid(raw) }
    }

    func testClosedMappingUUIDAndIdentifierGrammar() throws {
        for id in [operationID.uppercased(), "{" + operationID + "}", operationID.replacingOccurrences(of: "-", with: ""), " " + operationID, "invalid"] {
            invalid(try json(["op": "ackMapping", "operationId": id, "entry": NSNull()]))
        }
        for (name, value) in [("taskId", "" as Any), ("calendarId", " \u{feff}"), ("calendarEventId", 1),
                              ("platform", "android"), ("lastSyncedAt", ""), ("lastSyncedAt", String(repeating: "é", count: 65)),
                              ("calendarId", String(repeating: "é", count: 513)), ("extra", true)] {
            var row = mapping; row[name] = value
            invalid(try json(["op": "ackMapping", "operationId": operationID, "entry": row]))
            invalid(try json(["op": "deleteMapping", "expected": row]))
        }
        for name in mapping.keys {
            var row = mapping; row.removeValue(forKey: name)
            invalid(try json(["op": "deleteMapping", "expected": row]))
        }
        invalid(try json(["op": "deleteMapping", "expected": NSNull()]))
        invalid(##"{"op":"mapping","taskId":"\ud800"}"##)
        for task in ["", " \u{feff}", String(repeating: "é", count: 513)] {
            invalid(try json(["op": "mapping", "taskId": task]))
            invalid(try json(["op": "write", "request": ["op": "deleteCalendar", "calendarId": "calendar"], "taskId": task]))
        }
        var row = mapping; row["taskId"] = String(repeating: "é", count: 512); row["lastSyncedAt"] = String(repeating: "é", count: 64)
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: json(["op": "deleteMapping", "expected": row])))
    }

    func testReadAndWriteNestedValuesReuseExistingBoundsAndStrictTypes() throws {
        let nested: [String: Any] = ["op": "events", "calendarIds": [], "startMs": 0, "endMs": 366 * 86_400_000]
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: json(["op": "read", "request": nested])))
        for (start, end) in [(-62_135_596_800_000, -62_135_510_400_000), (253_402_214_399_999, 253_402_300_799_999)] {
            XCTAssertNoThrow(try NativeCalendarPushRequest(json: json(["op": "read", "request": ["op": "events", "calendarIds": [], "startMs": start, "endMs": end]])))
        }
        var boundary = nested
        boundary["calendarIds"] = Array(repeating: String(repeating: "é", count: 512), count: 1024)
        // The collection's aggregate still must fit the closed outer frame.
        invalid(try json(["op": "read", "request": boundary]))
        boundary["calendarIds"] = Array(repeating: "calendar", count: 1024)
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: json(["op": "read", "request": boundary])))
        boundary["calendarIds"] = [String(repeating: "é", count: 512)]
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: json(["op": "read", "request": boundary])))
        for (name, value) in [("startMs", true as Any), ("startMs", 0.5), ("startMs", -62_135_596_800_001),
                              ("endMs", 253_402_300_800_000), ("endMs", 0), ("endMs", 366 * 86_400_000 + 1),
                              ("calendarIds", [""]), ("calendarIds", [String(repeating: "é", count: 513)]),
                              ("calendarIds", Array(repeating: "calendar", count: 1025)), ("calendarIds", [1]), ("extra", true)] {
            var request = nested; request[name] = value
            invalid(try json(["op": "read", "request": request]))
        }
        for (name, value) in [("allDay", 1 as Any), ("startMs", true), ("url", NSNull()), ("timeZone", "not-a-zone"), ("calendarId", "calendar")] {
            var fields = event; fields[name] = value
            invalid(try json(["op": "write", "taskId": "task", "request": ["op": "createEvent", "calendarId": "calendar", "details": fields]]))
        }
    }

    func testWholeUTF8FrameAndEscapedStateValueLimits() throws {
        let raw = ##"{"op":"sources"}"##
        let boundary = raw + String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes - raw.utf8.count)
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: boundary)); invalid(boundary + " ")
        let name = "mindwtr:calendar-push-sync:creation-intent"
        let empty = try json(["op": "setState", "name": name, "value": ""])
        let capacity = NativeCalendarJobs.maximumRequestBytes - empty.utf8.count
        let value = String(repeating: "é", count: capacity / 2) + String(repeating: "a", count: capacity % 2)
        let exact = try json(["op": "setState", "name": name, "value": value])
        XCTAssertEqual(exact.utf8.count, NativeCalendarJobs.maximumRequestBytes)
        XCTAssertNoThrow(try NativeCalendarPushRequest(json: exact))
        invalid(try json(["op": "setState", "name": name, "value": value + "a"]))
        let escaped = try json(["op": "setState", "name": name, "value": String(repeating: "\n", count: NativeCalendarJobs.maximumRequestBytes / 2)])
        XCTAssertGreaterThan(escaped.utf8.count, NativeCalendarJobs.maximumRequestBytes); invalid(escaped)
    }
}
