package tech.dongdongbh.mindwtr.playstoreupdates

import android.content.Context
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PlayStoreUpdatesModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PlayStoreUpdates")

    AsyncFunction("getUpdateInfoAsync") { promise: Promise ->
      val appUpdateManager = AppUpdateManagerFactory.create(context)
      appUpdateManager.appUpdateInfo
        .addOnSuccessListener { appUpdateInfo ->
          val availability = appUpdateInfo.updateAvailability()
          val availabilityLabel = when (availability) {
            UpdateAvailability.UPDATE_AVAILABLE -> "available"
            UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS -> "in-progress"
            UpdateAvailability.UPDATE_NOT_AVAILABLE -> "not-available"
            else -> "unknown"
          }
          val installStatus = appUpdateInfo.installStatus()
          val installStatusLabel = when (installStatus) {
            InstallStatus.PENDING -> "pending"
            InstallStatus.DOWNLOADING -> "downloading"
            InstallStatus.DOWNLOADED -> "downloaded"
            InstallStatus.INSTALLING -> "installing"
            InstallStatus.INSTALLED -> "installed"
            InstallStatus.FAILED -> "failed"
            InstallStatus.CANCELED -> "canceled"
            InstallStatus.REQUIRES_UI_INTENT -> "requires-ui-intent"
            InstallStatus.UNKNOWN -> "unknown"
            else -> "unknown"
          }
          promise.resolve(
            mapOf(
              "availability" to availabilityLabel,
              "availabilityCode" to availability,
              "installStatus" to installStatusLabel,
              "installStatusCode" to installStatus,
              "updateAvailable" to (
                availability == UpdateAvailability.UPDATE_AVAILABLE ||
                  availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
                ),
              "availableVersionCode" to appUpdateInfo.availableVersionCode(),
              "clientVersionStalenessDays" to appUpdateInfo.clientVersionStalenessDays(),
              "updatePriority" to appUpdateInfo.updatePriority(),
              "immediateUpdateAllowed" to appUpdateInfo.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
              "flexibleUpdateAllowed" to appUpdateInfo.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)
            )
          )
        }
        .addOnFailureListener { error ->
          promise.reject("ERR_PLAY_STORE_UPDATES", "Unable to query Play Store update availability.", error)
        }
    }
  }
}
