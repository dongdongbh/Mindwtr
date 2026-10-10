import Foundation
import XCTest
@testable import MindwtrNativeCore

private actor CalendarAuthorizationGate {
    private var cancelled = false
    private var held: CheckedContinuation<Bool, Never>?
    let entered: XCTestExpectation
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func wait() async -> Bool {
        await withTaskCancellationHandler {
            if Task.isCancelled || cancelled { return false }
            return await withCheckedContinuation { continuation in
                if cancelled { continuation.resume(returning: false) }
                else { held = continuation; entered.fulfill() }
            }
        } onCancel: { Task { await self.cancel() } }
    }
    func cancel() { cancelled = true; held?.resume(returning: false); held = nil }
}

private actor CalendarAuthorizationCallback {
    private var held: CheckedContinuation<Void, Never>?
    let entered: XCTestExpectation
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func request() async throws {
        await withCheckedContinuation { held = $0; entered.fulfill() }
    }
    func release() { held?.resume(); held = nil }
}

private actor CalendarAuthorizationCloseState {
    private var completed = false
    func finish() { completed = true }
    func isCompleted() -> Bool { completed }
}

final class NativeCalendarAuthorizationTests: XCTestCase {
    func testSecondBeginRefusedUntilMatchingOwnerFinishes() throws {
        let owner = NativeCalendarAuthorization(), id = try owner.begin()
        XCTAssertThrowsError(try owner.begin())
        owner.finish(UUID())
        XCTAssertThrowsError(try owner.begin())
        owner.finish(id)
        let next = try owner.begin()
        XCTAssertNotEqual(id, next)
        owner.finish(next)
    }

    func testCancelledBeforeRequestRefusesReadmissionWithoutCallingCheck() async throws {
        let owner = NativeCalendarAuthorization(), id = try owner.begin()
        owner.cancelReadmission(id)
        let admitted = await owner.readmit(id) { XCTFail("Cancelled owner must not check or request permission"); return true }
        XCTAssertFalse(admitted)
        XCTAssertThrowsError(try owner.begin())
        owner.finish(id)
    }

    func testAcceptedCallbackCancellationBlocksCloseUntilOwnerFinishes() async throws {
        let owner = NativeCalendarAuthorization(), id = try owner.begin()
        let callbackEntered = expectation(description: "accepted callback held")
        let callback = CalendarAuthorizationCallback(callbackEntered)
        let requester: NativeCalendarAuthorization.Requester = { try await callback.request() }
        let request = Task { try await requester() }
        await fulfillment(of: [callbackEntered], timeout: 3)
        request.cancel()
        XCTAssertThrowsError(try owner.begin())
        let readmissionEntered = expectation(description: "readmission held")
        let gate = CalendarAuthorizationGate(readmissionEntered)
        let readmission = Task { await owner.readmit(id) { await gate.wait() } }
        await fulfillment(of: [readmissionEntered], timeout: 3)
        let state = CalendarAuthorizationCloseState()
        let close = Task { await owner.closeAndDrain(); await state.finish() }
        let admitted = await readmission.value
        XCTAssertFalse(admitted)
        let beforeCallback = await state.isCompleted()
        XCTAssertFalse(beforeCallback)
        let afterClose = await owner.readmit(id) { XCTFail("Closed owner must not run check"); return true }
        XCTAssertFalse(afterClose)
        await callback.release(); try await request.value
        let beforeFinish = await state.isCompleted()
        XCTAssertFalse(beforeFinish)
        owner.finish(id); await close.value
        let completed = await state.isCompleted()
        XCTAssertTrue(completed)
        XCTAssertThrowsError(try owner.begin())
    }

    func testCloseCancelsSuspendedReadmissionWithoutFutureActiveEvent() async throws {
        let owner = NativeCalendarAuthorization(), id = try owner.begin()
        let entered = expectation(description: "cooperative readmission held")
        let gate = CalendarAuthorizationGate(entered)
        let edit = Task {
            let admitted = await owner.readmit(id) { await gate.wait() }
            owner.finish(id)
            return admitted
        }
        await fulfillment(of: [entered], timeout: 3)
        let drained = expectation(description: "close drained cancelled readmission")
        let close = Task { await owner.closeAndDrain(); drained.fulfill() }
        await fulfillment(of: [drained], timeout: 3)
        await close.value
        let admitted = await edit.value
        XCTAssertFalse(admitted)
        XCTAssertThrowsError(try owner.begin())
    }

    func testClosedOwnerRefusesBeginAndReadmission() async throws {
        let owner = NativeCalendarAuthorization()
        await owner.closeAndDrain()
        XCTAssertThrowsError(try owner.begin())
        let admitted = await owner.readmit(UUID()) { XCTFail("Closed owner must not run check"); return true }
        XCTAssertFalse(admitted)
        await owner.closeAndDrain()
    }

    func testStaleOwnerCannotFinishOrCancelNewOwner() async throws {
        let owner = NativeCalendarAuthorization(), stale = try owner.begin()
        owner.finish(stale)
        let current = try owner.begin()
        owner.finish(stale); owner.cancelReadmission(stale)
        XCTAssertThrowsError(try owner.begin())
        let staleAdmission = await owner.readmit(stale) { XCTFail("Stale owner must not run check"); return true }
        XCTAssertFalse(staleAdmission)
        let currentAdmission = await owner.readmit(current) { true }
        XCTAssertTrue(currentAdmission)
        owner.finish(current)
    }

    func testOverlappingReadmissionCannotReplaceHeldTask() async throws {
        let owner = NativeCalendarAuthorization(), id = try owner.begin()
        let entered = expectation(description: "first readmission held")
        let gate = CalendarAuthorizationGate(entered)
        let first = Task { await owner.readmit(id) { await gate.wait() } }
        await fulfillment(of: [entered], timeout: 3)
        let second = await owner.readmit(id) { XCTFail("Overlapping readmission must not run check"); return true }
        XCTAssertFalse(second)
        owner.cancelReadmission(id)
        let firstAdmission = await first.value
        XCTAssertFalse(firstAdmission)
        owner.finish(id)
    }

    func testLateReadmissionCannotAdmitFinishedOwnerOrClearNewReadmission() async throws {
        let owner = NativeCalendarAuthorization(), stale = try owner.begin()
        let oldEntered = expectation(description: "old readmission held")
        let old = CalendarAuthorizationCallback(oldEntered)
        let previous = Task { await owner.readmit(stale) { try? await old.request(); return true } }
        await fulfillment(of: [oldEntered], timeout: 3)
        owner.finish(stale)
        let current = try owner.begin()
        let newEntered = expectation(description: "new readmission held")
        let gate = CalendarAuthorizationGate(newEntered)
        let next = Task { await owner.readmit(current) { await gate.wait() } }
        await fulfillment(of: [newEntered], timeout: 3)
        await old.release()
        let previousAdmission = await previous.value
        XCTAssertFalse(previousAdmission)
        owner.cancelReadmission(current)
        let nextAdmission = await next.value
        XCTAssertFalse(nextAdmission)
        owner.finish(current)
    }
}
