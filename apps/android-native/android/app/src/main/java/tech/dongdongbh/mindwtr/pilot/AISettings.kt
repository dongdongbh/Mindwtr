package tech.dongdongbh.mindwtr.pilot

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.UUID
import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/*
 * RN's Settings › AI (ai-settings-screen.tsx, its assistant and speech cards and the provider panels) on core's contract
 * (native-host-contract-ai.ts). Kotlin keeps only what RN keeps in React state for one visit, in memory (never in saved state:
 * a base URL may hold a password): which cards and folds are open, the open picker, text fields as typed, a key field while it
 * has focus, and the consent question. Every word, option, value and write is core's.
 */

/**
 * Settings › AI's screen writes AISettings.kt sends itself (host-entry.ts MENU_COMMANDS, never through the Menu tab's send()): the
 * screen's open (journaled), and a key and a base URL (WriteJournal.UNJOURNALED: a key, or a URL that may hold a password). No
 * failure of theirs is kept for a retry.
 */
val AI_COMMANDS = setOf("openAISettings", "setAIKey", "setAIEndpoint")

/** RN's picker Check (lucide at stroke 2.5). */
private val PickerCheck = lucide("PickerCheck", "M20 6 9 17l-5-5", stroke = 2.5f)

/**
 * The typed text a synced field sends once typing pauses (RN writes each keystroke; one write per pause keeps the journal small).
 * A key and a base URL have no pause (review C1 4): each change is one unjournaled write, in order, so a kill never loses one.
 */
private const val TYPING_PAUSE_MS = 500L

class AISettingsModel(private val menu: MenuModel) {
    private companion object {
        /** A visit's open and close, and every key and base URL write, in the order sent: a later keystroke never lands first. */
        val ordered: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-ai-settings") }
    }
    private val shell get() = menu.shell
    private val settings get() = menu.settings
    private val main = Handler(Looper.getMainLooper())

    /** openAISettings ran for this visit: RN reads the keys and stores its corrections once, when the screen mounts. */
    @Volatile private var opened = false
    var assistantOpen by mutableStateOf(false); private set
    var speechOpen by mutableStateOf(false); private set
    var advancedOpen by mutableStateOf(false); private set
    var extraOpen by mutableStateOf(false); private set
    /** The open picker: "model", "copilotModel", "speechModel" or "timeout". */
    var picker by mutableStateOf<String?>(null); private set
    /** Text fields as typed, by core's change type ("baseUrl" and "speechBaseUrl" for the base URLs), until core's view shows the text. */
    var typed by mutableStateOf(emptyMap<String, String>()); private set
    /** A key field ("assistant" or "speech") while it shows typed text: the key typed after core's dots ([keyTexts]). Gone once saved. */
    var keys by mutableStateOf(emptyMap<String, String>()); private set
    private val keyTexts = KeyTexts()
    /** The extra request parameters as typed, and the stored text it last took (RN resets it whenever the stored ones change). */
    var extraDraft by mutableStateOf<String?>(null); private set
    private var extraFollowed: String? = null
    /** Core's consent question, and the change that waits for its agree. */
    var consent by mutableStateOf<Pair<JSONObject, JSONObject>?>(null); private set
    /** The model lists asked for, by list, so each request goes once (core's `modelLists`). */
    private val asked = HashMap<String, String>()
    /** Each synced field's pending typed text: its send runs once typing pauses, or at once on blur or leave. */
    private val pending = LinkedHashMap<String, Runnable>()
    /** A key field whose last write failed: it keeps the typed key on blur (it never shows saved). Main thread. */
    private val unsaved = HashSet<String>()
    /** The model lists loading: leaving the screen or a newer request cancels one (its provider call stops). */
    private val modelCalls = AIRequestSlots<CoreHost.LongCall> { call -> shell.coreHost()?.cancel(call) }

    /** Settings' read of this screen: it opens once per visit (journaled), then core's view for the visit. */
    fun read(runtime: CoreHost): JSONObject {
        open(runtime)
        return try {
            runtime.menuRead("aiSettings", "{}")
        } catch (failure: Exception) {
            // Core has no open visit (a close that raced this one): open it again, once.
            if (failure.message?.contains("Open Settings › AI first") != true) throw failure
            opened = false
            open(runtime)
            runtime.menuRead("aiSettings", "{}")
        }
    }

