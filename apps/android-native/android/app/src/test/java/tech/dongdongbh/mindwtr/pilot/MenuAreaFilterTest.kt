package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class MenuAreaFilterTest {
    @Test fun theFilteredListsShowTheAreaFilter() {
        val shown = MenuScreen.entries.filter(::showsAreaFilter).toSet()
        assertEquals(setOf(MenuScreen.Waiting, MenuScreen.Someday, MenuScreen.Reference, MenuScreen.History, MenuScreen.Contexts,
            MenuScreen.Trash, MenuScreen.Review, MenuScreen.Projects, MenuScreen.Calendar, MenuScreen.Board, MenuScreen.SavedSearch), shown)
    }
}
