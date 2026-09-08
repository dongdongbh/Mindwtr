package tech.dongdongbh.mindwtr.startupmetrics

import android.os.SystemClock
import android.app.Activity
import java.lang.ref.WeakReference
import android.util.Log
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** No exported component, permissions, task data, or persisted configuration. */
class StartupMetricsModule : Module() {
  private var reportedActivity = WeakReference<Activity>(null)
  override fun definition() = ModuleDefinition {
    Name("MindwtrStartupMetrics")
    AsyncFunction("reportFullyDrawnAsync") {
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed) {
        false
      } else if (reportedActivity.get() === activity) {
        true
      } else {
        activity.reportFullyDrawn()
        reportedActivity = WeakReference(activity)
        Log.i("MindwtrStartup", "phase=native.fully_drawn uptimeMs=${SystemClock.elapsedRealtime()}")
        true
      }
    }.runOnQueue(Queues.MAIN)
  }
}
