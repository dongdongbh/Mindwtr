import Foundation
import Darwin


public struct EditorDraftSnapshot: Codable, Sendable, Equatable {
    public let version: Int
    public let sessionID: String
    public let taskID: String
    public let generation: Int
    public let payloadJSON: String

    public init(sessionID: String, taskID: String, generation: Int, payloadJSON: String) {
        version = 1
        self.sessionID = sessionID
        self.taskID = taskID
        self.generation = generation
        self.payloadJSON = payloadJSON
    }
}

public enum EditorDraftStoreError: LocalizedError, Sendable {
    case corrupt

    public var errorDescription: String? { "Saved editor draft is unreadable" }
}

struct EditorDraftAttempt: Codable, Equatable {
    let id: String
    let sessionID: String
    let taskID: String
    let generation: Int
    let method: String
    let argumentsJSON: String
}

private struct StoredEditorDraft: Codable {
    let snapshot: EditorDraftSnapshot
    let attempt: EditorDraftAttempt?
}


struct EditorDraftStore {
    let url: URL
    private static let maxPayload = 1_000_000
    private static let maxFile = 3_000_000

    init(databaseURL: URL) { url = databaseURL.appendingPathExtension("editor-draft.json") }

    private func validUUID(_ value: String) -> Bool {
        UUID(uuidString: value)?.uuidString.lowercased() == value
    }

    private func validObject(_ text: String, limit: Int) -> Bool {
        guard text.utf8.count <= limit,
              let value = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
              value is [String: Any] else { return false }
        return true
    }

    private func validate(_ value: StoredEditorDraft) throws {
        let snapshot = value.snapshot
        guard snapshot.version == 1, validUUID(snapshot.sessionID),
              !snapshot.taskID.isEmpty, snapshot.taskID.utf8.count <= 500,
              snapshot.generation > 0, validObject(snapshot.payloadJSON, limit: Self.maxPayload) else {
            throw EditorDraftStoreError.corrupt
        }
        if let attempt = value.attempt {
            guard validUUID(attempt.id), attempt.sessionID == snapshot.sessionID,
                  attempt.taskID == snapshot.taskID, attempt.generation == snapshot.generation,
                  ["saveDraft", "checklistSave", "boardAction", "taskDelete", "taskPromote", "attachmentDraftSave"].contains(attempt.method),
                  attempt.argumentsJSON.utf8.count <= 2_000_000,
                  let arguments = try? JSONSerialization.jsonObject(with: Data(attempt.argumentsJSON.utf8)) as? [String],
                  arguments.count == 1, validObject(arguments[0], limit: 2_000_000) else {
                throw EditorDraftStoreError.corrupt
            }
            if attempt.method == "attachmentDraftSave" {
                guard snapshot.generation <= 9_007_199_254_740_991,
                      exact(attempt.sessionID, snapshot.sessionID), exact(attempt.taskID, snapshot.taskID) else {
                    throw EditorDraftStoreError.corrupt
                }
            }
        }
    }

