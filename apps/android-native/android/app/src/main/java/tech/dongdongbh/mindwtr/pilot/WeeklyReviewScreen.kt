package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.util.UUID

/** RN's step icons (useReviewModalController STEP_ICONS), by core's step id. */
private fun stepIcon(id: String): ImageVector = when (id) {
    "inbox" -> Lucide.Inbox
    "stale" -> Lucide.History
    "calendar" -> Lucide.Calendar
    "waiting" -> Lucide.Clock
    "contexts" -> Lucide.Tag
    "projects" -> Lucide.FolderOpen
    "someday" -> Lucide.Lightbulb
    else -> Lucide.CheckCircle2
}

/**
 * RN's Weekly Review (components/review-modal.tsx) on core's getWeeklyReview, getWeeklyReviewList and runReviewAction: the
 * header (Close, core's step icon and title, core's "n/m"), core's progress, core's step rail, core's step content (Inbox with
 * Process Inbox; stale tasks and projects; the calendar's task dates; Waiting and Someday with their not-yet-due group;
 * contexts with their tasks; projects with Add task and the expanded project's rows; the summary), RN's toast, and Back and
 * Next (or Finish) at core's checkpoints. The step is core's checkpoint, kept on the device under core's key.
 */
@Composable
fun WeeklyReview(model: InboxViewModel) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shown = page
    val view = shown?.view
    val labels = view?.optJSONObject("labels")
    Column(Modifier.fillMaxSize().background(c.bg).testTag("weekly-review")) {
        val current = view?.optJSONObject("step")
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            val close = labels?.optString("closeLabel") ?: t("common.close")
            Box(Modifier.size(32.dp).clickable(enabled = model.failedAction == null, role = Role.Button) { closeScreen() }.semantics { contentDescription = close },
                contentAlignment = Alignment.Center) { Icon(Lucide.X, null, tint = c.text, modifier = Modifier.size(22.dp)) }
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                current?.let {
                    Icon(stepIcon(it.getString("id")), null, tint = c.text, modifier = Modifier.size(18.dp))
                    Text(it.getString("title"), style = rnText(18, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() }.testTag("review-step-title"))
                }
            }
            Text(current?.optString("indicator").orEmpty(), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.testTag("review-step-indicator"))
        }
        Rule()
        Box(Modifier.fillMaxWidth().height(4.dp).background(c.border)) {
            Box(Modifier.fillMaxWidth(((current?.optDouble("progress") ?: 0.0) / 100.0).coerceIn(0.0, 1.0).toFloat()).fillMaxHeight().background(theme.reviewProgress))
        }
        view?.let { StepRail(it) }
        model.error?.let { message ->
            FailureBanner(message) {
                if (model.failedAction == null) TextButton(onClick = { retryRead() }, enabled = !model.busy, modifier = Modifier.testTag("read-retry")) { Text(t("common.retry")) }
                else OwedRetry(model)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (shown != null && labels != null) LazyColumn(Modifier.fillMaxSize().testTag("review-step-scroll"), contentPadding = PaddingValues(20.dp)) {
                weeklyContent(model, shown, labels)
                if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
            }
            ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp))
        }
        Rule()
        if (view != null && labels != null) Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            val finish = view.optJSONObject("finish")
            if (finish != null) {
                // RN's share card is not built: its button keeps RN's look, drawn disabled.
                val shape = RoundedCornerShape(12.dp)
                Row(Modifier.fade(0.45f).padding(end = 12.dp).weight(1f, fill = false).heightIn(min = 48.dp).clip(shape).border(1.dp, c.border, shape)
                    .semantics { contentDescription = finish.getString("shareLabel"); disabled() }.padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Lucide.Share2, null, tint = c.text, modifier = Modifier.size(18.dp))
                    Text(finish.getString("shareLabel"), style = rnText(15, 600), color = c.text, textAlign = TextAlign.Center, maxLines = 2)
                }
                // RN's handleFinish: the review closes, then the store review prompt's gate (AboutSettings.kt).
                val activity = androidx.activity.compose.LocalActivity.current
                PrimaryButton(finish.getString("label"), Modifier.weight(1f), model.failedAction == null) {
                    finishReview()
                    requestStoreReviewAfterWeeklyReview(model, activity)
                }
            } else {
                val back = view.getJSONObject("back")
                val previous = back.menuText("checkpoint")
                val backLabel = back.getString("label")
                Text("← $backLabel", style = rnText(16, 400), color = c.secondaryText, modifier = Modifier
                    .clickable(enabled = previous != null && idle, role = Role.Button) { previous?.let { step(it) } }
                    .semantics { contentDescription = backLabel; if (previous == null) disabled() }.fade(if (previous == null) 0.5f else 1f).padding(12.dp))
                view.optJSONObject("next")?.let { next ->
                    val label = next.getString("label")
                    PrimaryButton("$label →", Modifier, idle, label) { step(next.getString("checkpoint")) }
                }
            }
        }
    }
}

