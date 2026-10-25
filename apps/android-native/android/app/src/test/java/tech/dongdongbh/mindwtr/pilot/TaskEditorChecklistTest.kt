package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Review of a55450375: a draft restored after a restart saves its checklist against the one it started from. With the
 * restored model's checklist as the base, a change another device synced meanwhile looked like the base, and Save wrote the
 * draft's older list over it; with the right base, core merges the two (saveTaskDraft's mergeSyncedChanges).
 */
class TaskEditorChecklistTest {
    private fun model(checklist: String): EditorModel {
        val date = JSONObject().put("value", "").put("label", "").put("hasTime", false).put("dateOnly", "")
            .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())
        val options = JSONObject().apply {
            listOf("statuses", "priorities", "energyLevels", "recurrences", "timeEstimates", "projects", "sections", "areas", "somedaySections")
                .forEach { put(it, JSONArray()) }
        }
        val reply = JSONObject().put("version", 1).put("id", "t1").put("readOnly", false).put("focusStar", JSONObject())
            .put("draft", JSONObject().put("title", "Task"))
            .put("layout", JSONObject().put("sections", JSONArray()).put("showSomedaySection", false)
                .put("recurrence", JSONObject().put("dailyInterval", 1).put("monthlyPattern", "date")))
            .put("options", options)
            .put("fields", JSONObject().put("startTime", date).put("dueDate", date).put("reviewAt", date).put("dateIssue", "")
                .put("recurrence", JSONObject()).put("reminders", JSONObject()).put("timeEstimate", JSONObject())
                .put("timeSpent", JSONObject().put("enabled", false)))
        return EditorModel.of(reply, JSONObject().put("checklistBase", JSONArray(checklist)))
    }

    private val opened = """[{"id":"c1","title":"One","isCompleted":false}]"""
    private val renamed = """[{"id":"c1","title":"One renamed","isCompleted":false}]"""
    private val synced = """[{"id":"c1","title":"One","isCompleted":true},{"id":"c2","title":"Two","isCompleted":false}]"""

    @Test fun aRestoredDraftSavesAgainstTheChecklistItStartedFrom() {
        val edited = TaskEditor.open(model(opened), "task").withChecklist(renamed)
        val restored = TaskEditor.restore(model(synced), JSONObject(edited.state().toString()))

        val half = JSONObject(restored.checklistSave)
        assertEquals(JSONArray(opened).toString(), half.getJSONArray("base").toString())
        assertEquals(JSONArray(renamed).toString(), half.getJSONArray("value").toString())
    }

    @Test fun aReloadKeepsTheChecklistItStartedFrom() {
        val edited = TaskEditor.open(model(opened), "task").withChecklist(renamed)
        val reloaded = edited.reloaded(model(synced), keepChecklist = true)

        assertEquals(JSONArray(opened).toString(), JSONObject(reloaded.checklistSave).getJSONArray("base").toString())
    }
}
