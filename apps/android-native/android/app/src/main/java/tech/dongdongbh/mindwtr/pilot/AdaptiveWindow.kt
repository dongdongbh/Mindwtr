package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.LayoutDirection
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min


const val EXPANDED_NAV_MIN_WIDTH = 840f
const val EXPANDED_NAV_MIN_USABLE_HEIGHT = 480f
const val EXPANDED_CONTENT_MIN_WIDTH = 600f
const val ADAPTIVE_HINGE_ACTION_GAP = 8f
const val COMPACT_ACTION_PANE_MIN_HEIGHT = 260f

data class WindowFrame(val x: Float, val y: Float, val width: Float, val height: Float)

data class WindowEdges(val top: Float = 0f, val right: Float = 0f, val bottom: Float = 0f, val left: Float = 0f)

data class FoldFeature(val left: Float, val top: Float, val right: Float, val bottom: Float, val vertical: Boolean,
                       val separating: Boolean, val fullOcclusion: Boolean) {
    val active: Boolean get() = separating || fullOcclusion
}

data class WindowSnapshot(val width: Float, val height: Float, val features: List<FoldFeature>)

data class AdaptiveWindow(
    val width: Float,
    val height: Float,
    val fontScale: Float,
    val insets: WindowEdges,
    val usableWidth: Float,
    val usableHeight: Float,
    val isExpanded: Boolean,
    val railOnRight: Boolean,
    val navigationWidth: Float,
    val navigationFrame: WindowFrame,
    val navigationActionFrame: WindowFrame,
    val activeFeature: FoldFeature?,
    val foregroundFrame: WindowFrame,
)

data class MoreSheetFrame(val bottom: Float, val left: Float, val maxHeight: Float, val width: Float)


private fun intersectionArea(feature: FoldFeature, width: Float, height: Float): Float {
    val left = max(0f, min(width, feature.left))
    val right = max(left, min(width, feature.right))
    val top = max(0f, min(height, feature.top))
    val bottom = max(top, min(height, feature.bottom))
    return if (feature.vertical) max(1f, right - left) * max(0f, bottom - top) else max(0f, right - left) * max(1f, bottom - top)
}

private fun intersectsWindow(feature: FoldFeature, width: Float, height: Float): Boolean =
    if (feature.vertical) feature.left <= width && feature.right >= 0 && feature.top < height && feature.bottom > 0
    else feature.top <= height && feature.bottom >= 0 && feature.left < width && feature.right > 0

fun activeFoldFeature(snapshot: WindowSnapshot?, width: Float, height: Float): FoldFeature? =
    snapshot?.features?.filter { it.active && intersectsWindow(it, width, height) }?.maxByOrNull { intersectionArea(it, width, height) }

private fun splitAroundFeature(frame: WindowFrame, feature: FoldFeature, railOnRight: Boolean): WindowFrame {
    val frameRight = frame.x + frame.width
    val frameBottom = frame.y + frame.height
    if (feature.vertical) {
        val featureLeft = max(frame.x, min(frameRight, feature.left))
        val featureRight = max(featureLeft, min(frameRight, feature.right))
        val leftFrame = WindowFrame(frame.x, frame.y, max(0f, featureLeft - ADAPTIVE_HINGE_ACTION_GAP - frame.x), frame.height)
        val rightX = min(frameRight, featureRight + ADAPTIVE_HINGE_ACTION_GAP)
        val rightFrame = WindowFrame(rightX, frame.y, max(0f, frameRight - rightX), frame.height)
        if (leftFrame.width == rightFrame.width) return if (!railOnRight) rightFrame else leftFrame
        return if (leftFrame.width > rightFrame.width) leftFrame else rightFrame
    }
    val featureTop = max(frame.y, min(frameBottom, feature.top))
    val featureBottom = max(featureTop, min(frameBottom, feature.bottom))
    val topFrame = WindowFrame(frame.x, frame.y, frame.width, max(0f, featureTop - ADAPTIVE_HINGE_ACTION_GAP - frame.y))
    val bottomY = min(frameBottom, featureBottom + ADAPTIVE_HINGE_ACTION_GAP)
    val bottomFrame = WindowFrame(frame.x, bottomY, frame.width, max(0f, frameBottom - bottomY))
    return if (topFrame.height >= bottomFrame.height) topFrame else bottomFrame
}

private fun actionFrame(frame: WindowFrame, feature: FoldFeature, railOnRight: Boolean, expanded: Boolean): WindowFrame {
    val frameRight = frame.x + frame.width
    val frameBottom = frame.y + frame.height
    if (feature.vertical) {
        if (!expanded) return splitAroundFeature(frame, feature, railOnRight)
        val featureLeft = max(frame.x, min(frameRight, feature.left))
        val featureRight = max(featureLeft, min(frameRight, feature.right))
        if (!railOnRight) return WindowFrame(frame.x, frame.y, max(0f, featureLeft - ADAPTIVE_HINGE_ACTION_GAP - frame.x), frame.height)
        val rightX = min(frameRight, featureRight + ADAPTIVE_HINGE_ACTION_GAP)
        return WindowFrame(rightX, frame.y, max(0f, frameRight - rightX), frame.height)
    }
    if (expanded) return splitAroundFeature(frame, feature, railOnRight)
    val featureBottom = max(frame.y, min(frameBottom, feature.bottom))
    val bottomY = min(frameBottom, featureBottom + ADAPTIVE_HINGE_ACTION_GAP)
    val bottomFrame = WindowFrame(frame.x, bottomY, frame.width, max(0f, frameBottom - bottomY))
    return if (bottomFrame.height >= COMPACT_ACTION_PANE_MIN_HEIGHT) bottomFrame else splitAroundFeature(frame, feature, railOnRight)
}

