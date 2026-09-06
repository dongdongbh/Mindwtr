package tech.dongdongbh.mindwtr.androidwidget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckoffStoreTest {
  @Test
  fun aSecondTapInsideTheWindowUndoesThePendingCheckoff() {
    val once = CheckoffStore.toggled(emptyMap(), "t1", 1_000L)
    assertEquals(mapOf("t1" to 1_000L), once)

    val undone = CheckoffStore.toggled(once, "t1", 2_000L)
    assertTrue(undone.isEmpty())
  }

  @Test
  fun onlyEntriesOlderThanTheWindowExpire() {
    val pending = mapOf("old" to 0L, "fresh" to 2_500L, "edge" to 1_000L)

    assertEquals(listOf("edge", "old"), CheckoffStore.expired(pending, 4_000L, CheckoffStore.UNDO_WINDOW_MS))
    assertEquals(emptyList<String>(), CheckoffStore.expired(pending, 1_500L, CheckoffStore.UNDO_WINDOW_MS))
  }
}
