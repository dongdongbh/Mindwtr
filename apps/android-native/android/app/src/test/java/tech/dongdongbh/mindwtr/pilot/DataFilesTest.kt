package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException

/** Pass D1a's Data files: the bounded stage copy, strict UTF-8, the folder write's two guards and the interrupted-export cleanup. */
class DataFilesTest {
    @get:Rule val folder = TemporaryFolder()

    // D1b code review P2: every Data row (Getting Started and the imports included) is off while a sync runs, as RN's
    // `isSyncing || isBackupBusy`; each entry point (export, pick, import, Getting Started, a snapshot) checks the same guard.
    @Test fun dataRowsWaitForARunningSync() {
        assertFalse(dataRowsBusy(null, syncing = false))
        assertTrue(dataRowsBusy(null, syncing = true))
        assertTrue(dataRowsBusy("gettingStarted", syncing = false))
        assertTrue(dataRowsBusy("import:todoist", syncing = true))
    }

    @Test fun theCopyCountsItsOwnBytesWhateverTheProviderSaid() {
        // The provider's SIZE column said 1 byte (RN's 7b7201ab6): the copy counts what it reads and stops past the production limit.
        val out = File(folder.root, "stage")
        val limit = stageLimit()
        assertEquals(DataTransferLimits.LIMIT_BYTES, limit)
        val refused = runCatching { copyBounded(ByteArrayInputStream(ByteArray((limit + 1).toInt())), out, limit) }.exceptionOrNull()
        assertTrue(refused is TransferTooLarge)
        copyBounded(ByteArrayInputStream(ByteArray(100)), out, limit)
        assertEquals(100L, out.length())
    }

    // Pass D1c §3.5 (RN 53128f68a): an import's file is capped at core's 16 MiB even when the transfer limit is larger; a JSON
    // backup at core's 128 MiB.
    @Test fun anImportPickIsCappedAtSixteenMiBWhateverTheTransferLimit() {
        val mib = 1024L * 1024
        assertEquals(16 * mib, stageLimit(import = true, transferLimit = 64 * mib))
        assertEquals(12 * mib, stageLimit(import = true, transferLimit = 12 * mib))
        assertEquals(64 * mib, stageLimit(import = false, transferLimit = 64 * mib))
        assertEquals(128 * mib, stageLimit(import = false, transferLimit = 256 * mib))
        val refused = runCatching { copyBounded(ByteArrayInputStream(ByteArray((16 * mib + 1).toInt())), File(folder.root, "import"), stageLimit(import = true, transferLimit = 64 * mib)) }
        assertTrue(refused.exceptionOrNull() is TransferTooLarge)
    }

    // Step 0 run 4: a TaskNotes ZIP of 10k tasks did not finish in 15 min on the S23 (one synchronous zip in QuickJS, so no
    // deadline runs), so the TaskNotes export keeps the 12 MiB library bound it had before D1c, whatever the transfer limit.
    @Test fun aTaskNotesExportKeepsTheTwelveMiBBoundWhateverTheTransferLimit() {
        val mib = 1024L * 1024
        assertEquals(12 * mib, exportLimit("tasknotes", transferLimit = 128 * mib))
        assertEquals(8 * mib, exportLimit("tasknotes", transferLimit = 8 * mib))
        assertEquals(128 * mib, exportLimit("json", transferLimit = 128 * mib))
        assertEquals(128 * mib, exportLimit("csv", transferLimit = 128 * mib))
    }

    private val library = 4L * 1024 * 1024
    private fun stagedCopy(bytes: ByteArray) = StagedCopies.create(File(folder.root, "backup-import")).apply { writeBytes(bytes) }

