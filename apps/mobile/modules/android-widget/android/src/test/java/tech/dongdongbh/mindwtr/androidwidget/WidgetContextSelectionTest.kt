package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Intent
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.view.View
import android.widget.ListView
import androidx.test.core.app.ApplicationProvider
import android.content.Context
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
class WidgetContextSelectionTest {
  private fun root(): JSONObject {
    val focus = JSONObject().put("title", "Focus").put("items", JSONArray().put(
      JSONObject().put("id", "focus-task").put("title", "Focus task")))
    return JSONObject().put("headerTitle", "Focus").put("lists", JSONObject().put("focus", focus))
      .put("contexts", JSONArray().put(JSONObject().put("id", "context:@家/desk +?%#").put("name", "@家/desk +?%#")))
      .put("tags", JSONArray().put(JSONObject().put("id", "tag:#urgent").put("name", "#urgent")))
  }

  @Test fun tokenOptionsAreOptionalValidatedAndGroupedWithoutChangingLegacyPayloads() {
    val payload = WidgetPayload.parse(root().toString())!!
    assertEquals("context:@家/desk +?%#", payload.contexts.single().id)
    assertEquals("tag:#urgent", payload.tags.single().id)
    assertEquals(listOf("Contexts", "Tags"), WidgetConfigureActivity.chooserGroups(payload).takeLast(2).map { it.first })
    val old = WidgetPayload.parse(root().apply { remove("contexts"); remove("tags") }.toString())!!
    assertTrue(old.contexts.isEmpty())
    assertTrue(old.tags.isEmpty())
    val unsafe = root().put("contexts", JSONArray().put(JSONObject().put("id", "context:").put("name", "Empty"))
      .put(JSONObject().put("id", "tag:#wrong-group").put("name", "Wrong")))
    assertTrue(WidgetPayload.parse(unsafe.toString())!!.contexts.isEmpty())
  }

  @Test fun emptyRemovedSelectionNeverFallsBackToFocusAndLinksEncodeReservedCharacters() {
    val payload = WidgetPayload.parse(root().toString())!!
    val id = "context:@家/desk +?%#"
    assertEquals("@家/desk +?%#", payload.listFor(id).title)
    assertTrue(payload.listFor(id).items.isEmpty())
    assertEquals("mindwtr:///widget-list/context%3A%40%E5%AE%B6%2Fdesk%20%2B%3F%25%23", payload.openUriFor(id))
    assertEquals("@removed", payload.listFor("context:@removed").title)
    assertTrue(payload.listFor("context:@removed").items.isEmpty())
    assertEquals("mindwtr:///widget-list/tag%3A%23removed", payload.openUriFor("tag:#removed"))
    assertEquals("focus", payload.resolvedListId("context:"))
    assertEquals("focus", payload.resolvedListId("tag:bad\u0000value"))
    val first = WidgetRenderer.tasksHeaderActions(payload, id, 42).openList
    val second = WidgetRenderer.tasksHeaderActions(payload, "tag:#urgent", 43).openList
    assertNotEquals(first.requestCode, second.requestCode)
    assertNotEquals(first.uri, second.uri)
  }

  @Test fun searchKeepsPendingSelectionWhenHiddenAndSavesOnlyThatWidgetsChoice() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val manager = AppWidgetManager.getInstance(context)
    shadowOf(manager).addBoundWidget(42, AppWidgetProviderInfo().apply { provider = ComponentName(context.packageName, "TasksWidgetProvider") })
    val json = root()
    // Force the established chooser's search affordance visible.
    for (i in 1..8) json.getJSONArray("contexts").put(JSONObject().put("id", "context:@other$i").put("name", "@other$i"))
    WidgetPayloadStore.write(context, json.toString())
    WidgetListStore.write(context, 42, "focus")
    WidgetListStore.write(context, 43, "tag:#urgent")
    val intent = Intent(context, WidgetConfigureActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 42)
    val controller = Robolectric.buildActivity(WidgetConfigureActivity::class.java, intent)
    controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    val activity = controller.create().get()
    val list = activity.findViewById<ListView>(R.id.mindwtr_widget_configure_lists)
    val adapter = list.adapter as WidgetConfigureActivity.ChooserAdapter
    // A landscape/IME-sized viewport: the list yields height before the Save row.
    val root = activity.findViewById<View>(R.id.mindwtr_widget_configure_root)
    val density = context.resources.displayMetrics.density
    val width = (400 * density).toInt()
    val height = (240 * density).toInt()
    root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.AT_MOST))
    root.layout(0, 0, root.measuredWidth, root.measuredHeight)
    val buttons = activity.findViewById<View>(R.id.mindwtr_widget_configure_buttons)
    val save = activity.findViewById<Button>(R.id.mindwtr_widget_configure_ok)
    assertTrue(root.measuredHeight <= height)
    assertTrue(list.measuredHeight > 0)
    assertTrue(buttons.bottom <= root.height)
    assertTrue(buttons.top + save.bottom <= root.height)
    val chosen = (0 until adapter.count).single { adapter.getItem(it).first == "context:@家/desk +?%#" }
    list.performItemClick(adapter.getView(chosen, null, list), chosen, adapter.getItemId(chosen))
    val search = activity.findViewById<EditText>(R.id.mindwtr_widget_configure_search)
    search.setText("urgent")
    search.setText("other")
    search.setText("")
    val restored = (0 until adapter.count).single { adapter.getItem(it).first == "context:@家/desk +?%#" }
    assertTrue((adapter.getView(restored, null, list) as RadioButton).isChecked)
    search.setText("urgent")
    activity.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertEquals("context:@家/desk +?%#", WidgetListStore.read(context, 42))
    assertEquals("tag:#urgent", WidgetListStore.read(context, 43))
  }
  @Test fun largeTokenInventoryInflatesOnlyVisibleRowsAndRecyclesCheckedState() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    var chosen = "context:@14999"
    val list = ListView(context)
    val adapter = WidgetConfigureActivity.ChooserAdapter(context,
      listOf("Contexts" to (0 until 15000).map { "context:@$it" to "@$it" }),
      0, 0, 44, { chosen }, { chosen = it })
    list.adapter = adapter
    list.measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY))
    list.layout(0, 0, 600, 800)
    assertEquals(15001, adapter.count)
    assertTrue(list.childCount in 1..30)
    adapter.search("14999")
    assertEquals(2, adapter.count)
    val selected = adapter.getView(1, null, list) as RadioButton
    assertTrue(selected.isChecked)
    adapter.search("14998")
    val reused = adapter.getView(1, selected, list) as RadioButton
    assertSame(selected, reused)
    assertFalse(reused.isChecked)
    reused.performClick()
    assertEquals("context:@14998", chosen)
    assertTrue((adapter.getView(1, reused, list) as RadioButton).isChecked)
  }

}
