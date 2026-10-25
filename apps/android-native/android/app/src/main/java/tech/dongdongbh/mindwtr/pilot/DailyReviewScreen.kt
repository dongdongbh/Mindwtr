package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * RN's Daily Review (components/daily-review-modal.tsx) on core's getDailyReview and runReviewAction: the header (Close, core's
 * title, the step's title and "Step n of m"), core's step (Today with its count and the calendar's two days, Focus with RN's
 * stars, Inbox with Process Inbox, Waiting with Follow up today), RN's toast, and Back and Next (or Finish) at core's
 * checkpoints. The step is core's checkpoint, kept on the device under core's key.
 */
@Composable
fun DailyReview(model: InboxViewModel) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shown = page
    val view = shown?.view
    Column(Modifier.fillMaxSize().background(c.bg).testTag("daily-review")) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            val close = view?.optString("closeLabel") ?: t("common.close")
            Box(Modifier.size(32.dp).clickable(enabled = model.failedAction == null, role = Role.Button) { closeScreen() }.semantics { contentDescription = close },
                contentAlignment = Alignment.Center) { Icon(Lucide.X, null, tint = c.text, modifier = Modifier.size(22.dp)) }
            Column(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                view?.let {
                    val step = it.getJSONObject("step")
                    Text(it.getString("title"), style = rnText(11, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 1.dp))
                    Text(step.getString("title"), style = rnText(16, 700, 20), color = c.text, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() }.testTag("review-step-title"))
                    Text(step.getString("label"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp).testTag("review-step-indicator"))
                }
            }
            Box(Modifier.size(28.dp))
        }
        Rule()
        model.error?.let { message ->
            FailureBanner(message) {
                if (model.failedAction == null) TextButton(onClick = { retryRead() }, enabled = !model.busy, modifier = Modifier.testTag("read-retry")) { Text(t("common.retry")) }
                else OwedRetry(model)
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (shown != null) LazyColumn(Modifier.fillMaxSize().testTag("review-step-scroll"), contentPadding = PaddingValues(20.dp)) {
                dailyContent(model, shown)
                if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
            }
            ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp))
        }
        Rule()
        if (view != null) Row(Modifier.fillMaxWidth().background(c.cardBg).padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val finish = view.optJSONObject("finish")
            if (finish != null) FooterButton(finish.getString("label"), true, Modifier.weight(1f), model.failedAction == null) { finishReview() }
            else {
                val back = view.optJSONObject("back")
                val previous = back?.menuText("checkpoint")
                back?.let { FooterButton(it.getString("label"), false, Modifier.weight(1f), previous != null && idle) { previous?.let { checkpoint -> step(checkpoint) } } }
                view.optJSONObject("next")?.let { next -> FooterButton(next.getString("label"), true, Modifier.weight(1f), idle) { step(next.getString("checkpoint")) } }
            }
        }
    }
}

/** RN's Daily Review footer button: filled (Next, Finish) or the filter background (Back), dimmed while unavailable. */
@Composable
private fun FooterButton(label: String, filled: Boolean, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(modifier.fade(if (enabled || filled) 1f else 0.5f).clip(RoundedCornerShape(12.dp)).background(if (filled) theme.filledBg else theme.colors.filterBg)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label; if (!enabled) disabled() }
        .padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 700), color = if (filled) theme.filledText else theme.colors.text)
    }
}

/** RN's info box: core's count in bold with its noun, then the step's description. */
private fun LazyListScope.infoBox(count: Int, unit: String, description: String) = item(key = "info") {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.padding(bottom = 14.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("$count") }; append(" $unit") }, style = rnText(14, 700), color = c.text)
        Text(description, style = rnText(13, 400, 18), color = c.secondaryText)
    }
}

/** A step's empty state: RN's 48 glyph at stroke 1.5 over core's line. */
private fun LazyListScope.dailyEmpty(icon: ImageVector, text: String) = item(key = "empty") {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 30.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(48.dp).fade(0.9f))
        Text(text, style = rnText(14, 400, 20), color = c.secondaryText, textAlign = TextAlign.Center)
    }
}

