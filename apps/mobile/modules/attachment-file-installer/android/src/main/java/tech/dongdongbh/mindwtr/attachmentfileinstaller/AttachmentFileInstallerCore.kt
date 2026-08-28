package tech.dongdongbh.mindwtr.attachmentfileinstaller

import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal const val INSTALLER_ARTIFACT_PREFIX = ".mindwtr-install-"
internal const val INSTALLER_LOCK_NAME = ".mindwtr-attachment-installer.lock"
internal const val INSTALLER_PRESERVED_PREFIX = ".mindwtr-preserved-"
internal const val INSTALLER_RETIREMENT_SUFFIX = ".retiring"
internal val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

// Immutable publication protects against crashes and cooperating Mindwtr
// writers by retaining a private namespace and exact descriptors. A malicious
// same-UID process that can bypass the private directory is outside the model;
// ambiguous provider or identity behavior remains fail-closed.

internal enum class InstallerNodeKind {
  MISSING,
  REGULAR_FILE,
  DIRECTORY,
  SYMLINK,
  OTHER,
}

internal sealed class ExpectedAttachmentGeneration {
  data object Absent : ExpectedAttachmentGeneration()
  data class Present(val sha256: String) : ExpectedAttachmentGeneration()
}

internal sealed class AttachmentInstallOutcome {
  data class Installed(val preservedFile: File? = null) : AttachmentInstallOutcome()
  data class Conflict(val preservedFile: File) : AttachmentInstallOutcome()
}

internal class AttachmentInstallerFailure(message: String, cause: Throwable? = null) :
  Exception(message, cause)

internal data class AttachmentFileIdentity(
  val fileKey: String,
  val size: Long,
  val modificationTimeNs: Long,
  val changeTimeNs: Long,
)

internal data class AttachmentFileHashSnapshot(
  val sha256: String,
  val size: Long,
  val modificationTimeMs: Double,
)

internal enum class ImmutableAttachmentPublishOutcome {
  PUBLISHED,
  ALREADY_EXISTS,
}

internal data class ImmutableAttachmentStageIdentity(
  val stagedIdentity: String,
  val directoryIdentity: String,
)

internal data class ImmutableAttachmentPreparedStage(
  val stagedPath: File,
  val stagedIdentity: String,
  val directoryIdentity: String,
  val privateDirectoryIdentity: String,
)

internal enum class ImmutableAttachmentStageCleanupOutcome {
  REMOVED,
  MISSING,
  CONFLICT,
}

internal interface AttachmentInstallerFileOps {
  fun canonical(file: File): File
  fun ensureDirectory(directory: File)
  fun ensurePrivateDirectory(directory: File) = ensureDirectory(directory)
  fun createPrivateDirectoryExclusive(directory: File)
  fun createNewRegularFile(file: File)
  fun nodeKind(file: File): InstallerNodeKind
  fun nodeIdentity(file: File): String
  fun fileIdentity(file: File): AttachmentFileIdentity
  fun copySnapshot(source: File, destination: File)
  fun sha256(file: File): String
  /** Move without replacing destination. False means destination already exists. */
  fun moveExclusive(source: File, destination: File): Boolean
  fun publishVerifiedImmutable(
    source: File,
    destination: File,
    expectedSha256: String,
    expectedSourceIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String,
  ): ImmutableAttachmentPublishOutcome
  /**
   * Durably retire an empty private directory through a reservation-derived
   * quarantine. Exact identities still fence every mutation; the stable name
   * lets recovery resume after a crash before adopted identities reach JS.
   */
  fun retireEmptyDirectoryIfIdentity(
    directory: File,
    expectedIdentity: String,
    expectedParentIdentity: String,
  ): ImmutableAttachmentStageCleanupOutcome
  /**
   * Retain the current parent once, adopt this reservation's candidate or
   * retirement namespace beneath that handle, and durably remove its stage.
   */
  fun retireReservedPrivateStage(directory: File): ImmutableAttachmentStageCleanupOutcome
  fun delete(file: File)
  fun deleteEmptyDirectory(directory: File) = delete(directory)
  fun readUtf8(file: File): String
  fun writeUtf8Durably(file: File, content: String)
  fun syncDirectory(directory: File)
  fun <T> withExclusiveLock(lockFile: File, action: () -> T): T
}

/** Recovery for a device-reserved File Sync publication stage. A shared leaf is
 * never deleted in place: it is first displaced create-no-replace into a
 * deterministic private quarantine, then its recorded inode and digest are
 * revalidated before deletion. Any ambiguity preserves bytes and fails closed. */
