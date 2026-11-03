package tech.dongdongbh.mindwtr.androidwidget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log


object CheckoffStore {
  enum class TapAction { TOGGLE_PENDING, RECONCILE, NO_OP }

  data class ToggleResult(
    val state: Map<String, Long>,
    val persisted: Boolean,
    val isPending: Boolean,
  )

  data class SweepState(
    val pending: Map<String, Long>,
    val committed: Map<String, String>,
    val newlyCommitted: Int,
    val failed: Int,
  )

  const val PREFS_NAME = "mindwtr_widget_checkoff"
  const val COMMITTED_PREFS_NAME = "mindwtr_widget_checkoff_committed"
  const val DIAGNOSTICS_PREFS_NAME = "mindwtr_widget_checkoff_diagnostics"
  const val UNDO_WINDOW_MS = 3_000L
  const val ACTION_SWEEP = "tech.dongdongbh.mindwtr.androidwidget.CHECKOFF_SWEEP"
  private const val HANDLER_DELAY_MS = 3_200L
  private const val ALARM_DELAY_MS = 15_000L
  private const val REQUEST_SWEEP = 4614
  private const val HIDDEN_COUNT = "hiddenCount"
  private const val REFRESH_COUNT = "refreshCount"
  private const val INDEX_RETRY = "indexRetry"
  private const val FAST_RETRY_COUNT = "fastRetryCount"
  private const val SERIALIZED_COUNT = "serializedCount"
  internal const val MAX_FAST_RETRIES = 2
  private const val TAG = "MindwtrWidgetCheckoff"
  private val stateMonitor = Any()


  private val handler by lazy { Handler(Looper.getMainLooper()) }

  private fun <T> withStateTransaction(action: () -> T): T = synchronized(stateMonitor, action)

  fun pending(context: Context): Map<String, Long> = withStateTransaction {
    readPending(context) ?: emptyMap()
  }

  fun isPending(context: Context, taskId: String): Boolean = pending(context).containsKey(taskId)


  fun committedFiles(context: Context): Map<String, String> = withStateTransaction {
    context.getSharedPreferences(COMMITTED_PREFS_NAME, Context.MODE_PRIVATE).all
      .mapValues { (_, value) -> value as? String ?: "" }
  }

  fun committed(context: Context): Set<String> = committedFiles(context).keys

  fun isCommitted(context: Context, taskId: String): Boolean = committed(context).contains(taskId)


  fun isStruck(context: Context, taskId: String): Boolean = withStateTransaction {
    isPending(context, taskId) || isCommitted(context, taskId)
  }


  fun prune(context: Context, presentTaskIds: Set<String>) = withStateTransaction {
    val current = committedFiles(context)
    val keep = pruned(current, presentTaskIds)
    if (keep.size == current.size) return@withStateTransaction
    writeCommitted(context, keep)
  }

  fun pruned(committed: Map<String, String>, presentTaskIds: Set<String>): Map<String, String> =
    committed.filterKeys { it in presentTaskIds }

  internal fun tapAction(
    isCommitted: Boolean,
    hasQueuedCompletion: Boolean = false,
    pendingSince: Long? = null,
    now: Long = System.currentTimeMillis(),
  ): TapAction = when {
    isCommitted || hasQueuedCompletion -> TapAction.RECONCILE
    pendingSince != null && now - pendingSince >= UNDO_WINDOW_MS -> TapAction.RECONCILE
    else -> TapAction.TOGGLE_PENDING
  }


  fun tapAction(context: Context, taskId: String, now: Long = System.currentTimeMillis()): TapAction = withStateTransaction {
    if (isCommitted(context, taskId)) return@withStateTransaction TapAction.RECONCILE
    val current = readPending(context) ?: return@withStateTransaction TapAction.NO_OP
    val tappedAt = current[taskId]
    tapAction(
      isCommitted = false,
      hasQueuedCompletion = tappedAt != null && PendingCaptureWriter.hasQueuedCompletion(context.filesDir, taskId, tappedAt),
      pendingSince = tappedAt,
      now = now,
    )
  }


