package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.DataSetObserver
import android.widget.EditText
import android.widget.ListView
import android.widget.RadioButton
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
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetChooserRefreshTest {
  private fun payload(vararg contexts: String) = JSONObject().put("contexts", JSONArray(contexts.map {
    JSONObject().put("id", "context:$it").put("name", it)
  })).toString()

  @Test fun publishedDeletionRefreshesAnOpenChooserWithoutLosingSearchOrPendingSelection() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val manager = AppWidgetManager.getInstance(context)
    shadowOf(manager).addBoundWidget(72, AppWidgetProviderInfo().apply {
      provider = ComponentName(context.packageName, "TasksWidgetProvider")
    })
    WidgetPayloadStore.write(context, payload("@removed", "@kept"))
    WidgetListStore.write(context, 72, "focus")
    val intent = Intent(context, WidgetConfigureActivity::class.java)
      .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 72)
    val controller = Robolectric.buildActivity(WidgetConfigureActivity::class.java, intent)
    controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    val activity = controller.create().get()
    val list = activity.findViewById<ListView>(R.id.mindwtr_widget_configure_lists)
    val adapter = list.adapter as WidgetConfigureActivity.ChooserAdapter
    val kept = (0 until adapter.count).single { adapter.getItem(it).first == "context:@kept" }
    list.performItemClick(adapter.getView(kept, null, list), kept, adapter.getItemId(kept))
    val search = activity.findViewById<EditText>(R.id.mindwtr_widget_configure_search)
    search.setText("kept")
    var changes = 0
    adapter.registerDataSetObserver(object : DataSetObserver() {
      override fun onChanged() { changes++ }
    })

    val fresh = payload("@kept", "@new")
    WidgetPayloadStore.write(context, fresh)
    ShadowLooper.idleMainLooper()
    assertEquals(1, changes)
    assertEquals("kept", search.text.toString())
    assertEquals(listOf("context:@kept"), (0 until adapter.count).mapNotNull { adapter.getItem(it).first })
    assertTrue((adapter.getView(1, null, list) as RadioButton).isChecked)

    WidgetPayloadStore.write(context, fresh)
    ShadowLooper.idleMainLooper()
    assertEquals(1, changes)
    search.setText("")
    assertEquals(listOf("context:@kept", "context:@new"), (0 until adapter.count)
      .mapNotNull { adapter.getItem(it).first }.filter { it.startsWith("context:") })
    val beforeDestroy = changes
    controller.destroy()
    WidgetPayloadStore.write(context, payload("@after-destroy"))
    ShadowLooper.idleMainLooper()
    assertEquals(beforeDestroy, changes)
    assertEquals("focus", WidgetListStore.read(context, 72))
  }
}
