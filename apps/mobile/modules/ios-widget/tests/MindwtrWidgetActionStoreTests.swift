import Dispatch
import Foundation
import XCTest
@testable import MindwtrWidgetActionStore

private final class LockedErrors: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Error] = []

    func append(_ error: Error) {
        lock.lock()
        values.append(error)
        lock.unlock()
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return values.count
    }
}

private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?

    func store(_ next: Value) {
        lock.lock()
        value = next
        lock.unlock()
    }

    func load() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

final class MindwtrWidgetActionStoreTests: XCTestCase {
    func testEnqueueUsesThreeSecondBoundaryAndCancelOnlyWorksBeforeClaim() throws {
        try withStore { store, _ in
            let start = Date(timeIntervalSince1970: 1_000)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: start)

            let pending = try XCTUnwrap(store.pendingActions().first)
            XCTAssertEqual(pending.createdAt, 1_000_000)
            XCTAssertEqual(pending.notBefore, 1_003_000)
            XCTAssertFalse(pending.claimed)
            XCTAssertEqual(try store.nextReadyAt(), 1_003_000)
            XCTAssertTrue(try store.claimReady(
                now: Date(timeIntervalSince1970: 1_002.999)
            ).isEmpty)

            let claimed = try store.claimReady(now: Date(timeIntervalSince1970: 1_003))
            XCTAssertEqual(claimed.map(\.id), [pending.id])
            XCTAssertTrue(try XCTUnwrap(claimed.first).claimed)
            XCTAssertNil(try store.nextReadyAt())

            XCTAssertFalse(try store.cancel(id: pending.id))
            XCTAssertEqual(try store.pendingActions().map(\.id), [pending.id])
        }
    }

    func testCancelRemovesOnlyTheExactUnclaimedOperation() throws {
        try withStore { store, _ in
            let now = Date(timeIntervalSince1970: 2_000)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now)
            try store.enqueue(taskId: "task-2", token: "revision-2", now: now)
            let pending = try store.pendingActions()

            XCTAssertTrue(try store.cancel(id: pending[0].id, now: now.addingTimeInterval(1)))
            XCTAssertFalse(try store.cancel(id: "missing-operation", now: now.addingTimeInterval(1)))

            XCTAssertEqual(try store.pendingActions().map(\.id), [pending[1].id])
        }
    }

    func testCancelRejectsAnUnclaimedActionAtAndAfterItsDeadline() throws {
        try withStore { store, _ in
            let start = Date(timeIntervalSince1970: 2_500)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: start)
            let action = try XCTUnwrap(store.pendingActions().first)

            XCTAssertFalse(try store.cancel(id: action.id, now: start.addingTimeInterval(3)))
            XCTAssertFalse(try store.cancel(id: action.id, now: start.addingTimeInterval(30)))
            XCTAssertEqual(try store.pendingActions(), [action])
        }
    }

    func testProjectionShowsGraceThenHidesAtTheExactExpiry() throws {
        let start = Date(timeIntervalSince1970: 2_600)
        let action = pendingAction(taskId: "task-1", token: "revision-1", start: start)
        let identity = MindwtrWidgetActionIdentity(taskId: "task-1", completionToken: "revision-1")

        XCTAssertEqual(
            MindwtrWidgetActionProjection.pendingAction(
                for: identity,
                in: [action],
                at: start.addingTimeInterval(2.999)
            ),
            action
        )
        XCTAssertFalse(MindwtrWidgetActionProjection.isHidden(
            identity,
            by: [action],
            at: start.addingTimeInterval(2.999)
        ))
        XCTAssertNil(MindwtrWidgetActionProjection.pendingAction(
            for: identity,
            in: [action],
            at: start.addingTimeInterval(3)
        ))
        XCTAssertTrue(MindwtrWidgetActionProjection.isHidden(
            identity,
            by: [action],
            at: start.addingTimeInterval(3)
        ))
    }

    func testProjectionMatchesBothTaskAndCompletionToken() {
        let start = Date(timeIntervalSince1970: 2_700)
        let oldOccurrence = pendingAction(taskId: "recurring", token: "occurrence-1", start: start)
        let nextOccurrence = MindwtrWidgetActionIdentity(
            taskId: "recurring",
            completionToken: "occurrence-2"
        )

        XCTAssertFalse(MindwtrWidgetActionProjection.isHidden(
            nextOccurrence,
            by: [oldOccurrence],
            at: start.addingTimeInterval(30)
        ))
        XCTAssertNil(MindwtrWidgetActionProjection.pendingAction(
            for: nextOccurrence,
            in: [oldOccurrence],
            at: start.addingTimeInterval(1)
        ))
    }

    func testProjectionKeepsFocusPrecedenceAndOnlyFallsBackForDefaultFocus() {
        let now = Date(timeIntervalSince1970: 2_800)
        let focus = MindwtrWidgetActionIdentity(taskId: "focus-1", completionToken: "focus-token")
        let next = MindwtrWidgetActionIdentity(taskId: "next-1", completionToken: "next-token")
        let lists: [String: [MindwtrWidgetActionIdentity]] = [
            "focus": [focus],
            "next": [next],
            "waiting": [],
        ]

        XCTAssertEqual(MindwtrWidgetActionProjection.resolvedListId(
            requestedListId: "focus",
            identitiesByList: lists,
            pendingActions: [],
            at: now
        ), "focus")

        let expiredFocus = pendingAction(
            taskId: "focus-1",
            token: "focus-token",
            start: now.addingTimeInterval(-3)
        )
        XCTAssertEqual(MindwtrWidgetActionProjection.resolvedListId(
            requestedListId: "focus",
            identitiesByList: lists,
            pendingActions: [expiredFocus],
            at: now
        ), "next")
        XCTAssertEqual(MindwtrWidgetActionProjection.resolvedListId(
            requestedListId: "waiting",
            identitiesByList: lists,
            pendingActions: [expiredFocus],
            at: now
        ), "waiting")
        XCTAssertEqual(MindwtrWidgetActionProjection.resolvedListId(
            requestedListId: "upcoming",
            identitiesByList: lists,
            pendingActions: [],
            at: now
        ), "upcoming")
        XCTAssertEqual(MindwtrWidgetActionProjection.resolvedListId(
            requestedListId: "focus",
            identitiesByList: ["focus": [], "next": []],
            pendingActions: [],
            at: now
        ), "next")
    }

    func testProjectionRefillsAfterSeveralExpiredCompletions() {
        let now = Date(timeIntervalSince1970: 2_900)
        let identities = (0..<6).map {
            MindwtrWidgetActionIdentity(taskId: "task-\($0)", completionToken: "token-\($0)")
        }
        let actions = (0..<3).map {
            pendingAction(taskId: "task-\($0)", token: "token-\($0)", start: now.addingTimeInterval(-3))
        }

        XCTAssertEqual(MindwtrWidgetActionProjection.visibleIndexes(
            in: identities,
            pendingActions: actions,
            at: now
        ), [3, 4, 5])
    }

    func testProjectionSchedulesDistinctFutureExpiryEntries() {
        let now = Date(timeIntervalSince1970: 2_950)
        let first = pendingAction(taskId: "task-1", token: "token-1", start: now)
        let duplicateExpiry = pendingAction(taskId: "task-2", token: "token-2", start: now)
        var claimed = pendingAction(taskId: "task-3", token: "token-3", start: now.addingTimeInterval(1))
        claimed.claimed = true

        XCTAssertEqual(
            MindwtrWidgetActionProjection.timelineDates(
                pendingActions: [first, duplicateExpiry, claimed],
                now: now
            ),
            [now, now.addingTimeInterval(3)]
        )
    }

    func testLegacyDecodedListsWithoutOpenUriUseCanonicalDestinations() throws {
        struct LegacyList: Decodable {
            let title: String
            let openUri: String?
        }

        let decoded = try JSONDecoder().decode(
            [String: LegacyList].self,
            from: Data(#"""
            {
                "focus":{"title":"Focus"},
                "inbox":{"title":"Inbox"},
                "next":{"title":"Next Actions"},
                "upcoming":{"title":"Upcoming"},
                "waiting":{"title":"Waiting For"},
                "someday":{"title":"Someday/Maybe"},
                "filter:cached":{"title":"Cached filter"}
            }
            """#.utf8)
        )
        let expected = [
            "focus": "mindwtr:///focus",
            "inbox": "mindwtr:///inbox",
            "next": "mindwtr:///widget-list/next",
            "upcoming": "mindwtr:///widget-list/upcoming",
            "waiting": "mindwtr:///waiting",
            "someday": "mindwtr:///someday",
            "filter:cached": "mindwtr:///widget-list/filter%3Acached",
        ]

        for (listId, destination) in expected {
            XCTAssertNil(decoded[listId]?.openUri)
            XCTAssertEqual(
                MindwtrWidgetListNavigation.destination(
                    for: listId,
                    suppliedOpenUri: decoded[listId]?.openUri
                ),
                destination
            )
        }
        XCTAssertEqual(
            MindwtrWidgetListNavigation.destination(
                for: "filter:missing-or-deleted",
                suppliedOpenUri: nil
            ),
            "mindwtr:///widget-list/filter%3Amissing-or-deleted"
        )
    }

    func testListNavigationRejectsMismatchedAndUnsafeSuppliedRoutes() {
        XCTAssertEqual(
            MindwtrWidgetListNavigation.destination(
                for: "inbox",
                suppliedOpenUri: "mindwtr:///waiting"
            ),
            "mindwtr:///inbox"
        )
        XCTAssertEqual(
            MindwtrWidgetListNavigation.destination(
                for: "filter:chosen",
                suppliedOpenUri: "mindwtr:///widget-list/filter%3Aother"
            ),
            "mindwtr:///widget-list/filter%3Achosen"
        )
        for unsafe in [
            "https://example.com/inbox",
            "mindwtr://evil.example/inbox",
            "mindwtr:///widget-list/filter%3Achosen?override=true",
            "mindwtr:///settings",
        ] {
            XCTAssertEqual(
                MindwtrWidgetListNavigation.destination(for: "filter:chosen", suppliedOpenUri: unsafe),
                "mindwtr:///widget-list/filter%3Achosen"
            )
        }
        XCTAssertEqual(
            MindwtrWidgetListNavigation.destination(for: "project:untrusted", suppliedOpenUri: nil),
            "mindwtr:///focus"
        )
        for invalidListId in [
            "filter:",
            "filter:   ",
            "filter:bad\u{0000}id",
            "filter:\(String(repeating: "x", count: 1_025))",
        ] {
            XCTAssertEqual(
                MindwtrWidgetListNavigation.destination(for: invalidListId, suppliedOpenUri: nil),
                "mindwtr:///focus"
            )
        }
        XCTAssertEqual(
            MindwtrWidgetListNavigation.destination(for: "filter:f/1 ?+", suppliedOpenUri: nil),
            "mindwtr:///widget-list/filter%3Af%2F1%20%3F%2B"
        )
    }

    func testClaimIsDurableAndReplayableUntilAcknowledged() throws {
        try withStore { store, directory in
            let now = Date(timeIntervalSince1970: 3_000)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now)
            let firstClaim = try XCTUnwrap(store.claimReady(
                now: now.addingTimeInterval(3)
            ).first)

            let reopened = MindwtrWidgetActionStore(directory: directory)
            let replay = try reopened.claimReady(now: now.addingTimeInterval(30))
            XCTAssertEqual(replay, [firstClaim])

            try reopened.acknowledge(id: firstClaim.id)
            XCTAssertTrue(try reopened.pendingActions().isEmpty)
            try reopened.acknowledge(id: firstClaim.id)

            try reopened.enqueue(taskId: "task-1", token: "revision-1", now: now)
            XCTAssertTrue(try reopened.pendingActions().isEmpty)
        }
    }

    func testReadOnlyProjectionDoesNotRemoveOrClaimQueuedWorkAcrossRestart() throws {
        try withStore { store, directory in
            let now = Date(timeIntervalSince1970: 3_500)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now)
            let action = try XCTUnwrap(store.pendingActions().first)
            let identity = MindwtrWidgetActionIdentity(
                taskId: action.taskId,
                completionToken: action.token
            )

            XCTAssertTrue(MindwtrWidgetActionProjection.isHidden(
                identity,
                by: [action],
                at: now.addingTimeInterval(3)
            ))

            let reopened = MindwtrWidgetActionStore(directory: directory)
            XCTAssertEqual(try reopened.pendingActions(), [action])
            XCTAssertFalse(try XCTUnwrap(reopened.pendingActions().first).claimed)
        }
    }

    func testEnqueueReplayIsANoOpBeforeAndAfterClaim() throws {
        try withStore { store, _ in
            let now = Date(timeIntervalSince1970: 4_000)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now.addingTimeInterval(1))
            XCTAssertEqual(try store.pendingActions().count, 1)

            _ = try store.claimReady(now: now.addingTimeInterval(3))
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now.addingTimeInterval(4))
            XCTAssertEqual(try store.pendingActions().count, 1)
        }
    }

    func testNextReadyAtIncludesPastUnclaimedTimeAndExcludesClaimedActions() throws {
        try withStore { store, _ in
            let first = Date(timeIntervalSince1970: 4_500)
            let second = first.addingTimeInterval(10)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: first)
            try store.enqueue(taskId: "task-2", token: "revision-2", now: second)

            _ = try store.claimReady(now: first.addingTimeInterval(5))

            XCTAssertEqual(try store.nextReadyAt(), 4_513_000)
            XCTAssertEqual(
                try store.claimReady(now: first.addingTimeInterval(12)).map(\.taskId),
                ["task-1"]
            )
            XCTAssertEqual(try store.nextReadyAt(), 4_513_000)
        }
    }

    func testAcknowledgementRejectsUnclaimedAction() throws {
        try withStore { store, _ in
            try store.enqueue(
                taskId: "task-1",
                token: "revision-1",
                now: Date(timeIntervalSince1970: 5_000)
            )
            let id = try XCTUnwrap(store.pendingActions().first).id

            XCTAssertThrowsError(try store.acknowledge(id: id)) { error in
                XCTAssertEqual(
                    error as? MindwtrWidgetActionStoreError,
                    .unclaimedAcknowledgement
                )
            }
            XCTAssertEqual(try store.pendingActions().map(\.id), [id])
        }
    }

    func testConcurrentClaimAndCancelReportTheDurableWinner() throws {
        try withStore { store, _ in
            let now = Date(timeIntervalSince1970: 5_500)
            try store.enqueue(taskId: "task-1", token: "revision-1", now: now)
            let id = try XCTUnwrap(store.pendingActions().first).id
            let queue = DispatchQueue(label: "mindwtr-widget-claim-cancel", attributes: .concurrent)
            let ready = DispatchGroup()
            let finished = DispatchGroup()
            let start = DispatchSemaphore(value: 0)
            let cancelResult = LockedValue<Result<Bool, Error>>()
            let claimResult = LockedValue<Result<[MindwtrWidgetPendingAction], Error>>()

            ready.enter()
            finished.enter()
            queue.async {
                ready.leave()
                start.wait()
                cancelResult.store(Result {
                    try store.cancel(id: id, now: now.addingTimeInterval(2.999))
                })
                finished.leave()
            }

            ready.enter()
            finished.enter()
            queue.async {
                ready.leave()
                start.wait()
                claimResult.store(Result {
                    try store.claimReady(now: now.addingTimeInterval(3))
                })
                finished.leave()
            }

            XCTAssertEqual(ready.wait(timeout: .now() + 5), .success)
            start.signal()
            start.signal()
            XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)

            let didCancel = try XCTUnwrap(cancelResult.load()).get()
            let claimed = try XCTUnwrap(claimResult.load()).get()
            let persisted = try store.pendingActions()
            if didCancel {
                XCTAssertTrue(claimed.isEmpty)
                XCTAssertTrue(persisted.isEmpty)
            } else {
                XCTAssertEqual(claimed.map(\.id), [id])
                XCTAssertEqual(persisted.map(\.id), [id])
                XCTAssertTrue(try XCTUnwrap(persisted.first).claimed)
            }
        }
    }

    func testCorruptStateFailsClosedAndPreservesOriginalBytes() throws {
        try withStore { store, directory in
            let stateURL = directory.appendingPathComponent("mindwtr-widget-actions-v1.json")
            let corrupt = Data("{not-json".utf8)
            try corrupt.write(to: stateURL)

            XCTAssertThrowsError(try store.pendingActions())
            XCTAssertThrowsError(try store.enqueue(taskId: "task-1", token: "revision-1"))
            XCTAssertEqual(try Data(contentsOf: stateURL), corrupt)
        }
    }

    func testPendingCapacityNeverEvictsExistingOperations() throws {
        try withStore { store, _ in
            let now = Date(timeIntervalSince1970: 6_000)
            for index in 0..<MindwtrWidgetActionStore.maximumPendingActions {
                try store.enqueue(taskId: "task-\(index)", token: "revision-\(index)", now: now)
            }

            XCTAssertThrowsError(
                try store.enqueue(taskId: "overflow", token: "overflow", now: now)
            ) { error in
                XCTAssertEqual(error as? MindwtrWidgetActionStoreError, .capacityFull)
            }
            XCTAssertEqual(
                try store.pendingActions().count,
                MindwtrWidgetActionStore.maximumPendingActions
            )
        }
    }

    func testConcurrentStoreInstancesDoNotLoseReadModifyWriteOperations() throws {
        try withStore { firstStore, directory in
            let secondStore = MindwtrWidgetActionStore(directory: directory)
            let queue = DispatchQueue(label: "mindwtr-widget-action-test", attributes: .concurrent)
            let group = DispatchGroup()
            let errors = LockedErrors()
            let now = Date(timeIntervalSince1970: 7_000)

            for index in 0..<64 {
                group.enter()
                queue.async {
                    defer { group.leave() }
                    do {
                        let store = index.isMultiple(of: 2) ? firstStore : secondStore
                        try store.enqueue(
                            taskId: "task-\(index)",
                            token: "revision-\(index)",
                            now: now
                        )
                    } catch {
                        errors.append(error)
                    }
                }
            }

            XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
            XCTAssertEqual(errors.count, 0)
            XCTAssertEqual(try firstStore.pendingActions().count, 64)
        }
    }

    func testNativeClaimKeepsOriginalUppercaseIDDelayedUndoAndReceipts() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            let pending = nativePending(id: id, notBefore: 1_010_000)
            let receipt: [String: Any] = ["taskId": "already-consumed", "token": "older-token", "consumedAt": 900_000.0]
            let bytes = try writeNativeState(["version": 1, "pending": [pending], "receipts": [receipt]], directory)
            let early = try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_003)) { actions in
                XCTAssertEqual(actions.map(\.id), [id]); XCTAssertFalse(actions[0].claimed)
            }
            XCTAssertTrue(early.isEmpty)
            XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            XCTAssertFalse(try store.cancel(id: id, now: Date(timeIntervalSince1970: 1_010)))
            let claimed = try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in }
            XCTAssertEqual(claimed.map(\.id), [id]); XCTAssertTrue(try XCTUnwrap(claimed.first).claimed)
            let cold = MindwtrWidgetActionStore(directory: directory)
            XCTAssertEqual(try cold.claimReadyForNative(now: Date(timeIntervalSince1970: 1_011)) { _ in }, claimed)
            try cold.acknowledge(id: id.lowercased())
            XCTAssertEqual(try cold.pendingActions().map(\.id), [id])
            try cold.acknowledge(id: id)
            XCTAssertTrue(try cold.pendingActions().isEmpty)
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json"))) as? [String: Any])
            let receipts = try XCTUnwrap(state["receipts"] as? [[String: Any]])
            XCTAssertEqual(receipts.count, 2)
            XCTAssertEqual(receipts[0] as NSDictionary, receipt as NSDictionary)
            XCTAssertEqual(receipts[1]["taskId"] as? String, "native-task")
            XCTAssertEqual(receipts[1]["token"] as? String, "native-token")
        }
    }

    func testNativeClaimRefusesMalformedUUIDWithoutAdmissionOrByteMutation() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            for invalid in ["invalid", " " + id, id + "x", "{" + id + "}"] {
                let bytes = try writeNativeState(["version": 1, "pending": [nativePending(id: invalid)], "receipts": []], directory)
                var admitted = false
                XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in admitted = true })
                XCTAssertFalse(admitted)
                XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            }
        }
    }

    func testNativeClaimRefusesCaseCollidingIDsIncludingUnreadyRowsWithoutMutation() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            var later = nativePending(id: id.lowercased(), notBefore: 1_100_000)
            later["taskId"] = "other-task"; later["token"] = "other-token"
            let bytes = try writeNativeState(["version": 1, "pending": [nativePending(id: id), later], "receipts": []], directory)
            var admitted = false
            XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in admitted = true })
            XCTAssertFalse(admitted)
            XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            XCTAssertEqual(try store.pendingActions().map(\.claimed), [false, false])
        }
    }

    func testNativeClaimRefusesUnsupportedRootPendingAndReceiptShapesWithoutMutation() throws {
        try withStore { store, directory in
            let pending = nativePending(id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")
            var extraPending = pending; extraPending["future"] = "preserve"
            let receipt: [String: Any] = ["taskId": "earlier", "token": "earlier-token", "consumedAt": 900_000]
            var extraReceipt = receipt; extraReceipt["future"] = false
            var missingPending = pending; missingPending.removeValue(forKey: "claimed")
            let invalid: [Any] = [
                ["version": 1, "pending": [pending], "receipts": [], "future": ["opaque": true]],
                ["version": 1, "pending": [extraPending], "receipts": []],
                ["version": 1, "pending": [pending], "receipts": [extraReceipt]],
                ["version": 1, "pending": [missingPending], "receipts": []],
                ["version": 1, "pending": [pending], "receipts": ["unsupported"]],
                ["version": 2, "pending": [pending], "receipts": []],
                ["version": true, "pending": [pending], "receipts": []],
                ["version": 1, "pending": [NSNull()], "receipts": []],
                ["version": 1, "pending": [pending]],
                ["version", "pending", "receipts"]]
            for value in invalid {
                let bytes = try writeNativeState(value, directory)
                var admitted = false
                XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in admitted = true })
                XCTAssertFalse(admitted)
                XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            }
        }
    }

    func testNativeAdmissionFailurePreservesEveryOriginalClaimFlagAndByte() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            let bytes = try writeNativeState(["version": 1, "pending": [nativePending(id: id)], "receipts": []], directory)
            var admitted = false
            XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { actions in
                admitted = true
                XCTAssertEqual(actions.map(\.id), [id]); XCTAssertFalse(actions[0].claimed)
                throw MindwtrWidgetActionStoreError.invalidValue("synthetic admission")
            })
            XCTAssertTrue(admitted)
            XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            XCTAssertEqual(try store.pendingActions().map(\.claimed), [false])
        }
    }

    func testNativeAdmissionHoldsExistingStoreLockUntilClaimFinishes() throws {
        try withStore { store, directory in
            let now = Date(timeIntervalSince1970: 1_000)
            try store.enqueue(taskId: "first", token: "first-token", now: now)
            let other = MindwtrWidgetActionStore(directory: directory)
            let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
            let enqueueStarted = DispatchSemaphore(value: 0), enqueueFinished = DispatchSemaphore(value: 0)
            let group = DispatchGroup(), errors = LockedErrors()
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    _ = try store.claimReadyForNative(now: now.addingTimeInterval(3)) { _ in
                        entered.signal()
                        guard release.wait(timeout: .now() + 10) == .success else {
                            throw MindwtrWidgetActionStoreError.corruptState("synthetic admission timeout")
                        }
                    }
                } catch { errors.append(error) }
            }
            XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave(); enqueueFinished.signal() }
                enqueueStarted.signal()
                do { try other.enqueue(taskId: "second", token: "second-token", now: now) }
                catch { errors.append(error) }
            }
            XCTAssertEqual(enqueueStarted.wait(timeout: .now() + 5), .success)
            let whileAdmitting = enqueueFinished.wait(timeout: .now() + 0.05)
            release.signal()
            XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
            XCTAssertEqual(whileAdmitting, .timedOut)
            XCTAssertEqual(errors.count, 0)
            let pending = try store.pendingActions()
            XCTAssertEqual(pending.map(\.taskId), ["first", "second"])
            XCTAssertEqual(pending.map(\.claimed), [true, false])
        }
    }

    func testOrdinaryRNClaimKeepsItsExistingDecodingAndIDBehavior() throws {
        try withStore { store, directory in
            var pending = nativePending(id: "legacy-non-uuid")
            pending["future"] = "ordinary decoding"
            let bytes = try writeNativeState(["version": 1, "pending": [pending], "receipts": [], "future": true], directory)
            XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in })
            XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            let claimed = try store.claimReady(now: Date(timeIntervalSince1970: 1_010))
            XCTAssertEqual(claimed.map(\.id), ["legacy-non-uuid"])
            XCTAssertTrue(try XCTUnwrap(claimed.first).claimed)
        }
    }

    func testNativeClaimRefusesDuplicateRootMembersBeforeEitherDecoderCollapses() throws {
        try withStore { store, directory in
            let row = try rawNativeRow()
            var unsupported = nativePending(id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF")
            unsupported["future"] = true
            let futureRow = String(decoding: try JSONSerialization.data(withJSONObject: unsupported, options: [.sortedKeys]), as: UTF8.self)
            let receipt = #"{"taskId":"earlier","token":"earlier-token","consumedAt":900000}"#
            let futureReceipt = #"{"taskId":"earlier","token":"earlier-token","consumedAt":900000,"future":true}"#
            let values = [
                #"{"version":1,"version":1,"pending":[\#(row)],"receipts":[]}"#,
                #"{"version":1,"pending":[\#(row)],"pending":[\#(row)],"receipts":[]}"#,
                #"{"version":1,"pending":[\#(row)],"\u0070ending":[\#(row)],"receipts":[]}"#,
                #"{"version":1,"pending":[\#(futureRow)],"pending":[\#(row)],"receipts":[]}"#,
                #"{"version":1,"pending":[\#(futureRow)],"\u0070ending":[\#(row)],"receipts":[]}"#,
                #"{"version":1,"pending":[\#(row)],"receipts":[\#(futureReceipt)],"receipts":[\#(receipt)]}"#,
                #"{"version":1,"pending":[\#(row)],"receipts":[\#(futureReceipt)],"\u0072eceipts":[\#(receipt)]}"#]
            for raw in values { try assertNativeRawRefused(Data((" \n" + raw + "\n ").utf8), store, directory) }
        }
    }

    func testNativeClaimRefusesDuplicatePendingRowMembersIncludingEscapedAliases() throws {
        try withStore { store, directory in
            let row = try rawNativeRow()
            let duplicateRows = [
                #"{"id":"ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",\#(row.dropFirst())"#,
                #"{"\u0069d":"ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",\#(row.dropFirst())"#,
                #"{"\u0074askId":"native-task",\#(row.dropFirst())"#]
            for duplicate in duplicateRows {
                let raw = #"{"version":1,"pending":[\#(duplicate)],"receipts":[]}"#
                try assertNativeRawRefused(Data((" \n" + raw + "\n ").utf8), store, directory)
            }
        }
    }

    func testNativeClaimRefusesDuplicateReceiptRowMembersIncludingEscapedAliases() throws {
        try withStore { store, directory in
            let row = try rawNativeRow()
            let receipts = [
                #"{"taskId":"earlier","token":"earlier-token","token":"earlier-token","consumedAt":900000}"#,
                #"{"taskId":"earlier","token":"earlier-token","\u0074oken":"earlier-token","consumedAt":900000}"#,
                #"{"taskId":"earlier","token":"earlier-token","consumedAt":900000,"\u0063onsumedAt":900000}"#]
            for receipt in receipts {
                let raw = #"{"version":1,"pending":[\#(row)],"receipts":[\#(receipt)]}"#
                try assertNativeRawRefused(Data((" \n" + raw + "\n ").utf8), store, directory)
            }
        }
    }

    func testNativeClaimRefusesAlternateEncodingRawNULAndEscapedNULMember() throws {
        try withStore { store, directory in
            let row = try rawNativeRow()
            let raw = #"{"version":1,"pending":[\#(row)],"receipts":[]}"#
            for encoding in [String.Encoding.utf16LittleEndian, .utf16BigEndian, .utf32LittleEndian, .utf32BigEndian] {
                try assertNativeRawRefused(XCTUnwrap(raw.data(using: encoding)), store, directory)
            }
            try assertNativeRawRefused(Data((raw + "\u{0000}").utf8), store, directory)
            let nulMember = #"{"version":1,"pending":[\#(row)],"receipts":[],"\u0000":true}"#
            try assertNativeRawRefused(Data(nulMember.utf8), store, directory)
            let bomMember = #"{"version":1,"pending":[\#(row)],"receipts":[],"\uFEFFpending":[]}"#
            try assertNativeRawRefused(Data(bomMember.utf8), store, directory)
        }
    }

    func testNativeAcknowledgmentKeepsOriginalCaseAndIsIdempotentWhenAbsent() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            _ = try writeNativeState(["version": 1, "pending": [nativePending(id: id)], "receipts": []], directory)
            let expected = try XCTUnwrap(store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in }.first)
            var admitted = 0
            try store.acknowledgeForNative(expected) { admitted += 1 }
            XCTAssertEqual(admitted, 1); XCTAssertTrue(try store.pendingActions().isEmpty)
            let path = directory.appendingPathComponent("mindwtr-widget-actions-v1.json"), bytes = try Data(contentsOf: path)
            try store.acknowledgeForNative(expected) { admitted += 1 }
            XCTAssertEqual(admitted, 1); XCTAssertEqual(try Data(contentsOf: path), bytes)
        }
    }

    func testNativeAcknowledgmentRefusesChangedOriginalTupleWithoutMutation() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            var pending = nativePending(id: id)
            pending["taskId"] = "e\u{301}"
            _ = try writeNativeState(["version": 1, "pending": [pending], "receipts": []], directory)
            let expected = try XCTUnwrap(store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in }.first)
            pending["claimed"] = true
            let edits: [[String: Any]] = [["id": id.lowercased()], ["taskId": "é"], ["token": "native-token "],
                ["createdAt": 999_999.0], ["notBefore": 1_004_000.0], ["claimed": false]]
            for edit in edits {
                var changed = pending; changed.merge(edit) { _, new in new }
                let bytes = try writeNativeState(["version": 1, "pending": [changed], "receipts": []], directory)
                var admitted = false
                XCTAssertThrowsError(try store.acknowledgeForNative(expected) { admitted = true })
                XCTAssertFalse(admitted)
                XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            }
        }
    }

    func testNativeAcknowledgmentRefusesNewUnknownFieldsAndNormalizedCollision() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            var pending = nativePending(id: id)
            _ = try writeNativeState(["version": 1, "pending": [pending], "receipts": []], directory)
            let expected = try XCTUnwrap(store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in }.first)
            pending["claimed"] = true
            var extra = pending; extra["future"] = true
            var colliding = pending; colliding["id"] = id.lowercased(); colliding["taskId"] = "other"; colliding["token"] = "other-token"
            let states: [[String: Any]] = [["version": 1, "pending": [pending], "receipts": [], "future": true],
                ["version": 1, "pending": [extra], "receipts": []],
                ["version": 1, "pending": [pending, colliding], "receipts": []]]
            for state in states {
                let bytes = try writeNativeState(state, directory)
                var admitted = false
                XCTAssertThrowsError(try store.acknowledgeForNative(expected) { admitted = true })
                XCTAssertFalse(admitted)
                XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("mindwtr-widget-actions-v1.json")), bytes)
            }
        }
    }

    func testNativeAcknowledgmentReadmissionFailureRetainsClaimedBytes() throws {
        try withStore { store, directory in
            let id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
            _ = try writeNativeState(["version": 1, "pending": [nativePending(id: id)], "receipts": []], directory)
            let expected = try XCTUnwrap(store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in }.first)
            let path = directory.appendingPathComponent("mindwtr-widget-actions-v1.json"), bytes = try Data(contentsOf: path)
            var admitted = false
            XCTAssertThrowsError(try store.acknowledgeForNative(expected) {
                admitted = true
                throw MindwtrWidgetActionStoreError.invalidValue("synthetic native acknowledgment admission")
            })
            XCTAssertTrue(admitted); XCTAssertEqual(try Data(contentsOf: path), bytes)
            XCTAssertEqual(try store.pendingActions(), [expected])
        }
    }

    private func rawNativeRow() throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: nativePending(id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"), options: [.sortedKeys]), as: UTF8.self)
    }

    private func assertNativeRawRefused(_ bytes: Data, _ store: MindwtrWidgetActionStore, _ directory: URL,
                                        file: StaticString = #filePath, line: UInt = #line) throws {
        let path = directory.appendingPathComponent("mindwtr-widget-actions-v1.json")
        try bytes.write(to: path)
        var admitted = false
        XCTAssertThrowsError(try store.claimReadyForNative(now: Date(timeIntervalSince1970: 1_010)) { _ in admitted = true }, file: file, line: line)
        XCTAssertFalse(admitted, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: path), bytes, file: file, line: line)
    }

    private func nativePending(id: String, notBefore: Double = 1_003_000) -> [String: Any] {
        ["id": id, "taskId": "native-task", "token": "native-token", "createdAt": 1_000_000.0,
         "notBefore": notBefore, "claimed": false]
    }

    private func writeNativeState(_ value: Any, _ directory: URL) throws -> Data {
        var bytes = Data(" \n".utf8)
        bytes.append(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
        bytes.append(Data("\n ".utf8))
        try bytes.write(to: directory.appendingPathComponent("mindwtr-widget-actions-v1.json"))
        return bytes
    }

    private func withStore(
        _ body: (MindwtrWidgetActionStore, URL) throws -> Void
    ) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("mindwtr-widget-action-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(MindwtrWidgetActionStore(directory: directory), directory)
    }

    private func pendingAction(
        taskId: String,
        token: String,
        start: Date
    ) -> MindwtrWidgetPendingAction {
        let createdAt = start.timeIntervalSince1970 * 1_000.0
        return MindwtrWidgetPendingAction(
            id: "action-\(taskId)-\(token)",
            taskId: taskId,
            token: token,
            createdAt: createdAt,
            notBefore: createdAt + MindwtrWidgetActionStore.minimumUndoDelayMilliseconds,
            claimed: false
        )
    }
}
