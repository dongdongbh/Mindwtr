import CryptoKit
import Foundation
import XCTest
import AttachmentFileInstallerEngine


final class AttachmentFileInstallerFacadeTests: XCTestCase {
  func testAbsentInstallAndHashExposeTypedPublicResults() throws {
    try withFixture { fixture in
      let staged = try fixture.stage("downloaded generation")
      let target = fixture.target("installed.bin")
      let facade = try fixture.facade()
      let outcome = try facade.install(stagedInput: staged, targetInput: target,
        expected: .absent, expectedDownloadSha256: digest("downloaded generation"))
      guard case .installed(let preserved) = outcome else { return XCTFail("Expected install") }
      XCTAssertNil(preserved)
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertEqual(try contents(target), "downloaded generation")
      let snapshot: AttachmentFileHashSnapshot = try facade.hash(target)
      XCTAssertEqual(snapshot.sha256, digest("downloaded generation"))
      XCTAssertEqual(snapshot.size, UInt64("downloaded generation".utf8.count))
      XCTAssertTrue(snapshot.modificationTimeMs.isFinite)
      let modified = try target.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
      XCTAssertEqual(snapshot.modificationTimeMs, try XCTUnwrap(modified).timeIntervalSince1970 * 1000,
        accuracy: 1)
    }
  }

