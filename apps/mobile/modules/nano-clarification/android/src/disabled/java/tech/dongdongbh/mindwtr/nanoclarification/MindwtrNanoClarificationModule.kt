package tech.dongdongbh.mindwtr.nanoclarification

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Same safe bridge surface for every build that does not opt into ML Kit. */
class MindwtrNanoClarificationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name(NANO_MODULE_NAME)

    AsyncFunction("getCapability") { _: String ->
      NanoCapability.unavailable(NanoFailureReason.BUILD_DISABLED).toBridgeValue()
    }

    AsyncFunction("downloadModel") { _: String, _: String, promise: Promise ->
      promise.reject(NanoBridgeException(NanoFailureReason.BUILD_DISABLED))
    }

    AsyncFunction("clarifyInbox") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(NanoBridgeException(NanoFailureReason.BUILD_DISABLED))
    }

    AsyncFunction("cancelRequest") { _: String -> Unit }
  }
}
