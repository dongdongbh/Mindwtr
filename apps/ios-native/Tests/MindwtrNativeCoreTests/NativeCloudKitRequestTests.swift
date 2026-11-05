import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeCloudKitRequestTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func parse(_ value: Any) throws -> NativeCloudKitRequest { try NativeCloudKitRequest(json: json(value)) }

    func testAllRecordsOperationsAndAttachmentDeletionUseExactProtocol() throws {
        guard case .accountStatus = try parse(["op": "accountStatus"]),
              case .ensureZone = try parse(["op": "ensureZone"]) else { return XCTFail("Wrong nullary request") }
        let types: [NativeCloudKitRequest.RecordType] = [.task, .project, .section, .area, .person, .settings]
        for type in types {
            guard case .fetchAllRecords(let fetched) = try parse(["op": "fetchAllRecords", "recordType": type.rawValue]) else {
                return XCTFail("Wrong fetch request")
            }
            XCTAssertEqual(fetched, type)
            let raw = #"[ { "id" : "legacy/ID ?#😀", "title" : "Synthetic" } ]"#
            guard case .saveRecords(let saved, let retained) = try parse(["op": "saveRecords", "recordType": type.rawValue, "recordsJSON": raw]) else {
                return XCTFail("Wrong save request")
            }
            XCTAssertEqual(saved, type); XCTAssertEqual(Data(retained.utf8), Data(raw.utf8))
        }
        for type in types + [.attachment] {
            guard case .deleteRecords(let deleted, let ids) = try parse(["op": "deleteRecords", "recordType": type.rawValue, "recordIDs": ["legacy/ID ?#😀"]]) else {
                return XCTFail("Wrong delete request")
            }
            XCTAssertEqual(deleted, type); XCTAssertEqual(ids, ["legacy/ID ?#😀"])
        }
        XCTAssertNoThrow(try parse(["op": "saveRecords", "recordType": "MindwtrTask", "recordsJSON": "[]"]))
        XCTAssertNoThrow(try parse(["op": "deleteRecords", "recordType": "MindwtrAttachment", "recordIDs": []]))
    }

    func testClosedFieldsUnknownTypesAndMalformedNestedJSONRefuse() throws {
        let valid: [[String: Any]] = [
            ["op": "accountStatus"], ["op": "ensureZone"],
            ["op": "fetchAllRecords", "recordType": "MindwtrTask"],
            ["op": "saveRecords", "recordType": "MindwtrTask", "recordsJSON": "[]"],
            ["op": "deleteRecords", "recordType": "MindwtrTask", "recordIDs": ["one"]],
            ["op": "saveAttachmentAsset", "recordName": "asset", "filePath": "opaque", "metadataJSON": "{}"],
            ["op": "fetchAttachmentAsset", "recordName": "asset", "targetPath": "opaque"],
        ]
        for value in valid {
            for key in value.keys {
                var missing = value; missing.removeValue(forKey: key)
                XCTAssertThrowsError(try parse(missing))
            }
            var extra = value; extra["extra"] = true
            XCTAssertThrowsError(try parse(extra))
        }
        for raw in ["null", "[]", "true", "bad", #"{"op":"unknown"}"#,
                    #"{"op":"ensureZone","op":"accountStatus"}"#,
                    #"{"op":"ensureZone","\u006fp":"accountStatus"}"#] {
            XCTAssertThrowsError(try NativeCloudKitRequest(json: raw))
        }
        for op in ["fetchAllRecords", "saveRecords", "deleteRecords"] {
            let base: [String: Any] = op == "saveRecords" ? ["op": op, "recordsJSON": "[]"]
                : op == "deleteRecords" ? ["op": op, "recordIDs": []] : ["op": op]
            for type in ["Unknown", "mindwtrtask", "", "MindwtrAttachment"] where op != "deleteRecords" || type != "MindwtrAttachment" {
                var bad = base; bad["recordType"] = type
                XCTAssertThrowsError(try parse(bad))
            }
        }
        for raw in ["null", "{}", "bad", "[null]", "[{\"title\":\"no id\"}]", "[{\"id\":\"one\",\"id\":\"two\"}]", "[{\"id\":\"same\"},{\"id\":\"same\"}]"] {
            XCTAssertThrowsError(try parse(["op": "saveRecords", "recordType": "MindwtrTask", "recordsJSON": raw]))
        }
        for raw in ["null", "[]", "bad", "{\"id\":1,\"id\":2}"] {
            XCTAssertThrowsError(try parse(["op": "saveAttachmentAsset", "recordName": "asset", "filePath": "opaque", "metadataJSON": raw]))
        }
        let malformed: [[String: Any]] = [
            ["op": "accountStatus", "recordType": "MindwtrTask"],
            ["op": false], ["op": "fetchAllRecords", "recordType": false],
            ["op": "saveRecords", "recordType": "MindwtrTask", "recordsJSON": []],
            ["op": "deleteRecords", "recordType": "MindwtrTask", "recordIDs": [true]],
            ["op": "saveAttachmentAsset", "recordName": "asset", "filePath": "opaque", "metadataJSON": [:]],
            ["op": "fetchAttachmentAsset", "recordName": "asset", "targetPath": NSNull()],
        ]
        for value in malformed { XCTAssertThrowsError(try parse(value)) }
    }

    func testByteDistinctUnicodeAndLeadingBOMSurviveWithoutReserialization() throws {
        let ids = ["é", "e\u{0301}", "Task", "task", "\u{FEFF}legacy/😀"]
        let raw = #"{"op":"deleteRecords","recordType":"MindwtrTask","recordIDs":["é","e\u0301","Task","task","\uFEFFlegacy/😀"]}"#
        guard case .deleteRecords(_, let retained) = try NativeCloudKitRequest(json: raw) else { return XCTFail("Wrong delete request") }
        XCTAssertEqual(retained.map { Data($0.utf8) }, ids.map { Data($0.utf8) })
        let body = #"[ {"id":"\uFEFFlegacy/😀","title":"\uFEFFsynthetic"}, {"id":"é"}, {"id":"e\u0301"} ]"#
        guard case .saveRecords(_, let saved) = try parse(["op": "saveRecords", "recordType": "MindwtrTask", "recordsJSON": body]) else {
            return XCTFail("Wrong save request")
        }
        XCTAssertEqual(Data(saved.utf8), Data(body.utf8))
        let asset = #"{"op":"fetchAttachmentAsset","recordName":"\uFEFFlegacy/😀","targetPath":"\uFEFFfile:///opaque/é"}"#
        guard case .fetchAttachmentAsset(let name, let path) = try NativeCloudKitRequest(json: asset) else { return XCTFail("Wrong asset request") }
        XCTAssertEqual(Data(name.utf8), Data(ids[4].utf8))
        XCTAssertEqual(Data(path.utf8), Data("\u{FEFF}file:///opaque/é".utf8))
        let metadata = #"{ "title": "\uFEFFsynthetic", "ownerId": "e\u0301" }"#
        guard case .saveAttachmentAsset(_, _, let savedMetadata) = try parse(["op": "saveAttachmentAsset", "recordName": "asset", "filePath": "opaque", "metadataJSON": metadata]) else {
            return XCTFail("Wrong asset request")
        }
        XCTAssertEqual(Data(savedMetadata.utf8), Data(metadata.utf8))
    }

    func testBoundsAndOpaquePathsDoNotGrantFileAuthority() throws {
        let boundary = String(repeating: "😀", count: 1_024)
        XCTAssertNoThrow(try parse(["op": "deleteRecords", "recordType": "MindwtrAttachment", "recordIDs": [boundary]]))
        for id in ["", boundary + "x", "line\nfeed", "nul\u{0000}", "del\u{007f}"] {
            XCTAssertThrowsError(try parse(["op": "deleteRecords", "recordType": "MindwtrTask", "recordIDs": [id]]))
            XCTAssertThrowsError(try parse(["op": "fetchAttachmentAsset", "recordName": id, "targetPath": "opaque"]))
        }
        XCTAssertThrowsError(try parse(["op": "deleteRecords", "recordType": "MindwtrTask", "recordIDs": ["same", "same"]]))
        // Only the future asset owner can turn one of these opaque values into an authorized file.
        for path in ["../relative", "file:///opaque/cache/file", "/outside/opaque", "https://example.invalid/opaque", String(repeating: "x", count: 16_384)] {
            guard case .fetchAttachmentAsset(_, let retained) = try parse(["op": "fetchAttachmentAsset", "recordName": "asset", "targetPath": path]) else {
                return XCTFail("Wrong asset request")
            }
            XCTAssertEqual(Data(retained.utf8), Data(path.utf8))
        }
        for path in ["", "nul\u{0000}", String(repeating: "x", count: 16_385)] {
            XCTAssertThrowsError(try parse(["op": "fetchAttachmentAsset", "recordName": "asset", "targetPath": path]))
        }
        let small = #"{"op":"accountStatus"}"#
        let padded = small + String(repeating: " ", count: NativeCloudKitRequest.maximumBytes - small.utf8.count)
        XCTAssertNoThrow(try NativeCloudKitRequest(json: padded))
        XCTAssertThrowsError(try NativeCloudKitRequest(json: padded + " "))
        XCTAssertThrowsError(try parse(["op": "deleteRecords", "recordType": "MindwtrTask", "recordIDs": Array(repeating: "id", count: 100_001)]))
    }
}
