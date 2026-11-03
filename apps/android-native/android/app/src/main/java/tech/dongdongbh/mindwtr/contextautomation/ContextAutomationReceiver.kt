package tech.dongdongbh.mindwtr.contextautomation

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import tech.dongdongbh.mindwtr.pilot.CoreJob
import tech.dongdongbh.mindwtr.pilot.CoreWork
import tech.dongdongbh.mindwtr.pilot.core.CoreHost

private const val ACTIVATE_CONTEXT_ACTION = "tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT"
private const val DEACTIVATE_CONTEXT_ACTION = "tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT"


class ContextAutomationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {

    val payload = runCatching { ContextAutomationPayload.fromIntent(intent) }.getOrNull() ?: return
    val outcome = queueTrigger(payload.action, payload.context) { CoreWork.enqueue(context.applicationContext, CoreJob.CONTEXT, it) }
    if (outcome != "queued") Log.w(CoreHost.TAG, "Native Android context trigger dropped reason=$outcome")
  }
}


internal const val MAX_TRIGGER_TEXT = 2000


internal fun queueTrigger(action: String, context: String, enqueue: (Map<String, String>) -> Unit): String {
  if (context.length > MAX_TRIGGER_TEXT) return "too-long"
  return if (runCatching { enqueue(mapOf("action" to action, "context" to context)) }.isSuccess) "queued" else "failed"
}

private data class ContextAutomationPayload(
  val action: String,
  val context: String
) {
  companion object {
    fun fromIntent(intent: Intent?): ContextAutomationPayload? {
      val contextAction = when (intent?.action) {
        ACTIVATE_CONTEXT_ACTION -> "activate"
        DEACTIVATE_CONTEXT_ACTION -> "deactivate"
        else -> return null
      }

      fun clean(value: String?): String? {
        val trimmed = value?.trim().orEmpty()
        return if (trimmed.isBlank()) null else trimmed
      }

      val data = intent.data
      val ignoredPathSegments = setOf("context", "contexts", "activate", "deactivate")
      val pathContext = data?.pathSegments
        ?.filter { segment -> !ignoredPathSegments.contains(segment) }
        ?.joinToString("/")
      val hostContext = data?.host?.takeIf { host -> host != "context" && host != "contexts" }
      val rawContext = clean(intent.getStringExtra("context"))
        ?: clean(intent.getStringExtra("name"))
        ?: clean(intent.getStringExtra("token"))
        ?: clean(intent.getStringExtra(Intent.EXTRA_TEXT))
        ?: clean(data?.getQueryParameter("context"))
        ?: clean(data?.getQueryParameter("name"))
        ?: clean(data?.getQueryParameter("token"))
        ?: clean(pathContext)
        ?: clean(hostContext)
        ?: return null

      return ContextAutomationPayload(contextAction, rawContext)
    }
  }
}
