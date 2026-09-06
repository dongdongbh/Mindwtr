package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StyleSpan
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** Backs the widget's task list; one row per payload item. */
class TasksWidgetService : RemoteViewsService() {
  override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = TasksWidgetFactory(applicationContext)
}

class TasksWidgetFactory(private val context: Context) : RemoteViewsService.RemoteViewsFactory {
  private var payload: WidgetPayload = WidgetPayload.EMPTY

  override fun onCreate() {
    payload = WidgetPayloadStore.read(context)
  }

  override fun onDataSetChanged() {
    payload = WidgetPayloadStore.read(context)
  }

  override fun onDestroy() {}

  override fun getCount(): Int = payload.items.size

  override fun getViewAt(position: Int): RemoteViews {
    val item = payload.items[position]
    val views = RemoteViews(context.packageName, R.layout.mindwtr_widget_item)
    views.setTextViewText(R.id.mindwtr_widget_item_title, "• ${item.title}")
    val dueLabel = item.dueLabel
    if (dueLabel == null) {
      views.setViewVisibility(R.id.mindwtr_widget_item_due, android.view.View.GONE)
    } else {
      views.setViewVisibility(R.id.mindwtr_widget_item_due, android.view.View.VISIBLE)
      views.setTextViewText(R.id.mindwtr_widget_item_due, styledDueLabel(dueLabel, item.dueEmphasis))
    }
    val palette = payload.palette?.takeUnless { payload.usesSystemColors }
    if (palette != null) {
      views.setTextColor(R.id.mindwtr_widget_item_title, palette.text)
      views.setTextColor(R.id.mindwtr_widget_item_due, if (item.dueEmphasis) palette.accent else palette.mutedText)
    } else if (item.dueEmphasis) {
      views.setTextColor(R.id.mindwtr_widget_item_due, context.getColor(R.color.mindwtr_widget_accent))
    }
    // Merged into the provider's row template (opens Focus); nothing to add.
    views.setOnClickFillInIntent(R.id.mindwtr_widget_item, Intent())
    return views
  }

  override fun getLoadingView(): RemoteViews? = null

  override fun getViewTypeCount(): Int = 1

  override fun getItemId(position: Int): Long = position.toLong()

  override fun hasStableIds(): Boolean = false

  private fun styledDueLabel(label: String, emphasis: Boolean): CharSequence {
    if (!emphasis) return label
    return SpannableString(label).apply {
      setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }
}
