package tech.dongdongbh.mindwtr.attachmentfileinstaller

import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private class TestInstallerFileOps : AttachmentInstallerFileOps {
  override fun canonical(file: File): File = file.canonicalFile

  override fun ensureDirectory(directory: File) {
    Files.createDirectories(directory.toPath())
  }

  override fun nodeKind(file: File): InstallerNodeKind {
    val path = file.toPath()
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return InstallerNodeKind.MISSING
    if (Files.isSymbolicLink(path)) return InstallerNodeKind.SYMLINK
    val attributes = Files.readAttributes(
      path,
      BasicFileAttributes::class.java,
      LinkOption.NOFOLLOW_LINKS,
    )
    return when {
      attributes.isRegularFile -> InstallerNodeKind.REGULAR_FILE
      attributes.isDirectory -> InstallerNodeKind.DIRECTORY
      else -> InstallerNodeKind.OTHER
    }
  }

  override fun copySnapshot(source: File, destination: File) {
    Files.copy(source.toPath(), destination.toPath())
  }

  override fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
  }

  override fun moveExclusive(source: File, destination: File): Boolean {
    return try {
      Files.createLink(destination.toPath(), source.toPath())
      Files.delete(source.toPath())
      true
    } catch (_: FileAlreadyExistsException) {
      false
    }
  }

  override fun delete(file: File) {
    Files.deleteIfExists(file.toPath())
  }

  override fun readUtf8(file: File): String = file.readText(Charsets.UTF_8)

  override fun writeUtf8Durably(file: File, content: String) {
    val temporary = File(file.parentFile, "${file.name}.test-write")
    temporary.writeText(content, Charsets.UTF_8)
    Files.move(
      temporary.toPath(),
      file.toPath(),
      StandardCopyOption.ATOMIC_MOVE,
      StandardCopyOption.REPLACE_EXISTING,
    )
  }

  override fun syncDirectory(directory: File) = Unit

  override fun <T> withExclusiveLock(lockFile: File, action: () -> T): T = action()
}

private class MoveHookOps(
  private val delegate: AttachmentInstallerFileOps,
  private val hook: (moveNumber: Int, source: File, destination: File) -> Unit,
  private val afterHook: (moveNumber: Int, moved: Boolean) -> Unit = { _, _ -> },
) : AttachmentInstallerFileOps by delegate {
  private var moveCount = 0

  override fun moveExclusive(source: File, destination: File): Boolean {
    moveCount += 1
    hook(moveCount, source, destination)
    val moved = delegate.moveExclusive(source, destination)
    afterHook(moveCount, moved)
    return moved
  }
}

class AttachmentFileInstallerCoreTest {
  private val ops = TestInstallerFileOps()

  @Test
  fun absentGenerationUsesCreateNoReplaceAndConsumesTheStagedSnapshot() = withFixture { fixture ->
    val staged = fixture.stage("new bytes")
    val target = fixture.target("attachment.bin")

    val result = fixture.installer(ops).install(staged, target, ExpectedAttachmentGeneration.Absent)

    assertEquals(AttachmentInstallOutcome.Installed, result)
    assertEquals("new bytes", target.readText())
    assertFalse(staged.exists())
  }

  @Test
  fun absentGenerationPreservesTheCandidateWhenATargetWinsTheRace() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val target = fixture.target("attachment.bin")
    val racingOps = MoveHookOps(ops, hook = { move, _, destination ->
      if (move == 1) destination.writeText("peer")
    })

    val result = fixture.installer(racingOps).install(staged, target, ExpectedAttachmentGeneration.Absent)

