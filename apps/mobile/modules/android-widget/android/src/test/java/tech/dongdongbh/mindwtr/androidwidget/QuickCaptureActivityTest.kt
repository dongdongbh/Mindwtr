package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class QuickCaptureActivityTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val queue = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @Before
  @After
  fun reset() {
    QuickCaptureAudioSessionStore.clearForTests()
    queue.deleteRecursively()
  }

  private fun controller() = Robolectric.buildActivity(QuickCaptureActivity::class.java).also {
    it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
  }

  @Test
  fun savesLiteralDescriptionAndKeepsTitleAutofocus() {
    val host = controller().setup()
    val activity = host.get()
    val title = activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input)
    val description = activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description)
    assertTrue(title.hasFocus())
    title.setText("Call Alex")
    description.setText("  @home #literal\nKeep both lines  ")

    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()

    val json = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())
    assertEquals("Call Alex", json.getString("title"))
    assertEquals("  @home #literal\nKeep both lines  ", json.getString("note"))
    assertTrue(activity.isFinishing)
    host.pause().stop().destroy()
  }

  @Test
  fun failedSaveAndProcessRecreationKeepBothFieldsForRetry() {
    val host = controller().setup()
    val activity = host.get()
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Keep title")
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description).setText("  Keep\nnote  ")
    queue.writeText("Block queue directory creation")

    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertFalse(activity.isFinishing)
    assertEquals("Keep title", activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    assertEquals("  Keep\nnote  ", activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description).text.toString())
    val saved = Bundle()
    host.saveInstanceState(saved).pause().stop().destroy()
    QuickCaptureAudioSessionStore.clearForTests()
    assertTrue(queue.delete())
    val restored = controller().create(saved).start().restoreInstanceState(saved).resume().visible()
    val recreated = restored.get()
    assertEquals("Keep title", recreated.findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    assertEquals("  Keep\nnote  ", recreated.findViewById<EditText>(R.id.mindwtr_quick_capture_description).text.toString())

    recreated.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    val json = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())
    assertEquals("Keep title", json.getString("title"))
    assertEquals("  Keep\nnote  ", json.getString("note"))
    restored.pause().stop().destroy()
  }

  @Test
  fun shortWindowKeepsSaveVisibleWhileMultilineFieldsScroll() {
    val host = controller().setup()
    val activity = host.get()
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Title\n".repeat(6))
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description).setText("Description\n".repeat(8))
    val scroll = activity.findViewById<ScrollView>(R.id.mindwtr_quick_capture_scroll)
    val save = activity.findViewById<Button>(R.id.mindwtr_quick_capture_save)
    val root = activity.findViewById<ViewGroup>(R.id.mindwtr_quick_capture_root)
    (root.parent as ViewGroup).removeView(root)
    root.measure(
      View.MeasureSpec.makeMeasureSpec(360, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(220, View.MeasureSpec.AT_MOST),
    )
    root.layout(0, 0, root.measuredWidth, root.measuredHeight)

    assertTrue(root.height in 1..220)
    assertTrue(scroll.height > 0)
    assertTrue(scroll.getChildAt(0).height > scroll.height)
    assertTrue(scroll.canScrollVertically(1))
    fun assertSaveInsideViewport() {
      val bounds = Rect()
      save.getDrawingRect(bounds)
      root.offsetDescendantRectToMyCoords(save, bounds)
      assertTrue(save.height > 0)
      assertEquals(save.height, bounds.height())
      assertTrue(Rect(0, 0, root.width, root.height).contains(bounds))
    }
    assertSaveInsideViewport()
    assertTrue(scroll.fullScroll(View.FOCUS_DOWN))
    assertSaveInsideViewport()
    host.pause().stop().destroy()
  }

  @Test
  fun titleOnlySaveRemainsAvailable() {
    val host = controller().setup()
    val activity = host.get()
    val save = activity.findViewById<Button>(R.id.mindwtr_quick_capture_save)
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description).setText("Needs a title")
    assertFalse(save.isEnabled)
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_description).setText("")
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Title only")
    assertTrue(save.isEnabled)

    save.performClick()

    val json = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())
    assertEquals("Title only", json.getString("title"))
    assertFalse(json.has("note"))
    host.pause().stop().destroy()
  }
}
