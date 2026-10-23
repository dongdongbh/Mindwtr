package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
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

/*
 * RN's selection mode on the Inbox, Waiting, Someday, Reference and Done (task-list/TaskListBulkBar.tsx, TaskListTagModal.tsx,
 * TaskListBulkOrganizeModal.tsx and TaskListBulkDateField.tsx) on core's bulk contract (native-host-contract-bulk-actions.ts):
 * the bar over the list, the Add tag dialog, and Bulk Organize. Every count, label, enabled state and edit is core's
 * getBulkActions reply (MenuPage.bulk); every write is core's runBulkAction through MenuModel.bulkAction.
 */

/**
 * RN's bulk bar: core's count (with the running action's label and a spinner), the exit button, core's statuses to move to,
 * then Move to section (Someday), Bulk organize (the Inbox), Range, Add tag, Remove tag and Delete, each enabled as core says.
 * Core's stateless Select all leads the actions (RN's TaskList has none; the contract offers it, as Archive's bar does).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BulkBar(model: InboxViewModel) = with(model.menu) {
    // Review draws its own bar (ReviewScreen.kt); its page carries core's bar only for the Organize dialog.
    val bulk = page?.bulk?.takeIf { list in BULK_LISTS } ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val bar = bulk.getJSONObject("bar")
    val labels = bulk.getJSONObject("labels")
    // While a command runs or a retry is owed the bar's controls wait; core's own enabled rules apply on top.
    val enabled = { control: JSONObject -> idle && control.getBoolean("enabled") }
    Column(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(bar.getString("countLabel"), style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.weight(1f))
            bulkBusy?.takeIf { model.busy }?.let { running ->
                val busyLabels = labels.getJSONObject("busy")
                CircularProgressIndicator(Modifier.size(16.dp), color = c.tint, strokeWidth = 2.dp)
                Text(busyLabels.optString(running, bar.getString("busyLabel")), style = rnText(11, 500), color = c.secondaryText)
            }
            val exit = bar.getJSONObject("exit")
            BulkExitButton(exit.getString("accessibilityLabel"), exit.getBoolean("enabled") && !model.busy) { list?.let(::endBulk) }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (option in bar.menuObjects("statuses")) {
                BarButton(option.getString("label"), enabled(option), c.filterBg, c.text, option.getString("accessibilityLabel"), weight = 500) {
                    bulkAction(JSONObject().put("type", "moveTasks").put("status", option.getString("status")), "move")
                }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val all = bulk.getInt("selectableCount")
            BarButton(labels.getString("selectAll"), idle && all > 0 && bulk.getInt("selectedCount") < all, c.filterBg, c.text) { bulkSelectAll() }
            bar.optJSONObject("moveToSection")?.let { move ->
                BarButton(move.getString("label"), enabled(move), c.filterBg, c.text) {
                    bulk.optJSONObject("moveToSection")?.let { openMove(it.getJSONArray("taskIds").ids(), it.getJSONObject("taskRevisions")) }
                }
            }
            bar.optJSONObject("organize")?.let { organize ->
                BarButton(organize.getString("label"), enabled(organize), theme.filledBg, theme.filledText, icon = Lucide.ClipboardCheck) { openOrganize() }
            }
            val range = bar.getJSONObject("range")
            val active = range.getBoolean("active")
            BarButton(range.getString("label"), enabled(range), if (active) c.tint else c.filterBg, if (active) c.onTint else c.text, selected = active) { bulkRange() }
            val addTag = bar.getJSONObject("addTag")
            BarButton(addTag.getString("label"), enabled(addTag), c.filterBg, c.text) { keepDialog(JSONObject().put("kind", "bulkTag").put("text", "")) }
            bar.optJSONObject("removeTag")?.let { remove -> BarButton(remove.getString("label"), enabled(remove), c.filterBg, c.text) { openRemoveTag() } }
            val delete = bar.getJSONObject("delete")
            BarButton(delete.getString("label"), enabled(delete), c.filterBg, c.text) { bulkDelete() }
        }
    }
}

/** RN's bulk bar exit (bulkExitButton): a 32 circle with Lucide X at 16, named [label] (core's bulk.exitSelect); dimmed while off. */
@Composable
internal fun BulkExitButton(label: String, enabled: Boolean, onExit: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.fade(if (enabled) 1f else 0.5f).size(32.dp).clip(CircleShape).background(c.filterBg)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { onExit(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onExit), contentAlignment = Alignment.Center) {
        Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
    }
}

