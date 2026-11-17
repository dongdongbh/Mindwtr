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
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import org.json.JSONObject
import kotlin.math.roundToInt


internal data class MarkdownAction(val id: String, val label: String, val short: String)


@Stable
internal class MarkdownDraft(text: String) {
    var field by mutableStateOf(TextFieldValue(text, TextRange(text.length)))
    var focused by mutableStateOf(false)
    val focus = FocusRequester()
    private val undo = ArrayDeque<TextFieldValue>()
    var canUndo by mutableStateOf(false)
        private set


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

    fun rewrite(next: TextFieldValue, store: (String) -> Unit) {
        field = next
        store(next.text)
    }

    fun undo(store: (String) -> Unit) {
        val last = undo.removeLastOrNull() ?: return
        canUndo = undo.isNotEmpty()
        field = last
        store(last.text)
    }


    fun sync(text: String) {
        if (text != field.text) field = TextFieldValue(text, TextRange(field.selection.start.coerceAtMost(text.length), field.selection.end.coerceAtMost(text.length)))
    }
}


internal data class MarkdownReference(val id: String, val title: String, val meta: String, val token: String)

internal data class MarkdownReferences(val text: String, val selection: TextRange, val start: Int, val end: Int, val items: List<MarkdownReference>) {
    fun insert(reference: MarkdownReference): TextFieldValue {
        val after = text.substring(end).removePrefix("]]")
        return TextFieldValue(text.substring(0, start) + reference.token + after, TextRange(start + reference.token.length))
    }
}


internal fun TextFieldValue.sameEdit(other: TextFieldValue) = text == other.text && selection == other.selection


internal class AssistGate {
    var closed = false
        private set

    fun close() { closed = true }

    fun lands(now: TextFieldValue, typed: TextFieldValue) = !closed && now.sameEdit(typed)
}


internal class PairedCloser {
    private var pair: TextFieldValue? = null
    private var echo: Pair<TextFieldValue, TextFieldValue>? = null

    fun inserted(rewritten: TextFieldValue, typed: TextFieldValue) {
        val caret = rewritten.selection.start
        echo = null
        pair = rewritten.takeIf { it.selection.collapsed && caret > 0 && caret < it.text.length && it.text.removeRange(caret, caret + 1) == typed.text }
    }

    fun forget() {
        pair = null
        echo = null
    }

    fun changed(before: TextFieldValue, typed: TextFieldValue): TextFieldValue? {
        echo?.let { (fixed, stale) -> if (before.sameEdit(fixed) && typed.sameEdit(stale)) return fixed }
        echo = null
        val shown = pair ?: return null
        pair = null
        val caret = before.selection.start
        if (!before.sameEdit(shown) || typed.selection != TextRange(caret - 1) || typed.text != before.text.removeRange(caret - 1, caret)) return null
        return TextFieldValue(before.text.removeRange(caret, caret + 1), TextRange(caret)).also { echo = it to typed }
    }
}


internal data class ReferenceCard(val below: Boolean, val maxHeight: Int)


internal fun referenceCard(lineTop: Int, lineBottom: Int, visibleTop: Int, visibleBottom: Int, gap: Int, wanted: Int): ReferenceCard {
    val below = visibleBottom - lineBottom - gap
    val above = lineTop - visibleTop - gap
    val underLine = below >= wanted || (above < wanted && below >= above)
    return ReferenceCard(underLine, (if (underLine) below else above).coerceIn(0, wanted))
}


internal fun typedLine(cursorTop: Float, cursorBottom: Float, textHeight: Int, boxHeight: Int): Pair<Float, Float> {
    val hidden = (textHeight - boxHeight).coerceAtLeast(0)
    return (cursorTop - hidden).coerceIn(0f, boxHeight.toFloat()) to cursorBottom.coerceIn(0f, boxHeight.toFloat())
}


@Stable
internal class MarkdownAssist(private val model: InboxViewModel, private val pairs: Boolean, private val taskId: String?) {
    var references by mutableStateOf<MarkdownReferences?>(null)
        private set
    private val gate = AssistGate()
    private val closer = PairedCloser()
    private var field: () -> TextFieldValue = { TextFieldValue() }
    private var searching = false
    private var searchAgain = false
    private var layout: TextLayoutResult? = null
    private var box: LayoutCoordinates? = null
    val textBox = Modifier.onGloballyPositioned { box = it }
    val textLayout = { result: TextLayoutResult -> layout = result }


