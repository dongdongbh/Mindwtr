package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.app.KeyguardManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.delay
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.lang.ref.WeakReference


private const val SWITCH_FAILURE = "appLockFailure"

private const val PROMPT_DELAY_MS = 250L


internal fun withinRelockDelay(delayMinutes: Int, leftUnlockedAt: Long?, now: Long): Boolean {
    if (delayMinutes <= 0 || leftUnlockedAt == null) return false
    val away = now - leftUnlockedAt
    return away >= 0 && away < delayMinutes * 60_000L
}


internal class Relock(private val clock: () -> Long = SystemClock::elapsedRealtime) {

    var delayMinutes = 0
    private var leftUnlockedAt: Long? = null


    fun left(unlocked: Boolean) { leftUnlockedAt = if (unlocked) clock() else null }


    fun returned(authenticating: Boolean = false): Boolean {
        val left = leftUnlockedAt
        leftUnlockedAt = null
        return !authenticating && withinRelockDelay(delayMinutes, left, clock())
    }
}


private val BIOMETRIC_UNUSABLE = setOf(BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS,
    BiometricPrompt.ERROR_UNABLE_TO_PROCESS, BiometricPrompt.ERROR_NO_SPACE)

class AppLock(private val shell: InboxViewModel) {

    var enabled by mutableStateOf(false); private set

    var locked by mutableStateOf(false); private set

    var authenticating by mutableStateOf(false); private set

    var failure by mutableStateOf<String?>(null); private set

    var locks by mutableIntStateOf(0); private set
    private var prompted = -1

    private var then: ((String?) -> Unit)? = null

    private var fallback = false

    private var host: WeakReference<MainActivity>? = null

    internal val relock = Relock()

    fun attach(activity: MainActivity) { host = WeakReference(activity) }
    fun detach(activity: MainActivity) { if (host?.get() === activity) host = null }


    internal fun boot(runtime: CoreHost) {
        val row = runtime.appLock()
        val on = row.getBoolean("value")
        shell.ui { enabled = on; locked = on; relock.delayMinutes = row.optInt("relockDelayMinutes") }
    }


    internal fun stored(on: Boolean) {
        enabled = on
        if (!on) { locked = false; failure = null }
    }


    fun paused(rotating: Boolean) {
        if (!enabled || authenticating || rotating) return
        relock.left(unlocked = !locked)
        locked = true
        failure = null
        locks += 1
    }


    fun resumed() {
        if (!enabled) return
        if (relock.returned(authenticating)) { locked = false; failure = null }
    }


    fun shouldPrompt(resumed: Boolean) = enabled && locked && !authenticating && resumed && prompted != locks


    fun promptOnce() {
        prompted = locks
        unlock()
    }


    fun unlock() {
        if (!enabled || authenticating) return
        failure = null
        ask(t("appLock.prompt")) { reason -> if (reason == null) locked = false else failure = reason }
    }


    fun toggle(row: JSONObject) {
        val settings = shell.menu.settings
        settings.editLocal { remove(SWITCH_FAILURE) }
        val edit = row.getJSONObject("edit")
        if (!edit.getBoolean("value")) return settings.general(edit)
        ask(row.getJSONObject("enablePrompt").getString("promptMessage")) { reason ->
            if (reason == null) shell.menu.whenIdle { settings.general(edit) } else settings.editLocal { put(SWITCH_FAILURE, reason) }
        }
    }


    fun switchFailure(row: JSONObject): String? = shell.menu.settings.local.menuText(SWITCH_FAILURE)?.let { row.getJSONObject("errors").getString(it) }


