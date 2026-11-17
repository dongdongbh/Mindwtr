package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class FocusLongPressTest {
    private fun row(id: String) = TaskRow(id, "Title $id", "next", false, RowMeta(
        emptyList(), null, null, true, RowSwipe("done", "Done", "done"), false, "Title $id"))

    private val review = JSONObject("""{"r":{"title":"Title r","cancel":"Cancel","options":[{"label":"Mark reviewed","action":{}}]}}""")
    private val defer = JSONObject("""{"d":{"title":"Start Date"},"n":{"title":"Start Date"}}""")
    private val menus = FocusRowMenus(defer, review)

    @Test
    fun aReviewDueRowGetsCoreReviewMenuAndOtherRowsOnlyTheStartDateMenuCoreOffers() {
        assertEquals("Mark reviewed", menus.forRow("r", reviewDue = true)?.label)
        assertEquals("n", (menus.forRow("n", reviewDue = true) as FocusRowMenu.Defer).taskId)
        assertEquals("Start Date", menus.forRow("d", reviewDue = false)?.label)
        assertNull(menus.forRow("r", reviewDue = false))
        assertNull(menus.forRow("x", reviewDue = false))
    }

    @Test
    fun aRowCoreOffersNothingForHasNoLongPressAndNoTalkBackAction() {
        assertNull(focusRowActions(menus, row("x"), reviewDue = false) {})
        assertNull(focusRowActions(null, row("d"), reviewDue = false) {})
        assertEquals("Start Date", focusRowActions(menus, row("d"), reviewDue = false) {}?.longPressLabel)
    }

    @Test
    fun theReadAsksForReviewDueRowsApartFromTheOthersOnceEach() {
        val view = FocusView("r1", "Tuesday", listOf(
            FocusSection("focus", "Today", 2, listOf(row("a"), row("b"))),
            FocusSection("reviewDue", "Review Due", 1, listOf(row("c"))),
            FocusSection("next", "Next", 2, listOf(row("a"), row("d"))),
        ), emptyList())
        assertEquals(FocusMenuIds(listOf("a", "b", "d"), listOf("c")), focusMenuIds(view))
        assertEquals(FocusMenuIds(emptyList(), emptyList()), focusMenuIds(null))
    }
}
