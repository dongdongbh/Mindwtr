package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException


class HostFilesTest {
    @get:Rule val folder = TemporaryFolder()

    private val synced = mutableListOf<String>()
    private val filesDir get() = File(folder.root, "files")
    private val cacheDir get() = File(folder.root, "cache")
    private fun open() = HostFiles(filesDir, cacheDir, syncDirectory = { synced += it.name })
    private fun queue() = File(filesDir, "pending-captures").apply { mkdirs() }

    @Test fun aFolderThatDoesNotExistListsAsNull() {
        assertEquals("null", open().list("files/pending-captures"))
    }

    @Test fun aFolderListsItsFileNamesOnly() {
        queue().resolve("b.json").writeText("{}")
        queue().resolve("a.json").writeText("{}")
        queue().resolve("a.tmp").writeText("{")
        queue().resolve("nested").mkdirs()
        assertEquals(listOf("a.json", "a.tmp", "b.json"), JSONArray(open().list("files/pending-captures")).toList().sorted())
    }

    @Test fun aFileReadsAsItsTextExactly() {
        queue().resolve("a.json").writeText("""{"id":"1","title":"Grüße ✓ 😀"}""")
        assertEquals("""{"id":"1","title":"Grüße ✓ 😀"}""", open().readText("files/pending-captures/a.json"))
    }

    @Test fun aDeleteIsOnDiskBeforeItReturns() {
        queue().resolve("a.json").writeText("{}")
        open().delete("files/pending-captures/a.json")
        assertFalse(queue().resolve("a.json").exists())

        assertEquals(listOf("pending-captures"), synced)
    }

    @Test fun aFileAlreadyGoneIsNoError() {
        open().delete("files/pending-captures/gone.json")
        assertEquals(emptyList<String>(), synced)
    }

    @Test fun theCacheFolderIsReachableToo() {
        File(cacheDir, "x").apply { mkdirs() }.resolve("a.txt").writeText("cached")
        assertEquals("cached", open().readText("cache/x/a.txt"))
    }

    @Test fun noPathLeavesTheAppFolders() {
        File(folder.root, "outside.json").writeText("secret")
        queue()
        val files = open()
        for (path in listOf("files/../outside.json", "files/pending-captures/../../outside.json", "databases/RKStorage", "/etc/hosts", "files", "")) {
            assertThrows(path, IllegalArgumentException::class.java) { files.readText(path) }
            assertThrows(path, IllegalArgumentException::class.java) { files.delete(path) }
            assertThrows(path, IllegalArgumentException::class.java) { files.list(path) }
        }
        assertEquals("secret", File(folder.root, "outside.json").readText())
    }

    private fun JSONArray.toList() = List(length()) { getString(it) }


    private fun uri(file: File) = "file://${file.absolutePath}"
    private fun call(files: HostFiles, op: String, file: File, extra: JSONObject.() -> Unit = {}, bytes: ByteArray? = null) =
        files.call(JSONObject().put("op", op).put("uri", uri(file)).apply(extra).toString(), bytes)
    private fun attachments() = File(filesDir, "attachments")

    @Test fun theFoldersAreNamedAsExpoNamesThem() {
        assertEquals("file://${filesDir.absolutePath}/", open().documentDirectory)
        assertEquals("file://${cacheDir.absolutePath}/", open().cacheDirectory)
    }

    @Test fun getInfoAnswersExpoShapeWithSecondsAndAMissingFileAsNotExisting() {
        val files = open()
        val missing = call(files, "getInfo", File(attachments(), "a.pdf")).value as JSONObject
        assertEquals(false, missing.getBoolean("exists"))
        val file = File(attachments().apply { mkdirs() }, "a.pdf").apply { writeBytes(ByteArray(5)); setLastModified(1_700_000_123_000) }
        val info = call(files, "getInfo", file).value as JSONObject
        assertEquals(true, info.getBoolean("exists"))
        assertEquals(false, info.getBoolean("isDirectory"))
        assertEquals(5L, info.getLong("size"))
        assertEquals(1_700_000_123.0, info.getDouble("modificationTime"), 0.0)
    }

