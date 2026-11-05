import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import AttachmentFileInstallerEngine

final class AttachmentFileInstallerEngineTests: XCTestCase {
  private enum SimulatedCrash: Error {
    case fault
  }

  func testNativeHasherStreamsStableManagedGeneration() throws {
    try withFixture { fixture in
      let target = fixture.target("hash.bin")
      try write("managed generation", to: target)

      let snapshot = try AttachmentFileHashingEngine(
        targetRoot: target.deletingLastPathComponent()
      ).hash(target)

      XCTAssertEqual(snapshot.sha256, digest("managed generation"))
      XCTAssertEqual(snapshot.size, UInt64("managed generation".utf8.count))
    }
  }

  func testNativeHasherRejectsSymlinkTarget() throws {
    try withFixture { fixture in
      let peer = fixture.target("peer.bin")
      let link = fixture.target("link.bin")
      try write("peer generation", to: peer)
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: peer)

      XCTAssertThrowsError(
        try AttachmentFileHashingEngine(
          targetRoot: link.deletingLastPathComponent()
        ).hash(link)
      )
    }
  }

  func testAbsentGenerationUsesCreateNoReplace() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("downloaded generation")
      let target = fixture.target("absent.bin")

      let installed = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: .absent,
        expectedDownloadSha256: digest("downloaded generation")
      )

      assertInstalled(installed)
      XCTAssertEqual(try contents(target), "downloaded generation")
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))

      let conflictingStage = try fixture.stage("peer candidate")
      let conflict = try fixture.engine().install(
        stagedInput: conflictingStage,
        targetInput: target,
        expected: .absent,
        expectedDownloadSha256: digest("peer candidate")
      )

      assertConflict(conflict, preservedUrl: conflictingStage)
      XCTAssertEqual(try contents(target), "downloaded generation")
      XCTAssertEqual(try contents(conflictingStage), "peer candidate")
    }
  }

  func testSourceContainmentAcceptsAbsoluteDescendantAndRejectsSiblingPrefix() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("managed candidate")
      let target = fixture.target("managed.bin")
      XCTAssertTrue(staged.path.hasPrefix("/"))

      let installed = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: .absent,
        expectedDownloadSha256: digest("managed candidate")
      )
      assertInstalled(installed)

      let outside = try fixture.stageOutsideManagedRoots("peer candidate")
      let untouchedTarget = fixture.target("outside.bin")
      XCTAssertThrowsError(try fixture.engine().install(
        stagedInput: outside,
        targetInput: untouchedTarget,
        expected: .absent,
        expectedDownloadSha256: digest("peer candidate")
      ))
      XCTAssertEqual(try contents(outside), "peer candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: untouchedTarget.path))
    }
  }

  func testImmutablePublisherCreatesNoSharedInstallerRecoveryArtifacts() throws {
    try withFixture { fixture in
      let target = fixture.target("a.\(digest("candidate")).txt")
      let prepared = try fixture.engine().prepareImmutableStage(
        targetInput: target,
        operationId: String(repeating: "1", count: 32)
      )
      let staged = prepared.stagedUrl
      try write("candidate", to: staged)

      let outcome = try fixture.engine().publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity
      )

      guard case .published = outcome else { return XCTFail("Expected published outcome") }
      XCTAssertEqual(try contents(target), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
    }
  }

  func testImmutablePublisherPreservesReplacementPrivateDirectoryAtRetirement() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "7", count: 32)
      let target = fixture.target("a.\(digest("candidate")).txt")
      let prepared = try fixture.engine().prepareImmutableStage(
        targetInput: target,
        operationId: operationId
      )
      let staged = prepared.stagedUrl
      let privateDirectory = staged.deletingLastPathComponent()
      let displacedDirectory = fixture.root.appendingPathComponent(
        "displaced-private-directory",
        isDirectory: true
      )
      try write("candidate", to: staged)
      let racing = fixture.engine { point in
        guard point == .beforeImmutablePrivateDirectoryRetirement else { return }
        try FileManager.default.moveItem(at: privateDirectory, to: displacedDirectory)
        try FileManager.default.createDirectory(
          at: privateDirectory,
          withIntermediateDirectories: false
        )
      }

      XCTAssertThrowsError(try racing.publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity
      ))
      XCTAssertEqual(try contents(target), "candidate")
      XCTAssertTrue(FileManager.default.fileExists(atPath: privateDirectory.path))
      XCTAssertTrue(FileManager.default.fileExists(atPath: displacedDirectory.path))
    }
  }

  func testImmutablePublisherPreservesOwnedStageAndPeerTargetOnCollision() throws {
    try withFixture { fixture in
      let target = fixture.target("a.\(digest("candidate")).txt")
      let prepared = try fixture.engine().prepareImmutableStage(
        targetInput: target,
        operationId: String(repeating: "2", count: 32)
      )
      let staged = prepared.stagedUrl
      try write("candidate", to: staged)
      try write("peer-corruption", to: target)

      let outcome = try fixture.engine().publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity
      )

      guard case .alreadyExists = outcome else { return XCTFail("Expected already-exists outcome") }
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertEqual(try contents(target), "peer-corruption")
      XCTAssertEqual(try fixture.internalArtifacts().count, 1)
    }
  }

  func testPreparedPrivateStageRecoveryRemovesOnlyRecordedInode() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "4", count: 32)
      let target = fixture.target("a.\(digest("candidate")).txt")
      let engine = fixture.engine()
      let prepared = try engine.prepareImmutableStage(
        targetInput: target,
        operationId: operationId
      )
      try write("partial", to: prepared.stagedUrl)

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: prepared.stagedUrl,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity
      )

      guard case .removed = outcome else { return XCTFail("Expected removed outcome") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.deletingLastPathComponent().path))
    }
  }

  func testImmutablePublisherRejectsVerifiedStageNameSwap() throws {
    try withFixture { fixture in
      let target = fixture.target("a.\(digest("candidate")).txt")
      let prepared = try fixture.engine().prepareImmutableStage(
        targetInput: target,
        operationId: String(repeating: "3", count: 32)
      )
      try write("candidate", to: prepared.stagedUrl)
      let displaced = prepared.stagedUrl.deletingLastPathComponent()
        .appendingPathComponent("displaced-stage")
      let racing = fixture.engine { point in
        guard point == .beforeImmutablePublication else { return }
        try FileManager.default.moveItem(at: prepared.stagedUrl, to: displaced)
        try self.write("replacement", to: prepared.stagedUrl)
      }

      XCTAssertThrowsError(try racing.publishImmutable(
        stagedInput: prepared.stagedUrl,
        targetInput: target,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: prepared.stagedIdentity,
        expectedDirectoryIdentity: prepared.directoryIdentity,
        expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity
      ))
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
      XCTAssertEqual(try contents(displaced), "candidate")
      XCTAssertEqual(try contents(prepared.stagedUrl), "replacement")
    }
  }

  func testOwnedStageRecoveryDeletesOnlyRecordedInodeAndDigest() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "a", count: 32)
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      let engine = fixture.engine()
      let identity = try engine.snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil
      )

      guard case .removed = outcome else { return XCTFail("Expected removed outcome") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
    }
  }

  func testOwnedStageRecoveryPreservesReplacementInodeWithSameDigest() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "b", count: 32)
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      let engine = fixture.engine()
      let identity = try engine.snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )
      try FileManager.default.removeItem(at: staged)
      try write("candidate", to: staged)

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil
      )

      guard case .conflict = outcome else { return XCTFail("Expected conflict outcome") }
      let preserved = fixture.target(".mindwtr-install-\(operationId).quarantine/stage")
      XCTAssertEqual(try contents(preserved), "candidate")
    }
  }

  func testOwnedStageRecoveryPreservesPreexistingQuarantineAmbiguity() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "c", count: 32)
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      let engine = fixture.engine()
      let identity = try engine.snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )
      let quarantine = fixture.target(".mindwtr-install-\(operationId).quarantine")
      try FileManager.default.createDirectory(at: quarantine, withIntermediateDirectories: false)
      try write("peer", to: quarantine.appendingPathComponent("stage"))

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil
      )

      guard case .conflict = outcome else { return XCTFail("Expected conflict outcome") }
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertEqual(try contents(quarantine.appendingPathComponent("stage")), "peer")
    }
  }

  func testOwnedStageRecoveryRejectsReplacedAttachmentRoot() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "d", count: 32)
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      let engine = fixture.engine()
      let identity = try engine.snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )
      let originalRoot = try fixture.replaceAttachmentsRoot()

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil
      )

      guard case .conflict = outcome else { return XCTFail("Expected conflict outcome") }
      XCTAssertEqual(try contents(originalRoot.appendingPathComponent(staged.lastPathComponent)), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
    }
  }

  func testOwnedStageRecoveryPreservesReplacementDirectory() throws {
    try withFixture { fixture in
      let operationId = String(repeating: "e", count: 32)
      let staged = fixture.target(".mindwtr-generation-stage-\(operationId).tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      let engine = fixture.engine()
      let identity = try engine.snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )
      try FileManager.default.removeItem(at: staged)
      try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: false)
      try write("peer", to: staged.appendingPathComponent("peer"))

      let outcome = try engine.cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: digest("candidate"),
        expectedStagedIdentity: identity.stagedIdentity,
        expectedDirectoryIdentity: identity.directoryIdentity,
        expectedPrivateDirectoryIdentity: nil
      )

      guard case .conflict = outcome else { return XCTFail("Expected conflict outcome") }
      XCTAssertEqual(try contents(staged.appendingPathComponent("peer")), "peer")
    }
  }

  func testPresentGenerationReplacesOnlyMatchingTargetAndPreservesIt() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("new generation")
      let target = fixture.target("present.bin")
      try write("old generation", to: target)

      let outcome = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: .present(sha256: digest("old generation")),
        expectedDownloadSha256: digest("new generation")
      )

      let preserved = try installedPreservedUrl(outcome)
      XCTAssertEqual(try contents(target), "new generation")
      XCTAssertEqual(try contents(preserved), "old generation")

      let conflictingStage = try fixture.stage("later generation")
      let conflict = try fixture.engine().install(
        stagedInput: conflictingStage,
        targetInput: target,
        expected: .present(sha256: digest("unexpected generation")),
        expectedDownloadSha256: digest("later generation")
      )

      assertConflict(conflict, preservedUrl: conflictingStage)
      XCTAssertEqual(try contents(target), "new generation")
      XCTAssertEqual(try contents(conflictingStage), "later generation")
    }
  }

  func testInitialJournalCrashRecoversUntouchedTargetAndRetries() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("new generation")
      let target = fixture.target("journal.bin")
      try write("old generation", to: target)
      let expected = ExpectedAttachmentGeneration.present(sha256: digest("old generation"))

      XCTAssertThrowsError(
        try fixture.engine { point in
          if point == .afterInitialJournal { throw SimulatedCrash.fault }
        }.install(
          stagedInput: staged,
          targetInput: target,
          expected: expected,
          expectedDownloadSha256: digest("new generation")
        )
      )
      XCTAssertEqual(try contents(target), "old generation")
      XCTAssertEqual(try fixture.internalArtifacts(suffix: ".journal").count, 1)

      let outcome = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: expected,
        expectedDownloadSha256: digest("new generation")
      )

      let preserved = try installedPreservedUrl(outcome)
      XCTAssertEqual(try contents(target), "new generation")
      XCTAssertEqual(try contents(preserved), "old generation")
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
    }
  }

  func testLinkBeforeUnlinkCrashRecoversBothNamesAndRetries() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("new generation")
      let target = fixture.target("link-crash.bin")
      try write("old generation", to: target)
      let expected = ExpectedAttachmentGeneration.present(sha256: digest("old generation"))
      var linkCount = 0

      XCTAssertThrowsError(
        try fixture.engine { point in
          guard point == .afterExclusiveLink else { return }
          linkCount += 1
          if linkCount == 1 { throw SimulatedCrash.fault }
        }.install(
          stagedInput: staged,
          targetInput: target,
          expected: expected,
          expectedDownloadSha256: digest("new generation")
        )
      )
      XCTAssertEqual(try contents(target), "old generation")
      XCTAssertEqual(try fixture.internalArtifacts(suffix: ".quarantine").count, 1)

      let outcome = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: expected,
        expectedDownloadSha256: digest("new generation")
      )

      let preserved = try installedPreservedUrl(outcome)
      XCTAssertEqual(try contents(target), "new generation")
      XCTAssertEqual(try contents(preserved), "old generation")
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
    }
  }

  func testLateWriterMutatesRetainedOldInodeWithoutTouchingInstalledGeneration() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("new generation")
      let target = fixture.target("late-writer.bin")
      try write("old generation", to: target)
      let writer = try FileHandle(forWritingTo: target)
      defer { try? writer.close() }

      let outcome = try fixture.engine().install(
        stagedInput: staged,
        targetInput: target,
        expected: .present(sha256: digest("old generation")),
        expectedDownloadSha256: digest("new generation")
      )
      let preserved = try installedPreservedUrl(outcome)

      try writer.seek(toOffset: 0)
      try writer.write(contentsOf: Data("late old bytes".utf8))
      try writer.truncate(atOffset: UInt64(Data("late old bytes".utf8).count))
      try writer.synchronize()

      XCTAssertEqual(try contents(target), "new generation")
      XCTAssertEqual(try contents(preserved), "late old bytes")
    }
  }

  private func withFixture(_ body: (Fixture) throws -> Void) throws {
    let fixture = try Fixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    try body(fixture)
  }

  private func assertInstalled(
    _ outcome: AttachmentInstallOutcome,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard case .installed = outcome else {
      XCTFail("Expected installed outcome", file: file, line: line)
      return
    }
  }

  private func installedPreservedUrl(
    _ outcome: AttachmentInstallOutcome,
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws -> URL {
    guard case .installed(let preservedUrl) = outcome, let preservedUrl else {
      XCTFail("Expected installed outcome with preserved generation", file: file, line: line)
      throw SimulatedCrash.fault
    }
    return preservedUrl
  }

  private func assertConflict(
    _ outcome: AttachmentInstallOutcome,
    preservedUrl: URL,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard case .conflict(let actual) = outcome else {
      XCTFail("Expected conflict outcome", file: file, line: line)
      return
    }
    XCTAssertEqual(actual.standardizedFileURL, preservedUrl.standardizedFileURL, file: file, line: line)
  }

  private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func contents(_ file: URL) throws -> String {
    try String(contentsOf: file, encoding: .utf8)
  }

  private func write(_ value: String, to file: URL) throws {
    try value.write(to: file, atomically: false, encoding: .utf8)
  }
}

