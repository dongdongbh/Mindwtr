import CoreFoundation
import Foundation

struct NativeCalendarPushMapping: Equatable, Sendable {
    let taskId: String
    let calendarEventId: String
    let calendarId: String
    let platform: String
    let lastSyncedAt: String

    init(taskId: String, calendarEventId: String, calendarId: String, platform: String, lastSyncedAt: String) throws {
        guard NativeCalendarWriteValidation.id(taskId), NativeCalendarWriteValidation.id(calendarEventId),
              NativeCalendarWriteValidation.id(calendarId), NativeCalendarWriteValidation.equalID(platform, "ios"),
              !lastSyncedAt.isEmpty, lastSyncedAt.utf8.count <= 128 else { throw NativeCalendarWriteError.invalid }
        self.taskId = taskId; self.calendarEventId = calendarEventId; self.calendarId = calendarId
        self.platform = platform; self.lastSyncedAt = lastSyncedAt
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        NativeCalendarWriteValidation.equalID(lhs.taskId, rhs.taskId) &&
        NativeCalendarWriteValidation.equalID(lhs.calendarEventId, rhs.calendarEventId) &&
        NativeCalendarWriteValidation.equalID(lhs.calendarId, rhs.calendarId) &&
        NativeCalendarWriteValidation.equalID(lhs.platform, rhs.platform) &&
        NativeCalendarWriteValidation.equalID(lhs.lastSyncedAt, rhs.lastSyncedAt)
    }

    fileprivate var json: [String: Any] {
        ["taskId": taskId, "calendarEventId": calendarEventId, "calendarId": calendarId,
         "platform": platform, "lastSyncedAt": lastSyncedAt]
    }
}

/// Frozen recovery state only; a matching identity does not authorize a provider or storage write.
struct NativeCalendarPushEffect: Sendable {
    enum Phase: String, Sendable { case prepared, started, saved, acknowledging }
    enum Result: Equatable, Sendable {
        case identifier(String), completed, missingEvent

        static func == (lhs: Self, rhs: Self) -> Bool {
            switch (lhs, rhs) {
            case (.identifier(let first), .identifier(let second)): return NativeCalendarWriteValidation.equalID(first, second)
            case (.completed, .completed), (.missingEvent, .missingEvent): return true
            default: return false
            }
        }

        fileprivate var json: [String: Any] {
            switch self {
            case .identifier(let id): return ["kind": "identifier", "id": id]
            case .completed: return ["kind": "completed"]
            case .missingEvent: return ["kind": "missingEvent"]
            }
        }
    }

    let id: UUID
    let libraryID: String
    let requestJSON: String
    let request: NativeCalendarWriteRequest
    let taskID: String?
    let beforeMapping: NativeCalendarPushMapping?
    let phase: Phase
    let result: Result?
    let afterMapping: NativeCalendarPushMapping?

    init(id: UUID = UUID(), libraryID: String, requestJSON: String, taskID: String? = nil,
         beforeMapping: NativeCalendarPushMapping? = nil) throws {
        try self.init(id: id, libraryID: libraryID, requestJSON: requestJSON,
                      request: NativeCalendarWriteRequest(json: requestJSON), taskID: taskID,
                      beforeMapping: beforeMapping, phase: .prepared, result: nil, afterMapping: nil)
    }

