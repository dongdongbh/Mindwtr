package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureAudioRecorder
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWave

/** Voice pass V2: the microphone's ownership, its staged files and their names, and leaving the app. No device: stand-in encoders. */
class VoiceRecorderTest {
    private val direct = Executor { it.run() }
    private fun folder(): File = File(Files.createTempDirectory("mindwtr-voice").toFile(), VoiceRecorder.DIRECTORY)
    private fun filesUnder(dir: File): List<String> = dir.walkTopDown().filter { it.isFile }.map { it.relativeTo(dir).path }.sorted().toList()

    private class FakeSink(private val bytes: Int = 64, private val failStart: Boolean = false, private val failStop: Boolean = false) : M4aSink {
        val events = mutableListOf<String>()
        private var output: File? = null
        override fun start(output: File) {
            events += "start"
            this.output = output
            output.writeBytes(ByteArray(bytes))
            if (failStart) throw IOException("No microphone")
        }
        override fun stop() {
            events += "stop"
            if (failStop) throw RuntimeException("stop failed")
        }
        override fun release() {
            events += "release"
        }
    }

    private class FakeFocus : AudioFocus {
        var requested = 0
        var abandoned = 0
        override fun request() { requested += 1 }
        override fun abandon() { abandoned += 1 }
    }

    /** A take whose stop answers only when the test says so (a WAV worker still finishing). */
    private class HeldTake(private val staged: File) : VoiceTake {
        var finish: (() -> Unit)? = null
        var cancelled = false
        init { staged.parentFile.mkdirs(); staged.writeBytes(ByteArray(8)) }
        override fun stop(done: (Result<File>) -> Unit) { finish = { done(Result.success(staged)) } }
        override fun cancel(done: () -> Unit) { cancelled = true; staged.delete(); done() }
    }

    private fun m4aRecorder(dir: File, focus: AudioFocus = FakeFocus(), sink: () -> FakeSink = { FakeSink() }, ids: () -> String = { "id-1" }) =
        VoiceRecorder(dir, direct, focus, { _, id -> M4aTake(dir, id, sink()) }, ids)

    private fun <T> answer(call: ((Result<T>) -> Unit) -> Unit): Result<T> {
        val result = AtomicReference<Result<T>>()
        call { result.set(it) }
        return result.get()
    }

    @Test fun anM4aRecordingTakesItsIdAndTheM4aExtensionOnlyWhenItStops() {
        val dir = folder()
        val focus = FakeFocus()
        val recorder = m4aRecorder(dir, focus)
        val id = answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow()
        assertEquals(listOf(".id-1.m4a.tmp"), filesUnder(dir))
        val kept = answer<File> { recorder.stop(id, it) }.getOrThrow()
        assertEquals(File(dir, "id-1.m4a"), kept)
        assertEquals(listOf("id-1.m4a"), filesUnder(dir))
        assertEquals(1, focus.requested)
        assertEquals(1, focus.abandoned)
    }

    @Test fun aWavRecordingGoesThroughTheWidgetRecorderAndKeepsTheWavExtension() {
        val dir = folder()
        val worker = Executors.newSingleThreadExecutor()
        val source = OneChunkSource()
        val id = "01234567-89ab-cdef-0123-456789abcdef"
        val recorder = VoiceRecorder(dir, worker, FakeFocus(), { _, takeId -> WavTake(dir, takeId, worker) { source } }, { id })
        val started = CountDownLatch(1)
        recorder.start(VoiceFormat.WAV) { started.countDown() }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        assertTrue(source.delivered.await(2, TimeUnit.SECONDS))
        val kept = AtomicReference<Result<File>>()
        val stopped = CountDownLatch(1)
        recorder.stop(id) { kept.set(it); stopped.countDown() }
        assertTrue(stopped.await(2, TimeUnit.SECONDS))
        assertEquals(File(dir, "$id.wav"), kept.get().getOrThrow())
        assertTrue(QuickCaptureWave.isValid(kept.get().getOrThrow()))
        assertEquals(listOf("$id.wav"), filesUnder(dir))
        worker.shutdown()
    }

    // RN 9604387e4 and c5fc870fe: one owner; a second start, or another id's stop, is refused.
    @Test fun aSecondStartIsRefusedWhileARecordingRunsOrEnds() {
        val dir = folder()
        var next = 0
        var held: HeldTake? = null
        val recorder = VoiceRecorder(dir, direct, FakeFocus(), { _, id -> HeldTake(File(dir, ".$id.m4a.tmp")).also { held = it } }, { "id-${++next}" })
        val first = answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow()
        assertTrue(answer<String> { recorder.start(VoiceFormat.M4A, it) }.exceptionOrNull() is VoiceRecorder.Refused)
        assertTrue(answer<File> { recorder.stop("someone-else", it) }.exceptionOrNull() is VoiceRecorder.Refused)
        val stopping = AtomicReference<Result<File>>()
        recorder.stop(first) { stopping.set(it) }
        // Still ending: the device is not free yet.
        assertTrue(answer<String> { recorder.start(VoiceFormat.WAV, it) }.exceptionOrNull() is VoiceRecorder.Refused)
        held!!.finish!!()
        assertEquals(File(dir, "$first.m4a"), stopping.get().getOrThrow())
        assertEquals("id-2", answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow())
    }

