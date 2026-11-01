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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * RN's project next-action prompt (project-next-action-prompt.tsx): after a row's Done leaves its project, or its sequential
 * section, without a next action, core's prompt (getProjectNextActionPrompt) asks what comes next. Choose, Add (Save & edit opens
 * the new task's Form tab) and Complete project are one journaled command each ([command], runProjectNextAction); Skip, Back and
 * the scrim close it. It lives on the shell, so it stays open when the completed row leaves its list (RN 754d2b719).
 */
class NextActionPromptModel(
    /** Core's projectNextAction command with this input (MenuModel.command). */
    private val command: (JSONObject) -> Unit,
    /** RN's failure toast: its title and message. */
    private val toast: (title: String, message: String) -> Unit,
    /** The new task's editor on its Form tab, once no command runs. */
    private val openEditor: (String) -> Unit,
) {
    /** Core's prompt, or null when none shows. */
    var prompt by mutableStateOf<JSONObject?>(null); private set
    /** The new next action as typed. */
    var title by mutableStateOf(""); private set
    /** The prompt the last action was sent from: its reply changes only that prompt, still open (RN's promptOwnerRef). */
    private var sentFrom: JSONObject? = null
    private val owned get() = prompt != null && prompt === sentFrom

    /** A completion's prompt (null: the project still has a next action). An open prompt's typed text is never replaced. */
    fun show(next: JSONObject?) {
        if (next == null || (prompt != null && title.isNotBlank())) return
        prompt = next
        title = ""
    }

    fun type(text: String) { title = text }

    fun close() {
        prompt = null
        title = ""
    }

    fun choose(item: JSONObject) = send(JSONObject().put("action", "choose").put("candidateId", item.getString("id"))
        .put("candidateRevision", item.getString("taskRevision")))

    /** RN's Add next action, or Save & edit ([openAfterSave]), into the prompt's project and section; nothing while the text is blank. */
    fun add(openAfterSave: Boolean) {
        val shown = prompt ?: return
        if (title.isBlank()) return
        send(JSONObject().put("action", "add").put("text", title).put("openAfterSave", openAfterSave)
            .put("projectId", shown.getString("projectId")).put("sectionId", shown.opt("sectionId") ?: JSONObject.NULL))
    }

    fun completeProject() {
        val shown = prompt ?: return
        send(JSONObject().put("action", "completeProject").put("projectId", shown.getString("projectId")).put("projectRevision", shown.getString("projectRevision")))
    }

    private fun send(action: JSONObject) {
        val shown = prompt ?: return
        sentFrom = shown
        command(action.put("taskId", shown.getString("taskId")))
    }

    /** Core's answer: its prompt closes; Save & edit opens the new task on its Form tab (RN 9dea771b5), only if that prompt was still open. */
    internal fun done(reply: JSONObject) {
        if (!owned) return
        close()
        if (reply.optString("action") == "add" && reply.optBoolean("openAfterSave")) openEditor(reply.getString("id"))
    }

    /**
     * A refusal wrote nothing: RN's failure toast, and the prompt stays open with its text (RN 1eb06e017). A stale one ([stale]: a
     * candidate or the project changed since) takes core's prompt read again for the same task ([fresh]), keeping the typed text,
     * and closes when that task needs none now.
     */
    internal fun refused(stale: Boolean = false, fresh: JSONObject? = null) {
        val failure = prompt?.optJSONObject("failure")
        if (failure != null) toast(failure.getString("title"), failure.getString("message"))
        if (!stale || !owned) return
        if (fresh == null) close() else prompt = fresh
    }

    /** A failure that leaves a retry owed (SAVE_FAILED: it landed): the prompt closes, so the failure banner's Try again is reachable. */
    internal fun owed() { if (owned) close() }
}

