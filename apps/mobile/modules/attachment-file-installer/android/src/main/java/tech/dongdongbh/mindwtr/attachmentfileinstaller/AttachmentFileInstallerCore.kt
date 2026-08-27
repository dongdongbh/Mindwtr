package tech.dongdongbh.mindwtr.attachmentfileinstaller

import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal const val INSTALLER_ARTIFACT_PREFIX = ".mindwtr-install-"
internal const val INSTALLER_LOCK_NAME = ".mindwtr-attachment-installer.lock"
internal const val INSTALLER_PRESERVED_PREFIX = ".mindwtr-preserved-"
internal val SHA256_HEX_PATTERN = Regex("^[a-f0-9]{64}$")

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

internal interface AttachmentInstallerFileOps {
  fun canonical(file: File): File
  fun ensureDirectory(directory: File)
  fun nodeKind(file: File): InstallerNodeKind
  fun copySnapshot(source: File, destination: File)
  fun sha256(file: File): String
  /** Move without replacing destination. False means destination already exists. */
  fun moveExclusive(source: File, destination: File): Boolean
  fun delete(file: File)
  fun readUtf8(file: File): String
  fun writeUtf8Durably(file: File, content: String)
  fun syncDirectory(directory: File)
  fun <T> withExclusiveLock(lockFile: File, action: () -> T): T
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
