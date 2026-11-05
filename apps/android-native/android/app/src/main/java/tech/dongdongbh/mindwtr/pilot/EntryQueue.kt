package tech.dongdongbh.mindwtr.pilot

import java.io.File
import java.io.FileOutputStream
import java.util.UUID


class EntryQueue(private val dir: File, private val limit: Int = 20) {
    data class Entry(val id: String, val input: String)

    private val file = File(dir, "queue")


    fun all(): List<Entry> = runCatching { if (file.exists()) file.readLines() else emptyList() }.getOrDefault(emptyList()).mapNotNull { line ->
        val tab = line.indexOf('\t')
        if (tab <= 0) null else Entry(line.substring(0, tab), line.substring(tab + 1))
    }

    fun head(): Entry? = all().firstOrNull()


    fun add(input: String): Boolean {
        if ('\n' in input || '\r' in input) return false
        val entries = all()
        if (entries.size >= limit) return false
        write(entries + Entry(UUID.randomUUID().toString(), input))
        return true
    }


    fun remove(id: String) {
        val entries = all()
        val kept = entries.filterNot { it.id == id }
        if (kept.size != entries.size) write(kept)
    }

    private fun write(entries: List<Entry>) {
        dir.mkdirs()
        val partial = File(dir, "queue-partial")
        FileOutputStream(partial).use { out ->
            out.write(entries.joinToString("") { "${it.id}\t${it.input}\n" }.toByteArray())
            out.fd.sync()
        }
        check(partial.renameTo(file)) { "Cannot save the entry queue" }
    }
}


fun entryRetryable(message: String?): Boolean = message?.startsWith("INVALID_INPUT") != true
