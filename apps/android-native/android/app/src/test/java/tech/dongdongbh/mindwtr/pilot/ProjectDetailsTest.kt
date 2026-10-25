package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Project details' write order and keeping (review PD 2), the edits a close stores (PD 1), and late replies (PD 3). */
class ProjectDetailsTest {
    /** A write that cannot start (another action runs, a retry is owed) waits in order; none is dropped, and one runs at a time. */
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
        // One at a time: the next waits for the first to finish.
        queue.pump()
        assertEquals(listOf("title"), started)
        finish.removeAt(0)()
        assertEquals(listOf("title", "notes"), started)
        finish.removeAt(0)()
        assertFalse(queue.waiting)
    }

    /** Leaving a project (Back, another project) stores its typed title and notes, as RN's end of editing and blur on close do. */
    @Test fun leavingStoresTheTypedTitleAndNotes() {
        assertEquals(listOf("projectRename" to "New", "projectNotes" to "Typed notes"),
            editsOnLeave(title = "  New  ", storedTitle = "Old", notes = "Typed notes", storedNotes = "Old notes"))
        // RN stores no blank title, and nothing unchanged.
        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = "   ", storedTitle = "Old", notes = "Old notes", storedNotes = "Old notes"))
        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = "Old ", storedTitle = "Old", notes = null, storedNotes = "Old notes"))
        assertEquals(emptyList<Pair<String, String>>(), editsOnLeave(title = null, storedTitle = "Old", notes = null, storedNotes = null))
        // Notes keep their exact text, blank included.
        assertEquals(listOf("projectNotes" to ""), editsOnLeave(title = null, storedTitle = "Old", notes = "", storedNotes = "Old notes"))
    }

    /** Focus loss or Done stores only a title the user typed, compared as saved: a padded stored title is no rename (audit 10-25 gap 5). */
    @Test fun aCommitStoresOnlyATypedRename() {
        // Focused and left without typing: nothing, even when the stored title has outer spaces.
        assertEquals(null, titleToStore(typed = null, stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "  Padded title  ", stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "Padded title", stored = "  Padded title  "))
        assertEquals(null, titleToStore(typed = "   ", stored = "Old"))
        assertEquals("New", titleToStore(typed = " New ", stored = "  Padded title  "))
    }

    /** A reply applies only if it answers the newest read of its kind in the current session (review PD 3). */
    @Test fun lateOrClosedRepliesNeverApply() {
        val guard = ReplyGuard()
        val older = guard.ticket("notes")
        val newer = guard.ticket("notes")
        assertFalse(guard.current(older))
        assertTrue(guard.current(newer))
        // Another kind's read does not outdate this one.
        val picker = guard.ticket("picker")
        assertTrue(guard.current(newer))
        // Leaving the screen or another project closes the session: an Area read answering then never opens its picker.
        guard.close()
        assertFalse(guard.current(picker))
        assertFalse(guard.current(newer))
        assertTrue(guard.current(guard.ticket("picker")))
    }

    /** An edit as journaled: core's NativeProjectEdit (request UUID, project, kind, the field's new value), nothing else. */
    @Test fun anEditCarriesItsRequestProjectKindAndValue() {
        val edit = projectEdit("r-1", "p", "date", org.json.JSONObject().put("field", "reviewAt").put("value", "2026-11-20").put("opened", "2026-10-04T21:23:37.456Z"))
        assertEquals(setOf("requestId", "projectId", "kind", "field", "value", "opened"), edit.keys().asSequence().toSet())
        assertEquals("date", edit.getString("kind"))
        assertEquals("2026-11-20", edit.getString("value"))
    }
}
