package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * EntryRouter's decisions about the [queue], apart from Android so JVM tests drive them: which entry core reads now (one at a
 * time, the oldest, never while work is open or a failed read waits), how long a failed read waits before the next try, and
 * when an entry leaves: only after its screen or popup opened, or after core refused its input and that notice showed. [now]
 * is the clock (uptime).
 * Main thread only.
 */
class EntryLifecycle(private val queue: EntryQueue, private val now: () -> Long) {
    sealed interface Failure {
        /** Keep the entry; read it again after [delayMs]. */
        data class Retry(val delayMs: Long) : Failure
        /** Core refused the input itself: it can never open. Show [notice] (core's words), then [dismissed] lets it leave. */
        data class Refused(val notice: String) : Failure
    }

    /** The entry core is reading, or whose screen waits to open. */
    private var reading: String? = null
    private var retryAt = 0L
    private var failures = 0

    /** The oldest waiting entry's id. */
    val head: String? get() = queue.head()?.id

    /** Links already read while the user's work stayed open: each waits for that work to end, then opens in its turn. */
    private val peeked = mutableSetOf<String>()

    /**
     * The entry core reads now, marked as read; null while none waits, one is being read, the app is [blocked] (not ready, a
     * command runs or a retry is owed), or a failed read waits. While the user's work is open ([workOpen]) only a link not read
     * yet is: RN runs a context automation link at once over open work, and core's read writes nothing.
     */
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

    /** Its screen or popup opened: now the entry leaves, and the wait after failures starts over. */
    fun opened(entry: EntryQueue.Entry) {
        reading = null
        failures = 0
        retryAt = 0L
        queue.remove(entry.id)
    }

    /** Work opened before its screen could: the entry stays, and is read again once that work ends. */
    fun deferred(entry: EntryQueue.Entry) {
        if (reading == entry.id) reading = null
    }

    /**
     * Core's read failed with [message]: kept with a wait that doubles from 5 s up to a minute; or, when core refused the input,
     * held (nothing else is read) until its notice showed and [dismissed] lets it leave. Never a silent drop.
     */
    fun failed(entry: EntryQueue.Entry, message: String?): Failure {
        if (!entryRetryable(message)) return Failure.Refused(message.orEmpty().substringAfter(": "))
        // Another entry's failure (a file share staged in the background) never frees the entry being read.
        if (reading == entry.id) reading = null
        failures += 1
        val delay = minOf(MAX_WAIT_MS, FIRST_WAIT_MS shl minOf(failures - 1, 4))
        retryAt = now() + delay
        return Failure.Retry(delay)
    }

    /** A refused entry's notice showed: now it leaves. */
    fun dismissed(entry: EntryQueue.Entry) {
        if (reading == entry.id) reading = null
        queue.remove(entry.id)
    }

    private companion object {
        const val FIRST_WAIT_MS = 5_000L
        const val MAX_WAIT_MS = 60_000L
    }
}

/**
 * EntryRouter's threads, apart from Android so JVM tests drive them: one background thread that stages file shares, and the
 * main thread's queue ([post] runs a job there after a delay; [cancelPosts] drops what waits). After [close] (the ViewModel is
 * gone, the process may live on) nothing starts: a waiting retry is dropped, a staging that ends later never pumps or
 * schedules another retry (a stopped thread would throw on the main thread), and a core read that answers later neither opens
 * nor removes its entry, so the next router opens it. [background], [close] and the jobs run on the main thread; [later] may
 * be called from either.
 */
class EntryThreads(private val post: (Long, () -> Unit) -> Unit, private val cancelPosts: () -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private var closed = false

    fun background(job: () -> Unit) {
        if (!closed) worker.execute(job)
    }

    fun later(delayMs: Long = 0, job: () -> Unit) = post(delayMs, guarded(job))

    /** [job] as a main-thread callback another handler runs (the ViewModel's ui, Menu's whenIdle): nothing once closed. */
    fun guarded(job: () -> Unit): () -> Unit = { if (!closed) job() }

    fun close() {
        closed = true
        cancelPosts()
        worker.shutdownNow()
    }
}
