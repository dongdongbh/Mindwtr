package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test


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
    @Test fun lateInputAndImeSubmitCannotCrossAPendingPositionChange() {
        val threeRows = """[{"id":"a","title":"A","isCompleted":false},{"id":"b","title":"B","isCompleted":false},{"id":"c","title":"C","isCompleted":false}]"""
        val editor = TaskEditor.open(model(threeRows), "task")
        val beforeMove = editor.queued(JSONObject().put("checklist", JSONObject().put("kind", "rename").put("index", 1).put("text", "Already typed")).toString(), "checklist:row-1")
        val moving = beforeMove.queued(JSONObject().put("checklist", JSONObject().put("kind", "move").put("from", 0).put("to", 2)).toString(), null)
        val lateRename = moving.queued(JSONObject().put("checklist", JSONObject().put("kind", "rename").put("index", 1).put("text", "B edited")).toString(), "checklist:row-2")
        val lateSubmit = lateRename.queued(JSONObject().put("checklist", JSONObject().put("kind", "insertAfter").put("index", 1)).toString(), "checklist:row-2")
        assertEquals(true, moving.checklistStructurePending)
        assertEquals(moving, lateRename)
        assertEquals(moving, lateSubmit)
        assertEquals(listOf("rename", "move"), lateSubmit.pending.map { JSONObject(it.edit).getJSONObject("checklist").getString("kind") })
        assertEquals("Already typed", JSONObject(lateSubmit.pending[0].edit).getJSONObject("checklist").getString("text"))
    }

    @Test fun everyRowShiftingEditBlocksStalePositionsWhileRapidTypingRemainsResponsive() {
        val editor = TaskEditor.open(model(opened), "task")
        val rename = JSONObject().put("checklist", JSONObject().put("kind", "rename").put("index", 0).put("text", "Typing")).toString()
        val typing = editor.queued(rename, "checklist:row-1").queued(rename, "checklist:row-1")
        assertEquals(2, typing.pending.size)
        assertEquals(false, typing.checklistStructurePending)
        for (kind in listOf("move", "remove", "insertAfter", "add", "append", "rename")) {
            val operation = JSONObject().put("kind", kind).put("index", 0).put("from", 0).put("to", 1)
                .put("text", "Pasted\nrow").put("title", "Append")
            val pending = editor.queued(JSONObject().put("checklist", operation).toString(), null)
            assertEquals(true, pending.checklistStructurePending)
            assertEquals(pending, pending.queued(rename, "checklist:row-1"))
            val settled = pending.refused(pending.pending.first())
            assertEquals(false, settled.checklistStructurePending)
            assertEquals(1, settled.queued(rename, "checklist:row-1").pending.size)
        }
    }

}
