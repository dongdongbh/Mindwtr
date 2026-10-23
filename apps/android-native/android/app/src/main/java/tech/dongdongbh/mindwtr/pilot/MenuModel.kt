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

/*
 * RN's Menu tab (app/(drawer)/(tabs)/_layout.tsx): the More sheet and the list screens it opens, on core's menu view
 * contract (native-host-contract-menu-views.ts), History's Archive, Contexts and Trash (the list views block of
 * native-host-contract.ts), Review with the Weekly and Daily Review (native-host-contract-review-views.ts), and the Calendar and
 * the Board (CalendarModel.kt, BoardModel.kt, on native-host-contract-calendar.ts and native-host-contract-board.ts), the Inbox
 * tab's list (native-host-contract-inbox-view.ts), the lists' selection mode (native-host-contract-bulk-actions.ts), Focus's
 * controls (FocusModel.kt, on native-host-contract-focus-controls.ts), Mind Sweep (MindSweep.kt), and a saved search's screen
 * (native-host-contract-saved-search.ts).
 * Kotlin keeps only RN's screen state: which sheet, screen and dialog are open, the session choices RN keeps in React
 * state, and the device choices RN keeps under its keys. Every row, heading, count, label, filter and edit is core's.
 * Reads and commands run on InboxViewModel's paths (perform, background, freshness, the exact-retry lock).
 */

private const val PAGE = 50
/** Core windows every collection by NATIVE_HOST_MAX_WINDOW. */
private const val WINDOW = 100

/** The Menu tab's commands (host-entry.ts MENU_COMMANDS); core can refuse each before writing. */
val MENU_KINDS = setOf("activateProject", "somedayMove", "somedayUndo", "somedayTask", "somedaySection", "taskListSort", "archiveAction",
    "contextsAction", "trashAction", "reviewAction", "reviewTask", "calendarAction", "calendarCreate", "boardAction", "boardCreate",
    "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder", "bulkCreate", "mindSweepAdd", "savedSearchDelete") + SETTINGS_KINDS
/**
 * The creates whose exact request waits on disk until core answers: Someday's, the Weekly Review's project Add task, the
 * Calendar composer's Save, the Board's Duplicate, a saved Focus filter, Settings › Manage's editor Save (a new area or person),
 * Bulk organize's new project or area, and a Mind Sweep capture.
 */
private val CREATES = setOf("somedayTask", "somedaySection", "reviewTask", "calendarCreate", "boardCreate", "focusSave", "manageEditor", "bulkCreate", "mindSweepAdd")

/**
 * The commands whose ACTION_FAILED means core's write did not land (core's contracts say so): Mind Sweep's Add (RN's "add failed"
 * line) and Bulk organize's create (RN's "failed to create" line). Like a refusal, nothing is owed.
 */
private val LANDLESS = setOf("mindSweepAdd", "bulkCreate", "calendarSetting")

/** The lists with RN's selection mode on core's bulk contract (getBulkActions, runBulkAction). */
val BULK_LISTS = setOf("inbox", "waiting", "someday", "reference", "done")

/**
 * The screens the More sheet opens here, with the title key of RN's stack header. History holds Done and Archived; Projects is
 * RN's Projects stack screen when the quick-access tab holds another view; Weekly and Daily are RN's review flows, full screen
 * over Review (or its tab), with core's own header.
 */
enum class MenuScreen(val title: String) {
    Waiting("waiting.title"), Someday("someday.title"), Reference("nav.reference"), History("nav.history"),
    Contexts("contexts.title"), Trash("trash.title"), Review("nav.review"), Projects("projects.title"), Weekly("nav.review"), Daily("nav.review"),
    Calendar("nav.calendar"), Board("nav.board"), Settings("settings.title"),
    // RN's Mind Sweep modal and a saved search's screen (its stack title); a widget list's screen titles itself with core's title.
    MindSweep("mindSweep.title"), SavedSearch("search.title"), WidgetList("search.noResults"),
}

/** Core's bulk actions (Contexts, Trash, Review, and a Review row's Mark reviewed): each ends RN's selection mode once core answers. */
private val BULK = setOf("moveTasks", "editTaskTokens", "trashTasks", "restoreItems", "purgeItems", "emptyTrash", "addTag", "removeTags", "markReviewedTasks",
    "organizeTasks", "markTaskReviewed")

/** The lists whose contract writes their rows' status (Contexts, and the Review screens): the command kind for each. */
private val ROW_KINDS = mapOf("contexts" to "contextsAction", "review" to "reviewAction", "weekly" to "reviewAction", "daily" to "reviewAction")

/** RN's routes for the lists this app has (search results and the More sheet's tiles go there). */
private val ROUTES = mapOf("/waiting" to (MenuScreen.Waiting to null), "/someday" to (MenuScreen.Someday to null),
    "/reference" to (MenuScreen.Reference to null), "/done" to (MenuScreen.History to "done"), "/archived" to (MenuScreen.History to "archived"))
fun isMenuRoute(route: String?) = route in ROUTES

/** One list item as core sent it ([json]); a task item also carries its parsed [row]. */
class MenuItem(val json: JSONObject, val row: TaskRow?) {
    /** Waiting's rows are plain task rows; the other lists say what each item is. */
    val type: String get() = json.optString("type", "task")
    /** A multi-tag task shows under each tag heading, so the heading is part of its key, as RN's keyExtractor does. A Weekly Review context card is keyed by its context. */
    val key: String get() = if (row != null) "task:${json.optString("groupId")}:${row.id}" else "$type:${json.optString("id").ifEmpty { json.optString("context") }}"
}

private fun JSONObject.list(name: String): List<JSONObject> = optJSONArray(name)?.let { items -> List(items.length()) { items.getJSONObject(it) } }.orEmpty()

private fun JSONObject.menuItems(): List<MenuItem> {
    optJSONArray("rows")?.let { rows -> return List(rows.length()) { index -> rows.getJSONObject(index).let { MenuItem(it, it.taskRow()) } } }
    // A Daily Review item has no type: it is a task row with the step's flags.
    return list("items").map { item -> MenuItem(item, if (item.optString("type", "task") == "task") item.getJSONObject("row").taskRow() else null) }
}

/** Where each windowed collection sits in its view (native-host-contract-menu-views.ts). */
private fun window(view: JSONObject, name: String): JSONObject? = when (name) {
    "people" -> view.optJSONObject("people")
    "deferredProjects" -> view.optJSONObject("deferred")?.optJSONObject("rows")
    "tokens" -> view.optJSONObject("filters")?.optJSONObject("tokens")
    "projects" -> view.optJSONObject("filters")?.optJSONObject("projects")
    "sections" -> view.optJSONObject("sections")
    "savedSearches" -> view.optJSONObject("savedSearches")
    // The Weekly Review's nested lists (getWeeklyReviewList); a context card's tasks sit on its item (MenuPage.source).
    "staleProjects" -> view.optJSONObject("content")?.optJSONObject("projects")
    else -> null
}

/**
 * A menu view at one revision: the [list] it was read for, core's reply for its first window ([view]), the inputs core accepted
 * ([params], sent again for every later window), its items as deep as shown, each windowed collection as paged, and, while the
 * list is selecting, core's getBulkActions reply for it ([bulk]; Review's is its view's own bar, with its Organize dialog).
 */
class MenuPage(val list: String, val view: JSONObject, val params: JSONObject, val items: List<MenuItem>, private val paged: Map<String, List<JSONObject>>,
               val bulk: JSONObject? = null) {
    val revision: String get() = view.getString("revision")
    val total: Int get() = view.optInt("total")
    /** A collection's items as shown: its first window, or as many as More loaded. */
    fun collection(name: String): List<JSONObject> = paged[name] ?: source(name)?.list("items").orEmpty()
    fun collectionTotal(name: String): Int = source(name)?.optInt("total") ?: 0
    /** Where a collection's first window is: in the view, or on a Weekly Review context card ("contextTasks:<context>"). */
    private fun source(name: String): JSONObject? = window(view, name)
        ?: items.firstNotNullOfOrNull { item -> item.json.optJSONObject("tasks")?.takeIf { name == "contextTasks:${item.json.optString("context")}" } }
    /** How deep each paged collection is shown, so a refresh reads it as deep. */
    val deep: Map<String, Int> get() = paged.mapValues { it.value.size }
    fun appended(more: List<MenuItem>) = MenuPage(list, view, params, items + more, paged, bulk)
    fun withCollection(name: String, items: List<JSONObject>) = MenuPage(list, view, params, this.items, paged + (name to items), bulk)
    fun withBulk(bulk: JSONObject?) = MenuPage(list, view, params, items, paged, bulk)
}