    private fun open(runtime: CoreHost) = ordered.submit {
        if (!opened) {
            runtime.menuCommand("openAISettings", JSONObject().put("requestId", uuid()).toString())
            opened = true
        }
    }.get()

    /** Core's new view: typed text that it now shows follows it again; the extra parameters take new stored ones; model lists load. Main thread. */
    fun follow(view: JSONObject) {
        val shown = shownTexts(view)
        typed = typed.filter { (field, text) -> shown[field] != text }
        val extra = view.getJSONObject("assistant").getJSONObject("panel").optJSONObject("extraBody")?.getString("value")
        if (extra != extraFollowed) { extraFollowed = extra; extraDraft = null }
        val lists = view.getJSONObject("modelLists")
        for (list in listOf("assistant", "speech")) {
            val request = lists.getJSONObject(list).menuText("request") ?: continue
            if (asked[list] == request) continue
            asked[list] = request
            main.postDelayed({ loadModels(list, request) }, lists.getLong("delayMs"))
        }
    }

    /** The text each typed field shows in core's view. */
    private fun shownTexts(view: JSONObject): Map<String, String> {
        val assistant = view.getJSONObject("assistant")
        val speech = view.getJSONObject("speech")
        return listOfNotNull(
            "model" to assistant.getJSONObject("model").getString("value"),
            "copilotModel" to assistant.getJSONObject("copilotModel").getString("value"),
            assistant.getJSONObject("panel").optJSONObject("baseUrl")?.let { "baseUrl" to it.getString("value") },
            "speechModel" to speech.getJSONObject("model").getString("value"),
            speech.optJSONObject("baseUrl")?.let { "speechBaseUrl" to it.getString("value") },
            "speechLanguage" to speech.getJSONObject("language").getString("value"),
        ).toMap()
    }

    /** A model list core asked for, `delayMs` after it last changed: the provider's own list, then core's view again. */
    private fun loadModels(list: String, request: String) {
        if (asked[list] != request || !opened) return
        val runtime = shell.coreHost() ?: return
        val handle = CoreHost.LongCall()
        modelCalls.start(list, handle)
        Thread({
            runCatching { runtime.aiRequest("loadAIModels", JSONObject().put("list", list).put("request", request).toString(), handle) }
                .onFailure { if (it !is CancellationException) Log.w(CoreHost.TAG, "AI model list failed code=${it.message?.substringBefore(':')}") }
            // Read again once no action runs (a background read skips while one does), so the new list shows.
            modelCalls.reply(list, handle, shell::ui) { menu.whenIdle { settings.refresh() } }
        }, "mindwtr-ai-models").start()
    }

    fun toggleAssistant() { assistantOpen = !assistantOpen }
    fun toggleSpeech() { speechOpen = !speechOpen }
    fun toggleAdvanced() { advancedOpen = !advancedOpen }
    fun toggleExtra() { extraOpen = !extraOpen }
    fun openPicker(name: String?) { picker = name }

    /** Leaving the screen (RN unmounts it): typed text still waiting is sent, and core forgets the visit's keys and lists. */
    fun leave() {
        if (!opened && typed.isEmpty() && pending.isEmpty()) return
        flushAll()
        modelCalls.cancel("assistant", "speech")
        opened = false
        assistantOpen = false; speechOpen = false; advancedOpen = false; extraOpen = false
        picker = null; typed = emptyMap(); keyTexts.clear(); keys = emptyMap(); extraDraft = null; extraFollowed = null; consent = null
        asked.clear(); unsaved.clear()
        val runtime = shell.coreHost() ?: return
        ordered.execute { runCatching { runtime.menuRead("aiSettingsClose", "{}") }.onFailure { Log.w(CoreHost.TAG, "AI screen close failed ${failureForLog(it)}") } }
    }

    // ---- Writes ----

    /** A control's change (core's setAISetting): a synced setting, so it goes through the Menu tab's journaled command path. */
    fun set(change: JSONObject, agreed: Boolean = false) =
        menu.command("setAISetting", JSONObject().put("change", change).apply { if (agreed) put("consent", true) })

    /** A text field as typed (a model, the audio language): sent once typing pauses; the field shows it until core's view does. */
    fun type(field: String, text: String, change: () -> JSONObject) {
        typed = typed + (field to text)
        schedule(field) { menu.whenIdle { set(change()) } }
    }

