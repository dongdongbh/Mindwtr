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
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 60))
    WidgetListStore.writeBackground(context, 60, WidgetBackground.DARK_TEXT)
    WidgetListStore.write(context, 60, "next")
    assertEquals(WidgetBackground.DARK_TEXT, WidgetListStore.background(context, 60))
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 61))

    WidgetListStore.writeBackground(context, 61, WidgetBackground.LIGHT_TEXT)
    assertEquals(WidgetBackground.LIGHT_TEXT, WidgetListStore.background(context, 61))
    WidgetListStore.writeBackground(context, 61, WidgetBackground.DEFAULT)
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 61))
    assertFalse(context.getSharedPreferences(WidgetListStore.BACKGROUNDS_PREFS_NAME, Context.MODE_PRIVATE).contains("61"))

    CompactWidgetProvider().onDeleted(context, intArrayOf(60))
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 60))
    assertEquals(WidgetListStore.DEFAULT_LIST, WidgetListStore.read(context, 60))
  }

  @Test fun aWidgetSavedAsTransparentByTheFirstReleaseReadsAsLightText() {
    val prefs = context.getSharedPreferences(WidgetListStore.BACKGROUNDS_PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit().putBoolean("69", true).putString("70", "sepia").commit()
    assertEquals(WidgetBackground.LIGHT_TEXT, WidgetListStore.background(context, 69))
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 70))
  }

  @Test fun transparentWidgetsUseTheirOwnTextColorsWhateverTheAppTheme() {
    // An explicit dark app theme: light text would be its own, dark text must still win.
    WidgetPayloadStore.write(context, JSONObject().put("themeMode", "dark").put("palette", JSONObject()
      .put("background", "#000000").put("card", "#000000").put("border", "#222222").put("text", "#EEEEEE")
      .put("mutedText", "#AAAAAA").put("accent", "#FF0000").put("onAccent", "#FFFFFF").put("warning", "#FFAA00"))
      .put("lists", JSONObject().put("focus", JSONObject().put("title", "Focus").put("items", org.json.JSONArray()
        .put(JSONObject().put("id", "t1").put("title", "Row").put("dueLabel", "Fri").put("dueTone", "normal")))))
      .toString())
    for ((id, background, palette) in listOf(
      Triple(71, WidgetBackground.LIGHT_TEXT, WidgetPayload.DARK_THEME_PALETTE),
      Triple(72, WidgetBackground.DARK_TEXT, WidgetPayload.LIGHT_THEME_PALETTE),
    )) {
      bind(id, TasksWidgetProvider::class.java.name)
      WidgetListStore.writeBackground(context, id, background)
      WidgetRenderer.render(context, manager, intArrayOf(id), WidgetKind.TASKS)
      val widget = shadowOf(manager).getViewFor(id)
      assertEquals(View.GONE, widget.findViewById<View>(R.id.mindwtr_widget_surface).visibility)
      assertEquals(palette.text, widget.findViewById<TextView>(R.id.mindwtr_widget_title).currentTextColor)
      val row = TasksWidgetFactory(context, WidgetKind.TASKS, id).apply { onCreate() }.getViewAt(0).apply(context, null)
      assertEquals(palette.text, row.findViewById<TextView>(R.id.mindwtr_widget_item_title).currentTextColor)
      assertEquals(palette.mutedText, row.findViewById<TextView>(R.id.mindwtr_widget_item_due).currentTextColor)
    }
  }

  @Test fun aSystemThemeRowTakesItsGreyFromTheThemeWhenTheLauncherDrawsIt() {
    WidgetPayloadStore.write(context, JSONObject().put("themeMode", "system")
      .put("lists", JSONObject().put("focus", JSONObject().put("title", "Focus").put("items", org.json.JSONArray()
        .put(JSONObject().put("id", "t1").put("title", "Row").put("dueLabel", "Fri").put("dueTone", "normal")))))
      .toString())
    bind(73, TasksWidgetProvider::class.java.name)
    val row = TasksWidgetFactory(context, WidgetKind.TASKS, 73).apply { onCreate() }.getViewAt(0)
    assertEquals(0xFF475569.toInt(), row.apply(context, null).findViewById<TextView>(R.id.mindwtr_widget_item_due).currentTextColor)
    // The same cached row, drawn after a switch to night mode.
    org.robolectric.RuntimeEnvironment.setQualifiers("+night")
    val night = row.apply(context.createConfigurationContext(context.resources.configuration), null)
    assertEquals(0xFFCBD5E1.toInt(), night.findViewById<TextView>(R.id.mindwtr_widget_item_due).currentTextColor)
  }

  @Test fun transparentDropsOnlyThePanelAndHeaderSurfaces() {
    WidgetPayloadStore.write(context, JSONObject().put("listTitles", JSONObject().put("next", "Next Actions")).toString())
    fun rendered(id: Int, kind: WidgetKind, transparent: Boolean): View {
      bind(id, if (kind == WidgetKind.TASKS) TasksWidgetProvider::class.java.name else CompactWidgetProvider::class.java.name)
      WidgetListStore.writeBackground(context, id, if (transparent) WidgetBackground.LIGHT_TEXT else WidgetBackground.DEFAULT)
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
      .put("background", "Fond").put("groupDefault", "Défaut").put("backgroundLightText", "Sans fond, texte clair").put("backgroundDarkText", "Sans fond, texte foncé")).toString())
    val activity = configure(66)
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_widget_configure_lists).visibility)
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility)
    assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.mindwtr_widget_configure_background_row).visibility)
    assertEquals("Fond", activity.findViewById<TextView>(R.id.mindwtr_widget_configure_background_label).text.toString())
    val spinner = activity.findViewById<Spinner>(R.id.mindwtr_widget_configure_background)
    assertEquals(listOf("Défaut", "Sans fond, texte clair", "Sans fond, texte foncé"), (0 until spinner.count).map { spinner.getItemAtPosition(it) })
    spinner.setSelection(2)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    activity.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertEquals(WidgetBackground.DARK_TEXT, WidgetListStore.background(context, 66))
    assertFalse(context.getSharedPreferences(WidgetListStore.PREFS_NAME, Context.MODE_PRIVATE).contains("66"))
    assertEquals(View.GONE, shadowOf(manager).getViewFor(66).findViewById<View>(R.id.mindwtr_widget_surface).visibility)
  }

  @Test fun tasksSettingsReopenOnTheSavedChoiceAndTheHeaderDropdownLeavesItOut() {
    bind(67, TasksWidgetProvider::class.java.name)
    WidgetListStore.writeBackground(context, 67, WidgetBackground.LIGHT_TEXT)
    val full = configure(67)
    assertEquals(View.VISIBLE, full.findViewById<View>(R.id.mindwtr_widget_configure_lists).visibility)
    assertEquals(1, full.findViewById<Spinner>(R.id.mindwtr_widget_configure_background).selectedItemPosition)
    full.findViewById<Spinner>(R.id.mindwtr_widget_configure_background).setSelection(0)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    full.findViewById<Button>(R.id.mindwtr_widget_configure_ok).performClick()
    assertEquals(WidgetBackground.DEFAULT, WidgetListStore.background(context, 67))

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
