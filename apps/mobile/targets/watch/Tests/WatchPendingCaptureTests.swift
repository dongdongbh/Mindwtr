import Foundation
import XCTest
@testable import MindwtrWatchCaptureState
@testable import MindwtrWatchProtocolCore

final class WatchPendingCaptureTests: XCTestCase {
    func testFailedTextCaptureRetryKeepsIdentityUntilSaveSucceeds() throws {
        let id = UUID(uuidString: "42fe1a71-9232-4976-bf09-bebcb875b370")!
        let createdAt = Date(timeIntervalSince1970: 1_789_000_000)
        var owner = MindwtrWatchPendingCaptureOwner()
        let original = owner.prepareText("Call the dentist", id: id, createdAt: createdAt)
        var attempts: [MindwtrWatchPendingCapture] = []

        XCTAssertFalse(owner.persistPending { capture in
            attempts.append(capture)
            return false
        })
        let failed = try XCTUnwrap(owner.pending)
        XCTAssertEqual(failed.id, original.id)
        XCTAssertEqual(failed.createdAt, original.createdAt)
        XCTAssertEqual(failed.content, original.content)
        XCTAssertTrue(failed.outboxRetried)

        let retry = owner.prepareText("Call the dentist")
        XCTAssertEqual(retry, failed)
        XCTAssertTrue(owner.persistPending { capture in
            attempts.append(capture)
            return true
        })

        XCTAssertEqual(attempts, [original, failed])
        XCTAssertNil(owner.pending)
    }

    func testEditingRejectedTextCreatesANewCaptureIdentity() {
        let firstId = UUID(uuidString: "42fe1a71-9232-4976-bf09-bebcb875b370")!
        let secondId = UUID(uuidString: "b318ba50-f58a-4492-8e94-93f1ac704e26")!
        let firstDate = Date(timeIntervalSince1970: 1_789_000_000)
        let secondDate = Date(timeIntervalSince1970: 1_789_000_100)
        var owner = MindwtrWatchPendingCaptureOwner()

        let original = owner.prepareText("Call the dentist", id: firstId, createdAt: firstDate)
        XCTAssertFalse(owner.persistPending { _ in false })
        let edited = owner.prepareText("Call the dentist tomorrow", id: secondId, createdAt: secondDate)

        XCTAssertNotEqual(edited, original)
        XCTAssertEqual(edited.id, secondId)
        XCTAssertEqual(edited.createdAt, secondDate)
        XCTAssertFalse(edited.outboxRetried)
        XCTAssertEqual(owner.pending, edited)
    }

    func testFailedAudioCaptureRetryKeepsFileAndPublishesOnlyOnce() throws {
        let id = UUID(uuidString: "5586b34b-1fe9-4224-a2d0-1df28f644390")!
        let createdAt = Date(timeIntervalSince1970: 1_789_100_000)
        let fileURL = URL(fileURLWithPath: "/captures/recording.m4a")
        var owner = MindwtrWatchPendingCaptureOwner()
        let original = owner.prepareAudio(fileURL: fileURL, id: id, createdAt: createdAt)
        var attempts: [MindwtrWatchPendingCapture] = []

        XCTAssertFalse(owner.persistPending { capture in
            attempts.append(capture)
            return false
        })
        let failed = try XCTUnwrap(owner.pending)
        XCTAssertEqual(failed.id, original.id)
        XCTAssertEqual(failed.createdAt, original.createdAt)
        XCTAssertEqual(failed.content, original.content)
        XCTAssertTrue(failed.outboxRetried)
        XCTAssertTrue(owner.persistPending { capture in
            attempts.append(capture)
            return true
        })
        XCTAssertFalse(owner.persistPending { capture in
            attempts.append(capture)
            return true
        })

        XCTAssertEqual(attempts, [original, failed])
        XCTAssertNil(owner.pending)
    }

    func testProtocolAddsRetryMarkerOnlyWhenRequestedForCaptures() throws {
        let id = UUID(uuidString: "42fe1a71-9232-4976-bf09-bebcb875b370")!
        let createdAt = Date(timeIntervalSince1970: 1_789_000_000)

        let firstText = try XCTUnwrap(MindwtrWatchProtocol.textCapture(
            title: "First attempt",
            id: id,
            createdAt: createdAt
        ))
        XCTAssertNil(firstText["outboxRetried"])

        let retriedText = try XCTUnwrap(MindwtrWatchProtocol.textCapture(
            title: "Retry",
            id: id,
            createdAt: createdAt,
            outboxRetried: true
        ))
        XCTAssertEqual(retriedText["outboxRetried"] as? Bool, true)

        let retriedAudio = MindwtrWatchProtocol.audioMetadata(
            id: id,
            createdAt: createdAt,
            outboxRetried: true
        )
        XCTAssertEqual(retriedAudio["outboxRetried"] as? Bool, true)
        XCTAssertNil(MindwtrWatchProtocol.command(kind: .complete)["outboxRetried"])
    }
}