/** A 1 dp rule, as RN's borderBottomWidth: 1 under the review header and above its footer. */
@Composable
fun Rule() = Box(Modifier.fillMaxWidth().height(1.dp).background(LocalTheme.current.colors.border))

/** RN's filled review button (the filled call-to-action colors): Next, Finish, Add. */
@Composable
fun PrimaryButton(label: String, modifier: Modifier, enabled: Boolean, description: String = label, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = description }.padding(horizontal = 32.dp, vertical = 14.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(16, 600), color = theme.filledText, textAlign = TextAlign.Center)
    }
}

/** RN's step rail: core's steps as pills, the current one in the tint wash, a finished one green with a check. */
@Composable
private fun StepRail(view: JSONObject) {
    val theme = LocalTheme.current
    val c = theme.colors
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (step in view.menuObjects("rail")) {
            val state = step.getString("state")
            val current = state == "current"
            val complete = state == "complete"
            val number = step.getInt("number")
            Row(Modifier.widthIn(min = 104.dp, max = 148.dp).height(32.dp).clip(CircleShape)
                .background(if (current) theme.railCurrent else if (complete) theme.railDone else c.filterBg)
                .border(1.dp, if (current) c.tint else if (complete) theme.railDoneBorder else c.border, CircleShape).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(18.dp).clip(CircleShape).background(if (current) c.tint else c.cardBg), contentAlignment = Alignment.Center) {
                    if (complete) Icon(Lucide.CheckCircle2, null, tint = c.text, modifier = Modifier.size(12.dp))
                    else Text("$number", style = rnText(10, 800), color = if (current) c.onTint else c.text)
                }
                Text(step.getString("title"), style = rnText(12, 700), color = if (current) c.text else c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    Rule()
}

/**
 * RN's AI analysis on the stale step (review-modal.tsx): Run analysis ("Analyzing..." while it runs), core's error line or RN's
 * empty line, each suggestion with RN's checkbox (an actionable one toggles), and Apply selected (n) through runReviewAction.
 */
@Composable
private fun ReviewAnalysisCard(model: InboxViewModel, labels: JSONObject) {
    val c = LocalTheme.current.colors
    val ai = model.ai
    val analysis = ai.review
    val running = ai.working == "review"
    Column(Modifier.padding(top = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Lucide.Sparkles, null, tint = c.text, modifier = Modifier.size(18.dp))
            Text(labels.getString("aiDesc"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.weight(1f))
        }
        // RN's button keeps its look while it runs; a second tap does nothing.
        PrimaryButton(labels.getString(if (running) "aiRunning" else "aiRun"), Modifier.padding(top = 12.dp).fillMaxWidth().testTag("review-ai-run"), true) { ai.runAnalysis() }
        analysis.error?.let { Text(it, style = rnText(14, 400), color = c.danger, modifier = Modifier.padding(top = 12.dp, bottom = 16.dp).testTag("review-ai-error")) }
        if (analysis.ran && !running && analysis.suggestions.isEmpty() && analysis.error == null) {
            Text(labels.getString("aiEmpty"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(top = 12.dp, bottom = 16.dp))
        }
        for (suggestion in analysis.suggestions) {
            val id = suggestion.getString("id")
            val actionable = suggestion.getBoolean("actionable")
            val selected = id in analysis.selected
            val title = suggestion.getString("title")
            val shape = RoundedCornerShape(10.dp)
            Row(Modifier.padding(bottom = 10.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
                .clickable(enabled = actionable, role = Role.Checkbox) { ai.toggleSuggestion(id) }
                .semantics { contentDescription = title; this.selected = selected }.testTag("review-ai-suggestion").padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val box = RoundedCornerShape(4.dp)
                Box(Modifier.padding(top = 2.dp).size(18.dp).clip(box).then(if (selected) Modifier.background(c.tint) else Modifier).border(1.dp, c.border, box),
                    contentAlignment = Alignment.Center) {
                    if (selected) Icon(Lucide.CheckBold, null, tint = c.onTint, modifier = Modifier.size(12.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(title, style = rnText(15, 600), color = c.text)
                    Text(suggestion.getString("meta"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        if (analysis.suggestions.isNotEmpty()) {
            PrimaryButton("${labels.getString("aiApply")} (${analysis.selected.size})", Modifier.padding(top = 12.dp).fillMaxWidth().testTag("review-ai-apply"),
                model.menu.idle) { ai.applySuggestions() }
        }
    }
}

/** RN's step heading: the step's icon at 22 and core's heading at 24 bold, then core's hint. */
private fun LazyListScope.stepHeading(icon: ImageVector, title: String, hint: String?) = item(key = "heading") {
    val c = LocalTheme.current.colors
    Column {
        Row(Modifier.padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, tint = c.text, modifier = Modifier.size(22.dp))
            Text(title, style = rnText(24, 700), color = c.text, modifier = Modifier.semantics { heading() })
        }
        hint?.let { Text(it, style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 16.dp)) }
    }
}

/** A row of the review: RN's task row, with core's status action, Delete and its Undo (runReviewAction). */
@Composable
private fun ReviewRow(model: InboxViewModel, row: TaskRow) = with(model.menu) {
    TaskRowItem(model, row, status = RowStatus.Badge, actions = RowActions(
        status = { status -> act("reviewAction", setTaskStatus(row.id, status, row.taskRevision)) },
        delete = { act("reviewAction", trashTask(row.id, row.taskRevision)) },
    ))
}

/** A step's empty line, RN's emptyState: centered, 16, the secondary text color. */
private fun LazyListScope.emptyLine(text: String, icon: ImageVector? = null) = item(key = "empty") {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        icon?.let { Icon(it, null, tint = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp).size(48.dp)) }
        Text(text, style = rnText(16, 400), color = c.secondaryText, textAlign = TextAlign.Center)
    }
}

/** Core's content for the step on screen, drawn as RN's renderStepContent draws it. */
@OptIn(ExperimentalLayoutApi::class)
private fun LazyListScope.weeklyContent(model: InboxViewModel, shown: MenuPage, labels: JSONObject) {
    val menu = model.menu
    val content = shown.view.getJSONObject("content")
    val rows = { list: List<MenuItem> -> items(list, key = { it.key }) { item -> item.row?.let { ReviewRow(model, it) } } }
    when (content.getString("step")) {
        "inbox" -> {
            item(key = "inbox") {
                val theme = LocalTheme.current
                val c = theme.colors
                Column(Modifier.padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    content.menuText("countLabel")?.let { count ->
                        Text(count, style = rnText(18, 600), color = c.text)
                        Text(labels.getString("inboxHint"), style = rnText(14, 400, 20), color = c.secondaryText)
                        val process = labels.getString("processInbox")
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg)
                            .clickable(enabled = menu.idle, role = Role.Button) { model.openProcessing() }.semantics { contentDescription = process }
                            .padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                            Icon(Lucide.PlayFilled, null, tint = theme.filledText, modifier = Modifier.size(18.dp))
                            Text(process, style = rnText(15, 600), color = theme.filledText)
                        }
                    }
                    MindSweepLink(labels.getString("mindSweep"), enabled = menu.idle) { menu.openMindSweep() }
                }
            }
            rows(shown.items)
            content.menuText("empty")?.let { emptyLine(it, Lucide.CheckCircle2Thin) }
        }
        "stale" -> {
            stepHeading(Lucide.History, labels.getString("stale"), labels.getString("staleDesc"))
            rows(shown.items)
            val projects = shown.collection("staleProjects")
            items(projects, key = { "stale:${it.getString("id")}" }) { project -> InfoCard(project.getString("title"), project.getString("daysLabel")) }
            if (projects.size < shown.collectionTotal("staleProjects")) item(key = "stale-more") { MoreChip(menu.idle) { menu.loadCollection("staleProjects") } }
            if (content.getJSONObject("ai").getBoolean("enabled")) item(key = "ai") { ReviewAnalysisCard(model, labels) }
        }
        "calendar" -> {
            stepHeading(Lucide.Calendar, labels.getString("calendar"), null)
            item(key = "calendar") {
                val c = LocalTheme.current.colors
                Column {
                    val shape = RoundedCornerShape(8.dp)
                    Text(labels.getString("addTask"), style = rnText(13, 600), color = c.text, modifier = Modifier.padding(bottom = 10.dp).clip(shape).border(1.dp, c.border, shape)
                        .clickable(enabled = menu.idle, role = Role.Button) { model.openCapture() }.padding(horizontal = 10.dp, vertical = 6.dp))
                    Text(labels.getString("calendarDesc"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 16.dp))
                    CalendarColumn(labels.getString("calendarUpcoming")) {
                        content.menuText("notice")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
                        for (day in content.menuObjects("days")) DayCard(menu, day, labels)
                    }
                    CalendarColumn(labels.getString("calendarTasks"), Modifier.padding(top = 12.dp)) {
                        content.menuText("tasksEmpty")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (task in content.menuObjects("tasks")) InfoCard(task.getString("title"), task.getString("meta"))
                        }
                    }
                }
            }
        }
        "waiting", "someday" -> {
            val waiting = content.getString("step") == "waiting"
            stepHeading(if (waiting) Lucide.Clock else Lucide.Lightbulb, labels.getString(if (waiting) "waitingDesc" else "somedayDesc"),
                labels.getString(if (waiting) "waitingGuide" else "somedayGuide"))
            content.menuText("empty")?.let { emptyLine(it) }
            // Core lists the rows due now first, then the not-yet-due ones it flags `scheduled`.
            val split = shown.items.indexOfFirst { it.json.optBoolean("scheduled") }.takeIf { it >= 0 } ?: shown.items.size
            val later = shown.items.subList(split, shown.items.size)
            rows(shown.items.subList(0, split))
            content.optJSONObject("scheduled")?.let { scheduled ->
                val open = menu.own("weekly").optBoolean("scheduled")
                item(key = "scheduled") {
                    val c = LocalTheme.current.colors
                    val label = scheduled.getString("label")
                    Row(Modifier.padding(top = 12.dp).clickable(role = Role.Button) { menu.editOwn("weekly") { put("scheduled", !open) } }
                        .semantics { contentDescription = label }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
                        Text(label.uppercase(), style = rnText(12, 600, letterSpacing = 0.5f), color = c.secondaryText)
                    }
                }
                if (open) rows(later)
            }
        }
        "contexts" -> {
            stepHeading(Lucide.Tag, labels.getString("contexts"), labels.getString("contextsDesc"))
            content.menuText("empty")?.let { emptyLine(it) }
            items(shown.items, key = { it.key }) { item -> ContextCard(model, shown, item.json, content.getInt("previewCount"), labels) }
        }
        "projects" -> {
            stepHeading(Lucide.FolderOpen, labels.getString("projectsDesc"), labels.getString("projectsGuide"))
            content.menuText("empty")?.let { emptyLine(it) }
            items(shown.items, key = { it.key }) { item ->
                val row = item.row
                if (row != null) ExpandedTask { ReviewRow(model, row) } else ProjectCard(model, item.json, labels)
            }
        }
        else -> item(key = "completed") { CompletedStep(model, content, labels) }
    }
}

/** RN's small bordered card (a stale project, a calendar task): the title at 14/600 and core's second line. */
@Composable
private fun InfoCard(title: String, meta: String) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(meta, style = rnText(12, 400), color = c.secondaryText)
    }
}

/** RN's calendar column card: core's heading in capitals, then its lines. */
@Composable
private fun CalendarColumn(title: String, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(modifier.fillMaxWidth().heightIn(min = 140.dp).clip(shape).background(c.cardBg).border(1.dp, c.border, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 0.4f), color = c.secondaryText)
        content()
    }
}

/** One external calendar day (core's day card), its first events and core's "+N more" to fold the rest in and out. */
@Composable
private fun DayCard(menu: MenuModel, day: JSONObject, labels: JSONObject) {
    val c = LocalTheme.current.colors
    val key = day.getString("key")
    val open = menu.own("weekly").optJSONObject("days")?.optBoolean(key) == true
    val events = day.getJSONObject("events").menuObjects("items")
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.border, shape).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(day.getString("title"), style = rnText(12, 700), color = c.secondaryText)
        for (event in if (open) events else events.take(day.getInt("previewCount"))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(event.getString("timeLabel"), style = rnText(12, 400), color = c.secondaryText)
                Text(event.getString("title"), style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        day.menuText("moreLabel")?.let { more ->
            Text(if (open) labels.getString("less") else more, style = rnText(12, 400).copy(textDecoration = TextDecoration.Underline), color = c.secondaryText,
                modifier = Modifier.clickable(role = Role.Button) { menu.editOwn("weekly") { put("days", (optJSONObject("days") ?: JSONObject()).put(key, !open)) } })
        }
    }
}

/** RN's context card: the context and core's task count, its first tasks (all while open, More for core's next window), and core's more/less. */
@Composable
private fun ContextCard(model: InboxViewModel, shown: MenuPage, card: JSONObject, preview: Int, labels: JSONObject) {
    val menu = model.menu
    val c = LocalTheme.current.colors
    val context = card.getString("context")
    val name = "contextTasks:$context"
    val open = menu.own("weekly").optJSONObject("contexts")?.optBoolean(context) == true
    val tasks = shown.collection(name)
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(bottom = 10.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            Text(context, style = rnText(14, 700), color = c.text)
            Text("${shown.collectionTotal(name)}", style = rnText(12, 600), color = c.secondaryText)
        }
        for (task in if (open) tasks else tasks.take(preview)) {
            Text(task.getString("title"), style = rnText(13, 500), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().hairline(c.border, top = true).clickable(enabled = menu.idle, role = Role.Button) { model.openEditor(task.getString("id")) }
                    .padding(horizontal = 10.dp, vertical = 8.dp))
        }
        if (open && tasks.size < shown.collectionTotal(name)) Box(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) { MoreChip(menu.idle) { menu.loadCollection(name) } }
        card.menuText("moreLabel")?.let { more ->
            Text(if (open) labels.getString("less") else more, style = rnText(12, 400), color = c.secondaryText, modifier = Modifier
                .clickable(role = Role.Button) { menu.editOwn("weekly") { put("contexts", (optJSONObject("contexts") ?: JSONObject()).put(context, !open)) } }
                .padding(start = 10.dp, end = 10.dp, top = 2.dp, bottom = 8.dp))
        }
    }
}

