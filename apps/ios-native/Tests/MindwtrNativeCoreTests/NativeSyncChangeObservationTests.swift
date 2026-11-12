import XCTest
@testable import MindwtrNativeCore

final class NativeSyncChangeObservationTests: XCTestCase {
    func testObservationDecodesOnlyTheExactKeySet() throws {
        XCTAssertTrue(try NativeSyncChangeObservation(json: #"{"pending":true}"#).pending)
        XCTAssertFalse(try NativeSyncChangeObservation(json: #"{"pending":false}"#).pending)
        for json in [#"{}"#, #"{"pending":1}"#, #"{"pending":"true"}"#, #"{"pending":true,"revision":1}"#,
                     #"{"pending":true,"pending":false}"#, #"[true]"#, #"true"#] {
            XCTAssertThrowsError(try NativeSyncChangeObservation(json: json), json)
        }
    }

    func testScheduleDecodesABoundedWholeDelayOrNothing() throws {
        XCTAssertNil(try NativeSyncChangeSchedule(json: #"{"delayMs":null}"#).delayMs)
        XCTAssertEqual(try NativeSyncChangeSchedule(json: #"{"delayMs":0}"#).delayMs, 0)
        XCTAssertEqual(try NativeSyncChangeSchedule(json: #"{"delayMs":1999.2}"#).delayMs, 2_000)
        XCTAssertEqual(try NativeSyncChangeSchedule(json: #"{"delayMs":1e12}"#).delayMs, NativeSyncChangeSchedule.maximumDelayMs)
        for json in [#"{}"#, #"{"delayMs":-1}"#, #"{"delayMs":true}"#, #"{"delayMs":"5"}"#, #"{"delayMs":5,"pending":true}"#,
                     #"{"delayMs":5,"delayMs":6}"#, #"[5]"#, #"5"#] {
            XCTAssertThrowsError(try NativeSyncChangeSchedule(json: json), json)
        }
    }
}