    init(json: String) throws {
        do {
            guard json.utf8.count <= NativeCalendarJobs.maximumRequestBytes, try NativeJSON.hasUniqueObjectKeys(json),
                  let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
                throw NativeCalendarWriteError.invalid
            }
            try Self.fields(value, ["version", "id", "libraryId", "requestJSON", "taskId", "beforeMapping", "phase", "result", "afterMapping"])
            guard let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
                  version.doubleValue == 1,
                  let idText = value["id"] as? String, let id = UUID(uuidString: idText),
                  NativeCalendarWriteValidation.equalID(idText, id.uuidString.lowercased()),
                  let phase = Phase(rawValue: try Self.text(value, "phase")) else { throw NativeCalendarWriteError.invalid }
            let raw = try Self.text(value, "requestJSON")
            try self.init(id: id, libraryID: Self.text(value, "libraryId"), requestJSON: raw,
                          request: NativeCalendarWriteRequest(json: raw), taskID: Self.optionalText(value, "taskId"),
                          beforeMapping: Self.mapping(value["beforeMapping"]), phase: phase,
                          result: Self.result(value["result"]), afterMapping: Self.mapping(value["afterMapping"]))
        } catch { throw NativeCalendarWriteError.invalid }
    }

    private init(id: UUID, libraryID: String, requestJSON: String, request: NativeCalendarWriteRequest,
                 taskID: String?, beforeMapping: NativeCalendarPushMapping?, phase: Phase,
                 result: Result?, afterMapping: NativeCalendarPushMapping?) throws {
        self.id = id; self.libraryID = libraryID; self.requestJSON = requestJSON; self.request = request
        self.taskID = taskID; self.beforeMapping = beforeMapping; self.phase = phase
        self.result = result; self.afterMapping = afterMapping
        _ = try encoded()
    }

    func markingStarted() throws -> Self {
        guard phase == .prepared else { throw NativeCalendarWriteError.invalid }
        return try transitioned(to: .started, result: nil, mapping: nil)
    }

    func recording(result: Result) throws -> Self {
        guard phase == .started else { throw NativeCalendarWriteError.invalid }
        return try transitioned(to: .saved, result: result, mapping: nil)
    }

    func acknowledging(mapping: NativeCalendarPushMapping?) throws -> Self {
        guard phase == .saved else { throw NativeCalendarWriteError.invalid }
        return try transitioned(to: .acknowledging, result: result, mapping: mapping)
    }

    private func transitioned(to phase: Phase, result: Result?, mapping: NativeCalendarPushMapping?) throws -> Self {
        try Self(id: id, libraryID: libraryID, requestJSON: requestJSON, request: request, taskID: taskID,
                 beforeMapping: beforeMapping, phase: phase, result: result, afterMapping: mapping)
    }

    func encoded() throws -> String {
        try validate()
        let value: [String: Any] = [
            "version": 1, "id": id.uuidString.lowercased(), "libraryId": libraryID, "requestJSON": requestJSON,
            "taskId": taskID as Any? ?? NSNull(), "beforeMapping": beforeMapping?.json as Any? ?? NSNull(),
            "phase": phase.rawValue, "result": result?.json as Any? ?? NSNull(),
            "afterMapping": afterMapping?.json as Any? ?? NSNull(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              data.count <= NativeCalendarJobs.maximumRequestBytes else { throw NativeCalendarWriteError.invalid }
        return String(decoding: data, as: UTF8.self)
    }

    private func validate() throws {
        guard !libraryID.isEmpty, libraryID.utf8.count <= 1024,
              taskID.map(NativeCalendarWriteValidation.id) ?? true else { throw NativeCalendarWriteError.invalid }
        switch request {
        case .sources: throw NativeCalendarWriteError.invalid
        case .createCalendar, .updateCalendar, .deleteCalendar:
            guard taskID == nil, beforeMapping == nil else { throw NativeCalendarWriteError.invalid }
        case .createEvent:
            guard taskID != nil, beforeMapping == nil else { throw NativeCalendarWriteError.invalid }
        case .updateEvent(let event, let calendar, _), .deleteEvent(let event, let calendar):
            guard let taskID, let beforeMapping,
                  Self.matches(beforeMapping, task: taskID, calendar: calendar, event: event) else {
                throw NativeCalendarWriteError.invalid
            }
        }
        switch phase {
        case .prepared, .started:
            guard result == nil, afterMapping == nil else { throw NativeCalendarWriteError.invalid }
        case .saved, .acknowledging:
            guard let result else { throw NativeCalendarWriteError.invalid }
            switch (request, result) {
            case (.createCalendar, .identifier(let id)), (.createEvent, .identifier(let id)):
                guard NativeCalendarWriteValidation.id(id) else { throw NativeCalendarWriteError.invalid }
            case (.updateCalendar, .completed), (.deleteCalendar, .completed),
                 (.updateEvent, .completed), (.deleteEvent, .completed),
                 (.updateEvent, .missingEvent), (.deleteEvent, .missingEvent): break
            default: throw NativeCalendarWriteError.invalid
            }
            if phase == .saved {
                guard afterMapping == nil else { throw NativeCalendarWriteError.invalid }
            } else {
                switch (request, result) {
                case (.createEvent(let calendar, _), .identifier(let event)):
                    guard let taskID, let afterMapping,
                          Self.matches(afterMapping, task: taskID, calendar: calendar, event: event) else {
                        throw NativeCalendarWriteError.invalid
                    }
                case (.updateEvent(let event, let calendar, _), .completed):
                    guard let taskID, let afterMapping,
                          Self.matches(afterMapping, task: taskID, calendar: calendar, event: event) else {
                        throw NativeCalendarWriteError.invalid
                    }
                default:
                    guard afterMapping == nil else { throw NativeCalendarWriteError.invalid }
                }
            }
        }
    }

    private static func matches(_ row: NativeCalendarPushMapping, task: String, calendar: String, event: String) -> Bool {
        NativeCalendarWriteValidation.equalID(row.taskId, task) &&
        NativeCalendarWriteValidation.equalID(row.calendarId, calendar) &&
        NativeCalendarWriteValidation.equalID(row.calendarEventId, event) &&
        NativeCalendarWriteValidation.equalID(row.platform, "ios")
    }

    private static func fields(_ value: [String: Any], _ names: Set<String>) throws {
        guard Set(value.keys) == names else { throw NativeCalendarWriteError.invalid }
    }
    private static func text(_ value: [String: Any], _ name: String) throws -> String {
        guard let text = value[name] as? String else { throw NativeCalendarWriteError.invalid }
        return text
    }
    private static func optionalText(_ value: [String: Any], _ name: String) throws -> String? {
        if value[name] is NSNull { return nil }
        return try text(value, name)
    }
    private static func mapping(_ value: Any?) throws -> NativeCalendarPushMapping? {
        if value is NSNull { return nil }
        guard let row = value as? [String: Any] else { throw NativeCalendarWriteError.invalid }
        try fields(row, ["taskId", "calendarEventId", "calendarId", "platform", "lastSyncedAt"])
        return try NativeCalendarPushMapping(taskId: text(row, "taskId"), calendarEventId: text(row, "calendarEventId"),
                                             calendarId: text(row, "calendarId"), platform: text(row, "platform"),
                                             lastSyncedAt: text(row, "lastSyncedAt"))
    }
    private static func result(_ value: Any?) throws -> Result? {
        if value is NSNull { return nil }
        guard let result = value as? [String: Any] else { throw NativeCalendarWriteError.invalid }
        switch try text(result, "kind") {
        case "identifier":
            try fields(result, ["kind", "id"])
            return .identifier(try text(result, "id"))
        case "completed":
            try fields(result, ["kind"]); return .completed
        case "missingEvent":
            try fields(result, ["kind"]); return .missingEvent
        default: throw NativeCalendarWriteError.invalid
        }
    }
}
