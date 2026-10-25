package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A command core refused before writing owes no retry. Done and both Undos were missing: a Done on a task deleted elsewhere, or an
 * Undo core could no longer run, became a retry that failed forever and blocked every other write until a restart (13a review P2).
 */
class RefusedCommandTest {
    @Test fun doneAndItsUndosOweNothingWhenCoreRefusedThem() {
        for (kind in listOf("complete", "completeUndo", "inboxDecisionUndo")) {
            assertTrue(kind, refusedUnwritten(kind, "TASK_NOT_FOUND: Task not found"))
            assertTrue(kind, refusedUnwritten(kind, "INVALID_INPUT: Task is read-only while its project is archived or deleted"))
        }
        assertTrue(refusedUnwritten("completeUndo", "ACTION_FAILED: Failed to restore task status"))
        assertTrue(refusedUnwritten("inboxDecisionUndo", "ACTION_FAILED: Process Inbox Undo failed"))
    }

    @Test fun aFailedSaveStaysOwed() {
        for (kind in listOf("complete", "completeUndo", "inboxDecisionUndo", "update")) assertFalse(kind, refusedUnwritten(kind, "SAVE_FAILED: disk full"))
        // Done's ACTION_FAILED keeps its retry, as before; only an Undo gives up.
        assertFalse(refusedUnwritten("complete", "ACTION_FAILED: Task completion failed"))
        assertTrue(refusedUnwritten("complete", "STALE_REVISION: changed"))
    }
}
