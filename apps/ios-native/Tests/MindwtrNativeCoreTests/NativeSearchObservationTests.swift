import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeSearchObservationTests: XCTestCase {
    func testClosedObservationAndExactNumbers() throws {
        let ready = try NativeSearchObservation(json: #"{"ready":true,"revision":9007199254740991,"nextAt":1800000000000}"#)
        XCTAssertTrue(ready.ready); XCTAssertEqual(ready.revision, 9_007_199_254_740_991)
        XCTAssertEqual(ready.nextAt, 1_800_000_000_000)
        let unavailable = try NativeSearchObservation(json: #"{"ready":false,"revision":0,"nextAt":null}"#)
        XCTAssertFalse(unavailable.ready); XCTAssertEqual(unavailable.revision, 0); XCTAssertNil(unavailable.nextAt)
        for raw in ["null", "[]", "{}", #"{"ready":1,"revision":1,"nextAt":null}"#,
                    #"{"ready":true,"revision":true,"nextAt":null}"#, #"{"ready":true,"revision":1.5,"nextAt":null}"#,
                    #"{"ready":true,"revision":-1,"nextAt":null}"#, #"{"ready":true,"revision":9007199254740992,"nextAt":null}"#,
                    #"{"ready":true,"revision":1,"nextAt":true}"#, #"{"ready":true,"revision":1,"nextAt":-1}"#,
                    #"{"ready":true,"revision":1,"nextAt":1e999}"#, #"{"ready":true,"revision":1}"#,
                    #"{"ready":true,"revision":1,"nextAt":null,"items":[]}"#,
                    #"{"ready":true,"revision":1,"nextAt":null,"\u0072eady":false}"#] {
            XCTAssertThrowsError(try NativeSearchObservation(json: raw), raw)
        }
        let raw = #"{"ready":true,"revision":1,"nextAt":null}"#
        XCTAssertNoThrow(try NativeSearchObservation(json: raw + String(repeating: " ", count: 2_048 - raw.utf8.count)))
        XCTAssertThrowsError(try NativeSearchObservation(json: raw + String(repeating: " ", count: 2_049 - raw.utf8.count)))
    }
}
