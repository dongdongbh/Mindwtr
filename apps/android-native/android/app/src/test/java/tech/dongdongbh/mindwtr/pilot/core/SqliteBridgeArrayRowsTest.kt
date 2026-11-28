package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.file.Files
import kotlin.random.Random


class SqliteBridgeArrayRowsTest {
    private val corpusFile = File("../../bundle/host-sql-rows.corpus.json")

    private fun withBridge(test: (SqliteBridge) -> Unit) {
        val dir = Files.createTempDirectory("sqlite-array-rows").toFile()
        try {
            val bridge = SqliteBridge(File(dir, "rows.db"))
            try { test(bridge) } finally { bridge.close() }
        } finally {
            dir.deleteRecursively()
        }
    }

    private val texts = listOf(
        "", " ", "plain", "a\"b", "a\\b", "</b>", "line\nbreak\ttab\r", "\u0000\u0001\u001f\u007f", "é中文", "😀 emoji", "  ",
        "null", "0", "[\"tag-0\",\"@home\"]", "[]", "{\"rule\":\"daily\",\"interval\":1}", "{bad json", "  [1, 2] ",
    )

    private fun seed(bridge: SqliteBridge) {
        bridge.exec(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, tags TEXT, recurrence TEXT, isFocusedToday INTEGER, " +
                "orderNum REAL, pushCount INTEGER, blob BLOB, description TEXT, rev INTEGER, revBy TEXT, createdAt TEXT, deletedAt TEXT)",
        )
        val random = Random(20261128)
        for (index in 0 until 200) {
            val values = JSONArray()
            values.put("task-$index")
            repeat(13) { column ->
                values.put(
                    when (random.nextInt(9)) {
                        0, 1, 2 -> JSONObject.NULL
                        3 -> texts[random.nextInt(texts.size)]
                        4 -> random.nextLong()
                        5 -> random.nextInt(-3, 4)
                        6 -> listOf(1.5, -0.25, 2.0, 1e300, 1e-7, 123456789.125, -0.0)[random.nextInt(7)]
                        7 -> if (column == 7) "x" else random.nextInt(2)
                        else -> "text $column ${random.nextInt(1000)}"
                    },
                )
            }
            bridge.run("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values.toString())
        }
        bridge.exec("UPDATE tasks SET blob = x'00ff' WHERE rowid % 7 = 0")
        bridge.exec("UPDATE tasks SET orderNum = -0.0 WHERE rowid % 11 = 0")
        bridge.exec("UPDATE tasks SET pushCount = 9007199254740993 WHERE rowid % 13 = 0")
        bridge.exec("UPDATE tasks SET pushCount = -9223372036854775808 WHERE rowid % 17 = 0")
    }

    private val queries = listOf(
        "SELECT rowid as _rowid, * FROM tasks WHERE rowid > ? ORDER BY rowid LIMIT ?" to "[0, 1000]",
        "SELECT rowid as _rowid, * FROM tasks WHERE rowid > ? ORDER BY rowid LIMIT ?" to "[190, 1000]",
        "SELECT rowid as _rowid, * FROM tasks WHERE id = ?" to "[\"none\"]",
        "SELECT COUNT(*) AS n FROM tasks" to "[]",
        "SELECT data FROM (SELECT ? AS data) WHERE data IS NOT NULL" to "[\"{\\\"theme\\\":\\\"dark\\\"}\"]",
        "SELECT 1 AS x, 2 AS y, 3 AS x" to "[]",
        "SELECT 1 AS \"__proto__\", 2 AS \"constructor\", 3 AS \"b\", 4 AS \"1\", 5 AS \"\", 6 AS \"a\"\"b\", 7 AS \"é\", 8 AS \"__proto__\"" to "[]",
        "SELECT id AS \"toString\", title AS \"hasOwnProperty\", 0 AS \"10\", 1 AS \"2\" FROM tasks ORDER BY rowid LIMIT 5" to "[]",
        "SELECT ? AS a, ? AS b, ? AS c" to "[null, true, 3.5]",
        "SELECT -0.0 AS z, 1e300 AS big, 0.1 AS tenth, -9223372036854775808 AS lo, x'00' AS b, '' AS e, NULL AS n" to "[]",
    )

    private fun corpus(bridge: SqliteBridge): JSONArray {
        val cases = JSONArray()
        for ((sql, params) in queries) {
            cases.put(JSONObject().put("sql", sql).put("params", params).put("objects", bridge.all(sql, params)).put("arrays", bridge.allArrays(sql, params)))
        }
        return cases
    }

    @Test fun theCommittedCorpusHoldsTheRepliesBothReadersWriteToday() = withBridge { bridge ->
        seed(bridge)
        val cases = corpus(bridge)

        if (System.getenv("UPDATE_SQL_ROWS_CORPUS") == "1") corpusFile.writeText(cases.toString(1) + "\n")
        val committed = JSONArray(corpusFile.readText())
        assertEquals(cases.length(), committed.length())
        for (index in 0 until cases.length()) {
            assertEquals(committed.getJSONObject(index).getString("objects"), cases.getJSONObject(index).getString("objects"))
            assertEquals(committed.getJSONObject(index).getString("arrays"), cases.getJSONObject(index).getString("arrays"))
        }
    }

    @Test fun eachArrayReplyHoldsTheColumnNamesThenOneArrayPerRowInColumnOrder() = withBridge { bridge ->
        bridge.exec("CREATE TABLE t (id TEXT, n INTEGER, f REAL, b BLOB, z TEXT)")
        bridge.run("INSERT INTO t VALUES (?, ?, ?, x'00ff', NULL)", JSONArray(listOf("a/\"\\\né", 9007199254740993L, 1.5)).toString())
        bridge.run("INSERT INTO t VALUES ('plain', -3, 2.0, NULL, '')", "[]")

        assertEquals(
            "[[\"_rowid\",\"id\",\"n\",\"f\",\"b\",\"z\"],[1,${JSONObject.quote("a/\"\\\né")},9007199254740993,1.5,null,null]," +
                "[2,\"plain\",-3,${JSONObject.numberToString(2.0)},null,\"\"]]",
            bridge.allArrays("SELECT rowid as _rowid, * FROM t ORDER BY rowid", "[]"),
        )
    }

    @Test fun anEmptyArrayReplyStillNamesItsColumns() = withBridge { bridge ->
        bridge.exec("CREATE TABLE t (id TEXT, title TEXT)")

        assertEquals("[[\"id\",\"title\"]]", bridge.allArrays("SELECT * FROM t WHERE id = ?", "[\"none\"]"))
    }

    @Test fun aRepeatedColumnNameIsSentAsIsForTheBundleToResolve() = withBridge { bridge ->
        assertEquals("[[\"x\",\"y\",\"x\"],[1,2,3]]", bridge.allArrays("SELECT 1 AS x, 2 AS y, 3 AS x", "[]"))
    }

    @Test fun aCachedReadNamesAColumnAddedAfterItsLastRun() = withBridge { bridge ->
        bridge.exec("CREATE TABLE t (a TEXT)")
        bridge.run("INSERT INTO t VALUES ('x')", "[]")
        val sql = "SELECT rowid as _rowid, * FROM t"
        assertEquals("[[\"_rowid\",\"a\"],[1,\"x\"]]", bridge.allArrays(sql, "[]"))

        bridge.exec("ALTER TABLE t ADD COLUMN c TEXT")

        assertEquals(bridge.all(sql, "[]").contains("\"c\":null"), true)
        assertEquals("[[\"_rowid\",\"a\",\"c\"],[1,\"x\",null]]", bridge.allArrays(sql, "[]"))
        bridge.exec("DELETE FROM t")
        assertEquals("[[\"_rowid\",\"a\",\"c\"]]", bridge.allArrays(sql, "[]"))
    }
}
