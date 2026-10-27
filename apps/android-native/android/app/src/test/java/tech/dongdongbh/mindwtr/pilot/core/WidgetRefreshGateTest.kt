package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The widget build (about 186 ms at 5,000 tasks on core's one thread) waits for core to be quiet, so the first screen's reads and
 * the user's first tap go first, and never waits longer than its bound.
 */
class WidgetRefreshGateTest {
    @Test fun aQuietIdleEngineBuildsAtOnce() {
        assertEquals(0L, WidgetRefreshGate.waitMs(now = 10_000, askedAt = 10_000, lastCallAt = 9_000, busy = false))
    }

    @Test fun aRecentCallMakesItWaitForTheQuietPeriod() {
        assertEquals(200L, WidgetRefreshGate.waitMs(now = 10_000, askedAt = 10_000, lastCallAt = 9_900, busy = false))
    }

    @Test fun aQueuedCallMakesItWait() {
        assertTrue(WidgetRefreshGate.waitMs(now = 10_000, askedAt = 10_000, lastCallAt = 0, busy = true) > 0)
    }

    @Test fun itNeverWaitsPastItsBound() {
        val askedAt = 10_000L
        val bound = askedAt + WidgetRefreshGate.MAX_WAIT_MS
        assertEquals(0L, WidgetRefreshGate.waitMs(now = bound, askedAt = askedAt, lastCallAt = bound, busy = true))
        // Just before the bound, a wait never carries past it.
        assertTrue(WidgetRefreshGate.waitMs(now = bound - 10, askedAt = askedAt, lastCallAt = bound - 10, busy = false) <= 10)
    }
}
