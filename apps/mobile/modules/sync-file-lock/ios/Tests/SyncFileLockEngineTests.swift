import XCTest
@testable import SyncFileLockEngine

final class SyncFileLockEngineTests: XCTestCase {
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
