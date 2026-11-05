package tech.dongdongbh.mindwtr.pilot.core


internal object WidgetRefreshGate {
    const val QUIET_MS = 300L
    const val MAX_WAIT_MS = 2_000L
    const val POLL_MS = 50L


    fun waitMs(now: Long, askedAt: Long, lastCallAt: Long, busy: Boolean): Long {
        val left = askedAt + MAX_WAIT_MS - now
        if (left <= 0) return 0
        val wait = if (busy) POLL_MS else lastCallAt + QUIET_MS - now
        return wait.coerceIn(0, left)
    }


    fun await(now: () -> Long, sleep: (Long) -> Unit, lastCallAt: () -> Long, busy: () -> Boolean, stop: () -> Boolean = { false },
              askedAt: Long = now()): String {
        while (!stop()) {
            if (now() >= askedAt + MAX_WAIT_MS) return "bound"
            val wait = waitMs(now(), askedAt, lastCallAt(), busy())
            if (wait <= 0) return "quiet"
            sleep(wait.coerceAtMost(POLL_MS))
        }
        return "left"
    }
}
