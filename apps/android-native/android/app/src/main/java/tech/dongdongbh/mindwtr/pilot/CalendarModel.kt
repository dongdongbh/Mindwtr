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
import tech.dongdongbh.mindwtr.pilot.core.HostCalendars
import java.util.UUID


private const val WINDOW = 100


data class ComposerDraft(
    val view: JSONObject, val requestId: String, val typed: Map<String, String> = emptyMap(), val edits: List<JSONObject> = emptyList(),
    val saveQueued: Boolean = false, val session: String = UUID.randomUUID().toString(),
) {
    fun state(): JSONObject = JSONObject().put("view", view).put("requestId", requestId).put("typed", JSONObject(typed as Map<*, *>))
        .put("edits", JSONArray(edits)).put("saveQueued", saveQueued)

    companion object {
        fun restore(json: JSONObject): ComposerDraft {
            val typed = json.getJSONObject("typed")
            val edits = json.getJSONArray("edits")
            return ComposerDraft(json.getJSONObject("view"), json.getString("requestId"),
                typed.keys().asSequence().associateWith { typed.getString(it) }, List(edits.length()) { edits.getJSONObject(it) }, json.optBoolean("saveQueued"))
        }
    }
}


class CalendarModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val main = Handler(Looper.getMainLooper())


    var state by mutableStateOf(saved.get<String>("calendarState")?.let(::JSONObject)); private set

    var query by mutableStateOf(saved.get<String>("calendarQuery").orEmpty()); private set

    var view by mutableStateOf<JSONObject?>(null); private set

    var sheet by mutableStateOf(saved.get<String>("calendarSheet")?.let(::JSONObject)); private set
    var composer by mutableStateOf(saved.get<String>("calendarComposer")?.let { ComposerDraft.restore(JSONObject(it)) }); private set

    var scrollTo by mutableStateOf<Int?>(null); private set

    private fun keepState(value: JSONObject?) { state = value; saved["calendarState"] = value?.toString() }
    private fun keepQuery(value: String) { query = value; saved["calendarQuery"] = value }
    private fun keepSheet(value: JSONObject?) { sheet = value; saved["calendarSheet"] = value?.toString() }
    private fun keepComposer(value: ComposerDraft?) { composer = value; saved["calendarComposer"] = value?.state()?.toString() }


    fun reset() {
        keepState(null); keepQuery(""); keepSheet(null); keepComposer(null)
        view = null
        scrollTo = null
    }

    fun scrolled() { scrollTo = null }


    private fun read(runtime: CoreHost, sent: JSONObject?, sentQuery: String, again: Boolean = true): JSONObject {
        val input = JSONObject().put("scheduleQuery", sentQuery).apply { sent?.let { put("state", it) } }
        val first = runtime.menuRead("calendar", JSONObject(input.toString()).put("offset", 0).put("limit", WINDOW).toString())
        check(first.optInt("version", 1) == 1) { "Unsupported core contract" }
        val items = first.getJSONArray("items")
        try {
            while (items.length() < first.getInt("total")) {
                val next = runtime.menuRead("calendar", JSONObject(input.toString()).put("offset", items.length()).put("limit", WINDOW)
                    .put("revision", first.getString("revision")).toString()).getJSONArray("items")
                if (next.length() == 0) break
                for (index in 0 until next.length()) items.put(next.get(index))
            }
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
            if (again) return read(runtime, sent, sentQuery, again = false)
        }
        return first
    }


    private fun show(sent: JSONObject?, sentQuery: String, next: JSONObject) {
        if (menu.list != "calendar" || sent?.toString() != state?.toString() || sentQuery != query) return
        view = next
        keepState(next.getJSONObject("state"))
    }


    fun reload() = menu.whenIdle {
        val sent = state
        val sentQuery = query
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, sent, sentQuery)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(sent, sentQuery, next) }
        }
    }


    fun refresh() {
        val sent = state
        val sentQuery = query
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, sent, sentQuery) }) { next, mine ->
            if (shell.fresh(mine, Part.Menu)) show(sent, sentQuery, next)
        }
        pumpComposer()
    }


    fun go(next: JSONObject) {
        keepState(next)
        keepSheet(null)
        reload()
    }


    fun select(dayKey: String) = state?.let { go(JSONObject(it.toString()).put("selectedDate", dayKey)) }


    fun mode(option: JSONObject) {
        keepState(option.getJSONObject("state"))
        keepSheet(null)
        act(JSONObject().put("type", "setViewMode").put("viewMode", option.getString("mode")))
    }

    private var typedQuery = 0


    fun typeQuery(text: String) {
        keepQuery(text)
        val mine = ++typedQuery
        main.postDelayed({ if (mine == typedQuery) menu.whenIdle { refresh() } }, 200)
    }


    private fun act(action: JSONObject) = menu.command("calendarAction", JSONObject().put("action", action).apply { state?.let { put("state", it) } })

    fun showCompleted(on: Boolean) = act(JSONObject().put("type", "setShowCompleted").put("on", on))
    fun density(days: Int) = act(JSONObject().put("type", "setWeekVisibleDays").put("days", days))

    fun complete(taskId: String, taskRevision: String) = act(JSONObject().put("type", "completeTask").put("taskId", taskId).put("taskRevision", taskRevision))


    fun move(item: JSONObject, dayKey: String, startMinutes: Int) {
        val timed = item.getJSONObject("timed")
        if (startMinutes == timed.getInt("startMinutes")) return
        act(JSONObject().put("type", "moveTask").put("taskId", item.getString("taskId")).put("day", dayKey)
            .put("startMinutes", startMinutes).put("durationMinutes", timed.getInt("durationMinutes")).put("taskRevision", item.rowRevision()))
    }


    fun openItem(item: JSONObject) {
        item.menuText("eventId")?.takeIf { item.menuText("taskId") == null }?.let { eventId ->
            shell.perform { runtime ->
                val reply = runtime.menuRead("calendarEvent", JSONObject().put("eventId", eventId).toString())
                shell.ui { keepSheet(reply) }
            }
            return
        }
        val taskId = item.menuText("taskId") ?: return
        val sent = state
        shell.perform { runtime ->
            val reply = runtime.menuRead("calendarSheet", JSONObject().put("taskId", taskId).apply { sent?.let { put("state", it) } }.toString())
            shell.ui { keepSheet(reply) }
        }
    }

    fun closeSheet() = keepSheet(null)


    fun press(id: String) {
        val taskId = sheet?.menuText("taskId")
        val revision = sheet?.optString("taskRevision").orEmpty()
        val event = sheet?.takeIf { it.optString("kind") == "event" }?.optJSONObject("event")
        keepSheet(null)
        if (event != null) {
            when (id) {
                "createTask" -> menu.create(FailedAction("calendarCreate", UUID.randomUUID().toString(), JSONObject()
                    .put("action", JSONObject().put("type", "createTaskFromEvent").put("event", event)).apply { state?.let { put("state", it) } }.toString()))
                "openInCalendar" -> if (!HostCalendars.openEvent(shell.getApplication(), event.getString("nativeEventId"))) {
                    view?.getJSONObject("text")?.getJSONObject("toasts")?.optJSONObject("openEventFailed")?.let(::toast)
                }
            }
            return
        }
        if (taskId == null) return
        when (id) {
            "edit" -> shell.openEditor(taskId)
            "unschedule" -> act(JSONObject().put("type", "unscheduleTask").put("taskId", taskId).put("taskRevision", revision))
            "done" -> complete(taskId, revision)
            "delete" -> act(JSONObject().put("type", "deleteTask").put("taskId", taskId).put("taskRevision", revision))
        }
    }


    private fun openComposer(input: JSONObject, start: String? = null) {
        shell.perform { runtime ->
            val reply = runtime.menuRead("calendarComposer", input.toString())
            shell.ui {
                reply.optJSONObject("toast")?.let(::toast)
                reply.optJSONObject("composer")?.let { opened ->
                    keepComposer(ComposerDraft(opened, UUID.randomUUID().toString()))
                    start?.let { typeTime("start", it) }
                }
            }
        }
    }


    fun addTask(dayKey: String) = openComposer(JSONObject().put("day", dayKey))


    fun schedule(taskId: String) = state?.menuText("selectedDate")?.let { openComposer(JSONObject().put("scheduleTaskId", taskId).put("day", it)) }


    fun addAt(dayKey: String, minutes: Int) = openComposer(JSONObject().put("day", dayKey), pickedTime(minutes / 60, minutes % 60))

    fun closeComposer() {
        keepComposer(null)
        inFlight = null
    }


    fun typeTitle(text: String) = edit("title", JSONObject().put("type", "title").put("title", text), text)
    fun typeCandidates(text: String) = edit("query", JSONObject().put("type", "query").put("query", text), text)


    fun typeTime(field: String, text: String) = edit(field, JSONObject().put("type", if (field == "start") "startTime" else "endTime").put("value", text), text)


    fun choose(edit: JSONObject) = edit(null, edit, null)


    private fun edit(field: String?, edit: JSONObject, text: String?) {
        val draft = composer ?: return
        val kept = ArrayList<JSONObject>()
        for (queued in draft.edits) if (queued === inFlight || queued.optString("type") != edit.optString("type")) kept.add(queued)

        val typed = if (field != null && text != null) draft.typed + (field to text) else if (edit.optString("type") == "selectTask") draft.typed - "query" else draft.typed
        keepComposer(draft.copy(typed = typed, edits = kept + edit))
        pumpComposer()
    }


    private var inFlight: JSONObject? = null


    fun pumpComposer() {
        val draft = composer ?: return
        if (inFlight != null || shell.busy || shell.failedAction != null) return
        val next = draft.edits.firstOrNull() ?: run { if (draft.saveQueued) save(); return }
        inFlight = next
        val request = JSONObject().put("composer", draft.view.getJSONObject("composer")).put("edit", next)
        shell.background(emptyList(), { runtime -> runCatching { runtime.menuRead("calendarEdit", request.toString()) } }) { reply, _ ->
            if (inFlight === next) inFlight = null

            val now = composer?.takeIf { it.session == draft.session && it.edits.firstOrNull() === next } ?: return@background pumpComposer()
            reply.onSuccess { answered -> keepComposer(now.copy(view = answered, edits = now.edits.drop(1))) }
                .onFailure { failure ->

                    shell.showToast(null, (failure.message ?: failure.javaClass.simpleName).substringAfter(": "), "warning")
                    keepComposer(now.copy(edits = emptyList(), saveQueued = false))
                }
            pumpComposer()
        }
    }


    private fun saveAction(draft: ComposerDraft) = FailedAction("calendarCreate", draft.requestId, JSONObject()
        .put("action", JSONObject().put("type", "saveComposer").put("composer", draft.view.getJSONObject("composer")))
        .apply { state?.let { put("state", it) } }.toString())


    fun owed(draft: ComposerDraft): FailedAction? = shell.failedAction?.takeIf { it.kind == "calendarCreate" && it.id == draft.requestId }


    fun save() {
        val draft = composer ?: return
        owed(draft)?.let { return menu.create(it) }
        if (draft.edits.isNotEmpty() || inFlight != null) return keepComposer(draft.copy(saveQueued = true))
        keepComposer(draft.copy(saveQueued = false))
        menu.create(saveAction(draft))
    }


    fun refused(action: FailedAction) {
        composer?.takeIf { it.requestId == action.id }?.let { keepComposer(it.copy(requestId = UUID.randomUUID().toString())) }
    }

    private fun toast(toast: JSONObject) = shell.showToast(toast)


    fun done(action: FailedAction, reply: JSONObject) {
        reply.optJSONObject("toast")?.let(::toast)
        if (action.kind != "calendarCreate") return
        val draft = composer?.takeIf { it.requestId == action.id }
        reply.optJSONObject("composer")?.let { refused -> draft?.let { keepComposer(it.copy(view = refused)) }; return }
        if (draft != null) closeComposer()
        if (menu.list != "calendar") return
        keepQuery("")
        reply.optJSONObject("next")?.let { keepState(it); keepSheet(null) }
        scrollTo = if (reply.isNull("scrollToMinutes")) null else reply.getInt("scrollToMinutes")
    }
}


internal fun JSONObject.rowRevision(): String = optJSONObject("row")?.optString("taskRevision").orEmpty()