  fun toggle(context: Context, taskId: String, now: Long = System.currentTimeMillis()): Boolean = withStateTransaction {
    if (isCommitted(context, taskId)) return@withStateTransaction false
    val current = readPending(context) ?: return@withStateTransaction false
    val tappedAt = current[taskId]
    if (tapAction(
        isCommitted = false,
        hasQueuedCompletion = tappedAt != null && PendingCaptureWriter.hasQueuedCompletion(context.filesDir, taskId, tappedAt),
        pendingSince = tappedAt,
        now = now,
      ) != TapAction.TOGGLE_PENDING
    ) return@withStateTransaction current.containsKey(taskId)
    val result = toggledDurably(current, taskId, now) { writePending(context, it) }
    if (!result.persisted) {
      Log.w(TAG, "Could not persist widget check-off toggle")
      if (result.isPending) scheduleInitialCommit(context)
      return@withStateTransaction result.isPending
    }
    recordSerializedCheckoff(context)
    if (result.isPending) scheduleInitialCommit(context)
    result.isPending
  }


  fun sweep(context: Context, now: Long = System.currentTimeMillis()): SweepState = withStateTransaction {
    val committed = committedFiles(context)
    val current = readPending(context)
      ?: return@withStateTransaction SweepState(emptyMap(), committed, newlyCommitted = 0, failed = 1)
    val next = swept(current, committed, now) { taskId, tappedAt ->
      PendingCaptureWriter.writeCompletion(context.filesDir, taskId, tappedAt).name
    }
    if (next.newlyCommitted > 0) markRefreshNeeded(context, next.newlyCommitted)
    val retryIndex = needsIndexRetry(context)
    if ((next.committed != committed || retryIndex) && !writeCommitted(context, next.committed)) {


      markIndexRetry(context, true)
      Log.e(TAG, "Could not persist queued widget completions; leaving check-offs pending")
      return@withStateTransaction next.copy(
        pending = current,
        committed = committedFiles(context),
        failed = next.failed + 1,
      )
    }
    if (retryIndex) markIndexRetry(context, false)

    val pendingWritten = next.pending == current || writePending(context, next.pending)
    val actual = if (pendingWritten) next else next.copy(pending = current, failed = next.failed + 1)
    if (!pendingWritten) Log.w(TAG, "Could not clear queued widget check-offs; retrying")
    if (actual.failed > 0) Log.w(TAG, "Could not queue ${actual.failed} widget completion(s); retrying")
    actual
  }

  fun toggled(pending: Map<String, Long>, taskId: String, now: Long): Map<String, Long> =
    if (pending.containsKey(taskId)) pending - taskId else pending + (taskId to now)

  internal fun toggledDurably(
    pending: Map<String, Long>,
    taskId: String,
    now: Long,
    persist: (Map<String, Long>) -> Boolean,
  ): ToggleResult {
    val next = toggled(pending, taskId, now)
    if (!persist(next)) return ToggleResult(pending, persisted = false, isPending = pending.containsKey(taskId))
    return ToggleResult(next, persisted = true, isPending = next.containsKey(taskId))
  }

  fun expired(pending: Map<String, Long>, now: Long, windowMs: Long): List<String> =
    pending.filter { (_, tappedAt) -> now - tappedAt >= windowMs }.keys.sorted()

  internal fun swept(
    pending: Map<String, Long>,
    committed: Map<String, String>,
    now: Long,
    enqueue: (String, Long) -> String,
  ): SweepState {
    val remaining = pending.toMutableMap()
    val done = committed.toMutableMap()
    var newlyCommitted = 0
    var failed = 0
    for (taskId in expired(pending, now, UNDO_WINDOW_MS)) {
      if (done.containsKey(taskId)) {
        remaining.remove(taskId)
        continue
      }
      try {
        done[taskId] = enqueue(taskId, pending.getValue(taskId))
        remaining.remove(taskId)
        newlyCommitted += 1
      } catch (_: Exception) {
        failed += 1
      }
    }
    return SweepState(remaining, done, newlyCommitted, failed)
  }

  private fun writeCommitted(context: Context, committed: Map<String, String>): Boolean {
    val editor = context.getSharedPreferences(COMMITTED_PREFS_NAME, Context.MODE_PRIVATE).edit().clear()
    for ((taskId, fileName) in committed) editor.putString(taskId, fileName)
    return editor.commit()
  }

  private fun writePending(context: Context, pending: Map<String, Long>): Boolean {
    return try {
      PendingCheckoffStore(context).write(pending)
      true
    } catch (error: Exception) {
      Log.e(TAG, "Could not persist pending widget check-offs", error)
      false
    }
  }

  private fun readPending(context: Context): Map<String, Long>? = try {
    PendingCheckoffStore(context).read()
  } catch (error: Exception) {
    Log.e(TAG, "Could not read pending widget check-offs", error)
    null
  }

