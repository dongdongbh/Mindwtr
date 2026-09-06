package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StyleSpan
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/**
 * Backs a widget's list; the adapter intent names the kind whose rows it serves.
 * The Tasks kind shows the Focus screen's sections (#1173): header rows plus
 * task rows with a priority dot and the project or area under the title.
 */
class TasksWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
    TasksWidgetFactory(applicationContext, WidgetKind.fromName(intent.getStringExtra(WidgetRenderer.EXTRA_KIND)))
}

class TasksWidgetFactory(private val context: Context, private val kind: WidgetKind) : RemoteViewsService.RemoteViewsFactory {
  /** One list row: a section header or a task. */
  sealed class Row {
    data class Header(val title: String) : Row()
    data class Task(val item: WidgetPayload.Item) : Row()
  }

  private var payload: WidgetPayload = WidgetPayload.EMPTY
  private var rows: List<Row> = emptyList()

  override fun onCreate() = reload()

  override fun onDataSetChanged() = reload()

  private fun reload() {
    payload = WidgetPayloadStore.read(context)
    rows = if (kind == WidgetKind.TASKS) buildRows(payload) else emptyList()
  }

  override fun onDestroy() {}

  override fun getCount(): Int = rows.size

  override fun getViewAt(position: Int): RemoteViews {
    val palette = payload.palette?.takeUnless { payload.usesSystemColors }
    return when (val row = rows[position]) {
      is Row.Header -> RemoteViews(context.packageName, R.layout.mindwtr_widget_section).apply {
        setTextViewText(R.id.mindwtr_widget_section_title, row.title)
        palette?.let { setTextColor(R.id.mindwtr_widget_section_title, it.mutedText) }
      }
      is Row.Task -> taskRow(row.item, palette)
    }
  }

  private fun taskRow(item: WidgetPayload.Item, palette: WidgetPayload.Palette?): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.mindwtr_widget_item)
    views.setTextViewText(R.id.mindwtr_widget_item_title, item.title)
    val dot = item.priorityColor
    views.setViewVisibility(R.id.mindwtr_widget_item_priority, if (dot == null) View.GONE else View.VISIBLE)
    if (dot != null) views.setInt(R.id.mindwtr_widget_item_priority, "setColorFilter", dot)
    val contextLabel = item.contextLabel
    views.setViewVisibility(R.id.mindwtr_widget_item_context, if (contextLabel == null) View.GONE else View.VISIBLE)
    if (contextLabel != null) views.setTextViewText(R.id.mindwtr_widget_item_context, contextLabel)
    val dueLabel = item.dueLabel
    views.setViewVisibility(R.id.mindwtr_widget_item_due, if (dueLabel == null) View.GONE else View.VISIBLE)
    if (dueLabel != null) views.setTextViewText(R.id.mindwtr_widget_item_due, styledDueLabel(dueLabel, item.dueEmphasis))
    if (palette != null) {
      views.setTextColor(R.id.mindwtr_widget_item_title, palette.text)
      views.setTextColor(R.id.mindwtr_widget_item_context, palette.mutedText)
      views.setTextColor(R.id.mindwtr_widget_item_due, if (item.dueEmphasis) palette.accent else palette.mutedText)
    } else if (item.dueEmphasis) {
      views.setTextColor(R.id.mindwtr_widget_item_due, context.getColor(R.color.mindwtr_widget_accent))
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

  private fun styledDueLabel(label: String, emphasis: Boolean): CharSequence {
    if (!emphasis) return label
    return SpannableString(label).apply {
      setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  companion object {
    /** Sectioned rows when the payload carries sections, else the flat list (older payloads). */
    fun buildRows(payload: WidgetPayload): List<Row> {
      if (payload.sections.isEmpty()) return payload.items.map { Row.Task(it) }
      return payload.sections.flatMap { section ->
        listOf<Row>(Row.Header(section.title)) + section.items.map { Row.Task(it) }
      }
    }
  }
}
