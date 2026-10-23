import CryptoKit
import Foundation
import UserNotifications
import XCTest
@testable import MindwtrNativeCore

/// These tests create request values only; they never obtain a notification center.
final class NativePomodoroRequestTests: XCTestCase {
    private let namespace = "tech.dongdongbh.mindwtr.native-ui.585_01"
    private let libraryID = "/Users/dd/Library/Application Support/Mindwtr/library::585"
    private let sessionID = "12345678-1234-1234-1234-123456789abc"
    private let fireAtMs: Int64 = 1_900_000_000_123

    private func intent() -> [String: Any] {
        ["kind": "schedule", "sessionID": sessionID, "phase": "focus", "fireAtMs": fireAtMs,
         "observedAtMs": fireAtMs - 60_000, "immediate": false,
         "details": ["title": "\u{FEFF}準備 🧭", "message": "Line one\n第二行 e\u{301}", "play_sound": true,
                     "has_button": false, "has_complete_action": false,
                     "data": ["kind": "pomodoro", "phase": "focus-complete"]] as [String: Any]]
    }

    private func details(_ input: [String: Any], changing field: String, to value: Any?) -> [String: Any] {
        var output = input, details = input["details"] as! [String: Any]
        details[field] = value; output["details"] = details
        return output
    }

    private func make(_ input: [String: Any]? = nil, namespace: String? = nil, libraryID: String? = nil) throws -> UNNotificationRequest {
        try NativePomodoroRequest.make(intent: input ?? intent(), namespace: namespace ?? self.namespace,
                                       libraryID: libraryID ?? self.libraryID)
    }

    private func owned(_ request: UNNotificationRequest, metadata: Any? = nil) -> NativePomodoroRequest.Identity? {
        NativePomodoroRequest.ownedIdentity(identifier: request.identifier,
            metadata: metadata ?? request.content.userInfo["mindwtrNativePomodoro"], namespace: namespace, libraryID: libraryID)
    }

