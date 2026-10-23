import Foundation
import UserNotifications

struct NativePomodoroAlarmObservation: Sendable, Equatable {
    let identifier: String
    let identity: NativePomodoroRequest.Identity?

    static func read(_ request: UNNotificationRequest, namespace: String) -> Self {
        Self(identifier: request.identifier, identity: NativePomodoroRequest.ownedIdentity(identifier: request.identifier,
            metadata: request.content.userInfo["mindwtrNativePomodoro"], namespace: namespace))
    }
    var ownedJSON: [String: Any]? {
        identity.map { ["identifier": identifier, "scope": $0.scope, "sessionID": $0.sessionID,
                        "phase": $0.phase, "fireAtMs": $0.fireAtMs] }
    }
}

protocol NativePomodoroAlarmPort: Sendable {
    func permission() async throws -> NativeNotificationPermission
    func pending(namespace: String) async throws -> [NativePomodoroAlarmObservation]
    func delivered(namespace: String) async throws -> [NativePomodoroAlarmObservation]
    func add(_ intentJSON: String, namespace: String, libraryID: String) async throws
    func removePending(_ identifiers: [String]) async throws
    func removeDelivered(_ identifiers: [String]) async throws
}

final class NativeSystemPomodoroAlarmPort: NativePomodoroAlarmPort, @unchecked Sendable {
    private let center = UNUserNotificationCenter.current()
    func permission() async throws -> NativeNotificationPermission { await NativeNotificationPermission.read() }
    func pending(namespace: String) async throws -> [NativePomodoroAlarmObservation] {
        await withCheckedContinuation { continuation in
            center.getPendingNotificationRequests { requests in
                continuation.resume(returning: requests.map { .read($0, namespace: namespace) })
            }
        }
    }
    func delivered(namespace: String) async throws -> [NativePomodoroAlarmObservation] {
        await withCheckedContinuation { continuation in
            center.getDeliveredNotifications { values in
                continuation.resume(returning: values.map { .read($0.request, namespace: namespace) })
            }
        }
    }
    func add(_ intentJSON: String, namespace: String, libraryID: String) async throws {
        guard intentJSON.utf8.count <= NativePomodoroAlarmEffects.intentLimit,
              let intent = try NativeJSON.jsonObject(with: Data(intentJSON.utf8)) as? [String: Any],
              try NativeJSON.hasUniqueObjectKeys(intentJSON) else { throw NativePomodoroAlarmEffects.unavailable }
        let request = try NativePomodoroRequest.make(intent: intent, namespace: namespace, libraryID: libraryID)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if error != nil { continuation.resume(throwing: NativePomodoroAlarmEffects.unavailable) }
                else { continuation.resume() }
            }
        }
    }
    func removePending(_ identifiers: [String]) async throws { center.removePendingNotificationRequests(withIdentifiers: identifiers) }
    func removeDelivered(_ identifiers: [String]) async throws { center.removeDeliveredNotifications(withIdentifiers: identifiers) }
}

#if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
/// Isolated lifecycle proof only; this port never obtains a notification center.
actor NativeSimulatorPomodoroAlarmPort: NativePomodoroAlarmPort {
    private let holdFirstAdd: Bool, denied: Bool, seedOwned: Bool
    private var bound = false, adds = 0, permissionReads = 0, pendingReads = 0, deliveredReads = 0
    private var removedPending = 0, removedDelivered = 0
    private var pendingValues: [NativePomodoroAlarmObservation] = [], deliveredValues: [NativePomodoroAlarmObservation] = []
    private var events: [String] = []
    private var heldAdd: CheckedContinuation<Void, Never>?
    init(holdFirstAdd: Bool, denied: Bool, seedOwned: Bool) {
        self.holdFirstAdd = holdFirstAdd; self.denied = denied; self.seedOwned = seedOwned
    }
    func bind(namespace: String, libraryID: String) throws {
        guard !bound else { return }; bound = true
        guard seedOwned else { return }
        let intent: [String: Any] = ["kind": "schedule", "sessionID": "58600000-0000-4000-8000-000000000001",
            "phase": "focus", "fireAtMs": 1_700_000_000_000 as Int64, "observedAtMs": 1_700_000_000_001 as Int64,
            "immediate": true, "details": ["title": "Fixture", "message": "Fixture", "play_sound": false,
                "has_button": false, "has_complete_action": false, "data": ["kind": "pomodoro", "phase": "focus-complete"]] as [String: Any]]
        let request = try NativePomodoroRequest.make(intent: intent, namespace: namespace, libraryID: libraryID)
        let observation = NativePomodoroAlarmObservation.read(request, namespace: namespace)
        pendingValues = [observation]; deliveredValues = [observation]; record("seed-owned")
    }
    private func record(_ event: String) { if events.count < 128 { events.append(event) } }
    func permission() async throws -> NativeNotificationPermission {
        permissionReads += 1; return .observed(status: denied ? .denied : .authorized, alertEnabled: !denied)
    }
    func pending(namespace: String) async throws -> [NativePomodoroAlarmObservation] { pendingReads += 1; return pendingValues }
    func delivered(namespace: String) async throws -> [NativePomodoroAlarmObservation] { deliveredReads += 1; return deliveredValues }
    func add(_ intentJSON: String, namespace: String, libraryID: String) async throws {
        guard let intent = try NativeJSON.jsonObject(with: Data(intentJSON.utf8)) as? [String: Any] else {
            throw NativePomodoroAlarmEffects.unavailable
        }
        let request = try NativePomodoroRequest.make(intent: intent, namespace: namespace, libraryID: libraryID)
        adds += 1; record("add")
        pendingValues.removeAll { $0.identifier == request.identifier }
        pendingValues.append(.read(request, namespace: namespace))
        if holdFirstAdd && adds == 1 { await withCheckedContinuation { heldAdd = $0; record("add-held") } }
    }
    func removePending(_ identifiers: [String]) async throws {
        removedPending += identifiers.count; record("remove-pending")
        pendingValues.removeAll { identifiers.contains($0.identifier) }
    }
    func removeDelivered(_ identifiers: [String]) async throws {
        removedDelivered += identifiers.count; record("remove-delivered")
        deliveredValues.removeAll { identifiers.contains($0.identifier) }
    }
    func release() { heldAdd?.resume(); heldAdd = nil; record("add-released") }
    func snapshot() throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: ["permissionReads": permissionReads, "pendingReads": pendingReads,
            "deliveredReads": deliveredReads, "addAttempts": adds, "removePending": removedPending,
            "removeDelivered": removedDelivered, "heldAdd": heldAdd != nil, "events": events]), as: UTF8.self)
    }
}
#endif
