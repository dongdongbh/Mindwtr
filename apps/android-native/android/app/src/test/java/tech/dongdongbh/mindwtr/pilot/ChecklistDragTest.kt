package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChecklistDragTest {
    private fun item(title: String, done: Boolean = false) = JSONObject().put("id", "duplicate").put("title", title).put("completed", done)

    @Test fun duplicateRowsKeepTheirInputIdentityWhenRenamedMovedAndRemoved() {
        val session = ChecklistRowSession()
        val original = listOf(item("First"), item("Second", true), item("Third"))
        val identities = session.sync(original).map { it.identity }
        val renamed = listOf(item("Second"), item("Second", true), item("Third"))
        assertEquals(identities, session.sync(renamed).map { it.identity })
        session.expectMove(1, 0)

        assertEquals(identities, session.sync(renamed).map { it.identity })
        val moved = listOf(renamed[1], renamed[0], renamed[2])
        session.settle(moved, true)
        assertEquals(listOf(identities[1], identities[0], identities[2]), session.sync(moved).map { it.identity })
        session.expectRemove(0)
        session.settle(moved.drop(1), true)
        assertEquals(listOf(identities[0], identities[2]), session.sync(moved.drop(1)).map { it.identity })
        assertTrue(moved.all { it.getString("id") == "duplicate" })
    }

    @Test fun rejectedMoveKeepsTheOriginalOrderAndInputIdentity() {
        val session = ChecklistRowSession()
        val original = listOf(item("First"), item("Second"))
        val identities = session.sync(original).map { it.identity }
        session.expectMove(0, 1)
        session.settle(original, false)
        assertEquals(identities, session.sync(original).map { it.identity })
    }

    @Test fun longListDropAndEdgeScrollingUseMeasuredRowsAndViewport() {
        val centers = (0 until 100).map { it * 60f + 30f }
        assertEquals(97, checklistDropIndex(centers, 5870f))
        assertEquals(99, checklistDropIndex(centers, 9000f))
        assertNull(checklistDropIndex(emptyList(), 400f))
        assertEquals(0f, checklistEdgeScroll(450f, 200f, 800f, 72f))
        assertTrue(checklistEdgeScroll(205f, 200f, 800f, 72f) < 0)
        assertTrue(checklistEdgeScroll(795f, 200f, 800f, 72f) > 0)
    }

    @Test fun neighboursBetweenTheDraggedRowAndItsSlotShiftByOneRow() {
        assertEquals(listOf(0f, -50f, -50f, 0f), (0..3).map { checklistPreviewShift(it, 0, 2, 50f) })
        assertEquals(listOf(0f, 50f, 50f, 0f), (0..3).map { checklistPreviewShift(it, 3, 1, 50f) })
        assertEquals(listOf(0f, 0f, 0f), (0..2).map { checklistPreviewShift(it, 1, 1, 50f) })
        assertEquals(0f, checklistPreviewShift(1, 0, -1, 50f))
    }

    @Test fun aDroppedRowKeepsItsPreviewUntilTheMoveLandsOrIsRefused() {
        val before = listOf("a", "b", "c")
        assertTrue(checklistDropPreviewHeld(null, before, false))
        assertTrue(checklistDropPreviewHeld(before, before, true))
        assertFalse(checklistDropPreviewHeld(before, listOf("b", "c", "a"), true))
        assertFalse(checklistDropPreviewHeld(before, listOf("b", "c", "a"), false))
        assertFalse(checklistDropPreviewHeld(before, before, false))
    }
}
