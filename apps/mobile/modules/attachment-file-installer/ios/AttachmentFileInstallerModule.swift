import CryptoKit
import Darwin
import Foundation
#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif

private let installerArtifactPrefix = ".mindwtr-install-"
private let installerPreservedPrefix = ".mindwtr-preserved-"
private let installerLockName = ".mindwtr-attachment-installer.lock"
private let sha256Pattern = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")


private enum InstallerNodeKind {
  case missing
  case regularFile
  case directory
  case symbolicLink
  case other
}

public enum ExpectedAttachmentGeneration {
  case absent
  case present(sha256: String)
}

public enum AttachmentInstallOutcome {
  case installed(preservedUrl: URL?)
  case conflict(preservedUrl: URL)
}

public enum ImmutableAttachmentPublishOutcome {
  case published
  case alreadyExists
}

public struct ImmutableAttachmentStageIdentity {
  public let stagedIdentity: String
  public let directoryIdentity: String
}

public struct ImmutableAttachmentPreparedStage {
  public let stagedUrl: URL
  public let stagedIdentity: String
  public let directoryIdentity: String
  public let privateDirectoryIdentity: String
}

/// A reserved inode only. The caller serializes writes; publication stays with the installer.
public final class ImmutableAttachmentStageWriter {
  private var descriptor: Int32
  private var expected: stat
  private let validate: (Int32) throws -> Void
  private let synchronizeParents: () throws -> Void
  private let releaseParents: () -> Void

  fileprivate init(descriptor: Int32, validate: @escaping (Int32) throws -> Void,
                   synchronizeParents: @escaping () throws -> Void, releaseParents: @escaping () -> Void) throws {
    self.descriptor = descriptor
    self.expected = try Self.regular(descriptor)
    self.validate = validate; self.synchronizeParents = synchronizeParents; self.releaseParents = releaseParents
  }
  deinit { close() }

  public func append(_ bytes: Data) throws {
    try check()
    try bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        try check()
        let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw installerError("Could not write reserved attachment stage") }
        offset += count
        expected = try Self.regular(descriptor)
        try validate(descriptor)
      }
    }
  }

  public func synchronize() throws {
    try check()
    guard Darwin.fsync(descriptor) == 0, Darwin.fcntl(descriptor, F_FULLFSYNC) == 0 else {
      throw installerError("Could not synchronize reserved attachment stage")
    }
    try synchronizeParents(); try check()
  }

  public func close() {
    guard descriptor >= 0 else { return }
    let selected = descriptor; descriptor = -1
    Darwin.close(selected); releaseParents()
  }

  private func check() throws {
    guard descriptor >= 0 else { throw installerError("Reserved attachment writer is closed") }
    let current = try Self.regular(descriptor)
    guard expected.st_dev == current.st_dev, expected.st_ino == current.st_ino, expected.st_size == current.st_size,
          expected.st_mode == current.st_mode, expected.st_mtimespec.tv_sec == current.st_mtimespec.tv_sec,
          expected.st_mtimespec.tv_nsec == current.st_mtimespec.tv_nsec,
          expected.st_ctimespec.tv_sec == current.st_ctimespec.tv_sec,
          expected.st_ctimespec.tv_nsec == current.st_ctimespec.tv_nsec else {
      throw installerError("Reserved attachment stage changed while writing")
    }
    try validate(descriptor)
  }

  private static func regular(_ descriptor: Int32) throws -> stat {
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1 else {
      throw installerError("Reserved attachment writer lost its regular file")
    }
    return value
  }
}

public enum ImmutableAttachmentStageCleanupOutcome {
  case removed
  case missing
  case conflict
}

public struct AttachmentFileHashSnapshot {
  public let sha256: String
  public let size: UInt64
  public let modificationTimeMs: Double
}


public final class AttachmentFileInstaller {
  private let installer: AttachmentFileInstallerEngine
  private let hasher: AttachmentFileHashingEngine

  public init(targetRoot: URL, sourceRoots: [URL]) throws {
    try Self.validateRoot(targetRoot)
    for root in sourceRoots { try Self.validateRoot(root) }
    installer = AttachmentFileInstallerEngine(targetRoot: targetRoot, sourceRoots: sourceRoots)
    hasher = AttachmentFileHashingEngine(targetRoot: targetRoot)
  }

  public func install(
    stagedInput: URL,
    targetInput: URL,
    expected: ExpectedAttachmentGeneration,
    expectedDownloadSha256: String
  ) throws -> AttachmentInstallOutcome {
    try Self.validateFileURL(stagedInput)
    try Self.validateFileURL(targetInput)
    let generation: ExpectedAttachmentGeneration
    switch expected {
    case .absent: generation = .absent
    case .present(let sha256):
      generation = .present(sha256: try parseInstallerSha256(sha256, label: "Expected attachment"))
    }
    return try installer.install(
      stagedInput: stagedInput,
      targetInput: targetInput,
      expected: generation,
      expectedDownloadSha256: try parseInstallerSha256(expectedDownloadSha256, label: "Expected download")
    )
  }

  public func hash(_ input: URL) throws -> AttachmentFileHashSnapshot {
    try Self.validateFileURL(input)
    return try hasher.hash(input)
  }

  public func install(stagedInput: URL, targetInput: URL, expected: ExpectedAttachmentGeneration,
    expectedDownloadSha256: String, directoryDescriptor: Int32, requireAuthority: () throws -> Void) throws -> AttachmentInstallOutcome {
    try Self.validateFileURL(stagedInput); try Self.validateFileURL(targetInput)
    let generation: ExpectedAttachmentGeneration
    switch expected {
    case .absent: generation = .absent
    case .present(let digest): generation = .present(sha256: try parseInstallerSha256(digest, label: "Expected attachment"))
    }
    return try installer.install(stagedInput: stagedInput, targetInput: targetInput, expected: generation,
      expectedDownloadSha256: parseInstallerSha256(expectedDownloadSha256, label: "Expected download"),
      directoryDescriptor: directoryDescriptor, requireAuthority: requireAuthority)
  }

  public func hash(_ input: URL, directoryDescriptor: Int32,
    requireAuthority: () throws -> Void) throws -> AttachmentFileHashSnapshot {
    try Self.validateFileURL(input)
    return try installer.hash(input, directoryDescriptor: directoryDescriptor, requireAuthority: requireAuthority)
  }

  /// Reserves an exclusive private stage using the existing RN installer.
  /// This facade is transport, not a durable reservation record: the caller must
  /// persist its operation/intent and every returned identity token across crashes.
  public func prepareImmutableStage(
    targetInput: URL,
    operationId: String
  ) throws -> ImmutableAttachmentPreparedStage {
    try Self.validateFileURL(targetInput)
    return try installer.prepareImmutableStage(targetInput: targetInput, operationId: operationId)
  }

