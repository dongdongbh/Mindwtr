import CoreFoundation
import Foundation
import UserNotifications

/// Converts the shared alarm value only. Applying requests and admitting their owners are separate operations.
enum NativeReminderRequest {
    private static let invalid = "Native reminder alarm is invalid"
    private static let snoozeBase = 1_073_741_824

    static func make(alarm: [String: Any], namespace: String) throws -> UNNotificationRequest {
        guard !namespace.isEmpty, namespace.utf8.count <= 255,
              namespace.utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
                      || byte == 46 || byte == 45 || byte == 95
              }),
              let key = alarm["key"] as? String, !key.isEmpty,
              let id = integer(alarm["id"], within: 1...2_147_483_647),
              let milliseconds = integerNumber(alarm["fireAtMs"]), abs(milliseconds) <= 8_640_000_000_000_000,
              let repeatKind = alarm["repeat"] as? String,
              let details = alarm["details"] as? [String: Any],
              let title = details["title"] as? String, let message = details["message"] as? String,
              let tag = details["tag"] as? String,
              let sound = details["play_sound"] as? NSNumber, CFGetTypeID(sound) == CFBooleanGetTypeID(),
              let data = details["data"] as? [String: String], let ownerKey = data["alarmKey"], !ownerKey.isEmpty else {
            throw HostFailure(invalid)
        }

        if key.hasPrefix("snooze:") {
            // Shared Snooze receipts retain the original alarm's payload for owner withdrawal and tap routing.
            guard key.range(of: #"\Asnooze:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z"#,
                            options: .regularExpression) != nil,
                  id >= snoozeBase, repeatKind == "once", !ownerKey.hasPrefix("snooze:") else {
                throw HostFailure(invalid)
            }
        } else {
            guard id < snoozeBase, ownerKey == key else { throw HostFailure(invalid) }
        }

        // Validate the instant even for repeats; their original wall-clock slot, rather than this first fire, is used below.
        let absolute = try absoluteComponents(milliseconds)
        let trigger: UNCalendarNotificationTrigger
        switch repeatKind {
        case "once":
            guard alarm["calendar"] == nil else { throw HostFailure(invalid) }
            trigger = UNCalendarNotificationTrigger(dateMatching: absolute, repeats: false)
        case "daily", "weekly":
            guard let slot = alarm["calendar"] as? [String: Any],
                  Set(slot.keys) == (repeatKind == "daily" ? Set(["hour", "minute"]) : Set(["hour", "minute", "weekday"])),
                  let hour = integer(slot["hour"], within: 0...23), let minute = integer(slot["minute"], within: 0...59) else {
                throw HostFailure(invalid)
            }
            var components = DateComponents()
            components.hour = hour; components.minute = minute; components.second = 0
            if repeatKind == "weekly" {
                guard let weekday = integer(slot["weekday"], within: 0...6) else { throw HostFailure(invalid) }
                components.weekday = weekday + 1
            }
            // Leaving calendar and timeZone unset preserves the configured local slot after zone and DST changes.
            trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
        default:
            throw HostFailure(invalid)
        }

        let content = UNMutableNotificationContent()
        content.title = title; content.body = message; content.threadIdentifier = tag
        content.sound = sound.boolValue ? .default : nil
        content.userInfo = [
            "data": data,
            "mindwtrNativeReminder": ["version": 1, "namespace": namespace, "id": id] as [String: Any],
        ]
        return UNNotificationRequest(identifier: "mindwtr-native:\(namespace):\(id)", content: content, trigger: trigger)
    }

    private static func integerNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.doubleValue
    }

    private static func integer(_ value: Any?, within range: ClosedRange<Int>) -> Int? {
        guard let number = integerNumber(value), number >= Double(range.lowerBound), number <= Double(range.upperBound) else { return nil }
        return Int(number)
    }

    private static func absoluteComponents(_ milliseconds: Double) throws -> DateComponents {
        guard let utc = TimeZone(secondsFromGMT: 0) else { throw HostFailure(invalid) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let date = Date(timeIntervalSince1970: milliseconds / 1_000)
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
