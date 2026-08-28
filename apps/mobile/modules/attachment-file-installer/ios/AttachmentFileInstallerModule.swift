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

// Immutable publication protects against crashes and cooperating Mindwtr
// writers by retaining a private namespace and exact descriptors. A malicious
// same-UID process that can bypass that private directory is outside the model;
// ambiguous provider or identity behavior remains fail-closed.

private enum InstallerNodeKind {
  case missing
  case regularFile
  case directory
  case symbolicLink
  case other
}

enum ExpectedAttachmentGeneration {
  case absent
  case present(sha256: String)
}

enum AttachmentInstallOutcome {
  case installed(preservedUrl: URL?)
  case conflict(preservedUrl: URL)
}

enum ImmutableAttachmentPublishOutcome {
  case published
  case alreadyExists
}

struct ImmutableAttachmentStageIdentity {
  let stagedIdentity: String
  let directoryIdentity: String
}

struct ImmutableAttachmentPreparedStage {
  let stagedUrl: URL
  let stagedIdentity: String
  let directoryIdentity: String
  let privateDirectoryIdentity: String
}

enum ImmutableAttachmentStageCleanupOutcome {
  case removed
  case missing
  case conflict
}

struct AttachmentFileHashSnapshot {
  let sha256: String
  let size: UInt64
  let modificationTimeMs: Double
}

/** Native streaming verifier for the managed canonical attachment generation.
 * It shares the installer lock and binds the digest to the same named inode
 * before and after consumption. */
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
    guard Darwin.flock(descriptor, LOCK_EX) == 0 else {
      throw installerError("Could not acquire attachment installer lock")
    }
    defer { _ = Darwin.flock(descriptor, LOCK_UN) }
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