/** One of the bar's buttons (RN's bulkMoveButton and bulkActionButton): one node with its label, role and state; dimmed while off. */
@Composable
internal fun BarButton(label: String, enabled: Boolean, background: Color, color: Color, description: String = label, selected: Boolean? = null,
                      weight: Int = 600, icon: ImageVector? = null, action: () -> Unit) {
    Row(Modifier.fade(if (enabled) 1f else 0.5f).clip(RoundedCornerShape(6.dp)).background(background)
        .clearAndSetSemantics {
            contentDescription = description; role = Role.Button
            selected?.let { this.selected = it }
            if (enabled) onClick { action(); true } else disabled()
        }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        icon?.let { Icon(it, null, tint = color, modifier = Modifier.size(14.dp)) }
        Text(label, style = rnText(12, weight), color = color)
    }
}

/**
 * RN's Add tag dialog (TaskListTagModal): core's title, the field with core's placeholder, Cancel and Save (off until something
 * is typed). Save sends core's editTaskTokens with the typed tag; core adds its # and writes only the rows it changes.
 */
@Composable
fun AddTagDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val text = page?.bulk?.getJSONObject("addTag") ?: return
    val c = LocalTheme.current.colors
    val typed = open.optString("text")
    val canSave = idle && typed.isNotBlank()
    ModalCard(model) {
        Text(text.getString("title"), style = rnText(16, 700), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().semantics { heading() })
        ModalInput(typed, text.getString("placeholder"), text.getString("placeholder")) { keepDialog(JSONObject(open.toString()).put("text", it)) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
            TextAction(text.getString("cancelLabel"), c.secondaryText, true) { keepDialog(null) }
            TextAction(text.getString("saveLabel"), c.tint, canSave) {
                bulkAction(JSONObject().put("type", "editTaskTokens").put("field", "tags").put("mode", "add").put("values", JSONArray(listOf(typed))), "addTag")
            }
        }
    }
}

/** RN's modal card (task-list.styles modalOverlay and modalCard): a dimmed screen and a centered card; the backdrop closes it. */
@Composable
private fun ModalCard(model: InboxViewModel, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { model.menu.keepDialog(null) }
        .semantics { contentDescription = close }.imePadding().padding(20.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(theme.colors.cardBg)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
    }
}

@Composable
private fun TextAction(label: String, color: Color, enabled: Boolean, action: () -> Unit) {
    Text(label, style = rnText(14, 600), color = color, modifier = Modifier.heightIn(min = 44.dp)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).fade(if (enabled) 1f else 0.5f).padding(horizontal = 12.dp, vertical = 12.dp))
}

/** RN's modal input: bordered, radius 8, the input background; [value] as typed; [onDone] is the keyboard's Done (RN's onSubmitEditing). */
@Composable
private fun ModalInput(value: String, placeholder: String, description: String, modifier: Modifier = Modifier, enabled: Boolean = true, onDone: (() -> Unit)? = null,
                       onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, onChange, enabled = enabled, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = onDone?.let { done -> KeyboardActions(onDone = { done() }) } ?: KeyboardActions.Default,
        modifier = modifier.fillMaxWidth().semantics { contentDescription = description },
        decorationBox = { inner ->
            Box(Modifier.heightIn(min = 42.dp).clip(shape).background(c.inputBg).border(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(14, 400), color = c.secondaryText)
                inner()
            }
        })
}

/**
 * RN's Bulk organize (TaskListBulkOrganizeModal): core's title and subtitle, then Status (core's chips), Project and Area (core's
 * pickers, Keep and None first), the person for Waiting, Start, Due and Review (typed as a local day, the calendar from core's
 * start, core's Today and Tomorrow), Contexts and Tags, core's validation line, Cancel and Apply. Every control sends core's
 * edit (typed text core's setText) and shows the draft core answered. The project and area pickers can create one (core's "+ Create").
 */