    // D1a review P2-9 and 2 (#8, #9): a pick's production path (backupPicked's previewStaged) admits the copy with the library
    // before core reads it (pass D1c: core reads the copy itself, through the data channel), and releases the copy on every
    // refusal or failure.
    @Test fun aPickedCopyIsAdmittedBeforeItIsReadAndReleasedUnlessItIsAsked() {
        val dir = File(folder.root, "backup-import")
        var inspected = 0
        val oversized = stagedCopy(ByteArray((DataTransferLimits.LIMIT_BYTES - library + 1).toInt()) { 0xff.toByte() })
        assertTrue(runCatching { previewStaged(oversized, library) { inspected += 1; JSONObject().put("valid", true) } }.exceptionOrNull() is TransferTooLarge)
        assertEquals(0, inspected)
        assertFalse(oversized.exists())
        val throwing = stagedCopy("{}".toByteArray())
        assertTrue(runCatching { previewStaged(throwing, library) { throw IllegalStateException("inspect failed") } }.isFailure)
        assertFalse(throwing.exists())
        val invalid = stagedCopy("{}".toByteArray())
        assertFalse(previewStaged(invalid, library) { JSONObject().put("valid", false) }.getBoolean("valid"))
        assertFalse(invalid.exists())
        val asked = stagedCopy("{}".toByteArray())
        var read: File? = null
        assertTrue(previewStaged(asked, library) { read = it; JSONObject().put("valid", true) }.getBoolean("valid"))
        assertEquals(asked, read)
        StagedCopies.sweep(dir)
        assertEquals(listOf(asked.name), dir.list().orEmpty().toList())
        StagedCopies.release(asked)
    }

    // D1a review P2-8: a start sweeps every staged copy no open question owns, a partial one too.
    @Test fun theStartSweepKeepsOnlyLiveStagedCopies() {
        val dir = File(folder.root, "backup-import")
        val live = StagedCopies.create(dir).apply { writeText("{}") }
        val orphan = File(dir, "11111111-1111-4111-8111-111111111111").apply { writeText("{\"tasks\":[") }
        StagedCopies.sweep(dir)
        assertTrue(live.isFile)
        assertFalse(orphan.exists())
        StagedCopies.release(live)
        assertFalse(live.exists())
    }

    // D1a review P1-2 and 2 (#2): an operation's own snapshot publish prunes nothing; operations that each published their
    // snapshot and died before the journal cost no older recovery point.
    @Test fun repeatedDeathsBeforeTheJournalKeepEveryOlderSnapshot() {
        val dir = File(folder.root, "snapshots").apply { mkdirs() }
        val history = (1..5).map { "data.2026-08-0${it}T00-00-00.000.snapshot.json" }.onEach { File(dir, it).writeText("{}") }
        repeat(3) {
            val pending = File(dir, ".1111111$it-1111-4111-8111-111111111111.recovery.pending").apply { writeText("{}") }
            tech.dongdongbh.mindwtr.pilot.core.RecoverySnapshots.publish(dir, pending, tech.dongdongbh.mindwtr.pilot.core.RecoverySnapshots.nextName(dir, java.util.Date()),
                2, tech.dongdongbh.mindwtr.pilot.core.BackupOperations.sha256("{}".toByteArray()), syncDirectory = {})
        }
        assertTrue(dir.list().orEmpty().toList().containsAll(history))
        assertEquals(8, tech.dongdongbh.mindwtr.pilot.core.RecoverySnapshots.list(dir).size)
    }

    // D1a review P2-7 and 2 (#7): a start's leftover is presented before its record goes; a stale or mismatched plan's record
    // (as CoreHost.backupFinish writes it) shows RN's failure title with core's reason.
    @Test fun aLeftoverIsPresentedBeforeItsRecordGoes() {
        val snapshots = File(folder.root, "snapshots").apply { mkdirs() }
        val ops = tech.dongdongbh.mindwtr.pilot.core.BackupOperations(File(folder.root, "ops"), snapshots, syncDirectory = {})
        val a = "11111111-1111-4111-8111-111111111111"
        // Each failure goes to core's failure toast (backupDocumentFailureModel) with its operation and its error, an import's too
        // (D1b: RN's "Import failed"); a record with no error passes its outcome.
        for ((record, operation, error) in listOf(
            Triple(JSONObject().put("operation", "merge").put("outcome", "stale").put("error", "STALE_REVISION: Local data changed after backup preparation"),
                "merge", "STALE_REVISION: Local data changed after backup preparation"),
            Triple(JSONObject().put("operation", "replace").put("outcome", "refused").put("error", "INVALID_INPUT: Backup operation files do not match"),
                "replace", "INVALID_INPUT: Backup operation files do not match"),
            Triple(JSONObject().put("operation", "todoist").put("outcome", "refused").put("error", "TOO_LARGE: The imported library would be too large to undo"),
                "todoist", "TOO_LARGE: The imported library would be too large to undo"),
            Triple(JSONObject().put("operation", "csv").put("outcome", "unresolved").put("error", ""), "csv", "unresolved"),
        )) {
            ops.writeResult(record.put("requestId", a).put("reply", JSONObject.NULL).put("undoSnapshot", ""))
            var presented: Leftover? = null
            var shown: (() -> Unit)? = null
            takeLeftover(ops, snapshots, { error("not committed") }) { leftover, done -> presented = leftover; shown = done }
            val failure = presented as Leftover.Failure
            assertEquals(operation, failure.operation)
            assertEquals(error, failure.error)
            assertEquals(a, ops.result()?.getString("requestId"))
            shown!!()
            assertNull(ops.result())
        }
        val undo = "data.2026-08-09T12-34-05.123.snapshot.json"
        File(snapshots, undo).writeText("{}")
        ops.writeResult(JSONObject().put("requestId", a).put("operation", "merge").put("outcome", "committed").put("reply", JSONObject().put("operation", "merge")).put("undoSnapshot", undo))
        var presented: Leftover? = null
        takeLeftover(ops, snapshots, { JSONObject().put("title", "Merge Backup") }) { leftover, _ -> presented = leftover }
        assertEquals(undo, (presented as Leftover.Result).undo)
        assertEquals(a, ops.result()?.getString("requestId"))
    }

