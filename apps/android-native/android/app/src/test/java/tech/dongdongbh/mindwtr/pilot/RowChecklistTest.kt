package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class RowChecklistTest {
    private fun read(vararg items: Triple<String, String, Boolean>) = JSONObject().put("items", JSONArray(items.map { (id, title, done) ->
        JSONObject().put("id", id).put("title", title).put("completed", done).put("inline", JSONArray().put(JSONObject().put("type", "text").put("text", title)))
    }))

    @Test fun aTickShowsAtOnceOnTheItemWithThatIdBeforeTheWrite() {
        val pending = RowChecklistPending().apply { completed["b"] = true }
        val shown = shownRowChecklist(read(Triple("a", "Bread", false), Triple("b", "Milk", false)), pending)
        assertEquals(listOf("a" to false, "b" to true), shown.map { it.id to it.completed })
    }

    @Test fun anAddedItemShowsAtTheEndOnceEvenWhenTheReadAlreadyHasIt() {
        val pending = RowChecklistPending().apply { added += "c" to "Eggs"; added += "a" to "Bread again" }
        val shown = shownRowChecklist(read(Triple("a", "Bread", false)), pending)
        assertEquals(listOf("Bread", "Eggs"), shown.map { it.title })
        assertEquals(listOf(false, false), shown.map { it.completed })
    }

    @Test fun ticksWithinTheFlushWindowGoOutAsOneEdit() {
        val pending = RowChecklistPending().apply { completed["a"] = true; completed["b"] = true; completed["a"] = false; added += "c" to "Eggs" }
        val input = rowChecklistEditInput("t1", pending)
        assertEquals("t1", input.getString("taskId"))
        assertEquals(mapOf("a" to false, "b" to true), input.getJSONObject("completed").let { json -> json.keys().asSequence().associateWith { json.getBoolean(it) } })
        assertEquals("Eggs", input.getJSONArray("added").getJSONObject(0).getString("title"))
        assertEquals(200L, ROW_CHECKLIST_FLUSH_MS)
    }

    @Test fun noPendingEditShowsTheReadAsIs() {
        assertEquals(listOf("a" to true), shownRowChecklist(read(Triple("a", "Bread", true)), null).map { it.id to it.completed })
    }
}
