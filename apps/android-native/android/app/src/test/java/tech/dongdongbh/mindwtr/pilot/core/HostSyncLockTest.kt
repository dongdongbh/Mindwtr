package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import tech.dongdongbh.mindwtr.syncfilelock.SyncFileLockCore
import tech.dongdongbh.mindwtr.syncfilelock.SyncFileLockUnavailableException

class HostSyncLockTest {
    private fun refused(block: () -> Unit) {
        try {
            block()
            fail("expected a lock refusal")
        } catch (error: SyncFileLockUnavailableException) {
            assertTrue(error.message!!.startsWith("SYNC_FILE_LOCK_UNAVAILABLE"))
        }
    }

    // Holding a real lease needs Android's Uri, file descriptors and the JNI library (no Robolectric here), so this test only
    // pins the refusals and that close() keeps refusing. close() calls SyncFileLockCore.destroy, whose drain RN's
    // SyncFileLockModuleTest covers (drainHeldSyncFileLocks); the device check proves a held lease is released (4b, 4c).
    @Test
    fun aTokenTheHostDoesNotHoldIsRefusedBeforeAndAfterClose() {
        val lock = HostSyncLock(SyncFileLockCore { error("no folder is opened in this test") })
        refused { lock.call(JSONObject().put("op", "revalidate").put("token", "unknown").toString()) }
        refused { lock.call(JSONObject().put("op", "release").put("token", "unknown").toString()) }
        lock.close()
        refused { lock.call(JSONObject().put("op", "release").put("token", "unknown").toString()) }
    }
}
