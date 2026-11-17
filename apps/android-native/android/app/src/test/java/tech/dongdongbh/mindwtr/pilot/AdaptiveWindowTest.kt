package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test


class AdaptiveWindowTest {
    private fun hinge(left: Float, top: Float, right: Float, bottom: Float, vertical: Boolean, separating: Boolean = true, full: Boolean = true) =
        FoldFeature(left, top, right, bottom, vertical, separating, full)

    private fun snapshot(width: Float, height: Float, vararg features: FoldFeature) = WindowSnapshot(width, height, features.toList())

    @Test fun phonesAndNarrowFoldsStayCompact() {
        assertFalse(resolveAdaptiveWindow(390f, 844f).isExpanded)
        assertFalse(resolveAdaptiveWindow(674f, 841f).isExpanded)
        assertFalse(resolveAdaptiveWindow(900f, 470f).isExpanded)
    }

    @Test fun aWideWindowGetsAnRailOf88OnTheStartEdge() {
        val layout = resolveAdaptiveWindow(841f, 674f, snapshot = snapshot(841f, 674f))
        assertTrue(layout.isExpanded)
        assertEquals(88f, layout.navigationWidth)
        assertFalse(layout.railOnRight)
        assertTrue(resolveAdaptiveWindow(900f, 674f, rtl = true).railOnRight)
        assertFalse(resolveAdaptiveWindow(839f, 674f).isExpanded)
    }

    @Test fun aLargeFontNeedsMoreContentWidthAndAWiderRail() {
        assertFalse(resolveAdaptiveWindow(900f, 674f, fontScale = 1.35f).isExpanded)
        val wide = resolveAdaptiveWindow(1040f, 674f, fontScale = 1.35f)
        assertTrue(wide.isExpanded)
        assertEquals(104f, wide.navigationWidth)
    }

    @Test fun aFlatNonSeparatingCreaseIsIgnored() {
        val layout = resolveAdaptiveWindow(900f, 674f, snapshot = snapshot(900f, 674f, hinge(449f, 0f, 451f, 674f, vertical = true, separating = false, full = false)))
        assertNull(layout.activeFeature)
        assertEquals(WindowFrame(0f, 0f, 900f, 674f), layout.foregroundFrame)
    }

    @Test fun aVerticalHingeSplitsTheForegroundAndTheRailActions() {
        val layout = resolveAdaptiveWindow(900f, 674f, snapshot = snapshot(900f, 674f, hinge(446f, 0f, 454f, 674f, vertical = true)))
        assertEquals(454f + ADAPTIVE_HINGE_ACTION_GAP, layout.foregroundFrame.x)
        assertEquals(900f - 454f - ADAPTIVE_HINGE_ACTION_GAP, layout.foregroundFrame.width)
        assertEquals(WindowFrame(0f, 0f, 438f, 674f), layout.navigationActionFrame)
    }

    @Test fun compactBottomBarMovesOffAVerticalHinge() {
        val layout = resolveAdaptiveWindow(674f, 841f, snapshot = snapshot(674f, 841f, hinge(333f, 0f, 341f, 841f, vertical = true)))
        assertFalse(layout.isExpanded)
        assertTrue(layout.foregroundFrame.x + layout.foregroundFrame.width / 2 > 341f + ADAPTIVE_HINGE_ACTION_GAP)
        assertEquals(layout.foregroundFrame, layout.navigationActionFrame)
    }

    @Test fun aHorizontalHingeKeepsTheForegroundAbove() {
        val layout = resolveAdaptiveWindow(674f, 841f, snapshot = snapshot(674f, 841f, hinge(0f, 418f, 674f, 423f, vertical = false)))
        assertFalse(layout.isExpanded)
        assertEquals(WindowFrame(0f, 0f, 674f, 418f - ADAPTIVE_HINGE_ACTION_GAP), layout.foregroundFrame)
        assertEquals(WindowFrame(0f, 423f + ADAPTIVE_HINGE_ACTION_GAP, 674f, 841f - 423f - ADAPTIVE_HINGE_ACTION_GAP), layout.navigationActionFrame)
    }

    @Test fun aCenteredTabletopFoldStaysCompact() {
        val layout = resolveAdaptiveWindow(841f, 674f, snapshot = snapshot(841f, 674f, hinge(0f, 333f, 841f, 341f, vertical = false)))
        assertFalse(layout.isExpanded)
        assertEquals(WindowFrame(0f, 0f, 841f, 325f), layout.navigationFrame)
    }

    @Test fun aTabletopRailStaysInTheLargerPane() {
        val layout = resolveAdaptiveWindow(1000f, 1000f, snapshot = snapshot(1000f, 1000f, hinge(0f, 600f, 1000f, 608f, vertical = false)))
        assertTrue(layout.isExpanded)
        assertEquals(WindowFrame(0f, 0f, 1000f, 592f), layout.navigationFrame)
        assertEquals(layout.navigationFrame, layout.navigationActionFrame)
    }

    @Test fun aStaleSnapshotAfterAResizeIsIgnored() {
        val layout = resolveAdaptiveWindow(900f, 674f, snapshot = snapshot(390f, 844f, hinge(190f, 0f, 200f, 844f, vertical = true)))
        assertNull(layout.activeFeature)
    }

    @Test fun aSameWidthImeShrunkWindowKeepsTheHinge() {
        val layout = resolveAdaptiveWindow(900f, 400f, snapshot = snapshot(900f, 674f, hinge(446f, 0f, 454f, 674f, vertical = true)))
        assertFalse(layout.isExpanded)
        assertNotNull(layout.activeFeature)
        assertEquals(462f, layout.foregroundFrame.x)
        assertEquals(400f, layout.foregroundFrame.height)
    }

    @Test fun aHingeBelowTheImeViewportIsIgnored() {
        val layout = resolveAdaptiveWindow(674f, 400f, snapshot = snapshot(674f, 841f, hinge(0f, 418f, 674f, 423f, vertical = false)))
        assertNull(layout.activeFeature)
        assertEquals(WindowFrame(0f, 0f, 674f, 400f), layout.foregroundFrame)
    }

    @Test fun aTinyBottomPaneKeepsCompactActionsAboveTheHinge() {
        val layout = resolveAdaptiveWindow(841f, 430f, snapshot = snapshot(841f, 674f, hinge(0f, 400f, 841f, 420f, vertical = false)))
        assertFalse(layout.isExpanded)
        assertEquals(WindowFrame(0f, 0f, 841f, 392f), layout.navigationActionFrame)
    }

    @Test fun theMoreSheetFloatsBesideTheRailWithRnsNumbers() {
        assertNull(moreSheetFrame(resolveAdaptiveWindow(390f, 844f), 66f))
        assertEquals(MoreSheetFrame(bottom = 12f, left = 100f, maxHeight = 676f, width = 420f), moreSheetFrame(resolveAdaptiveWindow(1000f, 700f), 66f))
        assertEquals(480f, moreSheetFrame(resolveAdaptiveWindow(1000f, 700f, rtl = true), 66f)!!.left)
    }
}
