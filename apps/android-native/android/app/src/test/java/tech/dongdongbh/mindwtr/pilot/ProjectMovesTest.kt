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


    @Test fun anAreaRenameSavesOnlyAfterCoreFindsTheNameFree() {
        assertFalse(AreaManagerDraft(renaming = "work", renameName = "Home").canRename)
        assertFalse(AreaManagerDraft(renaming = "work", renameName = "Home", renameCheck = JSONObject("""{"nameTaken":true,"saveDisabled":true}""")).canRename)
        assertFalse(AreaManagerDraft(renaming = "work", renameName = " ", renameCheck = JSONObject("""{"nameTaken":false,"saveDisabled":false}""")).canRename)
        assertTrue(AreaManagerDraft(renaming = "work", renameName = "Office", renameCheck = JSONObject("""{"nameTaken":false,"saveDisabled":false}""")).canRename)
    }


    @Test fun aRowMenuFindsItsProjectAndTheGroupItMovesIn() {
        val json = JSONObject("""{"version":1,"deferred":[],"archived":[],"active":[{"areaId":"w","areaName":"Work","areaColor":null,"areaIcon":null,"projects":[
            {"id":"p1","title":"One","status":"active","statusLabel":"Active","isFocused":false,"focusDisabled":false,"activeTaskCount":0,"nextActionTitle":null,"focusedWithoutNextAction":false},
            {"id":"p2","title":"Two","status":"active","statusLabel":"Active","isFocused":false,"focusDisabled":false,"activeTaskCount":0,"nextActionTitle":null,"focusedWithoutNextAction":false}]}]}""")
        val (row, group) = ProjectsView.parse(json).row("p2")!!
        assertEquals("Two", row.title)
        assertEquals(listOf("p1", "p2"), group.projects.map { it.id })
        assertEquals(null, ProjectsView.parse(json).row("gone"))
    }
}
