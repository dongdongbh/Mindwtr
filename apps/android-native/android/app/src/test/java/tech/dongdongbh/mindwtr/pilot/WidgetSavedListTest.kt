package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Test


class WidgetSavedListTest {
    private fun JSONObject.fields(): Map<String, Any> = keys().asSequence().associateWith { get(it) }

    @Test
    fun aWidgetSavedListAppliesItsFilterAndHoldsTheTodayWidgetInOneRead() {
        assertEquals(mapOf("type" to "applySavedFilter", "id" to "errands", "todayWidgetFilter" to "hold"), widgetSavedListEdit("errands").fields())
    }

    @Test
    fun returningToTheMainControlsReleasesTheTodayWidget() {
        assertEquals(mapOf("todayWidgetFilter" to "release"), mainControlsReturnEdit().fields())
    }

    @Test
    fun theSavedListEndsWhenFocusIsNoLongerShown() {
        assertTrue(widgetSavedListShown(Screen.Focus, null))
        assertFalse(widgetSavedListShown(Screen.Inbox, null))
        assertFalse(widgetSavedListShown(Screen.Projects, null))
        assertFalse(widgetSavedListShown(Screen.Focus, MenuScreen.entries.first()))
    }

    private class Replies {
        var issued = 0L
        private var shownAt = 0L
        fun issue() = ++issued
        fun fresh(mine: Long) = (mine > shownAt).also { if (it) shownAt = mine }
    }

    private fun session(replies: Replies = Replies()): Pair<WidgetSavedList, MutableList<String?>> {
        val stored = mutableListOf<String?>(null)
        return WidgetSavedList({ stored[0] }, { stored[0] = it }) { replies.fresh(replies.issue()) } to stored
    }

    @Test
    fun leavingFocusRestoresTheMainControlsOnce() {
        val (list, stored) = session()
        val main = JSONObject().put("sortBy", "due").put("savedFilterId", JSONObject.NULL)
        list.begin(main)
        list.begin(JSONObject().put("savedFilterId", "errands"))
        assertTrue(list.open)
        assertEquals(main.toString(), list.end().toString())
        assertNull(stored[0])
        assertFalse(list.open)
        assertNull(list.end())
    }

    @Test
    fun aFocusReplyIssuedBeforeTheCloseIsIgnored() {
        val replies = Replies()
        val (list) = session(replies)
        list.begin(JSONObject())
        val heldRead = replies.issue()
        list.end()
        assertFalse(replies.fresh(heldRead))
        assertTrue(replies.fresh(replies.issue()))
    }
}
