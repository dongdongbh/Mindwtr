package tech.dongdongbh.mindwtr.syncfilelock

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.security.MessageDigest
import java.util.UUID

private const val LOCK_NAME = ".mindwtr.lock"
private const val MAX_LOCK_DOCUMENT_CREATE_ATTEMPTS = 3
private const val LOG_TAG = "SyncFileLock"
private const val LOCK_IDENTITY_LOST_CODE = "SYNC_FILE_LOCK_IDENTITY_LOST"

internal class SyncFileLockUnavailableException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

internal data class HeldSyncFileLock(
  val lock: FileLock?,
  val channel: FileChannel?,
  val closeOwner: AutoCloseable,
  val descriptorOwner: AutoCloseable? = null,
  val stableAuthority: StableSyncAuthority? = null,
  val revalidateLegacy: (() -> Unit)? = null,
  val releaseNativeLock: (() -> Unit)? = null,
) {
  fun revalidate() {
    stableAuthority?.revalidate()
      ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: stable root authority is missing")
    revalidateLegacy?.invoke()
      ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: lock identity validator is missing")
  }

  fun close() {
    try {
      if (releaseNativeLock != null) releaseNativeLock.invoke() else lock?.release()
    } finally {
      try {
        channel?.close()
      } finally {
        try {
          closeOwner.close()
        } finally {
          try {
            descriptorOwner?.close()
          } finally {
            stableAuthority?.close()
          }
        }
      }
    }
  }
}

internal data class SyncFileNodeIdentity(val device: Long, val inode: Long)

internal interface StableSyncAuthority : AutoCloseable {
  fun revalidate()
}

internal object StableRootLockNative {
  init {
    System.loadLibrary("sync-file-lock")
  }

  external fun tryLock(fd: Int): Int
  external fun unlock(fd: Int): Int
  external fun tryOfdLock(fd: Int): Int
  external fun unlockOfdLock(fd: Int): Int
}

private fun descriptorIdentity(descriptor: java.io.FileDescriptor): SyncFileNodeIdentity {
  val stat = Os.fstat(descriptor)
  return SyncFileNodeIdentity(stat.st_dev, stat.st_ino)
}

private fun pathIdentity(path: File, requireDirectory: Boolean): SyncFileNodeIdentity {
  val stat = try {
    Os.lstat(path.absolutePath)
  } catch (error: Throwable) {
    throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: lease authority is unavailable", error)
  }
  val kindOk = if (requireDirectory) OsConstants.S_ISDIR(stat.st_mode) else OsConstants.S_ISREG(stat.st_mode)
  if (!kindOk || OsConstants.S_ISLNK(stat.st_mode)) {
    throw SyncFileLockUnavailableException(
      "SYNC_FILE_LOCK_UNAVAILABLE: lease authority is a symlink or unexpected node",
    )
  }
  return SyncFileNodeIdentity(stat.st_dev, stat.st_ino)
}

private class PathRootStableAuthority(
  private val directory: File,
  private val descriptor: ParcelFileDescriptor,
  private val identity: SyncFileNodeIdentity,
) : StableSyncAuthority {
  override fun revalidate() {
    if (pathIdentity(directory, true) != identity || descriptorIdentity(descriptor.fileDescriptor) != identity) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: sync root identity changed")
    }
  }

  override fun close() {
    try {
      val result = StableRootLockNative.unlock(descriptor.fd)
      if (result != 0) {
        Log.w(LOG_TAG, "Failed to release stable File Sync root authority (errno=$result)")
      }
    } finally {
      descriptor.close()
    }
  }
}

private class PrivateFileStableAuthority(
  private val path: File,
  private val owner: RandomAccessFile,
  private val lock: FileLock,
  private val identity: SyncFileNodeIdentity,
) : StableSyncAuthority {
  override fun revalidate() {
    if (pathIdentity(path, false) != identity || descriptorIdentity(owner.fd) != identity) {
      throw SyncFileLockUnavailableException("$LOCK_IDENTITY_LOST_CODE: private SAF authority changed")
    }
  }

  override fun close() {
    try {
      lock.release()
    } finally {
      try {
        owner.channel.close()
      } finally {
        owner.close()
      }
    }
  }
}

