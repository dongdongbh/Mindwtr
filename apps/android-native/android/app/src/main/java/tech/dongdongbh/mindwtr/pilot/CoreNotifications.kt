package tech.dongdongbh.mindwtr.pilot

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.UUID


internal object CoreNotifications {

    const val REMINDER_CHANNEL = "mindwtr_reminders_v2"

    const val EXTRA_OPEN = "tech.dongdongbh.mindwtr.notificationOpen"


    private const val EXTRA_ALARM_ID = "tech.dongdongbh.mindwtr.reminderAlarmId"


    private const val REMINDER_SLOT_ID = 1

    private val reminderOwners = mutableMapOf<String, Int>()


    fun post(context: Context, details: JSONObject): Boolean {

        val id = (System.currentTimeMillis() / 1000).toInt()
        val builder = builder(context, id, details, details.getString("channelName")) ?: return false
        context.getSystemService(NotificationManager::class.java).notify(id, builder.build())
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }


    private const val POMODORO_SLOT_ID = 2


    fun postPomodoro(context: Context, identifier: String, details: JSONObject) {
        val builder = builder(context, POMODORO_SLOT_ID, details, details.optString("channelName")) ?: return
        details.optJSONObject("data")?.optString("endsAtMs")?.toLongOrNull()?.let { builder.setWhen(it).setShowWhen(true) }
        context.getSystemService(NotificationManager::class.java).notify(identifier, POMODORO_SLOT_ID, builder.build())
    }


    fun cancelPomodoro(context: Context, identifier: String) =
        context.getSystemService(NotificationManager::class.java).cancel(identifier, POMODORO_SLOT_ID)


    fun postReminder(context: Context, alarm: JSONObject) {
        val id = alarm.getInt("id")
        val details = alarm.getJSONObject("details")
        val builder = builder(context, id, details, alarm.optString("channelName")) ?: return
        if (details.optBoolean("has_button")) {
            val data = details.optJSONObject("data") ?: JSONObject()
            fun action(name: String) = Intent(context, ReminderActionReceiver::class.java).setAction(name).putExtra(ReminderActionReceiver.EXTRA_ID, id)
            fun broadcast(intent: Intent) = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            if (data.optString("notificationActionComplete") == "true") {
                builder.addAction(android.R.drawable.checkbox_on_background, "COMPLETE", broadcast(action(ReminderActionReceiver.COMPLETE)
                    .putExtra(ReminderActionReceiver.EXTRA_REQUEST, UUID.randomUUID().toString()).putExtra(ReminderActionReceiver.EXTRA_TASK, data.optString("taskId"))))
            }
            builder.addAction(R.drawable.ic_snooze, "SNOOZE", broadcast(action(ReminderActionReceiver.SNOOZE)
                .putExtra(ReminderActionReceiver.EXTRA_REQUEST, UUID.randomUUID().toString()).putExtra(ReminderAlarms.EXTRA_ALARM, alarm.toString())))
            builder.addAction(android.R.drawable.ic_lock_idle_alarm, "DISMISS", broadcast(action(ReminderActionReceiver.DISMISS)))
        }
        builder.addExtras(Bundle().apply { putInt(EXTRA_ALARM_ID, id) })


        val tag = details.optString("tag")
        val manager = context.getSystemService(NotificationManager::class.java)
        synchronized(ReminderAlarms.LOCK) {
            if (tag.isEmpty()) manager.notify(id, builder.build()) else {
                manager.notify(tag, REMINDER_SLOT_ID, builder.build())
                reminderOwners[tag] = id
            }
        }
    }


    fun reminderAlarmId(shown: StatusBarNotification): Int = shown.notification.extras.getInt(EXTRA_ALARM_ID, shown.id)


    fun cancelReminder(context: Context, id: Int): Unit = synchronized(ReminderAlarms.LOCK) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(id)
        var taggedRemoved = 0
        for ((tag, owner) in reminderOwners) {
            if (owner == id) {
                manager.cancel(tag, REMINDER_SLOT_ID)
                taggedRemoved += 1
            }
        }
        for (shown in manager.activeNotifications) {
            if (shown.tag == null || NotificationCompat.getChannelId(shown.notification) != REMINDER_CHANNEL) continue
            if (shown.tag in reminderOwners) continue
            if (reminderAlarmId(shown) == id) {
                manager.cancel(shown.tag, shown.id)
                taggedRemoved += 1
            }
        }
        reminderOwners.entries.removeAll { it.value == id }
        Log.i(CoreHost.TAG, "Native Android reminder slot releaseCheck=v1.3.5/native-reminder-replacement operation=cancelled taggedRemoved=$taggedRemoved")
    }


    private fun builder(context: Context, id: Int, details: JSONObject, channelName: String): NotificationCompat.Builder? {
        val channel = details.optString("channel").ifEmpty { return null }
        val message = details.optString("message").ifEmpty { return null }
        val title = details.optString("title").ifEmpty { context.applicationInfo.loadLabel(context.packageManager).toString() }
        val color = details.optString("color").takeIf { it.isNotEmpty() }?.let(Color::parseColor)
        ensureChannel(context, channel, channelName.ifEmpty { channel }, color)
        val sound = if (details.optBoolean("play_sound", true)) Settings.System.DEFAULT_NOTIFICATION_URI else null
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN, (details.optJSONObject("data") ?: JSONObject()).toString())
        return NotificationCompat.Builder(context, channel)
            .setSmallIcon(context.resources.getIdentifier(details.optString("small_icon", "ic_launcher"), "mipmap", context.packageName))
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(details.optBoolean("auto_cancel", true))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setSound(sound)
            .setContentIntent(PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .apply {
                color?.let(::setColor)
                if (details.optBoolean("use_big_text")) setStyle(NotificationCompat.BigTextStyle().bigText(message))
            }
    }


    private fun ensureChannel(context: Context, id: String, name: String, color: Int?) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(id) != null) return
        manager.createNotificationChannel(NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = name
            enableLights(true)
            color?.let { lightColor = it }
            enableVibration(false)
            setSound(Settings.System.DEFAULT_NOTIFICATION_URI, AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build())
        })
    }
}
