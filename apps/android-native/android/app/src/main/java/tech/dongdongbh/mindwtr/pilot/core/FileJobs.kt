package tech.dongdongbh.mindwtr.pilot.core

import java.io.IOException
import java.util.concurrent.Executor


internal class FileJobs(
    private val queue: Executor,
    private val abortReader: (Thread) -> Unit,
    private val readDone: (Thread) -> Unit,
) {
    private val lock = Any()
    private val running = HashMap<String, Thread>()
    private val aborted = HashSet<String>()

    fun <T> start(id: String, readsDocument: Boolean, compute: () -> T, deliver: (Result<T>) -> Unit) {
        val job = Runnable {
            val thread = Thread.currentThread()
            val result = runCatching {
                synchronized(lock) {
                    if (aborted.remove(id)) throw IOException("Request cancelled")
                    running[id] = thread
                }
                compute()
            }
            synchronized(lock) { running.remove(id) }
            readDone(thread)
            deliver(result)
        }
        if (readsDocument) Thread(job, "mindwtr-document-$id").apply { isDaemon = true }.start() else queue.execute(job)
    }

    fun abort(id: String) = synchronized(lock) {
        running[id]?.let(abortReader) ?: aborted.add(id)
        Unit
    }

    companion object {

        fun readsPickedDocument(json: String) = "\"uri\":\"content:" in json
    }
}
