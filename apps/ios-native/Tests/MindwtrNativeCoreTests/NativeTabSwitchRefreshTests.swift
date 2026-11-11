import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativeTabSwitchRefreshTests: XCTestCase {
    private func decoded(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func testEqualHostRepliesAreSameAcrossKeyOrderNestingAndNull() throws {
        let first = try decoded(#"{"a":[1,{"b":null,"c":"x"}],"d":true,"e":{"f":[]}}"#)
        let second = try decoded(#"{"e":{"f":[]},"d":true,"a":[1,{"c":"x","b":null}]}"#)
        XCTAssertTrue(NativeValueEquality.same(first, second))
        XCTAssertTrue(NativeValueEquality.same([String: Any](), [String: Any]()))
        XCTAssertTrue(NativeValueEquality.same(try decoded(#"{"n":1}"#), try decoded(#"{"n":1.0}"#)))
    }

    func testChangedHostRepliesAreNotSame() throws {
        let base = try decoded(#"{"a":[1,{"b":null,"c":"x"}],"d":true}"#)
        for changed in [#"{"a":[1,{"b":null,"c":"y"}],"d":true}"#, #"{"a":[1,{"b":0,"c":"x"}],"d":true}"#,
                        #"{"a":[{"b":null,"c":"x"},1],"d":true}"#, #"{"a":[1,{"b":null,"c":"x"}],"d":false}"#,
                        #"{"a":[1,{"b":null,"c":"x"}]}"#, #"{"a":[1,{"b":null,"c":"x"}],"d":true,"z":1}"#,
                        #"{"a":[1,{"b":null,"c":"x"},2],"d":true}"#, #"{"a":{"0":1},"d":true}"#] {
            XCTAssertFalse(NativeValueEquality.same(base, try decoded(changed)), changed)
            XCTAssertFalse(NativeValueEquality.same(try decoded(changed), base), changed)
        }
    }

    func testBooleanAndNumberWithEqualValueAreNotSame() throws {
        XCTAssertFalse(NativeValueEquality.same(try decoded(#"{"v":true}"#), try decoded(#"{"v":1}"#)))
        XCTAssertFalse(NativeValueEquality.same(try decoded(#"{"v":[false]}"#), try decoded(#"{"v":[0]}"#)))
        XCTAssertTrue(NativeValueEquality.same(try decoded(#"{"v":false}"#), ["v": false]))
        XCTAssertFalse(NativeValueEquality.same(try decoded(#"{"v":"1"}"#), try decoded(#"{"v":1}"#)))
    }

    private func swipeIdentity(context: String = "inbox:4:[]", taskID: String = "t1", taskRevision: String = "r1",
                               status: String = "next", focusedToday: Bool = false, selectionMode: Bool = false,
                               readOnly: Bool = false, interactionDisabled: Bool = false,
                               languageGeneration: Int = 2, ready: Bool = true) -> String {
        NativeTaskRowSwipeRead.identity(context: context, taskID: taskID, taskRevision: taskRevision, status: status,
                                        focusedToday: focusedToday, selectionMode: selectionMode, readOnly: readOnly,
                                        interactionDisabled: interactionDisabled, languageGeneration: languageGeneration,
                                        ready: ready)
    }

    func testSwipeReadIdentityIsStableWithoutARealChange() {
        XCTAssertEqual(swipeIdentity(), swipeIdentity())
    }

    func testSwipeReadIdentityChangesWithTaskPresentationAndActionInputs() {
        let base = swipeIdentity()
        let changed = [
            swipeIdentity(context: "inbox:5:[]"), swipeIdentity(context: "focus:4:[]"), swipeIdentity(taskID: "t2"),
            swipeIdentity(taskRevision: "r2"), swipeIdentity(status: "done"), swipeIdentity(focusedToday: true),
            swipeIdentity(selectionMode: true), swipeIdentity(readOnly: true), swipeIdentity(interactionDisabled: true),
            swipeIdentity(languageGeneration: 3), swipeIdentity(ready: false),
        ]
        for identity in changed { XCTAssertNotEqual(identity, base) }
        XCTAssertEqual(Set(changed).count, changed.count)
    }

    func testSearchIndexStaysOnlyForAKnownOffLockOnTheSameHostWithoutAWrite() {
        XCTAssertTrue(NativeSearchAppLockReread.keepsIndex(lockEnabledBefore: false, readOnSameHost: true, writing: false))
        XCTAssertFalse(NativeSearchAppLockReread.keepsIndex(lockEnabledBefore: nil, readOnSameHost: true, writing: false))
        XCTAssertFalse(NativeSearchAppLockReread.keepsIndex(lockEnabledBefore: true, readOnSameHost: true, writing: false))
        XCTAssertFalse(NativeSearchAppLockReread.keepsIndex(lockEnabledBefore: false, readOnSameHost: false, writing: false))
        XCTAssertFalse(NativeSearchAppLockReread.keepsIndex(lockEnabledBefore: false, readOnSameHost: true, writing: true))
    }
}