private struct Fixture {
  let root: URL
  private let filesRoot: URL
  private let cacheRoot: URL
  private let attachmentsRoot: URL

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("attachment-installer-xctest-\(UUID().uuidString)", isDirectory: true)
    filesRoot = root.appendingPathComponent("files", isDirectory: true)
    cacheRoot = root.appendingPathComponent("cache", isDirectory: true)
    attachmentsRoot = filesRoot.appendingPathComponent("attachments", isDirectory: true)
    try FileManager.default.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
  }

  func engine(
    faultInjector: @escaping (AttachmentFileInstallerFaultPoint) throws -> Void = { _ in }
  ) -> AttachmentFileInstallerEngine {
    AttachmentFileInstallerEngine(
      targetRoot: attachmentsRoot,
      sourceRoots: [filesRoot, cacheRoot],
      faultInjector: faultInjector
    )
  }

  func stage(_ value: String) throws -> URL {
    let file = cacheRoot.appendingPathComponent("stage-\(UUID().uuidString).bin")
    try value.write(to: file, atomically: false, encoding: .utf8)
    return file
  }

  func stageOutsideManagedRoots(_ value: String) throws -> URL {
    let sibling = root.appendingPathComponent("cache-peer", isDirectory: true)
    try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: false)
    let file = sibling.appendingPathComponent("stage.bin")
    try value.write(to: file, atomically: false, encoding: .utf8)
    return file
  }

  func target(_ name: String) -> URL {
    attachmentsRoot.appendingPathComponent(name)
  }

  func replaceAttachmentsRoot() throws -> URL {
    let original = root.appendingPathComponent("original-attachments", isDirectory: true)
    try FileManager.default.moveItem(at: attachmentsRoot, to: original)
    try FileManager.default.createDirectory(at: attachmentsRoot, withIntermediateDirectories: true)
    return original
  }

  func internalArtifacts(suffix: String? = nil) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(
      at: attachmentsRoot,
      includingPropertiesForKeys: nil
    ).filter { file in
      file.lastPathComponent.hasPrefix(".mindwtr-install-")
        && (suffix == nil || file.lastPathComponent.hasSuffix(suffix!))
    }
  }
}


