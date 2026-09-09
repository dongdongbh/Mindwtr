package tech.dongdongbh.mindwtr.startupmetrics

import android.os.SystemClock
import android.app.Activity
import java.lang.ref.WeakReference
import android.util.Log
import java.io.File
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** No exported component, permissions, task data, or persisted configuration. */
class StartupMetricsModule : Module() {
  private var reportedActivity = WeakReference<Activity>(null)
  private val profileLock = Any()
  private var profileSequence = 0
  private var activeProfile = 0

  private fun captureProfilingAllowed(): Boolean = BuildConfig.CAPTURE_PROFILING_ENABLED &&
    appContext.reactContext?.packageName == "tech.dongdongbh.mindwtr.benchmark"

  private fun stopCaptureProfile(token: Int): Boolean = synchronized(profileLock) {
    if (!captureProfilingAllowed() || token == 0 || token != activeProfile) return@synchronized false
    activeProfile = 0
    try {
      CaptureSampling.disable()
      val root = checkNotNull(appContext.reactContext?.getExternalFilesDir(null))
      val directory = File(root, "capture-profiles")
      check(directory.isDirectory || directory.mkdirs())
      val output = File(directory, "capture-${System.currentTimeMillis()}-$token.cpuprofile")
      CaptureSampling.dump(output.absolutePath)
      Log.i("MindwtrCaptureProfile", "saved=${output.name}")
      true
    } catch (_: Throwable) {
      Log.w("MindwtrCaptureProfile", "unavailable")
      false
    }
  }

  private fun cancelCaptureProfile() = synchronized(profileLock) {
    if (activeProfile != 0) {
      activeProfile = 0
      try { CaptureSampling.disable() } catch (_: Throwable) { }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MindwtrStartupMetrics")
    // No exported component or caller-controlled path. Both the build flag and
    // exact synthetic-only package must match; normal releases cannot activate it.
    Function("beginCaptureProfile") {
      synchronized(profileLock) {
        if (!captureProfilingAllowed() || activeProfile != 0 || profileSequence >= 8) {
          0
        } else {
          try {
            CaptureSampling.enable()
            activeProfile = ++profileSequence
            activeProfile
          } catch (_: Throwable) { 0 }
        }
      }
    }
    AsyncFunction("endCaptureProfileAsync") { token: Int -> stopCaptureProfile(token) }
    OnActivityEntersBackground { cancelCaptureProfile() }
    OnDestroy { cancelCaptureProfile() }
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
