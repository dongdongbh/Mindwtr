import CoreFoundation
import Foundation

enum MindwtrWatchPayloadKind: String, CaseIterable {
    case text
    case audio
    case complete
    case deferTask = "defer"
    case pomodoro
}

struct MindwtrValidatedWatchPayload {
    let id: String
    let kind: MindwtrWatchPayloadKind
    let queuePayload: [String: Any]
}

enum MindwtrWatchPayloadValidationError: Error, Equatable {
    case invalidPayload
    case invalidField(String)
    case unsupportedKind
}

enum MindwtrWatchPayloadValidator {
    static let protocolVersion = 1
    static let source = "apple-watch"
    static let maxTitleCharacters = 2_000
    static let maxTitleBytes = 8_000
    static let maxTaskIdentifierBytes = 512
    static let maxFocusTasks = 20
    static let maxSnapshotTitleCharacters = 240
    static let maxApplicationContextBytes = 60 * 1_024

    private static let baseKeys: Set<String> = [
        "protocolVersion", "id", "createdAt", "source", "kind",
    ]

    private static let minimumTimestamp = Date(timeIntervalSince1970: 946_684_800) // 2000-01-01
    private static let maximumTimestamp = Date(timeIntervalSince1970: 4_102_444_800) // 2100-01-01

    private static let isoWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoWithoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func validateTransport(
        _ raw: [String: Any],
        expectedKind: MindwtrWatchPayloadKind? = nil
    ) throws -> MindwtrValidatedWatchPayload {
        guard integer(raw["protocolVersion"]) == protocolVersion else {
            throw MindwtrWatchPayloadValidationError.invalidField("protocolVersion")
        }
        guard raw["source"] as? String == source else {
            throw MindwtrWatchPayloadValidationError.invalidField("source")
        }
        guard let rawID = raw["id"] as? String,
              rawID.utf8.count == 36,
              let uuid = UUID(uuidString: rawID) else {
            throw MindwtrWatchPayloadValidationError.invalidField("id")
        }
        guard let kindValue = raw["kind"] as? String,
              let kind = MindwtrWatchPayloadKind(rawValue: kindValue) else {
            throw MindwtrWatchPayloadValidationError.unsupportedKind
        }
        if let expectedKind, kind != expectedKind {
            throw MindwtrWatchPayloadValidationError.invalidField("kind")
        }
        guard let createdAt = raw["createdAt"] as? String,
              validISO8601Timestamp(createdAt) else {
            throw MindwtrWatchPayloadValidationError.invalidField("createdAt")
        }

        let allowedKeys: Set<String>
        switch kind {
        case .text:
            allowedKeys = baseKeys.union(["title", "outboxRetried"])
        case .audio:
            allowedKeys = baseKeys.union(["outboxRetried"])
        case .complete:
            allowedKeys = baseKeys.union(["taskId"])
        case .deferTask:
            allowedKeys = baseKeys.union(["taskId", "startDate"])
        case .pomodoro:
            allowedKeys = baseKeys.union(["action", "taskId"])
        }
        guard Set(raw.keys).isSubset(of: allowedKeys) else {
            throw MindwtrWatchPayloadValidationError.invalidPayload
        }

        var queue: [String: Any] = [
            "protocolVersion": protocolVersion,
            "id": uuid.uuidString.lowercased(),
            "kind": kind.rawValue,
            "createdAt": createdAt,
            "source": source,
        ]
        if raw.keys.contains("outboxRetried") {
            guard strictBoolean(raw["outboxRetried"]) == true else {
                throw MindwtrWatchPayloadValidationError.invalidField("outboxRetried")
            }
            queue["outboxRetried"] = true
        }

        switch kind {
        case .text:
            guard let title = boundedTitle(raw["title"], maxCharacters: maxTitleCharacters, maxBytes: maxTitleBytes) else {
                throw MindwtrWatchPayloadValidationError.invalidField("title")
            }
            queue["title"] = title
        case .audio:
            break
        case .complete:
            queue["taskId"] = try taskIdentifier(raw["taskId"])
        case .deferTask:
            queue["taskId"] = try taskIdentifier(raw["taskId"])
            guard let startDate = raw["startDate"] as? String, validDateOnly(startDate) else {
                throw MindwtrWatchPayloadValidationError.invalidField("startDate")
            }
            queue["startDate"] = startDate
        case .pomodoro:
            guard let action = raw["action"] as? String,
                  ["start", "pause", "reset"].contains(action) else {
                throw MindwtrWatchPayloadValidationError.invalidField("action")
            }
            queue["action"] = action
            if raw.keys.contains("taskId") {
                queue["taskId"] = try taskIdentifier(raw["taskId"])
            }
        }

        return MindwtrValidatedWatchPayload(
            id: uuid.uuidString.lowercased(),
            kind: kind,
            queuePayload: queue
        )
    }

