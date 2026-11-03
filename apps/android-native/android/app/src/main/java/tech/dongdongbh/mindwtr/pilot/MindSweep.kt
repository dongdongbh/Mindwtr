package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.InboxViewModel.Part
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.io.File
import java.io.FileOutputStream
import java.util.UUID


private const val WINDOW = 100

private const val STALE_READS = 3


private fun <T> wholeView(read: () -> T): T {
    repeat(STALE_READS - 1) {
        try {
            return read()
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
    }
    return read()
}

class MindSweepModel(private val menu: MenuModel, private val file: File) {
    private val shell get() = menu.shell


    var state by mutableStateOf(if (menu.screen == MenuScreen.MindSweep) stored() ?: fresh() else fresh().also { file.delete() }); private set

    var view by mutableStateOf<JSONObject?>(null); private set

    var viewDraft by mutableStateOf<String?>(null); private set

    private fun fresh() = JSONObject().put("sweep", JSONObject().put("scope", "all").put("step", -1).put("captured", JSONObject()))
        .put("draft", "").put("addFailed", false).put("requestId", UUID.randomUUID().toString())

    private fun stored(): JSONObject? = runCatching { JSONObject(file.readText()) }.getOrNull()


    private fun keep(value: JSONObject) {
        state = value
        file.parentFile?.mkdirs()
        val partial = File(file.parentFile, "${file.name}.partial")
        FileOutputStream(partial).use { out -> out.write(value.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(file)) { "Cannot save the Mind Sweep" }
    }

    private fun edit(change: JSONObject.() -> Unit) = keep(JSONObject(state.toString()).apply(change))


    fun reset() { keep(fresh()); view = null; viewDraft = null }


    fun forget() { state = fresh(); view = null; viewDraft = null; file.delete() }


    private fun read(runtime: CoreHost, sent: JSONObject): JSONObject = wholeView {
        val input = JSONObject().put("state", sent.getJSONObject("sweep")).put("draft", sent.getString("draft")).put("addFailed", sent.getBoolean("addFailed"))
        val first = runtime.menuRead("mindSweep", JSONObject(input.toString()).put("offset", 0).put("limit", WINDOW).toString())
        first.optJSONObject("group")?.optJSONObject("captured")?.let { captured ->
            val items = captured.getJSONArray("items")
            while (items.length() < captured.getInt("total")) {
                val next = runtime.menuRead("mindSweep", JSONObject(input.toString()).put("offset", items.length()).put("limit", WINDOW)
                    .put("revision", first.getString("revision")).toString()).optJSONObject("group")?.optJSONObject("captured")?.getJSONArray("items")
                if (next == null || next.length() == 0) break
                for (index in 0 until next.length()) items.put(next.get(index))
            }
        }
        first
    }

    private fun show(sent: JSONObject, next: JSONObject) {
        if (menu.list != "mindSweep") return
        shell.readSucceeded()
        view = next
        viewDraft = sent.getString("draft")
    }


    fun reload() = menu.whenIdle {
        val sent = state
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, sent)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(sent, next) }
        }
    }


    fun refresh() {
        val sent = state
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, sent) }) { next, mine -> if (shell.fresh(mine, Part.Menu)) show(sent, next) }
    }


    fun scope(value: String) { edit { getJSONObject("sweep").put("scope", value) }; reload() }


    fun step(value: Int) { edit { getJSONObject("sweep").put("step", value) }; reload() }


    fun type(text: String) {
        edit { put("draft", text) }
        menu.whenIdle { refresh() }
    }


    private fun addAction(group: String) = FailedAction("mindSweepAdd", state.getString("requestId"), JSONObject().put("title", state.getString("draft")).toString(),
        patch = mapOf("group" to group))


    fun add() {
        val group = view?.optJSONObject("group") ?: return
        if (viewDraft != state.getString("draft") || group.getJSONObject("add").getBoolean("disabled")) return
        menu.create(addAction(group.getString("id")))
    }


    private fun ours(action: FailedAction) = menu.screen == MenuScreen.MindSweep && state.getString("requestId") == action.id


    fun added(action: FailedAction, reply: JSONObject) {
        val group = action.patch["group"] ?: return
        if (!ours(action)) return
        edit {
            val captured = getJSONObject("sweep").getJSONObject("captured")
            captured.put(group, (captured.optJSONArray(group) ?: JSONArray()).put(reply.getString("title")))
            if (optString("draft") == JSONObject(action.title).getString("title")) put("draft", "")
            put("addFailed", false)
            put("requestId", UUID.randomUUID().toString())
        }
    }


    fun refused(action: FailedAction) {
        if (!ours(action)) return
        edit { put("addFailed", true); put("requestId", UUID.randomUUID().toString()) }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MindSweepScreen(model: InboxViewModel) = with(model.menu.sweep) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shown = view
    val canClose = model.failedAction == null
    Column(Modifier.fillMaxSize().background(c.bg).imePadding().testTag("mind-sweep")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(shown?.getString("title").orEmpty(), style = rnText(18, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            val close = shown?.getString("closeLabel") ?: t("common.close")
            Text(close, style = rnText(15, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                .clearAndSetSemantics { contentDescription = close; role = Role.Button; testTag = "mind-sweep-close"; if (canClose) onClick { model.menu.closeScreen(); true } else disabled() }
                .clickable(enabled = canClose) { model.menu.closeScreen() }.padding(start = 12.dp, top = 12.dp, bottom = 12.dp))
        }
        model.error?.let { message ->
            FailureBanner(message) {
                if (model.failedAction == null) RetryButton({ reload() }, !model.busy, "read-retry")
                else OwedRetry(model)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                shown?.optJSONObject("intro")?.let { intro ->
                    Text(intro.getString("text"), style = rnText(15, 400, 21), color = c.secondaryText)
                    Text(intro.getString("scopeLabel"), style = rnText(15, 600), color = c.text, modifier = Modifier.padding(top = 8.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (option in intro.menuObjects("scopes")) ScopeChip(option.getString("label"), option.getBoolean("selected"), model.menu.idle) { scope(option.getString("value")) }
                    }
                    val start = intro.getJSONObject("start")
                    SweepButton(start.getString("label"), "mind-sweep-start", filled = true, enabled = model.menu.idle, wide = true) { step(start.getInt("step")) }
                }
                shown?.optJSONObject("group")?.let { group -> CueList(model, group) }
                shown?.optJSONObject("summary")?.let { summary ->
                    Column(Modifier.testTag("mind-sweep-summary"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(summary.getString("title"), style = rnText(17, 700), color = c.text, modifier = Modifier.semantics { heading() })
                        Text(summary.getString("message"), style = rnText(15, 400, 21), color = c.secondaryText)
                        summary.menuText("hint")?.let { Text(it, style = rnText(15, 400, 21), color = c.secondaryText) }
                        SweepButton(summary.getString("finishLabel"), "mind-sweep-finish", filled = true, enabled = canClose, wide = true) { model.menu.closeScreen() }
                    }
                }
            }
            ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp))
        }
    }
}


@Composable
private fun CueList(model: InboxViewModel, group: JSONObject) = with(model.menu.sweep) {
    val c = LocalTheme.current.colors
    val idle = model.menu.idle
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
        Text(group.getString("title"), style = rnText(17, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() }.testTag("mind-sweep-group-title"))
        Text(group.getString("progress"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(start = 8.dp))
    }
    for (prompt in group.getJSONArray("prompts").let { prompts -> List(prompts.length()) { prompts.getString(it) } }) {
        Text("• $prompt", style = rnText(14, 400, 20), color = c.secondaryText)
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 44.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val draft = state.getString("draft")
        val placeholder = group.getString("placeholder")
        val shape = RoundedCornerShape(10.dp)
        BasicTextField(draft, { type(it) }, enabled = model.failedAction == null, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text),
            cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { add() }),
            modifier = Modifier.weight(1f).semantics { contentDescription = placeholder }.testTag("mind-sweep-input"),
            decorationBox = { inner ->
                Box(Modifier.heightIn(min = 44.dp).clip(shape).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
                    if (draft.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText)
                    inner()
                }
            })
        val addControl = group.getJSONObject("add")
        SweepButton(addControl.getString("label"), "mind-sweep-add", filled = true, enabled = idle && viewDraft == draft && !addControl.getBoolean("disabled"), compact = true) { add() }
    }
    group.menuText("addFailed")?.let {
        Text(it, style = rnText(13, 400), color = c.danger, modifier = Modifier.padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Assertive }.testTag("mind-sweep-add-failed"))
    }
    group.optJSONObject("captured")?.let { captured ->
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(captured.getString("label"), style = rnText(12, 400), color = c.secondaryText)
            for (item in captured.getJSONArray("items").let { items -> List(items.length()) { items.getString(it) } }) {
                Text("• $item", style = rnText(14, 400), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("mind-sweep-captured-item"))
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        val back = group.getJSONObject("back")
        SweepButton(back.getString("label"), "mind-sweep-back", filled = false, enabled = idle && !back.getBoolean("disabled")) { step(back.getInt("step")) }
        val next = group.getJSONObject("next")
        SweepButton(next.getString("label"), "mind-sweep-next", filled = true, enabled = idle) { step(next.getInt("step")) }
    }
}


@Composable
private fun ScopeChip(label: String, selected: Boolean, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(999.dp)
    Box(Modifier.heightIn(min = 44.dp).clip(shape).background(if (selected) c.tint else c.bg).rnBorder(1.dp, if (selected) c.tint else c.border, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 14.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 600, 18), color = if (selected) c.onTint else c.text, textAlign = TextAlign.Center, maxLines = 2)
    }
}


@Composable
private fun SweepButton(label: String, tag: String, filled: Boolean, enabled: Boolean, wide: Boolean = false, compact: Boolean = false, action: () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.fade(if (enabled) 1f else 0.5f).then(if (wide) Modifier.padding(top = 16.dp).fillMaxWidth() else Modifier).heightIn(min = 44.dp).clip(shape)
        .then(if (filled) Modifier.background(theme.filledBg) else Modifier.rnBorder(1.dp, c.border, shape))
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action)
        .padding(horizontal = if (compact) 16.dp else 24.dp, vertical = if (wide) 12.dp else 10.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(15, if (filled) 700 else 600), color = if (filled) theme.filledText else c.text)
    }
}
