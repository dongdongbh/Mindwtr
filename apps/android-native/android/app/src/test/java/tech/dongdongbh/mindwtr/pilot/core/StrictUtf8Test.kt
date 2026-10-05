package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * HostIo hands JavaScript a fetch body as text only when it is strict UTF-8, so the host's answer must be the polyfill's fatal
 * TextDecoder's answer for every input. scripts/utf8-parity-cases.json holds Node's fatal decoder's answers (BOM kept), and
 * check-boot-gates.mjs proves the polyfill gives the same: incomplete sequences, overlong forms, surrogate code points, values
 * above U+10FFFF, astral characters, a BOM, and random bytes.
 */
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
                // The polyfill rebuilds bytes from this text when asked: they must be the body's own.
                assertArrayEquals("bytes of $hex", bytes, decoded!!.toByteArray(Charsets.UTF_8))
            }
        }
    }

    @Test fun keepsALeadingBomAndJsonEscapes() {
        assertEquals("\uFEFF{}", StrictUtf8.decodeOrNull(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), '{'.code.toByte(), '}'.code.toByte())))
        assertEquals("\"\\ud800\"", StrictUtf8.decodeOrNull("\"\\ud800\"".toByteArray()))
    }
}
