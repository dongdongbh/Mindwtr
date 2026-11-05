import CryptoKit
import Foundation
import XCTest
import AttachmentFileInstallerEngine

final class AttachmentFileInstallerSystemVarTests: XCTestCase {
  private let bytes = Data([0, 255, 10, 17, 128, 42])
  private let operationId = String(repeating: "1", count: 32)

  func testSystemVarAliasesReserveWritePublishAndHashMissingTargets() throws {
    for canonicalRoot in [false, true] {
      for canonicalTarget in [false, true] {
        try withSystemVarFixture { canonical, aliased in
          let root = canonicalRoot ? canonical : aliased
          let target = (canonicalTarget ? canonical : aliased).appendingPathComponent("model.bin")
          let peer = canonical.appendingPathComponent("peer.bin"), peerBytes = Data([7, 8, 9])
          try peerBytes.write(to: peer)
          let facade = try AttachmentFileInstaller(targetRoot: root, sourceRoots: [root])
          let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
          let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target)
          defer { writer.close() }
          try writer.append(bytes.prefix(2)); try writer.append(bytes.dropFirst(2)); try writer.synchronize(); writer.close()
          let stage = (canonicalTarget ? aliased : canonical)
            .appendingPathComponent(prepared.stagedUrl.deletingLastPathComponent().lastPathComponent, isDirectory: true)
            .appendingPathComponent("stage")
          let proof = try facade.snapshotImmutableStage(stagedInput: stage, targetInput: target, expectedStagedSha256: digest(bytes))
          guard case .published = try facade.publishImmutable(stagedInput: stage, targetInput: target,
            expectedStagedSha256: digest(bytes), expectedStagedIdentity: proof.stagedIdentity,
            expectedDirectoryIdentity: proof.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
          else { return XCTFail("Verified system alias publication did not complete") }
          for reopenedRoot in [canonical, aliased] {
            let reopened = try AttachmentFileInstaller(targetRoot: reopenedRoot, sourceRoots: [reopenedRoot])
            let snapshot = try reopened.hash(reopenedRoot.appendingPathComponent("model.bin"))
            XCTAssertEqual(snapshot.sha256, digest(bytes)); XCTAssertEqual(snapshot.size, UInt64(bytes.count))
          }
          XCTAssertEqual(try Data(contentsOf: target), bytes)
          XCTAssertEqual(try Data(contentsOf: peer), peerBytes)
          XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.stagedUrl.deletingLastPathComponent().path))
          XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: canonical.path).sorted(),
            [".mindwtr-attachment-installer.lock", "model.bin", "peer.bin"])
        }
      }
    }
  }

  func testSystemVarAliasesPreserveExistingTargetAndRetireThenRetryMissingOwnedStage() throws {
    for canonicalRoot in [false, true] {
      for existingTarget in [false, true] {
        try withSystemVarFixture { canonical, aliased in
          let root = canonicalRoot ? canonical : aliased, otherRoot = canonicalRoot ? aliased : canonical
          let target = otherRoot.appendingPathComponent("model.bin"), peerBytes = Data([8, 7, 6])
          if existingTarget { try peerBytes.write(to: target) }
          let facade = try AttachmentFileInstaller(targetRoot: root, sourceRoots: [root])
          let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
          let writer = try facade.openPreparedStageForWriting(prepared, targetInput: target)
          defer { writer.close() }
          try writer.append(bytes); try writer.synchronize(); writer.close()
          let stage = otherRoot.appendingPathComponent(prepared.stagedUrl.deletingLastPathComponent().lastPathComponent,
            isDirectory: true).appendingPathComponent("stage")
          if existingTarget {
            guard case .alreadyExists = try facade.publishImmutable(stagedInput: stage, targetInput: target,
              expectedStagedSha256: digest(bytes), expectedStagedIdentity: prepared.stagedIdentity,
              expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
            else { return XCTFail("Existing target must win without consuming the stage") }
            XCTAssertEqual(try Data(contentsOf: stage), bytes)
            XCTAssertEqual(try Data(contentsOf: target), peerBytes)
          }
          guard case .removed = try facade.retireOwnedPrivateStage(stagedInput: stage, targetInput: target,
            operationId: operationId, expectedStagedIdentity: prepared.stagedIdentity,
            expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
          else { return XCTFail("Exact owned stage must retire through either system alias") }
          for reopenedRoot in [canonical, aliased] {
            let reopened = try AttachmentFileInstaller(targetRoot: reopenedRoot, sourceRoots: [reopenedRoot])
            let missingStage = reopenedRoot.appendingPathComponent(prepared.stagedUrl.deletingLastPathComponent().lastPathComponent,
              isDirectory: true).appendingPathComponent("stage")
            guard case .missing = try reopened.retireOwnedPrivateStage(stagedInput: missingStage,
              targetInput: reopenedRoot.appendingPathComponent("model.bin"), operationId: operationId,
              expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
              expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
            else { return XCTFail("Cold retry must acknowledge the exact missing owned namespace") }
          }
          XCTAssertFalse(FileManager.default.fileExists(atPath: stage.deletingLastPathComponent().path))
          if existingTarget { XCTAssertEqual(try Data(contentsOf: target), peerBytes) }
          else { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)) }
        }
      }
    }
  }

  func testSystemVarAliasesStillRefuseForeignPathsAndInjectedSymlinks() throws {
    try withSystemVarFixture { canonical, aliased in
      let managed = canonical.appendingPathComponent("managed", isDirectory: true)
      let foreign = aliased.appendingPathComponent("foreign", isDirectory: true)
      for root in [managed, foreign] { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
      let facade = try AttachmentFileInstaller(targetRoot: managed, sourceRoots: [managed])
      let target = managed.appendingPathComponent("model.bin")
      let prepared = try facade.prepareImmutableStage(targetInput: target, operationId: operationId)
      let foreignFacade = try AttachmentFileInstaller(targetRoot: foreign, sourceRoots: [foreign])
      let foreignTarget = foreign.appendingPathComponent("peer.bin"), peerBytes = Data([9, 8, 7])
      let foreignPrepared = try foreignFacade.prepareImmutableStage(targetInput: foreignTarget, operationId: operationId)
      try bytes.write(to: prepared.stagedUrl); try peerBytes.write(to: foreignPrepared.stagedUrl); try peerBytes.write(to: foreignTarget)
      let link = managed.appendingPathComponent("foreign-link", isDirectory: true)
      try FileManager.default.createSymbolicLink(at: link, withDestinationURL: foreign)
      let linkedStage = link.appendingPathComponent(foreignPrepared.stagedUrl.deletingLastPathComponent().lastPathComponent,
        isDirectory: true).appendingPathComponent("stage")
      let linkedTarget = managed.appendingPathComponent("target-link")
      try FileManager.default.createSymbolicLink(at: linkedTarget, withDestinationURL: foreignTarget)
      for inputs in [(foreignPrepared.stagedUrl, target), (linkedStage, target),
        (prepared.stagedUrl, foreignTarget), (prepared.stagedUrl, linkedTarget)] {
        XCTAssertThrowsError(try facade.snapshotImmutableStage(stagedInput: inputs.0, targetInput: inputs.1,
          expectedStagedSha256: digest(bytes)))
        XCTAssertThrowsError(try facade.publishImmutable(stagedInput: inputs.0, targetInput: inputs.1,
          expectedStagedSha256: digest(bytes), expectedStagedIdentity: prepared.stagedIdentity,
          expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
        XCTAssertThrowsError(try facade.retireOwnedPrivateStage(stagedInput: inputs.0, targetInput: inputs.1,
          operationId: operationId, expectedStagedIdentity: prepared.stagedIdentity,
          expectedDirectoryIdentity: prepared.directoryIdentity, expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity))
      }
      let rootLink = canonical.appendingPathComponent("root-link", isDirectory: true)
      try FileManager.default.createSymbolicLink(at: rootLink, withDestinationURL: managed)
      XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: rootLink, sourceRoots: [managed]))
      XCTAssertThrowsError(try AttachmentFileInstaller(targetRoot: managed, sourceRoots: [rootLink]))
      XCTAssertThrowsError(try facade.hash(linkedTarget))
      XCTAssertEqual(try Data(contentsOf: prepared.stagedUrl), bytes)
      XCTAssertEqual(try Data(contentsOf: foreignPrepared.stagedUrl), peerBytes)
      XCTAssertEqual(try Data(contentsOf: foreignTarget), peerBytes)
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
  }

  func testSystemVarLegacyInterruptedJournalsKeepOriginalPathHashAndReplay() throws {
    for existingTarget in [false, true] {
      try withSystemVarFixture { canonical, aliased in
        let managed = canonical.appendingPathComponent("attachments", isDirectory: true)
        let cache = canonical.appendingPathComponent("cache", isDirectory: true)
        for root in [managed, cache] { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false) }
        let target = (existingTarget ? aliased : canonical).appendingPathComponent("attachments/model.bin")
        let staged = aliased.appendingPathComponent("cache/download.staged"), oldBytes = Data([1, 2, 3])
        try bytes.write(to: staged)
        if existingTarget { try oldBytes.write(to: target) }
        let prefix = ".mindwtr-install-\(digest(Data(target.path.utf8)).prefix(32))"
        let journal = managed.appendingPathComponent(prefix + ".journal")
        let candidate = managed.appendingPathComponent(prefix + ".candidate")
        try bytes.write(to: candidate)
        var record: [String: Any] = ["version": 2, "targetPath": target.path, "stagedPath": staged.path,
          "candidateSha256": digest(bytes), "expectedLocalSha256": NSNull(),
          "displacedSha256": NSNull(), "preservationPath": NSNull()]
        if existingTarget { record["expectedLocalSha256"] = digest(oldBytes) }
        try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]).write(to: journal)
        let facade = try AttachmentFileInstaller(targetRoot: managed, sourceRoots: [cache])
        let expected: ExpectedAttachmentGeneration = existingTarget ? .present(sha256: digest(oldBytes)) : .absent
        guard case .installed(let preserved) = try facade.install(stagedInput: staged, targetInput: target,
          expected: expected, expectedDownloadSha256: digest(bytes)) else { return XCTFail("Legacy journal must replay") }
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        if existingTarget { XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preserved)), oldBytes) }
        else { XCTAssertNil(preserved) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: candidate.path))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: managed.path).contains { $0.hasPrefix(".mindwtr-install-") })
      }
    }
  }

  private func withSystemVarFixture(_ body: (URL, URL) throws -> Void) throws {
    guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
          ["private/var", "/private/var"].contains(destination) else { throw XCTSkip("Verified Apple system var alias required") }
    let name = "mindwtr-attachment-system-var-" + UUID().uuidString.lowercased()
    let canonical = URL(fileURLWithPath: "/private/var/tmp", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    let aliased = URL(fileURLWithPath: "/var/tmp", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: canonical) }
    try body(canonical, aliased)
  }

  private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
