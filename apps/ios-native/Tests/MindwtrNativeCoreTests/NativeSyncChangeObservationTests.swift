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
}
