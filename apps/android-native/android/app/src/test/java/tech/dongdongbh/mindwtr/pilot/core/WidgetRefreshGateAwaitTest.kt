package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Work nothing on screen needs yet (a resume's reminder cycle, the widget build) waits for core to be quiet, never past its bound,
 * and a resume left early runs its cycle at once: a cycle is late at most, never skipped.
 */
class WidgetRefreshGateAwaitTest {
    private class Clock(var now: Long = 10_000) {
        var lastCallAt = 0L
        var busy = false
        val sleeps = mutableListOf<Long>()
        fun sleep(ms: Long) { sleeps += ms; now += ms }
    }

    @Test fun aQuietCoreGoesAtOnce() {
        val clock = Clock()
        assertEquals("quiet", WidgetRefreshGate.await({ clock.now }, clock::sleep, { clock.lastCallAt }, { clock.busy }))
        assertEquals(emptyList<Long>(), clock.sleeps)
    }

    @Test fun itWaitsForTheScreensReadsToEnd() {
        val clock = Clock()
        clock.lastCallAt = clock.now
        WidgetRefreshGate.await({ clock.now }, clock::sleep, { clock.lastCallAt }, { clock.busy })
        assertEquals(WidgetRefreshGate.QUIET_MS, clock.sleeps.sum())
    }

    @Test fun itNeverWaitsPastTheBound() {
        val clock = Clock()
        val startedAt = clock.now
        // Core never goes quiet: a call keeps coming.
        assertEquals("bound", WidgetRefreshGate.await({ clock.now }, { ms -> clock.sleep(ms); clock.lastCallAt = clock.now }, { clock.lastCallAt }, { true }))
        assertTrue(clock.now - startedAt <= WidgetRefreshGate.MAX_WAIT_MS)
    }

    @Test fun leavingTheAppEndsTheWaitAtOnce() {
        val clock = Clock()
        var left = false
        assertEquals("left", WidgetRefreshGate.await({ clock.now }, { ms -> clock.sleep(ms); if (clock.sleeps.size == 2) left = true }, { clock.now }, { true }, stop = { left }))
        // Two polls, then the app left: no more waiting.
        assertEquals(2, clock.sleeps.size)
        assertTrue(clock.sleeps.all { it <= WidgetRefreshGate.POLL_MS })
    }

    /**
     * ProcessCoreHost's sync thread runs, per resume, the cycle (after this wait) and then the sync trigger; a network change can
     * queue behind them. Every wait's bound counts from its post. Core never quiet and the app kept in front: each resume still runs one cycle and one trigger, and nothing
     * queued behind waits past the bound. A local change's upload is core's own timer on the engine, never this thread
     * (check-boot-gates pins the sync thread's posts).
     */
    @Test fun everyResumeRunsItsCycleAndSyncTriggerWithinTheBound() {
        val clock = Clock()
        val ran = mutableListOf<Pair<String, Long>>()
        val syncThread = ArrayDeque<() -> Unit>()
        fun resume(name: String) {
            val postedAt = clock.now
            syncThread += {
                WidgetRefreshGate.await({ clock.now }, clock::sleep, { clock.now }, { true }, askedAt = postedAt)
                ran += "cycle $name" to clock.now - postedAt
            }
            syncThread += { ran += "sync $name" to clock.now - postedAt }
        }
        resume("first")
        resume("second")
        val networkAt = clock.now
        syncThread += { ran += "network" to clock.now - networkAt }
        while (syncThread.isNotEmpty()) syncThread.removeFirst()()
        assertEquals(listOf("cycle first", "sync first", "cycle second", "sync second", "network"), ran.map { it.first })
        // The bound counts from the post, so the second resume's wait does not stack on the first's.
        assertTrue(ran.all { it.second <= WidgetRefreshGate.MAX_WAIT_MS })
    }

    /** A resume counts as a call (CoreHost.awaitQuiet's quietSince): an idle core still waits QUIET_MS for the screen's first read. */
    @Test fun aResumeCountsAsACall() {
        val clock = Clock()
        clock.lastCallAt = clock.now - 65_000
        val resumedAt = clock.now
        assertEquals("quiet", WidgetRefreshGate.await({ clock.now }, clock::sleep, { maxOf(clock.lastCallAt, resumedAt) }, { false }, askedAt = resumedAt))
        assertEquals(WidgetRefreshGate.QUIET_MS, clock.sleeps.sum())
    }
}

