package tech.dongdongbh.mindwtr.attachmentfileinstaller

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID


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

  external fun retireEmptyDirectoryIfIdentity(
    parentDirectoryPath: String,
    directoryName: String,
    expectedDirectoryIdentity: String,
    expectedParentIdentity: String,
  ): Int

  external fun retireReservedPrivateStage(
    parentDirectoryPath: String,
    directoryName: String,
  ): Int
}


internal sealed class LinkAttemptOutcome {
  data object Linked : LinkAttemptOutcome()
  data object AlreadyExists : LinkAttemptOutcome()
  data class Retry(val errno: Int, val cause: ErrnoException) : LinkAttemptOutcome()
  data class Failed(val errno: Int, val cause: ErrnoException) : LinkAttemptOutcome()
}


internal sealed class CopyExclusiveOutcome {
  data object Published : CopyExclusiveOutcome()
  data object AlreadyExists : CopyExclusiveOutcome()
  data class Failed(val errno: Int?, val cause: Throwable) : CopyExclusiveOutcome()
}

internal class AndroidAttachmentInstallerFileOps : AttachmentInstallerFileOps {
  internal var usedExclusiveCopyFallback = false
    private set

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


  internal var linkFile: (source: File, destination: File) -> LinkAttemptOutcome = ::realLinkFile

  private fun realLinkFile(source: File, destination: File): LinkAttemptOutcome {
    return try {
      Os.link(source.path, destination.path)
      LinkAttemptOutcome.Linked
    } catch (error: ErrnoException) {
      when (error.errno) {
        OsConstants.EEXIST -> LinkAttemptOutcome.AlreadyExists
        OsConstants.EXDEV, OsConstants.EPERM, OsConstants.EOPNOTSUPP, OsConstants.ENOTSUP, OsConstants.EACCES ->
          LinkAttemptOutcome.Retry(error.errno, error)
        else -> LinkAttemptOutcome.Failed(error.errno, error)
      }
    }
  }


  internal var copyExclusive: (source: File, destination: File) -> CopyExclusiveOutcome = ::realCopyExclusive

  private fun realCopyExclusive(source: File, destination: File): CopyExclusiveOutcome {
    val descriptor = try {
      Os.open(
        destination.path,
        OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW,
        0x180,
      )
    } catch (error: ErrnoException) {
      return if (error.errno == OsConstants.EEXIST) {
        CopyExclusiveOutcome.AlreadyExists
      } else {
        CopyExclusiveOutcome.Failed(error.errno, error)
      }
    }
    try {
      FileOutputStream(descriptor).use { output ->
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
      return CopyExclusiveOutcome.Failed(null, error)
    }
    try {
      Os.remove(source.path)
    } catch (_: Throwable) {


    }
    return CopyExclusiveOutcome.Published
  }


  internal var errnoName: (Int) -> String? = OsConstants::errnoName

  private fun describeErrno(errno: Int): String = errnoName(errno) ?: "errno $errno"

  override fun moveExclusive(source: File, destination: File): Boolean {
    return when (val attempt = linkFile(source, destination)) {
      LinkAttemptOutcome.AlreadyExists -> false
      LinkAttemptOutcome.Linked -> {
        try {
          Os.remove(source.path)
        } catch (error: Throwable) {


          throw AttachmentInstallerFailure("Published attachment generation could not release its old path", error)
        }
        true
      }
      is LinkAttemptOutcome.Retry -> {
        when (val copied = copyExclusive(source, destination)) {
          CopyExclusiveOutcome.AlreadyExists -> false
          CopyExclusiveOutcome.Published -> {
            usedExclusiveCopyFallback = true
            true
          }
          is CopyExclusiveOutcome.Failed -> throw AttachmentInstallerFailure(
            "Could not publish attachment generation (${copied.errno?.let(::describeErrno) ?: "copy failed"})",
            copied.cause,
          )
        }
      }
      is LinkAttemptOutcome.Failed -> throw AttachmentInstallerFailure(
        "Could not publish attachment generation (${describeErrno(attempt.errno)})",
        attempt.cause,
      )
    }
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

  override fun retireEmptyDirectoryIfIdentity(
    directory: File,
    expectedIdentity: String,
    expectedParentIdentity: String,
  ): ImmutableAttachmentStageCleanupOutcome {
    val parent = directory.parentFile
      ?: throw AttachmentInstallerFailure("Private attachment publication parent is unavailable")
    val nativeOutcome = try {
      ExactAttachmentPublisherNative.retireEmptyDirectoryIfIdentity(
        parent.path,
        directory.name,
        expectedIdentity,
        expectedParentIdentity,
      )
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not retire private attachment publication directory", error)
    }
    return when (nativeOutcome) {
      0 -> ImmutableAttachmentStageCleanupOutcome.REMOVED
      1 -> ImmutableAttachmentStageCleanupOutcome.MISSING
      2 -> ImmutableAttachmentStageCleanupOutcome.CONFLICT
      else -> throw AttachmentInstallerFailure("Native attachment directory retirement returned an invalid outcome")
    }
  }

  override fun retireReservedPrivateStage(
    directory: File,
  ): ImmutableAttachmentStageCleanupOutcome {
    val parent = directory.parentFile
      ?: throw AttachmentInstallerFailure("Private attachment publication parent is unavailable")
    val nativeOutcome = try {
      ExactAttachmentPublisherNative.retireReservedPrivateStage(
        parent.path,
        directory.name,
      )
    } catch (error: Throwable) {
      throw AttachmentInstallerFailure("Could not retire reserved private attachment stage", error)
    }
    return when (nativeOutcome) {
      0 -> ImmutableAttachmentStageCleanupOutcome.REMOVED
      1 -> ImmutableAttachmentStageCleanupOutcome.MISSING
      2 -> ImmutableAttachmentStageCleanupOutcome.CONFLICT
      else -> throw AttachmentInstallerFailure("Native reserved attachment retirement returned an invalid outcome")
    }
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
