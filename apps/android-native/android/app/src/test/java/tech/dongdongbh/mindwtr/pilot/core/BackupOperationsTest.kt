package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Pass D1a's operation files (design §4.2-4.3): publish, the identity check before every send, cleanup, protection, the result record. */
class BackupOperationsTest {
    @get:Rule val folder = TemporaryFolder()
    private val snapshots get() = File(folder.root, "snapshots").apply { mkdirs() }
    private fun ops(maxPlanBytes: Long = Long.MAX_VALUE) = BackupOperations(File(folder.root, "ops"), snapshots, syncDirectory = {}, maxPlanBytes = maxPlanBytes)
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    private val name = "data.2026-08-09T12-34-05.123.snapshot.json"
    private val TASKS = "{\"tasks\":[]}"
    private fun snapshot(text: String = TASKS) = File(snapshots, name).apply { writeText(text) }

    private fun refused(work: () -> Unit) = runCatching(work).exceptionOrNull() is BackupOperations.Mismatch
    private fun closed(text: String) = text.toByteArray().let { DataChannel.Closed(it.size.toLong(), BackupOperations.sha256(it)) }

    /** The production publish after core wrote [planJson] through the channel; [recovery] is the text this operation published. */
    private fun BackupOperations.publishText(id: String, mode: String, planJson: String, snapshotName: String, recovery: String?, beforeManifest: () -> Unit = {}): String {
        pendingPlan(id).writeText(planJson)
        return publish(id, mode, closed(planJson), snapshotName, recovery?.let(::closed), beforeManifest = beforeManifest)
    }
    private fun BackupOperations.planText(reference: String, snapshotName: String): String = plan(reference, snapshotName).let { (file, sha) ->
        assertEquals(BackupOperations.sha256(file), sha)
        file.readText()
    }

    @Test fun aPublishedPlanReadsBackExactly() {
        snapshot()
        val ref = ops().publishText(a, "merge", "{\"plan\":1}", name, recovery = TASKS)
        assertEquals("{\"plan\":1}", ops().planText(ref, name))
        assertEquals("merge", ops().mode(ref))
        assertTrue(JSONObject(ref).getInt("byteCount") <= 8192)
    }

    // D1b: an import's plan can grow far past its file; one over the read-back limit is refused before anything is written, so the
    // journal never gets an entry its identity check would set aside, and an import's mode publishes like a merge's.
    @Test fun aPlanOverTheLimitIsRefusedBeforeAnyFile() {
        snapshot()
        val failure = runCatching { ops(maxPlanBytes = 8).publishText(a, "todoist", "{\"plan\":\"too long\"}", name, recovery = TASKS) }.exceptionOrNull()
        assertTrue(failure is BackupOperations.PlanTooLarge)
        assertFalse(File(folder.root, "ops/$a/plan.json").exists())
        assertFalse(File(folder.root, "ops/$a/plan.json.pending").exists())
        assertFalse(File(folder.root, "ops/$a/manifest.json").exists())
        val ref = ops(maxPlanBytes = 64).publishText(a, "todoist", "{\"plan\":1}", name, recovery = TASKS)
        assertEquals("todoist", ops().mode(ref))
    }

    @Test fun swappedManifestsOrPlansAreRefused() {
        snapshot()
        val refA = ops().publishText(a, "merge", "{\"plan\":\"a\"}", name, recovery = TASKS)
        val refB = ops().publishText(b, "merge", "{\"plan\":\"b\"}", name, recovery = TASKS)
        val root = File(folder.root, "ops")
        // B's plan under A: A's manifest no longer matches its plan.
        File(root, "$b/plan.json").copyTo(File(root, "$a/plan.json"), overwrite = true)
        assertTrue(refused { ops().plan(refA, name) })
        // B's manifest under A: A's reference no longer matches its manifest.
        File(root, "$b/manifest.json").copyTo(File(root, "$a/manifest.json"), overwrite = true)
        assertTrue(refused { ops().plan(refA, name) })
        assertEquals("{\"plan\":\"b\"}", ops().planText(refB, name))
        // Another snapshot name than the journal's.
        assertTrue(refused { ops().plan(refB, "data.2026-08-09T12-34-06.000.snapshot.json") })
    }

    @Test fun aMissingOrTornPlanAndAChangedSnapshotAreRefused() {
        snapshot()
        val ref = ops().publishText(a, "replace", "{\"plan\":1}", name, recovery = TASKS)
        File(snapshots, name).writeText("{\"tasks\":[1]}")
        assertTrue(refused { ops().plan(ref, name) })
        snapshot()
        assertEquals("{\"plan\":1}", ops().planText(ref, name))
        File(folder.root, "ops/$a/plan.json").delete()
        assertTrue(refused { ops().plan(ref, name) })
        // A death mid-publish: the plan's pending file is there, the manifest never was.
        val torn = runCatching { ops().publishText(b, "merge", "{\"plan\":2}", name, recovery = null) { error("killed") } }
        assertTrue(torn.isFailure)
        assertTrue(refused { ops().plan(JSONObject().put("id", b).put("sha256", "0".repeat(64)).put("byteCount", 10).toString(), name) })
    }

