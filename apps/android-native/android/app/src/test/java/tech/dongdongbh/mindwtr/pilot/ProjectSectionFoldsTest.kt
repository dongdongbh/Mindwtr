package tech.dongdongbh.mindwtr.pilot

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test


class ProjectSectionFoldsTest {
    private class MemoryPrefs : SharedPreferences {
        val values = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?) = values[key] as String? ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?) = defValues
        override fun getInt(key: String, defValue: Int) = defValue
        override fun getLong(key: String, defValue: Long) = defValue
        override fun getFloat(key: String, defValue: Float) = defValue
        override fun getBoolean(key: String, defValue: Boolean) = defValue
        override fun contains(key: String) = key in values
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            override fun putString(key: String, value: String?) = apply { values[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = this
            override fun putInt(key: String, value: Int) = this
            override fun putLong(key: String, value: Long) = this
            override fun putFloat(key: String, value: Float) = this
            override fun putBoolean(key: String, value: Boolean) = this
            override fun remove(key: String) = apply { values.remove(key) }
            override fun clear() = apply { values.clear() }
            override fun commit() = true
            override fun apply() = Unit
        }
    }

    private val rnKey = "mindwtr:view:group-collapse:all:v1"

    private fun list(ids: JSONArray) = (0 until ids.length()).map { ids.getString(it) }

    @Test fun readsTheFoldsRnWroteForThatProjectOnly() {
        val prefs = MemoryPrefs()
        prefs.values[rnKey] = """{"project:p1":["s1","s2"],"project:p2":["x"],"none":["g"]}"""

        assertEquals(listOf("s1", "s2"), list(projectSectionFolds(prefs, "p1")))
        assertEquals(listOf("x"), list(projectSectionFolds(prefs, "p2")))
        assertEquals(emptyList<String>(), list(projectSectionFolds(prefs, "p3")))
    }

    @Test fun aFoldOutlivesClosingTheProjectAndKeepsOtherAxes() {
        val prefs = MemoryPrefs()
        prefs.values[rnKey] = """{"project:p2":["x"],"none":["g"]}"""

        toggleProjectSectionFold(prefs, "p1", "s1")
        toggleProjectSectionFold(prefs, "p1", "s2")
        assertEquals(listOf("s1", "s2"), list(projectSectionFolds(prefs, "p1")))

        val stored = JSONObject(prefs.getString(rnKey, null)!!)
        assertEquals(listOf("s1", "s2"), list(stored.getJSONArray("project:p1")))
        assertEquals(listOf("x"), list(stored.getJSONArray("project:p2")))
        assertEquals(listOf("g"), list(stored.getJSONArray("none")))

        toggleProjectSectionFold(prefs, "p1", "s1")
        assertEquals(listOf("s2"), list(projectSectionFolds(prefs, "p1")))
    }

    @Test fun idsCoreWouldRefuseAreDropped() {
        val prefs = MemoryPrefs()
        prefs.values[rnKey] = JSONObject().put("project:p1", JSONArray().put("s1").put(" ").put(7).put("x".repeat(501))).toString()

        assertEquals(listOf("s1"), list(projectSectionFolds(prefs, "p1")))
    }

    @Test fun brokenStorageReadsAsNoFolds() {
        val prefs = MemoryPrefs()
        prefs.values[rnKey] = "{"

        assertEquals(emptyList<String>(), list(projectSectionFolds(prefs, "p1")))
    }
}
