package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import java.util.concurrent.Executors


class EntryLifecycle(private val queue: EntryQueue, private val now: () -> Long) {
    sealed interface Failure {

        data class Retry(val delayMs: Long) : Failure

        data class Refused(val notice: String) : Failure
    }


    private var reading: String? = null
    private var retryAt = 0L
    private var failures = 0


    val head: String? get() = queue.head()?.id


    private val peeked = mutableSetOf<String>()


    fun next(blocked: Boolean, workOpen: Boolean = false): EntryQueue.Entry? {
        if (reading != null || blocked || now() < retryAt) return null
        if (!workOpen) peeked.clear()
        val entry = if (!workOpen) queue.head() else queue.all().firstOrNull { it.id !in peeked && it.isLink() }
        entry ?: return null
        if (workOpen) peeked += entry.id
        reading = entry.id
        return entry
    }

    private fun EntryQueue.Entry.isLink() = runCatching { JSONObject(input).optString("kind") == "link" }.getOrDefault(false)


    fun opened(entry: EntryQueue.Entry) {
        reading = null
        failures = 0
        retryAt = 0L
        queue.remove(entry.id)
    }


    fun deferred(entry: EntryQueue.Entry) {
        if (reading == entry.id) reading = null
    }


    fun failed(entry: EntryQueue.Entry, message: String?): Failure {
        if (!entryRetryable(message)) return Failure.Refused(message.orEmpty().substringAfter(": "))

        if (reading == entry.id) reading = null
        failures += 1
        val delay = minOf(MAX_WAIT_MS, FIRST_WAIT_MS shl minOf(failures - 1, 4))
        retryAt = now() + delay
        return Failure.Retry(delay)
    }


    fun dismissed(entry: EntryQueue.Entry) {
        if (reading == entry.id) reading = null
        queue.remove(entry.id)
    }

    private companion object {
        const val FIRST_WAIT_MS = 5_000L
        const val MAX_WAIT_MS = 60_000L
    }
}


class EntryThreads(private val post: (Long, () -> Unit) -> Unit, private val cancelPosts: () -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private var closed = false

    fun background(job: () -> Unit) {
        if (!closed) worker.execute(job)
    }

    fun later(delayMs: Long = 0, job: () -> Unit) = post(delayMs, guarded(job))


    fun guarded(job: () -> Unit): () -> Unit = { if (!closed) job() }

    fun close() {
        closed = true
        cancelPosts()
        worker.shutdownNow()
    }
}


class EntryLockHold {
    private var reported: String? = null


    fun holds(locked: Boolean, head: EntryQueue.Entry?, report: (EntryQueue.Entry) -> Unit): Boolean {
        if (!locked) return false
        if (head != null && head.id != reported) {
            reported = head.id
            report(head)
        }
        return true
    }
}