final class RetainedProviderInstallerEngineTests: XCTestCase {
  private enum Interrupted: Error { case boundary }

  func testRetainedHashReturnsOneStableNamedGenerationAndRefusesReplacement() throws {
    try withFixture { fixture in
      let target = fixture.file("hash.txt")
      try Data("snapshot".utf8).write(to: target)
      let snapshot = try fixture.engine().hash(target, directoryDescriptor: fixture.descriptor, requireAuthority: fixture.check)
      XCTAssertEqual(snapshot.sha256, fixture.digest("snapshot"))
      XCTAssertEqual(snapshot.size, 8)
      XCTAssertEqual(snapshot.modificationTimeMs,
        try XCTUnwrap(target.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate).timeIntervalSince1970 * 1000, accuracy: 1)
      let before = try fixture.inode(target)
      let engine = fixture.engine { point in
        if point == .afterRetainedHashRead { try Data("snapshot".utf8).write(to: target, options: .atomic) }
      }
      XCTAssertThrowsError(try engine.hash(target, directoryDescriptor: fixture.descriptor, requireAuthority: fixture.check))
      XCTAssertNotEqual(try fixture.inode(target), before)
      XCTAssertEqual(try Data(contentsOf: target), Data("snapshot".utf8))
    }
  }

  func testRetainedAbsentReplayConflictWrongDigestAndPresentPreservation() throws {
    try withFixture { fixture in
      let target = fixture.file("current.txt"), first = try fixture.stage("first")
      guard case .installed(let absentPreserved) = try fixture.install(first, target, "first") else { return XCTFail("Expected install") }
      XCTAssertNil(absentPreserved)
      XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
      let replay = try fixture.stage("first")
      guard case .installed = try fixture.install(replay, target, "first") else { return XCTFail("Expected replay") }
      XCTAssertFalse(FileManager.default.fileExists(atPath: replay.path))
      let conflictStage = try fixture.stage("conflict")
      guard case .conflict(let conflict) = try fixture.install(conflictStage, target, "conflict") else { return XCTFail("Expected conflict") }
      XCTAssertEqual(conflict, conflictStage)
      let bad = try fixture.stage("actual")
      XCTAssertThrowsError(try fixture.install(bad, target, "different"))
      XCTAssertEqual(try Data(contentsOf: bad), Data("actual".utf8))
      let stale = try fixture.stage("stale")
      guard case .conflict(let stalePreserved) = try fixture.install(stale, target, "stale", expected: .present(sha256: fixture.digest("other"))) else { return XCTFail("Expected stale conflict") }
      XCTAssertEqual(stalePreserved, stale)
      XCTAssertEqual(try Data(contentsOf: target), Data("first".utf8))
      let next = try fixture.stage("second")
      guard case .installed(let preserved) = try fixture.install(next, target, "second", expected: .present(sha256: fixture.digest("first"))) else { return XCTFail("Expected replacement") }
      XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preserved)), Data("first".utf8))
      XCTAssertEqual(try Data(contentsOf: target), Data("second".utf8))
      XCTAssertEqual(try fixture.artifacts(), [])
    }
  }

  func testRetainedColdRecoveryAtInitialJournalAndEveryExclusiveLink() throws {
    for boundary in 0...3 {
      try withFixture { fixture in
        let target = fixture.file("recover.txt"), stage = try fixture.stage("new")
        try Data("old".utf8).write(to: target)
        var links = 0
        let interrupted = fixture.engine { point in
          if boundary == 0 && point == .afterInitialJournal { throw Interrupted.boundary }
          if point == .afterExclusiveLink {
            links += 1
            if links == boundary { throw Interrupted.boundary }
          }
        }
        XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old")), engine: interrupted))
        XCTAssertEqual(try fixture.artifacts(suffix: ".journal").count, 1)
        guard case .installed(let preserved) = try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old"))) else { return XCTFail("Expected cold recovery") }
        XCTAssertEqual(try Data(contentsOf: target), Data("new".utf8))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preserved)), Data("old".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertEqual(try fixture.artifacts(), [])
        var value = stat()
        XCTAssertEqual(lstat(target.path, &value), 0)
        XCTAssertEqual(value.st_nlink, 1)
      }
    }
  }

  func testRetainedColdCASMismatchRollbackLinkReturnsConflictAndKeepsActualLocalGeneration() throws {
    try withFixture { fixture in
      let target = fixture.file("rollback.txt"), stage = try fixture.stage("incoming")
      try Data("actual local".utf8).write(to: target)
      var links = 0
      let engine = fixture.engine { point in
        if point == .afterExclusiveLink { links += 1; if links == 2 { throw Interrupted.boundary } }
      }
      let stale = ExpectedAttachmentGeneration.present(sha256: fixture.digest("stale expected"))
      XCTAssertThrowsError(try fixture.install(stage, target, "incoming", expected: stale, engine: engine))
      let before = try fixture.inode(target), journal = try XCTUnwrap(fixture.artifacts(suffix: ".journal").first)
      let journalBytes = try Data(contentsOf: journal), candidate = try XCTUnwrap(fixture.artifacts(suffix: ".candidate").first)
      guard case .conflict(let preserved) = try fixture.install(stage, target, "incoming", expected: stale) else { return XCTFail("Expected recovered CAS conflict") }
      XCTAssertEqual(preserved, candidate)
      XCTAssertEqual(try fixture.inode(target), before)
      XCTAssertEqual(try Data(contentsOf: target), Data("actual local".utf8))
      XCTAssertEqual(try Data(contentsOf: stage), Data("incoming".utf8))
      XCTAssertEqual(try Data(contentsOf: candidate), Data("incoming".utf8))
      XCTAssertEqual(try Data(contentsOf: journal), journalBytes)
      XCTAssertEqual(try fixture.artifacts(suffix: ".quarantine"), [])
      guard case .conflict(let repeated) = try fixture.install(stage, target, "incoming", expected: stale) else { return XCTFail("Expected retained conflict evidence") }
      XCTAssertEqual(repeated, candidate)
      var value = stat()
      XCTAssertEqual(lstat(target.path, &value), 0); XCTAssertEqual(value.st_nlink, 1)
    }
  }

  func testRetainedColdAbsentPublicationLinkCompletesWithoutReplacingTarget() throws {
    try withFixture { fixture in
      let target = fixture.file("absent.txt"), stage = try fixture.stage("new")
      let engine = fixture.engine { if $0 == .afterExclusiveLink { throw Interrupted.boundary } }
      XCTAssertThrowsError(try fixture.install(stage, target, "new", engine: engine))
      let identity = try fixture.inode(target)
      guard case .installed = try fixture.install(stage, target, "new") else { return XCTFail("Expected recovery") }
      XCTAssertEqual(try fixture.inode(target), identity)
      XCTAssertEqual(try Data(contentsOf: target), Data("new".utf8))
      XCTAssertEqual(try fixture.artifacts(), [])
    }
  }

  func testRetainedRecoveryKeepsRecordedAndFreshPreservationAliases() throws {
    try withFixture { fixture in
      let target = fixture.file("fresh.txt"), stage = try fixture.stage("new")
      try Data("old".utf8).write(to: target)
      var links = 0
      let interrupted = fixture.engine { point in
        if point == .afterExclusiveLink { links += 1; if links == 2 { throw Interrupted.boundary } }
      }
      XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old")), engine: interrupted))
      let journal = try XCTUnwrap(fixture.artifacts(suffix: ".journal").first)
      let prefix = ".mindwtr-preserved-" + fixture.slot(target) + "-"
      let recorded = fixture.file(prefix + "0"), fresh = fixture.file(prefix + "1")
      try Data("old".utf8).write(to: recorded)
      let recordedInode = try fixture.inode(recorded)
      try fixture.amend(journal) { $0["preservationPath"] = recorded.path }
      let second = fixture.engine { if $0 == .afterExclusiveLink { throw Interrupted.boundary } }
      XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old")), engine: second))
      XCTAssertNotEqual(try fixture.inode(fresh), recordedInode)
      guard case .installed(let preserved) = try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old"))) else { return XCTFail("Expected fresh alias recovery") }
      XCTAssertEqual(preserved, recorded)
      XCTAssertEqual(try fixture.inode(recorded), recordedInode)
      XCTAssertEqual(try Data(contentsOf: recorded), Data("old".utf8))
      XCTAssertEqual(try Data(contentsOf: fresh), Data("old".utf8))
      XCTAssertEqual(try Data(contentsOf: target), Data("new".utf8))
      XCTAssertEqual(try fixture.artifacts(), [])
    }
  }

  func testRetainedLateWriterKeepsOldInodeAndMutatedCrashAliasEvidence() throws {
    try withFixture { fixture in
      let target = fixture.file("late.txt"), stage = try fixture.stage("new")
      try Data("old".utf8).write(to: target)
      let writer = try FileHandle(forWritingTo: target)
      defer { try? writer.close() }
      guard case .installed(let preserved) = try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old"))) else { return XCTFail("Expected replacement") }
      try writer.write(contentsOf: Data("late".utf8)); try writer.truncate(atOffset: 4); try writer.synchronize()
      XCTAssertEqual(try Data(contentsOf: target), Data("new".utf8))
      XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preserved)), Data("late".utf8))
    }
    try withFixture { fixture in
      let target = fixture.file("crash-late.txt"), stage = try fixture.stage("new")
      try Data("old".utf8).write(to: target)
      let writer = try FileHandle(forWritingTo: target)
      defer { try? writer.close() }
      var links = 0
      let engine = fixture.engine { point in
        if point == .afterExclusiveLink { links += 1; if links == 3 { throw Interrupted.boundary } }
      }
      XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old")), engine: engine))
      try writer.write(contentsOf: Data("late".utf8)); try writer.truncate(atOffset: 4); try writer.synchronize()
      let before = try fixture.snapshot()
      XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old"))))
      XCTAssertEqual(try fixture.snapshot(), before)
      XCTAssertEqual(try Data(contentsOf: target), Data("new".utf8))
      XCTAssertEqual(try fixture.artifacts(suffix: ".quarantine").count, 1)
    }
  }

  func testRetainedJournalPreflightRefusesMalformedEscapingOldAndMismatchedRecordsWithoutMutation() throws {
    for mode in ["malformed", "oversized", "old-target", "escaping-stage", "wrong-slot", "wrong-optional", "escaping-preservation"] {
      try withFixture { fixture in
        let target = fixture.file("owned.txt"), stage = try fixture.stage("new")
        let engine = fixture.engine { if $0 == .afterInitialJournal { throw Interrupted.boundary } }
        XCTAssertThrowsError(try fixture.install(stage, target, "new", engine: engine))
        let journal = try XCTUnwrap(fixture.artifacts(suffix: ".journal").first)
        switch mode {
        case "malformed": try Data("{".utf8).write(to: journal)
        case "oversized": try Data(repeating: 0x20, count: 64 * 1024 + 1).write(to: journal)
        case "old-target": try fixture.amend(journal) { $0["targetPath"] = fixture.root.appendingPathComponent("old-uuid/Documents/attachments/owned.txt").path }
        case "escaping-stage": try fixture.amend(journal) { $0["stagedPath"] = fixture.root.appendingPathComponent("outside.staged").path }
        case "wrong-slot": try fixture.amend(journal) { $0["targetPath"] = fixture.file("different.txt").path }
        case "wrong-optional": try fixture.amend(journal) { $0["expectedLocalSha256"] = 12 }
        default: try fixture.amend(journal) { $0["preservationPath"] = fixture.root.appendingPathComponent("outside-preserved").path }
        }
        let unrelated = try fixture.stage("unrelated"), untouched = fixture.file("untouched.txt")
        let before = try fixture.snapshot()
        XCTAssertThrowsError(try fixture.install(unrelated, untouched, "unrelated"))
        XCTAssertEqual(try fixture.snapshot(), before, mode)
        XCTAssertFalse(FileManager.default.fileExists(atPath: untouched.path))
      }
    }
  }

  func testRetainedJournalInventoryCountsOnlyEligibleRecordsAndDoesNotRecoverUnrelatedTarget() throws {
    try withFixture { fixture in
      for index in 0..<10_001 { try Data().write(to: fixture.file("ordinary-\(index)")) }
      let target = fixture.file("pending.txt"), stage = try fixture.stage("pending")
      let engine = fixture.engine { if $0 == .afterInitialJournal { throw Interrupted.boundary } }
      XCTAssertThrowsError(try fixture.install(stage, target, "pending", engine: engine))
      let journal = try XCTUnwrap(fixture.artifacts(suffix: ".journal").first)
      let before = try Data(contentsOf: journal)
      let next = try fixture.stage("next"), other = fixture.file("other.txt")
      guard case .installed = try fixture.install(next, other, "next") else { return XCTFail("Expected unrelated install") }
      XCTAssertEqual(try Data(contentsOf: journal), before)
      XCTAssertTrue(FileManager.default.fileExists(atPath: stage.path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
      XCTAssertEqual(try Data(contentsOf: other), Data("next".utf8))
    }
  }

  func testRetainedRawInstallAndHashRefuseUnsafeLeafAuthorities() throws {
    for mode in ["source-hardlink", "target-hardlink", "source-symlink", "target-symlink", "cache-source", "nested-source"] {
      try withFixture { fixture in
        let target = fixture.file("target.txt")
        try Data("old".utf8).write(to: target)
        var stage = try fixture.stage("new")
        let peer = fixture.file("peer.txt")
        switch mode {
        case "source-hardlink": try FileManager.default.linkItem(at: stage, to: peer)
        case "target-hardlink": try FileManager.default.linkItem(at: target, to: peer)
        case "source-symlink": try FileManager.default.moveItem(at: stage, to: peer); try FileManager.default.createSymbolicLink(at: stage, withDestinationURL: peer)
        case "target-symlink": try FileManager.default.moveItem(at: target, to: peer); try FileManager.default.createSymbolicLink(at: target, withDestinationURL: peer)
        case "cache-source": stage = fixture.root.appendingPathComponent(".mindwtr-download-cache.staged"); try Data("new".utf8).write(to: stage)
        default:
          let nested = fixture.file("nested")
          try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
          stage = nested.appendingPathComponent(".mindwtr-download-nested.staged"); try Data("new".utf8).write(to: stage)
        }
        let old = try Data(contentsOf: target), incoming = try Data(contentsOf: stage)
        XCTAssertThrowsError(try fixture.install(stage, target, "new", expected: .present(sha256: fixture.digest("old"))))
        XCTAssertEqual(try Data(contentsOf: target), old)
        XCTAssertEqual(try Data(contentsOf: stage), incoming)
        XCTAssertEqual(try fixture.artifacts(), [])
        if mode.hasPrefix("target-") { XCTAssertThrowsError(try fixture.engine().hash(target, directoryDescriptor: fixture.descriptor, requireAuthority: fixture.check)) }
      }
    }
  }

  func testRetainedRawLockWaitRefusesAncestorDirectoryAndSymlinkReplacement() throws {
    for symlink in [false, true] {
      try withFixture { fixture in
        let target = fixture.file("target.txt"), stage = try fixture.stage("new")
        let engine = fixture.engine(), lock = Darwin.openat(fixture.descriptor, ".mindwtr-attachment-installer.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard lock >= 0, flock(lock, LOCK_EX) == 0 else { return XCTFail("Fixture lock unavailable") }
        defer { _ = flock(lock, LOCK_UN); Darwin.close(lock) }
        let waiting = DispatchSemaphore(value: 0), done = DispatchSemaphore(value: 0), result = RetainedRawAttempt()
        let check: () throws -> Void = { try fixture.check(); if result.observe() == 2 { waiting.signal() } }
        DispatchQueue.global(qos: .userInitiated).async {
          do {
            _ = try engine.install(stagedInput: stage, targetInput: target, expected: .absent,
              expectedDownloadSha256: fixture.digest("new"), directoryDescriptor: fixture.descriptor, requireAuthority: check)
            result.finish(false)
          } catch { result.finish(true) }
          done.signal()
        }
        let status = waiting.wait(timeout: .now() + 5)
        XCTAssertEqual(status, .success)
        guard status == .success else { _ = flock(lock, LOCK_UN); _ = done.wait(timeout: .now() + 5); return }
        XCTAssertEqual(done.wait(timeout: .now() + 0.05), .timedOut)
        let documents = fixture.managed.deletingLastPathComponent(), saved = fixture.root.appendingPathComponent("retained-documents")
        try FileManager.default.moveItem(at: documents, to: saved)
        let replacement = symlink ? fixture.root.appendingPathComponent("replacement-documents") : documents
        try FileManager.default.copyItem(at: saved, to: replacement)
        if symlink { try FileManager.default.createSymbolicLink(at: documents, withDestinationURL: replacement) }
        let replacementManaged = replacement.appendingPathComponent("attachments")
        let before = try fixture.snapshot(at: replacementManaged)
        XCTAssertEqual(flock(lock, LOCK_UN), 0)
        XCTAssertEqual(done.wait(timeout: .now() + 5), .success)
        XCTAssertTrue(result.refused)
        XCTAssertEqual(try fixture.snapshot(at: replacementManaged), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: saved.appendingPathComponent("attachments/target.txt").path))
        XCTAssertEqual(try Data(contentsOf: saved.appendingPathComponent("attachments/" + stage.lastPathComponent)), Data("new".utf8))
      }
    }
  }

  private func withFixture(_ body: (RetainedRawFixture) throws -> Void) throws {
    let fixture = try RetainedRawFixture()
    defer { Darwin.close(fixture.descriptor); try? FileManager.default.removeItem(at: fixture.root) }
    try body(fixture)
  }
}

private final class RetainedRawAttempt {
  private let lock = NSLock()
  private var observations = 0
  private var value = false
  func observe() -> Int { lock.lock(); defer { lock.unlock() }; observations += 1; return observations }
  func finish(_ refused: Bool) { lock.lock(); value = refused; lock.unlock() }
  var refused: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private struct RetainedRawFixture {
  let root: URL
  let managed: URL
  let descriptor: Int32
  let check: () throws -> Void

  init() throws {
    let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/raw-installer-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    guard let physical = Darwin.realpath(base.path, nil) else { throw NSError(domain: "RetainedRawFixture", code: 1) }
    root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    free(physical)
    managed = root.appendingPathComponent("Documents/attachments", isDirectory: true)
    try FileManager.default.createDirectory(at: managed, withIntermediateDirectories: true)
    let descriptor = Darwin.open(managed.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
    guard descriptor >= 0 else { throw NSError(domain: "RetainedRawFixture", code: 2) }
    self.descriptor = descriptor
    var expected = stat()
    guard Darwin.fstat(descriptor, &expected) == 0 else { Darwin.close(descriptor); throw NSError(domain: "RetainedRawFixture", code: 3) }
    let device = expected.st_dev, inode = expected.st_ino, path = managed.path
    check = {
      let current = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
      guard current >= 0 else { throw NSError(domain: "RetainedRawFixture", code: 4) }
      defer { Darwin.close(current) }
      var value = stat()
      guard Darwin.fstat(current, &value) == 0, value.st_dev == device, value.st_ino == inode else { throw NSError(domain: "RetainedRawFixture", code: 5) }
    }
    let lock = Darwin.openat(descriptor, ".mindwtr-attachment-installer.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard lock >= 0 else { Darwin.close(descriptor); throw NSError(domain: "RetainedRawFixture", code: 6) }
    Darwin.close(lock)
  }
  func file(_ name: String) -> URL { managed.appendingPathComponent(name) }
  func stage(_ text: String) throws -> URL {
    let path = file(".mindwtr-download-" + UUID().uuidString + ".staged")
    try Data(text.utf8).write(to: path)
    return path
  }
  func engine(_ fault: @escaping (AttachmentFileInstallerFaultPoint) throws -> Void = { _ in }) -> AttachmentFileInstallerEngine {
    AttachmentFileInstallerEngine(targetRoot: managed, sourceRoots: [managed], faultInjector: fault)
  }
  func install(_ stage: URL, _ target: URL, _ content: String, expected: ExpectedAttachmentGeneration = .absent,
    engine supplied: AttachmentFileInstallerEngine? = nil) throws -> AttachmentInstallOutcome {
    try (supplied ?? engine()).install(stagedInput: stage, targetInput: target, expected: expected,
      expectedDownloadSha256: digest(content), directoryDescriptor: descriptor, requireAuthority: check)
  }
  func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
  func slot(_ target: URL) -> String { String(digest(target.path).prefix(32)) }
  func artifacts(suffix: String? = nil) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(at: managed, includingPropertiesForKeys: nil).filter {
      $0.lastPathComponent.hasPrefix(".mindwtr-install-") && (suffix == nil || $0.lastPathComponent.hasSuffix(suffix!))
    }.sorted { $0.path < $1.path }
  }
  func amend(_ journal: URL, _ change: (inout [String: Any]) -> Void) throws {
    var value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any])
    change(&value)
    try JSONSerialization.data(withJSONObject: value, options: .sortedKeys).write(to: journal)
  }
  func inode(_ path: URL) throws -> ino_t {
    var value = stat()
    guard lstat(path.path, &value) == 0 else { throw NSError(domain: "RetainedRawFixture", code: 7) }
    return value.st_ino
  }
  func snapshot(at directory: URL? = nil) throws -> [String: Data] {
    let directory = directory ?? managed
    return try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).map {
      ($0.lastPathComponent, try Data(contentsOf: $0))
    })
  }
}
