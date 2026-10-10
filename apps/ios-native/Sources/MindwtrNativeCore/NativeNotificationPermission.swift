import Foundation
import UserNotifications

/// A passive snapshot; it grants no authority to schedule, remove or request permission.
struct NativeNotificationPermission: Sendable {
    typealias Reader = @Sendable () async throws -> NativeNotificationPermission
    let status: String
    let granted: Bool
    let canAskAgain: Bool
    var json: [String: Any] { ["status": status, "granted": granted, "canAskAgain": canAskAgain] }

    static func observed(status: UNAuthorizationStatus, alertEnabled: Bool) -> Self {
        switch status {
        case .notDetermined: return Self(status: "not-determined", granted: false, canAskAgain: true)
        case .denied: return Self(status: "denied", granted: false, canAskAgain: false)
        case .authorized: return Self(status: "authorized", granted: alertEnabled, canAskAgain: false)
        case .provisional: return Self(status: "provisional", granted: alertEnabled, canAskAgain: false)
        #if os(iOS)
        case .ephemeral: return Self(status: "ephemeral", granted: alertEnabled, canAskAgain: false)
        #endif
        default: return Self(status: "unavailable", granted: false, canAskAgain: false)
        }
    }

    static func read() async -> Self {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: observed(status: settings.authorizationStatus,
                    alertEnabled: settings.alertSetting == .enabled))
            }
        }
    }
}

struct NativeReminderPlanReadAdmission: Sendable {
    let generation: UInt64
    let read: NativeNotificationPermission.Reader
}
