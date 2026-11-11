package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProjectReturnTest {
    @Test fun aProjectOpenedFromAMenuScreenReturnsThere() {
        assertEquals(ProjectReturn(Screen.Inbox, MenuScreen.Someday), projectReturnFrom(Screen.Inbox, MenuScreen.Someday, true, null, null))
        assertEquals(ProjectReturn(Screen.Focus, MenuScreen.Weekly), projectReturnFrom(Screen.Focus, MenuScreen.Weekly, false, null, null))
        assertEquals(ProjectReturn(Screen.Focus, null), projectReturnFrom(Screen.Focus, null, true, null, null))
        assertEquals(ProjectReturn(Screen.Projects, null), projectReturnFrom(Screen.Projects, null, false, null, null))
    }

    @Test fun aProjectOpenedFromTheProjectsListReturnsToTheList() {
        val someday = ProjectReturn(Screen.Inbox, MenuScreen.Someday)
        assertNull(projectReturnFrom(Screen.Projects, null, true, null, someday))
        assertNull(projectReturnFrom(Screen.Inbox, MenuScreen.Projects, false, null, someday))
        assertEquals(someday, projectReturnFrom(Screen.Projects, null, true, "p1", someday))
        assertEquals(someday, projectReturnFrom(Screen.Inbox, MenuScreen.Projects, false, "p1", someday))
    }

    @Test fun aProjectOpenedFromSearchReturnsToTheSearch() {
        val search = SearchState("5600 | x", saveRequestId = "r1")
        val someday = ProjectReturn(Screen.Inbox, MenuScreen.Someday)
        assertEquals(ProjectReturn(Screen.Inbox, MenuScreen.Someday, search), projectReturnFrom(Screen.Inbox, MenuScreen.Someday, false, null, null, search))
        assertEquals(ProjectReturn(Screen.Projects, null, search), projectReturnFrom(Screen.Projects, null, true, null, someday, search))
        assertEquals(ProjectReturn(Screen.Inbox, MenuScreen.Projects, search), projectReturnFrom(Screen.Inbox, MenuScreen.Projects, false, "p1", someday, search))
    }

    @Test fun theReturnSurvivesSavedState() {
        val search = SearchState("5600 | x", saveRequestId = "r1")
        for (back in listOf(ProjectReturn(Screen.Inbox, MenuScreen.Someday), ProjectReturn(Screen.Focus, null), ProjectReturn(Screen.Focus, null, search),
            ProjectReturn(Screen.Projects, MenuScreen.Projects, search), ProjectReturn(Screen.Inbox, null, search.copy(scrollIndex = 7, scrollOffset = 40)), null)) {
            assertEquals(back, projectReturnOf(projectReturnText(back)))
        }
        assertNull(projectReturnOf("Nowhere|Someday"))
        assertNull(projectReturnOf("garbage"))
    }
}
