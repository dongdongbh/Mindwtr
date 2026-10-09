import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeSearchSnapshotTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func item(_ extra: [String: Any] = [:]) -> [String: Any] {
        ["id": "task", "title": "Synthetic title", "list": "next"].merging(extra) { _, new in new }
    }
    private func decode(_ values: [[String: Any]]) throws -> NativeSearchSnapshot {
        try NativeSearchSnapshot(json: json(["items": values]))
    }

    func testExactTextDatesEmptyTitlesAndByteDistinctIdentitySurvive() throws {
        let ids = ["é", "e\u{0301}", "Task", "task", "\u{FEFF}task"]
        let encodedIDs = [#""é""#, #""e\u0301""#, #""Task""#, #""task""#, #""\uFEFFtask""#]
        let values = encodedIDs.map {
            #"{"id":\#($0),"title":"\uFEFF漢😀\u0000e\u0301","list":"next","projectName":"\u0301Synthetic project","dueDate":"2026-10-09","startDate":"2026-10-09T00:00:00.000Z"}"#
        }
        let snapshot = try NativeSearchSnapshot(json: "{\"items\":[" + values.joined(separator: ",") + "]}")
        XCTAssertEqual(snapshot.items.map { Data($0.id.utf8) }, ids.map { Data($0.utf8) })
        XCTAssertEqual(snapshot.items.count, 5)
        for value in snapshot.items {
            XCTAssertEqual(Data(value.title.utf8), Data("\u{FEFF}漢😀\u{0000}e\u{0301}".utf8))
            XCTAssertEqual(Data(try XCTUnwrap(value.projectName).utf8), Data("\u{0301}Synthetic project".utf8))
            XCTAssertEqual(value.dueDate, "2026-10-09"); XCTAssertEqual(value.startDate, "2026-10-09T00:00:00.000Z")
            XCTAssertEqual(value.list, .next)
        }
        let empty = try decode([item(["title": "", "projectName": ""])])
        XCTAssertEqual(empty.items[0].title, ""); XCTAssertEqual(empty.items[0].projectName, "")
        XCTAssertNil(empty.items[0].dueDate); XCTAssertNil(empty.items[0].startDate)
        XCTAssertTrue(try decode([]).items.isEmpty)
    }

    func testClosedShapeRejectsMissingExtraNullNumericAndBooleanFields() throws {
        for raw in ["null", "[]", "{}", #"{"items":null}"#, #"{"items":{}}"#, #"{"items":[null]}"#,
                    #"{"items":[],"version":1}"#, #"{"items":[],"\uFEFFitems":[]}"#] {
            XCTAssertThrowsError(try NativeSearchSnapshot(json: raw), raw)
        }
        for field in ["id", "title", "list"] {
            var missing = item(); missing.removeValue(forKey: field)
            XCTAssertThrowsError(try decode([missing]))
        }
        let invalidValues: [Any] = [NSNull(), true, false, 0, 1, ["text"], ["nested": "text"]]
        for field in ["id", "title", "list", "projectName", "dueDate", "startDate"] {
            for value in invalidValues {
                XCTAssertThrowsError(try decode([item([field: value])]), field)
            }
        }
        for field in ["projectId", "deepLink", "notes", "attachments", "tags", "settings", "\u{FEFF}id"] {
            XCTAssertThrowsError(try decode([item([field: "private synthetic metadata"])]), field)
        }
        for list in ["", "project", "reference", "Next", "next "] {
            XCTAssertThrowsError(try decode([item(["list": list])]))
        }
        for list in ["inbox", "focus", "next", "waiting", "someday"] {
            XCTAssertEqual(try decode([item(["list": list])]).items[0].list.rawValue, list)
        }
    }

    func testRejectsExactDuplicateIDsAndDuplicateJSONMembers() throws {
        XCTAssertThrowsError(try decode([item(), item(["title": "Another synthetic title"])]))
        for raw in [#"{"items":[],"items":[]}"#, #"{"items":[],"\u0069tems":[]}"#,
                    #"{"items":[{"id":"one","id":"two","title":"Synthetic","list":"next"}]}"#,
                    #"{"items":[{"id":"one","title":"Synthetic","list":"next","\u006cist":"inbox"}]}"#] {
            XCTAssertThrowsError(try NativeSearchSnapshot(json: raw))
        }
    }

    func testUTF16BoundsAcceptExactAndRejectOneUnitOverWithoutTruncation() throws {
        let exact = item(["id": String(repeating: "😀", count: 250), "title": String(repeating: "😀", count: 8_192),
                          "projectName": String(repeating: "漢", count: 16_384),
                          "dueDate": String(repeating: "😀", count: 50), "startDate": String(repeating: "x", count: 100)])
        let snapshot = try decode([exact])
        XCTAssertEqual(snapshot.items[0].id.utf16.count, 500); XCTAssertEqual(snapshot.items[0].title.utf16.count, 16_384)
        for field in ["id", "title", "projectName", "dueDate", "startDate"] {
            var over = exact; over[field] = try XCTUnwrap(exact[field] as? String) + "x"
            XCTAssertThrowsError(try decode([over]), field)
        }
        for field in ["id", "dueDate", "startDate"] { XCTAssertThrowsError(try decode([item([field: ""])])) }
    }

    func testItemAndUTF8EnvelopeBoundsRejectWholeProjection() throws {
        let exact = (0..<2_750).map { item(["id": "synthetic-\($0)"]) }
        XCTAssertEqual(try decode(exact).items.count, 2_750)
        XCTAssertThrowsError(try decode(exact + [item(["id": "one-over"])]))
        let raw = try json(["items": []]), limit = 8 * 1_024 * 1_024
        let padded = raw + String(repeating: " ", count: limit - raw.utf8.count)
        XCTAssertEqual(padded.utf8.count, limit); XCTAssertTrue(try NativeSearchSnapshot(json: padded).items.isEmpty)
        XCTAssertThrowsError(try NativeSearchSnapshot(json: padded + " "))
        let multibyte = try json(["items": (0..<180).map { item(["id": "synthetic-\($0)", "title": String(repeating: "漢", count: 16_384)]) }])
        XCTAssertLessThan(multibyte.utf16.count, limit); XCTAssertGreaterThan(multibyte.utf8.count, limit)
        XCTAssertThrowsError(try NativeSearchSnapshot(json: multibyte))
    }
}
