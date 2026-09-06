package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The widget payload the React Native side publishes (widget-service.ts,
 * `AndroidTasksWidgetPayload`), shared by every widget kind. Every string the
 * widgets or the quick-capture dialog show is localized in TypeScript; Kotlin
 * only lays it out. Unknown keys (such as a future `sections` array) are ignored.
 */
data class WidgetPayload(
  val headerTitle: String,
  val dateLabel: String,
  val inboxLabel: String,
  val inboxCount: Int,
  val items: List<Item>,
  val sections: List<Section>,
  val lists: Map<String, ListPayload>,
  val listTitles: Map<String, String>,
  val projects: List<ProjectOption>,
  val emptyMessage: String,
  val focusUri: String,
  val themeMode: String,
  val palette: Palette?,
  val quickCapture: QuickCaptureLabels,
) {
  data class Item(
    val title: String,
    val dueLabel: String?,
    val dueEmphasis: Boolean,
    val openUri: String?,
    val priorityColor: Int?,
    val contextLabel: String?,
    val identityColor: Int?,
    val dueTone: DueTone,
  )

  enum class DueTone { OVERDUE, TODAY, NORMAL }

  /** A Focus screen section (#1173): title plus its rows, in screen order. */
  data class Section(val title: String, val detail: String?, val items: List<Item>)

  /** One list a placed Tasks widget can show (#1173). */
  data class ListPayload(val title: String, val dateLabel: String?, val sections: List<Section>, val items: List<Item>)

  data class ProjectOption(val id: String, val title: String, val identityColor: Int?)

  data class Palette(
    val background: Int,
    val card: Int,
    val text: Int,
    val mutedText: Int,
    val accent: Int,
    val onAccent: Int,
    val border: Int,
    val warning: Int,
    val headerWash: Int,
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

  /** The list a widget should draw: its selection when the payload has it, else the Focus list. */
  fun listFor(listId: String): ListPayload =
    lists[listId] ?: lists[WidgetListStore.DEFAULT_LIST] ?: ListPayload(headerTitle, dateLabel, sections, items)

  companion object {
    const val DEFAULT_FOCUS_URI = "mindwtr:///focus"
    const val MAX_ITEMS = 50

    val EMPTY = WidgetPayload(
      headerTitle = "Today's Focus",
      dateLabel = "",
      inboxLabel = "Inbox",
      inboxCount = 0,
      items = emptyList(),
      sections = emptyList(),
      lists = emptyMap(),
      listTitles = emptyMap(),
      projects = emptyList(),
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
      val items = parseItems(root.optJSONArray("items"))
      val sections = parseSections(root.optJSONArray("sections"))
      val lists = LinkedHashMap<String, ListPayload>()
      root.optJSONObject("lists")?.let { listsJson ->
        for (key in listsJson.keys()) {
          val list = listsJson.optJSONObject(key) ?: continue
          lists[key] = ListPayload(
            title = list.stringOr("title", key),
            dateLabel = list.optString("dateLabel").trim().takeIf { it.isNotEmpty() && !list.isNull("dateLabel") },
            sections = parseSections(list.optJSONArray("sections")),
            items = parseItems(list.optJSONArray("items")),
          )
        }
      }
      val listTitles = LinkedHashMap<String, String>()
      root.optJSONObject("listTitles")?.let { titles -> for (key in titles.keys()) listTitles[key] = titles.optString(key) }
      val projects = ArrayList<ProjectOption>()
      root.optJSONArray("projects")?.let { list ->
        for (index in 0 until list.length()) {
          val project = list.optJSONObject(index) ?: continue
          val id = project.optString("id").trim()
          if (id.isEmpty()) continue
          projects.add(ProjectOption(id, project.stringOr("title", id), parseHexColor(project.optString("identityColor"))))
        }
      }
      // Only the app's own routes may be launched from a tap.
      val focusUri = appUriOrNull(root.optString("focusUri")) ?: DEFAULT_FOCUS_URI
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
        dateLabel = root.stringOr("dateLabel", defaults.dateLabel),
        inboxLabel = root.stringOr("inboxLabel", defaults.inboxLabel),
        inboxCount = maxOf(0, root.optInt("inboxCount", 0)),
        items = items,
        sections = sections,
        lists = lists,
        listTitles = listTitles,
        projects = projects,
        emptyMessage = root.stringOr("emptyMessage", defaults.emptyMessage),
        focusUri = focusUri,
        themeMode = root.stringOr("themeMode", "system"),
        palette = parsePalette(root.optJSONObject("palette")),
        quickCapture = quickCapture,
      )
    }

    private fun parseSections(json: JSONArray?): List<Section> {
      val sections = ArrayList<Section>()
      if (json == null) return sections
      for (index in 0 until json.length()) {
        val section = json.optJSONObject(index) ?: continue
        val sectionItems = parseItems(section.optJSONArray("items"))
        if (sectionItems.isEmpty()) continue
        sections.add(Section(section.stringOr("title", ""), section.optString("detail").trim().takeIf { it.isNotEmpty() && !section.isNull("detail") }, sectionItems))
      }
      return sections
    }

    private fun parseItems(json: JSONArray?): List<Item> {
      val items = ArrayList<Item>()
      if (json == null) return items
      for (index in 0 until minOf(json.length(), MAX_ITEMS)) {
        val item = json.optJSONObject(index) ?: continue
        val title = item.optString("title").trim()
        if (title.isEmpty()) continue
        items.add(
          Item(
            title = title,
            dueLabel = item.optString("dueLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("dueLabel") },
            dueEmphasis = item.optBoolean("dueEmphasis", false),
            openUri = appUriOrNull(item.optString("openUri")),
            priorityColor = parseHexColor(item.optString("priorityColor")),
            contextLabel = item.optString("contextLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("contextLabel") },
            identityColor = parseHexColor(item.optString("identityColor")),
            dueTone = when (item.optString("dueTone")) {
              "overdue" -> DueTone.OVERDUE
              "today" -> DueTone.TODAY
              else -> if (item.optBoolean("dueEmphasis", false)) DueTone.TODAY else DueTone.NORMAL
            },
          ),
        )
      }
      return items
    }

    private fun parsePalette(json: JSONObject?): Palette? {
      if (json == null) return null
      val background = parseHexColor(json.optString("background")) ?: return null
      val text = parseHexColor(json.optString("text")) ?: return null
      return Palette(
        background = background,
        card = parseHexColor(json.optString("card")) ?: background,
        text = text,
        mutedText = parseHexColor(json.optString("mutedText")) ?: text,
        accent = parseHexColor(json.optString("accent")) ?: text,
        onAccent = parseHexColor(json.optString("onAccent")) ?: background,
        border = parseHexColor(json.optString("border")) ?: (parseHexColor(json.optString("mutedText")) ?: text),
        warning = parseHexColor(json.optString("warning")) ?: (parseHexColor(json.optString("accent")) ?: text),
        headerWash = parseHexColor(json.optString("headerWash"))
          ?: WidgetRenderer.withAlpha(parseHexColor(json.optString("accent")) ?: text, 0x2E),
      )
    }

    fun appUriOrNull(value: String?): String? = value?.takeIf { it.startsWith("mindwtr:") }

    /**
     * `#RRGGBB` or `#RRGGBBAA` (CSS order, what core's getAccentTint writes) to
     * an ARGB int; android.graphics.Color is a stub on the JVM.
     */
    fun parseHexColor(value: String?): Int? {
      val hex = value?.trim()?.removePrefix("#") ?: return null
      val digits = when (hex.length) {
        6 -> "FF$hex"
        8 -> hex.substring(6, 8) + hex.substring(0, 6)
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
