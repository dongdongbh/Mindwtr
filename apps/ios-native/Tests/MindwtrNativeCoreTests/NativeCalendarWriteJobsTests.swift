import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class CalendarWriteJobsProvider: NativeCalendarWriting, @unchecked Sendable {
    var sourceValues = [NativeCalendarSource(id: "source-e\u{301}", name: "Source 原文", type: .local)]
    var calendarIdentifier = "calendar-e\u{301}"
    var eventIdentifier = "event-e\u{301}"
    var beforeWrite: ((String) throws -> Void)?
    private let lock = NSLock()
    private var calls: [NativeCalendarWriteRequest] = []
    private var reads: [String] = []
    var requests: [NativeCalendarWriteRequest] { lock.lock(); defer { lock.unlock() }; return calls }
    var readCalls: [String] { lock.lock(); defer { lock.unlock() }; return reads }
    private func record(_ request: NativeCalendarWriteRequest, _ operation: String) throws {
        lock.lock(); calls.append(request); lock.unlock()
        try beforeWrite?(operation)
    }
    private func read(_ operation: String) { lock.lock(); reads.append(operation); lock.unlock() }
    func permissions() throws -> NativeCalendarPermission { read("permissions"); return .granted }
    func calendars() throws -> [[String: Any]] { read("calendars"); return [] }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { read("events"); return [] }
    func sources() throws -> [NativeCalendarSource] { try record(.sources, "sources"); return sourceValues }
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String {
        try record(.createCalendar(details), "createCalendar"); return calendarIdentifier
    }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws {
        try record(.updateCalendar(calendarID, details), "updateCalendar")
    }
    func deleteCalendar(calendarID: String) throws { try record(.deleteCalendar(calendarID), "deleteCalendar") }
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String {
        try record(.createEvent(calendarID, details), "createEvent"); return eventIdentifier
    }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws {
        try record(.updateEvent(eventID, calendarID, details), "updateEvent")
    }
    func deleteEvent(eventID: String, calendarID: String) throws {
        try record(.deleteEvent(eventID, calendarID), "deleteEvent")
    }
}