    fun close() {
        gate.close()
        closer.forget()
    }

    fun changed(before: TextFieldValue, typed: TextFieldValue, current: () -> TextFieldValue, apply: (TextFieldValue) -> Unit) {
        if (typed.sameEdit(before)) return
        field = current
        closer.changed(before, typed)?.let { apply(it); return search(it) }
        if (typed.text == before.text) return search(typed)
        model.background(emptyList(), { runtime -> rewrite(runtime, before, typed) }) { rewritten, _ ->
            if (!gate.lands(current(), typed)) return@background
            rewritten?.let { apply(it); closer.inserted(it, typed) }
            search(rewritten ?: typed)
        }
    }

    fun choose(reference: MarkdownReference, apply: (TextFieldValue) -> Unit) {
        val shown = references?.takeUnless { gate.closed } ?: return
        references = null
        closer.forget()
        apply(shown.insert(reference))
    }


    fun lineInWindow(offset: Int): Pair<Int, Int>? {
        val coordinates = box?.takeIf { it.isAttached } ?: return null
        val text = layout ?: return null
        val cursor = text.getCursorRect(offset.coerceIn(0, text.layoutInput.text.length))
        val (top, bottom) = typedLine(cursor.top, cursor.bottom, text.size.height, coordinates.size.height)
        val origin = coordinates.positionInWindow().y
        return (origin + top).roundToInt() to (origin + bottom).roundToInt()
    }


    private fun search(value: TextFieldValue) {
        if (!value.selection.collapsed || !value.text.contains("[[")) {
            searchAgain = false
            references = null
            return
        }
        if (searching) return run { searchAgain = true }
        searching = true
        model.background(emptyList(), { runtime -> find(runtime, value) }, always = {
            searching = false
            if (searchAgain && !gate.closed) { searchAgain = false; search(field()) }
        }) { found, _ -> if (gate.lands(field(), value)) references = found }
    }


    private fun rewrite(runtime: CoreHost, before: TextFieldValue, typed: TextFieldValue): TextFieldValue? =
        runtime.menuRead("markdownTextChange", JSONObject().put("previous", before.text).put("next", typed.text)
            .put("start", before.selection.min).put("end", before.selection.max).put("pairs", pairs).toString())
            .takeIf { it.getBoolean("changed") }?.let { TextFieldValue(it.getString("value"), TextRange(it.getInt("start"), it.getInt("end"))) }


    private fun find(runtime: CoreHost, value: TextFieldValue): MarkdownReferences? {
        val reply = runtime.menuRead("markdownReferences", JSONObject().put("value", value.text).put("start", value.selection.start)
            .put("end", value.selection.end).put("taskId", taskId ?: JSONObject.NULL).toString())
        val list = reply.getJSONArray("suggestions")
        val items = (0 until list.length()).map { list.getJSONObject(it).run { MarkdownReference(getString("id"), getString("title"), getString("meta"), getString("token")) } }
        return MarkdownReferences(value.text, value.selection, reply.getInt("start"), reply.getInt("end"), items).takeIf { items.isNotEmpty() }
    }
}


@Composable
internal fun rememberMarkdownAssist(model: InboxViewModel, pairs: Boolean, taskId: String?): MarkdownAssist {
    val assist = remember(model, pairs, taskId) { MarkdownAssist(model, pairs, taskId) }
    DisposableEffect(assist) { onDispose { assist.close() } }
    return assist
}


