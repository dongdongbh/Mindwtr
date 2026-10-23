package tech.dongdongbh.mindwtr.androidwidget

import java.io.File
import java.io.IOException
import java.util.Date
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Test

class QuickCaptureAudioSessionTest {
  @After
  fun clearRetainedSession() {
    QuickCaptureAudioSessionStore.clearForTests()
  }

  @Test fun ownerSessionsKeepTheirOwnAudioDestinationAcrossBackgroundPublicationRetry() {
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val publications = ArrayList<Publication>()
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    val first = QuickCaptureAudioSessionStore.acquire("TASKS/41") {
      QuickCaptureAudioSession(
        startRecorder = { callback -> deliver = callback; recorder },
        publishAudio = { draft, title, note, complete -> publications.add(Publication(draft, title, note, complete)) },
        discardAudio = {}, defaultStatus = "waiting", initialCaptureStatus = "inbox",
      )
    }
    first.beginRecording()
    first.onHostStopped()
    assertEquals(1, recorder.stopCount)
    val second = QuickCaptureAudioSessionStore.acquire("TASKS/42") {
      QuickCaptureAudioSession(startRecorder = { error("No recording requested") }, publishAudio = { _, _, _, _ -> }, discardAudio = {}, defaultStatus = "someday")
    }
    assertNotSame(first, second)
    assertEquals("someday", second.defaultStatus)
    assertEquals(null, second.captureStatus)
    assertTrue(QuickCaptureAudioSessionStore.activeIds().contains(recorder.id))
    deliver(QuickCaptureAudioRecorder.Outcome.Ready(QuickCaptureAudioDraft(recorder.id!!, Date(0), File("/owned/audio.tmp"), 6_400)))
    first.selectCaptureStatus("next")
    assertEquals("inbox", first.captureStatus)
    publications.single().complete(false)
    assertTrue(QuickCaptureAudioSessionStore.activeIds().contains(recorder.id))
    assertSame(first, QuickCaptureAudioSessionStore.acquire("TASKS/41") { error("Retain the original draft") })
    assertEquals("waiting", first.defaultStatus)
    assertEquals("inbox", first.captureStatus)
    first.saveAudio()
    assertEquals(2, publications.size)
    assertEquals(publications[0].draft, publications[1].draft)
    assertEquals(QuickCaptureAudioSession.State.IDLE, second.snapshot.state)
  }

  @Test
  fun tooShortRotationRestoresTypedPrefixInIdleRetryState() {
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val session = QuickCaptureAudioSession(
      startRecorder = { callback -> deliver = callback; recorder },
      publishAudio = { _, _, _, _ -> error("Too-short audio must not publish") },
      discardAudio = {},
    )
    val oldHost = session.attach {}
    session.updateTitle("Typed prefix")
    session.updateNote("  Literal @home\n#not-a-tag  ")
    session.beginRecording()

    session.onHostStopped()
    assertEquals(QuickCaptureAudioSession.State.STOPPING, session.snapshot.state)
    assertEquals(1, recorder.stopCount)
    session.detach(oldHost)
    deliver(QuickCaptureAudioRecorder.Outcome.Failed(IOException("Recording was too short")))

    var recreated: QuickCaptureAudioSession.Snapshot? = null
    session.attach { recreated = it }
    assertEquals(QuickCaptureAudioSession.State.IDLE, recreated!!.state)
    assertEquals(QuickCaptureAudioSession.Status.ERROR, recreated!!.status)
    assertEquals("Typed prefix", recreated!!.title)
    assertEquals("  Literal @home\n#not-a-tag  ", recreated!!.note)
    assertTrue(recreated!!.canSaveText)
  }

  @Test
  fun publishFailureAcrossRecreationRetriesSameDraftAndTypedPrefix() {
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val publications = ArrayList<Publication>()
    val session = QuickCaptureAudioSession(
      startRecorder = { callback -> deliver = callback; recorder },
      publishAudio = { draft, title, note, complete -> publications.add(Publication(draft, title, note, complete)) },
      discardAudio = {},
    )
    val oldHost = session.attach {}
    val draft = QuickCaptureAudioDraft(
      id = recorder.id!!,
      createdAt = Date(0),
      stagedFile = File("/owned/.${recorder.id}.wav.tmp"),
      dataBytes = 6_400,
    )
    session.updateTitle("Typed prefix")
    session.updateNote("  Literal @home\n#not-a-tag  ")
    session.beginRecording()
    session.onHostStopped()
    deliver(QuickCaptureAudioRecorder.Outcome.Ready(draft))

    assertEquals(QuickCaptureAudioSession.State.SAVING, session.snapshot.state)
    assertEquals(1, publications.size)
    session.detach(oldHost)
    var recreated: QuickCaptureAudioSession.Snapshot? = null
    session.attach { recreated = it }
    assertEquals(QuickCaptureAudioSession.State.SAVING, recreated!!.state)
    publications.single().complete(false)

    assertEquals(QuickCaptureAudioSession.State.READY, recreated!!.state)
    assertEquals(QuickCaptureAudioSession.Status.ERROR, recreated!!.status)
    assertEquals("Typed prefix", recreated!!.title)
    assertEquals("  Literal @home\n#not-a-tag  ", recreated!!.note)
    assertEquals(setOf(draft.id), session.activeIds)
    session.saveAudio()
    assertEquals(2, publications.size)
    assertSame(publications[0].draft, publications[1].draft)
    assertEquals("Typed prefix", publications[1].title)
    assertEquals("  Literal @home\n#not-a-tag  ", publications[1].note)

    publications[1].complete(true)
    assertEquals(QuickCaptureAudioSession.State.SAVED, session.snapshot.state)
    assertTrue(session.consumeSaved())
    assertFalse(session.consumeSaved())
  }

