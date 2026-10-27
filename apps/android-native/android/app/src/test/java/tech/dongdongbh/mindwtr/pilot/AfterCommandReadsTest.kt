package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test
import tech.dongdongbh.mindwtr.pilot.AfterCommandReads.Read

/**
 * After a command, core (one call at a time) answers the screen on show first: at 5,000 tasks a save's row waited behind a
 * hidden Focus read (105 ms) and its Pomodoro read (50 ms). Every hidden list is still read after every command.
 */
class AfterCommandReadsTest {
    private class Recorder {
        val started = mutableListOf<Read>()
        val pending = mutableListOf<Pair<Read, () -> Unit>>()
        val start: (Read, () -> Unit) -> Unit = { read, done -> started += read; pending += read to done }
        fun answer(read: Read) { pending.first { it.first == read }.also { pending.remove(it) }.second() }
    }

    @Test fun theInboxRowsComeFirstThenEveryOtherList() {
        val order = AfterCommandReads.order(Screen.Inbox, menuOnShow = true, searchOpen = false)
        assertEquals(listOf(setOf(Read.Menu), setOf(Read.AllLists)), order)
        val recorder = Recorder()
        AfterCommandReads.run(order, recorder.start)
        // Only the visible read is queued until it answers.
        assertEquals(listOf(Read.Menu), recorder.started)
        recorder.answer(Read.Menu)
        assertEquals(listOf(Read.Menu, Read.AllLists), recorder.started)
    }

    @Test fun focusOnShowReadsFocusFirstThenProjectsAndTheMenuList() {
        assertEquals(listOf(setOf(Read.Focus), setOf(Read.Projects, Read.Menu)),
            AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = false))
        assertEquals(listOf(setOf(Read.Projects), setOf(Read.Focus, Read.Menu)),
            AfterCommandReads.order(Screen.Projects, menuOnShow = false, searchOpen = false))
        // A Menu screen open over Focus is what is on screen.
        assertEquals(listOf(setOf(Read.Menu), setOf(Read.AllLists)), AfterCommandReads.order(Screen.Focus, menuOnShow = true, searchOpen = false))
    }

    @Test fun anOpenSearchIsReadFirst() {
        assertEquals(listOf(setOf(Read.Search), setOf(Read.AllLists, Read.Menu)),
            AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = true))
    }

    @Test fun aFailedVisibleReadStillLetsTheHiddenListsRead() {
        val recorder = Recorder()
        AfterCommandReads.run(AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = false), recorder.start)
        // A failure answers too (done is called on either outcome).
        recorder.answer(Read.Focus)
        assertEquals(setOf(Read.Projects, Read.Menu), recorder.started.drop(1).toSet())
    }

    @Test fun backToBackCommandsLoseNoHiddenRead() {
        val recorder = Recorder()
        val order = AfterCommandReads.order(Screen.Inbox, menuOnShow = true, searchOpen = false)
        AfterCommandReads.run(order, recorder.start)
        AfterCommandReads.run(order, recorder.start)
        recorder.answer(Read.Menu)
        recorder.answer(Read.Menu)
        // Each command's hidden read is queued once its own visible read answered: two, none dropped.
        assertEquals(2, recorder.started.count { it == Read.AllLists })
    }

    @Test fun theReadsAfterACommandStartNoWidgetReminderOrBadgeWork() {
        // Widgets, reminders and the sync badge follow the write inside core (the store's subscription and timers), not these
        // reads: no step of the order is one of them, so reordering the reads cannot move them.
        val reads = Screen.entries.flatMap { screen -> listOf(true, false).flatMap { menu -> listOf(true, false).flatMap { search ->
            AfterCommandReads.order(screen, menu, search).flatten() } } }.toSet()
        assertEquals(setOf(Read.Menu, Read.AllLists, Read.Focus, Read.Projects, Read.Search), reads)
    }
}
