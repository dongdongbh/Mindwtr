import Foundation

/// Engine-serialized facade over the existing worker and journal; the caller retains the library/KV lease.
final class NativeCalendarPushWrites {
    static let maximumTickets = 32
    private enum Stage: Equatable { case queued, prepared, started, running, saved, blocked, finished }
    private enum Publication { case prepare, start, completion, calendarAck, mappingAck, discard }
    private final class Entry {
        let operationID: UUID
        let ticket: String
        let requestJSON: String?
        let request: NativeCalendarWriteRequest?
        let taskID: String?
        var stage = Stage.queued
        var publication: Publication?
        var effect: NativeCalendarPushEffect?
        var outcome: NativeCalendarWriteOutcome?
        var submissionAttempted = false
        var accepted = false
        var retired = false
        var cancelled = false
        var replyQueued = false
        var replyConsumed = false
        var acknowledgement: (entry: NativeCalendarPushMapping?, confirmed: Bool)?
        init(requestJSON: String?, request: NativeCalendarWriteRequest?, taskID: String?) {
            let id = UUID(); operationID = id
            ticket = "cal-push:\(id.uuidString.lowercased())"
            self.requestJSON = requestJSON; self.request = request; self.taskID = taskID
        }
    }

    private let jobs: NativeCalendarJobs
    private let effects: NativeCalendarPushEffects
    private let authorize: (NativeCalendarWriteRequest?) throws -> Void
    private let settleAuthority: () throws -> Void
    private var entries: [String: Entry] = [:]
    private var waiting: [Entry] = []
    private var ready: [(Entry, String)] = []
    private var active: Entry?
    private var blocked = false
    private var closing = false
    private let failure = "Calendar write failed"
    private let cancelled = "Calendar request cancelled"
    #if DEBUG
    // Exact synchronous admission cut only; never a release-build owner or provider override.
    var beforeFirstSubmission: (() -> Void)?
    #endif

    init(jobs: NativeCalendarJobs, effects: NativeCalendarPushEffects,
         authorize: @escaping (NativeCalendarWriteRequest?) throws -> Void,
         settleAuthority: @escaping () throws -> Void) {
        self.jobs = jobs; self.effects = effects; self.authorize = authorize; self.settleAuthority = settleAuthority
    }

    func submit(requestJSON: String, taskID: String?) throws -> String {
        let request = try NativeCalendarWriteRequest(json: requestJSON)
        switch request {
        case .sources: throw NativeCalendarWriteError.invalid
        case .createCalendar, .updateCalendar, .deleteCalendar:
            guard taskID == nil else { throw NativeCalendarWriteError.invalid }
        case .createEvent, .updateEvent, .deleteEvent:
            guard let taskID, NativeCalendarWriteValidation.id(taskID) else { throw NativeCalendarWriteError.invalid }
        }
        return try enqueue(Entry(requestJSON: requestJSON, request: request, taskID: taskID))
    }

    func submitSources() throws -> String { try enqueue(Entry(requestJSON: nil, request: nil, taskID: nil)) }

    private func enqueue(_ entry: Entry) throws -> String {
        guard !closing, !blocked, entries.count < Self.maximumTickets else { throw NativeCalendarWriteError.unavailable }
        if active == nil {
            do { guard try snapshot() == nil else { throw NativeCalendarWriteError.unavailable } }
            catch { blocked = true; rejectWaiting(); throw NativeCalendarWriteError.unavailable }
        }
        entries[entry.ticket] = entry; waiting.append(entry)
        return entry.ticket
    }

    /// Nonblocking polling only. Reads and mapping acknowledgements can keep the head waiting.
    func next() -> String? {
        if active == nil, !closing, !blocked, !waiting.isEmpty { active = waiting.removeFirst() }
        advance()
        guard !ready.isEmpty else { return nil }
        let (entry, json) = ready.removeFirst(); entry.replyConsumed = true
        if active !== entry { entries.removeValue(forKey: entry.ticket) }
        return json
    }

