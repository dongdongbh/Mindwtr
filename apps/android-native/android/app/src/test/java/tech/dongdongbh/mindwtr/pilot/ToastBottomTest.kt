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

    @Test fun aTabToastSits12DpAboveTheTabBarAsRnsDoes() {
        assertEquals(78.dp, rnTabToastBottom(16.dp))
        assertEquals(114.dp, rnTabToastBottom(48.dp))
        assertEquals(tabBarHeight(48.dp) + 12.dp, rnTabToastBottom(48.dp))
    }
}
