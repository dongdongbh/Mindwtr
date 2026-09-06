package tech.dongdongbh.mindwtr.androidwidget

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AndroidWidgetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MindwtrAndroidWidget")

    Function("setPayload") { json: String ->
      val context = appContext.reactContext ?: return@Function
      WidgetPayloadStore.write(context, json)
    }

    Function("updateWidgets") {
      appContext.reactContext?.let { MindwtrTasksWidgetProvider.refreshAll(it) }
    }
  }
}
