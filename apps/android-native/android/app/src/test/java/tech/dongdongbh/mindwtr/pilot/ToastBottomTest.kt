package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test


class ToastBottomTest {
    @Test fun aToastSitsWhereRnsOverlayPutsItFromTheScreenBottom() {
        assertEquals(32.dp, rnToastBottom(0.dp))
        assertEquals(32.dp, rnToastBottom(16.dp))
        assertEquals(64.dp, rnToastBottom(48.dp))
    }
}
