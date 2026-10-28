package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Mail Gmail capture saved outside any host call shows once the lists read again (review rgmail, low): after each cycle that
 * ended with a new time and saved mail or failed partway (a failed round may follow rounds that saved), and never for a status
 * republished with its old time (dispose, a config change) or a cycle that found nothing.
 */
class GmailCycleTest {
    private fun status(at: String?, count: Int, error: Boolean) = JSONObject().put("lastPollAt", at ?: JSONObject.NULL)
        .put("lastImportCount", count).put("lastError", if (error) JSONObject().put("kind", "network") else JSONObject.NULL)

    @Test fun aNewCycleThatSavedMailOrFailedReadsTheListsAgain() {
        assertEquals("t1", gmailCycleToShow(null, status("t1", 2, false)))
        assertEquals("t2", gmailCycleToShow("t1", status("t2", 0, true)))
        assertEquals("t3", gmailCycleToShow("t2", status("t3", 1, true)))
    }

    @Test fun aRepublishedStatusOrAnEmptyCycleReadsNothing() {
        assertNull(gmailCycleToShow("t1", status("t1", 2, false)))
        assertNull(gmailCycleToShow("t1", status("t2", 0, false)))
        assertNull(gmailCycleToShow(null, status(null, 0, false)))
    }
}
