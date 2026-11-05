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


object DataTransferLimits {


    internal const val LIMIT_BYTES = 15L * 1024 * 1024

    const val MAX_BACKUP_SOURCE_BYTES = 128L * 1024 * 1024

    const val MAX_IMPORT_SOURCE_BYTES = 16L * 1024 * 1024


    const val MAX_TASKNOTES_EXPORT_BYTES = 12L * 1024 * 1024


    val MAX_DATA_TRANSFER_BYTES: Long get() = debugProperty("transfer_limit_mb").toLongOrNull()?.takeIf { it > 0 }?.let { it * 1024 * 1024 } ?: LIMIT_BYTES


    val MAX_PLAN_BYTES: Long get() = 2 * MAX_DATA_TRANSFER_BYTES + 1024 * 1024
}


internal fun dataRowsBusy(action: String?, syncing: Boolean): Boolean = action != null || syncing


internal val DATA_COMMANDS = setOf("gettingStarted")


private const val BACKUP_MIME = "application/json"

class DataTransferModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val app get() = shell.getApplication<Application>()
    private val resolver: ContentResolver get() = app.contentResolver
    private val snapshots get() = File(app.filesDir, "snapshots")
    private val staging get() = File(app.noBackupFilesDir, "backup-import")
    private val exportPending get() = File(app.noBackupFilesDir, "export-pending.json")

    private val rnExportPending get() = File(app.filesDir, "export-pending.json")
    private fun deleteDocument(uri: String): Boolean = try {
        DocumentsContract.deleteDocument(resolver, Uri.parse(uri))
    } catch (_: java.io.FileNotFoundException) { true }

    private fun documentExists(uri: String): Boolean? = try {
        resolver.query(Uri.parse(uri), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() }
    } catch (_: java.io.FileNotFoundException) { false } catch (_: Exception) { null }
    val operations get() = BackupOperations(File(app.noBackupFilesDir, "backup-operations"), snapshots, maxPlanBytes = DataTransferLimits.MAX_PLAN_BYTES)


    var action by mutableStateOf<String?>(null); private set


    var question by mutableStateOf<JSONObject?>(null); private set

    var launch by mutableStateOf<String?>(null); private set

    var pickTypes: Array<String> = arrayOf(BACKUP_MIME); private set

    var share by mutableStateOf<Pair<File, String>?>(null); private set

    private var exportFile: JSONObject? = null
    @Volatile private var noUndoAnswer: CompletableFuture<Boolean>? = null


    val busy get() = dataRowsBusy(action, shell.syncActive)

    fun launched() { launch = null }

    private fun view() = menu.settings.page?.takeIf { it.screen == "data" }?.view
    private fun words() = view()?.optJSONObject("backup")

    private fun importRow(key: String): JSONObject? = view()?.optJSONObject("importData")?.optJSONArray("rows")?.let { rows ->
        (0 until rows.length()).map(rows::getJSONObject).firstOrNull { it.getString("key") == key }
    }


    fun export(format: String) {
        if (busy) return
        val words = words() ?: return
        val failed = words.getString(when (format) { "csv" -> "csvFailed"; "tasknotes" -> "tasknotesFailed"; else -> "failed" })
        val running = if (format == "json") "export" else "export:$format"
        action = running
        shell.anyTime({ runtime ->

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


    fun pickBackup(mode: String) {
        if (busy) return
        action = mode
        saved["dataPick"] = mode
        saved.remove<String>("dataPickMode")
        pickTypes = arrayOf(BACKUP_MIME)
        launch = "json"
    }


    fun pickImport(key: String) {
        if (busy) return
        val row = importRow(key) ?: return
        action = "import:$key"
        saved["dataPick"] = "import:$key"

        saved["dataPickMode"] = row.getString("mode")
        pickTypes = row.getJSONArray("mimeTypes").let { types -> Array(types.length()) { types.getString(it) } }
        launch = "json"
    }


    fun backupPicked(uri: Uri?) {
        val mode = saved.get<String>("dataPick")
        val importMode = saved.get<String>("dataPickMode")?.takeIf { mode?.startsWith("import:") == true }
        saved.remove<String>("dataPick")
        saved.remove<String>("dataPickMode")
        if (uri == null || mode == null || mode.startsWith("import:") && importMode == null) { action = null; return }
        action = mode

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

                    shell.showToast(preview.getString("errorTitle"), preview.getString("errorMessage"), "warning", durationMs = 4_200)
                } else {
                    question = JSONObject().put("kind", "confirm").put("model", preview).put("mode", mode)
                        .put("stage", stage.file.name).put("metadata", stage.metadata).apply { importMode?.let { put("importMode", it) } }
                }
            }
        }
    }


    fun cancel() {

        if (question?.optString("kind") == "noUndo") { question = null; noUndoAnswer?.complete(false); return }
        question?.optString("stage")?.takeIf { it.isNotEmpty() }?.let { StagedCopies.release(File(staging, it)) }
        question = null
        finish()
    }


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


    fun askSnapshot(name: String, undo: Boolean) {
        if (busy) return
        whenHosted { runtime ->
            val model = runtime.backupSnapshotModel(name, if (undo) "undo" else "restore")
            shell.ui { question = JSONObject().put("kind", "snapshot").put("model", model).put("name", name).put("undo", undo) }
        }
    }


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
                val sourceBytes = admitBackupSource(source, base64)
                val libraryBytes = runtime.databaseBytes()
                sourceMiB = sourceBytes / MIB; libraryMiB = libraryBytes / MIB
                admitTransfer(sourceBytes, libraryBytes)
                val name = snapshot ?: RecoverySnapshots.nextName(snapshots, Date())

                ops.reserve(requestId, name)
                val recoveryFile = if (mode == "restore") null else ops.pendingSnapshot(requestId)


                val prepared = try {
                    runtime.backupPrepare(source, base64, JSONObject().put("requestId", requestId).put("mode", mode).put("snapshotName", name)
                        .put("metadata", metadata)
                        .put("admission", JSONObject().put("sourceBytes", sourceBytes).put("maxTransferBytes", DataTransferLimits.MAX_DATA_TRANSFER_BYTES)).toString(),
                        recoveryFile, ops.pendingPlan(requestId), DataTransferLimits.MAX_PLAN_BYTES)
                } finally { staged?.let(StagedCopies::release) }


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

                val reference = ops.publish(requestId, mode, plan, name, recovery, budgetMs = runtime.budgetMs(sourceBytes + libraryBytes + plan.bytes)) { stop("mid-plan") }
                journaled = true
                val reply = runtime.backupCommit(reference, name)
                val result = runtime.backupResultModel(reply.toString())
                RecoverySnapshots.prune(snapshots, ops::protectedNames)
                outcome = "committed"
                shell.ui { finish(); showResult(result, if (mode == "restore") null else name) { ops.clearResult(requestId) } }
            } catch (failure: Throwable) {
                staged?.let(StagedCopies::release)

                if (!journaled) runCatching { ops.discard(requestId); ops.pendingSnapshot(requestId).delete() }
                Log.w(CoreHost.TAG, "Backup operation failed mode=$mode ${failureForLog(failure)}")
                fail(runtime, mode, failure)
            } finally {

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


    private fun askNoUndo(words: JSONObject): Boolean {
        val answer = CompletableFuture<Boolean>()
        shell.ui { noUndoAnswer = answer; question = JSONObject().put("kind", "noUndo").put("model", words) }
        val continued = runCatching { answer.get() }.getOrDefault(false)
        shell.ui { noUndoAnswer = null; if (question?.optString("kind") == "noUndo") question = null }
        return continued
    }


    private fun showResult(result: JSONObject, undo: String?, shown: () -> Unit) {
        val undoLabel = result.optString("undoLabel").takeIf { it.isNotEmpty() && undo != null }
        shell.showToast(result.getString("title"), result.getString("message"), "success", undoLabel,
            if (result.isNull("durationMs")) null else result.getLong("durationMs")) { undo?.let { askSnapshot(it, undo = true) } }
        Thread { runCatching(shown) }.start()
    }


    fun leftover() = whenHosted { runtime ->
        if (BuildConfig.DEBUG && debugProperty("channel_roundtrip") == "1") channelRoundTrip(runtime)
        runCatching { cleanupInterruptedExport(runtime) }.onFailure { Log.w(CoreHost.TAG, "Interrupted export cleanup failed ${failureForLog(it)}") }
        runCatching { StagedCopies.sweep(staging) }.onFailure { Log.w(CoreHost.TAG, "Staged copy sweep failed ${failureForLog(it)}") }
        var found = "none"
        takeLeftover(operations, snapshots, { runtime.backupResultModel(it) }) { leftover, shown ->
            found = if (leftover is Leftover.Result) "result" else "failure"
            when (leftover) {
                is Leftover.Result -> {


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


        if (BuildConfig.DEBUG) Log.i(CoreHost.TAG, "Native Android data leftover done result=$found")
    }


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


    private fun inspectRnExport(uri: String): RnExportFile? {
        val document = Uri.parse(uri)
        val row = try {
            resolver.query(document, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                if (!row.moveToFirst()) null
                else (row.getString(0) ?: "") to row.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !row.isNull(it) }?.let(row::getLong)
            }
        } catch (_: java.io.FileNotFoundException) { return RnExportFile.GONE }

        if (row == null) return try { resolver.openInputStream(document)?.close(); null } catch (_: java.io.FileNotFoundException) { RnExportFile.GONE }
        return inspectRnExportStream(row.first, row.second) { resolver.openInputStream(document) ?: throw IOException("The backup cannot be read") }
    }


    private fun cleanupInterruptedExport(runtime: CoreHost) {
        for (outcome in cleanupRnExportRecord(rnExportPending, ::deleteDocument, ::documentExists, ::inspectRnExport)) {
            runtime.logLine("Native Android stale React Native export record handled releaseCheck=v1.3.8/android-rn-export-cleanup", JSONObject().put("releaseCheck", "v1.3.8/android-rn-export-cleanup").put("outcome", outcome))
        }
        val outcome = cleanupExportRecord(exportPending, ::deleteDocument, ::documentExists) ?: return
        runtime.logLine("Native Android interrupted export removed releaseCheck=v1.3.5/android-export-cleanup", JSONObject().put("releaseCheck", "v1.3.5/android-export-cleanup").put("outcome", outcome))
    }


    private class Stage(val file: File, val metadata: JSONObject)


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


    private fun fail(runtime: CoreHost, operation: String, failure: Throwable) {
        val error = if (failure is TransferTooLarge || failure is BackupOperations.PlanTooLarge || failure is BackupOperations.BudgetTooLarge) "TOO_LARGE" else failure.message ?: ""
        val model = failureModel(runtime, operation, error)
        shell.ui { finish(); shell.showToast(model.first, model.second, "error", durationMs = 5_200) }
    }


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


    private fun whenHosted(work: (CoreHost) -> Unit) {
        val runtime = shell.coreHost() ?: run { shell.ui { whenHosted(work) }; return }
        Thread({ runCatching { work(runtime) }.onFailure { failure ->
            Log.w(CoreHost.TAG, "Data transfer failed ${failureForLog(failure)}")
            shell.ui { finish(); shell.showToast(words()?.optString("restoreFailed"), (failure.message ?: "").substringAfter(": "), "error", durationMs = 5_200) }
        } }, "mindwtr-data-transfer").start()
    }


    fun gettingStarted(openProject: Boolean = false) {
        if (busy) return

        val row = words()?.optJSONObject("gettingStarted")
            ?: menu.settings.page?.takeIf { it.screen == "sync" }?.view?.optJSONObject("gettingStarted") ?: return
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

                else if (openProject) { menu.whenIdle { menu.openProjects(projectId) }; shell.showToast(null, row.getString("ready"), "success") }
                else shell.showToast(null, row.getString("ready"), "success", row.getString("open")) { menu.whenIdle { menu.openProjects(projectId) } }
            }
        }
    }
}


