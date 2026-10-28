package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A resume with a recording queued calls core only once core went quiet (or the bound passed); an empty folder never calls it. */
class WidgetAudioDrainTest {
    private class Clock(var now: Long = 10_000) {
        var lastCallAt = 0L
        var left = false
        val ingestedAt = mutableListOf<Long>()
        var waits = 0
        fun sleep(ms: Long) { now += ms }
        fun awaitQuiet(askedAt: Long, busy: () -> Boolean = { false }): String {
            waits++
            return WidgetRefreshGate.await({ now }, ::sleep, { lastCallAt }, busy, { left }, askedAt)
        }
    }

    @Test fun anEmptyFolderNeverWaitsOrCallsCore() {
        val clock = Clock()
        assertEquals("empty", WidgetAudioDrain.run({ false }, { clock.awaitQuiet(clock.now) }, { clock.ingestedAt += clock.now }))
        assertEquals(0, clock.waits)
        assertEquals(emptyList<Long>(), clock.ingestedAt)
    }

    @Test fun aQueuedRecordingRunsOnlyAfterTheResumedScreensReads() {
        val clock = Clock()
        val resumedAt = clock.now
        // The resumed screen's Focus read just went in.
        clock.lastCallAt = clock.now
        assertEquals("quiet", WidgetAudioDrain.run({ true }, { clock.awaitQuiet(resumedAt) }, { clock.ingestedAt += clock.now }))
        assertEquals(1, clock.ingestedAt.size)
        assertTrue(clock.ingestedAt.single() - clock.lastCallAt >= WidgetRefreshGate.QUIET_MS)
    }

    @Test fun aCoreNeverQuietStillDrainsWithinTheBound() {
        val clock = Clock()
        val resumedAt = clock.now
        assertEquals("bound", WidgetAudioDrain.run({ true }, { clock.awaitQuiet(resumedAt) { true } }, { clock.ingestedAt += clock.now }))
        assertEquals(listOf(resumedAt + WidgetRefreshGate.MAX_WAIT_MS), clock.ingestedAt)
    }

    @Test fun leavingTheAppEndsTheWaitAndKeepsTheRecordingQueued() {
        val clock = Clock()
        clock.lastCallAt = clock.now
        clock.left = true
        assertEquals("left", WidgetAudioDrain.run({ true }, { clock.awaitQuiet(clock.now) }, { clock.ingestedAt += clock.now }))
        assertEquals(emptyList<Long>(), clock.ingestedAt)
    }
}

/** The drain asks the queue, never the WAV folder: only a queued audio item starts one. */
class WidgetAudioDrainQueueTest {
    @get:org.junit.Rule val folder = org.junit.rules.TemporaryFolder()

    private fun queue(vararg items: Pair<String, String>): java.io.File =
        folder.newFolder("pending-captures").also { dir -> items.forEach { (name, text) -> java.io.File(dir, name).writeText(text) } }

    @Test fun noQueueOrAnEmptyOneAsksForNothing() {
        assertEquals(false, WidgetAudioDrain.hasQueuedRecording(java.io.File(folder.root, "pending-captures")))
        assertEquals(false, WidgetAudioDrain.hasQueuedRecording(queue()))
    }

    @Test fun aTextCheckOffOrHalfWrittenItemAsksForNothing() {
        val dir = queue(
            "a.json" to """{"kind":"capture","title":"Milk"}""",
            "b.json" to """{"kind":"complete","taskId":"t1"}""",
            "c.tmp" to """{"kind":"audio"}""",
            "d.json" to "{not json",
        )
        assertEquals(false, WidgetAudioDrain.hasQueuedRecording(dir))
    }

    @Test fun anOrphanWavAsksForNothing() {
        val dir = queue()
        java.io.File(folder.root, "quick-capture-audio").apply { mkdirs() }.resolve("0c8a7d8e-1b2c-4d5e-8f90-123456789abc.wav").writeBytes(ByteArray(64))
        assertEquals(false, WidgetAudioDrain.hasQueuedRecording(dir))
    }

    @Test fun aQueuedAudioItemAsksForADrain() {
        val dir = queue("a.json" to """{"kind":"capture","title":"Milk"}""", "b.json" to """{"kind":"audio","id":"0c8a7d8e-1b2c-4d5e-8f90-123456789abc"}""")
        assertEquals(true, WidgetAudioDrain.hasQueuedRecording(dir))
    }
}
