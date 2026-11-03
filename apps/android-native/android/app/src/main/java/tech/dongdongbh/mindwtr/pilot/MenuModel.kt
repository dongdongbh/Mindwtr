package tech.dongdongbh.mindwtr.pilot

import android.util.Log
import android.content.SharedPreferences
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
import java.io.File
import java.io.FileOutputStream
import java.util.UUID


private const val PAGE = 50

private const val WINDOW = 100


val MENU_KINDS = setOf("activateProject", "somedayMove", "somedayProjectMove", "taskDestinationMove", "taskDatesSave", "taskSwipeFocus", "somedayUndo", "somedayTask", "somedaySection", "taskListSort", "archiveAction",
    "contextsAction", "trashAction", "reviewAction", "reviewTask", "calendarAction", "calendarCreate", "boardAction", "boardCreate",
    "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder", "bulkCreate", "mindSweepAdd", "taskCompletedAt", "areaOrder", "areaColor", "projectNextAction", "savedSearchDelete", "savedSearchSort") + SETTINGS_KINDS


internal fun staleMoveLine(kind: String, message: String?): String? =
    message?.takeIf { kind in setOf("taskDestinationMove", "somedayProjectMove", "taskDatesSave", "taskSwipeFocus") && it.startsWith("STALE_REVISION") }
        ?.substringAfter(": ", "")?.ifEmpty { null }


private val CREATES = setOf("somedayTask", "somedaySection", "reviewTask", "calendarCreate", "boardCreate", "focusSave", "manageEditor", "bulkCreate", "mindSweepAdd")


private val LANDLESS = setOf("mindSweepAdd", "bulkCreate", "calendarSetting")


val BULK_LISTS = setOf("inbox", "waiting", "someday", "reference", "done")


enum class MenuScreen(val title: String) {
    Waiting("waiting.title"), Someday("someday.title"), Reference("nav.reference"), History("nav.history"),
    Contexts("contexts.title"), Trash("trash.title"), Review("nav.review"), Projects("projects.title"), Weekly("nav.review"), Daily("nav.review"),
    Calendar("nav.calendar"), Board("nav.board"), Settings("settings.title"),

    MindSweep("mindSweep.title"), SavedSearch("search.title"), WidgetList("search.noResults"),
}


private val AREA_FILTERED = setOf(MenuScreen.Waiting, MenuScreen.Someday, MenuScreen.Reference, MenuScreen.History, MenuScreen.Contexts,
    MenuScreen.Trash, MenuScreen.Review, MenuScreen.Projects, MenuScreen.Calendar, MenuScreen.Board, MenuScreen.SavedSearch)
fun showsAreaFilter(screen: MenuScreen) = screen in AREA_FILTERED


private val BULK = setOf("moveTasks", "editTaskTokens", "trashTasks", "restoreItems", "purgeItems", "emptyTrash", "addTag", "removeTags", "markReviewedTasks",
    "organizeTasks", "markTaskReviewed")


private val ROW_KINDS = mapOf("contexts" to "contextsAction", "review" to "reviewAction", "weekly" to "reviewAction", "daily" to "reviewAction")


private val ROUTES = mapOf("/waiting" to (MenuScreen.Waiting to null), "/someday" to (MenuScreen.Someday to null),
    "/reference" to (MenuScreen.Reference to null), "/done" to (MenuScreen.History to "done"), "/archived" to (MenuScreen.History to "archived"))
fun isMenuRoute(route: String?) = route in ROUTES


class MenuItem(val json: JSONObject, val row: TaskRow?) {

    val type: String get() = json.optString("type", "task")

    val key: String get() = if (row != null) "task:${json.optString("groupId")}:${row.id}" else "$type:${json.optString("id").ifEmpty { json.optString("context") }}"
}

private fun JSONObject.list(name: String): List<JSONObject> = optJSONArray(name)?.let { items -> List(items.length()) { items.getJSONObject(it) } }.orEmpty()

private fun JSONObject.menuItems(): List<MenuItem> {
    optJSONArray("rows")?.let { rows -> return List(rows.length()) { index -> rows.getJSONObject(index).let { MenuItem(it, it.taskRow()) } } }

    return list("items").map { item -> MenuItem(item, if (item.optString("type", "task") == "task") item.getJSONObject("row").taskRow() else null) }
}


private fun window(view: JSONObject, name: String): JSONObject? = when (name) {
    "people" -> view.optJSONObject("people")
    "deferredProjects" -> view.optJSONObject("deferred")?.optJSONObject("rows")
    "tokens" -> view.optJSONObject("filters")?.optJSONObject("tokens")
    "projects" -> view.optJSONObject("filters")?.optJSONObject("projects")
    "sections" -> view.optJSONObject("sections")
    "savedSearches" -> view.optJSONObject("savedSearches")

    "staleProjects" -> view.optJSONObject("content")?.optJSONObject("projects")
    else -> null
}


class MenuPage(val list: String, val view: JSONObject, val params: JSONObject, val items: List<MenuItem>, private val paged: Map<String, List<JSONObject>>,
               val bulk: JSONObject? = null) {
    val revision: String get() = view.getString("revision")
    val total: Int get() = view.optInt("total")

    fun collection(name: String): List<JSONObject> = paged[name] ?: source(name)?.list("items").orEmpty()
    fun collectionTotal(name: String): Int = source(name)?.optInt("total") ?: 0

    private fun source(name: String): JSONObject? = window(view, name)
        ?: items.firstNotNullOfOrNull { item -> item.json.optJSONObject("tasks")?.takeIf { name == "contextTasks:${item.json.optString("context")}" } }

    val deep: Map<String, Int> get() = paged.mapValues { it.value.size }
    fun appended(more: List<MenuItem>) = MenuPage(list, view, params, items + more, paged, bulk)
    fun withCollection(name: String, items: List<JSONObject>) = MenuPage(list, view, params, this.items, paged + (name to items), bulk)
    fun withBulk(bulk: JSONObject?) = MenuPage(list, view, params, items, paged, bulk)
}


private class MenuStore(private val dir: File) {
    private val file = File(dir, "pending")
    fun read(): FailedAction? = runCatching {
        val saved = JSONObject(file.readText())
        val patch = saved.getJSONObject("patch")
        FailedAction(saved.getString("kind"), saved.getString("id"), saved.getString("title"),
            patch = patch.keys().asSequence().associateWith<String, String?> { if (patch.isNull(it)) null else patch.getString(it) })
    }.getOrNull()
    fun write(action: FailedAction) {
        dir.mkdirs()
        val state = JSONObject().put("kind", action.kind).put("id", action.id).put("title", action.title).put("patch", JSONObject(json(action.patch)))
        val partial = File(dir, "pending-partial")
        FileOutputStream(partial).use { out -> out.write(state.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(file)) { "Cannot save the Someday request" }
    }
    fun delete() { file.delete() }
}

private fun JSONArray.strings(): List<String> = List(length()) { getString(it) }


private val OWN_READS = setOf("calendar", "board", "settings", "mindSweep")


class MenuModel(internal val shell: InboxViewModel, private val saved: SavedStateHandle, internal val prefs: SharedPreferences, dir: File) : FilterSheetHost {
    private val store = MenuStore(dir)
    private val main = Handler(Looper.getMainLooper())


    var sheet by mutableStateOf(saved.get<Boolean>("menuSheet") == true); private set

    var more by mutableStateOf<MenuPage?>(null); private set

    var quickAccess by mutableStateOf(saved.get<String>("quickAccess")); private set

    val quickView: String get() = quickAccess?.takeIf { it == "review" || it == "contexts" || it == "calendar" } ?: "projects"

    val quickLabel: String get() = when (quickView) { "review" -> "tab.review"; "contexts" -> "nav.contexts"; "calendar" -> "nav.calendar"; else -> "nav.projects" }
    var screen by mutableStateOf(MenuScreen.entries.firstOrNull { it.name == saved.get<String>("menuScreen") }); private set

    var historyTab by mutableStateOf(saved.get<String>("historyTab") ?: "done"); private set

    var history by mutableStateOf<JSONObject?>(null); private set

    private var loaded by mutableStateOf<MenuPage?>(null)

    val page: MenuPage? get() = loaded?.takeIf { it.list == list }


