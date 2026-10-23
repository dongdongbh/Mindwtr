package tech.dongdongbh.mindwtr.syncfilelock

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Expo names a rejection by its class; this keeps the code the module rejected with before SyncFileLockCore.
private class SyncFileLockModuleException(message: String, cause: Throwable? = null) :
  CodedException("ERR_SYNC_FILE_LOCK_UNAVAILABLE", message, cause)

/** React Native's SyncFileLock module: SyncFileLockCore behind Expo, its refusals as coded errors with the same text. */
class SyncFileLockModule : Module() {
  private val core = SyncFileLockCore { appContext.reactContext ?: throw Exceptions.ReactContextLost() }

  private fun <T> coded(call: () -> T): T = try {
    call()
  } catch (error: SyncFileLockUnavailableException) {
    throw SyncFileLockModuleException(error.message ?: "SYNC_FILE_LOCK_UNAVAILABLE", error.cause)
  }

  override fun definition() = ModuleDefinition {
    Name("SyncFileLock")

    // Proof for the startup log that SyncHttpClientPackage installed the bounded
    // connect timeout before any request was made (#1150).
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
