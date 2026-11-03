import Foundation

enum NativePomodoroAlarmEffects {
    static var unavailable: HostFailure { HostFailure("NOT_READY: Pomodoro alarm reconciliation is unavailable") }
    static let stateLimit = 1024 * 1024
    static let intentLimit = 16 * 1024
    static let inventoryLimit = 4096
    struct Admission: Sendable {
        let namespace: String
        let libraryID: String
        let port: any NativePomodoroAlarmPort
        let request: NativeNotificationAuthorization.Requester
    }
    struct Schedule: Sendable {
        let json: String
        let observation: NativePomodoroAlarmObservation
    }
    struct Dispatch: Sendable {
        let schedule: Schedule
        let published: String
    }
    struct Plan: Sendable {
        let writeAhead: String?
        let published: String?
        let after: String?
        let schedule: Schedule?
        let cancelPending: [NativePomodoroAlarmObservation]
        let cancelDelivered: [NativePomodoroAlarmObservation]
        let outcome: String
    }
    static func checkState(_ raw: String?) throws {
        guard let raw else { return }
        guard raw.utf8.count <= stateLimit,
              (try NativeJSON.jsonObject(with: Data(raw.utf8))) is [String: Any],
              try NativeJSON.hasUniqueObjectKeys(raw) else { throw unavailable }
    }
    static func checkInventory(_ values: [NativePomodoroAlarmObservation]) throws {
        guard values.count <= inventoryLimit, Set(values.map(\.identifier)).count == values.count,
              values.allSatisfy({ !$0.identifier.isEmpty && $0.identifier.utf8.count <= 1024 }) else { throw unavailable }
    }
    static func targets(_ values: [NativePomodoroAlarmObservation], expected: [NativePomodoroAlarmObservation]) throws -> [String] {
        try checkInventory(values)
        let expected = Dictionary(uniqueKeysWithValues: expected.map { ($0.identifier, $0) })
        return try values.compactMap { observed in
            guard let owner = expected[observed.identifier] else { return nil }
            guard observed.identity != nil, observed == owner else { throw unavailable }
            return observed.identifier
        }
    }
    static func checkCapacity(_ values: [NativePomodoroAlarmObservation], schedule: Schedule) throws {
        try checkInventory(values)
        if let existing = values.first(where: { $0.identifier == schedule.observation.identifier }) {
            guard existing == schedule.observation else { throw unavailable }
        }
        guard Set(values.map(\.identifier)).union([schedule.observation.identifier]).count <= 64 else { throw unavailable }
    }
}
