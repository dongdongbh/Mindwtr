package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * RN's AREA_FILTERED_ROUTES (#1448): a list screen outside the tabs whose list follows the area filter shows the filter in its
 * header, so a task it hides has a visible reason. A widget list keeps its widget's scope, and Settings has no list to filter.
 */
class MenuAreaFilterTest {
    @Test fun theFilteredListsShowTheAreaFilter() {
        val shown = MenuScreen.entries.filter(::showsAreaFilter).toSet()
        assertEquals(setOf(MenuScreen.Waiting, MenuScreen.Someday, MenuScreen.Reference, MenuScreen.History, MenuScreen.Contexts,
            MenuScreen.Trash, MenuScreen.Review, MenuScreen.Projects, MenuScreen.Calendar, MenuScreen.Board, MenuScreen.SavedSearch), shown)
    }
}
