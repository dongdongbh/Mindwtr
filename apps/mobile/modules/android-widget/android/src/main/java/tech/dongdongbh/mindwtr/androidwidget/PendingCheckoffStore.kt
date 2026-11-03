package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject


internal class PendingCheckoffStore(private val context: Context) {
  private val file = AtomicFile(File(context.filesDir, FILE_NAME))


  @Throws(IOException::class)
  fun read(): Map<String, Long> {
    val atomic = try {
      decode(file.readFully().toString(Charsets.UTF_8))
    } catch (_: FileNotFoundException) {
      null
    }
    return resolveInitialState(atomic, legacyPending(context)) { legacy ->
      write(legacy)


      val cleared = context.getSharedPreferences(CheckoffStore.PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .clear()
        .commit()
      if (!cleared) Log.w(TAG, "Atomic pending check-offs migrated; legacy cleanup will retry")
    }
  }

  @Throws(IOException::class)
  fun write(pending: Map<String, Long>) {
    val stream = try {
      file.startWrite()
    } catch (error: IOException) {
      throw error
    }
    try {
      val encoded = encode(pending).toByteArray(Charsets.UTF_8)
      stream.write(encoded)


      stream.fd.sync()
      file.finishWrite(stream)
      if (!file.readFully().contentEquals(encoded)) throw IOException("Pending check-off write did not publish")
    } catch (error: Exception) {
      file.failWrite(stream)
      if (error is IOException) throw error
      throw IOException("Could not persist pending widget check-offs", error)
    }
  }

  companion object {
    internal const val FILE_NAME = "mindwtr-widget-checkoff-pending.json"
    private const val VERSION = 1
    private const val TAG = "MindwtrWidgetCheckoff"

    internal fun encode(pending: Map<String, Long>): String {
      val entries = JSONArray()
      for ((taskId, tappedAt) in pending.toSortedMap()) {
        entries.put(JSONObject().put("id", taskId).put("at", tappedAt))
      }
      return JSONObject()
        .put("version", VERSION)
        .put("pending", entries)
        .toString()
    }

    @Throws(IOException::class)
    internal fun decode(raw: String): Map<String, Long> {
      try {
        val root = JSONObject(raw)
        if (root.getInt("version") != VERSION) throw IOException("Unsupported pending check-off state")
        val entries = root.getJSONArray("pending")
        val pending = linkedMapOf<String, Long>()
        for (index in 0 until entries.length()) {
          val entry = entries.getJSONObject(index)
          val taskId = entry.getString("id")
          val rawTimestamp = entry.get("at")
          if (taskId.isBlank() || rawTimestamp !is Number || rawTimestamp is Double || rawTimestamp is Float) {
            throw IOException("Invalid pending check-off entry")
          }
          if (pending.put(taskId, rawTimestamp.toLong()) != null) {
            throw IOException("Duplicate pending check-off entry")
          }
        }
        return pending
      } catch (error: IOException) {
        throw error
      } catch (error: JSONException) {
        throw IOException("Invalid pending check-off state", error)
      }
    }

    internal fun resolveInitialState(
      atomic: Map<String, Long>?,
      legacy: Map<String, Long>,
      persistLegacy: (Map<String, Long>) -> Unit,
    ): Map<String, Long> {
      if (atomic != null) return atomic
      if (legacy.isEmpty()) return emptyMap()
      persistLegacy(legacy)
      return legacy
    }

    private fun legacyPending(context: Context): Map<String, Long> =
      context.getSharedPreferences(CheckoffStore.PREFS_NAME, Context.MODE_PRIVATE).all
        .mapNotNull { (key, value) -> (value as? Long)?.let { key to it } }
        .toMap()
  }
}
