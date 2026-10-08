import Foundation
import Security

/// SecItem work is synchronous and cannot be rolled back by cancelling its caller.
/// Only plain records cross this serial worker; two retained replies bound memory.
final class NativeSecretJobs: @unchecked Sendable {
    static let maximumBytes = 64 * 1024
    private let condition = NSCondition()
    private let worker = DispatchQueue(label: "tech.dongdongbh.mindwtr.native-secrets")
    private let registry: NativeAttachmentLocalRequests
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var accepting = true
    private var jobs: [String: Job] = [:]
    private var ready: [String] = []
    private var wake: (() -> Void)?
    private var service = "app"
    #if DEBUG
    private let faults: HostIOFaults?
    #endif

    private final class Job {
        let id: String, registryID: UUID, token: NativeAttachmentCancellation
        let operation: String, account: String, value: String?, accessibility: String
        var finished = false
        var answer: [String: Any] = [:]
        var succeeded = false
        init(id: String, registryID: UUID, token: NativeAttachmentCancellation,
             operation: String, account: String, value: String?, accessibility: String) {
            self.id = id; self.registryID = registryID; self.token = token
            self.operation = operation; self.account = account; self.value = value; self.accessibility = accessibility
        }
    }

    #if DEBUG
    init(registry: NativeAttachmentLocalRequests, faults: HostIOFaults? = nil) throws {
        self.registry = registry; self.faults = faults
        if let namespace = faults?.secretService {
            guard namespace.hasPrefix("mindwtr.native-keychain.fixture."), namespace.utf8.count <= 255,
                  namespace.utf8.allSatisfy(Self.accountByte) else { throw HostFailure("Secure storage fixture is invalid") }
            service = namespace
        }
    }
    #else
    init(registry: NativeAttachmentLocalRequests) { self.registry = registry }
    #endif