    /** A base URL as typed ([field] "baseUrl" or "speechBaseUrl"): setAIEndpoint at once, in order. Never journaled. */
    fun typeUrl(field: String, text: String) {
        typed = typed + (field to text)
        val target = if (field == "baseUrl") "assistant" else "speech"
        screenWrite("setAIEndpoint", JSONObject().put("field", target).put("value", text))
    }

    /**
     * A key field's text. RN's secure field starts with the stored key; here it starts with core's dots, and [typedKey] keeps
     * them out of the key. setAIKey goes at once, in order, naming the provider shown.
     */
    fun typeKey(field: String, provider: String, mask: String, text: String) {
        val next = typedKey(keys[field], mask, text)
        keyTexts.typed(field, next)
        keys = keyTexts.shown
        screenWrite("setAIKey", JSONObject().put("field", field).put("provider", provider).put("value", next), keyField = field)
    }

    /**
     * A key field lost focus: once its writes before are stored, the key leaves the screen's state and the field shows core's dots
     * (saved). A failed write keeps the typed key in the field, and an edit typed after a refocus stays (review C1 verification 4).
     */
    fun blurKey(field: String) {
        val upTo = keyTexts.edit(field)
        ordered.execute { shell.ui { if (field !in unsaved) { keyTexts.saved(field, upTo); keys = keyTexts.shown } } }
    }

    /** The extra request parameters as typed, and their Save (core parses the text and answers the field's text). */
    fun typeExtra(text: String) { extraDraft = text }
    fun saveExtra(stored: String) = set(JSONObject().put("type", "extraBodyParams").put("text", extraDraft ?: stored))

    /** The consent question's agree: the same change again, with a new request UUID and the agreement, which core records first. */
    fun agree() {
        val (change, _) = consent ?: return
        consent = null
        set(change, agreed = true)
    }
    fun decline() { consent = null }

    private fun schedule(key: String, send: () -> Unit) {
        pending.remove(key)?.let(main::removeCallbacks)
        val task = Runnable { pending.remove(key); send() }
        pending[key] = task
        main.postDelayed(task, TYPING_PAUSE_MS)
    }

    private fun flush(key: String) { pending.remove(key)?.let { main.removeCallbacks(it); it.run() } }
    private fun flushAll() { pending.keys.toList().forEach(::flush) }

    /**
     * A key or base URL write, in order, off the main thread; core's view is read again after it. Its failure is shown, never
     * kept for a retry; a key's ([keyField]) marks the field unsaved until a later write of it lands.
     */
    private fun screenWrite(name: String, input: JSONObject, keyField: String? = null) {
        val runtime = shell.coreHost() ?: return
        ordered.execute {
            val result = runCatching { runtime.menuCommand(name, input.put("requestId", uuid()).toString()) }
            shell.ui {
                keyField?.let { if (result.isSuccess) unsaved -= it else unsaved += it }
                result.exceptionOrNull()?.let { error ->
                    // Core's message names no key: its failures are redacted (redactAIError).
                    Log.w(CoreHost.TAG, "AI screen command failed command=$name code=${error.message?.substringBefore(':')}")
                    shell.showToast(null, error.message.orEmpty().substringAfter(": "), "error")
                }
                menu.whenIdle { settings.refresh() }
            }
        }
    }

    // ---- Answers (MenuModel's send, for setAISetting) ----

    /** Core's answer: its consent question, its toasts (the newest shows, as RN's toast does), a Save's stored extra parameters. */
    fun done(action: FailedAction, reply: JSONObject) {
        reply.optJSONObject("consent")?.let { prompt -> consent = JSONObject(action.title).getJSONObject("change") to prompt }
        reply.menuText("extraBodyDraft")?.let { extraDraft = it }
        reply.menuObjects("toasts").lastOrNull()?.let { shell.showToast(it) }
    }

    private fun uuid() = UUID.randomUUID().toString()
}

// ---- The screen ----

/** RN's AI screen from core's view: the assistant card and the speech card. */
@Composable
internal fun AISettings(model: InboxViewModel, view: JSONObject) {
    AssistantCard(model, view.getJSONObject("assistant"))
    SpeechCard(model, view.getJSONObject("speech"))
}

