package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit


class FileJobsTest {
    @get:Rule val folder = TemporaryFolder()

    @Test fun aProviderStuckInOpenNeverBlocksTheNextFileCallAndIsClosedOnceItReturns() {
        val filesDir = File(folder.root, "files").apply { File(this, "attachments").mkdirs() }
        val release = CountDownLatch(1)
        var closed = false
        val stream = object : InputStream() {
            override fun read(): Int = -1
            override fun close() { closed = true }
        }
        val files = HostFiles(filesDir, File(folder.root, "cache"), syncDirectory = { }, content = object : HostFiles.ContentSource {
            override fun open(uri: String): InputStream { release.await(); return stream }
            override fun size(uri: String): Long? = null
        })
        val jobs = FileJobs(Executors.newSingleThreadExecutor(), abortReader = files::abortRead, readDone = files::readDone)
        val answers = LinkedBlockingQueue<Pair<String, Result<HostFiles.Reply>>>()
        val copy = JSONObject().put("op", "copy").put("uri", "content://provider/document/1")
            .put("to", "file://${filesDir.absolutePath}/attachments/a.pdf").toString()
        jobs.start("1", FileJobs.readsPickedDocument(copy), { files.call(copy) }) { answers.add("1" to it) }
        val info = JSONObject().put("op", "getInfo").put("uri", "file://${filesDir.absolutePath}/attachments/b.pdf").toString()
        jobs.start("2", FileJobs.readsPickedDocument(info), { files.call(info) }) { answers.add("2" to it) }

        val first = answers.poll(5, TimeUnit.SECONDS)
        assertEquals("the next file call answers while the provider is stuck", "2", first?.first)
        assertTrue(first!!.second.isSuccess)

        jobs.abort("1")
        release.countDown()
        val stuck = answers.poll(5, TimeUnit.SECONDS)
        assertEquals("1", stuck?.first)
        assertTrue("the abandoned call fails", stuck!!.second.exceptionOrNull() is IOException)
        assertTrue("its stream is closed once open() returns", closed)
        assertTrue(!File(filesDir, "attachments/a.pdf").exists())
    }
}