private object ExportRecordLock

internal data class ExportEntry(val uri: String, val owner: String? = null) {
    fun json(): JSONObject = JSONObject().put("uri", uri).apply { owner?.let { put("owner", it) } }
}


internal val EXPORT_OWNER: String = UUID.randomUUID().toString()


@Volatile internal var exportCleanupPause: () -> Unit = {}

private fun exportEntries(record: File): List<ExportEntry> = exportEntriesOrNull(record) ?: emptyList()


private fun exportEntriesOrNull(record: File): List<ExportEntry>? = if (!record.isFile) null else runCatching {
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
}.getOrNull()


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


private fun documentGone(uri: String, delete: (String) -> Boolean, exists: (String) -> Boolean?): Boolean =
    runCatching { delete(uri) }.getOrDefault(false) || runCatching { exists(uri) }.getOrNull() == false


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


internal enum class RnExportFile { GONE, TRUNCATED, COMPLETE, UNCHECKED }


private val RN_EXPORT_NAME = Regex("""^mindwtr-backup-.*\.(json|csv|zip)$""", RegexOption.IGNORE_CASE)


internal const val RN_EXPORT_CHECK_BYTES = 64L * 1024 * 1024


internal fun inspectRnExportStream(name: String, size: Long?, limit: Long = RN_EXPORT_CHECK_BYTES, open: () -> InputStream): RnExportFile? {
    val kind = RN_EXPORT_NAME.find(name)?.groupValues?.get(1)?.lowercase() ?: return RnExportFile.UNCHECKED
    if (size == null) return null
    if (size > limit) return RnExportFile.UNCHECKED
    return try {
        open().use { input ->
            val counted = CountingInput(input)
            val whole = if (kind == "zip") zipEnds(counted) else textEnds(counted, csv = kind == "csv")

            counted.skipRest()
            if (counted.count != size) null else if (whole) RnExportFile.COMPLETE else RnExportFile.TRUNCATED
        }
    } catch (_: IOException) { null }
}


