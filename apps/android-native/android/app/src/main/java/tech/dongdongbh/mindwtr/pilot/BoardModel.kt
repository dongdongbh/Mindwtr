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
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.UUID


private const val PAGE = 50

private const val WINDOW = 100


class BoardPage(val view: JSONObject, val cards: Map<String, List<JSONObject>>, val lists: Map<String, List<JSONObject>>) {
    val revision: String get() = view.getString("revision")
    val filters: JSONObject get() = view.getJSONObject("filters")

    fun collection(name: String): List<JSONObject> = lists[name] ?: view.getJSONObject("sheet").getJSONObject(name).menuObjects("items")
    fun collectionTotal(name: String): Int = view.getJSONObject("sheet").getJSONObject(name).getInt("total")

    val depth: Map<String, Int> get() = cards.mapValues { it.value.size } + lists.mapValues { it.value.size }
}

class BoardModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val main = Handler(Looper.getMainLooper())


    var filters by mutableStateOf(saved.get<String>("boardFilters")?.let(::JSONObject) ?: JSONObject()); private set

    var typed by mutableStateOf(saved.get<String>("boardSearch")); private set
    var page by mutableStateOf<BoardPage?>(null); private set

    var sheet by mutableStateOf(saved.get<String>("boardSheet")?.let(::JSONObject)); private set

    var found by mutableStateOf<JSONObject?>(null); private set

    private fun keepFilters(value: JSONObject) { filters = value; saved["boardFilters"] = value.toString() }
    private fun keepTyped(value: String?) { typed = value; saved["boardSearch"] = value }
    fun keepSheet(value: JSONObject?) { sheet = value; saved["boardSheet"] = value?.toString() }


    fun reset() {
        keepFilters(JSONObject()); keepTyped(null); keepSheet(null)
        page = null
    }


    private fun read(runtime: CoreHost, sent: JSONObject, edit: JSONObject?, depth: Map<String, Int>, again: Boolean = true): BoardPage {
        val view = runtime.menuRead("board", JSONObject().put("filters", sent).put("limit", PAGE).apply { edit?.let { put("filterEdit", it) } }.toString())
        check(view.optInt("version", 1) == 1) { "Unsupported core contract" }
        val cards = LinkedHashMap<String, List<JSONObject>>()
        for (column in view.menuObjects("columns")) cards[column.getString("status")] = column.menuObjects("cards")
        var shown = BoardPage(view, cards, emptyMap())
        try {
            for ((name, want) in depth) shown = pageTo(runtime, shown, name, want)
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
            if (again) return read(runtime, view.getJSONObject("filters"), null, depth, again = false)
        }
        return shown
    }


    private fun pageTo(runtime: CoreHost, shown: BoardPage, name: String, want: Int): BoardPage {
        val column = shown.view.menuObjects("columns").firstOrNull { it.getString("status") == name }
        var loaded = if (column != null) shown.cards[name].orEmpty() else shown.collection(name)
        val total = column?.getInt("count") ?: shown.collectionTotal(name)
        while (loaded.size < minOf(want, total)) {
            val input = JSONObject().put("filters", shown.filters).put("offset", loaded.size).put("limit", if (column != null) PAGE else WINDOW)
                .put("revision", shown.revision).apply { if (column != null) put("list", "cards").put("status", name) else put("list", name) }
            val next = runtime.menuRead("boardList", input.toString()).menuObjects("items")
            if (next.isEmpty()) break
            loaded = loaded + next
        }
        return if (column != null) BoardPage(shown.view, shown.cards + (name to loaded), shown.lists)
        else BoardPage(shown.view, shown.cards, shown.lists + (name to loaded))
    }


    private fun show(next: BoardPage) {
        if (menu.list != "board") return
        page = next
        keepFilters(next.filters)
    }


    fun reload(edit: JSONObject? = null, depth: Map<String, Int> = page?.depth.orEmpty()) = menu.whenIdle {
        val sent = filters
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, sent, edit, depth)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(next) }
        }
    }


    fun refresh() {
        val sent = filters
        val depth = page?.depth.orEmpty()
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, sent, null, depth) }) { next, mine ->
            if (shell.fresh(mine, Part.Menu)) show(next)
        }
    }


    fun more(name: String) {
        val shown = page ?: return
        val loaded = shown.cards[name]?.size ?: shown.collection(name).size
        reload(depth = shown.depth + (name to loaded + if (shown.cards.containsKey(name)) PAGE else WINDOW))
    }


    fun filterEdit(edit: JSONObject) {
        val type = edit.optString("type")
        if (type == "clear" || type == "setSearch") keepTyped(null)
        reload(edit)
    }


    fun clearSearch() = filterEdit(JSONObject().put("type", "setSearch").put("value", ""))
    fun clearFilters() = filterEdit(JSONObject().put("type", "clear"))

    private var searchTyped = 0


    fun typeSearch(text: String) {
        keepTyped(text)
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload(JSONObject().put("type", "setSearch").put("value", text)) }, 200)
    }

    private var pickerTyped = 0


    fun pickerQuery(name: String, text: String) {
        sheet?.let { keepSheet(JSONObject(it.toString()).put("query", text)) }
        val mine = ++pickerTyped
        main.postDelayed({ if (mine == pickerTyped) searchPicker(name, text) }, 200)
    }


    fun closePicker() {
        found = null
        sheet?.let { keepSheet(JSONObject(it.toString()).apply { remove("page"); remove("query") }) }
    }


    fun searchPicker(name: String, query: String, depth: Int = WINDOW) {
        val shown = page ?: return
        if (query.isBlank()) { found = null; return }
        shell.background(listOf(Part.MenuDialog), { runtime ->
            val items = JSONArray()
            var total: Int
            try {
                do {
                    val window = runtime.menuRead("boardList", JSONObject().put("filters", shown.filters).put("list", name).put("query", query)
                        .put("offset", items.length()).put("limit", WINDOW).put("revision", shown.revision).toString())
                    total = window.getInt("total")
                    val next = window.getJSONArray("items")
                    for (index in 0 until next.length()) items.put(next.get(index))
                } while (next.length() > 0 && items.length() < minOf(depth, total))
                JSONObject().put("name", name).put("query", query).put("revision", shown.revision).put("total", total).put("items", items)
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                null
            }
        }) { result, mine ->
            if (result != null && shell.fresh(mine, Part.MenuDialog)) found = result
            else if (result == null) reload()
        }
    }


    fun toggleToken(value: String) = reload(JSONObject().put("type", "toggleToken").put("value", value))
    fun toggleProject(id: String) = reload(JSONObject().put("type", "toggleProject").put("value", id))
    fun matchMode(kind: String, value: String) = reload(JSONObject().put("type", "setMatchMode").put("kind", kind).put("value", value))


    fun duePreset(preset: String) {
        sheet?.let { keepSheet(JSONObject(it.toString()).put("due", false)) }
        reload(JSONObject().put("type", "toggleDuePreset").put("preset", preset))
    }


    fun move(taskId: String, taskRevision: String, status: String, afterId: String?, sameColumn: Boolean) {
        val action = JSONObject().put("type", "moveCard").put("taskId", taskId).put("status", status).put("filters", filters).put("taskRevision", taskRevision)
        if (sameColumn) action.put("afterId", afterId ?: JSONObject.NULL)
        menu.command("boardAction", JSONObject().put("action", action))
    }


    fun trash(taskId: String, taskRevision: String) =
        menu.command("boardAction", JSONObject().put("action", JSONObject().put("type", "trashTask").put("taskId", taskId).put("taskRevision", taskRevision)))


    fun duplicate(taskId: String) = menu.create(FailedAction("boardCreate", UUID.randomUUID().toString(),
        JSONObject().put("action", JSONObject().put("type", "duplicateTask").put("taskId", taskId)).toString()))


    fun done(action: FailedAction, reply: JSONObject) {
        if (action.kind != "boardCreate") return

        reply.optJSONObject("open")?.let { open -> menu.whenIdle { shell.openEditor(open.getString("taskId"), "task") } }
    }
}
