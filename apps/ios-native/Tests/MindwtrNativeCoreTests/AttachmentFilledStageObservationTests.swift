import XCTest
import Foundation
import Darwin
import CryptoKit
import AttachmentFileInstallerEngine
@testable import MindwtrNativeCore

final class AttachmentFilledStageObservationTests: XCTestCase {
    private typealias StageProof = NativeAttachmentFiles.ReservedAttachmentStageProof
    private struct Fixture {
        let source: URL
        let target: URL
        let stage: URL
        let proof: StageProof
        let bytes: Data
    }
    private enum Cancelled: Error { case stopped }
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var cache: URL!

    override func setUpWithError() throws {

        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task249-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        let directories = try object(files.directoriesJSON)
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"] as? String)))
        try FileManager.default.createDirectory(at: files.managedRoot, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
    private func token(_ url: URL) throws -> String {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func fixture(_ bytes: Data = Data("owned + 世界".utf8)) throws -> Fixture {
        let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let source = cache.appendingPathComponent("source-\(id)")
        try bytes.write(to: source)
        let target = files.managedRoot.appendingPathComponent("target-\(id).bin")
        let installer = try AttachmentFileInstaller(targetRoot: files.managedRoot, sourceRoots: files.sourceRoots)
        let stage = try installer.prepareImmutableStage(targetInput: target, operationId: id)
        let proof = StageProof(stageURI: stage.stagedUrl.absoluteString, stagedIdentity: stage.stagedIdentity,
            directoryIdentity: stage.directoryIdentity, privateDirectoryIdentity: stage.privateDirectoryIdentity)
        let sourceProof = try files.snapshotCacheSource(source.absoluteString)
        _ = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        return Fixture(source: source, target: target, stage: stage.stagedUrl, proof: proof, bytes: bytes)
    }
    private func changed(_ proof: StageProof, uri: String? = nil, identity: String? = nil,
                         directory: String? = nil, privateDirectory: String? = nil) -> StageProof {
        StageProof(stageURI: uri ?? proof.stageURI, stagedIdentity: identity ?? proof.stagedIdentity,
            directoryIdentity: directory ?? proof.directoryIdentity,
            privateDirectoryIdentity: privateDirectory ?? proof.privateDirectoryIdentity)
    }
    @discardableResult
    private func observe(_ item: Fixture, proof: StageProof? = nil, sha256: String? = nil, size: Int64? = nil,
                         check: () throws -> Void = {}) throws -> NativeAttachmentFiles.AttachmentStageContent {
        try files.observeFilledAttachmentStage(stageProof: proof ?? item.proof,
            sha256: sha256 ?? digest(item.bytes), size: size ?? Int64(item.bytes.count), checkCancellation: check)
    }
    private func refused(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) {
            XCTAssertNotNil($0 as? NativeAttachmentFilesError, file: file, line: line)
        }
    }
    private func retained(_ item: Fixture, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: item.stage), item.bytes, file: file, line: line)
        XCTAssertEqual(try token(item.stage), item.proof.stagedIdentity, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: item.source), item.bytes, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: item.target.path), file: file, line: line)
    }

    func testExactFilledStageSucceedsWithBorrowedSourceGoneAndNonregularTargetUntouched() throws {
        let item = try fixture()
        try FileManager.default.removeItem(at: item.source)

        XCTAssertEqual(Darwin.mkfifo(item.target.path, mode_t(0o600)), 0)
        let targetIdentity = try token(item.target)
        let result = try observe(item)
        XCTAssertEqual(result.sha256, digest(item.bytes)); XCTAssertEqual(result.size, Int64(item.bytes.count))
        XCTAssertEqual(try token(item.stage), item.proof.stagedIdentity)
        XCTAssertEqual(try Data(contentsOf: item.stage), item.bytes)
        XCTAssertEqual(try token(item.target), targetIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: item.source.path))
    }

    func testEmptyFilledStageAndColdObserverKeepReservedIdentity() throws {
        let item = try fixture(Data())
        files = try NativeAttachmentFiles(libraryRoot: root)
        let result = try observe(item)
        XCTAssertEqual(result.sha256, digest(Data())); XCTAssertEqual(result.size, 0)
        try retained(item)
    }

    func testStreamingObservationExceedsRawByteReplyLimitWithoutReturningBytes() throws {
        let item = try fixture(Data(repeating: 0x71, count: 17 * 1024 * 1024))
        let result = try observe(item)
        XCTAssertEqual(result.sha256, digest(item.bytes)); XCTAssertEqual(result.size, Int64(item.bytes.count))
        try retained(item)
    }

    func testMissingStagePrivateDirectoryAndManagedRootRefuseWithoutRecreation() throws {
        for level in 0..<3 {
            let item = try fixture()
            let missing = level == 0 ? item.stage : level == 1 ? item.stage.deletingLastPathComponent() : files.managedRoot
            let held = root.appendingPathComponent("held-\(level)")
            try FileManager.default.moveItem(at: missing, to: held)
            refused { _ = try self.observe(item) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
            let retainedStage = level == 0 ? held : level == 1 ? held.appendingPathComponent("stage")
                : held.appendingPathComponent(item.stage.deletingLastPathComponent().lastPathComponent).appendingPathComponent("stage")
            XCTAssertEqual(try Data(contentsOf: retainedStage), item.bytes)
            try FileManager.default.moveItem(at: held, to: missing)
        }
    }

    func testWrongOrMalformedTokensDigestAndSizeCannotClaimPositiveProof() throws {
        let item = try fixture()
        for proof in [changed(item.proof, identity: "0:0"), changed(item.proof, directory: "0:0"),
                      changed(item.proof, privateDirectory: "0:0"), changed(item.proof, identity: "01:2"),
                      changed(item.proof, directory: String(repeating: "1", count: 42))] {
            refused { _ = try self.observe(item, proof: proof) }
        }
        for sha in ["not-a-digest", digest(item.bytes).uppercased(), String(repeating: "0", count: 64)] {
            refused { _ = try self.observe(item, sha256: sha) }
        }
        for size in [Int64(-1), Int64(item.bytes.count + 1), 9_007_199_254_740_992] {
            refused { _ = try self.observe(item, size: size) }
        }
        try retained(item)
    }

    func testOnlyExactManagedPrivateStagePathIsAdmitted() throws {
        let item = try fixture()
        for uri in [item.source.absoluteString, item.target.absoluteString,
                    item.stage.deletingLastPathComponent().absoluteString, item.stage.absoluteString + "?token=value",
                    files.managedRoot.appendingPathComponent(".mindwtr-install-invalid.candidate/stage").absoluteString,
                    item.stage.absoluteString.replacingOccurrences(of: "/stage", with: "/other")] {
            refused { _ = try self.observe(item, proof: self.changed(item.proof, uri: uri)) }
        }
        try retained(item)
    }

    func testLFAndCRLFCandidateSuffixRefuseObserveFillAndPublicationReproof() throws {
        for suffix in ["\n", "\r\n"] {
            let item = try fixture()
            let original = item.stage.deletingLastPathComponent()
            let malformed = original.deletingLastPathComponent().appendingPathComponent(original.lastPathComponent + suffix)
            try FileManager.default.moveItem(at: original, to: malformed)
            let stage = malformed.appendingPathComponent("stage")
            let proof = changed(item.proof, uri: stage.absoluteString)
            let sourceProof = try files.snapshotCacheSource(item.source.absoluteString)
            XCTAssertThrowsError(try observe(item, proof: proof)) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
            XCTAssertThrowsError(try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
            let facade = try AttachmentFileInstaller(targetRoot: files.managedRoot, sourceRoots: files.sourceRoots)
            XCTAssertThrowsError(try facade.snapshotImmutableStage(stagedInput: stage, targetInput: item.target,
                expectedStagedSha256: digest(item.bytes)))
            let installer = try NativeAttachmentInstaller(managedRoot: files.managedRoot, sourceRoots: files.sourceRoots)
            let operationID = original.lastPathComponent.replacingOccurrences(of: ".mindwtr-install-", with: "")
                .replacingOccurrences(of: ".candidate", with: "")
            XCTAssertThrowsError(try installer.publishStage(stage: proof, targetURI: item.target.absoluteString,
                sha256: digest(item.bytes))) {
                XCTAssertEqual($0 as? NativeAttachmentInstallerError, .unavailable)
            }
            XCTAssertThrowsError(try installer.retirePrivateStage(stage: proof, targetURI: item.target.absoluteString,
                operationID: operationID)) {
                XCTAssertEqual($0 as? NativeAttachmentInstallerError, .unavailable)
            }
            XCTAssertEqual(try Data(contentsOf: stage), item.bytes)
            XCTAssertEqual(try token(stage), item.proof.stagedIdentity)
            XCTAssertFalse(FileManager.default.fileExists(atPath: item.target.path))


            try FileManager.default.moveItem(at: stage, to: item.target)
            XCTAssertThrowsError(try files.verifyPublishedAttachment(targetURI: item.target.absoluteString,
                stageProof: proof, sha256: digest(item.bytes), size: Int64(item.bytes.count))) {
                XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest)
            }
            XCTAssertEqual(try Data(contentsOf: item.target), item.bytes)
            XCTAssertEqual(try token(item.target), item.proof.stagedIdentity)
            XCTAssertTrue(FileManager.default.fileExists(atPath: malformed.path))
            XCTAssertEqual(try Data(contentsOf: item.source), item.bytes)
        }
    }

    func testIdenticalContentReplacementInodeIsNeverAdopted() throws {
        let item = try fixture()
        let held = root.appendingPathComponent("original-stage")
        try FileManager.default.moveItem(at: item.stage, to: held)
        try item.bytes.write(to: item.stage)
        let peer = try token(item.stage)
        XCTAssertNotEqual(peer, item.proof.stagedIdentity)
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try token(item.stage), peer); XCTAssertEqual(try Data(contentsOf: item.stage), item.bytes)
        XCTAssertEqual(try Data(contentsOf: held), item.bytes)
    }

    func testHardlinkedStageRefusesAndPreservesBothNames() throws {
        let item = try fixture(), peer = cache.appendingPathComponent("hardlink")
        XCTAssertEqual(Darwin.link(item.stage.path, peer.path), 0)
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try Data(contentsOf: peer), item.bytes)
        try retained(item)
    }

    func testSymlinkStageAndPrivateAncestorRefuseWithoutFollowingThem() throws {
        let item = try fixture(), held = root.appendingPathComponent("held-stage")
        try FileManager.default.moveItem(at: item.stage, to: held)
        try FileManager.default.createSymbolicLink(at: item.stage, withDestinationURL: held)
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try Data(contentsOf: held), item.bytes)
        try FileManager.default.removeItem(at: item.stage)
        try FileManager.default.moveItem(at: held, to: item.stage)
        let directory = item.stage.deletingLastPathComponent(), heldDirectory = root.appendingPathComponent("held-private")
        try FileManager.default.moveItem(at: directory, to: heldDirectory)
        try FileManager.default.createSymbolicLink(at: directory, withDestinationURL: heldDirectory)
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try Data(contentsOf: heldDirectory.appendingPathComponent("stage")), item.bytes)
    }

    func testModifiedContentOrPartialFillRefusesAndKeepsCurrentBytes() throws {
        let item = try fixture()
        let changed = Data(repeating: 0x78, count: item.bytes.count)
        try changed.write(to: item.stage, options: [])
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try Data(contentsOf: item.stage), changed)
        let partial = Data(item.bytes.prefix(2))
        try partial.write(to: item.stage, options: [])
        refused { _ = try self.observe(item) }
        XCTAssertEqual(try Data(contentsOf: item.stage), partial)
        XCTAssertEqual(try token(item.stage), item.proof.stagedIdentity)
        XCTAssertEqual(try Data(contentsOf: item.source), item.bytes)
    }

    func testHashCallbacksCannotReplaceStagePrivateDirectoryOrManagedRoot() throws {
        for level in 0..<3 {
            let item = try fixture(Data(repeating: 0x61, count: 3 * 64 * 1024))
            var callbacks = 0
            refused {
                _ = try self.observe(item, check: {
                    callbacks += 1
                    if callbacks == 4 {
                        let held = self.root.appendingPathComponent("held-callback-\(level)")
                        if level == 0 {
                            try FileManager.default.moveItem(at: item.stage, to: held)
                            try item.bytes.write(to: item.stage)
                        } else {
                            let directory = level == 1 ? item.stage.deletingLastPathComponent() : self.files.managedRoot
                            try FileManager.default.moveItem(at: directory, to: held)
                            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                            let name = level == 1 ? "stage" : item.stage.deletingLastPathComponent().lastPathComponent
                            try FileManager.default.moveItem(at: held.appendingPathComponent(name), to: directory.appendingPathComponent(name))
                        }
                    }
                })
            }
            XCTAssertEqual(callbacks, 4)
            XCTAssertEqual(try Data(contentsOf: item.stage), item.bytes)
            XCTAssertFalse(FileManager.default.fileExists(atPath: item.target.path))
        }
    }

    func testLaterHashCallbackCannotModifyEarlierHashedChunkInPlace() throws {
        let item = try fixture(Data(repeating: 0x62, count: 3 * 64 * 1024))
        var callbacks = 0
        let prefix = Data("changed earlier chunk".utf8)
        refused {
            _ = try self.observe(item, check: {
                callbacks += 1
                if callbacks == 4 {
                    let handle = try FileHandle(forWritingTo: item.stage)
                    defer { try? handle.close() }
                    try handle.write(contentsOf: prefix)
                    try handle.synchronize()
                }
            })
        }
        XCTAssertEqual(callbacks, 4)
        XCTAssertEqual(Data(try Data(contentsOf: item.stage).prefix(prefix.count)), prefix)
        XCTAssertEqual(try token(item.stage), item.proof.stagedIdentity)
        XCTAssertEqual(try Data(contentsOf: item.source), item.bytes)
    }

    func testFinalCallbackMutationAfterHashCannotReturnPositiveProof() throws {
        let item = try fixture(), changed = Data(repeating: 0x7a, count: Data("owned + 世界".utf8).count)
        var callbacks = 0
        refused {
            _ = try self.observe(item, check: {
                callbacks += 1

                if callbacks == 5 { try changed.write(to: item.stage, options: []) }
            })
        }
        XCTAssertEqual(callbacks, 5)
        XCTAssertEqual(try Data(contentsOf: item.stage), changed)
        XCTAssertEqual(try token(item.stage), item.proof.stagedIdentity)
    }

    func testCancellationBeforeAndDuringHashPreservesStageAndAllowsExactRetry() throws {
        let item = try fixture(Data(repeating: 0x63, count: 3 * 64 * 1024))
        for stop in [1, 4] {
            var callbacks = 0
            XCTAssertThrowsError(try observe(item, check: {
                callbacks += 1
                if callbacks == stop { throw Cancelled.stopped }
            })) { XCTAssertTrue($0 is Cancelled) }
            try retained(item)
        }
        XCTAssertEqual(try observe(item).sha256, digest(item.bytes))
    }

    func testTypedObservationUsesSameFIFOAndExactBoundedMailboxOnly() throws {
        let item = try fixture(), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        defer { jobs.shutdown() }
        try FileManager.default.removeItem(at: item.source)
        var execution: [String] = []
        jobs.beforeWork = { id, _ in execution.append(id) }
        let first = try jobs.submit("{\"op\":\"barrier\"}")
        let typed = try jobs.submitDraft(.observeFilledStage(stage: item.proof, sha256: digest(item.bytes), size: Int64(item.bytes.count)))
        let last = try jobs.submit("{\"op\":\"barrier\"}")
        jobs.drain()
        XCTAssertEqual(execution, [first, typed, last])
        XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(try object(jobs.next())["id"] as? String, first)
        XCTAssertEqual(try object(jobs.next())["id"] as? String, last)
        XCTAssertEqual(jobs.next(), "")
        let encoded = jobs.takeDraft(typed), answer = try object(encoded)
        XCTAssertLessThan(encoded.utf8.count, 1024)
        XCTAssertEqual(Set(answer.keys), ["id", "value"])
        XCTAssertEqual(answer["id"] as? String, typed)
        let value = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertEqual(Set(value.keys), ["sha256", "size", "identity"])
        XCTAssertEqual(value["sha256"] as? String, digest(item.bytes))
        XCTAssertEqual((value["size"] as? NSNumber)?.int64Value, Int64(item.bytes.count))
        XCTAssertEqual(value["identity"] as? String, item.proof.stagedIdentity)
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        XCTAssertEqual(try Data(contentsOf: item.stage), item.bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: item.source.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: item.target.path))
    }

    func testTypedRefusalCancellationBoundsAndRawAllowlistRemainClosed() throws {
        let item = try fixture(), jobs = try NativeAttachmentFileJobs(libraryRoot: root)
        defer { jobs.shutdown() }
        for size in [Int64(-1), 9_007_199_254_740_992] {
            XCTAssertThrowsError(try jobs.submitDraft(.observeFilledStage(stage: item.proof, sha256: digest(item.bytes), size: size)))
        }
        XCTAssertThrowsError(try jobs.submitDraft(.observeFilledStage(stage: changed(item.proof, identity: "01:2"),
            sha256: digest(item.bytes), size: Int64(item.bytes.count))))
        XCTAssertEqual(jobs.counters.jobs, 0)
        let refusal = try jobs.submitDraft(.observeFilledStage(stage: item.proof, sha256: String(repeating: "0", count: 64), size: Int64(item.bytes.count)))
        jobs.drain()
        let refusedAnswer = try object(jobs.takeDraft(refusal))
        XCTAssertEqual(Set(refusedAnswer.keys), ["id", "error"])
        XCTAssertEqual(refusedAnswer["error"] as? String, NativeAttachmentFilesError.unavailable.localizedDescription)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        jobs.beforeWork = { _, _ in entered.signal(); release.wait() }
        let cancelled = try jobs.submitDraft(.observeFilledStage(stage: item.proof, sha256: digest(item.bytes), size: Int64(item.bytes.count)))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        jobs.abort(cancelled); release.signal(); jobs.drain(); jobs.beforeWork = nil
        let cancelledAnswer = try object(jobs.takeDraft(cancelled))
        XCTAssertEqual(cancelledAnswer["error"] as? String, "Attachment file operation was cancelled")
        let raw = try jobs.submit("{\"op\":\"observeFilledStage\"}")
        jobs.drain()
        let rawAnswer = try object(jobs.next())
        XCTAssertEqual(rawAnswer["id"] as? String, raw)
        XCTAssertEqual(rawAnswer["error"] as? String, "Attachment file request is invalid")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0)
        try retained(item)
    }
}
