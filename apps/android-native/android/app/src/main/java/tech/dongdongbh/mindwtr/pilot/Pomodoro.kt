package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.Context
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
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.InboxViewModel.Part
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.Locale
import java.util.UUID


internal class PomodoroPlanGate {
    private var requested = false
    private var last: String? = null

    fun request() { requested = true }

    fun planned(state: String) { last = state; requested = false }


    fun take(state: String): Boolean = (requested || state != last).also { if (it) planned(state) }
}


class PomodoroModel(private val shell: InboxViewModel) {
    var panel by mutableStateOf<JSONObject?>(null); private set

    var picker by mutableStateOf<List<JSONObject>?>(null); private set
    private var pickerTotal = 0
    private var pickerRevision = ""

    private var feedback: JSONObject? = null

    private val app: Application get() = shell.getApplication()
    private val prefs get() = app.getSharedPreferences(if (Workspace.sandbox) "$PREFS-sandbox" else PREFS, Context.MODE_PRIVATE)

    val collapsed: Boolean get() = prefs.getBoolean(COLLAPSED, false)

    private fun presentation() = JSONObject().put("collapsed", collapsed).put("lastEvent", feedback ?: JSONObject.NULL).toString()


    fun refresh(planAlarms: Boolean = false) {
        if (Workspace.sandbox) return
        if (!planAlarms) return read()
        planGate.request()
        shell.menu.whenIdle(::read)
    }

    private fun read() {
        shell.background(listOf(Part.Pomodoro), { runtime -> runtime.pomodoroPanelRead(presentation()) }) { next, mine ->
            if (!shell.fresh(mine, Part.Pomodoro)) return@background
            panel = next
            if (owed(next) != null) settle(null, null)
            else if (planGate.take(planned(next))) planInBackground()
        }
    }


    private val planGate = PomodoroPlanGate()
    private fun planned(shown: JSONObject) = "${shown.optString("sessionID")}:${shown.optLong("generation")}"


    fun act(action: String, fields: JSONObject? = null) = settle(action, fields)


    fun toggleCollapsed() {
        prefs.edit().putBoolean(COLLAPSED, !collapsed).apply()
        refresh()
    }


    private fun owed(shown: JSONObject): String? = when {
        shown.getString("kind") == "uninitialized" -> "adoptLegacy"
        shown.optBoolean("selectionMissing") -> "selectTask"
        shown.optBoolean("needsReconcile") -> "reconcile"
        else -> null
    }

    private fun settle(requested: String?, fields: JSONObject?) = shell.menu.whenIdle {
        shell.perform { runtime ->
            val next = transition(runtime, requested, fields)
            shell.ui {
                panel = next

                if (owed(next) == null) planGate.planned(planned(next))
            }
        }
    }


    private fun transition(runtime: CoreHost, requested: String?, fields: JSONObject?): JSONObject {
        val before = runtime.pomodoroPanelRead(presentation())

        val owed = owed(before)
        val action = (if (owed == "adoptLegacy") owed else requested ?: owed) ?: return before.also { plan(runtime) }
        val legacy = if (action == "adoptLegacy") adoptionInput(runtime) else null
        val request = JSONObject().put("action", action).put("requestId", UUID.randomUUID().toString())
            .put("observedAtMs", before.getJSONObject("observation").getLong("nowMs"))
            .put("localDayKey", before.getJSONObject("observation").getString("localDayKey"))
            .put("autoStart", before.getJSONObject("autoStart"))
        legacy?.let { request.put("legacy", it) }
        if (action == "selectTask" && action != requested) request.put("taskId", JSONObject.NULL)
        fields?.keys()?.forEach { request.put(it, fields.get(it)) }
        val prepared = runtime.pomodoroTransitionPrepare(request.toString())
        if (prepared.getString("kind") == "prepared") {
            val result = runtime.pomodoroTransitionCommit(prepared.getString("planJSON")).getJSONObject("result")

            val event = before.optString("completionEvent")
            feedback = if (action in FEEDBACK_ACTIONS && event in EVENTS && result.getLong("generation") == before.optLong("generation") + 1) {
                JSONObject().put("sessionID", result.getString("sessionID")).put("generation", result.getLong("generation")).put("value", event)
            } else null
            if (legacy != null) prefs.edit().putBoolean(COLLAPSED, legacy.optString("collapsedRaw") == "true").apply()
        }
        val after = runtime.pomodoroPanelRead(presentation())

        if (owed(after) == null) plan(runtime)
        return after
    }


