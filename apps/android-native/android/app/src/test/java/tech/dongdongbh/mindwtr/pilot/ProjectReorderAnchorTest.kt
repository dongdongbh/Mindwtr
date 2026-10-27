package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN's #765: Task order opens on the first task at least 10% visible in the project list (viewabilityConfig 10). */
class ProjectReorderAnchorTest {
    private fun item(key: Any, offset: Int, size: Int) = Triple(key, offset, size)

    @Test
    fun skipsHeaderRowsSectionsAndATaskLessThanTenPercentShown() {
        val items = listOf(item("details", -300, 200), item("section:a", -100, 60), item("task:t1", -95, 100), item("task:t2", 5, 100), item("task:t3", 105, 100))
        // t1 shows 5 of its 100 px: under RN's 10%, so the anchor is t2.
        assertEquals("t2", firstViewedTask(items, 0, 800))
        assertEquals("t1", firstViewedTask(items.map { if (it.first == "task:t1") item("task:t1", -90, 100) else it }, 0, 800))
    }

    @Test
    fun noTaskInViewGivesNoAnchor() {
        assertNull(firstViewedTask(listOf(item("details", 0, 400), item("more", 400, 60)), 0, 800))
    }
}
