package tech.dongdongbh.mindwtr.androidwidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.widget.RemoteViews

/** Draws every widget kind from the payload in [WidgetPayloadStore]. */
object WidgetRenderer {
  const val EXTRA_KIND = "tech.dongdongbh.mindwtr.androidwidget.kind"
  private const val REQUEST_FOCUS = 4611
  private const val REQUEST_CAPTURE = 4612
  private const val REQUEST_ROW = 4613

  fun refreshAll(context: Context) {
    val manager = AppWidgetManager.getInstance(context) ?: return
    for (kind in WidgetKind.entries) {
      val ids = manager.getAppWidgetIds(ComponentName(context, kind.providerClass))
      if (ids.isEmpty()) continue
      render(context, manager, ids, kind)
    }
  }

  fun render(context: Context, manager: AppWidgetManager, ids: IntArray, kind: WidgetKind) {
    // Commit check-offs whose undo window elapsed while nothing else ran.
    if (kind == WidgetKind.TASKS) CheckoffStore.sweep(context)
    val payload = WidgetPayloadStore.read(context)
    for (id in ids) {
      manager.updateAppWidget(id, buildViews(context, id, kind, payload))
    }
    if (kind == WidgetKind.TASKS) {
      manager.notifyAppWidgetViewDataChanged(ids, R.id.mindwtr_widget_list)
    }
  }

  private fun buildViews(context: Context, appWidgetId: Int, kind: WidgetKind, payload: WidgetPayload): RemoteViews {
    val views = RemoteViews(context.packageName, kind.layoutRes)
    val palette = payload.palette?.takeUnless { payload.usesSystemColors }
    val captureIntent = Intent(context, QuickCaptureActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    views.setOnClickPendingIntent(
      R.id.mindwtr_widget_capture,
      PendingIntent.getActivity(context, REQUEST_CAPTURE, captureIntent, immutableFlags()),
    )

    when (kind) {
      WidgetKind.TASKS -> bindTasks(context, views, appWidgetId, payload, palette)
      WidgetKind.QUICK_CAPTURE -> {
        views.setTextViewText(R.id.mindwtr_widget_title, payload.quickCapture.title)
        palette?.let {
          views.setInt(R.id.mindwtr_widget_capture_background, "setColorFilter", it.accent)
          views.setTextColor(R.id.mindwtr_widget_capture_label, it.onAccent)
          views.setTextColor(R.id.mindwtr_widget_title, it.text)
        }
      }
    }
    return views
  }

  private fun bindTasks(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    payload: WidgetPayload,
    palette: WidgetPayload.Palette?,
  ) {
    // Header: Focus shows the date plus the Inbox chip; any other list shows its
    // full title with a small count, so the header never reads as two lists.
    val listId = WidgetListStore.read(context, appWidgetId)
    val list = payload.listFor(listId)
    val isFocus = listId == WidgetListStore.DEFAULT_LIST || payload.lists[listId] == null
    val rowCount = if (list.sections.isEmpty()) list.items.size else list.sections.sumOf { it.items.size }
    views.setTextViewText(R.id.mindwtr_widget_title, if (isFocus) list.dateLabel?.ifEmpty { null } ?: list.title else "${list.title} · $rowCount")
    views.setTextViewText(R.id.mindwtr_widget_subtitle, "${payload.inboxLabel} ${payload.inboxCount}")
    views.setViewVisibility(R.id.mindwtr_widget_subtitle, if (isFocus) View.VISIBLE else View.GONE)
    views.setTextViewText(R.id.mindwtr_widget_empty, payload.emptyMessage)
    views.setViewVisibility(R.id.mindwtr_widget_empty, if (list.items.isEmpty() && list.sections.isEmpty()) View.VISIBLE else View.GONE)

    val adapterIntent = Intent(context, TasksWidgetService::class.java).apply {
      putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
      putExtra(EXTRA_KIND, WidgetKind.TASKS.name)
      data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
    }
    views.setRemoteAdapter(R.id.mindwtr_widget_list, adapterIntent)
    views.setEmptyView(R.id.mindwtr_widget_list, R.id.mindwtr_widget_empty)

    val focusIntent = appIntent(context, payload.focusUri)
    val focus = PendingIntent.getActivity(context, REQUEST_FOCUS, focusIntent, immutableFlags())
    views.setOnClickPendingIntent(R.id.mindwtr_widget_header, focus)
    views.setOnClickPendingIntent(R.id.mindwtr_widget_empty, focus)
    // Collection rows deliver clicks through a fill-in intent, which the
    // platform can only merge into a mutable template. The template fixes the
    // component (the invisible WidgetTapActivity) and leaves the data unset,
    // so a row's fill-in can add exactly one thing: the task's open link or its
    // check-off URI, both validated before anything acts on them.
    val rowTemplate = Intent(context, WidgetTapActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val mutable = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    views.setPendingIntentTemplate(
      R.id.mindwtr_widget_list,
      PendingIntent.getActivity(context, REQUEST_ROW, rowTemplate, mutable),
    )

    // Header = a low-alpha accent wash over the card with a hairline under it
    // (dd: some contrast, not the solid band); the accent itself only on "+".
    palette?.let {
      views.setInt(R.id.mindwtr_widget_surface, "setColorFilter", it.background)
      views.setInt(R.id.mindwtr_widget_band, "setColorFilter", it.headerWash)
      views.setTextColor(R.id.mindwtr_widget_title, it.text)
      views.setTextColor(R.id.mindwtr_widget_subtitle, it.mutedText)
      views.setTextColor(R.id.mindwtr_widget_capture, it.accent)
      views.setInt(R.id.mindwtr_widget_header_divider, "setBackgroundColor", it.border)
      views.setTextColor(R.id.mindwtr_widget_empty, it.mutedText)
    }
  }

  fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha shl 24)

  private fun immutableFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** Explicit VIEW intent to the app's MainActivity, same shape as the tile and notification. */
  fun appIntent(context: Context, uri: String?): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      if (uri != null) data = Uri.parse(uri)
      setClassName(context.packageName, "${context.packageName}.MainActivity")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
