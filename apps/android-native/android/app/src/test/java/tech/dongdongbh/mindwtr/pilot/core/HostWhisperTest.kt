package tech.dongdongbh.mindwtr.pilot.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWave
import tech.dongdongbh.mindwtr.whisper.WhisperNative


class HostWhisperTest {
    private val direct = Executor { it.run() }
    private val root = Files.createTempDirectory("mindwtr-whisper").toFile()
    private val files = File(root, "files").apply { mkdirs() }
    private val cache = File(root, "cache").apply { mkdirs() }
    private val model = "ggml-tiny.bin".let { name -> name to ByteArray(4096) { (it * 7).toByte() } }
    private val opened = mutableListOf<String>()
    private var served: (String) -> ByteArray = { model.second }
    private val heard = mutableListOf<Pair<File, FloatArray>>()

    private val store = WhisperModelStore(files, cache) { url -> opened += url; ByteArrayInputStream(served(url)) }
    private val host = HostWhisper(store, { file, samples, _ -> heard += file to samples; "  Buy milk  " }, direct, direct)

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun spec(size: Long = model.second.size.toLong(), digest: String = sha(model.second)) = JSONObject()
        .put("op", "whisperDownload").put("fileName", model.first).put("sizeBytes", size).put("sha256", digest)
        .put("urls", JSONArray(listOf("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.first}",
            "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${model.first}")))

    private fun answer(request: JSONObject): Result<Any?> {
        var result: Result<Any?>? = null
        host.call(request) { result = it }
        return result!!
    }

