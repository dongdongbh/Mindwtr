import Foundation
import CoreFoundation
import Darwin

enum AttachmentDraftBoundary: Sendable, Equatable {
    case beforeIntent, afterIntent, afterReservation, beforeStageProof, afterStageProof
    case beforeFilled, afterFilled, beforePublication, afterPublication, afterPublicationProof
    case beforeResult, afterResult, beforeCheckpoint, afterCheckpoint, beforeMarker, afterMarker
    case beforeDiscardDecision, afterDiscardDecision, beforeDetach, afterDetach
    case beforeAdvanceIntent, afterAdvanceIntent, beforeAdvanceEditor, afterAdvanceEditor
    case beforeAdvanceMarker, afterAdvanceMarker
    case afterSaveFreeze, afterSaveJournal, beforeSaveCommit, afterSaveCommit
    case beforeSaveTerminal, afterSaveTerminal, beforeSaveEditorDetach, afterSaveEditorDetach
    case beforeSaveStage(Int), afterSaveStage(Int), beforeSaveRelease, afterSaveRelease
    case beforeSaveJournalClear, afterSaveJournalClear, beforeSaveThaw, afterSaveThaw
    case beforeSaveTarget(Int), afterSaveTarget(Int), beforeSaveProgress, afterSaveProgress
    case beforeSaveSettled, afterSaveSettled
    case beforeDiscardFinishJournal, afterDiscardFinishJournal
    case beforeDiscardFilledObservation, afterDiscardFilledObservation
    case beforeDiscardPublicationReproof, afterDiscardPublicationReproof
    case beforeDiscardPublicationPromotion, afterDiscardPublicationPromotion
    case beforeDiscardTarget(Int), afterDiscardTarget(Int), beforeDiscardStage(Int), afterDiscardStage(Int)
    case beforeDiscardTerminal, afterDiscardTerminal, beforeDiscardRelease, afterDiscardRelease
    case beforeDiscardJournalClear, afterDiscardJournalClear
}
#if DEBUG
final class AttachmentDraftHostHooks: @unchecked Sendable {
    var boundary: ((AttachmentDraftBoundary) throws -> Void)?
}
#endif

/// Serialized by CoreHost's existing library owner. Descriptor proofs remain
/// native; editor projection and task authority remain in shared core.
final class NativeAttachmentDraftCoordinator {
    typealias Store = NativeAttachmentDraftStore
    private let store: Store
    private let editor: EditorDraftStore
    private let jobs: NativeAttachmentFileJobs
    private let invoke: (String, [Any]) throws -> String
    private let managedURI: String
    private let requireOwner: () throws -> Void
    private let maximumReadBytes: Int?
    #if DEBUG
    var hooks: AttachmentDraftHostHooks?
    #endif
    private static let failure = HostFailure("Attachment draft operation could not be confirmed; retained evidence requires exact recovery")

    init(databaseURL: URL, jobs: NativeAttachmentFileJobs, maximumReadBytes: Int? = nil, requireOwner: @escaping () throws -> Void = {},
         invoke: @escaping (String, [Any]) throws -> String) throws {
        store = Store(databaseURL: databaseURL)
        editor = EditorDraftStore(databaseURL: databaseURL)
        self.jobs = jobs
        self.invoke = invoke
        self.requireOwner = requireOwner
        self.maximumReadBytes = maximumReadBytes
        let directories = try Self.object(jobs.directoriesJSON)
        guard let document = directories["document"] as? String, let root = URL(string: document) else { throw Self.failure }
        managedURI = root.appendingPathComponent("attachments", isDirectory: true).absoluteString
    }

