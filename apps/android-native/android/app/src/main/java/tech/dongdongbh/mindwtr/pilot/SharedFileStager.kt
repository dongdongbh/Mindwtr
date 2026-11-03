package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream


class SharedFileStager(private val root: File, private val source: Source) {

    interface Source {
        fun open(uri: String): InputStream?

        fun name(uri: String): String?
        fun size(uri: String): Long?
        fun mimeType(uri: String): String?

        fun ownProvider(authority: String): Boolean

        fun authority(uri: String): String?
    }


    fun staged(entryId: String): JSONArray? = runCatching { JSONArray(File(dir(entryId), STAGED).readText()) }.getOrNull()


    fun stage(entryId: String, uris: List<String>): JSONArray {
        val dir = dir(entryId)
        dir.mkdirs()
        val files = JSONArray()
        uris.take(MAX_FILES).forEachIndexed { index, uri -> files.put(stageOne(uri, File(dir, index.toString()))) }
        val partial = File(dir, "$STAGED-partial")
        FileOutputStream(partial).use { out -> out.write(files.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(File(dir, STAGED))) { "Cannot save the staged share" }
        return files
    }

    private fun stageOne(uri: String, target: File): JSONObject {
        val authority = shareAuthority(uri, runCatching { source.authority(uri) }.getOrNull())
        if (authority == null || runCatching { source.ownProvider(authority) }.getOrDefault(true)) {
            return JSONObject().put("path", JSONObject.NULL).put("name", JSONObject.NULL).put("mimeType", JSONObject.NULL).put("size", JSONObject.NULL)
        }
        val name = runCatching { source.name(uri) }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: runCatching { android.net.Uri.parse(uri).lastPathSegment }.getOrNull() ?: uri.substringAfterLast('/').ifEmpty { null }
        val mimeType = runCatching { source.mimeType(uri) }.getOrNull()?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val declared = runCatching { source.size(uri) }.getOrNull()?.takeIf { it >= 0 }
        val file = JSONObject().put("name", name ?: JSONObject.NULL).put("mimeType", mimeType)
        if (declared != null && declared > MAX_BYTES) {

            return standIn(file, target, declared)
        }
        val copied = try {
            (source.open(uri) ?: return file.put("path", JSONObject.NULL).put("size", declared ?: JSONObject.NULL)).use { input ->
                FileOutputStream(target).use { out -> copyCapped(input, out) }
            }
        } catch (_: Exception) {
            target.delete()
            return file.put("path", JSONObject.NULL).put("size", declared ?: JSONObject.NULL)
        }
        if (copied > MAX_BYTES) return standIn(file, target, copied)
        return file.put("path", target.absolutePath).put("size", copied)
    }


    private fun standIn(file: JSONObject, target: File, size: Long): JSONObject = try {
        target.writeBytes(ByteArray(0))
        file.put("path", target.absolutePath).put("size", size)
    } catch (_: Exception) {
        file.put("path", JSONObject.NULL).put("size", size)
    }


    fun discard(entryId: String) {
        dir(entryId).deleteRecursively()
    }


    fun keepOnly(entryIds: Set<String>) {
        root.listFiles()?.filter { it.name !in entryIds }?.forEach { it.deleteRecursively() }
    }

    private fun dir(entryId: String): File {
        require(ENTRY_ID.matches(entryId)) { "Not an entry id" }
        return File(root, entryId)
    }

    companion object {

        const val MAX_FILES = 6

        const val MAX_BYTES = 50L * 1024 * 1024
        private const val STAGED = "staged.json"
        private val ENTRY_ID = Regex("^[0-9a-f-]{36}$")

        private val PLAIN_CONTENT = Regex("^content://([A-Za-z0-9._@-]+)(?=[/?#]|$)")


        fun shareAuthority(raw: String, decoded: String?): String? {
            val plain = PLAIN_CONTENT.find(raw)?.groupValues?.get(1) ?: return null
            if (decoded != plain) return null
            return plain.substringAfterLast('@').takeIf { it.isNotEmpty() }
        }


        fun copyCapped(input: InputStream, out: java.io.OutputStream): Long {
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (total <= MAX_BYTES) {
                val read = input.read(buffer, 0, minOf(buffer.size.toLong(), MAX_BYTES + 1 - total).toInt())
                if (read < 0) break
                out.write(buffer, 0, read)
                total += read
            }
            return total
        }
    }
}