/** RN's project card: core's area dot, title, Add task, core's badge and count, and the fold glyph; a tap expands it (core's expanded project). */
@Composable
private fun ProjectCard(model: InboxViewModel, project: JSONObject, labels: JSONObject) {
    val menu = model.menu
    val c = LocalTheme.current.colors
    val id = project.getString("id")
    val title = project.getString("title")
    val expanded = project.getBoolean("expanded")
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.padding(bottom = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
        .clickable(enabled = menu.idle, role = Role.Button) { menu.expandProject(id) }.semantics { contentDescription = title }.padding(12.dp)) {
        Row(Modifier.padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(end = 8.dp).size(12.dp).clip(CircleShape).background(coreColorOrNull(project.menuText("areaColor")) ?: c.tint))
            Text(title, style = rnText(16, 600), color = c.text, modifier = Modifier.weight(1f))
            val small = RoundedCornerShape(8.dp)
            Text(labels.getString("addTask"), style = rnText(12, 600), color = c.text, modifier = Modifier.padding(end = 8.dp).clip(small).border(1.dp, c.border, small)
                .clickable(enabled = menu.idle, role = Role.Button) { menu.openProjectTask(id, title) }.padding(horizontal = 8.dp, vertical = 4.dp))
            val badge = project.getJSONObject("badge")
            Text(badge.getString("label"), style = rnText(12, 500), color = coreColorOrNull(badge.getString("color")) ?: c.text,
                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(coreColorOrNull(badge.getString("background")) ?: c.filterBg).padding(horizontal = 8.dp, vertical = 4.dp))
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(project.getString("countLabel"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(start = 20.dp))
            Text(if (expanded) "▾" else "▸", style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/** The expanded project's rows: indented, with RN's blue rule on their left. */
@Composable
private fun ExpandedTask(content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    Box(Modifier.padding(start = 12.dp).drawBehind { drawLine(theme.reviewProgress, Offset(1.dp.toPx(), 0f), Offset(1.dp.toPx(), size.height), 2.dp.toPx()) }
        .padding(start = 10.dp)) { content() }
}

/** RN's last step: the party popper, core's heading and words, this week's look-back and core's checks, and the Mind Sweep nudge. */
@Composable
private fun CompletedStep(model: InboxViewModel, content: JSONObject, labels: JSONObject) {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Lucide.PartyPopper, null, tint = c.tint, modifier = Modifier.padding(bottom = 20.dp).size(64.dp))
        Text(labels.getString("reviewComplete"), style = rnText(28, 700), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 12.dp))
        Text(labels.getString("completeDesc"), style = rnText(16, 400), color = c.secondaryText, textAlign = TextAlign.Center,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 32.dp))
        val shape = RoundedCornerShape(10.dp)
        Column(Modifier.padding(bottom = 16.dp).fillMaxWidth().clip(shape).border(1.dp, c.border, shape).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            content.optJSONObject("week")?.let { week ->
                Column(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(week.getString("heading"), style = rnText(14, 600), color = c.secondaryText)
                    val rows = week.getJSONArray("rows")
                    for (index in 0 until rows.length()) SummaryRow(true, rows.getString(index))
                }
            }
            for (check in content.menuObjects("checks")) SummaryRow(check.getBoolean("good"), check.getString("text"))
        }
        val card = RoundedCornerShape(12.dp)
        Column(Modifier.padding(bottom = 16.dp).fillMaxWidth().clip(card).background(c.cardBg).border(1.dp, c.border, card).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(labels.getString("mindSweepTitle"), style = rnText(15, 700), color = c.text)
                Text(labels.getString("mindSweepIntro"), style = rnText(13, 400, 19), color = c.secondaryText)
            }
            MindSweepLink(labels.getString("mindSweep"), bordered = true, enabled = model.menu.idle) { model.menu.openMindSweep() }
        }
    }
}