internal class ImmutableAttachmentStageRecoveryCore(
  targetRoot: File,
  private val ops: AttachmentInstallerFileOps,
) {
  private val targetRoot = ops.canonical(targetRoot)

  fun prepare(targetInput: File, operationId: String): ImmutableAttachmentPreparedStage {
    if (!Regex("^[a-f0-9]{32}$").matches(operationId)) {
      throw AttachmentInstallerFailure("Attachment publication operation id is invalid")
    }
    val target = ops.canonical(targetInput.absoluteFile)
    if (target.parentFile != targetRoot) {
      throw AttachmentInstallerFailure("Immutable attachment target escapes the target directory")
    }
    val privateDirectory = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$operationId.candidate")
    val stage = File(privateDirectory, "stage")
    return ops.withExclusiveLock(File(targetRoot, INSTALLER_LOCK_NAME)) {
      requireDirectory(targetRoot)
      if (ops.nodeKind(privateDirectory) != InstallerNodeKind.MISSING) {
        throw AttachmentInstallerFailure("Attachment publication private namespace already exists")
      }
      ops.createPrivateDirectoryExclusive(privateDirectory)
      try {
        ops.createNewRegularFile(stage)
        ops.syncDirectory(privateDirectory)
        ops.syncDirectory(targetRoot)
        ImmutableAttachmentPreparedStage(
          stagedPath = stage,
          stagedIdentity = ops.fileIdentity(stage).fileKey,
          directoryIdentity = ops.nodeIdentity(targetRoot),
          privateDirectoryIdentity = ops.nodeIdentity(privateDirectory),
        )
      } catch (error: Throwable) {
        // The durable device-local reservation owns this exact random name.
        // Persist whichever final namespace state cleanup can safely reach so
        // recovery never clears the reservation ahead of an unsynced delete.
        try {
          if (ops.nodeKind(stage) == InstallerNodeKind.MISSING) {
            ops.deleteEmptyDirectory(privateDirectory)
          } else if (ops.nodeKind(privateDirectory) == InstallerNodeKind.DIRECTORY) {
            ops.syncDirectory(privateDirectory)
          }
        } catch (_: Throwable) {
          // Recovery retains the reservation and reclassifies the namespace.
        }
        try {
          ops.syncDirectory(targetRoot)
        } catch (_: Throwable) {
          // Preserve the original preparation failure; recovery fsyncs before
          // reporting a missing namespace or removing an adopted one.
        }
        throw error
      }
    }
  }

  fun snapshot(stagedInput: File, targetInput: File, expectedSha256: String): ImmutableAttachmentStageIdentity {
    validateInputs(stagedInput, targetInput, expectedSha256)
    return ops.withExclusiveLock(File(targetRoot, INSTALLER_LOCK_NAME)) {
      requireDirectory(targetRoot)
      requireRegular(stagedInput)
      val before = ops.fileIdentity(stagedInput)
      val digest = ops.sha256(stagedInput)
      val after = ops.fileIdentity(stagedInput)
      if (before.fileKey != after.fileKey || before != after || digest != expectedSha256) {
        throw AttachmentInstallerFailure("Staged attachment changed before ownership was recorded")
      }
      ImmutableAttachmentStageIdentity(after.fileKey, ops.nodeIdentity(targetRoot))
    }
  }

  fun cleanup(
    stagedInput: File,
    targetInput: File,
    operationId: String,
    expectedSha256: String?,
    expectedStagedIdentity: String?,
    expectedDirectoryIdentity: String?,
    expectedPrivateDirectoryIdentity: String?,
  ): ImmutableAttachmentStageCleanupOutcome {
    if (!Regex("^[a-f0-9]{32}$").matches(operationId)) {
      throw AttachmentInstallerFailure("Attachment publication operation id is invalid")
    }
    val privateDirectory = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$operationId.candidate")
    val privateStage = File(privateDirectory, "stage")
    val isPrivateStage = ops.canonical(stagedInput.absoluteFile) == ops.canonical(privateStage)
    if (!isPrivateStage && stagedInput.name != ".mindwtr-generation-stage-$operationId.tmp") {
      throw AttachmentInstallerFailure("Attachment publication stage name is invalid")
    }
    validatePaths(stagedInput, targetInput)
    val quarantine = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$operationId.quarantine")
    val quarantinedStage = File(quarantine, "stage")
    return ops.withExclusiveLock(File(targetRoot, INSTALLER_LOCK_NAME)) {
      requireDirectory(targetRoot)
      if (isPrivateStage) {
        if (
          expectedDirectoryIdentity == null
          || expectedPrivateDirectoryIdentity == null
        ) {
          if (
            expectedDirectoryIdentity != null
            || expectedPrivateDirectoryIdentity != null
            || expectedStagedIdentity != null
          ) {
            return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
          }
          // JS durably reserves this random 128-bit private name before native
          // prepare. Within the cooperating-writer/private-mode threat model,
          // that capability owns its candidate and stable retirement names.
          // Native recovery retains the parent before observing either leaf,
          // so a provider/root rebind cannot split identity adoption.
          return@withExclusiveLock ops.retireReservedPrivateStage(privateDirectory)
        }
        val privateDirectoryKind = ops.nodeKind(privateDirectory)
        if (
          ops.nodeIdentity(targetRoot) != expectedDirectoryIdentity
        ) {
          return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
        }
        if (privateDirectoryKind == InstallerNodeKind.MISSING) {
          return@withExclusiveLock ops.retireEmptyDirectoryIfIdentity(
            privateDirectory,
            expectedPrivateDirectoryIdentity,
            expectedDirectoryIdentity,
          )
        }
        if (
          ops.nodeKind(privateDirectory) != InstallerNodeKind.DIRECTORY
          || ops.nodeIdentity(privateDirectory) != expectedPrivateDirectoryIdentity
        ) {
          return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
        }
        when (ops.nodeKind(privateStage)) {
          InstallerNodeKind.MISSING -> {
            return@withExclusiveLock ops.retireEmptyDirectoryIfIdentity(
              privateDirectory,
              expectedPrivateDirectoryIdentity,
              expectedDirectoryIdentity,
            )
          }
          InstallerNodeKind.REGULAR_FILE -> Unit
          else -> return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
        }
        if (
          expectedStagedIdentity == null
          || ops.fileIdentity(privateStage).fileKey != expectedStagedIdentity
        ) {
          return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
        }
        // The inode was create-new inside this reservation's private mode-0700
        // namespace. It remains invocation-owned even if a crash left a
        // partial digest, so exact-identity cleanup is safe and bounded.
        ops.delete(privateStage)
        ops.syncDirectory(privateDirectory)
        return@withExclusiveLock ops.retireEmptyDirectoryIfIdentity(
          privateDirectory,
          expectedPrivateDirectoryIdentity,
          expectedDirectoryIdentity,
        )
      }
      if (expectedSha256 == null || expectedStagedIdentity == null || expectedDirectoryIdentity == null) {
        return@withExclusiveLock if (
          ops.nodeKind(stagedInput) == InstallerNodeKind.MISSING
          && ops.nodeKind(quarantine) == InstallerNodeKind.MISSING
        ) ImmutableAttachmentStageCleanupOutcome.MISSING else ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      if (ops.nodeIdentity(targetRoot) != expectedDirectoryIdentity) {
        return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      when (ops.nodeKind(quarantine)) {
        InstallerNodeKind.MISSING -> {
          when (ops.nodeKind(stagedInput)) {
            InstallerNodeKind.MISSING -> return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.MISSING
            InstallerNodeKind.REGULAR_FILE -> Unit
            else -> return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
          }
          ops.ensurePrivateDirectory(quarantine)
          if (!ops.moveExclusive(stagedInput, quarantinedStage)) {
            return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
          }
          ops.syncDirectory(targetRoot)
        }
        InstallerNodeKind.DIRECTORY -> {
          if (ops.nodeKind(stagedInput) != InstallerNodeKind.MISSING) {
            return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
          }
        }
        else -> return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      if (ops.nodeIdentity(targetRoot) != expectedDirectoryIdentity) {
        return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      if (ops.nodeKind(quarantinedStage) != InstallerNodeKind.REGULAR_FILE) {
        return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      val before = ops.fileIdentity(quarantinedStage)
      val digest = ops.sha256(quarantinedStage)
      val after = ops.fileIdentity(quarantinedStage)
      if (
        before != after
        || after.fileKey != expectedStagedIdentity
        || digest != expectedSha256
      ) {
        return@withExclusiveLock ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      ops.delete(quarantinedStage)
      ops.syncDirectory(quarantine)
      ops.deleteEmptyDirectory(quarantine)
      ops.syncDirectory(targetRoot)
      ImmutableAttachmentStageCleanupOutcome.REMOVED
    }
  }

  private fun validateInputs(staged: File, target: File, expectedSha256: String) {
    if (!SHA256_HEX_PATTERN.matches(expectedSha256)) {
      throw AttachmentInstallerFailure("Expected staged attachment SHA-256 is invalid")
    }
    validatePaths(staged, target)
  }

  private fun validatePaths(staged: File, target: File) {
    if (ops.nodeKind(staged) == InstallerNodeKind.SYMLINK || ops.nodeKind(target) == InstallerNodeKind.SYMLINK) {
      throw AttachmentInstallerFailure("Immutable attachment recovery path is a symbolic link")
    }
    val canonicalStaged = ops.canonical(staged)
    val canonicalTarget = ops.canonical(target)
    val stagedParent = canonicalStaged.parentFile
    val privateStage = canonicalStaged.name == "stage"
      && stagedParent?.parentFile == targetRoot
      && Regex("^\\.mindwtr-install-[a-f0-9]{32}\\.candidate$").matches(stagedParent.name)
    if ((!privateStage && stagedParent != targetRoot) || canonicalTarget.parentFile != targetRoot || staged == target) {
      throw AttachmentInstallerFailure("Immutable attachment recovery paths escape the target directory")
    }
  }

  private fun requireDirectory(directory: File) {
    if (ops.nodeKind(directory) != InstallerNodeKind.DIRECTORY) {
      throw AttachmentInstallerFailure("File Sync attachment directory is unavailable")
    }
  }

  private fun requireRegular(file: File) {
    if (ops.nodeKind(file) != InstallerNodeKind.REGULAR_FILE) {
      throw AttachmentInstallerFailure("Immutable attachment stage is not a regular file")
    }
  }
}

/** Stable, streaming hash of one managed canonical attachment. The installer
 * lock prevents our own publication path from moving the name while it is read;
 * the before/after inode identity rejects uncoordinated replacement. */
internal class AttachmentFileHasherCore(
  targetRoot: File,
  private val ops: AttachmentInstallerFileOps,
) {
  private val targetRoot = ops.canonical(targetRoot)

  fun hash(input: File): AttachmentFileHashSnapshot {
    requireDirectory(targetRoot)
    rejectSymlink(input.absoluteFile)
    val target = ops.canonical(input)
    if (target.parentFile != targetRoot) {
      throw AttachmentInstallerFailure("Attachment hash path escapes managed attachment root")
    }
    return ops.withExclusiveLock(File(targetRoot, INSTALLER_LOCK_NAME)) {
      requireDirectory(targetRoot)
      rejectSymlink(input.absoluteFile)
      val canonical = ops.canonical(input)
      if (canonical != target || canonical.parentFile != targetRoot) {
        throw AttachmentInstallerFailure("Attachment hash path changed during validation")
      }
      requireRegularFile(target)
      val before = ops.fileIdentity(target)
      val sha256 = ops.sha256(target)
      val after = ops.fileIdentity(target)
      if (before != after) {
        throw AttachmentInstallerFailure("Attachment changed while hashing")
      }
      AttachmentFileHashSnapshot(
        sha256,
        after.size,
        after.modificationTimeNs.toDouble() / 1_000_000.0,
      )
    }
  }

  private fun requireDirectory(directory: File) {
    if (ops.nodeKind(directory) != InstallerNodeKind.DIRECTORY) {
      throw AttachmentInstallerFailure("Managed attachment root is unavailable")
    }
  }

  private fun requireRegularFile(file: File) {
    when (ops.nodeKind(file)) {
      InstallerNodeKind.REGULAR_FILE -> Unit
      InstallerNodeKind.MISSING -> throw AttachmentInstallerFailure("Attachment file is unavailable")
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Attachment path is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Attachment path is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Attachment path is not a regular file")
    }
  }

  private fun rejectSymlink(file: File) {
    if (ops.nodeKind(file) == InstallerNodeKind.SYMLINK) {
      throw AttachmentInstallerFailure("Attachment path is a symbolic link")
    }
  }
}

/** Create-no-replace publication for a File Sync generation already staged in
 * the target directory. Unlike the managed-local installer, this path creates
 * no journal/candidate/quarantine artifacts in the shared sync folder: exact
 * scratch ownership and restart recovery live in device-local JS storage. */
internal class ImmutableAttachmentFilePublisherCore(
  targetRoot: File,
  private val ops: AttachmentInstallerFileOps,
) {
  private val targetRoot = ops.canonical(targetRoot)

  fun publish(
    stagedInput: File,
    targetInput: File,
    expectedStagedSha256: String,
    expectedStagedIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String,
  ): ImmutableAttachmentPublishOutcome {
    if (!SHA256_HEX_PATTERN.matches(expectedStagedSha256)) {
      throw AttachmentInstallerFailure("Expected staged attachment SHA-256 is invalid")
    }
    val stagedAbsolute = stagedInput.absoluteFile
    val targetAbsolute = targetInput.absoluteFile
    rejectSymlink(stagedAbsolute, "staged attachment")
    rejectSymlink(targetAbsolute, "target attachment")
    val staged = ops.canonical(stagedAbsolute)
    val target = ops.canonical(targetAbsolute)
    val stagedParent = staged.parentFile
    val privateStage = staged.name == "stage"
      && stagedParent != null
      && stagedParent.parentFile == targetRoot
      && Regex("^\\.mindwtr-install-[a-f0-9]{32}\\.candidate$").matches(stagedParent.name)
    if (!privateStage || target.parentFile != targetRoot || staged == target) {
      throw AttachmentInstallerFailure("Immutable attachment stage must use its reserved private namespace")
    }
    return ops.withExclusiveLock(File(targetRoot, INSTALLER_LOCK_NAME)) {
      requireDirectory()
      rejectSymlink(stagedAbsolute, "staged attachment")
      rejectSymlink(targetAbsolute, "target attachment")
      if (ops.canonical(stagedAbsolute) != staged || ops.canonical(targetAbsolute) != target) {
        throw AttachmentInstallerFailure("Immutable attachment path changed during validation")
      }
      if (ops.nodeKind(target) != InstallerNodeKind.MISSING) {
        return@withExclusiveLock ImmutableAttachmentPublishOutcome.ALREADY_EXISTS
      }
      val outcome = ops.publishVerifiedImmutable(
        staged,
        target,
        expectedStagedSha256,
        expectedStagedIdentity,
        expectedDirectoryIdentity,
        expectedPrivateDirectoryIdentity,
      )
      if (outcome == ImmutableAttachmentPublishOutcome.PUBLISHED) {
        val privateDirectory = staged.parentFile
          ?: throw AttachmentInstallerFailure("Private attachment publication directory is unavailable")
        val cleanupOutcome = if (ops.nodeKind(staged) == InstallerNodeKind.MISSING) {
          ops.retireEmptyDirectoryIfIdentity(
            privateDirectory,
            expectedPrivateDirectoryIdentity,
            expectedDirectoryIdentity,
          )
        } else {
          ImmutableAttachmentStageCleanupOutcome.CONFLICT
        }
        if (cleanupOutcome == ImmutableAttachmentStageCleanupOutcome.CONFLICT) {
          throw AttachmentInstallerFailure("Published attachment private namespace changed before cleanup")
        }
      }
      outcome
    }
  }

  private fun requireDirectory() {
    if (ops.nodeKind(targetRoot) != InstallerNodeKind.DIRECTORY) {
      throw AttachmentInstallerFailure("File Sync attachment directory is unavailable")
    }
  }

  private fun rejectSymlink(file: File, label: String) {
    if (ops.nodeKind(file) == InstallerNodeKind.SYMLINK) {
      throw AttachmentInstallerFailure("$label is a symbolic link")
    }
  }
}

private data class InstallJournal(
  val targetPath: String,
  val stagedPath: String,
  val candidateSha256: String,
  val expectedLocalSha256: String?,
  val displacedSha256: String?,
  val preservationPath: String?,
)

private data class InstallArtifacts(
  val journal: File,
  val candidate: File,
  val quarantine: File,
  val preservationPrefix: String,
)

private sealed class JournalRecovery {
  data object Continue : JournalRecovery()
  data class Completed(val stagedFile: File, val preservedFile: File?) : JournalRecovery()
  data class Conflict(val preservedFile: File) : JournalRecovery()
}

/**
 * Generation-bound install policy shared by the Android Expo bridge and its JVM
 * tests. All input paths originate in synced metadata and are therefore treated
 * as hostile until canonical confinement and node-type checks succeed.
 */
internal class AttachmentFileInstallerCore(
  targetRoot: File,
  sourceRoots: List<File>,
  private val ops: AttachmentInstallerFileOps,
) {
  private val targetRoot = ops.canonical(targetRoot)
  private val sourceRoots = sourceRoots.map(ops::canonical).distinctBy(File::getPath)

  fun install(
    stagedInput: File,
    targetInput: File,
    expected: ExpectedAttachmentGeneration,
    expectedDownloadSha256: String,
  ): AttachmentInstallOutcome {
    ops.ensureDirectory(targetRoot)
    requireDirectory(targetRoot, "managed attachment root")

    rejectSymlinkInput(stagedInput.absoluteFile, "staged attachment")
    rejectSymlinkInput(targetInput.absoluteFile, "target attachment")
    val staged = ops.canonical(stagedInput)
    val target = ops.canonical(targetInput)
    validateTargetPath(target)
    validateSourcePath(staged)
    if (staged == target) {
      throw AttachmentInstallerFailure("Staged and target attachment paths must differ")
    }
    if (expected is ExpectedAttachmentGeneration.Present && !SHA256_HEX_PATTERN.matches(expected.sha256)) {
      throw AttachmentInstallerFailure("Expected attachment SHA-256 is invalid")
    }
    if (!SHA256_HEX_PATTERN.matches(expectedDownloadSha256)) {
      throw AttachmentInstallerFailure("Expected download SHA-256 is invalid")
    }

    val lockFile = File(targetRoot, INSTALLER_LOCK_NAME)
    return ops.withExclusiveLock(lockFile) {
      // Revalidate after locking: another app process may have changed a path
      // between the initial checks and lock acquisition.
      requireDirectory(targetRoot, "managed attachment root")
      rejectSymlinkInput(stagedInput.absoluteFile, "staged attachment")
      rejectSymlinkInput(targetInput.absoluteFile, "target attachment")
      validateTargetPath(target)
      validateSourcePath(staged)

      val artifacts = artifactsFor(target)
      when (val recovery = recoverJournal(target, artifacts)) {
        is JournalRecovery.Completed -> {
          if (recovery.stagedFile == staged) {
            return@withExclusiveLock AttachmentInstallOutcome.Installed(recovery.preservedFile)
          }
        }
        is JournalRecovery.Conflict -> {
          return@withExclusiveLock AttachmentInstallOutcome.Conflict(recovery.preservedFile)
        }
        JournalRecovery.Continue -> Unit
      }

      prepareCleanArtifacts(artifacts)
      requireRegularFile(staged, "staged attachment")
      ops.copySnapshot(staged, artifacts.candidate)
      val candidateSha256 = ops.sha256(artifacts.candidate)
      if (candidateSha256 != expectedDownloadSha256) {
        deleteInternalIfRegular(artifacts.candidate)
        throw AttachmentInstallerFailure("Staged attachment changed before native snapshot")
      }
      when (expected) {
        ExpectedAttachmentGeneration.Absent -> installWhenAbsent(staged, target, candidateSha256, artifacts)
        is ExpectedAttachmentGeneration.Present -> installWhenPresent(
          staged,
          target,
          expected,
          candidateSha256,
          artifacts,
        )
      }
    }
  }

  private fun installWhenAbsent(
    staged: File,
    target: File,
    candidateSha256: String,
    artifacts: InstallArtifacts,
  ): AttachmentInstallOutcome {
    return when (ops.nodeKind(target)) {
      InstallerNodeKind.MISSING -> {
        writeJournal(
          artifacts.journal,
          InstallJournal(
            targetPath = target.path,
            stagedPath = staged.path,
            candidateSha256 = candidateSha256,
            expectedLocalSha256 = null,
            displacedSha256 = null,
            preservationPath = null,
          ),
        )
        val moved = ops.moveExclusive(artifacts.candidate, target)
        if (!moved) {
          deleteInternalIfRegular(artifacts.candidate)
          deleteJournal(artifacts.journal)
          AttachmentInstallOutcome.Conflict(staged)
        } else {
          ops.syncDirectory(targetRoot)
          deleteStagedBestEffort(staged, candidateSha256)
          deleteJournal(artifacts.journal)
          AttachmentInstallOutcome.Installed()
        }
      }
      InstallerNodeKind.REGULAR_FILE -> {
        if (ops.sha256(target) != candidateSha256) {
          deleteInternalIfRegular(artifacts.candidate)
          AttachmentInstallOutcome.Conflict(staged)
        } else {
          deleteInternalIfRegular(artifacts.candidate)
          deleteStagedBestEffort(staged, candidateSha256)
          AttachmentInstallOutcome.Installed()
        }
      }
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Target attachment path is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Target attachment path is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Target attachment path is not a regular file")
    }
  }

  private fun installWhenPresent(
    staged: File,
    target: File,
    expected: ExpectedAttachmentGeneration.Present,
    candidateSha256: String,
    artifacts: InstallArtifacts,
  ): AttachmentInstallOutcome {
    when (ops.nodeKind(target)) {
      InstallerNodeKind.MISSING -> return AttachmentInstallOutcome.Conflict(staged)
      InstallerNodeKind.REGULAR_FILE -> Unit
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Target attachment path is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Target attachment path is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Target attachment path is not a regular file")
    }

    writeJournal(
      artifacts.journal,
      InstallJournal(
        targetPath = target.path,
        stagedPath = staged.path,
        candidateSha256 = candidateSha256,
        expectedLocalSha256 = expected.sha256,
        displacedSha256 = null,
        preservationPath = null,
      ),
    )

    val quarantined = ops.moveExclusive(target, artifacts.quarantine)
    if (!quarantined) {
      // A quarantine artifact can only appear through an interrupted installer;
      // leave every generation in place for the next recovery pass.
      return AttachmentInstallOutcome.Conflict(firstPreservedFile(artifacts.quarantine, staged))
    }
    ops.syncDirectory(targetRoot)

    val displacedSha256 = ops.sha256(artifacts.quarantine)
    writeJournal(
      artifacts.journal,
      InstallJournal(
        targetPath = target.path,
        stagedPath = staged.path,
        candidateSha256 = candidateSha256,
        expectedLocalSha256 = expected.sha256,
        displacedSha256 = displacedSha256,
        preservationPath = null,
      ),
    )

    if (displacedSha256 != expected.sha256) {
      return if (ops.moveExclusive(artifacts.quarantine, target)) {
        ops.syncDirectory(targetRoot)
        deleteInternalIfRegular(artifacts.candidate)
        deleteJournal(artifacts.journal)
        AttachmentInstallOutcome.Conflict(staged)
      } else {
        AttachmentInstallOutcome.Conflict(artifacts.quarantine)
      }
    }

    if (!ops.moveExclusive(artifacts.candidate, target)) {
      return AttachmentInstallOutcome.Conflict(artifacts.quarantine)
    }
    ops.syncDirectory(targetRoot)
    if (ops.sha256(target) != candidateSha256) {
      // Keep the displaced generation and journal. A later invocation can
      // distinguish the completed candidate from an unexpected peer file.
      return AttachmentInstallOutcome.Conflict(artifacts.quarantine)
    }

    val preservedFile = preserveQuarantine(artifacts, InstallJournal(
      targetPath = target.path,
      stagedPath = staged.path,
      candidateSha256 = candidateSha256,
      expectedLocalSha256 = expected.sha256,
      displacedSha256 = displacedSha256,
      preservationPath = null,
    ))
    deleteStagedBestEffort(staged, candidateSha256)
    deleteJournal(artifacts.journal)
    return AttachmentInstallOutcome.Installed(preservedFile)
  }

  private fun recoverJournal(target: File, artifacts: InstallArtifacts): JournalRecovery {
    return when (ops.nodeKind(artifacts.journal)) {
      InstallerNodeKind.MISSING -> JournalRecovery.Continue
      InstallerNodeKind.REGULAR_FILE -> recoverParsedJournal(target, artifacts, parseJournal(artifacts.journal))
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Attachment install journal is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Attachment install journal is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Attachment install journal is not a regular file")
    }
  }

  private fun recoverParsedJournal(
    target: File,
    artifacts: InstallArtifacts,
    journal: InstallJournal,
  ): JournalRecovery {
    if (ops.canonical(File(journal.targetPath)) != target) {
      throw AttachmentInstallerFailure("Attachment install journal targets a different file")
    }
    val previousStaged = ops.canonical(File(journal.stagedPath))
    validateSourceContainment(previousStaged)

    val targetKind = requireRecoverableNode(target, "journal target")
    requireRecoverableNode(artifacts.candidate, "journal candidate")
    val quarantineKind = requireRecoverableNode(artifacts.quarantine, "journal quarantine")
    val preservation = journal.preservationPath?.let { path ->
      val file = ops.canonical(File(path))
      validatePreservationPath(file, artifacts)
      requireRecoverableNode(file, "journal preservation")
      file
    }

    if (targetKind == InstallerNodeKind.REGULAR_FILE) {
      val targetSha256 = ops.sha256(target)
      if (targetSha256 == journal.candidateSha256) {
        val preserved = if (journal.expectedLocalSha256 == null) {
          if (quarantineKind == InstallerNodeKind.REGULAR_FILE) {
            return JournalRecovery.Conflict(artifacts.quarantine)
          }
          null
        } else {
          if (quarantineKind == InstallerNodeKind.MISSING && preservation == null) {
            return JournalRecovery.Conflict(firstPreservedFile(artifacts.candidate, previousStaged))
          }
          preserveQuarantine(artifacts, journal)
        }
        deleteInternalIfRegular(artifacts.candidate)
        deleteStagedBestEffort(previousStaged, journal.candidateSha256)
        deleteJournal(artifacts.journal)
        return JournalRecovery.Completed(previousStaged, preserved)
      }

      val expectedLocal = journal.expectedLocalSha256
      if (expectedLocal != null && targetSha256 == expectedLocal) {
        if (preservation != null) {
          return JournalRecovery.Conflict(preservation)
        }
        if (quarantineKind == InstallerNodeKind.REGULAR_FILE) {
          if (ops.sha256(artifacts.quarantine) != expectedLocal) {
            return JournalRecovery.Conflict(artifacts.quarantine)
          }
          // Hash equality does not prove both names reference the same inode:
          // an uncoordinated writer may have replaced either path. Preserve the
          // active quarantine under a fresh name before restarting.
          preserveActiveQuarantine(artifacts)
        }
        deleteInternalIfRegular(artifacts.candidate)
        deleteJournal(artifacts.journal)
        return JournalRecovery.Continue
      }

      if (expectedLocal == null) {
        deleteInternalIfRegular(artifacts.candidate)
        deleteJournal(artifacts.journal)
        return JournalRecovery.Conflict(previousStaged)
      }

      return JournalRecovery.Conflict(firstPreservedFile(artifacts.quarantine, artifacts.candidate, previousStaged))
    }

    val expectedLocal = journal.expectedLocalSha256
    if (quarantineKind == InstallerNodeKind.REGULAR_FILE && expectedLocal != null) {
      if (ops.sha256(artifacts.quarantine) != expectedLocal) {
        return JournalRecovery.Conflict(artifacts.quarantine)
      }
      if (!ops.moveExclusive(artifacts.quarantine, target)) {
        return JournalRecovery.Conflict(artifacts.quarantine)
      }
      ops.syncDirectory(targetRoot)
      deleteInternalIfRegular(artifacts.candidate)
      deleteJournal(artifacts.journal)
      return JournalRecovery.Continue
    }

    if (expectedLocal == null && quarantineKind == InstallerNodeKind.MISSING) {
      deleteInternalIfRegular(artifacts.candidate)
      deleteJournal(artifacts.journal)
      return JournalRecovery.Continue
    }

    return JournalRecovery.Conflict(firstPreservedFile(artifacts.quarantine, artifacts.candidate, previousStaged, artifacts.journal))
  }

  private fun preserveQuarantine(artifacts: InstallArtifacts, journal: InstallJournal): File {
    var preserved = journal.preservationPath?.let { path ->
      ops.canonical(File(path)).also { validatePreservationPath(it, artifacts) }
    }
    if (preserved == null) {
      preserved = nextPreservationPath(artifacts)
      writeJournal(artifacts.journal, journal.copy(preservationPath = preserved.path))
    }

    return when (ops.nodeKind(preserved)) {
      InstallerNodeKind.MISSING -> {
        if (ops.nodeKind(artifacts.quarantine) != InstallerNodeKind.REGULAR_FILE) {
          throw AttachmentInstallerFailure("Quarantined attachment generation is unavailable")
        }
        if (!ops.moveExclusive(artifacts.quarantine, preserved)) {
          throw AttachmentInstallerFailure("Attachment preservation path already exists")
        }
        ops.syncDirectory(targetRoot)
        preserved
      }
      InstallerNodeKind.REGULAR_FILE -> {
        if (ops.nodeKind(artifacts.quarantine) == InstallerNodeKind.REGULAR_FILE) {
          if (ops.sha256(artifacts.quarantine) != ops.sha256(preserved)) {
            throw AttachmentInstallerFailure("Attachment preservation generations diverged")
          }
          // Equal bytes are not an inode-identity proof. Retain the active
          // quarantine independently before clearing its installer-owned name.
          preserveActiveQuarantine(artifacts)
        }
        preserved
      }
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Attachment preservation path is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Attachment preservation path is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Attachment preservation path is not a regular file")
    }
  }

  private fun preserveActiveQuarantine(artifacts: InstallArtifacts): File {
    if (ops.nodeKind(artifacts.quarantine) != InstallerNodeKind.REGULAR_FILE) {
      throw AttachmentInstallerFailure("Quarantined attachment generation is unavailable")
    }
    val freshPreservation = nextPreservationPath(artifacts)
    if (!ops.moveExclusive(artifacts.quarantine, freshPreservation)) {
      throw AttachmentInstallerFailure("Attachment preservation path already exists")
    }
    ops.syncDirectory(targetRoot)
    return freshPreservation
  }

  private fun nextPreservationPath(artifacts: InstallArtifacts): File {
    for (attempt in 0 until 10_000) {
      val candidate = File(targetRoot, "${artifacts.preservationPrefix}$attempt")
      if (ops.nodeKind(candidate) == InstallerNodeKind.MISSING) return candidate
    }
    throw AttachmentInstallerFailure("No attachment preservation path is available")
  }

  private fun validatePreservationPath(file: File, artifacts: InstallArtifacts) {
    if (file.parentFile?.let(ops::canonical) != targetRoot || !file.name.startsWith(artifacts.preservationPrefix)) {
      throw AttachmentInstallerFailure("Attachment preservation path is outside the managed root")
    }
  }

  private fun prepareCleanArtifacts(artifacts: InstallArtifacts) {
    if (ops.nodeKind(artifacts.journal) != InstallerNodeKind.MISSING) {
      throw AttachmentInstallerFailure("Attachment install journal was not recovered")
    }
    when (ops.nodeKind(artifacts.quarantine)) {
      InstallerNodeKind.MISSING -> Unit
      InstallerNodeKind.REGULAR_FILE -> throw AttachmentInstallerFailure(
        "Unjournaled attachment quarantine is preserved at ${artifacts.quarantine.path}",
      )
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Attachment quarantine is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Attachment quarantine is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Attachment quarantine is not a regular file")
    }
    when (ops.nodeKind(artifacts.candidate)) {
      InstallerNodeKind.MISSING -> Unit
      InstallerNodeKind.REGULAR_FILE -> deleteInternalIfRegular(artifacts.candidate)
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Attachment candidate is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Attachment candidate is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Attachment candidate is not a regular file")
    }
  }

  private fun artifactsFor(target: File): InstallArtifacts {
    val digest = sha256(target.path.toByteArray(StandardCharsets.UTF_8)).take(32)
    return InstallArtifacts(
      journal = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$digest.journal"),
      candidate = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$digest.candidate"),
      quarantine = File(targetRoot, "$INSTALLER_ARTIFACT_PREFIX$digest.quarantine"),
      preservationPrefix = "$INSTALLER_PRESERVED_PREFIX$digest-",
    )
  }

  private fun validateTargetPath(target: File) {
    if (
      target.name.startsWith(INSTALLER_ARTIFACT_PREFIX)
      || target.name.startsWith(INSTALLER_PRESERVED_PREFIX)
      || target.name == INSTALLER_LOCK_NAME
    ) {
      throw AttachmentInstallerFailure("Target attachment name is reserved")
    }
    val parent = target.parentFile?.let(ops::canonical)
      ?: throw AttachmentInstallerFailure("Target attachment has no parent directory")
    if (parent != targetRoot) {
      throw AttachmentInstallerFailure("Target attachment is outside the managed attachment root")
    }
    requireDirectory(parent, "target attachment parent")
  }

  private fun validateSourcePath(staged: File) {
    validateSourceContainment(staged)
    requireRegularFile(staged, "staged attachment")
  }

  private fun validateSourceContainment(staged: File) {
    if (sourceRoots.none { staged == it || isDescendant(staged, it) }) {
      throw AttachmentInstallerFailure("Staged attachment is outside app-private managed roots")
    }
  }

  private fun isDescendant(file: File, root: File): Boolean =
    file.path.startsWith(root.path.trimEnd(File.separatorChar) + File.separator)

  private fun requireDirectory(file: File, label: String) {
    when (ops.nodeKind(file)) {
      InstallerNodeKind.DIRECTORY -> Unit
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("$label is a symbolic link")
      else -> throw AttachmentInstallerFailure("$label is unavailable")
    }
  }

  private fun requireRegularFile(file: File, label: String) {
    when (ops.nodeKind(file)) {
      InstallerNodeKind.REGULAR_FILE -> Unit
      InstallerNodeKind.MISSING -> throw AttachmentInstallerFailure("$label is missing")
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("$label is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("$label is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("$label is not a regular file")
    }
  }

  private fun rejectSymlinkInput(file: File, label: String) {
    if (ops.nodeKind(file) == InstallerNodeKind.SYMLINK) {
      throw AttachmentInstallerFailure("$label is a symbolic link")
    }
  }

  private fun requireRecoverableNode(file: File, label: String): InstallerNodeKind {
    return when (val kind = ops.nodeKind(file)) {
      InstallerNodeKind.MISSING, InstallerNodeKind.REGULAR_FILE -> kind
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("$label is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("$label is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("$label is not a regular file")
    }
  }

  private fun writeJournal(file: File, journal: InstallJournal) {
    val content = buildString {
      append("version=2\n")
      append("target=").append(encodeHex(journal.targetPath)).append('\n')
      append("staged=").append(encodeHex(journal.stagedPath)).append('\n')
      append("candidateSha256=").append(journal.candidateSha256).append('\n')
      append("expectedLocalSha256=").append(journal.expectedLocalSha256 ?: "-").append('\n')
      append("displacedSha256=").append(journal.displacedSha256 ?: "-").append('\n')
      append("preservationPath=").append(journal.preservationPath?.let(::encodeHex) ?: "-").append('\n')
    }
    ops.writeUtf8Durably(file, content)
  }

  private fun parseJournal(file: File): InstallJournal {
    val entries = linkedMapOf<String, String>()
    for (line in ops.readUtf8(file).lineSequence().filter(String::isNotBlank)) {
      val separator = line.indexOf('=')
      if (separator <= 0) throw AttachmentInstallerFailure("Attachment install journal is malformed")
      val key = line.substring(0, separator)
      if (entries.put(key, line.substring(separator + 1)) != null) {
        throw AttachmentInstallerFailure("Attachment install journal has duplicate fields")
      }
    }
    if (entries.keys != setOf(
        "version",
        "target",
        "staged",
        "candidateSha256",
        "expectedLocalSha256",
        "displacedSha256",
        "preservationPath",
      )) {
      throw AttachmentInstallerFailure("Attachment install journal fields are invalid")
    }
    if (entries["version"] != "2") throw AttachmentInstallerFailure("Attachment install journal version is unsupported")
    val candidateSha256 = entries.getValue("candidateSha256")
    val expectedLocalValue = entries.getValue("expectedLocalSha256")
    val displacedValue = entries.getValue("displacedSha256")
    if (!SHA256_HEX_PATTERN.matches(candidateSha256)) {
      throw AttachmentInstallerFailure("Attachment install journal candidate hash is invalid")
    }
    if (expectedLocalValue != "-" && !SHA256_HEX_PATTERN.matches(expectedLocalValue)) {
      throw AttachmentInstallerFailure("Attachment install journal expected-local hash is invalid")
    }
    if (displacedValue != "-" && !SHA256_HEX_PATTERN.matches(displacedValue)) {
      throw AttachmentInstallerFailure("Attachment install journal displaced hash is invalid")
    }
    return InstallJournal(
      targetPath = decodeHex(entries.getValue("target")),
      stagedPath = decodeHex(entries.getValue("staged")),
      candidateSha256 = candidateSha256,
      expectedLocalSha256 = expectedLocalValue.takeUnless { it == "-" },
      displacedSha256 = displacedValue.takeUnless { it == "-" },
      preservationPath = entries.getValue("preservationPath").takeUnless { it == "-" }?.let(::decodeHex),
    )
  }

  private fun encodeHex(value: String): String = value.toByteArray(StandardCharsets.UTF_8)
    .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun decodeHex(value: String): String {
    if (value.length % 2 != 0 || !value.matches(Regex("^[a-f0-9]*$"))) {
      throw AttachmentInstallerFailure("Attachment install journal path is invalid")
    }
    val bytes = ByteArray(value.length / 2)
    for (index in bytes.indices) {
      bytes[index] = value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
    return String(bytes, StandardCharsets.UTF_8)
  }

  private fun deleteInternalIfRegular(file: File) {
    when (ops.nodeKind(file)) {
      InstallerNodeKind.MISSING -> Unit
      InstallerNodeKind.REGULAR_FILE -> {
        ops.delete(file)
        ops.syncDirectory(targetRoot)
      }
      InstallerNodeKind.DIRECTORY -> throw AttachmentInstallerFailure("Installer artifact is a directory")
      InstallerNodeKind.SYMLINK -> throw AttachmentInstallerFailure("Installer artifact is a symbolic link")
      InstallerNodeKind.OTHER -> throw AttachmentInstallerFailure("Installer artifact is not a regular file")
    }
  }

  private fun deleteJournal(file: File) = deleteInternalIfRegular(file)

  private fun deleteStagedBestEffort(staged: File, expectedSha256: String? = null) {
    try {
      if (ops.nodeKind(staged) != InstallerNodeKind.REGULAR_FILE) return
      if (expectedSha256 != null && ops.sha256(staged) != expectedSha256) return
      ops.delete(staged)
      staged.parentFile?.let(ops::syncDirectory)
    } catch (_: Throwable) {
      // The canonical target is already durable. Leaving a private staged copy
      // is safer than downgrading a completed install into an ambiguous retry.
    }
  }

  private fun firstPreservedFile(vararg files: File): File =
    files.firstOrNull { ops.nodeKind(it) == InstallerNodeKind.REGULAR_FILE }
      ?: throw AttachmentInstallerFailure("No attachment generation remains available for recovery")
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
  .digest(bytes)
  .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
