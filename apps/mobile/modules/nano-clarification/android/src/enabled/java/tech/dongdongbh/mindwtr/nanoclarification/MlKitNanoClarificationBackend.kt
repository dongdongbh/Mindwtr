package tech.dongdongbh.mindwtr.nanoclarification

import android.os.Build
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class MlKitNanoClarificationBackend(
  private val client: MlKitNanoClient = MlKitNanoClient(),
  private val sdkInt: () -> Int = { Build.VERSION.SDK_INT },
) : NanoClarificationBackend {
  override suspend fun getCapability(locale: String): NanoCapability {
    if (sdkInt() < Build.VERSION_CODES.O) {
      return NanoCapability.unavailable(NanoFailureReason.UNSUPPORTED_OS)
    }
    return try {
      when (client.status().awaitCancellable()) {
        "available" -> NanoCapability(
          available = true,
          reason = NanoFailureReason.AVAILABLE,
          modelName = try {
            client.modelName().awaitCancellable()
          } catch (error: CancellationException) {
            throw error
          } catch (_: Throwable) {
            null
          },
        )
        "downloadable" -> NanoCapability.unavailable(NanoFailureReason.DOWNLOADABLE)
        "downloading" -> NanoCapability.unavailable(NanoFailureReason.DOWNLOADING)
        else -> NanoCapability.unavailable(NanoFailureReason.UNAVAILABLE)
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Throwable) {
      NanoCapability.unavailable(error.toReason())
    }
  }

  override suspend fun downloadModel(locale: String): NanoCapability {
    val capability = getCapability(locale)
    if (capability.available) return capability
    if (capability.reason == NanoFailureReason.DOWNLOADING) return capability
    if (capability.reason != NanoFailureReason.DOWNLOADABLE) throw NanoFailure(capability.reason)
    try {
      client.download().awaitCancellable()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Throwable) {
      throw NanoFailure(error.toReason(download = true))
    }
    return getCapability(locale)
  }

  override suspend fun clarify(prompt: String): String {
    val status = try {
      client.status().awaitCancellable()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Throwable) {
      throw NanoFailure(error.toReason())
    }
    if (status != "available") throw NanoFailure(NanoFailureReason.UNAVAILABLE)
    return try {
      client.clarify(prompt).awaitCancellable()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Throwable) {
      throw NanoFailure(error.toReason())
    }
  }

  override fun close() {
    client.close()
  }

  private fun Throwable.toReason(download: Boolean = false): NanoFailureReason {
    val wireValue = MlKitNanoClient.reasonFor(this, download)
    return NanoFailureReason.entries.firstOrNull { it.wireValue == wireValue }
      ?: if (download) NanoFailureReason.DOWNLOAD_FAILED else NanoFailureReason.UNKNOWN
  }

  private suspend fun <T> CompletableFuture<T>.awaitCancellable(): T =
    suspendCancellableCoroutine { continuation ->
      whenComplete { value, error ->
        if (!continuation.isActive) return@whenComplete
        if (error == null) continuation.resume(value) else continuation.resumeWithException(error)
      }
      continuation.invokeOnCancellation { cancel(true) }
    }
}
