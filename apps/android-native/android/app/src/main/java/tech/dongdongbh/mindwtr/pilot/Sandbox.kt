package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost


private val SANDBOX_BG = Color(0xFFFEF3C7)
private val SANDBOX_BORDER = Color(0xFFD97706)
private val SANDBOX_TEXT = Color(0xFF713F12)
private val SANDBOX_ERROR = Color(0xFF991B1B)

internal val Beaker = lucide("Beaker", "M4.5 3h15", "M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3", "M6 14h12")


class SandboxSwitch(private val shell: InboxViewModel) {
    var switching by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var confirming by mutableStateOf(false); private set

    private val app get() = shell.getApplication<Application>()


    val blocked get() = switching || !shell.menu.idle || shell.menu.settings.transfer.busy || shell.menu.settings.sync.running > 0


    fun askEnter() { if (!blocked) confirming = true }


    fun cancel() { confirming = false }


    fun enter() {
        confirming = false
        open("entered")
    }


    fun reset() = open("reset")


    private fun open(outcome: String) {
        if (switching) return
        switching = true
        failed = false
        val prefs = Workspace.viewPrefs(app)
        val display = JSONObject().apply {
            prefs.getString(LANGUAGE_KEY, null)?.let { put("language", it) }
            prefs.getString(THEME_KEY, null)?.let { put("theme", it) }
        }
        if (!shell.tryPerform { runtime ->
            val request = runCatching { runtime.sandboxRequest(display) }.getOrElse { failure ->
                Log.w(CoreHost.TAG, "Native Android sandbox switch refused ${failure.message?.substringBefore(':')}")
                runtime.sandboxRelease()
                return@tryPerform shell.ui { refused() }
            }
            if (!Workspace.store(app).write(request)) {
                runtime.sandboxRelease()
                return@tryPerform shell.ui { refused() }
            }
            runtime.logLine("Native Android sandbox switch requested", JSONObject().put("releaseCheck", "v1.3.9/native-sandbox").put("outcome", outcome))
            Workspace.restart(app)
        }) refused()
    }


    fun exit() {
        if (switching) return
        switching = true
        failed = false
        val runtime = shell.host
        Thread({
            if (!Workspace.store(app).write(null)) return@Thread shell.ui { refused() }
            val closed = JSONObject().put("releaseCheck", "v1.3.9/native-sandbox").put("outcome", "exited")
            if (runtime != null) runtime.logLine("Native Android sandbox closed", closed)
            else Log.i(CoreHost.TAG, "Native Android sandbox closed $closed")
            Workspace.restart(app)
        }, "sandbox-exit").start()
    }


    private fun refused() {
        switching = false
        failed = true
    }
}


@Composable
fun Modifier.sandboxTop(): Modifier = background(SANDBOX_BG).windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Top))


@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SandboxBanner(model: InboxViewModel) {
    if (!Workspace.sandbox) return
    val sandbox = model.sandbox
    Column(Modifier.fillMaxWidth().background(SANDBOX_BG).rnBorderBottom(SANDBOX_BORDER).padding(start = 8.dp, end = 8.dp, bottom = 2.dp).semantics { testTagsAsResourceId = true }.testTag("sandbox-workspace-banner")) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(t("sandbox.label"), style = rnText(13, 700, 18), color = SANDBOX_TEXT, maxLines = 2, modifier = Modifier.weight(1f))
            if (sandbox.switching) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp), color = SANDBOX_TEXT, strokeWidth = 2.dp)
                Text(t("sandbox.switching"), style = rnText(12, 600, 16), color = SANDBOX_TEXT, maxLines = 2)
            } else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                BannerButton(t("sandbox.resetShort"), t("sandbox.reset"), "sandbox-reset-button", Lucide.RotateCcw, sandbox::reset)
                BannerButton(t("sandbox.exitShort"), t("sandbox.exit"), "sandbox-exit-button", null, sandbox::exit)
            }
        }
        if (sandbox.failed) Text(t("sandbox.switchFailed"), style = rnText(11, 400, 14), color = SANDBOX_ERROR, maxLines = 2, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}


@Composable
private fun BannerButton(text: String, label: String, tag: String, icon: androidx.compose.ui.graphics.vector.ImageVector?, onClick: () -> Unit) {
    Row(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).clip(RoundedCornerShape(8.dp))
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; onClick { onClick(); true } }
        .clickable(onClick = onClick).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        icon?.let { Icon(it, null, tint = SANDBOX_TEXT, modifier = Modifier.size(16.dp)) }
        Text(text, style = rnText(12, 700, 16), color = SANDBOX_TEXT, maxLines = 2)
    }
}


@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SandboxSwitchingOverlay(model: InboxViewModel) {
    if (!model.sandbox.switching) return
    Box(Modifier.fillMaxSize().background(Color(0x6B0F172A)).clickable(enabled = false) {}.semantics { testTagsAsResourceId = true }.testTag("sandbox-switching"), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(min = 210.dp).clip(RoundedCornerShape(14.dp)).background(SANDBOX_BG).padding(horizontal = 20.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(20.dp), color = SANDBOX_TEXT, strokeWidth = 2.dp)
            if (Workspace.sandbox) Text(t("sandbox.title"), style = rnText(12, 700, 16), color = SANDBOX_TEXT, textAlign = TextAlign.Center)
            Text(t("sandbox.switching"), style = rnText(12, 600, 16), color = SANDBOX_TEXT, textAlign = TextAlign.Center)
        }
    }
}


@Composable
fun SandboxEntryConfirmation(model: InboxViewModel) {
    val sandbox = model.sandbox
    if (!sandbox.confirming) return
    ThemedAlert(t("sandbox.confirmTitle"), t("sandbox.confirmDescription"), listOf(
        AlertButton(t("common.cancel"), "cancel", sandbox::cancel),
        AlertButton(t("sandbox.enter"), "default", sandbox::enter),
    ), sandbox::cancel)
}


@Composable
internal fun SandboxOpenCard(model: InboxViewModel) {
    if (Workspace.sandbox) return
    val c = LocalTheme.current.colors
    val sandbox = model.sandbox
    val enabled = !sandbox.blocked
    val title = t(if (sandbox.switching) "sandbox.switching" else "sandbox.open")
    val description = t(if (sandbox.failed) "sandbox.switchFailed" else "sandbox.description")
    Card(top = 16) {
        Row(Modifier.fillMaxWidth().heightIn(min = 72.dp)
            .clearAndSetSemantics { contentDescription = "$title. $description"; role = Role.Button; testTag = "sandbox-open"; if (enabled) onClick { sandbox.askEnter(); true } else disabled() }
            .clickable(enabled = enabled, onClick = sandbox::askEnter).fade(if (enabled) 1f else 0.5f)
            .padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Icon(Beaker, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
            Column(Modifier.weight(1f).padding(start = 13.dp)) {
                Text(title, style = rnText(17, 500, 22), color = c.text, maxLines = 2)
                Text(description, style = rnText(13, 400, 18), color = if (sandbox.failed) c.danger else c.secondaryText, maxLines = 3, modifier = Modifier.padding(top = 3.dp))
            }
            Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.padding(start = 8.dp).size(20.dp))
        }
    }
}
