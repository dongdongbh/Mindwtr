package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** RN 4e94be67f (#1423): App Lock can wait 1, 5 or 15 minutes before asking again (lib/mobile-app-lock.test.ts, mobile-app-lock-gate.test.tsx). */
class AppLockRelockTest {
    private val left = 1_000_000L
    private fun at(delayMinutes: Int, awayMs: Long, leftUnlockedAt: Long? = left) = withinRelockDelay(delayMinutes, leftUnlockedAt, left + awayMs)

    @Test fun skipsThePromptOnlyWithinTheDelay() {
        assertTrue(at(1, 59_999))
        assertTrue(at(5, 4 * 60_000L))
        assertFalse(at(1, 60_000))
        assertFalse(at(15, 16 * 60_000L))
        // Immediately, a cold start or a lock left locked, and a clock moved back all ask.
        assertFalse(at(0, 0))
        assertFalse(at(15, 1_000, null))
        assertFalse(at(15, -1))
    }

    private class Clock { var now = 0L }
    private fun relock(minutes: Int, clock: Clock) = Relock { clock.now }.apply { delayMinutes = minutes }

    @Test fun aColdStartAsksWhateverTheDelay() = assertFalse(relock(15, Clock()).returned())

    @Test fun aReturnWithinTheDelayOfLeavingUnlockedSkipsThePrompt() {
        val clock = Clock()
        val lock = relock(5, clock)
        lock.left(unlocked = true)
        clock.now += 60_000
        assertTrue(lock.returned())
        // Each leave counts once: a second resume without a leave asks.
        assertFalse(lock.returned())
    }

    @Test fun aReturnAfterTheDelayAsks() {
        val clock = Clock()
        val lock = relock(1, clock)
        lock.left(unlocked = true)
        clock.now += 61_000
        assertFalse(lock.returned())
    }

    @Test fun aQuickReturnStaysLockedWhenTheAppLeftStillLocked() {
        val clock = Clock()
        val lock = relock(15, clock)
        lock.left(unlocked = false)
        clock.now += 1_000
        assertFalse(lock.returned())
    }

    @Test fun immediatelyAsksEveryTime() {
        val clock = Clock()
        val lock = relock(0, clock)
        lock.left(unlocked = true)
        assertFalse(lock.returned())
        assertEquals(0, lock.delayMinutes)
    }

    /** Review note 2: a resume while the prompt is up still uses the leave, so a later resume (a rotation) asks. */
    @Test fun aResumeWhileThePromptIsUpUsesTheLeave() {
        val clock = Clock()
        val lock = relock(5, clock)
        lock.left(unlocked = true)
        clock.now += 1_000
        assertFalse(lock.returned(authenticating = true))
        clock.now += 1_000
        assertFalse(lock.returned())
    }
}
