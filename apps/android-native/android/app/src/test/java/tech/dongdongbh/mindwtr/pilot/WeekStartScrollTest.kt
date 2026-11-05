package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class WeekStartScrollTest {
    @Test fun deadlineWideColumnsOpenOnTheSelectedDay() {

        assertEquals(1040, weekStartScroll(start = 4, dayCount = 7, columnPx = 260f, availablePx = 304f))
        assertEquals(7 * 260 - 304, weekStartScroll(start = 6, dayCount = 7, columnPx = 260f, availablePx = 304f))
    }

    @Test fun densityColumnsStopWhereTheLastDayMeetsTheEdge() {
        assertEquals(120, weekStartScroll(start = 6, dayCount = 7, columnPx = 60f, availablePx = 300f))
        assertEquals(0, weekStartScroll(start = 4, dayCount = 7, columnPx = 40f, availablePx = 280f))
    }

    @Test fun todayInTheSameWeekScrollsAgain() {

        val saturday = weekScrollKeys("2026-10-11", visible = 5, start = 6, dayCount = 7, columnPx = 260f, availablePx = 304f)
        val thursday = weekScrollKeys("2026-10-11", visible = 5, start = 4, dayCount = 7, columnPx = 260f, availablePx = 304f)
        assertEquals(listOf("2026-10-11", 5, 1516), saturday)
        assertEquals(listOf("2026-10-11", 5, 1040), thursday)
    }

    @Test fun aResizeUnderDeadlineColumnsScrollsAgain() {
        val wide = weekScrollKeys("2026-10-11", visible = 5, start = 6, dayCount = 7, columnPx = 260f, availablePx = 700f)
        val narrow = weekScrollKeys("2026-10-11", visible = 5, start = 6, dayCount = 7, columnPx = 260f, availablePx = 304f)
        assertEquals(1120, wide.last())
        assertEquals(1516, narrow.last())
    }
}
