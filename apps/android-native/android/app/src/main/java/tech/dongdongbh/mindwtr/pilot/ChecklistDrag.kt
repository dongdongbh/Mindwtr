package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.ScrollState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.geometry.Rect
import org.json.JSONObject

internal data class ChecklistFormScroll(val state: ScrollState, val viewport: Rect, val dragging: (Boolean) -> Unit)
internal val LocalChecklistFormScroll = compositionLocalOf<ChecklistFormScroll?> { null }
internal data class ChecklistSessionRow(val identity: String, val item: JSONObject)


internal class ChecklistRowSession(private val sessionId: String = "checklist") {
    private var serial = 0
    private var rows = emptyList<ChecklistSessionRow>()
    private var expected: List<ChecklistSessionRow>? = null

    private fun same(a: JSONObject, b: JSONObject) = a.optString("id") == b.optString("id") &&
        a.optString("title") == b.optString("title") && a.optBoolean("completed") == b.optBoolean("completed")

    fun sync(items: List<JSONObject>): List<ChecklistSessionRow> {
        val planned = expected
        if (planned != null && planned.size == items.size && items.indices.all { same(planned[it].item, items[it]) }) {
            rows = planned.mapIndexed { index, row -> row.copy(item = items[index]) }
            expected = null
            return rows
        }
        if (rows.size == items.size && rows.indices.all { rows[it].item.optString("id") == items[it].optString("id") }) {
            rows = rows.mapIndexed { index, row -> row.copy(item = items[index]) }
            return rows
        }
        val remaining = rows.toMutableList()
        rows = items.map { item ->
            val previous = remaining.firstOrNull { same(it.item, item) }
                ?: remaining.firstOrNull { it.item.optString("id") == item.optString("id") }
            if (previous != null) remaining.remove(previous)
            ChecklistSessionRow(previous?.identity ?: "$sessionId-row-${++serial}", item)
        }
        return rows
    }

    fun settle(items: List<JSONObject>, succeeded: Boolean) {
        val planned = expected ?: return
        if (succeeded && planned.size == items.size) rows = planned.mapIndexed { index, row -> row.copy(item = items[index]) }
        expected = null
    }

    fun expectRemove(index: Int) {
        if (index in rows.indices) expected = rows.filterIndexed { offset, _ -> offset != index }
    }

    fun expectMove(from: Int, to: Int) {
        if (from !in rows.indices || to !in rows.indices || from == to) return
        expected = rows.toMutableList().apply { add(to, removeAt(from)) }
    }
}

internal fun checklistDropIndex(centers: List<Float>, pointer: Float): Int? =
    centers.indices.minByOrNull { kotlin.math.abs(centers[it] - pointer) }

internal fun checklistEdgeScroll(pointer: Float, top: Float, bottom: Float, edge: Float): Float = when {
    pointer < top + edge -> -minOf(16f, maxOf(0f, top + edge - pointer) / 4f)
    pointer > bottom - edge -> minOf(16f, maxOf(0f, pointer - bottom + edge) / 4f)
    else -> 0f
}

internal fun checklistPreviewShift(position: Int, from: Int, to: Int, height: Float): Float = when {
    from < 0 || to < 0 -> 0f
    position in (from + 1)..to -> -height
    position in to until from -> height
    else -> 0f
}

internal fun checklistDropPreviewHeld(droppedOrder: List<String>?, order: List<String>, editsPending: Boolean): Boolean =
    droppedOrder == null || (droppedOrder == order && editsPending)
