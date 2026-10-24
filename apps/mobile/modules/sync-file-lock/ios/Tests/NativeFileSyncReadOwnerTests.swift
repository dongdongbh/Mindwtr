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
    Owner(selection: .pickedDirectory(root), access: supplied ?? access(counts), diagnostic: { _ in counts.increment("admitted") })
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
      // The missing-file operation never enters its root coordinator.
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
    let realBytes = try root.bookmarkData(options: options, includingResourceValuesForKeys: nil, relativeTo: nil)
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

  /// Optional artifact is produced by actual owner IO, never a replacement fixture transcript.
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
      // Capture actual stat/absence before the deliberately failed read closes its owner.
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
