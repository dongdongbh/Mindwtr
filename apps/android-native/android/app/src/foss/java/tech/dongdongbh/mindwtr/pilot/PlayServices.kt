package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Context
import org.json.JSONObject


object PlayServices {
    fun installReferrer(context: Context): String? = null
    fun updateInfo(context: Context): JSONObject? = null
    fun reviewAvailable(context: Context): Boolean = false
    fun requestReview(activity: Activity, done: (String?) -> Unit) = done("Store review is not available in this build")
}