    static func normalizeApplicationContext(_ raw: [String: Any]) throws -> [String: Any] {
        guard let stripped = stripNullValues(raw) as? [String: Any],
              Set(stripped.keys) == Set(["protocolVersion", "generatedAt", "focus", "pomodoro"]) else {
            throw MindwtrWatchPayloadValidationError.invalidPayload
        }
        guard integer(stripped["protocolVersion"]) == protocolVersion else {
            throw MindwtrWatchPayloadValidationError.invalidField("protocolVersion")
        }
        guard let generatedAt = stripped["generatedAt"] as? String,
              validISO8601Timestamp(generatedAt) else {
            throw MindwtrWatchPayloadValidationError.invalidField("generatedAt")
        }
        guard let rawFocus = stripped["focus"] as? [[String: Any]],
              rawFocus.count <= maxFocusTasks else {
            throw MindwtrWatchPayloadValidationError.invalidField("focus")
        }

        let focus: [[String: Any]] = try rawFocus.map { item in
            guard Set(item.keys) == Set(["id", "title"]) else {
                throw MindwtrWatchPayloadValidationError.invalidField("focus")
            }
            let id = try taskIdentifier(item["id"])
            guard let title = boundedTitle(
                item["title"],
                maxCharacters: maxSnapshotTitleCharacters,
                maxBytes: maxSnapshotTitleCharacters * 4
            ) else {
                throw MindwtrWatchPayloadValidationError.invalidField("focus.title")
            }
            return ["id": id, "title": title]
        }

        guard let rawPomodoro = stripped["pomodoro"] as? [String: Any] else {
            throw MindwtrWatchPayloadValidationError.invalidField("pomodoro")
        }
        let pomodoroAllowedKeys: Set<String> = [
            "phase", "isRunning", "remainingSeconds", "phaseEndTime", "taskId", "taskTitle",
            "completionAlert",
        ]
        guard Set(rawPomodoro.keys).isSubset(of: pomodoroAllowedKeys),
              Set(rawPomodoro.keys).isSuperset(
                of: Set(["phase", "isRunning", "remainingSeconds"])
              ) else {
            throw MindwtrWatchPayloadValidationError.invalidField("pomodoro")
        }
        guard let phase = rawPomodoro["phase"] as? String,
              ["focus", "break"].contains(phase) else {
            throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.phase")
        }
        guard let isRunning = rawPomodoro["isRunning"] as? Bool else {
            throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.isRunning")
        }
        guard let remainingSeconds = integer(rawPomodoro["remainingSeconds"]),
              (0...86_400).contains(remainingSeconds) else {
            throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.remainingSeconds")
        }

        var pomodoro: [String: Any] = [
            "phase": phase,
            "isRunning": isRunning,
            "remainingSeconds": remainingSeconds,
        ]
        if rawPomodoro.keys.contains("phaseEndTime") {
            guard let phaseEndTime = number(rawPomodoro["phaseEndTime"]),
                  phaseEndTime.isFinite,
                  phaseEndTime >= minimumTimestamp.timeIntervalSince1970 * 1_000,
                  phaseEndTime <= maximumTimestamp.timeIntervalSince1970 * 1_000 else {
                throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.phaseEndTime")
            }
            pomodoro["phaseEndTime"] = phaseEndTime
        }
        if rawPomodoro.keys.contains("taskId") {
            pomodoro["taskId"] = try taskIdentifier(rawPomodoro["taskId"])
        }
        if rawPomodoro.keys.contains("taskTitle") {
            guard pomodoro["taskId"] != nil,
                  let taskTitle = boundedTitle(
                    rawPomodoro["taskTitle"],
                    maxCharacters: maxSnapshotTitleCharacters,
                    maxBytes: maxSnapshotTitleCharacters * 4
                  ) else {
                throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.taskTitle")
            }
            pomodoro["taskTitle"] = taskTitle
        }
        if rawPomodoro.keys.contains("completionAlert") {
            guard let completionAlert = rawPomodoro["completionAlert"] as? Bool else {
                throw MindwtrWatchPayloadValidationError.invalidField("pomodoro.completionAlert")
            }
            pomodoro["completionAlert"] = completionAlert
        }

        let normalized: [String: Any] = [
            "protocolVersion": protocolVersion,
            "generatedAt": generatedAt,
            "focus": focus,
            "pomodoro": pomodoro,
        ]
        guard PropertyListSerialization.propertyList(normalized, isValidFor: .binary),
              let encoded = try? PropertyListSerialization.data(
                fromPropertyList: normalized,
                format: .binary,
                options: 0
              ),
              encoded.count <= maxApplicationContextBytes else {
            throw MindwtrWatchPayloadValidationError.invalidPayload
        }
        return normalized
    }

