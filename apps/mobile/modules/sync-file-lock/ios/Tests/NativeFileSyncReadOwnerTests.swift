import Darwin
import Foundation
import XCTest
@testable import SyncFileLockEngine

final class NativeFileSyncReadOwnerTests: XCTestCase {
  private typealias Owner = NativeFileSyncReadOwner
  private final class Counts: @unchecked Sendable {
    private let lock = NSLock()
    private var values = [String: Int]()
    func increment(_ name: String) { lock.lock(); values[name, default: 0] += 1; lock.unlock() }
    func set(_ name: String, _ value: Int) { lock.lock(); values[name] = value; lock.unlock() }
    func count(_ name: String) -> Int { lock.lock(); defer { lock.unlock() }; return values[name, default: 0] }
  }
  private func fixture() throws -> URL {
    let parent = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("file-sync-read-" + UUID().uuidString.lowercased(), isDirectory: true)
    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
    return parent
  }
  private func folder(_ parent: URL, _ name: String = "selected") throws -> URL {
    let root = parent.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    return root
  }
  private func access(_ counts: Counts) -> Owner.Access {
    var value = Owner.Access()
    value.startScope = { _ in counts.increment("scope-start"); return true }
    value.stopScope = { _ in counts.increment("scope-stop") }
    return value
  }
  private func owner(_ root: URL, _ counts: Counts, access supplied: Owner.Access? = nil) -> Owner {
    Owner(selection: .pickedDirectory(root), access: supplied ?? access(counts), diagnostic: { event in
      switch event {
      case .admitted: counts.increment("admitted")
      case .createdWriteCompleted: counts.increment("write-completed")
      case .quarantineCompleted: counts.increment("quarantine-completed")
      case .ownedDeleteCompleted: counts.increment("delete-completed")
      }
    })
  }
  private func refuses(_ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
    do { try await work(); XCTFail("Expected refusal", file: file, line: line) } catch { }
  }

