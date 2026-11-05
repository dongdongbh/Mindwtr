import Foundation
import Security


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
    var beforeRead: ((String) throws -> Void)?
    var beforeAIProviderQuery: (([String: Any], NativeAttachmentCancellation) -> Void)?
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
        return try enqueue(operation: operation, account: account, value: value, accessibility: accessibility,
                           token: NativeAttachmentCancellation()).id
    }

    private func enqueue(operation: String, account: String, value: String?, accessibility: String,
                         token: NativeAttachmentCancellation) throws -> Job {
        let registryID = UUID()
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

        worker.async { [self] in execute(job) }
        condition.unlock()
        return job
    }

    private func query(_ account: String, alias: String) -> [String: Any] {
        let name = alias == "legacy" ? service : service + ":" + alias
        let bytes = Data(account.utf8)
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: name,
                kSecAttrAccount as String: bytes, kSecAttrGeneric as String: bytes,
                kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }

    /// Expo's byte query is retained on iOS. The macOS file Keychain drops
    /// CFData account attributes on add, so execution there uses CFString.
    private func executionQuery(_ input: [String: Any]) -> [String: Any] {
        #if os(macOS)
        if let bytes = input[kSecAttrAccount as String] as? Data,
           input[kSecAttrGeneric as String] as? Data == bytes, let account = String(data: bytes, encoding: .utf8) {
            var result = input; result[kSecAttrAccount as String] = account; return result
        }
        #endif
        return input
    }
    private func copyMatching(_ input: [String: Any], result: inout CFTypeRef?) -> OSStatus {
        let status = SecItemCopyMatching(executionQuery(input) as CFDictionary, &result)
        #if os(macOS)
        // Older byte-form Mac fixtures have no account attribute. Retry only
        // this exact account+generic query, and never fall back after denial.
        if status == errSecItemNotFound, let bytes = input[kSecAttrAccount as String] as? Data,
           input[kSecAttrGeneric as String] as? Data == bytes {
            result = nil; return SecItemCopyMatching(input as CFDictionary, &result)
        }
        #endif
        return status
    }
    private func deleteMatching(_ input: [String: Any]) -> OSStatus {
        let current = SecItemDelete(executionQuery(input) as CFDictionary)
        #if os(macOS)
        if let bytes = input[kSecAttrAccount as String] as? Data, input[kSecAttrGeneric as String] as? Data == bytes {
            // Clear both selected representations; every query keeps service,
            // account and generic identity. A partial failure remains failure.
            let previous = SecItemDelete(input as CFDictionary)
            if current != errSecSuccess && current != errSecItemNotFound { return current }
            if previous != errSecSuccess && previous != errSecItemNotFound { return previous }
            return current == errSecSuccess || previous == errSecSuccess ? errSecSuccess : errSecItemNotFound
        }
        #endif
        return current
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
        #if DEBUG
        try beforeRead?(account)
        #endif
        for alias in ["no-auth", "auth", "legacy"] {
            var input = query(account, alias: alias)
            input[kSecMatchLimit as String] = kSecMatchLimitOne
            input[kSecReturnData as String] = true
            var item: CFTypeRef?
            let result = status("get", alias: alias) { copyMatching(input, result: &item) }
            if result == errSecItemNotFound { continue }
            try check(result)
            guard let bytes = item as? Data, bytes.count <= Self.maximumBytes,
                  let text = String(data: bytes, encoding: .utf8) else { throw HostFailure("Secure storage data is invalid") }
            return text
        }
        return nil
    }

    private func inspectAIProviderItem(_ job: Job) throws -> String {
        for alias in ["no-auth", "auth", "legacy"] {
            try job.token.check()
            var input = query(job.account, alias: alias)
            input[kSecMatchLimit as String] = kSecMatchLimitOne
            input[kSecReturnAttributes as String] = true
            #if DEBUG
            beforeAIProviderQuery?(input, job.token)
            #endif
            try job.token.check()
            var attributes: CFTypeRef?
            let result = status("ai-metadata", alias: alias) { copyMatching(input, result: &attributes) }
            try job.token.check()
            if result == errSecItemNotFound { continue }
            return result == errSecSuccess ? "present" : "unavailable"
        }
        return "absent"
    }


    func inspectAIProviderItem(account: String, cancellation: NativeAttachmentCancellation) throws -> String {
        guard ["mindwtr-ai-key_openai", "mindwtr-ai-key_gemini", "mindwtr-ai-key_anthropic"].contains(account) else {
            throw HostFailure("AI provider device metadata request is invalid")
        }
        try cancellation.check()
        let job = try enqueue(operation: "ai-metadata", account: account, value: nil,
                              accessibility: "when-unlocked", token: cancellation)
        worker.sync {}
        condition.lock()
        let open = accepting
        jobs.removeValue(forKey: job.id); ready.removeAll { $0 == job.id }
        let answer = job.answer, succeeded = job.succeeded
        condition.unlock(); registry.remove(job.registryID)
        try cancellation.check()
        guard open, succeeded, let metadata = answer["secureItem"] as? String else {
            throw HostFailure("AI provider device metadata is unavailable")
        }
        return metadata
    }
    private func write(_ job: Job, enforceUnlocked: Bool = false) throws {
        let base = query(job.account, alias: "no-auth")
        var input = base
        input[kSecValueData as String] = Data(job.value!.utf8)
        input[kSecAttrAccessible as String] = job.accessibility == "after-first-unlock"
            ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = status("set", alias: "no-auth") { SecItemAdd(executionQuery(input) as CFDictionary, nil) }
        if result == errSecDuplicateItem {
            var changes: [String: Any] = [kSecValueData as String: Data(job.value!.utf8)]
            if enforceUnlocked { changes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
            try check(status("update", alias: "no-auth") { SecItemUpdate(executionQuery(base) as CFDictionary, changes as CFDictionary) })
        } else { try check(result) }

    }
    private func delete(_ account: String) throws {
        var failure: Error?
        for alias in ["legacy", "auth", "no-auth"] {
            let input = query(account, alias: alias)
            let result = status("delete", alias: alias) { deleteMatching(input) }
            if result == errSecItemNotFound { continue }
            do { try check(result) } catch { if failure == nil { failure = error } }
        }
        if let failure { throw failure }
    }

    private func execute(_ job: Job) {
        let answer: [String: Any], succeeded: Bool
        do {


            guard !job.token.isCancelled else { throw HostFailure("Secure storage bridge is closed") }
            if job.operation == "ai-metadata" {
                answer = ["id": job.id, "secureItem": try inspectAIProviderItem(job)]
            } else {
                let value: String?
                switch job.operation {
                case "get": value = try read(job.account)
                case "set": try write(job); value = nil
                default: try delete(job.account); value = nil
                }
                answer = ["id": job.id, "value": value.map { $0 as Any } ?? NSNull()]
            }
            succeeded = true
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

    func drain() { worker.sync {} }


    func readCloudTokenForAttachmentOwner(cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr_cloud_token", cancellation: cancellation)
    }
    func readWebDavPasswordForAttachmentOwner(cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr_webdav_password", cancellation: cancellation)
    }
    func readEncryptionKeyForAttachmentOwner(cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr_sync_encryption_key_v1", cancellation: cancellation)
    }
    /// Fixed selected-provider action read. Never migrates, writes or removes an item.
    func readAIRequestKey(provider: NativeAISettingsProjection.Provider, cancellation: NativeAttachmentCancellation) throws -> String? {
        try readForAttachmentOwner("mindwtr-ai-key_" + provider.rawValue, cancellation: cancellation)
    }

    /// Explicit selected-provider Save only. Secure readback must succeed before
    /// the caller is permitted to retire the selected plaintext fallback.
    func replaceOpenAIConfigurationCredential(value: String, cancellation: NativeAttachmentCancellation) throws {
        try replaceAIConfigurationCredential(provider: .openai, value: value, cancellation: cancellation)
    }
    func clearOpenAIConfigurationCredential(cancellation: NativeAttachmentCancellation) throws {
        try clearAIConfigurationCredential(provider: .openai, cancellation: cancellation)
    }
    func replaceAIConfigurationCredential(provider: NativeAISettingsProjection.Provider, value: String, cancellation: NativeAttachmentCancellation) throws {
        guard !value.isEmpty, value.utf16.count <= 4000, value.utf8.count <= Self.maximumBytes else {
            throw HostFailure("AI credential input is invalid")
        }
        try performAIConfigurationMutation(cancellation: cancellation) {
            let account = "mindwtr-ai-key_" + provider.rawValue
            let job = Job(id: "ai-configuration", registryID: UUID(), token: cancellation,
                operation: "set", account: account, value: value, accessibility: "when-unlocked")
            try self.write(job, enforceUnlocked: true)
            guard let written = try self.read(account), Data(written.utf8) == Data(value.utf8) else {
                throw HostFailure("AI credential replacement could not be verified")
            }
            var input = self.query(account, alias: "no-auth")
            input[kSecMatchLimit as String] = kSecMatchLimitOne; input[kSecReturnAttributes as String] = true
            var result: CFTypeRef?
            try self.check(self.status("verify", alias: "no-auth") { self.copyMatching(input, result: &result) })
            guard let attributes = result as? [String: Any] else {
                throw HostFailure("AI credential replacement could not be verified")
            }
            let accessibility = attributes[kSecAttrAccessible as String] as? String
            #if os(iOS)
            guard accessibility == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String else {
                throw HostFailure("AI credential replacement could not be verified")
            }
            #else
            // The macOS file-based Keychain omits iOS accessibility attributes.
            if let accessibility, accessibility != kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String {
                throw HostFailure("AI credential replacement could not be verified")
            }
            #endif
        }
    }

    /// Explicit selected-provider Clear only. Every alias is attempted and
    /// independently checked; a partial deletion is never acknowledged as clear.
    func clearAIConfigurationCredential(provider: NativeAISettingsProjection.Provider, cancellation: NativeAttachmentCancellation) throws {
        try performAIConfigurationMutation(cancellation: cancellation) {
            let account = "mindwtr-ai-key_" + provider.rawValue
            var failure: Error?
            do { try self.delete(account) } catch { failure = error }
            for alias in ["legacy", "auth", "no-auth"] {
                var input = self.query(account, alias: alias)
                input[kSecMatchLimit as String] = kSecMatchLimitOne; input[kSecReturnAttributes as String] = true
                var attributes: CFTypeRef?
                let result = self.status("verify-clear", alias: alias) { self.copyMatching(input, result: &attributes) }
                if result == errSecItemNotFound { continue }
                do {
                    try self.check(result)
                    throw HostFailure("AI credential clear could not be verified")
                } catch { if failure == nil { failure = error } }
            }
            if let failure { throw failure }
        }
    }

    private func performAIConfigurationMutation(cancellation: NativeAttachmentCancellation, _ work: () throws -> Void) throws {
        try cancellation.check()
        try worker.sync {
            condition.lock(); let open = accepting; condition.unlock()
            guard open else { throw HostFailure("Secure storage bridge is closed") }
            try cancellation.check()
            // Once admitted, do not abandon synchronous SecItem work or its
            // verification halfway through. Cancellation retires publication.
            try work()
            condition.lock(); let stillOpen = accepting; condition.unlock()
            guard stillOpen else { throw HostFailure("Secure storage bridge is closed") }
        }
        try cancellation.check()
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
