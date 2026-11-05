package tech.dongdongbh.mindwtr.pilot

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.notificationopenintents.PersistentCaptureNotifier
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.RnKeyValue
import tech.dongdongbh.mindwtr.pilot.core.debugProperty


internal object ReminderPlan {

    const val MAP_KEY = "mindwtr:local:alarms:v1"

    const val STATE_KEY = "mindwtr:native:reminders:v1"

    interface Port {

        fun store(entries: Map<String, String>)

        fun removeDelivered(id: Int)
        fun cancel(id: Int)

        fun schedule(alarm: JSONObject)

        fun clearDelivered()

        fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) {}
    }


    fun apply(plan: JSONObject, port: Port, checkpoint: (String) -> Unit = {}): Int {
        val ahead = buildMap {
            if (!plan.isNull("writeAhead")) put(MAP_KEY, plan.getString("writeAhead"))
            if (plan.has("stateAhead") && !plan.isNull("stateAhead")) put(STATE_KEY, plan.getString("stateAhead"))
        }
        if (ahead.isNotEmpty()) {
            port.store(ahead)
            checkpoint("write-ahead")
        }
        val cancel = plan.getJSONArray("cancel")
        val schedule = plan.getJSONArray("schedule")
        val refused = mutableListOf<String>()

        port.record(cancelled = List(cancel.length()) { cancel.getJSONObject(it).getInt("id") },
            armed = List(schedule.length()) { schedule.getJSONObject(it).let { alarm -> alarm.getInt("id") to alarm.getLong("fireAtMs") } })
        for (index in 0 until cancel.length()) {
            val item = cancel.getJSONObject(index)
            val id = item.getInt("id")
            if (item.getString("reason") == "withdrawn") runCatching { port.removeDelivered(id) }
            port.cancel(id)
        }
        for (index in 0 until schedule.length()) {
            val alarm = schedule.getJSONObject(index)
            if (alarm.optString("replacing") == "withdrawn") runCatching { port.removeDelivered(alarm.getInt("id")) }
            try {
                port.schedule(alarm)
            } catch (failure: RuntimeException) {
                refused += alarm.getString("key")

                runCatching { port.cancel(alarm.getInt("id")) }
            }
        }
        checkpoint("scheduled")
        if (plan.optBoolean("clearDelivered")) runCatching { port.clearDelivered() }

        val after = buildMap {
            if (!plan.optBoolean("unchanged")) put(MAP_KEY, if (refused.isEmpty()) plan.getString("alarms") else pendingAgain(plan, refused))

            val snoozeRefused = refused.isNotEmpty() && plan.has("stateAhead") && !plan.isNull("stateAhead")
            if (plan.has("state") && !plan.isNull("state") && !snoozeRefused) put(STATE_KEY, plan.getString("state"))
        }
        if (after.isNotEmpty()) port.store(after)
        return refused.size
    }


    private fun pendingAgain(plan: JSONObject, refused: List<String>): String {
        val ahead = if (plan.isNull("writeAhead")) JSONObject() else JSONObject(plan.getString("writeAhead"))
        val alarms = JSONObject(plan.getString("alarms"))
        for (key in refused) ahead.optJSONObject(key)?.let { alarms.put(key, it) } ?: alarms.remove(key)
        return alarms.toString()
    }
}


internal class ReminderReceiverCounts(private val read: (String) -> Int, private val write: (Map<String, Int>) -> Unit) {
    companion object {
        const val DROPPED = "dropped"
        const val NOT_QUEUED = "notQueued"
        private const val PREFS = "mindwtr_reminder_receiver"

        fun of(context: Context): ReminderReceiverCounts {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return ReminderReceiverCounts(read = { prefs.getInt(it, 0) },
                write = { values -> prefs.edit().apply { values.forEach { (name, value) -> putInt(name, value) } }.commit() })
        }
    }

    fun add(name: String) = synchronized(ReminderAlarms.LOCK) { write(mapOf(name to read(name) + 1)) }

    fun take(): JSONObject = synchronized(ReminderAlarms.LOCK) {
        JSONObject().put(DROPPED, read(DROPPED)).put(NOT_QUEUED, read(NOT_QUEUED))
            .also { taken -> if (taken.getInt(DROPPED) + taken.getInt(NOT_QUEUED) > 0) write(mapOf(DROPPED to 0, NOT_QUEUED to 0)) }
    }
}


