package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.net.toUri
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.util.UUID
import java.util.concurrent.Executors

/** The journaled command this file sends (host-entry.ts MENU_COMMANDS; check-boot-gates.mjs keeps them in step). */
internal val STARTUP_PROMPT_COMMANDS = setOf("supportPromptShown")

/**
 * RN's startup prompts (app/_layout.tsx's queue; core's native-host-contract-startup-prompts.ts): after the validated boot core
 * picks at most one prompt (the welcome sheet, the maintainer announcement, the update reminder, the donation ask) on RN's
 * device keys, and asks again after each one closes, as RN's queue goes on. Kotlin draws the prompt and opens its links.
 */
class StartupPromptsModel(private val shell: InboxViewModel) {
    /** The open prompt: core's `{ id, words, language }` (the welcome sheet) or `{ id, announcement, notNow, closeLabel }`. */
    var prompt by mutableStateOf<JSONObject?>(null); private set
    /** Start using Mindwtr is seeding Getting Started (RN's busy sheet). */
    var seeding by mutableStateOf(false); private set
    /** The welcome sheet's error box after a seed that did not create Getting Started. */
    var seedError by mutableStateOf<String?>(null); private set

    // One ask or action at a time, in order (review O2e P3-B: two asks never overlap).
    private val asks = Executors.newSingleThreadExecutor { Thread(it, "mindwtr-startup-prompts") }
    private var runtime: CoreHost? = null
    /**
     * A debug build's preview (RN's prompt test controls): `debug.mindwtr.native.startup_prompt` names the prompt to open. As RN's
     * tests, the welcome sheet runs its real handlers; a window's preview stores nothing.
     */
    private val preview = if (BuildConfig.DEBUG) debugProperty("startup_prompt") else ""
    private var previewing = false
    /** Core's line when a preview has no window (RN's toast for an update preview on a FOSS build). */
    @Volatile private var previewNotice: String? = null
    /** The donation window whose showing was recorded (RN's onShown runs once per showing; a rotation redraws it). */
    private var recordedShowing: JSONObject? = null

    /**
     * [work] on the prompts' thread, in order. A screen model cleared before its boot ended (Back on the start screen) or before a
     * seed answered has shut it: nothing more runs, as the last screen's writer (InboxViewModel.keepLastRoute).
     */
    private fun later(work: () -> Unit) {
        if (asks.isShutdown) return
        runCatching { asks.execute(work) }
    }

    /** After the validated boot, once per screen model: core records today's prompt activity, then answers the prompt to open. */
    fun start(host: CoreHost) {
        if (runtime != null) return
        runtime = host
        ask(preview.ifEmpty { null })
    }

    private fun ask(previewId: String? = null) {
        val host = runtime ?: return
        later {
            runCatching {
                val input = JSONObject().put("installerSource", shell.menu.settings.about.installerSource(host))
                    .put("donationEnabled", BuildConfig.DONATION_PROMPT)
                previewId?.let { input.put("preview", it) }
                host.aboutRequest("beginStartupPrompts", input.toString()).also { previewNotice = it.optString("notice").ifEmpty { null } }.optJSONObject("prompt")
            }.onSuccess { next ->
                shell.ui { previewing = previewId != null && next != null; prompt = next; seedError = null }
                if (next == null && previewId != null) previewNotice?.let { notice -> shell.ui { shell.showToast(null, notice, "info") } }
            }.onFailure { Log.w(CoreHost.TAG, "Startup prompts not read ${failureForLog(it)}") }
        }
    }

    /**
     * The open prompt closes: "dismiss" (Not now, the X, Back, the backdrop, Skip, or a finished Start) or "act" (its button, or
     * the welcome sheet's Set up sync and Import tasks). Core stores what RN stores; then the next prompt is asked.
     */
    fun close(action: String) {
        val open = prompt ?: return
        prompt = null
        seedError = null
        if (previewing) { previewing = false; if (open.optString("id") != "onboarding") return }
        val host = runtime ?: return
        later {
            runCatching { host.aboutRequest("startupPromptAction", JSONObject().put("id", open.getString("id")).put("action", action).toString()) }
                .onFailure { Log.w(CoreHost.TAG, "Startup prompt action not stored ${failureForLog(it)}") }
        }
        ask()
    }

