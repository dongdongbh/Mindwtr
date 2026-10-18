package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CharsetDecoder
import java.nio.charset.CharsetEncoder
import java.nio.charset.CoderResult
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Settings › Data's files between Kotlin and core in chunks (pass D1c design §3.1): Kotlin never holds a whole backup, plan or
 * export. Kotlin registers one file per host call and hands core an opaque handle; core reads or writes it about 1 MiB at a
 * time through the bridge (`dataRead`, `dataWrite`, `dataClose`). A handle's kind and byte cap are Kotlin's, never core's.
 *
 * Errors are [Failure]s with fixed, content-free codes; no path, handle or file byte is ever in their text.
 */
class DataChannel(private val chunkBytes: Int = CHUNK_BYTES, private val recoveryCapBytes: Long = RECOVERY_CAP_BYTES,
                  private val opener: (File) -> InputStream = ::FileInputStream) {
    enum class Kind { UTF8_READ, BASE64_READ, UTF8_WRITE, BASE64_WRITE }

    /** A channel failure: [code] is the whole message (the bridge's error marker carries it to core). */
    class Failure(val code: String) : IOException(code)

    /** A closed handle's bytes and their SHA-256 (hex). */
    data class Closed(val bytes: Long, val sha256: String)

    private abstract class Handle(val file: File, val kind: Kind) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        abstract fun close(): Closed
        abstract fun abandon()
    }

    private inner class Reader(file: File, kind: Kind, private val expectedSha256: String?) : Handle(file, kind) {
        private val input: InputStream = opener(file)
        private val decoder: CharsetDecoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        // A base64 chunk is a multiple of 3 bytes, so the pieces join to the whole file's base64; UTF-8 keeps a split
        // character's first bytes here for the next chunk.
        private val buffer = ByteBuffer.allocate(if (kind == Kind.BASE64_READ) maxOf(chunkBytes / 3 * 3, 3) else maxOf(chunkBytes, 4))
        private var ended = false

        /** The next piece of text, or null at the end. */
        fun next(): String? {
            if (ended) return null
            val eof = fill()
            buffer.flip()
            val text = if (kind == Kind.BASE64_READ) {
                val chunk = ByteArray(buffer.remaining()).also { buffer.get(it) }
                digest.update(chunk); bytes += chunk.size
                Base64.getEncoder().encodeToString(chunk)
            } else decodeUtf8(eof)
            buffer.compact()
            if (eof) ended = true
            return if (text.isEmpty() && ended) null else text
        }

        /** Reads until the buffer is full or the file ends (a short read continues); true at the end of the file. */
        private fun fill(): Boolean {
            while (buffer.hasRemaining()) {
                val read = try { input.read(buffer.array(), buffer.arrayOffset() + buffer.position(), buffer.remaining()) }
                    catch (_: IOException) { throw Failure(IO) }
                if (read < 0) return true
                buffer.position(buffer.position() + read)
            }
            return false
        }

        private fun decodeUtf8(eof: Boolean): String {
            val start = buffer.position()
            val out = CharBuffer.allocate(buffer.remaining() + 1)
            var result: CoderResult = decoder.decode(buffer, out, eof)
            if (!result.isError && eof) result = decoder.flush(out)
            // At the end of the file the decoder reports a character cut short as malformed: strict UTF-8 refuses it.
            if (result.isError) throw Failure(UTF8)
            val used = buffer.position() - start
            digest.update(buffer.array(), buffer.arrayOffset() + start, used); bytes += used
            out.flip()
            return out.toString()
        }

        override fun close(): Closed {
            runCatching { input.close() }
            val closed = Closed(bytes, hex(digest.digest()))
            if (expectedSha256 != null && closed.sha256 != expectedSha256) throw Failure(MISMATCH)
            return closed
        }

        override fun abandon() { runCatching { input.close() } }
    }

    private inner class Writer(file: File, kind: Kind, private val capBytes: Long) : Handle(file, kind) {
        private val output = FileOutputStream(file)
        private val encoder: CharsetEncoder = Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)

        fun write(chunk: String) {
            val data = try {
                if (kind == Kind.BASE64_WRITE) {
                    if (chunk.length % 4 != 0) throw Failure(IO)
                    Base64.getDecoder().decode(chunk)
                } else encoder.encode(CharBuffer.wrap(chunk)).let { encoded -> ByteArray(encoded.remaining()).also { encoded.get(it) } }
            } catch (_: IllegalArgumentException) { throw Failure(IO) } catch (_: CharacterCodingException) { throw Failure(IO) }
            if (bytes + data.size > capBytes) throw Failure(CAP)
            try { output.write(data) } catch (_: IOException) { throw Failure(IO) }
            digest.update(data); bytes += data.size
        }

        override fun close(): Closed {
            try { output.fd.sync(); output.close() } catch (_: IOException) { throw Failure(IO) }
            return Closed(bytes, hex(digest.digest()))
        }

        override fun abandon() {
            runCatching { output.close() }
            file.delete()
        }
    }

    private val open = ConcurrentHashMap<String, Handle>()

    /** A read handle over [file]; [expectedSha256] (hex), when given, must match what was served or [close] fails. */
    fun openRead(file: File, base64: Boolean = false, expectedSha256: String? = null): String {
        val reader = try { Reader(file, if (base64) Kind.BASE64_READ else Kind.UTF8_READ, expectedSha256) } catch (_: IOException) { throw Failure(IO) }
        return UUID.randomUUID().toString().also { open[it] = reader }
    }

    /** A write handle that creates [file] and refuses past [capBytes]; any failure deletes the file. */
    fun openWrite(file: File, base64: Boolean = false, capBytes: Long = Long.MAX_VALUE): String {
        val writer = try { Writer(file, if (base64) Kind.BASE64_WRITE else Kind.UTF8_WRITE, capBytes) } catch (_: IOException) { throw Failure(IO) }
        return UUID.randomUUID().toString().also { open[it] = writer }
    }

    /** A write handle for a recovery snapshot (an operation's or the capture popup's): capped at core's 128 MiB backup limit. */
    fun openRecoveryWrite(file: File): String = openWrite(file, capBytes = recoveryCapBytes)

    /** The bridge's `dataRead`: "D" + the next chunk, or "E" at the end (a data chunk can never look like an error marker). */
    fun read(handle: String): String {
        val reader = open[handle] as? Reader ?: throw Failure(HANDLE)
        return try {
            if (failNextRead) { failNextRead = false; throw Failure(IO) }
            reader.next()?.let { "D$it" } ?: "E"
        } catch (failure: Failure) { drop(handle); throw failure }
    }

    /** Debug-only: the next read fails with [IO] once (check-data-device.mjs R1: a replay whose plan cannot be read). */
    @Volatile var failNextRead = false

    /** The bridge's `dataWrite`. */
    fun write(handle: String, chunk: String) {
        val writer = open[handle] as? Writer ?: throw Failure(HANDLE)
        try { writer.write(chunk) } catch (failure: Failure) { drop(handle); throw failure }
    }

    /** The bridge's `dataClose`: the handle ends; a write handle's file is synced, a read handle's hash checked. */
    fun close(handle: String): Closed {
        val entry = open.remove(handle) ?: throw Failure(HANDLE)
        return try { entry.close() } catch (failure: Failure) { entry.abandon(); throw failure }
    }

    /** Ends [handle] without its result (the host call failed): a write handle's file goes. Unknown handles are ignored. */
    fun drop(handle: String) { open.remove(handle)?.abandon() }

    companion object {
        /** About 1 MiB per bridge call. */
        const val CHUNK_BYTES = 1024 * 1024
        /** Core's MAX_BACKUP_SOURCE_BYTES: a restore refuses a larger snapshot, so none is ever written. */
        const val RECOVERY_CAP_BYTES = 128L * 1024 * 1024
        const val IO = "DATA_IO"
        const val MISMATCH = "DATA_MISMATCH"
        const val CAP = "DATA_CAP"
        const val HANDLE = "DATA_HANDLE"
        const val UTF8 = "DATA_UTF8"

        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    }
}
