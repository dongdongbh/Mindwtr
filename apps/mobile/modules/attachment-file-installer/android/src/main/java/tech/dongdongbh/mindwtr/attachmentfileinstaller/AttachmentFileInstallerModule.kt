package tech.dongdongbh.mindwtr.attachmentfileinstaller

import android.content.Context
import android.net.Uri
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

private class AndroidAttachmentInstallerFileOps : AttachmentInstallerFileOps {
  override fun canonical(file: File): File = file.canonicalFile

  override fun ensureDirectory(directory: File) {
    if (!directory.exists() && !directory.mkdirs()) {
      throw AttachmentInstallerFailure("Managed attachment root could not be created")
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

  override fun delete(file: File) {
    try {
      Os.remove(file.path)
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.ENOENT) {
        throw AttachmentInstallerFailure("Could not remove installer artifact", error)
      }
    }
  }

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
        )
        when (outcome) {
          AttachmentInstallOutcome.Installed -> mapOf("status" to "installed")
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
        val digest = value["sha256"]?.trim()?.lowercase().orEmpty()
        if (!SHA256_HEX_PATTERN.matches(digest)) {
          throw AttachmentFileInstallerException("Expected attachment SHA-256 is invalid")
        }
        ExpectedAttachmentGeneration.Present(digest)
      }
      else -> throw AttachmentFileInstallerException("Expected attachment generation is invalid")
    }
  }
}