@Composable
fun OrganizeDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val organize = page?.bulk?.optJSONObject("organize") ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val locked = !idle
    val close = organize.getString("closeLabel")
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { if (!model.busy) keepDialog(null) }
        .semantics { contentDescription = close }.imePadding().padding(20.dp), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.86f).dp).clip(shape)
            .background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Lucide.ClipboardCheck, null, tint = c.tint, modifier = Modifier.size(18.dp))
                Column(Modifier.weight(1f)) {
                    Text(organize.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.semantics { heading() })
                    Text(organize.getString("subtitle"), style = rnText(12, 400, 16), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                }
                Box(Modifier.size(32.dp).clearAndSetSemantics { contentDescription = close; role = Role.Button; if (!model.busy) onClick { keepDialog(null); true } else disabled() }
                    .clickable(enabled = !model.busy) { keepDialog(null) }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
                }
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 14.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Section(organize.getString("statusLabel")) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (status in organize.menuObjects("statuses")) OrganizeChip(status.getString("label"), status.getBoolean("selected"), !locked) {
                            organizeEdit(status.getJSONObject("edit"))
                        }
                    }
                }
                for (name in listOf("project", "area")) {
                    val picker = organize.getJSONObject(name)
                    Section(picker.getString("label")) {
                        PickerRow(picker.getString("accessibilityLabel"), picker.getString("value"), !locked && !picker.optBoolean("disabled")) { organizePicker(name) }
                    }
                }
                organize.optJSONObject("waitingFor")?.let { person ->
                    Section(person.getString("label")) {
                        ModalInput(open.optString("typed:delegateWho", person.getString("value")), person.getString("placeholder"), person.getString("label")) {
                            organizeType("delegateWho", it)
                        }
                    }
                }
                for (date in organize.menuObjects("dates")) DateField(model, open, date, locked)
                for (name in listOf("contexts", "tags")) {
                    val tokens = organize.getJSONObject(name)
                    Section(tokens.getString("label")) {
                        ModalInput(open.optString("typed:$name", tokens.getString("value")), tokens.getString("placeholder"), tokens.getString("label")) { organizeType(name, it) }
                    }
                }
                if (open.optBoolean("validation")) Text(organize.getString("validationMessage"), style = rnText(12, 600), color = c.danger,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
            }
            Row(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically) {
                val cancel = organize.getString("cancelLabel")
                Text(cancel, style = rnText(14, 700), color = c.secondaryText, modifier = Modifier.heightIn(min = 40.dp)
                    .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; if (!model.busy) onClick { keepDialog(null); true } else disabled() }
                    .clickable(enabled = !model.busy) { keepDialog(null) }.padding(horizontal = 12.dp, vertical = 10.dp))
                val apply = organize.getString("applyLabel")
                // The lists' bar counts the selection (Select all included); Review's lists its selected ids.
                val canApply = !locked && (page?.bulk?.let { it.optInt("selectedCount", it.optJSONArray("selectedIds")?.length() ?: 0) } ?: 0) > 0
                Row(Modifier.fade(if (canApply) 1f else 0.6f).heightIn(min = 40.dp).clip(RoundedCornerShape(8.dp)).background(theme.filledBg)
                    .clearAndSetSemantics { contentDescription = apply; role = Role.Button; if (canApply) onClick { organizeApply(); true } else disabled() }
                    .clickable(enabled = canApply) { organizeApply() }.padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (model.busy && bulkBusy == "organize") CircularProgressIndicator(Modifier.size(16.dp), color = theme.filledText, strokeWidth = 2.dp)
                    Text(apply, style = rnText(14, 700), color = theme.filledText)
                }
            }
        }
        open.menuText("picker")?.let { OrganizePicker(model, open, it) }
        open.menuText("datePicker")?.let { field ->
            organize.menuObjects("dates").firstOrNull { it.getString("field") == field }?.let { date ->
                DayPickerDialog(date.getString("pickerStart"), { dialog?.let { keepDialog(JSONObject(it.toString()).apply { remove("datePicker") }) } }) { day ->
                    organizeDate(field, JSONObject().put("type", "setText").put("field", field).put("value", day))
                }
            }
        }
    }
}

@Composable
private fun Section(label: String, content: @Composable () -> Unit) = Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(label.uppercase(), style = rnText(12, 700), color = LocalTheme.current.colors.secondaryText)
    content()
}

/** RN's bulkOrganizeChip: a 34-high pill, the tint when chosen. */
@Composable
private fun OrganizeChip(label: String, selected: Boolean, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.fade(if (enabled) 1f else 0.45f).heightIn(min = 34.dp).clip(CircleShape).background(if (selected) c.tint else c.filterBg).border(1.dp, if (selected) c.tint else c.border, CircleShape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 12.dp, vertical = 7.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(12, 700), color = if (selected) c.onTint else c.text)
    }
}

