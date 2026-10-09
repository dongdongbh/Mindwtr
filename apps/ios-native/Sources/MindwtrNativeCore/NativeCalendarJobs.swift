import Foundation
import CoreFoundation

/// EventKit reads are synchronous: cancellation drains them, never interrupts them.
final class NativeCalendarJobs: @unchecked Sendable {
    static let maximumRequestBytes = 1024 * 1024
    static let maximumReplyBytes = 8 * 1024 * 1024
    private let condition = NSCondition()
    private let worker = DispatchQueue(label: "tech.dongdongbh.mindwtr.native-calendar")
    private let registry: NativeAttachmentLocalRequests
    private let readFile: ((String, NativeAttachmentCancellation) throws -> Data)?
    private let readerFactory: () -> any NativeCalendarReading
    private var reader: (any NativeCalendarReading)?
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var accepting = true
    private var jobs: [String: Job] = [:]
    private var ready: [String] = []
    private var taken: Job?
    private var wake: (() -> Void)?

    private enum Request {
        case permissions, calendars
        case events([String], Date, Date)
        case readFile(String)
    }
    private final class Job {
        let id: String, registryID: UUID, token: NativeAttachmentCancellation, request: Request
        var finished = false, succeeded = false
        var answer = ""
        var bytes: Data?
        init(id: String, registryID: UUID, token: NativeAttachmentCancellation, request: Request) {
            self.id = id; self.registryID = registryID; self.token = token; self.request = request
        }
    }

    init(registry: NativeAttachmentLocalRequests,
         readFile: ((String, NativeAttachmentCancellation) throws -> Data)? = nil,
         readerFactory: @escaping () -> any NativeCalendarReading = { NativeCalendarReader() }) {
        self.registry = registry; self.readFile = readFile; self.readerFactory = readerFactory
    }

    func setWake(_ callback: (() -> Void)?) {
        condition.lock(); wake = accepting ? callback : nil; condition.unlock()
    }