private class CountingInput(private val input: InputStream) {
    var count = 0L; private set
    private val buffer = ByteArray(64 * 1024)
    fun read(into: ByteArray): Int = input.read(into).also { if (it > 0) count += it }
    fun skipRest() { while (read(buffer) >= 0) Unit }
    fun stream(): InputStream = object : InputStream() {
        override fun read(): Int = input.read().also { if (it >= 0) count += 1 }
        override fun read(b: ByteArray, off: Int, len: Int): Int = input.read(b, off, len).also { if (it > 0) count += it }
    }
}


private fun textEnds(input: CountingInput, csv: Boolean): Boolean {
    val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
    val reader = java.io.InputStreamReader(input.stream(), decoder).buffered(64 * 1024)
    var first = true
    var quoted = false
    var escaped = false
    var depth = 0
    var closed = false
    var columns = -1
    var fields = 1
    var rowEmpty = true
    try {
        while (true) {
            val code = reader.read()
            if (code < 0) break
            val char = code.toChar()
            if (first) { first = false; if (char == '\uFEFF') continue }
            if (!csv) {
                when {

                    closed -> if (!char.isWhitespace() && char != '\u0000') return false
                    quoted -> if (escaped) escaped = false else if (char == '\\') escaped = true else if (char == '"') quoted = false
                    char == '"' -> quoted = true
                    char == '{' || char == '[' -> depth += 1
                    char == '}' || char == ']' -> { depth -= 1; if (depth == 0) closed = true; if (depth < 0) return false }
                    depth == 0 && !char.isWhitespace() -> return false
                }
                continue
            }
            if (quoted) { if (char == '"') quoted = false; continue }
            when (char) {
                '"' -> quoted = true
                ',' -> fields += 1
                '\n' -> { if (columns < 0) columns = fields else if (fields != columns) return false; fields = 1; rowEmpty = true; continue }
            }
            if (char != '\r') rowEmpty = false
        }
    } catch (_: java.nio.charset.CharacterCodingException) { return false }

    if (!csv) return closed
    if (quoted) return false
    if (rowEmpty) return columns > 1
    return (if (columns < 0) fields else columns) > 1 && (columns < 0 || fields == columns)
}


