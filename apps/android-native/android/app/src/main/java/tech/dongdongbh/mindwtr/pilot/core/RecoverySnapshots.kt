package tech.dongdongbh.mindwtr.pilot.core

import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone


object RecoverySnapshots {
    private const val MAX_SNAPSHOTS = 5
    private const val MAX_COLLISIONS = 100
    private const val SUFFIX = ".snapshot.json"
    private const val PENDING = "data.pending.snapshot.tmp"

    private val PATTERN = Regex("""^data\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:\.(\d{3})(?:\.(\d+))?)?\.snapshot\.json$""")


    fun isName(name: String): Boolean = PATTERN.matches(name)


    fun name(at: Date, clash: Int = 0): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss.SSS", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return "data.${format.format(at)}${if (clash > 0) ".$clash" else ""}$SUFFIX"
    }


    fun nextName(dir: File, at: Date): String {
        var clash = 0
        while (File(dir, name(at, clash)).exists()) {
            clash += 1
            check(clash <= MAX_COLLISIONS) { "Snapshot storage already holds too many snapshots from this instant." }
        }
        return name(at, clash)
    }


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


    fun list(dir: File): List<String> = dir.listFiles().orEmpty().mapNotNull { file ->
        PATTERN.matchEntire(file.name)?.let { match ->
            Triple(file.name, "${match.groupValues[1]}.${match.groupValues[2].ifEmpty { "000" }}", match.groupValues[3].toIntOrNull() ?: 0)
        }
    }.sortedWith(compareByDescending<Triple<String, String, Int>> { it.second }.thenByDescending { it.third }).map { it.first }


    fun prune(dir: File, protect: () -> Set<String>) = synchronized(this) {

        val protect = protect()
        val names = list(dir)
        val places = maxOf(0, MAX_SNAPSHOTS - names.count { it in protect })
        names.filter { it !in protect }.drop(places).forEach { runCatching { File(dir, it).delete() } }
    }
}
