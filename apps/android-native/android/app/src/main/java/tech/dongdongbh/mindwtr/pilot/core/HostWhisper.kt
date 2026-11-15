package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import tech.dongdongbh.mindwtr.androidwidget.QuickCaptureWave
import tech.dongdongbh.mindwtr.whisper.WhisperNative


class WhisperModelStore(private val files: File, private val cache: File, private val open: (String) -> InputStream) {
    class Located(val file: File?, val uri: String, val size: Long)

    class Spec(val fileName: String, val sizeBytes: Long, val sha256: String, val urls: List<String>)

    class Downloaded(val located: Located, val repaired: Boolean)

    companion object {
        const val DIRECTORY = "whisper-models"
        const val MAX_BYTES = 150_000_000L
        private val FILE_NAME = Regex("^ggml-(?:tiny|base)(?:\\.en)?\\.bin$")
        private val DIGEST = Regex("^[0-9a-f]{64}$")
        private val HOSTS = setOf("huggingface.co", "hf-mirror.com")

        fun fileName(value: String): String = value.takeIf(FILE_NAME::matches) ?: throw IOException("E_WHISPER_SPEC")

        fun spec(request: JSONObject): Spec {
            val fileName = fileName(request.getString("fileName"))
            val size = request.getLong("sizeBytes")
            val digest = request.getString("sha256")
            val list = request.getJSONArray("urls")
            val urls = (0 until list.length()).map { list.getString(it) }
            val allowed = urls.all { url ->
                runCatching { URI(url) }.getOrNull()?.let { it.scheme == "https" && it.host in HOSTS && it.path.endsWith("/$fileName") } == true
            }
            if (size !in 1..MAX_BYTES || !DIGEST.matches(digest) || urls.size !in 1..2 || !allowed) throw IOException("E_WHISPER_SPEC")
            return Spec(fileName, size, digest, urls)
        }

        fun sha256(file: File): String = file.inputStream().use { input ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
            hex(digest.digest())
        }

        private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    }

    private val roots get() = listOf(files, cache)

    private fun inside(file: File) = roots.any { root -> file.canonicalPath.startsWith(root.canonicalPath + File.separator) }

    private fun stored(path: String?, fileName: String): File? {
        if (path.isNullOrEmpty()) return null
        val file = if (path.startsWith("file:")) runCatching { File(URI(path)) }.getOrNull() else File(path)
        return file?.takeIf { it.name == fileName && inside(it) }
    }

    fun locate(fileName: String, storedPath: String?, sizeBytes: Long?): Located {
        val candidates = (listOfNotNull(stored(storedPath, fileName)) + roots.flatMap { listOf(File(File(it, DIRECTORY), fileName), File(it, fileName)) })
            .filter { it.isFile }
        val found = candidates.firstOrNull { it.length() == sizeBytes } ?: candidates.firstOrNull()
            ?: return Located(null, HostVoice.uriOf(File(File(files, DIRECTORY), fileName)), 0)
        return Located(found, HostVoice.uriOf(found), found.length())
    }

    private fun directoryIn(root: File): Pair<File, Boolean>? {
        val directory = File(root, DIRECTORY)
        val blocked = directory.exists() && !directory.isDirectory
        if (blocked) directory.delete()
        directory.mkdirs()
        return if (directory.isDirectory) directory to blocked else null
    }

    fun download(spec: Spec): Downloaded {
        val (directory, repaired) = roots.firstNotNullOfOrNull(::directoryIn) ?: throw IOException("E_WHISPER_STORAGE")
        val target = File(directory, spec.fileName)
        if (target.isDirectory) throw IOException("E_WHISPER_PATH_FOLDER")
        if (target.isFile && target.length() == spec.sizeBytes && sha256(target) == spec.sha256) {
            return Downloaded(Located(target, HostVoice.uriOf(target), target.length()), repaired)
        }
        if (directory.usableSpace < spec.sizeBytes) throw IOException("E_WHISPER_SPACE")
        val parts = File(cache, "whisper-downloads").apply { listFiles()?.forEach { it.delete() }; mkdirs() }
        val part = File(parts, "${spec.fileName}.part")
        var failure: IOException? = null
        for (url in spec.urls) {
            try {
                fetch(url, part, spec)
                if (!part.renameTo(target)) throw IOException("E_WHISPER_PUBLISH")
                return Downloaded(Located(target, HostVoice.uriOf(target), target.length()), repaired)
            } catch (error: IOException) {
                if (failure == null) failure = error
            } finally {
                part.delete()
            }
        }
        throw failure ?: IOException("E_WHISPER_DOWNLOAD")
    }

