package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject

/**
 * RN's last-screen restore (#842; RN's lib/session-restore.ts, core's session-restore.ts, pass O2b): the screen on show, as
 * RN's route path and params, for core to store under `mindwtr:session:lastRoute` in RN's RKStorage (so an RN user who
 * upgrades within the window resumes too). Core decides what is stored and what a cold start reopens; this only names the
 * screen. Null: a screen RN never records (Settings, the review flows, Mind Sweep, a widget list, the global search), so the
 * previous snapshot stays and a death there resumes the screen beneath.
 */
data class LastRoute(val pathname: String, val params: JSONObject = JSONObject())

fun lastRouteOf(
    screen: Screen,
    quickView: String,
    menuScreen: MenuScreen?,
    historyTab: String,
    openProjectId: String?,
    savedSearchId: String?,
    searchOpen: Boolean,
): LastRoute? {
    if (searchOpen) return null
    val project = { JSONObject().apply { openProjectId?.let { put("projectId", it) } } }
    return when (menuScreen) {
        MenuScreen.Waiting -> LastRoute("/waiting")
        MenuScreen.Someday -> LastRoute("/someday")
        MenuScreen.Reference -> LastRoute("/reference")
        MenuScreen.History -> LastRoute("/history", JSONObject().put("tab", historyTab))
        MenuScreen.Contexts -> LastRoute("/contexts")
        MenuScreen.Trash -> LastRoute("/trash")
        MenuScreen.Review -> LastRoute("/review")
        MenuScreen.Projects -> LastRoute("/projects-screen", project())
        MenuScreen.Calendar -> LastRoute("/calendar")
        MenuScreen.Board -> LastRoute("/board")
        MenuScreen.SavedSearch -> savedSearchId?.let { LastRoute("/saved-search/$it") }
        MenuScreen.Settings, MenuScreen.Weekly, MenuScreen.Daily, MenuScreen.MindSweep, MenuScreen.WidgetList -> null
        null -> when (screen) {
            Screen.Focus -> LastRoute("/focus")
            Screen.Inbox -> LastRoute("/inbox")
            Screen.Projects -> when (quickView) {
                "review" -> LastRoute("/review-tab")
                "contexts" -> LastRoute("/contexts-tab")
                "calendar" -> LastRoute("/calendar-tab")
                else -> LastRoute("/projects", project())
            }
        }
    }
}
