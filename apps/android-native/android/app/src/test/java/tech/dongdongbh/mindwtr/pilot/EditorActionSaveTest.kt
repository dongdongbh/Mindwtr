package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Skip and Cancel send the editor's draft save as core's checklist save reads it (device run: INVALID_INPUT before the fix). */
class EditorActionSaveTest {
    private val date = JSONObject().put("value", "null").put("label", "").put("hasTime", false).put("dateOnly", "null")
        .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())

    /** The smallest editor model core could send: one task with an empty checklist. */
    private val model = EditorModel.of(JSONObject().put("version", 1).put("id", "t").put("readOnly", false)
        .put("scheduleBase", JSONObject().put("dueDate", JSONObject.NULL)).put("recurrenceBase", JSONObject().put("recurrence", JSONObject.NULL).put("showFutureRecurrence", JSONObject.NULL))
        .put("focusStar", JSONObject()).put("draft", JSONObject().put("title", "Task"))
        .put("layout", JSONObject().put("sections", JSONArray()).put("showSomedaySection", false)
            .put("recurrence", JSONObject().put("dailyInterval", 1).put("monthlyPattern", "date")))
        .put("options", JSONObject().apply {
            listOf("statuses", "priorities", "energyLevels", "recurrences", "timeEstimates", "projects", "sections", "areas", "somedaySections")
                .forEach { put(it, JSONArray()) }
        })
        .put("fields", JSONObject().put("startTime", date).put("dueDate", date).put("reviewAt", date).put("dateIssue", "")
            .put("recurrence", JSONObject()).put("reminders", JSONObject()).put("timeEstimate", JSONObject())
            .put("timeSpent", JSONObject().put("enabled", false))),
        JSONObject().put("checklistBase", JSONArray()))

    @Test fun aSaveWithoutARecurrenceEditCarriesNoRecurrenceBaseline() {
        val save = editorActionSave(TaskEditor.open(model, "task").edit(mapOf("title" to "Renamed")))
        assertEquals(setOf("base", "patch", "scheduleBase"), save.keys().asSequence().toSet())
        assertTrue(save.getJSONObject("scheduleBase").has("dueDate"))
    }

    @Test fun aRecurrenceEditCarriesTheBaselineCoreChecksAgainst() {
        val save = editorActionSave(TaskEditor.open(model, "task").edit(mapOf("recurrence" to "daily")))
        assertTrue(save.has("recurrenceBase"))
        assertFalse(editorActionSave(TaskEditor.open(model, "task")).has("recurrenceBase"))
    }
}
