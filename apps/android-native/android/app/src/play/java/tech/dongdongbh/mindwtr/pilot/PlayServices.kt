package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Context
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.review.ReviewManagerFactory
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit


object PlayServices {
    private const val WAIT_S = 20L
    private const val PLAY_STORE_PACKAGE = "com.android.vending"


    fun installReferrer(context: Context): String? {
        val client = InstallReferrerClient.newBuilder(context).build()
        val latch = CountDownLatch(1)
        var referrer: String? = null
        runCatching {
            client.startConnection(object : InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    if (responseCode == InstallReferrerClient.InstallReferrerResponse.OK) {
                        referrer = runCatching { client.installReferrer.installReferrer ?: "" }.getOrNull()
                    }
                    runCatching { client.endConnection() }
                    latch.countDown()
                }
                override fun onInstallReferrerServiceDisconnected() = latch.countDown()
            })
        }.onFailure { return null }
        latch.await(WAIT_S, TimeUnit.SECONDS)
        return referrer
    }


    fun updateInfo(context: Context): JSONObject? {
        val latch = CountDownLatch(1)
        var answer = JSONObject().put("error", "Unable to query Play Store update availability.")
        runCatching {
            AppUpdateManagerFactory.create(context).appUpdateInfo
                .addOnSuccessListener { info ->
                    val availability = info.updateAvailability()
                    answer = JSONObject().put("value", JSONObject()
                        .put("updateAvailable", availability == UpdateAvailability.UPDATE_AVAILABLE
                            || availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS)
                        .put("availableVersionCode", info.availableVersionCode()))
                    latch.countDown()
                }
                .addOnFailureListener { latch.countDown() }
        }.onFailure { latch.countDown() }
        latch.await(WAIT_S, TimeUnit.SECONDS)
        return answer
    }


    fun reviewAvailable(context: Context): Boolean = runCatching { context.packageManager.getPackageInfo(PLAY_STORE_PACKAGE, 0); true }.getOrDefault(false)


    fun requestReview(activity: Activity, done: (String?) -> Unit) {
        runCatching {
            val manager = ReviewManagerFactory.create(activity)
            manager.requestReviewFlow().addOnCompleteListener { request ->
                if (!request.isSuccessful) return@addOnCompleteListener done("Android ReviewManager task was not successful")
                manager.launchReviewFlow(activity, request.result).addOnCompleteListener { flow ->
                    done(if (flow.isSuccessful) null else "Android ReviewManager task failed")
                }
            }
        }.onFailure { done(it.message ?: it.javaClass.simpleName) }
    }
}
