package tech.dongdongbh.mindwtr.pilot

import android.os.Handler
import android.os.Looper
import org.json.JSONObject


private val main = Handler(Looper.getMainLooper())
private var tokenTyped = 0


internal fun tokenQuery(open: JSONObject): String? = open.optString("text").takeIf { it.isNotBlank() }


internal fun MenuModel.dialogInputs(list: String, into: JSONObject) {
    val open = dialog ?: return
    if (list == "review" && open.optString("kind") == "organize") {
        into.put("organize", JSONObject().put("draft", open.optJSONObject("draft") ?: JSONObject()))
        open.menuText("picker")?.let { kind -> into.put("picker", JSONObject().put("kind", kind).apply { open.menuText("query")?.let { put("query", it) } }) }
        return
    }
    if (open.optString("kind") != "tokens" || open.optString("list") != list) return
    val query = tokenQuery(open) ?: return
    into.put("picker", (if (list == "review") JSONObject().put("kind", "removeTag") else JSONObject().put("field", open.getString("field")).put("mode", open.getString("mode")))
        .put("query", query))
}


internal fun MenuModel.typeToken(next: JSONObject) {
    keepDialog(next)
    val mine = ++tokenTyped
    main.postDelayed({ if (mine == tokenTyped) reload() }, 200)
}


internal fun MenuModel.closeSelectionDialogs(list: String) {
    val open = dialog ?: return
    if (open.optString("kind") in setOf("organize", "reviewMove", "reviewTag") || (open.optString("kind") == "tokens" && open.optString("list") == list)) keepDialog(null)
}
