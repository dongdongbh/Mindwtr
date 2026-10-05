package tech.dongdongbh.mindwtr.pilot.core

import android.icu.text.Collator
import android.icu.text.RuleBasedCollator
import android.icu.util.ULocale
import android.os.Trace
import android.util.Log
import com.whl.quickjs.android.QuickJSLoader
import com.whl.quickjs.wrapper.JSCallFunction
import com.whl.quickjs.wrapper.JSFunction
import com.whl.quickjs.wrapper.JSObject
import com.whl.quickjs.wrapper.QuickJSContext
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.BuildConfig
import java.io.File
import java.security.SecureRandom
import android.os.SystemClock
import java.util.concurrent.Callable
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future
import java.util.concurrent.FutureTask
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * QuickJS and SQLite share one worker thread; Compose never enters either runtime.
 * [rnDataDir] is set only when [databaseFile] is the React Native app's database:
 * then the JS host may apply RN's AsyncStorage change after it imported RN's backup.
 * [io] runs the JS host's fetch and secret calls off this thread; their answers come back in [callAsync]'s pump loop.
 * [logFile] is RN's diagnostics log (DiagnosticsLogFile.RELATIVE_PATH under the app's files directory).
 * [keyValue] is RN's AsyncStorage (RKStorage): the device keys RN keeps there, read and written in place.
 */
