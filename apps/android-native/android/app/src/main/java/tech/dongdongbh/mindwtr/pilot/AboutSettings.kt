package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
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
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.platform.LocalView
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.core.net.toUri
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors


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


internal fun aboutStub(port: String): String? = port.trim().toIntOrNull()?.takeIf { it in 1..65535 }?.let { "http://127.0.0.1:$it" }


internal fun aboutFeedbackEndpoint(buildType: String, builtEndpoint: String, stub: String?): String = when {
    buildType == "release" -> builtEndpoint
    else -> stub?.let { "$it/feedback" } ?: ""
}


internal fun aboutPlayAnswer(source: String, due: Boolean, stubbed: Boolean, askPlay: () -> JSONObject?): JSONObject? = when {
    source == "sideload" || !due -> null
    stubbed -> JSONObject().put("error", "Google Play is stubbed in a device check")
    else -> askPlay()
}


class AboutSettingsModel(private val menu: MenuModel) {
    private companion object {

        val checks: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-about-check") }
    }
    private val shell get() = menu.shell
    private val app get() = shell.getApplication<Application>()


    @Volatile private var installer: String? = null


    private val stubbed by lazy { aboutStub(debugProperty("about_stub")) != null }

    @Volatile private var silentRan = false

    var checking by mutableStateOf(false); private set

    var alert by mutableStateOf<JSONObject?>(null); private set

    var feedback by mutableStateOf(Feedback()); private set

    var feedbackCheck by mutableStateOf<JSONObject?>(null); private set

    data class Feedback(
        val open: Boolean = false,
        val category: String = "bug",
        val message: String = "",
        val email: String = "",
        val location: String = "",
        val includeDiagnostics: Boolean = false,

        val status: String = "idle",
        val error: String? = null,

        val visit: Int = 0,
    )

    internal fun installerSource(runtime: CoreHost): String = installer ?: run {
        val referrer = if (stubbed) debugProperty("about_referrer") else PlayServices.installReferrer(app)
        val installing = if (stubbed) debugProperty("about_installer").ifEmpty { null } else installingPackage()
        runtime.menuRead("aboutInstallerSource", JSONObject().put("referrer", referrer ?: JSONObject.NULL)
            .put("installerPackageName", installing ?: JSONObject.NULL).toString()).getString("source")
    }.also { installer = it }


    private fun installingPackage(): String? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) app.packageManager.getInstallSourceInfo(app.packageName).installingPackageName
        else @Suppress("DEPRECATION") app.packageManager.getInstallerPackageName(app.packageName)
    }.getOrNull()


    fun read(runtime: CoreHost): JSONObject =
        runtime.menuRead("aboutSettings", JSONObject().put("installerSource", installerSource(runtime)).toString())


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


    private fun updateCheck(mode: String) {
        val runtime = shell.coreHost() ?: return
        if (mode == "manual") checking = true
        Thread({
            val answer = runCatching {
                val source = installerSource(runtime)

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
                    else shell.showToast(notice)
                }
            }
        }, "mindwtr-about-update").start()
    }

    fun checkForUpdates() { if (!checking) updateCheck("manual") }

    fun dismissAlert() { alert = null }


    fun pressAlert(button: JSONObject, context: Context) {
        alert = null
        button.menuText("url")?.let { open(context, it) }
    }


    fun open(context: Context, url: String): Boolean = runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
    }.getOrElse { Log.w(CoreHost.TAG, "About link not opened ${it.javaClass.simpleName}"); false }


    fun rate(context: Context, view: JSONObject) {
        val rate = view.getJSONObject("rate")
        if (rate.getJSONArray("urls").let { urls -> (0 until urls.length()).none { open(context, urls.getString(it)) } }) {
            val failed = rate.getJSONObject("failed")
            shell.showToast(failed)
        }
    }


    fun openFeedback() {
        feedback = feedback.copy(open = true, status = "idle", error = null, visit = feedback.visit + 1)
        check()
    }

    fun closeFeedback() { feedback = feedback.copy(open = false, visit = feedback.visit + 1) }


    fun edit(change: Feedback.() -> Feedback) {
        val before = feedback
        var next = before.change()
        if (next.category != "bug") next = next.copy(location = "", includeDiagnostics = false)
        if (next.message != before.message || next.email != before.email || next.location != before.location) next = next.copy(error = null)
        feedback = next
        check()
    }


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


