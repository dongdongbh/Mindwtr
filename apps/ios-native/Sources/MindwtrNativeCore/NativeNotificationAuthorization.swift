import Foundation
import UserNotifications

/// Explicit Settings permission only. The accepted system callback is not cancellable; its owner drains it.
final class NativeNotificationAuthorization: @unchecked Sendable {
    typealias Requester = @Sendable () async throws -> Void
    private let lock = NSLock()
    private var active: UUID?
    private var cancelled = false
    private var readmissionTask: Task<Bool, Never>?
    private var closed = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func begin() throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        guard !closed, active == nil else { throw CoreHostRejection(message: "NOT_READY: Notification edit is unavailable") }
        let id = UUID(); active = id; cancelled = false; return id
    }
    func finish(_ id: UUID) {
        lock.lock()
        if active == id { active = nil }
        let pending = active == nil ? waiters : []
        if active == nil { waiters.removeAll() }
        lock.unlock(); pending.forEach { $0.resume() }
    }
    private func startReadmission(_ id: UUID, check: @escaping @Sendable () async -> Bool) -> Task<Bool, Never> {
        lock.lock(); defer { lock.unlock() }
        let task = Task { await check() }
        if active == id, !closed, !cancelled { readmissionTask = task }
        else { task.cancel() }
        return task
    }
    private func finishReadmission(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        if active == id { readmissionTask = nil }
    }
    func readmit(_ id: UUID, check: @escaping @Sendable () async -> Bool) async -> Bool {
        let task = startReadmission(id, check: check)
        let current = await task.value
        finishReadmission(id)
        return current && !task.isCancelled
    }
    func cancelReadmission(_ id: UUID) {
        lock.lock()
        if active == id { cancelled = true }
        let task = active == id ? readmissionTask : nil
        lock.unlock()
        task?.cancel()
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
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, error in
                if error != nil { continuation.resume(throwing: HostFailure("Notification authorization is unavailable")) }
                else { continuation.resume() }
            }
        }
    }
}

struct NativeNotificationSettingAdmission: Sendable {
    let replay: String?
    let requiresAuthorization: Bool
    let retryPending: Bool
    let request: NativeNotificationAuthorization.Requester
    let read: NativeNotificationPermission.Reader
}
