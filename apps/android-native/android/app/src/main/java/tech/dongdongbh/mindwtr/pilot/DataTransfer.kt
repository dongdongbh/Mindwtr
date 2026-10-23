package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.SavedStateHandle
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.BackupOperations
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.DataChannel
import tech.dongdongbh.mindwtr.pilot.core.RecoverySnapshots
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Date
import java.util.UUID
import java.util.concurrent.CompletableFuture

/*
 * Settings › Data's Backup and Import folds and Sync › Recovery snapshots (RN's use-sync-settings-backup-actions.ts and
 * lib/data-transfer.ts) on core's native backup document (native-backup-document.ts): export a JSON, CSV or TaskNotes file,
 * Restore backup, Merge backup, the five imports (Todoist, TickTick, DGT GTD, OmniFocus, Mindwtr CSV), Getting Started, and a
 * snapshot restore (a Recovery snapshots row, or a result's Undo). Kotlin keeps RN's screen state (which action runs, the
 * open question) and the platform's files: the system pickers, the staged copy, the recovery snapshot, the operation's plan
 * (BackupOperations) and the export's folder document. Every word, check and data change is core's. Design: pass D1 design.md; imports and Getting Started: pass D1b design.md.
 */

/** The measured transfer limit (design §4.1): a picked file and the library together, before anything is decoded or parsed. */
object DataTransferLimits {
    // Measured on the S23 (pass D1c step 0 runs 5 and 6; native heap ceiling 512 MiB): the smallest workload bound was an
    // OmniFocus import that left a 31.5 MiB library (native 228 MiB), and the limit is half of that. Restoring into a fresh
    // library passed at 91 MiB (run 5); an Undo over 53.4 MiB of rows reached 641 MiB native. Every workload rerun at 15 MiB
    // peaked at or under 327 MiB native and 79 MiB Java (rule: 128, half the 256 MiB growth limit).
    // ponytail: one fixed limit; a device with a smaller heap gets the same number. Stream the plan through a file if libraries outgrow it.
    internal const val LIMIT_BYTES = 15L * 1024 * 1024
    /** Core's MAX_BACKUP_SOURCE_BYTES: a picked JSON backup alone. */
    const val MAX_BACKUP_SOURCE_BYTES = 128L * 1024 * 1024
    /** Core's DEFAULT_IMPORT_SOURCE_LIMITS.maxInputBytes: an import's picked file alone. */
    const val MAX_IMPORT_SOURCE_BYTES = 16L * 1024 * 1024
    // ponytail: a fixed cap; build the ZIP in slices if TaskNotes users outgrow it.
    /**
     * A TaskNotes export's library: the bound it had before D1c. Step 0 run 4 (S23): a ZIP of about 10k tasks did not finish in
     * 15 min, because core builds it in one synchronous call in QuickJS, so no deadline runs meanwhile (host: 0.7 s).
     */
    const val MAX_TASKNOTES_EXPORT_BYTES = 12L * 1024 * 1024

    /** The limit; debug builds only: `debug.mindwtr.native.transfer_limit_mb` raises it for the measurement run. */
    val MAX_DATA_TRANSFER_BYTES: Long get() = debugProperty("transfer_limit_mb").toLongOrNull()?.takeIf { it > 0 }?.let { it * 1024 * 1024 } ?: LIMIT_BYTES

    /** A frozen plan holds the library twice (the current document and the result), plus its reply. */
    val MAX_PLAN_BYTES: Long get() = 2 * MAX_DATA_TRANSFER_BYTES + 1024 * 1024
}

/** Whether Settings › Data's rows are off: an action of theirs runs ([action]), or a sync does ([syncing]), as RN's rows are. */
internal fun dataRowsBusy(action: String?, syncing: Boolean): Boolean = action != null || syncing

/** Settings › Data's own Menu commands (check-boot-gates.mjs: each is one host command): Getting Started's seed. */
internal val DATA_COMMANDS = setOf("gettingStarted")

/** RN's MIME type for a picked backup (pickBackupDocument). */
private const val BACKUP_MIME = "application/json"

class DataTransferModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val app get() = shell.getApplication<Application>()
    private val resolver: ContentResolver get() = app.contentResolver
    private val snapshots get() = File(app.filesDir, "snapshots")
    private val staging get() = File(app.noBackupFilesDir, "backup-import")
    private val exportPending get() = File(app.noBackupFilesDir, "export-pending.json")
    private fun deleteDocument(uri: String): Boolean = try {
        DocumentsContract.deleteDocument(resolver, Uri.parse(uri))
    } catch (_: java.io.FileNotFoundException) { true }
    /** Whether the folder still has [uri]'s document; null when the provider cannot say. */
    private fun documentExists(uri: String): Boolean? = try {
        resolver.query(Uri.parse(uri), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() }
    } catch (_: java.io.FileNotFoundException) { false } catch (_: Exception) { null }
    val operations get() = BackupOperations(File(app.noBackupFilesDir, "backup-operations"), snapshots, maxPlanBytes = DataTransferLimits.MAX_PLAN_BYTES)

    /**
     * RN's backupAction: the running action ("export", "export:csv", "export:tasknotes", "restore", "merge", "import:<importer>",
     * "snapshot:<name>"), or "gettingStarted" (RN's own busy flag for that row; every Data row is off while it runs).
     */
    var action by mutableStateOf<String?>(null); private set
    /**
     * The open question (RN's Alert): `{ kind: "confirm", model, mode, stage }`, `{ kind: "snapshot", model, name, undo }`, or
     * `{ kind: "noUndo", model }` (large-library pass b: a prepared operation that may run without Undo; [noUndoAnswer] waits on it).
     */
    var question by mutableStateOf<JSONObject?>(null); private set
    /** A system picker the Data screen opens next ("json", "tree"); the screen launches it and clears it. */
    var launch by mutableStateOf<String?>(null); private set
    /** The document picker's types: RN's backup type, or the importer's list from core's Data model. */
    var pickTypes: Array<String> = arrayOf(BACKUP_MIME); private set
    /** A made export file waiting for the Data screen to open the share sheet. */
    var share by mutableStateOf<Pair<File, String>?>(null); private set
    /** The export made at press time (RN reads its snapshot before the folder picker), held for the picker's answer. */
    private var exportFile: JSONObject? = null
    @Volatile private var noUndoAnswer: CompletableFuture<Boolean>? = null

    /** Every Data row is off while one runs or a sync runs (RN's `isSyncing || isBackupBusy`); each entry point checks it. */
    val busy get() = dataRowsBusy(action, shell.syncActive)

    fun launched() { launch = null }

    private fun view() = menu.settings.page?.takeIf { it.screen == "data" }?.view
    private fun words() = view()?.optJSONObject("backup")
    /** Core's Import fold row for [key] (its mode and picker types). */
    private fun importRow(key: String): JSONObject? = view()?.optJSONObject("importData")?.optJSONArray("rows")?.let { rows ->
        (0 until rows.length()).map(rows::getJSONObject).firstOrNull { it.getString("key") == key }
    }

    // ---- Export ----

    /**
     * Export backup, Export CSV, Export TaskNotes (RN's exportCurrentDataBackup): core's file from the snapshot at press time,
     * written into the app's cache through the data channel (pass D1c), then the folder picker (RN's
     * requestDirectoryPermissionsAsync); a folder gets a copy of the file, no folder shares it.
     */
    fun export(format: String) {
        if (busy) return
        val words = words() ?: return
        val failed = words.getString(when (format) { "csv" -> "csvFailed"; "tasknotes" -> "tasknotesFailed"; else -> "failed" })
        val running = if (format == "json") "export" else "export:$format"
        action = running
        shell.anyTime({ runtime ->
            // The early check; core's own, in its document lane, decides (pass D1c §3.5).
            val limit = exportLimit(format)
            if (runtime.databaseBytes() > limit) throw TransferTooLarge()
            val dir = File(app.cacheDir, "exports").apply { mkdirs() }
            dir.listFiles().orEmpty().forEach { it.delete() }
            val pending = File(dir, "export-${UUID.randomUUID()}.pending")
            val made = try { runtime.dataExport(format, pending, limit) } catch (failure: Throwable) { pending.delete(); throw failure }
            val file = File(dir, made.getString("fileName"))
            if (!pending.renameTo(file)) { pending.delete(); throw IOException("Cannot save the export file") }
            shell.ui {
                exportFile = JSONObject().put("path", file.path).put("format", format)
                launch = "tree"
            }
        }) { failure ->
            Log.w(CoreHost.TAG, "Export failed ${failureForLog(failure)}")
            action = null
            shell.showToast(words.getString("errorTitle"), failed, "error", durationMs = 4_200)
        }
    }

    /** The folder picker's answer: copy the file into [tree], or (none chosen, or the write failed) RN's share fallback. */
    fun folderPicked(tree: Uri?) {
        val made = exportFile ?: run { action = null; return }
        exportFile = null
        val words = words()
        shell.anyTime({ runtime ->
            val file = File(made.getString("path"))
            check(file.isFile) { "The export file is gone" }
            val mime = when (made.getString("format")) { "csv" -> "text/csv"; "tasknotes" -> "application/zip"; else -> "application/json" }
            val written = tree?.let { runCatching { writeToFolder(it, file.name, mime, file) }.onFailure { Log.w(CoreHost.TAG, "Export folder write failed ${failureForLog(it)}") }.isSuccess } ?: false
            if (written) {
                file.delete()
                runtime.logLine("Native Android backup file written releaseCheck=v1.3.5/android-backup-export", JSONObject().put("releaseCheck", "v1.3.5/android-backup-export")
                    .put("format", made.getString("format")).put("route", "saf"))
                shell.ui { action = null }
            } else {
                shell.ui { share = file to mime }
            }
        }) { failure ->
            Log.w(CoreHost.TAG, "Export failed ${failureForLog(failure)}")
            action = null
            words?.let { shell.showToast(it.getString("errorTitle"), it.getString("failed"), "error", durationMs = 4_200) }
        }
    }

    /**
     * RN's StorageAccessFramework.createFileAsync and writeAsStringAsync: the grant kept (as Expo takes it), the document created
     * in the folder, its URI on disk before the first byte, [file] copied in, and the document deleted when the write fails.
     * The record goes once it is closed.
     */
    private fun writeToFolder(tree: Uri, name: String, mime: String, file: File) {
        runCatching { resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        writeExportDocument(exportPending,
            create = { (DocumentsContract.createDocument(resolver, parent, mime, name) ?: throw IOException("The folder refused the new file")).toString() },
            write = { uri ->
                if (debugProperty("backup_stop") == "mid-export") {
                    resolver.openOutputStream(Uri.parse(uri), "w")?.use { out -> file.inputStream().use { input ->
                        val half = ByteArray((file.length() / 2).toInt()); input.read(half); out.write(half)
                    } }
                    Log.i(CoreHost.TAG, "Native Android backup stop at=mid-export")
                    android.os.Process.killProcess(android.os.Process.myPid())
                }
                (resolver.openOutputStream(Uri.parse(uri), "w") ?: throw IOException("The new file cannot be opened")).use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } }
            },
            delete = ::deleteDocument, exists = ::documentExists)
    }

    /** RN's share fallback (expo-sharing): a chooser over ACTION_SEND with the file's FileProvider link and its read grant. */
    fun openShare(activity: Activity) {
        val (file, mime) = share ?: return
        share = null
        action = null
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.diagnostics", file)
            val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(null, uri)
            activity.startActivity(Intent.createChooser(send, "Export Mindwtr Backup"))
            shell.coreHost()?.let { runtime -> Thread { runtime.logLine("Native Android backup file written releaseCheck=v1.3.5/android-backup-export", JSONObject()
                .put("releaseCheck", "v1.3.5/android-backup-export").put("format", formatOf(file.name)).put("route", "share")) }.start() }
        } catch (failure: Exception) {
            Log.w(CoreHost.TAG, "Export share failed ${failureForLog(failure)}")
            words()?.let { shell.showToast(it.getString("errorTitle"), it.getString("failed"), "error", durationMs = 4_200) }
        }
    }

    private fun formatOf(name: String) = when { name.endsWith(".csv") -> "csv"; name.endsWith(".zip") -> "tasknotes"; else -> "json" }

    // ---- Restore backup, Merge backup ----

    /** Restore backup or Merge backup: RN's backup picker (application/json). */
    fun pickBackup(mode: String) {
        if (busy) return
        action = mode
        saved["dataPick"] = mode
        saved.remove<String>("dataPickMode")
        pickTypes = arrayOf(BACKUP_MIME)
        launch = "json"
    }

    /** An Import fold row (RN's handleImport…): the system picker with the importer's types from core's model. */
    fun pickImport(key: String) {
        if (busy) return
        val row = importRow(key) ?: return
        action = "import:$key"
        saved["dataPick"] = "import:$key"
        // Kept with the pick: its answer can arrive after process death, before Settings › Data's model is read again.
        saved["dataPickMode"] = row.getString("mode")
        pickTypes = row.getJSONArray("mimeTypes").let { types -> Array(types.length()) { types.getString(it) } }
        launch = "json"
    }

    /**
     * The document picker's answer (Restore backup, Merge backup, or an import): the file staged, then core's preview (RN's
     * Alert) or RN's invalid-file warning. An import's file goes to core as base64 bytes, a backup's as strict UTF-8 text.
     */
    fun backupPicked(uri: Uri?) {
        val mode = saved.get<String>("dataPick")
        val importMode = saved.get<String>("dataPickMode")?.takeIf { mode?.startsWith("import:") == true }
        saved.remove<String>("dataPick")
        saved.remove<String>("dataPickMode")
        if (uri == null || mode == null || mode.startsWith("import:") && importMode == null) { action = null; return }
        action = mode
        // Core's operation for RN's failure title: Restore failed, Merge failed, or Import failed.
        val operation = importMode ?: if (mode == "merge") "merge" else "replace"
        whenHosted { runtime ->
            val stage = try { stage(uri, import = importMode != null) } catch (failure: Throwable) {
                Log.w(CoreHost.TAG, "Backup stage failed ${failureForLog(failure)}")
                fail(runtime, operation, failure)
                return@whenHosted
            }
            val kind = importMode ?: if (mode == "restore") "json-restore" else "json"
            val preview = try {
                previewStaged(stage.file, runtime.databaseBytes()) { runtime.backupInspect(it, importMode != null, stage.metadata.toString(), kind) }
            } catch (failure: Throwable) {
                Log.w(CoreHost.TAG, "Backup preview failed ${failureForLog(failure)}")
                fail(runtime, operation, failure)
                return@whenHosted
            }
            shell.ui {
                if (!preview.getBoolean("valid")) {
                    finish()
                    // RN's showSettingsWarning (4.2 s).
                    shell.showToast(preview.getString("errorTitle"), preview.getString("errorMessage"), "warning", durationMs = 4_200)
                } else {
                    question = JSONObject().put("kind", "confirm").put("model", preview).put("mode", mode)
                        .put("stage", stage.file.name).put("metadata", stage.metadata).apply { importMode?.let { put("importMode", it) } }
                }
            }
        }
    }

    /** The question's Cancel: nothing was written; the staged copy goes. */
    fun cancel() {
        // The no-Undo question's Cancel: the waiting operation discards its prepared files and ends itself.
        if (question?.optString("kind") == "noUndo") { question = null; noUndoAnswer?.complete(false); return }
        question?.optString("stage")?.takeIf { it.isNotEmpty() }?.let { StagedCopies.release(File(staging, it)) }
        question = null
        finish()
    }

    /** The question's Restore or Merge: the operation runs (design §4.2). */
    fun confirm() {
        val open = question ?: return
        question = null
        when (open.getString("kind")) {
            "noUndo" -> noUndoAnswer?.complete(true)
            "confirm" -> {
                val file = File(staging, open.getString("stage"))
                val importMode = open.optString("importMode").takeIf { it.isNotEmpty() }
                val mode = importMode ?: if (open.getString("mode") == "restore") "replace" else "merge"
                run(open.getString("mode"), mode, null, open.getJSONObject("metadata"), file, base64 = importMode != null, staged = file)
            }
            "snapshot" -> {
                val name = open.getString("name")
                action = "snapshot:$name"
                run("snapshot:$name", "restore", name, JSONObject().put("fileName", name).put("lastModified", 0).put("appVersion", BuildConfig.VERSION_NAME),
                    File(snapshots, name), base64 = false)
            }
        }
    }

    // ---- Recovery snapshots ----

    /** A Recovery snapshots row, or a result's Undo ([undo]): core's question first (RN's Alert). */
    fun askSnapshot(name: String, undo: Boolean) {
        if (busy) return
        whenHosted { runtime ->
            val model = runtime.backupSnapshotModel(name, if (undo) "undo" else "restore")
            shell.ui { question = JSONObject().put("kind", "snapshot").put("model", model).put("name", name).put("undo", undo) }
        }
    }

    // ---- The operation ----

    /**
     * Prepare, recovery snapshot, plan, journaled commit (design §4.2), then RN's result toast with Undo. [running] is RN's
     * backupAction; [snapshot] the snapshot a `restore` reads (null: a new one is named now); [source] the file core reads
     * through the data channel (pass D1c), as base64 for an import ([base64]); [staged] the pick's copy, released once read.
     * Debug builds only: `debug.mindwtr.native.backup_stop` = `after-snapshot` or `mid-plan` ends the process at that step.
     */
    private fun run(running: String, mode: String, snapshot: String?, metadata: JSONObject, source: File, base64: Boolean, staged: File? = null) {
        action = running
        whenHosted { runtime ->
            val ops = operations
            val requestId = UUID.randomUUID().toString()
            var journaled = false
            val peak = HeapPeak()
            var outcome = "failed"
            var sourceMiB = 0L
            var libraryMiB = 0L
            try {
                check(source.isFile) { "Snapshot file not found." }
                if (!base64 && source.length() > DataTransferLimits.MAX_BACKUP_SOURCE_BYTES) throw TransferTooLarge()
                val sourceBytes = source.length()
                val libraryBytes = runtime.databaseBytes()
                sourceMiB = sourceBytes / MIB; libraryMiB = libraryBytes / MIB
                admitTransfer(sourceBytes, libraryBytes)
                val name = snapshot ?: RecoverySnapshots.nextName(snapshots, Date())
                // The name is protected from every prune before any of this operation's files exist.
                ops.reserve(requestId, name)
                val recoveryFile = if (mode == "restore") null else ops.pendingSnapshot(requestId)
                // Core admits the source with the library's SQLite bytes again, inside its document lane, and freezes how far the
                // library may grow while its Undo still fits (D1b §0 fix 2, D1c change 1).
                val prepared = try {
                    runtime.backupPrepare(source, base64, JSONObject().put("requestId", requestId).put("mode", mode).put("snapshotName", name)
                        .put("metadata", metadata)
                        .put("admission", JSONObject().put("sourceBytes", sourceBytes).put("maxTransferBytes", DataTransferLimits.MAX_DATA_TRANSFER_BYTES)).toString(),
                        recoveryFile, ops.pendingPlan(requestId), DataTransferLimits.MAX_PLAN_BYTES)
                } finally { staged?.let(StagedCopies::release) }
                // Large-library pass b: core estimates the library may be too large to undo this change. dd's warning first; it runs only on
                // Continue, with its recovery snapshot still written (RN's safety net); the commit then decides Undo from the real bytes.
                prepared.optJSONObject("noUndo")?.let { words ->
                    if (!askNoUndo(words)) {
                        ops.discard(requestId); ops.pendingSnapshot(requestId).delete()
                        outcome = "cancelled"
                        shell.ui { finish() }
                        return@whenHosted
                    }
                }
                val recovery = prepared.optJSONObject("recovery")?.let(::closed)
                if (recovery != null) RecoverySnapshots.publish(snapshots, recoveryFile!!, name, recovery.bytes, recovery.sha256)
                stop("after-snapshot")
                val plan = closed(prepared.getJSONObject("plan"))
                // The commit's deadline is frozen here, before its journal entry; one past the ceiling is refused now, never at a replay.
                val reference = ops.publish(requestId, mode, plan, name, recovery, budgetMs = runtime.budgetMs(sourceBytes + libraryBytes + plan.bytes)) { stop("mid-plan") }
                journaled = true
                val reply = runtime.backupCommit(reference, name)
                val result = runtime.backupResultModel(reply.toString())
                RecoverySnapshots.prune(snapshots, ops::protectedNames)
                outcome = "committed"
                shell.ui { finish(); showResult(result, if (mode == "restore") null else name) { ops.clearResult(requestId) } }
            } catch (failure: Throwable) {
                staged?.let(StagedCopies::release)
                // Never journaled: its folder (reservation, plan) and any unpublished snapshot go now, not at the next start.
                if (!journaled) runCatching { ops.discard(requestId); ops.pendingSnapshot(requestId).delete() }
                Log.w(CoreHost.TAG, "Backup operation failed mode=$mode ${failureForLog(failure)}")
                fail(runtime, mode, failure)
            } finally {
                // The size and memory a tester's phone used for it (pass D1c §3.6): whole MiB and seconds only.
                val (nativeMiB, javaMiB) = peak.stop()
                runCatching {
                    runtime.logLine("Native Android data transfer finished releaseCheck=v1.3.7/native-large-transfer", JSONObject()
                        .put("releaseCheck", "v1.3.7/native-large-transfer").put("operation", mode).put("outcome", outcome)
                        .put("sourceMiB", sourceMiB).put("libraryMiB", libraryMiB).put("seconds", peak.seconds())
                        .put("nativePeakMiB", nativeMiB).put("javaPeakMiB", javaMiB))
                }
            }
        }
    }

    private fun closed(json: JSONObject) = DataChannel.Closed(json.getLong("bytes"), json.getString("sha256"))

    /** Shows the no-Undo question ([words]: core's model) and waits on this operation's thread, as long as the app's other questions wait. */
    private fun askNoUndo(words: JSONObject): Boolean {
        val answer = CompletableFuture<Boolean>()
        shell.ui { noUndoAnswer = answer; question = JSONObject().put("kind", "noUndo").put("model", words) }
        val continued = runCatching { answer.get() }.getOrDefault(false)
        shell.ui { noUndoAnswer = null; if (question?.optString("kind") == "noUndo") question = null }
        return continued
    }

    /** RN's result toast (core's words and duration), with Undo; [shown] (the result record goes) runs once it shows (design §4.3). */
    private fun showResult(result: JSONObject, undo: String?, shown: () -> Unit) {
        val undoLabel = result.optString("undoLabel").takeIf { it.isNotEmpty() && undo != null }
        shell.showToast(result.getString("title"), result.getString("message"), "success", undoLabel,
            if (result.isNull("durationMs")) null else result.getLong("durationMs")) { undo?.let { askSnapshot(it, undo = true) } }
        Thread { runCatching(shown) }.start()
    }

    /**
     * After a start: a result record left by a death after its commit shows its toast once (design §4.3); one that did not commit
     * (stale, refused, its files unreadable) shows RN's failure toast with core's reason before it goes. Staged copies no open
     * question owns go too.
     */
    fun leftover() = whenHosted { runtime ->
        if (BuildConfig.DEBUG && debugProperty("channel_roundtrip") == "1") channelRoundTrip(runtime)
        runCatching { cleanupInterruptedExport(runtime) }.onFailure { Log.w(CoreHost.TAG, "Interrupted export cleanup failed ${failureForLog(it)}") }
        runCatching { StagedCopies.sweep(staging) }.onFailure { Log.w(CoreHost.TAG, "Staged copy sweep failed ${failureForLog(it)}") }
        var found = "none"
        takeLeftover(operations, snapshots, { runtime.backupResultModel(it) }) { leftover, shown ->
            found = if (leftover is Leftover.Result) "result" else "failure"
            when (leftover) {
                is Leftover.Result -> {
                    // Its Undo comes back with this toast: core holds that Undo's attachment files again first, as the commit did
                    // in the process that died (a sync's cleanup must not delete them before the Undo is taken).
                    // A result without Undo (large-library pass b: its toast says so) has nothing to hold.
                    leftover.undo?.takeIf { leftover.model.optString("undoLabel").isNotEmpty() }?.let { name ->
                        val held = runCatching { runtime.backupUndoHold(File(snapshots, name)).optBoolean("held") }
                            .onFailure { Log.w(CoreHost.TAG, "Leftover Undo hold failed ${failureForLog(it)}") }.getOrDefault(false)
                        runCatching {
                            runtime.logLine("Native Android leftover Undo held its attachments releaseCheck=v1.3.7/leftover-undo-hold", JSONObject()
                                .put("releaseCheck", "v1.3.7/leftover-undo-hold").put("outcome", if (held) "held" else "failed"))
                        }
                    }
                    shell.ui { showResult(leftover.model, leftover.undo, shown) }
                }
                is Leftover.Failure -> {
                    val model = failureModel(runtime, leftover.operation, leftover.error)
                    shell.ui {
                        shell.showToast(model.first, model.second, "error", durationMs = 5_200)
                        Thread { runCatching(shown) }.start()
                    }
                }
            }
        }
        // Debug builds only (check-data-device.mjs watches each start until this line): the start's leftover step is over, its
        // toast (if any) already handed to the main thread.
        if (BuildConfig.DEBUG) Log.i(CoreHost.TAG, "Native Android data leftover done result=$found")
    }

    /**
     * Debug builds (check-data-device D0, pass D1c design §7): a file whose second 1 MiB read starts with the bridge's error
     * marker and whose first 512 Ki-unit write ends inside a surrogate pair goes through the real bridge and back; the log line
     * says whether the copy is byte for byte the file.
     */
    private fun channelRoundTrip(runtime: CoreHost) {
        val dir = File(app.cacheDir, "channel-check").apply { mkdirs() }
        val source = File(dir, "source.txt")
        val copy = File(dir, "copy.txt")
        val head = "a".repeat(512 * 1024 - 1) + "\uD83E\uDD89"
        val pad = "b".repeat(DataChannel.CHUNK_BYTES - head.toByteArray().size)
        source.writeText(head + pad + "!MindwtrNativeError:tail")
        val ok = runCatching { runtime.dataChannelRoundTrip(source, copy); copy.readBytes().contentEquals(source.readBytes()) }.getOrDefault(false)
        Log.i(CoreHost.TAG, "Native Android channel roundtrip ok=$ok")
        dir.deleteRecursively()
    }

    /** At start, before any export: a folder document whose write never finished is deleted (the persisted grant allows it). */
    private fun cleanupInterruptedExport(runtime: CoreHost) {
        val outcome = cleanupExportRecord(exportPending, ::deleteDocument, ::documentExists) ?: return
        runtime.logLine("Native Android interrupted export removed releaseCheck=v1.3.5/android-export-cleanup", JSONObject().put("releaseCheck", "v1.3.5/android-export-cleanup").put("outcome", outcome))
    }

    // ---- Files ----

    private class Stage(val file: File, val metadata: JSONObject)

    /** RN's picker copy (copyToCacheDirectory) as a private file: its bytes counted while copied, stopped past the limit. */
    private fun stage(uri: Uri, import: Boolean): Stage {
        val (name, modified) = details(uri)
        val file = StagedCopies.create(staging)
        try {
            (resolver.openInputStream(uri) ?: throw IOException("The selected file cannot be read")).use { input -> copyBounded(input, file, stageLimit(import)) }
        } catch (failure: Throwable) {
            StagedCopies.release(file)
            throw failure
        }
        return Stage(file, JSONObject().put("fileName", name).put("lastModified", modified).put("appVersion", BuildConfig.VERSION_NAME))
    }

    /** expo-document-picker's DocumentDetailsReader: the display name, and COLUMN_LAST_MODIFIED when the provider has it. */
    private fun details(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "import"
        var modified = 0L
        runCatching {
            resolver.query(uri, null, null, null, null)?.use { row ->
                if (row.moveToFirst()) {
                    row.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !row.isNull(it) }?.let { name = row.getString(it) }
                    row.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !row.isNull(it) }?.let { modified = row.getLong(it) }
                }
            }
        }
        return name to modified
    }

    /**
     * RN's failure toast (showSettingsErrorToast, 5.2 s) for [operation] (core's mode) that did not land: core's title and words
     * (backupDocumentFailureModel: RN's formatThrownImportError or formatThrownBackupError, core's limit text for a size refusal).
     * On the calling worker; the toast shows on the main thread and the row's spinner stops.
     */
    private fun fail(runtime: CoreHost, operation: String, failure: Throwable) {
        val error = if (failure is TransferTooLarge || failure is BackupOperations.PlanTooLarge || failure is BackupOperations.BudgetTooLarge) "TOO_LARGE" else failure.message ?: ""
        val model = failureModel(runtime, operation, error)
        shell.ui { finish(); shell.showToast(model.first, model.second, "error", durationMs = 5_200) }
    }

    /** Core's failure toast for [operation] and [error]; a failure to build it shows the error's own words (never crashes). */
    private fun failureModel(runtime: CoreHost, operation: String, error: String): Pair<String, String> = runCatching {
        val model = runtime.backupFailureModel(operation, error, DataTransferLimits.MAX_DATA_TRANSFER_BYTES / (1024 * 1024))
        model.getString("title") to model.getString("message")
    }.getOrElse { (words()?.optString("restoreFailed") ?: "") to error.substringAfter(": ") }

    private fun stop(at: String) {
        if (debugProperty("backup_stop") != at) return
        Log.i(CoreHost.TAG, "Native Android backup stop at=$at")
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    private fun finish() { action = null }

    /** [work] on a worker once the validated boot finished (a picker's answer can arrive before it, after process death). */
    private fun whenHosted(work: (CoreHost) -> Unit) {
        val runtime = shell.coreHost() ?: run { shell.ui { whenHosted(work) }; return }
        Thread({ runCatching { work(runtime) }.onFailure { failure ->
            Log.w(CoreHost.TAG, "Data transfer failed ${failureForLog(failure)}")
            shell.ui { finish(); shell.showToast(words()?.optString("restoreFailed"), (failure.message ?: "").substringAfter(": "), "error", durationMs = 5_200) }
        } }, "mindwtr-data-transfer").start()
    }

    // ---- Getting Started ----

    /**
     * RN's Getting Started row (addGettingStartedContent): core's seed under a request UUID made now and the app language core's
     * model gave the row, both journaled with the write; core commits the seed's rows and its receipt together (D1b §6). RN's
     * toasts: ready with Open (the project), not created, or failed. The welcome sheet's handoff card ([openProject]) opens the
     * project at once instead, and its ready toast has no Open.
     */
    fun gettingStarted(openProject: Boolean = false) {
        if (busy) return
        val row = words()?.optJSONObject("gettingStarted") ?: return
        action = "gettingStarted"
        val input = JSONObject().put("requestId", UUID.randomUUID().toString()).put("language", row.getString("language")).toString()
        whenHosted { runtime ->
            val projectId = try {
                runtime.menuCommand("gettingStarted", input).optString("projectId").takeIf { it.isNotEmpty() && it != "null" }
            } catch (failure: Exception) {
                Log.w(CoreHost.TAG, "Getting Started failed ${failureForLog(failure)}")
                shell.ui { finish(); shell.showToast(null, row.getString("failed"), "error") }
                return@whenHosted
            }
            shell.ui {
                finish()
                if (projectId == null) shell.showToast(null, row.getString("notCreated"), "info")
                else if (openProject) { menu.openProjects(projectId); shell.showToast(null, row.getString("ready"), "success") }
                else shell.showToast(null, row.getString("ready"), "success", row.getString("open")) { menu.openProjects(projectId) }
            }
        }
    }
}