    func acknowledge(operationID: UUID, entry mapping: NativeCalendarPushMapping?) throws {
        guard let entry = active, entry.operationID == operationID, entry.taskID != nil,
              entry.stage == .saved, entry.outcome != nil else { throw NativeCalendarWriteError.invalid }
        if let prior = entry.acknowledgement {
            guard prior.entry == mapping else { throw NativeCalendarWriteError.invalid }
        } else {
            guard let effect = entry.effect else { throw NativeCalendarWriteError.invalid }
            _ = try effect.acknowledging(mapping: mapping)
            entry.acknowledgement = (mapping, false)
        }
        do {
            try settleAuthority()
            if let publication = entry.publication { try confirm(publication, entry: entry) }
            if entry.acknowledgement?.confirmed != true {
                guard let current = try snapshot(), let saved = entry.effect else { throw NativeCalendarWriteError.unavailable }
                let expected: NativeCalendarPushEffect
                if current.phase == .acknowledging { expected = try saved.acknowledging(mapping: mapping) }
                else { expected = saved }
                try sameEffect(current, expected)
                entry.publication = .mappingAck
                try effects.acknowledgeMapping(id: operationID, mapping: mapping)
                try confirm(.mappingAck, entry: entry)
                guard entry.acknowledgement?.confirmed == true else { throw NativeCalendarWriteError.unavailable }
            }
            finish(entry)
        } catch {
            blocked = true; rejectWaiting()
            throw NativeCalendarWriteError.failed
        }
    }

    func cancel(_ ticket: String) {
        guard let entry = entries[ticket], entry.stage != .finished else { return }
        entry.cancelled = true
        if active === entry {
            if entry.accepted, !entry.retired { jobs.cancelWrite(operationID: entry.operationID) }
        } else {
            waiting.removeAll { $0 === entry }
            entry.stage = .finished; reply(entry, error: cancelled)
        }
    }

    /// Drain cannot replace a real provider result. A failed publication keeps the caller's lease alive.
    func cancelAndDrain() throws {
        closing = true
        for entry in waiting { entry.cancelled = true; entry.stage = .finished; reply(entry, error: cancelled) }
        waiting.removeAll()
        if let entry = active { cancel(entry.ticket) }
        jobs.drain()
        advance()
        if let entry = active, let publication = entry.publication {
            try confirm(publication, entry: entry)
            advance()
        }
        guard let entry = active else { return }
        try settleAuthority()
        if entry.publication != nil { throw NativeCalendarWriteError.unavailable }
        if entry.accepted, !entry.retired {
            let effect = try snapshot()
            guard let outcome = entry.outcome, let effect, let frozen = entry.effect, effect.id == entry.operationID else {
                throw NativeCalendarWriteError.unavailable
            }
            switch outcome {
            case .failed:
                guard effect.phase == .started else { throw NativeCalendarWriteError.unavailable }
            case .succeeded, .confirmedMissingEvent:
                guard effect.phase == .saved || effect.phase == .acknowledging else { throw NativeCalendarWriteError.unavailable }
            case .notStarted, .failedBeforeMutation: throw NativeCalendarWriteError.unavailable
            }
            let expected: NativeCalendarPushEffect
            if effect.phase == .acknowledging { expected = try frozen.acknowledging(mapping: entry.acknowledgement?.entry) }
            else { expected = frozen }
            try sameEffect(effect, expected)
            try retire(entry)
        }
        // Saved/uncertain durable records deliberately remain for the root's cold-recovery gate.
    }

    private func snapshot() throws -> NativeCalendarPushEffect? {
        try settleAuthority()
        try effects.retryPublication()
        return try effects.current()
    }

    private func advance() {
        guard let entry = active else { return }
        do {
            if let publication = entry.publication { try confirm(publication, entry: entry) }
            guard active === entry else { return }
            if entry.stage == .queued {
                if entry.cancelled || closing { finish(entry, error: cancelled); return }
                guard jobs.writeAdmissionAvailable else { return }
                try authorize(entry.request)
                guard jobs.writeAdmissionAvailable else { return }
                guard try snapshot() == nil else { throw NativeCalendarWriteError.unavailable }
                if let raw = entry.requestJSON {
                    entry.publication = .prepare
                    entry.effect = try effects.prepare(id: entry.operationID, requestJSON: raw, taskID: entry.taskID)
                    try confirm(.prepare, entry: entry)
                } else { try submitWorker(entry, request: .sources) }
            }
            guard active === entry else { return }
            if entry.stage == .prepared {
                if entry.cancelled || closing {
                    entry.publication = .discard; try effects.discardPrepared(id: entry.operationID)
                    try confirm(.discard, entry: entry); return
                }
                entry.publication = .start
                entry.effect = try effects.markStarted(id: entry.operationID)
                try confirm(.start, entry: entry)
            }
            if entry.stage == .started {
                if entry.cancelled || closing {
                    guard !entry.submissionAttempted, !entry.accepted else { throw NativeCalendarWriteError.unavailable }
                    entry.outcome = .failedBeforeMutation(.unavailable)
                    try publishCompletion(entry); return
                }
                guard jobs.writeAdmissionAvailable, let effect = entry.effect else { return }
                do { try authorize(entry.request) }
                catch {
                    guard !entry.submissionAttempted, !entry.accepted else { throw NativeCalendarWriteError.unavailable }
                    entry.outcome = .failedBeforeMutation(.unavailable)
                    rejectWaiting(); try publishCompletion(entry); return
                }
                guard jobs.writeAdmissionAvailable else { return }
                try submitWorker(entry, request: effect.request)
            }
            if entry.stage == .running, let outcome = jobs.writeOutcome(operationID: entry.operationID) {
                entry.outcome = outcome
                if entry.requestJSON == nil {
                    try settleAuthority(); try retire(entry)
                    if case .succeeded(.sources(let sources)) = outcome {
                        finish(entry, value: sources.map { ["id": $0.id, "name": $0.name, "type": $0.type.rawValue] })
                    } else { finish(entry, error: outcomeError(outcome)) }
                } else { try publishCompletion(entry) }
            }
        } catch {
            blocked = true; rejectWaiting(); reply(entry, error: failure)
            if !entry.accepted { entry.cancelled = true }
            if entry.publication == nil, entry.stage != .running, entry.stage != .prepared, entry.stage != .started {
                entry.stage = .blocked
            }
        }
    }

