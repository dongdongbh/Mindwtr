import XCTest
@testable import MindwtrNativeCore

@MainActor
final class NativeQuickCaptureRequestsTests: XCTestCase {
    @MainActor private final class Target: NativeQuickCaptureIntentTarget {
        let requests: NativeQuickCaptureRequests
        var held = true
        var presentations = 0
        var claimed: NativeQuickCaptureRequests.Claim?
        init(_ requests: NativeQuickCaptureRequests) { self.requests = requests }
        func requestQuickCaptureIntent() {
            guard let claim = requests.claim(for: self) else { return }
            claimed = claim
            guard !held, requests.confirm(claim, for: self) else { return }
            presentations += 1
        }
    }

    func testBeforeRegistrationAndHeldRequestsCoalesceUntilOneConfirmedPresentation() throws {
        let requests = NativeQuickCaptureRequests()
        requests.request(); requests.request()
        XCTAssertTrue(requests.isPending)
        let target = Target(requests)
        requests.register(target)
        let first = try XCTUnwrap(target.claimed)
        requests.request(); target.requestQuickCaptureIntent()
        XCTAssertEqual(target.claimed, first)
        XCTAssertEqual(target.presentations, 0)
        XCTAssertTrue(requests.isCurrent(first, for: target))
        target.held = false
        target.requestQuickCaptureIntent()
        XCTAssertEqual(target.presentations, 1)
        XCTAssertFalse(requests.isPending)
        target.requestQuickCaptureIntent(); requests.register(target)
        XCTAssertEqual(target.presentations, 1)
        XCTAssertFalse(requests.confirm(first, for: target))
    }

    func testReplacementAndUnregisterRefuseStaleConfirmationWithoutLosingPendingRequest() throws {
        let requests = NativeQuickCaptureRequests()
        let first = Target(requests), replacement = Target(requests)
        requests.register(first); requests.request()
        let stale = try XCTUnwrap(first.claimed)
        requests.register(replacement)
        XCTAssertFalse(requests.confirm(stale, for: first))
        requests.unregister(first)
        XCTAssertNotNil(requests.claim(for: replacement))
        let beforeDisappear = try XCTUnwrap(replacement.claimed)
        requests.unregister(replacement)
        XCTAssertFalse(requests.confirm(beforeDisappear, for: replacement))
        XCTAssertTrue(requests.isPending)
        requests.register(replacement)
        XCTAssertNotEqual(replacement.claimed, beforeDisappear)
        replacement.held = false; replacement.requestQuickCaptureIntent()
        XCTAssertEqual(replacement.presentations, 1)
        XCTAssertFalse(requests.isPending)
    }

    func testRegistrationDoesNotRetainModelAndNextRegistrationReceivesPendingRequest() {
        let requests = NativeQuickCaptureRequests()
        weak var weakTarget: Target?
        do {
            let target = Target(requests); weakTarget = target
            requests.register(target); requests.request()
        }
        XCTAssertNil(weakTarget)
        let replacement = Target(requests); replacement.held = false
        requests.register(replacement)
        XCTAssertEqual(replacement.presentations, 1)
        XCTAssertFalse(requests.isPending)
    }
}