/** A Someday create's exact request in the no-backup folder, synced before the call, until core answers (as the capture's). */
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

/** The lists [MenuModel.refresh] hands to their own models, which keep their own rows. */
private val OWN_READS = setOf("calendar", "board", "settings", "mindSweep")

/**
 * The Menu tab's state, held by InboxViewModel (so rotation keeps it) and saved in the Bundle (so process death keeps the
 * open sheet, screen, History tab, dialog, and RN's session choices). Rows reload from core.
 */
class MenuModel(internal val shell: InboxViewModel, private val saved: SavedStateHandle, internal val prefs: SharedPreferences, dir: File) {
    private val store = MenuStore(dir)
    private val main = Handler(Looper.getMainLooper())

    /** RN's More sheet is open (the Menu tab toggles it). */
    var sheet by mutableStateOf(saved.get<Boolean>("menuSheet") == true); private set
    /** Core's getMoreMenu reply, with its saved searches as paged. */
    var more by mutableStateOf<MenuPage?>(null); private set
    /** Core's quickAccessView (getMoreMenu): the view on RN's quick-access tab. In the Bundle, so a recreated screen draws it at once. */
    var quickAccess by mutableStateOf(saved.get<String>("quickAccess")); private set
    /** What the quick-access tab shows: Review, Contexts or the Calendar; Projects otherwise. */
    val quickView: String get() = quickAccess?.takeIf { it == "review" || it == "contexts" || it == "calendar" } ?: "projects"
    /** The quick-access tab's label key (RN's tab title, also its header's). */
    val quickLabel: String get() = when (quickView) { "review" -> "tab.review"; "contexts" -> "nav.contexts"; "calendar" -> "nav.calendar"; else -> "nav.projects" }
    var screen by mutableStateOf(MenuScreen.entries.firstOrNull { it.name == saved.get<String>("menuScreen") }); private set
    /** History's tab, core's HistoryTab id. */
    var historyTab by mutableStateOf(saved.get<String>("historyTab") ?: "done"); private set
    /** Core's getHistoryView reply: its tabs and their labels. */
    var history by mutableStateOf<JSONObject?>(null); private set
    /** The last list read, at one revision. */
    private var loaded by mutableStateOf<MenuPage?>(null)
    /** The open list at one revision: a page read for another list (the tab changed since) is not shown. */
    val page: MenuPage? get() = loaded?.takeIf { it.list == list }
    /**
     * RN's session choices, as its screens keep them in React state, by list: Waiting's person; Someday's sort, grouping,
     * details and filters; Reference's grouping, archived-projects switch and filters; Done's filters; Archive's segment,
     * search, and selection. Small, so it rides the Bundle.
     */
    var session by mutableStateOf(runCatching { JSONObject(saved.get<String>("menuState") ?: "{}") }.getOrDefault(JSONObject())); private set
    /** The sheet or dialog over the list: filters, the overflow menu, sort, group, move, new section, add task, or a confirm. */
    var dialog by mutableStateOf(saved.get<String>("menuDialog")?.let { runCatching { JSONObject(it) }.getOrNull() }); private set
    /** Core's getSomedayMoveDialog reply for the open move dialog, with its choices as paged. */
    var moveChoices by mutableStateOf<JSONObject?>(null); private set
    /** RN's Calendar and Board: their own state and reads; their writes come back here (command, create). */
    val calendar = CalendarModel(this, saved)
    val board = BoardModel(this, saved)
    /** Focus's controls (the filter sheet, saved filters, View options, reorder); Focus's reads stay InboxViewModel's. */
    val focusControls = FocusModel(this, saved)
    /** The bulk action running now (a key of core's `labels.busy`), for the bar's spinner and label. */
    var bulkBusy by mutableStateOf<String?>(null); private set
    /** The filter picker's search: core's tokens or projects matching the typed query, from offset zero, at the list's revision. */
    var pickerFound by mutableStateOf<JSONObject?>(null); private set
    /** RN's Settings: its own screens, reads and writes (SettingsModel.kt). */
    val settings = SettingsModel(this, saved)
    /** RN's Mind Sweep (MindSweep.kt): its screen state on disk while it is open. */
    val sweep = MindSweepModel(this, File(dir, "mind-sweep"))

