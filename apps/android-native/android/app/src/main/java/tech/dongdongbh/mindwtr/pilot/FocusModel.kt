package tech.dongdongbh.mindwtr.pilot

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.InboxViewModel.Part
import java.util.UUID


private const val WINDOW = 100

class FocusModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val main = Handler(Looper.getMainLooper())


    var state by mutableStateOf(saved.get<String>("focusControls")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()); private set

    var dialog by mutableStateOf(saved.get<String>("focusDialog")?.let { runCatching { JSONObject(it) }.getOrNull() }); private set

    var reordering by mutableStateOf(saved.get<Boolean>("focusReorder") == true); private set

    var lists by mutableStateOf<Pair<String, Map<String, List<JSONObject>>>?>(null); private set

    var pickerFound by mutableStateOf<JSONObject?>(null); private set

    private fun keepState(value: JSONObject) { state = value; saved["focusControls"] = value.toString() }
    fun keepDialog(value: JSONObject?) { dialog = value; saved["focusDialog"] = value?.toString() }
    private fun keepReordering(on: Boolean) { reordering = on; saved["focusReorder"] = on }


    fun adopt(view: FocusView) {
        val controls = view.controls ?: return
        keepState(controls.getJSONObject("state"))
        if (reordering && controls.isNull("reorder")) keepReordering(false)
    }


    fun edit(edit: JSONObject) = menu.whenIdle { shell.editFocusControls(edit) }

    private var typed = 0


    fun typeLocation(text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:location", text)) }
        val mine = ++typed
        main.postDelayed({
            if (mine == typed) edit(JSONObject().put("type", "filter").put("edit", JSONObject().put("type", "setLocation").put("value", text)))
        }, 200)
    }


    fun open(kind: String) = keepDialog(JSONObject().put("kind", kind))


    fun page(name: String?) {
        pickerFound = null
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); if (name == null) remove("page") else put("page", name) }) }
    }

    private var searched = 0


    fun pickerQuery(name: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text)) }
        val mine = ++searched
        main.postDelayed({ if (mine == searched) searchPicker(name, text) }, 200)
    }


    fun searchPicker(name: String, query: String, depth: Int = WINDOW) {
        val revision = shell.focus?.let { shell.focusRevision } ?: return
        if (query.isBlank()) { pickerFound = null; return }
        val sent = state.toString()
        shell.background(listOf(Part.MenuDialog), { runtime ->
            val items = JSONArray()
            var total: Int
            try {
                do {
                    val window = runtime.menuRead("focusList", JSONObject().put("controls", JSONObject(sent)).put("list", name).put("offset", items.length())
                        .put("limit", WINDOW).put("revision", revision).put("query", query).toString())
                    total = window.getInt("total")
                    val next = window.getJSONArray("items")
                    for (index in 0 until next.length()) items.put(next.get(index))
                } while (next.length() > 0 && items.length() < minOf(depth, total))
                JSONObject().put("name", name).put("query", query).put("revision", revision).put("total", total).put("items", items)
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                null
            }
        }) { found, mine ->
            if (found != null && shell.fresh(mine, Part.MenuDialog)) pickerFound = found
            else if (found == null) shell.refreshFocus()
        }
    }


    fun toggle(id: String) { dialog?.let { keepDialog(JSONObject(it.toString()).put(id, !it.optBoolean(id))) } }


    fun back() {
        val open = dialog ?: return
        when {
            open.has("page") -> page(null)
            open.optString("kind") == "save" -> open("filters")
            else -> keepDialog(null)
        }
    }


    fun openSave(defaultName: String) =
        keepDialog(JSONObject().put("kind", "save").put("text", defaultName).put("requestId", UUID.randomUUID().toString()))

    fun typeName(text: String) { dialog?.takeIf { it.optString("kind") == "save" }?.let { keepDialog(JSONObject(it.toString()).put("text", text)) } }


    fun confirmDelete(id: String, name: String) = keepDialog(JSONObject().put("kind", "deleteFilter").put("id", id).put("name", name))
    fun confirmRemove(criterionId: String, label: String) = keepDialog(JSONObject().put("kind", "removeCriterion").put("id", criterionId).put("name", label))


    fun reorder(on: Boolean) = keepReordering(on)


    fun collection(name: String, first: JSONObject, revision: String): List<JSONObject> =
        lists?.takeIf { it.first == revision }?.second?.get(name) ?: first.menuObjects("items")


    fun loadMore(name: String, first: JSONObject, revision: String) {
        val shown = collection(name, first, revision)
        val sent = state.toString()
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = try {
                runtime.menuRead("focusList", JSONObject().put("controls", JSONObject(sent)).put("list", name).put("offset", shown.size)
                    .put("limit", WINDOW).put("revision", revision).toString()).menuObjects("items")
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure

                shell.ui { lists = null }
                return@perform
            }
            shell.ui {
                if (!shell.fresh(mine, Part.Focus)) return@ui
                val kept = lists?.takeIf { it.first == revision }?.second.orEmpty()
                lists = revision to (kept + (name to shown + next))
            }
        }
    }


    private fun command(kind: String, input: JSONObject) = menu.command(kind, JSONObject(input.toString()).put("controls", state))


    fun group(groupBy: String) = command("focusGroup", JSONObject().put("groupBy", groupBy))


    fun save() {
        val open = dialog?.takeIf { it.optString("kind") == "save" } ?: return
        val name = open.optString("text")
        if (name.isBlank()) return
        menu.create(FailedAction("focusSave", open.getString("requestId"), JSONObject().put("controls", state).put("name", name).toString()))
    }


    fun saveAction(): FailedAction? {
        val open = dialog?.takeIf { it.optString("kind") == "save" } ?: return null
        return FailedAction("focusSave", open.getString("requestId"), JSONObject().put("controls", state).put("name", open.optString("text")).toString())
    }


    fun confirmed() {
        val open = dialog ?: return
        keepDialog(if (open.optString("kind") == "removeCriterion") JSONObject().put("kind", "filters") else null)
        if (open.optString("kind") == "removeCriterion") command("focusCriterion", JSONObject().put("criterionId", open.getString("id")))
        else command("focusDelete", JSONObject().put("id", open.getString("id")))
    }


    fun reorderTo(ids: List<String>, taskRevisions: JSONObject) = command("focusReorder", JSONObject().put("ids", JSONArray(ids)).put("taskRevisions", taskRevisions))


    fun done(action: FailedAction, reply: JSONObject) {
        keepState(reply.getJSONObject("controls"))
        if (action.kind == "focusSave" && dialog?.optString("kind") == "save") keepDialog(null)
    }


    fun refused(action: FailedAction) {
        dialog?.takeIf { it.optString("kind") == "save" && it.optString("requestId") == action.id }
            ?.let { keepDialog(JSONObject(it.toString()).put("requestId", UUID.randomUUID().toString())) }
    }
}
