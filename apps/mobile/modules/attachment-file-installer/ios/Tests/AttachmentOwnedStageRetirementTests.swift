import Foundation
import Darwin
import XCTest
@testable import AttachmentFileInstallerEngine


final class AttachmentOwnedStageRetirementTests: XCTestCase {
  private enum Stop: Error { case fault }

  func testPublicEntryRemovesEmptyOwnedStageOnly() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testPublicEntryRetiresPartialBytesWithoutCompletedDigest() throws {
    try fixture { value in
      try value.fill(Data("partial bytes, no full digest".utf8))
      expect(try value.retire(), .removed)
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testExactEmptyNamespaceIsRemovedAndReportedMissing() throws {
    try fixture { value in
      try FileManager.default.removeItem(at: value.prepared.stagedUrl)
      expect(try value.retire(), .missing)
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testRecreatedPublicFacadeAcknowledgesExactMissingNamespace() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      expect(try value.retire(facade: value.facade()), .missing)
      expect(try value.retire(facade: value.facade()), .missing)
      try value.untouched()
    }
  }

  func testAlreadyMissingNamespaceStillReachesDurabilityOnEveryRetry() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      var syncs = 0
      let engine = value.engine { if $0 == .beforeOwnedPrivateRootSync { syncs += 1 } }
      expect(try value.retire(engine: engine), .missing)
      expect(try value.retire(engine: engine), .missing)
      XCTAssertEqual(syncs, 2)
      try value.untouched()
    }
  }

