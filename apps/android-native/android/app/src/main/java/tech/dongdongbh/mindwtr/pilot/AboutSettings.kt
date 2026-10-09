package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/*
 * RN's Settings › About (about-settings-screen.tsx) and its feedback modal (feedback-settings-modal.tsx) on core's About contract
 * (native-host-contract-about.ts): every row, word, check, alert, toast and request is core's. Kotlin keeps the screen state RN
 * keeps in React state (the open alert, the modal's draft), asks Google Play what RN's modules ask (PlayServices: the Play
 * channel's, none on FOSS) and opens the links.
 */

/**
 * The build as About, feedback and the heartbeat report it (host-about.ts's NativeAppInfo): RN's app.json version, build number
 * and package, the release tag, this channel, and the endpoints it was built with. A development build (RN's __DEV__) never
 * sends a heartbeat, and only a release build sends feedback ([aboutFeedbackEndpoint]). Debug builds only:
 * `debug.mindwtr.native.about_stub=<port>` points the feedback endpoint, the heartbeat and GitHub's release API at
 * check-about-device.mjs's stub on 127.0.0.1:<port> (adb reverse) and lets the heartbeat send there.
 */
fun aboutAppInfo(): String {
    val stub = aboutStub(debugProperty("about_stub"))
    return JSONObject()
        .put("appName", BuildConfig.RN_NAME)
        .put("version", BuildConfig.RN_VERSION)
        .put("releaseVersion", BuildConfig.RN_RELEASE_VERSION)
        .put("build", BuildConfig.RN_VERSION_CODE)
        .put("packageName", BuildConfig.RN_PACKAGE)
        .put("isFossBuild", BuildConfig.FOSS)
        .put("isDev", BuildConfig.DEBUG && stub == null)
        .put("platform", "android")
        .put("platformVersion", Build.VERSION.SDK_INT)
        .put("osRelease", Build.VERSION.RELEASE ?: "")
        .put("feedbackEndpointUrl", aboutFeedbackEndpoint(BuildConfig.BUILD_TYPE, BuildConfig.FEEDBACK_ENDPOINT_URL, stub))
        .put("analyticsHeartbeatUrl", stub?.let { "$it/heartbeat" } ?: BuildConfig.ANALYTICS_HEARTBEAT_URL)
        .put("analyticsHeartbeatChannel", BuildConfig.ANALYTICS_HEARTBEAT_CHANNEL)
        .apply { stub?.let { put("githubReleasesApi", "$it/github/releases/latest") } }
        .toString()
}

/** check-about-device.mjs's stub on 127.0.0.1:<[port]> (adb reverse), or null when [port] is not one. */
internal fun aboutStub(port: String): String? = port.trim().toIntOrNull()?.takeIf { it in 1..65535 }?.let { "http://127.0.0.1:$it" }

/**
 * Where feedback goes: a release build to the endpoint it was built with; every other build (debug, the upgrade check, the
 * benchmarks) only to a check's [stub], else nowhere (the modal says feedback is not configured), so a test build never sends
 * real feedback.
 */
internal fun aboutFeedbackEndpoint(buildType: String, builtEndpoint: String, stub: String?): String = when {
    buildType == "release" -> builtEndpoint
    else -> stub?.let { "$it/feedback" } ?: ""
}

/**
 * Google Play's update answer for core's update check (its `play` input): asked only on a Play (or unknown) install and only after
 * core's preflight said the check is [due]; a device check's stub ([stubbed]) answers a failure instead of calling Play. Null:
 * Play not asked.
 */
internal fun aboutPlayAnswer(source: String, due: Boolean, stubbed: Boolean, askPlay: () -> JSONObject?): JSONObject? = when {
    source == "sideload" || !due -> null
    stubbed -> JSONObject().put("error", "Google Play is stubbed in a device check")
    else -> askPlay()
}

/** Settings › About's state and requests: the screen, its update checks, the alert, Rate, the links and the feedback modal. */
class AboutSettingsModel(private val menu: MenuModel) {
    private companion object {
        /** The modal's checks in the order typed, so an older answer never lands after a newer one. */
        val checks: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-about-check") }
    }
    private val shell get() = menu.shell
    private val app get() = shell.getApplication<Application>()

