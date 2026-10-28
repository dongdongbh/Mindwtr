package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.Executor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Voice pass V3: the bundle's microphone calls answer like a fetch, with fixed codes host-voice.ts reads (its m4a fallback included). */
class HostVoiceTest {
    private val direct = Executor { it.run() }

    private class Sink(private val failStart: Boolean = false) : M4aSink {
        override fun start(output: File) {
            output.writeBytes(ByteArray(16))
            if (failStart) throw IOException("No microphone")
        }
        override fun stop() = Unit
        override fun release() = Unit
    }

    private class Focus : AudioFocus {
        override fun request() = Unit
        override fun abandon() = Unit
    }

    private fun host(granted: Boolean = true, failStart: Boolean = false, prompt: PermissionPrompt = PermissionPrompt { it() }): Pair<HostVoice, File> {
        val dir = File(Files.createTempDirectory("mindwtr-voice").toFile(), VoiceRecorder.DIRECTORY)
        val recorder = VoiceRecorder(dir, direct, Focus(), { _, id -> M4aTake(dir, id, Sink(failStart)) }, { "id-1" })
        return HostVoice({ granted }, { recorder }, prompt) to dir
    }

    private fun answer(host: HostVoice, request: String): Result<Any?> {
        var result: Result<Any?>? = null
        host.call(request) { result = it }
        return result!!
    }

    @Test fun aStartAndStopAnswerTheRecordingsIdThenItsFileUriAndSize() {
        val (host, dir) = host()
        val started = answer(host, """{"op":"start","format":"m4a"}""").getOrThrow() as JSONObject
        assertEquals("id-1", started.getString("id"))
        val stopped = answer(host, """{"op":"stop","id":"id-1"}""").getOrThrow() as JSONObject
        assertEquals("file://${File(dir, "id-1.m4a").absolutePath}", stopped.getString("uri"))
        assertEquals(16L, stopped.getLong("size"))
    }

    @Test fun aStartThatCannotOpenTheMicrophoneAnswersTheCodeTheFallbackReads() {
        val (host, _) = host(failStart = true)
        assertEquals("E_VOICE_START_FAILED", answer(host, """{"op":"start","format":"m4a"}""").exceptionOrNull()?.message)
        assertEquals("E_VOICE_BUSY", HostVoice.code(VoiceRecorder.Refused("busy")))
        assertEquals("E_VOICE_CANCELLED", HostVoice.code(VoiceRecorder.Cancelled()))
        assertEquals("E_VOICE_FAILED", HostVoice.code(IOException("/data/user/0/secret/path")))
    }

    @Test fun thePermissionAsksOnlyWhenNotGrantedAndAnswersTheUsersChoice() {
        var asked = 0
        val prompt = PermissionPrompt { it() }.apply { launcher = { asked += 1 } }
        val (granted, _) = host(granted = true, prompt = prompt)
        assertEquals("granted", answer(granted, """{"op":"permission"}""").getOrThrow())
        assertEquals(0, asked)

        val (refused, _) = host(granted = false, prompt = prompt)
        var reply: Result<Any?>? = null
        refused.call("""{"op":"permission"}""") { reply = it }
        assertEquals(1, asked)
        prompt.answered(false)
        assertEquals("denied", reply!!.getOrThrow())
    }

    @Test fun anUnknownCallOrFormatNeverThrowsIntoTheBridge() {
        val (host, _) = host()
        assertEquals("E_VOICE_UNKNOWN", answer(host, """{"op":"dance"}""").exceptionOrNull()?.message)
        assertTrue(runCatching { HostVoice.format("ogg") }.isFailure)
    }
}