    private fun adoptionInput(runtime: CoreHost): JSONObject {
        val alarms = PomodoroAlarms(app)
        runCatching { alarms.rememberUpgrade() }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro upgrade time not kept", it) }
        runCatching { alarms.showLegacy(runtime, runtime.rnValue(RN_ALARM_KEY)) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android RN Pomodoro alert not shown", it) }
        return JSONObject().put("version", 1).put("namespace", app.packageName)
            .put("sessionRaw", runtime.rnValue(RN_SESSION_KEY) ?: JSONObject.NULL)
            .put("collapsedRaw", runtime.rnValue(RN_COLLAPSED_KEY) ?: JSONObject.NULL)
    }

    private fun plan(runtime: CoreHost) {
        runCatching { PomodoroAlarms(app).plan(runtime) }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alarms not planned", it) }
    }


    fun planInBackground() = if (Workspace.sandbox) Unit else shell.menu.whenIdle { shell.background(listOf(Part.Pomodoro), { runtime -> plan(runtime) }) { _, _ -> } }


    fun taskDone(id: String, taskRevision: String) {
        feedback = null
        shell.complete(id, taskRevision)
    }

    fun openPicker() { picker = emptyList(); pickerTotal = 0; pickerRevision = ""; more() }
    fun closePicker() { picker = null }


    fun more() {
        val loaded = picker ?: return
        if (loaded.isNotEmpty() && loaded.size >= pickerTotal) return
        val controls = shell.menu.focusControls.state.toString()
        val revision = pickerRevision.ifEmpty { shell.focusRevision() }
        shell.background(listOf(Part.Pomodoro), { runtime ->
            val window = { offset: Int, at: String ->
                runtime.pomodoroTasks(JSONObject().put("offset", offset).put("limit", WINDOW).put("revision", at)
                    .put("controls", JSONObject(controls)).toString())
            }
            try {
                window(loaded.size, revision)
            } catch (failure: Exception) {
                if (failure.message?.startsWith("STALE_REVISION") != true) throw failure


                val fresh = runtime.focus(1, controls).getString("revision")
                window(0, fresh).put("restarted", true)
            }
        }) { next, _ ->
            val shown = picker ?: return@background
            if (shown.size != loaded.size) return@background
            val restarted = next.optBoolean("restarted")
            pickerTotal = next.getInt("total")
            pickerRevision = next.getString("revision")
            picker = (if (restarted) emptyList() else shown) + next.menuObjects("rows")

            if (restarted) shell.refreshFocus()
        }
    }

    companion object {
        private const val PREFS = "mindwtr-pomodoro"
        private const val COLLAPSED = "collapsed"
        private const val WINDOW = 100

        const val RN_SESSION_KEY = "@mindwtr_pomodoro_state"
        const val RN_COLLAPSED_KEY = "@mindwtr_pomodoro_collapsed"
        const val RN_ALARM_KEY = "mindwtr:local:pomodoro-alarm:v1"
        private val FEEDBACK_ACTIONS = setOf("reconcile", "toggle", "selectTask")
        private val EVENTS = setOf("focus-finished", "break-finished")
    }
}


private fun cardText(size: Int, weight: Int, lineHeight: Int? = null, letterSpacing: Float = 0f) =
    rnText(size, weight, lineHeight, letterSpacing).copy(platformStyle = PlatformTextStyle(includeFontPadding = true))


internal fun pomodoroClock(totalSeconds: Long): String {
    val safe = maxOf(0L, totalSeconds)
    val hours = safe / 3600
    val minutes = (safe % 3600) / 60
    val seconds = safe % 60

    return if (hours > 0) String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
    else String.format(Locale.ROOT, "%02d:%02d", safe / 60, seconds)
}


internal fun pomodoroRemaining(endsAtMs: Long, nowMs: Long): Long = if (endsAtMs <= nowMs) 0 else maxOf(1L, (endsAtMs - nowMs + 999) / 1000)


internal fun JSONObject?.pomodoroShown(): JSONObject? = this?.takeIf { it.optBoolean("visible") && it.optString("kind") in setOf("ready", "uninitialized") }


@Composable
fun PomodoroCard(model: InboxViewModel) = with(model.pomodoro) {
    val shown = panel.pomodoroShown() ?: return
    val running = shown.getBoolean("isRunning")
    val endsAt = if (shown.isNull("phaseEndsAtMs")) null else shown.getLong("phaseEndsAtMs")
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner, running, endsAt) {
        if (running && endsAt != null) owner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                now = System.currentTimeMillis()
                if (now >= endsAt) {

                    refresh(planAlarms = true)
                    break
                }

                delay((endsAt - now - 1) % 1000 + 1)
            }
        }
    }

    val clock = if (running && endsAt != null && now > 0) pomodoroClock(pomodoroRemaining(endsAt, System.currentTimeMillis())) else shown.getString("clock")
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    val text = shown.getJSONObject("text")

    val loading = shown.getString("kind") == "uninitialized"
    val enabled = model.menu.idle && !loading
    val phaseColor = if (shown.getString("phase") == "focus") c.tint else c.success
    val shape = RoundedCornerShape(14.dp)
    val collapsed = shown.getBoolean("collapsed")
    @Composable fun Fold() {
        val label = text.getString("collapse")

        val foldable = model.menu.idle
        Box(Modifier.clearAndSetSemantics { testTag = "pomodoro-fold"; contentDescription = label; role = Role.Button; if (foldable) onClick { toggleCollapsed(); true } else disabled() }
            .clickable(enabled = foldable) { toggleCollapsed() }.padding(horizontal = 6.dp, vertical = 2.dp)) {
            Icon(if (collapsed) Lucide.ChevronDownPlain else Lucide.ChevronUp, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        }
    }
    val card = Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).testTag("pomodoro-card")
    if (collapsed) {
        Row(card.padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(clock, style = cardText(20, 700).copy(fontFeatureSettings = "tnum"), color = c.text, modifier = Modifier.testTag("pomodoro-clock"))
            Text("${text.getString("phase")} · ${text.getString("state")}".uppercase(), style = cardText(11, 700), color = phaseColor,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (running) Box(Modifier.size(8.dp).clip(CircleShape).background(phaseColor))
            Spacer(Modifier.weight(1f))
            Fold()
        }
        return
    }
    Column(card.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Text(text.getString("title"), style = cardText(16, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            Text(text.getString("phase").uppercase(), style = cardText(11, 700), color = phaseColor, modifier = Modifier.padding(top = 2.dp))
            Fold()
        }
        if (loading) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
            Text(text.getString("loading"), style = cardText(12, 500), color = c.secondaryText)
        }
        Box(Modifier.fade(if (loading) 0.6f else 1f)) { Presets(shown, enabled) }
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(clock, style = cardText(36, 800, letterSpacing = 1f).copy(fontFeatureSettings = "tnum"), color = c.text,
                modifier = Modifier.testTag("pomodoro-clock"))
            Text("${text.getString("sessionsDone")}: ${shown.getInt("completedToday")}", style = cardText(11, 600), color = c.secondaryText)
        }
        if (shown.optBoolean("linkTaskEnabled")) LinkRow(shown, text, enabled)
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.fade(if (loading) 0.5f else 1f)) {
                CardButton(text.getString("toggle"), enabled, theme.filledBg, theme.filledBg, theme.filledText, 14, "pomodoro-primary") { act("toggle") }
            }
            CardButton(text.getString("reset"), enabled, c.filterBg, c.border, c.secondaryText, 12, "pomodoro-reset") { act("reset") }
            CardButton(text.getString("switchPhase"), enabled, c.filterBg, c.border, c.secondaryText, 12, "pomodoro-switch") { act("switchPhase") }
        }
        shown.menuText("event")?.let { Text(it, style = cardText(12, 500), color = c.secondaryText, modifier = Modifier.testTag("pomodoro-event")) }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PomodoroModel.Presets(shown: JSONObject, enabled: Boolean) {
    val c = LocalTheme.current.colors
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (preset in shown.menuObjects("presets")) {
            val active = preset.getBoolean("active")
            val label = preset.getString("label")
            val choose = {
                act("setDurations", JSONObject().put("durations", JSONObject().put("focusMinutes", preset.getInt("focusMinutes"))
                    .put("breakMinutes", preset.getInt("breakMinutes"))))
            }
            Box(Modifier.clip(CircleShape).background(if (active) c.tint else c.filterBg).rnBorder(1.dp, if (active) c.tint else c.border, CircleShape)
                .clearAndSetSemantics { testTag = "pomodoro-preset-${preset.getString("id")}"; contentDescription = label; role = Role.Button; selected = active; if (enabled) onClick { choose(); true } else disabled() }
                .clickable(enabled = enabled) { choose() }.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text(label, style = cardText(11, 700), color = if (active) c.onTint else c.secondaryText)
            }
        }
    }
}


