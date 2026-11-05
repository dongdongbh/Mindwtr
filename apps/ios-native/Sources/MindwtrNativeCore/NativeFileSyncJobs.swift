import Foundation
import SyncFileLockEngine

/// One turn's plain mailbox. Native tasks never retain or enter JavaScriptCore.
final class NativeFileSyncJobs: @unchecked Sendable {
    static let maximumEnvelope = 12 * 1024 * 1024
    let token = UUID().uuidString.lowercased()
    private var selectedRoot: URL?
    private let bookmarked: Bool
    private var prepared = false
    private var acquired = false
    var rootURI: String { withLock { selectedRoot?.absoluteString ?? "" } }
    var canonicalPath: String { withLock { selectedRoot?.appendingPathComponent("data.json", isDirectory: false).absoluteString ?? "" } }
    private func root() throws -> URL { try withLock { guard let selectedRoot else { throw Failure.unavailable }; return selectedRoot } }
    private let condition = NSCondition()
    private var session: NativeFileSyncSession!
    private var attachments: NativeFileSyncAttachments?
    private var tail: Task<Void, Never>?
    private var closing: Task<Void, Error>?
    private var closeFinished = false
    private var closeFailed = false
    private var accepting = true
    private var active = 0
    private var slots = 0
    private var sequence: UInt64 = 0
    private var replies: [(String, Data?, Bool)] = []
    private var taken: Data?
    private var takenSlot = false
    private var events: [[String: Any]] = []
    #if DEBUG
    // Observation/gating at real IO boundaries only; no replacement file or cleanup implementation.
    var afterRead: (() -> Void)?
    var afterClose: ((Bool) -> Void)?
    #endif
    enum Failure: Error { case unavailable }