    var session by mutableStateOf(runCatching { JSONObject(saved.get<String>("menuState") ?: "{}") }.getOrDefault(JSONObject())); private set

    var dialog by mutableStateOf(saved.get<String>("menuDialog")?.let { runCatching { JSONObject(it) }.getOrNull() }); private set

    var moveChoices by mutableStateOf<JSONObject?>(null); private set

    val calendar = CalendarModel(this, saved)
    val board = BoardModel(this, saved)

    val focusControls = FocusModel(this, saved)

    var bulkBusy by mutableStateOf<String?>(null); private set

    override var pickerFound by mutableStateOf<JSONObject?>(null); private set

    val settings = SettingsModel(this, saved)

    val sweep = MindSweepModel(this, File(dir, "mind-sweep"))


    val list: String? get() = when (screen) {
        MenuScreen.Waiting -> "waiting"
        MenuScreen.Someday -> "someday"
        MenuScreen.Reference -> "reference"
        MenuScreen.History -> if (historyTab == "archived") "archive" else "done"
        MenuScreen.Contexts -> "contexts"
        MenuScreen.Trash -> "trash"
        MenuScreen.Review -> "review"
        MenuScreen.Weekly -> "weekly"
        MenuScreen.Daily -> "daily"
        MenuScreen.Calendar -> "calendar"
        MenuScreen.Board -> "board"
        MenuScreen.Settings -> "settings"
        MenuScreen.MindSweep -> "mindSweep"
        MenuScreen.SavedSearch -> "savedSearch"
        MenuScreen.WidgetList -> "widgetList"
        MenuScreen.Projects -> null
        null -> when {
            shell.screen == Screen.Projects && quickView != "projects" -> quickView

            shell.screen == Screen.Inbox -> "inbox"
            else -> null
        }
    }


    val firstPagePending get() = list.let { it != null && it !in OWN_READS } && page == null


    override val idle get() = shell.writable && !shell.busy && shell.failedAction == null
    override val filterRevision: String? get() = page?.revision
    override fun collection(name: String): List<JSONObject> = page?.collection(name).orEmpty()
    override fun collectionTotal(name: String): Int = page?.collectionTotal(name) ?: 0
    override fun closeFilters() = keepDialog(null)

    fun own(list: String): JSONObject = session.optJSONObject(list) ?: JSONObject()

    private fun keepOwn(list: String, value: JSONObject) {
        session = JSONObject(session.toString()).put(list, value)
        saved["menuState"] = session.toString()
    }

    internal fun editOwn(list: String, edit: JSONObject.() -> Unit) = keepOwn(list, JSONObject(own(list).toString()).apply(edit))

    fun keepDialog(value: JSONObject?) {
        dialog = value
        saved["menuDialog"] = value?.toString()
    }


    internal fun closeDialog(kind: String) { if (dialog?.optString("kind") == kind) keepDialog(null) }


    fun toggleSheet() = if (sheet) closeSheet() else openSheet()

    private fun openSheet() {
        sheet = true
        saved["menuSheet"] = true
        readMore()
    }

    fun closeSheet() {
        sheet = false
        saved["menuSheet"] = false
    }


    fun openTile(id: String) {
        when (id) {
            "waiting" -> open(MenuScreen.Waiting)
            "someday" -> open(MenuScreen.Someday)
            "reference" -> open(MenuScreen.Reference)
            "history" -> open(MenuScreen.History, "done")
            "review" -> open(MenuScreen.Review)
            "contexts" -> open(MenuScreen.Contexts)
            "trash" -> open(MenuScreen.Trash)
            "calendar" -> open(MenuScreen.Calendar)
            "board" -> open(MenuScreen.Board)
            "settings" -> open(MenuScreen.Settings)
            "projects" -> openProjects(null)
            else -> if (isSavedSearch(id)) openSavedSearch(id)
        }
    }

    fun opens(id: String) = id in setOf("waiting", "someday", "reference", "history", "projects", "review", "contexts", "trash", "calendar", "board", "settings") || isSavedSearch(id)


    private fun isSavedSearch(id: String) = more?.collection("savedSearches")?.any { it.getString("id") == id && it.getString("route").startsWith("/saved-search/") } == true


    fun openSyncSettings() {
        open(MenuScreen.Settings)
        settings.push("sync")
    }


    fun openSettingsScreen(screen: String, onboardingHandoff: Boolean = false) {
        open(MenuScreen.Settings)
        settings.push(screen)
        if (onboardingHandoff) settings.editLocal { put("onboardingHandoff", true) }
    }


    fun openAISettings() {
        open(MenuScreen.Settings)
        settings.push("ai")
    }


    fun openSavedSearch(id: String) {
        editOwn("savedSearch") { put("id", id) }
        open(MenuScreen.SavedSearch)
    }


    fun openWidgetList(id: String) {
        editOwn("widgetList") { put("id", id) }
        open(MenuScreen.WidgetList)
    }


    fun openMindSweep() {
        saved["screenFrom"] = screen?.name
        sweep.reset()
        open(MenuScreen.MindSweep)
    }


    fun openProjects(projectId: String?) {
        if (quickView == "projects") { closeSheet(); leave(null); shell.show(Screen.Projects) } else open(MenuScreen.Projects)
        projectId?.let(shell::openProject)
    }


    fun openContexts(token: String) {
        editOwn("contexts") { put("tokens", JSONArray(listOf(token))) }
        if (quickView == "contexts") { closeSheet(); leave(null); shell.show(Screen.Projects); reload() } else open(MenuScreen.Contexts)
    }


    fun openReview(id: String) {
        saved["reviewFrom"] = screen?.name
        keepOwn(id, JSONObject())
        open(if (id == "daily") MenuScreen.Daily else MenuScreen.Weekly)
    }


    fun openRoute(route: String): Boolean {
        val (target, tab) = ROUTES[route] ?: return false
        open(target, tab)
        return true
    }

    private fun open(target: MenuScreen, tab: String? = null) {
        closeSheet()

        if (target == MenuScreen.Review) editOwn("review") { remove("expandedAreaIds"); remove("expandedProjectIds"); remove("selected") }

        if (target == MenuScreen.Calendar) calendar.reset()
        if (target == MenuScreen.Board) board.reset()

        if (target == MenuScreen.Settings) settings.reset()

        if (target == MenuScreen.Weekly || screen == MenuScreen.Weekly) shell.ai.leaveReview()
        screen = target
        saved["menuScreen"] = target.name
        tab?.let(::keepTab)
        loaded = null
        keepDialog(null)
        if (target == MenuScreen.History) readHistory()
        reload()

        when (target) {
            MenuScreen.Calendar -> calendarFeed("calendar")
            MenuScreen.Weekly -> calendarFeed("weeklyReview")
            MenuScreen.Daily -> calendarFeed("dailyReview")
            else -> {}
        }
    }


    internal fun calendarFeed(slot: String) {
        val runtime = shell.coreHost() ?: return
        Thread({
            runCatching { runtime.calendarRequest("refreshCalendarFeed", JSONObject().put("slot", slot).toString()) }
                .onFailure { Log.w(CoreHost.TAG, "Calendar reload failed slot=$slot ${failureForLog(it)}") }
        }, "mindwtr-calendar-feed").start()
    }


    fun closeScreen() {

        if (screen == MenuScreen.Settings && settings.back()) return
        val flow = screen == MenuScreen.Weekly || screen == MenuScreen.Daily

        val over = screen == MenuScreen.MindSweep
        if (screen == MenuScreen.MindSweep) sweep.forget()
        leave(if (flow || over) MenuScreen.entries.firstOrNull { it.name == saved.get<String>(if (over) "screenFrom" else "reviewFrom") } else null)
        if (list != null) refresh()

        if (list == "calendar") calendarFeed("calendar")
    }


    fun toTabs() {
        closeSheet()
        if (screen != null) leave(null)
    }

    private fun leave(back: MenuScreen?) {
        if (screen == MenuScreen.Projects) shell.closeProject()

        if (screen == MenuScreen.Weekly) shell.ai.leaveReview()
        screen = back
        saved["menuScreen"] = back?.name
        loaded = null
        keepDialog(null)
    }

    private fun keepTab(tab: String) {
        historyTab = tab
        saved["historyTab"] = tab
    }


