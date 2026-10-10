import Foundation
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

/// SDK values only: no notification center, host, storage, or scheduling effects.
final class NativeReminderResponseTests: XCTestCase {
    private let namespace = "tech.dongdongbh.mindwtr.native-ui.450"
    private let delivery = Date(timeIntervalSince1970: 1_900_000_000.123)
    private let received = Date(timeIntervalSince1970: 1_900_000_010.987)
    private let publication = "12345678-1234-4234-8234-123456789abc"

    private func details() -> [String: Any] {
        ["title": "\u{FEFF}準備 🧭", "message": "Line one\n第二行 e\u{301}", "tag": "task:synthetic-450",
         "play_sound": true, "has_complete_action": true, "snooze_interval": 10,
         "data": ["alarmKey": "task:synthetic-450", "taskId": "synthetic-450", "projectId": "project-450",
                  "kind": "task-review", "context": "@home", "notificationActionComplete": "true"],
         "unknown": ["nested": ["\u{FEFF}value", "e\u{301}", NSNull()]]]
    }

    private func request(_ original: Any? = nil, snoozed: Bool = false, namespace: String? = nil) throws -> UNNotificationRequest {
        try NativeReminderRequest.make(alarm: [
            "key": snoozed ? "snooze:\(publication)" : "task:synthetic-450",
            "id": snoozed ? 1_073_741_824 : 450, "fireAtMs": 1_900_000_000_123,
            "repeat": "once", "details": original ?? details(),
        ], namespace: namespace ?? self.namespace)
    }

    private func changing(_ request: UNNotificationRequest, _ change: (UNMutableNotificationContent) -> Void,
                          identifier: String? = nil) -> UNNotificationRequest {
        let content = request.content.mutableCopy() as! UNMutableNotificationContent
        change(content)
        return UNNotificationRequest(identifier: identifier ?? request.identifier, content: content, trigger: request.trigger)
    }

    private func capture(_ request: UNNotificationRequest, _ action: String = UNNotificationDefaultActionIdentifier,
                         deliveredAt: Date? = nil, receivedAt: Date? = nil, namespace: String? = nil) -> NativeReminderResponse? {
        NativeReminderResponse.capture(request, deliveredAt: deliveredAt ?? delivery, receivedAt: receivedAt ?? received,
                                       actionIdentifier: action, namespace: namespace ?? self.namespace)
    }