/**
 * The folder documents whose write has not closed (RN's export-pending.json): `{ "pending": [{ uri, owner }…] }`, each with the
 * process that listed it. The list is replaced through a synced pending file and a rename; each change reads and writes under
 * one lock, so a start's cleanup and an export never drop each other's entries. The older one-document record `{ uri }` is read
 * too.
 */
private object ExportRecordLock

internal data class ExportEntry(val uri: String, val owner: String? = null) {
    fun json(): JSONObject = JSONObject().put("uri", uri).apply { owner?.let { put("owner", it) } }
}

/** This process's entries: a start's cleanup never touches an export still running in it. */
internal val EXPORT_OWNER: String = UUID.randomUUID().toString()

/** A test seam: runs in [cleanupExportRecord] after it read the list. */
@Volatile internal var exportCleanupPause: () -> Unit = {}

private fun exportEntries(record: File): List<ExportEntry> = runCatching {
    val parsed = JSONObject(record.readText())
    if (parsed.has("uri")) return@runCatching listOf(ExportEntry(uri = parsed.getString("uri")))
    val list = parsed.getJSONArray("pending")
    List(list.length()) { index ->
        when (val entry = list.get(index)) {
            is String -> ExportEntry(uri = entry)
            is JSONObject -> entry.optString("uri").ifEmpty { null }?.let { ExportEntry(it, entry.optString("owner").ifEmpty { null }) }
            else -> null
        }
    }.filterNotNull()
}.getOrDefault(emptyList())

