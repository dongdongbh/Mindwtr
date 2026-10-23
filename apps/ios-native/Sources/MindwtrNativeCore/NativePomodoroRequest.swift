import CoreFoundation
import CryptoKit
import Foundation
import UserNotifications

/// Pure conversion of the core schedule intent; publication and durable ownership live elsewhere.
enum NativePomodoroRequest {
    struct Identity: Equatable, Sendable {
        let namespace: String
        let libraryDigest: String
        let sessionID: String
        let phase: String
        let fireAtMs: Int64
        var scope: String { namespace + ":" + libraryDigest }
    }

    private static let invalid = "Native Pomodoro schedule intent is invalid"

    static func ownedIdentity(identifier: String, metadata: Any?, namespace: String, libraryID: String) -> Identity? {
        guard let digest = libraryDigest(libraryID),
              let identity = ownedIdentity(identifier: identifier, metadata: metadata, namespace: namespace),
              identity.libraryDigest == digest else { return nil }
        return identity
    }

    static func scope(namespace: String, libraryID: String) -> String? {
        guard NativeReminderRequest.validNamespace(namespace), let digest = libraryDigest(libraryID) else { return nil }
        return namespace + ":" + digest
    }

    static func ownedIdentity(identifier: String, metadata: Any?, namespace: String) -> Identity? {
        guard NativeReminderRequest.validNamespace(namespace),
              let value = metadata as? [String: Any],
              Set(value.keys) == Set(["version", "namespace", "libraryDigest", "sessionID", "phase", "fireAtMs"]),
              milliseconds(value["version"]) == 1, value["namespace"] as? String == namespace,
              let digest = value["libraryDigest"] as? String,
              digest.range(of: #"\A[0-9a-f]{64}\z"#, options: .regularExpression) != nil,
              let sessionID = value["sessionID"] as? String, validSessionID(sessionID),
              let phase = value["phase"] as? String, phase == "focus" || phase == "break",
              let fireAtMs = milliseconds(value["fireAtMs"]),
              (try? absoluteComponents(fireAtMs)) != nil else { return nil }
        let identity = Identity(namespace: namespace, libraryDigest: digest, sessionID: sessionID,
                                phase: phase, fireAtMs: fireAtMs)
        return (try? requestIdentifier(identity)) == identifier ? identity : nil
    }

    static func make(intent: [String: Any], namespace: String, libraryID: String) throws -> UNNotificationRequest {
        guard NativeReminderRequest.validNamespace(namespace), let digest = libraryDigest(libraryID),
              intent["kind"] as? String == "schedule",
              let sessionID = intent["sessionID"] as? String, validSessionID(sessionID),
              let phase = intent["phase"] as? String, phase == "focus" || phase == "break",
              let fireAtMs = milliseconds(intent["fireAtMs"]), milliseconds(intent["observedAtMs"]) != nil,
              let immediate = boolean(intent["immediate"]),
              let details = intent["details"] as? [String: Any],
              let title = details["title"] as? String, let message = details["message"] as? String,
              let sound = boolean(details["play_sound"]),
              boolean(details["has_button"]) == false, boolean(details["has_complete_action"]) == false,
              let data = details["data"] as? [String: String], Set(data.keys) == Set(["kind", "phase"]),
              data["kind"] == "pomodoro", data["phase"] == phase + "-complete" else {
            throw HostFailure(invalid)
        }
        let identity = Identity(namespace: namespace, libraryDigest: digest, sessionID: sessionID,
                                phase: phase, fireAtMs: fireAtMs)
        let absolute = try absoluteComponents(fireAtMs)
        let content = UNMutableNotificationContent()
        content.title = title; content.body = message
        content.sound = sound ? .default : nil
        content.userInfo = [
            "data": data,
            "mindwtrNativePomodoro": ["version": 1, "namespace": namespace, "libraryDigest": digest,
                                      "sessionID": sessionID, "phase": phase, "fireAtMs": fireAtMs] as [String: Any],
        ]
        return UNNotificationRequest(identifier: try requestIdentifier(identity), content: content,
                                     trigger: immediate ? nil : UNCalendarNotificationTrigger(dateMatching: absolute, repeats: false))
    }

    private static func requestIdentifier(_ identity: Identity) throws -> String {
        let framed: [Any] = [1, identity.namespace, identity.libraryDigest, identity.sessionID, identity.phase, identity.fireAtMs]
        return "mindwtr-native-pomodoro:" + digest(try JSONSerialization.data(withJSONObject: framed))
    }

    private static func libraryDigest(_ libraryID: String) -> String? {
        guard !libraryID.isEmpty, libraryID.utf8.count <= 1_024 else { return nil }
        return digest(Data(libraryID.utf8))
    }

    private static func digest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    private static func validSessionID(_ sessionID: String) -> Bool {
        sessionID.range(of: #"\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z"#,
                        options: .regularExpression) != nil
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func milliseconds(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              abs(number.doubleValue) <= 8_640_000_000_000_000 else { return nil }
        let integer = Int64(number.doubleValue)
        return number.decimalValue == NSNumber(value: integer).decimalValue ? integer : nil
    }

    private static func absoluteComponents(_ milliseconds: Int64) throws -> DateComponents {
        guard let utc = TimeZone(secondsFromGMT: 0) else { throw HostFailure(invalid) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
        var components = calendar.dateComponents([.era, .year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
        components.calendar = calendar; components.timeZone = utc
        guard let era = components.era, (0...1).contains(era), let year = components.year, year >= 1,
              let month = components.month, (1...12).contains(month), let day = components.day, (1...31).contains(day),
              let hour = components.hour, (0...23).contains(hour), let minute = components.minute, (0...59).contains(minute),
              let second = components.second, (0...59).contains(second),
              let nanosecond = components.nanosecond, (0...999_999_999).contains(nanosecond),
              components.isValidDate(in: calendar), let represented = calendar.date(from: components), represented == date else {
            throw HostFailure(invalid)
        }
        return components
    }
}
