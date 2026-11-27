package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.os.Bundle
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.LinearLayout
import androidx.appcompat.app.AlertDialog
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class QuickCaptureDestinationTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val queue get() = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @Before @After fun reset() {
    QuickCaptureAudioSessionStore.clearForTests()
    context.getSharedPreferences(WidgetPayloadStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    queue.deleteRecursively()
  }

  private fun publish(area: String? = "personal") = WidgetPayloadStore.write(context,
    JSONObject().put("captureDestinations", captureDestinationCatalog(area)).toString())

  private fun controller() = Robolectric.buildActivity(QuickCaptureActivity::class.java).also {
    it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
  }

  private fun saved(): JSONObject = JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText())

  @Test fun destinationGrammarAgreesWithSharedCoreCases() {
    val corpus = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
      .map { File(it, "packages/core/src/capture-destination-parser.fixtures.json") }.first { it.isFile }
    val fixture = JSONObject(corpus.readText())
    val catalog = WidgetPayload.parse(JSONObject().put("captureDestinations", JSONObject()
      .put("defaultDestination", fixture.getJSONObject("baseline"))
      .put("areas", fixture.getJSONArray("areas")).put("projects", fixture.getJSONArray("projects"))
      .put("sections", org.json.JSONArray())).toString())!!.captureDestinations!!
    val cases = fixture.getJSONArray("cases")
    for (index in 0 until cases.length()) {
      val entry = cases.getJSONObject(index)
      val result = QuickCaptureDestination.resolve(entry.getString("input"), catalog, catalog.defaultDestination,
        WidgetPayload.CaptureDestination.parse(entry.optJSONObject("selected")))
      assertNotNull(entry.getString("input"), result)
      val expected = entry.getJSONObject("expected")
      assertEquals(entry.getString("input"), WidgetPayload.CaptureDestination.parse(expected.getJSONObject("destination")), result!!.destination)
      assertEquals(entry.getString("input"), expected.opt("projectToCreate") as? String, result.projectToCreate)
    }
    val ambiguous = org.json.JSONArray(File(corpus.parentFile, "capture-destination-ambiguity.fixtures.json").readText())
    for (index in 0 until ambiguous.length()) {
      val title = ambiguous.getJSONObject(index).getString("input")
      assertTrue(title, QuickCaptureDestination.requiresExplicitDestination(title))
      assertNull(title, QuickCaptureDestination.resolve(title, catalog, catalog.defaultDestination, null))
      val explicit = QuickCaptureDestination.resolve(title, catalog, catalog.defaultDestination, WidgetPayload.CaptureDestination("none"))!!
      assertEquals(title, "none", explicit.destination.kind)
      assertNull(title, explicit.projectToCreate)
    }
  }

  @Test fun ambiguousMixedSyntaxKeepsDraftUntilAnExplicitDestinationIsChosen() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    val input = activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input)
    val save = activity.findViewById<Button>(R.id.mindwtr_quick_capture_save)
    input.setText("Task +One @deep work Two")
    assertFalse(save.isEnabled)
    assertEquals(0.5f, save.alpha, 0f)
    assertEquals("Task +One @deep work Two", input.text.toString())
    assertTrue(queue.listFiles().isNullOrEmpty())
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).performClick()
    val dialog = ShadowDialog.getLatestDialog() as AlertDialog
    val choices = dialog.findViewById<ListView>(R.id.mindwtr_capture_destination_choices)!!
    choices.performItemClick(choices.adapter.getView(0, null, choices), 0, 0)
    assertTrue(save.isEnabled)
    assertEquals(1f, save.alpha, 0f)
    save.performClick()
    assertEquals("none", saved().getJSONObject("destination").getString("kind"))
    assertFalse(saved().has("projectToCreate"))
    host.pause().stop().destroy()
  }

  @Test fun shownDefaultSurvivesASettingsRefreshBeforeSave() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Call back")
    assertTrue(activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).text.contains("Personal"))
    publish("work")
    shadowOf(android.os.Looper.getMainLooper()).idle()
    assertTrue(activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).text.contains("Personal"))
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertEquals("personal", saved().getJSONObject("destination").getString("id"))
    assertEquals("inbox", saved().getString("defaultStatus"))
    host.pause().stop().destroy()
  }

  @Test fun explicitNoneSurvivesRecreationAndOverridesInlineProject() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Read +\"週末 planning\"")
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).performClick()
    val dialog = ShadowDialog.getLatestDialog() as AlertDialog
    val list = dialog.findViewById<ListView>(R.id.mindwtr_capture_destination_choices)!!
    list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
    val state = Bundle()
    host.saveInstanceState(state).pause().stop().destroy()
    QuickCaptureAudioSessionStore.clearForTests()
    val restored = controller().create(state).start().restoreInstanceState(state).resume().visible()
    restored.get().findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertEquals("none", saved().getJSONObject("destination").getString("kind"))
    assertFalse(saved().has("projectToCreate"))
    restored.pause().stop().destroy()
  }

  @Test fun missingCatalogKeepsDraftUntilRefreshAndCompositionDoesNotSave() {
    val host = controller().setup()
    val activity = host.get()
    val input = activity.findViewById<QuickCaptureInput>(R.id.mindwtr_quick_capture_input)
    val save = activity.findViewById<Button>(R.id.mindwtr_quick_capture_save)
    input.setText("中文")
    assertFalse(save.isEnabled)
    publish()
    shadowOf(android.os.Looper.getMainLooper()).idle()
    assertTrue(save.isEnabled)
    BaseInputConnection.setComposingSpans(input.text!!)
    input.onEditorAction(EditorInfo.IME_ACTION_DONE)
    assertTrue(queue.listFiles().isNullOrEmpty())
    assertEquals("中文", input.text.toString())
    BaseInputConnection.removeComposingSpans(input.text!!)
    val info = EditorInfo()
    input.onCreateInputConnection(info)
    assertEquals(EditorInfo.IME_ACTION_DONE, info.imeOptions and EditorInfo.IME_MASK_ACTION)
    assertEquals(0, info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION)
    input.onEditorAction(EditorInfo.IME_ACTION_DONE)
    assertEquals("中文", saved().getString("title"))
    host.pause().stop().destroy()
  }

  @Test fun resolutionUsesExistingIdentityAndFreezesNewProjectArea() {
    val catalog = WidgetPayload.parse(JSONObject().put("captureDestinations", captureDestinationCatalog("personal")).toString())!!.captureDestinations!!
    val selected = QuickCaptureDestination.resolve("Read +\"週末 planning\" tonight", catalog, catalog.defaultDestination, null)!!
    assertEquals("p1", selected.destination.id)
    assertNull(selected.projectToCreate)
    val created = QuickCaptureDestination.resolve("Read +\"New plan\"", catalog, catalog.defaultDestination, null)!!
    assertEquals("personal", created.destination.id)
    assertEquals("New plan", created.projectToCreate)
    val queued = PendingCaptureWriter.write(context.filesDir, "Read +\"New plan\"", destination = created)!!
    val json = JSONObject(queued.readText())
    assertEquals("New plan", json.getJSONObject("projectToCreate").getString("title"))
    assertEquals("personal", json.getJSONObject("destination").getString("id"))
  }

  @Test fun destinationSyntaxKeepsQuotedContextsLiteralAndUsesExistingQuotedProjects() {
    val catalog = WidgetPayload.parse(JSONObject().put("captureDestinations", captureDestinationCatalog("personal")).toString())!!.captureDestinations!!
    for (text in listOf("Read +‘週末 planning’", "Read +“週末 planning”", "Read +週末   planning")) {
      val result = QuickCaptureDestination.resolve(text, catalog, catalog.defaultDestination, null)!!
      assertEquals(text, "p1", result.destination.id)
      assertNull(result.projectToCreate)
    }
    for (text in listOf("Read @\"person +road\"", "Read #\"topic !Work\"", "Read \\+literal")) {
      val result = QuickCaptureDestination.resolve(text, catalog, catalog.defaultDestination, null)!!
      assertEquals(text, "personal", result.destination.id)
      assertNull(result.projectToCreate)
    }
    assertEquals("New Project", QuickCaptureDestination.resolve("Task +New Project", catalog, catalog.defaultDestination, null)!!.projectToCreate)
    val note = QuickCaptureDestination.resolve("Task /note: use +New Project", catalog, catalog.defaultDestination, null)!!
    assertEquals("personal", note.destination.id)
    assertNull(note.projectToCreate)
  }

  @Test fun deletedDestinationRefusesSaveWhileKeepingTheDraftEditable() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Keep this draft")
    val catalog = captureDestinationCatalog().put("areas", org.json.JSONArray())
    WidgetPayloadStore.write(context, JSONObject().put("captureDestinations", catalog).toString())
    shadowOf(android.os.Looper.getMainLooper()).idle()
    assertFalse(activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).isEnabled)
    assertTrue(activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).isEnabled)
    assertEquals("Keep this draft", activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    assertTrue(queue.listFiles().isNullOrEmpty())
    assertFalse(activity.isFinishing)
    host.pause().stop().destroy()
  }

  @Test fun typingFindsASavedTagOutsideTheInitialEightWhileTheKeyboardComposes() {
    val tags = org.json.JSONArray((1..9).map { "#tag$it" } + "#watchlist")
    WidgetPayloadStore.write(context, JSONObject().put("captureDestinations",
      captureDestinationCatalog().put("savedTags", tags)).toString())
    val host = controller().setup()
    val activity = host.get()
    val input = activity.findViewById<QuickCaptureInput>(R.id.mindwtr_quick_capture_input)
    input.setText("Watch #wa")
    input.setSelection(input.length())
    BaseInputConnection.setComposingSpans(input.text!!)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    val choices = activity.findViewById<LinearLayout>(R.id.mindwtr_quick_capture_autocomplete)
    assertEquals(1, choices.childCount)
    choices.getChildAt(0).performClick()
    assertEquals("Watch #watchlist", input.text.toString().trimEnd())
    assertTrue(queue.listFiles().isNullOrEmpty())
    host.pause().stop().destroy()
  }

  @Test fun areaAutocompleteSavesTheChosenAreaById() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    val input = activity.findViewById<QuickCaptureInput>(R.id.mindwtr_quick_capture_input)
    input.setText("Plan !wo")
    input.setSelection(input.length())
    shadowOf(android.os.Looper.getMainLooper()).idle()
    val choices = activity.findViewById<LinearLayout>(R.id.mindwtr_quick_capture_autocomplete)
    assertEquals(1, choices.childCount)
    choices.getChildAt(0).performClick()
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertEquals("work", saved().getJSONObject("destination").getString("id"))
    host.pause().stop().destroy()
  }

  @Test fun projectAutocompleteAtTheCaretSelectsAnIdentityWithoutCreatingAnotherProject() {
    publish()
    val host = controller().setup()
    val activity = host.get()
    val input = activity.findViewById<QuickCaptureInput>(R.id.mindwtr_quick_capture_input)
    input.setText("Read +\"週末 pln\" tonight")
    input.setSelection(11)
    shadowOf(android.os.Looper.getMainLooper()).idle()
    val suggestions = activity.findViewById<LinearLayout>(R.id.mindwtr_quick_capture_autocomplete)
    assertEquals(1, suggestions.childCount)
    suggestions.getChildAt(0).performClick()
    assertEquals("Read tonight", input.text.toString())
    assertEquals("Read ".length, input.selectionStart)
    assertTrue(activity.findViewById<Button>(R.id.mindwtr_quick_capture_destination).text.contains("週末 planning"))
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertEquals("p1", saved().getJSONObject("destination").getString("id"))
    assertFalse(saved().has("projectToCreate"))
    host.pause().stop().destroy()
  }
}