/** RN's picker row: core's value and a chevron, core's "label: value" for TalkBack; dimmed while off (Area under a chosen project). */
@Composable
private fun PickerRow(description: String, value: String, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.fade(if (enabled) 1f else 0.5f).fillMaxWidth().heightIn(min = 42.dp).clip(shape).background(c.inputBg).border(1.dp, c.border, shape)
        .clearAndSetSemantics { contentDescription = description; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(value, style = rnText(14, 600), color = if (enabled) c.text else c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
    }
}

/**
 * RN's bulk date field (TaskListBulkDateField): core's label, the field (core's date in the user's format until it is typed in;
 * a typed day goes to core as typed), the calendar (core's start), and core's Today and Tomorrow (the chosen one clears it).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DateField(model: InboxViewModel, open: JSONObject, date: JSONObject, locked: Boolean) = with(model.menu) {
    val c = LocalTheme.current.colors
    val field = date.getString("field")
    val label = date.getString("label")
    var editing by remember(field) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label.uppercase(), style = rnText(12, 700), color = c.secondaryText)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val shown = open.menuText("typed:$field") ?: date.getString(if (editing) "value" else "displayValue")
            ModalInput(shown, date.getString("placeholder"), label, Modifier.weight(1f).onFocusChanged { editing = it.isFocused }) { organizeType(field, it) }
            val calendar = date.getString("calendarAccessibilityLabel")
            val shape = RoundedCornerShape(8.dp)
            val openCalendar = { keepDialog(JSONObject(open.toString()).put("datePicker", field)) }
            Box(Modifier.size(44.dp).clip(shape).background(c.inputBg).border(1.dp, c.border, shape)
                .clearAndSetSemantics { contentDescription = calendar; role = Role.Button; if (!locked) onClick { openCalendar(); true } else disabled() }
                .clickable(enabled = !locked) { openCalendar() }, contentAlignment = Alignment.Center) {
                Icon(Lucide.Calendar, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (chip in date.menuObjects("quickDates")) {
                val on = chip.getBoolean("selected")
                val spoken = chip.getString("accessibilityLabel")
                val pick = { organizeDate(field, chip.getJSONObject("edit")) }
                Box(Modifier.widthIn(min = 44.dp).heightIn(min = 44.dp).clip(CircleShape).background(if (on) c.tint else c.filterBg).border(1.dp, if (on) c.tint else c.border, CircleShape)
                    .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; selected = on; if (!locked) onClick { pick(); true } else disabled() }
                    .clickable(enabled = !locked) { pick() }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                    Text(chip.getString("label"), style = rnText(12, 600), color = if (on) c.onTint else c.text)
                }
            }
        }
    }
}

/**
 * Bulk Organize's project or area picker ([kind]): the search box, then core's choices (Keep and None first, whatever the
 * search), the chosen one checked. A choice sends its edit and returns to the dialog. For a search no option names, core's "+ Create"
 * row makes the project or area (core's createBulkOrganizeDestination, on disk first) and returns to the dialog with it chosen; the
 * keyboard's Done runs core's `submit` (the match, or the create). A create that failed shows core's line; while its retry is owed,
 * the search is locked and the row sends that exact request again.
 */
@Composable
private fun OrganizePicker(model: InboxViewModel, open: JSONObject, kind: String) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val picker = page?.bulk?.optJSONObject("picker")?.takeIf { it.getString("kind") == kind }
    val organize = page?.bulk?.optJSONObject("organize") ?: return
    val title = organize.getJSONObject(kind).getString("label")
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { organizePicker(null) }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(14.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.8f).dp).clip(shape)
            .background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = rnText(17, 700), color = c.text, modifier = Modifier.semantics { heading() })
            val owed = model.failedAction?.takeIf { it.kind == "bulkCreate" }
            ModalInput(open.optString("query"), t("common.search"), "${t("common.search")} $title", Modifier.testTag("organize-picker-search"), enabled = owed == null,
                onDone = { if (idle) organizeSubmit() }) { organizeQuery(it) }
            picker?.optJSONObject("create")?.let { create ->
                val label = create.getString("label")
                val spoken = create.getString("accessibilityLabel")
                val canCreate = (idle || (owed != null && !model.busy))
                val make = { organizeCreate(create.getString("name")) }
                Box(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = "organize-create"; if (canCreate) onClick { make(); true } else disabled() }
                    .clickable(enabled = canCreate) { make() }.padding(horizontal = 4.dp, vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                    if (model.busy && open.optBoolean("creating")) CircularProgressIndicator(Modifier.size(18.dp), color = c.tint, strokeWidth = 2.dp)
                    else Text(label, style = rnText(15, 400), color = c.tint, maxLines = 2)
                }
            }
            if (open.optBoolean("createFailed") || owed != null) {
                Text(organize.getJSONObject("createFailed").getString(kind), style = rnText(15, 400), color = c.danger,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }.testTag("organize-create-failed"))
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                for (item in picker?.menuObjects("items").orEmpty()) {
                    val on = item.getBoolean("selected")
                    val label = item.getString("label")
                    val choose = { organizePicker(null); item.optJSONObject("edit")?.let { organizeEdit(it) } }
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).hairline(c.border, top = false)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (idle) onClick { choose(); true } else disabled() }
                        .clickable(enabled = idle) { choose() }.padding(horizontal = 4.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(label, style = rnText(15, 400), color = c.text, maxLines = 2, modifier = Modifier.weight(1f))
                        if (on) Icon(Lucide.Check, null, tint = c.tint, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Text(t("common.cancel"), style = rnText(15, 400), color = c.secondaryText, modifier = Modifier.align(Alignment.End).heightIn(min = 44.dp)
                .clickable(role = Role.Button) { organizePicker(null) }.padding(horizontal = 12.dp, vertical = 12.dp))
        }
    }
}