// Deterministic crash boundaries for the native recovery test target. The app
// always uses the default no-op injector.
enum AttachmentFileInstallerFaultPoint: Equatable {
  case afterInitialJournal
  case afterExclusiveLink
  case beforeImmutablePublication
}

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
      try self.requireDirectory(self.targetRoot, label: "managed attachment root")
      try self.rejectSymlinkInput(stagedInput, label: "staged attachment")
      try self.rejectSymlinkInput(targetInput, label: "target attachment")
      try self.validateTargetPath(target)
      try self.validateSourcePath(staged)

      let artifacts = self.artifacts(for: target)
      switch try self.recoverJournal(target: target, artifacts: artifacts) {
      case .completed(let previousStaged, let preservedUrl) where previousStaged == staged:
        return .installed(preservedUrl: preservedUrl)
      case .conflict(let preservedUrl):
        return .conflict(preservedUrl: preservedUrl)
      case .completed, .proceed:
        break
      }

      try self.prepareCleanArtifacts(artifacts)
      try self.requireRegularFile(staged, label: "staged attachment")
      try self.copySnapshot(from: staged, to: artifacts.candidate)
      let candidateSha256 = try self.sha256(artifacts.candidate)
      guard candidateSha256 == expectedDownloadSha256 else {
        try self.deleteInternalIfRegular(artifacts.candidate)
        throw installerError("Staged attachment changed before native snapshot")
      }
      switch expected {
      case .absent:
        return try self.installWhenAbsent(
          staged: staged,
          target: target,
          candidateSha256: candidateSha256,
          artifacts: artifacts
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
          artifacts: artifacts
        )
      }
    }
  }

  /** File Sync create-no-replace publication without putting the managed-local
   * installer's journal/candidate/quarantine artifacts in the shared folder.
   * Exact scratch ownership and restart recovery are device-local in JS. */
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
        of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate$",
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
    guard operationId.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
      throw installerError("Attachment publication operation id is invalid")
    }
    let privateDirectory = targetRoot.appendingPathComponent(
      "\(installerArtifactPrefix)\(operationId).candidate",
      isDirectory: true
    )
    let privateStage = privateDirectory.appendingPathComponent("stage")
    let isPrivateStage = Self.canonical(stagedInput) == Self.canonical(privateStage)
    guard isPrivateStage || stagedInput.lastPathComponent == ".mindwtr-generation-stage-\(operationId).tmp" else {
      throw installerError("Attachment publication stage name is invalid")
    }
    try validateImmutableRecoveryPaths(stagedInput: stagedInput, targetInput: targetInput)
    let quarantine = targetRoot.appendingPathComponent(
      "\(installerArtifactPrefix)\(operationId).quarantine",
      isDirectory: true
    )
    let quarantinedStage = quarantine.appendingPathComponent("stage")
    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "File Sync attachment directory")
      if isPrivateStage {
        if try self.nodeKind(privateDirectory) == .missing { return .missing }
        guard
          let expectedDirectoryIdentity,
          try self.directoryIdentity(self.targetRoot) == expectedDirectoryIdentity,
          let expectedPrivateDirectoryIdentity,
          try self.nodeKind(privateDirectory) == .directory,
          try self.directoryIdentity(privateDirectory) == expectedPrivateDirectoryIdentity
        else {
          return .conflict
        }
        switch try self.nodeKind(privateStage) {
        case .missing:
          guard Darwin.rmdir(privateDirectory.path) == 0 else {
            throw installerError("Could not remove empty private attachment publication directory")
          }
          try self.syncDirectory(self.targetRoot)
          return .missing
        case .regularFile:
          break
        default:
          return .conflict
        }
        guard
          let expectedStagedIdentity,
          self.identityToken(try self.publicationIdentity(privateStage)) == expectedStagedIdentity
        else {
          return .conflict
        }
        try self.delete(privateStage)
        try self.syncDirectory(privateDirectory)
        guard Darwin.rmdir(privateDirectory.path) == 0 else {
          throw installerError("Could not remove private attachment publication directory")
        }
        try self.syncDirectory(self.targetRoot)
        return .removed
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

  private func validateImmutableRecoveryPaths(stagedInput: URL, targetInput: URL) throws {
    try ensureDirectory(targetRoot)
    try requireDirectory(targetRoot, label: "File Sync attachment directory")
    try rejectSymlinkInput(stagedInput, label: "staged attachment")
    try rejectSymlinkInput(targetInput, label: "target attachment")
    let staged = Self.canonical(stagedInput)
    let target = Self.canonical(targetInput)
    let stagedParent = staged.deletingLastPathComponent()
    let privateStage = staged.lastPathComponent == "stage"
      && stagedParent.deletingLastPathComponent() == targetRoot
      && stagedParent.lastPathComponent.range(
        of: "^\\.mindwtr-install-[a-f0-9]{32}\\.candidate$",
        options: .regularExpression
      ) != nil
    guard
      privateStage || stagedParent == targetRoot,
      target.deletingLastPathComponent() == targetRoot,
      staged != target
    else {
      throw installerError("Immutable attachment recovery paths escape the target directory")
    }
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
    artifacts: InstallArtifacts
  ) throws -> AttachmentInstallOutcome {
    switch try nodeKind(target) {
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
        to: artifacts.journal
      )
      try faultInjector(.afterInitialJournal)
      guard try moveExclusive(from: artifacts.candidate, to: target) else {
        try deleteInternalIfRegular(artifacts.candidate)
        try deleteJournal(artifacts.journal)
        return .conflict(preservedUrl: staged)
      }
      try syncDirectory(targetRoot)
      deleteStagedBestEffort(staged, expectedSha256: candidateSha256)
      try deleteJournal(artifacts.journal)
      return .installed(preservedUrl: nil)
    case .regularFile:
      if try sha256(target) != candidateSha256 {
        try deleteInternalIfRegular(artifacts.candidate)
        return .conflict(preservedUrl: staged)
      }
      try deleteInternalIfRegular(artifacts.candidate)
      deleteStagedBestEffort(staged, expectedSha256: candidateSha256)
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
    artifacts: InstallArtifacts
  ) throws -> AttachmentInstallOutcome {
    switch try nodeKind(target) {
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
      to: artifacts.journal
    )
    try faultInjector(.afterInitialJournal)

    guard try moveExclusive(from: target, to: artifacts.quarantine) else {
      return .conflict(preservedUrl: firstPreservedUrl(artifacts.quarantine, staged))
    }
    try syncDirectory(targetRoot)

    let displacedSha256 = try sha256(artifacts.quarantine)
    try writeJournal(
      InstallJournal(
        targetPath: target.path,
        stagedPath: staged.path,
        candidateSha256: candidateSha256,
        expectedLocalSha256: expectedSha256,
        displacedSha256: displacedSha256,
        preservationPath: nil
      ),
      to: artifacts.journal
    )

    if displacedSha256 != expectedSha256 {
      if try moveExclusive(from: artifacts.quarantine, to: target) {
        try syncDirectory(targetRoot)
        try deleteInternalIfRegular(artifacts.candidate)
        try deleteJournal(artifacts.journal)
        return .conflict(preservedUrl: staged)
      }
      return .conflict(preservedUrl: artifacts.quarantine)
    }

    guard try moveExclusive(from: artifacts.candidate, to: target) else {
      return .conflict(preservedUrl: artifacts.quarantine)
    }
    try syncDirectory(targetRoot)
    guard try sha256(target) == candidateSha256 else {
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
      )
    )
    deleteStagedBestEffort(staged, expectedSha256: candidateSha256)
    try deleteJournal(artifacts.journal)
    return .installed(preservedUrl: preservedUrl)
  }

  private func recoverJournal(target: URL, artifacts: InstallArtifacts) throws -> JournalRecovery {
    switch try nodeKind(artifacts.journal) {
    case .missing:
      return .proceed
    case .regularFile:
      return try recoverParsedJournal(
        target: target,
        artifacts: artifacts,
        journal: parseJournal(artifacts.journal)
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
    journal: InstallJournal
  ) throws -> JournalRecovery {
    guard Self.canonical(URL(fileURLWithPath: journal.targetPath)) == target else {
      throw installerError("Attachment install journal targets a different file")
    }
    let previousStaged = Self.canonical(URL(fileURLWithPath: journal.stagedPath))
    try validateSourceContainment(previousStaged)

    let targetKind = try requireRecoverableNode(target, label: "journal target")
    _ = try requireRecoverableNode(artifacts.candidate, label: "journal candidate")
    let quarantineKind = try requireRecoverableNode(artifacts.quarantine, label: "journal quarantine")
    let preservation: URL? = try journal.preservationPath.map { path in
      let url = Self.canonical(URL(fileURLWithPath: path))
      try validatePreservationPath(url, artifacts: artifacts)
      _ = try requireRecoverableNode(url, label: "journal preservation")
      return url
    }

    if targetKind == .regularFile {
      let targetSha256 = try sha256(target)
      if targetSha256 == journal.candidateSha256 {
        let preservedUrl: URL?
        if journal.expectedLocalSha256 == nil {
          guard quarantineKind == .missing else {
            return .conflict(preservedUrl: artifacts.quarantine)
          }
          preservedUrl = nil
        } else {
          if quarantineKind == .missing && preservation == nil {
            return .conflict(preservedUrl: firstPreservedUrl(artifacts.candidate, previousStaged))
          }
          preservedUrl = try preserveQuarantine(artifacts: artifacts, journal: journal)
        }
        try deleteInternalIfRegular(artifacts.candidate)
        deleteStagedBestEffort(previousStaged, expectedSha256: journal.candidateSha256)
        try deleteJournal(artifacts.journal)
        return .completed(stagedUrl: previousStaged, preservedUrl: preservedUrl)
      }

      if let expectedLocal = journal.expectedLocalSha256, targetSha256 == expectedLocal {
        if let preservation { return .conflict(preservedUrl: preservation) }
        if quarantineKind == .regularFile {
          guard try sha256(artifacts.quarantine) == expectedLocal else {
            return .conflict(preservedUrl: artifacts.quarantine)
          }
          // Equal bytes do not prove both names reference the same inode.
          // Preserve the active quarantine independently before retrying.
          _ = try preserveActiveQuarantine(artifacts)
        }
        try deleteInternalIfRegular(artifacts.candidate)
        try deleteJournal(artifacts.journal)
        return .proceed
      }

      if journal.expectedLocalSha256 == nil {
        try deleteInternalIfRegular(artifacts.candidate)
        try deleteJournal(artifacts.journal)
        return .conflict(preservedUrl: previousStaged)
      }

      return .conflict(
        preservedUrl: firstPreservedUrl(artifacts.quarantine, artifacts.candidate, previousStaged)
      )
    }

    if quarantineKind == .regularFile, let expectedLocal = journal.expectedLocalSha256 {
      if try sha256(artifacts.quarantine) != expectedLocal {
        return .conflict(preservedUrl: artifacts.quarantine)
      }
      guard try moveExclusive(from: artifacts.quarantine, to: target) else {
        return .conflict(preservedUrl: artifacts.quarantine)
      }
      try syncDirectory(targetRoot)
      try deleteInternalIfRegular(artifacts.candidate)
      try deleteJournal(artifacts.journal)
      return .proceed
    }

    if journal.expectedLocalSha256 == nil && quarantineKind == .missing {
      try deleteInternalIfRegular(artifacts.candidate)
      try deleteJournal(artifacts.journal)
      return .proceed
    }

    return .conflict(
      preservedUrl: firstPreservedUrl(artifacts.quarantine, artifacts.candidate, previousStaged, artifacts.journal)
    )
  }

  private func preserveQuarantine(
    artifacts: InstallArtifacts,
    journal: InstallJournal
  ) throws -> URL {
    var preserved = try journal.preservationPath.map { path -> URL in
      let url = Self.canonical(URL(fileURLWithPath: path))
      try validatePreservationPath(url, artifacts: artifacts)
      return url
    }
    if preserved == nil {
      preserved = try nextPreservationPath(artifacts)
      try writeJournal(
        InstallJournal(
          targetPath: journal.targetPath,
          stagedPath: journal.stagedPath,
          candidateSha256: journal.candidateSha256,
          expectedLocalSha256: journal.expectedLocalSha256,
          displacedSha256: journal.displacedSha256,
          preservationPath: preserved!.path
        ),
        to: artifacts.journal
      )
    }
    let preservedUrl = preserved!

    switch try nodeKind(preservedUrl) {
    case .missing:
      guard try nodeKind(artifacts.quarantine) == .regularFile else {
        throw installerError("Quarantined attachment generation is unavailable")
      }
      guard try moveExclusive(from: artifacts.quarantine, to: preservedUrl) else {
        throw installerError("Attachment preservation path already exists")
      }
      try syncDirectory(targetRoot)
    case .regularFile:
      if try nodeKind(artifacts.quarantine) == .regularFile {
        guard try sha256(artifacts.quarantine) == sha256(preservedUrl) else {
          throw installerError("Attachment preservation generations diverged")
        }
        // Equal bytes are not an inode-identity proof. Retain the active
        // quarantine under a fresh name before clearing its installer slot.
        _ = try preserveActiveQuarantine(artifacts)
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

  private func preserveActiveQuarantine(_ artifacts: InstallArtifacts) throws -> URL {
    guard try nodeKind(artifacts.quarantine) == .regularFile else {
      throw installerError("Quarantined attachment generation is unavailable")
    }
    let freshPreservation = try nextPreservationPath(artifacts)
    guard try moveExclusive(from: artifacts.quarantine, to: freshPreservation) else {
      throw installerError("Attachment preservation path already exists")
    }
    try syncDirectory(targetRoot)
    return freshPreservation
  }

  private func nextPreservationPath(_ artifacts: InstallArtifacts) throws -> URL {
    for attempt in 0..<10_000 {
      let candidate = targetRoot.appendingPathComponent("\(artifacts.preservationPrefix)\(attempt)")
      if try nodeKind(candidate) == .missing { return candidate }
    }
    throw installerError("No attachment preservation path is available")
  }

  private func validatePreservationPath(_ file: URL, artifacts: InstallArtifacts) throws {
    guard Self.canonical(file.deletingLastPathComponent()) == targetRoot,
          file.lastPathComponent.hasPrefix(artifacts.preservationPrefix)
    else {
      throw installerError("Attachment preservation path is outside the managed root")
    }
  }

  private func prepareCleanArtifacts(_ artifacts: InstallArtifacts) throws {
    guard try nodeKind(artifacts.journal) == .missing else {
      throw installerError("Attachment install journal was not recovered")
    }
    switch try nodeKind(artifacts.quarantine) {
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
    switch try nodeKind(artifacts.candidate) {
    case .missing:
      break
    case .regularFile:
      try deleteInternalIfRegular(artifacts.candidate)
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

  private func validateTargetPath(_ target: URL) throws {
    let name = target.lastPathComponent
    guard !name.hasPrefix(installerArtifactPrefix),
          !name.hasPrefix(installerPreservedPrefix),
          name != installerLockName else {
      throw installerError("Target attachment name is reserved")
    }
    let parent = Self.canonical(target.deletingLastPathComponent())
    guard parent == targetRoot else {
      throw installerError("Target attachment is outside the managed attachment root")
    }
    try requireDirectory(parent, label: "target attachment parent")
  }

  private func validateSourcePath(_ staged: URL) throws {
    try validateSourceContainment(staged)
    try requireRegularFile(staged, label: "staged attachment")
  }

  private func validateSourceContainment(_ staged: URL) throws {
    guard sourceRoots.contains(where: { staged == $0 || isDescendant(staged, of: $0) }) else {
      throw installerError("Staged attachment is outside app-private managed roots")
    }
  }

  private func isDescendant(_ file: URL, of root: URL) -> Bool {
    file.path.hasPrefix(root.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/")
  }

  private func ensureDirectory(_ directory: URL) throws {
    if try nodeKind(directory) == .missing {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
  }

  private func requireDirectory(_ file: URL, label: String) throws {
    switch try nodeKind(file) {
    case .directory:
      return
    case .symbolicLink:
      throw installerError("\(label) is a symbolic link")
    default:
      throw installerError("\(label) is unavailable")
    }
  }

  private func requireRegularFile(_ file: URL, label: String) throws {
    switch try nodeKind(file) {
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

  private func rejectSymlinkInput(_ file: URL, label: String) throws {
    if try nodeKind(file.standardizedFileURL) == .symbolicLink {
      throw installerError("\(label) is a symbolic link")
    }
  }

  private func requireRecoverableNode(_ file: URL, label: String) throws -> InstallerNodeKind {
    let kind = try nodeKind(file)
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

  private func nodeKind(_ file: URL) throws -> InstallerNodeKind {
    var info = stat()
    if Darwin.lstat(file.path, &info) != 0 {
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

  private func copySnapshot(from source: URL, to destination: URL) throws {
    let descriptor = Darwin.open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw installerError("Installer candidate already exists")
    }
    let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)

    do {
      let input = try openRegularFileForReading(source)
      defer {
        try? input.close()
        try? output.close()
      }
      while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
        try output.write(contentsOf: data)
      }
      try output.synchronize()
      try syncDirectory(targetRoot)
    } catch {
      try? delete(destination)
      throw installerError("Could not snapshot staged attachment", underlying: error)
    }
  }

  private func sha256(_ file: URL) throws -> String {
    let input = try openRegularFileForReading(file)
    defer { try? input.close() }
    var digest = SHA256()
    while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
      digest.update(data: data)
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func openRegularFileForReading(_ file: URL) throws -> FileHandle {
    let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw installerError("Could not open regular attachment file")
    }
    var info = stat()
    guard Darwin.fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
      Darwin.close(descriptor)
      throw installerError("Attachment path is not a regular file")
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func moveExclusive(from source: URL, to destination: URL) throws -> Bool {
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

  private func delete(_ file: URL) throws {
    if Darwin.unlink(file.path) != 0, errno != ENOENT {
      throw installerError("Could not remove installer artifact")
    }
  }

  private func writeJournal(_ journal: InstallJournal, to file: URL) throws {
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
    let temporary = file.appendingPathExtension("write-\(UUID().uuidString)")
    do {
      try data.write(to: temporary, options: [.withoutOverwriting])
      let handle = try FileHandle(forWritingTo: temporary)
      try handle.synchronize()
      try handle.close()
      guard Darwin.rename(temporary.path, file.path) == 0 else {
        throw installerError("Could not replace attachment install journal")
      }
      try syncDirectory(targetRoot)
    } catch {
      try? delete(temporary)
      throw installerError("Could not persist attachment install journal", underlying: error)
    }
  }

  private func parseJournal(_ file: URL) throws -> InstallJournal {
    let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
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

  private func deleteInternalIfRegular(_ file: URL) throws {
    switch try nodeKind(file) {
    case .missing:
      return
    case .regularFile:
      try delete(file)
      try syncDirectory(targetRoot)
    case .directory:
      throw installerError("Installer artifact is a directory")
    case .symbolicLink:
      throw installerError("Installer artifact is a symbolic link")
    case .other:
      throw installerError("Installer artifact is not a regular file")
    }
  }

  private func deleteJournal(_ file: URL) throws {
    try deleteInternalIfRegular(file)
  }

  private func deleteStagedBestEffort(_ staged: URL, expectedSha256: String? = nil) {
    do {
      guard try nodeKind(staged) == .regularFile else { return }
      if let expectedSha256, try sha256(staged) != expectedSha256 { return }
      try delete(staged)
      try syncDirectory(staged.deletingLastPathComponent())
    } catch {
      // The target generation is already durable. Preserve a private duplicate
      // rather than turning a completed install into an ambiguous retry.
    }
  }

  private func firstPreservedUrl(_ urls: URL...) -> URL {
    for url in urls where (try? nodeKind(url)) == .regularFile {
      return url
    }
    return urls[0]
  }

  private func syncDirectory(_ directory: URL) throws {
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
    guard Darwin.flock(descriptor, LOCK_EX) == 0 else {
      throw installerError("Could not acquire attachment installer lock")
    }
    defer { _ = Darwin.flock(descriptor, LOCK_UN) }
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
      let engine = AttachmentFileInstallerEngine(
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
      let snapshot = try AttachmentFileHashingEngine(
        targetRoot: documentsRoot.appendingPathComponent("attachments", isDirectory: true)
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
    let digest = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard isSha256(digest) else { throw installerError("\(label) SHA-256 is invalid") }
    return digest
  }
}
#endif
