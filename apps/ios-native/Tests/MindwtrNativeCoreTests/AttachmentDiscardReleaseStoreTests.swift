import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore


final class AttachmentDiscardReleaseStoreTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private typealias StoreError = NativeAttachmentDraftStoreError
    private var root: URL!
    private var database: URL!
    private var store: Store!
    private let sessionID = "550e8400-e29b-41d4-a716-446655440000"
    private let discardID = "550e8400-e29b-41d4-a716-999999999999"
    private let sha = String(repeating: "a", count: 64)
    private let phases: [Store.Phase] = [.intent, .stagePrepared, .stageFilled, .published, .resultDurable, .checkpointed]

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task242-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw StoreError.corrupt }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        database = root.appendingPathComponent("library.sqlite")
        store = Store(databaseURL: database)
    }
    override func tearDownWithError() throws {
        if let root { _ = Darwin.chmod(root.path, mode_t(0o700)); try FileManager.default.removeItem(at: root) }
    }
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func snapshot(_ generation: Int, payload: String? = nil) -> EditorDraftSnapshot {
        .init(sessionID: sessionID, taskID: "task-café", generation: generation,
              payloadJSON: payload ?? "{\"generation\":\(generation),\"raw\":\"é / 文\"}")
    }
    private func operation(_ generation: Int, phase: Store.Phase = .checkpointed,
                           reason: Store.Reason? = nil, prepared: String = "{\"prepared\":\"é / 文\"}") -> Store.Operation {
        let inode = "1:\(20 + generation)"
        return .init(requestId: String(format: "550e8400-e29b-41d4-a716-%012d", generation),
            requestJSON: "{\"request\":\"é / 文\"}", phase: phase, reason: reason,
            before: snapshot(generation), after: snapshot(generation + 1), preparedJSON: prepared,
            targetURI: root.appendingPathComponent("published-\(generation)").absoluteString,
            source: .init(sourceURI: root.appendingPathComponent("source-cache").absoluteString,
                sha256: sha, size: 12, identity: "1:11", cacheRootIdentity: "1:12", parentIdentity: "1:13"),
            stage: phase.rank >= 1 ? .init(uri: root.appendingPathComponent("private-\(generation)/stage").absoluteString,
                identity: inode, directoryIdentity: "1:30", privateDirectoryIdentity: "1:\(40 + generation)") : nil,
            filled: phase.rank >= 2 ? .init(sha256: sha, size: 12, identity: inode) : nil,
            published: phase.rank >= 3 ? .init(sha256: sha, size: 12, identity: inode, directoryIdentity: "1:30") : nil,
            replyJSON: phase.rank >= 4 ? "{\"reply\":\"é / 文\"}" : nil)
    }
    private func record(version: Int = 2, operations: [Store.Operation]? = nil,
                        phase: Store.DiscardPhase? = .detached,
                        checkpoint: EditorDraftSnapshot? = nil) throws -> Store.Record {
        let operations = operations ?? [operation(1)]
        let checkpoint = checkpoint ?? operations.last.map { $0.phase == .checkpointed ? $0.after : $0.before } ?? snapshot(1)
        let discard: Store.Discard?
        if let phase {
            discard = .init(requestId: discardID,
                requestJSON: try json(["version": 1, "requestId": discardID, "sessionID": checkpoint.sessionID, "generation": checkpoint.generation]),
                expected: checkpoint, phase: phase,
                replyJSON: phase == .detached ? try json(["version": 1, "status": "cleanupPending", "requestId": discardID, "sessionID": checkpoint.sessionID]) : nil)
        } else { discard = nil }
        return .init(version: version,
            session: .init(sessionID: checkpoint.sessionID, taskID: checkpoint.taskID,
                state: phase == nil ? .active : .cleanupPending, checkpoint: checkpoint),
            operations: operations, discard: discard)
    }
    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
    private func object(_ value: Store.Record) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: encoded(value)) as? [String: Any])
    }
    private func model(_ value: [String: Any]) throws -> Store.Record {
        try JSONDecoder().decode(Store.Record.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func setting(_ value: Any, path: ArraySlice<String>, to replacement: Any) throws -> Any {
        guard let first = path.first else { return replacement }
        if var array = value as? [Any], let index = Int(first) {
            array[index] = try setting(array[index], path: path.dropFirst(), to: replacement); return array
        }
        var object = try XCTUnwrap(value as? [String: Any])
        object[first] = try setting(XCTUnwrap(object[first]), path: path.dropFirst(), to: replacement)
        return object
    }
    private func changed(_ base: Store.Record, _ changes: [([String], Any)]) throws -> Store.Record {
        var value: Any = try object(base)
        for (path, replacement) in changes { value = try setting(value, path: path[...], to: replacement) }
        return try model(XCTUnwrap(value as? [String: Any]))
    }
    private func identity(_ url: URL) throws -> String {
        var info = stat()
        guard Darwin.lstat(url.path, &info) == 0 else { throw StoreError.io }
        return "\(UInt64(info.st_dev)):\(UInt64(info.st_ino))"
    }
    private func retained(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) throws {
        let bytes = try Data(contentsOf: store.url), inode = try identity(store.url)
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertFalse(error.localizedDescription.contains(root.path), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("café"), file: file, line: line)
        }
        XCTAssertEqual(try Data(contentsOf: store.url), bytes, file: file, line: line)
        XCTAssertEqual(try identity(store.url), inode, file: file, line: line)
    }

    func testPureCanonicalFullFingerprintIsStableAcrossColdDecodeAndOuterKeyOrder() throws {
        let value = try record(), fingerprint = try Store.ownedDiscardFingerprint(value)
        XCTAssertEqual(fingerprint.count, 64)
        XCTAssertTrue(fingerprint.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
        let expected = SHA256.hash(data: try encoded(value)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(fingerprint, expected)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        let pretty = try JSONSerialization.data(withJSONObject: object(value), options: [.prettyPrinted, .sortedKeys])
        try pretty.write(to: store.url)
        let bytes = try Data(contentsOf: store.url), inode = try identity(store.url)
        XCTAssertEqual(try Store.ownedDiscardFingerprint(XCTUnwrap(Store(databaseURL: database).read())), fingerprint)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try identity(store.url), inode)
    }

    func testBothVersionsZeroMultipleAndEveryInterruptedOperationPhaseCanReleaseExactly() throws {
        for version in [1, 2] {
            var records = [try record(version: version, operations: [])]
            for phase in phases {
                let reason: Store.Reason? = phase == .checkpointed ? nil : (phase == .intent ? .interruptedReservation : .io)
                records.append(try record(version: version, operations: [operation(1, phase: phase, reason: reason)]))
                records.append(try record(version: version, operations: [operation(1), operation(2, phase: phase, reason: reason)]))
            }
            for value in records {
                let localDatabase = root.appendingPathComponent(UUID().uuidString + ".sqlite")
                let local = Store(databaseURL: localDatabase)
                let fingerprint = try Store.ownedDiscardFingerprint(value)
                try local.write(value)
                XCTAssertEqual(try Store.ownedDiscardFingerprint(XCTUnwrap(Store(databaseURL: localDatabase).read())), fingerprint)
                try local.releaseDiscardedAddsMatching(fingerprint: fingerprint)
                try local.releaseDiscardedAddsMatching(fingerprint: fingerprint)
                XCTAssertFalse(FileManager.default.fileExists(atPath: local.url.path))
            }
        }
    }

    func testV2DetachedOrdinaryGenerationGapIsBoundAndAccepted() throws {
        let value = try record(checkpoint: snapshot(19, payload: "\n {\"opaque\":\"later raw / 文\"}\n"))
        let fingerprint = try Store.ownedDiscardFingerprint(value)
        try store.write(value)
        XCTAssertEqual(try Store.ownedDiscardFingerprint(XCTUnwrap(store.read())), fingerprint)
        try store.releaseDiscardedAddsMatching(fingerprint: fingerprint)
        XCTAssertNil(try store.read())
    }

    func testActiveDecidedAdvanceAndUnknownVersionsNeverGainDiscardRelease() throws {
        let detached = try record(), fingerprint = try Store.ownedDiscardFingerprint(detached)
        let active = try record(phase: nil), decided = try record(phase: .decided)
        let advance = Store.Record(version: 2, session: active.session, operations: active.operations,
            checkpointAdvance: .init(before: active.session.checkpoint, after: snapshot(9)))
        let invalidDetachedAdvance = Store.Record(version: 2, session: detached.session, operations: detached.operations,
            discard: detached.discard, checkpointAdvance: .init(before: detached.session.checkpoint, after: snapshot(9)))
        XCTAssertThrowsError(try Store.ownedDiscardFingerprint(invalidDetachedAdvance))
        XCTAssertThrowsError(try Store.ownedDiscardFingerprint(Store.Record(version: 3, session: detached.session,
            operations: detached.operations, discard: detached.discard)))
        for value in [active, decided, advance] {
            try encoded(value).write(to: store.url)
            XCTAssertNotNil(try store.read())
            XCTAssertThrowsError(try Store.ownedDiscardFingerprint(value))
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testRequestExactShapeTypesAndStoredIdentityAreMandatoryWithoutChangingGeneralReader() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base)
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(base.discard).requestJSON.utf8)) as? [String: Any])
        var variants: [[String: Any]] = []
        let replacements: [(String, Any)] = [("version", true), ("version", 2), ("version", "1"),
            ("requestId", sessionID), ("sessionID", discardID), ("generation", 3), ("generation", true),
            ("generation", "2"), ("generation", 2.5)]
        for (field, replacement) in replacements {
            var value = request; value[field] = replacement; variants.append(value)
        }
        for field in request.keys { var value = request; value.removeValue(forKey: field); variants.append(value) }
        var unknown = request; unknown["unexpected"] = 1; variants.append(unknown)
        for variant in variants {
            let value = try changed(base, [(["discard", "requestJSON"], json(variant))])
            try encoded(value).write(to: store.url); XCTAssertNotNil(try store.read())
            XCTAssertThrowsError(try Store.ownedDiscardFingerprint(value))
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testReplyExactShapeTypesAndCleanupPendingIdentityAreMandatory() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base)
        let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(base.discard?.replyJSON).utf8)) as? [String: Any])
        var variants: [[String: Any]] = []
        let replacements: [(String, Any)] = [("version", true), ("version", 2), ("version", "1"),
            ("status", "confirmed"), ("requestId", sessionID), ("sessionID", discardID)]
        for (field, replacement) in replacements {
            var value = reply; value[field] = replacement; variants.append(value)
        }
        for field in reply.keys { var value = reply; value.removeValue(forKey: field); variants.append(value) }
        var unknown = reply; unknown["unexpected"] = 1; variants.append(unknown)
        for variant in variants {
            let value = try changed(base, [(["discard", "replyJSON"], json(variant))])
            try encoded(value).write(to: store.url); XCTAssertNotNil(try store.read())
            XCTAssertThrowsError(try Store.ownedDiscardFingerprint(value))
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testEveryRetainedOperationProofAndOpaqueFieldParticipatesInFullHash() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base), op = ["operations", "0"]
        let changes: [[([String], Any)]] = [
            [(op + ["requestId"], "550e8400-e29b-41d4-a716-555555555555")],
            [(op + ["requestJSON"], "{ \"request\" : \"é / 文\" }")],
            [(op + ["preparedJSON"], "{\"prepared\":\"different raw\"}")],
            [(op + ["before", "payloadJSON"], "{\"raw\":\"different before\"}")],
            [(op + ["targetURI"], root.appendingPathComponent("other-target").absoluteString)],
            [(op + ["source", "sourceURI"], root.appendingPathComponent("other-source").absoluteString)],
            [(op + ["source", "identity"], "2:100")], [(op + ["source", "cacheRootIdentity"], "2:101")],
            [(op + ["source", "parentIdentity"], "2:102")],
            [(op + ["source", "sha256"], String(repeating: "b", count: 64)),
             (op + ["filled", "sha256"], String(repeating: "b", count: 64)),
             (op + ["published", "sha256"], String(repeating: "b", count: 64))],
            [(op + ["source", "size"], 13), (op + ["filled", "size"], 13), (op + ["published", "size"], 13)],
            [(op + ["stage", "uri"], root.appendingPathComponent("other-private/stage").absoluteString)],
            [(op + ["stage", "identity"], "2:103"), (op + ["filled", "identity"], "2:103"), (op + ["published", "identity"], "2:103")],
            [(op + ["stage", "directoryIdentity"], "2:104"), (op + ["published", "directoryIdentity"], "2:104")],
            [(op + ["stage", "privateDirectoryIdentity"], "2:105")],
            [(op + ["replyJSON"], "{\"reply\":\"different reply\"}")],
            [(["session", "checkpoint", "payloadJSON"], "{\"raw\":\"different after\"}"),
             (op + ["after", "payloadJSON"], "{\"raw\":\"different after\"}"),
             (["discard", "expected", "payloadJSON"], "{\"raw\":\"different after\"}")],
            [(["discard", "requestJSON"], " \n" + (try XCTUnwrap(base.discard).requestJSON) + "\n")],
            [(["discard", "replyJSON"], " \n" + (try XCTUnwrap(base.discard?.replyJSON)) + "\n")]
        ]
        for edits in changes {
            let value = try changed(base, edits)
            XCTAssertNotEqual(try Store.ownedDiscardFingerprint(value), fingerprint)
            try encoded(value).write(to: store.url)
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
        let interrupted = try record(operations: [operation(1, phase: .intent, reason: .interruptedReservation)])
        let differentReason = try record(operations: [operation(1, phase: .intent, reason: .io)])
        XCTAssertNotEqual(try Store.ownedDiscardFingerprint(interrupted), try Store.ownedDiscardFingerprint(differentReason))
        XCTAssertNotEqual(try Store.ownedDiscardFingerprint(record(version: 1)), fingerprint)
        XCTAssertNotEqual(try Store.ownedDiscardFingerprint(record(operations: [])), fingerprint)
    }

    func testCoherentDiscardIdentityGenerationAndTaskBindingsChangeHash() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base), alternate = "550e8400-e29b-41d4-a716-888888888888"
        let newRequest = try json(["version": 1, "requestId": alternate, "sessionID": sessionID, "generation": 2])
        let newReply = try json(["version": 1, "status": "cleanupPending", "requestId": alternate, "sessionID": sessionID])
        let changedID = try changed(base, [(["discard", "requestId"], alternate),
            (["discard", "requestJSON"], newRequest), (["discard", "replyJSON"], newReply)])
        let changedGeneration = try record(checkpoint: snapshot(19))
        let taskPaths = [["session", "taskID"], ["session", "checkpoint", "taskID"],
            ["operations", "0", "before", "taskID"], ["operations", "0", "after", "taskID"], ["discard", "expected", "taskID"]]
        let task = try changed(base, taskPaths.map { ($0, "other-task" as Any) })
        let sessionPaths = [["session", "sessionID"], ["session", "checkpoint", "sessionID"],
            ["operations", "0", "before", "sessionID"], ["operations", "0", "after", "sessionID"], ["discard", "expected", "sessionID"]]
        let session = try changed(base, sessionPaths.map { ($0, alternate as Any) } + [
            (["discard", "requestJSON"], try json(["version": 1, "requestId": discardID, "sessionID": alternate, "generation": 2])),
            (["discard", "replyJSON"], try json(["version": 1, "status": "cleanupPending", "requestId": discardID, "sessionID": alternate]))])
        for value in [changedID, changedGeneration, task, session] {
            XCTAssertNotEqual(try Store.ownedDiscardFingerprint(value), fingerprint)
            try encoded(value).write(to: store.url)
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testUnicodeEquivalentOpaqueValuesRemainDistinctExactHashesAndReleaseRefuses() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base), op = ["operations", "0"]
        let equivalent: [[([String], Any)]] = [
            [(op + ["requestJSON"], "{\"request\":\"e\u{301} / 文\"}")],
            [(op + ["preparedJSON"], "{\"prepared\":\"e\u{301} / 文\"}")],
            [(op + ["before", "payloadJSON"], snapshot(1).payloadJSON.replacingOccurrences(of: "é", with: "e\u{301}"))],
            [(op + ["replyJSON"], "{\"reply\":\"e\u{301} / 文\"}")],
            [(["session", "checkpoint", "payloadJSON"], snapshot(2).payloadJSON.replacingOccurrences(of: "é", with: "e\u{301}")),
             (op + ["after", "payloadJSON"], snapshot(2).payloadJSON.replacingOccurrences(of: "é", with: "e\u{301}")),
             (["discard", "expected", "payloadJSON"], snapshot(2).payloadJSON.replacingOccurrences(of: "é", with: "e\u{301}"))],
            [["session", "taskID"], ["session", "checkpoint", "taskID"], op + ["before", "taskID"],
             op + ["after", "taskID"], ["discard", "expected", "taskID"]].map { ($0, "task-cafe\u{301}" as Any) }
        ]
        for edits in equivalent {
            let value = try changed(base, edits)
            XCTAssertEqual(value, base)
            XCTAssertNotEqual(try Store.ownedDiscardFingerprint(value), fingerprint)
            try encoded(value).write(to: store.url)
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testOpaqueDiscardRequestAndReplySpellingIsValidatedButNeverNormalizedBeforeHash() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base)
        let originalRequest = try XCTUnwrap(base.discard).requestJSON
        let originalReply = try XCTUnwrap(base.discard?.replyJSON)
        let variants: [[([String], Any)]] = [[(["discard", "requestJSON"], originalRequest.replacingOccurrences(of: "\"version\"", with: "\"\\u0076ersion\""))],
            [(["discard", "replyJSON"], originalReply.replacingOccurrences(of: "cleanupPending", with: "\\u0063leanupPending"))]]
        for edits in variants {
            let value = try changed(base, edits)
            XCTAssertNotEqual(try Store.ownedDiscardFingerprint(value), fingerprint)
            try encoded(value).write(to: store.url)
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testMalformedFingerprintCannotRemovePresentOrConfirmMissingRecord() throws {
        let value = try record()
        try store.write(value)
        for fingerprint in ["", String(repeating: "a", count: 63), String(repeating: "A", count: 64), String(repeating: "g", count: 64)] {
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
        try store.releaseDiscardedAddsMatching(fingerprint: Store.ownedDiscardFingerprint(value))
        for fingerprint in ["", String(repeating: "A", count: 64)] {
            XCTAssertThrowsError(try store.releaseDiscardedAddsMatching(fingerprint: fingerprint))
        }
    }

    func testExactColdReleaseAndMissingRetryPreserveDatabaseEditorAndAllFileSentinels() throws {
        let value = try record(), fingerprint = try Store.ownedDiscardFingerprint(value)
        let files = [try XCTUnwrap(database), root.appendingPathComponent("source-cache"),
            root.appendingPathComponent("published-1"), root.appendingPathComponent("private-1/stage"),
            EditorDraftStore(databaseURL: database).url]
        for file in files {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("sentinel \(file.lastPathComponent)".utf8).write(to: file)
        }
        let bytes = try files.map { try Data(contentsOf: $0) }, inodes = try files.map { try identity($0) }
        try store.write(value)
        var info = stat(); XCTAssertEqual(Darwin.lstat(store.url.path, &info), 0)
        XCTAssertEqual(info.st_mode & mode_t(0o777), mode_t(0o600))
        XCTAssertEqual(try store.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let cold = Store(databaseURL: database)
        try cold.releaseDiscardedAddsMatching(fingerprint: fingerprint)
        try cold.releaseDiscardedAddsMatching(fingerprint: fingerprint)
        XCTAssertNil(try cold.read())
        for index in files.indices {
            XCTAssertEqual(try Data(contentsOf: files[index]), bytes[index]); XCTAssertEqual(try identity(files[index]), inodes[index])
        }
    }

    func testMissingReleaseRequiresParentDurabilityAndNeverRecreatesParent() throws {
        let fingerprint = try Store.ownedDiscardFingerprint(record())
        let parent = root.appendingPathComponent("missing-parent", isDirectory: true)
        let absent = Store(databaseURL: parent.appendingPathComponent("library.sqlite"))
        XCTAssertThrowsError(try absent.releaseDiscardedAddsMatching(fingerprint: fingerprint)) {
            XCTAssertEqual($0 as? StoreError, .io)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: parent.path))
        try store.releaseDiscardedAddsMatching(fingerprint: fingerprint)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    func testCorruptUnknownSchemaAndMismatchedCheckpointArePreserved() throws {
        let base = try record(), fingerprint = try Store.ownedDiscardFingerprint(base)
        var unknown = try object(base); unknown["unexpected"] = true
        let differentExpected = try changed(base, [(["discard", "expected", "payloadJSON"], "{\"foreign\":\"checkpoint\"}")])
        for bytes in [Data("corrupt retained evidence".utf8), try JSONSerialization.data(withJSONObject: unknown), try encoded(differentExpected)] {
            try bytes.write(to: store.url)
            try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        }
    }

    func testFIFOAndDirectoryEntriesRefuseWithoutBlockingOrUnlinking() throws {
        let fingerprint = try Store.ownedDiscardFingerprint(record())
        XCTAssertEqual(Darwin.mkfifo(store.url.path, mode_t(0o600)), 0)
        let fifo = try identity(store.url), start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try store.releaseDiscardedAddsMatching(fingerprint: fingerprint))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2); XCTAssertEqual(try identity(store.url), fifo)
        try FileManager.default.removeItem(at: store.url)
        try FileManager.default.createDirectory(at: store.url, withIntermediateDirectories: false)
        let sentinel = store.url.appendingPathComponent("unrelated"); try Data("directory sentinel".utf8).write(to: sentinel)
        let directory = try identity(store.url)
        XCTAssertThrowsError(try store.releaseDiscardedAddsMatching(fingerprint: fingerprint))
        XCTAssertEqual(try identity(store.url), directory); XCTAssertEqual(try Data(contentsOf: sentinel), Data("directory sentinel".utf8))
    }

    func testSymlinkAndDanglingSymlinkNeverAuthorizeReleaseOrTouchDestination() throws {
        let value = try record(), fingerprint = try Store.ownedDiscardFingerprint(value)
        let target = root.appendingPathComponent("outside-record"), bytes = try encoded(value)
        try bytes.write(to: target); let inode = try identity(target)
        for destination in [target, root.appendingPathComponent("absent-destination")] {
            try FileManager.default.createSymbolicLink(at: store.url, withDestinationURL: destination)
            let link = try identity(store.url)
            XCTAssertThrowsError(try store.releaseDiscardedAddsMatching(fingerprint: fingerprint))
            XCTAssertEqual(try identity(store.url), link)
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: store.url.path), destination.path)
            XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try identity(target), inode)
            try FileManager.default.removeItem(at: store.url)
        }
    }

    func testActualEncodedOverflowRefusesEvenWhenOpaqueRawFieldsAreWithinBounds() throws {
        let prepared = "{\"raw\":\"" + String(repeating: "\\\\", count: 600_000) + "\"}"
        XCTAssertLessThan(prepared.utf8.count, 2 * 1024 * 1024)
        let operations = (1...4).map { operation($0, prepared: prepared) }
        let overflow = try record(operations: operations)
        XCTAssertGreaterThan(try encoded(overflow).count, Store.maximumBytes)
        XCTAssertThrowsError(try Store.ownedDiscardFingerprint(overflow))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    func testSavedFingerprintAndReleaseRemainSealedFromEveryDiscardedRecord() throws {
        let saved = try record(phase: nil), savedFingerprint = try Store.ownedSaveFingerprint(saved)
        XCTAssertThrowsError(try Store.ownedDiscardFingerprint(saved))
        try store.write(saved)
        try retained { try store.releaseDiscardedAddsMatching(fingerprint: savedFingerprint) }
        try store.releaseSavedAddsMatching(fingerprint: savedFingerprint)
        for version in [1, 2] {
            let discarded = try record(version: version), fingerprint = try Store.ownedDiscardFingerprint(discarded)
            try store.write(discarded)
            XCTAssertThrowsError(try Store.ownedSaveFingerprint(discarded))
            try retained { try store.releaseSavedAddsMatching(fingerprint: fingerprint) }
            try store.releaseDiscardedAddsMatching(fingerprint: fingerprint)
        }
    }

    func testActualReadAndUnlinkPermissionFailuresPreserveEvidenceThenColdRetrySucceeds() throws {
        if Darwin.geteuid() == 0 { throw XCTSkip("Actual permission refusal requires an unprivileged process") }
        let value = try record(), fingerprint = try Store.ownedDiscardFingerprint(value)
        try store.write(value)
        let bytes = try Data(contentsOf: store.url), inode = try identity(store.url)
        XCTAssertEqual(Darwin.chmod(store.url.path, mode_t(0o000)), 0)
        defer { _ = Darwin.chmod(store.url.path, mode_t(0o600)); _ = Darwin.chmod(root.path, mode_t(0o700)) }
        XCTAssertThrowsError(try store.releaseDiscardedAddsMatching(fingerprint: fingerprint)) { XCTAssertEqual($0 as? StoreError, .io) }
        XCTAssertEqual(Darwin.chmod(store.url.path, mode_t(0o600)), 0)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes); XCTAssertEqual(try identity(store.url), inode)
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o500)), 0)
        try retained { try store.releaseDiscardedAddsMatching(fingerprint: fingerprint) }
        XCTAssertEqual(Darwin.chmod(root.path, mode_t(0o700)), 0)
        try Store(databaseURL: database).releaseDiscardedAddsMatching(fingerprint: fingerprint)
        XCTAssertNil(try store.read())
    }
}
