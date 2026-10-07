package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Context
import org.json.JSONObject

/**
 * The FOSS channel has no Google Play services, as RN's FOSS build has none (its install referrer, in-app update and review
 * modules are removed): no referrer (a FOSS build reads as sideloaded), no Play update answer, no review flow.
 */
object PlayServices {
    fun installReferrer(context: Context): String? = null
    fun updateInfo(context: Context): JSONObject? = null
    fun reviewAvailable(context: Context): Boolean = false
    fun requestReview(activity: Activity, done: (String?) -> Unit) = done("Store review is not available in this build")
}
