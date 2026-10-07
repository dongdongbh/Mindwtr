import Foundation

enum MindwtrWatchProtocol {
    static let version = 1
    static let source = "apple-watch"
    static let maximumFocusTasks = 20
    static let maximumSnapshotTitleLength = 160
    static let maximumCaptureCharacters = 2_000
    static let maximumCaptureUtf8Bytes = 8_000

    enum Kind: String {
        case text
        case audio
        case complete
        case deferTask = "defer"
        case pomodoro
        case checklist
    }

    enum PomodoroAction: String {
        case start
        case pause
        case reset
    }

    static func envelope(
        id: UUID,
        createdAt: Date,
        kind: Kind,
        outboxRetried: Bool = false
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "protocolVersion": version,
            "id": id.uuidString.lowercased(),
            "createdAt": iso8601.string(from: createdAt),
            "source": source,
            "kind": kind.rawValue,
        ]
        if outboxRetried { payload["outboxRetried"] = true }
        return payload
    }

    static func textCapture(
        title: String,
        id: UUID = UUID(),
        createdAt: Date = Date(),
        outboxRetried: Bool = false
    ) -> [String: Any]? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.count <= maximumCaptureCharacters,
              trimmed.lengthOfBytes(using: .utf8) <= maximumCaptureUtf8Bytes
        else { return nil }
        var payload = envelope(id: id, createdAt: createdAt, kind: .text, outboxRetried: outboxRetried)
        payload["title"] = trimmed
        return payload
    }

    static func command(
        kind: Kind,
        taskId: String? = nil,
        startDate: String? = nil,
        action: PomodoroAction? = nil,
        id: UUID = UUID(),
        createdAt: Date = Date()
    ) -> [String: Any] {
        var payload = envelope(id: id, createdAt: createdAt, kind: kind)
        if let taskId, !taskId.isEmpty { payload["taskId"] = taskId }
        if let startDate { payload["startDate"] = startDate }
        if let action { payload["action"] = action.rawValue }
        return payload
    }

    static func audioMetadata(
        id: UUID,
        createdAt: Date,
        outboxRetried: Bool = false
    ) -> [String: Any] {
        envelope(id: id, createdAt: createdAt, kind: .audio, outboxRetried: outboxRetried)
    }

    static func tomorrowDate(from now: Date = Date(), calendar: Calendar = .current) -> String {
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: tomorrow)
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

}

struct MindwtrWatchFocusTask: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    var createdAt: String? = nil
    var description: String? = nil
    var checklist: [MindwtrWatchChecklistItem]? = nil
    var detailsUnavailable: Bool? = nil
}

struct MindwtrWatchChecklistItem: Codable, Hashable {
    let id: String
    let title: String
    var isCompleted: Bool
}

extension MindwtrWatchProtocol {
    static func checklistCommand(task: MindwtrWatchFocusTask, item: MindwtrWatchChecklistItem, completed: Bool,
                                 createdAt: Date = Date()) -> [String: Any]? {
        guard let taskCreatedAt = task.createdAt,
              task.checklist?.filter({ $0.id == item.id && $0.title == item.title }).count == 1 else { return nil }
        var payload = command(kind: .checklist, taskId: task.id, createdAt: createdAt)
        payload["taskCreatedAt"] = taskCreatedAt
        payload["itemId"] = item.id
        payload["itemTitle"] = item.title
        payload["isCompleted"] = completed
        return payload
    }

    static func overlay(_ payloads: [[String: Any]], on task: MindwtrWatchFocusTask) -> MindwtrWatchFocusTask {
        var updated = task
        for payload in payloads {
            guard payload["kind"] as? String == "checklist",
                  payload["taskId"] as? String == task.id,
                  payload["taskCreatedAt"] as? String == task.createdAt,
                  let itemID = payload["itemId"] as? String,
                  let title = payload["itemTitle"] as? String,
                  let completed = payload["isCompleted"] as? Bool,
                  updated.checklist?.filter({ $0.id == itemID && $0.title == title }).count == 1 else { continue }
            updated.checklist = updated.checklist?.map { item in
                var item = item
                if item.id == itemID && item.title == title { item.isCompleted = completed }
                return item
            }
        }
        return updated
    }

