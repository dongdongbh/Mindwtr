package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context

/** Which list each placed Tasks widget shows (#1173): SharedPreferences `mindwtr_widget_lists`, key = widget id. */
object WidgetListStore {
  const val PREFS_NAME = "mindwtr_widget_lists"
  const val DEFAULT_LIST = "focus"
  const val PROJECT_PREFIX = "project:"

  fun read(context: Context, appWidgetId: Int): String =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(appWidgetId.toString(), null) ?: DEFAULT_LIST

  fun write(context: Context, appWidgetId: Int, listId: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(appWidgetId.toString(), listId).commit()
  }

  fun remove(context: Context, appWidgetIds: IntArray) {
    val editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
    for (id in appWidgetIds) editor.remove(id.toString())
    editor.apply()
  }

  /** Distinct list ids bound to the Tasks widgets currently placed. */
  fun selections(context: Context): List<String> {
    val manager = AppWidgetManager.getInstance(context) ?: return emptyList()
    val ids = manager.getAppWidgetIds(ComponentName(context, TasksWidgetProvider::class.java))
    return ids.map { read(context, it) }.distinct()
  }
}