internal class ReminderLedger(private val read: () -> Map<Int, String>, private val write: (Map<Int, String?>) -> Boolean) {
    companion object {

        const val ONE_SHOT_LATE_LIMIT_MS = 24 * 60 * 60 * 1000L
        private const val PREFS = "mindwtr_reminder_ledger"

        fun of(context: Context): ReminderLedger {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return ReminderLedger(read = { prefs.all.mapNotNull { (id, value) -> id.toIntOrNull()?.let { it to value.toString() } }.toMap() },
                write = { changes -> prefs.edit().apply { changes.forEach { (id, value) -> if (value == null) remove("$id") else putString("$id", value) } }.commit() })
        }
    }


    fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) {
        val held = read()
        val changes = cancelled.filter { it in held }.associateWith { null as String? } +
            armed.filter { (id, at) -> held[id] != "armed:$at" }.associate { (id, at) -> id to "armed:$at" }

        if (changes.isNotEmpty()) check(write(changes)) { "The reminder ledger was not written" }
    }


    fun deliver(id: Int, fireAtMs: Long, repeat: String, nowMs: Long): Boolean {
        if (read()[id] != "armed:$fireAtMs") return false
        if (repeat != "once") return true
        if (nowMs - fireAtMs > ONE_SHOT_LATE_LIMIT_MS) return false

        write(mapOf(id to "fired:$fireAtMs"))
        return true
    }

    fun fired(): List<Int> = read().filterValues { it.startsWith("fired:") }.keys.sorted()

    fun ids(): Set<Int> = read().keys


    fun clear() { read().keys.takeIf { it.isNotEmpty() }?.let { ids -> check(write(ids.associateWith { null })) { "The reminder ledger was not cleared" } } }
}


internal object RnAlarmCleanup {


    val FORGOTTEN_KEYS = listOf(ReminderPlan.MAP_KEY)


    fun run(rows: () -> List<List<Int>>?, cancel: (Int) -> Unit, cancelNative: () -> Unit, stripButtons: () -> Unit, forgetMaps: () -> Unit,
            deleteTable: () -> Unit): Int {
        val ids = rows() ?: return 0
        ids.flatten().forEach(cancel)
        cancelNative()
        stripButtons()
        forgetMaps()
        deleteTable()
        return ids.size
    }


    fun requestCodes(rows: List<String?>): List<List<Int>> = rows.map { row ->
        val data = runCatching { JSONObject(row!!) }.getOrElse { throw IllegalStateException("An RN alarm row cannot be read", it) }
        val codes = data.keys().asSequence().mapNotNull { name ->
            (data.get(name) as? Number)?.toDouble()?.takeIf { it % 1.0 == 0.0 && it in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble() }?.toInt()
        }.distinct().toList()

        val named = data.optInt("alarmId", Int.MIN_VALUE).takeIf { data.has("alarmId") && it != Int.MIN_VALUE }
        val ordered = if (named != null) listOf(named) else codes.sorted()
        ordered.ifEmpty { throw IllegalStateException("An RN alarm row holds no request code fields=[${data.keys().asSequence().sorted().joinToString(",")}]") }
    }


    fun isMissingTable(failure: Throwable): Boolean = failure.message?.contains("no such table") == true
}


internal class ReminderStart<H : Any>(private val start: (H) -> JSONObject, private val cycle: (H) -> Unit) {

    @Volatile var reply: JSONObject? = null; private set
    @Volatile private var started: H? = null
    @Volatile private var failed: H? = null


    @Synchronized fun start(host: H): Boolean {
        if (started != null) return false
        failed = host
        reply = start.invoke(host)
        started = host
        failed = null
        return true
    }


    fun resume() {
        started?.let { cycle(it); return }
        failed?.let(::start)
    }
}


