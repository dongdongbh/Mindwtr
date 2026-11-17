package tech.dongdongbh.mindwtr.pilot


internal class WindowLoad<T : Any> {
    private var from: T? = null

    fun begin(base: T): Boolean = (from !== base).also { if (it) from = base }

    fun loading(base: T): Boolean = from === base

    fun end(base: T) { if (from === base) from = null }

    fun lands(base: T, current: T?, moved: Boolean): Boolean = moved && current === base
}
