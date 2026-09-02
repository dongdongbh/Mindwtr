package tech.dongdongbh.mindwtr.attachmentfileinstaller

import android.system.ErrnoException
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Covers the [AndroidAttachmentInstallerFileOps.moveExclusive] hard-link
 * fallback (issue #1139). android.system.Os is unusable on the host JVM
 * (every call throws "not mocked" and every OsConstants errno constant
 * collapses to 0 - verified empirically), so these tests drive the
 * [AndroidAttachmentInstallerFileOps.linkFile], [AndroidAttachmentInstallerFileOps.copyExclusive]
 * and [AndroidAttachmentInstallerFileOps.errnoName] seams directly instead of
 * a real cross-device mount, a real permission-denied filesystem, or a real
 * unmocked errno lookup.
 */
class AndroidAttachmentInstallerFileOpsTest {
  private val sentinelExdev = 18
  private val sentinelEio = 5

  @Test
  fun linkFailureFallsBackToAnExclusiveCopyThatPublishesTheSourceBytesAndRemovesTheSource() {
    withTempDir { dir ->
      val ops = AndroidAttachmentInstallerFileOps()
      val source = dir.resolve("source.bin").toFile().apply { writeText("attachment bytes") }
      val destination = dir.resolve("destination.bin").toFile()

      ops.linkFile = { _, _ -> LinkAttemptOutcome.Retry(sentinelExdev, ErrnoException("link", sentinelExdev)) }
      ops.copyExclusive = { s, d ->
        if (d.exists()) {
          CopyExclusiveOutcome.AlreadyExists
        } else {
          Files.copy(s.toPath(), d.toPath())
          Files.delete(s.toPath())
          CopyExclusiveOutcome.Published
        }
      }

      val published = ops.moveExclusive(source, destination)

      assertTrue(published)
      assertEquals("attachment bytes", destination.readText())
      assertFalse(source.exists())
    }
  }

  @Test
  fun eexistAtTheFallbackExclusiveCreateReturnsFalseAndLeavesTheExistingDestinationUntouched() {
    withTempDir { dir ->
      val ops = AndroidAttachmentInstallerFileOps()
      val source = dir.resolve("source.bin").toFile().apply { writeText("candidate bytes") }
      val destination = dir.resolve("destination.bin").toFile().apply { writeText("already published") }

      ops.linkFile = { _, _ -> LinkAttemptOutcome.Retry(sentinelExdev, ErrnoException("link", sentinelExdev)) }
      ops.copyExclusive = { _, d ->
        if (d.exists()) CopyExclusiveOutcome.AlreadyExists else error("test setup: destination unexpectedly missing")
      }

      val published = ops.moveExclusive(source, destination)

      assertFalse(published)
      assertEquals("already published", destination.readText())
      assertTrue(source.exists())
      assertEquals("candidate bytes", source.readText())
    }
  }

  @Test
  fun aNonListedErrnoAtTheLinkStepStillThrowsWithTheErrnoNameInTheMessage() {
    withTempDir { dir ->
      val ops = AndroidAttachmentInstallerFileOps()
      val source = dir.resolve("source.bin").toFile().apply { writeText("candidate bytes") }
      val destination = dir.resolve("destination.bin").toFile()

      ops.linkFile = { _, _ -> LinkAttemptOutcome.Failed(sentinelEio, ErrnoException("link", sentinelEio)) }
      ops.errnoName = { errno -> if (errno == sentinelEio) "EIO" else null }

      try {
        ops.moveExclusive(source, destination)
        fail("expected AttachmentInstallerFailure naming the errno")
      } catch (error: AttachmentInstallerFailure) {
        assertTrue(error.message.orEmpty().contains("(EIO)"))
      }
    }
  }

  private fun withTempDir(test: (java.nio.file.Path) -> Unit) {
    val dir = Files.createTempDirectory("attachment-installer-fileops-test")
    try {
      test(dir)
    } finally {
      dir.toFile().walkBottomUp().forEach { file -> Files.deleteIfExists(file.toPath()) }
    }
  }
}
