package tech.dongdongbh.mindwtr.androidwidget

import java.security.MessageDigest

internal data class CaptureIntentExtras(val text: String, val token: String)


internal object CaptureIntentExtrasReader {
  fun read(getStringExtra: (String) -> String?): CaptureIntentExtras? {
    return try {
      val text = getStringExtra(CaptureIntentProcessor.EXTRA_TEXT) ?: return null
      val token = getStringExtra(CaptureIntentProcessor.EXTRA_TOKEN) ?: return null
      CaptureIntentExtras(text, token)
    } catch (_: RuntimeException) {

      null
    }
  }
}


object CaptureIntentProcessor {
  const val ACTION = "tech.dongdongbh.mindwtr.action.CAPTURE"
  const val EXTRA_TEXT = "text"
  const val EXTRA_TOKEN = "token"

  fun process(
    action: String?,
    extras: Map<String, Any?>,
    config: CaptureIntentConfig,
    enqueue: (String) -> Boolean,
  ): Boolean {
    if (action != ACTION || !config.enabled || !CaptureIntentConfig.isValidToken(config.token)) return false

    val text = extras[EXTRA_TEXT] as? String ?: return false
    val token = extras[EXTRA_TOKEN] as? String ?: return false
    if (text.length > PendingCaptureWriter.MAX_TITLE_LENGTH) return false
    val title = text.trim()
    if (title.isEmpty()) return false
    if (!CaptureIntentConfig.isValidToken(token)) return false
    if (!constantTimeEquals(token, config.token!!)) return false

    return enqueue(title)
  }

  private fun constantTimeEquals(candidate: String, expected: String): Boolean =
    MessageDigest.isEqual(candidate.toByteArray(Charsets.UTF_8), expected.toByteArray(Charsets.UTF_8))
}
