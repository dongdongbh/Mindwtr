package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray

/**
 * A write's device-local part (core's deviceWrites: RN's device keys; a null value removes the key), each key kept with the
 * journal sequence of the write that set it, under "<key>@journal", in the same commit. A first send always applies; a journal
 * replay applies a key only when its entry is newer than the write that set the key last, so replaying an old entry (one whose
 * delete failed) never undoes a newer setting. [highestSequence] is the journal's floor: a new entry is numbered above it.
 */
class DeviceWrites(private val stored: () -> Map<String, *>, private val commit: (Map<String, String?>) -> Boolean) {
    companion object {
        const val SEQUENCE = "@journal"
    }

    /** [writes] from the write at journal [sequence] (null: not journaled, so no sequence is kept), on disk before this returns. */
    fun store(writes: JSONArray, sequence: Long?, replay: Boolean) {
        val now = stored()
        val changes = LinkedHashMap<String, String?>()
        for (write in List(writes.length()) { writes.getJSONObject(it) }) {
            val key = write.getString("key")
            if (replay && sequence != null && sequenceOf(now[key + SEQUENCE]) >= sequence) continue
            changes[key] = if (write.isNull("value")) null else write.getString("value")
            if (sequence != null) changes[key + SEQUENCE] = sequence.toString()
        }
        if (changes.isNotEmpty()) check(commit(changes)) { "Cannot store the device settings" }
    }

    fun highestSequence(): Long = stored().filterKeys { it.endsWith(SEQUENCE) }.values.maxOfOrNull(::sequenceOf) ?: 0

    private fun sequenceOf(value: Any?): Long = (value as? String)?.toLongOrNull() ?: 0
}

/** System search's switch and a switch-off's owed wipe (core's general-settings-model.ts): RN's keys, kept in RN's RKStorage. */
val RK_DEVICE_KEYS = setOf("mindwtr:appSearchIndexingEnabled", "mindwtr:appSearchWipeOwed")

/** True for a key [routedDeviceStore] keeps in RKStorage: one of [RK_DEVICE_KEYS], or its journal sequence. */
fun isRkDeviceKey(key: String) = key.removeSuffix(DeviceWrites.SEQUENCE) in RK_DEVICE_KEYS

/**
 * RN's device keys with their journal sequences (DeviceWrites): [RK_DEVICE_KEYS] in RN's RKStorage (pass O2d: an upgraded RN user
 * keeps the system search switch, and an RN recovery build reads it), every other key in [prefsAll]'s preferences.
 */
fun routedDeviceStore(prefsAll: () -> Map<String, *>, prefsCommit: (Map<String, String?>) -> Boolean, rkStorage: RkStore) = DeviceWrites(
    { prefsAll().filterKeys { !isRkDeviceKey(it) } + rkStorage.multiGet(RK_DEVICE_KEYS.flatMap { listOf(it, it + DeviceWrites.SEQUENCE) }).filterValues { it != null } },
    { changes ->
        val rk = changes.filterKeys(::isRkDeviceKey)
        // One RKStorage transaction: a value and its journal sequence land together, as DeviceWrites needs (a death between two
        // would let a replay skip the switch's removal, review O2d R-P2-2).
        if (rk.isNotEmpty()) rkStorage.apply(rk)
        changes.filterKeys { !isRkDeviceKey(it) }.let { rest -> rest.isEmpty() || prefsCommit(rest) }
    })

/** [routedDeviceStore]'s RKStorage (RnKeyValue in the app, a fake in the JVM test); each write is one transaction. */
interface RkStore {
    fun multiGet(keys: List<String>): Map<String, String?>
    fun multiSet(entries: List<Pair<String, String>>)
    fun multiRemove(keys: List<String>)
    fun apply(changes: Map<String, String?>)
}