  func testMissingManagedRootNeverRecreatesItOrAcknowledgesMissing() throws {
    try fixture { value in
      let retained = value.root.appendingPathComponent("retained-root", isDirectory: true)
      try FileManager.default.moveItem(at: value.attachments, to: retained)
      reject { try value.retire(facade: value.facade()) }
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.attachments.path))
      XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent(value.namespace.lastPathComponent).appendingPathComponent("stage")), Data())
      try value.retainedSiblings(in: retained)
    }
  }

  func testReplacedManagedRootRefusesEvenWhenNamespaceIsMissing() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      let retained = try value.replaceRoot()
      expect(try value.retire(facade: value.facade()), .conflict)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: value.attachments.path), [])
      try value.retainedSiblings(in: retained)
    }
  }

  func testSymlinkManagedRootRefusesEvenWhenNamespaceIsMissing() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      let retained = value.root.appendingPathComponent("retained-root", isDirectory: true)
      try FileManager.default.moveItem(at: value.attachments, to: retained)
      try FileManager.default.createSymbolicLink(at: value.attachments, withDestinationURL: retained)
      reject { try value.retire(facade: value.facade()) }
      XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: value.attachments.path), retained.path)
      try value.retainedSiblings(in: retained)
    }
  }

  func testWrongRecordedRootRefusesMissingNamespaceBeforeLockCreation() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      expect(try value.retire(directoryIdentity: "0:0"), .conflict)
      try value.untouched()
    }
  }

  func testWrongPrivateIdentityRefusesEvenWhenStageIsMissing() throws {
    try fixture { value in
      try FileManager.default.removeItem(at: value.prepared.stagedUrl)
      expect(try value.retire(privateIdentity: "0:0"), .conflict)
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testDifferentPrivateNamespaceInodePreservesBothDirectories() throws {
    try fixture { value in
      try value.fill(value.partial)
      let retained = value.cache.appendingPathComponent("retained-private", isDirectory: true)
      try FileManager.default.moveItem(at: value.namespace, to: retained)
      try FileManager.default.createDirectory(at: value.namespace, withIntermediateDirectories: false)
      try value.partial.write(to: value.prepared.stagedUrl)
      expect(try value.retire(), .conflict)
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent("stage")), value.partial)
      try value.untouched()
    }
  }

  func testEqualBytesDifferentStageInodeIsNeverAdopted() throws {
    try fixture { value in
      try value.fill(value.partial)
      let retained = value.namespace.appendingPathComponent("retained-stage")
      try FileManager.default.moveItem(at: value.prepared.stagedUrl, to: retained)
      try value.partial.write(to: value.prepared.stagedUrl)
      expect(try value.retire(), .conflict)
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      XCTAssertEqual(try Data(contentsOf: retained), value.partial)
      try value.untouched()
    }
  }

  func testHardLinkedStageRefusesEveryName() throws {
    try fixture { value in
      try value.fill(value.partial)
      let linked = value.cache.appendingPathComponent("hardlink")
      XCTAssertEqual(Darwin.link(value.prepared.stagedUrl.path, linked.path), 0)
      expect(try value.retire(), .conflict)
      XCTAssertEqual(try Data(contentsOf: linked), value.partial)
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      try value.untouched()
    }
  }

  func testSymlinkAndNonregularStageRefuseWithoutDeletingNamespace() throws {
    for symlink in [false, true] {
      try fixture { value in
        try FileManager.default.removeItem(at: value.prepared.stagedUrl)
        if symlink {
          try FileManager.default.createSymbolicLink(at: value.prepared.stagedUrl, withDestinationURL: value.sibling)
        } else {
          XCTAssertEqual(Darwin.mkfifo(value.prepared.stagedUrl.path, mode_t(0o600)), 0)
        }
        reject { try value.retire() }
        var info = stat()
        XCTAssertEqual(Darwin.lstat(value.prepared.stagedUrl.path, &info), 0)
        XCTAssertEqual(info.st_mode & S_IFMT, symlink ? S_IFLNK : S_IFIFO)
        XCTAssertTrue(FileManager.default.fileExists(atPath: value.namespace.path))
        try value.untouched()
      }
    }
  }

  func testNonemptyPrivateNamespaceRetainsUnrequestedSiblingAfterStageUnlink() throws {
    try fixture { value in
      let extra = value.namespace.appendingPathComponent("unknown-private-file")
      try value.partial.write(to: extra)
      XCTAssertThrowsError(try value.retire())
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      XCTAssertEqual(try Data(contentsOf: extra), value.partial)
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testExistingTargetCollisionIsNeverDeletedOrChanged() throws {
    for bytes in [Data(), Data("another published generation".utf8)] {
      try fixture { value in
        try bytes.write(to: value.target)
        expect(try value.retire(), .removed)
        XCTAssertEqual(try Data(contentsOf: value.target), bytes)
        try value.untouched()
      }
    }
  }

  func testSymlinkTargetIsRetainedAndDoesNotAuthorizeCleanup() throws {
    try fixture { value in
      try FileManager.default.createSymbolicLink(at: value.target, withDestinationURL: value.sibling)
      reject { try value.retire() }
      XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: value.target.path), value.sibling.path)
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      try value.untouched()
    }
  }

  func testInvalidOperationAndDifferentRecordedOperationRefuseBeforeMutation() throws {
    try fixture { value in
      for id in ["", String(repeating: "a", count: 31), String(repeating: "A", count: 32),
                 "../outside", String(repeating: "2", count: 32)] {
        XCTAssertThrowsError(try value.retire(operationId: id))
        XCTAssertTrue(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      }
      try value.untouched()
    }
  }

  func testLegacyRootStageAndOutsidePathsAreRejected() throws {
    try fixture { value in
      let legacy = value.attachments.appendingPathComponent(".mindwtr-generation-stage-\(value.operationId).tmp")
      try value.partial.write(to: legacy)
      let remote = try XCTUnwrap(URL(string: "https://example.invalid/private"))
      for inputs in [(legacy, value.target), (value.cache.appendingPathComponent("stage"), value.target),
                     (value.prepared.stagedUrl, value.cache.appendingPathComponent("outside")),
                     (remote, value.target), (value.prepared.stagedUrl, remote)] {
        XCTAssertThrowsError(try value.retire(stagedInput: inputs.0, targetInput: inputs.1))
      }
      XCTAssertEqual(try Data(contentsOf: legacy), value.partial)
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      try value.untouched()
    }
  }

  func testInvalidCanonicalTokensAreRequiredForEveryProofField() throws {
    try fixture { value in
      for token in ["", "1", "01:2", "1:02", "-1:2", "1:-2", "1:", ":2",
                    "18446744073709551616:2", String(repeating: "1", count: 42)] {
        for field in 0..<3 {
          XCTAssertThrowsError(try value.retire(stageIdentity: field == 0 ? token : nil,
            directoryIdentity: field == 1 ? token : nil, privateIdentity: field == 2 ? token : nil)) { error in
              XCTAssertEqual(error.localizedDescription,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Owned private attachment retirement proof is invalid")
          }
        }
      }
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      try value.untouched()
    }
  }

  func testWrongValidStageIdentityRetainsPartialBytes() throws {
    try fixture { value in
      try value.fill(value.partial)
      expect(try value.retire(stageIdentity: "0:0"), .conflict)
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      try value.untouched()
    }
  }

  func testFaultAfterStageUnlinkColdRetryRetiresExactEmptyNamespace() throws {
    try fixture { value in
      let engine = value.engine { if $0 == .afterOwnedPrivateStageUnlink { throw Stop.fault } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.prepared.stagedUrl.path))
      XCTAssertTrue(FileManager.default.fileExists(atPath: value.namespace.path))
      expect(try value.retire(facade: value.facade()), .missing)
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      try value.untouched()
    }
  }

  func testFaultAfterRmdirColdMissingRetrySyncsRecordedRoot() throws {
    try fixture { value in
      let engine = value.engine { if $0 == .afterOwnedPrivateNamespaceRetirement { throw Stop.fault } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      var syncs = 0
      let cold = value.engine { if $0 == .beforeOwnedPrivateRootSync { syncs += 1 } }
      expect(try value.retire(engine: cold), .missing)
      XCTAssertEqual(syncs, 1)
      try value.untouched()
    }
  }

  func testPresyncFaultRetainsUncertaintyUntilColdDurableMissingRetry() throws {
    try fixture { value in
      let engine = value.engine { if $0 == .beforeOwnedPrivateRootSync { throw Stop.fault } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertFalse(FileManager.default.fileExists(atPath: value.namespace.path))
      var syncs = 0
      let cold = value.engine { if $0 == .beforeOwnedPrivateRootSync { syncs += 1 } }
      expect(try value.retire(engine: cold), .missing)
      XCTAssertEqual(syncs, 1)
      try value.untouched()
    }
  }

  func testFaultAfterRmdirColdWrongRootCannotBecomeMissing() throws {
    try fixture { value in
      let engine = value.engine { if $0 == .afterOwnedPrivateNamespaceRetirement { throw Stop.fault } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      let retained = try value.replaceRoot()
      expect(try value.retire(facade: value.facade()), .conflict)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: value.attachments.path), [])
      try value.retainedSiblings(in: retained)
    }
  }

  func testFinalRootReplacementIsRetainedAndCannotAcknowledgeMissing() throws {
    try fixture { value in
      var retained: URL?
      let engine = value.engine { if $0 == .beforeOwnedPrivateRootSync { retained = try value.replaceRoot() } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: value.attachments.path), [])
      try value.retainedSiblings(in: XCTUnwrap(retained))
      expect(try value.retire(facade: value.facade()), .conflict)
    }
  }

  func testFinalNamespaceReplacementIsRetainedAndCannotAcknowledgeMissing() throws {
    try fixture { value in
      let engine = value.engine {
        if $0 == .beforeOwnedPrivateRootSync {
          try FileManager.default.createDirectory(at: value.namespace, withIntermediateDirectories: false)
          try value.partial.write(to: value.prepared.stagedUrl)
        }
      }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      reject { try value.retire(facade: value.facade()) }
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      try value.untouched()
    }
  }

  func testPreunlinkReplacementRetainsOriginalAndReplacementBytes() throws {
    try fixture { value in
      try value.fill(value.partial)
      let retained = value.cache.appendingPathComponent("retained-stage")
      let engine = value.engine {
        if $0 == .beforeOwnedPrivateStageUnlink {
          try FileManager.default.moveItem(at: value.prepared.stagedUrl, to: retained)
          try value.partial.write(to: value.prepared.stagedUrl)
        }
      }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertEqual(try Data(contentsOf: retained), value.partial)
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      try value.untouched()
    }
  }

  func testPreRmdirPrivateReplacementRetainsReplacementNamespace() throws {
    try fixture { value in
      let retained = value.cache.appendingPathComponent("retained-private", isDirectory: true)
      let engine = value.engine {
        if $0 == .beforeOwnedPrivateNamespaceRetirement {
          try FileManager.default.moveItem(at: value.namespace, to: retained)
          try FileManager.default.createDirectory(at: value.namespace, withIntermediateDirectories: false)
          try value.partial.write(to: value.prepared.stagedUrl)
        }
      }
      XCTAssertThrowsError(try value.retire(engine: engine))
      XCTAssertTrue(FileManager.default.fileExists(atPath: retained.path))
      XCTAssertEqual(try Data(contentsOf: value.prepared.stagedUrl), value.partial)
      try value.untouched()
    }
  }

  func testAlreadyMissingSyncFaultCannotReturnSuccessfulMissing() throws {
    try fixture { value in
      expect(try value.retire(), .removed)
      let engine = value.engine { if $0 == .beforeOwnedPrivateRootSync { throw Stop.fault } }
      XCTAssertThrowsError(try value.retire(engine: engine))
      expect(try value.retire(facade: value.facade()), .missing)
      try value.untouched()
    }
  }

  func testLegacyMissingContractRemainsSeparate() throws {
    try fixture { value in
      let facade = try value.facade()
      expect(try value.retire(), .removed)
      let legacyMissing = try facade.cleanupImmutableStage(stagedInput: value.prepared.stagedUrl,
        targetInput: value.target, operationId: value.operationId, expectedStagedSha256: nil,
        expectedStagedIdentity: nil, expectedDirectoryIdentity: "0:0", expectedPrivateDirectoryIdentity: nil)
      expect(legacyMissing, .missing)
      expect(try value.retire(directoryIdentity: "0:0"), .conflict)
      try value.untouched()
    }
  }

  func testRepeatedConflictAndMissingRetriesCloseDescriptors() throws {
    try fixture { value in
      func descriptors() -> Set<Int32> {
        var found = Set<Int32>()
        for fd in 0..<Darwin.getdtablesize() where Darwin.fcntl(fd, F_GETFD) != -1 { found.insert(fd) }
        return found
      }
      let before = descriptors()
      for _ in 0..<16 { expect(try value.retire(stageIdentity: "0:0"), .conflict) }
      expect(try value.retire(), .removed)
      for _ in 0..<16 { expect(try value.retire(facade: value.facade()), .missing) }
      XCTAssertEqual(descriptors(), before)
      try value.untouched()
    }
  }

  private func fixture(_ body: (OwnedStageFixture) throws -> Void) throws {
    let value = try OwnedStageFixture()
    defer { try? FileManager.default.removeItem(at: value.root) }
    try body(value)
  }

  private func expect(_ actual: ImmutableAttachmentStageCleanupOutcome, _ expected: ImmutableAttachmentStageCleanupOutcome,
                      file: StaticString = #filePath, line: UInt = #line) {
    switch (actual, expected) {
    case (.removed, .removed), (.missing, .missing), (.conflict, .conflict): return
    default: XCTFail("Unexpected owned-stage retirement outcome", file: file, line: line)
    }
  }

  private func reject(_ action: () throws -> ImmutableAttachmentStageCleanupOutcome,
                      file: StaticString = #filePath, line: UInt = #line) {
    do {
      let outcome = try action()
      guard case .conflict = outcome else { return XCTFail("Must refuse without terminal missing/removal", file: file, line: line) }
    } catch {

      XCTAssertFalse(error.localizedDescription.contains("file:///"), file: file, line: line)
    }
  }
}

