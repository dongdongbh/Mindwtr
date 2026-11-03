package tech.dongdongbh.mindwtr.syncfilelock

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition


private class SyncFileLockModuleException(message: String, cause: Throwable? = null) :
  CodedException("ERR_SYNC_FILE_LOCK_UNAVAILABLE", message, cause)


class SyncFileLockModule : Module() {
  private val core = SyncFileLockCore { appContext.reactContext ?: throw Exceptions.ReactContextLost() }

  private fun <T> coded(call: () -> T): T = try {
    call()
  } catch (error: SyncFileLockUnavailableException) {
    throw SyncFileLockModuleException(error.message ?: "SYNC_FILE_LOCK_UNAVAILABLE", error.cause)
  }

  override fun definition() = ModuleDefinition {
    Name("SyncFileLock")


    Constant("httpConnectTimeoutMs") { SyncHttpClientConfig.installedConnectTimeoutMs.toDouble() }

    OnDestroy {
      for (error in core.destroy()) {
        Log.w("SyncFileLock", "Failed to release File Sync lease during module teardown", error)
      }
    }

    AsyncFunction("acquireAsync") { uriValue: String -> coded { core.acquire(uriValue) } }

    AsyncFunction("releaseAsync") { token: String -> coded { core.release(token) } }

    AsyncFunction("revalidateAsync") { token: String -> coded { core.revalidate(token) } }
  }
}
