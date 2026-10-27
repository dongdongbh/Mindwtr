package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import kotlin.math.roundToInt

/** One of core's MARKDOWN_TOOLBAR_ACTIONS (the `markdownToolbarActions` read): its id, RN's label (translateWithFallback) and short label. */
internal data class MarkdownAction(val id: String, val label: String, val short: String)

/**
 * The expanded editor's text with its cursor, and RN's description undo stack (use-task-description-editor: every text change
 * pushes the text and selection before it, an identical entry is skipped, at most 100).
 */
@Stable
internal class MarkdownDraft(text: String) {
    var field by mutableStateOf(TextFieldValue(text, TextRange(text.length)))
    var focused by mutableStateOf(false)
    val focus = FocusRequester()
    private val undo = ArrayDeque<TextFieldValue>()
    var canUndo by mutableStateOf(false)
        private set

    /** [next] from the keyboard or the toolbar; a text change records the text before it and is sent to [store]. */
    fun change(next: TextFieldValue, store: (String) -> Unit) {
        if (next.text != field.text) {
            val before = TextFieldValue(field.text, field.selection)
            if (undo.lastOrNull()?.let { it.text == before.text && it.selection == before.selection } != true) undo.addLast(before)
            if (undo.size > 100) undo.removeFirst()
            canUndo = true
            store(next.text)
        }
        field = next
    }

    fun undo(store: (String) -> Unit) {
        val last = undo.removeLastOrNull() ?: return
        canUndo = undo.isNotEmpty()
        field = last
        store(last.text)
    }

    /** Text set from outside (core's stored value read again): the cursor keeps its place, clamped to the new text. */
    fun sync(text: String) {
        if (text != field.text) field = TextFieldValue(text, TextRange(field.selection.start.coerceAtMost(text.length), field.selection.end.coerceAtMost(text.length)))
    }
}

/** The expanded editor's field: [draft]'s text, focused on open so the keyboard is up, as RN's ExpandedMarkdownEditor's autoFocus. */
@Composable
internal fun MarkdownInput(draft: MarkdownDraft, store: (String) -> Unit, enabled: Boolean, placeholder: String, description: String, style: TextStyle,
                           modifier: Modifier, decoration: @Composable (@Composable () -> Unit) -> Unit, onBlur: () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(draft, enabled) { if (enabled) { draft.focus.requestFocus(); keyboard?.show() } }
    BasicTextField(draft.field, { draft.change(it, store) }, enabled = enabled, textStyle = style, cursorBrush = SolidColor(c.tint),
        modifier = modifier.focusRequester(draft.focus).semantics { contentDescription = description }.onFocusChanged {
            if (draft.focused && !it.isFocused) onBlur()
            draft.focused = it.isFocused
        },
        decorationBox = { field -> decoration { Box { if (draft.field.text.isEmpty()) Text(placeholder, style = style, color = c.secondaryText); field() } } })
}

/**
 * RN's MarkdownFormatToolbar over the keyboard, shown while the field has focus and the keyboard is up: the actions scroll
 * sideways, then a divider and Undo. Each action is core's applyMarkdownToolbarAction (the `markdownToolbarApply` read) on the
 * text and selection of the tap; a reply for text typed over since is dropped.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MarkdownToolbar(model: InboxViewModel, draft: MarkdownDraft, store: (String) -> Unit) {
    var actions by remember { mutableStateOf<List<MarkdownAction>?>(null) }
    var undoLabel by remember { mutableStateOf("") }
    // A background read: it does not start while a user action runs, so it tries again once that ends.
    LaunchedEffect(model.busy) {
        if (actions == null && !model.busy) model.background(emptyList(), { runtime -> runtime.menuRead("markdownToolbarActions", "{}") }) { reply, _ ->
            val list = reply.getJSONArray("actions")
            actions = (0 until list.length()).map { list.getJSONObject(it).run { MarkdownAction(getString("id"), getString("label"), getString("shortLabel")) } }
            undoLabel = reply.getString("undoLabel")
        }
    }
    val shown = actions
    if (shown == null || !draft.focused || !WindowInsets.isImeVisible) return
    val c = LocalTheme.current.colors
    // RN's sizing: the actions and Undo across the window, less 16 padding, 18 chrome and the 2 gaps, each 32 to 40.
    val width = LocalConfiguration.current.screenWidthDp
    val button = ((width - 16 - 18 - 2 * (shown.size - 1)) / (shown.size + 1)).coerceIn(32, 40)
    val iconSize = (button * 0.58f).roundToInt().coerceIn(18, 22)
    val fontSize = (button * 0.36f).roundToInt().coerceIn(12, 14)
    val apply = { action: String ->
        val before = draft.field
        val input = JSONObject().put("value", before.text).put("start", before.selection.min).put("end", before.selection.max).put("action", action)
        model.background(emptyList(), { runtime -> runtime.menuRead("markdownToolbarApply", input.toString()) }) { reply, _ ->
            if (draft.field.text == before.text) draft.change(TextFieldValue(reply.getString("value"), TextRange(reply.getInt("start"), reply.getInt("end"))), store)
        }
    }
    Row(Modifier.fillMaxWidth().background(c.bg).hairline(c.border, top = true).padding(horizontal = 8.dp, vertical = 4.dp).testTag("markdown-toolbar"),
        verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()).padding(vertical = 1.dp).padding(end = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
            shown.forEach { (id, label, short) ->
                ToolbarButton(label, button, enabled = true, { apply(id) }) {
                    when (val glyph = markdownGlyph(id)) {
                        null -> Text(short, style = rnText(fontSize, 700), color = c.text)
                        else -> {
                            // RN draws FontAwesome's italic and strikethrough as text at 64% of the icon size.
                            val fa = id == "italic" || id == "strikethrough"
                            val size = if (fa) maxOf(12, (iconSize * 0.64f).roundToInt()) else iconSize
                            Icon(glyph, null, tint = c.text, modifier = Modifier.size((size * glyph.defaultWidth.value / glyph.defaultHeight.value).dp, size.dp))
                        }
                    }
                }
            }
        }
        Row(Modifier.padding(start = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(horizontal = 3.dp).width(1.dp).height(20.dp).fade(0.8f).background(c.border))
            ToolbarButton(undoLabel, button, draft.canUndo, { draft.undo(store) }) {
                Icon(Ionicons.ArrowUndoOutline, null, tint = c.text, modifier = Modifier.size(iconSize.dp))
            }
        }
    }
}

private fun markdownGlyph(id: String): ImageVector? = when (id) {
    "bulletList" -> Ionicons.ListOutline
    "orderedList" -> Ionicons.ListCircleOutline
    "taskList" -> Ionicons.CheckboxOutline
    "horizontalRule" -> Ionicons.RemoveOutline
    "quote" -> Ionicons.ChatboxEllipsesOutline
    "link" -> Ionicons.LinkOutline
    "code" -> Ionicons.CodeSlashOutline
    "codeBlock" -> Ionicons.CodeWorkingOutline
    "italic" -> FontAwesome.Italic
    "strikethrough" -> FontAwesome.Strikethrough
    else -> null
}

/** RN's toolbar button: square, radius 7, the filter background while pressed; disabled at 35%. */
@Composable
private fun ToolbarButton(label: String, size: Int, enabled: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    Box(Modifier.size(size.dp).clip(RoundedCornerShape(7.dp)).background(if (pressed) c.filterBg else c.bg.copy(alpha = 0f))
        .clickable(press, null, enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .then(if (enabled) Modifier else Modifier.fade(0.35f)), contentAlignment = Alignment.Center) { content() }
}
