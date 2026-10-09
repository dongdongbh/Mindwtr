import CoreFoundation
import Foundation

/// Closed values only: parsing never authorizes provider, mapping or device-state effects.
enum NativeCalendarPushRequest: Sendable {
    enum Read: Sendable {
        case permissions, calendars
        case events([String], Date, Date)
    }

    case read(Read, requestJSON: String)
    case sources
    case write(NativeCalendarWriteRequest, requestJSON: String, taskID: String?)
    case ackMapping(operationID: UUID, entry: NativeCalendarPushMapping?)
    case deleteMapping(expected: NativeCalendarPushMapping)
    case mapping(taskID: String)
    case mappings, readState
    case setState(name: String, value: String?)

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
        case "read":
            try fields(object, ["op", "request"])
            let request = try nestedObject(object["request"])
            return .read(try read(request), requestJSON: try canonical(request))
        case "sources":
            try fields(object, ["op"]); return .sources
        case "write":
            try fields(object, ["op", "request", "taskId"])
            let requestJSON = try canonical(nestedObject(object["request"]))
            let request = try NativeCalendarWriteRequest(json: requestJSON)
            if case .sources = request { throw NativeCalendarWriteError.invalid }
            let taskID = try optionalText(object, "taskId")
            guard taskID.map(NativeCalendarWriteValidation.id) ?? true else { throw NativeCalendarWriteError.invalid }
            return .write(request, requestJSON: requestJSON, taskID: taskID)
        case "ackMapping":
            try fields(object, ["op", "operationId", "entry"])
            let rawID = try text(object, "operationId")
            guard let operationID = UUID(uuidString: rawID),
                  NativeCalendarWriteValidation.equalID(rawID, operationID.uuidString.lowercased()) else {
                throw NativeCalendarWriteError.invalid
            }
            let entry: NativeCalendarPushMapping?
            if object["entry"] is NSNull { entry = nil }
            else { entry = try mapping(object["entry"]) }
            return .ackMapping(operationID: operationID, entry: entry)
        case "deleteMapping":
            try fields(object, ["op", "expected"])
            return .deleteMapping(expected: try mapping(object["expected"]))
        case "mapping":
            try fields(object, ["op", "taskId"])
            let taskID = try text(object, "taskId")
            guard NativeCalendarWriteValidation.id(taskID) else { throw NativeCalendarWriteError.invalid }
            return .mapping(taskID: taskID)
        case "mappings":
            try fields(object, ["op"]); return .mappings
        case "readState":
            try fields(object, ["op"]); return .readState
        case "setState":
            try fields(object, ["op", "name", "value"])
            let name = try text(object, "name"), value = try optionalText(object, "value")
            let names = ["enabled", "calendar-id", "target-calendar-id", "color", "creation-intent"]
            guard names.contains(where: { NativeCalendarWriteValidation.equalID(name, "mindwtr:calendar-push-sync:" + $0) }),
                  value.map(NativeCalendarWriteValidation.text) ?? true else { throw NativeCalendarWriteError.invalid }
            return .setState(name: name, value: value)
        default: throw NativeCalendarWriteError.invalid
        }
    }

    private static func read(_ object: [String: Any]) throws -> Read {
        switch try text(object, "op") {
        case "permissions":
            try fields(object, ["op"]); return .permissions
        case "calendars":
            try fields(object, ["op"]); return .calendars
        case "events":
            try fields(object, ["op", "calendarIds", "startMs", "endMs"])
            guard let ids = object["calendarIds"] as? [String], ids.count <= 1024,
                  ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }) else { throw NativeCalendarWriteError.invalid }
            let start = try milliseconds(object["startMs"]), end = try milliseconds(object["endMs"])
            guard end > start, end - start <= 366 * 86_400_000 else { throw NativeCalendarWriteError.invalid }
            return .events(ids, Date(timeIntervalSince1970: start / 1000), Date(timeIntervalSince1970: end / 1000))
        default: throw NativeCalendarWriteError.invalid
        }
    }

    private static func milliseconds(_ value: Any?) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw NativeCalendarWriteError.invalid }
        let value = number.doubleValue
        guard value.isFinite, value.rounded(.down) == value,
              NativeCalendarEventOpenRequest.validDate(Date(timeIntervalSince1970: value / 1000)) else {
            throw NativeCalendarWriteError.invalid
        }
        return value
    }
    private static func mapping(_ value: Any?) throws -> NativeCalendarPushMapping {
        let row = try nestedObject(value)
        try fields(row, ["taskId", "calendarEventId", "calendarId", "platform", "lastSyncedAt"])
        return try NativeCalendarPushMapping(taskId: text(row, "taskId"), calendarEventId: text(row, "calendarEventId"),
                                             calendarId: text(row, "calendarId"), platform: text(row, "platform"),
                                             lastSyncedAt: text(row, "lastSyncedAt"))
    }
    private static func fields(_ object: [String: Any], _ names: Set<String>) throws {
        guard Set(object.keys) == names else { throw NativeCalendarWriteError.invalid }
    }
    private static func nestedObject(_ value: Any?) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw NativeCalendarWriteError.invalid }
        return object
    }
    private static func text(_ object: [String: Any], _ name: String) throws -> String {
        guard let value = object[name] as? String else { throw NativeCalendarWriteError.invalid }
        return value
    }
    private static func optionalText(_ object: [String: Any], _ name: String) throws -> String? {
        if object[name] is NSNull { return nil }
        return try text(object, name)
    }
    private static func canonical(_ object: [String: Any]) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard bytes.count <= NativeCalendarJobs.maximumRequestBytes else { throw NativeCalendarWriteError.invalid }
        return String(decoding: bytes, as: UTF8.self)
    }
}