@Composable
private fun SummaryRow(good: Boolean, text: String) {
    val c = LocalTheme.current.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (good) Icon(Lucide.CheckCircle2, null, tint = c.success, modifier = Modifier.size(16.dp))
        else Box(Modifier.size(8.dp).clip(CircleShape).background(c.warning))
        Text(text, style = rnText(14, 400), color = if (good) c.secondaryText else c.text, modifier = Modifier.weight(1f))
    }
}

/** RN's Mind Sweep button (the Inbox step's link, the summary's bordered pill): it opens RN's Mind Sweep over the review. */
@Composable
private fun MindSweepLink(label: String, bordered: Boolean = false, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(18.dp)
    Row(Modifier.fade(if (enabled) 1f else 0.45f).heightIn(min = if (bordered) 36.dp else 44.dp).then(if (bordered) Modifier.clip(shape).border(1.dp, c.tint, shape) else Modifier)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).then(if (bordered) Modifier.padding(horizontal = 12.dp) else Modifier), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (bordered) 6.dp else 8.dp)) {
        Icon(Lucide.Brain, null, tint = c.tint, modifier = Modifier.size(if (bordered) 16.dp else 18.dp))
        Text(label, style = rnText(if (bordered) 13 else 15, if (bordered) 700 else 600), color = c.tint)
        if (!bordered) Icon(Lucide.ChevronRight, null, tint = c.tint, modifier = Modifier.size(16.dp))
    }
}

