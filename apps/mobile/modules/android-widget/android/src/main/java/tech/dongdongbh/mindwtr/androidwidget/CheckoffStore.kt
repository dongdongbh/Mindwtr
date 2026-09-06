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
 *
 * A committed task stays struck through (`committed` set) until the app has
 * ingested it and republished a payload without it; the commit itself never
 * redraws the widget. Redrawing a collection widget from a background Handler
 * broke the app-side collection cache on Android 16 (ColorOS): every later
 * update was silently dropped until the process restarted, which read as
 * "I cannot undo and cannot check any other task".
 */
object CheckoffStore {
  const val PREFS_NAME = "mindwtr_widget_checkoff"
  const val COMMITTED_PREFS_NAME = "mindwtr_widget_checkoff_committed"
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

  fun committed(context: Context): Set<String> =
    context.getSharedPreferences(COMMITTED_PREFS_NAME, Context.MODE_PRIVATE).all.keys

  fun isCommitted(context: Context, taskId: String): Boolean = committed(context).contains(taskId)

  /** Struck through on the widget: waiting for its undo window, or queued and not yet ingested. */
  fun isStruck(context: Context, taskId: String): Boolean = isPending(context, taskId) || isCommitted(context, taskId)

  /**
   * Forgets committed ids the payload no longer lists: the app ingested them (or
   * the task went away). Called on every render so the set cannot grow forever.
   */
  fun prune(context: Context, presentTaskIds: Set<String>) {
    val current = committed(context)
    val keep = pruned(current, presentTaskIds)
    if (keep.size == current.size) return
    writeCommitted(context, keep)
  }

  fun pruned(committed: Set<String>, presentTaskIds: Set<String>): Set<String> =
    committed.filterTo(HashSet()) { it in presentTaskIds }

  /** Marks or, when already pending, un-marks (undo). Returns true when now pending. A committed task is left alone. */
  fun toggle(context: Context, taskId: String, now: Long = System.currentTimeMillis()): Boolean {
    if (isCommitted(context, taskId)) return true
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
    val done = committed(context).toMutableSet()
    for (taskId in due) {
      PendingCaptureWriter.writeCompletion(context.filesDir, taskId)
      remaining.remove(taskId)
      done.add(taskId)
    }
    write(context, remaining)
    writeCommitted(context, done)
    if (remaining.isNotEmpty()) scheduleCommit(context)
    return true
  }

  fun toggled(pending: Map<String, Long>, taskId: String, now: Long): Map<String, Long> =
    if (pending.containsKey(taskId)) pending - taskId else pending + (taskId to now)

  fun expired(pending: Map<String, Long>, now: Long, windowMs: Long): List<String> =
    pending.filter { (_, tappedAt) -> now - tappedAt >= windowMs }.keys.sorted()

  private fun writeCommitted(context: Context, committed: Set<String>) {
    val editor = context.getSharedPreferences(COMMITTED_PREFS_NAME, Context.MODE_PRIVATE).edit().clear()
    for (taskId in committed) editor.putBoolean(taskId, true)
    editor.commit()
  }

  private fun write(context: Context, pending: Map<String, Long>) {
    val editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear()
    for ((taskId, tappedAt) in pending) editor.putLong(taskId, tappedAt)
    editor.commit()
  }

  private fun scheduleCommit(context: Context) {
    val app = context.applicationContext
    handler.removeCallbacksAndMessages(null)
    // Sweep only: the row is already struck through, and a redraw from here
    // (background process, no activity) is what broke later updates.
    handler.postDelayed({ sweep(app) }, HANDLER_DELAY_MS)
    val alarm = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val intent = Intent(app, TasksWidgetProvider::class.java).setAction(ACTION_SWEEP)
    val pendingIntent = PendingIntent.getBroadcast(
      app, REQUEST_SWEEP, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    alarm.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ALARM_DELAY_MS, pendingIntent)
  }
}
