import Foundation
import UserNotifications

public enum NativeContextAutomationNotification {
    static let reminderID = 2_147_483_647
    static let kind = "context-automation"

    static func request(title: String, message: String, context: String, namespace: String) -> UNNotificationRequest? {
        guard NativeReminderRequest.validNamespace(namespace), !title.isEmpty, !context.isEmpty,
              title.utf16.count <= 4_000, message.utf16.count <= 16_000, context.utf16.count <= 500 else { return nil }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        content.userInfo = [
            "data": ["alarmKey": kind, "kind": kind, "context": context],
            "mindwtrNativeReminder": ["version": 1, "namespace": namespace, "id": reminderID] as [String: Any],
        ]
        return UNNotificationRequest(identifier: "mindwtr-native:\(namespace):\(reminderID)", content: content, trigger: nil)
    }

    public static func post(title: String, message: String, context: String, namespace: String) async -> Bool {
        guard let request = request(title: title, message: message, context: context, namespace: namespace) else { return false }
        return await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().add(request) { error in continuation.resume(returning: error == nil) }
        }
    }
}