    @Test fun aCancelledOrFailedStartLeavesNoFile() {
        val dir = folder()
        val focus = FakeFocus()
        val recorder = m4aRecorder(dir, focus)
        val id = answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow()
        recorder.cancel(id)
        assertEquals(emptyList<String>(), filesUnder(dir))
        assertEquals(1, focus.abandoned)

        val failing = m4aRecorder(dir, focus, sink = { FakeSink(failStart = true) }, ids = { "id-2" })
        assertTrue(answer<String> { failing.start(VoiceFormat.M4A, it) }.isFailure)
        assertEquals(emptyList<String>(), filesUnder(dir))
        assertEquals(2, focus.abandoned)
        // The failed start left the device free.
        val working = m4aRecorder(dir, focus, ids = { "id-3" })
        assertTrue(answer<String> { working.start(VoiceFormat.M4A, it) }.isSuccess)
    }

    @Test fun theStagedFileTakesItsFinalNameOnlyOnASuccessfulStop() {
        val dir = folder()
        val failing = m4aRecorder(dir, sink = { FakeSink(failStop = true) })
        val id = answer<String> { failing.start(VoiceFormat.M4A, it) }.getOrThrow()
        assertTrue(answer<File> { failing.stop(id, it) }.isFailure)
        assertEquals(emptyList<String>(), filesUnder(dir))

        val empty = m4aRecorder(dir, sink = { FakeSink(bytes = 0) }, ids = { "id-2" })
        val emptyId = answer<String> { empty.start(VoiceFormat.M4A, it) }.getOrThrow()
        assertTrue(answer<File> { empty.stop(emptyId, it) }.isFailure)
        assertEquals(emptyList<String>(), filesUnder(dir))
    }

    @Test fun leavingTheAppCancelsARecordingButNotAStopAlreadyAsked() {
        val dir = folder()
        val focus = FakeFocus()
        val recorder = m4aRecorder(dir, focus)
        answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow()
        recorder.leave()
        assertEquals(emptyList<String>(), filesUnder(dir))
        assertEquals(1, focus.abandoned)

        var held: HeldTake? = null
        val ending = VoiceRecorder(dir, direct, FakeFocus(), { _, id -> HeldTake(File(dir, ".$id.m4a.tmp")).also { held = it } }, { "id-9" })
        val id = answer<String> { ending.start(VoiceFormat.M4A, it) }.getOrThrow()
        val kept = AtomicReference<Result<File>>()
        ending.stop(id) { kept.set(it) }
        ending.leave()
        assertFalse(held!!.cancelled)
        held!!.finish!!()
        assertEquals(File(dir, "id-9.m4a"), kept.get().getOrThrow())
    }

    // RN d596ecce6: the recorder is stopped and released before anyone transcribes the file.
    @Test fun aStopAnswersOnlyOnceTheRecorderIsReleased() {
        val dir = folder()
        val sink = FakeSink()
        val recorder = m4aRecorder(dir, sink = { sink })
        val id = answer<String> { recorder.start(VoiceFormat.M4A, it) }.getOrThrow()
        var eventsAtAnswer: List<String>? = null
        recorder.stop(id) { eventsAtAnswer = sink.events.toList() }
        assertEquals(listOf("start", "stop", "release"), eventsAtAnswer)
    }

    @Test fun microphonePromptsShareOneAnswerAndNoScreenAnswersNo() {
        val prompt = PermissionPrompt { it() }
        var answered: Boolean? = null
        prompt.ask { answered = it }
        assertEquals(false, answered)

        var launches = 0
        prompt.launcher = { launches += 1 }
        val answers = mutableListOf<Boolean>()
        prompt.ask { answers += it }
        prompt.ask { answers += it }
        assertEquals(1, launches)
        prompt.answered(true)
        assertEquals(listOf(true, true), answers)
    }

    @Test fun m4aUsesRnsExpoHighQualityPreset() {
        // expo-audio 1.1.1 src/RecordingConstants.ts HIGH_QUALITY: 44100 Hz, 2 channels, 128000 bps, mpeg4 + aac on Android.
        assertEquals(44_100, ExpoHighQuality.SAMPLE_RATE)
        assertEquals(2, ExpoHighQuality.CHANNELS)
        assertEquals(128_000, ExpoHighQuality.BIT_RATE)
        assertEquals(".m4a", VoiceFormat.M4A.extension)
        assertEquals(".wav", VoiceFormat.WAV.extension)
    }

    /** One 0.2 s chunk of PCM, then silence until the recorder stops it. */
    private class OneChunkSource : QuickCaptureAudioRecorder.PcmSource {
        val delivered = CountDownLatch(1)
        private val stopped = CountDownLatch(1)
        private var sent = false
        override val bufferSize = 6_400
        override fun start() = Unit
        override fun read(target: ByteArray, length: Int): Int {
            if (!sent) {
                sent = true
                target.fill(3, 0, length)
                delivered.countDown()
                return length
            }
            stopped.await(2, TimeUnit.SECONDS)
            return -1
        }
        override fun stop() { stopped.countDown() }
        override fun release() { stopped.countDown() }
    }
}
