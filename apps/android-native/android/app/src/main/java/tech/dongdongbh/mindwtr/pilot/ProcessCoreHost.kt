package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import tech.dongdongbh.mindwtr.androidwidget.CheckoffStore
import tech.dongdongbh.mindwtr.androidwidget.PendingCaptureWriter
import tech.dongdongbh.mindwtr.pilot.core.AndroidContentSource
import tech.dongdongbh.mindwtr.pilot.core.BackupOperations
import tech.dongdongbh.mindwtr.pilot.core.BytecodeCache
import tech.dongdongbh.mindwtr.pilot.core.CoreBundle
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.DiagnosticsLogFile
import tech.dongdongbh.mindwtr.pilot.core.HostAppSearch
import tech.dongdongbh.mindwtr.pilot.core.HostCalendars
import tech.dongdongbh.mindwtr.pilot.core.HostGmailReceipts
import tech.dongdongbh.mindwtr.pilot.core.HostDocuments
import tech.dongdongbh.mindwtr.pilot.core.HostSyncLock
import tech.dongdongbh.mindwtr.pilot.core.HostVoice
import tech.dongdongbh.mindwtr.pilot.core.HostFiles
import tech.dongdongbh.mindwtr.pilot.core.HostInstaller
import tech.dongdongbh.mindwtr.pilot.core.HostIo
import tech.dongdongbh.mindwtr.pilot.core.HostNetwork
import tech.dongdongbh.mindwtr.pilot.core.HostWidgets
import tech.dongdongbh.mindwtr.pilot.core.LegacyRnStoreGuard
import tech.dongdongbh.mindwtr.pilot.core.RnKeyValue
import tech.dongdongbh.mindwtr.pilot.core.WidgetAudioDrain
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
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


private const val WIDGET_FALLBACK_MS = 3_000L

internal object ProcessCoreHost {
    private var boot: FutureTask<CoreHost>? = null
    @Volatile private var boots = 0


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


    @Synchronized fun recordFailure(pending: PendingFailure) {
        if (pending.action.kind == "storage" && failure?.action?.kind.let { it != null && it != "storage" }) return
        failure = pending
    }


    @Synchronized fun clearFailure(action: FailedAction) {
        if (failure?.action == action) failure = null
    }


    val booted: Boolean get() = synchronized(this) { boot != null }


