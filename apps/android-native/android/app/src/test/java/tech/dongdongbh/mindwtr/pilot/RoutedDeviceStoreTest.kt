package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tech.dongdongbh.mindwtr.pilot.core.RkStore
import tech.dongdongbh.mindwtr.pilot.core.routedDeviceStore

/**
 * System search's two keys live in RN's RKStorage, every other device key in the preferences (pass O2d), and both keep
 * DeviceWrites' journal order: a replayed older General edit never overwrites the newer switch (review O2d P2-3).
 */
class RoutedDeviceStoreTest {
    private val prefs = linkedMapOf<String, String>()
    private val rkStorage = Transactions()
    private val rk = rkStorage.values
    private val store = routedDeviceStore({ prefs }, { changes ->
        changes.forEach { (key, value) -> if (value == null) prefs.remove(key) else prefs[key] = value }
        true
    }, rkStorage)
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

    /**
     * RKStorage, one entry in [committed] per transaction. A switch-off must be one transaction holding the removal and its journal
     * sequence (review O2d R-P2-2). With two (values and sequences first, removals after) a death between them left the switch's
     * sequence stored without its removal, and the replay then skipped the removal: system search stayed on.
     */
    private class Transactions : RkStore {
        val committed = mutableListOf<Map<String, String?>>()
        val values = linkedMapOf<String, String>()
        override fun multiGet(keys: List<String>) = keys.associateWith { values[it] }
        override fun multiSet(entries: List<Pair<String, String>>) { committed += entries.toMap(); entries.forEach { (k, v) -> values[k] = v } }
        override fun multiRemove(keys: List<String>) { committed += keys.associateWith { null }; keys.forEach(values::remove) }
        override fun apply(changes: Map<String, String?>) { committed += changes; changes.forEach { (k, v) -> if (v == null) values.remove(k) else values[k] = v } }
    }

    @Test fun aSwitchOffIsOneRkStorageTransaction() {
        rk["mindwtr:appSearchIndexingEnabled"] = "true"
        store.store(writes("mindwtr:appSearchWipeOwed" to "true", "mindwtr:appSearchIndexingEnabled" to null), 12, replay = false)
        assertEquals(1, rkStorage.committed.size)
        assertEquals(mapOf("mindwtr:appSearchWipeOwed" to "true", "mindwtr:appSearchWipeOwed@journal" to "12",
            "mindwtr:appSearchIndexingEnabled" to null, "mindwtr:appSearchIndexingEnabled@journal" to "12"), rkStorage.committed.single())
    }
}
