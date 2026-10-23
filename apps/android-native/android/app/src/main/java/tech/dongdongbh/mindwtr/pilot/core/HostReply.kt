package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject

/**
 * A host method's reply [result] (CoreHost's calls and long calls): its value, or its error thrown. A method core answers with
 * no value (recordAboutPromptActivity, closeSyncSettings) is an empty object: reading it as one threw after the work was done.
 */
internal fun replyValue(result: JSONObject): JSONObject {
    if (!result.getBoolean("ok")) throw IllegalStateException(result.getString("error"))
    return if (result.isNull("value")) JSONObject() else result.getJSONObject("value")
}
