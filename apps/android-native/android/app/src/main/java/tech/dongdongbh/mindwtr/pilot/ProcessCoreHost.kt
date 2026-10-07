package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.util.Log
import org.json.JSONObject
import tech.dongdongbh.mindwtr.androidwidget.CheckoffStore
import tech.dongdongbh.mindwtr.androidwidget.PendingCaptureWriter
import tech.dongdongbh.mindwtr.pilot.core.AndroidContentSource
import tech.dongdongbh.mindwtr.pilot.core.BytecodeCache
import tech.dongdongbh.mindwtr.pilot.core.CoreBundle
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.DiagnosticsLogFile
import tech.dongdongbh.mindwtr.pilot.core.HostFiles
import tech.dongdongbh.mindwtr.pilot.core.HostInstaller
import tech.dongdongbh.mindwtr.pilot.core.HostIo
import tech.dongdongbh.mindwtr.pilot.core.HostNetwork
import tech.dongdongbh.mindwtr.pilot.core.HostWidgets
import tech.dongdongbh.mindwtr.pilot.core.LegacyRnStoreGuard
import tech.dongdongbh.mindwtr.pilot.core.RnKeyValue
import tech.dongdongbh.mindwtr.pilot.core.traced
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The one CoreHost of this process.
 *
 * Activities and ViewModels never close it. Process death is the only
 * shutdown: WAL with `synchronous = FULL` makes every acknowledged write
 * durable without a clean close. Two hosts on one database would reject each
 * other's writes, so recreation must reuse this one.
 */
/** A resume whose screen reports no new first content publishes the widgets this long after it (ProcessCoreHost.appState). */
private const val WIDGET_FALLBACK_MS = 3_000L

internal object ProcessCoreHost {
    private var boot: FutureTask<CoreHost>? = null
    @Volatile private var boots = 0

    /**
     * A failed command's exact retry, with the screen it failed on: the tab
     * (Inbox, Focus, or Projects) and its lists (the open Menu or Inbox list's page, Focus,
     * Projects), and the editor draft for a failed update.
     * It lives next to the host so a new screen in this process (the old one
     * finished) reopens on the same retry instead of a locked, empty list. In
     * memory only: after process death the saved capture draft and UUID, or the
     * saved editor draft and its base, cover retry.
     */
    data class PendingFailure(
        val action: FailedAction,
        val error: String,
        val menuPage: MenuPage?,
        val editor: TaskEditor? = null,
        val screen: Screen = Screen.Inbox,
        val focus: FocusView? = null,
        val projects: ProjectsView? = null,
        val project: ProjectDetail? = null,
        val areas: AreaFilter? = null,
    )

    @Volatile var failure: PendingFailure? = null
        private set

    /** A read's storage failure never replaces an owed command: that command's exact retry is what recovers. */
    @Synchronized fun recordFailure(pending: PendingFailure) {
        if (pending.action.kind == "storage" && failure?.action?.kind.let { it != null && it != "storage" }) return
        failure = pending
    }

    /** Called only after [action] itself succeeds. */
    @Synchronized fun clearFailure(action: FailedAction) {
        if (failure?.action == action) failure = null
    }

    /**
     * Blocks until the shared boot finishes. Call off the main thread. [language] is the language chosen in this app's
     * Settings (RN's device key), if any: the boot that starts here sets it before the journal replay, so a replayed
     * request (a capture's words) is read in the language it was written in.
     */
    fun get(app: Application, language: String? = null): CoreHost {
        var starter = false
        val task = synchronized(this) {
            boot ?: FutureTask { start(app, language) }.also {
                boot = it
                boots += 1
                starter = true
                Log.i(CoreHost.TAG, "Core host boot started boot=$boots")
            }
        }
        if (starter) task.run()
        val host = try {
            task.get()
        } catch (failure: ExecutionException) {
            // A failed boot is not cached: the next new screen may boot again.
            synchronized(this) { if (boot === task) boot = null }
            throw failure.cause ?: failure
        }
        if (!starter) logHostReuse("new-screen", attaches = 1, inFlight = false)
        return host
    }

