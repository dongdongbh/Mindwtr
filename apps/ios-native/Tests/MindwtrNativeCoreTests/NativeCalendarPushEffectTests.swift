import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarPushEffectTests: XCTestCase {
    private let operationID = UUID(uuid: (0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0x4c, 0xcc,
                                           0x8d, 0xdd, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee))
    private var event: [String: Any] {
        ["title": "Synthetic event", "startMs": 1_800_000_000_000, "endMs": 1_800_003_600_000,
         "allDay": false, "notes": "Synthetic notes", "location": ""]
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func request(_ operation: String, calendar: String = "calendar", eventID: String = "event") throws -> String {
        switch operation {
        case "createCalendar":
            return try json(["op": operation, "details": ["title": "Mindwtr", "color": "#3B82F6", "entityType": "event", "sourceId": "source"]])
        case "updateCalendar": return try json(["op": operation, "calendarId": calendar, "details": ["color": "#3B82F6"]])
        case "deleteCalendar": return try json(["op": operation, "calendarId": calendar])
        case "createEvent": return try json(["op": operation, "calendarId": calendar, "details": event])
        case "updateEvent": return try json(["op": operation, "calendarId": calendar, "eventId": eventID, "details": event])
        default: return try json(["op": operation, "calendarId": calendar, "eventId": eventID])
        }
    }
    private func mapping(task: String = "task", calendar: String = "calendar", eventID: String = "event",
                         stamp: String = "before") throws -> NativeCalendarPushMapping {
        try NativeCalendarPushMapping(taskId: task, calendarEventId: eventID, calendarId: calendar,
                                      platform: "ios", lastSyncedAt: stamp)
    }
    private func prepared(_ operation: String, raw: String? = nil) throws -> NativeCalendarPushEffect {
        let eventOperation = operation.hasSuffix("Event")
        return try NativeCalendarPushEffect(id: operationID, libraryID: "library", requestJSON: raw ?? request(operation),
                                            taskID: eventOperation ? "task" : nil,
                                            beforeMapping: eventOperation && operation != "createEvent" ? mapping() : nil,
                                            beforeCalendarState: eventOperation ? nil : [nil, "calendar", nil, "#3B82F6", nil])
    }
    private func object(_ effect: NativeCalendarPushEffect) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(effect.encoded().utf8)) as? [String: Any])
    }
    private func invalid<T>(file: StaticString = #filePath, line: UInt = #line, _ work: () throws -> T) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertEqual($0 as? NativeCalendarWriteError, .invalid, file: file, line: line)
            XCTAssertEqual($0.localizedDescription, "Calendar write request is invalid", file: file, line: line)
        }
    }
    private func roundtrip(_ effect: NativeCalendarPushEffect) throws {
        let restored = try NativeCalendarPushEffect(json: effect.encoded())
        XCTAssertEqual(restored.id, effect.id)
        XCTAssertEqual(Data(restored.libraryID.utf8), Data(effect.libraryID.utf8))
        XCTAssertEqual(Data(restored.requestJSON.utf8), Data(effect.requestJSON.utf8))
        XCTAssertEqual(restored.taskID.map { Data($0.utf8) }, effect.taskID.map { Data($0.utf8) })
        XCTAssertEqual(restored.beforeMapping, effect.beforeMapping)
        XCTAssertEqual(restored.beforeCalendarState?.map { $0.map { Data($0.utf8) } },
                       effect.beforeCalendarState?.map { $0.map { Data($0.utf8) } })
        XCTAssertEqual(restored.phase, effect.phase); XCTAssertEqual(restored.result, effect.result)
        XCTAssertEqual(restored.afterMapping, effect.afterMapping)
        XCTAssertLessThanOrEqual(try effect.encoded().utf8.count, NativeCalendarJobs.maximumRequestBytes)
    }

    func testAllSixMutationKindsHaveOnlyForwardTransitionsAndRoundtrip() throws {
        let operations = ["createCalendar", "updateCalendar", "deleteCalendar", "createEvent", "updateEvent", "deleteEvent"]
        for operation in operations {
            let first = try prepared(operation)
            XCTAssertEqual(first.phase, .prepared); XCTAssertNil(first.result); XCTAssertNil(first.afterMapping)
            invalid { try first.recording(result: .completed) }
            invalid { try first.acknowledging(mapping: nil) }
            let started = try first.markingStarted()
            XCTAssertEqual(started.phase, .started)
            invalid { try started.markingStarted() }; invalid { try started.acknowledging(mapping: nil) }
            let result: NativeCalendarPushEffect.Result = operation.hasPrefix("create") ? .identifier("created") : .completed
            let saved = try started.recording(result: result)
            XCTAssertEqual(saved.phase, .saved); XCTAssertNil(saved.afterMapping)
            invalid { try saved.markingStarted() }; invalid { try saved.recording(result: result) }
            let after: NativeCalendarPushMapping?
            if operation == "createEvent" { after = try mapping(eventID: "created", stamp: "after") }
            else if operation == "updateEvent" { after = try mapping(stamp: "after") }
            else { after = nil }
            let acknowledging = try saved.acknowledging(mapping: after)
            XCTAssertEqual(acknowledging.phase, .acknowledging)
            invalid { try acknowledging.markingStarted() }
            invalid { try acknowledging.recording(result: result) }
            invalid { try acknowledging.acknowledging(mapping: after) }
            for effect in [first, started, saved, acknowledging] { try roundtrip(effect) }
            let frame = try object(acknowledging)
            XCTAssertEqual(Set(frame.keys), ["version", "id", "libraryId", "requestJSON", "taskId", "beforeMapping", "beforeCalendarState", "phase", "result", "afterMapping"])
            XCTAssertEqual(frame["id"] as? String, operationID.uuidString.lowercased())
            XCTAssertTrue(frame["taskId"] is NSNull || frame["taskId"] is String)
        }
    }

    func testResultsAreClosedToTheirOperationAndMissingEventRemovesMapping() throws {
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar", "createEvent", "updateEvent", "deleteEvent"] {
            let started = try prepared(operation).markingStarted()
            for result in [NativeCalendarPushEffect.Result.identifier("created"), .completed, .missingEvent] {
                let legal: Bool
                switch result {
                case .identifier: legal = operation.hasPrefix("create")
                case .completed: legal = !operation.hasPrefix("create")
                case .missingEvent: legal = operation == "updateEvent" || operation == "deleteEvent"
                }
                if legal {
                    let saved = try started.recording(result: result)
                    try roundtrip(saved)
                    if result == .missingEvent {
                        let acknowledged = try saved.acknowledging(mapping: nil)
                        XCTAssertNil(acknowledged.afterMapping); try roundtrip(acknowledged)
                        invalid { try saved.acknowledging(mapping: mapping()) }
                    }
                } else { invalid { try started.recording(result: result) } }
            }
            invalid { try started.recording(result: .identifier("")) }
            invalid { try started.recording(result: .identifier(String(repeating: "x", count: 1025))) }
        }
    }

    func testPreparedIdentityAndMappingsCannotBeSubstituted() throws {
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: ##"{"op":"sources"}"##) }
        for library in ["", String(repeating: "é", count: 513)] {
            invalid { try NativeCalendarPushEffect(libraryID: library, requestJSON: request("deleteCalendar")) }
        }
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar"] {
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), taskID: "task") }
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), beforeMapping: mapping()) }
        }
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request("createEvent")) }
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request("createEvent"), taskID: "task", beforeMapping: mapping()) }
        for operation in ["updateEvent", "deleteEvent"] {
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), taskID: "task") }
            for row in try [mapping(task: "other"), mapping(calendar: "other"), mapping(eventID: "other")] {
                invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), taskID: "task", beforeMapping: row) }
            }
        }
        for task in ["", " ", String(repeating: "x", count: 1025)] {
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request("createEvent"), taskID: task) }
        }
        let create = try prepared("createEvent").markingStarted().recording(result: .identifier("created"))
        let update = try prepared("updateEvent").markingStarted().recording(result: .completed)
        for row in try [mapping(task: "other", eventID: "created"), mapping(calendar: "other", eventID: "created"), mapping()] {
            invalid { try create.acknowledging(mapping: row) }
        }
        for row in try [mapping(task: "other"), mapping(calendar: "other"), mapping(eventID: "other")] {
            invalid { try update.acknowledging(mapping: row) }
        }
        invalid { try create.acknowledging(mapping: nil) }; invalid { try update.acknowledging(mapping: nil) }
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar", "deleteEvent"] {
            let result: NativeCalendarPushEffect.Result = operation == "createCalendar" ? .identifier("created") : .completed
            let saved = try prepared(operation).markingStarted().recording(result: result)
            invalid { try saved.acknowledging(mapping: mapping()) }
        }
    }

    func testMappingValidationAndEqualityUseExactUTF8ForEveryField() throws {
        let decomposed = "e\u{301}", composed = "é"
        let original = try NativeCalendarPushMapping(taskId: decomposed, calendarEventId: decomposed, calendarId: decomposed,
                                                    platform: "ios", lastSyncedAt: decomposed)
        for row in try [
            NativeCalendarPushMapping(taskId: composed, calendarEventId: decomposed, calendarId: decomposed, platform: "ios", lastSyncedAt: decomposed),
            NativeCalendarPushMapping(taskId: decomposed, calendarEventId: composed, calendarId: decomposed, platform: "ios", lastSyncedAt: decomposed),
            NativeCalendarPushMapping(taskId: decomposed, calendarEventId: decomposed, calendarId: composed, platform: "ios", lastSyncedAt: decomposed),
            NativeCalendarPushMapping(taskId: decomposed, calendarEventId: decomposed, calendarId: decomposed, platform: "ios", lastSyncedAt: composed)
        ] { XCTAssertNotEqual(original, row) }
        for platform in ["android", "iOS", "ios "] {
            invalid { try NativeCalendarPushMapping(taskId: "task", calendarEventId: "event", calendarId: "calendar", platform: platform, lastSyncedAt: "stamp") }
        }
        for stamp in ["", String(repeating: "é", count: 65)] {
            invalid { try NativeCalendarPushMapping(taskId: "task", calendarEventId: "event", calendarId: "calendar", platform: "ios", lastSyncedAt: stamp) }
        }
        for badID in ["", " ", String(repeating: "x", count: 1025)] {
            invalid { try NativeCalendarPushMapping(taskId: badID, calendarEventId: "event", calendarId: "calendar", platform: "ios", lastSyncedAt: "stamp") }
            invalid { try NativeCalendarPushMapping(taskId: "task", calendarEventId: badID, calendarId: "calendar", platform: "ios", lastSyncedAt: "stamp") }
            invalid { try NativeCalendarPushMapping(taskId: "task", calendarEventId: "event", calendarId: badID, platform: "ios", lastSyncedAt: "stamp") }
        }
        let raw = try request("updateEvent", calendar: decomposed, eventID: decomposed)
        for row in try [mapping(task: composed, calendar: decomposed, eventID: decomposed),
                        mapping(task: decomposed, calendar: composed, eventID: decomposed),
                        mapping(task: decomposed, calendar: decomposed, eventID: composed)] {
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: raw, taskID: decomposed, beforeMapping: row) }
        }
        let valid = try NativeCalendarPushEffect(libraryID: "library", requestJSON: raw, taskID: decomposed, beforeMapping: original)
        let saved = try valid.markingStarted().recording(result: .completed)
        invalid { try saved.acknowledging(mapping: mapping(task: composed, calendar: decomposed, eventID: decomposed)) }
        invalid { try saved.acknowledging(mapping: mapping(task: decomposed, calendar: composed, eventID: decomposed)) }
        invalid { try saved.acknowledging(mapping: mapping(task: decomposed, calendar: decomposed, eventID: composed)) }
    }

    func testFrozenBytesSurviveEveryPhaseAndLeadingBOMDecoder() throws {
        let text = "\u{feff}e\u{301}", raw = " \n" + (try request("updateEvent", calendar: text, eventID: text)) + "\t "
        let before = try mapping(task: text, calendar: text, eventID: text, stamp: text)
        let initial = try NativeCalendarPushEffect(id: operationID, libraryID: text, requestJSON: raw, taskID: text, beforeMapping: before)
        let started = try initial.markingStarted(), saved = try started.recording(result: .completed)
        let acknowledging = try saved.acknowledging(mapping: mapping(task: text, calendar: text, eventID: text, stamp: "after"))
        for effect in [initial, started, saved, acknowledging] {
            XCTAssertEqual(Data(effect.requestJSON.utf8), Data(raw.utf8))
            XCTAssertEqual(Data(effect.libraryID.utf8), Data(text.utf8))
            XCTAssertEqual(effect.beforeMapping, before); try roundtrip(effect)
        }
        XCTAssertNotEqual(NativeCalendarPushEffect.Result.identifier("é"), .identifier("e\u{301}"))
    }

    func testMalformedFramesDuplicateKeysAndExplicitNullGrammarArePrivate() throws {
        let initial = try prepared("deleteCalendar"), baseline = try object(initial)
        for raw in ["", "null", "[]", "{private-title", String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes + 1)] {
            invalid { try NativeCalendarPushEffect(json: raw) }
        }
        for field in baseline.keys {
            var missing = baseline; missing.removeValue(forKey: field)
            invalid { try NativeCalendarPushEffect(json: json(missing)) }
        }
        for (field, value) in [("version", true as Any), ("version", 2), ("version", "1"), ("version", 1.5),
                               ("id", operationID.uuidString.uppercased()), ("id", "not-a-uuid"), ("libraryId", NSNull()),
                               ("requestJSON", NSNull()), ("taskId", false), ("beforeMapping", false),
                               ("result", false), ("afterMapping", false), ("phase", "unknown"), ("extra", true)] {
            var malformed = baseline; malformed[field] = value
            invalid { try NativeCalendarPushEffect(json: json(malformed)) }
        }
        let encoded = try initial.encoded()
        invalid { try NativeCalendarPushEffect(json: "{\"version\":1," + String(encoded.dropFirst())) }
        invalid { try NativeCalendarPushEffect(json: "{\"\\u0076ersion\":1," + String(encoded.dropFirst())) }
        invalid { try NativeCalendarPushEffect(json: encoded.replacingOccurrences(of: "\"libraryId\":\"library\"", with: "\"libraryId\":\"\\ud800\"")) }
        var changed = baseline; changed["requestJSON"] = ##"{"op":"deleteCalendar","calendarId":"calendar","extra":true}"##
        invalid { try NativeCalendarPushEffect(json: json(changed)) }
        var eventFrame = try object(prepared("updateEvent"))
        let row = try XCTUnwrap(eventFrame["beforeMapping"] as? [String: Any])
        for field in row.keys {
            var missing = row; missing.removeValue(forKey: field); eventFrame["beforeMapping"] = missing
            invalid { try NativeCalendarPushEffect(json: json(eventFrame)) }
        }
        for (field, value) in [("taskId", NSNull() as Any), ("calendarEventId", true), ("calendarId", ""),
                               ("platform", "android"), ("lastSyncedAt", ""), ("extra", true)] {
            var malformed = row; malformed[field] = value; eventFrame["beforeMapping"] = malformed
            invalid { try NativeCalendarPushEffect(json: json(eventFrame)) }
        }
        let eventJSON = try prepared("updateEvent").encoded()
        invalid { try NativeCalendarPushEffect(json: eventJSON.replacingOccurrences(of: "\"beforeMapping\":{", with: "\"beforeMapping\":{\"taskId\":\"task\",")) }
        invalid { try NativeCalendarPushEffect(json: eventJSON.replacingOccurrences(of: "\"beforeMapping\":{", with: "\"beforeMapping\":{\"\\u0074askId\":\"task\",")) }
        let saved = try prepared("createCalendar").markingStarted().recording(result: .identifier("created"))
        let savedFrame = try object(saved)
        for result in [["kind": "identifier"], ["kind": "identifier", "id": NSNull()], ["kind": "identifier", "id": ""],
                       ["kind": "completed", "id": "extra"], ["kind": "missingEvent", "extra": true], ["kind": "unknown"]] as [[String: Any]] {
            var malformed = savedFrame; malformed["result"] = result
            invalid { try NativeCalendarPushEffect(json: json(malformed)) }
        }
        invalid { try NativeCalendarPushEffect(json: saved.encoded().replacingOccurrences(of: "\"result\":{", with: "\"result\":{\"kind\":\"identifier\",")) }
        invalid { try NativeCalendarPushEffect(json: saved.encoded().replacingOccurrences(of: "\"result\":{", with: "\"result\":{\"\\u006bind\":\"identifier\",")) }
    }

    func testDecoderValidatesPhaseResultAndAcknowledgmentCombination() throws {
        let preparedFrame = try object(prepared("updateEvent"))
        for (phase, result, after) in [("prepared", ["kind": "completed"] as Any, NSNull() as Any),
                                      ("started", NSNull(), try mappingObject()),
                                      ("saved", NSNull(), NSNull()),
                                      ("saved", ["kind": "completed"], try mappingObject()),
                                      ("acknowledging", ["kind": "completed"], NSNull()),
                                      ("acknowledging", ["kind": "identifier", "id": "event"], try mappingObject())] {
            var frame = preparedFrame; frame["phase"] = phase; frame["result"] = result; frame["afterMapping"] = after
            invalid { try NativeCalendarPushEffect(json: json(frame)) }
        }
    }
    private func mappingObject() throws -> [String: Any] {
        let saved = try prepared("updateEvent").markingStarted().recording(result: .completed)
        return try XCTUnwrap(object(saved.acknowledging(mapping: mapping(stamp: "after")))["afterMapping"] as? [String: Any])
    }

    func testCompleteEscapedRecordLimitAppliesBeforeCreationAndEveryGrowingTransition() throws {
        let limit = NativeCalendarJobs.maximumRequestBytes
        var details = event; details["notes"] = String(repeating: "\n", count: 360_000)
        let raw = try json(["op": "createEvent", "calendarId": "calendar", "details": details])
        XCTAssertLessThan(raw.utf8.count, limit)
        XCTAssertNoThrow(try NativeCalendarWriteRequest(json: raw))
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: raw, taskID: "task") }

        let base = try prepared("deleteCalendar")
        let fullRaw = base.requestJSON + String(repeating: " ", count: limit - (try base.encoded().utf8.count))
        let full = try prepared("deleteCalendar", raw: fullRaw)
        XCTAssertEqual(try full.encoded().utf8.count, limit)
        try roundtrip(full)
        invalid { try prepared("deleteCalendar", raw: fullRaw + " ") }
        invalid { try full.markingStarted().recording(result: .completed) }

        let baseSaved = try prepared("updateEvent").markingStarted().recording(result: .completed)
        let savedRaw = baseSaved.requestJSON + String(repeating: " ", count: limit - (try baseSaved.encoded().utf8.count))
        let fullSaved = try prepared("updateEvent", raw: savedRaw).markingStarted().recording(result: .completed)
        XCTAssertEqual(try fullSaved.encoded().utf8.count, limit)
        invalid { try fullSaved.acknowledging(mapping: mapping(stamp: "after")) }
    }

    func testCalendarStateRequiresExactlyFiveRawStringOrNullCellsOnlyForCalendarOperations() throws {
        let raw: [String?] = ["legacy-boolean", "calendar-e\u{301}", nil, "", "\u{FEFF}legacy"]
        for operation in ["createCalendar", "updateCalendar", "deleteCalendar"] {
            invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation)) }
            for state in [[], [nil], Array(repeating: nil, count: 6)] as [[String?]] {
                invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), beforeCalendarState: state) }
            }
            let effect = try NativeCalendarPushEffect(libraryID: "library", requestJSON: request(operation), beforeCalendarState: raw)
            let result: NativeCalendarPushEffect.Result = operation == "createCalendar" ? .identifier("created") : .completed
            for phase in [effect, try effect.markingStarted(), try effect.markingStarted().recording(result: result)] {
                XCTAssertEqual(phase.beforeCalendarState?.map { $0.map { Data($0.utf8) } }, raw.map { $0.map { Data($0.utf8) } })
                try roundtrip(phase)
            }
        }
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request("createEvent"), taskID: "task", beforeCalendarState: raw) }
        var value = try object(prepared("deleteCalendar"))
        let wrongCellTypes: [Any] = [true, NSNull(), NSNull(), NSNull(), NSNull()]
        let malformedStates: [Any] = [NSNull(), "bad", wrongCellTypes, [NSNull()]]
        for malformed in malformedStates {
            value["beforeCalendarState"] = malformed
            invalid { try NativeCalendarPushEffect(json: json(value)) }
        }
        value.removeValue(forKey: "beforeCalendarState")
        invalid { try NativeCalendarPushEffect(json: json(value)) }
        let oversized: [String?] = [String(repeating: "\n", count: 600_000), nil, nil, nil, nil]
        invalid { try NativeCalendarPushEffect(libraryID: "library", requestJSON: request("deleteCalendar"), beforeCalendarState: oversized) }
    }
}
