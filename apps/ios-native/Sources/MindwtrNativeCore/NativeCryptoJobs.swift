import Foundation
import CoreFoundation
import CryptoKit
import CMindwtrArgon2

/// Two retained slots cover admitted work and undelivered bytes. Crypto never
/// enters JSC/SQLite and ordinary caller cancellation does not abort a primitive.
final class NativeCryptoJobs: @unchecked Sendable {
    static let maximumBytes = 8 * 1024 * 1024
    private let lock = NSLock()
    private let worker = DispatchQueue(label: "tech.dongdongbh.mindwtr.native-crypto")
    private let registry: NativeAttachmentLocalRequests
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var reserved = 0
    private var accepting = true
    private var jobs: [String: Job] = [:]
    private var ready: [String] = []
    private var taken: String?
    private var wake: (() -> Void)?
    #if DEBUG
    private let faults: HostIOFaults?
    private var operations = 0
    #endif

    private final class Job {
        let id: String, registryID: UUID, token: NativeAttachmentCancellation
        var operation = ""
        var pass = Data(), salt = Data(), key = Data(), nonce = Data(), data = Data(), aad = Data(), output = Data()
        var memory: UInt32 = 0, passes: UInt32 = 0, lanes: UInt32 = 0, length = 0
        var finished = false
        var error: String?
        var auth = false
        init(id: String, registryID: UUID, token: NativeAttachmentCancellation) {
            self.id = id; self.registryID = registryID; self.token = token
        }
        func clearInputs() {
            NativeCryptoJobs.clear(&pass); NativeCryptoJobs.clear(&salt); NativeCryptoJobs.clear(&key)
            NativeCryptoJobs.clear(&nonce); NativeCryptoJobs.clear(&data); NativeCryptoJobs.clear(&aad)
        }
    }
    private struct AuthFailure: Error { }
    private static func clear(_ bytes: inout Data) {
        if !bytes.isEmpty { bytes.resetBytes(in: bytes.startIndex..<bytes.endIndex) }
        bytes.removeAll(keepingCapacity: false)
    }
    #if DEBUG
    init(registry: NativeAttachmentLocalRequests, faults: HostIOFaults? = nil) {
        self.registry = registry; self.faults = faults
    }
    #else
    init(registry: NativeAttachmentLocalRequests) { self.registry = registry }
    #endif
    func setWake(_ callback: (() -> Void)?) { lock.lock(); wake = callback; lock.unlock() }