/** [record]'s list after [change]; throws when it cannot be written (the caller then treats its write as failed). */
private fun updateExportRecord(record: File, change: (List<ExportEntry>) -> List<ExportEntry>) {
    synchronized(ExportRecordLock) {
        val next = change(if (record.isFile) exportEntries(record) else emptyList())
        val pending = File(record.parentFile, record.name + ".pending")
        FileOutputStream(pending).use { out ->
            out.write(JSONObject().put("pending", org.json.JSONArray(next.map { it.json() })).toString().toByteArray())
            out.fd.sync()
        }
        if (!pending.renameTo(record)) { pending.delete(); throw IOException("Cannot save the export record") }
    }
}

/** [uri]'s document is gone: deleted now, or confirmed absent. False when the provider refused or cannot say. */
private fun documentGone(uri: String, delete: (String) -> Boolean, exists: (String) -> Boolean?): Boolean =
    runCatching { delete(uri) }.getOrDefault(false) || runCatching { exists(uri) }.getOrNull() == false

/**
 * RN's folder write with its guards. The created document's URI is listed (synced) in [record] right after the folder made it,
 * before the first byte; a list that cannot take it fails the export and the document goes at once. A failed write deletes the
 * document (RN's 206366cce) before the failure goes on; a document whose URI cannot leave the list after its write is deleted
 * too and the export fails, so no later start deletes a backup this one reported as written. An entry leaves the list only once
 * its document is gone. A death between the create and the listing leaves one empty document nobody owns: cleanup never looks
 * a file up by name, so it never deletes another backup that shares it.
 */
