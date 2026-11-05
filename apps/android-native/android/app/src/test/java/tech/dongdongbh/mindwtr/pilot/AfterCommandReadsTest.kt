package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test
import tech.dongdongbh.mindwtr.pilot.AfterCommandReads.Read


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

        assertEquals(listOf(Read.Menu), recorder.started)
        recorder.answer(Read.Menu)
        assertEquals(listOf(Read.Menu, Read.AllLists), recorder.started)
    }

    @Test fun focusOnShowReadsFocusFirstThenProjectsAndTheMenuList() {
        assertEquals(listOf(setOf(Read.Focus), setOf(Read.Projects, Read.Menu)),
            AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = false))
        assertEquals(listOf(setOf(Read.Projects), setOf(Read.Focus, Read.Menu)),
            AfterCommandReads.order(Screen.Projects, menuOnShow = false, searchOpen = false))

        assertEquals(listOf(setOf(Read.Menu), setOf(Read.AllLists)), AfterCommandReads.order(Screen.Focus, menuOnShow = true, searchOpen = false))
    }

    @Test fun anOpenSearchIsReadFirst() {
        assertEquals(listOf(setOf(Read.Search), setOf(Read.AllLists, Read.Menu)),
            AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = true))
    }

    @Test fun aFailedVisibleReadStillLetsTheHiddenListsRead() {
        val recorder = Recorder()
        AfterCommandReads.run(AfterCommandReads.order(Screen.Focus, menuOnShow = false, searchOpen = false), recorder.start)

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

        assertEquals(2, recorder.started.count { it == Read.AllLists })
    }

    @Test fun theReadsAfterACommandStartNoWidgetReminderOrBadgeWork() {


        val reads = Screen.entries.flatMap { screen -> listOf(true, false).flatMap { menu -> listOf(true, false).flatMap { search ->
            AfterCommandReads.order(screen, menu, search).flatten() } } }.toSet()
        assertEquals(setOf(Read.Menu, Read.AllLists, Read.Focus, Read.Projects, Read.Search), reads)
    }
}
