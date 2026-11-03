package tech.dongdongbh.mindwtr.androidwidget

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Date
import java.util.concurrent.Executor

data class QuickCaptureAudioDraft(
  val id: String,
  val createdAt: Date,
  val stagedFile: File,
  val dataBytes: Int,
)


object QuickCaptureWave {
  const val HEADER_SIZE = 44
  const val SAMPLE_RATE = 16_000
  const val CHANNELS = 1
  const val BITS_PER_SAMPLE = 16
  const val MINIMUM_DATA_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 150 / 1_000
  const val MAXIMUM_DATA_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 5 * 60

  private const val AUDIO_FORMAT_PCM = 1
  private const val BYTES_PER_FRAME = CHANNELS * (BITS_PER_SAMPLE / 8)
  private const val BYTE_RATE = SAMPLE_RATE * BYTES_PER_FRAME

  fun header(dataBytes: Int): ByteArray {
    require(dataBytes >= 0 && dataBytes <= MAXIMUM_DATA_BYTES && dataBytes % BYTES_PER_FRAME == 0)
    return ByteBuffer.allocate(HEADER_SIZE)
      .order(ByteOrder.LITTLE_ENDIAN)
      .put("RIFF".toByteArray(Charsets.US_ASCII))
      .putInt(36 + dataBytes)
      .put("WAVE".toByteArray(Charsets.US_ASCII))
      .put("fmt ".toByteArray(Charsets.US_ASCII))
      .putInt(16)
      .putShort(AUDIO_FORMAT_PCM.toShort())
      .putShort(CHANNELS.toShort())
      .putInt(SAMPLE_RATE)
      .putInt(BYTE_RATE)
      .putShort(BYTES_PER_FRAME.toShort())
      .putShort(BITS_PER_SAMPLE.toShort())
      .put("data".toByteArray(Charsets.US_ASCII))
      .putInt(dataBytes)
      .array()
  }

  fun isValid(file: File): Boolean {
    if (!file.isFile || file.length() < HEADER_SIZE) return false
    val bytes = try {
      RandomAccessFile(file, "r").use { input ->
        ByteArray(HEADER_SIZE).also { input.readFully(it) }
      }
    } catch (_: IOException) {
      return false
    }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    fun ascii(length: Int): String = ByteArray(length).also(buffer::get).toString(Charsets.US_ASCII)
    if (ascii(4) != "RIFF") return false
    val riffSize = buffer.int
    if (ascii(4) != "WAVE" || ascii(4) != "fmt ") return false
    if (buffer.int != 16) return false
    if (buffer.short.toInt() != AUDIO_FORMAT_PCM || buffer.short.toInt() != CHANNELS) return false
    if (buffer.int != SAMPLE_RATE || buffer.int != BYTE_RATE) return false
    if (buffer.short.toInt() != BYTES_PER_FRAME || buffer.short.toInt() != BITS_PER_SAMPLE) return false
    if (ascii(4) != "data") return false
    val dataBytes = buffer.int
    return dataBytes in MINIMUM_DATA_BYTES..MAXIMUM_DATA_BYTES &&
      dataBytes % BYTES_PER_FRAME == 0 &&
      riffSize == 36 + dataBytes &&
      file.length() == HEADER_SIZE.toLong() + dataBytes
  }
}


