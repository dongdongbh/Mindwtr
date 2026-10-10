import Foundation
import XCTest
@testable import MindwtrNativeCore
#if os(iOS) && canImport(EventKit)
import EventKit
#endif

final class CalendarTestReader: NativeCalendarReading, @unchecked Sendable {
    var permission: NativeCalendarPermission = .granted
    var calendarValues: [[String: Any]] = []
    var eventValues: [[String: Any]] = []
    var beforeRead: ((String) throws -> Void)?
    private let lock = NSLock()
    private var recorded: [String] = []
    private var eventRequest: (ids: [String], start: Date, end: Date)?
    var operations: [String] { lock.lock(); defer { lock.unlock() }; return recorded }
    var requestedEvents: (ids: [String], start: Date, end: Date)? {
        lock.lock(); defer { lock.unlock() }; return eventRequest
    }
    private func record(_ operation: String) throws {
        lock.lock(); recorded.append(operation); lock.unlock()
        try beforeRead?(operation)
    }
    func permissions() throws -> NativeCalendarPermission { try record("permissions"); return permission }
    func calendars() throws -> [[String: Any]] { try record("calendars"); return calendarValues }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        lock.lock(); eventRequest = (calendarIds, start, end); lock.unlock()
        try record("events"); return eventValues
    }
}

final class NativeCalendarReaderTests: XCTestCase {
    func testCalendarSelectionUsesExactUTF8Identity() {
        let composed = "caf\u{e9}", decomposed = "cafe\u{301}"
        XCTAssertEqual(composed, decomposed)
        let available = [composed, decomposed, " \u{feff}calendar ", "calendar", "not-selected"]
        let selected = NativeCalendarIDs.selected([decomposed, " \u{feff}calendar ", decomposed], available: available)
        XCTAssertEqual(selected, Set([Data(decomposed.utf8), Data(" \u{feff}calendar ".utf8)]))
        XCTAssertFalse(selected.contains(Data(composed.utf8)))
        XCTAssertFalse(selected.contains(Data("calendar".utf8)))
    }

    func testEmptyAndAllMissingSelectionsCannotSelectEveryCalendar() {
        XCTAssertTrue(NativeCalendarIDs.selected([], available: ["one", "two"]).isEmpty)
        XCTAssertTrue(NativeCalendarIDs.selected(["missing"], available: ["one", "two"]).isEmpty)
        XCTAssertTrue(NativeCalendarIDs.selected(["one"], available: []).isEmpty)
        XCTAssertEqual(NativeCalendarIDs.selected(["missing", "two"], available: ["one", "two"]), Set([Data("two".utf8)]))
    }

    #if os(iOS) && canImport(EventKit)
    func testPassiveAuthorizationMappingMatchesRNReadAuthority() {
        XCTAssertEqual(NativeCalendarReader.permission(.notDetermined), .undetermined)
        XCTAssertEqual(NativeCalendarReader.permission(.restricted), .denied)
        XCTAssertEqual(NativeCalendarReader.permission(.denied), .denied)
        if #available(iOS 17.0, *) {
            XCTAssertEqual(NativeCalendarReader.permission(.fullAccess), .granted)
            XCTAssertEqual(NativeCalendarReader.permission(.writeOnly), .denied)
        } else {
            XCTAssertEqual(NativeCalendarReader.permission(.authorized), .granted)
        }
    }
    #else
    func testSystemReaderIsExplicitlyUnavailableOutsideIOS() {
        let reader = NativeCalendarReader()
        XCTAssertThrowsError(try reader.permissions())
        XCTAssertThrowsError(try reader.calendars())
        XCTAssertThrowsError(try reader.events(calendarIds: [], start: Date(), end: Date()))
    }
    #endif
}
