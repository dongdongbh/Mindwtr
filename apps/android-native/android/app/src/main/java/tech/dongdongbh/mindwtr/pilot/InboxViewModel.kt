package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
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


data class MetaPart(
    val kind: String, val text: String, val detail: Boolean, val dotColor: String? = null, val tone: String? = null,
    val overflow: Int = 0, val done: Int = 0, val of: Int = 0, val spoken: String? = null,
)

data class RowSwipe(val target: String, val label: String, val icon: String)

data class RowMeta(
    val parts: List<MetaPart>, val priority: String?, val statusLabel: String?, val canFocus: Boolean,
    val swipe: RowSwipe, val rtl: Boolean, val accessibilityLabel: String, val hasDescription: Boolean = false,

    val statusHidden: Boolean = false,

    val validUntil: Long? = null,
) {

    val statusControl: String? get() = statusLabel?.takeUnless { statusHidden }
}


data class TaskRow(
    val id: String,
    val title: String,
    val status: String,
    val isFocusedToday: Boolean,
    val meta: RowMeta,
    val revealLabel: String? = null,
    val laterToday: Boolean = false,
    val taskRevision: String = "",

    val focusBlockedLabel: String? = null,
)

enum class Screen(val label: String) { Inbox("tab.inbox"), Focus("tab.next"), Projects("nav.projects") }


data class FailedAction(
    val kind: String,
    val id: String,
    val title: String = "",
    val base: Map<String, String?> = emptyMap(),
    val patch: Map<String, String?> = emptyMap(),
    val requestId: String = "",
    val attachments: String = "",
)


private fun withRequestId(action: FailedAction, owed: FailedAction?) =
    owed?.takeIf { it.copy(requestId = "") == action } ?: action.copy(requestId = UUID.randomUUID().toString())


private val FEED_LISTS = mapOf("calendar" to "calendar", "weeklyReview" to "weekly", "dailyReview" to "daily")
internal val UPDATE_REFUSALS = listOf("STALE_REVISION", "INVALID_INPUT", "TASK_NOT_FOUND")


private val STALE_SHOWN = setOf("saveDraft", "update", "calendarCreate", "manageEditor", "completeUndo", "inboxDecisionUndo", "taskCompletedAt")

private val REFUSABLE = setOf("complete", "completeUndo", "inboxDecisionUndo", "update", "saveDraft", "resetChecklist", "saveSearch", "inboxCommit", "inboxSkip", "capture", "captureLines", "capturePicker") + MENU_KINDS + CAPTURE_MODAL_KINDS + ATTACHMENT_KINDS + EDITOR_MENU_KINDS + PROJECT_DETAIL_KINDS


internal fun refusedUnwritten(kind: String?, message: String) =
    message.startsWith("STALE_REVISION") || (kind in REFUSABLE && UPDATE_REFUSALS.any { message.startsWith(it) })
        || (kind in setOf("completeUndo", "inboxDecisionUndo") && message.startsWith("ACTION_FAILED"))

private fun JSONObject.metaPart(): MetaPart = MetaPart(
    getString("kind"), getString("text"), getBoolean("detail"), text("dotColor"), text("tone"),
    optInt("overflowCount"), optInt("completed"), optInt("total"), text("accessibilityLabel"),
)

private fun JSONObject.text(name: String) = if (!has(name) || isNull(name)) null else getString(name)


fun toastDurationMs(toast: JSONObject?, action: String?): Long =
    toast?.takeIf { it.has("durationMs") && !it.isNull("durationMs") }?.getLong("durationMs") ?: if (action != null) 5_200 else 3_200


fun json(values: Map<String, String?>): String =
    JSONObject().apply { values.forEach { (name, value) -> put(name, value ?: JSONObject.NULL) } }.toString()


fun JSONObject.taskRow() = getJSONObject("meta").let { meta ->
    TaskRow(getString("id"), getString("title"), getString("status"), getBoolean("isFocusedToday"),
        RowMeta(meta.getJSONArray("parts").let { parts -> List(parts.length()) { parts.getJSONObject(it).metaPart() } },
            meta.text("priority"), meta.text("statusLabel"), meta.getBoolean("canFocus"),
            meta.getJSONObject("swipe").let { RowSwipe(it.getString("target"), it.getString("label"), it.getString("icon")) },
            meta.getString("textDirection") == "rtl", meta.getString("accessibilityLabel"),
            !meta.text("descriptionPreview").isNullOrEmpty(), meta.optBoolean("statusHidden"),
            meta.takeIf { it.has("validUntil") && !it.isNull("validUntil") }?.getLong("validUntil")),
        text("revealLabel"), getBoolean("laterToday"), optString("taskRevision"), text("focusBlockedLabel"))
}


fun JSONObject.taskRows(): List<TaskRow> = getJSONArray("rows").let { items ->
    List(items.length()) { index -> items.getJSONObject(index).taskRow() }
}


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

    fun deleteExcept(key: String?) { dir.listFiles()?.forEach { if (it.name != "editor-$key.json") it.delete() } }
}

private const val PAGE = 50

const val RELATIVE_AMOUNT = "relativeAmount"

const val WAITING_PROMPT = "waitingFor"

private const val SUGGESTIONS = 4

private const val SYNC_FALLBACK_MS = 3_000L

private const val ARCHIVE_RETENTION_MS = 15 * 60 * 1000L


internal fun archiveRetentionRun(awaitQuiet: () -> Unit, active: () -> Boolean, editor: () -> Boolean, project: () -> Boolean, busy: () -> Boolean,
    send: (Boolean) -> String): String? {
    awaitQuiet()
    return if (active()) send(editor() || project() || busy()) else null
}


private const val SPLASH_CAP_MS = 10_000L

private const val VIEW_WINDOW = 100


private class Stepped(val view: EditorModel, val checklist: String?, val focusId: String?)


private data class Depth(val focus: Map<String, Int>, val project: String?, val projectItems: Int, val controls: String)


private class Lists(val focus: FocusView?, val projects: ProjectsView?, val projectId: String?, val project: ProjectDetail?, val areas: AreaFilter)


class InboxViewModel(app: Application, private val saved: SavedStateHandle) : AndroidViewModel(app) {
    var loading by mutableStateOf(true); private set

    var slowStart by mutableStateOf(false); private set
    var writable by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set


    var capture by mutableStateOf<CaptureDraft?>(null); private set
    var failedAction by mutableStateOf<FailedAction?>(null); private set


    private val harnessStart = debugProperty("start_tab")

    var screen by mutableStateOf(Screen.entries.firstOrNull { it.name == saved.get<String>("screen") }
        ?: if (harnessStart == "inbox") Screen.Inbox else Screen.Focus); private set
    var focus by mutableStateOf<FocusView?>(null); private set


    var focusRevision by mutableStateOf(""); private set
    var projects by mutableStateOf<ProjectsView?>(null); private set

    var openProjectId by mutableStateOf(saved.get<String>("project")); private set
    var projectReturn = projectReturnOf(saved.get<String>("projectReturn")); private set
    var project by mutableStateOf<ProjectDetail?>(null); private set
    private val sandboxRequest = Workspace.decide(Workspace.store(app), ProcessCoreHost.booted, { Workspace.begin(app) }, { Workspace.restart(app) },
        refused = { reason -> Log.w(CoreHost.TAG, "Native Android sandbox request not used reason=$reason releaseCheck=v1.3.9/native-sandbox") })
    private val sandboxed = Workspace.sandbox
    private val prefs = Workspace.viewPrefs(app, sandbox = sandboxed)

    var focusView by mutableStateOf(FocusViewState.read(prefs)); private set

    var projectsView by mutableStateOf(ProjectsViewState.read(prefs)); private set

    var projectShowCompleted by mutableStateOf(prefs.getString(PROJECT_SHOW_COMPLETED_KEY, null) == "true"); private set

    var projectCompletedCollapsed by mutableStateOf(true); private set

    var areaFilter by mutableStateOf<AreaFilter?>(null); private set

    var areaSheet by mutableStateOf(false); private set

    var statusMenu by mutableStateOf<TaskRow?>(null); private set

    var destinationFor by mutableStateOf<TaskRow?>(null); private set
    var destinationQuery by mutableStateOf(""); private set
    var destinationPicker by mutableStateOf<JSONObject?>(null); private set

    var datesSheet by mutableStateOf<JSONObject?>(null); private set
    var datesPicker by mutableStateOf<String?>(null)
    private var datesFor: String? = null
    var toast by mutableStateOf<Toast?>(null); private set

    var projectDraft by mutableStateOf(saved.get<String>("projectDraft") ?: ""); private set
    var projectAreaId by mutableStateOf(saved.get<String>("projectAreaId")); private set
    var projectRequestId by mutableStateOf(saved.get<String>("projectRequestId") ?: UUID.randomUUID().toString()); private set


    var editor by mutableStateOf<TaskEditor?>(null); private set
    private val drafts = EditorDrafts(Workspace.dir(app, "editor", sandboxed))

    private var editorKey: String? = saved.get<String>("editorKey")

    private var pendingSave: FailedAction? = null

    private var saveQueued = false

    var suggestions by mutableStateOf<Map<String, EditorSuggestions>>(emptyMap()); private set

    var conflict by mutableStateOf(false); private set

    var taskView by mutableStateOf<JSONObject?>(null); private set
    private var taskViewDepth = VIEW_WINDOW

    var checklistFocus by mutableStateOf<String?>(null); private set

    var search by mutableStateOf(saved.get<String>("search")?.let(SearchState::restore)); private set

    var searchView by mutableStateOf<SearchView?>(null); private set

    var highlightTaskId by mutableStateOf<String?>(null); private set
    private var highlightList by mutableStateOf<String?>(null)
    private var highlightJob: Job? = null

    var processing by mutableStateOf<InboxProcessing?>(null); private set
    private val processingStore = ProcessingStore(Workspace.dir(app, "process-inbox", sandboxed))
    private val captureStore = CaptureStore(Workspace.dir(app, "capture", sandboxed))
    private val snapshots = File(app.filesDir, "snapshots")

    var processingMode by mutableStateOf(readProcessingMode(prefs)); private set

    val menu = MenuModel(this, saved, prefs, Workspace.dir(app, "menu", sandboxed))

    val lock = AppLock(this)

    val captureModal = CaptureModalModel(this, saved, Workspace.dir(app, "capture-modal", sandboxed))

    val prompts = StartupPromptsModel(this)

    val ai = AIActionsModel(this)

    val attachments = AttachmentsModel(this)

    val editorMenu = EditorMenuModel(this)