    private func invalid() -> HostFailure { HostFailure("Crypto request is invalid") }
    private func exact(_ value: Any?, minimum: UInt32, maximum: UInt32) throws -> UInt32 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw invalid() }
        let n = number.doubleValue
        guard n.isFinite, n.rounded(.down) == n, n >= Double(minimum), n <= Double(maximum) else { throw invalid() }
        return UInt32(n)
    }
    private func bytes(_ value: Any?, maximum: Int, minimum: Int = 0) throws -> Data {
        guard let text = value as? String, text.utf8.count <= ((maximum + 2) / 3) * 4,
              var data = Data(base64Encoded: text) else { throw invalid() }
        guard (minimum...maximum).contains(data.count), data.base64EncodedString() == text else {
            Self.clear(&data); throw invalid()
        }
        return data
    }
    private func parse(_ json: String, into job: Job) throws {
        guard let input = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let operation = input["op"] as? String else { throw invalid() }
        job.operation = operation
        if operation == "argon2id" {
            guard Set(input.keys) == Set(["op", "pass", "salt", "m", "t", "p", "dkLen"]) else { throw invalid() }
            job.memory = try exact(input["m"], minimum: 1, maximum: 262144)
            job.passes = try exact(input["t"], minimum: 1, maximum: 16)
            job.lanes = try exact(input["p"], minimum: 1, maximum: 8)
            job.length = Int(try exact(input["dkLen"], minimum: 4, maximum: 64))
            guard job.memory >= 8 * job.lanes else { throw invalid() }
            job.pass = try bytes(input["pass"], maximum: 64 * 1024)
            job.salt = try bytes(input["salt"], maximum: 64, minimum: 8)
        } else if operation == "aesGcmSeal" || operation == "aesGcmOpen" {
            guard Set(input.keys) == Set(["op", "key", "nonce", "data", "aad"]) else { throw invalid() }
            job.key = try bytes(input["key"], maximum: 32, minimum: 32)
            job.nonce = try bytes(input["nonce"], maximum: 12, minimum: 12)
            job.data = try bytes(input["data"], maximum: Self.maximumBytes + (operation == "aesGcmOpen" ? 16 : 0))
            job.aad = try bytes(input["aad"], maximum: 64 * 1024)
        } else { throw invalid() }
    }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= 12 * 1024 * 1024 else { throw invalid() }
        let token = NativeAttachmentCancellation(), registryID = UUID()
        registry.register(token, id: registryID)
        lock.lock()
        // Reserve before JSON/base64 decoding, including a not-yet-enqueued request.
        guard accepting, !token.isCancelled, jobs.count + reserved < 2, sequence < UInt64.max else {
            lock.unlock(); registry.remove(registryID)
            throw HostFailure("Crypto bridge is unavailable or at capacity")
        }
        reserved += 1; sequence += 1
        let id = "crypto:\(generation):\(sequence)"
        lock.unlock()
        let job = Job(id: id, registryID: registryID, token: token)
        do { try parse(json, into: job) }
        catch {
            job.clearInputs(); lock.lock(); reserved -= 1; lock.unlock(); registry.remove(registryID); throw invalid()
        }
        lock.lock(); reserved -= 1
        guard accepting, !token.isCancelled else {
            lock.unlock(); job.clearInputs(); registry.remove(registryID); throw HostFailure("Crypto bridge is closed")
        }
        jobs[id] = job
        worker.async { [self] in execute(job) }
        lock.unlock()
        return id
    }

    private func compute(_ job: Job) throws -> Data {
        if job.operation == "argon2id" {
            #if DEBUG
            if faults?.cryptoArgon2Unavailable?() == true { throw HostFailure("Sync encryption is unavailable") }
            #endif
            var output = Data(count: job.length)
            let result = job.pass.withUnsafeBytes { pass in
                job.salt.withUnsafeBytes { salt in
                    output.withUnsafeMutableBytes { bytes in
                        mindwtr_argon2id(pass.bindMemory(to: UInt8.self).baseAddress, job.pass.count,
                            salt.bindMemory(to: UInt8.self).baseAddress, job.salt.count,
                            job.memory, job.passes, job.lanes, bytes.bindMemory(to: UInt8.self).baseAddress, job.length)
                    }
                }
            }
            guard result == 1 else { Self.clear(&output); throw HostFailure("Sync encryption is unavailable") }
            return output
        }
        let key = SymmetricKey(data: job.key), nonce = try AES.GCM.Nonce(data: job.nonce)
        if job.operation == "aesGcmSeal" {
            let box = try AES.GCM.seal(job.data, using: key, nonce: nonce, authenticating: job.aad)
            var output = box.ciphertext; output.append(box.tag)
            return output
        }
        guard job.data.count >= 16 else { throw AuthFailure() }
        do {
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: job.data.dropLast(16), tag: job.data.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: job.aad)
        } catch CryptoKitError.authenticationFailure { throw AuthFailure() }
    }

    private func execute(_ job: Job) {
        var output = Data(), failure: String?, auth = false
        do {
            guard !job.token.isCancelled else { throw HostFailure("Crypto bridge is closed") }
            #if DEBUG
            lock.lock(); operations += 1; lock.unlock()
            faults?.cryptoBeforeOperation?(job.operation)
            #endif
            output = try compute(job)
            #if DEBUG
            faults?.cryptoAfterOperation?(job.operation)
            #endif
        } catch is AuthFailure { failure = "wrong passphrase or corrupted data"; auth = true }
        catch let cause { failure = (cause as? HostFailure)?.message ?? "Crypto operation failed" }
        job.clearInputs()
        lock.lock()
        if !accepting || job.token.isCancelled {
            Self.clear(&output); failure = "Crypto bridge is closed"; auth = false
        }
        job.output = output; job.error = failure; job.auth = auth; job.finished = true; ready.append(job.id)
        let callback = wake
        lock.unlock(); callback?()
    }

    func next() throws -> (json: String, body: Bool)? {
        lock.lock()
        guard taken == nil else { lock.unlock(); throw HostFailure("I/O response body is unavailable") }
        guard !ready.isEmpty, let job = jobs[ready.removeFirst()] else { lock.unlock(); return nil }
        if !accepting || job.token.isCancelled { Self.clear(&job.output); job.error = "Crypto bridge is closed"; job.auth = false }
        var answer: [String: Any] = ["id": job.id]
        let body = job.error == nil
        if let error = job.error {
            answer["error"] = error
            if job.auth { answer["auth"] = true }
            jobs.removeValue(forKey: job.id)
        } else { answer["body"] = true; taken = job.id }
        lock.unlock()
        if !body { registry.remove(job.registryID) }
        return (String(decoding: try JSONSerialization.data(withJSONObject: answer), as: UTF8.self), body)
    }
    func body() throws -> (base64: String, completed: Bool) {
        lock.lock()
        guard let id = taken, let job = jobs.removeValue(forKey: id), job.finished, job.error == nil else {
            lock.unlock(); throw HostFailure("I/O response body is unavailable")
        }
        taken = nil
        defer { Self.clear(&job.output); lock.unlock(); registry.remove(job.registryID) }
        guard accepting, !job.token.isCancelled else { throw HostFailure("I/O response body is unavailable") }
        let encoded = job.output.base64EncodedString()
        guard !job.token.isCancelled else { throw HostFailure("I/O response body is unavailable") }
        return (encoded, true)
    }
    /// Wait for an accepted primitive before its owning invocation releases.
    func drain() { worker.sync {} }

    func shutdown() {
        lock.lock(); accepting = false; wake = nil; let current = Array(jobs.values); lock.unlock()
        current.forEach { $0.token.cancel() }
        // A bounded running KDF has no truthful midcall cancellation. No Engine
        // callback is needed to finish this serial barrier and release ownership.
        worker.sync {}
        current.forEach { job in job.clearInputs(); Self.clear(&job.output); registry.remove(job.registryID) }
        lock.lock(); jobs.removeAll(); ready.removeAll(); taken = nil; lock.unlock()
    }
    #if DEBUG
    var counters: (jobs: Int, running: Int, bytes: Int, operations: Int) {
        lock.lock(); defer { lock.unlock() }
        return (jobs.count + reserved, jobs.values.filter { !$0.finished }.count,
                jobs.values.reduce(0) { $0 + $1.output.count }, operations)
    }
    #endif
}
