package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * How long Settings › Data's work on [bytes] of library and file may take (pass D1c design §3.4): [baseMs] plus [msPerMiB] for
 * each started MiB. One budget sizes Android's boot, recovery activation, the storage read, inspect, prepare, export and the
 * capture snapshot; a backup commit's is frozen into its manifest when it is published and never recomputed.
 */
data class BackupBudget(val baseMs: Long, val msPerMiB: Long) {
    fun ms(bytes: Long): Long = baseMs + (bytes + MIB - 1) / MIB * msPerMiB

    companion object {
        private const val MIB = 1024L * 1024
        // Three times step 0's slowest rate, rounded up (run 4, S23): a 53 MiB file restored over an empty library in 92 s, and a
        // 17.7 MiB file merged over a 22.8 MiB library in 97 s, each under 1 s per MiB of file, library and plan.
        val DEFAULT = BackupBudget(baseMs = 120_000, msPerMiB = 3_000)
        /** The longest operation a start admits (15 min); a journaled one is never refused for it. */
        const val MAX_MS = 15 * 60 * 1000L
    }
}

/**
 * A restore, merge or import's files between core's prepare and its journaled commit (design D1 §4), under the app's no-backup
 * `backup-operations` folder:
 *
 * - `<uuid>/reservation.json` (pass D1c): the snapshot name, written first, so no prune removes it before the manifest names it.
 * - `<uuid>/plan.json`: core's frozen plan (written by core through the data channel into `plan.json.pending`), then `<uuid>/manifest.json`: the uuid, the operation's mode, the plan's SHA-256 and
 *   size, and the recovery snapshot's name (with its SHA-256 and size when this operation wrote it). Each is written to a
 *   pending file, synced and renamed, then the folder is synced. The journal entry (`backupDocumentCommit`) holds only the
 *   reference: the uuid and the manifest's SHA-256 and size.
 * - `result.json`: the last operation's outcome and its Undo snapshot, written before any of its inputs go, so a death after the
 *   commit still shows its result once.
 *
 * [plan] checks every identity before a plan is sent: the manifest matches the reference, the plan matches the manifest, the
 * uuid is the folder's, the snapshot name is the journal's, and the snapshot this operation wrote is on disk unchanged. A
 * mismatch throws [Mismatch]; the caller sets the entry aside and never sends it.
 */
