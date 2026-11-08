package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.round


@Composable
fun Modifier.windowScrim(color: Color): Modifier {
    val window = LocalView.current.rootView
    var origin by remember { mutableStateOf(IntOffset.Zero) }
    return onPlaced { origin = it.positionInWindow().round() }
        .layout { measurable, constraints ->
            val placeable = measurable.measure(Constraints.fixed(window.width.coerceAtLeast(1), window.height.coerceAtLeast(1)))
            layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-origin.x, -origin.y) }
        }
        .background(color)
}
