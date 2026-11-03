import Foundation

enum AppleClarificationReservation<Value> {
    case reserved(token: UUID, value: Value)
    case duplicate
    case cancelledBeforeReservation
}


final class AppleClarificationRequestRegistry<Value>: @unchecked Sendable {
    private struct Entry {
        let token: UUID
        let value: Value
    }

    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var pendingCancellationIds: Set<String> = []
    private var pendingCancellationOrder: [String] = []
    private let maxPendingCancellationCount: Int

    init(maxPendingCancellationCount: Int = 128) {
        self.maxPendingCancellationCount = max(1, maxPendingCancellationCount)
    }


    func reserve(
        for requestId: String,
        createValue: () -> Value
    ) -> AppleClarificationReservation<Value> {
        lock.lock()
        defer { lock.unlock() }

        if pendingCancellationIds.remove(requestId) != nil {
            pendingCancellationOrder.removeAll { $0 == requestId }
            return .cancelledBeforeReservation
        }
        guard entries[requestId] == nil else { return .duplicate }

        let token = UUID()
        let value = createValue()
        entries[requestId] = Entry(token: token, value: value)
        return .reserved(token: token, value: value)
    }

    func value(for requestId: String) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return entries[requestId]?.value
    }


    func cancel(_ requestId: String) -> Value? {
        lock.lock()
        defer { lock.unlock() }

        if let value = entries[requestId]?.value {
            return value
        }
        guard !pendingCancellationIds.contains(requestId) else { return nil }
        pendingCancellationIds.insert(requestId)
        pendingCancellationOrder.append(requestId)
        if pendingCancellationOrder.count > maxPendingCancellationCount {
            let evicted = pendingCancellationOrder.removeFirst()
            pendingCancellationIds.remove(evicted)
        }
        return nil
    }

    @discardableResult
    func remove(_ requestId: String, token: UUID) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        guard entries[requestId]?.token == token else { return nil }
        return entries.removeValue(forKey: requestId)?.value
    }

    func removeAll() -> [Value] {
        lock.lock()
        defer { lock.unlock() }
        let values = entries.values.map(\.value)
        entries.removeAll()
        pendingCancellationIds.removeAll()
        pendingCancellationOrder.removeAll()
        return values
    }
}
