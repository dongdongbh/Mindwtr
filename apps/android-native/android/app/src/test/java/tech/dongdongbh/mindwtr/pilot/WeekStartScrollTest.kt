package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** The week's first place (RN's getCalendarWeekInitialScrollX): the selected day at the left, as far as the week allows. */
class WeekStartScrollTest {
    @Test fun deadlineWideColumnsOpenOnTheSelectedDay() {
        // 260 dp deadline columns on a 304 dp viewport: one day fits, so Thursday (index 4) leads, not the density's Tuesday.
        assertEquals(1040, weekStartScroll(start = 4, dayCount = 7, columnPx = 260f, availablePx = 304f))
        assertEquals(7 * 260 - 304, weekStartScroll(start = 6, dayCount = 7, columnPx = 260f, availablePx = 304f))
    }

    @Test fun densityColumnsStopWhereTheLastDayMeetsTheEdge() {
        assertEquals(120, weekStartScroll(start = 6, dayCount = 7, columnPx = 60f, availablePx = 300f))
        assertEquals(0, weekStartScroll(start = 4, dayCount = 7, columnPx = 40f, availablePx = 280f))
    }

    @Test fun todayInTheSameWeekScrollsAgain() {
        // Sunday-first deadline week: Saturday selected (1516), then Today on Thursday (1040). Same week, density and widths.
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