    fun showTab(tab: String) {
        if (tab == historyTab) return
        keepTab(tab)
        loaded = null
        keepDialog(null)
        readHistory()
        reload()
    }


    private fun params(list: String): JSONObject {
        val own = own(list)
        val kept = { names: List<String> -> JSONObject().apply { for (name in names) if (own.has(name)) put(name, own.get(name)) } }
        return when (list) {
            "waiting" -> JSONObject().put("person", own.optString("person"))

            "someday" -> kept(listOf("sortBy", "groupBy", "showDetails", "filters")).put("projectsInSections", true)
            "reference" -> kept(listOf("includeArchivedProjects", "filters")).apply {
                referenceGroupBy(own.optString("groupBy").ifEmpty { null }, prefs.getString(REFERENCE_GROUP_BY_KEY, null))?.let { put("groupBy", it) }
            }.put("collapsedGroupIds", GroupCollapse.all(prefs, "reference", 200))
            "done" -> ListViewState.read(prefs, DONE_VIEW_KEY).into(kept(listOf("filters"))).put("collapsedGroupIds", GroupCollapse.all(prefs, "done", 200))

            "inbox" -> kept(listOf("groupBy", "filters")).put("collapsedGroupIds", GroupCollapse.axis(prefs, "inbox", own.optString("groupBy", "none"), 200))


            "archive" -> ListViewState.read(prefs, ARCHIVED_VIEW_KEY).into(kept(listOf("segment", "filters")))
                .put("collapsedGroupIds", GroupCollapse.all(prefs, "archived", 1000)).apply {
                    if (dialog?.optString("kind") == "filters") put("filterSheetOpen", true)
                    own.optJSONArray("except")?.let { put("selectAll", JSONObject().put("except", it)) } ?: put("selectedIds", own.optJSONArray("selected") ?: JSONArray())
                }
            "contexts" -> kept(listOf("tokens", "matchMode", "searchQuery", "filters", "preservedCriteria", "savedFilterId"))
                .put("selectedIds", own.optJSONArray("selected") ?: JSONArray()).also {
                    if (dialog?.optString("kind") == "filters") it.put("filterSheetOpen", true)
                    dialogInputs(list, it)
                }
            "trash" -> JSONObject().put("selected", JSONObject().put("taskIds", own.optJSONArray("selectedTasks") ?: JSONArray())
                .put("projectIds", own.optJSONArray("selectedProjects") ?: JSONArray()))

            "review" -> kept(listOf("expandedAreaIds", "expandedProjectIds", "expandedLaterProjectIds")).put("scope", own.optString("scope", "due"))
                .put("selectedIds", own.optJSONArray("selected") ?: JSONArray()).also { dialogInputs(list, it) }

            "weekly" -> JSONObject().put("checkpoint", prefs.getString(WEEKLY_REVIEW_KEY, null) ?: JSONObject.NULL)
                .put("expandedProjectId", own.opt("expandedProjectId") ?: JSONObject.NULL)
                .put("expandedLaterProjectIds", own.optJSONArray("expandedLaterProjectIds") ?: JSONArray())
            "daily" -> JSONObject().put("checkpoint", prefs.getString(DAILY_REVIEW_KEY, null) ?: JSONObject.NULL)
            "savedSearch" -> JSONObject().put("id", own.optString("id"))
            "widgetList" -> JSONObject().put("id", own.optString("id"))
            else -> JSONObject()
        }
    }


    private fun accepted(list: String, params: JSONObject, view: JSONObject): JSONObject = JSONObject(params.toString()).apply {
        remove("organize"); remove("picker"); remove("filterPicker"); remove("filterEdit")
        view.optJSONObject("filters")?.optJSONObject("state")?.let { put("filters", it) }
        if (list == "contexts") {
            put("savedFilterId", view.opt("savedFilterId") ?: JSONObject.NULL)
            if (view.has("preservedCriteria")) put("preservedCriteria", view.getJSONObject("preservedCriteria")) else remove("preservedCriteria")
        }
        if (list == "waiting") put("person", view.getString("person"))
        if (list == "reference") put("includeArchivedProjects", view.getBoolean("includeArchivedProjects"))
        view.optJSONObject("selection")?.let { put("tokens", it.getJSONArray("tokens")).put("matchMode", it.getString("matchMode")) }
        if (list == "review") put("expandedAreaIds", view.getJSONArray("expandedAreaIds")).put("expandedProjectIds", view.getJSONArray("expandedProjectIds"))
        if (list == "weekly" || list == "daily") put("checkpoint", view.getString("checkpoint"))
    }


