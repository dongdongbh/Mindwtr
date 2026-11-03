package tech.dongdongbh.mindwtr.pilot.core

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit


class HostAnswers {

    class Answer(val json: String, val body: String? = null)

    private val lock = Any()
    @Volatile var closed = false; private set
    private val queue = LinkedBlockingQueue<Answer>()

    private var held: Answer? = null

    private var taken: String? = null
    val size: Int get() = queue.size


    fun add(answer: Answer): Boolean = synchronized(lock) { if (closed) false else queue.add(answer) }


    fun await(ms: Long) {
        if (held != null || closed) return
        val answer = queue.poll(ms, TimeUnit.MILLISECONDS) ?: return
        synchronized(lock) { if (!closed) held = answer }
    }


    fun next(): Answer? = synchronized(lock) {
        if (closed) return null
        val answer = held ?: queue.poll() ?: return null
        held = null
        taken = answer.body
        answer
    }


    fun body(): String = synchronized(lock) { if (closed) "" else (taken ?: "").also { taken = null } }

    fun close() = synchronized(lock) {
        closed = true
        queue.clear()
        held = null
        taken = null
    }
}
