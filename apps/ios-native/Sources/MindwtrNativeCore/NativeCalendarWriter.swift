import Foundation

enum NativeCalendarWriteError: Error, LocalizedError, Equatable, Sendable {
    case denied, unavailable, missingCalendar, missingSource, missingEvent
    case invalid, readOnly, ambiguous, recurring, failed

    var errorDescription: String? {
        switch self {
        case .denied: return "Calendar write access is denied"
        case .unavailable: return "Calendar writing is unavailable"
        case .missingCalendar: return "Calendar write target is missing"
        case .missingSource: return "Calendar source is missing"
        case .missingEvent: return "event-not-found"
        case .invalid: return "Calendar write request is invalid"
        case .readOnly: return "Calendar write target is read-only"
        case .ambiguous: return "Calendar write identity is ambiguous"
        case .recurring: return "Recurring calendar events cannot be changed"
        case .failed: return "Calendar write failed"
        }
    }
}

enum NativeCalendarSourceType: String, Sendable {
    case local, exchange, caldav, mobileme, subscribed, birthdays, unknown
    var supportsCreation: Bool {
        switch self {
        case .local, .exchange, .caldav, .mobileme: return true
        case .subscribed, .birthdays, .unknown: return false
        }
    }
}

struct NativeCalendarSource: Sendable {
    let id: String
    let name: String
    let type: NativeCalendarSourceType
}

/// Event calendars only; source selection and scheduling remain shared policy.
struct NativeCalendarCreateDetails: Sendable {
    let title: String
    let color: String
    let sourceID: String

    init(title: String, color: String, sourceID: String) throws {
        guard NativeCalendarWriteValidation.title(title), NativeCalendarWriteValidation.color(color),
              NativeCalendarWriteValidation.id(sourceID) else { throw NativeCalendarWriteError.invalid }
        self.title = title; self.color = color; self.sourceID = sourceID
        try NativeCalendarWriteValidation.frame(["op": "createCalendar", "details": json])
    }
    fileprivate var json: [String: Any] {
        ["title": title, "color": color, "entityType": "event", "sourceId": sourceID]
    }
}

struct NativeCalendarUpdateDetails: Sendable {
    let color: String
    let title: String?

    init(color: String, title: String? = nil) throws {
        guard NativeCalendarWriteValidation.color(color), title.map(NativeCalendarWriteValidation.title) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        self.color = color; self.title = title
        try NativeCalendarWriteValidation.frame(["op": "updateCalendar", "details": json])
    }
    fileprivate var json: [String: Any] {
        var value: [String: Any] = ["color": color]
        if let title { value["title"] = title }
        return value
    }
}

struct NativeCalendarEventDetails: Sendable {
    let title: String
    let start: Date
    let end: Date
    let allDay: Bool
    let notes: String
    let location: String
    let url: String?
    let timeZone: String?
    let endTimeZone: String?

    init(title: String, start: Date, end: Date, allDay: Bool, notes: String, location: String,
         url: String? = nil, timeZone: String? = nil, endTimeZone: String? = nil) throws {
        guard NativeCalendarWriteValidation.title(title), NativeCalendarEventOpenRequest.validDate(start),
              NativeCalendarEventOpenRequest.validDate(end), end > start,
              NativeCalendarWriteValidation.text(notes), NativeCalendarWriteValidation.text(location),
              url.map(NativeCalendarWriteValidation.url) ?? true,
              timeZone.map(NativeCalendarWriteValidation.timeZone) ?? true,
              endTimeZone.map(NativeCalendarWriteValidation.timeZone) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        self.title = title; self.start = start; self.end = end; self.allDay = allDay
        self.notes = notes; self.location = location; self.url = url
        self.timeZone = timeZone; self.endTimeZone = endTimeZone
        try NativeCalendarWriteValidation.frame(["op": "createEvent", "details": json])
    }
    fileprivate var json: [String: Any] {
        var value: [String: Any] = ["title": title, "startMs": start.timeIntervalSince1970 * 1000,
            "endMs": end.timeIntervalSince1970 * 1000, "allDay": allDay, "notes": notes, "location": location]
        if let url { value["url"] = url }
        if let timeZone { value["timeZone"] = timeZone }
        if let endTimeZone { value["endTimeZone"] = endTimeZone }
        return value
    }
}