    private fun start(app: Application, language: String?): CoreHost {
        // Nothing opens the RN database until the guard passes; it returns files/SQLite/mindwtr.db
        // and what RN left in AsyncStorage, which the JS host imports as RN's next launch would.
        val legacy = if (BuildConfig.RN_STORAGE) {
            LegacyRnStoreGuard.requireClear(app.dataDir, File(app.cacheDir, "legacy-rn-guard"))
        } else {
            null
        }
        val installer = HostInstaller(app.filesDir, app.cacheDir)
        val keyValue = RnKeyValue(app.getDatabasePath("RKStorage"))
        val runtime = CoreHost(legacy?.database ?: File(app.filesDir, "mindwtr-native-dev.db"), legacy?.let { app.dataDir }, HostIo(app),
            File(app.filesDir, "journal"), deviceStore(app), File(app.filesDir, DiagnosticsLogFile.RELATIVE_PATH),
            keyValue, HostFiles(app.filesDir, app.cacheDir, content = AndroidContentSource(app)), installer,
            ReminderAlarms(app, keyValue, checkpointRnState = { if (legacy != null) LegacyRnStoreGuard.checkpointRnState(app.dataDir) }),
            HostWidgets(app) { appState },
            scheduleBackgroundSync = { on -> CoreWork.scheduleSyncStored(app, on) }, appInfo = aboutAppInfo())
        try {
            runtime.start(coreBundle(app), legacy?.bootState ?: "", legacy?.backup ?: "")
            setLanguage(runtime, language ?: legacy?.language)
            loadTheme(runtime, legacy?.theme)
            // Before the journal's replay, the first write that can reach files/attachments: an install a death cut short is
            // finished or rolled back by RN's rules, so no attachment write meets a half-installed file.
            recoverInstalls(installer)
            if (replay(runtime)) recovered(app, runtime, deferSync = true)
            // The widgets show what this boot loaded (a store change before the validated load published nothing), once the first
            // screen shows its content, as the boot's sync start waits; a CoreWork job publishes at its end.
            deferredWidgets.hold(runtime)
            return runtime
        } catch (failure: Throwable) {
            runCatching { runtime.close() }
            throw failure
        }
    }

    /**
     * The bundle and its bytecode cache in the code cache directory (Android empties it on an app update; the key guards
     * every other case). Its key is the hash line the bundle carries (read from its start only); none turns the cache off.
     */
    private fun coreBundle(app: Application): CoreBundle {
        val hash = runCatching { app.assets.open("core-host.js").use(BytecodeCache::bundleKey) }.getOrDefault("")
        val cache = BytecodeCache(File(app.codeCacheDir, "core-host.qjsc"), BuildConfig.QUICKJS_WRAPPER)
        return CoreBundle(hash, cache) { traced("boot:bundleRead") { app.assets.open("core-host.js").use { it.readBytes() } } }
    }

    /** After first content (MainActivity's report): a start that ran the source caches its bytecode now, off the critical path. */
    fun contentShown() {
        startDeferredSync()
        val task = synchronized(this) { boot } ?: return
        if (task.isDone) runCatching { task.get() }.getOrNull()?.cacheBytecode()
    }

    /** Whether this process sent its first screen's About work ([aboutStartup]). */
    private val aboutStarted = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Once per process, when a screen first shows (RN's root layout at first paint, never a headless run): today counts as an
     * active day for the prompts, then the day's anonymous heartbeat (core decides whether one goes: the build, the setting, the
     * day). Off the main thread; a failure only logs, as RN keeps both silent.
     */
    fun aboutStartup(runtime: CoreHost) {
        if (!aboutStarted.compareAndSet(false, true)) return
        Thread({
            runCatching { runtime.aboutRequest("recordAboutPromptActivity", "{}") }.onFailure { Log.w(CoreHost.TAG, "Prompt activity not recorded ${failureForLog(it)}") }
            runCatching { runtime.aboutRequest("sendAboutHeartbeat", "{}") }
                .onSuccess { Log.i(CoreHost.TAG, "Native Android heartbeat sent=${it.optBoolean("sent")}") }
                .onFailure { Log.w(CoreHost.TAG, "Native Android heartbeat failed ${failureForLog(it)}") }
        }, "mindwtr-about-startup").start()
    }

