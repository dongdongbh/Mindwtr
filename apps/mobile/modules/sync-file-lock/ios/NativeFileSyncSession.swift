import Foundation

public actor NativeFileSyncSession {
  public static let maximumBytes = 8 * 1024 * 1024
  public enum Selection: Sendable { case pickedDirectory(URL), bookmark(Data) }
  public enum Read: Equatable, Sendable { case absent, bytes(Data) }
  public enum CreateResult: Equatable, Sendable { case created, exists }
  public struct Entry: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case file, directory }
    public let name: String
    public let kind: Kind
    public let byteCount: Int64?
  }
  public enum Failure: Error { case unavailable }
  private let owner: NativeFileSyncReadOwner
  private var handle: NativeFileSyncReadOwner.Handle?
  private var opening = false
  private var closing: Task<Void, Error>?

  public init(selection: Selection, diagnostic: @escaping @Sendable (String, [String: String]) -> Void = { _, _ in }) {
    let selected: NativeFileSyncReadOwner.Selection
    switch selection {
    case .pickedDirectory(let url): selected = .pickedDirectory(url)
    case .bookmark(let bytes): selected = .bookmark(bytes)
    }
    owner = NativeFileSyncReadOwner(selection: selected, maximumReadBytes: Self.maximumBytes) {
      diagnostic($0.eventMessage, $0.context)
    }
  }

  init(owner: NativeFileSyncReadOwner) { self.owner = owner }

  public func open() async throws { _ = try await openDirectory() }

  public func openDirectory() async throws -> URL {
    guard handle == nil, !opening, closing == nil else { throw Failure.unavailable }
    opening = true
    defer { opening = false }
    do {
      let opened = try await owner.open()
      let directory = try await owner.canonicalDirectory(opened)
      guard closing == nil else { throw Failure.unavailable }
      handle = opened
      return directory
    } catch {
      try await close()
      throw error
    }
  }

  private func perform<T: Sendable>(_ work: (NativeFileSyncReadOwner, NativeFileSyncReadOwner.Handle) async throws -> T) async throws -> T {
    guard closing == nil, let handle else { throw Failure.unavailable }
    do { return try await work(owner, handle) }
    catch { try await close(); throw error }
  }
  private func entry(_ value: NativeFileSyncReadOwner.Entry) -> Entry {
    Entry(name: value.name, kind: value.kind == .file ? .file : .directory, byteCount: value.byteCount)
  }
  public func revalidate() async throws { try await perform { try await $0.revalidate($1) } }
  public func read(_ name: String) async throws -> Read {
    try await perform { owner, handle in
      switch try await owner.read(name, using: handle) {
      case .absent: return .absent
      case .bytes(let bytes): return .bytes(bytes)
      }
    }
  }
  public func metadata(_ name: String) async throws -> Entry? {
    let value = try await perform { try await $0.metadata(name, using: $1) }
    return value.map(entry)
  }
  public func list() async throws -> [Entry] {
    let value = try await perform { try await $0.list(using: $1) }
    return value.map(entry)
  }
  public func createExclusive(_ name: String) async throws -> CreateResult {
    try await perform { try await $0.createExclusive(name, using: $1) == .created ? .created : .exists }
  }
  public func writeCreated(_ name: String, bytes: Data) async throws {
    try await perform { owner, handle in
      guard bytes.count <= Self.maximumBytes else { throw Failure.unavailable }
      try await owner.writeCreated(name, bytes: bytes, using: handle)
    }
  }
  public func renameObserved(_ source: String, to destination: String, expectedBytes: Data) async throws {
    try await perform { owner, handle in
      guard expectedBytes.count <= Self.maximumBytes else { throw Failure.unavailable }
      try await owner.renameObserved(source, to: destination, expectedBytes: expectedBytes, using: handle)
    }
  }
  public func deleteOwned(_ name: String, expectedBytes: Data) async throws {
    try await perform { owner, handle in
      guard expectedBytes.count <= Self.maximumBytes else { throw Failure.unavailable }
      try await owner.deleteOwned(name, expectedBytes: expectedBytes, using: handle)
    }
  }
  public func close() async throws {
    if closing == nil {
      let owner = owner
      closing = Task { try await owner.finishClosing() }
    }
    try await closing!.value
  }
}