/** Over the AI screen (SettingsDialogs, outside its scroll): the model and timeout pickers, and RN's consent question. */
@Composable
internal fun AISettingsDialogs(model: InboxViewModel, view: JSONObject) {
    val ai = model.menu.settings.ai
    ai.picker?.let { AIPicker(model, view, it) }
    ai.consent?.let { (_, prompt) ->
        AlertDialog(
            onDismissRequest = { ai.decline() },
            title = { Text(prompt.getString("title")) },
            text = { Text(prompt.getString("message")) },
            confirmButton = { TextButton(onClick = { ai.agree() }, modifier = Modifier.testTag("ai-consent-agree")) { Text(prompt.getString("agree")) } },
            dismissButton = { TextButton(onClick = { ai.decline() }, modifier = Modifier.testTag("ai-consent-cancel")) { Text(prompt.getString("cancel")) } },
        )
    }
}

/** RN's settingRow with its label and description (settingInfo), a hairline above unless first, and a trailing control. */
@Composable
private fun AIRow(label: String, description: String?, divider: Boolean = true, note: String? = null, modifier: Modifier = Modifier,
                  trailing: @Composable () -> Unit = {}) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).then(modifier).padding(16.dp),
        verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = c.text)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
            note?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp)) }
        }
        trailing()
    }
}

/** RN's folding row (the cards' headings, Advanced, Extra request parameters): the label, the description, and ▸ or ▾. */
@Composable
private fun FoldRow(label: String, description: String?, open: Boolean, divider: Boolean, tag: String, toggle: () -> Unit) {
    val spoken = if (description == null) label else "$label, $description"
    AIRow(label, description, divider, modifier = Modifier.clearAndSetSemantics {
        contentDescription = spoken; role = Role.Button; testTag = tag
        onClick { toggle(); true }; if (open) collapse { toggle(); true } else expand { toggle(); true }
    }.clickable(onClick = toggle)) {
        Text(if (open) "▾" else "▸", style = rnText(24, 300), color = LocalTheme.current.colors.secondaryText)
    }
}

/** RN's switch row: the label, the description, and RN's settings switch. */
@Composable
private fun SwitchRow(model: InboxViewModel, row: JSONObject, tag: String, toggle: (Boolean) -> Unit) {
    val label = row.getString("label")
    val on = row.getBoolean("value")
    AIRow(label, row.menuText("description")) {
        Box(Modifier.testTag(tag)) { RnSwitch(on, model.menu.idle, label, LocalTheme.current.settingsSwitch) { toggle(!on) } }
    }
}

/** RN's backendToggle: core's options as chips, the chosen one washed and in the tint; a tap sends its change. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Chips(model: InboxViewModel, options: List<JSONObject>, tag: String, enabled: Boolean = true, choose: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in options) {
            val selected = option.getBoolean("selected")
            val label = option.getString("label")
            val on = enabled && model.menu.idle
            val shape = RoundedCornerShape(16.dp)
            Box(Modifier.clip(shape).background(if (selected) c.filterBg else Color.Transparent).rnBorder(1.dp, c.border, shape)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected; testTag = "$tag-${option.get("value")}"
                    if (on) onClick { choose(option); true } else disabled() }
                .clickable(enabled = on) { choose(option) }.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text(label, style = rnText(13, 700, 17), color = if (selected) c.tint else c.secondaryText, maxLines = 2, textAlign = TextAlign.Center)
            }
        }
    }
}

/** RN's textInput and modelTextInput: a bordered field over the card; a secure one shows dots, a code one is monospace. */
@Composable
private fun AIInput(value: String, label: String, placeholder: String?, tag: String, modifier: Modifier, radius: Int = 8, secure: Boolean = false,
                    code: Boolean = false, keyboard: KeyboardType = KeyboardType.Text, focus: (Boolean) -> Unit = {}, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(radius.dp)
    val style = rnText(14, 400).copy(color = c.text, fontFamily = if (code) FontFamily.Monospace else null)
    BasicTextField(value, change, singleLine = !code, minLines = if (code) 5 else 1, cursorBrush = SolidColor(c.tint), textStyle = style,
        visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = keyboard),
        modifier = modifier.clip(shape).rnBorder(1.dp, c.border, shape).onFocusChanged { focus(it.isFocused) }.semantics { contentDescription = label }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = style.copy(color = c.secondaryText))
                inner()
            }
        })
}

