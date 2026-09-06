package tech.dongdongbh.mindwtr.notificationopenintents

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

object PersistentCaptureNotifier {
  const val CHANNEL_ID = "mindwtr-persistent-capture"
  const val NOTIFICATION_ID = 41120

  // Same target as CaptureTileService and the widget's "+": the native
  // quick-capture dialog (modules/android-widget, #1169) saves to the Inbox
  // queue and closes without bringing the app forward.
  private const val QUICK_CAPTURE_ACTIVITY = "tech.dongdongbh.mindwtr.androidwidget.QuickCaptureActivity"
  private const val CONTENT_REQUEST_CODE = NOTIFICATION_ID
  private const val DISMISS_REQUEST_CODE = NOTIFICATION_ID + 1

  const val EXTRA_TITLE = "tech.dongdongbh.mindwtr.persistentCapture.title"
  const val EXTRA_TEXT = "tech.dongdongbh.mindwtr.persistentCapture.text"
  const val EXTRA_CHANNEL_NAME = "tech.dongdongbh.mindwtr.persistentCapture.channelName"

  // Device-local mirror of the last posted state so the notification can be
  // re-pinned from any process start (alarm receivers, widgets, activity
  // launches) without waiting for React to boot. OEMs remove the app's
  // notifications when they kill its process, and that removal fires no
  // dismiss intent (#819).
  private const val PREFS_NAME = "mindwtr-persistent-capture"
  private const val PREF_ENABLED = "enabled"
  private const val PREF_TITLE = "title"
  private const val PREF_TEXT = "text"
  private const val PREF_CHANNEL_NAME = "channelName"

  fun post(context: Context, title: String, text: String, channelName: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
      .putBoolean(PREF_ENABLED, true)
      .putString(PREF_TITLE, title)
      .putString(PREF_TEXT, text)
      .putString(PREF_CHANNEL_NAME, channelName)
      .apply()
    val notificationManager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Recreate unconditionally: for an existing channel Android applies only the
      // safe fields (name/description), which keeps the user-visible channel label
      // in sync with the app language while preserving the user's own overrides.
      val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
      channel.description = channelName
      channel.enableLights(false)
      channel.enableVibration(false)
      channel.setSound(null, null)
      channel.setShowBadge(false)
      channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      notificationManager.createNotificationChannel(channel)
    }

    val openIntent = Intent().apply {
      setClassName(context.packageName, QUICK_CAPTURE_ACTIVITY)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
    val contentIntent = PendingIntent.getActivity(context, CONTENT_REQUEST_CODE, openIntent, pendingFlags)

    // Android 14+ lets users swipe away "ongoing" notifications. Re-post on
    // dismissal so the capture handle stays pinned while the setting is on;
    // the settings toggle cancels via cancel(), which does not fire this intent.
    val dismissIntent = Intent(context, PersistentCaptureDismissReceiver::class.java).apply {
      putExtra(EXTRA_TITLE, title)
      putExtra(EXTRA_TEXT, text)
      putExtra(EXTRA_CHANNEL_NAME, channelName)
    }
    val deleteIntent = PendingIntent.getBroadcast(context, DISMISS_REQUEST_CODE, dismissIntent, pendingFlags)

    val smallIcon = context.resources.getIdentifier("ic_quick_settings_capture", "drawable", context.packageName)
      .takeIf { it != 0 }
      ?: context.applicationInfo.icon

    @Suppress("DEPRECATION")
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
    }
    builder
      .setSmallIcon(smallIcon)
      .setContentTitle(title)
      .setContentText(text)
      .setContentIntent(contentIntent)
      .setDeleteIntent(deleteIntent)
      .setOngoing(true)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)

    notificationManager.notify(NOTIFICATION_ID, builder.build())
  }

  fun cancel(context: Context) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
    val notificationManager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    notificationManager?.cancel(NOTIFICATION_ID)
  }

  /**
   * Re-post the notification from the mirrored state if the toggle is on.
   * Same-id notify on the silent channel is an invisible in-place update, so
   * calling this on every process start is safe.
   */
  fun restoreOnProcessStart(context: Context) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    if (!prefs.getBoolean(PREF_ENABLED, false)) return
    val title = prefs.getString(PREF_TITLE, null) ?: return
    val text = prefs.getString(PREF_TEXT, null) ?: return
    val channelName = prefs.getString(PREF_CHANNEL_NAME, null) ?: return
    post(context, title, text, channelName)
  }
}

class PersistentCaptureDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val title = intent.getStringExtra(PersistentCaptureNotifier.EXTRA_TITLE) ?: return
    val text = intent.getStringExtra(PersistentCaptureNotifier.EXTRA_TEXT) ?: return
    val channelName = intent.getStringExtra(PersistentCaptureNotifier.EXTRA_CHANNEL_NAME) ?: return
    PersistentCaptureNotifier.post(context, title, text, channelName)
  }
}
