package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
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
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

/*
 * RN's capture confirmation screen (app/capture-modal.tsx), drawn from core's capture screen view: the Add Task card
 * centered on the background, the hide-keyboard and ? buttons, the title field with core's preview chips, the description
 * field when the entry brought one, a file share's files, the syntax help, the failure line, and Cancel, Save & edit and Save; over it, RN's
 * several-lines question. Every word and every control's edit is core's (CaptureModalModel.kt).
 */

private fun JSONObject.text(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)

/** One accessibility node per control: its label, role, state and test tag together, then the tap. */
private fun Modifier.control(label: String, tag: String, enabled: Boolean, action: () -> Unit) =
    clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action)

@OptIn(ExperimentalLayoutApi::class, ExperimentalComposeUiApi::class)
@Composable
fun CaptureModalScreen(model: InboxViewModel, modal: CaptureModal) = with(model.captureModal) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = modal.view
    val owed = model.failedAction != null
    val locked = model.busy || owed
    // While a Save's retry is owed, only that Save (or Create tasks) runs, with the same capture IDs.
    val canSave = model.writable && !model.busy && (!owed || model.failedAction == modal.pending)
    val keyboard = LocalSoftwareKeyboardController.current
    val titleFocus = remember { FocusRequester() }
    // RN focuses the field 120 ms after the screen opens; the keyboard leaves with the screen.
    LaunchedEffect(modal.session) { delay(120); runCatching { titleFocus.requestFocus() } }
    DisposableEffect(Unit) { onDispose { keyboard?.hide() } }
    // Edits wait while an action runs; they go on once none does.
    LaunchedEffect(model.busy, owed) { if (!model.busy && !owed) pump() }
    // Core's copilot question for the title as it reads now: requestAICopilot once typing pauses (RN's 800 ms), its answer back as an edit.
    val copilotRequest = view.getJSONObject("copilot").optJSONObject("request")
    LaunchedEffect(modal.session, copilotRequest?.toString()) { model.ai.captureCopilot(modal.session, copilotRequest) }
    BackHandler {
        if (model.busy) return@BackHandler
        if (modal.confirm != null) cancelLines() else cancel(leave = false)
    }
    // Edge to edge, as RN's screen: the card is centered in the whole window, and while the keyboard is up in the space above
    // it, so Cancel and Save stay reachable (RN's KeyboardAvoidingView, 'height' on Android).
    Box(Modifier.fillMaxSize().background(c.bg).imePadding().semantics { testTagsAsResourceId = true }.testTag("capture-modal")) {
        Column(Modifier.fillMaxSize()) {
            // An owed failure (this screen's save, or any other command) shows the app's failure banner with its exact retry.
            if (model.failedAction != null) Box(Modifier.statusBarsPadding()) { FailureBanner(model.error.orEmpty()) { OwedRetry(model) } }
            // RN's ScrollView: the card centered while it fits, scrolled once it does not (the keyboard up, a long description).
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                Column(Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).padding(16.dp), verticalArrangement = Arrangement.Center) {
                    val card = RoundedCornerShape(12.dp)
                    // RN's border sits outside its padding; a Compose border is drawn over the padding, so each bordered box here pads 1 dp more.
                    Column(Modifier.fillMaxWidth().clip(card).background(c.cardBg).border(1.dp, c.border, card).padding(17.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(view.getString("title"), style = rnText(20, 600), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (WindowInsets.isImeVisible) {
                                    Box(Modifier.clip(CircleShape).background(c.inputBg).border(1.dp, c.border, CircleShape)
                                        .control(view.getString("hideKeyboard"), "capture-modal-hide-keyboard", true) { keyboard?.hide() }
                                        .padding(horizontal = 11.dp, vertical = 7.dp)) {
                                        Icon(Lucide.ChevronDown, null, tint = c.text, modifier = Modifier.size(16.dp))
                                    }
                                }
                                val help = view.getJSONObject("help")
                                Box(Modifier.size(28.dp).clip(CircleShape).background(c.inputBg).border(1.dp, c.border, CircleShape)
                                    .control(help.getString("toggle"), "capture-modal-help", !locked) { edit(help.getJSONObject("edit")) },
                                    contentAlignment = Alignment.Center) {
                                    Text(help.getString("toggle"), style = rnText(14, 700), color = c.secondaryText)
                                }
                            }
                        }
                        val input = view.getJSONObject("input")
                        ModalField(modal.draft.getString("text"), input.getString("placeholder"), "capture-modal-title", !locked, 16, 80.dp,
                            Modifier.focusRequester(titleFocus)) { type(it) }
                        val preview = view.items("preview")
                        if (preview.isNotEmpty()) PreviewStrip(preview, Modifier)
                        // A file share's files (RN's Attachments group): the label, then each file's paperclip and name.
                        view.optJSONObject("attachments")?.let { files ->
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(files.getString("label"), style = rnText(12, 600, 16), color = c.secondaryText)
                                val titles = files.getJSONArray("titles")
                                for (index in 0 until titles.length()) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Icon(Lucide.Paperclip, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
                                    Text(titles.getString(index), style = rnText(14, 400), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f).testTag("capture-modal-attachment"))
                                }
                            }
                        }
                        // Shown while the entry brought a description or the field holds one.
                        view.optJSONObject("description")?.let { description ->
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(description.getString("label"), style = rnText(12, 600, 16), color = c.secondaryText)
                                ModalField(modal.draft.getString("description"), description.getString("placeholder"), "capture-modal-description", !locked, 15, 70.dp,
                                    Modifier) { describe(it) }
                            }
                        }
                        // The copilot's chips and the applied line (RN's copilotPill), while AI is on.
                        CaptureCopilot(model, view.getJSONObject("copilot"), !locked)
                        view.getJSONObject("help").text("text")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
                        // RN's failure line, until the next save starts; TalkBack hears it at once.
                        if (modal.failed) Text(t("task.addFailed"), style = rnText(13, 400, 18), color = c.danger,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
                        val actions = view.getJSONObject("actions")
                        // RN's row stretches its buttons to the bordered Save & edit's height; RN's Android text line (font padding) is 19.
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                            val button = RoundedCornerShape(8.dp)
                            Box(Modifier.clip(button).background(c.inputBg).control(actions.getString("cancel"), "capture-modal-cancel", !model.busy) { cancel() }
                                .padding(horizontal = 14.dp, vertical = 11.dp)) {
                                Text(actions.getString("cancel"), style = rnText(14, 400, 19), color = c.text)
                            }
                            Box(Modifier.clip(button).border(1.dp, c.border, button)
                                .control(actions.getString("saveAndEdit"), "capture-modal-save-edit", canSave) { keyboard?.hide(); save(openAfterSave = true) }
                                .padding(horizontal = 15.dp, vertical = 11.dp)) {
                                Text(actions.getString("saveAndEdit"), style = rnText(14, 400, 19), color = c.text)
                            }
                            Box(Modifier.clip(button).background(theme.captureSave)
                                .control(actions.getString("save"), "capture-modal-save", canSave) { save(openAfterSave = false) }
                                .padding(horizontal = 14.dp, vertical = 11.dp)) {
                                Text(actions.getString("save"), style = rnText(14, 600, 19), color = theme.onAction)
                            }
                        }
                    }
                }
            }
        }
        ToastCard(model, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 16.dp))
        // RN's several-lines question on the screen itself (#941): Cancel, the backdrop and Back close it.
        modal.confirm?.let { confirm ->
            PickerCard(confirm.getString("title"), { if (!locked) cancelLines() }) {
                Text(confirm.getString("message"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    DialogAction(confirm.getString("cancelLabel"), c.secondaryText, !locked) { cancelLines() }
                    DialogAction(confirm.getString("confirmLabel"), c.tint, canSave) { createLines() }
                }
            }
        }
    }
}

/**
 * RN's TextInput on the card: the input background, an 8 radius, multiline (Return adds a line, as RN's Android field does), the
 * text centered in the field's height as an Android multiline field centers it.
 */
@Composable
private fun ModalField(value: String, placeholder: String, tag: String, enabled: Boolean, size: Int, minHeight: Dp, modifier: Modifier, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(field, { typed -> field = typed; if (typed.text != value) onChange(typed.text) }, enabled = enabled,
        textStyle = rnText(size, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        modifier = modifier.fillMaxWidth().heightIn(min = minHeight).clip(shape).background(c.inputBg).border(1.dp, c.border, shape).testTag(tag)
            .semantics { contentDescription = placeholder },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 13.dp, vertical = 11.dp), contentAlignment = Alignment.CenterStart) {
                if (field.text.isEmpty()) Text(placeholder, style = rnText(size, 400), color = c.secondaryText)
                inner()
            }
        })
}

private fun JSONObject.items(name: String): List<JSONObject> = optJSONArray(name)?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()
