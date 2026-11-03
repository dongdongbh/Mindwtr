package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest


data class BackupBudget(val baseMs: Long, val msPerMiB: Long) {
    fun ms(bytes: Long): Long = baseMs + (bytes + MIB - 1) / MIB * msPerMiB

    companion object {
        private const val MIB = 1024L * 1024


        val DEFAULT = BackupBudget(baseMs = 120_000, msPerMiB = 3_000)

        const val MAX_MS = 15 * 60 * 1000L
    }
}


class BackupOperations(
    private val root: File,
    private val snapshots: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,


    private val maxPlanBytes: Long = Long.MAX_VALUE,
) {
    class Mismatch(message: String) : IllegalStateException(message)

    class PlanTooLarge : java.io.IOException("The prepared plan exceeds the transfer limit")

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

        val CAPTURE_PENDING_NAME = Regex("^\\.capture-[0-9a-f-]{36}\\.pending$")
        private const val MAX_MANIFEST_BYTES = 8192
        private const val MAX_RESULT_BYTES = 128 * 1024
        private val UUID = Regex("^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


        private val RESULT_LOCK = Any()

        @Volatile internal var clearPause: () -> Unit = {}

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }


        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val read = input.read(buffer); if (read < 0) break; digest.update(buffer, 0, read) }
            }
            return DataChannel.hex(digest.digest())
        }
    }


    fun pendingPlan(id: String): File {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        return File(File(root, id).apply { mkdirs() }, PLAN + PENDING)
    }


    fun pendingSnapshot(id: String): File {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        return File(snapshots.apply { mkdirs() }, ".$id$RECOVERY_PENDING")
    }


    fun reserve(id: String, snapshotName: String) {
        require(UUID.matches(id)) { "Invalid backup operation id" }
        val dir = File(root, id).apply { mkdirs() }
        writeSynced(dir, RESERVATION, JSONObject().put("snapshotName", snapshotName).toString().toByteArray())
        syncDirectory(root)
    }


    fun publish(id: String, mode: String, plan: DataChannel.Closed, snapshotName: String, recovery: DataChannel.Closed?, budgetMs: Long = 0, beforeManifest: () -> Unit = {}): String {
        val pending = pendingPlan(id)
        if (budgetMs > BackupBudget.MAX_MS) { pending.delete(); throw BudgetTooLarge() }

        if (plan.bytes > maxPlanBytes) { pending.delete(); throw PlanTooLarge() }
        if (!pending.isFile || pending.length() != plan.bytes || sha256(pending) != plan.sha256) throw Mismatch("The prepared plan changed")
        val dir = pending.parentFile!!
        check(pending.renameTo(File(dir, PLAN))) { "Cannot save $PLAN" }
        syncDirectory(dir)
        beforeManifest()
        val manifest = JSONObject().put("version", 1).put("id", id).put("mode", mode)
            .put("planSha256", plan.sha256).put("planBytes", plan.bytes).put("snapshotName", snapshotName)

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


    fun budgetMs(referenceJson: String, budget: BackupBudget): Long? = runCatching {
        val manifest = manifest(referenceJson)
        manifest.optLong("budgetMs", 0).takeIf { it > 0 } ?: budget.ms(2 * manifest.getLong("planBytes"))
    }.getOrNull()


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


    fun discard(id: String): Boolean {
        val dir = File(root, id)
        if (!UUID.matches(id) || !dir.exists()) return true
        dir.listFiles().orEmpty().forEach { it.delete() }
        val gone = dir.delete() || !dir.exists()
        if (gone) runCatching { syncDirectory(root) }
        return gone
    }


    fun cleanup(retaining: Set<String>) {
        root.listFiles().orEmpty().filter { it.isDirectory && it.name !in retaining }.forEach { discard(it.name) }
        root.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(PENDING) }.forEach { it.delete() }

        snapshots.listFiles().orEmpty().filter { file -> RECOVERY_PENDING_NAME.matchEntire(file.name)?.groupValues?.get(1)?.let { it !in retaining } == true
            || CAPTURE_PENDING_NAME.matches(file.name) }.forEach { it.delete() }
    }


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


    fun writeResult(record: JSONObject): Unit = synchronized(RESULT_LOCK) {
        root.mkdirs()
        val bytes = record.toString().toByteArray()
        check(bytes.size <= MAX_RESULT_BYTES) { "Backup result too large" }
        writeSynced(root, RESULT, bytes)
        syncDirectory(root)
    }


    fun result(): JSONObject? = File(root, RESULT).takeIf { it.isFile && it.length() <= MAX_RESULT_BYTES }
        ?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }


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