internal fun writeExportDocument(record: File, create: () -> String, write: (String) -> Unit,
                                 delete: (String) -> Boolean, exists: (String) -> Boolean?, owner: String = EXPORT_OWNER) {
    val created = create()
    val listed = ExportEntry(uri = created, owner = owner)
    try {
        updateExportRecord(record) { it + listed }
        write(created)
        updateExportRecord(record) { it - listed }
    } catch (failure: Throwable) {
        if (documentGone(created, delete, exists)) runCatching { updateExportRecord(record) { it - listed } }
        throw failure
    }
}

/**
 * At start: each document an earlier process listed (a death mid-export) is deleted by its URI, and its entry leaves once it is
 * gone; one the provider refused stays for the next start. An empty list is left as it is: an export may list its document
 * meanwhile. "deleted", "kept" (some stay), or null (nothing listed).
 */
internal fun cleanupExportRecord(record: File, delete: (String) -> Boolean, exists: (String) -> Boolean?, owner: String = EXPORT_OWNER): String? {
    val listed = synchronized(ExportRecordLock) { if (record.isFile) exportEntries(record) else emptyList() }.filter { it.owner != owner }
    exportCleanupPause()
    if (listed.isEmpty()) return null
    var kept = 0
    for (entry in listed) {
        if (documentGone(entry.uri, delete, exists)) runCatching { updateExportRecord(record) { it - entry } }.onFailure { kept += 1 } else kept += 1
    }
    return if (kept > 0) "kept" else "deleted"
}

