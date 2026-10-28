package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost

/**
 * RN's GmailCaptureSection (apps/mobile/components/settings/gmail-capture-section.tsx) under Settings › GTD › Capture: its state,
 * its calls (host-gmail.ts's requests through CoreHost.gmailRequest, off the main thread) and its generation rule, so an answer that
 * comes after a newer operation or after Back counts for nothing. Every word is one of RN's keys; a failure is the key host-gmail.ts
 * gives (RN's gmailCaptureErrorTranslation). Main thread, but the calls.
 */
class GmailCaptureModel(private val menu: MenuModel) {
    private val shell get() = menu.shell

    var open by mutableStateOf(false); private set
    var config by mutableStateOf<JSONObject?>(null); private set
    var labels by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var labelId by mutableStateOf(""); private set
    var pickerOpen by mutableStateOf(false); private set
    /** "connect", "cancel", "save", "check" or "disconnect" while one runs. */
    var operation by mutableStateOf<String?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var notice by mutableStateOf<String?>(null); private set
    /** Shown until capture starts again or the account disconnects (RN's receiptsReset). */
    var receiptsReset by mutableStateOf(false); private set
    /** host-gmail.ts's status view: RN's status, its "Last checked" text and its error's key. */
    var status by mutableStateOf<JSONObject?>(null); private set
    val busy get() = operation != null

    @Volatile private var generation = 0
    private var mounted = false

    private class Failed(val key: String) : Exception()

    /** One request on the calling (worker) thread: its value, or [Failed] with the section's key for the failure. */
    private fun call(runtime: CoreHost, name: String, input: JSONObject = JSONObject()): Any? {
        val reply = try { runtime.gmailRequest(name, input.toString()) } catch (_: Exception) { throw Failed("settings.gmailCaptureFailed") }
        reply.optString("errorKey").ifEmpty { null }?.let { throw Failed(it) }
        return reply.opt("value")
    }

    private fun labelsOf(value: Any?): List<JSONObject> = (value as? JSONArray)?.let { all -> List(all.length()) { all.getJSONObject(it) } }.orEmpty()

    /** RN's choice: the saved label, else one named "Mindwtr", else none. */
    private fun chosen(next: JSONObject, nextLabels: List<JSONObject>) = next.optString("labelId").takeUnless { next.isNull("labelId") }
        ?: nextLabels.firstOrNull { it.optString("name") == "Mindwtr" }?.optString("id") ?: ""

    /** RN's mount: the status, then the config, the reset notice and, once connected, the labels. Once per visit. */
    fun mount() {
        if (mounted) return
        mounted = true
        val runtime = shell.coreHost() ?: return
        val current = ++generation
        Thread({
            runCatching { call(runtime, "status") as? JSONObject }.getOrNull()?.let { read -> shell.ui { if (status == null) status = read } }
            try {
                val next = call(runtime, "config") as JSONObject
                if (current != generation) return@Thread
                // The status read opens the receipts file, so a reset it just made shows too.
                val reset = call(runtime, "receiptsReset") == true
                shell.ui { if (current == generation) { config = next; receiptsReset = reset } }
                if (next.getBoolean("connected")) {
                    val nextLabels = labelsOf(call(runtime, "labels"))
                    shell.ui { if (current == generation) { labels = nextLabels; labelId = chosen(next, nextLabels) } }
                }
            } catch (failure: Failed) {
                shell.ui { if (current == generation) error = failure.key }
            }
        }, "mindwtr-gmail-open").start()
    }

    /** Back (RN unmounts the section): its state goes, and an answer still on its way counts for nothing. */
    fun leave() {
        generation += 1
        mounted = false
        open = false; config = null; labels = emptyList(); labelId = ""; pickerOpen = false
        operation = null; error = null; notice = null; receiptsReset = false
    }

    /** RN's subscribeGmailCaptureStatus: the controller's status after each cycle (host-gmail.ts `gmailStatus` events). */
    fun statusChanged(next: JSONObject) { status = next }

    fun toggle() { open = !open }
    fun openPicker() { pickerOpen = true }
    fun closePicker() { pickerOpen = false }
    fun choose(id: String) { labelId = id; pickerOpen = false }

