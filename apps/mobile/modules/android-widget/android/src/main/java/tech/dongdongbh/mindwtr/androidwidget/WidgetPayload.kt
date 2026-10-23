package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.res.Configuration
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.DateFormat
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The widget payload the React Native side publishes (widget-service.ts,
 * `AndroidTasksWidgetPayload`), shared by every widget kind. Every string the
 * widgets or the quick-capture dialog show is localized in TypeScript; Kotlin
 * refreshes Upcoming dates in the current locale/timezone. Unknown keys are ignored.
 */
data class WidgetPayload(
  val headerTitle: String,
  val dateLabel: String,
  val inboxLabel: String,
  val inboxCount: Int,
  val subtitle: String,
  val items: List<Item>,
  val sections: List<Section>,
  val lists: Map<String, ListPayload>,
  val listTitles: Map<String, String>,
  val savedFilters: List<SavedFilterOption>,
  val contexts: List<SavedFilterOption> = emptyList(),
  val tags: List<SavedFilterOption> = emptyList(),
  val emptyMessage: String,
  val focusUri: String,
  val themeMode: String,
  val palette: Palette?,
  val quickCapture: QuickCaptureLabels,
  val taskPeek: TaskPeekLabels,
  val chooseListLabel: String = "Change",
  val viewAllLabel: String = "View all {{count}} tasks",
) {
  data class DisplaySnapshot(val sourceTaskIds: Set<String>, val payload: WidgetPayload)

  data class Item(
    val id: String,
    val title: String,
    val dueLabel: String?,
    val dueEmphasis: Boolean,
    val openUri: String?,
    val priorityColor: Int?,
    val contextLabel: String?,
    val identityColor: Int?,
    val dueTone: DueTone,
    // Only the task sheet reads the rest; absent on rows that carry none.
    val description: String?,
    val contexts: List<String>,
    val tags: List<String>,
    val startLabel: String?,
    val priorityLabel: String?,
    val upcomingDate: String? = null,
    val upcomingLabel: String? = null,
  )

  enum class DueTone { OVERDUE, TODAY, NORMAL }

  /** A Focus screen section (#1173): title plus its rows, in screen order. */
  data class Section(val title: String, val detail: String?, val items: List<Item>)

  /** One list a placed Tasks widget can show (#1173). */
  data class ListPayload(
    val title: String,
    val dateLabel: String?,
    val sections: List<Section>,
    val items: List<Item>,
    val openUri: String? = null,
    val totalCount: Int? = null,
  ) {
    fun taskIds(): Set<String> {
      val ids = HashSet<String>()
      items.forEach { if (it.id.isNotEmpty()) ids.add(it.id) }
      sections.forEach { section -> section.items.forEach { if (it.id.isNotEmpty()) ids.add(it.id) } }
      return ids
    }

    fun renderedTaskCount(): Int =
      if (sections.isEmpty()) items.size else sections.sumOf { it.items.size }

    fun eligibleTaskCount(): Int = totalCount ?: renderedTaskCount()
  }

  data class SavedFilterOption(val id: String, val name: String)

  data class Palette(
    val background: Int,
    val card: Int,
    val text: Int,
    val mutedText: Int,
    val accent: Int,
    val onAccent: Int,
    val border: Int,
    val warning: Int,
  )

  data class TaskPeekLabels(
    val complete: String,
    val open: String,
    val start: String,
    val due: String,
    val priority: String,
  )

  data class QuickCaptureLabels(
    val title: String,
    val placeholder: String,
    val save: String,
    val cancel: String,
    val added: String,
    val audioEnabled: Boolean = false,
    val audioRecord: String,
    val audioStop: String,
    val audioRecording: String,
    val audioReady: String,
    val audioSaved: String,
    val audioError: String,
    val audioPermissionDenied: String,
    val descriptionPlaceholder: String = "Description (optional)",
    val statusLabel: String = "Status",
    val statusLabels: Map<String, String> = mapOf("inbox" to "Inbox", "next" to "Next Actions", "waiting" to "Waiting For", "someday" to "Someday/Maybe"),
    val queued: String = "Saved. Your task will be added when Mindwtr opens.",
  )

  /** True when the launcher's own day/night resources should color the widget. */
  val usesSystemColors: Boolean get() = palette == null || themeMode == "system"

  fun resolvedPalette(context: Context): Palette? = when {
    themeMode == "system-oled" -> if (
      (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    ) OLED_PALETTE else null
    usesSystemColors -> null
    else -> palette
  }

  /** Every task id the payload can draw, across the flat list, the sections and every named list. */
  fun allTaskIds(): Set<String> {
    val ids = HashSet<String>()
    items.forEach { ids.add(it.id) }
    sections.forEach { section -> section.items.forEach { ids.add(it.id) } }
    lists.values.forEach { list ->
      list.items.forEach { ids.add(it.id) }
      list.sections.forEach { section -> section.items.forEach { ids.add(it.id) } }
    }
    ids.remove("")
    return ids
  }

  /**
   * Builds the launcher-facing snapshot without mutating the app-published
   * payload. [sourceTaskIds] deliberately comes from the unfiltered payload so
   * committed check-offs can still be reconciled after the app ingests them.
   */
  fun displaySnapshot(hiddenTaskIds: Set<String>, now: Date = Date(), timeZone: TimeZone = TimeZone.getDefault()): DisplaySnapshot {
    if (hiddenTaskIds.isEmpty() && UPCOMING_LIST_ID !in lists) return DisplaySnapshot(allTaskIds(), this)
    fun visible(items: List<Item>): List<Item> = items.filterNot { it.id in hiddenTaskIds }
    fun visible(sections: List<Section>): List<Section> = sections.mapNotNull { section ->
      section.copy(items = visible(section.items)).takeIf { it.items.isNotEmpty() }
    }
    fun visible(list: ListPayload): ListPayload {
      val hiddenInList = list.taskIds().count { it in hiddenTaskIds }
      val visibleSections = visible(list.sections)
      val visibleItems = visible(list.items)
      val visibleRowCount = if (visibleSections.isEmpty()) visibleItems.size else visibleSections.sumOf { it.items.size }
      return list.copy(
        sections = visibleSections,
        items = visibleItems,
        totalCount = list.totalCount?.let { (it - hiddenInList).coerceAtLeast(visibleRowCount) },
      )
    }
    return DisplaySnapshot(
      sourceTaskIds = allTaskIds(),
      payload = copy(
        items = visible(items),
        sections = visible(sections),
        lists = lists.mapValues { (id, list) ->
          val unhidden = visible(list)
          if (id == UPCOMING_LIST_ID) unhidden.upcomingSnapshot(now, timeZone) else unhidden
        },
      ),
    )
  }

  private fun ListPayload.upcomingSnapshot(now: Date, timeZone: TimeZone): ListPayload {
    val today = Calendar.getInstance(timeZone).apply {
      time = now
      set(Calendar.HOUR_OF_DAY, 0)
      set(Calendar.MINUTE, 0)
      set(Calendar.SECOND, 0)
      set(Calendar.MILLISECOND, 0)
    }
    val tomorrow = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, 1) }.time
    val afterWindow = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_MONTH, 8) }.time
    fun preview(items: List<Item>): List<Item> = items.mapNotNull { item ->
      val raw = item.upcomingDate ?: return@mapNotNull null
      val date = parseUpcomingDate(raw, timeZone) ?: return@mapNotNull null
      if (date.before(tomorrow) || !date.before(afterWindow)) return@mapNotNull null
      val format = if (DATE_ONLY.matches(raw)) DateFormat.getDateInstance(DateFormat.MEDIUM)
      else DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
      format.timeZone = timeZone
      item.copy(
        dueLabel = item.upcomingLabel?.let { "$it ${format.format(date)}" } ?: item.dueLabel,
        dueEmphasis = false,
        dueTone = DueTone.NORMAL,
      )
    }
    val nextItems = preview(items)
    val nextSections = sections.mapNotNull { section ->
      section.copy(items = preview(section.items)).takeIf { it.items.isNotEmpty() }
    }
    val removed = taskIds() - (nextItems.map { it.id } + nextSections.flatMap { it.items.map { item -> item.id } }).toSet()
    return copy(
      items = nextItems,
      sections = nextSections,
      totalCount = totalCount?.let { (it - removed.size).coerceAtLeast(if (nextSections.isEmpty()) nextItems.size else nextSections.sumOf { section -> section.items.size }) },
    )
  }

  /** The row a tap names, wherever the payload carries it; null when the payload has moved on. */
  fun itemFor(taskId: String): Item? {
    if (taskId.isEmpty()) return null
    items.firstOrNull { it.id == taskId }?.let { return it }
    sections.forEach { section -> section.items.firstOrNull { it.id == taskId }?.let { return it } }
    lists.values.forEach { list ->
      list.items.firstOrNull { it.id == taskId }?.let { return it }
      list.sections.forEach { section -> section.items.firstOrNull { it.id == taskId }?.let { return it } }
    }
    return null
  }

  /** A list the chooser offers, named even before the app has built its rows. */
  fun titleFor(listId: String): String? =
    lists[listId]?.title
      ?: listTitles[listId]
      ?: savedFilters.firstOrNull { listId == WidgetListStore.FILTER_PREFIX + it.id }?.name
      ?: (contexts + tags).firstOrNull { it.id == listId }?.name
      ?: listId.substringAfter(":").takeIf { WidgetListStore.isTokenList(listId) && navigableListIdOrNull(listId) != null }
      ?: "Upcoming".takeIf { listId == UPCOMING_LIST_ID }

  /** Unknown/retired selections draw and navigate as Focus; known legacy project payloads remain usable. */
  fun resolvedListId(listId: String): String =
    navigableListIdOrNull(listId)?.takeIf {
      !it.startsWith(WidgetListStore.PROJECT_PREFIX) || titleFor(it) != null
    }
      ?: WidgetListStore.DEFAULT_LIST

  /**
   * The list a widget should draw. A selection the app has not published yet
   * (a project just picked in the chooser) draws under its own name and empty,
   * never as the Focus rows wearing another list's title; an id we cannot name
   * at all falls back to Focus.
   */
  fun listFor(listId: String): ListPayload =
    lists[listId]
      ?: (if (listId == WidgetListStore.DEFAULT_LIST) null else titleFor(listId)?.let { ListPayload(it, null, emptyList(), emptyList()) })
      ?: lists[WidgetListStore.DEFAULT_LIST]
      ?: ListPayload(headerTitle, dateLabel, sections, items)

  /** Compact shows Next Actions only when Focus has no flat or section rows. */
  fun compactListId(): String {
    val focus = listFor(WidgetListStore.DEFAULT_LIST)
    val next = lists[NEXT_LIST_ID]
    return if (!focus.hasRows() && next?.hasRows() == true) NEXT_LIST_ID else WidgetListStore.DEFAULT_LIST
  }

  /** Safe app destination for a selected list; unknown legacy ids return Focus. */
  fun openUriFor(listId: String): String {
    val safeFocusUri = listAppUriOrNull(focusUri, WidgetListStore.DEFAULT_LIST) ?: DEFAULT_FOCUS_URI
    val validListId = resolvedListId(listId)
    lists[validListId]?.openUri?.let { return it }
    return when (validListId) {
      WidgetListStore.DEFAULT_LIST -> safeFocusUri
      "inbox" -> "mindwtr:///inbox"
      NEXT_LIST_ID -> listRoute(validListId)
      "waiting" -> "mindwtr:///waiting"
      "someday" -> "mindwtr:///someday"
      else -> listRoute(validListId)
    }
  }

  private fun listRoute(listId: String): String =
    "mindwtr:///widget-list/${URLEncoder.encode(listId, Charsets.UTF_8.name()).replace("+", "%20")}"

  private fun ListPayload.hasRows(): Boolean = items.isNotEmpty() || sections.any { it.items.isNotEmpty() }

  fun formatViewAllLabel(count: Int): String = viewAllLabel
    .replace("{{count}}", count.toString())
    .replace("{count}", count.toString())

  companion object {
    private val OLED_PALETTE = Palette(
      background = 0xFF000000.toInt(), card = 0xFF000000.toInt(),
      text = 0xFFE5E7EB.toInt(), mutedText = 0xFF9CA3AF.toInt(),
      accent = 0xFF4F9DFF.toInt(), onAccent = 0xFF000000.toInt(),
      border = 0xFF1F2937.toInt(), warning = 0xFFFBBF24.toInt(),
    )
    const val DEFAULT_FOCUS_URI = "mindwtr:///focus"
    const val NEXT_LIST_ID = "next"
    const val UPCOMING_LIST_ID = "upcoming"
    const val MAX_ITEMS = 200
    private const val MAX_LIST_ID_LENGTH = 1_024
    private val FIXED_LIST_IDS = setOf(WidgetListStore.DEFAULT_LIST, "inbox", NEXT_LIST_ID, UPCOMING_LIST_ID, "waiting", "someday")
    private val DATE_ONLY = Regex("""\d{4}-\d{2}-\d{2}""")
    private val DATE_TIME = Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?""")

    private fun parseUpcomingDate(raw: String, timeZone: TimeZone): Date? {
      val pattern = when {
        DATE_ONLY.matches(raw) -> "yyyy-MM-dd'T'HH:mm"
        DATE_TIME.matches(raw) -> "yyyy-MM-dd'T'HH:mm" +
          (if (raw.getOrNull(16) == ':') ":ss" else "") +
          (if ('.' in raw) ".SSS" else "") +
          (if (raw.endsWith('Z') || raw.drop(10).contains('+') || raw.drop(10).contains('-')) "XXX" else "")
        else -> return null
      }
      // Noon compares calendar days even where a DST transition skips local midnight.
      val normalized = if (DATE_ONLY.matches(raw)) "${raw}T12:00"
      else raw.replace(Regex("""\.(\d{1,3})(?=Z|[+-]|$)""")) { ".${it.groupValues[1].padEnd(3, '0')}" }
      val parser = SimpleDateFormat(pattern, Locale.ROOT).apply {
        isLenient = false
        this.timeZone = timeZone
      }
      val position = ParsePosition(0)
      return parser.parse(normalized, position)?.takeIf { position.index == normalized.length }
    }

    val EMPTY = WidgetPayload(
      headerTitle = "Today's Focus",
      dateLabel = "",
      inboxLabel = "Inbox",
      inboxCount = 0,
      subtitle = "Inbox: 0",
      items = emptyList(),
      sections = emptyList(),
      lists = emptyMap(),
      listTitles = emptyMap(),
      savedFilters = emptyList(),
      emptyMessage = "All clear",
      focusUri = DEFAULT_FOCUS_URI,
      themeMode = "system",
      palette = null,
      quickCapture = QuickCaptureLabels(
        title = "Quick capture",
        placeholder = "Add a task… use @context +Project #tag",
        save = "Save",
        cancel = "Cancel",
        added = "Task added to Mindwtr.",
        audioEnabled = false,
        audioRecord = "Record audio",
        audioStop = "Stop recording",
        audioRecording = "Recording...",
        audioReady = "Recording ready to save.",
        audioSaved = "Saved. Audio will be transcribed when you open Mindwtr.",
        audioError = "We could not record audio. Please try again.",
        audioPermissionDenied = "Enable microphone access to record audio captures.",
      ),
      taskPeek = TaskPeekLabels(
        complete = "Complete",
        open = "Open",
        start = "Start",
        due = "Due date",
        priority = "Priority",
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
          val listSections = parseSections(list.optJSONArray("sections"))
          val listItems = parseItems(list.optJSONArray("items"))
          val rowCount = if (listSections.isEmpty()) listItems.size else listSections.sumOf { it.items.size }
          lists[key] = ListPayload(
            title = list.stringOr("title", key),
            dateLabel = list.optString("dateLabel").trim().takeIf { it.isNotEmpty() && !list.isNull("dateLabel") },
            sections = listSections,
            items = listItems,
            openUri = listAppUriOrNull(list.optString("openUri"), key),
            totalCount = list.optInt("totalCount", -1).takeIf { it >= 0 }?.coerceAtLeast(rowCount),
          )
        }
      }
      val listTitles = LinkedHashMap<String, String>()
      root.optJSONObject("listTitles")?.let { titles -> for (key in titles.keys()) listTitles[key] = titles.optString(key) }
      val savedFilters = ArrayList<SavedFilterOption>()
      root.optJSONArray("savedFilters")?.let { list ->
        for (index in 0 until list.length()) {
          val filter = list.optJSONObject(index) ?: continue
          val id = filter.optString("id").trim()
          val name = filter.optString("name").trim()
          if (id.isEmpty() || name.isEmpty()) continue
          savedFilters.add(SavedFilterOption(id, name))
        }
      }
      // Only the app's own routes may be launched from a tap.
      val focusUri = appUriOrNull(root.optString("focusUri")) ?: DEFAULT_FOCUS_URI
      val labels = root.optJSONObject("quickCapture")
      val quickCapture = QuickCaptureLabels(
        title = labels.stringOr("title", defaults.quickCapture.title),
        // Pre-status cached payloads still say "Add task to inbox".
        placeholder = if (labels?.optJSONObject("statusLabels") != null) labels.stringOr("placeholder", defaults.quickCapture.placeholder)
          else defaults.quickCapture.placeholder,
        statusLabel = labels.stringOr("statusLabel", defaults.quickCapture.statusLabel),
        statusLabels = defaults.quickCapture.statusLabels.mapValues { (status, fallback) ->
          labels?.optJSONObject("statusLabels").stringOr(status, fallback)
        },
        queued = labels.stringOr("queued", defaults.quickCapture.queued),
        descriptionPlaceholder = labels.stringOr("descriptionPlaceholder", defaults.quickCapture.descriptionPlaceholder),
        save = labels.stringOr("save", defaults.quickCapture.save),
        cancel = labels.stringOr("cancel", defaults.quickCapture.cancel),
        added = labels.stringOr("added", defaults.quickCapture.added),
        audioEnabled = labels?.optBoolean("audioEnabled", false) ?: false,
        audioRecord = labels.stringOr("audioRecord", defaults.quickCapture.audioRecord),
        audioStop = labels.stringOr("audioStop", defaults.quickCapture.audioStop),
        audioRecording = labels.stringOr("audioRecording", defaults.quickCapture.audioRecording),
        audioReady = labels.stringOr("audioReady", defaults.quickCapture.audioReady),
        audioSaved = labels.stringOr("audioSaved", defaults.quickCapture.audioSaved),
        audioError = labels.stringOr("audioError", defaults.quickCapture.audioError),
        audioPermissionDenied = labels.stringOr("audioPermissionDenied", defaults.quickCapture.audioPermissionDenied),
      )
      val peek = root.optJSONObject("taskPeek")
      val taskPeek = TaskPeekLabels(
        complete = peek.stringOr("complete", defaults.taskPeek.complete),
        open = peek.stringOr("open", defaults.taskPeek.open),
        start = peek.stringOr("start", defaults.taskPeek.start),
        due = peek.stringOr("due", defaults.taskPeek.due),
        priority = peek.stringOr("priority", defaults.taskPeek.priority),
      )
      val inboxLabel = root.stringOr("inboxLabel", defaults.inboxLabel)
      val inboxCount = maxOf(0, root.optInt("inboxCount", 0))
      return WidgetPayload(
        headerTitle = root.stringOr("headerTitle", defaults.headerTitle),
        chooseListLabel = root.stringOr("chooseListLabel", defaults.chooseListLabel),
        dateLabel = root.stringOr("dateLabel", defaults.dateLabel),
        inboxLabel = inboxLabel,
        inboxCount = inboxCount,
        // Payloads written before #1173 had no subtitle; keep their exact
        // Inbox count rather than showing a blank header chip.
        subtitle = root.stringOr("subtitle", "$inboxLabel: $inboxCount"),
        items = items,
        sections = sections,
        lists = lists,
        listTitles = listTitles,
        savedFilters = savedFilters,
        contexts = parseTokenOptions(root, "contexts", WidgetListStore.CONTEXT_PREFIX),
        tags = parseTokenOptions(root, "tags", WidgetListStore.TAG_PREFIX),
        emptyMessage = root.stringOr("emptyMessage", defaults.emptyMessage),
        focusUri = focusUri,
        themeMode = root.stringOr("themeMode", "system"),
        palette = parsePalette(root.optJSONObject("palette")),
        quickCapture = quickCapture,
        taskPeek = taskPeek,
        viewAllLabel = root.stringOr("viewAllLabel", defaults.viewAllLabel),
      )
    }

    private fun parseSections(json: JSONArray?): List<Section> {
      val sections = ArrayList<Section>()
      if (json == null) return sections
      var remaining = MAX_ITEMS
      for (index in 0 until json.length()) {
        if (remaining <= 0) break
        val section = json.optJSONObject(index) ?: continue
        val sectionItems = parseItems(section.optJSONArray("items"), remaining)
        if (sectionItems.isEmpty()) continue
        sections.add(Section(section.stringOr("title", ""), section.optString("detail").trim().takeIf { it.isNotEmpty() && !section.isNull("detail") }, sectionItems))
        remaining -= sectionItems.size
      }
      return sections
    }

    private fun parseItems(json: JSONArray?, maxItems: Int = MAX_ITEMS): List<Item> {
      val items = ArrayList<Item>()
      if (json == null) return items
      for (index in 0 until minOf(json.length(), maxItems)) {
        val item = json.optJSONObject(index) ?: continue
        val title = item.optString("title").trim()
        if (title.isEmpty()) continue
        items.add(
          Item(
            id = item.optString("id").trim(),
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
            description = item.optString("description").trim().takeIf { it.isNotEmpty() && !item.isNull("description") },
            contexts = parseStrings(item.optJSONArray("contexts")),
            tags = parseStrings(item.optJSONArray("tags")),
            startLabel = item.optString("startLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("startLabel") },
            priorityLabel = item.optString("priorityLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("priorityLabel") },
            upcomingDate = item.optString("upcomingDate").takeIf { !item.isNull("upcomingDate") },
            upcomingLabel = item.optString("upcomingLabel").trim().takeIf { it.isNotEmpty() && !item.isNull("upcomingLabel") },
          ),
        )
      }
      return items
    }

    private fun parseStrings(json: JSONArray?): List<String> {
      if (json == null) return emptyList()
      val values = ArrayList<String>()
      for (index in 0 until json.length()) {
        val value = json.optString(index).trim()
        if (value.isNotEmpty()) values.add(value)
      }
      return values
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
      )
    }

    fun appUriOrNull(value: String?): String? = value?.takeIf { it.startsWith("mindwtr:") }

    /** List navigation accepts only hostless, hierarchical routes owned by this app. */
    private fun listAppUriOrNull(value: String?, listId: String): String? {
      val validListId = navigableListIdOrNull(listId) ?: return null
      val candidate = value?.trim()?.takeIf { it.length in 1..MAX_LIST_URI_LENGTH } ?: return null
      val uri = try {
        URI(candidate)
      } catch (_: URISyntaxException) {
        return null
      }
      if (uri.scheme != "mindwtr" || uri.isOpaque || uri.rawAuthority != null || uri.rawQuery != null || uri.rawFragment != null) return null
      val routedListId = when (val path = uri.rawPath) {
        "/focus" -> WidgetListStore.DEFAULT_LIST
        "/inbox" -> "inbox"
        "/waiting" -> "waiting"
        "/someday" -> "someday"
        else -> {
          val segment = path?.removePrefix(LIST_ROUTE_PREFIX)?.takeIf { path.startsWith(LIST_ROUTE_PREFIX) && it.isNotEmpty() && !it.contains('/') }
            ?: return null
          val decoded = try {
            URLDecoder.decode(segment, Charsets.UTF_8.name())
          } catch (_: IllegalArgumentException) {
            return null
          }
          decoded.takeIf {
            it == NEXT_LIST_ID || it == UPCOMING_LIST_ID || it.startsWith(WidgetListStore.FILTER_PREFIX) || it.startsWith(WidgetListStore.PROJECT_PREFIX) || WidgetListStore.isTokenList(it)
          }
            ?: return null
        }
      }
      return candidate.takeIf { routedListId == validListId }
    }

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

    private const val MAX_LIST_URI_LENGTH = 12_512
    private const val LIST_ROUTE_PREFIX = "/widget-list/"

    private fun parseTokenOptions(root: JSONObject, field: String, prefix: String): List<SavedFilterOption> {
      val list = root.optJSONArray(field) ?: return emptyList()
      return (0 until list.length()).mapNotNull { index ->
        val option = list.optJSONObject(index) ?: return@mapNotNull null
        val id = option.optString("id")
        val name = option.optString("name")
        if (id.startsWith(prefix) && navigableListIdOrNull(id) != null && name.isNotBlank()) SavedFilterOption(id, name) else null
      }.distinctBy { it.id }
    }

    private fun navigableListIdOrNull(listId: String): String? = when {
      listId in FIXED_LIST_IDS -> listId
      WidgetListStore.isTokenList(listId) &&
        listId.length <= MAX_LIST_ID_LENGTH && listId.substringAfter(":").isNotBlank() &&
        listId.none(Char::isISOControl) -> listId
      listId.startsWith(WidgetListStore.FILTER_PREFIX) &&
        listId.length <= MAX_LIST_ID_LENGTH &&
        listId.removePrefix(WidgetListStore.FILTER_PREFIX).isNotBlank() &&
        listId.none(Char::isISOControl) -> listId
      listId.startsWith(WidgetListStore.PROJECT_PREFIX) &&
        listId.length <= MAX_LIST_ID_LENGTH &&
        listId.removePrefix(WidgetListStore.PROJECT_PREFIX).isNotBlank() &&
        listId.none(Char::isISOControl) -> listId
      else -> null
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

  /** False when the payload did not reach the disk: the caller publishes it again. */
  fun write(context: Context, json: String): Boolean =
    // commit(), not apply(): the widget provider and the dialog read this from
    // other components right after the write.
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(KEY_PAYLOAD, json).commit()

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
    val inboxLabel = root.optString("inboxLabel").trim().ifEmpty { WidgetPayload.EMPTY.inboxLabel }
    val previousCount = maxOf(0, root.optInt("inboxCount", 0))
    val nextCount = previousCount + 1
    val previousPrefix = "$inboxLabel: $previousCount"
    val publishedSubtitle = root.optString("subtitle").trim()
    val curatedSuffix = publishedSubtitle
      .takeIf { it.startsWith(previousPrefix) }
      ?.removePrefix(previousPrefix)
      .orEmpty()
    root.put("inboxCount", nextCount)
    // Keep the RN-published curated hidden count while advancing the Inbox
    // count immediately after native quick capture. A legacy or malformed
    // subtitle safely falls back to Inbox only.
    root.put("subtitle", "$inboxLabel: $nextCount$curatedSuffix")
    return root.toString()
  }
}
