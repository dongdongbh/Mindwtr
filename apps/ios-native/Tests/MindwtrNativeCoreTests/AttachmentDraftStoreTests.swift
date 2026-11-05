import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore

final class AttachmentDraftStoreTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var database: URL!
    private var store: Store!
    private let sessionID = "550e8400-e29b-41d4-a716-446655440000"
    private let discardID = "550e8400-e29b-41d4-a716-999999999999"
    private let sha = String(repeating: "1", count: 64)
    private let phases: [Store.Phase] = [.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed]

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task224-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw StoreError.corrupt }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        database = root.appendingPathComponent("library.sqlite")
        store = Store(databaseURL: database)
    }
    private typealias StoreError = NativeAttachmentDraftStoreError
    override func tearDownWithError() throws {
        store = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func cold() -> Store { Store(databaseURL: database) }
    private func snapshot(_ generation: Int, payload: String? = nil) -> EditorDraftSnapshot {
        EditorDraftSnapshot(sessionID: sessionID, taskID: "task-record", generation: generation,
                            payloadJSON: payload ?? "{\"checkpoint\":\(generation)}")
    }
    private func operation(_ generation: Int, phase: Store.Phase = .intent,
                           prepared: String = "{}", reason: Store.Reason? = nil) -> Store.Operation {
        let source = Store.Source(sourceURI: "file:///owned/cache/source.bin", sha256: sha, size: 12,
                                  identity: "1:11", cacheRootIdentity: "1:12", parentIdentity: "1:13")
        let identity = "1:\(20 + generation)"
        return Store.Operation(requestId: String(format: "550e8400-e29b-41d4-a716-%012d", generation),
            requestJSON: "{}", phase: phase, reason: reason, before: snapshot(generation), after: snapshot(generation + 1),
            preparedJSON: prepared, targetURI: "file:///owned/documents/attachments/target-\(generation).bin", source: source,
            stage: phase.rank >= 1 ? Store.Stage(uri: "file:///owned/documents/attachments/private-\(generation)/stage",
                identity: identity, directoryIdentity: "1:30", privateDirectoryIdentity: "1:\(40 + generation)") : nil,
            filled: phase.rank >= 2 ? Store.Filled(sha256: sha, size: 12, identity: identity) : nil,
            published: phase.rank >= 3 ? Store.Published(sha256: sha, size: 12, identity: identity, directoryIdentity: "1:30") : nil,
            replyJSON: phase.rank >= 4 ? "{}" : nil)
    }
    private func record(_ operations: [Store.Operation] = [], discardPhase: Store.DiscardPhase? = nil) -> Store.Record {
        let checkpoint = operations.last.map { $0.phase == .checkpointed ? $0.after : $0.before } ?? snapshot(1)
        let session = Store.Session(sessionID: sessionID, taskID: "task-record",
                                    state: discardPhase == nil ? .active : .cleanupPending, checkpoint: checkpoint)
        let discard = discardPhase.map {
            Store.Discard(requestId: discardID, requestJSON: "{}", expected: checkpoint, phase: $0,
                          replyJSON: $0 == .detached ? "{}" : nil)
        }
        return Store.Record(session: session, operations: operations, discard: discard)
    }
    private func encoded(_ value: Store.Record) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    private func object(_ value: Store.Record) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: encoded(value)) as? [String: Any])
    }

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
    private func mutated(_ value: Store.Record, path: [String] = [], body: (inout [String: Any]) -> Void) throws -> [String: Any] {
        try XCTUnwrap(edit(object(value), path: path[...], body: body) as? [String: Any])
    }
    private func model(_ object: [String: Any]) throws -> Store.Record {
        try JSONDecoder().decode(Store.Record.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func raw(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
    private func bytes() throws -> Data { try Data(contentsOf: store.url) }
    private func identity() throws -> String {
        var info = stat()
        guard Darwin.lstat(store.url.path, &info) == 0 else { throw StoreError.corrupt }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func refused(_ body: () throws -> Void, expected: StoreError = .corrupt,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual(error as? StoreError, expected, file: file, line: line)
            XCTAssertEqual(error.localizedDescription, expected.localizedDescription, file: file, line: line)
        }
    }
    private func malformedRead(_ object: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try raw(object)
        try evidence.write(to: store.url)
        let originalIdentity = try identity()
        refused({ _ = try self.cold().read() }, file: file, line: line)
        refused({ try self.cold().write(self.record()) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(), originalIdentity, file: file, line: line)
    }
    private func refusedWrite(_ value: Store.Record, file: StaticString = #filePath, line: UInt = #line) throws {
        let evidence = try bytes(), originalIdentity = try identity()
        refused({ try self.cold().write(value) }, file: file, line: line)
        XCTAssertEqual(try bytes(), evidence, file: file, line: line)
        XCTAssertEqual(try identity(), originalIdentity, file: file, line: line)
    }

    func testMissingReadAndValidEmptyBeginRoundTripPrivateSibling() throws {
        XCTAssertNil(try store.read())
        XCTAssertEqual(store.url, database.appendingPathExtension("attachment-draft.json"))
        let begin = record()
        try store.write(begin)
        XCTAssertEqual(try cold().read(), begin)
        var info = stat()
        XCTAssertEqual(Darwin.lstat(store.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(0o777), mode_t(0o600))
        XCTAssertEqual(try store.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testEveryPhaseRoundTripsAfterRecreationWithExplicitNulls() throws {
        for phase in phases {
            let local = Store(databaseURL: root.appendingPathComponent("phase-\(phase.rawValue).sqlite"))
            let value = record([operation(1, phase: phase)])
            try local.write(value)
            XCTAssertEqual(try Store(databaseURL: root.appendingPathComponent("phase-\(phase.rawValue).sqlite")).read(), value)
            let raw = try object(value)
            XCTAssertTrue(raw["discard"] is NSNull)
            let op = try XCTUnwrap((raw["operations"] as? [[String: Any]])?.first)
            XCTAssertTrue(op["reason"] is NSNull)
            for field in ["stage", "filled", "published", "replyJSON"] {
                XCTAssertNotNil(op[field])
            }
        }
    }

    func testSingleOperationProgressesMonotonicallyThenAppendsOneOperation() throws {
        try store.write(record())
        for phase in phases { try cold().write(record([operation(1, phase: phase)])) }
        let second = record([operation(1, phase: .checkpointed), operation(2)])
        try cold().write(second)
        XCTAssertEqual(try cold().read(), second)
        let secondComplete = record([operation(1, phase: .checkpointed), operation(2, phase: .checkpointed)])
        try cold().write(secondComplete)
        XCTAssertEqual(try cold().read(), secondComplete)
    }

    func testMultipleCheckpointedOperationsAndRetainedDiscardRoundTrip() throws {
        let operations = [operation(1, phase: .checkpointed), operation(2, phase: .checkpointed)]
        try store.write(record(operations))
        let decided = record(operations, discardPhase: .decided)
        try cold().write(decided)
        XCTAssertEqual(try cold().read(), decided)
        XCTAssertTrue(try XCTUnwrap(object(decided)["discard"] as? [String: Any])["replyJSON"] is NSNull)
        let detached = record(operations, discardPhase: .detached)
        try cold().write(detached)
        XCTAssertEqual(try cold().read(), detached)
    }

    func testAllObjectLevelsRejectUnknownAndMissingFieldsWithoutEvidenceLoss() throws {
        let value = record([operation(1, phase: .checkpointed)], discardPhase: .detached)
        let paths = [[], ["session"], ["session", "checkpoint"], ["operations", "0"],
                     ["operations", "0", "before"], ["operations", "0", "after"], ["operations", "0", "source"],
                     ["operations", "0", "stage"], ["operations", "0", "filled"], ["operations", "0", "published"],
                     ["discard"], ["discard", "expected"]]
        for path in paths {
            try malformedRead(mutated(value, path: path) { $0["unexpected"] = true })
            try malformedRead(mutated(value, path: path) { object in
                if let field = object.keys.sorted().first { object.removeValue(forKey: field) }
            })
        }
    }

    func testRequiredNullableFieldsCannotBeOmittedOrTypeChanged() throws {
        let value = record([operation(1)])
        try malformedRead(mutated(value) { $0.removeValue(forKey: "discard") })
        for key in ["reason", "stage", "filled", "published", "replyJSON"] {
            try malformedRead(mutated(value, path: ["operations", "0"]) { $0.removeValue(forKey: key) })
            try malformedRead(mutated(value, path: ["operations", "0"]) { $0[key] = true })
        }
        let decided = record(discardPhase: .decided)
        try malformedRead(mutated(decided, path: ["discard"]) { $0.removeValue(forKey: "replyJSON") })
    }

    func testWrongTypesAndUnknownEnumsAreCapabilityErrors() throws {
        let value = record([operation(1, phase: .stageFilled)])
        try malformedRead(mutated(value) { $0["version"] = true })
        try malformedRead(mutated(value) { $0["operations"] = "not-array" })
        try malformedRead(mutated(value, path: ["session"]) { $0["state"] = "unknown" })
        try malformedRead(mutated(value, path: ["session", "checkpoint"]) { $0["generation"] = true })
        for phase in ["unknown", "Intent"] {
            try malformedRead(mutated(value, path: ["operations", "0"]) { $0["phase"] = phase })
        }
        try malformedRead(mutated(value, path: ["operations", "0"]) { $0["reason"] = "raw error text" })
        for size: Any in [true, "12", 12.5, -1, 9_007_199_254_740_992.0] {
            try malformedRead(mutated(value, path: ["operations", "0", "source"]) { $0["size"] = size })
        }
    }

    func testSessionSnapshotBindingsAndExactNextGenerationAreRequired() throws {
        let value = record([operation(1)])
        try malformedRead(mutated(value) { $0["version"] = 2 })
        try malformedRead(mutated(value, path: ["session"]) { $0["sessionID"] = self.discardID })
        try malformedRead(mutated(value, path: ["session"]) { $0["taskID"] = "other" })
        try malformedRead(mutated(value, path: ["operations", "0", "after"]) { $0["taskID"] = "other" })
        for generation in [0, 1, 3, Int.max] {
            try malformedRead(mutated(value, path: ["operations", "0", "after"]) { $0["generation"] = generation })
        }
        var overflow = try mutated(value, path: ["operations", "0", "before"]) { $0["generation"] = Int.max }
        overflow = try XCTUnwrap(edit(overflow, path: ["session", "checkpoint"][...]) { $0["generation"] = Int.max } as? [String: Any])
        try malformedRead(overflow)
    }

    func testWrongLineageAndByteDifferentUnicodeCheckpointsRefuse() throws {
        let value = record([operation(1, phase: .checkpointed), operation(2, phase: .checkpointed)])
        try malformedRead(mutated(value, path: ["operations", "1", "before"]) { $0["payloadJSON"] = "{\"different\":true}" })
        var unicode = try mutated(value, path: ["operations", "0", "after"]) { $0["payloadJSON"] = "{\"text\":\"é\"}" }
        unicode = try XCTUnwrap(edit(unicode, path: ["operations", "1", "before"][...]) { $0["payloadJSON"] = "{\"text\":\"e\u{301}\"}" } as? [String: Any])
        try malformedRead(unicode)
        try malformedRead(mutated(value, path: ["session", "checkpoint"]) { $0["payloadJSON"] = "{ \"checkpoint\":3 }" })
    }

    func testDuplicateAddAndDiscardIDsAndInvalidUUIDsRefuse() throws {
        let value = record([operation(1, phase: .checkpointed), operation(2, phase: .checkpointed)])
        try malformedRead(mutated(value, path: ["operations", "1"]) { $0["requestId"] = self.operation(1).requestId })
        let discarded = record([operation(1, phase: .checkpointed)], discardPhase: .decided)
        try malformedRead(mutated(discarded, path: ["discard"]) { $0["requestId"] = self.operation(1).requestId })
        for uuid in ["invalid", operation(1).requestId.uppercased(), "", "550e8400e29b41d4a716000000000001"] {
            try malformedRead(mutated(record([operation(1)]), path: ["operations", "0"]) { $0["requestId"] = uuid })
        }
    }

    func testProofPresenceReasonAndDigestConsistencyAreRequiredAtEveryPhase() throws {
        for phase in phases {
            let value = record([operation(1, phase: phase)])
            try malformedRead(mutated(value, path: ["operations", "0"]) { $0["phase"] = phase == .intent ? "checkpointed" : "intent" })
        }
        let filled = record([operation(1, phase: .stageFilled)])
        try malformedRead(mutated(filled, path: ["operations", "0", "filled"]) { $0["sha256"] = String(repeating: "2", count: 64) })
        try malformedRead(mutated(filled, path: ["operations", "0", "filled"]) { $0["size"] = 13 })
        try malformedRead(mutated(filled, path: ["operations", "0", "filled"]) { $0["identity"] = "1:99" })
        let published = record([operation(1, phase: .published)])
        for key in ["identity", "directoryIdentity"] {
            try malformedRead(mutated(published, path: ["operations", "0", "published"]) { $0[key] = "1:99" })
        }
        let complete = record([operation(1, phase: .checkpointed)])
        try malformedRead(mutated(complete, path: ["operations", "0"]) { $0["reason"] = "io" })
        let partialEarlier = record([operation(1), operation(2)])
        try malformedRead(object(partialEarlier))
    }

    func testFixedPrecheckpointReasonsRoundTripWithoutPersistingRawErrors() throws {
        let reasons: [Store.Reason] = [.interruptedReservation, .sourceChanged, .stageChanged, .targetConflict,
                                      .checkpointChanged, .taskReadOnly, .pendingDomainReplay, .io]
        for reason in reasons {
            let local = Store(databaseURL: root.appendingPathComponent("reason-\(reason.rawValue).sqlite"))
            let value = record([operation(1, reason: reason)])
            try local.write(value)
            XCTAssertEqual(try local.read(), value)
        }
    }

    func testDigestIdentityAndURIValidationIsStrictButNotOwnershipProof() throws {
        let value = record([operation(1, phase: .stageFilled)])
        for token in ["", "01:2", "1:+2", "-1:2", "1:", ":2", "1:2:3", "18446744073709551616:2", "x:y"] {
            try malformedRead(mutated(value, path: ["operations", "0", "source"]) { $0["identity"] = token })
        }
        for hash in ["", String(repeating: "A", count: 64), String(repeating: "1", count: 63), String(repeating: "g", count: 64)] {
            try malformedRead(mutated(value, path: ["operations", "0", "source"]) { $0["sha256"] = hash })
        }
        let invalidURIs = ["https://example.invalid/file", "/absolute/path", "file:relative", "file://localhost/owned/file",
                           "file://name:credential@/owned/file", "file:///owned/../file", "file:///owned/%2e%2e/file",
                           "file:///owned/%2e%2e%2Ffile", "file:///owned/file?private=value", "file:///owned/file#fragment", "file:///owned/file%00tail"]
        for uri in invalidURIs {
            try malformedRead(mutated(value, path: ["operations", "0"]) { $0["targetURI"] = uri })
            try malformedRead(mutated(value, path: ["operations", "0", "source"]) { $0["sourceURI"] = uri })
            try malformedRead(mutated(value, path: ["operations", "0", "stage"]) { $0["uri"] = uri })
        }

        let outside = try model(mutated(record([operation(1)]), path: ["operations", "0"]) { $0["targetURI"] = "file:///another-library/file" })
        let outsideDatabase = root.appendingPathComponent("structural-outside-uri.sqlite")
        let structuralStore = Store(databaseURL: outsideDatabase)
        try structuralStore.write(outside)
        XCTAssertEqual(try Store(databaseURL: outsideDatabase).read(), outside)
    }

    func testDiscardStateExpectedSnapshotAndPhaseReplyBindingsAreStrict() throws {
        let value = record(discardPhase: .decided)
        try malformedRead(mutated(value, path: ["session"]) { $0["state"] = "active" })
        try malformedRead(mutated(record(), path: ["session"]) { $0["state"] = "cleanupPending" })
        try malformedRead(mutated(value, path: ["discard", "expected"]) { $0["payloadJSON"] = "{\"other\":true}" })
        try malformedRead(mutated(value, path: ["discard"]) { $0["replyJSON"] = "{}" })
        try malformedRead(mutated(value, path: ["discard"]) { $0["phase"] = "unknown" })
        try malformedRead(mutated(record(discardPhase: .detached), path: ["discard"]) { $0["replyJSON"] = NSNull() })
    }

    func testFieldBoundsAndOpaqueObjectSyntaxRefuseWithoutReplacement() throws {
        try store.write(record())
        let base = record([operation(1)])
        for key in ["requestJSON", "preparedJSON"] {
            let limit = key == "requestJSON" ? 64 * 1024 : 2 * 1024 * 1024
            for text in ["[]", "{broken", "{\"x\":\"" + String(repeating: "x", count: limit) + "\"}"] {
                try refusedWrite(model(mutated(base, path: ["operations", "0"]) { $0[key] = text }))
            }
        }
        let oversizedPayload = "{\"x\":\"" + String(repeating: "x", count: 1_000_000) + "\"}"
        try refusedWrite(model(mutated(base, path: ["operations", "0", "after"]) { $0["payloadJSON"] = oversizedPayload }))
        try refusedWrite(model(mutated(base, path: ["operations", "0"]) { $0["targetURI"] = "file:///" + String(repeating: "x", count: 16 * 1024) }))
        let complete = record([operation(1, phase: .checkpointed)])
        for text in ["[]", "{\"x\":\"" + String(repeating: "x", count: 64 * 1024) + "\"}"] {
            try refusedWrite(model(mutated(complete, path: ["operations", "0"]) { $0["replyJSON"] = text }))
        }
    }

    func testOperationCountAndEncodedTotalBoundsPreservePriorEvidence() throws {
        let full = record((1...128).map { operation($0, phase: .checkpointed) })
        try store.write(full)
        XCTAssertEqual(try cold().read(), full)
        try refusedWrite(record((1...129).map { operation($0, phase: .checkpointed) }))
        let localDatabase = root.appendingPathComponent("encoded-bound.sqlite")
        let local = Store(databaseURL: localDatabase)


        let prepared = "{\"text\":\"" + String(repeating: "\\\\", count: 600_000) + "\"}"
        let prior = record((1...3).map { operation($0, phase: .checkpointed, prepared: prepared) })
        try local.write(prior)
        let evidence = try Data(contentsOf: local.url)
        XCTAssertLessThanOrEqual(evidence.count, Store.maximumBytes)
        let overflow = record((1...4).map { operation($0, phase: .checkpointed, prepared: prepared) })
        refused { try local.write(overflow) }
        XCTAssertEqual(try Data(contentsOf: local.url), evidence)
        XCTAssertEqual(try Store(databaseURL: localDatabase).read(), prior)
    }

    func testCorruptSymlinkDirectoryAndOversizeLeavesCannotBeReadOrOverwritten() throws {
        let data = Data("private corrupt evidence".utf8)
        try data.write(to: store.url)
        let before = try identity()
        refused { _ = try self.store.read() }
        refused { try self.store.write(self.record()) }
        XCTAssertEqual(try identity(), before)
        XCTAssertEqual(try bytes(), data)
        try FileManager.default.removeItem(at: store.url)
        let outside = root.appendingPathComponent("outside-evidence")
        try data.write(to: outside)
        try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: outside)
        refused { _ = try self.store.read() }
        refused { try self.store.write(self.record()) }
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: store.url.path), outside.path)
        XCTAssertEqual(try Data(contentsOf: outside), data)
        try FileManager.default.removeItem(at: store.url)
        try FileManager.default.createDirectory(at: store.url, withIntermediateDirectories: false)
        let nested = store.url.appendingPathComponent("private-evidence")
        try data.write(to: nested)
        refused { _ = try self.store.read() }
        refused { try self.store.write(self.record()) }
        XCTAssertEqual(try Data(contentsOf: nested), data)
        try FileManager.default.removeItem(at: store.url)
        let oversized = Data(repeating: 0x71, count: Store.maximumBytes + 1)
        try oversized.write(to: store.url)
        refused { _ = try self.store.read() }
        refused { try self.store.write(self.record()) }
        XCTAssertEqual(try bytes(), oversized)
    }

    func testUnexpectedFIFORefusesPromptlyWithoutRemovingEntry() throws {
        guard Darwin.mkfifo(store.url.path, mode_t(0o600)) == 0 else { throw StoreError.io }
        let originalIdentity = try identity()
        let started = ProcessInfo.processInfo.systemUptime
        refused { _ = try self.cold().read() }
        refused { try self.cold().write(self.record()) }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 2)
        XCTAssertEqual(try identity(), originalIdentity)
        var info = stat()
        XCTAssertEqual(Darwin.lstat(store.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(S_IFMT), mode_t(S_IFIFO))
    }

    func testImmutableOperationFieldsCannotChangeAcrossWrites() throws {
        let value = record([operation(1)])
        try store.write(value)
        let changes: [(String, Any)] = [("requestId", discardID), ("requestJSON", "{\"different\":1}"),
                                      ("preparedJSON", "{\"different\":1}"), ("targetURI", "file:///owned/new-target")]
        for (key, changed) in changes {
            try refusedWrite(model(mutated(value, path: ["operations", "0"]) { $0[key] = changed }))
        }
        for key in ["sourceURI", "sha256", "identity", "cacheRootIdentity", "parentIdentity"] {
            let changed = key == "sourceURI" ? "file:///owned/cache/new" : key == "sha256" ? String(repeating: "2", count: 64) : "1:99"
            try refusedWrite(model(mutated(value, path: ["operations", "0", "source"]) { $0[key] = changed }))
        }
        try refusedWrite(model(mutated(value, path: ["operations", "0", "after"]) { $0["payloadJSON"] = "{\"different\":1}" }))
        var changedBefore = try mutated(value, path: ["operations", "0", "before"]) { $0["payloadJSON"] = "{\"different\":1}" }
        changedBefore = try XCTUnwrap(edit(changedBefore, path: ["session", "checkpoint"][...]) { $0["payloadJSON"] = "{\"different\":1}" } as? [String: Any])
        try refusedWrite(model(changedBefore))
    }

    func testRetainedOpaqueStringsCannotChangeByUnicodeOrJSONReformatting() throws {
        var raw = try mutated(record([operation(1)]), path: ["operations", "0"]) { $0["preparedJSON"] = "{\"text\":\"é\"}" }
        let value = try model(raw)
        try store.write(value)
        raw = try mutated(value, path: ["operations", "0"]) { $0["preparedJSON"] = "{\"text\":\"e\u{301}\"}" }
        try refusedWrite(model(raw))
        try refusedWrite(model(mutated(value, path: ["operations", "0"]) { $0["requestJSON"] = "{ }" }))
    }

    func testExistingSessionAndOperationsCannotBeResetOrDropped() throws {
        let value = record([operation(1, phase: .checkpointed)])
        try store.write(value)
        let empty = Store.Record(session: value.session, operations: [])
        try refusedWrite(empty)
        let other = Store.Record(session: Store.Session(sessionID: discardID, taskID: "task-record", state: .active,
            checkpoint: EditorDraftSnapshot(sessionID: discardID, taskID: "task-record", generation: 1, payloadJSON: "{}")), operations: [])
        try refusedWrite(other)
        let beginDatabase = root.appendingPathComponent("unchanged-begin.sqlite"), begin = record()
        let beginStore = Store(databaseURL: beginDatabase)
        try beginStore.write(begin)
        let shifted = Store.Record(session: Store.Session(sessionID: sessionID, taskID: "task-record", state: .active, checkpoint: snapshot(2)), operations: [])
        let evidence = try Data(contentsOf: beginStore.url)
        refused { try beginStore.write(shifted) }
        refused { try beginStore.write(self.record([self.operation(2)])) }
        XCTAssertEqual(try Data(contentsOf: beginStore.url), evidence)
    }

    func testNonnullProofsCannotChangeOrDisappearAndPhasesCannotRegress() throws {
        let value = record([operation(1, phase: .stageFilled)])
        try store.write(value)
        try refusedWrite(record([operation(1, phase: .stagePrepared)]))
        try refusedWrite(model(mutated(value, path: ["operations", "0", "stage"]) { $0["uri"] = "file:///owned/new-stage" }))
        try refusedWrite(model(mutated(value, path: ["operations", "0", "stage"]) { $0["directoryIdentity"] = "1:99" }))
        var altered = try mutated(value, path: ["operations", "0", "stage"]) { $0["identity"] = "1:99" }
        altered = try XCTUnwrap(edit(altered, path: ["operations", "0", "filled"][...]) { $0["identity"] = "1:99" } as? [String: Any])
        try refusedWrite(model(altered))
        let completed = record([operation(1, phase: .checkpointed)])
        try cold().write(completed)
        try refusedWrite(record([operation(1, phase: .resultDurable)]))
        try refusedWrite(model(mutated(completed, path: ["operations", "0"]) { $0["replyJSON"] = "{\"different\":1}" }))
    }

    func testAppendRequiresPriorCheckpointedActiveStateAndAtMostOneNewOperation() throws {
        let before = record([operation(1)])
        try store.write(before)
        try refusedWrite(record([operation(1, phase: .checkpointed), operation(2)]))
        try cold().write(record([operation(1, phase: .checkpointed)]))
        try refusedWrite(record([operation(1, phase: .checkpointed), operation(2, phase: .checkpointed), operation(3)]))
        try cold().write(record([operation(1, phase: .checkpointed)], discardPhase: .decided))
        try refusedWrite(record([operation(1, phase: .checkpointed), operation(2)]))
    }

    func testDiscardDecisionIdentityReplyAndPhaseAreRetained() throws {
        let decided = record(discardPhase: .decided)
        try store.write(decided)
        try refusedWrite(record())
        try refusedWrite(model(mutated(decided, path: ["discard"]) { $0["requestId"] = self.operation(10).requestId }))
        try refusedWrite(model(mutated(decided, path: ["discard"]) { $0["requestJSON"] = "{\"different\":1}" }))
        let detached = record(discardPhase: .detached)
        try cold().write(detached)
        try refusedWrite(decided)
        try refusedWrite(model(mutated(detached, path: ["discard"]) { $0["replyJSON"] = "{\"different\":1}" }))
    }

    func testStoreNeverChangesSourceOrManagedBytesAndReportsOnlyFixedIOErrors() throws {
        let source = root.appendingPathComponent("sensitive-source"), target = root.appendingPathComponent("managed-target")
        let data = Data("private bytes + 世界".utf8)
        try data.write(to: source); try data.write(to: target)
        var activeObject = try mutated(record([operation(1, phase: .checkpointed)]), path: ["operations", "0"]) {
            $0["targetURI"] = target.absoluteString
        }
        activeObject = try XCTUnwrap(edit(activeObject, path: ["operations", "0", "source"][...]) {
            $0["sourceURI"] = source.absoluteString
        } as? [String: Any])
        let active = try model(activeObject)
        let detached = Store.Record(session: Store.Session(sessionID: sessionID, taskID: "task-record", state: .cleanupPending,
            checkpoint: active.session.checkpoint), operations: active.operations,
            discard: Store.Discard(requestId: discardID, requestJSON: "{}", expected: active.session.checkpoint,
                                   phase: .detached, replyJSON: "{}"))
        try store.write(active)
        try cold().write(detached)
        XCTAssertEqual(try Data(contentsOf: source), data)
        XCTAssertEqual(try Data(contentsOf: target), data)
        XCTAssertNotNil(try cold().read())
        if geteuid() == 0 { throw XCTSkip("Permission IO check requires an unprivileged account") }
        guard Darwin.chmod(root.path, mode_t(0o500)) == 0 else { throw StoreError.io }
        defer { _ = Darwin.chmod(root.path, mode_t(0o700)) }
        refused({ try self.cold().write(detached) }, expected: .io)
    }
}
