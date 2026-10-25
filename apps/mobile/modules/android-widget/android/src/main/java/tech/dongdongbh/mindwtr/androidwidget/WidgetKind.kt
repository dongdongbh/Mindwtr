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
  COMPACT(R.layout.mindwtr_compact_widget, CompactWidgetProvider::class.java),
  QUICK_CAPTURE(R.layout.mindwtr_quick_capture_widget, QuickCaptureWidgetProvider::class.java);

  val hasTaskList: Boolean get() = this != QUICK_CAPTURE

  companion object {
    fun fromName(name: String?): WidgetKind = entries.firstOrNull { it.name == name } ?: TASKS
  }
}

data class WidgetProviderIdentity(
  val kind: WidgetKind,
  val className: String,
  val isLegacy: Boolean,
)

data class PlacedWidgetProvider(
  val identity: WidgetProviderIdentity,
  val ids: IntArray,
)

/** Provider identities shared by refresh and per-widget list selection. */
object WidgetProviderRegistry {
  fun identities(applicationPackage: String): List<WidgetProviderIdentity> = WidgetKind.entries.flatMap { kind ->
    val current = WidgetProviderIdentity(kind, kind.providerClass.name, isLegacy = false)
    if (kind == WidgetKind.TASKS) {
      listOf(
        current,
        WidgetProviderIdentity(kind, "$applicationPackage.widget.TasksWidget", isLegacy = true),
      )
    } else {
      listOf(current)
    }
  }

  fun placed(
    applicationPackage: String,
    idsForProvider: (String) -> IntArray,
  ): List<PlacedWidgetProvider> = identities(applicationPackage).mapNotNull { identity ->
    val ids = idsForProvider(identity.className)
    if (ids.isEmpty()) null else PlacedWidgetProvider(identity, ids)
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

open class TasksWidgetProvider : MindwtrWidgetProvider(WidgetKind.TASKS) {
  override fun onDeleted(context: android.content.Context, appWidgetIds: IntArray) {
    WidgetListStore.remove(context, appWidgetIds)
  }

  // The check-off fallback alarm lands here when the Handler died with the process.
  override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
    if (intent.action in setOf(android.content.Intent.ACTION_DATE_CHANGED, android.content.Intent.ACTION_TIME_CHANGED, android.content.Intent.ACTION_TIMEZONE_CHANGED)) {
      val manager = android.appwidget.AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(android.content.ComponentName(context, javaClass))
      WidgetRenderer.render(context, manager, ids, WidgetKind.TASKS)
      return
    }
    if (intent.action == CheckoffStore.ACTION_SWEEP) {
      CheckoffStore.sweepAndRefresh(context)
      return
    }
    super.onReceive(context, intent)
  }
}

class QuickCaptureWidgetProvider : MindwtrWidgetProvider(WidgetKind.QUICK_CAPTURE)

class CompactWidgetProvider : MindwtrWidgetProvider(WidgetKind.COMPACT) {
  override fun onDeleted(context: android.content.Context, appWidgetIds: IntArray) {
    WidgetListStore.remove(context, appWidgetIds)
  }
}
