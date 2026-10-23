package tech.dongdongbh.mindwtr.syncfiletransitioncas

import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Expo names a rejection by its class; this keeps the code the rename rejected with before SyncFileTransitionCasCore.
private class TransitionRenameCodedException(message: String, cause: Throwable? = null) :
  CodedException("ERR_TRANSITION_RENAME_UNAVAILABLE", message, cause)

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
      val (uri, name) = try {
        renameTransitionDocument(context, uriValue, displayName)
      } catch (error: TransitionRenameUnavailableException) {
        throw TransitionRenameCodedException(error.message ?: "SYNC_FILE_TRANSITION_CAS_UNAVAILABLE", error.cause)
      }
      mapOf("uri" to uri, "name" to name)
    }
  }
}
