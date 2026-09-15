package tech.dongdongbh.mindwtr.nanoclarification

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NanoOperationCoordinatorTest {
  private lateinit var scope: CoroutineScope
  private lateinit var coordinator: NanoOperationCoordinator
  private var hostReady = true

  @Before
  fun setUp() {
    scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    coordinator = NanoOperationCoordinator(scope, hostReady = { hostReady })
    coordinator.setForeground(true)
  }

  @After
  fun tearDown() {
    coordinator.shutdown()
    scope.cancel()
  }

  @Test
  fun cancelBeforeStartConsumesAnExactTombstone() {
    val failure = ResultProbe<NanoFailureReason>()
    var ran = false

    coordinator.cancel("request-1")
    coordinator.start(
      requestId = "request-1",
      operation = { ran = true; "unexpected" },
      onSuccess = { failure.fail("operation unexpectedly succeeded") },
      onFailure = failure::complete,
    )

    assertEquals(NanoFailureReason.CANCELLED, failure.await())
    assertFalse(ran)
  }

  @Test
  fun cancellationTargetsOnlyTheMatchingOperation() {
    val releaseSecond = CompletableDeferred<Unit>()
    val firstFailure = ResultProbe<NanoFailureReason>()
    val secondSuccess = ResultProbe<String>()

    coordinator.start(
      requestId = "first",
      operation = { awaitCancellation() },
      onSuccess = { firstFailure.fail("cancelled operation unexpectedly succeeded") },
      onFailure = firstFailure::complete,
    )
    coordinator.start(
      requestId = "second",
      operation = { releaseSecond.await(); "second-result" },
      onSuccess = secondSuccess::complete,
      onFailure = { secondSuccess.fail("second operation failed: $it") },
    )

    coordinator.cancel("first")
    releaseSecond.complete(Unit)

    assertEquals(NanoFailureReason.CANCELLED, firstFailure.await())
    assertEquals("second-result", secondSuccess.await())
  }

  @Test
  fun backgroundCancelsRunningWorkAndRejectsNewWork() {
    val runningFailure = ResultProbe<NanoFailureReason>()
    val newFailure = ResultProbe<NanoFailureReason>()
    coordinator.start(
      requestId = "running",
      operation = { awaitCancellation() },
      onSuccess = { runningFailure.fail("backgrounded operation unexpectedly succeeded") },
      onFailure = runningFailure::complete,
    )

    coordinator.setForeground(false)
    coordinator.start(
      requestId = "new",
      operation = { "unexpected" },
      onSuccess = { newFailure.fail("background operation unexpectedly succeeded") },
      onFailure = newFailure::complete,
    )

    assertEquals(NanoFailureReason.BACKGROUND_BLOCKED, runningFailure.await())
    assertEquals(NanoFailureReason.BACKGROUND_BLOCKED, newFailure.await())
  }

  @Test
  fun duplicateActiveIdIsBusyAndDoesNotReplaceOriginal() {
    val release = CompletableDeferred<Unit>()
    val original = ResultProbe<String>()
    val duplicateFailure = ResultProbe<NanoFailureReason>()
    coordinator.start(
      requestId = "same",
      operation = { release.await(); "original" },
      onSuccess = original::complete,
      onFailure = { original.fail("original failed: $it") },
    )
    coordinator.start(
      requestId = "same",
      operation = { "duplicate" },
      onSuccess = { duplicateFailure.fail("duplicate unexpectedly succeeded") },
      onFailure = duplicateFailure::complete,
    )

    release.complete(Unit)

    assertEquals(NanoFailureReason.BUSY, duplicateFailure.await())
    assertEquals("original", original.await())
  }

  @Test
  fun hostLossDiscardsAResultBeforeItCanResolve() {
    val release = CompletableDeferred<Unit>()
    val failure = ResultProbe<NanoFailureReason>()
    coordinator.start(
      requestId = "host-loss",
      operation = { release.await(); "stale-result" },
      onSuccess = { failure.fail("stale result unexpectedly succeeded") },
      onFailure = failure::complete,
    )

    hostReady = false
    release.complete(Unit)

    assertEquals(NanoFailureReason.BACKGROUND_BLOCKED, failure.await())
  }

  @Test
  fun backgroundWinsAtomicallyAtTheFinalSuccessBoundary() {
    val atCommit = CountDownLatch(1)
    val releaseCommit = CountDownLatch(1)
    val localCoordinator = NanoOperationCoordinator(
      scope = scope,
      hostReady = { true },
      beforeSuccessCommit = {
        atCommit.countDown()
        assertTrue("commit release timed out", releaseCommit.await(5, TimeUnit.SECONDS))
      },
    )
    localCoordinator.setForeground(true)
    val failure = ResultProbe<NanoFailureReason>()
    localCoordinator.start(
      requestId = "background-final-boundary",
      operation = { "stale-result" },
      onSuccess = { failure.fail("backgrounded final result unexpectedly succeeded") },
      onFailure = failure::complete,
    )

    assertTrue("operation did not reach final boundary", atCommit.await(5, TimeUnit.SECONDS))
    localCoordinator.setForeground(false)
    releaseCommit.countDown()

    assertEquals(NanoFailureReason.BACKGROUND_BLOCKED, failure.await())
  }

  @Test
  fun exactCancelWinsAtomicallyAtTheFinalSuccessBoundary() {
    val atCommit = CountDownLatch(1)
    val releaseCommit = CountDownLatch(1)
    val localCoordinator = NanoOperationCoordinator(
      scope = scope,
      hostReady = { true },
      beforeSuccessCommit = {
        atCommit.countDown()
        assertTrue("commit release timed out", releaseCommit.await(5, TimeUnit.SECONDS))
      },
    )
    localCoordinator.setForeground(true)
    val failure = ResultProbe<NanoFailureReason>()
    localCoordinator.start(
      requestId = "cancel-final-boundary",
      operation = { "stale-result" },
      onSuccess = { failure.fail("cancelled final result unexpectedly succeeded") },
      onFailure = failure::complete,
    )

    assertTrue("operation did not reach final boundary", atCommit.await(5, TimeUnit.SECONDS))
    localCoordinator.cancel("cancel-final-boundary")
    releaseCommit.countDown()

    assertEquals(NanoFailureReason.CANCELLED, failure.await())
  }

  @Test
  fun unexpectedBackendErrorsExposeOnlyUnknownReason() {
    val failure = ResultProbe<NanoFailureReason>()
    coordinator.start(
      requestId = "failure",
      operation = { throw IllegalStateException("private prompt contents") },
      onSuccess = { failure.fail("failed operation unexpectedly succeeded") },
      onFailure = failure::complete,
    )

    assertEquals(NanoFailureReason.UNKNOWN, failure.await())
  }

  private class ResultProbe<T> {
    private val latch = CountDownLatch(1)
    @Volatile private var result: T? = null
    @Volatile private var failure: AssertionError? = null

    fun complete(value: T) {
      result = value
      latch.countDown()
    }

    fun fail(message: String) {
      failure = AssertionError(message)
      latch.countDown()
    }

    fun await(): T {
      assertTrue("callback timed out", latch.await(5, TimeUnit.SECONDS))
      failure?.let { throw it }
      @Suppress("UNCHECKED_CAST")
      return result as T
    }
  }
}
