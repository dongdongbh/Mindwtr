import Foundation
import CloudKitAttachmentErrorClassifier

/// One foreground owner's CloudKit calls. Retirement waits for SDK callbacks before releasing the library.
final class NativeCloudKitJobs: @unchecked Sendable {
    static let maximumBytes = 16 * 1024 * 1024
    private let condition = NSCondition()
    private let registry: NativeAttachmentLocalRequests
    private let registryID = UUID()
    private let cancellation = NativeAttachmentCancellation()
    private let perform: @Sendable (String) async throws -> String
    private let cancel: @Sendable () async -> Void
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var accepting = true
    private var cancellationFinished = false
    private var job: Job?

    private final class Job {
        let id: String
        var answer: String?
        init(id: String) { self.id = id }
    }

    init(registry: NativeAttachmentLocalRequests,
         perform: @escaping @Sendable (String) async throws -> String,
         cancel: @escaping @Sendable () async -> Void) {
        self.registry = registry; self.perform = perform; self.cancel = cancel
        cancellation.setCancellationHandler { [weak self] in self?.retire() }
        registry.register(cancellation, id: registryID)
    }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= Self.maximumBytes,
              (try? NativeJSON.hasUniqueObjectKeys(json)) == true,
              (try? NativeJSON.jsonObject(with: Data(json.utf8))) is [String: Any] else {
            throw HostFailure("CloudKit request is invalid")
        }
        condition.lock()
        guard accepting, !cancellation.isCancelled, !registry.isClosing, job == nil, sequence < UInt64.max else {
            condition.unlock(); throw HostFailure("CloudKit bridge is unavailable")
        }
        sequence += 1
        let current = Job(id: "ck:\(generation):\(sequence)")
        job = current
        condition.unlock()
        Task { [self] in
            var answer: [String: Any]
            do {
                try cancellation.check()
                let result = try await perform(json)
                try cancellation.check()
                guard result.utf8.count <= Self.maximumBytes,
                      (try? NativeJSON.jsonObject(with: Data(result.utf8), options: [.fragmentsAllowed])) != nil else {
                    throw HostFailure("CloudKit reply is invalid")
                }
                answer = ["id": current.id, "value": result]
            } catch {
                // SDK errors can contain private record names and account details.
                answer = ["id": current.id, "error": cancellation.isCancelled
                    ? "CloudKit operation was cancelled" : "CloudKit operation failed"]
                if !cancellation.isCancelled, let failure = error as? NativeCloudKitTransportError {
                    answer["code"] = failure.code.rawValue
                    if let retry = failure.retryAfterSeconds { answer["retryAfterSeconds"] = retry }
                }
            }
            let encoded = String(decoding: try! JSONSerialization.data(withJSONObject: answer), as: UTF8.self)
            finish(current, answer: encoded)
        }
        return current.id
    }

    private func finish(_ current: Job, answer: String) {
        condition.lock(); current.answer = answer; condition.broadcast(); condition.unlock()
    }

    func next() -> String? {
        condition.lock(); defer { condition.unlock() }
        guard let current = job, let answer = current.answer else { return nil }
        job = nil
        return answer
    }

    func abort(_ id: String) {
        condition.lock(); let matches = job?.id == id; condition.unlock()
        if matches { cancellation.cancel() }
    }

    private func retire() {
        condition.lock()
        guard accepting else { condition.unlock(); return }
        accepting = false
        condition.unlock()
        Task { [self] in
            await cancel()
            finishCancellation()
        }
    }

    private func finishCancellation() {
        condition.lock(); cancellationFinished = true; condition.broadcast(); condition.unlock()
    }

    func closeAndDrain() {
        cancellation.cancel()
        condition.lock()
        while !cancellationFinished || (job != nil && job?.answer == nil) { condition.wait() }
        condition.unlock()
        registry.remove(registryID)
    }
}