    private val record get() = File(folder.root, "export-pending.json")
    private fun listed() = if (record.isFile) JSONObject(record.readText()).getJSONArray("pending").let { list ->
        List(list.length()) { list.getJSONObject(it).getString("uri") }
    } else emptyList()
    /** The production writer with this test's folder: [create] makes the document, the rest as given. */
    private fun export(name: String, create: () -> String, write: (String) -> Unit = {}, delete: (String) -> Boolean = { true }, exists: (String) -> Boolean? = { true }) =
        writeExportDocument(record, create, write, delete, exists)
    /** A later process's start: it cleans what this one listed. */
    private fun nextStart(delete: (String) -> Boolean = { true }, exists: (String) -> Boolean? = { true }) =
        cleanupExportRecord(record, delete, exists, owner = "next-start")

    @Test fun theDocumentIsListedByItsUriBeforeTheFirstByte() {
        export("b.json", create = { assertTrue(listed().isEmpty()); "content://doc/1" }, write = { assertEquals(listOf("content://doc/1"), listed()) })
        assertTrue(listed().isEmpty())
        assertNull(nextStart(delete = { error("nothing to clean") }))
    }

    @Test fun aFailedFolderWriteDeletesTheDocumentItCreated() {
        val deleted = mutableListOf<String>()
        val failure = runCatching { export("b.json", create = { "content://doc/1" }, write = { throw IOException("provider") }, delete = { deleted += it; true }) }.exceptionOrNull()
        assertTrue(failure is IOException)
        assertEquals(listOf("content://doc/1"), deleted)
        assertTrue(listed().isEmpty())
    }

    // D1a review P1-3: a finished document whose URI cannot leave the list is deleted now and the export fails; no later start
    // deletes a backup this export reported as written.
    @Test fun aFinishedWriteWhoseRecordCannotChangeFailsInsteadOfLeavingATrap() {
        val deleted = mutableListOf<String>()
        val failure = runCatching { export("b.json", create = { "content://doc/5" }, write = { folder.root.setWritable(false) }, delete = { deleted += it; true }) }.exceptionOrNull()
        folder.root.setWritable(true)
        assertTrue(failure is IOException)
        assertEquals(listOf("content://doc/5"), deleted)
    }

    // D1a review P2-9: the record a death leaves is the production writer's own, taken at the moment of the death.
    @Test fun aDeathMidWriteIsCleanedAtTheNextStart() {
        val atDeath = File(folder.root, "at-death.json")
        export("b.json", create = { "content://doc/3" }, write = { record.copyTo(atDeath) })
        atDeath.copyTo(record, overwrite = true)
        val deleted = mutableListOf<String>()
        assertEquals("deleted", nextStart(delete = { deleted += it; true }))
        assertEquals(listOf("content://doc/3"), deleted)
        assertTrue(listed().isEmpty())
    }

    // D1a review 2: the record an older build wrote, `{ uri }`, keeps its cleanup.
    @Test fun theOlderOneDocumentRecordIsCleaned() {
        record.writeText("{\"uri\":\"content://doc/old\"}")
        val deleted = mutableListOf<String>()
        assertEquals("deleted", nextStart(delete = { deleted += it; true }))
        assertEquals(listOf("content://doc/old"), deleted)
        assertTrue(listed().isEmpty())
    }

