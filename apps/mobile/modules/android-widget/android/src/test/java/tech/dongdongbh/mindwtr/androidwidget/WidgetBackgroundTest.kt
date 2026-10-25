package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.Spinner
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetBackgroundTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val manager = AppWidgetManager.getInstance(context)

  @Test fun theChoiceDefaultsToTheDefaultBackgroundIsKeptPerWidgetAndClearedOnDelete() {
    assertFalse(WidgetListStore.isTransparent(context, 60))
    WidgetListStore.writeTransparent(context, 60, true)
    WidgetListStore.write(context, 60, "next")
    assertTrue(WidgetListStore.isTransparent(context, 60))
    assertFalse(WidgetListStore.isTransparent(context, 61))

    WidgetListStore.writeTransparent(context, 61, true)
    WidgetListStore.writeTransparent(context, 61, false)
    assertFalse(WidgetListStore.isTransparent(context, 61))
    assertFalse(context.getSharedPreferences(WidgetListStore.BACKGROUNDS_PREFS_NAME, Context.MODE_PRIVATE).contains("61"))

    CompactWidgetProvider().onDeleted(context, intArrayOf(60))
    assertFalse(WidgetListStore.isTransparent(context, 60))
    assertEquals(WidgetListStore.DEFAULT_LIST, WidgetListStore.read(context, 60))
  }

  @Test fun transparentDropsOnlyThePanelAndHeaderSurfaces() {
    WidgetPayloadStore.write(context, JSONObject().put("listTitles", JSONObject().put("next", "Next Actions")).toString())
    fun rendered(id: Int, kind: WidgetKind, transparent: Boolean): View {
      bind(id, if (kind == WidgetKind.TASKS) TasksWidgetProvider::class.java.name else CompactWidgetProvider::class.java.name)
      WidgetListStore.writeTransparent(context, id, transparent)
      WidgetRenderer.render(context, manager, intArrayOf(id), kind)
      return shadowOf(manager).getViewFor(id)
    }
    for (kind in listOf(WidgetKind.TASKS, WidgetKind.COMPACT)) {
      val plain = rendered(if (kind == WidgetKind.TASKS) 62 else 64, kind, transparent = false)
      val clear = rendered(if (kind == WidgetKind.TASKS) 63 else 65, kind, transparent = true)
      for (surface in WidgetRenderer.backgroundSurfaces(kind)) {
        assertEquals(View.VISIBLE, plain.findViewById<View>(surface).visibility)
        assertEquals(View.GONE, clear.findViewById<View>(surface).visibility)
      }
      assertEquals(View.VISIBLE, clear.findViewById<View>(R.id.mindwtr_widget_root).visibility)
      assertEquals(View.VISIBLE, clear.findViewById<View>(R.id.mindwtr_widget_title).visibility)
      assertEquals(View.VISIBLE, clear.findViewById<View>(R.id.mindwtr_widget_capture).visibility)
    }
    assertEquals(listOf(R.id.mindwtr_widget_surface, R.id.mindwtr_widget_band), WidgetRenderer.backgroundSurfaces(WidgetKind.TASKS))
    assertEquals(emptyList<Int>(), WidgetRenderer.backgroundSurfaces(WidgetKind.QUICK_CAPTURE))
  }

  @Test fun compactSettingsShowOnlyTheBackgroundRowAndSaveItWithoutAList() {
    bind(66, CompactWidgetProvider::class.java.name)
    WidgetPayloadStore.write(context, JSONObject().put("listTitles", JSONObject()
      .put("background", "Fond").put("groupDefault", "Défaut").put("backgroundTransparent", "Sans fond")).toString())
    val activity = configure(66)
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_widget_configure_lists).visibility)
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility)
    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.mindwtr_widget_configure_background_row).visibility)
    assertEquals("Fond", activity.findViewById<TextView>(R.id.mindwtr_widget_configure_background_label).text.toString())
    val spinner = activity.findViewById<Spinner>(R.id.mindwtr_widget_configure_background)
    assertEquals(listOf("Défaut", "Sans fond"), (0 until spinner.count).map { spinner.getItemAtPosition(it) })
    spinner.setSelection(1)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    activity.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertTrue(WidgetListStore.isTransparent(context, 66))
    assertFalse(context.getSharedPreferences(WidgetListStore.PREFS_NAME, Context.MODE_PRIVATE).contains("66"))
    assertEquals(View.GONE, shadowOf(manager).getViewFor(66).findViewById<View>(R.id.mindwtr_widget_surface).visibility)
  }

  @Test fun tasksSettingsReopenOnTheSavedChoiceAndTheHeaderDropdownLeavesItOut() {
    bind(67, TasksWidgetProvider::class.java.name)
    WidgetListStore.writeTransparent(context, 67, true)
    val full = configure(67)
    assertEquals(View.VISIBLE, full.findViewById<View>(R.id.mindwtr_widget_configure_lists).visibility)
    assertEquals(1, full.findViewById<Spinner>(R.id.mindwtr_widget_configure_background).selectedItemPosition)
    full.findViewById<Spinner>(R.id.mindwtr_widget_configure_background).setSelection(0)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    full.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertFalse(WidgetListStore.isTransparent(context, 67))

    val dropdown = configure(67, dropdown = true)
    assertEquals(View.GONE, dropdown.findViewById<View>(R.id.mindwtr_widget_configure_background_row).visibility)
  }

  @Test fun quickCaptureWidgetsHaveNoSettings() {
    bind(68, QuickCaptureWidgetProvider::class.java.name)
    assertTrue(configure(68).isFinishing)
  }

  private fun bind(id: Int, className: String) {
    shadowOf(manager).addBoundWidget(id, AppWidgetProviderInfo().apply { provider = ComponentName(context.packageName, className) })
  }

  private fun configure(id: Int, dropdown: Boolean = false): WidgetConfigureActivity {
    val intent = Intent(context, WidgetConfigureActivity::class.java)
      .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
      .putExtra(WidgetConfigureActivity.EXTRA_DROPDOWN, dropdown)
    val controller = Robolectric.buildActivity(WidgetConfigureActivity::class.java, intent)
    controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    return controller.create().get()
  }
}
