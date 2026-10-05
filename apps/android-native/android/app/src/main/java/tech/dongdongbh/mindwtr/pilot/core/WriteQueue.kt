package tech.dongdongbh.mindwtr.pilot.core

/**
 * The order CoreHost starts host calls in (D9a review): a journaled write starts only after the write before it answered, its
 * I/O included, so the database commits writes in the journal's order and a replay repeats it; a read starts at once. Engine
 * thread only.
 */
internal class WriteQueue<T : Any>(private val isWrite: (T) -> Boolean) {
    private var running: T? = null
    private val waiting = ArrayDeque<T>()

    /** True when [call] may start now: a read, or a write with no write running. Otherwise it waits its turn. */
    fun admit(call: T): Boolean {
        if (!isWrite(call)) return true
        if (running != null) {
            waiting.addLast(call)
            return false
        }
        running = call
        return true
    }

    /** [call] answered (or failed): the next waiting write, which may start now, or null. */
    fun ended(call: T): T? {
        if (call !== running) return null
        running = waiting.removeFirstOrNull()
        return running
    }

    /** The host closes: the writes that never started, for their callers to be failed. */
    fun close(): List<T> = waiting.toList().also {
        waiting.clear()
        running = null
    }
}
