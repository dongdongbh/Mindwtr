import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class NativeAttachmentAvailabilityStoreTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private typealias Failure = NativeAttachmentDraftStoreError
    private var root: URL!
    private var database: URL!
    private var store: Store!
    private let sessionID = "35700000-1111-4111-8111-111111111111"
    private let discardID = "35799999-1111-4111-8111-111111111111"
    private let sha = String(repeating: "a", count: 64)
    private let at = "2026-10-07T01:00:00.000Z"
    private let attachmentID = "saved:世界"

    override func setUpWithError() throws {
        #if os(iOS)
        let base = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
            .appendingPathComponent("NativeAttachmentAvailabilityTests", isDirectory: true)
        #else
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let base = checkout.appendingPathComponent(".build/task357-fixtures", isDirectory: true)
        #endif
        let fixture = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw Failure.corrupt }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        database = root.appendingPathComponent("library.sqlite"); store = Store(databaseURL: database)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func cold() -> Store { Store(databaseURL: database) }
    private func id(_ n: Int) -> String { String(format: "35700000-1111-4111-8111-%012d", n) }
    private func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    private func opening(_ note: String = "Dirty @note 🧪", selectedID: String? = nil) throws -> String {
        let file: [String: Any] = ["id": selectedID ?? attachmentID, "kind": "file", "title": "Saved file", "uri": "",
            "cloudKey": "attachments/saved.bin", "fileHash": sha, "contentRev": 7, "size": 12,
            "createdAt": at, "updatedAt": at, "localStatus": "missing"]
        return try json(["version": 2, "taskID": "task", "attachmentsOwned": true, "attachmentsBase": [file], "attachments": [file], "raw": ["note": note]])
    }
    private func snapshot(_ generation: Int, payload: String? = nil) throws -> EditorDraftSnapshot {
        EditorDraftSnapshot(sessionID: sessionID, taskID: "task", generation: generation, payloadJSON: try payload ?? opening())
    }
    // These are structural receipt fixtures, not installer-minted file ownership.
    private func operation(_ before: EditorDraftSnapshot, n: Int = 1, kind: String = "owned", phase: Store.Phase = .intent,
                           upperHash: Bool = false, selectedID: String? = nil, reason: Store.Reason? = nil) throws -> Store.AvailabilityOperation {
        let selectedID = selectedID ?? attachmentID, target = "file:///owned/documents/attachments/download-\(n).bin"
        let token = "1:\(20 + n)"
        let identity = "[\"\(selectedID)\",\"attachments/saved.bin\",\"\(sha)\",7]"
        let request = try json(["version": 1, "requestId": id(n), "sessionID": sessionID,
            "generation": before.generation, "attachmentId": selectedID, "identity": identity])
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(before.payloadJSON.utf8)) as? [String: Any])
        var rows = try XCTUnwrap(payload["attachments"] as? [[String: Any]])
        var resolved = rows[0]
        if kind == "none" {
            resolved.removeValue(forKey: "cloudKey"); resolved.removeValue(forKey: "fileHash")
            resolved["localStatus"] = "missing"; resolved["deletedAt"] = at; resolved["updatedAt"] = at
        } else { resolved["uri"] = target; resolved["localStatus"] = "available"; resolved["fileHash"] = upperHash ? sha.uppercased() : sha }
        resolved["id"] = selectedID; rows[0] = resolved; payload["attachments"] = rows
        let after = try snapshot(before.generation + 1, payload: json(payload))
        let frozen = try json(["version": 1, "kind": "prepared-file-availability", "taskID": "task", "requestId": id(n),
            "attachmentId": selectedID, "identity": identity, "beforePayloadJSON": before.payloadJSON, "afterPayloadJSON": after.payloadJSON,
            "status": kind == "none" ? "unrecoverable" : "available", "resolvedAttachmentJSON": json(resolved)])
        let source = Store.Source(sourceURI: "file:///owned/cache/source.bin", sha256: sha, size: 12,
            identity: "1:11", cacheRootIdentity: "1:12", parentIdentity: "1:13")
        let stage = phase.rank >= 1 ? Store.Stage(uri: "file:///owned/documents/attachments/private-\(n)/stage", identity: token,
            directoryIdentity: "1:30", privateDirectoryIdentity: "1:\(40 + n)") : nil
        let filled = phase.rank >= 2 ? Store.Filled(sha256: sha, size: 12, identity: token) : nil
        let published = phase.rank >= 3 ? Store.Published(sha256: sha, size: 12, identity: token, directoryIdentity: "1:30") : nil
        let resource: Store.AvailabilityResource = kind == "none" ? .none : kind == "borrowed"
            ? .borrowed(proof: Store.Published(sha256: sha, size: 12, identity: token, directoryIdentity: "1:30"))
            : .owned(source: source, stage: stage, filled: filled, published: published)
        return Store.AvailabilityOperation(requestId: id(n), requestJSON: request, attachmentId: selectedID, identity: identity,
            phase: phase, reason: reason, before: before, after: after, preparedJSON: frozen,
            targetURI: kind == "none" ? nil : target, resource: resource, replyJSON: phase.rank >= 4 ? "{}" : nil)
    }
    private func record(_ operations: [Store.AvailabilityOperation] = [], checkpoint: EditorDraftSnapshot? = nil,
                        advance: Store.CheckpointAdvance? = nil, discard: Store.DiscardPhase? = nil) throws -> Store.AvailabilityRecord {
        let checkpoint = try checkpoint ?? operations.last.map { $0.phase == .checkpointed ? $0.after : $0.before } ?? snapshot(1)
        return Store.AvailabilityRecord(session: Store.Session(sessionID: sessionID, taskID: "task",
            state: discard == nil ? .active : .cleanupPending, checkpoint: checkpoint), operations: operations,
            discard: discard.map { Store.Discard(requestId: discardID, requestJSON: "{}", expected: checkpoint,
                phase: $0, replyJSON: $0 == .detached ? "{}" : nil) }, checkpointAdvance: advance)
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]; return try e.encode(value) }
    private func object(_ value: Store.AvailabilityRecord) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: encoded(value)) as? [String: Any])
    }
    private func edit(_ value: Any, path: ArraySlice<String>, body: (inout [String: Any]) throws -> Void) throws -> Any {
        guard let first = path.first else { var fields = try XCTUnwrap(value as? [String: Any]); try body(&fields); return fields }
        if var values = value as? [Any], let index = Int(first) { values[index] = try edit(values[index], path: path.dropFirst(), body: body); return values }
        var fields = try XCTUnwrap(value as? [String: Any]); fields[first] = try edit(XCTUnwrap(fields[first]), path: path.dropFirst(), body: body); return fields
    }
    private func mutated(_ value: Store.AvailabilityRecord, path: [String] = [], body: (inout [String: Any]) throws -> Void) throws -> [String: Any] {
        try XCTUnwrap(edit(object(value), path: path[...], body: body) as? [String: Any])
    }
    private func model(_ fields: [String: Any]) throws -> Store.AvailabilityRecord {
        try JSONDecoder().decode(Store.AvailabilityRecord.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    private func inode(_ url: URL) throws -> String { var value = stat(); guard Darwin.lstat(url.path, &value) == 0 else { throw Failure.io }; return "\(value.st_dev):\(value.st_ino)" }
    private func refused(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { XCTAssertEqual($0 as? Failure, .corrupt, file: file, line: line) }
    }
    private func write(_ value: Store.AvailabilityRecord) throws { _ = try cold().writeAvailabilityAcknowledged(value) }
    private func refusedWrite(_ value: Store.AvailabilityRecord, file: StaticString = #filePath, line: UInt = #line) throws {
        let bytes = try Data(contentsOf: store.url), identity = try inode(store.url)
        refused({ try self.cold().preflightAvailability(value) }, file: file, line: line)
        refused({ _ = try self.cold().writeAvailabilityAcknowledged(value) }, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes, file: file, line: line); XCTAssertEqual(try inode(store.url), identity, file: file, line: line)
    }
    private func malformedRead(_ fields: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        let bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]); try bytes.write(to: store.url)
        let identity = try inode(store.url)
        refused({ _ = try self.cold().readAvailability() }, file: file, line: line)
        refused({ _ = try self.cold().writeAvailabilityAcknowledged(self.record()) }, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes, file: file, line: line); XCTAssertEqual(try inode(store.url), identity, file: file, line: line)
    }
    private func inner(_ value: Store.AvailabilityRecord, field: String, body: (inout [String: Any]) throws -> Void) throws -> [String: Any] {
        try mutated(value, path: ["operations", "0"]) { fields in
            var decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(fields[field] as? String).utf8)) as? [String: Any])
            try body(&decoded); fields[field] = try self.json(decoded)
        }
    }

    func testNoneBorrowedAndOwnedPhaseRoundTripsWithDistinctAttachmentID() throws {
        for kind in ["none", "borrowed", "owned"] {
            let local = Store(databaseURL: root.appendingPathComponent("\(kind).sqlite"))
            let phases: [Store.Phase] = kind == "owned" ? [.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed] : [.intent, .resultDurable, .checkpointed]
            for phase in phases {
                let value = try record([operation(snapshot(1), kind: kind, phase: phase)])
                let binding = try local.writeAvailabilityAcknowledged(value)
                XCTAssertEqual(try local.readAvailability(), value); XCTAssertTrue(try binding.matches(XCTUnwrap(local.readAvailabilitySnapshot())))
                XCTAssertNotEqual(value.operations[0].requestId, value.operations[0].attachmentId)
            }
        }
    }
    func testOrdinaryReadersNeverAdmitHistory5() throws {
        try write(record([operation(snapshot(1))]))
        let bytes = try Data(contentsOf: store.url), identity = try inode(store.url)
        refused { _ = try self.cold().readVersioned() }; refused { _ = try self.cold().read() }; refused { _ = try self.cold().readMixed() }
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
    }
    func testExactCodableKeysNullsClosedResourceAndBooleanVersions() throws {
        let value = try record([operation(snapshot(1), phase: .checkpointed)], discard: .detached)
        for path in [[], ["session"], ["session", "checkpoint"], ["operations", "0"], ["operations", "0", "before"],
                     ["operations", "0", "after"], ["operations", "0", "resource"], ["operations", "0", "resource", "source"],
                     ["operations", "0", "resource", "stage"], ["operations", "0", "resource", "filled"], ["operations", "0", "resource", "published"], ["discard"], ["discard", "expected"]] {
            try malformedRead(mutated(value, path: path) { $0["unknown"] = true })
            try malformedRead(mutated(value, path: path) { $0.removeValue(forKey: try XCTUnwrap($0.keys.sorted().first)) })
        }
        for bad: Any in [1, 2, 3, 4, 6, true] { try malformedRead(mutated(value) { $0["version"] = bad }) }
        try malformedRead(mutated(value, path: ["operations", "0", "resource"]) { $0["kind"] = "reused" })
        let none = try record([operation(snapshot(1), kind: "none")])
        for key in ["source", "stage", "filled", "published", "proof"] { try malformedRead(mutated(none, path: ["operations", "0", "resource"]) { $0[key] = NSNull() }) }
        let borrowed = try record([operation(snapshot(1), kind: "borrowed")])
        for key in ["source", "stage", "filled", "published"] { try malformedRead(mutated(borrowed, path: ["operations", "0", "resource"]) { $0[key] = NSNull() }) }
    }
    func testInnerRequestAndFrozenExactShapesBindAllSelectedFields() throws {
        let value = try record([operation(snapshot(1))])
        for field in ["requestJSON", "preparedJSON"] {
            for action in 0...2 { try malformedRead(inner(value, field: field) { fields in
                if action == 0 { fields["unknown"] = true }; if action == 1 { fields.removeValue(forKey: try XCTUnwrap(fields.keys.sorted().first)) }; if action == 2 { fields["version"] = true }
            }) }
        }
        let changes: [(String, String, Any)] = [("requestJSON", "requestId", id(2)), ("requestJSON", "sessionID", id(2)),
            ("requestJSON", "generation", 2), ("requestJSON", "generation", true), ("requestJSON", "attachmentId", "other"), ("requestJSON", "identity", "other"),
            ("preparedJSON", "status", "unknown"), ("preparedJSON", "kind", "prepared-file-add"), ("preparedJSON", "taskID", "other"),
            ("preparedJSON", "requestId", id(2)), ("preparedJSON", "attachmentId", "other"), ("preparedJSON", "identity", "other"),
            ("preparedJSON", "beforePayloadJSON", "{}"), ("preparedJSON", "afterPayloadJSON", "{}")]
        for (field, key, bad) in changes { try malformedRead(inner(value, field: field) { $0[key] = bad }) }
    }
    func testResolvedIdentityTargetAndMetadataDigestBinding() throws {
        let value = try record([operation(snapshot(1))])
        for (key, bad): (String, Any) in [("id", "other"), ("kind", "link"), ("uri", "file:///owned/other.bin"),
            ("fileHash", String(repeating: "b", count: 64)), ("fileHash", String(repeating: "x", count: 64)), ("fileHash", true)] {
            try malformedRead(inner(value, field: "preparedJSON") { frozen in
                var resolved = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(frozen["resolvedAttachmentJSON"] as? String).utf8)) as? [String: Any])
                resolved[key] = bad; frozen["resolvedAttachmentJSON"] = try self.json(resolved)
            })
        }
        let uppercase = try record([operation(snapshot(1), upperHash: true)])
        _ = try Store.availabilityFingerprint(uppercase)
        XCTAssertTrue(uppercase.operations[0].preparedJSON.contains(sha.uppercased()))
        try malformedRead(inner(value, field: "preparedJSON") { $0["resolvedAttachmentJSON"] = "[]" })
        try malformedRead(mutated(value, path: ["operations", "0"]) { $0["targetURI"] = NSNull() })
        let none = try record([operation(snapshot(1), kind: "none")])
        try malformedRead(mutated(none, path: ["operations", "0"]) { $0["targetURI"] = "file:///owned/target.bin" })
        try malformedRead(inner(none, field: "preparedJSON") { $0["status"] = "available" })
        try malformedRead(inner(value, field: "preparedJSON") { $0["status"] = "unrecoverable" })
    }
    func testOwnedReceiptContinuityAndPositiveDescriptors() throws {
        let value = try record([operation(snapshot(1), phase: .published)])
        let changes: [([String], String, Any)] = [(["source"], "sha256", String(repeating: "b", count: 64)),
            (["filled"], "sha256", String(repeating: "b", count: 64)), (["filled"], "size", 13), (["filled"], "identity", "1:99"),
            (["published"], "identity", "1:99"), (["published"], "directoryIdentity", "1:99"), (["stage"], "privateDirectoryIdentity", "01:2"),
            (["source"], "size", -1), (["source"], "size", true)]
        for (path, key, bad) in changes { try malformedRead(mutated(value, path: ["operations", "0", "resource"] + path) { $0[key] = bad }) }
        for uri in ["https://example.test/file", "file://host/file", "file:///owned/../file", "file:///owned/file?query=1"] {
            try malformedRead(mutated(value, path: ["operations", "0", "resource", "source"]) { $0["sourceURI"] = uri })
        }
        for key in ["stage", "filled", "published"] { try malformedRead(mutated(value, path: ["operations", "0", "resource"]) { $0[key] = NSNull() }) }
    }
    func testBorrowedDescriptorCanNeverHaveOwnedPhasesOrBecomeOwned() throws {
        let borrowed = try record([operation(snapshot(1), kind: "borrowed")]); try write(borrowed)
        try refusedWrite(record([operation(snapshot(1), kind: "owned")]))
        try refusedWrite(model(mutated(borrowed, path: ["operations", "0", "resource", "proof"]) { $0["identity"] = "1:99" }))
        for phase in ["stagePrepared", "stageFilled", "published"] { try malformedRead(mutated(borrowed, path: ["operations", "0"]) { $0["phase"] = phase }) }
        let proofValue = try record([operation(snapshot(1), kind: "borrowed", phase: .resultDurable)])
        for (key, bad): (String, Any) in [("sha256", String(repeating: "b", count: 64)), ("identity", "1:01"), ("directoryIdentity", "1:01"), ("size", -1)] {
            try malformedRead(mutated(proofValue, path: ["operations", "0", "resource", "proof"]) { $0[key] = bad })
        }
    }
    func testImmutableRetainedStringsReceiptsReplyAndPhaseDowngrade() throws {
        let value = try record([operation(snapshot(1), phase: .stageFilled)]); try write(value)
        try refusedWrite(record([operation(snapshot(1), phase: .stagePrepared)]))
        try refusedWrite(record([operation(snapshot(1), kind: "borrowed", phase: .resultDurable)]))
        try refusedWrite(model(mutated(value, path: ["operations", "0", "resource", "source"]) { $0["sourceURI"] = "file:///owned/cache/replacement.bin" }))
        for field in ["requestJSON", "preparedJSON"] {
            try refusedWrite(model(mutated(value, path: ["operations", "0"]) { $0[field] = " " + (try XCTUnwrap($0[field] as? String)) }))
        }
        try refusedWrite(model(mutated(value, path: ["operations", "0", "resource", "stage"]) { $0["privateDirectoryIdentity"] = "1:99" }))
        let complete = try record([operation(snapshot(1), phase: .checkpointed)]); try write(complete)
        try refusedWrite(model(mutated(complete, path: ["operations", "0"]) { $0["replyJSON"] = " { } " }))
        try refusedWrite(record())
        let none = try record([operation(snapshot(1), kind: "none")]); try refusedWrite(none)
    }
    func testReasonCanClearOnRetryButAcknowledgedMetadataCannotNormalize() throws {
        let interrupted = try record([operation(snapshot(1), reason: .io)]); try write(interrupted)
        try write(record([operation(snapshot(1))]))
        try refusedWrite(record([operation(snapshot(1), upperHash: true)]))
    }
    func testReplyIsRequiredExactlyFromResultDurableAndRemainsOpaqueBoundedJSON() throws {
        let intent = try record([operation(snapshot(1))])
        try malformedRead(mutated(intent, path: ["operations", "0"]) { $0["replyJSON"] = "{}" })
        let result = try record([operation(snapshot(1), phase: .resultDurable)])
        try malformedRead(mutated(result, path: ["operations", "0"]) { $0["replyJSON"] = NSNull() })
        try malformedRead(mutated(result, path: ["operations", "0"]) { $0["replyJSON"] = "[]" })
        let opaque = try model(mutated(result, path: ["operations", "0"]) { $0["replyJSON"] = "{\"opaque\":true}" })
        _ = try Store.availabilityFingerprint(opaque)
        try malformedRead(mutated(result, path: ["operations", "0"]) { $0["replyJSON"] = String(repeating: " ", count: 64 * 1024) + "{}" })
    }
    func testCountSafeGenerationUUIDAndUnicodeAttachmentBounds() throws {
        var operations: [Store.AvailabilityOperation] = []; var before = try snapshot(1)
        for n in 1...128 { let op = try operation(before, n: n, kind: "borrowed", phase: .checkpointed); operations.append(op); before = op.after }
        let value = try record(operations); try write(value)
        XCTAssertEqual(try cold().readAvailability()?.operations.count, 128)
        try refusedWrite(record(operations + [operation(before, n: 129, kind: "borrowed")]))
        let first = try record([operation(snapshot(1))])
        for bad: Any in [0, -1, 9_007_199_254_740_992, true] { try malformedRead(mutated(first, path: ["operations", "0", "before"]) { $0["generation"] = bad }) }
        for bad in [id(1) + "\n", "ABC00000-1111-4111-8111-111111111111", "not-uuid"] {
            try malformedRead(mutated(first, path: ["operations", "0"]) { $0["requestId"] = bad })
        }
        let boundary = String(repeating: "😀", count: 250), start = try snapshot(1, payload: opening(selectedID: boundary))
        _ = try Store.availabilityFingerprint(record([operation(start, selectedID: boundary)]))
        let over = boundary + "a", overStart = try snapshot(1, payload: opening(selectedID: over))
        refused { _ = try Store.availabilityFingerprint(self.record([self.operation(overStart, selectedID: over)])) }
    }
    func testPendingAndAppendOrderingRequireExactCheckpointAndOneGeneration() throws {
        let first = try operation(snapshot(1)); let value = try record([first]); try write(value)
        try refusedWrite(record([first], checkpoint: first.after))
        let second = try operation(first.after, n: 2)
        refused { _ = try Store.availabilityFingerprint(self.record([first, second])) }
        let complete = try operation(snapshot(1), phase: .checkpointed); try write(record([complete]))
        let appended = try operation(complete.after, n: 2); try write(record([complete, appended]))
        try refusedWrite(record([complete, appended, operation(appended.after, n: 3)]))
        let wrongGeneration = try model(mutated(record([complete, appended]), path: ["operations", "1", "after"]) { $0["generation"] = 8 })
        try refusedWrite(wrongGeneration)
        try refusedWrite(record([complete]))
    }
    func testOrdinaryCheckpointAdvanceIsFrozenUntilExactSettlement() throws {
        let complete = try operation(snapshot(1), phase: .checkpointed), value = try record([complete]); try write(value)
        let after = try snapshot(7, payload: opening("Later ordinary buffer e\u{301}"))
        let pair = Store.CheckpointAdvance(before: complete.after, after: after), pending = try record([complete], advance: pair)
        try write(pending); try write(pending)
        try refusedWrite(record([complete], advance: Store.CheckpointAdvance(before: complete.after, after: snapshot(8))))
        try refusedWrite(value)
        try refusedWrite(record([complete], advance: pair, discard: .decided))
        try refusedWrite(model(mutated(pending, path: ["operations", "0", "resource", "stage"]) { $0["privateDirectoryIdentity"] = "1:99" }))
        let settled = try record([complete], checkpoint: after); try write(settled)
        let next = try operation(after, n: 2); try write(record([complete, next]))
    }
    func testDiscardProgressionCannotReleaseOrReplaceTheRetainedEvidence() throws {
        let op = try operation(snapshot(1), kind: "none"), value = try record([op]); try write(value)
        let decided = try record([op], discard: .decided), detached = try record([op], discard: .detached)
        try write(decided); try write(detached); try refusedWrite(decided); try refusedWrite(value)
        try refusedWrite(record([op, operation(op.after, n: 2)], discard: .detached))
        let bytes = try Data(contentsOf: store.url), fingerprint = try Store.availabilityFingerprint(detached)
        refused { try self.cold().releaseDiscardedMixedMatching(fingerprint: fingerprint) }
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
    }
    func testAcknowledgedSnapshotDistinguishesSameBytesAtAnotherInodeAndRejectsHardlinks() throws {
        let value = try record([operation(snapshot(1))]), acknowledged = try cold().writeAvailabilityAcknowledged(value)
        let original = root.appendingPathComponent("retained-original.json")
        try FileManager.default.moveItem(at: store.url, to: original); try acknowledged.bytes.write(to: store.url)
        let replaced = try XCTUnwrap(cold().readAvailabilitySnapshot())
        XCTAssertEqual(acknowledged.bytes, replaced.bytes); XCTAssertEqual(acknowledged.record, replaced.record)
        XCTAssertFalse(acknowledged.matches(replaced)); XCTAssertNotEqual(acknowledged.inode, replaced.inode)
        XCTAssertEqual(Darwin.link(store.url.path, root.appendingPathComponent("alias.json").path), 0)
        refused { _ = try self.cold().readAvailabilitySnapshot() }; refused { _ = try self.cold().writeAvailabilityAcknowledged(value) }
        XCTAssertEqual(try Data(contentsOf: store.url), acknowledged.bytes)
    }
    func testCorruptOppositeVersionAndUnsafeSidecarPreserveExactBytesAndInode() throws {
        for version in 1...4 {
            let legacy = Store.Record(version: min(version, 2), session: Store.Session(sessionID: sessionID, taskID: "task", state: .active, checkpoint: try snapshot(1)), operations: [])
            let bytes = version < 3 ? try encoded(legacy) : try encoded(Store.MixedRecord(version: version, session: legacy.session, operations: []))
            try bytes.write(to: store.url); let identity = try inode(store.url)
            refused { _ = try self.cold().readAvailability() }; refused { _ = try self.cold().writeAvailabilityAcknowledged(self.record()) }
            XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
        }
        for bytes in [Data("private corrupt evidence".utf8), Data(repeating: 0x61, count: Store.maximumBytes + 1)] {
            try bytes.write(to: store.url); let identity = try inode(store.url)
            refused { _ = try self.cold().readAvailability() }; refused { _ = try self.cold().writeAvailabilityAcknowledged(self.record()) }
            XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
        }
        try FileManager.default.removeItem(at: store.url)
        let foreign = root.appendingPathComponent("foreign.json"), bytes = Data("foreign".utf8); try bytes.write(to: foreign)
        try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: foreign)
        refused { _ = try self.cold().readAvailability() }; refused { _ = try self.cold().writeAvailabilityAcknowledged(self.record()) }
        XCTAssertEqual(try Data(contentsOf: foreign), bytes)
        try FileManager.default.removeItem(at: store.url); XCTAssertEqual(Darwin.mkfifo(store.url.path, mode_t(0o600)), 0)
        refused { _ = try self.cold().readAvailability() }; refused { _ = try self.cold().writeAvailabilityAcknowledged(self.record()) }
    }
    func testActualEscapedAggregateCapRefusesBeforeWrite() throws {
        let note = String(repeating: "\\", count: 100_000)
        var operations: [Store.AvailabilityOperation] = []; var before = try snapshot(1, payload: opening(note))
        for n in 1...3 { let op = try operation(before, n: n, kind: "borrowed", phase: .checkpointed); operations.append(op); before = op.after }
        let value = try record(operations), data = try encoded(value)
        XCTAssertLessThan(data.count, Store.maximumBytes)
        try write(value); let bytes = try Data(contentsOf: store.url), identity = try inode(store.url)
        let after = try snapshot(8, payload: opening(String(repeating: "\\", count: 240_000)))
        let oversized = try record(operations, advance: Store.CheckpointAdvance(before: value.session.checkpoint, after: after))
        XCTAssertLessThan(after.payloadJSON.utf8.count, 1_000_000)
        XCTAssertGreaterThan(try encoded(oversized).count, Store.maximumBytes)
        try refusedWrite(oversized); XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
    }
    func testFingerprintBindsOpaqueUTF8AndNativeReceiptsWithoutChangingEvidence() throws {
        let value = try record([operation(snapshot(1), phase: .stagePrepared)]); try write(value)
        let fingerprint = try Store.availabilityFingerprint(value), bytes = try Data(contentsOf: store.url), identity = try inode(store.url)
        XCTAssertEqual(try Store.availabilityFingerprint(XCTUnwrap(cold().readAvailability())), fingerprint)
        let changed = try model(mutated(value, path: ["operations", "0", "resource", "stage"]) { $0["privateDirectoryIdentity"] = "1:99" })
        XCTAssertNotEqual(try Store.availabilityFingerprint(changed), fingerprint)
        let composed = try record([operation(snapshot(1, payload: opening("é")), kind: "none")])
        let decomposed = try record([operation(snapshot(1, payload: opening("e\u{301}")), kind: "none")])
        XCTAssertNotEqual(try Store.availabilityFingerprint(composed), try Store.availabilityFingerprint(decomposed))
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try inode(store.url), identity)
    }
}
