import Foundation

struct MindwtrAppleTaskSearchCancellationTombstones<RequestID: Hashable> {
    private let limit: Int
    private var ids = Set<RequestID>()
    private var insertionOrder: [RequestID] = []

    init(limit: Int = 64) {
        self.limit = max(1, limit)
    }

    var count: Int { ids.count }

    mutating func insert(_ requestId: RequestID) {
        guard ids.insert(requestId).inserted else { return }
        insertionOrder.append(requestId)
        while insertionOrder.count > limit {
            ids.remove(insertionOrder.removeFirst())
        }
    }

    mutating func consume(_ requestId: RequestID) -> Bool {
        guard ids.remove(requestId) != nil else { return false }
        insertionOrder.removeAll { $0 == requestId }
        return true
    }
}

struct MindwtrAppleTaskSearchReference: Sendable, Equatable {
    let indexedId: String
    let taskId: String
}

struct MindwtrAppleTaskSearchDrainState: Sendable, Equatable {
    let revision: Int
    let allObservedQueriesComplete: Bool
}

actor MindwtrAppleTaskSearchResultCollector<QueryToken: Hashable & Sendable> {
    private static var resultLimit: Int { 50 }

    private var acceptingResults = true
    private var seenTaskIds = Set<String>()
    private var results: [[String: String]] = []
    private var revision = 0
    private var observedQueryTokens = Set<QueryToken>()
    private var completedQueryTokens = Set<QueryToken>()

    private var allObservedQueriesComplete: Bool {
        !observedQueryTokens.isEmpty
            && completedQueryTokens.isSuperset(of: observedQueryTokens)
    }

    func record(
        queryToken: QueryToken,
        replyItems: [MindwtrAppleTaskSearchReference],
        isComplete: Bool
    ) {
        guard acceptingResults else { return }
        revision += 1
        observedQueryTokens.insert(queryToken)
        if isComplete {
            completedQueryTokens.insert(queryToken)
        }

        for item in replyItems {
            guard results.count < Self.resultLimit else { break }
            guard seenTaskIds.insert(item.taskId).inserted else { continue }
            results.append(["indexedId": item.indexedId, "taskId": item.taskId])
        }
    }

    func drainState() -> MindwtrAppleTaskSearchDrainState {
        MindwtrAppleTaskSearchDrainState(
            revision: revision,
            allObservedQueriesComplete: allObservedQueriesComplete
        )
    }


    func finishIfCompleteAndUnchanged(expectedRevision: Int) -> [[String: String]]? {
        guard acceptingResults,
              revision == expectedRevision,
              allObservedQueriesComplete else {
            return nil
        }
        acceptingResults = false
        return results
    }

    func close() {
        acceptingResults = false
    }
}