    /** RN's runOperation: a new generation, the operation shown, the old error and notice gone; [before] runs here at once. */
    private fun run(next: String, before: () -> Unit = {}, work: (CoreHost, Int) -> Unit) {
        val runtime = shell.coreHost() ?: return
        val current = ++generation
        operation = next
        error = null
        notice = null
        before()
        Thread({
            try {
                work(runtime, current)
            } catch (failure: Failed) {
                shell.ui { if (current == generation) error = failure.key }
            } finally {
                shell.ui { if (current == generation) operation = null }
            }
        }, "mindwtr-gmail-$next").start()
    }

    private fun retireAccount() {
        config = config?.let { JSONObject(it.toString()).put("connected", false).put("account", JSONObject.NULL)
            .put("accountId", JSONObject.NULL).put("labelId", JSONObject.NULL).put("enabled", false) }
        labels = emptyList()
        labelId = ""
        pickerOpen = false
    }

    fun connect() = run("connect", ::retireAccount) { runtime, current ->
        val next = call(runtime, "connect") as JSONObject
        if (current != generation) return@run
        shell.ui { if (current == generation) config = next }
        val nextLabels = labelsOf(call(runtime, "labels"))
        shell.ui { if (current == generation) { labels = nextLabels; labelId = chosen(next, nextLabels) } }
    }

    fun cancel() = run("cancel") { runtime, current ->
        call(runtime, "cancel")
        shell.ui { if (current == generation) notice = "settings.gmailCaptureCancelled" }
    }

    fun save() {
        val label = labelId
        run("save", { config = config?.let { JSONObject(it.toString()).put("enabled", false) } }) { runtime, current ->
            val next = call(runtime, "configure", JSONObject().put("labelId", label).put("enabled", true)) as JSONObject
            call(runtime, "clearReceiptsReset")
            shell.ui {
                receiptsReset = false
                if (current == generation) { config = next; labelId = next.optString("labelId").takeUnless { next.isNull("labelId") } ?: "" }
            }
        }
    }

    fun disconnect() = run("disconnect", ::retireAccount) { runtime, current ->
        val result = call(runtime, "disconnect") as JSONObject
        call(runtime, "clearReceiptsReset")
        shell.ui {
            receiptsReset = false
            if (current == generation) notice = if (result.optBoolean("revoked")) "settings.gmailCaptureDisconnected" else "settings.gmailCaptureRevokeManually"
        }
    }

    fun check() = run("check") { runtime, _ -> call(runtime, "checkNow") }

    /** RN's displayedError: the operation's, else the reset notice, else the last cycle's. */
    val shownError: String? get() = error ?: (if (receiptsReset) "settings.gmailCaptureReceiptsReset" else null)
        ?: status?.takeUnless { it.isNull("lastErrorKey") }?.optString("lastErrorKey")
}