class QuickCaptureAudioRecorder(
  private val filesDir: File,
  private val sourceFactory: () -> PcmSource = { AndroidPcmSource() },
  private val idFactory: () -> String = { java.util.UUID.randomUUID().toString() },
  private val now: () -> Date = { Date() },
  private val callbackExecutor: Executor,
  private val maximumDataBytes: Int = QuickCaptureWave.MAXIMUM_DATA_BYTES,
) {
  interface PcmSource {
    val bufferSize: Int
    fun start()
    fun read(target: ByteArray, length: Int): Int
    fun stop()
    fun release()
  }

  sealed class Outcome {
    data class Ready(val draft: QuickCaptureAudioDraft) : Outcome()
    data object Cancelled : Outcome()
    data class Failed(val error: IOException) : Outcome()
  }

  private val lock = Any()
  @Volatile private var stopRequested = false
  @Volatile private var cancelRequested = false
  private var started = false
  private var activeSource: PcmSource? = null

  init {
    require(maximumDataBytes in QuickCaptureWave.MINIMUM_DATA_BYTES..QuickCaptureWave.MAXIMUM_DATA_BYTES)
    require(maximumDataBytes % 2 == 0)
  }

  fun start(callback: (Outcome) -> Unit) {
    synchronized(lock) {
      check(!started) { "Recorder instances can only be started once" }
      started = true
    }
    Thread({ record(callback) }, "MindwtrQuickCaptureAudio").apply {
      isDaemon = true
      start()
    }
  }

  fun stop() {
    stopRequested = true
    stopActiveSource()
  }

  fun cancel() {
    cancelRequested = true
    stopRequested = true
    stopActiveSource()
  }

  private fun stopActiveSource() {
    val source = synchronized(lock) { activeSource }
    try {
      source?.stop()
    } catch (_: RuntimeException) {

    }
  }

  private fun record(callback: (Outcome) -> Unit) {
    var stagedFile: File? = null
    var source: PcmSource? = null
    var outcome: Outcome
    try {
      val id = idFactory()
      if (!PendingCaptureWriter.isSafeAudioId(id)) throw IOException("Invalid audio capture id")
      val directory = File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY)
      if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Could not create audio directory")
      stagedFile = File(directory, ".$id.wav.tmp")
      val finalFile = File(directory, "$id.wav")
      if (stagedFile.exists() || finalFile.exists()) throw IOException("Audio capture already exists")

      source = sourceFactory()
      synchronized(lock) { activeSource = source }
      if (cancelRequested) {
        outcome = Outcome.Cancelled
      } else {
        val dataBytes = recordPcm(source, stagedFile)
        outcome = when {
          cancelRequested -> Outcome.Cancelled
          dataBytes < QuickCaptureWave.MINIMUM_DATA_BYTES -> Outcome.Failed(IOException("Recording was too short"))
          else -> {
            if (!QuickCaptureWave.isValid(stagedFile)) throw IOException("Recorded WAV is invalid")
            Outcome.Ready(QuickCaptureAudioDraft(id, now(), stagedFile, dataBytes))
          }
        }
      }
    } catch (error: Exception) {
      outcome = if (cancelRequested) {
        Outcome.Cancelled
      } else {
        Outcome.Failed(error as? IOException ?: IOException("Audio recording failed", error))
      }
    } finally {
      synchronized(lock) { activeSource = null }
      try {
        source?.stop()
      } catch (_: RuntimeException) {

      }
      try {
        source?.release()
      } catch (_: RuntimeException) {

      }
    }

    if (cancelRequested && outcome is Outcome.Ready) outcome = Outcome.Cancelled
    if (outcome !is Outcome.Ready) stagedFile?.delete()
    val terminalOutcome = outcome
    callbackExecutor.execute { callback(terminalOutcome) }
  }

  private fun recordPcm(source: PcmSource, stagedFile: File): Int {
    var dataBytes = 0
    RandomAccessFile(stagedFile, "rw").use { output ->
      output.setLength(0)
      output.write(QuickCaptureWave.header(0))
      if (!stopRequested) source.start()
      val buffer = ByteArray(maxOf(2, source.bufferSize))
      while (!stopRequested && dataBytes < maximumDataBytes) {
        val remaining = maximumDataBytes - dataBytes
        val requested = minOf(buffer.size, remaining)
        val read = try {
          source.read(buffer, requested)
        } catch (error: RuntimeException) {
          if (dataBytes >= QuickCaptureWave.MINIMUM_DATA_BYTES) break
          throw IOException("Audio source read failed", error)
        }
        if (read < 0) {
          if (!stopRequested && dataBytes < QuickCaptureWave.MINIMUM_DATA_BYTES) {
            throw IOException("Audio source read failed: $read")
          }
          break
        }
        if (read == 0) continue
        val completeFrames = minOf(read, requested) - (minOf(read, requested) % 2)
        if (completeFrames > 0) {
          output.write(buffer, 0, completeFrames)
          dataBytes += completeFrames
        }
      }
      if (!cancelRequested && dataBytes >= QuickCaptureWave.MINIMUM_DATA_BYTES) {
        output.seek(0)
        output.write(QuickCaptureWave.header(dataBytes))
        output.fd.sync()
      }
    }
    return dataBytes
  }

  private class AndroidPcmSource : PcmSource {
    override val bufferSize: Int = maxOf(
      4_096,
      AudioRecord.getMinBufferSize(
        QuickCaptureWave.SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      ),
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
}
