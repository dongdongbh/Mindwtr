package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray


class DeviceWrites(private val stored: () -> Map<String, *>, private val commit: (Map<String, String?>) -> Boolean) {
    companion object {
        const val SEQUENCE = "@journal"
    }


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


val RK_DEVICE_KEYS = setOf("mindwtr:appSearchIndexingEnabled", "mindwtr:appSearchWipeOwed")


fun isRkDeviceKey(key: String) = key.removeSuffix(DeviceWrites.SEQUENCE) in RK_DEVICE_KEYS


fun routedDeviceStore(prefsAll: () -> Map<String, *>, prefsCommit: (Map<String, String?>) -> Boolean, rkStorage: RkStore) = DeviceWrites(
    { prefsAll().filterKeys { !isRkDeviceKey(it) } + rkStorage.multiGet(RK_DEVICE_KEYS.flatMap { listOf(it, it + DeviceWrites.SEQUENCE) }).filterValues { it != null } },
    { changes ->
        val rk = changes.filterKeys(::isRkDeviceKey)


        if (rk.isNotEmpty()) rkStorage.apply(rk)
        changes.filterKeys { !isRkDeviceKey(it) }.let { rest -> rest.isEmpty() || prefsCommit(rest) }
    })


interface RkStore {
    fun multiGet(keys: List<String>): Map<String, String?>
    fun multiSet(entries: List<Pair<String, String>>)
    fun multiRemove(keys: List<String>)
    fun apply(changes: Map<String, String?>)
}