    /**
     * How the app was installed (RN's androidInstallerSource), read once per process: core's getAboutInstallerSource from Google
     * Play's install referrer and the installing package (a FOSS build is a sideload).
     */
    @Volatile private var installer: String? = null
    /**
     * A device check's stub (debug builds, `about_stub`): Google Play is never called. The referrer and the installing package
     * come from `debug.mindwtr.native.about_referrer` and `about_installer` (both empty by default: a sideload), and Play's
     * update answer is a failure.
     */
    private val stubbed by lazy { aboutStub(debugProperty("about_stub")) != null }
    /** The silent check ran for this visit (RN's effect runs when the screen mounts). */
    @Volatile private var silentRan = false
    /** Check for updates is running (RN's spinner on its row). */
    var checking by mutableStateOf(false); private set
    /** RN's Alert for an update: core's title, message and buttons. */
    var alert by mutableStateOf<JSONObject?>(null); private set
    /** The feedback modal's draft and state (RN's React state), while open or kept for its next opening; see [Feedback]. */
    var feedback by mutableStateOf(Feedback()); private set
    /** Core's check of the draft as typed (Send on or off, the error line, the message limit), for [Feedback.message] and the rest. */
    var feedbackCheck by mutableStateOf<JSONObject?>(null); private set

    data class Feedback(
        val open: Boolean = false,
        val category: String = "bug",
        val message: String = "",
        val email: String = "",
        val location: String = "",
        val includeDiagnostics: Boolean = false,
        /** idle, sending, sent or error. */
        val status: String = "idle",
        val error: String? = null,
        /** Each opening is its own visit: a send from an earlier one that ends later changes nothing. */
        val visit: Int = 0,
    )

    private fun installerSource(runtime: CoreHost): String = installer ?: run {
        val referrer = if (stubbed) debugProperty("about_referrer") else PlayServices.installReferrer(app)
        val installing = if (stubbed) debugProperty("about_installer").ifEmpty { null } else installingPackage()
        runtime.menuRead("aboutInstallerSource", JSONObject().put("referrer", referrer ?: JSONObject.NULL)
            .put("installerPackageName", installing ?: JSONObject.NULL).toString()).getString("source")
    }.also { installer = it }

