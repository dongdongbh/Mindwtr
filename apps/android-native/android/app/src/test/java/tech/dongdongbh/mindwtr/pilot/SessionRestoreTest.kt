package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class SessionRestoreTest {
    private fun route(screen: Screen = Screen.Focus, quick: String = "projects", menu: MenuScreen? = null, tab: String = "done",
        project: String? = null, saved: String? = null, search: Boolean = false, sheet: Boolean = false) =
        lastRouteOf(screen, quick, menu, tab, project, saved, search, sheet)?.let { it.pathname to it.params.toString() }

    @Test fun theTabsAreRnsTabRoutes() {
        assertEquals("/focus" to "{}", route())
        assertEquals("/inbox" to "{}", route(Screen.Inbox))
        assertEquals("/projects" to "{\"projectId\":\"p1\"}", route(Screen.Projects, project = "p1"))
        assertEquals("/review-tab" to "{}", route(Screen.Projects, "review"))
        assertEquals("/contexts-tab" to "{}", route(Screen.Projects, "contexts"))
        assertEquals("/calendar-tab" to "{}", route(Screen.Projects, "calendar"))
    }


    @Test fun theMoreSheetIsRnsMenuTab() {
        assertEquals("/menu" to "{}", route(Screen.Inbox, sheet = true))
        assertEquals("/someday" to "{}", route(menu = MenuScreen.Someday, sheet = true))
    }


    @Test fun menuScreensCarryTheirProjectAndTab() {
        assertEquals("/someday" to "{}", route(menu = MenuScreen.Someday))
        assertEquals("/history" to "{\"tab\":\"archived\"}", route(menu = MenuScreen.History, tab = "archived"))
        assertEquals("/projects-screen" to "{\"projectId\":\"p9\"}", route(menu = MenuScreen.Projects, project = "p9"))
        assertEquals("/saved-search/s1" to "{}", route(menu = MenuScreen.SavedSearch, saved = "s1"))
        assertEquals("/board" to "{}", route(menu = MenuScreen.Board))
    }


    @Test fun transientScreensStoreNothing() {
        for (menu in listOf(MenuScreen.Settings, MenuScreen.Weekly, MenuScreen.Daily, MenuScreen.MindSweep, MenuScreen.WidgetList)) {
            assertNull(menu.name, route(menu = menu))
        }
        assertNull(route(search = true))
        assertNull(route(menu = MenuScreen.SavedSearch, saved = null))
    }
}
