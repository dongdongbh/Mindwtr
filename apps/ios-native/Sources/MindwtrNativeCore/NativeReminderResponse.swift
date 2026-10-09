import CoreFoundation
import CryptoKit
import Foundation
import UserNotifications

/// A callback-queue snapshot only; durable acceptance and replay belong to the response inbox.
public struct NativeReminderResponse: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable {
        case open, complete, snooze, dismiss
    }

    public static let completeActionIdentifier = "MINDWTR_NATIVE_COMPLETE"
    public static let snoozeActionIdentifier = "MINDWTR_NATIVE_SNOOZE"
    public static let dismissActionIdentifier = "MINDWTR_NATIVE_DISMISS"

    public static func categories() -> Set<UNNotificationCategory> {
        let complete = UNNotificationAction(identifier: completeActionIdentifier, title: "Complete", options: [])
        let snooze = UNNotificationAction(identifier: snoozeActionIdentifier, title: "Snooze", options: [])
        let dismiss = UNNotificationAction(identifier: dismissActionIdentifier, title: "Dismiss", options: [.foreground])
        return Set((1...3).map { flags in
            var actions: [UNNotificationAction] = []
            if flags & 1 != 0 { actions.append(complete) }
            if flags & 2 != 0 { actions.append(snooze) }
            actions.append(dismiss)
            return UNNotificationCategory(identifier: "MINDWTR_NATIVE_RESPONSE_\(flags)", actions: actions,
                intentIdentifiers: [], options: [])
        })
    }

    static func categoryIdentifier(details: NSDictionary, data: NSDictionary) -> String {
        let flags = (completeTaskID(details, data: data) == nil ? 0 : 1) | (canSnooze(details, data: data) ? 2 : 0)
        return flags == 0 ? "" : "MINDWTR_NATIVE_RESPONSE_\(flags)"
    }

    public let requestID: String
    public let notificationIdentifier: String
    public let action: Action
    public let deliveredAtBits: String
    public let requestedAtMs: Int64
    public let payloadJSON: String

    public static func foregroundPresentation(_ request: UNNotificationRequest,
                                              selection: NativeLaunchSelection?) -> UNNotificationPresentationOptions {
        let namespace: String
        switch selection {
        case let .standard(_, _, selectedNamespace), let .isolated(_, _, selectedNamespace, _):
            namespace = selectedNamespace
        case nil, .rehearsal:
            return []
        }
        guard NativeReminderRequest.ownedID(identifier: request.identifier,
                                            metadata: request.content.userInfo["mindwtrNativeReminder"],
                                            namespace: namespace) != nil else { return [] }
        return request.content.sound == nil ? [.banner, .list] : [.banner, .list, .sound]
    }

    public static func capture(_ request: UNNotificationRequest, deliveredAt: Date, receivedAt: Date,
                               actionIdentifier: String, namespace: String) -> NativeReminderResponse? {
        guard NativeReminderRequest.ownedID(identifier: request.identifier,
                                            metadata: request.content.userInfo["mindwtrNativeReminder"],
                                            namespace: namespace) != nil,
              let action = action(actionIdentifier), validDate(deliveredAt), validDate(receivedAt),
              let data = request.content.userInfo["data"] as? NSDictionary, validData(data) else { return nil }
        let deliveredAtBits = String(format: "%016llx", deliveredAt.timeIntervalSinceReferenceDate.bitPattern)
        let requestedAtMs = Int64(floor(receivedAt.timeIntervalSince1970 * 1_000))
        var publication = "legacy-owned-v1"
        var details: NSDictionary?
        if let sidecar = request.content.userInfo["mindwtrNativeResponse"] {
            guard let fields = sidecar as? NSDictionary, fields.count == 3,
                  Set(fields.allKeys.compactMap { $0 as? String }) == Set(["version", "publication", "details"]),
                  let version = fields["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
                  let id = fields["publication"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
                  let json = fields["details"] as? String, json.utf8.count <= 60_000,
                  let original = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? NSDictionary,
                  validDetails(original, content: request.content, data: data) else { return nil }
            publication = id
            details = original
        }
        guard let requestID = identity(namespace: namespace, identifier: request.identifier,
                                       publication: publication, deliveredAtBits: deliveredAtBits, action: action) else { return nil }
        let payload: Any
        switch action {
        case .open:
            var fields: [String: String] = ["notificationId": request.identifier, "actionIdentifier": "open"]
            for field in ["kind", "taskId", "projectId", "context"] {
                if let value = data[field] as? String { fields[field] = value }
            }
            payload = fields
        case .dismiss:
            payload = [String: String]()
        case .complete:
            guard let details, let taskID = completeTaskID(details, data: data) else { return nil }
            payload = ["requestId": requestID, "taskId": taskID]
        case .snooze:
            guard let details, canSnooze(details, data: data) else { return nil }
            payload = ["requestId": requestID, "requestedAt": requestedAtMs, "details": details] as [String: Any]
        }
        guard let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              encoded.count <= 65_536, let json = String(data: encoded, encoding: .utf8) else { return nil }
        return NativeReminderResponse(requestID: requestID, notificationIdentifier: request.identifier, action: action,
                                      deliveredAtBits: deliveredAtBits, requestedAtMs: requestedAtMs, payloadJSON: json)
    }

    private static func action(_ identifier: String) -> Action? {
        switch identifier {
        case UNNotificationDefaultActionIdentifier: return .open
        case completeActionIdentifier: return .complete
        case snoozeActionIdentifier: return .snooze
        case dismissActionIdentifier, UNNotificationDismissActionIdentifier: return .dismiss
        default: return nil
        }
    }

    private static func validDate(_ date: Date) -> Bool {
        let milliseconds = date.timeIntervalSince1970 * 1_000
        return date.timeIntervalSinceReferenceDate.isFinite && milliseconds.isFinite
            && abs(milliseconds) <= 8_640_000_000_000_000
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func validData(_ data: NSDictionary) -> Bool {
        guard let owner = data["alarmKey"] as? String, !owner.isEmpty else { return false }
        return data.allSatisfy { $0.key is String && $0.value is String }
    }

    private static func sameText(_ value: Any?, _ text: String) -> Bool {
        guard let value = value as? String else { return false }
        return value.utf8.elementsEqual(text.utf8)
    }

    private static func validDetails(_ details: NSDictionary, content: UNNotificationContent, data: NSDictionary) -> Bool {
        guard sameText(details["title"], content.title), sameText(details["message"], content.body),
              sameText(details["tag"], content.threadIdentifier), boolean(details["play_sound"]) != nil,
              let originalData = details["data"] as? NSDictionary, validData(originalData), originalData.count == data.count else { return false }
        return originalData.allSatisfy { key, value in
            guard let text = data[key] as? String else { return false }
            return sameText(value, text)
        }
    }

    private static func completeTaskID(_ details: NSDictionary, data: NSDictionary) -> String? {
        guard boolean(details["has_complete_action"]) == true,
              let taskID = data["taskId"] as? String, !taskID.isEmpty, taskID.utf16.count <= 500 else { return nil }
        return taskID
    }

    private static func canSnooze(_ details: NSDictionary, data: NSDictionary) -> Bool {
        guard let title = details["title"] as? String, title.utf16.count <= 10_000,
              let interval = details["snooze_interval"] as? NSNumber, CFGetTypeID(interval) != CFBooleanGetTypeID(),
              interval.doubleValue.isFinite, interval.doubleValue > 0,
              let owner = data["alarmKey"] as? String else { return false }
        return validSnoozeOwner(owner)
    }

    private static func validSnoozeOwner(_ owner: String) -> Bool {
        ["digest:morning", "digest:evening", "digest:weekly-review"].contains(owner)
            || owner.range(of: #"\A(task|project):.+\z"#, options: .regularExpression) != nil
    }

    private static func identity(namespace: String, identifier: String, publication: String,
                                 deliveredAtBits: String, action: Action) -> String? {
        guard let encoded = try? JSONSerialization.data(withJSONObject: [
            "mindwtr-native-response-v1", namespace, identifier, publication, deliveredAtBits, action.rawValue,
        ]) else { return nil }
        var bytes = Array(SHA256.hash(data: encoded).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x80 // UUID v8 denotes this custom SHA256 identity.
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])).uuidString.lowercased()
    }
}
