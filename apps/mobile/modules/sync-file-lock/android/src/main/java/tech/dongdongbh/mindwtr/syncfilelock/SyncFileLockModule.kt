package tech.dongdongbh.mindwtr.syncfilelock

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
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
private const val MAX_LOCK_DOCUMENT_CREATE_ATTEMPTS = 3
private const val LOG_TAG = "SyncFileLock"

internal class SyncFileLockUnavailableException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

internal data class HeldSyncFileLock(
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
    val lockUriValue = resolveExactLockDocument(
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
    val lockUri = Uri.parse(lockUriValue)
    val descriptor = try {
      resolver.openFileDescriptor(lockUri, "rw")
    } catch (error: Throwable) {
      throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open $LOCK_NAME for locking", error)
    } ?: throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: provider returned no lock descriptor")
    val stream = try {
      FileOutputStream(descriptor.fileDescriptor)
    } catch (error: Throwable) {
      descriptor.close()
      throw SyncFileLockUnavailableException(
        "SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open a lock channel for $LOCK_NAME",
        error,
      )
    }
    return acquireChannelLock(stream.channel, stream, descriptor)
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
      try {
        held.close()
      } catch (error: Throwable) {
        throw SyncFileLockUnavailableException("SYNC_FILE_LOCK_UNAVAILABLE: failed to release File Sync lease", error)
      }
    }
  }
}
