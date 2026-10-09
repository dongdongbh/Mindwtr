import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class RecoveryReader: NativeCalendarRecoveryReading {
    var permission: NativeCalendarPermission = .granted
    var value: [String: Any]?
    var failure: Error?
    var beforeReturn: (() -> Void)?
    var requested: (String, String)?
    func permissions() throws -> NativeCalendarPermission { permission }
    func calendars() throws -> [[String: Any]] { [] }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { [] }
    func event(eventID: String, calendarID: String) throws -> [String: Any]? {
        requested = (eventID, calendarID)
        beforeReturn?()
        if let failure { throw failure }
        return value
    }
}

final class NativeCalendarRecoveryTests: XCTestCase {
    private func answer(_ jobs: NativeCalendarJobs) throws -> [String: Any] {
        let reply = try XCTUnwrap(jobs.next())
        return try XCTUnwrap(NativeJSON.jsonObject(with: Data(reply.json.utf8)) as? [String: Any])
    }

    func testExactLookupIsTypedOnlyAndPreservesAbsentVersusPresent() throws {
        let reader = RecoveryReader()
        var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { factories += 1; return reader }
        defer { jobs.shutdown() }
        XCTAssertThrowsError(try jobs.submit(#"{"op":"recoveryEvent","eventId":"event","calendarId":"calendar"}"#))
        XCTAssertThrowsError(try jobs.submitRecoveryEvent(eventID: "", calendarID: "calendar"))
        XCTAssertEqual(factories, 0)
        for present in [false, true] {
            reader.value = present ? ["id": " event-e\u{301} ", "calendarId": " calendar "] : nil
            _ = try jobs.submitRecoveryEvent(eventID: " event-e\u{301} ", calendarID: " calendar ")
            jobs.drain()
            let reply = try answer(jobs)
            XCTAssertNil(reply["error"])
            if present {
                XCTAssertEqual((reply["value"] as? [String: String])?["id"], " event-e\u{301} ")
            } else { XCTAssertTrue(reply["value"] is NSNull) }
            XCTAssertEqual(reader.requested?.0.utf8.map { $0 }, Array(" event-e\u{301} ".utf8))
            XCTAssertEqual(reader.requested?.1, " calendar ")
        }
    }

    func testFailureAndPermissionRevocationCannotPublishAbsence() throws {
        for revoked in [false, true] {
            let reader = RecoveryReader()
            if revoked { reader.beforeReturn = { reader.permission = .denied } }
            else { reader.failure = NativeCalendarWriteError.missingEvent }
            let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
            defer { jobs.shutdown() }
            _ = try jobs.submitRecoveryEvent(eventID: "event", calendarID: "calendar")
            jobs.drain()
            let reply = try answer(jobs)
            XCTAssertNotNil(reply["error"])
            XCTAssertNil(reply["value"])
        }
    }

    func testCancelledHeldLookupDrainsWithoutPublishingProviderValue() throws {
        let reader = RecoveryReader(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        reader.beforeReturn = { entered.signal(); release.wait() }
        reader.value = ["id": "event"]
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        let id = try jobs.submitRecoveryEvent(eventID: "event", calendarID: "calendar")
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        jobs.abort(id); release.signal(); jobs.drain()
        let reply = try answer(jobs)
        XCTAssertNotNil(reply["error"]); XCTAssertNil(reply["value"])
        XCTAssertEqual(jobs.counters.jobs, 0)
    }

    func testUpdatedEventWitnessRequiresExactIdentityBodyAndNonrecurrence() throws {
        let raw = #"{"op":"updateEvent","eventId":"event","calendarId":"calendar","details":{"title":"title","startMs":1800000000000,"endMs":1800003600000,"allDay":false,"notes":"notes","location":"place"}}"#
        let before = try NativeCalendarPushMapping(taskId: "task", calendarEventId: "event", calendarId: "calendar", platform: "ios", lastSyncedAt: "before")
        let effect = try NativeCalendarPushEffect(id: UUID(), libraryID: "library", requestJSON: raw, taskID: "task", beforeMapping: before).markingStarted()
        guard case .updateEvent(_, _, let details) = effect.request else { return XCTFail("Expected update") }
        let formatter = ISO8601DateFormatter()
        let row: [String: Any] = ["id": "event", "calendarId": "calendar", "title": "title", "notes": "notes",
            "location": "place", "allDay": false, "isRecurring": false,
            "startDate": formatter.string(from: details.start), "endDate": formatter.string(from: details.end)]
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedEvent(effect: effect, event: row))
        for (field, value) in [("id", "other" as Any), ("calendarId", "other"), ("notes", "edited"), ("isRecurring", true), ("allDay", true)] {
            var changed = row; changed[field] = value
            XCTAssertThrowsError(try NativeCalendarPushWitness.updatedEvent(effect: effect, event: changed))
        }
    }

    func testUpdatedCalendarWitnessRequiresUniqueWritableMatchingResult() throws {
        let raw = ##"{"op":"updateCalendar","calendarId":"calendar","details":{"title":"Mindwtr","color":"#aabbcc"}}"##
        let effect = try NativeCalendarPushEffect(id: UUID(), libraryID: "library", requestJSON: raw,
            beforeCalendarState: Array(repeating: nil, count: 5)).markingStarted()
        let row: [String: Any] = ["id": "calendar", "title": "Mindwtr", "color": "#AABBCC", "allowsModifications": true]
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedCalendar(effect: effect, calendars: [row]))
        for rows in [[], [row, row]] { XCTAssertThrowsError(try NativeCalendarPushWitness.updatedCalendar(effect: effect, calendars: rows)) }
        for (field, value) in [("id", "other" as Any), ("title", "edited"), ("color", "#112233"), ("allowsModifications", false)] {
            var changed = row; changed[field] = value
            XCTAssertThrowsError(try NativeCalendarPushWitness.updatedCalendar(effect: effect, calendars: [changed]))
        }
    }

    func testEventWitnessUsesProviderEmptyMetadataAndPreservesOnlyUnspecifiedUpdateURL() throws {
        let before = try NativeCalendarPushMapping(taskId: "task", calendarEventId: "event", calendarId: "calendar", platform: "ios", lastSyncedAt: "before")
        let fields: [String: Any] = ["title": "title", "startMs": 1_800_000_000_000, "endMs": 1_800_003_600_000,
                                    "allDay": false, "notes": "", "location": "", "timeZone": "UTC"]
        func effect(_ fields: [String: Any]) throws -> NativeCalendarPushEffect {
            let request: [String: Any] = ["op": "updateEvent", "eventId": "event", "calendarId": "calendar", "details": fields]
            let raw = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
            return try NativeCalendarPushEffect(libraryID: "library", requestJSON: raw, taskID: "task", beforeMapping: before).markingStarted()
        }
        let expected = try effect(fields)
        guard case .updateEvent(_, _, let details) = expected.request else { return XCTFail("Expected update") }
        let formatter = ISO8601DateFormatter()
        var row: [String: Any] = ["id": "event", "calendarId": "calendar", "title": "title", "allDay": false,
            "isRecurring": false, "startDate": formatter.string(from: details.start), "endDate": formatter.string(from: details.end),
            "timeZone": "UTC", "url": "https://example.test/existing"]
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedEvent(effect: expected, event: row))
        row["timeZone"] = "GMT"
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedEvent(effect: expected, event: row))
        row["notes"] = NSNull(); row["location"] = NSNull()
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedEvent(effect: expected, event: row))
        row["notes"] = 42
        XCTAssertThrowsError(try NativeCalendarPushWitness.updatedEvent(effect: expected, event: row))
        row["notes"] = ""
        for zone in [nil, "America/New_York"] as [String?] {
            row["timeZone"] = zone
            XCTAssertThrowsError(try NativeCalendarPushWitness.updatedEvent(effect: expected, event: row))
        }
        row["timeZone"] = "UTC"
        var requestedURL = fields; requestedURL["url"] = "https://example.test/new"
        XCTAssertThrowsError(try NativeCalendarPushWitness.updatedEvent(effect: effect(requestedURL), event: row))
        row["url"] = "https://example.test/new"
        XCTAssertNoThrow(try NativeCalendarPushWitness.updatedEvent(effect: effect(requestedURL), event: row))
    }
}