/** RN's modelInputRow: the typed model and its Suggestions button, which opens the picker. */
@Composable
private fun ModelInput(model: InboxViewModel, field: String, row: JSONObject, tag: String, picker: String) {
    val ai = model.menu.settings.ai
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AIInput(ai.typed[field] ?: row.getString("value"), row.getString("label"), row.menuText("placeholder"), tag, Modifier.weight(1f), radius = 10) { text ->
            ai.type(field, text) { JSONObject().put("type", field).put("value", text) }
        }
        val suggestions = row.getString("suggestions")
        val shape = RoundedCornerShape(10.dp)
        Box(Modifier.clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .clearAndSetSemantics { contentDescription = suggestions; role = Role.Button; testTag = "$tag-suggestions"; onClick { ai.openPicker(picker); true } }
            .clickable { ai.openPicker(picker) }.padding(horizontal = 8.dp, vertical = 10.dp)) {
            Text(suggestions, style = rnText(12, 600, 16), color = c.secondaryText, maxLines = 2, textAlign = TextAlign.Center)
        }
    }
}

/** RN's dropdownButton: the value and ▾; it opens the picker. */
@Composable
private fun Dropdown(label: String, value: String, tag: String, open: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
        Row(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .clearAndSetSemantics { contentDescription = "$label: $value"; role = Role.Button; testTag = tag; onClick { open(); true } }
            .clickable(onClick = open).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(value, style = rnText(13, 600), color = c.text, maxLines = 2, modifier = Modifier.weight(1f))
            Text("▾", style = rnText(14, 600), color = c.secondaryText)
        }
    }
}

/** A key field (RN's secure textInput): core's dots until it is edited; the edit is the new key (AISettingsModel.typeKey). */
@Composable
private fun KeyField(model: InboxViewModel, field: String, provider: String, key: JSONObject, bottom: Int) {
    val ai = model.menu.settings.ai
    val mask = key.getString("mask")
    AIRow(key.getString("label"), key.getString("description"), note = key.menuText("note"))
    Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = bottom.dp)) {
        AIInput(ai.keys[field] ?: mask, key.getString("label"), key.getString("placeholder"), "ai-$field-key", Modifier.fillMaxWidth(), secure = true,
            keyboard = KeyboardType.Password, focus = { focused -> if (!focused) ai.blurKey(field) }) { text -> ai.typeKey(field, provider, mask, text) }
    }
}

/** A base URL field (the assistant's, or the speech card's): as typed until core's view shows it; setAIEndpoint once typing pauses. */
@Composable
private fun UrlField(model: InboxViewModel, field: String, row: JSONObject, tag: String) {
    val ai = model.menu.settings.ai
    AIRow(row.getString("label"), row.menuText("description"))
    Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
        AIInput(ai.typed[field] ?: row.getString("value"), row.getString("label"), row.menuText("placeholder"), tag, Modifier.fillMaxWidth(),
            keyboard = KeyboardType.Uri) { text -> ai.typeUrl(field, text) }
    }
}

private fun selectedValue(options: List<JSONObject>): String = options.first { it.getBoolean("selected") }.get("value").toString()

