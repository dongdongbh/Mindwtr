import Foundation
import XCTest
@testable import MindwtrNativeCore

private final class WriteTestSource {
    var value: NativeCalendarSource
    init(_ id: String = "source", type: NativeCalendarSourceType = .local) {
        value = NativeCalendarSource(id: id, name: "PRIVATE_ACCOUNT", type: type)
    }
}
private final class WriteTestCalendar {
    var value: NativeCalendarWriteTarget
    init(_ id: String = "calendar", writable: Bool = true, events: Bool = true, immutable: Bool = false) {
        value = NativeCalendarWriteTarget(id: id, allowsEvents: events, allowsModifications: writable, immutable: immutable)
    }
}
private final class WriteTestEvent {
    var value: NativeCalendarWriteEventIdentity?
    init(_ id: String = "event", calendarID: String = "calendar", recurring: Bool = false) {
        value = NativeCalendarWriteEventIdentity(id: id, calendarID: calendarID, recurring: recurring)
    }
}
private final class WriteTestProvider: NativeCalendarWriteProviding {
    var permissionReplies: [NativeCalendarPermission] = [.granted]
    var sourceValues = [WriteTestSource()]
    var calendarValues = [WriteTestCalendar()]
    var eventValues = [WriteTestEvent()]
    var calendarResult = "created-calendar"
    var eventResult = "created-event"
    var calendarFailure: Error?
    var eventFailure: Error?
    var mutationFailure: Error?
    var failAt: Int?
    var beforeOperation: ((Int) -> Void)?
    private(set) var operations: [String] = []
    private(set) var selectedSource: WriteTestSource?
    private(set) var selectedCalendar: WriteTestCalendar?
    private(set) var selectedEvent: WriteTestEvent?
    private(set) var calendarDetails: NativeCalendarCreateDetails?
    private(set) var updateDetails: NativeCalendarUpdateDetails?
    private(set) var eventDetails: NativeCalendarEventDetails?
    private(set) var requestedEventID: String?
    private struct PrivateProviderFailure: LocalizedError {
        var errorDescription: String? { "PRIVATE_TASK PRIVATE_ACCOUNT PRIVATE_LOCATION PRIVATE_URL" }
    }
    private func record(_ operation: String) throws {
        operations.append(operation); beforeOperation?(operations.count)
        if failAt == operations.count { throw PrivateProviderFailure() }
        if operation.hasPrefix("write:"), let mutationFailure { throw mutationFailure }
    }
    var writes: [String] { operations.filter { $0.hasPrefix("write:") } }
    func permissions() throws -> NativeCalendarPermission {
        try record("permissions")
        return permissionReplies.count > 1 ? permissionReplies.removeFirst() : permissionReplies[0]
    }
    func sources() throws -> [WriteTestSource] { try record("sources"); return sourceValues }
    func source(_ value: WriteTestSource) -> NativeCalendarSource { value.value }
    func calendars() throws -> [WriteTestCalendar] {
        try record("calendars")
        if let calendarFailure { throw calendarFailure }
        return calendarValues
    }
    func target(_ value: WriteTestCalendar) -> NativeCalendarWriteTarget { value.value }
    func events(eventID: String, calendar: WriteTestCalendar) throws -> [WriteTestEvent] {
        requestedEventID = eventID; selectedCalendar = calendar
        try record("events")
        if let eventFailure { throw eventFailure }
        return eventValues
    }
    func identity(_ value: WriteTestEvent) -> NativeCalendarWriteEventIdentity? { value.value }
    func createCalendar(_ details: NativeCalendarCreateDetails, source: WriteTestSource) throws -> String {
        try record("write:createCalendar"); selectedSource = source; calendarDetails = details; return calendarResult
    }
    func updateCalendar(_ details: NativeCalendarUpdateDetails, calendar: WriteTestCalendar) throws {
        try record("write:updateCalendar"); selectedCalendar = calendar; updateDetails = details
    }
    func deleteCalendar(_ calendar: WriteTestCalendar) throws {
        try record("write:deleteCalendar"); selectedCalendar = calendar
    }
    func createEvent(_ details: NativeCalendarEventDetails, calendar: WriteTestCalendar) throws -> String {
        try record("write:createEvent"); selectedCalendar = calendar; eventDetails = details; return eventResult
    }
    func updateEvent(_ details: NativeCalendarEventDetails, event: WriteTestEvent) throws {
        try record("write:updateEvent"); selectedEvent = event; eventDetails = details
    }
    func deleteEvent(_ event: WriteTestEvent) throws { try record("write:deleteEvent"); selectedEvent = event }
}

