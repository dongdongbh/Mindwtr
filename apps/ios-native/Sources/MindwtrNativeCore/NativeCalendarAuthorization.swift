import Foundation
#if os(iOS) && canImport(EventKit)
import EventKit
#endif

/// Explicit Settings permission only. The accepted system callback is not cancellable; its owner drains it.
final class NativeCalendarAuthorization: @unchecked Sendable {
    typealias Requester = @Sendable () async throws -> Void
    private let lock = NSLock()
    private var active: UUID?
    private var cancelled = false
    private var readmissionTask: Task<Bool, Never>?
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func begin() throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        guard !closed, active == nil else { throw CoreHostRejection(message: "NOT_READY: Calendar edit is unavailable") }
        let id = UUID(); active = id; cancelled = false; return id
    }
    func finish(_ id: UUID) {
        lock.lock()
        guard active == id else { lock.unlock(); return }
        active = nil
        let task = readmissionTask; readmissionTask = nil
        let pending = waiters; waiters.removeAll()
        lock.unlock(); task?.cancel(); pending.forEach { $0.resume() }
    }
    private func startReadmission(_ id: UUID, check: @escaping @Sendable () async -> Bool) -> Task<Bool, Never>? {
        lock.lock(); defer { lock.unlock() }
        guard active == id, !closed, !cancelled, readmissionTask == nil else { return nil }
        let task = Task { await check() }
        readmissionTask = task
        return task
    }
    private func finishReadmission(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard active == id else { return false }
        readmissionTask = nil
        return !closed && !cancelled
    }
    func readmit(_ id: UUID, check: @escaping @Sendable () async -> Bool) async -> Bool {
        guard let task = startReadmission(id, check: check) else { return false }
        let current = await task.value
        let admitted = finishReadmission(id)
        return current && admitted && !task.isCancelled
    }
    func cancelReadmission(_ id: UUID) {
        lock.lock()
        if active == id { cancelled = true }
        let task = active == id ? readmissionTask : nil
        lock.unlock(); task?.cancel()
    }
    func closeAndDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock(); closed = true
            let task = readmissionTask
            if active == nil { lock.unlock(); task?.cancel(); continuation.resume() }
            else { waiters.append(continuation); lock.unlock(); task?.cancel() }
        }
    }
    static func request() async throws {
        #if os(iOS) && canImport(EventKit)
        let store = EKEventStore()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completion: (Bool, Error?) -> Void = { [store] _, error in
                withExtendedLifetime(store) {
                    if error != nil { continuation.resume(throwing: HostFailure("Calendar authorization is unavailable")) }
                    else { continuation.resume() }
                }
            }
            if #available(iOS 17.0, *) { store.requestFullAccessToEvents(completion: completion) }
            else { store.requestAccess(to: .event, completion: completion) }
        }
        #else
        throw HostFailure("Calendar authorization is unavailable")
        #endif
    }
}
