import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class AttachmentDraftAdvanceStoreTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var database: URL!
    private var store: Store!
    private var editor: EditorDraftStore!
    private let sessionID = "550e8400-e29b-41d4-a716-446655440000"
    private let otherSessionID = "550e8400-e29b-41d4-a716-446655440001"
    private let discardID = "550e8400-e29b-41d4-a716-999999999999"
    private let maximumGeneration = 9_007_199_254_740_991
    private let sha = String(repeating: "1", count: 64)

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task234-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw StoreError.corrupt }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        database = root.appendingPathComponent("library.sqlite")
        store = Store(databaseURL: database)
        editor = EditorDraftStore(databaseURL: database)
    }

    private typealias StoreError = NativeAttachmentDraftStoreError
    override func tearDownWithError() throws {
        if let root { try FileManager.default.removeItem(at: root) }
    }

    func testVersionOneDefaultSchemaRoundTripAndReadDoNotUpgradeOrRewrite() throws {
        let value = Store.Record(session: session(snapshot(1)), operations: [])
        XCTAssertEqual(value.version, 1); XCTAssertNil(value.checkpointAdvance)
        XCTAssertEqual(Set(try object(value).keys), ["version", "session", "operations", "discard"])
        try store.write(value)
        let evidence = try bytes(), inode = try identity(store.url)
        XCTAssertEqual(try cold().read(), value)
        try cold().preflight(value)
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
        let legacyMaximum = Store(databaseURL: root.appendingPathComponent("legacy-maximum.sqlite"))
        let maximum = record(snapshot(Int.max), version: 1)
        try legacyMaximum.write(maximum)
        XCTAssertEqual(try legacyMaximum.read(), maximum)
    }

    func testVersionTwoRequiredNullAdvanceRoundTripsPrivatelyWithoutReadMutation() throws {
        let value = record(snapshot(1))
        try store.preflight(value)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        let fields = try object(value)
        XCTAssertEqual(Set(fields.keys), ["version", "session", "operations", "discard", "checkpointAdvance"])
        XCTAssertTrue(fields["checkpointAdvance"] is NSNull)
        try store.write(value)
        let evidence = try bytes(), inode = try identity(store.url)
        XCTAssertEqual(try cold().read(), value)
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
        var info = stat()
        XCTAssertEqual(Darwin.lstat(store.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(0o777), mode_t(0o600))
        XCTAssertEqual(try store.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testExistingEvidenceLocksVersionInBothDirections() throws {
        for version in [1, 2] {
            let local = Store(databaseURL: root.appendingPathComponent("version-\(version).sqlite"))
            let original = record(snapshot(1), version: version)
            try local.write(original)
            let evidence = try Data(contentsOf: local.url), inode = try identity(local.url)
            let replacement = record(snapshot(1), version: version == 1 ? 2 : 1)
            refused { try local.preflight(replacement) }
            refused { try local.write(replacement) }
            XCTAssertEqual(try Data(contentsOf: local.url), evidence)
            XCTAssertEqual(try identity(local.url), inode)
        }
    }

    func testVersionSpecificKeysAndAllAdvanceSnapshotLevelsAreStrict() throws {
        let advancing = pending(record(snapshot(1)), after: snapshot(8))
        for path in [[], ["checkpointAdvance"], ["checkpointAdvance", "before"], ["checkpointAdvance", "after"]] {
            try malformedRead(mutated(advancing, path: path) { $0["unexpected"] = true })
            try malformedRead(mutated(advancing, path: path) { fields in
                if let key = fields.keys.sorted().first { fields.removeValue(forKey: key) }
            })
        }
        try malformedRead(mutated(record(snapshot(1))) { $0.removeValue(forKey: "checkpointAdvance") })
        try malformedRead(mutated(record(snapshot(1), version: 1)) { $0["checkpointAdvance"] = NSNull() })
        try malformedRead(mutated(advancing) { $0["version"] = 1 })
        try malformedRead(mutated(advancing) { $0["version"] = 3 })
        try malformedRead(mutated(advancing) { $0["version"] = true })
    }

    func testAdvanceNullableFieldAndNestedTypesCannotBeSubstituted() throws {
        let base = pending(record(snapshot(1)), after: snapshot(8))
        for bad: Any in [true, 1, "not-an-object", []] {
            try malformedRead(mutated(base) { $0["checkpointAdvance"] = bad })
        }
        for key in ["before", "after"] {
            try malformedRead(mutated(base, path: ["checkpointAdvance"]) { $0[key] = NSNull() })
            try malformedRead(mutated(base, path: ["checkpointAdvance", key]) { $0["generation"] = true })
            try malformedRead(mutated(base, path: ["checkpointAdvance", key]) { $0["payloadJSON"] = [] })
        }
        XCTAssertThrowsError(try encoded(Store.Record(version: 1, session: session(snapshot(1)), operations: [],
            checkpointAdvance: Store.CheckpointAdvance(before: snapshot(1), after: snapshot(2)))))
    }

    func testVersionTwoMultipleAddsPermitOpaqueGenerationGaps() throws {
        let first = operation(snapshot(1), id: 1, phase: .checkpointed)
        let second = operation(snapshot(7, payload: "{\"ordinary\":\"edited\"}"), id: 2, phase: .checkpointed)
        let value = record(snapshot(12, payload: "{\"ordinary\":\"latest\"}"), operations: [first, second])
        try store.write(value)
        XCTAssertEqual(try cold().read(), value)
        let evidence = try bytes()
        XCTAssertTrue(try XCTUnwrap(cold().read()).operations[0].preparedJSON.utf8.elementsEqual(first.preparedJSON.utf8))
        XCTAssertEqual(try bytes(), evidence)
    }

    func testEqualGenerationAcrossAddsRequiresEntireExactSnapshot() throws {
        let first = operation(snapshot(1), id: 1, phase: .checkpointed)
        let second = operation(first.after, id: 2, phase: .checkpointed)
        let valid = record(second.after, operations: [first, second])
        try store.write(valid)
        XCTAssertEqual(try cold().read(), valid)
        try malformedRead(mutated(valid, path: ["operations", "1", "before"]) { $0["payloadJSON"] = "{ \"value\": 2 }" })
    }

    func testBackwardAddGapsAndVersionOneGapsAreRefused() throws {
        let first = operation(snapshot(4), id: 1, phase: .checkpointed)
        let earlier = operation(snapshot(2), id: 2, phase: .checkpointed)
        try malformedRead(object(record(earlier.after, operations: [first, earlier])))
        let later = operation(snapshot(8), id: 2, phase: .checkpointed)
        try malformedRead(object(record(later.after, operations: [first, later], version: 1)))
    }

    func testFinalCheckpointRulesDistinguishPendingAndCompletedAdds() throws {
        let intent = operation(snapshot(4), id: 1)
        try malformedRead(object(record(snapshot(6), operations: [intent])))
        let complete = operation(snapshot(4), id: 1, phase: .checkpointed)
        try malformedRead(object(record(snapshot(4), operations: [complete])))
        try malformedRead(object(record(snapshot(5, payload: "{\"different\":true}"), operations: [complete])))
        let valid = record(snapshot(9), operations: [complete])
        let positive = Store(databaseURL: root.appendingPathComponent("final-checkpoint-positive.sqlite"))
        try positive.write(valid)
        XCTAssertEqual(try positive.read(), valid)
    }

    func testVersionTwoAllSnapshotGenerationsAreSafePositiveIntegers() throws {
        let advancing = pending(record(snapshot(1)), after: snapshot(8))
        for generation in [0, -1, maximumGeneration + 1, Int.max] {
            for path in [["session", "checkpoint"], ["checkpointAdvance", "before"], ["checkpointAdvance", "after"]] {
                try malformedRead(mutated(advancing, path: path) { $0["generation"] = generation })
            }
        }
        let unsafeAdd = operation(snapshot(maximumGeneration), id: 1, phase: .checkpointed)
        try malformedRead(object(record(unsafeAdd.after, operations: [unsafeAdd])))
        let maximum = record(snapshot(maximumGeneration))
        let positive = Store(databaseURL: root.appendingPathComponent("safe-generation-positive.sqlite"))
        try positive.write(maximum)
        XCTAssertEqual(try positive.read(), maximum)
    }

    func testPendingAdvanceColdIdempotenceAndExactSettlementWithNoAdds() throws {
        let before = snapshot(1), after = snapshot(11, payload: "{\"raw\":\"new + 世界\"}")
        let initial = record(before), advancing = pending(initial, after: after)
        try store.write(initial)
        try cold().preflight(advancing); try cold().write(advancing)
        XCTAssertEqual(try cold().read(), advancing)
        try cold().write(advancing)
        XCTAssertEqual(try cold().read()?.session.checkpoint, before)
        try cold().write(settled(advancing))
        let read = try XCTUnwrap(cold().read())
        XCTAssertNil(read.checkpointAdvance)
        XCTAssertTrue(read.session.checkpoint.payloadJSON.utf8.elementsEqual(after.payloadJSON.utf8))
        XCTAssertEqual(read.session.checkpoint.generation, 11)
    }

    func testAdvanceAfterMultipleAddsThenNewAddUsesExactAcceptedCheckpoint() throws {
        let first = operation(snapshot(1), id: 1, phase: .checkpointed)
        let second = operation(first.after, id: 2, phase: .checkpointed)
        let initial = record(second.after, operations: [first, second])
        try store.write(initial)
        let advancing = pending(initial, after: snapshot(10, payload: "{\"raw\":\"ordinary edit\"}"))
        try cold().write(advancing); try cold().write(settled(advancing))
        let accepted = try XCTUnwrap(cold().read())
        let add = operation(accepted.session.checkpoint, id: 3)
        try cold().write(record(accepted.session.checkpoint, operations: accepted.operations + [add]))
        let complete = operation(accepted.session.checkpoint, id: 3, phase: .checkpointed)
        try cold().write(record(complete.after, operations: accepted.operations + [complete]))
        XCTAssertEqual(try cold().read()?.operations.count, 3)
        XCTAssertEqual(try cold().read()?.session.checkpoint.generation, 11)
        XCTAssertEqual(try cold().read()?.operations.first, first)
    }

    func testPendingPairCannotBeReplacedCancelledOrSettledToAnotherCheckpoint() throws {
        let initial = record(snapshot(1)), advancing = pending(initial, after: snapshot(8))
        try store.write(initial); try store.write(advancing)
        try refusedWrite(pending(initial, after: snapshot(9)))
        try refusedWrite(initial)
        try refusedWrite(record(snapshot(7)))
        try refusedWrite(record(snapshot(8, payload: "{\"different\":true}")))
        try refusedWrite(record(snapshot(10)))
        let wrongBefore = Store.CheckpointAdvance(before: snapshot(2), after: snapshot(8))
        try refusedWrite(record(snapshot(1), advance: wrongBefore))
        try refusedWrite(record(snapshot(1), advance: Store.CheckpointAdvance(before: snapshot(1), after: snapshot(1))))
        try refusedWrite(record(snapshot(1), advance: Store.CheckpointAdvance(before: snapshot(1), after: snapshot(0))))
    }

    func testPendingAdvanceFreezesAllOperationFieldsProofsAndNullableValues() throws {
        let complete = operation(snapshot(1), id: 1, phase: .checkpointed)
        let initial = record(snapshot(6), operations: [complete]), advancing = pending(initial, after: snapshot(12))
        try store.write(initial); try store.write(advancing)
        let changes: [([String], String, Any)] = [
            (["operations", "0"], "requestId", discardID),
            (["operations", "0"], "requestJSON", "{ \"other\": 1 }"),
            (["operations", "0"], "preparedJSON", "{ \"other\": 2 }"),
            (["operations", "0"], "targetURI", "file:///structural/another-target"),
            (["operations", "0"], "phase", "published"),
            (["operations", "0"], "reason", "io"),
            (["operations", "0"], "replyJSON", "{\"other\":3}"),
            (["operations", "0", "before"], "payloadJSON", "{\"other\":4}"),
            (["operations", "0", "after"], "payloadJSON", "{\"other\":5}"),
            (["operations", "0", "source"], "sourceURI", "file:///structural/another-source"),
            (["operations", "0", "source"], "identity", "1:99"),
            (["operations", "0", "stage"], "uri", "file:///structural/another-private/stage"),
            (["operations", "0", "stage"], "privateDirectoryIdentity", "1:99"),
            (["operations", "0"], "filled", NSNull()),
            (["operations", "0"], "published", NSNull()),
            (["operations", "0"], "replyJSON", NSNull())
        ]
        for (path, key, value) in changes {
            try refusedWrite(model(mutated(advancing, path: path) { $0[key] = value }))
        }
        try refusedWrite(record(initial.session.checkpoint, operations: [complete, operation(initial.session.checkpoint, id: 2)],
            advance: advancing.checkpointAdvance))
        try refusedWrite(record(initial.session.checkpoint, advance: advancing.checkpointAdvance))
    }

    func testPendingAdvanceRefusesDiscardAndCleanupState() throws {
        let initial = record(snapshot(1)), advancing = pending(initial, after: snapshot(7))
        try store.write(initial); try store.write(advancing)
        let discard = decision(initial.session.checkpoint)
        try refusedWrite(record(initial.session.checkpoint, discard: discard, state: .cleanupPending, advance: advancing.checkpointAdvance))
        try refusedWrite(record(initial.session.checkpoint, discard: discard, state: .cleanupPending))
    }

    func testUnfinishedAddAndExistingDiscardCannotBeginOrdinaryAdvance() throws {
        let intent = operation(snapshot(1), id: 1)
        let active = record(intent.before, operations: [intent])
        try store.write(active)
        try refusedWrite(pending(active, after: snapshot(8)))
        let separate = Store(databaseURL: root.appendingPathComponent("discarded.sqlite"))
        let discarded = record(snapshot(1), discard: decision(snapshot(1)), state: .cleanupPending)
        try separate.write(discarded)
        let evidence = try Data(contentsOf: separate.url)
        refused { try separate.write(self.pending(self.record(self.snapshot(1)), after: self.snapshot(8))) }
        XCTAssertEqual(try Data(contentsOf: separate.url), evidence)
    }

    func testNoPairCannotSilentlyAdvanceCheckpointEvenBeyondLastCompletedAdd() throws {
        let complete = operation(snapshot(1), id: 1, phase: .checkpointed)
        let originals = [record(snapshot(1)), record(complete.after, operations: [complete]), record(snapshot(8), operations: [complete])]
        for (index, original) in originals.enumerated() {
            let local = Store(databaseURL: root.appendingPathComponent("no-pair-\(index).sqlite"))
            try local.write(original)
            let evidence = try Data(contentsOf: local.url)
            let changed = record(snapshot(original.session.checkpoint.generation + 2), operations: original.operations)
            refused { try local.preflight(changed) }
            refused { try local.write(changed) }
            XCTAssertEqual(try Data(contentsOf: local.url), evidence)
        }
    }

    func testNewAddBeforeMustEqualCurrentAcceptedCheckpointBytes() throws {
        let initial = record(snapshot(8, payload: "{\"exact\":\"accepted\"}"))
        try store.write(initial)
        let wrong = operation(snapshot(8, payload: "{\"exact\":\"other\"}"), id: 1)
        try refusedWrite(record(wrong.before, operations: [wrong]))
        let right = operation(initial.session.checkpoint, id: 1)
        try cold().write(record(right.before, operations: [right]))
        XCTAssertEqual(try cold().read()?.operations.last?.before, initial.session.checkpoint)
    }

    func testOnlyExistingPendingAddCompletionMayMoveCheckpointWithoutAdvance() throws {
        let initial = record(snapshot(1)), complete = operation(snapshot(1), id: 1, phase: .checkpointed)
        try store.write(initial)
        try refusedWrite(record(complete.after, operations: [complete]))
        let pendingAdd = operation(snapshot(1), id: 1)
        try store.write(record(pendingAdd.before, operations: [pendingAdd]))
        try refusedWrite(record(snapshot(8), operations: [complete]))
        try store.write(record(complete.after, operations: [complete]))
        XCTAssertEqual(try cold().read()?.session.checkpoint, complete.after)
    }

    func testPreflightChecksRetentionAndCompleteEncodingWithoutChangingEitherFile() throws {
        let before = snapshot(1), initial = record(before), advancing = pending(initial, after: snapshot(8))
        try store.write(initial); try editor.checkpoint(before)
        let evidence = try bytes(), editorBytes = try Data(contentsOf: editor.url)
        let inode = try identity(store.url), editorInode = try identity(editor.url)
        try cold().preflight(advancing)
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try identity(store.url), inode); XCTAssertEqual(try identity(editor.url), editorInode)
        refused { try self.cold().preflight(self.record(self.snapshot(8))) }
        XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
    }

    func testPendingCapacityAccountsForEscapedRetainedBeforeSnapshot() throws {
        let prepared = escapedObject(700_000)
        let first = operation(snapshot(1), id: 1, phase: .checkpointed, prepared: prepared)
        let second = operation(first.after, id: 2, phase: .checkpointed, prepared: prepared)
        let before = snapshot(6, payload: escapedObject(450_000))
        let initial = record(before, operations: [first, second])
        try store.write(initial); try editor.checkpoint(before)
        XCTAssertLessThan(try bytes().count, Store.maximumBytes)
        let advancing = pending(initial, after: snapshot(12))
        XCTAssertGreaterThan(try encoded(advancing).count, Store.maximumBytes)
        let editorBytes = try Data(contentsOf: editor.url), editorInode = try identity(editor.url)
        try refusedWrite(advancing)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
        XCTAssertEqual(try identity(editor.url), editorInode)
        XCTAssertLessThan(try encoded(settled(advancing)).count, Store.maximumBytes)
    }

    func testPendingCapacityAccountsForEscapedNewSnapshotAndRetainedHistory() throws {
        let prepared = escapedObject(600_000)
        let operations = (1...3).map { operation(snapshot($0), id: $0, phase: .checkpointed, prepared: prepared) }
        let initial = record(try XCTUnwrap(operations.last).after, operations: operations)
        try store.write(initial); try editor.checkpoint(initial.session.checkpoint)
        let advancing = pending(initial, after: snapshot(10, payload: escapedObject(450_000)))
        XCTAssertLessThan(try bytes().count, Store.maximumBytes)
        XCTAssertGreaterThan(try encoded(advancing).count, Store.maximumBytes)
        let editorBytes = try Data(contentsOf: editor.url)
        try refusedWrite(advancing)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes)
    }

    func testCorruptUnknownVersionAndOversizeEvidenceIsNeverOverwrittenByPreflight() throws {
        for evidence in [Data("{broken private evidence}".utf8),
                         try raw(mutated(record(snapshot(1))) { $0["version"] = 99 }),
                         Data(repeating: 0x61, count: Store.maximumBytes + 1)] {
            try evidence.write(to: store.url)
            let inode = try identity(store.url)
            refused { _ = try self.cold().read() }
            refused { try self.cold().preflight(self.record(self.snapshot(1))) }
            refused { try self.cold().write(self.record(self.snapshot(1))) }
            XCTAssertEqual(try bytes(), evidence); XCTAssertEqual(try identity(store.url), inode)
        }
    }

    func testCheckpointAdvanceNeverChangesDatabaseSourceOrTargetBytes() throws {
        let source = root.appendingPathComponent("source.bin"), target = root.appendingPathComponent("target.bin")
        let databaseFile = try XCTUnwrap(database)
        let data = Data("unrequested file bytes 世界".utf8)
        for url in [source, target, databaseFile] { try data.write(to: url) }
        let before = snapshot(1), after = snapshot(9), advancing = pending(record(before), after: after)
        try store.write(record(before)); try editor.checkpoint(before)
        try store.write(advancing)
        try editor.checkpointOwnedAdvanceMatching(before: before, after: after)
        try store.write(settled(advancing))
        for url in [source, target, databaseFile] { XCTAssertEqual(try Data(contentsOf: url), data) }
    }

    func testByteDifferentCanonicallyEqualUnicodeCannotChangePendingPair() throws {
        let before = snapshot(1, payload: "{\"text\":\"é\"}"), after = snapshot(8, payload: "{\"text\":\"é\"}")
        let initial = record(before), advancing = pending(initial, after: after)
        try store.write(initial)
        let changedBefore = snapshot(1, payload: "{\"text\":\"e\u{301}\"}")
        try refusedWrite(record(before, advance: Store.CheckpointAdvance(before: changedBefore, after: after)))
        try store.write(advancing)
        let changedAfter = snapshot(8, payload: "{\"text\":\"e\u{301}\"}")
        try refusedWrite(pending(initial, after: changedAfter))
        try refusedWrite(record(changedAfter))
        XCTAssertTrue(try XCTUnwrap(cold().read()?.checkpointAdvance).after.payloadJSON.utf8.elementsEqual(after.payloadJSON.utf8))
    }

    func testCanonicallyEqualOpaqueOperationStringsAreFrozenDuringAdvance() throws {
        var fields = try object(record(snapshot(6), operations: [operation(snapshot(1), id: 1, phase: .checkpointed)]))
        let pathsAndKeys = [(["operations", "0"], "requestJSON"), (["operations", "0"], "preparedJSON"),
                           (["operations", "0"], "replyJSON"), (["operations", "0", "before"], "payloadJSON"),
                           (["operations", "0", "after"], "payloadJSON")]
        for (path, key) in pathsAndKeys {
            fields = try XCTUnwrap(edit(fields, path: path[...]) { $0[key] = "{\"text\":\"é\"}" } as? [String: Any])
        }
        let initial = try model(fields), advancing = pending(initial, after: snapshot(12))
        try store.write(initial); try store.write(advancing)
        for (path, key) in pathsAndKeys {
            try refusedWrite(model(mutated(advancing, path: path) { $0[key] = "{\"text\":\"e\u{301}\"}" }))
        }
        for (path, key) in [(["operations", "0"], "targetURI"), (["operations", "0", "source"], "sourceURI"),
                            (["operations", "0", "stage"], "uri")] {
            let local = Store(databaseURL: root.appendingPathComponent("unicode-uri-\(key).sqlite"))
            let base = try model(mutated(initial, path: path) { $0[key] = "file:///structural/é" })
            let advancing = pending(base, after: snapshot(12))
            try local.write(base); try local.write(advancing)
            let evidence = try Data(contentsOf: local.url)
            let changed = try model(mutated(advancing, path: path) { $0[key] = "file:///structural/e\u{301}" })
            refused { try local.write(changed) }
            XCTAssertEqual(try Data(contentsOf: local.url), evidence)
        }
    }

    func testSettledVersionTwoDiscardPreservesExistingSchemaAndRetention() throws {
        let complete = operation(snapshot(1), id: 1, phase: .checkpointed)
        let initial = record(complete.after, operations: [complete]), advancing = pending(initial, after: snapshot(8))
        try store.write(initial); try store.write(advancing); try store.write(settled(advancing))
        let accepted = try XCTUnwrap(cold().read())
        let decided = record(accepted.session.checkpoint, operations: accepted.operations,
            discard: decision(accepted.session.checkpoint), state: .cleanupPending)
        try store.write(decided)
        let detached = record(accepted.session.checkpoint, operations: accepted.operations,
            discard: decision(accepted.session.checkpoint, phase: .detached), state: .cleanupPending)
        try store.write(detached)
        XCTAssertEqual(try cold().read(), detached)
        try refusedWrite(accepted)
        try refusedWrite(decided)
        XCTAssertEqual(try cold().read()?.operations, accepted.operations)
    }

    func testEditorOwnedGapCASAndMatchedAfterColdRetryRewriteDurably() throws {
        let before = snapshot(1), after = snapshot(9, payload: "{\"raw\":\"after 世界\"}")
        try editor.checkpoint(before)
        try editor.checkpointOwnedAdvanceMatching(before: before, after: after)
        let firstIdentity = try identity(editor.url)
        let read = try XCTUnwrap(coldEditor().read())
        XCTAssertTrue(read.snapshot.payloadJSON.utf8.elementsEqual(after.payloadJSON.utf8))
        XCTAssertNil(read.attempt)
        try coldEditor().checkpointOwnedAdvanceMatching(before: before, after: after)
        XCTAssertNotEqual(try identity(editor.url), firstIdentity)
        XCTAssertEqual(try coldEditor().read()?.snapshot, after)
        XCTAssertEqual(try editor.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testExistingEditorAddCASStillRequiresPlusOneAndDoesNotRewriteMatchedAfter() throws {
        let before = snapshot(1), after = snapshot(2)
        try editor.checkpoint(before)
        let original = try Data(contentsOf: editor.url), originalIdentity = try identity(editor.url)
        editorRefused { try self.editor.checkpointMatching(before: before, after: self.snapshot(9)) }
        XCTAssertEqual(try Data(contentsOf: editor.url), original); XCTAssertEqual(try identity(editor.url), originalIdentity)
        try editor.checkpointMatching(before: before, after: after)
        let inode = try identity(editor.url), evidence = try Data(contentsOf: editor.url)
        try coldEditor().checkpointMatching(before: before, after: after)
        XCTAssertEqual(try identity(editor.url), inode); XCTAssertEqual(try Data(contentsOf: editor.url), evidence)
    }

    func testEditorOwnedCASRefusesMissingNewerOrDifferentExactBytes() throws {
        let before = snapshot(1), after = snapshot(8)
        editorRefused { try self.editor.checkpointOwnedAdvanceMatching(before: before, after: after) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: editor.url.path))
        for (index, current) in [snapshot(1, payload: "{\"other\":true}"), snapshot(8, payload: "{\"other\":true}"), snapshot(12)].enumerated() {
            let local = EditorDraftStore(databaseURL: root.appendingPathComponent("changed-editor-\(index).sqlite"))
            try local.checkpoint(current)
            let evidence = try Data(contentsOf: local.url), inode = try identity(local.url)
            editorRefused { try local.checkpointOwnedAdvanceMatching(before: before, after: after) }
            XCTAssertEqual(try Data(contentsOf: local.url), evidence); XCTAssertEqual(try identity(local.url), inode)
        }
    }

    func testEditorOwnedCASRetainsSaveAttemptAtBeforeAndMatchedAfter() throws {
        let before = snapshot(1), after = snapshot(8)
        for current in [before, after] {
            let local = EditorDraftStore(databaseURL: root.appendingPathComponent("attempt-\(current.generation).sqlite"))
            try local.checkpoint(current)
            let attempt = try local.freeze(sessionID: sessionID, generation: current.generation, method: "saveDraft", argumentsJSON: "[\"{}\"]")
            let evidence = try Data(contentsOf: local.url), inode = try identity(local.url)
            editorRefused { try local.checkpointOwnedAdvanceMatching(before: before, after: after) }
            XCTAssertEqual(try local.read()?.attempt, attempt)
            XCTAssertEqual(try Data(contentsOf: local.url), evidence); XCTAssertEqual(try identity(local.url), inode)
        }
    }

    func testEditorOwnedCASSessionTaskAndUnicodePayloadAreExact() throws {
        let before = snapshot(1, payload: "{\"text\":\"é\"}", taskID: "task-é")
        try editor.checkpoint(before)
        let evidence = try Data(contentsOf: editor.url), inode = try identity(editor.url)
        let wrongBefore = [snapshot(1, payload: before.payloadJSON, sessionID: otherSessionID, taskID: before.taskID),
                           snapshot(1, payload: before.payloadJSON, taskID: "task-e\u{301}"),
                           snapshot(1, payload: "{\"text\":\"e\u{301}\"}", taskID: before.taskID)]
        for value in wrongBefore {
            editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: value,
                after: self.snapshot(8, sessionID: value.sessionID, taskID: value.taskID)) }
        }
        editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: before, after: self.snapshot(8, sessionID: self.otherSessionID, taskID: before.taskID)) }
        editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: before, after: self.snapshot(8, taskID: "task-e\u{301}")) }
        XCTAssertEqual(try Data(contentsOf: editor.url), evidence); XCTAssertEqual(try identity(editor.url), inode)
    }

    func testEditorOwnedCASRejectsUnsafeBackwardAndEqualGenerations() throws {
        let before = snapshot(4)
        try editor.checkpoint(before)
        let evidence = try Data(contentsOf: editor.url), inode = try identity(editor.url)
        for generation in [0, -1, 3, 4, maximumGeneration + 1, Int.max] {
            editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: before, after: self.snapshot(generation)) }
        }
        editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: self.snapshot(self.maximumGeneration + 1), after: self.snapshot(Int.max)) }
        XCTAssertEqual(try Data(contentsOf: editor.url), evidence); XCTAssertEqual(try identity(editor.url), inode)
        let local = EditorDraftStore(databaseURL: root.appendingPathComponent("safe-maximum.sqlite"))
        let near = snapshot(maximumGeneration - 10), maximum = snapshot(maximumGeneration)
        try local.checkpoint(near)
        try local.checkpointOwnedAdvanceMatching(before: near, after: maximum)
        XCTAssertEqual(try local.read()?.snapshot, maximum)
    }

    func testEditorOwnedCASCorruptSymlinkAndDirectoryLeavesRetainEvidence() throws {
        let corrupt = Data("private corrupt editor".utf8)
        try corrupt.write(to: editor.url)
        let inode = try identity(editor.url)
        editorRefused { try self.editor.checkpointOwnedAdvanceMatching(before: self.snapshot(1), after: self.snapshot(8)) }
        XCTAssertEqual(try Data(contentsOf: editor.url), corrupt); XCTAssertEqual(try identity(editor.url), inode)
        try FileManager.default.removeItem(at: editor.url)
        let outside = root.appendingPathComponent("outside-evidence")
        try corrupt.write(to: outside)
        try FileManager.default.createSymbolicLink(at: editor.url, withDestinationURL: outside)
        editorRefused { try self.editor.checkpointOwnedAdvanceMatching(before: self.snapshot(1), after: self.snapshot(8)) }
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: editor.url.path), outside.path)
        XCTAssertEqual(try Data(contentsOf: outside), corrupt)
        try FileManager.default.removeItem(at: editor.url)
        try FileManager.default.createDirectory(at: editor.url, withIntermediateDirectories: false)
        let nested = editor.url.appendingPathComponent("evidence")
        try corrupt.write(to: nested)
        editorRefused { try self.editor.checkpointOwnedAdvanceMatching(before: self.snapshot(1), after: self.snapshot(8)) }
        XCTAssertEqual(try Data(contentsOf: nested), corrupt)
    }

    func testEditorFIFORefusesPromptlyWithoutReplacingOrRemovingLeaf() throws {
        XCTAssertEqual(Darwin.mkfifo(editor.url.path, mode_t(0o600)), 0)
        let inode = try identity(editor.url), started = ProcessInfo.processInfo.systemUptime
        editorRefused { _ = try self.coldEditor().read() }
        editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: self.snapshot(1), after: self.snapshot(8)) }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 2)
        XCTAssertEqual(try identity(editor.url), inode)
        var info = stat()
        XCTAssertEqual(Darwin.lstat(editor.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(S_IFMT), mode_t(S_IFIFO))
    }

    func testEditorOwnedCASInvalidPayloadRefusesBeforeWrite() throws {
        let before = snapshot(1)
        try editor.checkpoint(before)
        let evidence = try Data(contentsOf: editor.url), inode = try identity(editor.url)
        for payload in ["[]", "{broken", "{\"text\":\"" + String(repeating: "a", count: 1_000_000) + "\"}"] {
            editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: before, after: self.snapshot(8, payload: payload)) }
        }
        XCTAssertEqual(try Data(contentsOf: editor.url), evidence); XCTAssertEqual(try identity(editor.url), inode)
    }

    func testEditorPreflightNearRawPayloadBoundDoesNotWriteEitherFile() throws {
        let before = snapshot(1), large = snapshot(8, payload: escapedObject(499_990))
        XCTAssertLessThanOrEqual(large.payloadJSON.utf8.count, 1_000_000)
        let missing = EditorDraftStore(databaseURL: root.appendingPathComponent("preflight-missing.sqlite"))
        try missing.preflightCheckpoint(large)
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.url.path))
        try editor.checkpoint(before); try store.write(record(before))
        let editorBytes = try Data(contentsOf: editor.url), sidecarBytes = try bytes()
        let editorInode = try identity(editor.url), sidecarInode = try identity(store.url)
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
        try editor.preflightCheckpoint(large)
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try bytes(), sidecarBytes)
        XCTAssertEqual(try identity(editor.url), editorInode); XCTAssertEqual(try identity(store.url), sidecarInode)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted(), names)


        let accepted = EditorDraftStore(databaseURL: root.appendingPathComponent("accepted-large.sqlite"))
        try accepted.checkpoint(large)
        XCTAssertLessThan(try Data(contentsOf: accepted.url).count, 3_000_000)
    }

    func testEditorPreflightRawOverLimitRefusesWithoutAnyDiskMutation() throws {
        let before = snapshot(1)
        try editor.checkpoint(before); try store.write(record(before))
        let editorBytes = try Data(contentsOf: editor.url), sidecarBytes = try bytes()
        let editorInode = try identity(editor.url), sidecarInode = try identity(store.url)
        let excessive = snapshot(8, payload: "{\"text\":\"" + String(repeating: "a", count: 1_000_000) + "\"}")
        editorRefused { try self.editor.preflightCheckpoint(excessive) }
        let missing = EditorDraftStore(databaseURL: root.appendingPathComponent("refused-preflight.sqlite"))
        editorRefused { try missing.preflightCheckpoint(excessive) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.url.path))
        XCTAssertEqual(try Data(contentsOf: editor.url), editorBytes); XCTAssertEqual(try bytes(), sidecarBytes)
        XCTAssertEqual(try identity(editor.url), editorInode); XCTAssertEqual(try identity(store.url), sidecarInode)
    }

    func testMatchedAfterRequiresSuccessfulActualWriteAndColdRetry() throws {
        if geteuid() == 0 { throw XCTSkip("Actual permission refusal requires an unprivileged account") }
        let before = snapshot(1), after = snapshot(8)
        try editor.checkpoint(after)
        let evidence = try Data(contentsOf: editor.url), inode = try identity(editor.url)
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o500)), 0)
        defer { _ = Darwin.chmod(root.path, mode_t(0o700)) }
        editorRefused { try self.coldEditor().checkpointOwnedAdvanceMatching(before: before, after: after) }
        XCTAssertEqual(try Data(contentsOf: editor.url), evidence); XCTAssertEqual(try identity(editor.url), inode)
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o700)), 0)
        try coldEditor().checkpointOwnedAdvanceMatching(before: before, after: after)
        XCTAssertNotEqual(try identity(editor.url), inode)
        XCTAssertEqual(try coldEditor().read()?.snapshot, after)
    }

    func testFinalSidecarWriteRefusalRetainsPairAndColdExactAfterCanFinish() throws {
        if geteuid() == 0 { throw XCTSkip("Actual permission refusal requires an unprivileged account") }
        let before = snapshot(1), after = snapshot(8), initial = record(before)
        let advancing = pending(initial, after: after)
        try store.write(initial); try editor.checkpoint(before); try store.write(advancing)
        try editor.checkpointOwnedAdvanceMatching(before: before, after: after)
        let pendingBytes = try bytes(), editorInode = try identity(editor.url)
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o500)), 0)
        defer { _ = Darwin.chmod(root.path, mode_t(0o700)) }
        XCTAssertThrowsError(try cold().write(settled(advancing))) { error in
            XCTAssertEqual(error as? StoreError, .io)
        }
        XCTAssertEqual(try bytes(), pendingBytes)
        XCTAssertEqual(try cold().read(), advancing)
        XCTAssertEqual(try coldEditor().read()?.snapshot, after)
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o700)), 0)
        try coldEditor().checkpointOwnedAdvanceMatching(before: before, after: after)
        XCTAssertNotEqual(try identity(editor.url), editorInode)
        try cold().write(settled(advancing))
        XCTAssertNil(try cold().read()?.checkpointAdvance)
        XCTAssertEqual(try cold().read()?.session.checkpoint, after)
    }

    private func cold() -> Store { Store(databaseURL: database) }
    private func coldEditor() -> EditorDraftStore { EditorDraftStore(databaseURL: database) }
    private func snapshot(_ generation: Int, payload: String? = nil, sessionID: String? = nil,
                          taskID: String = "task-record") -> EditorDraftSnapshot {
        EditorDraftSnapshot(sessionID: sessionID ?? self.sessionID, taskID: taskID, generation: generation,
                            payloadJSON: payload ?? "{\"value\":\(generation)}")
    }
    private func session(_ checkpoint: EditorDraftSnapshot, state: Store.SessionState = .active) -> Store.Session {
        Store.Session(sessionID: checkpoint.sessionID, taskID: checkpoint.taskID, state: state, checkpoint: checkpoint)
    }
    private func record(_ checkpoint: EditorDraftSnapshot, operations: [Store.Operation] = [], version: Int = 2,
                        discard: Store.Discard? = nil, state: Store.SessionState = .active,
                        advance: Store.CheckpointAdvance? = nil) -> Store.Record {
        Store.Record(version: version, session: session(checkpoint, state: state), operations: operations,
                     discard: discard, checkpointAdvance: advance)
    }
    private func pending(_ previous: Store.Record, after: EditorDraftSnapshot) -> Store.Record {
        record(previous.session.checkpoint, operations: previous.operations,
            advance: Store.CheckpointAdvance(before: previous.session.checkpoint, after: after))
    }
    private func settled(_ pending: Store.Record) throws -> Store.Record {
        record(try XCTUnwrap(pending.checkpointAdvance).after, operations: pending.operations)
    }
    private func operation(_ before: EditorDraftSnapshot, id: Int, phase: Store.Phase = .intent,
                           prepared: String = "{}") -> Store.Operation {
        let source = Store.Source(sourceURI: "file:///structural/cache/source-\(id).bin", sha256: sha, size: 12,
                                  identity: "1:11", cacheRootIdentity: "1:12", parentIdentity: "1:13")
        let token = "1:\(20 + id)"
        return Store.Operation(requestId: String(format: "550e8400-e29b-41d4-a716-%012d", id), requestJSON: "{}", phase: phase,
            before: before, after: snapshot(before.generation + 1, sessionID: before.sessionID, taskID: before.taskID),
            preparedJSON: prepared, targetURI: "file:///structural/documents/attachments/target-\(id).bin", source: source,
            stage: phase.rank >= 1 ? Store.Stage(uri: "file:///structural/documents/attachments/private-\(id)/stage",
                identity: token, directoryIdentity: "1:30", privateDirectoryIdentity: "1:\(40 + id)") : nil,
            filled: phase.rank >= 2 ? Store.Filled(sha256: sha, size: 12, identity: token) : nil,
            published: phase.rank >= 3 ? Store.Published(sha256: sha, size: 12, identity: token, directoryIdentity: "1:30") : nil,
            replyJSON: phase.rank >= 4 ? "{}" : nil)
    }
    private func decision(_ checkpoint: EditorDraftSnapshot, phase: Store.DiscardPhase = .decided) -> Store.Discard {
        Store.Discard(requestId: discardID, requestJSON: "{}", expected: checkpoint, phase: phase,
                      replyJSON: phase == .detached ? "{}" : nil)
    }
    private func escapedObject(_ pairs: Int) -> String { "{\"text\":\"" + String(repeating: "\\\\", count: pairs) + "\"}" }
    private func encoded(_ record: Store.Record) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(record)
    }
    private func object(_ record: Store.Record) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: encoded(record)) as? [String: Any])
    }
    private func raw(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func model(_ value: [String: Any]) throws -> Store.Record { try JSONDecoder().decode(Store.Record.self, from: raw(value)) }
    private func edit(_ value: Any, path: ArraySlice<String>, body: (inout [String: Any]) -> Void) throws -> Any {
        guard let first = path.first else {
            var object = try XCTUnwrap(value as? [String: Any]); body(&object); return object
        }
        if var array = value as? [Any], let index = Int(first) {
            array[index] = try edit(array[index], path: path.dropFirst(), body: body); return array
        }
        var object = try XCTUnwrap(value as? [String: Any])
        object[first] = try edit(XCTUnwrap(object[first]), path: path.dropFirst(), body: body)
        return object
    }
    private func mutated(_ record: Store.Record, path: [String] = [], body: (inout [String: Any]) -> Void) throws -> [String: Any] {
        try XCTUnwrap(edit(object(record), path: path[...], body: body) as? [String: Any])
    }
    private func bytes() throws -> Data { try Data(contentsOf: store.url) }
    private func identity(_ url: URL) throws -> String {
        var info = stat()
        guard Darwin.lstat(url.path, &info) == 0 else { throw StoreError.io }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func refused(_ action: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try action(), file: file, line: line) { error in
            XCTAssertEqual(error as? StoreError, .corrupt, file: file, line: line)
        }
    }
    private func refusedWrite(_ value: Store.Record, file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try bytes(), inode = try identity(store.url)
        refused({ try self.cold().preflight(value) }, file: file, line: line)
        refused({ try self.cold().write(value) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(store.url), inode, file: file, line: line)
    }
    private func malformedRead(_ value: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try raw(value)
        try evidence.write(to: store.url)
        let inode = try identity(store.url)
        refused({ _ = try self.cold().read() }, file: file, line: line)
        refused({ try self.cold().preflight(self.record(self.snapshot(1))) }, file: file, line: line)
        refused({ try self.cold().write(self.record(self.snapshot(1))) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(store.url), inode, file: file, line: line)
    }
    private func editorRefused(_ action: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try action(), file: file, line: line) { error in
            XCTAssertTrue(error is HostFailure || error is EditorDraftStoreError, file: file, line: line)
        }
    }
}
