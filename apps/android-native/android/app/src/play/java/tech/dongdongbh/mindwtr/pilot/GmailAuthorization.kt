package tech.dongdongbh.mindwtr.pilot

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.identity.RevokeAccessRequest
import com.google.android.gms.common.AccountPicker
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import tech.dongdongbh.mindwtr.gmailauthorization.GMAIL_API_ROOT
import tech.dongdongbh.mindwtr.gmailauthorization.GMAIL_SCOPE
import tech.dongdongbh.mindwtr.gmailauthorization.GmailFailure
import tech.dongdongbh.mindwtr.gmailauthorization.GmailIdentity
import tech.dongdongbh.mindwtr.gmailauthorization.GmailSession
import tech.dongdongbh.mindwtr.gmailauthorization.GmailSnapshot
import tech.dongdongbh.mindwtr.gmailauthorization.gmailAccount
import tech.dongdongbh.mindwtr.gmailauthorization.gmailAccountId
import tech.dongdongbh.mindwtr.gmailauthorization.gmailRequestPath
import tech.dongdongbh.mindwtr.gmailauthorization.readGmailBody
import tech.dongdongbh.mindwtr.gmailauthorization.validateGmailJsonDepth
import tech.dongdongbh.mindwtr.pilot.core.GmailConsentPrompt
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** A failure as RN's module rejects it: its fixed code `E_GMAIL_<KIND>`, never its own text (a JSONException can carry mail text). */
internal fun gmailFailureCode(failure: Throwable): String = "E_GMAIL_${classifyGmailFailure(failure).kind}"

private fun classifyGmailFailure(failure: Throwable): GmailFailure {
    if (failure is GmailFailure) return failure
    val cause = if (failure is ExecutionException) failure.cause else failure
    return when {
        cause is GmailFailure -> cause
        cause is TimeoutException || cause is SocketTimeoutException || cause is java.io.IOException -> GmailFailure("NETWORK")
        cause is ApiException && cause.statusCode == CommonStatusCodes.NETWORK_ERROR -> GmailFailure("NETWORK")
        cause is ApiException && cause.statusCode == CommonStatusCodes.CANCELED -> GmailFailure("CANCELLED")
        cause is ApiException -> GmailFailure("AUTH")
        else -> GmailFailure("OTHER")
    }
}

/**
 * RN's MindwtrGmailAuthorizationModule (apps/mobile/modules/gmail-authorization), ported to this host: the same five calls
 * (`status`, `connect`, `cancel`, `disconnect`, `get`), the same guards, and RN's GmailAuthorizationCore.kt compiled as it is
 * (app/build.gradle.kts rnGmail). Google Identity Services' AuthorizationClient with the account picker (`com.google` only) and
 * the `gmail.readonly` scope only. No token is ever stored or leaves this class: Google's service holds it, and [session] keeps it
 * in memory. RN's SharedPreferences file keeps only the selected account, so an RN user who upgrades stays connected.
 *
 * Process scope, not the Activity's: the account picker and the consent screen answer through MainActivity's two result
 * launchers ([GmailConsentPrompt]), so a rotation during consent still reaches the pending call. Expo's Promise is the host's
 * reply ([call]); every failure replies with RN's fixed `E_GMAIL_<KIND>` code. Reads run on RN's own 3-thread pool, so a 30 s Gmail
 * read never holds the engine thread or the other host calls.
 */