    private func payload(_ response: NativeReminderResponse) throws -> NSDictionary {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(response.payloadJSON.utf8)) as? NSDictionary)
    }

    private func assertForeground(_ request: UNNotificationRequest, selection: NativeLaunchSelection?,
                                  options: UNNotificationPresentationOptions,
                                  file: StaticString = #filePath, line: UInt = #line) {
        let identifier = request.identifier
        let content = request.content.mutableCopy() as! UNMutableNotificationContent
        let trigger = request.trigger
        XCTAssertEqual(NativeReminderResponse.foregroundPresentation(request, selection: selection), options, file: file, line: line)
        XCTAssertEqual(request.identifier, identifier, file: file, line: line)
        XCTAssertEqual(request.content, content, file: file, line: line)
        XCTAssertTrue(request.trigger === trigger, file: file, line: line)
    }

    func testForegroundPresentationUsesTrustedSelectionsAndSuppliedSound() throws {
        let container = URL(fileURLWithPath: "/synthetic453", isDirectory: true)
        let database = container.appendingPathComponent("mindwtr.sqlite")
        let identifier = try XCTUnwrap(UUID(uuidString: publication))
        let standardNamespace = "tech.dongdongbh.mindwtr.native.dev"
        let isolatedNamespace = "tech.dongdongbh.mindwtr.native-ui." + publication
        let selections: [(NativeLaunchSelection, String)] = [
            (.standard(databaseURL: database, containerURL: container, namespace: standardNamespace), standardNamespace),
            (.isolated(databaseURL: database, containerURL: container, namespace: isolatedNamespace, identifier: identifier), isolatedNamespace),
        ]
        for (selection, namespace) in selections {
            for sounding in [false, true] {
                var original = details(); original["play_sound"] = sounding
                let request = try request(original, namespace: namespace)
                assertForeground(request, selection: selection, options: sounding ? [.banner, .list, .sound] : [.banner, .list])
                assertForeground(try self.request(original, namespace: namespace + ".other"), selection: selection, options: [])
            }
        }
    }

    func testForegroundPresentationRefusesUnavailableAndRehearsalSelections() throws {
        let container = URL(fileURLWithPath: "/synthetic453", isDirectory: true)
        let rehearsal = NativeLaunchSelection.rehearsal(containerURL: container,
            databaseURL: container.appendingPathComponent("mindwtr.sqlite"), bundleIdentifier: namespace)
        let request = try request()
        assertForeground(request, selection: nil, options: [])
        assertForeground(request, selection: rehearsal, options: [])
    }

    func testForegroundPresentationRequiresExactClosedNativeOwnership() throws {
        let container = URL(fileURLWithPath: "/synthetic453", isDirectory: true)
        let selection = NativeLaunchSelection.standard(databaseURL: container.appendingPathComponent("mindwtr.sqlite"),
            containerURL: container, namespace: namespace)
        let request = try request()
        for identifier in [request.identifier + "0", "mindwtr-native:\(namespace):0450", "foreign"] {
            assertForeground(changing(request, { _ in }, identifier: identifier), selection: selection, options: [])
        }
        for (field, value) in [("version", true as Any), ("version", 2), ("version", "1"), ("id", true),
                               ("id", 451), ("id", "450"), ("namespace", 1), ("namespace", "foreign"), ("extra", 1)] {
            let malformed = changing(request) { content in
                var owner = content.userInfo["mindwtrNativeReminder"] as! [String: Any]
                owner[field] = value; content.userInfo["mindwtrNativeReminder"] = owner
            }
            assertForeground(malformed, selection: selection, options: [])
        }
        for field in ["version", "namespace", "id"] {
            assertForeground(changing(request) { content in
                var owner = content.userInfo["mindwtrNativeReminder"] as! [String: Any]
                owner.removeValue(forKey: field); content.userInfo["mindwtrNativeReminder"] = owner
            }, selection: selection, options: [])
        }
        assertForeground(changing(request) { $0.userInfo.removeValue(forKey: "mindwtrNativeReminder") }, selection: selection, options: [])
        assertForeground(changing(request) { $0.userInfo["mindwtrNativeReminder"] = "invalid" }, selection: selection, options: [])
    }

    func testForegroundPresentationIgnoresResponseSidecarAndCategoryForLegacyOwnedRequests() throws {
        let container = URL(fileURLWithPath: "/synthetic453", isDirectory: true)
        let selection = NativeLaunchSelection.standard(databaseURL: container.appendingPathComponent("mindwtr.sqlite"),
            containerURL: container, namespace: namespace)
        let request = try request()
        for sidecar in [nil, "invalid"] as [Any?] {
            let legacy = changing(request) { content in
                content.userInfo["mindwtrNativeResponse"] = sidecar
                content.categoryIdentifier = "FOREIGN_CATEGORY"
            }
            assertForeground(legacy, selection: selection, options: [.banner, .list, .sound])
            assertForeground(changing(legacy) { $0.sound = nil }, selection: selection, options: [.banner, .list])
        }
    }

    func testOpenCompleteSnoozeAndDismissUseExactSharedPayloadsAndCodableValues() throws {
        for snoozed in [false, true] {
            let request = try request(snoozed: snoozed)
            let open = try XCTUnwrap(capture(request))
            XCTAssertEqual(open.action, .open)
            XCTAssertEqual(open.notificationIdentifier, request.identifier)
            XCTAssertEqual(open.deliveredAtBits, String(format: "%016llx", delivery.timeIntervalSinceReferenceDate.bitPattern))
            XCTAssertEqual(open.requestedAtMs, Int64(floor(received.timeIntervalSince1970 * 1_000)))
            XCTAssertEqual(try JSONDecoder().decode(NativeReminderResponse.self, from: JSONEncoder().encode(open)), open)
            let fields = try payload(open)
            XCTAssertEqual(Set(fields.allKeys.compactMap { $0 as? String }), Set(["notificationId", "actionIdentifier", "kind", "taskId", "projectId", "context"]))
            XCTAssertEqual(fields["notificationId"] as? String, request.identifier)
            XCTAssertEqual(fields["actionIdentifier"] as? String, "open")
            XCTAssertEqual(fields["kind"] as? String, "task-review") // Route precedence remains shared core policy.
            XCTAssertNil(fields["alarmKey"])
            let complete = try XCTUnwrap(capture(request, NativeReminderResponse.completeActionIdentifier))
            XCTAssertEqual(complete.action, .complete)
            XCTAssertEqual(try payload(complete) as? [String: String], ["requestId": complete.requestID, "taskId": "synthetic-450"])
            XCTAssertLessThanOrEqual(complete.payloadJSON.utf8.count, 4_096)
            let snooze = try XCTUnwrap(capture(request, NativeReminderResponse.snoozeActionIdentifier))
            XCTAssertEqual(snooze.action, .snooze)
            let snoozeFields = try payload(snooze)
            XCTAssertEqual(Set(snoozeFields.allKeys.compactMap { $0 as? String }), Set(["requestId", "requestedAt", "details"]))
            XCTAssertEqual(snoozeFields["requestId"] as? String, snooze.requestID)
            XCTAssertEqual((snoozeFields["requestedAt"] as? NSNumber)?.int64Value, snooze.requestedAtMs)
            let original = try XCTUnwrap(snoozeFields["details"] as? NSDictionary)
            XCTAssertTrue(original.isEqual(to: details()))
            XCTAssertEqual(Array(try XCTUnwrap(original["title"] as? String).utf8), Array("\u{FEFF}準備 🧭".utf8))
            XCTAssertLessThanOrEqual(snooze.payloadJSON.utf8.count, 65_536)
            let dismiss = try XCTUnwrap(capture(request, NativeReminderResponse.dismissActionIdentifier))
            XCTAssertEqual(dismiss.action, .dismiss)
            XCTAssertEqual(dismiss.payloadJSON, "{}")
            XCTAssertEqual(capture(request, UNNotificationDismissActionIdentifier), dismiss)
        }
    }

    func testLegacyOpenAndDismissWorkButNeverGrantMutation() throws {
        let legacy = changing(try request()) { $0.userInfo.removeValue(forKey: "mindwtrNativeResponse") }
        XCTAssertNotNil(capture(legacy))
        XCTAssertNotNil(capture(legacy, UNNotificationDismissActionIdentifier))
        XCTAssertNil(capture(legacy, NativeReminderResponse.completeActionIdentifier))
        XCTAssertNil(capture(legacy, NativeReminderResponse.snoozeActionIdentifier))
        XCTAssertEqual(NativeReminderObservation.read(legacy, namespace: namespace).ownedID, 450)
    }

    func testStableIdentitySeparatesDeliveryActionAndPublicationNotReceiptClock() throws {
        let firstRequest = try request()
        let first = try XCTUnwrap(capture(firstRequest, NativeReminderResponse.snoozeActionIdentifier))
        let retry = try XCTUnwrap(capture(firstRequest, NativeReminderResponse.snoozeActionIdentifier,
                                        receivedAt: received.addingTimeInterval(60)))
        XCTAssertEqual(first.requestID, retry.requestID)
        XCTAssertNotEqual(first.requestedAtMs, retry.requestedAtMs)
        // The inbox must retain the first accepted timestamp/payload for this same request ID.
        XCTAssertNotEqual(first.payloadJSON, retry.payloadJSON)
        XCTAssertNotEqual(first.requestID, capture(firstRequest, NativeReminderResponse.snoozeActionIdentifier,
                                                  deliveredAt: delivery.addingTimeInterval(0.000_001))?.requestID)
        XCTAssertNotEqual(first.requestID, capture(firstRequest, NativeReminderResponse.completeActionIdentifier)?.requestID)
        XCTAssertNotEqual(first.requestID, capture(try request(), NativeReminderResponse.snoozeActionIdentifier)?.requestID)
        XCTAssertEqual(first.requestID.count, 36)
        XCTAssertEqual(UUID(uuidString: first.requestID)?.uuidString.lowercased(), first.requestID)
        XCTAssertEqual(Array(first.requestID)[14], "8")
        XCTAssertTrue(["8", "9", "a", "b"].contains(String(Array(first.requestID)[19])))
    }

    func testIdentityUsesFrozenSHA256ArrayFramingAndUUIDV8Bits() throws {
        let fixed = changing(try request()) { content in
            var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
            metadata["publication"] = publication; content.userInfo["mindwtrNativeResponse"] = metadata
        }
        let response = try XCTUnwrap(capture(fixed, NativeReminderResponse.snoozeActionIdentifier,
                                            deliveredAt: Date(timeIntervalSinceReferenceDate: 123.125)))
        XCTAssertEqual(response.deliveredAtBits, "405ec80000000000")
        // Independent Python hashlib SHA256 over the six-string compact JSON array.
        XCTAssertEqual(response.requestID, "1d96c985-1e73-8cdc-83b8-224bd19f40af")
    }

    func testTrustedNamespaceExactOwnershipAndNativeActionAuthority() throws {
        let request = try request()
        for namespace in ["", "foreign", "a:b", "a\n", String(repeating: "a", count: 256)] {
            XCTAssertNil(capture(request, namespace: namespace))
        }
        for action in ["open", "complete", "complete_action", "snooze", "dismiss", "unknown", ""] {
            XCTAssertNil(capture(request, action))
        }
        XCTAssertNil(capture(changing(request, { _ in }, identifier: request.identifier + "0")))
        for (field, value) in [("version", true as Any), ("version", 2), ("id", true), ("id", 451),
                               ("namespace", "foreign"), ("extra", 1)] {
            let malformed = changing(request) { content in
                var metadata = content.userInfo["mindwtrNativeReminder"] as! [String: Any]
                metadata[field] = value; content.userInfo["mindwtrNativeReminder"] = metadata
            }
            XCTAssertNil(capture(malformed), field)
        }
    }

    func testMalformedPresentSidecarRefusesEveryActionWithoutLegacyFallback() throws {
        let request = try request()
        for (field, value) in [("version", true as Any), ("version", 2), ("version", 1.5),
                               ("publication", publication.uppercased()), ("publication", "bad"),
                               ("details", "[]"), ("details", "null"), ("details", "{bad"),
                               ("details", String(repeating: " ", count: 60_001)), ("extra", 1)] {
            let malformed = changing(request) { content in
                var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
                metadata[field] = value; content.userInfo["mindwtrNativeResponse"] = metadata
            }
            for action in [UNNotificationDefaultActionIdentifier, NativeReminderResponse.completeActionIdentifier,
                           NativeReminderResponse.snoozeActionIdentifier, UNNotificationDismissActionIdentifier] {
                XCTAssertNil(capture(malformed, action), field)
            }
        }
        for field in ["version", "publication", "details"] {
            XCTAssertNil(capture(changing(request) { content in
                var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
                metadata.removeValue(forKey: field); content.userInfo["mindwtrNativeResponse"] = metadata
            }))
        }
        XCTAssertNil(capture(changing(request) { $0.userInfo["mindwtrNativeResponse"] = "wrong" }))
    }

    func testNonfiniteNestedSidecarExtraRefusesEveryAction() throws {
        let request = try request()
        let encoded = try JSONSerialization.data(withJSONObject: details())
        let validJSON = String(decoding: encoded, as: UTF8.self)
        let forgedJSON = String(validJSON.dropLast()) + #","extra":{"nested":[1e309]}}"#
        let forged = changing(request) { content in
            var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
            metadata["details"] = forgedJSON; content.userInfo["mindwtrNativeResponse"] = metadata
        }
        for action in [UNNotificationDefaultActionIdentifier, NativeReminderResponse.completeActionIdentifier,
                       NativeReminderResponse.snoozeActionIdentifier, UNNotificationDismissActionIdentifier] {
            XCTAssertNil(capture(forged, action), action)
        }
    }

    func testMalformedDataAndMismatchedSnapshotRefuseWithoutReconstruction() throws {
        let request = try request()
        for value in [[:], ["alarmKey": ""], ["alarmKey": "task:synthetic-450", "taskId": 1] as [String: Any], "invalid"] as [Any] {
            XCTAssertNil(capture(changing(request) { $0.userInfo["data"] = value }))
        }
        for field in ["title", "message", "tag", "play_sound", "data"] {
            var original = details(); original[field] = nil
            let encoded = try JSONSerialization.data(withJSONObject: original)
            XCTAssertNil(capture(changing(request) { content in
                var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
                metadata["details"] = String(decoding: encoded, as: UTF8.self)
                content.userInfo["mindwtrNativeResponse"] = metadata
            }), field)
        }
        for (field, value) in [("title", 1 as Any), ("message", true), ("tag", NSNull()),
                               ("play_sound", 1), ("data", ["alarmKey": "task:synthetic-450", "flag": true])] {
            var original = details(); original[field] = value
            let encoded = try JSONSerialization.data(withJSONObject: original)
            XCTAssertNil(capture(changing(request) { content in
                var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
                metadata["details"] = String(decoding: encoded, as: UTF8.self)
                content.userInfo["mindwtrNativeResponse"] = metadata
            }), field)
        }
        XCTAssertNil(capture(changing(request) { $0.title = "another" }))
        XCTAssertNil(capture(changing(request) { $0.body = "another" }))
        XCTAssertNil(capture(changing(request) { $0.threadIdentifier = "another" }))
        XCTAssertNil(capture(changing(request) { $0.userInfo["data"] = ["alarmKey": "task:synthetic-450", "taskId": "another"] }))
        // Swift String equality canonically normalizes Unicode; snapshot agreement must retain the bytes.
        var original = details(); original["message"] = "é"
        XCTAssertNil(capture(changing(try self.request(original)) { $0.body = "e\u{301}" }))
    }

    func testMutationFlagsIntervalsAndUTF16BoundsAreStrict() throws {
        for flag in [nil, false, 1, "true"] as [Any?] {
            var original = details(); original["has_complete_action"] = flag
            let request = try request(original)
            XCTAssertNotNil(capture(request))
            XCTAssertNil(capture(request, NativeReminderResponse.completeActionIdentifier))
        }
        for taskID in ["", String(repeating: "🧭", count: 251)] {
            var original = details(); var data = original["data"] as! [String: String]; data["taskId"] = taskID; original["data"] = data
            XCTAssertNil(capture(try request(original), NativeReminderResponse.completeActionIdentifier))
        }
        var boundary = details(); var data = boundary["data"] as! [String: String]
        data["taskId"] = String(repeating: "🧭", count: 250); boundary["data"] = data
        XCTAssertNotNil(capture(try request(boundary), NativeReminderResponse.completeActionIdentifier))
        for interval in [nil, true, 0, -1, "10", NSNull()] as [Any?] {
            var original = details(); original["snooze_interval"] = interval
            XCTAssertNil(capture(try request(original), NativeReminderResponse.snoozeActionIdentifier))
        }
        for titleLength in [5_000, 5_001] {
            var original = details(); original["title"] = String(repeating: "🧭", count: titleLength)
            XCTAssertEqual(capture(try request(original), NativeReminderResponse.snoozeActionIdentifier) != nil, titleLength == 5_000)
        }
        var invalidOwner = details(); invalidOwner["data"] = ["alarmKey": "other:owner"]
        let base = try request()
        let originalJSON = String(decoding: try JSONSerialization.data(withJSONObject: invalidOwner), as: UTF8.self)
        let malformedOwner = changing(base) { content in
            content.userInfo["data"] = ["alarmKey": "other:owner"]
            var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
            metadata["details"] = originalJSON; content.userInfo["mindwtrNativeResponse"] = metadata
        }
        XCTAssertNotNil(capture(malformedOwner))
        XCTAssertNil(capture(malformedOwner, NativeReminderResponse.snoozeActionIdentifier))
    }

    func testRejectsInvalidDatesAndFloorsNegativeReceivedMilliseconds() throws {
        let request = try request()
        for instant in [Double.nan, Double.infinity, -Double.infinity, Double.greatestFiniteMagnitude,
                        8_640_000_000_001, -8_640_000_000_001] {
            let date = Date(timeIntervalSince1970: instant)
            XCTAssertNil(capture(request, deliveredAt: date))
            XCTAssertNil(capture(request, receivedAt: date))
        }
        XCTAssertEqual(capture(request, receivedAt: Date(timeIntervalSince1970: -0.123_4))?.requestedAtMs, -124)
    }

    func testOriginalFoundationUnicodeKeysAndNestedExtrasSurviveFullSnoozePayload() throws {
        let original = NSMutableDictionary(dictionary: details())
        original.setObject("composed", forKey: "é" as NSString)
        original.setObject("decomposed", forKey: "e\u{301}" as NSString)
        XCTAssertEqual(original.count, details().count + 2)
        let request = try request(original)
        let metadata = try XCTUnwrap(request.content.userInfo["mindwtrNativeResponse"] as? [String: Any])
        let stored = try XCTUnwrap(NativeJSON.jsonObject(with: Data(try XCTUnwrap(metadata["details"] as? String).utf8)) as? NSDictionary)
        XCTAssertEqual(stored.count, original.count)
        let response = try XCTUnwrap(capture(request, NativeReminderResponse.snoozeActionIdentifier))
        let copied = try XCTUnwrap(try payload(response)["details"] as? NSDictionary)
        XCTAssertEqual(copied.count, original.count)
        XCTAssertEqual(copied.object(forKey: "é" as NSString) as? String, "composed")
        XCTAssertEqual(copied.object(forKey: "e\u{301}" as NSString) as? String, "decomposed")
        XCTAssertTrue(copied.isEqual(original))
    }

    func testOversizedAndNonJSONDetailsKeepSchedulingButDoNotGrantMutations() throws {
        for extra in [String(repeating: "x", count: 60_001), Date(), Double.nan, Double.infinity] as [Any] {
            var original = details(); original["extra"] = extra
            let request = try request(original)
            XCTAssertNil(request.content.userInfo["mindwtrNativeResponse"])
            XCTAssertNotNil(capture(request))
            XCTAssertNil(capture(request, NativeReminderResponse.completeActionIdentifier))
            XCTAssertNil(capture(request, NativeReminderResponse.snoozeActionIdentifier))
        }
        var original = details(); original["extra"] = String(repeating: "/", count: 59_000)
        let json = String(decoding: try JSONSerialization.data(withJSONObject: original, options: [.withoutEscapingSlashes]), as: UTF8.self)
        XCTAssertLessThanOrEqual(json.utf8.count, 60_000)
        let oversized = changing(try request()) { content in
            var metadata = content.userInfo["mindwtrNativeResponse"] as! [String: Any]
            metadata["details"] = json; content.userInfo["mindwtrNativeResponse"] = metadata
        }
        XCTAssertNil(capture(oversized, NativeReminderResponse.snoozeActionIdentifier))
        var largeOpen = details(); var data = largeOpen["data"] as! [String: String]
        data["context"] = String(repeating: "x", count: 65_536); largeOpen["data"] = data
        XCTAssertNil(capture(try request(largeOpen)))
    }
}
