package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.dongdongbh.mindwtr.pilot.core.BackupOperations
import tech.dongdongbh.mindwtr.pilot.core.WriteJournal
import java.io.File


class WorkspaceTest {
    @get:Rule val folder = TemporaryFolder()

    private class Store(var value: String?, val writable: Boolean = true) : Workspace.RequestStore {
        override fun read() = value
        override fun write(value: String?): Boolean { if (writable) this.value = value; return writable }
    }


    private fun request(ageMs: Long) = """{"version":1,"requestedAt":${System.currentTimeMillis() - ageMs},"settings":{}}"""


    @Test fun aBootRequestIsConsumedOnceSoALaterLaunchBootsPersonal() {
        val raw = request(1_000)
        val store = Store(raw)
        assertEquals(raw, Workspace.take(store))
        assertNull(Workspace.take(store))
        assertNull(Workspace.take(Store(null)))
    }


    @Test fun aStaleMalformedOrUnconsumableRequestBootsPersonalWithoutCrashing() {
        val reasons = mutableListOf<String>()
        val stale = Store(request(61_000))
        assertNull(Workspace.take(stale, refused = { reasons += it }))
        assertNull(stale.value)
        assertNull(Workspace.take(Store("{"), refused = { reasons += it }))
        assertNull(Workspace.take(Store(request(1_000), writable = false), refused = { reasons += it }))
        assertEquals(listOf("stale", "stale", "unconsumed"), reasons)
    }


    @Test fun aRequestFoundAfterAWorkerBootedThePersonalWorkspaceRestartsTheProcessNeverSwitchesIt() {
        var restarts = 0
        var entered = false
        val raw = request(1_000)
        val fresh = Store(raw)
        assertNull(Workspace.decide(fresh, booted = true, begin = { true }, restart = { restarts += 1 }, enter = { entered = true }))
        assertEquals(raw, fresh.value)
        assertEquals(1, restarts)
        assertFalse(entered)

        assertNull(Workspace.decide(Store(request(61_000)), booted = true, begin = { true }, restart = { restarts += 1 }, enter = { entered = true }))
        assertEquals(1, restarts)
    }


    @Test fun aScreenThatDecidedTheSandboxButGotTheWorkersPersonalRuntimePutsTheRequestBackAndRestarts() {
        var restarts = 0
        val raw = request(1_000)
        val store = Store(null)
        assertFalse(Workspace.settled(store, raw, sandboxed = true, runtimeSandbox = false, restart = { restarts += 1 }))
        assertEquals(raw, store.value)
        assertEquals(1, restarts)

        val stale = Store(null)
        assertFalse(Workspace.settled(stale, request(61_000), sandboxed = true, runtimeSandbox = false, restart = { restarts += 1 }))
        assertNull(stale.value)
        assertEquals(2, restarts)

        assertTrue(Workspace.settled(Store(null), raw, sandboxed = true, runtimeSandbox = true, restart = { restarts += 1 }))
        assertTrue(Workspace.settled(Store(null), null, sandboxed = false, runtimeSandbox = false, restart = { restarts += 1 }))
        assertEquals(2, restarts)
    }


    @Test fun savedScreenStateFromTheOtherWorkspaceIsNotRestored() {
        assertTrue(Workspace.savedStateFits(null, sandbox = false))
        assertFalse(Workspace.savedStateFits(null, sandbox = true))
        assertTrue(Workspace.savedStateFits(Workspace.marker(false), sandbox = false))
        assertFalse(Workspace.savedStateFits(Workspace.marker(true), sandbox = false))
        assertTrue(Workspace.savedStateFits(Workspace.marker(true), sandbox = true))
        assertFalse(Workspace.savedStateFits(Workspace.marker(false), sandbox = true))
    }


    @Test fun theSandboxIsEnteredOnlyWhenItsScratchFolderIsReady() {
        var entered = false
        assertNull(Workspace.decide(Store(request(1_000)), booted = false, begin = { false }, restart = {}, enter = { entered = true }))
        assertFalse(entered)
        val raw = request(1_000)
        assertEquals(raw, Workspace.decide(Store(raw), booted = false, begin = { true }, restart = {}, enter = { entered = true }))
        assertTrue(entered)
    }


    @Test fun theSandboxViewStateLivesInItsOwnPreferencesFile() {
        assertEquals(DEVICE_PREFS, Workspace.prefsName(sandbox = false))
        assertEquals(Workspace.SANDBOX_VIEW_PREFS, Workspace.prefsName(sandbox = true))
        assertTrue(Workspace.prefsName(sandbox = true) != Workspace.prefsName(sandbox = false))
    }