    static func validDateOnly(_ raw: String) -> Bool {
        guard raw.utf8.count == 10 else { return false }
        let parts = raw.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              (2000...2100).contains(year) else {
            return false
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(
            calendar: calendar,
            timeZone: calendar.timeZone,
            year: year,
            month: month,
            day: day
        )
        guard let date = calendar.date(from: components) else { return false }
        let roundTrip = calendar.dateComponents([.year, .month, .day], from: date)
        return roundTrip.year == year && roundTrip.month == month && roundTrip.day == day
    }

    private static func validISO8601Timestamp(_ raw: String) -> Bool {
        guard !raw.isEmpty, raw.utf8.count <= 35,
              let date = isoWithFractionalSeconds.date(from: raw)
                ?? isoWithoutFractionalSeconds.date(from: raw) else {
            return false
        }
        return date >= minimumTimestamp && date <= maximumTimestamp
    }

    private static func boundedTitle(_ value: Any?, maxCharacters: Int, maxBytes: Int) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= maxCharacters,
              trimmed.utf8.count <= maxBytes,
              !trimmed.unicodeScalars.contains(where: { $0.value == 0 }) else {
            return nil
        }
        return trimmed
    }

    private static func taskIdentifier(_ value: Any?) throws -> String {
        guard let raw = value as? String,
              raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              raw.utf8.count <= maxTaskIdentifierBytes,
              !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw MindwtrWatchPayloadValidationError.invalidField("taskId")
        }
        return raw
    }

    private static func integer(_ value: Any?) -> Int? {
        if let value = value as? NSNumber {
            guard CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
            return Int(exactly: value.doubleValue)
        }
        return value as? Int
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber {
            guard CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
            return value.doubleValue
        }
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        return nil
    }

    private static func strictBoolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber,
              CFGetTypeID(value) == CFBooleanGetTypeID() else {
            return nil
        }
        return value.boolValue
    }

    private static func stripNullValues(_ value: Any) -> Any? {
        if value is NSNull { return nil }
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (key, child) in dictionary {
                if let stripped = stripNullValues(child) {
                    result[key] = stripped
                }
            }
            return result
        }
        if let array = value as? [Any] {
            return array.compactMap(stripNullValues)
        }
        return value
    }
}
