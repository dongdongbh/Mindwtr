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

/*
 * RN's Focus controls (app/(drawer)/(tabs)/focus.tsx) on core's Focus controls contract (native-host-contract-focus-controls.ts):
 * the header's View options and Filters buttons, the saved Focus filters, the active chips, the View options sheet, the filter
 * sheet with its Save, and Today's Focus reorder mode. Kotlin keeps only RN's screen state: core's control state (`controls.state`,
 * sent back with every Focus read and command), the open sheet or dialog, and reorder mode. Every label, chip, option and edit
 * is core's. Focus's reads stay InboxViewModel's (readFocus); every write is one of core's commands through MenuModel.command.
 */

/** Core windows every collection by NATIVE_HOST_MAX_WINDOW. */
private const val WINDOW = 100

class FocusModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val main = Handler(Looper.getMainLooper())

    /** Core's control state, RN's React state (filters, the applied saved filter, the sort): sent with every Focus read and command. */
    var state by mutableStateOf(saved.get<String>("focusControls")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()); private set
    /** The open sheet or dialog: View options, the filter sheet (its picker page and folds), Save filter, or a delete question. */
    var dialog by mutableStateOf(saved.get<String>("focusDialog")?.let { runCatching { JSONObject(it) }.getOrNull() }); private set
    /** RN's reorder mode for Today's Focus. */
    var reordering by mutableStateOf(saved.get<Boolean>("focusReorder") == true); private set
    /** The sheet's lists (tokens, projects, saved filters) read past their first window, with the Focus revision they belong to. */
    var lists by mutableStateOf<Pair<String, Map<String, List<JSONObject>>>?>(null); private set
    /** The filter picker's search: core's tokens or projects matching the typed query, from offset zero, at Focus's revision. */
    var pickerFound by mutableStateOf<JSONObject?>(null); private set

    private fun keepState(value: JSONObject) { state = value; saved["focusControls"] = value.toString() }
    fun keepDialog(value: JSONObject?) { dialog = value; saved["focusDialog"] = value?.toString() }
    private fun keepReordering(on: Boolean) { reordering = on; saved["focusReorder"] = on }

    /** A Focus read's answer: core's control state becomes the screen's; reorder mode ends once core no longer allows it (RN's effect). */
    fun adopt(view: FocusView) {
        val controls = view.controls ?: return
        keepState(controls.getJSONObject("state"))
        if (reordering && controls.isNull("reorder")) keepReordering(false)
    }

    /** A control's edit (a chip, a filter option, a sort, a saved filter): Focus read again with it, as core applies it. */
    fun edit(edit: JSONObject) = menu.whenIdle { shell.editFocusControls(edit) }

    private var typed = 0

    /**
     * The location field as typed, then core's setLocation filter edit (in the Focus control edit that carries a filter edit)
     * once typing pauses: only typed text builds an edit; every choice sends core's own.
     */
    fun typeLocation(text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:location", text)) }
        val mine = ++typed
        main.postDelayed({
            if (mine == typed) edit(JSONObject().put("type", "filter").put("edit", JSONObject().put("type", "setLocation").put("value", text)))
        }, 200)
    }

    // ---- Sheets and dialogs ----

    fun open(kind: String) = keepDialog(JSONObject().put("kind", kind))

    /** The filter sheet's picker page (tokens or projects; null: its first page); its search starts empty. */
    fun page(name: String?) {
        pickerFound = null
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); if (name == null) remove("page") else put("page", name) }) }
    }

    private var searched = 0

    /** The picker's search box: kept with the sheet as typed, then core's matching tokens or projects once typing pauses (the Inbox picker's). */
    fun pickerQuery(name: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text)) }
        val mine = ++searched
        main.postDelayed({ if (mine == searched) searchPicker(name, text) }, 200)
    }

    /**
     * Core's [name] options (tokens or projects) matching [query] through getFocusControlsList, from offset zero at Focus's revision, to
     * [depth] (a More reads one window deeper); a blank query shows the sheet's own. Focus that changed meanwhile is read again, and its
     * new revision runs the search again (the sheet's LaunchedEffect), so a typed search never stays unanswered.
     */
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

    /** A disclosure in the filter sheet (time estimate, energy, more filters), open or folded. */
    fun toggle(id: String) { dialog?.let { keepDialog(JSONObject(it.toString()).put(id, !it.optBoolean(id))) } }

    /** RN's Back: a picker returns to the sheet, the Save dialog to the filter sheet, anything else closes. */
    fun back() {
        val open = dialog ?: return
        when {
            open.has("page") -> page(null)
            open.optString("kind") == "save" -> open("filters")
            else -> keepDialog(null)
        }
    }

    /** RN's Save filter dialog, starting with core's name for the current filter, and the request UUID core makes the filter's id. */
    fun openSave(defaultName: String) =
        keepDialog(JSONObject().put("kind", "save").put("text", defaultName).put("requestId", UUID.randomUUID().toString()))

    fun typeName(text: String) { dialog?.takeIf { it.optString("kind") == "save" }?.let { keepDialog(JSONObject(it.toString()).put("text", text)) } }

    /** RN's delete question for a saved filter ([chip]: its id and name), or for an applied filter's advanced criterion. */
    fun confirmDelete(id: String, name: String) = keepDialog(JSONObject().put("kind", "deleteFilter").put("id", id).put("name", name))
    fun confirmRemove(criterionId: String, label: String) = keepDialog(JSONObject().put("kind", "removeCriterion").put("id", criterionId).put("name", label))

    // ---- Reorder ----

    fun reorder(on: Boolean) = keepReordering(on)

    // ---- Paging the sheet's lists ----

    /** A sheet list ([name]: tokens, projects or savedFilters) as shown: its first window, or as far as More read at [revision]. */
    fun collection(name: String, first: JSONObject, revision: String): List<JSONObject> =
        lists?.takeIf { it.first == revision }?.second?.get(name) ?: first.menuObjects("items")

    /** The next window of a sheet list through core's getFocusControlsList, under Focus's revision; a changed Focus reads Focus again. */
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
                // Focus changed: the sheet shows core's first windows again until the next Focus read.
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

    // ---- Commands ----

    /** One of core's Focus commands ([kind]) with the control state and its own [input]; a new request UUID. */
    private fun command(kind: String, input: JSONObject) = menu.command(kind, JSONObject(input.toString()).put("controls", state))

    /** A View options group chip: core's setFocusGroupBy (the synced grouping; it detaches an applied saved filter). */
    fun group(groupBy: String) = command("focusGroup", JSONObject().put("groupBy", groupBy))

    /** The Save dialog's Save: core's saveFocusFilter under the dialog's request UUID (the new filter's id), on disk first. */
    fun save() {
        val open = dialog?.takeIf { it.optString("kind") == "save" } ?: return
        val name = open.optString("text")
        if (name.isBlank()) return
        menu.create(FailedAction("focusSave", open.getString("requestId"), JSONObject().put("controls", state).put("name", name).toString()))
    }

    /** The owed Save's exact request (Save re-sends it). */
    fun saveAction(): FailedAction? {
        val open = dialog?.takeIf { it.optString("kind") == "save" } ?: return null
        return FailedAction("focusSave", open.getString("requestId"), JSONObject().put("controls", state).put("name", open.optString("text")).toString())
    }

    /** The delete question's Delete: core's deleteFocusFilter or removeFocusFilterCriterion. */
    fun confirmed() {
        val open = dialog ?: return
        keepDialog(if (open.optString("kind") == "removeCriterion") JSONObject().put("kind", "filters") else null)
        if (open.optString("kind") == "removeCriterion") command("focusCriterion", JSONObject().put("criterionId", open.getString("id")))
        else command("focusDelete", JSONObject().put("id", open.getString("id")))
    }

    /**
     * Today's Focus in a new order ([ids]: every starred task Focus shows, once), with each row's taskRevision as core's reorder
     * screen showed it ([taskRevisions]): core's reorderFocus writes only the moved tasks.
     */
    fun reorderTo(ids: List<String>, taskRevisions: JSONObject) = command("focusReorder", JSONObject().put("ids", JSONArray(ids)).put("taskRevisions", taskRevisions))

    /** Core's answer: its control state (a saved filter applied or detached) becomes the screen's; Save's dialog closes. */
    fun done(action: FailedAction, reply: JSONObject) {
        keepState(reply.getJSONObject("controls"))
        if (action.kind == "focusSave" && dialog?.optString("kind") == "save") keepDialog(null)
    }

    /** A refused Save wrote nothing: the dialog's next Save gets a fresh request UUID. */
    fun refused(action: FailedAction) {
        dialog?.takeIf { it.optString("kind") == "save" && it.optString("requestId") == action.id }
            ?.let { keepDialog(JSONObject(it.toString()).put("requestId", UUID.randomUUID().toString())) }
    }
}
