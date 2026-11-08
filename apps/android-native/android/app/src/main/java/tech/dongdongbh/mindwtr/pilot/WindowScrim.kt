package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.round


@Composable
fun Modifier.windowScrim(color: Color): Modifier {
    var origin by remember { mutableStateOf(IntOffset.Zero) }
    var window by remember { mutableStateOf(IntSize.Zero) }
    return onPlaced { placed ->
        val root = placed.findRootCoordinates()
        origin = root.localPositionOf(placed, Offset.Zero).round()
        window = root.size
    }
        .layout { measurable, constraints ->
            val known = window.width > 0 && window.height > 0
            val size = if (known) window else IntSize(constraints.maxWidth, constraints.maxHeight)
            val shift = if (known) origin else IntOffset.Zero
            val placeable = measurable.measure(Constraints.fixed(size.width, size.height))
            layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-shift.x, -shift.y) }
        }
        .background(color)
}
