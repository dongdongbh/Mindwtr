import XCTest
@testable import MindwtrNativeCore

final class NativeAppLockRelockPolicyTests: XCTestCase {
    func testOnlyWarmUnlockedDepartureMayResumeWithinDelay() {
        var policy = NativeAppLockRelockPolicy()
        XCTAssertFalse(policy.resume(delayMinutes: 5, now: 100))
        policy.leave(unlocked: false, now: 100)
        XCTAssertFalse(policy.resume(delayMinutes: 5, now: 101))
        policy.leave(unlocked: true, now: 100)
        policy.leave(unlocked: false, now: 150) // inactive -> background preserves departure
        XCTAssertTrue(policy.resume(delayMinutes: 1, now: 159.99))
        XCTAssertFalse(policy.resume(delayMinutes: 1, now: 160)) // consumed
    }
    func testExpirationImmediateInvalidAndBackwardClockRequireAuthentication() {
        for (delay, now) in [(0, 101.0), (1, 160.0), (5, 400.0), (15, 1000.0), (2, 101.0), (5, 99.0), (5, Double.infinity)] {
            var policy = NativeAppLockRelockPolicy()
            policy.leave(unlocked: true, now: 100)
            XCTAssertFalse(policy.resume(delayMinutes: delay, now: now))
        }
    }
    func testReadFailureOrLockSettingChangeClearsWarmSession() {
        var policy = NativeAppLockRelockPolicy()
        policy.leave(unlocked: true, now: 100)
        policy.reset()
        XCTAssertFalse(policy.resume(delayMinutes: 15, now: 101))
    }
}
