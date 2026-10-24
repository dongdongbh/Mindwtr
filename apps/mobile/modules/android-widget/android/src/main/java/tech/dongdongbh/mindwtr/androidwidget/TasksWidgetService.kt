package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/**
 * Backs a widget's list; the adapter intent names the kind whose rows it serves.
 * The Tasks kind shows the Focus screen's sections (#1173): header rows plus
 * task rows with a priority dot and the project or area under the title.
 */
class TasksWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = TasksWidgetFactory(
    applicationContext,
    WidgetKind.fromName(intent.getStringExtra(WidgetRenderer.EXTRA_KIND)),
    intent.getIntExtra(android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID, android.appwidget.AppWidgetManager.INVALID_APPWIDGET_ID),
  )
}

class TasksWidgetFactory(
  private val context: Context,
  private val kind: WidgetKind,
  private val appWidgetId: Int,
  snapshot: WidgetPayload? = null,
) : RemoteViewsService.RemoteViewsFactory {
  /** One list row: a section header or a task. */
  sealed class Row {
    data class Header(val title: String, val detail: String?) : Row()
    data class Task(val item: WidgetPayload.Item) : Row()
    data class Footer(val label: String, val openUri: String) : Row()
  }

  private var payload: WidgetPayload = WidgetPayload.EMPTY
  private var listPayload: WidgetPayload.ListPayload = WidgetPayload.EMPTY.listFor(WidgetListStore.DEFAULT_LIST)
  private var listId: String = WidgetListStore.DEFAULT_LIST
  private var compact = false
  private var baseRows: List<Row> = emptyList()
  private var footerRow: Row.Footer? = null
  private var rows: List<Row> = emptyList()

  init {
    snapshot?.let { setSnapshot(it) }
  }

  override fun onCreate() = reload()

  override fun onDataSetChanged() = reload()

  private fun reload() {
    setSnapshot(WidgetPayloadStore.read(context)
      .displaySnapshot(CheckoffStore.committed(context))
      .payload)
  }

  /** Direct collections and the legacy service share the exact same rows. */
  private fun setSnapshot(snapshot: WidgetPayload) {
    payload = snapshot.displaySnapshot(emptySet()).payload
    val requestedListId = when (kind) {
      WidgetKind.TASKS -> WidgetListStore.read(context, appWidgetId)
      WidgetKind.COMPACT -> payload.compactListId()
      WidgetKind.QUICK_CAPTURE -> WidgetListStore.DEFAULT_LIST
    }
    listId = payload.resolvedListId(requestedListId)
    compact = kind == WidgetKind.COMPACT
    listPayload = payload.listFor(listId)
    baseRows = if (kind.hasTaskList) buildBaseRows(listPayload, compact) else emptyList()
    footerRow = Row.Footer(payload.formatViewAllLabel(listPayload.eligibleTaskCount()), payload.openUriFor(listId))
    rows = rowsForTaskLimit(publishedTaskCount())
  }

  override fun onDestroy() {}

  override fun getCount(): Int = rows.size

  override fun getViewAt(position: Int): RemoteViews = viewForRow(rows[position])

  internal fun viewForRow(row: Row): RemoteViews {
    val palette = payload.resolvedPalette(context)
    return when (row) {
      is Row.Header -> RemoteViews(context.packageName, R.layout.mindwtr_widget_section).apply {
        // Section rows live inside the ListView, so the parent's blank-space
        // click cannot receive their taps. Use its existing explicit row template.
        setOnClickFillInIntent(
          R.id.mindwtr_widget_section,
          Intent().setData(Uri.parse(payload.openUriFor(listId))),
        )
        setTextViewText(R.id.mindwtr_widget_section_title, row.title)
        setViewVisibility(R.id.mindwtr_widget_section_detail, if (row.detail == null) View.GONE else View.VISIBLE)
        if (row.detail != null) setTextViewText(R.id.mindwtr_widget_section_detail, row.detail)
        palette?.let {
          setTextColor(R.id.mindwtr_widget_section_title, it.text)
          setTextColor(R.id.mindwtr_widget_section_detail, it.mutedText)
          setInt(R.id.mindwtr_widget_section_divider, "setBackgroundColor", it.border)
        }
      }
      is Row.Task -> taskRow(row.item, palette)
      is Row.Footer -> RemoteViews(context.packageName, R.layout.mindwtr_widget_footer).apply {
        setTextViewText(R.id.mindwtr_widget_footer_label, row.label)
        setContentDescription(R.id.mindwtr_widget_footer, row.label)
        setOnClickFillInIntent(R.id.mindwtr_widget_footer, Intent().setData(Uri.parse(row.openUri)))
        palette?.let {
          setTextColor(R.id.mindwtr_widget_footer_label, it.text)
          setInt(R.id.mindwtr_widget_footer_divider, "setBackgroundColor", it.border)
        }
      }
    }
  }

  private fun taskRow(item: WidgetPayload.Item, palette: WidgetPayload.Palette?): RemoteViews {
    if (kind == WidgetKind.COMPACT) return compactTaskRow(item, palette)
    val views = RemoteViews(context.packageName, R.layout.mindwtr_widget_item)
    val mutedText = palette?.mutedText ?: context.getColor(R.color.mindwtr_widget_muted_text)
    val struck = item.id.isNotEmpty() && CheckoffStore.isStruck(context, item.id)
    val title = boundedDisplayText(item.title)
    views.setTextViewText(R.id.mindwtr_widget_item_title, if (struck) struck(title) else title)
    // Priority ring: the priority colour, grey when the task has none; filled
    // while a check-off waits for its undo window or for the app to ingest it.
    views.setImageViewResource(
      R.id.mindwtr_widget_item_priority,
      if (struck) R.drawable.mindwtr_widget_circle else R.drawable.mindwtr_widget_ring,
    )
    views.setInt(R.id.mindwtr_widget_item_priority, "setColorFilter", item.priorityColor ?: mutedText)
    // The ring checks the task off or undoes it only inside the short window;
    // later stale taps reconcile presentation without touching the queue.
    // Without an action here the tap fell through
    // to the row and opened the app, which read as "check-off does nothing".
    views.setViewVisibility(R.id.mindwtr_widget_item_ring_target, if (item.id.isEmpty()) View.GONE else View.VISIBLE)
    if (item.id.isNotEmpty()) {
      views.setOnClickFillInIntent(R.id.mindwtr_widget_item_ring_target, Intent().setData(Uri.parse(WidgetTapActivity.checkoffUri(item.id))))
    }
    val contextLabel = listOfNotNull(item.statusLabel.takeIf { item.showStatus }, item.contextLabel)
      .joinToString(" · ").takeIf { it.isNotEmpty() }?.let(::boundedDisplayText)
    views.setViewVisibility(R.id.mindwtr_widget_item_context_row, if (contextLabel == null) View.GONE else View.VISIBLE)
    if (contextLabel != null) {
      views.setTextViewText(R.id.mindwtr_widget_item_context, contextLabel)
      views.setViewVisibility(R.id.mindwtr_widget_item_identity, if (item.identityColor == null) View.GONE else View.VISIBLE)
      item.identityColor?.let { views.setInt(R.id.mindwtr_widget_item_identity, "setColorFilter", it) }
    }
    val dueLabel = item.dueLabel
    views.setViewVisibility(R.id.mindwtr_widget_item_due, if (dueLabel == null) View.GONE else View.VISIBLE)
    if (dueLabel != null) {
      views.setTextViewText(R.id.mindwtr_widget_item_due, dueLabel)
      val dueColor = when (item.dueTone) {
        WidgetPayload.DueTone.TODAY -> palette?.accent ?: context.getColor(R.color.mindwtr_widget_accent)
        WidgetPayload.DueTone.OVERDUE -> palette?.warning ?: context.getColor(R.color.mindwtr_widget_warning)
        WidgetPayload.DueTone.NORMAL -> mutedText
      }
      views.setTextColor(R.id.mindwtr_widget_item_due, dueColor)
    }
    if (palette != null) {
      views.setTextColor(R.id.mindwtr_widget_item_title, palette.text)
      views.setTextColor(R.id.mindwtr_widget_item_context, palette.mutedText)
      views.setInt(R.id.mindwtr_widget_item_divider, "setBackgroundColor", palette.border)
    }
    // Merged into the renderer's row template, which fixes component + action
    // and leaves the data to this row: the task's own sheet, else Focus.
    val rowUri = if (item.id.isNotEmpty()) WidgetTapActivity.peekUri(item.id) else payload.focusUri
    views.setOnClickFillInIntent(R.id.mindwtr_widget_item, Intent().setData(Uri.parse(rowUri)))
    return views
  }

  private fun compactTaskRow(item: WidgetPayload.Item, palette: WidgetPayload.Palette?): RemoteViews =
    RemoteViews(context.packageName, R.layout.mindwtr_compact_widget_item).apply {
      val title = "• ${boundedDisplayText(item.title)}"
      setTextViewText(R.id.mindwtr_widget_item_title, if (CheckoffStore.isStruck(context, item.id)) struck(title) else title)
      palette?.let { setTextColor(R.id.mindwtr_widget_item_title, it.text) }
      val uri = if (item.id.isNotEmpty()) WidgetTapActivity.peekUri(item.id) else payload.focusUri
      setOnClickFillInIntent(R.id.mindwtr_widget_item, Intent().setData(Uri.parse(uri)))
    }

  private fun struck(title: String): CharSequence = SpannableString(title).apply {
    setSpan(StrikethroughSpan(), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }

  override fun getLoadingView(): RemoteViews? = null

  override fun getViewTypeCount(): Int = 3

  override fun getItemId(position: Int): Long = position.toLong()

  override fun hasStableIds(): Boolean = false

  companion object {
    private const val MAX_DISPLAY_TEXT = 512

    private fun boundedDisplayText(value: String): String =
      if (value.length <= MAX_DISPLAY_TEXT) value else value.take(MAX_DISPLAY_TEXT - 1) + "…"

    /** Sectioned rows when the list carries sections, else the flat list. */
    fun buildBaseRows(list: WidgetPayload.ListPayload, compact: Boolean = false): List<Row> {
      if (list.sections.isEmpty()) return list.items.map { Row.Task(it) }
      return list.sections.flatMap { section ->
        (if (compact) emptyList() else listOf<Row>(Row.Header(section.title, section.detail))) + section.items.map { Row.Task(it) }
      }
    }

    /** Legacy test/helper surface: old payloads have no total, so no synthetic footer. */
    fun buildRows(list: WidgetPayload.ListPayload, compact: Boolean = false): List<Row> =
      buildBaseRows(list, compact)

    fun takeTaskRows(rows: List<Row>, taskLimit: Int): List<Row> {
      if (taskLimit <= 0) return emptyList()
      val result = ArrayList<Row>()
      var pendingHeader: Row.Header? = null
      var tasks = 0
      for (row in rows) {
        when (row) {
          is Row.Header -> pendingHeader = row
          is Row.Task -> {
            if (tasks >= taskLimit) return result
            pendingHeader?.let { result.add(it) }
            pendingHeader = null
            result.add(row)
            tasks += 1
          }
          is Row.Footer -> Unit
        }
      }
      return result
    }
  }

  internal fun publishedTaskCount(): Int = baseRows.count { it is Row.Task }

  internal fun eligibleTaskCount(): Int = listPayload.eligibleTaskCount()

  internal fun baseRows(): List<Row> = baseRows

  internal fun rowsForTaskLimit(taskLimit: Int): List<Row> {
    val limited = takeTaskRows(baseRows, taskLimit.coerceAtMost(publishedTaskCount()))
    val renderedCount = limited.filterIsInstance<Row.Task>().distinctBy { it.item.id }.size
    val totalCount = listPayload.eligibleTaskCount()
    if (renderedCount >= totalCount) return limited
    return limited + requireNotNull(footerRow)
  }
}
