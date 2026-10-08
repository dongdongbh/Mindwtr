import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

/// Local coordinated URLs, real descriptors, bundled JSC and the existing V3
/// owner. These tests do not establish external document-provider/UI acceptance.
final class NativeAttachmentProviderHostTests: XCTestCase {
    private typealias Store = NativeAttachmentDraftStore
    private var root: URL!
    private var bundle: URL!
    private var database: URL { root.appendingPathComponent("core.sqlite") }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private var managed: URL { root.appendingPathComponent("attachment-files/documents/attachments", isDirectory: true) }
    private var store: Store { .init(databaseURL: database) }
    private var editor: EditorDraftStore { .init(databaseURL: database) }
    private let taskID = "provider-task"
    private let at = "2026-10-05T12:00:00.000Z"
    override func setUpWithError() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else { throw XCTSkip("Set MINDWTR_CORE_BUNDLE to actual core-host.js") }
        bundle = URL(fileURLWithPath: path)
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = checkout.appendingPathComponent(".build/task267/\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(directory.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { free(physical) }; root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
    private func object(_ raw: String) throws -> [String: Any] { try XCTUnwrap(NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any]) }
    private func core(_ faults: HostIOFaults = HostIOFaults()) -> CoreHost {
        let host = CoreHost(databaseURL: database, bundleURL: bundle, faults: faults)
        addTeardownBlock { await host.close() }; return host
    }
    private func sql(_ statement: String, _ args: [Any] = []) throws -> String {
        let db = try SQLiteBridge(url: database); defer { db.close() }
        return try db.execute(statement, parametersJSON: json(args))
    }
    private func domain() throws -> String {
        // Only outer row/column encoding is canonical. JSON held in SQL text
        // cells remains opaque and is compared byte-for-byte as a String.
        try json(NativeJSON.jsonObject(with: Data(sql("SELECT * FROM tasks ORDER BY id").utf8)))
    }
    private func latest() throws -> EditorDraftSnapshot { try XCTUnwrap(editor.read()?.snapshot) }
    private func record() throws -> Store.MixedRecord { try XCTUnwrap(store.readMixed()) }
    private func lastAdd() throws -> Store.Operation {
        guard let last = try record().operations.last, case .add(let op) = last else { throw HostFailure("Fixture Add missing") }
        return op
    }
    private func payload() throws -> String {
        try json(["version": 2, "taskID": taskID, "tab": "task", "touchedBase": ["title": "Saved", "description": "Kept"],
            "edited": ["title": "Private draft", "description": "Opaque notes / e\u{301} / 文"],
            "raw": ["title": "Private draft", "note": "Opaque notes / e\u{301} / 文", "location": "", "estimate": "", "estimateResolved": "",
                "timeSpent": "", "timeSpentResolved": "", "tokens": [:], "tokenCanonical": [:], "tokenResolved": [:], "tokenEdited": [],
                "checklistInputs": [:], "checklistAppend": "", "relativeAmount": "", "relativeUnit": "", "relativeOwned": false,
                "relativeCommitRequested": false, "recurrenceInputs": [:], "recurrenceOwned": [], "recurrenceCommitRequested": []] as [String: Any],
            "scheduleEdits": [], "scheduleFailedID": NSNull(), "attachmentsOwned": true,
            "attachmentsBase": [], "attachments": [], "linkSheet": [:]] as [String: Any])
    }
    private func seed(begin: Bool = false, hooks: NativeAttachmentHostHooks? = nil,
                      faults: HostIOFaults = HostIOFaults()) async throws -> CoreHost {
        let boot = core(); _ = try await boot.start(); await boot.close()
        _ = try sql("INSERT INTO tasks(id,title,description,status,contexts,tags,attachments,createdAt,updatedAt,rev,revBy) VALUES (?,'Saved','Kept','inbox','[]','[]','[]',?,?,1,'fixture')", [taskID, at, at])
        let host = core(faults)
        if let hooks { try await host.configureAttachmentHost(hooks) }
        _ = try await host.start()
        let snapshot = EditorDraftSnapshot(sessionID: UUID().uuidString.lowercased(), taskID: taskID, generation: 1, payloadJSON: try payload())
        try await host.checkpointEditorDraft(snapshot)
        if begin { _ = try await host.beginAttachmentDraftV3(expectedSession: snapshot.sessionID, expectedGeneration: 1) }
        return host
    }
    private func selection(_ name: String = "Provider report.pdf", bytes: Data = Data("Provider bytes / 文".utf8)) throws -> URL {
        let directory = root.appendingPathComponent("provider", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name); try bytes.write(to: url); return url
    }
    private func cacheEntries() throws -> [URL] { try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil).sorted { $0.path < $1.path } }
    private func added(_ host: CoreHost, source: URL, id: String = UUID().uuidString.lowercased()) async throws -> [String: Any] {
        let before = try latest()
        return try object(await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
            expectedGeneration: before.generation, requestId: id))
    }
    private func refused(_ body: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await body(); XCTFail("Expected retained refusal", file: file, line: line) }
        catch { XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("Provider report"), file: file, line: line) }
    }
    private func boundary(_ point: AttachmentDraftBoundary, host: CoreHost, action: (() throws -> Void)? = nil) async {
        let hooks = AttachmentDraftHostHooks(); hooks.boundary = { if $0 == point {
            if let action { try action() } else { throw HostFailure("Private provider failure") }
        } }; await host.configureAttachmentDraftHost(hooks)
    }
    private func inode(_ url: URL) throws -> String {
        var value = stat(); guard lstat(url.path, &value) == 0 else { throw HostFailure("Fixture inode missing") }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func replaceExact(_ url: URL) throws {
        let bytes = try Data(contentsOf: url), old = try inode(url)
        try FileManager.default.moveItem(at: url, to: url.appendingPathExtension("retained"))
        try bytes.write(to: url); XCTAssertNotEqual(try inode(url), old)
    }
    private func isolate() throws -> URL {
        let previous = try XCTUnwrap(root), next = previous.appendingPathComponent(String(UUID().uuidString.prefix(8)), isDirectory: true)
        try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true); root = next; return previous
    }

    func testCoordinatedProviderAddUsesActualMetadataAndRetiresOnlyNewScratch() async throws {
        let host = try await seed(), before = try latest(), rows = try domain(), source = try selection()
        let bytes = try Data(contentsOf: source), foreign = cache.appendingPathComponent("borrowed-source.txt")
        try Data("foreign cache sentinel".utf8).write(to: foreign)
        let reply = try await added(host, source: source), op = try lastAdd()
        XCTAssertEqual(Set(reply.keys), Set(["version", "status", "requestId", "sessionID", "generation"]))
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(reply["generation"] as? Int, 2)
        XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(op.source.size, Int64(bytes.count))
        let picked = try XCTUnwrap(object(op.requestJSON)["picked"] as? [String: Any])
        XCTAssertEqual(picked["name"] as? String, source.lastPathComponent); XCTAssertEqual(picked["mimeType"] as? String, "application/pdf")
        XCTAssertEqual(picked["size"] as? Int, bytes.count); XCTAssertTrue(op.targetURI.hasSuffix(".pdf"))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try cacheEntries(), [foreign])
        XCTAssertEqual(try Data(contentsOf: foreign), Data("foreign cache sentinel".utf8))
        XCTAssertEqual(try latest(), op.after); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try object(latest().payloadJSON)["raw"].flatMap { ($0 as? [String: Any])?["note"] as? String },
                       try object(before.payloadJSON)["raw"].flatMap { ($0 as? [String: Any])?["note"] as? String })
    }

    func testSearchableProviderParentWithoutReadPermissionStillAddsExactFile() async throws {
        let host = try await seed(), before = try latest(), rows = try domain(), source = try selection()
        let bytes = try Data(contentsOf: source), sourceIdentity = try inode(source)
        let parent = source.deletingLastPathComponent()
        XCTAssertEqual(Darwin.chmod(parent.path, mode_t(0o111)), 0)
        defer { XCTAssertEqual(Darwin.chmod(parent.path, mode_t(0o755)), 0) }

        // This must run as the ordinary Mac test account: the parent cannot be
        // opened for directory reads, while the selected regular file can.
        let parentFD = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        let parentError = errno
        if parentFD >= 0 { Darwin.close(parentFD) }
        XCTAssertEqual(parentFD, -1); XCTAssertEqual(parentError, EACCES)
        let sourceFD = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK)
        XCTAssertGreaterThanOrEqual(sourceFD, 0)
        if sourceFD >= 0 { Darwin.close(sourceFD) }

        let reply = try await added(host, source: source), op = try lastAdd()
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(reply["generation"] as? Int, 2)
        XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(op.source.size, Int64(bytes.count))
        let picked = try XCTUnwrap(object(op.requestJSON)["picked"] as? [String: Any])
        XCTAssertEqual(picked["name"] as? String, source.lastPathComponent)
        XCTAssertEqual(picked["mimeType"] as? String, "application/pdf"); XCTAssertEqual(picked["size"] as? Int, bytes.count)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertEqual(try inode(source), sourceIdentity)
        XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try latest(), op.after); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(before.generation, 1)
    }

    func testEditorAcknowledgmentFacadeForcesFiveBoundedLogMarkersWithDebugLoggingOff() async throws {
        let host = try await seed()
        let settings = try object(await host.call("menuRead", argumentsJSON: json(["dataSettings", "{}"])))
        let diagnostics = try XCTUnwrap(settings["diagnostics"] as? [String: Any])
        let debugLogging = try XCTUnwrap(diagnostics["debugLogging"] as? [String: Any])
        XCTAssertEqual(debugLogging["value"] as? Bool, false)

        let operations = ["add", "remove", "save", "discard", "recover"]
        for operation in operations { await host.recordEditorAttachmentAcknowledgment(operation: operation) }
        let log = root.appendingPathComponent("logs/mindwtr.log"), beforeInvalid = try Data(contentsOf: log)
        await host.recordEditorAttachmentAcknowledgment(operation: "invalid-operation")
        XCTAssertEqual(try Data(contentsOf: log), beforeInvalid)

        let rows = try String(decoding: beforeInvalid, as: UTF8.self).split(separator: "\n").map { try object(String($0)) }
        let slug = "v1.3.5/ios-editor-owned-attachments"
        let markers = rows.filter { ($0["context"] as? [String: Any])?["releaseCheck"] as? String == slug }
        XCTAssertEqual(markers.count, operations.count)
        for (marker, operation) in zip(markers, operations) {
            XCTAssertEqual(marker["level"] as? String, "info"); XCTAssertEqual(marker["scope"] as? String, "native-ios")
            XCTAssertEqual(marker["message"] as? String, "Native iOS attachment draft acknowledged")
            let context = try XCTUnwrap(marker["context"] as? [String: Any])
            XCTAssertEqual(Set(context.keys), Set(["releaseCheck", "operation", "outcome"]))
            XCTAssertEqual(context["releaseCheck"] as? String, slug)
            XCTAssertEqual(context["operation"] as? String, operation); XCTAssertEqual(context["outcome"] as? String, "confirmed")
        }
        XCTAssertFalse(String(decoding: beforeInvalid, as: UTF8.self).contains("invalid-operation"))
    }

    func testZeroAndExact50MiBUseStreamingWhileOversizeKeepsEmptyOwner() async throws {
        for size in [0, Int(NativeAttachmentFiles.maximumProviderBytes), Int(NativeAttachmentFiles.maximumProviderBytes) + 1] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), before = try latest(), rows = try domain()
            let source = try selection("Actual.bin", bytes: Data(repeating: 0x61, count: size))
            if size <= Int(NativeAttachmentFiles.maximumProviderBytes) {
                let reply = try await added(host, source: source), op = try lastAdd()
                XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(op.source.size, Int64(size))
                XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))).count, size)
            } else {
                await refused { _ = try await self.added(host, source: source) }
                XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before)
            }
            XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try domain(), rows)
            XCTAssertEqual(try Data(contentsOf: source).count, size); await host.close()
        }
    }

    func testDirectReceiptIsProofBoundPrivateAndRetirementRetainsReplacement() throws {
        let files = try NativeAttachmentFiles(libraryRoot: root), source = try selection("Unknown.mindwtr-unknown-extension")
        let receipt = try files.copyProviderSource(source, checkCancellation: {})
        XCTAssertEqual(receipt.fileName, source.lastPathComponent); XCTAssertNil(receipt.mimeType)
        let scratch = try XCTUnwrap(URL(string: receipt.sourceURI)), original = try Data(contentsOf: source)
        XCTAssertEqual(try Data(contentsOf: scratch), original); XCTAssertEqual(receipt.size, Int64(original.count))
        XCTAssertEqual(scratch.pathExtension, ""); XCTAssertNotNil(UUID(uuidString: scratch.lastPathComponent))
        XCTAssertEqual(try scratch.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        var info = stat(); XCTAssertEqual(lstat(scratch.path, &info), 0); XCTAssertEqual(info.st_mode & 0o777, 0o600)
        let proof = try files.snapshotCacheSource(receipt.sourceURI); XCTAssertTrue(receipt.matches(proof))
        XCTAssertEqual(proof.sha256, SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined())
        try replaceExact(scratch)
        XCTAssertThrowsError(try files.requireProviderSource(receipt))
        XCTAssertEqual(try files.retireProviderSource(receipt, checkCancellation: {}), .generationChanged)
        XCTAssertEqual(try Data(contentsOf: scratch), original); XCTAssertEqual(try Data(contentsOf: source), original)
    }

    func testProviderSourceSymlinkHardlinkGrowthAndRootReplacementRefuseWithoutForeignUnlink() throws {
        for kind in ["symlink", "ancestor-symlink", "hardlink", "growth", "root"] {
            let previous = try isolate(); defer { root = previous }
            let files = try NativeAttachmentFiles(libraryRoot: root), source = try selection(), bytes = try Data(contentsOf: source)
            var selected = source
            if kind == "symlink" {
                selected = source.appendingPathExtension("alias"); try FileManager.default.createSymbolicLink(at: selected, withDestinationURL: source)
            } else if kind == "ancestor-symlink" {
                let alias = root.appendingPathComponent("provider-alias", isDirectory: true)
                try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: source.deletingLastPathComponent())
                selected = alias.appendingPathComponent(source.lastPathComponent)
            } else if kind == "hardlink" {
                selected = source.appendingPathExtension("link"); try FileManager.default.linkItem(at: source, to: selected)
            } else if kind == "growth" {
                files.afterSourceOpened = { try (bytes + Data("growth".utf8)).write(to: source) }
            } else {
                files.beforePublish = {
                    try FileManager.default.moveItem(at: self.cache, to: self.cache.appendingPathExtension("retained"))
                    try FileManager.default.createDirectory(at: self.cache, withIntermediateDirectories: false)
                    try Data("foreign cache".utf8).write(to: self.cache.appendingPathComponent("foreign"))
                }
            }
            XCTAssertThrowsError(try files.copyProviderSource(selected, checkCancellation: {}))
            if kind == "root" { XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("foreign")), Data("foreign cache".utf8)) }
            else { XCTAssertTrue(try cacheEntries().isEmpty) }
            if kind != "growth" { XCTAssertEqual(try Data(contentsOf: source), bytes) }
        }
    }

    func testSourceAndCreatedScratchReplacementDuringCopyDoNotAdoptOrDeleteForeignGeneration() throws {
        for kind in ["source", "parent", "scratch"] {
            let previous = try isolate(); defer { root = previous }
            let files = try NativeAttachmentFiles(libraryRoot: root), source = try selection(), bytes = try Data(contentsOf: source)
            let sourceIdentity = try inode(source)
            var changed: URL?, retainedSource: URL?, parentSentinel: URL?
            if kind == "source" { files.afterSourceOpened = { try self.replaceExact(source) } }
            else if kind == "parent" { files.afterSourceOpened = {
                let parent = source.deletingLastPathComponent(), oldParentIdentity = try self.inode(parent)
                let retainedParent = parent.appendingPathExtension("retained")
                try FileManager.default.moveItem(at: parent, to: retainedParent)
                retainedSource = retainedParent.appendingPathComponent(source.lastPathComponent)
                try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
                try bytes.write(to: source)
                let sentinel = parent.appendingPathComponent("foreign-sentinel")
                try Data("foreign provider parent".utf8).write(to: sentinel); parentSentinel = sentinel
                XCTAssertNotEqual(try self.inode(parent), oldParentIdentity)
                XCTAssertNotEqual(try self.inode(source), sourceIdentity)
            } }
            else { files.beforePublish = { let partial = try XCTUnwrap(self.cacheEntries().first); changed = partial; try self.replaceExact(partial) } }
            XCTAssertThrowsError(try files.copyProviderSource(source, checkCancellation: {}))
            XCTAssertEqual(try Data(contentsOf: source), bytes)
            if let retainedSource {
                XCTAssertEqual(try Data(contentsOf: retainedSource), bytes); XCTAssertEqual(try inode(retainedSource), sourceIdentity)
                XCTAssertEqual(try Data(contentsOf: XCTUnwrap(parentSentinel)), Data("foreign provider parent".utf8))
            }
            if let changed { XCTAssertEqual(try Data(contentsOf: changed), bytes) }
            else { XCTAssertTrue(try cacheEntries().isEmpty) }
        }
    }

    func testFreshCanonicalAdmissionAndRepeatedUUIDNeverRecopyProvider() async throws {
        let host = try await seed(), before = try latest(), source = try selection(), rows = try domain()
        for id in ["not-a-uuid", UUID().uuidString.uppercased()] {
            await refused { _ = try await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
                expectedGeneration: before.generation, requestId: id) }
            XCTAssertNil(try store.readVersioned()); XCTAssertTrue(try cacheEntries().isEmpty)
        }
        let id = UUID().uuidString.lowercased(); _ = try await added(host, source: source, id: id)
        let current = try latest(), retained = try Data(contentsOf: store.url), picked = try Data(contentsOf: source)
        await refused { _ = try await self.added(host, source: source, id: id) }
        XCTAssertEqual(try latest(), current); XCTAssertEqual(try Data(contentsOf: store.url), retained)
        XCTAssertEqual(try Data(contentsOf: source), picked); XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try domain(), rows)
    }

    func testExactEditorAndSidecarInodesAfterCopyFenceBeforeAddIntent() async throws {
        for kind in ["editor", "sidecar", "journal"] {
            let previous = try isolate(); defer { root = previous }
            let hooks = NativeAttachmentHostHooks(); hooks.configureJobs = { jobs in jobs.beforeFilePublish = {
                if kind == "journal" { try Data("foreign journal".utf8).write(to: self.database.appendingPathExtension("pending.json")) }
                else { try self.replaceExact(kind == "editor" ? self.editor.url : self.store.url) }
            } }
            let host = try await seed(begin: true, hooks: hooks), before = try latest(), source = try selection(), rows = try domain()
            await refused { _ = try await self.added(host, source: source) }
            XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before); XCTAssertEqual(try domain(), rows)
            XCTAssertEqual(try cacheEntries().count, 1) // Ambiguous owner evidence forbids scratch cleanup too.
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(cacheEntries().first)), try Data(contentsOf: source)); await host.close()
        }
    }

    func testNativeCreatedSourceFenceRunsAfterBeforeIntentHook() async throws {
        let host = try await seed(begin: true), before = try latest(), source = try selection(), rows = try domain()
        var replaced: URL?
        await boundary(.beforeIntent, host: host) {
            let scratch = try XCTUnwrap(self.cacheEntries().first); replaced = scratch; try self.replaceExact(scratch)
        }
        await refused { _ = try await self.added(host, source: source) }
        XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(replaced)), try Data(contentsOf: source))
    }

    func testInterruptedIntentAndStageFilledKeepBorrowedSourceAcrossColdRecovery() async throws {
        for point in [AttachmentDraftBoundary.afterIntent, .afterFilled] {
            let previous = try isolate(); defer { root = previous }
            let label = point == .afterIntent ? "afterIntent" : "afterFilled"
            var sourcePublicationReached = false
            let fileHooks = NativeAttachmentHostHooks()
            fileHooks.configureJobs = { jobs in jobs.beforeFilePublish = { sourcePublicationReached = true } }
            let host = try await seed(hooks: fileHooks), before = try latest(), source = try selection(), rows = try domain()
            var reached: [AttachmentDraftBoundary] = [], hits = 0
            let draftHooks = AttachmentDraftHostHooks()
            draftHooks.boundary = { actual in
                reached.append(actual)
                if actual == point { hits += 1; throw HostFailure("Private provider failure") }
            }
            await host.configureAttachmentDraftHost(draftHooks)
            var refusal: Error?
            await refused {
                do { _ = try await self.added(host, source: source) }
                catch { refusal = error; throw error }
            }
            let operationCount = (try? store.readMixed())?.operations.count
            let cacheCount = try? cacheEntries().count
            let trace = reached.map { String(describing: $0) }.joined(separator: ",")
            let failureType = refusal.map { String(describing: type(of: $0)) } ?? "none"
            let failureMessage = refusal?.localizedDescription ?? "none"
            XCTAssertEqual(hits, 1, "Provider fault \(label) not reached exactly once; boundaries=[\(trace)]; sourcePublication=\(sourcePublicationReached); errorType=\(failureType); error=\(failureMessage); operations=\(operationCount.map { String($0) } ?? "unavailable"); cache=\(cacheCount.map { String($0) } ?? "unavailable")")
            guard hits == 1 else { return }
            let op = try lastAdd(), scratch = try XCTUnwrap(URL(string: op.source.sourceURI))
            XCTAssertEqual(op.phase, point == .afterIntent ? .intent : .stageFilled)
            XCTAssertEqual(try Data(contentsOf: scratch), try Data(contentsOf: source)); XCTAssertEqual(try latest(), before)
            await refused { _ = try await self.added(host, source: source) }
            XCTAssertEqual(try record().operations.count, 1); XCTAssertEqual(try cacheEntries(), [scratch])
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID)
            XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertEqual(try Data(contentsOf: scratch), try Data(contentsOf: source))
            XCTAssertEqual(try domain(), rows); await cold.close()
        }
    }

    func testWarmExactRecoveryRetiresSourceWithoutAnotherProviderCopy() async throws {
        let host = try await seed(), before = try latest(), source = try selection(), id = UUID().uuidString.lowercased()
        await boundary(.afterFilled, host: host)
        await refused { _ = try await self.added(host, source: source, id: id) }
        let scratch = try XCTUnwrap(URL(string: lastAdd().source.sourceURI)), bytes = try Data(contentsOf: source)
        try FileManager.default.removeItem(at: source)
        await host.configureAttachmentDraftHost(AttachmentDraftHostHooks())
        _ = try await host.recoverAttachmentDraftV3(expectedSession: before.sessionID)
        XCTAssertEqual(try lastAdd().phase, .checkpointed); XCTAssertTrue(try cacheEntries().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.path))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: lastAdd().targetURI))), bytes)
    }

    func testCleanupFailureOrLostUnlinkAcknowledgmentCannotFailAcceptedAdd() async throws {
        for lostAck in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let hooks = NativeAttachmentHostHooks()
            hooks.configureJobs = { jobs in
                if lostAck { jobs.afterRetirementUnlink = { throw HostFailure("Private cleanup ACK lost") } }
                else { jobs.beforeRetirementUnlink = { throw HostFailure("Private cleanup refused") } }
            }
            let host = try await seed(hooks: hooks), source = try selection()
            let reply = try await added(host, source: source), op = try lastAdd()
            XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(op.phase, .checkpointed)
            XCTAssertEqual(try cacheEntries().count, lostAck ? 0 : 1)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))), try Data(contentsOf: source))
            await host.close(); let cold = core(); _ = try await cold.start()
            _ = try await cold.recoverAttachmentDraftV3(expectedSession: op.after.sessionID)
            XCTAssertEqual(try record().operations.count, 1); XCTAssertEqual(try cacheEntries().count, lostAck ? 0 : 1)
            await cold.close()
        }
    }

    func testCleanupFinalCallbackPreservesForeignEditorAndScratchAfterAcknowledgment() async throws {
        let hooks = NativeAttachmentHostHooks()
        var changed = false
        hooks.configureJobs = { jobs in jobs.beforeRetirementUnlink = { changed = true; try self.replaceExact(self.editor.url) } }
        let host = try await seed(hooks: hooks), source = try selection()
        let reply = try await added(host, source: source), op = try lastAdd()
        XCTAssertTrue(changed); XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(try latest(), op.after)
        XCTAssertEqual(try cacheEntries().count, 1); XCTAssertEqual(try Data(contentsOf: XCTUnwrap(cacheEntries().first)), try Data(contentsOf: source))
    }

    func testProviderDiagnosticRunsAfterCleanupAndPreservesForeignAcknowledgedEvidence() async throws {
        for editorFile in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let originalBundle = try XCTUnwrap(bundle), original = try String(contentsOf: originalBundle, encoding: .utf8)
            let probe = root.appendingPathComponent("marker-boundary-core-host.js")
            try (original + "\n;(()=>{const f=MindwtrHost.attachmentDraftAcknowledged;MindwtrHost.attachmentDraftAcknowledged=(operation,outcome)=>{if(operation==='provider-add'&&outcome==='confirmed')__mindwtrNative.sqlRun('SELECT 267 AS provider_marker_boundary','[]');return f(operation,outcome);};})();\n")
                .write(to: probe, atomically: true, encoding: .utf8)
            bundle = probe; defer { bundle = originalBundle }
            let faults = HostIOFaults(), host = try await seed(faults: faults), source = try selection(), rows = try domain()
            let file = editorFile ? editor.url : store.url
            var fired = false, foreignIdentity: String?, foreignBytes: Data?
            faults.beforeSQL = { statement in
                if statement == "SELECT 267 AS provider_marker_boundary" && !fired {
                    fired = true
                    XCTAssertTrue(try self.cacheEntries().isEmpty, "Scratch settlement must precede diagnostic JSC")
                    XCTAssertEqual(try self.lastAdd().phase, .checkpointed)
                    try self.replaceExact(file); foreignIdentity = try self.inode(file); foreignBytes = try Data(contentsOf: file)
                }
            }
            let reply = try await added(host, source: source), op = try lastAdd()
            XCTAssertTrue(fired); XCTAssertEqual(reply["status"] as? String, "added")
            XCTAssertEqual(try inode(file), try XCTUnwrap(foreignIdentity)); XCTAssertEqual(try Data(contentsOf: file), try XCTUnwrap(foreignBytes))
            XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try latest(), op.after); XCTAssertEqual(try domain(), rows)
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(URL(string: op.targetURI))), try Data(contentsOf: source))
            await host.close()
        }
    }

    func testUnknownPreIntentCopySurvivesHostRecreationWithoutFilenameSweep() async throws {
        let host = try await seed(), source = try selection(), files = try NativeAttachmentFiles(libraryRoot: root)
        let receipt = try files.copyProviderSource(source, checkCancellation: {}), scratch = try XCTUnwrap(URL(string: receipt.sourceURI))
        let bytes = try Data(contentsOf: scratch), identity = try inode(scratch), before = try latest()
        await host.close(); let cold = core(); _ = try await cold.start()
        XCTAssertEqual(try latest(), before); XCTAssertNil(try store.readVersioned())
        XCTAssertEqual(try Data(contentsOf: scratch), bytes); XCTAssertEqual(try inode(scratch), identity)
    }

    func testAlreadyCancelledTaskAndCancelledPartialCopyNeverSubmitAdd() async throws {
        let host = try await seed(), before = try latest(), source = try selection(), rows = try domain()
        let work = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
                expectedGeneration: before.generation, requestId: UUID().uuidString.lowercased())
        }
        await refused { _ = try await work.value }
        XCTAssertNil(try store.readVersioned()); XCTAssertEqual(try latest(), before); XCTAssertTrue(try cacheEntries().isEmpty)
        let files = try NativeAttachmentFiles(libraryRoot: root), token = NativeAttachmentCancellation()
        files.afterSourceOpened = { token.cancel() }
        // The existing native token throws a fixed Jobs error; provider IO
        // normalizes it to bounded refusal, rather than Swift CancellationError.
        XCTAssertThrowsError(try files.copyProviderSource(source, checkCancellation: token.check)) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, .unavailable)
        }
        XCTAssertTrue(token.isCancelled)
        XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try Data(contentsOf: source), Data("Provider bytes / 文".utf8))
    }

    func testCancellationDuringCopyAndBeforeIntentCleansOnlyExactUnsubmittedSource() async throws {
        for duringCopy in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let entered = expectation(description: "Native cancellation boundary \(duringCopy)"), release = DispatchSemaphore(value: 0)
            let hooks = NativeAttachmentHostHooks()
            if duringCopy { hooks.configureJobs = { jobs in jobs.beforeFilePublish = {
                entered.fulfill(); _ = release.wait(timeout: .now() + 10)
            } } }
            let host = try await seed(hooks: hooks), before = try latest(), source = try selection(), rows = try domain()
            if !duringCopy { await boundary(.beforeIntent, host: host) { entered.fulfill(); _ = release.wait(timeout: .now() + 10) } }
            let work = Task { try await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
                expectedGeneration: before.generation, requestId: UUID().uuidString.lowercased()) }
            await fulfillment(of: [entered], timeout: 10); work.cancel(); release.signal()
            await refused { _ = try await work.value }
            XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before)
            XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try domain(), rows); await host.close()
        }
    }

    func testPostCheckpointCancellationKeepsSourceUntilExactWarmOrColdRecovery() async throws {
        for coldRecovery in [false, true] {
            let previous = try isolate(); defer { root = previous }
            let host = try await seed(), before = try latest(), source = try selection(), rows = try domain()
            let entered = expectation(description: "Checkpoint marker \(coldRecovery)"), release = DispatchSemaphore(value: 0)
            await boundary(.afterMarker, host: host) { entered.fulfill(); _ = release.wait(timeout: .now() + 10) }
            let id = UUID().uuidString.lowercased()
            let work = Task { try await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
                expectedGeneration: before.generation, requestId: id) }
            await fulfillment(of: [entered], timeout: 10); work.cancel(); release.signal()
            await refused { _ = try await work.value }
            let op = try lastAdd(), scratch = try XCTUnwrap(URL(string: op.source.sourceURI))
            XCTAssertEqual(op.phase, .checkpointed); XCTAssertEqual(try latest(), op.after)
            XCTAssertEqual(try Data(contentsOf: scratch), try Data(contentsOf: source))
            await refused { _ = try await self.added(host, source: source, id: id) }
            let recovery: CoreHost
            if coldRecovery { await host.close(); recovery = core(); _ = try await recovery.start() }
            else { await host.configureAttachmentDraftHost(AttachmentDraftHostHooks()); recovery = host }
            _ = try await recovery.recoverAttachmentDraftV3(expectedSession: before.sessionID)
            XCTAssertEqual(try record().operations.count, 1); XCTAssertEqual(try latest(), op.after)
            XCTAssertEqual(FileManager.default.fileExists(atPath: scratch.path), coldRecovery)
            XCTAssertEqual(try domain(), rows); await recovery.close()
        }
    }

    func testCancellationDuringOptionalCleanupPreservesAlreadyAcknowledgedAdd() async throws {
        let entered = expectation(description: "Optional cleanup entered"), release = DispatchSemaphore(value: 0), hooks = NativeAttachmentHostHooks()
        hooks.configureJobs = { jobs in jobs.beforeRetirementUnlink = { entered.fulfill(); _ = release.wait(timeout: .now() + 10) } }
        let host = try await seed(hooks: hooks), before = try latest(), source = try selection()
        let work = Task { try await host.addProviderAttachmentV3(selectedURL: source, expectedSession: before.sessionID,
            expectedGeneration: before.generation, requestId: UUID().uuidString.lowercased()) }
        await fulfillment(of: [entered], timeout: 10); work.cancel(); release.signal()
        let reply = try object(await work.value)
        XCTAssertEqual(reply["status"] as? String, "added"); XCTAssertEqual(try lastAdd().phase, .checkpointed)
        XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try latest(), try lastAdd().after)
    }

    func testForeignTargetAtPublicationRetainsSourceStageAndExactPendingOperation() async throws {
        let host = try await seed(), before = try latest(), source = try selection(), rows = try domain()
        var target: URL?
        await boundary(.beforePublication, host: host) {
            let selected = try XCTUnwrap(URL(string: self.lastAdd().targetURI)); target = selected
            try Data("foreign target bytes".utf8).write(to: selected)
        }
        await refused { _ = try await self.added(host, source: source) }
        let op = try lastAdd(), scratch = try XCTUnwrap(URL(string: op.source.sourceURI))
        XCTAssertEqual(op.phase, .stageFilled); XCTAssertEqual(try latest(), before)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(target)), Data("foreign target bytes".utf8))
        XCTAssertEqual(try Data(contentsOf: scratch), try Data(contentsOf: source))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(URL(string: XCTUnwrap(op.stage?.uri))).path))
        await host.close(); let cold = core(); _ = try await cold.start()
        await refused { _ = try await cold.recoverAttachmentDraftV3(expectedSession: before.sessionID) }
        XCTAssertEqual(try lastAdd().requestId, op.requestId); XCTAssertEqual(try domain(), rows)
        XCTAssertEqual(try Data(contentsOf: scratch), try Data(contentsOf: source))
    }

    func testUnknownMimeKeepsOriginalNameAndSharedBlockedMimeRefusalCleansUnsubmittedCopy() async throws {
        let host = try await seed(), source = try selection("Actual.mindwtr-unknown-extension"), rows = try domain()
        _ = try await added(host, source: source)
        let picked = try XCTUnwrap(object(lastAdd().requestJSON)["picked"] as? [String: Any])
        XCTAssertEqual(picked["name"] as? String, source.lastPathComponent); XCTAssertTrue(picked["mimeType"] is NSNull)
        XCTAssertEqual(try domain(), rows); await host.close()
        let previous = try isolate(); defer { root = previous }
        // Force the shared policy input only: local provider metadata/proofs and
        // actual JSC validation remain real; no platform MIME mapping is claimed.
        let original = try String(contentsOf: bundle, encoding: .utf8)
        let probe = root.appendingPathComponent("blocked-policy-core-host.js")
        try (original + "\n;(()=>{const f=MindwtrHost.attachmentDraftPrepareV3;MindwtrHost.attachmentDraftPrepareV3=(raw)=>{const v=JSON.parse(raw);v.picked.mimeType='application/x-msdownload';return f(JSON.stringify(v));};})();\n")
            .write(to: probe, atomically: true, encoding: .utf8)
        let oldBundle = bundle; bundle = probe; defer { bundle = oldBundle }
        let blocked = try await seed(), before = try latest(), selected = try selection(), unchanged = try domain()
        await refused { _ = try await self.added(blocked, source: selected) }
        XCTAssertEqual(try record().operations.count, 0); XCTAssertEqual(try latest(), before)
        XCTAssertTrue(try cacheEntries().isEmpty); XCTAssertEqual(try domain(), unchanged)
    }
}
