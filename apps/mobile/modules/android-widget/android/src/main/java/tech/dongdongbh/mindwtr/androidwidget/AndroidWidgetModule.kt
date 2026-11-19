package tech.dongdongbh.mindwtr.androidwidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Queues
import android.app.Activity
import android.view.View
import android.view.ViewGroup
import com.facebook.react.views.modal.ReactModalHostView

class AndroidWidgetModule : Module() {
  companion object {

    fun suppressWidgetModalExitAnimations(activity: Activity) {
      if (WidgetLaunchCover.snapshot()?.get("stage") != "pending") return
      fun visit(view: View) {
        if (view is ReactModalHostView) view.dialog?.window?.let(WidgetLaunchCover::suppressExitAnimation)
        if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
      }
      visit(activity.window.decorView)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MindwtrAndroidWidget")

    Function("getWidgetLaunchState") { WidgetLaunchCover.snapshot() }
    AsyncFunction("completeWidgetLaunch") { token: Int -> WidgetLaunchCover.complete(token) }.runOnQueue(Queues.MAIN)

    Function("setPayload") { json: String ->
      val context = checkNotNull(appContext.reactContext) { "Widget publication requires an Android context" }

      check(WidgetPayloadStore.write(context, json)) { "Widget payload not stored" }
    }

    Function("updateWidgets") {
      val context = checkNotNull(appContext.reactContext) { "Widget refresh requires an Android context" }
      val result = WidgetRenderer.refreshAll(context)
      val hiddenCheckoffCount = CheckoffStore.consumeHiddenCount(context)
      val serializedCheckoffCount = CheckoffStore.consumeSerializedCount(context)
      val heldCheckoffCount = CheckoffStore.consumeHeldCount(context)
      mapOf(
        "legacyWidgetCount" to result.legacyWidgetCount,
        "compactWidgetCount" to result.compactWidgetCount,
        "hiddenCheckoffCount" to hiddenCheckoffCount,
        "serializedCheckoffCount" to serializedCheckoffCount,
        "heldCheckoffCount" to heldCheckoffCount,
        "directCollectionCount" to result.directCollectionCount,
        "renderedTaskCount" to result.renderedTaskCount,
        "eligibleTaskCount" to result.eligibleTaskCount,
        "collectionBytes" to result.collectionBytes,
      )
    }

    Function("getWidgetListSelections") {
      appContext.reactContext?.let { WidgetListStore.selections(it) } ?: emptyList<String>()
    }

    AsyncFunction("getCaptureIntentConfig") {
      val context = appContext.reactContext
        ?: throw IllegalStateException("Capture intent is unavailable without an Android application context")
      CaptureIntentConfigStore.read(context).toBridgeValue()
    }

    AsyncFunction("setCaptureIntentEnabled") { enabled: Boolean ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Capture intent is unavailable without an Android application context")
      CaptureIntentConfigStore.setEnabled(context, enabled).toBridgeValue()
    }
  }
}