private fun zipEnds(input: CountingInput): Boolean {
    val keep = 22 + 0xffff
    val tail = ByteArray(keep)
    var filled = 0
    val chunk = ByteArray(64 * 1024)
    while (true) {
        val read = input.read(chunk)
        if (read < 0) break
        val shift = maxOf(0, filled + read - keep)
        if (shift > 0) { System.arraycopy(tail, shift, tail, 0, filled - shift); filled -= shift }
        System.arraycopy(chunk, 0, tail, filled, read)
        filled += read
    }
    val base = input.count - filled
    fun u16(at: Int) = (tail[at].toInt() and 0xff) or ((tail[at + 1].toInt() and 0xff) shl 8)
    fun u32(at: Int) = u16(at).toLong() or (u16(at + 2).toLong() shl 16)
    for (at in filled - 22 downTo 0) {
        if (u32(at) != 0x06054b50L || at + 22 + u16(at + 20) != filled) continue
        val size = u32(at + 12)
        val offset = u32(at + 16)


        if (offset == 0xffffffffL || size == 0xffffffffL || (at >= 20 && u32(at - 20) == 0x07064b50L)) return true
        if (offset + size != base + at) continue
        val local = offset - base

        if (size == 0L || local < 0 || u32(local.toInt()) == 0x02014b50L) return true
    }
    return false
}


