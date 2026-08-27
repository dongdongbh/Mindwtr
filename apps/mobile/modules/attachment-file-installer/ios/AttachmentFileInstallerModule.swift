import CryptoKit
import Darwin
import ExpoModulesCore
import Foundation

private let installerArtifactPrefix = ".mindwtr-install-"
private let installerLockName = ".mindwtr-attachment-installer.lock"
private let sha256Pattern = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")

private enum InstallerNodeKind {
  case missing
  case regularFile
  case directory
  case symbolicLink
  case other
}

private enum ExpectedAttachmentGeneration {
  case absent
  case present(sha256: String)
}

private enum AttachmentInstallOutcome {
  case installed
  case conflict(preservedUrl: URL)
}

private enum JournalRecovery {
  case proceed
  case completed(stagedUrl: URL)
  case conflict(preservedUrl: URL)
}

private struct InstallArtifacts {
  let journal: URL
  let candidate: URL
  let quarantine: URL
}

private struct InstallJournal {
  let targetPath: String
  let stagedPath: String
  let candidateSha256: String
  let displacedSha256: String?
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

private final class AttachmentFileInstallerEngine {
  private let fileManager = FileManager.default
  private let targetRoot: URL
  private let sourceRoots: [URL]

  init(targetRoot: URL, sourceRoots: [URL]) {
    self.targetRoot = Self.canonical(targetRoot)
    self.sourceRoots = Array(Set(sourceRoots.map { Self.canonical($0).path })).map {
      URL(fileURLWithPath: $0, isDirectory: true)
    }
  }

  func install(
    stagedInput: URL,
    targetInput: URL,
    expected: ExpectedAttachmentGeneration
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

    return try withExclusiveLock(targetRoot.appendingPathComponent(installerLockName)) {
      try self.requireDirectory(self.targetRoot, label: "managed attachment root")
      try self.rejectSymlinkInput(stagedInput, label: "staged attachment")
      try self.rejectSymlinkInput(targetInput, label: "target attachment")
      try self.validateTargetPath(target)
      try self.validateSourcePath(staged)

      let artifacts = self.artifacts(for: target)
      switch try self.recoverJournal(target: target, artifacts: artifacts) {
      case .completed(let previousStaged) where previousStaged == staged:
        return .installed
      case .conflict(let preservedUrl):
        return .conflict(preservedUrl: preservedUrl)
      case .completed, .proceed:
        break
      }

      try self.prepareCleanArtifacts(artifacts)
      try self.requireRegularFile(staged, label: "staged attachment")
      switch expected {
      case .absent:
        return try self.installWhenAbsent(staged: staged, target: target, artifacts: artifacts)
      case .present(let expectedSha256):
        guard isSha256(expectedSha256) else {
          throw installerError("Expected attachment SHA-256 is invalid")
        }
        return try self.installWhenPresent(
          staged: staged,
          target: target,
          expectedSha256: expectedSha256,
          artifacts: artifacts
        )
      }
    }
  }

