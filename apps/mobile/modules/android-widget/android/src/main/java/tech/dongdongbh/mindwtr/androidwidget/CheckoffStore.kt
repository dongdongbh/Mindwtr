package tech.dongdongbh.mindwtr.androidwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * Widget check-off with an undo window (#1173 phase 2). A ring tap marks the
 * task pending in SharedPreferences `mindwtr_widget_checkoff` (taskId → tapped
 * at); a second tap inside the window undoes it; once the window elapses the
 * task is appended to the pending-captures queue as ONE `complete` item and
 * the app completes it through the store when it next runs. The commit runs
 * from a main-thread Handler (~3 s), an inexact alarm (~15 s) if the process
 * died first, and a sweep on every widget update.
 */
object CheckoffStore {
  const val PREFS_NAME = "mindwtr_widget_checkoff"
  const val UNDO_WINDOW_MS = 3_000L
  const val ACTION_SWEEP = "tech.dongdongbh.mindwtr.androidwidget.CHECKOFF_SWEEP"
  private const val HANDLER_DELAY_MS = 3_200L
  private const val ALARM_DELAY_MS = 15_000L
  private const val REQUEST_SWEEP = 4614

  // Lazy: the pure helpers run in JVM unit tests where android.os.Handler is a stub.
  private val handler by lazy { Handler(Looper.getMainLooper()) }

  fun pending(context: Context): Map<String, Long> =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).all
      .mapNotNull { (key, value) -> (value as? Long)?.let { key to it } }
      .toMap()

  fun isPending(context: Context, taskId: String): Boolean = pending(context).containsKey(taskId)

  /** Marks or, when already pending, un-marks (undo). Returns true when now pending. */
  fun toggle(context: Context, taskId: String, now: Long = System.currentTimeMillis()): Boolean {
    val next = toggled(pending(context), taskId, now)
    write(context, next)
    val nowPending = next.containsKey(taskId)
    if (nowPending) scheduleCommit(context)
    return nowPending
  }

  /** Writes every entry older than the window to the queue and drops it. Returns true when something changed. */
  fun sweep(context: Context, now: Long = System.currentTimeMillis()): Boolean {
    val current = pending(context)
    val due = expired(current, now, UNDO_WINDOW_MS)
    if (due.isEmpty()) return false
    val remaining = current.toMutableMap()
    for (taskId in due) {
      PendingCaptureWriter.writeCompletion(context.filesDir, taskId)
      remaining.remove(taskId)
    }
    write(context, remaining)
    if (remaining.isNotEmpty()) scheduleCommit(context)
    return true
  }

  fun toggled(pending: Map<String, Long>, taskId: String, now: Long): Map<String, Long> =
    if (pending.containsKey(taskId)) pending - taskId else pending + (taskId to now)

  fun expired(pending: Map<String, Long>, now: Long, windowMs: Long): List<String> =
    pending.filter { (_, tappedAt) -> now - tappedAt >= windowMs }.keys.sorted()

  private fun write(context: Context, pending: Map<String, Long>) {
    val editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear()
    for ((taskId, tappedAt) in pending) editor.putLong(taskId, tappedAt)
    editor.commit()
  }

  private fun scheduleCommit(context: Context) {
    val app = context.applicationContext
    handler.removeCallbacksAndMessages(null)
    handler.postDelayed({ if (sweep(app)) WidgetRenderer.refreshAll(app) }, HANDLER_DELAY_MS)
    val alarm = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val intent = Intent(app, TasksWidgetProvider::class.java).setAction(ACTION_SWEEP)
    val pendingIntent = PendingIntent.getBroadcast(
      app, REQUEST_SWEEP, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    alarm.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ALARM_DELAY_MS, pendingIntent)
  }
}