    init(directoryURL: URL) throws {
        let canonical = URL(fileURLWithPath: directoryURL.path, isDirectory: true).standardizedFileURL
        guard directoryURL.isFileURL, directoryURL.host == nil || directoryURL.host == "",
              directoryURL.query == nil, directoryURL.fragment == nil,
              Data(canonical.absoluteString.utf8) == Data(directoryURL.absoluteString.utf8),
              canonical.absoluteString.utf8.count <= 16 * 1024 else { throw Failure.unavailable }
        selectedRoot = canonical
        bookmarked = false
        session = NativeFileSyncSession(selection: .pickedDirectory(canonical)) { [weak self] message, context in
            self?.withLock { self?.events.append(["message": message, "context": context]) }
        }
    }
    init(bookmark: Data) throws {
        guard !bookmark.isEmpty, bookmark.base64EncodedString().utf8.count <= 1024 * 1024 else { throw Failure.unavailable }
        bookmarked = true
        session = NativeFileSyncSession(selection: .bookmark(bookmark)) { [weak self] message, context in
            self?.withLock { self?.events.append(["message": message, "context": context]) }
        }
    }
    private func withLock<T>(_ work: () throws -> T) rethrows -> T {
        condition.lock(); defer { condition.unlock() }; return try work()
    }
    private func same(_ lhs: String, _ rhs: String) -> Bool { Data(lhs.utf8) == Data(rhs.utf8) }
    private func child(_ input: Any?) throws -> String {
        guard let uri = input as? String, uri.utf8.count <= 16 * 1024, let url = URL(string: uri),
              url.isFileURL, url.host == nil || url.host == "", url.query == nil, url.fragment == nil else { throw Failure.unavailable }
        let name = url.lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0"),
              same(try root().appendingPathComponent(name, isDirectory: false).absoluteString, uri) else { throw Failure.unavailable }
        return name
    }
    private func bytes(_ input: Any?) throws -> Data {
        guard let text = input as? String, text.utf8.count <= ((NativeFileSyncSession.maximumBytes + 2) / 3) * 4,
              let data = Data(base64Encoded: text), data.count <= NativeFileSyncSession.maximumBytes,
              same(data.base64EncodedString(), text) else { throw Failure.unavailable }
        return data
    }
    /// Cleanup admission bypasses both normal slots and cancellation. It never waits on its own request.
    func submit(_ text: String) -> String {
        let parsed = text.utf8.count <= Self.maximumEnvelope && (try? NativeJSON.hasUniqueObjectKeys(text)) == true
            ? (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] : nil
        let close = parsed?["op"] as? String == "close"
        return withLock {
            sequence += 1
            let id = "fileSync-" + token + "-" + String(sequence)
            let admitted = parsed?["turn"] as? String == token && (close || accepting && slots < 2)
            let ownsSlot = admitted && !close
            if ownsSlot { slots += 1 }
            active += 1
            let previous = tail
            let task = Task { [self] in
                // End starts closing now, rather than waiting behind an entered operation.
                if close || !admitted { _ = startClosing() }
                if let previous { await previous.value }
                var value: Any = NSNull(), body: Data?, failed = !admitted
                if admitted, let parsed {
                    do { (value, body) = try await execute(parsed) }
                    catch { failed = true }
                }
                if failed { do { try await startClosing().value } catch { } }
                let emitted = withLock { () -> [[String: Any]] in let all = events; events.removeAll(); return all }
                var answer: [String: Any] = ["id": id, "value": value, "events": emitted]
                if failed { answer = ["id": id, "error": "FILE_SYNC_PATH_OWNER_TERMINATED", "events": emitted]; body = nil }
                if body != nil { answer["body"] = true }
                var encoded = (try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys])) ?? Data()
                if encoded.count > Self.maximumEnvelope || encoded.isEmpty {
                    do { try await startClosing().value } catch { }
                    encoded = Data(("{\"id\":\"" + id + "\",\"error\":\"FILE_SYNC_PATH_OWNER_TERMINATED\"}").utf8); body = nil
                }
                withLock {
                    replies.append((String(decoding: encoded, as: UTF8.self), body, ownsSlot))
                    active -= 1
                    condition.broadcast()
                }
            }
            tail = task
            return id
        }
    }
    private func execute(_ request: [String: Any]) async throws -> (Any, Data?) {
        guard let op = request["op"] as? String else { throw Failure.unavailable }
        let fields: Set<String>
        switch op {
        case "prepare", "open", "revalidate", "close": fields = ["turn", "op"]
        case "read", "info", "list", "create": fields = ["turn", "op", "uri"]
        case "writeCreated", "deleteOwned": fields = ["turn", "op", "uri", "base64"]
        case "renameObserved": fields = ["turn", "op", "uri", "name", "base64"]
        case "attachmentInfo", "attachmentList", "attachmentDirectory": fields = ["turn", "op", "uri"]
        case "attachmentRead": fields = ["turn", "op", "uri", "position", "length"]
        case "attachmentPrepare": fields = ["turn", "op", "uri", "operationId"]
        case "attachmentWrite": fields = ["turn", "op", "uri", "base64"]
        case "attachmentSnapshot": fields = ["turn", "op", "uri", "target", "sha256"]
        case "attachmentPublish": fields = ["turn", "op", "uri", "target", "sha256", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]
        case "attachmentCleanup": fields = ["turn", "op", "uri", "target", "operationId", "sha256", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]
        default: throw Failure.unavailable
        }
        guard Set(request.keys) == fields else { throw Failure.unavailable }
        if request["base64"] == nil, try JSONSerialization.data(withJSONObject: request).count > 64 * 1024 { throw Failure.unavailable }
        if op == "close" { try await startClosing().value; return (NSNull(), nil) }
        guard withLock({ accepting }) else { throw Failure.unavailable }
        if op == "prepare" {
            guard bookmarked, !prepared, !acquired else { throw Failure.unavailable }
            let directory = try await session.openDirectory()
            guard directory.absoluteString.utf8.count <= 16 * 1024,
                  directory.appendingPathComponent("data.json", isDirectory: false).absoluteString.utf8.count <= 16 * 1024 else { throw Failure.unavailable }
            withLock { selectedRoot = directory; prepared = true }
            return (["rootURI": rootURI, "canonicalPath": canonicalPath], nil)
        }
        if op != "open" { guard acquired else { throw Failure.unavailable } }
        if op.hasPrefix("attachment") {
            try await session.revalidate()
            let owner = try withLock { () throws -> NativeFileSyncAttachments in
                guard accepting else { throw Failure.unavailable }
                if let attachments { return attachments }
                guard let selectedRoot else { throw Failure.unavailable }
                let created = NativeFileSyncAttachments(root: selectedRoot, rootURI: selectedRoot.absoluteString)
                attachments = created
                return created
            }
            return try await owner.perform(op, request)
        }
        switch op {
        case "open":
            guard !acquired else { throw Failure.unavailable }
            if bookmarked {
                guard prepared else { throw Failure.unavailable }
                try await session.revalidate()
            } else {
                let directory = try await session.openDirectory()
                guard same(directory.absoluteString, rootURI) else { throw Failure.unavailable }
            }
            acquired = true
        case "revalidate": try await session.revalidate()
        case "read":
            switch try await session.read(child(request["uri"])) {
            case .absent: return ("absent", nil)
            case .bytes(let data):
                #if DEBUG
                afterRead?()
                #endif
                return ("bytes", data)
            }
        case "info":
            if let uri = request["uri"] as? String, same(uri, rootURI) {
                try await session.revalidate(); return (["exists": true, "size": 0], nil)
            }
            guard let entry = try await session.metadata(child(request["uri"])) else { return (["exists": false], nil) }
            guard entry.kind == .file, let count = entry.byteCount, count >= 0 else { throw Failure.unavailable }
            return (["exists": true, "size": count], nil)
        case "list":
            guard let uri = request["uri"] as? String, same(uri, rootURI) else { throw Failure.unavailable }
            return (try await session.list().map { $0.name }, nil)
        case "create": return (try await session.createExclusive(child(request["uri"])) == .created ? "created" : "exists", nil)
        case "writeCreated": try await session.writeCreated(child(request["uri"]), bytes: bytes(request["base64"]))
        case "deleteOwned": try await session.deleteOwned(child(request["uri"]), expectedBytes: bytes(request["base64"]))
        case "renameObserved":
            let name = try child(request["uri"])
            guard let destination = request["name"] as? String else { throw Failure.unavailable }
            let uri = try root().appendingPathComponent(destination, isDirectory: false).absoluteString
            guard try same(child(uri), destination) else { throw Failure.unavailable }
            try await session.renameObserved(name, to: destination, expectedBytes: bytes(request["base64"]))
            return (uri, nil)
        default: throw Failure.unavailable
        }
        return (NSNull(), nil)
    }
    private func startClosing() -> Task<Void, Error> {
        withLock {
            accepting = false
            if let closing { return closing }
            let session = self.session!
            let attachments = self.attachments
            let task = Task { [self] in
                await attachments?.close()
                do {
                    try await session.close()
                    withLock { closeFinished = true; condition.broadcast() }
                    #if DEBUG
                    afterClose?(true)
                    #endif
                } catch {
                    withLock { closeFailed = true; closeFinished = true; condition.broadcast() }
                    #if DEBUG
                    afterClose?(false)
                    #endif
                    throw error
                }
            }
            closing = task
            return task
        }
    }
    func abort() { _ = startClosing() }
    /// Called on the CoreHost queue; tasks need no JS callback to reach this fence.
    func closeAndDrain() throws {
        _ = startClosing()
        condition.lock(); defer { condition.unlock() }
        while active != 0 || !closeFinished { condition.wait() }
        if closeFailed { throw Failure.unavailable }
    }
    func next() -> String? {
        withLock {
            guard taken == nil, !replies.isEmpty else { return nil }
            let reply = replies.removeFirst()
            taken = reply.1
            if taken != nil { takenSlot = reply.2 }
            else if reply.2 { slots -= 1 }
            return reply.0
        }
    }
    func body() throws -> String {
        try withLock {
            guard let data = taken else { throw Failure.unavailable }
            taken = nil
            if takenSlot { slots -= 1; takenSlot = false }
            return data.base64EncodedString()
        }
    }
}