    @Test fun makeDirectoryMakesParentsAndAnExistingFolderIsNoError() {
        val files = open()
        val nested = File(attachments(), "x/y")
        call(files, "makeDirectory", nested)
        call(files, "makeDirectory", nested)
        assertTrue(nested.isDirectory)
    }

    @Test fun bytesAreWrittenReadAndReadByRangeExactly() {
        val files = open()
        attachments().mkdirs()
        val file = File(attachments(), "a.bin")
        val bytes = ByteArray(300) { (it * 7).toByte() }
        call(files, "writeBytes", file, bytes = bytes)
        assertArrayEquals(bytes, call(files, "readBytes", file).bytes)
        assertArrayEquals(bytes.copyOfRange(10, 30), call(files, "readBytesRange", file, { put("position", 10).put("length", 20) }).bytes)
        assertArrayEquals(bytes.copyOfRange(290, 300), call(files, "readBytesRange", file, { put("position", 290).put("length", 50) }).bytes)

        assertTrue("attachments" in synced)
        assertEquals(listOf("a.bin"), (call(files, "readDirectory", attachments()).value as JSONArray).toList())
    }

    @Test fun sha256HashesTheBytesItIsSent() {

        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            open().call(JSONObject().put("op", "sha256").toString(), "abc".toByteArray()).value)
    }

    @Test fun aFileIsHashedWhereItLiesInPiecesPastTheReadLimit() {
        attachments().mkdirs()
        val file = File(attachments(), "big.bin").apply { writeBytes(ByteArray(300_000) { (it % 251).toByte() }) }

        val files = HostFiles(filesDir, cacheDir, syncDirectory = { }, maxReadBytes = 100_000)
        val expected = java.security.MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, call(files, "sha256File", file).value)
        assertThrows(IOException::class.java) { call(files, "sha256File", File(attachments(), "gone.bin")) }
    }

    @Test fun aMissingFileReadsAsENOENT() {
        val error = assertThrows(IOException::class.java) { call(open(), "readBytes", File(filesDir, "gone.bin")) }
        assertTrue(error.message!!.contains("ENOENT"))
        assertThrows(IOException::class.java) { call(open(), "readDirectory", File(filesDir, "gone")) }
    }

    @Test fun aReadPastTheLimitThrowsAndNeverAnswersShort() {
        attachments().mkdirs()
        val file = File(attachments(), "big.bin").apply { writeBytes(ByteArray(200_000)) }
        val files = HostFiles(filesDir, cacheDir, syncDirectory = { }, maxReadBytes = 100_000)
        assertThrows(IOException::class.java) { call(files, "readBytes", file) }
    }

    @Test fun aPickedDocumentCopiesInThroughTheContentSource() {
        val picked = "content://com.android.providers.downloads.documents/document/42"
        val bytes = "picked ✓".toByteArray()
        val files = HostFiles(filesDir, cacheDir, syncDirectory = { synced += it.name }, content = object : HostFiles.ContentSource {
            override fun open(uri: String) = if (uri == picked) bytes.inputStream() else throw IOException("gone")
            override fun size(uri: String): Long? = if (uri == picked) bytes.size.toLong() else throw IOException("gone")
        })
        attachments().mkdirs()
        val target = File(attachments(), "id.txt")
        files.call(JSONObject().put("op", "copy").put("uri", picked).put("to", uri(target)).toString())
        assertArrayEquals(bytes, target.readBytes())
        assertEquals(bytes.size.toLong(), (files.call(JSONObject().put("op", "getInfo").put("uri", picked).toString()).value as JSONObject).getLong("size"))
        assertArrayEquals(bytes, files.call(JSONObject().put("op", "readBytes").put("uri", picked).toString()).bytes)

        assertThrows(IllegalArgumentException::class.java) { files.call(JSONObject().put("op", "copy").put("uri", uri(target)).put("to", picked).toString()) }
    }

    @Test fun aMoveReplacesItsTargetAndADeleteIsIdempotentAndRecursive() {
        val files = open()
        attachments().mkdirs()
        val temp = File(attachments(), ".tmp").apply { writeText("new") }
        val target = File(attachments(), "a.txt").apply { writeText("old") }
        call(files, "move", temp, { put("to", uri(target)) })
        assertEquals("new", target.readText())
        assertFalse(temp.exists())
        File(attachments(), "dir/sub").mkdirs()
        File(attachments(), "dir/sub/f").writeText("x")
        call(files, "delete", File(attachments(), "dir"))
        call(files, "delete", File(attachments(), "dir"))
        assertFalse(File(attachments(), "dir").exists())
    }


    @Test fun aWriteCopyOrMoveMakesItsFolderAndReplacesAFolderAtTheTarget() {
        val files = open()
        val written = File(cacheDir, "stage/new/a.bin")
        call(files, "writeBytes", written, bytes = byteArrayOf(1, 2))
        assertArrayEquals(byteArrayOf(1, 2), written.readBytes())
        val copied = File(attachments(), "x/b.bin")
        call(files, "copy", written, { put("to", uri(copied)) })
        assertArrayEquals(byteArrayOf(1, 2), copied.readBytes())
        val moved = File(attachments(), "y/c.bin")
        call(files, "move", copied, { put("to", uri(moved)) })
        assertArrayEquals(byteArrayOf(1, 2), moved.readBytes())
        val folderAtTarget = File(attachments(), "d.bin").apply { mkdirs() }.also { File(it, "inner").writeText("old") }
        call(files, "writeBytes", folderAtTarget, bytes = byteArrayOf(3))
        assertArrayEquals(byteArrayOf(3), folderAtTarget.readBytes())
        File(attachments(), "e.bin").apply { mkdirs() }
        call(files, "copy", moved, { put("to", uri(File(attachments(), "e.bin"))) })
        assertTrue(File(attachments(), "e.bin").isFile)
        File(attachments(), "f.bin").apply { mkdirs() }
        call(files, "move", moved, { put("to", uri(File(attachments(), "f.bin"))) })
        assertTrue(File(attachments(), "f.bin").isFile)
    }


    @Test fun aRootNamedThroughALinkTakesURIsInEitherSpelling() {
        val real = File(folder.root, "data/app").apply { mkdirs() }
        File(real, "files/attachments").mkdirs()
        File(real, "cache").mkdirs()
        val user = File(folder.root, "user0").also { java.nio.file.Files.createSymbolicLink(it.toPath(), File(folder.root, "data").toPath()) }
        val files = HostFiles(File(user, "app/files"), File(user, "app/cache"), syncDirectory = { })
        val linked = File(user, "app/files/attachments/a.bin")
        call(files, "writeBytes", linked, bytes = byteArrayOf(7))
        assertArrayEquals(byteArrayOf(7), call(files, "readBytes", File(real, "files/attachments/a.bin")).bytes)
        call(files, "delete", File(real, "files/attachments/a.bin"))
        assertFalse(linked.exists())
    }


    @Test fun aBarrierAnswersAndADeleteNowKeepsTheDeleteRules() {
        val files = open()
        assertEquals(null, files.call(JSONObject().put("op", "barrier").toString()).value)
        val file = File(attachments().apply { mkdirs() }, "a.pdf").apply { writeText("x") }
        synced.clear()
        files.deleteNow(uri(file))
        assertFalse(file.exists())

        assertEquals(emptyList<String>(), synced)
        call(files, "syncParent", file)
        assertEquals(listOf("attachments"), synced)
        files.deleteNow(uri(file))
        File(filesDir, "journal").mkdirs()
        val journal = File(filesDir, "journal/1.json").apply { writeText("{}") }
        assertThrows(IllegalArgumentException::class.java) { files.deleteNow(uri(journal)) }
        assertThrows(IllegalArgumentException::class.java) { files.deleteNow(uri(attachments())) }
        assertTrue(journal.exists() && attachments().isDirectory)
    }


    @Test fun anAbortedReadEndsACopyStalledOnItsProvider() {
        val stalled = object : java.io.InputStream() {
            private val gate = java.util.concurrent.CountDownLatch(1)
            @Volatile private var closed = false
            override fun read(): Int { gate.await(); if (closed) throw IOException("Stream closed"); return -1 }
            override fun close() { closed = true; gate.countDown() }
        }
        val files = HostFiles(filesDir, cacheDir, syncDirectory = { }, content = object : HostFiles.ContentSource {
            override fun open(uri: String) = stalled
            override fun size(uri: String): Long? = null
        })
        attachments().mkdirs()
        val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val copy = Thread {
            runCatching { files.call(JSONObject().put("op", "copy").put("uri", "content://p/d/1").put("to", uri(File(attachments(), "a.pdf"))).toString()) }
                .onFailure { failure.set(it) }
        }.apply { start() }
        Thread.sleep(200)
        assertTrue("the copy is stalled", copy.isAlive)
        files.abortRead(copy)
        copy.join(5_000)
        assertFalse("the copy ended", copy.isAlive)
        assertTrue(failure.get() is IOException)
    }

    @Test fun noAttachmentUriLeavesTheAppFolders() {
        val outside = File(folder.root, "outside.txt").apply { writeText("secret") }
        attachments().mkdirs()
        val link = File(attachments(), "link")
        java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
        val files = open()
        for (bad in listOf(uri(outside), "${uri(attachments())}/../../outside.txt", uri(link), "file://relative/x", "https://example.com/a", "/etc/hosts")) {
            assertThrows(bad, IllegalArgumentException::class.java) { files.call(JSONObject().put("op", "readBytes").put("uri", bad).toString()) }
            if (bad != uri(link)) assertThrows(bad, IllegalArgumentException::class.java) { files.call(JSONObject().put("op", "delete").put("uri", bad).toString()) }
        }

        call(files, "delete", link)
        assertFalse(java.nio.file.Files.exists(link.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertEquals("secret", outside.readText())
    }

    @Test fun aDeleteNeverFollowsALinkInsideTheFolders() {
        attachments().mkdirs()
        val kept = File(filesDir, "kept.txt").apply { writeText("kept") }
        val keptDir = File(attachments(), "real").apply { mkdirs() }.also { File(it, "f").writeText("f") }
        java.nio.file.Files.createSymbolicLink(File(attachments(), "to-file").toPath(), kept.toPath())
        java.nio.file.Files.createSymbolicLink(File(attachments(), "to-dir").toPath(), keptDir.toPath())
        val files = open()
        call(files, "delete", File(attachments(), "to-file"))
        call(files, "delete", File(attachments(), "to-dir"))
        assertEquals("kept", kept.readText())
        assertEquals("f", File(keptDir, "f").readText())
    }

    @Test fun writesStayUnderTheAttachmentsFolderAndTheCacheAndNeitherRootIsRemoved() {
        attachments().mkdirs()
        File(filesDir, "journal").mkdirs()
        val journal = File(filesDir, "journal/0000000000000001.json").apply { writeText("{}") }
        val files = open()
        for (op in listOf("delete", "makeDirectory")) {
            for (target in listOf(filesDir, cacheDir, File(filesDir, "journal"), journal)) {
                assertThrows("$op ${target.name}", IllegalArgumentException::class.java) { call(files, op, target) }
            }
        }
        for (dots in listOf("${uri(attachments())}/sub/..", "${uri(attachments())}/.", "${uri(attachments())}/")) {
            assertThrows(dots, IllegalArgumentException::class.java) { files.call(JSONObject().put("op", "delete").put("uri", dots).toString()) }
        }
        assertTrue(attachments().isDirectory)
        assertThrows(IllegalArgumentException::class.java) { call(files, "writeBytes", File(filesDir, "x.bin"), bytes = ByteArray(1)) }
        assertThrows(IllegalArgumentException::class.java) { call(files, "move", journal, { put("to", uri(File(attachments(), "j"))) }) }
        assertThrows(IllegalArgumentException::class.java) { call(files, "copy", File(attachments(), "a").apply { writeText("a") }, { put("to", uri(File(filesDir, "a"))) }) }
        assertEquals("{}", journal.readText())

        call(files, "makeDirectory", attachments())
        call(files, "writeBytes", File(cacheDir.apply { mkdirs() }, "stage.bin"), bytes = ByteArray(2))
        call(files, "writeBytes", File(attachments(), "b.bin"), bytes = ByteArray(2))

        assertEquals(2, (call(files, "getInfo", File(cacheDir, "stage.bin")).value as JSONObject).getLong("size"))
        assertArrayEquals("{}".toByteArray(), call(files, "readBytes", journal).bytes)
    }
}
