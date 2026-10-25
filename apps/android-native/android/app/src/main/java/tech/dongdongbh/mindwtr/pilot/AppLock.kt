package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.app.KeyguardManager
import android.os.Build
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.delay
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.lang.ref.WeakReference

/*
 * RN's app lock (components/mobile-app-lock-gate.tsx, lib/mobile-app-lock.ts, and General's switch in
 * general-settings-screen.tsx) on core's General row for it: `settings.security.mobileAppLockEnabled`, per device and never
 * synced, read and written only through core. Every word is core's. Kotlin keeps only RN's gate state: locked, the prompt in
 * flight, the last failure, and which lock the screen already prompted for.
 */

/** Settings' screen state for General's switch (RN's appLockErrorKey): core's reason key of the last failed prompt. */
private const val SWITCH_FAILURE = "appLockFailure"
/** RN's AUTHENTICATE_AFTER_ACTIVE_DELAY_MS. */
private const val PROMPT_DELAY_MS = 250L
/** Expo's isBiometricUnavailable: the errors after which it asks for the device credential alone, once. */
private val BIOMETRIC_UNUSABLE = setOf(BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS,
    BiometricPrompt.ERROR_UNABLE_TO_PROCESS, BiometricPrompt.ERROR_NO_SPACE)

class AppLock(private val shell: InboxViewModel) {
    /** Core's value: read at boot, then after each write of it (an owed save's too: core applied it in memory). */
    var enabled by mutableStateOf(false); private set
    /** RN's `locked`: from boot while on, and from each time the app leaves the foreground, until the device lock says yes. */
    var locked by mutableStateOf(false); private set
    /** A device lock prompt is up (RN's authenticating and General's appLockBusy). */
    var authenticating by mutableStateOf(false); private set
    /** The lock screen's line: core's reason key (unavailable, cancelled, failed) of the last failed prompt; null shows RN's description. */
    var failure by mutableStateOf<String?>(null); private set
    /** RN's lockNonce and promptedNonce: the lock screen asks by itself once per lock. */
    var locks by mutableIntStateOf(0); private set
    private var prompted = -1
    /** What the prompt in flight goes on with, given its answer. */
    private var then: ((String?) -> Unit)? = null
    /** The prompt in flight already fell back to the device credential (Expo's isRetryingWithDeviceCredentials). */
    private var fallback = false
    /** The Activity on screen (AppLockGate attaches it), for the prompt and its fallback; weak, so a finished one is never kept. */
    private var host: WeakReference<MainActivity>? = null

    fun attach(activity: MainActivity) { host = WeakReference(activity) }
    fun detach(activity: MainActivity) { if (host?.get() === activity) host = null }

    /** At boot, off the main thread: core's value. While on, the app opens locked (RN's `useState(enabled)`). */
    internal fun boot(runtime: CoreHost) {
        val on = runtime.appLock().getBoolean("value")
        shell.ui { enabled = on; locked = on }
    }

    /** Core holds [on] (General's switch): turning it on leaves the app open, as RN's gate does; turning it off unlocks. */
    internal fun stored(on: Boolean) {
        enabled = on
        if (!on) { locked = false; failure = null }
    }

    /**
     * RN locks when AppState leaves active (Android's onPause), but not while its own prompt is up. A rotation is no leave:
     * RN's activity handles it without a pause, while this one is recreated.
     */
    fun paused(rotating: Boolean) {
        if (!enabled || authenticating || rotating) return
        locked = true
        failure = null
        locks += 1
    }

    /** RN's shouldAttemptMobileAppLockAuthentication. */
    fun shouldPrompt(resumed: Boolean) = enabled && locked && !authenticating && resumed && prompted != locks

    /** The lock screen's own prompt, once per lock. */
    fun promptOnce() {
        prompted = locks
        unlock()
    }

    /** RN's authenticate: core's `appLock.prompt` as the prompt's title; a yes unlocks, a no shows core's line for why. */
    fun unlock() {
        if (!enabled || authenticating) return
        failure = null
        ask(t("appLock.prompt")) { reason -> if (reason == null) locked = false else failure = reason }
    }

    /**
     * RN's handleAppLockToggle on core's [row]: off sends core's edit at once; on asks the device lock with core's `enablePrompt`
     * first, and only a yes sends it. A no shows core's line for why under the row, until the next toggle or visit.
     */
    fun toggle(row: JSONObject) {
        val settings = shell.menu.settings
        settings.editLocal { remove(SWITCH_FAILURE) }
        val edit = row.getJSONObject("edit")
        if (!edit.getBoolean("value")) return settings.general(edit)
        ask(row.getJSONObject("enablePrompt").getString("promptMessage")) { reason ->
            if (reason == null) shell.menu.whenIdle { settings.general(edit) } else settings.editLocal { put(SWITCH_FAILURE, reason) }
        }
    }