    /** PackageManager's installing package (com.android.vending for every Google Play install), or null. */
    private fun installingPackage(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) app.packageManager.getInstallSourceInfo(app.packageName).installingPackageName
        else @Suppress("DEPRECATION") app.packageManager.getInstallerPackageName(app.packageName)
    }.getOrNull()

    /** Settings' read of this screen: core's view for the install. */
    fun read(runtime: CoreHost): JSONObject =
        runtime.menuRead("aboutSettings", JSONObject().put("installerSource", installerSource(runtime)).toString())

    /** The screen on show: the silent check, once per visit. */
    fun follow(view: JSONObject) {
        if (silentRan) return
        silentRan = true
        updateCheck("silent")
    }

    fun leave() {
        silentRan = false
        alert = null
        if (feedback.open) closeFeedback()
    }

    /**
     * Core's update check with Google Play's answer on a Play install when core says the check is due (none on FOSS, a sideload,
     * or a silent check within the day), and whether market links open.
     */
    private fun updateCheck(mode: String) {
        val runtime = shell.coreHost() ?: return
        if (mode == "manual") checking = true
        Thread({
            val answer = runCatching {
                val source = installerSource(runtime)
                // Core's preflight first; when it fails the check does not run (no Play, no GitHub, nothing stored).
                val due = runtime.aboutRequest("isAboutUpdateCheckDue", JSONObject().put("mode", mode).toString()).getBoolean("due")
                val play = aboutPlayAnswer(source, due, stubbed) { PlayServices.updateInfo(app) }
                val market = Intent(Intent.ACTION_VIEW, "market://details?id=${BuildConfig.RN_PACKAGE}".toUri()).resolveActivity(app.packageManager) != null
                runtime.aboutRequest("runAboutUpdateCheck", JSONObject().put("mode", mode).put("installerSource", source)
                    .put("play", play ?: JSONObject.NULL).put("marketAvailable", market).toString())
            }
            shell.ui {
                if (mode == "manual") checking = false
                answer.onFailure { Log.w(CoreHost.TAG, "About update check failed ${failureForLog(it)}") }
                answer.getOrNull()?.menuObjects("notices")?.forEach { notice ->
                    if (notice.getString("kind") == "alert") alert = notice
                    else shell.showToast(notice.getString("title"), notice.getString("message"), notice.getString("tone"),
                        durationMs = if (notice.has("durationMs")) notice.getLong("durationMs") else null)
                }
            }
        }, "mindwtr-about-update").start()
    }

    fun checkForUpdates() { if (!checking) updateCheck("manual") }

    fun dismissAlert() { alert = null }

    /** An alert button: its link (RN's Linking.openURL), then the alert closes. */
    fun pressAlert(button: JSONObject, context: Context) {
        alert = null
        button.menuText("url")?.let { open(context, it) }
    }

    /** RN's Linking.openURL: true when something opened it. */
    fun open(context: Context, url: String): Boolean = runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
    }.getOrElse { Log.w(CoreHost.TAG, "About link not opened ${it.javaClass.simpleName}"); false }

    /** Rate our app: core's links in order (the market link, else the web page); none opens: core's toast. */
    fun rate(context: Context, view: JSONObject) {
        val rate = view.getJSONObject("rate")
        if (rate.getJSONArray("urls").let { urls -> (0 until urls.length()).none { open(context, urls.getString(it)) } }) {
            val failed = rate.getJSONObject("failed")
            shell.showToast(failed.getString("title"), failed.getString("message"), failed.getString("tone"))
        }
    }

    // ---- The feedback modal ----

    fun openFeedback() {
        feedback = feedback.copy(open = true, status = "idle", error = null, visit = feedback.visit + 1)
        check()
    }

    fun closeFeedback() { feedback = feedback.copy(open = false, visit = feedback.visit + 1) }

    /** A draft edit, as RN's setters: a typed field or a place clears the error; a category other than bug drops its place and diagnostics. */
    fun edit(change: Feedback.() -> Feedback) {
        val before = feedback
        var next = before.change()
        if (next.category != "bug") next = next.copy(location = "", includeDiagnostics = false)
        if (next.message != before.message || next.email != before.email || next.location != before.location) next = next.copy(error = null)
        feedback = next
        check()
    }

    /** Core's checkAboutFeedback for the draft as shown; an answer counts only while the draft is still the one it checked. */
    private fun check() {
        val runtime = shell.coreHost() ?: return
        val draft = feedback
        checks.execute {
            val answer = runCatching {
                runtime.menuRead("aboutFeedbackCheck", JSONObject().put("message", draft.message).put("email", draft.email)
                    .put("sending", draft.status == "sending").put("error", draft.error ?: JSONObject.NULL)
                    .put("category", draft.category).put("location", draft.location).toString())
            }.getOrNull() ?: return@execute
            shell.ui { if (feedback == draft) feedbackCheck = answer }
        }
    }

    /** Send: core refuses (the error line), sends (Sent, the draft cleared) or fails (RN's line, the draft kept). */
    fun send() {
        val runtime = shell.coreHost() ?: return
        val draft = feedback.copy(status = "sending", error = null)
        feedback = draft
        check()
        Thread({
            val answer = runCatching {
                runtime.aboutRequest("submitAboutFeedback", JSONObject().put("installerSource", installerSource(runtime)).put("draft", JSONObject()
                    .put("category", draft.category).put("message", draft.message).put("email", draft.email)
                    .put("location", draft.location).put("includeDiagnostics", draft.includeDiagnostics)).toString())
            }
            shell.ui {
                if (feedback.visit != draft.visit) return@ui
                val reply = answer.getOrNull()
                feedback = when {
                    reply == null -> feedback.copy(status = "error", error = t("settings.feedbackFailed"))
                    !reply.isNull("refused") -> feedback.copy(status = "idle", error = reply.getString("refused"))
                    reply.getBoolean("sent") -> feedback.copy(status = "sent", message = "", email = "", location = "", includeDiagnostics = false)
                    else -> feedback.copy(status = "error", error = reply.getString("failed"))
                }
                check()
            }
        }, "mindwtr-about-feedback").start()
    }
}

// ---- The screen ----

