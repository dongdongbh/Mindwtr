import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class AttachmentMixedDraftStoreTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private typealias StoreError = NativeAttachmentDraftStoreError
    private var root: URL!
    private var database: URL!
    private var store: Store!
    private let sessionID = "550e8400-e29b-41d4-a716-446655440000"
    private let discardID = "550e8400-e29b-41d4-a716-999999999999"
    private let sha = String(repeating: "1", count: 64)

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task256-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw StoreError.corrupt }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        database = root.appendingPathComponent("library.sqlite")
        store = Store(databaseURL: database)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func cold() -> Store { Store(databaseURL: database) }
    private func id(_ number: Int) -> String { String(format: "550e8400-e29b-41d4-a716-%012d", number) }
    private func snapshot(_ generation: Int, payload: String? = nil) -> EditorDraftSnapshot {
        EditorDraftSnapshot(sessionID: sessionID, taskID: "task-record", generation: generation,
                            payloadJSON: payload ?? "{\"opaque\":\(generation)}")
    }
    private func add(_ before: EditorDraftSnapshot, id number: Int, phase: Store.Phase = .intent,
                     prepared: String = "{}") -> Store.Operation {
        let identity = "1:\(20 + number)"
        return Store.Operation(requestId: id(number), requestJSON: "{}", phase: phase,
            before: before, after: snapshot(before.generation + 1), preparedJSON: prepared,
            targetURI: "file:///owned/documents/attachments/target-\(number).bin",
            source: Store.Source(sourceURI: "file:///owned/cache/source.bin", sha256: sha, size: 12,
                identity: "1:11", cacheRootIdentity: "1:12", parentIdentity: "1:13"),
            stage: phase.rank >= 1 ? Store.Stage(uri: "file:///owned/documents/attachments/private-\(number)/stage",
                identity: identity, directoryIdentity: "1:30", privateDirectoryIdentity: "1:\(40 + number)") : nil,
            filled: phase.rank >= 2 ? Store.Filled(sha256: sha, size: 12, identity: identity) : nil,
            published: phase.rank >= 3 ? Store.Published(sha256: sha, size: 12, identity: identity, directoryIdentity: "1:30") : nil,
            replyJSON: phase.rank >= 4 ? "{}" : nil)
    }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    private func remove(_ before: EditorDraftSnapshot, id number: Int, phase: Store.RemovePhase = .intent,
                        attachmentID: String = "baseline:世界", timestamp: String = "2035-04-02T03:04:05.006Z",
                        afterPayload: String? = nil) throws -> Store.RemoveOperation {
        let after = snapshot(before.generation + 1, payload: afterPayload)
        let request = try json(["version": 1, "requestId": id(number), "sessionID": sessionID,
                                "generation": before.generation, "attachmentId": attachmentID])
        let frozen = try json(["version": 1, "kind": "prepared-file-remove", "taskID": before.taskID,
            "requestId": id(number), "attachmentId": attachmentID, "removedAt": timestamp,
            "beforePayloadJSON": before.payloadJSON, "afterPayloadJSON": after.payloadJSON])
        let reply = phase == .checkpointed ? try json(["version": 1, "status": "draftRemoved", "requestId": id(number),
            "sessionID": sessionID, "generation": after.generation, "attachmentId": attachmentID]) : nil
        return Store.RemoveOperation(requestId: id(number), requestJSON: request, phase: phase,
                                     before: before, after: after, preparedJSON: frozen, replyJSON: reply)
    }
    private func record(_ operations: [Store.MixedOperation] = [], checkpoint: EditorDraftSnapshot? = nil,
                        discardPhase: Store.DiscardPhase? = nil,
                        advance: Store.CheckpointAdvance? = nil) -> Store.MixedRecord {
        let checkpoint = checkpoint ?? operations.last.map { $0.checkpointed ? $0.after : $0.before } ?? snapshot(1)
        return Store.MixedRecord(session: Store.Session(sessionID: sessionID, taskID: "task-record",
            state: discardPhase == nil ? .active : .cleanupPending, checkpoint: checkpoint), operations: operations,
            discard: discardPhase.map { Store.Discard(requestId: discardID, requestJSON: "{}", expected: checkpoint,
                phase: $0, replyJSON: $0 == .detached ? "{}" : nil) }, checkpointAdvance: advance)
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    private func object(_ value: Store.MixedRecord) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: encoded(value)) as? [String: Any])
    }
    private func edit(_ value: Any, path: ArraySlice<String>, body: (inout [String: Any]) throws -> Void) throws -> Any {
        guard let first = path.first else {
            var fields = try XCTUnwrap(value as? [String: Any]); try body(&fields); return fields
        }
        if var array = value as? [Any], let index = Int(first) {
            array[index] = try edit(array[index], path: path.dropFirst(), body: body); return array
        }
        var fields = try XCTUnwrap(value as? [String: Any])
        fields[first] = try edit(XCTUnwrap(fields[first]), path: path.dropFirst(), body: body); return fields
    }
    private func mutated(_ value: Store.MixedRecord, path: [String] = [],
                         body: (inout [String: Any]) throws -> Void) throws -> [String: Any] {
        try XCTUnwrap(edit(object(value), path: path[...], body: body) as? [String: Any])
    }
    private func model(_ fields: [String: Any]) throws -> Store.MixedRecord {
        try JSONDecoder().decode(Store.MixedRecord.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    private func bytes() throws -> Data { try Data(contentsOf: store.url) }
    private func identity(_ url: URL) throws -> String {
        var info = stat()
        guard Darwin.lstat(url.path, &info) == 0 else { throw StoreError.corrupt }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func refused(_ body: () throws -> Void, expected: StoreError = .corrupt,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) {
            XCTAssertEqual($0 as? StoreError, expected, file: file, line: line)
        }
    }
    private func refusedWrite(_ value: Store.MixedRecord, file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try bytes(), inode = try identity(store.url)
        refused({ try self.cold().preflightMixed(value) }, file: file, line: line)
        refused({ try self.cold().writeMixed(value) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(store.url), inode, file: file, line: line)
    }
    private func malformedRead(_ fields: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        try evidence.write(to: store.url)
        let inode = try identity(store.url)
        refused({ _ = try self.cold().readMixed() }, file: file, line: line)
        refused({ try self.cold().preflightMixed(self.record()) }, file: file, line: line)
        refused({ try self.cold().writeMixed(self.record()) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(store.url), inode, file: file, line: line)
    }

    func testEmptyMixedRoundTripUsesSamePrivateSidecarAndExplicitNulls() throws {
        XCTAssertNil(try store.readMixed())
        let empty = record()
        try store.preflightMixed(empty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        XCTAssertEqual(Set(try object(empty).keys), ["version", "session", "operations", "discard", "checkpointAdvance"])
        XCTAssertTrue(try object(empty)["discard"] is NSNull)
        XCTAssertTrue(try object(empty)["checkpointAdvance"] is NSNull)
        try store.writeMixed(empty)
        let evidence = try bytes(), inode = try identity(store.url)
        XCTAssertEqual(try cold().readMixed(), empty)
        try cold().preflightMixed(empty); _ = try Store.mixedFingerprint(empty)
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
        XCTAssertEqual(store.url, database.appendingPathExtension("attachment-draft.json"))
        var info = stat(); XCTAssertEqual(Darwin.lstat(store.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(0o777), mode_t(0o600))
        XCTAssertEqual(try store.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testBothLegacyVersionsAndMixedVersionRefuseCrossReadsAndWrites() throws {
        for version in [1, 2] {
            let local = Store(databaseURL: root.appendingPathComponent("legacy-\(version).sqlite"))
            let legacy = Store.Record(version: version, session: record().session, operations: [])
            try local.write(legacy)
            let evidence = try Data(contentsOf: local.url), inode = try identity(local.url)
            refused { _ = try local.readMixed() }; refused { try local.preflightMixed(self.record()) }
            refused { try local.writeMixed(self.record()) }
            XCTAssertEqual(try Data(contentsOf: local.url), evidence); XCTAssertEqual(try identity(local.url), inode)
        }
        try store.writeMixed(record())
        let evidence = try bytes(), inode = try identity(store.url)
        for version in [1, 2] {
            let legacy = Store.Record(version: version, session: record().session, operations: [])
            refused { _ = try self.cold().read() }; refused { try self.cold().preflight(legacy) }
            refused { try self.cold().write(legacy) }
        }
        refused { try self.cold().releaseSavedAddsMatching(fingerprint: self.sha) }
        refused { try self.cold().releaseDiscardedAddsMatching(fingerprint: self.sha) }
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
    }

    func testUnchangedAddProofPhasesRoundTripInTaggedGrammar() throws {
        let phases: [Store.Phase] = [.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed]
        try store.writeMixed(record())
        for phase in phases {
            let value = record([.add(add(snapshot(1), id: 1, phase: phase))])
            try cold().writeMixed(value); XCTAssertEqual(try cold().readMixed(), value)
        }
    }

    func testAddRemoveAddOrderedHistoryAndPendingBeforeToAcknowledgedAfter() throws {
        let first = add(snapshot(1), id: 1, phase: .checkpointed)
        let intent = try remove(first.after, id: 2)
        try store.writeMixed(record([.add(first), .remove(intent)]))
        XCTAssertEqual(try cold().readMixed()?.session.checkpoint, intent.before)
        let complete = try remove(first.after, id: 2, phase: .checkpointed)
        try cold().writeMixed(record([.add(first), .remove(complete)]))
        XCTAssertEqual(try cold().readMixed()?.session.checkpoint, complete.after)
        let last = add(complete.after, id: 3)
        let final = record([.add(first), .remove(complete), .add(last)])
        try cold().writeMixed(final); XCTAssertEqual(try cold().readMixed(), final)
        let entries = try XCTUnwrap(object(final)["operations"] as? [[String: Any]])
        XCTAssertEqual(entries.compactMap { $0["kind"] as? String }, ["add", "remove", "add"])
    }

    func testRemovePreservesOpaqueBytesAndAcknowledgesOnlyDraftMetadata() throws {
        let before = snapshot(1, payload: "{ \"opaque\":\"e\u{301}\", \"attachments\":[] }")
        let op = try remove(before, id: 1, timestamp: "bounded opaque timestamp", afterPayload: "{\"opaque\":\"é\"}")
        try store.writeMixed(record([.remove(op)]))
        let read = try XCTUnwrap(cold().readMixed())
        guard case .remove(let retained) = try XCTUnwrap(read.operations.first) else { return XCTFail("Expected Remove") }
        XCTAssertTrue(retained.before.payloadJSON.utf8.elementsEqual(before.payloadJSON.utf8))
        XCTAssertTrue(retained.preparedJSON.utf8.elementsEqual(op.preparedJSON.utf8))
        XCTAssertNil(retained.replyJSON)
        let complete = try remove(before, id: 1, phase: .checkpointed, timestamp: "bounded opaque timestamp",
                                  afterPayload: "{\"opaque\":\"é\"}")
        try cold().writeMixed(record([.remove(complete)]))
        let reply = try XCTUnwrap(complete.replyJSON)
        XCTAssertEqual(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])["status"] as? String, "draftRemoved")

    }

    func testAllMixedAndRemoveObjectLevelsRequireExactKeysAndNulls() throws {
        let value = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))], discardPhase: .detached)
        let paths = [[], ["session"], ["session", "checkpoint"], ["operations", "0"], ["operations", "0", "operation"],
                     ["operations", "0", "operation", "before"], ["operations", "0", "operation", "after"], ["discard"], ["discard", "expected"]]
        for path in paths {
            try malformedRead(mutated(value, path: path) { $0["unknown"] = true })
            try malformedRead(mutated(value, path: path) { $0.removeValue(forKey: try XCTUnwrap($0.keys.sorted().first)) })
        }
        for (path, key) in [([], "discard"), ([], "checkpointAdvance"), (["operations", "0", "operation"], "replyJSON")] {
            try malformedRead(mutated(value, path: path) { $0.removeValue(forKey: key) })
        }
        try malformedRead(mutated(value, path: ["operations", "0"]) { $0["kind"] = "delete" })
        try malformedRead(mutated(value, path: ["operations", "0", "operation"]) { $0["phase"] = "published" })
        try malformedRead(mutated(value) { $0["version"] = 2 })
        try malformedRead(mutated(value) { $0["version"] = true })
    }

    func testRemoveInnerRequestProjectionAndReplyShapeAndCrossFieldsAreStrict() throws {
        let value = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))])
        for field in ["requestJSON", "preparedJSON", "replyJSON"] {
            for action in 0...2 {
                try malformedRead(mutated(value, path: ["operations", "0", "operation"]) { fields in
                    var inner = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(fields[field] as? String).utf8)) as? [String: Any])
                    if action == 0 { inner["unknown"] = true }
                    if action == 1 { inner.removeValue(forKey: try XCTUnwrap(inner.keys.sorted().first)) }
                    if action == 2 { inner["version"] = true }
                    fields[field] = try self.json(inner)
                })
            }
        }
        let changes: [(String, String, Any)] = [("requestJSON", "requestId", id(2)), ("requestJSON", "sessionID", id(2)),
            ("requestJSON", "generation", 2), ("requestJSON", "attachmentId", ""),
            ("preparedJSON", "kind", "prepared-file-add"), ("preparedJSON", "taskID", "other"),
            ("preparedJSON", "requestId", id(2)), ("preparedJSON", "attachmentId", "other"),
            ("preparedJSON", "beforePayloadJSON", "{}"), ("preparedJSON", "afterPayloadJSON", "{}"),
            ("preparedJSON", "removedAt", ""), ("preparedJSON", "removedAt", String(repeating: "a", count: 101)),
            ("replyJSON", "status", "removed"), ("replyJSON", "requestId", id(2)), ("replyJSON", "sessionID", id(2)),
            ("replyJSON", "generation", 1), ("replyJSON", "attachmentId", "other")]
        for (field, key, bad) in changes {
            try malformedRead(mutated(value, path: ["operations", "0", "operation"]) { fields in
                var inner = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(fields[field] as? String).utf8)) as? [String: Any])
                inner[key] = bad; fields[field] = try self.json(inner)
            })
        }
    }

    func testRemoveCannotCarryAddProofOrWrongReplyPhase() throws {
        let intent = record([.remove(try remove(snapshot(1), id: 1))])
        for key in ["source", "stage", "filled", "published", "targetURI", "reason"] {
            try malformedRead(mutated(intent, path: ["operations", "0", "operation"]) { $0[key] = NSNull() })
        }
        let complete = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))])
        try malformedRead(mutated(complete, path: ["operations", "0", "operation"]) { $0["replyJSON"] = NSNull() })
        try malformedRead(mutated(complete, path: ["operations", "0", "operation"]) { $0["phase"] = "intent" })
    }

    func testCanonicalUUIDsSharedUnicodeAttachmentIDsAndSafeGenerations() throws {
        let value = record([.remove(try remove(snapshot(1), id: 1))])
        for bad in [id(1) + "\n", id(1).uppercased(), "not-a-uuid"] {
            try malformedRead(mutated(value, path: ["operations", "0", "operation"]) { $0["requestId"] = bad })
            try malformedRead(mutated(value, path: ["session"]) { $0["sessionID"] = bad })
        }
        for bad: Any in [0, -1, 9_007_199_254_740_992, true] {
            try malformedRead(mutated(value, path: ["operations", "0", "operation", "before"]) { $0["generation"] = bad })
        }
        let local = Store(databaseURL: root.appendingPathComponent("unicode.sqlite"))
        let boundary = String(repeating: "😀", count: 250)
        try local.writeMixed(record([.remove(try remove(snapshot(1), id: 1, attachmentID: boundary))]))
        XCTAssertNotNil(try local.readMixed())
        let tooLong = record([.remove(try remove(snapshot(1), id: 1, attachmentID: boundary + "a"))])
        refused { _ = try Store.mixedFingerprint(tooLong) }
    }

    func testUniqueRequestIDsAcrossAllTagsAndDiscard() throws {
        let first = add(snapshot(1), id: 1, phase: .checkpointed)
        let duplicate = try remove(first.after, id: 1)
        refused { _ = try Store.mixedFingerprint(self.record([.add(first), .remove(duplicate)])) }
        let valid = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))], discardPhase: .decided)
        try malformedRead(mutated(valid, path: ["discard"]) { $0["requestId"] = self.id(1) })
    }

    func testRemoveImmutableEvidenceAndReplyCannotBeReplacedOrRegressed() throws {
        let intent = record([.remove(try remove(snapshot(1), id: 1))])
        try store.writeMixed(intent)
        for field in ["requestJSON", "preparedJSON"] {
            let changed = try model(mutated(intent, path: ["operations", "0", "operation"]) { fields in
                fields[field] = " " + (try XCTUnwrap(fields[field] as? String))
            })
            try refusedWrite(changed)
        }
        let complete = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))])
        try cold().writeMixed(complete); try refusedWrite(intent)
        let changedReply = try model(mutated(complete, path: ["operations", "0", "operation"]) { fields in
            fields["replyJSON"] = " " + (try XCTUnwrap(fields["replyJSON"] as? String))
        })
        try refusedWrite(changedReply)
        let changedKind = record([.add(add(snapshot(1), id: 1, phase: .checkpointed))])
        try refusedWrite(changedKind)
        try refusedWrite(record())
    }

    func testPendingMustKeepExactBeforeAndCannotAppendOrAdvance() throws {
        let pending = try remove(snapshot(1), id: 1)
        let value = record([.remove(pending)])
        try store.writeMixed(value)
        try refusedWrite(record([.remove(pending)], checkpoint: pending.after))
        try refusedWrite(record([.remove(pending), .add(add(pending.after, id: 2))]))
        try refusedWrite(record([.remove(pending)], advance: Store.CheckpointAdvance(before: pending.before, after: snapshot(8))))
        let complete = try remove(snapshot(1), id: 1, phase: .checkpointed)
        try refusedWrite(record([.remove(complete)], checkpoint: pending.before))
        try cold().writeMixed(record([.remove(complete)]))
        let foreign = add(snapshot(8), id: 2)
        try refusedWrite(record([.remove(complete), .add(foreign)]))
    }

    func testMixedGenerationGapsNeedExactEqualGenerationSnapshots() throws {
        let first = add(snapshot(1), id: 1, phase: .checkpointed)
        let second = try remove(snapshot(7, payload: "{ \"ordinary\":true }"), id: 2, phase: .checkpointed)
        let value = record([.add(first), .remove(second)], checkpoint: snapshot(12))
        try store.writeMixed(value); XCTAssertEqual(try cold().readMixed(), value)
        let sameGeneration = record([.add(first), .remove(try remove(first.after, id: 2))])
        _ = try Store.mixedFingerprint(sameGeneration)
        let drift = record([.add(first), .remove(try remove(snapshot(first.after.generation, payload: "{}"), id: 2))])
        refused { _ = try Store.mixedFingerprint(drift) }
        let backwards = record([.add(first), .remove(try remove(snapshot(1), id: 2))])
        refused { _ = try Store.mixedFingerprint(backwards) }
        try refusedWrite(record(value.operations, checkpoint: snapshot(13)))
    }

    func testOrdinaryAdvanceRetainsMixedPrefixAndExactPairUntilSettled() throws {
        let first = add(snapshot(1), id: 1, phase: .checkpointed)
        let second = try remove(first.after, id: 2, phase: .checkpointed)
        let initial = record([.add(first), .remove(second)])
        try store.writeMixed(initial)
        let after = snapshot(9, payload: "{\"ordinary\":\"世界\"}")
        let pair = Store.CheckpointAdvance(before: initial.session.checkpoint, after: after)
        let pending = record(initial.operations, advance: pair)
        try cold().writeMixed(pending); try cold().writeMixed(pending)
        XCTAssertEqual(try cold().readMixed()?.checkpointAdvance, pair)
        try refusedWrite(record(initial.operations, advance: Store.CheckpointAdvance(before: pair.before, after: snapshot(10))))
        try refusedWrite(record(initial.operations, discardPhase: .decided, advance: pair))
        try refusedWrite(initial)
        let settled = record(initial.operations, checkpoint: after)
        try cold().writeMixed(settled); XCTAssertEqual(try cold().readMixed(), settled)
        let appended = record(initial.operations + [.remove(try remove(after, id: 3))])
        try cold().writeMixed(appended); XCTAssertEqual(try cold().readMixed(), appended)
    }

    func testDiscardCouplingRetainsMixedEvidenceWithoutMixedRelease() throws {
        let op = try remove(snapshot(1), id: 1)
        let initial = record([.remove(op)])
        try store.writeMixed(initial)
        let decided = record(initial.operations, discardPhase: .decided)
        try cold().writeMixed(decided)
        let detached = record(initial.operations, discardPhase: .detached)
        try cold().writeMixed(detached); try refusedWrite(decided); try refusedWrite(initial)
        try refusedWrite(record(initial.operations + [.add(add(op.after, id: 2))], discardPhase: .detached))
        let fingerprint = try Store.mixedFingerprint(detached), evidence = try bytes()
        refused { try self.cold().releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        XCTAssertEqual(try bytes(), evidence)
    }

    func testAddProofAndMonotonicRetentionRemainStrict() throws {
        let filled = record([.add(add(snapshot(1), id: 1, phase: .stageFilled))])
        try store.writeMixed(filled)
        try refusedWrite(record([.add(add(snapshot(1), id: 1, phase: .stagePrepared))]))
        try refusedWrite(try model(mutated(filled, path: ["operations", "0", "operation", "stage"]) { $0["identity"] = "1:99" }))
        try malformedRead(mutated(filled, path: ["operations", "0", "operation", "filled"]) { $0["sha256"] = String(repeating: "2", count: 64) })
        try malformedRead(mutated(filled, path: ["operations", "0", "operation"]) { $0["published"] = NSNull(); $0["phase"] = "published" })
    }

    func testCombinedMixedCountAndActualEscapedRecordCapacity() throws {
        let operations: [Store.MixedOperation] = try (1...128).map { number in
            number % 2 == 0 ? .remove(try remove(snapshot(number), id: number, phase: .checkpointed))
                : .add(add(snapshot(number), id: number, phase: .checkpointed))
        }
        let value = record(operations)
        try store.writeMixed(value); XCTAssertEqual(try cold().readMixed()?.operations.count, 128)
        try refusedWrite(record(operations + [.remove(try remove(snapshot(129), id: 129))]))
        let prepared = "{\"text\":\"" + String(repeating: "\\\\", count: 600_000) + "\"}"
        let largeAdds = (1...3).map { Store.MixedOperation.add(add(snapshot($0), id: $0, phase: .checkpointed, prepared: prepared)) }
        let local = Store(databaseURL: root.appendingPathComponent("capacity.sqlite"))
        let initial = record(largeAdds)
        try local.writeMixed(initial)
        let evidence = try Data(contentsOf: local.url), inode = try identity(local.url)
        let after = snapshot(10, payload: "{\"text\":\"" + String(repeating: "\\\\", count: 450_000) + "\"}")
        let advancing = record(largeAdds, advance: Store.CheckpointAdvance(before: initial.session.checkpoint, after: after))
        XCTAssertLessThan(evidence.count, Store.maximumBytes)
        XCTAssertGreaterThan(try encoded(advancing).count, Store.maximumBytes)
        refused { try local.preflightMixed(advancing) }; refused { try local.writeMixed(advancing) }
        XCTAssertEqual(try Data(contentsOf: local.url), evidence); XCTAssertEqual(try identity(local.url), inode)
    }

    func testUTF8PayloadAndInnerRequestProjectionReplyBounds() throws {
        try store.writeMixed(record())
        let tooLarge = snapshot(1, payload: "{\"text\":\"" + String(repeating: "界", count: 333_334) + "\"}")
        try refusedWrite(record([.remove(try remove(tooLarge, id: 1))]))
        let valid = record([.remove(try remove(snapshot(1), id: 1, phase: .checkpointed))])
        for (field, count) in [("requestJSON", 64 * 1024), ("preparedJSON", 2 * 1024 * 1024), ("replyJSON", 64 * 1024)] {
            let oversized = try model(mutated(valid, path: ["operations", "0", "operation"]) { fields in
                fields[field] = String(repeating: " ", count: count) + (try XCTUnwrap(fields[field] as? String))
            })
            try refusedWrite(oversized)
        }
    }

    func testFingerprintBindsOpaqueUTF8ProofPhaseAndDiscardWithoutMutation() throws {
        let value = record([.add(add(snapshot(1), id: 1, phase: .stagePrepared))])
        try store.writeMixed(value)
        let hash = try Store.mixedFingerprint(value), evidence = try bytes(), inode = try identity(store.url)
        XCTAssertEqual(try Store.mixedFingerprint(try cold().readMixed()!), hash)
        let proofChanged = try model(mutated(value, path: ["operations", "0", "operation", "stage"]) { $0["privateDirectoryIdentity"] = "1:99" })
        XCTAssertNotEqual(try Store.mixedFingerprint(proofChanged), hash)
        XCTAssertNotEqual(try Store.mixedFingerprint(record([.add(add(snapshot(1), id: 1, phase: .stageFilled))])), hash)
        XCTAssertNotEqual(try Store.mixedFingerprint(record(value.operations, discardPhase: .decided)), hash)
        let composed = record([.remove(try remove(snapshot(1), id: 1, timestamp: "é"))])
        let decomposed = record([.remove(try remove(snapshot(1), id: 1, timestamp: "e\u{301}"))])
        XCTAssertNotEqual(try Store.mixedFingerprint(composed), try Store.mixedFingerprint(decomposed))
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
    }

    func testCorruptOversizeSymlinkDirectoryAndFIFOEvidenceIsRetained() throws {
        for evidence in [Data("private corrupt evidence".utf8), Data(repeating: 0x61, count: Store.maximumBytes + 1)] {
            try evidence.write(to: store.url)
            let inode = try identity(store.url)
            refused { _ = try self.cold().readMixed() }; refused { try self.cold().writeMixed(self.record()) }
            XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
        }
        try FileManager.default.removeItem(at: store.url)
        let foreign = root.appendingPathComponent("foreign.json"), data = Data("foreign bytes".utf8)
        try data.write(to: foreign)
        try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: foreign)
        refused { _ = try self.cold().readMixed() }; refused { try self.cold().preflightMixed(self.record()) }
        XCTAssertEqual(try Data(contentsOf: foreign), data)
        try FileManager.default.removeItem(at: store.url)
        try FileManager.default.createDirectory(at: store.url, withIntermediateDirectories: false)
        refused { _ = try self.cold().readMixed() }; refused { try self.cold().writeMixed(self.record()) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.url.path))
        try FileManager.default.removeItem(at: store.url)
        XCTAssertEqual(Darwin.mkfifo(store.url.path, mode_t(0o600)), 0)
        let inode = try identity(store.url), started = Date()
        refused { _ = try self.cold().readMixed() }; refused { try self.cold().writeMixed(self.record()) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertEqual(try identity(store.url), inode)
    }
}