/** The transfer limit check (design §4.1): the picked file and the library together, before anything is decoded or parsed. */
internal fun admitTransfer(sourceBytes: Long, libraryBytes: Long) {
    if (sourceBytes + libraryBytes > DataTransferLimits.MAX_DATA_TRANSFER_BYTES) throw TransferTooLarge()
}

/** An export's library bound: the transfer limit, and for a TaskNotes ZIP its own bound. */
internal fun exportLimit(format: String, transferLimit: Long = DataTransferLimits.MAX_DATA_TRANSFER_BYTES): Long =
    if (format == "tasknotes") minOf(transferLimit, DataTransferLimits.MAX_TASKNOTES_EXPORT_BYTES) else transferLimit

/**
 * The staged copy's own bound: the transfer limit, and core's source limit: 128 MiB for a JSON backup, 16 MiB for an [import]'s
 * file (RN's 53128f68a; pass D1c §3.5: once the transfer limit passes 16 MiB, this is the import's only bound before core).
 */
internal fun stageLimit(import: Boolean = false, transferLimit: Long = DataTransferLimits.MAX_DATA_TRANSFER_BYTES): Long =
    minOf(transferLimit, if (import) DataTransferLimits.MAX_IMPORT_SOURCE_BYTES else DataTransferLimits.MAX_BACKUP_SOURCE_BYTES)

