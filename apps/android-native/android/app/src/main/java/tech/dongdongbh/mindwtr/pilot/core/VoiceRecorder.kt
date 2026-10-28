package tech.dongdongbh.mindwtr.pilot.core

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureAudioRecorder
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWave

/** RN's two recording formats (decision Q1): the caller passes the one core's resolveQuickCaptureAudioFormat picked. */
enum class VoiceFormat(val extension: String) {
    /** expo-audio's HIGH_QUALITY preset on Android, as RN records for the cloud providers ([ExpoHighQuality]). */
    M4A(".m4a"),
    /** 16 kHz mono PCM WAV through the widget's recorder, as RN's whisper.rn records for local Whisper. */
    WAV(".wav"),
}

/** One recording in progress. It owns its staged file: [stop] answers it complete; [cancel] and any failure delete it. */
interface VoiceTake {
    /** [done] once the microphone records, or with why it could not (then the take has ended and left no file). */
    fun started(done: (Result<Unit>) -> Unit)
    /** Ends the recording; [done] runs once the recorder is released (RN d596ecce6: stop it before transcribing). */
    fun stop(done: (Result<File>) -> Unit)
    fun cancel(done: () -> Unit)
}

/** Ducks other audio while recording, as RN's setAudioModeAsync interruptionModeAndroid 'duckOthers'. */
interface AudioFocus {
    fun request()
    fun abandon()
}

/**
 * The capture screens' microphone (voice pass V2): start, stop and cancel, each answered through a callback on [executor] like a
 * fetch, so no caller waits on the engine thread. One owner at a time (RN 9604387e4, c5fc870fe): a start while a recording runs or
 * ends is refused, and only the owner's id stops or cancels it. The recording stays staged until a stop succeeds, then takes its
 * final name in [directory]; a cancelled or failed one leaves no file. No foreground service: leaving the app cancels ([leave]).
 */
class VoiceRecorder(
    private val directory: File,
    private val executor: Executor,
    private val focus: AudioFocus,
    private val takes: (VoiceFormat, String) -> VoiceTake,
    private val ids: () -> String = { UUID.randomUUID().toString() },
) {
    class Refused(message: String) : IOException(message)

    /**
     * The microphone could not start in [format]. RN falls back to m4a when its Whisper start fails (use-quick-capture-audio.ts
     * 'Whisper realtime start failed, falling back to audio recording'); the caller does the same on a WAV one. The device is free.
     */
    class StartFailed(val format: VoiceFormat, cause: Throwable) : IOException("The $format recording could not start", cause)

    /** The app left before the microphone started: nothing was recorded, and nothing should be retried. */
    class Cancelled : IOException("The recording was cancelled")

    private class Owner(val id: String, val format: VoiceFormat, val take: VoiceTake) {
        var starting = true
        var ending = false
    }

    // Read and written on [executor] only.
    private var owner: Owner? = null

    fun start(format: VoiceFormat, reply: (Result<String>) -> Unit) = executor.execute {
        if (owner != null) return@execute reply(Result.failure(Refused("A recording is already running")))
        val id = ids()
        focus.request()
        val take = try {
            takes(format, id)
        } catch (error: Exception) {
            focus.abandon()
            return@execute reply(Result.failure(StartFailed(format, error)))
        }
        val current = Owner(id, format, take)
        owner = current
        // The reply waits for the microphone, so a WAV source that cannot open answers here, not at the stop.
        take.started { result ->
            executor.execute {
                current.starting = false
                val failure = result.exceptionOrNull()
                when {
                    current.ending -> reply(Result.failure(Cancelled()))
                    failure != null -> {
                        current.ending = true
                        if (owner === current) owner = null
                        focus.abandon()
                        reply(Result.failure(StartFailed(format, failure)))
                    }
                    else -> reply(Result.success(id))
                }
            }
        }
    }

    fun stop(id: String, reply: (Result<File>) -> Unit) = executor.execute {
        val current = owner?.takeIf { it.id == id && !it.starting && !it.ending }
            ?: return@execute reply(Result.failure(Refused("Not the running recording")))
        current.ending = true
        current.take.stop { result ->
            executor.execute {
                if (owner === current) owner = null
                focus.abandon()
                reply(result.mapCatching { staged -> keep(staged, File(directory, "${current.id}${current.format.extension}")) })
            }
        }
    }

    fun cancel(id: String) = executor.execute { end { it.id == id } }

    /** The app left the front: a recording still running ends without saving, as RN's sheet closing; a stop already asked keeps its answer. */
    fun leave() = executor.execute { end { true } }

    private fun end(matches: (Owner) -> Boolean) {
        val current = owner?.takeIf { matches(it) && !it.ending } ?: return
        current.ending = true
        current.take.cancel {
            executor.execute {
                if (owner === current) owner = null
                focus.abandon()
            }
        }
    }

    private fun keep(staged: File, final: File): File {
        if (final.exists() || !staged.renameTo(final)) {
            staged.delete()
            throw IOException("Could not keep the recording")
        }
        return final
    }

    companion object {
        /** The app's recorder: its own folder, apart from the widget's queue folder (QuickCaptureAudioCleanup expires that one). */
        fun create(context: Context): VoiceRecorder {
            val app = context.applicationContext
            val directory = File(app.filesDir, DIRECTORY)
            val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-voice") }
            return VoiceRecorder(directory, executor, AndroidAudioFocus(app), { format, id ->
                when (format) {
                    VoiceFormat.M4A -> M4aTake(directory, id, AndroidM4aSink(app))
                    VoiceFormat.WAV -> WavTake(directory, id, executor) { AndroidPcmSource() }
                }
            })
        }

        const val DIRECTORY = "voice-captures"
    }
}

