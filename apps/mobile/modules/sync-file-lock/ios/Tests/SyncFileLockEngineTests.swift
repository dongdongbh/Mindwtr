import Dispatch
import XCTest
@testable import SyncFileLockEngine

private final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value?

  func store(_ next: Value) {
    lock.lock()
    value = next
    lock.unlock()
  }

  func load() -> Value? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

final class SyncFileLockEngineTests: XCTestCase {
  private func sandbox() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("mindwtr-strict-root-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    return url
  }

  private func selectedDirectory(in parent: URL) throws -> URL {
    let selected = parent.appendingPathComponent("selected-e\u{301}-文件", isDirectory: true)
    try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: false)
    return selected
  }

  private func assertRefusesDirectory(
    _ engine: SyncFileLockEngine, _ selected: URL,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    var leaseAdmitted = false
    XCTAssertThrowsError(try {
      let token = try engine.acquireDirectory(selected)
      leaseAdmitted = true
      return token
    }(), file: file, line: line)
    XCTAssertFalse(leaseAdmitted, "a refused selection cannot admit reader authority", file: file, line: line)
  }

  func testStrictDirectoryLeasePreservesSelectionAndUnknownFiles() throws {
    let parent = try sandbox()
    defer { try? FileManager.default.removeItem(at: parent) }
    let selected = try selectedDirectory(in: parent)
    let unknown = selected.appendingPathComponent("unknown.bin")
    let bytes = Data([0, 1, 255, 8])
    try bytes.write(to: unknown)
    let engine = SyncFileLockEngine()
    defer { engine.drain() }
    let token = try engine.acquireDirectory(selected)
    try engine.revalidate(token)
    XCTAssertThrowsError(try SyncFileLockEngine().acquireDirectory(selected))
    try engine.release(token)
    XCTAssertThrowsError(try engine.revalidate(token))
    XCTAssertThrowsError(try engine.release(token))
    XCTAssertTrue(FileManager.default.fileExists(atPath: selected.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertEqual(try Data(contentsOf: unknown), bytes)
    let reacquired = try engine.acquireDirectory(selected)
    try engine.release(reacquired)
  }

  func testStrictMissingFileSymlinkAndNonFileSelectionsNeverLeaseParentOrPeer() throws {
    let parent = try sandbox()
    defer { try? FileManager.default.removeItem(at: parent) }
    let peer = try selectedDirectory(in: parent)
    let file = parent.appendingPathComponent("selection.json")
    let bytes = Data("untouched".utf8)
    try bytes.write(to: file)
    let link = parent.appendingPathComponent("linked-folder")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: peer)
    let missing = parent.appendingPathComponent("missing-folder", isDirectory: true)
    let engine = SyncFileLockEngine()
    defer { engine.drain() }
    for selected in [missing, file, link, URL(string: "https://example.invalid/folder")!] {
      assertRefusesDirectory(engine, selected)
      XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
      XCTAssertFalse(FileManager.default.fileExists(atPath: peer.appendingPathComponent(".mindwtr.lock").path))
    }
    XCTAssertEqual(try Data(contentsOf: file), bytes)
    XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
  }

  func testStrictRootMovedOrReplacedBeforeMetadataValidationCreatesNoLock() throws {
    for replacement in [false, true] {
      let parent = try sandbox()
      defer { try? FileManager.default.removeItem(at: parent) }
      let selected = try selectedDirectory(in: parent)
      let displaced = parent.appendingPathComponent("displaced", isDirectory: true)
      var mutation: Result<Void, Error>?
      let engine = SyncFileLockEngine(strictRootBoundaryForTesting: { boundary in
        guard boundary == .retainedRoot else { return }
        mutation = Result {
          try FileManager.default.moveItem(at: selected, to: displaced)
          if replacement { try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: false) }
        }
      })
      defer { engine.drain() }
      assertRefusesDirectory(engine, selected)
      try XCTUnwrap(mutation).get()
      for directory in [parent, selected, displaced] {
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent(".mindwtr.lock").path),
                       "pre-metadata identity refusal must not create any lock")
      }
      let next = SyncFileLockEngine()
      let token = try next.acquireDirectory(displaced)
      try next.release(token)
    }
  }

  func testStrictRootReplacementAfterValidationStaysOnRetainedDirectoryAndRefusesLease() throws {
    for existingForeignLock in [false, true] {
      let parent = try sandbox()
      defer { try? FileManager.default.removeItem(at: parent) }
      let selected = try selectedDirectory(in: parent)
      let displaced = parent.appendingPathComponent("displaced", isDirectory: true)
      let foreignLock = selected.appendingPathComponent(".mindwtr.lock")
      let foreignBytes = Data("foreign-lock-do-not-touch".utf8)
      var mutation: Result<Void, Error>?
      let engine = SyncFileLockEngine(strictRootBoundaryForTesting: { boundary in
        guard boundary == .validatedRoot else { return }
        mutation = Result {
          try FileManager.default.moveItem(at: selected, to: displaced)
          try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: false)
          if existingForeignLock { try foreignBytes.write(to: foreignLock) }
        }
      })
      defer { engine.drain() }
      assertRefusesDirectory(engine, selected)
      try XCTUnwrap(mutation).get()
      XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
      if existingForeignLock { XCTAssertEqual(try Data(contentsOf: foreignLock), foreignBytes) }
      else { XCTAssertFalse(FileManager.default.fileExists(atPath: foreignLock.path)) }
      XCTAssertTrue(FileManager.default.fileExists(atPath: displaced.appendingPathComponent(".mindwtr.lock").path))
      let next = SyncFileLockEngine()
      let token = try next.acquireDirectory(displaced)
      try next.release(token)
    }
  }

  func testStrictRootChangedBeforeRegistrationCannotAdmitLease() throws {
    let parent = try sandbox()
    defer { try? FileManager.default.removeItem(at: parent) }
    let selected = try selectedDirectory(in: parent)
    let displaced = parent.appendingPathComponent("displaced", isDirectory: true)
    var mutation: Result<Void, Error>?
    let engine = SyncFileLockEngine(beforeLeaseRegistrationForTesting: {
      mutation = Result {
        try FileManager.default.moveItem(at: selected, to: displaced)
        try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: false)
      }
    })
    defer { engine.drain() }
    assertRefusesDirectory(engine, selected)
    try XCTUnwrap(mutation).get()
    XCTAssertFalse(FileManager.default.fileExists(atPath: selected.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
    let next = SyncFileLockEngine()
    let token = try next.acquireDirectory(displaced)
    try next.release(token)
  }

  func testLegacyAcquireStillAcceptsExistingAndMissingFileSelections() throws {
    let parent = try sandbox()
    defer { try? FileManager.default.removeItem(at: parent) }
    let selected = try selectedDirectory(in: parent)
    let existing = selected.appendingPathComponent("data.json")
    let bytes = Data("legacy-file-selection".utf8)
    try bytes.write(to: existing)
    let missing = selected.appendingPathComponent("missing.json")
    let engine = SyncFileLockEngine()
    defer { engine.drain() }
    for file in [existing, missing] {
      let token = try engine.acquire(file.absoluteString)
      try engine.revalidate(token)
      try engine.release(token)
    }
    XCTAssertEqual(try Data(contentsOf: existing), bytes)
    XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: selected.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
  }

  func testDrainRejectsAcquireCompletingAfterTeardown() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("mindwtr-lock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }

    let reachedRegistration = DispatchSemaphore(value: 0)
    let resumeRegistration = DispatchSemaphore(value: 0)
    let acquisitionCompleted = DispatchSemaphore(value: 0)
    let acquisitionResult = LockedBox<Result<String, Error>>()
    let engine = SyncFileLockEngine(beforeLeaseRegistrationForTesting: {
      reachedRegistration.signal()
      _ = resumeRegistration.wait(timeout: .now() + 10)
    })

    DispatchQueue.global(qos: .userInitiated).async {
      acquisitionResult.store(Result { try engine.acquire(root.absoluteString) })
      acquisitionCompleted.signal()
    }

    guard reachedRegistration.wait(timeout: .now() + 5) == .success else {
      resumeRegistration.signal()
      XCTFail("acquire never reached the registration barrier")
      return
    }
    engine.drain()
    resumeRegistration.signal()

    XCTAssertEqual(acquisitionCompleted.wait(timeout: .now() + 5), .success)
    guard let result = acquisitionResult.load() else {
      XCTFail("acquire did not publish a result")
      return
    }
    guard case .failure(let error) = result else {
      XCTFail("acquire must reject a lease completed after teardown")
      return
    }
    XCTAssertTrue(String(describing: error).contains("destroyed"))
    XCTAssertThrowsError(try engine.acquire(root.absoluteString))

    let replacement = SyncFileLockEngine()
    let token = try replacement.acquire(root.absoluteString)
    try replacement.release(token)
  }

  func testRootAuthorityBlocksReplacementLockOwner() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("mindwtr-lock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }
    let engine = SyncFileLockEngine()
    let first = try engine.acquire(root.absoluteString)
    let lock = root.appendingPathComponent(".mindwtr.lock")
    let displaced = root.appendingPathComponent(".mindwtr.lock.displaced")
    try FileManager.default.moveItem(at: lock, to: displaced)
    FileManager.default.createFile(atPath: lock.path, contents: Data("replacement".utf8))

    XCTAssertThrowsError(try engine.revalidate(first))
    XCTAssertThrowsError(try SyncFileLockEngine().acquire(root.absoluteString))
    XCTAssertThrowsError(try engine.release(first))

    let replacementEngine = SyncFileLockEngine()
    let next = try replacementEngine.acquire(root.absoluteString)
    try replacementEngine.release(next)
  }

  func testSymlinkLockFailsClosedWithoutTouchingPeer() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("mindwtr-lock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: root) }
    let peer = root.appendingPathComponent("peer")
    try Data("peer".utf8).write(to: peer)
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent(".mindwtr.lock"),
      withDestinationURL: peer
    )

    XCTAssertThrowsError(try SyncFileLockEngine().acquire(root.absoluteString))
    XCTAssertEqual(try Data(contentsOf: peer), Data("peer".utf8))
  }
}
