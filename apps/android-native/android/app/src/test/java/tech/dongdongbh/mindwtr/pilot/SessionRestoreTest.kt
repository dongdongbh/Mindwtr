package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN's last-screen restore (pass O2b): each screen names RN's route as RN's router records it (RN's session-restore.ts). */
class SessionRestoreTest {
    private fun route(screen: Screen = Screen.Focus, quick: String = "projects", menu: MenuScreen? = null, tab: String = "done",
        project: String? = null, saved: String? = null, search: Boolean = false) =
        lastRouteOf(screen, quick, menu, tab, project, saved, search)?.let { it.pathname to it.params.toString() }

    @Test fun theTabsAreRnsTabRoutes() {
        assertEquals("/focus" to "{}", route())
        assertEquals("/inbox" to "{}", route(Screen.Inbox))
        assertEquals("/projects" to "{\"projectId\":\"p1\"}", route(Screen.Projects, project = "p1"))
        assertEquals("/review-tab" to "{}", route(Screen.Projects, "review"))
        assertEquals("/contexts-tab" to "{}", route(Screen.Projects, "contexts"))
        assertEquals("/calendar-tab" to "{}", route(Screen.Projects, "calendar"))
    }

    // 921c7c103 and f1b1d6255: the open project and History's tab come back.
    @Test fun menuScreensCarryTheirProjectAndTab() {
        assertEquals("/someday" to "{}", route(menu = MenuScreen.Someday))
        assertEquals("/history" to "{\"tab\":\"archived\"}", route(menu = MenuScreen.History, tab = "archived"))
        assertEquals("/projects-screen" to "{\"projectId\":\"p9\"}", route(menu = MenuScreen.Projects, project = "p9"))
        assertEquals("/saved-search/s1" to "{}", route(menu = MenuScreen.SavedSearch, saved = "s1"))
        assertEquals("/board" to "{}", route(menu = MenuScreen.Board))
    }

    // cad4bd6ed: a transient screen stores nothing, so the previous snapshot (the screen beneath) stays.
    @Test fun transientScreensStoreNothing() {
        for (menu in listOf(MenuScreen.Settings, MenuScreen.Weekly, MenuScreen.Daily, MenuScreen.MindSweep, MenuScreen.WidgetList)) {
            assertNull(menu.name, route(menu = menu))
        }
        assertNull(route(search = true))
        assertNull(route(menu = MenuScreen.SavedSearch, saved = null))
    }
}
