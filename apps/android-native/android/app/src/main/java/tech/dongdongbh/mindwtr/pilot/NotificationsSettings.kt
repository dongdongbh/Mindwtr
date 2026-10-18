package tech.dongdongbh.mindwtr.pilot

import android.Manifest
import android.app.TimePickerDialog
import android.content.Context
import android.text.format.DateFormat
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import java.util.Locale
import org.json.JSONObject
import tech.dongdongbh.mindwtr.notificationopenintents.PersistentCaptureNotifier
import tech.dongdongbh.mindwtr.pilot.core.CoreHost

/*
 * RN's Settings › Notifications (components/settings/notifications-settings-screen.tsx) on core's getNotificationsSettings: three
 * cards, every word, value, dimmed row and edit core's. A switch core marks `askPermission` asks for Android's notification
 * permission first and sends its edit only once it is granted (RN's ensureNotificationsPermission); a time row opens Android's
 * time picker (RN's DateTimePicker, display "default") and sends the picked time; the day row opens RN's day picker.
 */

@Composable
internal fun NotificationsSettings(model: InboxViewModel, view: JSONObject) = with(model.menu.settings) {
    val context = LocalContext.current
    val theme = LocalTheme.current
    val reminders = view.getJSONObject("reminders")
    val weekly = view.getJSONObject("weeklyReview")
    val digest = view.getJSONObject("dailyDigest")
    // The edit a permission request waits for; a granted permission sends it, a refusal drops it, as RN's does.
    var waiting by rememberSaveable { mutableStateOf<String?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        waiting?.let { edit -> if (granted) notifications(JSONObject(edit)) }
        waiting = null
    }
    val send = { toggle: JSONObject ->
        val edit = toggle.getJSONObject("edit")
        if (toggle.getBoolean("askPermission") && !ReminderAlarms.permissionGranted(context)) {
            waiting = edit.toString()
            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else notifications(edit)
    }
    val enabled = model.failedAction == null && model.menu.idle
    @Composable fun Toggle(toggle: JSONObject, divider: Boolean) {
        val label = toggle.getString("label")
        val off = toggle.getBoolean("disabled")
        SettingRow(label, toggle.menuText("description"), divider, dimmed = off) {
            RnSwitch(toggle.getBoolean("value"), enabled && !off, label, theme.settingsSwitch) { send(toggle) }
        }
    }
    @Composable fun Pressable(row: JSONObject, open: () -> Unit) {
        val label = row.getString("label")
        val value = row.getString("description")
        val on = enabled && !row.getBoolean("disabled")
        SettingRow(label, value, true, Modifier.clearAndSetSemantics {
            contentDescription = "$label: $value"; role = Role.Button; if (on) onClick { open(); true } else disabled()
        }.clickable(enabled = on, onClick = open), dimmed = row.getBoolean("disabled"))
    }
    val time = { row: JSONObject -> { pickTime(context, row) { picked -> notifications(JSONObject().put("type", row.getString("type")).put("value", picked)) } } }

    Card {
        Toggle(reminders.getJSONObject("enable"), false)
        Pressable(reminders.getJSONObject("taskDefault")) { model.menu.keepDialog(JSONObject().put("kind", "settingsPicker").put("picker", "taskReminderDefault")) }
        Toggle(reminders.getJSONObject("startReminders"), true)
        Toggle(reminders.getJSONObject("dueReminders"), true)
        // RN's exact-alarm row while a notification feature is on: shown only while Android 12+ denies exact alarms, read again on
        // each resume; Allow opens Android's Alarms & reminders page.
        reminders.optJSONObject("exactAlarmNotice")?.let { notice ->
            val denied = remember(model.resumes) { ReminderAlarms.exactAlarmsDenied(context) }
            if (denied) SettingRow(notice.getString("label"), notice.getString("description"), true, Modifier.testTag("exact-alarm-notice")) {
                val action = notice.getString("actionLabel")
                val shape = RoundedCornerShape(10.dp)
                // RN's manageEditorButton, primary: #2563eb, white 14/600.
                Box(Modifier.widthIn(min = 92.dp).heightIn(min = 42.dp).clip(shape).background(ALLOW_BLUE).border(1.dp, ALLOW_BLUE, shape)
                    .clearAndSetSemantics { testTag = "exact-alarm-allow"; contentDescription = action; role = Role.Button; onClick { ReminderAlarms.openExactAlarmSettings(context); true } }
                    .clickable { ReminderAlarms.openExactAlarmSettings(context) }.padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center) {
                    Text(action, style = rnText(14, 600), color = Color.White)
                }
            }
        }
        reminders.optJSONObject("persistentCapture")?.let { Toggle(it, true) }
    }
    Card(top = 12) {
        Toggle(weekly.getJSONObject("enable"), false)
        Pressable(weekly.getJSONObject("day")) { model.menu.keepDialog(JSONObject().put("kind", "settingsPicker").put("picker", "weeklyReviewDay")) }
        weekly.getJSONObject("time").let { Pressable(it, time(it)) }
    }
    Card(top = 12) {
        SettingRow(digest.getString("label"), digest.getString("description"))
        Toggle(digest.getJSONObject("morning"), true)
        digest.getJSONObject("morningTime").let { Pressable(it, time(it)) }
        Toggle(digest.getJSONObject("evening"), true)
        digest.getJSONObject("eveningTime").let { Pressable(it, time(it)) }
    }
}

/** RN's manageEditorButtonPrimary. */
private val ALLOW_BLUE = Color(0xFF2563EB)

/** RN's Android time picker for [row] (core's hour and minute), in the device's 12/24-hour format; [picked] gets 'HH:MM'. */
private fun pickTime(context: Context, row: JSONObject, picked: (String) -> Unit) {
    TimePickerDialog(context, { _, hour, minute -> picked(coreTime(hour, minute)) }, row.getInt("hour"), row.getInt("minute"),
        DateFormat.is24HourFormat(context)).show()
}

/** Core's 'HH:MM' in ASCII digits whatever the device's language (Arabic and Persian format digits of their own). */
internal fun coreTime(hour: Int, minute: Int): String = String.format(Locale.ROOT, "%02d:%02d", hour, minute)

/**
 * RN's persistent capture notification (PersistentCaptureNotifier.kt, RN's own Kotlin): posted or removed as core says, and posted
 * again at start and on every resume while it is on and notifications are allowed (RN's keepPersistentCaptureNotificationArmed).
 */
internal object PersistentCapture {
    /** The line Settings › Diagnostics shows for a notification that was not posted or removed (docs/release-notes/diagnostics-ledger.md). */
    const val FAILED = "Native Android persistent capture notification not applied releaseCheck=v1.3.5/native-persistent-capture"
    /** Held by every post, removal and process-start restore, so a removal never runs between a restore's read and its post. */
    private val LOCK = Any()
    /** A process start's failure, kept here (no engine runs yet) until the next boot's restore logs it. */
    private const val PREFS = "mindwtr_persistent_capture_host"
    private const val START_FAILURE = "startFailure"

    /** Core's `{ post }`: the title, text and channel's name to post, or null to remove it. A failure goes to [log] (core's log). */
    fun apply(context: Context, reply: JSONObject, log: (String, JSONObject) -> Unit) = guarded(log) {
        val post = reply.optJSONObject("post")
        synchronized(LOCK) {
            if (post == null) PersistentCaptureNotifier.cancel(context)
            else PersistentCaptureNotifier.post(context, post.getString("title"), post.getString("text"), post.getString("channelName"))
        }
    }

    /**
     * RN's process-start restore (NotificationOpenIntentsPackage) from the notifier's own mirror, before any engine: a receiver,
     * a widget or the app. Its failure is kept for the next boot's [restore].
     */
    fun restoreAtProcessStart(context: Context) = startWith(restore = { PersistentCaptureNotifier.restoreOnProcessStart(context) },
        keep = { failure -> context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(START_FAILURE, failure).commit() })

    internal fun startWith(restore: () -> Unit, keep: (String) -> Unit) {
        runCatching { synchronized(LOCK) { restore() } }.onFailure {
            runCatching { keep(it.javaClass.simpleName.take(64)) }
            runCatching { Log.w(CoreHost.TAG, "Native Android persistent capture notification not restored at process start", it) }
        }
    }

    /**
     * RN's restore with core's answer applied whole: on, it is posted again (only with the notification permission, which is never
     * asked for here); off, it is removed, so an off whose removal never ran (the process died after the key went) does not stay
     * pinned from the notifier's mirror.
     */
    fun restore(context: Context, runtime: CoreHost) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        restoreWith(read = { runtime.menuRead("persistentCaptureNotification", "{}") }, granted = { ReminderAlarms.permissionGranted(context) },
            apply = { reply -> apply(context, reply, runtime::logLine) }, log = runtime::logLine,
            startFailure = { prefs.getString(START_FAILURE, null)?.also { prefs.edit().remove(START_FAILURE).commit() } })
    }

    /** [restore] apart from Android (JVM-tested: PersistentCaptureTest). */
    internal fun restoreWith(read: () -> JSONObject, granted: () -> Boolean, apply: (JSONObject) -> Unit, log: (String, JSONObject) -> Unit,
        startFailure: () -> String? = { null }) {
        runCatching { startFailure() }.getOrNull()?.let { failure -> runCatching { log(FAILED, JSONObject().put("error", failure).put("path", "process-start")) } }
        guarded(log) {
            val reply = read()
            if (reply.isNull("post") || granted()) apply(reply)
        }
    }

    /** [block], its failure in Settings › Diagnostics (core's log) and logcat: no screen shows a notification that was not posted. */
    private fun guarded(log: (String, JSONObject) -> Unit, block: () -> Unit) {
        runCatching(block).onFailure {
            runCatching { log(FAILED, JSONObject().put("error", it.javaClass.simpleName)) }
            runCatching { Log.w(CoreHost.TAG, "Native Android persistent capture notification not applied releaseCheck=v1.3.5/native-persistent-capture", it) }
        }
    }
}
