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

/*
 * The native Pomodoro on the Focus screen (pass R2b, design .orchestrator/tasks/native-r2b-20261022/design.md): RN's card
 * (components/pomodoro-panel.tsx) drawn from core's panel (native-pomodoro-panel.ts, the session iOS built), each control a
 * core transition (prepared, then committed with its receipt and the task's credit in one transaction, journaled), and the
 * completion alarms planned after each (PomodoroAlarms.kt).
 */

/**
 * When a card read plans the alerts (design R2b §3 "Runs on"): for a session state they were not planned for, as after the boot's
 * journal replay of a control, which commits outside the card; and once for a requested plan (a resume) even when a newer read took
 * that read's place.
 */
internal class PomodoroPlanGate {
    private var requested = false
    private var last: String? = null

    fun request() { requested = true }

    fun planned(state: String) { last = state; requested = false }

    /** Whether the read of [state] plans; it then counts as planned. */
    fun take(state: String): Boolean = (requested || state != last).also { if (it) planned(state) }
}

/** The card's state: core's panel, the open picker's rows, and the two presentation values core takes back (collapsed, the last feedback). */
class PomodoroModel(private val shell: InboxViewModel) {
    var panel by mutableStateOf<JSONObject?>(null); private set
    /** The picker's rows while it is open (core's getPomodoroTaskWindow), null while closed. */
    var picker by mutableStateOf<List<JSONObject>?>(null); private set
    private var pickerTotal = 0
    private var pickerRevision = ""
    /** Core's completion feedback (NativePomodoroFeedback), shown under the clock until the next transition. */
    private var feedback: JSONObject? = null

    private val app: Application get() = shell.getApplication()
    private val prefs get() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    /** RN's card folded to its time row (RN's `@mindwtr_pomodoro_collapsed`, adopted once). Device-local, as RN's. */
    val collapsed: Boolean get() = prefs.getBoolean(COLLAPSED, false)

    private fun presentation() = JSONObject().put("collapsed", collapsed).put("lastEvent", feedback ?: JSONObject.NULL).toString()

    /**
     * Core's card again, in the background (each Focus read, a resume, the phase's end on screen). What core asks before anything
     * else runs as a write: the first start adopts RN's session, a linked task that went away is unlinked, an ended phase is
     * settled. [planAlarms]: plan the alerts after it (a start or resume, never before the ended phase settled: design §3b K5).
     */
    fun refresh(planAlarms: Boolean = false) {
        if (planAlarms) planGate.request()
        shell.background(listOf(Part.Pomodoro), { runtime -> runtime.pomodoroPanelRead(presentation()) }) { next, mine ->
            if (!shell.fresh(mine, Part.Pomodoro)) return@background
            panel = next
            if (owed(next) != null) settle(null, null)
            else if (planGate.take(planned(next))) planInBackground()
        }
    }

    /** Which session state the alerts were last planned for (UI thread only). */
    private val planGate = PomodoroPlanGate()
    private fun planned(shown: JSONObject) = "${shown.optString("sessionID")}:${shown.optLong("generation")}"

    /** A control's transition ([action] and its fields), then the card and the alarms again. */
    fun act(action: String, fields: JSONObject? = null) = settle(action, fields)

    /** RN's fold: presentation only (no transition), the card read again. */
    fun toggleCollapsed() {
        prefs.edit().putBoolean(COLLAPSED, !collapsed).apply()
        refresh()
    }

