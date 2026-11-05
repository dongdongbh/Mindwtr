package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test


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

        assertEquals("bound", WidgetRefreshGate.await({ clock.now }, { ms -> clock.sleep(ms); clock.lastCallAt = clock.now }, { clock.lastCallAt }, { true }))
        assertTrue(clock.now - startedAt <= WidgetRefreshGate.MAX_WAIT_MS)
    }

    @Test fun leavingTheAppEndsTheWaitAtOnce() {
        val clock = Clock()
        var left = false
        assertEquals("left", WidgetRefreshGate.await({ clock.now }, { ms -> clock.sleep(ms); if (clock.sleeps.size == 2) left = true }, { clock.now }, { true }, stop = { left }))

        assertEquals(2, clock.sleeps.size)
        assertTrue(clock.sleeps.all { it <= WidgetRefreshGate.POLL_MS })
    }


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

        assertTrue(ran.all { it.second <= WidgetRefreshGate.MAX_WAIT_MS })
    }


    @Test fun aResumeCountsAsACall() {
        val clock = Clock()
        clock.lastCallAt = clock.now - 65_000
        val resumedAt = clock.now
        assertEquals("quiet", WidgetRefreshGate.await({ clock.now }, clock::sleep, { maxOf(clock.lastCallAt, resumedAt) }, { false }, askedAt = resumedAt))
        assertEquals(WidgetRefreshGate.QUIET_MS, clock.sleeps.sum())
    }
}

