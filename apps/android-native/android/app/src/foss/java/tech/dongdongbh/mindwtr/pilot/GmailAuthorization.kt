package tech.dongdongbh.mindwtr.pilot

import android.content.Context
import org.json.JSONObject


class GmailAuthorization(@Suppress("UNUSED_PARAMETER") context: Context) {
    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        if (runCatching { JSONObject(json).optString("op") }.getOrNull() == "status") {
            reply(Result.success(JSONObject().put("available", false).put("connected", false)
                .put("account", JSONObject.NULL).put("accountId", JSONObject.NULL)))
        } else reply(Result.failure(IllegalStateException("E_GMAIL_CONFIG")))
    }
}