    private fun read(runtime: CoreHost, list: String, params: JSONObject, depth: Int, deep: Map<String, Int>, edit: JSONObject? = null, bulk: JSONObject? = null): MenuPage {
        val first = runtime.menuRead(list, JSONObject(params.toString()).put("offset", 0).put("limit", PAGE)
            .apply { edit?.let { put(if (list == "review") "expansionEdit" else "filterEdit", it) } }.toString())
        check(first.optInt("version", 1) == 1) { "Unsupported core contract" }
        val sent = accepted(list, params, first)
        var page = MenuPage(list, first, sent, first.menuItems(), emptyMap(), first.optJSONObject("bulk")?.takeIf { list == "review" })
        try {
            while (page.items.size < minOf(depth, page.total)) {
                val next = runtime.menuRead(list, JSONObject(sent.toString()).put("offset", page.items.size).put("limit", PAGE).put("revision", page.revision).toString()).menuItems()
                if (next.isEmpty()) break
                page = page.appended(next)
            }
            for ((name, want) in deep) page = collectionTo(runtime, list, page, name, want)
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
        bulk?.let { input -> page = page.withBulk(runtime.menuRead("bulk", JSONObject(input.toString()).put("params", sent).toString())) }
        return page
    }


    private fun collectionTo(runtime: CoreHost, list: String, page: MenuPage, name: String, want: Int): MenuPage {
        var loaded = page.collection(name)
        while (loaded.size < minOf(want, page.collectionTotal(name))) {
            val next = collectionWindow(runtime, list, page, name, loaded.size).list("items")
            if (next.isEmpty()) break
            loaded = loaded + next
        }
        return page.withCollection(name, loaded)
    }


    private fun collectionWindow(runtime: CoreHost, list: String, page: MenuPage, name: String, offset: Int, query: String? = null): JSONObject = when (list) {
        "weekly" -> runtime.menuRead("weeklyList", JSONObject(page.params.toString()).put("list", name.substringBefore(':'))
            .apply { if (':' in name) put("key", name.substringAfter(':')) }.put("offset", offset).put("limit", WINDOW).put("revision", page.revision).toString())
        "contexts" -> runtime.menuRead("contexts", JSONObject(page.params.toString()).put("offset", 0).put("limit", 1)
            .put("revision", page.revision).put("filterPicker", JSONObject().put("name", name).put("query", query ?: "")
                .put("offset", offset).put("limit", WINDOW).put("revision", page.revision)).toString()).getJSONObject("filterPicker")
        "inbox", "archive" -> runtime.menuRead(if (list == "inbox") "inboxTokens" else "archiveTokens", JSONObject().put("params", page.params)
            .put("offset", offset).put("limit", WINDOW).put("revision", page.revision).apply { query?.let { put("query", it) } }.toString())
        else -> runtime.menuRead("collection", JSONObject().put("view", list).put("collection", name).put("params", page.params)
            .put("offset", offset).put("limit", WINDOW).put("revision", page.revision).apply { query?.let { put("query", it) } }.toString())
    }


    internal fun restorePage(page: MenuPage) { loaded = page }


    private fun show(list: String, next: MenuPage) {
        if (list != this.list) return
        shell.readSucceeded()

        loaded = if (list in BULK_LISTS && own(list).optJSONObject("bulk") == null) next.withBulk(null) else next
        editOwn(list) {
            when (list) {
                "waiting" -> put("person", next.params.getString("person"))
                "someday", "done", "inbox" -> put("filters", next.params.getJSONObject("filters"))
                "reference" -> put("filters", next.params.getJSONObject("filters")).put("includeArchivedProjects", next.params.getBoolean("includeArchivedProjects"))
                "archive" -> {
                    put("filters", next.params.getJSONObject("filters")).put("selected", next.view.getJSONArray("selectedIds"))
                    next.view.optJSONObject("selectAll")?.let { put("except", it.getJSONArray("except")) }
                }
                "contexts" -> {
                    put("selected", next.view.getJSONArray("selectedIds")).put("filters", next.params.getJSONObject("filters"))
                        .put("savedFilterId", next.params.opt("savedFilterId") ?: JSONObject.NULL)
                    if (next.params.has("preservedCriteria")) put("preservedCriteria", next.params.getJSONObject("preservedCriteria")) else remove("preservedCriteria")
                }
                "trash" -> next.view.getJSONObject("selected").let { put("selectedTasks", it.getJSONArray("taskIds")).put("selectedProjects", it.getJSONArray("projectIds")) }
                "review" -> put("expandedAreaIds", next.params.getJSONArray("expandedAreaIds")).put("expandedProjectIds", next.params.getJSONArray("expandedProjectIds"))
                    .put("selected", next.view.optJSONObject("bulk")?.getJSONArray("selectedIds") ?: JSONArray())
            }
            if (list == "contexts") put("tokens", next.params.getJSONArray("tokens")).put("matchMode", next.params.getString("matchMode"))

            val kept = optJSONObject("bulk")
            next.bulk?.takeIf { kept != null }?.let { bulk ->
                kept!!.put("selected", bulk.getJSONArray("selectedIds")).put("anchorId", bulk.opt("anchorId") ?: JSONObject.NULL)
                bulk.optJSONObject("selectAll")?.let { kept.put("except", it.getJSONArray("except")) }
            }
        }

        next.bulk?.optJSONObject("organize")?.let { organize ->
            dialog?.takeIf { it.optString("kind") == "organize" }?.let { keepDialog(JSONObject(it.toString()).put("draft", organize.getJSONObject("draft"))) }
        }

        if (list == "review" && next.bulk == null) closeSelectionDialogs(list)

        if (list == "weekly" || list == "daily") prefs.edit().putString(next.view.getString("storageKey"), next.view.getString("checkpoint")).apply()
    }


    internal fun reload(edit: JSONObject? = null, fresh: Boolean = false, bulkEdit: JSONObject? = null) = whenIdle {
        val list = list ?: return@whenIdle

        if (list == "calendar") return@whenIdle calendar.reload()
        if (list == "board") return@whenIdle board.reload()
        if (list == "settings") return@whenIdle settings.reload()
        if (list == "mindSweep") return@whenIdle sweep.reload()
        val params = params(list)

        if (list == "review") bulkEdit?.optJSONObject("organizeEdit")?.let { params.optJSONObject("organize")?.put("edit", it) }

        val bulk = bulkInput(list)?.apply {
            bulkEdit?.optJSONObject("selectionEdit")?.let { put("selectionEdit", it) }
            bulkEdit?.optJSONObject("organizeEdit")?.let { optJSONObject("organize")?.put("edit", it) }
        }

        val shown = page.takeUnless { fresh }
        val depth = maxOf(PAGE, shown?.items?.size ?: 0)
        val deep = shown?.deep.orEmpty()
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, list, params, depth, deep, edit, bulk)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(list, next) }
        }
    }


    fun retryRead() = reload()


    fun refresh(done: () -> Unit = {}) {
        if (sheet) readMore()

        val list = list ?: return done()
        if (list == "calendar") return calendar.refresh().also { done() }
        if (list == "board") return board.refresh().also { done() }
        if (list == "settings") return settings.refresh().also { done() }
        if (list == "mindSweep") return sweep.refresh().also { done() }
        val params = params(list)
        val bulk = bulkInput(list)
        val shown = page
        val depth = maxOf(PAGE, shown?.items?.size ?: 0)
        val deep = shown?.deep.orEmpty()
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, list, params, depth, deep, bulk = bulk) }, done) { next, mine ->
            if (shell.fresh(mine, Part.Menu)) show(list, next)
        }
        if (screen == MenuScreen.History && history == null) readHistory()
        if (dialog?.optString("kind") == "move" && moveChoices == null) readMoveChoices()
    }

    internal fun readMore() {
        val deep = more?.deep.orEmpty()
        shell.background(listOf(Part.More), { runtime -> read(runtime, "more", JSONObject(), 0, deep) }) { next, mine ->
            if (shell.fresh(mine, Part.More)) keepMore(next)
        }
    }


    private fun keepMore(next: MenuPage) {
        more = next
        quickAccess = next.view.optString("quickAccessView").ifEmpty { null }
        saved["quickAccess"] = quickAccess
    }


    fun readSheet(runtime: CoreHost): MenuPage = read(runtime, "more", JSONObject(), 0, emptyMap())


    private fun readHistory() {
        val tab = historyTab
        shell.background(emptyList(), { runtime -> runtime.menuRead("history", JSONObject().put("tab", tab).toString()) }) { view, _ ->
            if (tab == historyTab) history = view
        }
    }


    fun loadMore() {
        val shown = page ?: return
        val list = list ?: return
        val params = params(list)
        val bulk = bulkInput(list)
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = try {
                val window = runtime.menuRead(list, JSONObject(shown.params.toString()).put("offset", shown.items.size).put("limit", PAGE)
                    .put("revision", shown.revision).toString())
                shown.appended(window.menuItems())
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                read(runtime, list, params, shown.items.size + PAGE, shown.deep, bulk = bulk)
            }
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(list, next) }
        }
    }


    override fun loadCollection(name: String) {
        val sheetPage = name == "savedSearches"
        val shown = (if (sheetPage) more else page) ?: return
        val list = if (sheetPage) "more" else list ?: return
        val want = shown.collection(name).size + WINDOW
        val params = if (sheetPage) JSONObject() else params(list)
        val bulk = if (sheetPage) null else bulkInput(list)
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = try {
                collectionTo(runtime, list, shown, name, want)
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                read(runtime, list, params, shown.items.size, shown.deep + (name to want), bulk = bulk)
            }
            shell.ui {
                if (sheetPage) { if (shell.fresh(mine, Part.More)) keepMore(next) } else if (shell.fresh(mine, Part.Menu)) show(list, next)
            }
        }
    }


    fun selectContextsSavedFilter(id: String?) {
        editOwn("contexts") {
            put("savedFilterId", id ?: JSONObject.NULL).put("tokens", JSONArray()).put("matchMode", "all")
            put("filters", JSONObject()).remove("preservedCriteria")
        }
        reload()
    }


    fun person(person: String) { editOwn("waiting") { put("person", person) }; reload() }


    override fun filterEdit(edit: JSONObject) {
        val type = edit.optString("type")
        dialog?.takeIf { it.optString("kind") == "filters" }?.let { open ->
            if (type == "clear" || type == "setSearch" || type == "setLocation") {
                keepDialog(JSONObject(open.toString()).apply { remove("typed:setSearch"); remove("typed:setLocation") })
            }
        }

        if (list == "archive" && (type == "clear" || type == "setSearch")) editOwn("archive") { put("search", edit.optString("value")) }
        reload(edit)
    }

    private var filterTyped = 0
    private var searchTyped = 0


    override fun typeFilter(type: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:$type", text)) }
        if (list == "archive" && type == "setSearch") editOwn("archive") { put("search", text) }
        val mine = ++filterTyped
        main.postDelayed({
            if (mine != filterTyped) return@postDelayed
            reload(JSONObject().put("type", type).put("value", text))
        }, 200)
    }


    internal fun whenIdle(read: () -> Unit) { if (shell.busy) main.postDelayed({ whenIdle(read) }, 200) else read() }


    override fun removeChip(action: JSONObject) {
        action.optJSONObject("filterEdit")?.let { filterEdit(it); return }
        archivedProjects(false)
    }


    override fun archivedProjects(on: Boolean) { editOwn("reference") { put("includeArchivedProjects", on) }; reload() }


    fun group(value: String) {
        val list = list ?: return
        when (list) {
            "reference" -> {
                prefs.edit().putString(REFERENCE_GROUP_BY_KEY, value).apply()
                editOwn(list) { put("groupBy", value) }
            }
            "done" -> ListViewState.read(prefs, DONE_VIEW_KEY).copy(groupBy = value).save(prefs, DONE_VIEW_KEY)
            "archive" -> ListViewState.read(prefs, ARCHIVED_VIEW_KEY).copy(groupBy = value).save(prefs, ARCHIVED_VIEW_KEY)
            else -> editOwn(list) { put("groupBy", value) }
        }
        reload()
    }


    fun sort(value: String) {
        when (val list = list ?: return) {
            "reference", "inbox", "contexts" -> send(FailedAction("taskListSort", value))
            "done" -> { ListViewState.read(prefs, DONE_VIEW_KEY).copy(sortBy = value).save(prefs, DONE_VIEW_KEY); reload() }
            "archive" -> { ListViewState.read(prefs, ARCHIVED_VIEW_KEY).copy(sortBy = value).save(prefs, ARCHIVED_VIEW_KEY); reload() }
            else -> { editOwn(list) { put("sortBy", value) }; reload() }
        }
    }


    fun savedSearchSort(edit: JSONObject) =
        act("savedSearchSort", JSONObject().put("id", own("savedSearch").optString("id")).put("sortBy", edit.opt("sortBy") ?: JSONObject.NULL))


    fun details(on: Boolean) { editOwn("someday") { put("showDetails", on) }; reload() }


    fun toggleGroup(id: String) {
        val list = list ?: return
        val axis = page?.view?.optString("groupBy")?.ifEmpty { null } ?: return

        val collapse = page?.items?.firstOrNull { it.type == "section" && it.json.optString("id") == id }?.json?.optJSONObject("collapseEdit")
        if (list == "inbox" && collapse != null) GroupCollapse.keep(prefs, list, axis, collapse.getJSONArray("collapsedGroupIds"))
        else GroupCollapse.toggle(prefs, if (list == "archive") "archived" else list, axis, id)
        reload()
    }


    fun segment(id: String) {
        editOwn("archive") { put("segment", id); put("selecting", false); put("selected", JSONArray()); remove("except") }
        reload()
    }


    fun search(text: String) {
        editOwn("archive") { put("search", text) }
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload(JSONObject().put("type", "setSearch").put("value", text)) }, 200)
    }


    fun typeSearch(list: String, name: String, text: String) {
        editOwn(list) { put(name, text) }
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload() }, 200)
    }

    fun selecting(on: Boolean) {
        editOwn("archive") { put("selecting", on); put("selected", JSONArray()); remove("except") }
        if (!on) reload()
    }


    fun toggleSelected(id: String) {
        val own = own("archive")
        val name = if (own.has("except")) "except" else "selected"
        val ids = own.optJSONArray(name)?.strings().orEmpty()
        editOwn("archive") { put(name, JSONArray(if (id in ids) ids - id else ids + id)) }
        reload()
    }


    fun archiveSelection(type: String): JSONObject {
        val view = page?.view
        return JSONObject().put("type", type).apply {

            view?.optJSONObject("selectAll")?.let { put("selectAll", it) }
                ?: put("taskIds", view?.optJSONArray("selectedIds") ?: JSONArray()).put("taskRevisions", view?.optJSONObject("taskRevisions") ?: JSONObject())
        }
    }


    fun selectAll() {
        val list = list ?: return
        if (list == "archive") {
            editOwn(list) { put("except", JSONArray()); put("selected", JSONArray()) }
            return reload()
        }
        val params = params(list)
        val mine = shell.issue()
        shell.perform { runtime ->
            val all = read(runtime, list, params, Int.MAX_VALUE, emptyMap())
            val ids = LinkedHashSet<String>()
            val projects = LinkedHashSet<String>()
            for (item in all.items) {
                val row = item.row
                if (row != null) ids.add(row.id) else if (item.type == "project") projects.add(item.json.getString("id"))
            }
            shell.ui {
                if (!shell.fresh(mine, Part.Menu)) return@ui
                if (list == "trash") editOwn(list) { put("selectedTasks", JSONArray(ids.toList())).put("selectedProjects", JSONArray(projects.toList())) }
                else editOwn(list) { put("selected", JSONArray(ids.toList())) }
                reload()
            }
        }
    }


    fun openDialog(kind: String) {
        keepDialog(JSONObject().put("kind", kind))

        if (kind == "filters" && list == "archive") reload()
    }


    override fun dialogPage(page: String?) {
        pickerFound = null
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); if (page == null) remove("page") else put("page", page) }) }
    }


    override fun pickerQuery(name: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text)) }
        val mine = ++filterTyped
        main.postDelayed({ if (mine == filterTyped) searchPicker(name, text) }, 200)
    }


    override fun searchPicker(name: String, query: String, depth: Int) {
        val shown = page ?: return
        val list = list ?: return
        if (query.isBlank()) { pickerFound = null; return }
        shell.background(listOf(Part.MenuDialog), { runtime ->
            val items = JSONArray()
            var total: Int
            try {
                do {
                    val window = collectionWindow(runtime, list, shown, name, items.length(), query)
                    total = window.getInt("total")
                    val next = window.getJSONArray("items")
                    for (index in 0 until next.length()) items.put(next.get(index))
                } while (next.length() > 0 && items.length() < minOf(depth, total))
                JSONObject().put("name", name).put("query", query).put("revision", shown.revision).put("total", total).put("items", items)
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                null
            }
        }) { found, mine ->
            if (found != null && shell.fresh(mine, Part.MenuDialog)) pickerFound = found


            else if (found == null) reload()
        }
    }


    override fun toggleDisclosure(id: String) {
        val open = dialog ?: return
        keepDialog(JSONObject(open.toString()).put(id, !open.optBoolean(id)))
    }


    fun backInDialog() {
        val open = dialog ?: return
        when {
            open.has("page") -> dialogPage(null)
            open.has("picker") -> keepDialog(JSONObject(open.toString()).apply { remove("picker"); remove("query") })
            open.optString("kind") == "newSection" && open.has("taskIds") -> openMove(open.getJSONArray("taskIds").strings(), open.optJSONObject("taskRevisions") ?: JSONObject())
            else -> keepDialog(null)
        }
    }


    fun typeDialog(text: String) { dialog?.let { keepDialog(JSONObject(it.toString()).put("text", text).apply { remove("error") }) } }


    fun confirm(confirmation: JSONObject, action: JSONObject, command: String = "archiveAction") =
        keepDialog(JSONObject(confirmation.toString()).put("kind", "confirm").put("action", action).put("command", command))


    fun moveLabel(task: TaskRow): String? {
        if (screen != MenuScreen.Someday) return null
        val shown = page ?: return null
        if (shown.items.none { it.row?.id == task.id }) return null
        return shown.view.getJSONObject("text").getString("moveToSection")
    }


    fun openMove(taskIds: List<String>, taskRevisions: JSONObject) {
        moveChoices = null
        keepDialog(JSONObject().put("kind", "move").put("taskIds", JSONArray(taskIds)).put("taskRevisions", taskRevisions))
        readMoveChoices()
    }


    fun openProjectMove(projectId: String, projectRevision: String) {
        moveChoices = null
        keepDialog(JSONObject().put("kind", "move").put("projectId", projectId).put("projectRevision", projectRevision))
        readMoveChoices()
    }


    private fun readMoveChoices(depth: Int = WINDOW) {
        val open = dialog?.takeIf { it.optString("kind") == "move" } ?: return

        val target = open.optString("projectId").ifEmpty { null }?.let { JSONObject().put("projectId", it) }
            ?: JSONObject().put("taskIds", open.getJSONArray("taskIds"))
        fun query(offset: Int) = JSONObject(target.toString()).put("offset", offset).put("limit", WINDOW)
        shell.background(listOf(Part.MenuDialog), { runtime ->
            val first = runtime.menuRead("moveDialog", query(0).toString())
            val choices = first.getJSONObject("choices")
            val items = choices.getJSONArray("items")
            try {
                while (items.length() < minOf(depth, choices.getInt("total"))) {
                    val next = runtime.menuRead("moveDialog", query(items.length()).put("revision", first.getString("revision")).toString())
                        .getJSONObject("choices").getJSONArray("items")
                    if (next.length() == 0) break
                    for (index in 0 until next.length()) items.put(next.get(index))
                }
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
            }
            first
        }) { reply, mine -> if (shell.fresh(mine, Part.MenuDialog) && dialog?.optString("kind") == "move") moveChoices = reply }
    }


    fun moreMoveChoices() { moveChoices?.getJSONObject("choices")?.getJSONArray("items")?.length()?.let { readMoveChoices(it + WINDOW) } }

    fun moveAction(taskIds: List<String>, sectionId: String?, taskRevisions: JSONObject) = FailedAction("somedayMove", UUID.randomUUID().toString(),
        patch = mapOf("taskIds" to taskIds.joinToString(","), "sectionId" to sectionId, "taskRevisions" to taskRevisions.toString()))


    fun move(taskIds: List<String>, sectionId: String?, taskRevisions: JSONObject) = send(moveAction(taskIds, sectionId, taskRevisions))


    fun moveProject(projectId: String, sectionId: String?, projectRevision: String) = send(FailedAction("somedayProjectMove", UUID.randomUUID().toString(),
        projectId, patch = mapOf("sectionId" to sectionId, "projectRevision" to projectRevision)))


    private fun undo(moveRequestId: String) {
        Log.i(CoreHost.TAG, "Someday Undo requested busy=${shell.busy}")
        whenIdle { send(FailedAction("somedayUndo", UUID.randomUUID().toString(), moveRequestId)) }
    }


    fun openNewSection(taskIds: List<String>? = null, taskRevisions: JSONObject? = null, project: Pair<String, String>? = null) = keepDialog(JSONObject()
        .put("kind", "newSection").put("text", "").put("requestId", UUID.randomUUID().toString()).apply {
            taskIds?.let { put("taskIds", JSONArray(it)).put("taskRevisions", taskRevisions ?: JSONObject()) }
            project?.let { (id, revision) -> put("projectId", id).put("projectRevision", revision) }
        })


    fun openAddTask(heading: JSONObject) {
        val addTask = heading.getJSONObject("addTask")
        keepDialog(JSONObject().put("kind", "addTask").put("text", "").put("title", addTask.getString("accessibilityLabel"))
            .put("sectionId", addTask.opt("sectionId") ?: JSONObject.NULL).put("captureId", UUID.randomUUID().toString()))
    }


    fun openContextsSave() {
        val view = page?.takeIf { it.list == "contexts" }?.view ?: return
        val controls = view.optJSONObject("saveControls") ?: return
        if (!idle || !view.optBoolean("canSave")) return
        keepDialog(JSONObject().put("kind", "contextsSave").put("text", "")
            .put("requestId", UUID.randomUUID().toString()).put("controls", controls))
    }

    fun createAction(): FailedAction? {
        val open = dialog ?: return null
        val text = open.optString("text").trim()
        if (text.isEmpty()) return null
        return when (open.optString("kind")) {
            "contextsSave" -> FailedAction("focusSave", open.getString("requestId"),
                JSONObject().put("controls", open.getJSONObject("controls")).put("name", text).put("view", "contexts").toString())
            "newSection" -> FailedAction("somedaySection", open.getString("requestId"), text)
            "addTask" -> FailedAction("somedayTask", open.getString("captureId"), text,
                patch = mapOf("sectionId" to if (open.isNull("sectionId")) null else open.getString("sectionId")))
            "projectTask" -> FailedAction("reviewTask", open.getString("requestId"), addProjectTask(open.getString("projectId"), open.optString("text")).toString())
            else -> null
        }
    }


    fun saveCreate() {
        val action = createAction() ?: return
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        store.write(action)
        send(action)
    }


    internal fun create(action: FailedAction) {
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        store.write(action)
        send(action)
    }


    internal fun command(kind: String, input: JSONObject) = send(FailedAction(kind, UUID.randomUUID().toString(), input.toString()))


    fun activate(projectId: String, projectRevision: String) = send(FailedAction("activateProject", projectId, patch = mapOf("projectRevision" to projectRevision)))


    fun archive(action: JSONObject) = act("archiveAction", action)


    internal fun act(kind: String, action: JSONObject) = send(FailedAction(kind, UUID.randomUUID().toString(), action.toString()))


    fun rowStatus(task: TaskRow, status: String): Boolean {
        val kind = ROW_KINDS[list ?: return false] ?: return false
        if (page?.items?.none { it.row?.id == task.id } != false) return false
        shell.showStatusMenu(null)
        if (status != task.status) act(kind, setTaskStatus(task.id, status, task.taskRevision))
        return true
    }


    fun openCompletedAt(row: TaskRow, start: JSONObject) = keepDialog(JSONObject().put("kind", "completedAt").put("taskId", row.id)
        .put("taskRevision", row.taskRevision).put("day", start.getString("day")).put("time", start.getString("time")))


    fun pickCompletedDay(day: String) { dialog?.takeIf { it.optString("kind") == "completedAt" }?.let { keepDialog(JSONObject(it.toString()).put("day", day).put("step", "time")) } }


    fun pickCompletedTime(time: String) {
        val open = dialog?.takeIf { it.optString("kind") == "completedAt" } ?: return
        keepDialog(null)
        archive(JSONObject().put("type", "setCompletedAt").put("taskId", open.getString("taskId")).put("day", open.getString("day")).put("time", time)
            .put("taskRevision", open.optString("taskRevision")))
    }


    private fun bulkInput(list: String): JSONObject? {
        val bulk = own(list).optJSONObject("bulk")?.takeIf { list in BULK_LISTS } ?: return null
        val open = dialog
        return JSONObject().put("list", list).put("anchorId", bulk.opt("anchorId") ?: JSONObject.NULL).put("rangeSelectMode", bulk.optBoolean("range")).apply {
            bulk.optJSONArray("except")?.let { put("selectAll", JSONObject().put("except", it)) } ?: put("taskIds", bulk.optJSONArray("selected") ?: JSONArray())
            if (open?.optString("kind") == "organize") {
                put("organize", JSONObject().put("draft", open.optJSONObject("draft") ?: JSONObject()))
                open.menuText("picker")?.let { kind -> put("picker", JSONObject().put("kind", kind).apply { open.menuText("query")?.let { put("query", it) } }) }
            }
            if (open?.optString("kind") == "tokens" && open.optString("list") == "bulk") put("picker", JSONObject().put("kind", "removeTag").apply { tokenQuery(open)?.let { put("query", it) } })
        }
    }


    fun bulkRow(row: TaskRow, readOnly: Boolean = false): RowActions? {
        if (list !in BULK_LISTS || readOnly) return null
        val bulk = page?.bulk
        val all = bulk?.optJSONObject("selectAll")
        val picked = when {
            bulk == null -> false
            all != null -> row.id !in all.getJSONArray("except").ids()
            else -> row.id in bulk.getJSONArray("selectedIds").ids()
        }
        return RowActions(selecting = bulk != null, selected = picked, select = { bulkTap(row.id) })
    }


    fun bulkTap(taskId: String) {
        val list = list?.takeIf { it in BULK_LISTS } ?: return
        val bulk = own(list).optJSONObject("bulk") ?: JSONObject().put("selected", JSONArray())
        val except = bulk.optJSONArray("except")?.ids()
        if (except != null) {
            editOwn(list) { put("bulk", JSONObject(bulk.toString()).put("except", JSONArray(if (taskId in except) except - taskId else except + taskId))) }
            return reload()
        }
        val range = bulk.optBoolean("range")
        editOwn(list) { put("bulk", JSONObject(bulk.toString()).put("range", false)) }
        reload(bulkEdit = JSONObject().put("selectionEdit", JSONObject().put("taskId", taskId).put("range", range)))
    }


    fun bulkRange() {
        val list = list?.takeIf { it in BULK_LISTS } ?: return
        editOwn(list) { optJSONObject("bulk")?.let { it.put("range", !it.optBoolean("range")) } }
        reload()
    }


    fun bulkSelectAll() {
        val list = list?.takeIf { it in BULK_LISTS } ?: return
        editOwn(list) { put("bulk", JSONObject().put("except", JSONArray()).put("selected", JSONArray())) }
        reload()
    }


    fun endBulk(list: String) {
        editOwn(list) { remove("bulk") }
        loaded?.takeIf { it.list == list }?.let { loaded = it.withBulk(null) }
    }


    fun bulkAction(action: JSONObject, busy: String) {
        bulkBusy = busy
        act("bulkAction", bulkPayload(action) ?: return)
    }


    fun bulkDelete() {
        val bulk = page?.bulk ?: return
        bulkBusy = "delete"
        confirm(bulk.getJSONObject("deleteConfirmation"), bulkPayload(JSONObject().put("type", "trashTasks")) ?: return, "bulkAction")
    }


    private fun bulkPayload(action: JSONObject): JSONObject? {
        val list = list ?: return null
        val bulk = page?.bulk ?: return null
        val target = JSONObject(action.toString()).apply {

            bulk.optJSONObject("selectAll")?.let { put("selectAll", it) }
                ?: put("taskIds", bulk.getJSONArray("selectedIds")).put("taskRevisions", bulk.getJSONObject("taskRevisions"))
        }
        return JSONObject().put("list", list).put("action", target)
    }


    fun openRemoveTag() {
        keepDialog(JSONObject().put("kind", "tokens").put("list", "bulk").put("text", "").put("picked", JSONArray()))
        reload()
    }


    fun openOrganize() {
        keepDialog(JSONObject().put("kind", "organize").put("draft", JSONObject()))
        reload()
    }


    fun organizeEdit(edit: JSONObject) {

        if (edit.optString("type") == "setStatus" || edit.optString("field") == "delegateWho") dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("validation") }) }
        reload(bulkEdit = JSONObject().put("organizeEdit", edit))
    }

    private var organizeTyped = 0


    fun organizeType(field: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:$field", text)) }
        val mine = ++organizeTyped
        main.postDelayed({ if (mine == organizeTyped) organizeEdit(JSONObject().put("type", "setText").put("field", field).put("value", text)) }, 200)
    }


    fun organizeDate(field: String, edit: JSONObject) {
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("typed:$field"); remove("datePicker") }) }
        organizeEdit(edit)
    }


    fun organizePicker(kind: String?) {
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); remove("createFailed"); if (kind == null) remove("picker") else put("picker", kind) }) }
        if (kind != null) reload()
    }

    fun organizeQuery(text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text).apply { remove("createFailed") }) }
        val mine = ++organizeTyped
        main.postDelayed({ if (mine == organizeTyped) reload() }, 200)
    }


    fun organizeCreate(name: String) {
        shell.failedAction?.takeIf { it.kind == "bulkCreate" }?.let { return retry(it) }
        val open = dialog?.takeIf { it.optString("kind") == "organize" } ?: return
        val kind = open.menuText("picker") ?: return
        val list = list ?: return
        if (!idle) return
        keepDialog(JSONObject(open.toString()).put("creating", true).apply { remove("createFailed") })
        create(FailedAction("bulkCreate", UUID.randomUUID().toString(), JSONObject().put("list", list).put("kind", kind).put("name", name)
            .put("draft", open.optJSONObject("draft") ?: JSONObject()).toString()))
    }


    fun organizeSubmit() {
        ++organizeTyped
        reload()
        whenIdle {
            val submit = page?.bulk?.optJSONObject("picker")?.optJSONObject("submit") ?: return@whenIdle
            submit.optJSONObject("edit")?.let { edit -> organizePicker(null); organizeEdit(edit) } ?: submit.menuText("create")?.let(::organizeCreate)
        }
    }


    fun organizeApply() {
        val open = dialog ?: return
        ++organizeTyped
        for (field in open.keys().asSequence().toList()) if (field.startsWith("typed:")) {
            val typed = open.getString(field)
            if (page?.bulk?.optJSONObject("organize")?.getJSONObject("draft")?.optString(field.removePrefix("typed:")) != typed) {
                reload(bulkEdit = JSONObject().put("organizeEdit", JSONObject().put("type", "setText").put("field", field.removePrefix("typed:")).put("value", typed)))
            }
        }
        whenIdle {
            val organize = page?.bulk?.optJSONObject("organize") ?: return@whenIdle

            val review = page?.bulk?.takeIf { list == "review" }
            if (!organize.getBoolean("canApply")) dialog?.let { keepDialog(JSONObject(it.toString()).put("validation", true)) }
            else if (review != null) { bulkBusy = "organize"; act("reviewAction", organizeTasks(review.getJSONArray("selectedIds").ids(), organize.getJSONObject("draft"), review.getJSONObject("taskRevisions"))) }
            else bulkAction(JSONObject().put("type", "organize").put("draft", organize.getJSONObject("draft")), "organize")
        }
    }


    private fun bulkDone(action: FailedAction, reply: JSONObject) {
        val list = JSONObject(action.title).getString("list")
        bulkBusy = null
        closeDialog("organize")
        closeDialog("bulkTag")
        if (reply.optBoolean("changed")) endBulk(list)
        reply.optJSONObject("toast")?.let { toast ->
            val undo = toast.optJSONObject("undo")
            shell.showToast(toast, undo?.getString("label")) {
                undo?.let { whenIdle { bulkBusy = "undo"; act("bulkAction", JSONObject().put("list", list).put("action", it.getJSONObject("action"))) } }
            }
        }
    }


    fun retry(action: FailedAction) = send(action)


    private fun input(action: FailedAction): String = when (action.kind) {
        "activateProject" -> JSONObject().put("projectId", action.id).put("projectRevision", action.patch["projectRevision"])
        "somedayMove" -> JSONObject().put("taskIds", JSONArray(action.patch["taskIds"].orEmpty().split(","))).put("requestId", action.id)
            .put("sectionId", action.patch["sectionId"] ?: JSONObject.NULL).put("taskRevisions", JSONObject(action.patch["taskRevisions"] ?: "{}"))
        "somedayProjectMove" -> JSONObject().put("projectId", action.title).put("sectionId", action.patch["sectionId"] ?: JSONObject.NULL)
            .put("projectRevision", action.patch["projectRevision"]).put("requestId", action.id)
        "somedayUndo" -> JSONObject().put("moveRequestId", action.title).put("requestId", action.id)
        "somedayTask" -> JSONObject().put("title", action.title).put("captureId", action.id).put("sectionId", action.patch["sectionId"] ?: JSONObject.NULL)
        "somedaySection" -> JSONObject().put("title", action.title).put("requestId", action.id)
        "taskListSort" -> JSONObject().put("sortBy", action.id)

        "calendarAction", "calendarCreate", "boardAction", "boardCreate" -> JSONObject(action.title).put("requestId", action.id)

        "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> JSONObject(action.title).put("requestId", action.id)

        "bulkCreate", "mindSweepAdd", "savedSearchDelete", "savedSearchSort" -> JSONObject(action.title).put("requestId", action.id)

        "projectNextAction" -> JSONObject(action.title).put("requestId", action.id)

        "taskCompletedAt" -> JSONObject(action.title).put("requestId", action.id)

        "taskDestinationMove" -> JSONObject(action.title).put("requestId", action.id)

        "taskDatesSave", "taskSwipeFocus" -> JSONObject(action.title).put("requestId", action.id)
        "generalSetting", "gtdSetting", "manageEditor", "manageDelete", "dataSetting", "syncPreference", "setAISetting", "calendarSetting" -> JSONObject(action.title).put("requestId", action.id)

        "notificationsSetting" -> JSONObject(action.title).put("requestId", action.id)
        "somedayRename", "somedayReorder", "somedayDelete" -> JSONObject(action.title)

        "areaOrder", "areaColor" -> JSONObject(action.title).put("requestId", action.id)
        else -> JSONObject().put("requestId", action.id).put("action", JSONObject(action.title))
    }.toString()


    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val reply = try {
            runtime.menuCommand(action.kind, input(action))
        } catch (failure: Exception) {
            val refused = UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }
                || ((action.kind in LANDLESS || action.kind == "projectNextAction") && failure.message?.startsWith("ACTION_FAILED") == true)
            if (refused && action.kind in CREATES) shell.ui { store.delete() }

            if (refused && action.kind == "calendarCreate") shell.ui { calendar.refused(action) }

            if (refused && action.kind == "focusSave") shell.ui {
                if (JSONObject(action.title).optString("view") == "contexts") {
                    dialog?.takeIf { it.optString("kind") == "contextsSave" && it.optString("requestId") == action.id }
                        ?.let { keepDialog(JSONObject(it.toString()).put("requestId", UUID.randomUUID().toString())) }
                } else focusControls.refused(action)
            }


            if (refused && action.kind in SETTINGS_KINDS) { shell.ui { settings.refused(action, failure) }; if (action.kind == "gtdSetting") return@perform
                if (action.kind == "calendarSetting") { shell.acknowledged(action); return@perform } }

            if (refused && action.kind == "reviewAction" && failure.message?.startsWith("STALE_REVISION") == true) shell.ui { bulkBusy = null; whenIdle { reload() } }

            if (refused && action.kind == "somedayUndo") {
                Log.w(CoreHost.TAG, "Someday Undo refused: ${failure.message?.substringBefore(':')}")
                shell.ui { undoFailed() }; return@perform
            }


            if (refused && action.kind in LANDLESS) {
                shell.acknowledged(action)
                shell.ui { landless(action) }
                return@perform
            }


            staleMoveLine(action.kind, failure.message)?.let { line -> shell.ui {
                if (action.kind == "somedayProjectMove") dialog?.takeIf { it.optString("kind") == "move" && it.optString("projectId") == action.title }?.let { keepDialog(null) }
                shell.showToast(t("common.error"), line, "error", durationMs = 4200)
            } }

            if (action.kind == "dataSetting") shell.ui { settings.archiveSaveFailed(true, action) }


            if (refused && action.kind == "projectNextAction") {
                shell.acknowledged(action)
                val fresh = if (failure.message?.startsWith("STALE_REVISION") != true) null else runCatching {
                    runtime.menuRead("projectNextActionPrompt", JSONObject().put("taskId", JSONObject(action.title).getString("taskId")).toString())
                        .optJSONObject("prompt")
                }.onFailure { Log.w(CoreHost.TAG, "Project next action prompt not read again ${failureForLog(it)}") }
                shell.ui { shell.nextAction.refused(stale = fresh?.isSuccess == true, fresh = fresh?.getOrNull()) }
                return@perform
            }

            if (action.kind == "projectNextAction") shell.ui { shell.nextAction.owed() }

            if (!refused && action.kind == "generalSetting") settings.unsettled(runtime, action)
            throw failure
        }

        if (action.kind in SETTINGS_KINDS) settings.applied(runtime, reply)
        shell.acknowledged(action)
        shell.ui {
            if (action.kind in CREATES) store.delete()
            if (action.kind == "dataSetting") settings.archiveSaveFailed(false, action)
            finish(action, reply)
        }

        if (action.kind == "taskCompletedAt" && reply.optBoolean("completed")) shell.askNextAction(runtime, JSONObject(action.title).getString("taskId"))
    }

    private fun undoFailed() {
        val text = page?.view?.optJSONObject("text") ?: return
        shell.showToast(text.getString("errorTitle"), text.getString("undoFailed"), "error")
    }

    private fun JSONObject.text(name: String) = if (!has(name) || isNull(name)) null else getString(name)


    private fun finish(action: FailedAction, reply: JSONObject) {
        when (action.kind) {
            "taskSwipeFocus" -> reply.optString("blocked").takeIf { it.isNotEmpty() }?.let { shell.showToast(reply.getString("blockedTitle"), it) }
            "projectNextAction" -> shell.nextAction.done(reply)
            "somedayMove" -> {
                val refused = reply.optJSONObject("refused")
                if (refused != null) { shell.showToast(refused, tone = "error"); return }
                closeDialog("move")

                if (own("someday").has("bulk")) endBulk("someday")
                reply.optJSONObject("toast")?.let { toast ->
                    val moveRequestId = reply.getString("undoRequestId")
                    shell.showToast(toast, toast.getString("undoLabel"), "success") { undo(moveRequestId) }
                }
            }

            "somedayProjectMove" -> {
                reply.optJSONObject("refused")?.let { refused -> shell.showToast(refused, tone = "error"); return }
                closeDialog("move")
            }
            "somedayTask" -> {
                val refused = reply.optJSONObject("refused")

                if (refused != null) {
                    dialog?.let { keepDialog(JSONObject(it.toString()).put("error", refused.getString("message")).put("captureId", UUID.randomUUID().toString())) }
                    return
                }
                closeDialog("addTask")
                shell.showToast(null, reply.getString("toast"), "success")
            }
            "somedaySection" -> {
                val open = dialog?.takeIf { it.optString("kind") == "newSection" }
                closeDialog("newSection")

                open?.optJSONArray("taskIds")?.let { ids -> whenIdle { move(ids.strings(), reply.getString("id"), open.optJSONObject("taskRevisions") ?: JSONObject()) } }
                open?.optString("projectId")?.ifEmpty { null }?.let { id -> whenIdle { moveProject(id, reply.getString("id"), open.getString("projectRevision")) } }
            }
            "archiveAction" -> {
                if (JSONObject(action.title).optString("type") in setOf("moveTasksToInbox", "trashTasks")) selecting(false)
                reply.optJSONObject("toast")?.let { toast ->
                    val undo = toast.optJSONObject("undo")
                    shell.showToast(toast, undo?.getString("label")) {
                        undo?.let { whenIdle { archive(it.getJSONObject("action")) } }
                    }
                }
            }
            "contextsAction", "trashAction", "reviewAction", "reviewTask" -> listDone(action, reply)
            "calendarAction", "calendarCreate" -> calendar.done(action, reply)
            "boardAction", "boardCreate" -> board.done(action, reply)
            "bulkAction" -> bulkDone(action, reply)
            "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> {
                if (action.kind == "focusSave" && JSONObject(action.title).optString("view") == "contexts") {
                    editOwn("contexts") {
                        put("savedFilterId", reply.getJSONObject("controls").getString("savedFilterId"))
                        put("tokens", JSONArray())
                        remove("preservedCriteria")
                    }
                    closeDialog("contextsSave")
                    Log.i(CoreHost.TAG, "Native Context filter saved releaseCheck=v1.3.8/context-filter-save outcome=confirmed")
                } else focusControls.done(action, reply)
            }
            in SETTINGS_KINDS -> settings.done(action, reply)

            "bulkCreate" -> dialog?.takeIf { it.optString("kind") == "organize" }?.let { open ->
                keepDialog(JSONObject(open.toString()).put("draft", reply.getJSONObject("draft")).apply { remove("picker"); remove("query"); remove("creating"); remove("createFailed") })
            }
            "mindSweepAdd" -> sweep.added(action, reply)

            "savedSearchDelete" -> if (screen == MenuScreen.SavedSearch && own("savedSearch").optString("id") == JSONObject(action.title).getString("id")) closeScreen()
        }
    }


    private fun landless(action: FailedAction) {
        when (action.kind) {
            "mindSweepAdd" -> sweep.refused(action)
            else -> dialog?.takeIf { it.optString("kind") == "organize" }?.let { keepDialog(JSONObject(it.toString()).put("createFailed", true).apply { remove("creating") }) }
        }
    }


    private fun listDone(action: FailedAction, reply: JSONObject) {
        val type = JSONObject(action.title).optString("type")
        if (action.kind == "reviewTask") {
            val open = dialog?.takeIf { it.optString("kind") == "projectTask" }
            closeDialog("projectTask")
            reply.text("createdId")?.takeIf { open?.optBoolean("edit") == true }?.let { id -> whenIdle { shell.openEditor(id, "task") } }
        }
        if (type in BULK) endSelection()

        if (type == "organizeTasks") { bulkBusy = null; closeDialog("organize") }
        if (type == "markReviewedTasks" && reply.optBoolean("changed")) shell.showToast(null, t("review.markReviewedDone"), "success")
        reply.optJSONObject("toast")?.let { toast ->
            val undo = toast.optJSONObject("undo")
            val kind = if (action.kind == "reviewTask") "reviewAction" else action.kind
            shell.showToast(toast, undo?.getString("label")) {
                undo?.let { whenIdle { act(kind, it.getJSONObject("action")) } }
            }
        }
    }


    internal fun endSelection() {
        when (val list = list ?: return) {
            "trash" -> editOwn(list) { put("selecting", false).put("selectedTasks", JSONArray()).put("selectedProjects", JSONArray()) }
            "archive" -> selecting(false)
            else -> editOwn(list) { put("selected", JSONArray()) }
        }
    }


    fun start(sheet: MenuPage?) {
        sheet?.let(::keepMore)
        store.read()?.let { pending ->
            if (shell.failedAction == null) {
                shell.owe(pending)
                send(pending)
            }
        }
        refresh()
    }
}