    fun get(app: Application, language: String? = null, sandboxRequest: String? = null): CoreHost {
        var starter = false
        val task = synchronized(this) {
            boot ?: FutureTask { start(app, language, sandboxRequest) }.also {
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

            synchronized(this) { if (boot === task) boot = null }
            throw failure.cause ?: failure
        }
        if (!starter) logHostReuse("new-screen", attaches = 1, inFlight = false)
        return host
    }

    private class SandboxRequestExpired : Exception()

    @Volatile private var sandboxHost: CoreHost? = null


    fun isSandbox(host: CoreHost) = host === sandboxHost


    private fun start(app: Application, language: String?, sandboxRequest: String?): CoreHost =
        try { open(app, language, sandboxRequest) } catch (_: SandboxRequestExpired) {
            Log.w(CoreHost.TAG, "Native Android sandbox request refused by core; restarting into the real workspace releaseCheck=v1.3.9/native-sandbox")
            Workspace.restart(app)
            throw IllegalStateException("The process did not restart")
        }


    private fun open(app: Application, language: String?, sandboxRequest: String?): CoreHost {
        application = app
        val scratch = Workspace.scratch(app)
        val sandbox = sandboxRequest != null
        if (!sandbox && scratch.exists() && !scratch.deleteRecursively()) Log.w(CoreHost.TAG, "Native Android sandbox scratch files not removed")
        if (sandbox) check(Workspace.freshBootFiles(scratch)) { "The sandbox boot files were not reset" }


        val legacy = if (BuildConfig.RN_STORAGE && !sandbox) {
            LegacyRnStoreGuard.requireClear(app.dataDir, File(app.cacheDir, "legacy-rn-guard"))
        } else {
            null
        }
        val installer = if (sandbox) HostInstaller(File(scratch, "files"), File(scratch, "cache")) else HostInstaller(app.filesDir, app.cacheDir)
        val files = Workspace.files(legacy?.database ?: File(app.filesDir, "mindwtr-native-dev.db"), File(app.filesDir, "journal"),
            app.getDatabasePath("RKStorage"), scratch, sandbox = sandbox)
        val runtime = host(app, files, legacy, installer, sandbox)
        try {
            if (sandboxRequest != null) {
                val opened = runtime.start(coreBundle(app), sandboxRequest = sandboxRequest)
                if (opened.optString("workspace") != "sandbox") throw SandboxRequestExpired()
                val sampleLanguage = opened.optString("language").ifEmpty { null }
                val sampleTheme = opened.optString("theme").ifEmpty { null }
                Workspace.viewPrefs(app, sandbox = true).edit().apply {
                    sampleLanguage?.let { putString(LANGUAGE_KEY, it) }
                    sampleTheme?.let { putString(THEME_KEY, it) }
                }.commit()
                setLanguage(runtime, sampleLanguage ?: language)
                loadTheme(runtime, sampleTheme)
                sandboxHost = runtime
                return runtime
            }
            runtime.start(coreBundle(app), legacy?.bootState ?: "", legacy?.backup ?: "", legacy?.preflight == true)

            if (legacy != null) {
                runtime.logLine("Native Android legacy import preflight releaseCheck=v1.3.5/native-android-legacy-preflight", JSONObject()
                    .put("releaseCheck", "v1.3.5/native-android-legacy-preflight").put("outcome", if (legacy.preflight) "passed" else "skipped"))
            }
            setLanguage(runtime, language ?: legacy?.language)
            loadTheme(runtime, legacy?.theme)


            recoverInstalls(installer)
            if (replay(runtime)) recovered(app, runtime, deferSync = true)


            deferredWidgets.hold(runtime)
            return runtime
        } catch (failure: Throwable) {
            runCatching { runtime.close() }
            throw failure
        }
    }


    private fun host(app: Application, files: Workspace.Files, legacy: LegacyRnStoreGuard.Opened?, installer: HostInstaller, sandbox: Boolean): CoreHost {
        val keyValue = RnKeyValue(files.keyValue)
        return CoreHost(files.database, legacy?.let { app.dataDir }, HostIo(app),
            files.journal, deviceStore(app, keyValue, sandbox), File(app.filesDir, DiagnosticsLogFile.RELATIVE_PATH),
            keyValue, HostFiles(app.filesDir, app.cacheDir, content = AndroidContentSource(app)), installer,
            if (sandbox) SandboxReminders else ReminderAlarms(app, keyValue, checkpointRnState = { if (legacy != null) LegacyRnStoreGuard.checkpointRnState(app.dataDir) }),
            if (sandbox) null else HostWidgets(app) { appState },
            scheduleBackgroundSync = if (sandbox) null else { on -> CoreWork.scheduleSyncStored(app, on) }, appInfo = aboutAppInfo(),
            backups = BackupOperations(Workspace.dir(app, "backup-operations", sandbox), if (sandbox) Workspace.dir(app, "snapshots", true) else File(app.filesDir, "snapshots"),
                maxPlanBytes = DataTransferLimits.MAX_PLAN_BYTES),
            calendars = HostCalendars(app), documents = HostDocuments(app), syncLock = HostSyncLock(app),
            appSearch = HostAppSearch(app, app.getString(R.string.mindwtr_link_scheme)),
            gmail = (gmail ?: GmailAuthorization(app).also { gmail = it })::call, gmailReceipts = HostGmailReceipts(if (sandbox) Workspace.dir(app, "GmailCapture", true) else File(app.filesDir, "GmailCapture")),
            voice = HostVoice.forApp(app)::call)
    }


    private fun coreBundle(app: Application): CoreBundle {
        val hash = runCatching { app.assets.open("core-host.js").use(BytecodeCache::bundleKey) }.getOrDefault("")
        val cache = BytecodeCache(File(app.codeCacheDir, "core-host.qjsc"), BuildConfig.QUICKJS_WRAPPER)
        return CoreBundle(hash, cache) { traced("boot:bundleRead") { app.assets.open("core-host.js").use { it.readBytes() } } }
    }


    fun contentShown() {
        startDeferredSync()
        val task = synchronized(this) { boot } ?: return
        val runtime = if (task.isDone) runCatching { task.get() }.getOrNull() else null
        runtime?.cacheBytecode()

        if (runtime != null && saveWarmStarted.compareAndSet(false, true)) Thread({
            runCatching { runtime.warmFirstSave() }.onFailure { Log.w(CoreHost.TAG, "Native Android save warm failed ${failureForLog(it)}") }
        }, "mindwtr-save-warm").also { it.priority = Thread.MIN_PRIORITY }.start()
    }


    private val resumeCycleLogged = java.util.concurrent.atomic.AtomicBoolean(false)


    private val saveWarmStarted = java.util.concurrent.atomic.AtomicBoolean(false)


    private fun resumedRuntime(): CoreHost? = boot?.takeIf { it.isDone }?.let { task -> runCatching { task.get() }.getOrNull() }


    private val aboutStarted = java.util.concurrent.atomic.AtomicBoolean(false)


    fun aboutStartup(runtime: CoreHost) {
        if (!aboutStarted.compareAndSet(false, true)) return
        Thread({
            runCatching { runtime.aboutRequest("sendAboutHeartbeat", "{}") }
                .onSuccess { Log.i(CoreHost.TAG, "Native Android heartbeat sent=${it.optBoolean("sent")}") }
                .onFailure { Log.w(CoreHost.TAG, "Native Android heartbeat failed ${failureForLog(it)}") }
        }, "mindwtr-about-startup").start()
    }


    private val deferredSync = AtomicReference<(() -> Unit)?>(null)

    private val deferredWidgets = HeldPublication<CoreHost>()


    private var screenShown = false


    fun startDeferredSync(trigger: String = "content") {
        synchronized(deferredSync) {
            screenShown = true
            deferredSync.getAndSet(null)
        }?.let { start -> syncThread.execute { start() } }
        deferredWidgets.take()?.let { publishHeldWidgets(it, trigger) }
    }


    private fun startSyncWithScreen(app: Application, runtime: CoreHost) {
        val now = synchronized(deferredSync) {

            if (!screenShown) deferredSync.compareAndSet(null) { startSync(app, runtime) }
            screenShown
        }
        if (now) startSync(app, runtime)
    }


    val appActive get() = appState == "active"


    private fun replay(runtime: CoreHost): Boolean {
        val replay = runtime.replayJournal()
        replay.owed?.let { recordFailure(PendingFailure(FailedAction("journal", ""), it, null)); return false }


        if (replay.left > 0) return true
        val pruneStarted = SystemClock.elapsedRealtime()
        runCatching { runtime.pruneReceipts() }
            .onSuccess {
                val elapsedMs = SystemClock.elapsedRealtime() - pruneStarted
                Log.i(CoreHost.TAG, "Native Android receipts pruned=${it.optInt("pruned")} elapsedMs=$elapsedMs releaseCheck=v1.3.9/native-receipt-prune")
                runtime.logLine("Native Android receipts pruned releaseCheck=v1.3.9/native-receipt-prune",
                    JSONObject().put("releaseCheck", "v1.3.9/native-receipt-prune").put("pruned", it.optInt("pruned")).put("elapsedMs", elapsedMs))
            }
            .onFailure { Log.w(CoreHost.TAG, "Native Android receipts prune failed", it) }
        return true
    }


    private fun recoverInstalls(installer: HostInstaller) {
        runCatching { installer.recover() }
            .onSuccess { found ->
                if (found.isNotEmpty()) Log.i(CoreHost.TAG, "Native Android install recovery " +
                    found.groupingBy { it.outcome }.eachCount().entries.joinToString(" ") { "${it.key}=${it.value}" })
            }
            .onFailure { Log.w(CoreHost.TAG, "Native Android install recovery failed ${failureForLog(it)}") }
    }


    @Volatile private var appState = "background"

    @Volatile private var syncHost: CoreHost? = null

    private val syncLock = Any()
    private val syncThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-sync-events") }
    private val widgetThread = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "mindwtr-widget-refresh") }
    private val syncListeners = CopyOnWriteArraySet<(JSONObject) -> Unit>()

    @Volatile var syncState: JSONObject? = null
        private set


    fun listenSync(listener: (JSONObject) -> Unit) = syncListeners.add(listener)
    fun unlistenSync(listener: (JSONObject) -> Unit) = syncListeners.remove(listener)

    private fun dispatch(event: JSONObject) {
        if (event.optString("type") == "sync") syncState = event
        syncListeners.forEach { runCatching { it(event) } }
    }


    private fun startSync(app: Application, runtime: CoreHost): Unit = synchronized(syncLock) {
        if (syncHost != null) return
        runtime.onEvent = { text -> runCatching { dispatch(JSONObject(text)) } }
        runCatching {
            val network = HostNetwork(app) { state -> syncThread.execute { runCatching { runtime.syncNetwork(state) } } }
            runtime.syncNetwork(network.state())
            val startedWith = appState

            runtime.syncStart(startedWith).put("type", "sync").let { reply -> if (syncState == null) syncState = reply }
            syncHost = runtime
            network.start()
            drainAudio(app, runtime, SystemClock.uptimeMillis())

            appState.takeIf { it != startedWith }?.let { now -> syncThread.execute { runCatching { runtime.syncAppState(now) } } }
            Log.i(CoreHost.TAG, "Native Android sync started appState=$appState")
        }.onFailure { Log.w(CoreHost.TAG, "Native Android sync start failed ${failureForLog(it)}") }
    }


    fun recovered(app: Application, runtime: CoreHost, deferSync: Boolean = false): Boolean = isSandbox(runtime) || StartOrder.afterReplay(
        drain = { drain(runtime, queue(app), app) },
        owe = { message -> recordFailure(PendingFailure(FailedAction("journal", ""), message, null)) },
        retryLater = { runCatching { CoreWork.retryDrain(app) }.onFailure { Log.w(CoreHost.TAG, "Native Android drain retry not queued", it) } },


        startSync = {
            if (deferSync) deferredSync.set {
                startSync(app, runtime)
                startReminders(runtime)
                startAppSearch(runtime)
            } else {
                startSyncWithScreen(app, runtime)
                startReminders(runtime)

                if (screenShown) startAppSearch(runtime)
            }
        },
        refreshWidgets = { refreshWidgets(runtime) },
    )


    private val reminders = ReminderStart<CoreHost>(start = { it.remindersStart() }, cycle = { it.remindersCycle("cycle") })
    @Volatile private var askedNotifications = false

    @Volatile private var application: Application? = null

    private var gmail: GmailAuthorization? = null

    val remindersStarted = kotlinx.coroutines.CompletableDeferred<Unit>()


    private fun startAppSearch(runtime: CoreHost) {
        Thread({
            runCatching { runtime.appSearchStart() }.onFailure { Log.w(CoreHost.TAG, "Native Android system search start failed ${failureForLog(it)}") }
        }, "mindwtr-app-search-start").start()
    }


    private fun startReminders(runtime: CoreHost) {
        runCatching { reminders.start(runtime) }
            .onSuccess { now ->
                if (now) logRemindersStarted()
                remindersStarted.complete(Unit)
            }
            .onFailure { Log.w(CoreHost.TAG, "Native Android reminders start failed", it) }

        application?.let { PersistentCapture.restore(it, runtime) }
    }

    private fun logRemindersStarted() {
        val reply = reminders.reply ?: return
        Log.i(CoreHost.TAG, "Native Android reminders started mode=${reply.optString("mode")} rnCancelled=${reply.optInt("rnCancelled")}")
    }


    @Synchronized fun askNotifications(): Boolean {
        if (askedNotifications || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return false
        val start = reminders.reply ?: return false
        askedNotifications = true
        return start.optBoolean("ask")
    }


    private fun publishHeldWidgets(runtime: CoreHost, trigger: String) {
        widgetThread.execute {
            runtime.logLine("Native Android held widget publication releaseCheck=v1.3.5/widget-publication-after-content",
                JSONObject().put("trigger", trigger))
        }
        refreshWidgets(runtime)
    }


    private fun refreshWidgets(runtime: CoreHost, leave: Boolean = false) = widgetThread.execute {
        runCatching { runtime.refreshWidgets(leave) }.onFailure { Log.w(CoreHost.TAG, "Native Android widget refresh failed", it) }
    }


    fun appState(state: String) {


        val changed = state != appState
        appState = state
        val resumedAt = SystemClock.uptimeMillis()
        if (state == "active") syncThread.execute {


            resumedRuntime()?.let { runtime ->


                val ended = runtime.awaitQuiet(resumedAt, quietSince = resumedAt) { appState != "active" }

                if (ended != "quiet" || resumeCycleLogged.compareAndSet(false, true)) {
                    val context = JSONObject().put("releaseCheck", "v1.3.8/native-resume-cycle-quiet").put("stage", ended)
                        .put("durationMs", SystemClock.uptimeMillis() - resumedAt)
                    runtime.logLine("Native Android resume reminder cycle after its quiet wait releaseCheck=v1.3.8/native-resume-cycle-quiet", context)
                }
            }
            runCatching { reminders.resume() }
                .onSuccess { if (reminders.reply != null) remindersStarted.complete(Unit) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android reminders cycle failed", it) }

            val app = application
            val runtime = boot?.takeIf { it.isDone }?.let { task -> runCatching { task.get() }.getOrNull() }
            if (app != null && runtime != null && reminders.reply != null) PersistentCapture.restore(app, runtime)


            if (BuildConfig.DEBUG && runtime != null && debugProperty("appsearch_dump") == "1") {
                runCatching { runtime.appSearchIds().optJSONArray("ids").also { File(app?.cacheDir, "appsearch-debug-ids.json").writeText(it.toString()) } }
                    .onSuccess { Log.i(CoreHost.TAG, "Native Android system search debug ids written count=${it?.length()}") }
                    .onFailure { Log.w(CoreHost.TAG, "Native Android system search debug read failed ${failureForLog(it)}") }
            }
        }
        if (!changed) return


        boot?.takeIf { it.isDone }?.let { task -> runCatching { task.get() }.getOrNull() }?.let { runtime ->
            if (state == "active") {

                val generation = deferredWidgets.hold(runtime)
                widgetThread.schedule({ deferredWidgets.takeIf(generation)?.let { publishHeldWidgets(it, "resume-fallback") } },
                    WIDGET_FALLBACK_MS, TimeUnit.MILLISECONDS)
            } else {


                refreshWidgets(runtime, leave = !deferredWidgets.leave())
            }
        }
        val runtime = syncHost ?: return
        syncThread.execute { runCatching { runtime.syncAppState(state) }.onFailure { Log.w(CoreHost.TAG, "Native Android sync app state failed ${failureForLog(it)}") } }
        if (state == "active") application?.let { drainAudio(it, runtime, resumedAt, quietSince = resumedAt) { appState != "active" } }
    }

    private val audioThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-widget-audio") }
    private val audioDrainQueued = java.util.concurrent.atomic.AtomicBoolean(false)


    private fun drainAudio(app: Application, runtime: CoreHost, askedAt: Long, quietSince: Long = 0, stop: () -> Boolean = { false }) {
        if (isSandbox(runtime)) return
        if (!audioDrainQueued.compareAndSet(false, true)) return
        audioThread.execute {
            audioDrainQueued.set(false)
            WidgetAudioDrain.run({ WidgetAudioDrain.hasQueuedRecording(queue(app)) }, { runtime.awaitQuiet(askedAt, quietSince, stop) },
                {
                    Log.i(CoreHost.TAG, "Native Android widget audio drain after its quiet wait waitedMs=${SystemClock.uptimeMillis() - askedAt}")
                    runCatching { runtime.ingestPendingAudio() }.onFailure { Log.w(CoreHost.TAG, "Native Android widget audio drain failed ${failureForLog(it)}") }
                })
        }
    }


    fun recover(runtime: CoreHost): Boolean {
        val owed = failure ?: return true
        if (owed.action.kind != "journal") return false
        runtime.replayJournal().owed?.let { return false }
        clearFailure(owed.action)
        return true
    }


    private fun drain(runtime: CoreHost, queue: File, app: Application): StartOrder.Drain {
        if (failure != null) return StartOrder.Drain.Waiting


        val unswept = runCatching { CheckoffStore.sweep(app).failed > 0 }.onFailure { Log.w(CoreHost.TAG, "Native Android widget check-off sweep failed", it) }.getOrDefault(true)
        if (unswept) runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "unswept"))
        val drained = if (unswept) StartOrder.Drain.Unswept else StartOrder.Drain.Done
        when (StartOrder.queueEmpty(queue.list(), queue.exists())) {
            true -> return drained

            null -> {
                runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "unreadable"))
                return StartOrder.Drain.Unswept
            }
            false -> Unit
        }
        return try {
            val ingested = runtime.ingestPendingCaptures(UUID.randomUUID().toString()).optInt("ingested")

            runCatching { CoreWork.owedUploads(app).add(ingested) }.onFailure { Log.w(CoreHost.TAG, "Native Android owed upload count not stored", it) }
            runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "drained").put("ingested", ingested))
            drained
        } catch (error: Throwable) {
            val message = error.message ?: error.javaClass.simpleName
            runtime.logLine("Native Android queue drain", JSONObject().put("outcome", "failed").put("error", message.substringBefore(':')))
            StartOrder.Drain.Failed(message)
        }
    }


    fun queue(app: Application) = File(app.filesDir, PendingCaptureWriter.DIRECTORY)


    private fun setLanguage(runtime: CoreHost, stored: String?): Unit = traced("boot:language") {
        runtime.language(stored ?: "", Locale.getDefault().toLanguageTag())
        loadLabels(runtime)
    }


    private fun loadTheme(runtime: CoreHost, stored: String?): Unit = traced("boot:theme") {
        runCatching { ThemeChoice.load(runtime.theme(stored ?: "")) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android theme read failed; using the default theme", it) }
    }

    fun logHostReuse(reason: String, attaches: Int, inFlight: Boolean) {
        Log.i(CoreHost.TAG, "Native Android host reuse releaseCheck=v1.3.3/native-android-dev-host-reuse " +
            "reason=$reason activityAttach=$attaches inFlight=$inFlight boots=$boots")
    }
}