/** RN's About card: the header (icon, name, version), then core's rows; a link row opens its link or its action. */
@Composable
internal fun AboutSettings(model: InboxViewModel, view: JSONObject) {
    val about = model.menu.settings.about
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    Card(top = 0) {
        Column(Modifier.fillMaxWidth().heightIn(min = 196.dp).hairline(c.border, top = false).padding(horizontal = 24.dp, vertical = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Image(painterResource(R.drawable.about_app_icon), null, contentScale = ContentScale.Crop,
                modifier = Modifier.padding(bottom = 16.dp).size(84.dp).clip(RoundedCornerShape(20.dp)))
            Text(view.getString("appName"), style = rnText(24, 700), color = c.text, maxLines = 2, textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 6.dp))
            Text(view.getString("versionText"), style = rnText(15, 500), color = c.secondaryText, maxLines = 2, textAlign = TextAlign.Center,
                modifier = Modifier.testTag("about-version"))
        }
        for (row in view.menuObjects("rows")) {
            val id = row.getString("id")
            val label = row.getString("label")
            val value = row.getString("value")
            val link = row.getString("tone") == "link"
            val spinning = id == "checkForUpdates" && about.checking
            val press = {
                when (id) {
                    "checkForUpdates" -> about.checkForUpdates()
                    "rate" -> about.rate(context, view)
                    "feedback" -> about.openFeedback()
                    else -> row.menuText("url")?.let { about.open(context, it) }
                }
            }
            // RN's settingRow: the label left, the value or link at the right (wrapping under it at large text), a hairline above
            // every row but Check for updates.
            FlowRow(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (id != "checkForUpdates") Modifier.hairline(c.border, top = true) else Modifier)
                .then(if (link) Modifier.clearAndSetSemantics {
                    contentDescription = "$label, $value"; role = Role.Button; testTag = "about-$id"
                    if (!spinning) onClick { press(); true } else disabled()
                }.clickable(enabled = !spinning) { press() } else Modifier.semantics { testTag = "about-$id" })
                .padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.Start), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(label, style = rnText(16, 500, 21), color = c.text, modifier = Modifier.weight(1f, fill = true))
                if (spinning) CircularProgressIndicator(Modifier.size(20.dp), color = LocalTheme.current.settingsLink, strokeWidth = 2.dp)
                else Text(value, style = rnText(16, 400, 21), color = if (link) LocalTheme.current.settingsLink else c.secondaryText, textAlign = TextAlign.End)
            }
        }
    }
}


