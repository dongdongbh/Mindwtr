package tech.dongdongbh.mindwtr.pilot

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

    /** The entry core reads now, marked as read; null while none waits, one is being read, work is open, or a failed read waits. */
    fun next(blocked: Boolean): EntryQueue.Entry? {
        val entry = queue.head() ?: return null
        if (reading != null || blocked || now() < retryAt) return null
        reading = entry.id
        return entry
    }

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
