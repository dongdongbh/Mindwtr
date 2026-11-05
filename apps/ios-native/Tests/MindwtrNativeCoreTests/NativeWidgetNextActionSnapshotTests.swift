import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeWidgetNextActionSnapshotTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func payload(ids: [String], tokens: [Any]) throws -> [String: Any] {
        ["snapshot": try json(["version": 1, "title": "Next", "emptyMessage": "Empty", "totalCount": ids.count,
            "items": ids.map { ["id": $0, "title": "Synthetic", "contextLabel": NSNull(), "dueLabel": NSNull(), "dueTone": "normal"] as [String: Any] }]),
         "tokens": tokens, "completeLabel": "完成", "undoLabel": "撤销"]
    }
    private func token(_ id: String) throws -> String { try json([id, 2, "2026-10-30T00:00:00Z", "next"]) }

    func testPreservesRawDisplayTokenAndLocalizedLabelsIncludingBOMAndByteDistinctIDs() throws {
        let ids = ["é", "e\u{0301}", "\u{FEFF}first", "read-only"]
        let values = try ids.prefix(3).map { try token($0) }
        let fields = try payload(ids: ids, tokens: values.map { $0 as Any } + [NSNull()])
        let actions = try NativeWidgetNextActionSnapshot(json: json(fields))
        XCTAssertEqual(Data(actions.snapshot.json.utf8), Data(try XCTUnwrap(fields["snapshot"] as? String).utf8))
        XCTAssertEqual(actions.tokens.count, 4)
        for index in values.indices { XCTAssertEqual(actions.tokens[index].map { Data($0.utf8) }, Data(values[index].utf8)) }
        XCTAssertNil(actions.tokens[3]); XCTAssertEqual(actions.completeLabel, "完成"); XCTAssertEqual(actions.undoLabel, "撤销")
    }

    func testClosedShapeAndCanonicalRowBindingRejectInvalidCapabilities() throws {
        let valid = try payload(ids: ["é"], tokens: [token("é")])
        for field in valid.keys {
            var bad = valid; bad.removeValue(forKey: field)
            XCTAssertThrowsError(try NativeWidgetNextActionSnapshot(json: json(bad)))
        }
        for (field, value) in [("extra", 1), ("tokens", []), ("tokens", [true]),
                ("tokens", [try token("e\u{0301}")]), ("tokens", [try token("other")]),
                ("tokens", ["[\"é\",true,\"stamp\",\"next\"]"]),
                ("tokens", ["[\"é\",1,\"stamp\",\"unknown\"]"]),
                ("tokens", [String(repeating: " ", count: 8_193)]),
                ("completeLabel", ""), ("undoLabel", String(repeating: "x", count: 16_385))] as [(String, Any)] {
            var bad = valid; bad[field] = value
            XCTAssertThrowsError(try NativeWidgetNextActionSnapshot(json: json(bad)))
        }
        let raw = try json(valid)
        XCTAssertThrowsError(try NativeWidgetNextActionSnapshot(json: "{\"tokens\":[]," + String(raw.dropFirst())))
        let padded = raw + String(repeating: " ", count: 2 * 1_024 * 1_024 - raw.utf8.count)
        XCTAssertNoThrow(try NativeWidgetNextActionSnapshot(json: padded))
        XCTAssertThrowsError(try NativeWidgetNextActionSnapshot(json: padded + " "))
    }
}
