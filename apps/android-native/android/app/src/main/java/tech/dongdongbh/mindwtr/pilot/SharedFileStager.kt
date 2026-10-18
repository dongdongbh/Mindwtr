package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/**
 * A file share's files, copied into the app's own folder while the share's read grant holds (expo-share-intent copies them into
 * the cache as the share arrives, as RN's module does): `<root>/<entry id>/<n>`, the provider's name kept apart, so no name from
 * another app reaches a path. Core's prepareSharedFiles then copies each into the managed attachments folder.
 *
 * - At most [MAX_FILES] (RN's six): a later file is never opened.
 * - Each copy streams with a byte counter and stops past [MAX_BYTES] (core's attachment cap), so a huge share neither fills the
 *   disk nor waits for a copy core refuses; such a file is staged empty with a size over the cap, so core counts it skipped.
 * - Only another app's `content://` file: any other scheme (a `file://` URI opens inside this process) and this app's own
 *   providers are unreadable, never opened, so a share cannot make the app attach its own private files. The authority is
 *   compared as ContentResolver opens it ([shareAuthority]): decoded, after the last `@` (a `0@` user prefix is dropped there,
 *   so it cannot hide this app's provider; a real cross-profile share keeps its `10@` and opens). The raw text must spell the
 *   same authority plainly (no `%`, `\`, port or other character), so no encoding can make the two differ; an empty one is
 *   refused, and so is any failed lookup.
 * - The provider's name, else the URI's last segment, and its MIME type, else `application/octet-stream` (RN's #1117 fallbacks
 *   for an empty cursor and a missing type). A file that cannot be opened is staged with no path: core counts it unreadable.
 * - `staged.json` is written last (temporary file, then rename), so a process death mid-copy leaves the entry to stage again.
 *
 * Not on the main thread: [stage] blocks on the provider.
 */
class SharedFileStager(private val root: File, private val source: Source) {
    /** The part of Android's ContentResolver a staging reads (a JVM test fakes it). */
    interface Source {
        fun open(uri: String): InputStream?
        /** OpenableColumns' display name and size, each null when the provider leaves it out. */
        fun name(uri: String): String?
        fun size(uri: String): Long?
        fun mimeType(uri: String): String?
        /** Whether [authority] is one of this app's own providers. */
        fun ownProvider(authority: String): Boolean
        /** [uri]'s authority as ContentResolver opens it (Android's Uri: decoded, ending at `\`), or null. */
        fun authority(uri: String): String?
    }

    /** The entry's staged files (core's NativeSharedFile list), or null until they are all staged. */
    fun staged(entryId: String): JSONArray? = runCatching { JSONArray(File(dir(entryId), STAGED).readText()) }.getOrNull()

    /** Copies the first [MAX_FILES] of [uris] for [entryId] and writes their list; answers it. */
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
            // Too large before a byte is read: an empty stand-in carries the provider's size, which core refuses.
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

    /** An empty file in place of one over the cap, with its [size], so core counts it skipped; unreadable when it cannot be written. */
    private fun standIn(file: JSONObject, target: File, size: Long): JSONObject = try {
        target.writeBytes(ByteArray(0))
        file.put("path", target.absolutePath).put("size", size)
    } catch (_: Exception) {
        file.put("path", JSONObject.NULL).put("size", size)
    }

    /** Deletes [entryId]'s staged files (its entry left the queue). */
    fun discard(entryId: String) {
        dir(entryId).deleteRecursively()
    }

    /** Deletes every staged folder but [entryIds]' (an entry that left while the process was gone). */
    fun keepOnly(entryIds: Set<String>) {
        root.listFiles()?.filter { it.name !in entryIds }?.forEach { it.deleteRecursively() }
    }

    private fun dir(entryId: String): File {
        require(ENTRY_ID.matches(entryId)) { "Not an entry id" }
        return File(root, entryId)
    }

    companion object {
        /** RN's SHARE_INTENT_MAX_FILES (core share-capture-files.ts). */
        const val MAX_FILES = 6
        /** Core's DEFAULT_MAX_FILE_SIZE_BYTES (attachment-validation.ts): 50 MiB. */
        const val MAX_BYTES = 50L * 1024 * 1024
        private const val STAGED = "staged.json"
        private val ENTRY_ID = Regex("^[0-9a-f-]{36}$")
        /** A `content://` URI's authority spelled plainly: letters, digits, `.`, `_`, `-` and a user's `@`, then the path or the end. */
        private val PLAIN_CONTENT = Regex("^content://([A-Za-z0-9._@-]+)(?=[/?#]|$)")

        /**
         * The provider a share's [raw] URI opens, given its [decoded] authority (Android's Uri.getAuthority: what ContentResolver
         * opens), or null to refuse it: not `content://`, not spelled plainly, spelled differently from the decoded one, or empty
         * once the user prefix (`<user>@`, which ContentResolver drops) is gone.
         */
        fun shareAuthority(raw: String, decoded: String?): String? {
            val plain = PLAIN_CONTENT.find(raw)?.groupValues?.get(1) ?: return null
            if (decoded != plain) return null
            return plain.substringAfterLast('@').takeIf { it.isNotEmpty() }
        }

        /** Copies [input] to [out], at most [MAX_BYTES] + 1 bytes; answers the bytes copied (over the cap: stopped there). */
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
