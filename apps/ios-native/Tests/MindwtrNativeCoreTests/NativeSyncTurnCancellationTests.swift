import XCTest
@testable import MindwtrNativeCore

final class NativeSyncTurnCancellationTests: XCTestCase {
    func testSettledSyncCancellationWithoutCleanupIsClean() {
        for command in ["syncStored", "syncResume", "syncPull"] {
            XCTAssertTrue(NativeSyncTurnCancellation.isClean(CancellationError(), command: command, cleanupOwed: false, settled: true))
        }
    }

    func testUnsettledReplyKeepsTheRestartGate() {
        XCTAssertFalse(NativeSyncTurnCancellation.isClean(CancellationError(), command: "syncResume", cleanupOwed: false, settled: false))
    }

    func testOwedCleanupKeepsTheRestartGate() {
        XCTAssertFalse(NativeSyncTurnCancellation.isClean(CancellationError(), command: "syncResume", cleanupOwed: true, settled: true))
    }

    func testOtherErrorsKeepTheRestartGate() {
        XCTAssertFalse(NativeSyncTurnCancellation.isClean(HostFailure("Core command failed"), command: "syncResume", cleanupOwed: false, settled: true))
    }

    func testNonSyncCommandsKeepTheRestartGate() {
        for command in ["syncNow", "runSyncEncryptionAction", "archiveRetention", "projectAttachmentDownload", "saveSyncBackend"] {
            XCTAssertFalse(NativeSyncTurnCancellation.isClean(CancellationError(), command: command, cleanupOwed: false, settled: true))
        }
    }
}