  public func prepareImmutableStage(targetInput: URL, operationId: String,
    directoryDescriptor: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentPreparedStage {
    try Self.validateFileURL(targetInput)
    return try installer.prepareImmutableStage(targetInput: targetInput, operationId: operationId,
      directoryDescriptor: directoryDescriptor, requireAuthority: requireAuthority)
  }

  public func publishImmutable(stagedInput: URL, targetInput: URL, expectedStagedSha256: String,
    expectedStagedIdentity: String, expectedDirectoryIdentity: String, expectedPrivateDirectoryIdentity: String,
    directoryDescriptor: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentPublishOutcome {
    try Self.validateFileURL(stagedInput); try Self.validateFileURL(targetInput)
    return try installer.publishImmutable(stagedInput: stagedInput, targetInput: targetInput,
      expectedStagedSha256: parseInstallerSha256(expectedStagedSha256, label: "Expected staged attachment"),
      expectedStagedIdentity: expectedStagedIdentity, expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity,
      directoryDescriptor: directoryDescriptor, requireAuthority: requireAuthority)
  }

  public func retireOwnedPrivateStage(stagedInput: URL, targetInput: URL, operationId: String,
    expectedStagedIdentity: String, expectedDirectoryIdentity: String, expectedPrivateDirectoryIdentity: String,
    directoryDescriptor: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentStageCleanupOutcome {
    try Self.validateFileURL(stagedInput); try Self.validateFileURL(targetInput)
    return try installer.retireOwnedPrivateStage(stagedInput: stagedInput, targetInput: targetInput, operationId: operationId,
      expectedStagedIdentity: expectedStagedIdentity, expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity,
      directoryDescriptor: directoryDescriptor, requireAuthority: requireAuthority)
  }

  public func openPreparedStageForWriting(_ prepared: ImmutableAttachmentPreparedStage,
                                         targetInput: URL) throws -> ImmutableAttachmentStageWriter {
    try Self.validateFileURL(prepared.stagedUrl); try Self.validateFileURL(targetInput)
    return try installer.openPreparedStageForWriting(prepared, targetInput: targetInput)
  }

  /// Records the written stage's proof. Atomic replacement invalidates the
  /// prepared stage token; snapshot the actual bytes before publication.
  public func snapshotImmutableStage(
    stagedInput: URL,
    targetInput: URL,
    expectedStagedSha256: String
  ) throws -> ImmutableAttachmentStageIdentity {
    try Self.validateFileURL(stagedInput)
    try Self.validateFileURL(targetInput)
    return try installer.snapshotImmutableStage(
      stagedInput: stagedInput,
      targetInput: targetInput,
      expectedStagedSha256: try parseInstallerSha256(expectedStagedSha256, label: "Expected staged attachment")
    )
  }


  public func publishImmutable(
    stagedInput: URL,
    targetInput: URL,
    expectedStagedSha256: String,
    expectedStagedIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String
  ) throws -> ImmutableAttachmentPublishOutcome {
    try Self.validateFileURL(stagedInput)
    try Self.validateFileURL(targetInput)
    return try installer.publishImmutable(
      stagedInput: stagedInput,
      targetInput: targetInput,
      expectedStagedSha256: try parseInstallerSha256(expectedStagedSha256, label: "Expected staged attachment"),
      expectedStagedIdentity: expectedStagedIdentity,
      expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity
    )
  }


  public func cleanupImmutableStage(
    stagedInput: URL,
    targetInput: URL,
    operationId: String,
    expectedStagedSha256: String?,
    expectedStagedIdentity: String?,
    expectedDirectoryIdentity: String?,
    expectedPrivateDirectoryIdentity: String?
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    try Self.validateFileURL(stagedInput)
    try Self.validateFileURL(targetInput)
    let digest = try expectedStagedSha256.map {
      try parseInstallerSha256($0, label: "Expected staged attachment")
    }
    return try installer.cleanupImmutableStage(
      stagedInput: stagedInput,
      targetInput: targetInput,
      operationId: operationId,
      expectedStagedSha256: digest,
      expectedStagedIdentity: expectedStagedIdentity,
      expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity
    )
  }


  public func retireOwnedPrivateStage(
    stagedInput: URL,
    targetInput: URL,
    operationId: String,
    expectedStagedIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    try Self.validateFileURL(stagedInput)
    try Self.validateFileURL(targetInput)
    return try installer.retireOwnedPrivateStage(
      stagedInput: stagedInput,
      targetInput: targetInput,
      operationId: operationId,
      expectedStagedIdentity: expectedStagedIdentity,
      expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity
    )
  }

  private static func validateFileURL(_ input: URL) throws {
    guard input.isFileURL else { throw installerError("Only app-private file paths are supported") }
  }

  private static func validateRoot(_ input: URL) throws {
    try validateFileURL(input)


    var path = input.path
    while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    var value = stat()
    if Darwin.lstat(path, &value) == 0 {
      guard value.st_mode & S_IFMT == S_IFDIR else {
        throw installerError("Managed attachment root is not a regular directory")
      }
    } else if errno != ENOENT {
      throw installerError("Managed attachment root is unavailable")
    }
  }
}


final class AttachmentFileHashingEngine {
  private let targetRoot: URL

  init(targetRoot: URL) {
    self.targetRoot = Self.canonical(targetRoot)
  }

  func hash(_ input: URL) throws -> AttachmentFileHashSnapshot {
    try rejectSymlink(input)
    let target = Self.canonical(input)
    guard target.deletingLastPathComponent() == targetRoot else {
      throw installerError("Attachment hash path escapes managed attachment root")
    }
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.rejectSymlink(input)
      guard Self.canonical(input) == target else {
        throw installerError("Attachment hash path changed during validation")
      }
      let descriptor = Darwin.open(target.path, O_RDONLY | O_NOFOLLOW)
      guard descriptor >= 0 else { throw installerError("Could not open regular attachment file") }
      let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      defer { try? handle.close() }

      let before = try self.identity(descriptor: descriptor)
      var digest = SHA256()
      while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
        digest.update(data: data)
      }
      let after = try self.identity(descriptor: descriptor)
      let namedAfter = try self.identity(path: target.path)
      guard before == after, after == namedAfter else {
        throw installerError("Attachment changed while hashing")
      }
      return AttachmentFileHashSnapshot(
        sha256: digest.finalize().map { String(format: "%02x", $0) }.joined(),
        size: UInt64(after.size),
        modificationTimeMs: Double(after.modifiedSeconds) * 1_000
          + Double(after.modifiedNanoseconds) / 1_000_000
      )
    }
  }

  private struct Identity: Equatable {
    let device: UInt64
    let inode: UInt64
    let size: Int64
    let modifiedSeconds: Int64
    let modifiedNanoseconds: Int64
    let changedSeconds: Int64
    let changedNanoseconds: Int64
  }

  private func identity(descriptor: Int32) throws -> Identity {
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFREG else {
      throw installerError("Attachment path is not a regular file")
    }
    return identity(value)
  }

  private func identity(path: String) throws -> Identity {
    var value = stat()
    guard Darwin.lstat(path, &value) == 0, value.st_mode & S_IFMT == S_IFREG else {
      throw installerError("Attachment path is not a regular file")
    }
    return identity(value)
  }

  private func identity(_ value: stat) -> Identity {
    Identity(
      device: UInt64(value.st_dev),
      inode: UInt64(value.st_ino),
      size: Int64(value.st_size),
      modifiedSeconds: Int64(value.st_mtimespec.tv_sec),
      modifiedNanoseconds: Int64(value.st_mtimespec.tv_nsec),
      changedSeconds: Int64(value.st_ctimespec.tv_sec),
      changedNanoseconds: Int64(value.st_ctimespec.tv_nsec)
    )
  }

  private func rejectSymlink(_ input: URL) throws {
    var value = stat()
    if Darwin.lstat(input.path, &value) == 0, value.st_mode & S_IFMT == S_IFLNK {
      throw installerError("Attachment path is a symbolic link")
    }
  }

  private func withExclusiveLock<T>(_ lock: URL, _ action: () throws -> T) throws -> T {
    let descriptor = Darwin.open(lock.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw installerError("Could not open attachment installer lock") }
    defer { Darwin.close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else {
      throw installerError("Could not acquire attachment installer lock")
    }
    defer { _ = flock(descriptor, LOCK_UN) }
    return try action()
  }

  private static func canonical(_ url: URL) -> URL {
    url.standardizedFileURL.resolvingSymlinksInPath()
  }
}

private enum JournalRecovery {
  case proceed
  case completed(stagedUrl: URL, preservedUrl: URL?)
  case conflict(preservedUrl: URL)
}

private struct InstallArtifacts {
  let journal: URL
  let candidate: URL
  let quarantine: URL
  let preservationPrefix: String
}

private struct InstallJournal {
  let targetPath: String
  let stagedPath: String
  let candidateSha256: String
  let expectedLocalSha256: String?
  let displacedSha256: String?
  let preservationPath: String?
}

private struct RetainedInstallDirectory {
  let descriptor: Int32
  let root: URL
  let requireAuthority: () throws -> Void

  func leaf(_ input: URL) throws -> String {
    guard input.isFileURL, let components = URLComponents(url: input, resolvingAgainstBaseURL: false),
      components.host == nil || components.host == "", components.user == nil, components.password == nil,
      components.port == nil, components.query == nil, components.fragment == nil,
      input.path.utf8.count <= 16 * 1024, !input.path.utf8.contains(0),
      !input.pathComponents.contains("."), !input.pathComponents.contains(".."),
      input.deletingLastPathComponent().path.utf8.elementsEqual(root.path.utf8), !input.lastPathComponent.isEmpty else {
      throw installerError("Retained attachment path is outside the managed root")
    }
    return input.lastPathComponent
  }
}

private func installerError(_ message: String, underlying: Error? = nil) -> NSError {
  var userInfo: [String: Any] = [NSLocalizedDescriptionKey: "ATTACHMENT_FILE_INSTALLER_FAILED: \(message)"]
  if let underlying {
    userInfo[NSUnderlyingErrorKey] = underlying
  }
  return NSError(domain: "AttachmentFileInstaller", code: 1, userInfo: userInfo)
}

private func isSha256(_ value: String) -> Bool {
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return sha256Pattern.firstMatch(in: value, range: range)?.range == range
}

private func parseInstallerSha256(_ value: String, label: String) throws -> String {
  let digest = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard isSha256(digest) else { throw installerError("\(label) SHA-256 is invalid") }
  return digest
}


enum AttachmentFileInstallerFaultPoint: Equatable {
  case afterInitialJournal
  case afterExclusiveLink
  case beforeImmutablePublication
  case beforeImmutablePrivateDirectoryRetirement
  case beforeOwnedPrivateStageUnlink
  case afterOwnedPrivateStageUnlink
  case beforeOwnedPrivateNamespaceRetirement
  case afterOwnedPrivateNamespaceRetirement
  case beforeOwnedPrivateRootSync
  case afterRetainedHashRead
}

private enum PrivateStageCleanupMode { case legacy, owned }

final class AttachmentFileInstallerEngine {
  private let fileManager = FileManager.default
  private let targetRoot: URL
  private let sourceRoots: [URL]
  private let faultInjector: (AttachmentFileInstallerFaultPoint) throws -> Void

  init(
    targetRoot: URL,
    sourceRoots: [URL],
    faultInjector: @escaping (AttachmentFileInstallerFaultPoint) throws -> Void = { _ in }
  ) {
    self.targetRoot = Self.canonical(targetRoot)
    self.sourceRoots = Array(Set(sourceRoots.map { Self.canonical($0).path })).map {
      URL(fileURLWithPath: $0, isDirectory: true)
    }
    self.faultInjector = faultInjector
  }

  private func retainedTargetName(_ target: URL) throws -> String {
    let name = target.lastPathComponent
    guard target.isFileURL, target.deletingLastPathComponent().path == targetRoot.path,
      !target.pathComponents.contains("."), !target.pathComponents.contains(".."),
      !name.isEmpty, !name.hasPrefix(installerArtifactPrefix), !name.hasPrefix(installerPreservedPrefix),
      name != installerLockName else { throw installerError("Retained attachment target is invalid") }
    return name
  }

  private func retainedPrivateName(_ staged: URL) throws -> String {
    let directory = staged.deletingLastPathComponent(), name = directory.lastPathComponent
    guard staged.isFileURL, staged.lastPathComponent == "stage", directory.deletingLastPathComponent().path == targetRoot.path,
      !staged.pathComponents.contains("."), !staged.pathComponents.contains(".."),
      name.range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z", options: .regularExpression) != nil
    else { throw installerError("Retained attachment namespace is invalid") }
    return name
  }

  private func withRetainedDirectoryLock<T>(_ root: Int32, requireAuthority: () throws -> Void,
    _ action: () throws -> T) throws -> T {
    try requireAuthority()
    _ = try directoryIdentity(descriptor: root)
    let lock = Darwin.openat(root, installerLockName, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw installerError("Could not open retained attachment lock") }
    defer { Darwin.close(lock) }
    var before = stat()
    guard Darwin.fstat(lock, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1 else {
      throw installerError("Retained attachment lock is unsafe")
    }
    try requireAuthority()
    guard flock(lock, LOCK_EX) == 0 else { throw installerError("Could not acquire retained attachment lock") }
    defer { _ = flock(lock, LOCK_UN) }
    try requireAuthority()
    var named = stat()
    guard Darwin.fstatat(root, installerLockName, &named, AT_SYMLINK_NOFOLLOW) == 0,
      named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1,
      named.st_dev == before.st_dev, named.st_ino == before.st_ino else {
      throw installerError("Retained attachment lock changed")
    }
    let result = try action()
    try requireAuthority()
    return result
  }

  private func retainedFileMatches(_ descriptor: Int32, parent: Int32, name: String,
    expected: PublicationIdentity) throws -> Bool {
    var opened = stat(), named = stat()
    return try Darwin.fstat(descriptor, &opened) == 0 && opened.st_mode & S_IFMT == S_IFREG && opened.st_nlink == 1
      && publicationIdentity(descriptor: descriptor) == expected
      && Darwin.fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0 && named.st_mode & S_IFMT == S_IFREG && named.st_nlink == 1
      && UInt64(named.st_dev) == expected.device && UInt64(named.st_ino) == expected.inode && Int64(named.st_size) == expected.size
      && Int64(named.st_mtimespec.tv_sec) == expected.modifiedSeconds && Int64(named.st_mtimespec.tv_nsec) == expected.modifiedNanoseconds
      && Int64(named.st_ctimespec.tv_sec) == expected.changedSeconds && Int64(named.st_ctimespec.tv_nsec) == expected.changedNanoseconds
  }

  private func retainedDirectoryMatches(_ descriptor: Int32, parent: Int32, name: String, expected: String) throws -> Bool {
    var named = stat()
    return try directoryIdentity(descriptor: descriptor) == expected
      && Darwin.fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0 && named.st_mode & S_IFMT == S_IFDIR
      && "\(UInt64(named.st_dev)):\(UInt64(named.st_ino))" == expected
  }

  func prepareImmutableStage(targetInput: URL, operationId: String,
    directoryDescriptor root: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentPreparedStage {
    _ = try retainedTargetName(targetInput)
    guard operationId.range(of: "^[a-f0-9]{32}\\z", options: .regularExpression) != nil else {
      throw installerError("Attachment publication operation id is invalid")
    }
    let name = installerArtifactPrefix + operationId + ".candidate"
    return try withRetainedDirectoryLock(root, requireAuthority: requireAuthority) {
      try requireAuthority()
      guard Darwin.mkdirat(root, name, S_IRWXU) == 0 else { throw installerError("Could not create retained attachment namespace") }
      let directory = Darwin.openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard directory >= 0 else { throw installerError("Could not retain attachment namespace") }
      defer { Darwin.close(directory) }
      let directoryToken = try self.directoryIdentity(descriptor: directory)
      try requireAuthority()
      guard try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: directoryToken) else {
        throw installerError("Retained attachment namespace changed")
      }
      let output = Darwin.openat(directory, "stage", O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard output >= 0 else { throw installerError("Could not create retained attachment stage") }
      defer { Darwin.close(output) }
      let identity = try self.publicationIdentity(descriptor: output)
      guard try self.retainedFileMatches(output, parent: directory, name: "stage", expected: identity),
        Darwin.fsync(output) == 0, Darwin.fsync(directory) == 0, Darwin.fsync(root) == 0 else {
        throw installerError("Could not flush retained attachment stage")
      }
      try requireAuthority()
      guard try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: directoryToken) else {
        throw installerError("Retained attachment namespace changed")
      }
      return ImmutableAttachmentPreparedStage(stagedUrl: self.targetRoot.appendingPathComponent(name, isDirectory: true).appendingPathComponent("stage"),
        stagedIdentity: self.identityToken(identity), directoryIdentity: try self.directoryIdentity(descriptor: root),
        privateDirectoryIdentity: directoryToken)
    }
  }

  func publishImmutable(stagedInput: URL, targetInput: URL, expectedStagedSha256: String,
    expectedStagedIdentity: String, expectedDirectoryIdentity: String, expectedPrivateDirectoryIdentity: String,
    directoryDescriptor root: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentPublishOutcome {
    let target = try retainedTargetName(targetInput), name = try retainedPrivateName(stagedInput)
    guard isSha256(expectedStagedSha256), [expectedStagedIdentity, expectedDirectoryIdentity, expectedPrivateDirectoryIdentity].allSatisfy(Self.validIdentityToken)
    else { throw installerError("Retained attachment publication proof is invalid") }
    return try withRetainedDirectoryLock(root, requireAuthority: requireAuthority) {
      guard try self.directoryIdentity(descriptor: root) == expectedDirectoryIdentity else { throw installerError("Retained attachment root changed") }
      let directory = Darwin.openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard directory >= 0 else { throw installerError("Could not retain publication namespace") }
      defer { Darwin.close(directory) }
      let source = Darwin.openat(directory, "stage", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      guard source >= 0 else { throw installerError("Could not retain publication stage") }
      defer { Darwin.close(source) }
      let before = try self.publicationIdentity(descriptor: source)
      guard self.identityToken(before) == expectedStagedIdentity,
        try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: expectedPrivateDirectoryIdentity),
        try self.retainedFileMatches(source, parent: directory, name: "stage", expected: before) else {
        throw installerError("Retained publication generation is unsafe")
      }
      let digest = try self.sha256(descriptor: source)
      func check() throws {
        try requireAuthority()
        guard try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: expectedPrivateDirectoryIdentity),
          try self.retainedFileMatches(source, parent: directory, name: "stage", expected: before),
          self.identityToken(before) == expectedStagedIdentity, digest == expectedStagedSha256 else {
          throw installerError("Retained publication generation changed")
        }
      }
      try check()
      var existing = stat()
      if Darwin.fstatat(root, target, &existing, AT_SYMLINK_NOFOLLOW) == 0 { return .alreadyExists }
      guard errno == ENOENT else { throw installerError("Could not inspect retained target") }
      try self.faultInjector(.beforeImmutablePublication)
      try check()
      guard Darwin.fsync(source) == 0 else { throw installerError("Could not flush retained publication source") }
      let result = Darwin.renameatx_np(directory, "stage", root, target, UInt32(RENAME_EXCL))
      if result != 0 {
        if errno == EEXIST { return .alreadyExists }
        throw installerError("Could not publish retained attachment")
      }
      guard Darwin.fsync(root) == 0, Darwin.fsync(directory) == 0 else { throw installerError("Could not flush retained publication") }
      try requireAuthority()
      let published = Darwin.openat(root, target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      guard published >= 0 else { throw installerError("Could not verify retained publication") }
      defer { Darwin.close(published) }
      let publishedIdentity = try self.publicationIdentity(descriptor: published)
      guard self.identityToken(publishedIdentity) == expectedStagedIdentity,
        try self.sha256(descriptor: published) == expectedStagedSha256,
        try self.retainedFileMatches(published, parent: root, name: target, expected: publishedIdentity) else {
        throw installerError("Retained publication failed verification")
      }
      try self.faultInjector(.beforeImmutablePrivateDirectoryRetirement)
      try requireAuthority()
      guard try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: expectedPrivateDirectoryIdentity),
        Darwin.unlinkat(root, name, AT_REMOVEDIR) == 0, Darwin.fsync(root) == 0 else {
        throw installerError("Could not retire retained publication namespace")
      }
      return .published
    }
  }

  func retireOwnedPrivateStage(stagedInput: URL, targetInput: URL, operationId: String,
    expectedStagedIdentity: String, expectedDirectoryIdentity: String, expectedPrivateDirectoryIdentity: String,
    directoryDescriptor root: Int32, requireAuthority: () throws -> Void) throws -> ImmutableAttachmentStageCleanupOutcome {
    _ = try retainedTargetName(targetInput)
    let name = try retainedPrivateName(stagedInput)
    guard name == installerArtifactPrefix + operationId + ".candidate",
      [expectedStagedIdentity, expectedDirectoryIdentity, expectedPrivateDirectoryIdentity].allSatisfy(Self.validIdentityToken)
    else { throw installerError("Retained attachment retirement proof is invalid") }
    return try withRetainedDirectoryLock(root, requireAuthority: requireAuthority) {
      guard try self.directoryIdentity(descriptor: root) == expectedDirectoryIdentity else { return .conflict }
      func namespaceAbsent() throws -> Bool {
        try requireAuthority()
        var named = stat()
        return Darwin.fstatat(root, name, &named, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT
      }
      func syncRoot() throws {
        guard try namespaceAbsent() else { throw installerError("Retained namespace retirement is uncertain") }
        try self.faultInjector(.beforeOwnedPrivateRootSync)
        guard try namespaceAbsent(), Darwin.fsync(root) == 0, try namespaceAbsent() else {
          throw installerError("Could not flush retained namespace retirement")
        }
      }
      let directory = Darwin.openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      if directory < 0 {
        guard errno == ENOENT else { return .conflict }
        try syncRoot()
        return .missing
      }
      defer { Darwin.close(directory) }
      func check() throws -> Bool {
        try requireAuthority()
        return try self.retainedDirectoryMatches(directory, parent: root, name: name, expected: expectedPrivateDirectoryIdentity)
      }
      guard try check() else { return .conflict }
      let source = Darwin.openat(directory, "stage", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      let missingStage = source < 0
      if source >= 0 {
        defer { Darwin.close(source) }
        let identity = try self.publicationIdentity(descriptor: source)
        guard self.identityToken(identity) == expectedStagedIdentity,
          try self.retainedFileMatches(source, parent: directory, name: "stage", expected: identity), try check() else { return .conflict }
        try self.faultInjector(.beforeOwnedPrivateStageUnlink)
        guard try check(), try self.retainedFileMatches(source, parent: directory, name: "stage", expected: identity),
          Darwin.unlinkat(directory, "stage", 0) == 0 else { throw installerError("Could not retire retained stage") }
        try self.faultInjector(.afterOwnedPrivateStageUnlink)
        guard try check(), Darwin.fsync(directory) == 0 else { throw installerError("Could not flush retained stage retirement") }
      } else if errno != ENOENT { return .conflict }
      try self.faultInjector(.beforeOwnedPrivateNamespaceRetirement)
      guard try check(), Darwin.unlinkat(root, name, AT_REMOVEDIR) == 0 else {
        throw installerError("Could not retire retained stage namespace")
      }
      try self.faultInjector(.afterOwnedPrivateNamespaceRetirement)
      try syncRoot()
      return missingStage ? .missing : .removed
    }
  }

  func openPreparedStageForWriting(_ prepared: ImmutableAttachmentPreparedStage,
                                   targetInput: URL) throws -> ImmutableAttachmentStageWriter {
    try validateImmutableRecoveryPaths(stagedInput: prepared.stagedUrl, targetInput: targetInput, createRoot: false)
    let staged = Self.canonical(prepared.stagedUrl), privateDirectory = staged.deletingLastPathComponent()
    guard staged.lastPathComponent == "stage", privateDirectory.deletingLastPathComponent() == targetRoot,
          privateDirectory.lastPathComponent.range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z", options: .regularExpression) != nil else {
      throw installerError("Reserved writer requires its private attachment stage")
    }
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      let root = Darwin.open(self.targetRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard root >= 0 else { throw installerError("Could not retain reserved writer root") }
      let parent = Darwin.openat(root, privateDirectory.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard parent >= 0 else { Darwin.close(root); throw installerError("Could not retain reserved writer namespace") }
      let output = Darwin.openat(parent, "stage", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      guard output >= 0 else { Darwin.close(parent); Darwin.close(root); throw installerError("Could not retain reserved writer file") }
      var transferred = false
      defer { if !transferred { Darwin.close(output); Darwin.close(parent); Darwin.close(root) } }
      let validate: (Int32) throws -> Void = { descriptor in
        var namedParent = stat(), named = stat(), opened = stat()
        guard try self.directoryIdentity(descriptor: root) == prepared.directoryIdentity,
              try self.directoryIdentity(self.targetRoot) == prepared.directoryIdentity,
              Self.canonical(self.targetRoot) == self.targetRoot,
              try self.directoryIdentity(descriptor: parent) == prepared.privateDirectoryIdentity,
              Darwin.fstatat(root, privateDirectory.lastPathComponent, &namedParent, AT_SYMLINK_NOFOLLOW) == 0,
              namedParent.st_mode & S_IFMT == S_IFDIR,
              "\(UInt64(namedParent.st_dev)):\(UInt64(namedParent.st_ino))" == prepared.privateDirectoryIdentity,
              Darwin.fstat(descriptor, &opened) == 0, opened.st_mode & S_IFMT == S_IFREG, opened.st_nlink == 1,
              self.identityToken(try self.publicationIdentity(descriptor: descriptor)) == prepared.stagedIdentity,
              Darwin.fstatat(parent, "stage", &named, AT_SYMLINK_NOFOLLOW) == 0,
              named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1,
              try self.publicationIdentity(descriptor: descriptor) == self.publicationIdentity(staged) else {
          throw installerError("Reserved attachment writer identity changed")
        }
      }
      try validate(output)
      guard try self.publicationIdentity(descriptor: output).size == 0 else {
        throw installerError("Reserved attachment writer requires an empty stage")
      }
      let writer = try ImmutableAttachmentStageWriter(descriptor: output, validate: validate,
        synchronizeParents: {
          try validate(output)
          guard Darwin.fsync(parent) == 0, Darwin.fsync(root) == 0 else { throw installerError("Could not synchronize reserved writer directories") }
        }, releaseParents: { Darwin.close(parent); Darwin.close(root) })
      transferred = true
      return writer
    }
  }

  func install(
    stagedInput: URL,
    targetInput: URL,
    expected: ExpectedAttachmentGeneration,
    expectedDownloadSha256: String
  ) throws -> AttachmentInstallOutcome {
    try ensureDirectory(targetRoot)
    try requireDirectory(targetRoot, label: "managed attachment root")

    try rejectSymlinkInput(stagedInput, label: "staged attachment")
    try rejectSymlinkInput(targetInput, label: "target attachment")
    let staged = Self.canonical(stagedInput)
    let target = Self.canonical(targetInput)
    try validateTargetPath(target)
    try validateSourcePath(staged)
    guard staged != target else {
      throw installerError("Staged and target attachment paths must differ")
    }
    guard isSha256(expectedDownloadSha256) else {
      throw installerError("Expected download SHA-256 is invalid")
    }

    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.installLocked(stagedInput: stagedInput, targetInput: targetInput, staged: staged, target: target,
        expected: expected, expectedDownloadSha256: expectedDownloadSha256, retained: nil)
    }
  }

  func install(stagedInput: URL, targetInput: URL, expected: ExpectedAttachmentGeneration,
    expectedDownloadSha256: String, directoryDescriptor: Int32,
    requireAuthority: () throws -> Void) throws -> AttachmentInstallOutcome {
    guard isSha256(expectedDownloadSha256) else { throw installerError("Expected download SHA-256 is invalid") }
    return try withoutActuallyEscaping(requireAuthority) { check in
      let retained = RetainedInstallDirectory(descriptor: directoryDescriptor, root: targetRoot, requireAuthority: check)
      _ = try retained.leaf(stagedInput)
      _ = try retainedTargetName(targetInput)
      _ = try retained.leaf(targetInput)
      guard !stagedInput.path.utf8.elementsEqual(targetInput.path.utf8) else { throw installerError("Staged and target paths must differ") }
      return try withRetainedDirectoryLock(directoryDescriptor, requireAuthority: check) {
        try self.preflightRetainedJournals(retained)
        return try self.installLocked(stagedInput: stagedInput, targetInput: targetInput, staged: stagedInput, target: targetInput,
          expected: expected, expectedDownloadSha256: expectedDownloadSha256, retained: retained)
      }
    }
  }

  func hash(_ input: URL, directoryDescriptor: Int32,
    requireAuthority: () throws -> Void) throws -> AttachmentFileHashSnapshot {
    return try withoutActuallyEscaping(requireAuthority) { check in
      let retained = RetainedInstallDirectory(descriptor: directoryDescriptor, root: targetRoot, requireAuthority: check)
      let name = try retained.leaf(input)
      _ = try retainedTargetName(input)
      return try withRetainedDirectoryLock(directoryDescriptor, requireAuthority: check) {
        let handle = try self.openRegularFileForReading(input, retained: retained)
        defer { try? handle.close() }
        let before = try self.publicationIdentity(descriptor: handle.fileDescriptor)
        let digest = try self.sha256(descriptor: handle.fileDescriptor)
        try self.faultInjector(.afterRetainedHashRead)
        try check()
        guard try self.retainedFileMatches(handle.fileDescriptor, parent: directoryDescriptor, name: name, expected: before) else {
          throw installerError("Retained attachment changed while hashing")
        }
        return AttachmentFileHashSnapshot(sha256: digest, size: UInt64(before.size),
          modificationTimeMs: Double(before.modifiedSeconds) * 1_000 + Double(before.modifiedNanoseconds) / 1_000_000)
      }
    }
  }

  private func retainedNode(_ input: URL, retained: RetainedInstallDirectory) throws -> stat? {
    try retained.requireAuthority()
    var value = stat()
    let result: Int32
    if input.path.utf8.elementsEqual(retained.root.path.utf8) {
      result = Darwin.fstat(retained.descriptor, &value)
    } else {
      result = Darwin.fstatat(retained.descriptor, try retained.leaf(input), &value, AT_SYMLINK_NOFOLLOW)
    }
    if result != 0 {
      if errno == ENOENT { return nil }
      throw installerError("Could not inspect retained attachment entry")
    }
    return value
  }

  private func readRetainedData(_ input: URL, retained: RetainedInstallDirectory, maximumBytes: Int) throws -> Data {
    let handle = try openRegularFileForReading(input, retained: retained)
    defer { try? handle.close() }
    let before = try publicationIdentity(descriptor: handle.fileDescriptor)
    guard before.size <= maximumBytes else { throw installerError("Attachment journal exceeds the byte limit") }
    var data = Data()
    while let chunk = try handle.read(upToCount: maximumBytes + 1 - data.count), !chunk.isEmpty {
      data.append(chunk)
      guard data.count <= maximumBytes else { throw installerError("Attachment journal exceeds the byte limit") }
    }
    try retained.requireAuthority()
    guard try retainedFileMatches(handle.fileDescriptor, parent: retained.descriptor, name: retained.leaf(input), expected: before) else {
      throw installerError("Attachment journal changed while reading")
    }
    return data
  }

  private func forEachRetainedEntry(_ retained: RetainedInstallDirectory, _ visit: (String) throws -> Void) throws {
    try retained.requireAuthority()
    let descriptor = Darwin.openat(retained.descriptor, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw installerError("Could not enumerate retained attachment directory") }
    guard let stream = Darwin.fdopendir(descriptor) else {
      Darwin.close(descriptor)
      throw installerError("Could not enumerate retained attachment directory")
    }
    defer { Darwin.closedir(stream) }
    while true {
      errno = 0
      guard let entry = Darwin.readdir(stream) else {
        guard errno == 0 else { throw installerError("Retained attachment enumeration failed") }
        break
      }
      let name = withUnsafePointer(to: &entry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(validatingUTF8: $0) }
      }
      if let name, name != ".", name != ".." { try visit(name) }
    }
    try retained.requireAuthority()
  }

  private func retainedJournalPath(_ path: String, retained: RetainedInstallDirectory) throws -> URL {
    guard path.utf8.count <= 16 * 1024, path.hasPrefix("/"), !path.utf8.contains(0) else {
      throw installerError("Attachment journal path is invalid")
    }
    let url = URL(fileURLWithPath: path)
    guard url.path.utf8.elementsEqual(path.utf8) else { throw installerError("Attachment journal path is not canonical") }
    _ = try retained.leaf(url)
    return url
  }

  private func validateRetainedJournal(_ journal: InstallJournal, file: URL,
    retained: RetainedInstallDirectory) throws -> URL {
    let target = try retainedJournalPath(journal.targetPath, retained: retained)
    try validateTargetPath(target, retained: retained)
    let staged = try retainedJournalPath(journal.stagedPath, retained: retained)
    try validateSourceContainment(staged, retained: retained)
    guard !target.path.utf8.elementsEqual(staged.path.utf8) else { throw installerError("Attachment journal source equals its target") }
    let expected = artifacts(for: target)
    guard expected.journal.path.utf8.elementsEqual(file.path.utf8) else { throw installerError("Attachment journal slot does not match its target") }
    if let path = journal.preservationPath {
      try validatePreservationPath(retainedJournalPath(path, retained: retained), artifacts: expected, retained: retained)
    }
    return target
  }

  private func preflightRetainedJournals(_ retained: RetainedInstallDirectory) throws {
    var count = 0
    try forEachRetainedEntry(retained) { name in
      guard name.hasPrefix(installerArtifactPrefix), name.hasSuffix(".journal") else { return }
      count += 1
      guard count <= 10_000,
        name.range(of: "^\\.mindwtr-install-[a-f0-9]{32}\\.journal\\z", options: .regularExpression) != nil else {
        throw installerError("Attachment journal inventory requires recovery")
      }
      let file = self.targetRoot.appendingPathComponent(name)
      let journal = try self.parseJournal(file, retained: retained)
      _ = try self.validateRetainedJournal(journal, file: file, retained: retained)
    }
  }

  private func sameRetainedPair(_ first: URL, _ second: URL, retained: RetainedInstallDirectory) throws -> Bool {
    guard let a = try retainedNode(first, retained: retained), let b = try retainedNode(second, retained: retained) else { return false }
    return a.st_mode & S_IFMT == S_IFREG && b.st_mode & S_IFMT == S_IFREG
      && a.st_nlink == 2 && b.st_nlink == 2 && a.st_dev == b.st_dev && a.st_ino == b.st_ino
  }

  private func retireRetainedAlias(_ owned: URL, preserved: URL, expectedSha256: String,
    retained: RetainedInstallDirectory) throws {
    guard try sameRetainedPair(owned, preserved, retained: retained) else { throw installerError("Attachment recovery alias is uncertain") }
    let name = try retained.leaf(owned), other = try retained.leaf(preserved)
    let descriptor = Darwin.openat(retained.descriptor, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { throw installerError("Could not retain attachment recovery alias") }
    defer { Darwin.close(descriptor) }
    let before = try publicationIdentity(descriptor: descriptor)
    let digest = try sha256(descriptor: descriptor)
    try retained.requireAuthority()
    var a = stat(), b = stat(), opened = stat()
    guard digest == expectedSha256, try publicationIdentity(descriptor: descriptor) == before,
      Darwin.fstat(descriptor, &opened) == 0,
      Darwin.fstatat(retained.descriptor, name, &a, AT_SYMLINK_NOFOLLOW) == 0,
      Darwin.fstatat(retained.descriptor, other, &b, AT_SYMLINK_NOFOLLOW) == 0,
      retainedValueMatches(opened, expected: before, links: 2), retainedValueMatches(a, expected: before, links: 2),
      retainedValueMatches(b, expected: before, links: 2) else {
      throw installerError("Attachment recovery alias changed")
    }
    guard Darwin.unlinkat(retained.descriptor, name, 0) == 0 else { throw installerError("Could not retire owned attachment recovery alias") }
    try syncDirectory(targetRoot, retained: retained)
  }

  private func normalizeRetainedJournalLinks(target: URL, artifacts: InstallArtifacts, journal: InstallJournal,
    retained: RetainedInstallDirectory) throws {
    if try sameRetainedPair(artifacts.candidate, target, retained: retained) {
      try retireRetainedAlias(artifacts.candidate, preserved: target, expectedSha256: journal.candidateSha256, retained: retained)
    }
    if let expected = journal.displacedSha256 ?? journal.expectedLocalSha256,
      try sameRetainedPair(artifacts.quarantine, target, retained: retained) {
      try retireRetainedAlias(artifacts.quarantine, preserved: target, expectedSha256: expected, retained: retained)
    }
    guard let quarantine = try retainedNode(artifacts.quarantine, retained: retained), quarantine.st_nlink == 2 else { return }
    var aliases: [URL] = []
    try forEachRetainedEntry(retained) { name in
      guard name.hasPrefix(artifacts.preservationPrefix) else { return }
      let path = self.targetRoot.appendingPathComponent(name)
      try self.validatePreservationPath(path, artifacts: artifacts, retained: retained)
      if try self.sameRetainedPair(artifacts.quarantine, path, retained: retained) { aliases.append(path) }
    }
    guard aliases.count == 1, let alias = aliases.first,
      let expected = journal.displacedSha256 ?? journal.expectedLocalSha256 else {
      throw installerError("Attachment quarantine alias requires recovery")
    }
    try retireRetainedAlias(artifacts.quarantine, preserved: alias, expectedSha256: expected, retained: retained)
  }

  private func retainedValueMatches(_ value: stat, expected: PublicationIdentity, links: nlink_t) -> Bool {
    value.st_mode & S_IFMT == S_IFREG && value.st_nlink == links
      && UInt64(value.st_dev) == expected.device && UInt64(value.st_ino) == expected.inode && Int64(value.st_size) == expected.size
      && Int64(value.st_mtimespec.tv_sec) == expected.modifiedSeconds && Int64(value.st_mtimespec.tv_nsec) == expected.modifiedNanoseconds
      && Int64(value.st_ctimespec.tv_sec) == expected.changedSeconds && Int64(value.st_ctimespec.tv_nsec) == expected.changedNanoseconds
  }

  private func removeRetainedCreatedEntry(_ file: URL, descriptor: Int32, retained: RetainedInstallDirectory) {
    guard (try? retained.requireAuthority()) != nil, let name = try? retained.leaf(file),
      let identity = try? publicationIdentity(descriptor: descriptor),
      (try? retainedFileMatches(descriptor, parent: retained.descriptor, name: name, expected: identity)) == true else { return }
    _ = Darwin.unlinkat(retained.descriptor, name, 0)
    _ = Darwin.fsync(retained.descriptor)
  }

  private func copyRetainedSnapshot(from source: URL, to destination: URL, retained: RetainedInstallDirectory) throws {
    let input = try openRegularFileForReading(source, retained: retained)
    defer { try? input.close() }
    let before = try publicationIdentity(descriptor: input.fileDescriptor)
    let name = try retained.leaf(destination)
    try retained.requireAuthority()
    let descriptor = Darwin.openat(retained.descriptor, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw installerError("Retained attachment candidate already exists") }
    let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var completed = false
    defer {
      if !completed { removeRetainedCreatedEntry(destination, descriptor: descriptor, retained: retained) }
      try? output.close()
    }
    var total: Int64 = 0
    while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty {
      guard total <= before.size - Int64(chunk.count) else { throw installerError("Retained source grew during snapshot") }
      total += Int64(chunk.count)
      try output.write(contentsOf: chunk)
    }
    try retained.requireAuthority()
    guard total == before.size,
      try retainedFileMatches(input.fileDescriptor, parent: retained.descriptor, name: retained.leaf(source), expected: before) else {
      throw installerError("Retained source changed during snapshot")
    }
    try output.synchronize()
    try syncDirectory(targetRoot, retained: retained)
    completed = true
  }

  private func moveRetainedExclusive(from source: URL, to destination: URL, retained: RetainedInstallDirectory) throws -> Bool {
    let name = try retained.leaf(source), target = try retained.leaf(destination)
    let input = try openRegularFileForReading(source, retained: retained)
    defer { try? input.close() }
    let before = try publicationIdentity(descriptor: input.fileDescriptor)
    try retained.requireAuthority()
    guard try retainedFileMatches(input.fileDescriptor, parent: retained.descriptor, name: name, expected: before) else {
      throw installerError("Retained move source changed")
    }
    let result = Darwin.linkat(retained.descriptor, name, retained.descriptor, target, 0)
    if result != 0 {
      if errno == EEXIST { return false }
      throw installerError("Could not publish retained attachment generation")
    }
    let linked = try publicationIdentity(descriptor: input.fileDescriptor)
    guard linked.device == before.device, linked.inode == before.inode, linked.size == before.size,
      linked.modifiedSeconds == before.modifiedSeconds, linked.modifiedNanoseconds == before.modifiedNanoseconds else {
      throw installerError("Retained attachment changed while linking")
    }
    try faultInjector(.afterExclusiveLink)
    try retained.requireAuthority()
    var opened = stat(), named = stat(), published = stat()
    guard Darwin.fstat(input.fileDescriptor, &opened) == 0,
      Darwin.fstatat(retained.descriptor, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
      Darwin.fstatat(retained.descriptor, target, &published, AT_SYMLINK_NOFOLLOW) == 0,
      retainedValueMatches(opened, expected: linked, links: 2), retainedValueMatches(named, expected: linked, links: 2),
      retainedValueMatches(published, expected: linked, links: 2) else { throw installerError("Retained publication link changed") }
    guard Darwin.unlinkat(retained.descriptor, name, 0) == 0 else { throw installerError("Could not release retained publication source") }
    return true
  }

  private func writeRetainedJournal(_ journal: InstallJournal, data: Data, to file: URL,
    retained: RetainedInstallDirectory) throws {
    guard data.count <= 64 * 1024 else { throw installerError("Attachment journal exceeds the byte limit") }
    _ = try validateRetainedJournal(journal, file: file, retained: retained)
    var previous: FileHandle?
    var previousIdentity: PublicationIdentity?
    defer { try? previous?.close() }
    if try retainedNode(file, retained: retained) != nil {
      let handle = try openRegularFileForReading(file, retained: retained)
      previous = handle
      previousIdentity = try publicationIdentity(descriptor: handle.fileDescriptor)
      let actual = try parseJournal(file, retained: retained)
      _ = try validateRetainedJournal(actual, file: file, retained: retained)
      guard actual.targetPath.utf8.elementsEqual(journal.targetPath.utf8), actual.stagedPath.utf8.elementsEqual(journal.stagedPath.utf8),
        actual.candidateSha256 == journal.candidateSha256, actual.expectedLocalSha256 == journal.expectedLocalSha256,
        actual.displacedSha256 == nil || actual.displacedSha256 == journal.displacedSha256,
        actual.preservationPath == nil || actual.preservationPath == journal.preservationPath else {
        throw installerError("Retained attachment journal ownership changed")
      }
    }
    let temporary = file.appendingPathExtension("write-" + UUID().uuidString)
    let name = try retained.leaf(temporary)
    try retained.requireAuthority()
    let descriptor = Darwin.openat(retained.descriptor, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw installerError("Could not create retained attachment journal") }
    let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var promoted = false
    defer {
      if !promoted { removeRetainedCreatedEntry(temporary, descriptor: descriptor, retained: retained) }
      try? output.close()
    }
    try output.write(contentsOf: data)
    try output.synchronize()
    let written = try publicationIdentity(descriptor: descriptor)
    try retained.requireAuthority()
    if let previous, let previousIdentity {
      guard try retainedFileMatches(previous.fileDescriptor, parent: retained.descriptor, name: retained.leaf(file), expected: previousIdentity) else {
        throw installerError("Retained journal changed before acknowledgment")
      }
    } else {
      guard try retainedNode(file, retained: retained) == nil else { throw installerError("Unowned attachment journal appeared") }
    }
    guard try retainedFileMatches(descriptor, parent: retained.descriptor, name: name, expected: written),
      Darwin.renameat(retained.descriptor, name, retained.descriptor, try retained.leaf(file)) == 0 else {
      throw installerError("Could not replace retained attachment journal")
    }
    promoted = true
    try syncDirectory(targetRoot, retained: retained)
  }

  private func retireRetainedStage(_ staged: URL, expectedSha256: String?, retained: RetainedInstallDirectory) throws {
    guard try retainedNode(staged, retained: retained) != nil else { return }
    let input = try openRegularFileForReading(staged, retained: retained)
    defer { try? input.close() }
    let before = try publicationIdentity(descriptor: input.fileDescriptor)
    if let expectedSha256, try sha256(descriptor: input.fileDescriptor) != expectedSha256 { return }
    try retained.requireAuthority()
    let name = try retained.leaf(staged)
    guard try retainedFileMatches(input.fileDescriptor, parent: retained.descriptor, name: name, expected: before),
      Darwin.unlinkat(retained.descriptor, name, 0) == 0 else { throw installerError("Retained stage changed before retirement") }
    try syncDirectory(targetRoot, retained: retained)
  }

  private func installLocked(stagedInput: URL, targetInput: URL, staged: URL, target: URL,
    expected: ExpectedAttachmentGeneration, expectedDownloadSha256: String,
    retained: RetainedInstallDirectory?) throws -> AttachmentInstallOutcome {
    try self.requireDirectory(self.targetRoot, label: "managed attachment root", retained: retained)
    try self.rejectSymlinkInput(stagedInput, label: "staged attachment", retained: retained)
    try self.rejectSymlinkInput(targetInput, label: "target attachment", retained: retained)
    try self.validateTargetPath(target, retained: retained)
    try self.validateSourcePath(staged, retained: retained)

    let artifacts = self.artifacts(for: target)
    switch try self.recoverJournal(target: target, artifacts: artifacts, retained: retained) {
    case .completed(let previousStaged, let preservedUrl) where previousStaged == staged:
      return .installed(preservedUrl: preservedUrl)
    case .conflict(let preservedUrl):
      return .conflict(preservedUrl: preservedUrl)
    case .completed, .proceed:
      break
    }

    if let retained, let targetNode = try retainedNode(target, retained: retained) {
      guard targetNode.st_mode & S_IFMT == S_IFREG, targetNode.st_nlink == 1 else {
        throw installerError("Retained attachment target is unsafe")
      }
    }

    try self.prepareCleanArtifacts(artifacts, retained: retained)
    try self.requireRegularFile(staged, label: "staged attachment", retained: retained)
    try self.copySnapshot(from: staged, to: artifacts.candidate, retained: retained)
    let candidateSha256 = try self.sha256(artifacts.candidate, retained: retained)
    guard candidateSha256 == expectedDownloadSha256 else {
      try self.deleteInternalIfRegular(artifacts.candidate, retained: retained)
      throw installerError("Staged attachment changed before native snapshot")
    }
    switch expected {
    case .absent:
      return try self.installWhenAbsent(
        staged: staged,
        target: target,
        candidateSha256: candidateSha256,
        artifacts: artifacts,
        retained: retained
      )
    case .present(let expectedSha256):
      guard isSha256(expectedSha256) else {
        throw installerError("Expected attachment SHA-256 is invalid")
      }
      return try self.installWhenPresent(
        staged: staged,
        target: target,
        expectedSha256: expectedSha256,
        candidateSha256: candidateSha256,
        artifacts: artifacts,
        retained: retained
      )
    }
  }


  func publishImmutable(
    stagedInput: URL,
    targetInput: URL,
    expectedStagedSha256: String,
    expectedStagedIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String
  ) throws -> ImmutableAttachmentPublishOutcome {
    guard isSha256(expectedStagedSha256) else {
      throw installerError("Expected staged attachment SHA-256 is invalid")
    }
    try ensureDirectory(targetRoot)
    try requireDirectory(targetRoot, label: "File Sync attachment directory")
    try rejectSymlinkInput(stagedInput, label: "staged attachment")
    try rejectSymlinkInput(targetInput, label: "target attachment")
    let staged = Self.canonical(stagedInput)
    let target = Self.canonical(targetInput)
    try validateTargetPath(target)
    let privateDirectory = staged.deletingLastPathComponent()
    guard
      staged.lastPathComponent == "stage",
      privateDirectory.deletingLastPathComponent() == targetRoot,
      privateDirectory.lastPathComponent.range(
        of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z",
        options: .regularExpression
      ) != nil
    else {
      throw installerError("Immutable attachment stage must use its reserved private namespace")
    }
    guard staged != target else {
      throw installerError("Immutable attachment stage and target must differ")
    }

    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "File Sync attachment directory")
      try self.requireDirectory(privateDirectory, label: "private attachment publication directory")
      try self.rejectSymlinkInput(stagedInput, label: "staged attachment")
      try self.rejectSymlinkInput(targetInput, label: "target attachment")
      guard Self.canonical(stagedInput) == staged, Self.canonical(targetInput) == target else {
        throw installerError("Immutable attachment path changed during validation")
      }
      let sourceDescriptor = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
      guard sourceDescriptor >= 0 else {
        throw installerError("Could not retain private attachment stage handle")
      }
      defer { Darwin.close(sourceDescriptor) }
      let privateDescriptor = Darwin.open(privateDirectory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      guard privateDescriptor >= 0 else {
        throw installerError("Could not retain private attachment publication directory")
      }
      defer { Darwin.close(privateDescriptor) }
      let targetDescriptor = Darwin.open(self.targetRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
      guard targetDescriptor >= 0 else {
        throw installerError("Could not retain attachment target directory")
      }
      defer { Darwin.close(targetDescriptor) }

      let before = try self.publicationIdentity(descriptor: sourceDescriptor)
      let digest = try self.sha256(descriptor: sourceDescriptor)
      let after = try self.publicationIdentity(descriptor: sourceDescriptor)
      guard
        before == after,
        digest == expectedStagedSha256,
        self.identityToken(after) == expectedStagedIdentity,
        try self.directoryIdentity(descriptor: targetDescriptor) == expectedDirectoryIdentity,
        try self.directoryIdentity(descriptor: privateDescriptor) == expectedPrivateDirectoryIdentity
      else {
        throw installerError("Staged attachment changed before native publication")
      }
      guard try self.nodeKind(target) == .missing else { return .alreadyExists }
      try self.faultInjector(.beforeImmutablePublication)
      var named = stat()
      guard
        Darwin.fstatat(privateDescriptor, "stage", &named, AT_SYMLINK_NOFOLLOW) == 0,
        named.st_mode & S_IFMT == S_IFREG,
        UInt64(named.st_dev) == before.device,
        UInt64(named.st_ino) == before.inode
      else {
        throw installerError("Verified attachment stage name changed before publication")
      }
      guard Darwin.fsync(sourceDescriptor) == 0 else {
        throw installerError("Could not flush private attachment stage")
      }
      guard
        try self.directoryIdentity(descriptor: targetDescriptor) == expectedDirectoryIdentity,
        try self.directoryIdentity(descriptor: privateDescriptor) == expectedPrivateDirectoryIdentity
      else {
        throw installerError("Attachment publication directory identity changed")
      }
      let result = target.lastPathComponent.withCString { targetName in
        Darwin.renameatx_np(
          privateDescriptor,
          "stage",
          targetDescriptor,
          targetName,
          UInt32(RENAME_EXCL)
        )
      }
      if result != 0 {
        if errno == EEXIST { return .alreadyExists }
        throw installerError("Could not publish exact attachment stage")
      }
      guard Darwin.fsync(targetDescriptor) == 0, Darwin.fsync(privateDescriptor) == 0 else {
        throw installerError("Could not flush retained attachment publication directories")
      }
      let publishedDescriptor = target.lastPathComponent.withCString { targetName in
        Darwin.openat(targetDescriptor, targetName, O_RDONLY | O_NOFOLLOW)
      }
      guard publishedDescriptor >= 0 else {
        throw installerError("Could not reopen published attachment from retained directory")
      }
      defer { Darwin.close(publishedDescriptor) }
      guard try self.sha256(descriptor: publishedDescriptor) == expectedStagedSha256 else {
        throw installerError("Published attachment generation failed verification")
      }
      try self.faultInjector(.beforeImmutablePrivateDirectoryRetirement)
      guard
        try self.directoryIdentity(descriptor: targetDescriptor) == expectedDirectoryIdentity,
        try self.directoryIdentity(descriptor: privateDescriptor) == expectedPrivateDirectoryIdentity
      else {
        throw installerError("Attachment publication directory identity changed before cleanup")
      }
      var namedPrivateDirectory = stat()
      let privateDirectoryName = privateDirectory.lastPathComponent
      let statResult = privateDirectoryName.withCString { name in
        Darwin.fstatat(targetDescriptor, name, &namedPrivateDirectory, AT_SYMLINK_NOFOLLOW)
      }
      guard
        statResult == 0,
        namedPrivateDirectory.st_mode & S_IFMT == S_IFDIR,
        "\(UInt64(namedPrivateDirectory.st_dev)):\(UInt64(namedPrivateDirectory.st_ino))"
          == expectedPrivateDirectoryIdentity
      else {
        throw installerError("Private attachment publication directory changed before cleanup")
      }
      let removeResult = privateDirectoryName.withCString { name in
        Darwin.unlinkat(targetDescriptor, name, AT_REMOVEDIR)
      }
      guard removeResult == 0 else {
        throw installerError("Could not remove empty private attachment publication directory")
      }
      guard Darwin.fsync(targetDescriptor) == 0 else {
        throw installerError("Could not flush attachment directory after private cleanup")
      }
      return .published
    }
  }

  func prepareImmutableStage(
    targetInput: URL,
    operationId: String
  ) throws -> ImmutableAttachmentPreparedStage {
    guard operationId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
      throw installerError("Attachment publication operation id is invalid")
    }
    let target = Self.canonical(targetInput)
    try validateTargetPath(target)
    let privateDirectory = targetRoot.appendingPathComponent(
      "\(installerArtifactPrefix)\(operationId).candidate",
      isDirectory: true
    )
    let stage = privateDirectory.appendingPathComponent("stage")
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "File Sync attachment directory")
      guard try self.nodeKind(privateDirectory) == .missing else {
        throw installerError("Attachment publication private namespace already exists")
      }
      guard Darwin.mkdir(privateDirectory.path, S_IRWXU) == 0 else {
        throw installerError("Could not create private attachment publication directory")
      }
      let descriptor = Darwin.open(stage.path, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW, 0o600)
      guard descriptor >= 0 else {
        throw installerError("Could not create private attachment publication stage")
      }
      defer { Darwin.close(descriptor) }
      guard Darwin.fsync(descriptor) == 0 else {
        throw installerError("Could not flush private attachment publication stage")
      }
      try self.syncDirectory(privateDirectory)
      try self.syncDirectory(self.targetRoot)
      let identity = try self.publicationIdentity(descriptor: descriptor)
      return ImmutableAttachmentPreparedStage(
        stagedUrl: stage,
        stagedIdentity: self.identityToken(identity),
        directoryIdentity: try self.directoryIdentity(self.targetRoot),
        privateDirectoryIdentity: try self.directoryIdentity(privateDirectory)
      )
    }
  }

  func snapshotImmutableStage(
    stagedInput: URL,
    targetInput: URL,
    expectedStagedSha256: String
  ) throws -> ImmutableAttachmentStageIdentity {
    guard isSha256(expectedStagedSha256) else {
      throw installerError("Expected staged attachment SHA-256 is invalid")
    }
    try validateImmutableRecoveryPaths(stagedInput: stagedInput, targetInput: targetInput)
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "File Sync attachment directory")
      try self.requireRegularFile(stagedInput, label: "staged attachment")
      let before = try self.publicationIdentity(stagedInput)
      let digest = try self.sha256(stagedInput)
      let after = try self.publicationIdentity(stagedInput)
      guard before == after, digest == expectedStagedSha256 else {
        throw installerError("Staged attachment changed before ownership was recorded")
      }
      return ImmutableAttachmentStageIdentity(
        stagedIdentity: self.identityToken(after),
        directoryIdentity: try self.directoryIdentity(self.targetRoot)
      )
    }
  }

  func cleanupImmutableStage(
    stagedInput: URL,
    targetInput: URL,
    operationId: String,
    expectedStagedSha256: String?,
    expectedStagedIdentity: String?,
    expectedDirectoryIdentity: String?,
    expectedPrivateDirectoryIdentity: String?
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    try cleanupImmutableStage(
      stagedInput: stagedInput, targetInput: targetInput, operationId: operationId,
      expectedStagedSha256: expectedStagedSha256, expectedStagedIdentity: expectedStagedIdentity,
      expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity, mode: .legacy
    )
  }

  func retireOwnedPrivateStage(
    stagedInput: URL,
    targetInput: URL,
    operationId: String,
    expectedStagedIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    guard operationId.utf8.count == 32,
          [expectedStagedIdentity, expectedDirectoryIdentity, expectedPrivateDirectoryIdentity]
            .allSatisfy(Self.validIdentityToken) else {
      throw installerError("Owned private attachment retirement proof is invalid")
    }
    for input in [stagedInput, targetInput] {
      guard input.isFileURL, input.absoluteString.utf8.count <= 16 * 1024,
            let components = URLComponents(url: input, resolvingAgainstBaseURL: false),
            components.host == nil || components.host == "",
            components.user == nil, components.password == nil, components.port == nil,
            components.query == nil, components.fragment == nil else {
        throw installerError("Owned private attachment retirement path is invalid")
      }
    }
    return try cleanupImmutableStage(
      stagedInput: stagedInput, targetInput: targetInput, operationId: operationId,
      expectedStagedSha256: nil, expectedStagedIdentity: expectedStagedIdentity,
      expectedDirectoryIdentity: expectedDirectoryIdentity,
      expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity, mode: .owned
    )
  }

  private func cleanupImmutableStage(
    stagedInput: URL,
    targetInput: URL,
    operationId: String,
    expectedStagedSha256: String?,
    expectedStagedIdentity: String?,
    expectedDirectoryIdentity: String?,
    expectedPrivateDirectoryIdentity: String?,
    mode: PrivateStageCleanupMode
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    guard operationId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
      throw installerError("Attachment publication operation id is invalid")
    }
    let privateDirectory = targetRoot.appendingPathComponent(
      "\(installerArtifactPrefix)\(operationId).candidate",
      isDirectory: true
    )
    let privateStage = privateDirectory.appendingPathComponent("stage")
    let isPrivateStage = immutablePathsMatch(Self.canonical(stagedInput), Self.canonical(privateStage))
    if mode == .owned {
      guard stagedInput.lastPathComponent == "stage",
            stagedInput.deletingLastPathComponent().lastPathComponent == privateDirectory.lastPathComponent,
            immutablePathsMatch(Self.canonical(stagedInput), privateStage) else {
        throw installerError("Owned attachment stage must use its recorded private namespace")
      }
    }
    guard isPrivateStage || stagedInput.lastPathComponent == ".mindwtr-generation-stage-\(operationId).tmp" else {
      throw installerError("Attachment publication stage name is invalid")
    }
    try validateImmutableRecoveryPaths(stagedInput: stagedInput, targetInput: targetInput, createRoot: mode == .legacy)
    if mode == .owned {
      try validateTargetPath(Self.canonical(targetInput))
      guard try directoryIdentity(targetRoot) == expectedDirectoryIdentity else { return .conflict }
    }
    let quarantine = targetRoot.appendingPathComponent(
      "\(installerArtifactPrefix)\(operationId).quarantine",
      isDirectory: true
    )
    let quarantinedStage = quarantine.appendingPathComponent("stage")
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "File Sync attachment directory")
      if isPrivateStage {
        return try self.cleanupPrivateStage(
          privateDirectory: privateDirectory, privateStage: privateStage,
          expectedStagedIdentity: expectedStagedIdentity,
          expectedDirectoryIdentity: expectedDirectoryIdentity,
          expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity, mode: mode
        )
      }
      guard
        let expectedStagedSha256,
        let expectedStagedIdentity,
        let expectedDirectoryIdentity
      else {
        return try self.nodeKind(stagedInput) == .missing && self.nodeKind(quarantine) == .missing
          ? .missing
          : .conflict
      }
      guard try self.directoryIdentity(self.targetRoot) == expectedDirectoryIdentity else {
        return .conflict
      }
      switch try self.nodeKind(quarantine) {
      case .missing:
        guard try self.nodeKind(stagedInput) == .regularFile else {
          return try self.nodeKind(stagedInput) == .missing ? .missing : .conflict
        }
        guard Darwin.mkdir(quarantine.path, S_IRWXU) == 0 else {
          throw installerError("Could not create private attachment recovery directory")
        }
        guard try self.moveExclusive(from: stagedInput, to: quarantinedStage) else {
          return .conflict
        }
        try self.syncDirectory(self.targetRoot)
      case .directory:
        guard try self.nodeKind(stagedInput) == .missing else { return .conflict }
      default:
        return .conflict
      }
      guard try self.directoryIdentity(self.targetRoot) == expectedDirectoryIdentity else {
        return .conflict
      }
      guard try self.nodeKind(quarantinedStage) == .regularFile else { return .conflict }
      let before = try self.publicationIdentity(quarantinedStage)
      let digest = try self.sha256(quarantinedStage)
      let after = try self.publicationIdentity(quarantinedStage)
      guard
        before == after,
        identityToken(after) == expectedStagedIdentity,
        digest == expectedStagedSha256
      else {
        return .conflict
      }
      try self.delete(quarantinedStage)
      try self.syncDirectory(quarantine)
      guard Darwin.rmdir(quarantine.path) == 0 else {
        throw installerError("Could not remove private attachment recovery directory")
      }
      try self.syncDirectory(self.targetRoot)
      return .removed
    }
  }

  private func validateImmutableRecoveryPaths(stagedInput: URL, targetInput: URL, createRoot: Bool = true) throws {
    if createRoot { try ensureDirectory(targetRoot) }
    try requireDirectory(targetRoot, label: "File Sync attachment directory")
    try rejectSymlinkInput(stagedInput, label: "staged attachment")
    try rejectSymlinkInput(targetInput, label: "target attachment")
    let staged = Self.canonical(stagedInput)
    let target = Self.canonical(targetInput)
    let stagedParent = staged.deletingLastPathComponent()
    let privateStage = staged.lastPathComponent == "stage"
      && immutablePathsMatch(stagedParent.deletingLastPathComponent(), targetRoot)
      && stagedParent.lastPathComponent.range(
        of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate\\z",
        options: .regularExpression
      ) != nil
    guard
      privateStage || immutablePathsMatch(stagedParent, targetRoot),
      immutablePathsMatch(target.deletingLastPathComponent(), targetRoot),
      staged != target
    else {
      throw installerError("Immutable attachment recovery paths escape the target directory")
    }
  }

  private func immutablePathsMatch(_ left: URL, _ right: URL) -> Bool {
    if left == right { return true }
    guard let destination = try? fileManager.destinationOfSymbolicLink(atPath: "/var"),
          ["private/var", "/private/var"].contains(destination) else { return false }
    func normalized(_ url: URL) -> URL {
      guard url.pathComponents.dropFirst().first == "var" else { return url }
      return URL(fileURLWithPath: "/private" + url.path, isDirectory: url.hasDirectoryPath)
    }
    return normalized(left) == normalized(right)
  }

  private static func validIdentityToken(_ value: String) -> Bool {
    guard value.utf8.count <= 41 else { return false }
    let parts = value.split(separator: ":", omittingEmptySubsequences: false)
    return parts.count == 2 && parts.allSatisfy {
      guard let number = UInt64($0) else { return false }
      return String(number) == $0
    }
  }


  private func cleanupPrivateStage(
    privateDirectory: URL,
    privateStage: URL,
    expectedStagedIdentity: String?,
    expectedDirectoryIdentity: String?,
    expectedPrivateDirectoryIdentity: String?,
    mode: PrivateStageCleanupMode
  ) throws -> ImmutableAttachmentStageCleanupOutcome {
    let owned = mode == .owned
    let rootToken = expectedDirectoryIdentity ?? ""
    let privateToken = expectedPrivateDirectoryIdentity ?? ""
    let stageToken = expectedStagedIdentity ?? ""
    let name = privateDirectory.lastPathComponent
    var rootDescriptor: Int32 = -1, privateDescriptor: Int32 = -1, stageDescriptor: Int32 = -1
    defer {
      if stageDescriptor >= 0 { Darwin.close(stageDescriptor) }
      if privateDescriptor >= 0 { Darwin.close(privateDescriptor) }
      if rootDescriptor >= 0 { Darwin.close(rootDescriptor) }
    }
    func rootMatches() throws -> Bool {
      try directoryIdentity(descriptor: rootDescriptor) == rootToken
        && directoryIdentity(targetRoot) == rootToken && Self.canonical(targetRoot) == targetRoot
    }
    func privateMatches() throws -> Bool {
      var named = stat()
      return try rootMatches()
        && directoryIdentity(descriptor: privateDescriptor) == privateToken
        && Darwin.fstatat(rootDescriptor, name, &named, AT_SYMLINK_NOFOLLOW) == 0
        && named.st_mode & S_IFMT == S_IFDIR
        && "\(UInt64(named.st_dev)):\(UInt64(named.st_ino))" == privateToken
    }
    func stageMatches() throws -> Bool {
      var opened = stat(), named = stat()
      return try privateMatches()
        && Darwin.fstat(stageDescriptor, &opened) == 0 && opened.st_mode & S_IFMT == S_IFREG && opened.st_nlink == 1
        && "\(UInt64(opened.st_dev)):\(UInt64(opened.st_ino))" == stageToken
        && Darwin.fstatat(privateDescriptor, "stage", &named, AT_SYMLINK_NOFOLLOW) == 0
        && named.st_mode & S_IFMT == S_IFREG && named.st_nlink == 1
        && "\(UInt64(named.st_dev)):\(UInt64(named.st_ino))" == stageToken
    }
    func stageAbsent() -> Bool {
      var named = stat()
      return Darwin.fstatat(privateDescriptor, "stage", &named, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT
    }
    func namespaceAbsent() throws -> Bool {
      var named = stat()
      return try rootMatches()
        && Darwin.fstatat(rootDescriptor, name, &named, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT
    }
    func syncOwnedRoot() throws {
      guard try namespaceAbsent() else { throw installerError("Owned attachment namespace retirement is uncertain") }
      try faultInjector(.beforeOwnedPrivateRootSync)
      guard try namespaceAbsent(), Darwin.fsync(rootDescriptor) == 0, try namespaceAbsent() else {
        throw installerError("Could not confirm durable owned attachment namespace retirement")
      }
    }
    if owned {
      rootDescriptor = Darwin.open(targetRoot.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard rootDescriptor >= 0 else { throw installerError("Could not retain owned attachment root") }
      guard try rootMatches() else { return .conflict }
    }
    let privateKind = try nodeKind(privateDirectory)
    if privateKind == .missing {
      if owned { try syncOwnedRoot() }
      return .missing
    }
    guard let expectedDirectoryIdentity,
          try directoryIdentity(targetRoot) == expectedDirectoryIdentity,
          let expectedPrivateDirectoryIdentity, privateKind == .directory,
          try directoryIdentity(privateDirectory) == expectedPrivateDirectoryIdentity else { return .conflict }
    if owned {
      privateDescriptor = Darwin.openat(rootDescriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard privateDescriptor >= 0 else { throw installerError("Could not retain owned attachment private directory") }
      guard try privateMatches() else { return .conflict }
    }
    let missingStage: Bool
    switch try nodeKind(privateStage) {
    case .missing: missingStage = true
    case .regularFile: missingStage = false
    default: return .conflict
    }
    if !missingStage {
      guard let expectedStagedIdentity,
            identityToken(try publicationIdentity(privateStage)) == expectedStagedIdentity else { return .conflict }
      if owned {
        stageDescriptor = Darwin.openat(privateDescriptor, "stage", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard stageDescriptor >= 0 else { throw installerError("Could not retain owned attachment stage") }
        guard try stageMatches() else { return .conflict }
        try faultInjector(.beforeOwnedPrivateStageUnlink)
        guard try stageMatches() else { throw installerError("Owned attachment stage changed before retirement") }
        guard Darwin.unlinkat(privateDescriptor, "stage", 0) == 0 else { throw installerError("Could not retire owned attachment stage") }
        try faultInjector(.afterOwnedPrivateStageUnlink)
        guard try privateMatches(), stageAbsent(), Darwin.fsync(privateDescriptor) == 0 else {
          throw installerError("Could not sync owned attachment private directory")
        }
      } else {
        try delete(privateStage)
        try syncDirectory(privateDirectory)
      }
    }
    if owned {
      try faultInjector(.beforeOwnedPrivateNamespaceRetirement)
      guard try privateMatches(), stageAbsent() else { throw installerError("Owned attachment private directory changed before retirement") }
    }
    let removed = owned
      ? Darwin.unlinkat(rootDescriptor, name, AT_REMOVEDIR)
      : Darwin.rmdir(privateDirectory.path)
    guard removed == 0 else {
      throw installerError(missingStage
        ? "Could not remove empty private attachment publication directory"
        : "Could not remove private attachment publication directory")
    }
    if owned {
      try faultInjector(.afterOwnedPrivateNamespaceRetirement)
      try syncOwnedRoot()
    } else { try syncDirectory(targetRoot) }
    return missingStage ? .missing : .removed
  }

  private func identityToken(_ identity: PublicationIdentity) -> String {
    "\(identity.device):\(identity.inode)"
  }

  private func directoryIdentity(_ directory: URL) throws -> String {
    var value = stat()
    guard Darwin.lstat(directory.path, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else {
      throw installerError("File Sync attachment directory is unavailable")
    }
    return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
  }

  private func directoryIdentity(descriptor: Int32) throws -> String {
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else {
      throw installerError("File Sync attachment directory handle is unavailable")
    }
    return "\(UInt64(value.st_dev)):\(UInt64(value.st_ino))"
  }

  private struct PublicationIdentity: Equatable {
    let device: UInt64
    let inode: UInt64
    let size: Int64
    let modifiedSeconds: Int64
    let modifiedNanoseconds: Int64
    let changedSeconds: Int64
    let changedNanoseconds: Int64
  }

  private func publicationIdentity(_ file: URL) throws -> PublicationIdentity {
    var value = stat()
    guard Darwin.lstat(file.path, &value) == 0, value.st_mode & S_IFMT == S_IFREG else {
      throw installerError("Attachment path is not a regular file")
    }
    return PublicationIdentity(
      device: UInt64(value.st_dev),
      inode: UInt64(value.st_ino),
      size: Int64(value.st_size),
      modifiedSeconds: Int64(value.st_mtimespec.tv_sec),
      modifiedNanoseconds: Int64(value.st_mtimespec.tv_nsec),
      changedSeconds: Int64(value.st_ctimespec.tv_sec),
      changedNanoseconds: Int64(value.st_ctimespec.tv_nsec)
    )
  }

  private func publicationIdentity(descriptor: Int32) throws -> PublicationIdentity {
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFREG else {
      throw installerError("Attachment handle is not a regular file")
    }
    return PublicationIdentity(
      device: UInt64(value.st_dev),
      inode: UInt64(value.st_ino),
      size: Int64(value.st_size),
      modifiedSeconds: Int64(value.st_mtimespec.tv_sec),
      modifiedNanoseconds: Int64(value.st_mtimespec.tv_nsec),
      changedSeconds: Int64(value.st_ctimespec.tv_sec),
      changedNanoseconds: Int64(value.st_ctimespec.tv_nsec)
    )
  }

  private func sha256(descriptor: Int32) throws -> String {
    let duplicate = Darwin.dup(descriptor)
    guard duplicate >= 0 else {
      throw installerError("Could not duplicate attachment stage handle")
    }
    let input = FileHandle(fileDescriptor: duplicate, closeOnDealloc: true)
    defer { try? input.close() }
    var digest = SHA256()
    while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
      digest.update(data: data)
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func installWhenAbsent(
    staged: URL,
    target: URL,
    candidateSha256: String,
    artifacts: InstallArtifacts,
    retained: RetainedInstallDirectory? = nil
  ) throws -> AttachmentInstallOutcome {
    switch try nodeKind(target, retained: retained) {
    case .missing:
      try writeJournal(
        InstallJournal(
          targetPath: target.path,
          stagedPath: staged.path,
          candidateSha256: candidateSha256,
          expectedLocalSha256: nil,
          displacedSha256: nil,
          preservationPath: nil
        ),
        to: artifacts.journal,
        retained: retained
      )
      try faultInjector(.afterInitialJournal)
      guard try moveExclusive(from: artifacts.candidate, to: target, retained: retained) else {
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        try deleteJournal(artifacts.journal, retained: retained)
        return .conflict(preservedUrl: staged)
      }
      try syncDirectory(targetRoot, retained: retained)
      deleteStagedBestEffort(staged, expectedSha256: candidateSha256, retained: retained)
      try deleteJournal(artifacts.journal, retained: retained)
      return .installed(preservedUrl: nil)
    case .regularFile:
      if try sha256(target, retained: retained) != candidateSha256 {
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        return .conflict(preservedUrl: staged)
      }
      try deleteInternalIfRegular(artifacts.candidate, retained: retained)
      deleteStagedBestEffort(staged, expectedSha256: candidateSha256, retained: retained)
      return .installed(preservedUrl: nil)
    case .directory:
      throw installerError("Target attachment path is a directory")
    case .symbolicLink:
      throw installerError("Target attachment path is a symbolic link")
    case .other:
      throw installerError("Target attachment path is not a regular file")
    }
  }

  private func installWhenPresent(
    staged: URL,
    target: URL,
    expectedSha256: String,
    candidateSha256: String,
    artifacts: InstallArtifacts,
    retained: RetainedInstallDirectory? = nil
  ) throws -> AttachmentInstallOutcome {
    switch try nodeKind(target, retained: retained) {
    case .missing:
      return .conflict(preservedUrl: staged)
    case .regularFile:
      break
    case .directory:
      throw installerError("Target attachment path is a directory")
    case .symbolicLink:
      throw installerError("Target attachment path is a symbolic link")
    case .other:
      throw installerError("Target attachment path is not a regular file")
    }

    try writeJournal(
      InstallJournal(
        targetPath: target.path,
        stagedPath: staged.path,
        candidateSha256: candidateSha256,
        expectedLocalSha256: expectedSha256,
        displacedSha256: nil,
        preservationPath: nil
      ),
      to: artifacts.journal,
      retained: retained
    )
    try faultInjector(.afterInitialJournal)

    guard try moveExclusive(from: target, to: artifacts.quarantine, retained: retained) else {
      return .conflict(preservedUrl: firstPreservedUrl(artifacts.quarantine, staged, retained: retained))
    }
    try syncDirectory(targetRoot, retained: retained)

    let displacedSha256 = try sha256(artifacts.quarantine, retained: retained)
    try writeJournal(
      InstallJournal(
        targetPath: target.path,
        stagedPath: staged.path,
        candidateSha256: candidateSha256,
        expectedLocalSha256: expectedSha256,
        displacedSha256: displacedSha256,
        preservationPath: nil
      ),
      to: artifacts.journal,
      retained: retained
    )

    if displacedSha256 != expectedSha256 {
      if try moveExclusive(from: artifacts.quarantine, to: target, retained: retained) {
        try syncDirectory(targetRoot, retained: retained)
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        try deleteJournal(artifacts.journal, retained: retained)
        return .conflict(preservedUrl: staged)
      }
      return .conflict(preservedUrl: artifacts.quarantine)
    }

    guard try moveExclusive(from: artifacts.candidate, to: target, retained: retained) else {
      return .conflict(preservedUrl: artifacts.quarantine)
    }
    try syncDirectory(targetRoot, retained: retained)
    guard try sha256(target, retained: retained) == candidateSha256 else {
      return .conflict(preservedUrl: artifacts.quarantine)
    }

    let preservedUrl = try preserveQuarantine(
      artifacts: artifacts,
      journal: InstallJournal(
        targetPath: target.path,
        stagedPath: staged.path,
        candidateSha256: candidateSha256,
        expectedLocalSha256: expectedSha256,
        displacedSha256: displacedSha256,
        preservationPath: nil
      ),
      retained: retained
    )
    deleteStagedBestEffort(staged, expectedSha256: candidateSha256, retained: retained)
    try deleteJournal(artifacts.journal, retained: retained)
    return .installed(preservedUrl: preservedUrl)
  }

  private func recoverJournal(target: URL, artifacts: InstallArtifacts, retained: RetainedInstallDirectory? = nil) throws -> JournalRecovery {
    switch try nodeKind(artifacts.journal, retained: retained) {
    case .missing:
      return .proceed
    case .regularFile:
      let journal = try parseJournal(artifacts.journal, retained: retained)
      if let retained {
        _ = try validateRetainedJournal(journal, file: artifacts.journal, retained: retained)
        try normalizeRetainedJournalLinks(target: target, artifacts: artifacts, journal: journal, retained: retained)
      }
      return try recoverParsedJournal(
        target: target,
        artifacts: artifacts,
        journal: journal,
        retained: retained
      )
    case .directory:
      throw installerError("Attachment install journal is a directory")
    case .symbolicLink:
      throw installerError("Attachment install journal is a symbolic link")
    case .other:
      throw installerError("Attachment install journal is not a regular file")
    }
  }

  private func recoverParsedJournal(
    target: URL,
    artifacts: InstallArtifacts,
    journal: InstallJournal,
    retained: RetainedInstallDirectory? = nil
  ) throws -> JournalRecovery {
    let recordedTarget: URL
    if let retained {
      recordedTarget = try retainedJournalPath(journal.targetPath, retained: retained)
    } else {
      recordedTarget = Self.canonical(URL(fileURLWithPath: journal.targetPath))
    }
    guard recordedTarget == target else {
      throw installerError("Attachment install journal targets a different file")
    }
    let previousStaged: URL
    if let retained { previousStaged = try retainedJournalPath(journal.stagedPath, retained: retained) }
    else { previousStaged = Self.canonical(URL(fileURLWithPath: journal.stagedPath)) }
    try validateSourceContainment(previousStaged, retained: retained)

    let targetKind = try requireRecoverableNode(target, label: "journal target", retained: retained)
    _ = try requireRecoverableNode(artifacts.candidate, label: "journal candidate", retained: retained)
    let quarantineKind = try requireRecoverableNode(artifacts.quarantine, label: "journal quarantine", retained: retained)
    let preservation: URL? = try journal.preservationPath.map { path in
      let url = try retained.map { try self.retainedJournalPath(path, retained: $0) }
        ?? Self.canonical(URL(fileURLWithPath: path))
      try validatePreservationPath(url, artifacts: artifacts, retained: retained)
      _ = try requireRecoverableNode(url, label: "journal preservation", retained: retained)
      return url
    }

    if targetKind == .regularFile {
      let targetSha256 = try sha256(target, retained: retained)
      if targetSha256 == journal.candidateSha256 {
        let preservedUrl: URL?
        if journal.expectedLocalSha256 == nil {
          guard quarantineKind == .missing else {
            return .conflict(preservedUrl: artifacts.quarantine)
          }
          preservedUrl = nil
        } else {
          if quarantineKind == .missing && preservation == nil {
            return .conflict(preservedUrl: firstPreservedUrl(artifacts.candidate, previousStaged, retained: retained))
          }
          preservedUrl = try preserveQuarantine(artifacts: artifacts, journal: journal, retained: retained)
        }
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        deleteStagedBestEffort(previousStaged, expectedSha256: journal.candidateSha256, retained: retained)
        try deleteJournal(artifacts.journal, retained: retained)
        return .completed(stagedUrl: previousStaged, preservedUrl: preservedUrl)
      }

      if let expectedLocal = journal.expectedLocalSha256, targetSha256 == expectedLocal {
        if let preservation { return .conflict(preservedUrl: preservation) }
        if quarantineKind == .regularFile {
          guard try sha256(artifacts.quarantine, retained: retained) == expectedLocal else {
            return .conflict(preservedUrl: artifacts.quarantine)
          }
          // Equal bytes do not prove both names reference the same inode.
          // Preserve the active quarantine independently before retrying.
          _ = try preserveActiveQuarantine(artifacts, retained: retained)
        }
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        try deleteJournal(artifacts.journal, retained: retained)
        return .proceed
      }

      if journal.expectedLocalSha256 == nil {
        try deleteInternalIfRegular(artifacts.candidate, retained: retained)
        try deleteJournal(artifacts.journal, retained: retained)
        return .conflict(preservedUrl: previousStaged)
      }

      return .conflict(
        preservedUrl: firstPreservedUrl(artifacts.quarantine, artifacts.candidate, previousStaged, retained: retained)
      )
    }

    if quarantineKind == .regularFile, let expectedLocal = journal.expectedLocalSha256 {
      if try sha256(artifacts.quarantine, retained: retained) != expectedLocal {
        return .conflict(preservedUrl: artifacts.quarantine)
      }
      guard try moveExclusive(from: artifacts.quarantine, to: target, retained: retained) else {
        return .conflict(preservedUrl: artifacts.quarantine)
      }
      try syncDirectory(targetRoot, retained: retained)
      try deleteInternalIfRegular(artifacts.candidate, retained: retained)
      try deleteJournal(artifacts.journal, retained: retained)
      return .proceed
    }

    if journal.expectedLocalSha256 == nil && quarantineKind == .missing {
      try deleteInternalIfRegular(artifacts.candidate, retained: retained)
      try deleteJournal(artifacts.journal, retained: retained)
      return .proceed
    }

    return .conflict(
      preservedUrl: firstPreservedUrl(artifacts.quarantine, artifacts.candidate, previousStaged, artifacts.journal, retained: retained)
    )
  }

  private func preserveQuarantine(
    artifacts: InstallArtifacts,
    journal: InstallJournal,
    retained: RetainedInstallDirectory? = nil
  ) throws -> URL {
    var preserved = try journal.preservationPath.map { path -> URL in
      let url = try retained.map { try self.retainedJournalPath(path, retained: $0) }
        ?? Self.canonical(URL(fileURLWithPath: path))
      try validatePreservationPath(url, artifacts: artifacts, retained: retained)
      return url
    }
    if preserved == nil {
      preserved = try nextPreservationPath(artifacts, retained: retained)
      try writeJournal(
        InstallJournal(
          targetPath: journal.targetPath,
          stagedPath: journal.stagedPath,
          candidateSha256: journal.candidateSha256,
          expectedLocalSha256: journal.expectedLocalSha256,
          displacedSha256: journal.displacedSha256,
          preservationPath: preserved!.path
        ),
        to: artifacts.journal,
        retained: retained
      )
    }
    let preservedUrl = preserved!

    switch try nodeKind(preservedUrl, retained: retained) {
    case .missing:
      guard try nodeKind(artifacts.quarantine, retained: retained) == .regularFile else {
        throw installerError("Quarantined attachment generation is unavailable")
      }
      guard try moveExclusive(from: artifacts.quarantine, to: preservedUrl, retained: retained) else {
        throw installerError("Attachment preservation path already exists")
      }
      try syncDirectory(targetRoot, retained: retained)
    case .regularFile:
      if try nodeKind(artifacts.quarantine, retained: retained) == .regularFile {
        guard try sha256(artifacts.quarantine, retained: retained) == sha256(preservedUrl, retained: retained) else {
          throw installerError("Attachment preservation generations diverged")
        }
        // Equal bytes are not an inode-identity proof. Retain the active
        // quarantine under a fresh name before clearing its installer slot.
        _ = try preserveActiveQuarantine(artifacts, retained: retained)
      }
    case .directory:
      throw installerError("Attachment preservation path is a directory")
    case .symbolicLink:
      throw installerError("Attachment preservation path is a symbolic link")
    case .other:
      throw installerError("Attachment preservation path is not a regular file")
    }
    return preservedUrl
  }

  private func preserveActiveQuarantine(_ artifacts: InstallArtifacts, retained: RetainedInstallDirectory? = nil) throws -> URL {
    guard try nodeKind(artifacts.quarantine, retained: retained) == .regularFile else {
      throw installerError("Quarantined attachment generation is unavailable")
    }
    let freshPreservation = try nextPreservationPath(artifacts, retained: retained)
    guard try moveExclusive(from: artifacts.quarantine, to: freshPreservation, retained: retained) else {
      throw installerError("Attachment preservation path already exists")
    }
    try syncDirectory(targetRoot, retained: retained)
    return freshPreservation
  }

  private func nextPreservationPath(_ artifacts: InstallArtifacts, retained: RetainedInstallDirectory? = nil) throws -> URL {
    for attempt in 0..<10_000 {
      let candidate = targetRoot.appendingPathComponent("\(artifacts.preservationPrefix)\(attempt)")
      if try nodeKind(candidate, retained: retained) == .missing { return candidate }
    }
    throw installerError("No attachment preservation path is available")
  }

  private func validatePreservationPath(_ file: URL, artifacts: InstallArtifacts, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      let name = try retained.leaf(file)
      let suffix = String(name.dropFirst(artifacts.preservationPrefix.count))
      guard name.hasPrefix(artifacts.preservationPrefix), let index = Int(suffix),
        (0..<10_000).contains(index), String(index) == suffix else { throw installerError("Retained preservation path is invalid") }
      return
    }
    guard Self.canonical(file.deletingLastPathComponent()) == targetRoot,
          file.lastPathComponent.hasPrefix(artifacts.preservationPrefix)
    else {
      throw installerError("Attachment preservation path is outside the managed root")
    }
  }

  private func prepareCleanArtifacts(_ artifacts: InstallArtifacts, retained: RetainedInstallDirectory? = nil) throws {
    guard try nodeKind(artifacts.journal, retained: retained) == .missing else {
      throw installerError("Attachment install journal was not recovered")
    }
    switch try nodeKind(artifacts.quarantine, retained: retained) {
    case .missing:
      break
    case .regularFile:
      throw installerError("Unjournaled attachment quarantine is preserved at \(artifacts.quarantine.path)")
    case .directory:
      throw installerError("Attachment quarantine is a directory")
    case .symbolicLink:
      throw installerError("Attachment quarantine is a symbolic link")
    case .other:
      throw installerError("Attachment quarantine is not a regular file")
    }
    switch try nodeKind(artifacts.candidate, retained: retained) {
    case .missing:
      break
    case .regularFile:
      try deleteInternalIfRegular(artifacts.candidate, retained: retained)
    case .directory:
      throw installerError("Attachment candidate is a directory")
    case .symbolicLink:
      throw installerError("Attachment candidate is a symbolic link")
    case .other:
      throw installerError("Attachment candidate is not a regular file")
    }
  }

  private func artifacts(for target: URL) -> InstallArtifacts {
    let digest = Self.sha256(Data(target.path.utf8)).prefix(32)
    return InstallArtifacts(
      journal: targetRoot.appendingPathComponent("\(installerArtifactPrefix)\(digest).journal"),
      candidate: targetRoot.appendingPathComponent("\(installerArtifactPrefix)\(digest).candidate"),
      quarantine: targetRoot.appendingPathComponent("\(installerArtifactPrefix)\(digest).quarantine"),
      preservationPrefix: "\(installerPreservedPrefix)\(digest)-"
    )
  }

  private func validateTargetPath(_ target: URL, retained: RetainedInstallDirectory? = nil) throws {
    let name = target.lastPathComponent
    guard !name.hasPrefix(installerArtifactPrefix),
          !name.hasPrefix(installerPreservedPrefix),
          name != installerLockName else {
      throw installerError("Target attachment name is reserved")
    }
    let parent: URL
    if let retained {
      _ = try retained.leaf(target)
      parent = target.deletingLastPathComponent()
    } else { parent = Self.canonical(target.deletingLastPathComponent()) }
    guard parent == targetRoot else {
      throw installerError("Target attachment is outside the managed attachment root")
    }
    try requireDirectory(parent, label: "target attachment parent", retained: retained)
  }

  private func validateSourcePath(_ staged: URL, retained: RetainedInstallDirectory? = nil) throws {
    try validateSourceContainment(staged, retained: retained)
    try requireRegularFile(staged, label: "staged attachment", retained: retained)
  }

  private func validateSourceContainment(_ staged: URL, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      let name = try retained.leaf(staged)
      guard name.hasPrefix(".mindwtr-download-"), name.hasSuffix(".staged") else {
        throw installerError("Retained provider stage name is invalid")
      }
      return
    }
    guard sourceRoots.contains(where: { staged == $0 || isDescendant(staged, of: $0) }) else {
      throw installerError("Staged attachment is outside app-private managed roots")
    }
  }

  private func isDescendant(_ file: URL, of root: URL) -> Bool {
    let fileComponents = file.pathComponents
    let rootComponents = root.pathComponents
    return fileComponents.count > rootComponents.count
      && fileComponents.starts(with: rootComponents)
  }

  private func ensureDirectory(_ directory: URL, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      guard directory.path.utf8.elementsEqual(retained.root.path.utf8),
        try nodeKind(directory, retained: retained) == .directory else { throw installerError("Retained attachment directory is unavailable") }
      return
    }
    if try nodeKind(directory, retained: retained) == .missing {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
  }

  private func requireDirectory(_ file: URL, label: String, retained: RetainedInstallDirectory? = nil) throws {
    switch try nodeKind(file, retained: retained) {
    case .directory:
      return
    case .symbolicLink:
      throw installerError("\(label) is a symbolic link")
    default:
      throw installerError("\(label) is unavailable")
    }
  }

  private func requireRegularFile(_ file: URL, label: String, retained: RetainedInstallDirectory? = nil) throws {
    if let retained, let value = try retainedNode(file, retained: retained) {
      guard value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1 else { throw installerError("Retained attachment entry is unsafe") }
      return
    }
    switch try nodeKind(file, retained: retained) {
    case .regularFile:
      return
    case .missing:
      throw installerError("\(label) is missing")
    case .directory:
      throw installerError("\(label) is a directory")
    case .symbolicLink:
      throw installerError("\(label) is a symbolic link")
    case .other:
      throw installerError("\(label) is not a regular file")
    }
  }

  private func rejectSymlinkInput(_ file: URL, label: String, retained: RetainedInstallDirectory? = nil) throws {
    if try nodeKind(file.standardizedFileURL, retained: retained) == .symbolicLink {
      throw installerError("\(label) is a symbolic link")
    }
  }

  private func requireRecoverableNode(_ file: URL, label: String, retained: RetainedInstallDirectory? = nil) throws -> InstallerNodeKind {
    let kind = try nodeKind(file, retained: retained)
    switch kind {
    case .missing, .regularFile:
      return kind
    case .directory:
      throw installerError("\(label) is a directory")
    case .symbolicLink:
      throw installerError("\(label) is a symbolic link")
    case .other:
      throw installerError("\(label) is not a regular file")
    }
  }

  private func nodeKind(_ file: URL, retained: RetainedInstallDirectory? = nil) throws -> InstallerNodeKind {
    var info = stat()
    if let retained {
      guard let value = try retainedNode(file, retained: retained) else { return .missing }
      info = value
    } else if Darwin.lstat(file.path, &info) != 0 {
      if errno == ENOENT { return .missing }
      throw installerError("Could not inspect \(file.path)")
    }
    switch info.st_mode & S_IFMT {
    case S_IFREG: return .regularFile
    case S_IFDIR: return .directory
    case S_IFLNK: return .symbolicLink
    default: return .other
    }
  }

  private func copySnapshot(from source: URL, to destination: URL, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      try copyRetainedSnapshot(from: source, to: destination, retained: retained)
      return
    }
    let descriptor = Darwin.open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw installerError("Installer candidate already exists")
    }
    let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)

    do {
      let input = try openRegularFileForReading(source, retained: retained)
      defer {
        try? input.close()
        try? output.close()
      }
      while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
        try output.write(contentsOf: data)
      }
      try output.synchronize()
      try syncDirectory(targetRoot, retained: retained)
    } catch {
      try? delete(destination, retained: retained)
      throw installerError("Could not snapshot staged attachment", underlying: error)
    }
  }

  private func sha256(_ file: URL, retained: RetainedInstallDirectory? = nil) throws -> String {
    let input = try openRegularFileForReading(file, retained: retained)
    defer { try? input.close() }
    let before = try retained.map { _ in try publicationIdentity(descriptor: input.fileDescriptor) }
    var digest = SHA256()
    while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
      digest.update(data: data)
    }
    if let retained, let before {
      try retained.requireAuthority()
      guard try retainedFileMatches(input.fileDescriptor, parent: retained.descriptor, name: retained.leaf(file), expected: before) else {
        throw installerError("Retained attachment changed while hashing")
      }
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func openRegularFileForReading(_ file: URL, retained: RetainedInstallDirectory? = nil) throws -> FileHandle {
    let descriptor: Int32
    if let retained {
      try retained.requireAuthority()
      descriptor = Darwin.openat(retained.descriptor, try retained.leaf(file), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    } else { descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW) }
    guard descriptor >= 0 else {
      throw installerError("Could not open regular attachment file")
    }
    var info = stat()
    guard Darwin.fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
      retained == nil || info.st_nlink == 1 && info.st_size >= 0 else {
      Darwin.close(descriptor)
      throw installerError("Attachment path is not a regular file")
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func moveExclusive(from source: URL, to destination: URL, retained: RetainedInstallDirectory? = nil) throws -> Bool {
    if let retained {
      return try moveRetainedExclusive(from: source, to: destination, retained: retained)
    }
    let result = source.path.withCString { sourcePath in
      destination.path.withCString { destinationPath in
        Darwin.link(sourcePath, destinationPath)
      }
    }
    if result != 0 {
      if errno == EEXIST { return false }
      throw installerError("Could not publish attachment generation")
    }
    try faultInjector(.afterExclusiveLink)
    guard Darwin.unlink(source.path) == 0 else {
      throw installerError("Published attachment generation could not release its old path")
    }
    return true
  }

  private func delete(_ file: URL, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      guard let named = try retainedNode(file, retained: retained) else { return }
      guard named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1 else { throw installerError("Retained attachment retirement entry is unsafe") }
      let handle = try openRegularFileForReading(file, retained: retained)
      defer { try? handle.close() }
      let identity = try publicationIdentity(descriptor: handle.fileDescriptor)
      try retained.requireAuthority()
      guard try retainedFileMatches(handle.fileDescriptor, parent: retained.descriptor, name: retained.leaf(file), expected: identity),
        Darwin.unlinkat(retained.descriptor, try retained.leaf(file), 0) == 0 else {
        throw installerError("Could not retire retained attachment entry")
      }
      return
    }
    if Darwin.unlink(file.path) != 0, errno != ENOENT {
      throw installerError("Could not remove installer artifact")
    }
  }

  private func writeJournal(_ journal: InstallJournal, to file: URL, retained: RetainedInstallDirectory? = nil) throws {
    let object: [String: Any] = [
      "version": 2,
      "targetPath": journal.targetPath,
      "stagedPath": journal.stagedPath,
      "candidateSha256": journal.candidateSha256,
      "expectedLocalSha256": journal.expectedLocalSha256 ?? NSNull(),
      "displacedSha256": journal.displacedSha256 ?? NSNull(),
      "preservationPath": journal.preservationPath ?? NSNull(),
    ]
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    if let retained {
      try writeRetainedJournal(journal, data: data, to: file, retained: retained)
      return
    }
    let temporary = file.appendingPathExtension("write-\(UUID().uuidString)")
    do {
      try data.write(to: temporary, options: [.withoutOverwriting])
      let handle = try FileHandle(forWritingTo: temporary)
      try handle.synchronize()
      try handle.close()
      guard Darwin.rename(temporary.path, file.path) == 0 else {
        throw installerError("Could not replace attachment install journal")
      }
      try syncDirectory(targetRoot, retained: retained)
    } catch {
      try? delete(temporary, retained: retained)
      throw installerError("Could not persist attachment install journal", underlying: error)
    }
  }

  private func parseJournal(_ file: URL, retained: RetainedInstallDirectory? = nil) throws -> InstallJournal {
    let data: Data
    if let retained { data = try readRetainedData(file, retained: retained, maximumBytes: 64 * 1024) }
    else { data = try Data(contentsOf: file) }
    let value = try JSONSerialization.jsonObject(with: data)
    guard let object = value as? [String: Any] else {
      throw installerError("Attachment install journal is malformed")
    }
    let expectedKeys: Set<String> = [
      "version", "targetPath", "stagedPath", "candidateSha256",
      "expectedLocalSha256", "displacedSha256", "preservationPath",
    ]
    guard Set(object.keys) == expectedKeys, object["version"] as? Int == 2,
          let targetPath = object["targetPath"] as? String,
          let stagedPath = object["stagedPath"] as? String,
          let candidateSha256 = object["candidateSha256"] as? String,
          isSha256(candidateSha256)
    else {
      throw installerError("Attachment install journal fields are invalid")
    }
    let expectedLocalSha256 = object["expectedLocalSha256"] as? String
    let displacedSha256 = object["displacedSha256"] as? String
    let preservationPath = object["preservationPath"] as? String
    if retained != nil {
      guard ["expectedLocalSha256", "displacedSha256", "preservationPath"].allSatisfy({ object[$0] is NSNull || object[$0] is String }) else {
        throw installerError("Retained attachment journal field types are invalid")
      }
    }
    if let expectedLocalSha256, !isSha256(expectedLocalSha256) {
      throw installerError("Attachment install journal expected-local hash is invalid")
    }
    if let displacedSha256, !isSha256(displacedSha256) {
      throw installerError("Attachment install journal displaced hash is invalid")
    }
    return InstallJournal(
      targetPath: targetPath,
      stagedPath: stagedPath,
      candidateSha256: candidateSha256,
      expectedLocalSha256: expectedLocalSha256,
      displacedSha256: displacedSha256,
      preservationPath: preservationPath
    )
  }

  private func deleteInternalIfRegular(_ file: URL, retained: RetainedInstallDirectory? = nil) throws {
    switch try nodeKind(file, retained: retained) {
    case .missing:
      return
    case .regularFile:
      try delete(file, retained: retained)
      try syncDirectory(targetRoot, retained: retained)
    case .directory:
      throw installerError("Installer artifact is a directory")
    case .symbolicLink:
      throw installerError("Installer artifact is a symbolic link")
    case .other:
      throw installerError("Installer artifact is not a regular file")
    }
  }

  private func deleteJournal(_ file: URL, retained: RetainedInstallDirectory? = nil) throws {
    try deleteInternalIfRegular(file, retained: retained)
  }

  private func deleteStagedBestEffort(_ staged: URL, expectedSha256: String? = nil, retained: RetainedInstallDirectory? = nil) {
    do {
      if let retained {
        try retireRetainedStage(staged, expectedSha256: expectedSha256, retained: retained)
        return
      }
      guard try nodeKind(staged, retained: retained) == .regularFile else { return }
      if let expectedSha256, try sha256(staged, retained: retained) != expectedSha256 { return }
      try delete(staged, retained: retained)
      try syncDirectory(staged.deletingLastPathComponent(), retained: retained)
    } catch {


    }
  }

  private func firstPreservedUrl(_ urls: URL..., retained: RetainedInstallDirectory? = nil) -> URL {
    for url in urls where (try? nodeKind(url, retained: retained)) == .regularFile {
      return url
    }
    return urls[0]
  }

  private func syncDirectory(_ directory: URL, retained: RetainedInstallDirectory? = nil) throws {
    if let retained {
      guard directory.path.utf8.elementsEqual(retained.root.path.utf8) else { throw installerError("Retained durability path is outside the managed root") }
      try retained.requireAuthority()
      guard Darwin.fsync(retained.descriptor) == 0 else { throw installerError("Could not sync retained attachment directory") }
      try retained.requireAuthority()
      return
    }
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else {
      throw installerError("Could not open attachment directory for durability")
    }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw installerError("Could not sync attachment directory")
    }
  }

  private func withExclusiveLock<T>(_ lockUrl: URL, _ action: () throws -> T) throws -> T {
    let descriptor = Darwin.open(lockUrl.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw installerError("Could not open attachment installer lock")
    }
    defer { Darwin.close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else {
      throw installerError("Could not acquire attachment installer lock")
    }
    defer { _ = flock(descriptor, LOCK_UN) }
    return try action()
  }

  private static func canonical(_ url: URL) -> URL {
    url.standardizedFileURL.resolvingSymlinksInPath()
  }
}

#if canImport(ExpoModulesCore)
public final class AttachmentFileInstallerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AttachmentFileInstaller")

    AsyncFunction("installAsync") {
        (
          stagedPath: String,
          targetPath: String,
          expected: [String: String],
          expectedDownloadSha256: String
        ) -> [String: String] in
      let fileManager = FileManager.default
      guard
        let documentsRoot = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first,
        let cacheRoot = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
      else {
        throw installerError("App-private storage roots are unavailable")
      }
      let targetRoot = documentsRoot.appendingPathComponent("attachments", isDirectory: true)
      let engine = try AttachmentFileInstaller(
        targetRoot: targetRoot,
        sourceRoots: [documentsRoot, cacheRoot, fileManager.temporaryDirectory]
      )
      let outcome = try engine.install(
        stagedInput: try Self.fileUrl(stagedPath),
        targetInput: try Self.fileUrl(targetPath),
        expected: try Self.parseExpected(expected),
        expectedDownloadSha256: try Self.parseSha256(expectedDownloadSha256, label: "Expected download")
      )
      switch outcome {
      case .installed(let preservedUrl):
        var result = ["status": "installed"]
        if let preservedUrl { result["preservedPath"] = preservedUrl.absoluteString }
        return result
      case .conflict(let preservedUrl):
        return ["status": "conflict", "preservedPath": preservedUrl.absoluteString]
      }
    }

    AsyncFunction("publishImmutableAsync") {
        (
          stagedPath: String,
          targetPath: String,
          expectedStagedSha256: String,
          expectedStagedIdentity: String,
          expectedDirectoryIdentity: String,
          expectedPrivateDirectoryIdentity: String
        ) -> [String: String] in
      let staged = try Self.fileUrl(stagedPath)
      let target = try Self.fileUrl(targetPath)
      let targetRoot = target.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
      let stagedRoot = staged.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
      guard stagedRoot.deletingLastPathComponent() == targetRoot else {
        throw installerError("Immutable attachment stage must use a private child of the target directory")
      }
      let outcome = try AttachmentFileInstallerEngine(
        targetRoot: targetRoot,
        sourceRoots: [targetRoot]
      ).publishImmutable(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: try Self.parseSha256(
          expectedStagedSha256,
          label: "Expected staged attachment"
        ),
        expectedStagedIdentity: expectedStagedIdentity,
        expectedDirectoryIdentity: expectedDirectoryIdentity,
        expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity
      )
      switch outcome {
      case .published:
        return ["status": "published"]
      case .alreadyExists:
        return ["status": "alreadyExists"]
      }
    }

    AsyncFunction("prepareImmutableStageAsync") {
        (targetPath: String, operationId: String) -> [String: String] in
      let target = try Self.fileUrl(targetPath)
      let targetRoot = target.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
      let prepared = try AttachmentFileInstallerEngine(
        targetRoot: targetRoot,
        sourceRoots: [targetRoot]
      ).prepareImmutableStage(targetInput: target, operationId: operationId)
      return [
        "stagedPath": prepared.stagedUrl.absoluteString,
        "stagedIdentity": prepared.stagedIdentity,
        "directoryIdentity": prepared.directoryIdentity,
        "privateDirectoryIdentity": prepared.privateDirectoryIdentity,
      ]
    }

    AsyncFunction("snapshotImmutableStageAsync") {
        (
          stagedPath: String,
          targetPath: String,
          expectedStagedSha256: String
        ) -> [String: String] in
      let staged = try Self.fileUrl(stagedPath)
      let target = try Self.fileUrl(targetPath)
      let targetRoot = target.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
      let identity = try AttachmentFileInstallerEngine(
        targetRoot: targetRoot,
        sourceRoots: [targetRoot]
      ).snapshotImmutableStage(
        stagedInput: staged,
        targetInput: target,
        expectedStagedSha256: try Self.parseSha256(expectedStagedSha256, label: "Expected staged attachment")
      )
      return [
        "stagedIdentity": identity.stagedIdentity,
        "directoryIdentity": identity.directoryIdentity,
      ]
    }

    AsyncFunction("cleanupImmutableStageAsync") {
        (
          stagedPath: String,
          targetPath: String,
          operationId: String,
          expectedStagedSha256: String?,
          expectedStagedIdentity: String?,
          expectedDirectoryIdentity: String?,
          expectedPrivateDirectoryIdentity: String?
        ) -> [String: String] in
      let staged = try Self.fileUrl(stagedPath)
      let target = try Self.fileUrl(targetPath)
      let targetRoot = target.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
      let outcome = try AttachmentFileInstallerEngine(
        targetRoot: targetRoot,
        sourceRoots: [targetRoot]
      ).cleanupImmutableStage(
        stagedInput: staged,
        targetInput: target,
        operationId: operationId,
        expectedStagedSha256: expectedStagedSha256,
        expectedStagedIdentity: expectedStagedIdentity,
        expectedDirectoryIdentity: expectedDirectoryIdentity,
        expectedPrivateDirectoryIdentity: expectedPrivateDirectoryIdentity
      )
      switch outcome {
      case .removed: return ["status": "removed"]
      case .missing: return ["status": "missing"]
      case .conflict: return ["status": "conflict"]
      }
    }

    AsyncFunction("hashAsync") { (targetPath: String) -> [String: Any] in
      let fileManager = FileManager.default
      guard let documentsRoot = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
        throw installerError("App-private storage root is unavailable")
      }
      let snapshot = try AttachmentFileInstaller(
        targetRoot: documentsRoot.appendingPathComponent("attachments", isDirectory: true),
        sourceRoots: []
      ).hash(try Self.fileUrl(targetPath))
      return [
        "sha256": snapshot.sha256,
        "size": Double(snapshot.size),
        "modificationTimeMs": snapshot.modificationTimeMs,
      ]
    }
  }

  private static func fileUrl(_ value: String) throws -> URL {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { throw installerError("Attachment path is required") }
    if let parsed = URL(string: normalized), parsed.scheme != nil {
      guard parsed.isFileURL else {
        throw installerError("Only app-private file paths are supported")
      }
      return parsed
    }
    return URL(fileURLWithPath: normalized)
  }

  private static func parseExpected(_ value: [String: String]) throws -> ExpectedAttachmentGeneration {
    switch value["kind"] {
    case "absent":
      return .absent
    case "present":
      let digest = try parseSha256(value["sha256"] ?? "", label: "Expected attachment")
      return .present(sha256: digest)
    default:
      throw installerError("Expected attachment generation is invalid")
    }
  }

  private static func parseSha256(_ value: String, label: String) throws -> String {
    try parseInstallerSha256(value, label: label)
  }
}
#endif
