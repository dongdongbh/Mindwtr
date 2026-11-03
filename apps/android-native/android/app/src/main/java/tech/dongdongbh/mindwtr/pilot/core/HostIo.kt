package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.util.Base64
import android.util.Log
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.GzipSource
import okio.buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import tech.dongdongbh.mindwtr.pilot.core.HostAnswers.Answer


class HostIo(context: Context) {
    companion object {

        const val CONNECT_TIMEOUT_MS = 10_000L

        const val CALL_TIMEOUT_MS = 5 * 60 * 1000L

        const val MAX_SYNC_DOCUMENT_BYTES = 1024L * 1024 * 1024


        private val INVALID_JSON_PHRASES = listOf("invalid webdav response", "webdav get failed: invalid json", "unexpected end of input",
            "unexpected end of json input", "unexpected eof", "eof while parsing", "error decoding response body")
        private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "PROPFIND", "MKCOL", "MOVE", "COPY")
    }


    private class Refused(message: String) : IOException(message)


    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    private val noRedirects = client.newBuilder().followRedirects(false).followSslRedirects(false).build()


    private val ceiling = minOf(MAX_SYNC_DOCUMENT_BYTES, Runtime.getRuntime().maxMemory() / 5)

    private val argon2DelayMs = debugProperty("crypto_delay_ms").toLongOrNull()?.coerceIn(0, 30_000) ?: 0L
    private val maxResponseBytes = debugProperty("net_max_bytes").toLongOrNull()?.takeIf { it > 0 }?.let { minOf(it, ceiling) } ?: ceiling
    private val secrets = SecretStore(context.applicationContext)
    private val secretThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-secrets") }

    private val fileThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-files") }

    private val calendarThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-calendar") }

    private val cryptoThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-crypto") }
    private val calls = ConcurrentHashMap<String, Call>()

    private val answers = HostAnswers()
    private var nextId = 0L

    private var open = 0

    @Volatile var wake: () -> Unit = {}

    init {
        Log.i(CoreHost.TAG, "Native Android fetch limit bytes=$maxResponseBytes ceiling=$ceiling heap=${Runtime.getRuntime().maxMemory()}")
    }


    fun fetch(json: String): String {
        val request = JSONObject(json)
        val method = request.getString("method")
        require(method in METHODS) { "Unsupported method $method" }
        val headers = Headers.Builder().apply {
            val pairs = request.getJSONArray("headers")

            for (i in 0 until pairs.length()) pairs.getJSONArray(i).let { addUnsafeNonAscii(it.getString(0), it.getString(1)) }
        }.build()
        val type = headers["Content-Type"]?.toMediaTypeOrNull()
        val body = when {
            request.has("text") -> request.getString("text").toByteArray(Charsets.UTF_8).toRequestBody(type)
            request.has("base64") -> Base64.decode(request.getString("base64"), Base64.NO_WRAP).toRequestBody(type)

            method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val redirect = request.optString("redirect", "follow")
        val call = (if (redirect == "follow") client else noRedirects)
            .newCall(Request.Builder().url(request.getString("url")).headers(headers).method(method, body).build())
        val id = (++nextId).toString()
        calls[id] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                calls.remove(id)
                answers.add(failure(id, call, e))
                wake()
            }

            override fun onResponse(call: Call, response: Response) {


                try {
                    answers.add(runCatching { response.use { read(id, it, redirect) } }.getOrElse { failure(id, call, it) })
                } finally {
                    calls.remove(id)
                }
                wake()
            }
        })
        open += 1
        return id
    }


    fun abort(id: String) {
        calls.remove(id)?.cancel()
    }


    fun secret(json: String): String {
        val call = JSONObject(json)
        val op = call.getString("op")
        val key = call.getString("key")
        val value = if (op == "set") call.getString("value") else null
        require(op == "get" || op == "set" || op == "delete") { "Unsupported secret call $op" }
        SecretStore.requireKey(key)
        val id = (++nextId).toString()
        secretThread.execute {

            if (op == "get" && answers.closed) return@execute
            answers.add(runCatching {
                JSONObject().put("id", id).put("value", when (op) {
                    "get" -> secrets.get(key) ?: JSONObject.NULL
                    "set" -> JSONObject.NULL.also { secrets.set(key, value!!) }
                    else -> JSONObject.NULL.also { secrets.delete(key) }
                }).toString()
            }.getOrElse { JSONObject().put("id", id).put("error", it.message ?: it.javaClass.simpleName).toString() }.let { Answer(it) })
            wake()
        }
        open += 1
        return id
    }


    fun file(json: String, run: (String, ByteArray?) -> HostFiles.Reply): String {
        val id = (++nextId).toString()
        fileJobs.start(id, FileJobs.readsPickedDocument(json), {
            val request = JSONObject(json)
            val bytes = if (request.has("base64")) Base64.decode(request.getString("base64"), Base64.NO_WRAP) else null
            request.remove("base64")
            run(request.toString(), bytes)
        }) { result ->
            answers.add(result.fold({ reply ->
                val answer = JSONObject().put("id", id).put("value", reply.value ?: JSONObject.NULL)
                if (reply.bytes == null) Answer(answer.toString())
                else Answer(answer.put("body", true).toString(), Base64.encodeToString(reply.bytes, Base64.NO_WRAP))
            }) { Answer(JSONObject().put("id", id).put("error", it.message ?: it.javaClass.simpleName).toString()) })
            wake()
        }
        open += 1
        return id
    }


    fun calendar(json: String, run: (String, (Result<Any?>) -> Unit) -> Unit): String =
        replied { reply -> calendarThread.execute { runCatching { run(json, reply) }.onFailure { reply(Result.failure(it)) } } }


    fun gmail(json: String, run: (String, (Result<Any?>) -> Unit) -> Unit): String =
        replied { reply -> runCatching { run(json, reply) }.onFailure { reply(Result.failure(it)) } }


    fun voice(json: String, run: (String, (Result<Any?>) -> Unit) -> Unit): String =
        replied { reply -> runCatching { run(json, reply) }.onFailure { reply(Result.failure(IOException("E_VOICE_FAILED"))) } }


    private fun replied(start: ((Result<Any?>) -> Unit) -> Unit): String {
        val id = (++nextId).toString()
        val replied = java.util.concurrent.atomic.AtomicBoolean(false)
        val reply = { result: Result<Any?> ->
            if (replied.compareAndSet(false, true)) {
                answers.add(Answer(result.fold({ JSONObject().put("id", id).put("value", it ?: JSONObject.NULL) },
                    { JSONObject().put("id", id).put("error", it.message ?: it.javaClass.simpleName) }).toString()))
                wake()
            }
        }
        start(reply)
        open += 1
        return id
    }


    fun crypto(json: String): String {
        val id = (++nextId).toString()
        cryptoThread.execute {
            val reply = runCatching { cryptoReply(id, json) }.getOrElse { failure ->
                val answer = JSONObject().put("id", id)
                if (failure is HostCrypto.AuthFailure) answer.put("error", failure.message).put("auth", true)

                else answer.put("error", "Sync crypto failed: ${failure.message ?: failure.javaClass.simpleName}")
                Answer(answer.toString())
            }

            if (reply != null) answers.add(reply)
            wake()
        }
        open += 1
        return id
    }


    private fun cryptoReply(id: String, json: String): Answer? {
        val request = JSONObject(json)
        val bytes = { name: String -> Base64.decode(request.getString(name), Base64.NO_WRAP) }
        val compute = { when (val op = request.getString("op")) {
            "argon2id" -> {
                val (m, t, p, dkLen) = HostCrypto.argon2Params(request)
                val pass = bytes("pass")
                Log.i(CoreHost.TAG, "Native Android sync crypto argon2id start")
                var started = System.nanoTime()
                try {
                    if (argon2DelayMs > 0) Thread.sleep(argon2DelayMs).also { started = System.nanoTime() }
                    HostCrypto.argon2id(pass, bytes("salt"), m, t, p, dkLen)
                } finally {
                    HostCrypto.wipe(pass)

                    Log.i(CoreHost.TAG, "Native Android sync crypto argon2id ms=${(System.nanoTime() - started) / 1_000_000} m=$m t=$t p=$p")
                }
            }
            "aesGcmSeal", "aesGcmOpen" -> {
                val key = bytes("key")
                try {
                    if (op == "aesGcmSeal") HostCrypto.aesGcmSeal(key, bytes("nonce"), bytes("data"), bytes("aad"))
                    else HostCrypto.aesGcmOpen(key, bytes("nonce"), bytes("data"), bytes("aad"))
                } finally {
                    HostCrypto.wipe(key)
                }
            }
            else -> throw IllegalArgumentException("Unsupported crypto call $op")
        } }
        return HostCrypto.answer({ answers.closed }, compute) { out ->
            Answer(JSONObject().put("id", id).put("body", true).toString(), Base64.encodeToString(out, Base64.NO_WRAP))
        }
    }


    @Volatile var abortReader: (Thread) -> Unit = {}
    @Volatile var readDone: (Thread) -> Unit = {}
    private val fileJobs = FileJobs(fileThread, { abortReader(it) }, { readDone(it) })


    fun fileAbort(id: String) = fileJobs.abort(id)

    fun busy() = open > 0


    fun await(ms: Long) = answers.await(ms)


    fun next(): String {
        val answer = answers.next() ?: return ""
        open -= 1
        return answer.json
    }


    fun body(): String = answers.body()

    fun close() {
        calls.values.forEach { it.cancel() }
        secretThread.shutdown()
        fileThread.shutdown()
        calendarThread.shutdown()


        answers.close()
        cryptoThread.shutdownNow()
        client.dispatcher.executorService.shutdown()
    }


    private fun read(id: String, response: Response, redirect: String): Answer {
        if (redirect == "error" && response.isRedirect) throw Refused("fetch failed: unexpected redirect")
        val body = response.body!!
        val tooLarge = "Response exceeds the $maxResponseBytes byte download limit"
        if (body.contentLength() > maxResponseBytes) throw Refused(tooLarge)


        val bodiless = response.request.method == "HEAD" || response.code == 204 || response.code == 304 || body.contentLength() == 0L
        val gzip = !bodiless && response.header("Content-Encoding").equals("gzip", ignoreCase = true)
        val source = if (gzip) GzipSource(body.source()).buffer() else body.source()
        val bytes = Buffer()
        while (source.read(bytes, 64 * 1024L) != -1L) {
            if (bytes.size > maxResponseBytes) throw Refused(tooLarge)
        }
        val headers = JSONArray()
        response.headers.forEach { (name, value) -> headers.put(JSONArray().put(name).put(value)) }
        val raw = bytes.readByteArray()
        val text = StrictUtf8.bridgeTextOrNull(raw)
        val json = JSONObject().put("id", id).put("status", response.code).put("statusText", response.message)
            .put("url", response.request.url.toString()).put("redirected", response.priorResponse != null)
            .put("headers", headers).put("body", true).put("bytes", raw.size).apply { if (text != null) put("utf8", true) }.toString()

        return Answer(json, if (text != null) "T$text" else Base64.encodeToString(raw, Base64.NO_WRAP))
    }


    private fun failure(id: String, call: Call, error: Throwable): Answer = Answer(JSONObject().put("id", id).put("error", when {
        error is Refused -> error.message

        error is InterruptedIOException && error.message == "timeout" -> "Network request failed: no answer within ${CALL_TIMEOUT_MS / 1000} s"
        call.isCanceled() -> "Request cancelled"
        else -> "Network request failed: ${(error.message ?: "").takeIf { detail ->
            detail.isNotEmpty() && INVALID_JSON_PHRASES.none { detail.lowercase().contains(it) }
        } ?: error.javaClass.simpleName}"
    }).toString())
}