    private fun fetch(url: String, part: File, spec: Spec) {
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        open(url).use { input ->
            FileOutputStream(part).use { output ->
                val buffer = ByteArray(1 shl 16)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > spec.sizeBytes) throw IOException("E_WHISPER_SIZE")
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                output.fd.sync()
            }
        }
        if (total != spec.sizeBytes) throw IOException("E_WHISPER_SIZE")
        if (hex(digest.digest()) != spec.sha256) throw IOException("E_WHISPER_HASH")
    }

    fun remove(fileName: String) {
        for (root in roots) {
            val model = File(File(root, DIRECTORY), fileName)
            if (model.isFile && !model.delete()) throw IOException("E_WHISPER_DELETE")
        }
    }

    fun owned(uri: String): File? = runCatching { File(URI(uri)) }.getOrNull()?.takeIf { it.isFile && inside(it) }
}


class HostWhisper(
    private val store: WhisperModelStore,
    private val engine: (File, FloatArray, String) -> String,
    private val models: Executor = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-whisper-models").apply { isDaemon = true } },
    private val transcriber: Executor = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-whisper").apply { isDaemon = true } },
) {
    fun call(request: JSONObject, reply: (Result<Any?>) -> Unit) {
        val answer = { work: () -> Any? -> reply(runCatching(work).recoverCatching { throw IOException(code(it)) }) }
        when (request.optString("op")) {
            "whisperLocate" -> answer {
                located(store.locate(WhisperModelStore.fileName(request.getString("fileName")), storedPath(request), request.optLong("sizeBytes").takeIf { it > 0 }))
            }
            "whisperDownload" -> models.execute {
                answer { store.download(WhisperModelStore.spec(request)).let { located(it.located).put("repaired", it.repaired) } }
            }
            "whisperDelete" -> models.execute { answer { store.remove(WhisperModelStore.fileName(request.getString("fileName"))); null } }
            "whisperTranscribe" -> transcriber.execute { answer { transcribe(request) } }
            else -> reply(Result.failure(IOException("E_VOICE_UNKNOWN")))
        }
    }

    private fun transcribe(request: JSONObject): String {
        val audio = store.owned(request.getString("uri"))?.takeIf(QuickCaptureWave::isValid) ?: throw IOException("E_WHISPER_AUDIO_UNSUPPORTED")
        val size = request.getLong("sizeBytes")
        val model = store.locate(WhisperModelStore.fileName(request.getString("fileName")), storedPath(request), size)
        if (model.file == null || model.size != size) throw IOException("E_WHISPER_MODEL_MISSING")
        return engine(model.file, samples(audio), language(request.optString("language"))).trim()
    }

    companion object {
        private val LANGUAGE = Regex("^[a-z]{2,32}$")

        fun code(error: Throwable): String = error.message?.takeIf { it.startsWith("E_WHISPER_") }
            ?: if (error is IOException) "E_WHISPER_IO" else "E_WHISPER_FAILED"

        fun language(value: String): String = value.takeIf(LANGUAGE::matches) ?: "auto"

        fun threads(cores: Int): Int = if (cores == 4) 2 else cores.coerceIn(1, 4)

        fun samples(wave: File): FloatArray {
            val bytes = wave.readBytes()
            val data = ByteBuffer.wrap(bytes, QuickCaptureWave.HEADER_SIZE, bytes.size - QuickCaptureWave.HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            return FloatArray(data.remaining()) { data.get(it) / 32768f }
        }

        private fun storedPath(request: JSONObject) = request.optString("storedPath").ifEmpty { null }

        private fun located(found: WhisperModelStore.Located) = JSONObject().put("exists", found.file != null).put("uri", found.uri).put("size", found.size)

        private val client by lazy {
            OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build()
        }

        private fun download(url: String): InputStream {
            val response = client.newCall(Request.Builder().url(url).header("Accept", "application/octet-stream").build()).execute()
            if (!response.isSuccessful) {
                response.close()
                throw IOException("E_WHISPER_HTTP_${response.code}")
            }
            return response.body?.byteStream() ?: throw IOException("E_WHISPER_DOWNLOAD")
        }

        @Volatile private var shared: HostWhisper? = null

        fun forApp(context: Context): HostWhisper = shared ?: synchronized(this) {
            shared ?: context.applicationContext.let { app ->
                HostWhisper(
                    WhisperModelStore(app.filesDir, app.cacheDir, ::download),
                    { model, samples, language -> WhisperNative.transcribe(model, samples, language, threads(Runtime.getRuntime().availableProcessors())) },
                )
            }.also { shared = it }
        }
    }
}
