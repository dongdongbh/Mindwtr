package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.security.MessageDigest
import java.util.Base64

/** Pass D1c design §3.1: the chunked file channel between Kotlin and core. */
class DataChannelTest {
    @get:Rule val folder = TemporaryFolder()
    private fun file(bytes: ByteArray) = folder.newFile().apply { writeBytes(bytes) }
    private fun sha(bytes: ByteArray) = DataChannel.hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun code(work: () -> Unit) = (runCatching(work).exceptionOrNull() as? DataChannel.Failure)?.code

    /** Every reply of [handle] until "E"; each data reply starts with "D". */
    private fun replies(channel: DataChannel, handle: String): List<String> {
        val out = ArrayList<String>()
        while (true) { val reply = channel.read(handle); if (reply == "E") return out; assertTrue(reply.startsWith("D")); out += reply.substring(1) }
    }

    @Test fun utf8ChunksJoinToTheFileEvenWhenACharacterIsSplitAcrossThem() {
        val text = "aé🦉日本語".repeat(50) + "end"
        val bytes = text.toByteArray()
        for (size in 4..12) {
            val channel = DataChannel(chunkBytes = size)
            val handle = channel.openRead(file(bytes), expectedSha256 = sha(bytes))
            assertEquals("chunk $size", text, replies(channel, handle).joinToString(""))
            assertEquals(DataChannel.Closed(bytes.size.toLong(), sha(bytes)), channel.close(handle))
        }
    }

    @Test fun aFileThatEndsInsideACharacterOrHoldsAnInvalidByteIsRefused() {
        val cut = "ok🦉".toByteArray().let { it.copyOf(it.size - 1) }
        val channel = DataChannel(chunkBytes = 2)
        assertEquals(DataChannel.UTF8, code { replies(channel, channel.openRead(file(cut))) })
        assertEquals(DataChannel.UTF8, code { replies(channel, channel.openRead(file(byteArrayOf(0x61, 0xff.toByte(), 0x62)))) })
    }

    @Test fun base64ChunksFromShortReadsJoinToTheWholeFilesBase64() {
        val bytes = ByteArray(1000) { (it * 7).toByte() }
        // The provider hands one byte per read: chunks still hold whole groups of three bytes.
        val channel = DataChannel(chunkBytes = 64) { source -> object : FilterInputStream(FileInputStream(source)) {
            override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, minOf(1, len))
        } }
        val handle = channel.openRead(file(bytes), base64 = true)
        val chunks = replies(channel, handle)
        assertTrue(chunks.dropLast(1).none { it.contains('=') })
        assertEquals(Base64.getEncoder().encodeToString(bytes), chunks.joinToString(""))
        assertEquals(DataChannel.Closed(1000, sha(bytes)), channel.close(handle))
    }

    @Test fun aChunkThatStartsWithTheBridgesErrorMarkerIsStillData() {
        val marker = "!MindwtrNativeError:"
        val text = "x".repeat(32) + marker + "tail"
        val channel = DataChannel(chunkBytes = 32)
        val handle = channel.openRead(file(text.toByteArray()))
        assertEquals("D" + "x".repeat(32), channel.read(handle))
        assertEquals("D${marker}tail", channel.read(handle))
        assertEquals("E", channel.read(handle))
    }

    @Test fun aByteChangedAfterTheCheckFailsTheClose() {
        val bytes = "{\"plan\":1}".toByteArray()
        val channel = DataChannel()
        val handle = channel.openRead(file(bytes), expectedSha256 = sha("{\"plan\":2}".toByteArray()))
        replies(channel, handle)
        assertEquals(DataChannel.MISMATCH, code { channel.close(handle) })
    }

    @Test fun aWritePastItsCapIsRefusedAndItsFileDeleted() {
        val target = File(folder.root, "plan.json.pending")
        val channel = DataChannel()
        val handle = channel.openWrite(target, capBytes = 8)
        channel.write(handle, "12345")
        assertEquals(DataChannel.CAP, code { channel.write(handle, "6789") })
        assertFalse(target.exists())
        assertEquals(DataChannel.HANDLE, code { channel.write(handle, "1") })
    }

    @Test fun utf8WritesCountBytesAndALoneSurrogateIsRefused() {
        val target = File(folder.root, "recovery.pending")
        val channel = DataChannel()
        val handle = channel.openWrite(target)
        channel.write(handle, "日本"); channel.write(handle, "🦉")
        assertEquals(DataChannel.Closed(10, sha("日本🦉".toByteArray())), channel.close(handle))
        assertEquals("日本🦉", target.readText())
        val split = channel.openWrite(File(folder.root, "split.pending"))
        assertEquals(DataChannel.IO, code { channel.write(split, "a\uD83E") })
        assertFalse(File(folder.root, "split.pending").exists())
    }

    @Test fun base64WritesStoreTheDecodedBytes() {
        val zip = ByteArray(300) { (it * 13).toByte() }
        val encoded = Base64.getEncoder().encodeToString(zip)
        val target = File(folder.root, "export.zip")
        val channel = DataChannel()
        val handle = channel.openWrite(target, base64 = true)
        encoded.chunked(8).forEach { channel.write(handle, it) }
        assertEquals(DataChannel.Closed(300, sha(zip)), channel.close(handle))
        assertTrue(zip.contentEquals(target.readBytes()))
        val misaligned = channel.openWrite(File(folder.root, "bad.zip"), base64 = true)
        assertEquals(DataChannel.IO, code { channel.write(misaligned, "AQI") })
    }

    @Test fun unknownClosedAndWrongKindHandlesAreRefused() {
        val channel = DataChannel()
        assertEquals(DataChannel.HANDLE, code { channel.read("not-a-handle") })
        val reader = channel.openRead(file("{}".toByteArray()))
        assertEquals(DataChannel.HANDLE, code { channel.write(reader, "x") })
        replies(channel, reader); channel.close(reader)
        assertEquals(DataChannel.HANDLE, code { channel.close(reader) })
    }

    // D1c code review P2: every recovery snapshot (an operation's and the capture popup's) is written through a handle capped
    // at core's 128 MiB backup limit, so no snapshot a restore would refuse is ever published; past it the file goes.
    @Test fun aRecoveryWriteIsCappedAtTheBackupLimit() {
        assertEquals(128L * 1024 * 1024, DataChannel.RECOVERY_CAP_BYTES)
        val target = File(folder.root, ".capture.pending")
        val channel = DataChannel(recoveryCapBytes = 8)
        val handle = channel.openRecoveryWrite(target)
        channel.write(handle, "12345678")
        assertEquals(DataChannel.CAP, code { channel.write(handle, "9") })
        assertFalse(target.exists())
    }
}