/** RN's GmailCaptureSection: a disclosure card under the Capture cards, its body while open, in RN's order. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun GmailCaptureSection(model: InboxViewModel) {
    val gmail = model.menu.settings.gmail
    val c = LocalTheme.current.colors
    LaunchedEffect(Unit) { gmail.mount() }
    val config = gmail.config
    val connected = config?.optBoolean("connected") == true
    val busy = gmail.busy
    Box(Modifier.padding(top = 12.dp).testTag("gmail-capture-section")) {
        Card {
            val title = t("settings.gmailCapture")
            val description = t("settings.gmailCaptureDesc")
            SettingRow(title, description, modifier = Modifier.testTag("gmail-expand").clearAndSetSemantics {
                contentDescription = "$title, $description"; role = Role.Button
                onClick { gmail.toggle(); true }
                if (gmail.open) collapse { gmail.toggle(); true } else expand { gmail.toggle(); true }
            }.clickable { gmail.toggle() }) {
                Text(if (gmail.open) "▾" else "▸", style = rnText(14, 400), color = c.secondaryText)
            }
            if (gmail.open) Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(t("settings.gmailCaptureDisclosure"), style = rnText(13, 400, 19), color = c.secondaryText)
                if (config != null && !config.optBoolean("available")) {
                    Text(t("settings.gmailCaptureUnavailable"), style = rnText(14, 400), color = c.secondaryText)
                } else {
                    if (connected) {
                        SelectionContainer {
                            Text("${t("settings.gmailCaptureAccount")}: ${config!!.optString("account")}", style = rnText(14, 400), color = c.text)
                        }
                        val labelName = gmail.labels.firstOrNull { it.optString("id") == gmail.labelId }?.optString("name") ?: t("settings.gmailCaptureChooseLabel")
                        val labelTitle = t("settings.gmailCaptureLabel")
                        // RN's SettingRow inside the body keeps its own 16 dp padding.
                        SettingRow(labelTitle, labelName, modifier = Modifier.testTag("gmail-label-picker").clearAndSetSemantics {
                            contentDescription = "$labelTitle, $labelName"; role = Role.Button
                            if (!busy) onClick { gmail.openPicker(); true } else disabled()
                        }.clickable(enabled = !busy) { gmail.openPicker() })
                        Text(t("settings.gmailCaptureLabelHint"), style = rnText(13, 400, 19), color = c.secondaryText)
                        Text(t(if (config.optBoolean("enabled")) "settings.gmailCaptureActive" else "settings.gmailCapturePaused"), style = rnText(14, 400),
                            color = c.secondaryText, modifier = Modifier.testTag("gmail-enabled-status"))
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val operation = gmail.operation
                        GmailButton("connect", t(when { operation == "connect" -> "settings.gmailCaptureConnecting"; connected -> "settings.gmailCaptureReconnect"
                            else -> "settings.gmailCaptureConnect" }), !busy && config?.optBoolean("available") == true, gmail::connect)
                        if (operation == "connect") GmailButton("cancel", t("settings.gmailCaptureCancel"), true, gmail::cancel)
                        if (connected) {
                            GmailButton("disconnect", t("settings.gmailCaptureDisconnect"), operation != "disconnect" && operation != "cancel", gmail::disconnect)
                            GmailButton("check", t(if (operation == "check") "settings.gmailCaptureChecking" else "settings.gmailCaptureCheckNow"),
                                !busy && config!!.optBoolean("enabled") && gmail.status?.optBoolean("terminal") != true, gmail::check)
                            GmailButton("save", t(if (operation == "save") "settings.gmailCaptureSaving" else "settings.gmailCaptureSave"), !busy && gmail.labelId.isNotEmpty(), gmail::save)
                        }
                    }
                }
                val status = gmail.status
                if (connected && status != null && !status.isNull("lastPollText")) {
                    val count = status.optInt("lastImportCount")
                    val imported = if (count > 0 && status.isNull("lastError")) " · ${t("settings.gmailCaptureImportedCount").replace("{{count}}", count.toString())}" else ""
                    Text("${t("settings.gmailCaptureLastChecked")}: ${status.optString("lastPollText")}$imported", style = rnText(13, 400, 19), color = c.secondaryText)
                }
                gmail.shownError?.let { key ->
                    Text(t(key), style = rnText(14, 400), color = c.warning, modifier = Modifier.testTag("gmail-error").semantics { liveRegion = LiveRegionMode.Assertive })
                }
                gmail.notice?.let { key ->
                    Text(t(key), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.testTag("gmail-notice").semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
        }
    }
}

/** RN's section button: a 1 dp tint outline, radius 8, its label in the tint at 600; half faded while disabled. */
@Composable
private fun GmailButton(id: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.testTag("gmail-$id").fade(if (enabled) 1f else 0.5f).heightIn(min = 44.dp).clip(shape).rnBorder(1.dp, c.tint, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
        Text(label, style = rnText(14, 600), color = c.tint)
    }
}

/** RN's label picker (its Modal on settings' pickerOverlay and pickerCard): the labels as radio rows; a choice closes it. */
@Composable
internal fun GmailLabelPicker(model: InboxViewModel) {
    val gmail = model.menu.settings.gmail
    if (!gmail.pickerOpen) return
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { gmail.closePicker() }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(Unit) { detectTapGestures { gmail.closePicker() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
            .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("gmail-label-sheet")) {
            Text(t("settings.gmailCaptureLabel"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (label in gmail.labels) {
                    val id = label.optString("id")
                    val name = label.optString("name")
                    val on = gmail.labelId == id
                    val row = RoundedCornerShape(10.dp)
                    Box(Modifier.fillMaxWidth().testTag("gmail-label-$id").clip(row).rnBorder(1.dp, c.border, row)
                        .clearAndSetSemantics { contentDescription = name; role = Role.RadioButton; selected = on; onClick { gmail.choose(id); true } }
                        .clickable { gmail.choose(id) }.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        Text(name, style = rnText(14, 400), color = c.text)
                    }
                }
            }
        }
    }
}
