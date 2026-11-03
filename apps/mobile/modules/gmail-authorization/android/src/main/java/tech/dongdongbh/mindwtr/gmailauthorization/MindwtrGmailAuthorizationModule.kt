package tech.dongdongbh.mindwtr.gmailauthorization

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
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.lang.ref.WeakReference
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class MindwtrGmailAuthorizationModule : Module() {
  private val session = GmailSession()
  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newFixedThreadPool(3)
  private val connections = mutableMapOf<Call, Long>()
  private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
    .callTimeout(30, TimeUnit.SECONDS).build()
  private var pending: Consent? = null
  private var nextRequestCode = 27000
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw GmailFailure("OTHER")

  private data class Consent(
    val generation: Long,
    val pickerCode: Int,
    val resolutionCode: Int,
    val promise: Promise,
    val activity: WeakReference<Activity>,
    var selectedName: String? = null,
    var phase: ConsentPhase = ConsentPhase.PICKER,
  )
  private enum class ConsentPhase { PICKER, AUTHORIZING, RESOLUTION }

  override fun definition() = ModuleDefinition {
    Name("MindwtrGmailAuthorization")

    AsyncFunction("status") { promise: Promise -> work(promise) { status() } }
    AsyncFunction("get") { path: String, promise: Promise -> work(promise) { get(path) } }
    AsyncFunction("connect") { promise: Promise -> main.post { connect(promise) } }
    AsyncFunction("cancel") { promise: Promise ->
      try {
        cancel()
        promise.resolve()
      } catch (failure: Exception) { reject(promise, failure) }
    }
    AsyncFunction("disconnect") { promise: Promise -> disconnect(promise) }

    OnActivityResult { _, payload -> handleActivityResult(payload.requestCode, payload.resultCode, payload.data) }
    OnDestroy {
      runCatching { cancel() }
      io.shutdownNow()
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

  private fun status(): Map<String, Any?> {
    val enabled = available()
    if (enabled) initialize()
    val selected = if (enabled) session.snapshot().identity else null
    return mapOf("available" to enabled, "connected" to (selected != null),
      "account" to selected?.account, "accountId" to selected?.accountId)
  }

  private fun closeConsent(consent: Consent?) {
    if (consent == null) return
    reject(consent.promise, GmailFailure("CANCELLED"))
    main.post {
      runCatching { consent.activity.get()?.finishActivity(consent.pickerCode) }
      runCatching { consent.activity.get()?.finishActivity(consent.resolutionCode) }
    }
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

  private fun connect(promise: Promise) {
    var started: Consent? = null
    try {
      if (!available()) throw GmailFailure("CONFIG")
      initialize()
      val activity = appContext.currentActivity ?: throw GmailFailure("CANCELLED")
      val consent: Consent
      val old: Consent?
      synchronized(session) {
        val snapshot = session.beginConnect(::clearSelection)
        old = pending
        if (nextRequestCode > 65000) throw GmailFailure("OTHER")
        consent = Consent(snapshot.generation, nextRequestCode++, nextRequestCode++, promise, WeakReference(activity))
        pending = consent
        started = consent
      }
      closeConsent(old)
      cancelConnections()
      val options = AccountPicker.AccountChooserOptions.Builder()
        .setAllowableAccountsTypes(listOf("com.google"))
        .setAlwaysShowAccountPicker(true).build()
      @Suppress("DEPRECATION")
      activity.startActivityForResult(AccountPicker.newChooseAccountIntent(options), consent.pickerCode)
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
      reject(promise, failure)
    }
  }

  private fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    val consent = synchronized(session) {
      pending?.takeIf {
        (requestCode == it.pickerCode && it.phase == ConsentPhase.PICKER) ||
          (requestCode == it.resolutionCode && it.phase == ConsentPhase.RESOLUTION)
      }?.also { it.phase = ConsentPhase.AUTHORIZING }
    } ?: return
    try {
      session.check(consent.generation)
      if (resultCode != Activity.RESULT_OK || data == null) throw GmailFailure("CANCELLED")
      if (requestCode == consent.pickerCode) {
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
                  @Suppress("DEPRECATION")
                  consent.activity.get()?.startIntentSenderForResult(
                    result.pendingIntent?.intentSender ?: throw GmailFailure("AUTH"),
                    consent.resolutionCode, null, 0, 0, 0,
                  ) ?: throw GmailFailure("CANCELLED")
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
      consent.promise.resolve(mapOf("available" to true, "connected" to true,
        "account" to selected.account, "accountId" to selected.accountId))
    }
  }

  private fun failConsent(consent: Consent, failure: Exception) {
    synchronized(session) {
      if (pending !== consent) return
      session.invalidate(clearIdentity = true)
      pending = null
      reject(consent.promise, failure)
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

  private fun get(path: String): Any {
    gmailRequestPath(path)
    if (!available()) throw GmailFailure("CONFIG")
    initialize()
    val snapshot = session.requestSnapshot()
    try {
      val access = access(snapshot)
      val result = request(path, access, snapshot.generation)
      session.check(snapshot.generation)
      return jsonObject(result)
    } catch (failure: Exception) {
      val normalized = classify(failure)
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
      throw classify(failure)
    } finally {
      synchronized(connections) { connections.remove(connection) }
      connection.cancel()
    }
  }

  private fun disconnect(promise: Promise) {
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
      if (selected == null) { promise.resolve(mapOf("revoked" to true)); return }
      try {
        val request = RevokeAccessRequest.builder().setAccount(Account(selected.selectedName, "com.google"))
          .setScopes(listOf(Scope(GMAIL_SCOPE))).build()
        Identity.getAuthorizationClient(context).revokeAccess(request).addOnCompleteListener { result ->
          session.finishRevocation()
          promise.resolve(mapOf("revoked" to result.isSuccessful))
        }
      } catch (_: Exception) {
        session.finishRevocation()
        promise.resolve(mapOf("revoked" to false))
      }
    } catch (failure: Exception) { reject(promise, failure) }
    finally { closeConsent(old); cancelConnections() }
  }

  private fun work(promise: Promise, action: () -> Any?) {
    try {
      io.execute {
        try { promise.resolve(action()) } catch (failure: Exception) { reject(promise, failure) }
      }
    } catch (_: Exception) { reject(promise, GmailFailure("CANCELLED")) }
  }

  private fun classify(failure: Exception): GmailFailure {
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

  private fun reject(promise: Promise, failure: Exception) {
    val fixed = classify(failure)
    promise.reject("E_GMAIL_${fixed.kind}", fixed.message, null)
  }

  private fun jsonObject(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
  private fun jsonValue(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> jsonObject(value)
    is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
    is String, is Number, is Boolean -> value
    else -> throw GmailFailure("OTHER")
  }
}
