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

/**
 * The JS host's fetch, secret, attachment file and sync crypto calls (bundle/host-polyfills.js). Each runs off the engine
 * thread, on OkHttp's dispatcher, the secrets thread, the files thread or the crypto thread, and only queues its answer as JSON
 * (a body apart, as base64); the engine takes the answers in CoreHost's pump loop, where timers fire too. [fetch], [abort],
 * [secret], [file], [crypto], [busy], [await], [next] and [body] are called on the engine thread only.
 */
class HostIo(context: Context) {
    companion object {
        /** RN's connect timeout (apps/mobile/modules/sync-file-lock/.../SyncHttpClientPackage.kt, #1150). */
        const val CONNECT_TIMEOUT_MS = 10_000L
        /** RN's background-safe fetch ceiling (apps/mobile/lib/background-safe-fetch.ts), enforced by OkHttp as there. */
        const val CALL_TIMEOUT_MS = 5 * 60 * 1000L
        /** Core's MAX_SYNC_DOCUMENT_BYTES (http-utils.ts), the largest body core reads; core applies its smaller limits itself. */
        const val MAX_SYNC_DOCUMENT_BYTES = 1024L * 1024 * 1024
        /**
         * Core's phrases for a WebDAV body that is not JSON (retry-utils.ts isWebdavInvalidJsonError). Sync reads such a
         * remote as missing and writes over it, so the text of a network failure must never carry one.
         */
        private val INVALID_JSON_PHRASES = listOf("invalid webdav response", "webdav get failed: invalid json", "unexpected end of input",
            "unexpected end of json input", "unexpected eof", "eof while parsing", "error decoding response body")
        private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "PROPFIND", "MKCOL", "MOVE", "COPY")
    }

    /** A refusal of this host's own (a redirect the request forbids, an oversized body): its text reaches JS as it is. */
    private class Refused(message: String) : IOException(message)

    // RN's fetch is OkHttp too, with RN's timeouts (connect 10 s, no read or write timeout), so its redirects, TLS and
    // cleartext rule (the network security config, the same as RN's) apply unchanged. No cookie jar (core sends its
    // credentials as headers) and no HTTP cache (RN's 10 MB cache could only answer a sync read with stale bytes).
    private val client = OkHttpClient.Builder()
        .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()
    /** `redirect: 'error'` or `'manual'`: the 3xx itself comes back. */
    private val noRedirects = client.newBuilder().followRedirects(false).followSslRedirects(false).build()
    /**
     * The largest body buffered: core's largest limit, [MAX_SYNC_DOCUMENT_BYTES], bounded by this process's heap. At its
     * peak a body is held about four times over (the bytes, the base64 bytes or the text, the string, the queued answer), so
     * a fifth of the heap leaves room for the app. Core still applies its own limit for the call (an attachment's 100 MiB,
     * an error body's 64 KiB). The net check lowers it in a debug build (`debug.mindwtr.native.net_max_bytes`).
     */
    // ponytail: a heap fraction estimates the peak; stream large bodies to a file and hand JS a handle if documents outgrow it.
    private val ceiling = minOf(MAX_SYNC_DOCUMENT_BYTES, Runtime.getRuntime().maxMemory() / 5)
    /** Debug builds only (check-encryption-device.mjs): each Argon2id waits this long first, so the check can tap during one. */
    private val argon2DelayMs = debugProperty("crypto_delay_ms").toLongOrNull()?.coerceIn(0, 30_000) ?: 0L
    private val maxResponseBytes = debugProperty("net_max_bytes").toLongOrNull()?.takeIf { it > 0 }?.let { minOf(it, ceiling) } ?: ceiling
    private val secrets = SecretStore(context.applicationContext)
    private val secretThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-secrets") }
    /** Core's attachment file port (HostFiles.call), one call at a time, in the order JS made them. */
    private val fileThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-files") }
    /** Sync encryption's Argon2id and AES-GCM (HostCrypto): an Argon2id holds its thread for about a second, never the engine. */
    private val cryptoThread = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-crypto") }
    private val calls = ConcurrentHashMap<String, Call>()
    /** Every call's answer; after [close] none is queued or taken, of any kind (a secret's value included). */
    private val answers = HostAnswers()
    private var nextId = 0L
    /** Calls started and not yet taken by [next], cancelled ones included. */
    private var open = 0
    /** Called on the answering thread once an answer is queued: CoreHost's idle pump settles it when no call is running. */
    @Volatile var wake: () -> Unit = {}

    init {
        Log.i(CoreHost.TAG, "Native Android fetch limit bytes=$maxResponseBytes ceiling=$ceiling heap=${Runtime.getRuntime().maxMemory()}")
    }

    /**
     * Starts `fetch`: [json] is `{ url, method, headers: [[name, value]], text? | base64?, redirect }`, the body as text
     * (sent as UTF-8) or as base64 bytes. Returns the call's id; its answer is `{ id, status, statusText, url, redirected,
     * headers, body: true, bytes, utf8? }` with the body from [body], or `{ id, error }`. `bytes` is the body's size after
     * gzip; with `utf8` the body is "T" and the text of a strict UTF-8 body with no NUL ([StrictUtf8.bridgeTextOrNull],
     * decoded on OkHttp's thread so the engine never decodes it), else base64.
     */
    fun fetch(json: String): String {
        val request = JSONObject(json)
        val method = request.getString("method")
        require(method in METHODS) { "Unsupported method $method" }
        val headers = Headers.Builder().apply {
            val pairs = request.getJSONArray("headers")
            // RN adds headers the same way, so a non-ASCII value is sent as RN sends it.
            for (i in 0 until pairs.length()) pairs.getJSONArray(i).let { addUnsafeNonAscii(it.getString(0), it.getString(1)) }
        }.build()
        val type = headers["Content-Type"]?.toMediaTypeOrNull()
        val body = when {
            request.has("text") -> request.getString("text").toByteArray(Charsets.UTF_8).toRequestBody(type)
            request.has("base64") -> Base64.decode(request.getString("base64"), Base64.NO_WRAP).toRequestBody(type)
            // RN's empty body for the methods OkHttp requires one for.
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
                // Nothing may throw on OkHttp's thread: the answer is the only way back. The call stays in [calls] until
                // its body is read, so an abort or [close] can still cancel a body that stalls after the headers.
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

    /** Cancels [id]'s request; JS has already rejected its promise and drops the late answer. */
    fun abort(id: String) {
        calls.remove(id)?.cancel()
    }

    /** Starts a secret call: [json] is `{ op: "get" | "set" | "delete", key, value? }`. Its answer is `{ id, value }` or `{ id, error }`. */
    fun secret(json: String): String {
        val call = JSONObject(json)
        val op = call.getString("op")
        val key = call.getString("key")
        val value = if (op == "set") call.getString("value") else null
        require(op == "get" || op == "set" || op == "delete") { "Unsupported secret call $op" }
        SecretStore.requireKey(key)
        val id = (++nextId).toString()
        secretThread.execute {
            // A read the closed host would never take is not made.
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

    /**
     * Starts a file call on the files thread: [run] is core's attachment file port (HostFiles.call) or the installer
     * (HostInstaller.call), and [json] its request, a write's bytes as `base64` in it. Its answer is `{ id, value }`, a read's
     * bytes as the body, or `{ id, error }`. Even the request is read there, so a large write's base64 never holds the engine.
     */
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

    /**
     * Starts a sync crypto call (HostCrypto) on the crypto thread: [json] is `{ op: "argon2id", pass, salt, m, t, p, dkLen }` or
     * `{ op: "aesGcmSeal" | "aesGcmOpen", key, nonce, data, aad }`, every byte field as base64; even the request is read there.
     * Its answer is `{ id, body: true }` with the bytes from [body], or `{ id, error }` with `auth: true` for core's
     * SyncCryptoAuthError. A passphrase or key never reaches an answer, a log or an error text.
     */
    fun crypto(json: String): String {
        val id = (++nextId).toString()
        cryptoThread.execute {
            val reply = runCatching { cryptoReply(id, json) }.getOrElse { failure ->
                val answer = JSONObject().put("id", id)
                if (failure is HostCrypto.AuthFailure) answer.put("error", failure.message).put("auth", true)
                // Not a parameter's value: BouncyCastle's and the JDK's texts name only what was wrong.
                else answer.put("error", "Sync crypto failed: ${failure.message ?: failure.javaClass.simpleName}")
                Answer(answer.toString())
            }
            // Once the host closed, nobody reads the queue again: a key or plaintext answer must not wait there.
            if (reply != null) answers.add(reply)
            wake()
        }
        open += 1
        return id
    }

    /** The call's answer, or null when the host closed meanwhile (HostCrypto.answer: the result's bytes are cleared either way). */
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
                    // Its cost and time only (the encryption check reads it): never a byte of the pass, salt or key.
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

    /** The files thread and the picked documents' own threads (FileJobs); CoreHost sets the reader hooks (HostFiles). */
    @Volatile var abortReader: (Thread) -> Unit = {}
    @Volatile var readDone: (Thread) -> Unit = {}
    private val fileJobs = FileJobs(fileThread, { abortReader(it) }, { readDone(it) })

    /**
     * A file call whose operation passed its deadline (host-polyfills.js cancel): one not started never runs; a running one has its
     * document read closed, so a copy stalled on a provider ends. Its late answer settles nothing.
     */
    fun fileAbort(id: String) = fileJobs.abort(id)

    fun busy() = open > 0

    /** Waits up to [ms] for an answer, so the pump loop wakes as soon as one is queued. */
    fun await(ms: Long) = answers.await(ms)

    /** The next queued answer's JSON, or "" when none is (or the host closed). Its body, if any, waits for [body]. */
    fun next(): String {
        val answer = answers.next() ?: return ""
        open -= 1
        return answer.json
    }

    /** The body of the answer [next] returned last: base64, or text when its answer says `utf8`; the polyfill asks right after [next]. */
    fun body(): String = answers.body()

    fun close() {
        calls.values.forEach { it.cancel() }
        secretThread.shutdown()
        fileThread.shutdown()
        // A crypto call still queued never runs; one running is dropped when it ends (HostCrypto.answer). Every answer already
        // queued goes too, and none is queued after: a secret's value, a derived key or plaintext must not outlive the host in a
        // queue nobody drains. A secret write still queued runs (its value reaches the keystore), its answer dropped.
        answers.close()
        cryptoThread.shutdownNow()
        client.dispatcher.executorService.shutdown()
    }

    /**
     * The whole body or a throw, never a short body: core reads an empty or unreadable sync document as a missing remote
     * and writes local data over it. OkHttp throws for a body cut short of its Content-Length or chunked end, a reset
     * connection, and a broken gzip stream; a body past the limit is refused here, by its declared length or as it arrives.
     */
    private fun read(id: String, response: Response, redirect: String): Answer {
        if (redirect == "error" && response.isRedirect) throw Refused("fetch failed: unexpected redirect")
        val body = response.body!!
        val tooLarge = "Response exceeds the $maxResponseBytes byte download limit"
        if (body.contentLength() > maxResponseBytes) throw Refused(tooLarge)
        // As RN: OkHttp decodes gzip itself unless the request named an Accept-Encoding; then the body is decoded here. A
        // response without a body (HEAD, 204, 304, a zero length) keeps its gzip header and has nothing to decode.
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
        // A text body goes with a leading "T", so no body (one starting "!MindwtrNativeError:") ever reads as a bridge error.
        return Answer(json, if (text != null) "T$text" else Base64.encodeToString(raw, Base64.NO_WRAP))
    }

    /**
     * Worded as RN's fetch words a failed request, so core's sync reads a dropped connection as offline. A detail that
     * carries one of core's invalid-JSON phrases is replaced by the exception's name.
     */
    private fun failure(id: String, call: Call, error: Throwable): Answer = Answer(JSONObject().put("id", id).put("error", when {
        error is Refused -> error.message
        // OkHttp's call timeout cancels the call, so it is told apart first.
        error is InterruptedIOException && error.message == "timeout" -> "Network request failed: no answer within ${CALL_TIMEOUT_MS / 1000} s"
        call.isCanceled() -> "Request cancelled"
        else -> "Network request failed: ${(error.message ?: "").takeIf { detail ->
            detail.isNotEmpty() && INVALID_JSON_PHRASES.none { detail.lowercase().contains(it) }
        } ?: error.javaClass.simpleName}"
    }).toString())
}
