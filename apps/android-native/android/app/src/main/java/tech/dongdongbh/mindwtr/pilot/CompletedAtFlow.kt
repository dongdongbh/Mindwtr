package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject


class CompletedAtModel(private val shell: InboxViewModel) {

    var open by mutableStateOf<JSONObject?>(null); private set

    var minutes by mutableStateOf(""); private set


    fun open(task: TaskRow, mode: String) = start(JSONObject().put("taskId", task.id).put("mode", mode))


    fun openEditor() {
        val editor = shell.editor ?: return
        val draft = JSONObject().put("completedAt", editor.text("completedAt").ifEmpty { null } ?: JSONObject.NULL)
            .put("timeSpentMinutes", (editor.value("timeSpentMinutes") as? Number) ?: JSONObject.NULL)
        start(JSONObject().put("taskId", editor.id).put("mode", "editor").put("draft", draft))
    }

    private fun start(input: JSONObject) {
        if (open != null) return
        shell.background(emptyList(), { runtime -> runtime.menuRead("completedAtPicker", input.toString()) }) { reply, _ ->
            val picker = reply.optJSONObject("picker") ?: return@background
            minutes = picker.optJSONObject("timeSpent")?.optString("value").orEmpty()
            open = picker.put("step", "date")
        }
    }

    fun close() { open = null; minutes = "" }

    fun pickDay(day: String) { open = open?.let { JSONObject(it.toString()).put("day", day).put("step", "time") } }


    fun pickTime(time: String) {
        val current = open?.let { JSONObject(it.toString()).put("time", time) } ?: return
        if (current.optJSONObject("timeSpent") == null) { open = current; save(); return }
        open = current.put("step", "details").put("label", "")
        shell.background(emptyList(), { runtime ->
            runtime.menuRead("pickedCompletedAtLabel", JSONObject().put("day", current.getString("day")).put("time", time).toString())
        }) { reply, _ -> open?.takeIf { it.optString("step") == "details" }?.let { open = JSONObject(it.toString()).put("label", reply.optString("label")) } }
    }

    fun type(text: String) { minutes = text.filter { it.isDigit() } }


    fun save() {
        val current = open ?: return
        val details = current.optString("step") == "details"
        val typed = minutes
        close()
        if (current.getString("mode") == "editor") {

            if (shell.editor?.id != current.getString("taskId")) return
            val edit = JSONObject().put("type", "backdatedCompletion").put("day", current.getString("day")).put("time", current.getString("time"))
            if (details) edit.put("timeSpentText", typed)
            shell.editDraft(edit)
            return
        }
        val input = JSONObject().put("taskId", current.getString("taskId")).put("taskRevision", current.getString("taskRevision"))
            .put("mode", current.getString("mode")).put("day", current.getString("day")).put("time", current.getString("time"))
        if (details) input.put("timeSpentText", typed)
        shell.menu.command("taskCompletedAt", input)
    }
}


@Composable
fun CompletedAtFlow(model: InboxViewModel) {
    val flow = model.completedAt
    val open = flow.open ?: return
    when (open.optString("step")) {

        "date" -> DayPickerDialog(open.getString("day"), { if (flow.open?.optString("step") == "date") flow.close() }) { flow.pickDay(it) }
        "time" -> {
            val (hour, minute) = pickerClock(open.getString("time"))
            ClockPickerDialog(hour, minute, { if (flow.open?.optString("step") == "time") flow.close() }) { flow.pickTime(it) }
        }
        "details" -> TimeSpentCard(flow, open)
    }
}


@Composable
private fun TimeSpentCard(flow: CompletedAtModel, open: JSONObject) {
    val theme = LocalTheme.current
    val c = theme.colors
    val words = open.getJSONObject("timeSpent")
    BackHandler { flow.close() }
    Box(Modifier.fillMaxSize().imePadding().background(theme.menuScrim).semantics { testTagsAsResourceId = true }
        .pointerInput(Unit) { detectTapGestures { flow.close() } }.padding(24.dp), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("completed-at-card")) {
            Text(words.getString("title"), style = rnText(16, 600), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).semantics { heading() })
            Text(open.optString("label"), style = rnText(15, 400), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp))
            Text(words.getString("label"), style = rnText(13, 500), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
            val field = RoundedCornerShape(8.dp)
            BasicTextField(flow.minutes, flow::type, singleLine = true, cursorBrush = SolidColor(c.tint), textStyle = rnText(16, 400).copy(color = c.text),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth().clip(field).background(c.inputBg).rnBorder(1.dp, c.border, field)
                    .semantics { contentDescription = words.getString("label") }.testTag("completed-at-minutes"),
                decorationBox = { inner ->
                    Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                        if (flow.minutes.isEmpty()) Text(words.getString("placeholder"), style = rnText(16, 400), color = c.secondaryText)
                        inner()
                    }
                })
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.End)) {
                Text(words.getString("cancel"), style = rnText(15, 600), color = c.secondaryText, modifier = Modifier
                    .clickable(role = Role.Button) { flow.close() }.padding(horizontal = 12.dp, vertical = 8.dp).testTag("completed-at-cancel"))
                Text(words.getString("save"), style = rnText(15, 600), color = c.tint, modifier = Modifier
                    .clickable(role = Role.Button) { flow.save() }.padding(horizontal = 12.dp, vertical = 8.dp).testTag("completed-at-save"))
            }
        }
    }
}
