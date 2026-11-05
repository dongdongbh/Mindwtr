package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject


internal fun replyValue(result: JSONObject): JSONObject {
    if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
    return if (result.isNull("value")) JSONObject() else result.getJSONObject("value")
}