/** The process's recorder, set by the bundle's voice host (pass V3); MainActivity tells it when the app leaves the front. */
object VoiceCapture {
    @Volatile var recorder: VoiceRecorder? = null
}

/** RN's m4a settings: expo-audio 1.1.1 RecordingPresets.HIGH_QUALITY (src/RecordingConstants.ts), its Android part. */
object ExpoHighQuality {
    const val SAMPLE_RATE = 44_100
    const val CHANNELS = 2
    const val BIT_RATE = 128_000
}

/** The m4a encoder: MediaRecorder on the device, a stand-in in the JVM tests. */
interface M4aSink {
    fun start(output: File)
    fun stop()
    fun release()
}

/** An m4a recording, staged as `.<id>.m4a.tmp` in [directory]. */
class M4aTake(directory: File, id: String, private val sink: M4aSink) : VoiceTake {
    private val staged = File(directory, ".$id.m4a.tmp")

    init {
        try {
            if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Could not create the recording folder")
            if (staged.exists()) throw IOException("The recording already exists")
            sink.start(staged)
        } catch (error: Exception) {
            runCatching { sink.release() }
            staged.delete()
            throw error
        }
    }

    // MediaRecorder.start ran in the constructor: a take that exists records.
    override fun started(done: (Result<Unit>) -> Unit) = done(Result.success(Unit))

    override fun stop(done: (Result<File>) -> Unit) {
        // MediaRecorder.stop throws when nothing was recorded.
        val stopped = runCatching { sink.stop() }
        runCatching { sink.release() }
        val result = stopped.mapCatching { if (staged.length() > 0) staged else throw IOException("Nothing was recorded") }
        if (result.isFailure) staged.delete()
        done(result)
    }

    override fun cancel(done: () -> Unit) {
        runCatching { sink.stop() }
        runCatching { sink.release() }
        staged.delete()
        done()
    }
}

/** expo-audio's Android recorder with RN's HIGH_QUALITY options, in expo's call order (AudioRecorder.setRecordingOptions). */
class AndroidM4aSink(private val context: Context) : M4aSink {
    private var recorder: MediaRecorder? = null

    override fun start(output: File) {
        val created = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        recorder = created
        created.setAudioSource(MediaRecorder.AudioSource.MIC)
        created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        created.setAudioSamplingRate(ExpoHighQuality.SAMPLE_RATE)
        created.setAudioChannels(ExpoHighQuality.CHANNELS)
        created.setAudioEncodingBitRate(ExpoHighQuality.BIT_RATE)
        created.setOutputFile(output.absolutePath)
        created.prepare()
        created.start()
    }

    override fun stop() {
        recorder?.stop()
    }

    override fun release() {
        recorder?.release()
        recorder = null
    }
}

/**
 * A WAV recording through the widget's QuickCaptureAudioRecorder, unchanged: it stages `quick-capture-audio/.<id>.wav.tmp` under
 * [directory], deletes it itself when cancelled or failed, and answers on [callbacks]. Its source is wrapped only to tell when the
 * microphone started; a source that cannot open or start ends the recorder before that.
 */