    private func submitWorker(_ entry: Entry, request: NativeCalendarWriteRequest) throws {
        guard !entry.submissionAttempted, !entry.accepted else { throw NativeCalendarWriteError.unavailable }
        #if DEBUG
        beforeFirstSubmission?()
        #endif
        entry.submissionAttempted = true
        do {
            try jobs.submitWrite(request, operationID: entry.operationID)
            entry.accepted = true; entry.stage = .running
        } catch {
            // Every submitWrite throw precedes enqueue; this exact first attempt has never been accepted.
            if entry.requestJSON != nil {
                entry.outcome = .failedBeforeMutation(.unavailable)
                rejectWaiting(); try publishCompletion(entry)
            } else { finish(entry, error: failure) }
        }
    }

    private func publishCompletion(_ entry: Entry) throws {
        guard let outcome = entry.outcome else { throw NativeCalendarWriteError.unavailable }
        try settleAuthority()
        guard let current = try snapshot(), let frozen = entry.effect else { throw NativeCalendarWriteError.unavailable }
        try sameEffect(current, frozen)
        entry.publication = .completion
        try effects.acceptCompletion(id: entry.operationID, outcome: outcome)
        try confirm(.completion, entry: entry)
    }

    /// Only retry the retained pair before inspecting phase; never replay a provider or guessed transition.
    private func confirm(_ publication: Publication, entry: Entry) throws {
        let current = try snapshot()
        if let current, current.id != entry.operationID { throw NativeCalendarWriteError.unavailable }
        switch publication {
        case .prepare:
            guard let current else { entry.publication = nil; finish(entry, error: failure); return }
            guard current.phase == .prepared else { throw NativeCalendarWriteError.unavailable }
            if let frozen = entry.effect { try sameEffect(current, frozen) }
            else {
                guard let raw = entry.requestJSON else { throw NativeCalendarWriteError.invalid }
                let expected: String
                if case .createEvent? = entry.request {
                    expected = try NativeCalendarPushWitness.markCreateEvent(requestJSON: raw, id: entry.operationID)
                } else { expected = raw }
                guard NativeCalendarWriteValidation.equalID(current.requestJSON, expected),
                      current.taskID.map({ Data($0.utf8) }) == entry.taskID.map({ Data($0.utf8) }) else {
                    throw NativeCalendarWriteError.invalid
                }
            }
            entry.effect = current; entry.stage = .prepared; entry.publication = nil
        case .start:
            guard let current, let frozen = entry.effect, current.phase == .started || current.phase == .prepared else { throw NativeCalendarWriteError.unavailable }
            let expected: NativeCalendarPushEffect
            if frozen.phase == .prepared && current.phase == .started { expected = try frozen.markingStarted() }
            else { expected = frozen }
            try sameEffect(current, expected)
            entry.effect = current; entry.stage = current.phase == .started ? .started : .prepared; entry.publication = nil
        case .discard:
            guard current == nil else { throw NativeCalendarWriteError.unavailable }
            entry.publication = nil; finish(entry, error: cancelled)
        case .completion:
            guard let outcome = entry.outcome else { throw NativeCalendarWriteError.unavailable }
            switch outcome {
            case .notStarted, .failedBeforeMutation:
                guard current == nil else { throw NativeCalendarWriteError.unavailable }
                entry.publication = nil; try retire(entry); finish(entry, error: outcomeError(outcome))
            case .failed:
                guard let current, let frozen = entry.effect, current.phase == .started else { throw NativeCalendarWriteError.unavailable }
                try sameEffect(current, frozen)
                entry.effect = current; entry.publication = nil; try retire(entry)
                entry.stage = .blocked; blocked = true; rejectWaiting(); reply(entry, error: failure)
            case .succeeded, .confirmedMissingEvent:
                guard let current, let frozen = entry.effect, current.phase == .saved else { throw NativeCalendarWriteError.unavailable }
                let result: NativeCalendarPushEffect.Result
                switch outcome {
                case .succeeded(.identifier(let id)): result = .identifier(id)
                case .succeeded(.completed): result = .completed
                case .confirmedMissingEvent: result = .missingEvent
                default: throw NativeCalendarWriteError.invalid
                }
                try sameEffect(current, frozen.recording(result: result))
                entry.effect = current; entry.stage = .saved; entry.publication = nil
                if entry.taskID != nil {
                    try retire(entry); reply(entry, value: try writeValue(entry))
                } else {
                    entry.publication = .calendarAck
                    try effects.acknowledgeCalendar(id: entry.operationID)
                    try confirm(.calendarAck, entry: entry)
                }
            }
        case .calendarAck:
            if let current {
                // No pending pair remains after retry; a saved record here means local acknowledgment refused.
                guard current.phase == .saved, let frozen = entry.effect else { throw NativeCalendarWriteError.unavailable }
                try sameEffect(current, frozen)
                entry.publication = nil; entry.stage = .blocked; blocked = true
                try retire(entry); rejectWaiting(); reply(entry, error: failure)
            } else {
                entry.publication = nil; try retire(entry); finish(entry, value: try writeValue(entry))
            }
        case .mappingAck:
            guard entry.acknowledgement != nil else { throw NativeCalendarWriteError.unavailable }
            if let current {
                guard let frozen = entry.effect, current.phase == .saved || current.phase == .acknowledging else { throw NativeCalendarWriteError.unavailable }
                let expected: NativeCalendarPushEffect
                if current.phase == .acknowledging { expected = try frozen.acknowledging(mapping: entry.acknowledgement?.entry) }
                else { expected = frozen }
                try sameEffect(current, expected)
                if current.phase == .acknowledging, current.afterMapping != entry.acknowledgement?.entry {
                    throw NativeCalendarWriteError.invalid
                }
            } else { entry.acknowledgement?.confirmed = true }
            entry.publication = nil; entry.stage = .saved
        }
    }

