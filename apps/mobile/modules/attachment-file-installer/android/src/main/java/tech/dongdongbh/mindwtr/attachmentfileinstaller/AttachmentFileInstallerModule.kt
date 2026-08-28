package tech.dongdongbh.mindwtr.attachmentfileinstaller

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

private class AttachmentFileInstallerException(message: String, cause: Throwable? = null) :
  CodedException("ATTACHMENT_FILE_INSTALLER_FAILED: $message", cause)

private object ExactAttachmentPublisherNative {
  init {
    System.loadLibrary("attachment-file-installer")
  }

  external fun publishRelativeNoReplace(
    sourceFd: Int,
    privateDirectoryPath: String,
    targetDirectoryPath: String,
    targetName: String,
    expectedSourceIdentity: String,
    expectedPrivateDirectoryIdentity: String,
    expectedTargetDirectoryIdentity: String,
  ): Boolean
}

private class AndroidAttachmentInstallerFileOps : AttachmentInstallerFileOps {
  override fun canonical(file: File): File = file.canonicalFile

  override fun ensureDirectory(directory: File) {
    if (!directory.exists() && !directory.mkdirs()) {
      throw AttachmentInstallerFailure("Managed attachment root could not be created")
    }
  }

  override fun ensurePrivateDirectory(directory: File) {
    try {
      Os.mkdir(directory.path, 0x1c0)
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.EEXIST) {
        throw AttachmentInstallerFailure("Could not create private attachment recovery directory", error)
      }
    }
    if (nodeKind(directory) != InstallerNodeKind.DIRECTORY) {
      throw AttachmentInstallerFailure("Attachment recovery path is not a directory")
    }
    try {
      Os.chmod(directory.path, 0x1c0)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not restrict attachment recovery directory", error)
    }
  }

  override fun createPrivateDirectoryExclusive(directory: File) {
    try {
      Os.mkdir(directory.path, 0x1c0)
      Os.chmod(directory.path, 0x1c0)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not create private attachment publication directory", error)
    }
  }

  override fun createNewRegularFile(file: File) {
    val descriptor = try {
      Os.open(
        file.path,
        OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW,
        0x180,
      )
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not create private attachment publication stage", error)
    }
    try {
      Os.fsync(descriptor)
    } finally {
      Os.close(descriptor)
    }
  }

  override fun nodeKind(file: File): InstallerNodeKind {
    val stat = try {
      Os.lstat(file.path)
    } catch (error: ErrnoException) {
      if (error.errno == OsConstants.ENOENT) return InstallerNodeKind.MISSING
      throw AttachmentInstallerFailure("Could not inspect ${file.path}", error)
    }
    return when {
      OsConstants.S_ISLNK(stat.st_mode) -> InstallerNodeKind.SYMLINK
      OsConstants.S_ISREG(stat.st_mode) -> InstallerNodeKind.REGULAR_FILE
      OsConstants.S_ISDIR(stat.st_mode) -> InstallerNodeKind.DIRECTORY
      else -> InstallerNodeKind.OTHER
    }
  }

  override fun nodeIdentity(file: File): String {
    val stat = try {
      Os.lstat(file.path)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not inspect attachment node identity", error)
    }
    return "${stat.st_dev}:${stat.st_ino}"
  }

  override fun fileIdentity(file: File): AttachmentFileIdentity {
    val stat = try {
      Os.lstat(file.path)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not inspect attachment identity", error)
    }
    if (!OsConstants.S_ISREG(stat.st_mode)) {
      throw AttachmentInstallerFailure("Attachment path is not a regular file")
    }
    return AttachmentFileIdentity(
      fileKey = "${stat.st_dev}:${stat.st_ino}",
      size = stat.st_size,
      modificationTimeNs = stat.st_mtim.tv_sec * 1_000_000_000L + stat.st_mtim.tv_nsec,
      changeTimeNs = stat.st_ctim.tv_sec * 1_000_000_000L + stat.st_ctim.tv_nsec,
    )
  }

  override fun copySnapshot(source: File, destination: File) {
    val outputDescriptor = try {
      Os.open(
        destination.path,
        OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW,
        0x180,
      )
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Installer candidate already exists", error)
    }
    try {
      FileOutputStream(outputDescriptor).use { output ->
        openRegularInput(source).use { input ->
          input.copyTo(output)
          output.fd.sync()
        }
      }
      destination.parentFile?.let(::syncDirectory)
    } catch (error: Throwable) {
      try {
        destination.delete()
      } catch (_: Throwable) {
      }
      throw AttachmentInstallerFailure("Could not snapshot staged attachment", error)
    }
  }

  override fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    openRegularInput(file).use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
  }

  override fun moveExclusive(source: File, destination: File): Boolean {
    try {
      Os.link(source.path, destination.path)
    } catch (error: ErrnoException) {
      if (error.errno == OsConstants.EEXIST) return false
      throw AttachmentInstallerFailure("Could not publish attachment generation", error)
    }
    try {
      Os.remove(source.path)
    } catch (error: Throwable) {
      // Both hard links intentionally remain. The durable journal lets the
      // next invocation prove which generation each path contains.
      throw AttachmentInstallerFailure("Published attachment generation could not release its old path", error)
    }
    return true
  }

  override fun publishVerifiedImmutable(
    source: File,
    destination: File,
    expectedSha256: String,
    expectedSourceIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String,
  ): ImmutableAttachmentPublishOutcome {
    val privateDirectory = source.parentFile
      ?: throw AttachmentInstallerFailure("Private attachment publication directory is unavailable")
    val targetDirectory = destination.parentFile
      ?: throw AttachmentInstallerFailure("Attachment target directory is unavailable")
    if (
      nodeIdentity(targetDirectory) != expectedDirectoryIdentity
      || nodeIdentity(privateDirectory) != expectedPrivateDirectoryIdentity
    ) {
      throw AttachmentInstallerFailure("Attachment publication directory identity changed")
    }
    val descriptor = try {
      ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_WRITE)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not retain private attachment stage handle", error)
    }
    descriptor.use { retained ->
      val before = Os.fstat(retained.fileDescriptor)
      if (!OsConstants.S_ISREG(before.st_mode)) {
        throw AttachmentInstallerFailure("Immutable attachment stage is not a regular file")
      }
      val digest = MessageDigest.getInstance("SHA-256")
      ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(retained.fileDescriptor)).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count > 0) digest.update(buffer, 0, count)
        }
      }
      val after = Os.fstat(retained.fileDescriptor)
      val actualSha256 = digest.digest().joinToString(separator = "") { byte ->
        "%02x".format(byte.toInt() and 0xff)
      }
      if (
        before.st_dev != after.st_dev
        || before.st_ino != after.st_ino
        || before.st_size != after.st_size
        || actualSha256 != expectedSha256
        || "${after.st_dev}:${after.st_ino}" != expectedSourceIdentity
      ) {
        throw AttachmentInstallerFailure("Staged attachment changed before native publication")
      }
      Os.fsync(retained.fileDescriptor)
      if (
        nodeIdentity(targetDirectory) != expectedDirectoryIdentity
        || nodeIdentity(privateDirectory) != expectedPrivateDirectoryIdentity
      ) {
        throw AttachmentInstallerFailure("Attachment publication directory identity changed")
      }
      val published = try {
        ExactAttachmentPublisherNative.publishRelativeNoReplace(
          retained.fd,
          privateDirectory.path,
          targetDirectory.path,
          destination.name,
          expectedSourceIdentity,
          expectedPrivateDirectoryIdentity,
          expectedDirectoryIdentity,
        )
      } catch (error: Throwable) {
        throw AttachmentInstallerFailure("Could not publish exact attachment stage", error)
      }
      if (!published) return ImmutableAttachmentPublishOutcome.ALREADY_EXISTS
    }
    return ImmutableAttachmentPublishOutcome.PUBLISHED
  }

  override fun delete(file: File) {
    try {
      Os.remove(file.path)
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.ENOENT) {
        throw AttachmentInstallerFailure("Could not remove installer artifact", error)
      }
    }
  }

  override fun deleteEmptyDirectory(directory: File) = delete(directory)

  override fun readUtf8(file: File): String = file.readText(Charsets.UTF_8)

  override fun writeUtf8Durably(file: File, content: String) {
    val temporary = File(file.parentFile, "${file.name}.write-${UUID.randomUUID()}")
    try {
      FileOutputStream(temporary).use { output ->
        output.write(content.toByteArray(Charsets.UTF_8))
        output.fd.sync()
      }
      Os.rename(temporary.path, file.path)
      file.parentFile?.let(::syncDirectory)
    } catch (error: Throwable) {
      try {
        temporary.delete()
      } catch (_: Throwable) {
      }
      throw AttachmentInstallerFailure("Could not persist attachment install journal", error)
    }
  }

  override fun syncDirectory(directory: File) {
    val descriptor = try {
      Os.open(directory.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not open attachment directory for durability", error)
    }
    try {
      if (!OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode)) {
        throw AttachmentInstallerFailure("Attachment durability path is not a directory")
      }
      Os.fsync(descriptor)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not sync attachment directory", error)
    } finally {
      Os.close(descriptor)
    }
  }

  override fun <T> withExclusiveLock(lockFile: File, action: () -> T): T {
    val descriptor = try {
      Os.open(
        lockFile.path,
        OsConstants.O_CREAT or OsConstants.O_RDWR or OsConstants.O_NOFOLLOW,
        0x180,
      )
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not open attachment installer lock", error)
    }
    FileOutputStream(descriptor).use { owner ->
      val lock = try {
        owner.channel.lock()
      } catch (error: Throwable) {
        throw AttachmentInstallerFailure("Could not acquire attachment installer lock", error)
      }
      lock.use { return action() }
    }
  }

  private fun openRegularInput(file: File): FileInputStream {
    val descriptor = try {
      Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not open regular attachment file", error)
    }
    try {
      if (!OsConstants.S_ISREG(Os.fstat(descriptor).st_mode)) {
        throw AttachmentInstallerFailure("Attachment path is not a regular file")
      }
      return FileInputStream(descriptor)
    } catch (error: Throwable) {
      Os.close(descriptor)
      throw error
    }
  }
}

class AttachmentFileInstallerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("AttachmentFileInstaller")

    AsyncFunction("installAsync") {
        stagedPath: String,
        targetPath: String,
        expected: Map<String, String>,
        expectedDownloadSha256: String,
      ->
      try {
        val filesRoot = context.filesDir.canonicalFile
        val cacheRoot = context.cacheDir.canonicalFile
        val installer = AttachmentFileInstallerCore(
          targetRoot = File(filesRoot, "attachments"),
          sourceRoots = listOf(filesRoot, cacheRoot),
          ops = AndroidAttachmentInstallerFileOps(),
        )
        val outcome = installer.install(
          stagedInput = fileFromPath(stagedPath),
          targetInput = fileFromPath(targetPath),
          expected = parseExpected(expected),
          expectedDownloadSha256 = parseSha256(expectedDownloadSha256, "Expected download"),
        )
        when (outcome) {
          is AttachmentInstallOutcome.Installed -> buildMap {
            put("status", "installed")
            outcome.preservedFile?.let { put("preservedPath", Uri.fromFile(it).toString()) }
          }
          is AttachmentInstallOutcome.Conflict -> mapOf(
            "status" to "conflict",
            "preservedPath" to Uri.fromFile(outcome.preservedFile).toString(),
          )
        }
      } catch (error: AttachmentFileInstallerException) {
        throw error
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(error.message ?: "Attachment install failed", error)
      }
    }

    AsyncFunction("publishImmutableAsync") {
        stagedPath: String,
        targetPath: String,
        expectedStagedSha256: String,
        expectedStagedIdentity: String,
        expectedDirectoryIdentity: String,
        expectedPrivateDirectoryIdentity: String,
      ->
      try {
        val staged = fileFromPath(stagedPath).absoluteFile
        val target = fileFromPath(targetPath).absoluteFile
        val targetRoot = target.parentFile
          ?: throw AttachmentFileInstallerException("Target attachment parent is unavailable")
        val stagedRoot = staged.parentFile
          ?: throw AttachmentFileInstallerException("Staged attachment parent is unavailable")
        if (stagedRoot.parentFile?.canonicalFile != targetRoot.canonicalFile) {
          throw AttachmentFileInstallerException(
            "Immutable attachment stage must use a private child of the target directory",
          )
        }
        val outcome = ImmutableAttachmentFilePublisherCore(
          targetRoot = targetRoot,
          ops = AndroidAttachmentInstallerFileOps(),
        ).publish(
          staged,
          target,
          parseSha256(expectedStagedSha256, "Expected staged attachment"),
          expectedStagedIdentity,
          expectedDirectoryIdentity,
          expectedPrivateDirectoryIdentity,
        )
        when (outcome) {
          ImmutableAttachmentPublishOutcome.PUBLISHED -> mapOf("status" to "published")
          ImmutableAttachmentPublishOutcome.ALREADY_EXISTS -> mapOf("status" to "alreadyExists")
        }
      } catch (error: AttachmentFileInstallerException) {
        throw error
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(
          error.message ?: "Immutable attachment publication failed",
          error,
        )
      }
    }

    AsyncFunction("prepareImmutableStageAsync") { targetPath: String, operationId: String ->
      try {
        val target = fileFromPath(targetPath).absoluteFile
        val targetRoot = target.parentFile
          ?: throw AttachmentFileInstallerException("Target attachment parent is unavailable")
        val prepared = ImmutableAttachmentStageRecoveryCore(
          targetRoot,
          AndroidAttachmentInstallerFileOps(),
        ).prepare(target, operationId)
        mapOf(
          "stagedPath" to Uri.fromFile(prepared.stagedPath).toString(),
          "stagedIdentity" to prepared.stagedIdentity,
          "directoryIdentity" to prepared.directoryIdentity,
          "privateDirectoryIdentity" to prepared.privateDirectoryIdentity,
        )
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(error.message ?: "Attachment stage preparation failed", error)
      }
    }

    AsyncFunction("snapshotImmutableStageAsync") {
        stagedPath: String,
        targetPath: String,
        expectedStagedSha256: String,
      ->
      try {
        val staged = fileFromPath(stagedPath).absoluteFile
        val target = fileFromPath(targetPath).absoluteFile
        val targetRoot = target.parentFile
          ?: throw AttachmentFileInstallerException("Target attachment parent is unavailable")
        val identity = ImmutableAttachmentStageRecoveryCore(
          targetRoot,
          AndroidAttachmentInstallerFileOps(),
        ).snapshot(staged, target, parseSha256(expectedStagedSha256, "Expected staged attachment"))
        mapOf(
          "stagedIdentity" to identity.stagedIdentity,
          "directoryIdentity" to identity.directoryIdentity,
        )
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(error.message ?: "Attachment stage snapshot failed", error)
      }
    }

    AsyncFunction("cleanupImmutableStageAsync") {
        stagedPath: String,
        targetPath: String,
        operationId: String,
        expectedStagedSha256: String?,
        expectedStagedIdentity: String?,
        expectedDirectoryIdentity: String?,
        expectedPrivateDirectoryIdentity: String?,
      ->
      try {
        val staged = fileFromPath(stagedPath).absoluteFile
        val target = fileFromPath(targetPath).absoluteFile
        val targetRoot = target.parentFile
          ?: throw AttachmentFileInstallerException("Target attachment parent is unavailable")
        val outcome = ImmutableAttachmentStageRecoveryCore(
          targetRoot,
          AndroidAttachmentInstallerFileOps(),
        ).cleanup(
          staged,
          target,
          operationId,
          expectedStagedSha256,
          expectedStagedIdentity,
          expectedDirectoryIdentity,
          expectedPrivateDirectoryIdentity,
        )
        mapOf("status" to when (outcome) {
          ImmutableAttachmentStageCleanupOutcome.REMOVED -> "removed"
          ImmutableAttachmentStageCleanupOutcome.MISSING -> "missing"
          ImmutableAttachmentStageCleanupOutcome.CONFLICT -> "conflict"
        })
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(error.message ?: "Attachment stage cleanup failed", error)
      }
    }

    AsyncFunction("hashAsync") { targetPath: String ->
      try {
        val filesRoot = context.filesDir.canonicalFile
        val ops = AndroidAttachmentInstallerFileOps()
        val snapshot = AttachmentFileHasherCore(
          targetRoot = File(filesRoot, "attachments"),
          ops = ops,
        ).hash(fileFromPath(targetPath))
        mapOf(
          "sha256" to snapshot.sha256,
          "size" to snapshot.size.toDouble(),
          "modificationTimeMs" to snapshot.modificationTimeMs,
        )
      } catch (error: AttachmentFileInstallerException) {
        throw error
      } catch (error: Throwable) {
        throw AttachmentFileInstallerException(error.message ?: "Attachment hash failed", error)
      }
    }
  }

  private fun fileFromPath(value: String): File {
    if (value.isBlank()) throw AttachmentFileInstallerException("Attachment path is required")
    val uri = Uri.parse(value)
    return when (uri.scheme?.lowercase()) {
      null, "" -> File(value)
      "file" -> File(uri.path ?: throw AttachmentFileInstallerException("Invalid file URI"))
      else -> throw AttachmentFileInstallerException("Only app-private file paths are supported")
    }
  }

  private fun parseExpected(value: Map<String, String>): ExpectedAttachmentGeneration {
    return when (value["kind"]) {
      "absent" -> ExpectedAttachmentGeneration.Absent
      "present" -> {
        val digest = parseSha256(value["sha256"].orEmpty(), "Expected attachment")
        ExpectedAttachmentGeneration.Present(digest)
      }
      else -> throw AttachmentFileInstallerException("Expected attachment generation is invalid")
    }
  }

  private fun parseSha256(value: String, label: String): String {
    val digest = value.trim().lowercase()
    if (!SHA256_HEX_PATTERN.matches(digest)) {
      throw AttachmentFileInstallerException("$label SHA-256 is invalid")
    }
    return digest
  }
}
