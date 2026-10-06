package tech.dongdongbh.mindwtr.notificationopenintents

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object NotificationOpenPayloadStore {
  private const val PREFS_NAME = "mindwtr_notification_open"
  private const val PENDING_COMPLETIONS = "pendingCompletions"
  private val completionsLock = Any()

  @Volatile
  private var pendingNotificationOpenPayload: LinkedHashMap<String, String>? = null

  @JvmStatic
  fun cache(payload: Map<String, String>) {
    pendingNotificationOpenPayload = LinkedHashMap(payload)
  }

  @JvmStatic
  fun consume(): LinkedHashMap<String, String>? {
    val payload = pendingNotificationOpenPayload ?: return null
    pendingNotificationOpenPayload = null
    return LinkedHashMap(payload)
  }

  private fun readQueue(context: Context): JSONArray {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val queue = JSONArray(prefs.getString(PENDING_COMPLETIONS, "[]"))
    for (index in 0 until queue.length()) {
      // Fail closed: malformed data stays on disk for recovery, never becomes an empty queue.
      val item = queue.getJSONObject(index)
      require(item.optString("taskId").isNotBlank()) { "Invalid pending completion" }
      if (item.optString("actionId").isBlank()) item.put("actionId", "legacy:$index")
    }
    return queue
  }

  private fun writeQueue(context: Context, queue: JSONArray) {
    val saved = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
      .putString(PENDING_COMPLETIONS, queue.toString()).commit()
    check(saved) { "Pending completion persistence failed" }
  }

  /** Every Done tap is durable before cancellation or JS delivery, including a warm process. */
  @JvmStatic
  fun persistCompletion(context: Context, payload: Map<String, String>): String = synchronized(completionsLock) {
    require(!payload["taskId"].isNullOrBlank()) { "Invalid pending completion" }
    val queue = readQueue(context)
    // Repeated delivery of the same notification action owns the same receipt.
    val actionId = payload["actionId"]?.takeIf { it.isNotBlank() }
      ?: "done:${payload["taskId"]}:${payload["alarmKey"] ?: payload["id"] ?: ""}"
    if ((0 until queue.length()).none { queue.getJSONObject(it).getString("actionId") == actionId }) {
      queue.put(JSONObject(payload as Map<*, *>).put("actionId", actionId))
    }
    writeQueue(context, queue)
    actionId
  }

  /** Non-destructive replay. Receipts survive process death until the task save is acknowledged. */
  @JvmStatic
  fun peekCompletions(context: Context): List<Map<String, String>> = synchronized(completionsLock) {
    val queue = readQueue(context)
    // Persist IDs added to receipts from an earlier version before exposing them to JS.
    if (queue.length() > 0) writeQueue(context, queue)
    (0 until queue.length()).map { index ->
      val item = queue.getJSONObject(index)
      item.keys().asSequence().associateWith { item.getString(it) }
    }
  }

  @JvmStatic
  fun acknowledgeCompletion(context: Context, actionId: String) = synchronized(completionsLock) {
    require(actionId.isNotBlank()) { "Invalid completion receipt" }
    val stored = readQueue(context)
    val queue = JSONArray()
    for (index in 0 until stored.length()) {
      val item = stored.getJSONObject(index)
      if (item.getString("actionId") != actionId) queue.put(item)
    }
    writeQueue(context, queue)
  }
}
