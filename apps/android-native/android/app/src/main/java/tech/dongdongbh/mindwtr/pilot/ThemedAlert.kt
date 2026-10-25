package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider

/** One of RN's Alert buttons: its text and style ("cancel", "destructive", or "default"). */
data class AlertButton(val label: String, val style: String, val onPress: () -> Unit)

/**
 * RN's Alert.alert as the RN app draws it (components/themed-alert.tsx ThemedAlertModal): a window over the whole screen with its
 * 58% black backdrop (a tap there or Back dismisses), a card with the title, the scrolling message, and the buttons side by side
 * (stacked when more than two): a destructive one in red, the last plain one filled with the tint, the others in the filter
 * background.
 */
@Composable
fun ThemedAlert(title: String, message: String?, buttons: List<AlertButton>, onDismiss: () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        Box(Modifier.fillMaxSize().background(theme.alertScrim).clickable(role = Role.Button) { onDismiss() }.semantics { contentDescription = title }
            .padding(24.dp), contentAlignment = Alignment.Center) {
            val shape = RoundedCornerShape(18.dp)
            Column(Modifier.fillMaxWidth().shadow(14.dp, shape).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                .pointerInput(Unit) { detectTapGestures { } }.testTag("themed-alert").padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(title, style = rnText(20, 700), color = c.text, modifier = Modifier.semantics { heading() })
                message?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = rnText(16, 400, 23), color = c.secondaryText, modifier = Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()))
                }
                val primary = buttons.indexOfLast { it.style != "cancel" && it.style != "destructive" }.takeIf { it == buttons.lastIndex } ?: -1
                val content: @Composable (Modifier) -> Unit = { weight ->
                    buttons.forEachIndexed { index, button ->
                        val fill = when { button.style == "destructive" -> c.danger; index == primary -> c.tint; else -> c.filterBg }
                        Box(weight.heightIn(min = 44.dp).clip(RoundedCornerShape(12.dp)).background(fill)
                            .rnBorder(1.dp, if (fill == c.filterBg) c.border else fill, RoundedCornerShape(12.dp))
                            .clearAndSetSemantics { contentDescription = button.label; role = Role.Button; onClick { button.onPress(); true } }
                            .clickable { button.onPress() }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                            Text(button.label, style = rnText(14, 700), color = if (fill == c.filterBg) c.text else c.onTint, textAlign = TextAlign.Center)
                        }
                    }
                }
                if (buttons.size > 2) Column(Modifier.padding(top = 8.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) { content(Modifier.fillMaxWidth()) }
                else Row(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) { content(Modifier.weight(1f)) }
            }
        }
    }
}