    /** What core asks of a card before any control: adopt RN's session, unlink a task that went away, settle an ended phase. */
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
                // transition() planned once nothing was owed.
                if (owed(next) == null) planGate.planned(planned(next))
            }
        }
    }

    /**
     * iOS's order (CoreModel.swift runtime admission): read, then the transition core owes or the control asked, read again, and
     * plan the alerts only once nothing is owed any more. A transition core refuses as stale or busy wrote nothing; the next
     * refresh tries again.
     */
    private fun transition(runtime: CoreHost, requested: String?, fields: JSONObject?): JSONObject {
        val before = runtime.pomodoroPanelRead(presentation())
        // iOS's order: adoption first, then the control (core's prepare settles an ended phase inside any action), then what is owed.
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
            // Core's feedback rule (iOS's pomodoroFeedback): a phase that ended in this transition says so under the clock.
            val event = before.optString("completionEvent")
            feedback = if (action in FEEDBACK_ACTIONS && event in EVENTS && result.getLong("generation") == before.optLong("generation") + 1) {
                JSONObject().put("sessionID", result.getString("sessionID")).put("generation", result.getLong("generation")).put("value", event)
            } else null
            if (legacy != null) prefs.edit().putBoolean(COLLAPSED, legacy.optString("collapsedRaw") == "true").apply()
        }
        val after = runtime.pomodoroPanelRead(presentation())
        // One owed transition per pass: the next refresh settles the rest before any plan.
        if (owed(after) == null) plan(runtime)
        return after
    }

    /**
     * RN's stored session for core's adoption (RN's AsyncStorage keys in RKStorage), at the first start: the upgrade time is kept
     * first, and RN's alert that fell due between the upgrade and this start is shown once (design §3b K6).
     */
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

    /** The alerts again with no read before (the alert setting or the permission changed). */
    fun planInBackground() = shell.background(listOf(Part.Pomodoro), { runtime -> plan(runtime) }) { _, _ -> }

    /**
     * RN's Mark task done: the Focus rows' completion command for the linked task at the revision the card showed. The feedback
     * line goes, as RN's clearLastEvent; the Focus read after the command reads the card again.
     */
    fun taskDone(id: String, taskRevision: String) {
        feedback = null
        shell.complete(id, taskRevision)
    }

    fun openPicker() { picker = emptyList(); pickerTotal = 0; pickerRevision = ""; more() }
    fun closePicker() { picker = null }

    /** The picker's next window of Focus tasks (RN's card takes the Focus screen's lists), for the Focus controls on screen. */
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
                // Core's Focus revision moves with the minute and each edit: one fresh Focus snapshot restarts the paging, never
                // mixing revisions (iOS's loadMorePomodoroTasks).
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
            // The screen's Focus was older than the picker's: read it again too.
            if (restarted) shell.refreshFocus()
        }
    }

    companion object {
        private const val PREFS = "mindwtr-pomodoro"
        private const val COLLAPSED = "collapsed"
        private const val WINDOW = 100
        /** RN's AsyncStorage keys (apps/mobile/lib/pomodoro-session.ts) and RN's alarm record (core's POMODORO_ALARM_STORAGE_KEY). */
        const val RN_SESSION_KEY = "@mindwtr_pomodoro_state"
        const val RN_COLLAPSED_KEY = "@mindwtr_pomodoro_collapsed"
        const val RN_ALARM_KEY = "mindwtr:local:pomodoro-alarm:v1"
        private val FEEDBACK_ACTIONS = setOf("reconcile", "toggle", "selectTask")
        private val EVENTS = setOf("focus-finished", "break-finished")
    }
}

/**
 * RN's Text on Android for the card's styles, which set no line height: Android's TextView metrics with the font's padding
 * (RN's includeFontPadding default), so each line is as tall as RN's (the S23 side by side, pass R2).
 */
private fun cardText(size: Int, weight: Int, lineHeight: Int? = null, letterSpacing: Float = 0f) =
    rnText(size, weight, lineHeight, letterSpacing).copy(platformStyle = PlatformTextStyle(includeFontPadding = true))

/** Core's formatPomodoroClock (pomodoro.ts): H:MM:SS from an hour, else MM:SS. */
internal fun pomodoroClock(totalSeconds: Long): String {
    val safe = maxOf(0L, totalSeconds)
    val hours = safe / 3600
    val minutes = (safe % 3600) / 60
    val seconds = safe % 60
    // ASCII digits in every language, as core's padStart.
    return if (hours > 0) String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
    else String.format(Locale.ROOT, "%02d:%02d", safe / 60, seconds)
}

