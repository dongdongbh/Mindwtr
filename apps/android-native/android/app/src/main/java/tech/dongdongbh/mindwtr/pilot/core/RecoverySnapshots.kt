package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Recovery snapshots as React Native writes them (apps/mobile/lib/recovery-snapshot.ts, its names in core's
 * recovery-snapshot-names.ts): core's contents under the app's `snapshots` folder (RN's document directory is this app's files
 * folder), through a temporary file, `.1`, `.2` … before `.snapshot.json` when the name is taken, and only the 5 newest kept.
 * A name in `protect` (the one just written, one an open backup operation needs) is never pruned, so a snapshot written after
 * the clock went back is not deleted at once (core's recoverySnapshotNamesToPrune).
 */
object RecoverySnapshots {
    private const val MAX_SNAPSHOTS = 5
    private const val MAX_COLLISIONS = 100
    private const val SUFFIX = ".snapshot.json"
    private const val PENDING = "data.pending.snapshot.tmp"
    /** RN's SNAPSHOT_FILE_PATTERN: the instant, its milliseconds, and the clash number. */
    private val PATTERN = Regex("""^data\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:\.(\d{3})(?:\.(\d+))?)?\.snapshot\.json$""")

    /** Whether [name] is a snapshot's name (RN's pattern). */
    fun isName(name: String): Boolean = PATTERN.matches(name)

    /** RN's buildSnapshotFileName for [at]: `data.<UTC instant, colons as dashes>[.<clash>].snapshot.json`. */
    fun name(at: Date, clash: Int = 0): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss.SSS", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return "data.${format.format(at)}${if (clash > 0) ".$clash" else ""}$SUFFIX"
    }

    /** The name a snapshot taken at [at] gets now (RN's clash numbering); reads only, so the write must still refuse a taken name. */
    fun nextName(dir: File, at: Date): String {
        var clash = 0
        while (File(dir, name(at, clash)).exists()) {
            clash += 1
            check(clash <= MAX_COLLISIONS) { "Snapshot storage already holds too many snapshots from this instant." }
        }
        return name(at, clash)
    }

    /**
     * Writes [contents] as core's [fileName] (or, unless [exact], its clash-numbered twin) and returns the name written. [exact]
     * refuses a name already taken: a backup operation's plan names its snapshot before the write. Every writer in the process
     * (a backup operation, a multiline capture) runs one at a time: the name check, the shared pending file and the rename never
     * interleave. [prune] false (a backup operation before its commit) leaves every older snapshot; the operation prunes once
     * it settled. [beforePublish] runs with the pending file written and synced, before its rename (a test seam).
     */
    fun write(dir: File, fileName: String, contents: String, protect: () -> Set<String> = { emptySet() }, exact: Boolean = false,
              prune: Boolean = true, syncDirectory: (File) -> Unit = ::syncDirectory, beforePublish: () -> Unit = {}): String = synchronized(this) {
        dir.mkdirs()
        val name = freeName(dir, fileName, exact)
        val pending = File(dir, PENDING)
        try {
            FileOutputStream(pending).use { out -> out.write(contents.toByteArray()); out.fd.sync() }
            beforePublish()
            check(pending.renameTo(File(dir, name))) { "Cannot save the recovery snapshot" }
        } catch (failure: Throwable) {
            pending.delete()
            throw failure
        }
        syncDirectory(dir)
        if (prune) prune(dir) { protect() + name }
        name
    }

    /** [fileName], or (unless [exact]) its first clash-numbered twin no file has yet. */
    private fun freeName(dir: File, fileName: String, exact: Boolean): String {
        var name = fileName
        var clash = 0
        while (File(dir, name).exists()) {
            check(!exact) { "The recovery snapshot name is already taken" }
            clash += 1
            check(clash <= MAX_COLLISIONS) { "Snapshot storage already holds too many snapshots from this instant." }
            name = fileName.removeSuffix(SUFFIX) + ".$clash$SUFFIX"
        }
        return name
    }

    /**
     * The capture popup's snapshot (pass D1c), which core wrote through the data channel into [written]: published as
     * [fileName] or its clash-numbered twin, as [write] does, then the older ones pruned. Returns the name written.
     */
    fun publishCapture(dir: File, written: File, fileName: String, protect: () -> Set<String>, syncDirectory: (File) -> Unit = ::syncDirectory): String = synchronized(this) {
        val name = try {
            freeName(dir, fileName, exact = false).also { check(written.renameTo(File(dir, it))) { "Cannot save the recovery snapshot" } }
        } catch (failure: Throwable) {
            written.delete()
            throw failure
        }
        syncDirectory(dir)
        prune(dir) { protect() + name }
        name
    }

    /**
     * A backup operation's recovery snapshot (pass D1c), which core wrote through the data channel into [pending]: published
     * under exactly [name] once the file on disk is the one the channel wrote ([bytes], [sha256]); a mismatch publishes nothing.
     * No prune: the operation prunes once it settled. The name is reserved (BackupOperations.reserve) before this runs.
     */
    fun publish(dir: File, pending: File, name: String, bytes: Long, sha256: String, syncDirectory: (File) -> Unit = ::syncDirectory) = synchronized(this) {
        try {
            check(!File(dir, name).exists()) { "The recovery snapshot name is already taken" }
            check(pending.isFile && pending.length() == bytes && BackupOperations.sha256(pending) == sha256) { "The recovery snapshot changed before it was published" }
            check(pending.renameTo(File(dir, name))) { "Cannot save the recovery snapshot" }
        } catch (failure: Throwable) {
            pending.delete()
            throw failure
        }
        syncDirectory(dir)
    }

    /** The snapshot names in [dir], newest first by instant, then by clash number (core's sortRecoverySnapshotNames). */
    fun list(dir: File): List<String> = dir.listFiles().orEmpty().mapNotNull { file ->
        PATTERN.matchEntire(file.name)?.let { match ->
            Triple(file.name, "${match.groupValues[1]}.${match.groupValues[2].ifEmpty { "000" }}", match.groupValues[3].toIntOrNull() ?: 0)
        }
    }.sortedWith(compareByDescending<Triple<String, String, Int>> { it.second }.thenByDescending { it.third }).map { it.first }

    /**
     * RN's pruneSnapshots with core's protection: the [protect]ed names stay and count toward the 5; the newest others fill the
     * places left; the rest go.
     */
    fun prune(dir: File, protect: () -> Set<String>) = synchronized(this) {
        // Read inside the lock: an operation that reserved and published its name meanwhile is protected too.
        val protect = protect()
        val names = list(dir)
        val places = maxOf(0, MAX_SNAPSHOTS - names.count { it in protect })
        names.filter { it !in protect }.drop(places).forEach { runCatching { File(dir, it).delete() } }
    }
}