final class NativeCalendarWriterTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_791_550_800)
    private var end: Date { start.addingTimeInterval(3_600) }
    private enum Operation: CaseIterable, Equatable {
        case sources, createCalendar, updateCalendar, deleteCalendar, createEvent, updateEvent, deleteEvent
    }
    private func create(title: String = "PRIVATE_CALENDAR", color: String = "#3B82F6", source: String = "source") throws -> NativeCalendarCreateDetails {
        try NativeCalendarCreateDetails(title: title, color: color, sourceID: source)
    }
    private func details(title: String = "PRIVATE_TASK", start: Date? = nil, end: Date? = nil,
                         notes: String = "PRIVATE_NOTES", location: String = "PRIVATE_LOCATION", url: String? = nil,
                         timeZone: String? = nil, endTimeZone: String? = nil, allDay: Bool = false) throws -> NativeCalendarEventDetails {
        try NativeCalendarEventDetails(title: title, start: start ?? self.start, end: end ?? self.end, allDay: allDay,
            notes: notes, location: location, url: url, timeZone: timeZone, endTimeZone: endTimeZone)
    }
    private func run(_ operation: Operation, _ provider: WriteTestProvider, calendarID: String = "calendar", eventID: String = "event",
                     beforeProviderMutation: () -> Void = {}, confirmedMissingEvent: () -> Void = {}) throws {
        switch operation {
        case .sources: _ = try NativeCalendarWritePolicy.sources(provider)
        case .createCalendar: _ = try NativeCalendarWritePolicy.createCalendar(create(), using: provider, beforeProviderMutation: beforeProviderMutation)
        case .updateCalendar:
            try NativeCalendarWritePolicy.updateCalendar(calendarID: calendarID, details: NativeCalendarUpdateDetails(color: "#2563EB"), using: provider, beforeProviderMutation: beforeProviderMutation)
        case .deleteCalendar: try NativeCalendarWritePolicy.deleteCalendar(calendarID: calendarID, using: provider, beforeProviderMutation: beforeProviderMutation)
        case .createEvent: _ = try NativeCalendarWritePolicy.createEvent(calendarID: calendarID, details: details(), using: provider, beforeProviderMutation: beforeProviderMutation)
        case .updateEvent: try NativeCalendarWritePolicy.updateEvent(eventID: eventID, calendarID: calendarID, details: details(), using: provider,
            beforeProviderMutation: beforeProviderMutation, confirmedMissingEvent: confirmedMissingEvent)
        case .deleteEvent: try NativeCalendarWritePolicy.deleteEvent(eventID: eventID, calendarID: calendarID, using: provider,
            beforeProviderMutation: beforeProviderMutation, confirmedMissingEvent: confirmedMissingEvent)
        }
    }
    private func assertError<T>(_ expected: NativeCalendarWriteError, file: StaticString = #filePath, line: UInt = #line,
                                _ operation: () throws -> T) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeCalendarWriteError, expected, file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("PRIVATE_"), file: file, line: line)
        }
    }

    func testMutationWitnessRunsOnlyAfterFinalPolicyChecksBeforeAnyProviderMutation() throws {
        for operation in Operation.allCases {
            let provider = WriteTestProvider(); var entries = 0, absences = 0
            try run(operation, provider, beforeProviderMutation: {
                entries += 1; XCTAssertTrue(provider.writes.isEmpty)
                XCTAssertEqual(provider.operations.last, "permissions")
            }, confirmedMissingEvent: { absences += 1 })
            XCTAssertEqual(entries, operation == .sources ? 0 : 1)
            XCTAssertEqual(provider.writes.count, entries); XCTAssertEqual(absences, 0)
        }
    }

    func testAbsenceWitnessRequiresSuccessfulNilLookupAndNeverAThrownMissingEvent() throws {
        for operation in [Operation.updateEvent, .deleteEvent] {
            for missingCalendar in [false, true] {
                let provider = WriteTestProvider(); var entries = 0, absences = 0
                if missingCalendar { provider.calendarValues = [] } else { provider.eventValues = [] }
                assertError(.missingEvent) { try run(operation, provider,
                    beforeProviderMutation: { entries += 1 }, confirmedMissingEvent: { absences += 1 }) }
                XCTAssertEqual(entries, 0); XCTAssertEqual(absences, 1); XCTAssertTrue(provider.writes.isEmpty)
            }
            for failure in [NativeCalendarWriteError.missingEvent, .missingCalendar, .denied, .unavailable, .failed] {
                let provider = WriteTestProvider(); provider.eventFailure = failure
                var entries = 0, absences = 0
                assertError(failure) { try run(operation, provider,
                    beforeProviderMutation: { entries += 1 }, confirmedMissingEvent: { absences += 1 }) }
                XCTAssertEqual(entries, 0); XCTAssertEqual(absences, 0)
                provider.eventFailure = nil; provider.calendarFailure = failure
                assertError(failure) { try run(operation, provider,
                    beforeProviderMutation: { entries += 1 }, confirmedMissingEvent: { absences += 1 }) }
                XCTAssertEqual(entries, 0); XCTAssertEqual(absences, 0); XCTAssertTrue(provider.writes.isEmpty)
            }
        }
    }

    func testEveryThrowingPreflightReadLeavesMutationAndAbsenceWitnessUnset() throws {
        for operation in Operation.allCases {
            let baseline = WriteTestProvider(); try run(operation, baseline)
            let readCount = baseline.operations.firstIndex(where: { $0.hasPrefix("write:") }) ?? baseline.operations.count
            for position in 1...readCount {
                let provider = WriteTestProvider(); provider.failAt = position
                var entries = 0, absences = 0
                assertError(.failed) { try run(operation, provider, beforeProviderMutation: { entries += 1 },
                                               confirmedMissingEvent: { absences += 1 }) }
                XCTAssertEqual(entries, 0); XCTAssertEqual(absences, 0); XCTAssertTrue(provider.writes.isEmpty)
            }
        }
    }

    func testRecoveryLookupDistinguishesConfirmedAbsenceFromProviderFailure() throws {
        let provider = WriteTestProvider()
        let found = try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider)
        XCTAssertTrue(found === provider.eventValues[0])
        provider.eventValues = []
        XCTAssertNil(try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider))
        provider.eventFailure = NativeCalendarWriteError.missingEvent
        assertError(.missingEvent) { try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider) }
        provider.calendarValues = []
        XCTAssertNil(try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider))
        provider.calendarFailure = NativeCalendarWriteError.missingCalendar
        assertError(.missingCalendar) { try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider) }
        XCTAssertTrue(provider.writes.isEmpty)
    }

    func testRecoveryLookupRefusesRevokedPermissionAndForeignOrRecurringEvents() throws {
        let provider = WriteTestProvider()
        provider.permissionReplies = [.granted, .granted, .granted, .denied]
        assertError(.denied) { try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider) }
        provider.permissionReplies = [.granted]
        for event in [WriteTestEvent(calendarID: "other"), WriteTestEvent(recurring: true)] {
            provider.eventValues = [event]
            XCTAssertThrowsError(try NativeCalendarWritePolicy.existingEvent(eventID: "event", calendarID: "calendar", using: provider))
        }
        XCTAssertTrue(provider.writes.isEmpty)
    }

    func testTypedDetailsRejectInvalidFieldsDatesColorsAndExternalSchemes() throws {
        for title in ["", " \n\t", "\u{feff}"] {
            assertError(.invalid) { try create(title: title) }
            assertError(.invalid) { try NativeCalendarUpdateDetails(color: "#3B82F6", title: title) }
            assertError(.invalid) { try details(title: title) }
        }
        for color in ["", "red", "#123", "#12345678", "#12G456", " #123456", "#123456 "] {
            assertError(.invalid) { try create(color: color) }
            assertError(.invalid) { try NativeCalendarUpdateDetails(color: color) }
        }
        _ = try create(color: "#aB09fF")
        let minimum = Date(timeIntervalSince1970: -62_135_596_800)
        let maximum = Date(timeIntervalSince1970: 253_402_300_799.999)
        _ = try details(start: minimum, end: minimum.addingTimeInterval(1))
        _ = try details(start: maximum.addingTimeInterval(-1), end: maximum)
        for date in [Date(timeIntervalSince1970: .nan), Date(timeIntervalSince1970: .infinity),
                     Date(timeIntervalSince1970: -.infinity), minimum.addingTimeInterval(-1), maximum.addingTimeInterval(1)] {
            assertError(.invalid) { try details(start: date) }
            assertError(.invalid) { try details(end: date) }
        }
        assertError(.invalid) { try details(end: start) }
        assertError(.invalid) { try details(end: start.addingTimeInterval(-1)) }
        for zone in ["", "PRIVATE_INVALID_ZONE", String(repeating: "x", count: 1_048_577)] {
            assertError(.invalid) { try details(timeZone: zone) }
            assertError(.invalid) { try details(endTimeZone: zone) }
        }
        for url in ["", "mindwtr://task/private", "file:///private.ics", "javascript:private", "ftp://example.invalid", "https://example.invalid/\nprivate"] {
            assertError(.invalid) { try details(url: url) }
        }
        for url in ["https://example.invalid/private", "HTTP://example.invalid/private", "mailto:private@example.invalid"] {
            _ = try details(url: url, timeZone: "America/New_York", endTimeZone: "Asia/Shanghai")
        }
    }

    func testUTF8IDBoundsPreservePaddingAndRefuseBeforeAnyProviderOperation() throws {
        for id in ["", " \n\t", "\u{feff}", String(repeating: "a", count: 1025), String(repeating: "é", count: 513)] {
            assertError(.invalid) { try create(source: id) }
            for operation in [Operation.updateCalendar, .deleteCalendar, .createEvent, .updateEvent, .deleteEvent] {
                let provider = WriteTestProvider()
                assertError(.invalid) { try run(operation, provider, calendarID: id) }
                XCTAssertTrue(provider.operations.isEmpty)
            }
            for operation in [Operation.updateEvent, .deleteEvent] {
                let provider = WriteTestProvider()
                assertError(.invalid) { try run(operation, provider, eventID: id) }
                XCTAssertTrue(provider.operations.isEmpty)
            }
        }
        _ = try create(source: String(repeating: "é", count: 512))
        let raw = " \u{feff}cafe\u{301} "
        let provider = WriteTestProvider(); provider.sourceValues = [WriteTestSource(raw)]
        _ = try NativeCalendarWritePolicy.createCalendar(create(source: raw), using: provider)
        XCTAssertEqual(Data(try XCTUnwrap(provider.calendarDetails).sourceID.utf8), Data(raw.utf8))
    }

    func testEscapedAndAggregateFieldsRespectOneMiBIncludingTargetIDs() throws {
        let limit = NativeCalendarJobs.maximumRequestBytes
        _ = try details(notes: String(repeating: "a", count: limit - 2000))
        assertError(.invalid) { try details(notes: String(repeating: "a", count: limit)) }
        assertError(.invalid) { try details(notes: String(repeating: "\u{1}", count: 200_000)) }
        assertError(.invalid) { try details(notes: String(repeating: "🙂", count: 262_145)) }
        assertError(.invalid) { try details(notes: String(repeating: "a", count: 600_000), location: String(repeating: "b", count: 600_000)) }
        assertError(.invalid) { try create(title: String(repeating: "\u{1}", count: 200_000)) }

        // Find the actual typed-detail ceiling, then add the maximum target ID.
        var lower = 0, upper = limit
        while lower + 1 < upper {
            let middle = (lower + upper) / 2
            if (try? details(notes: String(repeating: "a", count: middle))) != nil { lower = middle }
            else { upper = middle }
        }
        let boundary = try details(notes: String(repeating: "a", count: lower))
        let provider = WriteTestProvider()
        assertError(.invalid) {
            try NativeCalendarWritePolicy.createEvent(calendarID: String(repeating: "c", count: 1024), details: boundary, using: provider)
        }
        XCTAssertTrue(provider.operations.isEmpty)
    }

    func testExactSourceCalendarAndEventBytesSelectOnlyTheRetainedHandles() throws {
        let composed = "caf\u{e9}", decomposed = "cafe\u{301}"
        XCTAssertEqual(composed, decomposed)
        let provider = WriteTestProvider(), exactSource = WriteTestSource(decomposed), exactCalendar = WriteTestCalendar(decomposed)
        provider.sourceValues = [WriteTestSource(composed), exactSource]
        provider.calendarValues = [WriteTestCalendar(composed), exactCalendar]
        provider.eventValues = [WriteTestEvent(decomposed, calendarID: decomposed)]
        provider.calendarResult = " \u{feff}created-cafe\u{301} "
        provider.eventResult = " created-event\u{301} "
        let calendarID = try NativeCalendarWritePolicy.createCalendar(create(source: decomposed), using: provider)
        XCTAssertEqual(Data(calendarID.utf8), Data(provider.calendarResult.utf8))
        XCTAssertTrue(provider.selectedSource === exactSource)
        let eventID = try NativeCalendarWritePolicy.createEvent(calendarID: decomposed, details: details(), using: provider)
        XCTAssertEqual(Data(eventID.utf8), Data(provider.eventResult.utf8))
        XCTAssertTrue(provider.selectedCalendar === exactCalendar)
        try NativeCalendarWritePolicy.updateEvent(eventID: decomposed, calendarID: decomposed, details: details(), using: provider)
        XCTAssertTrue(provider.selectedEvent === provider.eventValues[0])
        XCTAssertEqual(Data(try XCTUnwrap(provider.requestedEventID).utf8), Data(decomposed.utf8))
        let other = WriteTestProvider(); other.calendarValues = [WriteTestCalendar(composed)]
        assertError(.missingCalendar) { try NativeCalendarWritePolicy.deleteCalendar(calendarID: decomposed, using: other) }
        XCTAssertTrue(other.writes.isEmpty)
    }

    func testSuccessfulOperationsPreserveFieldsOptionalTitleAndIOSAllDayInterval() throws {
        let provider = WriteTestProvider()
        let midnight = Date(timeIntervalSince1970: 1_791_504_000), lastSecond = midnight.addingTimeInterval(86_399)
        let event = try details(start: midnight, end: lastSecond, url: "https://example.invalid/private",
            timeZone: "America/New_York", endTimeZone: "Asia/Shanghai", allDay: true)
        _ = try NativeCalendarWritePolicy.createEvent(calendarID: "calendar", details: event, using: provider)
        let saved = try XCTUnwrap(provider.eventDetails)
        XCTAssertEqual(saved.start, midnight); XCTAssertEqual(saved.end, lastSecond); XCTAssertTrue(saved.allDay)
        XCTAssertEqual(saved.title, "PRIVATE_TASK"); XCTAssertEqual(saved.notes, "PRIVATE_NOTES")
        XCTAssertEqual(saved.location, "PRIVATE_LOCATION"); XCTAssertEqual(saved.url, event.url)
        XCTAssertEqual(saved.timeZone, event.timeZone); XCTAssertEqual(saved.endTimeZone, event.endTimeZone)
        try NativeCalendarWritePolicy.updateCalendar(calendarID: "calendar", details: NativeCalendarUpdateDetails(color: "#2563EB"), using: provider)
        XCTAssertNil(provider.updateDetails?.title)
        try NativeCalendarWritePolicy.updateCalendar(calendarID: "calendar", details: NativeCalendarUpdateDetails(color: "#059669", title: "Mindwtr"), using: provider)
        XCTAssertEqual(provider.updateDetails?.title, "Mindwtr")
        for operation in Operation.allCases {
            let fresh = WriteTestProvider(); try run(operation, fresh)
            XCTAssertEqual(fresh.writes.count, operation == .sources ? 0 : 1)
        }
    }

    func testEveryOperationRequiresFullAccessInitiallyAndImmediatelyBeforeEffects() throws {
        for operation in Operation.allCases {
            for permission in [NativeCalendarPermission.denied, .undetermined] {
                let provider = WriteTestProvider(); provider.permissionReplies = [permission]
                assertError(.denied) { try run(operation, provider) }
                XCTAssertEqual(provider.operations, ["permissions"])
                XCTAssertTrue(provider.writes.isEmpty)
            }
            let successful = WriteTestProvider(); try run(operation, successful)
            let checks = successful.operations.filter { $0 == "permissions" }.count
            for grantedCount in 1..<checks {
                let provider = WriteTestProvider()
                provider.permissionReplies = Array(repeating: .granted, count: grantedCount) + [.denied]
                assertError(.denied) { try run(operation, provider) }
                XCTAssertTrue(provider.writes.isEmpty)
            }
        }
    }

    func testMissingDuplicateAndUnsupportedSourcesNeverFallBack() throws {
        for values in [[], [WriteTestSource("other")]] as [[WriteTestSource]] {
            let provider = WriteTestProvider(); provider.sourceValues = values
            assertError(.missingSource) { try NativeCalendarWritePolicy.createCalendar(create(), using: provider) }
            XCTAssertTrue(provider.writes.isEmpty)
        }
        let duplicate = WriteTestProvider(); duplicate.sourceValues = [WriteTestSource(), WriteTestSource()]
        assertError(.ambiguous) { try NativeCalendarWritePolicy.createCalendar(create(), using: duplicate) }
        for type in [NativeCalendarSourceType.subscribed, .birthdays, .unknown] {
            let provider = WriteTestProvider(); provider.sourceValues = [WriteTestSource(type: type), WriteTestSource("other")]
            assertError(.invalid) { try NativeCalendarWritePolicy.createCalendar(create(), using: provider) }
            XCTAssertTrue(provider.writes.isEmpty)
        }
        for type in [NativeCalendarSourceType.local, .exchange, .caldav, .mobileme] {
            let provider = WriteTestProvider(); provider.sourceValues = [WriteTestSource(type: type)]
            _ = try NativeCalendarWritePolicy.createCalendar(create(), using: provider)
            XCTAssertEqual(provider.writes.count, 1)
        }
    }

    func testMissingAmbiguousReadOnlyAndReminderTargetsRefuseAllMutations() throws {
        for operation in [Operation.updateCalendar, .deleteCalendar, .createEvent, .updateEvent, .deleteEvent] {
            for values in [[], [WriteTestCalendar("other")]] as [[WriteTestCalendar]] {
                let provider = WriteTestProvider(); provider.calendarValues = values
                assertError(operation == .updateEvent || operation == .deleteEvent ? .missingEvent : .missingCalendar) {
                    try run(operation, provider)
                }
                XCTAssertTrue(provider.writes.isEmpty); XCTAssertNil(provider.requestedEventID)
            }
            let duplicate = WriteTestProvider(); duplicate.calendarValues = [WriteTestCalendar(), WriteTestCalendar()]
            assertError(.ambiguous) { try run(operation, duplicate) }
            let readOnly = WriteTestProvider(); readOnly.calendarValues = [WriteTestCalendar(writable: false)]
            assertError(.readOnly) { try run(operation, readOnly) }; XCTAssertTrue(readOnly.writes.isEmpty)
            let reminders = WriteTestProvider(); reminders.calendarValues = [WriteTestCalendar(events: false)]
            assertError(.invalid) { try run(operation, reminders) }; XCTAssertTrue(reminders.writes.isEmpty)
        }
        for operation in [Operation.updateCalendar, .deleteCalendar] {
            let immutable = WriteTestProvider(); immutable.calendarValues = [WriteTestCalendar(immutable: true)]
            assertError(.readOnly) { try run(operation, immutable) }; XCTAssertTrue(immutable.writes.isEmpty)
        }
        let immutable = WriteTestProvider(); immutable.calendarValues = [WriteTestCalendar(immutable: true)]
        try run(.createEvent, immutable)
        XCTAssertEqual(immutable.writes, ["write:createEvent"])
    }

    func testOnlyGenuineEventAbsenceUsesMissingSentinelAndRecurringOrChangedIDsRefuse() throws {
        for operation in [Operation.updateEvent, .deleteEvent] {
            let absent = WriteTestProvider(); absent.eventValues = []
            assertError(.missingEvent) { try run(operation, absent) }
            XCTAssertEqual(NativeCalendarWriteError.missingEvent.localizedDescription, "event-not-found")
            let duplicate = WriteTestProvider(); duplicate.eventValues = [WriteTestEvent(), WriteTestEvent()]
            assertError(.ambiguous) { try run(operation, duplicate) }
            let recurring = WriteTestProvider(); recurring.eventValues = [WriteTestEvent(recurring: true)]
            assertError(.recurring) { try run(operation, recurring) }
            for event in [WriteTestEvent("other"), WriteTestEvent(calendarID: "other") ] {
                let changed = WriteTestProvider(); changed.eventValues = [event]
                assertError(.invalid) { try run(operation, changed) }; XCTAssertTrue(changed.writes.isEmpty)
            }
            let malformed = WriteTestProvider(); malformed.eventValues[0].value = nil
            assertError(.invalid) { try run(operation, malformed) }
            XCTAssertTrue(absent.writes.isEmpty); XCTAssertTrue(duplicate.writes.isEmpty); XCTAssertTrue(recurring.writes.isEmpty)
        }
        let provider = WriteTestProvider(); provider.eventValues = [WriteTestEvent("café")]
        assertError(.invalid) { try run(.deleteEvent, provider, eventID: "cafe\u{301}") }
    }

    func testConfirmedMissingCalendarMakesMappedEventsMissingWithoutLookupOrMutation() throws {
        for operation in [Operation.updateEvent, .deleteEvent] {
            for values in [[], [WriteTestCalendar("calendar-\u{e9}")]] as [[WriteTestCalendar]] {
                let provider = WriteTestProvider(); provider.calendarValues = values
                assertError(.missingEvent) { try run(operation, provider, calendarID: "calendar-e\u{301}") }
                XCTAssertEqual(provider.operations, ["permissions", "calendars", "permissions"])
                XCTAssertTrue(provider.writes.isEmpty); XCTAssertNil(provider.requestedEventID)
            }
        }
        for operation in [Operation.updateCalendar, .deleteCalendar, .createEvent] {
            let provider = WriteTestProvider(); provider.calendarValues = []
            assertError(.missingCalendar) { try run(operation, provider) }
            XCTAssertEqual(provider.operations, ["permissions", "calendars", "permissions"])
            XCTAssertTrue(provider.writes.isEmpty); XCTAssertNil(provider.requestedEventID)
        }
    }

    func testMissingCalendarRequiresSuccessfulEnumerationAndPermissionRecheck() throws {
        let errors: [(Error, NativeCalendarWriteError)] = [
            (NativeCalendarReadError.denied, .denied), (NativeCalendarReadError.unavailable, .unavailable),
            (NativeCalendarWriteError.missingCalendar, .missingCalendar),
            (NativeCalendarWriteError.failed, .failed), (NativeCalendarWriteError.ambiguous, .ambiguous),
            (NativeCalendarWriteError.invalid, .invalid)
        ]
        for operation in [Operation.updateCalendar, .deleteCalendar, .createEvent, .updateEvent, .deleteEvent] {
            for (failure, expected) in errors {
                let provider = WriteTestProvider(); provider.calendarValues = []; provider.calendarFailure = failure
                assertError(expected) { try run(operation, provider) }
                XCTAssertEqual(provider.operations, ["permissions", "calendars"])
                XCTAssertTrue(provider.writes.isEmpty); XCTAssertNil(provider.requestedEventID)
            }
            for permission in [NativeCalendarPermission.denied, .undetermined] {
                let initiallyDenied = WriteTestProvider(); initiallyDenied.calendarValues = []
                initiallyDenied.permissionReplies = [permission]
                assertError(.denied) { try run(operation, initiallyDenied) }
                XCTAssertEqual(initiallyDenied.operations, ["permissions"])
                XCTAssertTrue(initiallyDenied.writes.isEmpty)
                for values in [[], [WriteTestCalendar(), WriteTestCalendar()]] as [[WriteTestCalendar]] {
                    let revoked = WriteTestProvider(); revoked.calendarValues = values
                    revoked.permissionReplies = [.granted, permission]
                    assertError(.denied) { try run(operation, revoked) }
                    XCTAssertEqual(revoked.operations, ["permissions", "calendars", "permissions"])
                    XCTAssertTrue(revoked.writes.isEmpty); XCTAssertNil(revoked.requestedEventID)
                }
            }
            for position in [2, 3] {
                let failed = WriteTestProvider(); failed.calendarValues = []; failed.failAt = position
                assertError(.failed) { try run(operation, failed) }
                XCTAssertEqual(failed.operations.count, position)
                XCTAssertTrue(failed.writes.isEmpty); XCTAssertNil(failed.requestedEventID)
            }
            let duplicate = WriteTestProvider(); duplicate.calendarValues = [WriteTestCalendar(), WriteTestCalendar()]
            assertError(.ambiguous) { try run(operation, duplicate) }
            XCTAssertEqual(duplicate.operations, ["permissions", "calendars", "permissions"])
            XCTAssertTrue(duplicate.writes.isEmpty); XCTAssertNil(duplicate.requestedEventID)
        }
    }

    func testFinalPermissionObservationRevalidatesSourceTargetAndEventIdentity() throws {
        let source = WriteTestProvider()
        source.beforeOperation = { count in
            if count == 3 { source.sourceValues[0].value = NativeCalendarSource(id: "changed", name: "PRIVATE_ACCOUNT", type: .local) }
        }
        assertError(.invalid) { try run(.createCalendar, source) }; XCTAssertTrue(source.writes.isEmpty)
        for operation in [Operation.updateCalendar, .deleteCalendar, .createEvent, .updateEvent, .deleteEvent] {
            let success = WriteTestProvider(); try run(operation, success)
            let finalCheck = try XCTUnwrap(success.operations.lastIndex(of: "permissions")) + 1
            for changed in [WriteTestCalendar("changed"), WriteTestCalendar(writable: false)] {
                let provider = WriteTestProvider()
                provider.beforeOperation = { count in
                    if count == finalCheck { provider.calendarValues[0].value = changed.value }
                }
                assertError(changed.value.allowsModifications ? .invalid : .readOnly) { try run(operation, provider) }
                XCTAssertTrue(provider.writes.isEmpty)
            }
        }
        let successfulEvent = WriteTestProvider(); try run(.updateEvent, successfulEvent)
        let finalEventCheck = try XCTUnwrap(successfulEvent.operations.lastIndex(of: "permissions")) + 1
        for changed in [WriteTestEvent("changed"), WriteTestEvent(calendarID: "changed"), WriteTestEvent(recurring: true)] {
            let provider = WriteTestProvider()
            provider.beforeOperation = { count in if count == finalEventCheck { provider.eventValues[0].value = changed.value } }
            assertError(changed.value?.recurring == true ? .recurring : .invalid) { try run(.updateEvent, provider) }
            XCTAssertTrue(provider.writes.isEmpty)
        }
    }

    func testPrivateProviderFailuresAndInvalidReturnedIDsStayFixedWithoutRetry() throws {
        for operation in Operation.allCases {
            let success = WriteTestProvider(); try run(operation, success)
            for position in 1...success.operations.count {
                let provider = WriteTestProvider(); provider.failAt = position
                assertError(.failed) { try run(operation, provider) }
                XCTAssertEqual(provider.operations.count, position)
                XCTAssertLessThanOrEqual(provider.writes.count, 1)
            }
        }
        for returned in ["", " \n\t", String(repeating: "x", count: 1025)] {
            let calendar = WriteTestProvider(); calendar.calendarResult = returned
            assertError(.failed) { try run(.createCalendar, calendar) }
            XCTAssertEqual(calendar.writes, ["write:createCalendar"])
            let event = WriteTestProvider(); event.eventResult = returned
            assertError(.failed) { try run(.createEvent, event) }
            XCTAssertEqual(event.writes, ["write:createEvent"])
        }
    }

    #if !os(iOS) || !canImport(EventKit)
    func testSystemWriterIsExplicitlyUnavailableOutsideIOS() throws {
        let writer: any NativeCalendarWriting = NativeCalendarReader()
        assertError(.unavailable) { try writer.sources() }
        assertError(.unavailable) { try writer.createCalendar(create()) }
        assertError(.unavailable) { try writer.updateCalendar(calendarID: "calendar", details: NativeCalendarUpdateDetails(color: "#3B82F6")) }
        assertError(.unavailable) { try writer.deleteCalendar(calendarID: "calendar") }
        assertError(.unavailable) { try writer.createEvent(calendarID: "calendar", details: details()) }
        assertError(.unavailable) { try writer.updateEvent(eventID: "event", calendarID: "calendar", details: details()) }
        assertError(.unavailable) { try writer.deleteEvent(eventID: "event", calendarID: "calendar") }
    }
    #endif
}

