package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream

/** RN's share module's fallbacks (#1117) and the stager's own bounds: six files, a streamed copy capped at core's 50 MiB. */
class SharedFileStagerTest {
    @get:Rule val folder = TemporaryFolder()
    private val entry = "0f8fad5b-d9cb-469f-a165-70867728950e"

    /** A provider: each URI's bytes, name, size and type, null where the provider leaves them out; [opened] counts reads. */
    private class Provider(val files: Map<String, Triple<ByteArray?, String?, String?>>, val declared: Map<String, Long> = emptyMap()) : SharedFileStager.Source {
        val opened = mutableListOf<String>()
        override fun open(uri: String): InputStream? { opened += uri; return files[uri]?.first?.let { ByteArrayInputStream(it) } }
        override fun name(uri: String) = files[uri]?.second
        override fun size(uri: String) = declared[uri] ?: files[uri]?.first?.size?.toLong()
        override fun mimeType(uri: String) = files[uri]?.third
        override fun ownProvider(authority: String) = authority == "own.app"
        /** The authority as ContentResolver opens it, decoded (java.net.URI decodes as Android's Uri does, and refuses a `\`). */
        override fun authority(uri: String): String? = runCatching { java.net.URI(uri).authority }.getOrNull()
    }

    private fun stager(provider: Provider) = SharedFileStager(folder.root, provider)
    private fun JSONObject.text(name: String): String? = if (isNull(name)) null else getString(name)

    @Test
    fun stagesEachFileUnderItsIndexWithTheProvidersNameAndType() {
        val provider = Provider(mapOf("content://p/1" to Triple("pdf".toByteArray(), "Report.pdf", "application/pdf")))
        val staged = stager(provider).stage(entry, listOf("content://p/1"))
        val file = staged.getJSONObject(0)
        assertEquals("Report.pdf", file.text("name"))
        assertEquals("application/pdf", file.text("mimeType"))
        assertEquals(3L, file.getLong("size"))
        assertEquals(java.io.File(folder.root, "$entry/0").absolutePath, file.text("path"))
        assertEquals("pdf", java.io.File(file.getString("path")).readText())
        assertEquals(staged.toString(), stager(provider).staged(entry).toString())
    }

    @Test
    fun anEmptyCursorAndNoTypeFallBackToTheUrisNameAndOctetStream() {
        val provider = Provider(mapOf("content://p/docs/scan.jpg" to Triple("x".toByteArray(), null, null)))
        val file = stager(provider).stage(entry, listOf("content://p/docs/scan.jpg")).getJSONObject(0)
        assertEquals("scan.jpg", file.text("name"))
        assertEquals("application/octet-stream", file.text("mimeType"))
    }

    @Test
    fun anUnreadableFileHasNoPath() {
        val file = stager(Provider(emptyMap())).stage(entry, listOf("content://p/gone")).getJSONObject(0)
        assertNull(file.text("path"))
    }

    @Test
    fun neverOpensASeventhFile() {
        val uris = (1..8).map { "content://p/$it" }
        val provider = Provider(uris.associateWith { Triple("b".toByteArray(), "$it", "text/csv") })
        assertEquals(6, stager(provider).stage(entry, uris).length())
        assertEquals(uris.take(6), provider.opened)
    }

    @Test
    fun aFileOverTheCapIsStoppedThereAndReportedTooLarge() {
        // Declared too large: never read.
        val big = Provider(mapOf("content://p/big" to Triple(ByteArray(1), "big.mov", "video/mp4")), declared = mapOf("content://p/big" to 60L * 1024 * 1024))
        val declared = stager(big).stage(entry, listOf("content://p/big")).getJSONObject(0)
        assertTrue(declared.getLong("size") > SharedFileStager.MAX_BYTES)
        assertTrue(big.opened.isEmpty())
        // Sizeless and endless: the copy stops one byte past the cap.
        val endless = object : InputStream() { override fun read() = 7; override fun read(b: ByteArray, off: Int, len: Int) = len.also { b.fill(7, off, off + len) } }
        val out = ByteArrayOutputStream()
        assertEquals(SharedFileStager.MAX_BYTES + 1, SharedFileStager.copyCapped(endless, out))
        assertEquals(SharedFileStager.MAX_BYTES + 1, out.size().toLong())
    }

    @Test
    fun anotherSchemeOrThisAppsOwnProviderIsNeverOpened() {
        // A hostile share naming this app's own files: file:// (opened in this process) or this app's own provider.
        val uris = listOf("file:///data/user/0/tech.dongdongbh.mindwtr/files/mindwtr.db", "content://own.app/logs/mindwtr.log", "android.resource://x/1", "content://p/1")
        val provider = Provider(uris.associateWith { Triple("secret".toByteArray(), "mindwtr.db", "application/octet-stream") })
        val staged = stager(provider).stage(entry, uris)
        assertEquals(listOf(true, true, true, false), (0 until 4).map { staged.getJSONObject(it).isNull("path") })
        assertEquals(listOf("content://p/1"), provider.opened)
    }