/** The About screen's alert and feedback modal, over the settings screen. */
@Composable
internal fun AboutOverlays(model: InboxViewModel, view: JSONObject) {
    val about = model.menu.settings.about
    val context = LocalContext.current
    if (about.feedback.open) FeedbackModal(model, view.getJSONObject("feedback"))
    about.alert?.let { alert ->
        val buttons = alert.menuObjects("buttons")
        val cancel = buttons.firstOrNull { it.optString("style") == "cancel" }
        val action = buttons.firstOrNull { it.optString("style") != "cancel" }
        // RN's Alert.alert on Android: the title, the message, the cancel button at the left of the action.
        AlertDialog(
            onDismissRequest = { about.dismissAlert() },
            title = { Text(alert.getString("title")) },
            text = { Text(alert.getString("message"), modifier = Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { action?.let { TextButton({ about.pressAlert(it, context) }, Modifier.testTag("about-alert-action")) { Text(it.getString("text").uppercase()) } } },
            dismissButton = { cancel?.let { TextButton({ about.dismissAlert() }, Modifier.testTag("about-alert-cancel")) { Text(it.getString("text").uppercase()) } } },
        )
    }
}

/**
 * RN's FeedbackSettingsModal (feedback-settings-modal.tsx, settings.styles.ts feedback*): the card over a 42% black backdrop, the
 * title with core's GitHub line and its link, the category buttons, a bug's places, the message, the reply email, a bug's
 * diagnostics switch, core's notices, Cancel and Send; after a send, core's thanks and Close.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FeedbackModal(model: InboxViewModel, view: JSONObject) {
    val about = model.menu.settings.about
    val draft = about.feedback
    val theme = LocalTheme.current
    val c = theme.colors
    val context = LocalContext.current
    val text = view.getJSONObject("text")
    val configured = view.getBoolean("isConfigured")
    val check = about.feedbackCheck
    val canSend = check?.optBoolean("canSubmit") == true && draft.status != "sending"
    val sent = draft.status == "sent"
    BackHandler { about.closeFeedback() }
    Box(Modifier.fillMaxSize().background(theme.feedbackScrim).pointerInput(Unit) { detectTapGestures { about.closeFeedback() } }
        .imePadding().padding(18.dp), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(18.dp)
        Column(Modifier.fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.88f).dp).clip(shape).background(c.cardBg)
            .border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.testTag("feedback-modal")) {
            // The header: the title, core's GitHub line (not after a send), and the close X.
            Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(text.getString("title"), style = rnText(17, 700), color = c.text, modifier = Modifier.semantics { heading() })
                    if (!sent) {
                        val line = text.getJSONObject("gitHub").getJSONObject(draft.category)
                        val linkLabel = line.getString("link")
                        Text(buildAnnotatedString {
                            append(line.getString("before"))
                            withStyle(SpanStyle(color = c.tint, textDecoration = TextDecoration.Underline)) { append(linkLabel) }
                            append(line.getString("after"))
                        }, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 3.dp)
                            .semantics { role = Role.Button; contentDescription = "${line.getString("before")}$linkLabel${line.getString("after")}"; testTag = "feedback-github" }
                            .clickable { about.open(context, line.getString("url")) })
                    }
                }
                Box(Modifier.size(34.dp).clip(CircleShape).clearAndSetSemantics { contentDescription = text.getString("close"); role = Role.Button; onClick { about.closeFeedback(); true } }
                    .clickable { about.closeFeedback() }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
                }
            }
            if (sent) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Notice(text.getString("sent"), null, c.success, wash = 0x22)
                    PrimaryButton(text.getString("close"), true, false, Modifier.fillMaxWidth()) { about.closeFeedback() }
                }
                return@Column
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FieldLabel(text.getString("category"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (category in view.getJSONArray("categories").let { list -> List(list.length()) { list.getString(it) } }) {
                        val on = category == draft.category
                        val label = text.getJSONObject("categories").getString(category)
                        val tone = if (on) c.tint else c.secondaryText
                        val buttonShape = RoundedCornerShape(12.dp)
                        Row(Modifier.weight(1f).heightIn(min = 42.dp).clip(buttonShape).background(if (on) c.tint.copy(alpha = 0x18 / 255f) else c.bg)
                            .border(1.dp, if (on) c.tint else c.border, buttonShape)
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; testTag = "feedback-category-$category"; onClick { about.edit { copy(category = category) }; true } }
                            .clickable { about.edit { copy(category = category) } }.padding(horizontal = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                            Icon(when (category) { "bug" -> Lucide.Bug; "feature" -> Lucide.Lightbulb; else -> Lucide.MessageSquare }, null, tint = tone, modifier = Modifier.size(17.dp))
                            Text(label, style = rnText(12, 700), color = tone, maxLines = 2)
                        }
                    }
                }
                if (draft.category == "bug") {
                    FieldLabel(text.getString("where"))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (place in view.getJSONArray("locations").let { list -> List(list.length()) { list.getString(it) } }) {
                            val on = place == draft.location
                            val label = text.getJSONObject("locations").getString(place)
                            val chip = RoundedCornerShape(18.dp)
                            Box(Modifier.heightIn(min = 36.dp).clip(chip).background(if (on) c.tint.copy(alpha = 0x18 / 255f) else c.bg).border(1.dp, if (on) c.tint else c.border, chip)
                                .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; testTag = "feedback-place-$place"
                                    onClick { about.edit { copy(location = if (on) "" else place) }; true } }
                                .clickable { about.edit { copy(location = if (on) "" else place) } }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                                Text(label, style = rnText(12, 700), color = if (on) c.tint else c.secondaryText)
                            }
                        }
                    }
                }
                FieldLabel(text.getString("message"))
                val limit = check?.optInt("messageMaxLength", 4000) ?: 4000
                FeedbackField(draft.message, text.getString("message"), text.getJSONObject("messagePlaceholders").getString(draft.category), multiline = true,
                    tag = "feedback-message") { typed -> about.edit { copy(message = typed.take(limit)) } }
                FieldLabel(text.getString("email"))
                FeedbackField(draft.email, text.getString("email"), text.getString("emailPlaceholder"), multiline = false, tag = "feedback-email") { typed ->
                    about.edit { copy(email = typed) }
                }
                if (draft.category == "bug") {
                    val rowShape = RoundedCornerShape(12.dp)
                    Row(Modifier.fillMaxWidth().clip(rowShape).background(c.bg).border(1.dp, c.border, rowShape).padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(text.getString("includeDiagnostics"), style = rnText(14, 700), color = c.text)
                            Text(text.getString("includeDiagnosticsDescription"), style = rnText(12, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                        }
                        RnSwitch(draft.includeDiagnostics, true, text.getString("includeDiagnostics"),
                            theme.feedbackSwitch) {
                            about.edit { copy(includeDiagnostics = !includeDiagnostics) }
                        }
                    }
                }
                if (!configured) Notice(text.getString("unavailable"), text.getString("unavailableDescription"), c.danger, wash = 0x18)
                check?.menuText("visibleError")?.let { Notice(it, null, c.danger, wash = 0x18) }
            }
            Row(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                val secondary = RoundedCornerShape(12.dp)
                val cancel = text.getString("cancel")
                Box(Modifier.widthIn(min = 92.dp).heightIn(min = 44.dp).clip(secondary).border(1.dp, c.border, secondary)
                    .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; onClick { about.closeFeedback(); true } }
                    .clickable { about.closeFeedback() }.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    Text(cancel, style = rnText(14, 700), color = c.secondaryText)
                }
                PrimaryButton(if (draft.status == "sending") text.getString("sending") else text.getString("submit"), canSend, draft.status == "sending",
                    Modifier.widthIn(min = 126.dp).testTag("feedback-send")) { about.send() }
            }
        }
    }
}

@Composable
private fun FieldLabel(label: String) = Text(label.uppercase(), style = rnText(12, 700), color = LocalTheme.current.colors.secondaryText)

/** RN's feedbackNotice: [color] text on its wash (`${color}${wash}`) inside a `${color}55` border. */
@Composable
private fun Notice(title: String, description: String?, color: Color, wash: Int) {
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(color.copy(alpha = wash / 255f)).border(1.dp, color.copy(alpha = 0x55 / 255f), shape)
        .padding(horizontal = 12.dp, vertical = 10.dp)) {
        Text(title, style = rnText(13, 600, 18), color = color)
        description?.let { Text(it, style = rnText(12, 400, 18), color = color, modifier = Modifier.padding(top = 4.dp)) }
    }
}

/** RN's feedbackPrimaryButton in the filled-button colors (useFilledButtonColors), half faded while off, with RN's spinner while sending. */
@Composable
private fun PrimaryButton(label: String, enabled: Boolean, spinning: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(12.dp)
    Row(modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = 44.dp).clip(shape).background(theme.filledBg)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        if (spinning) CircularProgressIndicator(Modifier.size(20.dp), color = theme.filledText, strokeWidth = 2.dp)
        Text(label, style = rnText(14, 700), color = theme.filledText)
    }
}