internal class ReminderAlarms(
    private val context: Context,
    private val keyValue: RnKeyValue,

    private val checkpointRnState: () -> Unit,
) : CoreHost.Reminders, ReminderPlan.Port {
    companion object {

        private const val RN_RECEIVER = "com.emekalites.react.alarm.notification.AlarmReceiver"
        private const val RN_DATABASE = "rnandb"
        const val FIRE = "tech.dongdongbh.mindwtr.reminder.FIRE"

        const val EXTRA_ALARM = "alarm"


        val LOCK = Any()

        private fun fireIntent(context: Context) = Intent(context, ReminderAlarmReceiver::class.java).setAction(FIRE)


        fun arm(context: Context, alarm: JSONObject) {
            val manager = context.getSystemService(AlarmManager::class.java)
            val intent = PendingIntent.getBroadcast(context, alarm.getInt("id"), fireIntent(context).putExtra(EXTRA_ALARM, alarm.toString()),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val at = alarm.getLong("fireAtMs")
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            }
        }


        fun exactAlarmsDenied(context: Context): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && !context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()


        fun openExactAlarmSettings(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
            runCatching { context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android exact-alarm settings not opened", it) }
        }


        fun permissionGranted(context: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private val alarms = context.getSystemService(AlarmManager::class.java)
    private val notifications = context.getSystemService(NotificationManager::class.java)

    private var channelName = ""

    override fun apply(plan: String): Int {
        val parsed = JSONObject(plan)
        channelName = parsed.optString("channelName")
        return synchronized(LOCK) { applyLocked(parsed) }
    }

    private fun applyLocked(parsed: JSONObject): Int = ReminderPlan.apply(parsed, this) { point ->

        if (debugProperty("reminder_stop") == point) {
            Log.i(CoreHost.TAG, "Native Android reminder stop at=$point")
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    override fun permissionGranted() = permissionGranted(context)

    override fun receiverCounts(): String = ReminderReceiverCounts.of(context).take().toString()

    override fun ledger(): String = synchronized(LOCK) {
        val shown = notifications.activeNotifications.filter { NotificationCompat.getChannelId(it.notification) == CoreNotifications.REMINDER_CHANNEL }
            .map(CoreNotifications::reminderAlarmId)
        JSONObject().put("fired", JSONArray(ReminderLedger.of(context).fired())).put("shown", JSONArray(shown)).toString()
    }

    override fun cleanupRn(): Int = RnAlarmCleanup.run(rows = ::rnAlarmIds, cancel = ::cancelRn, cancelNative = ::cancelEveryNative,
        stripButtons = ::stripRnButtons,

        forgetMaps = { keyValue.multiGet(RnAlarmCleanup.FORGOTTEN_KEYS).filterValues { it != null }.keys.toList()
            .takeIf { it.isNotEmpty() }?.let { keys -> beforeWrite(); keyValue.multiRemove(keys) }; Unit },
        deleteTable = { check(context.deleteDatabase(RN_DATABASE) || !context.getDatabasePath(RN_DATABASE).exists()) { "Cannot delete $RN_DATABASE" } })

    override fun store(entries: Map<String, String>) {
        beforeWrite()
        keyValue.multiSet(entries.toList())
    }

    private var checkpointed = false

    private fun beforeWrite() {
        if (checkpointed) return
        checkpointRnState()
        checkpointed = true
    }

    override fun removeDelivered(id: Int) = CoreNotifications.cancelReminder(context, id)

    override fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) = ReminderLedger.of(context).record(cancelled, armed)

    override fun cancel(id: Int) {
        PendingIntent.getBroadcast(context, id, fireIntent(context), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let {
            alarms.cancel(it)
            it.cancel()
        }
    }

    override fun schedule(alarm: JSONObject) = arm(context, JSONObject(alarm.toString()).put("channelName", channelName))

    override fun clearDelivered() {
        for (shown in notifications.activeNotifications) {
            if (NotificationCompat.getChannelId(shown.notification) == CoreNotifications.REMINDER_CHANNEL) notifications.cancel(shown.tag, shown.id)
        }
    }


    private fun rnAlarmIds(): List<List<Int>>? {
        val file = context.getDatabasePath(RN_DATABASE)
        if (!file.exists()) return null
        return SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
            val cursor = try {
                database.rawQuery("SELECT gson_data FROM alarmtbl", null)
            } catch (failure: Exception) {
                if (RnAlarmCleanup.isMissingTable(failure)) return emptyList()
                throw failure
            }
            RnAlarmCleanup.requestCodes(cursor.use { rows -> buildList { while (rows.moveToNext()) add(rows.getString(0)) } })
        }
    }


    private fun cancelEveryNative() = synchronized(LOCK) {
        val ledger = ReminderLedger.of(context)
        ledger.ids().forEach(::cancel)
        ledger.clear()
    }


    private fun stripRnButtons() {
        for (shown in notifications.activeNotifications) {
            val notification = shown.notification
            if (NotificationCompat.getChannelId(notification) != CoreNotifications.REMINDER_CHANNEL || notification.actions.isNullOrEmpty()) continue
            notifications.notify(shown.tag, shown.id, Notification.Builder.recoverBuilder(context, notification).setActions().build())
        }
    }


    private fun cancelRn(id: Int) {
        val intent = Intent().setComponent(ComponentName(context.packageName, RN_RECEIVER))
        PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let {
            alarms.cancel(it)
            it.cancel()
        }
    }
}


class ReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ReminderAlarms.FIRE) return
        val alarm = runCatching { JSONObject(intent.getStringExtra(ReminderAlarms.EXTRA_ALARM)!!) }.getOrNull() ?: return
        val repeat = alarm.optString("repeat", "once")
        val shown = runCatching {
            synchronized(ReminderAlarms.LOCK) {
                ReminderLedger.of(context).deliver(alarm.getInt("id"), alarm.getLong("fireAtMs"), repeat, System.currentTimeMillis())
                    .also { if (it) CoreNotifications.postReminder(context, alarm) }
            }
        }.onFailure { Log.w(CoreHost.TAG, "Native Android reminder not posted", it) }.getOrDefault(false)
        if (!shown) {
            Log.i(CoreHost.TAG, "Native Android reminder delivery dropped repeat=$repeat")
            runCatching { ReminderReceiverCounts.of(context).add(ReminderReceiverCounts.DROPPED) }
        }
        if (repeat != "once") {
            runCatching { CoreWork.enqueueDurably(this, context, CoreJob.REMINDERS, mapOf("mode" to "fired", "key" to alarm.getString("key"))) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android repeating reminder not queued", it) }
        }
    }
}


class ReminderActionReceiver : BroadcastReceiver() {
    companion object {
        const val COMPLETE = "ACTION_COMPLETE"
        const val SNOOZE = "ACTION_SNOOZE"
        const val DISMISS = "ACTION_DISMISS"
        const val EXTRA_ID = "notificationId"
        const val EXTRA_REQUEST = "requestId"
        const val EXTRA_TASK = "taskId"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val dismiss = { CoreNotifications.cancelReminder(context, id) }
        runCatching {
            when (intent.action) {
                DISMISS -> dismiss()
                COMPLETE -> CoreWork.enqueueDurably(this, context, CoreJob.REMINDER_DONE, mapOf(
                    "requestId" to intent.getStringExtra(EXTRA_REQUEST)!!, "taskId" to intent.getStringExtra(EXTRA_TASK)!!), done = dismiss)
                SNOOZE -> {
                    val alarm = JSONObject(intent.getStringExtra(ReminderAlarms.EXTRA_ALARM)!!)
                    val details = alarm.getJSONObject("details")

                    debugProperty("snooze_minutes").toDoubleOrNull()?.let { details.put("snooze_interval", it) }
                    CoreWork.enqueueDurably(this, context, CoreJob.REMINDER_SNOOZE, mapOf("requestId" to intent.getStringExtra(EXTRA_REQUEST)!!,
                        "requestedAt" to System.currentTimeMillis().toString(), "details" to details.toString()), done = dismiss)
                }
                else -> Unit
            }
        }.onFailure { Log.w(CoreHost.TAG, "Native Android reminder action not queued action=${intent.action}", it) }
    }
}


class ReminderRescheduleReceiver : BroadcastReceiver() {
    companion object {

        const val DEBUG_RESCHEDULE = "tech.dongdongbh.mindwtr.debug.RESCHEDULE_REMINDERS"
        private val ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_MY_PACKAGE_REPLACED, AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action !in ACTIONS && !(action == DEBUG_RESCHEDULE && BuildConfig.DEBUG)) return


        if (action == DEBUG_RESCHEDULE && BuildConfig.DEBUG && intent.getBooleanExtra("cancelCaptureNotification", false)) {
            context.getSystemService(NotificationManager::class.java).cancel(PersistentCaptureNotifier.NOTIFICATION_ID)
            return
        }

        if (action == DEBUG_RESCHEDULE && BuildConfig.DEBUG && intent.hasExtra("cancelReminderId")) {
            intent.getStringExtra("replacementAlarm")?.let { CoreNotifications.postReminder(context, JSONObject(it)) }
            CoreNotifications.cancelReminder(context, intent.getIntExtra("cancelReminderId", 0))
            return
        }
        Log.i(CoreHost.TAG, "Native Android reminders reschedule action=$action")

        runCatching { CoreWork.enqueueDurably(this, context, CoreJob.REMINDERS, mapOf("mode" to "rebuild")) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android reminders reschedule not queued", it) }
    }
}