    /** The core read behind the open screen (History shows Done or Archive), or behind the quick-access tab when it shows. */
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
            // The Inbox tab: RN's TaskList on core's getInboxView.
            shell.screen == Screen.Inbox -> "inbox"
            else -> null
        }
    }

    /** The open list's rows come in [page] (the lists [refresh] hands to their own models do not) and none are read yet. */
    val firstPagePending get() = list.let { it != null && it !in OWN_READS } && page == null

    /** No command runs and no retry is owed: the lists' controls are enabled. */
    val idle get() = shell.writable && !shell.busy && shell.failedAction == null

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

    /** Closes the dialog of [kind] only, so an answer that arrives late never closes another one. */
    internal fun closeDialog(kind: String) { if (dialog?.optString("kind") == kind) keepDialog(null) }

    // ---- Navigation ----

    /** RN's Menu tab: opens the sheet, or closes it (RN's tab toggles it). */
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

    /**
     * A tile's destination by core's id: a list this app has opens; Projects shows the Projects tab. The other tiles are
     * drawn disabled ([opens] is false for them), so they never get here.
     */
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

    /** A saved search of the More sheet (core's route `/saved-search/<id>`). */
    private fun isSavedSearch(id: String) = more?.collection("savedSearches")?.any { it.getString("id") == id && it.getString("route").startsWith("/saved-search/") } == true

    /** An automatic sync's warning toast's Open: RN's Settings › Sync. */
    fun openSyncSettings() {
        open(MenuScreen.Settings)
        settings.push("sync")
    }

    /**
     * RN's `/settings?settingsScreen=<screen>`: the startup prompt window's feedback (About), and the welcome sheet's Set up sync
     * and Import tasks (`sync`, `data`) with `onboardingHandoff=1`, which shows their Getting Started card for this visit.
     */
    fun openSettingsScreen(screen: String, onboardingHandoff: Boolean = false) {
        open(MenuScreen.Settings)
        settings.push(screen)
        if (onboardingHandoff) settings.editLocal { put("onboardingHandoff", true) }
    }

    /** An AI toast's Open (RN's `/settings?settingsScreen=ai`): Settings › AI. */
    fun openAISettings() {
        open(MenuScreen.Settings)
        settings.push("ai")
    }

    /** RN's saved search screen (`/saved-search/<id>`), pushed over the tabs under RN's stack header. */
    fun openSavedSearch(id: String) {
        editOwn("savedSearch") { put("id", id) }
        open(MenuScreen.SavedSearch)
    }

    /** RN's widget list screen (`/widget-list/<id>`, a Tasks widget's header for Next Actions or a saved filter), over the tabs. */
    fun openWidgetList(id: String) {
        editOwn("widgetList") { put("id", id) }
        open(MenuScreen.WidgetList)
    }

    /** RN's Mind Sweep (the Inbox's button, the Weekly Review's link): a new sweep, full screen over the screen it opens from. */
    fun openMindSweep() {
        saved["screenFrom"] = screen?.name
        sweep.reset()
        open(MenuScreen.MindSweep)
    }

    /**
     * RN's Projects: the quick-access tab while it holds Projects, else RN's Projects stack screen (the tile core shows then);
     * [projectId] opens there (a parked or archived project, a search result).
     */
    fun openProjects(projectId: String?) {
        if (quickView == "projects") { closeSheet(); leave(null); shell.show(Screen.Projects) } else open(MenuScreen.Projects)
        projectId?.let(shell::openProject)
    }

    /**
     * RN's openContextsScreen(token) (a context or tag in the editor's View tab): Contexts with that chip selected, on the
     * quick-access tab while it holds Contexts, else RN's Contexts screen.
     */
    fun openContexts(token: String) {
        editOwn("contexts") { put("tokens", JSONArray(listOf(token))) }
        if (quickView == "contexts") { closeSheet(); leave(null); shell.show(Screen.Projects); reload() } else open(MenuScreen.Contexts)
    }

    /** RN's Start Review choice (core's option id): the Daily or the Weekly Review, full screen; Close returns here. */
    fun openReview(id: String) {
        saved["reviewFrom"] = screen?.name
        keepOwn(id, JSONObject())
        open(if (id == "daily") MenuScreen.Daily else MenuScreen.Weekly)
    }

    /** RN's route for a list (a search result core routes there): true when this app has that list. */
    fun openRoute(route: String): Boolean {
        val (target, tab) = ROUTES[route] ?: return false
        open(target, tab)
        return true
    }

    private fun open(target: MenuScreen, tab: String? = null) {
        closeSheet()
        // RN's Review opens folded (its focus effect clears the expansion) and not selecting.
        if (target == MenuScreen.Review) editOwn("review") { remove("expandedAreaIds"); remove("expandedProjectIds"); remove("selected") }
        // RN pushes a new Calendar or Board: it opens in core's saved view mode on today, with no filters.
        if (target == MenuScreen.Calendar) calendar.reset()
        if (target == MenuScreen.Board) board.reset()
        // RN pushes Settings on its menu: no search, no sub-screen open.
        if (target == MenuScreen.Settings) settings.reset()
        // RN mounts a new review modal: no analysis yet. Leaving it stops its analysis.
        if (target == MenuScreen.Weekly || screen == MenuScreen.Weekly) shell.ai.leaveReview()
        screen = target
        saved["menuScreen"] = target.name
        tab?.let(::keepTab)
        loaded = null
        keepDialog(null)
        if (target == MenuScreen.History) readHistory()
        reload()
        // RN mounts the Calendar and the review modals anew: each loads its external calendars again.
        when (target) {
            MenuScreen.Calendar -> calendarFeed("calendar")
            MenuScreen.Weekly -> calendarFeed("weeklyReview")
            MenuScreen.Daily -> calendarFeed("dailyReview")
            else -> {}
        }
    }

    /**
     * A screen's external calendars load again (host-calendar.ts refresh: RN's reload on mount, focus and a return to the app);
     * its end reads the screen again (the host's calendarFeed event). One never loaded loads at the screen's first read.
     */
    internal fun calendarFeed(slot: String) {
        val runtime = shell.coreHost() ?: return
        Thread({
            runCatching { runtime.calendarRequest("refreshCalendarFeed", JSONObject().put("slot", slot).toString()) }
                .onFailure { Log.w(CoreHost.TAG, "Calendar reload failed slot=$slot ${failureForLog(it)}") }
        }, "mindwtr-calendar-feed").start()
    }

    /**
     * RN's stack Back (the header's chevron, or the system's): the tabs again, or, from a review flow, the screen it opened
     * over (Review, or the quick-access tab), read again.
     */
    fun closeScreen() {
        // A Settings sub-screen goes back to the screen it opened from, as RN's stack pops it.
        if (screen == MenuScreen.Settings && settings.back()) return
        val flow = screen == MenuScreen.Weekly || screen == MenuScreen.Daily
        // Mind Sweep (RN's modal) goes back to the screen it opened over and forgets its state, as RN's modal does.
        val over = screen == MenuScreen.MindSweep
        if (screen == MenuScreen.MindSweep) sweep.forget()
        leave(if (flow || over) MenuScreen.entries.firstOrNull { it.name == saved.get<String>(if (over) "screenFrom" else "reviewFrom") } else null)
        if (list != null) refresh()
        // Back on the Calendar (the screen, or the quick-access tab): RN's focus reload.
        if (list == "calendar") calendarFeed("calendar")
    }

    /** A system entry's tab or capture (EntryPoints.kt): the sheet closes and an open screen is left, as RN's router replaces it. */
    fun toTabs() {
        closeSheet()
        if (screen != null) leave(null)
    }

    private fun leave(back: MenuScreen?) {
        if (screen == MenuScreen.Projects) shell.closeProject()
        // The Weekly Review closed: its analysis stops (review C1 verification 5).
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

    /** History's tab bar: the other tab's list, read from its first window. */
    fun showTab(tab: String) {
        if (tab == historyTab) return
        keepTab(tab)
        loaded = null
        keepDialog(null)
        readHistory()
        reload()
    }

    // ---- Reads ----

    /** The inputs of [list] as its screen keeps them, without paging. */
    private fun params(list: String): JSONObject {
        val own = own(list)
        val kept = { names: List<String> -> JSONObject().apply { for (name in names) if (own.has(name)) put(name, own.get(name)) } }
        return when (list) {
            "waiting" -> JSONObject().put("person", own.optString("person"))
            // RN draws parked projects inside their section group (#1319).
            "someday" -> kept(listOf("sortBy", "groupBy", "showDetails", "filters")).put("projectsInSections", true)
            "reference" -> kept(listOf("groupBy", "includeArchivedProjects", "filters")).apply {
                if (!has("groupBy")) prefs.getString(REFERENCE_GROUP_BY_KEY, null)
                    ?.takeIf { it in REFERENCE_GROUP_BY_OPTIONS }?.let { put("groupBy", it) }
            }.put("collapsedGroupIds", GroupCollapse.all(prefs, "reference", 200))
            "done" -> ListViewState.read(prefs, DONE_VIEW_KEY).into(kept(listOf("filters"))).put("collapsedGroupIds", GroupCollapse.all(prefs, "done", 200))
            // The Inbox's grouping and filters are RN's session choices; its folds are the device's, for the grouping shown.
            "inbox" -> kept(listOf("groupBy", "filters")).put("collapsedGroupIds", GroupCollapse.axis(prefs, "inbox", own.optString("groupBy", "none"), 200))
            // Archive's filters are core's state (its search is core's setSearch); the open sheet asks for every token in use.
            // Select all is core's stateless one: the rows deselected since go as `except`.
            "archive" -> ListViewState.read(prefs, ARCHIVED_VIEW_KEY).into(kept(listOf("segment", "filters")))
                .put("collapsedGroupIds", GroupCollapse.all(prefs, "archived", 1000)).apply {
                    if (dialog?.optString("kind") == "filters") put("filterSheetOpen", true)
                    own.optJSONArray("except")?.let { put("selectAll", JSONObject().put("except", it)) } ?: put("selectedIds", own.optJSONArray("selected") ?: JSONArray())
                }
            "contexts" -> kept(listOf("tokens", "matchMode", "searchQuery")).put("selectedIds", own.optJSONArray("selected") ?: JSONArray()).also { dialogInputs(list, it) }
            "trash" -> JSONObject().put("selected", JSONObject().put("taskIds", own.optJSONArray("selectedTasks") ?: JSONArray())
                .put("projectIds", own.optJSONArray("selectedProjects") ?: JSONArray()))
            // RN's Review opens on its Due scope.
            "review" -> kept(listOf("expandedAreaIds", "expandedProjectIds")).put("scope", own.optString("scope", "due"))
                .put("selectedIds", own.optJSONArray("selected") ?: JSONArray()).also { dialogInputs(list, it) }
            // A review's place is the checkpoint core gave last, kept on the device as RN keeps its session.
            "weekly" -> JSONObject().put("checkpoint", prefs.getString(WEEKLY_REVIEW_KEY, null) ?: JSONObject.NULL)
                .put("expandedProjectId", own.opt("expandedProjectId") ?: JSONObject.NULL)
            "daily" -> JSONObject().put("checkpoint", prefs.getString(DAILY_REVIEW_KEY, null) ?: JSONObject.NULL)
            "savedSearch" -> JSONObject().put("id", own.optString("id"))
            "widgetList" -> JSONObject().put("id", own.optString("id"))
            else -> JSONObject()
        }
    }

    /** What core accepted: the same inputs with core's returned filters and none of a one-time edit or dialog input, for every later window. */
    private fun accepted(list: String, params: JSONObject, view: JSONObject): JSONObject = JSONObject(params.toString()).apply {
        remove("organize"); remove("picker")
        view.optJSONObject("filters")?.optJSONObject("state")?.let { put("filters", it) }
        if (list == "waiting") put("person", view.getString("person"))
        if (list == "reference") put("includeArchivedProjects", view.getBoolean("includeArchivedProjects"))
        view.optJSONObject("selection")?.let { put("tokens", it.getJSONArray("tokens")).put("matchMode", it.getString("matchMode")) }
        if (list == "review") put("expandedAreaIds", view.getJSONArray("expandedAreaIds")).put("expandedProjectIds", view.getJSONArray("expandedProjectIds"))
        if (list == "weekly" || list == "daily") put("checkpoint", view.getString("checkpoint"))
    }

    /**
     * [list] from its first window ([edit], a filter control's exact edit or Review's expansion edit, goes with it once), its
     * items to [depth] at one revision, then each collection to its depth in [deep]. A list that changed between windows keeps
     * what it has; the next refresh reads it again, as the Inbox does. A selecting list ([bulk], its getBulkActions input) also
     * reads core's bar for the inputs core accepted.
     */
    private fun read(runtime: CoreHost, list: String, params: JSONObject, depth: Int, deep: Map<String, Int>, edit: JSONObject? = null, bulk: JSONObject? = null): MenuPage {
        val first = runtime.menuRead(list, JSONObject(params.toString()).put("offset", 0).put("limit", PAGE)
            .apply { edit?.let { put(if (list == "review") "expansionEdit" else "filterEdit", it) } }.toString())
        check(first.optInt("version", 1) == 1) { "Unsupported core contract" }
        val sent = accepted(list, params, first)
        var page = MenuPage(list, first, sent, first.menuItems(), emptyMap(), first.optJSONObject("bulk")?.takeIf { list == "review" })
        try {
            while (page.items.size < minOf(depth, page.total)) {
                val next = runtime.menuRead(list, JSONObject(sent.toString()).put("offset", page.items.size).put("limit", PAGE).put("revision", page.revision).toString()).menuItems()
                if (next.isEmpty()) break // core sent no items: stop, never spin
                page = page.appended(next)
            }
            for ((name, want) in deep) page = collectionTo(runtime, list, page, name, want)
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
        bulk?.let { input -> page = page.withBulk(runtime.menuRead("bulk", JSONObject(input.toString()).put("params", sent).toString())) }
        return page
    }

    /** [page]'s collection [name] paged until [want] items show. */
    private fun collectionTo(runtime: CoreHost, list: String, page: MenuPage, name: String, want: Int): MenuPage {
        var loaded = page.collection(name)
        while (loaded.size < minOf(want, page.collectionTotal(name))) {
            val next = collectionWindow(runtime, list, page, name, loaded.size).list("items")
            if (next.isEmpty()) break
            loaded = loaded + next
        }
        return page.withCollection(name, loaded)
    }

    /**
     * One window of [page]'s collection [name] from [offset] ([query]: the filter picker's search, from offset zero): the Weekly
     * Review's nested lists through getWeeklyReviewList, the Inbox's and Archive's filter tokens through their own reads, the menu
     * views' collections through getMenuViewCollection, each with the view's accepted inputs and revision.
     */
    private fun collectionWindow(runtime: CoreHost, list: String, page: MenuPage, name: String, offset: Int, query: String? = null): JSONObject = when (list) {
        "weekly" -> runtime.menuRead("weeklyList", JSONObject(page.params.toString()).put("list", name.substringBefore(':'))
            .apply { if (':' in name) put("key", name.substringAfter(':')) }.put("offset", offset).put("limit", WINDOW).put("revision", page.revision).toString())
        "inbox", "archive" -> runtime.menuRead(if (list == "inbox") "inboxTokens" else "archiveTokens", JSONObject().put("params", page.params)
            .put("offset", offset).put("limit", WINDOW).put("revision", page.revision).apply { query?.let { put("query", it) } }.toString())
        else -> runtime.menuRead("collection", JSONObject().put("view", list).put("collection", name).put("params", page.params)
            .put("offset", offset).put("limit", WINDOW).put("revision", page.revision).apply { query?.let { put("query", it) } }.toString())
    }

    /** A failed command's page, shown again on a new screen while its retry is owed (no read runs then). */
    internal fun restorePage(page: MenuPage) { loaded = page }

    /** A new list becomes the screen's, and core's accepted inputs become its choices (the filters core pruned, the person it offers). */
    private fun show(list: String, next: MenuPage) {
        if (list != this.list) return
        shell.readSucceeded()
        // A bar read before selection mode ended is not shown.
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
                "contexts" -> put("selected", next.view.getJSONArray("selectedIds"))
                "trash" -> next.view.getJSONObject("selected").let { put("selectedTasks", it.getJSONArray("taskIds")).put("selectedProjects", it.getJSONArray("projectIds")) }
                "review" -> put("expandedAreaIds", next.params.getJSONArray("expandedAreaIds")).put("expandedProjectIds", next.params.getJSONArray("expandedProjectIds"))
                    .put("selected", next.view.optJSONObject("bulk")?.getJSONArray("selectedIds") ?: JSONArray())
            }
            if (list == "contexts") put("tokens", next.params.getJSONArray("tokens")).put("matchMode", next.params.getString("matchMode"))
            // Selection mode: core's selection still on screen, in tap order, Range's anchor, and Select all's pruned except.
            val kept = optJSONObject("bulk")
            next.bulk?.takeIf { kept != null }?.let { bulk ->
                kept!!.put("selected", bulk.getJSONArray("selectedIds")).put("anchorId", bulk.opt("anchorId") ?: JSONObject.NULL)
                bulk.optJSONObject("selectAll")?.let { kept.put("except", it.getJSONArray("except")) }
            }
        }
        // Bulk Organize's draft: core's, with the edit applied.
        next.bulk?.optJSONObject("organize")?.let { organize ->
            dialog?.takeIf { it.optString("kind") == "organize" }?.let { keepDialog(JSONObject(it.toString()).put("draft", organize.getJSONObject("draft"))) }
        }
        // Core ended Review's selection (a selected row is no longer drawn): the dialogs on it close with its bar.
        if (list == "review" && next.bulk == null) closeSelectionDialogs(list)
        // A review's place: the checkpoint core answered with, kept under core's key until the review is finished.
        if (list == "weekly" || list == "daily") prefs.edit().putString(next.view.getString("storageKey"), next.view.getString("checkpoint")).apply()
    }

    /**
     * A read the user asked for (a screen opening, a filter, sort or group choice): through perform, as the lists' More,
     * once no action runs, so a choice made while a command finishes is still read.
     */
    internal fun reload(edit: JSONObject? = null, fresh: Boolean = false, bulkEdit: JSONObject? = null) = whenIdle {
        val list = list ?: return@whenIdle
        // The Calendar and the Board read their own contracts.
        if (list == "calendar") return@whenIdle calendar.reload()
        if (list == "board") return@whenIdle board.reload()
        if (list == "settings") return@whenIdle settings.reload()
        if (list == "mindSweep") return@whenIdle sweep.reload()
        val params = params(list)
        // Review's Organize control edit goes to core once with the draft as it is now (the lists' goes with their bar, below).
        if (list == "review") bulkEdit?.optJSONObject("organizeEdit")?.let { params.optJSONObject("organize")?.put("edit", it) }
        // A row tap (selectionEdit) or a Bulk Organize control's edit goes to core's bar once, with the selection as it is now.
        val bulk = bulkInput(list)?.apply {
            bulkEdit?.optJSONObject("selectionEdit")?.let { put("selectionEdit", it) }
            bulkEdit?.optJSONObject("organizeEdit")?.let { optJSONObject("organize")?.put("edit", it) }
        }
        // A new review step starts from its own first window, not as deep as the last step was shown.
        val shown = page.takeUnless { fresh }
        val depth = maxOf(PAGE, shown?.items?.size ?: 0)
        val deep = shown?.deep.orEmpty()
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, list, params, depth, deep, edit, bulk)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(list, next) }
        }
    }

    /** The failure banner's Try again after a failed read: the open list again, as a read the user asked for (it clears the failure). */
    fun retryRead() = reload()

    /** After every command, on resume, and after boot: the open sheet and list from their first window, as deep as shown. */
    fun refresh() {
        if (sheet) readMore()
        val list = list ?: return
        if (list == "calendar") return calendar.refresh()
        if (list == "board") return board.refresh()
        if (list == "settings") return settings.refresh()
        if (list == "mindSweep") return sweep.refresh()
        val params = params(list)
        val bulk = bulkInput(list)
        val shown = page
        val depth = maxOf(PAGE, shown?.items?.size ?: 0)
        val deep = shown?.deep.orEmpty()
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, list, params, depth, deep, bulk = bulk) }) { next, mine ->
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

    /** The sheet's reply, and with it the quick-access view the tab bar draws. */
    private fun keepMore(next: MenuPage) {
        more = next
        quickAccess = next.view.optString("quickAccessView").ifEmpty { null }
        saved["quickAccess"] = quickAccess
    }

    /** Core's More sheet at boot (on the boot thread), so the tab bar draws RN's quick-access tab from the first frame. */
    fun readSheet(runtime: CoreHost): MenuPage = read(runtime, "more", JSONObject(), 0, emptyMap())

    /** History's tab labels (cosmetic: a failed read shows no error; the list's own read reports one). */
    private fun readHistory() {
        val tab = historyTab
        shell.background(emptyList(), { runtime -> runtime.menuRead("history", JSONObject().put("tab", tab).toString()) }) { view, _ ->
            if (tab == historyTab) history = view
        }
    }

    /**
     * RN's list end: the next window of items at the loaded revision. STALE_REVISION is never an error (as on the other lists):
     * the list changed, so it is read again from the first window as deep as More asked.
     */
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

    /** The next window of a collection (people, parked projects, tokens, projects, saved searches), as for items. */
    fun loadCollection(name: String) {
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

    // ---- Screen choices ----

    /** Waiting's person chip ('' is All). */
    fun person(person: String) { editOwn("waiting") { put("person", person) }; reload() }

    /**
     * A filter control's exact edit, as core put it on the control, read at once with the screen's filters. Clear (or a
     * text chip's removal) also resets the sheet's typed text, so its fields show core's values again.
     */
    fun filterEdit(edit: JSONObject) {
        val type = edit.optString("type")
        dialog?.takeIf { it.optString("kind") == "filters" }?.let { open ->
            if (type == "clear" || type == "setSearch" || type == "setLocation") {
                keepDialog(JSONObject(open.toString()).apply { remove("typed:setSearch"); remove("typed:setLocation") })
            }
        }
        // Archive's search box shows core's search text: Clear, or its chip's removal, empties it too.
        if (list == "archive" && (type == "clear" || type == "setSearch")) editOwn("archive") { put("search", edit.optString("value")) }
        reload(edit)
    }

    private var filterTyped = 0
    private var searchTyped = 0

    /**
     * Typed filter text (RN's search and location fields): kept with the sheet as typed, then core's setSearch or
     * setLocation with it once typing pauses. Only typed text builds an edit here; every choice sends core's own.
     */
    fun typeFilter(type: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:$type", text)) }
        if (list == "archive" && type == "setSearch") editOwn("archive") { put("search", text) }
        val mine = ++filterTyped
        main.postDelayed({
            if (mine != filterTyped) return@postDelayed
            reload(JSONObject().put("type", type).put("value", text))
        }, 200)
    }

    /** Runs [read] now, or once the running action ends: a typed filter is never dropped because a read was running. */
    internal fun whenIdle(read: () -> Unit) { if (shell.busy) main.postDelayed({ whenIdle(read) }, 200) else read() }

    /** A header chip's removal: its filter edit, or Reference's archived-projects switch turned off (core's chip action). */
    fun removeChip(action: JSONObject) {
        action.optJSONObject("filterEdit")?.let { filterEdit(it); return }
        archivedProjects(false)
    }

    /** Reference's filter sheet switch. */
    fun archivedProjects(on: Boolean) { editOwn("reference") { put("includeArchivedProjects", on) }; reload() }

    /** Someday's sort and grouping (RN's session choices), and Reference's and Done's grouping. */
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

    /**
     * A sort choice: Someday's is its session's, Done's and Archive's the device's (RN's view state), and Reference's and
     * Contexts' is the stored task-list sort every list shares, a command through core's setTaskListSort.
     */
    fun sort(value: String) {
        when (val list = list ?: return) {
            "reference", "inbox", "contexts" -> send(FailedAction("taskListSort", value))
            "done" -> { ListViewState.read(prefs, DONE_VIEW_KEY).copy(sortBy = value).save(prefs, DONE_VIEW_KEY); reload() }
            "archive" -> { ListViewState.read(prefs, ARCHIVED_VIEW_KEY).copy(sortBy = value).save(prefs, ARCHIVED_VIEW_KEY); reload() }
            else -> { editOwn(list) { put("sortBy", value) }; reload() }
        }
    }

    /** Someday's Details toggle. */
    fun details(on: Boolean) { editOwn("someday") { put("showDetails", on) }; reload() }

    /** A folding heading, under the grouping core showed it in (the view's groupBy), kept as RN keeps it. */
    fun toggleGroup(id: String) {
        val list = list ?: return
        val axis = page?.view?.optString("groupBy")?.ifEmpty { null } ?: return
        // An Inbox heading carries its grouping's folds after the tap (core's collapseEdit), written whole as RN writes them.
        val collapse = page?.items?.firstOrNull { it.type == "section" && it.json.optString("id") == id }?.json?.optJSONObject("collapseEdit")
        if (list == "inbox" && collapse != null) GroupCollapse.keep(prefs, list, axis, collapse.getJSONArray("collapsedGroupIds"))
        else GroupCollapse.toggle(prefs, if (list == "archive") "archived" else list, axis, id)
        reload()
    }

    /** Archive's Tasks and Projects chips; a new segment leaves selection mode, as RN does. */
    fun segment(id: String) {
        editOwn("archive") { put("segment", id); put("selecting", false); put("selected", JSONArray()); remove("except") }
        reload()
    }

    /** Archive's search box: kept as typed, then core's setSearch with it once typing pauses. */
    fun search(text: String) {
        editOwn("archive") { put("search", text) }
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload(JSONObject().put("type", "setSearch").put("value", text)) }, 200)
    }

    /** A list's typed search (Archive's box, Contexts' chip search): kept as typed, read once typing pauses. */
    fun typeSearch(list: String, name: String, text: String) {
        editOwn(list) { put(name, text) }
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload() }, 200)
    }

    fun selecting(on: Boolean) {
        editOwn("archive") { put("selecting", on); put("selected", JSONArray()); remove("except") }
        if (!on) reload()
    }

    /** One row in or out of Archive's selection (after Select all, in or out of its `except`); core prunes it to the rows on screen and counts it. */
    fun toggleSelected(id: String) {
        val own = own("archive")
        val name = if (own.has("except")) "except" else "selected"
        val ids = own.optJSONArray(name)?.strings().orEmpty()
        editOwn("archive") { put(name, JSONArray(if (id in ids) ids - id else ids + id)) }
        reload()
    }

    /** Archive's Restore to Inbox or Delete ([type]) for its selection: core's Select all (params, revision, except), or the rows tapped. */
    fun archiveSelection(type: String): JSONObject {
        val view = page?.view
        return JSONObject().put("type", type).apply {
            // The explicit selection goes with each row's revision as the view showed it (core's taskRevisions for selectedIds).
            view?.optJSONObject("selectAll")?.let { put("selectAll", it) }
                ?: put("taskIds", view?.optJSONArray("selectedIds") ?: JSONArray()).put("taskRevisions", view?.optJSONObject("taskRevisions") ?: JSONObject())
        }
    }

    /**
     * RN's Select all: every task row a folded heading has not removed (Archive: core's stateless Select all, the rows deselected
     * since going as `except`), or every item in Trash, tasks and projects (core's windows are read to the end to find them).
     */
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

    // ---- Dialogs ----

    fun openDialog(kind: String) {
        keepDialog(JSONObject().put("kind", kind))
        // Archive's open sheet offers every token in use (core's filterSheetOpen).
        if (kind == "filters" && list == "archive") reload()
    }

    /** A sub-page of the open dialog (null: its first page): the overflow menu's Sort or Group panel, or the filter sheet's picker (its search starts empty). */
    fun dialogPage(page: String?) {
        pickerFound = null
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); if (page == null) remove("page") else put("page", page) }) }
    }

    /** The filter picker's search box: kept with the sheet as typed, then core's matching tokens or projects once typing pauses. */
    fun pickerQuery(name: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text)) }
        val mine = ++filterTyped
        main.postDelayed({ if (mine == filterTyped) searchPicker(name, text) }, 200)
    }

    /**
     * Core's [name] options (tokens or projects) matching [query] from offset zero at the list's revision, to [depth] (a More reads
     * one window deeper); a blank query shows the list's own. A list that changed meanwhile keeps the last results: the sheet asks
     * again for its new revision.
     */
    fun searchPicker(name: String, query: String, depth: Int = WINDOW) {
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
            // The list's revision moved (a minute passed, or another write): read the list again; its new revision runs the
            // search again (the sheet's LaunchedEffect), so a typed search never stays unanswered (run 47).
            else if (found == null) reload()
        }
    }

    /** The filter sheet's disclosure rows (time estimate, energy, more filters) that are open. */
    fun toggleDisclosure(id: String) {
        val open = dialog ?: return
        keepDialog(JSONObject(open.toString()).put(id, !open.optBoolean(id)))
    }

    /** RN's Back inside a dialog: a sub-page (or Bulk Organize's picker) returns to its first page, else the dialog closes (a new section returns to its move). */
    fun backInDialog() {
        val open = dialog ?: return
        when {
            open.has("page") -> dialogPage(null)
            open.has("picker") -> keepDialog(JSONObject(open.toString()).apply { remove("picker"); remove("query") })
            open.optString("kind") == "newSection" && open.has("taskIds") -> openMove(open.getJSONArray("taskIds").strings(), open.optJSONObject("taskRevisions") ?: JSONObject())
            else -> keepDialog(null)
        }
    }

    /** A dialog's typed text (a new section's name, a new task's title), kept with the dialog. */
    fun typeDialog(text: String) { dialog?.let { keepDialog(JSONObject(it.toString()).put("text", text).apply { remove("error") }) } }

    /** RN's delete confirmation for a list action ([action], core's, sent as [command]), with core's words ([confirmation]). */
    fun confirm(confirmation: JSONObject, action: JSONObject, command: String = "archiveAction") =
        keepDialog(JSONObject(confirmation.toString()).put("kind", "confirm").put("action", action).put("command", command))

    // ---- Someday ----

    /** The status menu's Move to section… on Someday's rows: core's dialog title, or null elsewhere. */
    fun moveLabel(task: TaskRow): String? {
        if (screen != MenuScreen.Someday) return null
        val shown = page ?: return null
        if (shown.items.none { it.row?.id == task.id }) return null
        return shown.view.getJSONObject("text").getString("moveToSection")
    }

    /**
     * RN's move dialog for [taskIds] with their revisions as core's view showed them ([taskRevisions]: a row's taskRevision, or the
     * bulk bar's moveToSection.taskRevisions): core's choices ("No section" first, the current one selected).
     */
    fun openMove(taskIds: List<String>, taskRevisions: JSONObject) {
        moveChoices = null
        keepDialog(JSONObject().put("kind", "move").put("taskIds", JSONArray(taskIds)).put("taskRevisions", taskRevisions))
        readMoveChoices()
    }

    /**
     * Core's move dialog from its first window, its choices read to [depth] at one revision. Choices that changed between
     * windows (STALE_REVISION) are never an error: the dialog stays open with what it read, as the lists do, and its More
     * reads it again from the first window.
     */
    private fun readMoveChoices(depth: Int = WINDOW) {
        val open = dialog?.takeIf { it.optString("kind") == "move" } ?: return
        val ids = open.getJSONArray("taskIds")
        shell.background(listOf(Part.MenuDialog), { runtime ->
            val first = runtime.menuRead("moveDialog", JSONObject().put("taskIds", ids).put("offset", 0).put("limit", WINDOW).toString())
            val choices = first.getJSONObject("choices")
            val items = choices.getJSONArray("items")
            try {
                while (items.length() < minOf(depth, choices.getInt("total"))) {
                    val next = runtime.menuRead("moveDialog", JSONObject().put("taskIds", ids).put("offset", items.length()).put("limit", WINDOW)
                        .put("revision", first.getString("revision")).toString()).getJSONObject("choices").getJSONArray("items")
                    if (next.length() == 0) break // core sent no choices: stop, never spin
                    for (index in 0 until next.length()) items.put(next.get(index))
                }
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
            }
            first
        }) { reply, mine -> if (shell.fresh(mine, Part.MenuDialog) && dialog?.optString("kind") == "move") moveChoices = reply }
    }

    /** The move dialog's More: its choices read again from the first window, one window deeper. */
    fun moreMoveChoices() { moveChoices?.getJSONObject("choices")?.getJSONArray("items")?.length()?.let { readMoveChoices(it + WINDOW) } }

    fun moveAction(taskIds: List<String>, sectionId: String?, taskRevisions: JSONObject) = FailedAction("somedayMove", UUID.randomUUID().toString(),
        patch = mapOf("taskIds" to taskIds.joinToString(","), "sectionId" to sectionId, "taskRevisions" to taskRevisions.toString()))

    /** A move dialog choice: core's moveSomedayTasksToSection with a new request UUID and the tasks' revisions the dialog opened with. */
    fun move(taskIds: List<String>, sectionId: String?, taskRevisions: JSONObject) = send(moveAction(taskIds, sectionId, taskRevisions))

    /** The toast's Undo: core's undoSomedaySectionMove for the move's request, with its own request UUID. */
    private fun undo(moveRequestId: String) {
        Log.i(CoreHost.TAG, "Someday Undo requested busy=${shell.busy}")
        whenIdle { send(FailedAction("somedayUndo", UUID.randomUUID().toString(), moveRequestId)) }
    }

    /** RN's New section… (the list menu's, or the move dialog's "+ New section…", which then moves the tasks into it, at their [taskRevisions]). */
    fun openNewSection(taskIds: List<String>? = null, taskRevisions: JSONObject? = null) = keepDialog(JSONObject().put("kind", "newSection").put("text", "")
        .put("requestId", UUID.randomUUID().toString()).apply { taskIds?.let { put("taskIds", JSONArray(it)).put("taskRevisions", taskRevisions ?: JSONObject()) } })

    /** A heading's Add task: RN's dialog for that section (null = No section), titled with core's label. */
    fun openAddTask(heading: JSONObject) {
        val addTask = heading.getJSONObject("addTask")
        keepDialog(JSONObject().put("kind", "addTask").put("text", "").put("title", addTask.getString("accessibilityLabel"))
            .put("sectionId", addTask.opt("sectionId") ?: JSONObject.NULL).put("captureId", UUID.randomUUID().toString()))
    }

    /**
     * The open create dialog's exact request: a section's name, a task's title with its capture UUID and section, or the Weekly
     * Review's project Add task (core's addProjectTask, its request UUID the new task's id).
     */
    fun createAction(): FailedAction? {
        val open = dialog ?: return null
        val text = open.optString("text").trim()
        if (text.isEmpty()) return null
        return when (open.optString("kind")) {
            "newSection" -> FailedAction("somedaySection", open.getString("requestId"), text)
            "addTask" -> FailedAction("somedayTask", open.getString("captureId"), text,
                patch = mapOf("sectionId" to if (open.isNull("sectionId")) null else open.getString("sectionId")))
            "projectTask" -> FailedAction("reviewTask", open.getString("requestId"), addProjectTask(open.getString("projectId"), open.optString("text")).toString())
            else -> null
        }
    }

    /** Save in a create dialog: the exact request is on disk (synced) before the call, and after process death it goes first. */
    fun saveCreate() {
        val action = createAction() ?: return
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        store.write(action)
        send(action)
    }

    /** A Calendar or Board create's exact request ([action]): on disk (synced) before the call, sent first after process death. */
    internal fun create(action: FailedAction) {
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        store.write(action)
        send(action)
    }

    /** A Calendar or Board action ([kind]) with core's whole [input] and a new request UUID; the input itself is its exact retry. */
    internal fun command(kind: String, input: JSONObject) = send(FailedAction(kind, UUID.randomUUID().toString(), input.toString()))

    /**
     * Waiting's and Someday's parked projects: RN's swipe makes one active (a target state; a retry writes nothing), at the row's
     * [projectRevision] (a project changed since is refused).
     */
    fun activate(projectId: String, projectRevision: String) = send(FailedAction("activateProject", projectId, patch = mapOf("projectRevision" to projectRevision)))

    // ---- Archive ----

    /** One of core's Archive actions, with a new request UUID; the action itself is its exact retry. */
    fun archive(action: JSONObject) = act("archiveAction", action)

    /** One of core's list actions ([kind]: archiveAction, contextsAction, trashAction, reviewAction), with a new request UUID. */
    internal fun act(kind: String, action: JSONObject) = send(FailedAction(kind, UUID.randomUUID().toString(), action.toString()))

    /**
     * RN's status change on a row of a list whose contract writes it (Contexts, the Review screens): that list's setTaskStatus,
     * from the swipe or the status menu. False for any other row (the status menu then uses updateTask).
     */
    fun rowStatus(task: TaskRow, status: String): Boolean {
        val kind = ROW_KINDS[list ?: return false] ?: return false
        if (page?.items?.none { it.row?.id == task.id } != false) return false
        shell.showStatusMenu(null)
        if (status != task.status) act(kind, setTaskStatus(task.id, status, task.taskRevision))
        return true
    }

    /**
     * RN's CompletedAtPicker on Android: the system date dialog, then the time dialog, starting at core's local day and time for
     * the row (completedAtPicker); the picked day and time go to core's setCompletedAt, which stores them as RN's picker does.
     */
    fun openCompletedAt(row: TaskRow, start: JSONObject) = keepDialog(JSONObject().put("kind", "completedAt").put("taskId", row.id)
        .put("taskRevision", row.taskRevision).put("day", start.getString("day")).put("time", start.getString("time")))

    /** The date dialog's day (`yyyy-MM-dd`, the picker's own fields): the time dialog opens next. */
    fun pickCompletedDay(day: String) { dialog?.takeIf { it.optString("kind") == "completedAt" }?.let { keepDialog(JSONObject(it.toString()).put("day", day).put("step", "time")) } }

    /** The time dialog's `HH:mm`: core's setCompletedAt for the picked day and time. */
    fun pickCompletedTime(time: String) {
        val open = dialog?.takeIf { it.optString("kind") == "completedAt" } ?: return
        keepDialog(null)
        archive(JSONObject().put("type", "setCompletedAt").put("taskId", open.getString("taskId")).put("day", open.getString("day")).put("time", time)
            .put("taskRevision", open.optString("taskRevision")))
    }

    // ---- Selection mode (Inbox, Waiting, Someday, Reference, Done: RN's TaskList and TaskListView bulk bar) ----

    /**
     * A selecting list's getBulkActions input, without its params (read() adds the ones core accepted): the rows tapped (in tap
     * order) or Select all with its `except`, Range and its anchor, and an open Bulk Organize draft, its picker, or the remove-tag
     * picker. Null while the list is not selecting.
     */
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

    /** A row of a list with selection mode: RN's circle and tap while selecting, the long-press that starts it; a read-only row has none. */
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

    /**
     * RN's toggleMultiSelect: a long-press starts selecting with that row, and a tap while selecting toggles it (with Range, every
     * row between it and the last one tapped; Range then ends). Core keeps the tap order and the anchor (selectionEdit); after
     * Select all, a tap moves the row in or out of `except`.
     */
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

    /** RN's Range: the next tap selects every row between it and the last one tapped. */
    fun bulkRange() {
        val list = list?.takeIf { it in BULK_LISTS } ?: return
        editOwn(list) { optJSONObject("bulk")?.let { it.put("range", !it.optBoolean("range")) } }
        reload()
    }

    /** The contract's stateless Select all: every selectable row on screen, less the ones tapped off since. */
    fun bulkSelectAll() {
        val list = list?.takeIf { it in BULK_LISTS } ?: return
        editOwn(list) { put("bulk", JSONObject().put("except", JSONArray()).put("selected", JSONArray())) }
        reload()
    }

    /** RN's exitSelectionMode on [list]: the bar goes with the selection, Range and its anchor. */
    fun endBulk(list: String) {
        editOwn(list) { remove("bulk") }
        loaded?.takeIf { it.list == list }?.let { loaded = it.withBulk(null) }
    }

    /**
     * One of core's bulk actions ([action] without its target) on the selection, or on Select all (core's own object), with a new
     * request UUID; [busy] names core's label while it runs. The payload is its exact retry.
     */
    fun bulkAction(action: JSONObject, busy: String) {
        bulkBusy = busy
        act("bulkAction", bulkPayload(action) ?: return)
    }

    /** RN's bulk delete: core's question first (deleteConfirmation), then core's trashTasks with its Undo. */
    fun bulkDelete() {
        val bulk = page?.bulk ?: return
        bulkBusy = "delete"
        confirm(bulk.getJSONObject("deleteConfirmation"), bulkPayload(JSONObject().put("type", "trashTasks")) ?: return, "bulkAction")
    }

    /** runBulkAction's input without its request UUID: the list, and [action] on the explicit selection or core's Select all. */
    private fun bulkPayload(action: JSONObject): JSONObject? {
        val list = list ?: return null
        val bulk = page?.bulk ?: return null
        val target = JSONObject(action.toString()).apply {
            // The explicit selection goes with each row's revision as core's bar showed it (its taskRevisions); Select all's own object carries its revision.
            bulk.optJSONObject("selectAll")?.let { put("selectAll", it) }
                ?: put("taskIds", bulk.getJSONArray("selectedIds")).put("taskRevisions", bulk.getJSONObject("taskRevisions"))
        }
        return JSONObject().put("list", list).put("action", target)
    }

    /** The remove-tag picker (core's tags on the selection), read with the bar. */
    fun openRemoveTag() {
        keepDialog(JSONObject().put("kind", "tokens").put("list", "bulk").put("text", "").put("picked", JSONArray()))
        reload()
    }

    /** RN's Bulk Organize: an empty draft each time it opens (core completes it), read with the bar. */
    fun openOrganize() {
        keepDialog(JSONObject().put("kind", "organize").put("draft", JSONObject()))
        reload()
    }

    /** A Bulk Organize control's edit (core's own, or typed text's setText): applied by core to the draft as it is when it runs. */
    fun organizeEdit(edit: JSONObject) {
        // Apply's "choose a person" line shows until the status or the person changes.
        if (edit.optString("type") == "setStatus" || edit.optString("field") == "delegateWho") dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("validation") }) }
        reload(bulkEdit = JSONObject().put("organizeEdit", edit))
    }

    private var organizeTyped = 0

    /** Typed Bulk Organize text (a person, contexts, tags, a date): kept with the dialog as typed, then core's setText once typing pauses. */
    fun organizeType(field: String, text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("typed:$field", text)) }
        val mine = ++organizeTyped
        main.postDelayed({ if (mine == organizeTyped) organizeEdit(JSONObject().put("type", "setText").put("field", field).put("value", text)) }, 200)
    }

    /** A picked or quick date replaces the date field's typed text with core's value. */
    fun organizeDate(field: String, edit: JSONObject) {
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("typed:$field"); remove("datePicker") }) }
        organizeEdit(edit)
    }

    /** Bulk Organize's project or area picker ([kind]; null closes it), its search as typed. */
    fun organizePicker(kind: String?) {
        dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("query"); remove("createFailed"); if (kind == null) remove("picker") else put("picker", kind) }) }
        if (kind != null) reload()
    }

    fun organizeQuery(text: String) {
        dialog?.let { keepDialog(JSONObject(it.toString()).put("query", text).apply { remove("createFailed") }) }
        val mine = ++organizeTyped
        main.postDelayed({ if (mine == organizeTyped) reload() }, 200)
    }

    /**
     * The picker's "+ Create" row (core's `create.name`): core's createBulkOrganizeDestination with the draft and a new request UUID
     * (the new project's or area's id), on disk before the call. While its retry is owed, the row sends that exact request again.
     */
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

    /** The picker's search box Done (RN's onSubmitEditing): the text as typed is read first, then core's `submit` runs: its match, or its create. */
    fun organizeSubmit() {
        ++organizeTyped
        reload()
        whenIdle {
            val submit = page?.bulk?.optJSONObject("picker")?.optJSONObject("submit") ?: return@whenIdle
            submit.optJSONObject("edit")?.let { edit -> organizePicker(null); organizeEdit(edit) } ?: submit.menuText("create")?.let(::organizeCreate)
        }
    }

    /**
     * RN's Apply: typed text still waiting for core goes first; then, while core says Apply cannot run (Waiting without a person),
     * core's line shows; else core's organize with the draft core answered.
     */
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
            // Review's Apply is its own organizeTasks on its selection, with the revisions its bar showed.
            val review = page?.bulk?.takeIf { list == "review" }
            if (!organize.getBoolean("canApply")) dialog?.let { keepDialog(JSONObject(it.toString()).put("validation", true)) }
            else if (review != null) { bulkBusy = "organize"; act("reviewAction", organizeTasks(review.getJSONArray("selectedIds").ids(), organize.getJSONObject("draft"), review.getJSONObject("taskRevisions"))) }
            else bulkAction(JSONObject().put("type", "organize").put("draft", organize.getJSONObject("draft")), "organize")
        }
    }

    /**
     * Core's answer to a bulk action: its dialog closes; one that changed something leaves selection mode (RN's exitSelectionMode);
     * core's toast shows with its Undo (the same list's restoreTasks, a new request UUID).
     */
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

    // ---- Commands ----

    /** The Menu tab's owed command, from the failure banner's Try again: the same exact request. */
    fun retry(action: FailedAction) = send(action)

    /** A menu command's input, as host-entry.ts passes it to core. */
    private fun input(action: FailedAction): String = when (action.kind) {
        "activateProject" -> JSONObject().put("projectId", action.id).put("projectRevision", action.patch["projectRevision"])
        "somedayMove" -> JSONObject().put("taskIds", JSONArray(action.patch["taskIds"].orEmpty().split(","))).put("requestId", action.id)
            .put("sectionId", action.patch["sectionId"] ?: JSONObject.NULL).put("taskRevisions", JSONObject(action.patch["taskRevisions"] ?: "{}"))
        "somedayUndo" -> JSONObject().put("moveRequestId", action.title).put("requestId", action.id)
        "somedayTask" -> JSONObject().put("title", action.title).put("captureId", action.id).put("sectionId", action.patch["sectionId"] ?: JSONObject.NULL)
        "somedaySection" -> JSONObject().put("title", action.title).put("requestId", action.id)
        "taskListSort" -> JSONObject().put("sortBy", action.id)
        // The Calendar's and the Board's input: core's action with the view's state (or filters), and the request UUID.
        "calendarAction", "calendarCreate", "boardAction", "boardCreate" -> JSONObject(action.title).put("requestId", action.id)
        // A bulk action (its list and core's action) and Focus's commands (the control state and the command's own input).
        "bulkAction", "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> JSONObject(action.title).put("requestId", action.id)
        // Bulk organize's create, Mind Sweep's Add and a saved search's Delete: core's whole input and the request UUID.
        "bulkCreate", "mindSweepAdd", "savedSearchDelete" -> JSONObject(action.title).put("requestId", action.id)
        // Settings: core's whole input and the request UUID; Manage's Someday section writes are target-state and take none.
        "generalSetting", "gtdSetting", "manageEditor", "manageDelete", "dataSetting", "syncPreference", "setAISetting", "calendarSetting" -> JSONObject(action.title).put("requestId", action.id)
        // Settings › Notifications' edit, as core gave it.
        "notificationsSetting" -> JSONObject(action.title).put("requestId", action.id)
        "somedayRename", "somedayReorder", "somedayDelete" -> JSONObject(action.title)
        else -> JSONObject().put("requestId", action.id).put("action", JSONObject(action.title))
    }.toString()

    /**
     * Core's command with [action]'s exact request, through perform: one at a time, a failure holds the exact retry (a
     * Someday create's request stays on disk), and core's refusal before writing unlocks (its record goes too).
     */
    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val reply = try {
            runtime.menuCommand(action.kind, input(action))
        } catch (failure: Exception) {
            val refused = UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }
                || (action.kind in LANDLESS && failure.message?.startsWith("ACTION_FAILED") == true)
            if (refused && action.kind in CREATES) shell.ui { store.delete() }
            // A refused composer Save wrote nothing: the composer's next Save gets a fresh request UUID.
            if (refused && action.kind == "calendarCreate") shell.ui { calendar.refused(action) }
            // A refused saved filter wrote nothing either: the next Save gets a fresh one.
            if (refused && action.kind == "focusSave") shell.ui { focusControls.refused(action) }
            // A refused Settings write wrote nothing: a GTD time core cannot read is RN's warning toast, not an error.
            // Settings › Calendar's: a stale view reads again, and ACTION_FAILED (the device refused, or no calendar push yet) wrote nothing.
            if (refused && action.kind in SETTINGS_KINDS) { shell.ui { settings.refused(action, failure) }; if (action.kind == "gtdSetting") return@perform
                if (action.kind == "calendarSetting") { shell.acknowledged(action); return@perform } }
            // Review's compare-and-set writes refused as stale wrote nothing: core's view is read again (never resent), with its new revisions.
            if (refused && action.kind == "reviewAction" && failure.message?.startsWith("STALE_REVISION") == true) shell.ui { bulkBusy = null; whenIdle { reload() } }
            // An Undo core can no longer run wrote nothing: RN's undo-failed toast (core's text), not an error.
            if (refused && action.kind == "somedayUndo") {
                Log.w(CoreHost.TAG, "Someday Undo refused: ${failure.message?.substringBefore(':')}")
                shell.ui { undoFailed() }; return@perform
            }
            // A Mind Sweep Add or a Bulk organize create that wrote nothing shows RN's own line, not the failure message; nothing is
            // owed (an owed retry that now wrote nothing is settled too).
            if (refused && action.kind in LANDLESS) {
                shell.acknowledged(action)
                shell.ui { landless(action) }
                return@perform
            }
            // A General write core applied but could not save (SAVE_FAILED): App lock's gate follows core's value; the retry stays owed.
            if (!refused && action.kind == "generalSetting") settings.unsettled(runtime, action)
            throw failure
        }
        // A setting's device-local part (core's deviceWrites) is stored before the command counts as done; a language or theme reloads.
        if (action.kind in SETTINGS_KINDS) settings.applied(runtime, reply)
        shell.acknowledged(action)
        shell.ui {
            if (action.kind in CREATES) store.delete()
            finish(action, reply)
        }
    }

    private fun undoFailed() {
        val text = page?.view?.optJSONObject("text") ?: return
        shell.showToast(text.getString("errorTitle"), text.getString("undoFailed"), "error")
    }

    private fun JSONObject.text(name: String) = if (!has(name) || isNull(name)) null else getString(name)

    /** Core's answer on screen: a refusal's words, the dialog closing, and RN's toasts with core's Undo. */
    private fun finish(action: FailedAction, reply: JSONObject) {
        when (action.kind) {
            "somedayMove" -> {
                val refused = reply.optJSONObject("refused")
                if (refused != null) { shell.showToast(refused, tone = "error"); return }
                closeDialog("move")
                // A move from the bulk bar leaves selection mode, as RN's does.
                if (own("someday").has("bulk")) endBulk("someday")
                reply.optJSONObject("toast")?.let { toast ->
                    val moveRequestId = reply.getString("undoRequestId")
                    shell.showToast(toast, toast.getString("undoLabel"), "success") { undo(moveRequestId) }
                }
            }
            "somedayTask" -> {
                val refused = reply.optJSONObject("refused")
                // Core's refusal (the section is gone) wrote nothing: its words show, and the next Save gets a fresh capture UUID.
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
                // From the move dialog's "+ New section…": the tasks go into the new section, as RN's picker selects it.
                open?.optJSONArray("taskIds")?.let { ids -> whenIdle { move(ids.strings(), reply.getString("id"), open.optJSONObject("taskRevisions") ?: JSONObject()) } }
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
            "focusGroup", "focusSave", "focusCriterion", "focusDelete", "focusReorder" -> focusControls.done(action, reply)
            in SETTINGS_KINDS -> settings.done(action, reply)
            // Bulk organize's new project or area: the draft core answered (it chosen), and the dialog again.
            "bulkCreate" -> dialog?.takeIf { it.optString("kind") == "organize" }?.let { open ->
                keepDialog(JSONObject(open.toString()).put("draft", reply.getJSONObject("draft")).apply { remove("picker"); remove("query"); remove("creating"); remove("createFailed") })
            }
            "mindSweepAdd" -> sweep.added(action, reply)
            // RN goes back after its Delete (to the screen before, or the tabs).
            "savedSearchDelete" -> if (screen == MenuScreen.SavedSearch && own("savedSearch").optString("id") == JSONObject(action.title).getString("id")) closeScreen()
        }
    }

    /** A LANDLESS command that wrote nothing: Mind Sweep's failure line or the picker's line. */
    private fun landless(action: FailedAction) {
        when (action.kind) {
            "mindSweepAdd" -> sweep.refused(action)
            else -> dialog?.takeIf { it.optString("kind") == "organize" }?.let { keepDialog(JSONObject(it.toString()).put("createFailed", true).apply { remove("creating") }) }
        }
    }

    /**
     * Core's answer to a Contexts, Trash or Review action: a bulk action leaves selection mode (RN's exitSelectionMode), a
     * project Add task closes its prompt (Save & edit opens the new task), Mark reviewed shows RN's toast, and core's toast
     * shows with its Undo (the same list's command, a new request UUID).
     */
    private fun listDone(action: FailedAction, reply: JSONObject) {
        val type = JSONObject(action.title).optString("type")
        if (action.kind == "reviewTask") {
            val open = dialog?.takeIf { it.optString("kind") == "projectTask" }
            closeDialog("projectTask")
            reply.text("createdId")?.takeIf { open?.optBoolean("edit") == true }?.let { id -> whenIdle { shell.openEditor(id, "task") } }
        }
        if (type in BULK) endSelection()
        // Review's Organize: its dialog closes once core answers, as RN's onApply closes it.
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

    /** RN's exitSelectionMode on the open list. */
    internal fun endSelection() {
        when (val list = list ?: return) {
            "trash" -> editOwn(list) { put("selecting", false).put("selectedTasks", JSONArray()).put("selectedProjects", JSONArray()) }
            "archive" -> selecting(false)
            else -> editOwn(list) { put("selected", JSONArray()) }
        }
    }

    /**
     * After boot: a create left on disk by a dead process is sent again first (core writes it once: a capture UUID, a section
     * title that already exists, or a project task under its request UUID), even without saved state; then the open sheet and
     * screen are read. [sheet] is core's More sheet read at boot (the quick-access tab).
     */
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