    /** Core's words for General's last failed prompt, under the switch. */
    fun switchFailure(row: JSONObject): String? = shell.menu.settings.local.menuText(SWITCH_FAILURE)?.let { row.getJSONObject("errors").getString(it) }

    /**
     * RN's authenticateWithDeviceLock through expo-local-authentication on Android: AndroidX BiometricPrompt titled [title], with
     * weak biometrics or the device credential and confirmation required, and no cancel button (Android allows none beside the
     * credential). One prompt at a time.
     */
    private fun ask(title: String, next: (String?) -> Unit) {
        if (authenticating) return
        authenticating = true
        then = next
        fallback = false
        prompt(title, Authenticators.BIOMETRIC_WEAK or Authenticators.DEVICE_CREDENTIAL)
    }

    /**
     * One prompt on the Activity on screen. No secure screen lock answers "unavailable" (Expo's not_enrolled), as does no
     * Activity; one saving its state cannot show a prompt, which answers "cancelled".
     */
    private fun prompt(title: String, authenticators: Int) {
        val activity = host?.get() ?: return answered("unavailable")
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

    /**
     * Expo's bounded fallback: when a biometric cannot be used ([BIOMETRIC_UNUSABLE]) on a device with a secure screen lock, it asks
     * once for the device credential alone: Android's credential screen before Android 11 (MainActivity.credential answers), a
     * credential-only prompt from Android 11. Every other error, and a second one, is the answer.
     */
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

    /** The device lock's answer, on the main thread: null for a yes, else core's reason key; the flow that asked goes on. */
    internal fun answered(reason: String?) {
        authenticating = false
        fallback = false
        val next = then
        then = null
        next?.invoke(reason)
    }

    /** expo-local-authentication's error codes as RN's getMobileAppLockErrorKey reads them. */
    private fun reason(code: Int) = when (code) {
        BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_USER_CANCELED -> "cancelled"
        BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "unavailable"
        else -> "failed"
    }
}

/**
 * While App lock is on, Android's recents keeps no picture of the app: recents screenshots are off from Android 13, and before
 * it the window is FLAG_SECURE (which also blocks screenshots). Stronger than RN, whose lock screen races the recents snapshot.
 */
private fun protectRecents(activity: Activity, on: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) activity.setRecentsScreenshotEnabled(!on)
    else if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
}

/** Lucide's LockKeyhole at RN's stroke 2.2. */
private val LockKeyhole = lucide("LockKeyhole", circle(12, 16, 1), "M5 10h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z",
    "M7 10V7a5 5 0 0 1 10 0v3", stroke = 2.2f)

/**
 * RN's MobileAppLockGate around the app's screens: each time the app leaves the foreground (not a rotation) it locks, and while
 * locked the lock screen replaces the screens, so TalkBack reaches none of them. The screens keep their saved state (scroll
 * positions, open pickers) for when they come back.
 */
@Composable
fun AppLockGate(model: InboxViewModel, content: @Composable () -> Unit) {
    val owner = LocalLifecycleOwner.current
    val activity = LocalActivity.current
    DisposableEffect(owner, activity) {
        val main = activity as? MainActivity
        main?.let(model.lock::attach)
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) model.lock.paused(activity?.isChangingConfigurations == true) }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            main?.let(model.lock::detach)
        }
    }
    val on = model.lock.enabled
    LaunchedEffect(activity, on) { activity?.let { protectRecents(it, on) } }
    val screens = rememberSaveableStateHolder()
    // From the boot's end, so the lock screen shows in the user's theme (the boot draws no data).
    if (model.lock.locked && !model.loading) AppLockScreen(model) else screens.SaveableStateProvider("app", content)
}

/**
 * RN's lock screen: the lock tile, core's title, core's description or the last failure's line, and Unlock, centered; it scrolls
 * when large text does not fit (a short landscape window).
 */
@Composable
private fun AppLockScreen(model: InboxViewModel) {
    val theme = LocalTheme.current
    val c = theme.colors
    val lock = model.lock
    val activity = LocalActivity.current
    val resumed by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    // The system bars' icons follow the theme here too (the screens that set them are gone).
    SideEffect {
        activity?.window?.let { window ->
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !theme.isDark
                isAppearanceLightNavigationBars = !theme.isDark
            }
        }
    }
    // RN asks by itself once per lock, 250 ms after the app is active.
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
