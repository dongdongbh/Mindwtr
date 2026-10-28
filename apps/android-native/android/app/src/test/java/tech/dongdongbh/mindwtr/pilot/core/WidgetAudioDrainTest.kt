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
