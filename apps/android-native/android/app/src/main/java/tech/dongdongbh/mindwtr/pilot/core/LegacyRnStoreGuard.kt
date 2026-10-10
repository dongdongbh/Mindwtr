package tech.dongdongbh.mindwtr.pilot.core

import android.util.Log
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONObject
import java.io.File

/**
 * The only code that touches the React Native app's storage.
 *
 * [requireClear] decides whether this build may open the RN database, before
 * anything opens it, and reads what RN left in AsyncStorage for the JS host,
 * which imports it with core's `planLegacyJsonImport`. It refuses when:
 *
 * - the database is missing, RN left other state, and AsyncStorage holds no
 *   JSON backup: opening the path would create an empty database and show a
 *   blank Inbox (with a backup, the host migrates it as RN would);
 * - AsyncStorage cannot be read, or its JSON backup is over [MAX_BACKUP_BYTES];
 * - the database cannot be read, or fails `quick_check`.
 *
 * It never opens the originals with SQLite to read them. Even a read-only
 * connection writes beside a WAL database: it creates `-wal` and `-shm` when
 * they are missing and updates read marks in `-shm`. A read-write connection
 * that fails a check can also checkpoint the WAL into the file when it closes.
 * So the guard copies the bytes and queries the copy.
 *
 * Once the guard passes it copies `RKStorage` byte for byte, before anything
 * opens it: any open, a read included, can checkpoint RN's WAL into the file
 * and drop the sidecars when it closes. [commitRnState] makes RN's own startup
 * change after the import is saved and read back.
 *
 * It assumes no concurrent writer. Replacing the package kills the RN process,
 * and this process owns exactly one host, so the files cannot change while the
 * guard copies them or while the host imports.
 */
internal object LegacyRnStoreGuard {
    private const val DATABASE = "files/SQLite/mindwtr.db"
    private const val ASYNC_STORAGE = "databases/RKStorage"
    /** Beside the database's `.prewrite`. The first copy is kept forever. */
    private const val RN_STATE_CHECKPOINT = "files/SQLite/RKStorage.prewrite"
    private const val JSON_AHEAD = "mindwtr-data:json-ahead-of-sqlite"
    private const val RECONCILED = "mindwtr-data:sqlite-json-reconcile-v1"
    private const val BACKUP_VERSION = "mindwtr-data:startup-backup-version"
    /** RN's device-local language choice (core's LANGUAGE_STORAGE_KEY); core's setLanguage validates it. */
    private const val LANGUAGE = "mindwtr-language"
    /** RN's device-local theme choice (theme-context.tsx THEME_STORAGE_KEY); core classifies it. */
    private const val THEME = "@mindwtr_theme"
    /** RN's `getLegacyJson` order: the first present name holds the backup. */
    private val BACKUP_NAMES = listOf("mindwtr-data", "focus-gtd-data", "gtd-todo-data", "gtd-data")
    private const val MAX_BACKUP_BYTES = 64L * 1024 * 1024
    /** androidx profileinstaller writes these into any app's files/; they are not RN state. */
    private val PLATFORM_FILES = setOf("profileInstalled", "profileinstaller_profileWrittenFor_lastUpdateTime.dat")
    private val MESSAGES = mapOf(
        "database-missing" to "The previous app version's database is missing, so this build will not start an empty one",
        "async-storage-unreadable" to "Cannot read the previous app version's saved state",
        "json-too-large" to "The previous app version's backup is too large to import",
        "database-unreadable" to "The previous app version's database failed its integrity check",
    )

    /** The RN database, and what RN left in AsyncStorage: [bootState] as JSON, the backup text ("" when absent), RN's language and theme. */
    class Opened(val database: File, val bootState: String, val backup: String, val language: String?, val theme: String?)

    private class RnState(
        val jsonAhead: Boolean, val reconciled: Boolean, val backupVersion: String?, val backupBytes: Long, val backup: String?,
        val language: String? = null,
        val theme: String? = null,
    )

