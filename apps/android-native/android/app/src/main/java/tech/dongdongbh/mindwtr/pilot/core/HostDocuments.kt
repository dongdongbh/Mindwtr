package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.syncfiletransitioncas.AndroidSafDocumentProvider
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentProvider
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentRow
import tech.dongdongbh.mindwtr.syncfiletransitioncas.SafDocumentsCore
import tech.dongdongbh.mindwtr.syncfiletransitioncas.renameTransitionDocument

/**
 * File Sync's folder on the Storage Access Framework (core's MobileFileSyncSafPort, bundle/host-sync.ts): React Native's
 * SafDocumentsCore.kt and transition rename, compiled as they are, plus the document create and delete expo's SAF API made.
 * [call] takes `{ op, uri, name?, mimeType? }` and a write's bytes. A call naming a `content://` uri runs on a daemon thread
 * of its own (HostIo, FileJobs.readsPickedDocument), so a stalled provider holds only that call; `takePick` runs on the files
 * thread. A provider failure is an error, never an empty folder or a missing document.
 */
class HostDocuments internal constructor(
    private val provider: SafDocumentProvider,
    private val ops: DocumentOps,
    /** The largest document [call] reads whole (its bytes travel to JS as base64, as HostFiles' reads do). */
    private val maxReadBytes: Long = Runtime.getRuntime().maxMemory() / 5,
) {
    constructor(context: Context) : this(AndroidSafDocumentProvider(context), AndroidDocumentOps(context))

    /** The document calls SafDocumentsCore leaves to the platform. */
    interface DocumentOps {
        /** Creates a document in folder [dirUri] and answers its URI (the provider may decorate [name]). */
        fun create(dirUri: String, mimeType: String, name: String): String
        /** Deletes the document; false when the provider did not. */
        fun delete(uri: String): Boolean
        /** The transition rename: the renamed URI and the name the provider reports. */
        fun rename(uri: String, name: String): Pair<String, String>
    }

    private val core = SafDocumentsCore(provider)

    private fun SafDocumentRow.json() = JSONObject().put("uri", uri).put("name", name ?: JSONObject.NULL)
        .put("mime", mime ?: JSONObject.NULL).put("size", size ?: JSONObject.NULL).put("lastModified", lastModified ?: JSONObject.NULL)

    fun call(json: String, bytes: ByteArray? = null): HostFiles.Reply {
        val request = JSONObject(json)
        // The folder Settings › Sync's picker granted (core's pickSyncFolder takes it once; null: nothing picked).
        if (request.getString("op") == "takePick") return HostFiles.Reply(PendingSyncFolderPick.take())
        val uri = request.getString("uri")
        return when (val op = request.getString("op")) {
            "listChildren" -> HostFiles.Reply(JSONArray(core.listChildren(uri).map { it.json() }))
            "stat" -> HostFiles.Reply(core.stat(uri)?.json())
            "read" -> core.readBytes(uri, maxReadBytes).let { HostFiles.Reply(JSONObject().put("lengthVerified", it.lengthVerified), it.bytes) }
            "write" -> HostFiles.Reply(null.also { core.writeBytes(uri, bytes ?: ByteArray(0)) })
            "createFile" -> HostFiles.Reply(ops.create(uri, request.getString("mimeType"), request.getString("name")))
            "makeDirectory" -> HostFiles.Reply(ops.create(uri, DocumentsContract.Document.MIME_TYPE_DIR, request.getString("name")))
            // Expo's idempotent delete: a document the provider's query says is gone is no error.
            "delete" -> HostFiles.Reply(null.also {
                val deleted = runCatching { ops.delete(uri) }
                if (deleted.getOrNull() != true && core.stat(uri) != null) {
                    throw deleted.exceptionOrNull() ?: java.io.IOException("The provider did not delete the document")
                }
            })
            "rename" -> ops.rename(uri, request.getString("name")).let { (renamed, name) ->
                HostFiles.Reply(JSONObject().put("uri", renamed).put("name", name))
            }
            else -> throw IllegalArgumentException("Unsupported document call $op")
        }
    }
}

/**
 * File Sync's picked folder between Settings › Sync's system picker and core's pickSyncFolder (design §6): one value, taken
 * once by the bundle's host.pickSyncFolder ([HostDocuments.call]'s `takePick`). Memory only; a newer pick replaces an older one.
 */
object PendingSyncFolderPick {
    private var pick: JSONObject? = null

    /** `{ treeUri }` for a folder whose grant the app kept, `{ grant: "refused" }` when Android refused to persist it. */
    @Synchronized fun put(value: JSONObject) { pick = value }

    @Synchronized fun take(): JSONObject? = pick.also { pick = null }
}

private class AndroidDocumentOps(private val context: Context) : HostDocuments.DocumentOps {
    /** A tree URI's own root document, as androidx's DocumentFile.fromTreeUri resolves it; a document URI as it is. */
    private fun folder(dirUri: String): Uri {
        val uri = Uri.parse(dirUri)
        return if (DocumentsContract.isDocumentUri(context, uri)) uri
        else DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
    }

    override fun create(dirUri: String, mimeType: String, name: String): String =
        (DocumentsContract.createDocument(context.contentResolver, folder(dirUri), mimeType, name)
            ?: throw java.io.IOException("The folder refused the new document")).toString()

    override fun delete(uri: String): Boolean = DocumentsContract.deleteDocument(context.contentResolver, Uri.parse(uri))

    override fun rename(uri: String, name: String): Pair<String, String> = renameTransitionDocument(context, uri, name)
}
