package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.nio.file.Files


class SqliteBridgeRowsTest {
    private val awkward = "a/\"\\\n\t\u0001é中\u2028</b>"

    private fun withBridge(test: (SqliteBridge) -> Unit) {
        val dir = Files.createTempDirectory("sqlite-bridge").toFile()
        try {
            val file = File(dir, "rows.db")
            val bridge = SqliteBridge(file)
            try { test(bridge) } finally { bridge.close() }
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun everyColumnTypeIsWrittenInColumnOrderThroughQuoteAndNumberToString() = withBridge { bridge ->
        bridge.exec("CREATE TABLE t (id TEXT, n INTEGER, f REAL, b BLOB, z TEXT)")
        bridge.run("INSERT INTO t VALUES (?, ?, ?, x'00ff', NULL)", JSONArray(listOf(awkward, 9007199254740993L, 1.5)).toString())
        bridge.run("INSERT INTO t VALUES ('plain', -3, 2.0, NULL, '')", "[]")
        bridge.run("INSERT INTO t VALUES (NULL, 0, -0.25, NULL, 'x')", "[]")
        val sql = "SELECT rowid as _rowid, * FROM t ORDER BY rowid"

        val rows = bridge.all(sql, "[]")

        assertEquals(
            "[{\"_rowid\":1,\"id\":${JSONObject.quote(awkward)},\"n\":9007199254740993,\"f\":1.5,\"b\":null,\"z\":null}," +
                "{\"_rowid\":2,\"id\":\"plain\",\"n\":-3,\"f\":${JSONObject.numberToString(2.0)},\"b\":null,\"z\":\"\"}," +
                "{\"_rowid\":3,\"id\":null,\"n\":0,\"f\":-0.25,\"b\":null,\"z\":\"x\"}]",
            rows,
        )
    }

    @Test fun eachTextThatNeedsEscapingLeavesTheFastPath() = withBridge { bridge ->
        val rows = bridge.all("SELECT ? AS q, ? AS s, ? AS t, 'plain text' AS p", JSONArray(listOf("a\"b", "a\\b", "</b>")).toString())

        assertEquals("""[{"q":"a\"b","s":"a\\b","t":"<\/b>","p":"plain text"}]""", rows)
    }

    @Test fun integerExtremesNegativeZeroAndAnEscapedColumnNameAreWrittenExactly() = withBridge { bridge ->
        val rows = bridge.all("SELECT -9223372036854775808 AS lo, 9223372036854775807 AS hi, -0.0 AS z, 1 AS \"a\"\"b\"", "[]")

        assertEquals("""[{"lo":-9223372036854775808,"hi":9223372036854775807,"z":-0,"a\"b":1}]""", rows)
    }

    @Test fun aRealThatIsNotJsonStillFailsTheRead() = withBridge { bridge ->
        assertThrows(JSONException::class.java) { bridge.all("SELECT 9e999 AS f", "[]") }
    }

    @Test fun aRepeatedColumnNameKeepsItsFirstPlaceAndItsLastValueAsAnObjectPutDid() = withBridge { bridge ->
        val sql = "SELECT 1 AS x, 2 AS y, 3 AS x"

        assertEquals("[{\"x\":3,\"y\":2}]", bridge.all(sql, "[]"))
    }

    @Test fun noRowsIsAnEmptyArray() = withBridge { bridge ->
        bridge.exec("CREATE TABLE t (id TEXT)")

        assertEquals("[]", bridge.all("SELECT * FROM t WHERE id = ?", "[\"none\"]"))
    }
}
