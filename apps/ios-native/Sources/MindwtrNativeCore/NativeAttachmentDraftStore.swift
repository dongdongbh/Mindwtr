import Foundation
import Darwin
import CryptoKit

/// Fixed, private structural evidence only. Shared metadata and descriptor
/// ownership must be revalidated by the future host before any attachment IO.
enum NativeAttachmentDraftStoreError: LocalizedError, Equatable {
    case corrupt, io
    var errorDescription: String? {
        switch self {
        case .corrupt: return "Attachment draft capability is unavailable"
        case .io: return "Attachment draft record operation failed"
        }
    }
}

/// Called only under the existing serialized library lock. Retained evidence
/// cannot be reset or salvaged; exact saved/discarded release needs terminal authority.
struct NativeAttachmentDraftStore {
    static let maximumBytes = 8 * 1024 * 1024
    let url: URL
    init(databaseURL: URL) { url = databaseURL.appendingPathExtension("attachment-draft.json") }

    enum SessionState: String, Codable, Sendable { case active, cleanupPending }
    enum Phase: String, Codable, Sendable {
        case intent, stagePrepared, stageFilled, published, resultDurable, checkpointed
        var rank: Int {
            switch self {
            case .intent: return 0
            case .stagePrepared: return 1
            case .stageFilled: return 2
            case .published: return 3
            case .resultDurable: return 4
            case .checkpointed: return 5
            }
        }
    }
    enum Reason: String, Codable, Sendable {
        case interruptedReservation, sourceChanged, stageChanged, targetConflict
        case checkpointChanged, taskReadOnly, pendingDomainReplay, io
    }
    enum DiscardPhase: String, Codable, Sendable { case decided, detached }
    struct Record: Codable, Sendable, Equatable {
        let version: Int
        let session: Session
        let operations: [Operation]
        let discard: Discard?
        let checkpointAdvance: CheckpointAdvance?
        init(version: Int = 1, session: Session, operations: [Operation], discard: Discard? = nil,
             checkpointAdvance: CheckpointAdvance? = nil) {
            self.version = version
            self.session = session
            self.operations = operations
            self.discard = discard
            self.checkpointAdvance = checkpointAdvance
        }
        private enum CodingKeys: String, CodingKey { case version, session, operations, discard, checkpointAdvance }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decode(Int.self, forKey: .version)
            let fields = try decoder.container(keyedBy: Field.self)
            var expected: Set<String> = ["version", "session", "operations", "discard"]
            if version == 2 { expected.insert("checkpointAdvance") }
            try NativeAttachmentDraftStore.require((version == 1 || version == 2)
                && Set(fields.allKeys.map(\.stringValue)) == expected)
            session = try c.decode(Session.self, forKey: .session)
            operations = try c.decode([Operation].self, forKey: .operations)
            discard = try c.decodeIfPresent(Discard.self, forKey: .discard)
            checkpointAdvance = version == 2 ? try c.decodeIfPresent(CheckpointAdvance.self, forKey: .checkpointAdvance) : nil
        }
        func encode(to encoder: Encoder) throws {
            try NativeAttachmentDraftStore.require(version == 2 || (version == 1 && checkpointAdvance == nil))
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version)
            try c.encode(session, forKey: .session)
            try c.encode(operations, forKey: .operations)
            try c.encode(discard, forKey: .discard)
            if version == 2 { try c.encode(checkpointAdvance, forKey: .checkpointAdvance) }
        }
    }

    /// Separate V3 grammar on the same private sidecar; never upgrades Record.
    struct MixedRecord: Codable, Sendable, Equatable {
        let version: Int
        let session: Session
        let operations: [MixedOperation]
        let discard: Discard?
        let checkpointAdvance: CheckpointAdvance?
        init(version: Int = 3, session: Session, operations: [MixedOperation], discard: Discard? = nil,
             checkpointAdvance: CheckpointAdvance? = nil) {
            self.version = version
            self.session = session
            self.operations = operations
            self.discard = discard
            self.checkpointAdvance = checkpointAdvance
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, session, operations, discard, checkpointAdvance }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version)
            try NativeAttachmentDraftStore.require(version == 3 || version == 4)
            session = try c.decode(Session.self, forKey: .session)
            operations = try c.decode([MixedOperation].self, forKey: .operations)
            discard = try c.decodeIfPresent(Discard.self, forKey: .discard)
            checkpointAdvance = try c.decodeIfPresent(CheckpointAdvance.self, forKey: .checkpointAdvance)
        }
        func encode(to encoder: Encoder) throws {
            try NativeAttachmentDraftStore.require(version == 3 || version == 4)
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version)
            try c.encode(session, forKey: .session)
            try c.encode(operations, forKey: .operations)
            try c.encode(discard, forKey: .discard)
            try c.encode(checkpointAdvance, forKey: .checkpointAdvance)
        }
    }

    enum MixedOperation: Codable, Sendable, Equatable {
        case add(Operation), remove(RemoveOperation)
        private enum CodingKeys: String, CodingKey, CaseIterable { case kind, operation }
        private enum Kind: String, Codable { case add, remove }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            switch try c.decode(Kind.self, forKey: .kind) {
            case .add: self = .add(try c.decode(Operation.self, forKey: .operation))
            case .remove: self = .remove(try c.decode(RemoveOperation.self, forKey: .operation))
            }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .add(let operation):
                try c.encode(Kind.add, forKey: .kind); try c.encode(operation, forKey: .operation)
            case .remove(let operation):
                try c.encode(Kind.remove, forKey: .kind); try c.encode(operation, forKey: .operation)
            }
        }
        var requestId: String { switch self { case .add(let op): return op.requestId; case .remove(let op): return op.requestId } }
        var before: EditorDraftSnapshot { switch self { case .add(let op): return op.before; case .remove(let op): return op.before } }
        var after: EditorDraftSnapshot { switch self { case .add(let op): return op.after; case .remove(let op): return op.after } }
        var checkpointed: Bool { switch self { case .add(let op): return op.phase == .checkpointed; case .remove(let op): return op.phase == .checkpointed } }
    }

    enum RemovePhase: String, Codable, Sendable { case intent, checkpointed }
    struct RemoveOperation: Codable, Sendable, Equatable {
        let requestId: String
        let requestJSON: String
        let phase: RemovePhase
        let before: EditorDraftSnapshot
        let after: EditorDraftSnapshot
        let preparedJSON: String
        let replyJSON: String?
        init(requestId: String, requestJSON: String, phase: RemovePhase, before: EditorDraftSnapshot,
             after: EditorDraftSnapshot, preparedJSON: String, replyJSON: String? = nil) {
            self.requestId = requestId
            self.requestJSON = requestJSON
            self.phase = phase
            self.before = before
            self.after = after
            self.preparedJSON = preparedJSON
            self.replyJSON = replyJSON
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case requestId, requestJSON, phase, before, after, preparedJSON, replyJSON }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            requestId = try c.decode(String.self, forKey: .requestId)
            requestJSON = try c.decode(String.self, forKey: .requestJSON)
            phase = try c.decode(RemovePhase.self, forKey: .phase)
            before = try NativeAttachmentDraftStore.snapshot(c, forKey: .before)
            after = try NativeAttachmentDraftStore.snapshot(c, forKey: .after)
            preparedJSON = try c.decode(String.self, forKey: .preparedJSON)
            replyJSON = try c.decodeIfPresent(String.self, forKey: .replyJSON)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(requestJSON, forKey: .requestJSON)
            try c.encode(phase, forKey: .phase)
            try c.encode(before, forKey: .before)
            try c.encode(after, forKey: .after)
            try c.encode(preparedJSON, forKey: .preparedJSON)
            try c.encode(replyJSON, forKey: .replyJSON)
        }
    }

    /// Retains the exact old/new editor evidence until the separate editor CAS
    /// and its durability are acknowledged. Projection continuity is not owned here.
    struct CheckpointAdvance: Codable, Sendable, Equatable {
        let before: EditorDraftSnapshot
        let after: EditorDraftSnapshot
        init(before: EditorDraftSnapshot, after: EditorDraftSnapshot) {
            self.before = before
            self.after = after
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case before, after }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            before = try NativeAttachmentDraftStore.snapshot(c, forKey: .before)
            after = try NativeAttachmentDraftStore.snapshot(c, forKey: .after)
        }
    }

    struct Session: Codable, Sendable, Equatable {
        let sessionID: String
        let taskID: String
        let state: SessionState
        let checkpoint: EditorDraftSnapshot
        init(sessionID: String, taskID: String, state: SessionState, checkpoint: EditorDraftSnapshot) {
            self.sessionID = sessionID
            self.taskID = taskID
            self.state = state
            self.checkpoint = checkpoint
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case sessionID, taskID, state, checkpoint }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            sessionID = try c.decode(String.self, forKey: .sessionID)
            taskID = try c.decode(String.self, forKey: .taskID)
            state = try c.decode(SessionState.self, forKey: .state)
            checkpoint = try NativeAttachmentDraftStore.snapshot(c, forKey: .checkpoint)
        }
    }

    struct Operation: Codable, Sendable, Equatable {
        let requestId: String
        let requestJSON: String
        let phase: Phase
        let reason: Reason?
        let before: EditorDraftSnapshot
        let after: EditorDraftSnapshot
        let preparedJSON: String
        let targetURI: String
        let source: Source
        let stage: Stage?
        let filled: Filled?
        let published: Published?
        let replyJSON: String?
        init(requestId: String, requestJSON: String, phase: Phase, reason: Reason? = nil, before: EditorDraftSnapshot, after: EditorDraftSnapshot, preparedJSON: String, targetURI: String, source: Source, stage: Stage? = nil, filled: Filled? = nil, published: Published? = nil, replyJSON: String? = nil) {
            self.requestId = requestId
            self.requestJSON = requestJSON
            self.phase = phase
            self.reason = reason
            self.before = before
            self.after = after
            self.preparedJSON = preparedJSON
            self.targetURI = targetURI
            self.source = source
            self.stage = stage
            self.filled = filled
            self.published = published
            self.replyJSON = replyJSON
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case requestId, requestJSON, phase, reason, before, after, preparedJSON, targetURI, source, stage, filled, published, replyJSON }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            requestId = try c.decode(String.self, forKey: .requestId)
            requestJSON = try c.decode(String.self, forKey: .requestJSON)
            phase = try c.decode(Phase.self, forKey: .phase)
            reason = try c.decodeIfPresent(Reason.self, forKey: .reason)
            before = try NativeAttachmentDraftStore.snapshot(c, forKey: .before)
            after = try NativeAttachmentDraftStore.snapshot(c, forKey: .after)
            preparedJSON = try c.decode(String.self, forKey: .preparedJSON)
            targetURI = try c.decode(String.self, forKey: .targetURI)
            source = try c.decode(Source.self, forKey: .source)
            stage = try c.decodeIfPresent(Stage.self, forKey: .stage)
            filled = try c.decodeIfPresent(Filled.self, forKey: .filled)
            published = try c.decodeIfPresent(Published.self, forKey: .published)
            replyJSON = try c.decodeIfPresent(String.self, forKey: .replyJSON)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(requestJSON, forKey: .requestJSON)
            try c.encode(phase, forKey: .phase)
            try c.encode(reason, forKey: .reason)
            try c.encode(before, forKey: .before)
            try c.encode(after, forKey: .after)
            try c.encode(preparedJSON, forKey: .preparedJSON)
            try c.encode(targetURI, forKey: .targetURI)
            try c.encode(source, forKey: .source)
            try c.encode(stage, forKey: .stage)
            try c.encode(filled, forKey: .filled)
            try c.encode(published, forKey: .published)
            try c.encode(replyJSON, forKey: .replyJSON)
        }
    }

    struct Source: Codable, Sendable, Equatable {
        let sourceURI: String
        let sha256: String
        let size: Int64
        let identity: String
        let cacheRootIdentity: String
        let parentIdentity: String
        init(sourceURI: String, sha256: String, size: Int64, identity: String, cacheRootIdentity: String, parentIdentity: String) {
            self.sourceURI = sourceURI
            self.sha256 = sha256
            self.size = size
            self.identity = identity
            self.cacheRootIdentity = cacheRootIdentity
            self.parentIdentity = parentIdentity
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case sourceURI, sha256, size, identity, cacheRootIdentity, parentIdentity }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            sourceURI = try c.decode(String.self, forKey: .sourceURI)
            sha256 = try c.decode(String.self, forKey: .sha256)
            size = try c.decode(Int64.self, forKey: .size)
            identity = try c.decode(String.self, forKey: .identity)
            cacheRootIdentity = try c.decode(String.self, forKey: .cacheRootIdentity)
            parentIdentity = try c.decode(String.self, forKey: .parentIdentity)
        }
    }

    struct Stage: Codable, Sendable, Equatable {
        let uri: String
        let identity: String
        let directoryIdentity: String
        let privateDirectoryIdentity: String
        init(uri: String, identity: String, directoryIdentity: String, privateDirectoryIdentity: String) {
            self.uri = uri
            self.identity = identity
            self.directoryIdentity = directoryIdentity
            self.privateDirectoryIdentity = privateDirectoryIdentity
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case uri, identity, directoryIdentity, privateDirectoryIdentity }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            uri = try c.decode(String.self, forKey: .uri)
            identity = try c.decode(String.self, forKey: .identity)
            directoryIdentity = try c.decode(String.self, forKey: .directoryIdentity)
            privateDirectoryIdentity = try c.decode(String.self, forKey: .privateDirectoryIdentity)
        }
    }

    struct Filled: Codable, Sendable, Equatable {
        let sha256: String
        let size: Int64
        let identity: String
        init(sha256: String, size: Int64, identity: String) {
            self.sha256 = sha256
            self.size = size
            self.identity = identity
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case sha256, size, identity }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            sha256 = try c.decode(String.self, forKey: .sha256)
            size = try c.decode(Int64.self, forKey: .size)
            identity = try c.decode(String.self, forKey: .identity)
        }
    }

    struct Published: Codable, Sendable, Equatable {
        let sha256: String
        let size: Int64
        let identity: String
        let directoryIdentity: String
        init(sha256: String, size: Int64, identity: String, directoryIdentity: String) {
            self.sha256 = sha256
            self.size = size
            self.identity = identity
            self.directoryIdentity = directoryIdentity
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case sha256, size, identity, directoryIdentity }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            sha256 = try c.decode(String.self, forKey: .sha256)
            size = try c.decode(Int64.self, forKey: .size)
            identity = try c.decode(String.self, forKey: .identity)
            directoryIdentity = try c.decode(String.self, forKey: .directoryIdentity)
        }
    }

    struct Discard: Codable, Sendable, Equatable {
        let requestId: String
        let requestJSON: String
        let expected: EditorDraftSnapshot
        let phase: DiscardPhase
        let replyJSON: String?
        init(requestId: String, requestJSON: String, expected: EditorDraftSnapshot, phase: DiscardPhase, replyJSON: String? = nil) {
            self.requestId = requestId
            self.requestJSON = requestJSON
            self.expected = expected
            self.phase = phase
            self.replyJSON = replyJSON
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case requestId, requestJSON, expected, phase, replyJSON }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            requestId = try c.decode(String.self, forKey: .requestId)
            requestJSON = try c.decode(String.self, forKey: .requestJSON)
            expected = try NativeAttachmentDraftStore.snapshot(c, forKey: .expected)
            phase = try c.decode(DiscardPhase.self, forKey: .phase)
            replyJSON = try c.decodeIfPresent(String.self, forKey: .replyJSON)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(requestJSON, forKey: .requestJSON)
            try c.encode(expected, forKey: .expected)
            try c.encode(phase, forKey: .phase)
            try c.encode(replyJSON, forKey: .replyJSON)
        }
    }

    private struct Field: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private enum SnapshotFields: String, CodingKey, CaseIterable {
        case version, sessionID, taskID, generation, payloadJSON
    }
    private static func container<K: CodingKey & CaseIterable>(_ type: K.Type, from decoder: Decoder) throws -> KeyedDecodingContainer<K> {
        let fields = try decoder.container(keyedBy: Field.self)
        guard Set(fields.allKeys.map(\.stringValue)) == Set(K.allCases.map(\.stringValue)) else {
            throw NativeAttachmentDraftStoreError.corrupt
        }
        return try decoder.container(keyedBy: type)
    }
    private static func snapshot<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) throws -> EditorDraftSnapshot {
        let decoder = try c.superDecoder(forKey: key)
        _ = try container(SnapshotFields.self, from: decoder)
        return try EditorDraftSnapshot(from: decoder)
    }

    private static func equal(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }
    private static func same(_ a: EditorDraftSnapshot, _ b: EditorDraftSnapshot) -> Bool {
        a.version == b.version && equal(a.sessionID, b.sessionID) && equal(a.taskID, b.taskID)
            && a.generation == b.generation && equal(a.payloadJSON, b.payloadJSON)
    }
    private static func uuid(_ text: String) -> Bool {
        text.utf8.count == 36 && UUID(uuidString: text)?.uuidString.lowercased() == text
    }
    private static func object(_ text: String, limit: Int) -> Bool {
        text.utf8.count <= limit && (try? JSONSerialization.jsonObject(with: Data(text.utf8))) is [String: Any]
    }
    private static func digest(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func identity(_ text: String) -> Bool {
        guard text.utf8.count <= 41 else { return false }
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy {
            guard let number = UInt64($0) else { return false }
            return String(number) == $0
        }
    }
    private static func size(_ value: Int64) -> Bool { value >= 0 && value <= 9_007_199_254_740_991 }
    private static func uri(_ text: String) -> Bool {
        guard !text.isEmpty, text.utf8.count <= 16 * 1024, !text.utf8.contains(0),
              let parsed = URLComponents(string: text), parsed.scheme?.lowercased() == "file",
              parsed.host == nil || parsed.host == "", parsed.user == nil, parsed.password == nil,
              parsed.port == nil, parsed.query == nil, parsed.fragment == nil,
              let path = parsed.percentEncodedPath.removingPercentEncoding,
              path.hasPrefix("/"), !path.utf8.contains(0) else { return false }
        return !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
    }
    private static func valid(_ snapshot: EditorDraftSnapshot, safeGeneration: Bool = false) -> Bool {
        snapshot.version == 1 && uuid(snapshot.sessionID) && !snapshot.taskID.isEmpty
            && snapshot.taskID.utf8.count <= 500 && snapshot.generation > 0
            && (!safeGeneration || snapshot.generation <= 9_007_199_254_740_991)
            && object(snapshot.payloadJSON, limit: 1_000_000)
    }
    private static func require(_ condition: Bool) throws {
        guard condition else { throw NativeAttachmentDraftStoreError.corrupt }
    }

    private static func validate(_ record: Record) throws {
        let session = record.session
        let v2 = record.version == 2
        try require((record.version == 1 || v2) && (v2 || record.checkpointAdvance == nil)
                    && uuid(session.sessionID) && !session.taskID.isEmpty
                    && session.taskID.utf8.count <= 500 && valid(session.checkpoint, safeGeneration: v2)
                    && equal(session.checkpoint.sessionID, session.sessionID)
                    && equal(session.checkpoint.taskID, session.taskID) && record.operations.count <= 128)
        var ids = Set<String>()
        var prior: EditorDraftSnapshot?
        // Raw UTF-8 is a lower bound on encoded size. Refuse excessive models
        // before encoding, then enforce the actual complete JSON byte bound.
        var rawBytes = 0
        func account(_ strings: [String]) throws {
            for text in strings {
                try require(text.utf8.count <= maximumBytes - rawBytes)
                rawBytes += text.utf8.count
            }
        }
        func accountSnapshot(_ snapshot: EditorDraftSnapshot) throws {
            try account([snapshot.sessionID, snapshot.taskID, snapshot.payloadJSON])
        }
        try account([session.sessionID, session.taskID]); try accountSnapshot(session.checkpoint)
        for (index, op) in record.operations.enumerated() {
            let next = op.before.generation.addingReportingOverflow(1)
            try require(uuid(op.requestId) && ids.insert(op.requestId).inserted
                        && object(op.requestJSON, limit: 64 * 1024) && object(op.preparedJSON, limit: 2 * 1024 * 1024)
                        && valid(op.before, safeGeneration: v2) && valid(op.after, safeGeneration: v2)
                        && !next.overflow && op.after.generation == next.partialValue
                        && equal(op.before.sessionID, session.sessionID) && equal(op.after.sessionID, session.sessionID)
                        && equal(op.before.taskID, session.taskID) && equal(op.after.taskID, session.taskID)
                        && uri(op.targetURI) && uri(op.source.sourceURI) && digest(op.source.sha256)
                        && size(op.source.size) && identity(op.source.identity)
                        && identity(op.source.cacheRootIdentity) && identity(op.source.parentIdentity))
            if let prior {
                try require(v2 ? op.before.generation >= prior.generation
                    && (op.before.generation != prior.generation || same(op.before, prior)) : same(op.before, prior))
            }
            if index < record.operations.count - 1 { try require(op.phase == .checkpointed && op.reason == nil) }
            if op.phase == .checkpointed { try require(op.reason == nil) }
            try require((op.stage != nil) == (op.phase.rank >= Phase.stagePrepared.rank)
                        && (op.filled != nil) == (op.phase.rank >= Phase.stageFilled.rank)
                        && (op.published != nil) == (op.phase.rank >= Phase.published.rank)
                        && (op.replyJSON != nil) == (op.phase.rank >= Phase.resultDurable.rank))
            try account([op.requestId, op.requestJSON, op.preparedJSON, op.targetURI, op.source.sourceURI,
                         op.source.sha256, op.source.identity, op.source.cacheRootIdentity, op.source.parentIdentity])
            try accountSnapshot(op.before); try accountSnapshot(op.after)
            if let stage = op.stage {
                try require(uri(stage.uri) && identity(stage.identity) && identity(stage.directoryIdentity)
                            && identity(stage.privateDirectoryIdentity))
                try account([stage.uri, stage.identity, stage.directoryIdentity, stage.privateDirectoryIdentity])
            }
            if let filled = op.filled {
                try require(digest(filled.sha256) && size(filled.size) && identity(filled.identity)
                            && filled.identity == op.stage?.identity && filled.sha256 == op.source.sha256 && filled.size == op.source.size)
                try account([filled.sha256, filled.identity])
            }
            if let published = op.published {
                try require(digest(published.sha256) && size(published.size) && identity(published.identity)
                            && identity(published.directoryIdentity) && published.identity == op.stage?.identity
                            && published.directoryIdentity == op.stage?.directoryIdentity
                            && published.sha256 == op.filled?.sha256 && published.size == op.filled?.size)
                try account([published.sha256, published.identity, published.directoryIdentity])
            }
            if let reply = op.replyJSON { try require(object(reply, limit: 64 * 1024)); try account([reply]) }
            prior = op.after
        }
        if let last = record.operations.last {
            if v2 && last.phase == .checkpointed {
                try require(session.checkpoint.generation >= last.after.generation
                    && (session.checkpoint.generation != last.after.generation || same(session.checkpoint, last.after)))
            } else { try require(same(session.checkpoint, last.phase == .checkpointed ? last.after : last.before)) }
        }
        if let advance = record.checkpointAdvance {
            try require(v2 && session.state == .active && record.discard == nil
                && record.operations.allSatisfy { $0.phase == .checkpointed }
                && valid(advance.before, safeGeneration: true) && valid(advance.after, safeGeneration: true)
                && same(session.checkpoint, advance.before) && advance.after.generation > advance.before.generation
                && equal(advance.after.sessionID, session.sessionID) && equal(advance.after.taskID, session.taskID))
            try accountSnapshot(advance.before); try accountSnapshot(advance.after)
        }
        try require((session.state == .cleanupPending) == (record.discard != nil))
        if let discard = record.discard {
            try require(uuid(discard.requestId) && ids.insert(discard.requestId).inserted
                        && object(discard.requestJSON, limit: 64 * 1024) && valid(discard.expected, safeGeneration: v2)
                        && same(discard.expected, session.checkpoint)
                        && (discard.replyJSON != nil) == (discard.phase == .detached))
            try account([discard.requestId, discard.requestJSON]); try accountSnapshot(discard.expected)
            if let reply = discard.replyJSON { try require(object(reply, limit: 64 * 1024)); try account([reply]) }
        }
    }

    private static func sameSource(_ a: Source, _ b: Source) -> Bool {
        a == b && equal(a.sourceURI, b.sourceURI)
    }
    private static func sameStage(_ a: Stage, _ b: Stage) -> Bool { a == b && equal(a.uri, b.uri) }
    private static func sameOptionalString(_ a: String?, _ b: String?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case (let a?, let b?): return equal(a, b)
        default: return false
        }
    }
    private static func sameOperation(_ a: Operation, _ b: Operation) -> Bool {
        let stageMatches: Bool
        switch (a.stage, b.stage) {
        case (nil, nil): stageMatches = true
        case (let a?, let b?): stageMatches = sameStage(a, b)
        default: stageMatches = false
        }
        return equal(a.requestId, b.requestId) && equal(a.requestJSON, b.requestJSON)
            && a.phase == b.phase && a.reason == b.reason && same(a.before, b.before) && same(a.after, b.after)
            && equal(a.preparedJSON, b.preparedJSON) && equal(a.targetURI, b.targetURI) && sameSource(a.source, b.source)
            && stageMatches && a.filled == b.filled && a.published == b.published && sameOptionalString(a.replyJSON, b.replyJSON)
    }
    private static func retainedOperation(_ old: Operation, in new: Operation) throws {
        try require(old.requestId == new.requestId && equal(old.requestJSON, new.requestJSON)
                    && same(old.before, new.before) && same(old.after, new.after)
                    && equal(old.preparedJSON, new.preparedJSON) && equal(old.targetURI, new.targetURI)
                    && sameSource(old.source, new.source) && new.phase.rank >= old.phase.rank)
        if let stage = old.stage { try require(new.stage.map { sameStage(stage, $0) } == true) }
        if let filled = old.filled { try require(new.filled == filled) }
        if let published = old.published { try require(new.published == published) }
        if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
    }
    private static func retainedAdvance(_ previous: Record, in current: Record) throws {
        try require(previous.session.state == .active && current.session.state == .active
            && previous.discard == nil && current.discard == nil
            && previous.operations.count == current.operations.count
            && zip(previous.operations, current.operations).allSatisfy { sameOperation($0.0, $0.1) })
        switch (previous.checkpointAdvance, current.checkpointAdvance) {
        case (nil, let next?):
            try require(same(previous.session.checkpoint, current.session.checkpoint)
                && same(next.before, previous.session.checkpoint))
        case (let old?, let next?):
            try require(same(old.before, next.before) && same(old.after, next.after)
                && same(previous.session.checkpoint, current.session.checkpoint))
        case (let old?, nil):
            try require(same(current.session.checkpoint, old.after))
        case (nil, nil): throw NativeAttachmentDraftStoreError.corrupt
        }
    }
    private static func retained(_ previous: Record, in current: Record) throws {
        try require(previous.version == current.version
                    && equal(previous.session.sessionID, current.session.sessionID)
                    && equal(previous.session.taskID, current.session.taskID)
                    && current.operations.count >= previous.operations.count
                    && current.operations.count <= previous.operations.count + 1)
        if previous.version == 2 && (previous.checkpointAdvance != nil || current.checkpointAdvance != nil) {
            try retainedAdvance(previous, in: current)
            return
        }
        for (old, new) in zip(previous.operations, current.operations) {
            try retainedOperation(old, in: new)
        }
        if current.operations.count > previous.operations.count {
            try require(previous.session.state == .active && current.session.state == .active
                        && previous.discard == nil && current.discard == nil
                        && (previous.operations.last == nil || previous.operations.last?.phase == .checkpointed))
            try require(same(current.operations[previous.operations.count].before, previous.session.checkpoint))
        } else if previous.operations.isEmpty {
            try require(same(previous.session.checkpoint, current.session.checkpoint))
        }
        if previous.version == 2 && !same(previous.session.checkpoint, current.session.checkpoint) {
            guard previous.operations.count == current.operations.count,
                  let old = previous.operations.last, let new = current.operations.last else {
                throw NativeAttachmentDraftStoreError.corrupt
            }
            try require(old.phase != .checkpointed && new.phase == .checkpointed
                && same(current.session.checkpoint, new.after))
        }
        if let old = previous.discard {
            guard let new = current.discard else { throw NativeAttachmentDraftStoreError.corrupt }
            try require(old.requestId == new.requestId && equal(old.requestJSON, new.requestJSON) && same(old.expected, new.expected)
                        && (old.phase == .decided || new.phase == .detached))
            if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
        }
    }

    private struct RemoveRequest: Decodable {
        let version: Int, generation: Int
        let requestId: String, sessionID: String, attachmentId: String
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, requestId, sessionID, generation, attachmentId }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version)
            generation = try c.decode(Int.self, forKey: .generation)
            requestId = try c.decode(String.self, forKey: .requestId)
            sessionID = try c.decode(String.self, forKey: .sessionID)
            attachmentId = try c.decode(String.self, forKey: .attachmentId)
        }
    }
    private struct RemoveFrozen: Decodable {
        let version: Int
        let kind: String, taskID: String, requestId: String, attachmentId: String, removedAt: String
        let beforePayloadJSON: String, afterPayloadJSON: String
        private enum CodingKeys: String, CodingKey, CaseIterable {
            case version, kind, taskID, requestId, attachmentId, removedAt, beforePayloadJSON, afterPayloadJSON
        }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version)
            kind = try c.decode(String.self, forKey: .kind)
            taskID = try c.decode(String.self, forKey: .taskID)
            requestId = try c.decode(String.self, forKey: .requestId)
            attachmentId = try c.decode(String.self, forKey: .attachmentId)
            removedAt = try c.decode(String.self, forKey: .removedAt)
            beforePayloadJSON = try c.decode(String.self, forKey: .beforePayloadJSON)
            afterPayloadJSON = try c.decode(String.self, forKey: .afterPayloadJSON)
        }
    }
    private struct RemoveReply: Decodable {
        let version: Int, generation: Int
        let status: String, requestId: String, sessionID: String, attachmentId: String
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, status, requestId, sessionID, generation, attachmentId }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version)
            generation = try c.decode(Int.self, forKey: .generation)
            status = try c.decode(String.self, forKey: .status)
            requestId = try c.decode(String.self, forKey: .requestId)
            sessionID = try c.decode(String.self, forKey: .sessionID)
            attachmentId = try c.decode(String.self, forKey: .attachmentId)
        }
    }
    private static func validate(_ op: RemoveOperation) throws {
        try require(uuid(op.requestId) && object(op.requestJSON, limit: 64 * 1024)
            && object(op.preparedJSON, limit: 2 * 1024 * 1024)
            && (op.replyJSON != nil) == (op.phase == .checkpointed))
        let request: RemoveRequest, frozen: RemoveFrozen
        do {
            request = try JSONDecoder().decode(RemoveRequest.self, from: Data(op.requestJSON.utf8))
            frozen = try JSONDecoder().decode(RemoveFrozen.self, from: Data(op.preparedJSON.utf8))
        } catch { throw NativeAttachmentDraftStoreError.corrupt }
        try require(request.version == 1 && equal(request.requestId, op.requestId)
            && equal(request.sessionID, op.before.sessionID) && request.generation == op.before.generation
            && !request.attachmentId.isEmpty && request.attachmentId.utf16.count <= 500
            && frozen.version == 1 && frozen.kind == "prepared-file-remove"
            && equal(frozen.taskID, op.before.taskID) && equal(frozen.requestId, op.requestId)
            && equal(frozen.attachmentId, request.attachmentId)
            && equal(frozen.beforePayloadJSON, op.before.payloadJSON) && equal(frozen.afterPayloadJSON, op.after.payloadJSON)
            && !frozen.removedAt.isEmpty && frozen.removedAt.utf8.count <= 100)
        // Timestamp canonicality and the full RN soft-delete projection belong
        // to the shared V3 authority. This structural store preserves the bytes.
        if let replyJSON = op.replyJSON {
            try require(object(replyJSON, limit: 64 * 1024))
            let reply: RemoveReply
            do { reply = try JSONDecoder().decode(RemoveReply.self, from: Data(replyJSON.utf8)) }
            catch { throw NativeAttachmentDraftStoreError.corrupt }
            try require(reply.version == 1 && reply.status == "draftRemoved"
                && equal(reply.requestId, op.requestId) && equal(reply.sessionID, op.after.sessionID)
                && reply.generation == op.after.generation && equal(reply.attachmentId, request.attachmentId))
        }
    }
    private static func rawStrings(_ op: Operation) -> [String] {
        var strings = [op.requestId, op.requestJSON, op.preparedJSON, op.targetURI, op.source.sourceURI,
                       op.source.sha256, op.source.identity, op.source.cacheRootIdentity, op.source.parentIdentity]
        if let stage = op.stage { strings += [stage.uri, stage.identity, stage.directoryIdentity, stage.privateDirectoryIdentity] }
        if let filled = op.filled { strings += [filled.sha256, filled.identity] }
        if let published = op.published { strings += [published.sha256, published.identity, published.directoryIdentity] }
        if let reply = op.replyJSON { strings.append(reply) }
        return strings
    }
    private static func validate(_ record: MixedRecord) throws {
        let session = record.session
        try require((record.version == 3 || record.version == 4) && record.operations.count <= 128)
        // Reuse the existing V2 session/Discard/advance grammar, without
        // widening its decoder or persisting a synthetic legacy record.
        try validate(Record(version: 2, session: session, operations: [], discard: record.discard,
                            checkpointAdvance: record.checkpointAdvance))
        var ids = Set<String>(), prior: EditorDraftSnapshot?
        var rawBytes = 0
        func account(_ strings: [String]) throws {
            for text in strings {
                try require(text.utf8.count <= maximumBytes - rawBytes)
                rawBytes += text.utf8.count
            }
        }
        func accountSnapshot(_ snapshot: EditorDraftSnapshot) throws {
            try account([snapshot.sessionID, snapshot.taskID, snapshot.payloadJSON])
        }
        try account([session.sessionID, session.taskID]); try accountSnapshot(session.checkpoint)
        for (index, entry) in record.operations.enumerated() {
            let next = entry.before.generation.addingReportingOverflow(1)
            try require(uuid(entry.requestId) && ids.insert(entry.requestId).inserted
                && valid(entry.before, safeGeneration: true) && valid(entry.after, safeGeneration: true)
                && !next.overflow && entry.after.generation == next.partialValue
                && equal(entry.before.sessionID, session.sessionID) && equal(entry.after.sessionID, session.sessionID)
                && equal(entry.before.taskID, session.taskID) && equal(entry.after.taskID, session.taskID))
            if let prior {
                try require(entry.before.generation >= prior.generation
                    && (entry.before.generation != prior.generation || same(entry.before, prior)))
            }
            if index < record.operations.count - 1 { try require(entry.checkpointed) }
            try accountSnapshot(entry.before); try accountSnapshot(entry.after)
            switch entry {
            case .add(let op):
                if record.version == 4 {
                    let frozen = try JSONSerialization.jsonObject(with: Data(op.preparedJSON.utf8)) as? [String: Any]
                    let keys = Set(["version", "kind", "taskID", "requestId", "picked", "measuredSize", "managedDirectoryURI",
                        "beforePayloadJSON", "afterPayloadJSON", "prepared", "targetURI", "attachment", "sourceSha256"])
                    try require(frozen != nil && Set(frozen!.keys) == keys
                        && (frozen!["version"] as? NSNumber)?.doubleValue == 2)
                    let source = (frozen!["prepared"] as? [String: Any])?["attachment"] as? [String: Any]
                    let completed = frozen!["attachment"] as? [String: Any]
                    try require((frozen!["sourceSha256"] as? String).map { equal($0, op.source.sha256) } == true
                        && (source?["fileHash"] as? String).map { equal($0, op.source.sha256) } == true
                        && (completed?["fileHash"] as? String).map { equal($0, op.source.sha256) } == true)
                }
                try account(rawStrings(op))
                // Private structural view only: the original mixed owner and
                // all tagged continuity checks above remain authoritative here.
                let checkpoint = op.phase == .checkpointed ? op.after : op.before
                try validate(Record(version: 2, session: Session(sessionID: session.sessionID, taskID: session.taskID,
                    state: .active, checkpoint: checkpoint), operations: [op]))
            case .remove(let op):
                try account([op.requestId, op.requestJSON, op.preparedJSON])
                if let reply = op.replyJSON { try account([reply]) }
                try validate(op)
            }
            prior = entry.after
        }
        if let last = record.operations.last {
            if last.checkpointed {
                try require(session.checkpoint.generation >= last.after.generation
                    && (session.checkpoint.generation != last.after.generation || same(session.checkpoint, last.after)))
            } else { try require(same(session.checkpoint, last.before)) }
        }
        if let advance = record.checkpointAdvance {
            try require(record.operations.allSatisfy { $0.checkpointed })
            try accountSnapshot(advance.before); try accountSnapshot(advance.after)
        }
        if let discard = record.discard {
            try require(ids.insert(discard.requestId).inserted)
            try account([discard.requestId, discard.requestJSON]); try accountSnapshot(discard.expected)
            if let reply = discard.replyJSON { try account([reply]) }
        }
    }
    private static func sameRemoveIdentity(_ a: RemoveOperation, _ b: RemoveOperation) -> Bool {
        equal(a.requestId, b.requestId) && equal(a.requestJSON, b.requestJSON)
            && same(a.before, b.before) && same(a.after, b.after) && equal(a.preparedJSON, b.preparedJSON)
    }
    private static func sameMixedOperation(_ a: MixedOperation, _ b: MixedOperation) -> Bool {
        switch (a, b) {
        case (.add(let old), .add(let new)): return sameOperation(old, new)
        case (.remove(let old), .remove(let new)):
            return sameRemoveIdentity(old, new) && old.phase == new.phase && sameOptionalString(old.replyJSON, new.replyJSON)
        default: return false
        }
    }
    private static func retained(_ previous: MixedRecord, in current: MixedRecord) throws {
        try require(previous.version == current.version && equal(previous.session.sessionID, current.session.sessionID)
            && equal(previous.session.taskID, current.session.taskID)
            && current.operations.count >= previous.operations.count && current.operations.count <= previous.operations.count + 1)
        if previous.checkpointAdvance != nil || current.checkpointAdvance != nil {
            try require(previous.session.state == .active && current.session.state == .active
                && previous.discard == nil && current.discard == nil
                && previous.operations.count == current.operations.count
                && zip(previous.operations, current.operations).allSatisfy { sameMixedOperation($0.0, $0.1) })
            switch (previous.checkpointAdvance, current.checkpointAdvance) {
            case (nil, let next?):
                try require(same(previous.session.checkpoint, current.session.checkpoint) && same(next.before, previous.session.checkpoint))
            case (let old?, let next?):
                try require(same(old.before, next.before) && same(old.after, next.after)
                    && same(previous.session.checkpoint, current.session.checkpoint))
            case (let old?, nil): try require(same(current.session.checkpoint, old.after))
            case (nil, nil): throw NativeAttachmentDraftStoreError.corrupt
            }
            return
        }
        for (old, new) in zip(previous.operations, current.operations) {
            switch (old, new) {
            case (.add(let old), .add(let new)): try retainedOperation(old, in: new)
            case (.remove(let old), .remove(let new)):
                try require(sameRemoveIdentity(old, new) && (old.phase == .intent || new.phase == .checkpointed))
                if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
            default: throw NativeAttachmentDraftStoreError.corrupt
            }
        }
        if current.operations.count > previous.operations.count {
            try require(previous.session.state == .active && current.session.state == .active
                && previous.discard == nil && current.discard == nil
                && previous.operations.allSatisfy { $0.checkpointed }
                && same(current.operations[previous.operations.count].before, previous.session.checkpoint))
        } else if previous.operations.isEmpty {
            try require(same(previous.session.checkpoint, current.session.checkpoint))
        }
        if !same(previous.session.checkpoint, current.session.checkpoint) {
            guard previous.operations.count == current.operations.count,
                  let old = previous.operations.last, let new = current.operations.last else {
                throw NativeAttachmentDraftStoreError.corrupt
            }
            try require(!old.checkpointed && new.checkpointed && same(current.session.checkpoint, new.after))
        }
        if let old = previous.discard {
            guard let new = current.discard else { throw NativeAttachmentDraftStoreError.corrupt }
            try require(equal(old.requestId, new.requestId) && equal(old.requestJSON, new.requestJSON)
                && same(old.expected, new.expected) && (old.phase == .decided || new.phase == .detached))
            if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
        }
    }


    /// Selected history5 structural evidence; deliberately excluded from VersionedRecord/ordinary boot.
    struct AvailabilityRecord: Codable, Sendable, Equatable {
        let version: Int
        let session: Session
        let operations: [AvailabilityOperation]
        let discard: Discard?
        let checkpointAdvance: CheckpointAdvance?
        init(version: Int = 5, session: Session, operations: [AvailabilityOperation], discard: Discard? = nil,
             checkpointAdvance: CheckpointAdvance? = nil) {
            self.version = version; self.session = session; self.operations = operations
            self.discard = discard; self.checkpointAdvance = checkpointAdvance
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, session, operations, discard, checkpointAdvance }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version)
            try NativeAttachmentDraftStore.require(version == 5)
            session = try c.decode(Session.self, forKey: .session)
            operations = try c.decode([AvailabilityOperation].self, forKey: .operations)
            discard = try c.decodeIfPresent(Discard.self, forKey: .discard)
            checkpointAdvance = try c.decodeIfPresent(CheckpointAdvance.self, forKey: .checkpointAdvance)
        }
        func encode(to encoder: Encoder) throws {
            try NativeAttachmentDraftStore.require(version == 5)
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version); try c.encode(session, forKey: .session)
            try c.encode(operations, forKey: .operations); try c.encode(discard, forKey: .discard)
            try c.encode(checkpointAdvance, forKey: .checkpointAdvance)
        }
    }
    enum AvailabilityResource: Codable, Sendable, Equatable {
        case none
        // Published is a generation descriptor here, never creation/deletion authority.
        case borrowed(proof: Published)
        case owned(source: Source, stage: Stage?, filled: Filled?, published: Published?)
        private enum CodingKeys: String, CodingKey { case kind, proof, source, stage, filled, published }
        private enum Kind: String, Codable { case none, borrowed, owned }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let fields = try decoder.container(keyedBy: Field.self)
            let kind = try c.decode(Kind.self, forKey: .kind)
            let expected: Set<String>
            switch kind {
            case .none: expected = ["kind"]
            case .borrowed: expected = ["kind", "proof"]
            case .owned: expected = ["kind", "source", "stage", "filled", "published"]
            }
            try NativeAttachmentDraftStore.require(Set(fields.allKeys.map(\.stringValue)) == expected)
            switch kind {
            case .none: self = .none
            case .borrowed: self = .borrowed(proof: try c.decode(Published.self, forKey: .proof))
            case .owned: self = .owned(source: try c.decode(Source.self, forKey: .source),
                stage: try c.decodeIfPresent(Stage.self, forKey: .stage), filled: try c.decodeIfPresent(Filled.self, forKey: .filled),
                published: try c.decodeIfPresent(Published.self, forKey: .published))
            }
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .none: try c.encode(Kind.none, forKey: .kind)
            case .borrowed(let proof): try c.encode(Kind.borrowed, forKey: .kind); try c.encode(proof, forKey: .proof)
            case .owned(let source, let stage, let filled, let published):
                try c.encode(Kind.owned, forKey: .kind); try c.encode(source, forKey: .source)
                try c.encode(stage, forKey: .stage); try c.encode(filled, forKey: .filled); try c.encode(published, forKey: .published)
            }
        }
    }
    struct AvailabilityOperation: Codable, Sendable, Equatable {
        let requestId: String
        let requestJSON: String
        let attachmentId: String
        let identity: String
        let phase: Phase
        let reason: Reason?
        let before: EditorDraftSnapshot
        let after: EditorDraftSnapshot
        let preparedJSON: String
        let targetURI: String?
        let resource: AvailabilityResource
        let replyJSON: String?
        init(requestId: String, requestJSON: String, attachmentId: String, identity: String, phase: Phase,
             reason: Reason? = nil, before: EditorDraftSnapshot, after: EditorDraftSnapshot, preparedJSON: String,
             targetURI: String?, resource: AvailabilityResource, replyJSON: String? = nil) {
            self.requestId = requestId; self.requestJSON = requestJSON; self.attachmentId = attachmentId; self.identity = identity
            self.phase = phase; self.reason = reason; self.before = before; self.after = after; self.preparedJSON = preparedJSON
            self.targetURI = targetURI; self.resource = resource; self.replyJSON = replyJSON
        }
        private enum CodingKeys: String, CodingKey, CaseIterable {
            case requestId, requestJSON, attachmentId, identity, phase, reason, before, after, preparedJSON, targetURI, resource, replyJSON
        }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            requestId = try c.decode(String.self, forKey: .requestId); requestJSON = try c.decode(String.self, forKey: .requestJSON)
            attachmentId = try c.decode(String.self, forKey: .attachmentId); identity = try c.decode(String.self, forKey: .identity)
            phase = try c.decode(Phase.self, forKey: .phase); reason = try c.decodeIfPresent(Reason.self, forKey: .reason)
            before = try NativeAttachmentDraftStore.snapshot(c, forKey: .before); after = try NativeAttachmentDraftStore.snapshot(c, forKey: .after)
            preparedJSON = try c.decode(String.self, forKey: .preparedJSON); targetURI = try c.decodeIfPresent(String.self, forKey: .targetURI)
            resource = try c.decode(AvailabilityResource.self, forKey: .resource); replyJSON = try c.decodeIfPresent(String.self, forKey: .replyJSON)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(requestId, forKey: .requestId); try c.encode(requestJSON, forKey: .requestJSON)
            try c.encode(attachmentId, forKey: .attachmentId); try c.encode(identity, forKey: .identity)
            try c.encode(phase, forKey: .phase); try c.encode(reason, forKey: .reason)
            try c.encode(before, forKey: .before); try c.encode(after, forKey: .after); try c.encode(preparedJSON, forKey: .preparedJSON)
            try c.encode(targetURI, forKey: .targetURI); try c.encode(resource, forKey: .resource); try c.encode(replyJSON, forKey: .replyJSON)
        }
    }
    private struct AvailabilityRequest: Decodable {
        let version: Int, generation: Int
        let requestId: String, sessionID: String, attachmentId: String, identity: String
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, requestId, sessionID, generation, attachmentId, identity }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version); generation = try c.decode(Int.self, forKey: .generation)
            requestId = try c.decode(String.self, forKey: .requestId); sessionID = try c.decode(String.self, forKey: .sessionID)
            attachmentId = try c.decode(String.self, forKey: .attachmentId); identity = try c.decode(String.self, forKey: .identity)
        }
    }
    private struct AvailabilityFrozen: Decodable {
        let version: Int
        let kind: String, taskID: String, requestId: String, attachmentId: String, identity: String
        let beforePayloadJSON: String, afterPayloadJSON: String, status: String, resolvedAttachmentJSON: String
        private enum CodingKeys: String, CodingKey, CaseIterable {
            case version, kind, taskID, requestId, attachmentId, identity, beforePayloadJSON, afterPayloadJSON, status, resolvedAttachmentJSON
        }
        init(from decoder: Decoder) throws {
            let c = try NativeAttachmentDraftStore.container(CodingKeys.self, from: decoder)
            version = try c.decode(Int.self, forKey: .version); kind = try c.decode(String.self, forKey: .kind)
            taskID = try c.decode(String.self, forKey: .taskID); requestId = try c.decode(String.self, forKey: .requestId)
            attachmentId = try c.decode(String.self, forKey: .attachmentId); identity = try c.decode(String.self, forKey: .identity)
            beforePayloadJSON = try c.decode(String.self, forKey: .beforePayloadJSON); afterPayloadJSON = try c.decode(String.self, forKey: .afterPayloadJSON)
            status = try c.decode(String.self, forKey: .status); resolvedAttachmentJSON = try c.decode(String.self, forKey: .resolvedAttachmentJSON)
        }
    }
    private static func sameAvailabilityIdentity(_ a: AvailabilityOperation, _ b: AvailabilityOperation) -> Bool {
        equal(a.requestId, b.requestId) && equal(a.requestJSON, b.requestJSON) && equal(a.attachmentId, b.attachmentId)
            && equal(a.identity, b.identity) && same(a.before, b.before) && same(a.after, b.after)
            && equal(a.preparedJSON, b.preparedJSON) && sameOptionalString(a.targetURI, b.targetURI)
    }
    private static func retainedResource(_ old: AvailabilityResource, in new: AvailabilityResource) throws {
        switch (old, new) {
        case (.none, .none): break
        case (.borrowed(let a), .borrowed(let b)): try require(a == b)
        case (.owned(let a, let stage, let filled, let published), .owned(let b, let nextStage, let nextFilled, let nextPublished)):
            try require(sameSource(a, b))
            if let stage { try require(nextStage.map { sameStage(stage, $0) } == true) }
            if let filled { try require(nextFilled == filled) }
            if let published { try require(nextPublished == published) }
        default: throw NativeAttachmentDraftStoreError.corrupt
        }
    }
    private static func sameAvailabilityOperation(_ a: AvailabilityOperation, _ b: AvailabilityOperation) -> Bool {
        guard sameAvailabilityIdentity(a, b), a.phase == b.phase, a.reason == b.reason,
              sameOptionalString(a.replyJSON, b.replyJSON) else { return false }
        switch (a.resource, b.resource) {
        case (.none, .none): return true
        case (.borrowed(let a), .borrowed(let b)): return a == b
        case (.owned(let a, let stage, let filled, let published), .owned(let b, let otherStage, let otherFilled, let otherPublished)):
            let exactStage: Bool
            switch (stage, otherStage) {
            case (nil, nil): exactStage = true
            case (let a?, let b?): exactStage = sameStage(a, b)
            default: exactStage = false
            }
            return sameSource(a, b) && exactStage && filled == otherFilled && published == otherPublished
        default: return false
        }
    }
    private static func validate(_ record: AvailabilityRecord) throws {
        let session = record.session
        try require(record.version == 5 && record.operations.count <= 128)
        try validate(Record(version: 2, session: session, operations: [], discard: record.discard, checkpointAdvance: record.checkpointAdvance))
        var ids = Set<String>(), prior: EditorDraftSnapshot?, rawBytes = 0
        func account(_ texts: [String]) throws {
            for text in texts { try require(text.utf8.count <= maximumBytes - rawBytes); rawBytes += text.utf8.count }
        }
        func accountSnapshot(_ snapshot: EditorDraftSnapshot) throws { try account([snapshot.sessionID, snapshot.taskID, snapshot.payloadJSON]) }
        try account([session.sessionID, session.taskID]); try accountSnapshot(session.checkpoint)
        for (index, op) in record.operations.enumerated() {
            let next = op.before.generation.addingReportingOverflow(1)
            try require(uuid(op.requestId) && ids.insert(op.requestId).inserted
                && !op.attachmentId.isEmpty && op.attachmentId.utf16.count <= 500 && op.attachmentId.utf8.count <= 2000
                && !op.identity.isEmpty && op.identity.utf8.count <= 1_000_000
                && object(op.requestJSON, limit: 64 * 1024) && object(op.preparedJSON, limit: 2 * 1024 * 1024)
                && valid(op.before, safeGeneration: true) && valid(op.after, safeGeneration: true)
                && !next.overflow && op.after.generation == next.partialValue
                && equal(op.before.sessionID, session.sessionID) && equal(op.after.sessionID, session.sessionID)
                && equal(op.before.taskID, session.taskID) && equal(op.after.taskID, session.taskID))
            if let prior { try require(op.before.generation >= prior.generation && (op.before.generation != prior.generation || same(op.before, prior))) }
            if index < record.operations.count - 1 { try require(op.phase == .checkpointed && op.reason == nil) }
            if op.phase == .checkpointed { try require(op.reason == nil) }
            try require((op.replyJSON != nil) == (op.phase.rank >= Phase.resultDurable.rank))
            let request: AvailabilityRequest, frozen: AvailabilityFrozen
            do {
                request = try JSONDecoder().decode(AvailabilityRequest.self, from: Data(op.requestJSON.utf8))
                frozen = try JSONDecoder().decode(AvailabilityFrozen.self, from: Data(op.preparedJSON.utf8))
            } catch { throw NativeAttachmentDraftStoreError.corrupt }
            try require(request.version == 1 && equal(request.requestId, op.requestId) && equal(request.sessionID, op.before.sessionID)
                && request.generation == op.before.generation && equal(request.attachmentId, op.attachmentId) && equal(request.identity, op.identity)
                && frozen.version == 1 && frozen.kind == "prepared-file-availability" && equal(frozen.taskID, session.taskID)
                && equal(frozen.requestId, op.requestId) && equal(frozen.attachmentId, op.attachmentId) && equal(frozen.identity, op.identity)
                && equal(frozen.beforePayloadJSON, op.before.payloadJSON) && equal(frozen.afterPayloadJSON, op.after.payloadJSON)
                && object(frozen.resolvedAttachmentJSON, limit: 1_000_000))
            let resolved = try JSONSerialization.jsonObject(with: Data(frozen.resolvedAttachmentJSON.utf8)) as! [String: Any]
            try require((resolved["id"] as? String).map { equal($0, op.attachmentId) } == true && resolved["kind"] as? String == "file")
            try account([op.requestId, op.requestJSON, op.attachmentId, op.identity, op.preparedJSON]); try accountSnapshot(op.before); try accountSnapshot(op.after)
            switch op.resource {
            case .none:
                try require(frozen.status == "unrecoverable" && op.targetURI == nil
                    && [.intent, .resultDurable, .checkpointed].contains(op.phase))
            case .borrowed(let proof):
                try require(digest(proof.sha256) && size(proof.size) && identity(proof.identity) && identity(proof.directoryIdentity)
                    && [.intent, .resultDurable, .checkpointed].contains(op.phase))
                try validateAvailable(frozen, resolved: resolved, targetURI: op.targetURI, sha256: proof.sha256)
                try account([proof.sha256, proof.identity, proof.directoryIdentity])
            case .owned(let source, let stage, let filled, let published):
                let structural = Operation(requestId: op.requestId, requestJSON: op.requestJSON, phase: op.phase, reason: op.reason,
                    before: op.before, after: op.after, preparedJSON: op.preparedJSON, targetURI: op.targetURI ?? "",
                    source: source, stage: stage, filled: filled, published: published, replyJSON: op.replyJSON)
                try validate(Record(version: 2, session: Session(sessionID: session.sessionID, taskID: session.taskID,
                    state: .active, checkpoint: op.phase == .checkpointed ? op.after : op.before), operations: [structural]))
                try validateAvailable(frozen, resolved: resolved, targetURI: op.targetURI, sha256: source.sha256)
                try account([source.sourceURI, source.sha256, source.identity, source.cacheRootIdentity, source.parentIdentity])
                if let stage { try account([stage.uri, stage.identity, stage.directoryIdentity, stage.privateDirectoryIdentity]) }
                if let filled { try account([filled.sha256, filled.identity]) }
                if let published { try account([published.sha256, published.identity, published.directoryIdentity]) }
            }
            if let targetURI = op.targetURI { try account([targetURI]) }
            if let reply = op.replyJSON { try require(object(reply, limit: 64 * 1024)); try account([reply]) }
            prior = op.after
        }
        if let last = record.operations.last {
            if last.phase == .checkpointed {
                try require(session.checkpoint.generation >= last.after.generation
                    && (session.checkpoint.generation != last.after.generation || same(session.checkpoint, last.after)))
            } else { try require(same(session.checkpoint, last.before)) }
        }
        if let advance = record.checkpointAdvance { try require(record.operations.allSatisfy { $0.phase == .checkpointed }); try accountSnapshot(advance.before); try accountSnapshot(advance.after) }
        if let discard = record.discard {
            try require(ids.insert(discard.requestId).inserted); try account([discard.requestId, discard.requestJSON]); try accountSnapshot(discard.expected)
            if let reply = discard.replyJSON { try account([reply]) }
        }
    }
    private static func validateAvailable(_ frozen: AvailabilityFrozen, resolved: [String: Any], targetURI: String?, sha256: String) throws {
        guard let targetURI, let hash = resolved["fileHash"] as? String else { throw NativeAttachmentDraftStoreError.corrupt }
        // Only validated ASCII SHA256 may ignore case; retained metadata text stays exact.
        try require(frozen.status == "available" && uri(targetURI) && (resolved["uri"] as? String).map { equal($0, targetURI) } == true
            && hash.utf8.count == 64 && hash.utf8.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }
            && hash.lowercased() == sha256)
    }
    private static func retained(_ previous: AvailabilityRecord, in current: AvailabilityRecord) throws {
        try require(previous.version == current.version && equal(previous.session.sessionID, current.session.sessionID)
            && equal(previous.session.taskID, current.session.taskID) && current.operations.count >= previous.operations.count
            && current.operations.count <= previous.operations.count + 1)
        if previous.checkpointAdvance != nil || current.checkpointAdvance != nil {
            try require(previous.operations.count == current.operations.count
                && zip(previous.operations, current.operations).allSatisfy { sameAvailabilityOperation($0.0, $0.1) })
            try retainedAdvance(Record(version: 2, session: previous.session, operations: [], discard: previous.discard, checkpointAdvance: previous.checkpointAdvance),
                in: Record(version: 2, session: current.session, operations: [], discard: current.discard, checkpointAdvance: current.checkpointAdvance))
            return
        }
        for (old, new) in zip(previous.operations, current.operations) {
            try require(sameAvailabilityIdentity(old, new) && new.phase.rank >= old.phase.rank)
            try retainedResource(old.resource, in: new.resource)
            if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
        }
        if current.operations.count > previous.operations.count {
            try require(previous.session.state == .active && current.session.state == .active && previous.discard == nil && current.discard == nil
                && previous.operations.allSatisfy { $0.phase == .checkpointed }
                && same(current.operations[previous.operations.count].before, previous.session.checkpoint))
        } else if previous.operations.isEmpty { try require(same(previous.session.checkpoint, current.session.checkpoint)) }
        if !same(previous.session.checkpoint, current.session.checkpoint) {
            guard previous.operations.count == current.operations.count, let old = previous.operations.last, let new = current.operations.last else {
                throw NativeAttachmentDraftStoreError.corrupt
            }
            try require(old.phase != .checkpointed && new.phase == .checkpointed && same(current.session.checkpoint, new.after))
        }
        if let old = previous.discard {
            guard let new = current.discard else { throw NativeAttachmentDraftStoreError.corrupt }
            try require(equal(old.requestId, new.requestId) && equal(old.requestJSON, new.requestJSON) && same(old.expected, new.expected)
                && (old.phase == .decided || new.phase == .detached))
            if let reply = old.replyJSON { try require(new.replyJSON.map { equal(reply, $0) } == true) }
        }
    }
    struct AvailabilitySnapshot: Sendable {
        let record: AvailabilityRecord
        let bytes: Data
        let device: UInt64
        let inode: UInt64
        func matches(_ other: AvailabilitySnapshot) -> Bool { device == other.device && inode == other.inode && bytes == other.bytes }
    }
    func readAvailabilitySnapshot() throws -> AvailabilitySnapshot? {
        guard let read = try readBytes(bound: true) else { return nil }
        let record: AvailabilityRecord
        do {
            try Self.require(read.links == 1)
            record = try JSONDecoder().decode(AvailabilityRecord.self, from: read.data)
            try Self.validate(record)
        } catch { throw NativeAttachmentDraftStoreError.corrupt }
        return AvailabilitySnapshot(record: record, bytes: read.data, device: read.device, inode: read.inode)
    }
    func readAvailability() throws -> AvailabilityRecord? { try readAvailabilitySnapshot()?.record }
    private func encodedForWrite(_ record: AvailabilityRecord) throws -> Data {
        let previous = try readAvailability()
        try Self.validate(record)
        if let previous { try Self.retained(previous, in: record) }
        let data: Data
        do { data = try JSONEncoder().encode(record) } catch { throw NativeAttachmentDraftStoreError.corrupt }
        try Self.require(data.count <= Self.maximumBytes)
        return data
    }
    func preflightAvailability(_ record: AvailabilityRecord) throws { _ = try encodedForWrite(record) }
    func writeAvailabilityAcknowledged(_ record: AvailabilityRecord) throws -> AvailabilitySnapshot {
        let data = try encodedForWrite(record)
        do { try DurableFile.write(data, to: url, privateDraft: true) } catch { throw NativeAttachmentDraftStoreError.io }
        guard let binding = try readAvailabilitySnapshot(), binding.bytes == data else { throw NativeAttachmentDraftStoreError.corrupt }
        return binding
    }
    static func availabilityFingerprint(_ record: AvailabilityRecord) throws -> String { try validate(record); return try canonicalFingerprint(record) }

    enum VersionedRecord: Sendable { case legacy(Record), mixed(MixedRecord), availability(AvailabilityRecord) }
    struct VersionedSnapshot: Sendable {
        let record: VersionedRecord
        let bytes: Data
        let device: UInt64
        let inode: UInt64
        func matches(_ other: VersionedSnapshot) -> Bool {
            device == other.device && inode == other.inode && bytes == other.bytes
        }
    }
    private struct ReadBytes {
        let data: Data
        let device: UInt64
        let inode: UInt64
        let links: UInt64
    }
    private static func stable(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink
            && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec
            && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec
            && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func bytes() throws -> Data? { try readBytes(bound: false)?.data }
    private func readBytes(bound: Bool) throws -> ReadBytes? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            if errno == ELOOP { throw NativeAttachmentDraftStoreError.corrupt }
            throw NativeAttachmentDraftStoreError.io
        }
        defer { Darwin.close(fd) }
        var info = stat()
        guard Darwin.fstat(fd, &info) == 0 else { throw NativeAttachmentDraftStoreError.io }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_size >= 0,
              info.st_size <= off_t(Self.maximumBytes) else { throw NativeAttachmentDraftStoreError.corrupt }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw NativeAttachmentDraftStoreError.io }
            if count == 0 { break }
            guard data.count <= Self.maximumBytes - count else { throw NativeAttachmentDraftStoreError.corrupt }
            data.append(contentsOf: buffer[..<count])
        }
        if bound {
            var after = stat(), named = stat()
            guard Darwin.fstat(fd, &after) == 0, Darwin.lstat(url.path, &named) == 0 else {
                throw NativeAttachmentDraftStoreError.io
            }
            guard Self.stable(info, after), Self.stable(after, named), data.count == Int(after.st_size) else {
                throw NativeAttachmentDraftStoreError.corrupt
            }
        }
        return ReadBytes(data: data, device: UInt64(info.st_dev), inode: UInt64(info.st_ino), links: UInt64(info.st_nlink))
    }

    private struct VersionHeader: Decodable { let version: Int }
    /// One bounded descriptor read and one strict version-specific decoder.
    /// Existing readers intentionally retain their original behavior.
    func readVersioned() throws -> VersionedSnapshot? {
        guard let read = try readBytes(bound: true) else { return nil }
        let record: VersionedRecord
        do {
            switch try JSONDecoder().decode(VersionHeader.self, from: read.data).version {
            case 1, 2:
                let value = try JSONDecoder().decode(Record.self, from: read.data)
                try Self.validate(value); record = .legacy(value)
            case 3, 4:
                try Self.require(read.links == 1)
                let value = try JSONDecoder().decode(MixedRecord.self, from: read.data)
                try Self.validate(value); record = .mixed(value)
            case 5:
                try Self.require(read.links == 1)
                let value = try JSONDecoder().decode(AvailabilityRecord.self, from: read.data)
                try Self.validate(value); record = .availability(value)
            default: throw NativeAttachmentDraftStoreError.corrupt
            }
        } catch { throw NativeAttachmentDraftStoreError.corrupt }
        return VersionedSnapshot(record: record, bytes: read.data, device: read.device, inode: read.inode)
    }

    func read() throws -> Record? {
        guard let data = try bytes() else { return nil }
        do {
            let record = try JSONDecoder().decode(Record.self, from: data)
            try Self.validate(record)
            return record
        } catch { throw NativeAttachmentDraftStoreError.corrupt }
    }

    func readMixed() throws -> MixedRecord? {
        guard let data = try bytes() else { return nil }
        do {
            let record = try JSONDecoder().decode(MixedRecord.self, from: data)
            try Self.validate(record)
            return record
        } catch { throw NativeAttachmentDraftStoreError.corrupt }
    }

    /// Same complete encoded/retained-record admission as write, without mutation.
    /// A future owner must separately prove shared v2 attachment continuity and
    /// the exact editor file under the library lock before beginning an advance.
    func preflight(_ record: Record) throws { _ = try encodedForWrite(record) }

    private func encodedForWrite(_ record: Record) throws -> Data {
        let previous = try read() // Corrupt evidence must never be replaced.
        try Self.validate(record)
        if let previous { try Self.retained(previous, in: record) }
        let data: Data
        do { data = try JSONEncoder().encode(record) }
        catch { throw NativeAttachmentDraftStoreError.corrupt }
        guard data.count <= Self.maximumBytes else { throw NativeAttachmentDraftStoreError.corrupt }
        return data
    }

    func write(_ record: Record) throws {
        let data = try encodedForWrite(record)
        do { try DurableFile.write(data, to: url, privateDraft: true) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    /// V3 structural admission only; shared mixed projection authority remains
    /// required at the future coordinator before any editor or attachment IO.
    func preflightMixed(_ record: MixedRecord) throws { _ = try encodedForWrite(record) }

    private func encodedForWrite(_ record: MixedRecord) throws -> Data {
        let previous = try readMixed() // Never replace corrupt or opposite-version evidence.
        try Self.validate(record)
        if let previous { try Self.retained(previous, in: record) }
        let data: Data
        do { data = try JSONEncoder().encode(record) }
        catch { throw NativeAttachmentDraftStoreError.corrupt }
        guard data.count <= Self.maximumBytes else { throw NativeAttachmentDraftStoreError.corrupt }
        return data
    }

    func writeMixed(_ record: MixedRecord) throws {
        let data = try encodedForWrite(record)
        do { try DurableFile.write(data, to: url, privateDraft: true) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    /// The mixed Discard owner refreshes its binding only after confirming the
    /// exact bytes from this acknowledged write, never a replacement decode.
    func writeMixedAcknowledged(_ record: MixedRecord) throws -> VersionedSnapshot {
        let data = try encodedForWrite(record)
        do { try DurableFile.write(data, to: url, privateDraft: true) }
        catch { throw NativeAttachmentDraftStoreError.io }
        guard let binding = try readVersioned(), binding.bytes == data,
              case .mixed = binding.record else { throw NativeAttachmentDraftStoreError.corrupt }
        return binding
    }

    /// Complete private evidence binding, not Save, release or file authority.
    static func mixedFingerprint(_ record: MixedRecord) throws -> String {
        try validate(record)
        return try canonicalFingerprint(record)
    }

    /// Full private snapshot binding, not filesystem ownership or Save success.
    /// All exact opaque strings and native proofs participate in the digest.
    static func ownedSaveFingerprint(_ record: Record) throws -> String {
        try validate(record)
        try require(record.version == 2 && record.session.state == .active && !record.operations.isEmpty
                    && record.discard == nil && record.checkpointAdvance == nil
                    && record.operations.allSatisfy { $0.phase == .checkpointed && $0.reason == nil })
        return try canonicalFingerprint(record)
    }

    private struct DiscardRequestIdentity: Decodable {
        let version: Int
        let requestId: String
        let sessionID: String
        let generation: Int
    }
    private struct DiscardReplyIdentity: Decodable {
        let version: Int
        let status: String
        let requestId: String
        let sessionID: String
    }

    /// Exact detached private decision binding, not file cleanup or Discard
    /// success. Interrupted/unfinished Add evidence remains in the full hash.
    static func ownedDiscardFingerprint(_ record: Record) throws -> String {
        try validate(record)
        guard record.session.state == .cleanupPending, record.checkpointAdvance == nil,
              let discard = record.discard, discard.phase == .detached, let replyJSON = discard.replyJSON else {
            throw NativeAttachmentDraftStoreError.corrupt
        }
        let requestData = Data(discard.requestJSON.utf8), replyData = Data(replyJSON.utf8)
        guard let requestObject = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any],
              Set(requestObject.keys) == Set(["version", "requestId", "sessionID", "generation"]),
              let request = try? JSONDecoder().decode(DiscardRequestIdentity.self, from: requestData), request.version == 1,
              equal(request.requestId, discard.requestId), equal(request.sessionID, discard.expected.sessionID),
              request.generation == discard.expected.generation,
              let replyObject = try? JSONSerialization.jsonObject(with: replyData) as? [String: Any],
              Set(replyObject.keys) == Set(["version", "status", "requestId", "sessionID"]),
              let reply = try? JSONDecoder().decode(DiscardReplyIdentity.self, from: replyData), reply.version == 1,
              reply.status == "cleanupPending", equal(reply.requestId, discard.requestId),
              equal(reply.sessionID, discard.expected.sessionID) else { throw NativeAttachmentDraftStoreError.corrupt }
        return try canonicalFingerprint(record)
    }

    static func ownedMixedDiscardFingerprint(_ record: MixedRecord) throws -> String {
        try validate(record)
        guard record.session.state == .cleanupPending, record.checkpointAdvance == nil,
              let discard = record.discard, discard.phase == .detached, let reply = discard.replyJSON else {
            throw NativeAttachmentDraftStoreError.corrupt
        }
        // Reuse the sealed identity/reply validation without adapting any
        // mixed operation to a legacy history or granting resource authority.
        _ = try ownedDiscardFingerprint(Record(version: 2, session: record.session, operations: [],
            discard: .init(requestId: discard.requestId, requestJSON: discard.requestJSON,
                expected: discard.expected, phase: .detached, replyJSON: reply)))
        return try canonicalFingerprint(record)
    }

    private static func canonicalFingerprint<T: Encodable>(_ record: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data: Data
        do { data = try encoder.encode(record) }
        catch { throw NativeAttachmentDraftStoreError.corrupt }
        try require(data.count <= maximumBytes)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Caller owns the serialized library and the validated terminal cleanup
    /// decision. This exact private-record match grants no file-job authority.
    func releaseDiscardedAddsMatching(fingerprint: String) throws {
        try Self.require(Self.digest(fingerprint))
        if let record = try read() {
            try Self.require(Self.equal(try Self.ownedDiscardFingerprint(record), fingerprint))
        }
        // Missing confirms parent durability only under the retained caller
        // decision. Never recreate a missing parent or adopt a different record.
        do { try DurableFile.remove(url) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    /// CoreHost supplies the exact durable version5 success terminal. Missing
    /// confirms parent durability and never authorizes another cleanup job.
    func releaseDiscardedMixedMatching(fingerprint: String) throws {
        try Self.require(Self.digest(fingerprint))
        if let binding = try readVersioned() {
            guard case .mixed(let record) = binding.record else { throw NativeAttachmentDraftStoreError.corrupt }
            try Self.require(Self.equal(try Self.ownedMixedDiscardFingerprint(record), fingerprint))
        }
        do { try DurableFile.remove(url) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    /// Caller owns the Engine/library lock and a validated durable success
    /// terminal. This structural match alone grants no cleanup authority.
    func releaseSavedAddsMatching(fingerprint: String) throws {
        try Self.require(Self.digest(fingerprint))
        if let record = try read() {
            try Self.require(Self.equal(try Self.ownedSaveFingerprint(record), fingerprint))
        }
        // Missing is a durable retry only under the caller's retained terminal.
        // DurableFile.remove syncs the parent even after ENOENT.
        do { try DurableFile.remove(url) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    /// CoreHost alone supplies the fully validated, durable settled journal.
    /// Missing confirms parent durability; it never permits another file job.
    func releaseSavedMixedMatching(fingerprint: String, allowsEmptyHistory: Bool = false) throws {
        try Self.require(Self.digest(fingerprint))
        if let binding = try readVersioned() {
            guard case .mixed(let record) = binding.record else { throw NativeAttachmentDraftStoreError.corrupt }
            try Self.require(record.session.state == .active && (allowsEmptyHistory || !record.operations.isEmpty)
                && record.discard == nil && record.checkpointAdvance == nil
                && record.operations.allSatisfy { entry in
                    if case .add(let op) = entry { return op.phase == .checkpointed && op.reason == nil }
                    return entry.checkpointed
                })
            try Self.require(Self.equal(try Self.mixedFingerprint(record), fingerprint))
        }
        do { try DurableFile.remove(url) }
        catch { throw NativeAttachmentDraftStoreError.io }
    }

    static func ownedAvailabilityDiscardFingerprint(_ record: AvailabilityRecord) throws -> String {
        try validate(record)
        guard record.session.state == .cleanupPending, record.checkpointAdvance == nil,
              let discard = record.discard, discard.phase == .detached, let reply = discard.replyJSON else { throw NativeAttachmentDraftStoreError.corrupt }
        _ = try ownedDiscardFingerprint(Record(version: 2, session: record.session, operations: [],
            discard: .init(requestId: discard.requestId, requestJSON: discard.requestJSON, expected: discard.expected, phase: .detached, replyJSON: reply)))
        return try canonicalFingerprint(record)
    }
    func releaseSavedAvailabilityMatching(fingerprint: String) throws {
        try Self.require(Self.digest(fingerprint))
        if let record = try readAvailability() {
            try Self.require(record.session.state == .active && record.discard == nil && record.checkpointAdvance == nil
                && record.operations.allSatisfy { $0.phase == .checkpointed && $0.reason == nil }
                && Self.equal(try Self.availabilityFingerprint(record), fingerprint))
        }
        do { try DurableFile.remove(url) } catch { throw NativeAttachmentDraftStoreError.io }
    }
    func releaseDiscardedAvailabilityMatching(fingerprint: String) throws {
        try Self.require(Self.digest(fingerprint))
        if let record = try readAvailability() { try Self.require(Self.equal(try Self.ownedAvailabilityDiscardFingerprint(record), fingerprint)) }
        do { try DurableFile.remove(url) } catch { throw NativeAttachmentDraftStoreError.io }
    }
}
