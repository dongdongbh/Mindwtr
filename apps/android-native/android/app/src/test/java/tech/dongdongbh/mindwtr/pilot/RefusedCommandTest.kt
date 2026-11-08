package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class RefusedCommandTest {
    @Test fun doneAndItsUndosOweNothingWhenCoreRefusedThem() {
        for (kind in listOf("complete", "completeUndo", "inboxDecisionUndo")) {
            assertTrue(kind, refusedUnwritten(kind, "TASK_NOT_FOUND: Task not found"))
            assertTrue(kind, refusedUnwritten(kind, "INVALID_INPUT: Task is read-only while its project is archived or deleted"))
        }
        assertTrue(refusedUnwritten("completeUndo", "ACTION_FAILED: Failed to restore task status"))
        assertTrue(refusedUnwritten("inboxDecisionUndo", "ACTION_FAILED: Process Inbox Undo failed"))
    }

    @Test fun aStaleChecklistMoveOrUndoOwesNothing() {
        for (kind in listOf("taskChecklistMove", "taskChecklistMoveUndo")) assertTrue(kind, refusedUnwritten(kind, "STALE_REVISION: Task not found"))
        assertFalse(refusedUnwritten("taskChecklistMoveUndo", "SAVE_FAILED: disk full"))
    }

    @Test fun aFailedSaveStaysOwed() {
        for (kind in listOf("complete", "completeUndo", "inboxDecisionUndo", "update")) assertFalse(kind, refusedUnwritten(kind, "SAVE_FAILED: disk full"))

        assertFalse(refusedUnwritten("complete", "ACTION_FAILED: Task completion failed"))
        assertTrue(refusedUnwritten("complete", "STALE_REVISION: changed"))
    }
}
