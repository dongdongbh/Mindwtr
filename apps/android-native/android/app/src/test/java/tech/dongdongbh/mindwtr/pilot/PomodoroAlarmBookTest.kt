package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** PomodoroAlarmBook (PomodoroAlarms.kt): what Android cannot list for core's Pomodoro plan (design R2b §3b). */
class PomodoroAlarmBookTest {
    private val disk = mutableMapOf<String, String>()
    private var failWrites = false
    private val book = PomodoroAlarmBook(read = { disk.toMap() }, write = { changes ->
        if (!failWrites) changes.forEach { (key, value) -> if (value == null) disk.remove(key) else disk[key] = value }
        !failWrites
    })
    private val scope = PomodoroAlarmBook.scope("tech.dongdongbh.mindwtr.nativeclient.dev")
    private val now = 1_800_000_000_000L
    private fun occurrence(phase: String = "focus", fireAtMs: Long = now - 1_000, session: String = "11111111-1111-4111-8111-111111111111") =
        PomodoroOccurrence(PomodoroAlarmBook.identifier(scope, session, phase, fireAtMs), scope, session, phase, fireAtMs)
    private fun ids(list: org.json.JSONArray) = (0 until list.length()).map { list.getJSONObject(it).getString("identifier") }

    @Test
    fun `gives core the identity format its planner accepts, a new id for each session, phase and end`() {
        assertTrue(scope.matches(Regex("^[a-zA-Z0-9._-]{1,255}:[a-f0-9]{64}$")))
        val first = occurrence()
        assertTrue(first.identifier.matches(Regex("^mindwtr-native-pomodoro:[a-f0-9]{64}$")))
        assertEquals(first.identifier, occurrence().identifier)
        for (other in listOf(occurrence(phase = "break"), occurrence(fireAtMs = now), occurrence(session = "22222222-2222-4222-8222-222222222222")))
            assertNotEquals(first.identifier, other.identifier)
    }

    @Test
    fun `reports an armed alert as pending only while AlarmManager holds it, and as delivered once shown`() {
        val armed = occurrence()
        book.arm(armed)
        assertEquals(listOf(armed.identifier), ids(book.inventories(held = { true }, shown = emptySet()).first))
        // Force-stop or reboot dropped its PendingIntent: neither inventory, so core may arm it again.
        val dropped = book.inventories(held = { false }, shown = emptySet())
        assertEquals(emptyList<String>(), ids(dropped.first) + ids(dropped.second))
        // Shown and still in the tray before its ledger write would be odd, but it still counts as delivered.
        assertEquals(listOf(armed.identifier), ids(book.inventories(held = { true }, shown = setOf(armed.identifier)).second))
        assertTrue(book.deliver(armed, now))
        val after = book.inventories(held = { true }, shown = emptySet())
        assertEquals(emptyList<String>(), ids(after.first))
        // Dismissed from the tray, it stays delivered: the ledger keeps it.
        assertEquals(listOf(armed.identifier), ids(after.second))
    }

    @Test
    fun `shows an alert once and never more than a day late, with the ledger written before the post`() {
        val due = occurrence()
        assertTrue(book.deliver(due, now))
        assertFalse(book.deliver(due, now + 5_000))
        val stale = occurrence(fireAtMs = now - PomodoroAlarmBook.LATE_LIMIT_MS - 1)
        assertFalse(book.deliver(stale, now))
        assertTrue(book.deliver(occurrence(fireAtMs = now - PomodoroAlarmBook.LATE_LIMIT_MS), now))
        // A ledger that cannot be written shows nothing (a loss, never a duplicate).
        failWrites = true
        assertThrowsIllegalState { book.deliver(occurrence(phase = "break"), now) }
    }

    @Test
    fun `keeps RN's owed alert out of core's inventories but in the ledger`() {
        val rn = PomodoroOccurrence("rn:${now - 1_000}:focus-complete", scope, "", "focus-complete", now - 1_000)
        assertTrue(book.deliver(rn, now))
        assertFalse(book.deliver(rn, now))
        val (pending, delivered) = book.inventories(held = { true }, shown = emptySet())
        assertEquals(0, pending.length() + delivered.length())
    }

    @Test
    fun `prunes only what is two days past its time`() {
        val recent = occurrence(fireAtMs = now - PomodoroAlarmBook.KEEP_MS)
        val old = occurrence(fireAtMs = now - PomodoroAlarmBook.KEEP_MS - 1, phase = "break")
        book.deliver(recent, recent.fireAtMs)
        book.deliver(old, old.fireAtMs)
        book.arm(occurrence(fireAtMs = now - PomodoroAlarmBook.KEEP_MS - 5, session = "33333333-3333-4333-8333-333333333333"))
        book.saveRecord("{}")
        book.prune(now)
        assertTrue(book.fired(recent.identifier))
        assertFalse(book.fired(old.identifier))
        assertEquals(emptyList<PomodoroOccurrence>(), book.armed())
        assertEquals("{}", book.record())
    }

    @Test
    fun `stores the record and the upgrade time, and refuses to go on when the disk refused`() {
        assertNull(book.record())
        book.saveRecord("{\"version\":1}")
        book.saveUpgradedAt(now)
        assertEquals("{\"version\":1}", book.record())
        assertEquals(now, book.upgradedAt())
        failWrites = true
        assertThrowsIllegalState { book.saveRecord("{}") }
        assertThrowsIllegalState { book.arm(occurrence()) }
    }

    private fun assertThrowsIllegalState(block: () -> Unit) {
        try { block() } catch (expected: IllegalStateException) { return }
        throw AssertionError("expected IllegalStateException")
    }
}
