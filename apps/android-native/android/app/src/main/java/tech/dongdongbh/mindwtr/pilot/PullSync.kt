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
import org.json.JSONObject


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


@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullToRead(modifier: Modifier, read: (done: () -> Unit) -> Unit, content: @Composable BoxScope.() -> Unit) {
    var reading by remember { mutableStateOf(false) }
    PullToRefreshBox(isRefreshing = reading, onRefresh = { reading = true; read { reading = false } }, modifier = modifier, content = content)
}


internal fun pullSyncFailure(title: String, failure: Throwable): JSONObject = JSONObject().put("indicator", "error").put("toast",
    JSONObject().put("title", title).put("message", failure.message?.takeIf { it.isNotBlank() } ?: title).put("tone", "error").put("durationMs", 5200))