    /** The donation window is on screen (RN's onShown): its record on the device, then the synced one with the same time. */
    fun shown(open: JSONObject) {
        if (open.optString("id") != "donation" || previewing || recordedShowing === open) return
        recordedShowing = open
        val host = runtime ?: return
        later {
            runCatching {
                val at = host.aboutRequest("startupPromptAction", JSONObject().put("id", "donation").put("action", "shown").toString()).getString("shownAt")
                host.menuCommand("supportPromptShown", JSONObject().put("requestId", UUID.randomUUID().toString()).put("shownAt", at).toString())
            }.onFailure { Log.w(CoreHost.TAG, "Donation prompt showing not stored ${failureForLog(it)}") }
        }
    }

    /** The window's button: RN's handler closes it, then opens its link or, for feedback, Settings › About. */
    fun act(open: JSONObject, openLink: (String) -> Unit) {
        val action = open.getJSONObject("announcement").optJSONObject("action") ?: return
        close("act")
        if (action.optString("type") == "feedback") shell.menu.openSettingsScreen("about")
        else action.optString("url").trim().takeIf { it.isNotEmpty() }?.let(openLink)
    }

    /** The welcome sheet's Set up sync (`sync`) or Import tasks (`data`): RN closes it for this run, then opens that screen's handoff. */
    fun handoff(screen: String) {
        if (seeding) return
        close("act")
        shell.menu.openSettingsScreen(screen, onboardingHandoff = true)
    }

    /**
     * Start using Mindwtr: core's journaled Getting Started seed in the language core gave the sheet. On success the sheet is
     * dismissed for good and Getting Started opens with RN's toast; otherwise RN's error box and toast, and the sheet stays.
     */
    fun startFresh() {
        val open = prompt?.takeIf { it.optString("id") == "onboarding" } ?: return
        if (seeding) return
        val words = open.getJSONObject("words")
        val host = runtime ?: return
        seeding = true
        seedError = null
        val input = JSONObject().put("requestId", UUID.randomUUID().toString()).put("language", open.getString("language")).toString()
        Thread({
            val result = runCatching { host.menuCommand("gettingStarted", input).optString("projectId").takeIf { it.isNotEmpty() && it != "null" } }
            result.exceptionOrNull()?.let { Log.w(CoreHost.TAG, "Welcome sheet's Getting Started failed ${failureForLog(it)}") }
            shell.ui {
                seeding = false
                val projectId = result.getOrNull()
                when {
                    result.isFailure -> { seedError = words.getString("errorFailed"); shell.showToast(null, words.getString("toastFailed"), "error") }
                    projectId == null -> { seedError = words.getString("errorNotCreated"); shell.showToast(null, words.getString("toastNotCreated"), "info") }
                    else -> {
                        close("dismiss")
                        shell.menu.whenIdle { shell.menu.openProjects(projectId) }
                        shell.showToast(null, words.getString("toastReady"), "success")
                    }
                }
            }
        }, "mindwtr-welcome-seed").start()
    }

    /** The screen model is cleared: no ask starts after it. */
    fun shutdown() = asks.shutdown()
}

// RN draws these at stroke 2.2 (MobileOnboardingFlow.tsx, app-announcement-modal.tsx).
private val Database22 = lucide("Database", "M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0", "M3 5V19A9 3 0 0 0 21 19V5", "M3 12A9 3 0 0 0 21 12", stroke = 2.2f)
private val RefreshCw22 = lucide("RefreshCw", "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5", stroke = 2.2f)
private val X22 = lucide("X", "M18 6 6 18", "m6 6 12 12", stroke = 2.2f)
private val MessageSquare22 = lucide("MessageSquare",
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z", stroke = 2.2f)

/** The open startup prompt over the whole screen, as RN's root layout draws its modals. */
@Composable
fun StartupPromptOverlays(model: InboxViewModel) {
    val prompts = model.prompts
    val open = prompts.prompt ?: return
    if (open.optString("id") == "onboarding") WelcomeSheet(prompts, open)
    else PromptWindow(prompts, open)
}

/** A window over the whole screen with its own backdrop, as RN's transparent Modal (the platform dim off). */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun FullScreenDialog(onBack: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        // Its own window: the device checks find its tags only when this composition names them too, as MainActivity's does.
        Box(Modifier.semantics { testTagsAsResourceId = true }) { content() }
    }
}

/**
 * RN's AppAnnouncementModal (components/app-announcement-modal.tsx): the maintainer announcement, the update reminder or the
 * donation ask; a backdrop tap, the X or Back dismisses it.
 */