class WavTake(
    directory: File,
    id: String,
    callbacks: Executor,
    sourceFactory: () -> QuickCaptureAudioRecorder.PcmSource,
) : VoiceTake {
    private val lock = Any()
    private var startResult: Result<Unit>? = null
    private var startWaiting: ((Result<Unit>) -> Unit)? = null
    private var outcome: QuickCaptureAudioRecorder.Outcome? = null
    private var waiting: ((QuickCaptureAudioRecorder.Outcome) -> Unit)? = null

    private inner class Signalled(private val inner: QuickCaptureAudioRecorder.PcmSource) : QuickCaptureAudioRecorder.PcmSource by inner {
        override fun start() {
            inner.start()
            settleStart(Result.success(Unit))
        }
    }

    private val recorder = QuickCaptureAudioRecorder(
        filesDir = directory,
        sourceFactory = { Signalled(sourceFactory()) },
        idFactory = { id },
        callbackExecutor = callbacks,
    )

    init {
        recorder.start { ended ->
            // An end before the microphone started is the start's answer too.
            settleStart(Result.failure((ended as? QuickCaptureAudioRecorder.Outcome.Failed)?.error ?: IOException("The recording ended before it started")))
            val next = synchronized(lock) {
                outcome = ended
                waiting.also { waiting = null }
            }
            next?.invoke(ended)
        }
    }

    private fun settleStart(result: Result<Unit>) {
        val next = synchronized(lock) {
            if (startResult != null) return
            startResult = result
            startWaiting.also { startWaiting = null }
        }
        next?.invoke(result)
    }

    override fun started(done: (Result<Unit>) -> Unit) {
        val result = synchronized(lock) { startResult.also { if (it == null) startWaiting = done } }
        result?.let(done)
    }

    // The recorder answers once, possibly before a stop was asked (a failed source): the answer waits for the caller.
    private fun whenEnded(action: (QuickCaptureAudioRecorder.Outcome) -> Unit) {
        val ended = synchronized(lock) { outcome.also { if (it == null) waiting = action } }
        ended?.let(action)
    }

    override fun stop(done: (Result<File>) -> Unit) {
        recorder.stop()
        whenEnded { ended ->
            done(when (ended) {
                is QuickCaptureAudioRecorder.Outcome.Ready -> Result.success(ended.draft.stagedFile)
                is QuickCaptureAudioRecorder.Outcome.Failed -> Result.failure(ended.error)
                QuickCaptureAudioRecorder.Outcome.Cancelled -> Result.failure(IOException("The recording was cancelled"))
            })
        }
    }

    override fun cancel(done: () -> Unit) {
        recorder.cancel()
        whenEnded { ended ->
            if (ended is QuickCaptureAudioRecorder.Outcome.Ready) ended.draft.stagedFile.delete()
            done()
        }
    }
}

/**
 * The widget recorder's own microphone source (QuickCaptureAudioRecorder.AndroidPcmSource is private to :widget), with the same
 * settings: voice recognition, 16 kHz mono 16-bit PCM, a buffer of at least 4 KiB.
 */
class AndroidPcmSource : QuickCaptureAudioRecorder.PcmSource {
    override val bufferSize: Int = maxOf(
        4_096,
        AudioRecord.getMinBufferSize(QuickCaptureWave.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
    )

    @SuppressLint("MissingPermission")
    private val recorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        QuickCaptureWave.SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferSize,
    ).also {
        if (it.state != AudioRecord.STATE_INITIALIZED) {
            it.release()
            throw IOException("Could not initialize audio recorder")
        }
    }

    override fun start() {
        recorder.startRecording()
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            throw IOException("Could not start audio recorder")
        }
    }

    override fun read(target: ByteArray, length: Int): Int = recorder.read(target, 0, length)

    override fun stop() {
        if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
    }

    override fun release() = recorder.release()
}

/** Transient focus that lets other audio duck (RN's interruptionModeAndroid 'duckOthers'); a refusal still records, as RN does. */
class AndroidAudioFocus(context: Context) : AudioFocus {
    private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val listener = AudioManager.OnAudioFocusChangeListener { }
    private var request: AudioFocusRequest? = null

    override fun request() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val next = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(listener)
                .build()
            request = next
            audio.requestAudioFocus(next)
        } else {
            @Suppress("DEPRECATION")
            audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        }
    }

    override fun abandon() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            request?.let(audio::abandonAudioFocusRequest)
            request = null
        } else {
            @Suppress("DEPRECATION")
            audio.abandonAudioFocus(listener)
        }
    }
}

/**
 * The system microphone prompt, on the open screen (MainActivity registers [launcher] and hands each answer to [answered]), as
 * the calendar prompt: an ask while one shows waits for the same answer; with no screen it answers false at once.
 */
open class PermissionPrompt(private val post: (() -> Unit) -> Unit) {
    /** The open Activity's launcher; null while none is open. Main thread. */
    var launcher: (() -> Unit)? = null
    private val waiting = ArrayList<(Boolean) -> Unit>()

    fun ask(done: (Boolean) -> Unit) = post {
        val launch = launcher ?: return@post done(false)
        waiting.add(done)
        if (waiting.size == 1) runCatching { launch() }.onFailure { answered(false) }
    }

    /** The prompt closed with [granted]. Main thread. */
    fun answered(granted: Boolean) {
        val done = waiting.toList()
        waiting.clear()
        done.forEach { runCatching { it(granted) } }
    }
}

object MicrophonePermissionPrompt : PermissionPrompt({ action -> Handler(Looper.getMainLooper()).post(action) })
