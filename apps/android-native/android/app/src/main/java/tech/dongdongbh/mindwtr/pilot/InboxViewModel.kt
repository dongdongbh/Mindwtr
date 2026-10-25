package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.dropWhile
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * One item of core's row meta line (TaskRowMetaPart), as core sent it: [text] is shown as is.
 * [dotColor] is core's area color (null: the tint), [tone] a due date's urgency, [overflow]
 * a context's or tag's "+N", [done]/[of] the checklist count, [spoken] core's TalkBack text.
 */
data class MetaPart(
    val kind: String, val text: String, val detail: Boolean, val dotColor: String? = null, val tone: String? = null,
    val overflow: Int = 0, val done: Int = 0, val of: Int = 0, val spoken: String? = null,
)
/** Core's swipe action for a row (RN's getLeftAction): the status it sets, its label, and its icon (restore, done, next). */
data class RowSwipe(val target: String, val label: String, val icon: String)
/** Core's TaskRowMeta: the meta line in order, the priority strip, the status label, the star rule, the swipe, and TalkBack's label. */
data class RowMeta(
    val parts: List<MetaPart>, val priority: String?, val statusLabel: String?, val canFocus: Boolean,
    val swipe: RowSwipe, val rtl: Boolean, val accessibilityLabel: String, val hasDescription: Boolean = false,
)
/**
 * One task row as core sent it (NativeTaskRow). Kotlin never parses or formats a date:
 * the meta line is core's text. [revealLabel] (Upcoming, in the user's date format) and [laterToday] are core's.
 * [taskRevision] is core's revision of the task as the view showed it: a command that writes this task sends it.
 */
data class TaskRow(
    val id: String,
    val title: String,
    val status: String,
    val isFocusedToday: Boolean,
    val meta: RowMeta,
    val revealLabel: String? = null,
    val laterToday: Boolean = false,
    val taskRevision: String = "",
)
/** The three lists. [label] is the core key of the tab label mobile shows. */
enum class Screen(val label: String) { Inbox("tab.inbox"), Focus("tab.next"), Projects("nav.projects") }
/**
 * A command whose outcome is unknown; only this exact command may run again. [requestId] is the request UUID of an update and an
 * editor save (the other commands keep theirs in [id] or [title]); [attachments] is an editor save's attachments half ("" for none).
 */
data class FailedAction(
    val kind: String,
    val id: String,
    val title: String = "",
    val base: Map<String, String?> = emptyMap(),
    val patch: Map<String, String?> = emptyMap(),
    val requestId: String = "",
    val attachments: String = "",
)

/** [action] with a new request UUID, or the owed request [owed] when it is that same command: its control sends it again. */
private fun withRequestId(action: FailedAction, owed: FailedAction?) =
    owed?.takeIf { it.copy(requestId = "") == action } ?: action.copy(requestId = UUID.randomUUID().toString())

/** Core refused the update or the editor save before writing anything, so there is no retry to hold. */
/** The Menu list that shows each external calendar slot (host-calendar.ts, core's NATIVE_CALENDAR_FEED_SLOTS). */
private val FEED_LISTS = mapOf("calendar" to "calendar", "weeklyReview" to "weekly", "dailyReview" to "daily")
internal val UPDATE_REFUSALS = listOf("STALE_REVISION", "INVALID_INPUT", "TASK_NOT_FOUND")
/**
 * The commands whose STALE_REVISION keeps core's line on screen: the editor save's conflict (with Reload), the status menu's update, and
 * the saves of a draft that stays open (the Calendar composer, Manage's editor), so a Save that wrote nothing never looks done.
 */
private val STALE_SHOWN = setOf("saveDraft", "update", "calendarCreate", "manageEditor", "completeUndo", "inboxDecisionUndo")
/** Commands core can refuse before writing: an update, an editor save, a saved search, a Process Inbox answer, and the Menu tab's commands. */
private val REFUSABLE = setOf("update", "saveDraft", "resetChecklist", "saveSearch", "inboxCommit", "inboxSkip", "capture", "captureLines", "capturePicker") + MENU_KINDS + CAPTURE_MODAL_KINDS + ATTACHMENT_KINDS + PROJECT_DETAIL_KINDS

private fun JSONObject.metaPart(): MetaPart = MetaPart(
    getString("kind"), getString("text"), getBoolean("detail"), text("dotColor"), text("tone"),
    optInt("overflowCount"), optInt("completed"), optInt("total"), text("accessibilityLabel"),
)

private fun JSONObject.text(name: String) = if (!has(name) || isNull(name)) null else getString(name)

/** How long a toast shows: core's `durationMs` when it names one (RN's toast-context), else RN's 3.2 s, or 5.2 s with an action. */
fun toastDurationMs(toast: JSONObject?, action: String?): Long =
    toast?.takeIf { it.has("durationMs") && !it.isNull("durationMs") }?.getLong("durationMs") ?: if (action != null) 5_200 else 3_200

/** A field map as JSON. Null stays JSON null: `JSONObject.put(name, null)` would drop the name. */
fun json(values: Map<String, String?>): String =
    JSONObject().apply { values.forEach { (name, value) -> put(name, value ?: JSONObject.NULL) } }.toString()

/** One NativeTaskRow as core sent it. */
fun JSONObject.taskRow() = getJSONObject("meta").let { meta ->
    TaskRow(getString("id"), getString("title"), getString("status"), getBoolean("isFocusedToday"),
        RowMeta(meta.getJSONArray("parts").let { parts -> List(parts.length()) { parts.getJSONObject(it).metaPart() } },
            meta.text("priority"), meta.text("statusLabel"), meta.getBoolean("canFocus"),
            meta.getJSONObject("swipe").let { RowSwipe(it.getString("target"), it.getString("label"), it.getString("icon")) },
            meta.getString("textDirection") == "rtl", meta.getString("accessibilityLabel"),
            !meta.text("descriptionPreview").isNullOrEmpty()),
        text("revealLabel"), getBoolean("laterToday"), optString("taskRevision"))
}

/** Core's `rows` array, in its order. */
fun JSONObject.taskRows(): List<TaskRow> = getJSONArray("rows").let { items ->
    List(items.length()) { index -> items.getJSONObject(index).taskRow() }
}

/**
 * The open editor's draft on disk, in the app's no-backup folder: the task id, the edits with their
 * bases, the typed text, and an uncertain save's exact request. Saved instance state holds only the
 * file's key, so a large model or a long note never reaches the Bundle limit. Each write is synced and
 * renamed into place, so an uncertain save's request is durable before the call starts.
 */
private class EditorDrafts(private val dir: File) {
    private fun file(key: String) = File(dir, "editor-$key.json")
    fun read(key: String): JSONObject? = runCatching { JSONObject(file(key).readText()) }.getOrNull()
    fun write(key: String, state: JSONObject) {
        dir.mkdirs()
        val partial = File(dir, "editor-$key.json.partial")
        FileOutputStream(partial).use { out -> out.write(state.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(file(key))) { "Cannot save the editor draft" }
    }
    fun delete(key: String) { file(key).delete() }
    /** Drafts of editors this screen no longer has (a force-stop discarded their key). */
    fun deleteExcept(key: String?) { dir.listFiles()?.forEach { if (it.name != "editor-$key.json") it.delete() } }
}

private const val PAGE = 50
/** The typed-input name of the relative start's lead time. */
const val RELATIVE_AMOUNT = "relativeAmount"
/** The suggestions of RN's waiting prompt (people, like the Assigned To field). */
const val WAITING_PROMPT = "waitingFor"
/** RN's editor shows 4 matches (MAX_VISIBLE_SUGGESTIONS). */
private const val SUGGESTIONS = 4
/** The boot's sync start waits at most this long after the boot for the Inbox's first rows (ProcessCoreHost.startDeferredSync). */
private const val SYNC_FALLBACK_MS = 3_000L
/** The start screen waits at most this long for the first screen (InboxViewModel.holdSplash), then lets a slow start show. */
private const val SPLASH_CAP_MS = 10_000L
/** Core windows the View tab's checklist by NATIVE_HOST_MAX_WINDOW. */
private const val VIEW_WINDOW = 100

/** The editor after one control's edit: core's model with its checklist field, the checklist a checklist edit made, and the item to focus. */
private class Stepped(val view: EditorModel, val checklist: String?, val focusId: String?)

/** How deep each list is shown, so a refresh reads it again as deep; [controls] is Focus's control state (FocusModel) as JSON. */
private data class Depth(val focus: Map<String, Int>, val project: String?, val projectItems: Int, val controls: String)
/**
 * The lists one full read gives; the Inbox tab is MenuModel's list on core's getInboxView, read with the open Menu list. The
 * boot's read leaves Focus, and Projects with the open project, null when their tab is not on screen (read later).
 */
private class Lists(val focus: FocusView?, val projects: ProjectsView?, val projectId: String?, val project: ProjectDetail?, val areas: AreaFilter)

/**
 * Inbox, Focus, Projects, and editor screen state. It survives Activity recreation,
 * so a command that ends after rotation updates the new screen. The selected list,
 * the open project, the capture draft, and the editor draft survive process death;
 * rows reload from core. It never closes the process host.
 */
class InboxViewModel(app: Application, private val saved: SavedStateHandle) : AndroidViewModel(app) {
    var loading by mutableStateOf(true); private set
    /** The start was still not ready [SPLASH_CAP_MS] after it began: the start screen is gone and the loading screen shows RN's spinner. */
    var slowStart by mutableStateOf(false); private set
    var writable by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    /**
     * RN's capture popup, open with its draft: the typed text, core's options and view, the open picker, and an answer's
     * exact request. It is on disk (see [CaptureStore]); the Bundle holds only whether it is open.
     */
    var capture by mutableStateOf<CaptureDraft?>(null); private set
    var failedAction by mutableStateOf<FailedAction?>(null); private set
    /**
     * Debug builds only: `debug.mindwtr.native.start_tab` = `inbox` starts on the Inbox with no last-screen restore, the start
     * the device checks were written for (device.mjs launch sets it; the session check clears it).
     */
    private val harnessStart = debugProperty("start_tab")
    // RN opens Focus on a fresh start (its home tab); a recent last screen reopens instead (keepLastRoute, openRestored).
    var screen by mutableStateOf(Screen.entries.firstOrNull { it.name == saved.get<String>("screen") }
        ?: if (harnessStart == "inbox") Screen.Inbox else Screen.Focus); private set
    var focus by mutableStateOf<FocusView?>(null); private set
    var projects by mutableStateOf<ProjectsView?>(null); private set
    /** The project whose detail shows on the Projects tab; its rows reload from core after process death. */
    var openProjectId by mutableStateOf(saved.get<String>("project")); private set
    var project by mutableStateOf<ProjectDetail?>(null); private set
    private val prefs = app.getSharedPreferences(DEVICE_PREFS, android.content.Context.MODE_PRIVATE)
    /** Focus sections shown open, device-local as RN keeps them (every section starts open). */
    var focusView by mutableStateOf(FocusViewState.read(prefs)); private set
    /** Collapsed area groups and the open Someday / Waiting and Closed groups, device-local as RN keeps them. */
    var projectsView by mutableStateOf(ProjectsViewState.read(prefs)); private set
    /** RN's project Show completed (the view options): device-wide, in RN's own key and text, as RN keeps it (#1030). */
    var projectShowCompleted by mutableStateOf(prefs.getString(PROJECT_SHOW_COMPLETED_KEY, null) == "true"); private set
    /** RN's Completed pile under a project's open tasks: folded again each time another project opens (TaskList). */
    var projectCompletedCollapsed by mutableStateOf(true); private set
    /** Core's area filter: the header trigger's label and the sheet's options. */
    var areaFilter by mutableStateOf<AreaFilter?>(null); private set
    /** RN's area sheet is open. */
    var areaSheet by mutableStateOf(false); private set
    /** The row whose status menu is open (RN's SwipeableTaskItemStatusMenu). */
    var statusMenu by mutableStateOf<TaskRow?>(null); private set
    /** RN's toast: an optional title, a message, and its tone, shown for core's time or RN's 3.2 s (toastDurationMs). */
    var toast by mutableStateOf<Toast?>(null); private set
    /** The "Add new project…" draft, its area ("" = no area), and its request UUID; all survive process death. */
    var projectDraft by mutableStateOf(saved.get<String>("projectDraft") ?: ""); private set
    var projectAreaId by mutableStateOf(saved.get<String>("projectAreaId")); private set
    var projectRequestId by mutableStateOf(saved.get<String>("projectRequestId") ?: UUID.randomUUID().toString()); private set
    /**
     * The open editor, if any. After process death it comes back once core has booted: the model is
     * read again from core and the saved edits go on top with their own bases (see [EditorDrafts]).
     */
    var editor by mutableStateOf<TaskEditor?>(null); private set
    private val drafts = EditorDrafts(File(app.noBackupFilesDir, "editor"))
    /** The key of the open editor's draft file; the only editor state in the Bundle. */
    private var editorKey: String? = saved.get<String>("editorKey")
    /** An editor save whose outcome is unknown: its exact request, on disk before the call, until core answers. */
    private var pendingSave: FailedAction? = null
    /** Save was pressed while typed text waited for core's draft value; it runs once that arrives. */
    private var saveQueued = false
    /** Core's suggestions for each typed editor field, for the text they were read for. Read again after a restore. */
    var suggestions by mutableStateOf<Map<String, EditorSuggestions>>(emptyMap()); private set
    /** The last save was refused as stale; the screen offers Reload. */
    var conflict by mutableStateOf(false); private set
    /** Core's View tab (getTaskView) for the open editor's draft and checklist, its checklist read [taskViewDepth] items deep. */
    var taskView by mutableStateOf<JSONObject?>(null); private set
    private var taskViewDepth = VIEW_WINDOW
    /** The new empty checklist item core named to focus (editTaskChecklist's focusId). */
    var checklistFocus by mutableStateOf<String?>(null); private set
    /** The open global search (RN's global-search route): its query, filters, and save dialog; small, so it rides the Bundle. */
    var search by mutableStateOf(saved.get<String>("search")?.let(SearchState::restore)); private set
    /** Core's searchTasks reply for the query on screen. */
    var searchView by mutableStateOf<SearchView?>(null); private set
    /** RN's highlightTaskId: a task opened from search, outlined on the list it opened on ([highlightList]) until RN's 3.5 s pass. */
    var highlightTaskId by mutableStateOf<String?>(null); private set
    private var highlightList by mutableStateOf<String?>(null)
    private var highlightJob: Job? = null
    /** Process Inbox on screen: core's session and step view, and an answer's exact request (see [ProcessingStore]). */
    var processing by mutableStateOf<InboxProcessing?>(null); private set
    private val processingStore = ProcessingStore(File(app.noBackupFilesDir, "process-inbox"))
    private val captureStore = CaptureStore(File(app.noBackupFilesDir, "capture"))
    private val snapshots = File(app.filesDir, "snapshots")
    /** RN's per-device Process Inbox mode (guided or quick), under RN's key. */
    var processingMode by mutableStateOf(readProcessingMode(prefs)); private set
    /** RN's Menu tab: the More sheet and the list screens it opens (MenuModel.kt), on this screen's command path. */
    val menu = MenuModel(this, saved, prefs, File(app.noBackupFilesDir, "menu"))
    /** RN's app lock (AppLock.kt): core's stored value and the gate's state. */
    val lock = AppLock(this)
    /** RN's capture confirmation screen that links, shares and assistant notes open (CaptureModalModel.kt). */
    val captureModal = CaptureModalModel(this, saved, File(app.noBackupFilesDir, "capture-modal"))
    /** RN's startup prompts (the welcome sheet, the announcement, the update reminder, the donation ask), after the boot. */
    val prompts = StartupPromptsModel(this)
    /** RN's AI actions: the editor's copilot, Clarify and Break down, Process Inbox's Clarify, the review's analysis (AIActions.kt). */
    val ai = AIActionsModel(this)
    /** The editor's and the project screen's attachments (Attachments.kt): rows, pickers, links, downloads, opening. */
    val attachments = AttachmentsModel(this)
    /** The open project's Details (ProjectDetails.kt): its pickers and core's prepared commits. */
    val projectDetails = ProjectDetailsModel(this)
    /** The Focus screen's Pomodoro card (Pomodoro.kt, pass R2b): core's durable session, its transitions and its alarms. */
    val pomodoro = PomodoroModel(this)
    /** A link, share or assistant note waiting to open (EntryPoints.kt). */
    // A file share's files are staged in the cache, where core's file port reads them (HostFiles), as RN's share module copies them.
    val entries = EntryRouter(this, File(app.noBackupFilesDir, "entries"), SharedFileStager(File(app.cacheDir, "shared-entries"), ContentSharedFileSource(app)))
    /** A system capture's screen closed: MainActivity puts the app behind the previous one, as RN's returnToPreviousApp (#1169). */
    var leaveApp by mutableStateOf(false); internal set
    @Volatile private var host: CoreHost? = null
    private var attaches = 0
    private val main = Handler(Looper.getMainLooper())
    private val started = SystemClock.uptimeMillis()

