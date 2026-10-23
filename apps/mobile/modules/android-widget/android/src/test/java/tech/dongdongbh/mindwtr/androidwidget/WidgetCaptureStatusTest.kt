package tech.dongdongbh.mindwtr.androidwidget

import android.app.Application
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import androidx.appcompat.app.AlertDialog
import java.io.File
import java.util.Date
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
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetCaptureStatusTest {
  private val context = ApplicationProvider.getApplicationContext<Application>()
  private val queue get() = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @Before @After fun reset() {
    QuickCaptureAudioSessionStore.clearForTests()
    context.getSharedPreferences(WidgetListStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    context.getSharedPreferences(WidgetPayloadStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    queue.deleteRecursively()
  }

  private fun intent(id: Int, kind: WidgetKind = WidgetKind.TASKS): Intent =
    shadowOf(WidgetRenderer.capturePendingIntent(context, id, kind)).savedIntent

  private fun controller(intent: Intent = Intent(context, QuickCaptureActivity::class.java)) =
    Robolectric.buildActivity(QuickCaptureActivity::class.java, intent).also {
      it.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog)
    }

  private fun save(activity: QuickCaptureActivity, title: String = "Capture /next"): JSONObject {
    activity.findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText(title)
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    return JSONObject(queue.listFiles { file -> file.extension == "json" }!!.single().readText()).also { queue.deleteRecursively() }
  }

  private fun select(activity: QuickCaptureActivity, status: String) {
    activity.findViewById<Button>(R.id.mindwtr_quick_capture_status).performClick()
    val dialog = ShadowDialog.getLatestDialog() as AlertDialog
    val list = dialog.listView
    val position = PendingCaptureWriter.CREATION_STATUSES.indexOf(status)
    list.performItemClick(list.adapter.getView(position, null, list), position, position.toLong())
  }

  @Test fun renderedWidgetsHaveDistinctImmutableExplicitCaptureRoutes() {
    val manager = AppWidgetManager.getInstance(context)
    for (id in listOf(41, 42)) {
      shadowOf(manager).addBoundWidget(id, AppWidgetProviderInfo().apply {
        provider = ComponentName(context.packageName, "TasksWidgetProvider")
      })
    }
    WidgetListStore.write(context, 41, "next")
    WidgetListStore.write(context, 42, "waiting")
    WidgetRenderer.render(context, manager, intArrayOf(41, 42), WidgetKind.TASKS)
    val launched = listOf(41, 42).map { id ->
      val views = shadowOf(manager).getViewFor(id)
      assertTrue(views.findViewById<View>(R.id.mindwtr_widget_capture).performClick())
      shadowOf(context).nextStartedActivity
    }
    assertFalse(launched[0].filterEquals(launched[1]))
    assertEquals(listOf(41, 42), launched.map { it.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1) })
    launched.forEach { assertEquals(QuickCaptureActivity::class.java.name, it.component!!.className) }
    assertTrue(WidgetRenderer.capturePendingIntent(context, 41, WidgetKind.TASKS).isImmutable)
    assertNotEquals(WidgetRenderer.capturePendingIntent(context, 41, WidgetKind.TASKS), WidgetRenderer.capturePendingIntent(context, 42, WidgetKind.TASKS))
  }

  @Test fun selectedListsResolveAtOpenAndOtherEntrypointsDefaultToInbox() {
    for (listId in listOf("inbox", "next", "waiting", "someday", "focus", "upcoming", "filter:f1", "context:@home", "tag:#work", "project:p1", "retired")) {
      val capture = intent(41)
      WidgetListStore.write(context, 41, listId)
      val host = controller(capture).setup()
      val json = save(host.get())
      assertEquals(PendingCaptureWriter.creationStatus(listId) ?: "inbox", json.getString("defaultStatus"))
      assertFalse(json.has("status"))
      host.pause().stop().destroy()
    }
    WidgetListStore.write(context, 41, "waiting")
    for (capture in listOf(Intent(context, QuickCaptureActivity::class.java), intent(41, WidgetKind.COMPACT), intent(41, WidgetKind.QUICK_CAPTURE))) {
      val host = controller(capture).setup()
      assertEquals("inbox", save(host.get()).getString("defaultStatus"))
      host.pause().stop().destroy()
    }
  }

  @Test fun explicitInboxSurvivesProcessRecreationAndAChangedWidget() {
    WidgetListStore.write(context, 41, "inbox")
    val launch = intent(41)
    val host = controller(launch).setup()
    host.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Capture /next")
    select(host.get(), "inbox")
    queue.writeText("Block queue publication")
    host.get().findViewById<Button>(R.id.mindwtr_quick_capture_save).performClick()
    assertFalse(host.get().isFinishing)
    val state = Bundle()
    host.saveInstanceState(state).pause().stop().destroy()
    QuickCaptureAudioSessionStore.clearForTests()
    assertTrue(queue.delete())
    WidgetListStore.write(context, 41, "waiting")
    val restored = controller(launch).create(state).start().restoreInstanceState(state).resume().visible()
    val json = save(restored.get())
    assertEquals("inbox", json.getString("defaultStatus"))
    assertEquals("inbox", json.getString("status"))
    restored.pause().stop().destroy()
  }

  @Test fun reopeningADraftRetainsItsDefaultWithoutLeakingToStandaloneCapture() {
    WidgetListStore.write(context, 41, "next")
    val first = controller(intent(41)).setup()
    first.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Retained")
    select(first.get(), "someday")
    first.pause().stop().destroy()
    WidgetListStore.write(context, 41, "waiting")
    val generic = controller().setup()
    assertEquals("inbox", save(generic.get()).getString("defaultStatus"))
    generic.pause().stop().destroy()
    val reopened = controller(intent(41)).setup()
    assertEquals("Retained", reopened.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    val json = save(reopened.get())
    assertEquals("next", json.getString("defaultStatus"))
    assertEquals("someday", json.getString("status"))
    reopened.pause().stop().destroy()
  }

  @Test fun queuedTextDoesNotSpeculateAboutInboxCountOrClaimTaskCreation() {
    WidgetPayloadStore.write(context, """{"inboxCount":7,"subtitle":"Inbox: 7"}""")
    WidgetListStore.write(context, 41, "next")
    val host = controller(intent(41)).setup()
    save(host.get())
    assertEquals(7, WidgetPayloadStore.read(context).inboxCount)
    assertEquals(WidgetPayload.EMPTY.quickCapture.queued, ShadowToast.getTextOfLatestToast())
    host.pause().stop().destroy()
  }

  @Test fun singleTaskNewIntentKeepsSameOwnerDraftAndStartsOtherOwnersWithTheirOwnStatus() {
    WidgetListStore.write(context, 41, "next")
    WidgetListStore.write(context, 42, "waiting")
    val first = controller(intent(41)).setup()
    first.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).setText("Draft A")
    select(first.get(), "someday")
    first.newIntent(intent(41))
    assertFalse(first.get().isFinishing)
    assertEquals("Draft A", first.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())

    first.newIntent(Intent(context, QuickCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK))
    assertTrue(first.get().isFinishing)
    val genericLaunch = shadowOf(first.get()).nextStartedActivity
    assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK, genericLaunch.flags)
    assertEquals(QuickCaptureActivity::class.java.name, genericLaunch.component!!.className)
    first.pause().stop().destroy()
    val generic = controller(genericLaunch).setup()
    assertEquals("inbox", save(generic.get()).getString("defaultStatus"))
    generic.pause().stop().destroy()

    val reopened = controller(intent(41)).setup()
    assertEquals("Draft A", reopened.get().findViewById<EditText>(R.id.mindwtr_quick_capture_input).text.toString())
    reopened.newIntent(intent(42))
    assertTrue(reopened.get().isFinishing)
    val secondLaunch = shadowOf(reopened.get()).nextStartedActivity
    reopened.pause().stop().destroy()
    val second = controller(secondLaunch).setup()
    val json = save(second.get())
    assertEquals("waiting", json.getString("defaultStatus"))
    assertFalse(json.has("status"))
    second.pause().stop().destroy()

    val original = controller(intent(41)).setup()
    val oldDraft = save(original.get())
    assertEquals("next", oldDraft.getString("defaultStatus"))
    assertEquals("someday", oldDraft.getString("status"))
    original.pause().stop().destroy()
  }

  @Test fun queuedAudioDoesNotSpeculateAboutInboxCount() {
    WidgetPayloadStore.write(context, """{"inboxCount":7,"subtitle":"Inbox: 7"}""")
    val draft = QuickCaptureAudioDraft("01234567-89ab-cdef-0123-456789abcdef", Date(0), File(context.filesDir, "audio.tmp"), 6_400)
    val session = QuickCaptureAudioSessionStore.acquire("TASKS/41") {
      QuickCaptureAudioSession(
        startRecorder = { callback ->
          callback(QuickCaptureAudioRecorder.Outcome.Ready(draft))
          object : QuickCaptureAudioSession.RecordingControl {
            override val id = draft.id
            override fun stop() = Unit
            override fun cancel() = Unit
          }
        },
        publishAudio = { _, _, _, complete -> complete(true) }, discardAudio = {}, defaultStatus = "next",
      )
    }
    session.beginRecording()
    session.saveAudio()
    val host = controller(intent(41)).setup()
    assertTrue(host.get().isFinishing)
    assertEquals(7, WidgetPayloadStore.read(context).inboxCount)
    assertEquals(WidgetPayload.EMPTY.quickCapture.audioSaved, ShadowToast.getTextOfLatestToast())
    host.pause().stop().destroy()
  }

  @Test fun lateOldOwnerPermissionResultCannotStartRecordingBeforeOnStop() {
    var recordings = 0
    val session = QuickCaptureAudioSessionStore.acquire("TASKS/41") {
      QuickCaptureAudioSession(
        startRecorder = { recordings += 1; error("Old owner must not start recording") },
        publishAudio = { _, _, _, _ -> }, discardAudio = {}, defaultStatus = "next",
      )
    }
    session.updateTitle("Keep old draft")
    session.awaitPermission()
    val host = controller(intent(41)).setup()
    host.newIntent(Intent(context, QuickCaptureActivity::class.java))
    // ActivityResultRegistry can dispatch before Android has called onStop.
    host.get().onMicrophonePermissionResult(true)
    assertEquals(0, recordings)
    assertEquals(QuickCaptureAudioSession.State.PERMISSION, session.snapshot.state)
    assertEquals("Keep old draft", session.snapshot.title)
    val genericLaunch = shadowOf(host.get()).nextStartedActivity
    host.pause().stop().destroy()
    val generic = controller(genericLaunch).setup()
    assertEquals("Status: Inbox", generic.get().findViewById<Button>(R.id.mindwtr_quick_capture_status).text.toString())
    assertFalse(generic.get().isFinishing)
    generic.pause().stop().destroy()
  }
}