    static func timestamp(_ value: String) -> TimeInterval? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)?.timeIntervalSince1970
    }
}

struct MindwtrWatchPomodoro: Codable, Equatable {
    enum Phase: String, Codable {
        case focus
        case `break`
    }

    let phase: Phase
    let isRunning: Bool
    let remainingSeconds: Int
    let phaseEndTime: TimeInterval?
    let taskId: String?
    let taskTitle: String?
    let completionAlert: Bool

    func remaining(at date: Date = Date()) -> Int {
        guard isRunning, let phaseEndTime else { return max(0, remainingSeconds) }
        return max(0, Int(ceil((phaseEndTime - date.timeIntervalSince1970 * 1_000) / 1_000)))
    }
}

struct MindwtrWatchSnapshot: Codable, Equatable {
    let generatedAt: String
    let focus: [MindwtrWatchFocusTask]
    let pomodoro: MindwtrWatchPomodoro

    static let empty = MindwtrWatchSnapshot(
        generatedAt: "",
        focus: [],
        pomodoro: MindwtrWatchPomodoro(
            phase: .focus,
            isRunning: false,
            remainingSeconds: 25 * 60,
            phaseEndTime: nil,
            taskId: nil,
            taskTitle: nil,
            completionAlert: true
        )
    )

    init?(applicationContext: [String: Any]) {
        guard (applicationContext["protocolVersion"] as? NSNumber)?.intValue == MindwtrWatchProtocol.version,
              let generatedAt = applicationContext["generatedAt"] as? String,
              let pomodoroDictionary = applicationContext["pomodoro"] as? [String: Any],
              let phaseRaw = pomodoroDictionary["phase"] as? String,
              let phase = MindwtrWatchPomodoro.Phase(rawValue: phaseRaw),
              let isRunning = (pomodoroDictionary["isRunning"] as? NSNumber)?.boolValue,
              let remainingSeconds = (pomodoroDictionary["remainingSeconds"] as? NSNumber)?.intValue
        else { return nil }

        let focusDictionaries = applicationContext["focus"] as? [[String: Any]] ?? []
        focus = focusDictionaries.prefix(MindwtrWatchProtocol.maximumFocusTasks).compactMap { item in
            guard let id = item["id"] as? String,
                  !id.isEmpty,
                  let rawTitle = item["title"] as? String
            else { return nil }
            var task = MindwtrWatchFocusTask(
                id: id,
                title: String(rawTitle.prefix(MindwtrWatchProtocol.maximumSnapshotTitleLength))
            )
            task.createdAt = item["createdAt"] as? String
            task.description = item["description"] as? String
            task.detailsUnavailable = item["detailsUnavailable"] as? Bool
            if let checklist = item["checklist"] as? [[String: Any]],
               let data = try? JSONSerialization.data(withJSONObject: checklist) {
                task.checklist = try? JSONDecoder().decode([MindwtrWatchChecklistItem].self, from: data)
            }
            return task
        }

        self.generatedAt = generatedAt
        pomodoro = MindwtrWatchPomodoro(
            phase: phase,
            isRunning: isRunning,
            remainingSeconds: max(0, remainingSeconds),
            phaseEndTime: (pomodoroDictionary["phaseEndTime"] as? NSNumber)?.doubleValue,
            taskId: pomodoroDictionary["taskId"] as? String,
            taskTitle: (pomodoroDictionary["taskTitle"] as? String).map {
                String($0.prefix(MindwtrWatchProtocol.maximumSnapshotTitleLength))
            },
            completionAlert: (pomodoroDictionary["completionAlert"] as? NSNumber)?.boolValue ?? true
        )
    }

    init(generatedAt: String, focus: [MindwtrWatchFocusTask], pomodoro: MindwtrWatchPomodoro) {
        self.generatedAt = generatedAt
        self.focus = Array(focus.prefix(MindwtrWatchProtocol.maximumFocusTasks))
        self.pomodoro = pomodoro
    }
}
