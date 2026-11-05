import CryptoKit
import Foundation
import Darwin
import XCTest
import AttachmentFileInstallerEngine

// Ordinary package consumer: no @testable access, engine or fault injector.
final class AttachmentFileInstallerImmutableFacadeTests: XCTestCase {
  private let bytes = Data([0, 255, 10, 17, 128, 42])
  private let operationId = String(repeating: "1", count: 32)

  func testRetainedDirectoryPreparePublishAndPrivateRetirementUseHeldGeneration() throws {
    try withFixture { fixture in
      let root = fixture.attachments.resolvingSymlinksInPath(), target = root.appendingPathComponent("retained.bin")
      let descriptor = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
      guard descriptor >= 0 else { return XCTFail("Retained fixture root is unavailable") }
      defer { Darwin.close(descriptor) }
      let check = try retainedAuthority(root, descriptor: descriptor)
      let facade = try fixture.facade()
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId,
        directoryDescriptor: descriptor, requireAuthority: check)
      try bytes.write(to: prepared.stagedUrl)
      guard case .published = try facade.publishImmutable(stagedInput: prepared.stagedUrl, targetInput: target,
        expectedStagedSha256: digest(bytes), expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity,
        directoryDescriptor: descriptor, requireAuthority: check) else { return XCTFail("Retained publication did not complete") }
      XCTAssertEqual(try Data(contentsOf: target), bytes)
      let second = String(repeating: "2", count: 32)
      let partial = try facade.prepareImmutableStage(targetInput: target, operationId: second,
        directoryDescriptor: descriptor, requireAuthority: check)
      try Data([17]).write(to: partial.stagedUrl)
      guard case .removed = try facade.retireOwnedPrivateStage(stagedInput: partial.stagedUrl, targetInput: target, operationId: second,
        expectedStagedIdentity: partial.stagedIdentity, expectedDirectoryIdentity: partial.directoryIdentity,
        expectedPrivateDirectoryIdentity: partial.privateDirectoryIdentity, directoryDescriptor: descriptor, requireAuthority: check)
      else { return XCTFail("Retained partial stage was not retired") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: partial.stagedUrl.deletingLastPathComponent().path))
      XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
  }

  func testRetainedDirectoryLockWaitRefusesAncestorDirectoryAndSymlinkReplacement() throws {
    for symlink in [false, true] {
      try withFixture { fixture in
        let documents = fixture.root.appendingPathComponent("Documents", isDirectory: true)
        let managed = documents.appendingPathComponent("attachments", isDirectory: true)
        try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
        let root = managed.resolvingSymlinksInPath(), descriptor = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard descriptor >= 0 else { return XCTFail("Retained fixture root is unavailable") }
        defer { Darwin.close(descriptor) }
        let lock = Darwin.openat(descriptor, ".mindwtr-attachment-installer.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX) == 0 else { return XCTFail("Fixture lock is unavailable") }
        defer { _ = flock(lock, LOCK_UN); Darwin.close(lock) }
        let facade = try AttachmentFileInstaller(targetRoot: root, sourceRoots: [fixture.cache])
        let authority = try retainedAuthority(root, descriptor: descriptor), attempt = RetainedFacadeAttempt()
        let entered = DispatchSemaphore(value: 0), completed = DispatchSemaphore(value: 0)
        let operation = operationId
        let check: () throws -> Void = {
          try authority()
          if attempt.recordAuthority() { entered.signal() }
        }
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            _ = try facade.prepareImmutableStage(targetInput: root.appendingPathComponent("target.bin"),
              operationId: operation, directoryDescriptor: descriptor, requireAuthority: check)
            attempt.finish(refused: false)
          } catch { attempt.finish(refused: true) }
          completed.signal()
        }
        let waiting = entered.wait(timeout: .now() + 5)
        XCTAssertEqual(waiting, .success)
        guard waiting == .success else { _ = flock(lock, LOCK_UN); _ = completed.wait(timeout: .now() + 5); return }
        XCTAssertEqual(completed.wait(timeout: .now() + 0.05), .timedOut)
        let retained = fixture.root.appendingPathComponent("retained-documents", isDirectory: true)
        try FileManager.default.moveItem(at: documents, to: retained)
        let replacement = symlink ? fixture.root.appendingPathComponent("replacement-documents", isDirectory: true) : documents
        try FileManager.default.copyItem(at: retained, to: replacement)
        if symlink { try FileManager.default.createSymbolicLink(at: documents, withDestinationURL: replacement) }
        let replacementRoot = replacement.appendingPathComponent("attachments", isDirectory: true)
        let before = try FileManager.default.contentsOfDirectory(atPath: replacementRoot.path).sorted()
        XCTAssertEqual(flock(lock, LOCK_UN), 0)
        XCTAssertEqual(completed.wait(timeout: .now() + 5), .success)
        XCTAssertTrue(attempt.refused)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: replacementRoot.path).sorted(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: retained.appendingPathComponent("attachments/.mindwtr-install-" + operationId + ".candidate").path))
      }
    }
  }

  private func retainedAuthority(_ root: URL, descriptor: Int32) throws -> () throws -> Void {
    var expected = stat()
    guard Darwin.fstat(descriptor, &expected) == 0 else { throw NSError(domain: "RetainedFixture", code: 1) }
    let device = expected.st_dev, inode = expected.st_ino
    return {
      let current = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
      guard current >= 0 else { throw NSError(domain: "RetainedFixture", code: 2) }
      defer { Darwin.close(current) }
      var value = stat()
      guard Darwin.fstat(current, &value) == 0, value.st_dev == device, value.st_ino == inode else {
        throw NSError(domain: "RetainedFixture", code: 3)
      }
    }
  }

  func testTypedReservedWriterAppendsSameInodeAndPublishesVerifiedBytes() throws {
    try withFixture { fixture in
      let facade = try fixture.facade(), target = fixture.target("typed-writer.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target)
      try writer.append(bytes.prefix(2)); try writer.append(bytes.dropFirst(2)); try writer.synchronize(); writer.close()
      XCTAssertThrowsError(try writer.append(Data([1])))
      guard case .published = try facade.publishImmutable(stagedInput: prepared.stagedUrl, targetInput: target,
        expectedStagedSha256: digest(bytes), expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
      else { return XCTFail("Typed writer should retain the prepared publication inode") }
      XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
  }

  func testTypedReservedWriterRefusesReplacedStageAndHardlink() throws {
    try withFixture { fixture in
      let facade = try fixture.facade(), target = fixture.target("typed-replaced.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target); defer { writer.close() }
      try bytes.write(to: prepared.stagedUrl, options: .atomic)
      XCTAssertThrowsError(try writer.append(Data([1])))
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
    }
    try withFixture { fixture in
      let facade = try fixture.facade(), target = fixture.target("typed-linked.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target); defer { writer.close() }
      try FileManager.default.linkItem(at: prepared.stagedUrl, to: fixture.target("linked.bin"))
      XCTAssertThrowsError(try writer.append(Data([1])))
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), Data())
    }
  }

  func testTypedReservedWriterRefusesChangedParentAndBetweenChunkMutation() throws {
    try withFixture { fixture in
      let facade = try fixture.facade(), target = fixture.target("typed-parent.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target); defer { writer.close() }
      let parent = prepared.stagedUrl.deletingLastPathComponent(), moved = fixture.target("retained-parent")
      try FileManager.default.moveItem(at: parent, to: moved)
      try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
      try Data().write(to: prepared.stagedUrl)
      XCTAssertThrowsError(try writer.append(Data([1])))
      XCTAssertEqual(try Data(contentsOf: moved.appendingPathComponent("stage")), Data())
    }
    try withFixture { fixture in
      let facade = try fixture.facade(), target = fixture.target("typed-mutated.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target); defer { writer.close() }
      try writer.append(Data([1, 2]))
      try Data([9, 9, 9]).write(to: prepared.stagedUrl)
      XCTAssertThrowsError(try writer.synchronize())
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), Data([9, 9, 9]))
    }
  }

  func testPrepareWriteSnapshotPublishExposesTypedPublicProofAndExactBytes() throws {
    try withFixture { fixture in
      let facade = try fixture.facade()
      let target = fixture.target("published.bin")
      let prepared: ImmutableAttachmentPreparedStage = try facade.prepareImmutableStage(
        targetInput: target, operationId: operationId)
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), Data())
      XCTAssertFalse(prepared.stagedIdentity.isEmpty)
      XCTAssertFalse(prepared.directoryIdentity.isEmpty)
      XCTAssertFalse(prepared.privateDirectoryIdentity.isEmpty)
      try bytes.write(to: prepared.stagedUrl)
      let identity: ImmutableAttachmentStageIdentity = try facade.snapshotImmutableStage(
        stagedInput: prepared.stagedUrl, targetInput: target,
        expectedStagedSha256: " \n" + digest(bytes).uppercased() + "\t")
      let outcome: ImmutableAttachmentPublishOutcome = try facade.publishImmutable(
        stagedInput: prepared.stagedUrl, targetInput: target,
        expectedStagedSha256: "\n" + digest(bytes).uppercased() + " ",
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
      guard case .published = outcome else { return XCTFail("Expected exclusive publication") }
      XCTAssertEqual(try Data(contentsOf: target), bytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.deletingLastPathComponent().path))
      XCTAssertEqual(try fixture.facade().hash(target).sha256, digest(bytes))
    }
  }

  func testAtomicReplacementRequiresNewSnapshotAndRecreatedFacadeUsesSavedProof() throws {
    try withFixture { fixture in
      let target = fixture.target("recreated.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      // Atomic write creates a new inode while the original empty stage exists.
      try bytes.write(to: prepared.stagedUrl, options: .atomic)
      let identity = try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes))
      XCTAssertNotEqual(identity.stagedIdentity, prepared.stagedIdentity)
      XCTAssertThrowsError(try fixture.facade().publishImmutable(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      guard case .conflict = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
      else { return XCTFail("Stale empty-stage proof must not delete replacement bytes") }
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))

      // These are the persisted values a recreated consumer supplies, without
      // constructing internal proof types or retaining the original facade.
      let savedStageIdentity = identity.stagedIdentity
      let savedDirectoryIdentity = identity.directoryIdentity
      let savedPrivateIdentity = prepared.privateDirectoryIdentity
      let recreated = try fixture.facade()
      guard case .published = try recreated.publishImmutable(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: savedStageIdentity, expectedDirectoryIdentity: savedDirectoryIdentity,
        expectedPrivateDirectoryIdentity: savedPrivateIdentity)
      else { return XCTFail("Expected publication with recorded post-write proof") }
      XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
  }

  func testExistingSameAndDifferentTargetNeverAdoptsOverwritesOrConsumesStage() throws {
    for existing in [bytes, Data("peer generation".utf8)] {
      try withFixture { fixture in
        let target = fixture.target("existing.bin")
        let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
        try bytes.write(to: prepared.stagedUrl, options: .atomic)
        let identity = try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
          targetInput: target, expectedStagedSha256: digest(bytes))
        try existing.write(to: target)
        guard case .alreadyExists = try fixture.facade().publishImmutable(stagedInput: prepared.stagedUrl,
          targetInput: target, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
        else { return XCTFail("Existing bytes must not be adopted, even for the same digest") }
        XCTAssertEqual(try Data(contentsOf: target), existing)
        XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
        let cleanup: ImmutableAttachmentStageCleanupOutcome = try fixture.facade().cleanupImmutableStage(
          stagedInput: prepared.stagedUrl, targetInput: target, operationId: operationId,
          expectedStagedSha256: " " + digest(bytes).uppercased() + "\n",
          expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
        guard case .removed = cleanup else { return XCTFail("Expected exact owned-stage cleanup") }
        XCTAssertEqual(try Data(contentsOf: target), existing)
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.deletingLastPathComponent().path))
        guard case .missing = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
          targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
        else { return XCTFail("Recreated cleanup must be idempotent") }
        XCTAssertEqual(try Data(contentsOf: target), existing)
      }
    }
  }

  func testWrongDigestAndEveryWrongIdentityPreserveStageAndTarget() throws {
    try withFixture { fixture in
      let target = fixture.target("guarded.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl, options: .atomic)
      let identity = try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes))
      XCTAssertThrowsError(try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(Data("wrong".utf8))))
      for proof in [
        (digest(Data("wrong".utf8)), identity.stagedIdentity, identity.directoryIdentity, prepared.privateDirectoryIdentity),
        (digest(bytes), "0:0", identity.directoryIdentity, prepared.privateDirectoryIdentity),
        (digest(bytes), identity.stagedIdentity, "0:0", prepared.privateDirectoryIdentity),
        (digest(bytes), identity.stagedIdentity, identity.directoryIdentity, "0:0"),
      ] {
        XCTAssertThrowsError(try fixture.facade().publishImmutable(stagedInput: prepared.stagedUrl,
          targetInput: target, expectedStagedSha256: proof.0, expectedStagedIdentity: proof.1,
          expectedDirectoryIdentity: proof.2, expectedPrivateDirectoryIdentity: proof.3))
        XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
      }
      let cleanupProofs: [(String?, String?, String?)] = [
        (nil, nil, nil), ("0:0", identity.directoryIdentity, prepared.privateDirectoryIdentity),
        (identity.stagedIdentity, "0:0", prepared.privateDirectoryIdentity),
        (identity.stagedIdentity, identity.directoryIdentity, "0:0"),
      ]
      for proof in cleanupProofs {
        guard case .conflict = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
          targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: proof.0, expectedDirectoryIdentity: proof.1,
          expectedPrivateDirectoryIdentity: proof.2)
        else { return XCTFail("Wrong ownership proof must retain the stage") }
        XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      }
    }
  }

  func testReplacedPrivateDirectoryCannotUsePersistedOwnershipToken() throws {
    try withFixture { fixture in
      let target = fixture.target("directory-replaced.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl)
      let privateDirectory = prepared.stagedUrl.deletingLastPathComponent()
      let retainedDirectory = fixture.cache.appendingPathComponent("retained-private", isDirectory: true)
      try FileManager.default.moveItem(at: privateDirectory, to: retainedDirectory)
      try FileManager.default.createDirectory(at: privateDirectory, withIntermediateDirectories: false)
      try bytes.write(to: prepared.stagedUrl)
      let replacementIdentity = try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes))
      XCTAssertThrowsError(try fixture.facade().publishImmutable(stagedInput: prepared.stagedUrl,
        targetInput: target, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: replacementIdentity.stagedIdentity,
        expectedDirectoryIdentity: replacementIdentity.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      guard case .conflict = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: replacementIdentity.stagedIdentity,
        expectedDirectoryIdentity: replacementIdentity.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
      else { return XCTFail("Replaced private namespace must retain uncertain bytes") }
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertEqual(try Data(contentsOf: retainedDirectory.appendingPathComponent("stage")), bytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  func testPrivateCleanupUsesRecordedInodeForPartialBytesWithoutDigestClaim() throws {
    try withFixture { fixture in
      let target = fixture.target("partial.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      // Fill in place to retain the reserved inode; private cleanup intentionally
      // relies on ownership tokens, even when the intended full digest differs.
      let handle = try FileHandle(forWritingTo: prepared.stagedUrl)
      try handle.write(contentsOf: Data("partial".utf8))
      try handle.close()
      guard case .removed = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
      else { return XCTFail("Expected existing private-stage ownership cleanup contract") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  func testLegacyWrongDigestRetainsBytesInQuarantineAndRecreatedCleanupRecovers() throws {
    try withFixture { fixture in
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("legacy-target.bin")
      try bytes.write(to: staged)
      let existing = Data("peer target".utf8)
      try existing.write(to: target)
      let identity = try fixture.facade().snapshotImmutableStage(stagedInput: staged,
        targetInput: target, expectedStagedSha256: digest(bytes))
      guard case .conflict = try fixture.facade().cleanupImmutableStage(stagedInput: staged,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(Data("wrong".utf8)),
        expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil)
      else { return XCTFail("Wrong digest must retain uncertain legacy bytes") }
      let quarantined = fixture.target(".mindwtr-install-\(operationId).quarantine/stage")
      XCTAssertEqual(try Data(contentsOf: quarantined), bytes)
      XCTAssertEqual(try Data(contentsOf: target), existing)
      guard case .removed = try fixture.facade().cleanupImmutableStage(stagedInput: staged,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil)
      else { return XCTFail("Expected cleanup of recorded legacy quarantine") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: quarantined.deletingLastPathComponent().path))
      XCTAssertEqual(try Data(contentsOf: target), existing)
      guard case .missing = try fixture.facade().cleanupImmutableStage(stagedInput: staged,
        targetInput: target, operationId: operationId, expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: identity.stagedIdentity, expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil)
      else { return XCTFail("Expected idempotent missing legacy stage") }
    }
  }

  func testMalformedDigestsRefuseWithFixedErrorsWithoutChangingBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("malformed.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl)
      for value in ["", "private-secret-not-a-digest", String(repeating: "g", count: 64)] {
        let calls: [() throws -> Void] = [
          { _ = try fixture.facade().snapshotImmutableStage(stagedInput: prepared.stagedUrl,
            targetInput: target, expectedStagedSha256: value) },
          { _ = try fixture.facade().publishImmutable(stagedInput: prepared.stagedUrl,
            targetInput: target, expectedStagedSha256: value, expectedStagedIdentity: prepared.stagedIdentity,
            expectedDirectoryIdentity: prepared.directoryIdentity,
            expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity) },
          { _ = try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
            targetInput: target, operationId: self.operationId, expectedStagedSha256: value,
            expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
            expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity) },
        ]
        for call in calls {
          XCTAssertThrowsError(try call()) { error in
            XCTAssertEqual(error.localizedDescription,
              "ATTACHMENT_FILE_INSTALLER_FAILED: Expected staged attachment SHA-256 is invalid")
          }
        }
        XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
      }
    }
  }

  func testNonFileAndExternalPathsRefuseAndPreserveExistingBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("contained.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl)
      let remote = try XCTUnwrap(URL(string: "https://example.invalid/private-path"))
      let external = fixture.cache.appendingPathComponent("external.bin")
      let existing = Data("external bytes".utf8)
      try existing.write(to: external)
      for invalid in [remote, external] {
        XCTAssertThrowsError(try fixture.facade().prepareImmutableStage(targetInput: invalid, operationId: operationId))
        for inputs in [(invalid, target), (prepared.stagedUrl, invalid)] {
          XCTAssertThrowsError(try fixture.facade().snapshotImmutableStage(stagedInput: inputs.0,
            targetInput: inputs.1, expectedStagedSha256: digest(bytes)))
          XCTAssertThrowsError(try fixture.facade().publishImmutable(stagedInput: inputs.0,
            targetInput: inputs.1, expectedStagedSha256: digest(bytes),
            expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
            expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
          XCTAssertThrowsError(try fixture.facade().cleanupImmutableStage(stagedInput: inputs.0,
            targetInput: inputs.1, operationId: operationId, expectedStagedSha256: digest(bytes),
            expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
            expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
        }
      }
      XCTAssertEqual(try Data(contentsOf: external), existing)
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  func testSymlinkStageAndTargetRefuseWithoutMutatingReferencedBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("symlink-peer.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl)
      let peer = Data("peer bytes".utf8)
      try peer.write(to: target)
      let stageLink = fixture.cache.appendingPathComponent("stage-link")
      let targetLink = fixture.target("target-link")
      try FileManager.default.createSymbolicLink(at: stageLink, withDestinationURL: prepared.stagedUrl)
      try FileManager.default.createSymbolicLink(at: targetLink, withDestinationURL: target)
      for inputs in [(stageLink, target), (prepared.stagedUrl, targetLink)] {
        XCTAssertThrowsError(try fixture.facade().snapshotImmutableStage(stagedInput: inputs.0,
          targetInput: inputs.1, expectedStagedSha256: digest(bytes)))
        XCTAssertThrowsError(try fixture.facade().publishImmutable(stagedInput: inputs.0,
          targetInput: inputs.1, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
        XCTAssertThrowsError(try fixture.facade().cleanupImmutableStage(stagedInput: inputs.0,
          targetInput: inputs.1, operationId: operationId, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      }
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertEqual(try Data(contentsOf: target), peer)
    }
  }

  func testInvalidOrMismatchedOperationIDsPreserveReservedBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("operation.bin")
      let prepared = try fixture.facade().prepareImmutableStage(targetInput: target, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl)
      for invalid in ["", "../outside", String(repeating: "A", count: 32), String(repeating: "a", count: 31)] {
        XCTAssertThrowsError(try fixture.facade().prepareImmutableStage(targetInput: target, operationId: invalid))
        XCTAssertThrowsError(try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
          targetInput: target, operationId: invalid, expectedStagedSha256: digest(bytes),
          expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
          expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      }
      XCTAssertThrowsError(try fixture.facade().cleanupImmutableStage(stagedInput: prepared.stagedUrl,
        targetInput: target, operationId: String(repeating: "2", count: 32), expectedStagedSha256: digest(bytes),
        expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  private func withFixture(_ body: (ImmutableFacadeFixture) throws -> Void) throws {
    let fixture = try ImmutableFacadeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    try body(fixture)
  }

  private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

private struct ImmutableFacadeFixture {
  let root: URL
  let attachments: URL
  let cache: URL

  init() throws {
    root = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".mindwtr-native-tests/attachment-immutable-facade-xctest-\(UUID().uuidString)", isDirectory: true)
    attachments = root.appendingPathComponent("attachments", isDirectory: true)
    cache = root.appendingPathComponent("cache", isDirectory: true)
    try FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
  }

  func facade() throws -> AttachmentFileInstaller {
    try AttachmentFileInstaller(targetRoot: attachments, sourceRoots: [cache])
  }

  func target(_ name: String) -> URL { attachments.appendingPathComponent(name) }
}

private final class RetainedFacadeAttempt: @unchecked Sendable {
  private let lock = NSLock()
  private var stored = false
  private var calls = 0
  func recordAuthority() -> Bool { lock.lock(); defer { lock.unlock() }; calls += 1; return calls == 2 }
  func finish(refused: Bool) { lock.lock(); stored = refused; lock.unlock() }
  var refused: Bool { lock.lock(); defer { lock.unlock() }; return stored }
}
