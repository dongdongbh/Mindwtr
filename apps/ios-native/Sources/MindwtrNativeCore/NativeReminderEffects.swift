import Foundation

/// One explicit asynchronous cycle. The Engine owns policy/storage; this latch only drains accepted callbacks.
final class NativeReminderEffects: @unchecked Sendable {
    static var unavailable: HostFailure { HostFailure("NOT_READY: Reminder reconciliation is unavailable") }
    struct Alarm: Sendable { let id: Int; let identifier: String; let json: String; let withdrawn: Bool }
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
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func begin() throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        guard !closed, active == nil else { throw Self.unavailable }
        let id = UUID(); active = id; return id
    }
    func finish(_ id: UUID) {
        lock.lock()
        if active == id { active = nil }
        let resumed = active == nil ? waiters : []
        if active == nil { waiters.removeAll() }
        lock.unlock()
        resumed.forEach { $0.resume() }
    }
    func closeAndDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock(); closed = true
            if active == nil { lock.unlock(); continuation.resume() }
            else { waiters.append(continuation); lock.unlock() }
        }
    }

    static func checkInventory(_ observations: [NativeReminderObservation]) throws {
        guard observations.count <= 4096, Set(observations.map(\.identifier)).count == observations.count else { throw unavailable }
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
