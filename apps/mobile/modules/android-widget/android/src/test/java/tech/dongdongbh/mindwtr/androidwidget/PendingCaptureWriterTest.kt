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
}