    val projectDetails = ProjectDetailsModel(this)

    val pomodoro = PomodoroModel(this)

    val nextAction: NextActionPromptModel = NextActionPromptModel(command = { menu.command("projectNextAction", it) },
        toast = { title, message -> showToast(title, message, "error", durationMs = 4200) },


        openEditor = { taskId -> menu.whenIdle { openEditor(taskId, "task") } })

    val completedAt = CompletedAtModel(this)


    val entries = EntryRouter(this, File(app.noBackupFilesDir, "entries"), SharedFileStager(File(app.cacheDir, "shared-entries"), ContentSharedFileSource(app)))

    var leaveApp by mutableStateOf(false); internal set
    @Volatile private var host: CoreHost? = null
    private var attaches = 0
    private val main = Handler(Looper.getMainLooper())
    private val started = SystemClock.uptimeMillis()

    private val voiceThreads = java.util.concurrent.Executors.newCachedThreadPool { work -> Thread(work, "mindwtr-voice-ui") }


    val voice = CaptureVoice(
        call = { name, input -> (host ?: error("No core host")).voiceRequest(name, input.toString()) },
        io = { work -> voiceThreads.execute(work) },
        ui = ::ui,
        notice = ::showVoiceNotice,


        saved = { reply -> finishCapture(JSONObject(reply.toString()).put("kind", "saved").apply { if (!has("next")) put("next", "close") }) },
        later = { delayMs, run -> main.postDelayed(run, delayMs) },
    )


    var voiceAlert by mutableStateOf<Pair<String, String>?>(null); private set
    fun dismissVoiceAlert() { voiceAlert = null }

    private fun showVoiceNotice(notice: VoiceNotice) {
        when (notice) {
            is VoiceNotice.Toast -> showToast(t(notice.titleKey), t(notice.messageKey), durationMs = 4200)
            is VoiceNotice.Alert -> voiceAlert = t(notice.titleKey) to t(notice.messageKey)
            is VoiceNotice.Core -> showToast(notice.notice)
        }
    }


    internal fun coreHost(): CoreHost? = host


    data class SyncBadge(val state: String, val color: String?)
    var syncBadge by mutableStateOf(badgeOf(ProcessCoreHost.syncState)); private set

    var syncActive by mutableStateOf(ProcessCoreHost.syncState?.optBoolean("active") == true); private set
    private var syncCycles = ProcessCoreHost.syncState?.optInt("cycles") ?: 0

    private var syncContent = ProcessCoreHost.syncState?.optInt("contentRevision") ?: 0

    private val syncListener: (JSONObject) -> Unit = { event -> ui { syncEvent(event) } }

    private var gmailShown: String? = null

    private fun badgeOf(event: JSONObject?) = SyncBadge(event?.optString("badge")?.ifEmpty { null } ?: "hidden", event?.takeUnless { it.isNull("color") }?.optString("color"))


    private fun syncEvent(event: JSONObject) {
        when (event.optString("type")) {
            "sync" -> {
                syncBadge = badgeOf(event)
                syncActive = event.optBoolean("active")
                val cycles = event.optInt("cycles")
                val content = event.optInt("contentRevision", syncContent + 1)
                if (cycles != syncCycles && content != syncContent) {
                    syncCycles = cycles
                    syncContent = content

                    menu.whenIdle { if (writable) refreshAll(synced = true) }
                } else {


                    syncCycles = cycles
                    if (menu.list == "settings") menu.settings.refresh()
                }
            }

            "calendarFeed" -> if (menu.list == FEED_LISTS[event.optString("slot")]) menu.whenIdle { if (writable) menu.refresh() }
            "toast" -> showToast(event, event.optString("action").ifEmpty { null }) { if (event.optString("open") == "sync") menu.openSyncSettings() }

            "gmailStatus" -> event.optJSONObject("status")?.let { status ->
                menu.settings.gmail.statusChanged(status)
                gmailCycleToShow(gmailShown, status)?.let { at -> gmailShown = at; menu.whenIdle { if (writable) refreshAll(synced = true) } }
            }
        }
    }


    var resumes by mutableIntStateOf(0); private set


    fun appState(state: String) {
        active = state == "active"
        if (state == "active") resumes += 1

        if (state == "background") keepLastRoute(force = true)
        ProcessCoreHost.appState(state)

        if (state == "active") pomodoro.refresh(planAlarms = true)

        if (state == "active" && resumes > 1 && menu.list == "calendar") menu.calendarFeed("calendar")
        if (state == "active") runArchiveRetention()
    }


    @Volatile private var active = false
    private val retentionRunning = java.util.concurrent.atomic.AtomicBoolean(false)


    private fun runArchiveRetention() {
        val runtime = host ?: return
        if (!active || busy || failedAction != null || !retentionRunning.compareAndSet(false, true)) return
        val askedAt = SystemClock.uptimeMillis()
        Thread({
            try {
                val outcome = archiveRetentionRun({ runtime.awaitQuiet(askedAt) { !active } }, { active }, { editor != null }, { openProjectId != null },
                    { busy }) { runtime.archiveRetention(it).optString("outcome") }
                if (outcome == "purged") ui { menu.whenIdle { if (writable) refreshAll() } }
            } catch (failure: Throwable) {
                Log.w(CoreHost.TAG, "Native Android archive retention failed ${failureForLog(failure)}")
            } finally {
                retentionRunning.set(false)
            }
        }, "mindwtr-archive-retention").start()
    }


    private fun focused(target: Screen) {
        if (target == Screen.Projects && menu.screen == null && menu.quickView == "calendar") menu.calendarFeed("calendar")
    }


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


    private val freshStart = saved.get<Boolean>("started") != true

    private var routeReady = false
    private var keptRoute: String? = null

    private val routeWrites = java.util.concurrent.Executors.newSingleThreadExecutor { Thread(it, "mindwtr-last-route") }

    private val routeAgeMs by lazy { if (BuildConfig.DEBUG) debugProperty("session_age_ms").toLongOrNull() ?: 0L else 0L }

    init {
        saved["started"] = true
        ProcessCoreHost.listenSync(syncListener)
        viewModelScope.launch { while (true) { kotlinx.coroutines.delay(ARCHIVE_RETENTION_MS); runArchiveRetention() } }
        saved["projectRequestId"] = projectRequestId
        val at = depth()
        val savedDraft = editorKey?.let(drafts::read)
        drafts.deleteExcept(if (savedDraft != null) editorKey else null)
        if (savedDraft == null) keepKey(null)

        val storedProcessing = processingStore.read()
        val reopenProcessing = storedProcessing?.takeIf { saved.get<Boolean>("processing") == true }


        val storedCapture = captureStore.read()
        val reopenCapture = storedCapture?.takeIf { saved.get<Boolean>("capturing") == true || it.pending != null }

        main.postDelayed({ if (holdSplash()) { slowStart = true; host?.let { logSlowStart(it, "read") } } }, SPLASH_CAP_MS)
        Thread({
            try {

                debugProperty("boot_delay_ms").toLongOrNull()?.let(Thread::sleep)
                val runtime = ProcessCoreHost.get(getApplication(), prefs.getString(LANGUAGE_KEY, null), sandboxRequest)

                applyDeviceChoices(runtime, prefs)
                applySyncedChoices(runtime, prefs)

                lock.boot(runtime)
                ProcessCoreHost.failure?.let { pending -> ui { host = runtime; restore(pending, storedProcessing, storedCapture); keepRoutes() }; return@Thread }

                val lastRoute = if (freshStart && harnessStart.isEmpty() && entries.head == null) runCatching { runtime.sessionRestoreRead().optJSONObject("route") }
                    .onFailure { Log.w(CoreHost.TAG, "Last screen not read ${failureForLog(it)}") }.getOrNull() else null

                val lists = try {
                    read(runtime, at, screen)
                } catch (failure: Throwable) {

                    ProcessCoreHost.failure?.let { pending -> ui { host = runtime; restore(pending, storedProcessing, storedCapture); keepRoutes() }; return@Thread }
                    throw failure
                }

                val sheet = runCatching { menu.readSheet(runtime) }.getOrNull()

                val restored = savedDraft?.let { draft ->
                    runCatching { withView(runtime, TaskEditor.restore(readEditor(runtime, draft.getString("id")), draft)) }
                        .onFailure { Log.w(CoreHost.TAG, "Editor draft not restored ${failureForLog(it)}") }.getOrNull()
                }
                ui {
                    host = runtime; showLists(lists, ++issued); writable = true; loading = false

                    if (screen == Screen.Focus && lists.focus == null) refreshFocus()
                    if (screen == Screen.Projects && lists.projects == null) refreshProjects()
                    if (slowStart) logSlowStart(runtime, "boot")


                    ProcessCoreHost.aboutStartup(runtime)
                    prompts.start(runtime)

                    voice.refreshDefault()
                    if (screen != Screen.Inbox) ProcessCoreHost.startDeferredSync()
                    main.postDelayed({ ProcessCoreHost.startDeferredSync("boot-timeout") }, SYNC_FALLBACK_MS)
                    restored?.let { resumeEditor(it, savedDraft.optJSONObject("pending")) }

                    pumpEdits()

                    runArchiveRetention()
                    if (reopenProcessing != null) resumeProcessing(reopenProcessing) else processingStore.delete()
                    if (reopenCapture != null) resumeCapture(reopenCapture) else captureStore.delete()

                    menu.start(sheet)
                    captureModal.resume()

                    if (entries.head == null) lastRoute?.let { entries.openRestored(it.getString("pathname"), it.optJSONObject("params") ?: JSONObject()) }
                    keepRoutes()

                    menu.settings.transfer.leftover()
                    search?.let { current ->
                        readSearch()

                        current.submitted?.let { name -> if (failedAction == null) saveSearchAction(current, name).let { failedAction = it; sendSaveSearch(it) } }
                    }
                }
            } catch (failure: Throwable) {
                Log.e(CoreHost.TAG, "Core boot failed", failure)

                ui {
                    error = failure.message ?: failure.javaClass.simpleName
                    loading = false
                }
            }
        }, "mindwtr-startup").start()
    }


    fun holdSplash(): Boolean {

        if (!splashGone) splashGone = slowStart || !(loading || writable && failedAction == null && error == null && menu.firstPagePending)
        return !splashGone
    }
    private var splashGone = false


    private fun logSlowStart(runtime: CoreHost, stage: String) {
        val context = JSONObject().put("releaseCheck", "v1.3.5/native-splash-cap").put("stage", stage)
            .put("durationMs", SystemClock.uptimeMillis() - started)
        Thread({ runtime.logLine("Native Android start screen released by its cap releaseCheck=v1.3.5/native-splash-cap", context) }, "mindwtr-log").start()
    }


