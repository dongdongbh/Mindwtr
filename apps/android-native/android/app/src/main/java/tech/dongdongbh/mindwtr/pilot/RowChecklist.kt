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