@Composable
private fun PromptWindow(prompts: StartupPromptsModel, open: JSONObject) {
    val theme = LocalTheme.current
    val c = theme.colors
    val context = LocalContext.current
    val announcement = open.getJSONObject("announcement")
    val action = announcement.optJSONObject("action")
    LaunchedEffect(open) { prompts.shown(open) }
    val dismiss = { prompts.close("dismiss") }
    FullScreenDialog(dismiss) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            // The backdrop is the card's sibling, so its tap target never merges the card's text (TalkBack names it by the title).
            Box(Modifier.matchParentSize().background(theme.announcementScrim).clickable(role = Role.Button, onClick = dismiss)
                .semantics { contentDescription = announcement.getString("title") })
            Box(Modifier.systemBarsPadding().padding(18.dp), contentAlignment = Alignment.Center) {
            val shape = RoundedCornerShape(12.dp)
            val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.82f).dp
            Column(Modifier.widthIn(max = 460.dp).fillMaxWidth().heightIn(max = maxHeight).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                .pointerInput(Unit) { detectTapGestures { } }.testTag("startup-prompt")) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.padding(top = 1.dp).size(36.dp).clip(RoundedCornerShape(10.dp)).background(c.tint.copy(alpha = 0x18 / 255f)), contentAlignment = Alignment.Center) {
                        Icon(Lucide.Megaphone, null, tint = c.tint, modifier = Modifier.size(18.dp))
                    }
                    Text(announcement.getString("title"), style = rnText(17, 700, 23), color = c.text, modifier = Modifier.weight(1f))
                    Box(Modifier.size(34.dp).clip(RoundedCornerShape(17.dp)).clickable(role = Role.Button, onClick = dismiss)
                        .semantics { contentDescription = open.getString("closeLabel") }, contentAlignment = Alignment.Center) {
                        Icon(X22, null, tint = c.secondaryText, modifier = Modifier.size(21.dp))
                    }
                }
                Box(Modifier.fillMaxWidth().background(c.border).heightIn(min = 1.dp, max = 1.dp))
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Text(announcement.getString("body"), style = rnText(14, 400, 21), color = c.secondaryText)
                }
                Box(Modifier.fillMaxWidth().background(c.border).heightIn(min = 1.dp, max = 1.dp))
                Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                    Box(Modifier.heightIn(min = 44.dp).widthIn(min = 92.dp).clip(RoundedCornerShape(12.dp)).rnBorder(1.dp, c.border, RoundedCornerShape(12.dp))
                        .clickable(role = Role.Button, onClick = dismiss).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                        Text(announcement.optString("dismissLabel").ifEmpty { open.getString("notNow") }, style = rnText(14, 700), color = c.secondaryText,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (action != null) {
                        Row(Modifier.heightIn(min = 44.dp).widthIn(min = 126.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg)
                            .clickable(role = Role.Button) { prompts.act(open) { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) } } }
                            .padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (action.optString("type") == "feedback") MessageSquare22 else Lucide.ExternalLink, null, tint = theme.filledText, modifier = Modifier.size(16.dp))
                            Text(action.getString("label"), style = rnText(14, 700), color = theme.filledText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            }
        }
    }
}

/**
 * RN's first-run welcome sheet (components/MobileOnboardingFlow.tsx): Start using Mindwtr first, then Set up sync and Import
 * tasks, the error box, the footer (stacked at font scale 1.5 and above, #632) and the pinned close. While seeding, Back and every
 * control do nothing.
 */
