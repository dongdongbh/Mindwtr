import Darwin
import Foundation
import XCTest
@testable import SyncFileLockEngine

final class NativeFileSyncSessionTests: XCTestCase {
  private final class Counter: @unchecked Sendable {
    let lock = NSLock(); var value = 0
    @discardableResult func bump() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
  }
  private func root() throws -> URL {
    let url = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("file-sync-session-" + UUID().uuidString.lowercased(), isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    return url
  }
  private func access(_ root: URL) -> NativeFileSyncReadOwner.Access {
    var io = NativeFileSyncReadOwner.Access()
    io.applicationContainer = root.deletingLastPathComponent(); io.startScope = { _ in false }
    return io
  }
  private func refuses(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
    do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
  }
  func testBookmarkProjectionResolvesOnceAndKeepsTheSameLeaseUntilClose() async throws {
    let root = try root(), resolves = Counter(), starts = Counter(), stops = Counter()
    var io = access(root)
    io.resolve = { _ in resolves.bump(); return (root, false) }
    io.startScope = { _ in starts.bump(); return true }
    io.stopScope = { _ in stops.bump() }
    let session = NativeFileSyncSession(owner: NativeFileSyncReadOwner(selection: .bookmark(Data([1])), access: io, diagnostic: { _ in }))
    let directory = try await session.openDirectory()
    XCTAssertEqual(directory.absoluteString, root.absoluteString)
    XCTAssertEqual(resolves.count, 1); XCTAssertEqual(starts.count, 1); XCTAssertEqual(stops.count, 0)
    try await session.revalidate()
    await refuses { _ = try await session.openDirectory() }
    XCTAssertEqual(resolves.count, 1)
    let competitor = SyncFileLockEngine(); defer { competitor.drain() }
    XCTAssertThrowsError(try competitor.acquireDirectory(root))
    try await session.close()
    XCTAssertEqual(stops.count, 1)
    let lease = try competitor.acquireDirectory(root); try competitor.release(lease)
  }
  func testStaleOrFileBookmarkCannotProjectADirectoryOrRetainScope() async throws {
    let root = try root(), file = root.appendingPathComponent("picked-file")
    try Data([7]).write(to: file)
    for mode in ["stale", "file"] {
      let starts = Counter(), stops = Counter()
      var io = access(root)
      io.resolve = { _ in (mode == "file" ? file : root, mode == "stale") }
      io.startScope = { _ in starts.bump(); return true }
      io.stopScope = { _ in stops.bump() }
      let session = NativeFileSyncSession(owner: NativeFileSyncReadOwner(selection: .bookmark(Data([1])), access: io, diagnostic: { _ in }))
      await refuses { _ = try await session.openDirectory() }
      try await session.close()
      XCTAssertEqual(stops.count, starts.count)
      XCTAssertEqual(try Data(contentsOf: file), Data([7]))
    }
  }
  func testOversizeCapturedNodeRefusesBeforeAnyAccessRead() async throws {
    let root = try root(), count = Counter()
    try Data(repeating: 7, count: 9).write(to: root.appendingPathComponent("data.json"))
    var io = access(root)
    io.read = { fd, bytes, length in count.bump(); return Darwin.read(fd, bytes, length) }
    let owner = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, maximumReadBytes: 8, diagnostic: { _ in })
    let session = NativeFileSyncSession(owner: owner)
    try await session.open()
    await refuses { _ = try await session.read("data.json") }
    XCTAssertEqual(count.count, 0, "The allocation guard must precede Access.read")
    try await session.close(); try await session.close()
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), Data(repeating: 7, count: 9))
  }
  func testGrowthDuringReadCannotEscapeCapturedOrConfiguredBound() async throws {
    let root = try root(), count = Counter(), file = root.appendingPathComponent("data.json")
    try Data(repeating: 7, count: 8).write(to: file)
    var io = access(root)
    io.read = { fd, bytes, length in
      count.bump()
      if count.count == 1 {
        let writer = Darwin.open(file.path, O_WRONLY | O_APPEND | O_CLOEXEC)
        guard writer >= 0 else { return -1 }; defer { Darwin.close(writer) }
        var extra: UInt8 = 9; _ = Darwin.write(writer, &extra, 1)
      }
      return Darwin.read(fd, bytes, length)
    }
    let owner = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, maximumReadBytes: 8, diagnostic: { _ in })
    let session = NativeFileSyncSession(owner: owner)
    try await session.open(); await refuses { _ = try await session.read("data.json") }
    XCTAssertEqual(count.count, 1); try await session.close()
    XCTAssertEqual(try Data(contentsOf: file).count, 9)
  }
  func testAlreadyShutdownRetainsRealLeaseCleanupErrorAcrossFacadeCloses() async throws {
    let root = try root(), file = root.appendingPathComponent("data.json")
    try Data([7]).write(to: file)
    var io = access(root)
    io.read = { _, _, _ in
      let original = root.appendingPathComponent(".mindwtr.lock")
      do {
        try FileManager.default.moveItem(at: original, to: root.appendingPathComponent("retained-original-lock"))
        try Data().write(to: original)
      } catch { XCTFail("Real lock replacement failed") }
      errno = EIO; return -1
    }
    let owner = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, diagnostic: { _ in })
    let session = NativeFileSyncSession(owner: owner)
    try await session.open()
    await refuses { _ = try await session.read("data.json") }
    for _ in 0..<2 {
      do { try await session.close(); XCTFail("Retained cleanup error became success") }
      catch {
        guard let engineError = error as? SyncFileLockEngineError, case .unavailable(let message) = engineError else { return XCTFail("Cleanup error was replaced: \(error)") }
        XCTAssertEqual(message, ".mindwtr.lock identity changed")
      }
    }
    XCTAssertEqual(try Data(contentsOf: file), Data([7]))
  }
  func testSuccessfulCloseIsRepeatableAndLegacyCloseStillRejectsClosedHandle() async throws {
    let root = try root(), io = access(root)
    let owner = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, diagnostic: { _ in })
    let session = NativeFileSyncSession(owner: owner)
    try await session.open(); try await session.revalidate(); try await session.close(); try await session.close()
    let legacy = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, diagnostic: { _ in })
    let handle = try await legacy.open(); try await legacy.close(handle)
    do { try await legacy.close(handle); XCTFail("Legacy close changed") }
    catch { XCTAssertEqual(error as? NativeFileSyncReadOwner.Failure, .closed) }
    try await legacy.finishClosing()
  }
  func testCloseWaitsForEnteredOwnerReadAndReleasesDescriptorsBeforeSettlement() async throws {
    let root = try root(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), stopped = Counter(), reads = Counter()
    defer { release.signal() }
    try Data([7]).write(to: root.appendingPathComponent("data.json"))
    var io = access(root)
    io.read = { fd, buffer, length in
      if reads.bump() == 1 { entered.signal(); release.wait() }
      return Darwin.read(fd, buffer, length)
    }
    io.stopScope = { _ in stopped.bump() }
    io.startScope = { _ in true }
    let owner = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: io, maximumReadBytes: 8, diagnostic: { _ in })
    let session = NativeFileSyncSession(owner: owner)
    try await session.open()
    let read = Task { try await session.read("data.json") }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
    let closed = Counter()
    let close = Task { try await session.close(); closed.bump() }
    try await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(closed.count, 0); XCTAssertEqual(stopped.count, 0)
    release.signal()
    await refuses { _ = try await read.value }
    try await close.value
    XCTAssertEqual(closed.count, 1); XCTAssertEqual(stopped.count, 1)
    XCTAssertGreaterThanOrEqual(reads.count, 2, "The real reader must reach EOF without entering a second test gate")
    try await session.close()
    let legacy = NativeFileSyncReadOwner(selection: .pickedDirectory(root), access: access(root), diagnostic: { _ in })
    let handle = try await legacy.open(); try await legacy.close(handle)
  }

}
