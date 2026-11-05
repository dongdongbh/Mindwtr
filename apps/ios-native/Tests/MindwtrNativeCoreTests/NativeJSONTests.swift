import XCTest
import Foundation
import CoreFoundation
@testable import MindwtrNativeCore

final class NativeJSONTests: XCTestCase {
    func testPreservesLeadingBOMInKeysValuesAndNestedText() throws {
        let escaped = #"{"\uFEFFkey":"\uFEFFvalue","key":"plain","nested":{"name":"\uFEFFx\u0000y"},"array":["\uFEFFz",null]}"#
        let object = try XCTUnwrap(NativeJSON.jsonObject(with: Data(escaped.utf8)) as? NSDictionary)
        XCTAssertEqual(object.count, 4)
        XCTAssertEqual(object.object(forKey: "key" as NSString) as? String, "plain")
        let value = try XCTUnwrap(object["\u{FEFF}key"] as? String)
        XCTAssertEqual(Array(value.utf8), Array("\u{FEFF}value".utf8))
        let nested = try XCTUnwrap(object["nested"] as? NSDictionary)
        let name = try XCTUnwrap(nested["name"] as? String)
        XCTAssertEqual(Array(name.utf8), Array("\u{FEFF}x\u{0000}y".utf8))
        let array = try XCTUnwrap(object["array"] as? NSArray)
        XCTAssertEqual(Array(try XCTUnwrap(array[0] as? String).utf8), Array("\u{FEFF}z".utf8))
        XCTAssertTrue(array[1] is NSNull)

        let literal = "{\"name\":\"\u{FEFF}raw\"}"
        let raw = try XCTUnwrap(NativeJSON.jsonObject(with: Data(literal.utf8)) as? [String: Any])
        XCTAssertEqual(Array(try XCTUnwrap(raw["name"] as? String).utf8), Array("\u{FEFF}raw".utf8))
    }

    func testBOMFallbackKeepsCanonicallyDistinctKeysAndLeadingCombiningMark() throws {
        let json = #"{"é":"composed","e\u0301":"decomposed","\uFEFFkey":"kept","nested":["\u0301x","\"\\"]}"#
        let object = try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? NSDictionary)
        XCTAssertEqual(object.count, 4)
        XCTAssertEqual(object.object(forKey: "é" as NSString) as? String, "composed")
        XCTAssertEqual(object.object(forKey: "e\u{0301}" as NSString) as? String, "decomposed")


        let bomKey = String(decoding: [0xEF, 0xBB, 0xBF, 0x6B, 0x65, 0x79], as: UTF8.self) as NSString
        XCTAssertEqual(bomKey.character(at: 0), 0xFEFF)
        XCTAssertEqual(object.object(forKey: bomKey) as? String, "kept")
        let nested = try XCTUnwrap(object["nested"] as? NSArray)
        XCTAssertEqual(Array(try XCTUnwrap(nested[0] as? String).utf8), [0xCC, 0x81, 0x78])
        XCTAssertEqual(Array(try XCTUnwrap(nested[1] as? String).utf8), [0x22, 0x5C])
    }

    func testKeepsFoundationBooleanIntegerDoubleAndNullShapes() throws {
        let json = #"{"\uFEFFmarker":"kept","flag":true,"zero":0,"minimum":-9223372036854775808,"maximum":18446744073709551615,"fraction":1.5,"nothing":null}"#
        let object = try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let flag = try XCTUnwrap(object["flag"] as? NSNumber)
        let zero = try XCTUnwrap(object["zero"] as? NSNumber)
        let minimum = try XCTUnwrap(object["minimum"] as? NSNumber)
        let maximum = try XCTUnwrap(object["maximum"] as? NSNumber)
        let fraction = try XCTUnwrap(object["fraction"] as? NSNumber)
        XCTAssertEqual(CFGetTypeID(flag), CFBooleanGetTypeID())
        XCTAssertNotEqual(CFGetTypeID(zero), CFBooleanGetTypeID())
        XCTAssertEqual(zero.int64Value, 0)
        XCTAssertEqual(minimum.int64Value, Int64.min)
        XCTAssertEqual(maximum.uint64Value, UInt64.max)
        XCTAssertEqual(fraction.doubleValue, 1.5)
        XCTAssertTrue(object["nothing"] is NSNull)
    }

    func testFragmentsMutableContainersAndUnsupportedOptions() throws {
        let fragment = #""\uFEFFfragment""#
        XCTAssertThrowsError(try NativeJSON.jsonObject(with: Data(fragment.utf8)))
        let text = try XCTUnwrap(NativeJSON.jsonObject(with: Data(fragment.utf8), options: [.fragmentsAllowed]) as? String)
        XCTAssertEqual(Array(text.utf8), Array("\u{FEFF}fragment".utf8))

        let json = #"{"nested":[{"name":"\uFEFFvalue"}]}"#
        let mutable = try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8), options: [.mutableContainers]) as? NSMutableDictionary)
        let array = try XCTUnwrap(mutable["nested"] as? NSMutableArray)
        let nested = try XCTUnwrap(array[0] as? NSMutableDictionary)
        XCTAssertEqual(Array(try XCTUnwrap(nested["name"] as? String).utf8), Array("\u{FEFF}value".utf8))
        mutable["added"] = "ok"
        XCTAssertEqual(mutable["added"] as? String, "ok")
        XCTAssertThrowsError(try NativeJSON.jsonObject(with: Data(json.utf8), options: [.mutableLeaves]))
    }

    func testRejectsMalformedUTF8() {
        let invalid = Data([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0x80, 0x22, 0x7D])
        XCTAssertThrowsError(try NativeJSON.jsonObject(with: invalid))
        let invalidWithBOM = Data([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22,
                                   0xEF, 0xBB, 0xBF, 0x80, 0x22, 0x7D])
        XCTAssertThrowsError(try NativeJSON.jsonObject(with: invalidWithBOM))
    }
}