@Composable
private fun CardButton(label: String, enabled: Boolean, background: Color, border: Color, text: Color, horizontal: Int, tag: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.clip(shape).background(background).rnBorder(1.dp, border, shape)
        .clearAndSetSemantics { testTag = tag; contentDescription = label; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = horizontal.dp, vertical = 9.dp)) {
        Text(label, style = cardText(12, 700), color = text)
    }
}


@Composable
private fun PomodoroModel.LinkRow(shown: JSONObject, text: JSONObject, enabled: Boolean) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    val label = text.getString("selectedTask")
    val task = shown.optJSONObject("selectedTask")
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.weight(1f).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
            .clearAndSetSemantics { testTag = "pomodoro-link"; contentDescription = label; role = Role.Button; if (enabled) onClick { openPicker(); true } else disabled() }
            .clickable(enabled = enabled) { openPicker() }.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label.uppercase(), style = cardText(10, 700), color = c.secondaryText)
                Text(task?.getString("title") ?: text.getString("timerOnly"), style = cardText(13, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(text.getString("changeTask"), style = cardText(12, 700), color = c.tint)
        }
        if (task != null) {
            val spoken = text.getString("markDone")
            val done = { taskDone(task.getString("id"), task.getString("taskRevision")) }
            Box(Modifier.fillMaxHeight().clip(shape).background(c.success.copy(alpha = 0x18 / 255f)).rnBorder(1.dp, c.success, shape)
                .clearAndSetSemantics { testTag = "pomodoro-done"; contentDescription = spoken; role = Role.Button; if (enabled) onClick { done(); true } else disabled() }
                .clickable(enabled = enabled) { done() }.padding(horizontal = 10.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center) {
                Text(text.getString("taskDoneShort"), style = cardText(12, 700), color = c.success)
            }
        }
    }
}