    fun attach() {
        attaches += 1
        if (attaches > 1) ProcessCoreHost.logHostReuse("activity-recreate", attaches, busy)
    }


    fun contentShown() {
        if (focus == null) refreshFocus()
        if (projects == null) refreshProjects()
        ProcessCoreHost.contentShown()
    }


    private fun currentRoute() = lastRouteOf(screen, menu.quickView, menu.screen, menu.historyTab, openProjectId,
        menu.own("savedSearch").optString("id").ifEmpty { null }, search != null, menu.sheet)
    private fun routeKey() = currentRoute()?.let { it.pathname + it.params }


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

        if (routeWrites.isShutdown) return
        runCatching {
            routeWrites.execute {
                runCatching { runtime.sessionRestoreWrite(route.pathname, route.params.toString(), ageMs) }
                    .onFailure { Log.w(CoreHost.TAG, "Last screen not stored ${failureForLog(it)}") }
            }
        }
    }


    fun firstContentReady(): Boolean = !loading && host != null && when {
        menu.screen != null -> !menu.firstPagePending
        screen == Screen.Focus -> focus != null
        screen == Screen.Projects -> if (menu.quickView == "projects") projects != null else !menu.firstPagePending
        else -> !menu.firstPagePending
    }


    fun show(target: Screen) {
        val switched = target != screen
        if (switched) { keepProjectReturn(null); closeRowChecklists() }
        screen = target
        saved["screen"] = target.name
        if (switched) focused(target)
    }

    private fun keepKey(key: String?) {
        editorKey = key
        saved["editorKey"] = key
    }


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

        if (action.kind in CAPTURE_KINDS) storedCapture?.let { keepCapture(it.copy(pending = action)) }
        if (action.kind in CAPTURE_MODAL_KINDS) captureModal.restored(action)

        if (action.kind == "saveSearch") keepSearch(SearchState(action.title, saveName = action.patch["name"], saveRequestId = action.id, submitted = action.patch["name"]))
        if (action.kind in STEP_KINDS) storedProcessing?.let { keepProcessing(it.copy(pending = action)) }
        if (action.kind == "createProject") setProjectDraft(action.title, action.base["areaId"], action.id)
        areaFilter = pending.areas
        if (action.kind == "saveDraft") pendingSave = action
        pending.editor?.let(::keepEditor)

        pending.menuPage?.let(menu::restorePage)
        focus = pending.focus
        focusRevision = pending.focus?.revision.orEmpty()
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


    fun completeAction(id: String, taskRevision: String) = FailedAction("complete", id, patch = mapOf("taskRevision" to taskRevision))


    fun complete(id: String, taskRevision: String, askNext: Boolean = false) {
        val action = completeAction(id, taskRevision)
        perform(action) { runtime ->
            val reply = runtime.completeTask(id, taskRevision)
            acknowledged(action)
            val toast = reply.optJSONObject("toast")
            val undo = reply.optJSONObject("undo")
            if (toast != null && undo != null) {
                ui { showToast(null, toast.getString("message"), "info", toast.getString("undoLabel"), 5200) { undoCompletion(undo.put("id", id)) } }
                if (askNext) askNextAction(runtime, id)
            }
        }
    }


    internal fun askNextAction(runtime: CoreHost, taskId: String) {

        val prompt = runCatching { runtime.menuRead("projectNextActionPrompt", JSONObject().put("taskId", taskId).toString()).optJSONObject("prompt") }
            .onFailure { Log.w(CoreHost.TAG, "Project next action prompt not read ${failureForLog(it)}") }.getOrNull()
        if (prompt != null) ui { nextAction.show(prompt) }
    }


    fun undoInboxDecision(receipt: JSONObject) {
        val action = FailedAction("inboxDecisionUndo", receipt.getString("taskId"), patch = mapOf("receipt" to receipt.toString()))
        perform(action) { runtime ->
            runtime.undoInboxDecision(receipt.toString())
            acknowledged(action)
        }
    }


    fun undoCompletion(undo: JSONObject) {
        val action = FailedAction("completeUndo", undo.getString("id"), patch = mapOf("undo" to undo.toString()))
        perform(action) { runtime ->
            runtime.undoTaskCompletion(undo.toString())
            acknowledged(action)
        }
    }


    internal fun acknowledged(action: FailedAction) {
        ProcessCoreHost.clearFailure(action)
        ui { failedAction = null }
    }


    internal fun owe(action: FailedAction) { failedAction = action }


    private fun readEditor(runtime: CoreHost, id: String): EditorModel {
        val model = runtime.taskEditorModel(id)
        val view = runtime.taskView(JSONObject().put("id", id).toString())
        val field = if (view.getBoolean("readOnly")) null
            else runtime.editTaskChecklist(id, model.getJSONObject("draft").toString(), view.getJSONArray("checklistBase").toString(), "").getJSONObject("field")
        return EditorModel.of(model, view, field)
    }


    fun openEditor(id: String, routeTab: String? = null) {
        val mode = prefs.getString(TASK_OPEN_MODE_KEY, null)
        val automatic = routeTab ?: if (menu.screen == null && screen == Screen.Inbox && search == null) "task" else "view"
        perform { runtime ->
            val opened = readEditor(runtime, id)
            val tab = if (opened.readOnly) "view" else if (routeTab == "task") "task" else if (mode == "preview") "view" else if (mode == "edit") "task" else automatic
            ui { suggestions = emptyMap(); taskView = null; taskViewDepth = VIEW_WINDOW; keepEditor(TaskEditor.open(opened, tab)) }
        }
    }


    internal fun openSavedTask(taskId: String, projectId: String?) = menu.whenIdle {
        closeSearch()
        menu.closeSheet()
        if (projectId != null) openFromSearch(Screen.Projects, projectId) else { menu.toTabs(); show(Screen.Focus); highlight(taskId) }
        menu.whenIdle { openEditor(taskId, "task") }
    }


    private fun withView(runtime: CoreHost, current: TaskEditor): TaskEditor {
        val sent = current.fullDraft()
        return current.viewed(stepEditor(runtime, current, sent, "").view, sent)
    }


    private fun stepEditor(engine: CoreHost, current: TaskEditor, sent: Map<String, String>, edit: String): Stepped {
        val queued = edit.takeIf { it.isNotEmpty() }?.let { JSONObject(it).optJSONObject("checklist") }

        val listEdit = queued?.let { currentChecklistEdit(it, current.checklistNow) }
        val checked = listEdit?.let { engine.editTaskChecklist(current.id, draftJson(sent), current.checklistNow, it.toString()) }
        val list = checked?.getJSONArray("checklist")?.toString() ?: current.checklistNow

        val model = engine.editTaskDraft(current.id, checked?.getJSONObject("draft")?.toString() ?: draftJson(sent), if (queued == null) edit else "", list)
        val field = if (current.readOnly) null else engine.editTaskChecklist(current.id, model.getJSONObject("draft").toString(), list, "").getJSONObject("field")
        return Stepped(current.model.edited(model, field), checked?.let { list }, checked?.menuText("focusId"))
    }


    val editsPending get() = editor?.pending?.isNotEmpty() == true

    var editorPickerOpen by mutableStateOf(false)


    val editorClean get() = editor?.closesOnNavigation(editsPending, covered = editorPickerOpen || attachments.link != null || attachments.view != null
        || ai.working == "editor" || ai.answer != null || editorMenu.promoteTitle != null) ?: true

    private var inFlight: Pair<String, Long>? = null

    private var editRefusal: String? = null


    fun editDraft(edit: JSONObject, field: String? = null) {
        val current = editor ?: return
        keepEditor(current.queued(edit.toString(), field))
        pumpEdits()
    }


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


            val now = editor?.takeIf { it.session == ticket.first && it.pending.firstOrNull()?.seq == ticket.second }
                ?: return@background pumpEdits()
            reply.onSuccess { step ->

                keepEditor(now.viewed(step.view, sent).copy(pending = now.pending.drop(1)).withChecklist(step.checklist ?: now.checklist))
                step.focusId?.let { checklistFocus = it }
                if (error != null && error == editRefusal) error = null
                editRefusal = null
            }.onFailure { failure ->


                Log.w(CoreHost.TAG, "Editor edit refused", failure)
                keepEditor(now.refused(now.pending.first()))
                editRefusal = failure.message ?: failure.javaClass.simpleName
                error = editRefusal
                saveQueued = false
            }
            pumpEdits()
            if (!editsPending && saveQueued && editor?.waiting == false) { saveQueued = false; saveEditor() }
        }
    }


    private fun currentChecklistEdit(edit: JSONObject, checklist: String): JSONObject? {
        if (!edit.has("itemId")) return edit
        val items = JSONArray(checklist)
        val index = (0 until items.length()).firstOrNull { items.getJSONObject(it).getString("id") == edit.getString("itemId") } ?: return null
        val sent = JSONObject(edit.toString()).apply { remove("itemId"); remove("step") }
        if (edit.getString("kind") != "move") return sent.put("index", index)
        val to = index + edit.getInt("step")
        return if (to in 0 until items.length()) sent.put("from", index).put("to", to) else null
    }


    fun editChecklist(edit: JSONObject, field: String? = null) = editDraft(JSONObject().put("checklist", edit), field)


    fun checklistFocused() { checklistFocus = null }


    fun typeChecklistAdd(text: String) { editor?.takeIf { it.checklistAdd != text }?.let { keepEditor(it.copy(checklistAdd = text)) } }


    fun submitChecklistAdd() {
        val current = editor ?: return
        val queued = current.checklistAddQueued()
        if (queued === current) return
        keepEditor(queued)
        pumpEdits()
    }


    fun editorTab(tab: String) { editor?.let { keepEditor(it.copy(tab = tab)) } }


    fun readTaskView(more: Boolean = false) {
        val current = editor ?: return
        if (more) taskViewDepth += VIEW_WINDOW
        val depth = taskViewDepth
        val input = JSONObject().put("id", current.id)
        if (!current.readOnly) input.put("draft", JSONObject(draftJson(current.fullDraft()))).put("checklist", JSONArray(current.checklistNow))

        if (!current.readOnly && current.attachments != null) input.put("attachments", JSONArray(current.attachmentsNow))
        background(listOf(Part.TaskView), { runtime -> readView(runtime, input, depth) }) { view, mine ->
            if (fresh(mine, Part.TaskView) && editor?.id == current.id) taskView = view
        }
    }


    private fun readView(runtime: CoreHost, input: JSONObject, depth: Int): JSONObject {
        val first = runtime.taskView(JSONObject(input.toString()).put("offset", 0).put("limit", VIEW_WINDOW).toString())
        val checklist = { view: JSONObject -> view.menuObjects("rows").firstOrNull { it.getString("type") == "checklist" } }
        val items = checklist(first)?.getJSONArray("items") ?: return first
        try {
            while (items.length() < minOf(depth, checklist(first)!!.getInt("total"))) {
                val next = checklist(runtime.taskView(JSONObject(input.toString()).put("offset", items.length()).put("limit", VIEW_WINDOW)
                    .put("revision", first.getString("revision")).toString()))?.getJSONArray("items")
                if (next == null || next.length() == 0) break
                for (index in 0 until next.length()) items.put(next.get(index))
            }
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
        return first
    }


    fun resetChecklist() {
        val current = editor ?: return

        val revision = taskView?.takeIf { it.getString("id") == current.id }?.optString("taskRevision") ?: return
        sendReset(FailedAction("resetChecklist", current.id, UUID.randomUUID().toString(), patch = mapOf("taskRevision" to revision)))
    }

    private fun sendReset(action: FailedAction) = perform(action) { runtime ->
        try {
            runtime.resetTaskChecklist(action.id, action.title, action.patch["taskRevision"].orEmpty())
        } catch (failure: Exception) {

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


    fun editFields(values: Map<String, Any?>) =
        editDraft(JSONObject().put("type", "fields").put("patch", JSONObject().apply { values.forEach { (field, value) -> put(field, value ?: JSONObject.NULL) } }))


    internal fun applyAIEdit(edit: JSONObject) {
        val current = editor ?: return
        val patch = edit.optJSONObject("patch")
        val typed = buildMap { for (field in TYPED_FIELDS) if (patch?.has(field) == true) put(field, patch.getString(field)) }
        keepEditor(current.copy(inputs = current.inputs + typed, resolved = current.resolved + typed))
        editDraft(edit)
    }


    internal fun addAISteps(checklist: String, edit: JSONObject?) {
        val current = editor ?: return
        if (editsPending) { main.postDelayed({ addAISteps(checklist, edit) }, 100); return }
        keepEditor(current.withChecklist(checklist).queued(edit?.toString() ?: "", null))
        pumpEdits()
    }


    internal fun setDraftAttachments(taskId: String, next: String) {
        editor?.takeIf { it.id == taskId }?.let { keepEditor(it.withAttachments(next)) }
    }


    fun editText(field: String, text: String) { editor?.let { keepEditor(it.edit(mapOf(field to text))) } }


    fun editInput(field: String, text: String) {
        val current = editor ?: return
        keepEditor(current.typed(field, text))
        suggest(field, text)
    }


    fun suggest(field: String, text: String) {
        val id = editor?.id ?: return

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


    fun closeEditor(settle: Boolean = true) {
        val closed = editor

        editor?.takeIf { discardSettles(settle, pendingSave != null, it.attachments != null, it.readOnly) }?.let { closing ->
            val from = closing.attachmentsFrom ?: closing.model.attachmentsBase
            attachments.settle(closing.id, closing.model.taskRevision, from, closing.attachmentsNow, from)
        }
        attachments.closed()
        editorMenu.closed()
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

        if (processing?.takeUnless { it.hidden }?.taskId == closed?.id) editStep(JSONObject().put("reload", true))
    }


    fun openWaitingPrompt() { editor?.let { keepEditor(it.copy(waitingFor = it.input("assignedTo"))); suggest(WAITING_PROMPT, it.input("assignedTo")) } }

    fun editWaitingPrompt(text: String) {
        editor?.let { keepEditor(it.copy(waitingFor = text)) }
        suggest(WAITING_PROMPT, text)
    }

    fun closeWaitingPrompt() { editor?.let { keepEditor(it.copy(waitingFor = null)) } }


    fun confirmWaiting() {
        val current = editor ?: return
        val person = current.waitingFor.orEmpty()
        keepEditor(current.assignWaiting(person))
        editFields(mapOf("status" to "waiting", "assignedTo" to person))
    }


    fun saveDraftAction(current: TaskEditor) =
        withRequestId(FailedAction("saveDraft", current.id, current.checklistSave, base = current.base, patch = current.patch,
            attachments = current.attachmentsSave), failedAction)


    fun saveEditor() {

        if (editor?.checklistAdd?.isNotBlank() == true) submitChecklistAdd()
        val current = editor ?: return
        if (current.waiting || editsPending) { saveQueued = true; return }
        if (current.patch.isEmpty() && !current.checklistChanged && !current.attachmentsChanged) { closeEditor(); return }
        if (busy || (failedAction != null && failedAction != saveDraftAction(current))) return
        val action = saveDraftAction(current)
        pendingSave = action
        keepEditor(current)
        sendDraft(action)
    }


    private fun sendDraft(action: FailedAction) = perform(action) { runtime ->
        try {
            runtime.saveTaskDraft(action.id, draftJson(action.base), draftJson(action.patch), action.title, action.attachments, action.requestId)
        } catch (failure: Exception) {

            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) ui { pendingSave = null; failedAction = null; editor?.let(::keepEditor) }
            throw failure
        }
        acknowledged(action)

        if (action.attachments.isNotEmpty()) attachments.settleSaved(runtime, action.id, JSONObject(action.attachments))

        ui { editorMenu.saved(action.id); closeEditor(settle = false) }
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


    fun refresh() {
        val at = depth()
        val mine = ++issued
        perform { runtime ->
            val lists = read(runtime, at)

            ui { showLists(lists, mine); menu.retryRead() }
        }
    }


    fun refreshFocus() {

        if (focus == null && busy) return menu.whenIdle(::refreshFocus)
        val depth = focus.depth()
        val controls = menu.focusControls.state.toString()
        background(listOf(Part.Focus), { runtime -> readFocus(runtime, null, depth, controls) }) { view, mine -> if (fresh(mine, Part.Focus)) showFocus(view) }
    }


    fun loadMoreFocus(key: String) {
        val view = focus?.copy(revision = focusRevision) ?: return
        val depth = view.depth() + (key to (view.section(key)?.rows?.size ?: 0) + PAGE)
        val mine = ++issued
        perform { runtime ->
            val next = readFocus(runtime, view, depth, view.state.toString())
            ui { if (fresh(mine, Part.Focus)) showFocus(next) }
        }
    }


    internal fun editFocusControls(edit: JSONObject) {
        val depth = focus.depth()
        val controls = menu.focusControls.state.toString()
        val mine = ++issued
        perform { runtime ->
            val next = readFocus(runtime, null, depth, controls, edit.toString())
            ui { if (fresh(mine, Part.Focus)) showFocus(next) }
        }
    }


    private fun showFocus(view: FocusView?) {
        focusRevision = view?.revision.orEmpty()

        if (view != null && focus?.sameShown(view) == true) return
        focus = view
        view?.let(menu.focusControls::adopt)

        pomodoro.refresh()
    }


    internal fun focusRevision(): String = focusRevision

    private fun FocusView?.depth(): Map<String, Int> = this?.sections?.associate { it.key to it.rows.size }.orEmpty()

    private fun depth() = Depth(focus.depth(), openProjectId, maxOf(PAGE, project?.items?.size ?: 0), menu.focusControls.state.toString())


    fun toggle(group: String) {
        val view = projectsView
        projectsView = if (group == "deferred") view.copy(showDeferred = !view.showDeferred) else view.copy(showArchived = !view.showArchived)
        projectsView.save(prefs)
    }


    var areaManager by mutableStateOf<JSONObject?>(null); private set

    var areaManagerDraft by mutableStateOf(AreaManagerDraft()); private set
    fun openAreaManager(focus: String? = null, name: String = "") {
        areaManager = JSONObject()
        areaManagerDraft = AreaManagerDraft(focus = focus)
        readAreaManager()
        if (focus != null) startAreaRename(focus, name)
    }

    fun startAreaRename(areaId: String, name: String) {
        areaManagerDraft = areaManagerDraft.copy(renaming = areaId, renameName = name, renameCheck = null)
        editAreaRename(name)
    }

    fun cancelAreaRename() { areaManagerDraft = areaManagerDraft.copy(renaming = null, renameName = "", renameCheck = null) }

    fun editAreaRename(name: String) {
        val areaId = areaManagerDraft.renaming ?: return
        areaManagerDraft = areaManagerDraft.copy(renameName = name, renameCheck = null)
        background(emptyList(), { runtime -> runtime.menuRead("areaRenameCheck", JSONObject().put("areaId", areaId).put("name", name).toString()) }) { check, _ ->
            if (areaManagerDraft.renaming == areaId && areaManagerDraft.renameName == name) areaManagerDraft = areaManagerDraft.copy(renameCheck = check)
        }
    }

    fun saveAreaRename() {
        val draft = areaManagerDraft
        val areaId = draft.renaming ?: return
        if (!draft.canRename) return
        menu.command("areaRename", JSONObject().put("areaId", areaId).put("name", draft.renameName))
    }

    internal fun areaRenamed(reply: JSONObject) {
        if (reply.optString("outcome") == "taken") return showToast(t("common.notice"), t("areas.nameExists"), "warning")
        if (areaManagerDraft.renaming == reply.optString("id")) cancelAreaRename()
    }


    var projectMenu by mutableStateOf<String?>(null); private set
    fun openProjectMenu(projectId: String?) { projectMenu = projectId }

    var areaMove by mutableStateOf<Pair<String, JSONObject>?>(null); private set
    fun openAreaMove(projectId: String) {
        projectMenu = null
        background(emptyList(), { runtime -> runtime.menuRead("projectAreaOptions", JSONObject().put("projectId", projectId).toString()) }) { options, _ ->
            areaMove = projectId to options
        }
    }
    fun closeAreaMove() { areaMove = null }
    fun moveToArea(area: JSONObject?) {
        val (projectId, _) = areaMove ?: return
        areaMove = null
        projectDetails.moveToArea(projectId, area)
    }
    fun manageAreasFromMove() { areaMove = null; openAreaManager() }
    fun closeAreaManager() { areaManager = null; areaManagerDraft = AreaManagerDraft() }
    fun expandAreaColor(areaId: String?) { areaManagerDraft = areaManagerDraft.copy(expanded = areaId) }
    fun pickNewAreaColor(color: String) { areaManagerDraft = areaManagerDraft.copy(color = color) }

    fun editNewAreaName(name: String) {
        areaManagerDraft = areaManagerDraft.copy(name = name, check = null)
        val target = areaManager?.optJSONObject("newArea") ?: return
        background(emptyList(), { runtime -> runtime.menuRead("manageCheck", JSONObject().put("target", target).put("name", name).toString()) }) { check, _ ->
            if (areaManagerDraft.name == name) areaManagerDraft = areaManagerDraft.copy(check = check)
        }
    }

    fun setAreaColor(areaId: String, color: String?) {
        areaManagerDraft = areaManagerDraft.copy(expanded = null)
        menu.command("areaColor", JSONObject().put("areaId", areaId).put("color", color ?: JSONObject.NULL))
    }


    fun deleteArea(area: JSONObject) = menu.command("manageDelete", JSONObject().put("target", area.getJSONObject("delete")).put("ifUnused", true))

    fun addArea() {
        val draft = areaManagerDraft
        val name = draft.name.trim()
        if (!draft.canSave) return
        val sheet = areaManager ?: return
        val color = draft.color ?: sheet.optJSONArray("colors")?.optString(0) ?: return
        menu.settings.createArea(sheet.getJSONObject("newArea"), name, color)
        closeAreaManager()
    }

    fun readAreaManager() {
        if (areaManager == null) return
        background(emptyList(), { runtime -> runtime.menuRead("projectAreaManager", "{}") }) { reply, _ -> if (areaManager != null) areaManager = reply }
    }

    fun orderAreas(intent: JSONObject) {
        val shown = areaManager?.takeIf { it.has("areas") }?.menuObjects("areas")?.map { it.getString("id") } ?: return
        menu.command("areaOrder", JSONObject().put("intent", intent).put("order", JSONArray(shown)))
    }


    fun toggleArea(areaId: String) {
        val collapsed = projectsView.collapsedAreas
        projectsView = projectsView.copy(collapsedAreas = if (areaId in collapsed) collapsed - areaId else collapsed + areaId)
        projectsView.save(prefs)
    }


    fun toggleFocusSection(key: String) {
        focusView = focusView.with(mapOf(key to !focusView.isOpen(key)))
        focusView.save(prefs)
    }


    private fun focusFolds() = GroupCollapse.all(prefs, "focus-next", 200).apply {
        GroupCollapse.axis(prefs, "focus-schedule", "schedule", 200).let { later -> for (index in 0 until later.length()) put(later.getString(index)) }
    }


    fun toggleFocusGroup(heading: JSONObject) {
        val axis = heading.getString("axis")
        GroupCollapse.toggle(prefs, if (axis == "schedule") "focus-schedule" else "focus-next", axis, heading.getString("id"))
        refreshFocus()
    }


    fun setFocusDetails(on: Boolean) {
        focusView = focusView.withDetails(on)
        focusView.save(prefs)
    }


    fun setOtherFocusSections(open: Boolean) {
        focusView = focusView.with(FOCUS_SECTION_KEYS.associateWith { it == "focus" || open })
        focusView.save(prefs)
    }

    fun showAreaSheet(open: Boolean) { areaSheet = open }

    fun showStatusMenu(task: TaskRow?) {
        statusMenu = task
        checklistMoveEligible = null
        if (task != null && task.status == "inbox") readChecklistTargets(task.id, "", eligibleOnly = true) { reply -> if (statusMenu?.id == task.id) checklistMoveEligible = task.id.takeIf { reply.getBoolean("eligible") } }
    }

    var checklistMoveEligible by mutableStateOf<String?>(null); private set
    var checklistTargetsFor by mutableStateOf<TaskRow?>(null); private set
    var checklistTargets by mutableStateOf<JSONObject?>(null); private set
    var checklistTargetQuery by mutableStateOf(""); private set

    fun openChecklistTargets(task: TaskRow) {
        statusMenu = null
        checklistTargetsFor = task
        checklistTargetQuery = ""
        checklistTargets = null
        readChecklistTargets(task.id, "") { reply -> if (checklistTargetsFor?.id == task.id && checklistTargetQuery.isEmpty()) checklistTargets = reply }
    }

    fun searchChecklistTargets(text: String) {
        val task = checklistTargetsFor ?: return
        checklistTargetQuery = text
        readChecklistTargets(task.id, text) { reply -> if (checklistTargetsFor?.id == task.id && checklistTargetQuery == text) checklistTargets = reply }
    }

    fun closeChecklistTargets() {
        checklistTargetsFor = null
        checklistTargets = null
    }

    fun moveToChecklist(targetId: String) {
        val task = checklistTargetsFor ?: return
        closeChecklistTargets()
        menu.command("taskChecklistMove", JSONObject().put("sourceId", task.id).put("targetId", targetId))
    }

    internal fun checklistMoved(sourceId: String, targetId: String, toast: JSONObject) {
        showToast(null, toast.getString("message"), "info", toast.getString("undoLabel"), 5_200) {
            menu.whenIdle { menu.command("taskChecklistMoveUndo", JSONObject().put("sourceId", sourceId).put("targetId", targetId)) }
        }
    }

    private fun readChecklistTargets(sourceId: String, query: String, eligibleOnly: Boolean = false, apply: (JSONObject) -> Unit) {
        val input = JSONObject().put("sourceId", sourceId).put("query", query).apply { if (eligibleOnly) put("eligibleOnly", true) }
        background(listOf(Part.MenuDialog), { runtime -> runtime.menuRead("checklistTargets", input.toString()) }) { reply, _ -> apply(reply) }
    }


    var pullSync by mutableStateOf("idle"); private set
    private var pullRunning = false
    private var pullShown = 0


    fun pullToSync() {
        val runtime = host ?: return
        if (pullRunning) return
        pullRunning = true
        pullSync = "syncing"
        val mine = ++pullShown
        Thread({
            val outcome = runCatching { runtime.pullSync() }.getOrElse { failure ->
                Log.w(CoreHost.TAG, "Pull to sync failed ${failureForLog(failure)}")
                pullSyncFailure(t("settings.lastSyncError"), failure)
            }
            ui {
                pullRunning = false
                val indicator = outcome.optString("indicator", "error")
                pullSync = if (indicator == "idle") "idle" else indicator
                if (indicator != "idle") main.postDelayed({ if (mine == pullShown && !pullRunning) pullSync = "idle" }, 900)
                outcome.optJSONObject("toast")?.let { showToast(it) }
            }
        }, "mindwtr-pull-sync").start()
    }


    fun openDestination(task: TaskRow) {
        statusMenu = null
        destinationFor = task
        destinationQuery = ""
        destinationPicker = null
        readDestination()
    }


    fun searchDestination(text: String) {
        destinationQuery = text
        readDestination()
    }

    fun closeDestination() {
        destinationFor = null
        destinationPicker = null
    }

    private fun readDestination() {
        val task = destinationFor ?: return
        val query = destinationQuery
        background(listOf(Part.MenuDialog), { runtime -> runtime.menuRead("taskDestination", JSONObject().put("id", task.id).put("query", query).toString()) }) { reply, _ ->
            if (destinationFor?.id == task.id && destinationQuery == query) destinationPicker = reply
        }
    }


    fun openDates(task: TaskRow) {
        datesFor = task.id
        datesSheet = null
        datesPicker = null
        readDates(JSONObject().put("taskId", task.id))
    }

    fun editDates(field: String, value: String) = datesSheet?.let { sheet ->
        readDates(datesInput(sheet).put("draft", JSONObject(sheet.getJSONObject("draft").toString()).put(field, value)))
    }

    fun pickDatesDay(field: String, day: String) = datesSheet?.let { sheet ->
        readDates(datesInput(sheet).put("pick", JSONObject().put("field", field).put("day", day)))
    }

    private fun datesInput(sheet: JSONObject) =
        JSONObject().put("taskId", sheet.getString("taskId")).put("base", sheet.getJSONObject("base")).put("draft", sheet.getJSONObject("draft"))

    private fun readDates(input: JSONObject) {
        val taskId = input.getString("taskId")
        background(listOf(Part.MenuDialog), { runtime -> runtime.menuRead("taskDates", input.toString()).getJSONObject("sheet") }) { sheet, _ ->
            if (datesFor == taskId) datesSheet = sheet
        }
    }

    fun closeDates() {
        datesFor = null
        datesSheet = null
        datesPicker = null
    }

    fun saveDates() {
        val sheet = datesSheet ?: return
        closeDates()
        if (sheet.getJSONObject("draft").toString() == sheet.getJSONObject("base").toString()) return
        menu.command("taskDatesSave", JSONObject().put("taskId", sheet.getString("taskId")).put("base", sheet.getJSONObject("base"))
            .put("draft", sheet.getJSONObject("draft")))
    }

    fun swipeFocus(task: TaskRow) = menu.command("taskSwipeFocus", JSONObject().put("taskId", task.id).put("taskRevision", task.taskRevision))

    val rowChecklistOpen = mutableStateMapOf<String, Boolean>()
    val rowChecklists = mutableStateMapOf<String, JSONObject>()
    val rowChecklistDrafts = mutableStateMapOf<String, String>()
    private var rowChecklistVersion by mutableIntStateOf(0)
    private val rowChecklistEdits = RowChecklistEdits(
        schedule = { key, delay, run -> main.postAtTime(run, key.intern(), android.os.SystemClock.uptimeMillis() + delay) },
        cancel = { key -> main.removeCallbacksAndMessages(key.intern()) },
        send = { _, payload -> menu.whenIdle { payload()?.let { menu.command("taskRowChecklistEdit", it) } } },
        changed = { rowChecklistVersion += 1 },
    )

    fun toggleRowChecklist(taskId: String) {
        if (rowChecklistOpen.remove(taskId) == true) rowChecklistEdits.flush(taskId) else rowChecklistOpen[taskId] = true
    }

    fun closeRowChecklists() {
        if (rowChecklistOpen.isEmpty()) return
        rowChecklistOpen.keys.toList().forEach(rowChecklistEdits::flush)
        rowChecklistOpen.clear()
    }

    fun readRowChecklist(taskId: String) {
        if (busy) return menu.whenIdle { readRowChecklist(taskId) }
        background(emptyList(), { runtime -> runtime.menuRead("taskRowChecklist", JSONObject().put("taskId", taskId).toString()).getJSONObject("checklist") }) { read, _ ->
            if (failedAction == null && rowChecklistEdits.isOwed(taskId)) rowChecklistEdits.settled(taskId, RowChecklistOutcome.Dropped)
            if (rowChecklistOpen[taskId] == true) rowChecklists[taskId] = read
        }
    }

    fun shownRowChecklistItems(taskId: String): List<RowChecklistItem> {
        rowChecklistVersion
        return rowChecklists[taskId]?.let { shownRowChecklist(it, rowChecklistEdits.shown(taskId)) }.orEmpty()
    }

    fun rowChecklistTappable(read: JSONObject): Boolean = writable && failedAction == null && !read.optBoolean("readOnly")

    fun tickRowChecklistItem(taskId: String, item: RowChecklistItem) = editRowChecklist(taskId) { it.completed[item.id] = !item.completed }

    fun typeRowChecklistDraft(taskId: String, text: String) { rowChecklistDrafts[taskId] = text }

    fun submitRowChecklistDraft(taskId: String): Boolean {
        val read = rowChecklists[taskId] ?: return false
        val title = rowChecklistDrafts[taskId].orEmpty().trim()
        if (title.isEmpty() || !rowChecklistTappable(read)) return false
        rowChecklistDrafts[taskId] = ""
        editRowChecklist(taskId) { it.added += UUID.randomUUID().toString() to title }
        return true
    }

    private fun editRowChecklist(taskId: String, edit: (RowChecklistPending) -> Unit) {
        val read = rowChecklists[taskId] ?: return
        if (!rowChecklistTappable(read)) return
        rowChecklistEdits.edit(taskId, edit)
    }

    internal fun rowChecklistSettled(taskId: String, outcome: RowChecklistOutcome) {
        val written = rowChecklistEdits.settled(taskId, outcome)
        if (outcome == RowChecklistOutcome.Dropped && rowChecklistOpen[taskId] == true) readRowChecklist(taskId)
        written ?: return
        rowChecklists[taskId]?.let { read ->
            rowChecklists[taskId] = JSONObject(read.toString()).put("items", JSONArray(shownRowChecklist(read, written).map { item ->
                JSONObject().put("id", item.id).put("title", item.title).put("completed", item.completed).put("inline", JSONArray(item.inline))
            }))
        }
    }

    fun moveToDestination(destination: JSONObject) {
        val task = destinationFor ?: return
        closeDestination()
        menu.command("taskDestinationMove", JSONObject().put("id", task.id).put("taskRevision", task.taskRevision).put("destination", destination))
    }

    private var toastShown = 0

    internal fun showToast(title: String?, message: String, tone: String = "warning", action: String? = null, durationMs: Long? = null,
                           onAction: () -> Unit = {}) {
        toast = Toast(title, message, tone, action, onAction)
        val mine = ++toastShown
        val shown = durationMs ?: toastDurationMs(null, action)
        main.postDelayed({ if (mine == toastShown) toast = null }, if (action != null) actionTimeout(shown) else shown)
    }


    private fun actionTimeout(shown: Long): Long {
        if (android.os.Build.VERSION.SDK_INT < 29) return shown
        val accessibility = getApplication<Application>().getSystemService(android.view.accessibility.AccessibilityManager::class.java) ?: return shown
        return maxOf(shown, accessibility.getRecommendedTimeoutMillis(shown.toInt(),
            android.view.accessibility.AccessibilityManager.FLAG_CONTENT_TEXT or android.view.accessibility.AccessibilityManager.FLAG_CONTENT_CONTROLS).toLong())
    }


    internal fun showToast(toast: JSONObject, action: String? = null, tone: String = toast.optString("tone", "warning"), onAction: () -> Unit = {}) =
        showToast(toast.text("title")?.ifEmpty { null }, toast.getString("message"), tone, action, toastDurationMs(toast, action), onAction)

    fun dismissToast() { toast = null }


    fun taskFocusAction(id: String, focused: Boolean, taskRevision: String) =
        FailedAction("taskFocus", id, patch = mapOf("focused" to "$focused", "taskRevision" to taskRevision))


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


    fun setProjectFocus(id: String, focused: Boolean, projectRevision: String) {
        val action = projectFocusAction(id, focused, projectRevision)
        perform(action) { runtime ->
            runtime.setProjectFocus(id, focused, projectRevision)
            acknowledged(action)
        }
    }


    fun statusAction(task: TaskRow, status: String) =
        withRequestId(FailedAction("update", task.id, base = mapOf("status" to task.status), patch = mapOf("status" to status)), failedAction)


    fun chooseStatus(task: TaskRow, status: String) {
        if (status == "done" && task.status != "done") { statusMenu = null; complete(task.id, task.taskRevision, askNext = true) }
        else if (!menu.rowStatus(task, status)) changeStatus(task, status)
    }


    fun changeStatus(task: TaskRow, status: String) {
        statusMenu = null
        if (status == task.status) return
        sendUpdate(statusAction(task, status))
    }


    private fun sendUpdate(action: FailedAction) = perform(action) { runtime ->
        runtime.updateTask(action.id, json(action.base), json(action.patch), action.requestId)
        acknowledged(action)
    }


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


            "journal" -> perform(action) { runtime ->
                runtime.replayJournal().owed?.let { throw IllegalStateException(it) }
                acknowledged(action)

                if (!ProcessCoreHost.recovered(getApplication(), runtime)) throw IllegalStateException(ProcessCoreHost.failure?.error ?: "SAVE_FAILED")
            }


            "storage" -> ProcessCoreHost.failure?.action?.takeIf { it.kind == "journal" }?.let { owed -> failedAction = owed; retryOwed() }
                ?: perform(action) { runtime ->
                val lists = read(runtime, depth())
                acknowledged(action)
                ui { showLists(lists, ++issued) }
            }

            in ATTACHMENT_KINDS -> attachments.retry(action)

            in PROJECT_DETAIL_KINDS -> projectDetails.retry(action)
            in EDITOR_MENU_KINDS -> editorMenu.run(action)

            else -> menu.retry(action)
        }
    }


    private fun keepCapture(value: CaptureDraft?, persist: Boolean = true) {

        if (value == null && capture != null) voice.closed()
        capture = value
        saved["capturing"] = value != null
        if (value == null) captureStore.delete() else if (persist) captureStore.write(value.state())
    }


    fun openCapture(auto: AutoRecord = AutoRecord.OFF) {
        if (capture != null) return
        perform { runtime ->
            val view = runtime.openQuickCapture()
            ui { openedCapture(view, "", auto) }
        }
    }


    fun openProjectCapture(projectId: String) {
        if (capture != null || captureModal.open != null) return
        val params = JSONObject().put("initialProps", JSONObject().put("projectId", projectId).put("status", "next").toString())
            .put("returnTo", "/projects-screen?projectId=${android.net.Uri.encode(projectId)}")
        perform { runtime ->
            val reply = runtime.menuRead("captureModalOpen", JSONObject().put("params", params).toString())
            ui { val back = projectReturn; closeProject(); keepProjectReturn(back); captureModal.opened(params, reply) }
        }
    }


    internal fun openedCapture(view: JSONObject, text: String, auto: AutoRecord = AutoRecord.OFF) {
        captureInFlight = null
        keepCapture(CaptureDraft.opened(view).copy(text = text))
        voice.opened(auto)
        val addAnother = view.getJSONObject("addAnother")
        if (prefs.getString(ADD_ANOTHER_KEY, null) == "true" && !addAnother.getBoolean("value")) editCapture(addAnother.getJSONObject("edit"))
    }


    fun closeCapture() {
        keepCapture(null)
        captureInFlight = null
    }

    fun leftApp() { leaveApp = false }


    private fun resumeCapture(restored: CaptureDraft) {
        keepCapture(restored.reading())

        voice.opened(AutoRecord.OFF)
        val action = restored.pending ?: return
        if (failedAction != null) return
        failedAction = action
        when (action.kind) { "capture" -> sendCapture(action); "captureLines" -> sendLines(action); else -> sendPicker(action) }
    }


    fun typeCapture(text: String) {
        val current = capture ?: return
        keepCapture(current.copy(text = text).reading())
        pumpCapture()
    }


    fun editCapture(edit: JSONObject) {
        val current = capture ?: return

        keepCapture(current.copy(requests = current.requests + JSONObject().put("edit", edit)))
        pumpCapture()
    }


    fun setCaptureAddAnother(addAnother: JSONObject) {
        val on = addAnother.getJSONObject("edit").getBoolean("value")
        prefs.edit().apply { if (on) putString(ADD_ANOTHER_KEY, "true") else remove(ADD_ANOTHER_KEY) }.apply()
        editCapture(addAnother.getJSONObject("edit"))
    }

    fun setCaptureExpanded(open: Boolean) { capture?.let { keepCapture(it.copy(expanded = open)) } }


    fun openCapturePicker(kind: String) {
        val current = capture ?: return
        val picker = JSONObject().put("kind", kind).apply { if (kind != "priority") put("query", "") }
        keepCapture(current.copy(picker = picker, pickerRequestId = UUID.randomUUID().toString()).reading())
        pumpCapture()
    }

    fun closeCapturePicker() { capture?.let { keepCapture(it.copy(picker = null)) } }


    fun captureQuery(query: String) {
        val current = capture ?: return
        val picker = current.picker ?: return
        keepCapture(current.copy(picker = JSONObject(picker.toString()).put("query", query)).reading())
        pumpCapture()
    }


    fun pickCapture(edit: JSONObject, close: Boolean, clearQuery: Boolean = false) {
        val current = capture ?: return
        val picker = current.picker?.let { if (clearQuery && it.has("query")) JSONObject(it.toString()).put("query", "") else it }
        keepCapture(current.copy(picker = if (close) null else picker))
        editCapture(edit)
    }


    private var captureInFlight: JSONObject? = null


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
            .apply { current.picker?.let { put("picker", it) }; edit?.let { put("edit", it) } }
        background(emptyList(), { engine -> runCatching { if (edit != null) engine.editQuickCapture(request.toString()) else engine.quickCaptureView(request.toString()) } }) { reply, _ ->
            if (captureInFlight === next) captureInFlight = null

            val now = capture?.takeIf { it.session == current.session && it.requests.firstOrNull() === next } ?: return@background pumpCapture()
            reply.onSuccess { result ->
                val view = if (edit != null) result.getJSONObject("view") else result
                if (edit != null) result.optJSONObject("notice")?.let { showToast(it) }
                val answered = now.copy(options = view.getJSONObject("options"), view = view, requests = now.requests.drop(1))

                keepCapture(if (now.text != current.text) answered.reading() else answered)
            }.onFailure { failure ->

                Log.w(CoreHost.TAG, "Capture request refused", failure)
                showToast(null, (failure.message ?: failure.javaClass.simpleName).substringAfter(": "), "warning")
                keepCapture(now.copy(requests = emptyList(), queuedSave = null))
            }
            pumpCapture()
        }
    }


    fun captureAction(current: CaptureDraft, openAfterSave: Boolean) = current.pending?.takeIf { it.kind == "capture" }
        ?: FailedAction("capture", current.captureId, current.text, patch = mapOf("options" to current.options.toString(), "openAfterSave" to "$openAfterSave"))


    fun saveCapture(openAfterSave: Boolean) {
        val current = capture ?: return

        if (voice.state.busy) return
        if (current.requests.isNotEmpty() || captureInFlight != null) {
            keepCapture(current.copy(queuedSave = if (openAfterSave) "edit" else "save"), persist = false)
            return
        }


        if (voice.state.held && !busy) {
            keepCapture(current.copy(queuedSave = null), persist = false)
            if (voice.saveHeld(current.text, current.options, openAfterSave)) return
        }
        val action = captureAction(current, openAfterSave)
        if (busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action, queuedSave = null))
        sendCapture(action)
    }


    private fun freeCapture(action: FailedAction) = ui {
        if (failedAction == action) failedAction = null
        capture?.let { keepCapture(it.copy(pending = null, captureId = UUID.randomUUID().toString(), pickerRequestId = UUID.randomUUID().toString(),
            snapshot = null, snapshotTaken = false)) }
    }


    private fun sendCapture(action: FailedAction) = perform(action) { runtime ->
        val request = JSONObject().put("text", action.title).put("options", JSONObject(action.patch["options"]!!)).put("captureId", action.id)
            .put("openAfterSave", action.patch["openAfterSave"] == "true")
        val reply = try {
            runtime.submitQuickCapture(request.toString())
        } catch (failure: Exception) {
            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) freeCapture(action)
            throw failure
        }
        acknowledged(action)
        ui { finishCapture(reply) }
    }


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
                else -> keepCapture(null)
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


    fun linesAction(current: CaptureDraft) = current.pending?.takeIf { it.kind == "captureLines" }
        ?: FailedAction("captureLines", current.lineIds.first(), current.linesText ?: current.text,
            patch = mapOf("options" to current.options.toString(), "captureIds" to current.lineIds.joinToString(",")))


    fun createCaptureLines() {
        val current = capture ?: return
        if (current.lineIds.isEmpty()) return
        val action = linesAction(current)
        if (busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action))
        sendLines(action)
    }


    private fun <T> onMain(work: () -> T): T {
        val done = java.util.concurrent.CountDownLatch(1)
        var result: Result<T>? = null
        main.post { result = runCatching(work); done.countDown() }
        done.await()
        return result!!.getOrThrow()
    }


    private fun sendLines(action: FailedAction) = perform(action) { runtime ->
        val ids = org.json.JSONArray(action.patch["captureIds"]!!.split(","))
        val submit = { name: String? ->
            runtime.submitQuickCaptureLines(JSONObject().put("text", action.title).put("options", JSONObject(action.patch["options"]!!))
                .put("captureIds", ids).put("snapshotFileName", name ?: JSONObject.NULL).toString())
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


    fun pickerAction(current: CaptureDraft) = current.pending?.takeIf { it.kind == "capturePicker" }
        ?: FailedAction("capturePicker", current.pickerRequestId, current.picker?.optString("query").orEmpty().trim(),
            patch = mapOf("picker" to current.picker?.optString("kind").orEmpty(), "text" to current.text, "options" to current.options.toString()))


    fun submitCapturePicker() {
        val current = capture ?: return
        if (current.picker == null) return
        val action = pickerAction(current)
        if (action.title.isEmpty() || busy || (failedAction != null && failedAction != action)) return
        keepCapture(current.copy(pending = action))
        sendPicker(action)
    }


    private fun sendPicker(action: FailedAction) = perform(action) { runtime ->
        val request = JSONObject().put("picker", action.patch["picker"]).put("query", action.title).put("text", action.patch["text"])
            .put("options", JSONObject(action.patch["options"]!!)).put("requestId", action.id)
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


    private fun keepSearch(value: SearchState?) {
        search = value
        saved["search"] = value?.state()?.toString()
    }


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


    fun editSearch(query: String) {
        val current = search ?: return
        keepSearch(current.copy(query = query))
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) readSearch() }, 200)
    }


    fun setSearchFilters(filters: JSONObject) {
        val current = search ?: return
        keepSearch(current.copy(filters = filters))
        readSearch()
    }

    fun showSearchFilters(open: Boolean) { search?.let { keepSearch(it.copy(filtersOpen = open)) } }


    fun showSaveSearch(name: String?) { search?.let { keepSearch(it.copy(saveName = name)) } }


    private fun readSearch(done: (() -> Unit)? = null) {
        val request = search?.request() ?: return run { done?.invoke() }
        background(listOf(Part.Search), { runtime -> SearchView.parse(runtime.searchTasks(request)) }, done) { view, mine ->
            if (fresh(mine, Part.Search) && view.query == search?.query?.trim()) searchView = view
        }
    }

    fun saveSearchAction(current: SearchState, name: String) =
        FailedAction("saveSearch", current.saveRequestId, current.query.trim(), patch = mapOf("name" to name.trim()))


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

            if (UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }) ui { failedAction = null; search?.let { keepSearch(it.copy(submitted = null)) } }
            throw failure
        }
        acknowledged(action)
        ui { search?.let { keepSearch(it.copy(saveName = null, submitted = null, saveRequestId = UUID.randomUUID().toString())) } }
    }


    private fun listKey(project: String? = openProjectId) = listOf(menu.screen?.name, menu.list, screen.name, project).joinToString("|")


    fun isHighlighted(taskId: String) = taskId == highlightTaskId && highlightList == listKey()


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


    fun openFromSearch(target: Screen, projectId: String?) {
        closeSearch()

        if (target == Screen.Projects) return menu.openProjects(projectId)
        show(target)
        if (projectId != null) openProject(projectId)
    }


    private fun keepProcessing(value: InboxProcessing?, persist: Boolean = true) {
        processing = value
        saved["processing"] = value != null
        if (value == null) processingStore.delete() else if (persist) processingStore.write(value.state())
    }


    fun openProcessing() = perform { runtime ->
        val started = InboxProcessing.started(runtime.startInboxProcessing(processingMode))
        ui { keepProcessing(started) }
    }


    private fun resumeProcessing(restored: InboxProcessing) {
        val action = restored.pending
        if (action == null || failedAction != null) { keepProcessing(null); return }


        keepProcessing(restored.copy(hidden = true))
        failedAction = action
        sendAnswer(action, reopen = false)
    }


    fun switchProcessingMode(mode: String) {
        processingMode = mode
        prefs.edit().putString(PROCESSING_MODE_KEY, mode).apply()
        editStep(JSONObject().put("mode", mode))
    }


    fun editStep(input: JSONObject) {
        val current = processing ?: return
        keepProcessing(current.copy(edits = current.edits + input), persist = false)
        pumpStep()
    }


    private var stepInFlight: JSONObject? = null


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

            val now = processing?.takeIf { it.sessionId == current.sessionId && it.edits.firstOrNull() === next } ?: return@background pumpStep()
            reply.onSuccess { view -> keepProcessing(now.copy(view = view, edits = now.edits.drop(1)), persist = false) }
                .onFailure { failure ->


                    Log.w(CoreHost.TAG, "Process Inbox edit refused", failure)
                    val message = failure.message ?: failure.javaClass.simpleName
                    showToast(null, message.substringAfter(": "), "warning")
                    keepProcessing(now.copy(edits = emptyList(), queued = null), persist = false)
                    if (message.startsWith("STALE_REVISION")) openProcessing()
                }
            pumpStep()
        }
    }


    fun stepAction(current: InboxProcessing, kind: String, choice: String) = current.pending?.takeIf { it.kind == kind && it.title == choice }
        ?: FailedAction(kind, UUID.randomUUID().toString(), choice,
            patch = mapOf("sessionId" to current.sessionId, "taskId" to current.taskId, "step" to current.step))


    fun answer(kind: String, choice: String) {
        val current = processing ?: return
        if (current.edits.isNotEmpty() || stepInFlight != null) { keepProcessing(current.copy(queued = kind to choice), persist = false); return }
        val action = stepAction(current, kind, choice)
        if (busy || (failedAction != null && failedAction != action)) return
        keepProcessing(current.copy(pending = action, queued = null))
        sendAnswer(action)
    }


    private fun sendAnswer(action: FailedAction, reopen: Boolean = true) = perform(action) { runtime ->
        val request = JSONObject(action.patch).put("requestId", action.id)
        val reply = try {
            if (action.kind == "inboxSkip") runtime.skipInboxProcessingTask(request.apply { remove("step") }.toString())
            else runtime.commitInboxProcessingStep(request.put("decision", JSONObject().put("choice", action.title)).toString())
        } catch (failure: Exception) {
            val message = failure.message.orEmpty()
            if (!message.startsWith("STALE_REVISION")) {

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


    private fun finishAnswer(reply: JSONObject) {
        reply.optJSONObject("notice")?.let { showToast(it) }

        reply.optJSONObject("toast")?.let { toast ->
            val receipt = toast.optJSONObject("undoReceipt")
            if (receipt == null) showToast(toast, tone = "info")
            else showToast(null, toast.getString("message"), "info", toast.getString("undoLabel"), 5200) { undoInboxDecision(receipt) }
        }

        val current = processing ?: return
        if (current.hidden) { keepProcessing(null); return }
        val view = reply.optJSONObject("view")
        if (view == null) closeProcessing() else keepProcessing(current.copy(view = view, pending = null))
    }


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


    fun chooseProjectArea(areaId: String) = setProjectDraft(projectDraft, areaId, projectRequestId)

    fun createProjectAction(areaId: String) = FailedAction("createProject", projectRequestId, projectDraft, base = mapOf("areaId" to areaId))


    fun createProject(areaId: String) {
        val action = createProjectAction(areaId)
        perform(action) { runtime ->
            runtime.createProject(action.title, areaId, action.id)
            acknowledged(action)
            ui { setProjectDraft("", null, UUID.randomUUID().toString()) }
        }
    }

    fun areaFilterAction(option: AreaOption) = FailedAction("areaFilter", option.next)


    fun setAreaFilter(option: AreaOption) = sendAreaFilter(areaFilterAction(option))


    private fun sendAreaFilter(action: FailedAction) = perform(action) { runtime ->
        runtime.setAreaFilter(action.id)
        acknowledged(action)
    }

    private fun keepProject(id: String?) {
        if (id != openProjectId) closeRowChecklists()
        openProjectId = id
        saved["project"] = id
    }


    fun openProject(id: String) {
        if (id != openProjectId) { projectCompletedCollapsed = true; projectDetails.resetFilters() }
        val mine = ++issued
        perform { runtime ->
            val detail = readProject(runtime, id, null, PAGE)
            ui { if (fresh(mine, Part.Project)) { keepProject(id); project = detail } }
        }
    }

    fun keepProjectReturn(back: ProjectReturn?) {
        projectReturn = back
        saved["projectReturn"] = projectReturnText(back)
    }

    fun backFromProject() {
        val back = projectReturn
        closeProject()
        back?.let(menu::returnTo)
    }

    fun closeProject() {
        keepProject(null)
        keepProjectReturn(null)
        menu.endBulk("project")
        project = null

        projectDetails.follow(null)
    }


    fun loadMoreProject() {
        val view = project ?: return
        val mine = ++issued
        perform { runtime ->
            val next = readProject(runtime, view.projectId, view, view.items.size + PAGE)
            ui { if (fresh(mine, Part.Project)) showProject(view.projectId, next) }
        }
    }


    fun refreshProjects() {


        if (busy) return menu.whenIdle(::refreshProjects)
        val at = depth()
        background(listOf(Part.Projects, Part.Project), { runtime -> ProjectsView.parse(runtime.projects()) to readOpen(runtime, at) }) { (list, detail), mine ->
            if (fresh(mine, Part.Projects)) projects = list
            if (fresh(mine, Part.Project)) showProject(at.project, detail)
        }
    }


    private fun refreshAll(synced: Boolean = false) {
        val at = depth()
        if (synced) {
            background(Part.entries, { runtime -> applySyncedChoices(runtime, prefs); read(runtime, at) }, apply = ::showLists)
            menu.refresh()
            if (search != null) readSearch()
            return
        }

        voice.refreshDefault()
        AfterCommandReads.run(AfterCommandReads.order(screen, menu.screen != null, search != null)) { step, done ->
            when (step) {
                AfterCommandReads.Read.Search -> readSearch(done)
                AfterCommandReads.Read.Menu -> menu.refresh(done)
                AfterCommandReads.Read.Focus -> background(listOf(Part.Focus, Part.Areas), { runtime -> read(runtime, at, Screen.Focus) }, done, ::showLists)
                AfterCommandReads.Read.Projects ->
                    background(listOf(Part.Projects, Part.Project, Part.Areas), { runtime -> read(runtime, at, Screen.Projects) }, done, ::showLists)
                AfterCommandReads.Read.AllLists -> background(Part.entries, { runtime -> read(runtime, at) }, done, ::showLists)
            }
        }
    }


    private fun readOpen(runtime: CoreHost, at: Depth): ProjectDetail? = at.project?.let { id ->
        try {
            readProject(runtime, id, null, at.projectItems)
        } catch (failure: Exception) {
            if (failure.message?.startsWith("TASK_NOT_FOUND") != true) throw failure
            null
        }
    }


    private fun showProject(id: String?, detail: ProjectDetail?) {
        if (id != openProjectId) return
        if (detail == null) keepProject(null)
        project = detail
    }


    private fun projectWindow(runtime: CoreHost, id: String, offset: Int, revision: String, filterEdit: JSONObject? = null): JSONObject =
        runtime.menuRead("projectDetailFilterView", JSONObject().put("projectId", id).put("offset", offset).put("limit", PAGE)
            .apply { if (revision.isNotEmpty()) put("revision", revision) }
            .put("showCompleted", projectShowCompleted).put("completedCollapsed", projectCompletedCollapsed)
            .put("filters", projectDetails.listFilterState).put("filterSheetOpen", projectDetails.listFilterSheet != null)
            .apply { filterEdit?.let { put("filterEdit", it) } }.toString())


    fun editProjectFilters(edit: JSONObject) {
        val id = openProjectId ?: return
        menu.whenIdle {
            background(listOf(Part.Project), { runtime -> ProjectDetail.parse(projectWindow(runtime, id, 0, "", edit)) }) { detail, mine ->
                if (id != openProjectId || !fresh(mine, Part.Project)) return@background
                detail.listFilters?.getJSONObject("filters")?.getJSONObject("state")?.let(projectDetails::keepFilters)
                project = detail
            }
        }
    }


    fun showProjectCompleted(on: Boolean) {
        projectShowCompleted = on
        prefs.edit().putString(PROJECT_SHOW_COMPLETED_KEY, on.toString()).apply()
        refreshProjects()
    }


    fun toggleProjectCompleted() {
        projectCompletedCollapsed = !projectCompletedCollapsed
        refreshProjects()
    }


    private fun readProject(runtime: CoreHost, id: String, start: ProjectDetail?, depth: Int): ProjectDetail {
        var view = start ?: ProjectDetail.parse(projectWindow(runtime, id, 0, ""))
        while (view.items.size < minOf(depth, view.total)) {
            val next = try {
                view.append(projectWindow(runtime, id, view.items.size, view.revision))
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
                return if (start == null) view else readProject(runtime, id, null, depth)
            }
            if (next.items.size == view.items.size) break
            view = next
        }
        return view
    }


    private fun readFocus(runtime: CoreHost, start: FocusView?, depth: Map<String, Int>, controls: String, edit: String = ""): FocusView {
        val folds = focusFolds().toString()
        var view = start ?: FocusView.parse(runtime.focus(PAGE, controls, edit, folds))
        val state = view.state.toString()
        for ((key, want) in depth) {
            while (true) {
                val loaded = view.section(key) ?: break
                if (loaded.rows.size >= minOf(want, loaded.rowTotal)) break
                val next = try {
                    view.append(runtime.focusWindow(key, loaded.rows.size, PAGE, view.revision, state, folds))
                } catch (failure: Exception) {
                    if (failure.message?.startsWith("STALE_REVISION") != true) throw failure

                    return if (start == null) view else readFocus(runtime, null, depth, state)
                }
                if (next.section(key)?.rows?.size == loaded.rows.size) break
                view = next
            }
        }
        return view
    }


    private fun read(runtime: CoreHost, at: Depth, shown: Screen? = null) = Lists(
        if (shown == null || shown == Screen.Focus) readFocus(runtime, null, at.focus, at.controls) else null,
        if (shown == null || shown == Screen.Projects) ProjectsView.parse(runtime.projects()) else null,
        at.project,
        if (shown == null || shown == Screen.Projects) readOpen(runtime, at) else null,
        AreaFilter.parse(runtime.areaFilter()),
    )


    private fun showLists(lists: Lists, mine: Long) {
        lists.focus?.let { if (fresh(mine, Part.Focus)) { showFocus(it); readSucceeded() } }

        lists.projects?.let { read ->
            if (fresh(mine, Part.Projects)) projects = read
            if (fresh(mine, Part.Project)) showProject(lists.projectId, lists.project)
        }
        if (fresh(mine, Part.Areas)) areaFilter = lists.areas
    }


    internal fun readSucceeded() {
        if (failedAction == null) error = null
    }

    internal fun ui(update: () -> Unit) { main.post(update) }


    private var issued = 0L
    private var commandAt = 0L
    private val shownAt = HashMap<Part, Long>()


    internal enum class Part { Focus, Projects, Project, ProjectDetails, Areas, Editor, TaskView, Search, Menu, More, MenuDialog, Pomodoro }


    internal fun issue(): Long = ++issued


    internal fun fresh(mine: Long, part: Part) = (mine > commandAt && mine > (shownAt[part] ?: 0L)).also { if (it) shownAt[part] = mine }


    internal fun anyTime(work: (CoreHost) -> Unit, failed: (Throwable) -> Unit) {
        val runtime = host ?: return
        Thread({
            runCatching { work(runtime) }.onFailure { failure ->
                Log.e(CoreHost.TAG, "Core action failed action=anyTime ${failureForLog(failure)}")
                ui { failed(failure) }
            }
        }, "mindwtr-any-time").start()
    }


    internal fun <T> background(parts: List<Part>, read: (CoreHost) -> T, always: (() -> Unit)? = null, apply: (T, Long) -> Unit) {
        val runtime = host

        if (runtime == null || busy || failedAction != null) return run { always?.invoke() }
        val mine = ++issued
        Thread({
            val result = runCatching { read(runtime) }
            result.exceptionOrNull()?.let { Log.e(CoreHost.TAG, "Core action failed action=background ${failureForLog(it)}") }
            ui {
                try { show(parts, mine, result, apply) } finally { always?.invoke() }
            }
        }, "mindwtr-read").start()
    }


    private fun <T> show(parts: List<Part>, mine: Long, result: Result<T>, apply: (T, Long) -> Unit) {

        if (result.isFailure && parts.map { fresh(mine, it) }.none { it }) return
        result.onSuccess { apply(it, mine) }.onFailure { failure ->

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


    internal fun perform(action: FailedAction? = null, work: (CoreHost) -> Unit) {
        tryPerform(action, work = work)
    }


    internal fun tryPerform(action: FailedAction? = null, finished: (() -> Unit)? = null, work: (CoreHost) -> Unit): Boolean {
        val runtime = host


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


            var stale = false
            try {

                debugProperty("delay_action_ms").toLongOrNull()?.let(Thread::sleep)
                work(runtime); done = true
            }
            catch (failure: Throwable) {
                val message = failure.message ?: failure.javaClass.simpleName
                val refused = refusedUnwritten(action?.kind, message)
                stale = action != null && action.kind !in STALE_SHOWN && message.startsWith("STALE_REVISION")
                val failed = if ((action != null && !refused) || message.startsWith("SAVE_FAILED")) {
                    action ?: FailedAction("storage", "")
                } else null
                Log.e(CoreHost.TAG, "Core action failed action=${action?.kind ?: "read"} lock=${failed?.kind ?: "none"} ${failureForLog(failure)}")

                if (failed != null) {
                    ProcessCoreHost.recordFailure(ProcessCoreHost.PendingFailure(failed, message, menu.page, editor, screen, focus, projects, project, areaFilter))
                }
                if (stale) acknowledged(action!!)
                else ui {

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


data class AreaManagerDraft(val expanded: String? = null, val name: String = "", val color: String? = null, val check: JSONObject? = null,
                           val focus: String? = null, val renaming: String? = null, val renameName: String = "", val renameCheck: JSONObject? = null) {

    val canSave get() = name.isNotBlank() && check?.optBoolean("saveDisabled") == false

    val canRename get() = renameName.isNotBlank() && renameCheck?.optBoolean("saveDisabled") == false
}