    // D1a review 3 (P1): cleanup deletes only a recorded URI. An export that died before its document existed never costs an
    // older backup that shares the name.
    @Test fun anOlderBackupWithTheSameNameSurvivesADeathBeforeCreate() {
        runCatching { export("same.json", create = { throw IOException("process died") }) }
        val deleted = mutableListOf<String>()
        assertTrue(listed().isEmpty())
        assertNull(nextStart(delete = { deleted += it; true }))
        assertTrue(deleted.isEmpty())
    }

    // D1a review P2-4: a provider that refused or cannot say keeps the entry, through a later export, until the document is gone.
    @Test fun anEntryLeavesOnlyOnceItsDocumentIsGone() {
        val atDeath = File(folder.root, "at-death.json")
        export("half.json", create = { "content://doc/half" }, write = { record.copyTo(atDeath) })
        atDeath.copyTo(record, overwrite = true)
        assertEquals("kept", nextStart(delete = { throw SecurityException("provider gone") }, exists = { null }))
        assertEquals("kept", nextStart(delete = { false }, exists = { true }))
        export("next.json", create = { "content://doc/next" })
        assertEquals(listOf("content://doc/half"), listed())
        assertEquals("deleted", nextStart(delete = { false }, exists = { false }))
        assertTrue(listed().isEmpty())
    }

    // D1a review 3: created, then its URI cannot be listed: the document goes at once, before any byte.
    @Test fun aDocumentWhoseUriCannotBeListedIsDeletedAtOnce() {
        val deleted = mutableListOf<String>()
        var wrote = false
        val failure = runCatching {
            export("lost.json", create = { folder.root.setWritable(false); "content://doc/lost" }, write = { wrote = true }, delete = { deleted += it; true })
        }.exceptionOrNull()
        folder.root.setWritable(true)
        assertTrue(failure is IOException)
        assertFalse(wrote)
        assertEquals(listOf("content://doc/lost"), deleted)
        assertTrue(listed().isEmpty())
    }

    // D1a review 2: a start's cleanup that read an empty list never writes over an export listed meanwhile.
    @Test fun anEmptyCleanupLeavesAnExportListedMeanwhile() {
        record.writeText("{\"pending\":[]}")
        val writing = java.util.concurrent.CountDownLatch(1)
        val export = Thread { export("busy.json", create = { "content://doc/busy" }, write = { writing.await(2, java.util.concurrent.TimeUnit.SECONDS) }) }
        exportCleanupPause = {
            export.start()
            val deadline = System.currentTimeMillis() + 2_000
            while (listed() != listOf("content://doc/busy") && System.currentTimeMillis() < deadline) Thread.sleep(10)
        }
        try {
            assertNull(nextStart())
            assertEquals(listOf("content://doc/busy"), listed())
        } finally {
            exportCleanupPause = {}
            writing.countDown()
            export.join(2_000)
        }
    }

    // Audit gap 9: React Native kept its record in `files/export-pending.json` (dd6f93626), one `{"uri": ...}` while it wrote a
    // backup into a picked folder. A death mid-write, then the upgrade, leaves that record; the first native start deletes its
    // document by that URI only when the document is a cut-short export, and keeps a complete one (a record whose own delete
    // failed after a finished write). It never looks a file up by name.
    private val rnRecord get() = File(folder.root, "files-export-pending.json")
    private fun rnRecordFor(uri: String) = rnRecord.writeText(JSONObject().put("uri", uri).toString())

    @Test fun aRecordReactNativeLeftDeletesItsHalfWrittenBackup() {
        rnRecordFor("content://doc/rn-half")
        val deleted = mutableListOf<String>()
        assertEquals("deleted", cleanupRnExportRecord(rnRecord, delete = { deleted += it; true }, exists = { false }, inspect = { RnExportFile.TRUNCATED }))
        assertEquals(listOf("content://doc/rn-half"), deleted)
        assertFalse(rnRecord.exists())
    }

    @Test fun aRecordReactNativeLeftKeepsACompleteBackup() {
        for ((state, outcome) in listOf(RnExportFile.COMPLETE to "kept-complete", RnExportFile.UNCHECKED to "kept-unchecked", RnExportFile.GONE to "deleted")) {
            rnRecordFor("content://doc/rn-finished")
            assertEquals(outcome, cleanupRnExportRecord(rnRecord, delete = { error("must not delete") }, exists = { error("must not ask") }, inspect = { state }))
            assertFalse(rnRecord.exists())
        }
    }