/** Core's remaining seconds from the phase's end (pomodoro-session.ts getRemainingSecondsFromPhaseEnd): rounded up, 0 once ended. */
internal fun pomodoroRemaining(endsAtMs: Long, nowMs: Long): Long = if (endsAtMs <= nowMs) 0 else maxOf(1L, (endsAtMs - nowMs + 999) / 1000)

/** The shown panel while the Pomodoro feature is on, else null (the card draws nothing). Before the adoption core's panel is the default timer. */
internal fun JSONObject?.pomodoroShown(): JSONObject? = this?.takeIf { it.optBoolean("visible") && it.optString("kind") in setOf("ready", "uninitialized") }

/**
 * RN's card (components/pomodoro-panel.tsx) on core's panel: the folded time row or the full card. While the timer runs and the
 * screen is resumed the clock redraws each second from the phase's end, with no engine call; at 0 core settles the phase once.
 */
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
                    // The phase ended on screen: core settles it (RN's tick at 0), then the alerts are planned.
                    refresh(planAlarms = true)
                    break
                }
                // The next whole second of the countdown.
                delay((endsAt - now - 1) % 1000 + 1)
            }
        }
    }
    // `now` only schedules the redraw; the clock reads the time itself, so a resume never shows a stale second first.
    val clock = if (running && endsAt != null && now > 0) pomodoroClock(pomodoroRemaining(endsAt, System.currentTimeMillis())) else shown.getString("clock")
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    val text = shown.getJSONObject("text")
    // RN's card while its session loads: the default timer with its controls off (presets at 0.6, Start at 0.5) and a Loading row.
    val loading = shown.getString("kind") == "uninitialized"
    val enabled = model.menu.idle && !loading
    val phaseColor = if (shown.getString("phase") == "focus") c.tint else c.success
    val shape = RoundedCornerShape(14.dp)
    val collapsed = shown.getBoolean("collapsed")
    @Composable fun Fold() {
        val label = text.getString("collapse")
        // RN's fold stays on while the session loads.
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

/** RN's preset chips: the active one filled with the tint. */
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

/** RN's actionPrimary (padding 14) or actionSecondary (12). */
@Composable
private fun CardButton(label: String, enabled: Boolean, background: Color, border: Color, text: Color, horizontal: Int, tag: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.clip(shape).background(background).rnBorder(1.dp, border, shape)
        .clearAndSetSemantics { testTag = tag; contentDescription = label; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = horizontal.dp, vertical = 9.dp)) {
        Text(label, style = cardText(12, 700), color = text)
    }
}

/** RN's linked task row: the picker button (Timer task, the task or Timer only, Change or Link task) and Task done while a task is linked. */
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

/** RN's task picker modal: Timer task, Timer only, then the Focus lists' tasks (core's windows), or core's empty line. */
@Composable
fun PomodoroPicker(model: InboxViewModel) = with(model.pomodoro) {
    val rows = picker ?: return
    val shown = panel.pomodoroShown()?.takeIf { it.optBoolean("linkTaskEnabled") }
    // RN closes its picker when task linking is turned off.
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
    // Its own root over the screen: its tags reach UiAutomator as resource ids only when it says so, as the other overlays do.
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

/** RN's taskPickerOption: the selected one in the tint, washed `${tint}18`. */
@Composable
private fun Option(label: String, selected: Boolean, lines: Int, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(if (selected) c.tint.copy(alpha = 0x18 / 255f) else c.filterBg).rnBorder(1.dp, if (selected) c.tint else c.border, shape)
        .clearAndSetSemantics { testTag = tag; contentDescription = label; role = Role.Button; this.selected = selected; onClick { onClick(); true } }
        .clickable(onClick = onClick).padding(10.dp)) {
        Text(label, style = cardText(14, 700), color = if (selected) c.tint else c.text, maxLines = lines, overflow = TextOverflow.Ellipsis)
    }
}
