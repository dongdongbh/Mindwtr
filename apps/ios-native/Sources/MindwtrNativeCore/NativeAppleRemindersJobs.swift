import Foundation

/// Private serial tickets; an accepted SDK mutation retains ownership through its return.
final class NativeAppleRemindersJobs: @unchecked Sendable {
    static let maximumRequestBytes = NativeCalendarJobs.maximumRequestBytes
    static let maximumReplyBytes = NativeCalendarJobs.maximumReplyBytes
    struct Reply: Sendable { let json: String; let completed: Bool }
    private enum Request {
        case permission, requestPermission, lists, read(NativeAppleReminderListIdentity)
        case remove(NativeAppleReminderListIdentity, NativeAppleReminderSourceDTO)
    }
    private final class Job {
        let id: String, registryID: UUID, token: NativeAttachmentCancellation, request: Request
        var handle: UUID?, answered = false, succeeded = false, answer = ""
        init(id: String, registryID: UUID, token: NativeAttachmentCancellation, request: Request) {
            self.id = id; self.registryID = registryID; self.token = token; self.request = request
        }
    }
    private let lock = NSLock()
    private let worker = DispatchQueue(label: "tech.dongdongbh.mindwtr.apple-reminders")
    private let registry: NativeAttachmentLocalRequests
    private let providerFactory: () -> NativeAppleRemindersProvider
    private var provider: NativeAppleRemindersProvider?
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0, accepting = true
    private var jobs: [String: Job] = [:], queued: [Job] = [], ready: [Job] = []
    private var active: Job?
    private var wake: (() -> Void)?
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(registry: NativeAttachmentLocalRequests, providerFactory: @escaping () -> NativeAppleRemindersProvider = { .init() }) {
        self.registry = registry; self.providerFactory = providerFactory
    }
    func setWake(_ callback: (() -> Void)?) { lock.lock(); if accepting { wake = callback }; lock.unlock() }
    private func parse(_ json: String) throws -> Request {
        do {
            guard json.utf8.count <= Self.maximumRequestBytes, try NativeJSON.hasUniqueObjectKeys(json),
                  let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
                  let operation = value["op"] as? String else { throw NativeAppleRemindersError.invalid }
            switch operation {
            case "permission", "requestPermission", "lists":
                guard Set(value.keys) == ["op"] else { throw NativeAppleRemindersError.invalid }
                return operation == "permission" ? .permission : operation == "lists" ? .lists : .requestPermission
            case "read":
                guard Set(value.keys) == ["op", "listId", "sourceId"],
                      let id = value["listId"] as? String, let sourceID = value["sourceId"] as? String else {
                    throw NativeAppleRemindersError.invalid
                }
                let identity = NativeAppleReminderListIdentity(id: id, sourceID: sourceID)
                try NativeAppleRemindersValidation.identity(identity); return .read(identity)
            case "remove":
                guard Set(value.keys) == ["op", "listId", "sourceId", "source"],
                      let id = value["listId"] as? String, let sourceID = value["sourceId"] as? String,
                      let row = value["source"] as? [String: Any] else { throw NativeAppleRemindersError.invalid }
                let identity = NativeAppleReminderListIdentity(id: id, sourceID: sourceID)
                let source = try NativeAppleRemindersValidation.source(row)
                try NativeAppleRemindersValidation.identity(identity); try NativeAppleRemindersValidation.removal(source)
                return .remove(identity, source)
            default: throw NativeAppleRemindersError.invalid
            }
        } catch { throw NativeAppleRemindersError.invalid }
    }
    func submit(_ json: String) throws -> String {
        let request = try parse(json), token = NativeAttachmentCancellation(), registryID = UUID()
        registry.register(token, id: registryID)
        lock.lock()
        let retainedActive = active.map { jobs[$0.id] == nil ? 1 : 0 } ?? 0
        guard accepting, !registry.isClosing, !token.isCancelled, jobs.count + retainedActive < 2, sequence < UInt64.max else {
            lock.unlock(); registry.remove(registryID); throw NativeAppleRemindersError.unavailable
        }
        sequence += 1
        let id = "rem:\(generation):\(sequence)"
        let job = Job(id: id, registryID: registryID, token: token, request: request)
        jobs[id] = job; queued.append(job)
        token.setCancellationHandler { [weak self, weak job] in
            guard let self, let job else { return }
            self.worker.async { self.cancelOnWorker(job) }
        }
        worker.async { self.startNext() }; lock.unlock(); return id
    }
    private func ownedProvider() -> NativeAppleRemindersProvider {
        if let provider { return provider }; let value = providerFactory(); provider = value; return value
    }
    private func startNext() {
        lock.lock()
        guard accepting, active == nil, !queued.isEmpty else { lock.unlock(); cleanClosedIfReady(); return }
        let job = queued.removeFirst(); active = job; lock.unlock()
        guard !job.token.isCancelled, !registry.isClosing else { finish(job, result: .failure(.cancelled)); return }
        let provider = ownedProvider()
        do {
            switch job.request {
            case .permission: finish(job, result: .success(["status": provider.permission().rawValue]))
            case .lists: finish(job, result: .success(try provider.lists().map(\.value)))
            case .remove(let list, let source):
                try provider.remove(list: list, source: source, cancellation: job.token)
                finish(job, result: .success(["removed": true]))
            case .requestPermission:
                provider.requestPermission { [self, job] result in
                    worker.async { self.finish(job, result: result.map { ["status": $0.rawValue] as Any }) }
                }
            case .read(let list):
                job.handle = try provider.beginRead(list: list, cancellation: job.token) { [self, job] result in
                    worker.async {
                        guard let handle = job.handle else { return }
                        provider.whenReadDrained(handle) {
                            self.worker.async {
                                self.lock.lock()
                                let current = self.active === job && self.accepting && !self.registry.isClosing && !job.token.isCancelled
                                self.lock.unlock()
                                guard current else { self.finish(job, result: .failure(.cancelled)); return }
                                do {
                                    // Fresh SDK authority is checked at settlement, after callback drain.
                                    let value = try result.get(); try provider.requireList(list)
                                    self.finish(job, result: .success(value.value))
                                } catch { self.finish(job, result: .failure(error as? NativeAppleRemindersError ?? .failed)) }
                            }
                        }
                    }
                }
            }
        } catch { finish(job, result: .failure(error as? NativeAppleRemindersError ?? .failed)) }
    }
    private static func message(_ error: NativeAppleRemindersError) -> String {
        switch error {
        case .denied: return "Apple Reminders access is denied"
        case .unavailable: return "Apple Reminders are unavailable"
        case .invalid: return "Apple Reminders request is invalid"
        case .listChanged: return "Apple Reminders list changed"
        case .tooLarge: return "Apple Reminders reply exceeds the limit"
        case .cancelled: return "Apple Reminders request cancelled"
        case .failed: return "Apple Reminders operation failed"
        }
    }
    private func error(_ error: NativeAppleRemindersError, id: String) -> String {
        // Fixed messages and generated ASCII IDs always form a bounded JSON object.
        "{\"id\":\"\(id)\",\"error\":\"\(Self.message(error))\"}"
    }
    private func publish(_ job: Job, result: Result<Any, NativeAppleRemindersError>) {
        var answer: String, succeeded = false
        do {
            let bytes = try JSONSerialization.data(withJSONObject: ["id": job.id, "value": result.get()], options: [.sortedKeys])
            guard bytes.count <= Self.maximumReplyBytes else { throw NativeAppleRemindersError.tooLarge }
            answer = String(decoding: bytes, as: UTF8.self); succeeded = true
        } catch { answer = self.error(error as? NativeAppleRemindersError ?? .failed, id: job.id) }
        lock.lock()
        guard jobs[job.id] === job, !job.answered else { lock.unlock(); return }
        if !accepting || registry.isClosing || job.token.isCancelled { answer = error(.cancelled, id: job.id); succeeded = false }
        job.answer = answer; job.succeeded = succeeded; job.answered = true; ready.append(job)
        let callback = accepting && !registry.isClosing ? wake : nil; lock.unlock(); callback?()
    }
    private func finish(_ job: Job, result: Result<Any, NativeAppleRemindersError>) {
        lock.lock(); let current = active === job; if current { active = nil }; lock.unlock()
        guard current else { return }
        publish(job, result: result); startNext()
    }
    func cancel(_ id: String) {
        lock.lock(); let job = jobs[id] ?? (active?.id == id ? active : nil); lock.unlock(); job?.token.cancel()
    }
    private func cancelOnWorker(_ job: Job) {
        lock.lock(); let isActive = active === job
        queued.removeAll { $0 === job }; lock.unlock()
        publish(job, result: .failure(.cancelled))
        if isActive {
            switch job.request {
            case .read:
                if let handle = job.handle {
                    ownedProvider().cancelRead(handle) { [self, job] in
                        worker.async { self.finish(job, result: .failure(.cancelled)) }
                    }
                }
            case .requestPermission: break // Retain ownership until the actual OS callback.
            default: finish(job, result: .failure(.cancelled))
            }
        } else { startNext() }
    }
    func isDrained(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active?.id != id && !queued.contains(where: { $0.id == id })
    }
    func next() -> Reply? {
        lock.lock()
        guard accepting, !ready.isEmpty else { lock.unlock(); return nil }
        let job = ready.removeFirst(); jobs.removeValue(forKey: job.id)
        let current = !registry.isClosing && !job.token.isCancelled
        let reply = Reply(json: current ? job.answer : error(.cancelled, id: job.id), completed: current && job.succeeded)
        lock.unlock(); job.token.setCancellationHandler(nil); registry.remove(job.registryID); return reply
    }
    func closeAndDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock(); accepting = false; wake = nil; waiters.append(continuation)
            var current = Array(jobs.values)
            if let active, jobs[active.id] == nil { current.append(active) }
            lock.unlock(); current.forEach { $0.token.cancel() }
            worker.async { self.cleanClosedIfReady() }
        }
    }
    private func cleanClosedIfReady() {
        lock.lock()
        guard !accepting, active == nil else { lock.unlock(); return }
        let current = Array(jobs.values); jobs.removeAll(); queued.removeAll(); ready.removeAll()
        let continuations = waiters; waiters.removeAll(); lock.unlock()
        current.forEach { $0.token.setCancellationHandler(nil); registry.remove($0.registryID) }
        provider = nil; continuations.forEach { $0.resume() }
    }
    #if DEBUG
    func workerBarrier() { worker.sync {} } // Test ordering only, not asynchronous-operation drain.
    var counters: (accepted: Int, active: Int) {
        lock.lock(); defer { lock.unlock() }
        let retainedActive = active.map { jobs[$0.id] == nil ? 1 : 0 } ?? 0
        return (jobs.count + retainedActive, active == nil ? 0 : 1)
    }
    #endif
}