    @Test
    fun aUserPrefixOnThisAppsOwnAuthorityIsStillRefused() {
        // ContentResolver drops `<user>@` before it opens the provider, so the check compares what follows the last `@`; a
        // real cross-profile share (`10@` another app's provider) still opens, and an empty authority is refused.
        val uris = listOf("content://0@own.app/files/mindwtr.db", "content://10@own.app/x", "content://0@/x", "content://10@p/1")
        val provider = Provider(uris.associateWith { Triple("secret".toByteArray(), "x.db", "application/octet-stream") })
        val staged = stager(provider).stage(entry, uris)
        assertEquals(listOf(true, true, true, false), (0 until 4).map { staged.getJSONObject(it).isNull("path") })
        assertEquals(listOf("content://10@p/1"), provider.opened)
    }

    @Test
    fun anEncodedOrEscapedAuthorityIsRefusedBeforeItIsOpened() {
        // ContentResolver opens the decoded authority, which ends at `\`: an encoded `@` or `.`, an encoded letter, or a
        // backslash would hide this app's own provider from a check of the raw text.
        val uris = listOf("content://0%40own.app/x", "content://own%2Eapp/x", "content://%6Fwn.app/x", "content://own.app\\x/y", "content://own.app:80/x", "content://p/1")
        val provider = Provider(uris.associateWith { Triple("secret".toByteArray(), "x.db", "application/octet-stream") })
        val staged = stager(provider).stage(entry, uris)
        assertEquals(listOf(true, true, true, true, true, false), (0 until 6).map { staged.getJSONObject(it).isNull("path") })
        assertEquals(listOf("content://p/1"), provider.opened)
        assertEquals("own.app", SharedFileStager.shareAuthority("content://0@own.app/x", "0@own.app"))
        assertNull(SharedFileStager.shareAuthority("content://0%40own.app/x", "0@own.app"))
        assertNull(SharedFileStager.shareAuthority("content://own.app/x", "other.app"))
    }

    @Test
    fun aSizelessFileOverTheCapAndOneLargerThanDeclaredAreReportedTooLarge() {
        val big = ByteArray((SharedFileStager.MAX_BYTES + 10).toInt())
        val provider = Provider(mapOf("content://p/sizeless" to Triple(big, "a.bin", "application/octet-stream"), "content://p/liar" to Triple(big, "b.bin", "application/octet-stream")),
            declared = mapOf("content://p/liar" to 10L))
        val staged = SharedFileStager(folder.root, object : SharedFileStager.Source by provider { override fun size(uri: String): Long? = if (uri.endsWith("sizeless")) null else provider.size(uri) })
            .stage(entry, listOf("content://p/sizeless", "content://p/liar"))
        for (index in 0..1) {
            val file = staged.getJSONObject(index)
            assertEquals(SharedFileStager.MAX_BYTES + 1, file.getLong("size"))
            assertEquals(0L, java.io.File(file.getString("path")).length())
        }
    }

    @Test
    fun aStandInThatCannotBeWrittenIsUnreadableNotAFailedStaging() {
        // A file declared over the cap gets an empty stand-in; where that write fails, the file reads as unreadable.
        val provider = Provider(mapOf("content://p/big" to Triple(ByteArray(1), "big.mov", "video/mp4")), declared = mapOf("content://p/big" to 60L * 1024 * 1024))
        val dir = java.io.File(folder.root, entry).apply { mkdirs() }
        java.io.File(dir, "0").mkdirs() // the stand-in's name is taken by a folder
        val file = stager(provider).stage(entry, listOf("content://p/big")).getJSONObject(0)
        assertNull(file.text("path"))
    }

    @Test
    fun aClearedCacheLeavesTheEntryToStageAgain() {
        // The system cleared the cache before the entry opened: no list, so the router stages again (a gone grant then reads as
        // unreadable files, and core says so); a cleared copy under a kept list fails core's copy, which core counts skipped.
        val provider = Provider(mapOf("content://p/1" to Triple("a".toByteArray(), "a.txt", "text/plain")))
        stager(provider).stage(entry, listOf("content://p/1"))
        java.io.File(folder.root, entry).deleteRecursively()
        assertNull(stager(provider).staged(entry))
        assertEquals(1, stager(provider).stage(entry, listOf("content://p/1")).length())
    }

    @Test
    fun discardAndKeepOnlyDeleteStagedFolders() {
        val provider = Provider(mapOf("content://p/1" to Triple("a".toByteArray(), "a.txt", "text/plain")))
        val other = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
        stager(provider).stage(entry, listOf("content://p/1"))
        stager(provider).stage(other, listOf("content://p/1"))
        stager(provider).keepOnly(setOf(other))
        assertFalse(java.io.File(folder.root, entry).exists())
        stager(provider).discard(other)
        assertFalse(java.io.File(folder.root, other).exists())
        assertNull(stager(provider).staged(other))
    }
}
