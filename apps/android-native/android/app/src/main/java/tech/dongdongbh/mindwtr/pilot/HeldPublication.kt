package tech.dongdongbh.mindwtr.pilot

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * One publication held until the screen's first content (ProcessCoreHost: the boot's and a resume's widget publication). Each
 * hold has its own generation, so a resume's fallback publishes only its own hold: one left over from an earlier resume (a pause
 * and a new resume came before its deadline) finds a newer generation and leaves that hold for its own first content.
 */
internal class HeldPublication<T : Any> {
    private class Held<T>(val generation: Long, val value: T)

    private val held = AtomicReference<Held<T>?>(null)
    private val generations = AtomicLong()

    /** Holds [value] in place of any held one; returns the generation its fallback names. */
    fun hold(value: T): Long = generations.incrementAndGet().also { held.set(Held(it, value)) }

    /** First content: whatever is held, once. */
    fun take(): T? = held.getAndSet(null)?.value

    /** A fallback: the hold of [generation] only, if nothing took it first. */
    fun takeIf(generation: Long): T? {
        while (true) {
            val current = held.get() ?: return null
            if (current.generation != generation) return null
            if (held.compareAndSet(current, null)) return current.value
        }
    }

    /**
     * Leaving: nothing stays held. True when a publication was still held (a resume or the boot left before its first content
     * or fallback): the leave publishes it in full. False: the leave only flushes a change still waiting (RN's flush).
     */
    fun leave(): Boolean = held.getAndSet(null) != null
}
