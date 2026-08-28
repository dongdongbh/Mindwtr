import Darwin
import Foundation
#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif

private let lockName = ".mindwtr.lock"

struct SyncFileLockIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
}

enum SyncFileLockEngineError: Error, CustomStringConvertible {
  case busy
  case unavailable(String)

  var description: String {
    switch self {
    case .busy:
      return "SYNC_FILE_LOCK_BUSY: another File Sync operation is active"
    case .unavailable(let message):
      return "SYNC_FILE_LOCK_UNAVAILABLE: \(message)"
    }
  }
}

private func identity(fd: Int32, requireDirectory: Bool) throws -> SyncFileLockIdentity {
  var statValue = stat()
  guard fstat(fd, &statValue) == 0 else {
    throw SyncFileLockEngineError.unavailable("cannot identify retained lease authority")
  }
  let kind = statValue.st_mode & S_IFMT
  guard kind == (requireDirectory ? S_IFDIR : S_IFREG) else {
    throw SyncFileLockEngineError.unavailable("lease authority is an unexpected node")
  }
  return SyncFileLockIdentity(device: UInt64(statValue.st_dev), inode: UInt64(statValue.st_ino))
}

private func pathIdentity(_ path: String, requireDirectory: Bool) throws -> SyncFileLockIdentity {
  var statValue = stat()
  guard lstat(path, &statValue) == 0 else {
    throw SyncFileLockEngineError.unavailable("lease authority path is unavailable")
  }
  let kind = statValue.st_mode & S_IFMT
  guard kind == (requireDirectory ? S_IFDIR : S_IFREG), kind != S_IFLNK else {
    throw SyncFileLockEngineError.unavailable("lease authority is a symlink or unexpected node")
  }
  return SyncFileLockIdentity(device: UInt64(statValue.st_dev), inode: UInt64(statValue.st_ino))
}

private final class HeldSyncFileLease {
  let rootPath: String
  let rootFd: Int32
  let rootIdentity: SyncFileLockIdentity
  let lockPath: String
  let lockFd: Int32
  let lockIdentity: SyncFileLockIdentity

  init(
    rootPath: String,
    rootFd: Int32,
    rootIdentity: SyncFileLockIdentity,
    lockPath: String,
    lockFd: Int32,
    lockIdentity: SyncFileLockIdentity
  ) {
    self.rootPath = rootPath
    self.rootFd = rootFd
    self.rootIdentity = rootIdentity
    self.lockPath = lockPath
    self.lockFd = lockFd
    self.lockIdentity = lockIdentity
  }

  func revalidate() throws {
    guard try pathIdentity(rootPath, requireDirectory: true) == rootIdentity,
          try identity(fd: rootFd, requireDirectory: true) == rootIdentity else {
      throw SyncFileLockEngineError.unavailable("sync root identity changed")
    }
    guard try pathIdentity(lockPath, requireDirectory: false) == lockIdentity,
          try identity(fd: lockFd, requireDirectory: false) == lockIdentity else {
      throw SyncFileLockEngineError.unavailable("\(lockName) identity changed")
    }
  }

  func close() {
    _ = flock(lockFd, LOCK_UN)
    _ = Darwin.close(lockFd)
    _ = flock(rootFd, LOCK_UN)
    _ = Darwin.close(rootFd)
  }
}

final class SyncFileLockEngine {
  private let guardLock = NSLock()
  private var held: [String: HeldSyncFileLease] = [:]
  private var destroyed = false
  private let beforeLeaseRegistrationForTesting: () -> Void

  init(beforeLeaseRegistrationForTesting: @escaping () -> Void = {}) {
    self.beforeLeaseRegistrationForTesting = beforeLeaseRegistrationForTesting
  }