    private fun wave(samples: ShortArray, directory: File = File(files, "voice-captures")): File {
        val data = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN).apply { samples.forEach { putShort(it) } }.array()
        return File(directory.apply { mkdirs() }, "take.wav").apply { writeBytes(QuickCaptureWave.header(data.size) + data) }
    }

    private fun speech() = wave(ShortArray(16_000) { (it % 200 - 100).toShort() })

    private fun transcribe(audio: File, size: Long = model.second.size.toLong(), storedPath: String? = null) = answer(JSONObject()
        .put("op", "whisperTranscribe").put("uri", HostVoice.uriOf(audio)).put("fileName", model.first).put("sizeBytes", size).put("language", "en")
        .apply { storedPath?.let { put("storedPath", it) } })

    private fun canonical(base: File = files) = File(File(base, WhisperModelStore.DIRECTORY), model.first)

    @Test fun theSettingsRowTheReadinessCheckAndTheEngineResolveTheModelOneWay() {
        val elsewhere = File(cache, WhisperModelStore.DIRECTORY).apply { mkdirs() }.let { File(it, model.first) }.apply { writeBytes(model.second) }
        val outside = File(root, "outside/${model.first}").apply { parentFile!!.mkdirs(); writeBytes(model.second) }

        val located = answer(JSONObject().put("op", "whisperLocate").put("fileName", model.first).put("storedPath", HostVoice.uriOf(outside))).getOrThrow() as JSONObject
        assertTrue(located.getBoolean("exists"))
        assertEquals(HostVoice.uriOf(elsewhere), located.getString("uri"))
        assertEquals(model.second.size.toLong(), located.getLong("size"))

        assertEquals("Buy milk", transcribe(speech(), storedPath = HostVoice.uriOf(outside)).getOrThrow())
        assertEquals(elsewhere.canonicalPath, heard.single().first.canonicalPath)
    }

    @Test fun aFreshModelOfTheExactSizeWinsOverAStalePartialFileAtTheStoredPath() {
        val stale = File(cache, WhisperModelStore.DIRECTORY).apply { mkdirs() }.let { File(it, model.first) }.apply { writeBytes(model.second.copyOf(100)) }
        val leftover = File(cache, "whisper-downloads/ggml-base.bin.part").apply { parentFile!!.mkdirs(); writeBytes(ByteArray(10)) }
        answer(spec()).getOrThrow()
        assertFalse(leftover.exists())

        val located = answer(JSONObject().put("op", "whisperLocate").put("fileName", model.first).put("sizeBytes", model.second.size.toLong())
            .put("storedPath", HostVoice.uriOf(stale))).getOrThrow() as JSONObject
        assertEquals(HostVoice.uriOf(canonical()), located.getString("uri"))
        assertEquals(model.second.size.toLong(), located.getLong("size"))
        assertEquals("Buy milk", transcribe(speech(), storedPath = HostVoice.uriOf(stale)).getOrThrow())
        assertEquals(canonical().canonicalPath, heard.single().first.canonicalPath)
    }

    @Test fun aDownloadNeverOverwritesAGoodModelAndLeavesNoSidecarFile() {
        canonical().apply { parentFile!!.mkdirs(); writeBytes(model.second); setLastModified(1_000_000L) }
        served = { throw IOException("no network in this test") }

        val reply = answer(spec()).getOrThrow() as JSONObject

        assertEquals(HostVoice.uriOf(canonical()), reply.getString("uri"))
        assertTrue(opened.isEmpty())
        assertEquals(1_000_000L, canonical().lastModified())
        assertTrue(File(files, WhisperModelStore.DIRECTORY).isDirectory)
        assertEquals(listOf(model.first), File(files, WhisperModelStore.DIRECTORY).list()!!.toList())
    }

    @Test fun aFileBlockingTheModelFolderIsRepairedAndTheModelLandsInTheDocumentFolder() {
        File(files, WhisperModelStore.DIRECTORY).writeText("not a folder")

        val reply = answer(spec()).getOrThrow() as JSONObject

        assertTrue(reply.getBoolean("repaired"))
        assertEquals(HostVoice.uriOf(canonical()), reply.getString("uri"))
        assertArrayEquals(model.second, canonical().readBytes())
        assertFalse(canonical(cache).exists())
    }

    @Test fun aDownloadOfTheWrongSizeOrHashIsNeverInstalledAndAWrongSizedModelIsNotReady() {
        served = { model.second.copyOf(model.second.size - 1) }
        assertEquals("E_WHISPER_SIZE", answer(spec()).exceptionOrNull()?.message)
        served = { model.second + 1 }
        assertEquals("E_WHISPER_SIZE", answer(spec()).exceptionOrNull()?.message)
        served = { model.second.copyOf().also { it[0] = 99 } }
        assertEquals("E_WHISPER_HASH", answer(spec()).exceptionOrNull()?.message)
        assertEquals(6, opened.size)
        assertFalse(canonical().exists())
        assertTrue(File(cache, "whisper-downloads").list()!!.isEmpty())

        canonical().writeBytes(model.second.copyOf(100))
        assertEquals("E_WHISPER_MODEL_MISSING", transcribe(speech()).exceptionOrNull()?.message)
        assertTrue(heard.isEmpty())

        served = { model.second }
        answer(spec()).getOrThrow()
        assertArrayEquals(model.second, canonical().readBytes())
    }

    @Test fun onlyAValid16kMonoPcmWaveReachesTheEngine() {
        canonical().apply { parentFile!!.mkdirs(); writeBytes(model.second) }
        val m4a = File(files, "voice-captures/take.m4a").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(0, 0, 0, 24) + "ftypM4A ".toByteArray() + ByteArray(8000)) }
        val short = wave(ShortArray(1_000))
        val loud = File(files, "voice-captures/stereo.wav").apply { writeBytes(QuickCaptureWave.header(64_000).also { it[22] = 2 } + ByteArray(64_000)) }
        for (audio in listOf(m4a, short, loud)) assertEquals("E_WHISPER_AUDIO_UNSUPPORTED", transcribe(audio).exceptionOrNull()?.message)
        assertTrue(heard.isEmpty())

        val samples = ShortArray(16_000) { if (it == 0) Short.MIN_VALUE else if (it == 1) 16_384 else 0 }
        transcribe(wave(samples)).getOrThrow()
        val heardSamples = heard.single().second
        assertEquals(16_000, heardSamples.size)
        assertEquals(-1f, heardSamples[0])
        assertEquals(0.5f, heardSamples[1])
    }

    @Test fun twoTranscriptionsNeverRunInTheEngineAtOnce() {
        canonical().apply { parentFile!!.mkdirs(); writeBytes(model.second) }
        val running = AtomicInteger()
        val most = AtomicInteger()
        val shared = HostWhisper(store, { _, _, _ ->
            most.accumulateAndGet(running.incrementAndGet()) { a, b -> maxOf(a, b) }
            Thread.sleep(50)
            running.decrementAndGet()
            "text"
        })
        val audio = speech()
        val done = CountDownLatch(4)
        repeat(4) {
            Thread {
                shared.call(JSONObject().put("op", "whisperTranscribe").put("uri", HostVoice.uriOf(audio)).put("fileName", model.first)
                    .put("sizeBytes", model.second.size.toLong()).put("language", "auto")) { done.countDown() }
            }.start()
        }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(1, most.get())
    }

    @Test fun deleteRemovesTheCanonicalCopiesAndNeverALegacyRootFile() {
        canonical().apply { parentFile!!.mkdirs(); writeBytes(model.second) }
        canonical(cache).apply { parentFile!!.mkdirs(); writeBytes(model.second) }
        val legacy = File(files, model.first).apply { writeBytes(model.second) }

        answer(JSONObject().put("op", "whisperDelete").put("fileName", model.first)).getOrThrow()

        assertFalse(canonical().exists())
        assertFalse(canonical(cache).exists())
        assertTrue(legacy.exists())
    }

    @Test fun theBridgeRefusesUnsafeInputAndAnswersCodesWithoutPaths() {
        assertEquals("E_WHISPER_SPEC", answer(JSONObject().put("op", "whisperLocate").put("fileName", "../ggml-tiny.bin")).exceptionOrNull()?.message)
        assertEquals("E_WHISPER_SPEC", answer(spec().put("urls", JSONArray(listOf("http://example.com/${model.first}")))).exceptionOrNull()?.message)
        assertEquals("E_WHISPER_SPEC", answer(spec().put("sizeBytes", WhisperModelStore.MAX_BYTES + 1)).exceptionOrNull()?.message)
        val outsideAudio = wave(ShortArray(16_000), File(root, "elsewhere"))
        assertEquals("E_WHISPER_AUDIO_UNSUPPORTED", transcribe(outsideAudio).exceptionOrNull()?.message)
        assertEquals("E_VOICE_UNKNOWN", answer(JSONObject().put("op", "whisperRealtime")).exceptionOrNull()?.message)
        assertEquals("E_WHISPER_IO", HostWhisper.code(IOException("/data/user/0/secret/files/x")))
        assertEquals("E_WHISPER_FAILED", HostWhisper.code(IllegalStateException("/data/user/0/secret")))
        assertNull(answer(JSONObject().put("op", "whisperDelete").put("fileName", model.first)).getOrThrow())
    }

    @Test fun theEngineSettingsFollowWhisperRn() {
        assertEquals("auto", HostWhisper.language("auto"))
        assertEquals("de", HostWhisper.language("de"))
        assertEquals("auto", HostWhisper.language("en'; rm"))
        assertEquals(2, HostWhisper.threads(4))
        assertEquals(4, HostWhisper.threads(8))
        assertEquals(1, HostWhisper.threads(1))
        assertEquals("mindwtr_whisper_fp16", WhisperNative.library("arm64-v8a", "Features\t: fp asimd evtstrm aes fphp asimdhp"))
        assertEquals("mindwtr_whisper", WhisperNative.library("arm64-v8a", "Features\t: fp asimd evtstrm aes"))
        assertEquals("mindwtr_whisper", WhisperNative.library("x86_64", "Features\t: fphp"))
    }
}
