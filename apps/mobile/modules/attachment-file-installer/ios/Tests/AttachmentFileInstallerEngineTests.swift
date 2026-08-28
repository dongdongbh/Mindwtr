import CryptoKit
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

  func testImmutablePublisherCreatesNoSharedInstallerRecoveryArtifacts() throws {
    try withFixture { fixture in
      let staged = fixture.target(".mindwtr-generation-stage-owned.tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)

      let outcome = try fixture.engine().publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )

      guard case .published = outcome else { return XCTFail("Expected published outcome") }
      XCTAssertEqual(try contents(target), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
    }
  }

  func testImmutablePublisherPreservesOwnedStageAndPeerTargetOnCollision() throws {
    try withFixture { fixture in
      let staged = fixture.target(".mindwtr-generation-stage-owned.tmp")
      let target = fixture.target("a.\(digest("candidate")).txt")
      try write("candidate", to: staged)
      try write("peer-corruption", to: target)

      let outcome = try fixture.engine().publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: digest("candidate")
      )

      guard case .alreadyExists = outcome else { return XCTFail("Expected already-exists outcome") }
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertEqual(try contents(target), "peer-corruption")
      XCTAssertTrue(try fixture.internalArtifacts().isEmpty)
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

  func target(_ name: String) -> URL {
    attachmentsRoot.appendingPathComponent(name)
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
