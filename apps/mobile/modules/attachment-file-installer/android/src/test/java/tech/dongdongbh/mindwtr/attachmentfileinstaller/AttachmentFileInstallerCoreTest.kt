package tech.dongdongbh.mindwtr.attachmentfileinstaller

import java.io.File
import java.io.RandomAccessFile
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

  override fun createPrivateDirectoryExclusive(directory: File) {
    Files.createDirectory(directory.toPath())
  }

  override fun createNewRegularFile(file: File) {
    Files.createFile(file.toPath())
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

  override fun nodeIdentity(file: File): String {
    val attributes = Files.readAttributes(
      file.toPath(),
      BasicFileAttributes::class.java,
      LinkOption.NOFOLLOW_LINKS,
    )
    return attributes.fileKey()?.toString() ?: file.canonicalPath
  }

  override fun fileIdentity(file: File): AttachmentFileIdentity {
    val attributes = Files.readAttributes(
      file.toPath(),
      BasicFileAttributes::class.java,
      LinkOption.NOFOLLOW_LINKS,
    )
    return AttachmentFileIdentity(
      fileKey = attributes.fileKey()?.toString() ?: file.canonicalPath,
      size = attributes.size(),
      modificationTimeNs = attributes.lastModifiedTime().toMillis() * 1_000_000L,
      changeTimeNs = attributes.creationTime().toMillis() * 1_000_000L,
    )
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

  override fun publishVerifiedImmutable(
    source: File,
    destination: File,
    expectedSha256: String,
    expectedSourceIdentity: String,
    expectedDirectoryIdentity: String,
    expectedPrivateDirectoryIdentity: String,
  ): ImmutableAttachmentPublishOutcome {
    val destinationParent = destination.parentFile
      ?: throw AttachmentInstallerFailure("Attachment target directory is unavailable")
    val sourceParent = source.parentFile
      ?: throw AttachmentInstallerFailure("Attachment private directory is unavailable")
    if (
      fileIdentity(source).fileKey != expectedSourceIdentity
      || nodeIdentity(destinationParent) != expectedDirectoryIdentity
      || nodeIdentity(sourceParent) != expectedPrivateDirectoryIdentity
    ) {
      throw AttachmentInstallerFailure("Attachment publication directory identity changed")
    }
    val before = fileIdentity(source)
    if (sha256(source) != expectedSha256 || fileIdentity(source).fileKey != before.fileKey) {
      throw AttachmentInstallerFailure("Staged attachment changed before native publication")
    }
    return if (moveExclusive(source, destination)) {
      ImmutableAttachmentPublishOutcome.PUBLISHED
    } else {
      ImmutableAttachmentPublishOutcome.ALREADY_EXISTS
    }
  }

  override fun retireEmptyDirectoryIfIdentity(
    directory: File,
    expectedIdentity: String,
    expectedParentIdentity: String,
  ): ImmutableAttachmentStageCleanupOutcome {
    val parent = directory.parentFile ?: return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    if (
      nodeIdentity(parent) != expectedParentIdentity
      || nodeKind(directory) != InstallerNodeKind.DIRECTORY
      || nodeIdentity(directory) != expectedIdentity
    ) {
      return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    }
    return try {
      Files.delete(directory.toPath())
      ImmutableAttachmentStageCleanupOutcome.REMOVED
    } catch (_: Throwable) {
      ImmutableAttachmentStageCleanupOutcome.CONFLICT
    }
  }

  override fun retireReservedPrivateStage(
    directory: File,
  ): ImmutableAttachmentStageCleanupOutcome {
    val parent = directory.parentFile ?: return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    val quarantine = File(parent, "${directory.name}$INSTALLER_RETIREMENT_SUFFIX")
    val directoryKind = nodeKind(directory)
    val quarantineKind = nodeKind(quarantine)
    if (directoryKind == InstallerNodeKind.MISSING && quarantineKind == InstallerNodeKind.MISSING) {
      syncDirectory(parent)
      return ImmutableAttachmentStageCleanupOutcome.MISSING
    }
    if (directoryKind != InstallerNodeKind.MISSING && quarantineKind != InstallerNodeKind.MISSING) {
      return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    }
    if (quarantineKind != InstallerNodeKind.MISSING) {
      if (quarantineKind != InstallerNodeKind.DIRECTORY) {
        return ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
      return try {
        Files.delete(quarantine.toPath())
        syncDirectory(parent)
        ImmutableAttachmentStageCleanupOutcome.REMOVED
      } catch (_: Throwable) {
        ImmutableAttachmentStageCleanupOutcome.CONFLICT
      }
    }
    if (directoryKind != InstallerNodeKind.DIRECTORY) {
      return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    }
    when (nodeKind(File(directory, "stage"))) {
      InstallerNodeKind.MISSING -> Unit
      InstallerNodeKind.REGULAR_FILE -> delete(File(directory, "stage"))
      else -> return ImmutableAttachmentStageCleanupOutcome.CONFLICT
    }
    syncDirectory(directory)
    return retireEmptyDirectoryIfIdentity(
      directory,
      nodeIdentity(directory),
      nodeIdentity(parent),
    )
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

private class CopyMutationOps(
  private val delegate: AttachmentInstallerFileOps,
  private val replacement: String,
) : AttachmentInstallerFileOps by delegate {
  override fun copySnapshot(source: File, destination: File) {
    source.writeText(replacement)
    delegate.copySnapshot(source, destination)
  }
}

private class JournalFaultOps(
  private val delegate: AttachmentInstallerFileOps,
) : AttachmentInstallerFileOps by delegate {
  private var writes = 0

  override fun writeUtf8Durably(file: File, content: String) {
    delegate.writeUtf8Durably(file, content)
    writes += 1
    if (writes == 1) throw IllegalStateException("simulated crash after initial journal")
  }
}

private class LinkBeforeUnlinkFaultOps(
  private val delegate: AttachmentInstallerFileOps,
  private val failMove: Int,
) : AttachmentInstallerFileOps by delegate {
  private var moves = 0

  override fun moveExclusive(source: File, destination: File): Boolean {
    moves += 1
    if (moves != failMove) return delegate.moveExclusive(source, destination)
    Files.createLink(destination.toPath(), source.toPath())
    throw IllegalStateException("simulated crash after link before unlink")
  }
}

private fun AttachmentFileInstallerCore.install(
  staged: File,
  target: File,
  expected: ExpectedAttachmentGeneration,
): AttachmentInstallOutcome = install(staged, target, expected, sha256(Files.readAllBytes(staged.toPath())))

class AttachmentFileInstallerCoreTest {
  private val ops = TestInstallerFileOps()

  @Test
  fun absentGenerationUsesCreateNoReplaceAndConsumesTheStagedSnapshot() = withFixture { fixture ->
    val staged = fixture.stage("new bytes")
    val target = fixture.target("attachment.bin")

    val result = fixture.installer(ops).install(staged, target, ExpectedAttachmentGeneration.Absent)

    assertEquals(AttachmentInstallOutcome.Installed(), result)
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

    val installed = result as AttachmentInstallOutcome.Installed
    assertEquals("new bytes", target.readText())
    assertFalse(staged.exists())
    assertTrue(fixture.internalArtifacts().isEmpty())
    assertEquals("old bytes", installed.preservedFile?.readText())
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
    assertTrue(result is AttachmentInstallOutcome.Installed)
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

  @Test
  fun absentStageReplacementFailsBeforePublishingTarget() = withFixture { fixture ->
    val staged = fixture.stage("validated download")
    val expectedDownload = ops.sha256(staged)
    val target = fixture.target("absent-stage-race.bin")

    assertFailsWithMessage("changed before native snapshot") {
      fixture.installer(CopyMutationOps(ops, "replacement bytes")).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Absent,
        expectedDownload,
      )
    }

    assertFalse(target.exists())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun presentStageReplacementFailsBeforeQuarantiningTarget() = withFixture { fixture ->
    val staged = fixture.stage("validated download")
    val expectedDownload = ops.sha256(staged)
    val target = fixture.target("present-stage-race.bin").apply { writeText("old generation") }

    assertFailsWithMessage("changed before native snapshot") {
      fixture.installer(CopyMutationOps(ops, "replacement bytes")).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(ops.sha256(target)),
        expectedDownload,
      )
    }

    assertEquals("old generation", target.readText())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun initialJournalCrashRecoversUntouchedTargetAndRetries() = withFixture { fixture ->
    val staged = fixture.stage("new generation")
    val target = fixture.target("journal-crash.bin").apply { writeText("old generation") }
    val expectedLocal = ops.sha256(target)

    try {
      fixture.installer(JournalFaultOps(ops)).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      )
      fail("initial journal fault must interrupt the install")
    } catch (_: IllegalStateException) {
    }
    assertEquals("old generation", target.readText())

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(expectedLocal),
    ) as AttachmentInstallOutcome.Installed
    assertEquals("new generation", target.readText())
    assertEquals("old generation", result.preservedFile?.readText())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun linkBeforeUnlinkCrashRecoversAndRetriesWithoutPermanentConflict() = withFixture { fixture ->
    val staged = fixture.stage("new generation")
    val target = fixture.target("link-crash.bin").apply { writeText("old generation") }
    val expectedLocal = ops.sha256(target)

    try {
      fixture.installer(LinkBeforeUnlinkFaultOps(ops, failMove = 1)).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      )
      fail("link-before-unlink fault must interrupt the install")
    } catch (_: IllegalStateException) {
    }

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Present(expectedLocal),
    ) as AttachmentInstallOutcome.Installed
    assertEquals("new generation", target.readText())
    assertEquals("old generation", result.preservedFile?.readText())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun retainedOldInodeSurvivesLateWriteThroughPreopenedDescriptor() = withFixture { fixture ->
    val staged = fixture.stage("new generation")
    val target = fixture.target("late-writer.bin").apply { writeText("old generation") }
    val expectedLocal = ops.sha256(target)

    RandomAccessFile(target, "rw").use { writer ->
      val result = fixture.installer(ops).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      ) as AttachmentInstallOutcome.Installed
      writer.seek(0)
      writer.write("late old bytes".toByteArray())
      writer.setLength("late old bytes".length.toLong())
      writer.fd.sync()

      assertEquals("new generation", target.readText())
      assertEquals("late old bytes", result.preservedFile?.readText())
    }
  }

  @Test
  fun recoveryPreservesDistinctSameHashQuarantineBeforeRestart() = withFixture { fixture ->
    val staged = fixture.stage("new generation")
    val target = fixture.target("distinct-recovery-quarantine.bin").apply { writeText("old generation") }
    val expectedLocal = ops.sha256(target)

    try {
      fixture.installer(JournalFaultOps(ops)).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      )
      fail("initial journal fault must interrupt the install")
    } catch (_: IllegalStateException) {
    }

    // Model an uncoordinated writer creating a distinct inode with the same
    // bytes at the active quarantine name before recovery observes it.
    val quarantine = fixture.activeArtifact(".quarantine").apply { writeText("old generation") }
    RandomAccessFile(quarantine, "rw").use { lateWriter ->
      val result = fixture.installer(ops).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      ) as AttachmentInstallOutcome.Installed

      lateWriter.seek(0)
      lateWriter.write("late quarantine bytes".toByteArray())
      lateWriter.setLength("late quarantine bytes".length.toLong())
      lateWriter.fd.sync()

      assertEquals("new generation", target.readText())
      assertEquals("old generation", result.preservedFile?.readText())
      assertTrue(fixture.preservedArtifacts().any { it.readText() == "late quarantine bytes" })
    }
  }

  @Test
  fun completedRecoveryPreservesDistinctSameHashActiveQuarantine() = withFixture { fixture ->
    val staged = fixture.stage("new generation")
    val target = fixture.target("distinct-completed-quarantine.bin").apply { writeText("old generation") }
    val expectedLocal = ops.sha256(target)

    try {
      fixture.installer(LinkBeforeUnlinkFaultOps(ops, failMove = 3)).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      )
      fail("preservation link-before-unlink fault must interrupt the install")
    } catch (_: IllegalStateException) {
    }

    val quarantine = fixture.activeArtifact(".quarantine")
    Files.delete(quarantine.toPath())
    quarantine.writeText("old generation")
    RandomAccessFile(quarantine, "rw").use { lateWriter ->
      val result = fixture.installer(ops).install(
        staged,
        target,
        ExpectedAttachmentGeneration.Present(expectedLocal),
      ) as AttachmentInstallOutcome.Installed

      lateWriter.seek(0)
      lateWriter.write("late replacement bytes".toByteArray())
      lateWriter.setLength("late replacement bytes".length.toLong())
      lateWriter.fd.sync()

      assertEquals("new generation", target.readText())
      assertEquals("old generation", result.preservedFile?.readText())
      assertTrue(fixture.preservedArtifacts().any { it.readText() == "late replacement bytes" })
      assertFalse(quarantine.exists())
    }
  }

  @Test
  fun absentRetryTreatsAlreadyPublishedMatchingBytesAsInstalled() = withFixture { fixture ->
    val staged = fixture.stage("same generation")
    val target = fixture.target("absent-retry.bin").apply { writeText("same generation") }

    val result = fixture.installer(ops).install(
      staged,
      target,
      ExpectedAttachmentGeneration.Absent,
    )

    assertEquals(AttachmentInstallOutcome.Installed(), result)
    assertFalse(staged.exists())
    assertEquals("same generation", target.readText())
  }

  @Test
  fun nativeHasherStreamsStableManagedGeneration() = withFixture { fixture ->
    val target = fixture.target("hash.bin").apply { writeText("managed generation") }

    val snapshot = fixture.hasher(ops).hash(target)

    assertEquals(hash("managed generation"), snapshot.sha256)
    assertEquals(target.length(), snapshot.size)
  }

  @Test
  fun nativeHasherRejectsReplacementDuringRead() = withFixture { fixture ->
    val target = fixture.target("hash-race.bin").apply { writeText("old generation") }
    val racingOps = object : AttachmentInstallerFileOps by ops {
      override fun sha256(file: File): String {
        val digest = ops.sha256(file)
        val replacement = fixture.target("hash-race-replacement.bin").apply {
          writeText("new generation")
        }
        Files.move(
          replacement.toPath(),
          file.toPath(),
          StandardCopyOption.REPLACE_EXISTING,
        )
        return digest
      }
    }

    assertFailsWithMessage("changed while hashing") {
      fixture.hasher(racingOps).hash(target)
    }
  }

  @Test
  fun immutablePublisherCreatesNoSharedInstallerRecoveryArtifacts() = withFixture { fixture ->
    val target = fixture.target("a.${hash("candidate")}.txt")
    val prepared = fixture.recovery(ops).prepare(target, "1".repeat(32))
    val staged = prepared.stagedPath.apply {
      writeText("candidate")
    }

    val outcome = fixture.publisher(ops).publish(
      staged,
      target,
      hash("candidate"),
      prepared.stagedIdentity,
      prepared.directoryIdentity,
      prepared.privateDirectoryIdentity,
    )

    assertEquals(ImmutableAttachmentPublishOutcome.PUBLISHED, outcome)
    assertEquals("candidate", target.readText())
    assertFalse(staged.exists())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun immutablePublisherPreservesPeerReplacementAtPrivateNamespaceRetirement() = withFixture { fixture ->
    val target = fixture.target("a.${hash("candidate")}.txt")
    val prepared = fixture.recovery(ops).prepare(target, "9".repeat(32))
    val staged = prepared.stagedPath.apply {
      writeText("candidate")
    }
    val privateDirectory = staged.parentFile!!
    val racingOps = object : AttachmentInstallerFileOps by ops {
      override fun retireEmptyDirectoryIfIdentity(
        directory: File,
        expectedIdentity: String,
        expectedParentIdentity: String,
      ): ImmutableAttachmentStageCleanupOutcome {
        Files.delete(directory.toPath())
        directory.writeText("peer")
        return ops.retireEmptyDirectoryIfIdentity(
          directory,
          expectedIdentity,
          expectedParentIdentity,
        )
      }
    }

    assertFailsWithMessage("changed before cleanup") {
      fixture.publisher(racingOps).publish(
        staged,
        target,
        hash("candidate"),
        prepared.stagedIdentity,
        prepared.directoryIdentity,
        prepared.privateDirectoryIdentity,
      )
    }

    assertEquals("candidate", target.readText())
    assertEquals("peer", privateDirectory.readText())
  }

  @Test
  fun immutablePublisherPreservesOwnedStageAndPeerTargetOnCollision() = withFixture { fixture ->
    val target = fixture.target("a.${hash("candidate")}.txt").apply { writeText("peer-corruption") }
    val prepared = fixture.recovery(ops).prepare(target, "2".repeat(32))
    val staged = prepared.stagedPath.apply {
      writeText("candidate")
    }

    val outcome = fixture.publisher(ops).publish(
      staged,
      target,
      hash("candidate"),
      prepared.stagedIdentity,
      prepared.directoryIdentity,
      prepared.privateDirectoryIdentity,
    )

    assertEquals(ImmutableAttachmentPublishOutcome.ALREADY_EXISTS, outcome)
    assertEquals("candidate", staged.readText())
    assertEquals("peer-corruption", target.readText())
    assertEquals(1, fixture.internalArtifacts().size)
  }

  @Test
  fun immutablePublisherRejectsPrivateStageNameSwapWithoutTouchingTarget() = withFixture { fixture ->
    val target = fixture.target("a.${hash("candidate")}.txt")
    val prepared = fixture.recovery(ops).prepare(target, "3".repeat(32))
    val staged = prepared.stagedPath.apply {
      writeText("candidate")
    }
    val displaced = File(staged.parentFile, "displaced-stage")
    val racingOps = object : AttachmentInstallerFileOps by ops {
      override fun publishVerifiedImmutable(
        source: File,
        destination: File,
        expectedSha256: String,
        expectedSourceIdentity: String,
        expectedDirectoryIdentity: String,
        expectedPrivateDirectoryIdentity: String,
      ): ImmutableAttachmentPublishOutcome {
        Files.move(source.toPath(), displaced.toPath())
        source.writeText("replacement")
        return ops.publishVerifiedImmutable(
          source,
          destination,
          expectedSha256,
          expectedSourceIdentity,
          expectedDirectoryIdentity,
          expectedPrivateDirectoryIdentity,
        )
      }
    }

    assertFailsWithMessage("identity changed") {
      fixture.publisher(racingOps).publish(
        staged,
        target,
        hash("candidate"),
        prepared.stagedIdentity,
        prepared.directoryIdentity,
        prepared.privateDirectoryIdentity,
      )
    }
    assertFalse(target.exists())
    assertEquals("candidate", displaced.readText())
    assertEquals("replacement", staged.readText())
  }

  @Test
  fun preparedPrivateStageRecoveryRemovesOnlyItsCreateNewInode() = withFixture { fixture ->
    val operationId = "4".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val prepared = recovery.prepare(target, operationId)
    prepared.stagedPath.writeText("partial")

    val outcome = recovery.cleanup(
      prepared.stagedPath,
      target,
      operationId,
      hash("candidate"),
      prepared.stagedIdentity,
      prepared.directoryIdentity,
      prepared.privateDirectoryIdentity,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.REMOVED, outcome)
    assertFalse(prepared.stagedPath.exists())
    assertFalse(prepared.stagedPath.parentFile!!.exists())
  }

  @Test
  fun missingPrivateStageRecoveryWaitsForDurableDirectoryRetirement() = withFixture { fixture ->
    val operationId = "5".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val prepared = recovery.prepare(target, operationId)
    val privateDirectory = prepared.stagedPath.parentFile!!
    Files.delete(prepared.stagedPath.toPath())
    Files.delete(privateDirectory.toPath())
    var retirementCalled = false
    val recoveryOps = object : AttachmentInstallerFileOps by ops {
      override fun retireEmptyDirectoryIfIdentity(
        directory: File,
        expectedIdentity: String,
        expectedParentIdentity: String,
      ): ImmutableAttachmentStageCleanupOutcome {
        assertEquals(privateDirectory, directory)
        assertEquals(prepared.privateDirectoryIdentity, expectedIdentity)
        assertEquals(prepared.directoryIdentity, expectedParentIdentity)
        retirementCalled = true
        return ImmutableAttachmentStageCleanupOutcome.REMOVED
      }
    }

    val outcome = fixture.recovery(recoveryOps).cleanup(
      prepared.stagedPath,
      target,
      operationId,
      hash("candidate"),
      prepared.stagedIdentity,
      prepared.directoryIdentity,
      prepared.privateDirectoryIdentity,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.REMOVED, outcome)
    assertTrue(retirementCalled)
  }

  @Test
  fun unpreparedPrivateStageReservationClearsWhenCandidateWasNeverCreated() = withFixture { fixture ->
    val operationId = "6".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val privateDirectory = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.candidate")
    val staged = File(privateDirectory, "stage")
    var reservedRetirementCalled = false
    val recoveryOps = object : AttachmentInstallerFileOps by ops {
      override fun retireReservedPrivateStage(
        directory: File,
      ): ImmutableAttachmentStageCleanupOutcome {
        reservedRetirementCalled = true
        return ops.retireReservedPrivateStage(directory)
      }
    }

    val outcome = fixture.recovery(recoveryOps).cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      null,
      null,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.MISSING, outcome)
    assertFalse(privateDirectory.exists())
    assertTrue(reservedRetirementCalled)
  }

  @Test
  fun unclaimedPrivateStageIsRecoveredFromItsDurableReservation() = withFixture { fixture ->
    val operationId = "7".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val prepared = fixture.recovery(ops).prepare(target, operationId)

    val outcome = fixture.recovery(ops).cleanup(
      prepared.stagedPath,
      target,
      operationId,
      hash("candidate"),
      null,
      null,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.REMOVED, outcome)
    assertFalse(prepared.stagedPath.exists())
    assertFalse(prepared.stagedPath.parentFile!!.exists())
  }

  @Test
  fun unclaimedPrivateRetirementIsRecoveredFromItsDurableReservation() = withFixture { fixture ->
    val operationId = "a".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val privateDirectory = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.candidate")
    val retirementQuarantine = fixture.target("${privateDirectory.name}$INSTALLER_RETIREMENT_SUFFIX").apply {
      mkdirs()
    }
    val staged = File(privateDirectory, "stage")
    var retirementAttempted = false
    val recoveryOps = object : AttachmentInstallerFileOps by ops {
      override fun retireReservedPrivateStage(
        directory: File,
      ): ImmutableAttachmentStageCleanupOutcome {
        assertEquals(privateDirectory, directory)
        retirementAttempted = true
        Files.delete(retirementQuarantine.toPath())
        syncDirectory(target.parentFile!!)
        return ImmutableAttachmentStageCleanupOutcome.REMOVED
      }
    }

    val outcome = fixture.recovery(recoveryOps).cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      null,
      null,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.REMOVED, outcome)
    assertTrue(retirementAttempted)
    assertFalse(privateDirectory.exists())
    assertFalse(retirementQuarantine.exists())
  }

  @Test
  fun unclaimedNonDirectoryRetirementIsPreserved() = withFixture { fixture ->
    val operationId = "b".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val privateDirectory = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.candidate")
    val retirementQuarantine = fixture.target("${privateDirectory.name}$INSTALLER_RETIREMENT_SUFFIX").apply {
      writeText("peer")
    }

    val outcome = fixture.recovery(ops).cleanup(
      File(privateDirectory, "stage"),
      target,
      operationId,
      hash("candidate"),
      null,
      null,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    assertEquals("peer", retirementQuarantine.readText())
  }

  @Test
  fun unclaimedNonDirectoryReservationIsPreserved() = withFixture { fixture ->
    val operationId = "8".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val privateDirectory = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.candidate").apply {
      writeText("peer")
    }
    val staged = File(privateDirectory, "stage")

    val outcome = fixture.recovery(ops).cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      null,
      null,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    assertEquals("peer", privateDirectory.readText())
  }

  @Test
  fun failedPrivateStagePreparationSyncsItsFinalParentNamespace() = withFixture { fixture ->
    val operationId = "9".repeat(32)
    val target = fixture.target("a.${hash("candidate")}.txt")
    val targetRoot = target.parentFile!!
    var targetRootSynced = false
    val failingOps = object : AttachmentInstallerFileOps by ops {
      override fun createNewRegularFile(file: File) {
        throw AttachmentInstallerFailure("injected stage creation failure")
      }

      override fun syncDirectory(directory: File) {
        if (directory == targetRoot) targetRootSynced = true
        ops.syncDirectory(directory)
      }
    }

    assertFailsWithMessage("injected stage creation failure") {
      fixture.recovery(failingOps).prepare(target, operationId)
    }

    assertTrue(targetRootSynced)
    assertFalse(fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.candidate").exists())
  }

  @Test
  fun ownedStageRecoveryDeletesOnlyTheRecordedInodeAndDigest() = withFixture { fixture ->
    val operationId = "a".repeat(32)
    val staged = fixture.target(".mindwtr-generation-stage-$operationId.tmp").apply {
      writeText("candidate")
    }
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val identity = recovery.snapshot(staged, target, hash("candidate"))

    val outcome = recovery.cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      identity.stagedIdentity,
      identity.directoryIdentity,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.REMOVED, outcome)
    assertFalse(staged.exists())
    assertTrue(fixture.internalArtifacts().isEmpty())
  }

  @Test
  fun ownedStageRecoveryPreservesAReplacementInodeEvenWithTheSameDigest() = withFixture { fixture ->
    val operationId = "b".repeat(32)
    val staged = fixture.target(".mindwtr-generation-stage-$operationId.tmp").apply {
      writeText("candidate")
    }
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val identity = recovery.snapshot(staged, target, hash("candidate"))
    Files.delete(staged.toPath())
    staged.writeText("candidate")

    val outcome = recovery.cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      identity.stagedIdentity,
      identity.directoryIdentity,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    val preserved = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.quarantine/stage")
    assertEquals("candidate", preserved.readText())
  }

  @Test
  fun ownedStageRecoveryPreservesBothSidesOfAPreexistingQuarantineAmbiguity() = withFixture { fixture ->
    val operationId = "c".repeat(32)
    val staged = fixture.target(".mindwtr-generation-stage-$operationId.tmp").apply {
      writeText("candidate")
    }
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val identity = recovery.snapshot(staged, target, hash("candidate"))
    val quarantine = fixture.target("$INSTALLER_ARTIFACT_PREFIX$operationId.quarantine").apply { mkdirs() }
    quarantine.resolve("stage").writeText("peer")

    val outcome = recovery.cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      identity.stagedIdentity,
      identity.directoryIdentity,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    assertEquals("candidate", staged.readText())
    assertEquals("peer", quarantine.resolve("stage").readText())
  }

  @Test
  fun ownedStageRecoveryRejectsAReplacedAttachmentRoot() = withFixture { fixture ->
    val operationId = "d".repeat(32)
    val staged = fixture.target(".mindwtr-generation-stage-$operationId.tmp").apply {
      writeText("candidate")
    }
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val identity = recovery.snapshot(staged, target, hash("candidate"))
    val originalRoot = fixture.replaceAttachmentsRoot()

    val outcome = recovery.cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      identity.stagedIdentity,
      identity.directoryIdentity,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    assertEquals("candidate", originalRoot.resolve(staged.name).readText())
    assertFalse(staged.exists())
  }

  @Test
  fun ownedStageRecoveryPreservesAReplacementDirectory() = withFixture { fixture ->
    val operationId = "e".repeat(32)
    val staged = fixture.target(".mindwtr-generation-stage-$operationId.tmp").apply {
      writeText("candidate")
    }
    val target = fixture.target("a.${hash("candidate")}.txt")
    val recovery = fixture.recovery(ops)
    val identity = recovery.snapshot(staged, target, hash("candidate"))
    Files.delete(staged.toPath())
    Files.createDirectory(staged.toPath())
    staged.resolve("peer").writeText("peer")

    val outcome = recovery.cleanup(
      staged,
      target,
      operationId,
      hash("candidate"),
      identity.stagedIdentity,
      identity.directoryIdentity,
      null,
    )

    assertEquals(ImmutableAttachmentStageCleanupOutcome.CONFLICT, outcome)
    assertEquals("peer", staged.resolve("peer").readText())
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

    fun hasher(ops: AttachmentInstallerFileOps) = AttachmentFileHasherCore(
      targetRoot = attachments,
      ops = ops,
    )

    fun publisher(ops: AttachmentInstallerFileOps) = ImmutableAttachmentFilePublisherCore(
      targetRoot = attachments,
      ops = ops,
    )

    fun recovery(ops: AttachmentInstallerFileOps) = ImmutableAttachmentStageRecoveryCore(
      targetRoot = attachments,
      ops = ops,
    )

    fun stage(content: String): File = cache.resolve("stage-${System.nanoTime()}.bin").apply {
      writeText(content)
    }

    fun target(name: String): File = attachments.resolve(name)

    fun replaceAttachmentsRoot(): File {
      val original = root.resolve("original-attachments")
      Files.move(attachments.toPath(), original.toPath())
      Files.createDirectories(attachments.toPath())
      return original
    }

    fun activeArtifact(suffix: String): File {
      val journal = internalArtifacts().single { it.name.endsWith(".journal") }
      return attachments.resolve(journal.name.removeSuffix(".journal") + suffix)
    }

    fun internalArtifacts(): List<File> = attachments.listFiles()
      .orEmpty()
      .filter { it.name.startsWith(INSTALLER_ARTIFACT_PREFIX) }

    fun preservedArtifacts(): List<File> = attachments.listFiles()
      .orEmpty()
      .filter { it.name.startsWith(INSTALLER_PRESERVED_PREFIX) }
  }
}
