import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarJobsTests: XCTestCase {
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    private func events(ids: [String] = ["calendar"], start: Any = 0, end: Any = 1) throws -> String {
        try json(["op": "events", "calendarIds": ids, "startMs": start, "endMs": end])
    }
    private func reply(_ jobs: NativeCalendarJobs) throws -> (value: [String: Any], completed: Bool) {
        let answer = try XCTUnwrap(jobs.next())
        return (try XCTUnwrap(NativeJSON.jsonObject(with: Data(answer.json.utf8)) as? [String: Any]), answer.completed)
    }

    func testClosedRequestGrammarAndDuplicateMembersAreRefusedBeforeProviderCreation() throws {
        var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { factories += 1; return CalendarTestReader() }
        defer { jobs.shutdown() }
        let invalid = ["not-json", "[]", "null", "{\"op\":\"requestPermissions\"}",
                       "{\"op\":\"permissions\",\"extra\":false}", "{\"op\":\"calendars\",\"calendarIds\":[]}",
                       "{\"op\":\"permissions\",\"op\":\"permissions\"}",
                       "{\"op\":\"permissions\",\"\\u006fp\":\"permissions\"}",
                       "{\"op\":\"events\",\"calendarIds\":[],\"startMs\":0,\"startMs\":1,\"endMs\":2}",
                       "{\"op\":\"events\",\"calendarIds\":[1],\"startMs\":0,\"endMs\":1}",
                       "{\"op\":\"events\",\"calendarIds\":[],\"startMs\":0,\"endMs\":1,\"value\":{}}"]
        for input in invalid {
            XCTAssertThrowsError(try jobs.submit(input)) { error in
                XCTAssertEqual((error as? HostFailure)?.message, "Calendar request is invalid")
            }
        }
        XCTAssertEqual(factories, 0); XCTAssertEqual(jobs.counters.jobs, 0)
    }

    func testNumericDateRangeAndCalendarIDBoundaries() throws {
        let reader = CalendarTestReader(), jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        let invalidDates: [Any] = [true, "0", NSNull(), 0.5, -62_135_596_800_001, 253_402_300_800_000, 9_007_199_254_740_992]
        for value in invalidDates {
            XCTAssertThrowsError(try jobs.submit(events(start: value, end: 253_402_300_799_999)))
        }
        for (start, end) in [(0.0, 0.0), (1.0, 0.0), (0.0, 366 * 86_400_000 + 1)] {
            XCTAssertThrowsError(try jobs.submit(events(start: start, end: end)))
        }
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"events\",\"calendarIds\":[],\"startMs\":1e999,\"endMs\":2}"))
        XCTAssertThrowsError(try jobs.submit(events(ids: [""])))
        XCTAssertThrowsError(try jobs.submit(events(ids: [String(repeating: "a", count: 1025)])))
        XCTAssertThrowsError(try jobs.submit(events(ids: [String(repeating: "😀", count: 257)])))
        XCTAssertThrowsError(try jobs.submit(events(ids: Array(repeating: "x", count: 1025))))
        let allowed: [([String], Double, Double)] = [
            ([String(repeating: "😀", count: 256)], -62_135_596_800_000, -62_135_596_799_999),
            (Array(repeating: "x", count: 1024), 253_402_300_799_998, 253_402_300_799_999),
            (["calendar"], 0, 366 * 86_400_000)
        ]
        for (ids, start, end) in allowed {
            _ = try jobs.submit(events(ids: ids, start: start, end: end)); jobs.drain()
            XCTAssertTrue(try reply(jobs).completed)
            let seen = try XCTUnwrap(reader.requestedEvents)
            XCTAssertEqual(seen.ids.map { Data($0.utf8) }, ids.map { Data($0.utf8) })
            XCTAssertEqual(seen.start, Date(timeIntervalSince1970: start / 1000))
            XCTAssertEqual(seen.end, Date(timeIntervalSince1970: end / 1000))
        }
    }

    func testOuterRequestLimitCountsUTF8AndIncludesWhitespace() throws {
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { CalendarTestReader() }
        defer { jobs.shutdown() }
        let base = "{\"op\":\"permissions\"}"
        let boundary = base + String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes - base.utf8.count)
        _ = try jobs.submit(boundary); jobs.drain(); XCTAssertTrue(try reply(jobs).completed)
        XCTAssertThrowsError(try jobs.submit(boundary + " "))
    }

    func testPermissionIsPassiveAndDeniedOrUndeterminedReadsFailVisibly() throws {
        for permission in [NativeCalendarPermission.granted, .denied, .undetermined] {
            let reader = CalendarTestReader(); reader.permission = permission
            let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
            defer { jobs.shutdown() }
            _ = try jobs.submit("{\"op\":\"permissions\"}"); jobs.drain()
            let status = try reply(jobs)
            XCTAssertEqual((status.value["value"] as? [String: String])?["status"], permission.rawValue)
            XCTAssertTrue(status.completed)
            if permission != .granted {
                for request in ["{\"op\":\"calendars\"}", try events(ids: [])] {
                    _ = try jobs.submit(request); jobs.drain(); let result = try reply(jobs)
                    XCTAssertEqual(result.value["error"] as? String, "Calendar access is denied")
                    XCTAssertNil(result.value["value"]); XCTAssertFalse(result.completed)
                }
                XCTAssertFalse(reader.operations.contains("calendars")); XCTAssertFalse(reader.operations.contains("events"))
            }
        }
    }

    func testEmptyIDsSkipEventProviderAndNonemptyIDsAndInstantsRemainExact() throws {
        let reader = CalendarTestReader(), jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        _ = try jobs.submit(events(ids: [])); jobs.drain()
        XCTAssertEqual((try reply(jobs).value["value"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(reader.operations, ["permissions", "permissions"])
        let ids = [" \u{feff}calendar ", "cafe\u{301}", "caf\u{e9}"]
        _ = try jobs.submit(events(ids: ids, start: 1_793_497_800_123, end: 1_793_501_400_456)); jobs.drain()
        XCTAssertTrue(try reply(jobs).completed)
        let request = try XCTUnwrap(reader.requestedEvents)
        XCTAssertEqual(request.ids.map { Data($0.utf8) }, ids.map { Data($0.utf8) })
        XCTAssertEqual(request.start, Date(timeIntervalSince1970: 1_793_497_800.123))
        XCTAssertEqual(request.end, Date(timeIntervalSince1970: 1_793_501_400.456))
    }

    func testRetainedRepliesBoundTwoSlotsAndFIFOAndGenerationIDs() throws {
        let reader = CalendarTestReader(), jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        let first = try jobs.submit("{\"op\":\"permissions\"}"), second = try jobs.submit("{\"op\":\"calendars\"}")
        jobs.drain(); XCTAssertEqual(jobs.counters.jobs, 2); XCTAssertEqual(jobs.counters.running, 0)
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
        XCTAssertEqual(try reply(jobs).value["id"] as? String, first)
        let third = try jobs.submit("{\"op\":\"permissions\"}"); jobs.drain()
        XCTAssertEqual(try reply(jobs).value["id"] as? String, second)
        XCTAssertEqual(try reply(jobs).value["id"] as? String, third)
        XCTAssertEqual(reader.operations, ["permissions", "permissions", "calendars", "permissions", "permissions"])
        XCTAssertEqual(first.split(separator: ":").last, "1"); XCTAssertEqual(third.split(separator: ":").last, "3")
        let other = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { CalendarTestReader() }
        defer { other.shutdown() }
        XCTAssertNotEqual(try other.submit("{\"op\":\"permissions\"}"), first)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertNil(try jobs.next())
    }

    func testCompleteReplyAtByteBoundaryAndOneExtraByteFailsWithoutTruncation() throws {
        for extra in [0, 1] {
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            let reader = CalendarTestReader()
            reader.beforeRead = { operation in if operation == "calendars" { entered.signal(); release.wait() } }
            let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
            defer { jobs.shutdown() }
            let id = try jobs.submit("{\"op\":\"calendars\"}")
            XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
            let overhead = try JSONSerialization.data(withJSONObject: ["id": id, "value": [["id": "c", "title": ""]]]).count
            let title = String(repeating: "x", count: NativeCalendarJobs.maximumReplyBytes - overhead + extra)
            reader.calendarValues = [["id": "c", "title": title]]; release.signal(); jobs.drain()
            let raw = try XCTUnwrap(jobs.next())
            let answer = try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.json.utf8)) as? [String: Any])
            if extra == 0 {
                XCTAssertEqual(raw.json.utf8.count, NativeCalendarJobs.maximumReplyBytes)
                XCTAssertEqual((answer["value"] as? [[String: String]])?.first?["title"], title)
                XCTAssertTrue(raw.completed)
            } else {
                XCTAssertEqual(answer["error"] as? String, "Calendar reply exceeds the limit")
                XCTAssertNil(answer["value"]); XCTAssertFalse(raw.completed)
            }
            XCTAssertEqual(jobs.counters.jobs, 0)
        }
    }

    func testFullEventReplyRetainsUnicodeNotesAndProviderFailureIsContentFree() throws {
        let reader = CalendarTestReader(), jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        let notes = String(repeating: "\u{feff}原文\n", count: 100_000)
        reader.eventValues = [["id": "item", "calendarId": "calendar", "title": "event", "notes": notes,
                               "startDate": "2026-10-09T00:00:00.123Z", "endDate": "2026-10-10T00:00:00.123Z", "allDay": true]]
        _ = try jobs.submit(events()); jobs.drain()
        let full = try reply(jobs)
        let event = try XCTUnwrap((full.value["value"] as? [[String: Any]])?.first)
        XCTAssertEqual(event["notes"] as? String, notes); XCTAssertEqual(event["id"] as? String, "item")
        XCTAssertEqual(event["startDate"] as? String, "2026-10-09T00:00:00.123Z"); XCTAssertTrue(full.completed)
        reader.beforeRead = { _ in throw HostFailure("private calendar title and account") }
        _ = try jobs.submit("{\"op\":\"calendars\"}"); jobs.drain()
        let failure = try reply(jobs)
        XCTAssertEqual(failure.value["error"] as? String, "Calendar read failed"); XCTAssertNil(failure.value["value"])
        XCTAssertFalse(failure.completed)
    }

    func testQueuedCancellationNeverReadsAndBegunCancellationDrainsActualRead() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let reader = CalendarTestReader()
        reader.beforeRead = { operation in if operation == "events" { entered.signal(); release.wait() } }
        reader.eventValues = [["id": "late-private-result"]]
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        defer { jobs.shutdown() }
        let first = try jobs.submit(events()); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        let queued = try jobs.submit("{\"op\":\"calendars\"}")
        jobs.abort(first); jobs.abort(queued); jobs.abort("cal:foreign:1")
        XCTAssertEqual(jobs.counters.running, 2); XCTAssertNil(try jobs.next())
        release.signal(); jobs.drain()
        for id in [first, queued] {
            let result = try reply(jobs)
            XCTAssertEqual(result.value["id"] as? String, id)
            XCTAssertEqual(result.value["error"] as? String, "Calendar request cancelled")
            XCTAssertNil(result.value["value"]); XCTAssertFalse(result.completed)
        }
        XCTAssertEqual(reader.operations, ["permissions", "events", "permissions"])
    }

    func testReadFinishedBeforeCloseStillRetainsCancellationUntilReplyConsumption() throws {
        let registry = NativeAttachmentLocalRequests(), reader = CalendarTestReader()
        reader.calendarValues = [["id": "private-retained-calendar"]]
        let jobs = NativeCalendarJobs(registry: registry) { reader }
        defer { jobs.shutdown() }
        _ = try jobs.submit("{\"op\":\"calendars\"}"); jobs.drain()
        XCTAssertEqual(jobs.counters.jobs, 1); XCTAssertEqual(jobs.counters.running, 0)
        registry.close()
        let result = try reply(jobs)
        XCTAssertEqual(result.value["error"] as? String, "Calendar request cancelled")
        XCTAssertNil(result.value["value"]); XCTAssertFalse(result.completed)
        XCTAssertEqual(jobs.counters.jobs, 0)
    }

    func testRegistryCloseWaitsHeldWorkerSuppressesWakeAndRefusesAdmission() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0), registry = NativeAttachmentLocalRequests()
        let reader = CalendarTestReader()
        reader.beforeRead = { operation in if operation == "calendars" { entered.signal(); release.wait() } }
        let jobs = NativeCalendarJobs(registry: registry) { reader }
        defer { jobs.shutdown() }
        let unexpectedWake = expectation(description: "closed worker cannot publish a wake"); unexpectedWake.isInverted = true
        jobs.setWake { unexpectedWake.fulfill() }
        _ = try jobs.submit("{\"op\":\"calendars\"}"); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        registry.close()
        DispatchQueue.global().async { jobs.drain(); finished.signal() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.05), .timedOut)
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
        release.signal(); XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        let answer = try reply(jobs)
        XCTAssertEqual(answer.value["error"] as? String, "Calendar request cancelled"); XCTAssertFalse(answer.completed)
        wait(for: [unexpectedWake], timeout: 0.05)
        XCTAssertEqual(jobs.counters.jobs, 0)
    }

    func testForeignAbortDoesNotCancelAndShutdownWaitsThenClearsAllSlots() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let reader = CalendarTestReader()
        reader.beforeRead = { operation in if operation == "calendars" { entered.signal(); release.wait() } }
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { reader }
        let id = try jobs.submit("{\"op\":\"permissions\"}"); jobs.abort("sec:foreign:1"); jobs.drain()
        let permission = try reply(jobs); XCTAssertEqual(permission.value["id"] as? String, id); XCTAssertTrue(permission.completed)
        _ = try jobs.submit("{\"op\":\"calendars\"}"); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        _ = try jobs.submit("{\"op\":\"permissions\"}")
        DispatchQueue.global().async { jobs.shutdown(); finished.signal() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.running, 0)
        XCTAssertNil(try jobs.next()); XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
        XCTAssertEqual(reader.operations, ["permissions", "permissions", "calendars", "permissions"])
        jobs.shutdown()
    }
}
