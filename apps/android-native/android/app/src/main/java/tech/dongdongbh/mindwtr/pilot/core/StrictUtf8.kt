package tech.dongdongbh.mindwtr.pilot.core


object StrictUtf8 {

    fun decodeOrNull(bytes: ByteArray): String? = if (valid(bytes)) String(bytes, Charsets.UTF_8) else null


    fun bridgeTextOrNull(bytes: ByteArray): String? = if (bytes.contains(0)) null else decodeOrNull(bytes)

    fun valid(bytes: ByteArray): Boolean {
        var i = 0
        val size = bytes.size
        while (i < size) {
            val lead = bytes[i].toInt() and 0xff
            i += 1
            if (lead < 0x80) continue

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
