package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import org.json.JSONObject
import java.io.IOException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom


class DropboxAuthorization(context: Context, val clientId: String, val redirectUri: String) {
    companion object {
        const val AUTHORIZE_ENDPOINT = "https://www.dropbox.com/oauth2/authorize"
        const val SCOPES = "files.content.read files.content.write files.metadata.read"
        private val DROPBOX_ORIGINS = listOf("https://www.dropbox.com", "https://api.dropboxapi.com", "https://content.dropboxapi.com")
        private val random = SecureRandom()

        @Volatile var current: DropboxAuthorization? = null

        fun base64Url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

        fun challenge(verifier: String, encode: (ByteArray) -> String = ::base64Url): String =
            encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        fun authorizeUrl(clientId: String, redirectUri: String, challenge: String, state: String, origin: String = ""): String {
            val query = listOf("response_type" to "code", "client_id" to clientId, "redirect_uri" to redirectUri, "scope" to SCOPES,
                "code_challenge_method" to "S256", "code_challenge" to challenge, "state" to state, "token_access_type" to "offline")
                .joinToString("&") { (name, value) -> "$name=${URLEncoder.encode(value, "UTF-8").replace("+", "%20")}" }
            return "${route(AUTHORIZE_ENDPOINT, origin)}?$query"
        }

        fun route(url: String, origin: String): String {
            if (origin.isEmpty()) return url
            val host = DROPBOX_ORIGINS.firstOrNull { url.startsWith("$it/") } ?: return url
            return origin + url.removePrefix(host)
        }

        fun isRedirect(url: String, redirectUri: String): Boolean = url.substringBefore('#').substringBefore('?').removeSuffix("/") == redirectUri

        private fun params(url: String): Map<String, String>? = runCatching {
            url.substringBefore('#').substringAfter('?', "").split('&').filter { it.isNotEmpty() }.associate { pair ->
                URLDecoder.decode(pair.substringBefore('='), "UTF-8") to URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
            }
        }.getOrNull()

        fun answers(url: String, redirectUri: String, state: String): Boolean = isRedirect(url, redirectUri) && params(url)?.get("state") == state

        fun redirectCode(url: String, redirectUri: String, state: String): String {
            if (!answers(url, redirectUri, state)) throw IOException("Dropbox authorization failed")
            val params = params(url) ?: throw IOException("Dropbox authorization failed")
            return params["code"]?.takeIf { it.isNotEmpty() && params["error"] == null } ?: throw IOException("Dropbox authorization failed")
        }
    }

    private val context = context.applicationContext
    private val origin = debugProperty("dropbox_origin")
    private val main = Handler(Looper.getMainLooper())
    private val signIn = DropboxSignIn(clientId, redirectUri)

    fun configuration(): String = JSONObject().put("version", 1).put("clientId", clientId).put("redirectUri", redirectUri).toString()

    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        val request = JSONObject(json)
        require(request.optString("op") == "authorize") { "Unsupported Dropbox call" }
        val verifier = base64Url(ByteArray(32).also(random::nextBytes))
        val state = base64Url(ByteArray(16).also(random::nextBytes))
        val started = signIn.start(request.getString("requestId"), verifier, state, reply)
        val url = authorizeUrl(clientId, redirectUri, challenge(verifier), state, origin)
        main.post {
            runCatching { open(Uri.parse(url)) }
                .onFailure { signIn.finish(started, Result.failure(IOException("Dropbox authorization failed: no browser"))) }
        }
    }

    private fun open(uri: Uri) {
        val browser = CustomTabsClient.getPackageName(context, null)
        if (browser == null) {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        CustomTabsIntent.Builder().build().apply { intent.setPackage(browser).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }.launchUrl(context, uri)
    }

    fun redirected(url: String?): Boolean = signIn.redirected(url)

    fun left() = signIn.left()

    fun resumed() = signIn.resumed()
}


class DropboxSignIn(private val clientId: String, private val redirectUri: String) {
    class Pending internal constructor(val requestId: String, val verifier: String, val state: String, val reply: (Result<Any?>) -> Unit) {
        internal var left = false
    }

    private var pending: Pending? = null

    fun start(requestId: String, verifier: String, state: String, reply: (Result<Any?>) -> Unit): Pending {
        val started = Pending(requestId, verifier, state, reply)
        val previous = synchronized(this) { pending.also { pending = started } }
        previous?.reply?.invoke(Result.failure(IOException("Dropbox authorization failed")))
        return started
    }

    fun redirected(url: String?): Boolean {
        if (url == null) return false
        val answered = synchronized(this) {
            pending?.takeIf { DropboxAuthorization.answers(url, redirectUri, it.state) }?.also { pending = null }
        } ?: return false
        answered.reply(runCatching {
            JSONObject().put("version", 1).put("requestId", answered.requestId).put("clientId", clientId).put("redirectUri", redirectUri)
                .put("code", DropboxAuthorization.redirectCode(url, redirectUri, answered.state)).put("codeVerifier", answered.verifier)
        })
        return true
    }

    fun left() = synchronized(this) { pending?.left = true }

    fun resumed() {
        val dismissed = synchronized(this) { pending?.takeIf { it.left }?.also { pending = null } } ?: return
        dismissed.reply(Result.failure(IOException("Dropbox authorization failed")))
    }

    fun finish(started: Pending, result: Result<Any?>) {
        val owned = synchronized(this) { (pending === started).also { if (it) pending = null } }
        if (owned) started.reply(result)
    }
}
