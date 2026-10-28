package tech.dongdongbh.mindwtr.pilot.core

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files

/**
 * Core's Gmail receipt store on this host (gmail-receipt-store.ts GmailReceiptFiles, bundle/host-gmail.ts): RN's file
 * `filesDir/GmailCapture/receipts.sqlite`, so an RN user who upgrades keeps the receipts and old mail is not captured twice. Core
 * owns every rule (the empty-file check, the move-aside, the carry-over, the marker); this host only makes the file calls and runs
 * the SQL. Every name is a bare name of a receipts file, a moved one, their journals, or the reset marker; any other name is
 * refused, so these calls never reach the task database. The SQL runs on the bundled driver, never Android's SQLiteDatabase, whose
 * android_metadata table would fail core's two-table check on every start. Engine thread only.
 */
class HostGmailReceipts(private val folder: File) {
    private companion object {
        val NAMES = Regex("receipts(\\.corrupt-\\d+)?\\.sqlite(-wal|-shm|-journal)?|receipts-reset")
        val DATABASES = Regex("receipts(\\.corrupt-\\d+)?\\.sqlite")
        // androidx.sqlite's SQLITE_DATA_* (SqliteBridge spells them out too).
        const val COLUMN_INTEGER = 1
        const val COLUMN_FLOAT = 2
        const val COLUMN_BLOB = 4
    }

    private val open = HashMap<String, SQLiteConnection>()

    private fun named(name: String): File {
        require(NAMES.matches(name)) { "Not a Gmail receipts file" }
        return File(folder, name)
    }

    /**
     * One of core's file calls: `exists` ("true"/"false"), `size` (bytes), `create` (an empty file; fails over one), `rename` to
     * [to] (never over a file), `remove`, `list` (the receipts files, JSON), `open` and `close` (a database's connection).
     */
    fun file(op: String, name: String, to: String): String {
        if (op == "list") return JSONArray(folder.list().orEmpty().filter(NAMES::matches).sorted()).toString()
        val file = named(name)
        when (op) {
            "exists" -> return file.exists().toString()
            "size" -> return file.length().toString()
            // The folder comes with the first file, as RN makes it only when it opens the store.
            "create" -> check(folder.mkdirs() || folder.isDirectory) { "No Gmail receipts folder" }.also { check(file.createNewFile()) { "The file exists" } }
            "rename" -> Files.move(file.toPath(), named(to).toPath())
            "remove" -> check(!file.exists() || file.delete()) { "The file was not removed" }
            "open" -> {
                require(DATABASES.matches(name)) { "Not a Gmail receipts database" }
                open.remove(name)?.close()
                open[name] = BundledSQLiteDriver().open(file.path)
            }
            "close" -> open.remove(name)?.close()
            else -> throw IllegalArgumentException("Unsupported Gmail receipts call")
        }
        return ""
    }

    /** [sql] with [paramsJson] (a JSON array) on [name]'s open connection: the rows as a JSON array of objects. */
    fun sql(name: String, sql: String, paramsJson: String): String {
        val connection = checkNotNull(open[named(name).name]) { "The Gmail receipts file is not open" }
        return connection.prepare(sql).use { statement ->
            val params = JSONArray(paramsJson)
            for (index in 0 until params.length()) bind(statement, index + 1, if (params.isNull(index)) null else params.get(index))
            val rows = JSONArray()
            while (statement.step()) {
                val row = JSONObject()
                for (column in 0 until statement.getColumnCount()) {
                    row.put(statement.getColumnName(column), when {
                        statement.isNull(column) -> JSONObject.NULL
                        statement.getColumnType(column) == COLUMN_INTEGER -> statement.getLong(column)
                        statement.getColumnType(column) == COLUMN_FLOAT -> statement.getDouble(column)
                        statement.getColumnType(column) == COLUMN_BLOB -> JSONObject.NULL
                        else -> statement.getText(column)
                    })
                }
                rows.put(row)
            }
            rows.toString()
        }
    }

    private fun bind(statement: SQLiteStatement, position: Int, value: Any?) = when (value) {
        null -> statement.bindNull(position)
        is Int -> statement.bindLong(position, value.toLong())
        is Long -> statement.bindLong(position, value)
        // JSON's one number type: a whole number is an integer (core's enabled and blocked flags).
        is Double -> if (value == Math.floor(value) && !value.isInfinite()) statement.bindLong(position, value.toLong()) else statement.bindDouble(position, value)
        is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
        else -> statement.bindText(position, value.toString())
    }

    /** The host closed: every connection ends. */
    fun close() {
        open.values.forEach { runCatching { it.close() } }
        open.clear()
    }
}
