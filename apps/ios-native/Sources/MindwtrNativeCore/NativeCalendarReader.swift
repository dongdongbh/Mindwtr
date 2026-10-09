import Foundation

enum NativeCalendarPermission: String {
    case granted, denied, undetermined
}

enum NativeCalendarReadError: Error {
    case denied, unavailable
}

/// Only plain values cross the calendar worker; reads never request permission.
protocol NativeCalendarReading: AnyObject {
    func permissions() throws -> NativeCalendarPermission
    func calendars() throws -> [[String: Any]]
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]]
}

enum NativeCalendarIDs {
    static func selected(_ requested: [String], available: [String]) -> Set<Data> {
        // Swift String equality folds canonically equivalent Unicode IDs.
        Set(requested.map { Data($0.utf8) }).intersection(available.map { Data($0.utf8) })
    }
}

#if os(iOS) && canImport(EventKit)
import EventKit
import CoreGraphics

/// Created, used and released by NativeCalendarJobs' one serial worker.
final class NativeCalendarReader: NativeCalendarReading {
    private var ownedStore: EKEventStore?
    private let formatter: DateFormatter = {
        let value = DateFormatter()
        value.timeZone = TimeZone(identifier: "UTC")
        value.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ"
        value.locale = Locale(identifier: "en_US_POSIX")
        return value
    }()

    private var store: EKEventStore {
        if let ownedStore { return ownedStore }
        let value = EKEventStore(); ownedStore = value; return value
    }

    static func permission(_ status: EKAuthorizationStatus) -> NativeCalendarPermission {
        if #available(iOS 17.0, *) {
            switch status {
            case .fullAccess: return .granted
            case .writeOnly, .denied, .restricted: return .denied
            case .notDetermined: return .undetermined
            default: return .undetermined
            }
        }
        switch status {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        default: return .undetermined
        }
    }

    func permissions() throws -> NativeCalendarPermission {
        Self.permission(EKEventStore.authorizationStatus(for: .event))
    }

    private func requireReadAccess() throws {
        guard try permissions() == .granted else { throw NativeCalendarReadError.denied }
    }

    func calendars() throws -> [[String: Any]] {
        try requireReadAccess()
        return store.calendars(for: .event).map { calendar in
            var value: [String: Any] = [
                "id": calendar.calendarIdentifier, "title": calendar.title,
                "type": Self.calendarType(calendar.type, source: calendar.source.sourceType),
                "allowsModifications": calendar.allowsContentModifications,
                "source": ["id": calendar.source.sourceIdentifier, "name": calendar.source.title,
                           "type": Self.sourceType(calendar.source.sourceType)]
            ]
            if let color = calendar.cgColor { value["color"] = Self.color(color) }
            return value
        }
    }

    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        try requireReadAccess()
        guard !calendarIds.isEmpty else { return [] }
        let calendars = store.calendars(for: .event)
        let ids = NativeCalendarIDs.selected(calendarIds, available: calendars.map { $0.calendarIdentifier })
        let selected = calendars.filter { ids.contains(Data($0.calendarIdentifier.utf8)) }
        // EventKit's nil/empty predicate can select every calendar.
        guard !selected.isEmpty else { return [] }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: selected)
        return store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map { event in
            var value: [String: Any] = ["id": event.calendarItemIdentifier,
                                      "calendarId": event.calendar.calendarIdentifier,
                                      "allDay": event.isAllDay]
            if let title = event.title { value["title"] = title }
            if let start = event.startDate { value["startDate"] = formatter.string(from: start) }
            if let end = event.endDate { value["endDate"] = formatter.string(from: end) }
            if let notes = event.notes { value["notes"] = notes }
            if let location = event.location { value["location"] = location }
            return value
        }
    }

    private static func sourceType(_ type: EKSourceType) -> String {
        switch type {
        case .local: return "local"
        case .exchange: return "exchange"
        case .calDAV: return "caldav"
        case .mobileMe: return "mobileme"
        case .subscribed: return "subscribed"
        case .birthdays: return "birthdays"
        @unknown default: return "local"
        }
    }

    private static func calendarType(_ type: EKCalendarType, source: EKSourceType) -> String {
        switch type {
        case .local: return "local"
        case .calDAV: return "caldav"
        case .exchange: return "exchange"
        case .subscription: return "subscribed"
        case .birthday: return "birthdays"
        default: return sourceType(source)
        }
    }

    private static func color(_ color: CGColor) -> String? {
        guard let values = color.components else { return nil }
        let rgb: [CGFloat]
        if values.count == 2 { rgb = [values[0], values[0], values[0]] }
        else if values.count >= 3 { rgb = Array(values.prefix(3)) }
        else { return nil }
        return String(format: "#%02X%02X%02X", Int((rgb[0] * 255).rounded()),
                      Int((rgb[1] * 255).rounded()), Int((rgb[2] * 255).rounded()))
    }
}
#else
final class NativeCalendarReader: NativeCalendarReading {
    func permissions() throws -> NativeCalendarPermission { throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        throw NativeCalendarReadError.unavailable
    }
}
#endif
