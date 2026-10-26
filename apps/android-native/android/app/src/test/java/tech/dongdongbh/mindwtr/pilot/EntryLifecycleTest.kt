package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * EntryRouter's decisions (EntryLifecycle.kt), driven as the router drives them: which entry core reads, when a failed read
 * is tried again, and when an entry leaves the queue. The clock is the test's.
 */
class EntryLifecycleTest {
    @get:Rule val folder = TemporaryFolder()

    private var clock = 1_000L
    private val dir get() = File(folder.root, "entries")
    /** A new process: a new queue and lifecycle over the same folder. */
    private fun process() = EntryQueue(dir).let { queue -> queue to EntryLifecycle(queue) { clock } }

    @Test fun anEntryLeavesOnlyAfterItsScreenOpened() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        // Core answered, but the screen waits for the running action: the entry stays, and is not read twice.
        assertEquals(listOf(read), queue.all())
        assertNull(lifecycle.next(blocked = false))
        lifecycle.opened(read)
        assertTrue(queue.all().isEmpty())
    }

    @Test fun aFailureOfAnotherEntryNeverFreesTheEntryBeingRead() {
        // A file share staged in the background fails while the head entry is being read: the head is not read twice.
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        queue.add("""{"kind":"files"}""")
        val read = lifecycle.next(blocked = false)!!
        lifecycle.failed(queue.all()[1], "Staging failed")
        clock += 120_000
        assertNull(lifecycle.next(blocked = false))
        lifecycle.opened(read)
        assertEquals("""{"kind":"files"}""", lifecycle.next(blocked = false)?.input)
    }

    @Test fun workOpenedBeforeTheScreenKeepsTheEntryForALaterRead() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        lifecycle.deferred(read)
        assertNull(lifecycle.next(blocked = true))
        assertEquals(read, lifecycle.next(blocked = false))
    }

    /**
     * RN runs a context automation link at once, over open work. While the user's work is open, each waiting link is read once
     * (core's read writes nothing, and only an automation link opens then); every other entry waits for the work to end.
     */
    @Test fun whileWorkIsOpenEachLinkIsReadOnceAndNothingElse() {
        val (queue, lifecycle) = process()
        queue.add("""{"kind":"share","text":"a"}""")
        queue.add("""{"kind":"link","url":"one"}""")
        queue.add("""{"kind":"link","url":"two"}""")
        val first = lifecycle.next(blocked = false, workOpen = true)!!
        assertEquals("""{"kind":"link","url":"one"}""", first.input)
        // Core said it is no automation link: it waits, and is not read again while the work stays open.
        lifecycle.deferred(first)
        val second = lifecycle.next(blocked = false, workOpen = true)!!
        assertEquals("""{"kind":"link","url":"two"}""", second.input)
        // An automation link ran: it leaves, the share stays first.
        lifecycle.opened(second)
        assertNull(lifecycle.next(blocked = false, workOpen = true))
        // A command running or a retry owed holds even links.
        queue.add("""{"kind":"link","url":"three"}""")
        assertNull(lifecycle.next(blocked = true, workOpen = true))
        // The work ended: the queue opens in order again, the first link included.
        assertEquals("""{"kind":"share","text":"a"}""", lifecycle.next(blocked = false)?.input)
        assertEquals(listOf("""{"kind":"share","text":"a"}""", """{"kind":"link","url":"one"}""", """{"kind":"link","url":"three"}"""), queue.all().map { it.input })
    }

    @Test fun aFailedReadKeepsTheEntryAndTriesAgainAfterAGrowingWait() {
        val (queue, lifecycle) = process()
        queue.add("""{"n":1}""")
        val read = lifecycle.next(blocked = false)!!
        assertEquals(EntryLifecycle.Failure.Retry(5_000), lifecycle.failed(read, "NOT_READY: storage"))
        assertEquals(listOf(read), queue.all())
        clock += 4_999
        assertNull(lifecycle.next(blocked = false))
        clock += 1
        val again = lifecycle.next(blocked = false)!!
        assertEquals(EntryLifecycle.Failure.Retry(10_000), lifecycle.failed(again, "Core menuRead timed out"))
        clock += 10_000
        val third = lifecycle.next(blocked = false)!!
        // Waits double up to a minute; an entry that opens resets them.
        repeat(5) { lifecycle.failed(third, "SAVE_FAILED: disk"); clock += 60_000; lifecycle.next(blocked = false) }
        assertEquals(EntryLifecycle.Failure.Retry(60_000), lifecycle.failed(third, "SAVE_FAILED: disk"))
        clock += 60_000
        lifecycle.opened(lifecycle.next(blocked = false)!!)
        queue.add("""{"n":2}""")
        assertEquals(EntryLifecycle.Failure.Retry(5_000), lifecycle.failed(lifecycle.next(blocked = false)!!, "NOT_READY"))
    }

    @Test fun aRefusedEntryLeavesOnlyAfterItsNoticeShowed() {
        val (queue, lifecycle) = process()
        queue.add("""{"kind":"link"}""")
        queue.add("""{"n":2}""")
        val read = lifecycle.next(blocked = false)!!
        // Core refused the input: its words (without the code) are the notice, and the entry waits until it showed.
        assertEquals(EntryLifecycle.Failure.Refused("A link needs its URL and the app's scheme"),
            lifecycle.failed(read, "INVALID_INPUT: A link needs its URL and the app's scheme"))
        assertEquals(2, queue.all().size)
        assertNull(lifecycle.next(blocked = false))
        lifecycle.dismissed(read)
        assertEquals("""{"n":2}""", lifecycle.next(blocked = false)!!.input)
    }

    @Test fun severalQueuedEntriesOpenInOrderAcrossARestart() {
        val (queue, lifecycle) = process()
        for (n in 1..3) queue.add("""{"n":$n}""")
        val first = lifecycle.next(blocked = false)!!
        assertEquals("""{"n":1}""", first.input)
        // The process dies after core answered, before the screen opened: the new process reads the same entry again.
        val (restartedQueue, restarted) = process()
        assertEquals(first, restarted.next(blocked = false))
        restarted.opened(first)
        val second = restarted.next(blocked = false)!!
        assertEquals("""{"n":2}""", second.input)
        restarted.opened(second)
        assertEquals(listOf("""{"n":3}"""), restartedQueue.all().map { it.input })
    }

    @Test fun aRetryWaitingWhenTheRouterClosesNeverStagesAgain() {
        // A staging failed (the disk full) and its retry waits; then the ViewModel clears while the process lives on.
        val posted = mutableListOf<() -> Unit>()
        val threads = EntryThreads({ _, job -> posted += job }, { posted.clear() })
        var staged = 0
        threads.later(5_000) { threads.background { staged++ } }
        val retry = posted.single()
        threads.close()
        assertTrue("close drops the waiting retry", posted.isEmpty())
        // A retry the main thread took before close runs after it: it starts nothing (it threw RejectedExecutionException).
        retry()
        assertEquals(0, staged)
    }

    @Test fun aStagingThatEndsAfterTheRouterClosedNeverPumpsOrRetries() {
        val posted = LinkedBlockingQueue<() -> Unit>()
        val threads = EntryThreads({ _, job -> posted.add(job) }, { posted.clear() })
        val copying = CountDownLatch(1)
        var pumped = 0
        threads.background {
            copying.countDown()
            runCatching { Thread.sleep(60_000) }
            // The staging's completion: pump, which stages the next file share.
            threads.later { pumped++; threads.background {} }
        }
        copying.await()
        threads.close()
        val completion = posted.poll(5, TimeUnit.SECONDS)!!
        completion()
        assertEquals(0, pumped)
    }

    @Test fun aCoreReadThatAnswersAfterTheRouterClosedLeavesTheShareForTheNextRouter() {
        val file = "content://p/1"
        val stager = SharedFileStager(File(folder.root, "staged"), object : SharedFileStager.Source {
            override fun open(uri: String) = "pdf".byteInputStream()
            override fun name(uri: String) = "Report.pdf"
            override fun size(uri: String) = 3L
            override fun mimeType(uri: String) = "application/pdf"
            override fun authority(uri: String) = "p"
            override fun ownProvider(authority: String) = false
        })
        val (queue, lifecycle) = process()
        queue.add("""{"kind":"files","uris":["$file"]}""")
        val read = lifecycle.next(blocked = false)!!
        stager.stage(read.id, listOf(file))
        // Core reads the staged share; the ViewModel clears before its answer opens (the router's opened(): the entry leaves,
        // its files go), and the answer then arrives through the ViewModel's ui and Menu's whenIdle.
        val threads = EntryThreads({ _, _ -> }, {})
        val answer = threads.guarded { lifecycle.opened(read); stager.discard(read.id) }
        threads.close()
        answer()
        val (_, next) = process()
        assertEquals(read.id, next.next(blocked = false)?.id)
        assertEquals(1, stager.staged(read.id)?.length())
    }
}