private fun Float.positive(fallback: Float) = if (isFinite() && this > 0f) this else fallback

private fun Float.nonNegative() = if (isFinite()) max(0f, this) else 0f

fun resolveAdaptiveWindow(width: Float, height: Float, fontScale: Float = 1f, insets: WindowEdges = WindowEdges(), rtl: Boolean = false,
                          snapshot: WindowSnapshot? = null): AdaptiveWindow {
    val w = width.positive(390f)
    val h = height.positive(844f)
    val scale = max(1f, fontScale.positive(1f))
    val edges = WindowEdges(insets.top.nonNegative(), insets.right.nonNegative(), insets.bottom.nonNegative(), insets.left.nonNegative())
    val navigationWidth = if (scale > 1.15f) 104f else 88f
    val usableWidth = max(0f, w - edges.left - edges.right)
    val baseUsableHeight = max(0f, h - edges.top - edges.bottom)
    val matches = snapshot != null && run {
        val widthMatches = abs(snapshot.width - w) <= 48f
        val orientationMatches = (snapshot.width >= snapshot.height) == (w >= h)
        widthMatches && (orientationMatches || h < snapshot.height - 48f)
    }
    val feature = activeFoldFeature(snapshot.takeIf { matches }, w, h)
    val featureWidth = if (feature?.vertical == true) max(0f, feature.right - feature.left) + ADAPTIVE_HINGE_ACTION_GAP * 2 else 0f
    val safe = WindowFrame(edges.left, edges.top, usableWidth, baseUsableHeight)
    val foreground = feature?.let { splitAroundFeature(safe, it, rtl) } ?: safe
    val navigationFrame = if (feature != null && !feature.vertical) foreground else safe
    val usableHeight = navigationFrame.height
    val expanded = w >= EXPANDED_NAV_MIN_WIDTH && usableHeight >= EXPANDED_NAV_MIN_USABLE_HEIGHT &&
        usableWidth - navigationWidth - featureWidth >= EXPANDED_CONTENT_MIN_WIDTH * min(scale, 1.35f)
    return AdaptiveWindow(w, h, scale, edges, usableWidth, usableHeight, expanded, rtl, navigationWidth, navigationFrame,
        feature?.let { actionFrame(safe, it, rtl, expanded) } ?: safe, feature, foreground)
}

fun moreSheetFrame(layout: AdaptiveWindow, tabBarHeight: Float): MoreSheetFrame? {
    if (!layout.isExpanded && layout.activeFeature == null) return null
    val frame = layout.navigationActionFrame
    val overlayBottom = max(0f, layout.height - if (layout.isExpanded) 0f else tabBarHeight)
    val frameBottom = min(overlayBottom, frame.y + frame.height)
    val availableTop = min(frameBottom, frame.y + 12f)
    val availableBottom = max(availableTop, frameBottom - 12f)
    val width = max(0f, min(420f, frame.width - 24f))
    val minLeft = frame.x + 12f
    val maxLeft = max(minLeft, frame.x + frame.width - width - 12f)
    val triggerOnRight = if (layout.isExpanded) layout.railOnRight else !layout.railOnRight
    val preferredLeft = if (!triggerOnRight) frame.x + layout.navigationWidth + 12f else frame.x + frame.width - layout.navigationWidth - width - 12f
    return MoreSheetFrame(max(12f, overlayBottom - availableBottom), max(minLeft, min(maxLeft, preferredLeft)), max(0f, availableBottom - availableTop), width)
}


val LocalMoreSheetFrame = compositionLocalOf<MoreSheetFrame?> { null }


private fun Activity.foldFeatures(density: Float): Flow<List<FoldFeature>> = WindowInfoTracker.getOrCreate(this).windowLayoutInfo(this).map { info ->
    info.displayFeatures.filterIsInstance<FoldingFeature>().map { feature ->
        val bounds = feature.bounds
        FoldFeature(bounds.left / density, bounds.top / density, bounds.right / density, bounds.bottom / density,
            feature.orientation != FoldingFeature.Orientation.HORIZONTAL, feature.isSeparating, feature.occlusionType == FoldingFeature.OcclusionType.FULL)
    }
}


@Composable
fun rememberAdaptiveWindow(): AdaptiveWindow {
    val density = LocalDensity.current
    val activity = LocalContext.current as? Activity
    val features = remember(activity, density.density) { activity?.foldFeatures(density.density) ?: emptyFlow() }.collectAsState(emptyList()).value
    val size = LocalWindowInfo.current.containerSize
    val width = size.width / density.density
    val height = size.height / density.density
    val bars = WindowInsets.systemBars.union(WindowInsets.displayCutout)
    val direction = LocalLayoutDirection.current
    val insets = WindowEdges(bars.getTop(density) / density.density, bars.getRight(density, direction) / density.density,
        bars.getBottom(density) / density.density, bars.getLeft(density, direction) / density.density)
    return resolveAdaptiveWindow(width, height, density.fontScale, insets, direction == LayoutDirection.Rtl, WindowSnapshot(width, height, features))
}
