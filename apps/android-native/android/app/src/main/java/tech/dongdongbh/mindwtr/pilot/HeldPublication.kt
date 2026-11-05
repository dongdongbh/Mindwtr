package tech.dongdongbh.mindwtr.pilot

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference


internal class HeldPublication<T : Any> {
    private class Held<T>(val generation: Long, val value: T)

    private val held = AtomicReference<Held<T>?>(null)
    private val generations = AtomicLong()


    fun hold(value: T): Long = generations.incrementAndGet().also { held.set(Held(it, value)) }


    fun take(): T? = held.getAndSet(null)?.value


    fun takeIf(generation: Long): T? {
        while (true) {
            val current = held.get() ?: return null
            if (current.generation != generation) return null
            if (held.compareAndSet(current, null)) return current.value
        }
    }


    fun leave(): Boolean = held.getAndSet(null) != null
}
