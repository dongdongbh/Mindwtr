package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.dongdongbh.mindwtr.pilot.core.WriteJournal
import java.io.File


class WorkspaceTest {
    @get:Rule val folder = TemporaryFolder()

    private class Store(var value: String?, val writable: Boolean = true) : Workspace.RequestStore {
        override fun read() = value
        override fun write(value: String?): Boolean { if (writable) this.value = value; return writable }
    }


    @Test fun aBootRequestIsConsumedOnceSoALaterLaunchBootsPersonal() {
        val store = Store("{\"version\":1}")
        assertEquals("{\"version\":1}", Workspace.take(store))
        assertNull(Workspace.take(store))
        assertNull(Workspace.take(Store(null)))
    }


    @Test fun aRequestThatCannotBeConsumedNeverOpensTheSandbox() {
        assertThrows(IllegalStateException::class.java) { Workspace.take(Store("{}", writable = false)) }
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

