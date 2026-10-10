import Foundation
#if os(iOS) && canImport(EventKit)
import EventKit
#endif

public enum NativeCalendarEventOpenError: Error, Equatable, Sendable {
    case invalidRequest, denied, unavailable, missingOccurrence, ambiguousOccurrence
}

/// The original feed occurrence, without display IDs, content or source URLs.
public struct NativeCalendarEventOpenRequest: Sendable {
    public let calendarID: String
    public let calendarItemIdentifier: String
    public let start: Date
    public let end: Date
    public let allDay: Bool

    // Match NativeCalendarJobs' supported provider date range and ID byte limit.
    static let minimumSeconds: TimeInterval = -62_135_596_800
    static let maximumSeconds: TimeInterval = 253_402_300_799.999

    public init(calendarID: String, calendarItemIdentifier: String, start: Date, end: Date, allDay: Bool) throws {
        guard Self.validID(calendarID), Self.validID(calendarItemIdentifier),
              Self.validDate(start), Self.validDate(end), end > start else {
            throw NativeCalendarEventOpenError.invalidRequest
        }
        self.calendarID = calendarID
        self.calendarItemIdentifier = calendarItemIdentifier
        self.start = start
        self.end = end
        self.allDay = allDay
    }

    private static func validID(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 1_024 else { return false }
        // Test blankness without changing the raw identity (including padding).
        return value.unicodeScalars.contains {
            !CharacterSet.whitespacesAndNewlines.contains($0) && $0.value != 0xfeff
        }
    }

    static func validDate(_ value: Date) -> Bool {
        let seconds = value.timeIntervalSince1970
        return seconds.isFinite && seconds >= minimumSeconds && seconds <= maximumSeconds
    }
}

/// Retain this owner through actual EventKitUI dismissal. Its resources stay on
/// the MainActor and never come from NativeCalendarReader's serial worker.
@MainActor
public final class NativeCalendarEventOpenOwner {
    #if os(iOS) && canImport(EventKit)
    public let eventStore: EKEventStore
    public let event: EKEvent

    fileprivate init(eventStore: EKEventStore, event: EKEvent) {
        self.eventStore = eventStore
        self.event = event
    }
    #else
    fileprivate init() {}
    #endif
}

/// Passive exact-occurrence lookup only; presentation and its lifetime belong
/// to the App. Resolving never invokes CoreHost/JSC or requests authorization.
@MainActor
public final class NativeCalendarEventOpenResolver {
    public init() {}

    public func resolve(_ request: NativeCalendarEventOpenRequest) throws -> NativeCalendarEventOpenOwner {
        #if os(iOS) && canImport(EventKit)
        let provider = EventKitCalendarEventOpenProvider()
        let event = try NativeCalendarEventOpenPolicy.resolve(request, using: provider)
        return NativeCalendarEventOpenOwner(eventStore: provider.store, event: event)
        #else
        throw NativeCalendarEventOpenError.unavailable
        #endif
    }
}

struct NativeCalendarEventOpenOccurrence {
    let calendarID: String
    let calendarItemIdentifier: String
    let start: Date
    let end: Date
    let allDay: Bool
}

/// Internal provider seam exercises the same selection policy as EventKit.
/// It deliberately has no authorization request, identifier lookup or writes.
@MainActor
protocol NativeCalendarEventOpenProviding: AnyObject {
    associatedtype CalendarValue
    associatedtype EventValue
    func permissions() throws -> NativeCalendarPermission
    func calendars() throws -> [CalendarValue]
    func calendarID(for calendar: CalendarValue) -> String
    func events(in calendar: CalendarValue, start: Date, end: Date) throws -> [EventValue]
    func occurrence(for event: EventValue) -> NativeCalendarEventOpenOccurrence?
}