    assertEquals(AttachmentInstallOutcome.Conflict(staged.canonicalFile), result)
    assertEquals("peer", target.readText())
    assertEquals("candidate", staged.readText())
  }

  @Test
  fun matchingPresentGenerationIsQuarantinedThenReplaced() = withFixture { fixture ->
    val staged = fixture.stage("new bytes")
    val target = fixture.target("attachment.bin").apply { writeText("old bytes") }
    val expected = ops.sha256(target)

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(expected),
    )

    assertEquals(AttachmentInstallOutcome.Installed, result)
    assertEquals("new bytes", target.readText())
    assertFalse(staged.exists())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun mismatchedPresentGenerationIsRestoredAndTheCandidateIsPreserved() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val target = fixture.target("attachment.bin").apply { writeText("peer generation") }

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(hash("expected generation")),
    )

    assertEquals(AttachmentInstallOutcome.Conflict(staged.canonicalFile), result)
    assertEquals("peer generation", target.readText())
    assertEquals("candidate", staged.readText())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun peerTakeoverDuringInstallPreservesPeerCandidateAndQuarantine() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val target = fixture.target("attachment.bin").apply { writeText("expected old") }
    val expected = ops.sha256(target)
    val racingOps = MoveHookOps(ops, hook = { move, _, destination ->
      if (move == 2) destination.writeText("peer takeover")
    })

    val result = fixture.installer(racingOps).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(expected),
    )

    val conflict = result as AttachmentInstallOutcome.Conflict
    assertEquals("peer takeover", target.readText())
    assertEquals("expected old", conflict.preservedFile.readText())
    assertEquals("candidate", staged.readText())
    assertTrue(fixture.internalArtifacts().any { it.name.endsWith(".journal") })
  }

  @Test
  fun interruptedQuarantineIsRestoredFromTheJournalBeforeRetry() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val target = fixture.target("attachment.bin").apply { writeText("expected old") }
    val expected = ops.sha256(target)
    val crashingOps = MoveHookOps(
      delegate = ops,
      hook = { _, _, _ -> },
      afterHook = { move, moved ->
        if (move == 1 && moved) throw IllegalStateException("simulated process interruption")
      },
    )

    try {
      fixture.installer(crashingOps).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expected),
      )
      fail("interrupted quarantine must fail the first invocation")
    } catch (_: IllegalStateException) {
    }

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(expected),
    )
    assertEquals(AttachmentInstallOutcome.Installed, result)
    assertEquals("candidate", target.readText())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun missingPresentGenerationConflictsWithoutCreatingATarget() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val target = fixture.target("attachment.bin")

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(hash("old")),
    )

    assertEquals(AttachmentInstallOutcome.Conflict(staged.canonicalFile), result)
    assertFalse(target.exists())
    assertEquals("candidate", staged.readText())
  }

  @Test
  fun rejectsOutOfRootDirectoryAndSymlinkInputs() = withFixture { fixture ->
    val staged = fixture.stage("candidate")
    val outside = Files.createTempFile("outside-attachment", ".bin").toFile()
    try {
      assertFailsWithMessage("outside the managed attachment root") {
        fixture.installer(ops).install(staged, outside, ExpectedAttachmentGeneration.Absent)
      }
    } finally {
      Files.deleteIfExists(outside.toPath())
    }

    val directoryTarget = fixture.target("directory-target").apply { mkdirs() }
    assertFailsWithMessage("directory") {
      fixture.installer(ops).install(staged, directoryTarget, ExpectedAttachmentGeneration.Absent)
    }

    val realSource = fixture.stage("symlink source")
    val symlink = fixture.cache.resolve("symlink.bin")
    Files.createSymbolicLink(symlink.toPath(), realSource.toPath())
    assertFailsWithMessage("symbolic link") {
      fixture.installer(ops).install(symlink, fixture.target("symlink-target"), ExpectedAttachmentGeneration.Absent)
    }
  }

  private fun assertFailsWithMessage(expected: String, action: () -> Unit) {
    try {
      action()
      fail("Expected installer failure containing: $expected")
    } catch (error: AttachmentInstallerFailure) {
      assertTrue(error.message.orEmpty().contains(expected))
    }
  }

  private fun hash(value: String): String = sha256(value.toByteArray(StandardCharsets.UTF_8))

  private fun withFixture(test: (Fixture) -> Unit) {
    val root = Files.createTempDirectory("attachment-installer-test").toFile()
    try {
      test(Fixture(root))
    } finally {
      root.walkBottomUp().forEach { file ->
        Files.deleteIfExists(file.toPath())
      }
    }
  }

  private data class Fixture(val root: File) {
    val files = root.resolve("files").apply { mkdirs() }
    val cache = root.resolve("cache").apply { mkdirs() }
    private val attachments = files.resolve("attachments").apply { mkdirs() }

    fun installer(ops: AttachmentInstallerFileOps) = AttachmentFileInstallerCore(
      targetRoot = attachments,
      sourceRoots = listOf(files, cache),
      ops = ops,
    )

    fun stage(content: String): File = cache.resolve("stage-${System.nanoTime()}.bin").apply {
      writeText(content)
    }

    fun target(name: String): File = attachments.resolve(name)

    fun internalArtifacts(): List<File> = attachments.listFiles()
      .orEmpty()
      .filter { it.name.startsWith(INSTALLER_ARTIFACT_PREFIX) }
  }
}