    @Test fun aRestoreReadsAnExistingSnapshotWithoutCheckingItsBytes() {
        val ref = ops().publishText(a, "restore", "{\"plan\":1}", name, recovery = null)
        assertEquals("{\"plan\":1}", ops().planText(ref, name))
    }

    // D1c code review P2: a plan admitted when it was published (here under a raised limit) is replayed after the limit fell:
    // the size cap is admission's, before the journal; a replay checks only the manifest's size and hashes.
    @Test fun aJournaledPlanIsReadWhateverTodaysLimit() {
        val ref = ops().publishText(a, "merge", "x".repeat(100), name, recovery = null)
        assertEquals("x".repeat(100), ops(maxPlanBytes = 50).planText(ref, name))
    }

    @Test fun cleanupKeepsOnlyTheJournalsOperations() {
        snapshot()
        ops().publishText(a, "merge", "{}", name, recovery = TASKS)
        ops().publishText(b, "merge", "{}", name, recovery = null)
        ops().cleanup(setOf(b))
        assertFalse(File(folder.root, "ops/$a").exists())
        assertTrue(File(folder.root, "ops/$b/manifest.json").isFile)
    }

    @Test fun openOperationsAndTheResultProtectTheirSnapshots() {
        ops().publishText(a, "merge", "{}", name, recovery = null)
        val undo = "data.2026-08-09T12-34-06.000.snapshot.json"
        ops().writeResult(JSONObject().put("requestId", b).put("outcome", "committed").put("undoSnapshot", undo))
        assertEquals(setOf(name, undo), ops().protectedNames())
        ops().discard(a)
        assertEquals(setOf(undo), ops().protectedNames())
    }

    @Test fun theResultRecordGoesOnlyForItsOwnRequest() {
        ops().writeResult(JSONObject().put("requestId", a).put("outcome", "committed"))
        ops().clearResult(b)
        assertEquals(a, ops().result()!!.getString("requestId"))
        ops().clearResult(a)
        assertNull(ops().result())
    }

    // D1a review P1-1: another writer replaced the snapshot between this operation's write and its plan; nothing is published.
    @Test fun aSnapshotThatIsNotTheOperationsOwnTextIsNeverPublished() {
        snapshot("")
        assertTrue(refused { ops().publishText(a, "merge", "{\"plan\":1}", name, recovery = TASKS) })
        assertFalse(File(folder.root, "ops/$a/manifest.json").exists())
        File(snapshots, name).delete()
        assertTrue(refused { ops().publishText(b, "merge", "{\"plan\":1}", name, recovery = TASKS) })
    }

    // D1a review P2-6: A's clear checked its record, then B's operation wrote its own; A's delete must not take B's.
    @Test fun clearingOneResultNeverDeletesANewerOneWrittenMeanwhile() {
        ops().writeResult(JSONObject().put("requestId", a).put("outcome", "committed"))
        val checked = java.util.concurrent.CountDownLatch(1)
        val resume = java.util.concurrent.CountDownLatch(1)
        BackupOperations.clearPause = { checked.countDown(); resume.await(2, java.util.concurrent.TimeUnit.SECONDS) }
        try {
            val clearing = Thread { ops().clearResult(a) }.apply { start() }
            assertTrue(checked.await(2, java.util.concurrent.TimeUnit.SECONDS))
            val writing = Thread { ops().writeResult(JSONObject().put("requestId", b).put("outcome", "committed")) }.apply { start() }
            writing.join(300)
            resume.countDown()
            clearing.join(2_000)
            writing.join(2_000)
        } finally {
            BackupOperations.clearPause = {}
        }
        assertEquals(b, ops().result()?.getString("requestId"))
    }

    // Pass D1c §3.2: the plan core wrote through the channel is renamed only when the file on disk is the bytes the channel counted.
    @Test fun aPendingPlanThatIsNotTheChannelsBytesIsNeverPublished() {
        ops().pendingPlan(a).writeText("{\"plan\":2}")
        assertTrue(refused { ops().publish(a, "merge", closed("{\"plan\":1}"), name, recovery = null) })
        assertFalse(File(folder.root, "ops/$a/plan.json").exists())
        assertFalse(File(folder.root, "ops/$a/manifest.json").exists())
    }

