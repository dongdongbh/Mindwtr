package tech.dongdongbh.mindwtr.pilot.core

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * HostIo's answers: queued on the answering threads, taken on the engine thread. After [close] nothing is queued or taken, and
 * what waited is dropped: a secret's value, a derived key or plaintext must not outlive the host in a queue nobody drains.
 */
class HostAnswers {
    /** An answer's JSON, and its body (base64, or a fetch body's text: HostIo.read) apart from it, so no copy of the body is wrapped in JSON. */
    class Answer(val json: String, val body: String? = null)

    private val lock = Any()
    @Volatile var closed = false; private set
    private val queue = LinkedBlockingQueue<Answer>()
    /** An answer [await] took before [next] asked for it. */
    private var held: Answer? = null
    /** The body of the answer [next] returned last, until [body] takes it. */
    private var taken: String? = null
    val size: Int get() = queue.size

    /** Queues [answer]; false (dropped) once closed. */
    fun add(answer: Answer): Boolean = synchronized(lock) { if (closed) false else queue.add(answer) }

    /** Waits up to [ms] for an answer, so the pump loop wakes as soon as one is queued. */
    fun await(ms: Long) {
        if (held != null || closed) return
        val answer = queue.poll(ms, TimeUnit.MILLISECONDS) ?: return
        synchronized(lock) { if (!closed) held = answer }
    }

    /** The next answer, or null when none is or the host closed. Its body, if any, waits for [body]. */
    fun next(): Answer? = synchronized(lock) {
        if (closed) return null
        val answer = held ?: queue.poll() ?: return null
        held = null
        taken = answer.body
        answer
    }

    /** The body of the answer [next] returned last, as base64 ("" once closed). */
    fun body(): String = synchronized(lock) { if (closed) "" else (taken ?: "").also { taken = null } }

    fun close() = synchronized(lock) {
        closed = true
        queue.clear()
        held = null
        taken = null
    }
}
