import Foundation


actor AppleImageAnalysisCoordinator<Output: Sendable> {
    private var operations: [String: (token: UUID, task: Task<Output, Error>)] = [:]
    private var pendingCancellations: [String] = []
    private var closed = false
    private let pendingCancellationLimit = 128

    func analyze(
        operationId: String,
        operation: @escaping @Sendable () async throws -> Output
    ) async throws -> Output {
        guard !closed else { throw AppleImageCaptureError.cancelled }
        guard operationId.range(of: "^[0-9a-fA-F-]{36}$", options: .regularExpression) != nil,
              operations[operationId] == nil else {
            throw AppleImageCaptureError.invalidOperation
        }
        if let pendingIndex = pendingCancellations.firstIndex(of: operationId) {
            pendingCancellations.remove(at: pendingIndex)
            throw AppleImageCaptureError.cancelled
        }
        let token = UUID()
        let task = Task.detached(priority: .userInitiated, operation: operation)
        operations[operationId] = (token, task)
        defer {
            if operations[operationId]?.token == token {
                operations.removeValue(forKey: operationId)
            }
        }
        do {
            return try await task.value
        } catch is CancellationError {
            throw AppleImageCaptureError.cancelled
        }
    }

    func cancel(operationId: String) {
        if let operation = operations[operationId] {
            operation.task.cancel()
        } else if !pendingCancellations.contains(operationId) {
            pendingCancellations.append(operationId)
            if pendingCancellations.count > pendingCancellationLimit {
                pendingCancellations.removeFirst()
            }
        }
    }

    func cancelAll() {
        closed = true
        operations.values.forEach { $0.task.cancel() }


    }
}
