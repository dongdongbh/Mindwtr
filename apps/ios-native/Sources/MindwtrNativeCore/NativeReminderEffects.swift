import Foundation

/// One explicit asynchronous cycle. The Engine owns policy/storage; this latch only drains accepted callbacks.
final class NativeReminderEffects: @unchecked Sendable {
    static var unavailable: HostFailure { HostFailure("NOT_READY: Reminder reconciliation is unavailable") }
    struct Alarm: Sendable {
        let id: Int
        let identifier: String
        let json: String
        let withdrawn: Bool
        /// Only recovery of an already armed durable Snooze owes fresh future/absence admission.
        let armedSnoozeDeadline: Double?
        /// Unarmed Snoozes retain the shared inclusive24h late allowance after awaited callbacks.
        let unarmedSnoozeExpiry: Double?
    }
    struct Cancellation: Sendable { let id: Int; let identifier: String; let withdrawn: Bool }
    struct Admission: Sendable { let namespace: String; let port: any NativeReminderPort }
    struct Plan: Sendable {
        let mode: String
        let schedule: [Alarm]
        let cancel: [Cancellation]
        let clearDelivered: Bool
        let topUpDelayMs: Double?
    }
    private let lock = NSLock()
    private var active: UUID?
    private var activeCancellation: NativeAttachmentCancellation?
    private var ordinaryReservations = 0
    private var ordinaryBlockedReminder = false
    private var ordinaryWaiters: [CheckedContinuation<Bool, Never>] = []
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func begin(cancellation: NativeAttachmentCancellation) throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        guard !closed, active == nil else { throw Self.unavailable }
        guard ordinaryReservations == 0 else { ordinaryBlockedReminder = true; throw Self.unavailable }
        let id = UUID(); active = id; activeCancellation = cancellation; return id
    }
    func finish(_ id: UUID) {
        lock.lock()
        if active == id { active = nil; activeCancellation = nil }
        let resumed = active == nil ? waiters : []
        let ordinary = active == nil ? ordinaryWaiters : []
        if active == nil { waiters.removeAll(); ordinaryWaiters.removeAll() }
        lock.unlock()
        resumed.forEach { $0.resume() }; ordinary.forEach { $0.resume(returning: true) }
    }
    /// Reserves the existing Engine dispatcher, cancelling only asynchronous reminder work.
    /// The reservation survives callback drain so another reminder cannot overtake the ordinary caller.
    func reserveOrdinary(cancellation: NativeAttachmentCancellation) async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            guard !cancellation.isCancelled else { lock.unlock(); continuation.resume(returning: false); return }
            ordinaryReservations += 1
            guard active != nil else { lock.unlock(); continuation.resume(returning: true); return }
            ordinaryBlockedReminder = true
            ordinaryWaiters.append(continuation)
            let token = activeCancellation
            lock.unlock()
            token?.cancel()
        }
    }
    func finishOrdinary() {
        lock.lock(); defer { lock.unlock() }
        precondition(ordinaryReservations > 0)
        ordinaryReservations -= 1
    }
    /// Only an actual preemption or blocked begin owes a successor wake; routine reads do not.
    func takeOrdinaryReadyWake(ready: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !closed, ready, ordinaryReservations == 0, ordinaryBlockedReminder else { return false }
        ordinaryBlockedReminder = false; return true
    }
    func clearOrdinaryReadyWake() {
        lock.lock(); defer { lock.unlock() }; ordinaryBlockedReminder = false
    }

    func closeAndDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock(); closed = true; ordinaryBlockedReminder = false
            if active == nil { lock.unlock(); continuation.resume() }
            else { waiters.append(continuation); lock.unlock() }
        }
    }

    static func checkInventory(_ observations: [NativeReminderObservation]) throws {
        guard observations.count <= 4096, Set(observations.map(\.identifier)).count == observations.count else { throw unavailable }
    }
    /// RN keeps the first observed delivery on a tie. Only exact native owners are eligible here.
    static func supersededDelivered(_ observations: [NativeReminderObservation]) throws -> [NativeReminderObservation] {
        try checkInventory(observations)
        var newest: [String: NativeReminderObservation] = [:], superseded: [NativeReminderObservation] = []
        for item in observations {
            guard item.ownedID != nil, item.threadIdentifier.hasPrefix("mindwtr-reminder:"),
                  let date = item.deliveredAtMs, date.isFinite else { continue }
            if let kept = newest[item.threadIdentifier], let keptDate = kept.deliveredAtMs {
                if date > keptDate {
                    superseded.append(kept); newest[item.threadIdentifier] = item
                } else { superseded.append(item) }
            } else { newest[item.threadIdentifier] = item }
        }
        return superseded
    }
    static func projectedCapacity(plan: Plan, pending: [NativeReminderObservation]) throws {
        try checkInventory(pending)
        var identifiers = Set(pending.map(\.identifier))
        for item in plan.cancel {
            if pending.contains(where: { $0.identifier == item.identifier && $0.ownedID != nil }) { identifiers.remove(item.identifier) }
        }
        for alarm in plan.schedule {
            if pending.contains(where: { $0.identifier == alarm.identifier && $0.ownedID != alarm.id }) { throw unavailable }
            identifiers.insert(alarm.identifier)
        }
        guard identifiers.count <= 64 else { throw unavailable }
    }
}
