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


internal fun libraryFileBytes(database: File): Long = database.length() + File(database.path + "-wal").length()


class CoreHost(
    private val databaseFile: File,
    private val rnDataDir: File? = null,
    private val io: HostIo,
    private val journalDir: File,

    private val devices: DeviceWrites,
    private val logFile: File,
    private val keyValue: RnKeyValue,

    private val files: HostFiles,

    private val installer: HostInstaller,

    private val reminders: Reminders? = null,

    private val widgets: HostWidgets? = null,

    private val scheduleBackgroundSync: ((Boolean) -> Unit)? = null,

    private val appInfo: String? = null,

    private val backups: BackupOperations? = null,

    private val calendars: HostCalendars? = null,

    private val appSearch: HostAppSearch? = null,

    private val documents: HostDocuments? = null,

    private val syncLock: HostSyncLock? = null,

    private val gmail: ((String, (Result<Any?>) -> Unit) -> Unit)? = null,

    private val gmailReceipts: HostGmailReceipts? = null,

    private val voice: ((String, (Result<Any?>) -> Unit) -> Unit)? = null,
) {


    interface Reminders {


        fun apply(plan: String): Int
        fun permissionGranted(): Boolean

        fun cleanupRn(): Int

        fun receiverCounts(): String

        fun ledger(): String
    }

    companion object {
        const val TAG = "MindwtrNativeDev"

        const val SAVE_WARM_SLICE = 500
        const val SAVE_WARM_MAX_MS = 30_000L

        private const val NATIVE_ERROR = "!MindwtrNativeError:"


        const val OPERATION_DEADLINE_MS = 30_000L

        const val NETWORK_DEADLINE_MS = HostIo.CALL_TIMEOUT_MS + OPERATION_DEADLINE_MS

        private val ATTACHMENT_COMMANDS = setOf("attachmentAddFile", "attachmentLinks", "attachmentRemove")


        fun deadlineOf(method: String, args: List<Any?>): Long = when {
            method == "menuCommand" && args.firstOrNull() in ATTACHMENT_COMMANDS -> NETWORK_DEADLINE_MS
            method == BackupOperations.METHOD -> BACKUP_DEADLINE_MS
            else -> OPERATION_DEADLINE_MS
        }


        const val BACKUP_DEADLINE_MS = 120_000L


        const val DRAIN_MS = 10_000L

        const val PUMP_TURN_MS = 8


        const val SYNC_WAIT_MS = 30 * 60 * 1000L


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

    private var journal: WriteJournal? = null
    private val functions = HashMap<String, JSFunction>()

    @Volatile private var stopped: String? = null

    private val collators = HashMap<String, Collator>()
    private var hostObject: JSObject? = null
    @Volatile private var engineThread: Thread? = null
    private val executor = ScheduledThreadPoolExecutor(1) { task -> Thread(task, "mindwtr-core").also { engineThread = it } }.apply {
        executeExistingDelayedTasksAfterShutdownPolicy = false
        removeOnCancelPolicy = true
    }

    private var pumpTask: ScheduledFuture<*>? = null
    private var pumpAt = Long.MAX_VALUE

    private val watched = HashMap<String, CompletableFuture<String>>()


    @Volatile var onEvent: ((String) -> Unit)? = null

    private fun <T> onEngine(work: () -> T): T {
        if (Thread.currentThread() === engineThread) return work()

        return traced("core:wait") { onEngineQueued(work) }
    }


    private fun <T> onEngineQueued(work: () -> T): T {
        val task = synchronized(lifecycleLock) {
            check(shutdown == null) { "Core host is closed" }
            executor.submit(Callable { work() })
        }

        return try { task.get() } catch (failure: ExecutionException) { throw failure.cause ?: failure }
    }

    private fun call(method: String, vararg args: Any?): Any? = onEngine {
        val engine = checkNotNull(context)
        val host = hostObject ?: engine.globalObject.getJSObject("MindwtrHost").also { hostObject = it }
        functions.getOrPut(method) { host.getJSFunction(method) }.call(*args)
    }


    fun start(bundle: CoreBundle, legacyState: String = "", legacyBackup: String = "", preflight: Boolean = false): JSONObject {
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

                backups?.let { ops -> runCatching { ops.cleanup(pendingBackupIds()) }.onFailure { Log.w(TAG, "Native Android backup cleanup failed ${it.javaClass.simpleName}") } }
                Trace.endSection()
                Trace.beginSection("core:contextCreate")
                val engine = QuickJSContext.create()
                Trace.endSection()
                context = engine
                install(engine, database)

                io.wake = { runCatching { executor.execute { idlePump() } } }

                io.abortReader = files::abortRead
                io.readDone = files::readDone
                load(engine, database, bundle)
            })
        }
        if (preflight) {
            try {
                onEngine {
                    loading.get()

                    val checked = answer("legacyCheck", arrayOf(legacyState, legacyBackup), OPERATION_DEADLINE_MS)
                    check(checked.getBoolean("ok")) { checked.getString("error") }
                }
            } catch (failure: Throwable) {

                onEngine { closeOnEngine() }
                throw (failure as? ExecutionException)?.cause ?: failure
            }
        }
        opened.run()

        return onEngine {
            try {
                loading.get()
                sqlite = database()

                if (BuildConfig.DEBUG) data.failNextRead = debugFault("channel_fail") == "read-once"


                activationOwed = pendingBackupIds().isNotEmpty()

                val bootDeadline = sized(OPERATION_DEADLINE_MS, libraryFileBytes())
                (if (activationOwed) callAsync("bootRecovery", legacyState, legacyBackup, "journaled", storageBudget(), deadlineMs = bootDeadline)
                else callAsync("boot", legacyState, legacyBackup, "journaled", storageBudget(), deadlineMs = bootDeadline)).also { netCheck() }
            } catch (failure: Throwable) {
                if (sqlite == null) runCatching { database().close() }
                closeOnEngine()
                throw (failure as? ExecutionException)?.cause ?: failure
            }
        }
    }


    @Volatile private var activationOwed = false


    private fun pendingBackupIds(): Set<String> = checkNotNull(journal).pending().filter { it.method == BackupOperations.METHOD }
        .mapNotNull { runCatching { JSONObject(it.args[0] as String).getString("id") }.getOrNull() }.toSet()


    private fun sendArgs(method: String, args: Array<out Any?>): Array<out Any?> {
        if (method != BackupOperations.METHOD) return args
        val (plan, sha256) = checkNotNull(backups).plan(args[0] as String, args[1] as String)

        return arrayOf(args[0], data.openRead(plan, expectedSha256 = sha256), args[1], deadline(method, args.toList()))
    }


    private fun dropSent(method: String, sent: Array<out Any?>) {
        if (method == BackupOperations.METHOD) (sent.getOrNull(1) as? String)?.let(data::drop)
    }


    private fun answerChecked(method: String, args: Array<out Any?>, deadlineMs: Long): JSONObject {
        val sent = try { sendArgs(method, args) } catch (mismatch: BackupOperations.Mismatch) {
            Log.w(TAG, "Native Android backup operation refused before send: ${mismatch.message}")
            return JSONObject().put("ok", false).put("error", "INVALID_INPUT: Backup operation files do not match")
        }
        return try { answer(method, sent, deadlineMs) } finally { dropSent(method, sent) }
    }


    private fun backupFinish(entry: WriteJournal.Entry?, args: List<Any?>, result: JSONObject, replay: Boolean): Boolean {
        val ops = checkNotNull(backups)
        val reference = args[0] as String
        val id = runCatching { JSONObject(reference).getString("id") }.getOrDefault("")
        val error = result.error()
        if (WriteJournal.keeps(error)) return false
        val reply = result.optJSONObject("value")
        val operation = reply?.optString("operation")?.takeIf { it.isNotEmpty() } ?: ops.mode(reference) ?: ""
        val outcome = when {
            error == null -> "committed"
            error.startsWith("STALE_REVISION") -> "stale"
            replay && WriteJournal.malformed(error) -> "unresolved"
            else -> "refused"
        }

        ops.writeResult(JSONObject().put("requestId", id).put("operation", operation).put("outcome", outcome)
            .put("reply", reply ?: JSONObject.NULL).put("undoSnapshot", if (error == null && operation != "restore") args[1] as String else "")
            .put("error", error ?: ""))
        val stop = debugFault("backup_stop")
        val settled = if (stop == "settle-fail") false else settle(entry, result, replay)
        if (settled) ops.discard(id)
        if (replay) this.logLine("Native Android backup replay settled releaseCheck=v1.3.5/android-backup-replay", JSONObject().put("releaseCheck", "v1.3.5/android-backup-replay")
            .put("operation", operation).put("outcome", outcome))
        if (stop == "after-settle") {
            Log.i(TAG, "Native Android backup stop at=after-settle")
            android.os.Process.killProcess(android.os.Process.myPid())
        }
        return settled
    }


    @Volatile private var bundleOutcome = ""
    @Volatile private var bundleSource: CoreBundle? = null
    private var cacheWriter: Thread? = null


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


    private fun install(engine: QuickJSContext, database: () -> SqliteBridge) {
        val bridge = engine.createNewJSObject()
        bridge.setProperty("sqlRun", guarded { args -> traced("sql:run") { database().run(args[0] as String, args[1] as String) }; null })
        bridge.setProperty("sqlAll", guarded { args -> traced("sql:all") { database().all(args[0] as String, args[1] as String) } })
        bridge.setProperty("sqlExec", guarded { args -> traced("sql:exec") { database().exec(args[0] as String) }; null })

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

        bridge.setProperty("rnStateCommit", guarded { args ->
            val change = JSONObject(args[0] as String)
            LegacyRnStoreGuard.commitRnState(checkNotNull(rnDataDir) { "No React Native state in this build" },
                change.getBoolean("clearJsonAhead"), change.getBoolean("setReconciled"))
            null
        })


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

        val dates = IcuDateTimeFormat()
        bridge.setProperty("dateTimeFormat", guarded { args -> dates.reply(args[0] as String, args[1] as String, (args[2] as Number).toDouble()) })

        if (debugFault("intl_check") == "1") engine.globalObject.setProperty("__mindwtrIntlCheck", true)

        bridge.setProperty("log", guarded { args -> runCatching { Log.i(TAG, args.getOrNull(0).toString()) }; null })


        bridge.setProperty("netFetch", guarded { args -> io.fetch(args[0] as String) })
        bridge.setProperty("netAbort", guarded { args -> io.abort(args[0] as String); null })
        bridge.setProperty("secretCall", guarded { args -> io.secret(args[0] as String) })

        bridge.setProperty("cryptoCall", guarded { args -> io.crypto(args[0] as String) })
        bridge.setProperty("ioNext", guarded { _ -> io.next() })
        bridge.setProperty("ioBody", guarded { _ -> io.body() })

        val logs = DiagnosticsLogFile(logFile)
        bridge.setProperty("logFile", guarded { args -> logs.run(args[0] as String, args.getOrNull(1)?.toString().orEmpty()) })


        bridge.setProperty("kvGet", guarded { args -> JSONArray().put(keyValue.get(args[0] as String) ?: JSONObject.NULL).toString() })
        bridge.setProperty("kvSet", guarded { args -> kvFault(); keyValue.set(args[0] as String, args[1] as String); null })
        bridge.setProperty("kvRemove", guarded { args -> keyValue.remove(args[0] as String); null })
        bridge.setProperty("kvMultiGet", guarded { args -> keyValuePairs(keyValue.multiGet(stringList(args[0] as String))) })
        bridge.setProperty("kvMultiSet", guarded { args -> keyValue.multiSet(JSONArray(args[0] as String).let { pairs ->
            List(pairs.length()) { pairs.getJSONArray(it).let { pair -> pair.getString(0) to pair.getString(1) } } }); null })
        bridge.setProperty("kvMultiRemove", guarded { args -> keyValue.multiRemove(stringList(args[0] as String)); null })

        if (debugFault("ai_consent_reset") == "1") keyValue.remove("mindwtr-ai-provider-consent-v1")


        if (debugFault("about_reset") == "1") keyValue.multiRemove(listOf("mindwtr-analytics-last-heartbeat-day", "mindwtr-update-last-check",
            "mindwtr-update-available", "mindwtr-update-latest"))

        bridge.setProperty("hostEvent", guarded { args -> runCatching { onEvent?.invoke(args[0] as String) }; null })

        bridge.setProperty("fileList", guarded { args -> files.list(args[0] as String) })
        bridge.setProperty("fileRead", guarded { args -> files.readText(args[0] as String) })
        bridge.setProperty("fileDelete", guarded { args -> queueStop(); files.delete(args[0] as String); null })

        bridge.setProperty("dataRead", guarded { args -> data.read(args[0] as String) })
        bridge.setProperty("dataWrite", guarded { args -> data.write(args[0] as String, args[1] as String); null })
        bridge.setProperty("dataClose", guarded { args -> data.close(args[0] as String).let { JSONObject().put("bytes", it.bytes).put("sha256", it.sha256).toString() } })


        if (BuildConfig.DEBUG) bridge.setProperty("debugProp", guarded { args -> debugFault(args[0] as String) })

        if (BuildConfig.DEBUG) bridge.setProperty("memProbe", guarded { args -> Log.i(TAG, "Native Android memory probe at=${args[0]} quickjsMiB=${engine.memoryUsedSize / (1024 * 1024)}"); null })


        bridge.setProperty("fileCall", guarded { args -> io.file(args[0] as String, files::call) })

        bridge.setProperty("installerCall", guarded { args -> io.file(args[0] as String, installer::call) })


        documents?.let { folder -> bridge.setProperty("documentCall", guarded { args -> io.file(args[0] as String, folder::call) }) }
        syncLock?.let { lock -> bridge.setProperty("syncLockCall", guarded { args -> io.file(args[0] as String, lock::call) }) }

        bridge.setProperty("fileDeleteNow", guarded { args -> files.deleteNow(args[0] as String); null })


        bridge.setProperty("fileAbort", guarded { args -> io.fileAbort(args[0] as String); null })
        bridge.setProperty("fileDirectories", guarded { _ ->
            JSONObject().put("document", files.documentDirectory).put("cache", files.cacheDirectory).toString()
        })


        calendars?.let { device -> bridge.setProperty("calendarCall", guarded { args -> io.calendar(args[0] as String, device::call) }) }


        appSearch?.let { search ->
            bridge.setProperty("appSearchInfo", guarded { _ -> search.info() })
            bridge.setProperty("appSearchCall", guarded { args -> io.calendar(args[0] as String, search::call) })
        }

        reminders?.let { alarms ->
            bridge.setProperty("alarmApply", guarded { args -> alarms.apply(args[0] as String) })
            bridge.setProperty("notificationsAllowed", guarded { _ -> alarms.permissionGranted() })
            bridge.setProperty("rnAlarmCleanup", guarded { _ -> alarms.cleanupRn() })
            bridge.setProperty("reminderReceiverCounts", guarded { _ -> alarms.receiverCounts() })
            bridge.setProperty("reminderLedger", guarded { _ -> alarms.ledger() })
        }

        widgets?.let { widgets ->
            bridge.setProperty("widgetInputs", guarded { _ -> widgets.inputs() })
            bridge.setProperty("widgetPublish", guarded { args -> widgets.publish(args[0] as String); null })
            bridge.setProperty("widgetAppState", guarded { _ -> widgets.appState() })
        }
        scheduleBackgroundSync?.let { schedule -> bridge.setProperty("bgSyncSchedule", guarded { args -> schedule(args[0] as Boolean); null }) }


        gmail?.let { authorization -> bridge.setProperty("gmailCall", guarded { args -> io.gmail(args[0] as String, authorization) }) }
        gmailReceipts?.let { receipts ->
            bridge.setProperty("gmailFile", guarded { args -> receipts.file(args[0] as String, args[1] as String, args[2] as String) })
            bridge.setProperty("gmailSql", guarded { args -> receipts.sql(args[0] as String, args[1] as String, args[2] as String) })
        }

        voice?.let { call -> bridge.setProperty("voiceCall", guarded { args -> io.voice(args[0] as String, call) }) }
        engine.globalObject.setProperty("__mindwtrNative", bridge)

        engine.globalObject.setProperty("__mindwtrFossBuild", BuildConfig.FOSS)

        appInfo?.let { engine.globalObject.setProperty("__mindwtrAppInfo", it) }
    }


    fun focus(limit: Int, controls: String = "", controlEdit: String = "", folds: String = ""): JSONObject =
        callAsync("focus", limit, controls, controlEdit, folds)


    fun focusWindow(key: String, offset: Int, limit: Int, revision: String, controls: String = "", folds: String = ""): JSONObject =
        callAsync("focusWindow", key, offset, limit, revision, controls, folds)


    fun openQuickCapture(): JSONObject = callAsync("captureOpen")


    fun quickCaptureView(json: String): JSONObject = callAsync("captureView", json)


    fun editQuickCapture(json: String): JSONObject = callAsync("captureEdit", json)


    fun submitQuickCapture(json: String): JSONObject = callAsync("captureSubmit", json)


    fun createQuickCaptureSnapshot(snapshots: File, protect: () -> Set<String>): String? {
        snapshots.mkdirs()
        val written = File(snapshots, ".capture-${java.util.UUID.randomUUID()}.pending")
        val handle = data.openRecoveryWrite(written)
        try {
            val snapshot = callAsync("captureSnapshotFile", handle, deadlineMs = sized(OPERATION_DEADLINE_MS, libraryFileBytes())).optJSONObject("snapshot") ?: return null.also { written.delete() }
            return RecoverySnapshots.publishCapture(snapshots, written, snapshot.getString("fileName"), protect)
        } finally { data.drop(handle) }
    }


    fun dataExport(format: String, file: File, maxBytes: Long): JSONObject {
        val handle = data.openWrite(file, base64 = format == "tasknotes")
        try { return callAsync("dataExportFile", format, handle, maxBytes, deadlineMs = sized(OPERATION_DEADLINE_MS, libraryFileBytes())) }
        finally { data.drop(handle) }
    }


    fun dataChannelRoundTrip(source: File, copy: File): JSONObject {
        val read = data.openRead(source)
        val write = data.openWrite(copy)
        try { return callAsync("dataChannelRoundTrip", read, write, deadlineMs = BACKUP_DEADLINE_MS) }
        finally { data.drop(read); data.drop(write) }
    }


    fun submitQuickCaptureLines(json: String): JSONObject = callAsync("captureLines", json)


    fun submitQuickCapturePickerQuery(json: String): JSONObject = callAsync("capturePicker", json)


    fun submitCaptureModal(json: String): JSONObject = callAsync("captureModalSubmit", json)


    fun submitCaptureModalLines(json: String): JSONObject = callAsync("captureModalLines", json)


    fun completeTask(id: String, taskRevision: String): JSONObject = callAsync("complete", id, taskRevision)


    fun undoTaskCompletion(json: String): JSONObject = callAsync("completeUndo", json)


    fun undoInboxDecision(json: String): JSONObject = callAsync("inboxDecisionUndo", json)


    fun setTaskFocus(id: String, focused: Boolean, taskRevision: String): JSONObject = callAsync("taskFocus", id, focused, taskRevision)


    fun setProjectFocus(id: String, focused: Boolean, projectRevision: String): JSONObject = callAsync("projectFocus", id, focused, projectRevision)


    fun createProject(title: String, areaId: String, requestId: String): JSONObject =
        callAsync("createProject", title, areaId, requestId)


    fun areaFilter(): JSONObject = callAsync("areaFilter")


    fun setAreaFilter(selectionJson: String): JSONObject = callAsync("setAreaFilter", selectionJson)


    fun searchTasks(json: String): JSONObject = callAsync("search", json)


    fun saveSearch(json: String): JSONObject = callAsync("saveSearch", json)


    fun startInboxProcessing(mode: String): JSONObject = callAsync("inboxStart", mode)


    fun inboxProcessingStep(json: String): JSONObject = callAsync("inboxStep", json)


    fun commitInboxProcessingStep(json: String): JSONObject = callAsync("inboxCommit", json)


    fun skipInboxProcessingTask(json: String): JSONObject = callAsync("inboxSkip", json)


    fun endInboxProcessing(sessionId: String): JSONObject = callAsync("inboxEnd", sessionId)


    fun menuRead(name: String, json: String): JSONObject = callAsync("menuRead", name, json)


    fun menuCommand(name: String, json: String): JSONObject = callAsync("menuCommand", name, json)


    fun journalAhead(name: String, json: String) {
        require(name == "projectEdit") { "$name is not journaled ahead" }
        checkNotNull(journal) { "The write journal is not open" }.append("menuCommand", listOf(name, json))
    }


    fun taskEditorModel(id: String): JSONObject = callAsync("editorModel", id)


    fun editTaskDraft(id: String, draftJson: String, editJson: String, checklistJson: String = ""): JSONObject =
        callAsync("editDraft", JSONObject().put("id", id).put("draft", JSONObject(draftJson))
            .apply { if (editJson.isNotEmpty()) put("edit", JSONObject(editJson)) }
            .apply { if (checklistJson.isNotEmpty()) put("checklist", JSONArray(checklistJson)) }.toString())


    fun taskView(json: String): JSONObject = callAsync("taskView", json)


    fun editTaskChecklist(id: String, draftJson: String, checklistJson: String, editJson: String): JSONObject =
        callAsync("editChecklist", JSONObject().put("id", id).put("draft", JSONObject(draftJson)).put("checklist", JSONArray(checklistJson))
            .apply { if (editJson.isNotEmpty()) put("edit", JSONObject(editJson)) }.toString())


    fun resetTaskChecklist(id: String, requestId: String, taskRevision: String): JSONObject =
        callAsync("resetChecklist", JSONObject().put("id", id).put("requestId", requestId).put("taskRevision", taskRevision).toString())


    fun editorSuggestions(id: String, field: String, query: String, limit: Int): JSONObject =
        callAsync("editorSuggestions", id, field, query, limit)


    fun saveTaskDraft(id: String, baseJson: String, patchJson: String, checklistJson: String, attachmentsJson: String, requestId: String): JSONObject =
        callAsync("saveDraft", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson))
            .apply { if (checklistJson.isNotEmpty()) put("checklist", JSONObject(checklistJson)) }
            .apply { if (attachmentsJson.isNotEmpty()) put("attachments", JSONObject(attachmentsJson)) }.put("requestId", requestId).toString())


    fun updateTask(id: String, baseJson: String, patchJson: String, requestId: String): JSONObject =
        callAsync("update", JSONObject().put("id", id).put("base", JSONObject(baseJson)).put("patch", JSONObject(patchJson))
            .put("requestId", requestId).toString())


    fun ingestPendingCaptures(requestId: String): JSONObject = callAsync("ingest", requestId)


    fun ingestPendingAudio(): JSONObject = callLong("ingestAudio")


    fun archiveRetention(editorOpen: Boolean): JSONObject = callAsync("archiveRetention", editorOpen)


    fun logLinkHandoff(outcome: String, surface: String) {
        runCatching { callAsync("logLinkHandoff", outcome, surface) }
    }

    fun logLine(message: String, context: JSONObject) {
        runCatching { callAsync("logLine", message, context.toString()) }.onFailure { Log.i(TAG, "$message $context") }
    }


    fun contextAutomation(json: String): JSONObject = callAsync("contextAutomation", json)


    fun remindersStart(): JSONObject = callAsync("remindersStart")


    fun appSearchStart(): JSONObject = callAsync("appSearchStart")


    fun appSearchApply(): JSONObject = callAsync("appSearchApply")


    fun appSearchIds(): JSONObject = callAsync("appSearchIds")


    fun remindersCycle(mode: String, key: String = ""): JSONObject = callAsync("remindersCycle", mode, key)


    fun pomodoroAlarmPlan(granted: Boolean, raw: String?, scope: String, pending: String, delivered: String): JSONObject =
        callAsync("pomodoroAlarmPlan", granted, raw, scope, pending, delivered)


    fun pomodoroAlarmSaved(outcome: String): JSONObject = callAsync("pomodoroAlarmSaved", outcome)


    fun pomodoroPanelRead(presentation: String): JSONObject = callAsync("pomodoroPanelRead", presentation)


    fun pomodoroTasks(json: String): JSONObject = callAsync("pomodoroTasks", json)


    fun pomodoroTransitionPrepare(request: String): JSONObject = callAsync("pomodoroTransitionPrepare", request)


    fun pomodoroTransitionCommit(planJSON: String): JSONObject = callAsync("pomodoroTransitionCommit", planJSON, false)


    fun pomodoroLegacyAlert(raw: String?, upgradedAtMs: Long): JSONObject = callAsync("pomodoroLegacyAlert", raw, upgradedAtMs)


    fun reminderDone(requestId: String, taskId: String): JSONObject = callAsync("reminderDone", requestId, taskId)


    fun reminderSnooze(json: String): JSONObject = callAsync("reminderSnooze", json)


    fun refreshWidgets(leave: Boolean = false) {
        if (leave) callAsync("widgetsRefresh", "leave") else {

            awaitQuiet()
            callAsync("widgetsRefresh")
        }
        widgets?.settle()
    }


    fun awaitQuiet(askedAt: Long = SystemClock.uptimeMillis(), quietSince: Long = 0, stop: () -> Boolean = { false }): String {
        if (Thread.currentThread() === engineThread) return "engine"
        return WidgetRefreshGate.await(SystemClock::uptimeMillis, Thread::sleep, { maxOf(lastCallAt, quietSince) }, ::engineBusy, stop, askedAt)
    }


    fun warmFirstSave() {
        if (Thread.currentThread() === engineThread) return
        val startedAt = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - startedAt < SAVE_WARM_MAX_MS) {
            val quietFor = SystemClock.uptimeMillis() - lastCallAt
            if (engineBusy() || quietFor < WidgetRefreshGate.QUIET_MS) {
                Thread.sleep(if (engineBusy()) 50 else WidgetRefreshGate.QUIET_MS - quietFor)
                continue
            }
            if (callAsync("saveWarm", SAVE_WARM_SLICE).optBoolean("done", true)) return
        }
    }


    @Volatile private var lastCallAt = 0L


    private fun engineBusy(): Boolean = executor.queue.any { (it as? java.util.concurrent.Delayed)?.getDelay(TimeUnit.MILLISECONDS)?.let { d -> d <= 0 } ?: true }


    fun pruneReceipts(): JSONObject = callAsync("pruneReceipts")


    fun language(stored: String, system: String): JSONObject =
        callAsync("language", debugFault("language").ifEmpty { stored }, system)


    fun strings(keys: List<String>): JSONObject = callAsync("strings", JSONArray(keys).toString())


    fun swipeTrays(): JSONObject = callAsync("swipeTrays")

    fun theme(stored: String): JSONObject = callAsync("theme", stored)


    fun languageSaved(stored: String, system: String): JSONObject = callAsync("languageSaved", stored, system)


    fun appLock(): JSONObject = callAsync("appLock")


    fun logShare(): JSONObject = callAsync("logShare")


    fun databaseBytes(): Long = callAsync("backupLibraryBytes").getLong("bytes")


    fun backupFailureModel(operation: String, error: String, limitMb: Long): JSONObject = callAsync("backupDocumentFailureModel", operation, error, limitMb)


    val data = DataChannel()


    private val budget: BackupBudget get() = debugFault("budget_ms_per_mib").toLongOrNull()?.takeIf { it > 0 }
        ?.let { BackupBudget.DEFAULT.copy(msPerMiB = it) } ?: BackupBudget.DEFAULT


    private fun sized(old: Long, bytes: Long): Long = if (debugFault("d1c_control") in setOf("pre-d1c", "fixed-deadlines")) old else budget.ms(bytes)


    fun budgetMs(bytes: Long): Long = budget.ms(bytes)

    private fun libraryFileBytes(): Long = libraryFileBytes(databaseFile)


    private fun deadline(method: String, args: List<Any?>): Long =
        if (method == BackupOperations.METHOD) frozenBudget(args[0] as String) else deadlineOf(method, args)


    private fun frozenBudget(reference: String): Long =
        if (debugFault("d1c_control") in setOf("pre-d1c", "fixed-deadlines")) BACKUP_DEADLINE_MS
        else backups?.budgetMs(reference, budget) ?: BACKUP_DEADLINE_MS


    private fun storageBudget(): String = JSONObject().put("baseMs", budget.baseMs).put("msPerMiB", budget.msPerMiB)
        .put("storageTimeoutMs", budget.ms(libraryFileBytes())).toString()


    fun backupInspect(file: File, base64: Boolean, metadataJson: String, format: String): JSONObject {
        val handle = data.openRead(file, base64)
        try { return callAsync("backupDocumentInspectFile", handle, metadataJson, format, deadlineMs = sized(BACKUP_DEADLINE_MS, file.length() + libraryFileBytes())) }
        finally { data.drop(handle) }
    }


    fun backupPrepare(source: File, base64: Boolean, inputJson: String, recovery: File?, plan: File, maxPlanBytes: Long): JSONObject {
        val handles = ArrayList<String>()
        try {
            val sourceHandle = data.openRead(source, base64).also(handles::add)
            val recoveryHandle = recovery?.let(data::openRecoveryWrite)?.also(handles::add) ?: ""
            val planHandle = data.openWrite(plan, capBytes = maxPlanBytes).also(handles::add)
            return callAsync("backupDocumentPrepareFile", sourceHandle, inputJson, recoveryHandle, planHandle, deadlineMs = sized(BACKUP_DEADLINE_MS, source.length() + libraryFileBytes()))
        } finally { handles.forEach(data::drop) }
    }


    fun backupCommit(referenceJson: String, snapshotName: String): JSONObject = callAsync("backupDocumentCommit", referenceJson, snapshotName)


    fun backupResultModel(replyJson: String): JSONObject = callAsync("backupDocumentResultModel", replyJson)


    fun sessionRestoreRead(): JSONObject = callAsync("sessionRestoreRead")


    fun sessionRestoreWrite(pathname: String, paramsJson: String, ageMs: Long): JSONObject = callAsync("sessionRestoreWrite", pathname, paramsJson, ageMs)


    fun backupUndoHold(snapshot: File): JSONObject {
        val handle = data.openRead(snapshot, false)
        try {
            return callAsync("backupUndoHold", handle, snapshot.name, deadlineMs = sized(BACKUP_DEADLINE_MS, snapshot.length()))
        } finally { data.drop(handle) }
    }


    fun backupSnapshotModel(name: String, mode: String): JSONObject = callAsync("backupSnapshotRestoreModel", name, mode)


    fun logClear(): JSONObject = callAsync("logClear")


    fun syncStart(appState: String): JSONObject = callAsync("syncStart", appState)


    fun syncAppState(appState: String): JSONObject = callAsync("syncAppState", appState)


    fun syncNetwork(json: String): JSONObject = callAsync("syncNetwork", json)


    fun syncState(): JSONObject = callAsync("syncState")


    fun backgroundSync(trigger: String, stored: Int): JSONObject =
        callLong("backgroundSync", trigger, stored, debugFault("bgsync_deadline_ms").toIntOrNull() ?: 0)


    fun pullSync(): JSONObject = callLong("pullSync")


    fun syncCommand(name: String, json: String): JSONObject = callLong("menuCommand", name, json)


    fun aiRequest(name: String, json: String, handle: LongCall = LongCall()): JSONObject = callLong("aiRequest", name, json, handle = handle)


    fun aboutRequest(name: String, json: String): JSONObject = callLong("aboutRequest", name, json)


    fun rnValue(key: String): String? = onEngine { keyValue.get(key) }


    fun attachmentRequest(name: String, json: String): JSONObject = callLong("attachmentRequest", name, json)


    fun calendarRequest(name: String, json: String): JSONObject = callLong("calendarRequest", name, json)


    fun gmailRequest(name: String, json: String): JSONObject = callLong("gmailRequest", name, json)


    fun voiceRequest(name: String, json: String): JSONObject = callLong("voiceRequest", name, json)


    class LongCall {
        @Volatile internal var id: String? = null
        @Volatile internal var done: CompletableFuture<String>? = null
        @Volatile internal var cancelled = false
    }


    fun cancel(handle: LongCall) {
        handle.cancelled = true
        handle.done?.completeExceptionally(CancellationException("The AI request was cancelled"))
        runCatching { synchronized(lifecycleLock) { if (shutdown == null) executor.execute { abortLong(handle) } } }
    }


    private fun abortLong(handle: LongCall) {
        val id = handle.id ?: return
        if (context == null || stopped != null) return
        runCatching { call("abort", id) }
        handle.done?.completeExceptionally(CancellationException("The AI request was cancelled"))
    }


    fun projects(): JSONObject = callAsync("projectList")


    fun projectDetail(id: String, offset: Int, limit: Int, revision: String): JSONObject =
        callAsync("projectDetail", id, offset, limit, revision)


    private fun debugFault(name: String): String = debugProperty(name)


    private fun netCheck() {
        val port = debugFault("net_check").ifEmpty { return }
        runCatching { callAsync("netCheck", port, deadlineMs = NETWORK_DEADLINE_MS) }
            .onSuccess { Log.i(TAG, "Native Android net check $it") }
            .onFailure { Log.w(TAG, "Native Android net check failed", it) }

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


    private fun callAsync(method: String, vararg args: Any?, deadlineMs: Long = deadline(method, args.toList())): JSONObject {
        if (method != "widgetsRefresh" && method != "saveWarm") lastCallAt = SystemClock.uptimeMillis()
        val done = CompletableFuture<JSONObject>()
        val wait = {
            try { done.get() } catch (failure: ExecutionException) { throw failure.cause ?: failure }
        }
        if (Thread.currentThread() === engineThread) {
            stopped?.let { throw IllegalStateException(it) }
            finish(begin(method, args, deadlineMs, done), answerChecked(method, args, deadlineMs))
            return wait()
        }

        return traced("core:wait") {
            onEngineQueued {
                stopped?.let { throw IllegalStateException(it) }

                begin(method, args, deadlineMs, done).let { if (writeQueue.admit(it)) start(it) }
            }
            wait()
        }
    }


    private class Call(val method: String, val args: Array<out Any?>, val deadlineMs: Long, val entry: WriteJournal.Entry?, val stop: String,
                       val done: CompletableFuture<JSONObject>) {
        var id = ""
        var deadlineAt = 0L

        var deadlineCheck: ScheduledFuture<*>? = null

        var sent: Array<out Any?> = emptyArray()
    }


    private val calls = ArrayList<Call>()


    private val writeQueue = WriteQueue<Call> { it.entry != null }


    private fun startNextWrite(call: Call) {
        val next = writeQueue.ended(call) ?: return
        runCatching {
            executor.execute {
                if (stopped == null && context != null) start(next)
                else next.done.completeExceptionally(IllegalStateException(stopped ?: "Core host is closed"))
            }
        }.onFailure { next.done.completeExceptionally(it) }
    }


    private fun begin(method: String, args: Array<out Any?>, deadlineMs: Long, done: CompletableFuture<JSONObject>): Call {
        val entry = if (method in WriteJournal.WRITES) checkNotNull(journal).append(method, args.toList()) else null
        val stop = if (entry != null) debugFault("journal_stop") else ""
        if (entry != null) {
            checkNotNull(sqlite).failCommits = debugFault("fail_commit") == "1"

            sqlite?.stopAfterCommit = debugFault("commit_stop") == WriteJournal.key(method, args.toList())
            debugDelay("delay_before_ms")
            journalStop(stop, "before", entry)
        }
        return Call(method, args, deadlineMs, entry, stop, done)
    }


    private fun finish(call: Call, result: JSONObject) {
        call.deadlineCheck?.cancel(false)
        if (call.entry != null) {
            debugDelay("delay_after_ms")
            journalStop(call.stop, "after", call.entry)
        }
        try {
            if (call.method == BackupOperations.METHOD) backupFinish(call.entry, call.args.toList(), result, replay = false)
            else if (call.method in WriteJournal.WRITES) settle(call.entry, result, replay = false)
            dropSent(call.method, call.sent)
            call.done.complete(replyValue(result))
        } catch (failure: Throwable) {
            call.done.completeExceptionally(failure)
        }
        startNextWrite(call)
    }


    private fun start(call: Call) = traced("core:${call.method}") {

        val sent = try { sendArgs(call.method, call.args) } catch (mismatch: BackupOperations.Mismatch) {
            Log.w(TAG, "Native Android backup operation refused before send: ${mismatch.message}")
            finish(call, JSONObject().put("ok", false).put("error", "INVALID_INPUT: Backup operation files do not match"))
            return@traced
        }
        call.sent = sent
        call.id = call(call.method, *sent) as String
        call.deadlineAt = SystemClock.uptimeMillis() + call.deadlineMs
        val answer = call("poll", call.id) as String?
        if (answer != null) {
            finish(call, JSONObject(answer))
        } else {
            calls += call
            runCatching {
                call.deadlineCheck = executor.schedule({ pollCalls() }, call.deadlineMs, TimeUnit.MILLISECONDS)
                executor.execute { idlePump() }
            }
        }

        settleWatched()
        pollCalls()
        schedulePump()
    }


    private fun pollCalls() {
        if (calls.isEmpty() || context == null || stopped != null) return
        for (call in calls.toList()) {
            val answer = call("poll", call.id) as String?
            if (answer != null) {
                calls.remove(call)
                traced("core:${call.method}") { finish(call, JSONObject(answer)) }
            } else if (SystemClock.uptimeMillis() >= call.deadlineAt) {
                calls.remove(call)
                traced("core:${call.method}") { expire(call) }
                if (stopped != null) return
            }
        }
    }


    private fun expire(call: Call) {
        call.deadlineCheck?.cancel(false)
        call("cancel", call.id)
        if (pumpUntil(call.id, DRAIN_MS) == null) {
            val reason = "Core host stopped: ${call.method} did not end after its deadline"
            stopped = reason
            Log.e(TAG, reason)
            call.done.completeExceptionally(IllegalStateException(reason))
            closeOnEngine()
            return
        }
        checkNotNull(context).globalObject.getJSFunction("__resumeHostCalls").call()
        schedulePump()
        call.done.completeExceptionally(IllegalStateException("Core ${call.method} timed out"))
        startNextWrite(call)
    }


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

                if (handle.cancelled) abortLong(handle)
                idlePump()
            }
        }
        val answer = try {
            done.get(SYNC_WAIT_MS, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {

            onEngine { abortLong(handle) }
            throw IllegalStateException("Core $method timed out")
        } catch (failure: ExecutionException) {
            throw failure.cause ?: failure
        }
        return replyValue(JSONObject(answer))
    }


    private fun global(engine: QuickJSContext, name: String): JSFunction = functions.getOrPut("global:$name") { engine.globalObject.getJSFunction(name) }


    private fun settleWatched() {
        if (watched.isEmpty()) return
        for (id in watched.keys.toList()) (call("poll", id) as String?)?.let { watched.remove(id)?.complete(it) }
    }


    private fun idlePump() {

        pumpTask?.cancel(false)
        pumpTask = null
        pumpAt = Long.MAX_VALUE
        val engine = context ?: return
        if (stopped != null) return


        val turnStart = SystemClock.uptimeMillis()
        var ran = 0
        runCatching {
            traced("core:idlePump") {
                val one = global(engine, "__pumpOne")
                do {
                    ran = (one.call() as? Number)?.toInt() ?: 0
                } while (ran > 0 && SystemClock.uptimeMillis() - turnStart < PUMP_TURN_MS)
            }
        }.onFailure { Log.w(TAG, "Native Android idle pump failed error=${it.javaClass.simpleName}") }
        settleWatched()
        pollCalls()
        if (context == null || stopped != null) return

        if (ran > 0) runCatching { executor.execute { idlePump() } }
        schedulePump()
    }


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


    private fun answer(method: String, args: Array<out Any?>, deadlineMs: Long): JSONObject = traced("core:$method") {
        val id = call(method, *args) as String
        val answer = pumpUntil(id, deadlineMs) ?: run {


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

        settleWatched()
        pollCalls()
        schedulePump()
        JSONObject(answer)
    }

    private fun JSONObject.error(): String? = if (getBoolean("ok")) null else getString("error")


    private fun resumeActivation() {

        val result = answer("resumeActivation", emptyArray(), sized(OPERATION_DEADLINE_MS, libraryFileBytes()))
        if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
        activationOwed = false
        Log.i(TAG, "Native Android recovery boot activation resumed")
    }


    private fun settle(entry: WriteJournal.Entry?, result: JSONObject, replay: Boolean): Boolean {
        result.optJSONObject("value")?.optJSONArray("deviceWrites")?.let { devices.store(it, entry?.sequence, replay) }
        return entry != null && checkNotNull(journal).settle(entry, result.error(), replay)
    }


    data class Replay(val sent: Int, val dropped: Int, val left: Int, val owed: String?)


    fun replayJournal(): Replay = onEngine {
        stopped?.let { throw IllegalStateException(it) }
        Trace.beginSection("core:replayJournal")
        val journal = checkNotNull(journal)
        var sent = 0
        var dropped = 0
        var owed: String? = null
        val entries = journal.pending()
        val lastBackup = entries.indexOfLast { it.method == BackupOperations.METHOD }
        for ((index, entry) in entries.withIndex()) {
            sent += 1
            checkNotNull(sqlite).failCommits = debugFault("fail_commit") == "1"
            val error = try {
                answerChecked(entry.method, entry.args.toTypedArray(), deadline(entry.method, entry.args)).also {
                    val left = if (entry.method == BackupOperations.METHOD) backupFinish(entry, entry.args, it, replay = true) else settle(entry, it, replay = true)
                    if (left) dropped += 1
                }.error()
            } catch (failure: Throwable) {
                owed = failure.message ?: failure.javaClass.simpleName
                break
            }
            if (WriteJournal.keeps(error)) { owed = error; break }


            if (index == lastBackup && activationOwed) resumeActivation()
        }
        if (owed == null && activationOwed) resumeActivation()
        Trace.endSection()
        stopped?.let { throw IllegalStateException(it) }
        Replay(sent, dropped, journal.pending().size, owed).also {
            Log.i(TAG, "Native Android journal replay sent=${it.sent} dropped=${it.dropped} left=${it.left} owed=${owed?.substringBefore(':') ?: "none"}")
        }
    }


    private fun journalStop(stop: String, at: String, entry: WriteJournal.Entry) {
        val op = if (entry.method == "menuCommand") entry.args[0] else entry.method
        if (stop != "$at:$op") return
        Log.i(TAG, "Native Android journal stop at=$at op=$op entry=${entry.file.name}")
        android.os.Process.killProcess(android.os.Process.myPid())
    }


    private fun kvFault() = check(debugFault("fail_kv_set") != "1") { "Injected RKStorage write failure" }

    private fun queueStop() {
        if (debugFault("queue_stop") != "delete") return
        Log.i(TAG, "Native Android queue stop at=delete")
        android.os.Process.killProcess(android.os.Process.myPid())
    }


    private fun pumpUntil(id: String, ms: Long): String? {
        val engine = checkNotNull(context)
        val pump = engine.globalObject.getJSFunction("__pumpTimers")
        val nextDelay = engine.globalObject.getJSFunction("__nextTimerDelay")
        val deadline = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < deadline) {
            traced("core:pump") { pump.call() }
            (call("poll", id) as String?)?.let { return it }
            val delay = (nextDelay.call() as? Number)?.toLong() ?: 1L

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
        calls.forEach { it.done.completeExceptionally(IllegalStateException(stopped ?: "Core host is closed")) }
        calls.clear()
        writeQueue.close().forEach { it.done.completeExceptionally(IllegalStateException(stopped ?: "Core host is closed")) }
        io.close()

        runCatching { syncLock?.close() }
        runCatching { gmailReceipts?.close() }
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


fun debugProperty(name: String): String {
    if (!BuildConfig.DEBUG) return ""
    return runCatching {
        val process = ProcessBuilder("getprop", "debug.mindwtr.native.$name").start()
        process.inputStream.bufferedReader().use { it.readText().trim() }.also { process.waitFor() }
    }.getOrDefault("")
}


internal inline fun <T> traced(name: String, work: () -> T): T {
    Trace.beginSection(name)
    try { return work() } finally { Trace.endSection() }
}


class CoreBundle(val hash: String, val cache: BytecodeCache?, val bytes: () -> ByteArray) {
    fun source(): String = String(bytes(), Charsets.UTF_8)
}
