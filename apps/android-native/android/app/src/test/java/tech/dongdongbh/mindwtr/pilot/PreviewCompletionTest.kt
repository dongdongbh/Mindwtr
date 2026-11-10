package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PreviewCompletionTest {
    private val date = JSONObject().put("value", "null").put("label", "").put("hasTime", false).put("dateOnly", "null")
        .put("picker", JSONObject().put("date", "").put("time", "")).put("quickDates", JSONArray())


    private fun model(status: String = "next", readOnly: Boolean = false) = EditorModel.of(JSONObject().put("version", 1).put("id", "t").put("readOnly", readOnly)
        .put("focusStar", JSONObject()).put("draft", JSONObject().put("title", "Task").put("status", status))
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


    @Test fun pendingAppendPrecedesDoneWithoutLosingTheDirtyDraft() {
        val original = TaskEditor.open(model(), "view").edit(mapOf("title" to "Edited", "description" to "Notes"))
            .copy(checklistAdd = " Pending item ").typed("tags", "#work")
        val queued = original.previewCompletionQueued()
        assertEquals("Edited", queued.text("title"))
        assertEquals("Notes", queued.text("description"))
        assertEquals("#work", queued.input("tags"))
        assertEquals("", queued.checklistAdd)
        assertEquals(2, queued.pending.size)
        assertEquals("append", JSONObject(queued.pending[0].edit).getJSONObject("checklist").getString("kind"))
        assertEquals("Pending item", JSONObject(queued.pending[0].edit).getJSONObject("checklist").getString("title"))
        assertEquals("done", JSONObject(queued.pending[1].edit).getJSONObject("patch").getString("status"))
        assertEquals(queued.pending[1].seq, queued.previewCompletionSeq)
        assertEquals("next", queued.text("status"))
        assertSame(queued, queued.previewCompletionQueued())
    }

    @Test fun aRefusedDraftEditCancelsCompletionAndPreservesPendingChecklistText() {
        val queued = TaskEditor.open(model(), "view").copy(checklistAdd = "Item").previewCompletionQueued()
        val refused = queued.refused(queued.pending.first())
        assertNull(refused.previewCompletionSeq)
        assertTrue(refused.pending.isEmpty())
        assertEquals("Item", refused.checklistAdd)
        assertEquals("next", refused.text("status"))
    }

    @Test fun queuedAndReadyCompletionIntentsSurviveDraftRecovery() {
        val current = model()
        val queued = TaskEditor.open(current, "view").copy(checklistAdd = "Item").previewCompletionQueued()
        val restored = TaskEditor.restore(current, queued.state())
        assertEquals(queued.previewCompletionSeq, restored.previewCompletionSeq)
        assertEquals(queued.pending, restored.pending)
        assertSame(restored, restored.previewCompletionQueued())
        val ready = queued.copy(pending = emptyList()).edit(mapOf("status" to "done"))
        val readyRestored = TaskEditor.restore(current, ready.state())
        assertNotNull(readyRestored.previewCompletionSeq)
        assertEquals("done", readyRestored.text("status"))
        assertTrue(readyRestored.dirty)
        assertNull(TaskEditor.restore(current, TaskEditor.open(current, "view").state().apply { remove("previewCompletionSeq") }).previewCompletionSeq)
    }

    @Test fun terminalReferenceAndReadOnlyDraftsCannotStartCompletion() {
        for (status in listOf("done", "archived", "reference")) {
            val current = TaskEditor.open(model(status), "view")
            assertSame(current, current.previewCompletionQueued())
        }
        val readOnly = TaskEditor.open(model(readOnly = true), "view")
        assertSame(readOnly, readOnly.previewCompletionQueued())
    }
}