internal fun cleanupRnExportRecord(record: File, delete: (String) -> Boolean, exists: (String) -> Boolean?,
                                   inspect: (String) -> RnExportFile?): List<String> {
    val pending = File(record.parentFile, record.name + ".pending")
    if (!record.isFile && !pending.isFile) return emptyList()
    val listed = (exportEntriesOrNull(pending) ?: exportEntriesOrNull(record) ?: emptyList()).filter { it.uri.startsWith("content://") }
    val left = mutableListOf<ExportEntry>()
    val outcomes = listed.map { entry ->
        val (settled, outcome) = when (runCatching { inspect(entry.uri) }.getOrNull()) {
            RnExportFile.GONE -> true to "deleted"
            RnExportFile.TRUNCATED -> documentGone(entry.uri, delete, exists).let { gone -> gone to if (gone) "deleted" else "kept" }
            RnExportFile.COMPLETE -> true to "kept-complete"
            RnExportFile.UNCHECKED -> true to "kept-unchecked"
            null -> false to "kept"
        }
        if (!settled) left += entry
        outcome
    }
    if (left.isEmpty()) {
        pending.delete()
        record.delete()
    } else if (left != exportEntriesOrNull(record) || pending.isFile) {
        runCatching { updateExportRecord(record) { left } }
    }
    return outcomes
}


internal fun admitTransfer(sourceBytes: Long, libraryBytes: Long) {
    if (sourceBytes + libraryBytes > DataTransferLimits.MAX_DATA_TRANSFER_BYTES) throw TransferTooLarge()
}


internal fun exportLimit(format: String, transferLimit: Long = DataTransferLimits.MAX_DATA_TRANSFER_BYTES): Long =
    if (format == "tasknotes") minOf(transferLimit, DataTransferLimits.MAX_TASKNOTES_EXPORT_BYTES) else transferLimit


internal fun stageLimit(import: Boolean = false, transferLimit: Long = DataTransferLimits.MAX_DATA_TRANSFER_BYTES): Long =
    minOf(transferLimit, if (import) DataTransferLimits.MAX_IMPORT_SOURCE_BYTES else DataTransferLimits.MAX_BACKUP_SOURCE_BYTES)


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


internal sealed class Leftover {
    class Result(val model: JSONObject, val undo: String?) : Leftover()
    class Failure(val operation: String, val error: String) : Leftover()
}


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


    fun stop(): Pair<Long, Long> {
        running = false
        sampler.interrupt()
        runCatching { sample() }
        return native / MIB to java / MIB
    }

    fun seconds(): Long = (System.nanoTime() - started) / 1_000_000_000
}


internal class TransferTooLarge : IOException("The selected file is too large")


internal fun admitBackupSource(source: File, base64: Boolean): Long {
    check(source.isFile) { "Snapshot file not found." }
    val length = source.length()
    if (!base64 && length > DataTransferLimits.MAX_BACKUP_SOURCE_BYTES) throw TransferTooLarge()
    return length
}


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
