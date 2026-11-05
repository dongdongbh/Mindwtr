import XCTest
@testable import MindwtrNativeCore

final class NativeStartupRecoveryTests: XCTestCase {
    func testPayloadCarriesOnlyPresentFields() {
        let plain = NativeStartupRecovery(method: "boardCommit", resultJSON: "{}").payload(result: ["ok": true])
        XCTAssertEqual(Set(plain.keys), ["method", "result"])
        XCTAssertEqual(plain["method"] as? String, "boardCommit")
        let full = NativeStartupRecovery(method: "taskCompletionCommit", resultJSON: "{}", source: "row", requestId: "id").payload(result: 1)
        XCTAssertEqual(Set(full.keys), ["method", "result", "source", "requestId"])
        XCTAssertEqual(full["source"] as? String, "row")
        XCTAssertEqual(full["requestId"] as? String, "id")
    }

    func testEverySourceAndReleaseRuleNamesAnAllowListedMethod() {
        let methods = NativeStartupRecovery.methods
        XCTAssertTrue(Set(NativeStartupRecovery.fixedSources.keys).isSubset(of: methods))
        XCTAssertTrue(NativeStartupRecovery.releasedWithRuntime.isSubset(of: methods))
        XCTAssertTrue(Set(NativeStartupRecovery.methodsReportedAfterRelease.keys).isSubset(of: methods))
        XCTAssertTrue(NativeStartupRecovery.requestIdsReleasedWithRuntime.isSubset(of: methods))
    }

    func testReleasingRuntimeReportsWhatTheStoredResultsReportedAfterRelease() {
        for method in NativeStartupRecovery.releasedWithRuntime {
            XCTAssertNil(NativeStartupRecovery(method: method, resultJSON: "{}", source: "x").releasingRuntime(), method)
        }
        XCTAssertEqual(NativeStartupRecovery(method: "inboxTasksMoveCommit", resultJSON: "{}", source: "waiting").releasingRuntime(),
                       NativeStartupRecovery(method: "inboxTasksMoveCommit", resultJSON: "{}", source: "inbox"))
        XCTAssertEqual(NativeStartupRecovery(method: "archivedTasksDeleteCommit", resultJSON: "{}", source: "done").releasingRuntime(),
                       NativeStartupRecovery(method: "archivedTasksDeleteCommit", resultJSON: "{}"))
        XCTAssertEqual(NativeStartupRecovery(method: "taskCompletionCommit", resultJSON: "{}", source: "board", requestId: "id").releasingRuntime(),
                       NativeStartupRecovery(method: "taskCompletionCommit", resultJSON: "{}"))
        XCTAssertEqual(NativeStartupRecovery(method: "manageAreaEditCommit", resultJSON: "{}").releasingRuntime(),
                       NativeStartupRecovery(method: "areaRenameCommit", resultJSON: "{}"))
        XCTAssertEqual(NativeStartupRecovery(method: "referenceTasksMoveCommit", resultJSON: "{}", source: "reference").releasingRuntime()?.source,
                       "reference")
        let attachment = NativeStartupRecovery(method: "attachmentOwnedSaveCommit", resultJSON: "{}", requestId: "id")
        XCTAssertEqual(attachment.releasingRuntime(), attachment)
    }
}
