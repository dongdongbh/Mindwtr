package tech.dongdongbh.mindwtr.pilot

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

/** The card's on-screen countdown: core's formatPomodoroClock and its rounding up from the phase's end, ASCII in every language. */
class PomodoroClockTest {
    @Test fun formatsAsCore() {
        val original = Locale.getDefault()
        try {
            for (tag in listOf("ar", "en-US")) {
                Locale.setDefault(Locale.forLanguageTag(tag))
                assertEquals("25:00", pomodoroClock(1500))
                assertEquals("00:01", pomodoroClock(1))
                assertEquals("00:00", pomodoroClock(-5))
                assertEquals("59:59", pomodoroClock(3599))
                assertEquals("1:00:00", pomodoroClock(3600))
                assertEquals("2:05:09", pomodoroClock(7509))
            }
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test fun remainingRoundsUpUntilTheEnd() {
        assertEquals(25 * 60L, pomodoroRemaining(1_500_000, 0))
        assertEquals(1500L, pomodoroRemaining(1_500_000, 1))
        assertEquals(1499L, pomodoroRemaining(1_500_000, 1000))
        assertEquals(1L, pomodoroRemaining(1_500_000, 1_499_999))
        assertEquals(0L, pomodoroRemaining(1_500_000, 1_500_000))
        assertEquals(0L, pomodoroRemaining(1_500_000, 1_600_000))
    }
}
