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

    @Test fun theReturnSurvivesSavedState() {
        for (back in listOf(ProjectReturn(Screen.Inbox, MenuScreen.Someday), ProjectReturn(Screen.Focus, null), null)) {
            assertEquals(back, projectReturnOf(projectReturnText(back)))
        }
        assertNull(projectReturnOf("Nowhere|Someday"))
        assertNull(projectReturnOf("garbage"))
    }
}
