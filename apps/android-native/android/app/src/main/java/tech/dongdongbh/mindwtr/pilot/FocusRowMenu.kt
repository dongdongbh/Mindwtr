package tech.dongdongbh.mindwtr.pilot

import android.app.DatePickerDialog
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.GregorianCalendar


data class FocusMenuIds(val defer: List<String>, val review: List<String>)


class FocusRowMenus(private val defer: JSONObject, private val review: JSONObject) {
    fun forRow(taskId: String, reviewDue: Boolean): FocusRowMenu? = when {
        reviewDue && review.has(taskId) -> FocusRowMenu.Review(review.getJSONObject(taskId))
        defer.has(taskId) -> FocusRowMenu.Defer(taskId, defer.getJSONObject(taskId))
        else -> null
    }
}


sealed class FocusRowMenu {
    abstract val label: String

    data class Review(val menu: JSONObject) : FocusRowMenu() {
        override val label: String get() = menu.menuObjects("options").first().getString("label")
    }

    data class Defer(val taskId: String, val menu: JSONObject) : FocusRowMenu() {
        override val label: String get() = menu.getString("title")
    }

    data class Custom(val taskId: String, val menu: JSONObject) : FocusRowMenu() {
        override val label: String get() = menu.getJSONObject("custom").getString("label")
    }
}


fun focusMenuIds(view: FocusView?): FocusMenuIds {
    val sections = view?.sections.orEmpty()
    fun rows(review: Boolean) = sections.flatMap { section -> if ((section.key == "reviewDue") == review) section.rows.map { it.id } else emptyList() }
        .toSet().toList().take(500)
    return FocusMenuIds(rows(review = false), rows(review = true))
}


fun focusRowActions(menus: FocusRowMenus?, task: TaskRow, reviewDue: Boolean, show: (FocusRowMenu) -> Unit): RowActions? =
    menus?.forRow(task.id, reviewDue)?.let { menu -> RowActions(longPressLabel = menu.label, longPress = { show(menu) }) }


private fun menusInput(deferIds: List<String>, reviewIds: List<String>) =
    JSONObject().put("deferIds", JSONArray(deferIds)).put("reviewIds", JSONArray(reviewIds))


internal fun InboxViewModel.readFocusRowMenus(ids: FocusMenuIds, apply: (FocusRowMenus) -> Unit) =
    background(emptyList(), { runtime -> runtime.menuRead("focusRowMenus", menusInput(ids.defer, ids.review).toString()) }) { reply, _ ->
        apply(FocusRowMenus(reply.getJSONObject("defer"), reply.getJSONObject("review")))
    }


private fun datesSave(taskId: String, base: JSONObject, draft: JSONObject, refocus: Boolean) = JSONObject().put("taskId", taskId)
    .put("base", base).put("draft", draft).put("defer", JSONObject().put("refocus", refocus))


internal fun InboxViewModel.deferFocusTask(taskId: String, deferMenu: JSONObject, option: JSONObject) {
    val base = deferMenu.getJSONObject("base")
    val draft = option.getJSONObject("draft")
    menu.command("taskDatesSave", datesSave(taskId, base, draft, refocus = false))
    menu.whenIdle {
        background(emptyList(), { runtime -> runtime.menuRead("taskDates", JSONObject().put("taskId", taskId).toString()).getJSONObject("sheet") }) { sheet, _ ->
            if (sheet.getJSONObject("base").toString() != draft.toString()) return@background
            val toast = option.getJSONObject("toast")
            showToast(toast.getString("title"), toast.getString("message"), "info", t("common.undo"), 5_200) {
                menu.whenIdle { menu.command("taskDatesSave", datesSave(taskId, draft, base, option.getBoolean("refocus"))) }
            }
        }
    }
}


internal fun InboxViewModel.pickFocusDefer(open: FocusRowMenu.Custom, day: String) =
    background(emptyList(), { runtime ->
        runtime.menuRead("focusRowMenus", menusInput(listOf(open.taskId), emptyList()).put("day", day).toString()).getJSONObject("pick")
    }) { pick, _ ->
        val option = pick.optJSONObject("option")
        if (option == null) showToast(t("common.error"), pick.getString("issue"), "error", durationMs = 4_200)
        else deferFocusTask(open.taskId, open.menu, option)
    }


private fun pickerMillis(day: String?): Long? = pickerStart(day)?.let { (year, month, date) -> GregorianCalendar(year, month, date).timeInMillis }


@Composable
fun FocusRowMenuDialog(model: InboxViewModel, open: FocusRowMenu, close: (FocusRowMenu?) -> Unit) {
    when (open) {
        is FocusRowMenu.Review -> MenuAlert(open.menu.getString("title"), null, open.menu.menuObjects("options").map { option ->
            option.getString("label") to { model.menu.act("reviewAction", option.getJSONObject("action")) }
        }, open.menu.getString("cancel"), close)
        is FocusRowMenu.Defer -> MenuAlert(open.menu.getString("title"), open.menu.getString("message"), open.menu.menuObjects("options").map { option ->
            option.getString("label") to { model.deferFocusTask(open.taskId, open.menu, option) }
        } + (FocusRowMenu.Custom(open.taskId, open.menu).let { custom -> custom.label to { close(custom) } }), open.menu.getString("cancel"), close)
        is FocusRowMenu.Custom -> {
            val context = LocalContext.current
            val dark = LocalTheme.current.isDark
            val custom = open.menu.getJSONObject("custom")
            DisposableEffect(open, dark) {
                val dialog = DatePickerDialog(systemDialogContext(context, dark))
                pickerMillis(custom.getString("min"))?.let { dialog.datePicker.minDate = it }
                pickerMillis(custom.menuText("max"))?.let { dialog.datePicker.maxDate = it }
                dialog.setOnDateSetListener { _, year, month, day -> model.pickFocusDefer(open, pickedDay(year, month, day)) }
                dialog.setOnDismissListener { close(null) }
                dialog.show()
                onDispose { dialog.setOnDismissListener(null); dialog.dismiss() }
            }
        }
    }
}


@Composable
private fun MenuAlert(title: String, message: String?, choices: List<Pair<String, () -> Unit>>, cancel: String, close: (FocusRowMenu?) -> Unit) =
    ThemedAlert(title, message, choices.map { (label, choose) -> AlertButton(label, "default") { close(null); choose() } } +
        AlertButton(cancel, "cancel") { close(null) }) { close(null) }
