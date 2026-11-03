package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class ProjectMovesTest {
    @Test fun theListTakesCoreMovesPerProject() {
        val json = JSONObject("""{"version":1,"active":[],"deferred":[],"archived":[],
            "moves":{"s1":{"up":false,"down":true},"s2":{"up":true,"down":false},"a":{"up":false,"down":false}}}""")
        val view = ProjectsView.parse(json)
        assertEquals(mapOf("s1" to (false to true), "s2" to (true to false), "a" to (false to false)), view.moves)

        assertEquals(emptyMap<String, Pair<Boolean, Boolean>>(), ProjectsView.parse(JSONObject("""{"version":1,"active":[],"deferred":[],"archived":[]}""")).moves)
    }


    @Test fun theAreasSheetSaveWaitsForCoreNameCheck() {
        assertFalse(AreaManagerDraft(name = "Home").canSave)
        assertFalse(AreaManagerDraft(name = "Home", check = JSONObject("""{"nameTaken":true,"saveDisabled":true}""")).canSave)
        assertFalse(AreaManagerDraft(name = "  ", check = JSONObject("""{"saveDisabled":false}""")).canSave)
        assertTrue(AreaManagerDraft(name = "Home", check = JSONObject("""{"nameTaken":false,"saveDisabled":false}""")).canSave)
    }
}