    private func bytes() throws -> Data? {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            if errno == ELOOP { throw EditorDraftStoreError.corrupt }
            throw HostFailure("Cannot read editor draft")
        }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw HostFailure("Cannot inspect editor draft") }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_size >= 0,
              info.st_size <= off_t(Self.maxFile) else { throw EditorDraftStoreError.corrupt }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw HostFailure("Cannot read editor draft") }
            if count == 0 { break }
            guard data.count + count <= Self.maxFile else { throw EditorDraftStoreError.corrupt }
            data.append(contentsOf: buffer[..<count])
        }
        return data
    }

    func read() throws -> (snapshot: EditorDraftSnapshot, attempt: EditorDraftAttempt?)? {
        guard let data = try bytes() else { return nil }
        let stored = try decode(data)
        return (stored.snapshot, stored.attempt)
    }

    private func decode(_ data: Data) throws -> StoredEditorDraft {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(object["attempt"] == nil ? ["snapshot"] : ["snapshot", "attempt"]),
              let rawSnapshot = object["snapshot"] as? [String: Any],
              Set(rawSnapshot.keys) == Set(["version", "sessionID", "taskID", "generation", "payloadJSON"]),
              object["attempt"] == nil || (object["attempt"] as? [String: Any]).map({
                  Set($0.keys) == Set(["id", "sessionID", "taskID", "generation", "method", "argumentsJSON"])
              }) == true,
              let stored = try? JSONDecoder().decode(StoredEditorDraft.self, from: data) else {
            throw EditorDraftStoreError.corrupt
        }
        try validate(stored)
        return stored
    }


    struct OwnedCheckpoint {
        let snapshot: EditorDraftSnapshot
        let attempt: EditorDraftAttempt?
        let bytes: Data
        let device: UInt64
        let inode: UInt64
        func matches(_ other: OwnedCheckpoint) -> Bool {
            device == other.device && inode == other.inode && bytes == other.bytes
        }
    }

    private static func stable(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink
            && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec
            && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec
            && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }

    func readOwnedCheckpoint() throws -> OwnedCheckpoint? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw EditorDraftStoreError.corrupt
        }
        defer { Darwin.close(fd) }
        var before = stat()
        guard Darwin.fstat(fd, &before) == 0, before.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              before.st_nlink == 1, before.st_size >= 0, before.st_size <= off_t(Self.maxFile) else {
            throw EditorDraftStoreError.corrupt
        }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0, data.count <= Self.maxFile - count else { throw EditorDraftStoreError.corrupt }
            if count == 0 { break }
            data.append(contentsOf: buffer[..<count])
        }
        var after = stat(), named = stat()
        guard Darwin.fstat(fd, &after) == 0, Darwin.lstat(url.path, &named) == 0,
              Self.stable(before, after), Self.stable(after, named), data.count == Int(after.st_size) else {
            throw EditorDraftStoreError.corrupt
        }
        let stored = try decode(data)
        return OwnedCheckpoint(snapshot: stored.snapshot, attempt: stored.attempt, bytes: data,
            device: UInt64(before.st_dev), inode: UInt64(before.st_ino))
    }


    func checkpointOwnedMatching(before: EditorDraftSnapshot, after: EditorDraftSnapshot,
                                 binding: OwnedCheckpoint) throws -> OwnedCheckpoint {
        try validate(StoredEditorDraft(snapshot: before, attempt: nil))
        let data = try encodedBytes(after)
        guard before.generation <= 9_007_199_254_740_991, after.generation <= 9_007_199_254_740_991,
              after.generation > before.generation, exact(before.sessionID, after.sessionID),
              exact(before.taskID, after.taskID), let current = try readOwnedCheckpoint(),
              binding.matches(current), current.attempt == nil,
              matches(current.snapshot, before) || matches(current.snapshot, after) else {
            throw HostFailure("Owned editor checkpoint changed or is pending")
        }
        try DurableFile.write(data, to: url, privateDraft: true)
        guard let receipt = try readOwnedCheckpoint(), receipt.bytes == data else {
            throw EditorDraftStoreError.corrupt
        }
        return receipt
    }

    private func encodedBytes(_ snapshot: EditorDraftSnapshot, attempt: EditorDraftAttempt? = nil) throws -> Data {
        let value = StoredEditorDraft(snapshot: snapshot, attempt: attempt)
        try validate(value)
        let data = try JSONEncoder().encode(value)
        guard data.count <= Self.maxFile else { throw EditorDraftStoreError.corrupt }
        return data
    }


    func preflightCheckpoint(_ snapshot: EditorDraftSnapshot) throws { _ = try encodedBytes(snapshot) }

    private func write(_ snapshot: EditorDraftSnapshot, attempt: EditorDraftAttempt? = nil) throws {
        let data = try encodedBytes(snapshot, attempt: attempt)
        try DurableFile.write(data, to: url, privateDraft: true)
    }

    func checkpoint(_ snapshot: EditorDraftSnapshot) throws {
        try validate(StoredEditorDraft(snapshot: snapshot, attempt: nil))
        if let current = try read() {
            guard current.snapshot.sessionID == snapshot.sessionID,
                  current.snapshot.taskID == snapshot.taskID,
                  current.attempt == nil else {
                throw HostFailure("Editor draft belongs to another or pending session")
            }
            if current.snapshot == snapshot { return }
            guard snapshot.generation > current.snapshot.generation else {
                throw HostFailure("Editor draft checkpoint is stale")
            }
        }
        try write(snapshot)
    }


    func checkpointMatching(before: EditorDraftSnapshot, after: EditorDraftSnapshot) throws {
        try checkpointMatching(before: before, after: after, mode: .add)
    }


    func checkpointOwnedAdvanceMatching(before: EditorDraftSnapshot, after: EditorDraftSnapshot) throws {
        try checkpointMatching(before: before, after: after, mode: .ownedAdvance)
    }

    private enum ExactCheckpointMode { case add, ownedAdvance }
    private func checkpointMatching(before: EditorDraftSnapshot, after: EditorDraftSnapshot,
                                    mode: ExactCheckpointMode) throws {
        try validate(StoredEditorDraft(snapshot: before, attempt: nil))
        try validate(StoredEditorDraft(snapshot: after, attempt: nil))
        let next = before.generation.addingReportingOverflow(1)
        let validGeneration = mode == .add ? !next.overflow && after.generation == next.partialValue
            : before.generation <= 9_007_199_254_740_991 && after.generation <= 9_007_199_254_740_991
                && after.generation > before.generation
        guard validGeneration,
              before.sessionID == after.sessionID, before.taskID.utf8.elementsEqual(after.taskID.utf8) else {
            throw HostFailure("Editor draft checkpoint transition is invalid")
        }
        guard let current = try read(), current.attempt == nil else {
            throw HostFailure("Editor draft checkpoint is missing or pending")
        }
        if matches(current.snapshot, after) {
            if mode == .ownedAdvance { try write(after) }
            return
        }
        guard matches(current.snapshot, before) else { throw HostFailure("Editor draft checkpoint changed") }
        try write(after)
    }


    func discardMatching(expected: EditorDraftSnapshot) throws {
        try validate(StoredEditorDraft(snapshot: expected, attempt: nil))
        guard let current = try read() else { return }
        guard current.attempt == nil, matches(current.snapshot, expected) else {
            throw HostFailure("Editor draft checkpoint changed or is pending")
        }
        try DurableFile.remove(url)
    }

    private func matches(_ snapshot: EditorDraftSnapshot, _ expected: EditorDraftSnapshot) -> Bool {
        snapshot.version == expected.version && snapshot.sessionID == expected.sessionID
            && snapshot.taskID.utf8.elementsEqual(expected.taskID.utf8) && snapshot.generation == expected.generation
            && snapshot.payloadJSON.utf8.elementsEqual(expected.payloadJSON.utf8)
    }

    func freeze(sessionID: String, generation: Int, method: String, argumentsJSON: String) throws -> EditorDraftAttempt {
        guard let current = try read(), current.attempt == nil,
              current.snapshot.sessionID == sessionID, current.snapshot.generation == generation else {
            throw HostFailure("Editor draft changed before Save")
        }
        let attempt = EditorDraftAttempt(id: UUID().uuidString.lowercased(), sessionID: sessionID,
                                         taskID: current.snapshot.taskID, generation: generation,
                                         method: method, argumentsJSON: argumentsJSON)
        try write(current.snapshot, attempt: attempt)
        return attempt
    }

    func thaw(_ attempt: EditorDraftAttempt) throws {
        guard let current = try read() else { throw HostFailure("Editor draft Save attempt changed") }
        if current.attempt == nil, current.snapshot.sessionID == attempt.sessionID,
           current.snapshot.taskID == attempt.taskID, current.snapshot.generation == attempt.generation { return }
        guard current.attempt == attempt else {
            throw HostFailure("Editor draft Save attempt changed")
        }
        try write(current.snapshot)
    }

    func removeMatching(_ attempt: EditorDraftAttempt) throws {
        guard let current = try read() else { return }
        guard current.attempt == attempt else { throw HostFailure("Editor draft Save attempt changed") }
        try DurableFile.remove(url)
    }

    private func exact(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    private func ownedMatches(_ a: EditorDraftSnapshot, _ b: EditorDraftSnapshot) -> Bool {
        a.version == b.version && exact(a.sessionID, b.sessionID) && exact(a.taskID, b.taskID)
            && a.generation == b.generation && exact(a.payloadJSON, b.payloadJSON)
    }
    private func ownedMatches(_ a: EditorDraftAttempt, _ b: EditorDraftAttempt) -> Bool {
        exact(a.id, b.id) && exact(a.sessionID, b.sessionID) && exact(a.taskID, b.taskID)
            && a.generation == b.generation && exact(a.method, b.method) && exact(a.argumentsJSON, b.argumentsJSON)
    }


    func preflightOwnedSave(expected: EditorDraftSnapshot, attempt: EditorDraftAttempt) throws {
        guard attempt.method == "attachmentDraftSave" else { throw EditorDraftStoreError.corrupt }
        _ = try encodedBytes(expected, attempt: attempt)
    }


    func freezeOwnedSaveMatching(expected: EditorDraftSnapshot, attempt: EditorDraftAttempt) throws {
        try preflightOwnedSave(expected: expected, attempt: attempt)
        guard let current = try read(), ownedMatches(current.snapshot, expected),
              current.attempt.map({ ownedMatches($0, attempt) }) ?? true else {
            throw HostFailure("Owned editor Save checkpoint or attempt changed")
        }
        try write(expected, attempt: attempt)
    }


    func thawOwnedSaveMatching(expected: EditorDraftSnapshot, attempt: EditorDraftAttempt) throws {
        try preflightOwnedSave(expected: expected, attempt: attempt)
        guard let current = try read(), ownedMatches(current.snapshot, expected),
              current.attempt.map({ ownedMatches($0, attempt) }) ?? true else {
            throw HostFailure("Owned editor Save checkpoint or attempt changed")
        }
        try write(expected)
    }


    func removeOwnedSaveMatching(expected: EditorDraftSnapshot, attempt: EditorDraftAttempt) throws {
        try preflightOwnedSave(expected: expected, attempt: attempt)
        if let current = try read() {
            guard ownedMatches(current.snapshot, expected),
                  current.attempt.map({ ownedMatches($0, attempt) }) == true else {
                throw HostFailure("Owned editor Save checkpoint or attempt changed")
            }
        }
        try DurableFile.remove(url)
    }

    func discard(sessionID: String) throws {
        guard let current = try read(), current.snapshot.sessionID == sessionID,
              current.attempt == nil else { throw HostFailure("Editor draft is not editable") }
        try DurableFile.remove(url)
    }

    func discardCorrupt() throws {
        do {
            _ = try read()
            throw HostFailure("Editor draft is valid; reload before discarding")
        } catch EditorDraftStoreError.corrupt {
            try DurableFile.remove(url)
        }
    }
}
