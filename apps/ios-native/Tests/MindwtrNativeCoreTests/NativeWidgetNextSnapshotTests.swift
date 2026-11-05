import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWidgetNextSnapshotTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func item(_ extra: [String: Any] = [:]) -> [String: Any] {
        ["id": "task", "title": "Synthetic title", "contextLabel": NSNull(), "dueLabel": NSNull(), "dueTone": "normal"]
            .merging(extra) { _, new in new }
    }
    private func root(_ items: [[String: Any]] = []) -> [String: Any] {
        ["version": 1, "title": "Next Actions", "emptyMessage": "No tasks found", "totalCount": items.count, "items": items]
    }

    func testExactUnicodeNullsCountsAndThirteenRowsSurviveWithoutNormalization() throws {
        let ids = ["é", "e\u{0301}", "Task", "task"] + (4..<13).map { "task-\($0)" }
        var value = root(ids.map { item(["id": $0, "title": "\u{FEFF}漢😀\u{0000}", "contextLabel": "", "dueTone": "today"]) })
        value["totalCount"] = 20
        let snapshot = try NativeWidgetNextSnapshot(json: json(value))
        XCTAssertEqual(snapshot.version, 1); XCTAssertEqual(snapshot.totalCount, 20)
        XCTAssertEqual(snapshot.items.map { Data($0.id.utf8) }, ids.map { Data($0.utf8) })
        XCTAssertEqual(snapshot.items[0].contextLabel, ""); XCTAssertNil(snapshot.items[0].dueLabel)
        XCTAssertEqual(snapshot.items[0].dueTone, .today)
        XCTAssertEqual(Data(snapshot.items[0].title.utf8), Data("\u{FEFF}漢😀\u{0000}".utf8))
        XCTAssertTrue(try NativeWidgetNextSnapshot(json: json(root())).items.isEmpty)
    }

    func testClosedShapeAndTrustBoundaryRejectInvalidFieldsCountsTonesAndDuplicates() throws {
        let valid = root([item()])
        for field in valid.keys {
            var bad = valid; bad.removeValue(forKey: field)
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(bad)))
        }
        for field in item().keys {
            var row = item(); row.removeValue(forKey: field)
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([row]))))
        }
        for count in [-1, true, 0, 1.5, "1", NSNull(), 9_007_199_254_740_992] as [Any] {
            var bad = valid; bad["totalCount"] = count
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(bad)))
        }
        for version in [true, 0, 2, "1", NSNull()] as [Any] {
            var bad = valid; bad["version"] = version
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(bad)))
        }
        for field in ["contextLabel", "dueLabel"] {
            for bad in [true, 0, [], ["nested": "text"]] as [Any] {
                XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([item([field: bad])]))))
            }
        }
        for tone in ["", "overDue", "unknown"] {
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([item(["dueTone": tone])]))))
        }
        var extra = valid; extra["fingerprint"] = "not admitted"
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(extra)))
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([item(["completionToken": "not admitted"])]))))
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([item(), item()]))))
        for raw in ["null", "[]", "{}", #"{"version":1,"version":1}"#,
                    #"{"version":1,"title":"Next","emptyMessage":"Empty","totalCount":0,"items":[],"\u0069tems":[]}"#,
                    #"{"version":1,"title":"Next","emptyMessage":"Empty","totalCount":1,"items":[{"id":"one","id":"two","title":"T","contextLabel":null,"dueLabel":null,"dueTone":"normal"}]}"#] {
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: raw))
        }
    }

    func testUTF16RowAndUTF8EnvelopeLimitsRefuseWholeProjection() throws {
        let exact = item(["id": String(repeating: "😀", count: 250), "title": String(repeating: "漢", count: 16_384),
                          "contextLabel": String(repeating: "漢", count: 16_384), "dueLabel": String(repeating: "x", count: 100)])
        XCTAssertEqual(try NativeWidgetNextSnapshot(json: json(root([exact]))).items.count, 1)
        for field in ["id", "title", "contextLabel", "dueLabel"] {
            var row = exact; row[field] = try XCTUnwrap(row[field] as? String) + "x"
            XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([row]))))
        }
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root([item(["id": ""])]))))
        let oversized = (0..<14).map { item(["id": "task-\($0)"]) }
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: json(root(oversized))))
        let raw = try json(root()), limit = 1_024 * 1_024
        let padded = raw + String(repeating: " ", count: limit - raw.utf8.count)
        XCTAssertTrue(try NativeWidgetNextSnapshot(json: padded).items.isEmpty)
        XCTAssertThrowsError(try NativeWidgetNextSnapshot(json: padded + " "))
    }
}
