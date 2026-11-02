package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A pull down to sync whose host call fails (a timeout, a stopped engine) ends as core's own failure does (manual-pull-sync.ts's
 * catch, RN's useManualPullSync): the error bar and RN's "Sync failed" toast with the error's message.
 */
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