    // Pass D1c review 2 #7: a reserved name is protected before its snapshot is published, through a capture's prune after a
    // clock rollback (five future-dated snapshots outrank it), until the operation's folder goes.
    @Test fun aReservedSnapshotSurvivesACapturesPruneBeforeItsManifestExists() {
        (1..5).forEach { File(snapshots, "data.2030-01-0${it}T00-00-00.000.snapshot.json").writeText("{}") }
        ops().reserve(a, name)
        val pending = ops().pendingSnapshot(a).apply { writeText(TASKS) }
        RecoverySnapshots.publish(snapshots, pending, name, TASKS.length.toLong(), BackupOperations.sha256(TASKS.toByteArray()), syncDirectory = {})
        // The capture popup's snapshot write prunes while this operation has no manifest yet.
        RecoverySnapshots.write(snapshots, "data.2026-08-09T12-35-00.000.snapshot.json", "{}", ops()::protectedNames, syncDirectory = {})
        assertTrue(File(snapshots, name).isFile)
        assertTrue(name in ops().protectedNames())
        ops().discard(a)
        assertFalse(name in ops().protectedNames())
    }

    // Pass D1c §4: a recovery snapshot core was writing when the process died goes at the next start, unless its operation is open.
    @Test fun cleanupDeletesUnpublishedRecoverySnapshotsOfClosedOperations() {
        val open = ops().pendingSnapshot(a).apply { writeText("{") }
        val dead = ops().pendingSnapshot(b).apply { writeText("{") }
        ops().cleanup(setOf(a))
        assertTrue(open.isFile)
        assertFalse(dead.exists())
        assertFalse(RecoverySnapshots.isName(open.name))
    }

    private val mib = 1024L * 1024

    // Pass D1c §3.4: one budget, growing with every started MiB.
    @Test fun theBudgetGrowsWithEachStartedMiB() {
        val budget = BackupBudget(baseMs = 120_000, msPerMiB = 10_000)
        assertEquals(120_000L, budget.ms(0))
        assertEquals(130_000L, budget.ms(1))
        assertEquals(130_000L, budget.ms(mib))
        assertEquals(140_000L, budget.ms(mib + 1))
    }

    // Pass D1c review 3 #16: S 1, L 40, plan 80 MiB at 10 s/MiB is 120 + 10 × 121 = 1,330 s, past the 900 s ceiling: refused at
    // publish, so no manifest (and so no journal entry) exists to replay.
    @Test fun anOperationPastTheCeilingIsRefusedBeforeItsManifest() {
        val budget = BackupBudget(baseMs = 120_000, msPerMiB = 10_000)
        assertEquals(1_330_000L, budget.ms(121 * mib))
        val plan = "{\"plan\":1}"
        ops().pendingPlan(a).writeText(plan)
        val failure = runCatching { ops().publish(a, "merge", closed(plan), name, recovery = null, budgetMs = budget.ms(121 * mib)) }.exceptionOrNull()
        assertTrue(failure is BackupOperations.BudgetTooLarge)
        assertFalse(File(folder.root, "ops/$a/manifest.json").exists())
        assertFalse(File(folder.root, "ops/$a/plan.json").exists())
    }

    // Pass D1c review 3 #11/#16: S 1, L 10, plan 20 MiB at 10 s/MiB is 430 s, frozen into the manifest. A replay after the rate
    // changes to 2 s/MiB (a recompute would give 182 s) still gets 430 s; a D1a manifest gets the budget over twice its plan.
    @Test fun aReplayKeepsTheBudgetFrozenInItsManifest() {
        val frozen = BackupBudget(baseMs = 120_000, msPerMiB = 10_000).ms(31 * mib)
        assertEquals(430_000L, frozen)
        val plan = "{\"plan\":1}"
        ops().pendingPlan(a).writeText(plan)
        val ref = ops().publish(a, "merge", closed(plan), name, recovery = null, budgetMs = frozen)
        val later = BackupBudget(baseMs = 120_000, msPerMiB = 2_000)
        assertEquals(182_000L, later.ms(31 * mib))
        assertEquals(430_000L, ops().budgetMs(ref, later))
        val old = ops().publishText(b, "merge", plan, name, recovery = null)
        assertEquals(later.ms(2L * plan.length), ops().budgetMs(old, later))
        assertNull(ops().budgetMs("{\"id\":\"$b\",\"sha256\":\"${"0".repeat(64)}\",\"byteCount\":3}", later))
    }

    // Pass D1c review 3 #11: a boot sizes its budget by the database and its write-ahead log, a log larger than the file too.
    @Test fun theLibrarySizeCountsTheWriteAheadLog() {
        val db = File(folder.root, "mindwtr.db").apply { writeBytes(ByteArray(4096)) }
        assertEquals(4096L, libraryFileBytes(db))
        File(folder.root, "mindwtr.db-wal").writeBytes(ByteArray(3 * 4096 * 4))
        assertEquals(4096L + 3 * 4096 * 4, libraryFileBytes(db))
    }
}
