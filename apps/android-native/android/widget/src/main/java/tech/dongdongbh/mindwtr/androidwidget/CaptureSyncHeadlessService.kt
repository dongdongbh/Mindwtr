package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.os.FileObserver
import android.os.Looper
import android.util.Log
import java.io.File
import java.util.concurrent.Executors


object CaptureSyncHeadlessService {
  private const val TAG = "Mindwtr"
  @Volatile private var queued: ((Context) -> Unit)? = null
  @Volatile private var widgetRefresh: ((Context) -> Unit)? = null

  private var watcher: FileObserver? = null


  @Synchronized
  fun install(context: Context, queued: ((Context) -> Unit)?) = install(context, queued, queued)

  @Synchronized
  fun install(context: Context, queued: ((Context) -> Unit)?, widgetRefresh: ((Context) -> Unit)?) {
    val app = context.applicationContext
    this.queued = queued
    this.widgetRefresh = widgetRefresh
    watcher?.stopWatching()
    watcher = null


    CaptureIntentReceiver.queuedHook = queued?.let { { context: Context -> start(context) } }
    if (queued == null) return

    val queue = File(app.filesDir, PendingCaptureWriter.DIRECTORY).apply { mkdirs() }
    @Suppress("DEPRECATION")
    watcher = object : FileObserver(queue.path, FileObserver.MOVED_TO) {
      override fun onEvent(event: Int, path: String?) = queueEvent(app, event, path)
    }.apply { startWatching() }
  }


  internal fun queueEvent(context: Context, event: Int, path: String?) {
    if (event and FileObserver.MOVED_TO != 0 && path?.endsWith(".json") == true) start(context)
  }


  fun start(context: Context) = wake(context, queued)

  fun startWidgetRefresh(context: Context) = wake(context, widgetRefresh)

  private fun wake(context: Context, callback: ((Context) -> Unit)?) {
    val hook = callback ?: return
    val app = context.applicationContext
    val wake: () -> Unit = {
      try {
        hook(app)
      } catch (error: Exception) {

        Log.w(TAG, "capture sync start refused: ${error.javaClass.simpleName}")
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) wakes.execute(wake) else wake()
  }

  private val wakes = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-capture-wake").apply { isDaemon = true } }
}
