import Foundation

public enum NativeGmail {
    private static let lock = NSLock()
    private static var prepared: NativeGmailAuthorizing?

    #if canImport(UIKit)
    @MainActor public static func prepare() {
        lock.lock(); defer { lock.unlock() }
        guard prepared == nil else { return }
        if let client = NativeGmailClient.device() { prepared = client } else { prepared = NativeGmailUnavailable() }
    }
    #endif

    static var client: NativeGmailAuthorizing {
        lock.lock(); defer { lock.unlock() }
        return prepared ?? NativeGmailUnavailable()
    }

    public static var configured: Bool {
        NativeGmailConfiguration(clientId: Bundle.main.object(forInfoDictionaryKey: "MindwtrGmailClientId") as? String,
            enabled: Bundle.main.object(forInfoDictionaryKey: "MindwtrGmailEnabled") as? Bool == true) != nil
    }

    static func receiptFolder(databaseURL: URL, rnAdoptionContainerURL: URL?) -> URL {
        if let rnAdoptionContainerURL {
            return rnAdoptionContainerURL.appendingPathComponent("Documents", isDirectory: true)
                .appendingPathComponent("GmailCapture", isDirectory: true)
        }
        return databaseURL.deletingLastPathComponent().appendingPathComponent("GmailCapture", isDirectory: true)
    }
}

protocol NativeGmailAuthorizing: Sendable {
    func status() async throws -> [String: Any]
    func connect() async throws -> [String: Any]
    func cancel() async
    func disconnect() async throws -> [String: Any]
    func get(_ path: String) async throws -> [String: Any]
}

extension NativeGmailClient: NativeGmailAuthorizing {}

struct NativeGmailUnavailable: NativeGmailAuthorizing {
    func status() async throws -> [String: Any] {
        ["available": false, "connected": false, "account": NSNull(), "accountId": NSNull()]
    }
    func connect() async throws -> [String: Any] { throw NativeGmailFailure.config }
    func cancel() async {}
    func disconnect() async throws -> [String: Any] { ["revoked": true] }
    func get(_ path: String) async throws -> [String: Any] { throw NativeGmailFailure.config }
}

final class NativeGmailJobs: @unchecked Sendable {
    static let maximumRequestBytes = 9 * 1024
    private static let operations: Set<String> = ["status", "connect", "cancel", "disconnect", "get"]
    private let condition = NSCondition()
    private let client: NativeGmailAuthorizing
    private let generation = UUID().uuidString.lowercased()
    private var sequence: UInt64 = 0
    private var answers: [String] = []
    private var running: [String: Task<Void, Never>] = [:]
    private var closed = false

    init(client: NativeGmailAuthorizing) { self.client = client }

    func submit(_ json: String) throws -> String {
        guard json.utf8.count <= Self.maximumRequestBytes, try NativeJSON.hasUniqueObjectKeys(json),
              let input = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let op = input["op"] as? String, Self.operations.contains(op),
              Set(input.keys) == (op == "get" ? ["op", "path"] : ["op"]) else { throw HostFailure("Gmail request is invalid") }
        let path = input["path"] as? String
        if op == "get" { guard let path, !path.isEmpty, path.utf8.count <= 8192 else { throw HostFailure("Gmail request is invalid") } }
        condition.lock(); defer { condition.unlock() }
        guard !closed else { throw HostFailure("Gmail capture is unavailable") }
        sequence += 1
        let id = "gmail:\(generation):\(sequence)"
        let client = client
        running[id] = Task { [weak self] in
            let answer = await Self.answer(id: id, op: op, path: path, client: client)
            self?.finish(id, answer: answer)
        }
        return id
    }

    private static func answer(id: String, op: String, path: String?, client: NativeGmailAuthorizing) async -> String {
        do {
            let value: Any
            switch op {
            case "status": value = try await client.status()
            case "connect": value = try await client.connect()
            case "cancel": await client.cancel(); value = NSNull()
            case "disconnect": value = try await client.disconnect()
            default: value = try await client.get(path ?? "")
            }
            return try json(["id": id, "value": value])
        } catch {
            let code = (error as? NativeGmailFailure ?? .other).rawValue
            return (try? json(["id": id, "error": code])) ?? #"{"id":"\#(id)","error":"E_GMAIL_OTHER"}"#
        }
    }

    private static func json(_ object: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(object) else { throw NativeGmailFailure.other }
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func finish(_ id: String, answer: String) {
        condition.lock()
        if running.removeValue(forKey: id) != nil, !closed { answers.append(answer) }
        condition.broadcast()
        condition.unlock()
    }

    func next() -> String? {
        condition.lock(); defer { condition.unlock() }
        return answers.isEmpty ? nil : answers.removeFirst()
    }

    func retireUnclaimed() {
        condition.lock()
        let pending = Array(running.values)
        running.removeAll(); answers.removeAll()
        condition.broadcast()
        condition.unlock()
        pending.forEach { $0.cancel() }
    }

    func close() {
        condition.lock(); closed = true; condition.unlock()
        retireUnclaimed()
    }
}