/**
 * RN's project Add task prompt: core's Add task title, the project, the field with core's placeholder, and Cancel, Save & edit
 * and Add. Save sends core's addProjectTask with a request UUID that becomes the task's id, on disk before the call; while its
 * retry is owed the field is locked and Add (or Save & edit) sends it again.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectTaskPrompt(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val labels = page?.view?.optJSONObject("labels") ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val action = createAction()
    val owed = model.failedAction != null && model.failedAction == action
    val canSave = action != null && model.writable && !model.busy && (model.failedAction == null || owed)
    val text = open.optString("text")
    Box(Modifier.fillMaxSize().background(theme.promptScrim).pointerInput(Unit) { detectTapGestures { } }.imePadding().padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape).padding(16.dp)) {
            Text(labels.getString("addTask"), style = rnText(18, 700), color = c.text, modifier = Modifier.semantics { heading() })
            Text(open.getString("title"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            val field = RoundedCornerShape(8.dp)
            BasicTextField(text, { typeDialog(it) }, enabled = !owed && !model.busy, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text),
                cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (canSave) { keepDialog(JSONObject(open.toString()).put("edit", false)); saveCreate() } }),
                modifier = Modifier.padding(top = 12.dp).fillMaxWidth().focusRequester(focus).semantics { contentDescription = labels.getString("addTaskPlaceholder") }
                    .testTag("menu-dialog-field"),
                decorationBox = { inner ->
                    Box(Modifier.heightIn(min = 44.dp).clip(field).background(c.bg).border(1.dp, c.border, field).padding(10.dp), contentAlignment = Alignment.CenterStart) {
                        if (text.isEmpty()) Text(labels.getString("addTaskPlaceholder"), style = rnText(15, 400), color = c.secondaryText)
                        inner()
                    }
                })
            FlowRow(Modifier.padding(top = 14.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PromptButton(labels.getString("cancel"), c.text, !owed && !model.busy, filled = false) { keepDialog(null) }
                PromptButton(labels.getString("saveAndEdit"), c.text, canSave, filled = false) { keepDialog(JSONObject(open.toString()).put("edit", true)); saveCreate() }
                PromptButton(labels.getString("add"), theme.filledText, canSave, filled = true) { keepDialog(JSONObject(open.toString()).put("edit", false)); saveCreate() }
            }
        }
    }
}

@Composable
private fun PromptButton(label: String, color: Color, enabled: Boolean, filled: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(8.dp)
    Text(label, style = rnText(14, 600), color = color, modifier = Modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = 44.dp).clip(shape)
        .then(if (filled) Modifier.background(theme.filledBg) else Modifier.border(1.dp, theme.colors.border, shape))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .padding(horizontal = 12.dp, vertical = 12.dp))
}

/** A review step: core's checkpoint for Back or Next, kept under core's key, then read from its first window. */
internal fun MenuModel.step(checkpoint: String) {
    val key = page?.view?.optString("storageKey")?.ifEmpty { null } ?: return
    prefs.edit().putString(key, checkpoint).apply()
    reload(fresh = true)
}

/** Finish: core's lastReviewAt under its key (the Weekly Review), the checkpoint deleted, and the review closes, as RN's handleFinish. */
internal fun MenuModel.finishReview() {
    val view = page?.view ?: return
    view.optJSONObject("finish")?.let { finish -> finish.menuText("lastReviewKey")?.let { prefs.edit().putString(it, finish.getString("lastReviewAt")).apply() } }
    prefs.edit().remove(view.getString("storageKey")).apply()
    closeScreen()
}

/** RN's toggleExpandedProject: core's expanded project (one at a time), read again. */
internal fun MenuModel.expandProject(id: String) {
    editOwn("weekly") { put("expandedProjectId", if (optString("expandedProjectId") == id) JSONObject.NULL else id) }
    reload()
}

/** RN's project Add task prompt, with a new request UUID for the task it creates. */
internal fun MenuModel.openProjectTask(projectId: String, title: String) = keepDialog(JSONObject().put("kind", "projectTask").put("projectId", projectId)
    .put("title", title).put("text", "").put("requestId", UUID.randomUUID().toString()))
