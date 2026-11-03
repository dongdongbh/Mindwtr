package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest


class HostFiles(
    private val files: File,
    private val cache: File,
    private val syncDirectory: (File) -> Unit = ::syncDirectory,

    private val content: ContentSource? = null,

    private val maxReadBytes: Long = Runtime.getRuntime().maxMemory() / 5,
) {

    interface ContentSource {
        fun open(uri: String): InputStream

        fun size(uri: String): Long?
    }


    fun list(path: String): String {
        val dir = resolve(path)
        if (!dir.isDirectory) return "null"
        val names = dir.listFiles() ?: throw IOException("Cannot list $path")
        return JSONArray(names.filter { it.isFile }.map { it.name }).toString()
    }

    fun readText(path: String): String = resolve(path).readText()


    fun delete(path: String) {
        val file = resolve(path)
        if (!file.delete()) {
            if (file.exists()) throw IOException("Cannot delete $path")
            return
        }
        syncDirectory(file.parentFile!!)
    }


    val documentDirectory get() = "file://${files.absolutePath}/"
    val cacheDirectory get() = "file://${cache.absolutePath}/"


    class Reply(val value: Any?, val bytes: ByteArray? = null)


    fun call(json: String, bytes: ByteArray? = null): Reply {
        val request = JSONObject(json)
        val op = request.getString("op")

        if (op == "sha256") return Reply(MessageDigest.getInstance("SHA-256").digest(bytes ?: ByteArray(0)).joinToString("") { "%02x".format(it.toInt() and 0xff) })


        if (op == "barrier") return Reply(null)
        val uri = request.getString("uri")
        return when (op) {
            "getInfo" -> Reply(info(uri))
            "makeDirectory" -> Reply(null.also { makeDirectory(writable(local(uri), folder = true)) })

            "readDirectory" -> Reply(JSONArray(local(uri).let { dir -> if (dir.isDirectory) dir.list() else missing() }
                ?.toList() ?: throw IOException("Cannot read directory")))

            "sha256File" -> Reply(open(uri).use { input ->
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(64 * 1024)
                while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
                digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            })
            "readBytes" -> Reply(null, read(uri, 0, Long.MAX_VALUE))
            "readBytesRange" -> Reply(null, read(uri, request.getLong("position"), request.getLong("length")))
            "writeBytes" -> Reply(null.also { write(target(local(uri)), bytes ?: ByteArray(0)) })
            "copy" -> Reply(null.also { copy(uri) { target(local(request.getString("to"))) } })
            "move" -> Reply(null.also { writable(local(uri)).let { from -> if (!from.exists()) missing(); move(from, target(local(request.getString("to")))) } })
            "delete" -> Reply(null.also { remove(entry(uri)) })
            "syncParent" -> Reply(null.also { syncDirectory(entry(uri).parentFile!!) })
            else -> throw IllegalArgumentException("Unsupported file call $op")
        }
    }


    fun deleteNow(uri: String) {
        val file = entry(uri)
        if (file.exists() || isLink(file)) removeTree(file)
    }

    private fun info(uri: String): JSONObject {
        if (uri.startsWith("content://")) {
            val size = checkNotNull(content) { "No content resolver" }.size(uri)
            return JSONObject().put("exists", true).put("isDirectory", false).put("uri", uri).apply { size?.let { put("size", it) } }
        }
        val file = local(uri)
        if (!file.exists()) return JSONObject().put("exists", false).put("isDirectory", false).put("uri", uri)

        return JSONObject().put("exists", true).put("isDirectory", file.isDirectory).put("uri", uri)
            .put("size", if (file.isDirectory) 0 else file.length()).put("modificationTime", file.lastModified() / 1000.0)
    }

    private fun makeDirectory(dir: File) {
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw IOException("Cannot make directory ${dir.name}")
    }

    private fun open(uri: String): InputStream = if (uri.startsWith("content://")) openDocument(uri)
        else local(uri).let { file -> if (file.isFile) file.inputStream() else missing() }


    private val sources = java.util.concurrent.ConcurrentHashMap<Thread, InputStream>()
    private val abortedReaders: MutableSet<Thread> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    private fun openDocument(uri: String): InputStream {
        val thread = Thread.currentThread()
        val stream = checkNotNull(content) { "No content resolver" }.open(uri)
        sources[thread] = stream

        if (thread in abortedReaders) {
            runCatching { stream.close() }
            throw IOException("Request cancelled")
        }
        return stream
    }


    fun abortRead(reader: Thread) {
        abortedReaders.add(reader)
        sources[reader]?.let { runCatching { it.close() } }
    }


    fun readDone(reader: Thread) {
        sources.remove(reader)
        abortedReaders.remove(reader)
    }


    private fun read(uri: String, position: Long, length: Long): ByteArray {
        require(position >= 0 && length >= 0) { "Invalid byte range" }
        open(uri).use { input ->
            var skipped = 0L
            while (skipped < position) {
                val step = input.skip(position - skipped)
                if (step > 0) skipped += step else if (input.read() < 0) return ByteArray(0) else skipped += 1
            }
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var left = length
            while (left > 0) {
                val count = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                if (count < 0) break
                out.write(buffer, 0, count)
                left -= count
                if (out.size() > maxReadBytes) throw IOException("File exceeds the $maxReadBytes byte read limit")
            }
            return out.toByteArray()
        }
    }


    private fun target(file: File): File {
        val ready = writable(file)
        makeDirectory(ready.parentFile!!)
        if (ready.isDirectory) remove(ready)
        return ready
    }


    private fun write(file: File, bytes: ByteArray) {
        FileOutputStream(file).use { out -> out.write(bytes); out.fd.sync() }
        syncDirectory(file.parentFile!!)
    }


    private fun copy(from: String, to: () -> File) {
        val file = open(from).use { input -> to().also { file -> FileOutputStream(file).use { out -> input.copyTo(out, 64 * 1024); out.fd.sync() } } }
        syncDirectory(file.parentFile!!)
    }


    private fun move(from: File, to: File) {
        if (!from.renameTo(to)) throw IOException("Cannot move ${from.name}")
        syncDirectory(to.parentFile!!)
        if (from.parentFile != to.parentFile) syncDirectory(from.parentFile!!)
    }


    private fun remove(file: File) {
        if (!file.exists() && !isLink(file)) return
        removeTree(file)
        syncDirectory(file.parentFile!!)
    }

    private fun removeTree(file: File) {
        if (!isLink(file) && file.isDirectory) file.listFiles()?.forEach(::removeTree)

        if (!file.delete() && (file.exists() || isLink(file))) throw IOException("Cannot delete ${file.name}")
    }


    private fun isLink(file: File): Boolean = file.parentFile?.let { File(it.canonicalFile, file.name).canonicalPath != File(it.canonicalFile, file.name).absolutePath } == true

    private fun missing(): Nothing = throw IOException("ENOENT: no such file or directory")


    private fun local(uri: String): File {
        require(uri.startsWith("file:///")) { "Not an app file URI" }
        val file = File(decode(uri.removePrefix("file://").substringBefore('?').substringBefore('#'))).canonicalFile
        require(listOf(files, cache).any { root -> root.canonicalFile.let { file == it || file.path.startsWith(it.path + File.separator) } }) { "Not an app file URI" }
        return file
    }


    private fun writable(file: File, folder: Boolean = false): File {
        val attachments = File(files.canonicalFile, "attachments")
        val cacheRoot = cache.canonicalFile
        require(file.path.startsWith(attachments.path + File.separator) || (folder && file == attachments)
            || file.path.startsWith(cacheRoot.path + File.separator)) { "Not a writable attachment URI" }
        return file
    }


    private fun entry(uri: String): File {
        require(uri.startsWith("file:///")) { "Not an app file URI" }
        val named = File(decode(uri.removePrefix("file://").substringBefore('?').substringBefore('#')))
        val parent = named.parentFile ?: throw IllegalArgumentException("Not an app file URI")
        require(named.name.isNotEmpty() && named.name != "." && named.name != ".." && !uri.substringBefore('?').endsWith("/")) { "Not an app file URI" }
        return writable(File(local("file://${parent.path}"), named.name))
    }


    private fun decode(path: String): String = if ('%' !in path) path else java.net.URLDecoder.decode(path.replace("+", "%2B"), "UTF-8")

    private fun resolve(path: String): File {
        val root = when (path.substringBefore('/')) {
            "files" -> files
            "cache" -> cache
            else -> throw IllegalArgumentException("Not an app file: $path")
        }.canonicalFile
        val file = File(root, path.substringAfter('/', "")).canonicalFile
        require(file.path.startsWith(root.path + File.separator)) { "Not an app file: $path" }
        return file
    }
}


class AndroidContentSource(context: android.content.Context) : HostFiles.ContentSource {
    private val resolver = context.applicationContext.contentResolver

    override fun open(uri: String): InputStream =
        resolver.openInputStream(android.net.Uri.parse(uri)) ?: throw IOException("ENOENT: no such file or directory")

    override fun size(uri: String): Long? =
        resolver.query(android.net.Uri.parse(uri), arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { row ->
            if (!row.moveToFirst()) throw IOException("ENOENT: no such file or directory")
            if (row.isNull(0)) null else row.getLong(0)
        } ?: throw IOException("ENOENT: no such file or directory")
}
