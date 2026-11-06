package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject

internal const val ROW_CHECKLIST_FLUSH_MS = 200L

data class RowChecklistItem(val id: String, val title: String, val completed: Boolean, val inline: List<JSONObject>)

class RowChecklistPending(val completed: MutableMap<String, Boolean> = linkedMapOf(), val added: MutableList<Pair<String, String>> = mutableListOf())

internal fun shownRowChecklist(read: JSONObject, pending: RowChecklistPending?): List<RowChecklistItem> {
    val stored = read.menuObjects("items").map { item ->
        RowChecklistItem(item.getString("id"), item.getString("title"), item.getBoolean("completed"), item.menuObjects("inline"))
    }
    if (pending == null) return stored
    val storedIds = stored.map { it.id }.toSet()
    val added = pending.added.filter { (id, _) -> id !in storedIds }.map { (id, title) ->
        RowChecklistItem(id, title, false, listOf(JSONObject().put("type", "text").put("text", title)))
    }
    return (stored + added).map { item -> pending.completed[item.id]?.let { item.copy(completed = it) } ?: item }
}

internal fun rowChecklistEditInput(taskId: String, pending: RowChecklistPending): JSONObject = JSONObject()
    .put("taskId", taskId)
    .put("completed", JSONObject().apply { pending.completed.forEach { (id, done) -> put(id, done) } })
    .put("added", JSONArray().apply { pending.added.forEach { (id, title) -> put(JSONObject().put("id", id).put("title", title)) } })

internal fun mergeRowChecklist(first: RowChecklistPending?, second: RowChecklistPending?): RowChecklistPending? {
    if (first == null) return second
    if (second == null) return first
    return RowChecklistPending(LinkedHashMap(first.completed).apply { putAll(second.completed) }, (first.added + second.added).toMutableList())
}

enum class RowChecklistOutcome { Written, Dropped, Owed }

class RowChecklistEdits(
    private val schedule: (key: String, delayMs: Long, run: () -> Unit) -> Unit,
    private val cancel: (key: String) -> Unit,
    private val send: (taskId: String, payload: () -> JSONObject?) -> Unit,
    private val changed: () -> Unit,
) {
    private val pending = mutableMapOf<String, RowChecklistPending>()
    private val outgoing = mutableMapOf<String, RowChecklistPending>()
    private val sent = mutableSetOf<String>()
    private val owed = mutableSetOf<String>()

    private fun key(taskId: String) = "rowChecklist:$taskId"

    fun edit(taskId: String, change: (RowChecklistPending) -> Unit) {
        change(pending.getOrPut(taskId) { RowChecklistPending() })
        cancel(key(taskId))
        schedule(key(taskId), ROW_CHECKLIST_FLUSH_MS) { flush(taskId) }
        changed()
    }

    fun flush(taskId: String) {
        cancel(key(taskId))
        val next = pending.remove(taskId) ?: return
        val waiting = outgoing[taskId]
        when {
            waiting == null -> {
                outgoing[taskId] = next
                send(taskId) { outgoing[taskId]?.takeIf { taskId !in sent }?.let { edit -> sent += taskId; rowChecklistEditInput(taskId, edit) } }
            }
            taskId !in sent -> outgoing[taskId] = mergeRowChecklist(waiting, next)!!
            else -> pending[taskId] = mergeRowChecklist(next, pending[taskId])!!
        }
        changed()
    }

    fun settled(taskId: String, outcome: RowChecklistOutcome): RowChecklistPending? {
        val edit = outgoing[taskId] ?: return null
        if (outcome == RowChecklistOutcome.Owed) {
            owed += taskId
            changed()
            return null
        }
        outgoing.remove(taskId)
        sent -= taskId
        owed -= taskId
        if (pending.containsKey(taskId)) flush(taskId)
        changed()
        return edit.takeIf { outcome == RowChecklistOutcome.Written }
    }

    fun isOwed(taskId: String) = taskId in owed

    fun shown(taskId: String): RowChecklistPending? = mergeRowChecklist(outgoing[taskId]?.takeIf { taskId !in owed }, pending[taskId])
}