/**
 * The picked files' private copies (`no_backup/backup-import`). A copy is live from its creation until its question closes or
 * its operation read it; a start sweeps every other file there, so a death after a pick (or mid-copy) leaves none behind.
 */
internal object StagedCopies {
    private val live = HashSet<String>()

    fun create(dir: File): File = synchronized(this) {
        dir.mkdirs()
        File(dir, UUID.randomUUID().toString()).also { live += it.name }
    }

    fun release(file: File): Unit = synchronized(this) {
        file.delete()
        live -= file.name
    }

    fun sweep(dir: File): Unit = synchronized(this) {
        dir.listFiles().orEmpty().filter { it.name !in live }.forEach { it.delete() }
    }
}

/** A start's leftover result: a committed one's toast model and Undo snapshot, or one that did not commit (core's operation and its error, for core's failure toast). */
internal sealed class Leftover {
    class Result(val model: JSONObject, val undo: String?) : Leftover()
    class Failure(val operation: String, val error: String) : Leftover()
}

/**
 * A start's result record, [present]ed first; it leaves the disk only once [present] calls back (its toast showed), so a death
 * in between shows it again. A committed record whose reply core cannot read goes at once (its data change is already in).
 */
internal fun takeLeftover(ops: BackupOperations, snapshots: File, resultModel: (String) -> JSONObject?, present: (Leftover, shown: () -> Unit) -> Unit) {
    val record = ops.result() ?: return
    val requestId = record.optString("requestId")
    val shown = { ops.clearResult(requestId) }
    val reply = record.optJSONObject("reply")
    if (record.optString("outcome") != "committed" || reply == null) {
        present(Leftover.Failure(record.optString("operation"), record.optString("error").ifEmpty { record.optString("outcome") }), shown)
        return
    }
    val model = runCatching { resultModel(reply.toString()) }.getOrNull() ?: return shown()
    present(Leftover.Result(model, record.optString("undoSnapshot").takeIf { it.isNotEmpty() && File(snapshots, it).isFile }), shown)
}