    private func invalid() -> HostFailure { HostFailure("Calendar request is invalid") }
    private func milliseconds(_ value: Any?) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw invalid() }
        let value = number.doubleValue
        guard value.isFinite, value.rounded(.down) == value,
              value >= -62_135_596_800_000, value <= 253_402_300_799_999 else { throw invalid() }
        return value
    }

    private func parse(_ json: String) throws -> Request {
        guard json.utf8.count <= Self.maximumRequestBytes,
              let input = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              (try? NativeJSON.hasUniqueObjectKeys(json)) == true,
              let operation = input["op"] as? String else { throw invalid() }
        switch operation {
        case "permissions", "calendars":
            guard Set(input.keys) == Set(["op"]) else { throw invalid() }
            return operation == "permissions" ? .permissions : .calendars
        case "events":
            guard Set(input.keys) == Set(["op", "calendarIds", "startMs", "endMs"]),
                  let ids = input["calendarIds"] as? [String], ids.count <= 1024,
                  ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }) else { throw invalid() }
            let start = try milliseconds(input["startMs"]), end = try milliseconds(input["endMs"])
            guard end > start, end - start <= 366 * 86_400_000 else { throw invalid() }
            return .events(ids, Date(timeIntervalSince1970: start / 1000), Date(timeIntervalSince1970: end / 1000))
        case "readFile":
            guard Set(input.keys) == Set(["op", "uri"]), let uri = input["uri"] as? String,
                  !uri.isEmpty, uri.utf16.count <= 4000 else { throw invalid() }
            return .readFile(uri)
        default: throw invalid()
        }
    }

    func submit(_ json: String) throws -> String {
        let request = try parse(json), token = NativeAttachmentCancellation(), registryID = UUID()
        registry.register(token, id: registryID)
        condition.lock()
        guard accepting, !token.isCancelled, !registry.isClosing, jobs.count < 2, sequence < UInt64.max else {
            condition.unlock(); registry.remove(registryID)
            throw HostFailure("Calendar bridge is unavailable or at capacity")
        }
        sequence += 1
        let id = "cal:\(generation):\(sequence)"
        let job = Job(id: id, registryID: registryID, token: token, request: request)
        jobs[id] = job
        // Lock admission through enqueue to preserve accepted FIFO order.
        worker.async { [self] in execute(job) }
        condition.unlock()
        return id
    }

    func abort(_ id: String) {
        condition.lock(); let token = jobs[id]?.token; condition.unlock(); token?.cancel()
    }

    private func encode(_ answer: [String: Any]) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: answer)
        guard bytes.count <= Self.maximumReplyBytes else { throw HostFailure("Calendar reply exceeds the limit") }
        return String(decoding: bytes, as: UTF8.self)
    }
    private func error(_ message: String, id: String) -> String {
        // Both fields are native-owned ASCII, with JSON-safe UUID/sequence IDs.
        "{\"id\":\"\(id)\",\"error\":\"\(message)\"}"
    }

    private func execute(_ job: Job) {
        var answer: String, succeeded = false
        var bytes: Data?
        do {
            guard !job.token.isCancelled, !registry.isClosing else { throw NativeAttachmentFileJobsError.cancelled }
            if case .readFile(let uri) = job.request {
                guard let readFile else { throw NativeCalendarReadError.unavailable }
                #if DEBUG
                try beforeFileRead?()
                #endif
                let body = try readFile(uri, job.token)
                guard body.count <= Self.maximumReplyBytes else { throw HostFailure("Calendar reply exceeds the limit") }
                guard !job.token.isCancelled, !registry.isClosing else { throw NativeAttachmentFileJobsError.cancelled }
                bytes = body
                answer = try encode(["id": job.id, "body": true]); succeeded = true
            } else {
                let provider: any NativeCalendarReading
                if let reader { provider = reader }
                else { provider = readerFactory(); reader = provider }
                let permission = try provider.permissions()
                guard !job.token.isCancelled, !registry.isClosing else { throw NativeAttachmentFileJobsError.cancelled }
                let value: Any
                switch job.request {
                case .permissions: value = ["status": permission.rawValue]
                case .calendars:
                    guard permission == .granted else { throw NativeCalendarReadError.denied }
                    value = try provider.calendars()
                case .events(let ids, let start, let end):
                    guard permission == .granted else { throw NativeCalendarReadError.denied }
                    value = ids.isEmpty ? [[String: Any]]() : try provider.events(calendarIds: ids, start: start, end: end)
                case .readFile: throw invalid()
                }
                answer = try encode(["id": job.id, "value": value]); succeeded = true
            }
        } catch NativeCalendarReadError.denied {
            answer = error("Calendar access is denied", id: job.id)
        } catch NativeCalendarReadError.unavailable {
            answer = error("Calendar reads are unavailable", id: job.id)
        } catch let cause as HostFailure where cause.message == "Calendar reply exceeds the limit" {
            answer = error("Calendar reply exceeds the limit", id: job.id)
        } catch {
            answer = self.error("Calendar read failed", id: job.id)
        }
        condition.lock()
        if !accepting || job.token.isCancelled || registry.isClosing {
            answer = error("Calendar request cancelled", id: job.id); succeeded = false; bytes = nil
        }
        job.answer = answer; job.bytes = bytes; job.succeeded = succeeded; job.finished = true; ready.append(job.id)
        let callback = accepting && !registry.isClosing ? wake : nil
        condition.broadcast(); condition.unlock()
        callback?()
    }

    func next() throws -> (json: String, completed: Bool)? {
        condition.lock()
        guard taken == nil, !ready.isEmpty, let job = jobs[ready.removeFirst()] else { condition.unlock(); return nil }
        let completed = accepting && !job.token.isCancelled && !registry.isClosing && job.succeeded
        let answer = !accepting || job.token.isCancelled || registry.isClosing
            ? error("Calendar request cancelled", id: job.id) : job.answer
        let body = completed && job.bytes != nil
        if body { taken = job }
        else { jobs.removeValue(forKey: job.id); job.bytes = nil }
        condition.unlock()
        if !body { registry.remove(job.registryID) }
        return (answer, completed)
    }

    /// Metadata transfers only this exact job's body; cancellation stays owned
    /// until the bytes have been consumed or refused, then releases once.
    func body() throws -> String {
        condition.lock()
        guard let job = taken else { condition.unlock(); throw HostFailure("Calendar body is unavailable") }
        taken = nil; jobs.removeValue(forKey: job.id)
        let bytes = job.bytes; job.bytes = nil
        let current = accepting && !job.token.isCancelled && !registry.isClosing
        condition.unlock(); registry.remove(job.registryID)
        guard current, let bytes else { throw HostFailure("Calendar body is unavailable") }
        let encoded = bytes.base64EncodedString()
        guard !job.token.isCancelled, !registry.isClosing else { throw HostFailure("Calendar body is unavailable") }
        return encoded
    }

    func drain() { worker.sync {} }

    func shutdown() {
        condition.lock(); accepting = false; wake = nil; let current = Array(jobs.values); condition.unlock()
        current.forEach { $0.token.cancel() }
        worker.sync { reader = nil }
        current.forEach { registry.remove($0.registryID) }
        condition.lock(); jobs.removeAll(); ready.removeAll(); taken = nil; condition.unlock()
    }

    #if DEBUG
    var beforeFileRead: (() throws -> Void)?
    var counters: (jobs: Int, running: Int) {
        condition.lock(); defer { condition.unlock() }
        return (jobs.count, jobs.values.filter { !$0.finished }.count)
    }
    #endif
}
