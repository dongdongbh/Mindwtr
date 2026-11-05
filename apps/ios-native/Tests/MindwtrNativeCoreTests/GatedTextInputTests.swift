import XCTest
@testable import MindwtrNativeCore

final class GatedTextInputTests: XCTestCase {
    func testTextTypedWhileNotAdmittedIsStoredDeferredThenRevalidated() {
        var input = GatedTextInput(limit: 2_000)
        XCTAssertTrue(input.accept("#phone"))
        input.deferValidation()
        XCTAssertEqual(input.text, "#phone")
        XCTAssertTrue(input.deferred)
        XCTAssertFalse(input.canSave)
        let ticket = input.beginValidation()
        XCTAssertFalse(input.deferred)
        XCTAssertTrue(input.validating)
        XCTAssertTrue(input.finish(ticket, canSave: true))
        XCTAssertFalse(input.validating)
        XCTAssertTrue(input.canSave)
        XCTAssertEqual(input.text, "#phone")
    }

    func testTypingWhileDeferredKeepsLatestTextAndStaysDeferredUntilRevalidated() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#ph")
        input.deferValidation()
        input.accept("#phone")
        input.deferValidation()
        XCTAssertEqual(input.text, "#phone")
        XCTAssertTrue(input.deferred)
        let ticket = input.beginValidation()
        XCTAssertFalse(input.deferred)
        input.finish(ticket, canSave: true)
        XCTAssertTrue(input.canSave)
    }

    func testStaleTicketCannotEnableSaveForNewerText() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#ph")
        let stale = input.beginValidation()
        input.accept("#phone")
        XCTAssertFalse(input.isCurrent(stale))
        XCTAssertFalse(input.finish(stale, canSave: true))
        XCTAssertFalse(input.fail(stale))
        XCTAssertFalse(input.canSave)
        let current = input.beginValidation()
        XCTAssertFalse(input.isCurrent(stale))
        XCTAssertTrue(input.finish(current, canSave: false))
        XCTAssertFalse(input.canSave)
    }

    func testDeferralRetiresAnInFlightTicket() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        let inFlight = input.beginValidation()
        input.deferValidation()
        XCTAssertFalse(input.finish(inFlight, canSave: true))
        XCTAssertFalse(input.canSave)
        XCTAssertTrue(input.deferred)
    }

    func testSameTextReSetIsNoOpAndKeepsValidation() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        let ticket = input.beginValidation()
        input.finish(ticket, canSave: true)
        XCTAssertFalse(input.accept("#phone"))
        XCTAssertTrue(input.canSave)
        input.reset()
        XCTAssertFalse(input.accept(""))
        XCTAssertFalse(input.canSave)
    }

    func testOverLimitInputIsRejectedWithoutChangingState() {
        var input = GatedTextInput(limit: 4)
        XCTAssertTrue(input.accept("#abc"))
        let ticket = input.beginValidation()
        input.finish(ticket, canSave: true)
        XCTAssertFalse(input.accept("#abcd"))
        XCTAssertEqual(input.text, "#abc")
        XCTAssertFalse(input.canSave)
        XCTAssertTrue(input.rejected)
        XCTAssertFalse(input.accept("#ab\u{1F600}"))
        XCTAssertTrue(input.accept("#\u{1F600}"))
        XCTAssertFalse(input.rejected)
    }

    func testRejectedInputMakesTheStoredTextChangedAgain() {
        var input = GatedTextInput(limit: 4)
        input.accept("#abc")
        let ticket = input.beginValidation()
        input.finish(ticket, canSave: true)
        XCTAssertTrue(input.isUnchanged("#abc"))
        XCTAssertFalse(input.accept("#abcd"))
        XCTAssertFalse(input.isUnchanged("#abc"))
        XCTAssertTrue(input.accept("#abc"))
        XCTAssertFalse(input.rejected)
        XCTAssertFalse(input.canSave)
        XCTAssertTrue(input.isUnchanged("#abc"))
        input.accept("#abcd")
        input.reset()
        XCTAssertFalse(input.rejected)
        XCTAssertTrue(input.isUnchanged(""))
    }

    func testUnchangedTextIsReportedWithoutMutation() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        let ticket = input.beginValidation()
        input.finish(ticket, canSave: true)
        let before = input
        XCTAssertTrue(input.isUnchanged("#phone"))
        XCTAssertFalse(input.isUnchanged("#phon"))
        XCTAssertEqual(input, before)
    }

    func testResetClearsTextValidationAndDeferral() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        input.deferValidation()
        input.reset()
        XCTAssertEqual(input.text, "")
        XCTAssertFalse(input.deferred)
        XCTAssertFalse(input.validating)
        XCTAssertFalse(input.canSave)
        input.accept("#phone")
        let ticket = input.beginValidation()
        input.reset()
        XCTAssertFalse(input.finish(ticket, canSave: true))
        XCTAssertFalse(input.canSave)
    }

    func testInvalidateKeepsTextAndRetiresValidation() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        let ticket = input.beginValidation()
        input.invalidate()
        XCTAssertEqual(input.text, "#phone")
        XCTAssertFalse(input.validating)
        XCTAssertFalse(input.finish(ticket, canSave: true))
        XCTAssertFalse(input.canSave)
    }

    func testFailureEndsValidationWithoutEnablingSave() {
        var input = GatedTextInput(limit: 2_000)
        input.accept("#phone")
        let ticket = input.beginValidation()
        XCTAssertTrue(input.fail(ticket))
        XCTAssertFalse(input.validating)
        XCTAssertFalse(input.canSave)
        XCTAssertFalse(input.finish(ticket, canSave: true))
    }
}
