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
        let beforeCalendarState: [String?]?
        switch request {
        case .createCalendar, .updateCalendar, .deleteCalendar:
            let state = Array(snapshot.state.prefix(5))
            _ = try validateCalendar(request, state: state)
            beforeCalendarState = state
        default: beforeCalendarState = nil
        }
        let before: NativeCalendarPushMapping?
        if let taskID { before = try database.readCalendarPushMapping(taskID: taskID) }
        else { before = nil }
        let effect = try NativeCalendarPushEffect(id: id, libraryID: libraryID, requestJSON: frozenRequest,
                                                 taskID: taskID, beforeMapping: before, beforeCalendarState: beforeCalendarState)
        try preflightTransitions(effect)
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

    /// Before cold saved-delete acknowledgment, the exact owner must freshly prove the calendar is absent.
    func acknowledgeCalendar(id: UUID) throws {
        let snapshot = try read()
        guard let effect = snapshot.effect, effect.id == id, effect.phase == .saved,
              let before = effect.beforeCalendarState,
              snapshot.state.prefix(5).map({ $0.map { Data($0.utf8) } }) == before.map({ $0.map { Data($0.utf8) } }) else {
            throw NativeCalendarWriteError.invalid
        }
        let intent = try validateCalendar(effect.request, state: before)
        var next = snapshot.state
        switch effect.request {
        case .createCalendar:
            guard case .identifier(let returnedID)? = effect.result, let intent else { throw NativeCalendarWriteError.invalid }
            let title = String(decoding: try JSONSerialization.data(withJSONObject: intent.title,
                options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
            let calendarID = String(decoding: try JSONSerialization.data(withJSONObject: returnedID,
                options: [.fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
            next[1] = returnedID
            next[4] = "{\"title\":\(title),\"calendarId\":\(calendarID)}"
        case .updateCalendar(_, let details):
            if details.title != nil { next[4] = nil }
            else { next[3] = details.color.uppercased() }
        case .deleteCalendar(let calendarID):
            next[1] = nil; next[4] = nil
            if next[2].map({ NativeCalendarWriteValidation.equalID($0, calendarID) }) ?? false { next[2] = nil }
        default: throw NativeCalendarWriteError.invalid
        }
        next[5] = nil
        pending = (snapshot.state, next)
        try retryPublication()
    }

    /// Admission only: cold records retain their own validation without requiring hypothetical future space.
    private func preflightTransitions(_ effect: NativeCalendarPushEffect) throws {
        let started = try effect.markingStarted()
        // NUL is valid here and uses the largest JSON escape per permitted UTF-8 byte.
        let maximumIdentifier = String(repeating: "\0", count: 1024)
        let maximumStamp = String(repeating: "\0", count: 128)
        switch effect.request {
        case .createCalendar:
            _ = try started.recording(result: .identifier(maximumIdentifier))
        case .updateCalendar, .deleteCalendar:
            _ = try started.recording(result: .completed)
        case .createEvent(let calendarID, _):
            guard let taskID = effect.taskID else { throw NativeCalendarWriteError.invalid }
            let mapping = try NativeCalendarPushMapping(taskId: taskID, calendarEventId: maximumIdentifier,
                calendarId: calendarID, platform: "ios", lastSyncedAt: maximumStamp)
            _ = try started.recording(result: .identifier(maximumIdentifier)).acknowledging(mapping: mapping)
        case .updateEvent(let eventID, let calendarID, _):
            guard let taskID = effect.taskID else { throw NativeCalendarWriteError.invalid }
            let mapping = try NativeCalendarPushMapping(taskId: taskID, calendarEventId: eventID,
                calendarId: calendarID, platform: "ios", lastSyncedAt: maximumStamp)
            _ = try started.recording(result: .completed).acknowledging(mapping: mapping)
            _ = try started.recording(result: .missingEvent).acknowledging(mapping: nil)
        case .deleteEvent:
            _ = try started.recording(result: .completed).acknowledging(mapping: nil)
            _ = try started.recording(result: .missingEvent).acknowledging(mapping: nil)
        case .sources: throw NativeCalendarWriteError.invalid
        }
    }

    private func validateCalendar(_ request: NativeCalendarWriteRequest, state: [String?]) throws
        -> (title: String, calendarID: String?, deletionRevision: String?)? {
        guard state.count == 5, state[1].map(NativeCalendarWriteValidation.id) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        let intent = try calendarIntent(state[4])
        switch request {
        case .createCalendar(let details):
            // The exact owner separately proves a stale saved ID absent before admitting this unbound create.
            guard let intent, intent.calendarID == nil, intent.deletionRevision == nil,
                  NativeCalendarWriteValidation.equalID(intent.title, details.title) else { throw NativeCalendarWriteError.invalid }
        case .updateCalendar(let calendarID, let details):
            guard let savedID = state[1], NativeCalendarWriteValidation.equalID(savedID, calendarID) else {
                throw NativeCalendarWriteError.invalid
            }
            if let title = details.title {
                guard NativeCalendarWriteValidation.equalID(title, "Mindwtr"), let intent,
                      intent.calendarID.map({ NativeCalendarWriteValidation.equalID($0, calendarID) }) ?? false,
                      intent.deletionRevision == nil else { throw NativeCalendarWriteError.invalid }
            } else { guard intent == nil else { throw NativeCalendarWriteError.invalid } }
        case .deleteCalendar(let calendarID):
            guard state[1].map({ NativeCalendarWriteValidation.equalID($0, calendarID) }) ?? true else {
                throw NativeCalendarWriteError.invalid
            }
            if let intent {
                guard intent.calendarID.map({ NativeCalendarWriteValidation.equalID($0, calendarID) }) ?? false,
                      intent.deletionRevision != nil else { throw NativeCalendarWriteError.invalid }
            } else { guard state[1] != nil else { throw NativeCalendarWriteError.invalid } }
        default: throw NativeCalendarWriteError.invalid
        }
        return intent
    }

    private func calendarIntent(_ raw: String?) throws -> (title: String, calendarID: String?, deletionRevision: String?)? {
        guard let raw else { return nil }
        do {
            guard try NativeJSON.hasUniqueObjectKeys(raw),
                  let value = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                  Set(value.keys).isSubset(of: ["title", "calendarId", "deletionRevision"]),
                  let title = value["title"] as? String, title.hasPrefix("Mindwtr ("), title.hasSuffix(")"),
                  let id = UUID(uuidString: String(title.dropFirst(9).dropLast())), id.uuid.6 >> 4 == 4,
                  id.uuid.8 & 0xc0 == 0x80,
                  NativeCalendarWriteValidation.equalID(title, "Mindwtr (\(id.uuidString.lowercased()))") else {
                throw NativeCalendarWriteError.invalid
            }
            let calendarID: String?
            if let rawID = value["calendarId"] {
                guard let text = rawID as? String, NativeCalendarWriteValidation.id(text) else { throw NativeCalendarWriteError.invalid }
                calendarID = text
            } else { calendarID = nil }
            let revision: String?
            if let rawRevision = value["deletionRevision"] {
                guard calendarID != nil, let text = rawRevision as? String, text.utf8.count == 32,
                      text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                    throw NativeCalendarWriteError.invalid
                }
                revision = text
            } else { revision = nil }
            return (title, calendarID, revision)
        } catch { throw NativeCalendarWriteError.invalid }
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
