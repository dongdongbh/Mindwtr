import XCTest
@testable import MindwtrAppleTaskSearchCollector

final class MindwtrAppleTaskSearchCollectorTests: XCTestCase {
    func testCancelBeforeRegistrationTombstoneIsConsumedOnceAndBounded() {
        var tombstones = MindwtrAppleTaskSearchCancellationTombstones<String>(limit: 2)
        tombstones.insert("cancel-before-start")
        XCTAssertTrue(tombstones.consume("cancel-before-start"))
        XCTAssertFalse(tombstones.consume("cancel-before-start"))

        tombstones.insert("oldest")
        tombstones.insert("middle")
        tombstones.insert("newest")
        XCTAssertEqual(tombstones.count, 2)
        XCTAssertFalse(tombstones.consume("oldest"))
        XCTAssertTrue(tombstones.consume("middle"))
        XCTAssertTrue(tombstones.consume("newest"))
    }

    func testPartialTokenBetweenPollAndFinishPreventsStaleClose() async {
        let collector = MindwtrAppleTaskSearchResultCollector<String>()
        await collector.record(
            queryToken: "first",
            replyItems: [MindwtrAppleTaskSearchReference(indexedId: "index-1", taskId: "task-1")],
            isComplete: true
        )
        let polledState = await collector.drainState()
        XCTAssertTrue(polledState.allObservedQueriesComplete)


        await collector.record(
            queryToken: "second",
            replyItems: [MindwtrAppleTaskSearchReference(indexedId: "index-2", taskId: "task-2")],
            isComplete: false
        )

        let staleFinish = await collector.finishIfCompleteAndUnchanged(
            expectedRevision: polledState.revision
        )
        XCTAssertNil(staleFinish)
        let partialState = await collector.drainState()
        XCTAssertFalse(partialState.allObservedQueriesComplete)

        await collector.record(queryToken: "second", replyItems: [], isComplete: true)
        let completedState = await collector.drainState()
        let results = await collector.finishIfCompleteAndUnchanged(
            expectedRevision: completedState.revision
        )
        XCTAssertEqual(results, [
            ["indexedId": "index-1", "taskId": "task-1"],
            ["indexedId": "index-2", "taskId": "task-2"],
        ])
    }

    func testCollectorDeduplicatesAndCapsStableTaskIds() async {
        let collector = MindwtrAppleTaskSearchResultCollector<String>()
        let references = (0..<60).map { index in
            MindwtrAppleTaskSearchReference(
                indexedId: "index-\(index)",
                taskId: "task-\(index)"
            )
        } + [MindwtrAppleTaskSearchReference(indexedId: "duplicate", taskId: "task-1")]

        await collector.record(queryToken: "only", replyItems: references, isComplete: true)
        let state = await collector.drainState()
        let results = await collector.finishIfCompleteAndUnchanged(expectedRevision: state.revision)

        XCTAssertEqual(results?.count, 50)
        XCTAssertEqual(Set(results?.compactMap { $0["taskId"] } ?? []).count, 50)
    }
}
