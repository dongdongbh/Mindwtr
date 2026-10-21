package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * System search's two keys live in RN's RKStorage, every other device key in the preferences (pass O2d), and both keep
 * DeviceWrites' journal order: a replayed older General edit never overwrites the newer switch (review O2d P2-3).
 */
class RoutedDeviceStoreTest {
    private val prefs = linkedMapOf<String, String>()
    private val rk = linkedMapOf<String, String>()
    private val store = routedDeviceStore({ prefs }, { changes ->
        changes.forEach { (key, value) -> if (value == null) prefs.remove(key) else prefs[key] = value }
        true
    }, { keys -> keys.associateWith { rk[it] } }, { changes ->
        changes.forEach { (key, value) -> if (value == null) rk.remove(key) else rk[key] = value }
    })
    private fun writes(vararg pairs: Pair<String, String?>) = JSONArray().apply {
        pairs.forEach { (key, value) -> put(JSONObject().put("key", key).put("value", value ?: JSONObject.NULL)) }
    }

    @Test fun systemSearchKeysGoToRkStorageWithTheirSequence() {
        store.store(writes("mindwtr:appSearchWipeOwed" to "true", "mindwtr:appSearchIndexingEnabled" to null, "@mindwtr_theme" to "dark"), 7, replay = false)
        assertEquals(mapOf("mindwtr:appSearchWipeOwed" to "true", "mindwtr:appSearchWipeOwed@journal" to "7", "mindwtr:appSearchIndexingEnabled@journal" to "7"), rk)
        assertEquals(mapOf("@mindwtr_theme" to "dark", "@mindwtr_theme@journal" to "7"), prefs)
        assertEquals(7L, store.highestSequence())
    }

    @Test fun aReplayedOlderSwitchEditNeverWinsOverANewerOne() {
        store.store(writes("mindwtr:appSearchWipeOwed" to "true", "mindwtr:appSearchIndexingEnabled" to null), 9, replay = false)
        // The older "on" entry (sequence 4), kept because its delete failed, replays at the next boot.
        store.store(writes("mindwtr:appSearchIndexingEnabled" to "true"), 4, replay = true)
        assertNull(rk["mindwtr:appSearchIndexingEnabled"])
        assertEquals("true", rk["mindwtr:appSearchWipeOwed"])
    }

    @Test fun anUpgradedRnUsersSwitchIsReadWhereRnLeftIt() {
        rk["mindwtr:appSearchIndexingEnabled"] = "true"
        store.store(writes("mindwtr:appSearchIndexingEnabled" to "true"), 3, replay = true)
        assertEquals("true", rk["mindwtr:appSearchIndexingEnabled"])
        assertEquals(3L, store.highestSequence())
    }
}