    static func hasEvidence(databaseURL: URL) -> Bool {
        var info = stat()
        if lstat(Store(databaseURL: databaseURL).url.path, &info) == 0 { return true }
        return errno != ENOENT
    }
    private static func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    private static func object(_ text: String, limit: Int = 8 * 1024 * 1024) throws -> [String: Any] {
        guard text.utf8.count <= limit, let value = try NativeJSON.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw failure }
        return value
    }
    private static func equal(_ lhs: String, _ rhs: String) -> Bool { lhs.utf8.elementsEqual(rhs.utf8) }
    private static func equal(_ lhs: EditorDraftSnapshot, _ rhs: EditorDraftSnapshot) -> Bool {
        lhs.version == rhs.version && equal(lhs.sessionID, rhs.sessionID) && equal(lhs.taskID, rhs.taskID)
            && lhs.generation == rhs.generation && equal(lhs.payloadJSON, rhs.payloadJSON)
    }
    private static func uuid(_ value: Any?) -> String? {
        guard let text = value as? String, UUID(uuidString: text)?.uuidString.lowercased() == text else { return nil }
        return text
    }
    private static func integer(_ value: Any?, positive: Bool = false) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= (positive ? 1 : 0), number.doubleValue <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }
    private struct Request {
        let id: String
        let session: String
        let generation: Int
        let picked: [String: Any]?
        let json: String
    }
    private static func request(_ raw: String, add: Bool) throws -> Request {
        let value = try object(raw, limit: 64 * 1024)
        guard Set(value.keys) == Set(add ? ["version", "requestId", "sessionID", "generation", "picked"] : ["version", "requestId", "sessionID", "generation"]),
              integer(value["version"]) == 1, let id = uuid(value["requestId"]), let session = uuid(value["sessionID"]),
              let generation = integer(value["generation"], positive: true) else { throw failure }
        let picked = value["picked"] as? [String: Any]
        if add {
            guard let picked, Set(picked.keys) == Set(["uri", "name", "mimeType", "size"]),
                  let uri = picked["uri"] as? String, !uri.isEmpty, uri.utf8.count <= 16 * 1024,
                  picked["name"] is NSNull || (picked["name"] as? String).map({ $0.utf16.count <= 100_000 }) == true,
                  picked["mimeType"] is NSNull || (picked["mimeType"] as? String).map({ $0.utf16.count <= 500 }) == true else { throw failure }
            if !(picked["size"] is NSNull) {
                guard let size = picked["size"] as? NSNumber, CFGetTypeID(size) != CFBooleanGetTypeID(), size.doubleValue.isFinite, size.doubleValue >= 0 else { throw failure }
            }
        }
        let canonical = try json(value)
        guard canonical.utf8.count <= 64 * 1024 else { throw failure }
        return Request(id: id, session: session, generation: Int(generation), picked: picked, json: canonical)
    }
    private func current(_ expected: EditorDraftSnapshot) throws {
        guard let value = try editor.read(), value.attempt == nil, Self.equal(value.snapshot, expected) else { throw Self.failure }
    }
    private func lineage(_ record: Store.Record) throws {
        try history(record)
        if record.session.state == .active {
            guard let value = try editor.read(), value.attempt == nil else { throw Self.failure }
            let after = record.operations.last.flatMap { $0.phase == .resultDurable ? $0.after : nil }
            guard Self.equal(value.snapshot, record.session.checkpoint) || after.map({ Self.equal(value.snapshot, $0) }) == true
                || record.checkpointAdvance.map({ Self.equal(value.snapshot, $0.after) }) == true else { throw Self.failure }
        }
    }
    /// Metadata validation only. Owned Save separately requires its exact full
    /// editor attempt; the existing editable lineage gate is never relaxed.
    private func history(_ record: Store.Record) throws {
        for op in record.operations {
            _ = try prepared(op)
            if let reply = op.replyJSON { guard Self.equal(reply, try addReply(op)) else { throw Self.failure } }
        }
        if let discard = record.discard {
            let request = try Self.request(discard.requestJSON, add: false)
            guard request.id == discard.requestId, request.session == record.session.sessionID,
                  request.generation == discard.expected.generation, Self.equal(request.json, discard.requestJSON) else { throw Self.failure }
            if let reply = discard.replyJSON { guard Self.equal(reply, try discardReply(record, discard)) else { throw Self.failure } }
        }
        let pendingAdd = record.operations.last.map { $0.phase != .checkpointed } == true
        let projected = record.version == 2 && !pendingAdd ? record.session.checkpoint.payloadJSON
            : record.operations.last?.after.payloadJSON ?? record.session.checkpoint.payloadJSON
        try projection(record, payload: projected)
        if let advance = record.checkpointAdvance { try projection(record, payload: advance.after.payloadJSON) }
    }
    private func projection(_ record: Store.Record, payload projected: String) throws {
        let initial = record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON
        let input: [String: Any] = ["version": record.version, "taskID": record.session.taskID, "initialPayloadJSON": initial,
            "beforePayloadJSON": projected, "priorAdditions": try record.operations.map { try prepared($0) }, "managedDirectoryURI": managedURI]
        let validated = try Self.object(invoke(record.version == 2 ? "attachmentDraftValidateLineageV2" : "attachmentDraftValidateLineage", [Self.json(input)]))
        guard Set(validated.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(validated["version"]) == Int64(record.version),
              let task = validated["taskID"] as? String, Self.equal(task, record.session.taskID),
              let payload = validated["payloadJSON"] as? String, Self.equal(payload, projected) else { throw Self.failure }
    }
    private func prepared(_ op: Store.Operation, version: Int = 1) throws -> [String: Any] {
        let value = try Self.object(op.preparedJSON, limit: 2 * 1024 * 1024)
        let request = try Self.request(op.requestJSON, add: true)
        guard Set(value.keys) == Set(["version", "kind", "taskID", "requestId", "picked", "measuredSize", "managedDirectoryURI", "beforePayloadJSON", "afterPayloadJSON", "prepared", "targetURI", "attachment"]).union(version == 2 ? ["sourceSha256"] : []),
              Self.integer(value["version"]) == Int64(version), value["kind"] as? String == "prepared",
              value["taskID"] as? String == op.before.taskID, value["requestId"] as? String == op.requestId,
              request.id == op.requestId, request.session == op.before.sessionID, request.generation == op.before.generation,
              Self.equal(request.json, op.requestJSON),
              Self.equal(try Self.json(value["picked"]!), try Self.json(request.picked!)),
              (request.picked?["uri"] as? String) == op.source.sourceURI,
              Self.integer(value["measuredSize"]) == op.source.size,
              value["managedDirectoryURI"] as? String == managedURI,
              let before = value["beforePayloadJSON"] as? String, Self.equal(before, op.before.payloadJSON),
              let after = value["afterPayloadJSON"] as? String, Self.equal(after, op.after.payloadJSON),
              value["targetURI"] as? String == op.targetURI,
              let target = URL(string: op.targetURI), target.deletingLastPathComponent().absoluteString == managedURI,
              let attachment = value["attachment"] as? [String: Any], attachment["id"] as? String == op.requestId,
              attachment["uri"] as? String == op.targetURI, Self.integer(attachment["size"]) == op.source.size else { throw Self.failure }
        if version == 2 {
            guard let hash = value["sourceSha256"] as? String, Self.equal(hash, op.source.sha256),
                  let source = (value["prepared"] as? [String: Any])?["attachment"] as? [String: Any],
                  let sourceHash = source["fileHash"] as? String, Self.equal(sourceHash, hash),
                  let completed = value["attachment"] as? [String: Any], let completedHash = completed["fileHash"] as? String,
                  Self.equal(completedHash, hash) else { throw Self.failure }
        }
        if let stage = op.stage {
            let expected = managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage"
            guard Self.equal(stage.uri, expected) else { throw Self.failure }
        }
        return value
    }
    private func acknowledge(_ operation: String, _ outcome: String) { _ = try? invoke("attachmentDraftAcknowledged", [operation, outcome]) }
    static func readSummary(databaseURL: URL) throws -> String {
        guard let snapshot = try Store(databaseURL: databaseURL).readVersioned() else { return "null" }
        switch snapshot.record {
        case .legacy(let record): return try Self.summary(record)
        case .mixed(let record): return try Self.summary(record)
        case .availability(let record): return try Self.summary(record)
        }
    }
    private static func summary(_ record: Store.Record) throws -> String {
        let status = record.checkpointAdvance != nil ? "checkpointPending"
            : record.session.state == .cleanupPending ? "cleanupPending" : (record.operations.last?.reason == nil ? "active" : "uncertain")
        return try Self.json(["version": record.version, "status": status, "sessionID": record.session.sessionID,
                       "checkpoint": try Self.object(String(decoding: JSONEncoder().encode(record.session.checkpoint), as: UTF8.self)),
                       "operations": record.operations.map { ["requestId": $0.requestId, "phase": $0.phase.rawValue, "reason": $0.reason.map { $0.rawValue as Any } ?? NSNull()] },
                       "discard": record.discard.map { ["requestId": $0.requestId, "phase": $0.phase.rawValue] as Any } ?? NSNull()])
    }
    private static func summary(_ record: Store.MixedRecord) throws -> String {
        let uncertain = record.operations.last.map { entry in
            if case .add(let op) = entry { return op.reason != nil }
            return false
        } ?? false
        let status = record.checkpointAdvance != nil ? "checkpointPending"
            : record.session.state == .cleanupPending ? "cleanupPending" : uncertain ? "uncertain" : "active"
        let operations: [[String: Any]] = record.operations.map { entry in
            switch entry {
            case .add(let op): return ["kind": "add", "requestId": op.requestId, "phase": op.phase.rawValue,
                                      "reason": op.reason.map { $0.rawValue as Any } ?? NSNull()]
            case .remove(let op): return ["kind": "remove", "requestId": op.requestId, "phase": op.phase.rawValue, "reason": NSNull()]
            }
        }
        return try Self.json(["version": record.version, "status": status, "sessionID": record.session.sessionID,
            "checkpoint": try Self.object(String(decoding: JSONEncoder().encode(record.session.checkpoint), as: UTF8.self)),
            "operations": operations,
            "discard": record.discard.map { ["requestId": $0.requestId, "phase": $0.phase.rawValue] as Any } ?? NSNull()])
    }
    func begin(session: String, generation: Int) throws -> String {
        try begin(session: session, generation: generation, version: 1)
    }
    func beginV2(session: String, generation: Int) throws -> String {
        try begin(session: session, generation: generation, version: 2)
    }
    private func begin(session: String, generation: Int, version: Int) throws -> String {
        if version == 2 { jobs.drain() }
        guard Self.uuid(session) != nil, generation > 0, generation <= 9_007_199_254_740_991,
              let value = try editor.read(), value.attempt == nil, value.snapshot.sessionID == session, value.snapshot.generation == generation else { throw Self.failure }
        let snapshot = value.snapshot
        let existing = try store.read()
        if let existing {
            guard existing.version == version, existing.session.state == .active, Self.equal(existing.session.checkpoint, snapshot),
                  version == 1 || (existing.checkpointAdvance == nil && existing.operations.allSatisfy { $0.phase == .checkpointed }) else { throw Self.failure }
        }
        let initial = existing?.operations.first?.before.payloadJSON ?? snapshot.payloadJSON
        let reply = try Self.object(invoke(version == 2 ? "attachmentDraftBeginV2" : "attachmentDraftBegin", [Self.json(["taskID": snapshot.taskID, "payloadJSON": initial])]))
        guard Set(reply.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(reply["version"]) == Int64(version),
              let task = reply["taskID"] as? String, Self.equal(task, snapshot.taskID),
              let payload = reply["payloadJSON"] as? String, Self.equal(payload, initial) else { throw Self.failure }
        if let existing {
            try lineage(existing)
        } else {
            try store.write(Store.Record(version: version, session: .init(sessionID: session, taskID: snapshot.taskID, state: .active, checkpoint: snapshot), operations: []))
        }
        return try Self.json(["version": version, "status": "begun", "sessionID": session, "generation": generation])
    }

    /// Ordinary raw editor retention only. Shared lineage proves attachment
    /// continuity; this does not admit Save or recheck upload/task edit policy.
    func advance(_ snapshot: EditorDraftSnapshot) throws {
        // Finish all existing file work before invoking the pure JS validator.
        // No JSC invocation occurs between the durable intent and final marker.
        jobs.drain()
        guard let record = try store.read(), record.version == 2, record.session.state == .active,
              record.discard == nil, record.operations.allSatisfy({ $0.phase == .checkpointed }),
              snapshot.generation > 0, snapshot.generation <= 9_007_199_254_740_991,
              Self.equal(snapshot.sessionID, record.session.sessionID), Self.equal(snapshot.taskID, record.session.taskID) else { throw Self.failure }
        try editor.preflightCheckpoint(snapshot)
        try lineage(record)
        if let pending = record.checkpointAdvance {
            guard Self.equal(snapshot, pending.after) else { throw Self.failure }
            _ = try finishAdvance(record)
            acknowledge("checkpoint", "replayed")
            return
        }
        try current(record.session.checkpoint)
        if Self.equal(snapshot, record.session.checkpoint) {
            // An earlier marker may have been promoted before its parent-sync
            // acknowledgment failed. A read alone cannot confirm that write.
            try requireRecord(record)
            try store.write(record)
            acknowledge("checkpoint", "replayed")
            return
        }
        guard snapshot.generation > record.session.checkpoint.generation else { throw Self.failure }
        try projection(record, payload: snapshot.payloadJSON)
        let pending = checkpointRecord(record, checkpoint: record.session.checkpoint,
            advance: .init(before: record.session.checkpoint, after: snapshot))
        try preflightAdvanceAdmission(pending)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceIntent)
        #endif
        try current(record.session.checkpoint)
        try requireRecord(record)
        try store.write(pending)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceIntent)
        #endif
        _ = try finishAdvance(pending)
        acknowledge("discard-capacity", "confirmed")
        acknowledge("checkpoint", "confirmed")
    }

    private func checkpointRecord(_ record: Store.Record, checkpoint: EditorDraftSnapshot,
                                  advance: Store.CheckpointAdvance?) -> Store.Record {
        Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID,
            taskID: record.session.taskID, state: record.session.state, checkpoint: checkpoint),
            operations: record.operations, discard: record.discard, checkpointAdvance: advance)
    }
    private func requireRecord(_ expected: Store.Record) throws {
        guard let actual = try store.read() else { throw Self.failure }
        // Codable's synthesized String equality is Unicode-normalizing. Compare
        // a stable complete model encoding to retain every opaque byte instead.
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard try encoder.encode(actual) == encoder.encode(expected) else { throw Self.failure }
    }
    private func preflightAdvance(_ record: Store.Record) throws {
        guard record.version == 2, let advance = record.checkpointAdvance else { throw Self.failure }
        try editor.preflightCheckpoint(advance.after)
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        for candidate in [record, settled] {
            guard try JSONEncoder().encode(candidate).count <= Store.maximumBytes else { throw Self.failure }
        }
        // Before intent, only the pending record can pass retained-write checks;
        // the settled record requires that intent already present on disk.
        try store.preflight(record)
    }
    /// Reserve future Discard only before a new intent is admitted. Recovery
    /// must finish an older recorded pair under its original capacity checks.
    private func preflightAdvanceAdmission(_ record: Store.Record) throws {
        try preflightAdvance(record)
        guard let advance = record.checkpointAdvance else { throw Self.failure }
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        let discardID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try Self.json(["version": 1, "requestId": discardID,
            "sessionID": advance.after.sessionID, "generation": advance.after.generation])
        let reply = try Self.json(["version": 1, "status": "cleanupPending",
            "requestId": discardID, "sessionID": advance.after.sessionID])
        for phase in [Store.DiscardPhase.decided, .detached] {
            let future = Store.Record(version: settled.version,
                session: .init(sessionID: settled.session.sessionID, taskID: settled.session.taskID,
                    state: .cleanupPending, checkpoint: advance.after), operations: settled.operations,
                discard: .init(requestId: discardID, requestJSON: request, expected: advance.after,
                    phase: phase, replyJSON: phase == .detached ? reply : nil), checkpointAdvance: nil)
            guard try JSONEncoder().encode(future).count <= Store.maximumBytes else { throw Self.failure }
        }
    }
    private func finishAdvance(_ record: Store.Record) throws -> Store.Record {
        guard record.version == 2, let advance = record.checkpointAdvance else { throw Self.failure }
        try preflightAdvance(record)
        try requireRecord(record)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceEditor)
        #endif
        try editor.checkpointOwnedAdvanceMatching(before: advance.before, after: advance.after)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceEditor)
        #endif
        try current(advance.after)
        let settled = checkpointRecord(record, checkpoint: advance.after, advance: nil)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceMarker)
        #endif
        try current(advance.after)
        try requireRecord(record)
        try store.write(settled)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceMarker)
        #endif
        return settled
    }

    private struct RemoveRequest {
        let id: String, session: String, attachmentID: String, json: String
        let generation: Int
    }
    private static func removeRequest(_ raw: String) throws -> RemoveRequest {
        let value = try object(raw, limit: 64 * 1024)
        guard Set(value.keys) == Set(["version", "requestId", "sessionID", "generation", "attachmentId"]),
              integer(value["version"]) == 1, let id = uuid(value["requestId"]), id.utf8.count == 36,
              let session = uuid(value["sessionID"]), session.utf8.count == 36,
              let generation = integer(value["generation"], positive: true),
              let attachment = value["attachmentId"] as? String, !attachment.isEmpty, attachment.utf16.count <= 500 else { throw failure }
        let canonical = try json(value)
        guard canonical.utf8.count <= 64 * 1024 else { throw failure }
        return .init(id: id, session: session, attachmentID: attachment, json: canonical, generation: Int(generation))
    }
    private func mixedRead(_ cancellation: NativeAttachmentCancellation) throws -> (record: Store.MixedRecord, binding: Store.VersionedSnapshot) {
        try requireOwner(); try cancellation.check()
        guard let binding = try store.readVersioned(), case .mixed(let record) = binding.record else { throw Self.failure }
        try requireOwner(); try cancellation.check()
        return (record, binding)
    }
    private func requireMixed(_ binding: Store.VersionedSnapshot, _ cancellation: NativeAttachmentCancellation) throws {
        try requireOwner(); try cancellation.check()
        guard let actual = try store.readVersioned(), binding.matches(actual) else { throw Self.failure }
        try requireOwner(); try cancellation.check()
    }
    private func mixedInvoke(_ method: String, _ input: [String: Any], binding: Store.VersionedSnapshot?,
                             cancellation: NativeAttachmentCancellation) throws -> [String: Any] {
        try Self.object(mixedInvokeJSON(method, input, binding: binding, cancellation: cancellation))
    }
    private func mixedInvokeJSON(_ method: String, _ input: [String: Any], binding: Store.VersionedSnapshot?,
                                 cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        let result = try invoke(method, [Self.json(input)])
        try requireOwner(); try cancellation.check()
        if let binding { try requireMixed(binding, cancellation) }
        else { guard case nil = try store.readVersioned() else { throw Self.failure } }
        return result
    }
    private func currentMixed(_ candidates: [EditorDraftSnapshot]) throws {
        guard let value = try editor.read(), value.attempt == nil,
              candidates.contains(where: { Self.equal(value.snapshot, $0) }) else { throw Self.failure }
    }
    private func writeMixed(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot?,
                            cancellation: NativeAttachmentCancellation) throws -> Store.VersionedSnapshot {
        try requireOwner(); try cancellation.check()
        if let binding { try requireMixed(binding, cancellation) }
        else { guard case nil = try store.readVersioned() else { throw Self.failure } }
        // An uncertain write acknowledgment aborts before any binding refresh.
        try store.writeMixed(record)
        guard let next = try store.readVersioned(), case .mixed(let actual) = next.record else { throw Self.failure }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard try encoder.encode(actual) == encoder.encode(record) else { throw Self.failure }
        try requireOwner(); try cancellation.check()
        return next
    }
    private func removeReply(_ op: Store.RemoveOperation) throws -> String {
        let request = try Self.removeRequest(op.requestJSON)
        return try Self.json(["version": 1, "status": "draftRemoved", "requestId": op.requestId,
            "sessionID": op.after.sessionID, "generation": op.after.generation, "attachmentId": request.attachmentID])
    }
    private func mixedPrepared(_ entry: Store.MixedOperation, version: Int) throws -> [String: Any] {
        switch entry {
        case .add(let op):
            let frozen = try prepared(op, version: version == 4 ? 2 : 1)
            if let reply = op.replyJSON { guard Self.equal(reply, try addReply(op)) else { throw Self.failure } }
            return ["kind": "add", "operation": frozen]
        case .remove(let op):
            let request = try Self.removeRequest(op.requestJSON)
            guard Self.equal(request.json, op.requestJSON), request.id == op.requestId,
                  request.session == op.before.sessionID, request.generation == op.before.generation else { throw Self.failure }
            if let reply = op.replyJSON { guard Self.equal(reply, try removeReply(op)) else { throw Self.failure } }
            return ["kind": "remove", "operation": try Self.object(op.preparedJSON, limit: 2 * 1024 * 1024)]
        }
    }
    private func mixedInput(_ record: Store.MixedRecord, payload: String) throws -> [String: Any] {
        ["version": record.version, "taskID": record.session.taskID,
         "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
         "beforePayloadJSON": payload, "priorOperations": try record.operations.map { try mixedPrepared($0, version: record.version) }, "managedDirectoryURI": managedURI]
    }
    private func mixedProjection(_ record: Store.MixedRecord, payload: String, binding: Store.VersionedSnapshot,
                                 cancellation: NativeAttachmentCancellation) throws {
        let validated = try mixedInvoke(record.version == 4 ? "attachmentDraftValidateLineageV4" : "attachmentDraftValidateLineageV3", mixedInput(record, payload: payload),
                                        binding: binding, cancellation: cancellation)
        guard Set(validated.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(validated["version"]) == Int64(record.version),
              let task = validated["taskID"] as? String, Self.equal(task, record.session.taskID),
              let projected = validated["payloadJSON"] as? String, Self.equal(projected, payload) else { throw Self.failure }
    }
    private func mixedHistory(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot,
                              cancellation: NativeAttachmentCancellation) throws {
        guard record.session.state == .active, record.discard == nil else { throw Self.failure }
        let pending = record.operations.last.flatMap { $0.checkpointed ? nil : $0.after }
        try mixedProjection(record, payload: pending?.payloadJSON ?? record.session.checkpoint.payloadJSON,
                            binding: binding, cancellation: cancellation)
        if let advance = record.checkpointAdvance {
            try mixedProjection(record, payload: advance.after.payloadJSON, binding: binding, cancellation: cancellation)
        }
        try currentMixed([record.session.checkpoint] + (pending.map { [$0] } ?? [])
            + (record.checkpointAdvance.map { [$0.after] } ?? []))
    }
    private func mixedRecord(_ record: Store.MixedRecord, checkpoint: EditorDraftSnapshot,
                             operations: [Store.MixedOperation]? = nil,
                             advance: Store.CheckpointAdvance? = nil) -> Store.MixedRecord {
        Store.MixedRecord(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID,
            state: record.session.state, checkpoint: checkpoint), operations: operations ?? record.operations,
            discard: record.discard, checkpointAdvance: advance)
    }
    private func preflightMixedShapes(_ records: [Store.MixedRecord]) throws {
        for record in records {
            _ = try Store.mixedFingerprint(record) // Structural validation only.
            guard try JSONEncoder().encode(record).count <= Store.maximumBytes else { throw Self.failure }
        }
    }
    private func futureMixedDiscards(_ record: Store.MixedRecord) throws -> [Store.MixedRecord] {
        let used = Set(record.operations.map(\.requestId))
        guard let id = (0...128).map({ String(format: "ffffffff-ffff-ffff-ffff-%012d", $0) }).first(where: { !used.contains($0) }) else {
            throw Self.failure
        }
        let checkpoint = record.session.checkpoint
        let request = try Self.json(["version": 1, "requestId": id, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation])
        let reply = try Self.json(["version": 1, "status": "cleanupPending", "requestId": id, "sessionID": checkpoint.sessionID])
        return [Store.DiscardPhase.decided, .detached].map { phase in
            Store.MixedRecord(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID,
                state: .cleanupPending, checkpoint: checkpoint), operations: record.operations,
                discard: .init(requestId: id, requestJSON: request, expected: checkpoint, phase: phase,
                               replyJSON: phase == .detached ? reply : nil))
        }
    }
    private func completedRemove(_ op: Store.RemoveOperation) throws -> Store.RemoveOperation {
        .init(requestId: op.requestId, requestJSON: op.requestJSON, phase: .checkpointed,
            before: op.before, after: op.after, preparedJSON: op.preparedJSON, replyJSON: try removeReply(op))
    }
    private func acknowledgedRemoveRecord(_ record: Store.MixedRecord, _ op: Store.RemoveOperation) throws -> Store.MixedRecord {
        mixedRecord(record, checkpoint: op.after, operations: Array(record.operations.dropLast()) + [.remove(try completedRemove(op))])
    }
    private func preflightRemove(_ record: Store.MixedRecord, admission: Bool) throws {
        guard let last = record.operations.last, case .remove(let op) = last, op.phase == .intent else { throw Self.failure }
        try editor.preflightCheckpoint(op.after)
        let complete = try acknowledgedRemoveRecord(record, op)
        var shapes = [record, complete]
        if admission {
            shapes += try futureMixedDiscards(record) + futureMixedDiscards(complete)
            guard op.after.generation < 9_007_199_254_740_991 else { throw Self.failure }
            let next = EditorDraftSnapshot(sessionID: op.after.sessionID, taskID: op.after.taskID,
                generation: op.after.generation + 1, payloadJSON: op.after.payloadJSON)
            shapes += [mixedRecord(complete, checkpoint: op.after, advance: .init(before: op.after, after: next)),
                       mixedRecord(complete, checkpoint: next)]
        }
        try preflightMixedShapes(shapes)
        try store.preflightMixed(record)
    }
    func beginV3(session: String, generation: Int, cancellation: NativeAttachmentCancellation) throws -> String {
        try beginMixed(session: session, generation: generation, version: 3, cancellation: cancellation)
    }
    func beginV4(session: String, generation: Int, cancellation: NativeAttachmentCancellation) throws -> String {
        try beginMixed(session: session, generation: generation, version: 4, cancellation: cancellation)
    }
    private func beginMixed(session: String, generation: Int, version: Int, cancellation: NativeAttachmentCancellation) throws -> String {
        jobs.drain(); try requireOwner(); try cancellation.check()
        guard Self.uuid(session) != nil, session.utf8.count == 36, generation > 0, generation <= 9_007_199_254_740_991,
              let value = try editor.read(), value.attempt == nil,
              Self.equal(value.snapshot.sessionID, session), value.snapshot.generation == generation else { throw Self.failure }
        let snapshot = value.snapshot, binding = try store.readVersioned()
        let existing: Store.MixedRecord?
        if let binding {
            guard case .mixed(let record) = binding.record, record.version == version, record.session.state == .active, record.discard == nil,
                  record.checkpointAdvance == nil, record.operations.allSatisfy({ $0.checkpointed }),
                  Self.equal(record.session.checkpoint, snapshot) else { throw Self.failure }
            try mixedHistory(record, binding: binding, cancellation: cancellation); existing = record
        } else { existing = nil }
        let initial = existing?.operations.first?.before.payloadJSON ?? snapshot.payloadJSON
        let reply = try mixedInvoke(version == 4 ? "attachmentDraftBeginV4" : "attachmentDraftBeginV3", ["taskID": snapshot.taskID, "payloadJSON": initial],
                                    binding: binding, cancellation: cancellation)
        guard Set(reply.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(reply["version"]) == Int64(version),
              let task = reply["taskID"] as? String, Self.equal(task, snapshot.taskID),
              let payload = reply["payloadJSON"] as? String, Self.equal(payload, initial) else { throw Self.failure }
        try current(snapshot)
        if existing == nil {
            let record = Store.MixedRecord(version: version, session: .init(sessionID: session, taskID: snapshot.taskID, state: .active, checkpoint: snapshot), operations: [])
            try store.preflightMixed(record)
            _ = try writeMixed(record, binding: nil, cancellation: cancellation)
            try current(snapshot)
        } else if let binding { try requireMixed(binding, cancellation) }
        return try Self.json(["version": version, "status": "begun", "sessionID": session, "generation": generation])
    }
    func removeV3(_ raw: String, cancellation: NativeAttachmentCancellation) throws -> String {
        let request = try Self.removeRequest(raw)
        jobs.drain()
        let loaded = try mixedRead(cancellation), record = loaded.record
        guard Self.equal(record.session.sessionID, request.session), record.session.state == .active,
              record.discard == nil, record.checkpointAdvance == nil else { throw Self.failure }
        if let entry = record.operations.first(where: { $0.requestId == request.id }) {
            guard case .remove(let existing) = entry, Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
            try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
            if existing.phase == .checkpointed {
                guard record.operations.allSatisfy({ $0.checkpointed }), let reply = existing.replyJSON else { throw Self.failure }
                try current(record.session.checkpoint)
                let resynced = try writeMixed(record, binding: loaded.binding, cancellation: cancellation)
                try current(record.session.checkpoint); try requireMixed(resynced, cancellation)
                acknowledge("remove", "replayed"); return reply
            }
            guard record.operations.last?.requestId == request.id else { throw Self.failure }
            let finished = try finishRemove(record, binding: loaded.binding, cancellation: cancellation)
            acknowledge("remove", "confirmed"); return try lastRemoveReply(finished)
        }
        guard record.operations.allSatisfy({ $0.checkpointed }), record.operations.count < 128,
              request.generation == record.session.checkpoint.generation,
              request.generation < 9_007_199_254_740_990 else { throw Self.failure }
        try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
        try current(record.session.checkpoint)
        var input = try mixedInput(record, payload: record.session.checkpoint.payloadJSON)
        input["requestId"] = request.id; input["attachmentId"] = request.attachmentID
        let frozenJSON = try mixedInvokeJSON(record.version == 4 ? "attachmentDraftRemovePrepareV4" : "attachmentDraftRemovePrepareV3", input, binding: loaded.binding, cancellation: cancellation)
        let frozen = try Self.object(frozenJSON, limit: 2 * 1024 * 1024)
        guard let afterPayload = frozen["afterPayloadJSON"] as? String else { throw Self.failure }
        let before = record.session.checkpoint
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: before.generation + 1, payloadJSON: afterPayload)
        let op = Store.RemoveOperation(requestId: request.id, requestJSON: request.json, phase: .intent,
            before: before, after: after, preparedJSON: frozenJSON)
        let intent = mixedRecord(record, checkpoint: before, operations: record.operations + [.remove(op)])
        try preflightRemove(intent, admission: true)
        try mixedHistory(intent, binding: loaded.binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.beforeIntent)
        #endif
        try current(before); try requireMixed(loaded.binding, cancellation)
        let binding = try writeMixed(intent, binding: loaded.binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.afterIntent)
        #endif
        try currentMixed([before, after]); try requireMixed(binding, cancellation)
        let finished = try finishRemove(intent, binding: binding, cancellation: cancellation)
        acknowledge("remove", "confirmed"); return try lastRemoveReply(finished)
    }
    private func lastRemoveReply(_ record: Store.MixedRecord) throws -> String {
        guard let last = record.operations.last, case .remove(let op) = last, let reply = op.replyJSON else { throw Self.failure }
        return reply
    }
    private func finishRemove(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot,
                              cancellation: NativeAttachmentCancellation) throws -> Store.MixedRecord {
        guard let last = record.operations.last, case .remove(let op) = last, op.phase == .intent else { throw Self.failure }
        try preflightRemove(record, admission: false)
        try mixedHistory(record, binding: binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.beforeCheckpoint)
        #endif
        try currentMixed([op.before, op.after]); try requireMixed(binding, cancellation)
        try editor.checkpointOwnedAdvanceMatching(before: op.before, after: op.after)
        #if DEBUG
        try hooks?.boundary?(.afterCheckpoint)
        #endif
        try current(op.after); try requireMixed(binding, cancellation)
        let complete = try acknowledgedRemoveRecord(record, op)
        #if DEBUG
        try hooks?.boundary?(.beforeMarker)
        #endif
        try current(op.after); try requireMixed(binding, cancellation)
        let completedBinding = try writeMixed(complete, binding: binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.afterMarker)
        #endif
        try current(op.after); try requireMixed(completedBinding, cancellation)
        return complete
    }
    func recoverV3(session: String, cancellation: NativeAttachmentCancellation) throws -> String {
        jobs.drain()
        let loaded = try mixedRead(cancellation)
        guard Self.uuid(session) != nil, session.utf8.count == 36, Self.equal(loaded.record.session.sessionID, session) else { throw Self.failure }
        if loaded.record.checkpointAdvance == nil, let last = loaded.record.operations.last, case .add = last {
            let editorBinding = try mixedAddEditor(loaded.record)
            let finished = try resumeMixedAdd(loaded.record, binding: loaded.binding, editorBinding: editorBinding,
                cancellation: cancellation)
            return try Self.summary(finished)
        }
        try mixedHistory(loaded.record, binding: loaded.binding, cancellation: cancellation)
        if loaded.record.checkpointAdvance != nil {
            let record = try finishAdvanceV3(loaded.record, binding: loaded.binding, cancellation: cancellation)
            acknowledge("checkpoint", "replayed"); return try Self.summary(record)
        }
        if let last = loaded.record.operations.last, !last.checkpointed {
            guard case .remove = last else { throw Self.failure }
            let record = try finishRemove(loaded.record, binding: loaded.binding, cancellation: cancellation)
            acknowledge("remove", "confirmed"); return try Self.summary(record)
        }
        try current(loaded.record.session.checkpoint)
        let binding = try writeMixed(loaded.record, binding: loaded.binding, cancellation: cancellation)
        try current(loaded.record.session.checkpoint); try requireMixed(binding, cancellation)
        return try Self.summary(loaded.record)
    }
    private func preflightAdvanceV3(_ record: Store.MixedRecord, admission: Bool) throws {
        guard let advance = record.checkpointAdvance else { throw Self.failure }
        try editor.preflightCheckpoint(advance.after)
        let settled = mixedRecord(record, checkpoint: advance.after)
        var shapes = [record, settled]
        if admission { shapes += try futureMixedDiscards(settled) }
        try preflightMixedShapes(shapes); try store.preflightMixed(record)
    }
    func advanceV3(_ snapshot: EditorDraftSnapshot, cancellation: NativeAttachmentCancellation) throws {
        jobs.drain()
        let loaded = try mixedRead(cancellation), record = loaded.record
        guard record.session.state == .active, record.discard == nil, record.operations.allSatisfy({ $0.checkpointed }),
              Self.equal(snapshot.sessionID, record.session.sessionID), Self.equal(snapshot.taskID, record.session.taskID) else { throw Self.failure }
        try editor.preflightCheckpoint(snapshot)
        try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
        if let pending = record.checkpointAdvance {
            guard Self.equal(snapshot, pending.after) else { throw Self.failure }
            _ = try finishAdvanceV3(record, binding: loaded.binding, cancellation: cancellation)
            acknowledge("checkpoint", "replayed"); return
        }
        try current(record.session.checkpoint)
        if Self.equal(snapshot, record.session.checkpoint) {
            let binding = try writeMixed(record, binding: loaded.binding, cancellation: cancellation)
            try current(snapshot); try requireMixed(binding, cancellation)
            acknowledge("checkpoint", "replayed"); return
        }
        guard snapshot.generation > record.session.checkpoint.generation, snapshot.generation <= 9_007_199_254_740_991 else { throw Self.failure }
        try mixedProjection(record, payload: snapshot.payloadJSON, binding: loaded.binding, cancellation: cancellation)
        let pending = mixedRecord(record, checkpoint: record.session.checkpoint, advance: .init(before: record.session.checkpoint, after: snapshot))
        try preflightAdvanceV3(pending, admission: true)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceIntent)
        #endif
        try current(record.session.checkpoint); try requireMixed(loaded.binding, cancellation)
        let binding = try writeMixed(pending, binding: loaded.binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceIntent)
        #endif
        try currentMixed([record.session.checkpoint, snapshot]); try requireMixed(binding, cancellation)
        _ = try finishAdvanceV3(pending, binding: binding, cancellation: cancellation)
        acknowledge("checkpoint", "confirmed")
    }
    private func finishAdvanceV3(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot,
                                 cancellation: NativeAttachmentCancellation) throws -> Store.MixedRecord {
        guard let advance = record.checkpointAdvance else { throw Self.failure }
        try preflightAdvanceV3(record, admission: false)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceEditor)
        #endif
        try currentMixed([advance.before, advance.after]); try requireMixed(binding, cancellation)
        try editor.checkpointOwnedAdvanceMatching(before: advance.before, after: advance.after)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceEditor)
        #endif
        try current(advance.after); try requireMixed(binding, cancellation)
        let settled = mixedRecord(record, checkpoint: advance.after)
        #if DEBUG
        try hooks?.boundary?(.beforeAdvanceMarker)
        #endif
        try current(advance.after); try requireMixed(binding, cancellation)
        let next = try writeMixed(settled, binding: binding, cancellation: cancellation)
        #if DEBUG
        try hooks?.boundary?(.afterAdvanceMarker)
        #endif
        try current(advance.after); try requireMixed(next, cancellation)
        return settled
    }

    // Explicit mixed last-Add owner. The old Add-only controller stays sealed.
    private func mixedAddEditor(_ record: Store.MixedRecord) throws -> EditorDraftStore.OwnedCheckpoint {
        guard record.session.state == .active, record.discard == nil, record.checkpointAdvance == nil,
              let binding = try editor.readOwnedCheckpoint(), binding.attempt == nil else { throw Self.failure }
        if let last = record.operations.last, case .add(let op) = last, op.phase != .checkpointed {
            guard Self.equal(binding.snapshot, op.before)
                || (op.phase == .resultDurable && Self.equal(binding.snapshot, op.after)) else { throw Self.failure }
        } else {
            guard record.operations.allSatisfy({ $0.checkpointed }), Self.equal(binding.snapshot, record.session.checkpoint) else {
                throw Self.failure
            }
        }
        return binding
    }
    private func requireMixedAdd(_ binding: Store.VersionedSnapshot, _ editorBinding: EditorDraftStore.OwnedCheckpoint,
                                 _ cancellation: NativeAttachmentCancellation) throws {
        try requireMixed(binding, cancellation)
        guard let actual = try editor.readOwnedCheckpoint(), editorBinding.matches(actual), actual.attempt == nil else { throw Self.failure }
        try requireOwner(); try cancellation.check()
    }
    private func mixedAddBoundary(_ point: AttachmentDraftBoundary, binding: Store.VersionedSnapshot,
                                  editorBinding: EditorDraftStore.OwnedCheckpoint,
                                  cancellation: NativeAttachmentCancellation) throws {
        try requireMixedAdd(binding, editorBinding, cancellation)
        #if DEBUG
        try hooks?.boundary?(point)
        #endif
        try requireMixedAdd(binding, editorBinding, cancellation)
    }
    private func mixedAddFile(_ request: NativeAttachmentDraftFileRequest, binding: Store.VersionedSnapshot,
                             editorBinding: EditorDraftStore.OwnedCheckpoint, cancellation: NativeAttachmentCancellation,
                             ignoringCancellation: Bool = false) throws -> [String: Any] {
        try requireMixedAdd(binding, editorBinding, cancellation)
        let value = try file(request, cancellation: cancellation, ignoringCancellation: ignoringCancellation)
        try requireMixedAdd(binding, editorBinding, cancellation)
        return value
    }
    private func writeMixedAdd(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot,
                               editorBinding: EditorDraftStore.OwnedCheckpoint,
                               cancellation: NativeAttachmentCancellation) throws -> Store.VersionedSnapshot {
        try requireMixedAdd(binding, editorBinding, cancellation)
        let receipt = try store.writeMixedAcknowledged(record)
        try requireMixedAdd(receipt, editorBinding, cancellation)
        return receipt
    }
    private func replacingMixedAdd(_ record: Store.MixedRecord, _ op: Store.Operation) -> Store.MixedRecord {
        mixedRecord(record, checkpoint: op.phase == .checkpointed ? op.after : record.session.checkpoint,
            operations: Array(record.operations.dropLast()) + [.add(op)])
    }
    private func preflightMixedAdd(_ record: Store.MixedRecord, admission: Bool) throws {
        guard let last = record.operations.last, case .add(let op) = last else { throw Self.failure }
        if op.phase == .checkpointed { try store.preflightMixed(record); return }
        try editor.preflightCheckpoint(op.after)
        // Unknown identities are maximum-width size placeholders only. Actual
        // jobs supply every persisted proof; no placeholder grants authority.
        let token = "18446744073709551615:18446744073709551615"
        let stageProof = op.stage ?? Store.Stage(uri: managedURI + ".mindwtr-install-"
            + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage",
            identity: token, directoryIdentity: token, privateDirectoryIdentity: token)
        let filled = op.filled ?? Store.Filled(sha256: op.source.sha256, size: op.source.size, identity: stageProof.identity)
        let published = op.published ?? Store.Published(sha256: op.source.sha256, size: op.source.size,
            identity: stageProof.identity, directoryIdentity: stageProof.directoryIdentity)
        func shape(_ phase: Store.Phase, reason: Store.Reason? = nil) throws -> Store.MixedRecord {
            let candidate = Store.Operation(requestId: op.requestId, requestJSON: op.requestJSON, phase: phase, reason: reason,
                before: op.before, after: op.after, preparedJSON: op.preparedJSON, targetURI: op.targetURI, source: op.source,
                stage: phase.rank >= Store.Phase.stagePrepared.rank ? stageProof : nil,
                filled: phase.rank >= Store.Phase.stageFilled.rank ? filled : nil,
                published: phase.rank >= Store.Phase.published.rank ? published : nil,
                replyJSON: phase.rank >= Store.Phase.resultDurable.rank ? try addReply(op) : nil)
            return replacingMixedAdd(record, candidate)
        }
        var shapes = [record]
        for phase in [Store.Phase.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed]
            where phase.rank >= op.phase.rank {
            shapes.append(try shape(phase))
            // Longest admitted reason dominates every other reason's encoding.
            if phase != .checkpointed { shapes.append(try shape(phase, reason: .interruptedReservation)) }
        }
        if admission {
            let complete = try shape(.checkpointed)
            shapes += try futureMixedDiscards(shape(.resultDurable, reason: .interruptedReservation))
                + futureMixedDiscards(complete)
            guard op.after.generation < 9_007_199_254_740_991 else { throw Self.failure }
            let next = EditorDraftSnapshot(sessionID: op.after.sessionID, taskID: op.after.taskID,
                generation: op.after.generation + 1, payloadJSON: op.after.payloadJSON)
            try editor.preflightCheckpoint(next)
            shapes += [mixedRecord(complete, checkpoint: op.after, advance: .init(before: op.after, after: next)),
                       mixedRecord(complete, checkpoint: next)]
        }
        try preflightMixedShapes(shapes)
        try store.preflightMixed(record)
    }
    func addV3(_ raw: String, cancellation: NativeAttachmentCancellation) throws -> String {
        try addMixed(raw, version: 3, cancellation: cancellation)
    }
    func addV4(_ raw: String, cancellation: NativeAttachmentCancellation) throws -> String {
        try addMixed(raw, version: 4, cancellation: cancellation)
    }
    private func addMixed(_ raw: String, version: Int, cancellation: NativeAttachmentCancellation) throws -> String {
        let request = try Self.request(raw, add: true)
        guard request.id.utf8.count == 36, request.session.utf8.count == 36 else { throw Self.failure }
        jobs.drain()
        let loaded = try mixedRead(cancellation), record = loaded.record
        guard record.version == version, Self.equal(record.session.sessionID, request.session) else { throw Self.failure }
        let editorBinding = try mixedAddEditor(record)
        try requireMixedAdd(loaded.binding, editorBinding, cancellation)
        try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
        try requireMixedAdd(loaded.binding, editorBinding, cancellation)
        if let entry = record.operations.first(where: { $0.requestId == request.id }) {
            guard case .add(let existing) = entry, Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
            if existing.phase == .checkpointed {
                guard record.operations.allSatisfy({ $0.checkpointed }), let reply = existing.replyJSON else { throw Self.failure }
                let resynced = try writeMixedAdd(record, binding: loaded.binding, editorBinding: editorBinding, cancellation: cancellation)
                acknowledge("add-mixed", "replayed")
                try requireMixedAdd(resynced, editorBinding, cancellation)
                return reply
            }
            guard record.operations.last?.requestId == request.id else { throw Self.failure }
            let finished = try resumeMixedAdd(record, binding: loaded.binding, editorBinding: editorBinding, cancellation: cancellation)
            guard let last = finished.operations.last, case .add(let op) = last, let reply = op.replyJSON else { throw Self.failure }
            return reply
        }
        guard record.operations.allSatisfy({ $0.checkpointed }), record.operations.count < 128,
              request.generation == record.session.checkpoint.generation,
              request.generation < 9_007_199_254_740_990 else { throw Self.failure }
        let sourceValue = try mixedAddFile(.snapshotSource(sourceURI: request.picked!["uri"] as! String),
            binding: loaded.binding, editorBinding: editorBinding, cancellation: cancellation)
        let sourceProof = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(sourceValue).utf8))
        var input = try mixedInput(record, payload: record.session.checkpoint.payloadJSON)
        input["requestId"] = request.id; input["picked"] = request.picked!; input["measuredSize"] = sourceProof.size
        if record.version == 4 { input["sourceSha256"] = sourceProof.sha256 }
        let frozenJSON = try mixedInvokeJSON(record.version == 4 ? "attachmentDraftPrepareV4" : "attachmentDraftPrepareV3", input, binding: loaded.binding, cancellation: cancellation)
        try requireMixedAdd(loaded.binding, editorBinding, cancellation)
        let frozen = try Self.object(frozenJSON, limit: 2 * 1024 * 1024)
        guard let afterPayload = frozen["afterPayloadJSON"] as? String, let target = frozen["targetURI"] as? String else { throw Self.failure }
        let before = record.session.checkpoint
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID,
            generation: before.generation + 1, payloadJSON: afterPayload)
        let op = Store.Operation(requestId: request.id, requestJSON: request.json, phase: .intent,
            before: before, after: after, preparedJSON: frozenJSON, targetURI: target, source: sourceProof)
        _ = try prepared(op, version: record.version == 4 ? 2 : 1)
        let intent = mixedRecord(record, checkpoint: before, operations: record.operations + [.add(op)])
        try preflightMixedAdd(intent, admission: true)
        try mixedHistory(intent, binding: loaded.binding, cancellation: cancellation)
        try mixedAddBoundary(.beforeIntent, binding: loaded.binding, editorBinding: editorBinding, cancellation: cancellation)
        let binding = try writeMixedAdd(intent, binding: loaded.binding, editorBinding: editorBinding, cancellation: cancellation)
        try mixedAddBoundary(.afterIntent, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        let finished = try resumeMixedAdd(intent, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        guard let last = finished.operations.last, case .add(let completed) = last, let reply = completed.replyJSON else { throw Self.failure }
        return reply
    }
    private func resumeMixedAdd(_ original: Store.MixedRecord, binding originalBinding: Store.VersionedSnapshot,
                                editorBinding originalEditor: EditorDraftStore.OwnedCheckpoint,
                                cancellation: NativeAttachmentCancellation) throws -> Store.MixedRecord {
        var record = original, binding = originalBinding, editorBinding = originalEditor
        guard let last = record.operations.last, case .add(var op) = last else { throw Self.failure }
        try requireMixedAdd(binding, editorBinding, cancellation)
        try mixedHistory(record, binding: binding, cancellation: cancellation)
        try requireMixedAdd(binding, editorBinding, cancellation)
        try preflightMixedAdd(record, admission: false)
        // Re-acknowledge actual retained phase before another primitive, including
        // visible writes whose earlier directory-sync acknowledgment was lost.
        binding = try writeMixedAdd(record, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        if op.phase == .checkpointed {
            acknowledge("add-mixed", "replayed")
            try requireMixedAdd(binding, editorBinding, cancellation)
            return record
        }
        do {
            if op.phase == .intent {
                guard op.reason != .interruptedReservation else { throw Self.failure }
                _ = try mixedAddFile(.ensureManagedDirectory, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                do {
                    let value = try mixedAddFile(.prepareStage(targetURI: op.targetURI,
                        operationID: op.requestId.replacingOccurrences(of: "-", with: "")),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    try mixedAddBoundary(.afterReservation, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    guard Set(value.keys) == Set(["stageURI", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]),
                          let uri = value["stageURI"] as? String, let identity = value["stagedIdentity"] as? String,
                          let directory = value["directoryIdentity"] as? String, let privateDirectory = value["privateDirectoryIdentity"] as? String else { throw Self.failure }
                    let proof = Store.Stage(uri: uri, identity: identity, directoryIdentity: directory, privateDirectoryIdentity: privateDirectory)
                    try mixedAddBoundary(.beforeStageProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    let next = replacingMixedAdd(record, advancing(op, phase: .stagePrepared, stage: proof))
                    binding = try writeMixedAdd(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    record = next; if case .add(let actual) = next.operations.last! { op = actual }
                } catch {
                    // Only the still-exact acknowledged intent can receive this
                    // reason; an uncertain phase write is never reparsed/adopted.
                    if op.phase == .intent, (try? requireMixedAdd(binding, editorBinding, cancellation)) != nil {
                        let retained = replacingMixedAdd(record, advancing(op, phase: .intent, reason: .interruptedReservation))
                        _ = try? writeMixedAdd(retained, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    }
                    throw Self.failure
                }
                try mixedAddBoundary(.afterStageProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            if op.phase == .stagePrepared {
                let value = try mixedAddFile(.fillStage(source: source(op.source), stage: stage(op.stage!)),
                    binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                let content = try JSONDecoder().decode(Store.Filled.self, from: Data(Self.json(value).utf8))
                try mixedAddBoundary(.beforeFilled, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                let next = replacingMixedAdd(record, advancing(op, phase: .stageFilled, filled: content))
                binding = try writeMixedAdd(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                record = next; if case .add(let actual) = next.operations.last! { op = actual }
                try mixedAddBoundary(.afterFilled, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            if op.phase == .stageFilled {
                var proof = try? mixedAddFile(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!),
                    sha256: op.source.sha256, size: op.source.size), binding: binding, editorBinding: editorBinding,
                    cancellation: cancellation, ignoringCancellation: true)
                if proof == nil {
                    let sourceValue = try mixedAddFile(.snapshotSource(sourceURI: op.source.sourceURI),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    let latest = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(sourceValue).utf8))
                    guard latest == op.source, Self.equal(latest.sourceURI, op.source.sourceURI) else { throw Self.failure }
                    try mixedAddBoundary(.beforePublication, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    _ = try? mixedAddFile(.publishStage(stage: stage(op.stage!), targetURI: op.targetURI, sha256: op.source.sha256),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    try mixedAddBoundary(.afterPublication, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    proof = try mixedAddFile(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!),
                        sha256: op.source.sha256, size: op.source.size), binding: binding, editorBinding: editorBinding,
                        cancellation: cancellation, ignoringCancellation: true)
                }
                guard let proof else { throw Self.failure }
                let publication = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(proof).utf8))
                let next = replacingMixedAdd(record, advancing(op, phase: .published, published: publication))
                binding = try writeMixedAdd(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                record = next; if case .add(let actual) = next.operations.last! { op = actual }
                try mixedAddBoundary(.afterPublicationProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            if op.phase == .published || op.phase == .resultDurable {
                let proof = try mixedAddFile(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!),
                    sha256: op.source.sha256, size: op.source.size), binding: binding, editorBinding: editorBinding,
                    cancellation: cancellation, ignoringCancellation: true)
                guard try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(proof).utf8)) == op.published else { throw Self.failure }
                if op.phase == .published {
                    try mixedAddBoundary(.beforeResult, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    let frozen = try prepared(op, version: record.version == 4 ? 2 : 1)
                    let value = try mixedInvoke(record.version == 4 ? "attachmentDraftResultV4" : "attachmentDraftResult", ["prepared": frozen], binding: binding, cancellation: cancellation)
                    try requireMixedAdd(binding, editorBinding, cancellation)
                    guard Set(value.keys) == Set(["version", "kind", "taskID", "requestId", "afterPayloadJSON", "attachment"]),
                          Self.integer(value["version"]) == (record.version == 4 ? 2 : 1), value["kind"] as? String == "added",
                          value["taskID"] as? String == op.before.taskID, value["requestId"] as? String == op.requestId,
                          let payload = value["afterPayloadJSON"] as? String, Self.equal(payload, op.after.payloadJSON),
                          Self.equal(try Self.json(value["attachment"]!), try Self.json(frozen["attachment"]!)) else { throw Self.failure }
                    let next = replacingMixedAdd(record, advancing(op, phase: .resultDurable, reply: try addReply(op)))
                    binding = try writeMixedAdd(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    record = next; if case .add(let actual) = next.operations.last! { op = actual }
                }
                try mixedAddBoundary(.afterResult, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                try mixedAddBoundary(.beforeCheckpoint, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                let receipt = try editor.checkpointOwnedMatching(before: op.before, after: op.after, binding: editorBinding)
                try requireMixed(binding, cancellation)
                editorBinding = receipt
                try mixedAddBoundary(.afterCheckpoint, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                try mixedAddBoundary(.beforeMarker, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                let next = replacingMixedAdd(record, advancing(op, phase: .checkpointed))
                binding = try writeMixedAdd(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                record = next
                try mixedAddBoundary(.afterMarker, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            acknowledge("add-mixed", "confirmed")
            try requireMixedAdd(binding, editorBinding, cancellation)
            return record
        } catch {
            // Preserve the last acknowledged phase only. Failed writes, foreign
            // evidence and revocation cannot refresh or overwrite authority.
            if (try? requireMixedAdd(binding, editorBinding, cancellation)) != nil,
               let last = record.operations.last, case .add(let actual) = last, actual.phase != .checkpointed {
                let retained = replacingMixedAdd(record, advancing(actual, phase: actual.phase, reason: actual.reason ?? .io))
                _ = try? writeMixedAdd(retained, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            throw Self.failure
        }
    }

    // Selected availability consumers. Structural records alone grant neither
    // shared patch authority nor ownership of a matching existing generation.
    struct AvailabilitySavePreparation {
        let binding: Store.AvailabilitySnapshot
        let snapshot: EditorDraftSnapshot
        let fingerprint: String
        let envelopeJSON: String
        let resultJSON: String
        let candidates: [MixedSaveCandidate]
        let stages: [String]
    }
    struct AvailabilityDiscardDecision {
        let decided: Store.AvailabilityRecord
        let detached: Store.AvailabilityRecord
        let replyJSON: String
    }
    struct AvailabilityDownloadRequest {
        let id: String
        let session: String
        let generation: Int
        let attachmentID: String
        let identity: String
        let json: String
    }
    static func availabilityDownloadRequest(_ raw: String) throws -> AvailabilityDownloadRequest {
        let value = try object(raw, limit: 64 * 1024)
        guard Set(value.keys) == Set(["version", "requestId", "sessionID", "generation", "attachmentId", "identity"]),
              integer(value["version"]) == 1, let id = uuid(value["requestId"]), let session = uuid(value["sessionID"]),
              let generation = integer(value["generation"], positive: true), generation < 9_007_199_254_740_991,
              let attachment = value["attachmentId"] as? String, !attachment.isEmpty,
              attachment.utf16.count <= 500, attachment.utf8.count <= 2000,
              let identity = value["identity"] as? String, !identity.isEmpty else { throw failure }
        return .init(id: id, session: session, generation: Int(generation), attachmentID: attachment, identity: identity, json: try json(value))
    }
    /// A retained UUID is handled before any configuration, HTTP or source work.
    func replayAvailabilityV5(_ request: AvailabilityDownloadRequest, cancellation: NativeAttachmentCancellation) throws -> String? {
        try requireOwner(); try cancellation.check()
        guard let snapshot = try store.readVersioned() else { return nil }
        guard case .availability(let record) = snapshot.record, record.session.state == .active,
              record.discard == nil, record.checkpointAdvance == nil,
              Self.equal(record.session.sessionID, request.session) else { throw Self.failure }
        guard let op = record.operations.first(where: { Self.equal($0.requestId, request.id) }) else {
            guard record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }),
                  record.session.checkpoint.generation == request.generation else { throw Self.failure }
            return nil
        }
        guard Self.equal(op.requestJSON, request.json) else { throw Self.failure }
        _ = try recoverV5(session: request.session, cancellation: cancellation)
        let binding = try availabilityRead(cancellation), editorBinding = try availabilityEditor(binding.record)
        guard let completed = binding.record.operations.first(where: { Self.equal($0.requestId, request.id) }),
              completed.phase == .checkpointed, let reply = completed.replyJSON else { throw Self.failure }
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        return reply
    }
    private func downloadCheckpoint(_ request: AvailabilityDownloadRequest) throws -> EditorDraftStore.OwnedCheckpoint {
        guard let binding = try editor.readOwnedCheckpoint(), binding.attempt == nil,
              Self.equal(binding.snapshot.sessionID, request.session), binding.snapshot.generation == request.generation else { throw Self.failure }
        return binding
    }
    func beginV5(_ request: AvailabilityDownloadRequest, cancellation: NativeAttachmentCancellation) throws {
        jobs.drain(); try requireOwner(); try cancellation.check()
        let editorBinding = try downloadCheckpoint(request), snapshot = editorBinding.snapshot
        let previous = try store.readVersioned()
        if let previous {
            guard case .availability(let record) = previous.record, record.session.state == .active,
                  record.discard == nil, record.checkpointAdvance == nil,
                  record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }),
                  Self.equal(record.session.checkpoint, snapshot) else { throw Self.failure }
            let binding = try availabilityRead(cancellation)
            try availabilityProjection(record, payload: snapshot.payloadJSON, binding: binding, cancellation: cancellation)
            try requireAvailabilityEditor(binding, editorBinding, cancellation)
            return
        }
        let result = try Self.object(invoke("attachmentDraftBeginV5", [Self.json(["taskID": snapshot.taskID, "payloadJSON": snapshot.payloadJSON])]))
        try requireOwner(); try cancellation.check()
        guard try store.readVersioned() == nil, let actual = try editor.readOwnedCheckpoint(), editorBinding.matches(actual),
              Set(result.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(result["version"]) == 5,
              (result["taskID"] as? String).map({ Self.equal($0, snapshot.taskID) }) == true,
              (result["payloadJSON"] as? String).map({ Self.equal($0, snapshot.payloadJSON) }) == true else { throw Self.failure }
        let record = Store.AvailabilityRecord(session: .init(sessionID: request.session, taskID: snapshot.taskID,
            state: .active, checkpoint: snapshot), operations: [])
        try store.preflightAvailability(record)
        let binding = try store.writeAvailabilityAcknowledged(record)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
    }
    /// Capacity is checked with the longest native proof tokens before GET or
    /// cache creation, and with the actual frozen proof again before intent.
    func preflightDownloadV5(_ request: AvailabilityDownloadRequest, selectedJSON: String, targetURI: String,
                             cancellation: NativeAttachmentCancellation) throws {
        try requireOwner(); try cancellation.check()
        let editorBinding = try downloadCheckpoint(request), before = editorBinding.snapshot
        let previous = try store.readVersioned()
        let base: Store.AvailabilityRecord
        if let previous {
            guard case .availability(let record) = previous.record, record.session.state == .active,
                  record.discard == nil, record.checkpointAdvance == nil,
                  record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }),
                  Self.equal(record.session.checkpoint, before) else { throw Self.failure }
            base = record
        } else { base = .init(session: .init(sessionID: request.session, taskID: before.taskID, state: .active, checkpoint: before), operations: []) }
        guard base.operations.count < 128, !base.operations.contains(where: { Self.equal($0.requestId, request.id) }) else { throw Self.failure }
        var selected = try Self.object(selectedJSON, limit: 1_000_000)
        selected["uri"] = targetURI; selected["localStatus"] = "available"
        let hash = (selected["fileHash"] as? String) ?? String(repeating: "f", count: 64)
        selected["fileHash"] = hash
        let frozenJSON = try invoke("attachmentDraftPrepareAvailability", [Self.json(["version": 1, "taskID": before.taskID,
            "requestId": request.id, "attachmentId": request.attachmentID, "identity": request.identity,
            "beforePayloadJSON": before.payloadJSON, "status": "available", "resolvedAttachmentJSON": Self.json(selected)])])
        try requireOwner(); try cancellation.check()
        guard let actual = try editor.readOwnedCheckpoint(), editorBinding.matches(actual) else { throw Self.failure }
        if let previous { guard let actual = try store.readVersioned(), previous.matches(actual) else { throw Self.failure } }
        else { guard try store.readVersioned() == nil else { throw Self.failure } }
        let frozen = try Self.object(frozenJSON, limit: 2 * 1024 * 1024)
        guard let payload = frozen["afterPayloadJSON"] as? String else { throw Self.failure }
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1, payloadJSON: payload)
        let directories = try Self.object(jobs.directoriesJSON), token = "18446744073709551615:18446744073709551615"
        guard let cache = directories["cache"] as? String else { throw Self.failure }
        let source = Store.Source(sourceURI: cache + "ffffffff-ffff-4fff-8fff-ffffffffffff", sha256: hash.lowercased(),
            size: 8 * 1024 * 1024, identity: token, cacheRootIdentity: token, parentIdentity: token)
        let op = Store.AvailabilityOperation(requestId: request.id, requestJSON: request.json, attachmentId: request.attachmentID,
            identity: request.identity, phase: .intent, before: before, after: after, preparedJSON: frozenJSON, targetURI: targetURI,
            resource: .owned(source: source, stage: nil, filled: nil, published: nil))
        try preflightAvailabilityAdmission(.init(session: base.session, operations: base.operations + [op]))
    }
    private func preflightAvailabilityAdmission(_ record: Store.AvailabilityRecord) throws {
        try preflightAvailabilityRecovery(record)
        guard let op = record.operations.last else { throw Self.failure }
        let completed = replacingAvailability(record, advancingAvailability(op, phase: .checkpointed,
            resource: { if case .owned(let source, _, _, _) = op.resource {
                let token = "18446744073709551615:18446744073709551615"
                let stage = Store.Stage(uri: managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage",
                    identity: token, directoryIdentity: token, privateDirectoryIdentity: token)
                return .owned(source: source, stage: stage, filled: .init(sha256: source.sha256, size: source.size, identity: token),
                    published: .init(sha256: source.sha256, size: source.size, identity: token, directoryIdentity: token))
            }; return op.resource }(), reply: try availabilityReply(op)))
        let used = Set(completed.operations.map(\.requestId))
        guard let discardID = (0...128).map({ String(format: "ffffffff-ffff-ffff-ffff-%012d", $0) }).first(where: { !used.contains($0) }) else { throw Self.failure }
        let checkpoint = completed.session.checkpoint
        let discardRequest = try Self.json(["version": 1, "requestId": discardID, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation])
        for phase in [Store.DiscardPhase.decided, .detached] {
            let shape = try Store.AvailabilityRecord(session: .init(sessionID: checkpoint.sessionID, taskID: checkpoint.taskID,
                state: .cleanupPending, checkpoint: checkpoint), operations: completed.operations,
                discard: .init(requestId: discardID, requestJSON: discardRequest, expected: checkpoint, phase: phase,
                    replyJSON: phase == .detached ? Self.json(["version": 1, "status": "cleanupPending", "requestId": discardID, "sessionID": checkpoint.sessionID]) : nil))
            // Future capacity shapes need structural validation, not a direct
            // transition from the current disk checkpoint to a later Discard.
            _ = try Store.availabilityFingerprint(shape)
            guard try JSONEncoder().encode(shape).count <= Store.maximumBytes else { throw Self.failure }
        }
        // Existing full Save retains both the native record and shared lineage.
        let lineage = try Self.availabilityLineageJSON(completed, payload: checkpoint.payloadJSON, managedDirectoryURI: managedURI)
        guard try JSONEncoder().encode(completed).count + lineage.utf8.count + checkpoint.payloadJSON.utf8.count <= Store.maximumBytes else { throw Self.failure }
    }
    func acceptPreparedAvailabilityV5(request: AvailabilityDownloadRequest, preparedJSON: String,
                                     resource: Store.AvailabilityResource, cancellation: NativeAttachmentCancellation) throws -> String {
        let binding = try availabilityRead(cancellation), record = binding.record, editorBinding = try downloadCheckpoint(request)
        let before = editorBinding.snapshot, frozen = try Self.object(preparedJSON, limit: 2 * 1024 * 1024)
        guard record.session.state == .active, record.discard == nil, record.checkpointAdvance == nil,
              record.operations.count < 128, record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }),
              !record.operations.contains(where: { Self.equal($0.requestId, request.id) }), Self.equal(record.session.checkpoint, before),
              (frozen["beforePayloadJSON"] as? String).map({ Self.equal($0, before.payloadJSON) }) == true,
              let payload = frozen["afterPayloadJSON"] as? String, let resolved = frozen["resolvedAttachmentJSON"] as? String else { throw Self.failure }
        let target = (try Self.object(resolved, limit: 1_000_000))["uri"] as? String
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1, payloadJSON: payload)
        let op = Store.AvailabilityOperation(requestId: request.id, requestJSON: request.json, attachmentId: request.attachmentID,
            identity: request.identity, phase: .intent, before: before, after: after, preparedJSON: preparedJSON,
            targetURI: frozen["status"] as? String == "unrecoverable" ? nil : target, resource: resource)
        let next = Store.AvailabilityRecord(session: record.session, operations: record.operations + [op])
        _ = try availabilityPrepared(op)
        try availabilityProjection(next, payload: after.payloadJSON, binding: binding, cancellation: cancellation)
        try preflightAvailabilityAdmission(next)
        try availabilityBoundary(.beforeIntent, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        let intent = try writeAvailability(next, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        try availabilityBoundary(.afterIntent, binding: intent, editorBinding: editorBinding, cancellation: cancellation)
        _ = try recoverV5(session: request.session, cancellation: cancellation)
        let settled = try availabilityRead(cancellation), currentEditor = try availabilityEditor(settled.record)
        guard let completed = settled.record.operations.last, completed.phase == .checkpointed,
              Self.equal(completed.requestJSON, request.json), let reply = completed.replyJSON else { throw Self.failure }
        acknowledge("availability-checkpoint", "confirmed")
        try requireAvailabilityEditor(settled, currentEditor, cancellation)
        return reply
    }
    private func requireAvailability(_ binding: Store.AvailabilitySnapshot,
                                     _ cancellation: NativeAttachmentCancellation) throws {
        try requireOwner(); try cancellation.check()
        guard let actual = try store.readAvailabilitySnapshot(), binding.matches(actual) else { throw Self.failure }
        try requireOwner(); try cancellation.check()
    }
    private func availabilityRead(_ cancellation: NativeAttachmentCancellation) throws -> Store.AvailabilitySnapshot {
        try requireOwner(); try cancellation.check()
        guard let binding = try store.readAvailabilitySnapshot() else { throw Self.failure }
        try requireAvailability(binding, cancellation)
        return binding
    }
    private func availabilityInvoke(_ method: String, _ input: [String: Any], binding: Store.AvailabilitySnapshot,
                                    cancellation: NativeAttachmentCancellation) throws -> [String: Any] {
        try requireAvailability(binding, cancellation)
        let encoded = try Self.json(input)
        guard encoded.utf8.count <= Store.maximumBytes else { throw Self.failure }
        let result = try Self.object(invoke(method, [encoded]))
        try requireAvailability(binding, cancellation)
        return result
    }
    private func availabilityPrepared(_ op: Store.AvailabilityOperation) throws -> [String: Any] {
        let request = try Self.object(op.requestJSON, limit: 64 * 1024)
        guard Set(request.keys) == Set(["version", "requestId", "sessionID", "generation", "attachmentId", "identity"]),
              Self.integer(request["version"]) == 1, Self.uuid(request["requestId"]) == op.requestId,
              Self.uuid(request["sessionID"]) == op.before.sessionID, Self.integer(request["generation"]) == Int64(op.before.generation),
              (request["attachmentId"] as? String).map({ Self.equal($0, op.attachmentId) }) == true,
              (request["identity"] as? String).map({ Self.equal($0, op.identity) }) == true,
              Self.equal(try Self.json(request), op.requestJSON) else { throw Self.failure }
        let frozen = try Self.object(op.preparedJSON, limit: 2 * 1024 * 1024)
        guard Set(frozen.keys) == Set(["version", "kind", "taskID", "requestId", "attachmentId", "identity", "beforePayloadJSON", "afterPayloadJSON", "status", "resolvedAttachmentJSON"]),
              Self.integer(frozen["version"]) == 1, frozen["kind"] as? String == "prepared-file-availability",
              (frozen["taskID"] as? String).map({ Self.equal($0, op.before.taskID) }) == true,
              (frozen["requestId"] as? String).map({ Self.equal($0, op.requestId) }) == true,
              (frozen["attachmentId"] as? String).map({ Self.equal($0, op.attachmentId) }) == true,
              (frozen["identity"] as? String).map({ Self.equal($0, op.identity) }) == true,
              (frozen["beforePayloadJSON"] as? String).map({ Self.equal($0, op.before.payloadJSON) }) == true,
              (frozen["afterPayloadJSON"] as? String).map({ Self.equal($0, op.after.payloadJSON) }) == true else { throw Self.failure }
        if case .owned(_, let reserved?, _, _) = op.resource {
            let expected = managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage"
            guard Self.equal(reserved.uri, expected) else { throw Self.failure }
        }
        if let target = op.targetURI {
            guard let url = URL(string: target), Self.equal(url.deletingLastPathComponent().absoluteString, managedURI) else { throw Self.failure }
        }
        if let reply = op.replyJSON { guard Self.equal(reply, try availabilityReply(op)) else { throw Self.failure } }
        return ["kind": "availability", "operation": frozen]
    }
    private func availabilityReply(_ op: Store.AvailabilityOperation) throws -> String {
        let frozen = try Self.object(op.preparedJSON, limit: 2 * 1024 * 1024)
        guard let status = frozen["status"] as? String, ["available", "unrecoverable"].contains(status) else { throw Self.failure }
        return try Self.json(["version": 1, "status": status == "available" ? "draftAvailable" : "draftUnrecoverable",
            "requestId": op.requestId, "sessionID": op.after.sessionID, "generation": op.after.generation, "attachmentId": op.attachmentId])
    }
    static func availabilitySaveLineageJSON(_ record: Store.AvailabilityRecord, managedDirectoryURI: String) throws -> String {
        _ = try Store.availabilityFingerprint(record)
        guard record.session.state == .active, record.discard == nil, record.checkpointAdvance == nil,
              record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }) else { throw failure }
        return try availabilityLineageJSON(record, payload: record.session.checkpoint.payloadJSON, managedDirectoryURI: managedDirectoryURI)
    }
    private static func availabilityLineageJSON(_ record: Store.AvailabilityRecord, payload: String, managedDirectoryURI: String) throws -> String {
        try json(["version": 5, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "beforePayloadJSON": payload, "priorOperations": try record.operations.map {
                ["kind": "availability", "operation": try object($0.preparedJSON, limit: 2 * 1024 * 1024)] as [String: Any]
            }, "managedDirectoryURI": managedDirectoryURI])
    }
    private func availabilityProjection(_ record: Store.AvailabilityRecord, payload: String, binding: Store.AvailabilitySnapshot,
                                        cancellation: NativeAttachmentCancellation) throws {
        for op in record.operations { _ = try availabilityPrepared(op) }
        let input = try Self.object(Self.availabilityLineageJSON(record, payload: payload, managedDirectoryURI: managedURI))
        let result = try availabilityInvoke("attachmentDraftValidateLineageV5", input, binding: binding, cancellation: cancellation)
        guard Set(result.keys) == Set(["version", "taskID", "payloadJSON"]), Self.integer(result["version"]) == 5,
              (result["taskID"] as? String).map({ Self.equal($0, record.session.taskID) }) == true,
              (result["payloadJSON"] as? String).map({ Self.equal($0, payload) }) == true else { throw Self.failure }
    }
    private func availabilityEditor(_ record: Store.AvailabilityRecord) throws -> EditorDraftStore.OwnedCheckpoint {
        guard record.session.state == .active, record.discard == nil, let binding = try editor.readOwnedCheckpoint(), binding.attempt == nil else { throw Self.failure }
        var allowed = [record.session.checkpoint]
        if let last = record.operations.last, last.phase == .resultDurable { allowed.append(last.after) }
        if let advance = record.checkpointAdvance { allowed.append(advance.after) }
        guard allowed.contains(where: { Self.equal($0, binding.snapshot) }) else { throw Self.failure }
        return binding
    }
    private func requireAvailabilityEditor(_ binding: Store.AvailabilitySnapshot, _ editorBinding: EditorDraftStore.OwnedCheckpoint,
                                           _ cancellation: NativeAttachmentCancellation) throws {
        try requireAvailability(binding, cancellation)
        guard let current = try editor.readOwnedCheckpoint(), editorBinding.matches(current), current.attempt == nil else { throw Self.failure }
        try requireOwner(); try cancellation.check()
    }
    private func availabilityBoundary(_ point: AttachmentDraftBoundary, binding: Store.AvailabilitySnapshot,
                                      editorBinding: EditorDraftStore.OwnedCheckpoint, cancellation: NativeAttachmentCancellation) throws {
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        #if DEBUG
        try hooks?.boundary?(point)
        #endif
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
    }
    private func availabilityFile(_ request: NativeAttachmentDraftFileRequest, binding: Store.AvailabilitySnapshot,
                                  editorBinding: EditorDraftStore.OwnedCheckpoint, cancellation: NativeAttachmentCancellation) throws -> [String: Any] {
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        let result = try file(request, cancellation: cancellation)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        return result
    }
    private func writeAvailability(_ record: Store.AvailabilityRecord, binding: Store.AvailabilitySnapshot,
                                   editorBinding: EditorDraftStore.OwnedCheckpoint, cancellation: NativeAttachmentCancellation) throws -> Store.AvailabilitySnapshot {
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        let next = try store.writeAvailabilityAcknowledged(record)
        try requireAvailabilityEditor(next, editorBinding, cancellation)
        return next
    }
    private func availabilityRecord(_ record: Store.AvailabilityRecord, checkpoint: EditorDraftSnapshot,
                                    operations: [Store.AvailabilityOperation]? = nil, advance: Store.CheckpointAdvance? = nil) -> Store.AvailabilityRecord {
        .init(session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: record.session.state, checkpoint: checkpoint),
              operations: operations ?? record.operations, discard: record.discard, checkpointAdvance: advance)
    }
    private func advancingAvailability(_ op: Store.AvailabilityOperation, phase: Store.Phase, resource: Store.AvailabilityResource? = nil,
                                      reply: String? = nil, reason: Store.Reason? = nil) -> Store.AvailabilityOperation {
        .init(requestId: op.requestId, requestJSON: op.requestJSON, attachmentId: op.attachmentId, identity: op.identity,
              phase: phase, reason: reason, before: op.before, after: op.after, preparedJSON: op.preparedJSON,
              targetURI: op.targetURI, resource: resource ?? op.resource, replyJSON: reply ?? op.replyJSON)
    }
    private func replacingAvailability(_ record: Store.AvailabilityRecord, _ op: Store.AvailabilityOperation) -> Store.AvailabilityRecord {
        availabilityRecord(record, checkpoint: op.phase == .checkpointed ? op.after : record.session.checkpoint,
                           operations: Array(record.operations.dropLast()) + [op])
    }
    static func availabilityOwnedOperation(_ op: Store.AvailabilityOperation) throws -> Store.Operation {
        guard case .owned(let source, let stage, let filled, let published) = op.resource, let target = op.targetURI else { throw failure }
        // Physical helper adapter only. It is never admitted as an Add proof.
        return .init(requestId: op.requestId, requestJSON: op.requestJSON, phase: op.phase, reason: op.reason,
            before: op.before, after: op.after, preparedJSON: op.preparedJSON, targetURI: target,
            source: source, stage: stage, filled: filled, published: published, replyJSON: op.replyJSON)
    }
    private func verifyAvailabilityResource(_ op: Store.AvailabilityOperation, cancellation: NativeAttachmentCancellation) throws {
        try requireOwner(); try cancellation.check()
        switch op.resource {
        case .none: break
        case .borrowed(let expected):
            guard let target = op.targetURI else { throw Self.failure }
            let observed = try MixedSaveObservation.read(file(.snapshotBaseline(attachmentID: op.attachmentId, targetURI: target), cancellation: cancellation))
            guard let actual = observed.proof, actual.sha256 == expected.sha256, actual.size == expected.size,
                  Self.equal(actual.identity, expected.identity), Self.equal(actual.directoryIdentity, expected.directoryIdentity) else { throw Self.failure }
        case .owned:
            let owned = try Self.availabilityOwnedOperation(op)
            guard let reserved = owned.stage, let expected = owned.published else { throw Self.failure }
            let raw = try file(.verifyPublication(targetURI: owned.targetURI, stage: stage(reserved),
                sha256: owned.source.sha256, size: owned.source.size), cancellation: cancellation)
            guard try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(raw).utf8)) == expected else { throw Self.failure }
        }
        try requireOwner(); try cancellation.check()
    }
    private func preflightAvailabilityRecovery(_ record: Store.AvailabilityRecord) throws {
        try store.preflightAvailability(record)
        guard let op = record.operations.last, op.phase != .checkpointed else { return }
        try editor.preflightCheckpoint(op.after)
        let token = "18446744073709551615:18446744073709551615"
        let phases: [Store.Phase]
        let ownedProofs: (Store.Source, Store.Stage, Store.Filled, Store.Published)?
        switch op.resource {
        case .owned(let source, let reserved, let filled, let published):
            let stage = reserved ?? Store.Stage(uri: managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage",
                identity: token, directoryIdentity: token, privateDirectoryIdentity: token)
            ownedProofs = (source, stage, filled ?? .init(sha256: source.sha256, size: source.size, identity: stage.identity),
                published ?? .init(sha256: source.sha256, size: source.size, identity: stage.identity, directoryIdentity: stage.directoryIdentity))
            phases = [.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed]
        default: ownedProofs = nil; phases = [.intent, .resultDurable, .checkpointed]
        }
        for phase in phases where phase.rank >= op.phase.rank {
            let resource: Store.AvailabilityResource
            if let (source, stage, filled, published) = ownedProofs {
                resource = .owned(source: source, stage: phase.rank >= Store.Phase.stagePrepared.rank ? stage : nil,
                    filled: phase.rank >= Store.Phase.stageFilled.rank ? filled : nil,
                    published: phase.rank >= Store.Phase.published.rank ? published : nil)
            } else { resource = op.resource }
            let reply = phase.rank >= Store.Phase.resultDurable.rank ? try availabilityReply(op) : nil
            for reason in phase == .checkpointed ? [nil] : [nil, Store.Reason.interruptedReservation] {
                let next = advancingAvailability(op, phase: phase, resource: resource, reply: reply, reason: reason)
                let shape = replacingAvailability(record, next)
                _ = try Store.availabilityFingerprint(shape)
                guard try JSONEncoder().encode(shape).count <= Store.maximumBytes else { throw Self.failure }
            }
        }
    }
    func recoverV5(session: String, cancellation: NativeAttachmentCancellation) throws -> String {
        jobs.drain()
        var binding = try availabilityRead(cancellation), record = binding.record
        guard Self.uuid(session) != nil, Self.equal(session, record.session.sessionID) else { throw Self.failure }
        var editorBinding = try availabilityEditor(record)
        let projected = record.operations.last.flatMap { $0.phase == .checkpointed ? nil : $0.after.payloadJSON } ?? record.session.checkpoint.payloadJSON
        try availabilityProjection(record, payload: projected, binding: binding, cancellation: cancellation)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        if record.checkpointAdvance != nil {
            record = try finishAdvanceV5(record, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            return try Self.summary(record)
        }
        try preflightAvailabilityRecovery(record)
        binding = try writeAvailability(record, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        guard var op = record.operations.last else { return try Self.summary(record) }
        if op.phase == .checkpointed { return try Self.summary(record) }
        func persist(_ next: Store.AvailabilityOperation) throws {
            let changed = replacingAvailability(record, next)
            try editor.preflightCheckpoint(next.after); try store.preflightAvailability(changed)
            binding = try writeAvailability(changed, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            record = changed; op = next
        }
        if case .owned(let source, _, _, _) = op.resource {
            if op.phase == .intent {
                guard op.reason != .interruptedReservation, let target = op.targetURI else { throw Self.failure }
                _ = try availabilityFile(.ensureManagedDirectory, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                do {
                    let raw = try availabilityFile(.prepareStage(targetURI: target, operationID: op.requestId.replacingOccurrences(of: "-", with: "")),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    try availabilityBoundary(.afterReservation, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    guard Set(raw.keys) == Set(["stageURI", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]),
                          let uri = raw["stageURI"] as? String, let inode = raw["stagedIdentity"] as? String,
                          let directory = raw["directoryIdentity"] as? String, let parent = raw["privateDirectoryIdentity"] as? String else { throw Self.failure }
                    try availabilityBoundary(.beforeStageProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    try persist(advancingAvailability(op, phase: .stagePrepared,
                        resource: .owned(source: source, stage: .init(uri: uri, identity: inode, directoryIdentity: directory, privateDirectoryIdentity: parent), filled: nil, published: nil)))
                } catch {
                    if op.phase == .intent, (try? requireAvailabilityEditor(binding, editorBinding, cancellation)) != nil {
                        try? persist(advancingAvailability(op, phase: .intent, reason: .interruptedReservation))
                    }
                    throw Self.failure
                }
                try availabilityBoundary(.afterStageProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            if op.phase == .stagePrepared {
                guard case .owned(_, let reserved?, _, _) = op.resource else { throw Self.failure }
                let raw = try availabilityFile(.fillStage(source: self.source(source), stage: stage(reserved)),
                    binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                let filled = try JSONDecoder().decode(Store.Filled.self, from: Data(Self.json(raw).utf8))
                try availabilityBoundary(.beforeFilled, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                try persist(advancingAvailability(op, phase: .stageFilled,
                    resource: .owned(source: source, stage: reserved, filled: filled, published: nil)))
                try availabilityBoundary(.afterFilled, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
            if op.phase == .stageFilled {
                guard case .owned(_, let reserved?, let filled?, _) = op.resource, let target = op.targetURI else { throw Self.failure }
                var proof = try? availabilityFile(.verifyPublication(targetURI: target, stage: stage(reserved), sha256: filled.sha256, size: filled.size),
                    binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                if proof == nil {
                    let raw = try availabilityFile(.snapshotSource(sourceURI: source.sourceURI), binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    guard try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(raw).utf8)) == source else { throw Self.failure }
                    try availabilityBoundary(.beforePublication, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    _ = try? availabilityFile(.publishStage(stage: stage(reserved), targetURI: target, sha256: filled.sha256),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    try availabilityBoundary(.afterPublication, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                    proof = try availabilityFile(.verifyPublication(targetURI: target, stage: stage(reserved), sha256: filled.sha256, size: filled.size),
                        binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                }
                guard let proof else { throw Self.failure }
                let publication = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(proof).utf8))
                try persist(advancingAvailability(op, phase: .published,
                    resource: .owned(source: source, stage: reserved, filled: filled, published: publication)))
                try availabilityBoundary(.afterPublicationProof, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            }
        }
        if op.phase == .intent || op.phase == .published || op.phase == .resultDurable {
            try requireAvailabilityEditor(binding, editorBinding, cancellation)
            try verifyAvailabilityResource(op, cancellation: cancellation)
            try requireAvailabilityEditor(binding, editorBinding, cancellation)
            if op.phase != .resultDurable {
                try availabilityBoundary(.beforeResult, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
                try persist(advancingAvailability(op, phase: .resultDurable, reply: try availabilityReply(op)))
            }
            try availabilityBoundary(.afterResult, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            try availabilityBoundary(.beforeCheckpoint, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            editorBinding = try editor.checkpointOwnedMatching(before: op.before, after: op.after, binding: editorBinding)
            try requireAvailabilityEditor(binding, editorBinding, cancellation)
            try availabilityBoundary(.afterCheckpoint, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            try availabilityBoundary(.beforeMarker, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
            try persist(advancingAvailability(op, phase: .checkpointed))
            try availabilityBoundary(.afterMarker, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        }
        guard op.phase == .checkpointed else { throw Self.failure }
        return try Self.summary(record)
    }
    private static func summary(_ record: Store.AvailabilityRecord) throws -> String {
        let status = record.checkpointAdvance != nil ? "checkpointPending" : record.session.state == .cleanupPending ? "cleanupPending"
            : record.operations.last?.reason != nil ? "uncertain" : "active"
        return try json(["version": 5, "status": status, "sessionID": record.session.sessionID,
            "checkpoint": try object(String(decoding: JSONEncoder().encode(record.session.checkpoint), as: UTF8.self)),
            "operations": record.operations.map { ["kind": "availability", "requestId": $0.requestId, "phase": $0.phase.rawValue,
                "reason": $0.reason.map { $0.rawValue as Any } ?? NSNull()] },
            "discard": record.discard.map { ["requestId": $0.requestId, "phase": $0.phase.rawValue] as Any } ?? NSNull()])
    }
    func checkResumeV5(_ snapshot: EditorDraftSnapshot, cancellation: NativeAttachmentCancellation) throws -> String {
        jobs.drain(); let binding = try availabilityRead(cancellation), record = binding.record
        let lineage = try Self.availabilitySaveLineageJSON(record, managedDirectoryURI: managedURI)
        guard Self.equal(record.session.checkpoint, snapshot) else { throw Self.failure }
        let editorBinding = try availabilityEditor(record)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        try availabilityProjection(record, payload: snapshot.payloadJSON, binding: binding, cancellation: cancellation)
        let checkpoint = try Self.object(String(decoding: JSONEncoder().encode(snapshot), as: UTF8.self))
        let ready = try availabilityInvoke("attachmentDraftResumeCheckV3", ["version": 3, "kind": "owned-editor-resume", "checkpoint": checkpoint,
            "ownedDraft": try Self.object(lineage)], binding: binding, cancellation: cancellation)
        guard Set(ready.keys) == Set(["kind", "freshDraft", "freshScheduleBase", "freshRecurrenceBase", "freshChecklistBase", "freshAttachmentsBase"]),
              ready["kind"] as? String == "ready", ready["freshDraft"] is [String: Any], ready["freshScheduleBase"] is [String: Any],
              ready["freshRecurrenceBase"] is [String: Any], ready["freshChecklistBase"] is [[String: Any]], ready["freshAttachmentsBase"] is [[String: Any]] else { throw Self.failure }
        let result = try Self.json(["version": 1, "checkpoint": checkpoint, "ready": ready])
        guard result.utf8.count <= Store.maximumBytes else { throw Self.failure }
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        acknowledge("availability-resume", "validated")
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        return result
    }
    func advanceV5(_ snapshot: EditorDraftSnapshot, cancellation: NativeAttachmentCancellation) throws {
        jobs.drain(); let binding = try availabilityRead(cancellation), record = binding.record
        guard record.session.state == .active, record.discard == nil, record.operations.allSatisfy({ $0.phase == .checkpointed && $0.reason == nil }),
              Self.equal(snapshot.sessionID, record.session.sessionID), Self.equal(snapshot.taskID, record.session.taskID) else { throw Self.failure }
        let editorBinding = try availabilityEditor(record)
        try availabilityProjection(record, payload: snapshot.payloadJSON, binding: binding, cancellation: cancellation)
        if let pending = record.checkpointAdvance {
            guard Self.equal(snapshot, pending.after) else { throw Self.failure }
            _ = try finishAdvanceV5(record, binding: binding, editorBinding: editorBinding, cancellation: cancellation); return
        }
        guard snapshot.generation > record.session.checkpoint.generation else {
            guard Self.equal(snapshot, record.session.checkpoint) else { throw Self.failure }; return
        }
        let pending = availabilityRecord(record, checkpoint: record.session.checkpoint,
            advance: .init(before: record.session.checkpoint, after: snapshot))
        try editor.preflightCheckpoint(snapshot); try store.preflightAvailability(pending)
        let settled = availabilityRecord(pending, checkpoint: snapshot)
        guard try JSONEncoder().encode(settled).count <= Store.maximumBytes else { throw Self.failure }
        try availabilityBoundary(.beforeAdvanceIntent, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        let next = try writeAvailability(pending, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        try availabilityBoundary(.afterAdvanceIntent, binding: next, editorBinding: editorBinding, cancellation: cancellation)
        _ = try finishAdvanceV5(pending, binding: next, editorBinding: editorBinding, cancellation: cancellation)
    }
    private func finishAdvanceV5(_ record: Store.AvailabilityRecord, binding: Store.AvailabilitySnapshot,
                                 editorBinding: EditorDraftStore.OwnedCheckpoint, cancellation: NativeAttachmentCancellation) throws -> Store.AvailabilityRecord {
        guard let advance = record.checkpointAdvance else { throw Self.failure }
        try availabilityProjection(record, payload: advance.after.payloadJSON, binding: binding, cancellation: cancellation)
        try availabilityBoundary(.beforeAdvanceEditor, binding: binding, editorBinding: editorBinding, cancellation: cancellation)
        let receipt = try editor.checkpointOwnedMatching(before: advance.before, after: advance.after, binding: editorBinding)
        try availabilityBoundary(.afterAdvanceEditor, binding: binding, editorBinding: receipt, cancellation: cancellation)
        let settled = availabilityRecord(record, checkpoint: advance.after)
        try availabilityBoundary(.beforeAdvanceMarker, binding: binding, editorBinding: receipt, cancellation: cancellation)
        let next = try writeAvailability(settled, binding: binding, editorBinding: receipt, cancellation: cancellation)
        try availabilityBoundary(.afterAdvanceMarker, binding: next, editorBinding: receipt, cancellation: cancellation)
        acknowledge("availability-checkpoint", "confirmed")
        try requireAvailabilityEditor(next, receipt, cancellation)
        return settled
    }

    static func availabilitySaveCandidates(plan: [[String: Any]], envelopeJSON: String, authorities: [MixedSaveAuthority],
                                            record: Store.AvailabilityRecord?) throws -> [MixedSaveCandidate] {
        let envelope = try object(envelopeJSON)
        guard let request = envelope["request"] as? [String: Any], integer(request["version"]) == 4,
              let save = request["saveRequest"] as? [String: Any], let half = save["attachments"] as? [String: Any],
              let baseline = half["base"] as? [[String: Any]], let owned = request["ownedDraft"] as? [String: Any],
              integer(owned["version"]) == 5, let history = owned["priorOperations"] as? [[String: Any]],
              authorities.count == plan.count else { throw failure }
        let operations = try history.map { entry -> [String: Any] in
            guard Set(entry.keys) == Set(["kind", "operation"]), entry["kind"] as? String == "availability",
                  let frozen = entry["operation"] as? [String: Any] else { throw failure }
            return frozen
        }
        return try plan.enumerated().map { index, value in
            guard Set(value.keys) == Set(["attachment", "reason"]), let attachment = value["attachment"] as? [String: Any],
                  attachment["kind"] as? String == "file", let id = attachment["id"] as? String, let uri = attachment["uri"] as? String,
                  !uri.isEmpty, let reason = value["reason"] as? String,
                  ["uncommitted-draft", "replaced-baseline", "deleted-after-save"].contains(reason) else { throw failure }
            let originals = baseline.filter { ($0["id"] as? String).map { equal($0, id) } == true
                && ($0["uri"] as? String).map { equal($0, uri) } == true && $0["kind"] as? String == "file" }
            let matching = try operations.filter { frozen in
                guard frozen["status"] as? String == "available", let raw = frozen["resolvedAttachmentJSON"] as? String else { return false }
                let resolved = try object(raw, limit: 1_000_000)
                return (frozen["attachmentId"] as? String).map { equal($0, id) } == true
                    && (resolved["uri"] as? String).map { equal($0, uri) } == true
            }
            switch authorities[index] {
            case .ownedAdd: throw failure
            case .ownedAvailability(let requestID), .borrowedAvailability(let requestID):
                guard matching.count == 1, originals.count <= 1,
                      (originals.isEmpty ? reason == "uncommitted-draft" : ["replaced-baseline", "deleted-after-save"].contains(reason)),
                      (matching[0]["requestId"] as? String).map({ equal($0, requestID) }) == true else { throw failure }
                if let record {
                    let retained = record.operations.filter { equal($0.requestId, requestID) && equal($0.attachmentId, id)
                        && $0.targetURI.map { equal($0, uri) } == true }
                    guard retained.count == 1 else { throw failure }
                    switch (authorities[index], retained[0].resource) {
                    case (.ownedAvailability, .owned(_, let stage?, _, let published?)):
                        guard equal(stage.identity, published.identity), equal(stage.directoryIdentity, published.directoryIdentity) else { throw failure }
                    case (.borrowedAvailability, .borrowed): break
                    default: throw failure
                    }
                }
            case .baseline(let observation):
                guard originals.count == 1, matching.isEmpty, reason != "uncommitted-draft", equal(observation.targetURI, uri) else { throw failure }
            }
            return .init(index: index, attachmentID: id, targetURI: uri, reason: reason, authority: authorities[index])
        }
    }
    func prepareAvailabilitySave(_ raw: String, session: String, generation: Int,
                                 cancellation: NativeAttachmentCancellation) throws -> AvailabilitySavePreparation {
        jobs.drain(); let binding = try availabilityRead(cancellation), record = binding.record
        let lineage = try Self.availabilitySaveLineageJSON(record, managedDirectoryURI: managedURI)
        let editorBinding = try availabilityEditor(record)
        guard Self.equal(session, editorBinding.snapshot.sessionID), generation == editorBinding.snapshot.generation else { throw Self.failure }
        try availabilityProjection(record, payload: editorBinding.snapshot.payloadJSON, binding: binding, cancellation: cancellation)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        let request: [String: Any] = ["version": 4, "kind": "owned-editor-file-edit-save",
            "checkpoint": try Self.object(String(decoding: JSONEncoder().encode(editorBinding.snapshot), as: UTF8.self)),
            "ownedDraft": try Self.object(lineage), "saveRequest": try Self.object(raw, limit: 2_000_000)]
        let response = try availabilityInvoke("attachmentFileEditSavePrepare", request, binding: binding, cancellation: cancellation)
        guard Set(response.keys) == Set(["kind", "prepared"]), response["kind"] as? String == "prepared",
              let prepared = response["prepared"] as? [String: Any], let repeated = prepared["request"] as? [String: Any],
              Self.equal(try Self.json(repeated), try Self.json(request)) else { throw Self.failure }
        let envelopeJSON = try Self.json(["request": request, "prepared": prepared])
        guard envelopeJSON.utf8.count <= Store.maximumBytes else { throw Self.failure }
        let validation = try availabilityInvoke("attachmentFileEditSaveValidate", try Self.object(envelopeJSON), binding: binding, cancellation: cancellation)
        guard Set(validation.keys) == Set(["version", "kind", "result", "settlementPlan"]), Self.integer(validation["version"]) == 4,
              validation["kind"] as? String == "owned-editor-file-edit-save", let result = validation["result"] as? [String: Any],
              let plan = validation["settlementPlan"] as? [[String: Any]], !record.operations.isEmpty || plan.isEmpty else { throw Self.failure }
        let baseline = ((request["saveRequest"] as? [String: Any])?["attachments"] as? [String: Any])?["base"] as? [[String: Any]] ?? []
        var authorities: [MixedSaveAuthority] = []
        for value in plan {
            guard let attachment = value["attachment"] as? [String: Any], let id = attachment["id"] as? String,
                  let uri = attachment["uri"] as? String else { throw Self.failure }
            let originals = baseline.filter { ($0["id"] as? String).map { Self.equal($0, id) } == true
                && ($0["uri"] as? String).map { Self.equal($0, uri) } == true }
            let matching = record.operations.filter { Self.equal($0.attachmentId, id) && $0.targetURI.map { Self.equal($0, uri) } == true }
            guard matching.count <= 1, originals.count <= 1 else { throw Self.failure }
            if let retained = matching.first {
                switch retained.resource {
                case .owned: authorities.append(.ownedAvailability(retained.requestId))
                case .borrowed: authorities.append(.borrowedAvailability(retained.requestId))
                case .none: throw Self.failure
                }
            } else {
                guard originals.count == 1 else { throw Self.failure }
                try requireAvailabilityEditor(binding, editorBinding, cancellation)
                let observed = try MixedSaveObservation.read(file(.snapshotBaseline(attachmentID: id, targetURI: uri), cancellation: cancellation))
                try requireAvailabilityEditor(binding, editorBinding, cancellation)
                authorities.append(.baseline(observed))
            }
        }
        let candidates = try Self.availabilitySaveCandidates(plan: plan, envelopeJSON: envelopeJSON, authorities: authorities, record: record)
        try verifyAvailabilitySavePublished(record, envelopeJSON: envelopeJSON, cancellation: cancellation)
        try requireAvailabilityEditor(binding, editorBinding, cancellation)
        return .init(binding: binding, snapshot: editorBinding.snapshot, fingerprint: try Store.availabilityFingerprint(record),
            envelopeJSON: envelopeJSON, resultJSON: try Self.json(result), candidates: candidates,
            stages: record.operations.compactMap { if case .owned = $0.resource { return $0.requestId }; return nil })
    }
    func verifyAvailabilitySavePublished(_ record: Store.AvailabilityRecord, envelopeJSON: String,
                                        cancellation: NativeAttachmentCancellation) throws {
        jobs.drain(); try requireOwner(); try cancellation.check()
        _ = try Self.availabilitySaveLineageJSON(record, managedDirectoryURI: managedURI)
        for op in record.operations { _ = try availabilityPrepared(op) }
        let envelope = try Self.object(envelopeJSON)
        guard let request = envelope["request"] as? [String: Any], let save = request["saveRequest"] as? [String: Any],
              let id = save["id"] as? String, let prepared = envelope["prepared"] as? [String: Any], Self.integer(prepared["version"]) == 4,
              let decision = prepared["decision"] as? [String: Any], let proof = decision["prepared"] as? [String: Any] else { throw Self.failure }
        let tasks: [[String: Any]]
        switch decision["kind"] as? String {
        case "changed":
            guard let rows = (proof["effect"] as? [String: Any])?["tasks"] as? [[String: Any]] else { throw Self.failure }
            tasks = try rows.map { guard let after = $0["after"] as? [String: Any] else { throw Self.failure }; return after }
            guard tasks.filter({ ($0["id"] as? String).map { Self.equal($0, id) } == true }).count == 1 else { throw Self.failure }
        case "noop":
            guard let source = (proof["witness"] as? [String: Any])?["source"] as? [String: Any],
                  (source["id"] as? String).map({ Self.equal($0, id) }) == true else { throw Self.failure }
            tasks = [source]
        default: throw Self.failure
        }
        let attachments = try tasks.flatMap { task -> [[String: Any]] in
            guard task["attachments"] == nil || task["attachments"] is [[String: Any]] else { throw Self.failure }
            return task["attachments"] as? [[String: Any]] ?? []
        }
        for op in record.operations where op.targetURI.map({ target in attachments.contains {
            $0["kind"] as? String == "file" && ($0["uri"] as? String).map { Self.equal($0, target) } == true
                && ($0["deletedAt"] == nil || $0["deletedAt"] is NSNull)
        } }) == true { try verifyAvailabilityResource(op, cancellation: cancellation) }
    }
    func prepareAvailabilityDiscardDecision(_ raw: String, record: Store.AvailabilityRecord) throws -> AvailabilityDiscardDecision {
        let request = try Self.request(raw, add: false)
        _ = try Store.availabilityFingerprint(record)
        guard record.checkpointAdvance == nil, Self.equal(record.session.sessionID, request.session),
              !record.operations.contains(where: { Self.equal($0.requestId, request.id) }) else { throw Self.failure }
        if let existing = record.discard {
            guard Self.equal(existing.requestJSON, request.json), Self.equal(existing.expected, record.session.checkpoint) else { throw Self.failure }
        } else { guard record.session.state == .active, record.session.checkpoint.generation == request.generation else { throw Self.failure } }
        let reply = try Self.json(["version": 1, "status": "cleanupPending", "requestId": request.id, "sessionID": request.session])
        let session = Store.Session(sessionID: record.session.sessionID, taskID: record.session.taskID,
            state: .cleanupPending, checkpoint: record.session.checkpoint)
        let decided = Store.AvailabilityRecord(session: session, operations: record.operations,
            discard: .init(requestId: request.id, requestJSON: request.json, expected: record.session.checkpoint, phase: .decided))
        let detached = Store.AvailabilityRecord(session: session, operations: record.operations,
            discard: .init(requestId: request.id, requestJSON: request.json, expected: record.session.checkpoint, phase: .detached, replyJSON: reply))
        if let retained = record.discard?.replyJSON { guard Self.equal(retained, reply) else { throw Self.failure } }
        return .init(decided: decided, detached: detached, replyJSON: reply)
    }
    func prepareAvailabilityDiscardCandidates(_ record: Store.AvailabilityRecord, binding: Store.AvailabilitySnapshot,
                                             cancellation: NativeAttachmentCancellation) throws -> [Store.AvailabilityOperation] {
        jobs.drain(); try requireAvailability(binding, cancellation)
        _ = try Store.availabilityFingerprint(record)
        guard record.checkpointAdvance == nil else { throw Self.failure }
        for op in record.operations { _ = try availabilityPrepared(op) }
        if let discard = record.discard { _ = try prepareAvailabilityDiscardDecision(discard.requestJSON, record: record) }
        let operations = record.operations.map { ["kind": "availability", "phase": $0.phase == .checkpointed ? "checkpointed" : "intent", "preparedJSON": $0.preparedJSON] }
        let response = try availabilityInvoke("attachmentDraftDiscardCandidatesV5", ["version": 4, "historyVersion": 5,
            "taskID": record.session.taskID, "managedDirectoryURI": managedURI,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "checkpointPayloadJSON": record.session.checkpoint.payloadJSON, "operations": operations], binding: binding, cancellation: cancellation)
        guard Set(response.keys) == Set(["version", "kind", "historyVersion", "taskID", "candidates"]),
              Self.integer(response["version"]) == 4, Self.integer(response["historyVersion"]) == 5,
              response["kind"] as? String == "owned-availability-discard-candidates",
              (response["taskID"] as? String).map({ Self.equal($0, record.session.taskID) }) == true,
              let candidates = response["candidates"] as? [[String: Any]], candidates.count <= record.operations.count else { throw Self.failure }
        var used = Set<String>()
        return try candidates.map { candidate in
            guard Set(candidate.keys) == Set(["requestId", "attachmentId", "targetURI", "reason"]),
                  let request = candidate["requestId"] as? String, let id = candidate["attachmentId"] as? String,
                  let target = candidate["targetURI"] as? String, candidate["reason"] as? String == "uncommitted-draft", used.insert(request).inserted else { throw Self.failure }
            let matches = record.operations.filter { Self.equal($0.requestId, request) && Self.equal($0.attachmentId, id)
                && $0.targetURI.map { Self.equal($0, target) } == true }
            guard matches.count == 1 else { throw Self.failure }
            if case .none = matches[0].resource { throw Self.failure }
            return matches[0]
        }
    }
    func retireAvailabilityTarget(_ op: Store.AvailabilityOperation, cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        switch op.resource {
        case .none: throw Self.failure
        case .borrowed: return "notOwned"
        case .owned: return try retireOwnedDiscardTarget(Self.availabilityOwnedOperation(op), cancellation: cancellation)
        }
    }
    func retireAvailabilityStage(_ op: Store.AvailabilityOperation, cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        guard case .owned(_, let reserved?, _, _) = op.resource, let target = op.targetURI else { throw Self.failure }
        let raw = try file(.retirePrivateStage(stage: stage(reserved), targetURI: target,
            operationID: op.requestId.replacingOccurrences(of: "-", with: "")), cancellation: cancellation)
        guard Set(raw.keys) == Set(["status"]), let status = raw["status"] as? String, ["removed", "missing"].contains(status) else { throw Self.failure }
        try requireOwner(); try cancellation.check(); return status
    }
    func promotedAvailabilityDiscard(_ record: Store.AvailabilityRecord, proof: Store.Published) throws -> Store.AvailabilityRecord {
        guard let op = record.operations.last, op.phase == .stageFilled,
              case .owned(let source, let reserved?, let filled?, nil) = op.resource else { throw Self.failure }
        return replacingAvailability(record, advancingAvailability(op, phase: .published,
            resource: .owned(source: source, stage: reserved, filled: filled, published: proof), reason: op.reason))
    }

    struct OwnedSavePreparation {
        let record: NativeAttachmentDraftStore.Record
        let fingerprint: String
        let snapshot: EditorDraftSnapshot
        let envelopeJSON: String
        let resultJSON: String
    }

    struct MixedSaveObservation {
        let json: String
        let targetURI: String
        let kind: String
        let proof: NativeAttachmentFiles.BaselineAttachmentProof?
        static func read(_ value: [String: Any]) throws -> MixedSaveObservation {
            guard let kind = value["kind"] as? String, let uri = value["targetURI"] as? String,
                  !uri.isEmpty, uri.utf8.count <= 16 * 1024 else { throw failure }
            func token(_ value: Any?) -> String? {
                guard let text = value as? String else { return nil }
                let pieces = text.split(separator: ":", omittingEmptySubsequences: false)
                guard pieces.count == 2, pieces.allSatisfy({ part in
                    !part.isEmpty && part.utf8.count <= 20 && part.utf8.allSatisfy { (48...57).contains($0) }
                        && UInt64(part) != nil
                }) else { return nil }
                return text
            }
            var proof: NativeAttachmentFiles.BaselineAttachmentProof?
            switch kind {
            case "present":
                guard Set(value.keys) == Set(["kind", "targetURI", "sha256", "size", "identity", "directoryIdentity"]),
                      let digest = value["sha256"] as? String, digest.utf8.count == 64,
                      digest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                      let size = integer(value["size"]), let identity = token(value["identity"]),
                      let directory = token(value["directoryIdentity"]) else { throw failure }
                proof = .init(targetURI: uri, sha256: digest, size: size, identity: identity, directoryIdentity: directory)
            case "noOwnedGeneration":
                guard Set(value.keys) == Set(["kind", "targetURI", "absence"]),
                      let absence = value["absence"] as? [String: Any], let type = absence["kind"] as? String else { throw failure }
                let field: String
                switch type {
                case "leafAbsent": field = "directoryIdentity"
                case "managedDirectoryAbsent": field = "documentsIdentity"
                default: throw failure
                }
                guard Set(absence.keys) == Set(["kind", field]), token(absence[field]) != nil else { throw failure }
            case "unmanaged", "unsafeEntry":
                guard Set(value.keys) == Set(["kind", "targetURI"]) else { throw failure }
            default: throw failure
            }
            return .init(json: try NativeAttachmentDraftCoordinator.json(value), targetURI: uri, kind: kind, proof: proof)
        }
    }
    enum MixedSaveAuthority {
        case ownedAdd(String)
        case ownedAvailability(String), borrowedAvailability(String)
        case baseline(MixedSaveObservation)
        func object() throws -> [String: Any] {
            switch self {
            case .ownedAdd(let id): return ["kind": "ownedAdd", "requestId": id]
            case .ownedAvailability(let id): return ["kind": "ownedAvailability", "requestId": id]
            case .borrowedAvailability(let id): return ["kind": "borrowedAvailability", "requestId": id]
            case .baseline(let observation): return ["kind": "baseline", "observation": try NativeAttachmentDraftCoordinator.object(observation.json)]
            }
        }
        static func read(_ value: [String: Any]) throws -> MixedSaveAuthority {
            switch value["kind"] as? String {
            case "ownedAdd":
                guard Set(value.keys) == Set(["kind", "requestId"]), let id = uuid(value["requestId"]), id.utf8.count == 36 else { throw failure }
                return .ownedAdd(id)
            case "ownedAvailability", "borrowedAvailability":
                guard Set(value.keys) == Set(["kind", "requestId"]), let id = uuid(value["requestId"]), id.utf8.count == 36 else { throw failure }
                return value["kind"] as? String == "ownedAvailability" ? .ownedAvailability(id) : .borrowedAvailability(id)
            case "baseline":
                guard Set(value.keys) == Set(["kind", "observation"]), let raw = value["observation"] as? [String: Any] else { throw failure }
                return .baseline(try MixedSaveObservation.read(raw))
            default: throw failure
            }
        }
    }
    struct MixedSaveCandidate {
        let index: Int
        let attachmentID: String
        let targetURI: String
        let reason: String
        let authority: MixedSaveAuthority
        var outcomes: Set<String> {
            let keeps: Set<String> = reason == "uncommitted-draft" ? ["referenced"] : ["referenced", "taskChanged"]
            switch authority {
            case .ownedAdd, .ownedAvailability: return keeps.union(["removed", "absent"])
            case .borrowedAvailability: return keeps.union(["notOwned"])
            case .baseline(let observation):
                return keeps.union(observation.kind == "present" ? ["removed", "absent", "generationChanged", "unsafeEntry"] : [observation.kind])
            }
        }
    }
    struct MixedSavePreparation {
        let binding: Store.VersionedSnapshot
        let snapshot: EditorDraftSnapshot
        let fingerprint: String
        let envelopeJSON: String
        let resultJSON: String
        let candidates: [MixedSaveCandidate]
        let stages: [String]
    }
    enum MixedSaveSelection {
        case legacy, complete, completeHash, completeAvailability
        var isComplete: Bool { self != .legacy }
        var envelopeVersion: Int { self == .completeAvailability ? 4 : self == .completeHash ? 3 : (isComplete ? 2 : 1) }
        var wrapperVersion: Int { self == .completeAvailability ? 5 : self == .completeHash ? 4 : (isComplete ? 3 : 2) }
        var historyVersion: Int { self == .completeAvailability ? 5 : self == .completeHash ? 4 : 3 }
        var allowsEmptyHistory: Bool { isComplete }
    }
    static func mixedSaveLineageJSON(_ record: Store.MixedRecord, managedDirectoryURI: String,
                                    selection: MixedSaveSelection = .legacy) throws -> String {
        _ = try Store.mixedFingerprint(record)
        guard record.version == selection.historyVersion, record.session.state == .active, selection.allowsEmptyHistory || !record.operations.isEmpty, record.discard == nil,
              record.checkpointAdvance == nil, record.operations.allSatisfy({ entry in
                  if case .add(let op) = entry { return op.phase == .checkpointed && op.reason == nil }
                  return entry.checkpointed
              }) else { throw failure }
        let operations: [[String: Any]] = try record.operations.map { entry in
            switch entry {
            case .add(let op): return ["kind": "add", "operation": try object(op.preparedJSON, limit: 2 * 1024 * 1024)]
            case .remove(let op): return ["kind": "remove", "operation": try object(op.preparedJSON, limit: 2 * 1024 * 1024)]
            }
        }
        return try json(["version": record.version, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "beforePayloadJSON": record.session.checkpoint.payloadJSON, "priorOperations": operations, "managedDirectoryURI": managedDirectoryURI])
    }
    static func mixedSaveAdds(_ record: Store.MixedRecord) -> [Store.Operation] {
        record.operations.compactMap { if case .add(let op) = $0 { return op }; return nil }
    }
    /// The shared validator supplies the complete ordered plan; Swift binds
    /// each tuple to existing private Add evidence or an opening baseline.
    static func mixedSaveCandidates(plan: [[String: Any]], envelopeJSON: String,
                                    authorities: [MixedSaveAuthority], record: Store.MixedRecord?) throws -> [MixedSaveCandidate] {
        let envelope = try object(envelopeJSON)
        guard let request = envelope["request"] as? [String: Any],
              let save = request["saveRequest"] as? [String: Any], let half = save["attachments"] as? [String: Any],
              let baseline = half["base"] as? [[String: Any]], let owned = request["ownedDraft"] as? [String: Any],
              let history = owned["priorOperations"] as? [[String: Any]], authorities.count == plan.count else { throw failure }
        let additions = history.filter { $0["kind"] as? String == "add" }.compactMap { $0["operation"] as? [String: Any] }
        return try plan.enumerated().map { index, value in
            guard Set(value.keys) == Set(["attachment", "reason"]), let attachment = value["attachment"] as? [String: Any],
                  attachment["kind"] as? String == "file", let id = attachment["id"] as? String,
                  let uri = attachment["uri"] as? String, !uri.isEmpty,
                  let reason = value["reason"] as? String, ["uncommitted-draft", "replaced-baseline", "deleted-after-save"].contains(reason) else { throw failure }
            let adds = additions.filter { ($0["requestId"] as? String).map { equal($0, id) } == true
                && ($0["targetURI"] as? String).map { equal($0, uri) } == true }
            let originals = baseline.filter { ($0["id"] as? String).map { equal($0, id) } == true
                && ($0["uri"] as? String).map { equal($0, uri) } == true && $0["kind"] as? String == "file" }
            switch authorities[index] {
            case .ownedAdd(let requestID):
                guard adds.count == 1, originals.isEmpty, equal(requestID, id), reason == "uncommitted-draft" else { throw failure }
                if let record {
                    let retained = mixedSaveAdds(record).filter { equal($0.requestId, requestID) && equal($0.targetURI, uri) }
                    guard retained.count == 1, retained[0].stage != nil, retained[0].published != nil else { throw failure }
                }
            case .ownedAvailability, .borrowedAvailability: throw failure
            case .baseline(let observed):
                guard originals.count == 1, adds.isEmpty, reason != "uncommitted-draft", equal(observed.targetURI, uri) else { throw failure }
            }
            return .init(index: index, attachmentID: id, targetURI: uri, reason: reason, authority: authorities[index])
        }
    }
    /// Historical opening validation only. Missing or changed published bytes
    /// remain removable from the draft; a later Save proves publication again.
    func checkResumeV3(_ snapshot: EditorDraftSnapshot, cancellation: NativeAttachmentCancellation) throws -> String {
        jobs.drain()
        let loaded = try mixedRead(cancellation), record = loaded.record
        let lineage = try Self.mixedSaveLineageJSON(record, managedDirectoryURI: managedURI, selection: record.version == 4 ? .completeHash : .complete)
        guard Self.equal(record.session.checkpoint, snapshot) else { throw Self.failure }
        try current(snapshot)
        let checkpoint = try Self.object(String(decoding: JSONEncoder().encode(snapshot), as: UTF8.self))
        let request: [String: Any] = ["version": record.version == 4 ? 2 : 1, "kind": "owned-editor-resume", "checkpoint": checkpoint,
                                     "ownedDraft": try Self.object(lineage)]
        // Account for Foundation's actual nested escaping before the first
        // shared invocation, including historical lineage validation.
        guard try Self.json(request).utf8.count <= 8 * 1024 * 1024 else { throw Self.failure }
        try requireMixed(loaded.binding, cancellation)
        try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
        try requireMixed(loaded.binding, cancellation)
        let ready = try mixedInvoke("attachmentDraftResumeCheckV3", request, binding: loaded.binding, cancellation: cancellation)
        guard Set(ready.keys) == Set(["kind", "freshDraft", "freshScheduleBase", "freshRecurrenceBase", "freshChecklistBase", "freshAttachmentsBase"]),
              ready["kind"] as? String == "ready", ready["freshDraft"] is [String: Any],
              ready["freshScheduleBase"] is [String: Any], ready["freshRecurrenceBase"] is [String: Any],
              ready["freshChecklistBase"] is [[String: Any]], ready["freshAttachmentsBase"] is [[String: Any]] else { throw Self.failure }
        let result = try Self.json(["version": 1, "checkpoint": checkpoint, "ready": ready])
        guard result.utf8.count <= 8 * 1024 * 1024 else { throw Self.failure }
        try current(snapshot); try requireMixed(loaded.binding, cancellation)
        acknowledge("owned-resume", "validated")
        // Diagnostics can enter shared code. Recheck the original editor and
        // sidecar generation rather than adopting an identical-byte inode.
        try current(snapshot); try requireMixed(loaded.binding, cancellation)
        return result
    }
    func prepareMixedSave(_ raw: String, session: String, generation: Int, selection: MixedSaveSelection = .legacy,
                          cancellation: NativeAttachmentCancellation) throws -> MixedSavePreparation {
        jobs.drain()
        let loaded = try mixedRead(cancellation), record = loaded.record
        let lineage = try Self.mixedSaveLineageJSON(record, managedDirectoryURI: managedURI, selection: selection)
        guard let current = try editor.read(), current.attempt == nil, Self.equal(current.snapshot, record.session.checkpoint),
              Self.equal(session, current.snapshot.sessionID), session.utf8.count == 36, generation == current.snapshot.generation else { throw Self.failure }
        try mixedHistory(record, binding: loaded.binding, cancellation: cancellation)
        let request: [String: Any] = ["version": selection.envelopeVersion, "kind": "owned-editor-file-edit-save",
            "checkpoint": try Self.object(String(decoding: JSONEncoder().encode(current.snapshot), as: UTF8.self)),
            "ownedDraft": try Self.object(lineage), "saveRequest": try Self.object(raw, limit: 2_000_000)]
        let response = try mixedInvoke("attachmentFileEditSavePrepare", request, binding: loaded.binding, cancellation: cancellation)
        guard Set(response.keys) == Set(["kind", "prepared"]), response["kind"] as? String == "prepared",
              let prepared = response["prepared"] as? [String: Any], let repeated = prepared["request"] as? [String: Any],
              Self.equal(try Self.json(repeated), try Self.json(request)) else { throw Self.failure }
        let envelope = try Self.json(["request": request, "prepared": prepared])
        let validation = try mixedInvoke("attachmentFileEditSaveValidate", try Self.object(envelope), binding: loaded.binding, cancellation: cancellation)
        guard Set(validation.keys) == Set(["version", "kind", "result", "settlementPlan"]), Self.integer(validation["version"]) == Int64(selection.envelopeVersion),
              validation["kind"] as? String == "owned-editor-file-edit-save", let result = validation["result"] as? [String: Any],
              let plan = validation["settlementPlan"] as? [[String: Any]], !record.operations.isEmpty || plan.isEmpty else { throw Self.failure }
        let adds = Self.mixedSaveAdds(record), baseline = ((request["saveRequest"] as? [String: Any])?["attachments"] as? [String: Any])?["base"] as? [[String: Any]] ?? []
        var authorities: [MixedSaveAuthority] = []
        for candidate in plan {
            guard let attachment = candidate["attachment"] as? [String: Any], let id = attachment["id"] as? String,
                  let uri = attachment["uri"] as? String else { throw Self.failure }
            let owned = adds.filter { Self.equal($0.requestId, id) && Self.equal($0.targetURI, uri) }
            let originals = baseline.filter { ($0["id"] as? String).map { Self.equal($0, id) } == true
                && ($0["uri"] as? String).map { Self.equal($0, uri) } == true }
            if owned.count == 1 && originals.isEmpty { authorities.append(.ownedAdd(owned[0].requestId)) }
            else if owned.isEmpty && originals.count == 1 {
                try requireMixed(loaded.binding, cancellation); try self.current(current.snapshot)
                let observation = try MixedSaveObservation.read(file(.snapshotBaseline(attachmentID: id, targetURI: uri), cancellation: cancellation))
                try requireMixed(loaded.binding, cancellation); try self.current(current.snapshot)
                authorities.append(.baseline(observation))
            } else { throw Self.failure }
        }
        let candidates = try Self.mixedSaveCandidates(plan: plan, envelopeJSON: envelope, authorities: authorities, record: record)
        try verifyMixedSavePublished(record, envelopeJSON: envelope, selection: selection, cancellation: cancellation)
        try requireMixed(loaded.binding, cancellation); try self.current(current.snapshot)
        return .init(binding: loaded.binding, snapshot: current.snapshot, fingerprint: try Store.mixedFingerprint(record),
            envelopeJSON: envelope, resultJSON: try Self.json(result), candidates: candidates, stages: adds.map(\.requestId))
    }
    func verifyMixedSavePublished(_ record: Store.MixedRecord, envelopeJSON: String, selection: MixedSaveSelection = .legacy,
                                  cancellation: NativeAttachmentCancellation) throws {
        jobs.drain(); try requireOwner(); try cancellation.check()
        _ = try Self.mixedSaveLineageJSON(record, managedDirectoryURI: managedURI, selection: selection)
        for entry in record.operations { _ = try mixedPrepared(entry, version: record.version) }
        let envelope = try Self.object(envelopeJSON)
        guard let prepared = envelope["prepared"] as? [String: Any], Self.integer(prepared["version"]) == Int64(selection.envelopeVersion),
              let decision = prepared["decision"] as? [String: Any] else { throw Self.failure }
        let afterTasks: [[String: Any]]
        if selection.isComplete {
            guard let request = envelope["request"] as? [String: Any], let save = request["saveRequest"] as? [String: Any],
                  let id = save["id"] as? String, let proof = decision["prepared"] as? [String: Any] else { throw Self.failure }
            switch decision["kind"] as? String {
            case "changed":
                guard let effect = proof["effect"] as? [String: Any], let rows = effect["tasks"] as? [[String: Any]] else { throw Self.failure }
                afterTasks = try rows.map { row in
                    guard let after = row["after"] as? [String: Any] else { throw Self.failure }
                    return after
                }
                guard afterTasks.filter({ ($0["id"] as? String).map { Self.equal($0, id) } == true }).count == 1 else { throw Self.failure }
            case "noop":
                guard let witness = proof["witness"] as? [String: Any], let source = witness["source"] as? [String: Any],
                      (source["id"] as? String).map({ Self.equal($0, id) }) == true else { throw Self.failure }
                afterTasks = [source]
            default: throw Self.failure
            }
        } else {
            guard let effect = (decision["kind"] as? String == "changed" ? (decision["prepared"] as? [String: Any])?["effect"] : decision["effect"]) as? [String: Any],
                  let task = effect["task"] as? [String: Any], let after = task["after"] as? [String: Any],
                  after["attachments"] is [[String: Any]] else { throw Self.failure }
            afterTasks = [after]
        }
        // A generated recurring child can retain a file even if the source no
        // longer does. Prove every owned Add referenced by the complete effect.
        let attachments = try afterTasks.flatMap { task -> [[String: Any]] in
            guard task["attachments"] == nil || task["attachments"] is [[String: Any]] else { throw Self.failure }
            return task["attachments"] as? [[String: Any]] ?? []
        }
        for op in Self.mixedSaveAdds(record) where attachments.contains(where: {
            // Recurrence clones attachment IDs while sharing the exact file
            // URI. Complete effects must prove those child references too.
            (selection.isComplete || ($0["id"] as? String).map { Self.equal($0, op.requestId) } == true)
                && ($0["uri"] as? String).map { Self.equal($0, op.targetURI) } == true && $0["kind"] as? String == "file"
                && ($0["deletedAt"] == nil || $0["deletedAt"] is NSNull)
        }) {
            try requireOwner(); try cancellation.check()
            guard let reserved = op.stage, let expected = op.published else { throw Self.failure }
            let raw = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(reserved), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation)
            let actual = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(raw).utf8))
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard try encoder.encode(actual) == encoder.encode(expected) else { throw Self.failure }
            try requireOwner(); try cancellation.check()
        }
    }
    /// Typed synchronous jobs only, under the caller's journal-bound closure.
    func retireMixedSaveTarget(_ candidate: MixedSaveCandidate, record: Store.MixedRecord,
                               currentURI: String? = nil,
                               cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        let outcome: String
        switch candidate.authority {
        case .ownedAdd(let id):
            guard currentURI == nil, let op = Self.mixedSaveAdds(record).first(where: { Self.equal($0.requestId, id) }) else { throw Self.failure }
            outcome = try retireOwnedDiscardTarget(op, cancellation: cancellation)
        case .ownedAvailability, .borrowedAvailability: throw Self.failure
        case .baseline(let observation):
            outcome = try retireSaveBaseline(candidate, observation: observation, currentURI: currentURI, cancellation: cancellation)
        }
        jobs.drain(); try requireOwner(); try cancellation.check()
        guard candidate.outcomes.contains(outcome) else { throw Self.failure }
        return outcome
    }
    private func retireSaveBaseline(_ candidate: MixedSaveCandidate, observation: MixedSaveObservation,
                                    currentURI: String? = nil, cancellation: NativeAttachmentCancellation) throws -> String {
        if let proof = observation.proof {
            let resolved = currentURI.map { NativeAttachmentFiles.BaselineAttachmentProof(targetURI: $0,
                sha256: proof.sha256, size: proof.size, identity: proof.identity, directoryIdentity: proof.directoryIdentity) } ?? proof
            let value = try file(.retireBaseline(attachmentID: candidate.attachmentID, proof: resolved), cancellation: cancellation)
            guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
                  ["removed", "absent", "generationChanged", "unsafeEntry"].contains(status) else { throw Self.failure }
            return status
        }
        guard currentURI == nil else { throw Self.failure }
        return observation.kind
    }
    func retireAvailabilitySaveTarget(_ candidate: MixedSaveCandidate, record: Store.AvailabilityRecord,
                                      cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        let outcome: String
        switch candidate.authority {
        case .ownedAvailability(let id), .borrowedAvailability(let id):
            let matches = record.operations.filter { Self.equal($0.requestId, id) && Self.equal($0.attachmentId, candidate.attachmentID)
                && $0.targetURI.map { Self.equal($0, candidate.targetURI) } == true }
            guard matches.count == 1 else { throw Self.failure }
            outcome = try retireAvailabilityTarget(matches[0], cancellation: cancellation)
        case .baseline(let observation): outcome = try retireSaveBaseline(candidate, observation: observation, cancellation: cancellation)
        case .ownedAdd: throw Self.failure
        }
        jobs.drain(); try requireOwner(); try cancellation.check()
        guard candidate.outcomes.contains(outcome) else { throw Self.failure }
        return outcome
    }
    func retireMixedSaveStage(_ op: Store.Operation, cancellation: NativeAttachmentCancellation) throws -> String {
        try requireOwner(); try cancellation.check()
        let outcome = try retireOwnedDiscardStage(op, cancellation: cancellation)
        try requireOwner(); try cancellation.check()
        return outcome
    }

    /// Native structural correspondence for pre-runtime journal admission.
    /// Shared full lineage/effect validation and descriptor proofs remain separate.
    static func ownedSaveLineageJSON(_ record: NativeAttachmentDraftStore.Record) throws -> String {
        _ = try NativeAttachmentDraftStore.ownedSaveFingerprint(record)
        let additions = try record.operations.map { try object($0.preparedJSON, limit: 2 * 1024 * 1024) }
        guard let root = additions.first?["managedDirectoryURI"] as? String else { throw failure }
        return try json(["version": 2, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations[0].before.payloadJSON,
            "beforePayloadJSON": record.session.checkpoint.payloadJSON,
            "priorAdditions": additions, "managedDirectoryURI": root])
    }

    func prepareOwnedSave(_ saveRequestJSON: String, session: String, generation: Int) throws -> OwnedSavePreparation {
        jobs.drain()
        guard let record = try store.read(), let value = try editor.read(), value.attempt == nil,
              Self.equal(value.snapshot.sessionID, session), value.snapshot.generation == generation,
              Self.equal(value.snapshot, record.session.checkpoint) else { throw Self.failure }
        let fingerprint = try Store.ownedSaveFingerprint(record)
        try lineage(record)
        try verifyOwnedSavePublished(record)
        let save = try Self.object(saveRequestJSON, limit: 2_000_000)
        let checkpoint = try Self.object(String(decoding: JSONEncoder().encode(value.snapshot), as: UTF8.self))
        let owned = try Self.object(Self.ownedSaveLineageJSON(record))
        let request: [String: Any] = ["version": 1, "kind": "owned-editor-file-add-save", "checkpoint": checkpoint,
                                     "ownedDraft": owned, "saveRequest": save]
        let response = try Self.object(invoke("attachmentOwnedSavePrepare", [Self.json(request)]), limit: 16 * 1024 * 1024)
        guard Set(response.keys) == Set(["kind", "prepared"]), response["kind"] as? String == "prepared",
              let prepared = response["prepared"] as? [String: Any], let repeated = prepared["request"] as? [String: Any],
              Self.equal(try Self.json(repeated), try Self.json(request)) else { throw Self.failure }
        let envelope = try Self.json(["request": request, "prepared": prepared])
        let validation = try Self.object(invoke("attachmentOwnedSaveValidate", [envelope]), limit: 16 * 1024 * 1024)
        guard Set(validation.keys) == Set(["version", "kind", "result"]), Self.integer(validation["version"]) == 1,
              validation["kind"] as? String == "owned-editor-file-add-save",
              let result = validation["result"] as? [String: Any], Set(result.keys) == Set(["id", "draft"]),
              let id = result["id"] as? String, Self.equal(id, value.snapshot.taskID), result["draft"] is [String: Any] else { throw Self.failure }
        return .init(record: record, fingerprint: fingerprint, snapshot: value.snapshot,
                     envelopeJSON: envelope, resultJSON: try Self.json(result))
    }

    /// Call before first invocation and every nonterminal replay. This uses the
    /// recorded published inode/root/content; it never recopies a cache source.
    func verifyOwnedSavePublished(_ record: NativeAttachmentDraftStore.Record) throws {
        jobs.drain()
        _ = try Store.ownedSaveFingerprint(record)
        try history(record)
        let cancellation = NativeAttachmentCancellation()
        for op in record.operations {
            guard let reserved = op.stage, let expected = op.published else { throw Self.failure }
            let raw = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(reserved),
                sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
            let actual = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(raw).utf8))
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard try encoder.encode(actual) == encoder.encode(expected) else { throw Self.failure }
        }
    }

    /// The caller already owns a validated durable success terminal and checks
    /// the exact sidecar/editor before each job. No JSC runs during retirement.
    func retireOwnedSaveStage(_ op: NativeAttachmentDraftStore.Operation) throws {
        guard let reserved = op.stage else { throw Self.failure }
        let value = try file(.retirePrivateStage(stage: stage(reserved), targetURI: op.targetURI,
            operationID: op.requestId.replacingOccurrences(of: "-", with: "")),
            cancellation: NativeAttachmentCancellation(), ignoringCancellation: true)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "missing"].contains(status) else { throw Self.failure }
    }
    func drainOwnedSaveJobs() { jobs.drain() }

    /// Version 1 remains the fully published contract. Version 2 grants only
    /// recorded private-stage retirement for one last unpublished operation.
    /// Version 3 gives up an unproven intent without touching its namespace.
    /// Version 4 binds an explicitly observed filled-stage retirement decision.
    static func ownedDiscardVersion(_ record: NativeAttachmentDraftStore.Record) throws -> Int {
        if record.operations.allSatisfy({ [.published, .resultDurable, .checkpointed].contains($0.phase)
            && $0.stage != nil && $0.published != nil }) { return 1 }
        guard let last = record.operations.last,
              last.published == nil, last.replyJSON == nil,
              record.operations.dropLast().allSatisfy({ $0.phase == .checkpointed
                  && $0.stage != nil && $0.published != nil }) else { throw Self.failure }
        if last.phase == .stagePrepared && last.stage != nil && last.filled == nil { return 2 }
        if last.phase == .intent && last.stage == nil && last.filled == nil { return 3 }
        if last.phase == .stageFilled && last.stage != nil && last.filled != nil { return 4 }
        throw Self.failure
    }

    /// Only fresh unjournaled admission observes. A persisted v4 decision must
    /// remain retryable after its owned stage has already been unlinked.
    func observeOwnedDiscardFilledStage(_ op: NativeAttachmentDraftStore.Operation,
                                       cancellation: NativeAttachmentCancellation) throws {
        guard let reserved = op.stage, let expected = op.filled else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.observeFilledStage(stage: stage(reserved), sha256: expected.sha256, size: expected.size), cancellation: cancellation)
        guard Set(value.keys) == Set(["sha256", "size", "identity"]),
              let digest = value["sha256"] as? String, Self.equal(digest, expected.sha256),
              Self.integer(value["size"]) == expected.size,
              let identity = value["identity"] as? String, Self.equal(identity, reserved.identity) else { throw Self.failure }
    }

    func reproveOwnedDiscardPublication(_ op: NativeAttachmentDraftStore.Operation,
                                       cancellation: NativeAttachmentCancellation) throws -> NativeAttachmentDraftStore.Published {
        guard let reserved = op.stage, let expected = op.filled else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(reserved),
            sha256: expected.sha256, size: expected.size), cancellation: cancellation)
        guard Set(value.keys) == Set(["sha256", "size", "identity", "directoryIdentity"]),
              let digest = value["sha256"] as? String, Self.equal(digest, expected.sha256),
              Self.integer(value["size"]) == expected.size,
              let identity = value["identity"] as? String, Self.equal(identity, reserved.identity),
              let directory = value["directoryIdentity"] as? String, Self.equal(directory, reserved.directoryIdentity) else { throw Self.failure }
        return .init(sha256: digest, size: expected.size, identity: identity, directoryIdentity: directory)
    }

    /// The Engine guards the unjournaled exact record immediately before this
    /// acknowledged write and rebinds its new hash/inode immediately afterward.
    func promoteOwnedDiscardPublication(_ record: NativeAttachmentDraftStore.Record,
                                       proof: NativeAttachmentDraftStore.Published) throws -> NativeAttachmentDraftStore.Record {
        guard let op = record.operations.last, op.phase == .stageFilled else { throw Self.failure }
        let promoted = replacing(record, advancing(op, phase: .published, published: proof, reason: op.reason))
        try store.preflight(promoted)
        try requireRecord(record)
        try store.write(promoted)
        return promoted
    }

    /// Pure domain candidacy only. The Engine separately binds the detached
    /// decision, exact journal/editor and native publication proofs for each IO.
    func prepareOwnedDiscardCandidates(_ record: NativeAttachmentDraftStore.Record) throws -> [NativeAttachmentDraftStore.Operation] {
        jobs.drain()
        _ = try Store.ownedDiscardFingerprint(record)
        _ = try Self.ownedDiscardVersion(record)
        try history(record)
        let input: [String: Any] = ["version": 1, "historyVersion": record.version,
            "taskID": record.session.taskID, "managedDirectoryURI": managedURI,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "checkpointPayloadJSON": record.session.checkpoint.payloadJSON,
            "operations": record.operations.map { ["phase": $0.phase.rawValue, "preparedJSON": $0.preparedJSON] }]
        let response = try Self.object(invoke("attachmentDraftDiscardCandidates", [Self.json(input)]), limit: 4 * 1024 * 1024)
        guard Set(response.keys) == Set(["version", "kind", "historyVersion", "taskID", "candidates"]),
              Self.integer(response["version"]) == 1, response["kind"] as? String == "owned-add-discard-candidates",
              Self.integer(response["historyVersion"]) == Int64(record.version),
              let task = response["taskID"] as? String, Self.equal(task, record.session.taskID),
              let candidates = response["candidates"] as? [[String: Any]], candidates.count == record.operations.count else { throw Self.failure }
        for (candidate, op) in zip(candidates, record.operations) {
            guard Set(candidate.keys) == Set(["requestId", "targetURI", "reason"]),
                  let id = candidate["requestId"] as? String, Self.equal(id, op.requestId),
                  let target = candidate["targetURI"] as? String, Self.equal(target, op.targetURI),
                  candidate["reason"] as? String == "uncommitted-draft" else { throw Self.failure }
        }
        return record.operations
    }

    /// Synchronous typed completion only; this method never enters JSC. Called
    /// inside the trusted live-reference handoff's native retirement callback.
    func retireOwnedDiscardTarget(_ op: NativeAttachmentDraftStore.Operation,
                                  cancellation: NativeAttachmentCancellation) throws -> String {
        guard let proof = op.published else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.retirePublished(targetURI: op.targetURI,
            proof: .init(sha256: proof.sha256, size: proof.size, identity: proof.identity,
                         directoryIdentity: proof.directoryIdentity)), cancellation: cancellation)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "absent"].contains(status) else { throw Self.failure }
        return status
    }

    func retireOwnedDiscardStage(_ op: NativeAttachmentDraftStore.Operation,
                                 cancellation: NativeAttachmentCancellation) throws -> String {
        guard let reserved = op.stage else { throw Self.failure }
        defer { jobs.drain() }
        let value = try file(.retirePrivateStage(stage: stage(reserved), targetURI: op.targetURI,
            operationID: op.requestId.replacingOccurrences(of: "-", with: "")), cancellation: cancellation)
        guard Set(value.keys) == Set(["status"]), let status = value["status"] as? String,
              ["removed", "missing"].contains(status) else { throw Self.failure }
        return status
    }

    struct MixedDiscardDecision {
        let decided: Store.MixedRecord
        let detached: Store.MixedRecord
        let replyJSON: String
    }
    func prepareMixedDiscardDecision(_ raw: String, record: Store.MixedRecord) throws -> MixedDiscardDecision {
        let request = try Self.request(raw, add: false)
        _ = try Store.mixedFingerprint(record)
        guard record.checkpointAdvance == nil, Self.equal(record.session.sessionID, request.session),
              !record.operations.contains(where: { Self.equal($0.requestId, request.id) }) else { throw Self.failure }
        if let existing = record.discard {
            guard Self.equal(existing.requestJSON, request.json), Self.equal(existing.expected, record.session.checkpoint) else { throw Self.failure }
        } else {
            guard record.session.state == .active, record.session.checkpoint.generation == request.generation else { throw Self.failure }
        }
        let checkpoint = record.session.checkpoint
        let reply = try Self.json(["version": 1, "status": "cleanupPending", "requestId": request.id,
            "sessionID": checkpoint.sessionID])
        let session = Store.Session(sessionID: record.session.sessionID, taskID: record.session.taskID,
            state: .cleanupPending, checkpoint: checkpoint)
        let decided = Store.MixedRecord(version: record.version, session: session, operations: record.operations,
            discard: .init(requestId: request.id, requestJSON: request.json, expected: checkpoint, phase: .decided))
        let detached = Store.MixedRecord(version: record.version, session: session, operations: record.operations,
            discard: .init(requestId: request.id, requestJSON: request.json, expected: checkpoint, phase: .detached, replyJSON: reply))
        if let existing = record.discard, let retainedReply = existing.replyJSON {
            guard Self.equal(retainedReply, reply) else { throw Self.failure }
        }
        return .init(decided: decided, detached: detached, replyJSON: reply)
    }

    static func mixedDiscardAdds(_ record: Store.MixedRecord) throws -> [Store.Operation] {
        _ = try Store.mixedFingerprint(record)
        let adds = mixedSaveAdds(record)
        for (index, entry) in record.operations.enumerated() {
            guard case .add(let op) = entry else { continue }
            if [.published, .resultDurable, .checkpointed].contains(op.phase) {
                guard op.stage != nil, op.published != nil else { throw failure }
            } else {
                guard index == record.operations.count - 1, op.published == nil, op.replyJSON == nil else { throw failure }
                switch op.phase {
                case .intent: guard op.stage == nil, op.filled == nil else { throw failure }
                case .stagePrepared: guard op.stage != nil, op.filled == nil else { throw failure }
                case .stageFilled: guard op.stage != nil, op.filled != nil else { throw failure }
                default: throw failure
                }
            }
        }
        return adds
    }

    /// Historical projection only. Resource proofs and the current-reference
    /// callback remain separately bound by the Engine's exact native turn.
    func prepareMixedDiscardCandidates(_ record: Store.MixedRecord, binding: Store.VersionedSnapshot,
                                       cancellation: NativeAttachmentCancellation) throws -> [Store.Operation] {
        jobs.drain(); try requireMixed(binding, cancellation)
        guard record.checkpointAdvance == nil else { throw Self.failure }
        let adds = try Self.mixedDiscardAdds(record)
        for entry in record.operations { _ = try mixedPrepared(entry, version: record.version) }
        if let discard = record.discard {
            _ = try prepareMixedDiscardDecision(discard.requestJSON, record: record)
        }
        let operations: [[String: Any]] = record.operations.map { entry in
            switch entry {
            case .add(let op): return ["kind": "add", "phase": op.phase.rawValue, "preparedJSON": op.preparedJSON]
            case .remove(let op): return ["kind": "remove", "phase": op.phase.rawValue, "preparedJSON": op.preparedJSON]
            }
        }
        let input: [String: Any] = ["version": record.version == 4 ? 3 : 2, "historyVersion": record.version, "taskID": record.session.taskID,
            "managedDirectoryURI": managedURI,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "checkpointPayloadJSON": record.session.checkpoint.payloadJSON, "operations": operations]
        let encoded = try Self.json(input)
        guard encoded.utf8.count <= 8 * 1024 * 1024 else { throw Self.failure }
        try requireMixed(binding, cancellation)
        let response = try Self.object(invoke(record.version == 4 ? "attachmentDraftDiscardCandidatesV4" : "attachmentDraftDiscardCandidatesV3", [encoded]), limit: 4 * 1024 * 1024)
        try requireMixed(binding, cancellation)
        guard Set(response.keys) == Set(["version", "kind", "historyVersion", "taskID", "candidates"]),
              Self.integer(response["version"]) == (record.version == 4 ? 3 : 2), Self.integer(response["historyVersion"]) == Int64(record.version),
              response["kind"] as? String == "owned-mixed-discard-candidates",
              let task = response["taskID"] as? String, Self.equal(task, record.session.taskID),
              let candidates = response["candidates"] as? [[String: Any]], candidates.count == adds.count else { throw Self.failure }
        for (candidate, op) in zip(candidates, adds) {
            guard Set(candidate.keys) == Set(["requestId", "targetURI", "reason"]),
                  let id = candidate["requestId"] as? String, Self.equal(id, op.requestId),
                  let uri = candidate["targetURI"] as? String, Self.equal(uri, op.targetURI),
                  candidate["reason"] as? String == "uncommitted-draft" else { throw Self.failure }
        }
        return adds
    }

    func promotedMixedDiscard(_ record: Store.MixedRecord, proof: Store.Published) throws -> Store.MixedRecord {
        guard let last = record.operations.last, case .add(let op) = last, op.phase == .stageFilled else { throw Self.failure }
        return Store.MixedRecord(version: record.version, session: record.session,
            operations: Array(record.operations.dropLast()) + [.add(advancing(op, phase: .published, published: proof, reason: op.reason))],
            discard: record.discard, checkpointAdvance: record.checkpointAdvance)
    }

    func add(_ raw: String, cancellation: NativeAttachmentCancellation) throws -> String {
        let request = try Self.request(raw, add: true)
        guard var record = try store.read(), record.session.state == .active, record.session.sessionID == request.session,
              record.checkpointAdvance == nil else { throw Self.failure }
        if let existing = record.operations.first(where: { $0.requestId == request.id }) {
            guard Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
        }
        if record.discard?.requestId == request.id { throw Self.failure }
        try lineage(record)
        if record.operations.last?.phase != .checkpointed, !record.operations.isEmpty { record = try resume(record, cancellation: cancellation) }
        if let existing = record.operations.first(where: { $0.requestId == request.id }) {
            guard existing.phase == .checkpointed, let reply = existing.replyJSON else { throw Self.failure }
            try current(record.session.checkpoint)
            acknowledge("add", "replayed")
            return reply
        }
        try cancellation.check()
        guard record.operations.count < 128, record.session.checkpoint.generation == request.generation,
              request.generation < 9_007_199_254_740_991 else { throw Self.failure }
        if record.version == 2 { guard request.generation < 9_007_199_254_740_990 else { throw Self.failure } }
        try current(record.session.checkpoint)
        let sourceValue = try file(.snapshotSource(sourceURI: request.picked!["uri"] as! String), cancellation: cancellation)
        let source = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(sourceValue).utf8))
        let input: [String: Any] = ["version": record.version, "taskID": record.session.taskID,
            "initialPayloadJSON": record.operations.first?.before.payloadJSON ?? record.session.checkpoint.payloadJSON,
            "beforePayloadJSON": record.session.checkpoint.payloadJSON,
            "priorAdditions": try record.operations.map { try Self.object($0.preparedJSON, limit: 2 * 1024 * 1024) },
            "requestId": request.id, "picked": request.picked!, "measuredSize": source.size, "managedDirectoryURI": managedURI]
        let frozenJSON = try invoke(record.version == 2 ? "attachmentDraftPrepareV2" : "attachmentDraftPrepare", [Self.json(input)])
        let frozen = try Self.object(frozenJSON, limit: 2 * 1024 * 1024)
        guard let afterPayload = frozen["afterPayloadJSON"] as? String, let target = frozen["targetURI"] as? String else { throw Self.failure }
        let before = record.session.checkpoint
        let after = EditorDraftSnapshot(sessionID: before.sessionID, taskID: before.taskID, generation: before.generation + 1, payloadJSON: afterPayload)
        let op = Store.Operation(requestId: request.id, requestJSON: request.json, phase: .intent, before: before, after: after,
                                 preparedJSON: frozenJSON, targetURI: target, source: source)
        _ = try prepared(op)
        record = Store.Record(version: record.version, session: record.session, operations: record.operations + [op],
                              discard: record.discard, checkpointAdvance: record.checkpointAdvance)
        try preflight(record)
        try cancellation.check()
        #if DEBUG
        try hooks?.boundary?(.beforeIntent)
        #endif
        try store.write(record)
        #if DEBUG
        try hooks?.boundary?(.afterIntent)
        #endif
        record = try resume(record, cancellation: cancellation)
        guard let reply = record.operations.last?.replyJSON else { throw Self.failure }
        acknowledge("add", "confirmed")
        return reply
    }
    func recover(session: String, cancellation: NativeAttachmentCancellation) throws -> String {
        guard Self.uuid(session) != nil, var record = try store.read(), record.session.sessionID == session else { throw Self.failure }
        if record.version == 2 { jobs.drain() }
        try lineage(record)
        if record.checkpointAdvance != nil {
            try cancellation.check()
            record = try finishAdvance(record)
            acknowledge("checkpoint", "confirmed")
        }
        if record.session.state == .cleanupPending { record = try detach(record); return try Self.summary(record) }
        if !record.operations.isEmpty, record.operations.last?.phase != .checkpointed {
            record = try resume(record, cancellation: cancellation)
            acknowledge("add", "confirmed")
        }
        return try Self.summary(record)
    }
    private func addReply(_ op: Store.Operation) throws -> String {
        try Self.json(["version": Self.integer(try Self.object(op.preparedJSON)["version"]) == 2 ? 2 : 1, "status": "added", "requestId": op.requestId, "sessionID": op.after.sessionID, "generation": op.after.generation])
    }
    private func replacing(_ record: Store.Record, _ op: Store.Operation) -> Store.Record {
        let checkpoint = op.phase == .checkpointed ? op.after : record.session.checkpoint
        return Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: record.session.state, checkpoint: checkpoint),
                            operations: Array(record.operations.dropLast()) + [op], discard: record.discard, checkpointAdvance: record.checkpointAdvance)
    }
    private func advancing(_ op: Store.Operation, phase: Store.Phase, stage: Store.Stage? = nil,
                           filled: Store.Filled? = nil, published: Store.Published? = nil, reply: String? = nil,
                           reason: Store.Reason? = nil) -> Store.Operation {
        Store.Operation(requestId: op.requestId, requestJSON: op.requestJSON, phase: phase, reason: reason, before: op.before, after: op.after,
                        preparedJSON: op.preparedJSON, targetURI: op.targetURI, source: op.source,
                        stage: stage ?? op.stage, filled: filled ?? op.filled, published: published ?? op.published, replyJSON: reply ?? op.replyJSON)
    }
    private func stage(_ proof: Store.Stage) -> NativeAttachmentFiles.ReservedAttachmentStageProof {
        .init(stageURI: proof.uri, stagedIdentity: proof.identity, directoryIdentity: proof.directoryIdentity, privateDirectoryIdentity: proof.privateDirectoryIdentity)
    }
    private func source(_ proof: Store.Source) -> NativeAttachmentFiles.CacheSourceProof {
        .init(sourceURI: proof.sourceURI, sha256: proof.sha256, size: proof.size, identity: proof.identity, cacheRootIdentity: proof.cacheRootIdentity, parentIdentity: proof.parentIdentity)
    }
    private func resume(_ original: Store.Record, cancellation: NativeAttachmentCancellation) throws -> Store.Record {
        var record = original
        guard var op = record.operations.last else { return record }
        _ = try prepared(op)
        do {
            if op.phase == .intent {
                guard op.reason != .interruptedReservation else { throw Self.failure }
                try preflight(record)
                try cancellation.check()
                _ = try file(.ensureManagedDirectory, cancellation: cancellation)
                let value: [String: Any]
                do { value = try file(.prepareStage(targetURI: op.targetURI, operationID: op.requestId.replacingOccurrences(of: "-", with: "")), cancellation: cancellation) }
                catch {
                    let retained = advancing(op, phase: op.phase, reason: .interruptedReservation)
                    try? store.write(replacing(record, retained))
                    throw Self.failure
                }
                #if DEBUG
                try hooks?.boundary?(.afterReservation)
                #endif
                guard Set(value.keys) == Set(["stageURI", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"]),
                      let uri = value["stageURI"] as? String, let identity = value["stagedIdentity"] as? String,
                      let directory = value["directoryIdentity"] as? String, let privateDirectory = value["privateDirectoryIdentity"] as? String else { throw Self.failure }
                let proof = Store.Stage(uri: uri, identity: identity, directoryIdentity: directory, privateDirectoryIdentity: privateDirectory)
                #if DEBUG
                try hooks?.boundary?(.beforeStageProof)
                #endif
                op = advancing(op, phase: .stagePrepared, stage: proof)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterStageProof)
                #endif
            }
            if op.phase == .stagePrepared {
                try cancellation.check()
                let value = try file(.fillStage(source: source(op.source), stage: stage(op.stage!)), cancellation: cancellation)
                let content = try JSONDecoder().decode(Store.Filled.self, from: Data(Self.json(value).utf8))
                #if DEBUG
                try hooks?.boundary?(.beforeFilled)
                #endif
                op = advancing(op, phase: .stageFilled, filled: content)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterFilled)
                #endif
            }
            if op.phase == .stageFilled {
                // Re-prove an earlier rename before trying publication again.
                var proof = try? file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                if proof == nil {
                    try cancellation.check()
                    let latest = try JSONDecoder().decode(Store.Source.self, from: Data(Self.json(file(.snapshotSource(sourceURI: op.source.sourceURI), cancellation: cancellation)).utf8))
                    guard Self.equal(latest.sourceURI, op.source.sourceURI), latest.sha256 == op.source.sha256,
                          latest.size == op.source.size, latest.identity == op.source.identity,
                          latest.cacheRootIdentity == op.source.cacheRootIdentity, latest.parentIdentity == op.source.parentIdentity else { throw Self.failure }
                    #if DEBUG
                    try hooks?.boundary?(.beforePublication)
                    #endif
                    _ = try? file(.publishStage(stage: stage(op.stage!), targetURI: op.targetURI, sha256: op.source.sha256), cancellation: cancellation)
                    #if DEBUG
                    try hooks?.boundary?(.afterPublication)
                    #endif
                    proof = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                }
                guard let proof else { throw Self.failure }
                let publication = try JSONDecoder().decode(Store.Published.self, from: Data(Self.json(proof).utf8))
                op = advancing(op, phase: .published, published: publication)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterPublicationProof)
                #endif
            }
            if op.phase == .published || op.phase == .resultDurable {
                _ = try file(.verifyPublication(targetURI: op.targetURI, stage: stage(op.stage!), sha256: op.source.sha256, size: op.source.size), cancellation: cancellation, ignoringCancellation: true)
                try cancellation.check()
                #if DEBUG
                try hooks?.boundary?(.beforeResult)
                #endif
                let frozen = try prepared(op)
                let value = try Self.object(invoke("attachmentDraftResult", [Self.json(["prepared": frozen])]))
                guard Set(value.keys) == Set(["version", "kind", "taskID", "requestId", "afterPayloadJSON", "attachment"]),
                      Self.integer(value["version"]) == 1, value["kind"] as? String == "added",
                      value["taskID"] as? String == op.before.taskID, value["requestId"] as? String == op.requestId,
                      let payload = value["afterPayloadJSON"] as? String, Self.equal(payload, op.after.payloadJSON),
                      Self.equal(try Self.json(value["attachment"]!), try Self.json(frozen["attachment"]!)) else { throw Self.failure }
                if op.phase == .published {
                    op = advancing(op, phase: .resultDurable, reply: try addReply(op))
                    record = replacing(record, op); try store.write(record)
                }
                #if DEBUG
                try hooks?.boundary?(.afterResult)
                try hooks?.boundary?(.beforeCheckpoint)
                #endif
                try editor.checkpointMatching(before: op.before, after: op.after)
                #if DEBUG
                try hooks?.boundary?(.afterCheckpoint)
                #endif
                try current(op.after)
                #if DEBUG
                try hooks?.boundary?(.beforeMarker)
                #endif
                op = advancing(op, phase: .checkpointed)
                record = replacing(record, op); try store.write(record)
                #if DEBUG
                try hooks?.boundary?(.afterMarker)
                #endif
            }
            return record
        } catch {
            // Read the actual durable phase rather than a speculative local
            // value when a boundary write or acknowledgment failed.
            if let actual = try? store.read(), let retained = actual.operations.last, retained.phase != .checkpointed {
                try? store.write(replacing(actual, advancing(retained, phase: retained.phase, reason: retained.reason ?? .io)))
            }
            throw Self.failure
        }
    }
    private func preflight(_ record: Store.Record) throws {
        guard let op = record.operations.last else { throw Self.failure }
        // All unknown descriptor tokens have a fixed maximum decimal width.
        // Escaped snapshot/preparation strings are included by the real encoder.
        let token = "18446744073709551615:18446744073709551615"
        let proof = Store.Stage(uri: managedURI + ".mindwtr-install-" + op.requestId.replacingOccurrences(of: "-", with: "") + ".candidate/stage",
                                identity: token, directoryIdentity: token, privateDirectoryIdentity: token)
        let complete = advancing(op, phase: .checkpointed, stage: proof,
            filled: .init(sha256: op.source.sha256, size: op.source.size, identity: token),
            published: .init(sha256: op.source.sha256, size: op.source.size, identity: token, directoryIdentity: token), reply: try addReply(op))
        let checkpointed = replacing(record, complete)
        let failed = replacing(record, advancing(complete, phase: .resultDurable, reason: .interruptedReservation))
        let discardID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        let request = try Self.json(["version": 1, "requestId": discardID, "sessionID": op.after.sessionID, "generation": op.after.generation])
        let reply = try Self.json(["version": 1, "status": "cleanupPending", "requestId": discardID, "sessionID": op.after.sessionID])
        let retained = Store.Record(version: record.version, session: .init(sessionID: checkpointed.session.sessionID, taskID: checkpointed.session.taskID,
            state: .cleanupPending, checkpoint: op.after), operations: checkpointed.operations,
            discard: .init(requestId: discardID, requestJSON: request, expected: op.after, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        let pendingRequest = try Self.json(["version": 1, "requestId": discardID, "sessionID": op.before.sessionID, "generation": op.before.generation])
        // Before may contain more opaque whitespace than canonical after. A
        // failed Add must still leave room to retain that exact before-half.
        let retainedPending = Store.Record(version: record.version, session: .init(sessionID: failed.session.sessionID, taskID: failed.session.taskID,
            state: .cleanupPending, checkpoint: op.before), operations: failed.operations,
            discard: .init(requestId: discardID, requestJSON: pendingRequest, expected: op.before, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        var candidates = [checkpointed, failed, retained, retainedPending]
        if record.version == 2 {
            guard op.after.generation < 9_007_199_254_740_991 else { throw Self.failure }
            // Budget only incorporation of the acknowledged Add list, using
            // captured after bytes. Arbitrary later edits require their own budget.
            let next = EditorDraftSnapshot(sessionID: op.after.sessionID, taskID: op.after.taskID,
                generation: op.after.generation + 1, payloadJSON: op.after.payloadJSON)
            candidates.append(checkpointRecord(checkpointed, checkpoint: op.after,
                advance: .init(before: op.after, after: next)))
            candidates.append(checkpointRecord(checkpointed, checkpoint: next, advance: nil))
        }
        for candidate in candidates {
            guard try JSONEncoder().encode(candidate).count <= Store.maximumBytes else { throw Self.failure }
        }
    }
    /// Read-only opening observation; no editor, sidecar or durable ownership.
    func snapshotFileOpen(attachmentID: String, targetURI: String,
                          cancellation: NativeAttachmentCancellation) throws -> NativeAttachmentFiles.BaselineAttachmentProof? {
        try requireOwner(); try cancellation.check()
        let observed = try MixedSaveObservation.read(file(.snapshotBaseline(attachmentID: attachmentID, targetURI: targetURI),
            cancellation: cancellation))
        jobs.drain(); try requireOwner(); try cancellation.check()
        guard Self.equal(observed.targetURI, targetURI) else { throw Self.failure }
        switch observed.kind {
        case "present": guard let proof = observed.proof else { throw Self.failure }; return proof
        case "noOwnedGeneration": return nil
        default: throw Self.failure
        }
    }
    /// Polls one typed ID without entering JSC or taking a raw mailbox frame.
    private func file(_ request: NativeAttachmentDraftFileRequest, cancellation: NativeAttachmentCancellation,
                      ignoringCancellation: Bool = false) throws -> [String: Any] {
        if !ignoringCancellation { try cancellation.check() }
        let id = try jobs.submitDraft(request, maximumReadBytes: maximumReadBytes)
        while true {
            let raw = jobs.takeDraft(id)
            if !raw.isEmpty {
                let answer = try Self.object(raw, limit: 64 * 1024)
                guard answer["id"] as? String == id, Set(answer.keys) == Set(["id", "value"]), let value = answer["value"] as? [String: Any] else { throw Self.failure }
                return value
            }
            if !ignoringCancellation && cancellation.isCancelled { jobs.abort(id) }
            Thread.sleep(forTimeInterval: 0.001)
        }
    }
    func discard(_ raw: String) throws -> String {
        let request = try Self.request(raw, add: false)
        guard var record = try store.read(), record.session.sessionID == request.session,
              record.checkpointAdvance == nil else { throw Self.failure }
        if record.operations.contains(where: { $0.requestId == request.id }) { throw Self.failure }
        try lineage(record)
        if let existing = record.discard {
            guard Self.equal(existing.requestJSON, request.json) else { throw Self.failure }
            record = try detach(record)
            guard let reply = record.discard?.replyJSON else { throw Self.failure }
            acknowledge("discard", "retained")
            return reply
        }
        guard record.session.state == .active, record.session.checkpoint.generation == request.generation else { throw Self.failure }
        // A retained interrupted Add is discardable without resuming IO.
        // Only its exact recorded checkpoint may detach; a physically advanced
        // after-checkpoint still requires exact Add reconciliation first.
        jobs.drain()
        try lineage(record); try current(record.session.checkpoint)
        #if DEBUG
        try hooks?.boundary?(.beforeDiscardDecision)
        #endif
        record = Store.Record(version: record.version, session: .init(sessionID: record.session.sessionID, taskID: record.session.taskID, state: .cleanupPending, checkpoint: record.session.checkpoint), operations: record.operations,
                              discard: .init(requestId: request.id, requestJSON: request.json, expected: record.session.checkpoint, phase: .decided), checkpointAdvance: record.checkpointAdvance)
        try store.write(record)
        #if DEBUG
        try hooks?.boundary?(.afterDiscardDecision)
        #endif
        record = try detach(record)
        guard let reply = record.discard?.replyJSON else { throw Self.failure }
        acknowledge("discard", "retained")
        return reply
    }
    private func discardReply(_ record: Store.Record, _ discard: Store.Discard) throws -> String {
        try Self.json(["version": 1, "status": "cleanupPending", "requestId": discard.requestId, "sessionID": record.session.sessionID])
    }
    private func detach(_ record: Store.Record) throws -> Store.Record {
        guard let discard = record.discard else { throw Self.failure }
        if discard.phase == .detached {
            guard try editor.read() == nil else { throw Self.failure }
            return record
        }
        #if DEBUG
        try hooks?.boundary?(.beforeDetach)
        #endif
        try editor.discardMatching(expected: discard.expected)
        #if DEBUG
        try hooks?.boundary?(.afterDetach)
        #endif
        guard try editor.read() == nil else { throw Self.failure }
        let reply = try discardReply(record, discard)
        let detached = Store.Record(version: record.version, session: record.session, operations: record.operations,
            discard: .init(requestId: discard.requestId, requestJSON: discard.requestJSON, expected: discard.expected, phase: .detached, replyJSON: reply), checkpointAdvance: record.checkpointAdvance)
        try store.write(detached)
        return detached
    }
}
