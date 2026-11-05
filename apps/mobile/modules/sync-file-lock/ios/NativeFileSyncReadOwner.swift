import Darwin
import Foundation

final class NativeFileSyncReadOwner: @unchecked Sendable {
  enum Failure: Error, Equatable { case unavailable, staleBookmark, scopeUnproven, invalidName, invalidHandle, closed, incompleteRead, incompleteWrite, coordination }
  enum CreateResult: Equatable, Sendable { case created, exists }
  enum Selection { case pickedDirectory(URL), bookmark(Data) }
  struct Handle: Hashable, Sendable { fileprivate let identity: UUID }
  struct Entry: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case file, directory }
    let name: String
    let kind: Kind
    let byteCount: Int64?
  }
  enum Read: Equatable, Sendable { case absent, bytes(Data) }
  enum Diagnostic: Equatable {
    case admitted, createdWriteCompleted, quarantineCompleted, ownedDeleteCompleted
    static let message = "Native iOS File Sync read owner admitted"
    static let marker = "v1.3.9/ios-file-sync-read-owner"
    static let createdWriteMessage = "Native iOS File Sync created-file write completed"
    static let createdWriteMarker = "v1.3.9/ios-file-sync-created-write"
    static let publicationMarker = "v1.3.9/ios-file-sync-publication-primitives"
    var eventMessage: String {
      switch self {
      case .admitted: return Self.message
      case .createdWriteCompleted: return Self.createdWriteMessage
      case .quarantineCompleted: return "Native iOS File Sync quarantine rename completed"
      case .ownedDeleteCompleted: return "Native iOS File Sync owned artifact deletion completed"
      }
    }
    var context: [String: String] {
      switch self {
      case .admitted: return ["releaseCheck": Self.marker, "operation": "admission", "outcome": "confirmed"]
      case .createdWriteCompleted: return ["releaseCheck": Self.createdWriteMarker, "operation": "createdWrite", "outcome": "completed"]
      case .quarantineCompleted: return ["releaseCheck": Self.publicationMarker, "operation": "quarantine", "outcome": "completed"]
      case .ownedDeleteCompleted: return ["releaseCheck": Self.publicationMarker, "operation": "ownedDelete", "outcome": "completed"]
      }
    }
    static func accepts(_ value: [String: Any]) -> Bool {
      guard Set(value.keys) == Set(["releaseCheck", "operation", "outcome"]) else { return false }
      return [Diagnostic.admitted, .createdWriteCompleted, .quarantineCompleted, .ownedDeleteCompleted].contains { event in
        event.context.allSatisfy { value[$0.key] as? String == $0.value }
      }
    }
  }

  struct Access {
    var startScope: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() }
    var stopScope: (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }
    var resolve: (Data) throws -> (url: URL, stale: Bool) = { bytes in
      var stale = false
      #if os(macOS)
      let options: URL.BookmarkResolutionOptions = [.withSecurityScope]
      #else
      let options: URL.BookmarkResolutionOptions = []
      #endif
      let url = try URL(resolvingBookmarkData: bytes, options: options, relativeTo: nil, bookmarkDataIsStale: &stale)
      return (url, stale)
    }
    var coordinate: (URL, (URL) -> Void) throws -> Void = { url, body in
      var error: NSError?
      NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &error, byAccessor: body)
      if let error { throw error }
    }
    var coordinateWrite: (URL, (URL) -> Void) throws -> Void = { url, body in
      var error: NSError?
      NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: [], error: &error, byAccessor: body)
      if let error { throw error }
    }
    var read: (Int32, UnsafeMutableRawPointer, Int) -> Int = { Darwin.read($0, $1, $2) }
    var write: (Int32, UnsafeRawPointer, Int) -> Int = { Darwin.write($0, $1, $2) }
    var syncFile: (Int32) throws -> Void = { fd in
      guard Darwin.fsync(fd) == 0, Darwin.fcntl(fd, F_FULLFSYNC) == 0 else { throw Failure.incompleteWrite }
    }
    var syncDirectory: (Int32) throws -> Void = { fd in
      guard Darwin.fsync(fd) == 0 else { throw Failure.incompleteWrite }
    }
    var renameExclusive: (Int32, String, String) -> Int32 = { directory, source, destination in
      source.withCString { sourceName in
        destination.withCString { destinationName in
          Darwin.renameatx_np(directory, sourceName, directory, destinationName, UInt32(RENAME_EXCL))
        }
      }
    }
    var unlink: (Int32, String) -> Int32 = { directory, name in
      name.withCString { Darwin.unlinkat(directory, $0, 0) }
    }
    var applicationContainer = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
  }

  private struct Node: Equatable {
    let device: UInt64, inode: UInt64, links: UInt64
    let mode: mode_t
    let size: Int64, modifiedSeconds: Int64, modifiedNanos: Int64, changedSeconds: Int64, changedNanos: Int64
    init(_ value: Darwin.stat) throws {
      guard value.st_size >= 0 else { throw Failure.unavailable }
      device = UInt64(value.st_dev); inode = UInt64(value.st_ino); links = UInt64(value.st_nlink); mode = value.st_mode
      size = Int64(value.st_size)
      modifiedSeconds = Int64(value.st_mtimespec.tv_sec); modifiedNanos = Int64(value.st_mtimespec.tv_nsec)
      changedSeconds = Int64(value.st_ctimespec.tv_sec); changedNanos = Int64(value.st_ctimespec.tv_nsec)
    }
    var kind: mode_t { mode & S_IFMT }
    func sameIdentity(_ other: Node) -> Bool { device == other.device && inode == other.inode && kind == other.kind }
  }

  private enum OwnedState: Equatable { case unfinishedCreation, completedCreation, pendingQuarantine, quarantine }
  private struct CreatedFile {
    let fd: Int32
    let before: Node
    var state: OwnedState = .unfinishedCreation
    var verified: Node? = nil
  }

  private let selection: Selection
  private let access: Access
  private let maximumReadBytes: Int?
  private let diagnostic: (Diagnostic) -> Void
  private let engine = SyncFileLockEngine()
  private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.file-sync-read")
  private let queueMarker = DispatchSpecificKey<Bool>()
  private let lifecycle = NSLock()
  private var state = 0
  private let handle = Handle(identity: UUID())
  private var root: URL?
  private var rootFD: Int32 = -1
  private var token: String?
  private var scoped = false
  private var cleanupError: Error?
  private var created: [Data: CreatedFile] = [:]

  init(selection: Selection, access: Access = Access(), maximumReadBytes: Int? = nil, diagnostic: @escaping (Diagnostic) -> Void) {
    self.selection = selection; self.access = access; self.maximumReadBytes = maximumReadBytes; self.diagnostic = diagnostic
    queue.setSpecific(key: queueMarker, value: true)
  }

  deinit {
    if DispatchQueue.getSpecific(key: queueMarker) == true { shutdown() }
    else { queue.sync { shutdown() } }
  }

  func open() async throws -> Handle {
    try await submit(nil) {
      guard self.root == nil else { throw Failure.invalidHandle }
      let selected: URL
      switch self.selection {
      case .pickedDirectory(let url): selected = url
      case .bookmark(let bytes):
        guard !bytes.isEmpty else { throw Failure.unavailable }
        let resolved = try self.access.resolve(bytes)
        guard !resolved.stale else { throw Failure.staleBookmark }
        selected = resolved.url
      }
      guard selected.isFileURL, !selected.path.utf8.contains(0), !selected.pathComponents.contains("..") else { throw Failure.unavailable }
      let root = selected.standardizedFileURL
      guard root.resolvingSymlinksInPath().standardizedFileURL == root else { throw Failure.unavailable }
      self.root = root
      self.scoped = self.access.startScope(root)
      if !self.scoped {
        let container = self.access.applicationContainer.standardizedFileURL
        let prefix = container.path.hasSuffix("/") ? container.path : container.path + "/"
        guard root.path.hasPrefix(prefix), root.resolvingSymlinksInPath().standardizedFileURL == root else { throw Failure.scopeUnproven }
      }
      self.token = try self.engine.acquireDirectory(root)
      self.rootFD = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard self.rootFD >= 0 else { throw Failure.unavailable }
      try self.validateRoot()
      try self.coordinated(root) { try self.validateRoot() }
      try self.requireAccepting()
      self.diagnostic(.admitted)
      return self.handle
    }
  }

  func read(_ name: String, using handle: Handle) async throws -> Read {
    try Self.validName(name)
    return try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      let before = try self.coordinated(root) { try self.confirmedNode(name) }
      guard let before else { return .absent }
      guard before.kind == S_IFREG else { throw Failure.unavailable }
      return try self.coordinated(root.appendingPathComponent(name)) {
        try self.validateRoot()
        let fd = name.withCString { openat(self.rootFD, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
        guard fd >= 0 else { throw Failure.unavailable }
        defer { _ = Darwin.close(fd) }
        return .bytes(try self.readComplete(name, fd: fd, before: before))
      }
    }
  }

  func createExclusive(_ name: String, using handle: Handle) async throws -> CreateResult {
    try Self.validWriteName(name)
    return try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      return try self.coordinated(root, writing: true) {
        let fd = name.withCString { openat(self.rootFD, $0, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600)) }
        if fd < 0 {
          if errno == EEXIST { return .exists }
          throw Failure.unavailable
        }
        var retained = false
        defer { if !retained { _ = Darwin.close(fd) } }
        let key = Data(name.utf8), before = try self.node(fd)
        guard self.created[key] == nil else { throw Failure.unavailable }
        self.created[key] = CreatedFile(fd: fd, before: before)
        retained = true
        guard before.kind == S_IFREG, before.size == 0, before.links == 1,
              try self.lookup(name) == before else { throw Failure.unavailable }
        try self.access.syncDirectory(self.rootFD)
        guard try self.node(fd) == before, try self.lookup(name) == before else { throw Failure.unavailable }
        return .created
      }
    }
  }

  func writeCreated(_ name: String, bytes: Data, using handle: Handle) async throws {
    try await writeBytes(name, bytes: bytes, using: handle)
  }

  func writeBytes(_ name: String, bytes: Data, using handle: Handle) async throws {
    try Self.validWriteName(name)
    try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      let key = Data(name.utf8)
      let written = try self.coordinated(root.appendingPathComponent(name), writing: true) {
        guard let file = self.created[key], file.state == .unfinishedCreation else { throw Failure.unavailable }
        guard file.before.kind == S_IFREG, file.before.size == 0, file.before.links == 1,
              try self.node(file.fd) == file.before, try self.lookup(name) == file.before else { throw Failure.unavailable }
        try bytes.withUnsafeBytes { buffer in
          var offset = 0
          while offset < buffer.count {
            let count = self.access.write(file.fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 && count <= buffer.count - offset else { throw Failure.incompleteWrite }
            offset += count
          }
        }
        try self.access.syncFile(file.fd)
        try self.access.syncDirectory(self.rootFD)
        let written = try self.node(file.fd)
        guard written.sameIdentity(file.before), written.links == 1, written.size == Int64(bytes.count),
              Darwin.lseek(file.fd, 0, SEEK_SET) == 0,
              try self.readComplete(name, fd: file.fd, before: written) == bytes else { throw Failure.incompleteWrite }
        return written
      }
      try self.requireAccepting()
      self.created[key]?.verified = written
      self.created[key]?.state = .completedCreation
      self.diagnostic(.createdWriteCompleted)
    }
  }

  func renameObserved(_ source: String, to destination: String, expectedBytes: Data, using handle: Handle) async throws {
    try Self.validWriteName(source)
    try Self.validWriteName(destination)
    let sourceKey = Data(source.utf8), destinationKey = Data(destination.utf8)
    guard sourceKey != destinationKey, Self.hasScratchPrefix(destination, ".mindwtr-et-q-") else { throw Failure.invalidName }
    try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      let moved = try self.coordinated(root, writing: true) {
        guard self.created[destinationKey] == nil,
              try self.names().contains(where: { $0.utf8.elementsEqual(source.utf8) }),
              let before = try self.lookup(source), before.kind == S_IFREG, before.links == 1 else { throw Failure.unavailable }
        let owned = self.created[sourceKey]
        let fd: Int32
        if let owned {
          guard owned.state == .completedCreation || owned.state == .quarantine,
                owned.verified == before else { throw Failure.unavailable }
          fd = owned.fd
        } else {
          fd = source.withCString { openat(self.rootFD, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
          guard fd >= 0 else { throw Failure.unavailable }
        }
        var retained = owned != nil
        defer { if !retained { _ = Darwin.close(fd) } }
        try self.verifyExpectedBytes(source, fd: fd, before: before, expected: expectedBytes)
        guard try self.node(fd) == before, try self.lookup(source) == before,
              try self.names().contains(where: { $0.utf8.elementsEqual(source.utf8) }) else { throw Failure.unavailable }
        try self.validateRoot()
        guard self.access.renameExclusive(self.rootFD, source, destination) == 0 else { throw Failure.unavailable }
        self.created.removeValue(forKey: sourceKey)
        self.created[destinationKey] = CreatedFile(fd: fd, before: before, state: .pendingQuarantine)
        retained = true
        try self.access.syncDirectory(self.rootFD)
        let after = try self.node(fd)
        guard after.sameIdentity(before), after.mode == before.mode, after.links == 1, after.size == before.size,
              after.modifiedSeconds == before.modifiedSeconds, after.modifiedNanos == before.modifiedNanos,
              try self.confirmedNode(source) == nil else { throw Failure.unavailable }
        try self.verifyExpectedBytes(destination, fd: fd, before: after, expected: expectedBytes)
        return after
      }
      try self.requireAccepting()
      self.created[destinationKey]?.verified = moved
      self.created[destinationKey]?.state = .quarantine
      self.diagnostic(.quarantineCompleted)
    }
  }

  func deleteOwned(_ name: String, expectedBytes: Data, using handle: Handle) async throws {
    try Self.validWriteName(name)
    let key = Data(name.utf8)
    try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      let fd = try self.coordinated(root, writing: true) {
        guard let file = self.created[key],
              (file.state == .completedCreation && Self.hasScratchPrefix(name, ".mindwtr-et-s-")) ||
              (file.state == .quarantine && Self.hasScratchPrefix(name, ".mindwtr-et-q-")),
              let before = file.verified, before.kind == S_IFREG, before.links == 1 else { throw Failure.unavailable }
        try self.verifyExpectedBytes(name, fd: file.fd, before: before, expected: expectedBytes)
        guard try self.node(file.fd) == before, try self.lookup(name) == before else { throw Failure.unavailable }
        try self.validateRoot()
        guard self.access.unlink(self.rootFD, name) == 0 else { throw Failure.unavailable }
        try self.access.syncDirectory(self.rootFD)
        let after = try self.node(file.fd)
        guard after.sameIdentity(before), after.links == 0, after.size == before.size,
              try self.confirmedNode(name) == nil else { throw Failure.unavailable }
        return file.fd
      }
      try self.requireAccepting()
      self.created.removeValue(forKey: key)
      guard Darwin.close(fd) == 0 else { throw Failure.unavailable }
      self.diagnostic(.ownedDeleteCompleted)
    }
  }

  func metadata(_ name: String, using handle: Handle) async throws -> Entry? {
    try Self.validName(name)
    return try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      return try self.coordinated(root) {
        guard let value = try self.confirmedNode(name) else { return nil }
        return try self.entry(name, value)
      }
    }
  }

  func list(using handle: Handle) async throws -> [Entry] {
    try await submit(handle) {
      guard let root = self.root else { throw Failure.closed }
      return try self.coordinated(root) {
        try self.names().map { name in
          guard let value = try self.lookup(name) else { throw Failure.unavailable }
          return try self.entry(name, value)
        }
      }
    }
  }

  func close(_ handle: Handle) async throws {
    guard handle == self.handle else { throw Failure.invalidHandle }
    guard !isClosed() else { throw Failure.closed }
    requestClose()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.shutdown()
        if let error = self.cleanupError { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  func cancel(_ handle: Handle) async throws { try await close(handle) }

  func canonicalDirectory(_ handle: Handle) async throws -> URL {
    try await submit(handle) {
      try self.validateRoot()
      guard let root = self.root else { throw Failure.closed }
      return root
    }
  }

  func revalidate(_ handle: Handle) async throws {
    try await submit(handle) { try self.validateRoot() }
  }

  func finishClosing() async throws {
    requestClose()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.shutdown()
        if let error = self.cleanupError { continuation.resume(throwing: error) }
        else { continuation.resume() }
      }
    }
  }

  private func submit<T>(_ supplied: Handle?, _ work: @escaping () throws -> T) async throws -> T {
    if let supplied, supplied != handle { throw Failure.invalidHandle }
    try Task.checkCancellation()
    return try await withTaskCancellationHandler(operation: {
      try await withCheckedThrowingContinuation { continuation in
        queue.async {
          do {
            try self.requireAccepting()
            let value = try work()
            try self.requireAccepting()
            continuation.resume(returning: value)
          } catch {
            self.shutdown()
            continuation.resume(throwing: error)
          }
        }
      }
    }, onCancel: { self.requestClose() })
  }

  private func isClosed() -> Bool {
    lifecycle.lock(); defer { lifecycle.unlock() }; return state == 2
  }

  private func requireAccepting() throws {
    lifecycle.lock(); let accepting = state == 0; lifecycle.unlock()
    guard accepting else { throw Failure.closed }
  }

  private func requestClose() {
    lifecycle.lock(); let start = state == 0; if start { state = 1 }; lifecycle.unlock()
    if start { queue.async { self.shutdown() } }
  }

  private func shutdown() {
    lifecycle.lock()
    guard state != 2 else { lifecycle.unlock(); return }
    state = 1; lifecycle.unlock()
    for file in created.values { _ = Darwin.close(file.fd) }
    created.removeAll()
    if let token {
      do { try engine.release(token) } catch { cleanupError = error }
      self.token = nil
    }
    engine.drain()
    if rootFD >= 0 { _ = Darwin.close(rootFD); rootFD = -1 }
    if scoped, let root { access.stopScope(root); scoped = false }
    lifecycle.lock(); state = 2; lifecycle.unlock()
  }

  private func validateRoot() throws {
    guard let root, let token, rootFD >= 0 else { throw Failure.closed }
    try engine.revalidate(token)
    var value = Darwin.stat()
    guard lstat(root.path, &value) == 0, try Node(value).sameIdentity(node(rootFD)), value.st_mode & S_IFMT == S_IFDIR else { throw Failure.unavailable }
  }

  private func node(_ fd: Int32) throws -> Node {
    var value = Darwin.stat()
    guard fstat(fd, &value) == 0 else { throw Failure.unavailable }
    return try Node(value)
  }

  private func coordinated<T>(_ url: URL, writing: Bool = false, _ body: () throws -> T) throws -> T {
    try validateRoot()
    var calls = 0
    var result: Result<T, Error>?
    do {
      let coordinate = writing ? access.coordinateWrite : access.coordinate
      try coordinate(url) { supplied in
        calls += 1
        guard calls == 1 else { return }
        result = Result {
          guard supplied.isFileURL,
                supplied.standardizedFileURL.absoluteString.utf8.elementsEqual(url.standardizedFileURL.absoluteString.utf8) else { throw Failure.coordination }
          try self.validateRoot()
          return try body()
        }
      }
    } catch { throw Failure.coordination }
    guard calls == 1, let result else { throw Failure.coordination }
    let value = try result.get()
    try validateRoot()
    return value
  }

  private static func validName(_ name: String) throws {
    guard !name.isEmpty, name != ".", name != "..", !name.utf8.contains(0), !name.contains("/") else { throw Failure.invalidName }
  }

  private static func validWriteName(_ name: String) throws {
    try validName(name)
    guard name != ".mindwtr.lock" else { throw Failure.invalidName }
  }

  private static func hasScratchPrefix(_ name: String, _ prefix: String) -> Bool {
    name.utf8.count > prefix.utf8.count && name.utf8.starts(with: prefix.utf8)
  }

  private func verifyExpectedBytes(_ name: String, fd: Int32, before: Node, expected: Data) throws {
    guard Darwin.lseek(fd, 0, SEEK_SET) == 0,
          try readComplete(name, fd: fd, before: before) == expected else { throw Failure.incompleteRead }
  }

  private func readComplete(_ name: String, fd: Int32, before: Node) throws -> Data {
    guard maximumReadBytes.map({ $0 >= 0 && before.size <= Int64($0) }) ?? true else { throw Failure.incompleteRead }
    guard try node(fd) == before else { throw Failure.incompleteRead }
    var data = Data(); var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { access.read(fd, $0.baseAddress!, $0.count) }
      if count < 0 && errno == EINTR { continue }
      guard count >= 0 && count <= buffer.count else { throw Failure.incompleteRead }
      if count == 0 { break }
      guard Int64(data.count) <= before.size - Int64(count) else { throw Failure.incompleteRead }
      guard maximumReadBytes.map({ data.count <= $0 - count }) ?? true else { throw Failure.incompleteRead }
      data.append(contentsOf: buffer.prefix(count))
    }
    guard Int64(data.count) == before.size, try node(fd) == before,
          try lookup(name) == before else { throw Failure.incompleteRead }
    try validateRoot()
    return data
  }

  private func lookup(_ name: String) throws -> Node? {
    var value = Darwin.stat()
    let rc = name.withCString { fstatat(rootFD, $0, &value, AT_SYMLINK_NOFOLLOW) }
    if rc != 0 {
      guard errno == ENOENT else { throw Failure.unavailable }
      return nil
    }
    let node = try Node(value)
    guard node.kind == S_IFREG || node.kind == S_IFDIR else { throw Failure.unavailable }
    return node
  }

  private func confirmedNode(_ name: String) throws -> Node? {
    try validateRoot()
    if let value = try lookup(name) { return value }
    let listed = try names()
    guard !listed.contains(where: { $0.utf8.elementsEqual(name.utf8) }), try lookup(name) == nil else { throw Failure.unavailable }
    try validateRoot()
    return nil
  }

  private func names() throws -> [String] {
    let fd = openat(rootFD, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw Failure.unavailable }
    guard let directory = fdopendir(fd) else { _ = Darwin.close(fd); throw Failure.unavailable }
    defer { closedir(directory) }
    let before = try node(fd)
    var names: [String] = []; var bytes = Set<Data>()
    while true {
      errno = 0
      guard let value = readdir(directory) else {
        guard errno == 0 else { throw Failure.unavailable }
        break
      }
      let count = Int(value.pointee.d_namlen)
      let raw = withUnsafeBytes(of: value.pointee.d_name) { Data($0.prefix(count)) }
      guard let name = String(data: raw, encoding: .utf8), name.utf8.elementsEqual(raw) else { throw Failure.unavailable }
      if name == "." || name == ".." { continue }
      try Self.validName(name)
      guard bytes.insert(raw).inserted else { throw Failure.unavailable }
      names.append(name)
    }
    guard try node(fd) == before else { throw Failure.unavailable }
    return names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
  }

  private func entry(_ name: String, _ value: Node) throws -> Entry {
    guard value.kind == S_IFREG || value.kind == S_IFDIR else { throw Failure.unavailable }
    return Entry(name: name, kind: value.kind == S_IFREG ? .file : .directory, byteCount: value.kind == S_IFREG ? value.size : nil)
  }
}