/** RN's AiSettingsAssistantCard: folded; the switch, provider, models, the provider's panel, and Advanced's request timeout. */
@Composable
private fun AssistantCard(model: InboxViewModel, card: JSONObject) {
    val ai = model.menu.settings.ai
    val c = LocalTheme.current.colors
    Card {
        FoldRow(card.getString("title"), card.getString("description"), ai.assistantOpen, false, "ai-assistant-card") { ai.toggleAssistant() }
        if (!ai.assistantOpen) return@Card
        SwitchRow(model, card.getJSONObject("enabled"), "ai-enabled") { on -> ai.set(JSONObject().put("type", "enabled").put("value", on)) }
        val provider = card.getJSONObject("provider")
        val providers = provider.menuObjects("options")
        AIRow(provider.getString("label"), provider.getString("description"))
        Chips(model, providers, "ai-provider") { ai.set(JSONObject().put("type", "provider").put("value", it.getString("value"))) }
        val chosen = selectedValue(providers)
        val modelRow = card.getJSONObject("model")
        AIRow(modelRow.getString("label"), null)
        ModelInput(model, "model", modelRow, "ai-model", "model")
        val copilot = card.getJSONObject("copilotModel")
        AIRow(copilot.getString("label"), copilot.getString("description"))
        ModelInput(model, "copilotModel", copilot, "ai-copilot-model", "copilotModel")
        val panel = card.getJSONObject("panel")
        when (panel.getString("kind")) {
            "openai" -> {
                val reasoning = panel.getJSONObject("reasoning")
                AIRow(reasoning.getString("label"), reasoning.getString("description"))
                Chips(model, reasoning.menuObjects("options"), "ai-reasoning") { ai.set(JSONObject().put("type", "reasoningEffort").put("value", it.getString("value"))) }
                UrlField(model, "baseUrl", panel.getJSONObject("baseUrl"), "ai-base-url")
                val extra = panel.getJSONObject("extraBody")
                FoldRow(extra.getString("label"), extra.getString("description"), ai.extraOpen, true, "ai-extra-body") { ai.toggleExtra() }
                if (ai.extraOpen) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    val error = extra.menuText("error")
                    AIInput(ai.extraDraft ?: extra.getString("value"), extra.getString("label"), extra.getString("placeholder"), "ai-extra-body-input",
                        Modifier.fillMaxWidth().heightIn(min = 120.dp), code = true) { ai.typeExtra(it) }
                    Text(error ?: extra.getString("hint"), style = rnText(13, 400, 18), color = if (error != null) c.danger else c.secondaryText,
                        modifier = Modifier.padding(top = 6.dp))
                    val save = extra.getString("save")
                    val shape = RoundedCornerShape(10.dp)
                    Box(Modifier.padding(top = 10.dp).fillMaxWidth().clip(shape).rnBorder(1.dp, c.border, shape)
                        .clearAndSetSemantics { contentDescription = save; role = Role.Button; testTag = "ai-extra-body-save"
                            if (model.menu.idle) onClick { ai.saveExtra(extra.getString("value")); true } else disabled() }
                        .clickable(enabled = model.menu.idle) { ai.saveExtra(extra.getString("value")) }.padding(horizontal = 12.dp, vertical = 10.dp),
                        contentAlignment = Alignment.Center) {
                        Text(save, style = rnText(13, 700), color = c.text)
                    }
                }
                KeyField(model, "assistant", chosen, panel.getJSONObject("apiKey"), 16)
            }
            "gemini" -> {
                val thinking = panel.getJSONObject("thinking")
                AIRow(thinking.getString("label"), thinking.getString("description"))
                Chips(model, thinking.menuObjects("options"), "ai-thinking") { ai.set(JSONObject().put("type", "thinkingBudget").put("value", it.getInt("value"))) }
                KeyField(model, "assistant", chosen, panel.getJSONObject("apiKey"), 16)
            }
            else -> {
                SwitchRow(model, panel.getJSONObject("thinking"), "ai-anthropic-thinking") { on -> ai.set(JSONObject().put("type", "anthropicThinking").put("value", on)) }
                panel.optJSONObject("budget")?.let { budget ->
                    AIRow(budget.getString("label"), budget.getString("description"))
                    Chips(model, budget.menuObjects("options"), "ai-thinking") { ai.set(JSONObject().put("type", "thinkingBudget").put("value", it.getInt("value"))) }
                }
                KeyField(model, "assistant", chosen, panel.getJSONObject("apiKey"), 16)
            }
        }
        val advanced = card.getJSONObject("advanced")
        FoldRow(advanced.getString("label"), null, ai.advancedOpen, true, "ai-advanced") { ai.toggleAdvanced() }
        if (ai.advancedOpen) {
            val timeout = advanced.getJSONObject("timeout")
            AIRow(timeout.getString("label"), timeout.getString("description"))
            Dropdown(timeout.getString("label"), timeout.getString("value"), "ai-timeout") { ai.openPicker("timeout") }
        }
    }
}