class BackupOperations(
    private val root: File,
    private val snapshots: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,
    /**
     * The largest plan [publish] admits (the measured transfer limit's plan share). Only admission applies it: a journaled plan
     * is replayed whatever the limit is by then (pass D1c code review).
     */
    private val maxPlanBytes: Long = Long.MAX_VALUE,
) {
    class Mismatch(message: String) : IllegalStateException(message)
    /** A plan over the limit: refused at [publish], before its journal entry exists, so no journaled plan is ever refused for its size. */
    class PlanTooLarge : java.io.IOException("The prepared plan exceeds the transfer limit")
    /** An operation whose time budget passes [BackupBudget.MAX_MS]: refused at publish, before its journal entry exists. */
    class BudgetTooLarge : java.io.IOException("The operation would take too long")

    companion object {
        const val METHOD = "backupDocumentCommit"
        private const val PLAN = "plan.json"
        private const val MANIFEST = "manifest.json"
        private const val RESULT = "result.json"
        private const val PENDING = ".pending"
        private const val RESERVATION = "reservation.json"
        private const val RECOVERY_PENDING = ".recovery.pending"
        private val RECOVERY_PENDING_NAME = Regex("^\\.([0-9a-f-]{36})\\.recovery\\.pending$")
        /** A capture snapshot core was writing through the data channel (CoreHost.createQuickCaptureSnapshot). */
        val CAPTURE_PENDING_NAME = Regex("^\\.capture-[0-9a-f-]{36}\\.pending$")
        private const val MAX_MANIFEST_BYTES = 8192
        private const val MAX_RESULT_BYTES = 128 * 1024
        private val UUID = Regex("^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")

        /** One result record writer or clearer at a time in the process, whichever instance it goes through. */
        private val RESULT_LOCK = Any()
        /** A test seam: runs inside [clearResult] between its check and its delete. */
        @Volatile internal var clearPause: () -> Unit = {}

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** [file]'s SHA-256, read in 64 KiB pieces. */
        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val read = input.read(buffer); if (read < 0) break; digest.update(buffer, 0, read) }
            }
            return DataChannel.hex(digest.digest())
        }
    }

    /** Where prepare writes operation [id]'s plan through the data channel (pass D1c); [publish] renames it. */
    fun pendingPlan(id: String): File {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        return File(File(root, id).apply { mkdirs() }, PLAN + PENDING)
    }

    /** Where prepare writes operation [id]'s recovery snapshot: the snapshots folder, under a name RN's pattern never matches. */
    fun pendingSnapshot(id: String): File {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        return File(snapshots.apply { mkdirs() }, ".$id$RECOVERY_PENDING")
    }

    /**
     * Before anything of operation [id] is written: the snapshot name it will publish or restore, synced, so every prune spares
     * it from now on ([protectedNames]) until the operation's folder goes.
     */
    fun reserve(id: String, snapshotName: String) {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        val dir = File(root, id).apply { mkdirs() }
        writeSynced(dir, RESERVATION, JSONObject().put("snapshotName", snapshotName).toString().toByteArray())
        syncDirectory(root)
    }

    /**
     * The plan and manifest for operation [id] in [mode], on disk and synced; the journal's reference JSON. Core wrote the plan
     * through the data channel into [pendingPlan] ([plan]: the bytes and hash the channel counted); [snapshotName] is the
     * snapshot the plan's reply names, and [recovery] the bytes and hash of the one this operation published there (null: it
     * wrote none). A file on disk that differs from what the channel wrote publishes nothing ([Mismatch]).
     */
    fun publish(id: String, mode: String, plan: DataChannel.Closed, snapshotName: String, recovery: DataChannel.Closed?, budgetMs: Long = 0, beforeManifest: () -> Unit = {}): String {
        val pending = pendingPlan(id)
        if (budgetMs > BackupBudget.MAX_MS) { pending.delete(); throw BudgetTooLarge() }
        // An import can grow far past its file (100 000 short rows): a plan [plan] would refuse at its identity check is refused here.
        if (plan.bytes > maxPlanBytes) { pending.delete(); throw PlanTooLarge() }
        if (!pending.isFile || pending.length() != plan.bytes || sha256(pending) != plan.sha256) throw Mismatch("The prepared plan changed")
        val dir = pending.parentFile!!
        check(pending.renameTo(File(dir, PLAN))) { "Cannot save $PLAN" }
        syncDirectory(dir)
        beforeManifest()
        val manifest = JSONObject().put("version", 1).put("id", id).put("mode", mode)
            .put("planSha256", plan.sha256).put("planBytes", plan.bytes).put("snapshotName", snapshotName)
        // The commit's deadline, frozen now: its first send and every replay use it (pass D1c review 3 #11).
        if (budgetMs > 0) manifest.put("budgetMs", budgetMs)
        if (recovery != null) {
            val snapshot = File(snapshots, snapshotName)
            if (!snapshot.isFile || snapshot.length() != recovery.bytes || sha256(snapshot) != recovery.sha256) throw Mismatch("The recovery snapshot is missing or changed")
            manifest.put("snapshotSha256", recovery.sha256).put("snapshotBytes", recovery.bytes)
        }
        val manifestBytes = manifest.toString().toByteArray()
        check(manifestBytes.size <= MAX_MANIFEST_BYTES) { "Backup manifest too large" }
        writeSynced(dir, MANIFEST, manifestBytes)
        syncDirectory(root)
        return JSONObject().put("id", id).put("sha256", sha256(manifestBytes)).put("byteCount", manifestBytes.size).toString()
    }

    /**
     * Operation [referenceJson]'s plan file and its SHA-256, after every identity check (each file hashed as it streams, never
     * read whole); throws [Mismatch] otherwise. The data channel's read handle checks the same hash again as core reads it.
     */
    fun plan(referenceJson: String, snapshotName: String): Pair<File, String> {
        val manifest = manifest(referenceJson)
        if (manifest.getString("snapshotName") != snapshotName) throw Mismatch("The journal names another snapshot")
        val planFile = File(File(root, manifest.getString("id")), PLAN)
        val size = planFile.length()
        if (!planFile.isFile || size != manifest.getLong("planBytes")) throw Mismatch("The backup plan is missing or changed")
        val planSha256 = manifest.getString("planSha256")
        if (sha256(planFile) != planSha256) throw Mismatch("The backup plan changed")
        if (manifest.has("snapshotSha256")) {
            val snapshot = File(snapshots, snapshotName)
            if (!snapshot.isFile || snapshot.length() != manifest.getLong("snapshotBytes") || sha256(snapshot) != manifest.getString("snapshotSha256")) {
                throw Mismatch("The recovery snapshot is missing or changed")
            }
        }
        return planFile to planSha256
    }

    /**
     * Operation [referenceJson]'s commit deadline: the budget frozen in its manifest, or for a manifest published before pass
     * D1c, [budget] over twice its plan; null when the manifest is unreadable (the identity check then refuses the send).
     */
    fun budgetMs(referenceJson: String, budget: BackupBudget): Long? = runCatching {
        val manifest = manifest(referenceJson)
        manifest.optLong("budgetMs", 0).takeIf { it > 0 } ?: budget.ms(2 * manifest.getLong("planBytes"))
    }.getOrNull()

    /** The operation's mode from its manifest (for the result record when its plan cannot be sent); null when unreadable. */
    fun mode(referenceJson: String): String? = runCatching { manifest(referenceJson).getString("mode") }.getOrNull()

    private fun manifest(referenceJson: String): JSONObject {
        val reference = runCatching { JSONObject(referenceJson) }.getOrNull() ?: throw Mismatch("Invalid backup reference")
        val id = reference.optString("id")
        if (!UUID.matches(id)) throw Mismatch("Invalid backup reference")
        val file = File(File(root, id), MANIFEST)
        if (!file.isFile || file.length() > MAX_MANIFEST_BYTES) throw Mismatch("The backup manifest is missing")
        val bytes = file.readBytes()
        if (bytes.size != reference.optInt("byteCount", -1) || sha256(bytes) != reference.optString("sha256")) throw Mismatch("The backup manifest changed")
        val manifest = JSONObject(String(bytes, Charsets.UTF_8))
        if (manifest.optInt("version") != 1 || manifest.optString("id") != id) throw Mismatch("The backup manifest names another operation")
        return manifest
    }

    /** Operation [id]'s folder is gone (after its journal entry left); true once it is. */
    fun discard(id: String): Boolean {
        val dir = File(root, id)
        if (!UUID.matches(id) || !dir.exists()) return true
        dir.listFiles().orEmpty().forEach { it.delete() }
        val gone = dir.delete() || !dir.exists()
        if (gone) runCatching { syncDirectory(root) }
        return gone
    }

    /** At start, before boot: every operation folder no journal entry names goes (its commit was never sent, or it settled). */
    fun cleanup(retaining: Set<String>) {
        root.listFiles().orEmpty().filter { it.isDirectory && it.name !in retaining }.forEach { discard(it.name) }
        root.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(PENDING) }.forEach { it.delete() }
        // A recovery snapshot core was still writing, or that never published, when the process died.
        snapshots.listFiles().orEmpty().filter { file -> RECOVERY_PENDING_NAME.matchEntire(file.name)?.groupValues?.get(1)?.let { it !in retaining } == true
            || CAPTURE_PENDING_NAME.matches(file.name) }.forEach { it.delete() }
    }

    /** The snapshot names no prune may remove: each open operation's (reserved or in its manifest), and the result record's Undo snapshot. */
    fun protectedNames(): Set<String> {
        val names = HashSet<String>()
        root.listFiles().orEmpty().filter { it.isDirectory }.forEach { dir ->
            for (file in listOf(MANIFEST, RESERVATION)) {
                runCatching { JSONObject(File(dir, file).readText()).getString("snapshotName") }.getOrNull()?.let(names::add)
            }
        }
        result()?.optString("undoSnapshot")?.takeIf { it.isNotEmpty() }?.let(names::add)
        return names
    }

    /** The result record (`{ requestId, operation, outcome, reply, undoSnapshot }`), replacing the last one; synced. */
    fun writeResult(record: JSONObject): Unit = synchronized(RESULT_LOCK) {
        root.mkdirs()
        val bytes = record.toString().toByteArray()
        check(bytes.size <= MAX_RESULT_BYTES) { "Backup result too large" }
        writeSynced(root, RESULT, bytes)
        syncDirectory(root)
    }

    /** The result record left on disk, or null. */
    fun result(): JSONObject? = File(root, RESULT).takeIf { it.isFile && it.length() <= MAX_RESULT_BYTES }
        ?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }

    /** The result of [requestId] was shown: its record goes (a newer operation's record stays, even one written meanwhile). */
    fun clearResult(requestId: String) {
        synchronized(RESULT_LOCK) {
            if (result()?.optString("requestId") != requestId) return
            clearPause()
            File(root, RESULT).delete()
            runCatching { syncDirectory(root) }
        }
    }

    private fun writeSynced(dir: File, name: String, bytes: ByteArray) {
        val pending = File(dir, name + PENDING)
        try {
            FileOutputStream(pending).use { out -> out.write(bytes); out.fd.sync() }
            check(pending.renameTo(File(dir, name))) { "Cannot save $name" }
        } catch (failure: Throwable) {
            pending.delete()
            throw failure
        }
        syncDirectory(dir)
    }
}