  @Test
  fun noHistoryOwnerClearDoesNotTurnHomeInterruptionIntoCancellation() {
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val publications = ArrayList<Publication>()
    val session = QuickCaptureAudioSession(
      startRecorder = { callback -> deliver = callback; recorder },
      publishAudio = { draft, title, note, complete -> publications.add(Publication(draft, title, note, complete)) },
      discardAudio = {},
    )
    val draft = QuickCaptureAudioDraft(
      id = recorder.id!!,
      createdAt = Date(0),
      stagedFile = File("/owned/.${recorder.id}.wav.tmp"),
      dataBytes = 6_400,
    )
    session.updateTitle("Home prefix")
    session.updateNote("Home\nnote")
    session.beginRecording()

    session.onHostStopped()
    session.onOwnerCleared()
    deliver(QuickCaptureAudioRecorder.Outcome.Ready(draft))

    assertEquals(1, recorder.stopCount)
    assertEquals(0, recorder.cancelCount)
    assertEquals(1, publications.size)
    assertSame(draft, publications.single().draft)
    assertEquals("Home prefix", publications.single().title)
    assertEquals("Home\nnote", publications.single().note)
  }

  @Test
  fun ownerClearReleasesPermissionWaitWithoutLettingItsLateCallbackStartTheNextRequest() {
    var recorderStarts = 0
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    val session = QuickCaptureAudioSession(
      startRecorder = {
        recorderStarts += 1
        recorder
      },
      publishAudio = { _, _, _, _ -> error("Unused") },
      discardAudio = {},
    )
    val firstOwner = QuickCaptureAudioSessionStore.acquire { session }
    firstOwner.attach {}
    firstOwner.updateTitle("Keep this title")
    val staleRequest = firstOwner.awaitPermission()!!

    firstOwner.onOwnerCleared()
    assertEquals(QuickCaptureAudioSession.State.IDLE, firstOwner.snapshot.state)
    assertEquals("Keep this title", firstOwner.snapshot.title)
    assertTrue(firstOwner.snapshot.canSaveText)

    val secondOwner = QuickCaptureAudioSessionStore.acquire { error("Session was not retained") }
    assertSame(firstOwner, secondOwner)
    secondOwner.attach {}
    val currentRequest = secondOwner.awaitPermission()!!
    assertTrue(currentRequest != staleRequest)

    firstOwner.permissionGranted(staleRequest)
    assertEquals(QuickCaptureAudioSession.State.PERMISSION, secondOwner.snapshot.state)
    assertEquals(0, recorderStarts)

    secondOwner.permissionGranted(currentRequest)
    assertEquals(QuickCaptureAudioSession.State.RECORDING, secondOwner.snapshot.state)
    assertEquals(1, recorderStarts)
  }

  @Test
  fun configRecreationCanRestoreTheActivePermissionRequestForResultRedelivery() {
    var recorderStarts = 0
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    val session = QuickCaptureAudioSession(
      startRecorder = {
        recorderStarts += 1
        recorder
      },
      publishAudio = { _, _, _, _ -> error("Unused") },
      discardAudio = {},
    )
    val oldHost = session.attach {}
    session.updateTitle("Rotation title")
    val requestId = session.awaitPermission()!!
    val oldPermissionOwner = QuickCapturePermissionOwner().apply {
      launched(requestId)
      onStarting()
      onStopped()
    }
    assertEquals(null, oldPermissionOwner.consumeResult())

    session.detach(oldHost)
    var recreated: QuickCaptureAudioSession.Snapshot? = null
    session.attach { recreated = it }
    val recreatedPermissionOwner = QuickCapturePermissionOwner().apply {
      restore(session.permissionRequestId)
      // QuickCaptureActivity calls this before super.onStart(), which is where
      // ActivityResultRegistry may synchronously redeliver the pending result.
      onStarting()
    }
    val restoredRequestId = recreatedPermissionOwner.consumeResult()

    assertEquals(requestId, restoredRequestId)
    assertEquals(QuickCaptureAudioSession.State.PERMISSION, recreated!!.state)
    assertEquals("Rotation title", recreated!!.title)
    session.permissionGranted(restoredRequestId!!)
    assertEquals(QuickCaptureAudioSession.State.RECORDING, session.snapshot.state)
    assertEquals(1, recorderStarts)
  }

