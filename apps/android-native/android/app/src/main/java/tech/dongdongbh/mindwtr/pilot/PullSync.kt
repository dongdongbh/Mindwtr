package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp

/**
 * RN's pull down to sync on a task list (Focus, the Inbox, Reference, Done, a project; RN's useManualPullSync, 5bb0ea8f): the
 * pull starts one manual sync ([InboxViewModel.pullToSync]). RN's RefreshControl there is transparent, so only RN's
 * PullSyncIndicator shows: a 112 by 4 bar at the top, the tint while syncing, then green or red for 900 ms.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullToSync(model: InboxViewModel, modifier: Modifier, content: @Composable BoxScope.() -> Unit) {
    val c = LocalTheme.current.colors
    val state = model.pullSync
    PullToRefreshBox(isRefreshing = state == "syncing", onRefresh = model::pullToSync, modifier = modifier, indicator = {
        if (state != "idle") Box(Modifier.align(Alignment.TopCenter).size(112.dp, 4.dp).clip(RoundedCornerShape(2.dp))
            .background(when (state) { "error" -> c.danger; "success" -> c.success; else -> c.tint }))
    }, content = content)
}

/**
 * RN's pull on a saved search and a widget list (a RefreshControl over fetchData): the system spinner while the list is read
 * again ([read] calls its `done` once the read answered), no sync.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullToRead(modifier: Modifier, read: (done: () -> Unit) -> Unit, content: @Composable BoxScope.() -> Unit) {
    var reading by remember { mutableStateOf(false) }
    PullToRefreshBox(isRefreshing = reading, onRefresh = { reading = true; read { reading = false } }, modifier = modifier, content = content)
}
