package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class EditorNavigationTest {
    private val date = JSONObject().put("value", "null").put("label", "").put("hasTime", false).put("dateOnly", "null")
        .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())


    private fun model(readOnly: Boolean) = EditorModel.of(JSONObject().put("version", 1).put("id", "t").put("readOnly", readOnly)
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

    private val opened = TaskEditor.open(model(readOnly = false), "task")

    @Test fun anEditorWithNothingInItClosesOnNavigation() {
        assertTrue(opened.closesOnNavigation(editsPending = false, covered = false))
    }

    @Test fun anEditorHoldingWorkStaysOpen() {

        assertFalse(opened.copy(waitingFor = "").closesOnNavigation(editsPending = false, covered = false))
        assertFalse(opened.copy(waitingFor = "Sam").closesOnNavigation(editsPending = false, covered = false))

        assertFalse(opened.closesOnNavigation(editsPending = false, covered = true))
        assertFalse(opened.closesOnNavigation(editsPending = true, covered = false))
        assertFalse(opened.copy(checklistAdd = "Buy milk").closesOnNavigation(editsPending = false, covered = false))
    }

    @Test fun aReadOnlyEditorAlwaysClosesOnNavigation() {
        val readOnly = TaskEditor.open(model(readOnly = true), "view")
        assertTrue(readOnly.closesOnNavigation(editsPending = false, covered = true))
        assertTrue(readOnly.copy(waitingFor = "Sam").closesOnNavigation(editsPending = true, covered = false))
    }
}
