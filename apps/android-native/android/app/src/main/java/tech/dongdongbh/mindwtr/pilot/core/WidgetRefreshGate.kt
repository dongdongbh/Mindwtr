package tech.dongdongbh.mindwtr.pilot.core

/**
 * When the widget build may start on core's one thread. At 5,000 tasks it holds the engine about 186 ms, and a cold start asked
 * for it right after the first screen's content, ahead of that screen's reads and the user's first tap. It waits until no call
 * is queued and none went in for [QUIET_MS], and never longer than [MAX_WAIT_MS] after it was asked for. The caller waits on its
 * own thread (the widget thread, or a CoreWork job that stays running), so a publication is never dropped, only started later.
 */
internal object WidgetRefreshGate {
    const val QUIET_MS = 300L
    const val MAX_WAIT_MS = 2_000L
    private const val POLL_MS = 50L

    /** How long to wait at [now] (uptime ms) before the build: 0 to start it. */
    fun waitMs(now: Long, askedAt: Long, lastCallAt: Long, busy: Boolean): Long {
        val left = askedAt + MAX_WAIT_MS - now
        if (left <= 0) return 0
        val wait = if (busy) POLL_MS else lastCallAt + QUIET_MS - now
        return wait.coerceIn(0, left)
    }
}