    /** The booted host, for work that takes no lock (Settings › Sync's commands); null before the boot ends. */
    internal fun coreHost(): CoreHost? = host

    /** The sync badge (RN's useMobileSyncBadge, core's state): the Menu tab's dot and the Settings row's badge. */
    data class SyncBadge(val state: String, val color: String?)
    var syncBadge by mutableStateOf(badgeOf(ProcessCoreHost.syncState)); private set
    /** A sync is running now (core's activity state, not a pending write): Settings › Data's rows wait for it, as RN's do. */
    var syncActive by mutableStateOf(ProcessCoreHost.syncState?.optBoolean("active") == true); private set
    private var syncCycles = ProcessCoreHost.syncState?.optInt("cycles") ?: 0
    /** The JS host's events arrive on the engine thread; each is handed to the main thread. */
    private val syncListener: (JSONObject) -> Unit = { event -> ui { syncEvent(event) } }

    private fun badgeOf(event: JSONObject?) = SyncBadge(event?.optString("badge")?.ifEmpty { null } ?: "hidden", event?.takeUnless { it.isNull("color") }?.optString("color"))

    /**
     * A sync event: a new badge; a finished cycle (a sync can change what every list shows, as RN's store updates do), so the
     * lists and the open screen are read again; an automatic sync's warning, with Open for Settings › Sync.
     */
    private fun syncEvent(event: JSONObject) {
        when (event.optString("type")) {
            "sync" -> {
                syncBadge = badgeOf(event)
                syncActive = event.optBoolean("active")
                val cycles = event.optInt("cycles")
                if (cycles != syncCycles) {
                    syncCycles = cycles
                    // A read refused while a user action runs would leave the lists stale until the next resume: wait for idle.
                    menu.whenIdle { if (writable) refreshAll(synced = true) }
                } else if (menu.list == "settings") menu.settings.refresh()
            }
            // A screen's external calendars finished loading (host-calendar.ts): the screen showing them reads again.
            "calendarFeed" -> if (menu.list == FEED_LISTS[event.optString("slot")]) menu.whenIdle { if (writable) menu.refresh() }
            "toast" -> showToast(event, event.optString("action").ifEmpty { null }) { if (event.optString("open") == "sync") menu.openSyncSettings() }
        }
    }

    /** Each resume (MainActivity), for screens that read a system state again then (the exact-alarm notice). */
    var resumes by mutableIntStateOf(0); private set

    /** RN's AppState for core's sync triggers and the reminder alarms: "active" on resume, "background" on leaving (MainActivity). */
    fun appState(state: String) {
        if (state == "active") resumes += 1
        // RN stores the last screen again on leaving, so its time is the moment the app was left.
        if (state == "background") keepLastRoute(force = true)
        ProcessCoreHost.appState(state)
        // A return settles a phase that ended while away, then plans the alerts (never the other way: design R2b §3b K5).
        if (state == "active") pomodoro.refresh(planAlarms = true)
        // RN's Calendar reloads its external calendars on a return to the app (shouldRefreshExternalCalendarOnAppStateChange).
        if (state == "active" && resumes > 1 && menu.list == "calendar") menu.calendarFeed("calendar")
    }

    /** Where the editor returns: a tab; the quick-access Calendar regains focus (RN's focus reload). */
    private fun focused(target: Screen) {
        if (target == Screen.Projects && menu.screen == null && menu.quickView == "calendar") menu.calendarFeed("calendar")
    }

    /**
     * Whether to ask for the notification permission now, as RN asks at start (once per process; ProcessCoreHost.askNotifications),
     * once the reminder alarms started: they start with sync, after the first screen's content.
     */
    suspend fun askNotifications(): Boolean {
        ProcessCoreHost.remindersStarted.await()
        return ProcessCoreHost.askNotifications()
    }

    override fun onCleared() {
        ProcessCoreHost.unlistenSync(syncListener)
        entries.close()
        routeWrites.shutdown()
        prompts.shutdown()
        super.onCleared()
    }

