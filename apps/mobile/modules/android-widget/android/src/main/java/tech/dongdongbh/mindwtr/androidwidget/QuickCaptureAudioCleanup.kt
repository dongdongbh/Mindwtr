package tech.dongdongbh.mindwtr.androidwidget

import java.io.File
import java.io.IOException
import java.util.Locale


internal object QuickCaptureAudioCleanup {
  const val STALE_AFTER_MS: Long = 7L * 24 * 60 * 60 * 1_000


  fun sweep(
    filesDir: File,
    activeIds: Set<String> = emptySet(),
    nowMs: Long = System.currentTimeMillis(),
  ): Int {
    val audioDirectory = ownedDirectory(filesDir, PendingCaptureWriter.AUDIO_DIRECTORY) ?: return 0
    if (!audioDirectory.isDirectory) return 0
    val queueDirectory = ownedDirectory(filesDir, PendingCaptureWriter.DIRECTORY) ?: return 0
    val queuedIds = queuedCaptureIds(queueDirectory) ?: return 0
    val normalizedActiveIds = activeIds
      .filter(PendingCaptureWriter::isSafeAudioId)
      .mapTo(mutableSetOf()) { normalizeId(it) }
    val candidates = audioDirectory.listFiles() ?: return 0

    var deleted = 0
    for (candidate in candidates) {
      val id = audioCaptureId(candidate.name) ?: continue
      val normalizedId = normalizeId(id)
      if (normalizedId in queuedIds || normalizedId in normalizedActiveIds) continue
      if (!isOwnedRegularChild(candidate, audioDirectory)) continue
      val modifiedAt = candidate.lastModified()
      if (modifiedAt <= 0L || modifiedAt > nowMs) continue
      if (nowMs - modifiedAt < STALE_AFTER_MS) continue
      if (candidate.delete()) deleted += 1
    }
    return deleted
  }

  private fun queuedCaptureIds(queueDirectory: File): Set<String>? {
    if (!queueDirectory.exists()) return emptySet()
    if (!queueDirectory.isDirectory) return null
    val names = queueDirectory.list() ?: return null
    return names.mapNotNullTo(mutableSetOf()) { name ->
      val id = when {
        name.endsWith(".json") -> name.removeSuffix(".json")
        name.endsWith(".tmp") -> name.removeSuffix(".tmp")
        else -> return@mapNotNullTo null
      }
      id.takeIf(PendingCaptureWriter::isSafeAudioId)?.let(::normalizeId)
    }
  }

  private fun audioCaptureId(name: String): String? {
    val id = when {
      name.startsWith('.') && name.endsWith(".wav.tmp") ->
        name.removePrefix(".").removeSuffix(".wav.tmp")
      name.endsWith(".wav") -> name.removeSuffix(".wav")
      else -> return null
    }
    return id.takeIf(PendingCaptureWriter::isSafeAudioId)
  }


  private fun ownedDirectory(filesDir: File, name: String): File? {
    return try {
      val canonicalRoot = filesDir.canonicalFile
      val candidate = File(filesDir, name).absoluteFile
      val canonicalParent = candidate.parentFile?.canonicalFile ?: return null
      if (canonicalParent != canonicalRoot) return null
      val expected = File(canonicalParent, name).absoluteFile
      candidate.canonicalFile.takeIf { it == expected }
    } catch (_: IOException) {
      null
    }
  }

  private fun isOwnedRegularChild(candidate: File, canonicalDirectory: File): Boolean {
    return try {
      val absolute = candidate.absoluteFile
      if (absolute.parentFile?.canonicalFile != canonicalDirectory) return false
      val expected = File(canonicalDirectory, candidate.name).absoluteFile
      candidate.canonicalFile == expected && candidate.isFile
    } catch (_: IOException) {
      false
    }
  }

  private fun normalizeId(id: String): String = id.lowercase(Locale.ROOT)
}
