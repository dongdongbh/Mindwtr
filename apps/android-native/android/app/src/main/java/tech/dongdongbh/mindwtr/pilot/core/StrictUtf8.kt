package tech.dongdongbh.mindwtr.pilot.core

/**
 * UTF-8 exactly as the polyfill's fatal TextDecoder reads it (the Encoding Standard's decoder in "fatal" mode): no overlong
 * form, no surrogate code point, nothing above U+10FFFF, no sequence cut short. A leading BOM stays in the text, as the
 * polyfill keeps it. Checked here byte by byte, so the answer never depends on the platform's decoder; only text that passed
 * is then decoded, and valid UTF-8 decodes (and encodes back) exactly.
 */
object StrictUtf8 {
    /** [bytes] as text, or null when they are not strict UTF-8 (the caller then keeps the bytes). */
    fun decodeOrNull(bytes: ByteArray): String? = if (valid(bytes)) String(bytes, Charsets.UTF_8) else null

    /**
     * [bytes] as text that crosses the QuickJS bridge exactly, or null (send the bytes): strict UTF-8 with no NUL. The bridge
     * passes strings as modified UTF-8, where NUL is the two bytes C0 80, which QuickJS reads as U+FFFD.
     */
    fun bridgeTextOrNull(bytes: ByteArray): String? = if (bytes.contains(0)) null else decodeOrNull(bytes)

    fun valid(bytes: ByteArray): Boolean {
        var i = 0
        val size = bytes.size
        while (i < size) {
            val lead = bytes[i].toInt() and 0xff
            i += 1
            if (lead < 0x80) continue
            // The Encoding Standard's bounds for the first continuation byte; later ones are 0x80..0xBF.
            val needed: Int
            var lower = 0x80
            var upper = 0xbf
            when (lead) {
                in 0xc2..0xdf -> needed = 1
                in 0xe0..0xef -> { needed = 2; if (lead == 0xe0) lower = 0xa0; if (lead == 0xed) upper = 0x9f }
                in 0xf0..0xf4 -> { needed = 3; if (lead == 0xf0) lower = 0x90; if (lead == 0xf4) upper = 0x8f }
                else -> return false
            }
            if (size - i < needed) return false
            for (k in 0 until needed) {
                val next = bytes[i + k].toInt() and 0xff
                if (next < lower || next > upper) return false
                lower = 0x80
                upper = 0xbf
            }
            i += needed
        }
        return true
    }
}
