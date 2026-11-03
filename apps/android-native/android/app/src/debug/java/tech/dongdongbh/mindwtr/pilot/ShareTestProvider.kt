package tech.dongdongbh.mindwtr.pilot

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException


class ShareTestProvider : ContentProvider() {
    private fun file(uri: Uri): File {
        val segments = uri.pathSegments
        val name = segments.getOrNull(1)
        if (segments.size != 2 || segments[0] !in MODES || name == null || !NAME.matches(name)) throw FileNotFoundException("Not a test file")
        return File(File(context!!.filesDir, "share-test"), name)
    }

    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor {
        val file = file(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(columns)
        when (uri.pathSegments[0]) {
            "nometa" -> Unit
            else -> cursor.addRow(columns.map { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> if (uri.pathSegments[0] == "nosize") null else file.length()
                    else -> null
                }
            }.toTypedArray())
        }
        return cursor
    }

    override fun getType(uri: Uri): String? = if (uri.pathSegments.firstOrNull() == "nometa") null
        else TYPES[uri.lastPathSegment?.substringAfterLast('.', "")?.lowercase()]

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("Read-only")
        val file = file(uri)
        if (uri.pathSegments[0] == "gone" || !file.isFile) throw FileNotFoundException("Not a test file")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    private companion object {
        val MODES = setOf("file", "nosize", "nometa", "gone")

        val TYPES = mapOf("pdf" to "application/pdf", "png" to "image/png", "csv" to "text/csv", "bin" to "application/octet-stream",
            "exe" to "application/x-msdownload", "txt" to "text/plain")

        val NAME = Regex("^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$")
    }
}