/** RN's AiSettingsSpeechCard: folded; the switch, provider, model, the Whisper file or the key and base URL, language, mode and fields. */
@Composable
private fun SpeechCard(model: InboxViewModel, card: JSONObject) {
    val ai = model.menu.settings.ai
    val c = LocalTheme.current.colors
    Card(top = 12) {
        FoldRow(card.getString("title"), card.getString("description"), ai.speechOpen, false, "ai-speech-card") { ai.toggleSpeech() }
        if (!ai.speechOpen) return@Card
        SwitchRow(model, card.getJSONObject("enabled"), "ai-speech-enabled") { on -> ai.set(JSONObject().put("type", "speechEnabled").put("value", on)) }
        val provider = card.getJSONObject("provider")
        val providers = provider.menuObjects("options")
        AIRow(provider.getString("label"), provider.getString("description"))
        Chips(model, providers, "ai-speech-provider") { ai.set(JSONObject().put("type", "speechProvider").put("value", it.getString("value"))) }
        val speechModel = card.getJSONObject("model")
        AIRow(speechModel.getString("label"), null)
        if (speechModel.getString("kind") == "input") ModelInput(model, "speechModel", speechModel, "ai-speech-model", "speechModel")
        else Dropdown(speechModel.getString("label"), speechModel.getString("value"), "ai-speech-model") { ai.openPicker("speechModel") }
        card.optJSONObject("whisper")?.let { whisper ->
            AIRow(whisper.getString("label"), whisper.getString("description"))
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(whisper.getString("status"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.weight(1f))
                // Download and Delete come with the Whisper pass (D4): core offers them off.
                val action = whisper.getJSONObject("action")
                val shape = RoundedCornerShape(16.dp)
                Box(Modifier.fade(if (action.getBoolean("enabled")) 1f else 0.5f).clip(shape).rnBorder(1.dp, c.border, shape)
                    .clearAndSetSemantics { contentDescription = action.getString("label"); role = Role.Button; disabled() }
                    .padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Text(action.getString("label"), style = rnText(13, 700, 17), color = c.text, maxLines = 2, textAlign = TextAlign.Center)
                }
            }
        }
        card.optJSONObject("apiKey")?.let { key -> KeyField(model, "speech", selectedValue(providers), key, 12) }
        card.optJSONObject("baseUrl")?.let { UrlField(model, "speechBaseUrl", it, "ai-speech-base-url") }
        val language = card.getJSONObject("language")
        AIRow(language.getString("label"), language.getString("description"))
        Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
            AIInput(ai.typed["speechLanguage"] ?: language.getString("value"), language.getString("label"), language.getString("placeholder"),
                "ai-speech-language", Modifier.fillMaxWidth()) { text -> ai.type("speechLanguage", text) { JSONObject().put("type", "speechLanguage").put("text", text) } }
        }
        val mode = card.getJSONObject("mode")
        AIRow(mode.getString("label"), mode.getString("description"))
        Chips(model, mode.menuObjects("options"), "ai-speech-mode") { ai.set(JSONObject().put("type", "speechMode").put("value", it.getString("value"))) }
        val fields = card.getJSONObject("fieldStrategy")
        AIRow(fields.getString("label"), fields.getString("description"))
        Chips(model, fields.menuObjects("options"), "ai-speech-fields") { ai.set(JSONObject().put("type", "speechFieldStrategy").put("value", it.getString("value"))) }
    }
}

/**
 * RN's model and timeout pickers (pickerOverlay, pickerCard): core's title and options, the chosen one washed with lucide's Check;
 * a choice sends its change and closes it.
 */
@Composable
private fun AIPicker(model: InboxViewModel, view: JSONObject, picker: String) {
    val ai = model.menu.settings.ai
    val theme = LocalTheme.current
    val c = theme.colors
    val (title, options, change) = when (picker) {
        "timeout" -> view.getJSONObject("assistant").getJSONObject("advanced").getJSONObject("timeout").let { timeout ->
            Triple(timeout.getString("label"), timeout.menuObjects("options")) { option: JSONObject -> JSONObject().put("type", "requestTimeoutSeconds").put("value", option.getInt("value")) }
        }
        else -> view.getJSONObject("pickers").getJSONObject(picker).let { list ->
            Triple(list.getString("title"), list.menuObjects("options")) { option: JSONObject -> JSONObject().put("type", picker).put("value", option.getString("value")) }
        }
    }
    val close = { ai.openPicker(null) }
    BackHandler { close() }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(Unit) { detectTapGestures { close() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
            .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("ai-picker")) {
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (option in options) {
                    val on = option.getBoolean("selected")
                    val label = option.getString("label")
                    val row = RoundedCornerShape(10.dp)
                    val choose = { close(); ai.set(change(option)) }
                    Row(Modifier.fillMaxWidth().clip(row).background(if (on) c.filterBg else Color.Transparent).rnBorder(1.dp, c.border, row)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (model.menu.idle) onClick { choose(); true } else disabled() }
                        .clickable(enabled = model.menu.idle) { choose() }.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text(label, style = rnText(13, 600), color = if (on) c.tint else c.text, modifier = Modifier.weight(1f))
                        if (on) Icon(PickerCheck, null, tint = c.tint, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}
