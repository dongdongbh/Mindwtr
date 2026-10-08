import Foundation
import UserNotifications

/// SDK objects are inspected on their callback queue; only immutable observations leave it.
struct NativeReminderObservation: Sendable, Equatable {
    let identifier: String
    let ownedID: Int?
    let threadIdentifier: String
    let deliveredAtMs: Double?

    static func read(_ request: UNNotificationRequest, namespace: String, deliveredAt: Date? = nil) -> Self {
        Self(identifier: request.identifier,
             ownedID: NativeReminderRequest.ownedID(identifier: request.identifier,
                metadata: request.content.userInfo["mindwtrNativeReminder"], namespace: namespace),
             threadIdentifier: request.content.threadIdentifier, deliveredAtMs: deliveredAt.map { $0.timeIntervalSince1970 * 1000 })
    }
}

protocol NativeReminderPort: Sendable {
    func permission() async throws -> NativeNotificationPermission
    func pending(namespace: String) async throws -> [NativeReminderObservation]
    func delivered(namespace: String) async throws -> [NativeReminderObservation]
    func add(_ alarm: NativeReminderEffects.Alarm, namespace: String) async throws
    func removePending(_ identifiers: [String]) async throws
    func removeDelivered(_ identifiers: [String]) async throws
}

/// Passive observations and explicit mutations only; authorization/categories/actions are deliberately absent.
final class NativeSystemReminderPort: NativeReminderPort, @unchecked Sendable {
    private let center = UNUserNotificationCenter.current()
    func permission() async throws -> NativeNotificationPermission { await NativeNotificationPermission.read() }
    func pending(namespace: String) async throws -> [NativeReminderObservation] {
        await withCheckedContinuation { continuation in
            center.getPendingNotificationRequests { requests in
                continuation.resume(returning: requests.map { .read($0, namespace: namespace) })
            }
        }
    }
    func delivered(namespace: String) async throws -> [NativeReminderObservation] {
        await withCheckedContinuation { continuation in
            center.getDeliveredNotifications { notifications in
                continuation.resume(returning: notifications.map { .read($0.request, namespace: namespace, deliveredAt: $0.date) })
            }
        }
    }
    func add(_ alarm: NativeReminderEffects.Alarm, namespace: String) async throws {
        guard let value = try NativeJSON.jsonObject(with: Data(alarm.json.utf8)) as? [String: Any] else {
            throw NativeReminderEffects.unavailable
        }
        let request = try NativeReminderRequest.make(alarm: value, namespace: namespace)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if error != nil { continuation.resume(throwing: NativeReminderEffects.unavailable) }
                else { continuation.resume() }
            }
        }
    }
    func removePending(_ identifiers: [String]) async throws { center.removePendingNotificationRequests(withIdentifiers: identifiers) }
    func removeDelivered(_ identifiers: [String]) async throws { center.removeDeliveredNotifications(withIdentifiers: identifiers) }
}
