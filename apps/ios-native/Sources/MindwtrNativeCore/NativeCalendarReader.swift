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

protocol NativeCalendarRecoveryReading: NativeCalendarReading {
    func event(eventID: String, calendarID: String) throws -> [String: Any]?
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
final class NativeCalendarReader: NativeCalendarWriteWitnessing, NativeCalendarRecoveryReading {
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
        return store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.map(eventValue)
    }

    func event(eventID: String, calendarID: String) throws -> [String: Any]? {
        try requireReadAccess()
        do {
            let event = try NativeCalendarWritePolicy.existingEvent(eventID: eventID, calendarID: calendarID, using: writeProvider())
            let value = event.map(eventValue)
            try requireReadAccess()
            return value
        } catch NativeCalendarWriteError.denied { throw NativeCalendarReadError.denied }
    }

    private func eventValue(_ event: EKEvent) -> [String: Any] {
        var value: [String: Any] = ["id": event.calendarItemIdentifier,
                                  "calendarId": event.calendar.calendarIdentifier,
                                  "allDay": event.isAllDay,
                                  "isRecurring": event.isDetached || !(event.recurrenceRules ?? []).isEmpty]
        if let title = event.title { value["title"] = title }
        if let start = event.startDate { value["startDate"] = formatter.string(from: start) }
        if let end = event.endDate { value["endDate"] = formatter.string(from: end) }
        if let notes = event.notes { value["notes"] = notes }
        if let location = event.location { value["location"] = location }
        if let url = event.url { value["url"] = url.absoluteString }
        if let zone = event.timeZone { value["timeZone"] = zone.identifier }
        return value
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

    private func writeProvider() -> EventKitCalendarWriteProvider {
        EventKitCalendarWriteProvider(store: { self.store })
    }
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue {
        try NativeCalendarWritePolicy.write(request, using: writeProvider(), beforeProviderMutation: beforeProviderMutation,
                                           confirmedMissingEvent: confirmedMissingEvent)
    }
    func sources() throws -> [NativeCalendarSource] {
        try NativeCalendarWritePolicy.sources(writeProvider())
    }
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String {
        try NativeCalendarWritePolicy.createCalendar(details, using: writeProvider())
    }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws {
        try NativeCalendarWritePolicy.updateCalendar(calendarID: calendarID, details: details, using: writeProvider())
    }
    func deleteCalendar(calendarID: String) throws {
        try NativeCalendarWritePolicy.deleteCalendar(calendarID: calendarID, using: writeProvider())
    }
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String {
        try NativeCalendarWritePolicy.createEvent(calendarID: calendarID, details: details, using: writeProvider())
    }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws {
        try NativeCalendarWritePolicy.updateEvent(eventID: eventID, calendarID: calendarID, details: details, using: writeProvider())
    }
    func deleteEvent(eventID: String, calendarID: String) throws {
        try NativeCalendarWritePolicy.deleteEvent(eventID: eventID, calendarID: calendarID, using: writeProvider())
    }
}

/// A per-call view of the reader's retained store, used only on its serial worker.
private final class EventKitCalendarWriteProvider: NativeCalendarWriteProviding {
    private let retainedStore: () -> EKEventStore
    private var store: EKEventStore { retainedStore() }
    init(store: @escaping () -> EKEventStore) { retainedStore = store }
    func permissions() throws -> NativeCalendarPermission {
        NativeCalendarReader.permission(EKEventStore.authorizationStatus(for: .event))
    }
    func sources() throws -> [EKSource] { store.sources }
    func source(_ value: EKSource) -> NativeCalendarSource {
        let type: NativeCalendarSourceType
        switch value.sourceType {
        case .local: type = .local
        case .exchange: type = .exchange
        case .calDAV: type = .caldav
        case .mobileMe: type = .mobileme
        case .subscribed: type = .subscribed
        case .birthdays: type = .birthdays
        @unknown default: type = .unknown
        }
        return NativeCalendarSource(id: value.sourceIdentifier, name: value.title, type: type)
    }
    func calendars() throws -> [EKCalendar] { store.calendars(for: .event) }
    func target(_ value: EKCalendar) -> NativeCalendarWriteTarget {
        NativeCalendarWriteTarget(id: value.calendarIdentifier, allowsEvents: value.allowedEntityTypes.contains(.event),
            allowsModifications: value.allowsContentModifications, immutable: value.isImmutable)
    }
    func events(eventID: String, calendar: EKCalendar) throws -> [EKEvent] {
        guard let item = store.calendarItem(withIdentifier: eventID) else { return [] }
        guard let event = item as? EKEvent else { throw NativeCalendarWriteError.invalid }
        guard let value = identity(event), NativeCalendarWriteValidation.equalID(value.id, eventID),
              NativeCalendarWriteValidation.equalID(value.calendarID, calendar.calendarIdentifier), !value.recurring,
              let start = event.startDate else { return [event] }
        let queryStart = Date(timeIntervalSince1970: max(NativeCalendarEventOpenRequest.minimumSeconds, start.timeIntervalSince1970 - 1))
        let queryEnd = Date(timeIntervalSince1970: min(NativeCalendarEventOpenRequest.maximumSeconds, start.timeIntervalSince1970 + 1))
        guard queryEnd > queryStart else { throw NativeCalendarWriteError.invalid }
        let predicate = store.predicateForEvents(withStart: queryStart, end: queryEnd, calendars: [calendar])
        let matches = store.events(matching: predicate).filter {
            NativeCalendarWriteValidation.equalID($0.calendarItemIdentifier, eventID)
        }
        // A lookup that exists but cannot be confirmed is uncertainty, not absence.
        guard !matches.isEmpty else { throw NativeCalendarWriteError.invalid }
        return matches
    }
    func identity(_ value: EKEvent) -> NativeCalendarWriteEventIdentity? {
        guard let calendar = value.calendar, let start = value.startDate, let end = value.endDate,
              NativeCalendarEventOpenRequest.validDate(start), NativeCalendarEventOpenRequest.validDate(end), end > start else { return nil }
        return NativeCalendarWriteEventIdentity(id: value.calendarItemIdentifier, calendarID: calendar.calendarIdentifier,
            recurring: value.isDetached || !(value.recurrenceRules ?? []).isEmpty)
    }
    private func color(_ raw: String) -> CGColor {
        let value = UInt32(raw.dropFirst(), radix: 16)!
        return CGColor(red: CGFloat((value >> 16) & 255) / 255,
            green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
    }
    func createCalendar(_ details: NativeCalendarCreateDetails, source: EKSource) throws -> String {
        let calendar = EKCalendar(for: .event, eventStore: store)
        calendar.source = source; calendar.title = details.title; calendar.cgColor = color(details.color)
        try store.saveCalendar(calendar, commit: true)
        return calendar.calendarIdentifier
    }
    func updateCalendar(_ details: NativeCalendarUpdateDetails, calendar: EKCalendar) throws {
        calendar.cgColor = color(details.color)
        if let title = details.title { calendar.title = title }
        try store.saveCalendar(calendar, commit: true)
    }
    func deleteCalendar(_ calendar: EKCalendar) throws { try store.removeCalendar(calendar, commit: true) }
    private func apply(_ details: NativeCalendarEventDetails, to event: EKEvent) {
        event.title = details.title; event.startDate = details.start; event.endDate = details.end
        event.isAllDay = details.allDay; event.notes = details.notes; event.location = details.location
        // Expo iOS has one event timeZone and ignores endTimeZone; both were validated.
        if let zone = details.timeZone { event.timeZone = TimeZone(identifier: zone) }
        if let url = details.url { event.url = URL(string: url) }
        event.alarms = []
        event.availability = .notSupported
    }
    func createEvent(_ details: NativeCalendarEventDetails, calendar: EKCalendar) throws -> String {
        let event = EKEvent(eventStore: store); event.calendar = calendar
        apply(details, to: event)
        try store.save(event, span: .thisEvent, commit: true)
        return event.calendarItemIdentifier
    }
    func updateEvent(_ details: NativeCalendarEventDetails, event: EKEvent) throws {
        apply(details, to: event)
        try store.save(event, span: .thisEvent, commit: true)
    }
    func deleteEvent(_ event: EKEvent) throws { try store.remove(event, span: .thisEvent, commit: true) }
}
#else
final class NativeCalendarReader: NativeCalendarWriteWitnessing, NativeCalendarRecoveryReading {
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue { throw NativeCalendarWriteError.unavailable }
    func permissions() throws -> NativeCalendarPermission { throw NativeCalendarReadError.unavailable }
    func calendars() throws -> [[String: Any]] { throw NativeCalendarReadError.unavailable }
    func events(calendarIds: [String], start: Date, end: Date) throws -> [[String: Any]] {
        throw NativeCalendarReadError.unavailable
    }
    func event(eventID: String, calendarID: String) throws -> [String: Any]? { throw NativeCalendarReadError.unavailable }
    func sources() throws -> [NativeCalendarSource] { throw NativeCalendarWriteError.unavailable }
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteCalendar(calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String { throw NativeCalendarWriteError.unavailable }
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws { throw NativeCalendarWriteError.unavailable }
    func deleteEvent(eventID: String, calendarID: String) throws { throw NativeCalendarWriteError.unavailable }
}
#endif