    private fun ask(title: String, next: (String?) -> Unit) {
        if (authenticating) return
        authenticating = true
        then = next
        fallback = false
        prompt(title, Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
    }


    private fun prompt(title: String, authenticators: Int) {
        val activity = host?.get() ?: return answered("unavailable")

        if (debugProperty("app_lock_answer") == "yes") return answered(null)
        try {
            if (!activity.getSystemService(KeyguardManager::class.java).isDeviceSecure) return answered("unavailable")
            if (activity.supportFragmentManager.isStateSaved) return answered("cancelled")
            val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setAllowedAuthenticators(authenticators).setConfirmationRequired(true).build()
            BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = answered(null)
                override fun onAuthenticationError(code: Int, message: CharSequence) = failed(title, code)
            }).authenticate(info)
        } catch (error: Exception) {
            Log.w(CoreHost.TAG, "App lock prompt failed", error)
            answered("failed")
        }
    }


    @Suppress("DEPRECATION")
    private fun failed(title: String, code: Int) {
        if (code !in BIOMETRIC_UNUSABLE || fallback) return answered(reason(code))
        val activity = host?.get() ?: return answered("unavailable")
        try {
            val keyguard = activity.getSystemService(KeyguardManager::class.java)
            if (!keyguard.isDeviceSecure) return answered(reason(code))
            fallback = true
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) activity.credential.launch(keyguard.createConfirmDeviceCredentialIntent(title, null))
            else prompt(title, Authenticators.DEVICE_CREDENTIAL)
        } catch (error: Exception) {
            Log.w(CoreHost.TAG, "App lock credential fallback failed", error)
            answered("failed")
        }
    }


    internal fun answered(reason: String?) {
        authenticating = false
        fallback = false
        val next = then
        then = null
        next?.invoke(reason)
    }


    private fun reason(code: Int) = when (code) {
        BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_USER_CANCELED -> "cancelled"
        BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "unavailable"
        else -> "failed"
    }
}


private fun protectRecents(activity: Activity, on: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) activity.setRecentsScreenshotEnabled(!on)
    else if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
}


private val LockKeyhole = lucide("LockKeyhole", circle(12, 16, 1), "M5 10h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M7 10V7a5 5 0 0 1 10 0v3", stroke = 2.2f)


@Composable
fun AppLockGate(model: InboxViewModel, content: @Composable () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val activity = LocalActivity.current
    DisposableEffect(owner, activity) {
        val main = activity as? MainActivity
        main?.let(model.lock::attach)
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> model.lock.paused(activity?.isChangingConfigurations == true)
                Lifecycle.Event.ON_RESUME -> model.lock.resumed()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            main?.let(model.lock::detach)
        }
    }
    val on = model.lock.enabled
    LaunchedEffect(activity, on) { activity?.let { protectRecents(it, on) } }
    val screens = rememberSaveableStateHolder()

    if (model.lock.locked && !model.loading) AppLockScreen(model) else screens.SaveableStateProvider("app", content)
}


@Composable
private fun AppLockScreen(model: InboxViewModel) {
    val theme = LocalTheme.current
    val c = theme.colors
    val lock = model.lock
    val activity = LocalActivity.current
    val resumed by LocalLifecycleOwner.current.lifecycle.currentStateAsState()

    LaunchedEffect(c.bg, theme.isDark) { activity?.window?.applySystemBars(c.bg.toArgb(), theme.isDark) }

    LaunchedEffect(lock.locks, lock.authenticating, resumed) {
        if (lock.shouldPrompt(resumed.isAtLeast(Lifecycle.State.RESUMED))) { delay(PROMPT_DELAY_MS); lock.promptOnce() }
    }
    val message = when (lock.failure) {
        "unavailable" -> t("appLock.unavailable")
        "cancelled" -> t("appLock.cancelled")
        "failed" -> t("appLock.failed")
        else -> t("appLock.description")
    }
    val tile = RoundedCornerShape(24.dp)
    BoxWithConstraints(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("app-lock")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Box(Modifier.padding(bottom = 22.dp).size(72.dp).clip(tile).background(c.filterBg).rnBorder(1.dp, c.border, tile), contentAlignment = Alignment.Center) {
                Icon(LockKeyhole, null, tint = c.tint, modifier = Modifier.size(34.dp))
            }
            Text(t("appLock.title"), style = rnText(24, 700), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 10.dp).semantics { heading() })
            Text(message, style = rnText(15, 400, 22), color = c.secondaryText, textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 26.dp).widthIn(max = 320.dp).testTag("app-lock-message").semantics { liveRegion = LiveRegionMode.Polite })
            val label = t(if (lock.authenticating) "appLock.authenticating" else "appLock.unlock")
            val enabled = !lock.authenticating
            Box(Modifier.widthIn(min = 156.dp).heightIn(min = 48.dp).fade(if (enabled) 1f else 0.7f).clip(RoundedCornerShape(16.dp)).background(theme.filledBg)
                .testTag("app-lock-unlock")
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { lock.unlock(); true } else disabled() }
                .clickable(enabled = enabled) { lock.unlock() }.padding(horizontal = 22.dp),
                contentAlignment = Alignment.Center) {
                Text(label, style = rnText(16, 700), color = theme.filledText)
            }
        }
    }
}
