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
    }
    var writes: [String] { operations.filter { $0.hasPrefix("write:") } }
    func permissions() throws -> NativeCalendarPermission {
        try record("permissions")
        return permissionReplies.count > 1 ? permissionReplies.removeFirst() : permissionReplies[0]
    }
    func sources() throws -> [WriteTestSource] { try record("sources"); return sourceValues }
    func source(_ value: WriteTestSource) -> NativeCalendarSource { value.value }
    func calendars() throws -> [WriteTestCalendar] { try record("calendars"); return calendarValues }
    func target(_ value: WriteTestCalendar) -> NativeCalendarWriteTarget { value.value }
    func events(eventID: String, calendar: WriteTestCalendar) throws -> [WriteTestEvent] {
        requestedEventID = eventID; selectedCalendar = calendar
        try record("events"); return eventValues
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
    private enum Operation: CaseIterable {
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
    private func run(_ operation: Operation, _ provider: WriteTestProvider, calendarID: String = "calendar", eventID: String = "event") throws {
        switch operation {
        case .sources: _ = try NativeCalendarWritePolicy.sources(provider)
        case .createCalendar: _ = try NativeCalendarWritePolicy.createCalendar(create(), using: provider)
        case .updateCalendar:
            try NativeCalendarWritePolicy.updateCalendar(calendarID: calendarID, details: NativeCalendarUpdateDetails(color: "#2563EB"), using: provider)
        case .deleteCalendar: try NativeCalendarWritePolicy.deleteCalendar(calendarID: calendarID, using: provider)
        case .createEvent: _ = try NativeCalendarWritePolicy.createEvent(calendarID: calendarID, details: details(), using: provider)
        case .updateEvent: try NativeCalendarWritePolicy.updateEvent(eventID: eventID, calendarID: calendarID, details: details(), using: provider)
        case .deleteEvent: try NativeCalendarWritePolicy.deleteEvent(eventID: eventID, calendarID: calendarID, using: provider)
        }
    }
    private func assertError<T>(_ expected: NativeCalendarWriteError, file: StaticString = #filePath, line: UInt = #line,
                                _ operation: () throws -> T) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeCalendarWriteError, expected, file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("PRIVATE_"), file: file, line: line)
        }
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
                assertError(.missingCalendar) { try run(operation, provider) }
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
        for changed in [WriteTestEvent("changed"), WriteTestEvent(calendarID: "changed"), WriteTestEvent(recurring: true)] {
            let provider = WriteTestProvider()
            provider.beforeOperation = { count in if count == 6 { provider.eventValues[0].value = changed.value } }
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
