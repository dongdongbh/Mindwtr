package tech.dongdongbh.mindwtr.syncfiletransitioncas

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private class TransitionRenameUnavailableException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

private class SafDocumentCallException(message: String, cause: Throwable? = null) : CodedException(message, cause)

private fun SafDocumentRow.toMap(): Map<String, Any?> = mapOf(
  "uri" to uri,
  "name" to name,
  "mime" to mime,
  "size" to size?.toDouble(),
  "lastModified" to lastModified?.toDouble(),
)

class SyncFileTransitionCasModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val documents: SafDocumentsCore
    get() = SafDocumentsCore(AndroidSafDocumentProvider(context))

  private fun <T> documentCall(call: () -> T): T = try {
    call()
  } catch (error: SafDocumentUnavailableException) {
    throw SafDocumentCallException(error.message ?: SafDocumentsCore.UNAVAILABLE, error.cause)
  }

  override fun definition() = ModuleDefinition {
    Name("SyncFileTransitionCas")

    // File Sync's folder listing and document lookup (SafDocumentsCore): a provider failure rejects, never reads as empty.
    AsyncFunction("listChildrenAsync") { uriValue: String ->
      documentCall { documents.listChildren(uriValue).map { it.toMap() } }
    }

    AsyncFunction("statAsync") { uriValue: String ->
      documentCall { documents.stat(uriValue)?.toMap() }
    }

    // A write with no writability pre-check (SafDocumentsCore.writeBytes); Base64 as expo's SAF writes take bytes.
    AsyncFunction("writeAsync") { uriValue: String, base64: String ->
      documentCall { documents.writeBytes(uriValue, android.util.Base64.decode(base64, android.util.Base64.NO_WRAP)) }
    }

    // The whole document or an error, never a part (SafDocumentsCore.readBytes); Base64 as expo's SAF reads hand bytes over.
    AsyncFunction("readAsync") { uriValue: String ->
      documentCall {
        val read = documents.readBytes(uriValue, Runtime.getRuntime().maxMemory() / 5)
        mapOf(
          "base64" to android.util.Base64.encodeToString(read.bytes, android.util.Base64.NO_WRAP),
          "lengthVerified" to read.lengthVerified,
        )
      }
    }

    AsyncFunction("renameDocumentAsync") { uriValue: String, displayName: String ->
      val uri = Uri.parse(uriValue)
      if (uri.scheme != "content") {
        throw TransitionRenameUnavailableException("SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: only content URIs can use SAF quarantine")
      }
      if (displayName.isBlank() || displayName == "." || displayName == ".." || displayName.contains('/') || displayName.contains('\\')) {
        throw TransitionRenameUnavailableException("SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: invalid transition document name")
      }
      val flags = try {
        context.contentResolver.query(
          uri,
          arrayOf(DocumentsContract.Document.COLUMN_FLAGS),
          null,
          null,
          null
        )?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getLong(0) else null
        }
      } catch (error: Throwable) {
        throw TransitionRenameUnavailableException(
          "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: this document provider cannot report atomic rename support",
          error
        )
      }
      if (flags == null || flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME.toLong() == 0L) {
        throw TransitionRenameUnavailableException(
          "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: this document provider does not support atomic rename"
        )
      }
      val renamed = try {
        DocumentsContract.renameDocument(context.contentResolver, uri, displayName)
      } catch (error: Throwable) {
        throw TransitionRenameUnavailableException(
          "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: this document provider cannot atomically rename transition files",
          error
        )
      } ?: throw TransitionRenameUnavailableException(
        "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: this document provider did not atomically rename the transition file"
      )

      val actualName = context.contentResolver.query(
        renamed,
        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
        null,
        null,
        null
      )?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      } ?: throw TransitionRenameUnavailableException(
        "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE: renamed transition file cannot be verified"
      )
      mapOf("uri" to renamed.toString(), "name" to actualName)
    }
  }
}