private final class WitnessedJobsProvider: NativeCalendarWriteWitnessing, @unchecked Sendable {
    enum Proof { case none, mutation, absence, absenceThenMutation, mutationThenAbsence }
    let policy = WriteTestProvider()
    var returned: NativeCalendarWriteValue?
    var thrown: Error?
    var proof: Proof = .none
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue {
        if returned != nil || thrown != nil {
            switch proof {
            case .none: break
            case .mutation: beforeProviderMutation()
            case .absence: confirmedMissingEvent()
            case .absenceThenMutation: confirmedMissingEvent(); beforeProviderMutation()
            case .mutationThenAbsence: beforeProviderMutation(); confirmedMissingEvent()
            }
            if let thrown { throw thrown }
            return returned!
        }
        return try NativeCalendarWritePolicy.write(request, using: policy, beforeProviderMutation: beforeProviderMutation,
                                                   confirmedMissingEvent: confirmedMissingEvent)
    }
    func permissions() throws -> NativeCalendarPermission { try policy.permissions() }
    func calendars() throws -> [[String: Any]] { [] }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] { [] }
    func sources() throws -> [NativeCalendarSource] { try NativeCalendarWritePolicy.sources(policy) }
    // The witnessed method is the tested dispatch; unrefined compatibility has its existing separate fake.
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteCalendar(calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteEvent(eventID: String, calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
}

final class NativeCalendarWitnessJobsTests: XCTestCase {
    private func details() throws -> NativeCalendarEventDetails {
        try NativeCalendarEventDetails(title: "Synthetic", start: Date(timeIntervalSince1970: 1_800_000_000),
            end: Date(timeIntervalSince1970: 1_800_003_600), allDay: false, notes: "", location: "")
    }
    private func attempt(_ provider: WitnessedJobsProvider, _ request: NativeCalendarWriteRequest) throws -> NativeCalendarWriteOutcome {
        let registry = NativeAttachmentLocalRequests(), jobs = NativeCalendarJobs(registry: registry) { provider }, id = UUID()
        defer { jobs.shutdown() }
        try jobs.submitWrite(request, operationID: id); jobs.drain()
        jobs.cancelWrite(operationID: id); registry.close(); jobs.shutdown(); jobs.shutdown()
        let outcome = try XCTUnwrap(jobs.writeOutcome(operationID: id))
        try jobs.retireWrite(operationID: id); XCTAssertNil(jobs.writeOutcome(operationID: id))
        return outcome
    }
    private func assertPreflight(_ outcome: NativeCalendarWriteOutcome, _ expected: NativeCalendarWriteError,
                                 file: StaticString = #filePath, line: UInt = #line) {
        guard case .failedBeforeMutation(let error) = outcome else { return XCTFail("Expected witnessed preflight failure", file: file, line: line) }
        XCTAssertEqual(error, expected, file: file, line: line)
    }
    private func assertUncertain(_ outcome: NativeCalendarWriteOutcome, _ expected: NativeCalendarWriteError,
                                 file: StaticString = #filePath, line: UInt = #line) {
        guard case .failed(let error) = outcome else { return XCTFail("Expected uncertain failure", file: file, line: line) }
        XCTAssertEqual(error, expected, file: file, line: line)
    }
    func testRealPolicyPermissionPreflightFailureSurvivesCancelAndShutdownWithoutMutation() throws {
        let provider = WitnessedJobsProvider(); provider.policy.permissionReplies = [.denied]
        assertPreflight(try attempt(provider, .createEvent("calendar", details())), .denied)
        XCTAssertTrue(provider.policy.writes.isEmpty)
    }

    func testOnlyConfirmedAbsenceHasTheSharedEventNotFoundReplySentinel() {
        for outcome in [NativeCalendarWriteOutcome.failed(.missingEvent), .failedBeforeMutation(.missingEvent)] {
            XCTAssertEqual(outcome.replyError, .failed)
            XCTAssertEqual(outcome.replyError?.errorDescription, "Calendar write failed")
        }
        XCTAssertEqual(NativeCalendarWriteOutcome.confirmedMissingEvent.replyError?.errorDescription, "event-not-found")
        XCTAssertEqual(NativeCalendarWriteOutcome.failedBeforeMutation(.readOnly).replyError, .readOnly)
        XCTAssertEqual(NativeCalendarWriteOutcome.failed(.denied).replyError, .denied)
        XCTAssertNil(NativeCalendarWriteOutcome.notStarted.replyError)
        XCTAssertNil(NativeCalendarWriteOutcome.succeeded(.completed).replyError)
    }

    func testWitnessedRealPolicyAllSevenRequestsProduceValidatedExactValues() throws {
        let event = try details(), create = try NativeCalendarCreateDetails(title: "Synthetic", color: "#123abc", sourceID: "source")
        let update = try NativeCalendarUpdateDetails(color: "#123abc")
        let requests: [NativeCalendarWriteRequest] = [.sources, .createCalendar(create), .updateCalendar("calendar", update),
            .deleteCalendar("calendar"), .createEvent("calendar", event), .updateEvent("event", "calendar", event), .deleteEvent("event", "calendar")]
        for request in requests {
            let provider = WitnessedJobsProvider()
            provider.policy.calendarResult = "created-calendar/e\u{301}"; provider.policy.eventResult = "created-event/e\u{301}"
            let outcome = try attempt(provider, request)
            switch (request, outcome) {
            case (.sources, .succeeded(.sources(let sources))):
                XCTAssertEqual(sources.map { $0.id }, ["source"]); XCTAssertTrue(provider.policy.writes.isEmpty)
            case (.createCalendar, .succeeded(.identifier(let id))):
                XCTAssertEqual(Data(id.utf8), Data("created-calendar/e\u{301}".utf8)); XCTAssertEqual(provider.policy.writes.count, 1)
            case (.createEvent, .succeeded(.identifier(let id))):
                XCTAssertEqual(Data(id.utf8), Data("created-event/e\u{301}".utf8)); XCTAssertEqual(provider.policy.writes.count, 1)
            case (.updateCalendar, .succeeded(.completed)), (.deleteCalendar, .succeeded(.completed)),
                 (.updateEvent, .succeeded(.completed)), (.deleteEvent, .succeeded(.completed)):
                XCTAssertEqual(provider.policy.writes.count, 1)
            default: XCTFail("Wrong request/value shape")
            }
        }
    }

    func testSourceTargetIdentityAndLatePermissionRejectionsAreProvenNoMutationFailures() throws {
        let event = try details(), create = try NativeCalendarCreateDetails(title: "Synthetic", color: "#123abc", sourceID: "source")
        let update = try NativeCalendarUpdateDetails(color: "#123abc")
        let cases: [(NativeCalendarWriteRequest, NativeCalendarWriteError, (WriteTestProvider) -> Void)] = [
            (.createCalendar(create), .missingSource, { $0.sourceValues = [] }),
            (.createCalendar(create), .ambiguous, { $0.sourceValues.append(WriteTestSource()) }),
            (.createCalendar(create), .invalid, { $0.sourceValues = [WriteTestSource(type: .subscribed)] }),
            (.createCalendar(create), .denied, { $0.permissionReplies = [.granted, .denied] }),
            (.createEvent("calendar", event), .missingCalendar, { $0.calendarValues = [] }),
            (.createEvent("calendar", event), .denied, { $0.permissionReplies = [.granted, .granted, .denied] }),
            (.updateCalendar("calendar", update), .readOnly, { $0.calendarValues = [WriteTestCalendar(writable: false)] }),
            (.deleteCalendar("calendar"), .readOnly, { $0.calendarValues = [WriteTestCalendar(immutable: true)] }),
            (.updateEvent("event", "calendar", event), .invalid, { $0.eventValues = [WriteTestEvent(calendarID: "other")] }),
            (.updateEvent("event", "calendar", event), .recurring, { $0.eventValues = [WriteTestEvent(recurring: true)] }),
            (.deleteEvent("event", "calendar"), .ambiguous, { $0.eventValues.append(WriteTestEvent()) }),
        ]
        for (request, error, configure) in cases {
            let provider = WitnessedJobsProvider(); configure(provider.policy)
            assertPreflight(try attempt(provider, request), error); XCTAssertTrue(provider.policy.writes.isEmpty)
        }
    }

    func testOnlySuccessfulExactAbsenceCreatesConfirmedMissingOutcomeAndLateDenialRefusesIt() throws {
        let event = try details()
        for request in [NativeCalendarWriteRequest.updateEvent("event", "calendar", event), .deleteEvent("event", "calendar")] {
            for missingCalendar in [false, true] {
                let provider = WitnessedJobsProvider()
                if missingCalendar { provider.policy.calendarValues = [] } else { provider.policy.eventValues = [] }
                guard case .confirmedMissingEvent = try attempt(provider, request) else { return XCTFail("Expected confirmed exact absence") }
                XCTAssertTrue(provider.policy.writes.isEmpty)
                provider.policy.permissionReplies = missingCalendar ? [.granted, .denied] : [.granted, .granted, .granted, .denied]
                assertPreflight(try attempt(provider, request), .denied); XCTAssertTrue(provider.policy.writes.isEmpty)
            }
            for calendarRead in [false, true] {
                let provider = WitnessedJobsProvider()
                if calendarRead { provider.policy.calendarFailure = NativeCalendarWriteError.missingEvent }
                else { provider.policy.eventFailure = NativeCalendarWriteError.missingEvent }
                let outcome = try attempt(provider, request)
                assertPreflight(outcome, .missingEvent); XCTAssertEqual(outcome.replyError, .failed)
                XCTAssertTrue(provider.policy.writes.isEmpty)
            }
        }
    }

    func testEveryProviderMutationErrorRemainsUncertainIncludingTypedMissingEvent() throws {
        let failures: [(Error, NativeCalendarWriteError)] = [
            (NativeCalendarWriteError.denied, .denied), (NativeCalendarWriteError.unavailable, .unavailable),
            (NativeCalendarWriteError.missingSource, .missingSource), (NativeCalendarWriteError.missingCalendar, .missingCalendar),
            (NativeCalendarWriteError.missingEvent, .missingEvent), (NativeCalendarWriteError.readOnly, .readOnly),
            (NativeCalendarWriteError.invalid, .invalid), (NativeCalendarWriteError.ambiguous, .ambiguous),
            (NativeCalendarWriteError.recurring, .recurring), (NativeCalendarWriteError.failed, .failed),
            (NativeCalendarReadError.denied, .denied), (NativeCalendarReadError.unavailable, .unavailable),
            (HostFailure("private task account synthetic-secret"), .failed),
        ]
        for (failure, expected) in failures {
            let provider = WitnessedJobsProvider(); provider.policy.mutationFailure = failure
            let outcome = try attempt(provider, .createEvent("calendar", details()))
            assertUncertain(outcome, expected); XCTAssertEqual(provider.policy.writes, ["write:createEvent"])
            XCTAssertEqual(outcome.replyError, expected == .missingEvent ? .failed : expected)
        }
    }

    func testInvalidReturnedIDAfterRealPolicyProviderEntryIsUncertain() throws {
        let create = try NativeCalendarCreateDetails(title: "Synthetic", color: "#123abc", sourceID: "source")
        for request in [NativeCalendarWriteRequest.createCalendar(create), .createEvent("calendar", try details())] {
            for invalid in ["", " \n\u{FEFF}", String(repeating: "x", count: 1025)] {
                let provider = WitnessedJobsProvider(); provider.policy.calendarResult = invalid; provider.policy.eventResult = invalid
                assertUncertain(try attempt(provider, request), .failed); XCTAssertEqual(provider.policy.writes.count, 1)
            }
        }
    }

    func testMalformedWitnessedSuccessAndMissingEntryProofNeverPermitSafeClear() throws {
        let event = try details()
        let cases: [(NativeCalendarWriteRequest, NativeCalendarWriteValue, WitnessedJobsProvider.Proof)] = [
            (.createEvent("calendar", event), .identifier("created"), .none),
            (.createEvent("calendar", event), .identifier("created"), .absence),
            (.createEvent("calendar", event), .identifier(""), .mutation),
            (.createEvent("calendar", event), .completed, .mutation),
            (.createEvent("calendar", event), .sources([]), .mutation),
            (.updateEvent("event", "calendar", event), .identifier("event"), .mutation),
            (.deleteCalendar("calendar"), .sources([]), .mutation),
        ]
        for (request, value, proof) in cases {
            let provider = WitnessedJobsProvider(); provider.returned = value; provider.proof = proof
            assertUncertain(try attempt(provider, request), .failed)
        }
        let source = WitnessedJobsProvider(); source.returned = .sources([NativeCalendarSource(id: "", name: "private", type: .local)])
        assertPreflight(try attempt(source, .sources), .failed)
    }

    func testMutationProofWinsOverAbsenceAndAbsenceRequiresEventScopeAndMatchingFailure() throws {
        for proof in [WitnessedJobsProvider.Proof.absenceThenMutation, .mutationThenAbsence] {
            let provider = WitnessedJobsProvider(); provider.proof = proof; provider.thrown = NativeCalendarWriteError.missingEvent
            assertUncertain(try attempt(provider, .deleteEvent("event", "calendar")), .missingEvent)
        }
        let create = WitnessedJobsProvider(); create.proof = .absence; create.thrown = NativeCalendarWriteError.missingEvent
        assertPreflight(try attempt(create, .createEvent("calendar", details())), .missingEvent)
        let wrongError = WitnessedJobsProvider(); wrongError.proof = .absence; wrongError.thrown = NativeCalendarReadError.unavailable
        assertPreflight(try attempt(wrongError, .deleteEvent("event", "calendar")), .unavailable)
    }

    func testCancellationDuringWitnessedPreflightRetainsActualRejectionRatherThanNotStarted() throws {
        for closing in [false, true] {
            let provider = WitnessedJobsProvider(), registry = NativeAttachmentLocalRequests()
            provider.policy.permissionReplies = [.denied]
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            provider.policy.beforeOperation = { _ in entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
            let jobs = NativeCalendarJobs(registry: registry) { provider }, id = UUID()
            defer { release.signal(); jobs.shutdown() }
            try jobs.submitWrite(.createEvent("calendar", details()), operationID: id)
            XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
            if closing { registry.close() } else { jobs.cancelWrite(operationID: id) }
            release.signal(); jobs.drain(); jobs.shutdown()
            assertPreflight(try XCTUnwrap(jobs.writeOutcome(operationID: id)), .denied)
            XCTAssertTrue(provider.policy.writes.isEmpty); try jobs.retireWrite(operationID: id)
        }
    }

    func testCancellationAndCloseDuringWitnessedProviderEntryRetainActualSuccessOrFailure() throws {
        for failing in [false, true] {
            for closing in [false, true] {
                let provider = WitnessedJobsProvider(), registry = NativeAttachmentLocalRequests()
                let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
                provider.policy.eventResult = "created/e\u{301}"
                if failing { provider.policy.mutationFailure = NativeCalendarWriteError.missingEvent }
                provider.policy.beforeOperation = { _ in
                    if !provider.policy.writes.isEmpty { entered.signal(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
                }
                let jobs = NativeCalendarJobs(registry: registry) { provider }, id = UUID()
                defer { release.signal(); provider.policy.beforeOperation = nil; jobs.shutdown() }
                try jobs.submitWrite(.createEvent("calendar", details()), operationID: id)
                XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
                if closing { registry.close() } else { jobs.cancelWrite(operationID: id) }
                release.signal(); jobs.drain(); jobs.shutdown(); jobs.shutdown()
                let outcome = try XCTUnwrap(jobs.writeOutcome(operationID: id))
                if failing { assertUncertain(outcome, .missingEvent); XCTAssertEqual(outcome.replyError, .failed) }
                else {
                    guard case .succeeded(.identifier(let id)) = outcome else { return XCTFail("Cancelled actual save lost its identifier") }
                    XCTAssertEqual(Data(id.utf8), Data("created/e\u{301}".utf8))
                }
                XCTAssertEqual(provider.policy.writes, ["write:createEvent"]); try jobs.retireWrite(operationID: id)
            }
        }
    }
}
