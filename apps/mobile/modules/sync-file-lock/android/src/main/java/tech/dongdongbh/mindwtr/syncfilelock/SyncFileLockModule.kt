package tech.dongdongbh.mindwtr.syncfilelock

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.UUID

private const val LOCK_NAME = ".mindwtr.lock"

private class SyncFileLockUnavailableException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

private data class HeldSyncFileLock(
  val lock: FileLock,
  val channel: FileChannel,
  val closeOwner: AutoCloseable,
  val descriptorOwner: AutoCloseable? = null,
) {
  fun close() {
    try {
      lock.release()
    } finally {
      try {
        channel.close()
      } finally {
        try {
          closeOwner.close()
        } finally {
          descriptorOwner?.close()
        }
      }
    }
  }
}

class SyncFileLockModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val heldLocks = mutableMapOf<String, HeldSyncFileLock>()

  private fun acquireChannelLock(
    channel: FileChannel,
    closeOwner: AutoCloseable,
    descriptorOwner: AutoCloseable? = null,
  ): HeldSyncFileLock {
    val lock = try {
      channel.tryLock()
    } catch (error: OverlappingFileLockException) {
      null
    } catch (error: Throwable) {
      try {
        closeOwner.close()
      } finally {
        descriptorOwner?.close()
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
        descriptorOwner?.close()
      }
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_BUSY: another File Sync operation is active")
    }
    return HeldSyncFileLock(lock, channel, closeOwner, descriptorOwner)
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
    val owner = try {
      RandomAccessFile(File(directory, LOCK_NAME), "rw")
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot open $LOCK_NAME", error)
    }
    return acquireChannelLock(owner.channel, owner)
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
    var matches = exactLockDocuments(directoryUri)
    if (matches.isEmpty()) {
      val created = try {
        DocumentsContract.createDocument(resolver, directoryUri, "application/octet-stream", LOCK_NAME)
      } catch (error: Throwable) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: cannot create $LOCK_NAME", error)
      } ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider did not create $LOCK_NAME")
      val actualName = resolver.query(
        created,
        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
        null,
        null,
        null,
      )?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
      if (actualName != LOCK_NAME) {
        try {
          DocumentsContract.deleteDocument(resolver, created)
        } catch (_: Throwable) {
          // The wrongly named document is uniquely ours, but cleanup is best effort.
        }
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider changed the lock document name")
      }
      matches = exactLockDocuments(directoryUri)
    }
    if (matches.size != 1) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: $LOCK_NAME is missing or ambiguous")
    }
    val descriptor = try {
      resolver.openFileDescriptor(matches.single(), "rw")
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open $LOCK_NAME for locking", error)
    } ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider returned no lock descriptor")
    val stream = FileOutputStream(descriptor.fileDescriptor)
    return acquireChannelLock(stream.channel, stream, descriptor)
  }

  override fun definition() = ModuleDefinition {
    Name("SyncFileLock")

    AsyncFunction("acquireAsync") { uriValue: String ->
      val held = if (Uri.parse(uriValue).scheme == "content") {
        acquireSafLock(uriValue)
      } else {
        acquirePathLock(uriValue)
      }
      synchronized(heldLocks) {
        var token: String
        do {
          token = UUID.randomUUID().toString()
        } while (heldLocks.containsKey(token))
        heldLocks[token] = held
        token
      }
    }

    AsyncFunction("releaseAsync") { token: String ->
      val held = synchronized(heldLocks) { heldLocks.remove(token) }
        ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: unknown or already released lease")
      try {
        held.close()
      } catch (error: Throwable) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: failed to release File Sync lease", error)
      }
    }
  }
}
