package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject


@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ContextsList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    val bulk = view.optJSONObject("bulk")
    val selected = view.optJSONArray("selectedIds").ids()

    BackHandler(enabled = bulk != null && dialog == null && model.failedAction == null) { endSelection(); reload() }
    LazyColumn(Modifier.fillMaxSize().testTag("contexts-list"), contentPadding = PaddingValues(bottom = 16.dp)) {
        item(key = "search") {
            Row(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).padding(12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                ListSearchField(own("contexts").optString("searchQuery"), view.getString("searchPlaceholder"), Modifier.weight(1f)) {
                    typeSearch("contexts", "searchQuery", it)
                }

                view.optJSONObject("sort")?.let { sort ->
                    DirectControl(Lucide.ArrowUpDown, sort.getString("accessibilityLabel"), null, null, idle) { openDialog("sort") }
                }
                DirectControl(Lucide.Filter, t("filters.label"), null, null, idle) { openDialog("filters"); reload() }
                if (view.optBoolean("canSave")) {
                    DirectControl(Lucide.Plus, t("common.save"), null, null, idle) { openContextsSave() }
                }
            }
        }
        val savedFilters = view.optJSONObject("savedFilters")?.menuObjects("items").orEmpty()
        if (savedFilters.isNotEmpty()) item(key = "saved-filters") {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (filter in savedFilters) {
                    val on = filter.optBoolean("selected")
                    SheetChip(filter.getString("name"), on, excluded = false, enabled = idle) {
                        selectContextsSavedFilter(if (on) null else filter.getString("id"))
                    }
                }
            }
        }
        item(key = "chips") {
            Column(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).padding(top = 4.dp, bottom = 6.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    for (chip in view.menuObjects("chips")) {
                        val on = chip.getBoolean("selected")
                        val count = chip.getInt("count")
                        val shape = RoundedCornerShape(16.dp)


                        val additive = chip.optJSONObject("additive")
                        Row(Modifier.heightIn(min = 44.dp).clip(shape).background(if (on) c.tint else c.filterBg).rnBorder(1.dp, c.border, shape)
                            .combinedClickable(enabled = idle, role = Role.Button, onLongClickLabel = additive?.optString("label"),
                                onLongClick = additive?.let { { contextsChip(it.getJSONObject("next")) } }) { contextsChip(chip.getJSONObject("next")) }
                            .semantics { contentDescription = chip.getString("accessibilityLabel"); this.selected = on }.padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(chip.getString("label"), style = rnText(13, 500), color = if (on) c.onTint else c.text)
                            Box(Modifier.widthIn(min = 18.dp).clip(RoundedCornerShape(8.dp)).background(if (on) c.cardBg else theme.chipBadge)
                                .padding(horizontal = 5.dp, vertical = 1.dp), contentAlignment = Alignment.Center) {
                                Text("$count", style = rnText(10, 600), color = if (on) c.text else c.secondaryText)
                            }
                        }
                    }
                }
                view.optJSONObject("matchMode")?.let { mode ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(mode.getString("label"), style = rnText(11, 600), color = c.secondaryText)
                        val control = RoundedCornerShape(8.dp)
                        Row(Modifier.clip(control).background(c.filterBg).rnBorder(1.dp, c.border, control).padding(2.dp)) {
                            for (option in mode.menuObjects("options")) {
                                val on = option.getBoolean("selected")
                                val label = option.getString("label")
                                Text(label, style = rnText(12, 600), color = if (on) c.onTint else c.text, textAlign = TextAlign.Center,
                                    modifier = Modifier.widthIn(min = 52.dp).clip(RoundedCornerShape(6.dp)).then(if (on) Modifier.background(c.tint) else Modifier)
                                        .selectable(selected = on, enabled = idle, role = Role.RadioButton) { contextsMatchMode(option.getString("mode")) }
                                        .padding(horizontal = 12.dp, vertical = 6.dp))
                            }
                        }
                    }
                }
            }
        }
        bulk?.let { bar -> item(key = "bulk") { ContextsBulkBar(model, bar, selected, view.optJSONObject("taskRevisions") ?: JSONObject()) } }
        if (shown.items.isEmpty()) view.optJSONObject("empty")?.let { empty ->
            item(key = "empty") {
                IconEmptyState(if (empty.getString("icon") == "tag") Lucide.TagThin else Lucide.CheckCircle2Thin, empty.getString("title"), empty.getString("message"))
            }
        }
        items(shown.items, key = { it.key }) { item ->
            val row = item.row ?: return@items
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = if (item === shown.items.first()) 16.dp else 0.dp)) {
                TaskRowItem(model, row, status = RowStatus.Badge, actions = RowActions(
                    status = { status -> act("contextsAction", setTaskStatus(row.id, status, row.taskRevision)) },
                    delete = { act("contextsAction", trashTask(row.id, row.taskRevision)) },
                    selecting = bulk != null, selected = row.id in selected, select = { toggleRow("contexts", row.id) },
                ))
            }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ContextsBulkBar(model: InboxViewModel, bulk: JSONObject, selected: List<String>, revisions: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val any = idle && selected.isNotEmpty()
    Column(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(bulk.getString("countLabel"), style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.weight(1f))
            BulkExitButton(bulk.getString("exitLabel"), idle) { endSelection(); reload() }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (status in bulk.menuObjects("statuses")) {
                BarButton(status.getString("label"), any, c.filterBg, c.text, weight = 500) { act("contextsAction", moveTasks(selected, status.getString("status"), revisions)) }
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (token in bulk.menuObjects("tokenActions")) {
                BarButton(token.getString("title"), any && token.getBoolean("enabled"), c.filterBg, c.text) {
                    keepDialog(JSONObject().put("kind", "tokens").put("list", "contexts").put("field", token.getString("field"))
                        .put("mode", token.getString("mode")).put("text", "").put("picked", JSONArray()))
                }
            }
            BarButton(bulk.getString("deleteLabel"), any, c.filterBg, c.text) {
                confirm(bulk.getJSONObject("deleteConfirmation"), trashTasks(selected, revisions), "contextsAction")
            }
        }
    }
}


