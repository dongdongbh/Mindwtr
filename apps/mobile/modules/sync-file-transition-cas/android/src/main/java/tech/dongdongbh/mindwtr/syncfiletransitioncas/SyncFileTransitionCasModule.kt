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

class SyncFileTransitionCasModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SyncFileTransitionCas")

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
