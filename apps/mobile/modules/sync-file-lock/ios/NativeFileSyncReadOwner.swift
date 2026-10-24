import Darwin
import Foundation

/// Hidden selected-folder reader. It cannot configure sync or publish any document.
final class NativeFileSyncReadOwner: @unchecked Sendable {
  enum Failure: Error, Equatable { case unavailable, staleBookmark, scopeUnproven, invalidName, invalidHandle, closed, incompleteRead, coordination }
  enum Selection { case pickedDirectory(URL), bookmark(Data) }
  struct Handle: Hashable, Sendable { fileprivate let identity: UUID }
  struct Entry: Equatable {
    enum Kind: Equatable { case file, directory }
    let name: String
    let kind: Kind
    let byteCount: Int64?
  }
  enum Read: Equatable { case absent, bytes(Data) }
  enum Diagnostic {
    case admitted
    static let message = "Native iOS File Sync read owner admitted"
    static let marker = "v1.3.8/ios-file-sync-read-owner"
    var context: [String: String] { ["releaseCheck": Self.marker, "operation": "admission", "outcome": "confirmed"] }
    static func accepts(_ value: [String: Any]) -> Bool {
      Set(value.keys) == Set(["releaseCheck", "operation", "outcome"])
        && value["releaseCheck"] as? String == marker
        && value["operation"] as? String == "admission"
        && value["outcome"] as? String == "confirmed"
    }
  }

  /// Native-only platform boundary; tests retain actual owner/lease/FD logic.
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
    var read: (Int32, UnsafeMutableRawPointer, Int) -> Int = { Darwin.read($0, $1, $2) }
    // A false scope start is only accepted for a proven app-local directory, not an arbitrary external path.
    var applicationContainer = FileManager.default.homeDirectoryForCurrentUser
  }

  private struct Node: Equatable {
    let device: UInt64, inode: UInt64
    let mode: mode_t
    let size: Int64, modifiedSeconds: Int64, modifiedNanos: Int64, changedSeconds: Int64, changedNanos: Int64
    init(_ value: Darwin.stat) throws {
      guard value.st_size >= 0 else { throw Failure.unavailable }
      device = UInt64(value.st_dev); inode = UInt64(value.st_ino); mode = value.st_mode
      size = Int64(value.st_size)
      modifiedSeconds = Int64(value.st_mtimespec.tv_sec); modifiedNanos = Int64(value.st_mtimespec.tv_nsec)
      changedSeconds = Int64(value.st_ctimespec.tv_sec); changedNanos = Int64(value.st_ctimespec.tv_nsec)
    }
    var kind: mode_t { mode & S_IFMT }
    func sameIdentity(_ other: Node) -> Bool { device == other.device && inode == other.inode && kind == other.kind }
  }

  private let selection: Selection
  private let access: Access
  private let diagnostic: (Diagnostic) -> Void
  private let engine = SyncFileLockEngine()
  private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.file-sync-read")
  private let queueMarker = DispatchSpecificKey<Bool>()
  private let lifecycle = NSLock()
  private var state = 0 // accepting / closing / closed; protected by lifecycle
  private let handle = Handle(identity: UUID())
  // Remaining fields are accessed only on queue, including shutdown.
  private var root: URL?
  private var rootFD: Int32 = -1
  private var token: String?
  private var scoped = false
  private var cleanupError: Error?

  init(selection: Selection, access: Access = Access(), diagnostic: @escaping (Diagnostic) -> Void) {
    self.selection = selection; self.access = access; self.diagnostic = diagnostic
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
        guard try self.node(fd) == before else { throw Failure.incompleteRead }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
          let count = buffer.withUnsafeMutableBytes { self.access.read(fd, $0.baseAddress!, $0.count) }
          if count < 0 && errno == EINTR { continue }
          guard count >= 0 && count <= buffer.count else { throw Failure.incompleteRead }
          if count == 0 { break }
          guard Int64(data.count) <= before.size - Int64(count) else { throw Failure.incompleteRead }
          data.append(contentsOf: buffer.prefix(count))
        }
        guard Int64(data.count) == before.size, try self.node(fd) == before,
              try self.lookup(name) == before else { throw Failure.incompleteRead }
        try self.validateRoot()
        return .bytes(data)
      }
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

  /// Stops new admission immediately; completion waits for all entered coordinator/FD work.
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

  private func coordinated<T>(_ url: URL, _ body: () throws -> T) throws -> T {
    try validateRoot()
    var calls = 0
    var result: Result<T, Error>?
    do {
      try access.coordinate(url) { supplied in
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
    // ENOENT alone is not a successful provider read/list or affirmative absence.
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
