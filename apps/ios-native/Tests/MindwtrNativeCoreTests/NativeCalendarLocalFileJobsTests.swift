import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCalendarLocalFileJobsTests: XCTestCase {
    private func request(_ uri: String = "file:///native-owned/calendar.ics") throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: ["op": "readFile", "uri": uri], options: [.sortedKeys]), as: UTF8.self)
    }
    private func answer(_ jobs: NativeCalendarJobs) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(XCTUnwrap(jobs.next()).json.utf8)) as? [String: Any])
    }
    private func jobs(_ registry: NativeAttachmentLocalRequests = NativeAttachmentLocalRequests(),
                      read: @escaping (String, NativeAttachmentCancellation) throws -> Data) -> NativeCalendarJobs {
        NativeCalendarJobs(registry: registry, readFile: read, readerFactory: {
            XCTFail("File-only Calendar work must not construct EventKit"); return CalendarTestReader()
        })
    }

    func testClosedFileGrammarDuplicatesUTF16AndActualRequestLimitBeforeRead() throws {
        var reads = 0
        let jobs = jobs { _, _ in reads += 1; return Data() }; defer { jobs.shutdown() }
        let invalid = try ["[]", "{\"op\":\"readFile\"}", "{\"op\":\"readFile\",\"uri\":true}",
            "{\"op\":\"readFile\",\"uri\":\"a\",\"uri\":\"a\"}", "{\"op\":\"readFile\",\"uri\":\"a\",\"\\u0075ri\":\"a\"}",
            "{\"op\":\"readFile\",\"uri\":\"a\",\"path\":\"a\"}", request(String(repeating: "😀", count: 2001))]
        for raw in invalid { XCTAssertThrowsError(try jobs.submit(raw)) }
        XCTAssertEqual(reads, 0); XCTAssertEqual(jobs.counters.jobs, 0)
        let raw = try request(String(repeating: "😀", count: 2000))
        let boundary = raw + String(repeating: " ", count: NativeCalendarJobs.maximumRequestBytes - raw.utf8.count)
        _ = try jobs.submit(boundary); jobs.drain(); XCTAssertEqual(try answer(jobs)["body"] as? Bool, true)
        XCTAssertEqual(try jobs.body(), ""); XCTAssertEqual(reads, 1)
        XCTAssertThrowsError(try jobs.submit(boundary + " ")); XCTAssertEqual(reads, 1)
    }

    func testEightMiBEscapedBytesUseSeparateBodyAndRetainTwoSlotsUntilConsumption() throws {
        let bytes = Data(repeating: 1, count: 8 * 1024 * 1024)
        let jobs = jobs { _, token in try token.check(); return bytes }; defer { jobs.shutdown() }
        let first = try jobs.submit(request()), second = try jobs.submit(request())
        jobs.drain(); XCTAssertEqual(jobs.counters.jobs, 2); XCTAssertThrowsError(try jobs.submit(request()))
        let metadata = try XCTUnwrap(jobs.next()); XCTAssertLessThan(metadata.json.utf8.count, 256); XCTAssertTrue(metadata.completed)
        let header = try XCTUnwrap(NativeJSON.jsonObject(with: Data(metadata.json.utf8)) as? [String: Any])
        XCTAssertEqual(header["id"] as? String, first); XCTAssertEqual(header["body"] as? Bool, true)
        XCTAssertNil(header["value"]); XCTAssertNil(header["base64"]); XCTAssertNil(try jobs.next())
        XCTAssertEqual(jobs.counters.jobs, 2); XCTAssertEqual(Data(base64Encoded: try jobs.body()), bytes)
        XCTAssertEqual(jobs.counters.jobs, 1); XCTAssertThrowsError(try jobs.body())
        XCTAssertEqual(try answer(jobs)["id"] as? String, second); XCTAssertEqual(Data(base64Encoded: try jobs.body()), bytes)
        XCTAssertEqual(jobs.counters.jobs, 0)
        let oversized = self.jobs { _, _ in Data(repeating: 1, count: 8 * 1024 * 1024 + 1) }; defer { oversized.shutdown() }
        _ = try oversized.submit(request()); oversized.drain()
        XCTAssertNotNil(try answer(oversized)["error"]); XCTAssertThrowsError(try oversized.body()); XCTAssertEqual(oversized.counters.jobs, 0)
    }

    func testQueuedAbortAndHeldReadDrainWithoutLateBodyOrNextRead() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        var reads = 0
        let jobs = jobs { _, token in reads += 1; entered.signal(); release.wait(); try token.check(); return Data("private late bytes".utf8) }
        defer { release.signal(); jobs.shutdown() }
        let first = try jobs.submit(request()); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        let queued = try jobs.submit(request()); jobs.abort(first); jobs.abort(queued)
        DispatchQueue.global().async { jobs.drain(); drained.signal() }
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut); XCTAssertNil(try jobs.next())
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 2), .success)
        for identifier in [first, queued] {
            let result = try answer(jobs); XCTAssertEqual(result["id"] as? String, identifier)
            XCTAssertEqual(result["error"] as? String, "Calendar request cancelled"); XCTAssertNil(result["body"])
        }
        XCTAssertEqual(reads, 1); XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertThrowsError(try jobs.body())
    }

    func testCancellationAfterMetadataRefusesBodyAndReleasesExactlyOnce() throws {
        for close in [false, true] {
            let registry = NativeAttachmentLocalRequests(), jobs = jobs(registry) { _, _ in Data("private bytes".utf8) }
            defer { jobs.shutdown() }
            let id = try jobs.submit(request()); jobs.drain()
            XCTAssertEqual(try answer(jobs)["body"] as? Bool, true); XCTAssertEqual(jobs.counters.jobs, 1)
            if close { registry.close() } else { jobs.abort(id) }
            XCTAssertThrowsError(try jobs.body()); XCTAssertEqual(jobs.counters.jobs, 0)
            XCTAssertThrowsError(try jobs.body()); XCTAssertNil(try jobs.next())
        }
    }

    func testShutdownWaitsActualReadAndDropsRetainedBodyWithoutPrivateError() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let jobs = jobs { _, _ in entered.signal(); release.wait(); throw HostFailure("private file path and content") }
        defer { release.signal(); jobs.shutdown() }
        _ = try jobs.submit(request()); XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async { jobs.shutdown(); finished.signal() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertNil(try jobs.next()); XCTAssertThrowsError(try jobs.body()); XCTAssertEqual(jobs.counters.jobs, 0)
        XCTAssertThrowsError(try jobs.submit(request()))
        let failed = self.jobs { _, _ in throw HostFailure("private file path and content") }; defer { failed.shutdown() }
        _ = try failed.submit(request()); failed.drain()
        let failure = try answer(failed); XCTAssertEqual(failure["error"] as? String, "Calendar read failed")
        XCTAssertFalse(try String(decoding: JSONSerialization.data(withJSONObject: failure), as: UTF8.self).contains("private"))
    }
}