/**
 * A staged pick to its question: admitted with the library first (an oversized copy is never read), then core's preview
 * ([inspect], which reads the copy through the data channel). The copy stays only for a valid preview; a refusal, an invalid
 * file or a failure releases it.
 */
internal fun previewStaged(file: File, libraryBytes: Long, inspect: (File) -> JSONObject): JSONObject {
    try {
        admitTransfer(file.length(), libraryBytes)
        val preview = inspect(file)
        if (!preview.optBoolean("valid")) StagedCopies.release(file)
        return preview
    } catch (failure: Throwable) {
        StagedCopies.release(file)
        throw failure
    }
}

private const val MIB = 1024L * 1024

/**
 * The native heap (QuickJS allocates there) and the Java heap at their highest while one Data operation runs, sampled every
 * 500 ms on its own thread until [stop] (pass D1c §3.6).
 */
internal class HeapPeak {
    private val started = System.nanoTime()
    @Volatile private var native = 0L
    @Volatile private var java = 0L
    @Volatile private var running = true
    private val sampler = Thread({
        while (running) {
            sample()
            try { Thread.sleep(500) } catch (_: InterruptedException) { break }
        }
    }, "mindwtr-heap-peak").apply { isDaemon = true; start() }

    private fun sample() {
        native = maxOf(native, android.os.Debug.getNativeHeapAllocatedSize())
        val runtime = Runtime.getRuntime()
        java = maxOf(java, runtime.totalMemory() - runtime.freeMemory())
    }

    /** The peaks in whole MiB, after one last sample. */
    fun stop(): Pair<Long, Long> {
        running = false
        sampler.interrupt()
        runCatching { sample() }
        return native / MIB to java / MIB
    }

    fun seconds(): Long = (System.nanoTime() - started) / 1_000_000_000
}

/** A picked file, or it with the library, over the measured transfer limit (design §4.1). */
internal class TransferTooLarge : IOException("The selected file is too large")

/** [input] into [file], synced; refuses once it passes [limit] bytes (the caller deletes [file]). */
internal fun copyBounded(input: InputStream, file: File, limit: Long) {
    var total = 0L
    FileOutputStream(file).use { out ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > limit) throw TransferTooLarge()
            out.write(buffer, 0, read)
        }
        out.fd.sync()
    }
}
