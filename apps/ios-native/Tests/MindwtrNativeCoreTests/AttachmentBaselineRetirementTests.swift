import XCTest
import Foundation
import Darwin
@testable import MindwtrNativeCore


final class AttachmentBaselineRetirementTests: XCTestCase {
    private typealias Proof = NativeAttachmentFiles.BaselineAttachmentProof
    private enum Stop: Error { case cancelled, fault }
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var target: URL!
    private var source: URL!
    private var sibling: URL!
    private var proof: Proof!
    private let attachmentID = "historical-file-7"
    private let bytes = Data("Baseline current generation + 世界".utf8)
    private let sentinel = Data("Untouched sibling".utf8)

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task255-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        try FileManager.default.createDirectory(at: files.managedRoot, withIntermediateDirectories: false)
        let dirs = try object(files.directoriesJSON)
        source = try XCTUnwrap(URL(string: XCTUnwrap(dirs["cache"] as? String))).appendingPathComponent("borrowed.bin")
        target = files.managedRoot.appendingPathComponent(attachmentID + ".historical-extension")
        sibling = files.managedRoot.appendingPathComponent("untouched.bin")
        try bytes.write(to: source); try bytes.write(to: target); try sentinel.write(to: sibling)
        guard case .present(let actual) = try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString) else {
            throw NativeAttachmentFilesError.unavailable
        }
        proof = actual
    }
    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
    private func token(_ url: URL) throws -> String {
        var value = stat(); guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func changed(uri: String? = nil, sha: String? = nil, size: Int64? = nil,
                         identity: String? = nil, directory: String? = nil) -> Proof {
        Proof(targetURI: uri ?? proof.targetURI, sha256: sha ?? proof.sha256, size: size ?? proof.size,
            identity: identity ?? proof.identity, directoryIdentity: directory ?? proof.directoryIdentity)
    }
    @discardableResult private func retire(check: () throws -> Void = {}) throws -> NativeAttachmentFiles.BaselineAttachmentRetirementOutcome {
        try files.retireBaselineAttachment(attachmentID: attachmentID, proof: proof, checkCancellation: check)
    }
    private func refused(_ body: () throws -> Void, expected: NativeAttachmentFilesError = .unavailable,
                         file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) {
            XCTAssertEqual($0 as? NativeAttachmentFilesError, expected, file: file, line: line)
            XCTAssertFalse($0.localizedDescription.contains(self.attachmentID), file: file, line: line)
            XCTAssertFalse($0.localizedDescription.contains("file:///"), file: file, line: line)
        }
    }
    private func untouched(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: source), bytes, file: file, line: line)
        XCTAssertEqual(try Data(contentsOf: sibling), sentinel, file: file, line: line)
    }
    private func sameTarget(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: target), bytes, file: file, line: line)
        XCTAssertEqual(try token(target), proof.identity, file: file, line: line); try untouched(file: file, line: line)
    }
    private func replaceTarget(_ content: Data? = nil) throws -> URL {
        let held = root.appendingPathComponent("held-" + UUID().uuidString)
        try FileManager.default.moveItem(at: target, to: held); try (content ?? bytes).write(to: target)
        XCTAssertNotEqual(try token(target), proof.identity); return held
    }
    private func replaceManaged() throws -> URL {
        let held = root.appendingPathComponent("held-managed-" + UUID().uuidString)
        try FileManager.default.moveItem(at: files.managedRoot, to: held)
        try FileManager.default.createDirectory(at: files.managedRoot, withIntermediateDirectories: false)
        return held
    }

    func testExactMeasuredGenerationRemovesOnlyTargetAndColdAbsenceRetryStillSyncs() throws {
        XCTAssertEqual(try retire(), .removed); XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); try untouched()
        files = try NativeAttachmentFiles(libraryRoot: root)
        var synced = 0; files.beforeRetirementSync = { synced += 1 }
        XCTAssertEqual(try retire(), .absent); XCTAssertEqual(try retire(), .absent); XCTAssertEqual(synced, 2); try untouched()
    }

    func testLostUnlinkAcknowledgmentAndSyncBoundaryFailureAreUncertainUntilColdAbsentRetry() throws {
        for boundary in ["unlink", "sync"] {
            try bytes.write(to: target)
            guard case .present(let current) = try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString) else { return XCTFail("Fixture") }
            proof = current
            if boundary == "unlink" { files.afterRetirementUnlink = { throw Stop.fault } }
            else { files.beforeRetirementSync = { throw Stop.fault } }
            refused { _ = try retire() }; XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); try untouched()
            files = try NativeAttachmentFiles(libraryRoot: root); var syncs = 0
            files.beforeRetirementSync = { syncs += 1 }
            XCTAssertEqual(try retire(), .absent); XCTAssertEqual(syncs, 1); try untouched()
            files.beforeRetirementSync = nil
        }
    }

    func testSameContentDifferentInodeIsRetainedWithoutUnlinkOrSyncOrAdoption() throws {
        let held = try replaceTarget(), identity = try token(target)
        files.beforeRetirementUnlink = { XCTFail("Retained generation must not enter unlink") }
        files.beforeRetirementSync = { XCTFail("Retained generation is not durable absence") }
        XCTAssertEqual(try retire(), .generationChanged); XCTAssertEqual(try retire(), .generationChanged)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try token(target), identity)
        XCTAssertEqual(try Data(contentsOf: held), bytes); try untouched()
    }

    func testSameInodeChangedContentAndSizeArePositivelyRetained() throws {
        for content in [Data(repeating: 0x78, count: bytes.count), Data("New longer or shorter bytes".utf8)] {
            let handle = try FileHandle(forWritingTo: target); try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: content); try handle.close()
            XCTAssertEqual(try token(target), proof.identity); XCTAssertEqual(try retire(), .generationChanged)
            XCTAssertEqual(try Data(contentsOf: target), content); try untouched()
        }
    }

    func testStableUnsafeSymlinkFIFOFolderAndHardlinkAreKeptWithoutOpeningOrRemoving() throws {
        let held = root.appendingPathComponent("held-original")
        try FileManager.default.moveItem(at: target, to: held)
        for kind in ["symlink", "fifo", "folder", "hardlink"] {
            switch kind {
            case "symlink": try FileManager.default.createSymbolicLink(at: target, withDestinationURL: held)
            case "fifo": XCTAssertEqual(Darwin.mkfifo(target.path, mode_t(0o600)), 0)
            case "folder": try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            default: XCTAssertEqual(Darwin.link(held.path, target.path), 0)
            }
            let identity = try token(target)
            XCTAssertEqual(try retire(), .unsafeEntry); XCTAssertEqual(try token(target), identity)
            XCTAssertEqual(try Data(contentsOf: held), bytes); try untouched()
            try FileManager.default.removeItem(at: target)
        }
    }

    func testCapturedAbsenceIsNotRetirementProofAndLaterFileHasNoImplicitWork() throws {
        let missing = files.managedRoot.appendingPathComponent("other-id.txt")
        let observation = try files.snapshotBaselineAttachment(attachmentID: "other-id", targetURI: missing.absoluteString)
        guard case .noOwnedGeneration(_, .leafAbsent(_)) = observation else { return XCTFail("Expected observation") }
        let later = Data("Later generation remains untouched".utf8); try later.write(to: missing)
        let identity = try token(missing)


        XCTAssertEqual(try Data(contentsOf: missing), later); XCTAssertEqual(try token(missing), identity); try sameTarget()
    }

    func testMissingOrReplacedManagedRootRefusesEvenOnColdOwner() throws {
        let held = try replaceManaged()
        refused { _ = try retire() }
        files = try NativeAttachmentFiles(libraryRoot: root); refused { _ = try retire() }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: files.managedRoot.path), [])
        try FileManager.default.removeItem(at: files.managedRoot); refused { _ = try retire() }
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent(target.lastPathComponent)), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testKnownDocumentsMissingOrReplacedIsRefusalNotRetainedOrAbsent() throws {
        let documents = files.managedRoot.deletingLastPathComponent(), held = root.appendingPathComponent("held-documents")
        try FileManager.default.moveItem(at: documents, to: held); refused { _ = try retire() }
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: false); refused { _ = try retire() }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: documents.path), [])
        XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent("attachments/" + target.lastPathComponent)), bytes)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testMissingLeafRequiresExactKnownManagedIdentityAndSyncFailureRefuses() throws {
        try FileManager.default.removeItem(at: target)
        refused { _ = try files.retireBaselineAttachment(attachmentID: attachmentID, proof: changed(directory: "0:0")) }
        files.beforeRetirementSync = { throw Stop.fault }; refused { _ = try retire() }
        var syncs = 0; files.beforeRetirementSync = { syncs += 1 }
        XCTAssertEqual(try retire(), .absent); XCTAssertEqual(syncs, 1); try untouched()
    }

    func testMalformedProofAndNonFlatNonIDPathsRefuseBeforeMutation() throws {
        for malformed in [changed(sha: "bad"), changed(sha: String(repeating: "A", count: 64)), changed(size: -1),
            changed(size: 9_007_199_254_740_992), changed(identity: "01:2"), changed(directory: "1:-2"),
            changed(uri: source.absoluteString), changed(uri: target.absoluteString + "/"),
            changed(uri: target.absoluteString.replacingOccurrences(of: "/attachments/", with: "/attachments//")),
            changed(uri: files.managedRoot.appendingPathComponent("wrong-name").absoluteString), changed(uri: target.absoluteString + "?secret=x"),
            changed(uri: "content://provider/1")] {
            refused({ _ = try files.retireBaselineAttachment(attachmentID: attachmentID, proof: malformed) }, expected: .invalidRequest)
            try sameTarget()
        }
        for badID in ["", "nul\0id", String(repeating: "界", count: 501)] {
            refused({ _ = try files.retireBaselineAttachment(attachmentID: badID, proof: proof) }, expected: .invalidRequest)
        }
        try sameTarget()
    }

    func testReplacementDuringHashRefusesRatherThanReclassifyingAsRetained() throws {
        var callbacks = 0, held: URL?
        refused { _ = try retire {
            callbacks += 1; if callbacks == 3 { held = try self.replaceTarget() }
        } }
        XCTAssertEqual(callbacks, 3); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(held)), bytes); try untouched()
    }

    func testEarlierChunkMutationDuringHashIsAnErrorNotGenerationChanged() throws {
        let content = Data(repeating: 0x71, count: 3 * 64 * 1024); try content.write(to: target)
        guard case .present(let current) = try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString) else { return XCTFail("Fixture") }
        proof = current; var callbacks = 0
        refused { _ = try retire {
            callbacks += 1
            if callbacks == 4 {
                let handle = try FileHandle(forWritingTo: self.target); try handle.write(contentsOf: Data([0x58])); try handle.close()
            }
        } }
        XCTAssertEqual(callbacks, 4); XCTAssertEqual(try Data(contentsOf: target).first, 0x58)
        XCTAssertEqual(try token(target), current.identity); try untouched()
    }

    func testPreunlinkHookReplacementAndRootReplacementRefuseUnderOriginalProof() throws {
        var held: URL?
        files.beforeRetirementUnlink = { held = try self.replaceTarget() }
        refused { _ = try retire() }; XCTAssertEqual(try Data(contentsOf: XCTUnwrap(held)), bytes)
        XCTAssertEqual(try Data(contentsOf: target), bytes); try untouched()
        files.beforeRetirementUnlink = nil
        guard case .present(let actual) = try files.snapshotBaselineAttachment(attachmentID: attachmentID, targetURI: target.absoluteString) else { return XCTFail("Fixture") }
        proof = actual
        files.beforeRetirementUnlink = { held = try self.replaceManaged(); try self.bytes.write(to: self.target) }
        refused { _ = try retire() }
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(held).appendingPathComponent(target.lastPathComponent)), bytes)
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testUnsafeAndDifferentGenerationReplacementDuringClassifierCallbacksRefuse() throws {
        let held = root.appendingPathComponent("held-original"); try FileManager.default.moveItem(at: target, to: held)
        XCTAssertEqual(Darwin.mkfifo(target.path, mode_t(0o600)), 0); var callbacks = 0
        refused { _ = try retire {
            callbacks += 1
            if callbacks == 2 { try FileManager.default.removeItem(at: self.target); try self.bytes.write(to: self.target) }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: target), bytes)
        callbacks = 0
        refused { _ = try retire {
            callbacks += 1; if callbacks == 2 { _ = try self.replaceTarget() }
        } }
        XCTAssertEqual(callbacks, 2); XCTAssertEqual(try Data(contentsOf: target), bytes)
        XCTAssertEqual(try Data(contentsOf: held), bytes); try untouched()
    }

    func testFinalCancellationBeforeUnlinkLeavesAllBytesAndPostunlinkCancellationReturnsRemoved() throws {
        var cancelled = false, unlinked = false
        files.beforeRetirementUnlink = { cancelled = true }; files.afterRetirementUnlink = { unlinked = true }
        XCTAssertThrowsError(try retire { if cancelled { throw Stop.cancelled } }) { XCTAssertTrue($0 is Stop) }
        XCTAssertFalse(unlinked); try sameTarget()
        cancelled = false; files.beforeRetirementUnlink = nil
        var checks = 0, checksAtUnlink = 0, syncs = 0
        files.afterRetirementUnlink = { cancelled = true; checksAtUnlink = checks }
        files.beforeRetirementSync = { syncs += 1 }
        XCTAssertEqual(try retire { checks += 1; if cancelled { throw Stop.cancelled } }, .removed)
        XCTAssertEqual(checks, checksAtUnlink); XCTAssertEqual(syncs, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)); try untouched()
    }

    func testCancellationDuringInspectionAndHashPropagatesWithoutDeletion() throws {
        for stopAt in [1, 3] {
            var callbacks = 0
            XCTAssertThrowsError(try retire { callbacks += 1; if callbacks == stopAt { throw Stop.cancelled } }) { XCTAssertTrue($0 is Stop) }
            XCTAssertEqual(callbacks, stopAt); try sameTarget()
        }
    }

    func testTargetAppearanceAfterUnlinkOrAbsentSyncRemainsUncertainThenRetained() throws {
        let foreign = Data("Appeared during durability boundary".utf8)
        files.afterRetirementUnlink = { try foreign.write(to: self.target) }
        refused { _ = try retire() }; XCTAssertEqual(try Data(contentsOf: target), foreign)
        files = try NativeAttachmentFiles(libraryRoot: root)
        XCTAssertEqual(try retire(), .generationChanged); XCTAssertEqual(try Data(contentsOf: target), foreign); try untouched()
        try FileManager.default.removeItem(at: target)
        files.beforeRetirementSync = { try foreign.write(to: self.target) }
        refused { _ = try retire() }; XCTAssertEqual(try Data(contentsOf: target), foreign); try untouched()
    }

    func testManagedRootReplacementAfterUnlinkRefusesColdRetryWithoutRecreation() throws {
        var held: URL?; files.afterRetirementUnlink = { held = try self.replaceManaged() }
        refused { _ = try retire() }; files = try NativeAttachmentFiles(libraryRoot: root); refused { _ = try retire() }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: files.managedRoot.path), [])
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(held).appendingPathComponent(sibling.lastPathComponent)), sentinel)
        XCTAssertEqual(try Data(contentsOf: source), bytes)
    }

    func testUnreadableRegularTargetIsRefusalNotRetainedDisposition() throws {
        guard Darwin.geteuid() != 0 else { throw XCTSkip("Permission boundary needs an unprivileged test owner") }
        let identity = try token(target)
        XCTAssertEqual(Darwin.chmod(target.path, mode_t(0)), 0)
        defer { _ = Darwin.chmod(target.path, mode_t(0o600)) }
        refused { _ = try retire() }
        XCTAssertEqual(try token(target), identity)
        XCTAssertEqual(Darwin.chmod(target.path, mode_t(0o600)), 0)
        try sameTarget()
    }

    func testLegacyPublishedFacadeStillRefusesChangedOrUnsafeTargetsWithOriginalError() throws {
        let legacy = NativeAttachmentFiles.PublishedAttachmentProof(sha256: proof.sha256, size: proof.size,
            identity: proof.identity, directoryIdentity: proof.directoryIdentity)
        let held = try replaceTarget()
        refused { _ = try files.retirePublishedAttachment(targetURI: target.absoluteString, proof: legacy) }
        XCTAssertEqual(try retire(), .generationChanged); try FileManager.default.removeItem(at: target)
        XCTAssertEqual(Darwin.mkfifo(target.path, mode_t(0o600)), 0)
        refused { _ = try files.retirePublishedAttachment(targetURI: target.absoluteString, proof: legacy) }
        XCTAssertEqual(try retire(), .unsafeEntry); XCTAssertEqual(try Data(contentsOf: held), bytes); try untouched()
    }

    func testTypedFIFOExactResultsUseDraftMailboxAndNoByteBodies() throws {
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        var order: [String] = []; jobs.beforeWork = { id, installer in XCTAssertFalse(installer); order.append(id) }
        let first = try jobs.submit("{\"op\":\"barrier\"}")
        let typed = try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: proof))
        let last = try jobs.submit("{\"op\":\"barrier\"}"); jobs.drain()
        XCTAssertEqual(order, [first, typed, last]); XCTAssertEqual(jobs.takeDraft(first), "")
        XCTAssertEqual(try object(jobs.next())["id"] as? String, first); XCTAssertEqual(try object(jobs.next())["id"] as? String, last)
        let answer = try object(jobs.takeDraft(typed)), value = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertEqual(Set(answer.keys), Set(["id", "value"])); XCTAssertEqual(answer["id"] as? String, typed)
        XCTAssertEqual(Set(value.keys), Set(["status"])); XCTAssertEqual(value["status"] as? String, "removed")
        XCTAssertEqual(jobs.takeDraft(typed), ""); XCTAssertEqual(jobs.next(), ""); XCTAssertEqual(jobs.body(), "")
        let absent = try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: proof)); jobs.drain()
        XCTAssertEqual((try object(jobs.takeDraft(absent))["value"] as? [String: Any])?["status"] as? String, "absent")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0); try untouched()
    }

    func testTypedRetainedStatusAndRawBridgeRefusalAreSealed() throws {
        _ = try replaceTarget(); let identity = try token(target)
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        let changed = try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: proof)); jobs.drain()
        let answer = try object(jobs.takeDraft(changed)), value = try XCTUnwrap(answer["value"] as? [String: Any])
        XCTAssertEqual(Set(value.keys), Set(["status"])); XCTAssertEqual(value["status"] as? String, "generationChanged")
        XCTAssertEqual(try token(target), identity); try FileManager.default.removeItem(at: target)
        XCTAssertEqual(Darwin.mkfifo(target.path, mode_t(0o600)), 0); let fifoIdentity = try token(target)
        let unsafe = try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: proof)); jobs.drain()
        XCTAssertEqual((try object(jobs.takeDraft(unsafe))["value"] as? [String: Any])?["status"] as? String, "unsafeEntry")
        XCTAssertEqual(try token(target), fifoIdentity)
        let raw = try jobs.submit("{\"op\":\"retireBaseline\"}"); jobs.drain()
        XCTAssertEqual(try object(jobs.next())["error"] as? String, "Attachment file request is invalid")
        XCTAssertThrowsError(try files.call("{\"op\":\"retireBaseline\"}")) { XCTAssertEqual($0 as? NativeAttachmentFilesError, .invalidRequest) }
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0); try untouched()
    }

    func testTypedProofAdmissionAndHeldCancellationPreserveTarget() throws {
        let jobs = try NativeAttachmentFileJobs(libraryRoot: root); defer { jobs.shutdown() }
        for malformed in [changed(sha: "bad"), changed(size: -1), changed(directory: "01:2"), changed(uri: String(repeating: "x", count: 16 * 1024 + 1))] {
            XCTAssertThrowsError(try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: malformed)))
        }
        XCTAssertThrowsError(try jobs.submitDraft(.retireBaseline(attachmentID: "", proof: proof)))
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0); defer { release.signal() }
        jobs.beforeWork = { _, _ in entered.signal(); release.wait() }
        let operation = try jobs.submitDraft(.retireBaseline(attachmentID: attachmentID, proof: proof))
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success); jobs.abort(operation); release.signal(); jobs.drain()
        let answer = try object(jobs.takeDraft(operation)); XCTAssertEqual(Set(answer.keys), Set(["id", "error"]))
        XCTAssertEqual(answer["error"] as? String, "Attachment file operation was cancelled")
        XCTAssertEqual(jobs.counters.jobs, 0); XCTAssertEqual(jobs.counters.bytes, 0); try sameTarget()
    }
}
