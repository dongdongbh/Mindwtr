import Foundation
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

final class NativeContextAutomationNotificationTests: XCTestCase {
    private let namespace = "tech.dongdongbh.mindwtr.native.dev"
    private let delivery = Date(timeIntervalSince1970: 1_900_000_000.123)
    private let received = Date(timeIntervalSince1970: 1_900_000_010.987)

    private func request() throws -> UNNotificationRequest {
        try XCTUnwrap(NativeContextAutomationNotification.request(title: "2 @home next actions",
            message: "Call one\nCall two", context: "@home", namespace: namespace))
    }

    func testRequestIsAnOwnedImmediateNotificationOutsideTheReminderIDRanges() throws {
        let value = try request()
        XCTAssertNil(value.trigger)
        XCTAssertEqual(value.content.title, "2 @home next actions")
        XCTAssertEqual(value.content.body, "Call one\nCall two")
        XCTAssertFalse(value.content.threadIdentifier.hasPrefix("mindwtr-reminder:"))
        XCTAssertEqual(value.content.categoryIdentifier, "")
        let owned = NativeReminderRequest.ownedID(identifier: value.identifier,
            metadata: value.content.userInfo["mindwtrNativeReminder"], namespace: namespace)
        XCTAssertEqual(owned, 2_147_483_647)
        XCTAssertGreaterThan(try XCTUnwrap(owned), 1_073_741_824 + 1_073_741_822)
        XCTAssertNil(NativeReminderRequest.ownedID(identifier: value.identifier,
            metadata: value.content.userInfo["mindwtrNativeReminder"], namespace: namespace + ".other"))
    }

    func testTapCapturesTheContextsOpenPayloadAndOffersNoTaskActions() throws {
        let value = try request()
        let open = try XCTUnwrap(NativeReminderResponse.capture(value, deliveredAt: delivery, receivedAt: received,
            actionIdentifier: UNNotificationDefaultActionIdentifier, namespace: namespace))
        let payload = try XCTUnwrap(NativeJSON.jsonObject(with: Data(open.payloadJSON.utf8)) as? [String: String])
        XCTAssertEqual(payload, ["notificationId": value.identifier, "actionIdentifier": "open",
                                 "kind": "context-automation", "context": "@home"])
        for action in [NativeReminderResponse.completeActionIdentifier, NativeReminderResponse.snoozeActionIdentifier] {
            XCTAssertNil(NativeReminderResponse.capture(value, deliveredAt: delivery, receivedAt: received,
                actionIdentifier: action, namespace: namespace))
        }
    }

    func testRequestRefusesInvalidNamespaceAndEmptyOrOversizedFields() {
        XCTAssertNil(NativeContextAutomationNotification.request(title: "Title", message: "", context: "@home", namespace: ""))
        XCTAssertNil(NativeContextAutomationNotification.request(title: "Title", message: "", context: "@home", namespace: "bad namespace"))
        XCTAssertNil(NativeContextAutomationNotification.request(title: "", message: "", context: "@home", namespace: namespace))
        XCTAssertNil(NativeContextAutomationNotification.request(title: "Title", message: "", context: "", namespace: namespace))
        XCTAssertNil(NativeContextAutomationNotification.request(title: "Title", message: "",
            context: "@" + String(repeating: "x", count: 500), namespace: namespace))
    }
}