    private func assertInvalid(_ input: [String: Any], namespace: String? = nil, libraryID: String? = nil,
                               message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try make(input, namespace: namespace, libraryID: libraryID), message, file: file, line: line) { error in
            guard let failure = error as? HostFailure else { return XCTFail("Expected the fixed host failure", file: file, line: line) }
            XCTAssertEqual(failure.message, "Native Pomodoro schedule intent is invalid", file: file, line: line)
        }
    }

    func testStableIdentityIgnoresPresentationObservationAndGeneration() throws {
        let first = try make(), retry = try make()
        XCTAssertEqual(first.identifier, retry.identifier)
        XCTAssertTrue(first.identifier.hasPrefix("mindwtr-native-pomodoro:"))
        XCTAssertEqual(first.identifier.utf8.count, "mindwtr-native-pomodoro:".utf8.count + 64)
        var changed = details(intent(), changing: "title", to: "Other title")
        changed = details(changed, changing: "message", to: "Other body")
        changed = details(changed, changing: "play_sound", to: false)
        changed["generation"] = 999; changed["observedAtMs"] = fireAtMs + 60_000; changed["immediate"] = true
        XCTAssertEqual(try make(changed).identifier, first.identifier)
        XCTAssertEqual(owned(first), owned(try make(changed)))
    }

    func testIdentityIsolatesNamespaceExactLibraryBytesSessionPhaseAndDeadline() throws {
        let original = try make().identifier
        var session = intent(); session["sessionID"] = "12345678-1234-1234-1234-123456789abd"
        var deadline = intent(); deadline["fireAtMs"] = fireAtMs + 1
        var phase = details(intent(), changing: "data", to: ["kind": "pomodoro", "phase": "break-complete"])
        phase["phase"] = "break"
        let identifiers = try [original, make(namespace: namespace + ".other").identifier,
                               make(libraryID: libraryID + "/other").identifier, make(session).identifier,
                               make(deadline).identifier, make(phase).identifier]
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
        XCTAssertNotEqual(try make(libraryID: "café").identifier, try make(libraryID: "cafe\u{301}").identifier)
        XCTAssertNotEqual(try make(libraryID: "opaque").identifier, try make(libraryID: "opaque ").identifier)
    }

    func testClosedMetadataContainsOnlyHashedLibraryIdentity() throws {
        let request = try make(), metadata = try XCTUnwrap(request.content.userInfo["mindwtrNativePomodoro"] as? [String: Any])
        let digest = SHA256.hash(data: Data(libraryID.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(Set(metadata.keys), Set(["version", "namespace", "libraryDigest", "sessionID", "phase", "fireAtMs"]))
        XCTAssertEqual(metadata["version"] as? Int, 1)
        XCTAssertEqual(metadata["namespace"] as? String, namespace)
        XCTAssertEqual(metadata["libraryDigest"] as? String, digest)
        XCTAssertEqual(metadata["sessionID"] as? String, sessionID)
        XCTAssertEqual(metadata["phase"] as? String, "focus")
        XCTAssertEqual(metadata["fireAtMs"] as? Int64, fireAtMs)
        XCTAssertEqual(owned(request), NativePomodoroRequest.Identity(namespace: namespace, libraryDigest: digest,
                        sessionID: sessionID, phase: "focus", fireAtMs: fireAtMs))
        let bytes = try JSONSerialization.data(withJSONObject: request.content.userInfo)
        XCTAssertFalse(try XCTUnwrap(String(data: bytes, encoding: .utf8)).contains(libraryID))
        let framed: [Any] = [1, namespace, digest, sessionID, "focus", fireAtMs]
        let identifierDigest = SHA256.hash(data: try JSONSerialization.data(withJSONObject: framed)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(request.identifier, "mindwtr-native-pomodoro:" + identifierDigest)
    }

    func testNamespaceObservationRecognizesRetiredLibraryWithoutGrantingCurrentLibraryOwnership() throws {
        let request = try make(libraryID: libraryID + "/retired")
        let metadata = request.content.userInfo["mindwtrNativePomodoro"]
        let observed = try XCTUnwrap(NativePomodoroRequest.ownedIdentity(identifier: request.identifier,
            metadata: metadata, namespace: namespace))
        XCTAssertNil(owned(request))
        XCTAssertEqual(observed.scope, NativePomodoroRequest.scope(namespace: namespace, libraryID: libraryID + "/retired"))
        XCTAssertNotEqual(observed.scope, NativePomodoroRequest.scope(namespace: namespace, libraryID: libraryID))
        XCTAssertNotEqual(NativePomodoroRequest.scope(namespace: namespace, libraryID: "café"),
                          NativePomodoroRequest.scope(namespace: namespace, libraryID: "cafe\u{301}"))
        XCTAssertNil(NativePomodoroRequest.scope(namespace: "bad:namespace", libraryID: libraryID))
        XCTAssertNil(NativePomodoroRequest.scope(namespace: namespace, libraryID: ""))
        for digest in [String(repeating: "a", count: 63), String(repeating: "A", count: 64), "0" + String(repeating: "a", count: 63) + "\n"] {
            var invalid = try XCTUnwrap(metadata as? [String: Any]); invalid["libraryDigest"] = digest
            XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: invalid, namespace: namespace))
        }
    }

    func testOwnershipRequiresEveryExactMetadataFieldAndWholeIdentifier() throws {
        let request = try make(), metadata = try XCTUnwrap(request.content.userInfo["mindwtrNativePomodoro"] as? [String: Any])
        for field in metadata.keys { var missing = metadata; missing[field] = nil; XCTAssertNil(owned(request, metadata: missing), field) }
        let mutations: [(String, Any)] = [("version", true), ("version", "1"), ("version", 1.5), ("version", 2),
            ("namespace", namespace + ".other"), ("libraryDigest", String(repeating: "0", count: 64)),
            ("sessionID", sessionID.uppercased()), ("sessionID", "12345678-1234-1234-1234-123456789abd"),
            ("phase", "break"), ("phase", "focus-complete"), ("fireAtMs", true), ("fireAtMs", fireAtMs + 1),
            ("fireAtMs", 1.5), ("fireAtMs", NSDecimalNumber(string: "1900000000123.00001")),
            ("fireAtMs", Double.nan), ("fireAtMs", 8_640_000_000_000_001 as Int64), ("extra", 1)]
        for (field, value) in mutations { var changed = metadata; changed[field] = value; XCTAssertNil(owned(request, metadata: changed), field) }
        for value in [NSNull(), "metadata", ["version": 1] as [String: Any]] as [Any] { XCTAssertNil(owned(request, metadata: value)) }
        for identifier in [request.identifier + "0", "mindwtr-native-pomodoro:", "mindwtr-native:\(namespace):585"] {
            XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: identifier, metadata: metadata, namespace: namespace, libraryID: libraryID))
        }
        XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: nil, namespace: namespace, libraryID: libraryID))
        XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: metadata, namespace: namespace + ".other", libraryID: libraryID))
        XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: metadata, namespace: namespace, libraryID: libraryID + "other"))
        XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: metadata, namespace: "bad:namespace", libraryID: libraryID))
        XCTAssertNil(NativePomodoroRequest.ownedIdentity(identifier: request.identifier, metadata: metadata, namespace: namespace, libraryID: ""))
    }

    func testOnlyAllowedUnicodeContentAndSoundEscapeWithNoTaskActions() throws {
        var input = intent(), extra = input["details"] as! [String: Any]
        extra["categoryIdentifier"] = "MINDWTR_NATIVE_RESPONSE_3"; extra["snooze_interval"] = 10
        extra["mindwtrNativeResponse"] = ["version": 1]; extra["mindwtrNativeReminder"] = ["id": 585]
        extra["userInfo"] = ["taskId": "private-task"]; extra["sound"] = "private-file"
        extra["tag"] = "private-task-thread"; extra["extra"] = Date(); input["details"] = extra
        input["mindwtrNativePomodoro"] = ["libraryID": libraryID]
        let request = try make(input)
        XCTAssertEqual(Array(request.content.title.utf8), Array((extra["title"] as! String).utf8))
        XCTAssertEqual(Array(request.content.body.utf8), Array((extra["message"] as! String).utf8))
        XCTAssertEqual(request.content.sound, UNNotificationSound.default)
        XCTAssertNil(try make(details(input, changing: "play_sound", to: false)).content.sound)
        XCTAssertEqual(request.content.categoryIdentifier, ""); XCTAssertEqual(request.content.threadIdentifier, "")
        XCTAssertTrue(request.content.attachments.isEmpty)
        XCTAssertEqual(Set(request.content.userInfo.keys.compactMap { $0 as? String }), Set(["data", "mindwtrNativePomodoro"]))
        XCTAssertEqual(request.content.userInfo["data"] as? [String: String], ["kind": "pomodoro", "phase": "focus-complete"])
        XCTAssertNil(NativeReminderRequest.ownedID(identifier: request.identifier,
            metadata: request.content.userInfo["mindwtrNativePomodoro"], namespace: namespace))
        XCTAssertNil(NativeReminderRequest.ownedID(identifier: request.identifier,
            metadata: ["version": 1, "namespace": namespace, "id": 585], namespace: namespace))
        for action in [NativeReminderResponse.completeActionIdentifier, NativeReminderResponse.snoozeActionIdentifier,
                       NativeReminderResponse.dismissActionIdentifier, UNNotificationDefaultActionIdentifier] {
            XCTAssertNil(NativeReminderResponse.capture(request, deliveredAt: Date(timeIntervalSince1970: 1_900_000_000),
                receivedAt: Date(timeIntervalSince1970: 1_900_000_001), actionIdentifier: action, namespace: namespace))
        }
    }

    func testImmediateAndAbsoluteTriggerFollowCoreDecisionWithoutRetiming() throws {
        var input = intent(); input["immediate"] = true
        XCTAssertNil(try make(input).trigger)
        input["immediate"] = false; input["observedAtMs"] = fireAtMs + 60_000
        let trigger = try XCTUnwrap(try make(input).trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        let components = trigger.dateComponents, calendar = try XCTUnwrap(components.calendar)
        XCTAssertEqual(calendar.identifier, .gregorian); XCTAssertEqual(components.timeZone?.secondsFromGMT(), 0)
        XCTAssertEqual(calendar.timeZone.secondsFromGMT(), 0)
        XCTAssertNotNil(components.era); XCTAssertNotNil(components.year); XCTAssertNotNil(components.month); XCTAssertNotNil(components.day)
        XCTAssertNotNil(components.hour); XCTAssertNotNil(components.minute); XCTAssertNotNil(components.second); XCTAssertNotNil(components.nanosecond)
        XCTAssertEqual(try XCTUnwrap(calendar.date(from: components)), Date(timeIntervalSince1970: Double(fireAtMs) / 1_000))
        XCTAssertEqual(try XCTUnwrap(calendar.date(from: components)).timeIntervalSince1970 * 1_000, Double(fireAtMs), accuracy: 0.001)
    }

    func testJSONDecodedIntentAndMetadataKeepBooleanAndIntegerTypesDistinct() throws {
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: intent())) as? [String: Any])
        let request = try make(decoded)
        XCTAssertEqual(request.identifier, try make().identifier)
        var decimalTimes = intent(); decimalTimes["fireAtMs"] = NSDecimalNumber(string: "1900000000123")
        decimalTimes["observedAtMs"] = NSDecimalNumber(string: "1899999940123")
        XCTAssertEqual(try make(decimalTimes).identifier, request.identifier)
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: request.content.userInfo["mindwtrNativePomodoro"]!)) as? [String: Any])
        XCTAssertEqual(owned(request, metadata: metadata), owned(request))
        var numericImmediate = decoded; numericImmediate["immediate"] = 1; assertInvalid(numericImmediate)
        assertInvalid(details(decoded, changing: "play_sound", to: 1))
        var booleanDeadline = decoded; booleanDeadline["fireAtMs"] = true; assertInvalid(booleanDeadline)
    }

    func testNamespacesLibrariesAndCanonicalSessionUUIDAreBoundedAndStrict() throws {
        for value in ["", String(repeating: "a", count: 256), "a:b", "a/b", "a b", "a\n", "é", "a\u{0}"] { assertInvalid(intent(), namespace: value) }
        XCTAssertNoThrow(try make(namespace: String(repeating: "a", count: 255)))
        for value in ["", String(repeating: "a", count: 1_025), String(repeating: "🧭", count: 257)] { assertInvalid(intent(), libraryID: value) }
        XCTAssertNoThrow(try make(libraryID: String(repeating: "🧭", count: 256)))
        for value in ["", "not-a-uuid", sessionID.uppercased(), sessionID + "\n", " " + sessionID, "12345678123412341234123456789abc"] {
            var invalid = intent(); invalid["sessionID"] = value; assertInvalid(invalid)
        }
    }

    func testScheduleRequiredShapeTypesAndExactPomodoroDataRejectMalformedValues() {
        for field in ["kind", "sessionID", "phase", "fireAtMs", "observedAtMs", "immediate", "details"] {
            var missing = intent(); missing[field] = nil; assertInvalid(missing)
            missing[field] = NSNull(); assertInvalid(missing)
        }
        for (field, values) in [("kind", ["cancel", "uninitialized", 1, true] as [Any]),
                                ("sessionID", [1, true] as [Any]), ("phase", ["Focus", "focus-complete", "", 1, true] as [Any]),
                                ("details", ["private-payload", 1, true, [:] as [String: Any]] as [Any])] {
            for value in values { var invalid = intent(); invalid[field] = value; assertInvalid(invalid) }
        }
        for field in ["title", "message", "play_sound", "has_button", "has_complete_action", "data"] {
            assertInvalid(details(intent(), changing: field, to: nil)); assertInvalid(details(intent(), changing: field, to: NSNull()))
        }
        for field in ["title", "message"] { for value in [1, true] as [Any] { assertInvalid(details(intent(), changing: field, to: value)) } }
        for value in ["payload", [:] as [String: String], ["kind": "task", "phase": "focus-complete"],
                      ["kind": "pomodoro", "phase": "break-complete"], ["kind": "pomodoro", "phase": "focus-complete", "taskId": "private"],
                      ["kind": "pomodoro", "phase": true] as [String: Any]] as [Any] {
            assertInvalid(details(intent(), changing: "data", to: value))
        }
    }

    func testStrictBooleanFlagsRejectNumericStringsAndActionRequests() {
        for value in [0, 1, "true", "false", NSNull()] as [Any] {
            var invalid = intent(); invalid["immediate"] = value; assertInvalid(invalid)
            for field in ["play_sound", "has_button", "has_complete_action"] { assertInvalid(details(intent(), changing: field, to: value)) }
        }
        for field in ["has_button", "has_complete_action"] { assertInvalid(details(intent(), changing: field, to: true)) }
    }

    func testTimesRejectBooleanFractionalNonfiniteAndOutOfDateRangeEvenWhenImmediate() {
        for field in ["fireAtMs", "observedAtMs"] {
            for value in [true, false, Double.nan, Double.infinity, -Double.infinity, Double.greatestFiniteMagnitude,
                          8_640_000_000_000_001 as Int64, -8_640_000_000_000_001 as Int64, 1_900_000_000_123.5,
                          NSDecimalNumber(string: "1900000000123.00001"), "1900000000123", NSNull()] as [Any] {
                var invalid = intent(); invalid[field] = value
                assertInvalid(invalid, message: "\(field) = \(value), scheduled")
                invalid["immediate"] = true
                assertInvalid(invalid, message: "\(field) = \(value), immediate")
            }
        }
    }
}
