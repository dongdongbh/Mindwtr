import Foundation
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

/// Pure request objects: these tests never obtain a notification center or apply a request.
final class NativeReminderRequestTests: XCTestCase {
    private let namespace = "tech.dongdongbh.mindwtr.native-ui.439_01"
    private let fireAtMs: Double = 1_900_000_000_123
    private let snoozeKey = "snooze:12345678-1234-1234-1234-123456789abc"

    private func alarm() -> [String: Any] {
        [
            "key": "task:synthetic-439", "id": 439, "fireAtMs": fireAtMs, "repeat": "once", "replacing": NSNull(),
            "details": [
                "title": "\u{FEFF}準備 🧭", "message": "Line one\n第二行 e\u{301}", "tag": "task:synthetic-439",
                "play_sound": true, "has_button": true, "has_complete_action": true,
                "data": ["alarmKey": "task:synthetic-439", "taskId": "synthetic-439", "notificationActionComplete": "true"],
            ] as [String: Any],
        ]
    }

    private func details(_ input: [String: Any], changing field: String, to value: Any?) -> [String: Any] {
        var output = input
        var details = output["details"] as! [String: Any]
        details[field] = value; output["details"] = details
        return output
    }

    private func assertInvalid(_ input: [String: Any], namespace: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try NativeReminderRequest.make(alarm: input, namespace: namespace ?? self.namespace), file: file, line: line) { error in
            guard let failure = error as? HostFailure else { return XCTFail("Expected the fixed host failure", file: file, line: line) }
            XCTAssertEqual(failure.message, "Native reminder alarm is invalid", file: file, line: line)
        }
    }

    func testStableScopedIdentifiersAndStrictNativeMetadataPreserveExactContent() throws {
        var input = alarm()
        var unsafeDetails = input["details"] as! [String: Any]
        unsafeDetails["mindwtrNativeReminder"] = ["version": 999, "namespace": "foreign", "id": 1]
        unsafeDetails["categoryIdentifier"] = "foreign-actions"
        unsafeDetails["sound"] = "arbitrary-file"
        unsafeDetails["url"] = "https://example.invalid/private"
        input["details"] = unsafeDetails
        input["mindwtrNativeReminder"] = ["version": 999]
        let first = try NativeReminderRequest.make(alarm: input, namespace: namespace)
        let retry = try NativeReminderRequest.make(alarm: input, namespace: namespace)
        let otherLibrary = try NativeReminderRequest.make(alarm: input, namespace: namespace + ".other")
        XCTAssertEqual(first.identifier, "mindwtr-native:\(namespace):439")
        XCTAssertEqual(first.identifier, retry.identifier)
        XCTAssertNotEqual(first.identifier, otherLibrary.identifier)
        XCTAssertEqual(first.content.title, unsafeDetails["title"] as? String)
        XCTAssertEqual(first.content.body, unsafeDetails["message"] as? String)
        XCTAssertEqual(first.content.threadIdentifier, unsafeDetails["tag"] as? String)
        XCTAssertEqual(first.content.userInfo["data"] as? [String: String], unsafeDetails["data"] as? [String: String])
        XCTAssertEqual(Set(first.content.userInfo.keys.compactMap { $0 as? String }), Set(["data", "mindwtrNativeReminder"]))
        let metadata = try XCTUnwrap(first.content.userInfo["mindwtrNativeReminder"] as? [String: Any])
        XCTAssertEqual(Set(metadata.keys), Set(["version", "namespace", "id"]))
        XCTAssertEqual(metadata["version"] as? Int, 1)
        XCTAssertEqual(metadata["namespace"] as? String, namespace)
        XCTAssertEqual(metadata["id"] as? Int, 439)
        XCTAssertEqual(first.content.categoryIdentifier, "")
        XCTAssertTrue(first.content.attachments.isEmpty)
        XCTAssertEqual(first.content.sound, UNNotificationSound.default)
        XCTAssertNil(try NativeReminderRequest.make(alarm: details(input, changing: "play_sound", to: false), namespace: namespace).content.sound)
    }

    func testJSONDecodedSharedShapeKeepsBooleanAndNumberTypesDistinct() throws {
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: alarm())) as? [String: Any])
        XCTAssertEqual(try NativeReminderRequest.make(alarm: decoded, namespace: namespace).identifier, "mindwtr-native:\(namespace):439")
        var booleanID = decoded; booleanID["id"] = true
        assertInvalid(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: booleanID)) as? [String: Any]))
        let numericSound = details(decoded, changing: "play_sound", to: 1)
        assertInvalid(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: numericSound)) as? [String: Any]))
    }

    func testAbsoluteOneShotPreservesUTCInstantIncludingMilliseconds() throws {
        let request = try NativeReminderRequest.make(alarm: alarm(), namespace: namespace)
        let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        let components = trigger.dateComponents
        XCTAssertEqual(components.calendar?.identifier, .gregorian)
        XCTAssertEqual(components.timeZone?.secondsFromGMT(), 0)
        for field in [.era, .year, .month, .day, .hour, .minute, .second, .nanosecond] as [Calendar.Component] {
            XCTAssertNotNil(components.value(for: field))
        }
        let date = try XCTUnwrap(trigger.nextTriggerDate())
        XCTAssertEqual(date.timeIntervalSince1970, fireAtMs / 1_000, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(components.calendar?.date(from: components)), Date(timeIntervalSince1970: fireAtMs / 1_000))
    }

    func testElapsedOneShotIsNotShiftedToNow() throws {
        var input = alarm(); input["fireAtMs"] = -123_456_789
        let trigger = try XCTUnwrap(try NativeReminderRequest.make(alarm: input, namespace: namespace).trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        let components = trigger.dateComponents
        XCTAssertEqual(try XCTUnwrap(components.calendar?.date(from: components)), Date(timeIntervalSince1970: -123_456.789))
    }

    func testDailyUsesOriginalSlotInsteadOfDSTAdjustedFirstFireAndDoesNotPinZone() throws {
        var input = alarm(); input["repeat"] = "daily"; input["calendar"] = ["hour": 2, "minute": 30]
        // First shared fire is 03:30 in New York's DST gap; the recurring configured slot remains 02:30.
        input["fireAtMs"] = 2_120_110_200_000 // 2037-03-08T07:30:00Z
        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        let firstFire = Date(timeIntervalSince1970: 2_120_110_200)
        XCTAssertEqual(newYork.component(.hour, from: firstFire), 3)
        XCTAssertEqual(newYork.component(.minute, from: firstFire), 30)
        let trigger = try XCTUnwrap(try NativeReminderRequest.make(alarm: input, namespace: namespace).trigger as? UNCalendarNotificationTrigger)
        XCTAssertTrue(trigger.repeats)
        let components = trigger.dateComponents
        XCTAssertEqual(components.hour, 2); XCTAssertEqual(components.minute, 30); XCTAssertEqual(components.second, 0)
        assertUnpinned(components)
        XCTAssertNil(components.weekday)
    }

    func testWeeklyMapsSundayAndSaturdayWithoutPinnedDates() throws {
        for (sharedDay, nativeDay) in [(0, 1), (6, 7)] {
            var input = alarm(); input["repeat"] = "weekly"
            input["calendar"] = ["hour": 18, "minute": 5, "weekday": sharedDay]
            let trigger = try XCTUnwrap(try NativeReminderRequest.make(alarm: input, namespace: namespace).trigger as? UNCalendarNotificationTrigger)
            XCTAssertTrue(trigger.repeats)
            let components = trigger.dateComponents
            XCTAssertEqual(components.hour, 18); XCTAssertEqual(components.minute, 5); XCTAssertEqual(components.second, 0)
            XCTAssertEqual(components.weekday, nativeDay)
            assertUnpinned(components)
        }
    }

    private func assertUnpinned(_ components: DateComponents, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(components.calendar, file: file, line: line); XCTAssertNil(components.timeZone, file: file, line: line)
        for field in [.era, .year, .month, .day, .nanosecond, .weekOfMonth, .weekOfYear, .yearForWeekOfYear] as [Calendar.Component] {
            XCTAssertNil(components.value(for: field), file: file, line: line)
        }
    }

    func testActualSharedSnoozeShapePreservesOriginalOwnerPayloadAndScopedID() throws {
        var input = alarm(); input["key"] = snoozeKey; input["id"] = 1_073_741_824
        let request = try NativeReminderRequest.make(alarm: input, namespace: namespace)
        XCTAssertEqual(request.identifier, "mindwtr-native:\(namespace):1073741824")
        XCTAssertEqual((request.content.userInfo["data"] as? [String: String])?["alarmKey"], "task:synthetic-439")
        XCTAssertFalse(try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger).repeats)
        input["id"] = 2_147_483_647
        XCTAssertEqual(try NativeReminderRequest.make(alarm: input, namespace: namespace).identifier, "mindwtr-native:\(namespace):2147483647")
    }

    func testMalformedSnoozeProvenanceRefusesWithoutRewritingPayload() {
        var snooze = alarm(); snooze["key"] = snoozeKey; snooze["id"] = 1_073_741_824
        for key in ["snooze:", "snooze:not-a-uuid", "snooze:12345678-1234-1234-1234-123456789abC", snoozeKey + "\n", "Snooze:12345678-1234-1234-1234-123456789abc"] {
            var invalid = snooze; invalid["key"] = key; assertInvalid(invalid)
        }
        var lowID = snooze; lowID["id"] = 1_073_741_823; assertInvalid(lowID)
        var repeating = snooze; repeating["repeat"] = "daily"; repeating["calendar"] = ["hour": 2, "minute": 30]; assertInvalid(repeating)
        for owner in ["", snoozeKey] {
            assertInvalid(details(snooze, changing: "data", to: ["alarmKey": owner]))
        }
    }

    func testNamespaceAndOrdinaryIdentityRefuseMalformedValues() throws {
        for namespace in ["", String(repeating: "a", count: 256), "a:b", "a/b", "a b", "a\n", "é", "a\u{0}"] {
            assertInvalid(alarm(), namespace: namespace)
        }
        XCTAssertNoThrow(try NativeReminderRequest.make(alarm: alarm(), namespace: String(repeating: "a", count: 255)))
        var boundary = alarm(); boundary["id"] = 1_073_741_823
        XCTAssertTrue(try NativeReminderRequest.make(alarm: boundary, namespace: namespace).identifier.hasSuffix(":1073741823"))
        for id in [true, false, 0, -1, 1.5, 1_073_741_824, 2_147_483_648, Double.nan, Double.infinity, "439", NSNull()] as [Any] {
            var invalid = alarm(); invalid["id"] = id; assertInvalid(invalid)
        }
        var emptyKey = alarm(); emptyKey["key"] = ""; assertInvalid(emptyKey)
        for field in ["key", "id"] { var missing = alarm(); missing[field] = nil; assertInvalid(missing) }
        assertInvalid(details(alarm(), changing: "data", to: ["alarmKey": "task:other"]))
    }

    func testRequiredDetailsAndPayloadTypesAreStrict() {
        for field in ["title", "message", "tag", "play_sound", "data"] {
            assertInvalid(details(alarm(), changing: field, to: nil))
            assertInvalid(details(alarm(), changing: field, to: NSNull()))
        }
        for field in ["title", "message", "tag"] { assertInvalid(details(alarm(), changing: field, to: 439)) }
        for value in [0, 1, "true", NSNull()] as [Any] { assertInvalid(details(alarm(), changing: "play_sound", to: value)) }
        for value in ["not-an-object", ["alarmKey": "task:synthetic-439", "number": 1] as [String: Any], ["alarmKey": "task:synthetic-439", "flag": true] as [String: Any], ["alarmKey": "task:synthetic-439", "missing": NSNull()] as [String: Any], [:] as [String: String]] as [Any] {
            assertInvalid(details(alarm(), changing: "data", to: value))
        }
        var missingDetails = alarm(); missingDetails["details"] = nil; assertInvalid(missingDetails)
        var wrongDetails = alarm(); wrongDetails["details"] = "private-invalid-payload"; assertInvalid(wrongDetails)
    }

    func testFireInstantAndRepeatTypesRefuseInvalidValues() {
        for value in [true, false, Double.nan, Double.infinity, -Double.infinity, Double.greatestFiniteMagnitude, 8_640_000_000_000_001 as Int64, 1_900_000_000_123.5, "1900000000123", NSNull()] as [Any] {
            var invalid = alarm(); invalid["fireAtMs"] = value; assertInvalid(invalid)
        }
        var missingFire = alarm(); missingFire["fireAtMs"] = nil; assertInvalid(missingFire)
        for value in ["hourly", "", true, 1, NSNull()] as [Any] {
            var invalid = alarm(); invalid["repeat"] = value; assertInvalid(invalid)
        }
        var missingRepeat = alarm(); missingRepeat["repeat"] = nil; assertInvalid(missingRepeat)
        var onceWithSlot = alarm(); onceWithSlot["calendar"] = ["hour": 2, "minute": 30]; assertInvalid(onceWithSlot)
        onceWithSlot["calendar"] = NSNull(); assertInvalid(onceWithSlot)
    }

    func testRepeatingCalendarRequiresExactNonBooleanBoundedIntegerShape() {
        let invalidSlots: [Any] = [
            NSNull(), "02:30", [:] as [String: Any], ["hour": 2], ["hour": 2, "minute": 30, "extra": 0],
            ["hour": true, "minute": 30] as [String: Any], ["hour": 2, "minute": false] as [String: Any],
            ["hour": 2.5, "minute": 30], ["hour": 2, "minute": 30.5], ["hour": 24, "minute": 30],
            ["hour": -1, "minute": 30], ["hour": 2, "minute": 60], ["hour": 2, "minute": -1],
            ["hour": "2", "minute": 30] as [String: Any], ["hour": 2, "minute": Double.infinity],
        ]
        for slot in invalidSlots {
            var invalid = alarm(); invalid["repeat"] = "daily"; invalid["calendar"] = slot; assertInvalid(invalid)
        }
        var missing = alarm(); missing["repeat"] = "daily"; assertInvalid(missing)
        var dailyWithDay = missing; dailyWithDay["calendar"] = ["hour": 2, "minute": 30, "weekday": 0]; assertInvalid(dailyWithDay)
        var weekly = alarm(); weekly["repeat"] = "weekly"; weekly["calendar"] = ["hour": 2, "minute": 30]; assertInvalid(weekly)
        for day in [true, false, -1, 7, 0.5, Double.nan, "0", NSNull()] as [Any] {
            weekly["calendar"] = ["hour": 2, "minute": 30, "weekday": day]; assertInvalid(weekly)
        }
    }
}
