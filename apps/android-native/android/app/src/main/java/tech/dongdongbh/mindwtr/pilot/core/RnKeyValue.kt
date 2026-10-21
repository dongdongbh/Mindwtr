package tech.dongdongbh.mindwtr.pilot.core

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File

/**
 * RN's key-value store, in place: AsyncStorage's `databases/RKStorage`, table `catalystLocalStorage`, with RN's key names and
 * text values (plan D1). An upgraded RN user keeps every device key (the sync configuration, the encryption state, ...), and an
 * RN recovery build reads what this app wrote.
 *
 * Each call opens the file, runs AsyncStorage's own statements in one transaction with `synchronous = FULL`, and closes it: a
 * write is on disk before the call returns. Engine thread only (LegacyRnStoreGuard.commitRnState, the other opener, runs there
 * too); no other process writes the file (a package replace kills the RN app).
 *
 * A file this class creates gets RN's schema and `user_version = 1`, as RN's SQLiteOpenHelper (ReactDatabaseSupplier, version 1)
 * leaves it. At version 0 RN would run its onCreate over the existing table, fail, and delete the whole database on its retry.
 */
class RnKeyValue(private val file: File) : tech.dongdongbh.mindwtr.pilot.RkStore {
    companion object {
        /** AsyncStorage's own table and statements (ReactDatabaseSupplier, AsyncStorageModule). */
        private const val CREATE = "CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        private const val SELECT = "SELECT value FROM catalystLocalStorage WHERE key = ?"
        private const val UPSERT = "INSERT OR REPLACE INTO catalystLocalStorage VALUES (?, ?)"
        private const val DELETE = "DELETE FROM catalystLocalStorage WHERE key = ?"
    }

    fun get(key: String): String? = multiGet(listOf(key)).getValue(key)

    fun set(key: String, value: String) = multiSet(listOf(key to value))

    fun remove(key: String) = multiRemove(listOf(key))

    /** Each key's value, or null when it has none; in the order asked. */
    override fun multiGet(keys: List<String>): Map<String, String?> = open { connection ->
        keys.associateWith { key ->
            connection.prepare(SELECT).use { statement ->
                statement.bindText(1, key)
                if (statement.step()) statement.getText(0) else null
            }
        }
    }

    /** All [entries] in one transaction: every value is on disk, or none. */
    override fun multiSet(entries: List<Pair<String, String>>) = write { connection ->
        for ((key, value) in entries) connection.prepare(UPSERT).use { it.bindText(1, key); it.bindText(2, value); it.step() }
    }

    override fun multiRemove(keys: List<String>) = write { connection ->
        for (key in keys) connection.prepare(DELETE).use { it.bindText(1, key); it.step() }
    }

    /** [changes] (a null value removes the key) in one transaction: every change is on disk, or none (a value with its sequence). */
    override fun apply(changes: Map<String, String?>) = write { connection ->
        for ((key, value) in changes) {
            if (value == null) connection.prepare(DELETE).use { it.bindText(1, key); it.step() }
            else connection.prepare(UPSERT).use { it.bindText(1, key); it.bindText(2, value); it.step() }
        }
    }

    private fun write(work: (SQLiteConnection) -> Unit) = open<Unit> { connection ->
        connection.exec("BEGIN IMMEDIATE")
        try {
            work(connection)
            connection.exec("COMMIT")
        } catch (error: Throwable) {
            runCatching { connection.exec("ROLLBACK") }
            throw error
        }
    }

    private fun <T> open(work: (SQLiteConnection) -> T): T {
        file.parentFile?.mkdirs()
        return BundledSQLiteDriver().open(file.path).use { connection ->
            connection.exec("PRAGMA synchronous = FULL")
            if (connection.prepare("PRAGMA user_version").use { it.step(); it.getLong(0) } == 0L) {
                connection.exec("BEGIN IMMEDIATE")
                try {
                    connection.exec(CREATE)
                    connection.exec("PRAGMA user_version = 1")
                    connection.exec("COMMIT")
                } catch (error: Throwable) {
                    runCatching { connection.exec("ROLLBACK") }
                    throw error
                }
            }
            work(connection)
        }
    }

    private fun SQLiteConnection.exec(sql: String) = prepare(sql).use { it.step() }
}