@Composable
internal fun MarkdownReferenceList(assist: MarkdownAssist, field: TextFieldValue, focused: Boolean, apply: (TextFieldValue) -> Unit) {
    val shown = assist.references?.takeIf { focused && it.text == field.text && it.selection == field.selection } ?: return
    val c = LocalTheme.current.colors
    val focusManager = LocalFocusManager.current
    val density = LocalDensity.current
    val view = LocalView.current
    val frame = android.graphics.Rect().also { view.getWindowVisibleDisplayFrame(it) }
    val windowTop = IntArray(2).also { view.rootView.getLocationOnScreen(it) }[1]
    val gap = with(density) { 8.dp.roundToPx() }
    val (lineTop, lineBottom) = assist.lineInWindow(field.selection.start) ?: (frame.top - windowTop to frame.top - windowTop)
    val wanted = with(density) { minOf(320.dp, 20.dp + 60.dp * shown.items.size).roundToPx() }
    val card = referenceCard(lineTop, lineBottom, frame.top - windowTop + gap, frame.bottom - windowTop - gap, gap, wanted)
    val bottom = frame.bottom - windowTop - gap
    val position = remember(card, lineTop, bottom, gap) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize) =
                IntOffset((windowSize.width - popupContentSize.width) / 2,
                    if (card.below) bottom - popupContentSize.height else lineTop - gap - popupContentSize.height)
        }
    }
    Popup(position, onDismissRequest = { focusManager.clearFocus() }, properties = PopupProperties(focusable = false)) {
        val shape = RoundedCornerShape(18.dp)
        Column(Modifier.padding(horizontal = 12.dp).fillMaxWidth().heightIn(max = with(density) { card.maxHeight.toDp() }).shadow(12.dp, shape).clip(shape).background(c.cardBg)
            .border(Dp.Hairline, c.border, shape).semantics { testTagsAsResourceId = true }.testTag("markdown-reference-suggestions")) {
            Box(Modifier.padding(top = 10.dp, bottom = 6.dp).align(Alignment.CenterHorizontally).size(36.dp, 4.dp).clip(RoundedCornerShape(999.dp)).background(c.border))
            Column(Modifier.verticalScroll(rememberScrollState())) {
                shown.items.forEachIndexed { index, item ->
                    Column(Modifier.fillMaxWidth().clickable { assist.choose(item, apply) }
                        .then(if (index < shown.items.lastIndex) Modifier.rnBorderBottom(c.border) else Modifier)
                        .padding(horizontal = 14.dp, vertical = 10.dp).testTag("markdown-reference-${item.id}")) {
                        Text(item.title, style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(item.meta, style = rnText(12, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
    }
}


@Composable
internal fun MarkdownInput(draft: MarkdownDraft, store: (String) -> Unit, enabled: Boolean, placeholder: String, description: String, style: TextStyle,
                           modifier: Modifier, decoration: @Composable (@Composable () -> Unit) -> Unit, onBlur: () -> Unit = {}, assist: MarkdownAssist? = null) {
    val c = LocalTheme.current.colors
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(draft, enabled) { if (enabled) { draft.focus.requestFocus(); keyboard?.show() } }
    assist?.let { MarkdownReferenceList(it, draft.field, draft.focused) { next -> draft.change(next, store) } }
    BasicTextField(draft.field, { typed ->
        val before = draft.field
        draft.change(typed, store)
        assist?.changed(before, typed, { draft.field }) { next -> draft.rewrite(next, store) }
    }, enabled = enabled, textStyle = style, cursorBrush = SolidColor(c.tint), onTextLayout = { assist?.textLayout?.invoke(it) },
        modifier = modifier.focusRequester(draft.focus).semantics { contentDescription = description }.onFocusChanged {
            if (draft.focused && !it.isFocused) onBlur()
            draft.focused = it.isFocused
        },
        decorationBox = { field -> decoration { Box(assist?.textBox ?: Modifier) { if (draft.field.text.isEmpty()) Text(placeholder, style = style, color = c.secondaryText); field() } } })
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MarkdownToolbar(model: InboxViewModel, draft: MarkdownDraft, store: (String) -> Unit) {
    var actions by remember { mutableStateOf<List<MarkdownAction>?>(null) }
    var undoLabel by remember { mutableStateOf("") }

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


@Composable
private fun ToolbarButton(label: String, size: Int, enabled: Boolean, onClick: () -> Unit, content: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    Box(Modifier.size(size.dp).clip(RoundedCornerShape(7.dp)).background(if (pressed) c.filterBg else c.bg.copy(alpha = 0f))
        .clickable(press, null, enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .then(if (enabled) Modifier else Modifier.fade(0.35f)), contentAlignment = Alignment.Center) { content() }
}
