package tech.dongdongbh.mindwtr.nanoclarification

import expo.modules.kotlin.exception.CodedException

internal const val NANO_MODULE_NAME = "MindwtrNanoClarification"
internal const val NANO_OPERATION = "inbox_clarification"

internal enum class NanoFailureReason(val wireValue: String) {
  AVAILABLE("available"),
  BUILD_DISABLED("build_disabled"),
  UNSUPPORTED_OS("unsupported_os"),
  UNAVAILABLE("unavailable"),
  DOWNLOADABLE("downloadable"),
  DOWNLOADING("downloading"),
  DOWNLOAD_FAILED("download_failed"),
  BUSY("busy"),
  QUOTA_EXCEEDED("quota_exceeded"),
  BACKGROUND_BLOCKED("background_blocked"),
  LOCALE_NOT_SUPPORTED("locale_not_supported"),
  CANCELLED("cancelled"),
  UNKNOWN("unknown"),
}

internal data class NanoCapability(
  val available: Boolean,
  val reason: NanoFailureReason,
  val modelName: String? = null,
) {
  fun toBridgeValue(): Map<String, Any> = buildMap {
    put("available", available)
    put("reason", reason.wireValue)
    put("supportedOperations", if (available) listOf(NANO_OPERATION) else emptyList<String>())
    modelName?.takeIf { it.isNotBlank() }?.let { put("modelName", it) }
  }

  companion object {
    fun unavailable(reason: NanoFailureReason): NanoCapability = NanoCapability(false, reason)
  }
}

internal class NanoFailure(
  val reason: NanoFailureReason,
) : RuntimeException(reason.wireValue)

internal class NanoBridgeException(reason: NanoFailureReason) : CodedException(
  code = "ERR_NANO_${reason.wireValue.uppercase()}",
  message = "Nano clarification failed: ${reason.wireValue}",
  cause = null,
)

internal data class NanoCandidate(
  val kind: String,
  val id: String,
  val label: String,
)

internal data class NanoClarificationRequest(
  val requestId: String,
  val locale: String,
  val title: String,
  val description: String,
  val candidates: List<NanoCandidate>,
) {
  companion object {
    private const val MAX_REQUEST_ID_LENGTH = 128
    private const val MAX_LOCALE_LENGTH = 64
    private const val MAX_TITLE_LENGTH = 4_000
    private const val MAX_DESCRIPTION_LENGTH = 12_000
    private const val MAX_CANDIDATES = 256
    private const val MAX_CANDIDATE_ID_LENGTH = 256
    private const val MAX_CANDIDATE_LABEL_LENGTH = 500
    private val requestIdPattern = Regex("^[A-Za-z0-9._:-]+$")
    private val localePattern = Regex("^[A-Za-z0-9_-]+$")
    private val candidateKinds = setOf("project", "area", "context", "tag")

    fun parse(raw: Map<String, Any?>): NanoClarificationRequest {
      val requestId = requireBoundedString(
        raw["requestId"],
        MAX_REQUEST_ID_LENGTH,
        requestIdPattern,
      )
      val locale = parseLocale(raw["locale"])
      val title = requireBoundedString(raw["title"], MAX_TITLE_LENGTH)
      val description = requireBoundedString(raw["description"], MAX_DESCRIPTION_LENGTH, allowEmpty = true)
      if (title.isBlank() && description.isBlank()) throw NanoFailure(NanoFailureReason.UNKNOWN)

      val rawCandidates = raw["candidates"] as? List<*>
        ?: throw NanoFailure(NanoFailureReason.UNKNOWN)
      if (rawCandidates.size > MAX_CANDIDATES) throw NanoFailure(NanoFailureReason.UNKNOWN)
      val candidates = rawCandidates.map { rawCandidate ->
        val candidate = rawCandidate as? Map<*, *>
          ?: throw NanoFailure(NanoFailureReason.UNKNOWN)
        val kind = requireBoundedString(candidate["kind"], 16)
        if (kind !in candidateKinds) throw NanoFailure(NanoFailureReason.UNKNOWN)
        NanoCandidate(
          kind = kind,
          id = requireBoundedString(candidate["id"], MAX_CANDIDATE_ID_LENGTH),
          label = requireBoundedString(candidate["label"], MAX_CANDIDATE_LABEL_LENGTH),
        )
      }
      return NanoClarificationRequest(requestId, locale, title, description, candidates)
    }

    fun parseRequestId(value: Any?): String = requireBoundedString(
      value,
      MAX_REQUEST_ID_LENGTH,
      requestIdPattern,
    )

    fun parseLocale(value: Any?): String = requireBoundedString(
      value,
      MAX_LOCALE_LENGTH,
      localePattern,
    )

    private fun requireBoundedString(
      value: Any?,
      maxLength: Int,
      pattern: Regex? = null,
      allowEmpty: Boolean = false,
    ): String {
      val string = value as? String ?: throw NanoFailure(NanoFailureReason.UNKNOWN)
      if ((!allowEmpty && string.isEmpty()) || string.length > maxLength || pattern?.matches(string) == false) {
        throw NanoFailure(NanoFailureReason.UNKNOWN)
      }
      return string
    }
  }
}

internal interface NanoClarificationBackend {
  suspend fun getCapability(locale: String): NanoCapability
  suspend fun downloadModel(locale: String): NanoCapability
  suspend fun clarify(prompt: String): String
  fun close()
}