  private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
    guardLock.lock()
    defer { guardLock.unlock() }
    return try body()
  }

  private func rootDirectory(_ uriValue: String) throws -> URL {
    let selected: URL
    if let parsed = URL(string: uriValue), parsed.isFileURL {
      selected = parsed.standardizedFileURL
    } else {
      selected = URL(fileURLWithPath: uriValue).standardizedFileURL
    }
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: selected.path, isDirectory: &isDirectory),
       isDirectory.boolValue {
      return selected
    }
    return selected.deletingLastPathComponent()
  }

  func acquire(_ uriValue: String) throws -> String {
    try synchronized {
      guard !destroyed else {
        throw SyncFileLockEngineError.unavailable("lock engine was destroyed")
      }
    }
    let root = try rootDirectory(uriValue)
    let rootPath = root.path
    let expectedRoot = try pathIdentity(rootPath, requireDirectory: true)
    let rootFd = open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard rootFd >= 0 else {
      throw SyncFileLockEngineError.unavailable("cannot retain sync root authority")
    }
    do {
      guard try identity(fd: rootFd, requireDirectory: true) == expectedRoot else {
        throw SyncFileLockEngineError.unavailable("sync root changed while opening")
      }
      guard flock(rootFd, LOCK_EX | LOCK_NB) == 0 else {
        if errno == EWOULDBLOCK || errno == EAGAIN { throw SyncFileLockEngineError.busy }
        throw SyncFileLockEngineError.unavailable("cannot lock stable sync root")
      }

      let lockPath = root.appendingPathComponent(lockName).path
      var lockFd = open(lockPath, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      if lockFd < 0 {
        lockFd = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
      }
      guard lockFd >= 0 else {
        throw SyncFileLockEngineError.unavailable("cannot open \(lockName)")
      }
      do {
        let expectedLock = try identity(fd: lockFd, requireDirectory: false)
        guard try pathIdentity(lockPath, requireDirectory: false) == expectedLock else {
          throw SyncFileLockEngineError.unavailable("\(lockName) changed while opening")
        }
        guard flock(lockFd, LOCK_EX | LOCK_NB) == 0 else {
          if errno == EWOULDBLOCK || errno == EAGAIN { throw SyncFileLockEngineError.busy }
          throw SyncFileLockEngineError.unavailable("cannot lock \(lockName)")
        }
        let lease = HeldSyncFileLease(
          rootPath: rootPath,
          rootFd: rootFd,
          rootIdentity: expectedRoot,
          lockPath: lockPath,
          lockFd: lockFd,
          lockIdentity: expectedLock
        )
        try lease.revalidate()
        let token = UUID().uuidString
        beforeLeaseRegistrationForTesting()
        let registered = synchronized {
          guard !destroyed else { return false }
          held[token] = lease
          return true
        }
        guard registered else {
          throw SyncFileLockEngineError.unavailable("lock engine was destroyed")
        }
        return token
      } catch {
        _ = Darwin.close(lockFd)
        throw error
      }
    } catch {
      _ = flock(rootFd, LOCK_UN)
      _ = Darwin.close(rootFd)
      throw error
    }
  }

  func revalidate(_ token: String) throws {
    let lease = try synchronized {
      guard let lease = held[token] else {
        throw SyncFileLockEngineError.unavailable("unknown or already released lease")
      }
      return lease
    }
    try lease.revalidate()
  }

  func release(_ token: String) throws {
    let lease = try synchronized {
      guard let lease = held.removeValue(forKey: token) else {
        throw SyncFileLockEngineError.unavailable("unknown or already released lease")
      }
      return lease
    }
    let validation = Result { try lease.revalidate() }
    lease.close()
    try validation.get()
  }

  func drain() {
    let leases = synchronized {
      destroyed = true
      let values = Array(held.values)
      held.removeAll()
      return values
    }
    leases.forEach { $0.close() }
  }
}

#if canImport(ExpoModulesCore)
public final class SyncFileLockModule: Module {
  private let engine = SyncFileLockEngine()

  public func definition() -> ModuleDefinition {
    Name("SyncFileLock")
    OnDestroy { self.engine.drain() }
    AsyncFunction("acquireAsync") { (uriValue: String) throws -> String in
      do { return try self.engine.acquire(uriValue) }
      catch { throw NSError(domain: "SyncFileLock", code: 1, userInfo: [NSLocalizedDescriptionKey: String(describing: error)]) }
    }
    AsyncFunction("revalidateAsync") { (token: String) throws in
      do { try self.engine.revalidate(token) }
      catch { throw NSError(domain: "SyncFileLock", code: 1, userInfo: [NSLocalizedDescriptionKey: String(describing: error)]) }
    }
    AsyncFunction("releaseAsync") { (token: String) throws in
      do { try self.engine.release(token) }
      catch { throw NSError(domain: "SyncFileLock", code: 1, userInfo: [NSLocalizedDescriptionKey: String(describing: error)]) }
    }
  }
}
#endif
