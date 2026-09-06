package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import org.json.JSONException
import org.json.JSONObject

/**
 * The widget payload the React Native side publishes (widget-service.ts,
 * `AndroidTasksWidgetPayload`). Every string the widget or the quick-capture
 * dialog shows is localized in TypeScript; Kotlin only lays it out.
 */
data class WidgetPayload(
  val headerTitle: String,
  val inboxLabel: String,
  val inboxCount: Int,
  val items: List<Item>,
  val emptyMessage: String,
  val focusUri: String,
  val themeMode: String,
  val palette: Palette?,
  val quickCapture: QuickCaptureLabels,
) {
  data class Item(val title: String, val dueLabel: String?, val dueEmphasis: Boolean)

  data class Palette(
    val background: Int,
    val text: Int,
    val mutedText: Int,
    val accent: Int,
    val onAccent: Int,
  )

  data class QuickCaptureLabels(
    val title: String,
    val placeholder: String,
    val save: String,
    val cancel: String,
    val added: String,
  )

  /** True when the launcher's own day/night resources should color the widget. */
  val usesSystemColors: Boolean get() = palette == null || themeMode == "system"

  val subtitle: String get() = "$inboxLabel: $inboxCount"

  companion object {
    const val DEFAULT_FOCUS_URI = "mindwtr:///focus"
    const val MAX_ITEMS = 50

    val EMPTY = WidgetPayload(
      headerTitle = "Today's Focus",
      inboxLabel = "Inbox",
      inboxCount = 0,
      items = emptyList(),
      emptyMessage = "All clear",
      focusUri = DEFAULT_FOCUS_URI,
      themeMode = "system",
      palette = null,
      quickCapture = QuickCaptureLabels(
        title = "Quick capture",
        placeholder = "Add task to inbox...",
        save = "Save",
        cancel = "Cancel",
        added = "Task added to Mindwtr.",
      ),
    )

    fun parse(json: String): WidgetPayload? {
      val root = try {
        JSONObject(json)
      } catch (error: JSONException) {
        return null
      }
      val defaults = EMPTY
      val itemsJson = root.optJSONArray("items")
      val items = ArrayList<Item>()
      if (itemsJson != null) {
        for (index in 0 until minOf(itemsJson.length(), MAX_ITEMS)) {
          val item = itemsJson.optJSONObject(index) ?: continue
          val title = item.optString("title").trim()
          if (title.isEmpty()) continue
          val dueLabel = item.optString("dueLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("dueLabel") }
          items.add(Item(title, dueLabel, item.optBoolean("dueEmphasis", false)))
        }
      }
      // Only the app's own focus route may be launched from the header tap.
      val focusUri = root.optString("focusUri").takeIf { it.startsWith("mindwtr:") } ?: DEFAULT_FOCUS_URI
      val labels = root.optJSONObject("quickCapture")
      val quickCapture = QuickCaptureLabels(
        title = labels.stringOr("title", defaults.quickCapture.title),
        placeholder = labels.stringOr("placeholder", defaults.quickCapture.placeholder),
        save = labels.stringOr("save", defaults.quickCapture.save),
        cancel = labels.stringOr("cancel", defaults.quickCapture.cancel),
        added = labels.stringOr("added", defaults.quickCapture.added),
      )
      return WidgetPayload(
        headerTitle = root.stringOr("headerTitle", defaults.headerTitle),
        inboxLabel = root.stringOr("inboxLabel", defaults.inboxLabel),
        inboxCount = maxOf(0, root.optInt("inboxCount", 0)),
        items = items,
        emptyMessage = root.stringOr("emptyMessage", defaults.emptyMessage),
        focusUri = focusUri,
        themeMode = root.stringOr("themeMode", "system"),
        palette = parsePalette(root.optJSONObject("palette")),
        quickCapture = quickCapture,
      )
    }

    private fun parsePalette(json: JSONObject?): Palette? {
      if (json == null) return null
      val background = parseHexColor(json.optString("background")) ?: return null
      val text = parseHexColor(json.optString("text")) ?: return null
      return Palette(
        background = background,
        text = text,
        mutedText = parseHexColor(json.optString("mutedText")) ?: text,
        accent = parseHexColor(json.optString("accent")) ?: text,
        onAccent = parseHexColor(json.optString("onAccent")) ?: background,
      )
    }

    /** `#RRGGBB` or `#AARRGGBB` to an ARGB int; android.graphics.Color is a stub on the JVM. */
    fun parseHexColor(value: String?): Int? {
      val hex = value?.trim()?.removePrefix("#") ?: return null
      val digits = when (hex.length) {
        6 -> "FF$hex"
        8 -> hex
        else -> return null
      }
      return digits.toLongOrNull(16)?.toInt()
    }

    private fun JSONObject?.stringOr(key: String, fallback: String): String {
      val value = this?.optString(key)?.trim()
      return if (value.isNullOrEmpty()) fallback else value
    }
  }
}

/** The one place the payload JSON lives natively: SharedPreferences `mindwtr_widget` / `payload`. */
object WidgetPayloadStore {
  const val PREFS_NAME = "mindwtr_widget"
  const val KEY_PAYLOAD = "payload"

  fun readRaw(context: Context): String? =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_PAYLOAD, null)

  fun read(context: Context): WidgetPayload =
    readRaw(context)?.let { WidgetPayload.parse(it) } ?: WidgetPayload.EMPTY

  fun write(context: Context, json: String) {
    // commit(), not apply(): the widget provider and the dialog read this from
    // other components right after the write.
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(KEY_PAYLOAD, json).commit()
  }

  /** The quick-capture dialog saved one Inbox item; show it before the app next publishes. */
  fun incrementInboxCount(context: Context) {
    val raw = readRaw(context) ?: return
    val next = incrementInboxCount(raw) ?: return
    write(context, next)
  }

  fun incrementInboxCount(json: String): String? {
    val root = try {
      JSONObject(json)
    } catch (error: JSONException) {
      return null
    }
    root.put("inboxCount", maxOf(0, root.optInt("inboxCount", 0)) + 1)
    return root.toString()
  }
}