  func testPresentInstallNormalizesExpoDigestsAndPreservesPreviousBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("replace.bin")
      try write("original generation", to: target)
      let staged = try fixture.stage("replacement generation")
      let outcome = try fixture.facade().install(stagedInput: staged, targetInput: target,
        expected: .present(sha256: " \n" + digest("original generation").uppercased() + "\t"),
        expectedDownloadSha256: "\n" + digest("replacement generation").uppercased() + " ")
      guard case .installed(let preserved) = outcome else { return XCTFail("Expected install") }
      let preservedURL = try XCTUnwrap(preserved)
      XCTAssertEqual(preservedURL.deletingLastPathComponent().standardizedFileURL,
        fixture.attachments.standardizedFileURL)
      XCTAssertEqual(try contents(preservedURL), "original generation")
      XCTAssertEqual(try contents(target), "replacement generation")
      XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
      XCTAssertEqual(try fixture.facade().hash(target).sha256, digest("replacement generation"))
    }
  }

  func testAbsentConflictPreservesStagedAndExistingBytes() throws {
    try withFixture { fixture in
      let target = fixture.target("existing.bin")
      try write("existing", to: target)
      let staged = try fixture.stage("candidate")
      let outcome = try fixture.facade().install(stagedInput: staged, targetInput: target,
        expected: .absent, expectedDownloadSha256: digest("candidate"))
      guard case .conflict(let preserved) = outcome else { return XCTFail("Expected conflict") }
      XCTAssertEqual(preserved.standardizedFileURL, staged.standardizedFileURL)
      XCTAssertEqual(try contents(target), "existing")
      XCTAssertEqual(try contents(preserved), "candidate")
    }
  }

  func testRecreatedFacadeKeepsConcurrentGenerationAndReturnsConflict() throws {
    try withFixture { fixture in
      let target = fixture.target("concurrent.bin")
      try write("original", to: target)
      let expected = try fixture.facade().hash(target).sha256
      try write("intervening edit", to: target)
      let staged = try fixture.stage("candidate")
      let outcome = try fixture.facade().install(stagedInput: staged, targetInput: target,
        expected: .present(sha256: expected), expectedDownloadSha256: digest("candidate"))
      guard case .conflict(let preserved) = outcome else { return XCTFail("Expected conflict") }
      XCTAssertEqual(preserved.standardizedFileURL, staged.standardizedFileURL)
      XCTAssertEqual(try contents(target), "intervening edit")
      XCTAssertEqual(try contents(preserved), "candidate")
    }
  }

  func testMissingHashThrowsAndMissingPresentGenerationConflicts() throws {
    try withFixture { fixture in
      let target = fixture.target("missing.bin")
      let facade = try fixture.facade()
      XCTAssertThrowsError(try facade.hash(target))
      let staged = try fixture.stage("candidate")
      let outcome = try facade.install(stagedInput: staged, targetInput: target,
        expected: .present(sha256: digest("previous")), expectedDownloadSha256: digest("candidate"))
      guard case .conflict(let preserved) = outcome else { return XCTFail("Expected conflict") }
      XCTAssertEqual(preserved.standardizedFileURL, staged.standardizedFileURL)
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  func testRejectsNonFileURLsForRootsInstallAndHashWithoutMutatingBytes() throws {
    try withFixture { fixture in
      let remote = try XCTUnwrap(URL(string: "https://example.invalid/attachment"))
      XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: remote, sourceRoots: [fixture.cache]))
      XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: fixture.attachments, sourceRoots: [remote]))
      let facade = try fixture.facade()
      let staged = try fixture.stage("candidate")
      let target = fixture.target("valid.bin")
      XCTAssertThrowsError(try facade.install(stagedInput: remote, targetInput: target,
        expected: .absent, expectedDownloadSha256: digest("candidate")))
      XCTAssertThrowsError(try facade.install(stagedInput: staged, targetInput: remote,
        expected: .absent, expectedDownloadSha256: digest("candidate")))
      XCTAssertThrowsError(try facade.hash(remote))
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.attachments.path), [])
    }
  }

  func testInvalidDigestsRefuseBeforeInstallerArtifactsOrDocumentWrites() throws {
    try withFixture { fixture in
      let facade = try fixture.facade()
      let staged = try fixture.stage("candidate")
      let target = fixture.target("unchanged.bin")
      try write("existing", to: target)
      for digestValue in ["", "short", String(repeating: "g", count: 64), String(repeating: "a", count: 63)] {
        XCTAssertThrowsError(try facade.install(stagedInput: staged, targetInput: target,
          expected: .present(sha256: digestValue), expectedDownloadSha256: digest("candidate")))
        XCTAssertThrowsError(try facade.install(stagedInput: staged, targetInput: target,
          expected: .absent, expectedDownloadSha256: digestValue))
      }
      XCTAssertEqual(try contents(target), "existing")
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.attachments.path), ["unchanged.bin"])
    }
  }

  func testFacadeRetainsEngineContainmentAndReservedTargetRefusal() throws {
    try withFixture { fixture in
      let facade = try fixture.facade()
      let staged = try fixture.stage("candidate")
      let outsideRoot = fixture.root.appendingPathComponent("cache-peer", isDirectory: true)
      try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: false)
      let outside = outsideRoot.appendingPathComponent("candidate.bin")
      try write("outside", to: outside)
      XCTAssertThrowsError(try facade.install(stagedInput: outside, targetInput: fixture.target("outside.bin"),
        expected: .absent, expectedDownloadSha256: digest("outside")))
      let nested = fixture.attachments.appendingPathComponent("nested", isDirectory: true)
      try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
      for target in [outsideRoot.appendingPathComponent("target.bin"), nested.appendingPathComponent("target.bin"),
        fixture.target(".mindwtr-attachment-installer.lock"), fixture.target(".mindwtr-install-reserved.bin")] {
        XCTAssertThrowsError(try facade.install(stagedInput: staged, targetInput: target,
          expected: .absent, expectedDownloadSha256: digest("candidate")))
      }
      XCTAssertThrowsError(try facade.hash(outside))
      XCTAssertEqual(try contents(outside), "outside")
      XCTAssertEqual(try contents(staged), "candidate")
      XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.target("outside.bin").path))
    }
  }

  func testRejectsInjectedRootSymlinksBeforeCanonicalization() throws {
    try withFixture { fixture in
      let link = fixture.root.appendingPathComponent("root-link", isDirectory: true)
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture.attachments)
      let trailingLink = try XCTUnwrap(URL(string: link.absoluteString + "/"))
      for root in [link, trailingLink] {
        XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: root, sourceRoots: [fixture.cache]))
        XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: fixture.attachments, sourceRoots: [root]))
      }
      let regularRoot = fixture.root.appendingPathComponent("regular-root")
      try write("unchanged", to: regularRoot)
      XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: regularRoot, sourceRoots: [fixture.cache]))
      XCTAssertEqual(try contents(regularRoot), "unchanged")
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.attachments.path), [])
    }
  }

  func testFacadeRetainsEngineSymlinkSourceTargetAndHashRefusal() throws {
    try withFixture { fixture in
      let facade = try fixture.facade()
      let staged = try fixture.stage("candidate")
      let sourceLink = fixture.cache.appendingPathComponent("source-link.bin")
      try FileManager.default.createSymbolicLink(at: sourceLink, withDestinationURL: staged)
      let peer = fixture.target("peer.bin")
      try write("peer", to: peer)
      let targetLink = fixture.target("target-link.bin")
      try FileManager.default.createSymbolicLink(at: targetLink, withDestinationURL: peer)
      XCTAssertThrowsError(try facade.install(stagedInput: sourceLink, targetInput: fixture.target("new.bin"),
        expected: .absent, expectedDownloadSha256: digest("candidate")))
      XCTAssertThrowsError(try facade.install(stagedInput: staged, targetInput: targetLink,
        expected: .present(sha256: digest("peer")), expectedDownloadSha256: digest("candidate")))
      XCTAssertThrowsError(try facade.hash(targetLink))
      XCTAssertEqual(try contents(peer), "peer")
      XCTAssertEqual(try contents(staged), "candidate")
    }
  }

  private func withFixture(_ body: (FacadeFixture) throws -> Void) throws {
    let fixture = try FacadeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    try body(fixture)
  }

  private func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private func contents(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
  private func write(_ value: String, to url: URL) throws {
    try value.write(to: url, atomically: false, encoding: .utf8)
  }
}

private struct FacadeFixture {
  let root: URL
  let attachments: URL
  let cache: URL

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("attachment-facade-xctest-\(UUID().uuidString)", isDirectory: true)
    attachments = root.appendingPathComponent("attachments", isDirectory: true)
    cache = root.appendingPathComponent("cache", isDirectory: true)
    try FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
  }

  func facade() throws -> AttachmentFileInstaller {
    try AttachmentFileInstaller(targetRoot: attachments, sourceRoots: [cache])
  }

  func stage(_ value: String) throws -> URL {
    let staged = cache.appendingPathComponent("stage-\(UUID().uuidString).bin")
    try value.write(to: staged, atomically: false, encoding: .utf8)
    return staged
  }

  func target(_ name: String) -> URL { attachments.appendingPathComponent(name) }
}