    /**
     * A cold start: no saved state at all (the "started" mark, set below, comes back with any saved state, also when the user
     * never left the default tab), so a process the system killed comes back from its own saved state, never a restore.
     */
    private val freshStart = saved.get<Boolean>("started") != true
    /** The last screen was read and opened (or there was none): from now on every screen change is stored. */
    private var routeReady = false
    private var keptRoute: String? = null
    /** Stores run one at a time, in order (two quick changes never land reversed). */
    private val routeWrites = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "mindwtr-last-route") }
    /** Debug builds: `debug.mindwtr.native.session_age_ms`, read once (a device check ages the stored screens out). */
    private val routeAgeMs by lazy { if (BuildConfig.DEBUG) debugProperty("session_age_ms").toLongOrNull() ?: 0L else 0L }

    init {
        saved["started"] = true
        ProcessCoreHost.listenSync(syncListener)
        saved["projectRequestId"] = projectRequestId
        val at = depth()
        val savedDraft = editorKey?.let(drafts::read)
        drafts.deleteExcept(if (savedDraft != null) editorKey else null)
        if (savedDraft == null) keepKey(null)
        // Process Inbox left open at process death (the Bundle says so), or owed by a failure in this process.
        val storedProcessing = processingStore.read()
        val reopenProcessing = storedProcessing?.takeIf { saved.get<Boolean>("processing") == true }
        // The capture popup left open at process death, or owed by a failure in this process. A request whose outcome
        // was never answered comes back even without saved state (a force-stop or a crash): the captured text is user data.
        val storedCapture = captureStore.read()
        val reopenCapture = storedCapture?.takeIf { saved.get<Boolean>("capturing") == true || it.pending != null }
        // A start that is still not ready lets the start screen go ([holdSplash]); a booted host logs it now, a boot when it ends.
        main.postDelayed({ if (holdSplash()) { slowStart = true; host?.let { logSlowStart(it, "read") } } }, SPLASH_CAP_MS)
        Thread({
            try {
                // A device check's slow boot (debug builds only).
                debugProperty("boot_delay_ms").toLongOrNull()?.let(Thread::sleep)
                val runtime = ProcessCoreHost.get(getApplication(), prefs.getString(LANGUAGE_KEY, null))
                // The language and theme chosen in this app's Settings (RN's device keys) win over the ones found at boot.
                applyDeviceChoices(runtime, prefs)
                applySyncedChoices(runtime, prefs)
                // RN's app lock, before any screen shows data (an owed save does not block it).
                lock.boot(runtime)
                ProcessCoreHost.failure?.let { pending -> ui { host = runtime; restore(pending, storedProcessing, storedCapture); keepRoutes() }; return@Thread }
                // RN's last screen (#842): only on a start with no screen of its own (no saved state) and no entry to open.
                val lastRoute = if (freshStart && harnessStart.isEmpty() && entries.head == null) runCatching { runtime.sessionRestoreRead().optJSONObject("route") }
                    .onFailure { Log.w(CoreHost.TAG, "Last screen not read ${failureForLog(it)}") }.getOrNull() else null
                // Only the tab on screen: Focus and Projects are read once first content is drawn ([contentShown]) or their tab opens.
                val lists = try {
                    read(runtime, at, screen)
                } catch (failure: Throwable) {
                    // A save that failed while this screen opened blocks reads; show its retry.
                    ProcessCoreHost.failure?.let { pending -> ui { host = runtime; restore(pending, storedProcessing, storedCapture); keepRoutes() }; return@Thread }
                    throw failure
                }
                // RN's More sheet, for the quick-access tab the tab bar draws from its first frame (cosmetic: a failure shows Projects).
                val sheet = runCatching { menu.readSheet(runtime) }.getOrNull()
                // The editor open at process death: core's model read again, the saved draft on top.
                val restored = savedDraft?.let { draft ->
                    runCatching { withView(runtime, TaskEditor.restore(readEditor(runtime, draft.getString("id")), draft)) }
                        .onFailure { Log.w(CoreHost.TAG, "Editor draft not restored ${failureForLog(it)}") }.getOrNull()
                }
                ui {
                    host = runtime; showLists(lists, ++issued); writable = true; loading = false
                    // A tab chosen while the boot ran, whose list the boot left for later (no Inbox draws, so [contentShown] never runs).
                    if (screen == Screen.Focus && lists.focus == null) refreshFocus()
                    if (screen == Screen.Projects && lists.projects == null) refreshProjects()
                    if (slowStart) logSlowStart(runtime, "boot")
                    // The boot's held sync start: now when the boot read was this screen's content (not the Inbox, whose first rows
                    // report it: contentShown); a fallback covers an Inbox read that never draws.
                    // The day's heartbeat (once per process), and RN's startup prompts: core records the first-paint prompt activity
                    // first, then answers the prompt to open (the activity has no second writer: review O2e P3-A).
                    ProcessCoreHost.aboutStartup(runtime)
                    prompts.start(runtime)
                    if (screen != Screen.Inbox) ProcessCoreHost.startDeferredSync()
                    main.postDelayed({ ProcessCoreHost.startDeferredSync("boot-timeout") }, SYNC_FALLBACK_MS)
                    restored?.let { resumeEditor(it, savedDraft.optJSONObject("pending")) }
                    // Control edits core had not answered before the process died are sent again, in order.
                    pumpEdits()
                    if (reopenProcessing != null) resumeProcessing(reopenProcessing) else processingStore.delete()
                    if (reopenCapture != null) resumeCapture(reopenCapture) else captureStore.delete()
                    // An owed create left on disk goes first; then the open sheet and screen are read.
                    menu.start(sheet)
                    captureModal.resume()
                    // An entry that arrived while the boot ran (a link on a warm process) wins over the last screen, as RN's does.
                    if (entries.head == null) lastRoute?.let { entries.openRestored(it.getString("pathname"), it.optJSONObject("params") ?: JSONObject()) }
                    keepRoutes()
                    // A restore, merge or import result a death after its commit left unshown, and an export cut short.
                    menu.settings.transfer.leftover()
                    search?.let { current ->
                        readSearch()
                        // A Save Search whose outcome was lost with the process: its exact request first, then the dialog unlocks.
                        current.submitted?.let { name -> if (failedAction == null) saveSearchAction(current, name).let { failedAction = it; sendSaveSearch(it) } }
                    }
                }
            } catch (failure: Throwable) {
                Log.e(CoreHost.TAG, "Core boot failed", failure)
                // No command can run, and core's labels may never have loaded: the screen shows only this message.
                ui {
                    error = failure.message ?: failure.javaClass.simpleName
                    loading = false
                }
            }
        }, "mindwtr-startup").start()
    }

    /**
     * MainActivity's start screen (RN's expo-splash-screen) stays while the boot runs and the open list's first rows are read, as
     * RN hides it once its first screen has data, so the app opens on that screen with no spinner. A failed boot or an owed retry
     * lets it go at once (its message shows), and a start still not ready after [SPLASH_CAP_MS] lets it go then ([slowStart]).
     */
    fun holdSplash(): Boolean {
        // Once let go it stays gone: a later list change or a recreated screen never brings it back.
        if (!splashGone) splashGone = slowStart || !(loading || writable && failedAction == null && error == null && menu.firstPagePending)
        return !splashGone
    }
    private var splashGone = false

    /** The start screen's cap ran out while [stage] ("boot" or "read") still ran: one diagnostics line through core, off the main thread. */
    private fun logSlowStart(runtime: CoreHost, stage: String) {
        val context = JSONObject().put("releaseCheck", "v1.3.5/native-splash-cap").put("stage", stage)
            .put("durationMs", SystemClock.uptimeMillis() - started)
        Thread({ runtime.logLine("Native Android start screen released by its cap releaseCheck=v1.3.5/native-splash-cap", context) }, "mindwtr-log").start()
    }

    /** Each Activity instance calls this once. A later call is a recreation on the running host. */
    fun attach() {
        attaches += 1
        if (attaches > 1) ProcessCoreHost.logHostReuse("activity-recreate", attaches, busy)
    }

    /** First content is on screen: the lists the boot left for later are read, and the host may do its deferred work (its bytecode cache). */
    fun contentShown() {
        if (focus == null) refreshFocus()
        if (projects == null) refreshProjects()
        ProcessCoreHost.contentShown()
    }

    /**
     * Stores the screen on show for RN's last-screen restore (SessionRestore.kt names it; core stores it, as RN's
     * persistLastRoute), when it changed or [force] (leaving the app). Debug builds: `debug.mindwtr.native.session_age_ms` dates
     * it that far back, so a device check ages it out without touching the phone's clock.
     */
    private fun currentRoute() = lastRouteOf(screen, menu.quickView, menu.screen, menu.historyTab, openProjectId,
        menu.own("savedSearch").optString("id").ifEmpty { null }, search != null, menu.sheet)
    private fun routeKey() = currentRoute()?.let { it.pathname + it.params }

    /** From now on the screen on show is stored: at once, then on each change. */
    private fun keepRoutes() {
        if (routeReady) return
        routeReady = true
        keepLastRoute(force = true)
        viewModelScope.launch { snapshotFlow { routeKey() }.collect { keepLastRoute() } }
    }

    private fun keepLastRoute(force: Boolean = false) {
        if (!routeReady) return
        val route = currentRoute() ?: return
        val key = route.pathname + route.params
        if (!force && key == keptRoute) return
        keptRoute = key
        val runtime = host ?: return
        val ageMs = routeAgeMs
        // A screen cleared before its boot ended (Back on the splash) stores nothing.
        if (routeWrites.isShutdown) return
        runCatching {
            routeWrites.execute {
                runCatching { runtime.sessionRestoreWrite(route.pathname, route.params.toString(), ageMs) }
                    .onFailure { Log.w(CoreHost.TAG, "Last screen not stored ${failureForLog(it)}") }
            }
        }
    }

    /**
     * First content of the screen on show is drawn (MainActivity's ReportDrawnWhen; RN hides its splash once its first screen has
     * data): the Inbox's rows, Focus's, the Projects tab's or quick view's, or a Menu screen's first page.
     */
    // `loading` first: a snapshot state, so Compose checks this again when the boot ends (`host` is a plain field).
    fun firstContentReady(): Boolean = !loading && host != null && when {
        menu.screen != null -> !menu.firstPagePending
        screen == Screen.Focus -> focus != null
        screen == Screen.Projects -> if (menu.quickView == "projects") projects != null else !menu.firstPagePending
        else -> !menu.firstPagePending
    }

    /** The editor opens over this list, so Save and Cancel return to it. */
    fun show(target: Screen) {
        val switched = target != screen
        screen = target
        saved["screen"] = target.name
        if (switched) focused(target)
    }

    private fun keepKey(key: String?) {
        editorKey = key
        saved["editorKey"] = key
    }

    /** Every editor change goes to its draft file (synced) before anything else; closing deletes the file. */
    private fun keepEditor(value: TaskEditor?) {
        editor = value
        if (value == null) {
            editorKey?.let(drafts::delete)
            keepKey(null)
            pendingSave = null
            return
        }
        val key = editorKey ?: UUID.randomUUID().toString().also(::keepKey)
        val state = value.state()
        pendingSave?.let {
            state.put("pending", JSONObject().put("base", JSONObject(it.base)).put("patch", JSONObject(it.patch)).put("checklist", it.title).put("requestId", it.requestId)
                .put("attachments", it.attachments))
        }
        drafts.write(key, state)
    }

    /**
     * The restored editor. An uncertain save left on disk is reconciled first: its exact request is
     * sent again (core writes nothing twice: a field already holding its new value is left alone),
     * and the draft stays locked to it until core answers.
     */
    private fun resumeEditor(restored: TaskEditor, pending: JSONObject?) {
        keepEditor(restored)
        if (pending == null || failedAction != null) return
        fun map(name: String) = pending.getJSONObject(name).let { m -> m.keys().asSequence().associateWith<String, String?> { m.getString(it) } }
        val action = FailedAction("saveDraft", restored.id, pending.optString("checklist"), base = map("base"), patch = map("patch"),
            requestId = pending.optString("requestId"), attachments = pending.optString("attachments"))
        failedAction = action
        sendDraft(action)
    }

    private fun restore(pending: ProcessCoreHost.PendingFailure, storedProcessing: InboxProcessing?, storedCapture: CaptureDraft?) {
        val action = pending.action
        // An owed capture reopens the popup on the same request, never re-sent here.
        if (action.kind in CAPTURE_KINDS) storedCapture?.let { keepCapture(it.copy(pending = action)) }
        if (action.kind in CAPTURE_MODAL_KINDS) captureModal.restored(action)
        // An owed saved search or Process Inbox answer reopens its screen on the same request.
        if (action.kind == "saveSearch") keepSearch(SearchState(action.title, saveName = action.patch["name"], saveRequestId = action.id, submitted = action.patch["name"]))
        if (action.kind in STEP_KINDS) storedProcessing?.let { keepProcessing(it.copy(pending = action)) }
        if (action.kind == "createProject") setProjectDraft(action.title, action.base["areaId"], action.id)
        areaFilter = pending.areas
        if (action.kind == "saveDraft") pendingSave = action
        pending.editor?.let(::keepEditor)
        // The open list (the Inbox tab's too) as it was: no read runs while the retry is owed.
        pending.menuPage?.let(menu::restorePage)
        focus = pending.focus
        projects = pending.projects
        keepProject(pending.project?.projectId)
        project = pending.project
        show(pending.screen)
        failedAction = action
        error = pending.error
        writable = true
        loading = false
        if (slowStart) host?.let { logSlowStart(it, "boot") }
    }

    /** Done's exact request: the task and the revision its row showed ([TaskRow.taskRevision]). */
    fun completeAction(id: String, taskRevision: String) = FailedAction("complete", id, patch = mapOf("taskRevision" to taskRevision))

    /**
     * From the Inbox, Focus, Search, or a project: the same command, the same exact-retry lock. A completion this call made shows
     * RN's toast, "{title} marked Done" with Undo for 5.2 s (RN cafdac02d, #834; efd0d8ac8, #1051).
     */
    fun complete(id: String, taskRevision: String) {
        val action = completeAction(id, taskRevision)
        perform(action) { runtime ->
            val reply = runtime.completeTask(id, taskRevision)
            acknowledged(action)
            val toast = reply.optJSONObject("toast")
            val undo = reply.optJSONObject("undo")
            if (toast != null && undo != null) ui {
                showToast(null, toast.getString("message"), "info", toast.getString("undoLabel"), 5200) { undoCompletion(undo.put("id", id)) }
            }
        }
    }

    /** A Process Inbox decision's Undo: core's undoInboxDecision with its receipt; an item changed since stays, with core's words. */
    fun undoInboxDecision(receipt: JSONObject) {
        val action = FailedAction("inboxDecisionUndo", receipt.getString("taskId"), patch = mapOf("receipt" to receipt.toString()))
        perform(action) { runtime ->
            runtime.undoInboxDecision(receipt.toString())
            acknowledged(action)
        }
    }

    /** Done's Undo: core's undoTaskCompletion with the completion's answer; a task changed since stays done, with core's words. */
    fun undoCompletion(undo: JSONObject) {
        val action = FailedAction("completeUndo", undo.getString("id"), patch = mapOf("undo" to undo.toString()))
        perform(action) { runtime ->
            runtime.undoTaskCompletion(undo.toString())
            acknowledged(action)
        }
    }

    /** The command itself succeeded, so its exact retry is no longer owed. */
    internal fun acknowledged(action: FailedAction) {
        ProcessCoreHost.clearFailure(action)
        ui { failedAction = null }
    }

    /** A request left on disk by a dead process is owed before anything else runs (MenuModel.start), as a restored capture is. */
    internal fun owe(action: FailedAction) { failedAction = action }

    /**
     * Core's editor model, its View tab for the saved task (the saved checklist and the attachment titles), and the Form tab's
     * checklist field, read together.
     */
    private fun readEditor(runtime: CoreHost, id: String): EditorModel {
        val model = runtime.taskEditorModel(id)
        val view = runtime.taskView(JSONObject().put("id", id).toString())
        val field = if (view.getBoolean("readOnly")) null
            else runtime.editTaskChecklist(id, model.getJSONObject("draft").toString(), view.getJSONArray("checklistBase").toString(), "").getJSONObject("field")
        return EditorModel.of(model, view, field)
    }

    /**
     * RN's resolveTaskOpenTab: a read-only task shows only the View tab; an explicit edit ([routeTab] "task": RN's Save & edit, the
     * Board's Duplicate, the Weekly Review's Add task and edit) opens the Form tab; else the device's "Open tasks in" choice, else
     * the list's own tab: the Inbox list's is the Form tab (RN's defaultEditTab="task"), every other screen's, a search result's and a
     * link's ([routeTab] "view") the View tab.
     */
    fun openEditor(id: String, routeTab: String? = null) {
        val mode = prefs.getString(TASK_OPEN_MODE_KEY, null)
        val automatic = routeTab ?: if (menu.screen == null && screen == Screen.Inbox && search == null) "task" else "view"
        perform { runtime ->
            val opened = readEditor(runtime, id)
            val tab = if (opened.readOnly) "view" else if (routeTab == "task") "task" else if (mode == "preview") "view" else if (mode == "edit") "task" else automatic
            ui { suggestions = emptyMap(); taskView = null; taskViewDepth = VIEW_WINDOW; keepEditor(TaskEditor.open(opened, tab)) }
        }
    }

    /**
     * RN's openTaskScreen after Save & edit (the popup's and the capture screen's): the task's project on RN's Projects screen,
     * else Focus with the task outlined, and the task's editor over it on its Task tab. It waits for the save's action to end:
     * a project's read refuses to start while one runs.
     */
    internal fun openSavedTask(taskId: String, projectId: String?) = menu.whenIdle {
        closeSearch()
        menu.closeSheet()
        if (projectId != null) openFromSearch(Screen.Projects, projectId) else { menu.toTabs(); show(Screen.Focus); highlight(taskId) }
        menu.whenIdle { openEditor(taskId, "task") }
    }

    /** The editor [current] with core's model for its whole draft (editTaskDraft without an edit) and its checklist field. */
    private fun withView(runtime: CoreHost, current: TaskEditor): TaskEditor {
        val sent = current.fullDraft()
        return current.viewed(stepEditor(runtime, current, sent, "").view, sent)
    }

    /**
     * The editor after one control's edit ([edit], "" for none): a checklist edit (`{ checklist }`, core's TaskChecklistEdit) goes
     * to core's editTaskChecklist first (a list task's status follows its items), then core's editTaskDraft gives the model for
     * the draft, and editTaskChecklist without an edit the Form tab's checklist field for it. Nothing is written.
     */
    private fun stepEditor(engine: CoreHost, current: TaskEditor, sent: Map<String, String>, edit: String): Stepped {
        val queued = edit.takeIf { it.isNotEmpty() }?.let { JSONObject(it).optJSONObject("checklist") }
        // An item's edit resolved against the checklist as it is now; an edit whose item is gone is dropped (only the view is read).
        val listEdit = queued?.let { currentChecklistEdit(it, current.checklistNow) }
        val checked = listEdit?.let { engine.editTaskChecklist(current.id, draftJson(sent), current.checklistNow, it.toString()) }
        val list = checked?.getJSONArray("checklist")?.toString() ?: current.checklistNow
        // The layout follows the editor's checklist, unsaved items included (a hidden Checklist field shows while it has items, as RN's).
        val model = engine.editTaskDraft(current.id, checked?.getJSONObject("draft")?.toString() ?: draftJson(sent), if (queued == null) edit else "", list)
        val field = if (current.readOnly) null else engine.editTaskChecklist(current.id, model.getJSONObject("draft").toString(), list, "").getJSONObject("field")
        return Stepped(current.model.edited(model, field), checked?.let { list }, checked?.menuText("focusId"))
    }

    /** Control edits are with core or wait for it (the editor's persisted queue); Save waits for them, and Close counts them as unsaved. */
    val editsPending get() = editor?.pending?.isNotEmpty() == true
    /** The session and number of the edit core is answering now. */
    private var inFlight: Pair<String, Long>? = null
    /** Core's message for the last refused edit; the next accepted edit clears it. */
    private var editRefusal: String? = null

    /**
     * One control's edit through core's editTaskDraft (a date pick, a quick date, a recurrence or relative start
     * edit, field values). It is numbered and written to the draft file before it is sent, and sent one at a
     * time, so each applies to the draft the one before returned. [field] names the typed input it came from.
     * Nothing is written to the task until Save.
     */
    fun editDraft(edit: JSONObject, field: String? = null) {
        val current = editor ?: return
        keepEditor(current.queued(edit.toString(), field))
        pumpEdits()
    }

    /**
     * RN's relative start: the lead time and the unit are one edit. A missing part comes from the latest
     * pending relative start edit, else from core's model, so a quick amount-then-unit keeps both.
     */
    fun relativeStart(amount: Any?, unit: String?) {
        val current = editor ?: return
        val latest = current.pending.map { JSONObject(it.edit) }.lastOrNull { it.optString("type") == "relativeStart" }
        val shown = current.view.fields.relativeStart ?: return
        editDraft(JSONObject().put("type", "relativeStart")
            .put("amount", amount ?: latest?.get("amount") ?: shown.getInt("amount"))
            .put("unit", unit ?: latest?.getString("unit") ?: shown.getString("unit")), if (amount != null) RELATIVE_AMOUNT else null)
    }

    fun pumpEdits() {
        val current = editor
        val runtime = host
        if (inFlight != null || current == null || runtime == null || busy || failedAction != null) return
        val next = current.pending.firstOrNull() ?: return
        val ticket = current.session to next.seq
        inFlight = ticket
        val sent = current.fullDraft()
        background(listOf(Part.Editor), { engine -> runCatching { stepEditor(engine, current, sent, next.edit) } }) { reply, _ ->
            if (inFlight == ticket) inFlight = null
            // A reply counts only for its own session and the edit it answers, still first in the queue: a closed,
            // discarded, or reloaded editor, or an older edit, never changes the draft on screen.
            val now = editor?.takeIf { it.session == ticket.first && it.pending.firstOrNull()?.seq == ticket.second }
                ?: return@background pumpEdits()
            reply.onSuccess { step ->
                // The new draft (and checklist) and the removal of the edit it answers go to the draft file in one write.
                keepEditor(now.viewed(step.view, sent).copy(pending = now.pending.drop(1)).withChecklist(step.checklist ?: now.checklist))
                step.focusId?.let { checklistFocus = it }
                if (error != null && error == editRefusal) error = null
                editRefusal = null
            }.onFailure { failure ->
                // Core refused the edit: the draft stays as it was, the typed text and core's message stay on
                // screen, and a Save queued behind it is cancelled.
                Log.w(CoreHost.TAG, "Editor edit refused", failure)
                keepEditor(now.copy(pending = now.pending.drop(1)))
                editRefusal = failure.message ?: failure.javaClass.simpleName
                error = editRefusal
                saveQueued = false
            }
            pumpEdits()
            if (!editsPending && saveQueued && editor?.waiting == false) { saveQueued = false; saveEditor() }
        }
    }

    /**
     * A queued checklist edit as core takes it: the item it names by its stable id (`itemId`) at the item's position in [checklist]
     * as it is now, after every edit sent before it; a move keeps its direction (`step`). Null (the edit is dropped) when the item
     * is gone or the move would leave the list. A position is never taken from the screen: an edit still with core can shift it.
     */
    private fun currentChecklistEdit(edit: JSONObject, checklist: String): JSONObject? {
        if (!edit.has("itemId")) return edit
        val items = JSONArray(checklist)
        val index = (0 until items.length()).firstOrNull { items.getJSONObject(it).getString("id") == edit.getString("itemId") } ?: return null
        val sent = JSONObject(edit.toString()).apply { remove("itemId"); remove("step") }
        if (edit.getString("kind") != "move") return sent.put("index", index)
        val to = index + edit.getInt("step")
        return if (to in 0 until items.length()) sent.put("from", index).put("to", to) else null
    }

    /**
     * One of RN's checklist edits (core's TaskChecklistEdit: a tick, a rename, Return, remove, add, a move, the View tab's add input),
     * queued with the draft's own edits, so each applies to the checklist and status the one before returned. An item's edit names
     * the item by its id (see [currentChecklistEdit]). [field] names the typed item it came from. Nothing is written until Save.
     */
    fun editChecklist(edit: JSONObject, field: String? = null) = editDraft(JSONObject().put("checklist", edit), field)

    /** The focus request for a new checklist item is used. */
    fun checklistFocused() { checklistFocus = null }

    /** RN's editor tabs: the Form tab ("task") or the View tab, kept with the draft. */
    fun editorTab(tab: String) { editor?.let { keepEditor(it.copy(tab = tab)) } }

    /**
     * Core's View tab (getTaskView) for the editor's draft and checklist, as the RN editor shows its merged task, in the background;
     * [more] reads one more window of its checklist. A read-only task shows the saved task.
     */
    fun readTaskView(more: Boolean = false) {
        val current = editor ?: return
        if (more) taskViewDepth += VIEW_WINDOW
        val depth = taskViewDepth
        val input = JSONObject().put("id", current.id)
        if (!current.readOnly) input.put("draft", JSONObject(draftJson(current.fullDraft()))).put("checklist", JSONArray(current.checklistNow))
        // The draft's attachments, as RN's View tab shows its merged task.
        if (!current.readOnly && current.attachments != null) input.put("attachments", JSONArray(current.attachmentsNow))
        background(listOf(Part.TaskView), { runtime -> readView(runtime, input, depth) }) { view, mine ->
            if (fresh(mine, Part.TaskView) && editor?.id == current.id) taskView = view
        }
    }

    /**
     * The View tab from its first window, its checklist items read to [depth] under that window's revision. A view that changed
     * between windows (a new minute, a new draft) keeps what it read; the next read starts from the first window again.
     */
    private fun readView(runtime: CoreHost, input: JSONObject, depth: Int): JSONObject {
        val first = runtime.taskView(JSONObject(input.toString()).put("offset", 0).put("limit", VIEW_WINDOW).toString())
        val checklist = { view: JSONObject -> view.menuObjects("rows").firstOrNull { it.getString("type") == "checklist" } }
        val items = checklist(first)?.getJSONArray("items") ?: return first
        try {
            while (items.length() < minOf(depth, checklist(first)!!.getInt("total"))) {
                val next = checklist(runtime.taskView(JSONObject(input.toString()).put("offset", items.length()).put("limit", VIEW_WINDOW)
                    .put("revision", first.getString("revision")).toString()))?.getJSONArray("items")
                if (next == null || next.length() == 0) break // core sent no items: stop, never spin
                for (index in 0 until next.length()) items.put(next.get(index))
            }
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
        return first
    }

    /**
     * RN's Reset checklist: core's resetTaskChecklist writes at once (a new request UUID; its retry only finishes a failed save);
     * then the reset task becomes the editor's base and the editor's own items reopen (core's uncheckAll), as RN does.
     */
    fun resetChecklist() {
        val current = editor ?: return
        // The saved task's revision as the View tab showed it (getTaskView's taskRevision).
        val revision = taskView?.takeIf { it.getString("id") == current.id }?.optString("taskRevision") ?: return
        sendReset(FailedAction("resetChecklist", current.id, UUID.randomUUID().toString(), patch = mapOf("taskRevision" to revision)))
    }

    private fun sendReset(action: FailedAction) = perform(action) { runtime ->
        try {
            runtime.resetTaskChecklist(action.id, action.title, action.patch["taskRevision"].orEmpty())
        } catch (failure: Exception) {
            // The task changed since the View tab showed it: nothing was written; the View tab is read again, with its new revision.
            if (failure.message?.startsWith("STALE_REVISION") == true) ui { menu.whenIdle { readTaskView() } }
            throw failure
        }
        acknowledged(action)
        val fresh = readEditor(runtime, action.id)
        ui {
            editor?.takeIf { it.id == action.id }?.let { keepEditor(it.reloaded(fresh, keepChecklist = true)) }
            editChecklist(JSONObject().put("kind", "uncheckAll"))
        }
    }

    /** Field values exactly as RN's controls write them, through core, which runs the draft's cascades (status, star, due date). */
    fun editFields(values: Map<String, Any?>) =
        editDraft(JSONObject().put("type", "fields").put("patch", JSONObject().apply { values.forEach { (field, value) -> put(field, value ?: JSONObject.NULL) } }))

    /**
     * An AI answer's draft edit (a copilot chip, a Clarify button): core's editTaskDraft edit, queued as a control's edit. A
     * context, tag or person it sets shows as that field's text, as RN's field follows its draft.
     */
    internal fun applyAIEdit(edit: JSONObject) {
        val current = editor ?: return
        val patch = edit.optJSONObject("patch")
        val typed = buildMap { for (field in TYPED_FIELDS) if (patch?.has(field) == true) put(field, patch.getString(field)) }
        keepEditor(current.copy(inputs = current.inputs + typed, resolved = current.resolved + typed))
        editDraft(edit)
    }

    /**
     * Break down's "Add steps": core's checklist (the editor's items and the steps) becomes the draft's, and a list task's status
     * edit (or none) reads core's model for it. It waits for edits still with core, which could change the checklist first.
     */
    internal fun addAISteps(checklist: String, edit: JSONObject?) {
        val current = editor ?: return
        if (editsPending) { main.postDelayed({ addAISteps(checklist, edit) }, 100); return }
        keepEditor(current.withChecklist(checklist).queued(edit?.toString() ?: "", null))
        pumpEdits()
    }

    /** Core's answer to an attachment command on the open editor [taskId]: the draft's next list (JSON), kept with the draft. */
    internal fun setDraftAttachments(taskId: String, next: String) {
        editor?.takeIf { it.id == taskId }?.let { keepEditor(it.withAttachments(next)) }
    }

    /** Typed text (title, notes, location) stays in the editor as typed; no core rule reads it while editing. */
    fun editText(field: String, text: String) { editor?.let { keepEditor(it.edit(mapOf(field to text))) } }

    /** A context, tag, or person input: the text as typed, and core's draft value and suggestions for it. */
    fun editInput(field: String, text: String) {
        val current = editor ?: return
        keepEditor(current.typed(field, text))
        suggest(field, text)
    }

    /** Core's getTaskEditorSuggestions for [text]; its draft value applies only while the field still shows [text]. */
    fun suggest(field: String, text: String) {
        val id = editor?.id ?: return
        // The waiting prompt asks core for people, as the Assigned To field does.
        val coreField = if (field == WAITING_PROMPT) "assignedTo" else field
        background(listOf(Part.Editor), { runtime -> EditorSuggestions.parse(text, runtime.editorSuggestions(id, coreField, text, SUGGESTIONS)) }) { found, _ ->
            val current = editor?.takeIf { it.id == id } ?: return@background
            suggestions = suggestions + (field to found)
            if (field !in TYPED_FIELDS) return@background
            val resolved = current.resolve(field, text, found.draftValue)
            keepEditor(resolved)
            if (saveQueued && !resolved.waiting && !editsPending) { saveQueued = false; saveEditor() }
        }
    }

    /**
     * The editor closes. [settle]: a draft whose attachments changed and were not saved is discarded, so the managed copies it
     * added go (core's settleTaskDraftAttachments, as RN's editor settles its draft); a Save settles its own after it landed.
     */
    fun closeEditor(settle: Boolean = true) {
        // Never while a save is owed: its new copies are that save's, settled when it lands (sendDraft).
        editor?.takeIf { discardSettles(settle, pendingSave != null, it.attachments != null, it.readOnly) }?.let { closing ->
            val from = closing.attachmentsFrom ?: closing.model.attachmentsBase
            attachments.settle(closing.id, closing.model.taskRevision, from, closing.attachmentsNow, from)
        }
        attachments.closed()
        ai.cancelEditor()
        inFlight = null
        editRefusal = null
        taskView = null
        checklistFocus = null
        keepEditor(null)
        suggestions = emptyMap()
        saveQueued = false
        error = null
        conflict = false
    }

    /** RN's waiting prompt, starting from the person the draft names. */
    fun openWaitingPrompt() { editor?.let { keepEditor(it.copy(waitingFor = it.input("assignedTo"))); suggest(WAITING_PROMPT, it.input("assignedTo")) } }

    fun editWaitingPrompt(text: String) {
        editor?.let { keepEditor(it.copy(waitingFor = text)) }
        suggest(WAITING_PROMPT, text)
    }

    fun closeWaitingPrompt() { editor?.let { keepEditor(it.copy(waitingFor = null)) } }

    /** RN's confirmWaitingAssignment: Waiting and the person, in the draft. */
    fun confirmWaiting() {
        val current = editor ?: return
        val person = current.waitingFor.orEmpty()
        keepEditor(current.assignWaiting(person))
        editFields(mapOf("status" to "waiting", "assignedTo" to person))
    }

    /**
     * A save's exact request: the changed draft fields with their loaded values, the checklist's base and value ("" when unchanged),
     * and a request UUID (the owed save's, when it is this one).
     */
    fun saveDraftAction(current: TaskEditor) =
        withRequestId(FailedAction("saveDraft", current.id, current.checklistSave, base = current.base, patch = current.patch,
            attachments = current.attachmentsSave), failedAction)

    /**
     * Sends only the changed draft fields with their loaded values, to core's saveTaskDraft. Nothing
     * changed: close, no call. Typed text core has not resolved yet queues the save until it has.
     * The exact request is on disk before the call, so an outcome lost with the process is sent again.
     */
    fun saveEditor() {
        val current = editor ?: return
        if (current.waiting || editsPending) { saveQueued = true; return }
        if (current.patch.isEmpty() && !current.checklistChanged && !current.attachmentsChanged) { closeEditor(); return }
        if (busy || (failedAction != null && failedAction != saveDraftAction(current))) return
        val action = saveDraftAction(current)
        pendingSave = action
        keepEditor(current)
        sendDraft(action)
    }

    /** Core's saveTaskDraft with [action]'s exact request. A refusal wrote nothing, so no request is owed. */
    private fun sendDraft(action: FailedAction) = perform(action) { runtime ->
        try {
            runtime.saveTaskDraft(action.id, draftJson(action.base), draftJson(action.patch), action.title, action.attachments, action.requestId)
        } catch (failure: Exception) {
            // A restored request locked the draft before it was sent; a refusal unlocks it, as nothing is owed.
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) ui { pendingSave = null; failedAction = null; editor?.let(::keepEditor) }
            throw failure
        }
        acknowledged(action)
        // The saved attachments settle the draft's copies: a file no saved attachment owns any more goes (RN's settleDraftAttachments).
        if (action.attachments.isNotEmpty()) attachments.settleSaved(runtime, action.id, JSONObject(action.attachments))
        ui { closeEditor(settle = false) }
    }

    fun reloadEditor() {
        val id = editor?.id ?: return
        perform { runtime ->
            val fresh = readEditor(runtime, id)
            val current = editor ?: return@perform
            val reloaded = withView(runtime, current.reloaded(fresh))
            ui { keepEditor(reloaded) }
        }
    }

    /** Try again after a failed read: every list from offset 0, as deep as it is shown. */
    fun refresh() {
        val at = depth()
        val mine = ++issued
        perform { runtime ->
            val lists = read(runtime, at)
            // The open Menu list (the Inbox tab's too) is read again with them.
            ui { showLists(lists, mine); menu.retryRead() }
        }
    }

    /** Focus from offset 0, in the background: on resume and each minute while Focus shows. */
    fun refreshFocus() {
        // Never read yet (the boot left it for later): a running action delays the read, never drops it.
        if (focus == null && busy) return menu.whenIdle(::refreshFocus)
        val depth = focus.depth()
        val controls = menu.focusControls.state.toString()
        background(listOf(Part.Focus), { runtime -> readFocus(runtime, null, depth, controls) }) { view, mine -> if (fresh(mine, Part.Focus)) showFocus(view) }
    }

    /** The next window of one section at the loaded revision. */
    fun loadMoreFocus(key: String) {
        val view = focus ?: return
        val depth = view.depth() + (key to (view.section(key)?.rows?.size ?: 0) + PAGE)
        val mine = ++issued
        perform { runtime ->
            val next = readFocus(runtime, view, depth, view.state.toString())
            ui { if (fresh(mine, Part.Focus)) showFocus(next) }
        }
    }

    /** A Focus control's edit (FocusModel): Focus read again with it, as deep as shown; core's answer carries the new control state. */
    internal fun editFocusControls(edit: JSONObject) {
        val depth = focus.depth()
        val controls = menu.focusControls.state.toString()
        val mine = ++issued
        perform { runtime ->
            val next = readFocus(runtime, null, depth, controls, edit.toString())
            ui { if (fresh(mine, Part.Focus)) showFocus(next) }
        }
    }

    /** Core's Focus on screen, and its control state becomes the screen's (FocusModel.adopt). */
    private fun showFocus(view: FocusView?) {
        focus = view
        view?.let(menu.focusControls::adopt)
        // RN's card reads with every Focus read.
        pomodoro.refresh()
    }

    /** The Focus read's revision, for the Pomodoro picker's task windows (core pages the Focus lists at one revision). */
    internal fun focusRevision(): String = focus?.revision.orEmpty()

    private fun FocusView?.depth(): Map<String, Int> = this?.sections?.associate { it.key to it.rows.size }.orEmpty()

    private fun depth() = Depth(focus.depth(), openProjectId, maxOf(PAGE, project?.items?.size ?: 0), menu.focusControls.state.toString())

    /** Opens or closes Someday / Waiting ("deferred") or Closed ("archived"), as RN's toggleProjectSection. */
    fun toggle(group: String) {
        val view = projectsView
        projectsView = if (group == "deferred") view.copy(showDeferred = !view.showDeferred) else view.copy(showArchived = !view.showArchived)
        projectsView.save(prefs)
    }

    /** RN's toggleAreaCollapse: [areaId] is the area's id, "no-area" without one. */
    fun toggleArea(areaId: String) {
        val collapsed = projectsView.collapsedAreas
        projectsView = projectsView.copy(collapsedAreas = if (areaId in collapsed) collapsed - areaId else collapsed + areaId)
        projectsView.save(prefs)
    }

    /** RN's toggleSection on Focus. */
    fun toggleFocusSection(key: String) {
        focusView = focusView.with(mapOf(key to !focusView.isOpen(key)))
        focusView.save(prefs)
    }

    /** RN's toggleShowDetails (View options): rows show their detail parts, kept with the open sections. */
    fun setFocusDetails(on: Boolean) {
        focusView = focusView.withDetails(on)
        focusView.save(prefs)
    }

    /** RN's toggleOtherSections: Today's Focus stays open; the others all open, or all close. */
    fun setOtherFocusSections(open: Boolean) {
        focusView = focusView.with(FOCUS_SECTION_KEYS.associateWith { it == "focus" || open })
        focusView.save(prefs)
    }

    fun showAreaSheet(open: Boolean) { areaSheet = open }

    fun showStatusMenu(task: TaskRow?) { statusMenu = task }

    private var toastShown = 0
    /** RN's toast for 3.2 s, or 5.2 s with an action (RN's Undo), which runs [onAction] and dismisses it. */
    internal fun showToast(title: String?, message: String, tone: String = "warning", action: String? = null, durationMs: Long? = null,
                           onAction: () -> Unit = {}) {
        toast = Toast(title, message, tone, action, onAction)
        val mine = ++toastShown
        val shown = durationMs ?: toastDurationMs(null, action)
        main.postDelayed({ if (mine == toastShown) toast = null }, if (action != null) actionTimeout(shown) else shown)
    }

    /**
     * Android's "Time to take action" (Accessibility settings): a toast with an action (Undo) stays as long as the user asked,
     * never shorter than RN's time. Android 10+; earlier, RN's time.
     */
    private fun actionTimeout(shown: Long): Long {
        if (android.os.Build.VERSION.SDK_INT < 29) return shown
        val accessibility = getApplication<Application>().getSystemService(android.view.accessibility.AccessibilityManager::class.java) ?: return shown
        return maxOf(shown, accessibility.getRecommendedTimeoutMillis(shown.toInt(),
            android.view.accessibility.AccessibilityManager.FLAG_CONTENT_TEXT or android.view.accessibility.AccessibilityManager.FLAG_CONTENT_CONTROLS).toLong())
    }

    /** Core's toast or notice (`title`, `message`, `tone`, `durationMs`), shown for core's time (toastDurationMs). */
    internal fun showToast(toast: JSONObject, action: String? = null, tone: String = toast.optString("tone", "warning"), onAction: () -> Unit = {}) =
        showToast(toast.text("title")?.ifEmpty { null }, toast.getString("message"), tone, action, toastDurationMs(toast, action), onAction)

    fun dismissToast() { toast = null }

    /** The star's target state and the row's revision: the exact retry of a failed star re-sends the same request. */
    fun taskFocusAction(id: String, focused: Boolean, taskRevision: String) =
        FailedAction("taskFocus", id, patch = mapOf("focused" to "$focused", "taskRevision" to taskRevision))

    /** RN's row star through core's setTaskFocus. A refusal writes nothing and shows core's text in RN's toast. */
    fun setTaskFocus(id: String, focused: Boolean, taskRevision: String) {
        val action = taskFocusAction(id, focused, taskRevision)
        perform(action) { runtime ->
            val reply = runtime.setTaskFocus(id, focused, taskRevision)
            acknowledged(action)
            val blocked = reply.optString("blocked")
            if (blocked.isNotEmpty()) ui { showToast(reply.getString("blockedTitle"), blocked) }
        }
    }

    fun projectFocusAction(id: String, focused: Boolean, projectRevision: String) =
        FailedAction("projectFocus", id, patch = mapOf("focused" to "$focused", "projectRevision" to projectRevision))

    /** RN's project star through core's setProjectFocus. Core's `{ blocked: "" }` shows nothing, as RN gives only its haptic. */
    fun setProjectFocus(id: String, focused: Boolean, projectRevision: String) {
        val action = projectFocusAction(id, focused, projectRevision)
        perform(action) { runtime ->
            runtime.setProjectFocus(id, focused, projectRevision)
            acknowledged(action)
        }
    }

    /** The status change's exact request, with a request UUID (the owed change's, when it is this one). */
    fun statusAction(task: TaskRow, status: String) =
        withRequestId(FailedAction("update", task.id, base = mapOf("status" to task.status), patch = mapOf("status" to status)), failedAction)

    /** RN's status menu: core's updateTask with the status the row was loaded with, so core refuses a stale change. */
    fun changeStatus(task: TaskRow, status: String) {
        statusMenu = null
        if (status == task.status) return
        sendUpdate(statusAction(task, status))
    }

    /** Core's updateTask with [action]'s exact request: the status menu, the Restore and Next swipes, and their retry. */
    private fun sendUpdate(action: FailedAction) = perform(action) { runtime ->
        runtime.updateTask(action.id, json(action.base), json(action.patch), action.requestId)
        acknowledged(action)
    }

    /**
     * The failure banner's Try again while a command's retry is owed: that exact request again, on every screen,
     * so a command started where its control is gone (the status menu on Focus, a closed dialog) stays retryable.
     */
    fun retryOwed() {
        val action = failedAction ?: return
        when (action.kind) {
            "capture" -> sendCapture(action)
            "captureLines" -> sendLines(action)
            "capturePicker" -> sendPicker(action)
            "captureModal", "captureModalLines" -> captureModal.retry(action)
            "complete" -> complete(action.id, action.patch["taskRevision"].orEmpty())
            "completeUndo" -> undoCompletion(JSONObject(action.patch["undo"].orEmpty()))
            "inboxDecisionUndo" -> undoInboxDecision(JSONObject(action.patch["receipt"].orEmpty()))
            "update" -> sendUpdate(action)
            "saveDraft" -> sendDraft(action)
            "resetChecklist" -> sendReset(action)
            "taskFocus" -> setTaskFocus(action.id, action.patch["focused"] == "true", action.patch["taskRevision"].orEmpty())
            "projectFocus" -> setProjectFocus(action.id, action.patch["focused"] == "true", action.patch["projectRevision"].orEmpty())
            "createProject" -> createProject(action.base["areaId"].orEmpty())
            "areaFilter" -> sendAreaFilter(action)
            "saveSearch" -> sendSaveSearch(action)
            "inboxCommit", "inboxSkip" -> sendAnswer(action, reopen = processing?.hidden == false)
            // A journal replay that stopped on an owed save (ProcessCoreHost's boot, or its queue drain): the journal's requests
            // again, in order.
            "journal" -> perform(action) { runtime ->
                runtime.replayJournal().owed?.let { throw IllegalStateException(it) }
                acknowledged(action)
                // The replay finished: the queue drain it held back, then sync (never before the replay); an owed drain shows its retry.
                if (!ProcessCoreHost.recovered(getApplication(), runtime)) throw IllegalStateException(ProcessCoreHost.failure?.error ?: "SAVE_FAILED")
            }
            // A read that met an unsaved write: read again under the same lock; its success clears it. A write no screen sent (a
            // CoreWork queue drain while this screen showed) owes its journal retry instead: that replay saves it.
            "storage" -> ProcessCoreHost.failure?.action?.takeIf { it.kind == "journal" }?.let { owed -> failedAction = owed; retryOwed() }
                ?: perform(action) { runtime ->
                val lists = read(runtime, depth())
                acknowledged(action)
                ui { showLists(lists, ++issued) }
            }
            // A project's attachment command (Attachments.kt) with its exact request.
            in ATTACHMENT_KINDS -> attachments.retry(action)
            // A Project details commit (ProjectDetails.kt) with its exact request and preparation.
            in PROJECT_DETAIL_KINDS -> projectDetails.retry(action)
            // The Menu tab's commands (MENU_KINDS) keep their exact request in MenuModel.
            else -> menu.retry(action)
        }
    }

    // ---- The capture popup (RN's components/quick-capture-sheet.tsx) ----

    /** Every popup change is on disk (synced) before anything else, except reads and edits waiting for core; closing deletes it. */
    private fun keepCapture(value: CaptureDraft?, persist: Boolean = true) {
        capture = value
        saved["capturing"] = value != null
        if (value == null) captureStore.delete() else if (persist) captureStore.write(value.state())
    }

    /**
     * RN's center +: core's empty draft; RN's sticky "Add another" goes on with core's own edit. A project's "+" ([projectId], RN's
     * openProjectQuickAdd) chooses that project and keeps RN's preset (the project, status Next) for every call, so its task saves
     * as Next in the project.
     */
    fun openCapture(projectId: String? = null) {
        if (capture != null) return
        perform { runtime ->
            val view = runtime.openQuickCapture()
            ui {
                openedCapture(view, "")
                if (projectId != null) capture?.let { opened ->
                    keepCapture(opened.copy(preset = JSONObject().put("projectId", projectId).put("status", "next")))
                    editCapture(JSONObject().put("type", "selectProject").put("projectId", projectId))
                }
            }
        }
    }

    /** The popup on core's [view] with [text] (an entry's draft, EntryPoints.kt, replaces an open one), then RN's sticky "Add another". */
    internal fun openedCapture(view: JSONObject, text: String) {
        captureInFlight = null
        keepCapture(CaptureDraft.opened(view).copy(text = text))
        val addAnother = view.getJSONObject("addAnother")
        if (prefs.getString(ADD_ANOTHER_KEY, null) == "true" && !addAnother.getBoolean("value")) editCapture(addAnother.getJSONObject("edit"))
    }

    /** RN's Close (and the backdrop, and Back): the draft goes, as RN's popup discards it. */
    fun closeCapture() {
        keepCapture(null)
        captureInFlight = null
    }

    fun leftApp() { leaveApp = false }

    /**
     * After process death: the popup comes back with its draft. An answer whose outcome was unknown is sent again
     * exactly first (core answers a capture already written from its task, and writes nothing twice).
     */
    private fun resumeCapture(restored: CaptureDraft) {
        keepCapture(restored.reading())
        val action = restored.pending ?: return
        if (failedAction != null) return
        failedAction = action
        when (action.kind) { "capture" -> sendCapture(action); "captureLines" -> sendLines(action); else -> sendPicker(action) }
    }

    /** The typed text, then core's view for it (preview and Save's state). */
    fun typeCapture(text: String) {
        val current = capture ?: return
        keepCapture(current.copy(text = text).reading())
        pumpCapture()
    }

    /** A control's edit as core's view carries it; queued, then sent one at a time. */
    fun editCapture(edit: JSONObject) {
        val current = capture ?: return
        // The edit is part of the durable draft (on disk before it is sent), so a death before core answers keeps it.
        keepCapture(current.copy(requests = current.requests + JSONObject().put("edit", edit)))
        pumpCapture()
    }

    /** RN's Add another switch: core's edit, and RN's device preference for the next open. */
    fun setCaptureAddAnother(addAnother: JSONObject) {
        val on = addAnother.getJSONObject("edit").getBoolean("value")
        prefs.edit().apply { if (on) putString(ADD_ANOTHER_KEY, "true") else remove(ADD_ANOTHER_KEY) }.apply()
        editCapture(addAnother.getJSONObject("edit"))
    }

    fun setCaptureExpanded(open: Boolean) { capture?.let { keepCapture(it.copy(expanded = open)) } }

    /** Opens a picker (project, area, context, priority) with an empty search; core's view then carries it. */
    fun openCapturePicker(kind: String) {
        val current = capture ?: return
        val picker = JSONObject().put("kind", kind).apply { if (kind != "priority") put("query", "") }
        keepCapture(current.copy(picker = picker, pickerRequestId = UUID.randomUUID().toString()).reading())
        pumpCapture()
    }

    fun closeCapturePicker() { capture?.let { keepCapture(it.copy(picker = null)) } }

    /** The picker's search text; core's view lists the matches. */
    fun captureQuery(query: String) {
        val current = capture ?: return
        val picker = current.picker ?: return
        keepCapture(current.copy(picker = JSONObject(picker.toString()).put("query", query)).reading())
        pumpCapture()
    }

    /** A picker row's edit. Project, area and priority close the picker, as RN's do; contexts stay open for more. */
    fun pickCapture(edit: JSONObject, close: Boolean, clearQuery: Boolean = false) {
        val current = capture ?: return
        val picker = current.picker?.let { if (clearQuery && it.has("query")) JSONObject(it.toString()).put("query", "") else it }
        keepCapture(current.copy(picker = if (close) null else picker))
        editCapture(edit)
    }

    /** The read or edit core is answering now. */
    private var captureInFlight: JSONObject? = null

    /** Sends the next queued read or edit, then a queued Save. The popup calls it again whenever no action runs. */
    fun pumpCapture() {
        val current = capture ?: return
        val runtime = host
        if (captureInFlight != null || runtime == null || busy || failedAction != null) return
        val next = current.requests.firstOrNull()
        if (next == null) {
            current.queuedSave?.let { saveCapture(openAfterSave = it == "edit") }
            return
        }
        captureInFlight = next
        val edit = next.optJSONObject("edit")
        val request = JSONObject().put("text", current.text).put("options", current.options)
            .apply { current.picker?.let { put("picker", it) }; edit?.let { put("edit", it) }; current.preset?.let { put("preset", it) } }
        background(emptyList(), { engine -> runCatching { if (edit != null) engine.editQuickCapture(request.toString()) else engine.quickCaptureView(request.toString()) } }) { reply, _ ->
            if (captureInFlight === next) captureInFlight = null
            // A reply counts only for its popup and the request it answers, still first in the queue.
            val now = capture?.takeIf { it.session == current.session && it.requests.firstOrNull() === next } ?: return@background pumpCapture()
            reply.onSuccess { result ->
                val view = if (edit != null) result.getJSONObject("view") else result
                if (edit != null) result.optJSONObject("notice")?.let { showToast(it) }
                val answered = now.copy(options = view.getJSONObject("options"), view = view, requests = now.requests.drop(1))
                // Text typed while core answered is read again, so the preview follows the field.
                keepCapture(if (now.text != current.text) answered.reading() else answered)
            }.onFailure { failure ->
                // Core refused the request: its message shows, and the queue (with a queued Save) is dropped.
                Log.w(CoreHost.TAG, "Capture request refused", failure)
                showToast(null, (failure.message ?: failure.javaClass.simpleName).substringAfter(": "), "warning")
                keepCapture(now.copy(requests = emptyList(), queuedSave = null))
            }
            pumpCapture()
        }
    }

    /** The draft's opener preset in a request's saved patch (none for the center +). */
    private fun presetPatch(current: CaptureDraft): Map<String, String> = current.preset?.let { mapOf("preset" to it.toString()) }.orEmpty()
    private fun JSONObject.withPreset(action: FailedAction): JSONObject = apply { action.patch["preset"]?.let { put("preset", JSONObject(it)) } }

    /** A Save's exact request: the text, core's options, the capture UUID, and Save and edit. A retry reuses it. */
    fun captureAction(current: CaptureDraft, openAfterSave: Boolean) = current.pending?.takeIf { it.kind == "capture" }
        ?: FailedAction("capture", current.captureId, current.text, patch = mapOf("options" to current.options.toString(), "openAfterSave" to "$openAfterSave") + presetPatch(current))

    /** RN's Save (and Return): reads and edits still with core go first; the request is on disk before the call. */
    fun saveCapture(openAfterSave: Boolean) {
        val current = capture ?: return
        if (current.requests.isNotEmpty() || captureInFlight != null) {
            keepCapture(current.copy(queuedSave = if (openAfterSave) "edit" else "save"), persist = false)
            return
        }
        val action = captureAction(current, openAfterSave)
        if (busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action, queuedSave = null))
        sendCapture(action)
    }

    /** A refused request wrote nothing: the ID is free, and the draft stays for the next try. */
    private fun freeCapture(action: FailedAction) = ui {
        if (failedAction == action) failedAction = null
        capture?.let { keepCapture(it.copy(pending = null, captureId = UUID.randomUUID().toString(), pickerRequestId = UUID.randomUUID().toString(),
            snapshot = null, snapshotTaken = false)) }
    }

    /** Core's submitQuickCapture with [action]'s exact request. */
    private fun sendCapture(action: FailedAction) = perform(action) { runtime ->
        val request = JSONObject().put("text", action.title).put("options", JSONObject(action.patch["options"]!!)).put("captureId", action.id)
            .put("openAfterSave", action.patch["openAfterSave"] == "true").withPreset(action)
        val reply = try {
            runtime.submitQuickCapture(request.toString())
        } catch (failure: Exception) {
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) freeCapture(action)
            throw failure
        }
        acknowledged(action)
        ui { finishCapture(reply) }
    }

    /** Core's answer: saved (close, open the editor, or the next capture), refused (the notice; the draft stays), or several lines. */
    private fun finishCapture(reply: JSONObject) {
        val current = capture ?: return
        val fresh = current.copy(pending = null, captureId = UUID.randomUUID().toString())
        when (reply.getString("kind")) {
            "saved" -> when (reply.getString("next")) {
                "open" -> {
                    keepCapture(null)
                    openSavedTask(reply.getString("taskId"), reply.menuText("projectId"))
                }
                "addAnother" -> {
                    val reset = reply.getJSONObject("reset")
                    keepCapture(fresh.copy(text = reset.getString("text"), options = reset.getJSONObject("options"), picker = null, confirm = null).reading())
                    pumpCapture()
                }
                else -> {
                    // RN's quick capture highlights the task a project's "+" saved, on that project, once the popup closes (#916).
                    val project = current.preset?.optString("projectId")
                    keepCapture(null)
                    if (project != null) highlight(reply.getString("taskId"), project)
                }
            }
            "refused" -> {
                reply.getJSONObject("notice").let { showToast(it) }
                keepCapture(fresh)
            }
            else -> {
                val confirm = JSONObject(reply.getJSONObject("confirm").toString())
                keepCapture(fresh.copy(confirm = confirm, lineIds = List(reply.getInt("lineCount")) { UUID.randomUUID().toString() }))
            }
        }
    }

    fun cancelCaptureLines() { capture?.let { keepCapture(it.copy(confirm = null, lineIds = emptyList(), linesText = null)) } }

    /**
     * RN's Import .txt (More's panel): the picked file's text, read off the main thread, then core's plan for it: several lines
     * ask RN's question (Create tasks sends the file's text), one line goes into the field, an empty file does nothing, and an
     * unreadable one shows core's toast.
     */
    fun importCaptureText(uri: android.net.Uri) {
        if (capture == null) return
        perform { runtime ->
            val text = getApplication<Application>().readPickedText(uri)
            val plan = runtime.menuRead("captureImport", JSONObject().put("text", text ?: JSONObject.NULL).toString())
            ui {
                val current = capture ?: return@ui
                when (plan.getString("kind")) {
                    "confirmLines" -> keepCapture(current.copy(confirm = plan.getJSONObject("confirm"), linesText = plan.getString("text"),
                        lineIds = List(plan.getInt("lineCount")) { UUID.randomUUID().toString() }))
                    "setText" -> typeCapture(plan.getString("text"))
                    "refused" -> plan.getJSONObject("notice").let { showToast(it) }
                }
            }
        }
    }

    /** The several lines' exact request: the text (an imported file's, else the field's), core's options and one capture UUID per line. A retry reuses it. */
    fun linesAction(current: CaptureDraft) = current.pending?.takeIf { it.kind == "captureLines" }
        ?: FailedAction("captureLines", current.lineIds.first(), current.linesText ?: current.text,
            patch = mapOf("options" to current.options.toString(), "captureIds" to current.lineIds.joinToString(",")) + presetPatch(current))

    /** RN's Create tasks: the request is on disk before the call. */
    fun createCaptureLines() {
        val current = capture ?: return
        if (current.lineIds.isEmpty()) return
        val action = linesAction(current)
        if (busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action))
        sendLines(action)
    }

    /** Runs [work] on the main thread and waits for it: an action thread's durable write of the popup's state. */
    private fun <T> onMain(work: () -> T): T {
        val done = java.util.concurrent.CountDownLatch(1)
        var result: Result<T>? = null
        main.post { result = runCatching(work); done.countDown() }
        done.await()
        return result!!.getOrThrow()
    }

    /**
     * Core's recovery snapshot, written as mobile writes it, then submitQuickCaptureLines with the name actually written
     * (core accepts its clash name). The name goes on disk with the request before the batch is sent; a retry (after
     * process death too) first re-sends that exact request. Core refuses a stale snapshot (STALE_REVISION): a fresh one
     * is taken, its name persisted, and the same capture IDs are sent again.
     */
    private fun sendLines(action: FailedAction) = perform(action) { runtime ->
        val ids = org.json.JSONArray(action.patch["captureIds"]!!.split(","))
        val submit = { name: String? ->
            runtime.submitQuickCaptureLines(JSONObject().put("text", action.title).put("options", JSONObject(action.patch["options"]!!))
                .put("captureIds", ids).put("snapshotFileName", name ?: JSONObject.NULL).withPreset(action).toString())
        }
        val fresh = {
            val written = runtime.createQuickCaptureSnapshot(snapshots, menu.settings.transfer.operations::protectedNames)
            onMain { capture?.let { keepCapture(it.copy(snapshot = written, snapshotTaken = true)) } }
            submit(written)
        }
        val (taken, name) = onMain { (capture?.snapshotTaken == true) to capture?.snapshot }
        val reply = try {
            if (!taken) fresh() else try { submit(name) } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                fresh()
            }
        } catch (failure: Exception) {
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) freeCapture(action)
            throw failure
        }
        acknowledged(action)
        ui {
            val current = capture ?: return@ui
            if (reply.getString("kind") == "saved") keepCapture(null) else {
                reply.getJSONObject("notice").let { showToast(it) }
                keepCapture(current.copy(pending = null, confirm = null, lineIds = emptyList(), linesText = null, snapshot = null, snapshotTaken = false))
            }
        }
    }

    /** The project or area picker's search, chosen or created: its exact request, with a UUID kept while the picker is open. */
    fun pickerAction(current: CaptureDraft) = current.pending?.takeIf { it.kind == "capturePicker" }
        ?: FailedAction("capturePicker", current.pickerRequestId, current.picker?.optString("query").orEmpty().trim(),
            patch = mapOf("picker" to current.picker?.optString("kind").orEmpty(), "text" to current.text, "options" to current.options.toString()) + presetPatch(current))

    /** RN's picker submit (Return, or the Create row): the request is on disk before the call. */
    fun submitCapturePicker() {
        val current = capture ?: return
        if (current.picker == null) return
        val action = pickerAction(current)
        if (action.title.isEmpty() || busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action))
        sendPicker(action)
    }

    /** Core's submitQuickCapturePickerQuery; its options come back with the choice made, and the picker closes. */
    private fun sendPicker(action: FailedAction) = perform(action) { runtime ->
        val request = JSONObject().put("picker", action.patch["picker"]).put("query", action.title).put("text", action.patch["text"])
            .put("options", JSONObject(action.patch["options"]!!)).put("requestId", action.id).withPreset(action)
        val reply = try {
            runtime.submitQuickCapturePickerQuery(request.toString())
        } catch (failure: Exception) {
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) freeCapture(action)
            throw failure
        }
        acknowledged(action)
        ui {
            capture?.let {
                keepCapture(it.copy(options = reply.getJSONObject("options"), picker = null, pending = null,
                    pickerRequestId = UUID.randomUUID().toString()).reading())
            }
            pumpCapture()
        }
    }

    // ---- Global search (RN's app/global-search.tsx) ----

    private fun keepSearch(value: SearchState?) {
        search = value
        saved["search"] = value?.state()?.toString()
    }

    /** RN's header search button: an empty query and RN's default filters; a link's search opens with core's query and filters. */
    fun openSearch(state: SearchState = SearchState()) {
        keepSearch(state)
        searchView = null
        readSearch()
    }

    fun closeSearch() {
        keepSearch(null)
        searchView = null
    }

    private var searchTyped = 0

    /** The query as typed; core is asked once typing pauses (RN debounces its full-text read by 200 ms). */
    fun editSearch(query: String) {
        val current = search ?: return
        keepSearch(current.copy(query = query))
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) readSearch() }, 200)
    }

    /** A filter chip, the Include chips, the location, or an active chip's clear: RN's filter state, read again at once. */
    fun setSearchFilters(filters: JSONObject) {
        val current = search ?: return
        keepSearch(current.copy(filters = filters))
        readSearch()
    }

    fun showSearchFilters(open: Boolean) { search?.let { keepSearch(it.copy(filtersOpen = open)) } }

    /** RN's save dialog: open with the query as the name, or closed (null). */
    fun showSaveSearch(name: String?) { search?.let { keepSearch(it.copy(saveName = name)) } }

    /**
     * Core's searchTasks for the query and filters on screen, in the background. An answer for another
     * query (core echoes the trimmed query) or an older read is dropped.
     */
    private fun readSearch() {
        val request = search?.request() ?: return
        background(listOf(Part.Search), { runtime -> SearchView.parse(runtime.searchTasks(request)) }) { view, mine ->
            if (fresh(mine, Part.Search) && view.query == search?.query?.trim()) searchView = view
        }
    }

    fun saveSearchAction(current: SearchState, name: String) =
        FailedAction("saveSearch", current.saveRequestId, current.query.trim(), patch = mapOf("name" to name.trim()))

    /**
     * RN's handleSaveSearch through core's saveSearch. The submitted request (query, name, UUID) is kept with the
     * screen before the call; until core answers, the dialog shows it and cannot change it, and after process death
     * it is sent again before the dialog unlocks.
     */
    fun saveSearch(name: String) {
        val current = search ?: return
        val action = saveSearchAction(current, name)
        if (busy || (failedAction != null && failedAction != action)) return
        keepSearch(current.copy(submitted = action.patch["name"]))
        sendSaveSearch(action)
    }

    private fun sendSaveSearch(action: FailedAction) = perform(action) { runtime ->
        try {
            runtime.saveSearch(JSONObject().put("query", action.title).put("name", action.patch["name"]).put("requestId", action.id).toString())
        } catch (failure: Exception) {
            // Refused before writing: nothing is owed, and the dialog unlocks with core's message.
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) ui { failedAction = null; search?.let { keepSearch(it.copy(submitted = null)) } }
            throw failure
        }
        acknowledged(action)
        ui { search?.let { keepSearch(it.copy(saveName = null, submitted = null, saveRequestId = UUID.randomUUID().toString())) } }
    }

    /** Which list's rows are on screen: the Menu screen and its list, the tab, and the open project ([project] once it opens). */
    private fun listKey(project: String? = openProjectId) = listOf(menu.screen?.name, menu.list, screen.name, project).joinToString("|")

    /** A row of the list a search hit opened on, while RN's highlight lasts. */
    fun isHighlighted(taskId: String) = taskId == highlightTaskId && highlightList == listKey()

    /**
     * RN's setHighlightTask on a search hit: its row is outlined on the list it opened on (the list under the search, or the list
     * [project] opens once read), and RN's list timer clears it after 3.5 s. Leaving that list, once reached, clears it sooner.
     */
    fun highlight(id: String, project: String? = null) {
        val where = listKey(project ?: openProjectId)
        highlightTaskId = id
        highlightList = where
        highlightJob?.cancel()
        highlightJob = viewModelScope.launch {
            withTimeoutOrNull(3_500) { snapshotFlow { listKey() }.dropWhile { it != where }.first { it != where } }
            highlightTaskId = null
            highlightList = null
        }
    }

    /** A project hit, or a task core cannot open in the editor: the list RN routes to, when this app has it. */
    fun openFromSearch(target: Screen, projectId: String?) {
        closeSearch()
        // Projects hold another tab's place when the quick-access tab shows Review or Contexts: RN's Projects screen then.
        if (target == Screen.Projects) return menu.openProjects(projectId)
        show(target)
        if (projectId != null) openProject(projectId)
    }

    // ---- Process Inbox (RN's inbox-processing-modal.tsx and inbox-processing/) ----

    /** The screen state; it is on disk before an answer's call (synced), and the Bundle holds only whether it is open. */
    private fun keepProcessing(value: InboxProcessing?, persist: Boolean = true) {
        processing = value
        saved["processing"] = value != null
        if (value == null) processingStore.delete() else if (persist) processingStore.write(value.state())
    }

    /** RN's "Process Inbox (N)": core's queue in RN's per-device mode. Core refuses while earlier writes are unsaved; its message shows. */
    fun openProcessing() = perform { runtime ->
        val started = InboxProcessing.started(runtime.startInboxProcessing(processingMode))
        ui { keepProcessing(started) }
    }

    /**
     * After process death the app lands on the Inbox, as RN does (its modal does not survive). An answer whose
     * outcome was unknown is first sent again exactly, in the background; core's session died with the process,
     * so a refusal wrote nothing and only core's message shows. Another failure keeps the retry on the Inbox.
     */
    private fun resumeProcessing(restored: InboxProcessing) {
        val action = restored.pending
        if (action == null || failedAction != null) { keepProcessing(null); return }
        // The screen closes, but the record and its request stay on disk until core acknowledges or conclusively
        // refuses it: another process death during this replay finds it again.
        keepProcessing(restored.copy(hidden = true))
        failedAction = action
        sendAnswer(action, reopen = false)
    }

    /** RN's mode switch: kept on the device, and the same item's step in the other mode. */
    fun switchProcessingMode(mode: String) {
        processingMode = mode
        prefs.edit().putString(PROCESSING_MODE_KEY, mode).apply()
        editStep(JSONObject().put("mode", mode))
    }

    /** A control's edit (as core's view carries it), or a mode: queued, then sent to core one at a time. */
    fun editStep(input: JSONObject) {
        val current = processing ?: return
        keepProcessing(current.copy(edits = current.edits + input), persist = false)
        pumpStep()
    }

    /** The edit core is answering now. */
    private var stepInFlight: JSONObject? = null

    /** Sends the next queued edit, then a queued answer. The screen calls it again whenever no action runs. */
    fun pumpStep() {
        val current = processing ?: return
        val runtime = host
        if (stepInFlight != null || runtime == null || busy || failedAction != null) return
        val next = current.edits.firstOrNull()
        if (next == null) {
            current.queued?.let { (kind, choice) -> answer(kind, choice) }
            return
        }
        stepInFlight = next
        val request = JSONObject(next.toString()).put("sessionId", current.sessionId).put("taskId", current.taskId).put("step", current.step)
        background(emptyList(), { engine -> runCatching { engine.inboxProcessingStep(request.toString()) } }) { reply, _ ->
            if (stepInFlight === next) stepInFlight = null
            // A reply counts only for its session and the edit it answers, still first in the queue.
            val now = processing?.takeIf { it.sessionId == current.sessionId && it.edits.firstOrNull() === next } ?: return@background pumpStep()
            reply.onSuccess { view -> keepProcessing(now.copy(view = view, edits = now.edits.drop(1)), persist = false) }
                .onFailure { failure ->
                    // Core refused the edit: core's message shows, and queued edits and a queued answer are dropped.
                    // A changed item or an ended session opens a new session on core's current queue.
                    Log.w(CoreHost.TAG, "Process Inbox edit refused", failure)
                    val message = failure.message ?: failure.javaClass.simpleName
                    showToast(null, message.substringAfter(": "), "warning")
                    keepProcessing(now.copy(edits = emptyList(), queued = null), persist = false)
                    if (message.startsWith("STALE_REVISION")) openProcessing()
                }
            pumpStep()
        }
    }

    /** An answer's exact request: the step's choice ([kind] inboxCommit) or Skip (inboxSkip), for the task and step on screen. */
    fun stepAction(current: InboxProcessing, kind: String, choice: String) = current.pending?.takeIf { it.kind == kind && it.title == choice }
        ?: FailedAction(kind, UUID.randomUUID().toString(), choice,
            patch = mapOf("sessionId" to current.sessionId, "taskId" to current.taskId, "step" to current.step))

    /** A choice, File it, Back, Create project, or Skip. Edits still with core go first; the request is on disk before the call. */
    fun answer(kind: String, choice: String) {
        val current = processing ?: return
        if (current.edits.isNotEmpty() || stepInFlight != null) { keepProcessing(current.copy(queued = kind to choice), persist = false); return }
        val action = stepAction(current, kind, choice)
        if (busy || (failedAction != null && failedAction != action)) return
        keepProcessing(current.copy(pending = action, queued = null))
        sendAnswer(action)
    }

    /**
     * Core's commitInboxProcessingStep or skipInboxProcessingTask with [action]'s exact request. A stale session or
     * item wrote nothing: core's message shows and a new session opens on core's current queue.
     */
    private fun sendAnswer(action: FailedAction, reopen: Boolean = true) = perform(action) { runtime ->
        val request = JSONObject(action.patch).put("requestId", action.id)
        val reply = try {
            if (action.kind == "inboxSkip") runtime.skipInboxProcessingTask(request.apply { remove("step") }.toString())
            else runtime.commitInboxProcessingStep(request.put("decision", JSONObject().put("choice", action.title)).toString())
        } catch (failure: Exception) {
            val message = failure.message.orEmpty()
            if (!message.startsWith("STALE_REVISION")) {
                // A refusal (INVALID_INPUT) wrote nothing either: no request is owed.
                if (UPDATE_REFUSALS.any { message.startsWith(it) }) ui { failedAction = null; processing?.let { keepProcessing(if (it.hidden) null else it.copy(pending = null)) } }
                throw failure
            }
            val started = if (reopen) InboxProcessing.started(runtime.startInboxProcessing(processingMode)) else null
            acknowledged(action)
            ui { keepProcessing(started); showToast(null, message.substringAfter(": "), "warning") }
            return@perform
        }
        acknowledged(action)
        ui { finishAnswer(reply) }
    }

    /** Core's result: the next step (or the end of the queue), a notice instead of moving on, and the filed item's toast. */
    private fun finishAnswer(reply: JSONObject) {
        reply.optJSONObject("notice")?.let { showToast(it) }
        // RN's toast, with Undo of this decision while the receipt is there (RN 23e2102b3, 3b1a3f4f4).
        reply.optJSONObject("toast")?.let { toast ->
            val receipt = toast.optJSONObject("undoReceipt")
            if (receipt == null) showToast(toast, tone = "info")
            else showToast(null, toast.getString("message"), "info", toast.getString("undoLabel"), 5200) { undoInboxDecision(receipt) }
        }
        // A background re-send after process death has no screen to move on; its record is done.
        val current = processing ?: return
        if (current.hidden) { keepProcessing(null); return }
        val view = reply.optJSONObject("view")
        if (view == null) closeProcessing() else keepProcessing(current.copy(view = view, pending = null))
    }

    /** RN's close: the session ends in core (nothing is written), and the Inbox shows again. */
    fun closeProcessing() {
        val current = processing ?: return
        ai.cancelInbox()
        keepProcessing(null)
        stepInFlight = null
        background(emptyList(), { runtime -> runCatching { runtime.endInboxProcessing(current.sessionId) } }) { _, _ -> }
    }

    private fun setProjectDraft(text: String, areaId: String?, requestId: String) {
        projectDraft = text
        projectAreaId = areaId
        projectRequestId = requestId
        saved["projectDraft"] = text
        saved["projectAreaId"] = areaId
        saved["projectRequestId"] = requestId
    }

    fun editProjectDraft(text: String) = setProjectDraft(text, projectAreaId, projectRequestId)

    /** RN's area chip under the field; null means the default (the one area the filter selects, else none). */
    fun chooseProjectArea(areaId: String) = setProjectDraft(projectDraft, areaId, projectRequestId)

    fun createProjectAction(areaId: String) = FailedAction("createProject", projectRequestId, projectDraft, base = mapOf("areaId" to areaId))

    /**
     * RN's handleAddProject through core's createProject. The request UUID stays with the draft,
     * so the exact retry in this process re-sends it and core creates the project once. After
     * process death the draft comes back, but nothing is sent until the user taps + again.
     */
    fun createProject(areaId: String) {
        val action = createProjectAction(areaId)
        perform(action) { runtime ->
            runtime.createProject(action.title, areaId, action.id)
            acknowledged(action)
            ui { setProjectDraft("", null, UUID.randomUUID().toString()) }
        }
    }

    fun areaFilterAction(option: AreaOption) = FailedAction("areaFilter", option.next)

    /** RN's area sheet: one tap sends that option's `next` selection; every list is then read again. */
    fun setAreaFilter(option: AreaOption) = sendAreaFilter(areaFilterAction(option))

    /** Core's setAreaFilter with [action]'s `next` selection (its id), unchanged. */
    private fun sendAreaFilter(action: FailedAction) = perform(action) { runtime ->
        runtime.setAreaFilter(action.id)
        acknowledged(action)
    }

    private fun keepProject(id: String?) {
        openProjectId = id
        saved["project"] = id
    }

    /** Opens one project's detail at core's first window. */
    fun openProject(id: String) {
        if (id != openProjectId) projectCompletedCollapsed = true
        val mine = ++issued
        perform { runtime ->
            val detail = readProject(runtime, id, null, PAGE)
            ui { if (fresh(mine, Part.Project)) { keepProject(id); project = detail } }
        }
    }

    fun closeProject() {
        keepProject(null)
        project = null
        // RN's project modal starts folded with every picker shut each time it opens.
        projectDetails.follow(null)
    }

    /** The open project's next window at the loaded revision. */
    fun loadMoreProject() {
        val view = project ?: return
        val mine = ++issued
        perform { runtime ->
            val next = readProject(runtime, view.projectId, view, view.items.size + PAGE)
            ui { if (fresh(mine, Part.Project)) showProject(view.projectId, next) }
        }
    }

    /** Projects, and the open project from offset 0 as deep as it is shown, in the background: on every resume of the Projects tab. */
    fun refreshProjects() {
        // A running action delays the read, never drops it: the list may be unread (the boot left it for later) or older than a
        // write made outside a command (the welcome sheet's Getting Started, whose openProject is that running action).
        if (busy) return menu.whenIdle(::refreshProjects)
        val at = depth()
        background(listOf(Part.Projects, Part.Project), { runtime -> ProjectsView.parse(runtime.projects()) to readOpen(runtime, at) }) { (list, detail), mine ->
            if (fresh(mine, Part.Projects)) projects = list
            if (fresh(mine, Part.Project)) showProject(at.project, detail)
        }
    }

    /** Every list from offset 0, as deep as it is shown, in the background: after every command. */
    /** Every list and the open screen read again; after a finished sync cycle ([synced]) its language and theme first. */
    private fun refreshAll(synced: Boolean = false) {
        val at = depth()
        background(Part.entries, { runtime -> if (synced) applySyncedChoices(runtime, prefs); read(runtime, at) }, ::showLists)
        menu.refresh()
        if (search != null) readSearch()
    }

    /** The open project from offset 0 as deep as it is shown. A project core no longer has reads as null. */
    private fun readOpen(runtime: CoreHost, at: Depth): ProjectDetail? = at.project?.let { id ->
        try {
            readProject(runtime, id, null, at.projectItems)
        } catch (failure: Exception) {
            if (failure.message?.startsWith("TASK_NOT_FOUND") != true) throw failure
            null
        }
    }

    /** A read of project [id]. It is dropped if that project is no longer open; a project core no longer has closes. */
    private fun showProject(id: String?, detail: ProjectDetail?) {
        if (id != openProjectId) return
        if (detail == null) keepProject(null)
        project = detail
    }

    /** RN's Show completed and Completed pile shape the window: core's project view (getProjectDetailView) for both. */
    private fun projectWindow(runtime: CoreHost, id: String, offset: Int, revision: String): JSONObject =
        runtime.menuRead("projectDetailView", JSONObject().put("projectId", id).put("offset", offset).put("limit", PAGE)
            .apply { if (revision.isNotEmpty()) put("revision", revision) }
            .put("showCompleted", projectShowCompleted).put("completedCollapsed", projectCompletedCollapsed).toString())

    /** RN's Show completed / Hide completed: stored at once, in RN's key; the project reads again. */
    fun showProjectCompleted(on: Boolean) {
        projectShowCompleted = on
        prefs.edit().putString(PROJECT_SHOW_COMPLETED_KEY, on.toString()).apply()
        refreshProjects()
    }

    /** RN's Completed heading: folds or unfolds the pile. */
    fun toggleProjectCompleted() {
        projectCompletedCollapsed = !projectCompletedCollapsed
        refreshProjects()
    }

    /**
     * Core's project detail read to [depth] items at one revision. As in Focus,
     * STALE_REVISION is never an error: the project changed, so read it again
     * from offset 0. A fresh read that went stale keeps its first window.
     */
    private fun readProject(runtime: CoreHost, id: String, start: ProjectDetail?, depth: Int): ProjectDetail {
        var view = start ?: ProjectDetail.parse(projectWindow(runtime, id, 0, ""))
        while (view.items.size < minOf(depth, view.total)) {
            val next = try {
                view.append(projectWindow(runtime, id, view.items.size, view.revision))
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                return if (start == null) view else readProject(runtime, id, null, depth)
            }
            if (next.items.size == view.items.size) break // core sent no items: stop, never spin
            view = next
        }
        return view
    }

    /**
     * Core's Focus for the control state [controls] (after a control's [edit], JSON or ""), with each section read to [depth]
     * rows, all at one revision, so a refresh keeps what Load more showed. Later windows go with the control state core
     * answered. STALE_REVISION is never an error: Focus changed (an edit, a new minute, midnight), so read again from offset 0.
     */
    private fun readFocus(runtime: CoreHost, start: FocusView?, depth: Map<String, Int>, controls: String, edit: String = ""): FocusView {
        var view = start ?: FocusView.parse(runtime.focus(PAGE, controls, edit))
        val state = view.state.toString()
        for ((key, want) in depth) {
            while (true) {
                val loaded = view.section(key) ?: break
                if (loaded.rows.size >= minOf(want, loaded.rowTotal)) break
                val next = try {
                    view.append(runtime.focusWindow(key, loaded.rows.size, PAGE, view.revision, state))
                } catch (failure: Exception) {
                    if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                    // A fresh read that went stale keeps its first windows; the next refresh reads deeper.
                    return if (start == null) view else readFocus(runtime, null, depth, state)
                }
                if (next.section(key)?.rows?.size == loaded.rows.size) break // core sent no rows: stop, never spin
                view = next
            }
        }
        return view
    }

    /**
     * Every list from offset 0, as deep as it is shown: after every command (the Inbox tab reads with MenuModel). The boot reads
     * only [shown]'s: Focus and Projects cost most on a large library, and first content waits for the boot.
     */
    private fun read(runtime: CoreHost, at: Depth, shown: Screen? = null) = Lists(
        if (shown == null || shown == Screen.Focus) readFocus(runtime, null, at.focus, at.controls) else null,
        if (shown == null || shown == Screen.Projects) ProjectsView.parse(runtime.projects()) else null,
        at.project,
        if (shown == null || shown == Screen.Projects) readOpen(runtime, at) else null,
        AreaFilter.parse(runtime.areaFilter()),
    )

    /** A full read, each list applied on its own: a list a newer read already showed keeps the newer rows. */
    private fun showLists(lists: Lists, mine: Long) {
        lists.focus?.let { if (fresh(mine, Part.Focus)) { showFocus(it); readSucceeded() } }
        // Projects not read (the boot left them for later): the open project stays open.
        lists.projects?.let { read ->
            if (fresh(mine, Part.Projects)) projects = read
            if (fresh(mine, Part.Project)) showProject(lists.projectId, lists.project)
        }
        if (fresh(mine, Part.Areas)) areaFilter = lists.areas
    }

    /** A read's success (a full read, or the open Menu list's) clears a read's failure, never an owed retry's. */
    internal fun readSucceeded() {
        if (failedAction == null) error = null
    }

    internal fun ui(update: () -> Unit) { main.post(update) }

    // Read numbers, main thread only. A command outdates every read started before it,
    // so a read that began before a command can never show data from before it.
    // Each list keeps its own number: a quick Focus read that lands first never
    // makes a later-started full read drop its Inbox, Projects, or area filter.
    private var issued = 0L
    private var commandAt = 0L
    private val shownAt = HashMap<Part, Long>()

    /** One list a read can show: Menu is the open Menu list (the Inbox tab's too), More the More sheet, MenuDialog a dialog's choices, ProjectDetails the open project's Details values. */
    internal enum class Part { Focus, Projects, Project, ProjectDetails, Areas, Editor, TaskView, Search, Menu, More, MenuDialog, Pomodoro }

    /** A new read's number, for a read the Menu tab starts through perform (as the lists' More takes one). */
    internal fun issue(): Long = ++issued

    /** A read's result for [part] is shown only if no command, and no newer read of that list, came first. */
    internal fun fresh(mine: Long, part: Part) = (mine > commandAt && mine > (shownAt[part] ?: 0L)).also { if (it) shownAt[part] = mine }

    /**
     * Work that touches no app data (Settings › Data's Share log and Clear log): it runs in every state, as RN's does, while a
     * retry is owed or another action runs too; the engine thread queues it. [failed] shows its failure.
     */
    internal fun anyTime(work: (CoreHost) -> Unit, failed: (Throwable) -> Unit) {
        val runtime = host ?: return
        Thread({
            runCatching { work(runtime) }.onFailure { failure ->
                Log.e(CoreHost.TAG, "Core action failed action=anyTime ${failureForLog(failure)}")
                ui { failed(failure) }
            }
        }, "mindwtr-any-time").start()
    }

    /**
     * A read the app starts itself: on resume, each minute, and after every command.
     * It never takes [busy], so it disables no control and never turns a tap away:
     * a user action that starts meanwhile runs, and the engine thread queues both.
     * It starts only while no user action runs and no retry is owed.
     */
    internal fun <T> background(parts: List<Part>, read: (CoreHost) -> T, apply: (T, Long) -> Unit) {
        val runtime = host
        if (runtime == null || busy || failedAction != null) return
        val mine = ++issued
        Thread({
            val result = runCatching { read(runtime) }
            result.exceptionOrNull()?.let { Log.e(CoreHost.TAG, "Core action failed action=background ${failureForLog(it)}") }
            ui {
                // A failure is shown only if it is still the newest read of one of its lists.
                if (result.isFailure && parts.map { fresh(mine, it) }.none { it }) return@ui
                result.onSuccess { apply(it, mine) }.onFailure { failure ->
                    // A user action running now reports its own outcome; an owed retry is never replaced.
                    if (busy || failedAction != null) return@onFailure
                    val message = failure.message ?: failure.javaClass.simpleName
                    error = message
                    if (message.startsWith("SAVE_FAILED")) {
                        val failed = FailedAction("storage", "")
                        Log.w(CoreHost.TAG, "Core background read failed lock=storage")
                        ProcessCoreHost.recordFailure(ProcessCoreHost.PendingFailure(failed, message, menu.page, editor, screen, focus, projects, project, areaFilter))
                        failedAction = failed
                    }
                }
            }
        }, "mindwtr-read").start()
    }

    /**
     * A user action, one at a time: a command ([action]) or a read the user asked for.
     * Only these take [busy]. While a failed command's retry is owed, only that exact
     * [action] runs: no read starts, so none can clear the failure or replace it. The
     * retry keeps the failure on screen until it succeeds or fails again. After a
     * command succeeds, its lists are read again in the background.
     */
    internal fun perform(action: FailedAction? = null, work: (CoreHost) -> Unit) {
        tryPerform(action, work = work)
    }

    /** [perform], answering whether it started; [finished] runs once it ended and [busy] is clear. */
    internal fun tryPerform(action: FailedAction? = null, finished: (() -> Unit)? = null, work: (CoreHost) -> Unit): Boolean {
        val runtime = host
        // A journal retry owed by work no screen sent (a CoreWork queue drain that stored an item but could not save or record
        // it) holds newer edits back too: until its replay, a reopen would be undone by that item's retry.
        if (failedAction == null) ProcessCoreHost.failure?.takeIf { it.action.kind == "journal" }?.let { owed ->
            failedAction = owed.action
            error = owed.error
        }
        if (busy || runtime == null || (failedAction != null && failedAction != action)) return false
        busy = true
        if (action != null) commandAt = ++issued
        if (failedAction == null) error = null
        conflict = false
        Thread({
            var done = false
            // A command refused as stale (STALE_REVISION) wrote nothing: its row changed since the view showed it, so nothing is owed.
            // RN has no revisions, so nothing shows and the lists are read again, as after a command; the commands in STALE_SHOWN keep
            // core's line on screen instead (a read's success would clear it).
            var stale = false
            try {
                // Debug builds only (check-projects-device.mjs): a user action held long enough to switch tabs while it runs.
                debugProperty("delay_action_ms").toLongOrNull()?.let(Thread::sleep)
                work(runtime); done = true
            }
            catch (failure: Throwable) {
                val message = failure.message ?: failure.javaClass.simpleName
                val refused = message.startsWith("STALE_REVISION") || (action?.kind in REFUSABLE && UPDATE_REFUSALS.any { message.startsWith(it) })
                stale = action != null && action.kind !in STALE_SHOWN && message.startsWith("STALE_REVISION")
                val failed = if ((action != null && !refused) || message.startsWith("SAVE_FAILED")) {
                    action ?: FailedAction("storage", "")
                } else null
                Log.e(CoreHost.TAG, "Core action failed action=${action?.kind ?: "read"} lock=${failed?.kind ?: "none"} ${failureForLog(failure)}")
                // Recorded before the UI update so a screen opening now still finds it.
                if (failed != null) {
                    ProcessCoreHost.recordFailure(ProcessCoreHost.PendingFailure(failed, message, menu.page, editor, screen, focus, projects, project, areaFilter))
                }
                if (stale) acknowledged(action!!)
                else ui {
                    // A read never replaces an owed command's retry, whatever order the failures arrive in.
                    val owed = failedAction?.takeIf { action == null && it.kind != "storage" }
                    if (owed == null) {
                        error = message
                        conflict = message.startsWith("STALE_REVISION")
                        if (failed != null) failedAction = failed
                    }
                }
            } finally {
                ui {
                    busy = false
                    if ((done || stale) && action != null) refreshAll()
                    finished?.invoke()
                }
            }
        }, "mindwtr-action").start()
        return true
    }
}
