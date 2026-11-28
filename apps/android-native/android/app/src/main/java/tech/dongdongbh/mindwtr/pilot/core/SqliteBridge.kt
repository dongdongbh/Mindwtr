package tech.dongdongbh.mindwtr.pilot.core

import android.system.Os
import android.system.OsConstants
import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicLong


class SqliteBridge(databaseFile: File) {

    private val checkpointFile = File(databaseFile.parentFile, "${databaseFile.name}.prewrite")

    private val connection: SQLiteConnection = BundledSQLiteDriver().open(databaseFile.absolutePath).apply {

        prepare("PRAGMA foreign_keys = ON").use { it.step() }
    }


    private val statements = HashMap<String, SQLiteStatement>()


    fun ensureRecoveryCheckpoint() {
        checkIntegrity(connection)
        if (checkpointFile.exists()) {
            BundledSQLiteDriver().open(checkpointFile.absolutePath).use(::checkIntegrity)
            syncCheckpoint(checkpointFile)
        } else {
            val partial = File(checkpointFile.parentFile, "${checkpointFile.name}.building")
            if (partial.exists()) check(partial.delete()) { "Cannot remove incomplete recovery checkpoint" }
            try {
                val path = partial.absolutePath.replace("'", "''")
                exec("VACUUM INTO '$path'")
                BundledSQLiteDriver().open(partial.absolutePath).use(::checkIntegrity)
                syncFile(partial)
                check(partial.renameTo(checkpointFile)) { "Cannot promote recovery checkpoint" }
                syncDirectory(checkpointFile.parentFile!!)
            } catch (error: Throwable) {
                partial.delete()
                throw error
            }
        }


        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA synchronous = FULL")
    }

    private fun syncCheckpoint(file: File) {
        syncFile(file)
        syncDirectory(file.parentFile!!)
    }

    private fun checkIntegrity(database: SQLiteConnection) {
        database.prepare("PRAGMA quick_check").use { statement ->
            check(statement.step() && statement.getText(0) == "ok" && !statement.step()) {
                "SQLite recovery integrity check failed"
            }
        }
    }

    private fun statementFor(sql: String): SQLiteStatement =
        statements.getOrPut(sql) { connection.prepare(sql) }.also {
            it.reset()
            it.clearBindings()
        }


    @Volatile var failCommits = false


    @Volatile var stopAfterCommit = false

    fun run(sql: String, paramsJson: String) {

        if (failCommits && sql == "COMMIT") throw IllegalStateException("Injected commit failure")
        val statement = statementFor(sql)
        bind(statement, JSONArray(paramsJson))

        while (statement.step()) {                                                    }
        if (stopAfterCommit && sql == "COMMIT") {
            android.util.Log.i(CoreHost.TAG, "Native Android commit stop at=after-commit")
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    fun exec(sql: String) {
        connection.prepare(sql).use { statement -> while (statement.step()) {             } }
    }

    fun all(sql: String, paramsJson: String): String {
        val statement = statementFor(sql)
        bind(statement, JSONArray(paramsJson))
        val json = StringBuilder("[")
        var keys: Array<String?>? = null
        var sources = IntArray(0)
        var rows = 0L
        while (statement.step()) {
            if (keys == null) {
                val names = List(statement.getColumnCount()) { statement.getColumnName(it) }
                keys = Array(names.size) { if (names.indexOf(names[it]) == it) JSONObject.quote(names[it]) + ":" else null }
                sources = IntArray(names.size) { names.lastIndexOf(names[it]) }
            }
            if (rows++ > 0) json.append(',')
            json.append('{')
            var first = true
            for (column in keys.indices) {
                val key = keys[column] ?: continue
                if (!first) json.append(',')
                first = false
                json.append(key)
                appendValue(json, statement, sources[column])
            }
            json.append('}')
        }
        sqlRowsWritten.addAndGet(rows)
        return json.append(']').toString()
    }

    fun allArrays(sql: String, paramsJson: String): String {
        val statement = statementFor(sql)
        bind(statement, JSONArray(paramsJson))
        var hasRow = statement.step()
        val columns = statement.getColumnCount()
        val json = StringBuilder("[[")
        for (column in 0 until columns) {
            if (column > 0) json.append(',')
            json.append(JSONObject.quote(statement.getColumnName(column)))
        }
        json.append(']')
        var rows = 0L
        while (hasRow) {
            rows++
            json.append(",[")
            for (column in 0 until columns) {
                if (column > 0) json.append(',')
                appendValue(json, statement, column)
            }
            json.append(']')
            hasRow = statement.step()
        }
        sqlRowsWritten.addAndGet(rows)
        sqlArrayReplies.incrementAndGet()
        return json.append(']').toString()
    }

    private fun appendValue(json: StringBuilder, statement: SQLiteStatement, column: Int) {
        when (statement.getColumnType(column)) {
            COLUMN_NULL, COLUMN_BLOB -> json.append("null")
            COLUMN_INTEGER -> json.append(statement.getLong(column))
            COLUMN_FLOAT -> json.append(JSONObject.numberToString(statement.getDouble(column)))
            else -> {
                val text = statement.getText(column)
                if (text.all { it in ' '..'~' && it != '"' && it != '\\' && it != '/' }) json.append('"').append(text).append('"')
                else json.append(JSONObject.quote(text))
            }
        }
    }

    private fun bind(statement: SQLiteStatement, params: JSONArray) {
        for (index in 0 until params.length()) {
            val position = index + 1
            when (val value = if (params.isNull(index)) null else params.get(index)) {
                null -> statement.bindNull(position)
                is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
                is Int -> statement.bindLong(position, value.toLong())
                is Long -> statement.bindLong(position, value)


                is Double ->
                    if (!value.isInfinite() && value == Math.floor(value)) statement.bindLong(position, value.toLong())
                    else statement.bindDouble(position, value)
                else -> statement.bindText(position, value.toString())
            }
        }
    }

    fun close() {
        statements.values.forEach { it.close() }
        statements.clear()
        connection.close()
    }

    private companion object {


        const val COLUMN_INTEGER = 1
        const val COLUMN_FLOAT = 2
        const val COLUMN_BLOB = 4
        const val COLUMN_NULL = 5
    }
}


internal val sqlRowsWritten = AtomicLong()

internal val sqlArrayReplies = AtomicLong()


internal fun syncFile(file: File) {
    RandomAccessFile(file, "r").use { it.fd.sync() }
}

internal fun syncDirectory(directory: File) {
    val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
}
