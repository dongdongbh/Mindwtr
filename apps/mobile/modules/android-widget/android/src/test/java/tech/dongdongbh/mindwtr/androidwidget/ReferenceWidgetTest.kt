package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView
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
class ReferenceWidgetTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Test fun parserDefaultsLegacyRowsToCompletableAndPreservesReferenceCapabilityInSections() {
    assertTrue(payload().itemFor("item")!!.canComplete)
    assertTrue(payload(true).itemFor("item")!!.canComplete)
    val reference = payload(false)
    assertFalse(reference.itemFor("item")!!.canComplete)
    val section = JSONObject().put("title", "References").put("items", JSONArray().put(item(false)))
    val grouped = WidgetPayload.parse(JSONObject().put("sections", JSONArray().put(section)).toString())!!
    assertFalse(grouped.sections.single().items.single().canComplete)
  }

  @Test fun referenceRowsHideCompletionWhileRetainingTheirPeekDestination() {
    val reference = payload(false)
    val factory = TasksWidgetFactory(context, WidgetKind.TASKS, 71, reference)
    val remote = factory.getViewAt(0)
    RemoteViews::class.java.getDeclaredMethod("addFlags", Int::class.javaPrimitiveType)
      .apply { isAccessible = true }.invoke(remote, 2)
    val view = remote.apply(context, FrameLayout(context))
    assertEquals(View.GONE, view.findViewById<View>(R.id.mindwtr_widget_item_ring_target).visibility)
    val response = view.getTag(context.resources.getIdentifier("fillInIntent", "id", "android"))
    val destination = response.javaClass.getDeclaredField("mFillIntent").apply { isAccessible = true }.get(response) as Intent
    assertEquals(WidgetTapActivity.peekUri("item"), destination.dataString)

    val legacy = TasksWidgetFactory(context, WidgetKind.TASKS, 71, payload()).getViewAt(0).apply(context, FrameLayout(context))
    assertEquals(View.VISIBLE, legacy.findViewById<View>(R.id.mindwtr_widget_item_ring_target).visibility)
  }

  @Test fun referenceTitlesStayUnstruckInBothWidgetSizes() {
    CheckoffStore.toggle(context, "item")
    for (kind in listOf(WidgetKind.TASKS, WidgetKind.COMPACT)) {
      val view = TasksWidgetFactory(context, kind, 71, payload(false)).getViewAt(0).apply(context, FrameLayout(context))
      val title = view.findViewById<TextView>(R.id.mindwtr_widget_item_title).text
      assertTrue(title !is Spanned || title.getSpans(0, title.length, StrikethroughSpan::class.java).isEmpty())
    }
  }

  @Test fun staleCheckoffIntentsDoNotQueueReferenceCompletionButLegacyRowsStillComplete() {
    WidgetPayloadStore.write(context, json(false))
    fun tap() = Robolectric.buildActivity(WidgetTapActivity::class.java,
      Intent(context, WidgetTapActivity::class.java).setData(Uri.parse(WidgetTapActivity.checkoffUri("item"))))
      .create().get()
    tap()
    assertFalse(CheckoffStore.isPending(context, "item"))
    assertTrue(CheckoffStore.committed(context).isEmpty())
    WidgetPayloadStore.write(context, json())
    tap()
    assertTrue(CheckoffStore.isPending(context, "item"))
  }

  @Test fun referencePeekHidesCompleteAndStillOpensItsTask() {
    WidgetPayloadStore.write(context, json(false))
    val activity = peek()
    val complete = activity.findViewById<Button>(R.id.mindwtr_task_peek_complete)
    assertEquals(View.GONE, complete.visibility)
    complete.performClick()
    assertFalse(CheckoffStore.isPending(context, "item"))
    activity.findViewById<Button>(R.id.mindwtr_task_peek_open).performClick()
    assertEquals("mindwtr:///task/item", shadowOf(activity).nextStartedActivity.dataString)
  }

  @Test fun alreadyOpenPeekCannotCompleteAnItemRepublishedAsReference() {
    WidgetPayloadStore.write(context, json())
    val activity = peek()
    val complete = activity.findViewById<Button>(R.id.mindwtr_task_peek_complete)
    assertEquals(View.VISIBLE, complete.visibility)
    WidgetPayloadStore.write(context, json(false))
    complete.performClick()
    assertFalse(CheckoffStore.isPending(context, "item"))
  }

  private fun peek(): TaskPeekActivity {
    val controller = Robolectric.buildActivity(TaskPeekActivity::class.java,
      Intent(context, TaskPeekActivity::class.java).putExtra(TaskPeekActivity.EXTRA_TASK_ID, "item"))
    controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    return controller.create().get()
  }

  private fun item(canComplete: Boolean? = null): JSONObject = JSONObject()
    .put("id", "item").put("title", "Reference").put("openUri", "mindwtr:///task/item")
    .apply { if (canComplete != null) put("canComplete", canComplete) }

  private fun json(canComplete: Boolean? = null): String = JSONObject()
    .put("items", JSONArray().put(item(canComplete))).toString()

  private fun payload(canComplete: Boolean? = null): WidgetPayload = WidgetPayload.parse(json(canComplete))!!
}