@Composable
fun PomodoroPicker(model: InboxViewModel) = with(model.pomodoro) {
    val rows = picker ?: return
    val shown = panel.pomodoroShown()?.takeIf { it.optBoolean("linkTaskEnabled") }

    if (shown == null) {
        LaunchedEffect(Unit) { closePicker() }
        return
    }
    val text = shown.getJSONObject("text")
    val selectedId = shown.optJSONObject("selectedTask")?.getString("id")
    val c = LocalTheme.current.colors
    val enabled = model.menu.idle
    BackHandler { closePicker() }
    val choose = { id: String? -> if (enabled) { closePicker(); act("selectTask", JSONObject().put("taskId", id ?: JSONObject.NULL)) } }

    Box(Modifier.fillMaxSize().background(Color(0x99000000)).semantics { testTagsAsResourceId = true }
        .pointerInput(Unit) { detectTapGestures { closePicker() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(14.dp)
        Column(Modifier.fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.72f).dp).clip(shape).background(c.cardBg)
            .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(12.dp).testTag("pomodoro-picker"),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(text.getString("selectedTask"), style = cardText(16, 800), color = c.text, modifier = Modifier.semantics { heading() })
            Option(text.getString("timerOnly"), selectedId == null, 1, "pomodoro-timer-only") { choose(null) }
            LazyColumn(Modifier.heightIn(max = 320.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                itemsIndexed(rows, key = { _, row -> row.getString("id") }) { index, row ->
                    if (index == rows.size - 1) LaunchedEffect(rows.size) { more() }
                    val id = row.getString("id")
                    Option(row.getString("title"), id == selectedId, 2, "pomodoro-task") { choose(id) }
                }
                if (rows.isEmpty()) item {
                    Text(text.getString("noTask"), style = cardText(13, 600), color = c.secondaryText, modifier = Modifier.padding(vertical = 8.dp))
                }
            }
        }
    }
}


@Composable
private fun Option(label: String, selected: Boolean, lines: Int, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(if (selected) c.tint.copy(alpha = 0x18 / 255f) else c.filterBg)
        .rnBorder(selectedOptionBorder(selected), if (selected) c.tint else c.border, shape)
        .clearAndSetSemantics { testTag = tag; contentDescription = label; role = Role.Button; this.selected = selected; onClick { onClick(); true } }
        .clickable(onClick = onClick).padding(10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = cardText(14, 700), color = if (selected) c.tint else c.text, maxLines = lines, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (selected) Icon(Lucide.CheckPicked, null, tint = c.tint, modifier = Modifier.size(16.dp))
    }
}
