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

    private class Clock {
        var now = 0L
        val timers = mutableMapOf<String, Pair<Long, () -> Unit>>()
        val sends = mutableListOf<Pair<String, () -> JSONObject?>>()
        val sentPayloads = mutableListOf<JSONObject>()
        val edits = RowChecklistEdits({ key, delay, run -> timers[key] = now + delay to run }, { key -> timers.remove(key) },
            { taskId, payload -> sends += taskId to payload }, {})
        fun advance(ms: Long) {
            now += ms
            timers.entries.filter { it.value.first <= now }.map { it.key }.forEach { key -> timers.remove(key)?.second?.invoke() }
        }
        fun runSends() { val ready = sends.toList(); sends.clear(); ready.forEach { (_, payload) -> payload()?.let(sentPayloads::add) } }
    }

    private fun JSONObject.ticks() = getJSONObject("completed").let { json -> json.keys().asSequence().associateWith { json.getBoolean(it) } }

    @Test fun twoTicksInside200MsMakeOneSend() {
        val clock = Clock()
        clock.edits.edit("t1") { it.completed["a"] = true }
        clock.advance(150)
        clock.edits.edit("t1") { it.completed["b"] = true }
        clock.advance(150)
        assertEquals(0, clock.sends.size)
        clock.advance(60)
        clock.runSends()
        assertEquals(listOf(mapOf("a" to true, "b" to true)), clock.sentPayloads.map { it.ticks() })
    }

    @Test fun twoTicksAcross200MsMakeTwoSendsInOrder() {
        val clock = Clock()
        clock.edits.edit("t1") { it.completed["a"] = true }
        clock.advance(250)
        clock.runSends()
        clock.edits.edit("t1") { it.completed["a"] = false }
        clock.advance(250)
        assertEquals("a second send waits while the first is in flight", 0, clock.sends.size)
        clock.edits.settled("t1", RowChecklistOutcome.Written)
        clock.runSends()
        assertEquals(listOf(mapOf("a" to true), mapOf("a" to false)), clock.sentPayloads.map { it.ticks() })
    }

    @Test fun aTickMadeWhileTheEditWaitsToGoOutJoinsIt() {
        val clock = Clock()
        clock.edits.edit("t1") { it.completed["a"] = true }
        clock.advance(250)
        clock.edits.edit("t1") { it.completed["b"] = true }
        clock.advance(250)
        clock.runSends()
        assertEquals(listOf(mapOf("a" to true, "b" to true)), clock.sentPayloads.map { it.ticks() })
    }

    @Test fun anOwedSendIsNotShownAsWrittenAndARefusedOneIsDropped() {
        val clock = Clock()
        clock.edits.edit("t1") { it.completed["a"] = true }
        clock.advance(250)
        clock.runSends()
        assertEquals(mapOf("a" to true), clock.edits.shown("t1")?.completed)
        assertEquals(null, clock.edits.settled("t1", RowChecklistOutcome.Owed))
        assertEquals(null, clock.edits.shown("t1"))
        assertEquals(mapOf("a" to true), clock.edits.settled("t1", RowChecklistOutcome.Written)?.completed)
        clock.edits.edit("t1") { it.completed["b"] = true }
        clock.advance(250)
        clock.runSends()
        assertEquals(null, clock.edits.settled("t1", RowChecklistOutcome.Dropped))
        assertEquals(null, clock.edits.shown("t1"))
    }
}
