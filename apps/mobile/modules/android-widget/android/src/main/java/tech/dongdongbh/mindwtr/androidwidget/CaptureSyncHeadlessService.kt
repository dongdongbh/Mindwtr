package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// Repeated in apps/mobile/lib/background-sync-task.ts (MOBILE_CAPTURE_SYNC_HEADLESS_TASK_NAME).
private const val CAPTURE_SYNC_HEADLESS_TASK_NAME = "MindwtrCaptureSync"
// The JS side abandons a sync after four minutes; this only has to outlast it.
private const val CAPTURE_SYNC_HEADLESS_TIMEOUT_MS = 5 * 60 * 1000L

/**
 * Imports captures and notification Done receipts and syncs them without opening the app (#1257). The
 * dialog only ever writes a queue file; this wakes the JS side, which does every
 * store write through the normal path. Not exported: only internal capture/reminder actions start it.
 */
class CaptureSyncHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(if (intent?.getBooleanExtra(EXTRA_WIDGET_REFRESH, false) == true) "MindwtrWidgetRefresh" else CAPTURE_SYNC_HEADLESS_TASK_NAME,
      Arguments.createMap(), CAPTURE_SYNC_HEADLESS_TIMEOUT_MS, true)

  companion object {
    private const val TAG = "Mindwtr"
    private const val EXTRA_WIDGET_REFRESH = "widgetRefresh"

    fun startWidgetRefresh(context: Context) = start(context, true)

    /** Call while the dialog is still on screen: Android refuses a service start from the background. */
    fun start(context: Context) = start(context, false)

    private fun start(context: Context, widgetRefresh: Boolean) {
      try {
        context.startService(Intent(context, CaptureSyncHeadlessService::class.java).putExtra(EXTRA_WIDGET_REFRESH, widgetRefresh))
        acquireWakeLockNow(context)
      } catch (error: RuntimeException) {
        // The capture is already queued; the app imports it the next time it opens.
        Log.w(TAG, "capture sync start refused: ${error.javaClass.simpleName}")
      }
    }
  }
}