internal fun acquirePrivateFileStableAuthority(path: File): StableSyncAuthority {
  path.parentFile?.let { parent ->
    if (!parent.isDirectory && !parent.mkdirs()) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot create private authority")
    }
  }
  val owner = try {
    RandomAccessFile(path, "rw")
  } catch (error: Throwable) {
    throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot open private authority", error)
  }
  val identity = try {
    val opened = descriptorIdentity(owner.fd)
    if (pathIdentity(path, false) != opened) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: private authority changed")
    }
    opened
  } catch (error: Throwable) {
    owner.close()
    throw error
  }
  val lock = try {
    owner.channel.tryLock()
  } catch (_: OverlappingFileLockException) {
    null
  } catch (error: Throwable) {
    owner.close()
    throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot lock private authority", error)
  }
  if (lock == null) {
    owner.close()
    throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_BUSY: another File Sync operation is active")
  }
  return PrivateFileStableAuthority(path, owner, lock, identity).also { it.revalidate() }
}

internal fun selectStableSyncAuthority(
  saf: Boolean,
  acquirePathRoot: () -> StableSyncAuthority,
  acquirePrivateSaf: () -> StableSyncAuthority,
): StableSyncAuthority = if (saf) acquirePrivateSaf() else acquirePathRoot()

internal data class CreatedLockDocument(
  val uri: String,
  val displayName: String?,
)

/**
 * Resolve the one exact lock document without ever deleting a document that
 * this invocation did not create. Some providers permit duplicate display
 * names, so a first-use race can leave both peers visible after create.
 */
internal fun resolveExactLockDocument(
  listExactDocuments: () -> List<String>,
  createDocument: () -> CreatedLockDocument,
  deleteOwnedDocument: (String) -> Boolean,
  maxCreateAttempts: Int = MAX_LOCK_DOCUMENT_CREATE_ATTEMPTS,
): String {
  fun inventory(): List<String> = listExactDocuments().distinct()

  var matches = inventory()
  if (matches.size == 1) {
    return matches.single()
  }
  if (matches.size > 1) {
    throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME is ambiguous")
  }

  repeat(maxCreateAttempts) {
    val created = createDocument()
    matches = if (created.displayName == LOCK_NAME) inventory() else emptyList()
    if (matches.size == 1 && matches.single() == created.uri) {
      return created.uri
    }

    // The returned URI is the only document whose ownership is proven. If a
    // peer appeared, or the provider rewrote the display name, remove only our
    // creation before deciding whether the peer is now uniquely lockable.
    val deleted = try {
      deleteOwnedDocument(created.uri)
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: cannot remove the newly created lock document",
        error,
      )
    }
    if (!deleted) {
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: provider did not remove the newly created lock document",
      )
    }

    matches = inventory()
    if (matches.size == 1 && matches.single() != created.uri) {
      return matches.single()
    }
    if (matches.size > 1) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME is ambiguous")
    }
  }

  throw SyncFileLockUnavailableException(
    "SYNC_FILE_LOCK_UNAVAILABLE: provider did not create an exact $LOCK_NAME document",
  )
}

internal fun drainHeldSyncFileLocks(heldLocks: MutableMap<String, HeldSyncFileLock>): List<Throwable> {
  val locks = heldLocks.values.toList()
  heldLocks.clear()
  return buildList {
    for (held in locks) {
      try {
        held.close()
      } catch (error: Throwable) {
        add(error)
      }
    }
  }
}

class SyncFileLockModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val heldLocks = mutableMapOf<String, HeldSyncFileLock>()
  private val stateGuard = Any()
  private var destroyed = false

  private fun acquireChannelLock(
    channel: FileChannel,
    closeOwner: AutoCloseable,
    descriptorOwner: AutoCloseable? = null,
    stableAuthority: StableSyncAuthority,
    revalidateLegacy: () -> Unit,
  ): HeldSyncFileLock {
    val lock = try {
      channel.tryLock()
    } catch (error: OverlappingFileLockException) {
      null
    } catch (error: Throwable) {
      try {
        closeOwner.close()
      } finally {
        try {
          descriptorOwner?.close()
        } finally {
          stableAuthority.close()
        }
      }
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: this storage provider cannot take an exclusive lock on $LOCK_NAME",
        error,
      )
    }
    if (lock == null) {
      try {
        closeOwner.close()
      } finally {
        try {
          descriptorOwner?.close()
        } finally {
          stableAuthority.close()
        }
      }
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_BUSY: another File Sync operation is active")
    }
    val held = HeldSyncFileLock(
      lock,
      channel,
      closeOwner,
      descriptorOwner,
      stableAuthority,
      revalidateLegacy,
    )
    try {
      held.revalidate()
    } catch (error: Throwable) {
      held.close()
      throw error
    }
    return held
  }

  private fun acquirePathRootAuthority(directory: File): StableSyncAuthority {
    val expected = pathIdentity(directory, true)
    val descriptor = try {
      ParcelFileDescriptor.open(directory, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: cannot retain the sync root authority",
        error,
      )
    }
    try {
      if (descriptorIdentity(descriptor.fileDescriptor) != expected) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: sync root changed while opening")
      }
      val lockResult = StableRootLockNative.tryLock(descriptor.fd)
      when {
        lockResult == 0 -> Unit
        lockResult == OsConstants.EAGAIN || lockResult == OsConstants.EWOULDBLOCK -> {
          throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_BUSY: another File Sync operation is active")
        }
        else -> throw SyncFileLockUnavailableException(
          "SYNC_FILE_LOCK_UNAVAILABLE: cannot lock stable sync root (errno=$lockResult)",
        )
      }
      return PathRootStableAuthority(directory, descriptor, expected).also { it.revalidate() }
    } catch (error: Throwable) {
      descriptor.close()
      throw error
    }
  }

  private fun acquirePrivateSafAuthority(directoryUri: Uri): StableSyncAuthority {
    // SAF providers commonly cannot open directory documents. Current-version
    // processes instead converge on an app-private inode keyed by the canonical
    // tree/document authority; the shared provider lock remains secondary for
    // older clients. Cross-device safety remains CAS/final-inventory based.
    val digest = MessageDigest.getInstance("SHA-256")
      .digest(directoryUri.toString().toByteArray(StandardCharsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return acquirePrivateFileStableAuthority(
      File(File(context.filesDir, "file-sync-root-authorities"), "$digest.lock"),
    )
  }

  private fun acquirePathLock(uriValue: String): HeldSyncFileLock {
    val parsed = Uri.parse(uriValue)
    val selected = when (parsed.scheme) {
      "file" -> File(parsed.path ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: invalid file URI"))
      null, "" -> File(uriValue)
      else -> throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: unsupported File Sync URI")
    }
    val directory = if (selected.isDirectory) selected else selected.parentFile
      ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: sync folder has no parent")
    if (!directory.isDirectory) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: sync folder is unavailable")
    }
    val stableAuthority = selectStableSyncAuthority(
      saf = false,
      acquirePathRoot = { acquirePathRootAuthority(directory) },
      acquirePrivateSaf = { error("unreachable SAF authority") },
    )
    val lockPath = File(directory, LOCK_NAME)
    val owner = try {
      RandomAccessFile(lockPath, "rw")
    } catch (error: Throwable) {
      stableAuthority.close()
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot open $LOCK_NAME", error)
    }
    val lockIdentity = try {
      val opened = descriptorIdentity(owner.fd)
      if (pathIdentity(lockPath, false) != opened) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME changed while opening")
      }
      opened
    } catch (error: Throwable) {
      owner.close()
      stableAuthority.close()
      throw error
    }
    return acquireChannelLock(
      owner.channel,
      owner,
      stableAuthority = stableAuthority,
      revalidateLegacy = {
        if (pathIdentity(lockPath, false) != lockIdentity || descriptorIdentity(owner.fd) != lockIdentity) {
          throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME identity changed")
        }
      },
    )
  }

  private fun directoryDocumentUri(uri: Uri): Uri {
    val treeId = try {
      DocumentsContract.getTreeDocumentId(uri)
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: File Sync requires a persisted SAF tree URI",
        error,
      )
    }
    return DocumentsContract.buildDocumentUriUsingTree(uri, treeId)
  }

  private fun exactLockDocuments(directoryUri: Uri): List<Uri> {
    val resolver = context.contentResolver
    val documentId = DocumentsContract.getDocumentId(directoryUri)
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(directoryUri, documentId)
    return try {
      resolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        ),
        null,
        null,
        null,
      )?.use { cursor ->
        val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        buildList {
          while (cursor.moveToNext()) {
            if (cursor.getString(nameIndex) == LOCK_NAME) {
              add(DocumentsContract.buildDocumentUriUsingTree(directoryUri, cursor.getString(idIndex)))
            }
          }
        }
      } ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider returned no lock inventory")
    } catch (error: SyncFileLockUnavailableException) {
      throw error
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot inspect $LOCK_NAME", error)
    }
  }

  private fun acquireSafLock(uriValue: String): HeldSyncFileLock {
    val resolver = context.contentResolver
    val directoryUri = directoryDocumentUri(Uri.parse(uriValue))
    val stableAuthority = selectStableSyncAuthority(
      saf = true,
      acquirePathRoot = { error("SAF must not request a provider directory descriptor") },
      acquirePrivateSaf = { acquirePrivateSafAuthority(directoryUri) },
    )
    val lockUriValue = try {
      resolveExactLockDocument(
        listExactDocuments = { exactLockDocuments(directoryUri).map(Uri::toString) },
        createDocument = {
          val created = try {
            DocumentsContract.createDocument(resolver, directoryUri, "application/octet-stream", LOCK_NAME)
          } catch (error: Throwable) {
            throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot create $LOCK_NAME", error)
          } ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider did not create $LOCK_NAME")
          val actualName = try {
            resolver.query(
              created,
              arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
              null,
              null,
              null,
            )?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
          } catch (_: Throwable) {
            // Returning an unverified name makes the resolver remove only this
            // returned URI before retrying or failing closed.
            null
          }
          CreatedLockDocument(created.toString(), actualName)
        },
        deleteOwnedDocument = { createdUri ->
          try {
            DocumentsContract.deleteDocument(resolver, Uri.parse(createdUri))
          } catch (error: Throwable) {
            throw SyncFileLockUnavailableException(
              "SYNC_FILE_LOCK_UNAVAILABLE: cannot remove the newly created lock document",
              error,
            )
          }
        },
      )
    } catch (error: Throwable) {
      stableAuthority.close()
      throw error
    }
    val lockUri = Uri.parse(lockUriValue)
    val descriptor = try {
      resolver.openFileDescriptor(lockUri, "rw")
    } catch (error: Throwable) {
      stableAuthority.close()
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open $LOCK_NAME for locking", error)
    } ?: run {
      stableAuthority.close()
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider returned no lock descriptor")
    }
    val lockResult = StableRootLockNative.tryOfdLock(descriptor.fd)
    if (lockResult != 0) {
      descriptor.close()
      stableAuthority.close()
      if (lockResult == OsConstants.EAGAIN || lockResult == OsConstants.EACCES) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_BUSY: another File Sync operation is active")
      }
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: provider cannot take a durable compatibility lock on $LOCK_NAME (errno=$lockResult)",
      )
    }
    val lockIdentity = descriptorIdentity(descriptor.fileDescriptor)
    val held = HeldSyncFileLock(
      lock = null,
      channel = null,
      closeOwner = descriptor,
      stableAuthority = stableAuthority,
      revalidateLegacy = {
        val matches = exactLockDocuments(directoryUri)
        if (matches.size != 1 || matches.single() != lockUri) {
          throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME identity changed")
        }
        val validation = resolver.openFileDescriptor(lockUri, "r")
          ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider returned no validation descriptor")
        validation.use {
          if (descriptorIdentity(it.fileDescriptor) != lockIdentity
            || descriptorIdentity(descriptor.fileDescriptor) != lockIdentity
          ) {
            throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME identity changed")
          }
        }
      },
      releaseNativeLock = {
        val result = StableRootLockNative.unlockOfdLock(descriptor.fd)
        if (result != 0) {
          throw SyncFileLockUnavailableException(
            "SYNC_FILE_LOCK_UNAVAILABLE: failed to release compatibility lock on $LOCK_NAME (errno=$result)",
          )
        }
      },
    )
    try {
      held.revalidate()
    } catch (error: Throwable) {
      held.close()
      throw error
    }
    return held
  }

  override fun definition() = ModuleDefinition {
    Name("SyncFileLock")

    OnDestroy {
      val errors = synchronized(stateGuard) {
        destroyed = true
        drainHeldSyncFileLocks(heldLocks)
      }
      for (error in errors) {
        Log.w(LOG_TAG, "Failed to release File Sync lease during module teardown", error)
      }
    }

    AsyncFunction("acquireAsync") { uriValue: String ->
      val held = if (Uri.parse(uriValue).scheme == "content") {
        acquireSafLock(uriValue)
      } else {
        acquirePathLock(uriValue)
      }
      val token = synchronized(stateGuard) {
        if (destroyed) {
          null
        } else {
          var token: String
          do {
            token = UUID.randomUUID().toString()
          } while (heldLocks.containsKey(token))
          heldLocks[token] = held
          token
        }
      }
      if (token == null) {
        try {
          held.close()
        } catch (error: Throwable) {
          Log.w(LOG_TAG, "Failed to release File Sync lease acquired during teardown", error)
        }
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: native module is being destroyed")
      }
      token
    }

    AsyncFunction("releaseAsync") { token: String ->
      val held = synchronized(stateGuard) { heldLocks.remove(token) }
        ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: unknown or already released lease")
      val validationError = try {
        held.revalidate()
        null
      } catch (error: Throwable) {
        error
      }
      try {
        held.close()
      } catch (error: Throwable) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: failed to release File Sync lease", error)
      }
      if (validationError != null) throw validationError
    }

    AsyncFunction("revalidateAsync") { token: String ->
      val held = synchronized(stateGuard) { heldLocks[token] }
        ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: unknown or already released lease")
      held.revalidate()
    }
  }
}
