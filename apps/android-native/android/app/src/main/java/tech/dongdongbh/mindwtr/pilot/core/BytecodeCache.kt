package tech.dongdongbh.mindwtr.pilot.core

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest


class BytecodeCache(
    private val file: File,
    private val engineVersion: String,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,
) {

    class Read(val bytecode: ByteArray?, val outcome: String)

    fun read(bundleHash: String): Read = try {
        if (!file.exists()) Read(null, "absent")
        else DataInputStream(file.inputStream().buffered()).use { input ->
            val magic = ByteArray(MAGIC.size).also(input::readFully)
            val sameBundle = magic.contentEquals(MAGIC) && ByteArray(32).also(input::readFully).contentEquals(hex(bundleHash))
            when {
                !magic.contentEquals(MAGIC) -> Read(null, "corrupt")
                input.readUTF() != engineVersion -> Read(null, "other-engine")
                !sameBundle -> Read(null, "stale-bundle")
                else -> {
                    val length = input.readInt()
                    val digest = ByteArray(32).also(input::readFully)
                    if (length < 0 || length.toLong() != file.length() - HEADER_FIXED - utfLength(engineVersion)) Read(null, "truncated")
                    else {
                        val bytecode = ByteArray(length).also(input::readFully)
                        if (sha256(bytecode).contentEquals(digest)) Read(bytecode, "hit") else Read(null, "corrupt")
                    }
                }
            }
        }
    } catch (short: EOFException) {
        Read(null, "truncated")
    } catch (error: Exception) {
        Read(null, "error:${error.javaClass.simpleName}")
    }


    fun write(bundleHash: String, bytecode: ByteArray): Boolean {
        val temporary = runCatching {
            removeAbandonedTemporaryFiles()
            File.createTempFile("${file.name}.", ".tmp", file.parentFile)
        }.getOrElse { return false }
        return try {
            val header = ByteArrayOutputStream().also { bytes ->
                DataOutputStream(bytes).use { out ->
                    out.write(MAGIC)
                    out.write(hex(bundleHash))
                    out.writeUTF(engineVersion)
                    out.writeInt(bytecode.size)
                    out.write(sha256(bytecode))
                }
            }.toByteArray()
            FileOutputStream(temporary).use { out ->
                out.write(header)
                out.write(bytecode)
                out.fd.sync()
            }
            check(temporary.renameTo(file)) { "Cannot rename the bytecode cache into place" }
            syncDirectory(file.parentFile!!)
            true
        } catch (error: Exception) {
            temporary.delete()
            false
        }
    }


    private fun removeAbandonedTemporaryFiles() {
        val cutoff = System.currentTimeMillis() - ABANDONED_AFTER_MS
        file.parentFile?.listFiles { other -> other.name.startsWith("${file.name}.") && other.name.endsWith(".tmp") }
            ?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }

    companion object {
        private val MAGIC = "MWQJSBC1".toByteArray(Charsets.US_ASCII)
        private const val ABANDONED_AFTER_MS = 10 * 60_000L

        private val HEADER_FIXED = MAGIC.size + 32L + 4 + 32
        private fun utfLength(text: String) = 2L + text.toByteArray(Charsets.UTF_8).size

        fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)


        private val KEY_LINE = "//mindwtr-bundle-sha256:".toByteArray(Charsets.US_ASCII)


        fun bundleKey(bundle: InputStream): String {
            val head = ByteArray(KEY_LINE.size + 65)
            var read = 0
            while (read < head.size) {
                val count = bundle.read(head, read, head.size - read)
                if (count < 0) return ""
                read += count
            }
            if (!head.copyOf(KEY_LINE.size).contentEquals(KEY_LINE) || head.last() != '\n'.code.toByte()) return ""
            return String(head, KEY_LINE.size, 64, Charsets.US_ASCII).takeIf { key -> runCatching { hex(key) }.isSuccess }.orEmpty()
        }


        fun bodyMatches(bundle: ByteArray, key: String): Boolean {
            val newline = bundle.indexOf('\n'.code.toByte())
            if (newline < 0) return false
            val digest = MessageDigest.getInstance("SHA-256").apply { update(bundle, newline + 1, bundle.size - newline - 1) }.digest()
            return runCatching { digest.contentEquals(hex(key)) }.getOrDefault(false)
        }


        fun hex(text: String): ByteArray {
            require(text.length == 64 && text.all { it in '0'..'9' || it in 'a'..'f' }) { "Not a SHA-256: $text" }
            return ByteArray(32) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        }
    }
}
