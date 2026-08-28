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
