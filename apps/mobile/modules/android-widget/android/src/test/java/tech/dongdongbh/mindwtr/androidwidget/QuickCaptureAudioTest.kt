package tech.dongdongbh.mindwtr.androidwidget

import java.io.File
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class QuickCaptureAudioTest {
  private fun tempFilesDir(): File = Files.createTempDirectory("mindwtr-audio-files").toFile()

  private fun expoFileUri(file: File): String =
    URI("file", "", file.absolutePath, null).toASCIIString()

  private fun stageDraft(
    filesDir: File,
    id: String = "01234567-89ab-cdef-0123-456789abcdef",
    dataBytes: Int = 6_400,
  ): QuickCaptureAudioDraft {
    val directory = File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY).apply { mkdirs() }
    val staged = File(directory, ".$id.wav.tmp")
    staged.outputStream().use { output ->
      output.write(QuickCaptureWave.header(dataBytes))
      output.write(ByteArray(dataBytes) { (it % 127).toByte() })
    }
    return QuickCaptureAudioDraft(id, Date(0), staged, dataBytes)
  }

  @Test
  fun canonicalHeaderIs16kMonoSignedPcm16() {
    val header = QuickCaptureWave.header(6_400)
    val littleEndian = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)

    assertEquals(44, header.size)
    assertEquals("RIFF", header.copyOfRange(0, 4).toString(Charsets.US_ASCII))
    assertEquals(6_436, littleEndian.getInt(4))
    assertEquals("WAVE", header.copyOfRange(8, 12).toString(Charsets.US_ASCII))
    assertEquals("fmt ", header.copyOfRange(12, 16).toString(Charsets.US_ASCII))
    assertEquals(16, littleEndian.getInt(16))
    assertEquals(1, littleEndian.getShort(20).toInt())
    assertEquals(1, littleEndian.getShort(22).toInt())
    assertEquals(16_000, littleEndian.getInt(24))
    assertEquals(32_000, littleEndian.getInt(28))
    assertEquals(2, littleEndian.getShort(32).toInt())
    assertEquals(16, littleEndian.getShort(34).toInt())
    assertEquals("data", header.copyOfRange(36, 40).toString(Charsets.US_ASCII))
    assertEquals(6_400, littleEndian.getInt(40))
  }

  @Test
  fun publishesCanonicalWavBeforeMatchingAudioQueueJson() {
    val filesDir = tempFilesDir()
    val draft = stageDraft(filesDir)

    val note = "  @home #literal\nKeep this note  "
    val queued = PendingCaptureWriter.publishAudio(filesDir, draft, "  Call Alex  ", note, "waiting", "inbox")

    val finalAudio = File(File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY), "${draft.id}.wav")
    assertTrue(finalAudio.isFile)
    assertTrue(QuickCaptureWave.isValid(finalAudio))
    assertFalse(draft.stagedFile.exists())
    assertEquals("${draft.id}.json", queued.name)
    val json = JSONObject(queued.readText())
    assertEquals("audio", json.getString("kind"))
    assertEquals(draft.id, json.getString("id"))
    assertEquals(draft.id, queued.name.removeSuffix(".json"))
    assertEquals(expoFileUri(finalAudio), json.getString("audioPath"))
    assertEquals("android-quick-capture", json.getString("source"))
    assertEquals("1970-01-01T00:00:00.000Z", json.getString("createdAt"))
    assertEquals("Call Alex", json.getString("title"))
    assertEquals(note, json.getString("note"))
    assertEquals("waiting", json.getString("defaultStatus"))
    assertEquals("inbox", json.getString("status"))
  }

  @Test
  fun failedJsonPublicationKeepsFinalWavForSameUuidRetry() {
    val filesDir = tempFilesDir()
    val draft = stageDraft(filesDir)
    val queueDirectory = File(filesDir, PendingCaptureWriter.DIRECTORY).apply { mkdirs() }
    val blockingTempDirectory = File(queueDirectory, "${draft.id}.tmp").apply { mkdirs() }
    val note = "  Note retained across\npublication failure  "

    try {
      PendingCaptureWriter.publishAudio(filesDir, draft, "Prefix", note, "someday", "next")
      fail("Expected JSON publication to fail")
    } catch (_: IOException) {
      // Expected: the WAV is already durable and remains retryable.
    }

    val finalAudio = File(File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY), "${draft.id}.wav")
    assertTrue(finalAudio.isFile)
    assertFalse(draft.stagedFile.exists())
    assertFalse(File(queueDirectory, "${draft.id}.json").exists())

    assertTrue(blockingTempDirectory.delete())
    val queued = PendingCaptureWriter.publishAudio(filesDir = filesDir, draft = draft, rawTitle = "Prefix", note = note, defaultStatus = "someday", status = "next")
    assertTrue(queued.isFile)
    assertEquals(expoFileUri(finalAudio), JSONObject(queued.readText()).getString("audioPath"))
    assertEquals(note, JSONObject(queued.readText()).getString("note"))
    assertEquals("someday", JSONObject(queued.readText()).getString("defaultStatus"))
    assertEquals("next", JSONObject(queued.readText()).getString("status"))
  }

  @Test
  fun audioUriKeepsContextFilesDirIdentityWhileOwnershipValidationUsesCanonicalPath() {
    val realFilesDir = tempFilesDir()
    val aliasParent = Files.createTempDirectory("mindwtr-context-alias")
    val contextFilesDir = aliasParent.resolve("context-files").toFile()
    Files.createSymbolicLink(contextFilesDir.toPath(), realFilesDir.toPath())
    val draft = stageDraft(contextFilesDir)

    val queued = PendingCaptureWriter.publishAudio(contextFilesDir, draft, "")

    val contextTarget = File(File(contextFilesDir, PendingCaptureWriter.AUDIO_DIRECTORY), "${draft.id}.wav")
    val audioUri = JSONObject(queued.readText()).getString("audioPath")
    assertEquals(expoFileUri(contextTarget), audioUri)
    assertTrue(audioUri.startsWith("file:///"))
    assertFalse(audioUri.contains(realFilesDir.canonicalPath))
    assertTrue(contextTarget.canonicalFile.isFile)
  }

  @Test
  fun exactQueuedRetryIsIdempotentButDistinctJsonIsNeverOverwritten() {
    val filesDir = tempFilesDir()
    val draft = stageDraft(filesDir)
    val queued = PendingCaptureWriter.publishAudio(filesDir, draft, "Prefix")
    val original = queued.readText()

    assertEquals(queued, PendingCaptureWriter.publishAudio(filesDir, draft, "Prefix"))
    assertEquals(original, queued.readText())

    queued.writeText(JSONObject(original).put("title", "Different").toString())
    val distinct = queued.readText()
    try {
      PendingCaptureWriter.publishAudio(filesDir, draft, "Prefix")
      fail("Expected distinct existing queue JSON to be rejected")
    } catch (_: IOException) {
      // Expected.
    }
    assertEquals(distinct, queued.readText())
  }

  @Test
  fun refusesMalformedOrForeignDraftWithoutDeletingIt() {
    val filesDir = tempFilesDir()
    val outside = File(filesDir, "outside.wav.tmp").apply { writeBytes(byteArrayOf(1, 2, 3)) }
    val foreign = QuickCaptureAudioDraft(
      "01234567-89ab-cdef-0123-456789abcdef",
      Date(0),
      outside,
      3,
    )

    try {
      PendingCaptureWriter.publishAudio(filesDir, foreign, "")
      fail("Expected foreign draft to be rejected")
    } catch (_: IOException) {
      // Expected.
    }

    assertTrue(outside.isFile)
    assertFalse(File(filesDir, PendingCaptureWriter.DIRECTORY).exists())
  }

  @Test
  fun explicitDiscardDeletesOnlyUnqueuedAudioDraft() {
    val filesDir = tempFilesDir()
    val draft = stageDraft(filesDir)
    val unrelated = File(filesDir, "keep.txt").apply { writeText("keep") }

    assertTrue(PendingCaptureWriter.discardAudioDraft(filesDir, draft))

    assertFalse(draft.stagedFile.exists())
    assertTrue(unrelated.isFile)
  }

  @Test
  fun discardRefusesAlreadyQueuedAudio() {
    val filesDir = tempFilesDir()
    val draft = stageDraft(filesDir)
    val queued = PendingCaptureWriter.publishAudio(filesDir, draft, "")
    val audio = File(File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY), "${draft.id}.wav")

    assertFalse(PendingCaptureWriter.discardAudioDraft(filesDir, draft))
    assertTrue(queued.isFile)
    assertTrue(audio.isFile)
  }

  @Test
  fun publishesDistinctAudioCapturesWithoutOverwriting() {
    val filesDir = tempFilesDir()
    val first = stageDraft(filesDir, "01234567-89ab-cdef-0123-456789abcdef")
    val second = stageDraft(filesDir, "fedcba98-7654-3210-fedc-ba9876543210")

    val firstQueue = PendingCaptureWriter.publishAudio(filesDir, first, "")
    val secondQueue = PendingCaptureWriter.publishAudio(filesDir, second, "")

    assertEquals(setOf(firstQueue.name, secondQueue.name), File(filesDir, PendingCaptureWriter.DIRECTORY).list()!!.toSet())
    assertEquals(2, File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY).listFiles()!!.count { it.extension == "wav" })
  }

  @Test
  fun stopFinalizesCanonicalWavOnceOffTheCallerThread() {
    val filesDir = tempFilesDir()
    val source = BlockingPcmSource(ByteArray(6_400) { 7 })
    val callbacks = AtomicInteger(0)
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = { source },
      idFactory = { "01234567-89ab-cdef-0123-456789abcdef" },
      now = { Date(0) },
      callbackExecutor = Executor { it.run() },
    )

    recorder.start {
      callbacks.incrementAndGet()
      outcome.set(it)
      finished.countDown()
    }
    assertTrue(source.firstRead.await(2, TimeUnit.SECONDS))
    recorder.stop()
    recorder.stop()

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(1, callbacks.get())
    val ready = outcome.get() as? QuickCaptureAudioRecorder.Outcome.Ready
    assertNotNull(ready)
    assertEquals(6_400, ready!!.draft.dataBytes)
    assertTrue(QuickCaptureWave.isValid(ready.draft.stagedFile))
    assertTrue(source.released)
  }

  @Test
  fun cancellationDiscardsOnlyTheCurrentRecorderStagingFile() {
    val filesDir = tempFilesDir()
    val source = BlockingPcmSource(ByteArray(6_400) { 9 })
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = { source },
      idFactory = { "01234567-89ab-cdef-0123-456789abcdef" },
      callbackExecutor = Executor { it.run() },
    )

    recorder.start {
      outcome.set(it)
      finished.countDown()
    }
    assertTrue(source.firstRead.await(2, TimeUnit.SECONDS))
    recorder.cancel()

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertTrue(outcome.get() is QuickCaptureAudioRecorder.Outcome.Cancelled)
    val audioDirectory = File(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY)
    assertTrue(audioDirectory.listFiles().orEmpty().isEmpty())
    assertTrue(source.released)
  }

  @Test
  fun automaticallyStopsAtConfiguredBoundWithValidWav() {
    val filesDir = tempFilesDir()
    val source = RepeatingPcmSource(1_024)
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = { source },
      idFactory = { "01234567-89ab-cdef-0123-456789abcdef" },
      callbackExecutor = Executor { it.run() },
      maximumDataBytes = 6_400,
    )

    recorder.start {
      outcome.set(it)
      finished.countDown()
    }

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    val ready = outcome.get() as? QuickCaptureAudioRecorder.Outcome.Ready
    assertNotNull(ready)
    assertEquals(6_400, ready!!.draft.dataBytes)
    assertEquals(QuickCaptureWave.HEADER_SIZE + 6_400L, ready.draft.stagedFile.length())
    assertTrue(QuickCaptureWave.isValid(ready.draft.stagedFile))
    assertTrue(source.released)
  }

  @Test
  fun cancelBeforeSourceInitializationFinishesStillTerminatesOnceOffThread() {
    val filesDir = tempFilesDir()
    val factoryEntered = CountDownLatch(1)
    val releaseFactory = CountDownLatch(1)
    val source = TrackingPcmSource()
    val callbacks = AtomicInteger(0)
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = {
        factoryEntered.countDown()
        releaseFactory.await(2, TimeUnit.SECONDS)
        source
      },
      callbackExecutor = Executor { it.run() },
    )

    recorder.start {
      callbacks.incrementAndGet()
      outcome.set(it)
      finished.countDown()
    }
    assertTrue(factoryEntered.await(2, TimeUnit.SECONDS))
    recorder.cancel()
    releaseFactory.countDown()

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(1, callbacks.get())
    assertTrue(outcome.get() is QuickCaptureAudioRecorder.Outcome.Cancelled)
    assertFalse(source.started)
    assertTrue(source.released)
  }

  @Test
  fun stopBeforeSourceInitializationFinishesReturnsOneTerminalFailure() {
    val filesDir = tempFilesDir()
    val factoryEntered = CountDownLatch(1)
    val releaseFactory = CountDownLatch(1)
    val source = TrackingPcmSource()
    val callbacks = AtomicInteger(0)
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = {
        factoryEntered.countDown()
        releaseFactory.await(2, TimeUnit.SECONDS)
        source
      },
      callbackExecutor = Executor { it.run() },
    )

    recorder.start {
      callbacks.incrementAndGet()
      outcome.set(it)
      finished.countDown()
    }
    assertTrue(factoryEntered.await(2, TimeUnit.SECONDS))
    recorder.stop()
    releaseFactory.countDown()

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(1, callbacks.get())
    assertTrue(outcome.get() is QuickCaptureAudioRecorder.Outcome.Failed)
    assertFalse(source.started)
    assertTrue(source.released)
  }

  @Test
  fun cancelWhileSourceStartIsBlockedUnblocksAndCancelsExactlyOnce() {
    val filesDir = tempFilesDir()
    val source = BlockingStartPcmSource()
    val callbacks = AtomicInteger(0)
    val outcome = AtomicReference<QuickCaptureAudioRecorder.Outcome>()
    val finished = CountDownLatch(1)
    val recorder = QuickCaptureAudioRecorder(
      filesDir = filesDir,
      sourceFactory = { source },
      callbackExecutor = Executor { it.run() },
    )

    recorder.start {
      callbacks.incrementAndGet()
      outcome.set(it)
      finished.countDown()
    }
    assertTrue(source.startEntered.await(2, TimeUnit.SECONDS))
    recorder.cancel()

    assertTrue(finished.await(2, TimeUnit.SECONDS))
    assertEquals(1, callbacks.get())
    assertTrue(outcome.get() is QuickCaptureAudioRecorder.Outcome.Cancelled)
    assertTrue(source.released)
  }

  private class BlockingPcmSource(private val firstChunk: ByteArray) : QuickCaptureAudioRecorder.PcmSource {
    override val bufferSize: Int = firstChunk.size
    val firstRead = CountDownLatch(1)
    private val stopped = CountDownLatch(1)
    @Volatile var released = false
    private var delivered = false

    override fun start() = Unit

    override fun read(target: ByteArray, length: Int): Int {
      if (!delivered) {
        delivered = true
        firstChunk.copyInto(target, endIndex = minOf(firstChunk.size, length))
        firstRead.countDown()
        return minOf(firstChunk.size, length)
      }
      stopped.await(2, TimeUnit.SECONDS)
      return -1
    }

    override fun stop() {
      stopped.countDown()
    }

    override fun release() {
      released = true
      stopped.countDown()
    }
  }

  private class RepeatingPcmSource(override val bufferSize: Int) : QuickCaptureAudioRecorder.PcmSource {
    @Volatile var released = false

    override fun start() = Unit

    override fun read(target: ByteArray, length: Int): Int {
      target.fill(5, 0, length)
      return length
    }

    override fun stop() = Unit

    override fun release() {
      released = true
    }
  }

  private class TrackingPcmSource : QuickCaptureAudioRecorder.PcmSource {
    override val bufferSize = 1_024
    @Volatile var started = false
    @Volatile var released = false

    override fun start() {
      started = true
    }

    override fun read(target: ByteArray, length: Int): Int = -1
    override fun stop() = Unit

    override fun release() {
      released = true
    }
  }

  private class BlockingStartPcmSource : QuickCaptureAudioRecorder.PcmSource {
    override val bufferSize = 1_024
    val startEntered = CountDownLatch(1)
    private val stopped = CountDownLatch(1)
    @Volatile var released = false

    override fun start() {
      startEntered.countDown()
      stopped.await(2, TimeUnit.SECONDS)
    }

    override fun read(target: ByteArray, length: Int): Int = -1

    override fun stop() {
      stopped.countDown()
    }

    override fun release() {
      released = true
      stopped.countDown()
    }
  }
}