  func testActualDirectoryLeaseReadsListsAndReleasesWithoutChangingUnknownBytes() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent); let bytes = Data("{\"tasks\":[]}".utf8)
    try bytes.write(to: root.appendingPathComponent("資料.json"))
    let sentinel = Data([0, 255, 7, 0]); try sentinel.write(to: root.appendingPathComponent("unknown"))
    let counts = Counts()
    let observed = owner(root, counts)
    let handle = try await observed.open()
    let data = try await observed.read("資料.json", using: handle)
    XCTAssertEqual(data, .bytes(bytes)); XCTAssertEqual(counts.count("admitted"), 1)
    let first = try await observed.list(using: handle), second = try await observed.list(using: handle)
    XCTAssertEqual(first, second); XCTAssertEqual(Set(first.map(\.name)), Set([".mindwtr.lock", "資料.json", "unknown"]))
    let metadata = try await observed.metadata("資料.json", using: handle)
    XCTAssertEqual(metadata?.byteCount, Int64(bytes.count))
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    XCTAssertThrowsError(try competing.acquireDirectory(root))
    try await observed.close(handle)
    let token = try competing.acquireDirectory(root); try competing.release(token)
    XCTAssertEqual(counts.count("scope-start"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("unknown")), sentinel)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("資料.json")), bytes)
    await refuses { _ = try await observed.read("資料.json", using: handle) }
    await refuses { try await observed.close(handle) }
  }

  func testKnownAbsentAndSuccessfulEmptyAreDifferent() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent); try Data().write(to: root.appendingPathComponent("empty"))
    let reader = owner(root, Counts()), handle = try await reader.open()
    let empty = try await reader.read("empty", using: handle), absent = try await reader.read("missing", using: handle)
    let metadata = try await reader.metadata("missing", using: handle)
    XCTAssertEqual(empty, .bytes(Data())); XCTAssertEqual(absent, .absent); XCTAssertNil(metadata)
    try await reader.close(handle)
  }

  func testExclusiveCreationAndBothWritePathsCompleteUnderRealLease() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), sentinel = Data([0, 255, 7]), counts = Counts()
    for name in ["unknown", "data.json", "data.json.bak", "data.json.previous"] { try sentinel.write(to: root.appendingPathComponent(name)) }
    var io = access(counts)
    let syncFile = io.syncFile
    io.syncFile = { fd in
      counts.increment("file-sync"); counts.set("fd-\(counts.count("file-sync"))", Int(fd))
      try syncFile(fd)
    }
    io.write = { fd, buffer, length in
      counts.increment("write")
      if counts.count("write") == 1 { errno = EINTR; return -1 }
      return Darwin.write(fd, buffer, min(length, 4096))
    }
    io.stopScope = { _ in
      for index in 1...2 { XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd-\(index)")), F_GETFD), -1) }
      counts.increment("scope-stop")
    }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    let first = try await writer.createExclusive("empty", using: handle)
    XCTAssertEqual(first, .created)
    try await writer.writeCreated("empty", bytes: Data(), using: handle)
    let payload = Data(repeating: 42, count: 180_000)
    let second = try await writer.createExclusive("normal", using: handle)
    XCTAssertEqual(second, .created)
    try await writer.writeBytes("normal", bytes: payload, using: handle)
    let empty = try await writer.read("empty", using: handle), normal = try await writer.read("normal", using: handle)
    XCTAssertEqual(empty, .bytes(Data())); XCTAssertEqual(normal, .bytes(payload))
    let metadata = try await writer.metadata("normal", using: handle)
    XCTAssertEqual(metadata?.byteCount, Int64(payload.count)); XCTAssertGreaterThan(counts.count("write"), 2)
    XCTAssertEqual(counts.count("write-completed"), 2)
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    XCTAssertThrowsError(try competing.acquireDirectory(root))
    try await writer.close(handle)
    let token = try competing.acquireDirectory(root); try competing.release(token)
    XCTAssertEqual(counts.count("scope-stop"), 1)
    for name in ["unknown", "data.json", "data.json.bak", "data.json.previous"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), sentinel) }
  }

  func testCanonicalProjectionRevalidatesTheHandleAndActualRootIdentity() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), retained = parent.appendingPathComponent("retained-root"), bytes = Data([1, 2, 3])
    try bytes.write(to: root.appendingPathComponent("data.json"))
    let counts = Counts(), writer = owner(root, counts), handle = try await writer.open()
    let projected = try await writer.canonicalDirectory(handle)
    XCTAssertEqual(projected.absoluteString, root.absoluteString)
    try FileManager.default.moveItem(at: root, to: retained)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let sentinel = Data([9, 8, 7]); try sentinel.write(to: root.appendingPathComponent("foreign"))
    await refuses { _ = try await writer.canonicalDirectory(handle) }
    for _ in 0..<2 {
      do { try await writer.finishClosing(); XCTFail("The changed-root cleanup error must remain retained") }
      catch {
        guard let failure = error as? SyncFileLockEngineError, case .unavailable(let message) = failure else {
          XCTFail("Unexpected cleanup error: \(error)"); continue
        }
        XCTAssertEqual(message, "sync root identity changed")
      }
    }
    XCTAssertEqual(counts.count("scope-start"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: retained.appendingPathComponent("data.json")), bytes)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("foreign")), sentinel)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["foreign"], "The stale handle must not retarget the replacement root")
  }

  func testExistingNodesAndUnownedNamesNeverGrantWriteAuthority() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for kind in ["file", "directory", "symlink", "missing"] {
      let root = try folder(parent, kind), target = root.appendingPathComponent("target"), foreign = parent.appendingPathComponent("foreign-" + kind)
      let sentinel = Data([9, 8, 7]); try sentinel.write(to: foreign)
      if kind == "file" { try sentinel.write(to: target) }
      if kind == "directory" { try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false) }
      if kind == "symlink" { try FileManager.default.createSymbolicLink(at: target, withDestinationURL: foreign) }
      let counts = Counts(); var io = access(counts)
      io.write = { fd, buffer, length in counts.increment("write"); return Darwin.write(fd, buffer, length) }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      if kind != "missing" {
        let result = try await writer.createExclusive("target", using: handle)
        XCTAssertEqual(result, .exists)
      }
      await refuses { try await writer.writeBytes("target", bytes: Data([1]), using: handle) }
      XCTAssertEqual(counts.count("write"), 0); XCTAssertEqual(counts.count("write-completed"), 0)
      XCTAssertEqual(try Data(contentsOf: foreign), sentinel)
      if kind == "file" { XCTAssertEqual(try Data(contentsOf: target), sentinel) }
      XCTAssertEqual(counts.count("scope-stop"), 1)
    }
  }

  func testInvalidForeignAndUnicodeLookalikeNamesCannotRetargetCreatedFiles() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let a = try folder(parent, "a"), b = try folder(parent, "b"), counts = Counts()
    var io = access(counts)
    io.write = { fd, buffer, length in counts.increment("write"); return Darwin.write(fd, buffer, length) }
    let writer = owner(a, counts, access: io), other = owner(b, Counts())
    let handle = try await writer.open(), foreign = try await other.open()
    for name in ["", ".", "..", "../foreign", "/target", "bad\0name", "folder/target", ".mindwtr.lock"] {
      await refuses { _ = try await writer.createExclusive(name, using: handle) }
      await refuses { try await writer.writeCreated(name, bytes: Data([1]), using: handle) }
    }
    await refuses { _ = try await writer.createExclusive("target", using: foreign) }
    await refuses { try await writer.writeBytes("target", bytes: Data([1]), using: foreign) }
    let created = try await writer.createExclusive("\u{e9}", using: handle)
    XCTAssertEqual(created, .created)
    await refuses { try await writer.writeBytes("e\u{301}", bytes: Data([1]), using: handle) }
    XCTAssertEqual(counts.count("write"), 0)
    XCTAssertEqual(try Data(contentsOf: a.appendingPathComponent("\u{e9}")), Data())
    try await other.close(foreign)
  }

  func testCreatedFileAndRootReplacementAreRefusedBeforeAnyWrite() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["replace", "modify", "hardlink", "root"] {
      let root = try folder(parent, mode), target = root.appendingPathComponent("target"), counts = Counts()
      var io = access(counts)
      io.write = { fd, buffer, length in counts.increment("write"); return Darwin.write(fd, buffer, length) }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let created = try await writer.createExclusive("target", using: handle); XCTAssertEqual(created, .created)
      if mode == "replace" { try FileManager.default.removeItem(at: target) }
      if mode == "root" {
        try FileManager.default.moveItem(at: root, to: parent.appendingPathComponent("moved"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
      }
      if mode == "hardlink" { try FileManager.default.linkItem(at: target, to: root.appendingPathComponent("alias")) }
      else { try Data([9]).write(to: target) }
      await refuses { try await writer.writeCreated("target", bytes: Data([1, 2]), using: handle) }
      XCTAssertEqual(counts.count("write"), 0); XCTAssertEqual(counts.count("write-completed"), 0)
      XCTAssertEqual(try Data(contentsOf: target), mode == "hardlink" ? Data() : Data([9]))
      XCTAssertEqual(counts.count("scope-stop"), 1)
    }
  }

  func testCompletedCreationCannotBeRewritten() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts(), writer = owner(root, counts), handle = try await writer.open()
    let created = try await writer.createExclusive("target", using: handle); XCTAssertEqual(created, .created)
    try await writer.writeCreated("target", bytes: Data([1, 2, 3]), using: handle)
    await refuses { try await writer.writeBytes("target", bytes: Data([9]), using: handle) }
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("target")), Data([1, 2, 3]))
    XCTAssertEqual(counts.count("write-completed"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
  }

  func testPartialZeroFlushAndReadbackFailuresRetainBytesWithoutCompletion() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let payload = Data(repeating: 42, count: 32)
    for mode in ["zero", "partial", "file-flush", "directory-flush", "readback"] {
      let root = try folder(parent, mode), counts = Counts(); var io = access(counts)
      let syncFile = io.syncFile, syncDirectory = io.syncDirectory
      io.write = { fd, buffer, length in
        counts.set("fd", Int(fd)); counts.increment("write")
        if mode == "zero" { return 0 }
        if mode == "partial" {
          if counts.count("write") == 1 { return Darwin.write(fd, buffer, 3) }
          errno = EIO; return -1
        }
        return Darwin.write(fd, buffer, length)
      }
      io.syncFile = { fd in try syncFile(fd); if mode == "file-flush" { throw Owner.Failure.incompleteWrite } }
      io.syncDirectory = { fd in
        try syncDirectory(fd); counts.increment("directory-flush")
        if mode == "directory-flush", counts.count("directory-flush") == 2 { throw Owner.Failure.incompleteWrite }
      }
      io.read = { fd, buffer, length in
        let count = Darwin.read(fd, buffer, length)
        if mode == "readback", count > 0 { buffer.storeBytes(of: UInt8(0), as: UInt8.self) }
        return count
      }
      io.stopScope = { _ in
        XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1)
        counts.increment("scope-stop")
      }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let created = try await writer.createExclusive("target", using: handle); XCTAssertEqual(created, .created)
      await refuses { try await writer.writeCreated("target", bytes: payload, using: handle) }
      let expected = mode == "zero" ? Data() : mode == "partial" ? Data(payload.prefix(3)) : payload
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("target")), expected)
      XCTAssertEqual(counts.count("write-completed"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
      let writes = counts.count("write")
      await refuses { try await writer.writeBytes("target", bytes: payload, using: handle) }
      XCTAssertEqual(counts.count("write"), writes)
      let competing = SyncFileLockEngine(); defer { competing.drain() }
      let token = try competing.acquireDirectory(root); try competing.release(token)
    }
  }

  func testWriteCoordinatorMustSettleExactlyOnceAtTheIntendedURL() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in 0...3 {
      let root = try folder(parent, "mode-\(mode)"), counts = Counts(); var io = access(counts)
      let coordinate = io.coordinateWrite
      io.coordinateWrite = { url, body in
        counts.increment("write-coordinate")
        if counts.count("write-coordinate") == 1 { try coordinate(url, body); return }
        if mode == 0 { return }
        if mode == 1 { body(url.deletingLastPathComponent()); return }
        try coordinate(url, body)
        if mode == 2 { body(url) }
        if mode == 3 { throw Owner.Failure.coordination }
      }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let created = try await writer.createExclusive("target", using: handle); XCTAssertEqual(created, .created)
      await refuses { try await writer.writeCreated("target", bytes: Data([1]), using: handle) }
      XCTAssertEqual(counts.count("write-completed"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("target")), mode < 2 ? Data() : Data([1]))
    }
  }

  func testCloseAndCancellationDrainEnteredWritesAndCloseCreatedFDsBeforeScopeRelease() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["close", "cancel", "error"] {
      let root = try folder(parent, mode), counts = Counts()
      let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
      let closeStarted = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
      var io = access(counts)
      io.write = { fd, buffer, length in
        counts.set("fd", Int(fd)); counts.increment("write"); entered.signal()
        guard release.wait(timeout: .now() + 5) == .success else { errno = EIO; return -1 }
        if mode == "error" { errno = EIO; return -1 }
        return Darwin.write(fd, buffer, length)
      }
      io.stopScope = { _ in
        XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1)
        counts.increment("scope-stop")
      }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let created = try await writer.createExclusive("target", using: handle); XCTAssertEqual(created, .created)
      let writing = Task { try await writer.writeCreated("target", bytes: Data([1, 2, 3]), using: handle) }
      XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
      var closing: Task<Void, Error>?
      if mode == "cancel" { writing.cancel() }
      else {
        closing = Task { closeStarted.signal(); defer { closed.signal() }; try await writer.close(handle) }
        XCTAssertEqual(closeStarted.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
      }
      XCTAssertEqual(counts.count("scope-stop"), 0)
      let competing = SyncFileLockEngine(); defer { competing.drain() }
      XCTAssertThrowsError(try competing.acquireDirectory(root))
      let late = Task { try await writer.createExclusive("late", using: handle) }
      release.signal()
      await refuses { try await writing.value }
      if let closing { try await closing.value }
      await refuses { _ = try await late.value }
      XCTAssertEqual(counts.count("scope-stop"), 1); XCTAssertEqual(counts.count("write-completed"), 0)
      XCTAssertEqual(counts.count("write"), 1)
      XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("late").path))
      let token = try competing.acquireDirectory(root); try competing.release(token)
    }
  }

  func testObservedQuarantineAndOwnedStageDeletionUseTheSameRealLease() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), prior = Data([1, 2, 3]), sentinel = Data([9, 8, 7]), counts = Counts()
    try prior.write(to: root.appendingPathComponent("data.json"))
    for name in ["unknown", "data.json.bak"] { try sentinel.write(to: root.appendingPathComponent(name)) }
    var io = access(counts)
    io.read = { fd, buffer, length in
      counts.set("last-fd", Int(fd)); return Darwin.read(fd, buffer, length)
    }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    try await writer.renameObserved("data.json", to: ".mindwtr-et-q-prior", expectedBytes: prior, using: handle)
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("data.json").path))
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(".mindwtr-et-q-prior")), prior)
    let adoptedFD = Int32(counts.count("last-fd"))
    try await writer.deleteOwned(".mindwtr-et-q-prior", expectedBytes: prior, using: handle)
    XCTAssertEqual(Darwin.fcntl(adoptedFD, F_GETFD), -1)
    for (index, bytes) in [Data(), Data(repeating: 42, count: 80_000)].enumerated() {
      let stage = ".mindwtr-et-s-\(index)", quarantine = ".mindwtr-et-q-\(index)"
      let result = try await writer.createExclusive(stage, using: handle); XCTAssertEqual(result, .created)
      try await writer.writeCreated(stage, bytes: bytes, using: handle)
      if index == 0 {
        try await writer.deleteOwned(stage, expectedBytes: bytes, using: handle)
      } else {
        let createdFD = Int32(counts.count("last-fd"))
        try await writer.renameObserved(stage, to: quarantine, expectedBytes: bytes, using: handle)
        try await writer.deleteOwned(quarantine, expectedBytes: bytes, using: handle)
        XCTAssertEqual(Darwin.fcntl(createdFD, F_GETFD), -1)
      }
    }
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    XCTAssertThrowsError(try competing.acquireDirectory(root))
    XCTAssertEqual(counts.count("quarantine-completed"), 2); XCTAssertEqual(counts.count("delete-completed"), 3)
    try await writer.close(handle)
    let token = try competing.acquireDirectory(root); try competing.release(token)
    XCTAssertEqual(counts.count("scope-stop"), 1)
    for name in ["unknown", "data.json.bak"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), sentinel) }
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: root.path)), Set([".mindwtr.lock", "unknown", "data.json.bak"]))
  }

  func testQuarantineCannotBecomeAnOwnedWritableCreation() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), bytes = Data([1, 2, 3]), counts = Counts()
    try bytes.write(to: root.appendingPathComponent("data.json"))
    var io = access(counts)
    io.write = { fd, buffer, length in counts.increment("write"); return Darwin.write(fd, buffer, length) }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    try await writer.renameObserved("data.json", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle)
    await refuses { try await writer.writeBytes(".mindwtr-et-q-prior", bytes: Data([9]), using: handle) }
    XCTAssertEqual(counts.count("write"), 0); XCTAssertEqual(counts.count("write-completed"), 0)
    XCTAssertEqual(counts.count("quarantine-completed"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(".mindwtr-et-q-prior")), bytes)
  }

  func testUnfinishedCreationCannotGrantObservedQuarantineAuthority() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts()
    var io = access(counts); let rename = io.renameExclusive
    io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    _ = try await writer.createExclusive(".mindwtr-et-s-stage", using: handle)
    await refuses { try await writer.renameObserved(".mindwtr-et-s-stage", to: ".mindwtr-et-q-prior", expectedBytes: Data(), using: handle) }
    XCTAssertEqual(counts.count("rename"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(".mindwtr-et-s-stage")), Data())
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".mindwtr-et-q-prior").path))
  }

  func testQuarantineRejectsInvalidDestinationsAndForeignHandlesWithoutIO() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), otherRoot = try folder(parent, "other"), counts = Counts(), bytes = Data([1])
    try bytes.write(to: root.appendingPathComponent("source"))
    var io = access(counts); let rename = io.renameExclusive
    io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
    let writer = owner(root, counts, access: io), other = owner(otherRoot, Counts())
    let handle = try await writer.open(), foreign = try await other.open()
    for name in ["", ".", "..", "../target", "/target", "bad\0name", "folder/target", ".mindwtr.lock", "data.json", ".mindwtr-et-s-target", ".MINDWTR-et-q-target", ".mindwtr-et-q-"] {
      await refuses { try await writer.renameObserved("source", to: name, expectedBytes: bytes, using: handle) }
    }
    for name in ["", ".", "..", "../source", "/source", "bad\0name", "folder/source", ".mindwtr.lock"] {
      await refuses { try await writer.renameObserved(name, to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
      await refuses { try await writer.deleteOwned(name, expectedBytes: bytes, using: handle) }
    }
    await refuses { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: foreign) }
    await refuses { try await writer.deleteOwned(".mindwtr-et-s-stage", expectedBytes: bytes, using: foreign) }
    XCTAssertEqual(counts.count("rename"), 0); XCTAssertEqual(counts.count("scope-stop"), 0)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("source")), bytes)
    try await writer.close(handle); try await other.close(foreign)
    await refuses { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
    await refuses { try await writer.deleteOwned(".mindwtr-et-s-stage", expectedBytes: bytes, using: handle) }
  }

  func testQuarantineNeverReplacesDestinationOrMovesAnUnexpectedGeneration() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["collision", "bytes", "missing", "directory", "symlink", "hardlink", "root", "unicode"] {
      let root = try folder(parent, mode), source = root.appendingPathComponent("source"), destination = root.appendingPathComponent(".mindwtr-et-q-prior")
      let bytes = Data([1, 2, 3]), peer = Data([9, 8, 7]), counts = Counts()
      if mode == "directory" { try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false) }
      else if mode == "symlink" {
        try bytes.write(to: root.appendingPathComponent("sentinel"))
        try FileManager.default.createSymbolicLink(at: source, withDestinationURL: root.appendingPathComponent("sentinel"))
      } else if mode != "missing" { try bytes.write(to: source) }
      if mode == "hardlink" { try FileManager.default.linkItem(at: source, to: root.appendingPathComponent("alias")) }
      if mode == "collision" { try peer.write(to: destination) }
      if mode == "unicode" { try bytes.write(to: root.appendingPathComponent("\u{e9}")) }
      var io = access(counts); let rename = io.renameExclusive
      io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      var requestedSource = "source"
      var unicodeEntry: String?
      if mode == "unicode" {
        let listing = try await writer.list(using: handle)
        let actual = try XCTUnwrap(listing.first(where: { $0.name == "\u{e9}" })).name
        unicodeEntry = actual
        requestedSource = actual.utf8.elementsEqual("\u{e9}".utf8) ? "e\u{301}" : "\u{e9}"
        XCTAssertFalse(actual.utf8.elementsEqual(requestedSource.utf8))
      }
      if mode == "root" {
        try FileManager.default.moveItem(at: root, to: parent.appendingPathComponent("old-root"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try peer.write(to: source)
      }
      await refuses {
        try await writer.renameObserved(requestedSource, to: ".mindwtr-et-q-prior", expectedBytes: mode == "bytes" ? peer : bytes, using: handle)
      }
      XCTAssertEqual(counts.count("rename"), mode == "collision" ? 1 : 0)
      XCTAssertEqual(counts.count("quarantine-completed"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
      if mode == "collision" { XCTAssertEqual(try Data(contentsOf: destination), peer) }
      else { XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path)) }
      if ["collision", "bytes", "hardlink", "unicode"].contains(mode) { XCTAssertEqual(try Data(contentsOf: source), bytes) }
      if mode == "root" { XCTAssertEqual(try Data(contentsOf: source), peer) }
      if mode == "symlink" { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("sentinel")), bytes) }
      if let unicodeEntry { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(unicodeEntry)), bytes) }
    }
  }

  func testLockCaseAliasesAreRefusedBeforeAnyQuarantineMutation() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for (index, alias) in [".MINDWTR.LOCK", ".MiNdWtR.LoCk"].enumerated() {
      let root = try folder(parent, "alias-\(index)"), counts = Counts()
      var io = access(counts); let rename = io.renameExclusive
      io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let lock = root.appendingPathComponent(".mindwtr.lock"), bytes = try Data(contentsOf: lock)
      var before = Darwin.stat(); XCTAssertEqual(Darwin.lstat(lock.path, &before), 0)
      let listing = try await writer.list(using: handle)
      XCTAssertTrue(listing.contains(where: { $0.name.utf8.elementsEqual(".mindwtr.lock".utf8) }))
      XCTAssertFalse(listing.contains(where: { $0.name.utf8.elementsEqual(alias.utf8) }))
      await refuses { try await writer.renameObserved(alias, to: ".mindwtr-et-q-lock", expectedBytes: bytes, using: handle) }
      XCTAssertEqual(counts.count("rename"), 0); XCTAssertEqual(counts.count("quarantine-completed"), 0)
      XCTAssertEqual(counts.count("scope-stop"), 1)
      XCTAssertEqual(try Data(contentsOf: lock), bytes)
      var after = Darwin.stat(); XCTAssertEqual(Darwin.lstat(lock.path, &after), 0)
      XCTAssertEqual(after.st_dev, before.st_dev); XCTAssertEqual(after.st_ino, before.st_ino)
      XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".mindwtr-et-q-lock").path))
      let competing = SyncFileLockEngine(); defer { competing.drain() }
      let token = try competing.acquireDirectory(root); try competing.release(token)
    }
  }

  func testSourceReplacementDuringCompleteObservationRefusesBeforeRename() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), bytes = Data([1, 2, 3]), peer = Data([9, 8, 7]), counts = Counts()
    let source = root.appendingPathComponent("source"), retained = root.appendingPathComponent("retained")
    try bytes.write(to: source)
    var io = access(counts); let rename = io.renameExclusive
    io.read = { fd, buffer, length in
      let count = Darwin.read(fd, buffer, length)
      if count == 0, counts.count("replaced") == 0 {
        counts.increment("replaced")
        do { try FileManager.default.moveItem(at: source, to: retained); try peer.write(to: source) }
        catch { XCTFail("Could not establish replacement control") }
      }
      return count
    }
    io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    await refuses { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
    XCTAssertEqual(counts.count("rename"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: source), peer); XCTAssertEqual(try Data(contentsOf: retained), bytes)
  }

  func testDeleteRequiresCurrentOwnerRoleAndExactGenerationBeforeUnlink() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["read-stage", "read-quarantine", "canonical", "backup", "created-quarantine", "unfinished", "wrong-bytes", "modified", "replaced", "hardlink", "missing", "old-owner", "unicode"] {
      let root = try folder(parent, mode), counts = Counts(), bytes = Data([1, 2, 3]), peer = Data([9, 8, 7])
      let name = mode == "canonical" ? "data.json" : mode == "backup" ? "data.json.bak" : ["read-quarantine", "created-quarantine"].contains(mode) ? ".mindwtr-et-q-prior" : mode == "unicode" ? ".mindwtr-et-s-\u{e9}" : ".mindwtr-et-s-stage"
      let target = root.appendingPathComponent(name)
      var io = access(counts); let unlink = io.unlink
      io.unlink = { fd, name in counts.increment("unlink"); return unlink(fd, name) }
      var writer = owner(root, counts, access: io), handle = try await writer.open()
      if mode.hasPrefix("read-") {
        try bytes.write(to: target)
        let read = try await writer.read(name, using: handle); XCTAssertEqual(read, .bytes(bytes))
      } else {
        let result = try await writer.createExclusive(name, using: handle); XCTAssertEqual(result, .created)
        if mode != "unfinished" { try await writer.writeCreated(name, bytes: bytes, using: handle) }
      }
      if mode == "modified" { try peer.write(to: target) }
      if mode == "replaced" {
        try FileManager.default.moveItem(at: target, to: root.appendingPathComponent("retained")); try peer.write(to: target)
      }
      if mode == "hardlink" { try FileManager.default.linkItem(at: target, to: root.appendingPathComponent("alias")) }
      if mode == "missing" { try FileManager.default.removeItem(at: target) }
      if mode == "old-owner" {
        try await writer.close(handle)
        writer = owner(root, counts, access: io); handle = try await writer.open()
        let read = try await writer.read(name, using: handle); XCTAssertEqual(read, .bytes(bytes))
      }
      let stopped = counts.count("scope-stop")
      await refuses {
        try await writer.deleteOwned(mode == "unicode" ? ".mindwtr-et-s-e\u{301}" : name, expectedBytes: mode == "wrong-bytes" ? peer : bytes, using: handle)
      }
      XCTAssertEqual(counts.count("unlink"), 0); XCTAssertEqual(counts.count("delete-completed"), 0)
      XCTAssertEqual(counts.count("scope-stop"), stopped + 1)
      if mode == "missing" { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)) }
      else { XCTAssertEqual(try Data(contentsOf: target), mode == "unfinished" ? Data() : ["modified", "replaced"].contains(mode) ? peer : bytes) }
      if mode == "replaced" { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("retained")), bytes) }
    }
  }

  func testRenameCannotOverwriteAStaleDestinationLedgerEntry() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts(), bytes = Data([1, 2, 3])
    try bytes.write(to: root.appendingPathComponent("source"))
    var io = access(counts); let rename = io.renameExclusive, syncFile = io.syncFile
    io.syncFile = { fd in counts.set("fd", Int(fd)); try syncFile(fd) }
    io.renameExclusive = { fd, source, destination in counts.increment("rename"); return rename(fd, source, destination) }
    io.stopScope = { _ in XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1); counts.increment("scope-stop") }
    let writer = owner(root, counts, access: io), handle = try await writer.open()
    _ = try await writer.createExclusive(".mindwtr-et-q-prior", using: handle)
    try await writer.writeCreated(".mindwtr-et-q-prior", bytes: bytes, using: handle)
    try FileManager.default.removeItem(at: root.appendingPathComponent(".mindwtr-et-q-prior"))
    await refuses { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
    XCTAssertEqual(counts.count("rename"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("source")), bytes)
  }

  func testRenameFailuresRetainTruthfulNamesAndNeverGrantRestartDeletion() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["syscall", "flush", "readback", "recreated", "coordinate-zero", "coordinate-wrong", "coordinate-twice", "coordinate-after"] {
      let root = try folder(parent, mode), counts = Counts(), bytes = Data([1, 2, 3]), peer = Data([9, 8, 7])
      let source = root.appendingPathComponent("source"), destination = root.appendingPathComponent(".mindwtr-et-q-prior")
      try bytes.write(to: source)
      var io = access(counts); let rename = io.renameExclusive, syncDirectory = io.syncDirectory, coordinate = io.coordinateWrite
      io.read = { fd, buffer, length in
        counts.set("fd", Int(fd)); counts.increment("read")
        let count = Darwin.read(fd, buffer, length)
        if mode == "readback", counts.count("moved") == 1, count > 0 { buffer.storeBytes(of: UInt8(0), as: UInt8.self) }
        return count
      }
      io.renameExclusive = { fd, from, to in
        if mode == "syscall" { errno = EIO; return -1 }
        let result = rename(fd, from, to)
        if result == 0 {
          counts.increment("moved")
          if mode == "recreated" { do { try peer.write(to: source) } catch { XCTFail("Could not establish peer control") } }
        }
        return result
      }
      io.syncDirectory = { fd in try syncDirectory(fd); if mode == "flush" { throw Owner.Failure.incompleteWrite } }
      io.coordinateWrite = { url, body in
        if mode == "coordinate-zero" { return }
        if mode == "coordinate-wrong" { body(url.deletingLastPathComponent()); return }
        try coordinate(url, body)
        if mode == "coordinate-twice" { body(url) }
        if mode == "coordinate-after" { throw Owner.Failure.coordination }
      }
      io.stopScope = { _ in
        if counts.count("read") > 0 { XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1) }
        counts.increment("scope-stop")
      }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      await refuses { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
      XCTAssertEqual(counts.count("quarantine-completed"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
      if counts.count("moved") == 1 {
        XCTAssertEqual(try Data(contentsOf: destination), bytes)
        if mode == "recreated" { XCTAssertEqual(try Data(contentsOf: source), peer) }
        else { XCTAssertFalse(FileManager.default.fileExists(atPath: source.path)) }
        let restarted = owner(root, Counts()), next = try await restarted.open()
        await refuses { try await restarted.deleteOwned(".mindwtr-et-q-prior", expectedBytes: bytes, using: next) }
        XCTAssertEqual(try Data(contentsOf: destination), bytes)
      } else { XCTAssertEqual(try Data(contentsOf: source), bytes); XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path)) }
      await refuses { _ = try await writer.createExclusive("late", using: handle) }
    }
  }

  func testOwnedDeleteFailuresNeverAcknowledgeOrRemoveARecreatedPeer() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for mode in ["syscall", "flush", "readback", "recreated", "coordinate-zero", "coordinate-wrong", "coordinate-twice", "coordinate-after"] {
      let root = try folder(parent, mode), counts = Counts(), bytes = Data([1, 2, 3]), peer = Data([9, 8, 7])
      let target = root.appendingPathComponent(".mindwtr-et-s-stage")
      var io = access(counts); let unlink = io.unlink, syncDirectory = io.syncDirectory, coordinate = io.coordinateWrite, syncFile = io.syncFile
      io.syncFile = { fd in counts.set("fd", Int(fd)); try syncFile(fd) }
      io.unlink = { fd, name in
        counts.increment("unlink")
        if mode == "syscall" { errno = EIO; return -1 }
        let result = unlink(fd, name)
        if result == 0 {
          counts.increment("removed")
          if mode == "recreated" { do { try peer.write(to: target) } catch { XCTFail("Could not establish peer control") } }
        }
        return result
      }
      io.read = { fd, buffer, length in
        let count = Darwin.read(fd, buffer, length)
        if mode == "readback", counts.count("armed") == 1, count > 0 { buffer.storeBytes(of: UInt8(0), as: UInt8.self) }
        return count
      }
      io.syncDirectory = { fd in try syncDirectory(fd); if mode == "flush", counts.count("armed") == 1 { throw Owner.Failure.incompleteWrite } }
      io.coordinateWrite = { url, body in
        if counts.count("armed") == 0 { try coordinate(url, body); return }
        if mode == "coordinate-zero" { return }
        if mode == "coordinate-wrong" { body(url.deletingLastPathComponent()); return }
        try coordinate(url, body)
        if mode == "coordinate-twice" { body(url) }
        if mode == "coordinate-after" { throw Owner.Failure.coordination }
      }
      io.stopScope = { _ in XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1); counts.increment("scope-stop") }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      _ = try await writer.createExclusive(".mindwtr-et-s-stage", using: handle)
      try await writer.writeCreated(".mindwtr-et-s-stage", bytes: bytes, using: handle)
      counts.set("armed", 1)
      await refuses { try await writer.deleteOwned(".mindwtr-et-s-stage", expectedBytes: bytes, using: handle) }
      XCTAssertEqual(counts.count("delete-completed"), 0); XCTAssertEqual(counts.count("scope-stop"), 1)
      if counts.count("removed") == 0 { XCTAssertEqual(try Data(contentsOf: target), bytes) }
      else if mode == "recreated" { XCTAssertEqual(try Data(contentsOf: target), peer) }
      else { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path)) }
      await refuses { try await writer.writeBytes(".mindwtr-et-s-stage", bytes: peer, using: handle) }
    }
  }

  func testCloseAndCancellationDrainEnteredRenameAndDeleteBeforeReleasingAdoptedFDs() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    for operation in ["rename", "delete"] {
      for mode in ["close", "cancel", "error"] {
        let root = try folder(parent, operation + "-" + mode), counts = Counts(), bytes = Data([1, 2, 3])
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let closeStarted = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
        if operation == "rename" { try bytes.write(to: root.appendingPathComponent("source")) }
        var io = access(counts); let rename = io.renameExclusive, unlink = io.unlink
        io.read = { fd, buffer, length in counts.set("fd", Int(fd)); return Darwin.read(fd, buffer, length) }
        let barrier = {
          counts.increment("entered"); entered.signal()
          guard release.wait(timeout: .now() + 5) == .success, mode != "error" else { errno = EIO; return false }
          return true
        }
        io.renameExclusive = { fd, source, destination in barrier() ? rename(fd, source, destination) : -1 }
        io.unlink = { fd, name in barrier() ? unlink(fd, name) : -1 }
        io.stopScope = { _ in XCTAssertEqual(Darwin.fcntl(Int32(counts.count("fd")), F_GETFD), -1); counts.increment("scope-stop") }
        let writer = owner(root, counts, access: io), handle = try await writer.open()
        if operation == "delete" {
          _ = try await writer.createExclusive(".mindwtr-et-s-stage", using: handle)
          try await writer.writeCreated(".mindwtr-et-s-stage", bytes: bytes, using: handle)
        }
        let changing = Task {
          if operation == "rename" { try await writer.renameObserved("source", to: ".mindwtr-et-q-prior", expectedBytes: bytes, using: handle) }
          else { try await writer.deleteOwned(".mindwtr-et-s-stage", expectedBytes: bytes, using: handle) }
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        var closing: Task<Void, Error>?
        if mode == "cancel" { changing.cancel() }
        else {
          closing = Task { closeStarted.signal(); defer { closed.signal() }; try await writer.close(handle) }
          XCTAssertEqual(closeStarted.wait(timeout: .now() + 5), .success)
          XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
        }
        XCTAssertEqual(counts.count("scope-stop"), 0)
        let competing = SyncFileLockEngine(); defer { competing.drain() }
        XCTAssertThrowsError(try competing.acquireDirectory(root))
        let late = Task { try await writer.createExclusive("late", using: handle) }
        release.signal()
        await refuses { try await changing.value }
        if let closing { try await closing.value }
        await refuses { _ = try await late.value }
        XCTAssertEqual(counts.count("entered"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
        XCTAssertEqual(counts.count("quarantine-completed"), 0); XCTAssertEqual(counts.count("delete-completed"), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("late").path))
        let token = try competing.acquireDirectory(root); try competing.release(token)
      }
    }
  }

  func testPublicationPrimitiveDiagnosticsHaveOnlyFixedCompletedContexts() {
    for (event, operation, message) in [
      (Owner.Diagnostic.quarantineCompleted, "quarantine", "Native iOS File Sync quarantine rename completed"),
      (Owner.Diagnostic.ownedDeleteCompleted, "ownedDelete", "Native iOS File Sync owned artifact deletion completed"),
    ] {
      XCTAssertEqual(event.eventMessage, message)
      XCTAssertEqual(event.context, ["releaseCheck": "v1.3.9/ios-file-sync-publication-primitives", "operation": operation, "outcome": "completed"])
      XCTAssertTrue(Owner.Diagnostic.accepts(event.context))
      for extra in ["path", "uri", "bookmark", "token", "fileName", "namespace", "count", "error"] {
        var changed: [String: Any] = event.context; changed[extra] = "private"
        XCTAssertFalse(Owner.Diagnostic.accepts(changed))
      }
      for (field, value) in [("releaseCheck", Owner.Diagnostic.marker), ("operation", "write"), ("outcome", "failed")] {
        var changed: [String: Any] = event.context; changed[field] = value
        XCTAssertFalse(Owner.Diagnostic.accepts(changed))
      }
    }
  }

  func testTraversalAndForeignHandlesCannotRetargetOrReleaseEitherOwner() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let a = try folder(parent, "a"), b = try folder(parent, "b")
    try Data([1]).write(to: a.appendingPathComponent("document")); try Data([2]).write(to: b.appendingPathComponent("document"))
    let ac = Counts(), bc = Counts(), ar = owner(a, ac), br = owner(b, bc)
    let ah = try await ar.open(), bh = try await br.open()
    for name in ["", ".", "..", "../b/document", "/document", "bad\0name", "folder/document"] {
      await refuses { _ = try await ar.read(name, using: ah) }
    }
    await refuses { _ = try await ar.read("document", using: bh) }
    await refuses { try await ar.cancel(bh) }
    XCTAssertEqual(ac.count("scope-stop"), 0); XCTAssertEqual(bc.count("scope-stop"), 0)
    let av = try await ar.read("document", using: ah), bv = try await br.read("document", using: bh)
    XCTAssertEqual(av, .bytes(Data([1]))); XCTAssertEqual(bv, .bytes(Data([2])))
    try await ar.close(ah); try await br.close(bh)
  }

  func testMissingFileAndSymlinkSelectionsNeverUseParentLease() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), file = parent.appendingPathComponent("file")
    try Data([1]).write(to: file)
    let link = parent.appendingPathComponent("link"); try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
    for selected in [parent.appendingPathComponent("missing"), file, link, URL(string: "https://invalid.example/")!] {
      let reader = owner(selected, Counts()); await refuses { _ = try await reader.open() }
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".mindwtr.lock").path))
  }

  func testChildSymlinkCannotReadForeignBytes() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), foreign = parent.appendingPathComponent("foreign")
    try Data([9]).write(to: foreign)
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("document"), withDestinationURL: foreign)
    let reader = owner(root, Counts()), handle = try await reader.open()
    await refuses { _ = try await reader.read("document", using: handle) }
    XCTAssertEqual(try Data(contentsOf: foreign), Data([9]))
  }

  func testReplacedSelectedDirectoryRefusesAndLeavesReplacementUntouched() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), moved = parent.appendingPathComponent("moved")
    try Data([1]).write(to: root.appendingPathComponent("document"))
    let counts = Counts(), reader = owner(root, counts), handle = try await reader.open()
    try FileManager.default.moveItem(at: root, to: moved); try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    try Data([8]).write(to: root.appendingPathComponent("document"))
    await refuses { _ = try await reader.read("document", using: handle) }
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("document")), Data([8]))
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".mindwtr.lock").path))
    XCTAssertEqual(counts.count("scope-stop"), 1)
  }

  func testShortEOFWithUnchangedFileCannotReturnEvenAValidLookingPrefix() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent); let original = Data("{}".utf8) + Data(repeating: 32, count: 80_000)
    try original.write(to: root.appendingPathComponent("document"))
    let counts = Counts(); var io = access(counts)
    io.read = { fd, buffer, _ in
      counts.increment("read")
      if counts.count("read") > 1 { return 0 }
      return Darwin.read(fd, buffer, 2)
    }
    let reader = owner(root, counts, access: io), handle = try await reader.open()
    await refuses { _ = try await reader.read("document", using: handle) }
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("document")), original)
    XCTAssertEqual(counts.count("scope-stop"), 1)
  }

  func testReadFailureAfterPrefixCannotReturnPartialData() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent); try Data(repeating: 65, count: 80_000).write(to: root.appendingPathComponent("document"))
    let counts = Counts(); var io = access(counts)
    io.read = { fd, buffer, length in
      counts.increment("read")
      if counts.count("read") > 1 { errno = EIO; return -1 }
      return Darwin.read(fd, buffer, length)
    }
    let reader = owner(root, counts, access: io), handle = try await reader.open()
    await refuses { _ = try await reader.read("document", using: handle) }
    XCTAssertEqual(counts.count("scope-stop"), 1)
  }

  func testCoordinatorMustEnterExactlyOnceAtTheIntendedURL() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent)
    let modes = [0, 1, 2, 3]
    for mode in modes {
      let counts = Counts(); var io = access(counts)
      io.coordinate = { url, body in
        if mode == 0 { return }
        if mode == 1 { body(url.deletingLastPathComponent()); return }
        body(url)
        if mode == 2 { body(url) }
        if mode == 3 { throw Owner.Failure.coordination }
      }
      let reader = owner(root, counts, access: io)
      await refuses { _ = try await reader.open() }
      XCTAssertEqual(counts.count("scope-stop"), 1); XCTAssertEqual(counts.count("admitted"), 0)
    }
  }

  func testAbsentReadStillRequiresSuccessfulCoordination() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts(); var io = access(counts)
    io.coordinate = { url, body in
      counts.increment("coordinate")
      if counts.count("coordinate") == 1 { body(url) }
    }
    let reader = owner(root, counts, access: io), handle = try await reader.open()
    await refuses { _ = try await reader.read("missing", using: handle) }
  }

  func testBookmarkReconstructionAndStaleRefusalDoNotPersistRefresh() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), bytes = Data([1, 9, 7]), counts = Counts(); var io = access(counts)
    io.resolve = { data in XCTAssertEqual(data, bytes); return (root, false) }
    let reader = Owner(selection: .bookmark(bytes), access: io, diagnostic: { _ in counts.increment("admitted") })
    let handle = try await reader.open(); try await reader.close(handle)
    XCTAssertEqual(counts.count("scope-start"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    let staleCounts = Counts(); io = access(staleCounts); io.resolve = { _ in (root, true) }
    let stale = Owner(selection: .bookmark(bytes), access: io, diagnostic: { _ in staleCounts.increment("admitted") })
    await refuses { _ = try await stale.open() }
    XCTAssertEqual(staleCounts.count("scope-start"), 0); XCTAssertEqual(staleCounts.count("admitted"), 0)
    XCTAssertEqual(bytes, Data([1, 9, 7]))
    #if os(macOS)
    let options: URL.BookmarkCreationOptions = [.withSecurityScope]
    #else
    let options: URL.BookmarkCreationOptions = []
    #endif
    let realBytes: Data
    do { realBytes = try root.bookmarkData(options: options, includingResourceValuesForKeys: nil, relativeTo: nil) }
    catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadUnknownError
      && (error.userInfo[NSDebugDescriptionErrorKey] as? String)?.contains("ScopedBookmarksAgent") == true {
      throw XCTSkip("Security-scoped bookmark creation needs a logged-in session's ScopedBookmarksAgent")
    }
    let realCounts = Counts()
    let reconstructed = Owner(selection: .bookmark(realBytes), access: access(realCounts), diagnostic: { _ in realCounts.increment("admitted") })
    let realHandle = try await reconstructed.open()
    try await reconstructed.close(realHandle)
    XCTAssertEqual(realCounts.count("admitted"), 1); XCTAssertEqual(realCounts.count("scope-stop"), 1)
    let invalid = Owner(selection: .bookmark(Data([255, 0])), diagnostic: { _ in XCTFail("Invalid bookmark admitted") })
    await refuses { _ = try await invalid.open() }
  }

  func testFalseScopeStartNeedsProvenAppLocalContainmentAndIsNotBalancedAsAcquired() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts(); var io = access(counts)
    io.startScope = { _ in counts.increment("scope-start"); return false }
    io.applicationContainer = parent
    let local = owner(root, counts, access: io), handle = try await local.open(); try await local.close(handle)
    XCTAssertEqual(counts.count("scope-stop"), 0)
    let foreign = try folder(parent, "unproven")
    io.applicationContainer = parent.appendingPathComponent("different-container")
    let refused = owner(foreign, counts, access: io)
    await refuses { _ = try await refused.open() }
    XCTAssertFalse(FileManager.default.fileExists(atPath: foreign.appendingPathComponent(".mindwtr.lock").path))
  }

  func testCancellationKeepsLeaseAndScopeUntilEnteredReadReturnsThenRejectsLateRead() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent); try Data([1]).write(to: root.appendingPathComponent("document"))
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let counts = Counts(); var io = access(counts)
    io.read = { fd, buffer, length in
      if counts.count("entered") == 0 {
        counts.increment("entered"); entered.signal()
        guard release.wait(timeout: .now() + 5) == .success else { errno = EIO; return -1 }
      }
      return Darwin.read(fd, buffer, length)
    }
    let reader = owner(root, counts, access: io), handle = try await reader.open()
    let reading = Task { try await reader.read("document", using: handle) }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
    reading.cancel()
    XCTAssertEqual(counts.count("scope-stop"), 0)
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    XCTAssertThrowsError(try competing.acquireDirectory(root))
    let late = Task { try await reader.read("document", using: handle) }
    release.signal()
    await refuses { _ = try await reading.value }
    await refuses { _ = try await late.value }
    XCTAssertEqual(counts.count("scope-stop"), 1)
    let token = try competing.acquireDirectory(root); try competing.release(token)
  }

  func testAwaitedCloseWaitsForEnteredCoordinatedReadAndRejectsNewReads() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), document = Data([1, 2, 3]), sentinel = Data([0, 255, 7])
    try document.write(to: root.appendingPathComponent("document"))
    try sentinel.write(to: root.appendingPathComponent("late"))
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    let closeStarted = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
    let lateStarted = DispatchSemaphore(value: 0), counts = Counts()
    var io = access(counts)
    let coordinate = io.coordinate
    io.coordinate = { url, body in
      try coordinate(url) { supplied in
        counts.increment("coordinator-entered")
        defer { counts.increment("coordinator-exited") }
        body(supplied)
      }
    }
    io.read = { fd, buffer, length in
      counts.increment("read")
      if counts.count("read") == 1 {
        entered.signal()
        guard release.wait(timeout: .now() + 5) == .success else { errno = EIO; return -1 }
      }
      return Darwin.read(fd, buffer, length)
    }
    let reader = owner(root, counts, access: io), handle = try await reader.open()
    let reading = Task { try await reader.read("document", using: handle) }
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(counts.count("coordinator-entered") - counts.count("coordinator-exited"), 1)
    let admittedCoordinations = counts.count("coordinator-entered")
    let closing = Task {
      closeStarted.signal()
      defer { closed.signal() }
      try await reader.close(handle)
      counts.increment("close-returned")
      XCTAssertEqual(counts.count("coordinator-entered"), counts.count("coordinator-exited"),
                     "Awaited close returned while coordinated IO was still entered")
    }
    XCTAssertEqual(closeStarted.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(closed.wait(timeout: .now() + 0.05), .timedOut)
    XCTAssertEqual(counts.count("scope-stop"), 0)
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    XCTAssertThrowsError(try competing.acquireDirectory(root))
    let late = Task {
      lateStarted.signal()
      return try await reader.read("late", using: handle)
    }
    XCTAssertEqual(lateStarted.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(counts.count("coordinator-entered"), admittedCoordinations)
    release.signal()
    do { _ = try await reading.value; XCTFail("Closing owner must not publish the entered read") }
    catch { XCTAssertEqual(error as? Owner.Failure, .closed) }
    try await closing.value
    do { _ = try await late.value; XCTFail("Closing owner must refuse the queued read") }
    catch { XCTAssertEqual(error as? Owner.Failure, .closed) }
    XCTAssertEqual(counts.count("close-returned"), 1)
    XCTAssertEqual(counts.count("coordinator-entered"), admittedCoordinations)
    XCTAssertEqual(counts.count("scope-start"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    let token = try competing.acquireDirectory(root); try competing.release(token)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("document")), document)
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("late")), sentinel)
    await refuses { _ = try await reader.read("late", using: handle) }
  }

  private let restartQuarantine = ".mindwtr-et-q-restart-observed"
  private let restartSentinel = "unrelated-sentinel.bin"

  private func restartDocument(_ id: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "tasks": [["id": id, "title": id, "status": "inbox", "createdAt": "2026-10-25T00:00:00.000Z", "updatedAt": "2026-10-25T00:00:00.000Z"]],
      "projects": [], "sections": [], "areas": [], "settings": [:],
    ], options: [.sortedKeys])
  }

  private func restartEnvironment(_ phase: String) throws -> (root: URL, artifact: URL) {
    let environment = ProcessInfo.processInfo.environment
    guard let selectedPhase = environment["NATIVE_FILE_SYNC_RESTART_PHASE"] else {
      throw XCTSkip("Requires the explicit two-process restart controller")
    }
    guard selectedPhase == phase,
          let root = environment["NATIVE_FILE_SYNC_RESTART_ROOT"], root.hasPrefix("/"),
          let artifact = environment["NATIVE_FILE_SYNC_RESTART_ARTIFACT"], artifact.hasPrefix("/"),
          !root.split(separator: "/").contains(".."), !artifact.split(separator: "/").contains("..") else { throw Owner.Failure.unavailable }
    let url = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
    guard url.resolvingSymlinksInPath() == url else { throw Owner.Failure.unavailable }
    return (url, URL(fileURLWithPath: artifact))
  }

  private func restartObservations(_ reader: Owner, _ handle: Owner.Handle, root: URL, label: String) async throws -> [String: Any] {
    let listing = try await reader.list(using: handle)
    let names = Set(listing.map(\.name)).union([
      "data.json", "mindwtr-sync.json", "data.json.enc", "mindwtr-sync.json.enc", "data.json.bak", "data.json.enc.bak",
      "data.json.bak.previous", "data.json.enc.bak.previous", "data.json.previous", "data.json.enc.previous", "data.json.tmp",
      "attachments", restartQuarantine, restartSentinel,
    ]).sorted()
    var files = [[String: Any]]()
    for name in names {
      let entry = try await reader.metadata(name, using: handle)
      var row: [String: Any] = ["name": name, "exists": entry != nil, "kind": NSNull(), "size": NSNull()]
      if let entry {
        row["kind"] = entry.kind == .file ? "file" : "directory"
        if let count = entry.byteCount { row["size"] = count }
      }
      if entry?.kind == .directory {
        row["read"] = ["state": "directory"]
      } else {
        switch try await reader.read(name, using: handle) {
        case .absent: row["read"] = ["state": "absent"]
        case .bytes(let bytes): row["read"] = ["state": "bytes", "base64": bytes.base64EncodedString()]
        }
      }
      files.append(row)
    }
    return ["name": label, "root": root.path, "listing": listing.map(\.name), "files": files]
  }

  private func restartClose(_ reader: Owner, _ handle: Owner.Handle, root: URL, counts: Counts) async throws -> [String: Any] {
    try await reader.close(handle)
    XCTAssertEqual(counts.count("scope-start"), 1); XCTAssertEqual(counts.count("scope-stop"), 1)
    let competing = SyncFileLockEngine(); defer { competing.drain() }
    let token = try competing.acquireDirectory(root); try competing.release(token)
    return ["scopeStarts": counts.count("scope-start"), "scopeStops": counts.count("scope-stop"), "leaseReleased": true]
  }

  func testOrderlyRestartPrepareArtifact() async throws {
    let context = try restartEnvironment("prepare")
    try FileManager.default.createDirectory(at: context.root, withIntermediateDirectories: false)
    var cases = [[String: Any]]()
    for label in ["missing-primary", "valid-primary"] {
      let root = try folder(context.root, label), counts = Counts()
      let writer = owner(root, counts), handle = try await writer.open()
      var operations = [String]()
      for (name, bytes) in [(restartSentinel, Data([0, 255, 7, 0, 42])), ("data.json", try restartDocument("restart-retained-row"))] {
        guard try await writer.createExclusive(name, using: handle) == .created else { throw Owner.Failure.unavailable }
        operations.append("create:" + name)
        try await writer.writeCreated(name, bytes: bytes, using: handle); operations.append("write:" + name)
      }
      let observed = try await writer.read("data.json", using: handle)
      guard case .bytes(let bytes) = observed else { throw Owner.Failure.incompleteRead }
      try await writer.renameObserved("data.json", to: restartQuarantine, expectedBytes: bytes, using: handle)
      operations.append("quarantine:data.json")
      if label == "valid-primary" {
        guard try await writer.createExclusive("data.json", using: handle) == .created else { throw Owner.Failure.unavailable }
        operations.append("create:data.json")
        try await writer.writeCreated("data.json", bytes: restartDocument("restart-primary-row"), using: handle)
        operations.append("write:data.json")
      }
      var sample = try await restartObservations(writer, handle, root: root, label: label)
      sample["operations"] = operations
      sample["close"] = try await restartClose(writer, handle, root: root, counts: counts)
      XCTAssertEqual(counts.count("quarantine-completed"), 1); XCTAssertEqual(counts.count("delete-completed"), 0)
      cases.append(sample)
    }
    let artifact: [String: Any] = ["schema": "actual-native-orderly-restart-v1", "phase": "prepare",
      "processID": ProcessInfo.processInfo.processIdentifier, "root": context.root.path, "cases": cases]
    try JSONSerialization.data(withJSONObject: artifact, options: [.sortedKeys]).write(to: context.artifact, options: [.withoutOverwriting])
  }

  func testOrderlyRestartObserveArtifact() async throws {
    let context = try restartEnvironment("observe")
    guard let previousPath = ProcessInfo.processInfo.environment["NATIVE_FILE_SYNC_RESTART_PREPARE_ARTIFACT"],
          let previous = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: previousPath))) as? [String: Any],
          previous["schema"] as? String == "actual-native-orderly-restart-v1", previous["phase"] as? String == "prepare",
          previous["root"] as? String == context.root.path,
          let previousPID = previous["processID"] as? Int, previousPID != Int(ProcessInfo.processInfo.processIdentifier) else { throw Owner.Failure.unavailable }
    var cases = [[String: Any]]()
    for label in ["missing-primary", "valid-primary"] {
      let root = context.root.appendingPathComponent(label, isDirectory: true), counts = Counts()
      let reader = owner(root, counts), handle = try await reader.open()
      var sample = try await restartObservations(reader, handle, root: root, label: label)
      sample["operations"] = [] as [String]
      sample["close"] = try await restartClose(reader, handle, root: root, counts: counts)
      XCTAssertEqual(counts.count("write-completed"), 0); XCTAssertEqual(counts.count("quarantine-completed"), 0)
      XCTAssertEqual(counts.count("delete-completed"), 0)
      cases.append(sample)
    }
    let artifact: [String: Any] = ["schema": "actual-native-orderly-restart-v1", "phase": "observe",
      "processID": ProcessInfo.processInfo.processIdentifier, "prepareProcessID": previousPID, "root": context.root.path, "cases": cases]
    try JSONSerialization.data(withJSONObject: artifact, options: [.sortedKeys]).write(to: context.artifact, options: [.withoutOverwriting])
  }

  func testSharedReadPolicyArtifactComesFromActualOwnerResults() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let document = Data(#"{"tasks":[],"projects":[],"sections":[],"areas":[],"settings":{}}"#.utf8)
    let names = ["data.json", "mindwtr-sync.json", "data.json.enc", "mindwtr-sync.json.enc", "data.json.bak", "data.json.enc.bak", "data.json.bak.previous", "data.json.enc.bak.previous", "data.json.previous", "data.json.enc.previous", "data.json.tmp"]
    var cases = [[String: Any]]()
    for label in ["primary", "absent", "retained", "short"] {
      let root = try folder(parent, label)
      if label == "primary" { try document.write(to: root.appendingPathComponent("data.json")) }
      if label == "retained" { try document.write(to: root.appendingPathComponent("data.json.bak")) }
      if label == "short" { try (document + Data(repeating: 32, count: 80_000)).write(to: root.appendingPathComponent("data.json")) }
      let counts = Counts(); var io = access(counts)
      if label == "short" {
        io.read = { fd, buffer, _ in
          counts.increment("read")
          return counts.count("read") == 1 ? Darwin.read(fd, buffer, 2) : 0
        }
      }
      let reader = owner(root, counts, access: io), handle = try await reader.open()
      let listing = try await reader.list(using: handle)
      var files = [[String: Any]]()
      for name in names {
        let entry = try await reader.metadata(name, using: handle)
        files.append(["name": name, "exists": entry != nil, "size": entry?.byteCount ?? 0])
      }
      for index in files.indices {
        let name = names[index]
        if label == "short" && name != "data.json" { continue }
        do {
          switch try await reader.read(name, using: handle) {
          case .absent: files[index]["read"] = ["state": "absent"]
          case .bytes(let bytes): files[index]["read"] = ["state": "bytes", "base64": bytes.base64EncodedString()]
          }
          XCTAssertFalse(label == "short", "Short native read returned bytes")
        } catch {
          guard label == "short", name == "data.json", (error as? Owner.Failure) == .incompleteRead else { throw error }
          files[index]["read"] = ["state": "failed"]
        }
      }
      if label != "short" { try await reader.close(handle) }
      XCTAssertEqual(counts.count("scope-stop"), 1)
      cases.append(["name": label, "listing": listing.map(\.name), "files": files])
    }
    if let destination = ProcessInfo.processInfo.environment["NATIVE_FILE_SYNC_READ_ARTIFACT"] {
      let bytes = try JSONSerialization.data(withJSONObject: ["schema": "actual-native-read-owner-v1", "cases": cases], options: [.sortedKeys])
      try bytes.write(to: URL(fileURLWithPath: destination), options: [.withoutOverwriting])
    }
  }

  func testCreatedWriteArtifactComesFromActualOwnerOperations() async throws {
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let payload = Data("native created bytes".utf8), prior = Data([9, 8, 7])
    var cases = [[String: Any]]()
    for mode in ["createOnly", "writeBytes", "exists", "partial"] {
      let root = try folder(parent, mode), name = "artifact-" + mode, counts = Counts()
      if mode == "exists" { try prior.write(to: root.appendingPathComponent(name)) }
      var io = access(counts)
      if mode == "partial" {
        io.write = { fd, buffer, _ in
          counts.increment("write")
          if counts.count("write") == 1 { return Darwin.write(fd, buffer, 3) }
          errno = EIO; return -1
        }
      }
      let writer = owner(root, counts, access: io), handle = try await writer.open()
      let result = try await writer.createExclusive(name, using: handle)
      var calls = [[String: Any]]()
      var sample: [String: Any] = ["mode": mode, "name": name, "payloadBase64": payload.base64EncodedString()]
      if mode == "writeBytes" {
        guard result == .created else { throw Owner.Failure.unavailable }
        sample["setupCreate"] = "created"
        let before = try await writer.read(name, using: handle)
        guard case .bytes(let bytes) = before else { throw Owner.Failure.incompleteRead }
        XCTAssertEqual(bytes, Data())
        calls.append(["op": "readBytes", "name": name, "result": "bytes", "base64": bytes.base64EncodedString()])
      } else {
        XCTAssertEqual(result, mode == "exists" ? .exists : .created)
        calls.append(["op": "createExclusive", "name": name, "result": result == .created ? "created" : "exists"])
      }
      if mode != "exists" {
        let op = mode == "writeBytes" ? "writeBytes" : "writeCreated"
        do {
          if mode == "writeBytes" { try await writer.writeBytes(name, bytes: payload, using: handle) }
          else { try await writer.writeCreated(name, bytes: payload, using: handle) }
          guard mode != "partial" else { throw Owner.Failure.unavailable }
          calls.append(["op": op, "name": name, "result": "completed", "base64": payload.base64EncodedString()])
        } catch {
          guard mode == "partial", (error as? Owner.Failure) == .incompleteWrite else { throw error }
          calls.append(["op": op, "name": name, "result": "failed", "base64": payload.base64EncodedString()])
        }
      }
      if mode != "partial" {
        let read = try await writer.read(name, using: handle)
        guard case .bytes(let bytes) = read else { throw Owner.Failure.incompleteRead }
        XCTAssertEqual(bytes, mode == "exists" ? prior : payload)
        calls.append(["op": "readBytes", "name": name, "result": "bytes", "base64": bytes.base64EncodedString()])
        try await writer.close(handle)
      }
      let after = try Data(contentsOf: root.appendingPathComponent(name))
      XCTAssertEqual(after, mode == "exists" ? prior : mode == "partial" ? Data(payload.prefix(3)) : payload)
      XCTAssertEqual(counts.count("write-completed"), mode == "exists" || mode == "partial" ? 0 : 1)
      XCTAssertEqual(counts.count("scope-stop"), 1)
      sample["calls"] = calls; sample["afterBase64"] = after.base64EncodedString()
      sample["createdWriteEvents"] = counts.count("write-completed"); sample["scopeStops"] = counts.count("scope-stop")
      cases.append(sample)
    }
    if let destination = ProcessInfo.processInfo.environment["NATIVE_FILE_SYNC_CREATED_WRITE_ARTIFACT"] {
      let bytes = try JSONSerialization.data(withJSONObject: ["schema": "actual-native-created-write-v1", "cases": cases], options: [.sortedKeys])
      try bytes.write(to: URL(fileURLWithPath: destination), options: [.withoutOverwriting])
    }
  }

  func testCreatedWriteDiagnosticHasOnlyTheFixedCompletedContext() {
    let event = Owner.Diagnostic.createdWriteCompleted
    XCTAssertEqual(event.eventMessage, "Native iOS File Sync created-file write completed")
    XCTAssertEqual(event.context, ["releaseCheck": "v1.3.9/ios-file-sync-created-write", "operation": "createdWrite", "outcome": "completed"])
    XCTAssertTrue(Owner.Diagnostic.accepts(event.context))
    for extra in ["path", "uri", "bookmark", "token", "fileName", "namespace", "count"] {
      var changed: [String: Any] = event.context; changed[extra] = "private"
      XCTAssertFalse(Owner.Diagnostic.accepts(changed))
    }
    for (field, value) in [("releaseCheck", Owner.Diagnostic.marker), ("operation", "write"), ("outcome", "failed")] {
      var changed: [String: Any] = event.context; changed[field] = value
      XCTAssertFalse(Owner.Diagnostic.accepts(changed))
    }
  }

  func testAdmissionDiagnosticHasOnlyTheFixedPrivateSafeContext() async throws {
    XCTAssertTrue(Owner.Diagnostic.accepts(Owner.Diagnostic.admitted.context))
    for extra in ["path", "uri", "bookmark", "token", "fileName", "namespace", "count"] {
      var changed: [String: Any] = Owner.Diagnostic.admitted.context; changed[extra] = "private"
      XCTAssertFalse(Owner.Diagnostic.accepts(changed))
    }
    for (field, value) in [("releaseCheck", "v1.3.7/other"), ("operation", "write"), ("outcome", "refused")] {
      var changed: [String: Any] = Owner.Diagnostic.admitted.context; changed[field] = value
      XCTAssertFalse(Owner.Diagnostic.accepts(changed))
    }
    let parent = try fixture(); defer { try? FileManager.default.removeItem(at: parent) }
    let root = try folder(parent), counts = Counts(), reader = owner(root, counts)
    let handle = try await reader.open()
    _ = try await reader.list(using: handle)
    XCTAssertEqual(counts.count("admitted"), 1)
    try await reader.close(handle)
  }
}