  @Test
  fun failedPublishAfterOwnerClearIsRetainedForNewOwnerRetry() {
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val publications = ArrayList<Publication>()
    lateinit var created: QuickCaptureAudioSession
    created = QuickCaptureAudioSession(
      startRecorder = { callback -> deliver = callback; recorder },
      publishAudio = { draft, title, note, complete -> publications.add(Publication(draft, title, note, complete)) },
      discardAudio = {},
      onTerminal = { QuickCaptureAudioSessionStore.release(created) },
    )
    val firstOwner = QuickCaptureAudioSessionStore.acquire { created }
    val draft = QuickCaptureAudioDraft(
      id = recorder.id!!,
      createdAt = Date(0),
      stagedFile = File("/owned/.${recorder.id}.wav.tmp"),
      dataBytes = 6_400,
    )
    firstOwner.updateTitle("Retained Home prefix")
    firstOwner.updateNote("Retained\nnote")
    firstOwner.beginRecording()
    firstOwner.onHostStopped()
    firstOwner.onOwnerCleared()
    deliver(QuickCaptureAudioRecorder.Outcome.Ready(draft))
    publications.single().complete(false)

    val secondOwner = QuickCaptureAudioSessionStore.acquire { error("Session was not retained") }
    assertSame(firstOwner, secondOwner)
    var restored: QuickCaptureAudioSession.Snapshot? = null
    secondOwner.attach { restored = it }
    assertEquals(QuickCaptureAudioSession.State.READY, restored!!.state)
    assertEquals("Retained Home prefix", restored!!.title)
    assertEquals("Retained\nnote", restored!!.note)
    secondOwner.saveAudio()
    assertEquals(2, publications.size)
    assertSame(draft, publications[1].draft)
    assertEquals("Retained Home prefix", publications[1].title)
    assertEquals("Retained\nnote", publications[1].note)

    publications[1].complete(true)
    val replacement = QuickCaptureAudioSessionStore.acquire {
      QuickCaptureAudioSession(
        startRecorder = { error("Unused") },
        publishAudio = { _, _, _, _ -> error("Unused") },
        discardAudio = {},
      )
    }
    assertNotSame(firstOwner, replacement)
  }

  @Test
  fun successfulTextCaptureReleasesRetainedSessionBeforeNextOpen() {
    lateinit var first: QuickCaptureAudioSession
    first = QuickCaptureAudioSession(
      startRecorder = { error("Unused") },
      publishAudio = { _, _, _, _ -> error("Unused") },
      discardAudio = {},
      onTerminal = { QuickCaptureAudioSessionStore.release(first) },
    )
    val firstOwner = QuickCaptureAudioSessionStore.acquire { first }
    firstOwner.updateTitle("Already saved")

    firstOwner.completeTextCapture()
    firstOwner.onOwnerCleared()

    val nextOwner = QuickCaptureAudioSessionStore.acquire {
      QuickCaptureAudioSession(
        startRecorder = { error("Unused") },
        publishAudio = { _, _, _, _ -> error("Unused") },
        discardAudio = {},
      )
    }
    assertNotSame(firstOwner, nextOwner)
    assertEquals("", nextOwner.snapshot.title)
    assertEquals(QuickCaptureAudioSession.State.IDLE, nextOwner.snapshot.state)
  }

  @Test
  fun cancelAudioKeepsANoteEvenWithoutATypedTitle() {
    lateinit var deliver: (QuickCaptureAudioRecorder.Outcome) -> Unit
    val recorder = FakeRecordingControl("01234567-89ab-cdef-0123-456789abcdef")
    val session = QuickCaptureAudioSession(
      startRecorder = { callback -> deliver = callback; recorder },
      publishAudio = { _, _, _, _ -> error("Cancelled audio must not publish") },
      discardAudio = {},
    )
    session.updateNote("A note without a title\nshould remain editable")
    session.beginRecording()

    assertFalse(session.cancelAudioOrClose())
    deliver(QuickCaptureAudioRecorder.Outcome.Cancelled)

    assertEquals(QuickCaptureAudioSession.State.IDLE, session.snapshot.state)
    assertEquals("A note without a title\nshould remain editable", session.snapshot.note)
    assertFalse(session.snapshot.canSaveText)
    session.updateTitle("Add title")
    assertTrue(session.snapshot.canSaveText)
  }

  private data class Publication(
    val draft: QuickCaptureAudioDraft,
    val title: String,
    val note: String,
    val complete: (Boolean) -> Unit,
  )

  private class FakeRecordingControl(override val id: String?) : QuickCaptureAudioSession.RecordingControl {
    var stopCount = 0
    var cancelCount = 0

    override fun stop() {
      stopCount += 1
    }

    override fun cancel() {
      cancelCount += 1
    }
  }
}
