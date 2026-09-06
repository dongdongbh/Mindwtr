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
    palette?.let {
      views.setInt(R.id.mindwtr_widget_capture_background, "setColorFilter", it.accent)
      views.setTextColor(R.id.mindwtr_widget_capture_label, it.onAccent)
    }

    when (kind) {
      WidgetKind.TASKS -> bindTasks(context, views, appWidgetId, payload, palette)
      WidgetKind.QUICK_CAPTURE -> {
        views.setTextViewText(R.id.mindwtr_widget_title, payload.quickCapture.title)
        palette?.let { views.setTextColor(R.id.mindwtr_widget_title, it.text) }
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
    views.setTextViewText(R.id.mindwtr_widget_title, payload.headerTitle)
    views.setTextViewText(R.id.mindwtr_widget_subtitle, payload.subtitle)
    views.setTextViewText(R.id.mindwtr_widget_empty, payload.emptyMessage)
    views.setViewVisibility(R.id.mindwtr_widget_empty, if (payload.items.isEmpty()) View.VISIBLE else View.GONE)

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
    // component and action and leaves the data unset, so a row's fill-in can
    // add exactly one thing: its own `mindwtr:` URI (validated in WidgetPayload),
    // which MainActivity's deep-link handler already treats as untrusted.
    val rowTemplate = appIntent(context, null)
    val mutable = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    views.setPendingIntentTemplate(
      R.id.mindwtr_widget_list,
      PendingIntent.getActivity(context, REQUEST_ROW, rowTemplate, mutable),
    )

    palette?.let {
      views.setInt(R.id.mindwtr_widget_root, "setBackgroundColor", it.background)
      views.setTextColor(R.id.mindwtr_widget_title, it.text)
      views.setTextColor(R.id.mindwtr_widget_subtitle, it.mutedText)
      views.setTextColor(R.id.mindwtr_widget_empty, it.mutedText)
    }
  }

  private fun immutableFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** Explicit VIEW intent to the app's MainActivity, same shape as the tile and notification. */
  fun appIntent(context: Context, uri: String?): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      if (uri != null) data = Uri.parse(uri)
      setClassName(context.packageName, "${context.packageName}.MainActivity")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}
