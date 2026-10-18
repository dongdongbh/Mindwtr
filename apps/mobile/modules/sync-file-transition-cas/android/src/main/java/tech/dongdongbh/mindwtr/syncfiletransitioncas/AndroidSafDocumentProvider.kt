package tech.dongdongbh.mindwtr.syncfiletransitioncas

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract

/** [SafDocumentProvider] on the app's ContentResolver. Child URIs are built as androidx's TreeDocumentFile builds them. */
class AndroidSafDocumentProvider(private val context: Context) : SafDocumentProvider {
    private val resolver: ContentResolver get() = context.contentResolver

    private fun documentId(uri: Uri): String =
        if (DocumentsContract.isDocumentUri(context, uri)) DocumentsContract.getDocumentId(uri)
        else DocumentsContract.getTreeDocumentId(uri)

    private fun row(cursor: Cursor, uri: String): SafDocumentRow {
        fun string(column: String) = cursor.getColumnIndex(column).takeIf { it >= 0 && !cursor.isNull(it) }?.let(cursor::getString)
        fun long(column: String) = cursor.getColumnIndex(column).takeIf { it >= 0 && !cursor.isNull(it) }?.let(cursor::getLong)
        return SafDocumentRow(
            uri = uri,
            name = string(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            mime = string(DocumentsContract.Document.COLUMN_MIME_TYPE),
            size = long(DocumentsContract.Document.COLUMN_SIZE),
            flags = long(DocumentsContract.Document.COLUMN_FLAGS) ?: 0L,
            lastModified = long(DocumentsContract.Document.COLUMN_LAST_MODIFIED),
        )
    }

    override fun queryChildren(dirUri: String): List<SafDocumentRow>? {
        val dir = Uri.parse(dirUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(dir, documentId(dir))
        return resolver.query(childrenUri, COLUMNS, null, null, null)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            buildList {
                while (cursor.moveToNext()) {
                    add(row(cursor, DocumentsContract.buildDocumentUriUsingTree(dir, cursor.getString(idIndex)).toString()))
                }
            }
        }
    }

    override fun queryDocument(uri: String): SafDocumentQuery {
        val cursor = resolver.query(Uri.parse(uri), COLUMNS, null, null, null) ?: return SafDocumentQuery.NoCursor
        return cursor.use { if (it.moveToFirst()) SafDocumentQuery.Found(row(it, uri)) else SafDocumentQuery.Missing }
    }

    override fun openRead(uri: String): SafOpenedDocument {
        val descriptor = resolver.openFileDescriptor(Uri.parse(uri), "r")
            ?: throw java.io.IOException("The provider returned no descriptor")
        val stream = java.io.FileInputStream(descriptor.fileDescriptor)
        return object : SafOpenedDocument {
            override val stream: java.io.InputStream = stream
            // -1 for a pipe or socket: no length from the descriptor.
            override fun size(): Long? = descriptor.statSize.takeIf { it >= 0 }
            override fun close() {
                try { stream.close() } finally { descriptor.close() }
            }
        }
    }

    override fun openWrite(uri: String): java.io.OutputStream =
        resolver.openOutputStream(Uri.parse(uri), "w") ?: throw java.io.IOException("The provider returned no output stream")

    override fun isReachable(uri: String): Boolean {
        val authority = Uri.parse(uri).authority ?: return false
        val client = resolver.acquireUnstableContentProviderClient(authority) ?: return false
        client.close()
        return true
    }

    private companion object {
        val COLUMNS = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_FLAGS,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
    }
}
