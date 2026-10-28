package tech.dongdongbh.mindwtr.pilot

import android.content.Context
import org.json.JSONObject

/**
 * The FOSS channel has no Gmail authorization, as RN's FOSS build removes its module (scripts/fdroid_strip_deps.js): status answers
 * `available: false`, so Settings shows RN's "Gmail is unavailable" line, and every other call fails with RN's CONFIG code.
 */
class GmailAuthorization(@Suppress("UNUSED_PARAMETER") context: Context) {
    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        if (runCatching { JSONObject(json).optString("op") }.getOrNull() == "status") {
            reply(Result.success(JSONObject().put("available", false).put("connected", false)
                .put("account", JSONObject.NULL).put("accountId", JSONObject.NULL)))
        } else reply(Result.failure(IllegalStateException("E_GMAIL_CONFIG")))
    }
}
