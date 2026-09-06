package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
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
) : RemoteViewsService.RemoteViewsFactory {
  /** One list row: a section header or a task. */
  sealed class Row {
    data class Header(val title: String, val detail: String?) : Row()
    data class Task(val item: WidgetPayload.Item) : Row()
  }

  private var payload: WidgetPayload = WidgetPayload.EMPTY
  private var rows: List<Row> = emptyList()

  override fun onCreate() = reload()

  override fun onDataSetChanged() = reload()

  private fun reload() {
    payload = WidgetPayloadStore.read(context)
    rows = if (kind == WidgetKind.TASKS) buildRows(payload.listFor(WidgetListStore.read(context, appWidgetId))) else emptyList()
  }

  override fun onDestroy() {}

  override fun getCount(): Int = rows.size

  override fun getViewAt(position: Int): RemoteViews {
    val palette = payload.palette?.takeUnless { payload.usesSystemColors }
    return when (val row = rows[position]) {
      is Row.Header -> RemoteViews(context.packageName, R.layout.mindwtr_widget_section).apply {
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
    }
  }

  private fun taskRow(item: WidgetPayload.Item, palette: WidgetPayload.Palette?): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.mindwtr_widget_item)
    val mutedText = palette?.mutedText ?: context.getColor(R.color.mindwtr_widget_muted_text)
    views.setTextViewText(R.id.mindwtr_widget_item_title, item.title)
    // Priority ring: the priority colour, grey when the task has none; never filled.
    views.setInt(R.id.mindwtr_widget_item_priority, "setColorFilter", item.priorityColor ?: mutedText)
    val contextLabel = item.contextLabel
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
    // and leaves the data to this row: the task's own open link, else Focus.
    views.setOnClickFillInIntent(R.id.mindwtr_widget_item, Intent().setData(Uri.parse(item.openUri ?: payload.focusUri)))
    return views
  }

  override fun getLoadingView(): RemoteViews? = null

  override fun getViewTypeCount(): Int = 2

  override fun getItemId(position: Int): Long = position.toLong()

  override fun hasStableIds(): Boolean = false

  companion object {
    /** Sectioned rows when the list carries sections, else the flat list. */
    fun buildRows(list: WidgetPayload.ListPayload): List<Row> {
      if (list.sections.isEmpty()) return list.items.map { Row.Task(it) }
      return list.sections.flatMap { section ->
        listOf<Row>(Row.Header(section.title, section.detail)) + section.items.map { Row.Task(it) }
      }
    }
  }
}
