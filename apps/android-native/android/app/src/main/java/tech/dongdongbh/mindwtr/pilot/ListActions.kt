package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject


internal fun setTaskStatus(taskId: String, status: String, taskRevision: String): JSONObject =
    JSONObject().put("type", "setTaskStatus").put("taskId", taskId).put("status", status).put("taskRevision", taskRevision)
internal fun trashTask(taskId: String, taskRevision: String): JSONObject = JSONObject().put("type", "trashTask").put("taskId", taskId).put("taskRevision", taskRevision)
internal fun trashTasks(taskIds: List<String>, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "trashTasks").put("taskIds", JSONArray(taskIds)).put("taskRevisions", taskRevisions)
internal fun moveTasks(taskIds: List<String>, status: String, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "moveTasks").put("taskIds", JSONArray(taskIds)).put("status", status).put("taskRevisions", taskRevisions)


internal fun editTaskTokens(taskIds: List<String>, field: String, mode: String, values: List<String>, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "editTaskTokens").put("taskIds", JSONArray(taskIds)).put("field", field).put("mode", mode).put("values", JSONArray(values))
        .put("taskRevisions", taskRevisions)


internal fun restoreItem(kind: String, id: String, revision: String): JSONObject =
    JSONObject().put("type", "restoreItem").put("kind", kind).put("id", id).put("revision", revision)
internal fun purgeItem(kind: String, id: String, revision: String): JSONObject =
    JSONObject().put("type", "purgeItem").put("kind", kind).put("id", id).put("revision", revision)
internal fun restoreItems(selected: JSONObject): JSONObject = JSONObject().put("type", "restoreItems").selection(selected)
internal fun purgeItems(selected: JSONObject): JSONObject = JSONObject().put("type", "purgeItems").selection(selected)
private fun JSONObject.selection(selected: JSONObject): JSONObject =
    put("taskIds", selected.getJSONArray("taskIds")).put("projectIds", selected.getJSONArray("projectIds"))
        .put("taskRevisions", selected.getJSONObject("taskRevisions")).put("projectRevisions", selected.getJSONObject("projectRevisions"))
internal fun emptyTrash(revision: String): JSONObject = JSONObject().put("type", "emptyTrash").put("revision", revision)


internal fun addTag(taskIds: List<String>, tag: String, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "addTag").put("taskIds", JSONArray(taskIds)).put("tag", tag).put("taskRevisions", taskRevisions)
internal fun removeTags(taskIds: List<String>, tags: List<String>, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "removeTags").put("taskIds", JSONArray(taskIds)).put("tags", JSONArray(tags)).put("taskRevisions", taskRevisions)
internal fun markReviewedTasks(taskIds: List<String>, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "markReviewedTasks").put("taskIds", JSONArray(taskIds)).put("taskRevisions", taskRevisions)
internal fun organizeTasks(taskIds: List<String>, draft: JSONObject, taskRevisions: JSONObject): JSONObject =
    JSONObject().put("type", "organizeTasks").put("taskIds", JSONArray(taskIds)).put("draft", draft).put("taskRevisions", taskRevisions)


internal fun addProjectTask(projectId: String, title: String): JSONObject = JSONObject().put("type", "addProjectTask").put("projectId", projectId).put("title", title)
internal fun followUpToday(taskId: String, taskRevision: String): JSONObject =
    JSONObject().put("type", "followUpToday").put("taskId", taskId).put("taskRevision", taskRevision)


internal fun JSONArray?.ids(): List<String> = this?.let { list -> List(list.length()) { list.getString(it) } }.orEmpty()
