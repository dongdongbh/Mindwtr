package tech.dongdongbh.mindwtr.syncfiletransitioncas

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract

/** A transition rename the provider cannot do atomically; the message starts with SYNC_FILE_TRANSITION_CAS_UNAVAILABLE. */
class TransitionRenameUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * File Sync's transition rename (the SAF quarantine CAS), with no Expo type: React Native's SyncFileTransitionCas module and the
 * native Android app both call it. Renames only where the document says FLAG_SUPPORTS_RENAME, and answers the renamed
 * document's URI and the display name the provider reports (the caller checks it is the one asked for).
 */
fun renameTransitionDocument(context: Context, uriValue: String, displayName: String): Pair<String, String> {
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
    return renamed.toString() to actualName
}