@Composable
fun ListSearchField(value: String, placeholder: String, modifier: Modifier, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, onChange, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), modifier = modifier.semantics { contentDescription = placeholder }.testTag("list-search"),
        decorationBox = { inner ->
            Box(Modifier.height(40.dp).clip(shape).background(c.inputBg).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                inner()
            }
        })
}


internal fun MenuModel.contextsChip(next: JSONObject) {
    editOwn("contexts") { put("tokens", next.getJSONArray("tokens")).put("matchMode", next.getString("matchMode")) }
    reload()
}


internal fun MenuModel.contextsMatchMode(mode: String) {
    editOwn("contexts") { put("matchMode", mode) }
    reload()
}


internal fun MenuModel.toggleRow(list: String, id: String) {
    val picked = own(list).optJSONArray("selected").ids()
    editOwn(list) { put("selected", JSONArray(if (id in picked) picked - id else picked + id)) }
    reload()
}


private fun MenuModel.tokenPicker(open: JSONObject): JSONObject? {
    if (open.optString("list") == "bulk") {
        val bar = page?.bulk ?: return null
        val remove = bar.optJSONObject("removeTag") ?: return null
        val tokens = JSONArray().apply { for (item in bar.optJSONObject("picker")?.menuObjects("items").orEmpty()) put(item.getString("value")) }
        return JSONObject().put("title", remove.getString("title")).put("placeholder", remove.getString("placeholder"))
            .put("tokens", tokens).put("allowCustomValue", false).put("multiSelect", true)
    }
    val bulk = page?.view?.optJSONObject("bulk") ?: return null
    val review = open.optString("list") == "review"

    val found = bulk.optJSONObject("picker")?.takeIf { picker ->
        tokenQuery(open) != null && if (review) picker.optString("kind") == "removeTag"
            else picker.optString("field") == open.optString("field") && picker.optString("mode") == open.optString("mode")
    }?.getJSONArray("items")?.let { items -> JSONArray().apply { for (index in 0 until items.length()) put(items.optJSONObject(index)?.getString("value") ?: items.getString(index)) } }
    if (review) {
        val remove = bulk.getJSONObject("removeTag")
        return JSONObject().put("title", remove.getString("title")).put("placeholder", remove.getString("placeholder"))
            .put("tokens", found ?: remove.getJSONArray("tags")).put("allowCustomValue", false).put("multiSelect", true)
    }
    return bulk.menuObjects("tokenActions").firstOrNull { it.getString("field") == open.getString("field") && it.getString("mode") == open.getString("mode") }
        ?.let { action -> found?.let { JSONObject(action.toString()).put("tokens", it) } ?: action }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TokenPicker(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val picker = tokenPicker(open) ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val multi = picker.getBoolean("multiSelect")
    val custom = picker.getBoolean("allowCustomValue")
    val text = open.optString("text")
    val picked = open.optJSONArray("picked").ids()
    val values = if (multi) picked else listOfNotNull((picked.firstOrNull() ?: text.trim().takeIf { custom }).takeUnless { it.isNullOrBlank() })
    val canSave = values.isNotEmpty() && idle
    val review = open.optString("list") == "review"
    val save = {

        val selection = page?.view?.takeIf { it.has("selectedIds") } ?: page?.view?.optJSONObject("bulk")
        val ids = selection?.optJSONArray("selectedIds").ids()
        val revisions = selection?.optJSONObject("taskRevisions") ?: JSONObject()
        keepDialog(null)
        when {

            open.optString("list") == "bulk" -> bulkAction(JSONObject().put("type", "editTaskTokens").put("field", "tags").put("mode", "remove").put("values", JSONArray(values)), "removeTag")
            review -> act("reviewAction", removeTags(ids, values, revisions))
            else -> act("contextsAction", editTaskTokens(ids, open.getString("field"), open.getString("mode"), values, revisions))
        }
    }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { keepDialog(null) }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(18.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val title = picker.getString("title")
            Text(title, style = rnText(18, 700), color = c.text, modifier = Modifier.semantics { heading() })
            Text(title, style = rnText(13, 400, 18), color = c.secondaryText)

            run {
                val focus = remember { FocusRequester() }
                LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
                val field = RoundedCornerShape(12.dp)
                BasicTextField(text, { typed -> typeToken(JSONObject(open.toString()).put("text", typed).apply { if (!multi && picked.firstOrNull() != typed) put("picked", JSONArray()) }) },
                    singleLine = true, textStyle = rnText(15, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = picker.getString("placeholder") }.testTag("menu-dialog-field"),
                    decorationBox = { inner ->
                        Box(Modifier.heightIn(min = 44.dp).clip(field).background(c.inputBg).rnBorder(1.dp, c.border, field).padding(horizontal = 14.dp, vertical = 10.dp),
                            contentAlignment = Alignment.CenterStart) {
                            if (text.isEmpty()) Text(picker.getString("placeholder"), style = rnText(15, 400), color = c.secondaryText)
                            inner()
                        }
                    })
            }
            val list = RoundedCornerShape(14.dp)
            val tokens = picker.optJSONArray("tokens").ids()
            Box(Modifier.testTag("token-picker-list").fillMaxWidth().heightIn(max = 240.dp).clip(list).background(c.bg).rnBorder(1.dp, c.border, list)
                .verticalScroll(rememberScrollState()).padding(12.dp)) {
                if (tokens.isEmpty()) Text(t("common.noMatches"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (token in tokens) {
                        val on = token in picked
                        Text(token, style = rnText(13, 600), color = if (on) c.onTint else c.text, modifier = Modifier.clip(CircleShape)
                            .background(if (on) c.tint else c.filterBg).rnBorder(1.dp, if (on) c.tint else c.border, CircleShape)
                            .selectable(selected = on, role = Role.Button) {

                                if (multi) keepDialog(JSONObject(open.toString()).put("picked", JSONArray(if (on) picked - token else picked + token)))
                                else typeToken(JSONObject(open.toString()).put("picked", JSONArray(listOf(token))).put("text", token))
                            }.padding(horizontal = 12.dp, vertical = 8.dp))
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                Text(t("common.cancel"), style = rnText(15, 600), color = c.secondaryText, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { keepDialog(null) }.padding(horizontal = 4.dp, vertical = 12.dp))
                Text(t("common.save"), style = rnText(15, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(enabled = canSave, role = Role.Button) { save() }.fade(if (canSave) 1f else 0.45f).padding(horizontal = 4.dp, vertical = 12.dp))
            }
        }
    }
}