final class NativeCalendarWriteJobsTests: XCTestCase {
    private func details() throws -> NativeCalendarEventDetails {
        try NativeCalendarEventDetails(title: "\u{FEFF}Calendar 原文 e\u{301}",
            start: Date(timeIntervalSince1970: 1_793_497_800.123), end: Date(timeIntervalSince1970: 1_793_501_400.456),
            allDay: false, notes: "notes 原文\nMindwtr: exact", location: "location e\u{301}",
            url: "https://example.invalid/private?synthetic-secret", timeZone: "America/New_York", endTimeZone: "Europe/London")
    }
    private func assertUnavailable(_ operation: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeCalendarWriteError, .unavailable, file: file, line: line)
        }
    }
    private func assertIdentifier(_ jobs: NativeCalendarJobs, _ id: UUID, _ expected: String,
                                  file: StaticString = #filePath, line: UInt = #line) throws {
        guard case .succeeded(.identifier(let value)) = try XCTUnwrap(jobs.writeOutcome(operationID: id), file: file, line: line) else {
            return XCTFail("Expected retained identifier", file: file, line: line)
        }
        XCTAssertEqual(Data(value.utf8), Data(expected.utf8), file: file, line: line)
    }
    private func assertFailure(_ jobs: NativeCalendarJobs, _ id: UUID, _ expected: NativeCalendarWriteError,
                               file: StaticString = #filePath, line: UInt = #line) throws {
        guard case .failed(let error) = try XCTUnwrap(jobs.writeOutcome(operationID: id), file: file, line: line) else {
            return XCTFail("Expected retained fixed failure", file: file, line: line)
        }
        XCTAssertEqual(error, expected, file: file, line: line)
    }
    private func assertNotStarted(_ jobs: NativeCalendarJobs, _ id: UUID,
                                  file: StaticString = #filePath, line: UInt = #line) throws {
        guard case .notStarted = try XCTUnwrap(jobs.writeOutcome(operationID: id), file: file, line: line) else {
            return XCTFail("Expected cancellation before provider entry", file: file, line: line)
        }
    }
    private func assertEvent(_ actual: NativeCalendarEventDetails, _ expected: NativeCalendarEventDetails,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(Data(actual.title.utf8), Data(expected.title.utf8), file: file, line: line)
        XCTAssertEqual(actual.start, expected.start, file: file, line: line)
        XCTAssertEqual(actual.end, expected.end, file: file, line: line)
        XCTAssertEqual(actual.allDay, expected.allDay, file: file, line: line)
        XCTAssertEqual(Data(actual.notes.utf8), Data(expected.notes.utf8), file: file, line: line)
        XCTAssertEqual(Data(actual.location.utf8), Data(expected.location.utf8), file: file, line: line)
        XCTAssertEqual(actual.url.map { Data($0.utf8) }, expected.url.map { Data($0.utf8) }, file: file, line: line)
        XCTAssertEqual(actual.timeZone, expected.timeZone, file: file, line: line)
        XCTAssertEqual(actual.endTimeZone, expected.endTimeZone, file: file, line: line)
    }

    func testAllSevenRequestsUseOneLazyProviderAndRetainExactTypedValuesUntilRetirement() throws {
        let provider = CalendarWriteJobsProvider()
        var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { factories += 1; return provider }
        defer { jobs.shutdown() }
        XCTAssertEqual(factories, 0)
        _ = try jobs.submit("{\"op\":\"permissions\"}"); jobs.drain()
        XCTAssertTrue(try XCTUnwrap(jobs.next()).completed)
        let create = try NativeCalendarCreateDetails(title: "title e\u{301}", color: "#aB12EF", sourceID: "source-e\u{301}")
        let update = try NativeCalendarUpdateDetails(color: "#123abc", title: "updated 原文")
        let event = try details(), calendarID = " calendar-e\u{301} ", eventID = " event-e\u{301} "
        let requests: [NativeCalendarWriteRequest] = [.sources, .createCalendar(create), .updateCalendar(calendarID, update),
            .deleteCalendar(calendarID), .createEvent(calendarID, event), .updateEvent(eventID, calendarID, event), .deleteEvent(eventID, calendarID)]
        for (index, request) in requests.enumerated() {
            let id = UUID(); try jobs.submitWrite(request, operationID: id); jobs.drain()
            let outcome = try XCTUnwrap(jobs.writeOutcome(operationID: id))
            switch (index, outcome) {
            case (0, .succeeded(.sources(let sources))):
                XCTAssertEqual(sources.count, 1)
                XCTAssertEqual(sources.map { Data($0.id.utf8) }, provider.sourceValues.map { Data($0.id.utf8) })
                XCTAssertEqual(sources.map { Data($0.name.utf8) }, provider.sourceValues.map { Data($0.name.utf8) })
                XCTAssertEqual(sources.map { $0.type.rawValue }, provider.sourceValues.map { $0.type.rawValue })
            case (1, .succeeded(.identifier(let value))): XCTAssertEqual(Data(value.utf8), Data(provider.calendarIdentifier.utf8))
            case (4, .succeeded(.identifier(let value))): XCTAssertEqual(Data(value.utf8), Data(provider.eventIdentifier.utf8))
            case (2, .succeeded(.completed)), (3, .succeeded(.completed)), (5, .succeeded(.completed)), (6, .succeeded(.completed)): break
            default: XCTFail("Unexpected typed result for request \(index)")
            }
            XCTAssertNotNil(jobs.writeOutcome(operationID: id)); XCTAssertNil(try jobs.next())
            assertUnavailable { try jobs.submitWrite(.sources, operationID: UUID()) }
            XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
            try jobs.retireWrite(operationID: id); XCTAssertNil(jobs.writeOutcome(operationID: id))
            assertUnavailable { try jobs.retireWrite(operationID: id) }
        }
        XCTAssertEqual(factories, 1); XCTAssertEqual(provider.readCalls, ["permissions"])
        let recorded = provider.requests; XCTAssertEqual(recorded.count, 7)
        guard case .sources = recorded[0], case .createCalendar(let actualCreate) = recorded[1],
              case .updateCalendar(let updateID, let actualUpdate) = recorded[2], case .deleteCalendar(let deleteID) = recorded[3],
              case .createEvent(let createID, let createEvent) = recorded[4],
              case .updateEvent(let updatedEventID, let updatedCalendarID, let updateEvent) = recorded[5],
              case .deleteEvent(let deletedEventID, let deletedCalendarID) = recorded[6] else { return XCTFail("Request variant changed") }
        XCTAssertEqual(Data(actualCreate.title.utf8), Data(create.title.utf8)); XCTAssertEqual(actualCreate.color, create.color)
        XCTAssertEqual(Data(actualCreate.sourceID.utf8), Data(create.sourceID.utf8)); XCTAssertEqual(actualUpdate.color, update.color)
        XCTAssertEqual(actualUpdate.title, update.title)
        for id in [updateID, deleteID, createID, updatedCalendarID, deletedCalendarID] { XCTAssertEqual(Data(id.utf8), Data(calendarID.utf8)) }
        for id in [updatedEventID, deletedEventID] { XCTAssertEqual(Data(id.utf8), Data(eventID.utf8)) }
        assertEvent(createEvent, event); assertEvent(updateEvent, event)
    }

    func testReadJobsAndTakenBodiesRefuseWriteAdmissionWithoutCreatingWriteSlots() throws {
        let provider = CalendarWriteJobsProvider()
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests(), readFile: { _, _ in Data("ICS".utf8) }) { provider }
        defer { jobs.shutdown() }
        let refused = UUID()
        _ = try jobs.submit("{\"op\":\"permissions\"}"); jobs.drain()
        assertUnavailable { try jobs.submitWrite(.sources, operationID: refused) }
        XCTAssertNil(jobs.writeOutcome(operationID: refused)); XCTAssertTrue(try XCTUnwrap(jobs.next()).completed)
        _ = try jobs.submit("{\"op\":\"readFile\",\"uri\":\"file:///owned.ics\"}"); jobs.drain()
        XCTAssertTrue(try XCTUnwrap(jobs.next()).completed)
        assertUnavailable { try jobs.submitWrite(.sources, operationID: refused) }
        XCTAssertNil(jobs.writeOutcome(operationID: refused)); XCTAssertEqual(try jobs.body(), Data("ICS".utf8).base64EncodedString())
        try jobs.submitWrite(.sources, operationID: refused); jobs.drain()
        XCTAssertNotNil(jobs.writeOutcome(operationID: refused)); XCTAssertEqual(provider.requests.count, 1)
        try jobs.retireWrite(operationID: refused)
    }

    func testRunningReadRefusesWriteBeforeFactoryAndReopensAfterBodyConsumption() throws {
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let provider = CalendarWriteJobsProvider(); var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests(), readFile: { _, _ in
            entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            return Data("ICS".utf8)
        }) { factories += 1; return provider }
        defer { release.signal(); jobs.shutdown() }
        _ = try jobs.submit("{\"op\":\"readFile\",\"uri\":\"file:///owned.ics\"}")
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        let id = UUID(); assertUnavailable { try jobs.submitWrite(.sources, operationID: id) }
        XCTAssertNil(jobs.writeOutcome(operationID: id)); XCTAssertEqual(factories, 0)
        release.signal(); jobs.drain(); XCTAssertTrue(try XCTUnwrap(jobs.next()).completed)
        XCTAssertEqual(try jobs.body(), Data("ICS".utf8).base64EncodedString())
        try jobs.submitWrite(.sources, operationID: id); jobs.drain()
        XCTAssertNotNil(jobs.writeOutcome(operationID: id)); XCTAssertEqual(factories, 1)
        try jobs.retireWrite(operationID: id)
    }

    func testWrongUUIDCannotInspectCancelOrRetireRunningOrCompletedWrite() throws {
        let provider = CalendarWriteJobsProvider(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        provider.beforeWrite = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
        defer { release.signal(); jobs.shutdown() }
        let id = UUID(), wrong = UUID(); try jobs.submitWrite(.createEvent("calendar", try details()), operationID: id)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        XCTAssertNil(jobs.writeOutcome(operationID: wrong)); jobs.cancelWrite(operationID: wrong)
        assertUnavailable { try jobs.retireWrite(operationID: wrong) }; assertUnavailable { try jobs.retireWrite(operationID: id) }
        assertUnavailable { try jobs.submitWrite(.sources, operationID: UUID()) }
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
        release.signal(); jobs.drain(); try assertIdentifier(jobs, id, provider.eventIdentifier)
        XCTAssertNil(jobs.writeOutcome(operationID: wrong))
        assertUnavailable { try jobs.retireWrite(operationID: wrong) }; try assertIdentifier(jobs, id, provider.eventIdentifier)
        try jobs.retireWrite(operationID: id)
    }

    func testCancellationAfterProviderEntryRetainsActualCreateIdentifierAndDrainWaits() throws {
        let provider = CalendarWriteJobsProvider(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let draining = DispatchSemaphore(value: 0), drained = DispatchSemaphore(value: 0)
        provider.beforeWrite = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
        defer { release.signal(); jobs.shutdown() }
        let id = UUID(); try jobs.submitWrite(.createEvent("calendar-e\u{301}", try details()), operationID: id)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success); jobs.cancelWrite(operationID: id)
        XCTAssertNil(jobs.writeOutcome(operationID: id))
        DispatchQueue.global().async { draining.signal(); jobs.drain(); drained.signal() }
        XCTAssertEqual(draining.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(drained.wait(timeout: .now() + 0.05), .timedOut)
        release.signal(); XCTAssertEqual(drained.wait(timeout: .now() + 2), .success)
        try assertIdentifier(jobs, id, provider.eventIdentifier)
        jobs.cancelWrite(operationID: id); try assertIdentifier(jobs, id, provider.eventIdentifier)
        XCTAssertEqual(provider.requests.count, 1); try jobs.retireWrite(operationID: id)
    }

    func testRegistryCloseAndShutdownDrainHeldWriteRetainCompletionAndSuppressWake() throws {
        let registry = NativeAttachmentLocalRequests(), provider = CalendarWriteJobsProvider()
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let shuttingDown = DispatchSemaphore(value: 0)
        provider.beforeWrite = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let jobs = NativeCalendarJobs(registry: registry) { provider }
        defer { release.signal(); jobs.shutdown() }
        let wake = expectation(description: "Closed writer cannot wake Engine"); wake.isInverted = true
        jobs.setWake { wake.fulfill() }
        let id = UUID(); try jobs.submitWrite(.createCalendar(try NativeCalendarCreateDetails(title: "Calendar", color: "#123abc", sourceID: "source")), operationID: id)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success); registry.close()
        DispatchQueue.global().async { shuttingDown.signal(); jobs.shutdown(); finished.signal() }
        XCTAssertEqual(shuttingDown.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(finished.wait(timeout: .now() + 0.05), .timedOut)
        assertUnavailable { try jobs.submitWrite(.sources, operationID: UUID()) }
        XCTAssertThrowsError(try jobs.submit("{\"op\":\"permissions\"}"))
        release.signal(); XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        try assertIdentifier(jobs, id, provider.calendarIdentifier); jobs.shutdown()
        try assertIdentifier(jobs, id, provider.calendarIdentifier); XCTAssertNil(try jobs.next())
        XCTAssertEqual(jobs.counters.jobs, 0); wait(for: [wake], timeout: 0.05)
        try jobs.retireWrite(operationID: id); XCTAssertNil(jobs.writeOutcome(operationID: id))
        assertUnavailable { try jobs.submitWrite(.sources, operationID: UUID()) }
    }

    func testCancellationBeforeProviderEntryRetainsNotStartedWithoutFactoryOrProviderCall() throws {
        for closing in [false, true] {
            let registry = NativeAttachmentLocalRequests(), provider = CalendarWriteJobsProvider()
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            var factories = 0
            let jobs = NativeCalendarJobs(registry: registry) { factories += 1; return provider }
            defer { release.signal(); jobs.shutdown() }
            jobs.beforeWriteEntry = { entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
            let id = UUID(); try jobs.submitWrite(.createEvent("calendar", try details()), operationID: id)
            XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
            if closing { registry.close() } else { jobs.cancelWrite(operationID: id) }
            release.signal(); jobs.drain(); try assertNotStarted(jobs, id)
            XCTAssertEqual(factories, 0); XCTAssertTrue(provider.requests.isEmpty)
            jobs.shutdown(); try assertNotStarted(jobs, id); try jobs.retireWrite(operationID: id)
        }
    }

    func testCancellationDuringLazyFactorySkipsProviderEntryAndRetainsNotStarted() throws {
        for closing in [false, true] {
            let registry = NativeAttachmentLocalRequests(), provider = CalendarWriteJobsProvider()
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            var factories = 0
            let jobs = NativeCalendarJobs(registry: registry) {
                factories += 1; entered.signal()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
                return provider
            }
            defer { release.signal(); jobs.shutdown() }
            let id = UUID(); try jobs.submitWrite(.createEvent("calendar", try details()), operationID: id)
            XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
            if closing { registry.close() } else { jobs.cancelWrite(operationID: id) }
            release.signal(); jobs.drain(); try assertNotStarted(jobs, id)
            XCTAssertEqual(factories, 1); XCTAssertTrue(provider.requests.isEmpty)
            try jobs.retireWrite(operationID: id)
        }
    }

    func testEveryCompletedValueSurvivesCancellationRegistryCloseAndRepeatedShutdown() throws {
        let event = try details(), update = try NativeCalendarUpdateDetails(color: "#123abc")
        let requests: [NativeCalendarWriteRequest] = [.sources, .createEvent("calendar", event), .updateCalendar("calendar", update)]
        for (index, request) in requests.enumerated() {
            let registry = NativeAttachmentLocalRequests(), provider = CalendarWriteJobsProvider()
            let jobs = NativeCalendarJobs(registry: registry) { provider }
            defer { jobs.shutdown() }
            let id = UUID(); try jobs.submitWrite(request, operationID: id); jobs.drain()
            jobs.cancelWrite(operationID: id); registry.close(); jobs.shutdown(); jobs.shutdown()
            let outcome = try XCTUnwrap(jobs.writeOutcome(operationID: id))
            switch (index, outcome) {
            case (0, .succeeded(.sources(let sources))):
                XCTAssertEqual(sources.map { Data($0.id.utf8) }, provider.sourceValues.map { Data($0.id.utf8) })
                XCTAssertEqual(sources.map { Data($0.name.utf8) }, provider.sourceValues.map { Data($0.name.utf8) })
                XCTAssertEqual(sources.map { $0.type.rawValue }, provider.sourceValues.map { $0.type.rawValue })
            case (1, .succeeded(.identifier(let value))): XCTAssertEqual(Data(value.utf8), Data(provider.eventIdentifier.utf8))
            case (2, .succeeded(.completed)): break
            default: XCTFail("Completed write was replaced during close")
            }
            XCTAssertNil(try jobs.next())
            assertUnavailable { try jobs.submitWrite(.sources, operationID: UUID()) }
            try jobs.retireWrite(operationID: id); XCTAssertNil(jobs.writeOutcome(operationID: id))
        }
    }

    func testShutdownReleasesLazyProviderWhileKeepingItsImmutableResult() throws {
        weak var provider: CalendarWriteJobsProvider?
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) {
            let created = CalendarWriteJobsProvider(); provider = created; return created
        }
        defer { jobs.shutdown() }
        let id = UUID(); try jobs.submitWrite(.sources, operationID: id); jobs.drain()
        XCTAssertNotNil(provider); jobs.shutdown(); XCTAssertNil(provider)
        guard case .succeeded(.sources(let sources)) = try XCTUnwrap(jobs.writeOutcome(operationID: id)) else {
            return XCTFail("Provider release discarded the retained result")
        }
        XCTAssertEqual(sources.count, 1); XCTAssertEqual(Data(sources[0].id.utf8), Data("source-e\u{301}".utf8))
        try jobs.retireWrite(operationID: id)
    }

    func testFixedProviderFailuresSurviveCancellationAndShutdownWithoutPrivateErrorText() throws {
        let failures: [(Error, NativeCalendarWriteError)] = [
            (NativeCalendarWriteError.denied, .denied), (NativeCalendarWriteError.unavailable, .unavailable),
            (NativeCalendarWriteError.missingCalendar, .missingCalendar), (NativeCalendarWriteError.missingSource, .missingSource),
            (NativeCalendarWriteError.missingEvent, .missingEvent), (NativeCalendarWriteError.invalid, .invalid),
            (NativeCalendarWriteError.readOnly, .readOnly), (NativeCalendarWriteError.ambiguous, .ambiguous),
            (NativeCalendarWriteError.recurring, .recurring), (NativeCalendarWriteError.failed, .failed),
            (NativeCalendarReadError.denied, .denied), (NativeCalendarReadError.unavailable, .unavailable),
            (HostFailure("private title account synthetic-secret"), .failed)]
        for (failure, expected) in failures {
            let provider = CalendarWriteJobsProvider(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            provider.beforeWrite = { _ in
                entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success); throw failure
            }
            let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
            defer { release.signal(); jobs.shutdown() }
            let id = UUID(); try jobs.submitWrite(.createEvent("calendar", try details()), operationID: id)
            XCTAssertEqual(entered.wait(timeout: .now() + 2), .success); jobs.cancelWrite(operationID: id)
            release.signal(); jobs.shutdown(); try assertFailure(jobs, id, expected)
            XCTAssertEqual(provider.requests.count, 1); try jobs.retireWrite(operationID: id)
        }
    }

    func testInvalidReturnedCalendarEventAndSourceIDsBecomeFixedFailures() throws {
        for invalid in ["", " \n\u{FEFF}", String(repeating: "é", count: 513)] {
            let provider = CalendarWriteJobsProvider()
            provider.calendarIdentifier = invalid; provider.eventIdentifier = invalid
            provider.sourceValues = [NativeCalendarSource(id: invalid, name: "private name", type: .local)]
            let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
            defer { jobs.shutdown() }
            let requests: [NativeCalendarWriteRequest] = [.sources,
                .createCalendar(try NativeCalendarCreateDetails(title: "Calendar", color: "#123abc", sourceID: "source")),
                .createEvent("calendar", try details())]
            for request in requests {
                let id = UUID(); try jobs.submitWrite(request, operationID: id); jobs.drain()
                try assertFailure(jobs, id, .failed); try jobs.retireWrite(operationID: id)
            }
            XCTAssertEqual(provider.requests.count, 3)
        }
    }

    func testReadOnlyInjectedProviderProducesRetainedUnavailableWithoutChangingReadContract() throws {
        let provider = CalendarTestReader(); var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { factories += 1; return provider }
        defer { jobs.shutdown() }
        let id = UUID(); try jobs.submitWrite(.sources, operationID: id); jobs.drain()
        guard case .failedBeforeMutation(.unavailable) = try XCTUnwrap(jobs.writeOutcome(operationID: id)) else {
            return XCTFail("Read-only provider cannot enter a mutation")
        }
        XCTAssertEqual(factories, 1); XCTAssertTrue(provider.operations.isEmpty)
        try jobs.retireWrite(operationID: id)
        _ = try jobs.submit("{\"op\":\"permissions\"}"); jobs.drain()
        XCTAssertTrue(try XCTUnwrap(jobs.next()).completed); XCTAssertEqual(provider.operations, ["permissions"])
        XCTAssertEqual(factories, 1)
    }

    func testWriteReadinessIsAdvisoryAndRefusesReadTakenBodyActiveSlotAndClosedRegistry() throws {
        let registry = NativeAttachmentLocalRequests(), provider = CalendarWriteJobsProvider()
        let jobs = NativeCalendarJobs(registry: registry, readFile: { _, _ in Data("synthetic".utf8) }) { provider }
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        defer { release.signal(); jobs.shutdown() }
        XCTAssertTrue(jobs.writeAdmissionAvailable)
        _ = try jobs.submit("{\"op\":\"permissions\"}")
        XCTAssertFalse(jobs.writeAdmissionAvailable); jobs.drain()
        XCTAssertFalse(jobs.writeAdmissionAvailable)
        _ = try jobs.next(); XCTAssertTrue(jobs.writeAdmissionAvailable)
        _ = try jobs.submit("{\"op\":\"readFile\",\"uri\":\"synthetic\"}"); jobs.drain()
        _ = try jobs.next(); XCTAssertFalse(jobs.writeAdmissionAvailable)
        _ = try jobs.body(); XCTAssertTrue(jobs.writeAdmissionAvailable)
        provider.beforeWrite = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let id = UUID(); try jobs.submitWrite(.sources, operationID: id)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        XCTAssertFalse(jobs.writeAdmissionAvailable)
        release.signal(); jobs.drain(); XCTAssertFalse(jobs.writeAdmissionAvailable)
        try jobs.retireWrite(operationID: id); XCTAssertTrue(jobs.writeAdmissionAvailable)
        registry.close(); XCTAssertFalse(jobs.writeAdmissionAvailable)
        jobs.shutdown(); XCTAssertFalse(jobs.writeAdmissionAvailable)
    }

    func testWakeRunsOutsideSlotLockAndCanPeekWithoutConsumingCompletion() throws {
        let provider = CalendarWriteJobsProvider(), jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
        defer { jobs.shutdown() }
        let id = UUID(), woke = expectation(description: "Peek from wake does not deadlock worker")
        jobs.setWake { XCTAssertNotNil(jobs.writeOutcome(operationID: id)); woke.fulfill() }
        try jobs.submitWrite(.createEvent("calendar", try details()), operationID: id)
        wait(for: [woke], timeout: 2); jobs.drain(); try assertIdentifier(jobs, id, provider.eventIdentifier)
        try jobs.retireWrite(operationID: id)
    }

    func testRetiredGenerationCannotCancelOrRetireNewGenerationWrite() throws {
        let old = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { CalendarWriteJobsProvider() }
        let oldID = UUID(); try old.submitWrite(.sources, operationID: oldID); old.drain(); old.shutdown()
        defer { old.shutdown() }
        let provider = CalendarWriteJobsProvider(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        provider.beforeWrite = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let current = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { provider }
        defer { release.signal(); current.shutdown() }
        let currentID = UUID(); try current.submitWrite(.createEvent("calendar", try details()), operationID: currentID)
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        XCTAssertNil(old.writeOutcome(operationID: currentID)); old.cancelWrite(operationID: currentID)
        assertUnavailable { try old.retireWrite(operationID: currentID) }; try old.retireWrite(operationID: oldID)
        current.cancelWrite(operationID: oldID); assertUnavailable { try current.retireWrite(operationID: oldID) }
        release.signal(); current.drain(); try assertIdentifier(current, currentID, provider.eventIdentifier)
        try current.retireWrite(operationID: currentID)
    }

    func testAllWriterGrammarRemainsRefusedByGenericReadBridgeBeforeFactory() throws {
        var factories = 0
        let jobs = NativeCalendarJobs(registry: NativeAttachmentLocalRequests()) { factories += 1; return CalendarWriteJobsProvider() }
        defer { jobs.shutdown() }
        let event: [String: Any] = ["title": "Event", "startMs": 0, "endMs": 1, "allDay": false, "notes": "", "location": ""]
        let values: [[String: Any]] = [["op": "sources"],
            ["op": "createCalendar", "details": ["title": "Calendar", "color": "#123abc", "entityType": "event", "sourceId": "source"]],
            ["op": "updateCalendar", "calendarId": "calendar", "details": ["color": "#123abc"]],
            ["op": "deleteCalendar", "calendarId": "calendar"], ["op": "createEvent", "calendarId": "calendar", "details": event],
            ["op": "updateEvent", "eventId": "event", "calendarId": "calendar", "details": event],
            ["op": "deleteEvent", "eventId": "event", "calendarId": "calendar"]]
        for value in values {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
            _ = try NativeCalendarWriteRequest(json: json)
            XCTAssertThrowsError(try jobs.submit(json)) { XCTAssertEqual(($0 as? HostFailure)?.message, "Calendar request is invalid") }
        }
        XCTAssertEqual(factories, 0); XCTAssertEqual(jobs.counters.jobs, 0)
    }
}
