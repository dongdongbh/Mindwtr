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
    /** Runs in MainActivity before URL delivery and after RN host resume; no editor state or task data is read. */
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
      val context = appContext.reactContext ?: return@Function
      // A payload that did not reach the disk fails the call, so widget-service.ts publishes it again.
      check(WidgetPayloadStore.write(context, json)) { "Widget payload not stored" }
    }

    Function("updateWidgets") {
      val context = appContext.reactContext
      val result = context?.let { WidgetRenderer.refreshAll(it) } ?: WidgetRenderer.RefreshResult()
      val hiddenCheckoffCount = context?.let { CheckoffStore.consumeHiddenCount(it) } ?: 0
      val serializedCheckoffCount = context?.let { CheckoffStore.consumeSerializedCount(it) } ?: 0
      mapOf(
        "legacyWidgetCount" to result.legacyWidgetCount,
        "compactWidgetCount" to result.compactWidgetCount,
        "hiddenCheckoffCount" to hiddenCheckoffCount,
        "serializedCheckoffCount" to serializedCheckoffCount,
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
