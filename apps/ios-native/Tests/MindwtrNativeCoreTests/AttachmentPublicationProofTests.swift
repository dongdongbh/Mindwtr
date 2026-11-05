import XCTest
import Foundation
import Darwin
import AttachmentFileInstallerEngine
@testable import MindwtrNativeCore

final class AttachmentPublicationProofTests: XCTestCase {
    private typealias Stage = NativeAttachmentFiles.ReservedAttachmentStageProof
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private var target: URL!
    private var source: URL!
    private var stage: Stage!
    private var content: NativeAttachmentFiles.AttachmentStageContent!
    private enum Stop: Error { case cancelled }

    override func setUpWithError() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let fixture = checkout.appendingPathComponent(".build/task225-fixtures/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw NativeAttachmentFilesError.unavailable }
        defer { Darwin.free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
        try FileManager.default.createDirectory(at: files.managedRoot, withIntermediateDirectories: false)
        let directories = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(files.directoriesJSON.utf8)) as? [String: String])
        source = try XCTUnwrap(URL(string: XCTUnwrap(directories["cache"]))).appendingPathComponent("source 世界.bin")
        try Data("retained exact bytes".utf8).write(to: source)
        target = files.managedRoot.appendingPathComponent("result 世界.bin")
        let reserved = try installer().prepareImmutableStage(targetInput: target,
            operationId: UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))
        stage = Stage(stageURI: reserved.stagedUrl.absoluteString, stagedIdentity: reserved.stagedIdentity,
            directoryIdentity: reserved.directoryIdentity, privateDirectoryIdentity: reserved.privateDirectoryIdentity)
        content = try files.fillReservedAttachmentStage(sourceProof: files.snapshotCacheSource(source.absoluteString), stageProof: stage)
    }
    override func tearDownWithError() throws {
        files = nil
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func installer() throws -> AttachmentFileInstaller {
        try AttachmentFileInstaller(targetRoot: files.managedRoot, sourceRoots: files.sourceRoots)
    }
    private var stageURL: URL { URL(string: stage.stageURI)! }
    private func publish() throws {
        let result = try installer().publishImmutable(stagedInput: stageURL, targetInput: target,
            expectedStagedSha256: content.sha256, expectedStagedIdentity: stage.stagedIdentity,
            expectedDirectoryIdentity: stage.directoryIdentity, expectedPrivateDirectoryIdentity: stage.privateDirectoryIdentity)
        guard case .published = result else { return XCTFail("Expected exclusive publication") }
    }
    @discardableResult private func prove(check: () throws -> Void = {}) throws -> NativeAttachmentFiles.PublishedAttachmentProof {
        try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: stage,
            sha256: content.sha256, size: content.size, checkCancellation: check)
    }
    private func interruptedRename() throws {
        XCTAssertEqual(Darwin.rename(stageURL.path, target.path), 0)
    }
    private func refused(_ body: () throws -> Void) {
        XCTAssertThrowsError(try body()) { XCTAssertNotNil($0 as? NativeAttachmentFilesError) }
    }
    func testColdProofAfterSuccessfulPublicationPreservesSourceAndTarget() throws {
        try publish()
        files = try NativeAttachmentFiles(libraryRoot: root)
        let proof = try prove()
        XCTAssertEqual(proof.identity, stage.stagedIdentity)
        XCTAssertEqual(proof.directoryIdentity, stage.directoryIdentity)
        XCTAssertEqual(proof.sha256, content.sha256)
        XCTAssertEqual(proof.size, content.size)
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stageURL.deletingLastPathComponent().path))
        XCTAssertEqual(try prove(), proof)
    }
    func testColdProofOfRenameBeforeNamespaceRetirementRetainsDirectory() throws {
        try interruptedRename()
        files = try NativeAttachmentFiles(libraryRoot: root)
        XCTAssertEqual(try prove().identity, stage.stagedIdentity)
        XCTAssertTrue(FileManager.default.fileExists(atPath: stageURL.deletingLastPathComponent().path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stageURL.path))
    }
    func testSameHashDifferentInodeNeverAdopted() throws {
        try Data(contentsOf: source).write(to: target)
        refused { _ = try prove() }
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stageURL.path))
    }
    func testMissingTargetPreservesStage() throws {
        refused { _ = try prove() }
        XCTAssertEqual(try Data(contentsOf: stageURL), try Data(contentsOf: source))
    }
    func testWrongDigestSizeAndRootTokensRefusePublishedFile() throws {
        try publish()
        refused { _ = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: stage,
            sha256: String(repeating: "0", count: 64), size: content.size) }
        refused { _ = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: stage,
            sha256: content.sha256, size: content.size + 1) }
        let wrong = Stage(stageURI: stage.stageURI, stagedIdentity: stage.stagedIdentity,
            directoryIdentity: "0:0", privateDirectoryIdentity: stage.privateDirectoryIdentity)
        refused { _ = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: wrong,
            sha256: content.sha256, size: content.size) }
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
    }
    func testRemainingStageNameAndHardLinkRefuse() throws {
        XCTAssertEqual(Darwin.link(stageURL.path, target.path), 0)
        refused { _ = try prove() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: stageURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }
    func testReplacedPrivateDirectoryRefusesWithoutCleanup() throws {
        try interruptedRename()
        let directory = stageURL.deletingLastPathComponent()
        let retained = directory.appendingPathExtension("retained")
        try FileManager.default.moveItem(at: directory, to: retained)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        refused { _ = try prove() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: retained.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
    }
    func testSymlinkTargetAndPrivateNamespaceRefuse() throws {
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: stageURL)
        refused { _ = try prove() }
        try FileManager.default.removeItem(at: target)
        try publish()
        try FileManager.default.createSymbolicLink(at: stageURL.deletingLastPathComponent(), withDestinationURL: root)
        refused { _ = try prove() }
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
    }
    func testReplacedManagedRootRefusesAcrossColdOwner() throws {
        try publish()
        let managed = files.managedRoot
        let retained = managed.appendingPathExtension("retained")
        try FileManager.default.moveItem(at: managed, to: retained)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: false)


        try FileManager.default.moveItem(at: retained.appendingPathComponent(target.lastPathComponent), to: target)
        files = try NativeAttachmentFiles(libraryRoot: root)
        refused { _ = try prove() }
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
    }
    func testCancellationRetainsPublicationAndNamespace() throws {
        try interruptedRename()
        XCTAssertThrowsError(try prove { throw Stop.cancelled }) { XCTAssertTrue($0 is Stop) }
        XCTAssertEqual(try Data(contentsOf: target), try Data(contentsOf: source))
        XCTAssertTrue(FileManager.default.fileExists(atPath: stageURL.deletingLastPathComponent().path))
    }
    func testMutationDuringHashRefusesOriginalInodeChangedBytes() throws {
        try publish()
        var calls = 0
        refused {
            _ = try prove {
                calls += 1
                if calls == 2 {
                    let handle = try FileHandle(forWritingTo: target)
                    try handle.write(contentsOf: Data("changed".utf8)); try handle.close()
                }
            }
        }
        XCTAssertGreaterThanOrEqual(calls, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }
    func testNonManagedTargetAndInvalidProofRefuse() throws {
        refused { _ = try files.verifyPublishedAttachment(targetURI: source.absoluteString, stageProof: stage,
            sha256: content.sha256, size: content.size) }
        let bad = Stage(stageURI: target.absoluteString, stagedIdentity: stage.stagedIdentity,
            directoryIdentity: stage.directoryIdentity, privateDirectoryIdentity: stage.privateDirectoryIdentity)
        refused { _ = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: bad,
            sha256: content.sha256, size: content.size) }
        refused { _ = try files.verifyPublishedAttachment(targetURI: target.absoluteString, stageProof: stage,
            sha256: "bad", size: -1) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: stageURL.path))
    }
}
