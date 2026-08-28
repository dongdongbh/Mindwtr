package tech.dongdongbh.mindwtr.syncfilelock

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SyncFileLockModuleTest {
  @Test
  fun teardownReleasesEveryHandleAndAllowsReacquisition() {
    val lockPath = Files.createTempFile("mindwtr-lock", ".tmp").toFile()
    val owner = RandomAccessFile(lockPath, "rw")
    val held = HeldSyncFileLock(owner.channel.lock(), owner.channel, owner)
    val heldLocks = mutableMapOf("renderer-token" to held)

    val errors = drainHeldSyncFileLocks(heldLocks)

    assertTrue(errors.isEmpty())
    assertTrue(heldLocks.isEmpty())
    RandomAccessFile(lockPath, "rw").use { replacement ->
      replacement.channel.tryLock().use { reacquired ->
        assertNotNull("teardown must release the OS-level lock", reacquired)
      }
    }
  }

  @Test
  fun firstUseRaceDeletesOnlyItsOwnCreationAndKeepsThePeerLockable() {
    val documents = mutableListOf<String>()
    val deleted = mutableListOf<String>()
    var creates = 0

    val selected = resolveExactLockDocument(
      listExactDocuments = { documents.toList() },
      createDocument = {
        creates += 1
        documents += "peer-uri"
        documents += "our-uri"
        CreatedLockDocument("our-uri", ".mindwtr.lock")
      },
      deleteOwnedDocument = { uri ->
        deleted += uri
        documents.remove(uri)
      },
    )

    assertEquals("peer-uri", selected)
    assertEquals(listOf("our-uri"), deleted)
    assertEquals(listOf("peer-uri"), documents)
    assertEquals(1, creates)

    val subsequent = resolveExactLockDocument(
      listExactDocuments = { documents.toList() },
      createDocument = {
        fail("a subsequent acquisition must reuse the surviving exact lock")
        CreatedLockDocument("unreachable", null)
      },
      deleteOwnedDocument = {
        fail("a subsequent acquisition must never delete the peer lock")
        false
      },
    )
    assertEquals("peer-uri", subsequent)
  }

  @Test
  fun rewrittenNameIsRemovedBeforeBoundedRetry() {
    val deleted = mutableListOf<String>()
    var creates = 0

    val selected = resolveExactLockDocument(
      listExactDocuments = { if (creates >= 2) listOf("second-uri") else emptyList() },
      createDocument = {
        creates += 1
        if (creates == 1) {
          CreatedLockDocument("wrong-uri", ".mindwtr.lock (1)")
        } else {
          CreatedLockDocument("second-uri", ".mindwtr.lock")
        }
      },
      deleteOwnedDocument = { uri -> deleted.add(uri) },
    )

    assertEquals("second-uri", selected)
    assertEquals(listOf("wrong-uri"), deleted)
    assertEquals(2, creates)
  }

  @Test
  fun stalePostDeleteInventoryNeverReturnsTheDeletedCreation() {
    var creates = 0
    var inventoryReads = 0
    val deleted = mutableListOf<String>()

    try {
      resolveExactLockDocument(
        listExactDocuments = {
          inventoryReads += 1
          when {
            creates == 0 -> emptyList()
            inventoryReads % 2 == 0 -> listOf("our-$creates", "transient-peer-$creates")
            else -> listOf("our-$creates")
          }
        },
        createDocument = {
          creates += 1
          CreatedLockDocument("our-$creates", ".mindwtr.lock")
        },
        deleteOwnedDocument = { uri -> deleted.add(uri) },
        maxCreateAttempts = 2,
      )
      fail("a stale listing of a deleted creation must not be returned")
    } catch (error: SyncFileLockUnavailableException) {
      assertTrue(error.message.orEmpty().contains("did not create"))
    }

    assertEquals(listOf("our-1", "our-2"), deleted)
  }

  @Test
  fun preexistingAmbiguityNeverDeletesUnownedDocuments() {
    var deleted = false
    try {
      resolveExactLockDocument(
        listExactDocuments = { listOf("peer-a", "peer-b") },
        createDocument = {
          fail("ambiguous inventory must not create another document")
          CreatedLockDocument("unreachable", null)
        },
        deleteOwnedDocument = {
          deleted = true
          true
        },
      )
      fail("ambiguous inventory must fail closed")
    } catch (error: SyncFileLockUnavailableException) {
      assertTrue(error.message.orEmpty().contains("ambiguous"))
    }
    assertTrue(!deleted)
  }

  @Test
  fun safUsesPrivateStableAuthorityWithoutOpeningProviderDirectory() {
    var providerDirectoryOpened = false
    var privateAuthorityOpened = false
    val authorityPath = Files.createTempFile("mindwtr-private-saf", ".lock").toFile()

    val authority = selectStableSyncAuthority(
      saf = true,
      acquirePathRoot = {
        providerDirectoryOpened = true
        fail("SAF must not depend on a provider directory descriptor")
        acquirePrivateFileStableAuthority(authorityPath)
      },
      acquirePrivateSaf = {
        privateAuthorityOpened = true
        acquirePrivateFileStableAuthority(authorityPath)
      },
    )

    assertTrue(privateAuthorityOpened)
    assertTrue(!providerDirectoryOpened)
    authority.close()
  }

  @Test
  fun replacedLegacyLockCannotCreateSecondCurrentVersionOwner() {
    val directory = Files.createTempDirectory("mindwtr-stable-authority").toFile()
    val authorityPath = File(directory, "private-authority.lock")
    val legacyPath = File(directory, ".mindwtr.lock")
    legacyPath.writeText("first")
    val first = acquirePrivateFileStableAuthority(authorityPath)

    legacyPath.renameTo(File(directory, ".mindwtr.lock.displaced"))
    legacyPath.writeText("replacement")
    try {
      acquirePrivateFileStableAuthority(authorityPath)
      fail("stable authority must reject a second owner after legacy replacement")
    } catch (error: SyncFileLockUnavailableException) {
      assertTrue(error.message.orEmpty().contains("BUSY"))
    }

    first.close()
    acquirePrivateFileStableAuthority(authorityPath).close()
  }
}