    @Test fun aRecordReactNativeLeftStaysWhileTheProviderKeepsItsDocument() {
        rnRecordFor("content://doc/rn-half")
        assertEquals("kept", cleanupRnExportRecord(rnRecord, delete = { false }, exists = { true }, inspect = { RnExportFile.TRUNCATED }))
        assertTrue(rnRecord.isFile)
        assertEquals("kept", cleanupRnExportRecord(rnRecord, delete = { error("must not delete") }, exists = { true }, inspect = { throw IOException("provider") }))
        assertTrue(rnRecord.isFile)
        assertEquals("deleted", cleanupRnExportRecord(rnRecord, delete = { true }, exists = { false }, inspect = { RnExportFile.TRUNCATED }))
        assertFalse(rnRecord.exists())
    }

    @Test fun aRecordReactNativeLeftWithNoFolderDocumentTouchesNothing() {
        val never = { _: String -> error("must not look") }
        assertNull(cleanupRnExportRecord(rnRecord, delete = never, exists = never, inspect = never))
        // RN wrote the record only for a picked folder's `content://` document; anything else, or a record cut short, is dropped.
        for (text in listOf(JSONObject().put("uri", "file:///data/user/0/x/files/backup.json").toString(), "")) {
            rnRecord.writeText(text)
            assertNull(cleanupRnExportRecord(rnRecord, delete = never, exists = never, inspect = never))
            assertFalse(rnRecord.exists())
        }
    }

    // RN's three export formats (data-transfer.ts): core's JSON backup, Mindwtr CSV (no trailing newline) and the TaskNotes ZIP.
    @Test fun aReactNativeExportIsJudgedCompleteOnlyWhenItsFormatEnds() {
        val name = "mindwtr-backup-2026-10-01T10-00-00-000Z"
        val json = JSONObject().put("tasks", org.json.JSONArray().put(JSONObject().put("id", "t1").put("title", "Grüße 😀"))).put("settings", JSONObject()).toString(2).toByteArray()
        // Recurrence is Mindwtr CSV's last column, empty on most rows: a cut inside a non-empty last field cannot be seen.
        val csv = "Title,Description,ID,Recurrence\nBuy milk,\"two\nlines, quoted \"\"x\"\"\",t1,FREQ=DAILY\nCall,,t2,".toByteArray()
        val zip = java.io.ByteArrayOutputStream().also { out ->
            java.util.zip.ZipOutputStream(out).use { z -> z.putNextEntry(java.util.zip.ZipEntry("TaskNotes/a.md")); z.write(ByteArray(4096) { 'a'.code.toByte() }); z.closeEntry() }
        }.toByteArray()
        for ((file, bytes) in listOf("$name.json" to json, "$name.csv" to csv, "$name-tasknotes.zip" to zip, "$name (1).json" to json)) {
            assertEquals(file, RnExportFile.COMPLETE, judgeRnExport(file, bytes))
            for (cut in listOf(0, 1, bytes.size / 2, bytes.size - 1)) {
                assertEquals("$file cut at $cut", RnExportFile.TRUNCATED, judgeRnExport(file, bytes.copyOf(cut)))
            }
        }
        // A cut inside a UTF-8 character is cut short too.
        val emoji = json.indexOfFirst { it == 0xF0.toByte() }
        assertEquals(RnExportFile.TRUNCATED, judgeRnExport("$name.json", json.copyOf(emoji + 2)))
        // A file that is not one of RN's export names is never judged (nor deleted).
        assertEquals(RnExportFile.UNCHECKED, judgeRnExport("notes.json", json.copyOf(3)))
    }

    // This process's own entries belong to an export still running here: its start's cleanup leaves them.
    @Test fun aCleanupNeverTouchesThisProcesssRunningExport() {
        val writing = java.util.concurrent.CountDownLatch(1)
        val listedNow = java.util.concurrent.CountDownLatch(1)
        val export = Thread { export("busy.json", create = { "content://doc/busy" }, write = { listedNow.countDown(); writing.await(2, java.util.concurrent.TimeUnit.SECONDS) }) }.apply { start() }
        try {
            assertTrue(listedNow.await(2, java.util.concurrent.TimeUnit.SECONDS))
            assertNull(cleanupExportRecord(record, delete = { error("must not delete") }, exists = { true }))
            assertEquals(listOf("content://doc/busy"), listed())
        } finally {
            writing.countDown()
            export.join(2_000)
        }
    }
}
