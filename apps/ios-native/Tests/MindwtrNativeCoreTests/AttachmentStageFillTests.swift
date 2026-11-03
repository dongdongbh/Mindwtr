import XCTest
import Foundation
import Darwin
import CryptoKit
import AttachmentFileInstallerEngine
@testable import MindwtrNativeCore

final class AttachmentStageFillTests: XCTestCase {
    private typealias SourceProof = NativeAttachmentFiles.CacheSourceProof
    private typealias StageProof = NativeAttachmentFiles.ReservedAttachmentStageProof
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var cache: URL!
    private enum Cancelled: Error { case stopped }

    override func setUpWithError() throws {

        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task221-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        let directories = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(files.directoriesJSON.utf8)) as? [String: String])
        cache = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"])))
        try FileManager.default.createDirectory(at: files.managedRoot, withIntermediateDirectories: false)
    }

    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }

    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func bytes(_ url: URL) throws -> Data { try Data(contentsOf: url) }
    private func source(_ data: Data, name: String = "source + 世界.bin") throws -> URL {
        let url = cache.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }
    private func token(_ url: URL) throws -> String {
        var value = stat()
        guard Darwin.lstat(url.path, &value) == 0 else { throw NativeAttachmentFilesError.unavailable }
        return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
    }
    private func installer() throws -> AttachmentFileInstaller {
        try AttachmentFileInstaller(targetRoot: files.managedRoot, sourceRoots: files.sourceRoots)
    }
    private func reserve(_ name: String = "target.bin") throws -> (URL, ImmutableAttachmentPreparedStage, StageProof) {
        let target = files.managedRoot.appendingPathComponent(name)
        let prepared = try installer().prepareImmutableStage(targetInput: target,
            operationId: UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))
        let proof = StageProof(stageURI: prepared.stagedUrl.absoluteString, stagedIdentity: prepared.stagedIdentity,
                               directoryIdentity: prepared.directoryIdentity, privateDirectoryIdentity: prepared.privateDirectoryIdentity)
        return (target, prepared, proof)
    }
    private func changed(_ proof: SourceProof, uri: String? = nil, sha: String? = nil, size: Int64? = nil,
                         identity: String? = nil, cacheIdentity: String? = nil, parentIdentity: String? = nil) -> SourceProof {
        SourceProof(sourceURI: uri ?? proof.sourceURI, sha256: sha ?? proof.sha256, size: size ?? proof.size,
                    identity: identity ?? proof.identity, cacheRootIdentity: cacheIdentity ?? proof.cacheRootIdentity,
                    parentIdentity: parentIdentity ?? proof.parentIdentity)
    }
    private func changed(_ proof: StageProof, uri: String? = nil, identity: String? = nil,
                         directory: String? = nil, privateDirectory: String? = nil) -> StageProof {
        StageProof(stageURI: uri ?? proof.stageURI, stagedIdentity: identity ?? proof.stagedIdentity,
                   directoryIdentity: directory ?? proof.directoryIdentity,
                   privateDirectoryIdentity: privateDirectory ?? proof.privateDirectoryIdentity)
    }
    private func refused(_ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertNotNil(error as? NativeAttachmentFilesError, file: file, line: line)
        }
    }

    func testCacheSnapshotBindsExactDigestSizeAndRetainedAncestors() throws {
        let data = Data([0, 1, 255]) + Data("captured + 世界".utf8)
        let url = try source(data)
        let proof = try files.snapshotCacheSource(url.absoluteString)
        XCTAssertEqual(proof.sourceURI, url.absoluteString)
        XCTAssertEqual(proof.sha256, digest(data))
        XCTAssertEqual(proof.size, Int64(data.count))
        XCTAssertEqual(proof.identity, try token(url))
        XCTAssertEqual(proof.cacheRootIdentity, try token(cache))
        XCTAssertEqual(proof.parentIdentity, try token(cache))
        XCTAssertEqual(try bytes(url), data)
    }

    func testEmptySnapshotAndFillKeepExistingStageInode() throws {
        let url = try source(Data())
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        try Data("previous partial fill".utf8).write(to: stage.stagedUrl, options: [])
        let result = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        XCTAssertEqual(result.sha256, digest(Data()))
        XCTAssertEqual(result.size, 0)
        XCTAssertEqual(try bytes(stage.stagedUrl), Data())
        XCTAssertEqual(try token(stage.stagedUrl), stage.stagedIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testStreamingSnapshotFillAndPublicPublisherWorkAboveBridgeLimit() throws {
        let url = try source(Data(), name: "large.bin")
        let handle = try FileHandle(forWritingTo: url)
        let chunk = Data(repeating: 0x71, count: 1024 * 1024)
        var hash = SHA256()
        for _ in 0..<18 { try handle.write(contentsOf: chunk); hash.update(data: chunk) }
        let tail = Data("tail + 世界".utf8)
        try handle.write(contentsOf: tail); hash.update(data: tail)
        try handle.synchronize(); try handle.close()
        let expectedHash = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        XCTAssertEqual(sourceProof.sha256, expectedHash)
        XCTAssertEqual(sourceProof.size, Int64(18 * chunk.count + tail.count))
        let (target, stage, proof) = try reserve()
        let result = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        XCTAssertEqual(result.sha256, expectedHash)
        XCTAssertEqual(result.size, sourceProof.size)
        XCTAssertEqual(try token(stage.stagedUrl), stage.stagedIdentity)
        let facade = try installer()
        let snapshot = try facade.snapshotImmutableStage(stagedInput: stage.stagedUrl, targetInput: target,
                                                         expectedStagedSha256: result.sha256)
        XCTAssertEqual(snapshot.stagedIdentity, stage.stagedIdentity)
        let outcome = try facade.publishImmutable(stagedInput: stage.stagedUrl, targetInput: target,
            expectedStagedSha256: result.sha256, expectedStagedIdentity: snapshot.stagedIdentity,
            expectedDirectoryIdentity: snapshot.directoryIdentity,
            expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity)
        guard case .published = outcome else { return XCTFail("Expected exclusive publication") }
        XCTAssertEqual(try token(target), stage.stagedIdentity)
        XCTAssertEqual(try facade.hash(target).sha256, sourceProof.sha256)
        XCTAssertEqual(try token(url), sourceProof.identity)
        XCTAssertEqual(try files.snapshotCacheSource(url.absoluteString).sha256, sourceProof.sha256)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.stagedUrl.path))
    }

    func testFilledStageDoesNotAdoptSameHashTargetCollision() throws {
        let data = Data("same bytes".utf8), url = try source(Data("same bytes".utf8))
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        _ = try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        try data.write(to: target)
        let peerIdentity = try token(target)
        let outcome = try installer().publishImmutable(stagedInput: stage.stagedUrl, targetInput: target,
            expectedStagedSha256: sourceProof.sha256, expectedStagedIdentity: proof.stagedIdentity,
            expectedDirectoryIdentity: proof.directoryIdentity, expectedPrivateDirectoryIdentity: proof.privateDirectoryIdentity)
        guard case .alreadyExists = outcome else { return XCTFail("Expected peer target refusal") }
        XCTAssertEqual(try token(target), peerIdentity)
        XCTAssertNotEqual(peerIdentity, stage.stagedIdentity)
        XCTAssertEqual(try bytes(target), data)
        XCTAssertEqual(try bytes(stage.stagedUrl), data)
        XCTAssertEqual(try bytes(url), data)
    }

    func testSnapshotRejectsForeignDocumentDirectoryMissingAndSymlinkSources() throws {
        let owned = try source(Data("owned".utf8))
        let outside = root.appendingPathComponent("outside")
        try Data("private".utf8).write(to: outside)
        let document = files.managedRoot.appendingPathComponent("document")
        try Data("document".utf8).write(to: document)
        let link = cache.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: owned)
        let folderLink = cache.appendingPathComponent("ancestor-link")
        try FileManager.default.createSymbolicLink(at: folderLink, withDestinationURL: cache)
        for uri in [outside.absoluteString, document.absoluteString, cache.absoluteString,
                    cache.appendingPathComponent("missing").absoluteString, link.absoluteString,
                    folderLink.appendingPathComponent(owned.lastPathComponent).absoluteString,
                    cache.absoluteString + "../documents/attachments/document", owned.absoluteString + "?secret=value"] {
            refused { _ = try self.files.snapshotCacheSource(uri) }
        }
        XCTAssertEqual(try bytes(outside), Data("private".utf8))
        XCTAssertEqual(try bytes(owned), Data("owned".utf8))
    }

    func testCorruptAndMismatchedProofsRefuseBeforeTruncatingStage() throws {
        let url = try source(Data("source".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        let keep = Data("owned previous fill".utf8)
        try keep.write(to: stage.stagedUrl, options: [])
        let badSources = [changed(sourceProof, sha: "not-sha"), changed(sourceProof, sha: sourceProof.sha256.uppercased()),
                          changed(sourceProof, size: -1), changed(sourceProof, size: 9_007_199_254_740_992),
                          changed(sourceProof, identity: "01:2"), changed(sourceProof, identity: "0:0"),
                          changed(sourceProof, cacheIdentity: "0:0"), changed(sourceProof, parentIdentity: "0:0"),
                          changed(sourceProof, identity: String(repeating: "1", count: 200)),
                          changed(sourceProof, uri: String(repeating: "x", count: 16 * 1024 + 1))]
        for bad in badSources {
            refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: bad, stageProof: proof) }
            XCTAssertEqual(try bytes(stage.stagedUrl), keep)
        }
        for bad in [changed(proof, identity: "0:0"), changed(proof, directory: "0:0"),
                    changed(proof, privateDirectory: "0:0"), changed(proof, identity: "+1:2"),
                    changed(proof, uri: files.managedRoot.appendingPathComponent("direct-target").absoluteString),
                    changed(proof, uri: url.absoluteString)] {
            refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: bad) }
            XCTAssertEqual(try bytes(stage.stagedUrl), keep)
        }
        XCTAssertEqual(try bytes(url), Data("source".utf8))
    }

    func testIdenticalBytesInReplacedSourceInodeRefuseBeforeTruncate() throws {
        let data = Data("same source".utf8), url = try source(Data("same source".utf8))
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        let keep = Data("retained stage".utf8)
        try keep.write(to: stage.stagedUrl, options: [])
        let retained = cache.appendingPathComponent("retained")
        try FileManager.default.moveItem(at: url, to: retained)
        try data.write(to: url)
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        refused { _ = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try bytes(stage.stagedUrl), keep)
        XCTAssertEqual(try bytes(retained), data)
        XCTAssertEqual(try bytes(url), data)
    }

    func testCacheAndSourceParentReplacementAfterOwnerRecreationRefuse() throws {
        for replaceCache in [false, true] {
            let nested = cache.appendingPathComponent("nested-\(replaceCache)", isDirectory: true)
            try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
            let url = nested.appendingPathComponent("source")
            try Data("source".utf8).write(to: url)
            let sourceProof = try files.snapshotCacheSource(url.absoluteString)
            let (_, stage, proof) = try reserve("target-\(replaceCache)")
            let original = replaceCache ? cache! : nested
            let retained = root.appendingPathComponent("retained-\(replaceCache)", isDirectory: true)
            try FileManager.default.moveItem(at: original, to: retained)
            try FileManager.default.createDirectory(at: original, withIntermediateDirectories: false)
            let nestedReplacement = replaceCache ? original.appendingPathComponent(nested.lastPathComponent) : original
            if replaceCache { try FileManager.default.createDirectory(at: nestedReplacement, withIntermediateDirectories: false) }
            let movedSource = retained.appendingPathComponent(replaceCache ? nested.lastPathComponent + "/source" : "source")

            try FileManager.default.moveItem(at: movedSource, to: url)
            XCTAssertEqual(try token(url), sourceProof.identity)
            let cold = try NativeAttachmentFiles(libraryRoot: root)
            refused { _ = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
            XCTAssertEqual(try bytes(stage.stagedUrl), Data())
            XCTAssertEqual(try bytes(url), Data("source".utf8))
            files = cold
        }
    }

    func testReplacementStageAndPrivateDirectoryRefuseWithoutTouchingPeers() throws {
        let url = try source(Data("incoming".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        for replaceDirectory in [false, true] {
            let (_, stage, proof) = try reserve("target-\(replaceDirectory)")
            let original = replaceDirectory ? stage.stagedUrl.deletingLastPathComponent() : stage.stagedUrl
            let retained = files.managedRoot.appendingPathComponent("retained-\(replaceDirectory)")
            try FileManager.default.moveItem(at: original, to: retained)
            if replaceDirectory { try FileManager.default.createDirectory(at: original, withIntermediateDirectories: false) }
            let peer = Data("peer must remain".utf8)
            try peer.write(to: stage.stagedUrl)
            let cold = try NativeAttachmentFiles(libraryRoot: root)
            refused { _ = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
            XCTAssertEqual(try bytes(stage.stagedUrl), peer)
            XCTAssertEqual(try bytes(replaceDirectory ? retained.appendingPathComponent("stage") : retained), Data())
        }
    }

    func testManagedRootReplacementRefusesEvenWhenStageDirectoryIsMovedBack() throws {
        let url = try source(Data("source".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        let managed = files.managedRoot, retained = root.appendingPathComponent("retained-managed", isDirectory: true)
        try FileManager.default.moveItem(at: managed, to: retained)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)
        let privateName = stage.stagedUrl.deletingLastPathComponent().lastPathComponent
        try FileManager.default.moveItem(at: retained.appendingPathComponent(privateName),
                                         to: managed.appendingPathComponent(privateName))
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        refused { _ = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try bytes(stage.stagedUrl), Data())
    }

    func testStageAndPrivateAncestorSymlinksNeverTouchOutsideBytes() throws {
        let url = try source(Data("source".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let sentinel = outside.appendingPathComponent("stage")
        let keep = Data("private outside bytes".utf8)
        try keep.write(to: sentinel)
        for parentLink in [false, true] {
            let (_, stage, proof) = try reserve("symlink-target-\(parentLink)")
            let original = parentLink ? stage.stagedUrl.deletingLastPathComponent() : stage.stagedUrl
            let retained = files.managedRoot.appendingPathComponent("symlink-retained-\(parentLink)")
            try FileManager.default.moveItem(at: original, to: retained)
            try FileManager.default.createSymbolicLink(at: original, withDestinationURL: parentLink ? outside : sentinel)
            refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
            XCTAssertEqual(try bytes(sentinel), keep)
            XCTAssertEqual(try bytes(parentLink ? retained.appendingPathComponent("stage") : retained), Data())
        }
    }

    func testChangedSourceHashRetainsOwnedStageButNeverAcknowledgesOrPublishes() throws {
        let url = try source(Data("old data".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        try Data("new data".utf8).write(to: url, options: [])
        XCTAssertEqual(try token(url), sourceProof.identity)
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(stage.stagedUrl), Data("new data".utf8))
        XCTAssertEqual(try bytes(url), Data("new data".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testHardLinkedStageCannotTruncateSourceOrAnotherNamedFile() throws {
        let data = Data("protected source".utf8), url = try source(Data("protected source".utf8))
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        try Data("protected stage".utf8).write(to: stage.stagedUrl, options: [])
        let peer = cache.appendingPathComponent("hardlink-peer")
        guard Darwin.link(stage.stagedUrl.path, peer.path) == 0 else { throw NativeAttachmentFilesError.unavailable }
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try bytes(peer), Data("protected stage".utf8))
        XCTAssertEqual(try bytes(stage.stagedUrl), Data("protected stage".utf8))
        try FileManager.default.removeItem(at: stage.stagedUrl)
        guard Darwin.link(url.path, stage.stagedUrl.path) == 0 else { throw NativeAttachmentFilesError.unavailable }
        let sameSourceProof = changed(proof, identity: sourceProof.identity)
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: sameSourceProof) }
        XCTAssertEqual(try bytes(url), data)
        XCTAssertEqual(try bytes(stage.stagedUrl), data)
    }

    func testCancellationRetainsPartialInodeAndColdExactRetrySucceeds() throws {
        let data = Data(repeating: 0x61, count: 3 * 64 * 1024), url = try source(Data(repeating: 0x61, count: 3 * 64 * 1024))
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        var checks = 0
        XCTAssertThrowsError(try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof, checkCancellation: {
            checks += 1
            if checks == 4 { throw Cancelled.stopped }
        })) { XCTAssertTrue($0 is Cancelled) }
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        let partial = try bytes(stage.stagedUrl)
        XCTAssertFalse(partial.isEmpty)
        XCTAssertLessThan(partial.count, data.count)
        XCTAssertEqual(partial, data.prefix(partial.count))
        XCTAssertEqual(try bytes(url), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        let result = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        XCTAssertEqual(result.sha256, sourceProof.sha256)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(stage.stagedUrl), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testCancellationBeforeTruncateKeepsPriorStageAndSourceBytes() throws {
        let url = try source(Data("incoming".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        let previous = Data("previous stage".utf8)
        try previous.write(to: stage.stagedUrl, options: [])
        XCTAssertThrowsError(try files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof,
            checkCancellation: { throw Cancelled.stopped })) { XCTAssertTrue($0 is Cancelled) }
        XCTAssertEqual(try bytes(stage.stagedUrl), previous)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(url), Data("incoming".utf8))
    }

    func testLaterCopyCallbackTamperingWithEarlierChunkCannotAcknowledgeSuccess() throws {
        let data = Data(repeating: 0x61, count: 3 * 64 * 1024)
        let url = try source(data), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        let changedPrefix = Data("tampered copied chunk".utf8)
        var callbacks = 0
        refused {
            _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof, checkCancellation: {
                callbacks += 1


                if callbacks == 3 {
                    let handle = try FileHandle(forWritingTo: stage.stagedUrl)
                    defer { try? handle.close() }
                    try handle.seek(toOffset: 0)
                    try handle.write(contentsOf: changedPrefix)
                    try handle.synchronize()
                }
            })
        }
        let retained = try bytes(stage.stagedUrl)
        XCTAssertEqual(retained.count, data.count)
        XCTAssertEqual(Data(retained.prefix(changedPrefix.count)), changedPrefix)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(url), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        let result = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        XCTAssertEqual(result.sha256, sourceProof.sha256)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(stage.stagedUrl), data)
    }

    func testVerificationCallbackTamperingWithAlreadyHashedChunkFailsStableProof() throws {
        let data = Data(repeating: 0x62, count: 3 * 64 * 1024)
        let url = try source(data), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        let changedPrefix = Data("tampered verified chunk".utf8)
        var callbacks = 0, tampered = false
        refused {
            _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof, checkCancellation: {
                callbacks += 1


                if callbacks == 8 {
                    let handle = try FileHandle(forWritingTo: stage.stagedUrl)
                    defer { try? handle.close() }
                    try handle.seek(toOffset: 0)
                    try handle.write(contentsOf: changedPrefix)
                    try handle.synchronize()
                    tampered = true
                }
            })
        }
        XCTAssertTrue(tampered)
        XCTAssertEqual(Data(try bytes(stage.stagedUrl).prefix(changedPrefix.count)), changedPrefix)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(url), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }

    func testCallbackReplacementAndLateHardLinkNeverTruncatePeer() throws {
        let url = try source(Data("incoming".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        for hardlink in [false, true] {
            let (_, stage, proof) = try reserve("target-\(hardlink)")
            let retained = files.managedRoot.appendingPathComponent("callback-retained-\(hardlink)")
            try Data("previous stage".utf8).write(to: stage.stagedUrl, options: [])
            var checks = 0
            refused {
                _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof, checkCancellation: {
                    checks += 1
                    if checks == (hardlink ? 2 : 1) {
                        if hardlink {
                            guard Darwin.link(stage.stagedUrl.path, retained.path) == 0 else { throw NativeAttachmentFilesError.unavailable }
                        } else {
                            try FileManager.default.moveItem(at: stage.stagedUrl, to: retained)
                            try Data("peer replacement".utf8).write(to: stage.stagedUrl)
                        }
                    }
                })
            }
            XCTAssertEqual(try bytes(stage.stagedUrl), hardlink ? Data() : Data("peer replacement".utf8))
            XCTAssertEqual(try bytes(retained), hardlink ? Data() : Data("previous stage".utf8))
        }
        XCTAssertEqual(try bytes(url), Data("incoming".utf8))
    }

    func testGenericAtomicCopyStillReplacesStageInodeAndOldProofRefuses() throws {
        let url = try source(Data("incoming".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        let request: [String: Any] = ["op": "copy", "uri": url.absoluteString, "to": stage.stagedUrl.absoluteString]
        _ = try files.call(String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self))
        XCTAssertNotEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        let cold = try NativeAttachmentFiles(libraryRoot: root)
        refused { _ = try cold.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try bytes(stage.stagedUrl), Data("incoming".utf8))
        XCTAssertEqual(try bytes(url), Data("incoming".utf8))
    }

    #if DEBUG
    func testSnapshotMutationAndReplacementAfterDescriptorOpenRefuse() throws {
        for replacement in [false, true] {
            let url = try source(Data("original".utf8), name: "source-\(replacement)")
            files.afterSourceOpened = {
                if replacement {
                    try FileManager.default.moveItem(at: url, to: self.cache.appendingPathComponent("retained-\(replacement)"))
                }
                try Data("changed longer".utf8).write(to: url, options: [])
            }
            refused { _ = try self.files.snapshotCacheSource(url.absoluteString) }
            files.afterSourceOpened = nil
        }
    }

    func testOpenedStageSourceMutationAndSyncFailureRetainInodeWithoutPublication() throws {
        let data = Data("source".utf8), url = try source(Data("source".utf8))
        let sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        try Data("prior".utf8).write(to: stage.stagedUrl, options: [])
        files.afterSourceOpened = { try Data("change".utf8).write(to: url, options: []) }
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        files.afterSourceOpened = nil
        XCTAssertEqual(try bytes(stage.stagedUrl), Data("prior".utf8))
        try data.write(to: url, options: [])
        files.beforeStageSync = { throw NativeAttachmentFilesError.unavailable }
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        files.beforeStageSync = nil
        XCTAssertEqual(try bytes(stage.stagedUrl), data)
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let result = try NativeAttachmentFiles(libraryRoot: root).fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof)
        XCTAssertEqual(result.sha256, sourceProof.sha256)
    }

    func testStageContentMutationBeforeSyncCannotReturnSuccess() throws {
        let url = try source(Data("incoming".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (target, stage, proof) = try reserve()
        files.beforeStageSync = { try Data("modified".utf8).write(to: stage.stagedUrl, options: []) }
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        files.beforeStageSync = nil
        XCTAssertEqual(try token(stage.stagedUrl), proof.stagedIdentity)
        XCTAssertEqual(try bytes(stage.stagedUrl), Data("modified".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
    #endif

    func testUnreadableCacheSourceRefusesWithoutStageMutation() throws {
        if geteuid() == 0 { throw XCTSkip("Requires an unprivileged account") }
        let url = try source(Data("source".utf8)), sourceProof = try files.snapshotCacheSource(url.absoluteString)
        let (_, stage, proof) = try reserve()
        guard Darwin.chmod(url.path, mode_t(0o000)) == 0 else { throw NativeAttachmentFilesError.unavailable }
        defer { _ = Darwin.chmod(url.path, mode_t(0o600)) }
        refused { _ = try self.files.snapshotCacheSource(url.absoluteString) }
        refused { _ = try self.files.fillReservedAttachmentStage(sourceProof: sourceProof, stageProof: proof) }
        XCTAssertEqual(try bytes(stage.stagedUrl), Data())
    }
}
