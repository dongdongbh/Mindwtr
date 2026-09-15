package tech.dongdongbh.mindwtr.nanoclarification

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.LinkedHashSet
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns operation identity and lifecycle independently of ML Kit so races are
 * covered by ordinary JVM tests. The native backend never writes application data.
 */
internal class NanoOperationCoordinator(
  private val scope: CoroutineScope,
  private val hostReady: () -> Boolean,
  private val beforeSuccessCommit: (() -> Unit)? = null,
) {
  private class Entry {
    lateinit var job: Job
    val settled = AtomicBoolean(false)
    @Volatile var cancellationReason = NanoFailureReason.CANCELLED
    @Volatile var cancellationRequested = false
  }

  private val lock = Any()
  private val active = mutableMapOf<String, Entry>()
  private val cancellationTombstones = LinkedHashSet<String>()
  private var foreground = false
  private var shutdown = false

  fun setForeground(value: Boolean) {
    val jobsToCancel = synchronized(lock) {
      foreground = value && !shutdown
      if (foreground) {
        emptyList()
      } else {
        active.values.onEach {
          it.cancellationRequested = true
          it.cancellationReason = NanoFailureReason.BACKGROUND_BLOCKED
        }.map { it.job }
      }
    }
    jobsToCancel.forEach(Job::cancel)
  }

  fun <T> start(
    requestId: String,
    operation: suspend () -> T,
    onSuccess: (T) -> Unit,
    onFailure: (NanoFailureReason) -> Unit,
  ) {
    val entry = Entry()
    entry.job = scope.launch(start = CoroutineStart.LAZY) {
      try {
        ensureRunnable()
        val result = operation()
        beforeSuccessCommit?.invoke()
        val settlement = synchronized(lock) {
          val failureReason = when {
            active[requestId] !== entry -> entry.cancellationReason
            entry.cancellationRequested -> entry.cancellationReason
            shutdown || !foreground || !hostReady() -> NanoFailureReason.BACKGROUND_BLOCKED
            else -> null
          }
          entry.settled.compareAndSet(false, true) to failureReason
        }
        if (settlement.first) {
          if (settlement.second == null) onSuccess(result) else onFailure(settlement.second!!)
        }
      } catch (error: CancellationException) {
        throw error
      } catch (error: NanoFailure) {
        settleFailure(entry, error.reason, onFailure)
      } catch (_: Throwable) {
        settleFailure(entry, NanoFailureReason.UNKNOWN, onFailure)
      }
    }
    entry.job.invokeOnCompletion { cause ->
      if (cause is CancellationException) settleFailure(entry, entry.cancellationReason, onFailure)
      synchronized(lock) {
        if (active[requestId] === entry) active.remove(requestId)
      }
    }

    val registrationFailure = synchronized(lock) {
      when {
        shutdown -> NanoFailureReason.BACKGROUND_BLOCKED
        !foreground || !hostReady() -> NanoFailureReason.BACKGROUND_BLOCKED
        cancellationTombstones.remove(requestId) -> NanoFailureReason.CANCELLED
        active.containsKey(requestId) -> NanoFailureReason.BUSY
        else -> {
          active[requestId] = entry
          null
        }
      }
    }
    if (registrationFailure != null) {
      entry.settled.set(true)
      entry.job.cancel()
      onFailure(registrationFailure)
      return
    }
    entry.job.start()
  }

  fun cancel(requestId: String) {
    val job = synchronized(lock) {
      val entry = active[requestId]
      if (entry == null) {
        rememberTombstone(requestId)
        null
      } else {
        entry.cancellationRequested = true
        entry.cancellationReason = NanoFailureReason.CANCELLED
        entry.job
      }
    }
    job?.cancel()
  }

  fun shutdown() {
    val jobs = synchronized(lock) {
      if (shutdown) return
      shutdown = true
      foreground = false
      cancellationTombstones.clear()
      active.values.onEach {
        it.cancellationRequested = true
        it.cancellationReason = NanoFailureReason.BACKGROUND_BLOCKED
      }.map { it.job }
    }
    jobs.forEach(Job::cancel)
  }

  fun isRunnable(): Boolean = synchronized(lock) {
    !shutdown && foreground && hostReady()
  }

  private fun ensureRunnable() {
    if (!isRunnable()) throw NanoFailure(NanoFailureReason.BACKGROUND_BLOCKED)
  }

  private fun settleFailure(
    entry: Entry,
    proposedReason: NanoFailureReason,
    onFailure: (NanoFailureReason) -> Unit,
  ) {
    val reason = synchronized(lock) {
      if (!entry.settled.compareAndSet(false, true)) return@synchronized null
      if (entry.cancellationRequested) entry.cancellationReason else proposedReason
    }
    if (reason != null) onFailure(reason)
  }

  private fun rememberTombstone(requestId: String) {
    cancellationTombstones.remove(requestId)
    cancellationTombstones.add(requestId)
    while (cancellationTombstones.size > MAX_TOMBSTONES) {
      val iterator = cancellationTombstones.iterator()
      if (!iterator.hasNext()) break
      iterator.next()
      iterator.remove()
    }
  }

  private companion object {
    const val MAX_TOMBSTONES = 128
  }
}