    @Test fun aSandboxBootLeavesARealPendingBackupOperationAlone() {
        val noBackup = File(folder.root, "no_backup")
        val realOperation = File(Workspace.dir(noBackup, "backup-operations", sandbox = false), "op-1").apply { mkdirs() }
        val realPending = File(Workspace.dir(noBackup, "backup-operations", sandbox = false), "op-2.pending").apply { writeText("{}") }
        BackupOperations(Workspace.dir(noBackup, "backup-operations", sandbox = true).apply { mkdirs() },
            Workspace.dir(noBackup, "snapshots", sandbox = true).apply { mkdirs() }, syncDirectory = {}).cleanup(emptySet())
        assertTrue(realOperation.isDirectory)
        assertTrue(realPending.exists())
    }


    @Test fun aSandboxCaptureDraftNeverReachesTheRealCaptureStore() {
        val noBackup = File(folder.root, "no_backup")
        CaptureStore(Workspace.dir(noBackup, "capture", sandbox = true)).write(org.json.JSONObject().put("text", "Sample capture"))
        assertTrue(File(Workspace.dir(noBackup, "capture", sandbox = true), "capture").exists())
        assertNull(CaptureStore(Workspace.dir(noBackup, "capture", sandbox = false)).read())
        assertFalse(File(Workspace.dir(noBackup, "capture", sandbox = false), "capture").exists())
    }


    @Test fun theSandboxNeverSharesAFileWithTheRealWorkspace() {
        val root = folder.root
        val scratch = File(root, "no_backup/sandbox")
        val real = Workspace.files(File(root, "files/mindwtr.db"), File(root, "files/journal"), File(root, "databases/RKStorage"), scratch, sandbox = false)
        val sandbox = Workspace.files(File(root, "files/mindwtr.db"), File(root, "files/journal"), File(root, "databases/RKStorage"), scratch, sandbox = true)
        assertEquals(Workspace.Files(File(root, "files/mindwtr.db"), File(root, "files/journal"), File(root, "databases/RKStorage")), real)
        for (file in listOf(sandbox.database, sandbox.journal, sandbox.keyValue)) {
            assertTrue(file.canonicalPath.startsWith(scratch.canonicalPath + File.separator))
            assertFalse(file in listOf(real.database, real.journal, real.keyValue))
        }
    }


    @Test fun aJournalEntryWrittenInTheSandboxCanNeverReachTheRealDatabase() {
        val root = folder.root
        val scratch = File(root, "no_backup/sandbox")
        val sandbox = Workspace.files(File(root, "files/mindwtr.db"), File(root, "files/journal"), File(root, "databases/RKStorage"), scratch, sandbox = true)
        val real = Workspace.files(File(root, "files/mindwtr.db"), File(root, "files/journal"), File(root, "databases/RKStorage"), scratch, sandbox = false)
        WriteJournal(sandbox.journal, syncDirectory = {}).append("complete", listOf("sample-task", "3:dev:2026"))
        assertEquals(1, WriteJournal(sandbox.journal, syncDirectory = {}).pending().size)

        assertTrue(scratch.deleteRecursively())
        assertFalse(sandbox.journal.exists())
        assertTrue(WriteJournal(real.journal, syncDirectory = {}).pending().isEmpty())
    }


    @Test fun aSandboxBootResetsOnlyItsOwnBootFilesAndKeepsItsDrafts() {
        val scratch = File(folder.root, "no_backup/sandbox")
        val drafts = File(scratch, "editor/draft.json").apply { parentFile.mkdirs(); writeText("{}") }
        for (name in listOf("sandbox.db", "sandbox.db-wal", "RKStorage")) File(scratch, name).writeText("old")
        File(scratch, "journal").mkdirs()
        assertTrue(Workspace.freshBootFiles(scratch))
        assertTrue(drafts.exists())
        for (name in listOf("sandbox.db", "sandbox.db-wal", "RKStorage", "journal")) assertFalse(File(scratch, name).exists())
    }


    @Test fun theSandboxArmsNoAlarmAndReportsNothingFired() {
        assertEquals(0, SandboxReminders.apply("""{"schedule":[{"id":1}],"cancel":[2]}"""))
        assertFalse(SandboxReminders.permissionGranted())
        assertEquals(0, SandboxReminders.cleanupRn())
        assertEquals("""{"dropped":0,"notQueued":0}""", SandboxReminders.receiverCounts())
        assertEquals("""{"fired":[],"shown":[]}""", SandboxReminders.ledger())
    }
}

