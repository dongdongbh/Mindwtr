package tech.dongdongbh.mindwtr.androidwidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

/** Draws the home-screen widget from the payload in [WidgetPayloadStore]. */
class MindwtrTasksWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    render(context, appWidgetManager, appWidgetIds)
    appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.mindwtr_widget_list)
  }

  companion object {
    private const val REQUEST_FOCUS = 4611
    private const val REQUEST_CAPTURE = 4612
    private const val REQUEST_ROW = 4613

    fun refreshAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context) ?: return
      val ids = manager.getAppWidgetIds(ComponentName(context, MindwtrTasksWidgetProvider::class.java))
      if (ids.isEmpty()) return
      render(context, manager, ids)
      manager.notifyAppWidgetViewDataChanged(ids, R.id.mindwtr_widget_list)
    }

    fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
      val payload = WidgetPayloadStore.read(context)
      for (id in ids) {
        manager.updateAppWidget(id, buildViews(context, id, payload))
      }
    }

    private fun buildViews(context: Context, appWidgetId: Int, payload: WidgetPayload): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.mindwtr_widget)
      views.setTextViewText(R.id.mindwtr_widget_title, payload.headerTitle)
      views.setTextViewText(R.id.mindwtr_widget_subtitle, payload.subtitle)
      views.setTextViewText(R.id.mindwtr_widget_empty, payload.emptyMessage)
      views.setViewVisibility(R.id.mindwtr_widget_empty, if (payload.items.isEmpty()) View.VISIBLE else View.GONE)

      val adapterIntent = Intent(context, TasksWidgetService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
      }
      views.setRemoteAdapter(R.id.mindwtr_widget_list, adapterIntent)
      views.setEmptyView(R.id.mindwtr_widget_list, R.id.mindwtr_widget_empty)

      val immutable = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val focusIntent = focusIntent(context, payload.focusUri)
      views.setOnClickPendingIntent(
        R.id.mindwtr_widget_header,
        PendingIntent.getActivity(context, REQUEST_FOCUS, focusIntent, immutable),
      )
      views.setOnClickPendingIntent(
        R.id.mindwtr_widget_empty,
        PendingIntent.getActivity(context, REQUEST_FOCUS, focusIntent, immutable),
      )
      // Collection rows deliver clicks through a fill-in intent, which the
      // platform can only merge into a mutable template. The component, action
      // and data are fixed here, so a fill-in can add nothing but extras that
      // MainActivity's deep-link handler already treats as untrusted.
      val mutableFlags = PendingIntent.FLAG_UPDATE_CURRENT or
        (if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      views.setPendingIntentTemplate(
        R.id.mindwtr_widget_list,
        PendingIntent.getActivity(context, REQUEST_ROW, focusIntent, mutableFlags),
      )
      val captureIntent = Intent(context, QuickCaptureActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      views.setOnClickPendingIntent(
        R.id.mindwtr_widget_capture,
        PendingIntent.getActivity(context, REQUEST_CAPTURE, captureIntent, immutable),
      )

      payload.palette?.takeUnless { payload.usesSystemColors }?.let { palette ->
        views.setInt(R.id.mindwtr_widget_root, "setBackgroundColor", palette.background)
        views.setTextColor(R.id.mindwtr_widget_title, palette.text)
        views.setTextColor(R.id.mindwtr_widget_subtitle, palette.mutedText)
        views.setTextColor(R.id.mindwtr_widget_empty, palette.mutedText)
        views.setInt(R.id.mindwtr_widget_capture_background, "setColorFilter", palette.accent)
        views.setTextColor(R.id.mindwtr_widget_capture_label, palette.onAccent)
      }
      return views
    }

    /** Explicit VIEW intent to the app's MainActivity, same shape as the tile and notification. */
    fun focusIntent(context: Context, uri: String): Intent =
      Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
        setClassName(context.packageName, "${context.packageName}.MainActivity")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
  }
}