/** RN's ProjectNextActionPromptModal: its card over a 50% scrim, as RN's Modal over the whole app. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NextActionPrompt(model: InboxViewModel) {
    val next = model.nextAction
    val prompt = next.prompt ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val submitting = model.busy
    val canAdd = next.title.isNotBlank()
    val addDisabled = !canAdd || submitting
    BackHandler { next.close() }
    Box(Modifier.fillMaxSize().imePadding().background(theme.menuScrim).semantics { testTagsAsResourceId = true }
        .pointerInput(Unit) { detectTapGestures { next.close() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        val title = prompt.getString("title")
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.86f).dp)
            .shadow(5.dp, shape).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .verticalScroll(rememberScrollState()).padding(20.dp).semantics { contentDescription = title }.testTag("next-action-prompt")) {
            Text(title, style = rnText(18, 600), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp).semantics { heading() })
            Text(prompt.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp))
            val choose = prompt.getJSONObject("choose")
            val items = choose.getJSONArray("items")
            if (items.length() > 0) {
                Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(choose.getString("label").uppercase(), style = rnText(12, 700), color = c.secondaryText)
                    Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
                        for (index in 0 until items.length()) {
                            val item = items.getJSONObject(index)
                            val row = RoundedCornerShape(10.dp)
                            Column(Modifier.padding(bottom = 8.dp).fillMaxWidth().fade(if (submitting) 0.6f else 1f).clip(row).background(c.inputBg)
                                .rnBorder(1.dp, c.border, row).clickable(enabled = !submitting, role = Role.Button) { next.choose(item) }
                                .semantics { contentDescription = item.getString("title") }.padding(horizontal = 12.dp, vertical = 10.dp)
                                .testTag("next-action-candidate")) {
                                Text(item.getString("title"), style = rnText(14, 600, 19), color = c.text)
                                // RN's textTransform capitalize on the status words.
                                Text(item.getString("statusLabel").split(" ").joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } },
                                    style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                            }
                        }
                    }
                }
            }
            val add = prompt.getJSONObject("add")
            Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(add.getString("label").uppercase(), style = rnText(12, 700), color = c.secondaryText)
                val field = RoundedCornerShape(10.dp)
                BasicTextField(next.title, next::type, enabled = !submitting, singleLine = true, cursorBrush = SolidColor(c.tint),
                    textStyle = rnText(15, 500).copy(color = c.text), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (!addDisabled) next.add(false) }),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(field).background(c.inputBg).rnBorder(1.dp, c.border, field)
                        .semantics { contentDescription = add.getString("label") }.testTag("next-action-input"),
                    decorationBox = { inner ->
                        Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
                            if (next.title.isEmpty()) Text(add.getString("placeholder"), style = rnText(15, 500), color = c.secondaryText)
                            inner()
                        }
                    })
                Box(Modifier.heightIn(min = 44.dp).clickable(enabled = !addDisabled, role = Role.Button) { next.add(true) }.padding(horizontal = 8.dp)
                    .testTag("next-action-save-edit"), contentAlignment = Alignment.CenterStart) {
                    Text(add.getString("saveAndEdit"), style = rnText(14, 700), color = if (addDisabled) c.secondaryText else c.tint)
                }
            }
            val button = RoundedCornerShape(10.dp)
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                prompt.optJSONObject("completeProject")?.let { complete ->
                    Box(Modifier.heightIn(min = 44.dp).clickable(enabled = !submitting, role = Role.Button) { next.completeProject() }.padding(horizontal = 8.dp)
                        .testTag("next-action-complete-project"), contentAlignment = Alignment.Center) {
                        Text(complete.getString("label"), style = rnText(14, 700), color = if (submitting) c.secondaryText else c.tint)
                    }
                    // RN's marginRight: 'auto' pushes Complete project left, away from Skip and Add.
                    Spacer(Modifier.weight(1f))
                }
                Box(Modifier.heightIn(min = 44.dp).clip(button).background(c.filterBg).rnBorder(1.dp, c.border, button)
                    .clickable(role = Role.Button) { next.close() }.padding(horizontal = 16.dp).testTag("next-action-skip"), contentAlignment = Alignment.Center) {
                    Text(prompt.getString("skip"), style = rnText(14, 700), color = c.text)
                }
                Box(Modifier.heightIn(min = 44.dp).clip(button).background(if (addDisabled) c.filterBg else c.tint)
                    .clickable(enabled = !addDisabled, role = Role.Button) { next.add(false) }.padding(horizontal = 16.dp).testTag("next-action-add"),
                    contentAlignment = Alignment.Center) {
                    if (submitting) CircularProgressIndicator(Modifier.size(20.dp), color = c.secondaryText, strokeWidth = 2.dp)
                    else Text(add.getString("button"), style = rnText(14, 700), color = if (canAdd) c.onTint else c.secondaryText)
                }
            }
        }
    }
}
