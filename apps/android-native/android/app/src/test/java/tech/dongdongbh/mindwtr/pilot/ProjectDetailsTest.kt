package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class ProjectDetailsTest {

    @Test fun writesWaitInOrderAndNoneIsDropped() {
        var busy = true
        val started = mutableListOf<String>()
        val finish = mutableListOf<() -> Unit>()
        val queue = WriteQueue<String> { item, done -> if (busy) false else { started += item; finish += done; true } }
        queue.add("title")
        queue.add("notes")
        assertEquals(emptyList<String>(), started)
        assertTrue(queue.waiting)
        busy = false
        queue.pump()
        assertEquals(listOf("title"), started)

        queue.pump()
        assertEquals(listOf("title"), started)
        finish.removeAt(0)()
        assertEquals(listOf("title", "notes"), started)
        finish.removeAt(0)()
        assertFalse(queue.waiting)
    }


    @Test fun leavingStoresTheTypedTitleAndNotes() {
        assertEquals(listOf("projectRename" to "New", "projectNotes" to "Typed notes"),
            editsOnLeave(title = "  New  ", storedTitle = "Old", notes = "Typed notes", storedNotes = "Old notes"))

        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = "   ", storedTitle = "Old", notes = "Old notes", storedNotes = "Old notes"))
        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = "Old ", storedTitle = "Old", notes = null, storedNotes = "Old notes"))
        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = null, storedTitle = "Old", notes = null, storedNotes = null))

        assertEquals(listOf("projectNotes" to ""), editsOnLeave(title = null, storedTitle = "Old", notes = "", storedNotes = "Old notes"))
    }


    @Test fun aCommitStoresOnlyATypedRename() {

        assertEquals(null, titleToStore(typed = null, stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "  Padded title  ", stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "Padded title", stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "   ", stored = "Old"))
        assertEquals("New", titleToStore(typed = " New ", stored = "  Padded title  "))
    }


    @Test fun aCommitComparesWithTheTitleAtOpenOrLastSent() {

        assertEquals(null, titleToStore(typed = "Old ", stored = titleBase(sent = null, opened = "Old", stored = "Remote")))

        assertEquals(null, titleToStore(typed = "New", stored = titleBase(sent = "New", opened = "Old", stored = "Old")))
        assertEquals("Newer", titleToStore(typed = "Newer", stored = titleBase(sent = "New", opened = "Old", stored = "Old")))

        assertEquals("New", titleToStore(typed = "New", stored = titleBase(sent = null, opened = null, stored = "Old")))
    }


    @Test fun lateOrClosedRepliesNeverApply() {
        val guard = ReplyGuard()
        val older = guard.ticket("notes")
        val newer = guard.ticket("notes")
        assertFalse(guard.current(older))
        assertTrue(guard.current(newer))

        val picker = guard.ticket("picker")
        assertTrue(guard.current(newer))

        guard.close()
        assertFalse(guard.current(picker))
        assertFalse(guard.current(newer))
        assertTrue(guard.current(guard.ticket("picker")))
    }


    @Test fun anEditCarriesItsRequestProjectKindAndValue() {
        val edit = projectEdit("r-1", "p", "date", org.json.JSONObject().put("field", "reviewAt").put("value", "2026-11-20").put("opened", "2026-10-04T21:23:37.456Z"))
        assertEquals(setOf("requestId", "projectId", "kind", "field", "value", "opened"), edit.keys().asSequence().toSet())
        assertEquals("date", edit.getString("kind"))
        assertEquals("2026-11-20", edit.getString("value"))
    }


    @Test fun aFlowModeTapStoresExactlyThatModeAndTheShownModeSendsNothing() {
        assertEquals(listOf("parallel", "sequential", "perSection"), PROJECT_FLOW_MODES.map { it.first })
        assertEquals(listOf("projects.parallel", "projects.sequential", "projects.perSection"), PROJECT_FLOW_MODES.map { it.second })
        assertEquals(null, flowModeEdit(shown = "perSection", picked = "perSection"))
        for (picked in listOf("parallel", "sequential")) assertEquals(picked, flowModeEdit(shown = "perSection", picked = picked)?.getString("mode"))
        assertEquals("perSection", flowModeEdit(shown = "sequential", picked = "perSection")?.getString("mode"))
    }

    @Test fun aCalendarRefreshCutOffByAProjectEditRerunsOnce() {
        assertTrue(rerunsCalendarFeed("STALE_REVISION: Project or calendars changed while loading", null, retried = false))
        assertFalse(rerunsCalendarFeed("STALE_REVISION: Project or calendars changed while loading", null, retried = true))
        assertFalse(rerunsCalendarFeed("STALE_REVISION: Project or calendars changed while loading", "kick", retried = false))
        assertFalse(rerunsCalendarFeed("SAVE_FAILED: disk", null, retried = false))
        assertFalse(rerunsCalendarFeed(null, null, retried = false))
    }
}
