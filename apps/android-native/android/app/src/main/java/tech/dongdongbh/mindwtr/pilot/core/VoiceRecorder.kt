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


enum class VoiceFormat(val extension: String) {

    M4A(".m4a"),

    WAV(".wav"),
}


interface VoiceTake {

    fun started(done: (Result<Unit>) -> Unit)

    fun stop(done: (Result<File>) -> Unit)
    fun cancel(done: () -> Unit)
}


interface AudioFocus {
    fun request()
    fun abandon()
}


class VoiceRecorder(
    private val directory: File,
    private val executor: Executor,
    private val focus: AudioFocus,
    private val takes: (VoiceFormat, String) -> VoiceTake,
    private val ids: () -> String = { UUID.randomUUID().toString() },
) {
    class Refused(message: String) : IOException(message)


    class StartFailed(val format: VoiceFormat, cause: Throwable) : IOException("The $format recording could not start", cause)


    class Cancelled : IOException("The recording was cancelled")

    private class Owner(val id: String, val format: VoiceFormat, val take: VoiceTake) {
        var starting = true
        var ending = false
    }


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

        fun create(context: Context): VoiceRecorder {
            val app = context.applicationContext
            val directory = File(app.filesDir, DIRECTORY)
            sweep(directory)
            val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-voice") }
            return VoiceRecorder(directory, executor, AndroidAudioFocus(app), { format, id ->
                when (format) {
                    VoiceFormat.M4A -> M4aTake(directory, id, AndroidM4aSink(app))
                    VoiceFormat.WAV -> WavTake(directory, id, executor) { AndroidPcmSource() }
                }
            })
        }

        const val DIRECTORY = "voice-captures"

        private val RECORDING = Regex("^\\.?[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\\.(?:m4a|wav)(?:\\.tmp)?$")


        fun sweep(directory: File): Int {
            val staging = File(directory, "quick-capture-audio")
            var deleted = 0
            for (folder in listOf(directory, staging)) {
                val owner = runCatching { folder.canonicalFile }.getOrNull() ?: continue
                for (file in folder.listFiles() ?: continue) {
                    val name = file.name
                    val staged = name.startsWith(".") && name.endsWith(".tmp")
                    if (!RECORDING.matches(name) || (folder == staging && !staged)) continue
                    if (!file.isFile || runCatching { file.canonicalFile.parentFile }.getOrNull() != owner) continue
                    if (file.delete()) deleted += 1
                }
            }
            return deleted
        }
    }
}


object VoiceCapture {
    @Volatile var recorder: VoiceRecorder? = null

    fun recorderFor(context: Context): VoiceRecorder = recorder ?: synchronized(this) {
        recorder ?: VoiceRecorder.create(context).also { recorder = it }
    }
}


object ExpoHighQuality {
    const val SAMPLE_RATE = 44_100
    const val CHANNELS = 2
    const val BIT_RATE = 128_000
}


interface M4aSink {
    fun start(output: File)
    fun stop()
    fun release()
}


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


    override fun started(done: (Result<Unit>) -> Unit) = done(Result.success(Unit))

    override fun stop(done: (Result<File>) -> Unit) {

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


open class PermissionPrompt(private val post: (() -> Unit) -> Unit) {

    var launcher: (() -> Unit)? = null
    private val waiting = ArrayList<(Boolean) -> Unit>()

    fun ask(done: (Boolean) -> Unit) = post {
        val launch = launcher ?: return@post done(false)
        waiting.add(done)
        if (waiting.size == 1) runCatching { launch() }.onFailure { answered(false) }
    }


    fun answered(granted: Boolean) {
        val done = waiting.toList()
        waiting.clear()
        done.forEach { runCatching { it(granted) } }
    }
}

object MicrophonePermissionPrompt : PermissionPrompt({ action -> Handler(Looper.getMainLooper()).post(action) })
