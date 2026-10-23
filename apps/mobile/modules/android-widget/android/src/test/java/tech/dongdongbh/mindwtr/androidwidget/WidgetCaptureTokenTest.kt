package tech.dongdongbh.mindwtr.androidwidget

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetCaptureTokenTest {
  private val context = ApplicationProvider.getApplicationContext<Application>()
  private val queue get() = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @Before @After fun reset() {
    QuickCaptureAudioSessionStore.clearForTests()
    context.getSharedPreferences(WidgetListStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    queue.deleteRecursively()
  }

  private fun open(intent: Intent) = Robolectric.buildActivity(QuickCaptureActivity::class.java, intent).also {
    it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
  }.setup()

  private fun widgetIntent(id: Int, kind: WidgetKind = WidgetKind.TASKS): Intent =
    shadowOf(WidgetRenderer.capturePendingIntent(context, id, kind)).savedIntent

  // Each emitted form is pinned to round-trip through core parseQuickAdd in widget-capture-token.test.ts.
  @Test fun captureTextKeepsOnlyTokensQuickAddParsesUnaided() {
    for ((listId, expected) in listOf(
      "context:@Todd" to "@Todd ", "tag:#errand-1" to "#errand-1 ", "context:@Büro" to "@Büro ",
      "context:@person/todd" to "@person/todd ", "tag:#area/sub-1" to "#area/sub-1 ",
      "context:@Two words" to "@\"Two words\" ", "tag:#a.b" to "#\"a.b\" ",
      "context:@person/Todd Smith" to "@\"person/Todd Smith\" ", "tag:#Tom's & co." to "#\"Tom's & co.\" ",
      "context:@a/" to "@\"a/\" ",
    )) {
      assertEquals(listId, expected, WidgetListStore.captureText(listId))
    }
    for (none in listOf("focus", "inbox", "next", "upcoming", "filter:f1", "project:p1", "context:@", "tag:#",
      "context:#wrong", "tag:@wrong", "tag:#\"q\"", "context:@a\\b", "context:@\u201Cq\u201D", "context:@ x", "context:@x ",
      "context:@a  b", "context:@a\tb", "tag:#x @y", "context:@see /link:x", "tag:#a +b")) {
      assertEquals(none, "", WidgetListStore.captureText(none))
    }
  }

  @Test fun singleTokenWidgetOpensWithEditableTokenAndKeepsInbox() {
    for ((listId, expected) in listOf("context:@Todd" to "@Todd ", "tag:#errand" to "#errand ",
      "context:@person/todd" to "@person/todd ", "context:@Two words" to "@\"Two words\" ")) {
      QuickCaptureAudioSessionStore.clearForTests()
      WidgetListStore.write(context, 41, listId)
      val activity = open(widgetIntent(41)).get()
      val input = activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input)
      assertEquals(expected, input.text.toString())
      assertEquals(expected.length, input.selectionStart)
      input.append("Call back")
      activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
      val json = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())
      assertEquals("${expected}Call back", json.getString("title"))
      assertEquals("inbox", json.getString("defaultStatus"))
      queue.deleteRecursively()
    }
  }

  @Test fun otherListsAndEntrypointsOpenEmpty() {
    for (listId in listOf("focus", "next", "filter:f1", "tag:#x @y")) {
      QuickCaptureAudioSessionStore.clearForTests()
      WidgetListStore.write(context, 41, listId)
      assertEquals(listId, "", open(widgetIntent(41)).get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    }
    WidgetListStore.write(context, 41, "context:@Todd")
    for (intent in listOf(widgetIntent(41, WidgetKind.QUICK_CAPTURE), Intent(context, QuickCaptureActivity::class.java))) {
      QuickCaptureAudioSessionStore.clearForTests()
      assertEquals("", open(intent).get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    }
  }

  @Test fun deletedTokenStaysDeletedAcrossProcessRecreation() {
    WidgetListStore.write(context, 41, "context:@Todd")
    val launch = widgetIntent(41)
    val host = open(launch)
    host.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("")
    val state = Bundle()
    host.saveInstanceState(state).pause().stop().destroy()
    QuickCaptureAudioSessionStore.clearForTests()
    val restored = Robolectric.buildActivity(QuickCaptureActivity::class.java, launch).also {
      it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
    }.create(state).start().restoreInstanceState(state).resume().visible()
    assertEquals("", restored.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
  }
}