    private static func accountByte(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || [45, 46, 95].contains(byte)
    }
    func setWake(_ callback: (() -> Void)?) { condition.lock(); wake = callback; condition.unlock() }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= 512 * 1024,
              let input = try? NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let operation = input["op"] as? String, ["get", "set", "delete"].contains(operation),
              let account = input["key"] as? String, (1...255).contains(account.utf8.count),
              account.utf8.allSatisfy(Self.accountByte) else { throw HostFailure("Secure storage request is invalid") }
        let value: String?, accessibility: String
        if operation == "set" {
            guard Set(input.keys).isSubset(of: ["op", "key", "value", "accessibility"]),
                  let text = input["value"] as? String, text.utf8.count <= Self.maximumBytes else {
                throw HostFailure("Secure storage request is invalid")
            }
            value = text
            if let raw = input["accessibility"] {
                guard let name = raw as? String, ["after-first-unlock", "when-unlocked"].contains(name) else {
                    throw HostFailure("Secure storage request is invalid")
                }
                accessibility = name
            } else { accessibility = "when-unlocked" }
        } else {
            guard Set(input.keys) == Set(["op", "key"]) else { throw HostFailure("Secure storage request is invalid") }
            value = nil; accessibility = "when-unlocked"
        }
        let token = NativeAttachmentCancellation(), registryID = UUID()
        registry.register(token, id: registryID)
        condition.lock()
        guard accepting, !token.isCancelled, jobs.count < 2, sequence < UInt64.max else {
            condition.unlock(); registry.remove(registryID)
            throw HostFailure("Secure storage bridge is unavailable or at capacity")
        }
        sequence += 1
        let id = "sec:\(generation):\(sequence)"
        let job = Job(id: id, registryID: registryID, token: token, operation: operation,
                      account: account, value: value, accessibility: accessibility)
        jobs[id] = job
        // Enqueue while admission is locked, so serial execution follows admission order.
        worker.async { [self] in execute(job) }
        condition.unlock()
        return id
    }

    private func query(_ account: String, alias: String) -> [String: Any] {
        let name = alias == "legacy" ? service : service + ":" + alias
        let bytes = Data(account.utf8)
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: name,
                kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }

    private func status(_ operation: String, alias: String, work: () -> OSStatus) -> OSStatus {
        #if DEBUG
        faults?.secretBeforeOperation?(operation, alias)
        let result = faults?.secretStatus?(operation, alias) ?? work()
        faults?.secretAfterOperation?(operation, alias)
        return result
        #else
        return work()
        #endif
    }
    private func check(_ result: OSStatus) throws {
        switch result {
        case errSecSuccess: return
        case errSecNotAvailable: throw HostFailure("Secure storage is unavailable")
        case errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled:
            throw HostFailure("Secure storage access is denied")
        case errSecDecode: throw HostFailure("Secure storage data is invalid")
        default: throw HostFailure("Secure storage operation failed")
        }
    }
    private func read(_ account: String) throws -> String? {
        for alias in ["no-auth", "auth", "legacy"] {
            var input = query(account, alias: alias)
            input[kSecMatchLimit as String] = kSecMatchLimitOne
            input[kSecReturnData as String] = true
            var item: CFTypeRef?
            let result = status("get", alias: alias) { SecItemCopyMatching(input as CFDictionary, &item) }
            if result == errSecItemNotFound { continue }
            try check(result)
            guard let bytes = item as? Data, bytes.count <= Self.maximumBytes,
                  let text = String(data: bytes, encoding: .utf8) else { throw HostFailure("Secure storage data is invalid") }
            return text
        }
        return nil
    }
    private func write(_ job: Job) throws {
        let base = query(job.account, alias: "no-auth")
        var input = base
        input[kSecValueData as String] = Data(job.value!.utf8)
        input[kSecAttrAccessible as String] = job.accessibility == "after-first-unlock"
            ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = status("set", alias: "no-auth") { SecItemAdd(input as CFDictionary, nil) }
        if result == errSecDuplicateItem {
            let changes = [kSecValueData as String: Data(job.value!.utf8)]
            try check(status("update", alias: "no-auth") { SecItemUpdate(base as CFDictionary, changes as CFDictionary) })
        } else { try check(result) }
        // Stage1 intentionally retains legacy/auth aliases; no write-induced migration.
    }
    private func delete(_ account: String) throws {
        var failure: Error?
        for alias in ["legacy", "auth", "no-auth"] {
            let input = query(account, alias: alias)
            let result = status("delete", alias: alias) { SecItemDelete(input as CFDictionary) }
            if result == errSecItemNotFound { continue }
            do { try check(result) } catch { if failure == nil { failure = error } }
        }
        if let failure { throw failure }
    }

    private func execute(_ job: Job) {
        let answer: [String: Any], succeeded: Bool
        do {
            // This is the last cancellation boundary: a started synchronous
            // SecItem operation completes even if close arrives during the call.
            guard !job.token.isCancelled else { throw HostFailure("Secure storage bridge is closed") }
            let value: String?
            switch job.operation {
            case "get": value = try read(job.account)
            case "set": try write(job); value = nil
            default: try delete(job.account); value = nil
            }
            answer = ["id": job.id, "value": value.map { $0 as Any } ?? NSNull()]; succeeded = true
        } catch {
            answer = ["id": job.id, "error": (error as? HostFailure)?.message ?? "Secure storage operation failed"]; succeeded = false
        }
        condition.lock()
        job.answer = answer; job.succeeded = succeeded; job.finished = true; ready.append(job.id)
        let callback = wake
        condition.broadcast(); condition.unlock()
        callback?()
    }

    func next() throws -> (json: String, completed: Bool)? {
        condition.lock()
        guard !ready.isEmpty, let job = jobs.removeValue(forKey: ready.removeFirst()) else { condition.unlock(); return nil }
        let answer = job.answer, completed = job.succeeded && !job.token.isCancelled
        condition.unlock(); registry.remove(job.registryID)
        return (String(decoding: try JSONSerialization.data(withJSONObject: answer), as: UTF8.self), completed)
    }
    /// Do not abort accepted work: finally compensation still runs in this runtime.
    func drain() { worker.sync {} }
    /// The selected attachment owner compares the same read-only account at its
    /// serialized mutation boundaries. This does not lock external Keychain writers.
    func readCloudTokenForAttachmentOwner(cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr_cloud_token", cancellation: cancellation)
    }
    func readEncryptionKeyForAttachmentOwner(cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr_sync_encryption_key_v1", cancellation: cancellation)
    }
    private func readForAttachmentOwner(_ account: String, cancellation: NativeAttachmentCancellation) throws -> String? {
        try cancellation.check()
        return try worker.sync {
            condition.lock(); let open = accepting; condition.unlock()
            guard open else { throw HostFailure("Secure storage bridge is closed") }
            try cancellation.check()
            let value = try read(account)
            try cancellation.check()
            condition.lock(); let stillOpen = accepting; condition.unlock()
            guard stillOpen else { throw HostFailure("Secure storage bridge is closed") }
            return value
        }
    }
    func shutdown() {
        condition.lock(); accepting = false; wake = nil; let current = Array(jobs.values); condition.unlock()
        current.forEach { $0.token.cancel() }
        worker.sync {}
        current.forEach { registry.remove($0.registryID) }
        condition.lock(); jobs.removeAll(); ready.removeAll(); condition.unlock()
    }
    #if DEBUG
    var counters: (jobs: Int, running: Int) {
        condition.lock(); defer { condition.unlock() }
        return (jobs.count, jobs.values.filter { !$0.finished }.count)
    }
    #endif
}
