package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.app.Application
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.Spinner
import android.widget.TextView
import android.widget.RemoteViews
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetGroupingTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Test fun tappingTheRenderedBlankSpaceOpensTheSelectedList() {
    val manager = AppWidgetManager.getInstance(context)
    shadowOf(manager).addBoundWidget(47, AppWidgetProviderInfo().apply { provider = ComponentName(context.packageName, "TasksWidgetProvider") })
    WidgetListStore.write(context, 47, "waiting")
    WidgetPayloadStore.write(context, JSONObject().put("listTitles", JSONObject().put("waiting", "Waiting For")).toString())
    WidgetRenderer.render(context, manager, intArrayOf(47), WidgetKind.TASKS)
    val view = shadowOf(manager).getViewFor(47)
    view.findViewById<View>(R.id.mindwtr_widget_spacer).performClick()
    assertEquals("mindwtr:///waiting", shadowOf(context as Application).nextStartedActivity.data.toString())
  }

  @Test fun groupedIdsKeepTheirBaseNavigationCaptureAndDistinctWidgetSelection() {
    val base = "context:@家/desk +?%#"
    val grouped = WidgetListStore.withGrouping(base, "project")
    val payload = payload()
    assertEquals("group:project:context%3A%40%E5%AE%B6%2Fdesk%20%2B%3F%25%23", grouped)
    assertEquals(base, WidgetListStore.baseListId(grouped))
    assertEquals(grouped, payload.resolvedListId(grouped))
    assertEquals(payload.openUriFor(base), payload.openUriFor(grouped))
    assertEquals(WidgetListStore.captureText(base), WidgetListStore.captureText(grouped))
    assertEquals("focus", payload.resolvedListId("group:project:focus"))
    assertEquals("focus", payload.resolvedListId("group:context:group%3Acontext%3Anext"))
    assertEquals("focus", payload.resolvedListId("group:unknown:next"))
    assertEquals("focus", payload.resolvedListId("group:context:%GG"))
    WidgetListStore.write(context, 42, grouped)
    WidgetListStore.write(context, 43, "next")
    assertEquals(grouped, WidgetListStore.read(context, 42))
    assertEquals("next", WidgetListStore.read(context, 43))
  }

  @Test fun fullConfigurationStoresGroupingAndDropdownPreservesItForTheNextList() {
    val manager = AppWidgetManager.getInstance(context)
    shadowOf(manager).addBoundWidget(42, AppWidgetProviderInfo().apply { provider = ComponentName(context.packageName, "TasksWidgetProvider") })
    WidgetPayloadStore.write(context, JSONObject().put("listTitles", JSONObject().put("next", "Next Actions")).toString())
    WidgetListStore.write(context, 42, "next")
    fun activity(dropdown: Boolean): WidgetConfigureActivity {
      val intent = Intent(context, WidgetConfigureActivity::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 42)
        .putExtra(WidgetConfigureActivity.EXTRA_DROPDOWN, dropdown)
      val controller = Robolectric.buildActivity(WidgetConfigureActivity::class.java, intent)
      controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
      return controller.create().get()
    }
    val full = activity(false)
    assertEquals(View.VISIBLE, full.findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility)
    full.findViewById<Spinner>(R.id.mindwtr_widget_configure_grouping).setSelection(3)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    full.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertEquals("group:project:next", WidgetListStore.read(context, 42))

    val dropdown = activity(true)
    assertEquals(View.GONE, dropdown.findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility)
    val list = dropdown.findViewById<ListView>(R.id.mindwtr_widget_configure_lists)
    val adapter = list.adapter as WidgetConfigureActivity.ChooserAdapter
    val waiting = (0 until adapter.count).single { adapter.getItem(it).first == "waiting" }
    adapter.pick(waiting)
    assertEquals("group:project:waiting", WidgetListStore.read(context, 42))
  }

  @Test fun priorityOptionIsAbsentWhenPrioritiesAreDisabledAndFocusKeepsItsHierarchy() {
    val manager = AppWidgetManager.getInstance(context)
    shadowOf(manager).addBoundWidget(44, AppWidgetProviderInfo().apply { provider = ComponentName(context.packageName, "TasksWidgetProvider") })
    WidgetPayloadStore.write(context, JSONObject().put("prioritiesEnabled", false).toString())
    WidgetListStore.write(context, 44, "focus")
    val controller = Robolectric.buildActivity(WidgetConfigureActivity::class.java,
      Intent(context, WidgetConfigureActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 44))
    controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    val activity = controller.create().get()
    assertEquals(4, activity.findViewById<Spinner>(R.id.mindwtr_widget_configure_grouping).count)
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility)
    controller.pause().stop().destroy()
    WidgetListStore.write(context, 44, "group:priority:next")
    val reopened = Robolectric.buildActivity(WidgetConfigureActivity::class.java,
      Intent(context, WidgetConfigureActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 44))
    reopened.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    val retained = reopened.create().get()
    shadowOf(android.os.Looper.getMainLooper()).idle()
    retained.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertEquals("group:priority:next", WidgetListStore.read(context, 44))
  }

  @Test fun renderedMetadataShowsRequestedStatusAndKeepsDedicatedListsUnchanged() {
    fun metadata(showStatus: Boolean): String {
      val item = JSONObject().put("id", "task").put("title", "Task").put("statusLabel", "Waiting For")
        .put("showStatus", showStatus).put("contextLabel", "Project")
      val payload = payload(JSONObject().put("next", JSONObject().put("title", "Next Actions").put("items", JSONArray().put(item))))
      WidgetListStore.write(context, 45, "next")
      val factory = TasksWidgetFactory(context, WidgetKind.TASKS, 45, payload)
      return factory.getViewAt(0).apply(context, FrameLayout(context))
        .findViewById<TextView>(R.id.mindwtr_widget_item_context).text.toString()
    }
    assertEquals("Waiting For · Project", metadata(true))
    assertEquals("Project", metadata(false))
  }

  @Test fun duplicateContextAppearancesKeepUniqueTotalsAndOverflow() {
    fun task(id: String) = JSONObject().put("id", id).put("title", id)
    fun section(title: String, vararg ids: String) = JSONObject().put("key", "context:$title").put("title", title).put("detail", "3")
      .put("items", JSONArray().apply { ids.forEach { put(task(it)) } })
    val grouped = "group:context:next"
    val payload = payload(JSONObject().put(grouped, JSONObject().put("title", "Next Actions").put("totalCount", 3)
      .put("sections", JSONArray().put(section("@a", "one", "two")).put(section("@b", "one", "two")))))
    val focusPayload = this.payload(JSONObject().put("focus", JSONObject().put("title", "Focus")
      .put("sections", JSONArray().put(section("Today", "one", "two").put("key", "schedule").put("detail", "2030")))))
    WidgetListStore.write(context, 46, grouped)
    val factory = TasksWidgetFactory(context, WidgetKind.TASKS, 46, payload)
    val header = factory.getViewAt(0)
    RemoteViews::class.java.getDeclaredMethod("addFlags", Int::class.javaPrimitiveType)
      .apply { isAccessible = true }.invoke(header, 2)
    val view = header.apply(context, null)
    val response = view.getTag(context.resources.getIdentifier("fillInIntent", "id", "android"))
    val destination = response.javaClass.getDeclaredField("mFillIntent").apply { isAccessible = true }.get(response) as Intent
    assertEquals("mindwtr:///widget-list/next", destination.dataString)
    assertEquals(3, factory.eligibleTaskCount())
    assertTrue(factory.rowsForTaskLimit(factory.publishedTaskCount()).last() is TasksWidgetFactory.Row.Footer)
    assertEquals(2, payload.displaySnapshot(setOf("one")).payload.listFor(grouped).eligibleTaskCount())
    assertEquals(listOf("2", "2"), payload.displaySnapshot(setOf("one")).payload.listFor(grouped).sections.map { it.detail })
    assertEquals(listOf("3", "3"), payload.displaySnapshot(emptySet()).payload.listFor(grouped).sections.map { it.detail })
    assertEquals("2030", focusPayload.displaySnapshot(setOf("one")).payload.listFor("focus").sections.single().detail)
    assertEquals("3", (factory.baseRows().first() as TasksWidgetFactory.Row.Header).detail)
  }

  private fun payload(lists: JSONObject = JSONObject()): WidgetPayload =
    WidgetPayload.parse(JSONObject().put("lists", lists).toString())!!
}
