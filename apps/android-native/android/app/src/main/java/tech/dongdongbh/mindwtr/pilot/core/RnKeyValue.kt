package tech.dongdongbh.mindwtr.pilot.core

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File


class RnKeyValue(private val file: File) : RkStore {
    companion object {

        private const val CREATE = "CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        private const val SELECT = "SELECT value FROM catalystLocalStorage WHERE key = ?"
        private const val UPSERT = "INSERT OR REPLACE INTO catalystLocalStorage VALUES (?, ?)"
        private const val DELETE = "DELETE FROM catalystLocalStorage WHERE key = ?"
    }

    fun get(key: String): String? = multiGet(listOf(key)).getValue(key)

    fun set(key: String, value: String) = multiSet(listOf(key to value))

    fun remove(key: String) = multiRemove(listOf(key))


    override fun multiGet(keys: List<String>): Map<String, String?> = open { connection ->
        keys.associateWith { key ->
            connection.prepare(SELECT).use { statement ->
                statement.bindText(1, key)
                if (statement.step()) statement.getText(0) else null
            }
        }
    }


    override fun multiSet(entries: List<Pair<String, String>>) = write { connection ->
        for ((key, value) in entries) connection.prepare(UPSERT).use { it.bindText(1, key); it.bindText(2, value); it.step() }
    }

    override fun multiRemove(keys: List<String>) = write { connection ->
        for (key in keys) connection.prepare(DELETE).use { it.bindText(1, key); it.step() }
    }


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
