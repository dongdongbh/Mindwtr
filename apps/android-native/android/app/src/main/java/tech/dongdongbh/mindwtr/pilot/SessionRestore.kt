package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject


data class LastRoute(val pathname: String, val params: JSONObject = JSONObject())

fun lastRouteOf(
    screen: Screen,
    quickView: String,
    menuScreen: MenuScreen?,
    historyTab: String,
    openProjectId: String?,
    savedSearchId: String?,
    searchOpen: Boolean,
    sheetOpen: Boolean = false,
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

        null -> if (sheetOpen) LastRoute("/menu") else when (screen) {
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
