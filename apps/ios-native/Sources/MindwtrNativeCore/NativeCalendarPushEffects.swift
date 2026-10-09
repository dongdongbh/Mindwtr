import Foundation

/// Serialized Engine calls only: the caller retains the exact owner/library/KV lease and drains before close.
final class NativeCalendarPushEffects {
    private let storage: NativeDeviceKV
    private let database: SQLiteBridge
    private let libraryID: String
    private var pending: (before: [String?], next: [String?])?

    init(storage: NativeDeviceKV, database: SQLiteBridge, libraryID: String) throws {
        guard !libraryID.isEmpty, libraryID.utf8.count <= 1024 else { throw NativeCalendarWriteError.invalid }
        self.storage = storage; self.database = database; self.libraryID = libraryID
        _ = try read()
    }

    func current() throws -> NativeCalendarPushEffect? { try read().effect }

    func retryPublication() throws {
        guard let pending else { return }
        try storage.compareAndSetCalendarPushState(expected: pending.before, next: pending.next)
        self.pending = nil
    }

    func prepare(id: UUID, requestJSON: String, taskID: String?) throws -> NativeCalendarPushEffect {
        let snapshot = try read()
        guard snapshot.effect == nil else { throw NativeCalendarWriteError.unavailable }
        let request = try NativeCalendarWriteRequest(json: requestJSON)
        let frozenRequest: String
        if case .createEvent = request {
            frozenRequest = try NativeCalendarPushWitness.markCreateEvent(requestJSON: requestJSON, id: id)
        } else { frozenRequest = requestJSON }
        let before: NativeCalendarPushMapping?
        if let taskID { before = try database.readCalendarPushMapping(taskID: taskID) }
        else { before = nil }
        let effect = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: frozenRequest,
                                                 taskID: taskID, beforeMapping: before)
        _ = try publish(effect, replacing: snapshot.state)
        return effect
    }

    func markStarted(id: UUID) throws -> NativeCalendarPushEffect {
        let snapshot = try read()
        guard let effect = snapshot.effect, effect.id == id else { throw NativeCalendarWriteError.invalid }
        let started = try effect.markingStarted()
        _ = try publish(started, replacing: snapshot.state)
        return started
    }

    /// The caller retains the actual worker outcome until this publication succeeds, then retires it.
    func acceptCompletion(id: UUID, outcome: NativeCalendarWriteOutcome) throws {
        let snapshot = try read()
        guard let effect = snapshot.effect, effect.id == id, effect.phase == .started else {
            throw NativeCalendarWriteError.invalid
        }
        let next: NativeCalendarPushEffect?
        switch outcome {
        case .notStarted: next = nil
        case .succeeded(.identifier(let identifier)): next = try effect.recording(result: .identifier(identifier))
        case .succeeded(.completed): next = try effect.recording(result: .completed)
        case .succeeded(.sources(_)): throw NativeCalendarWriteError.invalid
        case .failed(.missingEvent): next = try effect.recording(result: .missingEvent)
        case .failed: return
        }
        _ = try publish(next, replacing: snapshot.state)
    }

    func acknowledgeMapping(id: UUID, mapping: NativeCalendarPushMapping?) throws {
        let snapshot = try read()
        guard let effect = snapshot.effect, effect.id == id, let taskID = effect.taskID else {
            throw NativeCalendarWriteError.invalid
        }
        let acknowledging: NativeCalendarPushEffect
        let state: [String?]
        switch effect.phase {
        case .saved:
            acknowledging = try effect.acknowledging(mapping: mapping)
            state = try publish(acknowledging, replacing: snapshot.state)
        case .acknowledging:
            guard effect.afterMapping == mapping else { throw NativeCalendarWriteError.invalid }
            acknowledging = effect; state = snapshot.state
        default: throw NativeCalendarWriteError.invalid
        }
        try database.compareAndSetCalendarPushMapping(taskID: taskID, expected: acknowledging.beforeMapping,
                                                     next: acknowledging.afterMapping)
        _ = try publish(nil, replacing: state)
    }

    private func read() throws -> (state: [String?], effect: NativeCalendarPushEffect?) {
        guard pending == nil else { throw NativeCalendarWriteError.unavailable }
        let state = try storage.readCalendarPushState()
        let effect = try state[5].map { try NativeCalendarPushEffect(json: $0) }
        guard effect.map({ NativeCalendarWriteValidation.equalID($0.libraryID, libraryID) }) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        return (state, effect)
    }

    private func publish(_ effect: NativeCalendarPushEffect?, replacing before: [String?]) throws -> [String?] {
        var next = before; next[5] = try effect?.encoded()
        pending = (before, next)
        try retryPublication()
        return next
    }
}
