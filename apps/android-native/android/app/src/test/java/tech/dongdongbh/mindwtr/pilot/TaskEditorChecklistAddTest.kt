package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The View tab's add-item text belongs to the draft, as RN's checklistDraftRef does (9d3a7c87d; audit 10-25 gap 4). */
class TaskEditorChecklistAddTest {
    private val date = JSONObject().put("value", "null").put("label", "").put("hasTime", false).put("dateOnly", "null")
        .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())

    /** The smallest editor model core could send: one open task with an empty checklist. */
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
        // Close asks before it drops the typed item, as RN's hasPendingChanges does.
        assertTrue(typed.dirty)
        assertFalse(opened.copy(checklistAdd = "   ").dirty)
        // The draft file keeps it, so a process death does not lose it either.
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
        // Nothing typed: Save queues nothing.
        val blank = TaskEditor.open(model, "view").copy(checklistAdd = " ")
        assertSame(blank, blank.checklistAddQueued())
    }
}