/** RN's feedbackTextArea (126 tall, multiline) and feedbackInput (44, an email keyboard): the screen color, a 12 radius border. */
@Composable
private fun FeedbackField(value: String, label: String, placeholder: String, multiline: Boolean, tag: String, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(value, change, singleLine = !multiline, cursorBrush = SolidColor(c.tint),
        textStyle = (if (multiline) rnText(14, 400, 20) else rnText(14, 400)).copy(color = c.text),
        keyboardOptions = if (multiline) KeyboardOptions.Default else KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().heightIn(min = if (multiline) 126.dp else 44.dp).clip(shape).background(c.bg).border(1.dp, c.border, shape)
            .semantics { contentDescription = label }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = if (multiline) 10.dp else 12.dp), contentAlignment = if (multiline) Alignment.TopStart else Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = if (multiline) rnText(14, 400, 20) else rnText(14, 400), color = c.secondaryText)
                inner()
            }
        })
}

/**
 * After a finished Weekly Review (RN's handleFinish): 650 ms later, core's store review gate; when it says so, Google Play's
 * review flow over [activity] (none on FOSS). A failure only logs, as RN's.
 */
fun requestStoreReviewAfterWeeklyReview(shell: InboxViewModel, activity: android.app.Activity?) {
    val runtime = shell.coreHost() ?: return
    if (activity == null) return
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        Thread({
            val request = runCatching {
                runtime.aboutRequest("attemptAboutStoreReview", JSONObject().put("storeReviewAvailable", PlayServices.reviewAvailable(activity)).toString())
                    .getBoolean("request")
            }.getOrElse { Log.w(CoreHost.TAG, "Store review gate failed ${failureForLog(it)}"); false }
            if (request) shell.ui {
                PlayServices.requestReview(activity) { failure ->
                    failure?.let { message -> Thread { runtime.logLine("Native store review request failed", JSONObject().put("scope", "store-review").put("error", message)) }.start() }
                }
            }
        }, "mindwtr-store-review").start()
    }, 650)
}
