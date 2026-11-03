package tech.dongdongbh.mindwtr.androidwidget

import java.io.File
import java.nio.file.Files
import java.util.Date
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingCaptureWriterTest {
  private fun tempFilesDir(): File = Files.createTempDirectory("mindwtr-files").toFile()

  @Test fun writesOnlyAllowedDestinationMetadataAndPreservesExplicitInbox() {
    for (status in PendingCaptureWriter.CREATION_STATUSES) {
      val json = JSONObject(PendingCaptureWriter.write(tempFilesDir(), "Capture /next", defaultStatus = status, status = "inbox")!!.readText())
      assertEquals(status, json.getString("defaultStatus"))
      assertEquals("inbox", json.getString("status"))
    }
    for (invalid in listOf("done", "archived", "reference", "NEXT", " next ")) {
      val json = JSONObject(PendingCaptureWriter.write(tempFilesDir(), "Keep", note = "Keep note", defaultStatus = invalid, status = invalid)!!.readText())
      assertTrue(!json.has("defaultStatus"))
      assertTrue(!json.has("status"))
      assertEquals("Keep note", json.getString("note"))
    }
  }

  @Test
  fun writesOneJsonItemInTheParsePendingCaptureSchema() {
    val filesDir = tempFilesDir()

    val written = PendingCaptureWriter.write(filesDir, "  Buy milk  ", Date(0))

    assertNotNull(written)
    val directory = File(filesDir, "pending-captures")
    assertEquals(listOf(written!!.name), directory.list()!!.toList())
    assertTrue(written.name.endsWith(".json"))
    val json = JSONObject(written.readText())
    assertEquals(written.name.removeSuffix(".json"), json.getString("id"))
    assertEquals("Buy milk", json.getString("title"))
    assertEquals("1970-01-01T00:00:00.000Z", json.getString("createdAt"))
    assertEquals("android-quick-capture", json.getString("source"))
  }

  @Test
  fun writesLiteralMultilineNoteWithoutParsingOrTruncatingIt() {
    val note = "  @home #literal due:tomorrow\nSecond line\n" + "x".repeat(5000)
    val written = PendingCaptureWriter.write(tempFilesDir(), "Title", Date(0), note)

    assertEquals(note, JSONObject(written!!.readText()).getString("note"))
  }

  @Test
  fun titleOnlyAndBlankNoteKeepTheLegacyQueueShape() {
    val filesDir = tempFilesDir()
    val titleOnly = PendingCaptureWriter.write(filesDir, "Title")!!
    val blankNote = PendingCaptureWriter.write(filesDir, "Title", note = " \n ")!!

    assertTrue(!JSONObject(titleOnly.readText()).has("note"))
    assertTrue(!JSONObject(blankNote.readText()).has("note"))
    assertNull(PendingCaptureWriter.write(filesDir, "  ", note = "A note needs a title"))
  }

  @Test
  fun writesACompletionItemInTheCompleteKindSchema() {
    val filesDir = tempFilesDir()

    val written = PendingCaptureWriter.writeCompletion(filesDir, "task-9", Date(0))

    val json = JSONObject(written.readText())
    assertEquals("complete", json.getString("kind"))
    assertEquals("task-9", json.getString("taskId"))
    assertEquals("1970-01-01T00:00:00.000Z", json.getString("completedAt"))
    assertEquals("android-widget", json.getString("source"))
    assertEquals(written.name.removeSuffix(".json"), json.getString("id"))
    assertTrue(!json.has("title"))
  }

  @Test
  fun widgetCompletionRetryReusesTheExactDurableQueueItem() {
    val filesDir = tempFilesDir()

    val first = PendingCaptureWriter.writeCompletion(filesDir, "task-9", 1_000L)
    val second = PendingCaptureWriter.writeCompletion(filesDir, "task-9", 1_000L)

    assertEquals(first.canonicalFile, second.canonicalFile)
    assertEquals(listOf(first.name), File(filesDir, "pending-captures").list()!!.toList())
    val json = JSONObject(first.readText())
    assertEquals("1970-01-01T00:00:04.000Z", json.getString("completedAt"))
  }

  @Test
  fun aCommittedTapCannotRemoveTheQueuedCompletion() {
    val filesDir = tempFilesDir()
    val written = PendingCaptureWriter.writeCompletion(filesDir, "task-9", 1_000L)

    assertTrue(PendingCaptureWriter.hasQueuedCompletion(filesDir, "task-9", 1_000L))
    assertEquals(
      CheckoffStore.TapAction.RECONCILE,
      CheckoffStore.tapAction(isCommitted = false, hasQueuedCompletion = true),
    )
    assertTrue(written.exists())
  }

  @Test
  fun leavesNoTempFileBehindAndUsesUniqueNames() {
    val filesDir = tempFilesDir()

    val first = PendingCaptureWriter.write(filesDir, "one")
    val second = PendingCaptureWriter.write(filesDir, "two")

    val names = File(filesDir, "pending-captures").list()!!.sorted()
    assertEquals(listOf(first!!.name, second!!.name).sorted(), names)
    assertTrue(names.none { it.endsWith(".tmp") })
  }

  @Test
  fun rejectsBlankTitlesWithoutTouchingTheQueue() {
    val filesDir = tempFilesDir()

    assertNull(PendingCaptureWriter.write(filesDir, "   \n "))

    assertTrue(!File(filesDir, "pending-captures").exists())
  }

  @Test
  fun capsTheTitleAtTwoThousandCharacters() {
    val filesDir = tempFilesDir()

    val written = PendingCaptureWriter.write(filesDir, "x".repeat(2500))

    assertEquals(2000, JSONObject(written!!.readText()).getString("title").length)
  }

  @Test
  fun captureIntentRejectsOverLimitInsteadOfTruncating() {
    val filesDir = tempFilesDir()

    assertNull(PendingCaptureWriter.writeCaptureIntent(filesDir, "x".repeat(2001)))
    assertTrue(!File(filesDir, "pending-captures").exists())
  }
}
