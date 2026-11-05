import Foundation
import CoreFoundation

public struct NativeDropboxConfiguration: Sendable {
    public let clientID: String
    public let redirectURI: String

    public init(clientID: String, redirectURI: String) throws {
        guard !clientID.isEmpty, clientID.utf8.count <= 512,
              clientID.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }),
              redirectURI.utf8.elementsEqual("mindwtr-native-dev://redirect".utf8) else {
            throw CoreHostRejection(message: "INVALID_INPUT: Dropbox public configuration is invalid")
        }
        self.clientID = clientID; self.redirectURI = redirectURI
    }
}

public struct NativeDropboxAuthorizationGrant: Sendable {
    public let requestID: String
    public let clientID: String
    public let redirectURI: String
    public let code: String
    public let codeVerifier: String

    public init(requestID: String, clientID: String, redirectURI: String, code: String, codeVerifier: String) {
        self.requestID = requestID; self.clientID = clientID; self.redirectURI = redirectURI
        self.code = code; self.codeVerifier = codeVerifier
    }
}

public struct NativeDropboxAuthorizationBinding: Sendable {
    public let configuration: NativeDropboxConfiguration
    let isCurrent: @Sendable () -> Bool
    let authorize: @Sendable (String) async throws -> NativeDropboxAuthorizationGrant
    let cancel: @Sendable (String) -> Void

    public init(configuration: NativeDropboxConfiguration,
                isCurrent: @escaping @Sendable () -> Bool,
                authorize: @escaping @Sendable (String) async throws -> NativeDropboxAuthorizationGrant,
                cancel: @escaping @Sendable (String) -> Void) {
        self.configuration = configuration; self.isCurrent = isCurrent
        self.authorize = authorize; self.cancel = cancel
    }
}

final class NativeDropboxAuthorizationJobs: @unchecked Sendable {
    private let condition = NSCondition()
    private let registry: NativeAttachmentLocalRequests
    private let registryID = UUID()
    private let cancellation = NativeAttachmentCancellation()
    private let binding: NativeDropboxAuthorizationBinding
    private let expectedRequestID: String?
    private let generation = UUID().uuidString.lowercased()
    private var accepting = true
    private var used = false
    private var job: Job?
    private var task: Task<Void, Never>?

    private final class Job {
        let id: String
        let requestID: String
        var answer: String?
        init(id: String, requestID: String) { self.id = id; self.requestID = requestID }
    }

    static var unavailable: HostFailure { HostFailure("Dropbox authorization is unavailable") }
    static func canonicalRequestID(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value).map { $0.uuidString.lowercased().utf8.elementsEqual(value.utf8) } == true
    }
    init(registry: NativeAttachmentLocalRequests, binding: NativeDropboxAuthorizationBinding, expectedRequestID: String?) {
        self.registry = registry; self.binding = binding; self.expectedRequestID = expectedRequestID
        cancellation.setCancellationHandler { [weak self] in self?.retire() }
        registry.register(cancellation, id: registryID)
    }

    func control(_ json: String) throws -> String {
        guard json.utf8.count <= 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let input = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(input.keys) == Set(["phase"]), let phase = input["phase"] as? String,
              ["configuration", "assertCurrent"].contains(phase), binding.isCurrent() else { throw Self.unavailable }
        condition.lock(); let current = accepting && !cancellation.isCancelled && !registry.isClosing; condition.unlock()
        guard current else { throw Self.unavailable }
        if phase == "assertCurrent" { return "{\"current\":true}" }
        return try Self.json(["version": 1, "clientId": binding.configuration.clientID, "redirectUri": binding.configuration.redirectURI])
    }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let input = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(input.keys) == Set(["version", "requestId"]),
              let version = input["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let requestID = input["requestId"] as? String, Self.canonicalRequestID(requestID),
              let expectedRequestID, expectedRequestID.utf8.elementsEqual(requestID.utf8), binding.isCurrent() else { throw Self.unavailable }
        condition.lock()
        guard accepting, !used, !cancellation.isCancelled, !registry.isClosing else {
            condition.unlock(); throw Self.unavailable
        }
        used = true
        let current = Job(id: "dbx:\(generation):1", requestID: requestID)
        job = current
        task = Task { [self] in
            let answer: String
            do {
                try cancellation.check()
                let grant = try await binding.authorize(requestID)
                try cancellation.check()
                guard !Task.isCancelled, binding.isCurrent() else { throw Self.unavailable }
                let value = try validatedGrant(grant, requestID: requestID)
                answer = try Self.json(["id": current.id, "value": value])
            } catch {
                answer = (try? Self.json(["id": current.id, "error": "Dropbox authorization is unavailable"])) ?? ""
            }
            finish(current, answer: answer)
        }
        condition.unlock()
        return current.id
    }

    private func validatedGrant(_ grant: NativeDropboxAuthorizationGrant, requestID: String) throws -> String {
        guard grant.requestID.utf8.elementsEqual(requestID.utf8),
              grant.clientID.utf8.elementsEqual(binding.configuration.clientID.utf8),
              grant.redirectURI.utf8.elementsEqual(binding.configuration.redirectURI.utf8),
              !grant.code.isEmpty, grant.code.utf8.count <= 8192,
              !grant.code.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              (43...128).contains(grant.codeVerifier.utf8.count),
              grant.codeVerifier.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 95, 126].contains($0) }) else { throw Self.unavailable }
        let json = try Self.json(["version": 1, "requestId": requestID, "clientId": grant.clientID,
                                 "redirectUri": grant.redirectURI, "code": grant.code, "codeVerifier": grant.codeVerifier])
        guard json.utf8.count <= 16_384 else { throw Self.unavailable }
        return json
    }
    private static func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
    private func finish(_ current: Job, answer: String) {
        condition.lock(); current.answer = answer; task = nil; condition.broadcast(); condition.unlock()
    }
    func next() -> String? {
        let ownerCurrent = binding.isCurrent()
        condition.lock(); defer { condition.unlock() }
        guard let current = job, let answer = current.answer else { return nil }
        job = nil
        guard accepting, ownerCurrent, !cancellation.isCancelled, !registry.isClosing else {
            return try? Self.json(["id": current.id, "error": "Dropbox authorization is unavailable"])
        }
        return answer
    }
    func abort(_ id: String) {
        condition.lock(); let matches = job?.id.utf8.elementsEqual(id.utf8) == true; condition.unlock()
        if matches { cancellation.cancel() }
    }
    private func retire() {
        condition.lock()
        guard accepting else { condition.unlock(); return }
        accepting = false
        if let current = job, current.answer != nil {
            current.answer = try? Self.json(["id": current.id, "error": "Dropbox authorization is unavailable"])
        }
        let pending = task, requestID = task == nil ? nil : job?.requestID
        condition.unlock()
        pending?.cancel()
        if let requestID { binding.cancel(requestID) }
    }
    func drain() {
        condition.lock()
        while task != nil { condition.wait() }
        condition.unlock()
    }
    func closeAndDrain() {
        cancellation.cancel()
        drain()
        registry.remove(registryID)
    }
}