/** Core's step content, as RN's renderStep draws it. */
private fun LazyListScope.dailyContent(model: InboxViewModel, shown: MenuPage) {
    val menu = model.menu
    val view = shown.view
    val content = view.getJSONObject("content")
    val description = view.getJSONObject("step").getString("description")
    val stepId = content.getString("step")
    if (stepId == "completed") {
        item(key = "completed") {
            val c = LocalTheme.current.colors
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Icon(Lucide.CheckCircle2Thin, null, tint = c.tint, modifier = Modifier.padding(bottom = 6.dp).size(56.dp))
                Text(description, style = rnText(14, 400, 20), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp))
            }
        }
        return
    }
    infoBox(content.getInt("count"), content.getString("unit"), description)
    if (stepId == "today") item(key = "calendar") { TodayCalendar(menu, content.getJSONObject("calendar")) }
    content.menuText("processLabel")?.let { process ->
        item(key = "process") {
            val theme = LocalTheme.current
            Row(Modifier.padding(bottom = 14.dp).clip(CircleShape).background(theme.filledBg).clickable(enabled = menu.idle, role = Role.Button) { model.openProcessing() }
                .semantics { contentDescription = process }.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Lucide.PlayFilled, null, tint = theme.filledText, modifier = Modifier.size(14.dp))
                Text(process, style = rnText(12, 700), color = theme.filledText)
            }
        }
    }
    items(shown.items, key = { it.key }) { item ->
        val row = item.row ?: return@items
        val json = item.json
        val followUp = json.optJSONObject("followUp")
        TaskRowItem(model, row, status = if (json.optBoolean("hideStatusBadge")) RowStatus.Hidden else RowStatus.Badge,
            star = if (json.optBoolean("showFocusToggle")) RowStar.Shown else RowStar.Hidden, actions = RowActions(
                status = { status -> menu.act("reviewAction", setTaskStatus(row.id, status, row.taskRevision)) },
                delete = { menu.act("reviewAction", trashTask(row.id, row.taskRevision)) },
                footer = followUp?.let { { FollowUpButton(menu, row, it) } },
            ))
    }
    content.menuText("empty")?.let { empty ->
        dailyEmpty(when (stepId) { "today" -> Lucide.SparklesThin; "focus" -> Lucide.StarThin; else -> Lucide.CheckCircle2Thin }, empty)
    }
}

/** RN's Follow up today on a waiting row: core's label; disabled (and dimmed) once the task is due for review, as core says. */
@Composable
private fun FollowUpButton(menu: MenuModel, row: TaskRow, followUp: JSONObject) {
    val c = LocalTheme.current.colors
    val due = followUp.getBoolean("due")
    val enabled = !due && menu.idle
    Row(Modifier.fade(if (due) 0.7f else 1f).padding(top = 4.dp).heightIn(min = 32.dp).clip(RoundedCornerShape(8.dp)).background(c.filterBg)
        .clickable(enabled = enabled, role = Role.Button) { menu.act("reviewAction", followUpToday(row.id, row.taskRevision)) }
        .semantics { contentDescription = followUp.getString("accessibilityLabel"); if (due) disabled() }
        .padding(horizontal = 9.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Lucide.Clock, null, tint = if (due) c.secondaryText else c.tint, modifier = Modifier.size(13.dp))
        Text(followUp.getString("label"), style = rnText(11, 700), color = if (due) c.secondaryText else c.tint)
    }
}

/** RN's Today calendar: the Events toggle with core's count, then today's and tomorrow's cards with core's notice or events. */
@Composable
private fun TodayCalendar(menu: MenuModel, calendar: JSONObject) {
    val c = LocalTheme.current.colors
    val open = !menu.own("daily").has("calendarClosed")
    val label = calendar.getString("label")
    val count = calendar.getInt("count")
    Column(Modifier.padding(bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val shape = RoundedCornerShape(12.dp)
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .clickable(role = Role.Button) { menu.editOwn("daily") { if (open) put("calendarClosed", true) else remove("calendarClosed") } }
            .semantics { contentDescription = label }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Lucide.Calendar, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                Text(label, style = rnText(13, 700), color = c.text)
                Box(Modifier.widthIn(min = 28.dp).height(24.dp).clip(CircleShape).background(c.filterBg).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                    Text("$count", style = rnText(12, 700), color = c.secondaryText)
                }
            }
            Icon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        }
        if (open) for (day in calendar.menuObjects("days")) {
            Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(day.getString("title").uppercase(), style = rnText(11, 700, letterSpacing = 0.4f), color = c.secondaryText)
                day.menuText("notice")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
                for (event in day.menuObjects("events")) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(event.getString("title"), style = rnText(13, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(event.getString("timeLabel"), style = rnText(12, 400), color = c.secondaryText, maxLines = 1)
                    }
                }
            }
        }
    }
}
