package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test


class TaskEditorChecklistAddTest {
    private val date = JSONObject().put("value", "null").put("label", "").put("hasTime", false).put("dateOnly", "null")
        .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())


    private val model = EditorModel.of(JSONObject().put("version", 1).put("id", "t").put("readOnly", false)
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

    @Test fun typedItemTextIsUnsavedAndSurvivesARestore() {
        val opened = TaskEditor.open(model, "view")
        assertFalse(opened.dirty)
        val typed = opened.copy(checklistAdd = "Buy milk")

        assertTrue(typed.dirty)
        assertFalse(opened.copy(checklistAdd = "   ").dirty)

        assertEquals("Buy milk", TaskEditor.restore(model, typed.state()).checklistAdd)
        assertEquals("", TaskEditor.restore(model, opened.state().apply { remove("checklistAdd") }).checklistAdd)
    }

    @Test fun saveQueuesTheTypedItemAsCoreAppendAndEmptiesTheField() {
        val typed = TaskEditor.open(model, "view").copy(checklistAdd = "  Buy milk ")
        val queued = typed.checklistAddQueued()
        assertEquals("", queued.checklistAdd)
        assertEquals(1, queued.pending.size)
        val edit = JSONObject(queued.pending.single().edit).getJSONObject("checklist")
        assertEquals("append", edit.getString("kind"))
        assertEquals("Buy milk", edit.getString("title"))

        val blank = TaskEditor.open(model, "view").copy(checklistAdd = " ")
        assertSame(blank, blank.checklistAddQueued())
    }


    @Test fun aRefusedAppendPutsTheTypedTextBack() {
        val queued = TaskEditor.open(model, "view").copy(checklistAdd = "Buy milk").checklistAddQueued()
        val refused = queued.refused(queued.pending.first())
        assertEquals("Buy milk", refused.checklistAdd)
        assertTrue(refused.pending.isEmpty())
        assertTrue(refused.dirty)

        assertEquals("Eggs", queued.copy(checklistAdd = "Eggs").refused(queued.pending.first()).checklistAdd)

        val other = TaskEditor.open(model, "view").queued(JSONObject().put("type", "pickTime").toString(), null)
        assertEquals("", other.refused(other.pending.first()).checklistAdd)
    }
}
