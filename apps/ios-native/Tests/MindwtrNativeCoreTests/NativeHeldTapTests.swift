import XCTest
@testable import MindwtrNativeCore

final class NativeHeldTapTests: XCTestCase {
    private let start = ContinuousClock.now

    func testHeldTapRunsOnceInItsOwnContextBeforeItExpires() {
        var tap = NativeHeldTap<String, String>()
        tap.hold("open focus", context: "inbox", now: start, replaying: nil)
        XCTAssertEqual(tap.take(context: "inbox", now: start + .milliseconds(400))?.action, "open focus")
        XCTAssertNil(tap.take(context: "inbox", now: start + .milliseconds(450)))
        XCTAssertFalse(tap.isHolding)
    }

    func testLatestTapReplacesAnEarlierOne() {
        var tap = NativeHeldTap<String, String>()
        tap.hold("open focus", context: "inbox", now: start, replaying: nil)
        tap.hold("open menu", context: "inbox", now: start + .milliseconds(50), replaying: nil)
        XCTAssertEqual(tap.take(context: "inbox", now: start + .milliseconds(100))?.action, "open menu")
    }

    func testTapIsDroppedAfterOneSecondOrWhenTheContextChanged() {
        var late = NativeHeldTap<String, String>()
        late.hold("open focus", context: "inbox", now: start, replaying: nil)
        XCTAssertNil(late.take(context: "inbox", now: start + .seconds(1)))
        XCTAssertFalse(late.isHolding)

        var moved = NativeHeldTap<String, String>()
        moved.hold("open focus", context: "inbox", now: start, replaying: nil)
        XCTAssertNil(moved.take(context: "inbox+sheet", now: start + .milliseconds(10)))
        XCTAssertFalse(moved.isHolding)
    }

    func testAReplayHeldAgainKeepsItsFirstTimeAndContext() throws {
        var tap = NativeHeldTap<String, String>()
        tap.hold("open focus", context: "inbox", now: start, replaying: nil)
        let replay = try XCTUnwrap(tap.take(context: "inbox", now: start + .milliseconds(600)))
        tap.hold(replay.action, context: "other", now: start + .milliseconds(700), replaying: replay.origin)
        XCTAssertEqual(tap.take(context: "inbox", now: start + .milliseconds(900))?.action, "open focus")
        tap.hold(replay.action, context: "inbox", now: start + .milliseconds(950), replaying: replay.origin)
        XCTAssertNil(tap.take(context: "inbox", now: start + .milliseconds(1_050)))
    }
}