class GmailAuthorization(context: Context) {
    private val context = context.applicationContext
    private val session = GmailSession()
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(3) { task -> Thread(task, "mindwtr-gmail") }
    private val connections = mutableMapOf<Call, Long>()
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS).build()
    private var pending: Consent? = null

    private class Consent(
        val generation: Long,
        val reply: (Result<Any?>) -> Unit,
        var selectedName: String? = null,
        var phase: ConsentPhase = ConsentPhase.PICKER,
    )
    private enum class ConsentPhase { PICKER, AUTHORIZING, RESOLUTION }

    init {
        GmailConsentPrompt.answered = { kind, resultCode, data -> handleActivityResult(kind, resultCode, data) }
    }

    /**
     * One of RN's five calls: [json] is `{ op, path? }`. [reply] gets its value (JSON) or a failure whose message is the fixed code.
     * It never waits: each call goes to the Gmail pool, or to the main thread (connect), as RN's module runs it.
     */
    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        val request = try { JSONObject(json) } catch (_: Exception) { return reject(reply, GmailFailure("OTHER")) }
        when (request.optString("op")) {
            "status" -> work(reply) { status() }
            "get" -> request.optString("path").let { path -> work(reply) { get(path) } }
            "connect" -> main.post { connect(reply) }
            "cancel" -> try {
                cancel()
                reply(Result.success(null))
            } catch (failure: Exception) { reject(reply, failure) }
            // RN's disconnect writes the selection's preferences: off the engine thread here.
            "disconnect" -> work(reply, settles = false) { disconnect(reply) }
            else -> reject(reply, GmailFailure("CONFIG"))
        }
    }

    private fun available(): Boolean = try {
        @Suppress("DEPRECATION")
        val metadata = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
        metadata?.getBoolean("MindwtrGmailEnabled", false) == true &&
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    } catch (_: Exception) { false }

    private fun preferences() = context.getSharedPreferences("mindwtr-gmail-authorization", Context.MODE_PRIVATE)

    private fun initialize() = session.initialize {
        try {
            val prefs = preferences()
            if (prefs.getBoolean("blocked", true)) return@initialize null
            val name = prefs.getString("selectedAccount", null) ?: throw GmailFailure("STORAGE")
            val account = prefs.getString("profileAccount", null) ?: throw GmailFailure("STORAGE")
            val id = prefs.getString("profileId", null) ?: throw GmailFailure("STORAGE")
            if (name.isBlank() || name.length > 320 || name.any { it.isISOControl() } ||
                account != gmailAccount(account) || id != gmailAccountId(account)) throw GmailFailure("STORAGE")
            GmailIdentity(name, account, id)
        } catch (_: Exception) { throw GmailFailure("STORAGE") }
    }

    private fun clearSelection() {
        try {
            if (!preferences().edit().clear().putBoolean("blocked", true).commit()) throw GmailFailure("STORAGE")
            if (!preferences().getBoolean("blocked", false)) throw GmailFailure("STORAGE")
        } catch (_: Exception) { throw GmailFailure("STORAGE") }
    }

    private fun saveSelection(selected: GmailIdentity) {
        try {
            val prefs = preferences()
            if (!prefs.edit().putString("selectedAccount", selected.selectedName)
                    .putString("profileAccount", selected.account).putString("profileId", selected.accountId)
                    .putBoolean("blocked", false).commit()) throw GmailFailure("STORAGE")
            if (prefs.getBoolean("blocked", true) || prefs.getString("selectedAccount", null) != selected.selectedName ||
                prefs.getString("profileAccount", null) != selected.account || prefs.getString("profileId", null) != selected.accountId) {
                throw GmailFailure("STORAGE")
            }
        } catch (_: Exception) {
            runCatching { clearSelection() }
            throw GmailFailure("STORAGE")
        }
    }

    private fun state(available: Boolean, selected: GmailIdentity?) = JSONObject().put("available", available)
        .put("connected", selected != null).put("account", selected?.account ?: JSONObject.NULL)
        .put("accountId", selected?.accountId ?: JSONObject.NULL)

    private fun status(): JSONObject {
        val enabled = available()
        if (enabled) initialize()
        return state(enabled, if (enabled) session.snapshot().identity else null)
    }

    /** RN's closeConsent: the pending connect answers CANCELLED. The picker or consent screen still open is left to the user (a
     *  result launcher cannot finish it, as RN's finishActivity did); its late answer settles nothing. */
    private fun closeConsent(consent: Consent?) {
        if (consent == null) return
        reject(consent.reply, GmailFailure("CANCELLED"))
    }

    private fun cancelConnections() {
        val generation = session.snapshot().generation
        val active = synchronized(connections) { connections.filterValues { it != generation }.keys.toList() }
        active.forEach { it.cancel() }
    }

    private fun cancel() {
        val previous = synchronized(session) {
            session.invalidate()
            pending.also { pending = null }
        }
        closeConsent(previous)
        cancelConnections()
    }

    /** Main thread. */
    private fun connect(reply: (Result<Any?>) -> Unit) {
        var started: Consent? = null
        try {
            if (!available()) throw GmailFailure("CONFIG")
            initialize()
            val launch = GmailConsentPrompt.picker ?: throw GmailFailure("CANCELLED")
            val consent: Consent
            val old: Consent?
            synchronized(session) {
                val snapshot = session.beginConnect(::clearSelection)
                old = pending
                consent = Consent(snapshot.generation, reply)
                pending = consent
                started = consent
            }
            closeConsent(old)
            cancelConnections()
            val options = AccountPicker.AccountChooserOptions.Builder()
                .setAllowableAccountsTypes(listOf("com.google"))
                .setAlwaysShowAccountPicker(true).build()
            launch(AccountPicker.newChooseAccountIntent(options))
            // RN's 180 s consent limit.
            main.postDelayed({
                synchronized(session) {
                    if (pending === consent) {
                        session.invalidate()
                        pending = null
                        closeConsent(consent)
                        cancelConnections()
                    }
                }
            }, 180_000)
        } catch (failure: Exception) {
            val stale = synchronized(session) {
                pending?.takeIf { it === started || it.generation != session.snapshot().generation }.also {
                    if (it != null) { session.invalidate(); pending = null }
                }
            }
            closeConsent(stale)
            cancelConnections()
            reject(reply, failure)
        }
    }

    /** MainActivity's launchers' answers: [kind] "picker" or "consent". Main thread. */
    private fun handleActivityResult(kind: String, resultCode: Int, data: Intent?) {
        val consent = synchronized(session) {
            pending?.takeIf {
                (kind == "picker" && it.phase == ConsentPhase.PICKER) || (kind == "consent" && it.phase == ConsentPhase.RESOLUTION)
            }?.also { it.phase = ConsentPhase.AUTHORIZING }
        } ?: return
        try {
            session.check(consent.generation)
            if (resultCode != Activity.RESULT_OK || data == null) throw GmailFailure("CANCELLED")
            if (kind == "picker") {
                val name = data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME) ?: throw GmailFailure("AUTH")
                if (data.getStringExtra(AccountManager.KEY_ACCOUNT_TYPE) != "com.google") throw GmailFailure("AUTH")
                gmailAccount(name)
                synchronized(session) {
                    session.check(consent.generation)
                    consent.selectedName = name
                }
                io.execute {
                    try {
                        val result = authorization(name)
                        session.check(consent.generation)
                        if (result.hasResolution()) {
                            main.post {
                                try {
                                    synchronized(session) {
                                        session.check(consent.generation)
                                        if (pending !== consent) throw GmailFailure("CANCELLED")
                                        consent.phase = ConsentPhase.RESOLUTION
                                    }
                                    val sender = result.pendingIntent?.intentSender ?: throw GmailFailure("AUTH")
                                    (GmailConsentPrompt.consent ?: throw GmailFailure("CANCELLED"))(sender)
                                } catch (failure: Exception) { failConsent(consent, failure) }
                            }
                        } else finishConsent(consent, result)
                    } catch (failure: Exception) { failConsent(consent, failure) }
                }
            } else {
                val result = Identity.getAuthorizationClient(context).getAuthorizationResultFromIntent(data)
                io.execute {
                    try { finishConsent(consent, result) } catch (failure: Exception) { failConsent(consent, failure) }
                }
            }
        } catch (failure: Exception) { failConsent(consent, failure) }
    }

    private fun authorization(name: String): AuthorizationResult {
        val request = AuthorizationRequest.builder().setAccount(Account(name, "com.google"))
            .setRequestedScopes(listOf(Scope(GMAIL_SCOPE))).setOptOutIncludingGrantedScopes(true).build()
        return Tasks.await(Identity.getAuthorizationClient(context).authorize(request), 30, TimeUnit.SECONDS)
    }

    private fun token(result: AuthorizationResult): String {
        if (result.hasResolution() || GMAIL_SCOPE !in result.grantedScopes) throw GmailFailure("AUTH")
        return result.accessToken?.takeIf { it.isNotBlank() && it.length <= 16_384 }
            ?: throw GmailFailure("AUTH")
    }

    private fun profile(access: String, generation: Long): Pair<String, String> {
        val profile = request("profile", access, generation)
        val account = gmailAccount(profile.optString("emailAddress"))
        return account to gmailAccountId(account)
    }

    private fun finishConsent(consent: Consent, result: AuthorizationResult) {
        session.check(consent.generation)
        val access = token(result)
        val profile = profile(access, consent.generation)
        val selected = GmailIdentity(consent.selectedName ?: throw GmailFailure("AUTH"), profile.first, profile.second)
        synchronized(session) {
            if (pending !== consent) throw GmailFailure("CANCELLED")
            session.install(consent.generation, selected, access) { saveSelection(selected) }
            pending = null
            consent.reply(Result.success(state(true, selected)))
        }
    }

    private fun failConsent(consent: Consent, failure: Exception) {
        synchronized(session) {
            if (pending !== consent) return
            session.invalidate(clearIdentity = true)
            pending = null
            reject(consent.reply, failure)
        }
    }

    private fun access(snapshot: GmailSnapshot): String {
        val selected = snapshot.identity ?: throw GmailFailure("AUTH")
        val result = authorization(selected.selectedName)
        val current = session.check(snapshot.generation)
        val access = token(result)
        if (access != current.token) {
            val actual = profile(access, snapshot.generation)
            if (actual.first != selected.account || actual.second != selected.accountId) throw GmailFailure("AUTH")
        }
        session.acceptToken(snapshot.generation, selected, access)
        return access
    }

    private fun get(path: String): JSONObject {
        gmailRequestPath(path)
        if (!available()) throw GmailFailure("CONFIG")
        initialize()
        val snapshot = session.requestSnapshot()
        try {
            val access = access(snapshot)
            val result = request(path, access, snapshot.generation)
            session.check(snapshot.generation)
            return result
        } catch (failure: Exception) {
            val normalized = classifyGmailFailure(failure)
            if (normalized.kind == "AUTH") {
                val invalid = session.check(snapshot.generation).token
                synchronized(session) { session.failAuth(snapshot.generation, ::clearSelection) }
                if (invalid != null) {
                    runCatching { Identity.getAuthorizationClient(context).clearToken(ClearTokenRequest.builder().setToken(invalid).build()) }
                }
                throw normalized
            }
            session.check(snapshot.generation)
            throw normalized
        }
    }

    private fun request(path: String, access: String, generation: Long): JSONObject {
        gmailRequestPath(path)
        session.check(generation)
        val connection = http.newCall(Request.Builder().url(GMAIL_API_ROOT + path).get()
            .header("Authorization", "Bearer $access").header("Accept", "application/json")
            .header("Accept-Encoding", "identity").build())
        synchronized(connections) { connections[connection] = generation }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        try {
            session.check(generation)
            val bytes = connection.execute().use { response ->
                session.check(generation)
                val status = response.code
                if (status == 401 || status == 403) throw GmailFailure("AUTH")
                if (status !in 200..299) throw GmailFailure(if (status >= 500 || status == 429) "NETWORK" else "OTHER")
                val body = response.body ?: throw GmailFailure("OTHER")
                body.byteStream().use { input ->
                    readGmailBody(input, body.contentLength()) {
                        session.check(generation)
                        if (System.nanoTime() >= deadline) throw GmailFailure("NETWORK")
                    }
                }
            }
            session.check(generation)
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            validateGmailJsonDepth(text)
            return JSONObject(text)
        } catch (failure: Exception) {
            session.check(generation)
            throw classifyGmailFailure(failure)
        } finally {
            synchronized(connections) { connections.remove(connection) }
            connection.cancel()
        }
    }

    /** A Gmail pool thread. */
    private fun disconnect(reply: (Result<Any?>) -> Unit) {
        var old: Consent? = null
        try {
            initialize()
            val previous: GmailSnapshot
            synchronized(session) {
                old = pending
                pending = null
                previous = session.beginDisconnect(::clearSelection)
            }
            val selected = previous.identity
            if (selected == null) { reply(Result.success(JSONObject().put("revoked", true))); return }
            try {
                val request = RevokeAccessRequest.builder().setAccount(Account(selected.selectedName, "com.google"))
                    .setScopes(listOf(Scope(GMAIL_SCOPE))).build()
                Identity.getAuthorizationClient(context).revokeAccess(request).addOnCompleteListener { result ->
                    session.finishRevocation()
                    reply(Result.success(JSONObject().put("revoked", result.isSuccessful)))
                }
            } catch (_: Exception) {
                session.finishRevocation()
                reply(Result.success(JSONObject().put("revoked", false)))
            }
        } catch (failure: Exception) { reject(reply, failure) }
        finally { closeConsent(old); cancelConnections() }
    }

    /** [action] on the Gmail pool; its value is the reply unless [settles] is false (it replies itself). */
    private fun work(reply: (Result<Any?>) -> Unit, settles: Boolean = true, action: () -> Any?) {
        try {
            io.execute {
                try {
                    val value = action()
                    if (settles) reply(Result.success(value))
                } catch (failure: Exception) { reject(reply, failure) }
            }
        } catch (_: Exception) { reject(reply, GmailFailure("CANCELLED")) }
    }

    private fun reject(reply: (Result<Any?>) -> Unit, failure: Throwable) {
        reply(Result.failure(IllegalStateException(gmailFailureCode(failure))))
    }
}