@Composable
private fun WelcomeSheet(prompts: StartupPromptsModel, open: JSONObject) {
    val theme = LocalTheme.current
    val c = theme.colors
    val words = open.getJSONObject("words")
    val busy = prompts.seeding
    val skip = { if (!prompts.seeding) prompts.close("dismiss") }
    val stackFooter = LocalDensity.current.fontScale >= 1.5f
    FullScreenDialog(skip) {
        Box(Modifier.fillMaxSize().background(theme.onboardingScrim).systemBarsPadding().padding(horizontal = 16.dp, vertical = 20.dp), contentAlignment = Alignment.Center) {
            val shape = RoundedCornerShape(16.dp)
            val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.92f).dp
            Box(Modifier.fillMaxWidth().heightIn(max = maxHeight).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).testTag("welcome-sheet")) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 18.dp).padding(end = 38.dp)) {
                        Text(words.getString("title"), style = rnText(24, 800), color = c.text)
                        Text(words.getString("subtitle"), style = rnText(15, 400, 21), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp))
                    }
                    Box(Modifier.fillMaxWidth().background(c.border).heightIn(min = 0.5.dp, max = 0.5.dp))
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        val onFilled = theme.filledText
                        WelcomeOption(
                            title = words.getString(if (busy) "startFreshBusy" else "startFreshTitle"), description = words.getString("startFreshDesc"),
                            background = theme.filledBg, border = theme.filledBg, titleColor = onFilled, descriptionColor = onFilled.copy(alpha = onFilled.alpha * 0.84f),
                            iconBackground = Color.White.copy(alpha = 0.16f), minHeight = 92, disabledAlpha = 0.68f, disabled = busy, tag = "welcome-start",
                            onClick = prompts::startFresh,
                        ) {
                            if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = onFilled, strokeWidth = 2.dp)
                            else Icon(Database22, null, tint = onFilled, modifier = Modifier.size(22.dp))
                        }
                        WelcomeOption(words.getString("syncTitle"), words.getString("syncDesc"), c.inputBg, c.border, c.text, c.secondaryText,
                            c.tint.copy(alpha = 0x18 / 255f), 88, 0.58f, busy, "welcome-sync", { prompts.handoff("sync") }) {
                            Icon(RefreshCw22, null, tint = c.tint, modifier = Modifier.size(22.dp))
                        }
                        WelcomeOption(words.getString("importTitle"), words.getString("importDescMobile"), c.inputBg, c.border, c.text, c.secondaryText,
                            c.tint.copy(alpha = 0x18 / 255f), 88, 0.58f, busy, "welcome-import", { prompts.handoff("data") }) {
                            Icon(Lucide.Download, null, tint = c.tint, modifier = Modifier.size(22.dp))
                        }
                        prompts.seedError?.let { error ->
                            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.danger.copy(alpha = 0x18 / 255f))
                                .rnBorder(1.dp, c.danger, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp)) {
                                Text(error, style = rnText(13, 600, 18), color = c.danger)
                            }
                        }
                    }
                    Box(Modifier.fillMaxWidth().background(c.border).heightIn(min = 0.5.dp, max = 0.5.dp))
                    val skipText: @Composable (Modifier) -> Unit = { modifier ->
                        Text(words.getString("skipForNow"), style = rnText(15, 800), color = if (busy) c.secondaryText else c.tint,
                            modifier = modifier.clickable(enabled = !busy, role = Role.Button, onClick = skip).semantics { if (busy) disabled() })
                    }
                    if (stackFooter) Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(words.getString("footer"), style = rnText(13, 400, 18), color = c.secondaryText)
                        skipText(Modifier.align(Alignment.End))
                    } else Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text(words.getString("footer"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.weight(1f))
                        skipText(Modifier)
                    }
                }
                Box(Modifier.align(Alignment.TopEnd).padding(top = 12.dp, end = 12.dp).size(38.dp).fade(if (busy) 0.45f else 1f).clip(RoundedCornerShape(19.dp))
                    .background(c.cardBg).clickable(enabled = !busy, role = Role.Button, onClick = skip)
                    .semantics { contentDescription = words.getString("skip"); if (busy) disabled() }, contentAlignment = Alignment.Center) {
                    Icon(X22, null, tint = c.secondaryText, modifier = Modifier.size(22.dp))
                }
            }
        }
    }
}

/** One of the welcome sheet's options (RN's OnboardingOption, and Start's filled row). */
@Composable
private fun WelcomeOption(
    title: String, description: String, background: Color, border: Color, titleColor: Color, descriptionColor: Color, iconBackground: Color,
    minHeight: Int, disabledAlpha: Float, disabled: Boolean, tag: String, onClick: () -> Unit, icon: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().heightIn(min = minHeight.dp).fade(if (disabled) disabledAlpha else 1f).clip(shape).background(background).rnBorder(1.dp, border, shape)
        .clickable(enabled = !disabled, role = Role.Button, onClick = onClick).semantics { if (disabled) disabled() }.testTag(tag)
        .padding(horizontal = 16.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(10.dp)).background(iconBackground), contentAlignment = Alignment.Center) { icon() }
        Column(Modifier.weight(1f).align(Alignment.CenterVertically)) {
            Text(title, style = rnText(17, 800), color = titleColor)
            Text(description, style = rnText(14, 400, 20), color = descriptionColor, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

