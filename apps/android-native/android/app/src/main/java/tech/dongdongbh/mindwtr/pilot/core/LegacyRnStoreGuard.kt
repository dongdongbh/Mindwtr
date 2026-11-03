package tech.dongdongbh.mindwtr.pilot.core

import android.util.Log
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONObject
import java.io.File


internal object LegacyRnStoreGuard {
    private const val DATABASE = "files/SQLite/mindwtr.db"
    private const val ASYNC_STORAGE = "databases/RKStorage"

    private const val RN_STATE_CHECKPOINT = "files/SQLite/RKStorage.prewrite"
    private const val JSON_AHEAD = "mindwtr-data:json-ahead-of-sqlite"
    private const val RECONCILED = "mindwtr-data:sqlite-json-reconcile-v1"
    private const val BACKUP_VERSION = "mindwtr-data:startup-backup-version"

    private const val LANGUAGE = "mindwtr-language"

    private const val THEME = "@mindwtr_theme"

    private val BACKUP_NAMES = listOf("mindwtr-data", "focus-gtd-data", "gtd-todo-data", "gtd-data")
    private const val MAX_BACKUP_BYTES = 64L * 1024 * 1024

    private val PLATFORM_FILES = setOf("profileInstalled", "profileinstaller_profileWrittenFor_lastUpdateTime.dat")
    private val MESSAGES = mapOf(
        "database-missing" to "The previous app version's database is missing, so this build will not start an empty one",
        "async-storage-unreadable" to "Cannot read the previous app version's saved state",
        "json-too-large" to "The previous app version's backup is too large to import",
        "database-unreadable" to "The previous app version's database failed its integrity check",
    )


    class Opened(val database: File, val bootState: String, val backup: String, val language: String?, val theme: String?, val preflight: Boolean)


    fun preflightNeeded(jsonAhead: Boolean, reconciled: Boolean, backupPresent: Boolean, databaseExists: Boolean): Boolean =
        jsonAhead || (backupPresent && (!reconciled || !databaseExists))

    private class RnState(
        val jsonAhead: Boolean, val reconciled: Boolean, val backupVersion: String?, val backupBytes: Long, val backup: String?,
        val language: String? = null,
        val theme: String? = null,
    )


    fun requireClear(dataDir: File, scratch: File): Opened {
        val database = File(dataDir, DATABASE)
        val asyncStorage = File(dataDir, ASYNC_STORAGE)
        var state = RnState(false, false, null, 0, null)
        val blocked = run {
            if (asyncStorage.exists()) {

                state = runCatching { readState(asyncStorage, scratch) }.getOrNull() ?: return@run "async-storage-unreadable"
                if (state.backupBytes > MAX_BACKUP_BYTES) return@run "json-too-large"
            }
            if (!database.exists()) return@run if (state.backup == null && hasRnState(dataDir, asyncStorage)) "database-missing" else null


            val intact = runCatching {
                queryCopy(database, scratch) { copy ->
                    copy.prepare("PRAGMA quick_check").use { it.step() && it.getText(0) == "ok" && !it.step() }
                }
            }
            if (intact.getOrDefault(false)) null else "database-unreadable"
        }
        Log.i(CoreHost.TAG, "Native Android legacy store guard releaseCheck=v1.3.3/native-android-legacy-json-ahead-guard " +
            "outcome=${if (blocked == null) "clear" else "blocked"}${blocked?.let { " reason=$it" } ?: ""}")
        check(blocked == null) { MESSAGES.getValue(blocked!!) }
        val preflight = preflightNeeded(state.jsonAhead, state.reconciled, state.backup != null, database.exists())


        database.parentFile!!.mkdirs()


        checkpointRnState(dataDir)
        val bootState = JSONObject()
            .put("jsonAhead", state.jsonAhead)
            .put("reconciled", state.reconciled)
            .put("backupVersion", state.backupVersion ?: JSONObject.NULL)
            .put("backupPresent", state.backup != null)
        return Opened(database, bootState.toString(), state.backup ?: "", state.language, state.theme, preflight)
    }