  private fun markRefreshNeeded(context: Context, count: Int) {
    if (count <= 0) return
    val prefs = context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
    val total = prefs.getInt(REFRESH_COUNT, 0).coerceAtLeast(0) + count
    prefs.edit().putInt(REFRESH_COUNT, total).commit()
  }

  private fun refreshNeeded(context: Context): Int =
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .getInt(REFRESH_COUNT, 0)
      .coerceAtLeast(0)

  private fun markIndexRetry(context: Context, retry: Boolean) {
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(INDEX_RETRY, retry)
      .commit()
  }

  private fun needsIndexRetry(context: Context): Boolean =
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .getBoolean(INDEX_RETRY, false)

  private fun recordHidden(context: Context, fallbackCount: Int) {
    val prefs = context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
    val count = refreshNeeded(context).takeIf { it > 0 } ?: fallbackCount
    if (count <= 0) return
    val total = prefs.getInt(HIDDEN_COUNT, 0).coerceAtLeast(0) + count
    prefs.edit().remove(REFRESH_COUNT).putInt(HIDDEN_COUNT, total).commit()
  }

  private fun clearRefreshNeeded(context: Context) {
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(REFRESH_COUNT)
      .commit()
  }


  fun consumeHiddenCount(context: Context): Int {
    val prefs = context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
    val count = prefs.getInt(HIDDEN_COUNT, 0).coerceAtLeast(0)
    if (count <= 0) return 0
    return if (prefs.edit().remove(HIDDEN_COUNT).commit()) count else 0
  }

  private fun scheduleInitialCommit(context: Context) {
    val app = context.applicationContext
    setFastRetryCount(app, 0)
    handler.removeCallbacksAndMessages(null)

    handler.postDelayed({ sweepAndRefresh(app, allowFastRetry = true) }, HANDLER_DELAY_MS)
    val alarm = app.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    val intent = Intent(app, TasksWidgetProvider::class.java).setAction(ACTION_SWEEP)
    val pendingIntent = PendingIntent.getBroadcast(
      app, REQUEST_SWEEP, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    alarm.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + ALARM_DELAY_MS, pendingIntent)
  }

  private fun scheduleFastRetry(context: Context) {
    val app = context.applicationContext
    val next = nextFastRetry(fastRetryCount(app)) ?: return
    setFastRetryCount(app, next)
    handler.removeCallbacksAndMessages(null)
    handler.postDelayed({ sweepAndRefresh(app, allowFastRetry = true) }, HANDLER_DELAY_MS)
  }

  private fun fastRetryCount(context: Context): Int =
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .getInt(FAST_RETRY_COUNT, 0)
      .coerceAtLeast(0)

  private fun setFastRetryCount(context: Context, count: Int) {
    context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .putInt(FAST_RETRY_COUNT, count)
      .commit()
  }

  private fun recordSerializedCheckoff(context: Context) {
    val prefs = context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
    val total = prefs.getInt(SERIALIZED_COUNT, 0).coerceAtLeast(0) + 1
    prefs.edit().putInt(SERIALIZED_COUNT, total).commit()
  }


  fun consumeSerializedCount(context: Context): Int = withStateTransaction {
    val prefs = context.getSharedPreferences(DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
    val count = prefs.getInt(SERIALIZED_COUNT, 0).coerceAtLeast(0)
    if (count <= 0) return@withStateTransaction 0
    if (prefs.edit().remove(SERIALIZED_COUNT).commit()) count else 0
  }

  internal fun nextFastRetry(previous: Int): Int? =
    (previous + 1).takeIf { it <= MAX_FAST_RETRIES }


  fun reconcileFromInteraction(context: Context) {
    setFastRetryCount(context, 0)
    sweepAndRefresh(context, allowFastRetry = true)
  }

  fun sweepAndRefresh(context: Context, allowFastRetry: Boolean = false) {
    val result = sweep(context)
    var failed = result.failed > 0
    if (shouldRefresh(result.newlyCommitted, refreshNeeded(context))) {
      try {
        if (WidgetRenderer.refreshTaskCollections(context) > 0) {
          recordHidden(context, result.newlyCommitted)
        } else {
          clearRefreshNeeded(context)
        }
      } catch (error: RuntimeException) {
        failed = true
        Log.e(TAG, "Could not refresh widget rows after queued completion", error)
      }
    }
    if (failed && allowFastRetry) scheduleFastRetry(context)
    if (!failed) setFastRetryCount(context, 0)
  }

  internal fun shouldRefresh(newlyCommitted: Int, queuedRefresh: Int): Boolean =
    newlyCommitted > 0 || queuedRefresh > 0
}
