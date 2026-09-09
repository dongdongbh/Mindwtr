import Foundation
import XCTest
@testable import MindwtrWatchPayloadValidation

final class MindwtrWatchPayloadValidatorTests: XCTestCase {
    private let id = "9D8A4448-255F-4C49-A40B-1855FA86BE2D"

    func testNormalizesTextCaptureAndCanonicalizesUUID() throws {
        let validated = try MindwtrWatchPayloadValidator.validateTransport([
            "protocolVersion": 1,
            "id": id,
            "createdAt": "2026-09-06T15:04:05.123Z",
            "source": "apple-watch",
            "kind": "text",
            "title": "  Call Sam  ",
        ])

        XCTAssertEqual(validated.id, id.lowercased())
        XCTAssertEqual(validated.kind, .text)
        XCTAssertEqual(validated.queuePayload["title"] as? String, "Call Sam")
        XCTAssertEqual(validated.queuePayload["protocolVersion"] as? Int, 1)
    }

    func testAcceptsNumericNSNumberProtocolVersionAndRejectsBoolean() {
        var payload = basePayload(kind: "audio")
        payload["protocolVersion"] = NSNumber(value: 1)
        XCTAssertNoThrow(try MindwtrWatchPayloadValidator.validateTransport(payload))

        payload["protocolVersion"] = NSNumber(value: true)
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))

        payload["protocolVersion"] = true
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))
    }

    func testAcceptsOnlyStrictTrueOutboxRetryMarkersOnCaptures() throws {
        for kind in ["text", "audio"] {
            var payload = basePayload(kind: kind)
            if kind == "text" { payload["title"] = "Retry" }
            payload["outboxRetried"] = true

            let validated = try MindwtrWatchPayloadValidator.validateTransport(payload)
            XCTAssertEqual(validated.queuePayload["outboxRetried"] as? Bool, true)

            let invalidMarkers: [Any] = [NSNumber(value: 1), "true", false]
            for invalidMarker in invalidMarkers {
                payload["outboxRetried"] = invalidMarker
                XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))
            }
        }

        var command = basePayload(kind: "complete")
        command["taskId"] = "task-1"
        command["outboxRetried"] = true
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(command))
    }

    func testRejectsUnknownFieldsAndProtocolKinds() {
        var payload = basePayload(kind: "text")
        payload["title"] = "Capture"
        payload["unexpected"] = "ignored only by unsafe implementations"
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))

        payload = basePayload(kind: "delete")
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))
    }

    func testRejectsInvalidAndOutOfRangeDates() {
        var payload = basePayload(kind: "defer")
        payload["taskId"] = "task-1"
        payload["startDate"] = "2026-02-29"
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))

        payload["startDate"] = "2028-02-29"
        XCTAssertNoThrow(try MindwtrWatchPayloadValidator.validateTransport(payload))

        payload["createdAt"] = "1999-12-31T23:59:59Z"
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(payload))
    }

    func testValidatesEveryCommandKind() throws {
        var complete = basePayload(kind: "complete")
        complete["taskId"] = "task-1"
        XCTAssertEqual(
            try MindwtrWatchPayloadValidator.validateTransport(complete).kind,
            .complete
        )

        var pomodoro = basePayload(kind: "pomodoro")
        pomodoro["action"] = "pause"
        XCTAssertEqual(
            try MindwtrWatchPayloadValidator.validateTransport(pomodoro).kind,
            .pomodoro
        )

        pomodoro["action"] = "finish"
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.validateTransport(pomodoro))
    }

    func testValidatesEveryTransportKindAfterJSONAndPropertyListRoundTrips() throws {
        for (kind, payload) in transportPayloads() {
            let jsonPayload = try jsonRoundTrip(payload)
            XCTAssertEqual(
                try MindwtrWatchPayloadValidator.validateTransport(jsonPayload).kind,
                kind
            )

            let propertyListPayload = try propertyListRoundTrip(payload)
            XCTAssertEqual(
                try MindwtrWatchPayloadValidator.validateTransport(propertyListPayload).kind,
                kind
            )
        }
    }

    func testApplicationContextStripsNullsAndKeepsPropertyListShape() throws {
        let normalized = try MindwtrWatchPayloadValidator.normalizeApplicationContext([
            "protocolVersion": 1,
            "generatedAt": "2026-09-06T15:04:05Z",
            "focus": [["id": "task-1", "title": "One"]],
            "pomodoro": [
                "phase": "focus",
                "isRunning": false,
                "remainingSeconds": 1_500,
                "completionAlert": true,
                "phaseEndTime": NSNull(),
                "taskId": NSNull(),
                "taskTitle": NSNull(),
            ],
        ])

        let pomodoro = try XCTUnwrap(normalized["pomodoro"] as? [String: Any])
        XCTAssertNil(pomodoro["phaseEndTime"])
        XCTAssertNil(pomodoro["taskId"])
        XCTAssertEqual(pomodoro["completionAlert"] as? Bool, true)
        XCTAssertTrue(PropertyListSerialization.propertyList(normalized, isValidFor: .binary))
    }

    func testApplicationContextEnforcesFocusAndTitleBounds() {
        let focus = (0...MindwtrWatchPayloadValidator.maxFocusTasks).map {
            ["id": "task-\($0)", "title": "Task \($0)"]
        }
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.normalizeApplicationContext([
            "protocolVersion": 1,
            "generatedAt": "2026-09-06T15:04:05Z",
            "focus": focus,
            "pomodoro": [
                "phase": "break",
                "isRunning": true,
                "remainingSeconds": 300,
            ],
        ]))
    }

    func testNormalizesApplicationContextAfterJSONAndPropertyListRoundTrips() throws {
        for context in [
            try jsonRoundTrip(applicationContext(remainingSeconds: 1)),
            try propertyListRoundTrip(applicationContext(remainingSeconds: 1)),
        ] {
            let normalized = try MindwtrWatchPayloadValidator.normalizeApplicationContext(context)
            let pomodoro = try XCTUnwrap(normalized["pomodoro"] as? [String: Any])
            XCTAssertEqual(pomodoro["remainingSeconds"] as? Int, 1)
            XCTAssertEqual(pomodoro["isRunning"] as? Bool, false)
            XCTAssertEqual(pomodoro["completionAlert"] as? Bool, true)
        }
    }

    func testApplicationContextAcceptsZeroAndOneAsNativeAndNSNumberIntegers() throws {
        let values: [(Any, Int)] = [
            (0, 0),
            (1, 1),
            (NSNumber(value: 0), 0),
            (NSNumber(value: 1), 1),
        ]
        for (value, expected) in values {
            let normalized = try MindwtrWatchPayloadValidator.normalizeApplicationContext(
                applicationContext(remainingSeconds: value)
            )
            let pomodoro = try XCTUnwrap(normalized["pomodoro"] as? [String: Any])
            XCTAssertEqual(pomodoro["remainingSeconds"] as? Int, expected)
        }
    }

    func testRejectsBooleansInNumericApplicationContextFields() throws {
        for value: Any in [false, true, NSNumber(value: false), NSNumber(value: true)] {
            XCTAssertThrowsError(try MindwtrWatchPayloadValidator.normalizeApplicationContext(
                applicationContext(remainingSeconds: value)
            ))
        }

        var context = applicationContext(remainingSeconds: 1)
        var pomodoro = try XCTUnwrap(context["pomodoro"] as? [String: Any])
        pomodoro["phaseEndTime"] = NSNumber(value: true)
        context["pomodoro"] = pomodoro
        XCTAssertThrowsError(try MindwtrWatchPayloadValidator.normalizeApplicationContext(context))
    }

    func testPhaseEndTimeAcceptsNumericNSNumber() throws {
        var context = applicationContext(remainingSeconds: 1)
        var pomodoro = try XCTUnwrap(context["pomodoro"] as? [String: Any])
        pomodoro["phaseEndTime"] = NSNumber(value: Int64(1_800_000_000_000))
        context["pomodoro"] = pomodoro

        XCTAssertNoThrow(try MindwtrWatchPayloadValidator.normalizeApplicationContext(context))
    }

    func testRejectsNonexactAndOutOfRangeIntegerNumbersWithoutTrapping() {
        let invalidValues: [Any] = [
            NSNumber(value: 9_223_372_036_854_775_808.0),
            NSNumber(value: Double.infinity),
            NSNumber(value: Double.nan),
            NSNumber(value: 1.5),
            NSNumber(value: -1),
            NSNumber(value: 86_401),
        ]
        for value in invalidValues {
            XCTAssertThrowsError(try MindwtrWatchPayloadValidator.normalizeApplicationContext(
                applicationContext(remainingSeconds: value)
            ))
        }
    }

    private func basePayload(kind: String) -> [String: Any] {
        [
            "protocolVersion": 1,
            "id": id,
            "createdAt": "2026-09-06T15:04:05Z",
            "source": "apple-watch",
            "kind": kind,
        ]
    }

    private func transportPayloads() -> [(MindwtrWatchPayloadKind, [String: Any])] {
        var text = basePayload(kind: "text")
        text["title"] = "Capture"
        let audio = basePayload(kind: "audio")
        var complete = basePayload(kind: "complete")
        complete["taskId"] = "task-1"
        var deferTask = basePayload(kind: "defer")
        deferTask["taskId"] = "task-1"
        deferTask["startDate"] = "2026-09-07"
        var pomodoro = basePayload(kind: "pomodoro")
        pomodoro["action"] = "start"
        pomodoro["taskId"] = "task-1"
        return [
            (.text, text),
            (.audio, audio),
            (.complete, complete),
            (.deferTask, deferTask),
            (.pomodoro, pomodoro),
        ]
    }

    private func applicationContext(remainingSeconds: Any) -> [String: Any] {
        [
            "protocolVersion": NSNumber(value: 1),
            "generatedAt": "2026-09-06T15:04:05Z",
            "focus": [["id": "task-1", "title": "One"]],
            "pomodoro": [
                "phase": "focus",
                "isRunning": false,
                "remainingSeconds": remainingSeconds,
                "completionAlert": true,
            ],
        ]
    }

    private func jsonRoundTrip(_ payload: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func propertyListRoundTrip(_ payload: [String: Any]) throws -> [String: Any] {
        let data = try PropertyListSerialization.data(
            fromPropertyList: payload,
            format: .binary,
            options: 0
        )
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any]
        )
    }
}
