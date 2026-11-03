package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit


class CaptureIntentReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val ordered = isOrderedBroadcast
    if (ordered) setResultCode(Activity.RESULT_CANCELED)
    if (intent.action != CaptureIntentProcessor.ACTION) return
    val extras = CaptureIntentExtrasReader.read(intent::getStringExtra) ?: return
    val text = extras.text
    val token = extras.token
    if (text.length > PendingCaptureWriter.MAX_TITLE_LENGTH) return
    if (!CaptureIntentConfig.isValidToken(token)) return
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return

    val pendingResult = goAsync()
    try {
      executor.execute {
        try {
          val appContext = context.applicationContext
          val queued = CaptureIntentProcessor.process(
            intent.action,
            mapOf(
              CaptureIntentProcessor.EXTRA_TEXT to text,
              CaptureIntentProcessor.EXTRA_TOKEN to token,
            ),
            CaptureIntentConfigStore.read(appContext),
          ) { title ->
            PendingCaptureWriter.writeCaptureIntent(appContext.filesDir, title) != null
          }
          if (queued && ordered) pendingResult.resultCode = Activity.RESULT_OK
          if (queued) queuedHook?.invoke(appContext)
        } catch (_: Exception) {


        } finally {
          pendingResult.finish()
        }
      }
    } catch (_: RejectedExecutionException) {
      pendingResult.finish()
    }
  }

  companion object {


    @Volatile var queuedHook: ((Context) -> Unit)? = null


    private val executor = ThreadPoolExecutor(
      1,
      1,
      30L,
      TimeUnit.SECONDS,
      ArrayBlockingQueue(32),
      { runnable -> Thread(runnable, "mindwtr-capture-intent").apply { isDaemon = true } },
      ThreadPoolExecutor.AbortPolicy(),
    ).apply { allowCoreThreadTimeOut(true) }
  }
}
