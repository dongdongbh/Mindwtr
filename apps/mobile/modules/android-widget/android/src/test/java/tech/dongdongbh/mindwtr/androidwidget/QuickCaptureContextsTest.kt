package tech.dongdongbh.mindwtr.androidwidget

import android.app.Application
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The widget capture dialog's Contexts button (#1418 follow-up). Each inserted form is pinned to
// parse back through core parseQuickAdd in widget-capture-token.test.ts.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class QuickCaptureContextsTest {
  private val context = ApplicationProvider.getApplicationContext<Application>()
  private val queue get() = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @Before @After fun reset() {
    QuickCaptureAudioSessionStore.clearForTests()
    context.getSharedPreferences(WidgetPayloadStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    queue.deleteRecursively()
  }

  private fun publish(vararg names: String) {
    val contexts = JSONArray()
    names.forEach { contexts.put(JSONObject().put("id", "context:$it").put("name", it)) }
    WidgetPayloadStore.write(context, JSONObject().put("headerTitle", "Focus").put("contexts", contexts)
      .put("listTitles", JSONObject().put("contexts", "Kontexte").put("search", "Suchen")).toString())
  }

  private fun open() = Robolectric.buildActivity(QuickCaptureActivity::class.java, Intent(context, QuickCaptureActivity::class.java)).also {
    it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
  }.setup().get()

  private fun QuickCaptureActivity.button() = findViewById<Button>(R.id.mindwtr_quick_capture_contexts)
  private fun QuickCaptureActivity.input() = findViewById<EditText>(R.id.mindwtr_quick_capture_input)
  private fun QuickCaptureActivity.filter() = findViewById<EditText>(R.id.mindwtr_quick_capture_context_filter)
  private fun QuickCaptureActivity.rows(): List<TextView> = findViewById<LinearLayout>(R.id.mindwtr_quick_capture_context_matches)
    .let { list -> (0 until list.childCount).map { list.getChildAt(it) as TextView } }

  @Test fun buttonIsHiddenWithoutAContextItCanInsert() {
    assertEquals(View.GONE, open().button().visibility)
    QuickCaptureAudioSessionStore.clearForTests()
    publish("@a\\b")
    assertEquals(View.GONE, open().button().visibility)
  }

  @Test fun filterNarrowsAndPickInsertsAtTheCaretThenSaveQueuesIt() {
    publish("@garage", "@home", "@person", "@person/gary")
    val activity = open()
    assertEquals(View.VISIBLE, activity.button().visibility)
    assertEquals("Kontexte", activity.button().text.toString())
    activity.input().setText("Call back")
    activity.input().setSelection(4)
    activity.button().performClick()
    assertEquals("Suchen", activity.filter().hint.toString())
    assertTrue(activity.filter().hasFocus())
    assertEquals(listOf("@garage", "@home", "@person", "@person/gary"), activity.rows().map { it.text.toString() })
    activity.filter().setText("GA")
    assertEquals(listOf("@garage", "@person/gary"), activity.rows().map { it.text.toString() })
    activity.filter().setText("@gary")
    activity.rows().single().performClick()
    assertEquals("Call @person/gary back", activity.input().text.toString())
    assertEquals("Call @person/gary ".length, activity.input().selectionStart)
    assertTrue(activity.input().hasFocus())
    assertEquals(View.GONE, activity.findViewById<View>(R.id.mindwtr_quick_capture_context_panel).visibility)
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    val json = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())
    assertEquals("Call @person/gary back", json.getString("title"))
  }

  @Test fun contextAlreadyInTheTextIsNotOfferedAgain() {
    publish("@garage", "@home", "@Two words")
    val activity = open()
    activity.input().setText("@GARAGE fix @\"Two words\" door")
    activity.button().performClick()
    assertEquals(listOf("@home"), activity.rows().map { it.text.toString() })
  }

  @Test fun spacedNameIsInsertedQuotedAndDonePicksTheTopMatch() {
    publish("@Two words", "@home")
    val activity = open()
    activity.button().performClick()
    activity.filter().setText("two")
    activity.filter().onEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_DONE)
    assertEquals("@\"Two words\" ", activity.input().text.toString())
    assertEquals(activity.input().text.length, activity.input().selectionStart)
  }

  // Same cases as core task-token-usage.test.ts getTaskContextMatches; keep the two in step.
  @Test fun rankingMirrorsCoreGetTaskContextMatches() {
    fun matches(names: List<String>, query: String) =
      QuickCaptureActivity.contextChoices(names.map { WidgetPayload.SavedFilterOption("context:$it", it) }, "", query).map { it.first }
    val core = listOf("@computer", "@office", "@offsite")
    assertEquals(listOf("@office", "@offsite"), matches(core, "off"))
    assertEquals(listOf("@off", "@office", "@coffee"), matches(listOf("@coffee", "@office", "@off"), "@off"))
    assertEquals(emptyList<String>(), matches(core, "offer"))
    assertEquals(listOf("@Seasonal Planning"), matches(listOf("@Seasonal Planning", "@office"), "seas"))
    // Prefix beats substring, as in the app (#1418): "gar" puts @garage before @agarwal.
    assertEquals(listOf("@garage", "@agarwal"), matches(listOf("@agarwal", "@garage"), "gar"))
    // Unlike core (which hides history on an empty query), the button lists every context in core's order.
    assertEquals(core, matches(core, ""))
    assertEquals(8, matches((1..12).map { "@c$it" }, "c").size)
  }

  @Test fun choicesKeepCoreOrderAndSpacingRules() {
    val options = listOf("@zeta", "@alpha", "@x ", "@Büro").map { WidgetPayload.SavedFilterOption("context:$it", it) }
    // Core's order stands: Kotlin only filters, it never re-ranks.
    assertEquals(listOf("@zeta" to "@zeta", "@alpha" to "@alpha", "@Büro" to "@Büro"), QuickCaptureActivity.contextChoices(options, "", ""))
    assertEquals(listOf("@Büro"), QuickCaptureActivity.contextChoices(options, "", "bü").map { it.first })
    assertEquals(listOf("@alpha", "@Büro"), QuickCaptureActivity.contextChoices(options, "see @zeta", "").map { it.first })
    // `@zetas` is a different context, so `@zeta` is still offered.
    assertEquals(3, QuickCaptureActivity.contextChoices(options, "@zetas", "").size)
    assertEquals("@a " to 3, QuickCaptureActivity.insertToken("", 0, 0, "@a"))
    assertEquals("x @a " to 5, QuickCaptureActivity.insertToken("x", 1, 1, "@a"))
    assertEquals("@a x" to 3, QuickCaptureActivity.insertToken(" x", 0, 0, "@a"))
    assertEquals("a @b c" to 5, QuickCaptureActivity.insertToken("a SEL c", 2, 5, "@b"))
  }
}