    /** The boot's sync start, held until the first screen shows its content ([startDeferredSync]); null once it ran. */
    private val deferredSync = AtomicReference<(() -> Unit)?>(null)
    /** The boot's widget publication, held with it; null once it ran. */
    private val deferredWidgets = HeldPublication<CoreHost>()

    /** Set once a screen of this process showed its content: from then on sync's triggers start at once ([startSyncWithScreen]). */
    private var screenShown = false

    /**
     * The first screen shows its content (the Inbox's first rows, another tab's boot read, or the screen's fallback): the boot's
     * held sync start runs now, on the sync thread. It stays after the boot's journal replay and queue drain, as before; only
     * the first screen no longer waits for it.
     */
    fun startDeferredSync(trigger: String = "content") {
        synchronized(deferredSync) {
            screenShown = true
            deferredSync.getAndSet(null)
        }?.let { start -> syncThread.execute { start() } }
        deferredWidgets.take()?.let { publishHeldWidgets(it, trigger) }
    }

    /**
     * Sync's triggers in a CoreWork job's recovery: at once once a screen showed, else held for the first screen, as RN's headless
     * runs never mount its root layout's triggers. A process with no screen syncs only through core's background run (CoreJob),
     * which the job awaits; a trigger's sync there would outlive the job's protection.
     */
    private fun startSyncWithScreen(app: Application, runtime: CoreHost) {
        val now = synchronized(deferredSync) {
            // A boot's held start already waiting covers this one.
            if (!screenShown) deferredSync.compareAndSet(null) { startSync(app, runtime) }
            screenShown
        }
        if (now) startSync(app, runtime)
    }


    /** Whether MainActivity is resumed (RN's AppState "active"). */
    val appActive get() = appState == "active"

    /**
     * The write journal's replay: after the validated load, before this boot hands the host to any screen or entry point
     * (get() waits for it). A replay stopped by an owed save leaves that entry, and every screen opens on its exact retry
     * (InboxViewModel.retryOwed, kind "journal"), as for any owed command. Only a replay that left nothing prunes core's old
     * receipts, so an entry never outlives the receipt its replay needs; a failed prune only logs (the next boot prunes).
     * True once the replay finished (no entry owed): then sync may start.
     */
    private fun replay(runtime: CoreHost): Boolean {
        val replay = runtime.replayJournal()
        replay.owed?.let { recordFailure(PendingFailure(FailedAction("journal", ""), it, null)); return false }
        // Only once the journal is empty on disk: an entry whose delete did not reach the disk still needs its receipt. That
        // entry had its final reply, so the replay itself finished: sync may start.
        if (replay.left > 0) return true
        runCatching { runtime.pruneReceipts() }
            .onSuccess { Log.i(CoreHost.TAG, "Native Android receipts pruned=${it.optInt("pruned")}") }
            .onFailure { Log.w(CoreHost.TAG, "Native Android receipts prune failed", it) }
        return true
    }

    /**
     * RN's installer journal recovery (HostInstaller.recover) at boot. A journal it cannot prove stays on disk as it is, and a
     * failure here never fails the boot: an install of that target recovers it first, as in RN.
     */
    private fun recoverInstalls(installer: HostInstaller) {
        runCatching { installer.recover() }
            .onSuccess { found ->
                if (found.isNotEmpty()) Log.i(CoreHost.TAG, "Native Android install recovery " +
                    found.groupingBy { it.outcome }.eachCount().entries.joinToString(" ") { "${it.key}=${it.value}" })
            }
            .onFailure { Log.w(CoreHost.TAG, "Native Android install recovery failed ${failureForLog(it)}") }
    }

    // ---- Sync (bundle/host-sync.ts: core's service and triggers decide every cycle) ----

