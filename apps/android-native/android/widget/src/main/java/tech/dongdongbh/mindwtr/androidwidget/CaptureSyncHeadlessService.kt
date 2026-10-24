package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.os.FileObserver
import android.os.Looper
import android.util.Log
import java.io.File
import java.util.concurrent.Executors

/**
 * Native: RN's CaptureSyncHeadlessService woke React Native's JS to import the pending-captures queue (#1257). Here the app's
 * CoreWork stores the queue, through the hook the app sets at process start ([install], MindwtrApplication). RN's dialog
 * (QuickCaptureActivity, compiled as it is) calls [start] where it started RN's service. Everything else RN's writer queues (the
 * capture intent receiver's item, a widget check-off RN's CheckoffStore sweeps into the queue), RN's files compiled as they
 * are, is seen here: the hook also runs when an item is published in the queue folder. A missing or failing hook loses nothing:
 * the file stays queued, and the next app start drains it.
 */
object CaptureSyncHeadlessService {
  private const val TAG = "Mindwtr"
  @Volatile private var queued: ((Context) -> Unit)? = null
  @Volatile private var widgetRefresh: ((Context) -> Unit)? = null
  // A FileObserver stops watching once collected: this keeps the one on the queue folder.
  private var watcher: FileObserver? = null

  /** Sets the app's hook ([queued], null to remove it); called once per process before any widget component runs. */
  @Synchronized
  fun install(context: Context, queued: ((Context) -> Unit)?) = install(context, queued, queued)

  @Synchronized
  fun install(context: Context, queued: ((Context) -> Unit)?, widgetRefresh: ((Context) -> Unit)?) {
    val app = context.applicationContext
    this.queued = queued
    this.widgetRefresh = widgetRefresh
    watcher?.stopWatching()
    watcher = null
    // RN's capture intent receiver: its queued capture's wake runs on the receiver's thread before the broadcast finishes, so the
    // process lives until WorkManager stored the job.
    CaptureIntentReceiver.queuedHook = queued?.let { { context: Context -> start(context) } }
    if (queued == null) return
    // A folder is watched only while it exists; RN's writer would create it with its first item anyway.
    val queue = File(app.filesDir, PendingCaptureWriter.DIRECTORY).apply { mkdirs() }
    @Suppress("DEPRECATION") // FileObserver(File, Int) is API 29+; minSdk is 24.
    watcher = object : FileObserver(queue.path, FileObserver.MOVED_TO) {
      override fun onEvent(event: Int, path: String?) = queueEvent(app, event, path)
    }.apply { startWatching() }
  }

  /** RN's writer publishes an item by renaming its synced `<id>.tmp` to `<id>.json`, so a moved-in `.json` is a whole item. */
  internal fun queueEvent(context: Context, event: Int, path: String?) {
    if (event and FileObserver.MOVED_TO != 0 && path?.endsWith(".json") == true) start(context)
  }

  /**
   * Call once a pending-captures file is on disk. The hook returns once WorkManager stored the job: off the main thread (the
   * queue folder's watcher) this waits for it; on the main thread (the dialog's Save, while it still shows) it waits on a thread
   * of its own.
   */
  fun start(context: Context) = wake(context, queued)

  fun startWidgetRefresh(context: Context) = wake(context, widgetRefresh)

  private fun wake(context: Context, callback: ((Context) -> Unit)?) {
    val hook = callback ?: return
    val app = context.applicationContext
    val wake: () -> Unit = {
      try {
        hook(app)
      } catch (error: Exception) {
        // The capture is already queued; the app imports it the next time it opens.
        Log.w(TAG, "capture sync start refused: ${error.javaClass.simpleName}")
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) wakes.execute(wake) else wake()
  }

  private val wakes = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-capture-wake").apply { isDaemon = true } }
}
