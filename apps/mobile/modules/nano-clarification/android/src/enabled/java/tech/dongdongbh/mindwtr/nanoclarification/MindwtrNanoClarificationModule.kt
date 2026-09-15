package tech.dongdongbh.mindwtr.nanoclarification

import android.app.Activity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MindwtrNanoClarificationModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val backendDelegate = lazy { MlKitNanoClarificationBackend() }
  private val backend by backendDelegate
  private val coordinator = NanoOperationCoordinator(scope, ::hasForegroundActivity)

  override fun definition() = ModuleDefinition {
    Name(NANO_MODULE_NAME)

    AsyncFunction("getCapability") { locale: String, promise: Promise ->
      val parsedLocale = try {
        NanoClarificationRequest.parseLocale(locale)
      } catch (_: NanoFailure) {
        promise.resolve(NanoCapability.unavailable(NanoFailureReason.LOCALE_NOT_SUPPORTED).toBridgeValue())
        return@AsyncFunction
      }
      if (!coordinator.isRunnable()) {
        promise.resolve(NanoCapability.unavailable(NanoFailureReason.BACKGROUND_BLOCKED).toBridgeValue())
        return@AsyncFunction
      }
      scope.launch {
        val capability = try {
          backend.getCapability(parsedLocale)
        } catch (_: Throwable) {
          NanoCapability.unavailable(NanoFailureReason.UNKNOWN)
        }
        promise.resolve(capability.toBridgeValue())
      }
    }

    AsyncFunction("downloadModel") { requestId: String, locale: String, promise: Promise ->
      val parsedRequestId: String
      val parsedLocale: String
      try {
        parsedRequestId = NanoClarificationRequest.parseRequestId(requestId)
        parsedLocale = NanoClarificationRequest.parseLocale(locale)
      } catch (error: NanoFailure) {
        promise.reject(NanoBridgeException(error.reason))
        return@AsyncFunction
      }
      coordinator.start(
        requestId = parsedRequestId,
        operation = { backend.downloadModel(parsedLocale) },
        onSuccess = { promise.resolve(it.toBridgeValue()) },
        onFailure = { promise.reject(NanoBridgeException(it)) },
      )
    }

    AsyncFunction("clarifyInbox") { raw: Map<String, Any?>, promise: Promise ->
      val request = try {
        NanoClarificationRequest.parse(raw)
      } catch (error: NanoFailure) {
        promise.reject(NanoBridgeException(error.reason))
        return@AsyncFunction
      }
      val prompt = NanoPromptBuilder.build(request)
      coordinator.start(
        requestId = request.requestId,
        operation = { backend.clarify(prompt) },
        onSuccess = promise::resolve,
        onFailure = { promise.reject(NanoBridgeException(it)) },
      )
    }

    AsyncFunction("cancelRequest") { requestId: String ->
      try {
        coordinator.cancel(NanoClarificationRequest.parseRequestId(requestId))
      } catch (error: NanoFailure) {
        throw NanoBridgeException(error.reason)
      }
    }

    OnCreate {
      coordinator.setForeground(hasForegroundActivity())
    }

    OnActivityEntersForeground {
      coordinator.setForeground(true)
    }

    OnActivityEntersBackground {
      coordinator.setForeground(false)
    }

    OnActivityDestroys {
      coordinator.setForeground(false)
    }

    OnDestroy {
      coordinator.shutdown()
      if (backendDelegate.isInitialized()) backend.close()
      scope.cancel()
    }
  }

  private fun hasForegroundActivity(): Boolean {
    val activity = appContext.currentActivity ?: return false
    return activity.isUsableHost()
  }

  private fun Activity.isUsableHost(): Boolean = !isFinishing && !isDestroyed
}
