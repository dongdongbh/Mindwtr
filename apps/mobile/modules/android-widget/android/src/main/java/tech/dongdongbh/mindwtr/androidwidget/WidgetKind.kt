package tech.dongdongbh.mindwtr.androidwidget

/**
 * One entry per home-screen widget kind. Adding a kind = one enum row here,
 * one `MindwtrWidgetProvider` subclass, one layout, and one row in the kinds
 * table of `plugins/android-widget.js` (which registers the receiver and
 * writes its appwidget-provider XML). See README.md for the planned `Focus`
 * kind (#1173).
 */
enum class WidgetKind(val layoutRes: Int, val providerClass: Class<out MindwtrWidgetProvider>) {
  TASKS(R.layout.mindwtr_widget, TasksWidgetProvider::class.java),
  QUICK_CAPTURE(R.layout.mindwtr_quick_capture_widget, QuickCaptureWidgetProvider::class.java);

  companion object {
    fun fromName(name: String?): WidgetKind = entries.firstOrNull { it.name == name } ?: TASKS
  }
}

/** Every kind's receiver: the platform needs one class per kind; rendering is shared. */
abstract class MindwtrWidgetProvider(private val kind: WidgetKind) : android.appwidget.AppWidgetProvider() {
  override fun onUpdate(
    context: android.content.Context,
    appWidgetManager: android.appwidget.AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    WidgetRenderer.render(context, appWidgetManager, appWidgetIds, kind)
  }
}

class TasksWidgetProvider : MindwtrWidgetProvider(WidgetKind.TASKS)

class QuickCaptureWidgetProvider : MindwtrWidgetProvider(WidgetKind.QUICK_CAPTURE)
