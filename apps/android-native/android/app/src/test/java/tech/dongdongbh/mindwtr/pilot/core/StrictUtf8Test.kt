package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File


class StrictUtf8Test {
    private val cases = JSONArray(File("../../scripts/utf8-parity-cases.json").readText())

    @Test fun matchesTheFatalDecoderOnEverySharedCase() {
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val hex = case.getString("hex")
            val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
            val decoded = StrictUtf8.decodeOrNull(bytes)
            if (case.isNull("text")) assertNull("malformed $hex", decoded)
            else {
                assertEquals("text of $hex", case.getString("text"), decoded)

                assertArrayEquals("bytes of $hex", bytes, decoded!!.toByteArray(Charsets.UTF_8))
            }
        }
    }

    @Test fun aNulKeepsItsBytes() {

        val bytes = byteArrayOf(0x61, 0, 0x62)
        assertEquals("a\u0000b", StrictUtf8.decodeOrNull(bytes))
        assertNull(StrictUtf8.bridgeTextOrNull(bytes))
        assertEquals("ab", StrictUtf8.bridgeTextOrNull(byteArrayOf(0x61, 0x62)))
    }

    @Test fun keepsALeadingBomAndJsonEscapes() {
        assertEquals("\uFEFF{}", StrictUtf8.decodeOrNull(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), '{'.code.toByte(), '}'.code.toByte())))
        assertEquals("\"\\ud800\"", StrictUtf8.decodeOrNull("\"\\ud800\"".toByteArray()))
    }
}
