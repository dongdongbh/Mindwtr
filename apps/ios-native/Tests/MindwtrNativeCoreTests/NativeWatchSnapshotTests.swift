import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWatchSnapshotTests: XCTestCase {
    private func context() -> [String: Any] {
        ["protocolVersion": 1, "generatedAt": "2026-10-30T12:00:00.000Z",
         "focus": [["id": "watch-task", "title": "Synthetic 牛奶 🥛", "description": "Synthetic note",
                    "checklist": [["id": "milk", "title": "Milk", "isCompleted": true]]]],
         "pomodoro": ["phase": "focus", "isRunning": false, "remainingSeconds": 1500,
                      "completionAlert": true, "phaseEndTime": NSNull()]]
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private func snapshot(_ value: Any) throws -> NativeWatchSnapshot { try NativeWatchSnapshot(json: json(value)) }

    func testApplicationContextRoundtripStripsNullsAndReturnsIndependentValues() throws {
        let value = try snapshot(context())
        var first = try value.applicationContext()
        var tasks = try XCTUnwrap(first["focus"] as? [[String: Any]])
        tasks[0]["title"] = "Changed by caller"
        tasks[0]["checklist"] = []
        first["focus"] = tasks
        first["pomodoro"] = [:]
        let fresh = try value.applicationContext()
        let original = try XCTUnwrap(fresh["focus"] as? [[String: Any]])
        XCTAssertEqual(original.first?["title"] as? String, "Synthetic 牛奶 🥛")
        XCTAssertEqual((original.first?["checklist"] as? [[String: Any]])?.count, 1)
        let timer = try XCTUnwrap(fresh["pomodoro"] as? [String: Any])
        XCTAssertEqual(timer["completionAlert"] as? Bool, true)
        XCTAssertNil(timer["phaseEndTime"])
        XCTAssertTrue(PropertyListSerialization.propertyList(fresh, isValidFor: .binary))
        XCTAssertEqual(Set(fresh.keys), ["protocolVersion", "generatedAt", "focus", "pomodoro"])
    }

    func testMalformedContextsAndNumericBooleanStandInsRefuse() throws {
        for raw in ["", "null", "[]", "{", #"{"focus":"unterminated\"}"#] {
            XCTAssertThrowsError(try NativeWatchSnapshot(json: raw))
        }
        var invalid = context(); invalid["unexpected"] = true
        XCTAssertThrowsError(try snapshot(invalid))
        invalid = context(); invalid["protocolVersion"] = true
        XCTAssertThrowsError(try snapshot(invalid))
        invalid = context(); invalid["generatedAt"] = "not a date"
        XCTAssertThrowsError(try snapshot(invalid))
        invalid = context(); invalid["focus"] = (0..<21).map { ["id": "task-\($0)", "title": "Synthetic"] }
        XCTAssertThrowsError(try snapshot(invalid))
        for field in ["isRunning", "completionAlert"] {
            for number in [0, 1] {
                invalid = context()
                var timer = try XCTUnwrap(invalid["pomodoro"] as? [String: Any])
                timer[field] = NSNumber(value: number); invalid["pomodoro"] = timer
                XCTAssertThrowsError(try snapshot(invalid), field)
            }
        }
    }

    func testDuplicateNamesTransportSizeAndNestingRefuse() throws {
        let valid = try json(context())
        let duplicate = #"{"protocolVersion":1,"protocolVersion":1,"generatedAt":"2026-10-30T12:00:00Z","focus":[],"pomodoro":{"phase":"focus","isRunning":false,"remainingSeconds":1500}}"#
        let escapedDuplicate = #"{"protocolVersion":1,"generatedAt":"2026-10-30T12:00:00Z","focus":[],"pomodoro":{"phase":"focus","isRunning":false,"isR\u0075nning":false,"remainingSeconds":1500}}"#
        for raw in [duplicate, escapedDuplicate, valid + String(repeating: " ", count: 512 * 1024),
                    String(repeating: "[", count: 33) + "0" + String(repeating: "]", count: 33)] {
            XCTAssertThrowsError(try NativeWatchSnapshot(json: raw))
        }
        var quoted = context()
        quoted["focus"] = [["id": "quoted", "title": String(repeating: "[", count: 100) + "\\\"{}"]]
        XCTAssertNoThrow(try snapshot(quoted))
    }

    func testActualBinaryPropertyListBudgetDropsWholeDetailsAndPreservesSummaries() throws {
        var raw = context()
        raw["focus"] = (0..<20).map { index -> [String: Any] in
            ["id": "task-\(index)", "title": "Synthetic \(index)",
             "description": String(repeating: "\(index)牛奶😀", count: 1000),
             "checklist": [["id": "milk-\(index)", "title": "Milk", "isCompleted": false]]]
        }
        let normalized = try snapshot(raw).applicationContext()
        let encoded = try PropertyListSerialization.data(fromPropertyList: normalized, format: .binary, options: 0)
        XCTAssertLessThanOrEqual(encoded.count, 60 * 1024)
        let tasks = try XCTUnwrap(normalized["focus"] as? [[String: Any]])
        XCTAssertEqual(tasks.count, 20)
        XCTAssertTrue(tasks.contains { $0["detailsUnavailable"] as? Bool == true })
        for task in tasks where task["detailsUnavailable"] as? Bool == true {
            XCTAssertNil(task["description"]); XCTAssertNil(task["checklist"])
            XCTAssertTrue((task["title"] as? String)?.hasPrefix("Synthetic ") == true)
        }
    }

    func testLeadingBOMInsideDetailSurvivesJSONAndPropertyList() throws {
        let raw = #"{"protocolVersion":1,"generatedAt":"2026-10-30T12:00:00Z","focus":[{"id":"bom","title":"Synthetic","description":"\uFEFFSynthetic detail"}],"pomodoro":{"phase":"focus","isRunning":false,"remainingSeconds":1500}}"#
        let decoded = try NativeWatchSnapshot(json: raw).applicationContext()
        let focus = try XCTUnwrap(decoded["focus"] as? [[String: Any]])
        XCTAssertEqual(Array(try XCTUnwrap(focus.first?["description"] as? String).utf8),
                       Array("\u{feff}Synthetic detail".utf8))
    }
}