@MainActor
enum NativeCalendarEventOpenPolicy {
    static func resolve<Provider: NativeCalendarEventOpenProviding>(
        _ request: NativeCalendarEventOpenRequest, using provider: Provider
    ) throws -> Provider.EventValue {
        do {
            try requireReadAccess(provider)
            let calendars = try provider.calendars().filter {
                equalID(provider.calendarID(for: $0), request.calendarID)
            }
            guard let calendar = calendars.first else { throw NativeCalendarEventOpenError.missingOccurrence }
            guard calendars.count == 1 else { throw NativeCalendarEventOpenError.ambiguousOccurrence }

            // Permission can be revoked after enumeration. Never query another
            // calendar or use an empty/nil all-calendar predicate as a fallback.
            try requireReadAccess(provider)
            let queryStart = Date(timeIntervalSince1970: max(
                NativeCalendarEventOpenRequest.minimumSeconds, request.start.timeIntervalSince1970 - 1))
            let queryEnd = Date(timeIntervalSince1970: min(
                NativeCalendarEventOpenRequest.maximumSeconds, request.start.timeIntervalSince1970 + 1))
            guard queryEnd > queryStart else { throw NativeCalendarEventOpenError.invalidRequest }
            let events = try provider.events(in: calendar, start: queryStart, end: queryEnd)
            try requireReadAccess(provider)

            // Use NativeCalendarReader's actual millisecond representation,
            // rather than independently rounding fractional provider instants.
            let formatter = DateFormatter()
            formatter.timeZone = TimeZone(identifier: "UTC")
            formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            let expectedStart = formatter.string(from: request.start)
            let expectedEnd = formatter.string(from: request.end)
            let matches = events.filter { event in
                guard let occurrence = provider.occurrence(for: event),
                      NativeCalendarEventOpenRequest.validDate(occurrence.start),
                      NativeCalendarEventOpenRequest.validDate(occurrence.end), occurrence.end > occurrence.start else { return false }
                return equalID(occurrence.calendarID, request.calendarID)
                    && equalID(occurrence.calendarItemIdentifier, request.calendarItemIdentifier)
                    && formatter.string(from: occurrence.start) == expectedStart
                    && formatter.string(from: occurrence.end) == expectedEnd
                    && occurrence.allDay == request.allDay
            }
            guard let event = matches.first else { throw NativeCalendarEventOpenError.missingOccurrence }
            guard matches.count == 1 else { throw NativeCalendarEventOpenError.ambiguousOccurrence }
            return event
        } catch let error as NativeCalendarEventOpenError {
            throw error
        } catch NativeCalendarReadError.denied {
            throw NativeCalendarEventOpenError.denied
        } catch {
            // Provider failures never carry calendar identifiers or content.
            throw NativeCalendarEventOpenError.unavailable
        }
    }

    private static func requireReadAccess<Provider: NativeCalendarEventOpenProviding>(_ provider: Provider) throws {
        guard try provider.permissions() == .granted else { throw NativeCalendarEventOpenError.denied }
    }

    private static func equalID(_ first: String, _ second: String) -> Bool {
        Data(first.utf8) == Data(second.utf8)
    }
}

#if os(iOS) && canImport(EventKit)
@MainActor
private final class EventKitCalendarEventOpenProvider: NativeCalendarEventOpenProviding {
    private var ownedStore: EKEventStore?
    var store: EKEventStore {
        if let ownedStore { return ownedStore }
        let store = EKEventStore()
        ownedStore = store
        return store
    }

    func permissions() throws -> NativeCalendarPermission {
        NativeCalendarReader.permission(EKEventStore.authorizationStatus(for: .event))
    }
    func calendars() throws -> [EKCalendar] { store.calendars(for: .event) }
    func calendarID(for calendar: EKCalendar) -> String { calendar.calendarIdentifier }
    func events(in calendar: EKCalendar, start: Date, end: Date) throws -> [EKEvent] {
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: [calendar])
        return store.events(matching: predicate)
    }
    func occurrence(for event: EKEvent) -> NativeCalendarEventOpenOccurrence? {
        guard let calendar = event.calendar, let start = event.startDate, let end = event.endDate else { return nil }
        return NativeCalendarEventOpenOccurrence(calendarID: calendar.calendarIdentifier,
            calendarItemIdentifier: event.calendarItemIdentifier, start: start, end: end, allDay: event.isAllDay)
    }
}
#endif