    /** RN's AppState: "active" while MainActivity is resumed, else "background" (RN's onHostResume and onHostPause). */
    @Volatile private var appState = "background"
    /** Set once sync started; its app state and network changes go through [syncThread], in order. */
    @Volatile private var syncHost: CoreHost? = null
    /** One sync start at a time: the boot's held start (sync thread) and CoreWork's (its worker) may meet. */
    private val syncLock = Any()
    private val syncThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-sync-events") }
    private val widgetThread = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "mindwtr-widget-refresh") }
    private val syncListeners = CopyOnWriteArraySet<(JSONObject) -> Unit>()
    /** The last sync badge and finished-cycle count (host-sync.ts's `sync` event), for a screen that opens later. */
    @Volatile var syncState: JSONObject? = null
        private set

    /** A screen's listener for the JS host's events (a `sync` state, an automatic sync's `toast`); called on the engine thread. */
    fun listenSync(listener: (JSONObject) -> Unit) = syncListeners.add(listener)
    fun unlistenSync(listener: (JSONObject) -> Unit) = syncListeners.remove(listener)

    private fun dispatch(event: JSONObject) {
        if (event.optString("type") == "sync") syncState = event
        syncListeners.forEach { runCatching { it(event) } }
    }

    /**
     * Sync starts only after the boot's validated load and a journal replay that finished with no entry owed (plan block 1: a
     * sync never runs before the replay finished); a replay that stopped starts it once its owed retry went through
     * ([recovered]). The network state goes first, then core's triggers start and ask for the app's first sync. A failure
     * here never fails the boot: the app runs without automatic sync, and Settings › Sync still opens.
     */
    private fun startSync(app: Application, runtime: CoreHost): Unit = synchronized(syncLock) {
        if (syncHost != null) return
        runtime.onEvent = { text -> runCatching { dispatch(JSONObject(text)) } }
        runCatching {
            val network = HostNetwork(app) { state -> syncThread.execute { runCatching { runtime.syncNetwork(state) } } }
            runtime.syncNetwork(network.state())
            val startedWith = appState
            // An event that arrived while the triggers started is newer than this reply.
            runtime.syncStart(startedWith).put("type", "sync").let { reply -> if (syncState == null) syncState = reply }
            syncHost = runtime
            network.start()
            // Resumed or paused while the triggers started.
            appState.takeIf { it != startedWith }?.let { now -> syncThread.execute { runCatching { runtime.syncAppState(now) } } }
            Log.i(CoreHost.TAG, "Native Android sync started appState=$appState")
        }.onFailure { Log.w(CoreHost.TAG, "Native Android sync start failed ${failureForLog(it)}") }
    }

    /**
     * After a replay that left nothing owed (the boot's, the owed journal retry's, CoreWork's): the queue drain, then sync, in the
     * boot's order (StartOrder). A drain that did not finish becomes the screens' owed "journal" retry, so no screen edits until
     * it goes through, sync waits, and CoreWork retries it with its back-off. True once drained.
     */
    fun recovered(app: Application, runtime: CoreHost, deferSync: Boolean = false): Boolean = StartOrder.afterReplay(
        drain = { drain(runtime, queue(app), app) },
        owe = { message -> recordFailure(PendingFailure(FailedAction("journal", ""), message, null)) },
        retryLater = { runCatching { CoreWork.retryDrain(app) }.onFailure { Log.w(CoreHost.TAG, "Native Android drain retry not queued", it) } },
        // The boot's start waits for the first screen's content (startDeferredSync); a retry's starts at once, CoreWork's once a
        // screen showed (startSyncWithScreen). The reminder alarms start with sync; CoreWork's at once.
        startSync = {
            if (deferSync) deferredSync.set {
                startSync(app, runtime)
                startReminders(runtime)
            } else {
                startSyncWithScreen(app, runtime)
                startReminders(runtime)
            }
        },
        refreshWidgets = { refreshWidgets(runtime) },
    )

    // ---- Reminder alarms (bundle/host-reminders.ts: core plans every alarm and runs the timers) ----

    /** The reminder alarms' start, and what a resume does (ReminderStart): plan again, or start again after a failed start. */
    private val reminders = ReminderStart<CoreHost>(start = { it.remindersStart() }, cycle = { it.remindersCycle("cycle") })
    @Volatile private var askedNotifications = false
    /** Done once the reminder alarms started (with sync, after the first screen's content): the permission question waits for it. */
    val remindersStarted = kotlinx.coroutines.CompletableDeferred<Unit>()

    /**
     * Started where sync starts, after the validated load, the journal replay and the queue drain: RN's old alarms are cancelled
     * once, then core plans every alarm. A failure never fails the boot: the next resume starts again, and a reschedule plans.
     */
    private fun startReminders(runtime: CoreHost) {
        runCatching { reminders.start(runtime) }
            .onSuccess { now ->
                if (now) logRemindersStarted()
                remindersStarted.complete(Unit)
            }
            .onFailure { Log.w(CoreHost.TAG, "Native Android reminders start failed", it) }
    }

    private fun logRemindersStarted() {
        val reply = reminders.reply ?: return
        Log.i(CoreHost.TAG, "Native Android reminders started mode=${reply.optString("mode")} rnCancelled=${reply.optInt("rnCancelled")}")
    }

    /**
     * Once per process, after the boot: true when RN would ask for the notification permission at start (a reminder feature is on and
     * Android 13+ does not allow notifications yet). The screen asks; its answer reaches core's plan at the next resume.
     */
    @Synchronized fun askNotifications(): Boolean {
        if (askedNotifications || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return false
        val start = reminders.reply ?: return false
        askedNotifications = true
        return start.optBoolean("ask")
    }

    /**
     * A held publication (the boot's or a resume's) runs, its line written to the diagnostics log through core on the widget
     * thread: [trigger] is "content" (the screen's first content), "boot-timeout" (the boot's fallback) or "resume-fallback".
     */
    private fun publishHeldWidgets(runtime: CoreHost, trigger: String) {
        widgetThread.execute {
            runtime.logLine("Native Android held widget publication releaseCheck=v1.3.5/widget-publication-after-content",
                JSONObject().put("trigger", trigger))
        }
        refreshWidgets(runtime)
    }

    /** The home-screen widgets published from the store now if what they show changed, off the caller's thread. */
    private fun refreshWidgets(runtime: CoreHost) = widgetThread.execute {
        runCatching { runtime.refreshWidgets() }.onFailure { Log.w(CoreHost.TAG, "Native Android widget refresh failed", it) }
    }

    /** MainActivity resumed ("active") or paused ("background"): core's triggers sync on resume and on leaving. */
    fun appState(state: String) {
        // RN plans the reminder alarms again on every resume (its start runs one more cycle), so a permission that changed counts;
        // a start that failed starts again.
        if (state == "active") syncThread.execute {
            runCatching { reminders.resume() }
                .onSuccess { if (reminders.reply != null) remindersStarted.complete(Unit) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android reminders cycle failed", it) }
        }
        if (state == appState) return
        appState = state
        // RN republishes the widgets when the app comes to the front (a new day, a changed theme) and flushes a change still
        // waiting when it leaves; a boot still running publishes once it finished. Coming to the front, the publication reads
        // the whole store on core's one thread, so it waits for the screen's first content, as the boot's does (warm starts at
        // 5,000 tasks drew 130 ms later); a resume that draws nothing new publishes after the fallback.
        boot?.takeIf { it.isDone }?.let { task -> runCatching { task.get() }.getOrNull() }?.let { runtime ->
            if (state == "active") {
                // Its own generation: a fallback left from an earlier resume never takes this hold before this screen draws.
                val generation = deferredWidgets.hold(runtime)
                widgetThread.schedule({ deferredWidgets.takeIf(generation)?.let { publishHeldWidgets(it, "resume-fallback") } },
                    WIDGET_FALLBACK_MS, TimeUnit.MILLISECONDS)
            } else {
                deferredWidgets.clear()
                refreshWidgets(runtime)
            }
        }
        val runtime = syncHost ?: return
        syncThread.execute { runCatching { runtime.syncAppState(state) }.onFailure { Log.w(CoreHost.TAG, "Native Android sync app state failed ${failureForLog(it)}") } }
    }

    /**
     * CoreWork's recovery before its job: an owed journal replay (the boot's or a drain's, kind "journal") sent again, as the
     * screens' Try again sends it; CoreJob then drains (recovered). True once nothing is owed. False while that replay still
     * stops, or while a screen's own command is owed: only that screen's exact retry recovers it (the job retries later).
     */
    fun recover(runtime: CoreHost): Boolean {
        val owed = failure ?: return true
        if (owed.action.kind != "journal") return false
        runtime.replayJournal().owed?.let { return false }
        clearFailure(owed.action)
        return true
    }

    /**
     * One drain of the pending-captures queue (core's ingestPendingCaptures, a journaled write), through [recovered] only: at
     * every boot after the journal replay, before any screen, entry point or sync gets the host; after the owed retry; and as
     * CoreWork's job. It waits while another retry is owed. SAVE_FAILED keeps the drain's journal entry, whose replay drains
     * again. An empty [queue] folder needs no drain, so a start with nothing queued journals nothing.
     */
    private fun drain(runtime: CoreHost, queue: File, app: Application): StartOrder.Drain {
        if (failure != null) return StartOrder.Drain.Waiting
        // RN's widget check-offs past their Undo window (an RN user's pending file on the first native start, or a sweep a killed
        // process missed) go into the queue first, through RN's CheckoffStore, so this drain stores them. One that did not (a
        // failed read or queue write, which RN's sweep keeps pending) is retried: the queue still drains, and CoreWork runs again.
        val unswept = runCatching { CheckoffStore.sweep(app).failed > 0 }.onFailure { Log.w(CoreHost.TAG, "Native Android widget check-off sweep failed", it) }.getOrDefault(true)
        if (unswept) runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "unswept"))
        val drained = if (unswept) StartOrder.Drain.Unswept else StartOrder.Drain.Done
        when (StartOrder.queueEmpty(queue.list(), queue.exists())) {
            true -> return drained
            // An unreadable queue folder strands its work as a failed sweep would: retried, never taken for empty.
            null -> {
                runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "unreadable"))
                return StartOrder.Drain.Unswept
            }
            false -> Unit
        }
        return try {
            val ingested = runtime.ingestPendingCaptures(UUID.randomUUID().toString()).optInt("ingested")
            // A count not stored only means the capture waits for the scheduled job: the drain itself stands.
            runCatching { CoreWork.owedUploads(app).add(ingested) }.onFailure { Log.w(CoreHost.TAG, "Native Android owed upload count not stored", it) }
            runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "drained").put("ingested", ingested))
            drained
        } catch (error: Throwable) {
            val message = error.message ?: error.javaClass.simpleName
            runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "failed").put("error", message.substringBefore(':')))
            StartOrder.Drain.Failed(message)
        }
    }

    /** The pending-captures queue's folder, where RN's writer puts it. */
    fun queue(app: Application) = File(app.filesDir, PendingCaptureWriter.DIRECTORY)

    /** Core's setLanguage, then the label map read again in that language. Screens render only after this. */
    private fun setLanguage(runtime: CoreHost, stored: String?): Unit = traced("boot:language") {
        runtime.language(stored ?: "", Locale.getDefault().toLanguageTag())
        Labels.load(runtime.strings(LABEL_KEYS))
    }

    /** RN's theme as core resolves it. The theme is cosmetic: a failed read keeps RN's default look. */
    private fun loadTheme(runtime: CoreHost, stored: String?): Unit = traced("boot:theme") {
        runCatching { ThemeChoice.load(runtime.theme(stored ?: "")) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android theme read failed; using the default theme", it) }
    }

    fun logHostReuse(reason: String, attaches: Int, inFlight: Boolean) {
        Log.i(CoreHost.TAG, "Native Android host reuse releaseCheck=v1.3.3/native-android-dev-host-reuse " +
            "reason=$reason activityAttach=$attaches inFlight=$inFlight boots=$boots")
    }
}
