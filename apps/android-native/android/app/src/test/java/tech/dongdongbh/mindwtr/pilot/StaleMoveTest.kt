package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The status menu's Move to project or area… and a parked project's Move to section… refused as stale wrote nothing. They show
 * core's line as RN's failure toast (swipeable-task-item.tsx showActionFailure, someday-view.tsx moveProjectToSection), and the
 * lists are read again, so the next tap sends the new revision (status menu review BLOCK 1). Other refusals are not this toast.
 */
class StaleMoveTest {
    @Test fun aStaleMoveShowsCoresLine() {
        for (kind in listOf("taskDestinationMove", "somedayProjectMove")) {
            assertEquals(kind, "A task changed since the view showed it; read the view again",
                staleMoveLine(kind, "STALE_REVISION: A task changed since the view showed it; read the view again"))
        }
    }

    @Test fun otherRefusalsAndCommandsAreNotThisToast() {
        assertNull(staleMoveLine("taskDestinationMove", "INVALID_INPUT: That project cannot take tasks"))
        assertNull(staleMoveLine("somedayProjectMove", null))
        assertNull(staleMoveLine("somedayMove", "STALE_REVISION: A task changed since the view showed it; read the view again"))
    }
}