    private func retire(_ entry: Entry) throws {
        guard entry.accepted, !entry.retired else { return }
        try jobs.retireWrite(operationID: entry.operationID); entry.retired = true
    }
    private func sameEffect(_ current: NativeCalendarPushEffect, _ expected: NativeCalendarPushEffect) throws {
        guard NativeCalendarWriteValidation.equalID(try current.encoded(), try expected.encoded()) else {
            throw NativeCalendarWriteError.unavailable
        }
    }
    private func writeValue(_ entry: Entry) throws -> [String: Any] {
        guard let result = entry.effect?.result else { throw NativeCalendarWriteError.unavailable }
        let value: [String: Any]
        switch result {
        case .identifier(let id): value = ["kind": "identifier", "id": id]
        case .completed: value = ["kind": "completed"]
        case .missingEvent: value = ["kind": "missingEvent"]
        }
        return ["operationId": entry.operationID.uuidString.lowercased(), "result": value]
    }
    private func outcomeError(_ outcome: NativeCalendarWriteOutcome) -> String {
        if case .notStarted = outcome { return cancelled }
        if case .failed = outcome { return failure }
        return outcome.replyError?.localizedDescription ?? failure
    }
    private func rejectWaiting() {
        for entry in waiting { entry.stage = .finished; reply(entry, error: failure) }
        waiting.removeAll()
    }
    private func finish(_ entry: Entry, value: Any? = nil, error: String? = nil) {
        if let error { reply(entry, error: error) }
        else if let value { reply(entry, value: value) }
        entry.stage = .finished
        if active === entry { active = nil; blocked = false }
        if entry.replyConsumed { entries.removeValue(forKey: entry.ticket) }
    }
    private func reply(_ entry: Entry, value: Any? = nil, error: String? = nil) {
        guard !entry.replyQueued else { return }
        let object: [String: Any]
        if let error { object = ["id": entry.ticket, "error": error] }
        else { object = ["id": entry.ticket, "value": value ?? NSNull()] }
        let encoded = try? JSONSerialization.data(withJSONObject: object)
        let json: String
        if let encoded, encoded.count <= NativeCalendarJobs.maximumReplyBytes { json = String(decoding: encoded, as: UTF8.self) }
        else { json = "{\"id\":\"\(entry.ticket)\",\"error\":\"Calendar write failed\"}" }
        entry.replyQueued = true; ready.append((entry, json))
    }
}
