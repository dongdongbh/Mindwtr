package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class PullSyncFailureTest {
    @Test fun aHostFailureShowsRnsSyncFailedToast() {
        val outcome = pullSyncFailure("Sync failed", IllegalStateException("TIMEOUT: core did not answer"))
        assertEquals("error", outcome.getString("indicator"))
        val toast = outcome.getJSONObject("toast")
        assertEquals("Sync failed", toast.getString("title"))
        assertEquals("TIMEOUT: core did not answer", toast.getString("message"))
        assertEquals("error", toast.getString("tone"))
        assertEquals(5200, toast.getInt("durationMs"))
    }

    @Test fun aFailureWithoutAMessageStillSaysSyncFailed() {
        assertEquals("Sync failed", pullSyncFailure("Sync failed", RuntimeException()).getJSONObject("toast").getString("message"))
    }
}
