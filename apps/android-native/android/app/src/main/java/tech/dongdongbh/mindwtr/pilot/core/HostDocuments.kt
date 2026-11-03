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


class HostDocuments internal constructor(
    private val provider: SafDocumentProvider,
    private val ops: DocumentOps,

    private val maxReadBytes: Long = Runtime.getRuntime().maxMemory() / 5,
) {
    constructor(context: Context) : this(AndroidSafDocumentProvider(context), AndroidDocumentOps(context))


    interface DocumentOps {

        fun create(dirUri: String, mimeType: String, name: String): String

        fun delete(uri: String): Boolean

        fun rename(uri: String, name: String): Pair<String, String>
    }

    private val core = SafDocumentsCore(provider)

    private fun SafDocumentRow.json() = JSONObject().put("uri", uri).put("name", name ?: JSONObject.NULL)
        .put("mime", mime ?: JSONObject.NULL).put("size", size ?: JSONObject.NULL).put("lastModified", lastModified ?: JSONObject.NULL)

    fun call(json: String, bytes: ByteArray? = null): HostFiles.Reply {
        val request = JSONObject(json)

        if (request.getString("op") == "takePick") return HostFiles.Reply(PendingSyncFolderPick.take())
        val uri = request.getString("uri")
        return when (val op = request.getString("op")) {
            "listChildren" -> HostFiles.Reply(JSONArray(core.listChildren(uri).map { it.json() }))
            "stat" -> HostFiles.Reply(core.stat(uri)?.json())
            "read" -> core.readBytes(uri, maxReadBytes).let { HostFiles.Reply(JSONObject().put("lengthVerified", it.lengthVerified), it.bytes) }
            "write" -> HostFiles.Reply(null.also { core.writeBytes(uri, bytes ?: ByteArray(0)) })
            "createFile" -> HostFiles.Reply(ops.create(uri, request.getString("mimeType"), request.getString("name")))
            "makeDirectory" -> HostFiles.Reply(ops.create(uri, DocumentsContract.Document.MIME_TYPE_DIR, request.getString("name")))


            "delete" -> HostFiles.Reply(null.also { runCatching { ops.delete(uri) } })
            "rename" -> ops.rename(uri, request.getString("name")).let { (renamed, name) ->
                HostFiles.Reply(JSONObject().put("uri", renamed).put("name", name))
            }
            else -> throw IllegalArgumentException("Unsupported document call $op")
        }
    }
}


object PendingSyncFolderPick {
    private var pick: JSONObject? = null


    @Synchronized fun put(value: JSONObject) { pick = value }

    @Synchronized fun take(): JSONObject? = pick.also { pick = null }
}

private class AndroidDocumentOps(private val context: Context) : HostDocuments.DocumentOps {

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