class CoreHost(
    private val databaseFile: File,
    private val rnDataDir: File? = null,
    private val io: HostIo,
    private val journalDir: File,
    /** A write's deviceWrites (a setting's device-local part), kept with the journal sequence that set each key. */
    private val devices: DeviceWrites,
    private val logFile: File,
    private val keyValue: RnKeyValue,
    /** The pending-captures queue's files (host-entry's queue port), and core's attachment file port. */
    private val files: HostFiles,
    /** RN's attachment installer: core's native installer port. */
    private val installer: HostInstaller,
    /** Reminder alarms' platform side (host-reminders.ts's bridges); null: this host plans no alarms. */
    private val reminders: Reminders? = null,
    /** RN's home-screen widgets (bundle/host-widgets.ts publishes through it); null: this host has none. */
    private val widgets: HostWidgets? = null,
    /** The background sync job kept scheduled or cancelled, as core decides (CoreWork.scheduleSync); null: this host has none. */
    private val scheduleBackgroundSync: ((Boolean) -> Unit)? = null,
) {
    /**
     * Reminder alarms on the platform (pilot/Reminders.kt): core's plan applied in core's order, the notification permission as RN
     * reads it, and React Native's old alarms cancelled once. Engine thread.
     */
    interface Reminders {
        /** Core's NativeReminderAlarmPlan (JSON, with the channel's name): `writeAhead` stored, cancels, alarms, then `alarms` stored. */
        fun apply(plan: String)
        fun permissionGranted(): Boolean
        /** React Native's alarms cancelled and its alarm maps removed; how many were cancelled (0 once none is left). */
        fun cleanupRn(): Int
        /** `{ dropped, notQueued }` since the last call, then zero (ReminderReceiverCounts). */
        fun receiverCounts(): String
        /** `{ fired, shown }`: ids of alarms that showed (ReminderLedger), and of reminder notifications still in the tray. */
        fun ledger(): String
    }

    companion object {
        const val TAG = "MindwtrNativeDev"
        /** Must match NATIVE_ERROR in bundle/host-entry.ts. */
        private const val NATIVE_ERROR = "!MindwtrNativeError:"

        /**
         * An operation's deadline: the longest core timeout it can wrap. A contract read or command waits at most on core's
         * storage (STORAGE_TIMEOUT_MS, 15 s), inside core's request timeout (DEFAULT_TIMEOUT_MS, 30 s).
         */
        const val OPERATION_DEADLINE_MS = 30_000L
        /** An operation that sends requests: HostIo's ceiling for one request, plus core's 30 s for the work around it. */
        const val NETWORK_DEADLINE_MS = HostIo.CALL_TIMEOUT_MS + OPERATION_DEADLINE_MS
        /** A project's attachment commands (Attachments.kt ATTACHMENT_KINDS): each copies a picked file, which a slow provider stretches. */
        private val ATTACHMENT_COMMANDS = setOf("attachmentAddFile", "attachmentLinks", "attachmentRemove")

        /**
         * An operation's deadline: a request's (NETWORK_DEADLINE_MS) for an attachment command, on its first send and on the journal's
         * replay alike, so a slow copy never stops the host; [OPERATION_DEADLINE_MS] for everything else.
         */
        fun deadlineOf(method: String, args: List<Any?>): Long =
            if (method == "menuCommand" && args.firstOrNull() in ATTACHMENT_COMMANDS) NETWORK_DEADLINE_MS else OPERATION_DEADLINE_MS

        /** How long a timed-out operation may take to end once cancelled, before the host stops for good. */
        const val DRAIN_MS = 10_000L
        /**
         * How long a caller waits for a long operation ([callLong]: a Sync screen command, whose sync can make several requests
         * of up to HostIo's 5 min each). Past it the caller stops waiting; the operation holds no engine time, so it goes on.
         */
        const val SYNC_WAIT_MS = 30 * 60 * 1000L

        /**
         * A Kotlin exception must not cross the QuickJS JNI boundary: the
         * wrapper keeps calling JNI with it pending and the process aborts.
         * Return it as a marked string; host-entry.ts throws it inside JS.
         */
        private fun guarded(work: (Array<out Any?>) -> Any?) = JSCallFunction { args ->
            try { work(args) } catch (error: Throwable) { NATIVE_ERROR + (error.message ?: error.javaClass.simpleName) }
        }
        init { traced("core:loadQuickJs") { QuickJSLoader.init() } }
    }

    private val lifecycleLock = Any()
    private var shutdown: Future<*>? = null
    private val random = SecureRandom()
    private val startedAt = System.nanoTime()
    private var context: QuickJSContext? = null
    private var sqlite: SqliteBridge? = null
    /** The write-ahead journal (WriteJournal), opened at start on this thread. */
    private var journal: WriteJournal? = null
    private val functions = HashMap<String, JSFunction>()
    /** Set when an operation outlived its deadline and its drain. The engine is gone, so that operation never resumes. */
    @Volatile private var stopped: String? = null
    /** ICU collators by "sensitivity:numeric", made and used on the engine thread only. */
    private val collators = HashMap<String, Collator>()
    private var hostObject: JSObject? = null
    @Volatile private var engineThread: Thread? = null
    private val executor = ScheduledThreadPoolExecutor(1) { task -> Thread(task, "mindwtr-core").also { engineThread = it } }.apply {
        executeExistingDelayedTasksAfterShutdownPolicy = false
        removeOnCancelPolicy = true
    }
    /** The next idle pump ([schedulePump]) and when it runs (uptime); engine thread only. */
    private var pumpTask: ScheduledFuture<*>? = null
    private var pumpAt = Long.MAX_VALUE
    /** Long operations ([callLong]) by id, each answered from the pump; engine thread only. */
    private val watched = HashMap<String, CompletableFuture<String>>()
    /**
     * The JS host's events (bundle/host-sync.ts): sync's badge and finished-cycle count, an automatic sync's warning. Called on
     * the engine thread, so a listener only hands the text on and never calls back into this host.
     */
    @Volatile var onEvent: ((String) -> Unit)? = null

    private fun <T> onEngine(work: () -> T): T {
        if (Thread.currentThread() === engineThread) return work()
        val task = synchronized(lifecycleLock) {
            check(shutdown == null) { "Core host is closed" }
            executor.submit(Callable { work() })
        }
        // Rethrow the engine's own exception: callers match "SAVE_FAILED" on its message. The caller's wait, queue and run, as a
        // trace section (merge profiling: how long a screen's call waits behind the engine's other work).
        return try { traced("core:wait") { task.get() } } catch (failure: ExecutionException) { throw failure.cause ?: failure }
    }

    private fun call(method: String, vararg args: Any?): Any? = onEngine {
        val engine = checkNotNull(context)
        val host = hostObject ?: engine.globalObject.getJSObject("MindwtrHost").also { hostObject = it }
        functions.getOrPut(method) { host.getJSFunction(method) }.call(*args)
    }

    /**
     * [legacyState] and [legacyBackup] come from LegacyRnStoreGuard; both are "" for the dev database.
     *
     * SQLite opens and takes its recovery checkpoint on the caller's thread while the engine thread loads the bundle. No SQL
     * runs before the checkpoint: the bridge's SQL calls take the database from [opened] (they would wait for it), and boot,
     * the first caller, starts only after the engine owns it. From then on only the engine thread uses it.
     */
    fun start(bundle: CoreBundle, legacyState: String = "", legacyBackup: String = ""): JSONObject {
        val opened = FutureTask {
            val database = traced("core:sqliteOpen") { SqliteBridge(databaseFile) }
            try {
                traced("core:recoveryCheckpoint") { database.ensureRecoveryCheckpoint() }
            } catch (error: Throwable) {
                runCatching { database.close() }
                throw error
            }
            database
        }
        val database = { opened.get() }
        val loading = synchronized(lifecycleLock) {
            check(shutdown == null) { "Core host is closed" }
            executor.submit(Callable {
                Trace.beginSection("core:journalOpen")
                journal = WriteJournal(journalDir, log = { Log.i(TAG, it) }, floor = devices.highestSequence())
                Trace.endSection()
                Trace.beginSection("core:contextCreate")
                val engine = QuickJSContext.create()
                Trace.endSection()
                context = engine
                install(engine, database)
                // A fetch or secret answer queued while no call runs wakes the idle pump, which settles it at once.
                io.wake = { runCatching { executor.execute { idlePump() } } }
                // An aborted file call's stalled document read ends (fileAbort), and each call's reader is forgotten when it ends.
                io.abortReader = files::abortRead
                io.readDone = files::readDone
                load(engine, database, bundle)
            })
        }
        opened.run()
        // The engine runs this after the load (one thread, in order).
        return onEngine {
            try {
                loading.get()
                sqlite = database()
                // This host journals every write (WriteJournal), so core requires each write's replay tokens.
                callAsync("boot", legacyState, legacyBackup, "journaled").also { netCheck() }
            } catch (failure: Throwable) {
                if (sqlite == null) runCatching { database().close() }
                closeOnEngine()
                throw (failure as? ExecutionException)?.cause ?: failure
            }
        }
    }

    /** Where the bundle came from at start: "hit" (its cached bytecode), or why the source ran (BytecodeCache.Read). */
    @Volatile private var bundleOutcome = ""
    @Volatile private var bundleSource: CoreBundle? = null
    private var cacheWriter: Thread? = null

    /**
     * The bundle into [engine]: its cached bytecode when the cache's key matches, without reading the source; else the
     * source. Bytecode that fails to run is dropped with its engine, and a new engine runs the source.
     */
    private fun load(first: QuickJSContext, database: () -> SqliteBridge, bundle: CoreBundle) {
        var engine = first
        val cached = bundle.cache?.let { cache -> bundle.hash.takeIf { it.isNotEmpty() }?.let(cache::read) }
        bundleOutcome = cached?.outcome ?: "off"
        Trace.beginSection("core:evaluate")
        try {
            cached?.bytecode?.let { compiled ->
                val ran = runCatching { engine.execute(compiled) }
                if (ran.isSuccess) return
                bundleOutcome = "failed:${ran.exceptionOrNull()?.javaClass?.simpleName}"
                engine.destroy()
                engine = QuickJSContext.create().also { context = it }
                functions.clear()
                hostObject = null
                install(engine, database)
            }
            engine.evaluate(bundle.source(), "core-host.js")
        } finally {
            Trace.endSection()
            bundleSource = bundle
            Log.i(TAG, "Native Android bundle load releaseCheck=v1.3.4/native-android-bytecode-cache outcome=$bundleOutcome")
        }
    }

    /**
     * After first content (ProcessCoreHost.contentShown): a start that ran the source compiles the bundle on a thread of its
     * own, on an engine of its own, and writes the cache for the next start. It writes only bytecode compiled from bytes whose
     * SHA-256 it has just checked against the bundle's key. Once per host; a failure only logs (the next start runs the source).
     */
    fun cacheBytecode() {
        val writer = synchronized(lifecycleLock) {
            if (bundleOutcome == "hit" || cacheWriter != null || shutdown != null) return
            val bundle = bundleSource ?: return
            val cache = bundle.cache ?: return
            Thread({
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
                val outcome = runCatching {
                    val bytes = bundle.bytes()
                    check(BytecodeCache.bodyMatches(bytes, bundle.hash)) { "the bundle does not match its key" }
                    val compiler = QuickJSContext.create()
                    val compiled = try { compiler.compile(String(bytes, Charsets.UTF_8), "core-host.js") } finally { compiler.destroy() }
                    if (cache.write(bundle.hash, compiled)) "written bytes=${compiled.size}" else "write-failed"
                }.getOrElse { "failed:${it.javaClass.simpleName}" }
                Log.i(TAG, "Native Android bytecode cache releaseCheck=v1.3.4/native-android-bytecode-cache outcome=$outcome")
            }, "mindwtr-bytecode").also { cacheWriter = it }
        }
        writer.start()
    }

    /** The native bridge, `globalThis.__mindwtrNative`, on a new [engine]; [database] waits for SQLite's recovery checkpoint. */
    private fun install(engine: QuickJSContext, database: () -> SqliteBridge) {
        val bridge = engine.createNewJSObject()
        bridge.setProperty("sqlRun", guarded { args -> traced("sql:run") { database().run(args[0] as String, args[1] as String) }; null })
        bridge.setProperty("sqlAll", guarded { args -> traced("sql:all") { database().all(args[0] as String, args[1] as String) } })
        bridge.setProperty("sqlExec", guarded { args -> traced("sql:exec") { database().exec(args[0] as String) }; null })
        // The bundle's boot steps as trace sections (Perfetto): a name opens one, "" closes the open one.
        bridge.setProperty("trace", guarded { args ->
            (args[0] as String).let { if (it.isEmpty()) Trace.endSection() else Trace.beginSection(it.take(127)) }
            null
        })
        bridge.setProperty("nowMs", guarded { _ -> (System.nanoTime() - startedAt) / 1e6 })
        bridge.setProperty("randomBytes", guarded { args ->
            val length = (args[0] as Number).toInt()
            require(length in 0..65_536) { "Invalid random byte count" }
            JSONArray().also { out ->
                ByteArray(length).also(random::nextBytes).forEach { out.put(it.toInt() and 0xff) }
            }.toString()
        })
        // `{ clearJsonAhead, setReconciled }`, decided by core's planLegacyJsonImport after the saved import is read back.
        bridge.setProperty("rnStateCommit", guarded { args ->
            val change = JSONObject(args[0] as String)
            LegacyRnStoreGuard.commitRnState(checkNotNull(rnDataDir) { "No React Native state in this build" },
                change.getBoolean("clearJsonAhead"), change.getBoolean("setReconciled"))
            null
        })
        // QuickJS has no Intl: the host's Intl.Collator and localeCompare sort by these ICU collation keys, from the device
        // locale's collator as Hermes uses on Android, so titles order as in RN ("éclair" before "Zoo"). The key's bytes
        // become chars 1-255 (the trailing 0 dropped), so comparing two keys as strings compares them as ICU does.
        bridge.setProperty("collationKey", guarded { args ->
            val options = args[1] as String
            val collator = collators.getOrPut(options) {
                val (sensitivity, numeric) = options.split(':')
                Collator.getInstance(ULocale.getDefault()).apply {
                    strength = when (sensitivity) { "base", "case" -> Collator.PRIMARY; "accent" -> Collator.SECONDARY; else -> Collator.TERTIARY }
                    (this as? RuleBasedCollator)?.let { rules ->
                        rules.isCaseLevel = sensitivity == "case"
                        rules.numericCollation = numeric == "1"
                    }
                    freeze()
                }
            }
            val bytes = collator.getCollationKey(args[0] as String).toByteArray()
            String(CharArray(bytes.size - 1) { (bytes[it].toInt() and 0xff).toChar() })
        })
        // The host's Intl.DateTimeFormat and Date's toLocale*String: Android's ICU, resolved and formatted as Hermes does.
        val dates = IcuDateTimeFormat()
        bridge.setProperty("dateTimeFormat", guarded { args -> dates.reply(args[0] as String, args[1] as String, (args[2] as Number).toDouble()) })
        // Debug builds only: check-intl-device.mjs's cases, logged once the bundle (and so the polyfill) is loaded.
        if (debugFault("intl_check") == "1") engine.globalObject.setProperty("__mindwtrIntlCheck", true)
        // A diagnostic line must never fail the caller: coerce and swallow.
        bridge.setProperty("log", guarded { args -> runCatching { Log.i(TAG, args.getOrNull(0).toString()) }; null })
        // fetch and the secret calls (host-polyfills.js): each only starts here; HostIo runs it off this thread and
        // queues its answer, and the polyfill settles it when the pump loop below takes that answer with ioNext.
        bridge.setProperty("netFetch", guarded { args -> io.fetch(args[0] as String) })
        bridge.setProperty("netAbort", guarded { args -> io.abort(args[0] as String); null })
        bridge.setProperty("secretCall", guarded { args -> io.secret(args[0] as String) })
        // Sync encryption's Argon2id and AES-GCM (HostCrypto): started here, run on HostIo's crypto thread, settled as a fetch.
        bridge.setProperty("cryptoCall", guarded { args -> io.crypto(args[0] as String) })
        bridge.setProperty("ioNext", guarded { _ -> io.next() })
        bridge.setProperty("ioBody", guarded { _ -> io.body() })
        // RN's diagnostics log file: core's diagnostics-log.ts decides every write; this is its file IO.
        val logs = DiagnosticsLogFile(logFile)
        bridge.setProperty("logFile", guarded { args -> logs.run(args[0] as String, args.getOrNull(1)?.toString().orEmpty()) })
        // RN's AsyncStorage (RnKeyValue): reads answer JSON (a value, or AsyncStorage's [[key, value]] pairs); a write is on disk
        // when it returns.
        bridge.setProperty("kvGet", guarded { args -> JSONArray().put(keyValue.get(args[0] as String) ?: JSONObject.NULL).toString() })
        bridge.setProperty("kvSet", guarded { args -> kvFault(); keyValue.set(args[0] as String, args[1] as String); null })
        bridge.setProperty("kvRemove", guarded { args -> keyValue.remove(args[0] as String); null })
        bridge.setProperty("kvMultiGet", guarded { args -> keyValuePairs(keyValue.multiGet(stringList(args[0] as String))) })
        bridge.setProperty("kvMultiSet", guarded { args -> keyValue.multiSet(JSONArray(args[0] as String).let { pairs ->
            List(pairs.length()) { pairs.getJSONArray(it).let { pair -> pair.getString(0) to pair.getString(1) } } }); null })
        bridge.setProperty("kvMultiRemove", guarded { args -> keyValue.multiRemove(stringList(args[0] as String)); null })
        // Debug builds only (check-ai-device.mjs): RN's AI consent record goes before boot, so the check sees RN's question again.
        if (debugFault("ai_consent_reset") == "1") keyValue.remove("mindwtr-ai-provider-consent-v1")
        // An event for the screens: handed on as text; a listener that throws never reaches JS.
        bridge.setProperty("hostEvent", guarded { args -> runCatching { onEvent?.invoke(args[0] as String) }; null })
        // The pending-captures queue (core's ingestPendingCaptures): app-private files only.
        bridge.setProperty("fileList", guarded { args -> files.list(args[0] as String) })
        bridge.setProperty("fileRead", guarded { args -> files.readText(args[0] as String) })
        bridge.setProperty("fileDelete", guarded { args -> queueStop(); files.delete(args[0] as String); null })
        // Core's attachment file port (bundle/host-attachments.ts): each call only starts here; HostIo runs it on its files
        // thread and the pump settles it, as a fetch. The folders are named as expo-file-system names them.
        bridge.setProperty("fileCall", guarded { args -> io.file(args[0] as String, files::call) })
        // RN's attachment installer (HostInstaller): install and hash, on the same thread, after the file calls before them.
        bridge.setProperty("installerCall", guarded { args -> io.file(args[0] as String, installer::call) })
        // A managed attachment's delete, at once on this thread: core asked who owns the file in this same turn (host-attachments.ts).
        bridge.setProperty("fileDeleteNow", guarded { args -> files.deleteNow(args[0] as String); null })
        // A file call whose operation passed its deadline: HostIo ends it (a copy stalled on a document provider), so the operation
        // drains and the host never stops (host-polyfills.js fileChannel's cancel).
        bridge.setProperty("fileAbort", guarded { args -> io.fileAbort(args[0] as String); null })
        bridge.setProperty("fileDirectories", guarded { _ ->
            JSONObject().put("document", files.documentDirectory).put("cache", files.cacheDirectory).toString()
        })
        // Reminder alarms (host-reminders.ts): core's plan applied, the notification permission, RN's old alarms cancelled once.
        reminders?.let { alarms ->
            bridge.setProperty("alarmApply", guarded { args -> alarms.apply(args[0] as String); null })
            bridge.setProperty("notificationsAllowed", guarded { _ -> alarms.permissionGranted() })
            bridge.setProperty("rnAlarmCleanup", guarded { _ -> alarms.cleanupRn() })
            bridge.setProperty("reminderReceiverCounts", guarded { _ -> alarms.receiverCounts() })
            bridge.setProperty("reminderLedger", guarded { _ -> alarms.ledger() })
        }
        // RN's widget module (HostWidgets): the publication's device inputs, and core's payload to store and draw.
        widgets?.let { widgets ->
            bridge.setProperty("widgetInputs", guarded { _ -> widgets.inputs() })
            bridge.setProperty("widgetPublish", guarded { args -> widgets.publish(args[0] as String); null })
            bridge.setProperty("widgetAppState", guarded { _ -> widgets.appState() })
        }
        scheduleBackgroundSync?.let { schedule -> bridge.setProperty("bgSyncSchedule", guarded { args -> schedule(args[0] as Boolean); null }) }
        engine.globalObject.setProperty("__mindwtrNative", bridge)
        // The build's flavor (D8): core reads it as RN's isFossBuild.
        engine.globalObject.setProperty("__mindwtrFossBuild", BuildConfig.FOSS)
    }

    /**
     * Core's getFocus: its sections in its order, the first [limit] rows of each, for the control state [controls] (JSON; ""
     * reads the flat Focus) after a control's [controlEdit] (JSON, or "").
     */
    fun focus(limit: Int, controls: String = "", controlEdit: String = ""): JSONObject = callAsync("focus", limit, controls, controlEdit)

    /** Core's getFocusSectionWindow for the same [controls]. A changed Focus fails with "STALE_REVISION: …". */
    fun focusWindow(key: String, offset: Int, limit: Int, revision: String, controls: String = ""): JSONObject =
        callAsync("focusWindow", key, offset, limit, revision, controls)

    /** Core's openQuickCapture: the popup's empty draft and its starting options. */
    fun openQuickCapture(): JSONObject = callAsync("captureOpen")

    /** Core's getQuickCaptureView with [json] (`{ text, options, picker? }`) unchanged. */
    fun quickCaptureView(json: String): JSONObject = callAsync("captureView", json)

    /** Core's editQuickCapture with [json] (`{ text, options, edit, picker? }`) unchanged. */
    fun editQuickCapture(json: String): JSONObject = callAsync("captureEdit", json)

    /** Core's submitQuickCapture with [json] unchanged; its captureId makes a retry exact. */
    fun submitQuickCapture(json: String): JSONObject = callAsync("captureSubmit", json)

    /** Core's createQuickCaptureSnapshot, as `{ snapshot: { fileName, contents } | null }`. */
    fun createQuickCaptureSnapshot(): JSONObject = callAsync("captureSnapshot")

    /** Core's submitQuickCaptureLines with [json] unchanged; one capture ID per line. */
    fun submitQuickCaptureLines(json: String): JSONObject = callAsync("captureLines", json)

    /** Core's submitQuickCapturePickerQuery with [json] unchanged; its requestId makes a create's retry exact. */
    fun submitQuickCapturePickerQuery(json: String): JSONObject = callAsync("capturePicker", json)

    /** Core's submitCaptureModal (the capture screen's Save) with [json] unchanged; its captureId makes a retry exact. */
    fun submitCaptureModal(json: String): JSONObject = callAsync("captureModalSubmit", json)

    /** Core's submitCaptureModalLines (the capture screen's Create tasks) with [json] unchanged; one capture ID per line. */
    fun submitCaptureModalLines(json: String): JSONObject = callAsync("captureModalLines", json)

    /** Core's completeTask; [taskRevision] is the row's: a task changed since is refused (STALE_REVISION). */
    fun completeTask(id: String, taskRevision: String): JSONObject = callAsync("complete", id, taskRevision)

    /** Core's setTaskFocus to the target [focused], at the row's [taskRevision]. A reply with `blocked` wrote nothing. */
    fun setTaskFocus(id: String, focused: Boolean, taskRevision: String): JSONObject = callAsync("taskFocus", id, focused, taskRevision)

    /** Core's setProjectFocus to the target [focused], at the row's [projectRevision]. `{ blocked: "" }` wrote nothing. */
    fun setProjectFocus(id: String, focused: Boolean, projectRevision: String): JSONObject = callAsync("projectFocus", id, focused, projectRevision)

    /** Core's createProject; [areaId] "" is no area, and [requestId] is kept for the exact retry. */
    fun createProject(title: String, areaId: String, requestId: String): JSONObject =
        callAsync("createProject", title, areaId, requestId)

    /** Core's getAreaFilter: the trigger label, the summary, and each option with its `next` selection. */
    fun areaFilter(): JSONObject = callAsync("areaFilter")

    /** Core's setAreaFilter with one of getAreaFilter's `next` selections, unchanged. */
    fun setAreaFilter(selectionJson: String): JSONObject = callAsync("setAreaFilter", selectionJson)

    /** Core's searchTasks with [json] (`{ query, filters, limit }`) unchanged. */
    fun searchTasks(json: String): JSONObject = callAsync("search", json)

    /** Core's saveSearch with [json] (`{ query, name, requestId }`) unchanged. */
    fun saveSearch(json: String): JSONObject = callAsync("saveSearch", json)

    /** Core's startInboxProcessing in [mode] ('guided' or 'quick'). */
    fun startInboxProcessing(mode: String): JSONObject = callAsync("inboxStart", mode)

    /** Core's getInboxProcessingStep with [json] unchanged: one edit or a mode, for the step on screen. */
    fun inboxProcessingStep(json: String): JSONObject = callAsync("inboxStep", json)

    /** Core's commitInboxProcessingStep with [json] unchanged; its requestId makes a retry exact. */
    fun commitInboxProcessingStep(json: String): JSONObject = callAsync("inboxCommit", json)

    /** Core's skipInboxProcessingTask with [json] unchanged. */
    fun skipInboxProcessingTask(json: String): JSONObject = callAsync("inboxSkip", json)

    /** Core's endInboxProcessing; it writes nothing. */
    fun endInboxProcessing(sessionId: String): JSONObject = callAsync("inboxEnd", sessionId)

    /** A Menu tab read (host-entry.ts MENU_READS: the More sheet, the lists, their collections) with [json], its input, unchanged. */
    fun menuRead(name: String, json: String): JSONObject = callAsync("menuRead", name, json)

    /** A Menu tab command (host-entry.ts MENU_COMMANDS) with [json] unchanged; its request or capture UUID makes a retry exact. */
    fun menuCommand(name: String, json: String): JSONObject = callAsync("menuCommand", name, json)

    /**
     * A Menu command journaled now, on the caller's thread, ahead of its send: its later [menuCommand] finds the same entry
     * (the journal never holds a request twice), and a death before then leaves it for the boot's replay. Project details'
     * edits only: what the user typed is on disk the moment the field lets go or Back is pressed.
     */
    fun journalAhead(name: String, json: String) {
        require(name == "projectEdit") { "$name is not journaled ahead" }
        checkNotNull(journal) { "The write journal is not open" }.append("menuCommand", listOf(name, json))
    }

    /** Core's getTaskEditorModel for one task: its draft, the fields to show by section, and each field's choices. */
    fun taskEditorModel(id: String): JSONObject = callAsync("editorModel", id)

    /**
     * Core's editTaskDraft: the editor model for [draftJson] after one control's edit ([editJson], "" for none), laid out for the
     * editor's own checklist ([checklistJson], unsaved items included; "" for the saved one).
     * It writes nothing; the editor saves the returned draft with saveTaskDraft.
     */
    fun editTaskDraft(id: String, draftJson: String, editJson: String, checklistJson: String = ""): JSONObject =
        callAsync("editDraft", JSONObject().put("id", id).put("draft", JSONObject(draftJson))
            .apply { if (editJson.isNotEmpty()) put("edit", JSONObject(editJson)) }
            .apply { if (checklistJson.isNotEmpty()) put("checklist", JSONArray(checklistJson)) }.toString())

    /** Core's getTaskView with [json] (`{ id, draft?, checklist?, offset?, limit?, revision? }`) unchanged: RN's View tab. */
    fun taskView(json: String): JSONObject = callAsync("taskView", json)

    /**
     * Core's editTaskChecklist: one checklist edit ([editJson], "" for none: the Form tab's field as it is) on [draftJson] and
     * [checklistJson]. It writes nothing; saveTaskDraft saves the checklist with the draft.
     */
    fun editTaskChecklist(id: String, draftJson: String, checklistJson: String, editJson: String): JSONObject =
        callAsync("editChecklist", JSONObject().put("id", id).put("draft", JSONObject(draftJson)).put("checklist", JSONArray(checklistJson))
            .apply { if (editJson.isNotEmpty()) put("edit", JSONObject(editJson)) }.toString())

    /**
     * Core's resetTaskChecklist, written at once; [requestId] makes a retry only finish a failed save, and [taskRevision] (getTaskView's)
     * refuses a task changed since (STALE_REVISION).
     */
    fun resetTaskChecklist(id: String, requestId: String, taskRevision: String): JSONObject =
        callAsync("resetChecklist", JSONObject().put("id", id).put("requestId", requestId).put("taskRevision", taskRevision).toString())

    /** Core's getTaskEditorSuggestions for a context, tag, or person input's whole text as typed. */
    fun editorSuggestions(id: String, field: String, query: String, limit: Int): JSONObject =
        callAsync("editorSuggestions", id, field, query, limit)

    /**
     * [baseJson], [patchJson], [checklistJson] and [attachmentsJson] (each half `{ base, value }`, "" when unchanged) go to core's
     * saveTaskDraft unchanged, in one write; core decides everything. [requestId] makes a repeat answer the first reply (core's receipt).
     */
    fun saveTaskDraft(id: String, baseJson: String, patchJson: String, checklistJson: String, attachmentsJson: String, requestId: String): JSONObject =
        callAsync("saveDraft", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson))
            .apply { if (checklistJson.isNotEmpty()) put("checklist", JSONObject(checklistJson)) }
            .apply { if (attachmentsJson.isNotEmpty()) put("attachments", JSONObject(attachmentsJson)) }.put("requestId", requestId).toString())

    /**
     * The status menu and the Restore and Next swipes: [baseJson] and [patchJson] go to core's updateTask unchanged, with the
     * request's [requestId].
     */
    fun updateTask(id: String, baseJson: String, patchJson: String, requestId: String): JSONObject =
        callAsync("update", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson))
            .put("requestId", requestId).toString())

    /**
     * Core's ingestPendingCaptures: the queue's captures, check-offs and defers stored, each file deleted once its write is on
     * disk. A journaled write under [requestId]; its replay drains again, and each item's own id makes that write nothing twice.
     */
    fun ingestPendingCaptures(requestId: String): JSONObject = callAsync("ingest", requestId)

    /**
     * A line of the runner's (CoreWork, the queue drain) through core's logger: logcat, and RN's diagnostics log file while Debug
     * logging is on, its fields in [context]. It never fails its caller: a line that cannot go through core goes to logcat.
     */
    fun logLinkHandoff(outcome: String, surface: String) {
        runCatching { callAsync("logLinkHandoff", outcome, surface) }
    }

    fun logLine(message: String, context: JSONObject) {
        runCatching { callAsync("logLine", message, context.toString()) }.onFailure { Log.i(TAG, "$message $context") }
    }

    /** Core's runContextAutomation with [json] (`{ action, context }`): `{ notification }`, the details to post, or null. */
    fun contextAutomation(json: String): JSONObject = callAsync("contextAutomation", json)

    /**
     * Reminder alarms (bundle/host-reminders.ts): React Native's old alarms cancelled once, core's plan applied now, then again on
     * core's timers (a store change, the capped window's top-up). `{ active, permissionGranted, ask }`: `ask` while a reminder
     * feature is on and notifications are not allowed, where RN asks for the permission at start.
     */
    fun remindersStart(): JSONObject = callAsync("remindersStart")

    /**
     * Core's reminder plan applied now: [mode] "cycle", "rebuild" to remake every alarm (a reboot dropped them, exact alarms were just
     * allowed), or "fired" to make the daily or weekly alarm [key] that fired again at its next time.
     */
    fun remindersCycle(mode: String, key: String = ""): JSONObject = callAsync("remindersCycle", mode, key)

    /** A reminder's Done (core's completeReminderTask), journaled under [requestId]: a retry or a replay writes nothing twice. */
    fun reminderDone(requestId: String, taskId: String): JSONObject = callAsync("reminderDone", requestId, taskId)

    /** A reminder's Snooze (core's snoozeReminder) with [json] (`{ requestId, requestedAt, details }`), journaled: the alarm to make. */
    fun reminderSnooze(json: String): JSONObject = callAsync("reminderSnooze", json)

    /**
     * The home-screen widgets published now if what they show changed (bundle/host-widgets.ts), and stored and drawn before this
     * returns: after a CoreWork job, and when the app comes to the front.
     */
    fun refreshWidgets() {
        callAsync("widgetsRefresh")
        widgets?.settle()
    }

    /** Core's receipts older than 30 days go; ProcessCoreHost calls it once, after a boot replay that left no entry. */
    fun pruneReceipts(): JSONObject = callAsync("pruneReceipts")

    /**
     * Core's setLanguage: [stored] is RN's saved language ("" for none), [system] the device locale tag.
     * A debug build lets `debug.mindwtr.native.language` replace [stored] for the language check.
     */
    fun language(stored: String, system: String): JSONObject =
        callAsync("language", debugFault("language").ifEmpty { stored }, system)

    /** Core's getStrings for [keys], in the language core chose. */
    fun strings(keys: List<String>): JSONObject = callAsync("strings", JSONArray(keys).toString())

    /** RN's theme as core resolves it: [stored] is RN's device-local `@mindwtr_theme` ("" for none). */
    fun theme(stored: String): JSONObject = callAsync("theme", stored)

    /** Core's General row for RN's app lock (its `value` is the stored setting); an owed save does not block it. */
    fun appLock(): JSONObject = callAsync("appLock")

    /** Settings › Data's Share log: core's diagnostics log file, made when missing; `path` is null when it cannot be made. */
    fun logShare(): JSONObject = callAsync("logShare")

    /** Settings › Data's Clear log: core deletes the diagnostics log file. */
    fun logClear(): JSONObject = callAsync("logClear")

    /**
     * Sync (bundle/host-sync.ts), after the boot's validated load and journal replay: core's automatic triggers start and the
     * app's first sync is asked for. [appState] is RN's AppState ("active" or "background"). Each of these answers the sync
     * badge and the finished-cycle count (`{ badge, color, cycles }`).
     */
    fun syncStart(appState: String): JSONObject = callAsync("syncStart", appState)

    /** RN's AppState change: resuming or leaving runs core's triggers. */
    fun syncAppState(appState: String): JSONObject = callAsync("syncAppState", appState)

    /** The device's network state ([json]: `{ isConnected, isInternetReachable }`, as expo-network reads it). */
    fun syncNetwork(json: String): JSONObject = callAsync("syncNetwork", json)

    /** The sync badge and the finished-cycle count now. */
    fun syncState(): JSONObject = callAsync("syncState")

    /**
     * Core's background run (bundle/host-sync.ts backgroundSync) for CoreWork's capture and sync jobs, after the start order:
     * [trigger] "capture" or "scheduled", [stored] what the queue drains stored. It syncs for up to core's 4 min deadline, so it
     * never holds the engine ([callLong]); it settles with the run. `{ schedule }`: whether the sync job runs again. Debug builds
     * only: `debug.mindwtr.native.bgsync_deadline_ms` shortens that deadline, for check-bgsync-device.mjs.
     */
    fun backgroundSync(trigger: String, stored: Int): JSONObject =
        callLong("backgroundSync", trigger, stored, debugFault("bgsync_deadline_ms").toIntOrNull() ?: 0)

    /**
     * A Settings › Sync screen command (host-entry.ts MENU_COMMANDS, one of WriteJournal.UNJOURNALED) with [json] unchanged. It
     * may sync for minutes, so it never holds the engine ([callLong]); it is never journaled (it can carry a password).
     */
    fun syncCommand(name: String, json: String): JSONObject = callLong("menuCommand", name, json)

    /**
     * An AI request (host-entry.ts AI_REQUESTS) with [json] unchanged: it waits on the provider for up to RN's longest request
     * timeout (5 min), so it never holds the engine ([callLong]). It is a read: nothing to journal.
     */
    fun aiRequest(name: String, json: String, handle: LongCall = LongCall()): JSONObject = callLong("aiRequest", name, json, handle = handle)

    /**
     * An attachment's Download, Open (the bytes first) or the editor's draft settlement (host-entry.ts ATTACHMENT_REQUESTS) with
     * [json] unchanged: a download waits on the network for minutes, so it never holds the engine ([callLong]). None is a journaled
     * write: a project download's availability fields are identity-guarded and run again by the next Download or sync.
     */
    fun attachmentRequest(name: String, json: String): JSONObject = callLong("attachmentRequest", name, json)

    /**
     * A long call's handle: [cancel] frees the thread that waits on it at once and aborts its operation's signal
     * (host-entry.ts abort), so its provider call stops. Main thread safe: nothing here waits for the engine.
     */
    class LongCall {
        @Volatile internal var id: String? = null
        @Volatile internal var done: CompletableFuture<String>? = null
        @Volatile internal var cancelled = false
    }

    /** [handle]'s call is no longer wanted (its input changed, its screen closed): see [LongCall]. */
    fun cancel(handle: LongCall) {
        handle.cancelled = true
        handle.done?.completeExceptionally(CancellationException("The AI request was cancelled"))
        runCatching { synchronized(lifecycleLock) { if (shutdown == null) executor.execute { abortLong(handle) } } }
    }

    /** Engine thread: [handle]'s operation's signal fires (its answer still settles through the pump, which forgets it). */
    private fun abortLong(handle: LongCall) {
        val id = handle.id ?: return
        if (context == null || stopped != null) return
        runCatching { call("abort", id) }
        handle.done?.completeExceptionally(CancellationException("The AI request was cancelled"))
    }

    /** Core's getProjects: its Active, Deferred, and Archived groups in its order. */
    fun projects(): JSONObject = callAsync("projects")

    /** Core's getProjectDetail. A changed project fails with "STALE_REVISION: …". */
    fun projectDetail(id: String, offset: Int, limit: Int, revision: String): JSONObject =
        callAsync("projectDetail", id, offset, limit, revision)

    /**
     * Debug-build fault injection for the device checks, and the language override at boot.
     * Read once per task command, on the engine thread. Release builds return
     * "" before reading anything, so no property can reach them.
     */
    private fun debugFault(name: String): String = debugProperty(name)

    /**
     * Debug builds only: with `debug.mindwtr.native.net_check=<port>`, core's WebDAV calls and the secret calls run against
     * check-net-device.mjs's server on 127.0.0.1:<port> (adb reverse) once, after boot, and log their outcomes.
     */
    private fun netCheck() {
        val port = debugFault("net_check").ifEmpty { return }
        runCatching { callAsync("netCheck", port, deadlineMs = NETWORK_DEADLINE_MS) }
            .onSuccess { Log.i(TAG, "Native Android net check $it") }
            .onFailure { Log.w(TAG, "Native Android net check failed", it) }
        // Operations past a short deadline: "drain" ends once cancelled; "stuck" cannot, so the host stops and this boot fails.
        for (mode in listOf("drain", "stuck")) {
            runCatching { callAsync("netDeadline", port, mode, deadlineMs = 1_500L) }
                .onFailure { Log.i(TAG, "Native Android net deadline $mode: ${it.message}") }
        }
    }

    private fun stringList(json: String): List<String> = JSONArray(json).let { keys -> List(keys.length()) { keys.getString(it) } }

    private fun keyValuePairs(values: Map<String, String?>): String =
        JSONArray().also { out -> values.forEach { (key, value) -> out.put(JSONArray().put(key).put(value ?: JSONObject.NULL)) } }.toString()

    private fun debugDelay(name: String) {
        val ms = debugFault(name).toLongOrNull() ?: return
        if (ms > 0) Thread.sleep(minOf(ms, 60_000L))
    }

    /**
     * Every host call. A write ([WriteJournal.WRITES]) is on disk in the journal before the engine sees it, and core's reply
     * settles it: a final reply drops it, SAVE_FAILED keeps it for the owed retry, and no reply (a timeout, a stopped engine,
     * process death) keeps it for the next boot's replay.
     */
    private fun callAsync(method: String, vararg args: Any?, deadlineMs: Long = deadlineOf(method, args.toList())): JSONObject = onEngine {
        stopped?.let { throw IllegalStateException(it) }
        val entry = if (method in WriteJournal.WRITES) checkNotNull(journal).append(method, args.toList()) else null
        val stop = if (entry != null) debugFault("journal_stop") else ""
        if (entry != null) {
            checkNotNull(sqlite).failCommits = debugFault("fail_commit") == "1"
            debugDelay("delay_before_ms")
            journalStop(stop, "before", entry)
        }
        val result = answer(method, args, deadlineMs)
        if (entry != null) {
            debugDelay("delay_after_ms")
            journalStop(stop, "after", entry)
        }
        if (method in WriteJournal.WRITES) settle(entry, result, replay = false)
        if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
        result.getJSONObject("value")
    }

    /**
     * A long operation (a Sync screen command, an AI request) that never holds the engine: it starts here, then the idle pump and
     * every other call's pump advance it while the caller waits on this thread. Only an unjournaled write or a read comes here, so
     * no journaled write skips the journal. Past [SYNC_WAIT_MS] the caller stops waiting; nothing holds the engine, so nothing
     * needs to stop.
     */
    private fun callLong(method: String, vararg args: Any?, handle: LongCall = LongCall()): JSONObject {
        require(method !in WriteJournal.WRITES || WriteJournal.unjournaled(method, args.toList())) { "$method is a journaled write" }
        check(Thread.currentThread() !== engineThread) { "A long operation is waited for off the engine thread" }
        val done = CompletableFuture<String>()
        handle.done = done
        onEngine {
            stopped?.let { throw IllegalStateException(it) }
            (call(method, *args) as String).also {
                watched[it] = done
                handle.id = it
                // Cancelled before it started: its signal fires now.
                if (handle.cancelled) abortLong(handle)
                idlePump()
            }
        }
        val answer = try {
            done.get(SYNC_WAIT_MS, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            // Past the wait: the operation's signal fires too, so its requests stop (the pump settles and forgets it).
            onEngine { abortLong(handle) }
            throw IllegalStateException("Core $method timed out")
        } catch (failure: ExecutionException) {
            throw failure.cause ?: failure
        }
        val result = JSONObject(answer)
        if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
        return result.getJSONObject("value")
    }

    /** A polyfill function the idle pump calls often, kept once per engine (closeOnEngine drops it). */
    private fun global(engine: QuickJSContext, name: String): JSFunction = functions.getOrPut("global:$name") { engine.globalObject.getJSFunction(name) }

    /** Hands each long operation that answered to its waiting caller; engine thread. */
    private fun settleWatched() {
        if (watched.isEmpty()) return
        for (id in watched.keys.toList()) (call("poll", id) as String?)?.let { watched.remove(id)?.complete(it) }
    }

    /**
     * Engine work between host calls: due timers (auto-sync's pacing, a debounced save) and the answers of host calls started
     * outside one (a sync's requests). Engine thread; a stopped or closed host pumps nothing.
     */
    private fun idlePump() {
        // A pump a host-call answer woke replaces the one scheduled for a timer: schedulePump below sets the next.
        pumpTask?.cancel(false)
        pumpTask = null
        pumpAt = Long.MAX_VALUE
        val engine = context ?: return
        if (stopped != null) return
        runCatching { traced("core:idlePump") { global(engine, "__pumpTimers").call() } }.onFailure { Log.w(TAG, "Native Android idle pump failed error=${it.javaClass.simpleName}") }
        settleWatched()
        schedulePump()
    }

    /**
     * The next idle pump, when the next timer is due (a host call's answer wakes it through HostIo). A pump already due earlier
     * stays; engine thread.
     */
    private fun schedulePump() {
        val engine = context ?: return
        if (stopped != null) return
        val delay = (global(engine, "__nextTimerDelay").call() as? Number)?.toLong() ?: return
        if (delay < 0) return
        val at = SystemClock.uptimeMillis() + delay
        if (at >= pumpAt) return
        pumpTask?.cancel(false)
        pumpAt = at
        pumpTask = executor.schedule({ idlePump() }, delay, TimeUnit.MILLISECONDS)
    }

    /** Operation [method]'s reply, `{ ok, value }` or `{ ok: false, error }`; one past [deadlineMs] is cancelled and throws. */
    private fun answer(method: String, args: Array<out Any?>, deadlineMs: Long): JSONObject = traced("core:$method") {
        val id = call(method, *args) as String
        val answer = pumpUntil(id, deadlineMs) ?: run {
            // Past its deadline: its signal fires, its fetches reject and new host calls are refused, so it ends now, before
            // the failure is reported. One that still has not ended stops the host: no JS runs again, so it never resumes.
            call("cancel", id)
            if (pumpUntil(id, DRAIN_MS) == null) {
                val reason = "Core host stopped: $method did not end after its deadline"
                stopped = reason
                Log.e(TAG, reason)
                closeOnEngine()
                throw IllegalStateException(reason)
            }
            checkNotNull(context).globalObject.getJSFunction("__resumeHostCalls").call()
            schedulePump()
            throw IllegalStateException("Core $method timed out")
        }
        // Work this call's pump advanced: a long operation it finished, and the timers it left.
        settleWatched()
        schedulePump()
        JSONObject(answer)
    }

    private fun JSONObject.error(): String? = if (getBoolean("ok")) null else getString("error")

    /**
     * Core's reply to a write, on the first send and on the journal's [replay] alike: a success's deviceWrites (a setting's
     * device-local part) are on disk first (a replay's only for keys no newer write set), then [entry] settles (a replay core
     * refuses as malformed is set aside); true once it left the journal. A device write that fails throws before the entry
     * settles, so the entry stays for a retry or the next boot.
     */
    private fun settle(entry: WriteJournal.Entry?, result: JSONObject, replay: Boolean): Boolean {
        result.optJSONObject("value")?.optJSONArray("deviceWrites")?.let { devices.store(it, entry?.sequence, replay) }
        return entry != null && checkNotNull(journal).settle(entry, result.error(), replay)
    }

    /** What one replay did: requests [sent], [dropped] after a final reply, entries [left], and the failure that stopped it. */
    data class Replay(val sent: Int, val dropped: Int, val left: Int, val owed: String?)

    /**
     * The journal's requests, sent again in journal order, one at a time, each exactly as first sent: at boot (ProcessCoreHost,
     * after the validated load and before any screen gets this host), and as the owed retry of a replay that stopped. A reply
     * that keeps its entry (SAVE_FAILED), or no reply, stops the replay; that entry and the ones after it wait for the retry.
     */
    fun replayJournal(): Replay = onEngine {
        stopped?.let { throw IllegalStateException(it) }
        Trace.beginSection("core:replayJournal")
        val journal = checkNotNull(journal)
        var sent = 0
        var dropped = 0
        var owed: String? = null
        for (entry in journal.pending()) {
            sent += 1
            checkNotNull(sqlite).failCommits = debugFault("fail_commit") == "1"
            val error = try {
                answer(entry.method, entry.args.toTypedArray(), deadlineOf(entry.method, entry.args)).also { if (settle(entry, it, replay = true)) dropped += 1 }.error()
            } catch (failure: Throwable) {
                owed = failure.message ?: failure.javaClass.simpleName
                break
            }
            if (WriteJournal.keeps(error)) { owed = error; break }
        }
        Trace.endSection()
        stopped?.let { throw IllegalStateException(it) }
        Replay(sent, dropped, journal.pending().size, owed).also {
            Log.i(TAG, "Native Android journal replay sent=${it.sent} dropped=${it.dropped} left=${it.left} owed=${owed?.substringBefore(':') ?: "none"}")
        }
    }

    /**
     * Debug builds only (check-journal-device.mjs): [stop] is `debug.mindwtr.native.journal_stop`; set to `<at>:<op>`, the
     * process dies at [at] ("before": the entry is on disk and the engine has not seen it; "after": core replied and the entry
     * is not settled) of the write [op] (the method, or a Menu command's name). A replay never stops.
     */
    private fun journalStop(stop: String, at: String, entry: WriteJournal.Entry) {
        val op = if (entry.method == "menuCommand") entry.args[0] else entry.method
        if (stop != "$at:$op") return
        Log.i(TAG, "Native Android journal stop at=$at op=$op entry=${entry.file.name}")
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    /**
     * Debug builds only (check-runner-device.mjs): with `debug.mindwtr.native.queue_stop=delete`, the process dies before a
     * queue file's delete, so after that item's write and save.
     */
    /** Debug builds only (check-runner-device.mjs, an owed drain): `debug.mindwtr.native.fail_kv_set` = 1 refuses an RKStorage write. */
    private fun kvFault() = check(debugFault("fail_kv_set") != "1") { "Injected RKStorage write failure" }

    private fun queueStop() {
        if (debugFault("queue_stop") != "delete") return
        Log.i(TAG, "Native Android queue stop at=delete")
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    /** Pumps timers and host call answers until operation [id] answers (its JSON), or null once [ms] have passed. */
    private fun pumpUntil(id: String, ms: Long): String? {
        val engine = checkNotNull(context)
        val pump = engine.globalObject.getJSFunction("__pumpTimers")
        val nextDelay = engine.globalObject.getJSFunction("__nextTimerDelay")
        val deadline = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < deadline) {
            traced("core:pump") { pump.call() }
            (call("poll", id) as String?)?.let { return it }
            val delay = (nextDelay.call() as? Number)?.toLong() ?: 1L
            // An open fetch or secret call wakes the loop as soon as its answer is queued.
            if (io.busy()) io.await(if (delay < 0) 25L else minOf(delay, 25L))
            else if (delay > 0) Thread.sleep(minOf(delay, 25L))
        }
        return null
    }

    private fun closeOnEngine() {
        functions.clear()
        hostObject = null
        pumpTask?.cancel(false)
        pumpTask = null
        watched.values.forEach { it.completeExceptionally(IllegalStateException(stopped ?: "Core host is closed")) }
        watched.clear()
        io.close()
        try {
            sqlite?.close()
        } finally {
            sqlite = null
            context?.destroy()
            context = null
        }
    }

    fun close() {
        check(Thread.currentThread() !== engineThread) { "Core host cannot close itself" }
        val task = synchronized(lifecycleLock) {
            shutdown ?: executor.submit(Callable { closeOnEngine() }).also {
                shutdown = it
                executor.shutdown()
            }
        }
        task.get()
    }
}

/**
 * A device check's debug property `debug.mindwtr.native.<name>`. Release builds return "" before reading anything,
 * so no property can reach them.
 */
fun debugProperty(name: String): String {
    if (!BuildConfig.DEBUG) return ""
    return runCatching {
        val process = ProcessBuilder("getprop", "debug.mindwtr.native.$name").start()
        process.inputStream.bufferedReader().use { it.readText().trim() }.also { process.waitFor() }
    }.getOrDefault("")
}

/** [work] as an android.os.Trace section named [name] (startup profiling with Perfetto); almost free while no trace records. */
internal inline fun <T> traced(name: String, work: () -> T): T {
    Trace.beginSection(name)
    try { return work() } finally { Trace.endSection() }
}

/**
 * The JS host's bundle: [hash] is the SHA-256 of its body, from its own first line (BytecodeCache.bundleKey; "" when
 * missing, which turns the cache off), [cache] its compiled form (null: the source runs every start), and [bytes] reads it.
 * The source is read only when it runs or is compiled.
 */
class CoreBundle(val hash: String, val cache: BytecodeCache?, val bytes: () -> ByteArray) {
    fun source(): String = String(bytes(), Charsets.UTF_8)
}
