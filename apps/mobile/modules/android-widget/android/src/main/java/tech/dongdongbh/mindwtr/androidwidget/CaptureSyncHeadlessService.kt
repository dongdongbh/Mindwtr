package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig


private const val CAPTURE_SYNC_HEADLESS_TASK_NAME = "MindwtrCaptureSync"

private const val CAPTURE_SYNC_HEADLESS_TIMEOUT_MS = 5 * 60 * 1000L


class CaptureSyncHeadlessService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(if (intent?.getBooleanExtra(EXTRA_WIDGET_REFRESH, false) == true) "MindwtrWidgetRefresh" else CAPTURE_SYNC_HEADLESS_TASK_NAME,
      Arguments.createMap(), CAPTURE_SYNC_HEADLESS_TIMEOUT_MS, true)

  companion object {
    private const val TAG = "Mindwtr"
    private const val EXTRA_WIDGET_REFRESH = "widgetRefresh"

    fun startWidgetRefresh(context: Context) = start(context, true)


    fun start(context: Context) = start(context, false)

    private fun start(context: Context, widgetRefresh: Boolean) {
      try {
        context.startService(Intent(context, CaptureSyncHeadlessService::class.java).putExtra(EXTRA_WIDGET_REFRESH, widgetRefresh))
        acquireWakeLockNow(context)
      } catch (error: RuntimeException) {

        Log.w(TAG, "capture sync start refused: ${error.javaClass.simpleName}")
      }
    }
  }
}