  private func installWhenAbsent(
    staged: URL,
    target: URL,
    artifacts: InstallArtifacts
  ) throws -> AttachmentInstallOutcome {
    switch try nodeKind(target) {
    case .missing:
      try copySnapshot(from: staged, to: artifacts.candidate)
      guard try moveExclusive(from: artifacts.candidate, to: target) else {
        try deleteInternalIfRegular(artifacts.candidate)
        return .conflict(preservedUrl: staged)
      }
      try syncDirectory(targetRoot)
      deleteStagedBestEffort(staged)
      return .installed
    case .regularFile:
      return .conflict(preservedUrl: staged)
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

    try copySnapshot(from: staged, to: artifacts.candidate)
    let candidateSha256 = try sha256(artifacts.candidate)
    try writeJournal(
      InstallJournal(
        targetPath: target.path,
        stagedPath: staged.path,
        candidateSha256: candidateSha256,
        displacedSha256: nil
      ),
      to: artifacts.journal
    )

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
        displacedSha256: displacedSha256
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

    try deleteInternalIfRegular(artifacts.quarantine)
    deleteStagedBestEffort(staged, expectedSha256: candidateSha256)
    try deleteJournal(artifacts.journal)
    return .installed
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
    let candidateKind = try requireRecoverableNode(artifacts.candidate, label: "journal candidate")
    let quarantineKind = try requireRecoverableNode(artifacts.quarantine, label: "journal quarantine")

    if targetKind == .regularFile {
      let targetSha256 = try sha256(target)
      if targetSha256 == journal.candidateSha256 {
        if quarantineKind == .regularFile {
          guard
            let displaced = journal.displacedSha256,
            try sha256(artifacts.quarantine) == displaced
          else {
            return .conflict(preservedUrl: artifacts.quarantine)
          }
          try deleteInternalIfRegular(artifacts.quarantine)
        }
        try deleteInternalIfRegular(artifacts.candidate)
        deleteStagedBestEffort(previousStaged, expectedSha256: journal.candidateSha256)
        try deleteJournal(artifacts.journal)
        return .completed(stagedUrl: previousStaged)
      }

      if let displaced = journal.displacedSha256, targetSha256 == displaced {
        if quarantineKind == .regularFile, try sha256(artifacts.quarantine) != displaced {
          return .conflict(preservedUrl: artifacts.quarantine)
        }
        try deleteInternalIfRegular(artifacts.quarantine)
        try deleteInternalIfRegular(artifacts.candidate)
        try deleteJournal(artifacts.journal)
        return .proceed
      }

      return .conflict(
        preservedUrl: firstPreservedUrl(artifacts.quarantine, artifacts.candidate, previousStaged)
      )
    }

    if quarantineKind == .regularFile {
      let actualDisplaced = try sha256(artifacts.quarantine)
      if let displaced = journal.displacedSha256, displaced != actualDisplaced {
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

    return .conflict(
      preservedUrl: firstPreservedUrl(artifacts.candidate, previousStaged, artifacts.journal)
    )
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
      quarantine: targetRoot.appendingPathComponent("\(installerArtifactPrefix)\(digest).quarantine")
    )
  }

  private func validateTargetPath(_ target: URL) throws {
    let name = target.lastPathComponent
    guard !name.hasPrefix(installerArtifactPrefix), name != installerLockName else {
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
      "version": 1,
      "targetPath": journal.targetPath,
      "stagedPath": journal.stagedPath,
      "candidateSha256": journal.candidateSha256,
      "displacedSha256": journal.displacedSha256 ?? NSNull(),
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
      "version", "targetPath", "stagedPath", "candidateSha256", "displacedSha256",
    ]
    guard Set(object.keys) == expectedKeys, object["version"] as? Int == 1,
          let targetPath = object["targetPath"] as? String,
          let stagedPath = object["stagedPath"] as? String,
          let candidateSha256 = object["candidateSha256"] as? String,
          isSha256(candidateSha256)
    else {
      throw installerError("Attachment install journal fields are invalid")
    }
    let displacedSha256 = object["displacedSha256"] as? String
    if let displacedSha256, !isSha256(displacedSha256) {
      throw installerError("Attachment install journal displaced hash is invalid")
    }
    return InstallJournal(
      targetPath: targetPath,
      stagedPath: stagedPath,
      candidateSha256: candidateSha256,
      displacedSha256: displacedSha256
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

public final class AttachmentFileInstallerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AttachmentFileInstaller")

    AsyncFunction("installAsync") {
        (stagedPath: String, targetPath: String, expected: [String: String]) -> [String: String] in
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
        expected: try Self.parseExpected(expected)
      )
      switch outcome {
      case .installed:
        return ["status": "installed"]
      case .conflict(let preservedUrl):
        return ["status": "conflict", "preservedPath": preservedUrl.absoluteString]
      }
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
      let digest = value["sha256"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
      guard isSha256(digest) else {
        throw installerError("Expected attachment SHA-256 is invalid")
      }
      return .present(sha256: digest)
    default:
      throw installerError("Expected attachment generation is invalid")
    }
  }
}