private final class OwnedStageFixture {
  let root: URL
  let attachments: URL
  let cache: URL
  let sibling: URL
  let target: URL
  let prepared: ImmutableAttachmentPreparedStage
  let operationId = String(repeating: "1", count: 32)
  let partial = Data("partial private bytes 世界".utf8)
  private let siblingBytes = Data("unrequested managed sibling".utf8)
  private let cacheBytes = Data("owned cache source retained".utf8)

  var namespace: URL { prepared.stagedUrl.deletingLastPathComponent() }

  init() throws {
    let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let path = package.appendingPathComponent(".build/task231-fixtures/\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    guard let physical = Darwin.realpath(path.path, nil) else { throw StopFixture.unavailable }
    defer { Darwin.free(physical) }
    root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    attachments = root.appendingPathComponent("attachments", isDirectory: true)
    cache = root.appendingPathComponent("cache", isDirectory: true)
    sibling = attachments.appendingPathComponent("sibling.bin")
    target = attachments.appendingPathComponent("target.bin")
    try FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: false)
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: false)
    try siblingBytes.write(to: sibling)
    try cacheBytes.write(to: cache.appendingPathComponent("source.bin"))
    prepared = try AttachmentFileInstaller(targetRoot: attachments, sourceRoots: [cache])
      .prepareImmutableStage(targetInput: target, operationId: operationId)
  }

  func facade() throws -> AttachmentFileInstaller {
    try AttachmentFileInstaller(targetRoot: attachments, sourceRoots: [cache])
  }

  func engine(_ fault: @escaping (AttachmentFileInstallerFaultPoint) throws -> Void = { _ in }) -> AttachmentFileInstallerEngine {
    AttachmentFileInstallerEngine(targetRoot: attachments, sourceRoots: [cache], faultInjector: fault)
  }

  func fill(_ bytes: Data) throws {
    let handle = try FileHandle(forWritingTo: prepared.stagedUrl)
    defer { try? handle.close() }
    try handle.write(contentsOf: bytes)
  }

  func retire(facade: AttachmentFileInstaller? = nil, stagedInput: URL? = nil, targetInput: URL? = nil,
              operationId: String? = nil, stageIdentity: String? = nil,
              directoryIdentity: String? = nil, privateIdentity: String? = nil) throws -> ImmutableAttachmentStageCleanupOutcome {
    try (facade ?? self.facade()).retireOwnedPrivateStage(stagedInput: stagedInput ?? prepared.stagedUrl,
      targetInput: targetInput ?? target, operationId: operationId ?? self.operationId,
      expectedStagedIdentity: stageIdentity ?? prepared.stagedIdentity,
      expectedDirectoryIdentity: directoryIdentity ?? prepared.directoryIdentity,
      expectedPrivateDirectoryIdentity: privateIdentity ?? prepared.privateDirectoryIdentity)
  }

  func retire(engine: AttachmentFileInstallerEngine) throws -> ImmutableAttachmentStageCleanupOutcome {
    try engine.retireOwnedPrivateStage(stagedInput: prepared.stagedUrl, targetInput: target, operationId: operationId,
      expectedStagedIdentity: prepared.stagedIdentity, expectedDirectoryIdentity: prepared.directoryIdentity,
      expectedPrivateDirectoryIdentity: prepared.privateDirectoryIdentity)
  }

  func replaceRoot() throws -> URL {
    let retained = root.appendingPathComponent("retained-root", isDirectory: true)
    try FileManager.default.moveItem(at: attachments, to: retained)
    try FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: false)
    return retained
  }

  func retainedSiblings(in directory: URL) throws {
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(sibling.lastPathComponent)), siblingBytes)
    XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("source.bin")), cacheBytes)
  }

  func untouched() throws { try retainedSiblings(in: attachments) }

  private enum StopFixture: Error { case unavailable }
}
