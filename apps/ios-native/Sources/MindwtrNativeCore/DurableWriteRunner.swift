import Foundation

public protocol DurableWriteTransport: AnyObject {
    func retryPending() async throws -> String?
}

extension CoreHost: DurableWriteTransport {}

public struct DurableWriteModel {
    public let isBusy: @MainActor () -> Bool
    public let begin: @MainActor () -> Void
    public let finish: @MainActor () -> Void
    public let setRetryNeeded: @MainActor (_ needed: Bool, _ error: String?) -> Void
    public let isDefiniteRejection: @MainActor (Error) -> Bool

    public init(isBusy: @escaping @MainActor () -> Bool, begin: @escaping @MainActor () -> Void,
                finish: @escaping @MainActor () -> Void,
                setRetryNeeded: @escaping @MainActor (_ needed: Bool, _ error: String?) -> Void,
                isDefiniteRejection: @escaping @MainActor (Error) -> Bool) {
        self.isBusy = isBusy
        self.begin = begin
        self.finish = finish
        self.setRetryNeeded = setRetryNeeded
        self.isDefiniteRejection = isDefiniteRejection
    }
}

@MainActor
public final class DurableWriteRunner<Transport: DurableWriteTransport> {
    public struct Pending {
        public let request: String
        public let transport: Transport
    }

    public struct Write {
        public let admit: @MainActor (Transport) -> Bool
        public let dispatch: @MainActor (Transport, _ request: String, _ operation: UUID) async throws -> String
        public let retryOutcome: @MainActor (Transport, _ request: String) async throws -> String
        public let acknowledge: @MainActor (_ reply: String) throws -> Void
        public let fail: @MainActor (Error, _ definite: Bool) -> String
        public let refresh: @MainActor (_ acknowledged: Bool) async -> Void
        public let ended: @MainActor (_ operation: UUID) -> Void

        public init(admit: @escaping @MainActor (Transport) -> Bool,
                    dispatch: @escaping @MainActor (Transport, _ request: String, _ operation: UUID) async throws -> String,
                    retryOutcome: @escaping @MainActor (Transport, _ request: String) async throws -> String,
                    acknowledge: @escaping @MainActor (_ reply: String) throws -> Void,
                    fail: @escaping @MainActor (Error, _ definite: Bool) -> String,
                    refresh: @escaping @MainActor (_ acknowledged: Bool) async -> Void,
                    ended: @escaping @MainActor (_ operation: UUID) -> Void) {
            self.admit = admit
            self.dispatch = dispatch
            self.retryOutcome = retryOutcome
            self.acknowledge = acknowledge
            self.fail = fail
            self.refresh = refresh
            self.ended = ended
        }
    }

    public private(set) var pending: Pending?
    public private(set) var operation: UUID?
    public private(set) var task: Task<Void, Never>?
    private let model: DurableWriteModel

    public init(model: DurableWriteModel) { self.model = model }

    public func stage(_ request: String, on transport: Transport) {
        pending = Pending(request: request, transport: transport)
    }

    @discardableResult
    public func run(retry: Bool, _ write: Write) -> Bool {
        guard !model.isBusy(), operation == nil, let pending, write.admit(pending.transport) else { return false }
        let id = UUID()
        operation = id
        model.begin()
        task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.operation == id {
                    self.operation = nil
                    self.task = nil
                    write.ended(id)
                    self.model.finish()
                }
            }
            await self.perform(pending, retry: retry, operation: id, write)
        }
        return true
    }

    private func perform(_ attempt: Pending, retry: Bool, operation id: UUID, _ write: Write) async {
        do {
            let reply: String
            if retry {
                if let acknowledged = try await attempt.transport.retryPending() { reply = acknowledged }
                else { reply = try await write.retryOutcome(attempt.transport, attempt.request) }
            } else {
                reply = try await write.dispatch(attempt.transport, attempt.request, id)
            }
            guard holds(attempt) else { throw CocoaError(.coderReadCorrupt) }
            try write.acknowledge(reply)
            pending = nil
            model.setRetryNeeded(false, nil)
            if !Task.isCancelled { await write.refresh(true) }
        } catch {
            guard holds(attempt) else { return }
            let definite = model.isDefiniteRejection(error)
            let message = write.fail(error, definite)
            if definite {
                pending = nil
                model.setRetryNeeded(false, nil)
                if !Task.isCancelled { await write.refresh(false) }
            } else {
                model.setRetryNeeded(true, message)
            }
        }
    }

    private func holds(_ attempt: Pending) -> Bool {
        pending?.request == attempt.request && pending?.transport === attempt.transport
    }
}
