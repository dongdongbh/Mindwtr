package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Date


class RecoverySnapshotsTest {
    @get:Rule val folder = TemporaryFolder()
    private val dir get() = File(folder.root, "snapshots")
    private val noSync: (File) -> Unit = {}
    private fun names() = dir.listFiles().orEmpty().map { it.name }.sorted()
    private val at = Date(1786278845123L)

    @Test fun namesAnInstantAsRnDoes() {
        assertEquals("data.2026-08-09T12-34-05.123.snapshot.json", RecoverySnapshots.name(at))
        assertEquals("data.2026-08-09T12-34-05.123.2.snapshot.json", RecoverySnapshots.name(at, 2))
        assertFalse(RecoverySnapshots.isName("data.pending.snapshot.tmp"))
    }

    @Test fun twoWritesAtOneInstantKeepBoth() {
        val first = RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = noSync)
        val second = RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = noSync)
        assertEquals("data.2026-08-09T12-34-05.123.snapshot.json", first)
        assertEquals("data.2026-08-09T12-34-05.123.1.snapshot.json", second)
        assertEquals(listOf(second, first), RecoverySnapshots.list(dir))
        assertEquals("data.2026-08-09T12-34-05.123.2.snapshot.json", RecoverySnapshots.nextName(dir, at))
    }

    @Test fun anExactWriteRefusesATakenName() {
        val name = RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = noSync)
        val refused = runCatching { RecoverySnapshots.write(dir, name, "{\"x\":1}", exact = true, syncDirectory = noSync) }
        assertTrue(refused.isFailure)
        assertEquals("{}", File(dir, name).readText())
    }

    @Test fun theHundredAndFirstClashThrowsAndWritesNothing() {
        dir.mkdirs()
        File(dir, RecoverySnapshots.name(at)).writeText("{}")
        for (clash in 1..100) File(dir, RecoverySnapshots.name(at, clash)).writeText("{}")
        val before = names()
        assertTrue(runCatching { RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = noSync) }.isFailure)
        assertEquals(before, names())
    }

    @Test fun aFailedWriteLeavesNoRestorePointAndPrunesNothing() {
        dir.mkdirs()
        val existing = (1..6).map { "data.2026-08-0${it}T00-00-00.000.snapshot.json" }.onEach { File(dir, it).writeText("{}") }
        val failed = runCatching { RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = { error("disk full") }) }
        assertTrue(failed.isFailure)

        assertFalse(File(dir, "data.pending.snapshot.tmp").exists())
        assertTrue(names().containsAll(existing))
    }

    @Test fun onlyTheFiveNewestStay() {
        dir.mkdirs()
        (1..6).forEach { File(dir, "data.2026-08-0${it}T00-00-00.000.snapshot.json").writeText("{}") }
        RecoverySnapshots.write(dir, "data.2026-08-07T00-00-00.000.snapshot.json", "{}", syncDirectory = noSync)
        assertEquals((3..7).map { "data.2026-08-0${it}T00-00-00.000.snapshot.json" }, names())
    }

    @Test fun aSnapshotWrittenAfterTheClockWentBackSurvivesItsOwnPrune() {
        dir.mkdirs()
        val future = (1..5).map { "data.2027-01-0${it}T00-00-00.000.snapshot.json" }.onEach { File(dir, it).writeText("{}") }
        val written = RecoverySnapshots.write(dir, RecoverySnapshots.name(at), "{}", syncDirectory = noSync)
        assertTrue(File(dir, written).isFile)
        assertEquals(5, names().size)
        assertFalse(File(dir, future[0]).exists())
    }

    @Test fun aProtectedNameIsNeverPruned() {
        dir.mkdirs()
        val old = "data.2020-01-01T00-00-00.000.snapshot.json"
        File(dir, old).writeText("{}")
        (1..6).forEach { File(dir, "data.2026-08-0${it}T00-00-00.000.snapshot.json").writeText("{}") }
        RecoverySnapshots.prune(dir) { setOf(old) }
        assertTrue(File(dir, old).isFile)
        assertEquals(5, names().size)
    }


    @Test fun twoWritersNeverShareThePendingFile() {
        val name = RecoverySnapshots.name(at)
        var other: Thread? = null
        RecoverySnapshots.write(dir, name, "backup", exact = true, syncDirectory = noSync, beforePublish = {
            other = Thread { RecoverySnapshots.write(dir, name, "capture", syncDirectory = noSync) }.apply { start() }
            other!!.join(300)
        })
        other!!.join(2_000)
        assertEquals("backup", File(dir, name).readText())
        assertEquals("capture", File(dir, RecoverySnapshots.name(at, 1)).readText())
    }


    @Test fun aPendingSnapshotThatChangedIsNeverPublished() {
        dir.mkdirs()
        val name = RecoverySnapshots.name(at)
        val pending = File(dir, ".11111111-1111-4111-8111-111111111111.recovery.pending").apply { writeText("{\"x\":2}") }
        val sha = BackupOperations.sha256("{\"x\":1}".toByteArray())
        assertTrue(runCatching { RecoverySnapshots.publish(dir, pending, name, 7, sha, syncDirectory = noSync) }.isFailure)
        assertFalse(File(dir, name).exists())
        assertFalse(pending.exists())
        File(dir, name).writeText("{}")
        val again = File(dir, ".22222222-2222-4222-8222-222222222222.recovery.pending").apply { writeText("{\"x\":1}") }
        assertTrue(runCatching { RecoverySnapshots.publish(dir, again, name, 7, sha, syncDirectory = noSync) }.isFailure)
        assertEquals("{}", File(dir, name).readText())
    }
}