    private fun readState(asyncStorage: File, scratch: File): RnState = queryCopy(asyncStorage, scratch) { copy ->
        val names = BACKUP_NAMES + listOf(JSON_AHEAD, RECONCILED, BACKUP_VERSION, LANGUAGE, THEME)
        val sizes = HashMap<String, Long>()
        copy.prepare("SELECT key, length(CAST(value AS BLOB)) FROM catalystLocalStorage " +
            "WHERE value IS NOT NULL AND key IN (${names.joinToString(", ") { "?" }})").use { statement ->
            names.forEachIndexed { index, name -> statement.bindText(index + 1, name) }
            while (statement.step()) sizes[statement.getText(0)] = statement.getLong(1)
        }
        val value = { name: String ->
            copy.prepare("SELECT value FROM catalystLocalStorage WHERE key = ?").use { statement ->
                statement.bindText(1, name)
                check(statement.step()) { "AsyncStorage row vanished" }
                statement.getText(0)
            }
        }


        val backupName = BACKUP_NAMES.firstOrNull { it in sizes }
        val backupBytes = backupName?.let { sizes.getValue(it) } ?: 0
        RnState(
            jsonAhead = JSON_AHEAD in sizes,
            reconciled = RECONCILED in sizes,
            backupVersion = if (BACKUP_VERSION in sizes) value(BACKUP_VERSION) else null,
            backupBytes = backupBytes,
            backup = backupName?.takeIf { backupBytes <= MAX_BACKUP_BYTES }?.let(value),
            language = if (LANGUAGE in sizes) value(LANGUAGE) else null,
            theme = if (THEME in sizes) value(THEME) else null,
        )
    }


    fun commitRnState(dataDir: File, clearJsonAhead: Boolean, setReconciled: Boolean) {
        val asyncStorage = File(dataDir, ASYNC_STORAGE)
        check(asyncStorage.exists()) { "The previous app version's saved state is missing" }
        ensureRnStateCheckpoint(asyncStorage, File(dataDir, RN_STATE_CHECKPOINT))
        BundledSQLiteDriver().open(asyncStorage.path).use { connection ->
            connection.prepare("PRAGMA synchronous = FULL").use { it.step() }
            connection.prepare("BEGIN IMMEDIATE").use { it.step() }
            try {

                if (clearJsonAhead) {
                    connection.prepare("DELETE FROM catalystLocalStorage WHERE key = ?").use { it.bindText(1, JSON_AHEAD); it.step() }
                }
                if (setReconciled) {
                    connection.prepare("INSERT OR REPLACE INTO catalystLocalStorage VALUES (?, ?)").use {
                        it.bindText(1, RECONCILED)
                        it.bindText(2, "1")
                        it.step()
                    }
                }
                connection.prepare("COMMIT").use { it.step() }
            } catch (error: Throwable) {
                runCatching { connection.prepare("ROLLBACK").use { it.step() } }
                throw error
            }
        }
    }


    fun checkpointRnState(dataDir: File) {
        val asyncStorage = File(dataDir, ASYNC_STORAGE)
        if (asyncStorage.exists()) ensureRnStateCheckpoint(asyncStorage, File(dataDir, RN_STATE_CHECKPOINT))
    }

    private fun ensureRnStateCheckpoint(asyncStorage: File, checkpoint: File) {
        if (!checkpoint.exists()) {
            val partial = File(checkpoint.path + ".building")
            partial.deleteRecursively()
            check(partial.mkdirs()) { "Cannot create the RN state checkpoint" }
            try {
                for (suffix in listOf("", "-wal", "-journal", "-shm")) {
                    val source = File(asyncStorage.path + suffix)
                    if (source.exists()) syncFile(source.copyTo(File(partial, source.name)))
                }
                syncDirectory(partial)
                check(partial.renameTo(checkpoint)) { "Cannot promote the RN state checkpoint" }
            } catch (error: Throwable) {
                partial.deleteRecursively()
                throw error
            }
        }
        syncDirectory(checkpoint.parentFile!!)
    }

    private fun hasRnState(dataDir: File, asyncStorage: File): Boolean =
        asyncStorage.exists() ||
            File(dataDir, "files").walk().any { it.isFile && it.name !in PLATFORM_FILES } ||
            File(dataDir, "shared_prefs").walk().any { it.isFile }


    private fun <T> queryCopy(file: File, scratch: File, query: (SQLiteConnection) -> T): T {
        scratch.deleteRecursively()
        check(scratch.mkdirs()) { "Cannot create the guard's scratch folder" }
        try {

            for (suffix in listOf("", "-wal", "-journal")) {
                val source = File(file.path + suffix)
                if (source.exists()) source.copyTo(File(scratch, file.name + suffix))
            }
            return BundledSQLiteDriver().open(File(scratch, file.name).path).use(query)
        } finally {
            scratch.deleteRecursively()
        }
    }
}