    /** Returns the RN database to open and the RN state, or throws before anything has opened the database. */
    fun requireClear(dataDir: File, scratch: File): Opened {
        val database = File(dataDir, DATABASE)
        val asyncStorage = File(dataDir, ASYNC_STORAGE)
        var state = RnState(false, false, null, 0, null)
        val blocked = run {
            if (asyncStorage.exists()) {
                // A copy without the RN table fails here and counts as unreadable.
                state = runCatching { readState(asyncStorage, scratch) }.getOrNull() ?: return@run "async-storage-unreadable"
                if (state.backupBytes > MAX_BACKUP_BYTES) return@run "json-too-large"
            }
            if (!database.exists()) return@run if (state.backup == null && hasRnState(dataDir, asyncStorage)) "database-missing" else null
            // ponytail: copies the whole database on every boot. Skip it once a native-owned
            // marker proves the last shutdown was clean.
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
        // A fresh install, or a missing database with a JSON backup to migrate, gets here without
        // the file. SQLite creates the file, not its folder.
        database.parentFile!!.mkdirs()
        // RN's own copy before the host opens RKStorage (RnKeyValue's first read, the About keys, the alarms): taken at a first
        // write instead, it could miss the WAL an earlier read checkpointed away.
        checkpointRnState(dataDir)
        val bootState = JSONObject()
            .put("jsonAhead", state.jsonAhead)
            .put("reconciled", state.reconciled)
            .put("backupVersion", state.backupVersion ?: JSONObject.NULL)
            .put("backupPresent", state.backup != null)
        return Opened(database, bootState.toString(), state.backup ?: "", state.language, state.theme)
    }

    /** The AsyncStorage reads RN's startup makes. The backup is passed on as text and never parsed here. */
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
        // ponytail: reads the backup text on every boot, because RN's empty-database path may
        // need it. Skip it once a native-owned record proves the import is done.
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

    /**
     * Makes the AsyncStorage change RN's own startup makes after its import:
     * deletes the json-ahead marker and/or sets the one-time reconcile flag to
     * '1', in one transaction. Nothing else in `RKStorage` changes, and the JSON
     * backup is never rewritten. The JS host calls this only after it saved the
     * import and read it back.
     *
     * First, once per install, it copies `RKStorage` and its `-wal`, `-journal`
     * and `-shm` byte for byte into [RN_STATE_CHECKPOINT] and syncs them. The RN
     * process is not running after a package replace, so the byte copy is
     * consistent.
     */
    fun commitRnState(dataDir: File, clearJsonAhead: Boolean, setReconciled: Boolean) {
        val asyncStorage = File(dataDir, ASYNC_STORAGE)
        check(asyncStorage.exists()) { "The previous app version's saved state is missing" }
        ensureRnStateCheckpoint(asyncStorage, File(dataDir, RN_STATE_CHECKPOINT))
        BundledSQLiteDriver().open(asyncStorage.path).use { connection ->
            connection.prepare("PRAGMA synchronous = FULL").use { it.step() }
            connection.prepare("BEGIN IMMEDIATE").use { it.step() }
            try {
                // AsyncStorage's own removeItem and setItem statements.
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

    /**
     * The byte copy of `RKStorage` (once per install, the first copy kept): [requireClear] takes it before anything opens
     * `RKStorage`; a writer may call it again (the reminder alarms, Reminders.kt), which then only syncs. Nothing when RN left
     * no `RKStorage`.
     */
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

    /** Runs [query] on a byte copy of [file] with its `-wal` and `-journal`, then deletes the copy. */
    private fun <T> queryCopy(file: File, scratch: File, query: (SQLiteConnection) -> T): T {
        scratch.deleteRecursively()
        check(scratch.mkdirs()) { "Cannot create the guard's scratch folder" }
        try {
            // A committed row can live only in -wal, and a hot -journal must roll back: copy both.
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
