package tech.dongdongbh.mindwtr.pilot.core


internal class WriteQueue<T : Any>(private val isWrite: (T) -> Boolean) {
    private var running: T? = null
    private val waiting = ArrayDeque<T>()


    fun admit(call: T): Boolean {
        if (!isWrite(call)) return true
        if (running != null) {
            waiting.addLast(call)
            return false
        }
        running = call
        return true
    }


    fun ended(call: T): T? {
        if (call !== running) return null
        running = waiting.removeFirstOrNull()
        return running
    }


    fun close(): List<T> = waiting.toList().also {
        waiting.clear()
        running = null
    }
}