/// Not an authorization boundary: root must retain durable effect ownership
/// through provider completion and mapping acknowledgment before exposing it.
protocol NativeCalendarWriting: NativeCalendarReading {
    func sources() throws -> [NativeCalendarSource]
    func createCalendar(_ details: NativeCalendarCreateDetails) throws -> String
    func updateCalendar(calendarID: String, details: NativeCalendarUpdateDetails) throws
    func deleteCalendar(calendarID: String) throws
    func createEvent(calendarID: String, details: NativeCalendarEventDetails) throws -> String
    func updateEvent(eventID: String, calendarID: String, details: NativeCalendarEventDetails) throws
    func deleteEvent(eventID: String, calendarID: String) throws
}

/// Per-call proof on the serial worker, before mutable provider handles or stores are changed.
/// Unrefined writers remain uncertain on every error; callbacks cannot escape or authorize a write.
protocol NativeCalendarWriteWitnessing: NativeCalendarWriting {
    func writeWitnessed(_ request: NativeCalendarWriteRequest, beforeProviderMutation: () -> Void,
                        confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue
}

enum NativeCalendarWriteValidation {
    static func id(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 1024 && value.unicodeScalars.contains {
            !CharacterSet.whitespacesAndNewlines.contains($0) && $0.value != 0xfeff
        }
    }
    static func text(_ value: String) -> Bool { value.utf8.count <= NativeCalendarJobs.maximumRequestBytes }
    static func title(_ value: String) -> Bool {
        text(value) && value.unicodeScalars.contains {
            !CharacterSet.whitespacesAndNewlines.contains($0) && $0.value != 0xfeff
        }
    }
    static func color(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return bytes.count == 7 && bytes[0] == 35 && bytes.dropFirst().allSatisfy {
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }
    }
    static func url(_ value: String) -> Bool {
        guard text(value), !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let url = URL(string: value), let scheme = url.scheme?.lowercased() else { return false }
        return ["http", "https", "mailto"].contains(scheme)
    }
    static func timeZone(_ value: String) -> Bool { text(value) && TimeZone(identifier: value) != nil }
    static func equalID(_ first: String, _ second: String) -> Bool { Data(first.utf8) == Data(second.utf8) }
    static func frame(_ value: [String: Any]) throws {
        guard let bytes = try? JSONSerialization.data(withJSONObject: value),
              bytes.count <= NativeCalendarJobs.maximumRequestBytes else { throw NativeCalendarWriteError.invalid }
    }
}

struct NativeCalendarWriteTarget {
    let id: String
    let allowsEvents: Bool
    let allowsModifications: Bool
    let immutable: Bool
}

struct NativeCalendarWriteEventIdentity {
    let id: String
    let calendarID: String
    let recurring: Bool
}

/// Plain metadata and injected provider handles keep policy tests permission-free.
protocol NativeCalendarWriteProviding: AnyObject {
    associatedtype SourceValue
    associatedtype CalendarValue
    associatedtype EventValue
    func permissions() throws -> NativeCalendarPermission
    func sources() throws -> [SourceValue]
    func source(_ value: SourceValue) -> NativeCalendarSource
    func calendars() throws -> [CalendarValue]
    func target(_ value: CalendarValue) -> NativeCalendarWriteTarget
    func events(eventID: String, calendar: CalendarValue) throws -> [EventValue]
    func identity(_ value: EventValue) -> NativeCalendarWriteEventIdentity?
    func createCalendar(_ details: NativeCalendarCreateDetails, source: SourceValue) throws -> String
    func updateCalendar(_ details: NativeCalendarUpdateDetails, calendar: CalendarValue) throws
    func deleteCalendar(_ calendar: CalendarValue) throws
    func createEvent(_ details: NativeCalendarEventDetails, calendar: CalendarValue) throws -> String
    func updateEvent(_ details: NativeCalendarEventDetails, event: EventValue) throws
    func deleteEvent(_ event: EventValue) throws
}

enum NativeCalendarWritePolicy {
    static func sources<P: NativeCalendarWriteProviding>(_ provider: P) throws -> [NativeCalendarSource] {
        try fixedErrors {
            try requireAccess(provider)
            let values = try provider.sources().map(provider.source)
            try requireAccess(provider)
            guard values.allSatisfy({ NativeCalendarWriteValidation.id($0.id) }) else { throw NativeCalendarWriteError.failed }
            return values
        }
    }
    static func createCalendar<P: NativeCalendarWriteProviding>(_ details: NativeCalendarCreateDetails, using provider: P,
                                                               beforeProviderMutation: () -> Void = {}) throws -> String {
        try fixedErrors {
            try requireAccess(provider)
            let matches = try provider.sources().filter { NativeCalendarWriteValidation.equalID(provider.source($0).id, details.sourceID) }
            guard let source = matches.first else { throw NativeCalendarWriteError.missingSource }
            guard matches.count == 1 else { throw NativeCalendarWriteError.ambiguous }
            try requireAccess(provider)
            let current = provider.source(source)
            guard NativeCalendarWriteValidation.equalID(current.id, details.sourceID), current.type.supportsCreation else {
                throw NativeCalendarWriteError.invalid
            }
            beforeProviderMutation()
            return try resultID(provider.createCalendar(details, source: source))
        }
    }
    static func updateCalendar<P: NativeCalendarWriteProviding>(calendarID: String, details: NativeCalendarUpdateDetails, using provider: P,
                                                               beforeProviderMutation: () -> Void = {}) throws {
        try request(calendarID: calendarID, operation: "updateCalendar", details: details.json)
        try fixedErrors {
            let calendar = try target(calendarID, provider: provider)
            try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider, mutableCalendar: true)
            beforeProviderMutation()
            try provider.updateCalendar(details, calendar: calendar)
        }
    }
    static func deleteCalendar<P: NativeCalendarWriteProviding>(calendarID: String, using provider: P,
                                                               beforeProviderMutation: () -> Void = {}) throws {
        try request(calendarID: calendarID, operation: "deleteCalendar")
        try fixedErrors {
            let calendar = try target(calendarID, provider: provider)
            try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider, mutableCalendar: true)
            beforeProviderMutation()
            try provider.deleteCalendar(calendar)
        }
    }
    static func createEvent<P: NativeCalendarWriteProviding>(calendarID: String, details: NativeCalendarEventDetails, using provider: P,
                                                            beforeProviderMutation: () -> Void = {}) throws -> String {
        try request(calendarID: calendarID, operation: "createEvent", details: details.json)
        return try fixedErrors {
            let calendar = try target(calendarID, provider: provider)
            try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider)
            beforeProviderMutation()
            return try resultID(provider.createEvent(details, calendar: calendar))
        }
    }
    static func updateEvent<P: NativeCalendarWriteProviding>(eventID: String, calendarID: String, details: NativeCalendarEventDetails, using provider: P,
                                                            beforeProviderMutation: () -> Void = {}, confirmedMissingEvent: () -> Void = {}) throws {
        try request(calendarID: calendarID, eventID: eventID, operation: "updateEvent", details: details.json)
        try fixedErrors {
            let (calendar, event) = try exactEvent(eventID, calendarID: calendarID, provider: provider, confirmedMissingEvent: confirmedMissingEvent)
            try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider)
            try checkIdentity(event, eventID: eventID, calendarID: calendarID, provider: provider)
            beforeProviderMutation()
            try provider.updateEvent(details, event: event)
        }
    }
    static func deleteEvent<P: NativeCalendarWriteProviding>(eventID: String, calendarID: String, using provider: P,
                                                            beforeProviderMutation: () -> Void = {}, confirmedMissingEvent: () -> Void = {}) throws {
        try request(calendarID: calendarID, eventID: eventID, operation: "deleteEvent")
        try fixedErrors {
            let (calendar, event) = try exactEvent(eventID, calendarID: calendarID, provider: provider, confirmedMissingEvent: confirmedMissingEvent)
            try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider)
            try checkIdentity(event, eventID: eventID, calendarID: calendarID, provider: provider)
            beforeProviderMutation()
            try provider.deleteEvent(event)
        }
    }

    static func write<P: NativeCalendarWriteProviding>(_ request: NativeCalendarWriteRequest, using provider: P,
        beforeProviderMutation: () -> Void, confirmedMissingEvent: () -> Void) throws -> NativeCalendarWriteValue {
        switch request {
        case .sources: return .sources(try sources(provider))
        case .createCalendar(let details):
            return .identifier(try createCalendar(details, using: provider, beforeProviderMutation: beforeProviderMutation))
        case .updateCalendar(let id, let details):
            try updateCalendar(calendarID: id, details: details, using: provider, beforeProviderMutation: beforeProviderMutation)
        case .deleteCalendar(let id):
            try deleteCalendar(calendarID: id, using: provider, beforeProviderMutation: beforeProviderMutation)
        case .createEvent(let id, let details):
            return .identifier(try createEvent(calendarID: id, details: details, using: provider, beforeProviderMutation: beforeProviderMutation))
        case .updateEvent(let event, let calendar, let details):
            try updateEvent(eventID: event, calendarID: calendar, details: details, using: provider,
                beforeProviderMutation: beforeProviderMutation, confirmedMissingEvent: confirmedMissingEvent)
        case .deleteEvent(let event, let calendar):
            try deleteEvent(eventID: event, calendarID: calendar, using: provider,
                beforeProviderMutation: beforeProviderMutation, confirmedMissingEvent: confirmedMissingEvent)
        }
        return .completed
    }

    static func existingEvent<P: NativeCalendarWriteProviding>(eventID: String, calendarID: String, using provider: P) throws -> P.EventValue? {
        guard NativeCalendarWriteValidation.id(eventID), NativeCalendarWriteValidation.id(calendarID) else {
            throw NativeCalendarWriteError.invalid
        }
        return try findEvent(eventID, calendarID: calendarID, provider: provider)?.1
    }

    private static func request(calendarID: String, eventID: String? = nil, operation: String, details: [String: Any]? = nil) throws {
        guard NativeCalendarWriteValidation.id(calendarID), eventID.map(NativeCalendarWriteValidation.id) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        var value: [String: Any] = ["op": operation, "calendarId": calendarID]
        if let eventID { value["eventId"] = eventID }
        if let details { value["details"] = details }
        try NativeCalendarWriteValidation.frame(value)
    }
    private static func target<P: NativeCalendarWriteProviding>(_ id: String, provider: P) throws -> P.CalendarValue {
        guard let calendar = try findTarget(id, provider: provider) else { throw NativeCalendarWriteError.missingCalendar }
        return calendar
    }
    private static func findTarget<P: NativeCalendarWriteProviding>(_ id: String, provider: P) throws -> P.CalendarValue? {
        try requireAccess(provider)
        let calendars = try provider.calendars()
        try requireAccess(provider)
        let matches = calendars.filter { NativeCalendarWriteValidation.equalID(provider.target($0).id, id) }
        guard let calendar = matches.first else { return nil }
        guard matches.count == 1 else { throw NativeCalendarWriteError.ambiguous }
        return calendar
    }
    private static func writable<P: NativeCalendarWriteProviding>(_ calendar: P.CalendarValue, id: String, provider: P, mutableCalendar: Bool = false) throws {
        let value = provider.target(calendar)
        guard NativeCalendarWriteValidation.equalID(value.id, id), value.allowsEvents else { throw NativeCalendarWriteError.invalid }
        guard value.allowsModifications, !mutableCalendar || !value.immutable else { throw NativeCalendarWriteError.readOnly }
    }
    private static func exactEvent<P: NativeCalendarWriteProviding>(_ id: String, calendarID: String, provider: P,
        confirmedMissingEvent: () -> Void = {}) throws -> (P.CalendarValue, P.EventValue) {
        guard let result = try findEvent(id, calendarID: calendarID, provider: provider) else {
            confirmedMissingEvent()
            throw NativeCalendarWriteError.missingEvent
        }
        return result
    }
    private static func findEvent<P: NativeCalendarWriteProviding>(_ id: String, calendarID: String, provider: P) throws -> (P.CalendarValue, P.EventValue)? {
        guard let calendar = try findTarget(calendarID, provider: provider) else { return nil }
        try requireAccess(provider); try writable(calendar, id: calendarID, provider: provider)
        let matches = try provider.events(eventID: id, calendar: calendar)
        try requireAccess(provider)
        guard let event = matches.first else { return nil }
        guard matches.count == 1 else { throw NativeCalendarWriteError.ambiguous }
        try checkIdentity(event, eventID: id, calendarID: calendarID, provider: provider)
        return (calendar, event)
    }
    private static func checkIdentity<P: NativeCalendarWriteProviding>(_ event: P.EventValue, eventID: String, calendarID: String, provider: P) throws {
        guard let value = provider.identity(event), NativeCalendarWriteValidation.equalID(value.id, eventID),
              NativeCalendarWriteValidation.equalID(value.calendarID, calendarID) else { throw NativeCalendarWriteError.invalid }
        guard !value.recurring else { throw NativeCalendarWriteError.recurring }
    }
    private static func requireAccess<P: NativeCalendarWriteProviding>(_ provider: P) throws {
        guard try provider.permissions() == .granted else { throw NativeCalendarWriteError.denied }
    }
    private static func resultID(_ value: String) throws -> String {
        guard NativeCalendarWriteValidation.id(value) else { throw NativeCalendarWriteError.failed }
        return value
    }
    private static func fixedErrors<T>(_ operation: () throws -> T) throws -> T {
        do { return try operation() }
        catch let error as NativeCalendarWriteError { throw error }
        catch NativeCalendarReadError.denied { throw NativeCalendarWriteError.denied }
        catch NativeCalendarReadError.unavailable { throw NativeCalendarWriteError.unavailable }
        catch { throw NativeCalendarWriteError.failed }
    }
}