@Composable
internal fun AboutSettings(model: InboxViewModel, view: JSONObject) {
    val about = model.menu.settings.about
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    Card(top = 0) {
        Column(Modifier.fillMaxWidth().heightIn(min = 196.dp).rnBorderBottom(c.border).padding(horizontal = 24.dp, vertical = 28.dp),
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


            FlowRow(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (id != "checkForUpdates") Modifier.rnBorderTop(c.border) else Modifier)
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


@Composable
internal fun AboutOverlays(model: InboxViewModel, view: JSONObject) {
    val about = model.menu.settings.about
    val context = LocalContext.current
    if (about.feedback.open) FeedbackModal(model, view.getJSONObject("feedback"))
    about.alert?.let { alert ->
        val buttons = alert.menuObjects("buttons")
        val cancel = buttons.firstOrNull { it.optString("style") == "cancel" }
        val action = buttons.firstOrNull { it.optString("style") != "cancel" }

        AlertDialog(
            onDismissRequest = { about.dismissAlert() },
            title = { Text(alert.getString("title")) },
            text = { Text(alert.getString("message"), modifier = Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { action?.let { TextButton({ about.pressAlert(it, context) }, Modifier.testTag("about-alert-action")) { Text(it.getString("text").uppercase()) } } },
            dismissButton = { cancel?.let { TextButton({ about.dismissAlert() }, Modifier.testTag("about-alert-cancel")) { Text(it.getString("text").uppercase()) } } },
        )
    }
}


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
    var confirmNoEmail by remember { mutableStateOf(false) }
    if (confirmNoEmail) AlertDialog(
        onDismissRequest = { confirmNoEmail = false },
        title = { Text(text.getString("noEmailTitle")) },
        text = { Text(text.getString("noEmailDescription")) },
        confirmButton = { TextButton(onClick = { confirmNoEmail = false; if (canSend) about.send() }) { Text(text.getString("sendWithoutEmail")) } },
        dismissButton = { TextButton(onClick = { confirmNoEmail = false }) { Text(text.getString("addEmail")) } },
    )
    Dialog(onDismissRequest = { about.closeFeedback() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        BoxWithConstraints(Modifier.fillMaxSize().background(theme.feedbackScrim).semantics { testTagsAsResourceId = true }
            .pointerInput(Unit) { detectTapGestures { about.closeFeedback() } }.imePadding().padding(18.dp), contentAlignment = Alignment.Center) {
            val shape = RoundedCornerShape(18.dp)
            Column(Modifier.fillMaxWidth().heightIn(max = maxHeight * 0.88f).clip(shape).background(c.cardBg)
                .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.testTag("feedback-modal")) {

                Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text(text.getString("title"), style = padded(rnText(17, 700)), color = c.text, modifier = Modifier.semantics { heading() })
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
                                .rnBorder(1.dp, if (on) c.tint else c.border, buttonShape)
                                .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; testTag = "feedback-category-$category"; onClick { about.edit { copy(category = category) }; true } }
                                .clickable { about.edit { copy(category = category) } }.padding(horizontal = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                                Icon(when (category) { "bug" -> Lucide.Bug; "feature" -> Lucide.Lightbulb; else -> Lucide.MessageSquare }, null, tint = tone, modifier = Modifier.size(17.dp))
                                Text(label, style = padded(rnText(12, 700)), color = tone, maxLines = 2)
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
                                Box(Modifier.heightIn(min = 36.dp).clip(chip).background(if (on) c.tint.copy(alpha = 0x18 / 255f) else c.bg).rnBorder(1.dp, if (on) c.tint else c.border, chip)
                                    .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; testTag = "feedback-place-$place"
                                        onClick { about.edit { copy(location = if (on) "" else place) }; true } }
                                    .clickable { about.edit { copy(location = if (on) "" else place) } }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                                    Text(label, style = padded(rnText(12, 700)), color = if (on) c.tint else c.secondaryText)
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
                        Row(Modifier.fillMaxWidth().clip(rowShape).background(c.bg).rnBorder(1.dp, c.border, rowShape).padding(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(text.getString("includeDiagnostics"), style = padded(rnText(14, 700)), color = c.text)
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
                Row(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                    val secondary = RoundedCornerShape(12.dp)
                    val cancel = text.getString("cancel")
                    Box(Modifier.widthIn(min = 92.dp).heightIn(min = 44.dp).clip(secondary).rnBorder(1.dp, c.border, secondary)
                        .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; onClick { about.closeFeedback(); true } }
                        .clickable { about.closeFeedback() }.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                        Text(cancel, style = padded(rnText(14, 700)), color = c.secondaryText)
                    }
                    PrimaryButton(if (draft.status == "sending") text.getString("sending") else text.getString("submit"), canSend, draft.status == "sending",
                        Modifier.widthIn(min = 126.dp).testTag("feedback-send")) {
                        if (draft.email.trim { it.isWhitespace() || it == '\uFEFF' }.isEmpty()) confirmNoEmail = true else about.send()
                    }
                }
            }
        }
    }
}


@Suppress("DEPRECATION")
private fun padded(style: TextStyle) = style.copy(platformStyle = PlatformTextStyle(includeFontPadding = true))

@Composable
private fun FieldLabel(label: String) = Text(label.uppercase(), style = padded(rnText(12, 700)), color = LocalTheme.current.colors.secondaryText)


@Composable
private fun Notice(title: String, description: String?, color: Color, wash: Int) {
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(color.copy(alpha = wash / 255f)).rnBorder(1.dp, color.copy(alpha = 0x55 / 255f), shape)
        .padding(horizontal = 12.dp, vertical = 10.dp)) {
        Text(title, style = rnText(13, 600, 18), color = color)
        description?.let { Text(it, style = rnText(12, 400, 18), color = color, modifier = Modifier.padding(top = 4.dp)) }
    }
}


@Composable
private fun PrimaryButton(label: String, enabled: Boolean, spinning: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(12.dp)
    val alpha = if (enabled) 1f else 0.5f
    Row(modifier.heightIn(min = 44.dp).clip(shape).background(theme.filledBg.copy(alpha = theme.filledBg.alpha * alpha))
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        if (spinning) CircularProgressIndicator(Modifier.size(20.dp), color = theme.filledText.copy(alpha = theme.filledText.alpha * alpha), strokeWidth = 2.dp)
        Text(label, style = padded(rnText(14, 700)), color = theme.filledText.copy(alpha = theme.filledText.alpha * alpha))
    }
}


@Composable
private fun FeedbackField(value: String, label: String, placeholder: String, multiline: Boolean, tag: String, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(value, change, singleLine = !multiline, cursorBrush = SolidColor(c.tint),
        textStyle = (if (multiline) rnText(14, 400, 20) else rnText(14, 400)).copy(color = c.text),
        keyboardOptions = if (multiline) KeyboardOptions.Default else KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().heightIn(min = if (multiline) 126.dp else 44.dp).clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape)
            .semantics { contentDescription = label }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = if (multiline) 10.dp else 12.dp), contentAlignment = if (multiline) Alignment.TopStart else Alignment.CenterStart) {

                if (value.isEmpty()) Text(placeholder, style = padded(rnText(14, 400)), color = c.secondaryText)
                inner()
            }
        })
}


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
