package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CheckoffStoreTest {
  @Test
  fun aTapSurvivesAConcurrentSweepWithoutUndoingCommittedQueueEntries() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val committedId = "concurrent-committed"
    val tappedId = "concurrent-tap"
    val sweepReachedPublish = CountDownLatch(1)
    val allowSweepPublish = CountDownLatch(1)
    val sweepFinished = CountDownLatch(1)
    val tapStarted = CountDownLatch(1)
    val tapFinished = CountDownLatch(1)
    var committedReads = 0
    var swept: CheckoffStore.SweepState? = null
    var tapPending = false
    var sweepFailure: Throwable? = null
    var tapFailure: Throwable? = null
    var sweepThread: Thread? = null
    var tapThread: Thread? = null
    val sweepContext = object : ContextWrapper(context) {
      override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
        if (name == CheckoffStore.COMMITTED_PREFS_NAME && ++committedReads == 2) {
          sweepReachedPublish.countDown()
          check(allowSweepPublish.await(5, TimeUnit.SECONDS)) { "timed out waiting to publish sweep" }
        }
        return super.getSharedPreferences(name, mode)
      }
    }

    context.getSharedPreferences(CheckoffStore.COMMITTED_PREFS_NAME, Context.MODE_PRIVATE)
      .edit().clear().commit()
    PendingCheckoffStore(context).write(mapOf(committedId to 0L))
    CheckoffStore.consumeSerializedCount(context)

    try {
      sweepThread = thread(name = "widget-checkoff-sweep") {
        try {
          swept = CheckoffStore.sweep(sweepContext, now = 4_000L)
        } catch (error: Throwable) {
          sweepFailure = error
        } finally {
          sweepFinished.countDown()
        }
      }
      assertTrue(sweepReachedPublish.await(5, TimeUnit.SECONDS))

      val runningTap = thread(name = "widget-checkoff-tap") {
        tapStarted.countDown()
        try {
          tapPending = CheckoffStore.toggle(context, tappedId, now = 4_000L)
        } catch (error: Throwable) {
          tapFailure = error
        } finally {
          tapFinished.countDown()
        }
      }
      tapThread = runningTap
      assertTrue(tapStarted.await(5, TimeUnit.SECONDS))
      val blockedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
      while (runningTap.state != Thread.State.BLOCKED && runningTap.isAlive && System.nanoTime() < blockedDeadline) {
        Thread.yield()
      }
      assertEquals(Thread.State.BLOCKED, runningTap.state)

      allowSweepPublish.countDown()
      assertTrue(sweepFinished.await(5, TimeUnit.SECONDS))
      assertTrue(tapFinished.await(5, TimeUnit.SECONDS))
      sweepThread.join()
      tapThread?.join()
      sweepFailure?.let { throw AssertionError("concurrent sweep failed", it) }
      tapFailure?.let { throw AssertionError("concurrent tap failed", it) }
      assertEquals(setOf(committedId), swept?.committed?.keys)
      assertTrue(tapPending)
      assertEquals(mapOf(tappedId to 4_000L), CheckoffStore.pending(context))
      assertTrue(CheckoffStore.committed(context).contains(committedId))
      assertFalse(CheckoffStore.toggle(context, committedId, now = 4_001L))
      assertTrue(CheckoffStore.committed(context).contains(committedId))
      assertEquals(1, CheckoffStore.consumeSerializedCount(context))
    } finally {
      allowSweepPublish.countDown()
      sweepThread?.takeIf { it.isAlive }?.let {
        it.interrupt()
        it.join(1_000L)
      }
      tapThread?.takeIf { it.isAlive }?.let {
        it.interrupt()
        it.join(1_000L)
      }
      PendingCheckoffStore(context).write(emptyMap())
      context.getSharedPreferences(CheckoffStore.COMMITTED_PREFS_NAME, Context.MODE_PRIVATE)
        .edit().clear().commit()
      CheckoffStore.consumeSerializedCount(context)
    }
  }

  @Test
  fun aSecondTapInsideTheWindowUndoesThePendingCheckoff() {
    val once = CheckoffStore.toggled(emptyMap(), "t1", 1_000L)
    assertEquals(mapOf("t1" to 1_000L), once)

    val undone = CheckoffStore.toggled(once, "t1", 2_000L)
    assertTrue(undone.isEmpty())
  }

  @Test
  fun aFailedPendingCheckPreservesTheDurableUncheckedStateAcrossRestart() {
    val before = emptyMap<String, Long>()
    val durable = before

    val result = CheckoffStore.toggledDurably(durable, "t1", 1_000L) { false }
    val afterRestart = durable

    assertFalse(result.persisted)
    assertFalse(result.isPending)
    assertEquals(before, result.state)
    assertFalse(afterRestart.containsKey("t1"))
  }

  @Test
  fun aFailedPendingUndoPreservesTheDurableCheckedStateAcrossRestart() {
    val before = mapOf("t1" to 1_000L)
    val durable = before

    val result = CheckoffStore.toggledDurably(durable, "t1", 2_000L) { false }
    val afterRestart = durable

    assertFalse(result.persisted)
    assertTrue(result.isPending)
    assertEquals(before, result.state)
    assertEquals(before, afterRestart)
  }

  @Test
  fun aCommittedTapIsRefreshOnly() {
    assertEquals(CheckoffStore.TapAction.RECONCILE, CheckoffStore.tapAction(isCommitted = true))
    assertEquals(CheckoffStore.TapAction.TOGGLE_PENDING, CheckoffStore.tapAction(isCommitted = false))
  }

  @Test
  fun undoClosesAtTheTimeBoundaryEvenBeforeADeferredSweepRuns() {
    assertEquals(
      CheckoffStore.TapAction.TOGGLE_PENDING,
      CheckoffStore.tapAction(isCommitted = false, pendingSince = 1_000L, now = 3_999L),
    )
    assertEquals(
      CheckoffStore.TapAction.RECONCILE,
      CheckoffStore.tapAction(isCommitted = false, pendingSince = 1_000L, now = 4_000L),
    )
  }

  @Test
  fun committedIdsSurviveOnlyWhileThePayloadStillListsThem() {
    val committed = mapOf("queued" to "a.json", "ingested" to "b.json")
    assertEquals(mapOf("queued" to "a.json"), CheckoffStore.pruned(committed, setOf("queued", "other")))
    assertEquals(emptyMap<String, String>(), CheckoffStore.pruned(committed, emptySet()))
  }

  @Test
  fun pendingCheckoffsExpireTogetherOnlyAfterTheLastTapsWindow() {
    val pending = mapOf("old" to 0L, "fresh" to 2_500L, "edge" to 1_000L)

    assertEquals(emptyList<String>(), CheckoffStore.expired(pending, 1_500L, CheckoffStore.UNDO_WINDOW_MS))
    assertEquals(emptyList<String>(), CheckoffStore.expired(pending, 4_000L, CheckoffStore.UNDO_WINDOW_MS))
    assertEquals(emptyList<String>(), CheckoffStore.expired(pending, 5_499L, CheckoffStore.UNDO_WINDOW_MS))
    assertEquals(listOf("edge", "fresh", "old"), CheckoffStore.expired(pending, 5_500L, CheckoffStore.UNDO_WINDOW_MS))
    assertEquals(listOf("solo"), CheckoffStore.expired(mapOf("solo" to 1_000L), 4_000L, CheckoffStore.UNDO_WINDOW_MS))
  }

  @Test
  fun twoQuickCheckoffsKeepEveryRowInPlaceUntilTheLastUndoWindowEnds() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val payload = WidgetPayload.parse(
      org.json.JSONObject()
        .put("title", "Focus")
        .put("items", org.json.JSONArray().apply {
          listOf("first", "second", "third").forEach { put(org.json.JSONObject().put("id", it).put("title", it)) }
        })
        .toString(),
    )!!
    fun visibleRows() = payload.displaySnapshot(CheckoffStore.committed(context)).payload.items.map { it.id }
    try {
      assertTrue(CheckoffStore.toggle(context, "first", now = 0L))
      assertTrue(CheckoffStore.toggle(context, "second", now = 1_000L))

      CheckoffStore.sweep(context, now = 3_500L)
      assertEquals(listOf("first", "second", "third"), visibleRows())
      assertEquals(setOf("first", "second"), CheckoffStore.pending(context).keys)

      CheckoffStore.sweep(context, now = 4_000L)
      assertEquals(listOf("third"), visibleRows())
      assertTrue(CheckoffStore.pending(context).isEmpty())
      assertEquals(setOf("first", "second"), CheckoffStore.committed(context))
      assertEquals(0, CheckoffStore.consumeHeldCount(context))
    } finally {
      PendingCheckoffStore(context).write(emptyMap())
      context.getSharedPreferences(CheckoffStore.COMMITTED_PREFS_NAME, Context.MODE_PRIVATE)
        .edit().clear().commit()
      context.getSharedPreferences(CheckoffStore.DIAGNOSTICS_PREFS_NAME, Context.MODE_PRIVATE)
        .edit().clear().commit()
    }
  }

  @Test
  fun aBatchCountsOnlyRowsWhoseOwnWindowEndedBeforeTheLastTap() {
    val spread = CheckoffStore.swept(mapOf("first" to 0L, "second" to 3_500L), emptyMap(), 6_500L) { id, _ -> "$id.json" }
    val quick = CheckoffStore.swept(mapOf("first" to 0L, "second" to 1_000L), emptyMap(), 4_000L) { id, _ -> "$id.json" }

    assertEquals(2, spread.newlyCommitted)
    assertEquals(1, spread.held)
    assertEquals(2, quick.newlyCommitted)
    assertEquals(0, quick.held)
  }

  @Test
  fun aHeldRowStaysUndoableUntilTheLastUndoWindowEnds() {
    val pending = mapOf("first" to 0L, "second" to 1_000L)

    assertEquals(
      CheckoffStore.TapAction.TOGGLE_PENDING,
      CheckoffStore.tapAction(isCommitted = false, pendingSince = CheckoffStore.windowOpenedAt(pending, "first"), now = 3_500L),
    )
    assertEquals(
      CheckoffStore.TapAction.RECONCILE,
      CheckoffStore.tapAction(isCommitted = false, pendingSince = CheckoffStore.windowOpenedAt(pending, "first"), now = 4_000L),
    )
    assertEquals(null, CheckoffStore.windowOpenedAt(pending, "unchecked"))
  }

  @Test
  fun aQueueFailureLeavesTheCheckoffVisibleAndRetryable() {
    val pending = mapOf("failed" to 0L)

    val failed = CheckoffStore.swept(pending, emptyMap(), 4_000L) { _, _ -> throw java.io.IOException("disk full") }

    assertEquals(pending, failed.pending)
    assertTrue(failed.committed.isEmpty())
    assertEquals(0, failed.newlyCommitted)

    val retried = CheckoffStore.swept(failed.pending, failed.committed, 4_001L) { _, _ -> "queued.json" }
    assertTrue(retried.pending.isEmpty())
    assertEquals(mapOf("failed" to "queued.json"), retried.committed)
    assertEquals(1, retried.newlyCommitted)
  }

  @Test
  fun aRepeatedSweepNeverQueuesAnAlreadyCommittedCheckoffAgain() {
    val first = CheckoffStore.swept(mapOf("task" to 0L), emptyMap(), 4_000L) { _, _ -> "queued.json" }
    val second = CheckoffStore.swept(first.pending, first.committed, 4_001L) { _, _ ->
      throw AssertionError("repeat sweep must not enqueue")
    }

    assertTrue(second.pending.isEmpty())
    assertEquals(mapOf("task" to "queued.json"), second.committed)
    assertEquals(0, second.newlyCommitted)
  }

  @Test
  fun aFailedPartialRefreshRemainsEligibleWithoutRequeueingTheCompletion() {
    assertTrue(CheckoffStore.shouldRefresh(newlyCommitted = 0, queuedRefresh = 1))
    assertTrue(!CheckoffStore.shouldRefresh(newlyCommitted = 0, queuedRefresh = 0))
  }

  @Test
  fun automaticFastFailureRetriesAreBounded() {
    assertEquals(1, CheckoffStore.nextFastRetry(0))
    assertEquals(2, CheckoffStore.nextFastRetry(1))
    assertEquals(null, CheckoffStore.nextFastRetry(2))
    assertEquals(null, CheckoffStore.nextFastRetry(20))
  }
}
