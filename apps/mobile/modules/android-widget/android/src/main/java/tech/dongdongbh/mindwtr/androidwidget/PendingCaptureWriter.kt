package tech.dongdongbh.mindwtr.androidwidget

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONObject

/**
 * Appends one item to the pending-captures queue (#845 contract): native code
 * never writes the app database. `apps/mobile/lib/pending-captures.ts`
 * (`parsePendingCapture`) reads `<filesDir>/pending-captures/<uuid>.json` on
 * the next app start or foreground and creates the Inbox task through the
 * normal store path.
 */
object PendingCaptureWriter {
  const val DIRECTORY = "pending-captures"
  const val SOURCE = "android-quick-capture"
  const val MAX_TITLE_LENGTH = 2000

  /** Returns the queued file, or null when the trimmed title is empty. */
  @Throws(IOException::class)
  fun write(filesDir: File, rawTitle: String, now: Date = Date()): File? {
    val title = rawTitle.trim().take(MAX_TITLE_LENGTH).trim()
    if (title.isEmpty()) return null

    val directory = File(filesDir, DIRECTORY)
    if (!directory.isDirectory && !directory.mkdirs()) {
      throw IOException("Could not create ${directory.absolutePath}")
    }
    val id = UUID.randomUUID().toString()
    val json = JSONObject()
      .put("id", id)
      .put("title", title)
      .put("createdAt", isoTimestamp(now))
      .put("source", SOURCE)
      .toString()

    // Ingest only picks up `*.json`, so a half-written `.tmp` is never read.
    val temp = File(directory, "$id.tmp")
    val target = File(directory, "$id.json")
    FileOutputStream(temp).use { stream ->
      stream.write(json.toByteArray(Charsets.UTF_8))
      stream.fd.sync()
    }
    if (!temp.renameTo(target)) {
      temp.delete()
      throw IOException("Could not publish ${target.absolutePath}")
    }
    return target
  }

  private fun isoTimestamp(date: Date): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(date)
}
