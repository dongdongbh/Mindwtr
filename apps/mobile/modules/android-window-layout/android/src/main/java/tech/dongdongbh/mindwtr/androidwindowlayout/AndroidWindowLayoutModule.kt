package tech.dongdongbh.mindwtr.androidwindowlayout

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.window.layout.WindowMetricsCalculator
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.util.ArrayDeque
import java.util.LinkedHashSet

private const val LAYOUT_EVENT = "onLayoutChanged"
private const val MAX_DESTROYED_ACTIVITY_SESSIONS = 4
private const val MAX_KNOWN_HOST_ACTIVITY_IDS = 8

/**
 * Read-only, non-exported bridge for the current Android activity window.
 * Nothing here persists UI-session state or reads physical-screen dimensions.
 */
class AndroidWindowLayoutModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val trackingScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val activitySessionLock = Any()
  private val destroyedActivitySessions = ArrayDeque<Map<String, Any>>()
  private val knownHostActivityIds = LinkedHashSet<Int>()

  private val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityPreDestroyed(activity: Activity) {
      captureDestroyedHostActivity(activity)
    }

    override fun onActivityDestroyed(activity: Activity) {
      // API 24-28 fallback. On newer versions the primitive session was
      // already recorded by onActivityPreDestroyed and this is a no-op.
      captureDestroyedHostActivity(activity)
    }
  }

  @Volatile
  private var latestSnapshot: Map<String, Any>? = null

  @Volatile
  private var latestActivitySession: Map<String, Any>? = null

  @Volatile
  private var destroyed = false

  private var trackedActivity: Activity? = null
  private var sessionActivity: Activity? = null
  private var latestLayoutInfo: WindowLayoutInfo? = null
  private var trackingJob: Job? = null
  private var registeredApplication: Application? = null

  private val layoutChangeListener = View.OnLayoutChangeListener { view, left, top, right, bottom,
                                                                    oldLeft, oldTop, oldRight, oldBottom ->
    if (left != oldLeft || top != oldTop || right != oldRight || bottom != oldBottom) {
      trackedActivity?.let { activity -> publishSnapshot(activity, latestLayoutInfo) }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AndroidWindowLayout")
    Events(LAYOUT_EVENT)

    Function("getLayout") {
      latestSnapshot
    }

    Function("getActivitySession") {
      currentActivitySession()
    }

    Function("getActivitySessionForId") { activityId: Int ->
      activitySessionForId(activityId)
    }

    OnCreate {
      runOnMain {
        registerActivityLifecycleCallbacks()
        bindToCurrentActivity()
      }
    }

    OnStartObserving(LAYOUT_EVENT) {
      runOnMain { bindToCurrentActivity() }
    }

    OnActivityEntersForeground {
      runOnMain { bindToCurrentActivity() }
    }

    OnActivityEntersBackground {
      runOnMain { stopTracking(clearSnapshot = false) }
    }

    OnActivityDestroys {
      runOnMain {
        // Application.ActivityLifecycleCallbacks normally captures the exact
        // Activity first. Keep this guarded fallback for hosts that do not
        // dispatch application lifecycle callbacks, without touching a
        // replacement Activity that has already entered the foreground.
        sessionActivity
          ?.takeIf { it.isChangingConfigurations || it.isFinishing || it.isDestroyed }
          ?.let(::captureDestroyedHostActivity)
      }
    }

    OnDestroy {
      destroyed = true
      trackingScope.cancel()
      runOnMain {
        unregisterActivityLifecycleCallbacks()
        sessionActivity = null
        latestActivitySession = null
        synchronized(activitySessionLock) {
          destroyedActivitySessions.clear()
          knownHostActivityIds.clear()
        }
        stopTracking(clearSnapshot = true)
      }
    }
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  private fun bindToCurrentActivity() {
    if (destroyed) return
    registerActivityLifecycleCallbacks()
    val activity = appContext.currentActivity
      ?.takeUnless { it.isFinishing || it.isDestroyed }
      ?: return

    if (trackedActivity === activity && trackingJob?.isActive == true) {
      publishSnapshot(activity, latestLayoutInfo)
      return
    }

    stopTracking(clearSnapshot = trackedActivity !== activity)
    trackedActivity = activity
    sessionActivity = activity
    rememberHostActivity(activity)
    latestActivitySession = createActivitySession(activity)
    latestLayoutInfo = null
    activity.window.decorView.addOnLayoutChangeListener(layoutChangeListener)
    publishSnapshot(activity, null)

    trackingJob = trackingScope.launch {
      try {
        WindowInfoTracker.getOrCreate(activity)
          .windowLayoutInfo(activity)
          .collect { layoutInfo ->
            if (!destroyed && trackedActivity === activity) {
              latestLayoutInfo = layoutInfo
              publishSnapshot(activity, layoutInfo)
            }
          }
      } catch (error: CancellationException) {
        throw error
      } catch (_: Throwable) {
        // WindowManager is optional. Keep publishing window metrics without
        // folding features and try the tracker again after the next rebind.
        if (!destroyed && trackedActivity === activity) {
          latestLayoutInfo = null
          publishSnapshot(activity, null)
        }
      }
    }
  }

  private fun stopTracking(clearSnapshot: Boolean) {
    trackingJob?.cancel()
    trackingJob = null
    trackedActivity?.window?.decorView?.removeOnLayoutChangeListener(layoutChangeListener)
    trackedActivity = null
    latestLayoutInfo = null
    if (clearSnapshot) latestSnapshot = null
  }

  private fun publishSnapshot(activity: Activity, layoutInfo: WindowLayoutInfo?) {
    val snapshot = createSnapshot(activity, layoutInfo) ?: return
    if (snapshot == latestSnapshot) return
    latestSnapshot = snapshot
    sendEvent(LAYOUT_EVENT, snapshot)
  }

  private fun currentActivitySession(): Map<String, Any>? {
    val activity = appContext.currentActivity
      ?.takeUnless { it.isFinishing || it.isDestroyed }
    return activity?.let(::createActivitySession) ?: latestActivitySession
  }

  private fun registerActivityLifecycleCallbacks() {
    if (registeredApplication != null || destroyed) return
    val application = appContext.reactContext?.applicationContext as? Application ?: return
    application.registerActivityLifecycleCallbacks(activityLifecycleCallbacks)
    registeredApplication = application
  }

  private fun unregisterActivityLifecycleCallbacks() {
    registeredApplication?.unregisterActivityLifecycleCallbacks(activityLifecycleCallbacks)
    registeredApplication = null
  }

  private fun rememberHostActivity(activity: Activity) {
    val activityId = System.identityHashCode(activity)
    synchronized(activitySessionLock) {
      knownHostActivityIds.remove(activityId)
      knownHostActivityIds.add(activityId)
      while (knownHostActivityIds.size > MAX_KNOWN_HOST_ACTIVITY_IDS) {
        val iterator = knownHostActivityIds.iterator()
        if (!iterator.hasNext()) break
        iterator.next()
        iterator.remove()
      }
    }
  }

  private fun captureDestroyedHostActivity(activity: Activity) {
    val activityId = System.identityHashCode(activity)
    val wasKnownHost = synchronized(activitySessionLock) {
      knownHostActivityIds.remove(activityId)
    }
    if (!wasKnownHost) return

    recordDestroyedActivitySession(createActivitySession(activity))
    if (sessionActivity === activity) sessionActivity = null
    if (trackedActivity === activity) stopTracking(clearSnapshot = true)
  }

  private fun activitySessionForId(activityId: Int): Map<String, Any>? {
    val current = appContext.currentActivity
      ?.takeUnless { it.isFinishing || it.isDestroyed }
      ?.let(::createActivitySession)
    if (current?.get("activityId") == activityId) return current

    return synchronized(activitySessionLock) {
      destroyedActivitySessions.firstOrNull { it["activityId"] == activityId }
    }
  }

  private fun recordDestroyedActivitySession(session: Map<String, Any>) {
    latestActivitySession = session
    synchronized(activitySessionLock) {
      val activityId = session["activityId"]
      val iterator = destroyedActivitySessions.iterator()
      while (iterator.hasNext()) {
        if (iterator.next()["activityId"] == activityId) iterator.remove()
      }
      destroyedActivitySessions.addFirst(session)
      while (destroyedActivitySessions.size > MAX_DESTROYED_ACTIVITY_SESSIONS) {
        destroyedActivitySessions.removeLast()
      }
    }
  }

  private fun createActivitySession(activity: Activity): Map<String, Any> = mapOf(
    "activityId" to System.identityHashCode(activity),
    "isChangingConfigurations" to activity.isChangingConfigurations,
  )

  private fun createSnapshot(
    activity: Activity,
    layoutInfo: WindowLayoutInfo?,
  ): Map<String, Any>? {
    return try {
      val density = activity.resources.displayMetrics.density.toDouble()
      if (!density.isFinite() || density <= 0.0) return null

      val windowBounds = WindowMetricsCalculator.getOrCreate()
        .computeCurrentWindowMetrics(activity)
        .bounds
      if (windowBounds.width() <= 0 || windowBounds.height() <= 0) return null

      val features = layoutInfo?.displayFeatures
        ?.filterIsInstance<FoldingFeature>()
        ?.map { feature ->
          val bounds = feature.bounds
          mapOf(
            "bounds" to mapOf(
              "left" to bounds.left / density,
              "top" to bounds.top / density,
              "right" to bounds.right / density,
              "bottom" to bounds.bottom / density,
            ),
            "orientation" to when (feature.orientation) {
              FoldingFeature.Orientation.HORIZONTAL -> "horizontal"
              else -> "vertical"
            },
            "state" to when (feature.state) {
              FoldingFeature.State.HALF_OPENED -> "half-opened"
              else -> "flat"
            },
            "isSeparating" to feature.isSeparating,
            "occlusionType" to when (feature.occlusionType) {
              FoldingFeature.OcclusionType.FULL -> "full"
              else -> "none"
            },
          )
        }
        ?: emptyList()

      mapOf(
        "width" to windowBounds.width() / density,
        "height" to windowBounds.height() / density,
        "features" to features,
      )
    } catch (_: Throwable) {
      null
    }
  }
}
