package tech.dongdongbh.mindwtr.pilot.core

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File


class HostGmailReceipts(private val folder: File) {
    private companion object {
        val NAMES = Regex("receipts(\\.corrupt-\\d+)?\\.sqlite(-wal|-shm|-journal)?|receipts-reset")
        val DATABASES = Regex("receipts(\\.corrupt-\\d+)?\\.sqlite")

        const val COLUMN_INTEGER = 1
        const val COLUMN_FLOAT = 2
        const val COLUMN_BLOB = 4
    }

    private val open = HashMap<String, SQLiteConnection>()

    private fun named(name: String): File {
        require(NAMES.matches(name)) { "Not a Gmail receipts file" }
        return File(folder, name)
    }


    fun file(op: String, name: String, to: String): String {
        if (op == "list") return JSONArray(folder.list().orEmpty().filter(NAMES::matches).sorted()).toString()
        val file = named(name)
        when (op) {
            "exists" -> return file.exists().toString()
            "size" -> return file.length().toString()

            "create" -> check(folder.mkdirs() || folder.isDirectory) { "No Gmail receipts folder" }.also { check(file.createNewFile()) { "The file exists" } }

            "rename" -> named(to).let { target -> check(!target.exists() && file.renameTo(target)) { "The file was not renamed" } }
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

        is Double -> if (value == Math.floor(value) && !value.isInfinite()) statement.bindLong(position, value.toLong()) else statement.bindDouble(position, value)
        is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
        else -> statement.bindText(position, value.toString())
    }


    fun close() {
        open.values.forEach { runCatching { it.close() } }
        open.clear()
    }
}
