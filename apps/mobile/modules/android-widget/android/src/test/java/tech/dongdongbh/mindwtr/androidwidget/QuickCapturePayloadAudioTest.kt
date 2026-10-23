package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickCapturePayloadAudioTest {
  @Test fun destinationLabelsAndGenericPromptUseLocalizedPayloadWithLegacyFallbacks() {
    val labels = JSONObject().put("statusLabel", "Destination localized")
      .put("statusLabels", JSONObject().put("inbox", "Inbox localized"))
      .put("placeholder", "Add localized")
      .put("queued", "Queued localized")
    val payload = WidgetPayload.parse(JSONObject().put("quickCapture", labels).toString())!!
    assertEquals("Destination localized", payload.quickCapture.statusLabel)
    assertEquals("Inbox localized", payload.quickCapture.statusLabels["inbox"])
    assertEquals("Next Actions", payload.quickCapture.statusLabels["next"])
    assertEquals("Add localized", payload.quickCapture.placeholder)
    assertEquals("Queued localized", payload.quickCapture.queued)
  }

  @Test
  fun legacyPayloadKeepsAudioHiddenWithSafeEnglishDefaults() {
    val payload = WidgetPayload.parse("""{"headerTitle":"Focus"}""")!!

    assertFalse(payload.quickCapture.audioEnabled)
    assertEquals("Record audio", payload.quickCapture.audioRecord)
    assertEquals("Stop recording", payload.quickCapture.audioStop)
    assertEquals("Recording ready to save.", payload.quickCapture.audioReady)
    assertEquals("Saved. Audio will be transcribed when you open Mindwtr.", payload.quickCapture.audioSaved)
  }

  @Test
  fun parsesAudioEnablementAndEveryLocalizedNativeLabel() {
    val quickCapture = JSONObject()
      .put("audioEnabled", true)
      .put("audioRecord", "Record localized")
      .put("audioStop", "Stop localized")
      .put("audioRecording", "Recording localized")
      .put("audioReady", "Ready localized")
      .put("audioSaved", "Saved localized")
      .put("audioError", "Error localized")
      .put("audioPermissionDenied", "Permission localized")
    val payload = WidgetPayload.parse(JSONObject().put("quickCapture", quickCapture).toString())!!

    assertTrue(payload.quickCapture.audioEnabled)
    assertEquals("Record localized", payload.quickCapture.audioRecord)
    assertEquals("Stop localized", payload.quickCapture.audioStop)
    assertEquals("Recording localized", payload.quickCapture.audioRecording)
    assertEquals("Ready localized", payload.quickCapture.audioReady)
    assertEquals("Saved localized", payload.quickCapture.audioSaved)
    assertEquals("Error localized", payload.quickCapture.audioError)
    assertEquals("Permission localized", payload.quickCapture.audioPermissionDenied)
  }
}
