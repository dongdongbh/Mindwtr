import CoreFoundation
import Foundation

/// Parsing proves the closed value grammar; the retained CoreHost owner must authorize effects separately.
enum NativeCalendarWriteRequest {
    case sources
    case createCalendar(NativeCalendarCreateDetails)
    case updateCalendar(String, NativeCalendarUpdateDetails)
    case deleteCalendar(String)
    case createEvent(String, NativeCalendarEventDetails)
    case updateEvent(String, String, NativeCalendarEventDetails)
    case deleteEvent(String, String)

    init(json: String) throws {
        do { self = try Self.parse(json) }
        catch { throw NativeCalendarWriteError.invalid }
    }

    private static func parse(_ json: String) throws -> Self {
        guard json.utf8.count <= NativeCalendarJobs.maximumRequestBytes,
              try NativeJSON.hasUniqueObjectKeys(json),
              let object = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let operation = object["op"] as? String else { throw NativeCalendarWriteError.invalid }
        switch operation {
        case "sources":
            try Self.fields(object, required: ["op"])
            return .sources
        case "createCalendar":
            try Self.fields(object, required: ["op", "details"])
            let details = try Self.object(object["details"])
            try Self.fields(details, required: ["title", "color", "entityType", "sourceId"])
            guard details["entityType"] as? String == "event" else { throw NativeCalendarWriteError.invalid }
            return .createCalendar(try NativeCalendarCreateDetails(title: Self.text(details, "title"),
                color: Self.text(details, "color"), sourceID: Self.text(details, "sourceId")))
        case "updateCalendar":
            try Self.fields(object, required: ["op", "calendarId", "details"])
            let details = try Self.object(object["details"])
            try Self.fields(details, required: ["color"], optional: ["title"])
            return .updateCalendar(try Self.id(object, "calendarId"),
                try NativeCalendarUpdateDetails(color: Self.text(details, "color"), title: Self.optionalText(details, "title")))
        case "deleteCalendar":
            try Self.fields(object, required: ["op", "calendarId"])
            return .deleteCalendar(try Self.id(object, "calendarId"))
        case "createEvent":
            try Self.fields(object, required: ["op", "calendarId", "details"])
            return .createEvent(try Self.id(object, "calendarId"), try Self.event(object["details"]))
        case "updateEvent":
            try Self.fields(object, required: ["op", "eventId", "calendarId", "details"])
            return .updateEvent(try Self.id(object, "eventId"), try Self.id(object, "calendarId"), try Self.event(object["details"]))
        case "deleteEvent":
            try Self.fields(object, required: ["op", "eventId", "calendarId"])
            return .deleteEvent(try Self.id(object, "eventId"), try Self.id(object, "calendarId"))
        default: throw NativeCalendarWriteError.invalid
        }
    }

    private static func fields(_ object: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        let names = Set(object.keys)
        guard required.isSubset(of: names), names.isSubset(of: required.union(optional)) else { throw NativeCalendarWriteError.invalid }
    }
    private static func object(_ value: Any?) throws -> [String: Any] {
        guard let value = value as? [String: Any] else { throw NativeCalendarWriteError.invalid }
        return value
    }
    private static func text(_ object: [String: Any], _ name: String) throws -> String {
        guard let value = object[name] as? String else { throw NativeCalendarWriteError.invalid }
        return value
    }
    private static func optionalText(_ object: [String: Any], _ name: String) throws -> String? {
        guard object[name] != nil else { return nil }
        return try text(object, name)
    }
    private static func id(_ object: [String: Any], _ name: String) throws -> String {
        let value = try text(object, name)
        guard NativeCalendarWriteValidation.id(value) else { throw NativeCalendarWriteError.invalid }
        return value
    }
    private static func date(_ object: [String: Any], _ name: String) throws -> Date {
        guard let value = object[name] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue.rounded(.down) == value.doubleValue else {
            throw NativeCalendarWriteError.invalid
        }
        return Date(timeIntervalSince1970: value.doubleValue / 1000)
    }
    private static func event(_ input: Any?) throws -> NativeCalendarEventDetails {
        let value = try object(input)
        try fields(value, required: ["title", "startMs", "endMs", "allDay", "notes", "location"],
                   optional: ["url", "timeZone", "endTimeZone"])
        guard let allDay = value["allDay"] as? NSNumber, CFGetTypeID(allDay) == CFBooleanGetTypeID() else {
            throw NativeCalendarWriteError.invalid
        }
        return try NativeCalendarEventDetails(title: text(value, "title"), start: date(value, "startMs"),
            end: date(value, "endMs"), allDay: allDay.boolValue, notes: text(value, "notes"), location: text(value, "location"),
            url: optionalText(value, "url"), timeZone: optionalText(value, "timeZone"), endTimeZone: optionalText(value, "endTimeZone"))
    }
}
