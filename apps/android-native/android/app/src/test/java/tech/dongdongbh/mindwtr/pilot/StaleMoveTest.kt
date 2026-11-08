package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class StaleMoveTest {
    @Test fun aStaleMoveShowsCoresLine() {
        for (kind in listOf("taskDestinationMove", "somedayProjectMove")) {
            assertEquals(kind, "A task changed since the view showed it; read the view again",
                staleMoveLine(kind, "STALE_REVISION: A task changed since the view showed it; read the view again"))
        }
    }

    @Test fun aStaleChecklistMoveOrUndoShowsCoresLineInsteadOfLockingWrites() {
        for (kind in listOf("taskChecklistMove", "taskChecklistMoveUndo")) {
            assertEquals(kind, "Task not found", staleMoveLine(kind, "STALE_REVISION: Task not found"))
        }
        assertNull(staleMoveLine("taskChecklistMoveUndo", "SAVE_FAILED: disk full"))
    }

    @Test fun otherRefusalsAndCommandsAreNotThisToast() {
        assertNull(staleMoveLine("taskDestinationMove", "INVALID_INPUT: That project cannot take tasks"))
        assertNull(staleMoveLine("somedayProjectMove", null))
        assertNull(staleMoveLine("somedayMove", "STALE_REVISION: A task changed since the view showed it; read the view again"))
    }
}
